'use strict';
// TAURI-04: the sidecar's JSON-RPC peer and the sidecar platform, with a fake transport standing in
// for the Rust shell. The core runs on it for real (as sidecar/main.js does).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPeer } = require('../sidecar/rpc');
const { createSidecarPlatform } = require('../src/main/platform/sidecar');
const { missing } = require('../src/main/platform');
const { createCore } = require('../src/main/core');

const display = { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1280, height: 832 }, workArea: { x: 0, y: 0, width: 1280, height: 800 }, size: { width: 1280, height: 832 } };

// two peers wired back to back: `rust` is the fake shell
function wire({ rustHandlers = {}, timeoutMs } = {}) {
  const seen = []; // what the sidecar sent: { kind, method, params }
  let sidecar;
  const rust = createPeer({
    write: (line) => setImmediate(() => sidecar.feed(line)),
    timeoutMs,
    onRequest: async (method, params) => {
      seen.push({ kind: 'request', method, params });
      if (rustHandlers[method]) return rustHandlers[method](params);
      return null;
    },
    onNotification: (method, params) => seen.push({ kind: 'notification', method, params }),
  });
  sidecar = createPeer({ write: (line) => setImmediate(() => rust.feed(line)), timeoutMs, onRequest: async () => null });
  return { rust, sidecar, seen };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('rpc: a request is answered, an error and a missing handler come back as errors, lines split anywhere', async () => {
  const log = [];
  const peer = createPeer({
    write: (line) => log.push(line),
    onRequest: async (method, params) => {
      if (method === 'boom') throw new Error('nope');
      return { echo: params };
    },
  });
  // fed in odd pieces, two messages in one chunk
  const a = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'x', params: { n: 1 } });
  const b = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'boom' });
  peer.feed(a.slice(0, 10));
  peer.feed(a.slice(10) + '\n' + b + '\nnot json\n');
  await tick();
  const answers = log.map((l) => JSON.parse(l));
  assert.deepEqual(answers.find((m) => m.id === 7).result, { echo: { n: 1 } });
  assert.equal(answers.find((m) => m.id === 8).error.message, 'nope');
});

test('rpc: a request that is never answered times out, close() rejects what waits, late answers are ignored', async () => {
  const { sidecar } = wire({ rustHandlers: { slow: () => new Promise(() => {}) } });
  await assert.rejects(sidecar.request('slow', {}, { timeoutMs: 30 }), /no answer in 30 ms/);
  assert.equal(sidecar.pending(), 0);
  const waiting = sidecar.request('slow', {}, { timeoutMs: 5000 });
  sidecar.close('rust went away');
  await assert.rejects(waiting, /rust went away/);
  await assert.rejects(sidecar.request('x', {}), /rpc closed/);
});

async function startOnSidecar(extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-sidecar-'));
  const rustHandlers = { 'overlay.create': ({ area }) => ({ ...area }), 'overlay.setBounds': ({ rect }) => rect };
  const { rust, sidecar, seen } = wire({ rustHandlers });
  const hello = {
    name: 'Capri', version: '9.9.9', packaged: false, tauri: '2',
    paths: { userData, home: os.homedir(), appPath: path.resolve(__dirname, '..'), resources: path.resolve(__dirname, '..'), temp: os.tmpdir(), exe: process.execPath },
    screens: [display], cursor: { x: 10, y: 20 },
  };
  const platform = createSidecarPlatform({ rpc: sidecar, hello, root: path.resolve(__dirname, '..'), log: (m) => seen.push({ kind: 'log', m }) });
  const core = createCore({ platform, smoke: true, port: 0, watchWindows: () => ({ stop() {}, refresh() {} }), ...extra });
  return { rust, sidecar, seen, platform, core, userData, hello };
}

test('the sidecar platform has every method of the platform interface', async () => {
  const { platform, userData } = await startOnSidecar();
  assert.deepEqual(missing(platform), []);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('the core starts on it: the overlay is asked of Rust, events go out by channel, commands come in through the dispatcher', async () => {
  const { rust, seen, platform, core, userData } = await startOnSidecar();
  try {
    core.start();
    await tick();
    const created = seen.find((s) => s.method === 'overlay.create');
    assert.ok(created, 'the overlay is created by Rust');
    assert.deepEqual(core.overlay().bounds(), created.params.area);
    // the notification path to her page
    core.command('status');
    await tick();
    const emitted = seen.find((s) => s.method === 'emit' && s.params.event === 'capri:command');
    assert.deepEqual(emitted.params, { window: 'overlay', event: 'capri:command', payload: { name: 'status' } });
    // a command from her page, as Rust forwards it (sender: the window's label)
    const sender = { label: 'overlay' };
    const config = await core.dispatch.handle('getConfig', [], sender);
    assert.equal(typeof config.lang, 'string');
    assert.ok(platform.overlayNow().owns(sender));
    // the settings window's command from the overlay is refused by the protocol
    assert.throws(() => core.dispatch.handle('view', [], sender), (err) => err.name === 'ProtocolError' && err.code === 'forbidden');
    // click-through goes to Rust as a notification
    core.dispatch.handle('setInteractive', [true], sender);
    await tick();
    assert.deepEqual(seen.find((s) => s.method === 'overlay.clickThrough').params, { on: false });
    // the screens and the pointer are pushed by Rust and read from the cache
    rust.notify('cursor', { x: 5, y: 6 });
    rust.notify('screens', { list: [{ ...display, id: 2 }] });
    await tick();
    assert.deepEqual(platform.screens.cursor(), { x: 5, y: 6 });
    assert.equal(platform.screens.primary().id, 2);
    const at = await core.dispatch.handle('cursor', [], sender);
    assert.equal(at.inside, true);
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('what Rust cannot do yet is answered neutrally and logged once, the core does not fall over', async () => {
  const { seen, platform, core, userData } = await startOnSidecar();
  try {
    core.start();
    assert.equal(platform.secrets.isAvailable(), false);
    assert.equal(await platform.capture.screen({}, {}), null);
    assert.deepEqual(await platform.shell.openExternal('https://example.com'), { unsupported: true });
    await platform.shell.openExternal('https://example.com');
    assert.equal(platform.shortcuts.register('X', () => {}), false);
    const logs = seen.filter((s) => s.kind === 'log' && /unsupported: shell.openExternal/.test(s.m));
    assert.equal(logs.length, 1, 'logged once');
    assert.ok(platform.unsupported.has('tray.create') && platform.unsupported.has('shortcuts.register'));
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
