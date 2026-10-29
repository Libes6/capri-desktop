'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { bridgeEnabled } = require('./bridge-feed');

// The installers, then what in-app updates read (docs/UPDATES.md): electron-builder's latest*.yml
// for each platform and the blockmaps of differential downloads (the AppImage carries its own).
// bridge (TAURI-13, bridge.json): this release carries the Tauri installers' latest*.yml, written by the Tauri job
// (scripts/release-tauri.js, docs/TAURI_BRIDGE.md); the Electron files here are installers for people only, and this job
// must neither require nor upload its own latest*.yml and blockmaps (it would overwrite the bridge's).
function releaseFiles(dir, version, { bridge = false } = {}) {
  const installers = [
    `Capri-${version}-win-x64.exe`,
    `Capri-${version}-linux-x86_64.AppImage`,
    `Capri-${version}-linux-amd64.deb`,
    `Capri-${version}-mac-arm64.dmg`,
    `Capri-${version}-mac-arm64.zip`,
  ];
  const updates = bridge ? [] : [
    'latest.yml',
    'latest-linux.yml',
    'latest-mac.yml',
    `Capri-${version}-win-x64.exe.blockmap`,
    `Capri-${version}-mac-arm64.dmg.blockmap`,
    `Capri-${version}-mac-arm64.zip.blockmap`,
  ];
  for (const name of [...installers, ...updates]) {
    const kind = installers.includes(name) ? 'installer' : 'update file';
    if (!fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing ${kind}: ${name}`);
    if (!fs.statSync(path.join(dir, name)).size) throw new Error(`Empty ${kind}: ${name}`);
  }
  if (!bridge) checkUpdateFeeds(dir, version, installers);
  return [...installers, ...updates];
}

// electron-builder's update info, read without a YAML library: its version and, per file, the url
// (a name next to it in the release), sha512 and size.
function parseUpdateInfo(text) {
  const version = (text.match(/^version:\s*['"]?([^'"\n]+?)['"]?\s*$/m) || [])[1] || null;
  const files = [];
  for (const block of text.split(/^\s+-\s+url:/m).slice(1)) {
    const field = (name) => (block.match(new RegExp(`^\\s*${name}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm')) || [])[1];
    const url = block.split('\n')[0].trim().replace(/^['"]|['"]$/g, '');
    files.push({ url, sha512: field('sha512'), size: Number(field('size')) || null });
  }
  return { version, files };
}

// Each latest*.yml names this version, lists only assets of this release under their exact names
// (artifactName), with the right checksum and size, and offers what that platform's updater takes.
function checkUpdateFeeds(dir, version, installers) {
  const wants = { 'latest.yml': ['.exe'], 'latest-linux.yml': ['.AppImage'], 'latest-mac.yml': ['.zip'] };
  for (const [feed, extensions] of Object.entries(wants)) {
    const info = parseUpdateInfo(fs.readFileSync(path.join(dir, feed), 'utf8'));
    if (info.version !== version) throw new Error(`${feed} is for ${info.version}, not ${version}`);
    if (!info.files.length) throw new Error(`${feed} lists no files`);
    for (const file of info.files) {
      if (!installers.includes(file.url)) throw new Error(`${feed} names ${file.url}, which is not a release asset`);
      const bytes = fs.readFileSync(path.join(dir, file.url));
      if (file.sha512 !== createHash('sha512').update(bytes).digest('base64')) throw new Error(`${feed}: sha512 of ${file.url} does not match`);
      if (file.size !== null && file.size !== bytes.length) throw new Error(`${feed}: size of ${file.url} does not match`);
    }
    for (const ext of extensions) {
      if (!info.files.some((f) => f.url.endsWith(ext))) throw new Error(`${feed} has no ${ext}`);
    }
  }
}

// The Tauri pipeline (scripts/release-tauri.js) keeps its notes between these markers in the SAME draft: keep them.
const TAURI_BEGIN = '<!-- capri-tauri:begin -->';
const TAURI_END = '<!-- capri-tauri:end -->';
function keepTauriNotes(existing, body) {
  const text = String(existing?.body ?? '');
  const from = text.indexOf(TAURI_BEGIN);
  const to = text.indexOf(TAURI_END);
  return from >= 0 && to > from ? `${body}\n\n${text.slice(from, to + TAURI_END.length)}` : body;
}

function draftPayload(existing, version, sha, { bridge = false } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a stable x.y.z package version');
  if (existing && !existing.draft) throw new Error(`fork-v${version} is already published; bump package.json and package-lock.json`);
  const body = `Cross-platform build from ${sha}.\n\nWindows x64: EXE\nLinux x64 (X11/XWayland): AppImage and DEB\nmacOS Apple Silicon: DMG and ZIP\n\nUnsigned builds: Windows signing and Apple Developer ID/notarization are not configured.\nWindow tracking and desktop automation remain Windows-only in v0.1.\n\n${bridge
    ? 'This release is the bridge: latest.yml, latest-linux.yml and latest-mac.yml point installed Electron copies at the Tauri installers (see the Tauri notes below). These Electron installers are for downloading by hand, e.g. to go back.'
    : 'In-app updates read latest.yml, latest-linux.yml and latest-mac.yml (sha512 of each installer) from the latest published release: publishing this draft offers it to installed copies.'} These notes are shown in the app as plain text.\n\nVerify SHA256SUMS.txt and test installers before publishing.`;
  return { tag_name: `fork-v${version}`, target_commitish: sha, name: `Capri v${version}`, draft: true, body: keepTauriNotes(existing, body) };
}

function main() {
  const version = require('../package.json').version;
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  if (!repo || !sha) throw new Error('Run this script in GitHub Actions with GITHUB_REPOSITORY and GITHUB_SHA');
  const dir = path.resolve(process.argv[2] || 'release-assets');
  const bridge = bridgeEnabled();
  const names = releaseFiles(dir, version, { bridge });
  const checksums = names.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), checksums);
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 10 * 1024 * 1024 });
  // Drafts are included for the authenticated repository token; tags/ endpoints don't find untagged drafts.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  const existing = pages.flat().find((release) => release.tag_name === `fork-v${version}`);
  const payload = draftPayload(existing, version, sha, { bridge });
  // Refuse to attach a new commit's binaries to an existing tag pointing elsewhere.
  const refs = JSON.parse(gh(['api', `repos/${repo}/git/matching-refs/tags/fork-v${version}`]));
  if (refs.some((ref) => ref.ref === `refs/tags/fork-v${version}` && (ref.object.type !== 'commit' || ref.object.sha !== sha))) {
    throw new Error(`Tag fork-v${version} already exists at another commit; bump the version`);
  }
  const endpoint = existing ? `repos/${repo}/releases/${existing.id}` : `repos/${repo}/releases`;
  const release = JSON.parse(gh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], JSON.stringify(payload)));
  // Use the release id: gh release upload resolves tags, which may not exist for a draft yet.
  const assets = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases/${release.id}/assets?per_page=100`])).flat();
  for (const name of [...names, 'SHA256SUMS.txt']) {
    const old = assets.find((asset) => asset.name === name);
    if (old) gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${old.id}`]);
    gh(['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream',
      `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, '--input', path.join(dir, name)]);
  }
  console.log(`Draft ready: ${release.html_url}`);
}

if (require.main === module) main();
module.exports = { releaseFiles, draftPayload, parseUpdateInfo, checkUpdateFeeds };
