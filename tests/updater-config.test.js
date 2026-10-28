'use strict';
// TAURI-10: scripts/updater-config.js, the updater part of a build's configuration, and what the
// committed configuration must NOT hold (a key, an endpoint: they are put in at build time).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { updaterConfig, checkPublicKey, ENDPOINT } = require('../scripts/updater-config');

const KEY = Buffer.from('untrusted comment: minisign public key: ABCDEF0123456789\nRWSomePublicKeyText\n').toString('base64');

test('the release configuration: this repository\'s latest release feed, the public key, updater artifacts', () => {
  const c = updaterConfig({ publicKey: `${KEY}\n` });
  assert.deepEqual(c.plugins.updater.endpoints, ['https://github.com/Libes6/capri-desktop/releases/latest/download/latest.json']);
  assert.equal(ENDPOINT, c.plugins.updater.endpoints[0]);
  assert.equal(c.plugins.updater.pubkey, KEY);
  assert.equal(c.bundle.createUpdaterArtifacts, true);
  assert.ok(!('dangerousInsecureTransportProtocol' in c.plugins.updater), 'a release build never allows plain http');
});

test('no key, or something that is not a Tauri public key (a path, a private key, text): no configuration', () => {
  for (const bad of [undefined, '', '   ', '/home/me/capri.key.pub', 'RWSomePublicKeyText', Buffer.from('untrusted comment: rsign encrypted secret key\nRWRT').toString('base64'), 'not base64!']) {
    assert.throws(() => updaterConfig({ publicKey: bad }), /CAPRI_UPDATER_PUBLIC_KEY/, String(bad));
  }
  assert.equal(checkPublicKey(KEY), KEY);
});

test('only the local test (loopback port) gets plain http, and says so in the configuration', () => {
  const c = updaterConfig({ publicKey: KEY, local: { port: 47833 }, version: '0.1.1' });
  assert.deepEqual(c.plugins.updater.endpoints, ['http://127.0.0.1:47833/latest.json']);
  assert.equal(c.plugins.updater.dangerousInsecureTransportProtocol, true);
  assert.equal(c.version, '0.1.1');
});

test('the committed configuration has no updater, key or endpoint: a build without them is disabled', () => {
  const dir = path.join(__dirname, '..', 'src-tauri');
  for (const file of ['tauri.conf.json', 'tauri.bundle.conf.json']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const json = JSON.parse(text);
    assert.equal(json.plugins?.updater, undefined, file);
    assert.ok(!/pubkey|dangerousInsecure|createUpdaterArtifacts/.test(text), file);
  }
});

test('no private key text is in the repository\'s updater files', () => {
  for (const file of ['scripts/updater-config.js', 'scripts/updater-smoke-tauri.js', 'scripts/release-manifest.js', 'src-tauri/src/updater.rs']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY|untrusted comment: rsign encrypted secret key/.test(text), file);
  }
});
