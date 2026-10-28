'use strict';

// TAURI-03: opens the overlay and her settings window in WKWebView (macOS only) against the fake
// host, and fails on console errors or a sprite that did not draw.
//   node tools/webkit-check/run.js [--out dir]     PNGs go to tools/webkit-check/out by default

const { spawnSync, spawn } = require('node:child_process');

// async: the server lives in this process and must keep answering while the page loads
const run = (bin, args, limitMs = 120000) => new Promise((resolve) => {
  const p = spawn(bin, args);
  let text = '';
  const timer = setTimeout(() => { text += '\n[timeout] killed after ' + limitMs + ' ms\n'; p.kill('SIGKILL'); }, limitMs);
  process.on('exit', () => p.kill('SIGKILL'));
  p.stdout.on('data', (d) => (text += d));
  p.stderr.on('data', (d) => (text += d));
  p.on('close', (status) => { clearTimeout(timer); resolve({ status: status === null ? 3 : status, text }); });
});
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./server');

const dir = __dirname;
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(dir, 'out'));
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(dir, '.build'), { recursive: true });

if (process.platform !== 'darwin') { console.log('webkit-check/run.js needs macOS (WKWebView); on Linux see .github/workflows/webkit-check.yml'); process.exit(0); }
const bin = path.join(dir, '.build/wkcheck');
if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(path.join(dir, 'wkcheck.swift')).mtimeMs) {
  const r = spawnSync('swiftc', ['-O', path.join(dir, 'wkcheck.swift'), '-o', bin], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}

const SPRITE = 'const r=document.getElementById("sprite").getBoundingClientRect();[r.x,r.y,r.width,r.height]';
const PROBE = `const c=document.getElementById("sprite");const gl=c.getContext("webgl");
let audio;try{const x=new (window.AudioContext||window.webkitAudioContext)();audio=x.state}catch(e){audio="ERR "+e}
window.__fakeEmit("overlay","capri:command",{name:"status"});
return JSON.stringify({webgl:gl&&gl.getParameter(gl.VERSION),lost:gl&&gl.isContextLost(),glError:gl&&gl.getError(),extensions:gl&&gl.getSupportedExtensions().length,audio,structuredClone:typeof structuredClone})`;

(async () => {
  const { server, port } = await start(0);
  const base = `http://127.0.0.1:${port}/src/renderer`;
  const runs = [
    ['settings', ['--url', `${base}/settings.html?fake=1`, '--out', path.join(out, 'settings.png'), '--wait', '2500']],
    ['overlay', ['--url', `${base}/index.html?fake=1`, '--out', path.join(out, 'overlay.png'), '--wait', '14000', '--transparent', '--count-rect', SPRITE, '--eval', PROBE]],
  ];
  let failed = false;
  for (const [name, args] of runs) {
    console.log(`\n== ${name}`);
    const r = await run(bin, args);
    const text = r.text;
    process.stdout.write(text.split('\n').filter((l) => !l.includes('[fake-host')).join('\n'));
    let bad = r.status !== 0;
    const m = /visible=(\d+) of/.exec(text);
    if (name === 'overlay' && (!m || Number(m[1]) < 5000)) { console.log('sprite did not draw'); bad = true; }
    if (bad) failed = true;
  }
  server.close();
  console.log(failed ? '\nWEBKIT CHECK FAILED' : '\nWEBKIT CHECK OK');
  process.exit(failed ? 1 : 0);
})();
