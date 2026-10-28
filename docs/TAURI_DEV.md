# Running the Tauri build (TAURI-04)

Needs Rust (stable, 1.90 or newer) and Node 22. No `@tauri-apps/cli`: the shell is a plain Cargo project in `src-tauri/`.

```
npm run tauri:dev      # stage her pages, cargo build, run the app; the core runs as `node sidecar/main.js`
npm run tauri:build    # stage, build the sidecar executable (Node SEA), cargo build --release
npm run tauri:test     # cargo test (RPC layer, sidecar supervisor, user-sound protocol)
npm run tauri:stage    # only the pages     npm run tauri:sidecar    # only the sidecar executable
```

Her pages are Tauri's `frontendDist` (`src-tauri/frontend/`, generated, not committed): `scripts/stage-frontend.js` copies `src/renderer`, `assets` and the font files her styles name, keeping the repository layout, so the relative paths (`../../assets/...`, `../../../node_modules/@fontsource/...`) work as they do in Electron. They are embedded when Cargo builds: **a change to a page needs `npm run tauri:dev` again** (it restages, Cargo rebuilds only what changed).

## Where things go

- Rust's build folder is Cargo's `target/`: set `CARGO_TARGET_DIR` to keep it outside the repository (`src-tauri/target/` is ignored by git anyway).
- Her data: `~/Library/Application Support/capri.desktop` (the identifier's folder; Electron's was `Capri`, moving it is TAURI-09). **`CAPRI_USER_DATA=<dir>` uses another profile**: use it for every try-out, with `CAPRI_PORT=<port>` for the hooks bridge (47823 by default, the real Capri's). Autostart writes a LaunchAgent / the registry's Run key: for try-outs set **`CAPRI_AUTOSTART_FAKE=<file>`** (the state is that file's, the system is untouched).
- `CAPRI_NODE` names the `node` that runs the sidecar when it is not on the GUI's PATH (an nvm node). `CAPRI_SIDECAR=<executable>` runs that file as the sidecar instead (the SEA one). `CAPRI_ROOT` is the project folder (set by `tauri:dev`).
- Debug: with `CAPRI_DEBUG_STDIN=1` each line on stdin is JavaScript run in her page (the result is printed as `[eval] ...`); `!sidecar` prints its pid and state, `!kill` kills it (to see it come back), `!exit` quits.

## Trying it

```
export CARGO_TARGET_DIR=$HOME/capri-target
CAPRI_USER_DATA=$(mktemp -d) CAPRI_PORT=47955 npm run tauri:dev
curl -s localhost:47955/health                       # the core is up
curl -s -X POST localhost:47955/event -H 'content-type: application/json' -d '{"hook_event_name":"UserPromptSubmit","session_id":"t","prompt":"hi"}'
```

On macOS she has no Dock icon (Accessory policy); the overlay window is level 1000 on all Spaces. The hit test is a pointer poll in Rust (25 Hz) that feeds her page synthetic `mousemove` events, so `app.js` is unchanged; `docs/TAURI_SPIKE.md` says why.

## Windows and Linux

Written but never run: the Rust and Node code is portable (`cfg(target_os)` only for the macOS window flags and the pointer read), the sidecar build has the platform branches. CI is TAURI-12. Known gaps there: mixed-DPI coordinates (the cursor and monitor positions are divided by one scale), `capri://usersounds/` is `http://capri.localhost/` on Windows (`platform.app.userSoundUrl` makes the address; her pages' CSP allows it; never run). The native services of TAURI-07 (key store, capture, clipboard, links, power) are in `docs/TAURI_NATIVE.md`, with what was and was not run on each system.


## Tray, menus, settings window, shortcuts, autostart (TAURI-06)

- **Tray**: the core sends its menu as data on every rebuild (`tray.setMenu`, built by `platform/menu-wire.js`: items get ids `t<generation>.<n>`, callbacks stay in the sidecar); `src-tauri/src/menu.rs` turns it into a `tauri::menu` (a radio is a check item that stays checked), a click comes back as `tray.click { id, checked }`. The last two menus' ids stay good, so a click on a menu rebuilt while open still works. As in Electron: on macOS the icon opens the menu, on Windows/Linux a left click is her status and a right click opens it. Right click on her (`menu:open`) opens the same menu at the pointer.
- **Settings window** (`settings_window.rs`): label `settings`, one at a time, `settings.html` as it is, 720x540 (min 480x360) centered in the work area, `#fcee0a`, shown when the page has loaded, only her own origin may be in it. The app is brought forward first (Accessory has no Dock icon). `owns(sender)` goes by the label; `capabilities/settings.json` gives it the bridge command and events, and Rust refuses a `scope` that is not the window's own.
- **Application menu** (macOS): app + Quit, Edit, Window; Minimize / Close Window act on the focused window, never the overlay. None on Windows and Linux.
- **Shortcuts**: `Control+Alt+C` (hide/show) through tauri-plugin-global-shortcut; a refused one is logged.
- **Autostart**: tauri-plugin-autostart (macOS LaunchAgent, Windows Run key; Linux has none by decision, the core never asks).
- **Debug** (`CAPRI_DEBUG=1`, sidecar/debug.js, on the bridge port): `POST /debug/menu {click:"label"}` (labels, click), `/debug/tray {fire:"id"}` (Rust's item list, click by id), `/debug/popup`, `/debug/settings {open, section, key, js}`. A second Capri with the same identifier exits at once (single instance): build a try-out copy with `TAURI_CONFIG='{"identifier":"capri.desktop.try"}' cargo build`.
