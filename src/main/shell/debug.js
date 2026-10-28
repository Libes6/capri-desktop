'use strict';

// The --dev routes of the bridge (127.0.0.1:CAPRI_PORT/debug/<route>): scripts drive the overlay and
// grab frames of it (no desktop content, just our own windows). Electron's windows are touched
// directly here (platform.native): this is the Electron shell's, not the core's.

const path = require('node:path');
const fs = require('node:fs');
const { PERCH_ON_TOP } = require('../core');

function createDebugHandler({ core, platform, root, dev }) {
  const testWins = new Map(); // name -> test window
  const native = platform.native.electron;
  const settings = () => core.settings();

  return async function debugHandler(route, body) {
    if (!dev) throw new Error('debug routes need --dev');
    const overlay = platform.native.overlay();
    if (route === 'command') {
      core.command(body.name, body);
      return { ok: true };
    }
    if (route === 'power') {
      // her pause, without locking anything: { event: 'lock-screen' | 'unlock-screen' | 'suspend' |
      // 'resume' | ... } as if powerMonitor had sent it (to her pause only: the window watcher and
      // the mouse hook don't hear of it), or { away: true | false } held until said otherwise
      if (typeof body.away === 'boolean') core.power()?.test(body.away);
      else if (body.event) core.power()?.emit(String(body.event));
      return { ok: true, value: core.power()?.state() ?? null };
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
        const win = new native.BrowserWindow({
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
      if (body.click) core.menu.click(body.click);
      return { ok: true, value: core.menu.labels() };
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
      if (body.open === true) settings().open();
      if (body.open === false) settings().close();
      if (body.capture && settings().isOpen()) {
        const image = await settings().window().webContents.capturePage();
        const dir = path.join(platform.app.isPackaged() ? platform.paths.get('userData') : root, 'captures');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${String(body.capture).replace(/[^\w-]/g, '')}.png`);
        fs.writeFileSync(file, image.toPNG());
        return { ok: true, file };
      }
      if (Array.isArray(body.size) && settings().isOpen()) settings().window().setSize(...body.size.map(Number)); // [width, height]
      if (body.key && settings().isOpen()) {
        // a key pressed in it ({ key: 'Tab', shift: true }), the real keyboard untouched
        const contents = settings().window().webContents;
        const modifiers = body.shift ? ['shift'] : [];
        contents.sendInputEvent({ type: 'keyDown', keyCode: String(body.key), modifiers });
        contents.sendInputEvent({ type: 'keyUp', keyCode: String(body.key), modifiers });
        return { ok: true };
      }
      if (body.js && settings().isOpen()) return { ok: true, value: await settings().window().webContents.executeJavaScript(String(body.js)) };
      return { ok: true, value: settings().isOpen() };
    }
    if (route === 'capture') {
      const image = await overlay.webContents.capturePage();
      // installed, the app's own folder is read-only: its data folder instead
      const dir = path.join(platform.app.isPackaged() ? platform.paths.get('userData') : root, 'captures');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${(body.name || 'frame').replace(/[^\w-]/g, '')}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { ok: true, file };
    }
    throw new Error('unknown debug route');
  };
}

module.exports = { createDebugHandler };
