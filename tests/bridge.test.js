'use strict';
// TAURI-13: the bridge release. The Electron build's updater (electron-updater + mac-update.js) takes the Tauri installers
// through latest*.yml; before it installs, the keys are handed over; if that does not fully work she is told and agrees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const bridge = require('../scripts/bridge-feed');
const rel = require('../scripts/release-tauri');
const pack = require('../scripts/package-tauri');
const { releaseFiles, draftPayload } = require('../scripts/draft-release');
const { UpdateController, isTauriBridge, bridgeProblem, macTransport, updaterTransport } = require('../src/main/updates');
const mac = require('../src/main/mac-update');

const ROOT = path.resolve(__dirname, '..');
const tmp = (t, prefix = 'capri-bridge-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const V = '0.2.0';
const NAMES = {
  zip: `Capri-${V}-macOS-arm64-bridge.zip`,
  exe: `Capri-${V}-Windows-x64-setup.exe`,
  appimage: `Capri-${V}-Linux-x64.AppImage`,
};

function folder(t) {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, NAMES.zip), 'a zip of Capri.app');
  fs.writeFileSync(path.join(dir, NAMES.exe), 'the NSIS installer');
  fs.writeFileSync(path.join(dir, NAMES.appimage), 'the AppImage');
  return dir;
}

// --- the feeds ---------------------------------------------------------------------------------------------------

test('the three feeds name the Tauri files of this version, with the sha512 (base64) and size of the bytes, and the bridge mark', (t) => {
  const dir = folder(t);
  assert.deepEqual(bridge.buildFeeds({ dir, version: V, date: '2026-10-29T10:00:00Z' }), ['latest.yml', 'latest-linux.yml', 'latest-mac.yml']);
  for (const [feed, name] of [['latest.yml', NAMES.exe], ['latest-linux.yml', NAMES.appimage], ['latest-mac.yml', NAMES.zip]]) {
    const text = fs.readFileSync(path.join(dir, feed), 'utf8');
    const bytes = fs.readFileSync(path.join(dir, name));
    const info = bridge.parseFeed(text);
    assert.equal(info.version, V);
    assert.equal(info.bridge, 'tauri');
    assert.deepEqual(info.files, [{ url: name, sha512: sha512(bytes), size: bytes.length }]);
    assert.equal(info.path, name);
    assert.equal(info.sha512, sha512(bytes));
    assert.match(text, /releaseDate: '2026-10-29T10:00:00\.000Z'/);
  }
  assert.deepEqual(bridge.checkFeeds(dir, V), bridge.FEED_FILES);
});

test('electron-updater itself reads the feeds: its parser finds the file each system takes, and the mac zip is the one mac-update picks', (t) => {
  const dir = folder(t);
  bridge.buildFeeds({ dir, version: V });
  const { parseUpdateInfo, getFileList, findFile } = require('electron-updater/out/providers/Provider');
  const base = `https://github.com/Libes6/capri-desktop/releases/download/fork-v${V}/`;
  const read = (feed) => {
    const info = parseUpdateInfo(fs.readFileSync(path.join(dir, feed), 'utf8'), feed, new URL(feed, base));
    return { info, files: getFileList(info).map((f) => ({ url: new URL(f.url, base), info: f })) };
  };
  const win = read('latest.yml');
  assert.equal(findFile(win.files, 'exe').url.pathname.split('/').pop(), NAMES.exe);
  const linux = read('latest-linux.yml');
  assert.equal(findFile(linux.files, 'AppImage', ['rpm', 'deb', 'pacman']).url.pathname.split('/').pop(), NAMES.appimage);
  const darwin = read('latest-mac.yml');
  assert.equal(mac.pickZip(darwin.files, 'arm64').url.pathname.split('/').pop(), NAMES.zip);
  // the extra field survives in what the updater hands to the app, and the app takes it for a bridge
  for (const r of [win, linux, darwin]) assert.equal(isTauriBridge(r.info), true);
});

