'use strict';
// TAURI-12: the Tauri packaging and release scripts (package-tauri, release-tauri, verify-signatures) and the line between
// the Electron package and the Tauri one. Nothing here builds, signs with a real key, or talks to GitHub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const pack = require('../scripts/package-tauri');
const rel = require('../scripts/release-tauri');
const sigs = require('../scripts/verify-signatures');
const manifest = require('../scripts/release-manifest');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('every platform has the target triple Tauri names its externalBin with, and the same platform keys as the feed', () => {
  assert.deepEqual(Object.keys(pack.PLATFORMS).sort(), [...manifest.REQUIRED, ...manifest.OPTIONAL].sort());
  assert.equal(pack.sidecarFile('darwin-aarch64'), 'capri-sidecar-aarch64-apple-darwin');
  assert.equal(pack.sidecarFile('darwin-x86_64'), 'capri-sidecar-x86_64-apple-darwin');
  assert.equal(pack.sidecarFile('windows-x86_64'), 'capri-sidecar-x86_64-pc-windows-msvc.exe');
  assert.equal(pack.sidecarFile('linux-x86_64'), 'capri-sidecar-x86_64-unknown-linux-gnu');
  assert.equal(pack.platformOf('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(pack.platformOf('win32', 'x64'), 'windows-x86_64');
  assert.throws(() => pack.platformOf('linux', 'arm64'), /no Tauri package/);
  // the bundle config names the sidecar WITHOUT the triple: the bundler adds it
  const bundle = JSON.parse(read('src-tauri', 'tauri.bundle.conf.json'));
  assert.deepEqual(bundle.bundle.externalBin, ['binaries/capri-sidecar']);
});

test('resources: capri-hook on every system, the mac helper only on macOS, windows.ps1 only on Windows', () => {
  assert.deepEqual(pack.resourcesMap('darwin-aarch64'), { 'resources/bin/capri-hook': 'bin/capri-hook', 'resources/bin/capri-windows': 'bin/capri-windows' });
  assert.deepEqual(pack.resourcesMap('darwin-x86_64'), pack.resourcesMap('darwin-aarch64'));
  assert.deepEqual(pack.resourcesMap('windows-x86_64'), { 'resources/bin/capri-hook.exe': 'bin/capri-hook.exe', 'resources/windows.ps1': 'windows.ps1' });
  assert.deepEqual(pack.resourcesMap('linux-x86_64'), { 'resources/bin/capri-hook': 'bin/capri-hook' });
  // where the core and the hooks look (sidecar/main.js CAPRI_RESOURCES, mac/window-watch.js, windows.js, migrate.js)
  assert.match(read('src', 'main', 'mac', 'window-watch.js'), /'bin', 'capri-windows'/);
  assert.match(read('src', 'main', 'windows.js'), /'windows\.ps1'/);
  assert.match(read('src', 'main', 'migrate.js'), /path\.join\(resources, 'bin'\)/);
  assert.deepEqual(pack.resourcesConfig('linux-x86_64', { identifier: 'x.y' }).identifier, 'x.y');
  assert.ok(!('identifier' in pack.resourcesConfig('linux-x86_64')));
});

test('the content check names what a package lacks, with or without a path prefix', () => {
  const full = pack.expectedFiles('darwin-aarch64');
  assert.deepEqual(pack.missingFrom(full.map((f) => `Capri.app/${f}`), full), []);
  assert.deepEqual(pack.missingFrom(full.filter((f) => !/capri-hook/.test(f)), full), ['Contents/Resources/bin/capri-hook']);
  assert.deepEqual(pack.missingFrom(['./usr/bin/capri', './usr/bin/capri-sidecar', './usr/lib/Capri/bin/capri-hook'], pack.expectedFiles('linux-x86_64')), []);
  assert.deepEqual(pack.missingFrom(['capri.exe', 'capri-sidecar.exe', 'bin\\capri-hook.exe'], pack.expectedFiles('windows-x86_64')), ['windows.ps1']);
  // "capri-hook" must not be satisfied by a file that only ends in the same letters
  assert.deepEqual(pack.missingFrom(['usr/bin/capri', 'usr/bin/capri-sidecar', 'x/notcapri-hook'], pack.expectedFiles('linux-x86_64')), ['bin/capri-hook']);
});

test('collect copies the installers, the update package and its .sig into <platform>/, and says when the .sig is missing', (t) => {
  const bundle = tmp(t);
  const dest = tmp(t);
  fs.mkdirSync(path.join(bundle, 'macos'));
  fs.mkdirSync(path.join(bundle, 'dmg'));
  fs.writeFileSync(path.join(bundle, 'macos', 'Capri.app.tar.gz'), 'tar');
  fs.writeFileSync(path.join(bundle, 'dmg', 'Capri_0.1.0_aarch64.dmg'), 'dmg');
  assert.throws(() => pack.collect('darwin-aarch64', dest, bundle), /\.sig.*TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY/);
  fs.writeFileSync(path.join(bundle, 'macos', 'Capri.app.tar.gz.sig'), 'sig');
  assert.deepEqual(pack.collect('darwin-aarch64', dest, bundle).sort(), ['Capri.app.tar.gz', 'Capri.app.tar.gz.sig', 'Capri_0.1.0_aarch64.dmg']);
  assert.ok(fs.existsSync(path.join(dest, 'darwin-aarch64', 'Capri.app.tar.gz.sig')));
});

// --- a real minisign signature, made here with a throw-away key (the format Tauri's signer writes)
function minisignKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const id = crypto.randomBytes(8);
  const file = (line) => Buffer.from(`untrusted comment: minisign public key ${id.toString('hex')}\n${line}\n`).toString('base64');
  const pub = file(Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64'));
  const sign = (bytes, alg = 'ED') => {
    const message = alg === 'ED' ? crypto.createHash('blake2b512').update(bytes).digest() : bytes;
    const signature = crypto.sign(null, message, privateKey);
    const trusted = 'timestamp:1 file:x';
    const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
    return Buffer.from(`untrusted comment: signature\n${Buffer.concat([Buffer.from(alg), id, signature]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`).toString('base64');
  };
  return { pub, sign };
}

test('signatures: the update packages verify against the public key; a changed byte, another key, a stale .sig do not', (t) => {
  const a = minisignKey();
  const b = minisignKey();
  const bytes = Buffer.from('the package');
  for (const alg of ['ED', 'Ed']) assert.equal(sigs.verify(bytes, a.sign(bytes, alg), sigs.publicKey(a.pub)), true, alg);
  assert.throws(() => sigs.verify(Buffer.from('the packagE'), a.sign(bytes), sigs.publicKey(a.pub)), /does not match/);
  assert.throws(() => sigs.verify(bytes, b.sign(bytes), sigs.publicKey(a.pub)), /another key/);
  assert.throws(() => sigs.publicKey('not a key'), /public key/);
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'Capri.AppImage'), bytes);
  fs.writeFileSync(path.join(dir, 'Capri.AppImage.sig'), a.sign(bytes));
  assert.deepEqual(sigs.verifyFolder(dir, a.pub), ['Capri.AppImage']);
  fs.appendFileSync(path.join(dir, 'Capri.AppImage'), 'x');
  assert.throws(() => sigs.verifyFolder(dir, a.pub), /Capri\.AppImage: /);
  assert.throws(() => sigs.verifyFolder(tmp(t), a.pub), /no \.sig files/);
});

