'use strict';

// One place that decides what command the assistants' hook settings run, and which existing
// entries are Capri's. Default (Electron/Node): the JS hooks, as before. When the Rust
// `capri-hook` binary is found next to the app, the command points at it instead and the
// old Electron/Node entries can be migrated.

const fs = require('node:fs');
const path = require('node:path');

const BIN_NAME = process.platform === 'win32' ? 'capri-hook.exe' : 'capri-hook';
const SCRIPTS = { claude: 'capri-hook.js', codex: 'capri-codex-hook.js', agy: 'capri-agy-hook.js' };
const ASSISTANTS = Object.keys(SCRIPTS);
// `"<path>/capri-hook[.exe]" --assistant codex ...` (the path may be unquoted when it has no spaces)
const BIN_RE = /capri-hook(?:\.exe)?"?\s+--assistant\s+(claude|codex|agy)\b/i;

// Where the binary lives: CAPRI_HOOK_BIN (tests, dev), else next to the packaged app.
function findHookBin({ env = process.env, resourcesPath = process.resourcesPath, dirs = [] } = {}) {
  const explicit = env.CAPRI_HOOK_BIN;
  if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  for (const dir of [resourcesPath, ...dirs].filter(Boolean)) {
    const file = path.join(dir, BIN_NAME);
    if (fs.existsSync(file)) return file;
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

// `legacy` is the previous Electron/Node command, built by the installer, used when no binary exists.
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

// AGY commands end with the event name the installer appended.
function agyEventType(command) {
  const words = String(command).trim().split(/\s+/);
  return words[words.length - 1].replace(/^"|"$/g, '');
}

// Walks parsed settings and rewrites Capri's own commands (old Electron/Node form, or a binary path that
// moved) to the current command. Everything else, including the user's other hooks, is untouched.
function rewriteCommands(node, assistant, bin) {
  let changed = 0;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (typeof value.command === 'string' && isCapriCommand(value.command, assistant)) {
      const type = assistant === 'agy' ? agyEventType(value.command) : undefined;
      const next = binCommand(assistant, type, bin);
      if (next !== value.command) {
        value.command = next;
        changed += 1;
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(node);
  return changed;
}

// Rewrites one assistant's settings file in place (timestamped backup first). Without a binary it
// does nothing: the Electron build keeps its Node commands. Returns { file, migrated }.
function migrateFile(file, assistant, bin = findHookBin()) {
  if (!bin || !fs.existsSync(file)) return { file, migrated: 0 };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { file, migrated: 0 }; // never touch a file we cannot read
  }
  const migrated = rewriteCommands(settings, assistant, bin);
  if (migrated) {
    fs.copyFileSync(file, `${file}.capri-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
  return { file, migrated };
}

// The way back (TAURI-09, going back to the Electron build): Capri's `capri-hook` entries become the
// command `legacyFor(eventType)` gives (the installer's Electron/Node one, built by the build that is
// running). Same rules as migrateFile: only Capri's own entries, a timestamped backup, a file that does
// not parse is left alone. Returns { file, reverted }.
function revertFile(file, assistant, legacyFor) {
  if (typeof legacyFor !== 'function' || !fs.existsSync(file)) return { file, reverted: 0 };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { file, reverted: 0 };
  }
  let reverted = 0;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (typeof value.command === 'string') {
      const found = classify(value.command);
      if (found?.assistant === assistant && found.form === 'bin') {
        const next = legacyFor(assistant === 'agy' ? agyEventType(value.command) : undefined);
        if (next && next !== value.command) {
          value.command = next;
          reverted += 1;
        }
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(settings);
  if (reverted) {
    fs.copyFileSync(file, `${file}.capri-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
  return { file, reverted };
}

module.exports = {
  BIN_NAME, SCRIPTS, ASSISTANTS, findHookBin, binCommand, hookCommand, classify,
  isCapriCommand, isLegacyCommand, containsCapriCommand, rewriteCommands, migrateFile, revertFile,
};
