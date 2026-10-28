#!/usr/bin/env node
'use strict';
// Idle CPU / GPU / wakeups of the Tauri spike, same method as scripts/perf-probe.js of the Electron app
// (ps cputime deltas, top idlew/power, ioreg AGXDeviceUserClient accumulatedGPUTime). macOS only.
//   node scripts/perf-probe.js --pid <spike pid> --stdin <fifo the spike reads> --log <spike log> [--secs 45]
// The spike's WebKit helpers (Web Content, GPU, Networking) are XPC services, not children of the app:
// they are found through `lsappinfo`, which names them "<app> Web Content" etc.
const fs = require('node:fs');
const { execFileSync, execFile } = require('node:child_process');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PID = Number(arg('pid')); const SECS = Number(arg('secs', 45)); const FIFO = arg('stdin'); const LOG = arg('log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseTime = (t) => t.split(':').reduce((a, p) => a * 60 + Number(p), 0);

function helperPids() {
  const out = execFileSync('lsappinfo', ['list']).toString();
  const pids = new Map([[PID, 'main']]);
  for (const block of out.split(/\n(?=\s*\d+\) )/)) {
    const m = block.match(/^\s*\d+\) "([^"]+)"/); const p = block.match(/pid = (\d+)/);
    if (!m || !p) continue;
    if (m[1].startsWith('capri-overlay-spike ')) pids.set(Number(p[1]), m[1].slice('capri-overlay-spike '.length));
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
async function pageStats() {
  const tag = `STATS${Date.now()}`;
  fs.writeFileSync(FIFO, `window.__TAURI__.core.invoke("log",{msg:"${tag} "+JSON.stringify(__spike.snapshot())})\n`);
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const m = fs.readFileSync(LOG, 'utf8').split('\n').find((l) => l.includes(tag));
    if (m) return JSON.parse(m.slice(m.indexOf(tag) + tag.length + 1));
  }
  return null;
}
const spikeTicks = () => { const l = fs.readFileSync(LOG, 'utf8').split('\n').filter((x) => x.includes('stats ticks=')).pop() || ''; return Number((l.match(/ticks=(\d+)/) || [])[1] || 0); };

(async () => {
  const pids = helperPids();
  const ws = Number(execFileSync('pgrep', ['-x', 'WindowServer']).toString().trim().split('\n')[0]);
  const gpuPid = [...pids].find(([, k]) => k === 'Graphics and Media')?.[0];
  console.log('processes:', JSON.stringify([...pids]));
  await sleep(10000); // warm-up
  const c0 = cpuOf(pids), g0 = gpuTimes(), s0 = await pageStats(); const t0 = Date.now();
  const tp = await top([...pids.keys()], SECS);
  const secs = (Date.now() - t0) / 1000;
  const c1 = cpuOf(pids), g1 = gpuTimes(), s1 = await pageStats();
  const rows = [...pids].map(([pid, kind]) => ({ kind, pid, rssMB: Math.round((c1.get(pid)?.rss || 0) / 1024),
    cpuPct: c0.has(pid) && c1.has(pid) ? +((100 * (c1.get(pid).cpu - c0.get(pid).cpu)) / secs).toFixed(2) : null,
    wakeups: tp.get(pid) ? +tp.get(pid).wakeups.toFixed(1) : null, power: tp.get(pid)?.power ?? null }));
  const gpu = (pid) => (pid && g0.has(pid) && g1.has(pid) ? +((100 * (g1.get(pid) - g0.get(pid))) / (secs * 1e9)).toFixed(3) : null);
  console.log(JSON.stringify({
    secs: +secs.toFixed(1), cpuTotalPct: +rows.reduce((n, r) => n + (r.cpuPct || 0), 0).toFixed(2),
    wakeupsTotal: +rows.reduce((n, r) => n + (r.wakeups || 0), 0).toFixed(1),
    gpuProcessGpuPct: gpu(gpuPid), windowServerGpuPct: gpu(ws),
    drawsPerSec: s0 && s1 ? +((s1.draws - s0.draws) / ((s1.t - s0.t) / 1000)).toFixed(1) : null,
    rafPerSec: s0 && s1 ? +((s1.rafs - s0.rafs) / ((s1.t - s0.t) / 1000)).toFixed(1) : null,
    rows,
  }, null, 1));
})();
