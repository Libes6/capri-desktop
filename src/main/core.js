'use strict';

// The core of Capri: her state (the overlay and settings windows she is shown in, the chat, the
// updates, the screens), the rules (what the menu offers, what a settings change does) and the
// handlers of every command from her pages. It runs on a platform (platform/index.js) and never
// imports a shell: sidecar/main.js runs it under the Tauri shell (src-tauri/), platform/sidecar.js its hands.
//
//   const core = createCore({ platform, port, dev, smoke, notify })
//   (watchWindows: another window watcher than windows.js's, for the tests)
//   core.ipc.on / core.ipc.handle   channel -> fn(arg, sender): the handlers themselves
//   core.dispatch                   the door of her pages (dispatch.js): handle(name, args, sender) and
//                                   handleChannel(channel, payload, sender) check the window, the arguments
//                                   against src/protocol.js, then call the handler. The shell registers these.
//   core.start({ debug })           once the platform is ready: windows, tray, watchers, bridge
//   core.stop()                     on quit
// `notify.rendererReady()` / `notify.settingsReady(info)`: the shell hears of the pages saying they are up.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const { createConfig } = require('./config');
const { TRAY, LANGS } = require('./labels');
const lang = require('./lang');
const { createBridge } = require('./bridge');
const { startWindowWatch, SCRIPT: WINDOW_HELPER } = require('./windows');
const { watchPower } = require('./power');
const { createCapabilities } = require('./capabilities');
const { settingsView } = require('./settings-view');
const { startUpdates, isReleasePage } = require('./updates');
const { createDispatcher } = require('./dispatch');
const settingsPatch = require('./settings-patch');
const llm = require('./llm');
const ollama = require('./ollama');
const setup = require('./setup');
const apps = require('./apps');
const { createLaunch } = require('./launch');
const { createFiles } = require('./files');
const { ASSISTANTS, assistant } = require('./assistants');
const { trayMenuTemplate } = require('./tray-menu');
const demoSteps = require('../../scripts/demo-sequence');

const SOUND_EXT = /\.(mp3|wav|ogg|m4a)$/i;
const OLLAMA_SITE = 'https://ollama.com';

// Her demo and --dev test windows stay on top, except on macOS: a window above the normal level is
// not one the helper reports as a perch (mac/window-watch.js), and showInactive() brings it up anyway.
const PERCH_ON_TOP = process.platform !== 'darwin';

