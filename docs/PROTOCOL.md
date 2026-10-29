# Capri protocol: commands and events (TAURI-02)

The one description of what her pages say to the core and what the core says back. The source is
[`src/protocol.js`](../src/protocol.js) (plain JS, no requires); [`docs/protocol.json`](protocol.json) is the same
for the Tauri side (`npm run protocol:export` makes it and the tables below; the tests fail when they are old).

## How a call goes

```
page  -> host.js: host.invoke(name, args)          args = the positional arguments of the call
      -> Tauri: host_invoke { scope, name, args }   (host.js packs nothing; the dispatcher packs args into one value)
      -> core.dispatch (src/main/dispatch.js)
           1. the window it comes from has the command's scope?   no: ProtocolError "forbidden"
           2. the arguments fit the schema (types, required, enum, max lengths)?   no: ProtocolError "invalid"
           3. core.ipc.on[channel] / core.ipc.handle[channel](payload, sender)
```

- **scope**: `overlay` (her overlay) or `settings` (her settings window). A command is answered only for its window.
  The dispatcher asks the core which window a sender is (`settings.owns`, `overlay.owns`); a message from anywhere else is `forbidden`.
  `openMenu` is a command of both windows (`menu:open` for the overlay, `settings:menu` for the settings window): the sender picks.
- **kind**: `send` (fire and forget, no answer) or `handle` (the core answers; the call is a promise).
- **name**: what `host.js` calls it (the method of `host.js`: `chatSend`, `updates.check`). **channel**: the core's handler name (`core.ipc.on` / `core.ipc.handle`).
- **pack**: how the positional arguments become the one value the handler gets: `none`, `first` (the first argument), or `object`
  (keyed by the parameters' names: `closeApp(name, force)` -> `{ name, force }`, `openFile(file, reveal)` -> `{ file, reveal }`,
  `saveKey(provider, key)` -> `{ provider, key }`). Parameters marked "coerced" become `true`/`false` whatever they were (`Boolean(on)`);
  `updates.install(confirmed)` is `true` only for `true`.
- **Refusals**: a refused call is logged (`[capri] refused: ...`); an `invoke` gets the error as a rejected promise, a `send` gets nothing, nothing crashes.
- **Tauri** (TAURI-04): the Rust command `host_invoke { scope, name, args }` goes to the sidecar, which calls
  `core.dispatch.handle(name, args, sender)` with the sender of that window; events go the other way by the channel names below.
  Rust can check its own list of commands against `docs/protocol.json`.
- The handlers keep their own checks (`settings.owns` in `settings:*`, `isReleasePage` in `updates:page`...): the dispatcher is the first door, not the only one.
- Replies are documented, not checked at run time. Arguments the schema does not name (extra keys of an object) pass through.

## Notes

- 65 channels (`ipc.on`/`ipc.handle` in the core, 53 overlay + 12 settings, the same set in `host.js`) and 11 events; `send`/`invoke` match the core's `on`/`handle` for every one.
- `host.js` calls by the **method name**, not the channel (`setConfig` is `config:set`); the same name can be two channels (`openMenu`).
- The Tauri bridge shapes the arguments (objects from positionals, `Boolean(...)`): that is what `pack`/`coerce` say and `dispatch.handle` does.
- Only the `settings:*`/`updates:*` handlers once checked the sender; now the dispatcher refuses a wrong window with an error. Arguments are checked against the schema before a handler runs.
- The settings window's `updates:status` event is `settingsHost.updates.onStatus` in `host.js`.
- Nothing in the renderer called a channel outside the protocol (`tests/protocol.test.js` reads every `host.x(` of the pages).

<!-- The tables below are generated: npm run protocol:export. Do not edit them by hand. -->

## Overlay commands (53)

