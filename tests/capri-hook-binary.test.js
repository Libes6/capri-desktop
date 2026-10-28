'use strict';
// The Rust capri-hook binary must send the bridge exactly what the JS hooks send.
// Skipped when the binary is not built: cargo build --release --manifest-path crates/capri-hook/Cargo.toml
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const exe = process.platform === 'win32' ? 'capri-hook.exe' : 'capri-hook';
const candidates = [
  process.env.CAPRI_HOOK_BIN,
  process.env.CARGO_TARGET_DIR && path.join(process.env.CARGO_TARGET_DIR, 'release', exe),
  path.join(root, 'crates', 'capri-hook', 'target', 'release', exe),
].filter(Boolean);
const BIN = candidates.find((f) => fs.existsSync(f));
const skip = BIN ? false : 'capri-hook binary is not built';

function capture() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      const json = JSON.stringify({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    });
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({ server, bodies, port: server.address().port }));
}

function run(cmd, args, input, port, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, CAPRI_PORT: String(port), ...env }, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (s) => { stdout += s; });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const script = (name) => path.join(root, 'hooks', name);
const KINDS = {
  claude: { js: [script('capri-hook.js')], bin: ['--assistant', 'claude'] },
  codex: { js: [script('capri-codex-hook.js')], bin: ['--assistant', 'codex'] },
};

async function same(t, kind, input, extra = {}) {
  const a = await capture();
  const b = await capture();
  t.after(() => { a.server.close(); b.server.close(); });
  const k = KINDS[kind];
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const js = await run(process.execPath, k.js, raw, a.port, extra);
  const rs = await run(BIN, k.bin, raw, b.port, extra);
  assert.equal(rs.code, 0);
  assert.equal(rs.stdout, js.stdout);
  assert.deepEqual(b.bodies, a.bodies);
  return a.bodies;
}

const base = { session_id: 'shared', cwd: '/project' };
const hookInputs = [
  { hook_event_name: 'UserPromptSubmit', prompt: 'Run tests', ...base },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...base },
  { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { description: 'Allow tests?' }, ...base },
  { hook_event_name: 'PermissionRequest', ...base },
  { hook_event_name: 'PostToolUse', tool_name: 'Bash', ...base },
  { hook_event_name: 'Stop', last_assistant_message: 'Tests passed. ' + 'я'.repeat(7000), ...base },
  { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Update File: a.js\n*** Add File: b.js\r\n*** Delete File:  c.js  \n*** Move File: z' }, ...base },
  { hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'ls -la', workdir: '/x' }, ...base },
  { hook_event_name: 'PreToolUse', tool_name: 'shell_command', tool_input: { command: 'pwd' }, ...base },
  { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which?' }, { title: 'Pick' }, {}] }, ...base },
  { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: {}, ...base },
  { hook_event_name: 'PreCompact', session_id: 7 },
  { hook_event_name: 'SubagentStart', agent_type: 'explorer', unknown_secret: 'drop me', tool_output: 'x'.repeat(5000) },
  { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a.js', content: 'abc😀', old_string: 'x', new_string: 'y', edits: [1, 2, 3], list: Array.from({ length: 12 }, (_, i) => i), deep: { a: { b: { c: { d: 1 } } } }, long: 'é'.repeat(400), emoji: '😀'.repeat(150) }, ...base },
  { hook_event_name: 'PostToolUseFailure', error: 'boom', is_interrupt: true, duration_ms: 12, tool_input: { nested: [[[[1]]]] } },
  { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'tab\tnew\nline "quote" \\ \u0001  ', title: null },
];

for (const kind of ['claude', 'codex']) {
  test(`capri-hook --assistant ${kind} sends what the JS hook sends`, { skip }, async (t) => {
    for (const input of hookInputs) {
      const bodies = await same(t, kind, input);
      assert.equal(bodies.length, 1, JSON.stringify(input).slice(0, 80));
      assert.equal(bodies[0].method, 'POST');
      assert.equal(bodies[0].url, '/event');
      assert.equal(bodies[0].type, 'application/json');
    }
  });

  test(`capri-hook --assistant ${kind} ignores garbage like the JS hook`, { skip }, async (t) => {
    for (const raw of ['invalid', 'null', '[]', '', '   ', '"text"', '5', '﻿{"hook_event_name":"Stop"}', '{"hook_event_name":5}']) {
      const bodies = await same(t, kind, raw);
      if (kind === 'codex') assert.equal(bodies.length, 0, raw);
    }
  });
}

test('capri-hook handles large stdin (1 MiB event)', { skip }, async (t) => {
  const bodies = await same(t, 'claude', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: 'z'.repeat(1024 * 1024), ...base });
  assert.equal(bodies.length, 1);
});

test('capri-hook honours CAPRI_PORT', { skip }, async (t) => {
  const a = await capture();
  t.after(() => a.server.close());
  const r = await run(BIN, ['--assistant', 'claude'], JSON.stringify({ hook_event_name: 'Stop' }), a.port);
  assert.equal(r.code, 0);
  assert.equal(a.bodies.length, 1);
});

// ---- Antigravity ----

async function agySame(t, type, payload) {
  const a = await capture();
  const b = await capture();
  t.after(() => { a.server.close(); b.server.close(); });
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const js = await run(process.execPath, [script('capri-agy-hook.js'), type], raw, a.port);
  const rs = await run(BIN, ['--assistant', 'agy', type], raw, b.port);
  assert.equal(rs.code, 0);
  assert.equal(rs.stdout, js.stdout, `stdout for ${type}`);
  assert.deepEqual(b.bodies, a.bodies, `events for ${type}`);
  return { bodies: a.bodies, stdout: rs.stdout };
}

