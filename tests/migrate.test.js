'use strict';
// TAURI-09: the Electron profile -> the Tauri one. Only synthetic profiles in temporary folders: the real
// ~/Library/Application Support/Capri, ~/.claude and the real key store are never read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFakePlatform } = require('../src/main/platform/fake');
const { sealWith, openWith } = require('../src/main/seal');
const { prepareTauriMigration, sha256 } = require('../src/main/migrate-prepare');
const migrate = require('../src/main/migrate');
const hc = require('../src/main/hooks-command');
const { createCliKeyStore } = require('../src/main/keychain-cli');
const { DEFAULTS } = require('../src/main/config');

const OPENAI = 'sk-test-openai-0123456789abcdef';
const GROQ = 'gsk_test_groq_plain_value_42';
const MISTRAL = 'mistral-test-key-777';

// A stand-in for Electron's safeStorage: reversible, and "enc:" values do not show the key as a substring
const electronEncrypt = (text) => Buffer.from([...text].reverse().join('') + '#e');
const electronDecrypt = (buf) => [...buf.toString().slice(0, -2)].reverse().join('');
const enc = (text) => `enc:${electronEncrypt(text).toString('base64')}`;

function tmp(t, prefix = 'capri-mig-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); // only the directory made above
  return dir;
}

// an in-memory stand-in for the key store (keychain-cli.js)
function memoryStore(initial = null) {
  const store = {
    service: 'capri.desktop.test.unit', value: initial, sets: 0, gets: 0, broken: false, forgetful: false,
    async get() { store.gets++; if (store.broken) throw new Error('no store'); return store.value; },
    async set(v) { if (store.broken) throw new Error('no store'); store.sets++; if (!store.forgetful) store.value = v; },
  };
  return store;
}

function electronProfile(t, { extra = {} } = {}) {
  const dir = tmp(t, 'capri-electron-');
  fs.mkdirSync(path.join(dir, 'sounds'));
  fs.mkdirSync(path.join(dir, 'Cache'));
  fs.writeFileSync(path.join(dir, 'Cache', 'data_0'), 'chromium junk');
  fs.writeFileSync(path.join(dir, 'Cookies'), 'junk');
  fs.writeFileSync(path.join(dir, 'sounds', 'hello.mp3'), Buffer.from('mp3-bytes'));
  fs.writeFileSync(path.join(dir, 'sounds', 'beep.wav'), Buffer.from('wav-bytes'));
  fs.writeFileSync(path.join(dir, 'sounds', 'notes.txt'), 'not a sound');
  fs.mkdirSync(path.join(dir, 'sounds', 'nested'));
  fs.writeFileSync(path.join(dir, 'sounds', 'nested', 'deep.mp3'), 'deep');
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], claude: { session: 'abc' } }));
  const config = {
    scale: 0.8, lang: 'ru', muted: true, welcomed: true, provider: 'openai', userName: 'Max', persona: 'dry',
    memories: ['likes tea'], myLines: ['yo'], render: 'software', displayId: 4,
    reminders: [{ id: 1, at: 1893456000000, text: 'call', made: 1 }], bond: { xp: 120, first: 1, last: 2, days: 3, streak: 2, caps: {} },
    apiKeys: { openai: enc(OPENAI), mistral: enc(MISTRAL), groq: GROQ },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return { dir, config };
}

