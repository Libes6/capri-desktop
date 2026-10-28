'use strict';

// A stand-in platform (platform/index.js) for the tests, and for loading the core in plain `node`:
// nothing real is touched. Every call is written down in `calls` ({ name: 'shell.openPath', args }),
// what a test may want to change is in `state`, and `power` and `screens` are event emitters a test
// feeds. `overrides` replaces whole sections (or methods) when a test needs another answer.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSettingsWindow } = require('../settings-window');

function createFakePlatform({ userData, overrides = {}, display } = {}) {
  const calls = [];
  const note = (name, args) => calls.push({ name, args });
  const dir = userData || fs.mkdtempSync(path.join(os.tmpdir(), 'capri-fake-'));
  const state = {
    userData: dir,
    paths: {}, // name -> path, over the defaults below
    packaged: false,
    version: '0.0.0-test',
    runtime: 'fake',
    languages: { preferred: ['en-US'], fallback: ['en-US', 'en-US'] },
    autostart: false,
    secrets: true,
    cursor: { x: 0, y: 0 },
    protocols: new Set(), // links an app is registered for
    capture: null, // a Buffer the next screen capture gives (null: no picture)
    folder: null, // what the folder picker returns
    singleInstance: true,
    updater: null, // what updater.get() gives
  };
  const primary = display || { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 760 }, size: { width: 1280, height: 800 } };
  state.displays = [primary];

  const power = new EventEmitter();
  const screens = new EventEmitter();
  const handlers = { on: new Map(), handle: new Map() };
  const quitHandlers = [];
  let ready = null;
  const sent = []; // what the overlay was sent: { channel, payload }
  const overlays = [];
  let settingsCtl = null;

  const fake = {
    id: 'fake',
    calls,
    state,
    sent,
    overlays,
    handlers,
    power,
    screens,
    lastTrayMenu: null,
    quitHandlers,

    paths: {
      get: (name) => {
        note('paths.get', [name]);
        if (state.paths[name]) return state.paths[name];
        if (name === 'userData') return state.userData;
        if (name === 'appPath' || name === 'resources') return path.join(dir, name);
        return path.join(dir, 'paths', name);
      },
      setUserData: (d) => { note('paths.setUserData', [d]); state.userData = d; },
    },

    app: {
      name: () => 'Capri',
      version: () => state.version,
      runtimeVersion: () => state.runtime,
      isPackaged: () => state.packaged,
      languages: () => state.languages,
      whenReady: () => (ready ||= Promise.resolve()),
      onQuit: (fn) => { quitHandlers.push(fn); },
      singleInstance: (onSecond) => { note('app.singleInstance', [onSecond]); return state.singleInstance; },
      stayAlive: () => note('app.stayAlive', []),
      relaunch: () => note('app.relaunch', []),
      quit: () => note('app.quit', []),
      exit: (code) => note('app.exit', [code]),
      focus: () => note('app.focus', []),
      hideFromDock: () => note('app.hideFromDock', []),
      setAppId: (id) => note('app.setAppId', [id]),
      installAppMenu: () => note('app.installAppMenu', []),
      appForProtocol: (url) => state.protocols.has(url),
      userSoundUrl: (file) => `capri://usersounds/${encodeURIComponent(file)}`,
      setRenderMode: (mode) => note('app.setRenderMode', [mode]),
      gpuStatus: () => ({}),
      serveAssets: (opts) => note('app.serveAssets', [opts]),
    },

    autostart: {
      isEnabled: () => state.autostart,
      set: (on) => { note('autostart.set', [on]); state.autostart = on; },
    },

    screens: Object.assign(screens, {
      all: () => state.displays,
      primary: () => state.displays[0],
      nearest: () => state.displays[0],
      cursor: () => state.cursor,
      toDip: (rect) => rect,
    }),

    power: Object.assign(power, { getSystemIdleState: () => 'active' }),

    // "encrypted" by reversing the text: enough to tell sealed from not
    secrets: {
      isAvailable: () => state.secrets,
      encrypt: (text) => Buffer.from([...text].reverse().join('')),
      decrypt: (buffer) => [...buffer.toString()].reverse().join(''),
    },

    shell: {
      openExternal: async (url) => { note('shell.openExternal', [url]); },
      openPath: async (file) => { note('shell.openPath', [file]); return ''; },
      showItemInFolder: (file) => note('shell.showItemInFolder', [file]),
    },

    shortcuts: {
      register: (accelerator, fn) => { note('shortcuts.register', [accelerator, fn]); return true; },
      unregisterAll: () => note('shortcuts.unregisterAll', []),
    },

    capture: {
      screen: async (d, opts) => { note('capture.screen', [d, opts]); return state.capture; },
    },

    clipboard: {
      writeImage: async (png) => note('clipboard.writeImage', [png]),
    },

    dialogs: {
      pickFolder: async (defaultPath) => { note('dialogs.pickFolder', [defaultPath]); return state.folder; },
    },

    tray: {
      create: ({ onClick }) => {
        note('tray.create', []);
        return {
          onClick,
          setMenu: (template) => { fake.lastTrayMenu = template; note('tray.setMenu', [template]); },
          popup: (where) => note('tray.popup', [where]),
          bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
        };
      },
    },

    windows: {
      createOverlay: ({ area, onReady = () => {} }) => {
        let bounds = { ...area };
        const overlay = {
          closed: false,
          bounds: () => bounds,
          setBounds: (rect) => { bounds = { ...rect }; },
          send: (channel, payload) => { sent.push({ channel, payload }); },
          clickThrough: (on) => note('overlay.clickThrough', [on]),
          keepOnTop: () => note('overlay.keepOnTop', []),
          raise: () => note('overlay.raise', []),
          setFocusable: (on) => note('overlay.setFocusable', [on]),
          focus: () => note('overlay.focus', []),
          blur: () => note('overlay.blur', []),
          isAlive: () => !overlay.closed,
          page: { id: 'overlay-page' }, // what a message from her page is sent as (a test passes it as the sender)
          owns: (sender) => !overlay.closed && sender === overlay.page,
          nativeHandle: () => Buffer.alloc(8),
          mediaSourceId: () => 'window:1:0',
          capture: async () => null,
        };
        overlays.push(overlay);
        note('windows.createOverlay', [area]);
        onReady();
        return overlay;
      },
      createSettings: ({ view, area }) => {
        note('windows.createSettings', []);
        // the real controller over a stand-in BrowserWindow that never opens
        class Window {
          constructor() { this.destroyed = false; this.webContents = { send: (c, d) => sent.push({ channel: c, payload: d, to: 'settings' }), setWindowOpenHandler() {}, on() {}, isDestroyed: () => false }; }
          isDestroyed() { return this.destroyed; }
          isMinimized() { return false; }
          restore() {} show() {} focus() {} setTitle() {} removeMenu() {} loadURL() {} close() { this.destroyed = true; this.closed?.(); }
          once(event, fn) { if (event === 'ready-to-show') fn(); }
          on(event, fn) { if (event === 'closed') this.closed = fn; }
        }
        settingsCtl = createSettingsWindow({ BrowserWindow: Window, preload: '', url: 'about:blank', view, area });
        return settingsCtl;
      },
      createDemoTerminal: (opts) => {
        note('windows.createDemoTerminal', [opts]);
        return { destroy: () => note('demoTerminal.destroy', []) };
      },
    },

    ipc: {
      on: (channel, fn) => handlers.on.set(channel, fn),
      handle: (channel, fn) => handlers.handle.set(channel, fn),
    },

    updater: {
      get: () => {
        note('updater.get', []);
        if (!state.updater) throw new Error('no updater in the fake platform');
        return state.updater;
      },
    },

    native: null,
  };

  for (const [section, value] of Object.entries(overrides)) {
    fake[section] = typeof value === 'object' && value && typeof fake[section] === 'object' ? Object.assign(fake[section], value) : value;
  }
  return fake;
}

module.exports = { createFakePlatform };