function createCore({ platform, port = Number(process.env.CAPRI_PORT) || 47823, dev = false, smoke = false, notify = {}, watchWindows = startWindowWatch }) {
  const DEV = dev;
  const SMOKE = smoke;
  const PORT = port;
  const config = createConfig({ platform });
  const keys = setup.createKeys({ platform });
  const launch = createLaunch({ platform });
  const files = createFiles({ platform });
  const activeAssistant = () => assistant(config.load().assistant); // Claude Code or Codex
  const activeHooks = () => activeAssistant().hooks;
  // what works on this computer (capabilities.js): the menu, the overlay and the IPC below go by it
  const caps = createCapabilities({ helpers: { windowWatch: WINDOW_HELPER } });
  const ipc = { on: {}, handle: {} };
  const ipcOn = (channel, fn) => { ipc.on[channel] = fn; };
  const ipcHandle = (channel, fn) => { ipc.handle[channel] = fn; };

  let overlay = null;
  let tray = null; // her tray icon (platform.tray)
  let trayTemplate = null; // her menu as data (tray-menu.js): also what she opens when you right-click her
  let settings = null; // her settings window (settings-window.js), made in start()
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

  const userSoundsDir = () => path.join(platform.paths.get('userData'), 'sounds');

  // Her memory of your chats, across restarts: { history: [{ role, content }], claude: Claude Code's session }
  const memoryFile = () => path.join(platform.paths.get('userData'), 'memory.json');
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

  // Your screens. In --dev with CAPRI_SCREENS=2 and only one screen, it's cut in two halves side by
  // side, to try her going from one to the other without a second monitor.
  function displays() {
    const real = platform.screens.all();
    if (!DEV || process.env.CAPRI_SCREENS !== '2' || real.length > 1) return real;
    const d = platform.screens.primary();
    const half = (r, i) => ({ x: r.x + Math.floor(r.width / 2) * i, y: r.y, width: Math.floor(r.width / 2), height: r.height });
    return [0, 1].map((i) => ({ ...d, id: d.id * 10 + i + 1, bounds: half(d.bounds, i), workArea: half(d.workArea, i), size: { width: Math.floor(d.size.width / 2), height: d.size.height } }));
  }

  // The screen a point (DIP) is on, else the nearest one.
  function displayAt(p) {
    const all = displays();
    const inside = all.find(({ bounds: b }) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height);
    if (inside) return inside;
    const near = platform.screens.nearest(p);
    return all.find((d) => d.id === near.id) || all[0];
  }

  function targetDisplay() {
    const { displayId } = config.load();
    const all = displays();
    return all.find((d) => d.id === displayId) || all.find((d) => d.id === platform.screens.primary().id) || all[0];
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
    overlay.send('overlay:resize', { width: area.width, height: area.height, gap });
  }

  // The pointer reaches her click-through window through a mouse hook, and Windows drops a hook that
  // doesn't answer in time without a word (waking from sleep, a locked screen, a stall): she can't be
  // clicked anymore. Off then on puts in a new one; her place on top and her size are set again too.
  function rearmOverlay() {
    if (!overlay || !overlay.isAlive()) return;
    overlay.clickThrough(false);
    overlay.clickThrough(true);
    overlay.keepOnTop();
    fitOverlay();
    sendCommand('rearmed'); // click-through again: she waits for the pointer to be on her
    console.log('[capri] mouse hook set up again');
  }

  // Back on top of everything, the taskbar included (it comes up over her when it's clicked). Twice:
  // the taskbar can come up again a moment later, as its menus and previews open.
  function raiseOverlay() {
    for (const wait of [0, 400]) {
      setTimeout(() => {
        if (!overlay || !overlay.isAlive()) return;
        overlay.raise();
      }, wait);
    }
  }

  function createOverlay() {
    // always shown: put away, she's still there as her biochip in the corner. Sized again first (onReady):
    // Windows keeps a new window inside the work area, and resting on the taskbar it covers it too.
    overlay = platform.windows.createOverlay({ area: overlayArea().area, onReady: fitOverlay });
  }

  // Away (screen locked, asleep) or back: the overlay's only word of it (preload.js onPower).
  function sendPower() {
    if (powerWatch) overlay?.send('power:state', powerWatch.state());
  }

  function sendCommand(name, payload = {}) {
    overlay?.send('capri:command', { name, ...payload });
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
        overlay?.send('claude:event', evt);
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

  function demoWindow(open) {
    demoWin?.destroy();
    demoWin = null;
    if (!open || !caps.has('windowTracking')) return false;
    const b = overlay.bounds();
    demoWin = platform.windows.createDemoTerminal({
      x: Math.round(b.x + b.width * 0.5 - 310), y: Math.round(b.y + b.height * 0.42), width: 620, height: 300,
      alwaysOnTop: PERCH_ON_TOP, title: 'night-city-api — npm test', background: '#14101c', html: DEMO_TERMINAL,
      onClosed: () => { demoWin = null; },
    });
    return true;
  }

  // 'auto' -> the first system language Capri speaks, English otherwise (lang.js). Asked each time,
  // so a change in the system's languages shows at her next start without touching the 'auto' kept in the config.
  function systemLanguages() {
    return platform.app.languages();
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
      renderModes: platform.app.renderModes !== false,
      lang: resolveLang(cfg.lang),
      langSetting: lang.langSetting(cfg.lang, LANGS),
      autoLang: resolveLang('auto'),
      assistant: cfg.claude ? activeAssistant() : null,
      hooksInstalled: cfg.claude ? Boolean(activeHooks().status().installed) : false,
      provider: llm.PROVIDERS[cfg.provider]?.label || cfg.provider,
      model: pickModel(cfg),
      features: caps.all(),
      autostart: caps.has('autostart') && platform.autostart.isEnabled(),
      screen: { index: Math.max(0, screens.findIndex((d) => d.id === current.id)), count: screens.length, width: current.size.width, height: current.size.height },
      about: { version: platform.app.version(), platform: process.platform, arch: process.arch, runtime: platform.app.runtimeVersion(), session: caps.session },
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
        platform.autostart.set(effects.autostart);
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
    overlay?.send('capri:config', cfg);
    rebuildTray();
    return cfg;
  }

  function rebuildTray() {
    if (!tray) return;
    trayTemplate = trayMenuTemplate({
      platform, config, caps, port: PORT, settings, updateOffered, chatModels, chatError, cloud,
      activeAssistant, activeHooks, resolveLang, displays, targetDisplay,
      sendCommand, playDemo, toggleVisible, openSettings, updateConfig, userSoundsDir, pickModel, pickProvider, fetchModel,
      signInToOllama, pickClaudeFolder, forgetChats, runHooks, rebuildTray,
    });
    tray.setMenu(trayTemplate);
    settings?.update(); // what the menu shows, her settings window shows too
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
    platform.shell.openExternal(cloud.account.signin);
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
    const picture = await platform.capture.screen(d, { ...size, format: 'jpeg', quality: 72 });
    if (!picture) throw new Error('no picture of the screen');
    return picture.toString('base64');
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
    const folder = await platform.dialogs.pickFolder(config.load().claudeCwd || platform.paths.get('home'));
    if (!folder) return;
    llm.resetClaude(); // a new folder, a new Claude Code conversation (hers goes on)
    saveMemory({ claude: null });
    updateConfig({ claudeCwd: folder });
  }

  function createTray() {
    tray = platform.tray.create({ onClick: () => sendCommand('status') });
    rebuildTray();
  }

  // --- the commands of her pages (the shell registers them: ipc.on fire and forget, ipc.handle answered)

  ipcOn('renderer:ready', () => {
    sendPower(); // a reload while you were away: she starts paused
    notify.rendererReady?.();
  });
  ipcOn('overlay:interactive', (on) => {
    overlay?.clickThrough(!on);
  });
  ipcOn('overlay:rearm', () => rearmOverlay()); // the pointer moved over her and she never heard of it
  ipcHandle('overlay:cursor', () => {
    const p = platform.screens.cursor();
    const b = overlay.bounds();
    const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    return { x: p.x - b.x, y: p.y - b.y, inside, display: displayAt(p).id };
  });
  // your screens (their bounds), the one she's on, and where her window is
  ipcHandle('screens:list', () => {
    const o = overlay.bounds();
    return {
      current: targetDisplay().id,
      origin: { x: o.x, y: o.y },
      list: displays().map(({ id, bounds: b }) => ({ id, x: b.x, y: b.y, w: b.width, h: b.height })),
    };
  });
  ipcHandle('screens:move', async (id) => {
    const area = moveOverlay(id);
    if (!area) return null;
    await new Promise((r) => setTimeout(r, 60));
    overlay.setBounds(area); // again, once Windows has settled it on its new screen
    const o = overlay.bounds();
    return { origin: { x: o.x, y: o.y }, width: o.width, height: o.height, gap: overlayArea().gap };
  });
  ipcHandle('config:get', () => rendererConfig());
  // her settings window : answered only for that window
  ipcHandle('settings:view', (_arg, sender) => (settings?.owns(sender) ? settingsView(settingsFacts()) : null));
  ipcOn('settings:close', (_arg, sender) => settings?.owns(sender) && settings.close());
  ipcOn('settings:menu', (_arg, sender) => settings?.owns(sender) && tray?.popup('settings'));
  ipcHandle('settings:set', (patch, sender) => (settings?.owns(sender) ? applySettings(patch) : null));
  ipcHandle('settings:key', (input, sender) => (settings?.owns(sender) ? saveSettingsKey(input) : null));
  ipcHandle('settings:reset', (_arg, sender) => (settings?.owns(sender) ? resetSettings() : null));
  ipcOn('settings:restart', (_arg, sender) => {
    if (!settings?.owns(sender)) return;
    platform.app.relaunch();
    platform.app.quit(); // not exit(): will-quit still stops her window watcher and frees her shortcuts
  });
  ipcOn('settings:ready', (info, sender) => {
    if (!settings?.owns(sender)) return;
    if (DEV || SMOKE) console.log('[capri] settings ready:', JSON.stringify(info));
    notify.settingsReady?.(info);
  });
  ipcHandle('updates:check', (_arg, sender) => (settings?.owns(sender) ? updates?.check() : null));
  ipcHandle('updates:download', (_arg, sender) => (settings?.owns(sender) ? updates?.download() : null));
  // "Update and restart", confirmed in the window first (settings.js confirmUpdate)
  ipcHandle('updates:install', (confirmed, sender) => (settings?.owns(sender) ? updates?.install(async () => confirmed === true) : null));
  ipcOn('updates:page', (_arg, sender) => settings?.owns(sender) && isReleasePage(updates?.page()) && platform.shell.openExternal(updates.page()));
  ipcHandle('hooks:status', () => activeHooks().status());
  ipcHandle('config:set', (patch) => updateConfig(patch));
  ipcHandle('demo:window', (open) => demoWindow(open));
  // right-clicking her: the same menu as the tray icon (which Windows often hides behind the ^ by the clock)
  ipcOn('menu:open', () => tray?.popup('overlay'));
  // her welcome panel's buttons
  ipcHandle('hooks:install', () => runHooks('install', { quiet: true }));
  ipcHandle('claude:found', () => fs.existsSync(path.dirname(activeHooks().status().file))); // Claude Code keeps its settings there
  ipcOn('claude:help', () => platform.shell.openExternal(activeAssistant().help));
  ipcHandle('windows:get', () => lastWindows);
  // talking to her (chat.js): is Ollama there, with a model to talk with
  ipcHandle('chat:status', async () => {
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
  ipcHandle('chat:send', async ({ id, messages }) => {
    const abort = new AbortController();
    chats.set(id, abort);
    try {
      let streamed = false;
      const send = (text) => {
        streamed = true;
        overlay?.send('chat:delta', { id, text });
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
  ipcOn('chat:stop', (id) => chats.get(id)?.abort());
  // she looks at your screen (look.js): the picture first, then what her AI says about it
  ipcHandle('look:snap', async () => {
    try {
      const id = randomUUID();
      snaps.set(id, await snapScreen());
      setTimeout(() => snaps.delete(id), 120000);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcHandle('look:say', (request) => sayAboutSnap(request || {}));
  // how hard the processor works, in %, since the last time she asked (pc.js)
  let cpuBefore = null;
  ipcHandle('pc:cpu', () => {
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
  ipcHandle('look:where', () => {
    const cfg = config.load();
    const model = pickModel(cfg);
    const provider = cfg.provider === 'ollama' && ollama.isCloud(model) ? 'Ollama' : llm.PROVIDERS[cfg.provider]?.label || cfg.provider;
    return { local: llm.isLocal(cfg.provider, cfg, model), provider, model };
  });
  ipcHandle('chat:memory', () => readMemory().history || []);
  ipcOn('chat:remember', (history) => Array.isArray(history) && saveMemory({ history }));
  ipcOn('chat:ollama', () => platform.shell.openExternal(OLLAMA_SITE));
  // setting her up with buttons (setup.js): Ollama and a model, or a key, or an address
  const progress = (payload) => overlay?.send('setup:progress', payload);
  let pulling = null; // AbortController of the model being fetched
  ipcHandle('setup:info', async () => {
    // the free cloud models too, when Ollama is up and you're signed in to it
    const { free } = (await ollama.models().catch(() => null)) ? await refreshCloud() : { free: [] };
    return { models: setup.MODELS, cloud: free, ram: os.totalmem(), keyed: Object.keys(setup.KEY_PAGES) };
  });
  ipcHandle('setup:ollama', () => setup.ollamaState());
  ipcHandle('setup:install', () => (caps.has('ollamaInstall')
    ? setup.installOllama((line) => progress({ kind: 'install', line }))
    : { ok: false, unsupported: true }));
  ipcHandle('setup:start', async () => {
    const res = await setup.startOllama();
    await refreshModels();
    return res;
  });
  ipcHandle('setup:pull', async (name) => {
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
  ipcOn('setup:cancel', () => pulling?.abort());
  // who answers her chat, with its key or address if it needs one: saved, tried, and undone if it fails
  ipcHandle('setup:use', async ({ provider, key, url }) => {
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
  ipcOn('setup:keyPage', (provider) => setup.KEY_PAGES[provider] && platform.shell.openExternal(setup.KEY_PAGES[provider]));
  ipcHandle('setup:launch', (integration) => (caps.has('ollamaLaunch') ? setup.launchThroughOllama(integration) : { ok: false, unsupported: true }));
  // closing an app you asked her to close, once you've clicked to confirm (apps.js)
  const appInfo = (app) => app && { name: app.process, label: app.label };
  ipcHandle('apps:list', async () => (caps.has('appList') ? (await apps.list().catch(() => [])).map(appInfo) : []));
  ipcHandle('apps:find', async (wanted) => (caps.has('appList') ? appInfo(await apps.find(wanted).catch(() => null)) : null));
  ipcHandle('apps:close', ({ name, force }) => (caps.has('appClose')
    ? apps.close(name, { force }).catch((err) => ({ error: err.message }))
    : { unsupported: true }));
  // opening things you ask her to (launch.js): an app or a game, your music, a website
  ipcHandle('apps:findLaunch', async (text) => {
    const item = await launch.find(String(text || '')).catch(() => null);
    return item && { ...item, risky: launch.risky(item) }; // a program or a script: behind a button
  });
  ipcHandle('apps:youtube', (query) => launch.youtube(query).catch(() => null));
  ipcHandle('apps:roblox', (query) => launch.roblox(query).catch(() => null));
  // your files (files.js): a search, opening what it found, a screenshot, a search on the web
  ipcHandle('files:search', (query) => files.search(query).catch(() => []));
  ipcHandle('files:open', ({ file, reveal }) => files.open(String(file), { reveal: Boolean(reveal) }).then(() => true, () => false));
  ipcHandle('files:screenshot', () => files.screenshot(targetDisplay()).catch(() => null));
  ipcHandle('web:search', (query) => {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) return false;
    return platform.shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(q)}`).then(() => true, () => false);
  });
  ipcHandle('apps:launch', (item) => launch.launch(item).then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message })));
  ipcHandle('apps:media', (action) => (caps.has('mediaKeys') ? launch.media(action) : false));
  ipcHandle('apps:music', (query) => launch.music(query).catch(() => false));
  ipcHandle('apps:site', (address) => launch.site(address).catch(() => false));
  // typing to her: the overlay takes the keyboard while the chat is open, and gives it back after
  ipcOn('overlay:focus', (on) => {
    if (!overlay) return;
    overlay.setFocusable(Boolean(on));
    if (on) overlay.focus();
    else overlay.blur();
  });
  // her report card's copy button: a picture of that part of the overlay, on the clipboard
  ipcHandle('panel:copy', async (rect) => {
    const png = await overlay.capture(rect);
    if (!png) return false;
    await platform.clipboard.writeImage(png);
    return true;
  });
  // her guide: where her tray icon is (it lives in the taskbar, off the overlay, hence overlay
  // coordinates past its edge), and the corner by the clock in case Windows hid it behind the ^
  ipcHandle('guide:tray', () => {
    const o = overlay.bounds();
    const d = targetDisplay().bounds;
    const b = tray?.bounds();
    const icon = b && b.width > 0 ? { x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height } : null;
    const corner = { x: d.x + d.width - 150 - o.x, y: d.y + d.height - 44 - o.y, w: 140, h: 40 };
    return { icon, corner };
  });
  // her guide: Claude Code's folder (~/.claude) in Explorer, its settings file selected
  ipcHandle('guide:claudeFolder', () => {
    const file = activeHooks().status().file;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) return { found: false, dir };
    if (fs.existsSync(file)) platform.shell.showItemInFolder(file);
    else platform.shell.openPath(dir);
    return { found: true, dir, file: fs.existsSync(file), label: fs.existsSync(file) ? path.basename(file) : path.basename(dir) };
  });
  ipcHandle('sounds:list', () => {
    try {
      return fs.readdirSync(userSoundsDir())
        .filter((f) => SOUND_EXT.test(f))
        .map((f) => ({ name: f.replace(SOUND_EXT, '').toLowerCase(), url: platform.app.userSoundUrl(f) }));
    } catch {
      return [];
    }
  });

  // How her window is drawn, set before the platform starts (her menu › Display). On some PCs her see-through
  // window shows up black (NVIDIA with FXAA, MFAA or HDR on, for one): drawing it through OpenGL, or
  // without the graphics card, often fixes it.
  let RENDER_AT_START = null; // the display mode she was started with (her settings say when a restart is due)
  function applyRender() {
    const { render } = config.load();
    RENDER_AT_START = render || 'auto';
    platform.app.setRenderMode(render);
    // --dev: what the platform ended up drawing with
    if (DEV) platform.app.whenReady().then(() => setTimeout(() => console.log('[capri] display:', render, JSON.stringify(platform.app.gpuStatus())), 4000));
  }

  // The platform is ready: her windows, her tray, the watchers, the bridge for the assistants' hooks.
  // debug: the --dev routes (sidecar/debug.js)
  function start({ debug = null } = {}) {
    if (!['codex', 'claude'].includes(config.load().assistant)) config.save({ assistant: activeAssistant().id });
    settings = platform.windows.createSettings({
      view: () => settingsView(settingsFacts()),
      area: () => targetDisplay().workArea,
    });
    updates = startUpdates({ platform, smoke: SMOKE, onChange: updatesChanged });
    createOverlay();
    createTray();
    // an adapter that starts or gives up changes what she offers: the menu and the overlay hear of it
    caps.onChange(() => updateConfig({}));
    windowWatch = watchWindows({
      platform,
      overlay,
      session: caps.session, // Linux: X11 only, never XWayland or native Wayland
      onState: (ok) => caps.set('windowTracking', ok),
      onUpdate: (data) => {
        // a click on the taskbar brings it up over her: sitting on it, her legs would vanish behind it
        if (data.taskbar && !lastWindows?.taskbar && config.load().rest === 'taskbar') raiseOverlay();
        lastWindows = data;
        overlay?.send('windows:update', data);
      },
    });
    if (!SMOKE) createBridge({
      port: PORT,
      // her own Claude Code chat's hooks would cover its answer with theirs
      onEvent: (evt) => !llm.isChatSession(evt.session_id) && overlay?.send('claude:event', evt),
      onDebug: DEV ? debug : null,
    });
    platform.shortcuts.register('Control+Alt+C', () => toggleVisible());
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
    platform.screens.on('display-metrics-changed', screensChanged);
    platform.screens.on('display-added', screensChanged);
    platform.screens.on('display-removed', screensChanged);
    // after sleep or a locked screen, once Windows has settled
    platform.power.on('resume', () => setTimeout(rearmOverlay, 2000));
    platform.power.on('unlock-screen', () => setTimeout(rearmOverlay, 1000));
    // and meanwhile her overlay pauses what's only for show (power.js; the macOS window watcher
    // pauses its helper on the same events itself: windows.js). Main goes on: the bridge still
    // takes Claude Code's events and passes them on, she shows what matters once you're back.
    powerWatch = watchPower({ power: platform.power, onChange: sendPower });
  }

  function stop() {
    platform.shortcuts.unregisterAll();
    powerWatch?.stop();
    windowWatch?.stop();
  }

  // Her menu as it is now, for the --dev route: the labels (a submenu as { label: [...] }), and a click
  // on the item with that label, as the menu would give it (a checkbox flips, a radio is picked)
  const menuLabels = (menu = trayTemplate) => (menu || []).filter((i) => i.label).map((i) => (i.submenu ? { [i.label]: menuLabels(i.submenu) } : i.label));
  function menuClick(label) {
    const find = (menu) => menu.reduce((hit, i) => hit || (i.label === label ? i : i.submenu && find(i.submenu)), null);
    const item = trayTemplate && find(trayTemplate);
    if (!item?.click) return;
    if (item.type === 'checkbox') item.click({ ...item, checked: !item.checked });
    else if (item.type === 'radio') item.click({ ...item, checked: true });
    else item.click(item);
  }

  // which of her windows a message comes from (the dispatcher lets a command in from its own window only)
  const dispatch = createDispatcher({
    handlers: ipc,
    scopeOf: (sender) => (settings?.owns(sender) ? 'settings' : overlay?.owns?.(sender) ? 'overlay' : null),
  });

  return {
    config,
    ipc,
    dispatch,
    start,
    stop,
    applyRender,
    command: sendCommand,
    userSoundsDir,
    menu: { labels: () => menuLabels(), click: menuClick },
    power: () => powerWatch,
    overlay: () => overlay,
    settings: () => settings,
    caps: () => caps,
    resolveLang,
  };
}

module.exports = { createCore, PERCH_ON_TOP };
