'use strict';
// CAPRI-04: what the settings window may change, how it's saved, what it never sees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('../src/main/config');
const { createFakePlatform } = require('../src/main/platform/fake');

// config.js asks the platform for its folder: a stand-in pointing at a temporary one, set per test
let userData = null;
const config = createConfig({ platform: createFakePlatform({ overrides: { paths: { get: () => userData } } }) });
const { checkPatch, toConfig, checkKey, resetPatch, RESET_KEYS } = require('../src/main/settings-patch');
const { settingsView } = require('../src/main/settings-view');
const { LANGS, SETTINGS, TRAY } = require('../src/main/labels');

const ctx = (extra = {}) => ({
  langs: LANGS,
  providers: ['ollama', 'openai', 'custom'],
  assistants: ['claude', 'codex'],
  models: ['llama3.2', 'gemma3:4b'],
  displays: [1, 2],
  features: { windowTracking: false, autostart: true },
  ...extra,
});

const made = [];
function freshProfile(content) {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-settings-'));
  made.push(userData);
  if (content !== undefined) fs.writeFileSync(path.join(userData, 'config.json'), content);
  config.load(true);
  return userData;
}

test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test('patches: known keys with the right types and values pass', () => {
  const res = checkPatch({ lang: 'ru', scale: 0.8, muted: true, volume: 0.35, motion: 'reduced', rest: 'taskbar', render: 'gl' }, ctx());
  assert.equal(res.ok, true);
  assert.deepEqual(res.values, { lang: 'ru', scale: 0.8, muted: true, volume: 0.35, motion: 'reduced', rest: 'taskbar', render: 'gl' });
  assert.equal(checkPatch({ lang: 'auto' }, ctx()).ok, true);
  assert.equal(checkPatch({ displayId: 2 }, ctx()).ok, true);
  assert.equal(checkPatch({ assistant: 'none' }, ctx()).ok, true);
  assert.equal(checkPatch({ chatModel: 'gemma3:4b' }, ctx()).ok, true);
  assert.equal(checkPatch({ customUrl: 'http://127.0.0.1:1234/v1' }, ctx()).ok, true);
  assert.equal(checkPatch({ customUrl: '' }, ctx()).ok, true);
  assert.equal(checkPatch({ autostart: false }, ctx()).ok, true);
});

test('patches: anything else is refused, key by key', () => {
  const bad = (patch, extra) => checkPatch(patch, ctx(extra)).fields;
  // not something the window may write: keys, memories, hooks, her bond...
  assert.deepEqual(bad({ apiKeys: { openai: 'x' } }), { apiKeys: 'unknown' });
  assert.deepEqual(bad({ memories: [] }), { memories: 'unknown' });
  assert.deepEqual(bad({ bond: null, reminders: [] }), { bond: 'unknown', reminders: 'unknown' });
  assert.deepEqual(bad({ __proto__: { muted: true } }), { '': 'range' }); // no own keys
  // wrong types and values
  assert.deepEqual(bad({ muted: 'yes' }), { muted: 'type' });
  assert.deepEqual(bad({ volume: 2 }), { volume: 'range' });
  assert.deepEqual(bad({ volume: Number.NaN }), { volume: 'type' });
  assert.deepEqual(bad({ scale: 5 }), { scale: 'range' });
  assert.deepEqual(bad({ lang: 'de' }), { lang: 'choice' });
  assert.deepEqual(bad({ motion: 'wild' }), { motion: 'choice' });
  assert.deepEqual(bad({ displayId: 3 }), { displayId: 'choice' });
  assert.deepEqual(bad({ provider: 'skynet' }), { provider: 'choice' });
  assert.deepEqual(bad({ chatModel: 'gpt-9' }), { chatModel: 'choice' });
  assert.deepEqual(bad({ chatModel: 'llama3.2' }, { models: null }), { chatModel: 'choice' });
  assert.deepEqual(bad({ customUrl: 'file:///etc/passwd' }), { customUrl: 'url' });
  assert.deepEqual(bad({ customUrl: 'not a url' }), { customUrl: 'url' });
  // what this computer can't do
  assert.deepEqual(bad({ possess: true }), { possess: 'unsupported' });
  assert.equal(checkPatch({ possess: false }, ctx()).ok, true); // turning it off is always fine
  assert.deepEqual(bad({ autostart: true }, { features: { autostart: false } }), { autostart: 'unsupported' });
  // not a patch at all
  for (const input of [null, 'muted', [], 42, {}]) assert.equal(checkPatch(input, ctx()).ok, false);
  // one bad key refuses the whole patch: nothing half-saved
  assert.equal(checkPatch({ muted: true, volume: 9 }, ctx()).ok, false);
});

