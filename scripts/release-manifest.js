'use strict';

// The feed of the Tauri build's updater (TAURI-10, docs/TAURI_UPDATES.md): latest.json, written from
// the signed update packages the bundler produced, as Gustaf's scripts/release-manifest.mjs.
//
//   node scripts/release-manifest.js <artifacts> <version> [--notes <file>] [--out <dir>]
//
// <artifacts>/<platform>/ holds, per platform (darwin-aarch64, windows-x86_64, linux-x86_64, and
// darwin-x86_64 if there is one), the one update package the bundler made and its `.sig`:
//   darwin  *.app.tar.gz     windows  *-setup.exe (NSIS)     linux  *.AppImage
// <out> (default <artifacts>/release) gets the packages under the release's names, their `.sig`,
// SHA256SUMS and latest.json. Packages are copied byte for byte (the signature is of the bytes).
// No key is read or needed: a signature is the public text of a `.sig` file. A missing platform, an
// empty or odd signature, two packages for a platform: it fails and writes nothing.
// The URLs point to the release's own tag (fork-vX.Y.Z), never to /latest/: a feed must keep
// meaning the same files after a newer release is published.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const OWNER = 'Libes6';
const REPO = 'capri-desktop';
const TAG_PREFIX = 'fork-v';
const REQUIRED = ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64'];
const OPTIONAL = ['darwin-x86_64'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// where a platform's package comes from, and what it is called in the release
const KINDS = {
  'darwin-aarch64': { find: (n) => n.endsWith('.app.tar.gz'), release: (v) => `Capri-${v}-macOS-arm64.app.tar.gz` },
  'darwin-x86_64': { find: (n) => n.endsWith('.app.tar.gz'), release: (v) => `Capri-${v}-macOS-x64.app.tar.gz` },
  'windows-x86_64': { find: (n) => n.endsWith('-setup.exe'), release: (v) => `Capri-${v}-Windows-x64-setup.exe` },
  'linux-x86_64': { find: (n) => n.endsWith('.AppImage'), release: (v) => `Capri-${v}-Linux-x64.AppImage` },
};

/** Capri-<version>-<OS>-<arch>.<ext>, the Tauri names (the Electron release's are lower-case: mac, win, linux). */
function assetName(version, platform) {
  const kind = KINDS[platform];
  if (!kind) throw new Error(`Unknown platform: ${platform}`);
  return kind.release(version);
}

/** fork-v0.3.0 -> 0.3.0 */
function versionFromTag(tag) {
  const version = String(tag).startsWith(TAG_PREFIX) ? String(tag).slice(TAG_PREFIX.length) : null;
  if (!version || !SEMVER.test(version)) throw new Error(`Not a release tag (${TAG_PREFIX}X.Y.Z): ${tag}`);
  return version;
}

/**
 * assets: { [platform]: { name, signature } } (name: the asset's file name in the release).
 * → the latest.json object. Throws for anything that would make a feed that cannot be trusted.
 */
function manifest(version, assets, { notes = '', date = new Date().toISOString(), tagPrefix = TAG_PREFIX } = {}) {
  if (!SEMVER.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (Number.isNaN(Date.parse(date))) throw new Error(`Invalid release date: ${date}`);
  const platforms = {};
  const names = new Set();
  for (const platform of [...REQUIRED, ...OPTIONAL]) {
    const asset = assets?.[platform];
    if (!asset && OPTIONAL.includes(platform)) continue;
    const signature = typeof asset?.signature === 'string' ? asset.signature.trim() : '';
    if (!asset?.name || !KINDS[platform].find(asset.name) || !signature || !BASE64.test(signature)) {
      throw new Error(`Missing or invalid signed package: ${platform}`);
    }
    if (names.has(asset.name)) throw new Error(`The same package for two platforms: ${asset.name}`);
    names.add(asset.name);
    platforms[platform] = {
      signature,
      url: `https://github.com/${OWNER}/${REPO}/releases/download/${tagPrefix}${version}/${encodeURIComponent(asset.name)}`,
    };
  }
  return { version, notes: String(notes ?? ''), pub_date: new Date(date).toISOString(), platforms };
}

/** The one package of a platform in `dir` and its signature text. */
function collect(dir, platform) {
  const folder = path.join(dir, platform);
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Missing folder: ${folder}`);
  const found = fs.readdirSync(folder).filter((n) => KINDS[platform].find(n));
  if (found.length !== 1) throw new Error(`Expected one update package in ${folder}, found ${found.length}`);
  const file = path.join(folder, found[0]);
  if (!fs.statSync(file).size) throw new Error(`Empty package: ${file}`);
  const sig = `${file}.sig`;
  if (!fs.statSync(sig, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing signature: ${found[0]}.sig`);
  return { file, signature: fs.readFileSync(sig, 'utf8') };
}

function build({ artifacts, version, notes = '', out = path.join(artifacts, 'release'), date }) {
  const picked = {};
  for (const platform of [...REQUIRED, ...OPTIONAL]) {
    if (OPTIONAL.includes(platform) && !fs.existsSync(path.join(artifacts, platform))) continue;
    const { file, signature } = collect(artifacts, platform);
    picked[platform] = { file, name: assetName(version, platform), signature };
  }
  const feed = manifest(version, picked, { notes, date }); // validates before anything is written
  fs.mkdirSync(out, { recursive: true });
  const sums = [];
  for (const { file, name, signature } of Object.values(picked)) {
    fs.copyFileSync(file, path.join(out, name));
    fs.writeFileSync(path.join(out, `${name}.sig`), signature.trim() + '\n');
    sums.push(`${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${name}`);
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  return { feed, out };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const notesFile = option('--notes');
  const out = option('--out');
  const [artifacts, version] = args;
  if (!artifacts || !version) {
    console.error('usage: node scripts/release-manifest.js <artifacts> <version> [--notes <file>] [--out <dir>]');
    process.exit(2);
  }
  try {
    const result = build({ artifacts: path.resolve(artifacts), version, notes: notesFile ? fs.readFileSync(notesFile, 'utf8') : '', ...(out && { out: path.resolve(out) }) });
    console.log(`latest.json for ${version}: ${Object.keys(result.feed.platforms).join(', ')} -> ${result.out}`);
  } catch (err) {
    console.error(`release-manifest: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { manifest, assetName, versionFromTag, collect, build, REQUIRED, OPTIONAL, TAG_PREFIX };