function tree(dir, base = dir, out = {}) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (st.isDirectory()) tree(file, base, out);
    else out[path.relative(base, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}

const masterOf = (store) => Buffer.from(store.value, 'base64');

// the Tauri platform: the fake one, with kc: secrets under the master key of `store`
function tauriPlatform(userData, store, { up = true, home } = {}) {
  const master = store.value ? masterOf(store) : crypto.randomBytes(32);
  const platform = createFakePlatform({
    userData,
    overrides: {
      secrets: {
        prefix: 'kc',
        isAvailable: () => up,
        encrypt: (text) => sealWith(master, text),
        decrypt: (buf) => openWith(master, buf),
      },
    },
  });
  if (home) platform.state.paths.home = home;
  return platform;
}

const ENV = (profile) => ({ CAPRI_ELECTRON_USER_DATA: profile, CAPRI_USER_DATA: '1' });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function prepared(t, opts = {}) {
  const profile = electronProfile(t, opts);
  const store = memoryStore();
  const result = await prepareTauriMigration({
    userData: profile.dir, apiKeys: profile.config.apiKeys, decrypt: electronDecrypt, canDecrypt: true, store, autostart: opts.autostart ?? true,
  });
  return { ...profile, store, result };
}

// ---------- where the profile is ----------

test('the Electron profile is looked for where each system keeps it, the productName first', () => {
  const p = (platform, env = {}) => migrate.electronProfiles({ platform, env, home: '/h' });
  assert.deepEqual(p('darwin'), ['/h/Library/Application Support/Capri', '/h/Library/Application Support/capri-desktop']);
  assert.deepEqual(p('linux'), ['/h/.config/Capri', '/h/.config/capri-desktop']);
  assert.deepEqual(p('linux', { XDG_CONFIG_HOME: '/x' }), ['/x/Capri', '/x/capri-desktop']);
  assert.deepEqual(p('win32', { APPDATA: 'C:\\A' }).map((s) => s.replace(/\\/g, '/')), ['C:\\A/Capri'.replace(/\\/g, '/'), 'C:\\A/capri-desktop'.replace(/\\/g, '/')]);
  assert.deepEqual(p('darwin', { CAPRI_ELECTRON_USER_DATA: '/t/e' }), ['/t/e']);
  assert.deepEqual(migrate.electronProfiles({ platform: 'darwin', env: {} }), []);
});

// ---------- the Electron half ----------

test('prepare: the keys are sealed in the Tauri format, no plain key anywhere, Electron files untouched', async (t) => {
  const profile = electronProfile(t);
  const before = tree(profile.dir);
  const store = memoryStore();
  const r = await prepareTauriMigration({ userData: profile.dir, apiKeys: profile.config.apiKeys, decrypt: electronDecrypt, store, autostart: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys.sort(), ['mistral', 'openai']);
  const after = tree(profile.dir);
  const added = Object.keys(after).filter((k) => !(k in before));
  assert.deepEqual(added, ['tauri-keys.json']); // the only new file
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} unchanged`);
  const text = fs.readFileSync(path.join(profile.dir, 'tauri-keys.json'), 'utf8');
  for (const secret of [OPENAI, MISTRAL, store.value]) assert.ok(!text.includes(secret), 'no plain value in the manifest');
  const manifest = JSON.parse(text);
  assert.equal(manifest.autostart, true);
  assert.match(manifest.keys.openai, /^kc:/);
  assert.equal(openWith(masterOf(store), Buffer.from(manifest.keys.openai.slice(3), 'base64')), OPENAI);
  assert.equal(manifest.sources.openai, sha256(profile.config.apiKeys.openai));
  assert.equal(manifest.keys.groq, undefined, 'a plain key is not in the manifest (it is sealed on import)');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(profile.dir, 'tauri-keys.json')).mode & 0o077, 0, 'owner only');
});

test('prepare: run again changes nothing and does not touch the store; an existing master key is reused', async (t) => {
  const profile = electronProfile(t);
  const existing = crypto.randomBytes(32).toString('base64');
  const store = memoryStore(existing);
  const r1 = await prepareTauriMigration({ userData: profile.dir, apiKeys: profile.config.apiKeys, decrypt: electronDecrypt, store });
  assert.equal(r1.wrote, true);
  assert.equal(store.sets, 0, 'the key that was there is used, not replaced');
  const manifest = readJson(path.join(profile.dir, 'tauri-keys.json'));
  assert.equal(openWith(Buffer.from(existing, 'base64'), Buffer.from(manifest.keys.mistral.slice(3), 'base64')), MISTRAL);
  const gets = store.gets;
  const r2 = await prepareTauriMigration({ userData: profile.dir, apiKeys: profile.config.apiKeys, decrypt: electronDecrypt, store });
  assert.equal(r2.wrote, false);
  assert.equal(store.gets, gets);
  assert.deepEqual(readJson(path.join(profile.dir, 'tauri-keys.json')), manifest);
  // a changed key is sealed again
  const changed = { ...profile.config.apiKeys, openai: enc('sk-new-value') };
  const r3 = await prepareTauriMigration({ userData: profile.dir, apiKeys: changed, decrypt: electronDecrypt, store });
  assert.equal(r3.wrote, true);
});

test('prepare: a key store that fails, forgets or is missing writes no keys and says why; Electron is not harmed', async (t) => {
  for (const [name, store] of [['broken', Object.assign(memoryStore(), { broken: true })], ['forgetful', Object.assign(memoryStore(), { forgetful: true })], ['missing', null]]) {
    const profile = electronProfile(t);
    const before = tree(profile.dir);
    const r = await prepareTauriMigration({ userData: profile.dir, apiKeys: profile.config.apiKeys, decrypt: electronDecrypt, store, autostart: false });
    assert.equal(r.ok, false, name);
    assert.ok(r.skipped, name);
    const after = tree(profile.dir);
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${name}: ${k} unchanged`);
    const manifest = readJson(path.join(profile.dir, 'tauri-keys.json'));
    assert.deepEqual(manifest.keys, {}, name);
    assert.ok(manifest.keysSkipped, name);
    assert.ok(!fs.readFileSync(path.join(profile.dir, 'tauri-keys.json'), 'utf8').includes(OPENAI));
  }
  // safeStorage unavailable at that moment
  const profile = electronProfile(t);
  const r = await prepareTauriMigration({ userData: profile.dir, apiKeys: profile.config.apiKeys, decrypt: electronDecrypt, canDecrypt: false, store: memoryStore() });
  assert.equal(r.ok, false);
});

test('prepare: nothing to hand over (no enc: keys, login item off) writes nothing; a login item alone is handed over', async (t) => {
  const dir = tmp(t);
  const none = await prepareTauriMigration({ userData: dir, apiKeys: { groq: 'plain' }, decrypt: electronDecrypt, store: memoryStore(), autostart: false });
  assert.equal(none.ok, true);
  assert.deepEqual(fs.readdirSync(dir), []);
  const released = [];
  const only = await prepareTauriMigration({ userData: dir, apiKeys: {}, decrypt: electronDecrypt, store: memoryStore(), autostart: true, releaseAutostart: true, setAutostart: (on) => released.push(on) });
  assert.equal(only.ok, true);
  assert.equal(readJson(path.join(dir, 'tauri-keys.json')).autostart, true);
  assert.deepEqual(released, [false], 'the Electron login item is released only when asked, after the manifest is safe');
  const dir2 = tmp(t);
  const kept = [];
  await prepareTauriMigration({ userData: dir2, apiKeys: {}, decrypt: electronDecrypt, store: memoryStore(), autostart: true, setAutostart: (on) => kept.push(on) });
  assert.deepEqual(kept, [], 'by default Electron\'s login item stays');
});