// --- assemble + check, with fake packages
const SIG = (platform) => Buffer.from(`untrusted comment: sig ${platform}\nAAAA\n`).toString('base64');
function artifacts(t, { intel = false } = {}) {
  const dir = tmp(t);
  const files = {
    'darwin-aarch64': ['Capri.app.tar.gz', 'Capri_0.3.0_aarch64.dmg'],
    'windows-x86_64': ['Capri_0.3.0_x64-setup.exe'],
    'linux-x86_64': ['Capri_0.3.0_amd64.AppImage', 'Capri_0.3.0_amd64.deb'],
    ...(intel && { 'darwin-x86_64': ['Capri.app.tar.gz', 'Capri_0.3.0_x64.dmg'] }),
  };
  for (const [platform, names] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, platform));
    for (const name of names) fs.writeFileSync(path.join(dir, platform, name), `${platform} ${name}`);
    fs.writeFileSync(path.join(dir, platform, `${names[0]}.sig`), `${SIG(platform)}\n`);
  }
  return dir;
}

test('assemble: release names, the installers for people, .sig, one SHA256SUMS of all of them, latest.json', (t) => {
  const out = path.join(tmp(t), 'out');
  const feed = rel.assemble({ artifacts: artifacts(t), version: '0.3.0', out });
  assert.deepEqual(fs.readdirSync(out).sort(), [
    'Capri-0.3.0-Linux-x64.AppImage', 'Capri-0.3.0-Linux-x64.AppImage.sig', 'Capri-0.3.0-Linux-x64.deb',
    'Capri-0.3.0-Windows-x64-setup.exe', 'Capri-0.3.0-Windows-x64-setup.exe.sig',
    'Capri-0.3.0-macOS-arm64.app.tar.gz', 'Capri-0.3.0-macOS-arm64.app.tar.gz.sig', 'Capri-0.3.0-macOS-arm64.dmg',
    'SHA256SUMS', 'latest.json',
  ]);
  assert.equal(feed.notes, 'Capri v0.3.0');
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 5);
  assert.ok(sums.every((l) => /^[0-9a-f]{64} {2}Capri-0\.3\.0-/.test(l)));
  assert.deepEqual(rel.checkRelease(out, '0.3.0').at(-1), 'latest.json');
  // none of the names is one of the Electron release's
  const electron = ['win-x64.exe', 'linux-x86_64.AppImage', 'linux-amd64.deb', 'mac-arm64.dmg', 'mac-arm64.zip'].map((s) => `Capri-0.3.0-${s}`);
  for (const name of fs.readdirSync(out)) assert.ok(!electron.includes(name), name);
});

