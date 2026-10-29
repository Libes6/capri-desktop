#!/usr/bin/env node
'use strict';
// Idle CPU / GPU / wakeups of the Tauri build with her real renderer (TAURI-05), the method of the spike's
// probe and of scripts/perf-probe.js (ps cputime deltas, top idlew/power, ioreg AGXDeviceUserClient
// accumulatedGPUTime). macOS only. Counted: the app, its sidecar (Node, a child), and WebKit's
// helpers (Web Content, GPU, Networking: XPC services, not children; lsappinfo lists them right after the app).
//   node scripts/perf-probe-tauri.js --pid <capri pid> [--secs 60] [--warm 10]      one idle window of a running app
//   node scripts/perf-probe-tauri.js --launch [--bin <capri>] [--states idle,hidden,paused,work,chat] [--secs 45] [--warm 8] [--out f.json]
// --launch (TAURI-11): starts the built app itself, with a throwaway profile (CAPRI_USER_DATA), its own port and
// keychain service, drives it through the sidecar's debug routes (CAPRI_DEBUG) and the page through the debug stdin
// (CAPRI_DEBUG_STDIN), and measures the states of docs/PERFORMANCE.md the same way, plus the
// requestAnimationFrame callbacks and sprite draws per second counted inside the page. Kills only its own pids.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, execFile, spawn, spawnSync } = require('node:child_process');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const LAUNCH = process.argv.includes('--launch');
let PID = Number(arg('pid')); const SECS = Number(arg('secs', 45)); const WARM = Number(arg('warm', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseTime = (t) => t.split(':').reduce((a, p) => a * 60 + Number(p), 0);

function helperPids() {
  const out = execFileSync('lsappinfo', ['list']).toString();
  const pids = new Map([[PID, 'main']]);
  const blocks = out.split(/\n(?=\s*\d+\) )/);
  const at = blocks.findIndex((b) => new RegExp(`pid = ${PID}\\b`).test(b));
  for (let i = at + 1; at >= 0 && i < blocks.length; i++) {
    const m = blocks[i].match(/^\s*\d+\) "([^"]+)"/); const p = blocks[i].match(/pid = (\d+)/);
    if (m && p && m[1] === 'capri-windows') continue; // the window helper sits between (the sidecar's child, counted below)
    if (!m || !p || !m[1].startsWith('capri ')) break; // the next app
    pids.set(Number(p[1]), m[1].slice('capri '.length));
  }
  // the sidecar and whatever else the app started
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (ppid === PID) pids.set(pid, 'child');
  }
  return pids;
}
function cpuOf(pids) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,time=,rss=']).toString();
  const res = new Map();
  for (const line of out.trim().split('\n')) {
    const [pid, time, rss] = line.trim().split(/\s+/);
    if (pids.has(Number(pid))) res.set(Number(pid), { cpu: parseTime(time), rss: Number(rss) });
  }
  return res;
}
function gpuTimes() {
  const out = execFileSync('ioreg', ['-r', '-c', 'AGXDeviceUserClient', '-l'], { maxBuffer: 64 << 20 }).toString();
  const t = new Map();
  for (const block of out.split(/\+-o /).slice(1)) {
    const c = block.match(/"IOUserClientCreator" = "pid (\d+),/); const u = block.match(/"AppUsage" = \((.*)\)/);
    if (!c || !u) continue;
    t.set(Number(c[1]), (t.get(Number(c[1])) || 0) + [...u[1].matchAll(/"accumulatedGPUTime"=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0));
  }
  return t;
}
function top(pids, secs) {
  return new Promise((resolve) => {
    const args = ['-l', '2', '-s', String(secs), '-stats', 'pid,idlew,power'];
    for (const p of pids) args.push('-pid', String(p));
    execFile('top', args, { maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) return resolve(new Map());
      const tables = stdout.split(/^PID\s+IDLEW\s+POWER\s*$/m).slice(1).map((t) => {
        const rows = new Map();
        for (const l of t.split('\n')) { const m = l.trim().match(/^(\d+)\s+(\d+)\+?\s+([\d.]+)/); if (m) rows.set(Number(m[1]), { idlew: Number(m[2]), power: Number(m[3]) }); }
        return rows;
      });
      const res = new Map();
      if (tables.length < 2) return resolve(res);
      for (const p of pids) { const a = tables[0].get(p), b = tables[1].get(p); if (a && b) res.set(p, { wakeups: (b.idlew - a.idlew) / secs, power: b.power }); }
      resolve(res);
    });
  });
}
async function singleWindow() {
  const pids = helperPids();
  const ws = Number(execFileSync('pgrep', ['-x', 'WindowServer']).toString().trim().split('\n')[0]);
  const gpuPid = [...pids].find(([, k]) => k === 'Graphics and Media')?.[0];
  console.log('processes:', JSON.stringify([...pids]));
  await sleep(WARM * 1000);
  const c0 = cpuOf(pids), g0 = gpuTimes(); const t0 = Date.now();
  const tp = await top([...pids.keys()], SECS);
  const secs = (Date.now() - t0) / 1000;
  const c1 = cpuOf(pids), g1 = gpuTimes();
  const rows = [...pids].map(([pid, kind]) => ({ kind, pid, rssMB: Math.round((c1.get(pid)?.rss || 0) / 1024),
    cpuPct: c0.has(pid) && c1.has(pid) ? +((100 * (c1.get(pid).cpu - c0.get(pid).cpu)) / secs).toFixed(2) : null,
    wakeups: tp.get(pid) ? +tp.get(pid).wakeups.toFixed(1) : null, power: tp.get(pid)?.power ?? null }));
  const gpu = (pid) => (pid && g0.has(pid) && g1.has(pid) ? +((100 * (g1.get(pid) - g0.get(pid))) / (secs * 1e9)).toFixed(3) : null);
  console.log(JSON.stringify({
    secs: +secs.toFixed(1), cpuTotalPct: +rows.reduce((n, r) => n + (r.cpuPct || 0), 0).toFixed(2),
    wakeupsTotal: +rows.reduce((n, r) => n + (r.wakeups || 0), 0).toFixed(1),
    gpuProcessGpuPct: gpu(gpuPid), windowServerGpuPct: gpu(ws),
    rows,
  }, null, 1));
}

// ---------- --launch: the states of docs/PERFORMANCE.md ----------

const root = path.resolve(__dirname, '..');
const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri', 'target');
const BIN = path.resolve(arg('bin', process.env.CAPRI_TAURI_BIN || path.join(targetDir, 'debug', 'capri')));
const ONLY = arg('states', null)?.split(',');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
function request(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const INSTRUMENT = `(() => {
  if (window.__perf) return true;
  const c = window.__perf = { raf: 0, draw: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => { c.raf++; fn(t); });
  const sprite = window.dev.capri.sprite;
  const draw = sprite.draw.bind(sprite);
  sprite.draw = (p) => { c.draw++; return draw(p); };
  return true;
})()`;
const PREP = `(() => { const d = window.dev; d.panel.hide(); d.capri.wake(); d.capri.lastActivity = performance.now();
  d.capri.nextMove = d.capri.nextGaze = Infinity; return d.capri.mode; })()`;

async function launchRun() {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  if (!fs.existsSync(BIN)) throw new Error(`no binary at ${BIN} (cargo build, or --bin)`);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-perf-tauri-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ welcomed: true, motionAsked: true, motion: 'full', lang: 'en', assistant: 'claude', linked: true, initiative: 'quiet' }));
  const port = await freePort();
  const env = { ...process.env, CAPRI_USER_DATA: data, CAPRI_PORT: String(port), CAPRI_DEBUG: '1', CAPRI_DEBUG_STDIN: '1',
    CAPRI_KEYCHAIN_SERVICE: `capri.desktop.smoke.perf${process.pid}`, CAPRI_AUTOSTART_FAKE: path.join(data, 'autostart-fake'), CAPRI_ROOT: root, CAPRI_NODE: process.execPath };
  delete env.CAPRI_SIDECAR;
  const child = spawn(BIN, [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  PID = child.pid;
  let log = '';
  const waiting = []; // resolvers of `[eval] ...` lines, in order
  let partial = '';
  child.stdout.on('data', (c) => {
    partial += c;
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (line.startsWith('[eval] ') && waiting.length) waiting.shift()(line.slice(7));
      else log += `${line}\n`;
    }
  });
  child.stderr.on('data', (c) => { log += c; });
  let chain = Promise.resolve();
  // one line of JavaScript in her page, its result (the debug stdin prints it as JSON). One at a time; a call the
  // page never answers (it is not loaded yet) times out and takes its place in the queue of answers with it.
  const evalJs = (js) => {
    const run = () => new Promise((resolve, reject) => {
      const answer = (r) => { clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(answer), 1); reject(new Error(`eval timed out: ${js.slice(0, 60)}`)); }, 8000);
      waiting.push(answer);
      child.stdin.write(`${js.replace(/\n/g, ' ')}\n`);
    });
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
  const parsed = async (js) => { const r = JSON.parse(await evalJs(js)); return typeof r === 'string' ? JSON.parse(r) : r; };
  const debug = (route, body = {}) => request(port, `/debug/${route}`, body);
  const command = (name, payload = {}) => debug('command', { name, ...payload });
  const event = (name, extra = {}) => request(port, '/event', { hook_event_name: name, session_id: 'perf-session', cwd: '/tmp/perf-project', demo: true, ...extra });
  const kill = () => { try { child.stdin.write('!exit\n'); } catch { /* gone */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kill(); setTimeout(() => process.exit(1), 3500); });

  const STATES = {
    async idle() { await evalJs(PREP); },
    async work(ctl) {
      await evalJs(PREP);
      await event('SessionStart', { source: 'startup' });
      await sleep(500);
      await event('UserPromptSubmit', { prompt: 'Measure the overlay' });
      const tools = [['Read', { file_path: '/tmp/perf-project/a.js' }], ['Grep', { pattern: 'raf' }], ['Edit', { file_path: '/tmp/perf-project/a.js' }], ['Bash', { command: 'npm test' }]];
      let i = 0;
      ctl.loop = setInterval(() => {
        const [name, input] = tools[i++ % tools.length];
        event('PreToolUse', { tool_name: name, tool_input: input }).catch(() => {});
        setTimeout(() => event('PostToolUse', { tool_name: name, tool_input: input, duration_ms: 900 }).catch(() => {}), 1200);
      }, 2500);
    },
    async workEnd(ctl) { clearInterval(ctl.loop); await event('Stop', { last_assistant_message: 'Done.' }); await sleep(3000); },
    async chat() { await evalJs(PREP); await command('chat'); },
    async chatEnd() { await evalJs('window.dev.chat.close(); window.dev.panel.hide(); true'); },
    async hidden() { await evalJs(PREP); await command('stow', { on: true }); },
    async hiddenEnd() { await command('stow', { on: false }); await sleep(4000); },
    async paused() { await evalJs(PREP); await debug('power', { away: true }); },
    async pausedEnd() { await debug('power', { away: false }); await sleep(2000); },
  };
  const ORDER = ['idle', 'chat', 'hidden', 'paused', 'work'];

  try {
    for (let i = 0; ; i++) {
      if (i > 60) throw new Error(`never came up:\n${log.slice(-2000)}`);
      await sleep(1000);
      const ready = await evalJs('Boolean(window.dev && window.dev.capri && !window.dev.capri.busy)').catch(() => 'false');
      if (ready === 'true') break;
    }
    await sleep(8000); // past her intro and her hello
    await evalJs(INSTRUMENT);
    const info = await parsed(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, gl: (() => { const gl = window.dev.capri.sprite.gl;
      const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })() })`);
    const pids = helperPids();
    const gpuPid = [...pids].find(([, k]) => k === 'Graphics and Media')?.[0];
    const ws = Number(execFileSync('pgrep', ['-x', 'WindowServer']).toString().trim().split('\n')[0]);
    console.log(JSON.stringify({ renderer: info, processes: [...pids] }));
    const out = { when: new Date().toISOString(), bin: BIN, secs: SECS, warm: WARM, renderer: info, states: [] };
    for (const state of ORDER.filter((x) => !ONLY || ONLY.includes(x))) {
      const ctl = {};
      await STATES[state](ctl);
      await sleep(WARM * 1000);
      const ps = helperPids();
      const c0 = cpuOf(ps), g0 = gpuTimes();
      const r0 = await parsed('JSON.stringify(window.__perf)');
      const t0 = Date.now();
      const tp = await top([...ps.keys()], SECS);
      const secs = (Date.now() - t0) / 1000;
      const c1 = cpuOf(ps), g1 = gpuTimes();
      const r1 = await parsed('JSON.stringify(window.__perf)');
      const page = await parsed(`JSON.stringify({ css: document.getAnimations().filter((a) => a.playState === 'running').length, mode: window.dev.capri.mode,
        hidden: window.dev.capri.hidden, stowed: window.dev.capri.stowed, dormant: window.dev.capri.dormant, chat: window.dev.chat.open, paused: Boolean(window.dev.pause?.paused) })`);
      const rows = [...ps].map(([pid, kind]) => ({ kind, pid, rssMB: Math.round((c1.get(pid)?.rss || 0) / 1024),
        cpu: c0.has(pid) && c1.has(pid) ? +((100 * (c1.get(pid).cpu - c0.get(pid).cpu)) / secs).toFixed(2) : null,
        wakeups: tp.get(pid) ? +tp.get(pid).wakeups.toFixed(1) : null }));
      const gpu = (pid) => (pid && g0.has(pid) && g1.has(pid) ? +((100 * (g1.get(pid) - g0.get(pid))) / (secs * 1e9)).toFixed(3) : null);
      const res = { state, secs: +secs.toFixed(1), cpuTotal: +rows.reduce((n, r) => n + (r.cpu || 0), 0).toFixed(2),
        wakeupsTotal: +rows.reduce((n, r) => n + (r.wakeups || 0), 0).toFixed(1), gpuProcGpu: gpu(gpuPid), windowServerGpu: gpu(ws),
        rafPerSec: +((r1.raf - r0.raf) / secs).toFixed(1), drawsPerSec: +((r1.draw - r0.draw) / secs).toFixed(1), page, rows };
      out.states.push(res);
      console.log(JSON.stringify({ state, cpuTotal: res.cpuTotal, wakeups: res.wakeupsTotal, gpu: res.gpuProcGpu, raf: res.rafPerSec, draws: res.drawsPerSec, page, byKind: Object.fromEntries(rows.map((r) => [r.kind, r.cpu])) }));
      await STATES[`${state}End`]?.(ctl);
    }
    const outFile = arg('out', null);
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  } finally {
    kill();
    await sleep(3500);
    fs.rmSync(data, { recursive: true, force: true });
    spawnSync('/usr/bin/security', ['delete-generic-password', '-s', env.CAPRI_KEYCHAIN_SERVICE, '-a', 'master-key'], { stdio: 'ignore' }); // the test service's item
  }
}

(LAUNCH ? launchRun() : singleWindow()).catch((err) => { console.error(err); process.exit(1); });
