'use strict';

// The Capri sidecar (TAURI-04): the core of Capri (src/main/core.js) running in Node next to the Rust
// shell. It talks to Rust in JSON-RPC lines on stdin/stdout (rpc.js); everything it prints for people
// goes to stderr, stdout is the protocol's. The core is the same one the Electron build runs; only
// the platform differs (src/main/platform/sidecar.js).
//
//   from Rust: request `invoke` { scope, name, args, sender: { label } } -> core.dispatch.handle(...)
//              notifications: screens, cursor, second-instance, quit, power
//   to Rust:   requests hello, overlay.create, overlay.setBounds; notifications emit, overlay.*, app.*
//
// Environment: CAPRI_ROOT (the project folder in dev; the bundle is self-contained otherwise),
// CAPRI_PORT (the hooks bridge).

const path = require('node:path');
const { createPeer } = require('./rpc');
const { createSidecarPlatform } = require('../src/main/platform/sidecar');
const { createCore } = require('../src/main/core');

// stdout is the protocol's: whatever the core prints with console.log / info goes to stderr
console.log = console.info = console.debug = (...args) => console.error(...args);

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
  platform = createSidecarPlatform({ rpc: peer, hello, root, log });
  const core = createCore({ platform, port: Number(process.env.CAPRI_PORT) || undefined, dev: process.env.CAPRI_DEV === '1' });

  // The one door in (src/main/dispatch.js): a refusal is a ProtocolError, never a crash. A command that
  // sends and expects nothing back just logs.
  function invoke({ scope, name, args = [], sender }) {
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
  platform.app.onQuit(() => core.stop());
  core.start({ debug: null });
  log(`core started (userData ${platform.paths.get('userData')})`);
  peer.notify('ready', { pid: process.pid });
}

main().catch((err) => {
  log(`fatal: ${err.stack || err}`);
  process.exit(1);
});
