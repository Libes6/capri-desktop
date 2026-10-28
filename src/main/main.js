'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, protocol, net, shell, globalShortcut, nativeImage,
  clipboard, ClipboardItem, dialog, powerMonitor, desktopCapturer,
} = require('electron');
const { randomUUID } = require('node:crypto');

const { createConfig } = require('./config');
const { createElectronPlatform } = require('./platform/electron');
const { TRAY, LANGS } = require('./labels');
const lang = require('./lang');
const { createBridge } = require('./bridge');
const { startWindowWatch, SCRIPT: WINDOW_HELPER } = require('./windows');
const { watchPower } = require('./power');
const { createCapabilities } = require('./capabilities');
const { createSettingsWindow } = require('./settings-window');
const { settingsView } = require('./settings-view');
const { startUpdates, isReleasePage } = require('./updates');
const settingsPatch = require('./settings-patch');
const llm = require('./llm');
const ollama = require('./ollama');
const setup = require('./setup');
const apps = require('./apps');
const { createLaunch } = require('./launch');
const { createFiles } = require('./files');
const { ASSISTANTS, assistant } = require('./assistants');
const activeAssistant = () => assistant(config.load().assistant); // Claude Code or Codex
const activeHooks = () => activeAssistant().hooks;
const demoSteps = require('../../scripts/demo-sequence');
// what works on this computer (capabilities.js): the menu, the overlay and the IPC below go by it
const caps = createCapabilities({ helpers: { windowWatch: WINDOW_HELPER } });

const ROOT = path.resolve(__dirname, '..', '..');
const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke-test');
const platform = createElectronPlatform({ root: ROOT, dev: DEV, smoke: SMOKE });
const config = createConfig({ platform });
const keys = setup.createKeys({ platform });
const launch = createLaunch({ platform });
const files = createFiles({ platform });
if (SMOKE) {
  app.setPath('userData', process.env.CAPRI_SMOKE_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'capri-smoke-')));
  config.save({ welcomed: true, claude: false, muted: true, motion: 'reduced', render: process.platform === 'linux' ? 'software' : 'auto' });
  setTimeout(() => { console.error('[capri] smoke test timed out'); app.exit(1); }, 30000).unref();
}
const PORT = Number(process.env.CAPRI_PORT) || 47823;
const SOUND_EXT = /\.(mp3|wav|ogg|m4a)$/i;

const OLLAMA_SITE = 'https://ollama.com';

let overlay = null;
let tray = null;
let trayMenu = null; // also what she opens when you right-click her
let settings = null; // her settings window (settings-window.js), made in main()
let updates = null; // the app's updates (updates.js): what her settings and her menu show
let updateOffered = null; // the version her menu offers
let updateSaid = null; // the version she has mentioned (once)
let demoTimer = null;
let windowWatch = null;
let powerWatch = null; // screen locked / asleep (power.js): her overlay pauses its decorative work
// the watcher only speaks when something changes: the overlay asks for this when it (re)loads
let lastWindows = null;
let chatModels = null; // the provider's models, as last seen (null: not reached)
let chatError = null;  // why not, when the provider said
let chatErrorCode = null; // 'nokey' or 'nourl': what her setup should ask for
// Ollama's cloud, as last seen: your account ({ name } or { signin }) and the models free with it
let cloud = { at: 0, account: null, free: [] };
const chats = new Map(); // id -> AbortController of an answer being streamed

const userSoundsDir = () => path.join(app.getPath('userData'), 'sounds');