// ---------- the whole way ----------

test('full scenario: config, memory, sounds, keys and the login item come over; Electron stays as it was', async (t) => {
  const e = await prepared(t);
  const electronBefore = tree(e.dir);
  const userData = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(userData, e.store);
  const log = [];
  const result = migrate.startMigration({ platform, env: ENV(e.dir), log: (m) => log.push(m), appVersion: '1.0.0', platformName: 'darwin' });

  assert.equal(result.status, 'imported');
  const cfg = readJson(path.join(userData, 'config.json'));
  assert.equal(cfg.lang, 'ru');
  assert.equal(cfg.userName, 'Max');
  assert.deepEqual(cfg.memories, ['likes tea']);
  assert.deepEqual(cfg.reminders, e.config.reminders);
  assert.deepEqual(cfg.bond, e.config.bond);
  assert.equal(cfg.render, undefined, 'the Chromium render mode is dropped');
  assert.equal(cfg.displayId, null, 'Electron\'s display id means nothing to the Tauri shell');
  // keys: kc: under the Tauri master key
  const open = (v) => openWith(masterOf(e.store), Buffer.from(v.slice(3), 'base64'));
  assert.equal(open(cfg.apiKeys.openai), OPENAI);
  assert.equal(open(cfg.apiKeys.mistral), MISTRAL);
  assert.equal(open(cfg.apiKeys.groq), GROQ, 'a plain key of Electron without safeStorage is sealed on the way');
  // memory and sounds
  assert.deepEqual(readJson(path.join(userData, 'memory.json')), readJson(path.join(e.dir, 'memory.json')));
  assert.equal(fs.readFileSync(path.join(userData, 'sounds', 'hello.mp3'), 'utf8'), 'mp3-bytes');
  assert.equal(fs.readFileSync(path.join(userData, 'sounds', 'beep.wav'), 'utf8'), 'wav-bytes');
  assert.ok(!fs.existsSync(path.join(userData, 'sounds', 'notes.txt')));
  assert.ok(!fs.existsSync(path.join(userData, 'sounds', 'nested')));
  assert.ok(!fs.existsSync(path.join(userData, 'Cache')) && !fs.existsSync(path.join(userData, 'Cookies')), 'Chromium\'s files stay behind');
  // the marker
  const marker = readJson(path.join(userData, migrate.MARKER));
  assert.equal(marker.version, 1);
  assert.equal(marker.app, '1.0.0');
  assert.equal(marker.source, e.dir);
  assert.deepEqual(marker.keys.lost, []);
  assert.deepEqual(marker.keys.moved.sort(), ['mistral', 'openai']);
  assert.ok(marker.copied.some((c) => c.name === 'config.json' && c.action === 'copied'));
  assert.equal(marker.autostart, 'enabled');
  // the login item: only by the platform's method, because Electron's was on
  assert.deepEqual(platform.calls.filter((c) => c.name === 'autostart.set').map((c) => c.args), [[true]]);
  // Electron's profile: byte for byte as before, except its own hand-over file, now gone
  const electronAfter = tree(e.dir);
  delete electronBefore['tauri-keys.json'];
  assert.deepEqual(electronAfter, electronBefore);
  // no plain key on disk in the new profile, nor in the log
  for (const [name] of Object.entries(tree(userData))) {
    const text = fs.readFileSync(path.join(userData, name), 'utf8');
    for (const secret of [OPENAI, MISTRAL, GROQ, e.store.value]) assert.ok(!text.includes(secret), `${name} holds no plain key`);
  }
  assert.ok(!log.join('\n').includes(OPENAI) && !log.join('\n').includes(GROQ));
});

test('second start: nothing is copied again, nothing the user changed since is overwritten', async (t) => {
  const e = await prepared(t);
  const userData = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(userData, e.store);
  assert.equal(migrate.startMigration({ platform, env: ENV(e.dir), log() {}, platformName: 'darwin' }).status, 'imported');
  // the user goes on in the new app
  const cfgFile = path.join(userData, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), userName: 'Changed', apiKeys: { openai: 'kc:mine' } }));
  fs.writeFileSync(path.join(userData, 'memory.json'), JSON.stringify({ history: [{ role: 'user', content: 'new' }] }));
  fs.unlinkSync(path.join(userData, 'sounds', 'beep.wav'));
  // the old app changes too (it must not matter)
  fs.writeFileSync(path.join(e.dir, 'config.json'), JSON.stringify({ userName: 'Old again' }));
  const snapshot = tree(userData);
  const calls = platform.calls.length;
  const again = migrate.startMigration({ platform, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(again.status, 'already');
  assert.deepEqual(tree(userData), snapshot);
  assert.equal(platform.calls.filter((c) => c.name === 'autostart.set').length, 1, 'the login item is not set again');
  assert.ok(platform.calls.length >= calls);
  assert.ok(!fs.existsSync(path.join(userData, 'sounds', 'beep.wav')), 'a sound the user removed does not come back');
});

