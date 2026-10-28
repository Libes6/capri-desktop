'use strict';
// TAURI-06: the tray menu on the wire, the settings window, shortcuts, autostart and the application
// menu of the sidecar platform, with a fake Rust shell on the other end of the RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPeer } = require('../sidecar/rpc');
const { createSidecarPlatform } = require('../src/main/platform/sidecar');
const { createCore } = require('../src/main/core');
const { serializeMenu, runClick, createClickBook } = require('../src/main/platform/menu-wire');
const { settingsBounds } = require('../src/main/settings-window');

const display = { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1280, height: 832 }, workArea: { x: 0, y: 25, width: 1280, height: 800 }, size: { width: 1280, height: 832 } };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function wire({ rustHandlers = {} } = {}) {
  const seen = [];
  let sidecar;
  const rust = createPeer({
    write: (line) => setImmediate(() => sidecar.feed(line)),
    onRequest: async (method, params) => {
      seen.push({ kind: 'request', method, params });
      return rustHandlers[method] ? rustHandlers[method](params) : null;
    },
    onNotification: (method, params) => seen.push({ kind: 'notification', method, params }),
  });
  const hook = { fn: () => {} };
  sidecar = createPeer({ write: (line) => setImmediate(() => rust.feed(line)), onRequest: async () => null, onNotification: (m, p) => hook.fn(m, p) });
  return { rust, sidecar, seen, hook };
}

