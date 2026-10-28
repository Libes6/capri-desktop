'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');
const { parseLine, toUpdate, overlayWindowId, startMacWindowWatch } = require('../src/main/mac/window-watch');
const { createFakePlatform } = require('../src/main/platform/fake');

const line = (o) => JSON.stringify({ v: 1, fg: null, displays: [], wins: [], ...o });

test('mac helper line: windows and displays parsed, unknown fields dropped', () => {
  const snap = parseLine(line({
    fg: 42,
    displays: [{ id: 2, x: 0, y: 0, w: 2560, h: 1440, scale: 2 }, { id: 3, x: -1920, y: -200, w: 1920, h: 1080 }],
    wins: [{ id: 42, x: -250, y: 300, w: 700, h: 400, max: false, full: false, title: 'secret', owner: 'App' },
      { id: 7, x: 0, y: 0, w: 2560, h: 1440, max: true, full: true }],
    extra: 'ignored',
  }));
  assert.deepEqual(snap, {
    fg: 42,
    wins: [{ id: 42, x: -250, y: 300, w: 700, h: 400, max: false, full: false },
      { id: 7, x: 0, y: 0, w: 2560, h: 1440, max: true, full: true }],
    displays: [{ id: 2, x: 0, y: 0, w: 2560, h: 1440, scale: 2 }, { id: 3, x: -1920, y: -200, w: 1920, h: 1080, scale: 1 }],
    locked: false,
  });
  assert.equal(parseLine(line({ locked: true })).locked, true);
  assert.equal(parseLine(line({ locked: 'yes' })).locked, false);
});

test('mac helper line: garbage is rejected or filtered', () => {
  for (const bad of ['', 'not json', 'null', '[]', '{"v":2,"wins":[]}', '{"v":1}', '{"v":1,"wins":{}}']) {
    assert.equal(parseLine(bad), null, bad);
  }
  const snap = parseLine(line({
    fg: -1,
    wins: [null, { id: 0, x: 0, y: 0, w: 10, h: 10 }, { id: 1.5, x: 0, y: 0, w: 10, h: 10 }, { id: 2, x: '1', y: 0, w: 10, h: 10 },
      { id: 3, x: 0, y: 0, w: 0, h: 10 }, { id: 4, x: 1e9, y: 0, w: 10, h: 10 }, { id: 5, x: NaN, y: 0, w: 10, h: 10 },
      { id: 6, x: 1, y: 2, w: 3, h: 4, max: 'yes' }],
  }));
  assert.equal(snap.fg, null);
  assert.deepEqual(snap.wins, [{ id: 6, x: 1, y: 2, w: 3, h: 4, max: false, full: false }]);
  const many = parseLine(line({ wins: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, x: 0, y: 0, w: 300, h: 200 })) }));
  assert.equal(many.wins.length, 40);
});

test('mac update: shifted into the overlay, off-screen windows dropped, Windows-only fields empty', () => {
  const snap = parseLine(line({
    fg: 1,
    wins: [
      { id: 1, x: -250, y: 300, w: 700, h: 400 }, // partly off the left edge: kept
      { id: 2, x: 2600, y: 100, w: 800, h: 600 }, // on a display to the right: dropped
      { id: 3, x: -1900, y: -100, w: 800, h: 600 }, // on a display up-left (negative space): dropped
      { id: 4, x: 0, y: 30, w: 2560, h: 1312, max: true },
    ],
  }));
  const update = toUpdate(snap, { x: 0, y: 30, width: 2560, height: 1410 });
  assert.deepEqual(update, {
    fg: 1, taskbar: false, ai: [], game: null, usb: [], plug: null,
    wins: [{ id: 1, x: -250, y: 270, w: 700, h: 400, max: false, full: false }, { id: 4, x: 0, y: 0, w: 2560, h: 1312, max: true, full: false }],
  });
  // her overlay on the left display: the same windows seen from there
  const left = toUpdate(snap, { x: -1920, y: -200, width: 1920, height: 1080 });
  assert.deepEqual(left.wins.map((w) => [w.id, w.x, w.y]), [[1, 1670, 500], [3, 20, 100]]);
});

test('mac overlay window id comes from the media source id', () => {
  assert.equal(overlayWindowId({ mediaSourceId: () => 'window:74027:0' }), 74027);
  assert.equal(overlayWindowId({ mediaSourceId: () => 'screen:1:0' }), null);
  assert.equal(overlayWindowId({ mediaSourceId() { throw new Error('destroyed'); } }), null);
});

function fakeOverlay() {
  return { isAlive: () => true, bounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }), mediaSourceId: () => 'window:99:0' };
}

