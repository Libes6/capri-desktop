'use strict';

// The sidecar platform (platform/index.js) for the Tauri build (TAURI-04): the core runs in a Node
// process next to the Rust shell, and what only the system can do is asked of Rust over JSON-RPC
// (sidecar/rpc.js, one JSON line each way on stdin/stdout). Plain node.
//
// What the Rust side answers today: paths, the overlay window (create, bounds, click-through, level,
// focusable), events to her page, quit / relaunch / exit, the screens and the cursor (pushed by Rust,
// read here from a cache because the platform's methods are synchronous); (TAURI-06) the tray with
// her menu (menu-wire.js), the settings window, the application menu, the global shortcut and the
// autostart; and (TAURI-07) the key store, screen capture, clipboard, links and files, the folder
// picker, power events and idle time, and which application a link opens; (TAURI-11) the demo's fake
// terminal. Everything else (the picture of the overlay, its native handle: docs/TAURI_PARITY.md) answers { unsupported: true } where a method answers
// anything, or the neutral value of its type (no picture: null, no key store: false), and is logged
// once. The core never crashes on it.
//
// Some methods are synchronous in the platform's contract but need an answer from Rust (secrets, the
// idle state, appForProtocol): `init()` fetches what they need before the core starts (the master key
// of the key store, the links it will ask about), and they answer from that.
//
//   rpc: a sidecar/rpc.js peer
//   hello: what Rust says of itself first (see src-tauri/src/sidecar.rs `hello`): identifier, name,
//          version, paths, screens, cursor, packaged, updater (TAURI-10: { mode, reason })
//   root: the project folder in dev, the resources folder when packaged

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { serializeMenu, createClickBook } = require('./menu-wire');
const { settingsBounds } = require('../settings-window');

const { systemLanguages } = require('./system-languages');
const { sealWith, openWith } = require('../seal'); // "kc:" keys: AES-256-GCM under the master key (src/main/seal.js)