test('assemble: an Intel Mac, when it was built, gets its own entry and dmg', (t) => {
  const out = path.join(tmp(t), 'out');
  const feed = rel.assemble({ artifacts: artifacts(t, { intel: true }), version: '0.3.0', out });
  assert.ok(feed.platforms['darwin-x86_64']);
  assert.ok(fs.existsSync(path.join(out, 'Capri-0.3.0-macOS-x64.dmg')));
  rel.checkRelease(out, '0.3.0');
});

test('assemble: a missing platform, installer or signature is no release', (t) => {
  for (const [platform, file] of [['darwin-aarch64', 'Capri_0.3.0_aarch64.dmg'], ['linux-x86_64', 'Capri_0.3.0_amd64.deb'], ['windows-x86_64', 'Capri_0.3.0_x64-setup.exe.sig'], ['linux-x86_64', 'Capri_0.3.0_amd64.AppImage']]) {
    const dir = artifacts(t);
    fs.rmSync(path.join(dir, platform, file));
    assert.throws(() => rel.assemble({ artifacts: dir, version: '0.3.0', out: path.join(tmp(t), 'o') }), /installer|signature|update package/i, `${platform}/${file}`);
  }
  const none = artifacts(t);
  fs.rmSync(path.join(none, 'windows-x86_64'), { recursive: true });
  assert.throws(() => rel.assemble({ artifacts: none, version: '0.3.0', out: path.join(tmp(t), 'o') }), /windows-x86_64/);
});

test('checkRelease: a tampered file, a stale signature, a feed of another version, an unknown file all stop the draft', (t) => {
  const make = () => {
    const out = path.join(tmp(t), 'out');
    rel.assemble({ artifacts: artifacts(t), version: '0.3.0', out });
    return out;
  };
  let out = make();
  fs.appendFileSync(path.join(out, 'Capri-0.3.0-Linux-x64.deb'), 'x');
  assert.throws(() => rel.checkRelease(out, '0.3.0'), /wrong hash/);
  out = make();
  fs.writeFileSync(path.join(out, 'Capri-0.3.0-Linux-x64.AppImage.sig'), `${SIG('other')}\n`);
  assert.throws(() => rel.checkRelease(out, '0.3.0'), /signature in latest\.json/);
  out = make();
  assert.throws(() => rel.checkRelease(out, '0.4.0'), /latest\.json is for 0\.3\.0/);
  out = make();
  fs.writeFileSync(path.join(out, 'notes.txt'), 'x');
  assert.throws(() => rel.checkRelease(out, '0.3.0'), /SHA256SUMS does not list notes\.txt/);
  out = make();
  fs.rmSync(path.join(out, 'latest.json'));
  assert.throws(() => rel.checkRelease(out, '0.3.0'), /Missing latest\.json/);
  out = make();
  const feed = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
  feed.platforms['linux-x86_64'].url = feed.platforms['linux-x86_64'].url.replace('fork-v0.3.0', 'latest');
  fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(feed));
  assert.throws(() => rel.checkRelease(out, '0.3.0'), /not of release fork-v0\.3\.0/);
});

