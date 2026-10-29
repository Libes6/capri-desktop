'use strict';

// The platform: everything the core of Capri (config, chat, settings, the tray menu's rules…) asks of
// the system it runs on, in narrow methods. The core imports no shell; it is given one of these:
//   platform/sidecar.js   the Tauri one: the same methods, answered by Rust through the sidecar's RPC
//   platform/fake.js      a recording stand-in for the tests, and for the core to run in plain `node`
//
// Sections and their methods (names only: what each one takes and returns is in platform/sidecar.js,
// and in fake.js for what a test can count on):
//   paths      get(name) -> string, setUserData(dir)
//              names: userData home desktop documents downloads pictures music videos temp exe
//              appPath resources
//   app        name() version() runtimeVersion() isPackaged() languages() whenReady() onQuit(fn)
//              singleInstance(onSecond) -> bool, stayAlive() relaunch() quit() exit(code) focus()
//              hideFromDock() setAppId(id) installAppMenu() appForProtocol(url) -> bool
//              setRenderMode(mode) gpuStatus() userSoundUrl(file) -> string
//   autostart  isEnabled() -> bool, set(on)
//   screens    all() primary() nearest(point) cursor() toDip(rect) on(event, fn) removeListener(event, fn)
//   power      on(event, fn) removeListener(event, fn) getSystemIdleState(seconds)
//   secrets    isAvailable() encrypt(text) -> Buffer, decrypt(Buffer) -> text
//   shell      openExternal(url) openPath(path) showItemInFolder(path)
//   shortcuts  register(accelerator, fn) unregisterAll()
//   capture    screen(display, { width, height, format, quality }) -> Buffer | null
//   clipboard  writeImage(png)
//   dialogs    pickFolder(defaultPath) -> path | null
//   tray       create({ onClick }) -> a tray (OVERLAY_API's sibling: TRAY_API)
//   windows    createOverlay({ area, onReady }) -> an overlay (OVERLAY_API)
//              createSettings({ view, area }) -> the settings window (src-tauri/src/settings_window.rs)
//              createDemoTerminal({ ...bounds, title, background, alwaysOnTop, html, onClosed })
//   ipc        on(channel, fn(arg, sender)) handle(channel, fn(arg, sender))
//   updater    get() -> { tauri: { status, check, download(progress), install } } (Rust's updater, for updates.js)

const SHAPE = {
  paths: ['get', 'setUserData'],
  app: [
    'name', 'version', 'runtimeVersion', 'isPackaged', 'languages', 'whenReady', 'onQuit', 'singleInstance', 'stayAlive',
    'relaunch', 'quit', 'exit', 'focus', 'hideFromDock', 'setAppId', 'installAppMenu', 'appForProtocol', 'setRenderMode',
    'gpuStatus', 'userSoundUrl',
  ],
  autostart: ['isEnabled', 'set'],
  screens: ['all', 'primary', 'nearest', 'cursor', 'toDip', 'on', 'removeListener'],
  power: ['on', 'removeListener', 'getSystemIdleState'],
  secrets: ['isAvailable', 'encrypt', 'decrypt'],
  shell: ['openExternal', 'openPath', 'showItemInFolder'],
  shortcuts: ['register', 'unregisterAll'],
  capture: ['screen'],
  clipboard: ['writeImage'],
  dialogs: ['pickFolder'],
  tray: ['create'],
  windows: ['createOverlay', 'createSettings', 'createDemoTerminal'],
  ipc: ['on', 'handle'],
  updater: ['get'],
};

// The window she lives in. bounds are { x, y, width, height } in screen DIPs.
const OVERLAY_API = [
  'bounds', 'setBounds', 'send', 'clickThrough', 'keepOnTop', 'raise', 'setFocusable', 'focus', 'blur',
  'isAlive', 'owns', 'nativeHandle', 'mediaSourceId', 'capture',
];
// Her tray icon. The menu is data (a template of { label, type, checked, enabled, accelerator, click,
// submenu }, tray-menu.js); popup(where) opens the last one set, over 'overlay' or 'settings'.
const TRAY_API = ['setMenu', 'popup', 'bounds'];

/** The methods `platform` lacks, as 'section.method' (empty: it is complete). */
function missing(platform) {
  const lacking = [];
  for (const [section, methods] of Object.entries(SHAPE)) {
    for (const method of methods) {
      if (typeof platform?.[section]?.[method] !== 'function') lacking.push(`${section}.${method}`);
    }
  }
  return lacking;
}

module.exports = { SHAPE, OVERLAY_API, TRAY_API, missing };
