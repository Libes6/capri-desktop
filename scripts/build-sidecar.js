'use strict';

// Builds the Capri sidecar (TAURI-04) as ONE executable per platform, for Tauri's `externalBin`:
//   1. bundle   sidecar/main.js and every file it requires, into one CommonJS file (a small
//               require-inliner below, no dependencies: node builtins stay `require`d, anything else
//               must be a file of this repository)
//   2. sea      Node's single executable application: the running node binary, copied, with the
//               bundle injected as a blob (postject, already in node_modules/.bin)
//   3. out      src-tauri/binaries/capri-sidecar-<target triple>[.exe] (the name Tauri wants)
// Why SEA and what it costs: docs/TAURI_SIDECAR.md.
//
//   node scripts/build-sidecar.js                 bundle + executable for this machine
//   node scripts/build-sidecar.js --bundle-only   just <out>/sidecar.bundle.js (runs with `node`)
//   --out <dir>   where the executable goes (default src-tauri/binaries)
//   --target <triple>   the name's triple (default: rustc's host); the node binary is always THIS machine's,
//                 so a Windows or Linux build has to run on Windows or Linux (CI, TAURI-12)
//
// Only the macOS arm64 path has been run. The Windows and Linux branches below follow Node's SEA
// documentation and are untested.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { builtinModules } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const VIRTUAL = '/$capri'; // where the bundle thinks it lives: __dirname of src/main/core.js is /$capri/src/main

const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec);

function resolveFile(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${path.relative(ROOT, from)}`);
}

// the requires a file makes: require('./x'), and the core's require(path.join(__dirname, 'a', 'b.js'))
function requiresOf(file, source) {
  const found = [];
  for (const m of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) found.push({ spec: m[2] });
  for (const m of source.matchAll(/\brequire\(\s*path\.join\(\s*__dirname\s*,((?:\s*'[^']+'\s*,?)+)\)\s*\)/g)) {
    const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    found.push({ spec: './' + parts.join('/') });
  }
  return found;
}

/** The bundle's source: { source, modules } for `entry` (an absolute file). */
function bundle(entry = path.join(ROOT, 'sidecar', 'main.js')) {
  const modules = new Map(); // absolute file -> source
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (modules.has(file)) continue;
    const source = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
    modules.set(file, source);
    if (file.endsWith('.json')) continue;
    for (const { spec } of requiresOf(file, source)) {
      if (isBuiltin(spec)) continue;
      if (!spec.startsWith('.')) throw new Error(`${path.relative(ROOT, file)} requires ${spec}: only node builtins and repository files go in the sidecar`);
      queue.push(resolveFile(file, spec));
    }
  }
  const virtual = (file) => VIRTUAL + '/' + path.relative(ROOT, file).split(path.sep).join('/');
  const defs = [...modules].map(([file, source]) => {
    const body = file.endsWith('.json') ? `module.exports = ${source.trim()};` : source;
    return `${JSON.stringify(virtual(file))}: function (module, exports, require, __filename, __dirname) {\n${body}\n}`;
  });
  const out = `'use strict';
// Capri sidecar bundle: ${modules.size} files, built by scripts/build-sidecar.js
const __defs = {
${defs.join(',\n')}
};
const __cache = {};
const __builtin = require;
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  const def = __defs[id];
  if (!def) throw new Error('sidecar bundle: no module ' + id);
  const module = (__cache[id] = { exports: {} });
  const dir = id.slice(0, id.lastIndexOf('/'));
  const req = (spec) => {
    if (spec.startsWith('node:') || !/^[./]/.test(spec)) return __builtin(spec);
    const joined = spec.startsWith('/') ? spec : dir + '/' + spec;
    const parts = [];
    for (const p of joined.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
    const base = '/' + parts.join('/');
    for (const c of [base, base + '.js', base + '.json', base + '/index.js']) if (__defs[c]) return __load(c);
    throw new Error('sidecar bundle: cannot find ' + spec + ' from ' + id);
  };
  def(module, module.exports, req, id, dir);
  return module.exports;
}
__load(${JSON.stringify(virtual(entry))});
`;
  return { source: out, modules: [...modules.keys()].map((f) => path.relative(ROOT, f)) };
}

function hostTriple() {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = /^host: (.+)$/m.exec(r.stdout || '');
  if (!m) throw new Error('cannot read the host triple (rustc -vV); pass --target');
  return m[1];
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error})`);
}

function buildExecutable({ bundlePath, outFile, work }) {
  const config = path.join(work, 'sea-config.json');
  const blob = path.join(work, 'sea-prep.blob');
  fs.writeFileSync(config, JSON.stringify({ main: bundlePath, output: blob, disableExperimentalSEAWarning: true }));
  run(process.execPath, ['--experimental-sea-config', config]);
  fs.copyFileSync(process.execPath, outFile);
  fs.chmodSync(outFile, 0o755);
  if (process.platform === 'darwin') spawnSync('codesign', ['--remove-signature', outFile], { stdio: 'inherit' });
  const postject = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  const args = [outFile, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  run(postject, args, { shell: process.platform === 'win32' });
  // macOS refuses an unsigned arm64 binary; ad-hoc here, the release signing is TAURI-12's
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', outFile]);
}

function main(argv = process.argv.slice(2)) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const out = path.resolve(arg('--out') || path.join(ROOT, 'src-tauri', 'binaries'));
  fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const { source, modules } = bundle();
  const bundlePath = path.join(out, 'sidecar.bundle.js');
  fs.writeFileSync(bundlePath, source);
  console.log(`bundle: ${modules.length} files, ${(source.length / 1024).toFixed(0)} KB -> ${path.relative(ROOT, bundlePath)}`);
  if (argv.includes('--bundle-only')) return;
  const triple = arg('--target') || hostTriple();
  const outFile = path.join(out, `capri-sidecar-${triple}${process.platform === 'win32' ? '.exe' : ''}`);
  const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'capri-sea-'));
  try {
    buildExecutable({ bundlePath, outFile, work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`executable: ${path.relative(ROOT, outFile)} ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { bundle, requiresOf };
