'use strict';

// The sidecar platform (platform/index.js) for the Tauri build (TAURI-04): the core runs in a Node
// process next to the Rust shell, and what only the system can do is asked of Rust over JSON-RPC
// (sidecar/rpc.js, one JSON line each way on stdin/stdout). Plain node: no Electron.
//
// What the Rust side answers today: paths, the overlay window (create, bounds, click-through, level,
// focusable), events to her page, quit / relaunch / exit, the screens and the cursor (pushed by Rust,
// read here from a cache because the platform's methods are synchronous), and (TAURI-06) the tray with
// her menu (menu-wire.js), the settings window, the application menu, the global shortcut and the
// autostart. Everything else (secrets, capture, clipboard, shell, power, dialogs, demo
// window, updater) belongs to TAURI-05..07: it answers { unsupported: true } where a method answers
// anything, or the neutral value of its type (no picture: null, no key store: false), and is logged
// once. The core never crashes on it.
//
//   rpc: a sidecar/rpc.js peer
//   hello: what Rust says of itself first (see src-tauri/src/sidecar.rs `hello`): identifier, name,
//          version, paths, screens, cursor, packaged
//   root: the project folder in dev, the resources folder when packaged

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { serializeMenu, createClickBook } = require('./menu-wire');
const { settingsBounds } = require('../settings-window');

