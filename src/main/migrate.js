'use strict';

// TAURI-09, the Tauri half: on its first start the Tauri build takes over what the Electron build
// kept for the user. It runs in the sidecar (plain Node) after the platform is up and before the core
// is made, and it NEVER touches the Electron profile except to read it (and to remove the one file
// of its own, tauri-keys.json, once the keys in it are safe). docs/TAURI_MIGRATION_DATA.md has the map.
//
//   Electron's userData   macOS ~/Library/Application Support/Capri
//                         Windows %APPDATA%\Capri        Linux ~/.config/Capri
//   Tauri's (identifier)  macOS ~/Library/Application Support/capri.desktop
//                         Windows %APPDATA%\capri.desktop    Linux ~/.local/share/capri.desktop
//
// What it copies: config.json (normalised), memory.json, sounds/. Each by a temporary file and a
// rename, so a crash leaves a whole file or none; one that already exists in the new profile is NEVER
// overwritten (the user's newer data win), except a config the Tauri build wrote itself and nobody
// changed (all defaults), which is kept beside it as config.json.pre-migration. A broken or missing file
// is skipped and noted, not fatal. The marker `migrated-from-electron.json` says what happened; with
// it present the import is not run again (only the keys, if they are still on their way).
//
// API keys: `enc:` values of Electron cannot be opened here. The last Electron build left them sealed in
// the Tauri format in tauri-keys.json (migrate-prepare.js); they are verified with the key store's master
// key and put in the new config as they are (`kc:`). No file but that one ever holds a key, and it is
// removed afterwards. A key that cannot be carried over is left out and `keysLost` says so: she tells the
// user to enter it again (core.js, lines.js).
//
// Also here: the login item (only when Electron's was on, by the platform's own method) and the hooks of
// the assistants (hooks-command.js migrateFile, only Capri's own entries, with a backup).

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('./config');
const { sha256, isEnc } = require('./migrate-prepare');
const hooksCommand = require('./hooks-command');

const MARKER = 'migrated-from-electron.json';
const KEYS_FILE = 'tauri-keys.json';
const SOUND_EXT = /\.(mp3|wav|ogg|m4a)$/i;
const MAX_CONFIG = 8 * 1024 * 1024;
const MAX_MEMORY = 64 * 1024 * 1024;
const MAX_SOUND = 64 * 1024 * 1024;
const APP_NAMES = ['Capri', 'capri-desktop']; // productName of the installed app, then package name (npm start)
const MARKER_VERSION = 1;

// Electron-only settings that mean nothing to the Tauri shell (or mean something else there)
const DROPPED = ['render']; // how Chromium draws her window (gl/software): no Chromium in the Tauri build
const RESET = { displayId: null }; // Electron's display ids are not the Tauri shell's (indices): back to the primary

// ---------- where the Electron profile is ----------

function electronProfiles({ platform = process.platform, env = process.env, home }) {
  if (env.CAPRI_ELECTRON_USER_DATA) return [path.resolve(env.CAPRI_ELECTRON_USER_DATA)];
  if (!home) return [];
  let base;
  if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return APP_NAMES.map((name) => path.join(base, name));
}

function looksLikeProfile(dir) {
  return ['config.json', 'memory.json', 'sounds', KEYS_FILE].some((n) => fs.existsSync(path.join(dir, n)));
}

const same = (a, b) => {
  const norm = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
};

function findProfile({ userData, platform, env, home }) {
  return electronProfiles({ platform, env, home }).find((dir) => !same(dir, userData) && looksLikeProfile(dir)) || null;
}

// ---------- small file helpers ----------

function readJson(file, max = MAX_CONFIG) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > max) return { error: st.isFile() ? 'too big' : 'not a file' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { value };
  } catch (err) {
    return err.code === 'ENOENT' ? { missing: true } : { error: err.message };
  }
}

// whole file or none: a temporary beside it, then a rename
function writeAtomic(fsx, file, data, mode) {
  const temp = `${file}.tmp-${process.pid}`;
  try {
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    fsx.writeFileSync(temp, data, mode ? { mode } : undefined);
    fsx.renameSync(temp, file);
  } catch (err) {
    try {
      fsx.rmSync(temp, { force: true });
    } catch {
      // nothing more to clean up
    }
    throw err;
  }
}

