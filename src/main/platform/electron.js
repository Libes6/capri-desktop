'use strict';

// The Electron platform (platform/index.js): the calls main.js and its modules used to make to
// Electron, wrapped as they were. This is the only file of the core's side that touches Electron's
// API (tests/core-portable.test.js); the behaviour of the Electron build is what it always was.
//   electron: the Electron module (tests pass a stand-in; it is `require('electron')` otherwise)
//   root: the project folder (the app's files: capri://app/..., assets, preload scripts)
//   dev / smoke: --dev and --smoke-test

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSettingsWindow } = require('../settings-window');

function createElectronPlatform({ electron = require('electron'), root, dev = false, smoke = false } = {}) {
  const {
    app, BrowserWindow, Tray, Menu, ipcMain, screen, protocol, net, shell, globalShortcut, nativeImage,
    clipboard, ClipboardItem, dialog, powerMonitor, desktopCapturer, safeStorage,
  } = electron;

  protocol.registerSchemesAsPrivileged([
    { scheme: 'capri', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
  // A consistent X11 backend is needed for global cursor coordinates and transparent overlays.
  if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');
  if (smoke && process.platform === 'linux') app.commandLine.appendSwitch('use-angle', 'swiftshader');

  let overlayWin = null; // the BrowserWindow behind the overlay handle
  let settingsCtl = null; // settings-window.js's controller
  let trayMenu = null; // the Menu last set on the tray (also what she opens when you right-click her)

  // Run from a clone (`npm start`), electron.exe alone would open the default Electron app at login:
  // it needs the project folder as argument.
  const loginItemOptions = () => (app.isPackaged ? {} : { path: process.execPath, args: [root] });

  // The pointer reaches her click-through window through the mouse hook; Linux has no `forward`.
  const forward = () => (process.platform === 'linux' ? undefined : { forward: true });

  function overlayHandle(win) {
    return {
      bounds: () => win.getBounds(),
      setBounds: (rect) => win.setBounds(rect),
      send: (channel, payload) => win.webContents.send(channel, payload),
      // on: clicks go through her window (the pointer is still passed on where the system allows)
      clickThrough: (on) => win.setIgnoreMouseEvents(on, forward()),
      keepOnTop: () => win.setAlwaysOnTop(true, 'screen-saver'),
      raise: () => {
        win.setAlwaysOnTop(true, 'screen-saver');
        win.moveTop();
      },
      setFocusable: (on) => win.setFocusable(on),
      focus: () => win.focus(),
      blur: () => win.blur(),
      isAlive: () => !win.isDestroyed(),
      nativeHandle: () => win.getNativeWindowHandle(),
      mediaSourceId: () => win.getMediaSourceId(),
      // a picture of that part of the window (all of it without a rect), PNG; null when it is empty
      capture: async (rect) => {
        const image = await win.webContents.capturePage(rect);
        return image.isEmpty() ? null : image.toPNG();
      },
    };
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
          { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: (_item, win) => win && win !== overlayWin && win.minimize() },
          { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: (_item, win) => win && win !== overlayWin && win.close() },
        ],
      },
      ...(dev ? [{ label: 'Dev', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }] : []),
    ]);
  }

  return {
    id: 'electron',

    paths: {
      // userData home desktop documents downloads pictures music videos temp exe (Electron's names),
      // appPath (the app's folder or archive), resources (where the installed app keeps its extras)
      get: (name) => {
        if (name === 'appPath') return app.getAppPath();
        if (name === 'resources') return process.resourcesPath;
        return app.getPath(name);
      },
      setUserData: (dir) => app.setPath('userData', dir),
    },

    app: {
      name: () => app.name,
      version: () => app.getVersion(),
      runtimeVersion: () => process.versions.electron,
      isPackaged: () => app.isPackaged,
      // 'auto' -> the first system language Capri speaks (lang.js)
      languages: () => ({ preferred: app.getPreferredSystemLanguages(), fallback: [app.getSystemLocale(), app.getLocale()] }),
      whenReady: () => app.whenReady(),
      onQuit: (fn) => app.on('will-quit', fn),
      // false: another Capri is running (it is told with onSecond, this one should quit)
      singleInstance: (onSecond) => {
        if (!app.requestSingleInstanceLock()) return false;
        app.on('second-instance', onSecond);
        return true;
      },
      // she has no window to speak of: closing the last one does not end her
      stayAlive: () => app.on('window-all-closed', () => {}),
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
      exit: (code) => app.exit(code),
      // no Dock icon on macOS: the app has to come forward for its window to get the keyboard
      focus: () => process.platform === 'darwin' && app.focus({ steal: true }),
      hideFromDock: () => process.platform === 'darwin' && app.dock?.hide(),
      setAppId: (id) => process.platform === 'win32' && app.setAppUserModelId(id),
      installAppMenu: () => {
        if (process.platform === 'darwin') Menu.setApplicationMenu(appMenu());
        else if (!dev) Menu.setApplicationMenu(null);
      },
      // whether something is registered to open that kind of link (roblox://…)
      appForProtocol: (url) => Boolean(app.getApplicationNameForProtocol(url)),
      // how her window is drawn, set before Electron starts: 'auto', 'gl' or 'software'
      setRenderMode: (render) => {
        if (render === 'gl') app.commandLine.appendSwitch('use-angle', 'gl');
        if (render === 'software') {
          app.disableHardwareAcceleration();
          app.commandLine.appendSwitch('enable-unsafe-swiftshader'); // her drawing still needs WebGL, done on the CPU
        }
      },
      gpuStatus: () => app.getGPUFeatureStatus(),
      // capri://app/...        -> files of this repo
      // capri://usersounds/... -> the user's own sound overrides
      serveAssets: ({ userSoundsDir }) => {
        protocol.handle('capri', (request) => {
          const url = new URL(request.url);
          const base = url.host === 'usersounds' ? userSoundsDir() : root;
          const target = path.resolve(base, '.' + decodeURIComponent(url.pathname));
          if (target !== base && !target.startsWith(base + path.sep)) {
            return new Response('forbidden', { status: 403 });
          }
          return net.fetch(pathToFileURL(target).toString());
        });
      },
    },

    autostart: {
      isEnabled: () => app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      set: (on) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: on }),
    },

    screens: {
      all: () => screen.getAllDisplays(),
      primary: () => screen.getPrimaryDisplay(),
      nearest: (point) => screen.getDisplayNearestPoint(point),
      cursor: () => screen.getCursorScreenPoint(),
      // a physical-pixel rect (Windows) -> the DIPs of the overlay's coordinates
      toDip: (rect) => screen.screenToDipRect(null, rect),
      on: (event, fn) => screen.on(event, fn),
      removeListener: (event, fn) => screen.removeListener(event, fn),
    },

    // Electron's powerMonitor events: suspend resume lock-screen unlock-screen … (docs/POWER_EVENTS.md)
    power: {
      on: (event, fn) => powerMonitor.on(event, fn),
      removeListener: (event, fn) => powerMonitor.removeListener(event, fn),
      getSystemIdleState: (seconds) => powerMonitor.getSystemIdleState(seconds),
    },

    // API keys, kept encrypted with your account
    secrets: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buffer) => safeStorage.decryptString(buffer),
    },

    shell: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (file) => shell.openPath(file),
      showItemInFolder: (file) => shell.showItemInFolder(file),
    },

    shortcuts: {
      register: (accelerator, fn) => globalShortcut.register(accelerator, fn),
      unregisterAll: () => globalShortcut.unregisterAll(),
    },

    capture: {
      // a picture of that display at that size ('png', or 'jpeg' at `quality`); null when there is none
      screen: async (display, { width, height, format = 'png', quality = 72 }) => {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
        const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
        if (!src || src.thumbnail.isEmpty()) return null;
        return format === 'jpeg' ? src.thumbnail.toJPEG(quality) : src.thumbnail.toPNG();
      },
    },

    clipboard: {
      writeImage: async (png) => {
        const blob = new Blob([png], { type: 'image/png' });
        await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      },
    },

    dialogs: {
      pickFolder: async (defaultPath) => {
        const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath });
        return canceled || !filePaths[0] ? null : filePaths[0];
      },
    },

    tray: {
      create: ({ onClick }) => {
        const icon = nativeImage.createFromPath(path.join(root, 'assets', 'icons', 'tray.png'));
        const tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 22, height: 22 }) : icon);
        tray.setToolTip('Capri');
        tray.on('click', onClick);
        return {
          setMenu: (template) => {
            trayMenu = Menu.buildFromTemplate(template);
            tray.setContextMenu(trayMenu);
          },
          // the same menu as the tray icon's, over her overlay or her settings window
          popup: (where) => trayMenu?.popup({ window: where === 'settings' ? settingsCtl?.window() : overlayWin }),
          bounds: () => tray.getBounds(),
        };
      },
    },

    windows: {
      createOverlay: ({ area, onReady = () => {} }) => {
        const win = new BrowserWindow({
          ...area,
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
            preload: path.join(root, 'src', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required',
          },
        });
        overlayWin = win;
        win.setAlwaysOnTop(true, 'screen-saver');
        if (process.platform === 'darwin') {
          win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        win.setIgnoreMouseEvents(true, forward());
        win.loadURL('capri://app/src/renderer/index.html');
        // always shown: put away, she's still there as her biochip in the corner. Sized again first:
        // Windows keeps a new window inside the work area, and resting on the taskbar it covers it too.
        win.once('ready-to-show', () => {
          onReady();
          win.showInactive();
        });
        win.webContents.on('render-process-gone', (_e, details) => {
          console.error('[capri] renderer gone:', details.reason);
          if (smoke) app.exit(1);
        });
        if (dev || smoke) {
          win.webContents.on('console-message', (e) => {
            const { level, message, lineNumber, sourceId } = e;
            console.log(`[renderer:${level}] ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
          });
          if (dev && process.env.CAPRI_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
        }
        return overlayHandle(win);
      },

      // view(): what the window shows, area(): the work area to center it in (settings-window.js)
      createSettings: ({ view, area }) => {
        settingsCtl = createSettingsWindow({
          BrowserWindow,
          preload: path.join(root, 'src', 'settings-preload.js'),
          url: 'capri://app/src/renderer/settings.html',
          view,
          area,
          focusApp: () => process.platform === 'darwin' && app.focus({ steal: true }),
        });
        return settingsCtl;
      },

      // a little fake terminal for her to sit on, opened without stealing focus; destroy() closes it
      createDemoTerminal: ({ x, y, width, height, title, background, alwaysOnTop, html, onClosed = () => {} }) => {
        const win = new BrowserWindow({
          x, y, width, height, show: false, alwaysOnTop, title, backgroundColor: background, autoHideMenuBar: true,
        });
        win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        win.once('ready-to-show', () => win.showInactive());
        win.on('closed', onClosed);
        return { destroy: () => win.destroy() };
      },
    },

    // the channel's callback gets (the argument, the sender): the sender is only to be handed back to
    // settings.owns(sender)
    ipc: {
      on: (channel, fn) => ipcMain.on(channel, (e, arg) => fn(arg, e.sender)),
      handle: (channel, fn) => ipcMain.handle(channel, (e, arg) => fn(arg, e.sender)),
    },

    updater: {
      get: () => {
        const { autoUpdater, CancellationToken } = require('electron-updater');
        return { autoUpdater, CancellationToken };
      },
    },

    // Electron's own objects, for the Electron shell (--dev routes, the smoke test): never the core
    native: {
      electron,
      overlay: () => overlayWin,
      settings: () => settingsCtl,
    },
  };
}

module.exports = { createElectronPlatform };
