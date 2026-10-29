'use strict';

// Packages the Tauri build (TAURI-12): `npm run tauri:package`. No @tauri-apps/cli in the project: the CLI is
// `cargo tauri` (cargo install tauri-cli --version '^2'), or the binary CAPRI_TAURI_CLI names.
//
//   node scripts/package-tauri.js [--collect <dir>] [--bundles app,dmg] [--no-updates] [--require-updates] [--skip-build]
//   node scripts/package-tauri.js verify [--target-dir <dir>]      only check what an earlier run left
//
// Order (each step is this machine's: Node SEA and the helpers cannot be cross-built):
//   1. stage her pages               scripts/stage-frontend.js
//   2. the sidecar                   scripts/build-sidecar.js -> src-tauri/binaries/capri-sidecar-<triple>[.exe]  (externalBin)
//   3. capri-hook                    cargo build --release in crates/capri-hook  -> src-tauri/resources/bin/capri-hook[.exe]
//   4. window helpers                macOS: scripts/build-mac-helper.js (capri-windows, --required) -> resources/bin/;
//                                    Windows: src/main/windows.ps1 -> resources/windows.ps1
//   5. cargo tauri build             merged: tauri.bundle.conf.json (externalBin, Entitlements, ad-hoc identity),
//                                    the resources map made here, and (when CAPRI_UPDATER_PUBLIC_KEY is set)
//                                    scripts/updater-config.js; signs the update packages with TAURI_SIGNING_PRIVATE_KEY
//   6. verify                        the sidecar, capri-hook and the helper are really in the package
//   7. --collect <dir>               copies the installers and the update package with its .sig into <dir>/<platform>/
//                                    (the layout scripts/release-manifest.js reads)
// Without CAPRI_UPDATER_PUBLIC_KEY the build has updates off (updater.rs: disabled `feed`) and says so.
// With the public key the private key MUST be there too: a build that would claim updates but cannot sign is refused.
// Environment: CARGO_TARGET_DIR, CAPRI_TAURI_CLI, CAPRI_UPDATER_PUBLIC_KEY, TAURI_SIGNING_PRIVATE_KEY[_PASSWORD],
// CAPRI_APP_IDENTIFIER (a test identifier: the single-instance socket is named after it).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { stage } = require('./stage-frontend');
const { updaterConfig } = require('./updater-config');
const { bridgeEnabled } = require('./bridge-feed');

const ROOT = path.resolve(__dirname, '..');
const TAURI = path.join(ROOT, 'src-tauri');
const RESOURCES = path.join(TAURI, 'resources');
const BINARIES = path.join(TAURI, 'binaries');

