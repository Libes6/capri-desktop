'use strict';

// The Electron shell of Capri: the platform that holds Electron's hands (platform/electron.js), the
// core that holds everything else (core.js), and between them what only Electron's life cycle needs:
// the single instance, the app starting up and quitting, the IPC channels handed to the core's
// handlers, and the two developer tools that drive Electron's windows directly (--dev routes in
// shell/debug.js, --smoke-test in shell/smoke.js). TAURI-01: nothing else imports Electron.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createElectronPlatform } = require('./platform/electron');
const { createCore } = require('./core');
const { createDebugHandler } = require('./shell/debug');
const { createSmoke } = require('./shell/smoke');

const ROOT = path.resolve(__dirname, '..', '..');
const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke-test');

const platform = createElectronPlatform({ root: ROOT, dev: DEV, smoke: SMOKE });
if (SMOKE) platform.paths.setUserData(process.env.CAPRI_SMOKE_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'capri-smoke-')));
const notify = {}; // the pages saying they are up, for the smoke test
const core = createCore({ platform, dev: DEV, smoke: SMOKE, notify });
if (SMOKE) {
  core.config.save({ welcomed: true, claude: false, muted: true, motion: 'reduced', render: process.platform === 'linux' ? 'software' : 'auto' });
  setTimeout(() => { console.error('[capri] smoke test timed out'); platform.app.exit(1); }, 30000).unref();
  Object.assign(notify, createSmoke({ core, platform }).notify);
}

// every channel of her pages goes through the core's dispatcher (dispatch.js): the window it comes from,
// its arguments against the protocol (src/protocol.js), then the core's handler of that name. A refused
// call is logged; the caller of an `invoke` gets the error, a plain `send` just gets nothing.
function registerIpc() {
  const refused = (err) => {
    if (err?.name !== 'ProtocolError') throw err;
    console.warn(`[capri] refused: ${err.message}`);
    return err;
  };
  for (const c of core.dispatch.commands) {
    if (c.kind === 'send') {
      platform.ipc.on(c.channel, (arg, sender) => {
        try {
          core.dispatch.handleChannel(c.channel, arg, sender);
        } catch (err) {
          refused(err);
        }
      });
    } else {
      platform.ipc.handle(c.channel, (arg, sender) => {
        try {
          return core.dispatch.handleChannel(c.channel, arg, sender);
        } catch (err) {
          throw refused(err);
        }
      });
    }
  }
}

function main() {
  core.applyRender();
  if (!platform.app.singleInstance(() => core.command('status'))) {
    platform.app.quit();
    return;
  }
  platform.app.setAppId('capri.desktop');

  platform.app.whenReady().then(() => {
    platform.app.hideFromDock();
    platform.app.installAppMenu();
    platform.app.serveAssets({ userSoundsDir: core.userSoundsDir });
    registerIpc();
    core.start({ debug: DEV ? createDebugHandler({ core, platform, root: ROOT, dev: DEV }) : null });
  });

  platform.app.onQuit(() => core.stop());
  platform.app.stayAlive();
}

main();