// Her memory of your chats, across restarts: { history: [{ role, content }], claude: Claude Code's session }
const memoryFile = () => path.join(app.getPath('userData'), 'memory.json');
function readMemory() {
  try {
    return JSON.parse(fs.readFileSync(memoryFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveMemory(patch) {
  try {
    fs.writeFileSync(memoryFile(), JSON.stringify({ ...readMemory(), ...patch }));
  } catch (err) {
    console.error('[capri] could not save her memory:', err.message);
  }
}
function forgetChats() {
  llm.resetClaude();
  saveMemory({ history: [], claude: null });
  sendCommand('forget');
}

// capri://app/...        -> files of this repo
// capri://usersounds/... -> the user's own sound overrides
function serveProtocol() {
  protocol.handle('capri', (request) => {
    const url = new URL(request.url);
    const base = url.host === 'usersounds' ? userSoundsDir() : ROOT;
    const target = path.resolve(base, '.' + decodeURIComponent(url.pathname));
    if (target !== base && !target.startsWith(base + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

// Your screens. In --dev with CAPRI_SCREENS=2 and only one screen, it's cut in two halves side by
// side, to try her going from one to the other without a second monitor.
function displays() {
  const real = screen.getAllDisplays();
  if (!DEV || process.env.CAPRI_SCREENS !== '2' || real.length > 1) return real;
  const d = screen.getPrimaryDisplay();
  const half = (r, i) => ({ x: r.x + Math.floor(r.width / 2) * i, y: r.y, width: Math.floor(r.width / 2), height: r.height });
  return [0, 1].map((i) => ({ ...d, id: d.id * 10 + i + 1, bounds: half(d.bounds, i), workArea: half(d.workArea, i), size: { width: Math.floor(d.size.width / 2), height: d.size.height } }));
}

// The screen a point (DIP) is on, else the nearest one.
function displayAt(p) {
  const all = displays();
  const inside = all.find(({ bounds: b }) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height);
  if (inside) return inside;
  const near = screen.getDisplayNearestPoint(p);
  return all.find((d) => d.id === near.id) || all[0];
}

function targetDisplay() {
  const { displayId } = config.load();
  const all = displays();
  return all.find((d) => d.id === displayId) || all.find((d) => d.id === screen.getPrimaryDisplay().id) || all[0];
}

// Her window over to another screen (she's on her way there, screens.js). Set twice: going to a
// screen with another scale, Windows resizes the window once it lands there.
function moveOverlay(id) {
  if (!displays().some((d) => d.id === id)) return null;
  config.save({ displayId: id });
  fitOverlay();
  const { area } = overlayArea();
  overlay.setBounds(area);
  windowWatch?.refresh();
  rebuildTray();
  return area;
}

// Her window: the work area, or the whole screen while she rests on the taskbar (her legs hang
// over it), less its top row of pixels: a window on top covering the whole screen is a fullscreen
// app to Windows (animated wallpapers pause, notifications wait). `gap`: how much of her window is
// below the top of the taskbar (0, or its height).
function overlayArea() {
  const { workArea, bounds } = targetDisplay();
  const area = config.load().rest === 'taskbar' ? { ...bounds, y: bounds.y + 1, height: bounds.height - 1 } : workArea;
  return { area, gap: area.y + area.height - (workArea.y + workArea.height) };
}

function fitOverlay() {
  if (!overlay) return;
  const { area, gap } = overlayArea();
  overlay.setBounds(area);
  overlay.webContents.send('overlay:resize', { width: area.width, height: area.height, gap });
}

// The pointer reaches her click-through window through a mouse hook, and Windows drops a hook that
// doesn't answer in time without a word (waking from sleep, a locked screen, a stall): she can't be
// clicked anymore. Off then on puts in a new one; her place on top and her size are set again too.
function rearmOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setIgnoreMouseEvents(false);
  overlay.setIgnoreMouseEvents(true, process.platform === 'linux' ? undefined : { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  fitOverlay();
  sendCommand('rearmed'); // click-through again: she waits for the pointer to be on her
  console.log('[capri] mouse hook set up again');
}

// Back on top of everything, the taskbar included (it comes up over her when it's clicked). Twice:
// the taskbar can come up again a moment later, as its menus and previews open.
function raiseOverlay() {
  for (const wait of [0, 400]) {
    setTimeout(() => {
      if (!overlay || overlay.isDestroyed()) return;
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    }, wait);
  }
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayArea().area,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlay.setIgnoreMouseEvents(true, process.platform === 'linux' ? undefined : { forward: true });
  overlay.loadURL('capri://app/src/renderer/index.html');
  // always shown: put away, she's still there as her biochip in the corner. Sized again first:
  // Windows keeps a new window inside the work area, and resting on the taskbar it covers it too.
  overlay.once('ready-to-show', () => {
    fitOverlay();
    overlay.showInactive();
  });
  overlay.webContents.on('render-process-gone', (_e, details) => {
    console.error('[capri] renderer gone:', details.reason);
    if (SMOKE) app.exit(1);
  });
  if (DEV || SMOKE) {
    overlay.webContents.on('console-message', (e) => {
      const { level, message, lineNumber, sourceId } = e;
      console.log(`[renderer:${level}] ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
    });
    if (DEV && process.env.CAPRI_DEVTOOLS) overlay.webContents.openDevTools({ mode: 'detach' });
  }
}

// Away (screen locked, asleep) or back: the overlay's only word of it (preload.js onPower).
function sendPower() {
  if (powerWatch) overlay?.webContents.send('power:state', powerWatch.state());
}

function sendCommand(name, payload = {}) {
  overlay?.webContents.send('capri:command', { name, ...payload });
}

// Ctrl+Alt+C: she folds herself away into her biochip in the corner, or comes back out of it.
function toggleVisible(force) {
  const visible = typeof force === 'boolean' ? force : !config.load().visible;
  config.save({ visible });
  sendCommand('stow', { on: !visible });
  rebuildTray();
}

function playDemo() {
  clearTimeout(demoTimer);
  const steps = demoSteps(resolveLang(config.load().lang)); // in her language
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const [delay, evt] = steps[i++];
    demoTimer = setTimeout(() => {
      overlay?.webContents.send('claude:event', evt);
      next();
    }, delay);
  };
  next();
}

// During the demo, a little fake terminal for her to sit on and take over (window tracking is
// Windows only, so only there). Opened without stealing focus; closing it drops her off it.
let demoWin = null;
const DEMO_TERMINAL = `<body style="margin:0;background:#14101c;color:#8f8aa3;font:13px/1.7 Consolas,monospace;padding:14px 18px">
<div style="color:#36ff7a">PS C:\\night-city-api&gt; npm test -- gigs</div>
<div>&nbsp;&nbsp;GET /gigs</div><div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ returns 20 items per page</div>
<div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ paginates with a cursor</div><div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ rejects a bad cursor</div>
<div>&nbsp;&nbsp;6 passing (212ms)</div><div style="color:#36ff7a">PS C:\\night-city-api&gt; _</div></body>`;

// Her demo and --dev test windows stay on top, except on macOS: a window above the normal level is
// not one the helper reports as a perch (mac/window-watch.js), and showInactive() brings it up anyway.
const PERCH_ON_TOP = process.platform !== 'darwin';

function demoWindow(open) {
  demoWin?.destroy();
  demoWin = null;
  if (!open || !caps.has('windowTracking')) return false;
  const b = overlay.getBounds();
  demoWin = new BrowserWindow({
    x: Math.round(b.x + b.width * 0.5 - 310), y: Math.round(b.y + b.height * 0.42), width: 620, height: 300,
    show: false, alwaysOnTop: PERCH_ON_TOP, title: 'night-city-api — npm test', backgroundColor: '#14101c', autoHideMenuBar: true,
  });
  demoWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DEMO_TERMINAL)}`);
  demoWin.once('ready-to-show', () => demoWin?.showInactive());
  demoWin.on('closed', () => { demoWin = null; });
  return true;
}

// 'auto' -> the first system language Capri speaks, English otherwise (lang.js). Asked each time,
// so a change in the system's languages shows at her next start without touching the 'auto' kept in the config.
function systemLanguages() {
  return { preferred: app.getPreferredSystemLanguages(), fallback: [app.getSystemLocale(), app.getLocale()] };
}
function resolveLang(setting) {
  return lang.resolveLang(setting, systemLanguages(), LANGS);
}

// What the overlay gets: `lang` is the resolved one, `langSetting` what the user picked.
function rendererConfig() {
  const { apiKeys, ...cfg } = config.load(); // the keys stay here: the overlay only learns which ones are set
  return { ...cfg, platform: process.platform, keys: Object.keys(apiKeys || {}), assistant: activeAssistant().id, lang: resolveLang(cfg.lang), langSetting: lang.langSetting(cfg.lang, LANGS), floorGap: overlayArea().gap, caps: caps.forRenderer() };
}

// What her settings window shows (settings-view.js), from the config and what's known here.
function settingsFacts() {
  const { apiKeys, ...cfg } = config.load(); // the keys stay here: the window learns which are saved, no more
  const screens = displays();
  const current = targetDisplay();
  return {
    cfg,
    keys: Object.fromEntries(Object.entries(apiKeys || {}).filter(([, v]) => Boolean(v)).map(([id]) => [id, true])),
    envKeys: Object.fromEntries(Object.entries(llm.PROVIDERS).filter(([, p]) => p.env && process.env[p.env]).map(([id]) => [id, true])),
    providers: Object.entries(llm.PROVIDERS).map(([id, p]) => ({ id, label: p.label, keyed: Boolean(p.env) })),
    assistants: Object.entries(ASSISTANTS).map(([id, a]) => ({ id, name: a.name })),
    models: chatModels ? [...chatModels] : null,
    screens: screens.map((d) => ({ id: d.id, width: d.size.width, height: d.size.height })),
    renderNow: RENDER_AT_START,
    lang: resolveLang(cfg.lang),
    langSetting: lang.langSetting(cfg.lang, LANGS),
    autoLang: resolveLang('auto'),
    assistant: cfg.claude ? activeAssistant() : null,
    hooksInstalled: cfg.claude ? Boolean(activeHooks().status().installed) : false,
    provider: llm.PROVIDERS[cfg.provider]?.label || cfg.provider,
    model: pickModel(cfg),
    features: caps.all(),
    autostart: caps.has('autostart') && app.getLoginItemSettings(loginItemOptions()).openAtLogin,
    screen: { index: Math.max(0, screens.findIndex((d) => d.id === current.id)), count: screens.length, width: current.size.width, height: current.size.height },
    about: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, session: caps.session },
    updates: updates?.view(),
  };
}

// The updater moved: her settings window hears of it, her menu when what it offers changes, and
// she may mention a new version once (an optional line, initiative.js decides).
function updatesChanged(view) {
  settings?.send('updates:status', view);
  const offered = ['available', 'downloading', 'downloaded'].includes(view.kind) ? view.version : null;
  if (offered !== updateOffered) {
    updateOffered = offered;
    rebuildTray();
  }
  if (view.kind === 'available' && updateSaid !== view.version) {
    updateSaid = view.version;
    sendCommand('update', { version: view.version });
  }
}

function openSettings() {
  settings?.open();
}

// What her settings window may pick from right now (settings-patch.js checks against it).
function settingsContext() {
  return {
    langs: LANGS,
    providers: Object.keys(llm.PROVIDERS),
    assistants: Object.keys(ASSISTANTS),
    models: chatModels,
    displays: displays().map((d) => d.id),
    features: caps.all(),
  };
}

// A change from her settings window: checked, saved through updateConfig like her menu's (so the
// menu, the overlay and the window hear of it), then what isn't a config key is done. On a refusal
// or a failed write the window is sent the view as it really is, and told why.
function applySettings(input) {
  const checked = settingsPatch.checkPatch(input, settingsContext());
  if (!checked.ok) {
    settings?.update();
    return { ok: false, error: 'invalid', fields: checked.fields };
  }
  const cfg = config.load();
  const { patch, effects } = settingsPatch.toConfig(checked.values, cfg);
  try {
    if (Object.keys(patch).length) updateConfig(patch, { strict: true });
  } catch (err) {
    console.error('[capri] settings not saved:', err.code || err.message);
    settings?.update();
    return { ok: false, error: 'save', code: err.code || null };
  }
  let status = 'saved';
  if ('autostart' in effects) {
    try {
      app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: effects.autostart });
    } catch (err) {
      settings?.update();
      return { ok: false, error: 'save', code: err.code || null };
    }
    rebuildTray();
  }
  if ('screen' in effects && effects.screen !== targetDisplay().id) {
    sendCommand('goScreen', { id: effects.screen }); // she goes there herself, as from her menu; saved once she's there
    status = 'moving';
  }
  if ('watchScreen' in effects && effects.watchScreen !== Boolean(cfg.watchScreen)) {
    sendCommand('watchScreen', { on: effects.watchScreen }); // she asks first, as from her menu, then saves it
    if (effects.watchScreen && !cfg.lookAsked) status = 'asks';
  }
  if (effects.assistantChanged) sendCommand('assistantChanged');
  // its models (or the new address's), in the window and the menu once known
  if ('provider' in patch || 'customUrl' in patch) refreshModels().catch(() => {});
  return { ok: true, status };
}

// A new API key from her settings window: checked, sealed (setup.js) and saved. It's never sent back
// and never logged; the window only learns that a key is saved. For the provider in use, its models
// are fetched with it, and the window told when that failed.
async function saveSettingsKey(input) {
  const { provider, key } = input || {};
  const keyed = Object.entries(llm.PROVIDERS).filter(([, p]) => p.env).map(([id]) => id);
  const checked = settingsPatch.checkKey(provider, key, keyed);
  if (!checked.ok) return { ok: false, field: checked.field };
  const before = config.load();
  try {
    updateConfig({ apiKeys: { ...before.apiKeys, [provider]: keys.sealKey(checked.key) } }, { strict: true });
  } catch (err) {
    console.error('[capri] key not saved:', err.code || 'write failed');
    settings?.update();
    return { ok: false, error: 'save', code: err.code || null };
  }
  if (provider !== before.provider) return { ok: true, status: 'keySaved' };
  const models = await refreshModels().catch(() => null);
  // saved either way; the field says when the service didn't answer with it
  return models?.length ? { ok: true, status: 'keySaved' } : { ok: true, status: 'keySaved', field: 'rejected' };
}

// "Reset settings" in her window: only settings-patch.js RESET_KEYS go back to their defaults.
function resetSettings() {
  const before = config.load();
  try {
    updateConfig(settingsPatch.resetPatch(config.DEFAULTS), { strict: true });
  } catch (err) {
    console.error('[capri] settings not reset:', err.code || err.message);
    settings?.update();
    return { ok: false, error: 'save', code: err.code || null };
  }
  if (before.displayId !== config.DEFAULTS.displayId) {
    // back on the main screen: her window there, and she learns of it
    fitOverlay();
    windowWatch?.refresh();
    rebuildTray();
    sendCommand('screens');
  }
  return { ok: true, status: 'resetDone' };
}

// `strict` (her settings window): saved to disk or not at all, and the error thrown to say so,
// before anything else hears of the change
function updateConfig(patch, { strict = false } = {}) {
  if (strict) config.commit(patch);
  else config.save(patch);
  if ('rest' in patch) {
    fitOverlay(); // the taskbar in her window or not
    windowWatch?.refresh();
  }
  const cfg = rendererConfig();
  overlay?.webContents.send('capri:config', cfg);
  rebuildTray();
  return cfg;
}

function rebuildTray() {
  if (!tray) return;
  const cfg = config.load();
  const hookState = activeHooks().status();
  const watched = activeAssistant();
  const t = Object.fromEntries(Object.entries(TRAY[resolveLang(cfg.lang)]).map(([key, value]) =>
    [key, typeof value === 'string' && watched.id !== 'claude' ? value.replaceAll('Claude Code', watched.name) : value]));

  const screens = displays();
  const current = targetDisplay().id;
  // how close she is to you (bond.js): STAGES there, 1000 xp is 100 %
  const xp = cfg.bond?.xp || 0;
  const stage = [0, 100, 300, 550, 850].filter((at) => xp >= at).length - 1;
  // the reminders she keeps (reminders.js), soonest first
  const reminders = [...(cfg.reminders || [])].sort((a, b) => a.at - b.at);
  const when = (at) => {
    const d = new Date(at);
    const sameDay = d.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(resolveLang(cfg.lang), sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  };
  const cancelReminder = (id) => updateConfig({ reminders: (config.load().reminders || []).filter((r) => r.id !== id) });

  const menu = Menu.buildFromTemplate([
    { label: t.online(PORT), enabled: false },
    { label: t.sync(Math.min(100, Math.floor(xp / 10)), t.stages[stage]), enabled: false },
    { type: 'separator' },
    { label: t.teleport, click: () => sendCommand('teleport') },
    { label: t.satellite, click: () => sendCommand('satellite') },
    { label: t.demo, click: playDemo },
    { label: t.help, click: () => sendCommand('welcome') },
    ...(cfg.claude ? [{ label: t.report, click: () => sendCommand('report') }] : []),
    { label: t.talk, click: () => sendCommand('chat') },
    { label: t.lookNow, click: () => sendCommand('look') },
    {
      label: t.reminders,
      submenu: reminders.length
        ? reminders.map((r) => ({
          label: `${when(r.at)} · ${(r.text || '…').slice(0, 50)}`,
          submenu: [{ label: t.cancelReminder, click: () => cancelReminder(r.id) }],
        }))
        : [{ label: t.noReminders, enabled: false }],
    },
    { label: t.custom, click: () => sendCommand('customize') },
    { label: cfg.visible ? t.hide : t.show, accelerator: 'Ctrl+Alt+C', click: () => toggleVisible() },
    ...(updateOffered ? [{ label: t.updateAvailable(updateOffered), click: () => settings?.open('about') }] : []),
    { label: t.settings, click: openSettings },
    { type: 'separator' },
    {
      label: t.size,
      submenu: [[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].map(([label, scale]) => ({
        label, type: 'radio', checked: Math.abs(cfg.scale - scale) < 0.01, click: () => updateConfig({ scale }),
      })),
    },
    {
      label: t.sound,
      submenu: [
        { label: t.mute, type: 'checkbox', checked: cfg.muted, click: (item) => updateConfig({ muted: item.checked }) },
        { type: 'separator' },
        {
          label: t.soundsDir,
          click: () => {
            fs.mkdirSync(userSoundsDir(), { recursive: true });
            shell.openPath(userSoundsDir());
          },
        },
      ],
    },
    {
      label: t.screen,
      enabled: screens.length > 1,
      submenu: [
        ...screens.map((d, i) => ({
          label: `${i + 1} — ${d.size.width}×${d.size.height}`,
          type: 'radio',
          checked: d.id === current,
          click: () => d.id !== current && sendCommand('goScreen', { id: d.id }), // she goes over there herself
        })),
        { type: 'separator' },
        { label: t.follow, type: 'checkbox', checked: cfg.follow !== false, click: (item) => updateConfig({ follow: item.checked }) },
      ],
    },
    {
      label: t.chatModel,
      submenu: [
        { label: t.aiSetup, click: () => sendCommand('setupChat') },
        { type: 'separator' },
        ...Object.entries(llm.PROVIDERS).map(([provider, p]) => ({
          label: p.label, type: 'radio', checked: cfg.provider === provider, click: () => pickProvider(provider),
        })),
        { type: 'separator' },
        ...(chatModels?.length
          ? chatModels.map((name) => ({
            label: cloud.free.includes(name) ? `${name} · ${t.cloudFree}` : name,
            type: 'radio', checked: name === pickModel(cfg), click: () => updateConfig({ chatModel: name }),
          }))
          : [{ label: (chatError || t.noOllama).slice(0, 80), enabled: false }]),
        // Ollama's free cloud models when you're signed in to it, fetched on the click (it takes a second)
        ...(cfg.provider === 'ollama' && chatModels ? [
          ...cloud.free.filter((name) => !chatModels.includes(name)).map((name) => ({
            label: `${name} · ${t.cloudFree}`, type: 'radio', checked: false, click: () => fetchModel(name).catch(() => rebuildTray()),
          })),
          ...(cloud.account?.signin ? [{ label: t.cloudSignin, click: signInToOllama }] : []),
        ] : []),
        { type: 'separator' },
        ...(cfg.provider === 'claude' ? [
          { label: `Claude Code: ${cfg.claudeCwd || app.getPath('home')}`, click: pickClaudeFolder },
          {
            label: 'Claude Code permissions',
            submenu: llm.CLAUDE_MODES.map((mode) => ({
              label: mode, type: 'radio', checked: cfg.claudeMode === mode, click: () => updateConfig({ claudeMode: mode }),
            })),
          },
        ] : []),
        { label: t.forget, click: forgetChats },
        // the key (or the address) of the one picked, pasted in her panel
        { label: t.apiKey, click: () => sendCommand('setupKey') },
      ],
    },
    { label: t.wander, type: 'checkbox', checked: cfg.wander, click: (item) => updateConfig({ wander: item.checked }) },
    {
      label: caps.has('windowTracking') ? t.possess : `${t.possess} (${t.unavailable})`,
      enabled: caps.has('windowTracking'), type: 'checkbox', checked: caps.has('windowTracking') && cfg.possess,
      click: (item) => updateConfig({ possess: item.checked }),
    },
    // her jealousy also comes from the other assistants' hooks, not only from the window in front
    { label: t.jealous, type: 'checkbox', checked: cfg.jealous !== false, click: (item) => updateConfig({ jealous: item.checked }) },
    { label: t.pcReact, type: 'checkbox', checked: cfg.pcReact !== false, click: (item) => updateConfig({ pcReact: item.checked }) },
    {
      // she asks first (what she'll send where), then turns it on herself
      label: t.lookAuto, type: 'checkbox', checked: Boolean(cfg.watchScreen),
      click: (item) => {
        sendCommand('watchScreen', { on: item.checked });
        rebuildTray(); // as it is until she's asked
      },
    },
    {
      label: t.rest,
      submenu: [['corner', t.restCorner], ['taskbar', t.restTaskbar]].map(([rest, label]) => ({
        label, type: 'radio', checked: cfg.rest === rest, click: () => updateConfig({ rest }),
      })),
    },
    // the coding assistant she watches (a new one: she says hello and offers to plug herself in), or none
    {
      label: t.watch,
      submenu: [
        ...Object.entries(ASSISTANTS).map(([id, { name }]) => ({
          label: name,
          type: 'radio',
          checked: cfg.claude && watched.id === id,
          click: () => {
            const other = watched.id !== id;
            updateConfig({ claude: true, assistant: id, ...(other && { linked: false, welcomed: false }) });
            if (other) sendCommand('assistantChanged');
          },
        })),
        { label: t.watchNone, type: 'radio', checked: !cfg.claude, click: () => updateConfig({ claude: false }) },
      ],
    },
    // how much she speaks up on her own (initiative.js): never errors, prompts, reminders or answers
    {
      label: t.initiative,
      submenu: [['quiet', t.initiativeQuiet], ['normal', t.initiativeNormal], ['active', t.initiativeActive]].map(([initiative, label]) => ({
        // an unknown value (an old or hand-edited config) reads as normal, as in her settings window
        label, type: 'radio', checked: (['quiet', 'active'].includes(cfg.initiative) ? cfg.initiative : 'normal') === initiative, click: () => updateConfig({ initiative }),
      })),
    },
    {
      label: t.motion,
      submenu: [['auto', t.motionAuto], ['full', t.motionFull], ['reduced', t.motionReduced]].map(([motion, label]) => ({
        label, type: 'radio', checked: cfg.motion === motion, click: () => updateConfig({ motion, motionAsked: true }),
      })),
    },
    {
      label: t.display,
      // only read when she starts: she restarts in the mode picked
      submenu: [['auto', t.displayAuto], ['gl', t.displayGl], ['software', t.displaySoftware]].map(([render, label]) => ({
        label, type: 'radio', checked: cfg.render === render,
        click: () => {
          if (cfg.render === render) return;
          config.save({ render });
          app.relaunch();
          app.exit(0);
        },
      })),
    },
    {
      label: t.lang,
      // Auto names the language it gives right now: "Automatic: English"
      submenu: [[t.auto(t.langNames[resolveLang('auto')]), 'auto'], ...LANGS.map((code) => [TRAY[code].name, code])].map(([label, code]) => ({
        label, type: 'radio', checked: lang.langSetting(cfg.lang, LANGS) === code, click: () => updateConfig({ lang: code }),
      })),
    },
    {
      label: caps.has('autostart') ? t.startup : `${t.startup} (${t.unavailable})`,
      type: 'checkbox',
      enabled: caps.has('autostart'),
      checked: caps.has('autostart') && app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
    },
    // her hooks, while she watches Claude Code
    ...(cfg.claude ? [
      { type: 'separator' },
      hookState.installed
        ? { label: t.hooksOn, enabled: false }
        : { label: t.hooksOff, click: () => runHooks('install') },
      ...(hookState.installed ? [{ label: t.hooksRemove, click: () => runHooks('uninstall') }] : []),
    ] : []),
    { type: 'separator' },
    { label: t.quit, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  trayMenu = menu;
  settings?.update(); // what the menu shows, her settings window shows too
}

// Run from a clone (`npm start`), electron.exe alone would open the default Electron app at login:
// it needs the project folder as argument.
function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [ROOT] };
}

// From the tray, she says how it went; from her welcome panel (quiet), the panel does.
function runHooks(action, { quiet = false } = {}) {
  let outcome;
  try {
    const result = action === 'install' ? activeHooks().install() : activeHooks().uninstall();
    outcome = { action, ok: true, file: result.file };
  } catch (err) {
    outcome = { action, ok: false, error: err.message };
  }
  if (!quiet) sendCommand('hooks', outcome);
  rebuildTray();
  return outcome;
}

// The model she talks with: the one picked in her menu if it's still installed, else the first one
// on this PC (a cloud model only once you pick it).
function pickModel(cfg = config.load()) {
  if (!chatModels?.length) return null;
  if (chatModels.includes(cfg.chatModel)) return cfg.chatModel;
  return chatModels.find((m) => !ollama.isCloud(m)) || chatModels[0];
}

async function refreshModels() {
  const cfg = config.load();
  chatError = null;
  chatErrorCode = null;
  chatModels = await llm.models(cfg.provider, llmConfig(cfg)).catch((err) => {
    chatError = err.message;
    chatErrorCode = err.code || null;
    return null;
  });
  rebuildTray();
  if (cfg.provider === 'ollama' && chatModels) refreshCloud(); // in the background: it asks ollama.com
  return chatModels;
}

// Whether you're signed in to Ollama, and its free cloud models if so. Once a minute at most.
let cloudCheck = null; // the look under way
function refreshCloud(force = false) {
  if (!force && Date.now() - cloud.at < 60000) return cloudCheck || Promise.resolve(cloud);
  const at = Date.now();
  cloud.at = at;
  cloudCheck = (async () => {
    const account = await ollama.account();
    const free = account?.name ? await ollama.freeModels() : [];
    cloud = { at, account, free };
    rebuildTray();
    return cloud;
  })().finally(() => { cloudCheck = null; });
  return cloudCheck;
}

// A model fetched with Ollama (a cloud one is only a small file), then her chat on it.
async function fetchModel(name, onProgress, signal) {
  await setup.pullModel(name, onProgress, signal);
  updateConfig({ provider: 'ollama' });
  await refreshModels();
  const model = chatModels?.find((m) => m === name || m.startsWith(`${name}:`));
  if (model) updateConfig({ chatModel: model });
  return model;
}

// The page that links this PC to your Ollama account, then a look every few seconds until you're in.
async function signInToOllama() {
  if (!cloud.account?.signin) return;
  shell.openExternal(cloud.account.signin);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await refreshCloud(true)).account?.name) return;
  }
}

// Her answer from the model picked, or from the next one when that one can't: too busy twice in a row
// (Gemini's "high demand", an Ollama cloud model out of free use), not served anymore (an older model
// closed to new keys), or signed out of Ollama. A model on this PC first. The model that answered is
// kept for next time.
async function chatWithFallback(cfg, messages, send, signal, streamed) {
  let model = pickModel(cfg);
  const tried = new Set();
  let busy = 0;
  for (;;) {
    try {
      const text = await llm.chat(cfg.provider, llmConfig(cfg), { model, messages }, send, signal);
      if (model !== pickModel(cfg)) updateConfig({ chatModel: model });
      return text;
    } catch (err) {
      if (signal.aborted || streamed() || !['busy', 'gone', 'signin'].includes(err.code)) throw err;
      if (err.code === 'busy' && busy++ === 0) {
        await new Promise((r) => setTimeout(r, 1500)); // usually gone a moment later
        continue;
      }
      tried.add(model);
      const next = chatModels?.find((m) => !tried.has(m) && !ollama.isCloud(m)) || chatModels?.find((m) => !tried.has(m));
      if (!next || tried.size >= 3) throw err;
      model = next;
      busy = 0;
    }
  }
}

// She looks at your screen (look.js): a picture of the screen she's on, kept here in memory a moment
// for her AI to look at, never written anywhere. 1280 px wide at most: enough to read, light to send.
const snaps = new Map(); // id -> the picture, base64 JPEG
async function snapScreen() {
  const d = targetDisplay();
  const k = d.scaleFactor || 1;
  const fit = Math.min(1, 1280 / (d.bounds.width * k));
  const size = { width: Math.round(d.bounds.width * k * fit), height: Math.round(d.bounds.height * k * fit) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('no picture of the screen');
  return src.thumbnail.toJPEG(72).toString('base64');
}

// What her AI says about that picture, as her (`persona`), asked `prompt`. With a code when it can't:
// 'noai' (nothing to ask), 'novision' (that model can't look at pictures).
async function sayAboutSnap({ id, persona, prompt, history = [] }) {
  const image = snaps.get(id);
  snaps.delete(id);
  if (!image) return { ok: false, error: 'the picture is gone' };
  const cfg = config.load();
  if (!chatModels?.length) await refreshModels();
  const model = pickModel(cfg);
  if (!model) return { ok: false, code: 'noai' };
  if (cfg.provider === 'claude') return { ok: false, code: 'novision', model: 'Claude Code' };
  if (cfg.provider === 'ollama' && !(await ollama.canSee(model))) return { ok: false, code: 'novision', model };
  const user = cfg.provider === 'ollama'
    ? { role: 'user', content: prompt, images: [image] }
    : { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] };
  // asked in her chat: the conversation so far comes before it (text only)
  const before = (Array.isArray(history) ? history : []).filter((m) => typeof m?.content === 'string' && ['user', 'assistant'].includes(m.role));
  const messages = [{ role: 'system', content: persona }, ...before, user];
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await llm.chat(cfg.provider, llmConfig(cfg), { model, messages }, () => {}, AbortSignal.timeout(120000));
      return { ok: true, text, model };
    } catch (err) {
      if (err.code === 'busy' && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const novision = /image|vision|multimodal|modalit|image_url|content.*(part|type)/i.test(err.message);
      return { ok: false, error: err.message, code: novision ? 'novision' : err.code || null, model };
    }
  }
}

async function pickProvider(provider) {
  updateConfig({ provider });
  await refreshModels();
  if (chatErrorCode) sendCommand('setupKey'); // it needs a key or an address: she asks for it
}

// What llm.js gets: the config with its keys opened (they're kept encrypted, setup.js)
function llmConfig(cfg = config.load()) {
  return { ...cfg, apiKeys: keys.openKeys(cfg.apiKeys) };
}

async function pickClaudeFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: config.load().claudeCwd || app.getPath('home') });
  if (canceled || !filePaths[0]) return;
  llm.resetClaude(); // a new folder, a new Claude Code conversation (hers goes on)
  saveMemory({ claude: null });
  updateConfig({ claudeCwd: filePaths[0] });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icons', 'tray.png'));
  tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 22, height: 22 }) : icon);
  tray.setToolTip('Capri');
  tray.on('click', () => sendCommand('status'));
  rebuildTray();
}

function registerIpc() {
  ipcMain.on('renderer:ready', () => {
    sendPower(); // a reload while you were away: she starts paused
    if (!SMOKE) return;
    const cfg = config.load();
    console.log(`[capri] smoke ready: ${process.platform}/${process.arch} lang=${resolveLang(cfg.lang)} (${lang.langSetting(cfg.lang, LANGS)})`);
    smokeSettings().then(() => app.quit(), (err) => {
      console.error('[capri] smoke settings failed:', err?.message ?? err);
      app.exit(1);
    });
  });
  ipcMain.on('overlay:interactive', (_e, on) => {
    overlay?.setIgnoreMouseEvents(!on, process.platform === 'linux' ? undefined : { forward: true });
  });
  ipcMain.on('overlay:rearm', () => rearmOverlay()); // the pointer moved over her and she never heard of it
  ipcMain.handle('overlay:cursor', () => {
    const p = screen.getCursorScreenPoint();
    const b = overlay.getBounds();
    const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    return { x: p.x - b.x, y: p.y - b.y, inside, display: displayAt(p).id };
  });
  // your screens (their bounds), the one she's on, and where her window is
  ipcMain.handle('screens:list', () => {
    const o = overlay.getBounds();
    return {
      current: targetDisplay().id,
      origin: { x: o.x, y: o.y },
      list: displays().map(({ id, bounds: b }) => ({ id, x: b.x, y: b.y, w: b.width, h: b.height })),
    };
  });
  ipcMain.handle('screens:move', async (_e, id) => {
    const area = moveOverlay(id);
    if (!area) return null;
    await new Promise((r) => setTimeout(r, 60));
    overlay.setBounds(area); // again, once Windows has settled it on its new screen
    const o = overlay.getBounds();
    return { origin: { x: o.x, y: o.y }, width: o.width, height: o.height, gap: overlayArea().gap };
  });
  ipcMain.handle('config:get', () => rendererConfig());
  // her settings window (settings-preload.js): answered only for that window
  ipcMain.handle('settings:view', (e) => (settings?.owns(e.sender) ? settingsView(settingsFacts()) : null));
  ipcMain.on('settings:close', (e) => settings?.owns(e.sender) && settings.close());
  ipcMain.on('settings:menu', (e) => settings?.owns(e.sender) && trayMenu?.popup({ window: settings.window() }));
  ipcMain.handle('settings:set', (e, patch) => (settings?.owns(e.sender) ? applySettings(patch) : null));
  ipcMain.handle('settings:key', (e, input) => (settings?.owns(e.sender) ? saveSettingsKey(input) : null));
  ipcMain.handle('settings:reset', (e) => (settings?.owns(e.sender) ? resetSettings() : null));
  ipcMain.on('settings:restart', (e) => {
    if (!settings?.owns(e.sender)) return;
    app.relaunch();
    app.quit(); // not exit(): will-quit still stops her window watcher and frees her shortcuts
  });
  ipcMain.on('settings:ready', (e, info) => {
    if (!settings?.owns(e.sender)) return;
    if (DEV || SMOKE) console.log('[capri] settings ready:', JSON.stringify(info));
    settingsReady?.(info);
  });
  ipcMain.handle('updates:check', (e) => (settings?.owns(e.sender) ? updates?.check() : null));
  ipcMain.handle('updates:download', (e) => (settings?.owns(e.sender) ? updates?.download() : null));
  // "Update and restart", confirmed in the window first (settings.js confirmUpdate)
  ipcMain.handle('updates:install', (e, confirmed) => (settings?.owns(e.sender) ? updates?.install(async () => confirmed === true) : null));
  ipcMain.on('updates:page', (e) => settings?.owns(e.sender) && isReleasePage(updates?.page()) && shell.openExternal(updates.page()));
  ipcMain.handle('hooks:status', () => activeHooks().status());
  ipcMain.handle('config:set', (_e, patch) => updateConfig(patch));
  ipcMain.handle('demo:window', (_e, open) => demoWindow(open));
  // right-clicking her: the same menu as the tray icon (which Windows often hides behind the ^ by the clock)
  ipcMain.on('menu:open', () => trayMenu?.popup({ window: overlay }));
  // her welcome panel's buttons
  ipcMain.handle('hooks:install', () => runHooks('install', { quiet: true }));
  ipcMain.handle('claude:found', () => fs.existsSync(path.dirname(activeHooks().status().file))); // Claude Code keeps its settings there
  ipcMain.on('claude:help', () => shell.openExternal(activeAssistant().help));
  ipcMain.handle('windows:get', () => lastWindows);
  // talking to her (chat.js): is Ollama there, with a model to talk with
  ipcMain.handle('chat:status', async () => {
    const cfg = config.load(true); // keys may have been edited by hand
    const { provider } = cfg;
    const models = await refreshModels();
    if (!models) return { ok: false, error: chatError || 'offline', code: chatErrorCode, provider };
    if (!models.length) return { ok: false, error: 'nomodel', provider };
    const model = pickModel();
    llm.warm(provider, model); // loading while you type your first message
    const local = llm.isLocal(provider, cfg, model);
    return { ok: true, provider, model, agent: provider === 'claude', local, warmup: provider === 'ollama' && local };
  });
  // her answer, streamed to the overlay piece by piece as `chat:delta`
  ipcMain.handle('chat:send', async (_e, { id, messages }) => {
    const abort = new AbortController();
    chats.set(id, abort);
    try {
      let streamed = false;
      const send = (text) => {
        streamed = true;
        overlay?.webContents.send('chat:delta', { id, text });
      };
      const cfg = config.load();
      const text = await chatWithFallback(cfg, messages, send, abort.signal, () => streamed);
      if (cfg.provider === 'claude') saveMemory({ claude: llm.claudeMemory() });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: abort.signal.aborted ? 'stopped' : err.message, code: err.code || null };
    } finally {
      chats.delete(id);
    }
  });
  ipcMain.on('chat:stop', (_e, id) => chats.get(id)?.abort());
  // she looks at your screen (look.js): the picture first, then what her AI says about it
  ipcMain.handle('look:snap', async () => {
    try {
      const id = randomUUID();
      snaps.set(id, await snapScreen());
      setTimeout(() => snaps.delete(id), 120000);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('look:say', (_e, request) => sayAboutSnap(request || {}));
  // how hard the processor works, in %, since the last time she asked (pc.js)
  let cpuBefore = null;
  ipcMain.handle('pc:cpu', () => {
    const now = os.cpus().map(({ times: t }) => ({ idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }));
    const before = cpuBefore;
    cpuBefore = now;
    if (!before) return null;
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      idle += c.idle - (before[i]?.idle || 0);
      total += c.total - (before[i]?.total || 0);
    });
    return total > 0 ? Math.round(100 * (1 - idle / total)) : null;
  });
  // where her AI runs, for what she tells you before she looks: { local, provider, model }
  ipcMain.handle('look:where', () => {
    const cfg = config.load();
    const model = pickModel(cfg);
    const provider = cfg.provider === 'ollama' && ollama.isCloud(model) ? 'Ollama' : llm.PROVIDERS[cfg.provider]?.label || cfg.provider;
    return { local: llm.isLocal(cfg.provider, cfg, model), provider, model };
  });
  ipcMain.handle('chat:memory', () => readMemory().history || []);
  ipcMain.on('chat:remember', (_e, history) => Array.isArray(history) && saveMemory({ history }));
  ipcMain.on('chat:ollama', () => shell.openExternal(OLLAMA_SITE));
  // setting her up with buttons (setup.js): Ollama and a model, or a key, or an address
  const progress = (payload) => overlay?.webContents.send('setup:progress', payload);
  let pulling = null; // AbortController of the model being fetched
  ipcMain.handle('setup:info', async () => {
    // the free cloud models too, when Ollama is up and you're signed in to it
    const { free } = (await ollama.models().catch(() => null)) ? await refreshCloud() : { free: [] };
    return { models: setup.MODELS, cloud: free, ram: os.totalmem(), keyed: Object.keys(setup.KEY_PAGES) };
  });
  ipcMain.handle('setup:ollama', () => setup.ollamaState());
  ipcMain.handle('setup:install', () => (caps.has('ollamaInstall')
    ? setup.installOllama((line) => progress({ kind: 'install', line }))
    : { ok: false, unsupported: true }));
  ipcMain.handle('setup:start', async () => {
    const res = await setup.startOllama();
    await refreshModels();
    return res;
  });
  ipcMain.handle('setup:pull', async (_e, name) => {
    if (!setup.MODELS.some((m) => m.name === name) && !cloud.free.includes(name)) return { ok: false, error: 'unknown model' };
    pulling?.abort();
    const abort = new AbortController();
    pulling = abort;
    try {
      const model = await fetchModel(name, (p) => progress({ kind: 'pull', ...p }), abort.signal);
      return { ok: true, model };
    } catch (err) {
      return { ok: false, error: abort.signal.aborted ? 'stopped' : err.message };
    } finally {
      if (pulling === abort) pulling = null;
    }
  });
  ipcMain.on('setup:cancel', () => pulling?.abort());
  // who answers her chat, with its key or address if it needs one: saved, tried, and undone if it fails
  ipcMain.handle('setup:use', async (_e, { provider, key, url }) => {
    if (!llm.PROVIDERS[provider]) return { ok: false, error: 'unknown provider' };
    const before = config.load();
    const patch = { provider };
    if (key) patch.apiKeys = { ...before.apiKeys, [provider]: keys.sealKey(String(key).trim()) };
    if (url) patch.customUrl = String(url).trim();
    updateConfig(patch);
    const models = await refreshModels();
    if (models?.length) return { ok: true, model: pickModel() };
    const error = models ? 'no model' : chatError || 'offline';
    updateConfig({ provider: before.provider, apiKeys: before.apiKeys, customUrl: before.customUrl });
    await refreshModels();
    return { ok: false, error };
  });
  ipcMain.on('setup:keyPage', (_e, provider) => setup.KEY_PAGES[provider] && shell.openExternal(setup.KEY_PAGES[provider]));
  ipcMain.handle('setup:launch', (_e, integration) => (caps.has('ollamaLaunch') ? setup.launchThroughOllama(integration) : { ok: false, unsupported: true }));
  // closing an app you asked her to close, once you've clicked to confirm (apps.js)
  const appInfo = (app) => app && { name: app.process, label: app.label };
  ipcMain.handle('apps:list', async () => (caps.has('appList') ? (await apps.list().catch(() => [])).map(appInfo) : []));
  ipcMain.handle('apps:find', async (_e, wanted) => (caps.has('appList') ? appInfo(await apps.find(wanted).catch(() => null)) : null));
  ipcMain.handle('apps:close', (_e, { name, force }) => (caps.has('appClose')
    ? apps.close(name, { force }).catch((err) => ({ error: err.message }))
    : { unsupported: true }));
  // opening things you ask her to (launch.js): an app or a game, your music, a website
  ipcMain.handle('apps:findLaunch', async (_e, text) => {
    const item = await launch.find(String(text || '')).catch(() => null);
    return item && { ...item, risky: launch.risky(item) }; // a program or a script: behind a button
  });
  ipcMain.handle('apps:youtube', (_e, query) => launch.youtube(query).catch(() => null));
  ipcMain.handle('apps:roblox', (_e, query) => launch.roblox(query).catch(() => null));
  // your files (files.js): a search, opening what it found, a screenshot, a search on the web
  ipcMain.handle('files:search', (_e, query) => files.search(query).catch(() => []));
  ipcMain.handle('files:open', (_e, { file, reveal }) => files.open(String(file), { reveal: Boolean(reveal) }).then(() => true, () => false));
  ipcMain.handle('files:screenshot', () => files.screenshot(targetDisplay()).catch(() => null));
  ipcMain.handle('web:search', (_e, query) => {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) return false;
    return shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(q)}`).then(() => true, () => false);
  });
  ipcMain.handle('apps:launch', (_e, item) => launch.launch(item).then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message })));
  ipcMain.handle('apps:media', (_e, action) => (caps.has('mediaKeys') ? launch.media(action) : false));
  ipcMain.handle('apps:music', (_e, query) => launch.music(query).catch(() => false));
  ipcMain.handle('apps:site', (_e, address) => launch.site(address).catch(() => false));
  // typing to her: the overlay takes the keyboard while the chat is open, and gives it back after
  ipcMain.on('overlay:focus', (_e, on) => {
    if (!overlay) return;
    overlay.setFocusable(Boolean(on));
    if (on) overlay.focus();
    else overlay.blur();
  });
  // her report card's copy button: a picture of that part of the overlay, on the clipboard
  ipcMain.handle('panel:copy', async (_e, rect) => {
    const image = await overlay.webContents.capturePage(rect);
    if (image.isEmpty()) return false;
    const png = new Blob([image.toPNG()], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  });
  // her guide: where her tray icon is (it lives in the taskbar, off the overlay, hence overlay
  // coordinates past its edge), and the corner by the clock in case Windows hid it behind the ^
  ipcMain.handle('guide:tray', () => {
    const o = overlay.getBounds();
    const d = targetDisplay().bounds;
    const b = tray?.getBounds();
    const icon = b && b.width > 0 ? { x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height } : null;
    const corner = { x: d.x + d.width - 150 - o.x, y: d.y + d.height - 44 - o.y, w: 140, h: 40 };
    return { icon, corner };
  });
  // her guide: Claude Code's folder (~/.claude) in Explorer, its settings file selected
  ipcMain.handle('guide:claudeFolder', () => {
    const file = activeHooks().status().file;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) return { found: false, dir };
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(dir);
    return { found: true, dir, file: fs.existsSync(file), label: fs.existsSync(file) ? path.basename(file) : path.basename(dir) };
  });
  ipcMain.handle('sounds:list', () => {
    try {
      return fs.readdirSync(userSoundsDir())
        .filter((f) => SOUND_EXT.test(f))
        .map((f) => ({ name: f.replace(SOUND_EXT, '').toLowerCase(), url: `capri://usersounds/${encodeURIComponent(f)}` }));
    } catch {
      return [];
    }
  });
}