test('checked values -> config patch and side effects, as her menu does it', () => {
  assert.deepEqual(toConfig({ motion: 'full' }), { patch: { motion: 'full', motionAsked: true }, effects: {} });
  assert.deepEqual(toConfig({ volume: 0.333 }).patch, { volume: 0.33 });
  assert.deepEqual(toConfig({ assistant: 'none' }, { assistant: 'claude' }).patch, { claude: false });
  assert.deepEqual(toConfig({ assistant: 'claude' }, { assistant: 'claude' }), { patch: { claude: true, assistant: 'claude' }, effects: {} });
  assert.deepEqual(toConfig({ assistant: 'codex' }, { assistant: 'claude' }), {
    patch: { claude: true, assistant: 'codex', linked: false, welcomed: false }, effects: { assistantChanged: true },
  });
  // not config keys: done by main (the system's login items, her walk to a screen, her asking first)
  assert.deepEqual(toConfig({ autostart: true, displayId: 2, watchScreen: true }), { patch: {}, effects: { autostart: true, screen: 2, watchScreen: true } });
});

test('a new API key: only for providers that take one, checked, never echoed', () => {
  const keyed = ['openai', 'groq'];
  assert.deepEqual(checkKey('openai', '  sk-test-1234567890  ', keyed), { ok: true, key: 'sk-test-1234567890' });
  assert.deepEqual(checkKey('ollama', 'sk-test-1234567890', keyed), { ok: false, field: 'provider' });
  assert.deepEqual(checkKey('openai', '   ', keyed), { ok: false, field: 'empty' });
  assert.deepEqual(checkKey('openai', undefined, keyed), { ok: false, field: 'empty' });
  assert.deepEqual(checkKey('openai', 'short', keyed), { ok: false, field: 'format' });
  assert.deepEqual(checkKey('openai', 'sk test with spaces', keyed), { ok: false, field: 'format' });
  // a field error never carries the key
  assert.equal(JSON.stringify(checkKey('openai', 'sk test with spaces', keyed)).includes('spaces'), false);
});

test('reset: only its own keys, back to defaults; keys, hooks, memory and history untouched', () => {
  const patch = resetPatch(config.DEFAULTS);
  assert.deepEqual(Object.keys(patch), RESET_KEYS);
  for (const key of RESET_KEYS) assert.deepEqual(patch[key], config.DEFAULTS[key], key);
  for (const kept of ['apiKeys', 'provider', 'chatModel', 'customUrl', 'assistant', 'claude', 'claudeCwd', 'claudeMode',
    'userName', 'persona', 'myLines', 'memories', 'reminders', 'bond', 'welcomed', 'linked', 'lookAsked', 'motionAsked', 'render']) {
    assert.equal(kept in patch, false, kept);
  }
  // applied to a lived-in config
  freshProfile(JSON.stringify({ scale: 0.8, volume: 0.2, lang: 'ru', apiKeys: { openai: 'enc:abc' }, memories: ['cats'], provider: 'openai', bond: { xp: 400 } }));
  const after = config.commit(patch);
  assert.equal(after.scale, config.DEFAULTS.scale);
  assert.equal(after.volume, config.DEFAULTS.volume);
  assert.equal(after.lang, 'auto');
  assert.deepEqual(after.apiKeys, { openai: 'enc:abc' });
  assert.deepEqual(after.memories, ['cats']);
  assert.equal(after.provider, 'openai');
  assert.deepEqual(after.bond, { xp: 400 });
  // every reset key has a label in the window's description, in every language
  for (const code of LANGS) assert.ok(SETTINGS[code].resetWhat && SETTINGS[code].resetKeeps, code);
});

test('an old config without the newer settings reads with defaults, and the window shows it', () => {
  freshProfile(JSON.stringify({ scale: 0.45, muted: true, lang: 'fr' }));
  const cfg = config.load();
  assert.equal(cfg.scale, 0.45);
  assert.equal(cfg.volume, config.DEFAULTS.volume);
  assert.equal(cfg.motion, 'auto');
  assert.equal(cfg.pcReact, true);
  assert.equal(cfg.render, 'auto');
  // a config that isn't JSON anymore: defaults, no crash
  freshProfile('{ broken');
  assert.deepEqual(config.load(), config.DEFAULTS);
  const view = settingsView({ cfg: config.load(), lang: 'en', langSetting: 'auto', autoLang: 'en', features: {}, about: {} });
  assert.equal(view.sections.length, 4);
});

