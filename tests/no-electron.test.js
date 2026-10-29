'use strict';
// TAURI-14: Electron is gone from the code. Nothing in the repository (the docs, the changelog and the lock file
// aside) requires it, builds with it or runs under it. The branch electron-final is an archive and does not count.
// The one place that still names it is the recogniser of the old hook commands (src/main/hooks-command.js):
// installing the hooks replaces an entry that an Electron build of Capri once wrote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = [
  /require(?:\.resolve)?\(\s*['"`]electron(-updater|-builder)?(\/[^'"`]*)?['"`]\s*\)/,
  /(?:from|import)\s+['"`]electron(-updater|-builder)?['"`]/,
  /import\(\s*['"`]electron/,
  /\bnpx\s+(?:--\S+\s+)*electron\b/,
  /\belectron\s+(?:\.|scripts\/)/,
  /\belectron-builder\b/,
  /\belectron-updater\b/,
  /\bELECTRON_RUN_AS_NODE\b/,
  /process\.versions\.electron/,
];
// files that may name them: this test, the recogniser of old hook commands and its test
const ALLOWED = new Set(['tests/no-electron.test.js', 'src/main/hooks-command.js', 'tests/hooks-command.test.js']);

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return null; // not a git checkout (an exported tree): nothing to list
  }
}

test('no working file requires, builds with or runs under Electron', { skip: tracked() === null && 'not a git checkout' }, () => {
  const bad = [];
  for (const file of tracked()) {
    if (file.startsWith('docs/') || /^CHANGELOG/i.test(file) || file === 'package-lock.json' || ALLOWED.has(file)) continue;
    if (!/\.(js|mjs|cjs|json|yml|yaml|html|css|rs|toml|swift|ps1|nsh|sh|md)$/.test(file)) continue;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) bad.push(`${file}: ${re}`);
  }
  assert.deepEqual(bad, []);
});

test('package.json has no Electron dependency, build block, main or script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}), ...Object.keys(pkg.optionalDependencies || {})];
  assert.deepEqual(names.filter((n) => /electron/i.test(n)), []);
  assert.equal(pkg.build, undefined);
  assert.equal(pkg.main, undefined);
  assert.deepEqual(Object.entries(pkg.scripts).filter(([, v]) => /electron/i.test(v)), []);
  assert.ok(!/electron/i.test(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')));
});

test('the old Electron hook entries are still recognised, so that installing replaces them', () => {
  const hc = require('../src/main/hooks-command');
  assert.deepEqual(hc.classify('ELECTRON_RUN_AS_NODE=1 "/Applications/Capri.app/Contents/MacOS/Capri" "/x/hooks/capri-hook.js"'), { assistant: 'claude', form: 'electron' });
});
