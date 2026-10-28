'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const x11 = require('../src/main/linux/x11');
const { startX11Watch, GIVE_UP } = require('../src/main/linux/x11-watch');
const { createFakePlatform } = require('../src/main/platform/fake');

// Electron's screens as the old stand-in had them: none, and a rect is its own DIP rect
const platform = createFakePlatform({ overrides: { screens: { all: () => [], toDip: (r) => r } } });

// Output as xprop/xwininfo (x11-utils 7.7) print it, on a reparenting EWMH window manager
// (written from the tools' formats, not captured on a live desktop: see docs/LINUX_WINDOW_TRACKING.md).
const ROOT = `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007
_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1a00003, 0x1e00004, 0x2c00001, 0x2400006, 0x3a00007, 0x4400002
_NET_CURRENT_DESKTOP(CARDINAL) = 1
`;
const TREE = `
xwininfo: Window id: 0x1e3 (the root window) (has no name)

  Root window id: 0x1e3 (the root window) (has no name)
  Parent window id: 0x0 (none)
     9 children:
     0x1a00003 "Desktop": ("desktop_window" "Nautilus")  1920x1080+0+0  +0+0
     0x1c0000a (has no name): ()  1920x1080+0+0  +0+0
        1 child:
        0x1e00004 "dev@box: ~/capri": ("gnome-terminal-server" "Gnome-terminal")  800x600+1+37  +101+87
     0x2c00001 "Top Bar": ("panel" "Panel")  1920x32+0+0  +0+0
     0x1c0000c (has no name): ()  1022x768+300+200  +300+200
        1 child:
        0x2400006 "Hidden: (one) 640x480+5+5  +1+1": ("x" "X")  1000x700+11+57  +311+257
     0x3a00007 "Firefox: x 10x10+0+0": ("Navigator" "firefox")  2000x1200+-40+-30  +-40+-30
     0x4400002 "Capri": ("capri-desktop" "capri-desktop")  1920x1048+0+32  +0+32
     0x5000001 "tooltip": ()  120x30+50+50  +50+50
`;
const PROPS = {
  0x1a00003: `_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DESKTOP
_NET_WM_STATE(ATOM) =
_NET_WM_DESKTOP(CARDINAL) = 4294967295
_NET_FRAME_EXTENTS:  not found.
_GTK_FRAME_EXTENTS:  not found.
_NET_WM_PID(CARDINAL) = 900`,
  0x1e00004: `_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_STATE(ATOM) = _NET_WM_STATE_FOCUSED
_NET_WM_DESKTOP(CARDINAL) = 1
_NET_FRAME_EXTENTS(CARDINAL) = 1, 1, 37, 1
_GTK_FRAME_EXTENTS:  not found.
_NET_WM_PID(CARDINAL) = 1200`,
  0x2c00001: `_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK
_NET_WM_STATE(ATOM) = _NET_WM_STATE_STICKY, _NET_WM_STATE_SKIP_TASKBAR
_NET_WM_DESKTOP(CARDINAL) = 4294967295
_NET_FRAME_EXTENTS:  not found.
_GTK_FRAME_EXTENTS:  not found.
_NET_WM_PID(CARDINAL) = 950`,
  0x2400006: `_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN
_NET_WM_DESKTOP(CARDINAL) = 1
_NET_FRAME_EXTENTS(CARDINAL) = 11, 11, 57, 11
_GTK_FRAME_EXTENTS:  not found.
_NET_WM_PID(CARDINAL) = 1300`,
  // a GTK window drawing its own decorations and shadow (CSD), maximized
  0x3a00007: `_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_FOCUSED
_NET_WM_DESKTOP(CARDINAL) = 1
_NET_FRAME_EXTENTS(CARDINAL) = 0, 0, 0, 0
_GTK_FRAME_EXTENTS(CARDINAL) = 40, 40, 30, 90
_NET_WM_PID(CARDINAL) = 1400`,
  // Capri's own overlay
  0x4400002: `_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE, _NET_WM_STATE_SKIP_TASKBAR
_NET_WM_DESKTOP(CARDINAL) = 1
_NET_FRAME_EXTENTS(CARDINAL) = 0, 0, 0, 0
_GTK_FRAME_EXTENTS:  not found.
_NET_WM_PID(CARDINAL) = 4242`,
};

