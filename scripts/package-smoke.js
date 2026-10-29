'use strict';

// A small check of a PACKAGED Tauri app (TAURI-12), used by the CI and by hand: start it with a temporary profile, wait
// for the line that says the core is up and the hooks bridge answers /health, (macOS) for the window helper, then stop it.
// The fuller scenario (settings window, screens, keys) is scripts/smoke-test-tauri.js of TAURI-11.
//
//   node scripts/package-smoke.js <executable> [--expect-window-tracking] [--port N] [--wait seconds]
//
// The profile (CAPRI_USER_DATA) is a new temporary folder, nothing of a real profile is read
// the bridge has its own port: nothing of a real profile, of the assistants' settings or of the key store is
// touched. Only the process it started is stopped. A running Capri of the same identifier makes the new copy exit at once
// (single instance): that is reported as such, not as a failure of the package.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const READY = /\[capri\] listening on 127\.0\.0\.1:(\d+)/;
const TRACKING = /\[capri\] window tracking: on/;

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** → { ok, ready, healthy, tracking, exited, log } */
async function smoke(executable, { port = 47891, expectWindowTracking = false, waitMs = 60000, log = console.log } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-package-smoke-'));
  const env = { ...process.env, CAPRI_USER_DATA: profile, CAPRI_PORT: String(port) };
  delete env.CAPRI_HOOK_BIN;
  const child = spawn(path.resolve(executable), [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let exited = null;
  const take = (chunk) => { out += String(chunk); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { out += `\nspawn error: ${err.message}\n`; exited = { code: -1 }; });
  const result = { ok: false, ready: false, healthy: false, tracking: false, exited: null, log: '' };
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs && !exited) {
      result.ready = READY.test(out);
      result.tracking = TRACKING.test(out);
      if (result.ready && !result.healthy) result.healthy = await health(port);
      if (result.healthy && (!expectWindowTracking || result.tracking)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    result.exited = exited;
    result.ok = result.ready && result.healthy && (!expectWindowTracking || result.tracking) && !exited;
  } finally {
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    result.log = out;
    fs.rmSync(profile, { recursive: true, force: true });
  }
  log(out.split('\n').filter((l) => l.trim()).slice(-25).join('\n'));
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const port = Number(option('--port')) || undefined;
  const wait = Number(option('--wait')) || undefined;
  const expectWindowTracking = args.includes('--expect-window-tracking');
  const executable = args.find((a) => !a.startsWith('--'));
  if (!executable) { console.error('usage: node scripts/package-smoke.js <executable> [--expect-window-tracking]'); process.exit(2); }
  smoke(executable, { port, waitMs: wait && wait * 1000, expectWindowTracking }).then((r) => {
    console.log(`package smoke: core ${r.ready ? 'up' : 'NOT up'}, bridge /health ${r.healthy ? 'ok' : 'NOT ok'}${expectWindowTracking ? `, window tracking ${r.tracking ? 'on' : 'NOT on'}` : ''}${r.exited ? `, exited early (${JSON.stringify(r.exited)})` : ''}`);
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { smoke, READY, TRACKING };
