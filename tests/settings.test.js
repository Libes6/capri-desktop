'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { settingsView, SECTIONS } = require('../src/main/settings-view');
const { TRAY, SETTINGS, LANGS } = require('../src/main/labels');
const { DEFAULTS } = require('../src/main/config');

const facts = (extra = {}) => ({
  cfg: { ...DEFAULTS },
  lang: 'en',
  langSetting: 'auto',
  autoLang: 'en',
  assistant: { id: 'claude', name: 'Claude Code' },
  hooksInstalled: true,
  provider: 'Ollama (local)',
  model: 'llama3.2',
  features: { autostart: true, windowTracking: false },
  autostart: false,
  screen: { index: 0, count: 2, width: 1512, height: 982 },
  about: { version: '0.1.0', platform: 'darwin', arch: 'arm64', runtime: 'tauri 2 / node 22' },
  ...extra,
});
const row = (view, section, id) => view.sections.find((s) => s.id === section).rows.find((r) => r.id === id);

test('the four sections, in order, each with rows; the note on her menu at the top of General', () => {
  const view = settingsView(facts());
  assert.deepEqual(view.sections.map((s) => s.id), SECTIONS);
  assert.deepEqual(SECTIONS, ['general', 'behavior', 'ai', 'about']);
  for (const s of view.sections) {
    assert.ok(s.rows.length > 0, s.id);
    for (const r of s.rows) assert.equal(typeof r.value, 'string', `${s.id}.${r.id}`);
  }
  assert.deepEqual(view.sections.map((s) => s.fromMenu), [true, false, false, false]);
});

test('every language has every settings text, and the menu item', () => {
  const keys = Object.keys(SETTINGS.en).sort();
  for (const code of LANGS) {
    assert.deepEqual(Object.keys(SETTINGS[code]).sort(), keys, code);
    for (const key of keys) assert.ok(SETTINGS[code][key], `${code}.${key}`);
    assert.ok(TRAY[code].settings, `${code} menu item`);
    const view = settingsView(facts({ lang: code }));
    assert.equal(view.title, SETTINGS[code].title);
    assert.equal(view.lang, code);
  }
});

test('the view is plain data: it crosses IPC as it is', () => {
  const view = settingsView(facts());
  assert.deepEqual(structuredClone(view), view);
  assert.equal(JSON.stringify(view).includes('apiKeys'), false);
});

test('language: Auto names the language it gives, a choice names itself', () => {
  assert.equal(row(settingsView(facts({ lang: 'ru', autoLang: 'ru' })), 'general', 'lang').value, 'Автоматически: русский');
  assert.equal(row(settingsView(facts({ langSetting: 'fr', lang: 'fr' })), 'general', 'lang').value, 'Français');
  // an unknown language falls back to English texts
  assert.equal(settingsView(facts({ lang: 'zz' })).lang, 'en');
});

test('unavailable features say so instead of showing a state', () => {
  const t = TRAY.en;
  const off = settingsView(facts({ features: { autostart: false, windowTracking: false } }));
  assert.equal(row(off, 'general', 'autostart').value, t.unavailable);
  assert.equal(row(off, 'behavior', 'possess').value, t.unavailable);
  const on = settingsView(facts({ features: { autostart: true, windowTracking: true }, autostart: true }));
  assert.equal(row(on, 'general', 'autostart').value, SETTINGS.en.on);
  assert.equal(row(on, 'behavior', 'possess').value, SETTINGS.en.on);
});

test('size, sound, the assistant watched and no assistant', () => {
  const view = settingsView(facts({ cfg: { ...DEFAULTS, scale: 0.8, muted: true } }));
  assert.equal(row(view, 'general', 'scale').value, TRAY.en.large);
  assert.equal(row(view, 'general', 'muted').value, SETTINGS.en.on);
  assert.equal(row(view, 'general', 'muted').control.value, true);
  assert.equal(row(settingsView(facts({ cfg: { ...DEFAULTS, scale: 0.7 } })), 'general', 'scale').value, '70 %');
  assert.equal(row(settingsView(facts()), 'general', 'volume').value, '70 %');
  assert.equal(row(settingsView(facts()), 'general', 'volume').control.value, 70);
  const codex = settingsView(facts({ assistant: { id: 'codex', name: 'Codex' } }));
  assert.equal(row(codex, 'ai', 'assistant').value, 'Codex');
  assert.equal(row(codex, 'ai', 'hooks').label, 'Hooks Codex');
  const none = settingsView(facts({ assistant: null }));
  assert.equal(row(none, 'ai', 'assistant').value, TRAY.en.watchNone);
  assert.equal(row(none, 'ai', 'hooks'), undefined);
  assert.equal(row(settingsView(facts({ model: null })), 'ai', 'model').value, SETTINGS.en.none);
  assert.equal(row(settingsView(facts()), 'about', 'system').value, 'macOS · arm64');
});

test('the settings page reaches main only through the protocol, and every settings command checks its sender', () => {
  const root = path.join(__dirname, '..');
  const { COMMANDS } = require('../src/protocol');
  const channels = COMMANDS.filter((c) => c.scope === 'settings').map((c) => c.channel);
  assert.ok(channels.length >= 12);
  const html = fs.readFileSync(path.join(root, 'src/renderer/settings.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  const main = fs.readFileSync(path.join(root, 'src/main/core.js'), 'utf8');
  for (const channel of channels) {
    // its handler checks the sender is the settings window, on its first lines
    const at = main.indexOf(`ipcOn('${channel}'`) >= 0 ? main.indexOf(`ipcOn('${channel}'`) : main.indexOf(`ipcHandle('${channel}'`);
    assert.ok(at >= 0, channel);
    assert.match(main.slice(at, at + 160), /settings\?\.owns\(sender\)/, channel);
  }
});