const parsedInfos = () => new Map(Object.entries(PROPS).map(([id, text]) => [Number(id), x11.parseWindow(text)]));

test('xprop: window ids, cardinals, atoms, empty and missing values, -notype too', () => {
  const p = x11.parseXprop(`${ROOT}_NET_WM_STATE(ATOM) =\n_GTK_FRAME_EXTENTS:  not found.\n`);
  assert.deepEqual(p._NET_ACTIVE_WINDOW, ['0x3a00007']);
  assert.equal(p._NET_CLIENT_LIST_STACKING.length, 6);
  assert.deepEqual(p._NET_CURRENT_DESKTOP, ['1']);
  assert.deepEqual(p._NET_WM_STATE, []);
  assert.equal(p._GTK_FRAME_EXTENTS, null);
  const notype = x11.parseXprop('_NET_ACTIVE_WINDOW: window id # 0x0\n_NET_FRAME_EXTENTS = 2, 2, 30, 2\n');
  assert.deepEqual(notype._NET_FRAME_EXTENTS, ['2', '2', '30', '2']);
  assert.equal(x11.xid(notype._NET_ACTIVE_WINDOW[0]), null); // no window in front
  assert.equal(x11.xid('0x3a00007'), 0x3a00007);
  assert.equal(x11.xid('nope'), null);
});

test('root: front window, stacking front first, workspace; no EWMH window manager is null', () => {
  const root = x11.parseRoot(ROOT);
  assert.equal(root.active, 0x3a00007);
  assert.deepEqual(root.stacking, [0x4400002, 0x3a00007, 0x2400006, 0x2c00001, 0x1e00004, 0x1a00003]);
  assert.equal(root.desktop, 1);
  assert.equal(x11.parseRoot('_NET_ACTIVE_WINDOW:  not found.\n_NET_CLIENT_LIST_STACKING:  not found.\n'), null);
  assert.equal(x11.parseRoot(''), null);
  // an empty desktop: a list with nothing in it
  assert.deepEqual(x11.parseRoot('_NET_CLIENT_LIST_STACKING(WINDOW): window id #\n').stacking, []);
});