test('a config that can\'t be written: commit throws and changes nothing; save keeps the old behaviour', () => {
  freshProfile(JSON.stringify({ volume: 0.5 }));
  // a folder where the file should be: every write fails
  const file = path.join(userData, 'config.json');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => config.commit({ volume: 0.9 }), (err) => Boolean(err.code));
  assert.equal(config.load().volume, 0.5); // not shown as saved
  assert.equal(fs.readdirSync(userData).some((f) => f.endsWith('.tmp')), false); // nothing left behind
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.doesNotThrow(() => config.save({ volume: 0.9 }));
  } finally {
    console.error = original;
  }
  assert.equal(config.load().volume, 0.9);
  assert.equal(errors.length, 1);
  // written fine: on disk, whole
  fs.rmSync(file, { recursive: true });
  config.commit({ volume: 0.4 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).volume, 0.4);
});

test('the window\'s data carries no secret: only whether a key is saved', () => {
  const secret = 'sk-live-SECRET-0123456789';
  const view = settingsView({
    cfg: { ...config.DEFAULTS, provider: 'openai', apiKeys: { openai: secret, groq: `enc:${secret}` } },
    keys: { openai: true },
    envKeys: {},
    providers: [{ id: 'ollama', label: 'Ollama', keyed: false }, { id: 'openai', label: 'OpenAI', keyed: true }],
    lang: 'en', langSetting: 'auto', autoLang: 'en', features: {}, about: {},
  });
  const json = JSON.stringify(view);
  assert.equal(json.includes('SECRET'), false);
  assert.equal(json.includes('apiKeys'), false);
  const key = view.sections.find((s) => s.id === 'ai').rows.find((r) => r.id === 'apiKey');
  assert.deepEqual(key.control, { type: 'key', provider: 'openai', has: true, env: false });
  assert.equal(key.value, SETTINGS.en.keySet);
  assert.deepEqual(structuredClone(view), view);
});

test('controls: unsupported features disabled with the reason, a restart said honestly', () => {
  const facts = (extra) => ({
    cfg: { ...config.DEFAULTS, possess: true, render: 'gl' }, lang: 'en', langSetting: 'auto', autoLang: 'en',
    features: { windowTracking: false, autostart: false }, about: {}, renderNow: 'auto',
    screen: { index: 0, count: 1, width: 1512, height: 982 }, screens: [{ id: 7, width: 1512, height: 982 }], ...extra,
  });
  const rows = Object.fromEntries(settingsView(facts()).sections.flatMap((s) => s.rows).map((r) => [r.id, r]));
  assert.deepEqual([rows.possess.control.disabled, rows.possess.control.value, rows.possess.control.reason], [true, false, TRAY.en.unavailable]);
  assert.equal(rows.autostart.control.disabled, true);
  assert.equal(rows.screen.control.disabled, true); // only one screen
  assert.equal(rows.render.control.note, SETTINGS.en.restartNote);
  assert.deepEqual(rows.render.control.restart, { label: SETTINGS.en.restartNeeded, button: SETTINGS.en.restartNow });
  const same = Object.fromEntries(settingsView(facts({ renderNow: 'gl' })).sections.flatMap((s) => s.rows).map((r) => [r.id, r]));
  assert.equal('restart' in same.render.control, false);
  // every control sends a key settings-patch.js knows
  for (const r of Object.values(rows)) {
    if (r.control?.key) assert.notDeepEqual(checkPatch({ [r.control.key]: r.control.value }, ctx({ displays: [7] })).fields?.[r.control.key], 'unknown', r.id);
  }
});

test('patches: Object.prototype names are unknown keys, not a crash', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    // what a window could send (JSON.parse makes __proto__ an own key, as IPC's structured clone does)
    const input = JSON.parse(`{${JSON.stringify(key)}: "full"}`);
    assert.deepEqual(checkPatch(input, ctx()), { ok: false, fields: { [key]: 'unknown' } });
  }
  assert.deepEqual(checkPatch({ motion: 'full', constructor: 'auto' }, ctx()).fields, { constructor: 'unknown' });
  assert.deepEqual(checkPatch({ customUrl: 'javascript:alert(1)' }, ctx()).fields, { customUrl: 'url' });
  assert.deepEqual(checkPatch({ customUrl: `https://a.b/${'x'.repeat(3000)}` }, ctx()).fields, { customUrl: 'url' });
  assert.deepEqual(checkPatch({ scale: Infinity }, ctx()).fields, { scale: 'type' });
});

