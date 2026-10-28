# Capri protocol: commands and events (TAURI-02)

The one description of what her pages say to the core and what the core says back. The source is
[`src/protocol.js`](../src/protocol.js) (plain JS, no Electron); [`docs/protocol.json`](protocol.json) is the same
for the Tauri side (`npm run protocol:export` makes it and the tables below; the tests fail when they are old).

## How a call goes

```
page  -> host.js: host.invoke(name, args)          args = the positional arguments of the call
      -> Electron: preload (packs args into one value) -> IPC channel     | Tauri: host_invoke { scope, name, args }
      -> core.dispatch (src/main/dispatch.js)
           1. the window it comes from has the command's scope?   no: ProtocolError "forbidden"
           2. the arguments fit the schema (types, required, enum, max lengths)?   no: ProtocolError "invalid"
           3. core.ipc.on[channel] / core.ipc.handle[channel](payload, sender)
```

- **scope**: `overlay` (her overlay) or `settings` (her settings window). A command is answered only for its window.
  The dispatcher asks the core which window a sender is (`settings.owns`, `overlay.owns`); a message from anywhere else is `forbidden`.
  `openMenu` is a command of both windows (`menu:open` for the overlay, `settings:menu` for the settings window): the sender picks.
- **kind**: `send` (fire and forget, no answer) or `handle` (the core answers; the call is a promise).
- **name**: what `host.js` calls it (the preload's method: `chatSend`, `updates.check`). **channel**: the Electron IPC name and the core's handler.
- **pack**: how the positional arguments become the one value the handler gets: `none`, `first` (the first argument), or `object`
  (keyed by the parameters' names: `closeApp(name, force)` -> `{ name, force }`, `openFile(file, reveal)` -> `{ file, reveal }`,
  `saveKey(provider, key)` -> `{ provider, key }`). Parameters marked "coerced" become `true`/`false` whatever they were (`Boolean(on)` in the preload);
  `updates.install(confirmed)` is `true` only for `true`.
- **Electron**: `main.js` registers every protocol channel with `core.dispatch.handleChannel(channel, payload, sender)`. A refused
  call is logged (`[capri] refused: ...`); an `invoke` gets the error as a rejected promise, a `send` gets nothing, nothing crashes.
- **Tauri** (TAURI-04): the Rust command `host_invoke { scope, name, args }` goes to the sidecar, which calls
  `core.dispatch.handle(name, args, sender)` with the sender of that window; events go the other way by the channel names below.
  Rust can check its own list of commands against `docs/protocol.json`.
- The handlers keep their own checks (`settings.owns` in `settings:*`, `isReleasePage` in `updates:page`...): the dispatcher is the first door, not the only one.
- Replies are documented, not checked at run time. Arguments the schema does not name (extra keys of an object) pass through.

## Found while comparing core.js, preload.js, settings-preload.js and host.js

- The three agree on the set: 65 channels (`ipc.on`/`ipc.handle` in the core, 53 + 12 in the two preloads, the same in `host.js`) and 11 events; none extra, none missing; `send`/`invoke` match the core's `on`/`handle` for every one.
- `host.js` calls by the preload's **method name**, not the channel (`setConfig` is `config:set`); the same name can be two channels (`openMenu`).
- The preload shaped some arguments (objects from positionals, `Boolean(...)`): the Tauri bridge has to do the same, which is what `pack`/`coerce` say and `dispatch.handle` does.
- The preload named the argument of `searchFiles` `query` while it is the object `{ query, exts }`: renamed `request` (the only change in a preload).
- Before this, only the `settings:*`/`updates:*` handlers checked the sender; the overlay's channels answered anyone with the preload, and a wrong sender got `null` silently. Now a wrong window is refused with an error. Arguments were not checked at all (each handler coerced what it could).
- The settings window's `updates:status` event is `settingsHost.updates.onStatus` (host.js special-cases it).
- Nothing in the renderer called a channel outside the protocol (`tests/protocol.test.js` reads every `host.x(` of the pages).