function fakeSpawn(calls) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, child });
    return child;
  };
}

test('mac watch: missing helper keeps the base overlay and spawns nothing', () => {
  const calls = [];
  const logs = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() { throw new Error('no update expected'); },
    helper: '/nonexistent/capri-windows', spawn: fakeSpawn(calls), log: (...a) => logs.push(a.join(' ')) });
  assert.equal(watch.available, false);
  assert.equal(calls.length, 0);
  watch.refresh();
  watch.stop();
  assert.match(logs[0], /not built/);
});

test('mac watch: helper lines become updates; restarts are bounded', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const updates = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  assert.equal(watch.available, true);
  assert.deepEqual(calls[0].args, ['--parent', String(process.pid), '--watch-stdin', '--self-window', '99']);

  return new Promise((resolve) => {
    calls[0].child.stdout.write(`garbage\n${line({ fg: 5, wins: [{ id: 5, x: 10, y: 20, w: 300, h: 200 }] })}\n`);
    setImmediate(() => {
      assert.equal(updates.length, 1);
      assert.deepEqual(updates[0].wins, [{ id: 5, x: 10, y: 20, w: 300, h: 200, max: false, full: false }]);
      watch.refresh(); // her window moved: the last snapshot again
      assert.equal(updates.length, 2);

      // a helper that keeps dying is restarted three times, then left alone
      for (let i = 0; i < 5; i++) {
        calls.at(-1).child.emit('close', 1);
        t.mock.timers.tick(3000);
      }
      assert.equal(calls.length, 4);

      // stopped: the helper is killed and not brought back
      const again = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, helper: __filename, spawn: fakeSpawn(calls), log() {} });
      again.stop();
      assert.equal(calls.at(-1).child.killed, true);
      calls.at(-1).child.emit('close', null);
      t.mock.timers.tick(3000);
      assert.equal(calls.length, 5);
      resolve();
    });
  });
});

test('mac watch: a JSON line split across stdout chunks is joined before parsing', async () => {
  const calls = [];
  const updates = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u), helper: __filename, spawn: fakeSpawn(calls), log() {} });
  const full = line({ fg: 5, wins: [{ id: 5, x: 10, y: 20, w: 300, h: 200 }] });
  const out = calls[0].child.stdout;
  out.write(full.slice(0, 17));
  await new Promise(setImmediate);
  assert.equal(updates.length, 0);
  out.write(`${full.slice(17)}\n${full.slice(0, 5)}`);
  await new Promise(setImmediate);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fg, 5);
});

test('mac watch: onState follows the helper like the Windows/Linux watchers', async (t) => {
  const states = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok),
    helper: '/nonexistent/capri-windows', spawn: fakeSpawn([]), log() {} });
  assert.deepEqual(states, [false]); // no helper: tracking off, the base overlay stays

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  states.length = 0;
  const calls = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  calls[0].child.stdout.write('garbage\n');
  await new Promise(setImmediate);
  assert.deepEqual(states, []); // not a snapshot: not running yet
  calls[0].child.stdout.write(`${line({})}\n${line({ fg: 3 })}\n`);
  await new Promise(setImmediate);
  assert.deepEqual(states, [true]); // once per helper run, not per line
  for (let i = 0; i < 4; i++) {
    calls.at(-1).child.emit('close', 1);
    t.mock.timers.tick(3000);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(states, [true, false]); // gave up after three restarts
});

test('mac watch: stop() during a pending restart spawns nothing more, later lines are ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const updates = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  calls[0].child.emit('close', 1); // the helper died: a restart is pending
  watch.stop();
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1);

  const again = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  again.stop();
  calls.at(-1).child.stdout.write(`${line({ fg: 1 })}\n`);
  return new Promise((resolve) => setImmediate(() => {
    assert.equal(updates.length, 0);
    resolve();
  }));
});

test('mac watch: a helper that cannot be executed (no exit event) is still retried, then given up', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'capri-windows');
  fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o644 }); // present but not executable: EACCES
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const states = [];
  const logs = [];
  const spawn = (...a) => {
    const c = realSpawn(...a);
    children.push(new Promise((r) => c.once('close', r)));
    return c;
  };
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok), helper, spawn, log: (...a) => logs.push(a.join(' ')) });
  for (let i = 0; i < 4; i++) {
    await children[i];
    await new Promise(setImmediate);
    t.mock.timers.tick(3000);
  }
  assert.equal(children.length, 4);
  assert.deepEqual(states, [false]);
  assert.ok(logs.some((l) => /EACCES/.test(l)));
});

