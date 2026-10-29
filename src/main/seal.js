'use strict';

// API keys sealed in config.json as "kc:<base64>" (setup.js createKeys tells them from other kinds): AES-256-GCM under the master key that lives in the system key store
// (src-tauri/src/secrets.rs). The blob is: version byte 1 | 12-byte nonce | ciphertext | 16-byte tag.
// Used by the Tauri sidecar platform (opens and seals).

const crypto = require('node:crypto');

const SEAL_VERSION = 1;

function sealWith(masterKey, text) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, nonce);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, body, cipher.getAuthTag()]);
}

function openWith(masterKey, blob) {
  if (blob.length < 1 + 12 + 16 || blob[0] !== SEAL_VERSION) throw new Error('secrets: not a sealed key');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, blob.subarray(1, 13));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(13, blob.length - 16)), decipher.final()]).toString('utf8');
}

module.exports = { SEAL_VERSION, sealWith, openWith };