test('a user\'s own newer data in the new profile is never overwritten, a pristine config is replaced with a copy kept', async (t) => {
  const e = await prepared(t);
  const store = e.store;
  // (a) the new profile has a config the user changed, and a memory
  const a = tmp(t, 'capri-tauri-');
  fs.writeFileSync(path.join(a, 'config.json'), JSON.stringify({ userName: 'Newer', lang: 'fr' }));
  fs.writeFileSync(path.join(a, 'memory.json'), '{"history":[]}');
  const ra = migrate.startMigration({ platform: tauriPlatform(a, store), env: ENV(e.dir), log() {}, platformName: 'linux' });
  assert.equal(ra.status, 'imported');
  assert.equal(readJson(path.join(a, 'config.json')).userName, 'Newer');
  assert.equal(readJson(path.join(a, 'config.json')).lang, 'fr');
  assert.equal(readJson(path.join(a, 'memory.json')).history.length, 0);
  assert.ok(ra.report.find((c) => c.name === 'config.json').action === 'kept');
  // a key for a provider that has none yet is still filled in, one that has a key is not replaced
  assert.equal(openWith(masterOf(store), Buffer.from(readJson(path.join(a, 'config.json')).apiKeys.openai.slice(3), 'base64')), OPENAI);
  // (b) a config Tauri wrote at an earlier start and nobody changed
  const e2 = await prepared(t);
  const b = tmp(t, 'capri-tauri-');
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ ...DEFAULTS, assistant: 'claude' }));
  const rb = migrate.startMigration({ platform: tauriPlatform(b, e2.store), env: ENV(e2.dir), log() {}, platformName: 'linux' });
  assert.equal(rb.status, 'imported');
  assert.equal(readJson(path.join(b, 'config.json')).userName, 'Max');
  assert.deepEqual(readJson(path.join(b, 'config.json.pre-migration')), { ...DEFAULTS, assistant: 'claude' });
});

test('no Electron profile: nothing happens and no marker is made', (t) => {
  const userData = tmp(t, 'capri-tauri-');
  const home = tmp(t, 'capri-home-');
  const platform = tauriPlatform(userData, memoryStore(), { home });
  assert.equal(migrate.startMigration({ platform, env: {}, log() {}, platformName: 'darwin' }).status, 'none');
  assert.deepEqual(fs.readdirSync(userData), []);
  // the folder is there but empty of anything Capri's
  const empty = tmp(t, 'capri-electron-');
  fs.writeFileSync(path.join(empty, 'Cookies'), 'x');
  assert.equal(migrate.startMigration({ platform, env: ENV(empty), log() {}, platformName: 'darwin' }).status, 'none');
});

test('the real Electron location is not looked at when another profile is chosen on purpose (CAPRI_USER_DATA), nor with CAPRI_NO_MIGRATE', async (t) => {
  const home = tmp(t, 'capri-home-');
  const dir = path.join(home, 'Library', 'Application Support', 'Capri');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"userName":"X"}');
  const userData = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(userData, memoryStore(), { home });
  assert.equal(migrate.runMigration({ platform, env: { CAPRI_USER_DATA: userData }, platformName: 'darwin' }).status, 'disabled');
  assert.equal(migrate.runMigration({ platform, env: { CAPRI_NO_MIGRATE: '1' }, platformName: 'darwin' }).status, 'disabled');
  assert.deepEqual(fs.readdirSync(userData), []);
  // the default way finds it
  assert.equal(migrate.runMigration({ platform, env: {}, platformName: 'darwin' }).status, 'imported');
});

test('a broken config, a broken memory, a missing sounds folder: skipped and noted, the start goes on', (t) => {
  const e = tmp(t, 'capri-electron-');
  fs.writeFileSync(path.join(e, 'config.json'), '{"scale": 0.7, broken');
  fs.writeFileSync(path.join(e, 'memory.json'), 'not json at all');
  const userData = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(userData, memoryStore());
  const r = migrate.startMigration({ platform, env: ENV(e), log() {}, platformName: 'linux' });
  assert.equal(r.status, 'imported');
  assert.match(r.report.find((c) => c.name === 'config.json').reason, /unreadable/);
  assert.equal(r.report.find((c) => c.name === 'memory.json').action, 'skipped');
  assert.equal(r.report.find((c) => c.name === 'sounds/').action, 'absent');
  assert.ok(!fs.existsSync(path.join(userData, 'config.json')), 'a config nobody can read is not copied');
  assert.ok(fs.existsSync(path.join(userData, migrate.MARKER)));
  // a config that is JSON but not an object
  const e2 = tmp(t, 'capri-electron-');
  fs.writeFileSync(path.join(e2, 'config.json'), '[1,2]');
  const u2 = tmp(t, 'capri-tauri-');
  assert.equal(migrate.startMigration({ platform: tauriPlatform(u2, memoryStore()), env: ENV(e2), log() {}, platformName: 'linux' }).status, 'imported');
  // symlinks in sounds are not followed
  if (process.platform !== 'win32') {
    const e3 = tmp(t, 'capri-electron-');
    fs.mkdirSync(path.join(e3, 'sounds'));
    const secret = path.join(e3, 'secret.txt');
    fs.writeFileSync(secret, 'private');
    fs.symlinkSync(secret, path.join(e3, 'sounds', 'link.mp3'));
    const u3 = tmp(t, 'capri-tauri-');
    migrate.startMigration({ platform: tauriPlatform(u3, memoryStore()), env: ENV(e3), log() {}, platformName: 'linux' });
    assert.ok(!fs.existsSync(path.join(u3, 'sounds', 'link.mp3')));
  }
});