test('window properties: type, state, workspace, frames, pid', () => {
  const w = x11.parseWindow(PROPS[0x3a00007]);
  assert.deepEqual(w.types, ['NORMAL']);
  assert.deepEqual(w.state, ['MAXIMIZED_VERT', 'MAXIMIZED_HORZ', 'FOCUSED']);
  assert.equal(w.desktop, 1);
  assert.deepEqual(w.frame, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.deepEqual(w.csd, { left: 40, right: 40, top: 30, bottom: 90 });
  assert.equal(w.pid, 1400);
  const bare = x11.parseWindow('_NET_WM_WINDOW_TYPE:  not found.\n');
  assert.deepEqual(bare, { types: [], state: [], desktop: null, frame: null, csd: null, pid: null });
});

test('xwininfo tree: absolute geometry of nested windows, odd names, negative positions', () => {
  const rects = x11.parseTree(TREE);
  assert.deepEqual(rects.get(0x1e00004), { x: 101, y: 87, w: 800, h: 600 });
  assert.deepEqual(rects.get(0x2400006), { x: 311, y: 257, w: 1000, h: 700 }); // name with "x+y" in it
  assert.deepEqual(rects.get(0x3a00007), { x: -40, y: -30, w: 2000, h: 1200 });
  assert.equal(rects.has(0x1e3), false); // the header lines
  assert.equal(rects.size, 9);
});

test('snapshot: front first, frames added, CSD shadow removed, no desktop/dock/hidden/own/small', () => {
  const snap = x11.buildSnapshot({
    root: x11.parseRoot(ROOT), infos: parsedInfos(), rects: x11.parseTree(TREE), self: { id: 0x4400002, pid: 4242 },
  });
  assert.equal(snap.fg, 0x3a00007);
  assert.equal(snap.taskbar, false);
  assert.deepEqual(snap.wins, [
    { id: 0x3a00007, x: 0, y: 0, w: 1920, h: 1080, max: true },     // CSD: 2000x1200 minus its shadow
    { id: 0x1e00004, x: 100, y: 50, w: 802, h: 638, max: false },  // with the title bar she sits on
  ]);
  // the format the overlay already gets from Windows
  assert.deepEqual(Object.keys(snap).sort(), ['ai', 'fg', 'game', 'plug', 'taskbar', 'usb', 'wins']);
});

test('snapshot: other workspaces, sticky windows, minimized ones, own pid, panel in front', () => {
  const infos = parsedInfos();
  const rects = x11.parseTree(TREE);
  // workspace 2 shown: the terminal and the browser are on 1
  const other = x11.buildSnapshot({ root: { ...x11.parseRoot(ROOT), desktop: 2 }, infos, rects });
  assert.deepEqual(other.wins.map((w) => w.id), []);
  // the terminal pinned to every workspace
  infos.set(0x1e00004, { ...infos.get(0x1e00004), desktop: x11.ALL_DESKTOPS });
  const sticky = x11.buildSnapshot({ root: { ...x11.parseRoot(ROOT), desktop: 2 }, infos, rects });
  assert.deepEqual(sticky.wins.map((w) => w.id), [0x1e00004]);
  // the overlay left out by its id even listed in the taskbar; when its id is unknown, it skips the taskbar
  const overlayInfo = infos.get(0x4400002);
  infos.set(0x4400002, { ...overlayInfo, state: [] });
  const own = x11.buildSnapshot({ root: x11.parseRoot(ROOT), infos, rects, self: { id: 0x4400002 } });
  assert.equal(own.wins.some((w) => w.id === 0x4400002), false);
  infos.set(0x4400002, overlayInfo);
  assert.equal(x11.buildSnapshot({ root: x11.parseRoot(ROOT), infos, rects, self: { id: null } })
    .wins.some((w) => w.id === 0x4400002), false);
  // the panel clicked: in front, never a seat
  const panel = x11.buildSnapshot({ root: { ...x11.parseRoot(ROOT), active: 0x2c00001 }, infos, rects });
  assert.equal(panel.taskbar, true);
  assert.equal(panel.wins.some((w) => w.id === 0x2c00001), false);
  // nothing known about the window in front (it closed meanwhile)
  assert.equal(x11.buildSnapshot({ root: { ...x11.parseRoot(ROOT), active: 0x7 }, infos, rects }).taskbar, false);
});

test('snapshot: her other windows (the demo terminal, same pid) are seats, as on Windows', () => {
  const infos = parsedInfos();
  const rects = x11.parseTree(TREE);
  // the demo terminal: another window of Capri's process, on top
  infos.set(0x2400006, { ...infos.get(0x2400006), state: ['ABOVE'], pid: 4242 });
  const snap = x11.buildSnapshot({ root: x11.parseRoot(ROOT), infos, rects, self: { id: 0x4400002, pid: 4242 } });
  assert.deepEqual(snap.wins.map((w) => w.id), [0x3a00007, 0x2400006, 0x1e00004]);
});

test('window type: the first standard EWMH type, vendor types before it skipped', () => {
  // Qt frameless windows: _KDE_NET_WM_WINDOW_TYPE_OVERRIDE first, then NORMAL
  const qt = x11.parseWindow('_NET_WM_WINDOW_TYPE(ATOM) = _KDE_NET_WM_WINDOW_TYPE_OVERRIDE, _NET_WM_WINDOW_TYPE_NORMAL\n');
  assert.deepEqual(qt.types, ['NORMAL']);
  assert.equal(x11.isSeat({ ...qt, state: [], desktop: null }, { desktop: 0 }), true);
  const dock = x11.parseWindow('_NET_WM_WINDOW_TYPE(ATOM) = _KDE_NET_WM_WINDOW_TYPE_OVERRIDE, _NET_WM_WINDOW_TYPE_DOCK\n');
  assert.equal(x11.isSeat({ ...dock, state: [], desktop: null }, { desktop: 0 }), false);
  // only a vendor type: no standard type, a normal window (EWMH)
  assert.deepEqual(x11.parseWindow('_NET_WM_WINDOW_TYPE(ATOM) = _KDE_NET_WM_WINDOW_TYPE_OVERRIDE\n').types, []);
});

test('pixels to DIPs: scale factor, second screen, no displays', () => {
  const one = [{ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 2 }];
  assert.deepEqual(x11.pxToDip({ x: 200, y: 100, w: 800, h: 600 }, one), { x: 100, y: 50, width: 400, height: 300 });
  const two = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
  ];
  assert.deepEqual(x11.pxToDip({ x: 2000, y: 40, w: 600, h: 400 }, two), { x: 2000, y: 40, width: 600, height: 400 });
  // the same two screens at 1.5 (X11: one factor for the whole screen)
  const scaled = two.map((d) => ({ bounds: { x: d.bounds.x / 1.5, y: 0, width: d.bounds.width / 1.5, height: d.bounds.height / 1.5 }, scaleFactor: 1.5 }));
  assert.deepEqual(x11.pxToDip({ x: 2100, y: 150, w: 600, h: 300 }, scaled), { x: 1400, y: 100, width: 400, height: 200 });
  assert.deepEqual(x11.pxToDip({ x: 1, y: 2, w: 3, h: 4 }, []), { x: 1, y: 2, width: 3, height: 4 });
});