function createSidecarPlatform({ rpc, hello, root, log = (m) => console.error(`[sidecar] ${m}`), detectLanguages = systemLanguages }) {
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

  let preferredLanguages = []; // the system's list, asked once in init() (system-languages.js)
  let masterKey = null; // Buffer, once init() has it; null: no key store, keys stay plain (plain keys)
  let locked = Boolean(hello.locked); // the screen lock, from hello and then the events
  let idle = 'active'; // the last idle state Rust gave
  let idleAsked = 0;
  const protocols = new Map(); // 'roblox' -> bool: which links an application is registered for
  const protocolAsked = new Set();

  let userData = hello.paths.userData;
  let displays = hello.screens || [];
  let cursor = hello.cursor || { x: 0, y: 0 };
  const screens = new EventEmitter();
  const power = new EventEmitter();
  const quitHandlers = [];
  const ipc = { on: new Map(), handle: new Map() };
  let overlay = null;
  const updaterCalls = new Map(); // id -> { resolve, reject, progress, timer }: what Rust (updater.rs) has been asked
  let updaterSeq = 0;
  let secondInstance = () => {};
  // TAURI-06: the tray (its clicks, the icon's bounds), the settings window, the shortcuts, autostart
  const clickBook = createClickBook();
  let menuGeneration = 0;
  let trayClick = () => {};
  let trayBounds = { x: 0, y: 0, width: 0, height: 0 };
  let settingsOpen = false;
  let demoSeq = 0;
  const demoWindows = new Map(); // id -> the demo terminal's handle, while Rust has it
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
      if (Array.isArray(params.list) && params.list.length) displays = params.list; // never none: the core needs a screen
      screens.emit('display-metrics-changed');
    } else if (method === 'cursor') {
      cursor = params;
    } else if (method === 'second-instance') {
      secondInstance(params);
    } else if (method === 'quit') {
      for (const fn of quitHandlers) { try { fn(); } catch (err) { log(`on quit: ${err.message}`); } }
    } else if (method === 'power') {
      if (params.event === 'lock-screen') locked = true;
      else if (params.event === 'unlock-screen') locked = false;
      power.emit(params.event);
    } else if (method === 'tray.click') {
      clickBook.click(params.id, params.checked, log);
    } else if (method === 'tray.iconClick') {
      try { trayClick(); } catch (err) { log(`tray click: ${err.message}`); }
    } else if (method === 'tray.bounds') {
      trayBounds = params;
    } else if (method === 'settings.closed') {
      settingsOpen = false;
    } else if (method === 'demo.closed') {
      // closed by the person (not by the core's destroy, which forgot it): the core hears of it
      const demo = demoWindows.get(params.id);
      if (demo && !demo.destroyed) {
        demoWindows.delete(params.id);
        try { demo.onClosed(); } catch (err) { log(`demo closed: ${err.message}`); }
      }
    } else if (method === 'shortcut') {
      const fn = shortcutFns.get(params.id);
      if (fn) { try { fn(); } catch (err) { log(`shortcut: ${err.message}`); } }
    } else if (method === 'updater.progress') {
      updaterCalls.get(params.id)?.progress?.(params.received, params.total);
    } else if (method === 'updater.result') {
      settleUpdater(params);
    } else {
      log(`unknown notification ${method}`);
    }
  }

  // The updater (src-tauri/src/updater.rs) is asked with a notification and answers with another, so a
  // download never holds the line to Rust. A call that is not answered ends at its time limit.
  function settleUpdater({ id, ok, result, error }) {
    const call = updaterCalls.get(id);
    if (!call) return;
    updaterCalls.delete(id);
    clearTimeout(call.timer);
    if (ok) return call.resolve(result ?? null);
    const category = error?.category;
    call.reject(Object.assign(new Error(error?.message || 'update failed'), {
      code: category === 'signature' ? 'ERR_CAPRI_SIGNATURE' : category === 'network' ? 'ERR_CAPRI_NETWORK' : 'ERR_CAPRI_UPDATE',
      ...(error?.reason && { reason: error.reason }),
    }));
  }

  function updaterCall(method, { progress, timeoutMs }) {
    const id = ++updaterSeq;
    return new Promise((resolve, reject) => {
      const call = { resolve, reject, progress, timer: null };
      const arm = () => {
        clearTimeout(call.timer);
        call.timer = setTimeout(() => {
          updaterCalls.delete(id);
          reject(Object.assign(new Error(`${method}: no answer in ${Math.round(timeoutMs / 1000)} s`), { code: 'ERR_CAPRI_NETWORK' }));
        }, timeoutMs);
        call.timer.unref?.();
      };
      arm();
      if (progress) call.progress = (received, total) => { arm(); progress(received, total); }; // alive while bytes come
      updaterCalls.set(id, call);
      tell(method, { id });
    });
  }

  const updaterInfo = hello.updater || { mode: 'disabled', reason: 'dev' };

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

  // what the synchronous methods answer from; to be awaited before the core is made
  async function init() {
    preferredLanguages = await detectLanguages().catch(() => []);
    // a first use may make the system ask the person to allow it: given time to
    const key = await rpc.request('secrets.masterKey', {}, { timeoutMs: 60000 }).catch((err) => { log(`secrets.masterKey: ${err.message}`); return { error: err.message }; });
    if (key?.available && typeof key.key === 'string') {
      const bytes = Buffer.from(key.key, 'base64');
      if (bytes.length === 32) masterKey = bytes;
      else log('secrets: the master key is not 256 bits; keys stay plain text');
    } else {
      log(`secrets: no system key store${key?.reason || key?.error ? ` (${key.reason || key.error})` : ''}; keys stay plain text in config.json`);
    }
    await Promise.all(['roblox://'].map(lookupProtocol));
  }

  function lookupProtocol(url) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(String(url))?.[1]?.toLowerCase();
    if (!scheme) return Promise.resolve(false);
    protocolAsked.add(scheme);
    return ask('app.appForProtocol', { url: `${scheme}://` }).then((r) => {
      const found = r === true;
      protocols.set(scheme, found);
      return found;
    });
  }

  return {
    id: 'sidecar',
    unsupported: unsupportedCalls,
    init,
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
        if (preferredLanguages.length) return { preferred: preferredLanguages, fallback: [Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'] };
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
      // synchronous in the contract: the answer is the one asked for earlier (init asks for roblox://),
      // false for a link not asked about yet, which is asked now for the next time
      appForProtocol: (url) => {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(String(url))?.[1]?.toLowerCase();
        if (!scheme) return false;
        if (!protocolAsked.has(scheme)) lookupProtocol(url);
        return protocols.get(scheme) === true;
      },
      // the address of one of the user's sound files for her page: capri://usersounds/<file>, which
      // Windows' webview sees as http://capri.localhost/<file> (Rust serves both, assets.rs)
      userSoundUrl: (file) => `${process.platform === 'win32' ? 'http://capri.localhost/' : 'capri://usersounds/'}${encodeURIComponent(file)}`,
      renderModes: false, // WKWebView / WebView2 / WebKitGTK choose their own renderer: no display mode (settings, tray)
      setRenderMode: () => {},
      gpuStatus: () => ({}),
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
      primary: () => displays.find((d) => d.primary) || displays[0],
      nearest: (point) => displays.find((d) => inside(point, d.bounds)) || [...displays].sort((a, b) => dist(point, a.bounds) - dist(point, b.bounds))[0],
      cursor: () => cursor,
      toDip: (rect) => rect, // macOS and Linux coordinates are DIPs already; Windows is TAURI-05
    }),

    // getSystemIdleState is synchronous: 'locked' from the lock events (and hello), else the
    // last idle state Rust gave, which this call refreshes for the next one (at most once a second).
    power: Object.assign(power, {
      getSystemIdleState: (seconds = 60) => {
        if (locked) return 'locked';
        if (Date.now() - idleAsked > 1000) {
          idleAsked = Date.now();
          ask('power.idle', { threshold: seconds }).then((r) => { if (typeof r?.state === 'string') idle = r.state; });
        }
        return idle === 'locked' ? 'active' : idle;
      },
    }),

    secrets: {
      // the core tells a sealed key by this prefix (setup.js createKeys): "kc:"
      prefix: 'kc',
      isAvailable: () => masterKey !== null,
      encrypt: (text) => {
        if (!masterKey) throw new Error('secrets: no system key store');
        return sealWith(masterKey, text);
      },
      decrypt: (buffer) => {
        if (!masterKey) throw new Error('secrets: no system key store');
        return openWith(masterKey, buffer);
      },
    },

    // links: http(s) and the launchers' own only, files and folders as they are (Rust checks, opener.rs)
    shell: {
      openExternal: (url) => rpc.request('shell.openExternal', { url: String(url) }).then(() => {}),
      openPath: (file) => ask('shell.openPath', { path: String(file) }).then((r) => (typeof r === 'string' ? r : r?.error || 'could not open it')),
      showItemInFolder: (file) => { ask('shell.showItemInFolder', { path: String(file) }); },
    },

    // global shortcuts (tauri-plugin-global-shortcut, accelerator names such as 'Control+Alt+C'). Whether the system
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

    capture: {
      // a Buffer (PNG, or JPEG at `quality`), null when there is no picture (no Screen Recording permission…)
      screen: async (display, { width, height, format = 'png', quality = 72 } = {}) => {
        const r = await rpc.request('capture.screen', { bounds: display?.bounds, width, height, format, quality }, { timeoutMs: 60000 }).catch((err) => {
          log(`capture.screen: ${err.message}`);
          return null;
        });
        return typeof r === 'string' ? Buffer.from(r, 'base64') : null;
      },
    },
    clipboard: {
      writeImage: (png) => rpc.request('clipboard.writeImage', { png: Buffer.from(png).toString('base64') }, { timeoutMs: 20000 }).then(() => {}),
      writeText: (text) => rpc.request('clipboard.writeText', { text: String(text) }).then(() => {}),
    },
    // waits as long as the person does
    dialogs: {
      pickFolder: (defaultPath) => rpc.request('dialogs.pickFolder', { default: defaultPath || null }, { timeoutMs: 60 * 60 * 1000 })
        .then((r) => (typeof r === 'string' ? r : null), (err) => { log(`dialogs.pickFolder: ${err.message}`); return null; }),
    },

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
      // the demo's fake terminal (src-tauri/src/demo.rs): a window of its own, shown without the keyboard.
      // Rust says when it is gone; the core's own destroy() is not a "closed" (the core already knows)
      createDemoTerminal: ({ x, y, width, height, title, background, alwaysOnTop, html, onClosed = () => {} }) => {
        const id = ++demoSeq;
        const handle = { id, destroyed: false, onClosed };
        demoWindows.set(id, handle);
        tell('demo.open', { id, x, y, width, height, title, background, alwaysOnTop: Boolean(alwaysOnTop), html });
        return {
          destroy: () => {
            handle.destroyed = true;
            demoWindows.delete(id);
            tell('demo.close', { id });
          },
        };
      },
    },

    ipc: {
      on: (channel, fn) => ipc.on.set(channel, fn),
      handle: (channel, fn) => ipc.handle.set(channel, fn),
    },

    // tauri-plugin-updater, driven by Rust
    updater: {
      get: () => ({
        tauri: {
          // { mode: 'install' | 'notify' | 'disabled', reason, test }: decided by Rust from its configuration
          status: updaterInfo,
          check: () => updaterCall('updater.check', { timeoutMs: 60 * 1000 }),
          download: (progress) => updaterCall('updater.download', { progress, timeoutMs: 2 * 60 * 1000 }),
          install: () => updaterCall('updater.install', { timeoutMs: 5 * 60 * 1000 }),
        },
      }),
    },

    // the dev debug routes (sidecar/debug.js): a request to Rust as it is
    debugRequest: (method, params) => rpc.request(method, params),
    overlayNow: () => overlay,
  };
}

module.exports = { createSidecarPlatform, sealWith, openWith };
