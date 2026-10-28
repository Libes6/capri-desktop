'use strict';

// TAURI-03: the renderer reaches the native side only through src/renderer/js/host.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = path.resolve(__dirname, '../src/renderer');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(e.name)) files.push(p);
  }
})(dir);

const FORBIDDEN = /\b(?:window|globalThis|self|top|parent)\s*\.\s*(?:host|settingsHost|capriSettings|__CAPRI_HOST__|__TAURI__|electron|ipcRenderer)\b|\bipcRenderer\b|require\(\s*['"]electron['"]\s*\)|@tauri-apps\/api\//;

test('no renderer file but host.js touches the native bridge', () => {
  const bad = [];
  for (const file of files) {
    if (path.basename(file) === 'host.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (FORBIDDEN.test(line)) bad.push(`${path.relative(dir, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('the pages that talk to the host import it from host.js', () => {
  for (const f of ['app.js', 'settings.js']) {
    assert.match(fs.readFileSync(path.join(dir, 'js', f), 'utf8'), /from '\.\/host\.js'/, f);
  }
});

test('host.js offers every command of both preloads, over invoke and on', async () => {
  const { host, settingsHost } = await import(pathToFileURL(path.join(dir, 'js/host.js')).href);
  const sent = [];
  global.window = {
    __CAPRI_HOST__: {
      invoke: (name, args) => sent.push([name, args]) && 'ok',
      on: (event, cb) => sent.push(['on', event]) && (() => {}),
    },
  };
  try {
    const overlay = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
    const names = [...overlay.matchAll(/^  (\w+):/gm)].map((m) => m[1]);
    assert.ok(names.length > 50);
    for (const n of names) assert.equal(typeof host[n], 'function', `overlay ${n}`);

    host.setConfig({ a: 1 });
    host.onConfig(() => {});
    settingsHost.updates.install(true);
    settingsHost.updates.onStatus(() => {});
    assert.deepEqual(sent, [['setConfig', [{ a: 1 }]], ['on', 'capri:config'], ['updates.install', [true]], ['on', 'updates:status']]);
  } finally {
    delete global.window;
  }
});
