'use strict';

// TAURI-09, the Electron half: the last Electron build gets the user's API keys ready for the Tauri
// build, which cannot open Electron's `enc:` values itself (safeStorage is Chromium's os_crypt: the
// key lives in a "Capri Safe Storage" Keychain item on macOS, in DPAPI + Local State on Windows, in
// libsecret/kwallet on Linux; no other process opens that without a system prompt or at all).
//
// So Electron, which CAN open its own keys, seals each one again in the Tauri format
// (`kc:<base64>`, src/main/seal.js) under the master key of the Tauri build's key store
// (service `capri.desktop`, account `master-key`, keychain-cli.js), and writes only those sealed
// values to `tauri-keys.json` beside its config. No plain key is ever written anywhere: not in the
// file, not in a log, not in an argument (the master key goes to the store on stdin where the system
// tool takes it so). The Tauri build picks the file up on its first start (migrate.js) and removes it.
//
// Electron's own data are never changed: this adds one file and, on first use, one key store item.
// When the store is not there, or any step fails, nothing is written for the keys and the Tauri
// build asks for them again (honestly, in her words).
//
//   tauri-keys.json  { version: 1, at, service, keys: { openai: "kc:..." }, sources: { openai: sha256 of
//                      the enc: value it came from }, autostart: bool|null, keysSkipped?: reason }
//
// `autostart` is the state of Electron's login item (the Tauri build sets its own, and only if it was on).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sealWith } = require('./seal');

const FILE = 'tauri-keys.json';
const VERSION = 1;
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function isEnc(value) {
  return typeof value === 'string' && value.startsWith('enc:') && value.length > 4;
}

function atomicWrite(file, text) {
  const temp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function readManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

// The master key of the store: the one that is there (a Tauri build may have made it already, and keys
// sealed with it must stay readable), else a new random 256-bit one, kept and read back.
async function masterKeyFrom(store) {
  const have = await store.get();
  if (have) {
    if (Buffer.from(have.trim(), 'base64').length !== 32) throw new Error('the item in the key store is not a 256-bit key');
    return have.trim();
  }
  const fresh = crypto.randomBytes(32).toString('base64');
  await store.set(fresh);
  const back = await store.get();
  if ((back || '').trim() !== fresh) throw new Error('the key store did not keep the master key');
  return fresh;
}

/**
 * @param {object} o
 * @param {string} o.userData        Electron's userData (the manifest goes beside config.json)
 * @param {object} o.apiKeys         config.apiKeys as stored ("enc:..." values)
 * @param {(buf: Buffer) => string} o.decrypt  safeStorage.decryptString
 * @param {boolean} o.canDecrypt     safeStorage.isEncryptionAvailable()
 * @param {object|null} o.store      keychain-cli.js store (null: no tool on this system)
 * @param {boolean|null} [o.autostart]  Electron's login item (null: unknown)
 * @param {(on: boolean) => void} [o.setAutostart]  with releaseAutostart: takes Electron's login item off
 * @param {boolean} [o.releaseAutostart]  the app is about to be replaced (TAURI-13): remove Electron's login item,
 *                                        once the state is safe in the manifest
 */
async function prepareTauriMigration({
  userData, apiKeys = {}, decrypt, canDecrypt = true, store, autostart = null, setAutostart, releaseAutostart = false,
  now = () => new Date(),
}) {
  const file = path.join(userData, FILE);
  const encs = Object.entries(apiKeys || {}).filter(([, v]) => isEnc(v));
  const sources = Object.fromEntries(encs.map(([id, v]) => [id, sha256(v)]));
  const previous = readManifest(file);
  const result = { ok: true, wrote: false, keys: [], skipped: null, failed: [] };

  let keys = {};
  if (encs.length) {
    const same = previous && previous.version === VERSION && !previous.keysSkipped
      && JSON.stringify(previous.sources || {}) === JSON.stringify(sources)
      && Object.keys(previous.keys || {}).length === encs.length;
    if (same) {
      keys = previous.keys; // done before and nothing changed: no key store traffic at all
      result.keys = Object.keys(keys);
    } else if (!canDecrypt) {
      result.skipped = 'Electron cannot decrypt its keys right now (safeStorage unavailable)';
    } else if (!store) {
      result.skipped = 'no key store tool on this system';
    } else {
      const opened = {};
      for (const [id, value] of encs) {
        try {
          const text = decrypt(Buffer.from(value.slice(4), 'base64'));
          if (text) opened[id] = text;
          else result.failed.push(id);
        } catch {
          result.failed.push(id);
        }
      }
      if (Object.keys(opened).length) {
        try {
          const master = Buffer.from(await masterKeyFrom(store), 'base64');
          for (const [id, text] of Object.entries(opened)) {
            keys[id] = `kc:${sealWith(master, text).toString('base64')}`;
          }
          result.keys = Object.keys(keys);
          master.fill(0);
        } catch (err) {
          keys = {};
          result.skipped = `key store: ${err.message}`;
        }
      }
    }
  }

  const wantAutostart = typeof autostart === 'boolean' ? autostart : null;
  const empty = !Object.keys(keys).length && wantAutostart !== true;
  // a manifest left by an earlier run that said the login item was on, and it has been turned off since: rewritten, or
  // the Tauri build would turn on a login item the user no longer wants
  const staleAutostart = previous?.autostart === true && wantAutostart === false;
  if (empty && !result.skipped && !encs.length && !staleAutostart) {
    result.ok = true; // nothing to hand over
    return result;
  }

  const manifest = {
    version: VERSION,
    at: now().toISOString(),
    service: store?.service || null,
    keys,
    sources: Object.fromEntries(Object.keys(keys).map((id) => [id, sources[id]])),
    autostart: wantAutostart,
    ...(result.skipped ? { keysSkipped: result.skipped } : {}),
  };
  const unchanged = previous && JSON.stringify({ ...previous, at: 0 }) === JSON.stringify({ ...manifest, at: 0 });
  if (!unchanged) {
    try {
      fs.mkdirSync(userData, { recursive: true });
      atomicWrite(file, JSON.stringify(manifest, null, 2));
      result.wrote = true;
    } catch (err) {
      result.ok = false;
      result.skipped = `could not write ${FILE}: ${err.message}`;
      return result; // and Electron's login item stays: the hand-over did not happen
    }
  }
  if (releaseAutostart && wantAutostart === true && typeof setAutostart === 'function') {
    try {
      setAutostart(false);
      result.autostartReleased = true;
    } catch (err) {
      result.autostartReleased = false;
    }
  }
  if (result.skipped) result.ok = false;
  return result;
}

module.exports = { FILE, VERSION, prepareTauriMigration, sha256, isEnc };