test('the overlay XID from its native handle', () => {
  const h = Buffer.alloc(8);
  h.writeBigUInt64LE(0x4400002n);
  assert.equal(x11.selfXid(h), 0x4400002);
  const h4 = Buffer.alloc(4);
  h4.writeUInt32LE(0x4400002);
  assert.equal(x11.selfXid(h4), 0x4400002);
  assert.equal(x11.selfXid(Buffer.alloc(0)), null);
});

// ---- the watcher, with the tools faked ----

const quiet = { log() {}, error() {} };
const manual = () => {
  const queue = [];
  return { queue, set: (fn) => { queue.push(fn); return queue.length; }, clear() {} };
};
const fakeTools = (overrides = {}) => async (cmd, args) => {
  if (overrides[cmd]) return overrides[cmd](args);
  if (cmd === 'xwininfo') return TREE;
  if (args[0] === '-root') return ROOT;
  const text = PROPS[parseInt(args[1], 16)];
  if (text == null) throw Object.assign(new Error('BadWindow'), { code: 1 });
  return text;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const session of ['xwayland', 'wayland', null]) {
  test(`watcher: off in a ${session} session, no tool run`, () => {
    const states = [];
    startX11Watch({ session, onSnapshot() {}, onState: (ok) => states.push(ok), log: quiet,
      run: () => { throw new Error('tool run'); } });
    assert.deepEqual(states, [false]);
  });
}

test('watcher: X11 with the tools turns tracking on and speaks only on change', async () => {
  const states = [];
  const snaps = [];
  const timer = manual();
  const watch = startX11Watch({
    session: 'x11', self: { id: 0x4400002, pid: 4242 }, run: fakeTools(), timer, log: quiet,
    onState: (ok) => states.push(ok), onSnapshot: (s) => snaps.push(s),
  });
  await settle();
  assert.deepEqual(states, [true]);
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].wins.map((w) => w.id), [0x3a00007, 0x1e00004]);
  timer.queue.shift()();
  await settle();
  assert.equal(snaps.length, 1); // nothing changed
  watch.stop();
});

