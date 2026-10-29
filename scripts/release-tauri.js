'use strict';

// The release half of the Tauri pipeline (TAURI-12, docs/TAURI_RELEASE.md), run by .github/workflows/tauri-release.yml.
//
//   node scripts/release-tauri.js versions                       package.json = Cargo.toml = tauri.conf.json (or fail)
//   node scripts/release-tauri.js plan                           GitHub only: is fork-v<version> new, a draft or published?
//                                                                (writes version, tag, state to $GITHUB_OUTPUT)
//   node scripts/release-tauri.js assemble <artifacts> <out> [--notes <file>]
//                                                                <artifacts>/<platform>/ (scripts/package-tauri.js --collect)
//                                                                -> <out>: the packages under their release names, .sig, the
//                                                                installers for people (dmg, deb), SHA256SUMS, latest.json
//   node scripts/release-tauri.js draft <out>                    checks <out>, then creates / updates the DRAFT release
//
// Never publishes: `draft: true` is the only value this file ever sends. A release that is already public is refused. The
// tag fork-vX.Y.Z is the Electron build's too (docs/TAURI_UPDATES.md): the Electron draft job (scripts/draft-release.js) and this
// one fill the same draft, in turn (one concurrency group), from the SAME commit.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const manifest = require('./release-manifest');
const bridge = require('./bridge-feed');

const ROOT = path.resolve(__dirname, '..');
const TAG_PREFIX = manifest.TAG_PREFIX;
const BEGIN = '<!-- capri-tauri:begin -->';
const END = '<!-- capri-tauri:end -->';

// the installers for people that are not the update package (those are release-manifest's)
const EXTRAS = {
  'darwin-aarch64': { find: (n) => n.endsWith('.dmg'), name: (v) => `Capri-${v}-macOS-arm64.dmg` },
  'darwin-x86_64': { find: (n) => n.endsWith('.dmg'), name: (v) => `Capri-${v}-macOS-x64.dmg` },
  'linux-x86_64': { find: (n) => n.endsWith('.deb'), name: (v) => `Capri-${v}-Linux-x64.deb` },
};

/** The Tauri assets of a release (what this file owns in a shared draft): by name. */
const isTauriAsset = (name) => /^Capri-\d+\.\d+\.\d+-(macOS|Windows|Linux)-/.test(name) || name === 'latest.json' || name === 'SHA256SUMS';

