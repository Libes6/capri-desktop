'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { FEATURES, detect, linuxSession, createCapabilities } = require('../src/main/capabilities');
const { createFakePlatform } = require('../src/main/platform/fake');

const HELPER = '/app/src/main/windows.ps1';
const exists = (file) => file === HELPER;
const make = (platform, extra = {}) => createCapabilities({ platform, env: {}, helpers: { windowWatch: HELPER }, exists, ...extra });

test('Windows: everything implemented is on, with the window helper in place', () => {
  const caps = make('win32');
  for (const name of FEATURES) assert.equal(caps.has(name), true, name);
  assert.deepEqual(caps.forRenderer(), {
    windows: true, possess: true, closeApps: true, launchApps: true, mediaKeys: true, ollamaLaunch: true,
  });
});

test('Windows: no window tracking without its helper script', () => {
  const caps = make('win32', { exists: () => false });
  assert.equal(caps.has('windowTracking'), false);
  assert.equal(caps.forRenderer().possess, false);
  assert.equal(caps.has('mediaKeys'), true);
  // a check that throws counts as missing
  assert.equal(make('win32', { exists: () => { throw new Error('EACCES'); } }).has('windowTracking'), false);
});

test('macOS: only autostart of the system-dependent features', () => {
  const caps = make('darwin');
  const on = FEATURES.filter((name) => caps.has(name));
  assert.deepEqual(on, ['autostart']);
  assert.equal(Object.values(caps.forRenderer()).some(Boolean), false);
  assert.equal(caps.session, null);
});

test('Linux: nothing system-dependent yet, autostart included', () => {
  const caps = make('linux', { env: { DISPLAY: ':0' } });
  assert.equal(FEATURES.some((name) => caps.has(name)), false);
  assert.equal(caps.session, 'x11');
});

test('Linux session: X11, XWayland, native Wayland, none', () => {
  assert.equal(linuxSession({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }), 'x11');
  assert.equal(linuxSession({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'xwayland');
  assert.equal(linuxSession({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':1' }), 'xwayland');
  assert.equal(linuxSession({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland');
  assert.equal(linuxSession({}), null);
  assert.equal(detect({ platform: 'darwin', env: { DISPLAY: ':0' } }).session, null);
});

test('an adapter turns a feature on or off, listeners hear only real changes', () => {
  const caps = make('darwin');
  const heard = [];
  const off = caps.onChange((name, value) => heard.push([name, value]));
  caps.set('windowTracking', true); // e.g. a macOS watcher that started (CAPRI-09)
  caps.set('windowTracking', true);
  assert.equal(caps.has('windowTracking'), true);
  assert.equal(caps.forRenderer().windows, true);
  assert.equal(caps.forRenderer().possess, true);
  caps.set('windowTracking', false); // it gave up
  assert.equal(caps.forRenderer().possess, false);
  off();
  caps.set('windowTracking', true);
  assert.deepEqual(heard, [['windowTracking', true], ['windowTracking', false]]);
});

test('unknown features are refused, the renderer only gets booleans', () => {
  const caps = make('win32');
  assert.throws(() => caps.has('teleport'), /unknown capability/);
  assert.throws(() => caps.set('teleport', true), /unknown capability/);
  for (const value of Object.values(caps.forRenderer())) assert.equal(typeof value, 'boolean');
  assert.equal(caps.all().mediaKeys, true);
});

test('closing an app outside Windows never reports it closed nor runs PowerShell', async () => {
  for (const platform of ['darwin', 'linux']) {
    const apps = load('apps.js', platform, { 'node:child_process': { execFile() { throw new Error('PowerShell invoked'); } } });
    assert.equal((await apps.list()).length, 0);
    assert.equal(await apps.find('discord'), null);
    // (objects from the module's own context: compared by their fields)
    assert.equal(JSON.stringify(await apps.close('Discord')), JSON.stringify({ running: false, unsupported: true }));
  }
});

test('the window watcher reports when it runs and when it gives up', () => {
  const states = [];
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close');
    children.push(child);
    return child;
  };
  const overlay = {
    nativeHandle: () => Buffer.alloc(8), isAlive: () => true, bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  };
  const platform = createFakePlatform({ overrides: { screens: { toDip: (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }) } } });
  const windows = load('windows.js', 'win32', { 'node:child_process': { spawn } }, { setTimeout: (fn) => fn() });
  windows.startWindowWatch({ overlay, onUpdate() {}, onState: (ok) => states.push(ok), platform });
  children[0].emit('error', new Error('spawn powershell.exe ENOENT'));
  for (let i = 0; i < 4; i++) children[i].emit('close'); // three restarts, then it stops trying
  assert.equal(children.length, 4);
  assert.deepEqual(states, [false]);
});

function load(file, platform, extra = {}, globals = {}) {
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/main', file);
  const context = {
    module, exports: module.exports, __dirname: path.dirname(filename), process: { platform, env: {}, pid: 1 }, console, Buffer, ...globals,
    require(id) {
      if (id in extra) return extra[id];
      return require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}
