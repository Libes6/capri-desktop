'use strict';

// Checks the minisign signatures of the release's update packages against the PUBLIC key (TAURI-12), as the app's
// updater will: the same file, the same key. A draft whose packages do not verify must not be published.
//
//   CAPRI_UPDATER_PUBLIC_KEY="$(cat capri.key.pub)" node scripts/verify-signatures.js <release folder>
//
// Formats: a Tauri public key and a `.sig` are each the base64 of a minisign file. The signature line is
// 2 bytes of algorithm ("Ed" signs the file, "ED" its BLAKE2b-512 hash), 8 of key id, 64 of Ed25519 signature;
// the trusted comment is covered by a second signature. Only the public key is read.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkPublicKey } = require('./updater-config');

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

function minisignFile(b64, what) {
  const lines = Buffer.from(String(b64).trim(), 'base64').toString('utf8').split('\n');
  if (!/^untrusted comment:/.test(lines[0] || '') || !lines[1]) throw new Error(`${what} is not a minisign file`);
  return { raw: Buffer.from(lines[1].trim(), 'base64'), trusted: /^trusted comment: (.*)$/.exec(lines[2] || '')?.[1], global: lines[3] && Buffer.from(lines[3].trim(), 'base64') };
}

function publicKey(text) {
  const { raw } = minisignFile(checkPublicKey(text), 'the public key');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('unsupported public key');
  return { id: raw.subarray(2, 10), key: crypto.createPublicKey({ key: Buffer.concat([SPKI, raw.subarray(10)]), format: 'der', type: 'spki' }) };
}

/** true or throws. */
function verify(bytes, signatureB64, pub) {
  const sig = minisignFile(signatureB64, 'the signature');
  if (sig.raw.length !== 74) throw new Error('unsupported signature');
  const alg = sig.raw.subarray(0, 2).toString();
  if (!['Ed', 'ED'].includes(alg)) throw new Error(`unknown signature algorithm ${alg}`);
  if (!sig.raw.subarray(2, 10).equals(pub.id)) throw new Error('signed with another key');
  const signature = sig.raw.subarray(10);
  const message = alg === 'ED' ? crypto.createHash('blake2b512').update(bytes).digest() : bytes;
  if (!crypto.verify(null, message, pub.key, signature)) throw new Error('the signature does not match the file');
  if (sig.trusted !== undefined && sig.global) {
    if (!crypto.verify(null, Buffer.concat([signature, Buffer.from(sig.trusted)]), pub.key, sig.global)) throw new Error('the trusted comment is not signed');
  }
  return true;
}

function verifyFolder(dir, publicKeyText) {
  const pub = publicKey(publicKeyText);
  const packages = fs.readdirSync(dir).filter((n) => !n.endsWith('.sig') && fs.existsSync(path.join(dir, `${n}.sig`)));
  if (!packages.length) throw new Error(`no .sig files in ${dir}`);
  for (const name of packages) {
    try {
      verify(fs.readFileSync(path.join(dir, name)), fs.readFileSync(path.join(dir, `${name}.sig`), 'utf8'), pub);
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
  }
  return packages;
}

if (require.main === module) {
  try {
    const dir = process.argv[2];
    if (!dir) throw new Error('usage: verify-signatures.js <release folder>');
    const ok = verifyFolder(path.resolve(dir), process.env.CAPRI_UPDATER_PUBLIC_KEY);
    console.log(`signatures verified: ${ok.join(', ')}`);
  } catch (err) {
    console.error(`verify-signatures: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { verify, verifyFolder, publicKey };