/** The version the three manifests agree on. */
function versions(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1];
  if (new Set([pkg, conf, cargo]).size !== 1) throw new Error(`versions differ: package.json ${pkg}, tauri.conf.json ${conf}, Cargo.toml ${cargo}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg)) throw new Error(`not a stable X.Y.Z version: ${pkg}`);
  return pkg;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * latest.json, the packages, .sig and SHA256SUMS (release-manifest), plus the dmg / deb, all under release names.
 * bridge (TAURI-13): also the zip of the Tauri Capri.app for the Electron build's Mac updater and the three latest*.yml
 * of electron-updater that point at the Tauri installers (scripts/bridge-feed.js).
 */
function assemble({ artifacts, version, out, notes = '', bridge: withBridge = false }) {
  const { feed } = manifest.build({ artifacts, version, notes: notes || `Capri v${version}`, out });
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  for (const platform of Object.keys(feed.platforms)) {
    const extra = EXTRAS[platform];
    if (!extra) continue;
    const found = fs.readdirSync(path.join(artifacts, platform)).filter(extra.find);
    if (found.length !== 1) throw new Error(`Expected one installer for ${platform} (${found.length} found)`);
    const from = path.join(artifacts, platform, found[0]);
    if (!fs.statSync(from).size) throw new Error(`Empty installer: ${found[0]}`);
    const name = extra.name(version);
    fs.copyFileSync(from, path.join(out, name));
    sums.push(`${sha256(from)}  ${name}`);
  }
  if (withBridge) {
    const folder = path.join(artifacts, 'darwin-aarch64');
    const zips = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => n.endsWith('-bridge.zip')) : [];
    if (zips.length !== 1) throw new Error(`bridge: expected one *-bridge.zip in ${folder} (made by package-tauri.js --collect with the bridge on), found ${zips.length}`);
    const from = path.join(folder, zips[0]);
    if (!fs.statSync(from).size) throw new Error(`Empty bridge package: ${zips[0]}`);
    const name = bridge.bridgeZipName(version);
    fs.copyFileSync(from, path.join(out, name));
    sums.push(`${sha256(from)}  ${name}`);
    bridge.buildFeeds({ dir: out, version, date: feed.pub_date });
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return feed;
}

/**
 * Checks a folder made by assemble() as a release would be: the feed names this version's tag and files that are there,
 * the signatures are the .sig files, SHA256SUMS lists every file and every hash is right. → the names to upload, feed last.
 */
function checkRelease(dir, version, { bridge: withBridge = false } = {}) {
  const read = (name) => {
    try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { throw new Error(`Missing ${name}`); }
  };
  const feed = JSON.parse(read('latest.json'));
  if (feed.version !== version) throw new Error(`latest.json is for ${feed.version}, not ${version}`);
  for (const platform of manifest.REQUIRED) {
    const entry = feed.platforms?.[platform];
    if (!entry) throw new Error(`latest.json has no ${platform}`);
    const name = decodeURIComponent(entry.url.split('/').pop());
    const prefix = `https://github.com/${'Libes6'}/capri-desktop/releases/download/${TAG_PREFIX}${version}/`;
    if (!entry.url.startsWith(prefix)) throw new Error(`${platform}: url is not of release ${TAG_PREFIX}${version}`);
    if (name !== manifest.assetName(version, platform)) throw new Error(`${platform}: unexpected package name ${name}`);
    if (!fs.existsSync(path.join(dir, name))) throw new Error(`${platform}: ${name} is not in the release`);
    if (read(`${name}.sig`).trim() !== String(entry.signature).trim()) throw new Error(`${platform}: the signature in latest.json is not ${name}.sig`);
  }
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
  const isFeed = (n) => bridge.FEED_FILES.includes(n);
  // the electron-updater feeds are there exactly when the bridge is on, and name the files of this release
  if (withBridge) {
    bridge.checkFeeds(dir, version);
    if (!names.includes(bridge.bridgeZipName(version))) throw new Error(`bridge: ${bridge.bridgeZipName(version)} is not in the release`);
  } else if (names.some(isFeed)) {
    throw new Error(`Unexpected ${names.filter(isFeed).join(', ')} (the bridge is off)`);
  }
  const listed = new Map(read('SHA256SUMS').split('\n').filter(Boolean).map((l) => { const [h, n] = l.split(/\s{2}/); return [n, h]; }));
  for (const name of names) {
    if (/\.sig$|^SHA256SUMS$|^latest\.json$/.test(name) || isFeed(name)) continue;
    if (!listed.has(name)) throw new Error(`SHA256SUMS does not list ${name}`);
    if (listed.get(name) !== sha256(path.join(dir, name))) throw new Error(`SHA256SUMS: wrong hash for ${name}`);
  }
  for (const name of listed.keys()) if (!names.includes(name)) throw new Error(`SHA256SUMS lists ${name}, which is not there`);
  const body = names.filter((n) => n !== 'latest.json');
  for (const name of body) if (!isTauriAsset(name) && !isFeed(name)) throw new Error(`Unexpected file in the release folder: ${name}`);
  return [...body.sort(), 'latest.json'];
}

/** The release notes block of this pipeline, kept between markers so that a re-run replaces it and nothing else. */
function tauriBlock(version, sha, { bridge: withBridge = false } = {}) {
  const bridgeNote = withBridge
    ? `\n\n**Bridge:** \`latest.yml\`, \`latest-mac.yml\` and \`latest-linux.yml\` of this release point the Electron build's own updater at the Tauri installers (\`-macOS-arm64-bridge.zip\`, \`-Windows-x64-setup.exe\`, \`-Linux-x64.AppImage\`): an installed Electron Capri updates itself into this one.`
    : '';
  return `${BEGIN}\n**Tauri build ${version}** from ${sha}.${bridgeNote}\n\nmacOS Apple Silicon: \`.dmg\` (and \`.app.tar.gz\` for in-app updates), Windows x64: NSIS \`-setup.exe\`, Linux x64: \`.AppImage\` and \`.deb\`. In-app updates of the Tauri build read \`latest.json\`.\n\nUnsigned for the operating systems: macOS is ad-hoc signed (no Developer ID, no notarization: Gatekeeper asks to open it), the Windows installer is not Authenticode-signed (SmartScreen may warn).\n\nVerify \`SHA256SUMS\` and test the installers before publishing.\n${END}`;
}