function copyAtomic(fsx, from, to) {
  const temp = `${to}.tmp-${process.pid}`;
  try {
    fsx.mkdirSync(path.dirname(to), { recursive: true });
    fsx.copyFileSync(from, temp);
    fsx.renameSync(temp, to);
  } catch (err) {
    try {
      fsx.rmSync(temp, { force: true });
    } catch {
      // nothing more to clean up
    }
    throw err;
  }
}

// ---------- config ----------

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A config the Tauri build wrote itself at a first start and nobody touched: nothing but defaults.
function isPristine(cfg) {
  if (!isObject(cfg)) return true;
  return Object.entries(cfg).every(([k, v]) => k === 'assistant' || deepEqual(v, DEFAULTS[k]));
}

/**
 * Electron's config as the Tauri build wants it. `apiKeys` is handled apart (keys.js-like rules below):
 *   enc:  -> left out here (applyKeys puts the sealed one back, or it is lost)
 *   kc:   -> kept if it opens with this platform's master key, else lost
 *   plain -> sealed (kc:) when the key store works, else kept as it is (what the core does without a store)
 */
function normalizeConfig(source, platform) {
  const cfg = isObject(source) ? { ...source } : {};
  for (const k of DROPPED) delete cfg[k];
  Object.assign(cfg, RESET);
  const keysWanted = []; // providers that had a key in Electron
  const keysKept = {};
  const lost = [];
  const store = platform.secrets;
  for (const [id, value] of Object.entries(isObject(cfg.apiKeys) ? cfg.apiKeys : {})) {
    if (typeof value !== 'string' || !value) continue;
    keysWanted.push(id);
    if (isEnc(value)) continue; // applyKeys
    if (value.startsWith('kc:')) {
      try {
        store.decrypt(Buffer.from(value.slice(3), 'base64'));
        keysKept[id] = value;
      } catch {
        lost.push(id);
      }
    } else if (store.isAvailable()) {
      keysKept[id] = `kc:${store.encrypt(value).toString('base64')}`;
    } else {
      keysKept[id] = value;
    }
  }
  cfg.apiKeys = keysKept;
  return { config: cfg, keysWanted, lost };
}

// ---------- keys ----------

/**
 * Puts the keys Electron left sealed (tauri-keys.json) into the new config, for providers that have none
 * there yet. Returns { moved, lost, pending, manifest } and removes the manifest when it has been used up.
 */
function applyKeys({ platform, userData, sourceDir, fsx = fs, log }) {
  const out = { moved: [], lost: [], pending: false, manifest: null };
  const manifestFile = path.join(sourceDir, KEYS_FILE);
  const man = readJson(manifestFile);
  const manifest = man.value && isObject(man.value) ? man.value : null;
  out.manifest = manifest;
  const src = readJson(path.join(sourceDir, 'config.json'));
  const dst = readJson(path.join(userData, 'config.json'));
  const wanted = Object.entries(isObject(src.value?.apiKeys) ? src.value.apiKeys : {}).filter(([, v]) => isEnc(v));
  if (!dst.value || !isObject(dst.value)) {
    out.lost = wanted.map(([id]) => id);
    return out;
  }
  const have = isObject(dst.value.apiKeys) ? dst.value.apiKeys : {};
  const todo = wanted.filter(([id]) => !have[id]); // a key the user entered since is never replaced
  const sealed = isObject(manifest?.keys) ? manifest.keys : {};
  const mine = (id, value) => {
    const entry = sealed[id];
    if (typeof entry !== 'string' || !entry.startsWith('kc:')) return false;
    if (manifest.sources?.[id] !== sha256(value)) return false; // sealed from an older value of that key
    try {
      return platform.secrets.decrypt(Buffer.from(entry.slice(3), 'base64')) !== '' && entry;
    } catch {
      return false;
    }
  };
  const storeUp = platform.secrets.isAvailable();
  const next = { ...have };
  for (const [id, value] of todo) {
    const entry = storeUp && mine(id, value);
    if (entry) {
      next[id] = entry;
      out.moved.push(id);
    } else {
      out.lost.push(id);
    }
  }
  // the key store is down right now and there are sealed keys waiting: not lost yet, try at the next start
  if (!storeUp && manifest && Object.keys(sealed).length && todo.some(([id]) => sealed[id])) out.pending = true;
  if (out.moved.length) writeAtomic(fsx, path.join(userData, 'config.json'), JSON.stringify({ ...dst.value, apiKeys: next }, null, 2), 0o600);
  return out;
}

