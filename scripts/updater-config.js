'use strict';

// The updater part of the Tauri build's configuration (TAURI-10, docs/TAURI_UPDATES.md). The committed
// tauri.conf.json has no `plugins.updater`: a build made without it is disabled (updater.rs
// `configured`). A release build adds this on the command line, with the PUBLIC key the maintainers
// generated (repository variable CAPRI_UPDATER_PUBLIC_KEY):
//
//   CAPRI_UPDATER_PUBLIC_KEY="$(cat capri.key.pub)" node scripts/updater-config.js > updater.conf.json
//   cargo tauri build --config src-tauri/tauri.bundle.conf.json --config updater.conf.json
//
// The endpoint is this repository's latest published release, fixed here (not a variable). The private
// key is never read here: it signs at bundling time (TAURI_SIGNING_PRIVATE_KEY, a secret of the CI job).

const ENDPOINT = 'https://github.com/Libes6/capri-desktop/releases/latest/download/latest.json';

// a Tauri public key is the base64 of a minisign public key file
function checkPublicKey(key) {
  const text = String(key ?? '').trim();
  if (!text) throw new Error('CAPRI_UPDATER_PUBLIC_KEY is empty: this build would have updates off');
  let decoded = '';
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) decoded = Buffer.from(text, 'base64').toString('utf8');
  if (!/^untrusted comment: minisign public key/.test(decoded)) {
    throw new Error('CAPRI_UPDATER_PUBLIC_KEY is not a Tauri public key (the content of the .pub file made by `tauri signer generate`)');
  }
  return text;
}

/**
 * → the configuration to merge. `local` (scripts/updater-smoke-tauri.js only) is { port }: a loopback feed over
 * plain http, which updater.rs accepts only in a binary compiled with CAPRI_LOCAL_UPDATER_TEST=1.
 */
function updaterConfig({ publicKey, local = null, version = null } = {}) {
  const pubkey = checkPublicKey(publicKey);
  const updater = local
    ? { pubkey, endpoints: [`http://127.0.0.1:${Number(local.port)}/latest.json`], dangerousInsecureTransportProtocol: true }
    : { pubkey, endpoints: [ENDPOINT], windows: { installMode: 'passive' } };
  return { ...(version && { version }), bundle: { createUpdaterArtifacts: true }, plugins: { updater } };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(updaterConfig({ publicKey: process.env.CAPRI_UPDATER_PUBLIC_KEY }), null, 2)}\n`);
  } catch (err) {
    console.error(`updater-config: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { updaterConfig, checkPublicKey, ENDPOINT };