test('feeds are refused for a missing or empty file, an odd version, an odd date; nothing is written', (t) => {
  const dir = folder(t);
  fs.rmSync(path.join(dir, NAMES.appimage));
  assert.throws(() => bridge.buildFeeds({ dir, version: V }), /latest-linux\.yml.*not in/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.yml')), []);
  fs.writeFileSync(path.join(dir, NAMES.appimage), '');
  assert.throws(() => bridge.buildFeeds({ dir, version: V }), /empty/);
  fs.writeFileSync(path.join(dir, NAMES.appimage), 'x');
  assert.throws(() => bridge.buildFeeds({ dir, version: '0.2' }), /Invalid release version/);
  assert.throws(() => bridge.buildFeeds({ dir, version: V, date: 'yesterday' }), /Invalid release date/);
});

test('checkFeeds catches a changed file, another version, a lost mark, an extra or another file', (t) => {
  const dir = folder(t);
  bridge.buildFeeds({ dir, version: V });
  assert.throws(() => bridge.checkFeeds(dir, '0.3.0'), /is for 0\.2\.0, not 0\.3\.0/);
  const feedFile = path.join(dir, 'latest.yml');
  const good = fs.readFileSync(feedFile, 'utf8');
  fs.writeFileSync(feedFile, good.replace('capriBridge: tauri\n', ''));
  assert.throws(() => bridge.checkFeeds(dir, V), /not marked capriBridge/);
  fs.writeFileSync(feedFile, good.replace(/size: \d+/, 'size: 1'));
  assert.throws(() => bridge.checkFeeds(dir, V), /size of .* does not match/);
  fs.writeFileSync(feedFile, good);
  fs.writeFileSync(path.join(dir, NAMES.exe), 'another installer, same name');
  assert.throws(() => bridge.checkFeeds(dir, V), /sha512 of .* does not match/);
  fs.writeFileSync(path.join(dir, NAMES.exe), 'the NSIS installer');
  fs.writeFileSync(feedFile, good.replace(NAMES.exe, `Capri-${V}-win-x64.exe`));
  assert.throws(() => bridge.checkFeeds(dir, V), /must offer/);
  fs.writeFileSync(feedFile, good);
  fs.rmSync(path.join(dir, 'latest-mac.yml'));
  assert.throws(() => bridge.checkFeeds(dir, V), /Missing latest-mac\.yml/);
});

test('the bridge is off unless bridge.json (or CAPRI_BRIDGE=1) says so; the repository ships it off', (t) => {
  assert.equal(bridge.bridgeEnabled({ env: {} }), false);
  assert.equal(bridge.bridgeEnabled({ env: { CAPRI_BRIDGE: '1' } }), true);
  const root = tmp(t);
  assert.equal(bridge.bridgeEnabled({ root, env: {} }), false); // no file
  fs.writeFileSync(path.join(root, 'bridge.json'), '{ "tauri": true }');
  assert.equal(bridge.bridgeEnabled({ root, env: {} }), true);
  assert.equal(bridge.bridgeEnabled({ root, env: { CAPRI_BRIDGE: '0' } }), false);
  fs.writeFileSync(path.join(root, 'bridge.json'), 'not json');
  assert.equal(bridge.bridgeEnabled({ root, env: {} }), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge.json'), 'utf8')).tauri, false);
});

// --- the release folder ------------------------------------------------------------------------------------------

function artifacts(t, { zip = true } = {}) {
  const dir = tmp(t);
  const put = (platform, name, text) => {
    fs.mkdirSync(path.join(dir, platform), { recursive: true });
    fs.writeFileSync(path.join(dir, platform, name), text);
  };
  const sig = Buffer.from('untrusted comment: signature\nRUQ=\n').toString('base64');
  put('darwin-aarch64', 'Capri.app.tar.gz', 'tar');
  put('darwin-aarch64', 'Capri.app.tar.gz.sig', sig);
  put('darwin-aarch64', 'Capri_0.2.0_aarch64.dmg', 'dmg');
  if (zip) put('darwin-aarch64', 'Capri-bridge.zip', 'the bridge zip');
  put('windows-x86_64', 'Capri_0.2.0_x64-setup.exe', 'nsis');
  put('windows-x86_64', 'Capri_0.2.0_x64-setup.exe.sig', sig);
  put('linux-x86_64', 'capri_0.2.0_amd64.AppImage', 'appimage');
  put('linux-x86_64', 'capri_0.2.0_amd64.AppImage.sig', sig);
  put('linux-x86_64', 'capri_0.2.0_amd64.deb', 'deb');
  return dir;
}

test('assemble with the bridge on puts latest.json (Tauri) and the three latest*.yml (Electron bridge) in one folder, for one version', (t) => {
  const out = path.join(tmp(t), 'out');
  const feed = rel.assemble({ artifacts: artifacts(t), version: V, out, bridge: true });
  const names = fs.readdirSync(out).sort();
  for (const name of ['latest.json', 'latest.yml', 'latest-linux.yml', 'latest-mac.yml', NAMES.zip, NAMES.exe, NAMES.appimage, 'SHA256SUMS']) assert.ok(names.includes(name), name);
  assert.equal(feed.version, V);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8')).version, V);
  for (const f of bridge.FEED_FILES) assert.equal(bridge.parseFeed(fs.readFileSync(path.join(out, f), 'utf8')).version, V);
  // the bridge zip is listed with the other files, and every hash is right
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');
  assert.match(sums, new RegExp(`${createHash('sha256').update('the bridge zip').digest('hex')}  ${NAMES.zip.replace(/\./g, '\\.')}`));
  const upload = rel.checkRelease(out, V, { bridge: true });
  assert.equal(upload.at(-1), 'latest.json');
  for (const f of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml', NAMES.zip]) assert.ok(upload.includes(f), f);
  // the same folder is not a release with the bridge off
  assert.throws(() => rel.checkRelease(out, V), /Unexpected latest.*bridge is off/);
});

test('assemble with the bridge off writes no latest*.yml and no zip (the Electron job owns those names)', (t) => {
  const out = path.join(tmp(t), 'out');
  rel.assemble({ artifacts: artifacts(t), version: V, out });
  assert.deepEqual(fs.readdirSync(out).filter((n) => /\.yml$|bridge/.test(n)), []);
  assert.ok(rel.checkRelease(out, V).includes('latest.json'));
  assert.equal(rel.isTauriAsset('latest.yml'), false); // the Tauri job never deletes the Electron feeds as "its own stale files"
  assert.equal(rel.isTauriAsset(NAMES.zip), true);
});

test('the bridge needs the zip from the Mac build; a folder that lost a feed or a file is refused', (t) => {
  assert.throws(() => rel.assemble({ artifacts: artifacts(t, { zip: false }), version: V, out: path.join(tmp(t), 'o'), bridge: true }), /expected one \*-bridge\.zip/);
  const out = path.join(tmp(t), 'out');
  rel.assemble({ artifacts: artifacts(t), version: V, out, bridge: true });
  fs.rmSync(path.join(out, 'latest-linux.yml'));
  assert.throws(() => rel.checkRelease(out, V, { bridge: true }), /Missing latest-linux\.yml/);
});

test('the Tauri notes say what the bridge is; the Electron draft job stops writing latest*.yml in a bridge release', (t) => {
  assert.match(rel.tauriBlock(V, 'abc', { bridge: true }), /Bridge:.*latest\.yml.*latest-mac\.yml/s);
  assert.doesNotMatch(rel.tauriBlock(V, 'abc'), /Bridge:/);
  assert.match(rel.draftPlan({ version: V, sha: 'abc', bridge: true }).payload.body, /Bridge:/);
  // Electron job: installers only, no feeds required or uploaded
  const dir = tmp(t);
  const installers = ['win-x64.exe', 'linux-x86_64.AppImage', 'linux-amd64.deb', 'mac-arm64.dmg', 'mac-arm64.zip'].map((s) => `Capri-0.1.0-${s}`);
  for (const n of installers) fs.writeFileSync(path.join(dir, n), n);
  assert.deepEqual(releaseFiles(dir, '0.1.0', { bridge: true }), installers);
  assert.throws(() => releaseFiles(dir, '0.1.0'), /Missing update file/);
  assert.match(draftPayload(null, '0.1.0', 'abc', { bridge: true }).body, /This release is the bridge/);
  assert.doesNotMatch(draftPayload(null, '0.1.0', 'abc').body, /bridge/i);
});

test('the Windows installer carries the hook, the hook knows the Electron uninstall key electron-builder derives from the appId', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.bundle.conf.json'), 'utf8'));
  const hooks = conf.bundle.windows.nsis.installerHooks;
  assert.equal(hooks, 'windows/hooks.nsh');
  const text = fs.readFileSync(path.join(ROOT, 'src-tauri', hooks), 'utf8');
  const { UUID } = require('builder-util-runtime');
  const guid = UUID.v5(require('../package.json').build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  assert.match(text, new RegExp(`CAPRI_ELECTRON_GUID "${guid}"`));
  assert.match(text, /!macro NSIS_HOOK_PREINSTALL/);
  assert.match(text, /!macro NSIS_HOOK_POSTINSTALL/);
  assert.match(text, /--force-run/);
  assert.doesNotMatch(text.replace(/^;.*$/gm, ''), /delete-app-data/); // never the user's data (the comments say so)
  // balanced macros and conditionals (NSIS cannot be run here)
  assert.equal((text.match(/^!macro /gm) || []).length, (text.match(/^!macroend/gm) || []).length);
  assert.equal((text.match(/\$\{If\}/g) || []).length + (text.match(/\$\{IfNot\}/g) || []).length, (text.match(/\$\{EndIf\}/g) || []).length);
});

// --- the Electron side: which update is a bridge, and what happens before it is installed -------------------------

const bridgeInfo = (extra = {}) => ({
  version: V,
  files: [{ url: NAMES.zip, sha512: 'x', size: 1 }],
  path: NAMES.zip,
  capriBridge: 'tauri',
  ...extra,
});

test('only a feed with the mark AND Tauri file names is a bridge; Electron updates never are', () => {
  assert.equal(isTauriBridge(bridgeInfo()), true);
  assert.equal(isTauriBridge(bridgeInfo({ files: [{ url: `Capri-${V}-Windows-x64-setup.exe` }], path: undefined })), true);
  assert.equal(isTauriBridge({ version: V, files: [{ url: `Capri-${V}-mac-arm64.zip` }], path: `Capri-${V}-mac-arm64.zip` }), false); // an ordinary one
  assert.equal(isTauriBridge(bridgeInfo({ capriBridge: undefined })), false); // Tauri names, no mark
  assert.equal(isTauriBridge(bridgeInfo({ files: [{ url: `Capri-${V}-mac-arm64.zip` }], path: `Capri-${V}-mac-arm64.zip` })), false); // the mark, Electron names
  assert.equal(isTauriBridge(bridgeInfo({ capriBridge: 'electron' })), false);
  assert.equal(isTauriBridge(bridgeInfo({ files: [{ url: NAMES.zip }, { url: `Capri-${V}-mac-arm64.dmg` }] })), false); // one odd file spoils it
  assert.equal(isTauriBridge(bridgeInfo({ files: [{ url: 'https://evil.example/Capri-0.2.0-macOS-arm64.zip/../../x.exe' }], path: undefined })), false);
  assert.equal(isTauriBridge(bridgeInfo({ files: [], path: undefined })), false);
  assert.equal(isTauriBridge(null), false);
  assert.equal(isTauriBridge({}), false);
});

test('the transports pass the bridge flag of electron-updater\'s answer to the offer (Windows/AppImage, macOS), an ordinary update stays plain', async () => {
  const updater = (info) => ({ checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: info }), updateInfoAndProvider: { provider: { resolveFiles: () => [] } } });
  assert.equal((await updaterTransport(updater(bridgeInfo())).check()).bridge, true);
  assert.equal((await updaterTransport(updater({ version: V })).check()).bridge, false);
  const installs = [];
  const installer = { download: async () => {}, install: async (v, o) => installs.push([v, o]), discard: () => {} };
  const offered = await macTransport(updater(bridgeInfo()), installer).check();
  assert.equal(offered.bridge, true);
  await offered.install();
  assert.deepEqual(installs, [[V, { bridge: true }]]);
  const plain = await macTransport(updater({ version: V }), installer).check();
  await plain.install();
  assert.deepEqual(installs.at(-1), [V, { bridge: false }]);
});

function controller({ bridge = true, prepare, install = async () => {} } = {}) {
  const seen = [];
  const calls = [];
  const c = new UpdateController({
    current: '0.1.0',
    onChange: (v) => seen.push(v),
    log: () => {},
    prepare: prepare && (async () => { calls.push('prepare'); return prepare(); }),
    transport: { check: async () => ({ version: V, notes: '', tag: null, bridge, download: async () => {}, install: async () => { calls.push('install'); await install(); } }) },
  });
  return { c, seen, calls };
}

test('a bridge update hands the keys over first, then installs; the view says it is a bridge', async () => {
  const { c, calls } = controller({ prepare: () => ({ problem: null }) });
  await c.check();
  assert.equal(c.view().bridge, true);
  await c.download();
  await c.install(async () => true);
  assert.deepEqual(calls, ['prepare', 'install']);
  assert.equal(c.status.kind, 'installing');
});

test('an ordinary Electron update never prepares anything', async () => {
  const { c, calls } = controller({ bridge: false, prepare: () => assert.fail('prepared an ordinary update') });
  await c.check();
  assert.equal(c.view().bridge, undefined);
  await c.download();
  await c.install(async () => true);
  assert.deepEqual(calls, ['install']);
});

test('a hand-over that did not fully work does not block the update, but she is told which keys, and agrees once more', async () => {
  let undone = 0;
  const problem = { keys: ['OpenAI', 'Anthropic'], reason: 'no key store tool on this system' };
  const { c, calls, seen } = controller({ prepare: () => ({ problem, undo: () => { undone++; } }) });
  await c.check();
  await c.download();
  const first = await c.install(async () => true);
  assert.deepEqual(calls, ['prepare']); // nothing installed yet
  assert.equal(first.kind, 'downloaded');
  assert.deepEqual(first.bridgeWarning, problem);
  assert.equal(first.canDownload, true);
  assert.equal(seen.at(-1).bridgeWarning.keys.length, 2);
  // declined (a confirmation that says no): still waiting, the warning stays
  await c.install(async () => false);
  assert.equal(c.status.kind, 'downloaded');
  assert.deepEqual(calls, ['prepare']);
  // agreed: the update goes on without asking a third time
  await c.install(async () => true);
  assert.deepEqual(calls, ['prepare', 'prepare', 'install']);
  assert.equal(c.status.kind, 'installing');
  assert.equal(undone, 0);
});

test('a hand-over that throws is the same: a general warning, no key names', async () => {
  const { c } = controller({ prepare: () => { throw new Error('boom https://x.example/path?token=SECRET'); } });
  await c.check();
  await c.download();
  const view = await c.install(async () => true);
  assert.deepEqual(view.bridgeWarning.keys, []);
  assert.doesNotMatch(JSON.stringify(view), /SECRET/);
});

test('when the install then fails, what the hand-over changed (the login item) is put back', async () => {
  let undone = 0;
  const { c } = controller({ prepare: () => ({ problem: null, undo: () => { undone++; } }), install: async () => { throw new Error('bundle id mismatch'); } });
  await c.check();
  await c.download();
  await c.install(async () => true);
  assert.equal(c.status.kind, 'error');
  assert.equal(undone, 1);
});

test('a new check forgets the warning', async () => {
  const { c } = controller({ prepare: () => ({ problem: { keys: ['OpenAI'], reason: '' } }) });
  await c.check();
  await c.download();
  await c.install(async () => true);
  assert.ok(c.view().bridgeWarning);
  await c.check();
  assert.equal(c.view().bridgeWarning, undefined);
  assert.equal(c.warned, c.warned); // (a new offer is a new object: it is warned about again)
  await c.download();
  const again = await c.install(async () => true);
  assert.ok(again.bridgeWarning);
});

test('bridgeProblem: null when every key moved, else the providers that did not, never a key', () => {
  const keys = { openai: 'enc:AAAA', anthropic: 'enc:BBBB', gemini: '', local: 'plain-key-value' };
  const label = (id) => ({ openai: 'OpenAI', anthropic: 'Anthropic' }[id] || id);
  assert.equal(bridgeProblem({ ok: true, keys: ['openai', 'anthropic'] }, keys, label), null);
  assert.equal(bridgeProblem({ ok: true, keys: [] }, {}, label), null); // nothing to carry
  assert.deepEqual(bridgeProblem({ ok: false, keys: [], skipped: 'no key store tool on this system' }, keys, label), { keys: ['OpenAI', 'Anthropic'], reason: 'no key store tool on this system' });
  assert.deepEqual(bridgeProblem({ ok: false, keys: ['openai'], failed: ['anthropic'] }, keys, label), { keys: ['Anthropic'], reason: 'a key could not be opened' });
  assert.deepEqual(bridgeProblem({ ok: false, keys: [], skipped: 'could not write tauri-keys.json: EACCES' }, {}, label), { keys: [], reason: 'could not write tauri-keys.json: EACCES' });
  assert.doesNotMatch(JSON.stringify(bridgeProblem({ ok: false, keys: [], skipped: 'x' }, keys, label)), /AAAA|BBBB|plain-key/);
});

test('the warning and the bridge hint are in all five languages', () => {
  const { SETTINGS, LANGS } = require('../src/main/labels');
  for (const lang of LANGS) {
    for (const key of ['updBridge', 'updBridgeKeys', 'updBridgeSome', 'updBridgeAnyway', 'updBridgeConfirm']) assert.equal(typeof SETTINGS[lang][key], 'string', `${lang}.${key}`);
    assert.match(SETTINGS[lang].updBridgeKeys, /\{keys\}/, lang);
    assert.doesNotMatch(SETTINGS[lang].updBridgeSome, /\{keys\}/, lang);
  }
  assert.equal(LANGS.length, 5);
});

// --- mac-update with the Tauri app ------------------------------------------------------------------------------

test('relaunchBundle waits for the old process and opens the bundle through the system, arguments never in the script text', () => {
  const calls = [];
  const child = { unref: () => calls.push('unref') };
  const lines = [];
  mac.relaunchBundle({ bundle: '/Applications/Capri $(touch x).app', pid: 4242, env: { CAPRI_PORT: '47901', B: 'a b' }, log: (l) => lines.push(l), spawnFn: (cmd, args, opts) => { calls.push([cmd, args, opts]); return child; } });
  const [cmd, args, opts] = calls[0];
  assert.equal(cmd, '/bin/sh');
  assert.deepEqual(args.slice(2), ['capri-relaunch', '4242', '--env', 'CAPRI_PORT=47901', '--env', 'B=a b', '/Applications/Capri $(touch x).app']);
  assert.doesNotMatch(args[1], /Applications|4242|47901/);
  assert.match(args[1], /kill -0 "\$pid".*exec \/usr\/bin\/open "\$@"/);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.deepEqual(calls[1], 'unref');
  assert.match(lines[0], /Capri \$\(touch x\)\.app after pid 4242/);
  assert.throws(() => mac.relaunchBundle({ bundle: null, pid: 1 }), /no bundle/);
});

test('a zip of a Tauri Capri.app (Contents/MacOS/capri, not Capri) is swapped in and relaunched as a bridge, with the system tools', { skip: process.platform !== 'darwin' && 'needs ditto, plutil and codesign (macOS)' }, async (t) => {
  const root = fs.realpathSync(tmp(t, 'capri-bridge-mac-'));
  const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  const makeApp = (dir, { exe, version, id = 'capri.desktop', extra = [] }) => {
    const app = path.join(dir, 'Capri.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>\n`);
    for (const name of [exe, ...extra]) {
      const file = path.join(app, 'Contents', 'MacOS', name);
      fs.writeFileSync(file, `#!/bin/sh\necho ${name}\n`);
      fs.chmodSync(file, 0o755);
    }
    fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'bin', 'capri-hook'), 'hook');
    sh('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app]); // ad-hoc, as the Tauri bundle's
    return app;
  };
  // the installed Electron app and the Tauri app, zipped as package-tauri's bridgeZip does
  const installed = path.join(root, 'Applications');
  fs.mkdirSync(installed);
  const old = makeApp(installed, { exe: 'Capri', version: '0.1.0' });
  const tauriDir = path.join(root, 'tauri');
  fs.mkdirSync(tauriDir);
  const tauriApp = makeApp(tauriDir, { exe: 'capri', version: V, extra: ['capri-sidecar'] });
  const zip = pack.bridgeZip(tauriApp, tauriDir);
  assert.equal(path.basename(zip), 'Capri-bridge.zip');
  const bytes = fs.readFileSync(zip);
  const tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(tmpDir);
  const relaunches = [];
  const installer = mac.createMacInstaller({
    exePath: path.join(old, 'Contents', 'MacOS', 'Capri'),
    tmpDir,
    arch: 'arm64',
    download: async (url, dest) => fs.copyFileSync(zip, dest),
    relaunch: (o) => relaunches.push(o),
  });
  const files = [{ url: new URL(`https://example.invalid/${NAMES.zip}`), info: { sha512: sha512(bytes), size: bytes.length } }];
  await installer.download(files, V, () => {});
  await installer.install(V, { bridge: true });
  const now = path.join(installed, 'Capri.app', 'Contents');
  assert.ok(fs.existsSync(path.join(now, 'MacOS', 'capri-sidecar')), 'the Tauri app is at the old bundle path');
  assert.ok(fs.readdirSync(path.join(now, 'MacOS')).includes('capri'));
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(now, 'Info.plist')], { encoding: 'utf8' }).trim(), V);
  assert.ok(fs.existsSync(path.join(installed, mac.BACKUP)), 'the Electron bundle is kept beside it');
  assert.deepEqual(relaunches, [{ bridge: true }]);
  // and the Tauri start removes the backup (updates.js, startTauriUpdates → cleanup with the Tauri exe path)
  mac.cleanup({ exePath: path.join(now, 'MacOS', 'capri'), tmpDir });
  assert.equal(fs.existsSync(path.join(installed, mac.BACKUP)), false);
  assert.ok(fs.existsSync(path.join(now, 'MacOS', 'capri')));
});

