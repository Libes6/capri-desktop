'use strict';

// Builds the macOS window helper (src/main/mac/capri-windows.swift) into src/main/mac/bin/, where
// mac/window-watch.js looks for it; scripts/package-tauri.js puts it into the macOS bundle's Resources/bin. Needs the Xcode Command Line Tools (swiftc); no npm dependency.
//
//   node scripts/build-mac-helper.js [--arch arm64|x64] [--required] [--force]
//
// Off macOS it does nothing. Without swiftc it says so and leaves Capri without window tracking
// (her base overlay), unless --required (packaging), where that is an error.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'main', 'mac', 'capri-windows.swift');
const OUT = path.join(ROOT, 'src', 'main', 'mac', 'bin', 'capri-windows');
const TARGETS = { arm64: 'arm64-apple-macos12.0', x64: 'x86_64-apple-macos12.0' };

// one arch per build: the one the binary already is, if it is that one (lipo -archs)
function archOf(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function buildMacHelper({ arch = process.arch, required = false, force = false, log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    log('[mac-helper] not on macOS: skipped');
    return null;
  }
  const target = TARGETS[arch];
  if (!target) throw new Error(`[mac-helper] unsupported arch: ${arch}`);
  const want = arch === 'x64' ? 'x86_64' : arch;
  const fresh = fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SOURCE).mtimeMs && archOf(OUT) === want;
  if (fresh && !force) {
    log(`[mac-helper] up to date: ${path.relative(ROOT, OUT)} (${want})`);
    return OUT;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  try {
    execFileSync('swiftc', ['-O', '-target', target, '-o', OUT, SOURCE], { stdio: 'inherit' });
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'swiftc not found (xcode-select --install)' : err.message;
    if (required) throw new Error(`[mac-helper] build failed: ${why}`);
    log(`[mac-helper] not built, windows will not be tracked: ${why}`);
    return null;
  }
  log(`[mac-helper] built ${path.relative(ROOT, OUT)} (${want})`);
  return OUT;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--arch');
  try {
    buildMacHelper({ arch: at >= 0 ? args[at + 1] : process.arch, required: args.includes('--required'), force: args.includes('--force') });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { buildMacHelper, OUT, SOURCE };