| Command | Channel | Kind | Arguments | Reply | What |
|---|---|---|---|---|---|
| `rendererReady` | `renderer:ready` | send | - | - | The overlay page is up (a reload too): the core sends the power state. |
| `setInteractive` | `overlay:interactive` | send | `on?`: boolean | - | Click-through off or on, from where the pointer is on her. |
| `rearm` | `overlay:rearm` | send | - | - | The pointer moved over her and she never heard of it: click-through is armed again. |
| `cursor` | `overlay:cursor` | handle | - | { x?: number, y?: number, inside?: boolean, display?: number } | The pointer in overlay coordinates, whether it is inside her window, and the display it is on. |
| `screens` | `screens:list` | handle | - | { current?: number, origin?: { x?: number, y?: number }, list?: array<{ id?: number, x?: number, y?: number, w?: number, h?: number }> } | Your screens (their bounds), the one she is on, and where her window is. |
| `moveScreen` | `screens:move` | handle | `id`: integer | { origin?: { x?: number, y?: number }, width?: number, height?: number, gap?: number } \| null | Her window goes to that screen; null when there is no such screen. |
| `getConfig` | `config:get` | handle | - | { keys?: array } | Her config as the overlay sees it (API keys left out, `keys`: the providers that have one). |
| `setConfig` | `config:set` | handle | `patch`: object | object | Saves a part of the config, answers the new config (the overlay is sent capri:config too). |
| `listSounds` | `sounds:list` | handle | - | array<{ name?: string, url?: string }> | Your own sounds (the sounds folder of her data). |
| `hooksStatus` | `hooks:status` | handle | - | object | Whether the assistant's hooks are installed. |
| `demoWindow` | `demo:window` | handle | `open?`: boolean | boolean | Opens or closes the demo terminal she perches on; false when windows are not tracked. |
| `openMenu` | `menu:open` | send | - | - | Right-clicking her: the tray's menu where the pointer is. |
| `installHooks` | `hooks:install` | handle | - | object | Installs the assistant's hooks (her welcome panel). |
| `claudeFound` | `claude:found` | handle | - | boolean | Whether Claude Code's folder exists. |
| `openClaudeHelp` | `claude:help` | send | - | - | Opens the assistant's help page in the browser. |
| `windowsNow` | `windows:get` | handle | - | object \| null | The last windows update (what the watcher saw), null before the first. |
| `trayPlace` | `guide:tray` | handle | - | { icon?: object \| null, corner?: object } | Where her tray icon is, in overlay coordinates, and the corner by the clock. |
| `openClaudeFolder` | `guide:claudeFolder` | handle | - | { found?: boolean, dir?: string, file?: boolean, label?: string } | Shows Claude Code's folder, its settings file selected. |
| `copyImage` | `panel:copy` | handle | `rect`: { x: number, y: number, width: number, height: number } | boolean | A picture of that part of the overlay, on the clipboard. |
| `chatStatus` | `chat:status` | handle | - | { ok?: boolean, error?: string, code?: string, provider?: string, model?: string, agent?: boolean, local?: boolean, warmup?: boolean } | Is the AI there, with a model to talk with. |
| `chatSend` | `chat:send` | handle | `request`: { id: string (max 100), messages: array<{ role: `system` \| `user` \| `assistant`, content: string (max 200000) }> } | { ok?: boolean, text?: string, error?: string, code?: string \| null } | Her answer; it is streamed to the overlay as chat:delta { id, text } meanwhile. |
| `chatStop` | `chat:stop` | send | `id`: string (max 100) | - | Stops that chat turn. |
| `chatMemory` | `chat:memory` | handle | - | array | The remembered conversation. |
| `chatRemember` | `chat:remember` | send | `history`: array | - | Remembers the conversation. |
| `lookSnap` | `look:snap` | handle | - | { ok?: boolean, id?: string, error?: string } | Takes a picture of your screen; the id stands for 2 minutes. |
| `lookSay` | `look:say` | handle | `request`: { id: string (max 100), persona?: string (max 100000), prompt: string (max 100000), history?: array } | { ok?: boolean, text?: string, model?: string, code?: string, error?: string } | What her AI says about the picture. |
| `lookWhere` | `look:where` | handle | - | { local?: boolean, provider?: string, model?: string } | Where her AI runs, for what she says before she looks. |
| `cpu` | `pc:cpu` | handle | - | number \| null | How hard the processor works, in %, since the last call (null the first time). |
| `openOllama` | `chat:ollama` | send | - | - | Opens the Ollama site. |
| `setupInfo` | `setup:info` | handle | - | { models?: array, cloud?: array, ram?: number, keyed?: array } | What the setup offers. |
| `ollamaState` | `setup:ollama` | handle | - | object | Whether Ollama is installed and running. |
| `installOllama` | `setup:install` | handle | - | { ok?: boolean, unsupported?: boolean } | Installs Ollama (progress: setup:progress { kind: "install" }). |
| `startOllama` | `setup:start` | handle | - | object | Starts Ollama. |
| `pullModel` | `setup:pull` | handle | `name`: string (max 200) | { ok?: boolean, model?: string, error?: string } | Fetches a model (progress: setup:progress { kind: "pull" }). |
| `cancelSetup` | `setup:cancel` | send | - | - | Stops the model being fetched. |
| `useProvider` | `setup:use` | handle | `choice`: { provider: string (max 50), key?: string (max 4096), url?: string (max 2000) } | { ok?: boolean, model?: string, error?: string } | Saves the provider, tries it, and undoes it if it fails. |
| `keyPage` | `setup:keyPage` | send | `provider`: string (max 50) | - | Opens the page where that provider's key is made. |
| `launchThroughOllama` | `setup:launch` | handle | `integration`: `claude` \| `codex` | { ok?: boolean, unsupported?: boolean } | Opens an assistant through Ollama (Windows). |
| `openApps` | `apps:list` | handle | - | array<{ name?: string, label?: string }> | The apps she may close. |
| `findApp` | `apps:find` | handle | `wanted`: string (max 2000) | { name?: string, label?: string } \| null | The open app that matches what you said. |
| `closeApp` | `apps:close` | handle | `name`: string (max 2000)<br>`force?`: boolean | { error?: string, unsupported?: boolean } | Closes an app you confirmed. |
| `findLaunch` | `apps:findLaunch` | handle | `text`: string (max 2000) | { kind?: string, id?: string, name?: string, risky?: boolean } \| null | An app, a game or a folder that matches what you said. |
| `launch` | `apps:launch` | handle | `item`: { kind: string (max 50), id?: string (max 4096) } | { ok?: boolean, error?: string } | Opens it (only what findLaunch listed). |
| `media` | `apps:media` | handle | `action`: `pause` \| `play` \| `next` \| `previous` \| `volup` \| `voldown` \| `mute` | boolean | A media key (Windows). |
| `music` | `apps:music` | handle | `query`: string (max 2000) | boolean | A Spotify search. |
| `youtube` | `apps:youtube` | handle | `query`: string (max 2000) | { title?: string \| null } \| null | The song on YouTube in your browser. |
| `roblox` | `apps:roblox` | handle | `query`: string (max 2000) | { name?: string \| null } \| null | The Roblox game, opened. |
| `searchFiles` | `files:search` | handle | `request`: { query?: string (max 2000), exts?: array<string (max 20)> } | array | Your files that match. |
| `openFile` | `files:open` | handle | `file`: string (max 4096)<br>`reveal?`: boolean | boolean | Opens a file a search showed. |
| `screenshot` | `files:screenshot` | handle | - | object \| null | A screenshot saved on your computer. |
| `webSearch` | `web:search` | handle | `query`: string (max 2000) | boolean | A search on the web, in your browser. |
| `openSite` | `apps:site` | handle | `address`: string (max 2000) | boolean | A website (http and https only). |
| `focusOverlay` | `overlay:focus` | send | `on?`: boolean | - | The overlay takes the keyboard while the chat is open. |