test('with a fake exec: a Tauri-shaped zip passes the bundle checks, another bundle id or version does not', async (t) => {
  const root = tmp(t);
  const parent = path.join(root, 'Applications');
  const bundle = path.join(parent, 'Capri.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Capri'), 'electron');
  fs.mkdirSync(path.join(root, 'tmp'));
  const ZIP = Buffer.from('zip');
  const run = async (fresh) => {
    const plist = new Map([[bundle, { CFBundleIdentifier: 'capri.desktop', CFBundleShortVersionString: '0.1.0' }]]);
    const exec = async (cmd, args) => {
      if (cmd.endsWith('ditto')) {
        const app = path.join(args[3], 'Capri.app');
        fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
        fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'capri'), 'tauri');
        plist.set(app, { CFBundleIdentifier: fresh.id, CFBundleShortVersionString: fresh.version });
      }
      if (cmd.endsWith('plutil')) return `${plist.get(path.dirname(path.dirname(args[5])))?.[args[1]] ?? ''}\n`;
      return '';
    };
    const relaunches = [];
    const installer = mac.createMacInstaller({
      exePath: path.join(bundle, 'Contents', 'MacOS', 'Capri'), tmpDir: path.join(root, 'tmp'), arch: 'arm64', exec,
      download: async (url, dest) => fs.writeFileSync(dest, ZIP), relaunch: (o) => relaunches.push(o),
    });
    await installer.download([{ url: new URL(`https://example.invalid/${NAMES.zip}`), info: { sha512: sha512(ZIP), size: ZIP.length } }], V);
    return installer.install(V, { bridge: true }).then(() => relaunches, (err) => err);
  };
  assert.match((await run({ id: 'other.app', version: V })).message, /bundle id mismatch/);
  assert.match((await run({ id: 'capri.desktop', version: '9.9.9' })).message, /version mismatch/);
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents', 'MacOS', 'Capri'), 'utf8'), 'electron'); // the running one untouched
  assert.deepEqual(await run({ id: 'capri.desktop', version: V }), [{ bridge: true }]);
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents', 'MacOS', 'capri'), 'utf8'), 'tauri');
});
