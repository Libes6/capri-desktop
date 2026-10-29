'use strict';

// macOS updates without a Developer ID (docs/UPDATES.md). Squirrel.Mac, which electron-updater's
// MacUpdater hands the zip to, accepts an update only if its code signature satisfies the running
// app's designated requirement; an ad-hoc signature's requirement is its own cdhash, different in
// every build, so it would refuse every update. Instead, as Gustaf's updater does with its archive:
//
//   download the zip of latest-mac.yml → check its size and sha512 → unpack it next to the bundle
//   (ditto) → one .app inside, same bundle id, the version offered, a code signature →
//   quarantine removed → the running bundle renamed to a backup, the new one moved in its place
//   (put back if that fails) → relaunch. The backup is removed at the next start.
//
// A bundle that can't be replaced (run from the DMG, translocated by Gatekeeper, a folder it may not
// write) is said before anything is downloaded: move Capri to Applications, or download by hand.
// Everything that touches the system is passed in (fs, exec, download), so it is tested with fakes.

const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const STAGING = '.Capri-update-staging';
const BACKUP = '.Capri-previous.app';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim().slice(0, 200)}`), { code: err.code }));
      else resolve(String(stdout));
    });
  });
}

const locationError = (why) => Object.assign(new Error(`Capri cannot replace itself here (${why}): move Capri.app to Applications and start it from there`), { code: 'ERR_CAPRI_LOCATION', why });

// …/Capri.app/Contents/MacOS/Capri → …/Capri.app
function bundleOf(exePath) {
  const bundle = path.resolve(exePath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

// Why this bundle can't be replaced in place, or null.
function locationProblem(bundle, fs = nodeFs) {
  if (!bundle) return 'not an app bundle';
  if (bundle.includes('/AppTranslocation/')) return 'translocated';
  if (bundle.startsWith('/Volumes/')) return 'disk image or external volume';
  try {
    fs.accessSync(path.dirname(bundle), nodeFs.constants.W_OK);
    fs.accessSync(bundle, nodeFs.constants.W_OK);
  } catch {
    return 'folder not writable';
  }
  return null;
}

// the zip of latest-mac.yml for this Mac (arm64 builds name it so), as electron-updater's MacUpdater picks it
function pickZip(files, arch = process.arch) {
  const zips = (files || []).filter((f) => String(f.url?.pathname ?? f.url ?? '').toLowerCase().endsWith('.zip'));
  const isArm = (f) => String(f.url?.pathname ?? f.url ?? '').includes('arm64');
  return zips.find((f) => (arch === 'arm64') === isArm(f)) || (arch === 'arm64' ? null : zips[0]) || null;
}

// size and sha512 (base64, as in latest-mac.yml) of the downloaded file
async function verifyFile(file, info, fs = nodeFs) {
  if (!info?.sha512) throw Object.assign(new Error('Update has no sha512 checksum'), { code: 'ERR_CHECKSUM_MISMATCH' });
  const size = fs.statSync(file).size;
  if (info.size && size !== Number(info.size)) throw Object.assign(new Error(`size mismatch: expected ${info.size}, got ${size}`), { code: 'ERR_CHECKSUM_MISMATCH' });
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject));
  const base64 = hash.digest('base64');
  const expected = info.sha512.length === 128 && /^[\da-f]+$/i.test(info.sha512) ? Buffer.from(info.sha512, 'hex').toString('base64') : info.sha512;
  if (base64 !== expected) throw Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' });
}

const plistValue = async (exec, app, key) => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')])).trim();

/**
 * deps: exePath, tmpDir, download(url, dest, { sha512, onProgress }), relaunch(), arch, fs, exec
 */
function createMacInstaller({ exePath, tmpDir, download, relaunch, arch = process.arch, fs = nodeFs, exec = run }) {
  const bundle = bundleOf(exePath);
  let ready = null; // { version, zip, dir }

  function guard() {
    const why = locationProblem(bundle, fs);
    if (why) throw locationError(why);
  }

  function forget() {
    if (ready) fs.rmSync(ready.dir, { recursive: true, force: true });
    ready = null;
  }

  return {
    bundle,
    discard: forget,
    async download(files, version, progress = () => {}) {
      guard(); // before 100 MB come down for nothing
      const file = pickZip(files, arch);
      if (!file) throw Object.assign(new Error(`No macOS ${arch} zip in this update`), { code: 'ERR_CAPRI_NO_ZIP' });
      forget();
      const dir = fs.mkdtempSync(path.join(tmpDir, 'capri-update-'));
      const zip = path.join(dir, 'update.zip');
      try {
        await download(String(file.url?.href ?? file.url), zip, {
          sha512: file.info?.sha512,
          onProgress: (p) => progress(p?.transferred, p?.total || file.info?.size),
        });
        await verifyFile(zip, file.info, fs);
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      ready = { version, zip, dir };
    },

    // bridge (TAURI-13): the bundle is replaced by the Tauri build, whose executable has another name; relaunch({ bridge })
    async install(version, { bridge = false } = {}) {
      if (!ready || ready.version !== version) throw new Error('Update is not downloaded');
      guard();
      const parent = path.dirname(bundle);
      const staging = path.join(parent, STAGING);
      const backup = path.join(parent, BACKUP);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging);
      try {
        await exec('/usr/bin/ditto', ['-x', '-k', ready.zip, staging]);
        const apps = fs.readdirSync(staging).filter((name) => name.endsWith('.app'));
        if (apps.length !== 1) throw new Error(`Update bundle check failed: expected one app, found ${apps.length}`);
        const fresh = path.join(staging, apps[0]);
        // a folder of its own, not a symlink (ditto keeps those) leading anywhere else
        if (!fs.lstatSync(fresh).isDirectory()) throw new Error('Update bundle check failed: the app is not a folder');
        const [id, freshId, freshVersion] = await Promise.all([
          plistValue(exec, bundle, 'CFBundleIdentifier'),
          plistValue(exec, fresh, 'CFBundleIdentifier'),
          plistValue(exec, fresh, 'CFBundleShortVersionString'),
        ]);
        if (freshId !== id) throw new Error(`Update bundle id mismatch: ${freshId}`);
        if (freshVersion !== version) throw new Error(`Update bundle version mismatch: ${freshVersion} instead of ${version}`);
        // signed at all (Apple Silicon runs no unsigned code). Not `codesign --verify`: these builds
        // carry only the linker's ad-hoc signature of the executable, no sealed resources, so a
        // verify fails on every one of them; the bytes are vouched for by the sha512 above.
        await exec('/usr/bin/codesign', ['-d', fresh]).catch(() => { throw new Error('Update bundle check failed: the app is not signed'); });
        await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => {});
        fs.rmSync(backup, { recursive: true, force: true });
        fs.renameSync(bundle, backup);
        try {
          fs.renameSync(fresh, bundle);
        } catch (err) {
          fs.renameSync(backup, bundle); // the running one back in its place
          throw err;
        }
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
      forget();
      relaunch({ bridge });
    },
  };
}

/**
 * Starts the bundle at `bundle` once process `pid` (the app being replaced) has gone, through the system (`open`).
 * Electron's app.relaunch() execs the old executable's path inside the bundle; after a bridge update that bundle is the
 * Tauri build, with another executable (Contents/MacOS/capri), and on a case-sensitive volume the old name is not there.
 * `open` also starts it as a normal application (its own launch services identity, not a child of this process), which
 * means it does not inherit this process's environment: `env` ({ NAME: value }) is handed over with `open --env`, and is
 * only ever given for a local test build (updates.js).
 * The waiting is a detached shell with the pid, the variables and the path as arguments (never part of the script text);
 * it gives up after about 30 s and starts the app anyway.
 */
function relaunchBundle({ bundle, pid, env = {}, log = () => {}, spawnFn = spawn }) {
  if (!bundle) throw new Error('no bundle to start');
  const script = 'pid="$1"; shift; n=0; while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.3; n=$((n+1)); done; exec /usr/bin/open "$@"';
  const vars = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  const child = spawnFn('/bin/sh', ['-c', script, 'capri-relaunch', String(pid), ...vars, bundle], { detached: true, stdio: 'ignore' });
  child.unref?.();
  log(`relaunch: ${path.basename(bundle)} after pid ${pid}`);
  return child;
}

// At start: what an update left behind: the previous version and an unpacked staging next to the
// bundle, downloads never installed in the temporary folder.
function cleanup({ exePath, tmpDir = null, fs = nodeFs }) {
  const bundle = bundleOf(exePath);
  const leftovers = bundle ? [BACKUP, STAGING].map((name) => path.join(path.dirname(bundle), name)) : [];
  try {
    if (tmpDir) leftovers.push(...fs.readdirSync(tmpDir).filter((name) => /^capri-update-[\w-]{6}$/.test(name)).map((name) => path.join(tmpDir, name)));
  } catch {
    // no temporary folder to read
  }
  for (const file of leftovers) {
    if (file === bundle) continue; // never the running app, whatever it was named
    try {
      fs.rmSync(file, { recursive: true, force: true });
    } catch {
      // not ours to insist on: a read-only folder, say
    }
  }
}

module.exports = { createMacInstaller, cleanup, relaunchBundle, bundleOf, locationProblem, pickZip, verifyFile, STAGING, BACKUP };