function createSidecarPlatform({ rpc, hello, root, log = (m) => console.error(`[sidecar] ${m}`) }) {
  const unsupportedCalls = new Set();
  // one line per method, once: the TAURI-05..07 work list, as it shows in a run
  function unsupported(name, neutral = { unsupported: true }) {
    if (!unsupportedCalls.has(name)) {
      unsupportedCalls.add(name);
      log(`unsupported: ${name} (not in the Tauri shell yet)`);
    }
    return neutral;
  }
  const ask = (method, params) => rpc.request(method, params).catch((err) => { log(`${method}: ${err.message}`); return { error: err.message }; });
  const tell = (method, params) => rpc.notify(method, params);

  let userData = hello.paths.userData;
  let displays = hello.screens || [];
  let cursor = hello.cursor || { x: 0, y: 0 };
  const screens = new EventEmitter();
  const power = new EventEmitter();
  const quitHandlers = [];
  const ipc = { on: new Map(), handle: new Map() };
  let overlay = null;
  let secondInstance = () => {};
  // TAURI-06: the tray (its clicks, the icon's bounds), the settings window, the shortcuts, autostart
  const clickBook = createClickBook();
  let menuGeneration = 0;
  let trayClick = () => {};
  let trayBounds = { x: 0, y: 0, width: 0, height: 0 };
  let settingsOpen = false;
  const shortcutFns = new Map();
  let shortcutCount = 0;
  let autostartOn = Boolean(hello.autostart);

  const inside = (p, b) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
  const dist = (p, b) => {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width - 1));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height - 1));
    return dx * dx + dy * dy;
  };

  // Rust pushes: the screens when they change, the pointer when it moves, a second launch, a quit request
  function onNotification(method, params) {
    if (method === 'screens') {
      displays = params.list || displays;
      screens.emit('display-metrics-changed');
    } else if (method === 'cursor') {
      cursor = params;
    } else if (method === 'second-instance') {
      secondInstance(params);
    } else if (method === 'quit') {
      for (const fn of quitHandlers) { try { fn(); } catch (err) { log(`on quit: ${err.message}`); } }
    } else if (method === 'power') {
      power.emit(params.event);
    } else if (method === 'tray.click') {
      clickBook.click(params.id, params.checked, log);
    } else if (method === 'tray.iconClick') {
      try { trayClick(); } catch (err) { log(`tray click: ${err.message}`); }
    } else if (method === 'tray.bounds') {
      trayBounds = params;
    } else if (method === 'settings.closed') {
      settingsOpen = false;
    } else if (method === 'shortcut') {
      const fn = shortcutFns.get(params.id);
      if (fn) { try { fn(); } catch (err) { log(`shortcut: ${err.message}`); } }
    } else {
      log(`unknown notification ${method}`);
    }
  }

  function overlayHandle(initial, label) {
    let bounds = { ...initial };
    const handle = {
      bounds: () => bounds,
      setBounds: (rect) => {
        bounds = { ...rect };
        ask('overlay.setBounds', { rect }).then((r) => { if (r && r.width) bounds = r; });
      },
      send: (channel, payload) => tell('emit', { window: label, event: channel, payload }),
      clickThrough: (on) => tell('overlay.clickThrough', { on: Boolean(on) }),
      keepOnTop: () => tell('overlay.keepOnTop', {}),
      raise: () => tell('overlay.raise', {}),
      setFocusable: (on) => tell('overlay.setFocusable', { on: Boolean(on) }),
      focus: () => tell('overlay.focus', {}),
      blur: () => tell('overlay.blur', {}),
      isAlive: () => alive,
      // a message from her page arrives as { label }: the window it was sent from
      owns: (sender) => alive && sender?.label === label,
      nativeHandle: () => unsupported('overlay.nativeHandle', Buffer.alloc(8)),
      mediaSourceId: () => unsupported('overlay.mediaSourceId', null),
      capture: async () => unsupported('overlay.capture', null),
    };
    let alive = true;
    handle.markDead = () => { alive = false; };
    handle.setBoundsCache = (rect) => { bounds = { ...rect }; };
    return handle;
  }

  return {
    id: 'sidecar',
    unsupported: unsupportedCalls,
    onNotification,
    // the handlers the core registered (the dispatcher, sidecar/main.js, goes through core.dispatch)
    handlers: ipc,

    paths: {
      get: (name) => {
        if (name === 'userData') return userData;
        const p = hello.paths[name];
        if (!p) throw new Error(`no path named ${name}`);
        return p;
      },
      setUserData: (dir) => { userData = dir; },
    },

    app: {
      name: () => hello.name,
      version: () => hello.version,
      runtimeVersion: () => `tauri ${hello.tauri || ''} / node ${process.versions.node}`.trim(),
      isPackaged: () => Boolean(hello.packaged),
      languages: () => {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
        const env = (process.env.LANG || '').split('.')[0].replace('_', '-');
        const preferred = [env && env !== 'C' && env !== 'POSIX' ? env : locale];
        return { preferred, fallback: [locale, locale] };
      },
      whenReady: () => Promise.resolve(),
      onQuit: (fn) => { quitHandlers.push(fn); },
      // Rust holds the single-instance lock; a second launch comes here as a notification
      singleInstance: (onSecond) => { secondInstance = onSecond; return true; },
      stayAlive: () => {},
      relaunch: () => tell('app.relaunch', {}),
      quit: () => tell('app.quit', {}),
      exit: (code) => tell('app.exit', { code }),
      focus: () => tell('app.focus', {}),
      hideFromDock: () => {}, // Rust does it (Accessory policy) before any window
      setAppId: () => {},
      // macOS: Edit, Quit, Window (not for her overlay); none elsewhere (Rust: menu.rs)
      installAppMenu: () => tell('app.installMenu', {}),
      appForProtocol: () => unsupported('app.appForProtocol', false),
      setRenderMode: () => {},
      gpuStatus: () => ({}),
      serveAssets: () => {}, // Rust serves capri://usersounds/ from userData/sounds itself
    },

    // the login item: Rust says what it is when it starts (hello), and does what it is told
    autostart: {
      isEnabled: () => autostartOn,
      set: (on) => {
        const before = autostartOn;
        autostartOn = Boolean(on);
        ask('autostart.set', { on: autostartOn }).then((r) => {
          if (r && r.error) autostartOn = before;
        });
      },
    },

    screens: Object.assign(screens, {
      all: () => displays,
      primary: () => displays[0],
      nearest: (point) => displays.find((d) => inside(point, d.bounds)) || [...displays].sort((a, b) => dist(point, a.bounds) - dist(point, b.bounds))[0],
      cursor: () => cursor,
      toDip: (rect) => rect, // macOS and Linux coordinates are DIPs already; Windows is TAURI-05
    }),

    power: Object.assign(power, { getSystemIdleState: () => unsupported('power.getSystemIdleState', 'active') }),

    secrets: {
      isAvailable: () => unsupported('secrets.isAvailable', false),
      encrypt: () => { throw new Error('secrets: not in the Tauri shell yet (TAURI-07)'); },
      decrypt: () => { throw new Error('secrets: not in the Tauri shell yet (TAURI-07)'); },
    },

    shell: {
      openExternal: async () => unsupported('shell.openExternal'),
      openPath: async () => { unsupported('shell.openPath'); return 'not in the Tauri shell yet (TAURI-07)'; },
      showItemInFolder: () => unsupported('shell.showItemInFolder'),
    },

    // global shortcuts (tauri-plugin-global-shortcut, Electron's accelerator names). Whether the system
    // took it is known a moment later, so this says yes and logs the refusal (another app holds it)
    shortcuts: {
      register: (accelerator, fn) => {
        const id = `s${++shortcutCount}`;
        shortcutFns.set(id, fn);
        ask('shortcuts.register', { id, accelerator }).then((r) => {
          if (!r || r.error || r.ok === false) {
            shortcutFns.delete(id);
            log(`shortcut ${accelerator} not registered${r?.error ? `: ${r.error}` : ''}`);
          }
        });
        return true;
      },
      unregisterAll: () => {
        shortcutFns.clear();
        tell('shortcuts.unregisterAll', {});
      },
    },

    capture: { screen: async () => unsupported('capture.screen', null) },
    clipboard: { writeImage: async () => unsupported('clipboard.writeImage') },
    dialogs: { pickFolder: async () => unsupported('dialogs.pickFolder', null) },

    // her tray icon: Rust draws it and builds the menu from the data (menu-wire.js); a click on an
    // item comes back by id. On macOS the icon opens the menu; elsewhere a left click is `onClick`.
    tray: {
      create: ({ onClick }) => {
        trayClick = onClick || (() => {});
        tell('tray.create', {});
        return {
          setMenu: (template) => {
            const wire = serializeMenu(template, ++menuGeneration);
            clickBook.add(wire);
            tell('tray.setMenu', { generation: wire.generation, items: wire.items });
          },
          // the same menu as the icon's, over her overlay or her settings window, at the pointer
          popup: (where) => tell('tray.popup', { window: where === 'settings' ? 'settings' : 'overlay' }),
          bounds: () => trayBounds,
        };
      },
    },

    windows: {
      createOverlay: ({ area, onReady = () => {} }) => {
        const handle = overlayHandle(area, 'overlay');
        overlay = handle;
        ask('overlay.create', { area }).then((r) => {
          if (r && r.width) handle.setBoundsCache?.(r);
          onReady();
        });
        return handle;
      },
      // the settings window (src-tauri/src/settings_window.rs): one at a time, made and kept by Rust.
      // Same controller as settings-window.js; `owns` goes by the window's label.
      createSettings: ({ view, area }) => {
        tell('settings.reset', {}); // a window left by a core that went (the sidecar came back) is closed
        const send = (event, payload) => settingsOpen && tell('emit', { window: 'settings', event, payload });
        return {
          open: (section) => {
            settingsOpen = true;
            tell('settings.open', { title: view().title, bounds: settingsBounds(area?.()), section: section || null });
            return { label: 'settings' };
          },
          close: () => { if (settingsOpen) tell('settings.close', {}); },
          update: () => {
            if (!settingsOpen) return;
            const v = view();
            tell('settings.title', { title: v.title });
            send('settings:view', v);
          },
          send,
          isOpen: () => settingsOpen,
          window: () => (settingsOpen ? { label: 'settings' } : null),
          owns: (sender) => settingsOpen && sender?.label === 'settings',
        };
      },
      createDemoTerminal: () => {
        unsupported('windows.createDemoTerminal');
        return { destroy: () => {} };
      },
    },

    ipc: {
      on: (channel, fn) => ipc.on.set(channel, fn),
      handle: (channel, fn) => ipc.handle.set(channel, fn),
    },

    updater: {
      get: () => { throw new Error('updater: not in the Tauri shell yet'); },
    },

    native: null,
    // the dev debug routes (sidecar/debug.js): a request to Rust as it is
    debugRequest: (method, params) => rpc.request(method, params),
    overlayNow: () => overlay,
  };
}

module.exports = { createSidecarPlatform };