test('mac watch: giving up sends an empty update, so she does not stay perched on a stale window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const updates = [];
  const states = [];
  startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u), onState: (ok) => states.push(ok),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  calls[0].child.stdout.write(`${line({ fg: 5, wins: [{ id: 5, x: 10, y: 20, w: 300, h: 200 }] })}\n`);
  await new Promise(setImmediate);
  assert.equal(updates.at(-1).wins.length, 1);
  for (let i = 0; i < 4; i++) {
    calls.at(-1).child.emit('close', 1);
    t.mock.timers.tick(3000);
  }
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(updates.at(-1), { fg: null, taskbar: false, ai: [], game: null, usb: [], plug: null, wins: [] });
});

test('mac watch: pause() stops the helper without counting a failure; resume() starts a fresh one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const states = [];
  const updates = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u), onState: (ok) => states.push(ok),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  calls[0].child.stdout.write(`${line({ fg: 1 })}\n`);
  await new Promise(setImmediate);
  assert.deepEqual(states, [true]);

  watch.pause(); // locked or asleep
  assert.equal(calls[0].child.killed, true);
  calls[0].child.emit('close', null);
  calls[0].child.stdout.write(`${line({ fg: 2 })}\n`); // late output of the old helper: ignored
  await new Promise(setImmediate);
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1); // no restart while paused
  assert.equal(updates.length, 1);
  assert.deepEqual(states, [true]); // still on: the last snapshot holds

  watch.resume();
  assert.equal(calls.length, 2);
  calls[1].child.stdout.write(`${line({ fg: 3 })}\n`);
  await new Promise(setImmediate);
  assert.equal(updates.at(-1).fg, 3);

  // a resume while one runs replaces it, and the replaced one's end is not a failure
  watch.resume();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].child.killed, true);
  calls[1].child.emit('close', null);
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 3);

  // a helper that gave up gets one more chance on resume (a system event), with its restarts back
  for (let i = 0; i < 4; i++) {
    calls.at(-1).child.emit('close', 1);
    t.mock.timers.tick(3000);
  }
  assert.equal(states.at(-1), false);
  const before = calls.length;
  t.mock.timers.tick(60000);
  assert.equal(calls.length, before); // no loop of its own
  watch.resume();
  assert.equal(calls.length, before + 1);
  calls.at(-1).child.stdout.write(`${line({})}\n`);
  await new Promise(setImmediate);
  assert.equal(states.at(-1), true);

  watch.stop();
  watch.resume(); // stopped for good
  assert.equal(calls.length, before + 1);
});

test('windows.js on macOS: paused on sleep and lock, fresh helper after wake, unlock and screen changes', () => {
  const { startMacWatch } = loadWindowsOnMac();
  const power = new EventEmitter();
  const screens = new EventEmitter();
  const timers = new Map();
  let next = 1;
  const later = { set: (fn) => { timers.set(next, fn); return next++; }, clear: (id) => timers.delete(id) };
  const log = [];
  const fakeWatch = { available: true, pause: () => log.push('pause'), resume: () => log.push('resume'), stop: () => log.push('stop'), refresh: () => log.push('refresh') };
  const states = [];
  const watch = startMacWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok), power, screens, later,
    start: ({ onState }) => { onState(true); return fakeWatch; } });
  assert.deepEqual(states, [true]);

  power.emit('lock-screen');
  assert.deepEqual(log, ['pause']);
  power.emit('unlock-screen');
  assert.equal(timers.size, 1);
  power.emit('suspend'); // asleep before the unlock settled: the fresh start is called off
  assert.equal(timers.size, 0);
  power.emit('resume');
  screens.emit('display-metrics-changed');
  screens.emit('display-added'); // several events in a row: one fresh helper
  assert.equal(timers.size, 1);
  const [[id, fire]] = timers;
  timers.delete(id);
  fire();
  assert.deepEqual(log, ['pause', 'pause', 'resume']);
  watch.refresh();
  assert.equal(log.at(-1), 'refresh');

  screens.emit('display-removed');
  watch.stop();
  assert.equal(timers.size, 0);
  assert.equal(log.at(-1), 'stop');
  for (const e of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) assert.equal(power.listenerCount(e), 0, e);
  for (const e of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(screens.listenerCount(e), 0, e);
});

