'use strict';

// Updates of the installed app from the fork's GitHub Releases (CAPRI-11, docs/UPDATES.md).
//
// The controller below holds what her settings window and her menu show: disabled, idle, checking,
// current, available, downloading, downloaded, installing, error (network, signature, other). It
// never says "current" without a check that succeeded, runs one operation at a time, and installs
// only a download that was verified, after an explicit confirmation. What it checks with is a
// transport: electron-updater's autoUpdater for Windows (NSIS) and the AppImage, the same check
// without download for a .deb (her package manager updates her), and on macOS electron-updater's
// check with our own verified download and bundle swap (mac-update.js), since Squirrel.Mac refuses
// an update without a Developer ID signature. In the Tauri build (TAURI-10, docs/TAURI_UPDATES.md) the
// transport is tauri-plugin-updater, driven by Rust: signed latest.json feed, minisign-verified
// download, the plugin replaces the app (macOS .app.tar.gz, NSIS, AppImage). No Electron in the
// controller: it is tested with fakes.

const fs = require('node:fs');
const path = require('node:path');

const OWNER = 'Libes6';
const REPO = 'capri-desktop';
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases`;
const TAG_PREFIX = 'fork-v';
const STARTUP_DELAY = 45 * 1000;
// the local test feed (scripts/updater-smoke.js): only a build made by it, with this mark in its package.json
const TEST_FEED = /^http:\/\/127\.0\.0\.1:\d+\/?$/;

// the release page of a tag (fork-vX.Y.Z), or of a version
function releasePage(tag, version) {
  const name = tag || (version ? `${TAG_PREFIX}${version}` : null);
  return name ? `${RELEASES}/tag/${encodeURIComponent(name)}` : `${RELEASES}/latest`;
}

// Only pages of this repository's releases are opened from the app.
function isReleasePage(url) {
  return typeof url === 'string' && (url === `${RELEASES}/latest` || url.startsWith(`${RELEASES}/tag/`));
}

// Messages go to logs and to the window: no query strings (a signed download URL carries one), no
// feed XML or stack, and not too long.
function redact(text) {
  return String(text ?? '')
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1')
    .replace(/,?\s*XML:[\s\S]*$/, '')
    .replace(/\n\s+at [\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The error status of a failure: a verification failure blocks installation, a network failure is retried. */
function updateError(err, extra = {}) {
  const message = redact(err?.message ?? err);
  const code = String(err?.code ?? '');
  let category = 'other';
  let reason = null;
  if (code === 'ERR_CAPRI_SIGNATURE') {
    category = 'signature';
  } else if (code === 'ERR_CAPRI_NETWORK') {
    category = 'network';
  } else if (code === 'ERR_CHECKSUM_MISMATCH' || /sha512|sha256|checksum|signature|code ?sign|integrity|bundle (id|version|check)/i.test(message)) {
    category = 'signature';
  } else if (/net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|timed? ?out|offline|network|status code 5\d\d|\b50[234]\b/i.test(message)
    || /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)$/.test(code)) {
    category = 'network';
  } else if (code === 'ERR_CAPRI_LOCATION') {
    reason = 'location';
  } else if (['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'].includes(code)) {
    reason = 'feed'; // nothing published with update files yet (or a release without them)
  }
  // the Tauri shell says why itself (feed: nothing published for this system, location: cannot replace the app)
  if (!reason && ['feed', 'location'].includes(err?.reason)) reason = err.reason;
  return { kind: 'error', error: message, category, ...(reason && { reason }), ...extra };
}

// GitHub's release notes come as HTML (its releases feed): plain text for the window.
function plainNotes(notes) {
  if (Array.isArray(notes)) notes = notes.map((n) => [n.version, n.note].filter(Boolean).join('\n')).join('\n\n');
  if (typeof notes !== 'string') return '';
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return notes
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] !== '#') return entities[e.toLowerCase()] ?? all;
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/**
 * One update at a time, as Gustaf's UpdateController.
 * transport.check() → null (no newer version) | { version, notes, tag, download(progress)?, install()? }
 * mode: 'install' (download and install here) | 'notify' (a .deb: shown, installed elsewhere)
 */
class UpdateController {
  constructor({ transport = null, disabled = null, mode = 'install', current = '', onChange = () => {}, log = () => {} } = {}) {
    this.transport = disabled ? null : transport;
    this.mode = mode;
    this.current = current;
    this.onChange = onChange;
    this.log = log;
    this.update = null;
    this.busy = false;
    this.status = this.transport ? { kind: 'idle' } : { kind: 'disabled', reason: disabled || 'unconfigured' };
  }

  set(status) {
    this.status = status;
    if (status.kind !== 'downloading') this.log(status.kind === 'error' ? `error (${status.category}): ${status.error}` : `${status.kind}${status.version ? ` ${status.version}` : ''}`);
    this.onChange(this.view());
  }

  // what the window and the menu are given: plain data
  view() {
    const offer = this.update && { version: this.update.version, notes: this.update.notes || '', page: releasePage(this.update.tag, this.update.version) };
    return { ...(offer || {}), ...this.status, current: this.current, mode: this.mode, canDownload: Boolean(this.update?.download) && this.mode === 'install' };
  }

  async check() {
    if (!this.transport || this.busy) return this.view();
    this.busy = true;
    const previous = this.update;
    this.update = null;
    this.set({ kind: 'checking' });
    try {
      await previous?.close?.(); // a download of the previous check is let go (mac: its zip deleted)
      const update = await this.transport.check();
      if (update) {
        this.update = { ...update, notes: plainNotes(update.notes) };
        this.set({ kind: 'available', version: update.version });
      } else {
        this.set({ kind: 'current' });
      }
    } catch (err) {
      this.set(updateError(err));
    } finally {
      this.busy = false;
    }
    return this.view();
  }

  async download() {
    const update = this.update;
    if (this.busy || this.mode !== 'install' || !update?.download || this.status.kind !== 'available') return this.view();
    this.busy = true;
    const version = update.version;
    this.set({ kind: 'downloading', version, received: 0, total: 0 });
    try {
      await update.download((received, total) => this.set({ kind: 'downloading', version, received: Number(received) || 0, total: Number(total) || 0 }));
      this.set({ kind: 'downloaded', version });
    } catch (err) {
      this.set(updateError(err, { version }));
    } finally {
      this.busy = false;
    }
    return this.view();
  }

  // confirm(version) → true to restart now; declined, the download stays ready
  async install(confirm = async () => false) {
    const update = this.update;
    if (this.busy || !update?.install || this.status.kind !== 'downloaded') return this.view();
    this.busy = true;
    let yes = false;
    try {
      yes = await confirm(update.version);
    } catch {
      yes = false;
    }
    if (!yes || this.update !== update) {
      this.busy = false;
      return this.view();
    }
    this.set({ kind: 'installing', version: update.version });
    try {
      await update.install();
    } catch (err) {
      this.set(updateError(err, { version: update.version }));
      this.busy = false;
    }
    return this.view();
  }

  // the release page of what's offered (a .deb, a Mac that can't replace itself), or the latest
  page() {
    return this.update ? releasePage(this.update.tag, this.update.version) : releasePage();
  }
}

// --- Transports -------------------------------------------------------------------------------

// electron-updater's answer to a check: null when the updater is inactive (never "current")
async function checkWith(updater) {
  const result = await updater.checkForUpdates();
  if (!result) throw Object.assign(new Error('The updater is not active in this installation'), { code: 'ERR_CAPRI_INACTIVE' });
  if (!result.isUpdateAvailable) return null;
  const info = result.updateInfo || {};
  return { info, version: info.version, notes: info.releaseNotes, tag: info.tag || null };
}

// Windows NSIS and the AppImage: electron-updater downloads (sha512 from latest*.yml) and installs.
function updaterTransport(updater) {
  return {
    async check() {
      const found = await checkWith(updater);
      if (!found) return null;
      return {
        version: found.version,
        notes: found.notes,
        tag: found.tag,
        async download(progress) {
          const listener = (p) => progress(p?.transferred, p?.total);
          updater.on('download-progress', listener);
          try {
            await updater.downloadUpdate();
          } finally {
            updater.removeListener('download-progress', listener);
          }
        },
        async install() {
          // silent (the one-click installer), and Capri starts again afterwards. An installer it
          // can't start (no verified download, quitAndInstall already called) is only an 'error'
          // event, emitted synchronously, and nothing quits: said, not left "installing" forever.
          let failed = null;
          const onError = (err) => { failed = failed || err; };
          updater.on('error', onError);
          try {
            updater.quitAndInstall(true, true);
          } finally {
            updater.removeListener('error', onError);
          }
          if (failed) throw failed;
        },
      };
    },
  };
}

// A .deb (or another Linux package): the check only; the package manager installs.
function notifyTransport(updater) {
  return {
    async check() {
      const found = await checkWith(updater);
      return found && { version: found.version, notes: found.notes, tag: found.tag };
    },
  };
}

// macOS: electron-updater's check (it resolves the files of latest-mac.yml), then mac-update.js
// downloads the zip, verifies it and swaps the bundle.
function macTransport(updater, installer) {
  return {
    async check() {
      const found = await checkWith(updater);
      if (!found) return null;
      // electron-updater 6.6.x keeps the provider of the last check here; it gives absolute URLs
      const provider = updater.updateInfoAndProvider?.provider;
      const files = provider ? provider.resolveFiles(found.info) : [];
      return {
        version: found.version,
        notes: found.notes,
        tag: found.tag,
        download: (progress) => installer.download(files, found.version, progress),
        install: () => installer.install(found.version),
        close: () => installer.discard(),
      };
    },
  };
}

// Tauri (TAURI-10): the shell checks the signed feed, downloads (minisign-verified before it says
// done) and installs; platform/sidecar.js gives `api` = { status, check, download(progress), install }.
// A package (.deb): the check only. After install() macOS and Linux start the new app by relaunch();
// on Windows the installer ends this process by itself.
function tauriTransport(api, { notify = false, relaunch = () => {} } = {}) {
  return {
    async check() {
      const found = await api.check();
      if (!found) return null;
      const offer = { version: found.version, notes: found.notes, tag: null };
      if (notify) return offer;
      return {
        ...offer,
        download: (progress) => api.download(progress),
        async install() {
          await api.install();
          relaunch();
        },
      };
    },
  };
}

// --- Where updates can work -------------------------------------------------------------------

// The feed the build was made with (resources/app-update.yml, written by electron-builder from
// build.publish): this repository on GitHub, or the loopback test feed of a test build.
function readFeed(file, { testBuild = false, readFile = fs.readFileSync } = {}) {
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch {
    return null;
  }
  const field = (name) => (text.match(new RegExp(`^${name}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm')) || [])[1] || null;
  const provider = field('provider');
  if (provider === 'github' && field('owner') === OWNER && field('repo') === REPO) return { provider };
  if (provider === 'generic' && testBuild && TEST_FEED.test(field('url') || '')) return { provider, test: true };
  return null;
}