async function start({ rustHandlers, hello: extra = {}, coreOpts = {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-ui-'));
  const { rust, sidecar, seen, hook } = wire({
    rustHandlers: { 'overlay.create': ({ area }) => ({ ...area }), 'overlay.setBounds': ({ rect }) => rect, ...rustHandlers },
  });
  const hello = {
    name: 'Capri', version: '9.9.9', packaged: false, tauri: '2',
    paths: { userData, home: os.homedir(), appPath: path.resolve(__dirname, '..'), resources: path.resolve(__dirname, '..'), temp: os.tmpdir(), exe: process.execPath },
    screens: [display], cursor: { x: 10, y: 20 }, ...extra,
  };
  const logs = [];
  const platform = createSidecarPlatform({ rpc: sidecar, hello, root: path.resolve(__dirname, '..'), log: (m) => logs.push(m) });
  hook.fn = platform.onNotification;
  const core = createCore({ platform, smoke: true, port: 0, watchWindows: () => ({ stop() {}, refresh() {} }), ...coreOpts });
  const done = () => fs.rmSync(userData, { recursive: true, force: true });
  return { rust, sidecar, seen, platform, core, logs, done, userData };
}

const sent = (seen, method) => seen.filter((s) => s.method === method).map((s) => s.params);

// ---- menu-wire.js ----------------------------------------------------------------------------

test('menu wire: items keep their data, only clickable ones get an id, callbacks never cross', () => {
  const calls = [];
  const template = [
    { label: 'Online', enabled: false },
    { type: 'separator' },
    { label: 'Hide', accelerator: 'Ctrl+Alt+C', click: () => calls.push('hide') },
    { label: 'Size', submenu: [
      { label: 'Small', type: 'radio', checked: false, click: (i) => calls.push(['small', i.checked]) },
      { label: 'Medium', type: 'radio', checked: true, click: () => {} },
    ] },
    { label: 'Mute', type: 'checkbox', checked: false, click: (i) => calls.push(['mute', i.checked]) },
  ];
  const wire = serializeMenu(template, 4);
  assert.doesNotThrow(() => JSON.stringify(wire.items));
  assert.deepEqual(wire.items[0], { label: 'Online', enabled: false });
  assert.deepEqual(wire.items[1], { type: 'separator' });
  assert.deepEqual(wire.items[2], { label: 'Hide', accelerator: 'Ctrl+Alt+C', id: 't4.0' });
  assert.deepEqual(wire.items[3].submenu.map((i) => i.id), ['t4.1', 't4.2']);
  assert.deepEqual(wire.items[3].submenu[1], { label: 'Medium', type: 'radio', checked: true, id: 't4.2' });
  assert.equal(wire.items[3].id, undefined, 'a submenu is not clicked');
  assert.equal(wire.items[4].id, 't4.3');
  assert.equal(JSON.stringify(wire.items).includes('function'), false);

  // clicks come back as the item after the click
  runClick(wire.clicks, 't4.0', false);
  runClick(wire.clicks, 't4.1', false); // a radio is picked: Rust says true
  runClick(wire.clicks, 't4.1', true);
  runClick(wire.clicks, 't4.3', true);
  runClick(wire.clicks, 't4.3', false);
  assert.deepEqual(calls, ['hide', ['small', false], ['small', true], ['mute', true], ['mute', false]]);
});

test('menu wire: an unknown type is refused, an unknown or throwing click is logged not thrown', () => {
  assert.throws(() => serializeMenu([{ label: 'x', type: 'banana' }], 1), /unknown item type/);
  const logs = [];
  assert.equal(runClick(new Map(), 'nope', false, (m) => logs.push(m)), false);
  const wire = serializeMenu([{ label: 'Boom', click: () => { throw new Error('bang'); } }], 1);
  assert.equal(runClick(wire.clicks, 't1.0', false, (m) => logs.push(m)), true);
  assert.deepEqual(logs.length, 2);
});

test('menu wire: the click book keeps the last menus, so a click on one rebuilt while open still works', () => {
  const calls = [];
  const book = createClickBook(2);
  const mk = (gen) => serializeMenu([{ label: 'A', click: () => calls.push(gen) }], gen);
  book.add(mk(1));
  book.add(mk(2));
  book.add(mk(3));
  book.click('t3.0', false);
  book.click('t2.0', false);
  book.click('t1.0', false, () => {}); // too old: gone
  assert.deepEqual(calls, [3, 2]);
});

// ---- the tray on the platform --------------------------------------------------------------------

test('tray: the core sends its real menu as data on every rebuild, and a click by id runs the core\'s action', async () => {
  const { rust, seen, platform, core, done } = await start();
  try {
    core.start();
    await tick();
    assert.ok(sent(seen, 'tray.create').length >= 1);
    const menus = sent(seen, 'tray.setMenu');
    assert.ok(menus.length >= 1);
    const last = menus.at(-1);
    // the real template: labels, a radio group for the size, a checkbox for mute, items without a click are disabled labels
    const find = (items, label) => items.reduce((hit, i) => hit || (i.label === label ? i : i.submenu && find(i.submenu, label)), null);
    const size = find(last.items, 'Size');
    assert.deepEqual(size.submenu.map((i) => i.type), ['radio', 'radio', 'radio']);
    assert.equal(size.submenu.filter((i) => i.checked).length, 1);
    const mute = find(last.items, 'Mute');
    assert.equal(mute.type, 'checkbox');
    assert.ok(find(last.items, 'Put her away'));
    assert.equal(last.items[0].enabled, false);
    assert.ok(JSON.stringify(last).length < 20000);
    assert.ok(!JSON.stringify(last).includes('function'));

    // a click on "Mute": Rust says the checkbox is now checked; the core saves it
    rust.notify('tray.click', { id: mute.id, checked: true });
    await tick();
    assert.equal(core.config.load().muted, true);
    // the rebuild after it sends a new menu, whose Mute is checked
    const after = sent(seen, 'tray.setMenu').at(-1);
    assert.equal(find(after.items, 'Mute').checked, true);
    assert.ok(after.generation > last.generation);
    // a radio: Large
    const large = find(after.items, 'Large');
    rust.notify('tray.click', { id: large.id, checked: true });
    await tick();
    assert.equal(core.config.load().scale, 0.8);
    // a click on the old menu's item (it was open while the menu was rebuilt) still works
    rust.notify('tray.click', { id: find(last.items, 'Small').id, checked: true });
    await tick();
    assert.equal(core.config.load().scale, 0.45);
    core.stop();
  } finally {
    done();
  }
});

test('tray: a left click on the icon is the core\'s status command; bounds come from Rust', async () => {
  const { rust, seen, platform, core, done } = await start();
  try {
    core.start();
    await tick();
    rust.notify('tray.bounds', { x: 1100, y: 0, width: 24, height: 24 });
    rust.notify('tray.iconClick', {});
    await tick();
    assert.ok(seen.some((s) => s.method === 'emit' && s.params.event === 'capri:command' && s.params.payload.name === 'status'));
    // guide:tray reads the bounds
    const guide = await core.dispatch.handle('trayPlace', [], { label: 'overlay' });
    assert.equal(guide.icon.w, 24);
    core.stop();
  } finally {
    done();
  }
});

test('tray: right click on her (menu:open) asks for the menu over the overlay; the settings window\'s over the settings', async () => {
  const { seen, core, done } = await start();
  try {
    core.start();
    await tick();
    core.ipc.on['menu:open'](undefined, { label: 'overlay' });
    await core.dispatch.handle('openMenu', [], { label: 'overlay' });
    await tick();
    assert.deepEqual(sent(seen, 'tray.popup').at(-1), { window: 'overlay' });
    core.settings().open();
    core.dispatch.handle('openMenu', [], { label: 'settings' });
    await tick();
    assert.deepEqual(sent(seen, 'tray.popup').at(-1), { window: 'settings' });
    core.stop();
  } finally {
    done();
  }
});

// ---- the settings window -------------------------------------------------------------------------

test('settings window: one at a time, opened by Rust, centered in the work area, owned by label', async () => {
  const { rust, seen, core, done } = await start();
  try {
    core.start();
    await tick();
    assert.equal(sent(seen, 'settings.reset').length, 1, 'a window left by an earlier core is closed');
    const s = core.settings();
    assert.equal(s.isOpen(), false);
    assert.equal(s.owns({ label: 'settings' }), false, 'nothing is owned before it is open');
    s.open();
    s.open('about');
    await tick();
    const opens = sent(seen, 'settings.open');
    assert.equal(opens.length, 2, 'asking again goes to the same Rust window (it brings it forward)');
    assert.deepEqual(opens[0].bounds, { x: 280, y: 25 + 130, width: 720, height: 540 });
    assert.equal(opens[0].section, null);
    assert.equal(opens[1].section, 'about');
    assert.match(opens[0].title, /Capri/);
    assert.equal(s.isOpen(), true);
    assert.equal(s.owns({ label: 'settings' }), true);
    assert.equal(s.owns({ label: 'overlay' }), false);
    assert.equal(s.owns(undefined), false);

    // a command of the settings window is let in by the dispatcher, the overlay's is not
    const view = await core.dispatch.handle('view', [], { label: 'settings' });
    assert.equal(typeof view.title, 'string');
    assert.throws(() => core.dispatch.handle('view', [], { label: 'overlay' }), (e) => e.code === 'forbidden');

    // a change from the window: saved, and the window is told the view again (and the title)
    const before = sent(seen, 'emit').filter((p) => p.event === 'settings:view').length;
    await core.dispatch.handle('set', [{ volume: 0.4 }], { label: 'settings' });
    await tick();
    assert.equal(core.config.load().volume, 0.4);
    assert.ok(sent(seen, 'emit').filter((p) => p.event === 'settings:view' && p.window === 'settings').length > before);
    assert.ok(sent(seen, 'settings.title').length >= 1);
    // the overlay hears of it too
    assert.ok(sent(seen, 'emit').some((p) => p.window === 'overlay' && p.event === 'capri:config' && p.payload.volume === 0.4));

    // close from the page (Escape / the button): Rust closes, then says it is gone
    await core.dispatch.handle('close', [], { label: 'settings' });
    await tick();
    assert.equal(sent(seen, 'settings.close').length, 1);
    rust.notify('settings.closed', {});
    await tick();
    assert.equal(s.isOpen(), false);
    assert.equal(s.owns({ label: 'settings' }), false);
    assert.equal(s.window(), null);
    // not open: nothing is sent to it
    const n = seen.length;
    s.update();
    s.send('updates:status', {});
    await tick();
    assert.equal(seen.length, n);
    // and it opens again
    s.open();
    await tick();
    assert.equal(sent(seen, 'settings.open').length, 3);
    core.stop();
  } finally {
    done();
  }
});

test('settings window: the bounds are the Electron window\'s (720x540, centered, never bigger than the work area)', () => {
  assert.deepEqual(settingsBounds(null), { width: 720, height: 540 });
  assert.deepEqual(settingsBounds({ x: 0, y: 0, width: 1000, height: 700 }), { x: 140, y: 80, width: 720, height: 540 });
  assert.deepEqual(settingsBounds({ x: 10, y: 20, width: 600, height: 400 }), { x: 10, y: 20, width: 600, height: 400 });
});

test('settings window: the capability of the window is the bridge and nothing else, for its label only', () => {
  const caps = require('../src-tauri/capabilities/settings.json');
  assert.deepEqual(caps.windows, ['settings']);
  assert.deepEqual([...caps.permissions].sort(), ['allow-host-invoke', 'core:event:allow-listen', 'core:event:allow-unlisten']);
  const overlay = require('../src-tauri/capabilities/overlay.json');
  assert.deepEqual(overlay.windows, ['overlay']);
});

// ---- shortcuts, autostart, the application menu --------------------------------------------------

test('shortcuts: the core registers hide/show by its accelerator; a press from Rust runs it; unregisterAll clears', async () => {
  const registered = [];
  const { rust, seen, core, done } = await start({ rustHandlers: { 'shortcuts.register': (p) => { registered.push(p); return { ok: true }; } } });
  try {
    core.start();
    await tick();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].accelerator, 'Control+Alt+C');
    const visible = core.config.load().visible;
    rust.notify('shortcut', { id: registered[0].id });
    await tick();
    assert.equal(core.config.load().visible, !visible, 'hide / show');
    rust.notify('shortcut', { id: 'nobody' }); // an id nobody holds: nothing happens
    core.stop(); // unregisterAll
    await tick();
    assert.equal(sent(seen, 'shortcuts.unregisterAll').length, 1);
    rust.notify('shortcut', { id: registered[0].id });
    await tick();
    assert.equal(core.config.load().visible, !visible, 'after unregisterAll a press does nothing');
  } finally {
    done();
  }
});

