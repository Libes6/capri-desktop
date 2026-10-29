'use strict';

// The protocol between her pages and the core (TAURI-02): every command the pages send and every event
// the core sends back, in one place. Plain JS, no requires: the dispatcher (main/dispatch.js), the tests,
// `npm run protocol:export` (docs/protocol.json, read by the Tauri side) and docs/PROTOCOL.md all come from this file.
//
// A command:
//   name     the command as the page calls it: the method of host.js (host.invoke(name, args))
//   channel  the channel name, and the core's handler (core.ipc.on / core.ipc.handle) of that name
//   scope    'overlay' (her overlay) or 'settings' (her settings window): the only window that may call it
//   kind     'send' (fire and forget, the core answers nothing) or 'handle' (the core answers)
//   params   the positional arguments of the call (what host.invoke gets as `args`)
//   pack     how they become the one value the core's handler gets, as host.js does it:
//            'none' (no value), 'first' (args[0]), 'object' (an object keyed by the params' names)
//   reply    the shape of the answer ('handle' only); null: whatever the core answers when it has nothing
//   doc      what it is for
// An event: name (the method a page subscribes with), event (the channel), scope, payload, doc.
//
// A schema (a param, a property, a reply, a payload):
//   type      'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'
//   required  default false for a property, true for a param (a param with `optional: true` may be left out)
//   enum      the only values; max: a string's length or an array's size; min/max for a number too
//   int       a whole number; props: an object's known properties (others are let through); items: an array's
//   coerce    'boolean': whatever is given becomes true/false, as host.js does (Boolean(on)); 'true-only':
//             only `true` counts
//   nullable  null is let through; reply schemas are for the docs and the other side, never checked

const s = (max, extra = {}) => ({ type: 'string', max, ...extra });
const QUERY = 2000; // a search, a name, a song: the core cuts them shorter itself
const bool = { type: 'boolean', coerce: 'boolean', optional: true };
const obj = (props = {}, extra = {}) => ({ type: 'object', props, ...extra });
const ok = obj({ ok: { type: 'boolean' }, error: { type: 'string' } });

const param = (name, schema, doc = '') => ({ name, ...schema, doc });

function command(name, channel, scope, kind, { params = [], pack, reply = null, doc = '' } = {}) {
  return { name, channel, scope, kind, params, pack: pack || (params.length > 1 ? 'object' : params.length ? 'first' : 'none'), reply, doc };
}
const send = (name, channel, scope, options) => command(name, channel, scope, 'send', options);
const handle = (name, channel, scope, options) => command(name, channel, scope, 'handle', options);

const O = 'overlay';
const S = 'settings';

// --- her overlay (host) -------------------------------------------------------------

