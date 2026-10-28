'use strict';

// npm run tauri:dev | tauri:build | tauri:test (TAURI-04). No @tauri-apps/cli: the shell is a plain
// Cargo project (src-tauri/), her pages are staged by scripts/stage-frontend.js, and the sidecar is
// run with `node` in dev and built as one executable (scripts/build-sidecar.js) for a build.
//
//   dev     stage her pages, cargo build, run the app (the sidecar is `node sidecar/main.js`)
//   build   stage, build the sidecar executable, cargo build --release
//   test    cargo test
// Environment: CARGO_TARGET_DIR (default: src-tauri/target, ignored by git), CAPRI_USER_DATA (another
// profile), CAPRI_PORT (the hooks bridge), CAPRI_NODE (which node runs the sidecar in dev), CAPRI_ROOT.

const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { stage } = require('./stage-frontend');

const ROOT = path.resolve(__dirname, '..');
const TAURI = path.join(ROOT, 'src-tauri');
const exe = process.platform === 'win32' ? '.exe' : '';

function cargo(args) {
  const r = spawnSync('cargo', args, { cwd: TAURI, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

const targetDir = () => process.env.CARGO_TARGET_DIR || path.join(TAURI, 'target');

function main(command) {
  if (command === 'test') return cargo(['test']);
  if (command !== 'dev' && command !== 'build') {
    console.error('usage: node scripts/tauri.js dev|build|test');
    process.exit(2);
  }
  const { fonts } = stage();
  console.log(`staged her pages (${fonts} font files)`);
  if (command === 'build') {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'build-sidecar.js')], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
    cargo(['build', '--release']);
    console.log(`built: ${path.join(targetDir(), 'release', 'capri' + exe)} (+ src-tauri/binaries/capri-sidecar-*; the .app / installers are TAURI-12)`);
    return;
  }
  cargo(['build']);
  const child = spawn(path.join(targetDir(), 'debug', 'capri' + exe), process.argv.slice(3), { stdio: 'inherit', env: { ...process.env, CAPRI_ROOT: ROOT } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}

main(process.argv[2]);