test('a copy that fails half way leaves no partial file and no marker; the next start finishes it without duplicating', async (t) => {
  const e = await prepared(t);
  const userData = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(userData, e.store);
  let failures = 1;
  const flaky = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (from, to) => {
          if (String(to).endsWith('memory.json') && failures-- > 0) throw Object.assign(new Error('simulated: disk full'), { code: 'ENOSPC' });
          return target.renameSync(from, to);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const first = migrate.startMigration({ platform, env: ENV(e.dir), log() {}, platformName: 'darwin', fsx: flaky });
  assert.equal(first.status, 'partial');
  assert.ok(!fs.existsSync(path.join(userData, migrate.MARKER)), 'no marker: it will be tried again');
  assert.ok(!fs.existsSync(path.join(userData, 'memory.json')));
  assert.deepEqual(fs.readdirSync(userData).filter((n) => n.includes('.tmp-')), [], 'no temporary left');
  assert.ok(fs.existsSync(path.join(userData, 'config.json')), 'what went well stays');
  assert.equal(platform.calls.filter((c) => c.name === 'autostart.set').length, 0, 'the login item waits for the import to be whole');
  const cfg = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
  const second = migrate.startMigration({ platform, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(second.status, 'imported');
  assert.equal(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'), cfg, 'config not written again');
  assert.ok(fs.existsSync(path.join(userData, 'memory.json')));
  assert.equal(platform.calls.filter((c) => c.name === 'autostart.set').length, 1);
  assert.deepEqual(fs.readdirSync(userData).filter((n) => n.includes('.tmp-')), []);
  const keys = readJson(path.join(userData, 'config.json')).apiKeys;
  assert.equal(openWith(masterOf(e.store), Buffer.from(keys.openai.slice(3), 'base64')), OPENAI, 'the keys survived the retry');
});

// ---------- keys that cannot come over ----------

test('keys that did not come over are left empty and named; never taken as plain keys', async (t) => {
  // (1) no manifest at all (Electron never prepared them)
  const e = electronProfile(t);
  const u = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(u, memoryStore(crypto.randomBytes(32).toString('base64')));
  const r = migrate.startMigration({ platform, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(r.status, 'imported');
  assert.deepEqual(r.keys.lost.sort(), ['mistral', 'openai']);
  const cfg = readJson(path.join(u, 'config.json'));
  assert.equal(cfg.apiKeys.openai, undefined);
  assert.equal(cfg.apiKeys.mistral, undefined);
  assert.ok(cfg.apiKeys.groq.startsWith('kc:'), 'the plain one is still carried (sealed)');
  assert.ok(!fs.readFileSync(path.join(u, 'config.json'), 'utf8').includes('enc:'), 'no Electron ciphertext is carried over either');
  assert.deepEqual(readJson(path.join(u, migrate.MARKER)).keys.lost.sort(), ['mistral', 'openai']);

  // (2) a manifest sealed under another master key, and one made from an older value of the key
  const e2 = await prepared(t);
  const u2 = tmp(t, 'capri-tauri-');
  const other = memoryStore(crypto.randomBytes(32).toString('base64'));
  const r2 = migrate.startMigration({ platform: tauriPlatform(u2, other), env: ENV(e2.dir), log() {}, platformName: 'darwin' });
  assert.deepEqual(r2.keys.lost.sort(), ['mistral', 'openai']);
  const e3 = await prepared(t);
  const cfg3 = readJson(path.join(e3.dir, 'config.json'));
  fs.writeFileSync(path.join(e3.dir, 'config.json'), JSON.stringify({ ...cfg3, apiKeys: { ...cfg3.apiKeys, openai: enc('a newer key typed after the hand-over') } }));
  const u3 = tmp(t, 'capri-tauri-');
  const r3 = migrate.startMigration({ platform: tauriPlatform(u3, e3.store), env: ENV(e3.dir), log() {}, platformName: 'darwin' });
  assert.deepEqual(r3.keys.lost, ['openai'], 'a stale hand-over is not trusted');
  assert.deepEqual(r3.keys.moved, ['mistral']);

  // (3) Electron could not seal them (its key store failed): the manifest says so, the keys are empty
  const e4 = electronProfile(t);
  await prepareTauriMigration({ userData: e4.dir, apiKeys: e4.config.apiKeys, decrypt: electronDecrypt, store: Object.assign(memoryStore(), { broken: true }) });
  const u4 = tmp(t, 'capri-tauri-');
  const r4 = migrate.startMigration({ platform: tauriPlatform(u4, memoryStore(crypto.randomBytes(32).toString('base64'))), env: ENV(e4.dir), log() {}, platformName: 'darwin' });
  assert.deepEqual(r4.keys.lost.sort(), ['mistral', 'openai']);
});

test('the key store is down at that start: the sealed keys wait, and arrive at the next start', async (t) => {
  const e = await prepared(t);
  const u = tmp(t, 'capri-tauri-');
  const down = tauriPlatform(u, e.store, { up: false });
  const r1 = migrate.startMigration({ platform: down, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(r1.status, 'imported');
  assert.equal(r1.keys.pending, true);
  assert.ok(fs.existsSync(path.join(e.dir, 'tauri-keys.json')), 'the hand-over file waits');
  assert.equal(readJson(path.join(u, 'config.json')).apiKeys.openai, undefined);
  const up = tauriPlatform(u, e.store, { up: true });
  const r2 = migrate.startMigration({ platform: up, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(r2.status, 'already');
  assert.deepEqual(r2.keys.moved.sort(), ['mistral', 'openai']);
  assert.deepEqual(r2.keys.lost, []);
  assert.ok(!fs.existsSync(path.join(e.dir, 'tauri-keys.json')), 'used up: removed');
  assert.equal(openWith(masterOf(e.store), Buffer.from(readJson(path.join(u, 'config.json')).apiKeys.openai.slice(3), 'base64')), OPENAI);
  assert.deepEqual(readJson(path.join(u, migrate.MARKER)).keys.lost, []);
});

test('a key the user entered in the new app meanwhile is not replaced by the carried one', async (t) => {
  const e = await prepared(t);
  const u = tmp(t, 'capri-tauri-');
  const down = tauriPlatform(u, e.store, { up: false });
  migrate.startMigration({ platform: down, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  const file = path.join(u, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), apiKeys: { openai: 'kc:typed-by-the-user' } }));
  migrate.startMigration({ platform: tauriPlatform(u, e.store), env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(readJson(file).apiKeys.openai, 'kc:typed-by-the-user');
  assert.match(readJson(file).apiKeys.mistral, /^kc:/);
});

// ---------- login item ----------

test('the login item: set only when Electron\'s was on, only where there is one, never when it already is', () => {
  const calls = [];
  const platform = { autostart: { isEnabled: () => false, set: (on) => calls.push(on) } };
  assert.equal(migrate.migrateAutostart({ platform, wanted: true, platformName: 'darwin' }), 'enabled');
  assert.equal(migrate.migrateAutostart({ platform, wanted: true, platformName: 'win32' }), 'enabled');
  assert.equal(migrate.migrateAutostart({ platform, wanted: true, platformName: 'linux' }), 'unsupported');
  assert.equal(migrate.migrateAutostart({ platform, wanted: false, platformName: 'darwin' }), 'was-off');
  assert.equal(migrate.migrateAutostart({ platform, wanted: null, platformName: 'darwin' }), 'unknown');
  assert.deepEqual(calls, [true, true]);
  const on = { autostart: { isEnabled: () => true, set: () => assert.fail('already on') } };
  assert.equal(migrate.migrateAutostart({ platform: on, wanted: true, platformName: 'darwin' }), 'already-on');
  const bad = { autostart: { isEnabled: () => false, set: () => { throw new Error('refused'); } } };
  assert.equal(migrate.migrateAutostart({ platform: bad, wanted: true, platformName: 'darwin', log() {} }), 'failed');
});

test('login item off in the manifest: the Tauri build does not turn it on', async (t) => {
  const e = await prepared(t, { autostart: false });
  const u = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(u, e.store);
  migrate.startMigration({ platform, env: ENV(e.dir), log() {}, platformName: 'darwin' });
  assert.equal(platform.calls.filter((c) => c.name === 'autostart.set').length, 0);
  assert.equal(readJson(path.join(u, migrate.MARKER)).autostart, 'was-off');
});

// ---------- hooks ----------

const OLD_ELECTRON = 'ELECTRON_RUN_AS_NODE=1 "/Applications/Capri.app/Contents/MacOS/Capri" "/Applications/Capri.app/Contents/Resources/app.asar.unpacked/hooks/capri-hook.js"';
const OLD_CODEX = 'node "/old/place/hooks/capri-codex-hook.js"';

function hooksSandbox(t) {
  const dir = tmp(t, 'capri-hooks-');
  const bin = path.join(dir, 'res', 'bin', hc.BIN_NAME);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  const env = {
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), AGY_CONFIG_DIR: path.join(dir, 'agy'),
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const claudeFile = require('../scripts/install-hooks').status().file;
  const codexFile = require('../scripts/install-codex-hooks').status().file;
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  const mine = { type: 'command', command: 'echo mine capri-hook-notes' };
  fs.writeFileSync(claudeFile, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [mine, { type: 'command', command: OLD_ELECTRON, async: true }] }] } }));
  fs.writeFileSync(codexFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: OLD_CODEX, timeout: 3 }] }] } }));
  return { dir, bin, claudeFile, codexFile, mine, env };
}