## Overlay events (8)

| Event | Channel | Payload | What |
|---|---|---|---|
| `onClaudeEvent` | `claude:event` | { session_id?: string } | An assistant's hook event (what the bridge took). |
| `onCommand` | `capri:command` | { name: string } | The core tells her to do something: { name, ...details } (status, stow, screens, goScreen, watchScreen, hooks, update ...). |
| `onConfig` | `capri:config` | object | The config changed (without the keys). |
| `onResize` | `overlay:resize` | { width?: number, height?: number, gap?: number } | Her window was fitted again. |
| `onWindows` | `windows:update` | object | The windows watcher's news ({ fg, wins, ... }). |
| `onPower` | `power:state` | { away?: boolean, why?: string } | Away (screen locked or asleep) or back. |
| `onChatDelta` | `chat:delta` | { id?: string, text?: string } | A piece of her answer to chatSend. |
| `onSetupProgress` | `setup:progress` | { kind?: `install` \| `pull` } | The progress of an Ollama install or a model fetch. |

## Settings window commands (12)

| Command | Channel | Kind | Arguments | Reply | What |
|---|---|---|---|---|---|
| `view` | `settings:view` | handle | - | { title?: string, sections?: array } \| null | What the window shows (settings-view.js). |
| `ready` | `settings:ready` | send | `info`: { sections?: number, focused?: any } | - | The settings page is up (the smoke test waits for it). |
| `set` | `settings:set` | handle | `patch`: object | { ok?: boolean, status?: string, error?: string, fields?: object } | Saves a change. |
| `saveKey` | `settings:key` | handle | `provider`: string (max 50)<br>`key`: string (max 4096) | { ok?: boolean, status?: string, field?: string, error?: string } | A new API key: sent, sealed, never read back. |
| `reset` | `settings:reset` | handle | - | { ok?: boolean } | Back to the defaults. |
| `restart` | `settings:restart` | send | - | - | Restarts her. |
| `openMenu` | `settings:menu` | send | - | - | Her menu over the settings window. |
| `close` | `settings:close` | send | - | - | Closes the window. |
| `updates.check` | `updates:check` | handle | - | object | Looks for an update; answers the update view. |
| `updates.download` | `updates:download` | handle | - | object | Downloads the update offered. |
| `updates.install` | `updates:install` | handle | `confirmed?`: boolean | object | Installs the downloaded update and restarts, once confirmed in the window. |
| `updates.page` | `updates:page` | send | - | - | Opens the release page (only this repository's). |

## Settings window events (3)

| Event | Channel | Payload | What |
|---|---|---|---|
| `onView` | `settings:view` | { title?: string, sections?: array } | The window shows another view (the config or her language changed). |
| `onSection` | `settings:section` | string | A section asked from outside (her menu's "Update available"). |
| `updates.onStatus` | `updates:status` | { kind?: string } | The updater's status. |
