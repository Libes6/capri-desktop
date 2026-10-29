'use strict';

// Her menu, as data: the template of { label, type, checked, enabled, accelerator, click, submenu }
// that the tray icon and the right click on her show. Built again at each change (core.js
// rebuildTray), from the config and what the core knows; the platform turns it into a real menu
// (platform.tray.setMenu). A click is called with the item as it is after the click (`item.checked`).
// Nothing here touches the system: everything goes through `platform` and the core's own actions.

const fs = require('node:fs');
const { TRAY, LANGS } = require('./labels');
const lang = require('./lang');
const llm = require('./llm');
const { ASSISTANTS } = require('./assistants');

function trayMenuTemplate({
  platform, config, caps, port, settings, updateOffered, chatModels, chatError, cloud,
  activeAssistant, activeHooks, resolveLang, displays, targetDisplay,
  sendCommand, playDemo, toggleVisible, openSettings, updateConfig, userSoundsDir, pickModel, pickProvider, fetchModel,
  signInToOllama, pickClaudeFolder, forgetChats, runHooks, rebuildTray,
}) {
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

  return [
    { label: t.online(port), enabled: false },
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
            platform.shell.openPath(userSoundsDir());
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
          { label: `Claude Code: ${cfg.claudeCwd || platform.paths.get('home')}`, click: pickClaudeFolder },
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
    // WebKit and WebView2 pick their own renderer: the Tauri build has no display mode to offer (platform.app.renderModes)
    ...(platform.app.renderModes === false ? [] : [
      {
        label: t.display,
        // only read when she starts: she restarts in the mode picked
        submenu: [['auto', t.displayAuto], ['gl', t.displayGl], ['software', t.displaySoftware]].map(([render, label]) => ({
          label, type: 'radio', checked: cfg.render === render,
          click: () => {
            if (cfg.render === render) return;
            config.save({ render });
            platform.app.relaunch();
            platform.app.exit(0);
          },
        })),
      },
    ]),
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
      checked: caps.has('autostart') && platform.autostart.isEnabled(),
      click: (item) => platform.autostart.set(item.checked),
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
    { label: t.quit, click: () => platform.app.quit() },
  ];
}

module.exports = { trayMenuTemplate };
