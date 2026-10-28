// The renderer's only way out to the native side (TAURI-03). Nothing else in src/renderer may touch
// window.host, window.settingsHost, window.__CAPRI_HOST__ or window.__TAURI__ (tests/host-guard.test.js).
//
// Two verbs, whatever is underneath:
//   invoke(name, args)  a command; args is the array of positional arguments; returns what it answers
//   on(event, cb)       an event from the native side; returns an unsubscribe function
// plus named helpers (host.setConfig(patch), host.onConfig(cb) ...) that are only sugar over those two.
//
// Which implementation answers is picked when a command is first used:
//   1. window.__CAPRI_HOST__   { invoke(name, args), on(event, cb) } set by the Tauri bridge (or a test page)
//   2. window.__TAURI__        the generic Tauri bridge below (commands go to one Rust command, events to its event bus)
//   3. the Electron preload    window.host (overlay) / window.settingsHost (settings), called by method name
// Channels, names and behaviour are the preload's; this file only gives them one shape.

// name: the command (the preload method). Events: [event, preload method].
const OVERLAY = {
  scope: 'overlay',
  electron: 'host',
  calls: [
    'rendererReady', 'setInteractive', 'rearm', 'cursor', 'screens', 'moveScreen', 'getConfig', 'setConfig',
    'listSounds', 'hooksStatus', 'demoWindow', 'openMenu', 'installHooks', 'claudeFound', 'openClaudeHelp',
    'windowsNow', 'trayPlace', 'openClaudeFolder', 'copyImage', 'chatStatus', 'chatSend', 'chatStop',
    'chatMemory', 'chatRemember', 'lookSnap', 'lookSay', 'lookWhere', 'cpu', 'openOllama', 'setupInfo',
    'ollamaState', 'installOllama', 'startOllama', 'pullModel', 'cancelSetup', 'useProvider', 'keyPage',
    'launchThroughOllama', 'openApps', 'findApp', 'closeApp', 'findLaunch', 'launch', 'media', 'music',
    'youtube', 'roblox', 'searchFiles', 'openFile', 'screenshot', 'webSearch', 'openSite', 'focusOverlay',
  ],
  events: {
    'claude:event': 'onClaudeEvent',
    'capri:command': 'onCommand',
    'capri:config': 'onConfig',
    'overlay:resize': 'onResize',
    'windows:update': 'onWindows',
    'power:state': 'onPower', // { away, why }: screen locked or asleep (CAPRI-07)
    'chat:delta': 'onChatDelta',
    'setup:progress': 'onSetupProgress',
  },
};

const SETTINGS = {
  scope: 'settings',
  electron: 'settingsHost',
  calls: [
    'view', 'ready', 'set', 'saveKey', 'reset', 'restart', 'openMenu', 'close',
    'updates.check', 'updates.download', 'updates.install', 'updates.page',
  ],
  events: {
    'settings:view': 'onView',
    'settings:section': 'onSection',
    'updates:status': 'onStatus', // updates.onStatus in the preload
  },
};

const walk = (object, path) => path.split('.').reduce((o, key) => o?.[key], object);

function electronImpl(spec) {
  const bridge = window[spec.electron];
  if (!bridge) throw new Error(`no host: window.${spec.electron} is missing (not in Electron, no __CAPRI_HOST__)`);
  const listener = (event) => {
    const method = spec.events[event];
    // the settings preload keeps its status listener under updates
    return walk(bridge, method) || walk(bridge, `updates.${method}`);
  };
  return {
    invoke: (name, args = []) => {
      const parent = name.includes('.') ? walk(bridge, name.slice(0, name.lastIndexOf('.'))) : bridge;
      const fn = walk(bridge, name);
      if (typeof fn !== 'function') throw new Error(`host: no command ${name}`);
      return fn.apply(parent, args);
    },
    on: (event, cb) => {
      const fn = listener(event);
      if (typeof fn !== 'function') throw new Error(`host: no event ${event}`);
      return fn(cb);
    },
  };
}

// The generic Tauri side: one Rust command takes { scope, name, args }, events come over Tauri's bus
// as "capri://<event>". The Rust half arrives with TAURI-04; until it does __CAPRI_HOST__ takes priority.
function tauriImpl(spec) {
  const tauri = window.__TAURI__;
  return {
    invoke: (name, args = []) => tauri.core.invoke('host_invoke', { scope: spec.scope, name, args }),
    on: (event, cb) => {
      const pending = tauri.event.listen(`capri://${event}`, (e) => cb(e.payload));
      return () => pending.then((off) => off());
    },
  };
}

function pick(spec) {
  const custom = window.__CAPRI_HOST__;
  if (custom) return custom[spec.scope] || custom;
  if (window.__TAURI__?.core) return tauriImpl(spec);
  return electronImpl(spec);
}

function create(spec) {
  let impl = null;
  const get = () => (impl ||= pick(spec));
  const host = {
    invoke: (name, args) => get().invoke(name, args),
    on: (event, cb) => get().on(event, cb),
  };
  for (const name of spec.calls) {
    const key = name.replace(/^updates\./, '');
    const target = name.startsWith('updates.') ? (host.updates ||= {}) : host;
    target[key] = (...args) => host.invoke(name, args);
  }
  for (const [event, method] of Object.entries(spec.events)) {
    const target = event === 'updates:status' ? (host.updates ||= {}) : host;
    target[method] = (cb) => host.on(event, cb);
  }
  return Object.freeze(host);
}

export const host = create(OVERLAY);
export const settingsHost = create(SETTINGS);
