'use strict';
// TAURI-10: the updater of the Tauri build. updates.js with the tauri-plugin-updater transport on a
// fake, and the sidecar platform's half of the protocol (updater.* notifications to Rust and back)
// with the shell faked. The Rust half is tested in src-tauri/src/updater.rs (cargo test).
const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateController, tauriTransport, startUpdates, updateError } = require('../src/main/updates');
const { createSidecarPlatform } = require('../src/main/platform/sidecar');
const { createFakePlatform } = require('../src/main/platform/fake');

const NEWER = { version: '0.2.0', notes: 'Fixes & more', date: '2026-10-28T10:00:00Z' };

// what platform/sidecar.js gives (`tauri`): every call recorded, the answers set by the test
function fakeApi({ found = NEWER, checkError = null, downloadError = null, installError = null, status = { mode: 'install' } } = {}) {
  const calls = [];
  const api = {
    calls,
    status,
    check: async () => { calls.push('check'); if (checkError) throw checkError; return found; },
    download: async (progress) => {
      calls.push('download');
      progress(50, 100);
      if (downloadError) throw downloadError;
      progress(100, 100);
    },
    install: async () => { calls.push('install'); if (installError) throw installError; },
  };
  return api;
}

const rustError = (category, message, extra = {}) => Object.assign(new Error(message), {
  code: category === 'signature' ? 'ERR_CAPRI_SIGNATURE' : category === 'network' ? 'ERR_CAPRI_NETWORK' : 'ERR_CAPRI_UPDATE',
  ...extra,
});

test('tauri: check → download with progress → verified → confirm → install and relaunch', async () => {
  const api = fakeApi();
  let relaunches = 0;
  const seen = [];
  const c = new UpdateController({ transport: tauriTransport(api, { relaunch: () => relaunches++ }), current: '0.1.0', onChange: (v) => seen.push(v) });
  await c.check();
  assert.equal(c.status.kind, 'available');
  assert.equal(c.view().notes, 'Fixes & more');
  assert.equal(c.view().canDownload, true);
  assert.match(c.view().page, /releases\/tag\/fork-v0\.2\.0$/);
  await c.install(async () => true); // not downloaded: nothing installs
  assert.deepEqual(api.calls, ['check']);
  await c.download();
  assert.equal(c.status.kind, 'downloaded');
  const last = seen.filter((v) => v.kind === 'downloading').at(-1);
  assert.deepEqual([last.received, last.total], [100, 100]);
  // declined: the download stays, nothing installs, nothing relaunches
  await c.install(async () => false);
  assert.equal(c.status.kind, 'downloaded');
  assert.equal(relaunches, 0);
  await c.install(async () => true);
  assert.deepEqual(api.calls, ['check', 'download', 'install']);
  assert.equal(c.status.kind, 'installing');
  assert.equal(relaunches, 1);
});

test('tauri: nothing newer is "current"; a failed check never is', async () => {
  const none = new UpdateController({ transport: tauriTransport(fakeApi({ found: null })) });
  await none.check();
  assert.equal(none.status.kind, 'current');

  let offline = true;
  const api = fakeApi();
  api.check = async () => { if (offline) throw rustError('network', 'error sending request for url (http://127.0.0.1:1/latest.json)'); return null; };
  const c = new UpdateController({ transport: tauriTransport(api) });
  await c.check();
  assert.equal(c.status.kind, 'error');
  assert.equal(c.status.category, 'network');
  offline = false;
  await c.check();
  assert.equal(c.status.kind, 'current'); // a retry that worked
});

test('tauri: a signature failure blocks installation; a broken download is a retryable network error', async () => {
  const bad = fakeApi({ downloadError: rustError('signature', 'Signature verification failed') });
  const c = new UpdateController({ transport: tauriTransport(bad) });
  await c.check();
  await c.download();
  assert.equal(c.status.kind, 'error');
  assert.equal(c.status.category, 'signature');
  assert.equal(c.status.version, '0.2.0');
  await c.install(async () => true);
  assert.ok(!bad.calls.includes('install'), 'never installs what failed verification');

  const broken = fakeApi({ downloadError: rustError('network', 'Download request failed with status: 503') });
  const d = new UpdateController({ transport: tauriTransport(broken) });
  await d.check();
  await d.download();
  assert.equal(d.status.category, 'network');
  // a new check can recover; the download is asked for again
  broken.download = async () => {};
  await d.check();
  await d.download();
  assert.equal(d.status.kind, 'downloaded');
});

