'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hc = require('../src/main/hooks-command');

const claude = require('../scripts/install-hooks');
const codex = require('../scripts/install-codex-hooks');
const agy = require('../scripts/install-hooks-agy');

// Only temporary profiles: the real ~/.claude, ~/.codex and ~/.gemini are never read or written.
function sandbox(t, { bin = true, binDir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-hookcmd-'));
  const saved = { ...process.env };
  const binPath = path.join(binDir ? path.join(dir, binDir) : dir, hc.BIN_NAME);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '');
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CODEX_HOME: path.join(dir, 'codex'),
    AGY_CONFIG_DIR: path.join(dir, 'agy'),
  });
  if (bin) process.env.CAPRI_HOOK_BIN = binPath; else delete process.env.CAPRI_HOOK_BIN;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true }); // only the directory created above
  });
  return { dir, binPath, claudeFile: claude.status().file, codexFile: codex.status().file, agyFile: agy.status().file };
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const commands = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((v) => commands(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') out.push(value.command);
    Object.values(value).forEach((v) => commands(v, out));
  }
  return out;
};

const OLD_ELECTRON = 'ELECTRON_RUN_AS_NODE=1 "/Applications/Capri.app/Contents/MacOS/Capri" "/Applications/Capri.app/Contents/Resources/app.asar.unpacked/hooks/capri-hook.js"';
const OLD_NODE = 'node "/old/place/hooks/capri-codex-hook.js"';
const OLD_AGY = (type) => `ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Capri/Capri.exe" "C:/Program Files/Capri/resources/app.asar.unpacked/hooks/capri-agy-hook.js" ${type}`;

test('without the binary the commands are `node <hook.js>`', (t) => {
  const s = sandbox(t, { bin: false });
  assert.equal(hc.findHookBin({ env: {}, resourcesPath: undefined }), null);
  claude.install(); codex.install(); agy.install();
  for (const file of [s.claudeFile, s.codexFile, s.agyFile]) {
    for (const c of commands(read(file))) {
      assert.match(c, /^node /);
      assert.match(c, /capri-(codex-|agy-)?hook\.js/);
    }
  }
});

test('the binary is found by env, and in the resources directory of a packaged app', (t) => {
  const s = sandbox(t, { binDir: 'res' });
  assert.equal(hc.findHookBin({ env: { CAPRI_HOOK_BIN: s.binPath } }), s.binPath);
  assert.equal(hc.findHookBin({ env: { CAPRI_HOOK_BIN: path.join(s.dir, 'nope') } }), null);
  assert.equal(hc.findHookBin({ env: {}, resourcesPath: path.dirname(s.binPath) }), s.binPath);
  assert.equal(hc.findHookBin({ env: {}, resourcesPath: s.dir + '-none', dirs: [path.dirname(s.binPath)] }), s.binPath);
  assert.equal(hc.findHookBin({ env: {}, resourcesPath: path.join(s.dir, 'empty') }), null);
});

test('command format: quoted, no env prefix, spaces and Windows paths survive', () => {
  assert.equal(hc.binCommand('claude', undefined, '/Apps/My Capri/capri-hook'), '"/Apps/My Capri/capri-hook" --assistant claude');
  assert.equal(hc.binCommand('codex', undefined, 'C:\\Program Files\\Capri\\capri-hook.exe'), '"C:/Program Files/Capri/capri-hook.exe" --assistant codex');
  assert.equal(hc.binCommand('agy', 'PreToolUse', '/x/capri-hook'), '"/x/capri-hook" --assistant agy PreToolUse');
  assert.doesNotMatch(hc.binCommand('claude', undefined, '/x/capri-hook'), /ELECTRON_RUN_AS_NODE/);
  assert.equal(hc.hookCommand('claude', { legacy: () => 'legacy', bin: null }), 'legacy');
  assert.equal(hc.hookCommand('claude', { legacy: () => 'legacy', bin: '/x/capri-hook' }), '"/x/capri-hook" --assistant claude');
  assert.equal(hc.classify('echo capri-hook is great'), null);
  assert.equal(hc.classify(hc.binCommand('agy', 'Stop', 'C:\\a b\\capri-hook.exe')).assistant, 'agy');
  assert.deepEqual(hc.classify(OLD_ELECTRON), { assistant: 'claude', form: 'electron' });
  assert.deepEqual(hc.classify(OLD_NODE), { assistant: 'codex', form: 'node' });
  assert.equal(hc.isLegacyCommand(OLD_ELECTRON), true);
  assert.equal(hc.isLegacyCommand('"/x/capri-hook" --assistant claude'), false);
});

test('fresh install with the binary writes the binary command for all three assistants', (t) => {
  const s = sandbox(t, { binDir: 'with space' });
  claude.install(); codex.install(); agy.install();
  const want = (a, type) => hc.binCommand(a, type, s.binPath);
  assert.equal(claude.status().installed, true);
  assert.equal(codex.status().installed, true);
  assert.equal(agy.status().installed, true);
  assert.deepEqual([...new Set(commands(read(s.claudeFile)))], [want('claude')]);
  assert.deepEqual([...new Set(commands(read(s.codexFile)))], [want('codex')]);
  const agyCmds = commands(read(s.agyFile));
  assert.deepEqual(agyCmds.sort(), ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'].map((e) => want('agy', e)).sort());
  assert.match(agyCmds[0], /with space/);
  // uninstall removes the binary entries too
  claude.uninstall(); codex.uninstall(); agy.uninstall();
  assert.equal(claude.status().installed, false);
  assert.equal(codex.status().installed, false);
  assert.equal(agy.status().installed, false);
});

test('installing over old entries swaps them for the binary command without duplicates', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.dirname(s.claudeFile), { recursive: true });
  fs.writeFileSync(s.claudeFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: OLD_ELECTRON }] }] } }));
  claude.install();
  const stop = read(s.claudeFile).hooks.Stop;
  assert.equal(stop.length, 1);
  assert.equal(stop[0].hooks[0].command, hc.binCommand('claude', undefined, s.binPath));
});