const commandsIn = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((v) => commandsIn(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') out.push(value.command);
    Object.values(value).forEach((v) => commandsIn(v, out));
  }
  return out;
};

test('hooks: old Electron/Node entries become capri-hook on the first Tauri start, the user\'s own are untouched, and it is idempotent', async (t) => {
  const h = hooksSandbox(t);
  const e = await prepared(t);
  const u = tmp(t, 'capri-tauri-');
  const platform = tauriPlatform(u, e.store);
  platform.state.paths.resources = path.join(h.dir, 'res');
  const env = { ...ENV(e.dir), CAPRI_HOOK_BIN: h.bin };
  const r = migrate.startMigration({ platform, env, log() {}, platformName: 'darwin' });
  assert.equal(r.status, 'imported');
  assert.equal(r.hooks.bin, h.bin);
  assert.deepEqual(r.hooks.migrated, { claude: 1, codex: 1, agy: 0 });
  const claude = readJson(h.claudeFile);
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.hooks.Stop[0].hooks[0], h.mine);
  assert.equal(claude.hooks.Stop[0].hooks[1].command, hc.binCommand('claude', undefined, h.bin));
  assert.equal(readJson(h.codexFile).hooks.Stop[0].hooks[0].command, hc.binCommand('codex', undefined, h.bin));
  assert.ok(!fs.existsSync(path.join(path.dirname(h.codexFile), 'none')));
  assert.equal(fs.readdirSync(path.dirname(h.claudeFile)).filter((n) => n.includes('.capri-backup-')).length, 1);
  assert.deepEqual(readJson(path.join(u, migrate.MARKER)).hooks, { bin: h.bin, migrated: { claude: 1, codex: 1, agy: 0 } });
  // no agy file was created
  assert.ok(!fs.existsSync(require('../scripts/install-hooks-agy').status().file));
  // second start: no change, no new backup
  const before = [h.claudeFile, h.codexFile].map((f) => fs.readFileSync(f, 'utf8'));
  const again = migrate.startMigration({ platform, env, log() {}, platformName: 'darwin' });
  assert.equal(again.status, 'already');
  assert.deepEqual(again.hooks.migrated, { claude: 0, codex: 0, agy: 0 });
  assert.deepEqual([h.claudeFile, h.codexFile].map((f) => fs.readFileSync(f, 'utf8')), before);
  assert.equal(fs.readdirSync(path.dirname(h.claudeFile)).filter((n) => n.includes('.capri-backup-')).length, 1);
});

