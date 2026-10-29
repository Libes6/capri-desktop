'use strict';

// Smoke test of the Tauri build (TAURI-11): starts the built app with a temporary profile and checks, through
// the dev routes of the sidecar (sidecar/debug.js, on the hooks port, CAPRI_DEBUG=1):
//   1. her page is ready (renderer:ready reached the core)
//   2. the core answers getConfig
//   3. the settings window opens (Rust made it, its page is loaded)
//   4. a field changed through settings:set reaches config.json
//   5. the window watcher is on when the helper is built (--expect-window-tracking)
//   6. the sidecar comes back after a kill (a new pid, her page meets the new core)
//   7. at exit nothing of ours is left (the sidecar and the other children are gone)
//
//   node scripts/smoke-test-tauri.js [--build] [--release] [--expect-window-tracking] [--bin <file>] [--keep]
//   npm run test:smoke:tauri
//
// The binary: --bin, or $CAPRI_TAURI_BIN, or <CARGO_TARGET_DIR or src-tauri/target>/{debug,release}/capri.
// --build builds it first (stage her pages, cargo build) with its own identifier (TAURI_CONFIG), so that it never
// meets the real Capri's single-instance socket (/tmp/capri_desktop_si.sock); without --build, use a binary built
// that way (the script refuses to start next to a live Capri whose socket it would share).
// Everything it starts is its own: a temporary profile and keychain service, a free port, the autostart
// faked in a file; it kills only the pids it started. Hard limit: 3 minutes.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const IDENTIFIER = 'capri.desktop.smoke';
const exe = process.platform === 'win32' ? '.exe' : '';
const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri', 'target');
const bin = path.resolve(opt('bin') || process.env.CAPRI_TAURI_BIN || path.join(targetDir, flag('release') ? 'release' : 'debug', `capri${exe}`));
const expectWindows = flag('expect-window-tracking');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {}; // step -> true | false
const say = (m) => console.log(`[smoke] ${m}`);
function step(name, ok, detail = '') {
  results[name] = Boolean(ok);
  say(`${name}: ${ok ? 'ok' : 'FAILED'}${detail ? ` (${detail})` : ''}`);
  return ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function call(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: data ? 'POST' : 'GET', headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, timeout: 8000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error(`not JSON: ${text.slice(0, 80)}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (err) { last = err; }
    await sleep(250);
  }
  throw new Error(`${what}: not within ${Math.round(ms / 1000)} s${last ? ` (${last.message})` : ''}`);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

// every descendant of `pid` (ps), so that the exit check and the cleanup know exactly what is ours
function descendants(pid) {
  if (process.platform === 'win32') return [];
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const out = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift();
    for (const [c, parent] of rows) if (parent === p && !out.includes(c)) { out.push(c); queue.push(c); }
  }
  return out;
}

function buildBinary() {
  say('building (stage her pages, cargo build) ...');
  const stage = spawnSync(process.execPath, [path.join(root, 'scripts', 'stage-frontend.js')], { cwd: root, stdio: 'inherit' });
  if (stage.status !== 0) throw new Error('stage-frontend failed');
  const build = spawnSync('cargo', ['build', ...(flag('release') ? ['--release'] : [])], {
    cwd: path.join(root, 'src-tauri'), stdio: 'inherit',
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: IDENTIFIER }) },
  });
  if (build.status !== 0) throw new Error('cargo build failed');
}

// a live Capri on the same single-instance socket would make ours quit at once and look like a failure
function refuseSharedSocket() {
  if (process.platform === 'win32') return;
  const sock = '/tmp/capri_desktop_si.sock';
  if (!fs.existsSync(sock)) return;
  let embedded = false;
  try { embedded = fs.readFileSync(bin).includes(Buffer.from(IDENTIFIER)); } catch { /* unreadable: treated as shared */ }
  if (!embedded) throw new Error(`${sock} exists and this binary has the identifier capri.desktop: build it with --build (identifier ${IDENTIFIER}) or stop the other Capri`);
}

async function main() {
  if (flag('build')) buildBinary();
  if (!fs.existsSync(bin)) throw new Error(`no binary at ${bin} (npm run tauri:build, or --build)`);
  refuseSharedSocket();

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-smoke-tauri-'));
  const port = await freePort();
  const env = {
    ...process.env,
    CAPRI_USER_DATA: data,
    CAPRI_PORT: String(port),
    CAPRI_DEBUG: '1',
    CAPRI_DEBUG_STDIN: '1',
    CAPRI_KEYCHAIN_SERVICE: `${IDENTIFIER}.${process.pid}`,
    CAPRI_AUTOSTART_FAKE: path.join(data, 'autostart-fake'),
    CAPRI_ROOT: root,
    CAPRI_NODE: process.execPath, // the GUI-less PATH may not have node (nvm)
  };
  delete env.CAPRI_SIDECAR; // the sidecar of this clone, run by node
  say(`${bin}\n        profile ${data}, port ${port}`);
  const child = spawn(bin, [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const ours = new Set([child.pid]);
  let log = '';
  const keep = (chunk) => { log += String(chunk); if (log.length > 200000) log = log.slice(-100000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { exited = { code: -1, signal: String(err) }; });

  const killOurs = () => {
    for (const pid of [...ours, ...descendants(child.pid)]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  };
  const hard = setTimeout(() => { console.error('Smoke process did not finish in 3 minutes'); killOurs(); process.exit(1); }, 180000);
  hard.unref();

  try {
    // 1. her page is ready
    const info = await until('renderer ready', async () => {
      if (exited) throw new Error(`the app exited early: ${JSON.stringify(exited)}`);
      const r = await call(port, '/debug/info');
      return r.rendererReady ? r : null;
    }, 60000).catch((err) => { step('rendererReady', false, err.message); return null; });
    if (!info) throw new Error('no renderer');
    step('rendererReady', true, `core pid ${info.pid}`);
    ours.add(info.pid);

    // 2. the core answers getConfig
    const cfg = await call(port, '/debug/invoke', { scope: 'overlay', name: 'getConfig', args: [] }).catch(() => null);
    step('coreGetConfig', cfg?.ok && cfg.value && Array.isArray(cfg.value.keys) && typeof cfg.value.platform === 'string', cfg?.value ? `platform ${cfg.value.platform}, lang ${cfg.value.lang}` : 'no answer');

    // 3. the settings window opens
    await call(port, '/debug/settings', { open: true });
    const page = await until('settings window', async () => {
      const r = await call(port, '/debug/settings', { js: "document.readyState + '|' + document.body.children.length + '|' + document.title" });
      const v = typeof r.value === 'string' ? r.value : '';
      return v.startsWith('complete|') && Number(v.split('|')[1]) > 0 ? v : null;
    }, 20000).catch(() => null);
    step('settingsWindow', Boolean(page), page || 'its page did not load');

    // 4. a change reaches config.json
    const set = await call(port, '/debug/invoke', { scope: 'settings', name: 'set', args: [{ initiative: 'active' }] }).catch(() => null);
    const file = path.join(data, 'config.json');
    const saved = await until('config.json', () => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')).initiative === 'active'; } catch { return false; }
    }, 5000).catch(() => false);
    step('settingChange', Boolean(set?.ok && set.value?.ok && saved), `settings:set ${JSON.stringify(set?.value?.ok)}, config.json ${saved ? 'has initiative=active' : 'unchanged'}`);
    await call(port, '/debug/settings', { open: false }).catch(() => {});

    // 5. the window watcher
    if (expectWindows) {
      const on = await until('window tracking', async () => (await call(port, '/debug/info')).features?.windowTracking, 20000).catch(() => false);
      step('windowTracking', on, on ? 'on' : 'the watcher did not start (is the helper built: npm run build:mac-helper?)');
    } else {
      const f = (await call(port, '/debug/info').catch(() => ({}))).features;
      say(`windowTracking: ${f?.windowTracking ? 'on' : 'off'} (not required; --expect-window-tracking)`);
    }

    // 5b. the demo's fake terminal (Rust's window, 620x300) is seen by the watcher, and goes when the demo ends
    if ((await call(port, '/debug/info').catch(() => ({}))).features?.windowTracking) {
      const seenWin = () => call(port, '/debug/invoke', { scope: 'overlay', name: 'windowsNow', args: [] })
        .then((r) => Boolean(r.value?.wins?.some((w) => w.w === 620 && w.h === 300)));
      const opened = await call(port, '/debug/invoke', { scope: 'overlay', name: 'demoWindow', args: [true] }).catch(() => null);
      const shown = opened?.value === true && await until('demo terminal', seenWin, 15000).catch(() => false);
      await call(port, '/debug/invoke', { scope: 'overlay', name: 'demoWindow', args: [false] }).catch(() => {});
      const gone = shown && await until('demo terminal gone', async () => !(await seenWin()), 15000).catch(() => false);
      step('demoTerminal', shown && gone, shown ? (gone ? 'seen by the watcher, gone after' : 'did not close') : 'the window never showed in the watcher\'s list');
    }

    // 6. the sidecar comes back after a kill
    const before = (await call(port, '/debug/info')).pid;
    process.kill(before, 'SIGKILL');
    const again = await until('sidecar restart', async () => {
      const r = await call(port, '/debug/info');
      return r.pid !== before && r.rendererReady ? r : null;
    }, 40000).catch((err) => { say(err.message); return null; });
    step('sidecarRestart', again, again ? `pid ${before} -> ${again.pid}, her page met the new core` : 'no new core');
    if (again) ours.add(again.pid);

    // 7. no orphans at exit
    const family = [...new Set([...ours, ...descendants(child.pid)])];
    child.stdin.write('!exit\n');
    const done = await until('exit', () => exited, 20000).catch(() => null);
    if (!done) { say('did not leave after !exit; killing it'); killOurs(); }
    await sleep(2500); // the sidecar leaves on EOF / the quit notification, a kill after 2 s at the latest
    const left = family.filter((p) => alive(p));
    step('exitClean', done && left.length === 0, left.length ? `still alive: ${left.join(', ')}` : `${family.length} processes, all gone`);
    for (const p of left) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  } catch (err) {
    say(err.message);
  } finally {
    clearTimeout(hard);
    if (!exited) killOurs();
    const failed = Object.values(results).includes(false) || Object.keys(results).length < (expectWindows ? 8 : 6);
    if (failed || flag('keep')) {
      const tail = log.split('\n').slice(-40).join('\n');
      console.error(`--- last output of the app ---\n${tail}`);
    }
    if (!flag('keep')) fs.rmSync(data, { recursive: true, force: true });
    // the core made its master key in the Keychain under the test service name: take that item away again
    if (process.platform === 'darwin') spawnSync('/usr/bin/security', ['delete-generic-password', '-s', env.CAPRI_KEYCHAIN_SERVICE, '-a', 'master-key'], { stdio: 'ignore' });
    if (failed) {
      console.error(`Smoke failed: ${Object.entries(results).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      process.exitCode = 1;
    } else {
      say('Smoke passed');
    }
  }
}

main().catch((err) => { console.error(`Smoke failed: ${err.message}`); process.exitCode = 1; });