test('capri-hook --assistant agy matches the JS Antigravity hook', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-hook-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'USER_INPUT', content: 'hi' },
    { type: 'PLANNER_RESPONSE', content: 'first answer' },
    'not json',
    { type: 'PLANNER_RESPONSE', content: `  final answer ${'я'.repeat(7000)} ` },
    { type: 'TOOL', content: 'x' },
  ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const base = { conversationId: 'c1', workspacePaths: ['/project'] };
  const cases = [
    ['SessionStart', base],
    ['SessionStart', {}],
    ['PreInvocation', { ...base, invocationNum: 1, lastUserInput: 'x <USER_REQUEST>\n  fix   the\tbug  </USER_REQUEST> y' }],
    ['PreInvocation', { ...base, lastUserInput: 'plain request ' + 'ж'.repeat(400) }],
    ['PreInvocation', { ...base, invocationNum: 2, lastUserInput: 'again' }],
    ['PreInvocation', base],
    ['PreToolUse', { ...base, toolCall: { name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'run the tests' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'read_file', args: { Path: '/project/a.js' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'view_file', args: { AbsolutePath: '/etc/passwd' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'write_to_file', args: { TargetFile: '/project/../out/x.js', Content: 'héllo😀' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'replace_file_content', args: { TargetFile: '/project/b.js', Target: 'abc', Replacement: 'defgh' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'grep_search', args: { Query: 'needle' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'list_dir', args: {} } }],
    ['PreToolUse', { ...base, toolCall: { name: 'find_by_name', args: { Pattern: '*.rs' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'search_web', args: { query: 'rust' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'read_url_content', args: { Url: 'https://example.com' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'invoke_subagent', args: { Role: 'researcher', TypeName: 'explorer' } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'invoke_subagent', args: {} } }],
    ['PreToolUse', { ...base, toolCall: { name: 'ask_question', args: { questions: [{ question: 'Which one?' }] } } }],
    ['PreToolUse', { ...base, toolCall: { name: 'ask_question', args: {} } }],
    ['PreToolUse', { ...base, toolCall: { name: 'something_new' } }],
    ['PreToolUse', { ...base }],
    ['PreToolUse', {}],
    ['PostToolUse', { ...base, toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }],
    ['PostToolUse', { ...base, error: 'It failed '.repeat(60), toolCall: { name: 'read_file', args: { Path: '/p/x' } } }],
    ['PostToolUse', { ...base, toolCall: { name: 'invoke_subagent', args: { TypeName: 'worker' } } }],
    ['Stop', { ...base, transcriptPath: transcript }],
    ['Stop', { ...base, transcriptPath: path.join(dir, 'missing.jsonl') }],
    ['Stop', base],
    ['Stop', { ...base, terminationReason: 'ERROR' }],
    ['Stop', { ...base, error: 'bad' }],
    ['Unknown', base],
    ['SessionStart', '{broken'],
    ['Stop', '{broken'],
    ['PreToolUse', ''],
    ['PreToolUse', '   '],
  ];
  for (const [type, payload] of cases) {
    const { stdout } = await agySame(t, type, payload);
    const parsed = JSON.parse(stdout);
    if (type === 'PreToolUse') assert.deepEqual(parsed, { decision: 'allow' });
    if (type === 'Stop') assert.deepEqual(parsed, { decision: 'stop' });
  }
  // default hook type when none is given
  const a = await capture();
  t.after(() => a.server.close());
  const r = await run(BIN, ['--assistant', 'agy'], JSON.stringify({ ...base, toolCall: { name: 'run_command', args: { CommandLine: 'x' } } }), a.port);
  assert.deepEqual(JSON.parse(r.stdout), { decision: 'allow' });
  assert.equal(a.bodies.length, 2);
});

test('capri-hook never delays the assistant when Capri is off', { skip }, async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  for (const [args, input, out] of [
    [['--assistant', 'claude'], { hook_event_name: 'Stop' }, ''],
    [['--assistant', 'codex'], { hook_event_name: 'Stop' }, ''],
    [['--assistant', 'agy', 'PreToolUse'], { toolCall: { name: 'run_command', args: { CommandLine: 'x' } } }, '{"decision":"allow"}\n'],
    [['--assistant', 'agy', 'Stop'], {}, '{"decision":"stop"}\n'],
  ]) {
    const started = Date.now();
    const r = await run(BIN, args, JSON.stringify(input), port);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, out);
    assert.ok(Date.now() - started < 1500, `${args.join(' ')} took ${Date.now() - started} ms`);
  }
});

test('capri-hook gives up on a bridge that accepts but never answers', { skip }, async () => {
  const server = net.createServer((s) => { s.on('error', () => {}); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const started = Date.now();
  const r = await run(BIN, ['--assistant', 'claude'], JSON.stringify({ hook_event_name: 'Stop' }), server.address().port);
  server.close();
  assert.equal(r.code, 0);
  assert.ok(Date.now() - started < 2600);
});

test('capri-hook gives up when stdin never closes', { skip }, async () => {
  const child = spawn(BIN, ['--assistant', 'agy', 'Stop'], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (s) => { out += s; });
  const started = Date.now();
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(out, '{"decision":"stop"}\n');
  assert.ok(Date.now() - started < 3000);
});
