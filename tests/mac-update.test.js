'use strict';
// The macOS bundle swap (mac-update.js) on real temporary folders, with ditto, plutil, codesign and
// xattr played by a fake exec: what is checked, what is put back on failure, what is left behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMacInstaller, cleanup, locationProblem, pickZip, bundleOf, BACKUP, STAGING } = require('../src/main/mac-update');

const ZIP_BYTES = Buffer.from('pretend this is Capri-0.2.0-mac-arm64.zip');
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');

function setup(t, { fresh = { id: 'capri.desktop', version: '0.2.0' }, codesignFails = false, apps = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mac-update-'));
  t.after(() => {
    fs.chmodSync(path.join(root, 'Applications'), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const parent = path.join(root, 'Applications');
  const bundle = path.join(parent, 'Capri.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Capri'), 'old');
  const tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(tmpDir);
  const calls = [];
  const plist = new Map([[bundle, { CFBundleIdentifier: 'capri.desktop', CFBundleShortVersionString: '0.1.0' }]]);
  const exec = async (cmd, args) => {
    calls.push(path.basename(cmd));
    if (cmd.endsWith('ditto')) {
      const dest = args[3];
      for (let i = 0; i < apps; i++) {
        const app = path.join(dest, i ? `Other${i}.app` : 'Capri.app');
        fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
        fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Capri'), 'new');
        plist.set(app, { CFBundleIdentifier: fresh.id, CFBundleShortVersionString: fresh.version });
      }
      return '';
    }
    if (cmd.endsWith('plutil')) {
      const app = path.dirname(path.dirname(args[5]));
      return `${plist.get(app)?.[args[1]] ?? ''}\n`;
    }
    if (cmd.endsWith('codesign') && codesignFails) throw new Error('code object is not signed at all');
    return '';
  };
  let relaunched = 0;
  let downloads = 0;
  const download = async (url, dest, opts) => {
    downloads++;
    opts.onProgress({ transferred: ZIP_BYTES.length, total: ZIP_BYTES.length });
    fs.writeFileSync(dest, ZIP_BYTES);
  };
  const files = [
    { url: new URL('https://github.com/Libes6/capri-desktop/releases/download/fork-v0.2.0/Capri-0.2.0-mac-arm64.dmg'), info: { sha512: 'eA==' } },
    { url: new URL('https://github.com/Libes6/capri-desktop/releases/download/fork-v0.2.0/Capri-0.2.0-mac-arm64.zip'), info: { sha512: sha512(ZIP_BYTES), size: ZIP_BYTES.length } },
  ];
  const make = (extra = {}) => createMacInstaller({
    exePath: path.join(bundle, 'Contents', 'MacOS', 'Capri'), tmpDir, arch: 'arm64', exec, download, relaunch: () => { relaunched++; }, ...extra,
  });
  return { root, parent, bundle, tmpDir, calls, files, make, relaunched: () => relaunched, downloads: () => downloads };
}

const exe = (bundle) => fs.readFileSync(path.join(bundle, 'Contents', 'MacOS', 'Capri'), 'utf8');

test('download verifies size and sha512, install swaps the bundle, keeps a backup and relaunches', async (t) => {
  const s = setup(t);
  const installer = s.make();
  const progress = [];
  await installer.download(s.files, '0.2.0', (r, total) => progress.push([r, total]));
  assert.deepEqual(progress, [[ZIP_BYTES.length, ZIP_BYTES.length]]);
  await installer.install('0.2.0');
  assert.equal(exe(s.bundle), 'new');
  assert.equal(exe(path.join(s.parent, BACKUP)), 'old');
  assert.equal(fs.existsSync(path.join(s.parent, STAGING)), false);
  assert.deepEqual(fs.readdirSync(s.tmpDir), []); // the zip is gone
  assert.deepEqual(s.calls, ['ditto', 'plutil', 'plutil', 'plutil', 'codesign', 'xattr']);
  assert.equal(s.relaunched(), 1);
  // the next start removes the backup, and downloads never installed (not other files)
  fs.mkdirSync(path.join(s.tmpDir, 'capri-update-AbC123'));
  fs.writeFileSync(path.join(s.tmpDir, 'capri-update-notes.txt'), 'not ours');
  cleanup({ exePath: path.join(s.bundle, 'Contents', 'MacOS', 'Capri'), tmpDir: s.tmpDir });
  assert.deepEqual(fs.readdirSync(s.parent), ['Capri.app']);
  assert.deepEqual(fs.readdirSync(s.tmpDir), ['capri-update-notes.txt']);
});

test('a sha512 or size mismatch discards the download and installs nothing', async (t) => {
  for (const info of [{ sha512: sha512(Buffer.from('other')), size: ZIP_BYTES.length }, { sha512: sha512(ZIP_BYTES), size: 1 }, {}]) {
    const s = setup(t);
    const installer = s.make();
    const files = [{ url: s.files[1].url, info }];
    await assert.rejects(installer.download(files, '0.2.0'), (err) => err.code === 'ERR_CHECKSUM_MISMATCH');
    assert.deepEqual(fs.readdirSync(s.tmpDir), []);
    await assert.rejects(installer.install('0.2.0'), /not downloaded/);
    assert.equal(exe(s.bundle), 'old');
  }
});

for (const [name, opts, pattern] of [
  ['another bundle id', { fresh: { id: 'evil.app', version: '0.2.0' } }, /bundle id mismatch/],
  ['another version', { fresh: { id: 'capri.desktop', version: '0.1.9' } }, /bundle version mismatch/],
  ['an unsigned app', { codesignFails: true }, /not signed/],
  ['two apps in the zip', { apps: 2 }, /expected one app/],
]) {
  test(`${name}: refused, the running bundle untouched, nothing left behind`, async (t) => {
    const s = setup(t, opts);
    const installer = s.make();
    await installer.download(s.files, '0.2.0');
    await assert.rejects(installer.install('0.2.0'), pattern);
    assert.equal(exe(s.bundle), 'old');
    assert.deepEqual(fs.readdirSync(s.parent), ['Capri.app']);
    assert.equal(s.relaunched(), 0);
  });
}

test('if moving the new bundle in fails, the running one is put back', async (t) => {
  const s = setup(t);
  let renames = 0;
  const flaky = { ...fs, renameSync: (a, b) => { if (++renames === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.renameSync(a, b); } };
  const installer = s.make({ fs: flaky });
  await installer.download(s.files, '0.2.0');
  await assert.rejects(installer.install('0.2.0'), /EPERM/);
  assert.equal(exe(s.bundle), 'old');
  assert.equal(s.relaunched(), 0);
});

test('a bundle that cannot be replaced is said before anything is downloaded', async (t) => {
  assert.equal(locationProblem('/private/var/folders/x/AppTranslocation/ABC/d/Capri.app'), 'translocated');
  assert.equal(locationProblem('/Volumes/Capri 0.1.0/Capri.app'), 'disk image or external volume');
  assert.equal(locationProblem(null), 'not an app bundle');
  assert.equal(bundleOf('/usr/local/bin/capri'), null);
  if (process.getuid?.() === 0 || process.platform === 'win32') return; // root writes anywhere; a Windows folder has no 0o555
  const s = setup(t);
  fs.chmodSync(s.parent, 0o555);
  const installer = s.make();
  await assert.rejects(installer.download(s.files, '0.2.0'), (err) => err.code === 'ERR_CAPRI_LOCATION');
  assert.equal(s.downloads(), 0);
});

test('a new check lets the previous download go', async (t) => {
  const s = setup(t);
  const installer = s.make();
  await installer.download(s.files, '0.2.0');
  assert.equal(fs.readdirSync(s.tmpDir).length, 1);
  installer.discard();
  assert.deepEqual(fs.readdirSync(s.tmpDir), []);
  await assert.rejects(installer.install('0.2.0'), /not downloaded/);
});

test('the zip for this Mac is picked, never the dmg', () => {
  const f = (name) => ({ url: new URL(`https://x/${name}`), info: {} });
  const files = [f('Capri-0.2.0-mac-arm64.dmg'), f('Capri-0.2.0-mac-x64.zip'), f('Capri-0.2.0-mac-arm64.zip')];
  assert.equal(pickZip(files, 'arm64'), files[2]);
  assert.equal(pickZip(files, 'x64'), files[1]);
  assert.equal(pickZip([files[0]], 'arm64'), null);
  assert.equal(pickZip([f('Capri-0.2.0-mac-x64.zip')], 'arm64'), null);
});

test('a symlink in place of the app (ditto keeps them) is refused, nothing moved', async (t) => {
  const s = setup(t, { apps: 0 });
  const installer = s.make({
    exec: async (cmd, args) => {
      if (cmd.endsWith('ditto')) fs.symlinkSync(s.tmpDir, path.join(args[3], 'Capri.app'));
      return '';
    },
  });
  await installer.download(s.files, '0.2.0');
  await assert.rejects(installer.install('0.2.0'), /not a folder/);
  assert.equal(exe(s.bundle), 'old');
  assert.deepEqual(fs.readdirSync(s.parent), ['Capri.app']);
  assert.equal(s.relaunched(), 0);
});

test('cleanup never removes the running bundle, even one named like the backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mac-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, BACKUP);
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  cleanup({ exePath: path.join(bundle, 'Contents', 'MacOS', 'Capri') });
  assert.ok(fs.existsSync(bundle));
});

// Real ditto, plutil and xattr (codesign played: these test bundles carry no executable to sign),
// in folders with spaces and Cyrillic, as a Mac may well have them.
test('macOS tools: a real zip installed into a folder with spaces and Cyrillic', { skip: process.platform !== 'darwin' }, async (t) => {
  const { execFile } = require('node:child_process');
  const real = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message))) : resolve(String(out)))));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capri mac update '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plist = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>capri.desktop</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
  const makeApp = (app, version, body) => {
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(version));
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Capri'), body);
    fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'файлы с пробелами'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'файлы с пробелами', 'её заметка.txt'), body);
  };
  const parent = path.join(root, 'Мои программы');
  const bundle = path.join(parent, 'Capri Beta.app');
  makeApp(bundle, '0.1.0', 'old');
  const build = path.join(root, 'build dir');
  makeApp(path.join(build, 'Capri.app'), '0.2.0', 'new');
  const zip = path.join(root, 'Capri-0.2.0-mac-arm64.zip');
  await real('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(build, 'Capri.app'), zip]);
  const bytes = fs.readFileSync(zip);
  const tmpDir = path.join(root, 'tmp dir');
  fs.mkdirSync(tmpDir);
  let relaunched = 0;
  const calls = [];
  const installer = createMacInstaller({
    exePath: path.join(bundle, 'Contents', 'MacOS', 'Capri'),
    tmpDir,
    arch: 'arm64',
    exec: (cmd, args) => { calls.push(path.basename(cmd)); return cmd.endsWith('codesign') ? Promise.resolve('') : real(cmd, args); },
    download: async (url, dest) => fs.copyFileSync(zip, dest),
    relaunch: () => { relaunched++; },
  });
  const files = [{ url: new URL('https://github.com/Libes6/capri-desktop/releases/download/fork-v0.2.0/Capri-0.2.0-mac-arm64.zip'), info: { sha512: sha512(bytes), size: bytes.length } }];
  await installer.download(files, '0.2.0');
  await installer.install('0.2.0');
  assert.equal(exe(bundle), 'new');
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'файлы с пробелами', 'её заметка.txt'), 'utf8'), 'new');
  assert.equal(exe(path.join(parent, BACKUP)), 'old');
  assert.deepEqual(fs.readdirSync(parent).sort(), [BACKUP, 'Capri Beta.app'].sort());
  assert.deepEqual(calls, ['ditto', 'plutil', 'plutil', 'plutil', 'codesign', 'xattr']);
  assert.equal(relaunched, 1);
  cleanup({ exePath: path.join(bundle, 'Contents', 'MacOS', 'Capri'), tmpDir });
  assert.deepEqual(fs.readdirSync(parent), ['Capri Beta.app']);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});