test('windows.js on macOS: a screen event while asleep or locked does not bring the helper back', () => {
  const { startMacWatch } = loadWindowsOnMac();
  const power = new EventEmitter();
  const screens = new EventEmitter();
  const timers = new Map();
  let next = 1;
  const later = { set: (fn) => { timers.set(next, fn); return next++; }, clear: (id) => timers.delete(id) };
  const log = [];
  const fakeWatch = { available: true, pause: () => log.push('pause'), resume: () => log.push('resume'), stop() {}, refresh() {} };
  const watch = startMacWatch({ overlay: fakeOverlay(), onUpdate() {}, onState() {}, power, screens, later, start: () => fakeWatch });
  power.emit('lock-screen');
  screens.emit('display-removed'); // an external screen going dark behind the lock screen
  assert.equal(timers.size, 0);
  power.emit('unlock-screen');
  screens.emit('display-added');
  assert.equal(timers.size, 1); // after the unlock, screen events count again
  const [[, fire]] = timers;
  fire();
  assert.deepEqual(log, ['pause', 'resume']);
  watch.stop();
});

test('windows.js on macOS: no helper, no listeners, tracking off', () => {
  const { startMacWatch } = loadWindowsOnMac();
  const power = new EventEmitter();
  const screens = new EventEmitter();
  const states = [];
  const watch = startMacWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok), power, screens,
    start: ({ onState }) => { onState(false); return { available: false, stop() {}, refresh() {}, pause() {}, resume() {} }; } });
  assert.deepEqual(states, [false]);
  assert.equal(power.listenerCount('resume') + screens.listenerCount('display-added'), 0);
  watch.refresh();
  watch.stop();
});

test('windows.js on macOS: startWindowWatch runs the real adapter, a missing helper keeps the base overlay', () => {
  const { windows, spawned } = loadWindowsOnMac({ helperMissing: true });
  const states = [];
  const watch = windows.startWindowWatch({ overlay: fakeOverlay(), onUpdate() {}, onState: (ok) => states.push(ok), platform: createFakePlatform() });
  assert.deepEqual(states, [false]);
  assert.equal(spawned.length, 0);
  watch.refresh();
  watch.stop();
});

// windows.js as on a Mac, with the platform's screens and power stood in for (the fake's)
function loadWindowsOnMac({ helperMissing = false } = {}) {
  const vm = require('node:vm');
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/main/windows.js');
  const spawned = [];
  const quiet = { log() {}, error() {} };
  const context = {
    module, exports: module.exports, __dirname: path.dirname(filename), console: quiet, Buffer, setTimeout, clearTimeout,
    process: { platform: 'darwin', env: {}, pid: 1 },
    require(id) {
      if (id === 'node:child_process') return { spawn: (...a) => { spawned.push(a); throw new Error('spawned'); } };
      if (id.endsWith(path.join('mac', 'window-watch.js')) && helperMissing) {
        const real = require(id);
        return { ...real, startMacWindowWatch: (o) => real.startMacWindowWatch({ ...o, helper: '/nonexistent/capri-windows', log() {} }) };
      }
      return require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { windows: module.exports, startMacWatch: module.exports.startMacWatch, spawned };
}

test('mac helper path: bin/ next to the adapter from the repository, Resources/bin once packaged', () => {
  const { helperPath } = require('../src/main/mac/window-watch');
  const repo = path.join('/src', 'capri', 'src', 'main', 'mac');
  assert.equal(helperPath(repo, '/whatever'), path.join(repo, 'bin', 'capri-windows'));
  const res = path.join('/Applications', 'Capri.app', 'Contents', 'Resources');
  assert.equal(helperPath(path.join(res, 'app.asar', 'src', 'main', 'mac'), res), path.join(res, 'bin', 'capri-windows'));
  assert.equal(helperPath(path.join(res, 'app.asar.unpacked', 'src', 'main', 'mac'), res), path.join(res, 'bin', 'capri-windows'));
});

test('mac watch: snapshots behind the lock screen are ignored, the last good one holds', async () => {
  const calls = [];
  const updates = [];
  const states = [];
  const watch = startMacWindowWatch({ overlay: fakeOverlay(), onUpdate: (u) => updates.push(u), onState: (ok) => states.push(ok),
    helper: __filename, spawn: fakeSpawn(calls), log() {} });
  const out = calls[0].child.stdout;
  out.write(`${line({ locked: true, wins: [{ id: 9, x: 0, y: 0, w: 300, h: 200 }] })}\n`);
  await new Promise(setImmediate);
  assert.deepEqual(states, [true]); // the helper runs
  assert.equal(updates.length, 0); // but nothing stale goes out
  out.write(`${line({ fg: 5, wins: [{ id: 5, x: 10, y: 20, w: 300, h: 200 }] })}\n`);
  out.write(`${line({ locked: true, fg: null, wins: [] })}\n`);
  await new Promise(setImmediate);
  assert.equal(updates.length, 1);
  watch.refresh();
  assert.equal(updates.at(-1).fg, 5);
  watch.stop();
});
