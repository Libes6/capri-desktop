'use strict';

// TAURI-02: the protocol (src/protocol.js) is the one list of what her pages and the core say to each
// other. The tests: it is complete (the protocol's channels are the core's handlers, the preloads' and
// host.js's, events too), every command passes with good arguments and is turned down with bad ones,
// and none can be called from the other window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const protocol = require('../src/protocol');
const { createDispatcher, ProtocolError } = require('../src/main/dispatch');
const { createFakePlatform } = require('../src/main/platform/fake');
const { createCore } = require('../src/main/core');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const { COMMANDS, EVENTS } = protocol;
const names = (list) => list.map((c) => c.name);

// --- a good call of every command ----------------------------------------------------------------------------------

const GOOD = {
  rendererReady: [], setInteractive: [true], rearm: [], cursor: [], screens: [], moveScreen: [2], getConfig: [],
  setConfig: [{ muted: true }], listSounds: [], hooksStatus: [], demoWindow: [false], openMenu: [], installHooks: [],
  claudeFound: [], openClaudeHelp: [], windowsNow: [], trayPlace: [], openClaudeFolder: [],
  copyImage: [{ x: 0, y: 10, width: 300, height: 200 }], chatStatus: [],
  chatSend: [{ id: 't1', messages: [{ role: 'system', content: 'you are Capri' }, { role: 'user', content: 'hi' }] }],
  chatStop: ['t1'], chatMemory: [], chatRemember: [[{ role: 'user', content: 'hi' }]], lookSnap: [],
  lookSay: [{ id: 'abc', persona: 'she', prompt: 'what is this?' }], lookWhere: [], cpu: [], openOllama: [], setupInfo: [],
  ollamaState: [], installOllama: [], startOllama: [], pullModel: ['llama3.2'], cancelSetup: [],
  useProvider: [{ provider: 'groq', key: 'gsk_test' }], keyPage: ['groq'], launchThroughOllama: ['claude'], openApps: [],
  findApp: ['spotify'], closeApp: ['Spotify', false], findLaunch: ['spotify'], launch: [{ kind: 'app', id: 'x!y', name: 'X' }],
  media: ['pause'], music: ['daft punk'], youtube: ['daft punk'], roblox: ['brookhaven'],
  searchFiles: [{ query: 'cv', exts: ['pdf'] }], openFile: ['/tmp/a.txt', true], screenshot: [], webSearch: ['cyber pet'],
  openSite: ['example.com'], focusOverlay: [true],
  view: [], ready: [{ sections: 4, focused: 'field-lang' }], set: [{ volume: 0.3 }], saveKey: ['openai', 'sk-test-0123456789'],
  reset: [], restart: [], close: [],
  'updates.check': [], 'updates.download': [], 'updates.install': [true], 'updates.page': [],
};
// what the handler is to get for it (the preload's packing), where it is not the args as they are
const PAYLOAD = {
  closeApp: { name: 'Spotify', force: false },
  openFile: { file: '/tmp/a.txt', reveal: true },
  saveKey: { provider: 'openai', key: 'sk-test-0123456789' },
};

const OVERLAY_SENDER = { page: 'overlay' };
const SETTINGS_SENDER = { page: 'settings' };
const STRANGER = { page: 'somewhere else' };
const scopeOf = (sender) => (sender === OVERLAY_SENDER ? 'overlay' : sender === SETTINGS_SENDER ? 'settings' : null);

function stubbed() {
  const calls = [];
  const handlers = { on: {}, handle: {} };
  for (const c of COMMANDS) handlers[c.kind === 'send' ? 'on' : 'handle'][c.channel] = (payload, sender) => { calls.push({ channel: c.channel, payload, sender }); return `answer:${c.channel}`; };
  return { calls, dispatch: createDispatcher({ handlers, scopeOf }) };
}
const senderOf = (c) => (c.scope === 'overlay' ? OVERLAY_SENDER : SETTINGS_SENDER);
const strangerOf = (c) => (c.scope === 'overlay' ? SETTINGS_SENDER : OVERLAY_SENDER);
const refusal = (fn, code) => assert.throws(fn, (err) => err instanceof ProtocolError && (!code || err.code === code));

