'use strict';
// TAURI-10: scripts/release-manifest.js, the signed feed (latest.json) of the Tauri updater.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { manifest, assetName, versionFromTag, build, REQUIRED } = require('../scripts/release-manifest');

const SIG = Buffer.from('untrusted comment: signature\nRWQ...\n').toString('base64');
const assets = (v = '0.3.0') => Object.fromEntries(REQUIRED.map((p) => [p, { name: assetName(v, p), signature: SIG }]));

test('every platform, a release-tag URL for each, and a signature that is the .sig text', () => {
  const feed = manifest('0.3.0', assets(), { notes: 'Notes', date: '2026-10-28T10:00:00Z' });
  assert.deepEqual(Object.keys(feed.platforms).sort(), ['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']);
  assert.equal(feed.version, '0.3.0');
  assert.equal(feed.notes, 'Notes');
  assert.equal(feed.pub_date, '2026-10-28T10:00:00.000Z');
  for (const entry of Object.values(feed.platforms)) {
    assert.equal(entry.signature, SIG);
    // the immutable tag of this release, never /latest/ (a newer release must not change what this feed means)
    assert.match(entry.url, /^https:\/\/github\.com\/Libes6\/capri-desktop\/releases\/download\/fork-v0\.3\.0\/Capri-0\.3\.0-/);
    assert.ok(!entry.url.includes('/latest/'));
  }
  assert.equal(feed.platforms['darwin-aarch64'].url.split('/').pop(), 'Capri-0.3.0-macOS-arm64.app.tar.gz');
  assert.equal(feed.platforms['windows-x86_64'].url.split('/').pop(), 'Capri-0.3.0-Windows-x64-setup.exe');
  assert.equal(feed.platforms['linux-x86_64'].url.split('/').pop(), 'Capri-0.3.0-Linux-x64.AppImage');
});

test('asset names never collide with the Electron release\'s (lower-case os names, other extensions)', () => {
  const electron = ['win-x64.exe', 'linux-x86_64.AppImage', 'linux-amd64.deb', 'mac-arm64.dmg', 'mac-arm64.zip'].map((s) => `Capri-0.3.0-${s}`);
  for (const p of [...REQUIRED, 'darwin-x86_64']) assert.ok(!electron.includes(assetName('0.3.0', p)), p);
});

test('an Intel Mac entry is optional, and only when it is signed', () => {
  const feed = manifest('0.3.0', { ...assets(), 'darwin-x86_64': { name: assetName('0.3.0', 'darwin-x86_64'), signature: SIG } });
  assert.ok(feed.platforms['darwin-x86_64']);
  assert.throws(() => manifest('0.3.0', { ...assets(), 'darwin-x86_64': { name: assetName('0.3.0', 'darwin-x86_64'), signature: '' } }), /darwin-x86_64/);
});

test('a missing platform, an empty or odd signature, a wrong package: no feed', () => {
  for (const platform of REQUIRED) {
    const without = assets();
    delete without[platform];
    assert.throws(() => manifest('0.3.0', without), new RegExp(platform));
    for (const signature of ['', '   ', undefined, 'not base64!', 'a\nb']) {
      assert.throws(() => manifest('0.3.0', { ...assets(), [platform]: { name: assetName('0.3.0', platform), signature } }), new RegExp(platform), JSON.stringify(signature));
    }
    assert.throws(() => manifest('0.3.0', { ...assets(), [platform]: { name: 'Capri.dmg', signature: SIG } }), new RegExp(platform));
  }
  assert.throws(() => manifest('0.3.0', { ...assets(), 'linux-x86_64': { name: assetName('0.3.0', 'windows-x86_64'), signature: SIG } }), /linux-x86_64/);
});

test('only a stable X.Y.Z version, and a date that is a date', () => {
  for (const v of ['0.3', 'v0.3.0', '0.3.0-beta.1', '', '01.2.3']) assert.throws(() => manifest(v, assets()), /version/);
  assert.throws(() => manifest('0.3.0', assets(), { date: 'yesterday' }), /date/);
  assert.equal(versionFromTag('fork-v0.3.0'), '0.3.0');
  for (const tag of ['v0.3.0', 'fork-v0.3', 'fork-v', 'latest']) assert.throws(() => versionFromTag(tag), /release tag/);
});

function artifactsFolder(mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-manifest-'));
  const files = { 'darwin-aarch64': 'Capri.app.tar.gz', 'windows-x86_64': 'Capri_0.3.0_x64-setup.exe', 'linux-x86_64': 'Capri_0.3.0_amd64.AppImage' };
  for (const [platform, name] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, platform));
    fs.writeFileSync(path.join(dir, platform, name), `bytes of ${platform}`);
    fs.writeFileSync(path.join(dir, platform, `${name}.sig`), `${SIG}\n`);
  }
  mutate(dir);
  return dir;
}

test('build: packages are renamed byte for byte, with signatures, checksums and latest.json', () => {
  const dir = artifactsFolder();
  const { feed, out } = build({ artifacts: dir, version: '0.3.0', notes: 'N' });
  const names = fs.readdirSync(out).sort();
  assert.deepEqual(names, [
    'Capri-0.3.0-Linux-x64.AppImage', 'Capri-0.3.0-Linux-x64.AppImage.sig',
    'Capri-0.3.0-Windows-x64-setup.exe', 'Capri-0.3.0-Windows-x64-setup.exe.sig',
    'Capri-0.3.0-macOS-arm64.app.tar.gz', 'Capri-0.3.0-macOS-arm64.app.tar.gz.sig',
    'SHA256SUMS', 'latest.json',
  ]);
  assert.equal(fs.readFileSync(path.join(out, 'Capri-0.3.0-macOS-arm64.app.tar.gz'), 'utf8'), 'bytes of darwin-aarch64');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8')), feed);
  assert.equal(fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n').length, 3);
  // every url of the feed is a file of the release, under that name
  for (const entry of Object.values(feed.platforms)) assert.ok(names.includes(decodeURIComponent(entry.url.split('/').pop())));
});

test('build: a missing .sig, a missing platform, two packages: fails and writes nothing', () => {
  const cases = [
    (d) => fs.rmSync(path.join(d, 'linux-x86_64', 'Capri_0.3.0_amd64.AppImage.sig')),
    (d) => fs.writeFileSync(path.join(d, 'windows-x86_64', 'Capri_0.3.0_x64-setup.exe.sig'), '\n'),
    (d) => fs.rmSync(path.join(d, 'darwin-aarch64'), { recursive: true }),
    (d) => fs.writeFileSync(path.join(d, 'linux-x86_64', 'Other.AppImage'), 'x'),
    (d) => fs.writeFileSync(path.join(d, 'linux-x86_64', 'Capri_0.3.0_amd64.AppImage'), ''),
  ];
  for (const mutate of cases) {
    const dir = artifactsFolder(mutate);
    assert.throws(() => build({ artifacts: dir, version: '0.3.0' }));
    assert.ok(!fs.existsSync(path.join(dir, 'release', 'latest.json')));
  }
});
