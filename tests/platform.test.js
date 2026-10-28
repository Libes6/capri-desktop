'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakePlatform } = require('../src/main/platform/fake');

function load(file, platform, extra = {}) {
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/main', file);
  const context = { module, exports: module.exports, process: { platform, env: {} },
    require(id) {
      if (id === 'node:path') return path.posix;
      if (id in extra) return extra[id];
      return require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: file manager uses native paths, launch errors propagate, executable files need confirmation`, async () => {
    const opened = [];
    const host = createFakePlatform({ overrides: {
      paths: { get: (key) => `/home/test/${key}` },
      shell: {
        openPath: async (file) => { opened.push(file); return ''; },
        openExternal: async (url) => { opened.push(url); },
      },
    } });
    const launch = load('launch.js', platform, { './apps': { powershell() { throw new Error('Windows helper invoked'); } } }).createLaunch({ platform: host });
    assert.equal((await launch.launchables()).length, 0);
    await launch.launch({ kind: 'known', id: 'explorer' });
    assert.equal(opened[0], '/home/test/home');
    await launch.launch({ kind: 'known', id: 'recycle' });
    assert.equal(opened[1], platform === 'darwin' ? '/home/test/home/.Trash' : 'trash:///');
    host.shell.openPath = async () => 'Permission denied';
    await assert.rejects(launch.launch({ kind: 'known', id: 'downloads' }), /Permission denied/);
    assert.equal(launch.risky({ kind: 'file', id: '/tmp/run.sh' }), true);
    assert.equal(launch.risky({ kind: 'folder', id: '/tmp/Test.app' }), true);
  });
  test(`${platform}: Ollama install never invokes winget`, async () => {
    const setup = load('setup.js', platform, { './ollama': {} });
    assert.equal((await setup.installOllama()).ok, false);
  });
}
