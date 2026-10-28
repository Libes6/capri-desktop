'use strict';

// TAURI-03: a dependency-free static server for checking the renderer in a real WebKit.
// It serves the repository as it is, so the pages keep their paths, CSS, fonts and CSP. For the two
// renderer pages, `?fake=1` injects a fake host (fake-host.js + the data it answers with):
//   /src/renderer/index.html?fake=1      the overlay
//   /src/renderer/settings.html?fake=1   her settings window
// The settings view is the real one: settings-view.js run on test facts, not a copy.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

const CONFIG = {
  scale: 0.6, muted: false, volume: 0.7, lang: 'en', langSetting: 'auto', displayId: null, wander: false, possess: false,
  visible: true, welcomed: true, assistant: 'claude', linked: true, chatModel: null, provider: 'ollama', customUrl: '',
  claudeCwd: null, userName: 'Test', persona: '', myLines: [], memories: [], claudeMode: 'default', claude: true,
  rest: 'corner', motion: 'full', motionAsked: true, render: 'auto', follow: true, jealous: true, reminders: [],
  bond: null, initiative: 'quiet', pcReact: false, watchScreen: false, lookAsked: false,
  platform: 'darwin', keys: [], floorGap: 0, caps: { guide: true, setup: true, chat: true, possess: false },
};

function data() {
  const { settingsView } = require('../../src/main/settings-view');
  const features = Object.fromEntries(['windowTracking', 'appList', 'appClose', 'appLaunch', 'mediaKeys', 'autostart', 'ollamaInstall', 'ollamaLaunch'].map((f) => [f, true]));
  const { keys, floorGap, caps, platform, assistant, lang, langSetting, ...cfg } = CONFIG;
  const view = settingsView({
    cfg, lang: 'en', langSetting: 'auto', autoLang: 'en', assistant: { id: 'claude', name: 'Claude Code' }, hooksInstalled: true,
    assistants: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }],
    provider: 'Ollama', providers: [{ id: 'ollama', label: 'Ollama', keyed: false }, { id: 'openai', label: 'OpenAI', keyed: true }],
    keys: { openai: true }, envKeys: {}, model: 'test-model', models: ['test-model', 'other-model'], features, autostart: false,
    screen: { index: 0, count: 2, width: 1440, height: 900 },
    screens: [{ id: 1, width: 1440, height: 900 }, { id: 2, width: 1920, height: 1080 }], renderNow: 'auto',
    about: { version: '0.0.0-webkit-check', platform: 'darwin', arch: 'arm64', electron: 'none', session: null },
    updates: { kind: 'available', mode: 'notify', version: '9.9.9', canDownload: false },
  });
  return { config: CONFIG, view, screens: { current: 1, origin: { x: 0, y: 0 }, list: [{ id: 1, x: 0, y: 0, w: 1440, h: 900 }, { id: 2, x: 1440, y: 0, w: 1920, h: 1080 }] } };
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  let file;
  try { file = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (file.includes('\0')) { res.writeHead(400); return res.end(); }
  if (file === '/__fake/data.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    return res.end(`window.__FAKE_DATA__ = ${JSON.stringify(data())};`);
  }
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT + path.sep) || /(^|\/)\.git(\/|$)/.test(file)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, body) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = TYPES[path.extname(full)] || 'application/octet-stream';
    if (url.searchParams.has('fake') && full.endsWith('.html')) {
      body = Buffer.from(String(body).replace('<head>', '<head>\n  <script src="/__fake/data.js"></script>\n  <script src="/tools/webkit-check/fake-host.js"></script>'));
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });
}

function start(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.env.PORT) || 8765).then(({ port }) => console.log(`webkit-check server: http://127.0.0.1:${port}/src/renderer/index.html?fake=1`));
}
