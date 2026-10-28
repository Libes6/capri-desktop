'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Her initiative (initiative.js): how often her optional lines come, the lines she said lately, and
// what always comes whatever the level (errors, permission prompts, answers, the battery running out).
const url = (file) => pathToFileURL(path.resolve(__dirname, '../src/renderer/js', file)).href;
const load = async () => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} }); // util.js reads it on import
  const [initiative, { Brain }, { Pc }] = await Promise.all([import(url('initiative.js')), import(url('brain.js')), import(url('pc.js'))]);
  return { ...initiative, Brain, Pc };
};

// a clock moved by hand, and dice that go round a fixed sequence
const clock = (t = 0) => ({ now: () => t, add: (ms) => { t += ms; } });
const dice = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('recent lines: never the same one twice in a row, every line before one comes back', async () => {
  const { Recent } = await load();
  for (const roll of [0, 0.5, 0.999]) {
    const recent = new Recent({ rng: () => roll });
    const list = ['a', 'b', 'c', 'd'];
    const said = Array.from({ length: 40 }, () => recent.pick(list));
    for (let i = 1; i < said.length; i++) assert.notEqual(said[i], said[i - 1], `roll ${roll} at ${i}`);
    for (let i = 0; i + 4 <= said.length; i += 4) assert.deepEqual([...said.slice(i, i + 4)].sort(), list, `roll ${roll}`);
  }
});

test('recent lines: a list of one is said as it is, a list of two alternates, an empty list gives nothing', async () => {
  const { Recent } = await load();
  const recent = new Recent({ rng: () => 0 });
  assert.deepEqual([recent.pick(['only']), recent.pick(['only']), recent.pick(['only'])], ['only', 'only', 'only']);
  assert.deepEqual(Array.from({ length: 5 }, () => recent.pick(['x', 'y'])), ['x', 'y', 'x', 'y', 'x']);
  assert.equal(recent.pick([]), undefined);
  assert.equal(recent.pick(undefined), undefined);
});

test('recent lines: lines from other lists count too, and only so many are kept', async () => {
  const { Recent } = await load();
  const recent = new Recent({ size: 3, rng: () => 0 });
  recent.pick(['hi']);
  assert.equal(recent.pick(['hi', 'yo']), 'yo'); // "hi" was just said from another list
  for (const l of ['p', 'q', 'r']) recent.pick([l]);
  assert.equal(recent.said.size, 3);
  assert.equal(recent.pick(['hi', 'yo']), 'hi'); // both forgotten by now: the first fresh one
});

// The same reproducible half hour for each level: something to remark on every 5 s (the satellite
// by chance, the PC, how Claude's job goes, nothing going on).
function halfHour(Initiative, level) {
  const c = clock();
  const ini = new Initiative({ level, now: c.now, rng: dice([0.1, 0.5, 0.3, 0.9, 0.2, 0.7]) });
  const shown = { ambient: 0, pc: 0, progress: 0, idle: 0 };
  const kinds = Object.keys(shown);
  for (let i = 0; i < 360; i++) {
    c.add(5000);
    const kind = kinds[i % kinds.length];
    if (kind === 'ambient' && !ini.chance(0.4)) continue;
    if (ini.offer(kind, () => true)) shown[kind] += 1;
  }
  return shown;
}

test('initiative: quiet says less than normal, normal less than active, on the same events', async () => {
  const { Initiative } = await load();
  const total = (s) => Object.values(s).reduce((a, b) => a + b, 0);
  const quiet = halfHour(Initiative, 'quiet');
  const normal = halfHour(Initiative, 'normal');
  const active = halfHour(Initiative, 'active');
  assert.ok(total(quiet) < total(normal), `${total(quiet)} < ${total(normal)}`);
  assert.ok(total(normal) < total(active), `${total(normal)} < ${total(active)}`);
  assert.deepEqual({ ambient: quiet.ambient, progress: quiet.progress, idle: quiet.idle }, { ambient: 0, progress: 0, idle: 0 });
  assert.equal(quiet.pc, 2); // once every 15 minutes
  assert.equal(normal.idle, 0); // something of her own with nothing going on: only when active
  assert.ok(active.idle >= 5);
  // the same events give the same result: nothing left to chance but the dice given
  assert.deepEqual(halfHour(Initiative, 'active'), active);
});