function mergeBody(existing, block) {
  const text = String(existing ?? '');
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);
  if (from >= 0 && to > from) return `${text.slice(0, from)}${block}${text.slice(to + END.length)}`;
  return text.trim() ? `${text.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

/**
 * Decides what to do. existing: the release of the tag, if any (GitHub's object), refs: matching tag refs.
 * Throws for everything that must not be done; returns { create, payload }.
 */
function draftPlan({ existing, refs = [], version, sha, assets = [], allowOtherCommit = false, bridge: withBridge = false }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Use a stable x.y.z package version');
  if (!sha) throw new Error('GITHUB_SHA is not set');
  const tag = `${TAG_PREFIX}${version}`;
  if (existing && !existing.draft) throw new Error(`${tag} is already published; bump the version (a published release is never touched)`);
  if (refs.some((r) => r.ref === `refs/tags/${tag}` && (r.object.type !== 'commit' || r.object.sha !== sha))) {
    throw new Error(`Tag ${tag} already exists at another commit; bump the version`);
  }
  if (existing && existing.target_commitish !== sha && !allowOtherCommit) {
    // the draft is shared with the Electron build (scripts/draft-release.js): its files would end up under another commit
    const others = assets.filter((a) => !isTauriAsset(a.name));
    if (others.length) throw new Error(`The draft ${tag} holds files built from ${existing.target_commitish} (${others.length} not ours); build both from the same commit, or delete the draft`);
  }
  const body = mergeBody(existing?.body, tauriBlock(version, sha, { bridge: withBridge }));
  return {
    create: !existing,
    payload: { tag_name: tag, target_commitish: sha, name: existing?.name || `Capri v${version}`, draft: true, prerelease: false, body },
  };
}

/** Our assets of the draft that this run does not upload again (an Intel package that is gone, an old name). */
const staleAssets = (existing, wanted) => existing.filter((a) => isTauriAsset(a.name) && !wanted.includes(a.name));

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

function findRelease(repo, version) {
  // drafts are only listed for a token that can write; tags/<tag> endpoints do not find an untagged draft
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  return pages.flat().find((r) => r.tag_name === `${TAG_PREFIX}${version}`) || null;
}

function plan() {
  const version = versions();
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('Run this in GitHub Actions (GITHUB_REPOSITORY)');
  const existing = findRelease(repo, version);
  const state = !existing ? 'none' : existing.draft ? 'draft' : 'published';
  const lines = { version, tag: `${TAG_PREFIX}${version}`, state };
  console.log(JSON.stringify(lines));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return lines;
}

function draft(dir) {
  const version = versions();
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  if (!repo || !sha) throw new Error('Run this in GitHub Actions (GITHUB_REPOSITORY, GITHUB_SHA)');
  const withBridge = bridge.bridgeEnabled();
  const names = checkRelease(dir, version, { bridge: withBridge });
  const existing = findRelease(repo, version);
  const assets = existing ? JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases/${existing.id}/assets?per_page=100`])).flat() : [];
  const refs = JSON.parse(gh(['api', `repos/${repo}/git/matching-refs/tags/${TAG_PREFIX}${version}`]));
  const { create, payload } = draftPlan({ existing, refs, version, sha, assets, allowOtherCommit: process.env.CAPRI_ALLOW_OTHER_COMMIT === '1', bridge: withBridge });
  if (payload.draft !== true) throw new Error('refusing to publish');
  const endpoint = create ? `repos/${repo}/releases` : `repos/${repo}/releases/${existing.id}`;
  const release = JSON.parse(gh(['api', '--method', create ? 'POST' : 'PATCH', endpoint, '--input', '-'], JSON.stringify(payload)));
  if (!release.draft) throw new Error('GitHub returned a published release; stopping');
  for (const old of staleAssets(assets, names)) gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${old.id}`]);
  for (const name of names) {
    const old = assets.find((a) => a.name === name);
    if (old) gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${old.id}`]);
    gh(['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream', `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, '--input', path.join(dir, name)]);
  }
  console.log(`Draft ready: ${release.html_url}`);
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  if (command === 'versions') return console.log(versions());
  if (command === 'plan') return plan();
  if (command === 'assemble') {
    const notesFile = option('--notes');
    const [artifacts, out] = rest;
    if (!artifacts || !out) throw new Error('usage: assemble <artifacts> <out> [--notes <file>]');
    const feed = assemble({ artifacts: path.resolve(artifacts), version: versions(), out: path.resolve(out), notes: notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : '', bridge: bridge.bridgeEnabled() });
    return console.log(`assembled ${feed.version}: ${Object.keys(feed.platforms).join(', ')}${bridge.bridgeEnabled() ? ' + the Electron bridge feeds' : ''}`);
  }
  if (command === 'draft') return draft(path.resolve(rest[0] || 'release-assets'));
  throw new Error('usage: release-tauri.js versions | plan | assemble <artifacts> <out> | draft <out>');
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`release-tauri: ${err.message}`); process.exit(1); }
}

module.exports = { versions, assemble, checkRelease, draftPlan, mergeBody, tauriBlock, staleAssets, isTauriAsset, BEGIN, END, EXTRAS };