test('watcher: no xprop/xwininfo gives up at once', async () => {
  const states = [];
  const timer = manual();
  startX11Watch({
    session: 'x11', timer, log: quiet, onSnapshot() {}, onState: (ok) => states.push(ok),
    run: async (cmd) => { throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', path: cmd }); },
  });
  await settle();
  assert.deepEqual(states, [false]);
  assert.equal(timer.queue.length, 0);
});

test('watcher: a window manager without EWMH gives up after a few tries', async () => {
  const states = [];
  const timer = manual();
  startX11Watch({
    session: 'x11', timer, log: quiet, onSnapshot() {}, onState: (ok) => states.push(ok),
    run: fakeTools({ xprop: async () => '_NET_CLIENT_LIST_STACKING:  not found.\n' }),
  });
  for (let i = 0; i < GIVE_UP; i++) {
    await settle();
    timer.queue.shift()?.();
  }
  await settle();
  assert.deepEqual(states, [false]);
  assert.equal(timer.queue.length, 0);
});

test('watcher: a window closing between the two calls is left out, not fatal', async () => {
  const snaps = [];
  const timer = manual();
  const props = { ...PROPS };
  delete props[0x1e00004];
  const watch = startX11Watch({
    session: 'x11', timer, log: quiet, onState() {}, onSnapshot: (s) => snaps.push(s),
    run: fakeTools({ xprop: async (args) => {
      if (args[0] === '-root') return ROOT;
      const text = props[parseInt(args[1], 16)];
      if (text == null) throw new Error('X Error of failed request:  BadWindow');
      return text;
    } }),
  });
  await settle();
  assert.deepEqual(snaps[0].wins.map((w) => w.id), [0x3a00007]);
  watch.stop();
});

test('watcher: stopped during a poll, nothing more is sent nor scheduled', async () => {
  const snaps = [];
  const states = [];
  const timer = manual();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tools = fakeTools();
  const watch = startX11Watch({
    session: 'x11', timer, log: quiet, onState: (ok) => states.push(ok), onSnapshot: (s) => snaps.push(s),
    run: async (cmd, args) => { await gate; return tools(cmd, args); },
  });
  watch.stop();
  release();
  await settle();
  await settle();
  assert.deepEqual(snaps, []);
  assert.deepEqual(states, []);
  assert.equal(timer.queue.length, 0);
});

test('watcher: failures in a row only count until a poll works again', async () => {
  const states = [];
  const timer = manual();
  let fail = GIVE_UP - 1;
  const tools = fakeTools();
  startX11Watch({
    session: 'x11', timer, log: quiet, onSnapshot() {}, onState: (ok) => states.push(ok),
    run: async (cmd, args) => {
      if (cmd === 'xwininfo' && fail-- > 0) throw new Error('timed out');
      return tools(cmd, args);
    },
  });
  for (let i = 0; i < GIVE_UP; i++) {
    await settle();
    timer.queue.shift()?.();
  }
  fail = GIVE_UP - 1;
  for (let i = 0; i < GIVE_UP - 1; i++) {
    await settle();
    timer.queue.shift()?.();
  }
  await settle();
  assert.deepEqual(states, [true]);
  assert.equal(timer.queue.length, 1);
});

// ---- windows.js: the Linux path goes by the session, the Windows one is unchanged ----

function loadWindows(platform, { spawn, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/main/windows.js');
  const spawned = [];
  const context = {
    module, exports: module.exports, __dirname: path.dirname(filename), console: quiet, Buffer, setTimeout: later, clearTimeout: cancel,
    process: { platform, env: {}, pid: 1 },
    require(id) {
      if (id === 'node:child_process') return { spawn: (...a) => { spawned.push(a); if (spawn) return spawn(...a); throw new Error('spawned'); } };
      return require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { windows: module.exports, spawned };
}

test('windows.js on Linux: XWayland and Wayland never start tracking nor PowerShell', () => {
  const { windows, spawned } = loadWindows('linux');
  const overlay = { nativeHandle: () => Buffer.alloc(8), isAlive: () => true, bounds: () => ({ x: 0, y: 0, width: 10, height: 10 }) };
  for (const session of ['xwayland', 'wayland', null]) {
    const states = [];
    const watch = windows.startWindowWatch({ overlay, session, onUpdate() {}, onState: (ok) => states.push(ok), platform });
    assert.deepEqual(states, [false]);
    watch.refresh();
    watch.stop();
  }
  assert.equal(spawned.length, 0);
});

test('feed: physical pixels to the overlay, only what overlaps her screen', () => {
  const { windows } = loadWindows('win32');
  const got = [];
  const overlay = { isAlive: () => true, bounds: () => ({ x: 100, y: 0, width: 800, height: 600 }) };
  const feed = windows.createFeed({ overlay, onUpdate: (d) => got.push(d), toDip: (w) => ({ x: w.x / 2, y: w.y / 2, width: w.w / 2, height: w.h / 2 }) });
  feed.push({ fg: 5, wins: [{ id: 5, x: 400, y: 200, w: 600, h: 400, max: false }, { id: 6, x: 4000, y: 0, w: 400, h: 400, max: false }] });
  assert.equal(got.length, 1);
  assert.equal(JSON.stringify(got[0].wins), JSON.stringify([{ id: 5, x: 100, y: 100, w: 300, h: 200, max: false }]));
  assert.equal(got[0].taskbar, false);
  feed.send();
  assert.equal(got.length, 2);
});

test('windows.js on Windows: the helper\'s lines to the overlay, restarts, then gives up (unchanged by createFeed)', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const children = [];
  const later = [];
  const { windows, spawned } = loadWindows('win32', {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: 0 });
      child.kill = () => { child.killed++; };
      children.push(child);
      return child;
    },
    setTimeout: (fn) => later.push(fn),
  });
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x1234n);
  const overlay = { nativeHandle: () => handle, isAlive: () => true, bounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }) };
  const states = [];
  const got = [];
  const watch = windows.startWindowWatch({ overlay, onUpdate: (d) => got.push(d), onState: (ok) => states.push(ok), platform });
  assert.equal(spawned[0][0], 'powershell.exe');
  assert.equal(spawned[0][1].slice(-2).join(' '), '4660 1'); // her hwnd, her pid
  children[0].stdout.write('not json\n');
  children[0].stdout.write(`${JSON.stringify({ fg: 7, taskbar: true, ai: ['chatgpt'], wins: [{ id: 7, x: 10, y: 20, w: 800, h: 600, max: false }] })}\n`);
  await settle();
  assert.deepEqual(states, [true]);
  assert.equal(got.length, 1);
  assert.equal(JSON.stringify(got[0]), JSON.stringify({
    fg: 7, taskbar: true, ai: ['chatgpt'], game: null, usb: [], plug: null, wins: [{ id: 7, x: 10, y: 20, w: 800, h: 600, max: false }],
  }));
  watch.refresh();
  assert.equal(got.length, 2);
  // the helper dies: three restarts 3 s apart, then tracking off
  for (let i = 0; i < 3; i++) {
    children[i].emit('close');
    assert.equal(later.length, i + 1);
    later[i]();
  }
  children[3].emit('close');
  assert.deepEqual(states, [true, false]);
  watch.stop();
  assert.equal(children[3].killed, 0); // already gone (child is null)
});

