'use strict';

// The system's language preference list for the Tauri build (TAURI-11; CAPRI-01). Electron asks
// `app.getPreferredSystemLanguages()`; the sidecar is plain Node, whose `Intl` locale comes from the
// environment (LANG), and an app started from the Finder or the Start menu has none: she would speak
// English to a Russian Mac. So the list is asked of the system once, at start, where the system keeps it:
//   macOS   `defaults read -g AppleLanguages`   (System Settings > Language & Region, in order)
//   Windows the user's language list (Get-WinUserLanguageList), in order
//   Linux   LANGUAGE (a colon list), then LC_ALL, LC_MESSAGES, LANG
// Pure parsing is here and tested; `run` is injected. Never throws: no answer is `[]` and the caller falls
// back to the process locale.

const { execFile } = require('node:child_process');

// "ru_RU.UTF-8" / "ru_RU@euro" / "pt-BR" -> "ru-RU" / "pt-BR"; "C", "POSIX", "" -> null
function normalizeTag(raw) {
  const tag = String(raw || '').trim().split(/[.@]/)[0].replace(/_/g, '-');
  if (!tag || /^(C|POSIX)$/i.test(tag) || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return null;
  return tag;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

// defaults prints a property list: ( "ru-RU", "en-RU" )
function parseDefaultsList(text) {
  return unique([...String(text || '').matchAll(/"([^"]+)"|^\s*([A-Za-z][\w-]*)\s*,?\s*$/gm)].map((m) => normalizeTag(m[1] || m[2])));
}

function parseLines(text) {
  return unique(String(text || '').split(/\r?\n/).map(normalizeTag));
}

function fromEnv(env = process.env) {
  const list = [];
  for (const part of String(env.LANGUAGE || '').split(':')) list.push(normalizeTag(part));
  list.push(normalizeTag(env.LC_ALL), normalizeTag(env.LC_MESSAGES), normalizeTag(env.LANG));
  return unique(list);
}

const nodeRun = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 4000, windowsHide: true, maxBuffer: 1 << 16 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

async function systemLanguages({ platform = process.platform, env = process.env, run = nodeRun } = {}) {
  try {
    if (platform === 'darwin') return parseDefaultsList(await run('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']));
    if (platform === 'win32') {
      return parseLines(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) -join [Environment]::NewLine']));
    }
    return fromEnv(env);
  } catch {
    return [];
  }
}

module.exports = { systemLanguages, parseDefaultsList, parseLines, fromEnv, normalizeTag };