// --- the protocol itself --------------------------------------------------------------------------------------------

test('the protocol is well formed: unique names per window, unique channels, known scopes and kinds', () => {
  assert.ok(COMMANDS.length >= 60);
  assert.equal(new Set(COMMANDS.map((c) => c.channel)).size, COMMANDS.length, 'a channel twice');
  for (const scope of protocol.SCOPES) {
    const own = names(COMMANDS.filter((c) => c.scope === scope));
    assert.equal(new Set(own).size, own.length, `a name twice in ${scope}`);
  }
  for (const c of COMMANDS) {
    assert.ok(protocol.SCOPES.includes(c.scope), c.name);
    assert.ok(['send', 'handle'].includes(c.kind), c.name);
    assert.ok(['none', 'first', 'object'].includes(c.pack), c.name);
    assert.ok(c.doc, `${c.name} has no comment`);
    assert.ok(c.kind === 'send' || c.reply, `${c.name} has no reply`);
    assert.ok(c.pack !== 'none' || c.params.length === 0, c.name);
    assert.ok(c.pack !== 'first' || c.params.length === 1, c.name);
    // the channel's own prefix: settings:* and updates:* are the settings window's
    if (/^(settings|updates):/.test(c.channel)) assert.equal(c.scope, 'settings', c.channel);
    else assert.equal(c.scope, 'overlay', c.channel);
  }
  assert.equal(new Set(EVENTS.map((e) => e.event)).size, EVENTS.length);
  for (const e of EVENTS) assert.ok(e.doc && protocol.SCOPES.includes(e.scope), e.event);
});

test('JSON carries the whole protocol (it is exported for the Rust side)', () => {
  const copy = JSON.parse(JSON.stringify({ commands: COMMANDS, events: EVENTS }));
  assert.equal(copy.commands.length, COMMANDS.length);
  assert.deepEqual(copy.commands.map((c) => c.channel), COMMANDS.map((c) => c.channel));
  const exported = JSON.parse(read('docs/protocol.json'));
  assert.deepEqual(exported.commands, copy.commands, 'docs/protocol.json is old: run npm run protocol:export');
  assert.deepEqual(exported.events, copy.events);
});

// --- complete: the protocol, the core, the preloads, host.js ----------------------------------------------------------