// platform key = the key of latest.json
const PLATFORMS = {
  'darwin-aarch64': { os: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', bundles: ['app', 'dmg'] },
  'darwin-x86_64': { os: 'darwin', arch: 'x64', triple: 'x86_64-apple-darwin', bundles: ['app', 'dmg'] },
  'windows-x86_64': { os: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', bundles: ['nsis'] },
  'linux-x86_64': { os: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu', bundles: ['appimage', 'deb'] },
};

function platformOf(os = process.platform, arch = process.arch) {
  const key = Object.keys(PLATFORMS).find((k) => PLATFORMS[k].os === os && PLATFORMS[k].arch === arch);
  if (!key) throw new Error(`no Tauri package for ${os}/${arch}`);
  return key;
}

const exeSuffix = (platform) => (PLATFORMS[platform].os === 'win32' ? '.exe' : '');

/** The names externalBin wants for a target: binaries/capri-sidecar-<triple>[.exe]. */
const sidecarFile = (platform) => `capri-sidecar-${PLATFORMS[platform].triple}${exeSuffix(platform)}`;

/** { source (relative to src-tauri) -> destination in the app's resources } for a platform. */
function resourcesMap(platform) {
  const map = { [`resources/bin/capri-hook${exeSuffix(platform)}`]: `bin/capri-hook${exeSuffix(platform)}` };
  if (PLATFORMS[platform].os === 'darwin') map['resources/bin/capri-windows'] = 'bin/capri-windows';
  if (PLATFORMS[platform].os === 'win32') map['resources/windows.ps1'] = 'windows.ps1';
  return map;
}

/** The part of the configuration made here (merged after tauri.bundle.conf.json). */
function resourcesConfig(platform, { identifier } = {}) {
  return { ...(identifier && { identifier }), bundle: { resources: resourcesMap(platform) } };
}

/**
 * What a finished package must hold, as paths relative to the package root:
 * darwin: Capri.app; linux: the .deb's file list; windows: the NSIS installer's file list.
 */
function expectedFiles(platform) {
  const x = exeSuffix(platform);
  switch (PLATFORMS[platform].os) {
    case 'darwin':
      return ['Contents/MacOS/capri', 'Contents/MacOS/capri-sidecar', 'Contents/Resources/bin/capri-hook', 'Contents/Resources/bin/capri-windows', 'Contents/Info.plist'];
    case 'win32':
      return [`capri${x}`, `capri-sidecar${x}`, `bin/capri-hook${x}`, 'windows.ps1'];
    default:
      return ['usr/bin/capri', 'usr/bin/capri-sidecar', `bin/capri-hook${x}`];
  }
}

/** Fails for any `expected` path that no entry of `listing` ends with (a listing's entries may carry a prefix). */
function missingFrom(listing, expected) {
  const entries = listing.map((e) => String(e).replace(/\\/g, '/').replace(/^\.\//, ''));
  return expected.filter((want) => !entries.some((e) => e === want || e.endsWith(`/${want}`)));
}

function listDir(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), r); else out.push(r);
    }
  };
  walk(root, '');
  return out;
}

const targetDir = () => process.env.CARGO_TARGET_DIR || path.join(TAURI, 'target');
const bundleDir = (target = targetDir()) => path.join(target, 'release', 'bundle');

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (${r.status ?? r.error})`);
}

function tauriCli() {
  const cli = process.env.CAPRI_TAURI_CLI;
  if (!cli) return ['cargo', ['tauri']];
  // a Windows path given without the extension (cargo install --root puts cargo-tauri.exe there)
  return [!fs.existsSync(cli) && fs.existsSync(`${cli}.exe`) ? `${cli}.exe` : cli, []];
}

/** The files of a finished package, per system, read WITHOUT installing it. */
function packageListing(platform, files) {
  const os = PLATFORMS[platform].os;
  if (os === 'darwin') return listDir(files.app);
  if (os === 'linux') {
    const text = execFileSync('dpkg-deb', ['-c', files.deb], { encoding: 'utf8', maxBuffer: 64 << 20 });
    return text.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
  }
  const seven = ['7z', '7za', '7zz'].find((c) => spawnSync(c, ['i'], { stdio: 'ignore' }).status === 0);
  if (!seven) return null;
  const text = execFileSync(seven, ['l', '-slt', files.nsis], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return [...text.matchAll(/^Path = (.+)$/gm)].map((m) => m[1]);
}

/** Where the bundler leaves things. → { app, dmg, deb, appimage, nsis, updater: { file, sig } } (what exists). */
function findOutputs(platform, dir = bundleDir()) {
  const pick = (sub, test) => {
    const folder = path.join(dir, sub);
    if (!fs.existsSync(folder)) return null;
    const hit = fs.readdirSync(folder).filter(test);
    if (hit.length > 1) throw new Error(`more than one file in ${folder}: ${hit.join(', ')}`);
    return hit.length ? path.join(folder, hit[0]) : null;
  };
  const os = PLATFORMS[platform].os;
  const out = {};
  if (os === 'darwin') {
    out.app = pick('macos', (n) => n.endsWith('.app'));
    out.dmg = pick('dmg', (n) => n.endsWith('.dmg'));
    out.updater = pick('macos', (n) => n.endsWith('.app.tar.gz'));
  } else if (os === 'win32') {
    out.nsis = pick('nsis', (n) => n.endsWith('-setup.exe'));
    out.updater = out.nsis;
  } else {
    out.appimage = pick('appimage', (n) => n.endsWith('.AppImage'));
    out.deb = pick('deb', (n) => n.endsWith('.deb'));
    out.updater = out.appimage;
  }
  return out;
}

function verify(platform, dir = bundleDir(), { log = console.log } = {}) {
  const files = findOutputs(platform, dir);
  const main = { darwin: files.app, win32: files.nsis, linux: files.deb }[PLATFORMS[platform].os];
  if (!main) throw new Error(`no package in ${dir} to check`);
  const listing = packageListing(platform, files);
  if (!listing) {
    log('::warning::7-Zip not found: the contents of the installer were not listed');
    return files;
  }
  const missing = missingFrom(listing, expectedFiles(platform));
  // 7-Zip's view of an NSIS installer: if it does not even show the program, its listing format is not the one this
  // check knows, which is a warning (the CI also installs and starts the package), not a broken package
  if (missing.length && PLATFORMS[platform].os === 'win32' && missing.includes('capri.exe')) {
    log(`::warning::could not read the NSIS installer's file list with 7-Zip (${listing.length} entries); contents not checked`);
    return files;
  }
  if (missing.length) throw new Error(`the package lacks: ${missing.join(', ')}`);
  if (PLATFORMS[platform].os === 'darwin') {
    execFileSync('codesign', ['--verify', '--deep', '--strict', files.app]);
    const ent = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path.join(files.app, 'Contents', 'MacOS', 'capri-sidecar')], { encoding: 'utf8' });
    const text = `${ent.stdout}${ent.stderr}`;
    if (!/allow-jit/.test(text) || !/allow-unsigned-executable-memory/.test(text)) throw new Error('the sidecar is signed without the JIT entitlements (Node would die with SIGTRAP)');
  }
  log(`package verified: ${expectedFiles(platform).length} paths present in ${path.basename(main)}`);
  return files;
}