test('hooks: without the capri-hook binary nothing is touched; a fresh profile with no Capri hooks installed gets none', async (t) => {
  const h = hooksSandbox(t);
  const before = [h.claudeFile, h.codexFile].map((f) => fs.readFileSync(f, 'utf8'));
  const e = electronProfile(t);
  const u = tmp(t, 'capri-tauri-');
  const r = migrate.startMigration({ platform: tauriPlatform(u, memoryStore()), env: { ...ENV(e.dir), CAPRI_HOOK_BIN: path.join(h.dir, 'nope') }, log() {}, platformName: 'darwin' });
  assert.equal(r.hooks.bin, null);
  assert.deepEqual([h.claudeFile, h.codexFile].map((f) => fs.readFileSync(f, 'utf8')), before);
  // binary there, but only the user's own hooks in the settings
  fs.writeFileSync(h.claudeFile, JSON.stringify({ hooks: { Stop: [{ hooks: [h.mine] }] } }));
  fs.writeFileSync(h.codexFile, '{broken');
  const u2 = tmp(t, 'capri-tauri-');
  const e2 = electronProfile(t);
  migrate.startMigration({ platform: tauriPlatform(u2, memoryStore()), env: { ...ENV(e2.dir), CAPRI_HOOK_BIN: h.bin }, log() {}, platformName: 'darwin' });
  assert.deepEqual(readJson(h.claudeFile), { hooks: { Stop: [{ hooks: [h.mine] }] } });
  assert.equal(fs.readFileSync(h.codexFile, 'utf8'), '{broken');
  assert.deepEqual(fs.readdirSync(path.dirname(h.claudeFile)).filter((n) => n.includes('.capri-backup-')), []);
});

test('hooks: the way back puts the Node/Electron commands again, leaves the user\'s own, and is idempotent', async (t) => {
  const h = hooksSandbox(t);
  const { revertHooks, migrateHooks } = require('../src/main/assistants');
  migrateHooks(h.bin);
  assert.ok(commandsIn(readJson(h.claudeFile)).includes(hc.binCommand('claude', undefined, h.bin)));
  const back = revertHooks();
  assert.deepEqual([back.claude.reverted, back.codex.reverted, back.agy.reverted], [1, 1, 0]);
  const claude = readJson(h.claudeFile);
  assert.deepEqual(claude.hooks.Stop[0].hooks[0], h.mine);
  const claudeCmd = claude.hooks.Stop[0].hooks[1].command;
  assert.match(claudeCmd, /capri-hook\.js/);
  assert.doesNotMatch(claudeCmd, /--assistant/);
  assert.equal(hc.classify(claudeCmd).assistant, 'claude');
  assert.equal(hc.isLegacyCommand(claudeCmd), true);
  const codexCmd = readJson(h.codexFile).hooks.Stop[0].hooks[0].command;
  assert.match(codexCmd, /^node ".*capri-codex-hook\.js"$/);
  assert.equal(hc.isLegacyCommand(codexCmd), true);
  const snapshot = [h.claudeFile, h.codexFile].map((f) => fs.readFileSync(f, 'utf8'));
  assert.deepEqual([revertHooks().claude.reverted, revertHooks().codex.reverted], [0, 0]);
  assert.deepEqual([h.claudeFile, h.codexFile].map((f) => fs.readFileSync(f, 'utf8')), snapshot);
  // and forward again: the migration is repeatable
  assert.equal(migrateHooks(h.bin).claude.migrated, 1);
  // install-hooks (Electron, no binary) also returns the Electron/Node command, without duplicates
  const saved = process.env.CAPRI_HOOK_BIN;
  delete process.env.CAPRI_HOOK_BIN;
  t.after(() => { if (saved) process.env.CAPRI_HOOK_BIN = saved; });
  require('../scripts/install-hooks').install();
  const cmds = [...new Set(commandsIn(readJson(h.claudeFile)).filter((c) => hc.classify(c)))];
  assert.equal(cmds.length, 1);
  assert.equal(hc.isLegacyCommand(cmds[0]), true);
});

