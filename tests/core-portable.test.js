'use strict';
// TAURI-01: the core of Capri is plain node, whatever shell it runs under. It loads in a process that refuses
// `electron`, the fake platform has every method of the interface, and the core starts and answers its commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { missing, SHAPE, OVERLAY_API, TRAY_API } = require('../src/main/platform');
const { TRAY } = require('../src/main/labels');
const { createFakePlatform } = require('../src/main/platform/fake');

const MAIN = path.resolve(__dirname, '../src/main');
test('the modules that were Electron-bound are plain node now', () => {
  // each loads in a process that refuses `electron`, with nothing but node's own modules
  const modules = ['config', 'labels', 'lang', 'capabilities', 'settings-patch', 'settings-view', 'llm', 'ollama', 'setup', 'files',
    'apps', 'launch', 'bridge', 'assistants', 'linux/x11', 'linux/x11-watch', 'mac/window-watch', 'power', 'updates',
    'windows', 'tray-menu', 'core', 'settings-window'];
  const script = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (/^electron(-updater)?$/.test(request)) throw new Error('electron was asked for by ' + (rest[0] && rest[0].filename));
      return load.call(this, request, ...rest);
    };
    for (const m of ${JSON.stringify(modules)}) require(${JSON.stringify(MAIN)} + '/' + m);
    console.log('loaded ' + ${modules.length});
  `;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`loaded ${modules.length}`));
});

test('the fake platform has every method of the interface', () => {
  assert.deepEqual(missing(createFakePlatform()), []);
  assert.ok(missing({}).length > 20 && missing({}).includes('paths.get'));
  // what the handles of a window and of the tray are
  const fake = createFakePlatform();
  const overlay = fake.windows.createOverlay({ area: { x: 0, y: 0, width: 10, height: 10 } });
  for (const method of OVERLAY_API) assert.equal(typeof overlay[method], 'function', `overlay.${method}`);
  const tray = fake.tray.create({ onClick() {} });
  for (const method of TRAY_API) assert.equal(typeof tray[method], 'function', `tray.${method}`);
  assert.ok(Object.keys(SHAPE).length >= 15);
});

// ---- the core, started on the fake platform ----

function startCore(extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-core-'));
  const platform = createFakePlatform({ userData });
  const watched = [];
  const watchWindows = (o) => { watched.push(o); return { stop() { watched.stopped = true; }, refresh() {} }; };
  const { createCore } = require('../src/main/core');
  const core = createCore({ platform, smoke: true, watchWindows, ...extra });
  core.start();
  return { core, platform, userData, watched };
}

test('the core starts on the fake platform: overlay, settings window, tray menu, shortcut, watchers', () => {
  const { core, platform, watched, userData } = startCore();
  try {
    assert.equal(platform.overlays.length, 1);
    assert.ok(core.overlay().isAlive());
    assert.deepEqual(core.overlay().bounds(), { x: 0, y: 0, width: 1280, height: 760 }, 'her window is the work area');
    assert.ok(platform.calls.some((c) => c.name === 'tray.create'));
    assert.ok(platform.calls.some((c) => c.name === 'shortcuts.register' && c.args[0] === 'Control+Alt+C'));
    assert.equal(watched.length, 1);
    assert.equal(watched[0].overlay, core.overlay());
    const labels = core.menu.labels();
    assert.ok(labels.length > 20);
    assert.ok(labels.some((l) => typeof l === 'object' && Object.keys(l)[0]), 'submenus are there');
    // her menu is a template (data) with click handlers, set on the tray whole
    assert.equal(platform.lastTrayMenu.at(-1).click.length, 0);
    core.stop();
    assert.ok(platform.calls.some((c) => c.name === 'shortcuts.unregisterAll'));
    assert.equal(watched.stopped, true);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the menu\'s clicks go through the core: a checkbox saves and the overlay hears of it, quit and display go to the platform', () => {
  const { core, platform, userData } = startCore();
  try {
    const before = core.config.load().muted;
    const sentBefore = platform.sent.length;
    core.menu.click(TRAY.en.mute);
    assert.equal(core.config.load().muted, !before);
    assert.ok(platform.sent.slice(sentBefore).some((m) => m.channel === 'capri:config' && m.payload.muted === !before));
    assert.equal(JSON.parse(fs.readFileSync(core.config.file(), 'utf8')).muted, !before);
    // the radio of the display mode saves it and relaunches in that mode (the fake speaks English)
    const display = platform.lastTrayMenu.find((i) => i.label === TRAY.en.display);
    display.submenu.find((i) => i.label === TRAY.en.displaySoftware).click({});
    assert.equal(core.config.load().render, 'software');
    assert.deepEqual(platform.calls.filter((c) => c.name === 'app.relaunch' || c.name === 'app.exit').map((c) => c.name), ['app.relaunch', 'app.exit']);
    // and the last item quits
    platform.lastTrayMenu.at(-1).click({});
    assert.ok(platform.calls.some((c) => c.name === 'app.quit'));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the settings commands are answered only for the settings window; keys never reach the pages', async () => {
  const { core, platform, userData } = startCore();
  try {
    const settings = core.settings();
    settings.open();
    const sender = settings.window().webContents;
    const stranger = { id: 'overlay' };
    // a page that is not the settings window gets nothing, and changes nothing
    assert.equal(core.ipc.handle['settings:view'](null, stranger), null);
    assert.equal(core.ipc.handle['settings:set']({ volume: 0.31 }, stranger), null);
    assert.equal(await core.ipc.handle['settings:key']({ provider: 'openai', key: 'sk-test-0123456789' }, stranger), null);
    assert.equal(core.ipc.handle['settings:reset'](null, stranger), null);
    assert.notEqual(core.config.load().volume, 0.31);
    // the settings window itself
    const view = core.ipc.handle['settings:view'](null, sender);
    assert.ok(view.sections.length >= 4);
    const set = core.ipc.handle['settings:set']({ volume: 0.31 }, sender);
    assert.deepEqual(set, { ok: true, status: 'saved' });
    assert.equal(core.config.load().volume, 0.31);
    assert.ok(platform.sent.some((m) => m.channel === 'capri:config' && m.payload.volume === 0.31));
    // a key: sealed on disk, never in what the overlay or the window are sent
    const saved = await core.ipc.handle['settings:key']({ provider: 'openai', key: 'sk-test-0123456789' }, sender);
    assert.equal(saved.ok, true);
    assert.match(core.config.load().apiKeys.openai, /^enc:/);
    assert.ok(!fs.readFileSync(core.config.file(), 'utf8').includes('sk-test-0123456789'));
    assert.ok(!JSON.stringify(platform.sent).includes('sk-test-0123456789'));
    const config = await core.ipc.handle['config:get']();
    assert.equal('apiKeys' in config, false);
    assert.deepEqual(config.keys, ['openai']);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the core\'s other commands go to the platform: links, screens, the power state, the summoned menu', async () => {
  const { core, platform, userData } = startCore();
  try {
    core.ipc.on['chat:ollama']();
    assert.deepEqual(platform.calls.find((c) => c.name === 'shell.openExternal').args, ['https://ollama.com']);
    assert.equal(await core.ipc.handle['web:search']('cyber pet'), true);
    assert.match(platform.calls.filter((c) => c.name === 'shell.openExternal').at(-1).args[0], /google\.com\/search\?q=cyber%20pet/);
    const screens = core.ipc.handle['screens:list']();
    assert.equal(screens.current, 1);
    assert.deepEqual(screens.list, [{ id: 1, x: 0, y: 0, w: 1280, h: 800 }]);
    platform.state.cursor = { x: 100, y: 50 };
    assert.deepEqual(core.ipc.handle['overlay:cursor'](), { x: 100, y: 50, inside: true, display: 1 });
    core.ipc.on['overlay:interactive'](true);
    core.ipc.on['overlay:interactive'](false);
    assert.deepEqual(platform.calls.filter((c) => c.name === 'overlay.clickThrough').map((c) => c.args[0]), [false, true]);
    core.ipc.on['menu:open']();
    assert.deepEqual(platform.calls.at(-1), { name: 'tray.popup', args: ['overlay'] });
    core.ipc.on['renderer:ready']();
    assert.ok(platform.sent.some((m) => m.channel === 'power:state'));
    // an unrelated page asking to open the settings window's "ready" does nothing
    core.ipc.on['settings:ready']({ sections: 4 }, { id: 'stranger' });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('in plain node that refuses electron: the core starts on the fake platform and answers', () => {
  const script = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (/^electron(-updater)?$/.test(request)) throw new Error('electron was asked for');
      return load.call(this, request, ...rest);
    };
    const fs = require('node:fs');
    const { createCore } = require(${JSON.stringify(path.join(MAIN, 'core'))});
    const { createFakePlatform } = require(${JSON.stringify(path.join(MAIN, 'platform', 'fake'))});
    const platform = createFakePlatform();
    const core = createCore({ platform, smoke: true, watchWindows: () => ({ stop() {}, refresh() {} }) });
    core.start();
    const cfg = core.ipc.handle['config:get']();
    console.log(JSON.stringify({ lang: cfg.lang, menu: core.menu.labels().length, electron: Object.keys(require.cache).some((k) => /node_modules[\\\\/]electron[\\\\/]/.test(k)) }));
    core.stop();
    fs.rmSync(platform.state.userData, { recursive: true, force: true });
  `;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: path.resolve(__dirname, '..') });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(out.electron, false);
  assert.ok(out.menu > 20);
  assert.match(out.lang, /^(en|fr|es|pt|ru)$/);
});