// the sealed values were used (or can never be): the file goes. Only ever Capri's own file, never a profile's.
function removeManifest({ sourceDir, fsx = fs, log }) {
  try {
    fsx.rmSync(path.join(sourceDir, KEYS_FILE), { force: true });
  } catch (err) {
    log?.(`migration: could not remove ${KEYS_FILE}: ${err.message}`);
  }
}

// ---------- the import ----------

function importFiles({ fsx, platform, userData, sourceDir, log }) {
  const report = [];
  const errors = [];
  const note = (name, action, reason) => report.push(reason ? { name, action, reason } : { name, action });
  let keysWanted = [];
  let keysLostHere = [];

  // config.json
  try {
    const target = path.join(userData, 'config.json');
    const src = readJson(path.join(sourceDir, 'config.json'));
    if (src.missing) note('config.json', 'absent');
    else if (src.error || !isObject(src.value)) note('config.json', 'skipped', `unreadable: ${src.error || 'not an object'}`);
    else {
      const existing = readJson(target);
      const present = !existing.missing;
      const overwritable = !present || Boolean(existing.error) || isPristine(existing.value); // a broken one is kept aside too
      if (present && !overwritable) {
        note('config.json', 'kept', 'the new profile has its own');
      } else {
        const { config, keysWanted: wanted, lost } = normalizeConfig(src.value, platform);
        keysWanted = wanted;
        keysLostHere = lost;
        if (present) copyAtomic(fsx, target, `${target}.pre-migration`);
        writeAtomic(fsx, target, JSON.stringify(config, null, 2), 0o600);
        note('config.json', 'copied');
      }
    }
  } catch (err) {
    errors.push(`config.json: ${err.message}`);
    note('config.json', 'failed', err.message);
  }

  // memory.json (her chat history; Claude Code's session)
  try {
    const from = path.join(sourceDir, 'memory.json');
    const to = path.join(userData, 'memory.json');
    const src = readJson(from, MAX_MEMORY);
    if (src.missing) note('memory.json', 'absent');
    else if (src.error || !isObject(src.value)) note('memory.json', 'skipped', `unreadable: ${src.error || 'not an object'}`);
    else if (fsx.existsSync(to)) note('memory.json', 'kept', 'the new profile has its own');
    else {
      copyAtomic(fsx, from, to);
      note('memory.json', 'copied');
    }
  } catch (err) {
    errors.push(`memory.json: ${err.message}`);
    note('memory.json', 'failed', err.message);
  }

  // sounds/ (the user's own: .mp3 .wav .ogg .m4a, one level, regular files only)
  try {
    const dir = path.join(sourceDir, 'sounds');
    let names = [];
    try {
      names = fsx.readdirSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const counts = { copied: 0, kept: 0, skipped: 0, failed: 0 };
    for (const name of names) {
      if (name !== path.basename(name) || !SOUND_EXT.test(name)) { counts.skipped += 1; continue; }
      const from = path.join(dir, name);
      const to = path.join(userData, 'sounds', name);
      try {
        const st = fsx.lstatSync(from);
        if (!st.isFile() || st.size > MAX_SOUND) { counts.skipped += 1; continue; }
        if (fsx.existsSync(to)) { counts.kept += 1; continue; }
        copyAtomic(fsx, from, to);
        counts.copied += 1;
      } catch (err) {
        counts.failed += 1;
        errors.push(`sounds/${name}: ${err.message}`);
      }
    }
    if (names.length) note('sounds/', counts.failed ? 'partial' : 'copied', JSON.stringify(counts));
    else note('sounds/', 'absent');
  } catch (err) {
    errors.push(`sounds/: ${err.message}`);
    note('sounds/', 'failed', err.message);
  }
  return { report, errors, keysWanted, keysLostHere };
}

/**
 * The import on a start of the Tauri build. Never throws.
 * @returns {{ status: 'disabled'|'none'|'already'|'imported'|'partial'|'error', source?, report?, keys, errors?, autostart?: boolean|null, manifestAutostart? }}
 *   keys: { moved, lost, pending }
 */
function runMigration({ platform, env = process.env, log = () => {}, appVersion = null, now = () => new Date(), fsx = fs, platformName = process.platform }) {
  const empty = { moved: [], lost: [], pending: false };
  try {
    if (env.CAPRI_NO_MIGRATE) return { status: 'disabled', keys: empty };
    // another profile on purpose (tests, a try-out): the real Electron one is not looked for unless it is named
    if (env.CAPRI_USER_DATA && !env.CAPRI_ELECTRON_USER_DATA) return { status: 'disabled', keys: empty };
    const userData = platform.paths.get('userData');
    const markerFile = path.join(userData, MARKER);
    const home = (() => {
      try {
        return platform.paths.get('home');
      } catch {
        return null;
      }
    })();

    // done before: only the keys can still be on their way
    if (fsx.existsSync(markerFile)) {
      const marker = readJson(markerFile).value || {};
      const sourceDir = marker.source;
      let keys = { moved: [], lost: marker.keys?.lost || [], pending: Boolean(marker.keys?.pending) };
      if (sourceDir && fsx.existsSync(path.join(sourceDir, KEYS_FILE))) {
        const k = applyKeys({ platform, userData, sourceDir, fsx, log });
        if (!k.pending) removeManifest({ sourceDir, fsx, log });
        keys = { moved: k.moved, lost: k.lost, pending: k.pending };
        if (k.moved.length || k.lost.length !== (marker.keys?.lost || []).length || k.pending !== Boolean(marker.keys?.pending)) {
          writeAtomic(fsx, markerFile, JSON.stringify({ ...marker, keys: { moved: [...new Set([...(marker.keys?.moved || []), ...k.moved])], lost: k.lost, pending: k.pending } }, null, 2));
        }
      }
      return { status: 'already', source: sourceDir || null, keys, notices: marker.notices || 0 };
    }

    const sourceDir = findProfile({ userData, platform: platformName, env, home });
    if (!sourceDir) return { status: 'none', keys: empty };

    const imported = importFiles({ fsx, platform, userData, sourceDir, log });
    const k = applyKeys({ platform, userData, sourceDir, fsx, log });
    // Electron's login item was on? (the manifest says; the config has no such setting)
    const autostart = k.manifest && typeof k.manifest.autostart === 'boolean' ? k.manifest.autostart : null;
    // a provider whose key is neither in the new config nor on its way is lost
    const lost = [...new Set([...imported.keysLostHere, ...k.lost])];
    const keys = { moved: k.moved, lost, pending: k.pending };

    if (imported.errors.length) {
      log(`migration: partial (${imported.errors.length} errors); will go on at the next start`);
      return { status: 'partial', source: sourceDir, report: imported.report, keys, errors: imported.errors, autostart };
    }
    const marker = {
      version: MARKER_VERSION,
      at: now().toISOString(),
      app: appVersion,
      source: sourceDir,
      copied: imported.report,
      keys: { moved: k.moved, lost, pending: k.pending },
      autostart: null, // filled by finishStart
      hooks: null,
      notices: 0,
    };
    writeAtomic(fsx, markerFile, JSON.stringify(marker, null, 2));
    if (!k.pending) removeManifest({ sourceDir, fsx, log }); // after the marker: a crash before it leaves the file for the retry
    return { status: 'imported', source: sourceDir, report: imported.report, keys, autostart };
  } catch (err) {
    log(`migration: ${err.message}`);
    return { status: 'error', keys: empty, errors: [err.message] };
  }
}

function updateMarker(userData, patch, fsx = fs) {
  const file = path.join(userData, MARKER);
  const current = readJson(file).value;
  if (!current) return;
  writeAtomic(fsx, file, JSON.stringify({ ...current, ...patch }, null, 2));
}

// ---------- the login item and the hooks ----------

/**
 * The login item: only when the import found Electron's on (`wanted === true`, from the manifest the
 * last Electron build wrote), by the platform's method, and only on systems that have one. Electron's
 * own entry is not Tauri's to remove (macOS: SMAppService under the same bundle id; Windows: the same Run
 * value name, which this overwrites): the Electron build removes it itself when it hands over
 * (prepareTauriMigration({ releaseAutostart })). Returns what was done, for the marker.
 */
function migrateAutostart({ platform, wanted, platformName = process.platform, log = () => {} }) {
  if (wanted !== true) return wanted === false ? 'was-off' : 'unknown';
  if (platformName !== 'darwin' && platformName !== 'win32') return 'unsupported';
  try {
    if (platform.autostart.isEnabled()) return 'already-on';
    platform.autostart.set(true);
    return 'enabled';
  } catch (err) {
    log(`migration: autostart: ${err.message}`);
    return 'failed';
  }
}

/** Capri's old hook entries (Electron/Node commands) become `capri-hook` commands; nothing if the binary is not there. */
function migrateHookEntries({ platform, env = process.env, log = () => {} }) {
  try {
    const resources = (() => {
      try {
        return platform.paths.get('resources');
      } catch {
        return null;
      }
    })();
    const bin = hooksCommand.findHookBin({ env, resourcesPath: undefined, dirs: [resources && path.join(resources, 'bin'), resources] });
    if (!bin) return { bin: null, migrated: {} };
    const { migrateHooks } = require('./assistants');
    const result = migrateHooks(bin);
    return { bin, migrated: Object.fromEntries(Object.entries(result).map(([id, r]) => [id, r.migrated])) };
  } catch (err) {
    log(`migration: hooks: ${err.message}`);
    return { bin: null, migrated: {}, error: err.message };
  }
}

/**
 * Everything the sidecar does at start: the import, the login item and the hooks (once the import has
 * been done), and what the core needs to tell the user (`notice`). Never throws.
 */
function startMigration({ platform, env = process.env, log = () => {}, appVersion = null, platformName = process.platform, fsx = fs }) {
  const result = runMigration({ platform, env, log, appVersion, platformName, fsx });
  const userData = platform.paths.get('userData');
  if (result.status === 'imported') {
    const autostart = migrateAutostart({ platform, wanted: result.autostart, platformName, log });
    result.autostartResult = autostart;
    log(`migration: imported from ${result.source} (${result.report.map((r) => `${r.name} ${r.action}`).join(', ')}); keys moved ${result.keys.moved.length}, lost ${result.keys.lost.length}; login item ${autostart}`);
    try {
      updateMarker(userData, { autostart }, fsx);
    } catch (err) {
      log(`migration: marker: ${err.message}`);
    }
  } else if (result.status !== 'none' && result.status !== 'disabled') {
    log(`migration: ${result.status}${result.errors ? ` (${result.errors.join('; ')})` : ''}`);
  }
  if (!env.CAPRI_NO_MIGRATE && (result.status === 'imported' || result.status === 'already')) {
    const hooks = migrateHookEntries({ platform, env, log });
    result.hooks = hooks;
    if (result.status === 'imported') {
      try {
        updateMarker(userData, { hooks: { bin: hooks.bin, migrated: hooks.migrated } }, fsx);
      } catch (err) {
        log(`migration: marker: ${err.message}`);
      }
    }
  }
  return result;
}

/** The core said it once more: at most three launches (keeps count in the marker). */
function noticeDue(userData) {
  const marker = readJson(path.join(userData, MARKER)).value;
  return Boolean(marker) && (marker.notices || 0) < 3;
}
function noticeShown(userData, fsx = fs) {
  const marker = readJson(path.join(userData, MARKER)).value;
  if (marker) updateMarker(userData, { notices: (marker.notices || 0) + 1 }, fsx);
}

module.exports = {
  MARKER, KEYS_FILE, electronProfiles, findProfile, normalizeConfig, isPristine, applyKeys, runMigration, startMigration,
  migrateAutostart, migrateHookEntries, noticeDue, noticeShown,
};
