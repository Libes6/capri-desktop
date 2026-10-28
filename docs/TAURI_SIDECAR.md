# TAURI-04: the Node sidecar

The core of Capri (`src/main/core.js`, the same files the Electron build runs) runs in a Node process next to the Rust shell. Rust owns windows and the system; the core owns state, rules and every command of her pages. They talk JSON-RPC 2.0, one JSON object per line, on the sidecar's stdin and stdout.

```
her page --invoke('host_invoke', {scope, name, args})--> Rust --request `invoke`--> sidecar
                                                                  core.dispatch.handle(name, args, { label })
her page <--event "capri://<channel>"-- Rust <--notification `emit` {window, event, payload}-- sidecar
```

Rust knows no command names. `host_invoke` refuses a `scope` that is not the calling window's label, and the core's dispatcher (`src/main/dispatch.js`, TAURI-02) checks the command, its scope, and its arguments against `src/protocol.js`. A refusal comes back to the page as the rejected promise `"<code>: <message>"` (`unknown`, `forbidden`, `invalid`). The sender is `{ label }`; `overlay.owns(sender)` of the sidecar platform recognizes it.

## Messages

Sidecar to Rust (requests): `hello` (paths, name, version, screens, cursor: the platform's first facts), `overlay.create {area}`, `overlay.setBounds {rect}`.
Sidecar to Rust (notifications): `emit`, `overlay.clickThrough|keepOnTop|raise|setFocusable|focus|blur`, `app.quit|exit|relaunch|focus`, `ready`.
Rust to sidecar: request `invoke`; notifications `cursor {x,y}` (DIP, pushed on change, at most 25/s), `screens {list}`, `second-instance`, `quit` (the core stops, the process leaves), `power {event}` (nothing sends it yet).

Anything on stdout that is not a message is logged by Rust and ignored; the sidecar sends `console.log` to stderr for that reason. Timeouts: a request to the sidecar waits at most 15 minutes (`CAPRI_INVOKE_TIMEOUT_MS`), a safety net for chat answers that stream; everything waiting fails at once when the process dies. The Node half is `sidecar/rpc.js`, the Rust half `src-tauri/src/rpc.rs`.

## Life cycle

Started when the event loop runs (`RunEvent::Ready`: the first question, `hello`, needs the screens). Restarted when it falls: at most 5 starts in 60 seconds, 0.2 s then twice as long each time, then `host_invoke` answers "the Capri core stopped and could not be restarted". A restarted core makes the overlay again, which reloads her page so that she meets the new core. Ends with the app: a `quit` notification, stdin closed (the sidecar leaves on EOF), a kill after 2 seconds. If the app itself is killed the pipe closes and the sidecar leaves by itself: checked with `kill -9` on the app. Single instance: `tauri-plugin-single-instance`; a second launch is told to the core as `second-instance` (her status comes up) and exits.

## What is not there yet

The sidecar platform (`src/main/platform/sidecar.js`) answers what the system cannot do yet with `{ unsupported: true }` where a method answers anything, or the neutral value of its type (no picture: `null`; no key store: `false`), and logs `unsupported: <method>` once. The core does not fall over. Work list by task:

| Method | Now | Task |
|---|---|---|
| `tray.create`, `app.installAppMenu`, `windows.createSettings` (a closed controller), `autostart.*`, `shortcuts.*` | unsupported | TAURI-06 |
| `secrets.*` (isAvailable is false: **keys are then stored as plain text in config.json**, as Electron does when its encryption is unavailable), `capture.screen`, `clipboard.writeImage`, `shell.*` (links and files do not open), `power.*`, `dialogs.pickFolder`, `app.appForProtocol`, `overlay.capture`/`nativeHandle`/`mediaSourceId` (macOS window watcher), `windows.createDemoTerminal` | unsupported | TAURI-07 |
| `updater` | tauri-plugin-updater through Rust (`updater.rs`) | TAURI-10 done, see [TAURI_UPDATES.md](TAURI_UPDATES.md) |
| Hover, chat focus, several screens, mixed DPI on Windows | minimal | TAURI-05 |

The core also reads files next to its sources (the macOS and Windows window-watch helpers, `windows.ps1`); the bundle does not carry them (TAURI-07 decides whether the watchers run from Rust or from the sidecar with resources).

## Delivering Node: Node SEA

`scripts/build-sidecar.js` bundles `sidecar/main.js` and every file it requires (33 files, 296 KB; a 60-line require-inliner, no dependency: node builtins stay `require`, anything else must be a file of the repository, `require(path.join(__dirname, ...))` is followed) and turns the bundle into a Node single executable application (`node --experimental-sea-config` + `postject`, already in `node_modules/.bin`). Output: `src-tauri/binaries/capri-sidecar-<target triple>[.exe]`, the name Tauri wants for `externalBin`. `src-tauri/tauri.bundle.conf.json` is the bundle config to merge in TAURI-12 (`externalBin`); it is not in `tauri.conf.json` because Tauri would then refuse to build without the binary.

Compared, on this machine (macOS 26, M4, arm64, Node 22.22.0):

| | size | start to `ready` (3 runs) |
|---|---|---|
| `node sidecar/main.js` (dev; needs Node installed) | 0.3 MB of sources + the user's node | 49, 49, 50 ms |
| `node sidecar.bundle.js` | 0.3 MB + the user's node | 46, 47, 46 ms |
| **SEA executable** | **105.9 MB** (34.2 MB gzip -9), build 6.4 s | 45 and 46 ms; **the first run of a new file 1104 ms** (macOS checks a new executable once) |
| `bun build --compile` | not available here (no bun installed); same order of size (bun's runtime ~60 MB) | not measured |

Why SEA: it is the only option that builds here without a new dependency; its start time is the same as plain Node's, once; Node is not required on the user's machine; the file is a copy of the real `node`, so native behaviour (child processes, `fetch`, `fs`) is the one the core was written for. What it costs: ~106 MB per platform (the node binary), 34 MB compressed in an installer; the first launch after install is a second slower. Smaller options (bun, or the core rewritten in Rust, TAURI-15) are the way to shrink it later.

Not checked, written from Node's SEA documentation: the Windows and Linux steps of `build-sidecar.js` (a `.exe` name, no `--macho-segment-name`, no codesign). Node cannot cross-build: the node binary copied is the one that runs the script, so each platform builds its own (CI, TAURI-12). macOS release signing and notarizing of the sidecar is TAURI-12's: here it is ad-hoc signed so that an arm64 Mac runs it.
