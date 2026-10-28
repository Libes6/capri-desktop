'use strict';
// TAURI-05: the overlay half of the sidecar platform (hover/click-through, the chat's keyboard, screens, moving
// between them, a screen change on the fly) on the core, with a fake Rust shell. The Rust half (poll, gate,
// geometry) has its own cargo tests; the live checks are in docs/TAURI_SPIKE.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPeer } = require('../sidecar/rpc');
const { createSidecarPlatform } = require('../src/main/platform/sidecar');
const { createCore } = require('../src/main/core');

const screen = (id, x, over = {}) => ({
  id, scaleFactor: 2, primary: x === 0,
  bounds: { x, y: 0, width: 1280, height: 832 }, workArea: { x, y: 29, width: 1280, height: 803 }, size: { width: 1280, height: 832 }, ...over,
});

async function boot({ screens = [screen(11, 0)] } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-overlay-'));
  const seen = [];
  let sidecar;
  const rust = createPeer({
    write: (line) => setImmediate(() => sidecar.feed(line)),
    onRequest: async (method, params) => {
      seen.push({ kind: 'request', method, params });
      return method === 'overlay.create' ? params.area : method === 'overlay.setBounds' ? params.rect : null;
    },
    onNotification: (method, params) => seen.push({ kind: 'notification', method, params }),
  });
  const hook = { fn: () => {} };
  sidecar = createPeer({ write: (line) => setImmediate(() => rust.feed(line)), onRequest: async () => null, onNotification: (m, p) => hook.fn(m, p) });
  const hello = {
    name: 'Capri', version: '9.9.9', packaged: false, tauri: '2', screens, cursor: { x: 700, y: 300 },
    paths: { userData, home: os.homedir(), appPath: path.resolve(__dirname, '..'), resources: path.resolve(__dirname, '..'), temp: os.tmpdir(), exe: process.execPath },
  };
  const platform = createSidecarPlatform({ rpc: sidecar, hello, root: path.resolve(__dirname, '..'), log: () => {} });
  hook.fn = platform.onNotification;
  const core = createCore({ platform, smoke: true, port: 0, dev: false, watchWindows: () => ({ stop() {}, refresh() {} }) });
  return { rust, seen, platform, core, userData };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const sender = { label: 'overlay' };
const told = (seen, method) => seen.filter((s) => s.method === method).map((s) => s.params);

test('the primary screen is the one Rust marks, not the first of the list', async () => {
  const { platform, userData } = await boot({ screens: [screen(12, -1280, { primary: false }), screen(11, 0)] });
  assert.equal(platform.screens.primary().id, 11);
  assert.equal(platform.screens.nearest({ x: -5, y: 5 }).id, 12);
  assert.equal(platform.screens.nearest({ x: 5000, y: 5 }).id, 11);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('a screen list that arrives empty is ignored: the core always has a screen', async () => {
  const { rust, platform, userData } = await boot();
  rust.notify('screens', { list: [] });
  rust.notify('screens', {});
  await tick();
  assert.equal(platform.screens.all().length, 1);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('hover: her page asks for the window or lets it through, and the chat takes and gives back the keyboard', async () => {
  const { seen, core, userData } = await boot();
  try {
    core.start();
    await tick();
    core.dispatch.handle('setInteractive', [true], sender);
    core.dispatch.handle('setInteractive', [false], sender);
    // the chat: focusable, then the keyboard; closed: not focusable, the keyboard handed back
    core.dispatch.handle('focusOverlay', [true], sender);
    core.dispatch.handle('focusOverlay', [false], sender);
    await tick();
    const order = seen.filter((s) => s.kind === 'notification' && s.method.startsWith('overlay.') && s.method !== 'overlay.keepOnTop').map((s) => [s.method, s.params.on]);
    assert.deepEqual(order, [
      ['overlay.clickThrough', false], ['overlay.clickThrough', true],
      ['overlay.setFocusable', true], ['overlay.focus', undefined],
      ['overlay.setFocusable', false], ['overlay.blur', undefined],
    ]);
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the pointer: where it is on her window, whether it is inside, and which screen it is on', async () => {
  const { rust, platform, core, userData } = await boot({ screens: [screen(11, 0), screen(12, 1280)] });
  try {
    core.start();
    await tick();
    const o = core.overlay().bounds();
    rust.notify('cursor', { x: o.x + 40, y: o.y + 50 });
    await tick();
    assert.deepEqual(await core.dispatch.handle('cursor', [], sender), { x: 40, y: 50, inside: true, display: 11 });
    rust.notify('cursor', { x: 1500, y: 300 });
    await tick();
    const away = await core.dispatch.handle('cursor', [], sender);
    assert.equal(away.inside, false);
    assert.equal(away.display, 12);
    assert.deepEqual(platform.screens.cursor(), { x: 1500, y: 300 });
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('screens: listed with the one she is on, moved to another (the window covers its work area), and refit when the screens change', async () => {
  const { rust, seen, core, userData } = await boot({ screens: [screen(11, 0), screen(12, 1280)] });
  try {
    core.start();
    await tick();
    const list = await core.dispatch.handle('screens', [], sender);
    assert.equal(list.current, 11);
    assert.deepEqual(list.list.map((d) => d.id), [11, 12]);
    assert.deepEqual(core.overlay().bounds(), { x: 0, y: 29, width: 1280, height: 803 });
    // to the second screen
    const moved = await core.dispatch.handle('moveScreen', [12], sender);
    assert.deepEqual(moved.origin, { x: 1280, y: 29 });
    assert.equal(moved.width, 1280);
    assert.deepEqual(told(seen, 'overlay.setBounds').pop().rect, { x: 1280, y: 29, width: 1280, height: 803 });
    assert.equal(await core.dispatch.handle('moveScreen', [99], sender), null, 'no such screen');
    // the second one is unplugged: she is back on the primary one, refit, and her page is told
    seen.length = 0;
    rust.notify('screens', { list: [screen(11, 0)] });
    await tick(80);
    assert.deepEqual(told(seen, 'overlay.setBounds').pop().rect, { x: 0, y: 29, width: 1280, height: 803 });
    const resize = seen.find((s) => s.method === 'emit' && s.params.event === 'overlay:resize');
    assert.deepEqual(resize.params.payload, { width: 1280, height: 803, gap: 0 });
    // a new resolution on the same screen
    seen.length = 0;
    rust.notify('screens', { list: [screen(11, 0, { workArea: { x: 0, y: 29, width: 1000, height: 600 }, bounds: { x: 0, y: 0, width: 1000, height: 629 } })] });
    await tick(80);
    assert.deepEqual(told(seen, 'overlay.setBounds').pop().rect, { x: 0, y: 29, width: 1000, height: 600 });
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('rearm (what resume and unlock call): click-through off/on, on top, refit, and her page is told', async () => {
  const { seen, core, userData } = await boot();
  try {
    core.start();
    await tick();
    seen.length = 0;
    core.dispatch.handle('rearm', [], sender);
    await tick();
    const kinds = seen.filter((s) => s.kind === 'notification').map((s) => `${s.method}${s.params.on === undefined ? '' : ':' + s.params.on}`);
    assert.deepEqual(kinds.slice(0, 3), ['overlay.clickThrough:false', 'overlay.clickThrough:true', 'overlay.keepOnTop']);
    assert.ok(told(seen, 'overlay.setBounds').length >= 1);
    assert.ok(seen.some((s) => s.method === 'emit' && s.params.payload?.name === 'rearmed'));
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