/**
 * How this installation updates.
 * → { disabled: reason } | { mode: 'install', kind: 'nsis' | 'appimage' | 'mac' } | { mode: 'notify', kind: 'package' }
 */
function updateMode({ platform, packaged, smoke = false, env = {}, feed }) {
  if (smoke) return { disabled: 'smoke' };
  if (!packaged) return { disabled: 'dev' };
  if (!feed) return { disabled: 'feed' };
  if (platform === 'win32') return { mode: 'install', kind: 'nsis' };
  if (platform === 'darwin') return { mode: 'install', kind: 'mac' };
  if (platform === 'linux') return env.APPIMAGE ? { mode: 'install', kind: 'appimage' } : { mode: 'notify', kind: 'package' };
  return { disabled: 'platform' };
}

// --- Platform wiring (core.js) -----------------------------------------------------------------

/**
 * Starts the updater of the running app. deps: platform (platform/index.js: the app's version and
 * folders, relaunch and quit, and electron-updater's autoUpdater through platform.updater),
 * smoke, onChange(view), log
 * Returns the controller, plus page() and the startup check scheduled.
 */
function startUpdates({ platform, smoke = false, onChange = () => {}, log = (line) => console.log(`[capri] update: ${line}`) }) {
  if (platform.updater.transport === 'tauri') return startTauriUpdates({ platform, smoke, onChange, log });
  const packaged = platform.app.isPackaged();
  const testBuild = Boolean(packaged && safeRequire(path.join(platform.paths.get('appPath'), 'package.json'))?.capriUpdaterTest === true);
  const feed = packaged ? readFeed(path.join(platform.paths.get('resources'), 'app-update.yml'), { testBuild }) : null;
  const mode = updateMode({ platform: process.platform, packaged, smoke, env: process.env, feed });
  if (mode.disabled) {
    log(`disabled (${mode.disabled})`);
    return new UpdateController({ disabled: mode.disabled, current: platform.app.version(), onChange });
  }
  const { autoUpdater, CancellationToken } = platform.updater.get();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.fullChangelog = false;
  // its warnings only (its errors are the controller's to log, once, redacted)
  autoUpdater.logger = { info: () => {}, debug: () => {}, warn: (msg) => log(`warn: ${redact(msg?.message ?? msg)}`), error: () => {} };
  autoUpdater.on('error', () => {}); // failures are the controller's to report (an unheard 'error' would throw)
  let transport;
  if (mode.kind === 'mac') {
    const mac = require('./mac-update');
    mac.cleanup({ exePath: platform.paths.get('exe'), tmpDir: platform.paths.get('temp') });
    transport = macTransport(autoUpdater, mac.createMacInstaller({
      exePath: platform.paths.get('exe'),
      tmpDir: platform.paths.get('temp'),
      download: (url, dest, opts) => autoUpdater.httpExecutor.download(new URL(url), dest, { ...opts, cancellationToken: new CancellationToken() }),
      relaunch: () => {
        platform.app.relaunch();
        platform.app.quit();
      },
    }));
  } else if (mode.mode === 'notify') {
    transport = notifyTransport(autoUpdater);
  } else {
    transport = updaterTransport(autoUpdater);
  }
  const controller = new UpdateController({ transport, mode: mode.mode, current: platform.app.version(), onChange, log });
  log(`${mode.kind} (${feed.test ? 'local test feed' : `github ${OWNER}/${REPO}`})`);
  // once, unless a check was already asked for in the settings by then
  setTimeout(() => controller.status.kind === 'idle' && controller.check(), STARTUP_DELAY).unref?.();
  return controller;
}

