'use strict';

// The bridge release (TAURI-13, docs/TAURI_BRIDGE.md): the Electron build's own updater (electron-updater, CAPRI-11) reads
// latest.yml / latest-linux.yml / latest-mac.yml of the latest published release. In a bridge release these point at the
// TAURI installers, so that an installed Electron Capri updates itself into the Tauri one:
//
//   latest.yml        -> Capri-X-Windows-x64-setup.exe      (the Tauri NSIS installer: electron-updater runs it as
//                                                            `<exe> --updated /S --force-run`; src-tauri/windows/hooks.nsh takes care of the rest)
//   latest-linux.yml  -> Capri-X-Linux-x64.AppImage         (electron-updater replaces the file $APPIMAGE points to)
//   latest-mac.yml    -> Capri-X-macOS-arm64-bridge.zip     (a zip of the Tauri Capri.app made with ditto: src/main/mac-update.js
//                                                            downloads, checks size/sha512/bundle id/version/signature and swaps the bundle)
//
// Each yml carries `capriBridge: tauri` (the Electron side prepares the key hand-over only for an update that has it AND names
// only Tauri files: src/main/updates.js isTauriBridge). The files are the release's own Tauri files: sha512 (base64) and size
// are computed from the bytes that are going to be uploaded. No blockmaps: electron-updater falls back to a full download.
//
//   node scripts/bridge-feed.js <release folder> <version> [--date <iso>]     writes the three ymls into the folder
//   bridge.json  { "tauri": true }  turns the bridge on for a release build (the Tauri job writes the ymls and the Electron job
//                does not); CAPRI_BRIDGE=1|0 overrides it (tests, a trial run).

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// the electron-updater feed file of each system, and the Tauri file it offers
const FEEDS = {
  'latest.yml': { os: 'Windows', name: (v) => `Capri-${v}-Windows-x64-setup.exe`, ext: '.exe' },
  'latest-linux.yml': { os: 'Linux', name: (v) => `Capri-${v}-Linux-x64.AppImage`, ext: '.AppImage' },
  'latest-mac.yml': { os: 'macOS', name: (v) => `Capri-${v}-macOS-arm64-bridge.zip`, ext: '.zip' },
};
const FEED_FILES = Object.keys(FEEDS);

/** The zip of the Tauri Capri.app the Mac bridge offers (Electron builds only ever existed for Apple Silicon). */
const bridgeZipName = (version) => FEEDS['latest-mac.yml'].name(version);

/** Is the bridge on? CAPRI_BRIDGE=1|0 wins, else bridge.json { "tauri": true } in the repository. */
function bridgeEnabled({ root = ROOT, env = process.env } = {}) {
  if (env.CAPRI_BRIDGE === '1') return true;
  if (env.CAPRI_BRIDGE === '0') return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'bridge.json'), 'utf8')).tauri === true;
  } catch {
    return false;
  }
}

function digest(file) {
  const bytes = fs.readFileSync(file);
  return { sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
}

/** The text of one feed, in electron-builder's shape (it reads it with js-yaml; unknown fields are kept in updateInfo). */
function feedText({ version, name, sha512, size, date }) {
  if (!SEMVER.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (Number.isNaN(Date.parse(date))) throw new Error(`Invalid release date: ${date}`);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date(date).toISOString()}'`,
    'capriBridge: tauri',
    '',
  ].join('\n');
}

/** The few fields of a feed this file writes (not a YAML parser: the shape above, one file). */
function parseFeed(text) {
  const field = (re) => (text.match(re) || [])[1];
  const files = [...text.matchAll(/^ {2}- url: (.+)\n {4}sha512: (.+)\n {4}size: (\d+)$/gm)].map((m) => ({ url: m[1].trim(), sha512: m[2].trim(), size: Number(m[3]) }));
  return {
    version: field(/^version: (.+)$/m)?.trim(),
    path: field(/^path: (.+)$/m)?.trim(),
    sha512: field(/^sha512: (.+)$/m)?.trim(),
    bridge: field(/^capriBridge: (.+)$/m)?.trim(),
    files,
  };
}

/** Writes latest.yml, latest-linux.yml and latest-mac.yml into `dir` from the Tauri files that are there. → their names. */
function buildFeeds({ dir, version, date = new Date().toISOString() }) {
  if (!SEMVER.test(version)) throw new Error(`Invalid release version: ${version}`);
  const texts = {};
  for (const [feed, spec] of Object.entries(FEEDS)) {
    const name = spec.name(version);
    const file = path.join(dir, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${feed}: ${name} is not in ${dir}`);
    const { sha512, size } = digest(file);
    if (!size) throw new Error(`${feed}: ${name} is empty`);
    texts[feed] = feedText({ version, name, sha512, size, date }); // all checked before any is written
  }
  for (const [feed, text] of Object.entries(texts)) fs.writeFileSync(path.join(dir, feed), text);
  return FEED_FILES;
}

/** Checks the three feeds of a folder as a release would carry them. Throws with the reason. */
function checkFeeds(dir, version) {
  for (const [feed, spec] of Object.entries(FEEDS)) {
    let text;
    try { text = fs.readFileSync(path.join(dir, feed), 'utf8'); } catch { throw new Error(`Missing ${feed}`); }
    const info = parseFeed(text);
    if (info.version !== version) throw new Error(`${feed} is for ${info.version}, not ${version}`);
    if (info.bridge !== 'tauri') throw new Error(`${feed} is not marked capriBridge: tauri`);
    const name = spec.name(version);
    if (info.files.length !== 1 || info.files[0].url !== name || info.path !== name) throw new Error(`${feed} must offer ${name} and nothing else`);
    const file = path.join(dir, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${feed} names ${name}, which is not in the release`);
    const { sha512, size } = digest(file);
    if (info.files[0].sha512 !== sha512 || info.sha512 !== sha512) throw new Error(`${feed}: sha512 of ${name} does not match`);
    if (info.files[0].size !== size) throw new Error(`${feed}: size of ${name} does not match`);
  }
  return FEED_FILES;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const date = args.includes('--date') ? args.splice(args.indexOf('--date'), 2)[1] : undefined;
  const [dir, version] = args;
  if (!dir || !version) {
    console.error('usage: node scripts/bridge-feed.js <release folder> <version> [--date <iso>]');
    process.exit(2);
  }
  try {
    console.log(`bridge feeds for ${version}: ${buildFeeds({ dir: path.resolve(dir), version, ...(date && { date }) }).join(', ')}`);
  } catch (err) {
    console.error(`bridge-feed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { FEEDS, FEED_FILES, bridgeEnabled, bridgeZipName, feedText, parseFeed, buildFeeds, checkFeeds };
