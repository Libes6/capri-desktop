'use strict';

// One place that decides what command the assistants' hook settings run, and which existing
// entries are Capri's. When the Rust `capri-hook` binary is found next to the app, the command points
// at it; without it (a clone) the JS hooks run under plain `node`. Entries of the old Electron build
// (ELECTRON_RUN_AS_NODE=1 "<Capri>" hook.js) are still recognised, so that installing the hooks replaces them.

const fs = require('node:fs');
const path = require('node:path');

const BIN_NAME = process.platform === 'win32' ? 'capri-hook.exe' : 'capri-hook';
const SCRIPTS = { claude: 'capri-hook.js', codex: 'capri-codex-hook.js', agy: 'capri-agy-hook.js' };
const ASSISTANTS = Object.keys(SCRIPTS);
// `"<path>/capri-hook[.exe]" --assistant codex ...` (the path may be unquoted when it has no spaces)
const BIN_RE = /capri-hook(?:\.exe)?"?\s+--assistant\s+(claude|codex|agy)\b/i;

// Where the binary lives: CAPRI_HOOK_BIN (tests, dev), else in the resources folder of the packaged app
// (CAPRI_RESOURCES, set by sidecar/main.js: <resources>/bin/capri-hook).
function findHookBin({ env = process.env, resourcesPath = env.CAPRI_RESOURCES, dirs = [] } = {}) {
  const explicit = env.CAPRI_HOOK_BIN;
  if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  for (const dir of [resourcesPath, ...dirs].filter(Boolean)) {
    for (const file of [path.join(dir, 'bin', BIN_NAME), path.join(dir, BIN_NAME)]) {
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

// Forward slashes work in cmd, PowerShell and the bash Claude Code uses on Windows, and need
// no escaping; the double quotes keep spaces in the path. No env prefix: the binary needs none.
function quote(file) {
  return `"${String(file).replace(/\\/g, '/').replace(/"/g, '')}"`;
}

function binCommand(assistant, eventType, bin) {
  if (!SCRIPTS[assistant] || !bin) return null;
  return `${quote(bin)} --assistant ${assistant}${assistant === 'agy' && eventType ? ` ${eventType}` : ''}`;
}

// `legacy` is the `node <hook.js>` command, built by the installer, used when no binary exists.
function hookCommand(assistant, { eventType, legacy, bin = findHookBin() } = {}) {
  return binCommand(assistant, eventType, bin) || (typeof legacy === 'function' ? legacy() : legacy);
}

// Which assistant a stored command belongs to, and in which form. Anything else is the user's own.
function classify(command) {
  const text = String(command || '');
  const m = BIN_RE.exec(text);
  if (m) return { assistant: m[1].toLowerCase(), form: 'bin' };
  for (const [assistant, script] of Object.entries(SCRIPTS)) {
    if (text.includes(script)) {
      return { assistant, form: /ELECTRON_RUN_AS_NODE/.test(text) ? 'electron' : 'node' };
    }
  }
  return null;
}

const isCapriCommand = (command, assistant) => classify(command)?.assistant === assistant;
const isLegacyCommand = (command) => ['electron', 'node'].includes(classify(command)?.form);

// True when any `command` string anywhere inside `value` is Capri's (for one of `assistants`).
function containsCapriCommand(value, assistants = ASSISTANTS) {
  if (Array.isArray(value)) return value.some((v) => containsCapriCommand(v, assistants));
  if (!value || typeof value !== 'object') return false;
  if (typeof value.command === 'string' && assistants.includes(classify(value.command)?.assistant)) return true;
  return Object.values(value).some((v) => containsCapriCommand(v, assistants));
}

module.exports = {
  BIN_NAME, SCRIPTS, ASSISTANTS, findHookBin, binCommand, hookCommand, classify,
  isCapriCommand, isLegacyCommand, containsCapriCommand,
};