// The Tauri build: Rust says (status) whether this installation updates: a provisioned bundle with a
// public key and https endpoints, no dev run, an AppImage or a package on Linux.
function startTauriUpdates({ platform, smoke, onChange, log }) {
  const current = platform.app.version();
  const { tauri: api } = platform.updater.get();
  const status = api.status || { mode: 'disabled', reason: 'dev' };
  if (smoke || status.mode === 'disabled') {
    const reason = smoke ? 'smoke' : status.reason || 'feed';
    log(`disabled (${reason})`);
    return new UpdateController({ disabled: reason, current, onChange });
  }
  const mode = status.mode === 'notify' ? 'notify' : 'install';
  const transport = tauriTransport(api, { notify: mode === 'notify', relaunch: () => platform.app.relaunch() });
  // a local test build also writes its lines to a file: the app it relaunches does not share our pipes
  const logFile = status.test ? process.env.CAPRI_UPDATER_SMOKE_LOG : null;
  if (logFile) {
    const say = log;
    log = (line) => {
      say(line);
      try { fs.appendFileSync(logFile, `update: ${line}\n`); } catch { /* the test's to notice */ }
    };
  }
  const controller = new UpdateController({ transport, mode, current, onChange, log });
  log(`tauri ${mode} ${current} (${status.test ? 'local test feed' : `github ${OWNER}/${REPO}`})`);
  // a local test build (scripts/updater-smoke-tauri.js; Rust says `test` only for a binary compiled for it) can run
  // the steps it is given, with the restart confirmed, instead of waiting for her settings window
  const steps = status.test ? String(process.env.CAPRI_UPDATER_SMOKE_STEPS || '').split(',').filter(Boolean) : [];
  if (steps.length) {
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (const step of steps) {
        if (step === 'check') await controller.check();
        else if (step === 'download') await controller.download();
        else if (step === 'install') await controller.install(async () => true);
      }
    })().catch((err) => log(`smoke steps: ${redact(err?.message ?? err)}`));
    return controller;
  }
  setTimeout(() => controller.status.kind === 'idle' && controller.check(), STARTUP_DELAY).unref?.();
  return controller;
}

function safeRequire(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  UpdateController,
  updateError,
  plainNotes,
  redact,
  releasePage,
  isReleasePage,
  updaterTransport,
  notifyTransport,
  macTransport,
  tauriTransport,
  readFeed,
  updateMode,
  startUpdates,
  RELEASES,
  TAG_PREFIX,
};