/**
 * The bridge zip (TAURI-13): the Tauri Capri.app zipped with ditto (`--keepParent`: the .app is the one folder in the zip), the
 * shape src/main/mac-update.js of the Electron build unpacks. Apple Silicon only (the Electron build never had another Mac).
 */
function bridgeZip(app, out, { exec = execFileSync } = {}) {
  const zip = path.join(out, `${path.basename(app, '.app')}-bridge.zip`);
  fs.rmSync(zip, { force: true });
  exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  return zip;
}

/** Copies what a release needs into <dest>/<platform>/. */
function collect(platform, dest, dir = bundleDir(), { bridge = bridgeEnabled() } = {}) {
  const files = findOutputs(platform, dir);
  const out = path.join(dest, platform);
  fs.mkdirSync(out, { recursive: true });
  const copied = [];
  for (const file of [files.dmg, files.deb, files.updater, files.updater && `${files.updater}.sig`]) {
    if (!file) continue;
    if (!fs.existsSync(file)) throw new Error(`missing: ${file}${file.endsWith('.sig') ? ' (was TAURI_SIGNING_PRIVATE_KEY set?)' : ''}`);
    fs.copyFileSync(file, path.join(out, path.basename(file)));
    copied.push(path.basename(file));
  }
  if (bridge && platform === 'darwin-aarch64') {
    if (!files.app) throw new Error('the bridge zip needs Capri.app');
    copied.push(path.basename(bridgeZip(files.app, out)));
  }
  return copied;
}

