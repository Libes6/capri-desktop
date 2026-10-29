'use strict';

// The one door of her pages into the core (TAURI-02): handle(name, args, sender). It looks the command
// up in the protocol (src/protocol.js), lets it through only from the window its scope belongs to,
// checks its arguments against the schema, and calls the core's handler of that channel. A refusal is
// a ProtocolError (code 'unknown' | 'forbidden' | 'invalid'), never a crash. A page's call comes in
// by name with the positional arguments (handle), or by channel with the arguments packed in one value
// (handleChannel). Plain JS.

const protocol = require('../protocol');

class ProtocolError extends Error {
  constructor(code, message, command) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.command = command;
  }
}

/**
 * @param {object} deps
 *   handlers: { on, handle }, channel -> fn(payload, sender) (the core's ipc)
 *   scopeOf(sender): 'overlay' | 'settings' | null, which of her windows a message comes from
 *   commands: the protocol's list (the tests pass their own)
 */
function createDispatcher({ handlers, scopeOf, commands = protocol.COMMANDS }) {
  const byName = { overlay: new Map(), settings: new Map() };
  const byChannel = new Map();
  for (const c of commands) {
    byName[c.scope].set(c.name, c);
    byChannel.set(c.channel, c);
  }
  const table = (c) => handlers[c.kind === 'send' ? 'on' : 'handle'];

  function run(c, payload, sender) {
    const from = scopeOf(sender);
    if (from !== c.scope) throw new ProtocolError('forbidden', `${c.channel} is for the ${c.scope} window${from ? `, not the ${from} window` : ''}`, c.channel);
    const fn = table(c)[c.channel];
    if (typeof fn !== 'function') throw new ProtocolError('unknown', `${c.channel} has no handler`, c.channel);
    return fn(payload, sender);
  }

  // By channel, the payload being the one value the handler gets .
  function handleChannel(channel, payload, sender) {
    const c = byChannel.get(channel);
    if (!c) throw new ProtocolError('unknown', `unknown channel ${channel}`, channel);
    const checked = protocol.checkPayload(c, payload);
    if (!checked.ok) throw new ProtocolError('invalid', `${c.channel}: ${checked.error}`, c.channel);
    return run(c, checked.payload, sender);
  }

  // By name (host.js's: 'chatSend', 'updates.check') with the positional arguments (Tauri's bridge).
  // The scope given by the window the call came from, so a name means one command per window.
  function handle(name, args, sender) {
    const from = scopeOf(sender);
    const c = (from && byName[from].get(name)) || byName.overlay.get(name) || byName.settings.get(name);
    if (!c) throw new ProtocolError('unknown', `unknown command ${name}`, name);
    // the name asked in a window that has no such command, but another has: forbidden, not unknown
    if (c.scope !== from) throw new ProtocolError('forbidden', `${name} is for the ${c.scope} window${from ? `, not the ${from} window` : ''}`, name);
    const packed = protocol.packArgs(c, args);
    if (!packed.ok) throw new ProtocolError('invalid', `${name}: ${packed.error}`, name);
    return run(c, packed.payload, sender);
  }

  // handlers the protocol lacks and protocol commands the handlers lack (both should be empty)
  function audit() {
    const have = (kind) => Object.keys(handlers[kind === 'send' ? 'on' : 'handle']);
    const known = (kind) => commands.filter((c) => c.kind === kind).map((c) => c.channel);
    return {
      missing: commands.filter((c) => typeof table(c)[c.channel] !== 'function').map((c) => c.channel),
      extra: [...have('send').filter((ch) => !known('send').includes(ch)), ...have('handle').filter((ch) => !known('handle').includes(ch))],
    };
  }

  return { handle, handleChannel, audit, commands };
}

module.exports = { createDispatcher, ProtocolError };