test('Windows: a config held open (rename refused) is still written, in place', () => {
  freshProfile(JSON.stringify({ volume: 0.5 }));
  const file = path.join(userData, 'config.json');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const rename = fs.renameSync;
  const busy = (code) => () => { throw Object.assign(new Error(code), { code }); };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fs.renameSync = busy('EPERM');
    config.commit({ volume: 0.9 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).volume, 0.9);
    assert.equal(config.load().volume, 0.9);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    // any other failure still throws, and changes nothing
    fs.renameSync = busy('ENOSPC');
    assert.throws(() => config.commit({ volume: 0.2 }), { code: 'ENOSPC' });
    assert.equal(config.load().volume, 0.9);
    // elsewhere a refused rename is a failure: no writing in place
    Object.defineProperty(process, 'platform', platform);
    fs.renameSync = busy('EPERM');
    assert.throws(() => config.commit({ volume: 0.2 }), { code: 'EPERM' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).volume, 0.9);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    fs.renameSync = rename;
  }
});

test('macOS app menu: Cmd+W / Cmd+M never reach the overlay; no default menu outside --dev elsewhere', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const menu = src.slice(src.indexOf('function appMenu()'), src.indexOf('function main()'));
  const dev = /\.\.\.\(DEV \? \[\{ label: 'Dev', submenu: \[\{ role: 'reload' \}, \{ role: 'toggleDevTools' \}\] \}\] : \[\]\)/;
  assert.doesNotMatch(menu.replace(dev, ''), /role: '(close|minimize|reload|forceReload|toggleDevTools)'/);
  assert.match(menu, /win !== overlay && win\.close\(\)/);
  assert.match(menu, /win !== overlay && win\.minimize\(\)/);
  assert.match(menu, dev);
  assert.match(src, /else if \(!DEV\) Menu\.setApplicationMenu\(null\)/);
});

// CAPRI-05: her initiative, picked in the window like her other choices
test('initiative: one of quiet, normal, active, saved as it is, reset to normal, in every language', () => {
  for (const level of ['quiet', 'normal', 'active']) {
    const res = checkPatch({ initiative: level }, ctx());
    assert.equal(res.ok, true, level);
    assert.deepEqual(toConfig(res.values, {}).patch, { initiative: level });
  }
  for (const v of ['loud', '', null, 1, true]) assert.deepEqual(checkPatch({ initiative: v }, ctx()).fields, { initiative: 'choice' });
  assert.equal(config.DEFAULTS.initiative, 'normal');
  assert.equal(resetPatch(config.DEFAULTS).initiative, 'normal');
  for (const code of LANGS) {
    assert.ok(SETTINGS[code].initiativeNote, code);
    for (const key of ['initiative', 'initiativeQuiet', 'initiativeNormal', 'initiativeActive']) assert.ok(TRAY[code][key], `${code} ${key}`);
    const r = settingsView({ cfg: { ...config.DEFAULTS, initiative: 'quiet' }, lang: code }).sections
      .find((s) => s.id === 'behavior').rows.find((x) => x.id === 'initiative');
    assert.equal(r.value, TRAY[code].initiativeQuiet);
    assert.deepEqual(r.control.options.map((o) => o.value), ['quiet', 'normal', 'active']);
    assert.equal(r.control.value, 'quiet');
    assert.equal(r.control.note, SETTINGS[code].initiativeNote);
  }
  // an old config without it, or with something unknown: shown as normal
  const r = settingsView({ cfg: { initiative: 'loud' }, lang: 'en' }).sections.find((s) => s.id === 'behavior').rows.find((x) => x.id === 'initiative');
  assert.equal(r.control.value, 'normal');
});

test('initiative: saved through commit and read back from a fresh profile', () => {
  freshProfile(JSON.stringify({ lang: 'en' }));
  assert.equal(config.load().initiative, 'normal'); // an old config without it
  config.commit(toConfig(checkPatch({ initiative: 'active' }, ctx()).values, config.load()).patch);
  assert.equal(config.load(true).initiative, 'active');
});
