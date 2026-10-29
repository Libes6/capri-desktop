'use strict';
// TAURI-04: the sidecar's JSON-RPC peer and the sidecar platform, with a fake transport standing in
// for the Rust shell. The core runs on it for real (as sidecar/main.js does).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPeer } = require('../sidecar/rpc');
const { createSidecarPlatform, sealWith, openWith } = require('../src/main/platform/sidecar');
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
  const hook = { fn: () => {} };
  sidecar = createPeer({ write: (line) => setImmediate(() => rust.feed(line)), timeoutMs, onRequest: async () => null, onNotification: (m, p) => hook.fn(m, p) });
  sidecar.hook = hook;
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

async function startOnSidecar(extra = {}, more = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-sidecar-'));
  const rustHandlers = { 'overlay.create': ({ area }) => ({ ...area }), 'overlay.setBounds': ({ rect }) => rect, ...more };
  const { rust, sidecar, seen } = wire({ rustHandlers });
  const hello = {
    name: 'Capri', version: '9.9.9', packaged: false, tauri: '2',
    paths: { userData, home: os.homedir(), appPath: path.resolve(__dirname, '..'), resources: path.resolve(__dirname, '..'), temp: os.tmpdir(), exe: process.execPath },
    screens: [display], cursor: { x: 10, y: 20 },
  };
  const platform = createSidecarPlatform({ rpc: sidecar, hello, root: path.resolve(__dirname, '..'), log: (m) => seen.push({ kind: 'log', m }) });
  sidecar.hook.fn = platform.onNotification;
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
    // the key store is not asked until init(): no key store, keys stay plain (as Electron without safeStorage)
    assert.equal(platform.secrets.isAvailable(), false);
    // what is still not Rust's (the picture of the overlay, TAURI-11 open question) answers neutrally and is logged once
    assert.equal(await platform.windows.createOverlay({ area: { x: 0, y: 0, width: 10, height: 10 } }).capture({}), null);
    await platform.overlayNow().capture({});
    const logs = seen.filter((s) => s.kind === 'log' && /unsupported: overlay.capture/.test(s.m));
    assert.equal(logs.length, 1, 'logged once');
    assert.ok(platform.unsupported.has('overlay.capture'));
    assert.ok(!platform.unsupported.has('windows.createDemoTerminal'), 'the demo terminal is the shell\'s now');
    assert.ok(!platform.unsupported.has('tray.create'), 'the tray is the shell\'s now');
    assert.ok(!platform.unsupported.has('shortcuts.register'), 'so are the shortcuts');
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// TAURI-07: the native services, asked of a fake Rust
const MASTER = Buffer.alloc(32, 7).toString('base64');

test('secrets: init fetches the master key, keys are sealed as kc: and open again, an enc: key is not taken for a plain one', async () => {
  const { platform, userData, sidecar } = await startOnSidecar({}, { 'secrets.masterKey': () => ({ available: true, key: MASTER }), 'app.appForProtocol': () => false });
  try {
    await platform.init();
    assert.equal(platform.secrets.isAvailable(), true);
    const { createKeys } = require('../src/main/setup');
    const keys = createKeys({ platform });
    const sealed = keys.sealKey('sk-secret-123');
    assert.match(sealed, /^kc:[A-Za-z0-9+/=]+$/);
    assert.ok(!sealed.includes('sk-secret-123'));
    assert.equal(keys.openKey(sealed), 'sk-secret-123');
    assert.notEqual(keys.sealKey('sk-secret-123'), sealed, 'a fresh nonce each time');
    // blob layout: version | nonce(12) | ciphertext | tag(16)
    const blob = Buffer.from(sealed.slice(3), 'base64');
    assert.equal(blob[0], 1);
    assert.equal(blob.length, 1 + 12 + 'sk-secret-123'.length + 16);
    // a plain key stays itself; another kind's sealed key, a damaged one and one sealed under another master read as empty
    assert.equal(keys.openKey('sk-plain'), 'sk-plain');
    assert.equal(keys.openKey('enc:AAAA'), '');
    const damaged = Buffer.from(blob); damaged[damaged.length - 1] ^= 1;
    assert.equal(keys.openKey(`kc:${damaged.toString('base64')}`), '');
    assert.equal(keys.openKeys({ a: sealed, b: 'plain' }).b, 'plain');
    assert.throws(() => openWith(Buffer.alloc(32, 7), sealWith(Buffer.alloc(32, 9), 'x')), 'another master key cannot open it');
    sidecar.close('done');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('secrets: no key store means isAvailable false and keys stay plain, as Electron without safeStorage', async () => {
  const { platform, userData, seen } = await startOnSidecar({}, { 'secrets.masterKey': () => ({ available: false, reason: 'no secret service' }), 'app.appForProtocol': () => false });
  try {
    await platform.init();
    assert.equal(platform.secrets.isAvailable(), false);
    const { createKeys } = require('../src/main/setup');
    const keys = createKeys({ platform });
    assert.equal(keys.sealKey('sk-1'), 'sk-1');
    assert.equal(keys.openKey('kc:AAAA'), '', 'a sealed key that cannot be opened is empty, never the ciphertext');
    assert.ok(seen.some((s) => s.kind === 'log' && /no system key store.*no secret service/.test(s.m)));
    assert.ok(!seen.some((s) => /sk-1/.test(JSON.stringify(s))), 'the key is not logged');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('Electron keys (enc:) are opened by the Electron platform only, kc: keys by the Tauri one', () => {
  const { createKeys } = require('../src/main/setup');
  const { createFakePlatform } = require('../src/main/platform/fake');
  const fake = createFakePlatform();
  const electronLike = createKeys({ platform: fake });
  const sealed = electronLike.sealKey('k1');
  assert.match(sealed, /^enc:/);
  assert.equal(electronLike.openKey(sealed), 'k1');
  assert.equal(electronLike.openKey('kc:AAAA'), '');
});

test('shell: openExternal rejects what Rust refuses, openPath answers the error text, showItemInFolder is told', async () => {
  const { platform, userData, seen } = await startOnSidecar({}, {
    'shell.openExternal': ({ url }) => { if (!/^https:/.test(url)) throw new Error('links of the kind file: are not opened'); return null; },
    'shell.openPath': ({ path: p }) => (p === '/ok' ? '' : 'the path does not exist'),
    'shell.showItemInFolder': () => null,
  });
  try {
    await platform.shell.openExternal('https://example.com');
    await assert.rejects(platform.shell.openExternal('file:///etc/passwd'), /not opened/);
    assert.equal(await platform.shell.openPath('/ok'), '');
    assert.equal(await platform.shell.openPath('/no'), 'the path does not exist');
    platform.shell.showItemInFolder('/ok');
    await tick();
    assert.ok(seen.some((s) => s.method === 'shell.showItemInFolder' && s.params.path === '/ok'));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('capture, clipboard and the folder picker go to Rust and come back as the contract says', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const { platform, userData, seen } = await startOnSidecar({}, {
    'capture.screen': ({ width }) => (width > 0 ? png.toString('base64') : null),
    'clipboard.writeImage': ({ png: b64 }) => { if (Buffer.from(b64, 'base64').equals(png)) return true; throw new Error('bad'); },
    'dialogs.pickFolder': ({ default: d }) => (d === '/home/x' ? '/home/x/project' : null),
  });
  try {
    const shot = await platform.capture.screen(display, { width: 640, height: 400, format: 'jpeg', quality: 60 });
    assert.ok(Buffer.isBuffer(shot) && shot.equals(png));
    assert.deepEqual(seen.find((s) => s.method === 'capture.screen').params, { bounds: display.bounds, width: 640, height: 400, format: 'jpeg', quality: 60 });
    assert.equal(await platform.capture.screen(display, { width: 0, height: 0 }), null, 'no picture is null');
    await platform.clipboard.writeImage(png);
    assert.equal(await platform.dialogs.pickFolder('/home/x'), '/home/x/project');
    assert.equal(await platform.dialogs.pickFolder('/elsewhere'), null);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('capture: a failure in Rust is a missing picture, not an exception', async () => {
  const { platform, userData } = await startOnSidecar({}, { 'capture.screen': () => { throw new Error('boom'); } });
  try {
    assert.equal(await platform.capture.screen(display, { width: 10, height: 10 }), null);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('power: events from Rust reach the listeners, the lock is remembered for getSystemIdleState', async () => {
  const { rust, platform, userData, seen } = await startOnSidecar({}, { 'power.idle': () => ({ seconds: 500, state: 'idle' }) });
  try {
    const got = [];
    for (const e of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'user-did-resign-active', 'user-did-become-active']) platform.power.on(e, () => got.push(e));
    for (const e of ['suspend', 'resume', 'lock-screen']) rust.notify('power', { event: e });
    await tick();
    assert.deepEqual(got, ['suspend', 'resume', 'lock-screen']);
    assert.equal(platform.power.getSystemIdleState(1), 'locked');
    rust.notify('power', { event: 'unlock-screen' });
    await tick();
    assert.equal(platform.power.getSystemIdleState(60), 'active', 'the first answer is the cached one');
    await tick();
    assert.equal(platform.power.getSystemIdleState(60), 'idle', 'refreshed from Rust');
    assert.ok(seen.some((s) => s.method === 'power.idle' && s.params.threshold === 60));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('power: started behind the lock screen (hello says so), it is locked from the start', async () => {
  const { platform, hello, userData } = await startOnSidecar();
  try {
    const locked = createSidecarPlatform({ rpc: { request: async () => null, notify() {} }, hello: { ...hello, locked: true }, root: __dirname, log: () => {} });
    assert.equal(locked.power.getSystemIdleState(1), 'locked');
    assert.equal(platform.power.getSystemIdleState(1), 'active');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('appForProtocol: the answer asked for in init, then for any link once it is asked about', async () => {
  const asked = [];
  const { platform, userData } = await startOnSidecar({}, {
    'secrets.masterKey': () => ({ available: false }),
    'app.appForProtocol': ({ url }) => { asked.push(url); return url === 'roblox://' || url === 'steam://'; },
  });
  try {
    await platform.init();
    assert.equal(platform.app.appForProtocol('roblox://'), true);
    assert.equal(platform.app.appForProtocol('steam://'), false, 'not asked yet');
    await tick();
    assert.equal(platform.app.appForProtocol('steam://x'), true);
    assert.equal(platform.app.appForProtocol('nonsense'), false);
    assert.deepEqual(asked, ['roblox://', 'steam://']);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('userSoundUrl: capri://usersounds/ here, http://capri.localhost/ for the Windows webview', async () => {
  const { platform, userData } = await startOnSidecar();
  try {
    const expected = process.platform === 'win32' ? 'http://capri.localhost/a%20b.mp3' : 'capri://usersounds/a%20b.mp3';
    assert.equal(platform.app.userSoundUrl('a b.mp3'), expected);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the window helper is looked for in the resources folder when the sidecar is told where it is', () => {
  const { helperPath } = require('../src/main/mac/window-watch');
  assert.equal(helperPath('/$capri/src/main/mac', undefined, { CAPRI_RESOURCES: '/App/Resources' }), path.join('/App/Resources', 'bin', 'capri-windows'));
  assert.equal(helperPath('/repo/src/main/mac', undefined, {}), path.join('/repo/src/main/mac', 'bin', 'capri-windows'));
});

test('the demo terminal is Rust\'s window: opened by id, the core\'s destroy is not a "closed", the person\'s close is', async () => {
  const { rust, seen, platform, userData } = await startOnSidecar();
  try {
    let closed = 0;
    const win = platform.windows.createDemoTerminal({ x: 5, y: 6, width: 620, height: 300, title: 't', background: '#14101c', alwaysOnTop: true, html: '<body>hi</body>', onClosed: () => { closed++; } });
    await tick();
    const opened = seen.find((s) => s.method === 'demo.open');
    assert.deepEqual({ ...opened.params, html: undefined }, { id: opened.params.id, x: 5, y: 6, width: 620, height: 300, title: 't', background: '#14101c', alwaysOnTop: true, html: undefined });
    assert.equal(opened.params.html, '<body>hi</body>');
    // the person closes it: Rust says so
    rust.notify('demo.closed', { id: opened.params.id });
    await tick();
    assert.equal(closed, 1);
    // the core replaces one with another (demoWindow does destroy + create): the old one's "closed" arrives late and means nothing
    const first = platform.windows.createDemoTerminal({ html: 'a', onClosed: () => { closed += 10; } });
    await tick();
    const firstId = seen.filter((s) => s.method === 'demo.open').pop().params.id;
    first.destroy();
    platform.windows.createDemoTerminal({ html: 'b', onClosed: () => { closed += 100; } });
    await tick();
    assert.ok(seen.some((s) => s.method === 'demo.close' && s.params.id === firstId));
    rust.notify('demo.closed', { id: firstId });
    await tick();
    assert.equal(closed, 1, 'a window the core destroyed does not call back');
    assert.ok(!platform.unsupported.has('windows.createDemoTerminal'));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// TAURI-11: every command of docs/protocol.json is served by the core on the sidecar platform, and the platform
// answers "unsupported" only where docs/TAURI_PARITY.md says so.
const protocolJson = require('../docs/protocol.json');
const KNOWN_UNSUPPORTED = ['overlay.capture', 'overlay.mediaSourceId', 'overlay.nativeHandle'];

test('integrity: all 65 commands are registered by the core on the sidecar platform, as send or handle as the protocol says', async () => {
  const { core, userData } = await startOnSidecar();
  try {
    core.start();
    await tick();
    assert.equal(protocolJson.commands.length, 65);
    for (const c of protocolJson.commands) {
      const table = c.kind === 'send' ? core.ipc.on : core.ipc.handle;
      assert.equal(typeof table[c.channel], 'function', `${c.name} (${c.channel}) is not served as ${c.kind}`);
    }
    // and nothing is served that the protocol does not know
    const known = new Set(protocolJson.commands.map((c) => c.channel));
    for (const channel of [...Object.keys(core.ipc.on), ...Object.keys(core.ipc.handle)]) assert.ok(known.has(channel), `${channel} is served but not in the protocol`);
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('integrity: the commands that read state answer on the sidecar platform with nothing unsupported behind them', async () => {
  const { platform, core, userData } = await startOnSidecar();
  try {
    core.start();
    await tick();
    const overlay = { label: 'overlay' };
    const calls = [['getConfig', []], ['setConfig', [{ muted: true }]], ['screens', []], ['cursor', []], ['windowsNow', []], ['hooksStatus', []],
      ['listSounds', []], ['claudeFound', []], ['trayPlace', []], ['chatStatus', []], ['setupInfo', []], ['demoWindow', [false]], ['openApps', []], ['media', ['play']]];
    for (const [name, args] of calls) {
      const value = await Promise.resolve(core.dispatch.handle(name, args, overlay)).catch((err) => { throw new Error(`${name}: ${err.message}`); });
      assert.notDeepEqual(value, { unsupported: true }, `${name} answered unsupported`);
    }
    core.dispatch.handle('rendererReady', [], overlay);
    assert.deepEqual([...platform.unsupported].sort().filter((m) => !KNOWN_UNSUPPORTED.includes(m)), [], 'a new unsupported method needs a line in docs/TAURI_PARITY.md');
    core.stop();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('integrity: the platform names exactly the unsupported methods the parity table knows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'platform', 'sidecar.js'), 'utf8');
  const named = [...src.matchAll(/unsupported\('([a-zA-Z.]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, KNOWN_UNSUPPORTED);
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'TAURI_PARITY.md'), 'utf8');
  for (const m of KNOWN_UNSUPPORTED) assert.ok(doc.includes(`\`${m}\``), `docs/TAURI_PARITY.md does not explain ${m}`);
});

test('the Tauri build offers no display mode: not in her tray menu, not in the settings window', async () => {
  const { platform, core, userData } = await startOnSidecar();
  try {
    assert.equal(platform.app.renderModes, false);
    core.start();
    await tick();
    const { TRAY } = require('../src/main/labels');
    const labels = JSON.stringify(core.menu.labels());
    assert.ok(!labels.includes(TRAY.en.displayGl) && !labels.includes(TRAY.ru.displayGl), 'no display submenu');
    assert.ok(labels.includes(TRAY.en.motionFull) || labels.includes(TRAY.ru.motionFull), 'the menu itself is there');
    core.stop(); // the settings window's view is tested in settings-save.test.js
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
