'use strict';

// What Capri can really do on this computer, in one place: the menu, her guide, her setup and her
// chat ask this instead of guessing from the OS name. The base is what is implemented here (and
// whether its helper is in place); a native adapter that starts or fails later (window tracking on
// macOS or X11, CAPRI-08/09/10) reports it with set(), and whoever listens hears of the change.

const fs = require('node:fs');

// Every feature that depends on the system. Anything not here (the overlay, hooks, chat, reminders,
// opening folders, files and websites) works everywhere.
const FEATURES = [
  'windowTracking', // other windows' geometry and the one in front (sitting on them, possession, demo)
  'appList',        // the apps with a window open, by name
  'appClose',       // closing one of them
  'appLaunch',      // installed apps and games (Start menu, Steam, Epic)
  'mediaKeys',      // play/pause, next, volume, as media keys
  'autostart',      // starting with the system
  'ollamaInstall',  // installing Ollama herself (winget)
  'ollamaLaunch',   // Claude Code or Codex through Ollama, in a terminal window of its own
];

// The display session on Linux: Capri runs as an X11 client (ozone x11), natively or through
// XWayland. Native Wayland windows are out of reach of X11 calls, which matters to window tracking.
function linuxSession(env = {}) {
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  if (wayland) return env.DISPLAY ? 'xwayland' : 'wayland';
  return env.DISPLAY || env.XDG_SESSION_TYPE === 'x11' ? 'x11' : null;
}

// What this build implements on `platform`. `helpers.windowWatch`: the window watcher's helper
// script, which must be shipped for it to run.
function detect({ platform = process.platform, env = process.env, helpers = {}, exists = fs.existsSync } = {}) {
  const win = platform === 'win32';
  const has = (file) => {
    try {
      return Boolean(file) && exists(file);
    } catch {
      return false;
    }
  };
  return {
    platform,
    session: platform === 'linux' ? linuxSession(env) : null,
    features: {
      windowTracking: win && has(helpers.windowWatch),
      appList: win,
      appClose: win,
      appLaunch: win,
      mediaKeys: win,
      autostart: win || platform === 'darwin', // login items; not on Linux yet
      ollamaInstall: win,
      ollamaLaunch: win,
    },
  };
}

function createCapabilities(options = {}) {
  const base = detect(options);
  const runtime = {}; // what adapters reported since: feature -> boolean
  const listeners = new Set();

  const features = () => ({ ...base.features, ...runtime });

  return {
    platform: base.platform,
    session: base.session,

    // { feature: boolean } for every feature
    all: features,

    has(name) {
      if (!FEATURES.includes(name)) throw new Error(`unknown capability: ${name}`);
      return features()[name];
    },

    // An adapter started (true) or gave up (false). Listeners hear of real changes only.
    set(name, value) {
      if (!FEATURES.includes(name)) throw new Error(`unknown capability: ${name}`);
      const before = features()[name];
      runtime[name] = Boolean(value);
      if (before !== runtime[name]) listeners.forEach((fn) => fn(name, runtime[name]));
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Only what the overlay acts on, as plain booleans.
    forRenderer() {
      const f = features();
      return {
        windows: f.windowTracking,
        possess: f.windowTracking,
        closeApps: f.appList && f.appClose,
        launchApps: f.appLaunch,
        mediaKeys: f.mediaKeys,
        ollamaLaunch: f.ollamaLaunch,
      };
    },
  };
}

module.exports = { FEATURES, detect, linuxSession, createCapabilities };
