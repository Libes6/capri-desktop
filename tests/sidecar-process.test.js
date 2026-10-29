'use strict';
// sidecar/main.js as a real process, with a fake Rust shell on its stdin/stdout: stdout carries nothing but
// protocol lines (the core's console.log goes to stderr), a second launch makes her show her status (as in
// the Electron build), and `quit` ends the process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const display = { id: 1, primary: true, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1280, height: 832 }, workArea: { x: 0, y: 0, width: 1280, height: 800 }, size: { width: 1280, height: 832 } };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('sidecar process: protocol-only stdout, a second launch shows her status, quit ends it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-sidecar-proc-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'main.js')], {
    env: { ...process.env, CAPRI_NO_MIGRATE: '1', CAPRI_USER_DATA: dir, CAPRI_PORT: String(port), CAPRI_DEBUG: '', CAPRI_DEV: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const seen = [];
  const strays = [];
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let buffer = '';
  const reply = (id, result) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        strays.push(line);
        continue;
      }
      seen.push(message);
      if (message.method && message.id !== undefined) {
        if (message.method === 'hello') {
          const p = (n) => path.join(home, n);
          reply(message.id, {
            name: 'Capri', identifier: 'capri.desktop.test', version: '0.0.0', tauri: '2', packaged: false, updater: { mode: 'disabled', reason: 'dev' },
            paths: { userData: dir, home, desktop: p('d'), documents: p('doc'), downloads: p('dl'), pictures: p('pic'), music: p('m'), videos: p('v'), temp: dir, exe: process.execPath, appPath: dir, resources: dir },
            screens: [display], cursor: { x: 1, y: 1 }, autostart: false, locked: false,
          });
        } else if (message.method === 'secrets.masterKey') reply(message.id, { available: false, reason: 'test' });
        else if (message.method === 'overlay.create') reply(message.id, display.workArea);
        else reply(message.id, null);
      }
    }
  });
  const until = async (check, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    child.kill();
    throw new Error(`timed out: ${what}`);
  };
  try {
    await until(() => seen.some((m) => m.method === 'ready'), 'the sidecar to be ready');
    const status = (m) => m.method === 'emit' && m.params?.event === 'capri:command' && m.params?.payload?.name === 'status';
    assert.ok(!seen.some(status), 'no status before a second launch');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'second-instance', params: { argv: [], cwd: '/' } })}\n`);
    await until(() => seen.some(status), 'her status after a second launch');
    assert.deepEqual(strays, [], 'stdout holds protocol lines only');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'quit', params: {} })}\n`);
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('did not exit on quit')), 5000))]);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