test('shortcuts: one the system refuses is logged and forgotten, not thrown', async () => {
  const { platform, logs, done } = await start({ rustHandlers: { 'shortcuts.register': () => ({ ok: false, error: 'taken' }) } });
  try {
    assert.equal(platform.shortcuts.register('Control+Alt+C', () => {}), true);
    await tick();
    assert.ok(logs.some((l) => /Control\+Alt\+C not registered: taken/.test(l)));
  } finally {
    done();
  }
});

test('autostart: the state is Rust\'s from hello, set goes to Rust, a refusal puts the old state back', async () => {
  const sets = [];
  const { platform, done } = await start({
    hello: { autostart: true },
    rustHandlers: { 'autostart.set': (p) => { sets.push(p); if (sets.length === 2) throw new Error('no permission'); return { on: p.on }; } },
  });
  try {
    assert.equal(platform.autostart.isEnabled(), true);
    platform.autostart.set(false);
    assert.equal(platform.autostart.isEnabled(), false, 'at once, the menu is rebuilt from it');
    await tick();
    platform.autostart.set(true); // refused by the system
    assert.equal(platform.autostart.isEnabled(), true);
    await tick();
    assert.equal(platform.autostart.isEnabled(), false);
    assert.deepEqual(sets, [{ on: false }, { on: true }]);
  } finally {
    done();
  }
});

test('application menu: asked of Rust once at start', async () => {
  const { seen, platform, done } = await start();
  try {
    platform.app.installAppMenu();
    await tick();
    assert.equal(sent(seen, 'app.installMenu').length, 1);
  } finally {
    done();
  }
});
