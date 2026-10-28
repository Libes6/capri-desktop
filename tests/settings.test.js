'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { settingsView, SECTIONS } = require('../src/main/settings-view');
const { createSettingsWindow } = require('../src/main/settings-window');
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
  about: { version: '0.1.0', platform: 'darwin', arch: 'arm64', electron: '44.9.3' },
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

// A stand-in for Electron's BrowserWindow: enough of it for settings-window.js.
function fakeElectron() {
  const made = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.focused = false;
      this.minimized = false;
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
        send: (channel, payload) => this.sent.push([channel, payload]),
      });
      made.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    setTitle(title) { this.title = title; }
    loadURL(url) { this.url = url; }
    removeMenu() { this.menuRemoved = true; }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  return { FakeWindow, made };
}

function makeSettings(extra = {}) {
  const { FakeWindow, made } = fakeElectron();
  let focusApp = 0;
  let closed = 0;
  const settings = createSettingsWindow({
    BrowserWindow: FakeWindow,
    preload: '/app/src/settings-preload.js',
    url: 'capri://app/src/renderer/settings.html',
    view: () => ({ title: 'Capri — Settings' }),
    area: () => ({ x: 100, y: 50, width: 1440, height: 900 }),
    focusApp: () => { focusApp++; },
    onClosed: () => { closed++; },
    ...extra,
  });
  return { settings, made, counts: () => ({ focusApp, closed }) };
}

test('one window: opening again brings the same one forward with the focus', () => {
  const { settings, made, counts } = makeSettings();
  const win = settings.open();
  assert.equal(made.length, 1);
  assert.equal(win.visible, false); // shown once its page is ready, not blank
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  assert.equal(win.focused, true);
  win.focused = false;
  win.minimized = true;
  assert.equal(settings.open(), win);
  assert.equal(made.length, 1);
  assert.equal(win.minimized, false);
  assert.equal(win.focused, true);
  assert.equal(counts().focusApp, 2);
});

test('a secure, ordinary window in the middle of the screen', () => {
  const { settings } = makeSettings();
  const win = settings.open();
  const { webPreferences: web, ...options } = win.options;
  assert.equal(web.contextIsolation, true);
  assert.equal(web.sandbox, true);
  assert.equal(web.nodeIntegration, false);
  assert.equal(web.preload, '/app/src/settings-preload.js');
  assert.equal(options.x, 100 + (1440 - options.width) / 2);
  assert.equal(options.y, 50 + (900 - options.height) / 2);
  // nothing that would make it an overlay: no click-through, no always-on-top, focusable, in the taskbar
  for (const key of ['transparent', 'alwaysOnTop', 'skipTaskbar', 'frame', 'focusable']) assert.equal(key in options, false, key);
  assert.equal(win.menuRemoved, true);
  assert.deepEqual(win.openHandler(), { action: 'deny' });
  let prevented = false;
  win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('fits a small screen', () => {
  const { settings } = makeSettings({ area: () => ({ x: 0, y: 0, width: 600, height: 400 }) });
  const { options } = settings.open();
  assert.deepEqual([options.x, options.y, options.width, options.height], [0, 0, 600, 400]);
});

test('closed: gone for good, the next open makes a new one; update only reaches an open window', () => {
  const { settings, made, counts } = makeSettings();
  settings.update(); // nothing open: nothing to do
  const win = settings.open();
  assert.equal(settings.owns(win.webContents), true);
  assert.equal(settings.owns({}), false);
  settings.update();
  assert.deepEqual(win.sent, [['settings:view', { title: 'Capri — Settings' }]]);
  assert.equal(win.title, 'Capri — Settings');
  settings.close();
  assert.equal(settings.isOpen(), false);
  assert.equal(settings.window(), null);
  assert.equal(settings.owns(win.webContents), false);
  assert.equal(counts().closed, 1);
  settings.close(); // twice: no harm
  win.emit('ready-to-show'); // late event from the old window: ignored
  assert.equal(win.visible, false);
  const next = settings.open();
  assert.notEqual(next, win);
  assert.equal(made.length, 2);
});

test('the settings page reaches main only through its own preload', () => {
  const root = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/settings-preload.js'), 'utf8');
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(channels)].sort(), [
    'settings:close', 'settings:key', 'settings:menu', 'settings:ready', 'settings:reset', 'settings:restart', 'settings:set', 'settings:view',
    'updates:check', 'updates:download', 'updates:install', 'updates:page',
  ]);
  // and what main sends it
  const heard = [...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(heard)].sort(), ['settings:section', 'settings:view', 'updates:status']);
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

test('update while the page is already gone (closing, quitting): nothing sent, no throw', () => {
  const { settings } = makeSettings();
  const win = settings.open();
  win.webContents.isDestroyed = () => true;
  win.webContents.send = () => { throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => settings.update());
  assert.equal(settings.isOpen(), false);
  assert.equal(settings.owns(win.webContents), false);
});