// ---------- the key store tools ----------

test('keychain-cli: the commands are files and argument arrays, the key goes on stdin, the service can be a test one', async () => {
  const calls = [];
  const exec = (code = 0, stdout = '', stderr = '') => async (file, args, opts) => { calls.push({ file, args, input: opts?.input }); return { code, stdout, stderr }; };
  const env = { CAPRI_KEYCHAIN_SERVICE: 'capri.desktop.test.abc' };
  const key = Buffer.alloc(32, 5).toString('base64');

  const mac = createCliKeyStore({ platform: 'darwin', env, exec: exec(0, `${key}\n`) });
  assert.equal(await mac.get(), key);
  assert.deepEqual(calls[0], { file: 'security', args: ['find-generic-password', '-s', 'capri.desktop.test.abc', '-a', 'master-key', '-w'], input: undefined });
  assert.equal(await createCliKeyStore({ platform: 'darwin', env, exec: exec(44) }).get(), null);
  await mac.set(key);
  const set = calls.at(-1);
  assert.deepEqual(set.args, ['-i']);
  assert.equal(set.input, `add-generic-password -s capri.desktop.test.abc -a master-key -w ${key}\n`);
  assert.ok(!JSON.stringify(set.args).includes(key), 'the key is not an argument');
  await createCliKeyStore({ platform: 'darwin', env: { ...env, CAPRI_KEYCHAIN_OPEN_ACL: '1' }, exec: exec() }).set(key);
  assert.match(calls.at(-1).input, / -A /);
  await assert.rejects(createCliKeyStore({ platform: 'darwin', env, exec: exec(0, '', 'security: SecKeychainItemCreateFromContent: failed') }).set(key));
  await assert.rejects(mac.set('not base64; rm -rf /'));
  assert.equal(createCliKeyStore({ platform: 'darwin', env: {}, exec: exec() }).service, 'capri.desktop');

  const linux = createCliKeyStore({ platform: 'linux', env, exec: exec(0, key) });
  assert.equal(await linux.get(), key);
  assert.deepEqual(calls.at(-1).args, ['lookup', 'service', 'capri.desktop.test.abc', 'username', 'master-key', 'target', 'default', 'application', 'rust-keyring']);
  await linux.set(key);
  assert.equal(calls.at(-1).file, 'secret-tool');
  assert.equal(calls.at(-1).input, key);
  assert.ok(!JSON.stringify(calls.at(-1).args).includes(key));
  assert.equal(await createCliKeyStore({ platform: 'linux', env, exec: exec(1) }).get(), null);

  const win = createCliKeyStore({ platform: 'win32', env, exec: exec(0, 'Target: LegacyGeneric:target=master-key.capri.desktop.test.abc') });
  await assert.rejects(win.get(), { code: 'unreadable' }); // cmdkey cannot read: an item that is there is never overwritten
  assert.equal(await createCliKeyStore({ platform: 'win32', env, exec: exec(1) }).get(), null);
  await createCliKeyStore({ platform: 'win32', env, exec: exec() }).set(key);
  assert.deepEqual(calls.at(-1).args, ['/generic:master-key.capri.desktop.test.abc', '/user:master-key', `/pass:${key}`]);
  assert.equal(createCliKeyStore({ platform: 'freebsd', env, exec: exec() }), null);
});

// ---------- what she tells the user ----------

test('the core tells her pages once which keys did not come over; five languages have the words', async () => {
  const { createCore } = require('../src/main/core');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-core-'));
  try {
    const platform = createFakePlatform({ userData });
    let shown = 0;
    const core = createCore({ platform, smoke: true, watchWindows: () => ({ stop() {}, refresh() {} }), migration: { keysLost: ['openai', 'groq'], noticeDue: () => true, noticeShown: () => { shown++; } } });
    core.config.save({ apiKeys: { groq: 'kc:already-entered' } });
    const first = core.ipc.handle['config:get']();
    assert.deepEqual(first.keysLost, ['OpenAI'], 'only the keys still missing, by name');
    assert.equal(shown, 1);
    assert.equal(core.ipc.handle['config:get']().keysLost, undefined, 'once per launch');
    assert.equal(JSON.stringify(first).includes('kc:already-entered'), false, 'the keys never reach her pages');
    const none = createCore({ platform, smoke: true, watchWindows: () => ({ stop() {}, refresh() {} }), migration: { keysLost: ['openai'], noticeDue: () => false, noticeShown() {} } });
    assert.equal(none.ipc.handle['config:get']().keysLost, undefined, 'after three launches she stops');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
  const { pathToFileURL } = require('node:url');
  const { LINES } = await import(pathToFileURL(path.resolve(__dirname, '../src/renderer/js/lines.js')).href);
  assert.deepEqual(Object.keys(LINES).sort(), ['en', 'es', 'fr', 'pt', 'ru']);
  for (const [lang, t] of Object.entries(LINES)) {
    assert.ok(Array.isArray(t.keysLost) && t.keysLost.length, lang);
    for (const line of t.keysLost) assert.match(line, /\{providers\}/, lang);
  }
});
