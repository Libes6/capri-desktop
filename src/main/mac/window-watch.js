'use strict';

// macOS window watch: the same contract as startWindowWatch() in ../windows.js, which starts it on
// macOS, fed by the small Swift helper next to this file (capri-windows.swift, built into bin/ by
// scripts/build-mac-helper.js; electron-builder does it before packing, scripts/before-pack.js).
//
// The helper speaks in global points with the origin at the main display's top-left corner and y
// going down. Electron's screen coordinates on macOS are the same points (DIP), so unlike the
// Windows helper's physical pixels nothing has to be scaled: only shifted into the overlay's frame.
// Of the Windows fields only `fg` and `wins` exist here; the others keep their empty defaults.

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn: nodeSpawn } = require('node:child_process');

// From the repository: bin/ next to this file (scripts/build-mac-helper.js). In the packaged app it
// is outside the app archive, in the bundle's Resources/bin (package.json build.mac.extraResources),
// so no other platform's package carries it.
function helperPath(dir = __dirname, resources = process.resourcesPath) {
  const packaged = dir.split(path.sep).some((part) => part === 'app.asar' || part === 'app.asar.unpacked');
  return packaged && resources ? path.join(resources, 'bin', 'capri-windows') : path.join(dir, 'bin', 'capri-windows');
}
const HELPER = helperPath();

const MAX_WINDOWS = 40;
const LIMIT = 1e6; // no real screen is this far away: anything beyond is garbage

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < LIMIT;
const windowId = (n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff;

// One line of the helper into a snapshot, or null if it is not one. Unknown fields are dropped,
// so nothing the helper might add later (or a title, should it ever print one) travels further.
function parseLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.wins)) return null;
  const wins = [];
  for (const w of raw.wins) {
    if (wins.length >= MAX_WINDOWS) break;
    if (!w || !windowId(w.id) || ![w.x, w.y, w.w, w.h].every(finite) || w.w <= 0 || w.h <= 0) continue;
    wins.push({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, max: w.max === true, full: w.full === true });
  }
  const displays = (Array.isArray(raw.displays) ? raw.displays : [])
    .filter((d) => d && windowId(d.id) && [d.x, d.y, d.w, d.h].every(finite) && d.w > 0 && d.h > 0)
    .map((d) => ({ id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, scale: finite(d.scale) && d.scale > 0 ? d.scale : 1 }));
  return { fg: windowId(raw.fg) ? raw.fg : null, wins, displays, locked: raw.locked === true };
}

// The snapshot as seen from her window (`bounds`, in screen DIP), in the Windows watcher's shape.
function toUpdate(snapshot, bounds) {
  const wins = snapshot.wins
    .map((w) => ({ id: w.id, x: w.x - bounds.x, y: w.y - bounds.y, w: w.w, h: w.h, max: w.max, full: w.full }))
    // only what overlaps Capri's screen
    .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
  return { fg: snapshot.fg, taskbar: false, ai: [], game: null, usb: [], plug: null, wins };
}

// Capri's own overlay, as a window number the helper can skip ("window:<CGWindowID>:0")
function overlayWindowId(overlay) {
  try {
    const m = /^window:(\d+):/.exec(overlay.mediaSourceId());
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Nothing to sit on: what goes to the overlay when the helper gave up, so she does not stay perched
// on a window she can no longer follow
const emptyUpdate = () => ({ fg: null, taskbar: false, ai: [], game: null, usb: [], plug: null, wins: [] });

// onState(ok), as in ../windows.js: the helper runs (true, on its first snapshot), or is missing or
// gave up after its restarts (false): capabilities.js
//
// pause() / resume(): around sleep and the lock screen (windows.js). While the screen is locked or
// asleep the helper's snapshots are not to be trusted (animations stall, see
// docs/MAC_WINDOW_TRACKING.md), so it is stopped; resume() starts a fresh one with its restarts
// earned back, which is also how a helper that gave up gets one more chance after a system event,
// never in a loop of its own.
function startMacWindowWatch({
  overlay, onUpdate, onState = () => {}, helper = HELPER, spawn = nodeSpawn, log = console.error, excludeOwnProcess = false,
}) {
  const idle = { available: false, stop() {}, refresh() {}, pause() {}, resume() {} };
  if (!fs.existsSync(helper)) {
    log('[capri] window watch: macOS helper not built, windows are not tracked');
    onState(false);
    return idle; // she keeps the screen floor and the corners: the base overlay
  }

  let child = null;
  let stopped = false;
  let paused = false;
  let restarts = 0;
  let retry = null; // the pending restart, cancelled by stop() and pause()
  let last = null; // the helper's last snapshot: it only speaks when something changes

  const send = () => {
    if (!last || !overlay.isAlive()) return;
    onUpdate(toUpdate(last, overlay.bounds()));
  };

  // the running helper, if any, let go: whatever it still prints or however it ends is ignored
  const retire = () => {
    clearTimeout(retry);
    retry = null;
    if (!child) return;
    child.retired = true;
    child.kill();
    child = null;
  };

  const giveUp = () => {
    log('[capri] window watch: the macOS helper keeps failing, windows are not tracked');
    last = null;
    if (overlay.isAlive()) onUpdate(emptyUpdate());
    onState(false);
  };

  const start = () => {
    retry = null;
    if (stopped || paused) return;
    const startedAt = Date.now();
    let running = false;
    const args = ['--parent', String(process.pid), '--watch-stdin'];
    const self = overlayWindowId(overlay);
    if (self) args.push('--self-window', String(self));
    // her other windows (chat, setup) are fair perches on Windows too; skipping them is optional
    if (excludeOwnProcess) args.push('--exclude-pid', String(process.pid));
    const proc = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (stopped || proc.retired) return; // lines still buffered when she stopped it
      const snap = parseLine(line);
      if (!snap) return;
      if (!running) {
        running = true;
        onState(true);
      }
      // behind the lock screen the list is stale (stalled animations): the last good one holds
      if (snap.locked) return;
      last = snap;
      send();
    });
    proc.stderr.on('data', (d) => log('[capri] window watch:', String(d).trim()));
    // not executable (EACCES), gone: no 'exit' then, only 'close'
    proc.on('error', (err) => log('[capri] window watch:', err.message));
    proc.on('close', () => {
      if (child === proc) child = null;
      if (stopped || proc.retired) return;
      // a helper that ran a good while earns its restarts back; one that keeps dying stops after 3
      if (Date.now() - startedAt > 60000) restarts = 0;
      if (restarts++ < 3) retry = setTimeout(start, 3000);
      else giveUp();
    });
  };

  start();
  return {
    available: true,
    stop() {
      stopped = true;
      retire();
    },
    // her window moved (another screen): the same windows, from there
    refresh: send,
    // asleep or locked: no helper meanwhile; the last snapshot stays where it is
    pause() {
      if (stopped) return;
      paused = true;
      retire();
    },
    // awake, unlocked, screens changed: a fresh helper (the old one, if any, replaced)
    resume() {
      if (stopped) return;
      paused = false;
      restarts = 0;
      retire();
      start();
    },
  };
}

module.exports = { startMacWindowWatch, parseLine, toUpdate, overlayWindowId, HELPER, helperPath, emptyUpdate };