const OVERLAY_COMMANDS = [
  send('rendererReady', 'renderer:ready', O, { doc: 'The overlay page is up (a reload too): the core sends the power state.' }),
  send('setInteractive', 'overlay:interactive', O, { params: [param('on', bool, 'true: the overlay takes clicks; false: they go through')], doc: 'Click-through off or on, from where the pointer is on her.' }),
  send('rearm', 'overlay:rearm', O, { doc: 'The pointer moved over her and she never heard of it: click-through is armed again.' }),
  handle('cursor', 'overlay:cursor', O, {
    reply: obj({ x: { type: 'number' }, y: { type: 'number' }, inside: { type: 'boolean' }, display: { type: 'number' } }),
    doc: 'The pointer in overlay coordinates, whether it is inside her window, and the display it is on.',
  }),
  handle('screens', 'screens:list', O, {
    reply: obj({
      current: { type: 'number' },
      origin: obj({ x: { type: 'number' }, y: { type: 'number' } }),
      list: { type: 'array', items: obj({ id: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }) },
    }),
    doc: 'Your screens (their bounds), the one she is on, and where her window is.',
  }),
  handle('moveScreen', 'screens:move', O, {
    params: [param('id', { type: 'number', int: true }, 'the display id from screens')],
    reply: obj({ origin: obj({ x: { type: 'number' }, y: { type: 'number' } }), width: { type: 'number' }, height: { type: 'number' }, gap: { type: 'number' } }, { nullable: true }),
    doc: 'Her window goes to that screen; null when there is no such screen.',
  }),
  handle('getConfig', 'config:get', O, { reply: obj({ keys: { type: 'array' } }), doc: 'Her config as the overlay sees it (API keys left out, `keys`: the providers that have one).' }),
  handle('setConfig', 'config:set', O, { params: [param('patch', obj(), 'the keys to change')], reply: obj(), doc: 'Saves a part of the config, answers the new config (the overlay is sent capri:config too).' }),
  handle('listSounds', 'sounds:list', O, { reply: { type: 'array', items: obj({ name: { type: 'string' }, url: { type: 'string' } }) }, doc: 'Your own sounds (the sounds folder of her data).' }),
  handle('hooksStatus', 'hooks:status', O, { reply: obj(), doc: 'Whether the assistant\'s hooks are installed.' }),
  handle('demoWindow', 'demo:window', O, { params: [param('open', bool)], reply: { type: 'boolean' }, doc: 'Opens or closes the demo terminal she perches on; false when windows are not tracked.' }),
  send('openMenu', 'menu:open', O, { doc: 'Right-clicking her: the tray\'s menu where the pointer is.' }),
  handle('installHooks', 'hooks:install', O, { reply: obj(), doc: 'Installs the assistant\'s hooks (her welcome panel).' }),
  handle('claudeFound', 'claude:found', O, { reply: { type: 'boolean' }, doc: 'Whether Claude Code\'s folder exists.' }),
  send('openClaudeHelp', 'claude:help', O, { doc: 'Opens the assistant\'s help page in the browser.' }),
  handle('windowsNow', 'windows:get', O, { reply: obj({}, { nullable: true }), doc: 'The last windows update (what the watcher saw), null before the first.' }),
  handle('trayPlace', 'guide:tray', O, { reply: obj({ icon: obj({}, { nullable: true }), corner: obj() }), doc: 'Where her tray icon is, in overlay coordinates, and the corner by the clock.' }),
  handle('openClaudeFolder', 'guide:claudeFolder', O, { reply: obj({ found: { type: 'boolean' }, dir: { type: 'string' }, file: { type: 'boolean' }, label: { type: 'string' } }), doc: 'Shows Claude Code\'s folder, its settings file selected.' }),
  handle('copyImage', 'panel:copy', O, {
    params: [param('rect', obj({ x: { type: 'number', required: true }, y: { type: 'number', required: true }, width: { type: 'number', required: true }, height: { type: 'number', required: true } }), 'the part of the overlay, in pixels')],
    reply: { type: 'boolean' },
    doc: 'A picture of that part of the overlay, on the clipboard.',
  }),
  handle('chatStatus', 'chat:status', O, { reply: obj({ ok: { type: 'boolean' }, error: { type: 'string' }, code: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, agent: { type: 'boolean' }, local: { type: 'boolean' }, warmup: { type: 'boolean' } }), doc: 'Is the AI there, with a model to talk with.' }),
  handle('chatSend', 'chat:send', O, {
    params: [param('request', obj({
      id: s(100, { required: true }),
      messages: { type: 'array', required: true, max: 500, items: obj({ role: s(20, { required: true, enum: ['system', 'user', 'assistant'] }), content: s(200000, { required: true }) }) },
    }), 'a turn: its id, the conversation')],
    reply: obj({ ok: { type: 'boolean' }, text: { type: 'string' }, error: { type: 'string' }, code: { type: 'string', nullable: true } }),
    doc: 'Her answer; it is streamed to the overlay as chat:delta { id, text } meanwhile.',
  }),
  send('chatStop', 'chat:stop', O, { params: [param('id', s(100), 'the turn to stop')], doc: 'Stops that chat turn.' }),
  handle('chatMemory', 'chat:memory', O, { reply: { type: 'array' }, doc: 'The remembered conversation.' }),
  send('chatRemember', 'chat:remember', O, { params: [param('history', { type: 'array', max: 500 }, 'the conversation')], doc: 'Remembers the conversation.' }),
  handle('lookSnap', 'look:snap', O, { reply: obj({ ok: { type: 'boolean' }, id: { type: 'string' }, error: { type: 'string' } }), doc: 'Takes a picture of your screen; the id stands for 2 minutes.' }),
  handle('lookSay', 'look:say', O, {
    params: [param('request', obj({
      id: s(100, { required: true }),
      persona: s(100000),
      prompt: s(100000, { required: true }),
      history: { type: 'array', max: 500 },
    }), 'the picture\'s id and what to ask about it')],
    reply: obj({ ok: { type: 'boolean' }, text: { type: 'string' }, model: { type: 'string' }, code: { type: 'string' }, error: { type: 'string' } }),
    doc: 'What her AI says about the picture.',
  }),
  handle('lookWhere', 'look:where', O, { reply: obj({ local: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' } }), doc: 'Where her AI runs, for what she says before she looks.' }),
  handle('cpu', 'pc:cpu', O, { reply: { type: 'number', nullable: true }, doc: 'How hard the processor works, in %, since the last call (null the first time).' }),
  send('openOllama', 'chat:ollama', O, { doc: 'Opens the Ollama site.' }),
  handle('setupInfo', 'setup:info', O, { reply: obj({ models: { type: 'array' }, cloud: { type: 'array' }, ram: { type: 'number' }, keyed: { type: 'array' } }), doc: 'What the setup offers.' }),
  handle('ollamaState', 'setup:ollama', O, { reply: obj(), doc: 'Whether Ollama is installed and running.' }),
  handle('installOllama', 'setup:install', O, { reply: obj({ ok: { type: 'boolean' }, unsupported: { type: 'boolean' } }), doc: 'Installs Ollama (progress: setup:progress { kind: "install" }).' }),
  handle('startOllama', 'setup:start', O, { reply: obj(), doc: 'Starts Ollama.' }),
  handle('pullModel', 'setup:pull', O, { params: [param('name', s(200), 'a model of the setup\'s list')], reply: obj({ ok: { type: 'boolean' }, model: { type: 'string' }, error: { type: 'string' } }), doc: 'Fetches a model (progress: setup:progress { kind: "pull" }).' }),
  send('cancelSetup', 'setup:cancel', O, { doc: 'Stops the model being fetched.' }),
  handle('useProvider', 'setup:use', O, {
    params: [param('choice', obj({ provider: s(50, { required: true }), key: s(4096), url: s(2000) }), 'who answers her chat, with its key or address')],
    reply: obj({ ok: { type: 'boolean' }, model: { type: 'string' }, error: { type: 'string' } }),
    doc: 'Saves the provider, tries it, and undoes it if it fails.',
  }),
  send('keyPage', 'setup:keyPage', O, { params: [param('provider', s(50), 'a provider with a key page')], doc: 'Opens the page where that provider\'s key is made.' }),
  handle('launchThroughOllama', 'setup:launch', O, { params: [param('integration', s(50, { enum: ['claude', 'codex'] }))], reply: obj({ ok: { type: 'boolean' }, unsupported: { type: 'boolean' } }), doc: 'Opens an assistant through Ollama (Windows).' }),
  handle('openApps', 'apps:list', O, { reply: { type: 'array', items: obj({ name: { type: 'string' }, label: { type: 'string' } }) }, doc: 'The apps she may close.' }),
  handle('findApp', 'apps:find', O, { params: [param('wanted', s(QUERY))], reply: obj({ name: { type: 'string' }, label: { type: 'string' } }, { nullable: true }), doc: 'The open app that matches what you said.' }),
  handle('closeApp', 'apps:close', O, {
    params: [param('name', s(QUERY)), param('force', bool)],
    reply: obj({ error: { type: 'string' }, unsupported: { type: 'boolean' } }),
    doc: 'Closes an app you confirmed.',
  }),
  handle('findLaunch', 'apps:findLaunch', O, { params: [param('text', s(QUERY))], reply: obj({ kind: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, risky: { type: 'boolean' } }, { nullable: true }), doc: 'An app, a game or a folder that matches what you said.' }),
  handle('launch', 'apps:launch', O, { params: [param('item', obj({ kind: s(50, { required: true }), id: s(4096) }), 'an item findLaunch gave')], reply: ok, doc: 'Opens it (only what findLaunch listed).' }),
  handle('media', 'apps:media', O, { params: [param('action', s(20, { enum: ['pause', 'play', 'next', 'previous', 'volup', 'voldown', 'mute'] }))], reply: { type: 'boolean' }, doc: 'A media key (Windows).' }),
  handle('music', 'apps:music', O, { params: [param('query', s(QUERY))], reply: { type: 'boolean' }, doc: 'A Spotify search.' }),
  handle('youtube', 'apps:youtube', O, { params: [param('query', s(QUERY))], reply: obj({ title: { type: 'string', nullable: true } }, { nullable: true }), doc: 'The song on YouTube in your browser.' }),
  handle('roblox', 'apps:roblox', O, { params: [param('query', s(QUERY))], reply: obj({ name: { type: 'string', nullable: true } }, { nullable: true }), doc: 'The Roblox game, opened.' }),
  handle('searchFiles', 'files:search', O, {
    params: [param('request', obj({ query: s(QUERY), exts: { type: 'array', max: 50, items: s(20) } }), 'a name and/or file types')],
    reply: { type: 'array' },
    doc: 'Your files that match.',
  }),
  handle('openFile', 'files:open', O, {
    params: [param('file', s(4096)), param('reveal', bool, 'show it in its folder instead of opening it')],
    reply: { type: 'boolean' },
    doc: 'Opens a file a search showed.',
  }),
  handle('screenshot', 'files:screenshot', O, { reply: obj({}, { nullable: true }), doc: 'A screenshot saved on your computer.' }),
  handle('webSearch', 'web:search', O, { params: [param('query', s(QUERY))], reply: { type: 'boolean' }, doc: 'A search on the web, in your browser.' }),
  handle('openSite', 'apps:site', O, { params: [param('address', s(QUERY))], reply: { type: 'boolean' }, doc: 'A website (http and https only).' }),
  send('focusOverlay', 'overlay:focus', O, { params: [param('on', bool, 'true: the overlay takes the keyboard (the chat); false: gives it back')], doc: 'The overlay takes the keyboard while the chat is open.' }),
];

// --- her settings window (settingsHost) --------------------------------------

const SETTINGS_COMMANDS = [
  handle('view', 'settings:view', S, { reply: obj({ title: { type: 'string' }, sections: { type: 'array' } }, { nullable: true }), doc: 'What the window shows (settings-view.js).' }),
  send('ready', 'settings:ready', S, { params: [param('info', obj({ sections: { type: 'number' }, focused: { type: 'any' } }), 'what the page shows once up')], doc: 'The settings page is up (the smoke test waits for it).' }),
  handle('set', 'settings:set', S, {
    params: [param('patch', obj(), 'the fields to change; the core checks every key and type')],
    reply: obj({ ok: { type: 'boolean' }, status: { type: 'string' }, error: { type: 'string' }, fields: { type: 'object' } }),
    doc: 'Saves a change.',
  }),
  handle('saveKey', 'settings:key', S, {
    params: [param('provider', s(50)), param('key', s(4096))],
    reply: obj({ ok: { type: 'boolean' }, status: { type: 'string' }, field: { type: 'string' }, error: { type: 'string' } }),
    doc: 'A new API key: sent, sealed, never read back.',
  }),
  handle('reset', 'settings:reset', S, { reply: obj({ ok: { type: 'boolean' } }), doc: 'Back to the defaults.' }),
  send('restart', 'settings:restart', S, { doc: 'Restarts her.' }),
  send('openMenu', 'settings:menu', S, { doc: 'Her menu over the settings window.' }),
  send('close', 'settings:close', S, { doc: 'Closes the window.' }),
  handle('updates.check', 'updates:check', S, { reply: obj(), doc: 'Looks for an update; answers the update view.' }),
  handle('updates.download', 'updates:download', S, { reply: obj(), doc: 'Downloads the update offered.' }),
  handle('updates.install', 'updates:install', S, {
    params: [param('confirmed', { type: 'boolean', coerce: 'true-only', optional: true }, 'the window asked and you said yes')],
    reply: obj(),
    doc: 'Installs the downloaded update and restarts, once confirmed in the window.',
  }),
  send('updates.page', 'updates:page', S, { doc: 'Opens the release page (only this repository\'s).' }),
];

const COMMANDS = [...OVERLAY_COMMANDS, ...SETTINGS_COMMANDS];

// --- the events of the core to her pages --------------------------------------------------------------------

const event = (name, channel, scope, payload, doc) => ({ name, event: channel, scope, payload, doc });

const EVENTS = [
  event('onClaudeEvent', 'claude:event', O, obj({ session_id: { type: 'string' } }), 'An assistant\'s hook event (what the bridge took).'),
  event('onCommand', 'capri:command', O, obj({ name: { type: 'string', required: true } }), 'The core tells her to do something: { name, ...details } (status, stow, screens, goScreen, watchScreen, hooks, update ...).'),
  event('onConfig', 'capri:config', O, obj(), 'The config changed (without the keys).'),
  event('onResize', 'overlay:resize', O, obj({ width: { type: 'number' }, height: { type: 'number' }, gap: { type: 'number' } }), 'Her window was fitted again.'),
  event('onWindows', 'windows:update', O, obj(), 'The windows watcher\'s news ({ fg, wins, ... }).'),
  event('onPower', 'power:state', O, obj({ away: { type: 'boolean' }, why: { type: 'string' } }), 'Away (screen locked or asleep) or back.'),
  event('onChatDelta', 'chat:delta', O, obj({ id: { type: 'string' }, text: { type: 'string' } }), 'A piece of her answer to chatSend.'),
  event('onSetupProgress', 'setup:progress', O, obj({ kind: { type: 'string', enum: ['install', 'pull'] } }), 'The progress of an Ollama install or a model fetch.'),
  event('onView', 'settings:view', S, obj({ title: { type: 'string' }, sections: { type: 'array' } }), 'The window shows another view (the config or her language changed).'),
  event('onSection', 'settings:section', S, { type: 'string' }, 'A section asked from outside (her menu\'s "Update available").'),
  event('updates.onStatus', 'updates:status', S, obj({ kind: { type: 'string' } }), 'The updater\'s status.'),
];

const SCOPES = ['overlay', 'settings'];

const byName = (scope) => new Map(COMMANDS.filter((c) => c.scope === scope).map((c) => [c.name, c]));

// --- validation -----------------------------------------------------------------------------------------

// Why `value` is not a `schema` (a string), or null when it is. `path` names it in the message.
function check(schema, value, path) {
  if (value === undefined || value === null) {
    if (value === null && schema.nullable) return null;
    return schema.required === false || schema.optional ? null : `${path} is required`;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.max != null && value.length > schema.max) return `${path} is longer than ${schema.max}`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
      if (schema.int && !Number.isInteger(value)) return `${path} must be a whole number`;
      if (schema.min != null && value < schema.min) return `${path} is below ${schema.min}`;
      if (schema.max != null && value > schema.max) return `${path} is above ${schema.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.max != null && value.length > schema.max) return `${path} has more than ${schema.max} items`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const why = check({ ...schema.items, required: true }, value[i], `${path}[${i}]`);
          if (why) return why;
        }
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
      for (const [key, prop] of Object.entries(schema.props || {})) {
        const why = check({ ...prop, required: prop.required === true }, value[key], `${path}.${key}`);
        if (why) return why;
      }
      return null;
    }
    default:
      return null;
  }
}

function coerce(schema, value) {
  if (schema.coerce === 'boolean') return Boolean(value);
  if (schema.coerce === 'true-only') return value === true;
  return value;
}

// The positional args of a call checked against the params (coerced ones turned into what the preload
// sends); { ok: true, payload } with the one value the core's handler gets, or { ok: false, error }.
function packArgs(command, args) {
  if (args === undefined || args === null) args = [];
  if (!Array.isArray(args)) return { ok: false, error: 'args must be an array' };
  if (args.length > command.params.length) return { ok: false, error: `${command.name} takes ${command.params.length} argument(s), got ${args.length}` };
  const values = command.params.map((p, i) => {
    const value = p.coerce ? coerce(p, args[i]) : args[i];
    return value;
  });
  for (let i = 0; i < command.params.length; i++) {
    const p = command.params[i];
    const why = check({ ...p, required: !p.optional }, values[i], p.name);
    if (why) return { ok: false, error: why };
  }
  if (command.pack === 'none') return { ok: true, payload: undefined };
  if (command.pack === 'first') return { ok: true, payload: values[0] };
  return { ok: true, payload: Object.fromEntries(command.params.map((p, i) => [p.name, values[i]])) };
}

// The one value a channel carries (already packed in one value) against the same params.
function checkPayload(command, payload) {
  if (command.pack === 'none') return { ok: true, payload: undefined };
  if (command.pack === 'first') {
    const p = command.params[0];
    const value = p.coerce ? coerce(p, payload) : payload;
    const why = check({ ...p, required: !p.optional }, value, p.name);
    return why ? { ok: false, error: why } : { ok: true, payload: value };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'the payload must be an object' };
  const out = { ...payload };
  for (const p of command.params) {
    const value = p.coerce ? coerce(p, payload[p.name]) : payload[p.name];
    const why = check({ ...p, required: !p.optional }, value, p.name);
    if (why) return { ok: false, error: why };
    if (p.coerce) out[p.name] = value;
  }
  return { ok: true, payload: out };
}

const byChannel = new Map(COMMANDS.map((c) => [c.channel, c]));

module.exports = { COMMANDS, EVENTS, SCOPES, byName, byChannel, check, packArgs, checkPayload };