test('draft plan: only ever a draft; a published release, a tag at another commit, foreign files from another commit refuse', () => {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const fresh = rel.draftPlan({ existing: null, version: '0.3.0', sha });
  assert.equal(fresh.create, true);
  assert.equal(fresh.payload.draft, true);
  assert.equal(fresh.payload.tag_name, 'fork-v0.3.0');
  assert.equal(fresh.payload.target_commitish, sha);
  assert.match(fresh.payload.body, /capri-tauri:begin/);
  assert.throws(() => rel.draftPlan({ existing: { draft: false, tag_name: 'fork-v0.3.0' }, version: '0.3.0', sha }), /already published/);
  assert.throws(() => rel.draftPlan({ existing: null, version: '0.3.0', sha, refs: [{ ref: 'refs/tags/fork-v0.3.0', object: { type: 'commit', sha: other } }] }), /another commit/);
  assert.throws(() => rel.draftPlan({ existing: null, version: '0.3.0', sha, refs: [{ ref: 'refs/tags/fork-v0.3.0', object: { type: 'tag', sha } }] }), /another commit/);
  assert.equal(rel.draftPlan({ existing: null, version: '0.3.0', sha, refs: [{ ref: 'refs/tags/fork-v0.3.0', object: { type: 'commit', sha } }] }).create, true);
  for (const v of ['0.3', 'v0.3.0', '0.3.0-rc.1', '']) assert.throws(() => rel.draftPlan({ existing: null, version: v, sha }), /stable/);
  // the draft is shared with the Electron job: same commit, any assets; another commit only if every asset is ours
  const draft = (commit) => ({ draft: true, id: 1, target_commitish: commit, body: 'Electron notes' });
  const electronAsset = { name: 'latest-mac.yml' };
  const ourAsset = { name: 'Capri-0.3.0-Linux-x64.deb' };
  assert.equal(rel.draftPlan({ existing: draft(sha), version: '0.3.0', sha, assets: [electronAsset, ourAsset] }).create, false);
  assert.throws(() => rel.draftPlan({ existing: draft(other), version: '0.3.0', sha, assets: [electronAsset, ourAsset] }), /same commit/);
  assert.equal(rel.draftPlan({ existing: draft(other), version: '0.3.0', sha, assets: [ourAsset] }).payload.target_commitish, sha);
});

test('release notes: our block is replaced on a re-run and the rest of the draft is kept; the Electron job keeps our block', () => {
  const first = rel.mergeBody('Electron notes', rel.tauriBlock('0.3.0', 'a'.repeat(40)));
  assert.match(first, /^Electron notes\n\n<!-- capri-tauri:begin -->/);
  const again = rel.mergeBody(first, rel.tauriBlock('0.3.0', 'c'.repeat(40)));
  assert.equal(again.split(rel.BEGIN).length, 2);
  assert.match(again, /c{40}/);
  assert.doesNotMatch(again, /a{40}/);
  assert.match(again, /^Electron notes/);
  const { draftPayload } = require('../scripts/draft-release');
  const electron = draftPayload({ draft: true, body: first }, '0.3.0', 'd'.repeat(40));
  assert.equal(electron.draft, true);
  assert.match(electron.body, /capri-tauri:begin/);
  assert.equal(electron.body.split(rel.BEGIN).length, 2);
  assert.doesNotMatch(draftPayload(null, '0.3.0', 'd'.repeat(40)).body, /capri-tauri/);
});

test('stale assets of ours are removed from the draft, the Electron files never', () => {
  const existing = ['latest.yml', 'latest-mac.yml', 'Capri-0.3.0-mac-arm64.dmg', 'SHA256SUMS.txt', 'Capri-0.3.0-macOS-x64.dmg', 'latest.json', 'SHA256SUMS', 'Capri-0.3.0-Linux-x64.deb'].map((name) => ({ name }));
  const wanted = ['latest.json', 'SHA256SUMS', 'Capri-0.3.0-Linux-x64.deb'];
  assert.deepEqual(rel.staleAssets(existing, wanted).map((a) => a.name), ['Capri-0.3.0-macOS-x64.dmg']);
});

test('one version everywhere: package.json, Cargo.toml and tauri.conf.json', () => {
  assert.match(rel.versions(), /^\d+\.\d+\.\d+$/);
  const pkg = JSON.parse(read('package.json')).version;
  assert.equal(rel.versions(), pkg);
});