test('windows.js on Windows: stop() kills the helper and does not restart it', () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const later = [];
  let child;
  const { windows } = loadWindows('win32', {
    spawn: () => {
      child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: 0 });
      child.kill = () => { child.killed++; child.emit('close'); };
      return child;
    },
    setTimeout: (fn) => later.push(fn),
  });
  const watch = windows.startWindowWatch({ overlay: { nativeHandle: () => Buffer.alloc(8) }, onUpdate() {}, platform });
  watch.stop();
  assert.equal(child.killed, 1);
  assert.equal(later.length, 0);
});

test('windows.js on Windows: stop() while a restart is pending cancels it', () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const timers = new Map();
  let next = 1;
  const children = [];
  const { windows } = loadWindows('win32', {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      child.kill = () => {};
      children.push(child);
      return child;
    },
    setTimeout: (fn) => { timers.set(next, fn); return next++; },
    clearTimeout: (id) => timers.delete(id),
  });
  const watch = windows.startWindowWatch({ overlay: { nativeHandle: () => Buffer.alloc(8) }, onUpdate() {}, platform });
  children[0].emit('close'); // the helper died: a restart is due in 3 s
  assert.equal(timers.size, 1);
  watch.stop();
  assert.equal(timers.size, 0);
  // and a restart that fires anyway (already queued) starts nothing
  const { windows: w2 } = loadWindows('win32', {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      child.kill = () => {};
      children.push(child);
      return child;
    },
    setTimeout: (fn) => { timers.set(next, fn); return next++; },
    clearTimeout() {},
  });
  const again = w2.startWindowWatch({ overlay: { nativeHandle: () => Buffer.alloc(8) }, onUpdate() {}, platform });
  children.at(-1).emit('close');
  again.stop();
  const count = children.length;
  [...timers.values()].forEach((fn) => fn());
  assert.equal(children.length, count);
});