test('tauri: other failures, a feed with nothing for this system, and an install that fails', async () => {
  const other = new UpdateController({ transport: tauriTransport(fakeApi({ checkError: rustError('other', 'the platform `darwin-aarch64` was not found in the response `platforms` object', { reason: 'feed' }) })) });
  await other.check();
  assert.equal(other.status.category, 'other');
  assert.equal(other.status.reason, 'feed');

  const api = fakeApi({ installError: rustError('other', 'Permission denied (os error 13)', { reason: 'location' }) });
  const c = new UpdateController({ transport: tauriTransport(api) });
  await c.check();
  await c.download();
  await c.install(async () => true);
  assert.equal(c.status.kind, 'error');
  assert.equal(c.status.reason, 'location');
  assert.equal(c.busy, false);
  // a signed-url query never reaches the window
  const e = updateError(rustError('network', 'GET https://objects.example/x?X-Amz-Signature=secret failed'));
  assert.ok(!e.error.includes('secret'));
});

test('tauri: one operation at a time (a second check, download or install while one runs is ignored)', async () => {
  let release;
  const api = fakeApi();
  api.check = async () => { api.calls.push('check'); await new Promise((r) => { release = r; }); return NEWER; };
  const c = new UpdateController({ transport: tauriTransport(api) });
  const first = c.check();
  await c.check();
  await c.download();
  await c.install(async () => true);
  assert.deepEqual(api.calls, ['check']);
  release();
  await first;
  assert.equal(c.status.kind, 'available');

  let finish;
  api.download = async () => { api.calls.push('download'); await new Promise((r) => { finish = r; }); };
  const dl = c.download();
  await c.download();
  await c.check(); // busy: ignored, the state is still the download's
  assert.equal(c.status.kind, 'downloading');
  finish();
  await dl;
  assert.deepEqual(api.calls, ['check', 'download']);
});

test('tauri: a package (notify mode) is told of the update and offers no download or install', async () => {
  const api = fakeApi({ status: { mode: 'notify' } });
  const c = new UpdateController({ mode: 'notify', transport: tauriTransport(api, { notify: true }) });
  await c.check();
  assert.equal(c.status.kind, 'available');
  assert.equal(c.view().canDownload, false);
  await c.download();
  await c.install(async () => true);
  assert.deepEqual(api.calls, ['check']);
});

// --- startUpdates on a platform with the Tauri updater ---------------------------------------------

function platformWith(api, version = '0.1.0') {
  const p = createFakePlatform();
  p.updater.transport = 'tauri';
  p.updater.get = () => ({ tauri: api });
  p.app.version = () => version;
  p.app.relaunch = () => p.relaunched.push(1);
  p.relaunched = [];
  return p;
}

test('startUpdates (tauri): disabled in a dev run, a build without a key and --smoke-test; never "current"', async () => {
  for (const [status, smoke, reason] of [
    [{ mode: 'disabled', reason: 'dev' }, false, 'dev'],
    [{ mode: 'disabled', reason: 'feed' }, false, 'feed'],
    [{ mode: 'install' }, true, 'smoke'],
  ]) {
    const api = fakeApi({ status });
    const c = startUpdates({ platform: platformWith(api), smoke, log: () => {} });
    await c.check();
    await c.download();
    assert.equal(c.status.kind, 'disabled');
    assert.equal(c.status.reason, reason);
    assert.deepEqual(api.calls, []);
  }
});

