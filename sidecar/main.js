'use strict';

// The Capri sidecar (TAURI-04): the core of Capri (src/main/core.js) running in Node next to the Rust
// shell. It talks to Rust in JSON-RPC lines on stdin/stdout (rpc.js); everything it prints for people
// goes to stderr, stdout is the protocol's. The platform it runs on is src/main/platform/sidecar.js.
//
//   from Rust: request `invoke` { scope, name, args, sender: { label } } -> core.dispatch.handle(...)
//              notifications: screens, cursor, second-instance, quit, power
//   to Rust:   requests hello, overlay.create, overlay.setBounds; notifications emit, overlay.*, app.*
//
// Environment: CAPRI_ROOT (the project folder in dev; the bundle is self-contained otherwise),
// CAPRI_PORT (the hooks bridge), CAPRI_DEBUG (dev routes, debug.js).

const path = require('node:path');
const { createPeer } = require('./rpc');
const { createSidecarPlatform } = require('../src/main/platform/sidecar');
const { createDebugHandler } = require('./debug');

// stdout is the protocol's: whatever the core prints with console.log / info goes to stderr
console.log = console.info = console.debug = (...args) => console.error(...args);

function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

const log = (message) => process.stderr.write(`[sidecar] ${message}\n`);

async function main() {
  const root = process.env.CAPRI_ROOT || path.resolve(__dirname, '..');
  let platform = null;
  const peer = createPeer({
    write: (line) => process.stdout.write(line),
    log,
    onRequest: async (method, params) => {
      if (method === 'invoke') return invoke(params);
      throw new Error(`unknown method ${method}`);
    },
    onNotification: (method, params) => {
      platform?.onNotification(method, params);
      if (method === 'quit') setTimeout(() => process.exit(0), 200); // the core stopped in the quit handlers
    },
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => peer.feed(chunk));
  // Rust went away (closed pipe, or killed): there is nobody left to serve
  process.stdin.on('end', () => { log('stdin closed, exiting'); process.exit(0); });
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

  const hello = await peer.request('hello', {});
  // The window helpers (capri-windows on macOS, windows.ps1) are files of the app, not of this bundle:
  // packaged (a Node SEA executable, or the shell says so), they are looked for in the resources folder
  // (<resources>/bin/capri-windows, <resources>/windows.ps1). From a clone the sources' own folders do.
  // Set before the core is loaded: its modules read it when they are.
  if ((isSea() || hello.packaged) && hello.paths.resources) process.env.CAPRI_RESOURCES = hello.paths.resources;
  const { createCore } = require('../src/main/core');
  platform = createSidecarPlatform({ rpc: peer, hello, root, log });
  await platform.init(); // the key store's master key and the like: the synchronous methods answer from it
  // CAPRI_DEBUG=1: the dev routes of the bridge (debug.js); Rust honours its own debug requests on the same variable
  const dev = Boolean(process.env.CAPRI_DEBUG);
  // CAPRI_DEV=1: the core's dev switches too (CAPRI_SCREENS=2 cuts one display in two halves for testing)
  const core = createCore({ platform, port: Number(process.env.CAPRI_PORT) || undefined, dev: dev || process.env.CAPRI_DEV === '1' });

  // The one door in (src/main/dispatch.js): a refusal is a ProtocolError, never a crash. A command that
  // sends and expects nothing back just logs.
  const seen = { rendererReady: 0 }; // for the debug route `info` (the Tauri smoke test)
  function invoke({ scope, name, args = [], sender }) {
    if (name === 'rendererReady') seen.rendererReady = Date.now();
    const from = { label: sender?.label || scope };
    try {
      return Promise.resolve(core.dispatch.handle(name, args, from)).then((r) => (r === undefined ? null : r));
    } catch (err) {
      if (err.name !== 'ProtocolError') throw err;
      log(`${err.code}: ${err.message}`);
      const e = new Error(err.message);
      e.code = err.code;
      throw e;
    }
  }

  core.applyRender();
  // Rust holds the single-instance lock and tells of a second launch: she shows her status
  platform.app.singleInstance(() => core.command('status'));
  platform.app.onQuit(() => core.stop());
  platform.app.installAppMenu();
  core.start({ debug: dev ? createDebugHandler({ core, platform, seen }) : null });
  log(`core started (userData ${platform.paths.get('userData')})`);
  peer.notify('ready', { pid: process.pid });
}

main().catch((err) => {
  log(`fatal: ${err.stack || err}`);
  process.exit(1);
});