// --- the line between the two packages
const globs = (list) => list.filter((p) => !p.startsWith('!'));

test('the Electron package takes nothing of the Tauri build: no shell, sidecar, crates, binaries, Tauri scripts', () => {
  const build = JSON.parse(read('package.json')).build;
  const included = globs(build.files);
  for (const g of included) {
    assert.ok(!/src-tauri|crates|sidecar|binaries|\.cargo|target/.test(g), `build.files: ${g}`);
  }
  const resources = [...(build.mac.extraResources || []), ...(build.extraResources || [])].map((r) => r.from);
  for (const from of resources) assert.ok(!/src-tauri|crates|sidecar|binaries|target/.test(from), from);
  assert.deepEqual(build.mac.extraResources.map((r) => r.from), ['src/main/mac/bin/capri-windows']);
  // the scripts folder is shipped whole (the hooks installers are in it); the Tauri-only ones are cut out
  assert.ok(included.includes('scripts/**'));
  const excluded = build.files.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  for (const file of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    if (!/tauri|sidecar|stage-frontend|release-manifest|updater-config|verify-signatures/.test(file)) continue;
    assert.ok(excluded.includes(`scripts/${file}`), `scripts/${file} must not be in the Electron package`);
  }
  // and what the shipped code needs is not cut: the core requires these three, the hooks the rest of src/hooks/assets
  for (const needed of ['scripts/demo-sequence.js', 'scripts/install-hooks.js', 'scripts/install-codex-hooks.js', 'scripts/install-hooks-agy.js']) {
    assert.ok(!excluded.includes(needed), needed);
  }
});

test('the Tauri package takes only what package-tauri stages: the sidecar, the resources map, the bundle config', () => {
  const bundle = JSON.parse(read('src-tauri', 'tauri.bundle.conf.json')).bundle;
  assert.deepEqual(Object.keys(bundle).sort(), ['active', 'externalBin', 'macOS', 'windows']);
  assert.deepEqual(bundle.windows, { nsis: { installerHooks: 'windows/hooks.nsh' } }); // TAURI-13: removes the Electron install, restarts after --force-run
  assert.equal(bundle.macOS.signingIdentity, '-');
  const plist = read('src-tauri', bundle.macOS.entitlements);
  assert.match(plist, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(plist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  // no updater or key in the committed configuration (updater-config.js adds it at build time) and no Electron anywhere
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  assert.equal(conf.plugins?.updater, undefined);
  assert.equal(conf.bundle.resources, undefined);
  assert.doesNotMatch(JSON.stringify([conf, bundle]), /electron/i);
  for (const dir of ['src-tauri/resources/', 'src-tauri/binaries/', 'src-tauri/frontend/', 'src-tauri/target/', 'crates/*/target/']) {
    assert.ok(read('.gitignore').split('\n').includes(dir), `${dir} is ignored by git`);
  }
  for (const source of Object.keys(pack.resourcesMap('linux-x86_64'))) assert.match(source, /^resources\//);
});

test('the workflow is wired to the same scripts, never publishes, and pins its actions', () => {
  const text = read('.github', 'workflows', 'tauri-release.yml');
  for (const script of ['package-tauri.js', 'package-smoke.js', 'release-tauri.js', 'verify-signatures.js']) {
    assert.ok(text.includes(`scripts/${script}`), script);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', script)), script);
  }
  assert.doesNotMatch(text, /draft:\s*false|--draft=false|gh release (create|edit)|prerelease:\s*false.*publish/);
  for (const m of text.matchAll(/uses:\s*([^\s]+)/g)) assert.match(m[1], /@(v\d+|stable)$/, m[1]);
  // contents: write only where a release is read or written; the default is read
  assert.match(text, /^permissions:\n  contents: read/m);
  assert.equal((text.match(/contents: write/g) || []).length, 2);
  // the secrets go to the packaging step only, never to a step that runs tests or checks
  assert.equal((text.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY\b/g) || []).length, 2); // the presence check + the package step
  // both draft jobs (Electron's and this one) share a concurrency group, so they cannot create two drafts at once
  assert.match(text, /group: capri-fork-release/);
  assert.match(read('.github', 'workflows', 'build.yml'), /group: capri-fork-release/);
  for (const triple of ['macos-15', 'macos-15-intel', 'windows-latest', 'ubuntu-24.04']) assert.ok(text.includes(triple), triple);
});