// --smoke-test: her settings window opens with its sections, asking again brings back the same
// one, Escape closes it, and the overlay is still there after.
let settingsReady = null; // resolves the wait for the settings page to say it's up
function waitSettingsReady(ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('settings page never got ready')), ms);
    settingsReady = (info) => {
      clearTimeout(timer);
      settingsReady = null;
      resolve(info);
    };
  });
}
// One field changed through the window as a person would (her volume slider): it must reach the
// config, the file on disk, the overlay, and come back to the window in the status line.
async function smokeSettingsChange(win) {
  const target = config.load().volume === 0.3 ? 0.5 : 0.3;
  await win.webContents.executeJavaScript(`(() => {
    const range = document.getElementById('field-volume');
    range.value = '${Math.round(target * 100)}';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const poll = async (check, what) => {
    for (let i = 0; i < 30; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`settings change: ${what}`);
  };
  await poll(() => config.load().volume === target, 'config not updated');
  await poll(() => JSON.parse(fs.readFileSync(config.file(), 'utf8')).volume === target, 'config file not written');
  await poll(async () => (await overlay.webContents.executeJavaScript('window.dev?.voice?.volume')) === target, 'overlay not updated');
  await poll(async () => (await win.webContents.executeJavaScript(
    `(() => { const s = document.getElementById('status'); return Boolean(s.textContent) && !s.classList.contains('settings__status--error') && document.getElementById('field-volume').value; })()`)) === String(Math.round(target * 100)), 'window did not say it was saved');
  return `volume=${target}`;
}

async function smokeSettings() {
  const ready = waitSettingsReady();
  const win = settings.open();
  const info = await ready;
  if (info?.sections !== 4) throw new Error(`settings shows ${info?.sections} sections`);
  if (settings.open() !== win) throw new Error('a second settings window opened');
  const windows = BrowserWindow.getAllWindows().length;
  // its fonts come through tokens.css (@import): they must load from the settings page too
  const fonts = await win.webContents.executeJavaScript(
    `Promise.all(['700 16px "Chakra Petch"', '400 13px "JetBrains Mono"'].map((f) => document.fonts.load(f).then((l) => l.length)))`);
  if (fonts.some((n) => !n)) throw new Error(`settings fonts did not load: ${fonts}`);
  // drawn again with the focus on a control: the focus stays on it
  await win.webContents.executeJavaScript(`document.getElementById('menu-general').focus()`);
  settings.update();
  const kept = await win.webContents.executeJavaScript(
    `new Promise((r) => setTimeout(() => r(document.activeElement?.id || null), 300))`);
  if (kept !== 'menu-general') throw new Error(`focus lost when the settings were drawn again (${kept})`);
  const changed = await smokeSettingsChange(win);
  // a field's hint is read with it: its display mode always says when it's taken into account
  const described = await win.webContents.executeJavaScript(`(() => {
    const ids = (document.getElementById('field-render')?.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
    return ids.length > 0 && ids.every((id) => document.getElementById(id)?.textContent);
  })()`);
  if (!described) throw new Error('settings hints not tied to their fields (aria-describedby)');
  // shown first (ready-to-show may come after the page said it's ready), then Escape, sent again
  // until it lands: on Xvfb or a CI desktop a key can go before the window really has the focus
  if (!win.isVisible()) await new Promise((resolve) => { win.once('show', resolve); setTimeout(resolve, 5000); });
  let closed = false;
  win.once('closed', () => { closed = true; });
  for (let i = 0; i < 10 && !closed; i++) {
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!closed) throw new Error('Escape did not close the settings window');
  if (settings.isOpen() || !overlay || overlay.isDestroyed()) throw new Error('closing the settings touched the overlay');
  // opened again after closing: a new window, the one before is gone
  const again = waitSettingsReady();
  const second = settings.open();
  await again;
  if (second === win) throw new Error('the closed settings window came back');
  settings.close();
  console.log(`[capri] smoke settings: ok (sections=${info.sections}, focus=${info.focused}, windows=${windows}, ${changed})`);
}

// Only in --dev: lets scripts drive the overlay and grab frames of it (no desktop content, just our window).
const testWins = new Map(); // name -> test window

async function debugHandler(route, body) {
  if (!DEV) throw new Error('debug routes need --dev');
  if (route === 'command') {
    sendCommand(body.name, body);
    return { ok: true };
  }
  if (route === 'power') {
    // her pause, without locking anything: { event: 'lock-screen' | 'unlock-screen' | 'suspend' |
    // 'resume' | ... } as if powerMonitor had sent it (to her pause only: the window watcher and
    // the mouse hook don't hear of it), or { away: true | false } held until said otherwise
    if (typeof body.away === 'boolean') powerWatch?.test(body.away);
    else if (body.event) powerWatch?.emit(String(body.event));
    return { ok: true, value: powerWatch?.state() ?? null };
  }
  if (route === 'reload') {
    overlay.webContents.reloadIgnoringCache();
    return { ok: true };
  }
  if (route === 'unhook') {
    // the pointer no longer passed on to her, as when Windows drops the mouse hook
    overlay.setIgnoreMouseEvents(true);
    return { ok: true };
  }
  if (route === 'testwin') {
    // plain windows to sit on, opened without stealing focus, by name (`id`, default "main");
    // each one opened goes in front of the others. { open: false } without an id closes them all.
    const id = body.id ?? 'main';
    if (!body.open && body.id === undefined) {
      for (const win of testWins.values()) win.destroy();
      testWins.clear();
      return { ok: true };
    }
    testWins.get(id)?.destroy();
    testWins.delete(id);
    if (body.open) {
      const b = overlay.getBounds();
      const win = new BrowserWindow({
        x: b.x + (body.x ?? 300), y: b.y + (body.y ?? 380), width: body.w ?? 720, height: body.h ?? 380,
        show: false, alwaysOnTop: PERCH_ON_TOP, title: `Capri test window ${id}`, backgroundColor: '#1b1726',
      });
      win.loadURL('data:text/html,<body style="background:%231b1726"></body>');
      win.showInactive();
      testWins.set(id, win);
    }
    return { ok: true };
  }
  if (route === 'movewin' && testWins.has(body.id ?? 'main')) {
    const win = testWins.get(body.id ?? 'main');
    const [x, y] = win.getPosition();
    win.setPosition(x + (body.dx || 0), y + (body.dy || 0));
    return { ok: true };
  }
  if (route === 'mouse') {
    // the pointer moving over the overlay (css px), and clicking if asked, without touching the real one
    const at = { x: Math.round(body.x), y: Math.round(body.y) };
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    if (body.click) {
      overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
      overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at });
    }
    return { ok: true };
  }
  if (route === 'menu') {
    // her menu as labels, and a click on one of them if asked ({ click: 'beam:cloud · ...' })
    const items = (menu) => menu.items.filter((i) => i.label).map((i) => (i.submenu ? { [i.label]: items(i.submenu) } : i.label));
    const find = (menu) => menu.items.reduce((hit, i) => hit || (i.label === body.click ? i : i.submenu && find(i.submenu)), null);
    if (body.click) find(trayMenu)?.click();
    return { ok: true, value: items(trayMenu) };
  }
  if (route === 'eval') {
    // a look inside the overlay (app.js puts what's there on window.dev in --dev)
    return { ok: true, value: await overlay.webContents.executeJavaScript(String(body.js || 'null')) };
  }
  if (route === 'drag') {
    // a drag over the overlay with a stand-in pointer, the real one untouched: the button goes down
    // at the first point, follows the others (each `ms` after the one before), and comes up at the last
    const points = Array.isArray(body.points) ? body.points : [];
    if (!points.length) throw new Error('drag needs points');
    const at = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...at(points[0]) });
    overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at(points[0]) });
    for (const p of points.slice(1)) {
      await new Promise((r) => setTimeout(r, p.ms ?? 16));
      overlay.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], ...at(p) });
    }
    if (body.up !== false) overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at(points.at(-1)) });
    return { ok: true };
  }
  if (route === 'type') {
    // typing into the overlay (her chat), and Enter if asked
    if (body.text) await overlay.webContents.insertText(body.text);
    if (body.enter) {
      overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      overlay.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
      overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
    return { ok: true };
  }
  if (route === 'settings') {
    // her settings window: { open: true } / { open: false }, { capture: 'name' } for a picture of it
    if (body.open === true) settings.open();
    if (body.open === false) settings.close();
    if (body.capture && settings.isOpen()) {
      const image = await settings.window().webContents.capturePage();
      const dir = path.join(app.isPackaged ? app.getPath('userData') : ROOT, 'captures');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${String(body.capture).replace(/[^\w-]/g, '')}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { ok: true, file };
    }
    if (Array.isArray(body.size) && settings.isOpen()) settings.window().setSize(...body.size.map(Number)); // [width, height]
    if (body.key && settings.isOpen()) {
      // a key pressed in it ({ key: 'Tab', shift: true }), the real keyboard untouched
      const contents = settings.window().webContents;
      const modifiers = body.shift ? ['shift'] : [];
      contents.sendInputEvent({ type: 'keyDown', keyCode: String(body.key), modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode: String(body.key), modifiers });
      return { ok: true };
    }
    if (body.js && settings.isOpen()) return { ok: true, value: await settings.window().webContents.executeJavaScript(String(body.js)) };
    return { ok: true, value: settings.isOpen() };
  }
  if (route === 'capture') {
    const image = await overlay.webContents.capturePage();
    // installed, the app's own folder is read-only: its data folder instead
    const dir = path.join(app.isPackaged ? app.getPath('userData') : ROOT, 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${(body.name || 'frame').replace(/[^\w-]/g, '')}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { ok: true, file };
  }
  throw new Error('unknown debug route');
}

// How her window is drawn, set before Electron starts (her menu › Display). On some PCs her see-through
// window shows up black (NVIDIA with FXAA, MFAA or HDR on, for one): drawing it through OpenGL, or
// without the graphics card, often fixes it.
let RENDER_AT_START = null; // the display mode she was started with (her settings say when a restart is due)
function applyRender() {
  const { render } = config.load();
  RENDER_AT_START = render || 'auto';
  if (render === 'gl') app.commandLine.appendSwitch('use-angle', 'gl');
  if (render === 'software') {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('enable-unsafe-swiftshader'); // her drawing still needs WebGL, done on the CPU
  }
  // --dev: what Chromium ended up drawing with
  if (DEV) app.whenReady().then(() => setTimeout(() => console.log('[capri] display:', render, JSON.stringify(app.getGPUFeatureStatus())), 4000));
}

// macOS: the keyboard shortcuts of text fields (Cmd+C, V, X, A, Z) come from the app's menu, and
// without one they do nothing in her settings window (pasting a key). A small one, then: the app
// with Quit, Edit, Window. Reload and DevTools only in --dev. Windows and Linux need none (text
// fields have their shortcuts without it), and Electron's default one is removed there outside --dev:
// it would give her windows Ctrl+R (reload), Ctrl+Shift+I (DevTools) and Ctrl+W (close her overlay).
function appMenu() {
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    {
      role: 'editMenu',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    // not the roles: Cmd+W / Cmd+M would close or minimize her overlay too, focused while you type
    // in her chat, and with no Dock icon there'd be no getting her back
    {
      role: 'windowMenu',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: (_item, win) => win && win !== overlay && win.minimize() },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: (_item, win) => win && win !== overlay && win.close() },
      ],
    },
    ...(DEV ? [{ label: 'Dev', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }] : []),
  ]);
}

function main() {
  applyRender();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => sendCommand('status'));
  if (process.platform === 'win32') app.setAppUserModelId('capri.desktop');

  app.whenReady().then(() => {
    if (!['codex', 'claude'].includes(config.load().assistant)) config.save({ assistant: activeAssistant().id });
    if (process.platform === 'darwin') app.dock?.hide();
    if (process.platform === 'darwin') Menu.setApplicationMenu(appMenu());
    else if (!DEV) Menu.setApplicationMenu(null);
    serveProtocol();
    registerIpc();
    settings = createSettingsWindow({
      BrowserWindow,
      preload: path.join(__dirname, '..', 'settings-preload.js'),
      url: 'capri://app/src/renderer/settings.html',
      view: () => settingsView(settingsFacts()),
      area: () => targetDisplay().workArea,
      // no Dock icon on macOS: the app has to come forward for its window to get the keyboard
      focusApp: () => process.platform === 'darwin' && app.focus({ steal: true }),
    });
    updates = startUpdates({ platform, smoke: SMOKE, onChange: updatesChanged });
    createOverlay();
    createTray();
    // an adapter that starts or gives up changes what she offers: the menu and the overlay hear of it
    caps.onChange(() => updateConfig({}));
    windowWatch = startWindowWatch({
      platform,
      overlay: { // what the watchers ask of her window (the platform's overlay handle, from the next commit)
        bounds: () => overlay.getBounds(),
        isAlive: () => !overlay.isDestroyed(),
        nativeHandle: () => overlay.getNativeWindowHandle(),
        mediaSourceId: () => overlay.getMediaSourceId(),
      },
      session: caps.session, // Linux: X11 only, never XWayland or native Wayland
      onState: (ok) => caps.set('windowTracking', ok),
      onUpdate: (data) => {
        // a click on the taskbar brings it up over her: sitting on it, her legs would vanish behind it
        if (data.taskbar && !lastWindows?.taskbar && config.load().rest === 'taskbar') raiseOverlay();
        lastWindows = data;
        overlay?.webContents.send('windows:update', data);
      },
    });
    if (!SMOKE) createBridge({
      port: PORT,
      // her own Claude Code chat's hooks would cover its answer with theirs
      onEvent: (evt) => !llm.isChatSession(evt.session_id) && overlay?.webContents.send('claude:event', evt),
      onDebug: DEV ? debugHandler : null,
    });
    globalShortcut.register('Control+Alt+C', () => toggleVisible());
    llm.restoreClaude(readMemory().claude);
    if (!SMOKE) refreshModels(); // for her menu's model list
    if (!SMOKE) setTimeout(() => launch.launchables().catch(() => {}), 20000); // what she can open, before you ask
    // a screen plugged in, unplugged, or rearranged: her window fitted again, and she learns of it
    const screensChanged = () => {
      fitOverlay();
      windowWatch?.refresh();
      rebuildTray();
      sendCommand('screens');
    };
    screen.on('display-metrics-changed', screensChanged);
    screen.on('display-added', screensChanged);
    screen.on('display-removed', screensChanged);
    // after sleep or a locked screen, once Windows has settled
    powerMonitor.on('resume', () => setTimeout(rearmOverlay, 2000));
    powerMonitor.on('unlock-screen', () => setTimeout(rearmOverlay, 1000));
    // and meanwhile her overlay pauses what's only for show (power.js; the macOS window watcher
    // pauses its helper on the same events itself: windows.js). Main goes on: the bridge still
    // takes Claude Code's events and passes them on, she shows what matters once you're back.
    powerWatch = watchPower({ power: powerMonitor, onChange: sendPower });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    powerWatch?.stop();
    windowWatch?.stop();
  });
  app.on('window-all-closed', () => {});
}

main();
