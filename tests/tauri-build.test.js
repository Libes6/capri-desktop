'use strict';
// TAURI-04: what the Tauri shell is built from: her pages staged for frontendDist (every file the pages
// name is there), and the sidecar bundle (one file, node builtins only) that really starts, says hello,
// answers a command and leaves when its stdin closes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stage } = require('../scripts/stage-frontend');
const { bundle } = require('../scripts/build-sidecar');

const ROOT = path.resolve(__dirname, '..');

test('the staged frontend holds every file her pages name (images, fonts, scripts)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-stage-'));
  try {
    stage(out);
    const missing = [];
    for (const page of ['index.html', 'settings.html']) {
      const html = fs.readFileSync(path.join(out, 'src', 'renderer', page), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (/^(https?:|data:)/.test(m[1])) continue;
        if (!fs.existsSync(path.join(out, 'src', 'renderer', m[1]))) missing.push(`${page}: ${m[1]}`);
      }
    }
    for (const file of fs.readdirSync(path.join(out, 'src', 'renderer', 'js'))) {
      const text = fs.readFileSync(path.join(out, 'src', 'renderer', 'js', file), 'utf8');
      for (const m of text.matchAll(/['"`](\.\.\/\.\.\/assets\/[^'"`$]+[^/'"`$])['"`]/g)) {
        // loaded by the page (src/renderer/index.html), so relative to it
        if (!fs.existsSync(path.join(out, 'src', 'renderer', m[1]))) missing.push(`${file}: ${m[1]}`);
      }
    }
    const css = fs.readFileSync(path.join(out, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
    for (const m of css.matchAll(/url\('([^']+woff2)'\)/g)) {
      if (!fs.existsSync(path.join(out, 'src', 'renderer', 'styles', m[1]))) missing.push(`tokens.css: ${m[1]}`);
    }
    assert.deepEqual(missing, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the sidecar bundle takes only node builtins and the repository\'s own files, and not Electron', () => {
  const { source, modules } = bundle();
  assert.ok(modules.includes('src/main/core.js') && modules.includes('src/main/platform/sidecar.js') && modules.includes('src/protocol.js'));
  assert.ok(!modules.some((m) => /platform\/electron\.js$/.test(m)), 'the Electron platform is not in it');
  assert.doesNotMatch(source, /require\(\s*['"]electron/);
});

test('the bundled sidecar starts, answers a command through the dispatcher and ends with its stdin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-bundle-'));
  const file = path.join(dir, 'sidecar.bundle.js');
  fs.writeFileSync(file, bundle().source);
  const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CAPRI_PORT: '47977' } });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let buffer = '';
  const display = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 760 }, size: { width: 1280, height: 800 } };
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const answer = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from the sidecar')), 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (m.method === 'hello') send({ id: m.id, result: { name: 'Capri', version: '0', paths: { userData: dir, home: dir, appPath: ROOT, resources: ROOT, temp: dir, exe: dir }, screens: [display], cursor: { x: 0, y: 0 } } });
        else if (m.method === 'overlay.create') send({ id: m.id, result: m.params.area });
        else if (m.method === 'ready') send({ id: 50, method: 'invoke', params: { scope: 'overlay', name: 'getConfig', args: [], sender: { label: 'overlay' } } });
        else if (m.id === 50) { clearTimeout(timer); resolve(m); }
      }
    });
  });
  try {
    assert.equal(answer.error, undefined);
    assert.equal(typeof answer.result.lang, 'string');
    child.stdin.end();
    assert.equal(await exited, 0, 'it leaves when its stdin closes');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