test('the protocol\'s channels are the core\'s handlers, kind for kind (no more, no fewer)', () => {
  const src = read('src/main/core.js');
  const found = [...src.matchAll(/ipc(On|Handle)\('([^']+)'/g)].map((m) => [m[1] === 'On' ? 'send' : 'handle', m[2]]);
  const fromCore = found.map(([kind, channel]) => `${kind}:${channel}`).sort();
  assert.equal(new Set(fromCore).size, fromCore.length, 'a handler registered twice in core.js');
  assert.deepEqual(COMMANDS.map((c) => `${c.kind}:${c.channel}`).sort(), fromCore);
  // and the real core, started: nothing missing, nothing extra
  const { core, userData } = startCore();
  try {
    assert.deepEqual(core.dispatch.audit(), { missing: [], extra: [] });
    assert.deepEqual(Object.keys(core.ipc.on).sort(), COMMANDS.filter((c) => c.kind === 'send').map((c) => c.channel).sort());
    assert.deepEqual(Object.keys(core.ipc.handle).sort(), COMMANDS.filter((c) => c.kind === 'handle').map((c) => c.channel).sort());
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// method -> { channel, kind, params } of a preload, read from its source
function preloadCommands(file, bridge) {
  const out = new Map();
  let prefix = '';
  for (const line of read(file).split('\n')) {
    if (/^\s{2}updates: \{/.test(line)) prefix = 'updates.';
    else if (/^\s{2}\},?$/.test(line)) prefix = '';
    const m = line.match(/^\s+(\w+): \(([^)]*)\) => ipcRenderer\.(send|invoke)\('([^']+)'/);
    if (m && !/^\s+on\w+:/.test(line)) out.set(prefix + m[1], { kind: m[3] === 'send' ? 'send' : 'handle', channel: m[4], params: m[2].split(',').map((x) => x.trim()).filter(Boolean) });
  }
  assert.ok(out.size >= 10, `${bridge}: its commands were read`);
  return out;
}

test('the protocol and the preloads agree on every command: name, channel, send or invoke, argument names', () => {
  const overlay = preloadCommands('src/preload.js', 'host');
  const settings = preloadCommands('src/settings-preload.js', 'settingsHost');
  for (const [scope, found] of [['overlay', overlay], ['settings', settings]]) {
    const mine = COMMANDS.filter((c) => c.scope === scope);
    assert.deepEqual(names(mine).sort(), [...found.keys()].sort(), `the ${scope} preload's methods`);
    for (const c of mine) {
      const p = found.get(c.name);
      assert.equal(c.channel, p.channel, c.name);
      assert.equal(c.kind, p.kind, c.name);
      assert.deepEqual(c.params.map((x) => x.name), p.params, `${c.name}: argument names`);
    }
  }
});

test('the protocol and the preloads agree on the events', () => {
  const overlay = [...read('src/preload.js').matchAll(/^\s+(on\w+): on\('([^']+)'\)/gm)].map((m) => [m[1], m[2]]);
  const settingsSrc = read('src/settings-preload.js');
  const settings = [
    ['onView', settingsSrc.match(/ipcRenderer\.on\('(settings:view)'/)[1]],
    ['onSection', settingsSrc.match(/ipcRenderer\.on\('(settings:section)'/)[1]],
    ['updates.onStatus', settingsSrc.match(/ipcRenderer\.on\('(updates:status)'/)[1]],
  ];
  const mine = EVENTS.map((e) => [e.name, e.event]);
  const theirs = [...overlay, ...settings];
  assert.deepEqual(mine.sort(), theirs.sort());
  // the preload's names for the same: onView is settingsHost.onView, onStatus is settingsHost.updates.onStatus
  assert.ok(overlay.length >= 8);
});

test('every event of the protocol is sent by the core, and the core sends no other', () => {
  const files = fs.readdirSync(path.join(ROOT, 'src/main')).filter((f) => f.endsWith('.js'));
  const sent = new Set();
  for (const f of files) {
    const text = read(`src/main/${f}`).replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/(?:overlay\??|settings\??|webContents|win\.webContents)\.send\('([^']+)'/g)) sent.add(m[1]);
  }
  assert.deepEqual([...sent].sort(), EVENTS.map((e) => e.event).sort());
});

test('host.js offers exactly the protocol\'s commands and events, over invoke and on', async () => {
  const { host, settingsHost } = await import(pathToFileURL(path.join(ROOT, 'src/renderer/js/host.js')).href);
  const log = [];
  global.window = {
    __CAPRI_HOST__: {
      invoke: (name, args) => log.push(['invoke', name, args]),
      on: (event) => log.push(['on', event]) && (() => {}),
    },
  };
  try {
    for (const [scope, bridge] of [['overlay', host], ['settings', settingsHost]]) {
      const mine = COMMANDS.filter((c) => c.scope === scope);
      const functions = Object.entries(bridge).flatMap(([key, value]) => {
        if (['invoke', 'on'].includes(key)) return [];
        if (typeof value === 'function') return [[key, value]];
        return Object.entries(value).map(([sub, fn]) => [`${key}.${sub}`, fn]);
      });
      const commandNames = functions.map(([key]) => key).filter((key) => !/(^|\.)on[A-Z]/.test(key));
      assert.deepEqual(commandNames.sort(), names(mine).sort(), `${scope}: host.js's commands`);
      // each calls invoke(name, args) with its own name and the arguments as they are
      for (const c of mine) {
        log.length = 0;
        const fn = c.name.split('.').reduce((o, k) => o[k], bridge);
        fn(...(GOOD[c.name] || []));
        assert.deepEqual(log, [['invoke', c.name, GOOD[c.name]]], c.name);
      }
      // the events: the method's name, the protocol's channel
      const eventNames = functions.map(([key]) => key).filter((key) => /(^|\.)on[A-Z]/.test(key));
      const events = EVENTS.filter((e) => e.scope === scope);
      assert.deepEqual(eventNames.sort(), names(events).sort(), `${scope}: host.js's events`);
      for (const e of events) {
        log.length = 0;
        e.name.split('.').reduce((o, k) => o[k], bridge)(() => {});
        assert.deepEqual(log, [['on', e.event]], e.name);
      }
    }
  } finally {
    delete global.window;
  }
});

test('the pages call only commands of the protocol, from their own window', () => {
  const dir = path.join(ROOT, 'src/renderer/js');
  const overlay = new Set(names(COMMANDS.filter((c) => c.scope === 'overlay')).concat(names(EVENTS.filter((e) => e.scope === 'overlay'))));
  const settings = new Set(names(COMMANDS.filter((c) => c.scope === 'settings')).concat(names(EVENTS.filter((e) => e.scope === 'settings'))));
  const used = { overlay: new Set(), settings: new Set() };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'host.js')) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const scope = file === 'settings.js' ? 'settings' : 'overlay';
    for (const m of text.matchAll(/\bhost\.((?:updates\.)?[A-Za-z]+)\(/g)) {
      if (m[1] === 'includes') continue; // `host.includes('.')` is a string's
      used[scope].add(m[1]);
    }
  }
  for (const n of used.overlay) assert.ok(overlay.has(n), `the overlay's pages call host.${n}, which the protocol lacks`);
  for (const n of used.settings) assert.ok(settings.has(n), `the settings page calls host.${n}, which the protocol lacks`);
  assert.ok(used.overlay.size > 30 && used.settings.size >= 8);
});

// --- calls ---------------------------------------------------------------------------------------------------------------

test('a good call of every command passes: the handler gets the preload\'s value, from its own window', () => {
  assert.deepEqual(Object.keys(GOOD).sort(), [...new Set(names(COMMANDS))].sort(), 'a good call for every command');
  for (const c of COMMANDS) {
    const { calls, dispatch } = stubbed();
    const answer = dispatch.handle(c.name, GOOD[c.name], senderOf(c));
    assert.equal(calls.length, 1, c.name);
    assert.equal(calls[0].channel, c.channel);
    assert.equal(calls[0].sender, senderOf(c));
    assert.equal(answer, `answer:${c.channel}`);
    const expected = c.name in PAYLOAD ? PAYLOAD[c.name] : c.pack === 'none' ? undefined : GOOD[c.name][0];
    assert.deepEqual(calls[0].payload, expected, c.name);
    // and by channel, with the value the preload sends
    const again = stubbed();
    again.dispatch.handleChannel(c.channel, expected, senderOf(c));
    assert.deepEqual(again.calls[0].payload, expected, `${c.channel} by channel`);
  }
});

// a value of the wrong kind for a schema
function wrongFor(schema) {
  if (schema.type === 'string') return schema.max != null && schema.enum == null ? 'x'.repeat(schema.max + 1) : 42;
  if (schema.type === 'number') return 'nope';
  if (schema.type === 'array') return 'nope';
  if (schema.type === 'object') return 'nope';
  return undefined;
}

test('wrong arguments are turned down with a clear error, whatever the command', () => {
  let tried = 0;
  for (const c of COMMANDS) {
    const { calls, dispatch } = stubbed();
    const bad = [];
    // too many
    bad.push([...GOOD[c.name], 'extra', 'extra', 'extra']);
    c.params.forEach((p, i) => {
      if (p.coerce) return; // whatever it is, it becomes true or false
      const args = GOOD[c.name].slice();
      // the wrong kind
      args[i] = wrongFor(p);
      if (args[i] !== undefined) bad.push(args);
      // a string too long, an enum outside
      if (p.type === 'string' && p.max != null) bad.push(Object.assign(GOOD[c.name].slice(), { [i]: 'x'.repeat(p.max + 1) }));
      if (p.enum) bad.push(Object.assign(GOOD[c.name].slice(), { [i]: 'not-in-the-list' }));
      // missing
      if (!p.optional) bad.push(GOOD[c.name].slice(0, i));
      // null for what is not nullable
      bad.push(Object.assign(GOOD[c.name].slice(), { [i]: null }));
      // an object's properties
      if (p.type === 'object') {
        for (const [key, prop] of Object.entries(p.props || {})) {
          const broken = { ...GOOD[c.name][i] };
          if (prop.required) {
            delete broken[key];
            bad.push(Object.assign(GOOD[c.name].slice(), { [i]: broken }));
          }
          const w = wrongFor(prop);
          if (w !== undefined) bad.push(Object.assign(GOOD[c.name].slice(), { [i]: { ...GOOD[c.name][i], [key]: w } }));
        }
      }
      // an array of what it should not hold
      if (p.type === 'array' && p.items) bad.push(Object.assign(GOOD[c.name].slice(), { [i]: [42] }));
    });
    for (const args of bad) {
      tried++;
      assert.throws(() => dispatch.handle(c.name, args, senderOf(c)), (err) => err instanceof ProtocolError && err.code === 'invalid' && err.message.includes(c.name) && err.command === c.name, `${c.name}(${JSON.stringify(args).slice(0, 80)}) should be turned down`);
    }
    // args that are no array at all
    refusal(() => dispatch.handle(c.name, 'nope', senderOf(c)), 'invalid');
    assert.equal(calls.length, 0, `${c.name}: a refused call reached the handler`);
  }
  assert.ok(tried > 150);
});

test('the same on a channel: a payload of the wrong kind is turned down before the handler', () => {
  for (const c of COMMANDS.filter((x) => x.params.length && !x.params[0].coerce)) {
    const { calls, dispatch } = stubbed();
    refusal(() => dispatch.handleChannel(c.channel, c.pack === 'object' ? 'nope' : wrongFor(c.params[0]), senderOf(c)), 'invalid');
    refusal(() => dispatch.handleChannel(c.channel, undefined, senderOf(c)), 'invalid');
    assert.equal(calls.length, 0, c.channel);
  }
});

test('booleans are what the preload made of them: any value becomes true or false', () => {
  const { calls, dispatch } = stubbed();
  dispatch.handle('setInteractive', ['yes'], OVERLAY_SENDER);
  dispatch.handle('setInteractive', [], OVERLAY_SENDER);
  dispatch.handle('focusOverlay', [0], OVERLAY_SENDER);
  dispatch.handle('closeApp', ['Spotify'], OVERLAY_SENDER);
  dispatch.handle('openFile', ['/a', 1], OVERLAY_SENDER);
  dispatch.handle('updates.install', ['true'], SETTINGS_SENDER);
  dispatch.handle('updates.install', [], SETTINGS_SENDER);
  assert.deepEqual(calls.map((c) => c.payload), [true, false, false, { name: 'Spotify', force: false }, { file: '/a', reveal: true }, false, false]);
});

test('a command from the other window is refused, and so is one from nowhere: nothing runs', () => {
  for (const c of COMMANDS) {
    const { calls, dispatch } = stubbed();
    const payload = c.name in PAYLOAD ? PAYLOAD[c.name] : c.pack === 'none' ? undefined : GOOD[c.name][0];
    for (const sender of [strangerOf(c), STRANGER, undefined, null]) {
      // (openMenu is a command of both windows: the other window's own is not a refusal)
      const shared = sender === strangerOf(c) && COMMANDS.some((o) => o.name === c.name && o.scope !== c.scope);
      if (!shared) refusal(() => dispatch.handle(c.name, GOOD[c.name], sender), 'forbidden');
      refusal(() => dispatch.handleChannel(c.channel, payload, sender), 'forbidden');
    }
    assert.equal(calls.length, 0, `${c.name} ran for the wrong window`);
  }
  // the overlay can't take any settings:* / updates:* channel, the settings window no overlay channel
  assert.ok(COMMANDS.filter((c) => c.scope === 'settings').length >= 12);
  assert.ok(COMMANDS.filter((c) => c.scope === 'overlay').length >= 50);
});

test('a name two windows share (openMenu) goes to the window\'s own command', () => {
  const { calls, dispatch } = stubbed();
  dispatch.handle('openMenu', [], OVERLAY_SENDER);
  dispatch.handle('openMenu', [], SETTINGS_SENDER);
  assert.deepEqual(calls.map((c) => c.channel), ['menu:open', 'settings:menu']);
});

test('unknown commands and channels are refused, not run', () => {
  const { dispatch } = stubbed();
  refusal(() => dispatch.handle('format', [], OVERLAY_SENDER), 'unknown');
  refusal(() => dispatch.handle('__proto__', [], OVERLAY_SENDER), 'unknown');
  refusal(() => dispatch.handle('constructor', [], OVERLAY_SENDER), 'unknown');
  refusal(() => dispatch.handleChannel('shell:exec', {}, OVERLAY_SENDER), 'unknown');
  refusal(() => dispatch.handleChannel('constructor', {}, OVERLAY_SENDER), 'unknown');
});

test('a protocol command whose handler is missing is refused, and audit says so', () => {
  const dispatch = createDispatcher({ handlers: { on: {}, handle: { 'config:get': () => 1, 'ghost:x': () => 1 } }, scopeOf });
  refusal(() => dispatch.handle('rearm', [], OVERLAY_SENDER), 'unknown');
  const audit = dispatch.audit();
  assert.ok(audit.missing.includes('overlay:rearm'));
  assert.deepEqual(audit.extra, ['ghost:x']);
});

// --- the real core behind the dispatcher -------------------------------------------------------------------------------------

function startCore() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-protocol-'));
  const platform = createFakePlatform({ userData });
  const core = createCore({ platform, smoke: true, watchWindows: () => ({ stop() {}, refresh() {} }) });
  core.start();
  return { core, platform, userData };
}

test('the real core: calls from its own windows work, calls from the other window do not', async () => {
  const { core, platform, userData } = startCore();
  try {
    const overlay = platform.overlays[0].page;
    const settings = core.settings();
    settings.open();
    const window = settings.window().webContents;
    // the overlay's
    assert.equal('apiKeys' in (await core.dispatch.handle('getConfig', [], overlay)), false);
    assert.equal((await core.dispatch.handle('screens', [], overlay)).current, 1);
    const saved = await core.dispatch.handle('setConfig', [{ muted: true }], overlay);
    assert.equal(saved.muted, true);
    assert.equal(core.config.load().muted, true);
    core.dispatch.handle('setInteractive', [true], overlay);
    assert.deepEqual(platform.calls.filter((c) => c.name === 'overlay.clickThrough').at(-1).args, [false]);
    assert.equal(await core.dispatch.handle('webSearch', ['cyber pet'], overlay), true);
    // the settings window's
    assert.ok((await core.dispatch.handle('view', [], window)).sections.length >= 4);
    assert.deepEqual(await core.dispatch.handle('set', [{ volume: 0.31 }], window), { ok: true, status: 'saved' });
    // a settings window asking for an overlay command, the overlay for a settings one
    refusal(() => core.dispatch.handle('setConfig', [{ muted: false }], window), 'forbidden');
    refusal(() => core.dispatch.handle('webSearch', ['x'], window), 'forbidden');
    refusal(() => core.dispatch.handleChannel('config:set', { muted: false }, window), 'forbidden');
    refusal(() => core.dispatch.handle('set', [{ volume: 0.9 }], overlay), 'forbidden');
    refusal(() => core.dispatch.handleChannel('settings:reset', undefined, overlay), 'forbidden');
    refusal(() => core.dispatch.handle('updates.check', [], overlay), 'forbidden');
    refusal(() => core.dispatch.handle('getConfig', [], { id: 'a web page' }), 'forbidden');
    assert.equal(core.config.load().muted, true);
    assert.equal(core.config.load().volume, 0.31);
    // bad arguments from the right window: refused, not run
    refusal(() => core.dispatch.handle('set', ['volume=1'], window), 'invalid');
    refusal(() => core.dispatch.handle('saveKey', ['openai'], window), 'invalid');
    refusal(() => core.dispatch.handle('moveScreen', ['1'], overlay), 'invalid');
    // after the settings window is closed it is nobody
    settings.close();
    refusal(() => core.dispatch.handle('view', [], window), 'forbidden');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the core\'s raw handlers (core.ipc) are the same ones, kept for the shell and the tests', () => {
  const { core, userData } = startCore();
  try {
    assert.equal(typeof core.ipc.handle['config:get'], 'function');
    assert.equal(typeof core.ipc.on['renderer:ready'], 'function');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