test('initiative: cooldowns per kind and the gap between any two lines', async () => {
  const { Initiative, COOLDOWNS, GAPS } = await load();
  const c = clock(1e6);
  const ini = new Initiative({ level: 'normal', now: c.now });
  assert.equal(ini.offer('pc', () => true), true);
  assert.equal(ini.allow('pc'), false);
  assert.equal(ini.allow('session'), false); // right after another line: the gap
  c.add(GAPS.normal);
  assert.equal(ini.allow('session'), true);
  assert.equal(ini.allow('pc'), false);
  c.add(COOLDOWNS.pc.normal - GAPS.normal);
  assert.equal(ini.allow('pc'), true);
  // the panel didn't take it: nothing counted
  assert.equal(ini.offer('pc', () => false), false);
  assert.equal(ini.allow('pc'), true);
  // a level it doesn't know is normal; an unknown kind is never said
  ini.level = 'loud';
  assert.equal(ini.level, 'normal');
  assert.equal(ini.allow('nonsense'), false);
  // "every 20 tool calls" by level
  assert.deepEqual(['quiet', 'normal', 'active'].map((level) => new Initiative({ level }).every(20)), [Infinity, 20, 10]);
});

test('initiative: never over her chat, her guide, an answer, a prompt or a reminder', async () => {
  const { Initiative, occupied } = await load();
  const panel = { visible: true, current: { kind: 'idle' } };
  const world = { panel, chat: { open: false }, guide: { running: false }, capri: { mode: 'idle' } };
  const ini = new Initiative({ level: 'active', now: clock(1e6).now, busy: () => occupied(world) });
  assert.equal(ini.allow('ambient'), true);
  for (const current of [{ kind: 'done', reply: 'All done.' }, { kind: 'report', report: {} }, { kind: 'chat', chat: {} },
    { kind: 'alert' }, { kind: 'remind', actions: [{ id: 'done' }] }, { kind: 'error' }, { kind: 'info', guide: true }]) {
    panel.current = current;
    assert.equal(ini.allow('ambient'), false, JSON.stringify(current));
  }
  panel.visible = false; // gone: free again
  assert.equal(ini.allow('ambient'), true);
  world.chat.open = true;
  assert.equal(ini.allow('ambient'), false);
  world.chat.open = false;
  world.guide.running = true;
  assert.equal(ini.allow('ambient'), false);
  world.guide.running = false;
  world.capri.mode = 'alert';
  assert.equal(ini.allow('idle'), false);
});