test('startUpdates (tauri): a provisioned install runs the whole cycle and relaunches through the platform', async () => {
  const api = fakeApi();
  const platform = platformWith(api, '0.1.0');
  const c = startUpdates({ platform, log: () => {} });
  assert.equal(c.status.kind, 'idle');
  assert.equal(c.view().current, '0.1.0');
  await c.check();
  await c.download();
  await c.install(async () => true);
  assert.deepEqual(api.calls, ['check', 'download', 'install']);
  assert.equal(platform.relaunched.length, 1);
});

// --- platform/sidecar.js: the protocol with Rust -----------------------------------------------------

function sidecarPlatform(updater = { mode: 'install', reason: null, test: false }) {
  const sent = [];
  const rpc = { request: async () => null, notify: (method, params) => sent.push({ method, params }) };
  const hello = { name: 'Capri', identifier: 'capri.desktop', version: '0.1.0', paths: { userData: '/tmp/x' }, screens: [], cursor: { x: 0, y: 0 }, updater };
  const platform = createSidecarPlatform({ rpc, hello, root: '/tmp/x', log: () => {} });
  return { platform, sent };
}

test('sidecar platform: updater calls go to Rust as notifications and settle on their results', async () => {
  const { platform, sent } = sidecarPlatform();
  const { tauri } = platform.updater.get();
  assert.deepEqual(tauri.status, { mode: 'install', reason: null, test: false });

  const check = tauri.check();
  assert.deepEqual(sent.map((s) => s.method), ['updater.check']);
  platform.onNotification('updater.result', { id: sent[0].params.id, ok: true, result: NEWER });
  assert.deepEqual(await check, NEWER);

  const seen = [];
  const download = tauri.download((received, total) => seen.push([received, total]));
  const id = sent[1].params.id;
  assert.equal(sent[1].method, 'updater.download');
  platform.onNotification('updater.progress', { id, received: 10, total: 40 });
  platform.onNotification('updater.progress', { id: 999, received: 1, total: 1 }); // another call's: ignored
  platform.onNotification('updater.result', { id, ok: true, result: { version: '0.2.0' } });
  await download;
  assert.deepEqual(seen, [[10, 40]]);
});

test('sidecar platform: Rust failures keep their category and reason; a late or unknown result is ignored', async () => {
  const { platform, sent } = sidecarPlatform();
  const { tauri } = platform.updater.get();
  const p = tauri.download(() => {});
  platform.onNotification('updater.result', { id: sent[0].params.id, ok: false, error: { category: 'signature', reason: null, message: 'Signature verification failed' } });
  await assert.rejects(p, (err) => err.code === 'ERR_CAPRI_SIGNATURE' && /Signature/.test(err.message));
  platform.onNotification('updater.result', { id: sent[0].params.id, ok: true }); // already settled
  platform.onNotification('updater.result', { id: 12345, ok: true });

  const q = tauri.check();
  platform.onNotification('updater.result', { id: sent[1].params.id, ok: false, error: { category: 'other', reason: 'feed', message: 'no build for this system' } });
  await assert.rejects(q, (err) => err.code === 'ERR_CAPRI_UPDATE' && err.reason === 'feed');
  const n = tauri.install();
  platform.onNotification('updater.result', { id: sent[2].params.id, ok: false, error: { category: 'network', message: 'down' } });
  await assert.rejects(n, (err) => err.code === 'ERR_CAPRI_NETWORK');
});

test('sidecar platform: with no word from Rust the updater is off; the Tauri controller reads that', () => {
  const bare = createSidecarPlatform({
    rpc: { request: async () => null, notify: () => {} },
    hello: { name: 'Capri', version: '0.1.0', paths: { userData: '/tmp/x' } },
    root: '/tmp/x',
    log: () => {},
  });
  assert.deepEqual(bare.updater.get().tauri.status, { mode: 'disabled', reason: 'dev' });
  const c = startUpdates({ platform: bare, log: () => {} });
  assert.equal(c.status.kind, 'disabled');
});

test('the sidecar platform still has every method the core asks for', () => {
  const { missing } = require('../src/main/platform');
  assert.deepEqual(missing(sidecarPlatform().platform), []);
});