function buildHook(platform, target) {
  const cargoTarget = process.env.CAPRI_HOOK_TARGET_DIR || path.join(target, 'capri-hook');
  run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(ROOT, 'crates', 'capri-hook', 'Cargo.toml'), '--target-dir', cargoTarget]);
  const from = path.join(cargoTarget, 'release', `capri-hook${exeSuffix(platform)}`);
  const to = path.join(RESOURCES, 'bin', `capri-hook${exeSuffix(platform)}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
}

function stageHelpers(platform) {
  const os = PLATFORMS[platform].os;
  if (os === 'darwin') {
    run(process.execPath, [path.join(__dirname, 'build-mac-helper.js'), '--required', '--arch', PLATFORMS[platform].arch, '--force']);
    fs.mkdirSync(path.join(RESOURCES, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'src', 'main', 'mac', 'bin', 'capri-windows'), path.join(RESOURCES, 'bin', 'capri-windows'));
    fs.chmodSync(path.join(RESOURCES, 'bin', 'capri-windows'), 0o755);
  } else if (os === 'win32') {
    fs.copyFileSync(path.join(ROOT, 'src', 'main', 'windows.ps1'), path.join(RESOURCES, 'windows.ps1'));
  }
}

function main(argv = process.argv.slice(2)) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const platform = platformOf();
  const log = console.log;
  if (argv[0] === 'verify') { verify(platform, bundleDir(arg('--target-dir') || targetDir())); return; }

  const publicKey = (process.env.CAPRI_UPDATER_PUBLIC_KEY || '').trim();
  const updates = !argv.includes('--no-updates') && publicKey !== '';
  if (argv.includes('--require-updates') && !updates) throw new Error('--require-updates: CAPRI_UPDATER_PUBLIC_KEY is not set (a release build must have updates on)');
  if (updates && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error('CAPRI_UPDATER_PUBLIC_KEY is set but TAURI_SIGNING_PRIVATE_KEY is not: the update packages could not be signed');
  }
  if (!updates) log('::warning::this package has updates OFF (no CAPRI_UPDATER_PUBLIC_KEY / --no-updates): installed copies will not update from it');

  const t0 = Date.now();
  if (!argv.includes('--skip-build')) {
    const { fonts } = stage();
    log(`[1/6] staged her pages (${fonts} font files)`);
    run(process.execPath, [path.join(__dirname, 'build-sidecar.js'), '--target', PLATFORMS[platform].triple]);
    if (!fs.existsSync(path.join(BINARIES, sidecarFile(platform)))) throw new Error(`the sidecar ${sidecarFile(platform)} was not made`);
    fs.rmSync(RESOURCES, { recursive: true, force: true });
    buildHook(platform, targetDir());
    stageHelpers(platform);
    for (const src of Object.keys(resourcesMap(platform))) {
      if (!fs.existsSync(path.join(TAURI, src))) throw new Error(`resource not staged: ${src}`);
    }

    const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'capri-package-'));
    try {
      const configs = [path.join(TAURI, 'tauri.bundle.conf.json')];
      const resourcesFile = path.join(work, 'resources.conf.json');
      fs.writeFileSync(resourcesFile, JSON.stringify(resourcesConfig(platform, { identifier: process.env.CAPRI_APP_IDENTIFIER })));
      configs.push(resourcesFile);
      if (updates) {
        const updaterFile = path.join(work, 'updater.conf.json');
        fs.writeFileSync(updaterFile, JSON.stringify(updaterConfig({ publicKey })));
        configs.push(updaterFile);
      }
      const bundles = (arg('--bundles') || PLATFORMS[platform].bundles.join(','));
      const [bin, pre] = tauriCli();
      const env = { ...process.env };
      if (PLATFORMS[platform].os === 'darwin') {
        // ad-hoc (signingIdentity "-" in the bundle config): paid identities are not used by this pipeline
        for (const name of ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_CERTIFICATE']) delete env[name];
      }
      run(bin, [...pre, 'build', '--bundles', bundles, ...configs.flatMap((c) => ['--config', c])], { cwd: TAURI, env });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  log('[verify]');
  verify(platform);
  const dest = arg('--collect');
  if (dest) log(`collected into ${path.join(path.resolve(dest), platform)}: ${collect(platform, path.resolve(dest)).join(', ')}`);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s, updates ${updates ? 'ON' : 'OFF'}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`package-tauri: ${err.message}`); process.exit(1); }
}

module.exports = { PLATFORMS, platformOf, sidecarFile, resourcesMap, resourcesConfig, expectedFiles, missingFrom, findOutputs, collect, bridgeZip, verify };