// Brain with everything around it stubbed: what she says to the panel, in order.
async function brainAt(level, busy = null) {
  const { Brain, Initiative } = await load();
  const said = [];
  const panel = {
    current: null, tickerAction: null,
    say: (msg) => (said.push(msg), true), setTicker() {}, clearKind() {}, hide() {}, updateLog() {},
  };
  const capri = new Proxy({ windows: { fg: null, wins: [] }, mode: 'idle', stowed: false, towardCenter: () => 1, spot: () => ({}),
    celebrate: ({ onSpeak }) => onSpeak(), teleport: async () => true, toPointer: async () => null, canPoint: () => false }, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  const host = { cursor: async () => null };
  const brain = new Brain({ capri, panel, voice: { play() {} }, host, mission: null, lang: 'en' });
  const c = clock(1e6);
  brain.initiative = new Initiative({ level, now: c.now, busy });
  return { brain, said, clock: c };
}

const SESSION = 's1';
const sequence = [
  { hook_event_name: 'SessionStart', session_id: SESSION, cwd: '/tmp/demo', source: 'startup' },
  ...Array.from({ length: 40 }, (_, i) => ({ hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Read', tool_input: { file_path: `/f${i}.js` } })),
  { hook_event_name: 'PostToolUseFailure', session_id: SESSION, tool_name: 'Bash', error: 'Exit code 1\nboom' },
  { hook_event_name: 'Notification', session_id: SESSION, notification_type: 'permission_prompt', message: 'Allow Bash?' },
  { hook_event_name: 'PreCompact', session_id: SESSION },
  { hook_event_name: 'Stop', session_id: SESSION, last_assistant_message: 'Done.' },
  { hook_event_name: 'SessionEnd', session_id: SESSION },
];

// two seconds between events
async function play({ brain, clock: c }) {
  for (const evt of sequence) {
    c.add(2000);
    await brain.handle(evt);
  }
}

test('brain: quiet drops hello, progress, compaction and bye, never errors, prompts or the answer', async () => {
  const at = await brainAt('quiet');
  await play(at);
  const { said } = at;
  assert.deepEqual(said.map((m) => m.kind), ['error', 'alert', 'done']);
  assert.equal(said[2].quote, 'Done.');
});

test('brain: normal says how the job goes every 20 tool calls, active more often', async () => {
  const kinds = async (level) => {
    const at = await brainAt(level);
    await play(at);
    return at.said.map((m) => m.kind);
  };
  const normal = await kinds('normal');
  const active = await kinds('active');
  for (const k of ['error', 'alert', 'done']) {
    assert.ok(normal.includes(k), `normal ${k}`);
    assert.ok(active.includes(k), `active ${k}`);
  }
  assert.equal(normal[0], 'info'); // hello to the session
  const work = (kinds) => kinds.filter((k) => k === 'work').length;
  assert.equal(work(normal), 1); // at 20 tool calls; at 40 the cooldown holds it back
  assert.equal(work(active), 2); // at 10 and 30; 20 and 40 come too soon after
  assert.ok(active.length > normal.length);
});

test('brain: progress lines come every 20 tool calls (normal) or every 10 (active) as time passes', async () => {
  for (const [level, expected] of [['quiet', 0], ['normal', 3], ['active', 6]]) {
    const { brain, said, clock: c } = await brainAt(level);
    for (let i = 0; i < 60; i++) {
      c.add(10000);
      brain.handle({ hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Read', tool_input: {} });
    }
    assert.equal(said.filter((m) => m.kind === 'work').length, expected, level);
  }
});

test('brain: with her chat open, her optional lines wait, a permission prompt still comes', async () => {
  const { brain, said } = await brainAt('active', () => true);
  await brain.handle(sequence[0]); // hello: not over the chat
  await brain.handle({ hook_event_name: 'Notification', session_id: SESSION, notification_type: 'permission_prompt', message: 'Allow?' });
  assert.deepEqual(said.map((m) => m.kind), ['alert']);
});

test('brain: the line when you click her never comes twice in a row', async () => {
  const { brain, said } = await brainAt('quiet');
  for (let i = 0; i < 12; i++) brain.status();
  const lines = said.map((m) => m.line);
  assert.equal(said.length, 12); // an answer to your click: whatever the level
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1]);
});

test('pc: the battery running out comes whatever the level, the charger waits its turn', async () => {
  const { Pc, Initiative } = await load();
  const said = [];
  const realInterval = globalThis.setInterval;
  globalThis.window ??= { addEventListener() {} };
  globalThis.setInterval = () => 0; // its timers aren't part of this test
  let pc;
  try {
    pc = new Pc({
      capri: { mode: 'idle', free: true, wake() {}, recharge() {}, drain() {}, hurt() {} },
      panel: { visible: false, say: (msg) => (said.push(msg.line), true) },
      brain: { t: { pc: { charging: ['Charging.'], unplugged: ['Unplugged.'], low: ['Low {level}.'], critical: ['Critical {level}.'] } } },
      host: {}, voice: { play() {} }, chat: { open: false }, guide: { running: false },
    });
  } finally {
    globalThis.setInterval = realInterval;
  }
  const c = clock(1e6);
  pc.initiative = new Initiative({ level: 'quiet', now: c.now });
  pc.initiative.mark('pc'); // she just said something about your PC
  pc.charging = false;
  await pc.battery({ level: 0.5, charging: true });
  assert.deepEqual(said, []);
  await pc.battery({ level: 0.04, charging: false });
  assert.deepEqual(said, ['Critical 4.']);
});

// CAPRI-05 review: what the tests above left out

test('initiative: a level changed at run time applies at once, its waits kept', async () => {
  const { Initiative, COOLDOWNS } = await load();
  const c = clock(1e6);
  const ini = new Initiative({ level: 'normal', now: c.now });
  ini.delay('idle'); // as app.js does at start
  assert.equal(ini.allow('idle'), false); // normal: never
  ini.level = 'active';
  assert.equal(ini.allow('idle'), false); // not right as she comes online
  c.add(COOLDOWNS.idle.active);
  assert.equal(ini.offer('idle', () => true), true);
  ini.level = 'quiet';
  c.add(COOLDOWNS.idle.active);
  assert.equal(ini.allow('idle'), false);
  ini.level = 'loud'; // unknown: normal
  assert.equal(ini.level, 'normal');
  ini.level = undefined;
  assert.equal(ini.level, 'normal');
});

test('initiative: a line the panel refused counts for nothing', async () => {
  const { Initiative } = await load();
  const ini = new Initiative({ level: 'normal', now: clock(1e6).now });
  assert.equal(ini.offer('pc', () => false), false);
  assert.equal(ini.allow('pc'), true);
  assert.equal(ini.allow('ambient'), true); // nor did it start the gap
  assert.equal(ini.offer('pc', () => undefined), true); // anything but false: shown
  assert.equal(ini.allow('pc'), false);
});

test('brain: quiet still says an interruption, Claude waiting for you, a crash, a notification', async () => {
  const { brain, said } = await brainAt('quiet');
  await brain.handle({ hook_event_name: 'SessionStart', session_id: SESSION, cwd: '/tmp/demo', source: 'startup' });
  await brain.handle({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: 'go' });
  await brain.handle({ hook_event_name: 'PostToolUseFailure', session_id: SESSION, tool_name: 'Bash', is_interrupt: true });
  await brain.handle({ hook_event_name: 'Notification', session_id: SESSION, notification_type: 'idle_prompt' });
  await brain.handle({ hook_event_name: 'Notification', session_id: SESSION, message: 'Something to read' });
  await brain.handle({ hook_event_name: 'StopFailure', session_id: SESSION, error: 'rate limited' });
  await brain.handle({ hook_event_name: 'Interrupt', session_id: SESSION });
  assert.deepEqual(said.map((m) => m.kind), ['work', 'info', 'info', 'info', 'error', 'info']);
  assert.equal(said[3].line, 'Something to read');
});

test('brain: her language changed at run time, her click lines follow it and still never repeat', async () => {
  const { brain, said } = await brainAt('normal');
  for (let i = 0; i < 4; i++) brain.status();
  brain.lang = 'ru';
  for (let i = 0; i < 6; i++) brain.status();
  const ru = said.slice(4).map((m) => m.line);
  const ruIdle = new Set(brain.t.idle.map((l) => l.replace('{name}', 'choom')));
  const ruClose = new Set((brain.t.bond.idle[0] || []).map((l) => l.replace('{name}', 'choom')));
  for (const l of ru) assert.ok(ruIdle.has(l) || ruClose.has(l), l);
  const lines = said.map((m) => m.line);
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1]);
});

test('settings: the tray reads an unknown initiative as normal, like her settings window', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tray-menu.js'), 'utf8');
  assert.match(src, /\['quiet', 'active'\]\.includes\(cfg\.initiative\) \? cfg\.initiative : 'normal'/);
});
