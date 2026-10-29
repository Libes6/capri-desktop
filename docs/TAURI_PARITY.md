# TAURI-11: feature parity of the Tauri build with the Electron build

Date: 2026-10-29. Branch `tauri-11`, on top of TAURI-00…10. Machine: MacBook with Apple M4, macOS 26 (Darwin 25.6), arm64, one display 2560x1440. Everything "live" below was run on this Mac and nowhere else.

One table per area; every row names a function of `docs/IMPROVEMENT_TASKS.md` (CAPRI-01…12) or commands of the protocol (`docs/protocol.json`: 65 commands, 11 events), what the Electron build does, and what the Tauri build does on each system.

## How to read it

Cells of the three Tauri columns:

| Mark | Meaning |
|---|---|
| ✅ | run in the app on this Mac (macOS only; a command through the dispatcher, a window, a process) |
| 🧪 | written and covered by tests, or by a check of the code, never run on that system (Windows and Linux were never started in this work) |
| ⚠️ | works with a limit, the limit follows the mark |
| ❌ | not there in the Tauri build, though Electron has it |
| — | not offered on that system by design, in Electron too (an honest "unavailable" in her menu) |

The **status** column is the claim for the row as a whole: ✅ run live on macOS and nothing missing; 🧪 only tests/code (no live run anywhere); ⚠️ a known limit; ❌ a missing feature. A row whose macOS cell is ✅ and whose Windows/Linux cells are 🧪 is ✅ in the status column: **Windows and Linux are 🧪 until TAURI-12's CI runs them**, that is stated once here and not repeated in each row.

No cell is left undecided: when a thing could not be run, the cell says 🧪 or ⚠️ and why. `tests/tauri-contract.test.js` fails on an empty cell, on a status without a mark, on a protocol command or event the document does not name, and on a cell that says it is undecided.

How things were checked: `npm test` (node), `cargo test` in `src-tauri` , `npm run test:smoke:tauri` (below), and the live runs of this task: a probe that started the built app with a temporary profile and called the commands through the dispatcher (`/debug/invoke`), a look at the tray and menu, and the performance probe.

## 1. CAPRI-01…12

| Function | Electron | Tauri macOS | Tauri Windows | Tauri Linux | Status | Test / doc |
|---|---|---|---|---|---|---|
| CAPRI-01 language: `auto` takes the first supported language of the system list, English when none; the choice is kept as `auto`; menu, lines, setup, guide, settings in one language | `app.getPreferredSystemLanguages()` | ✅ the list is read with `defaults read -g AppleLanguages` once at start (this task); `getConfig` gives `lang: ru` on this Mac. Before the fix it gave `en` (a GUI process has no `LANG`) | 🧪 `Get-WinUserLanguageList` through PowerShell, parser tested | 🧪 `LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG` | ✅ | `tests/system-languages.test.js`, `tests/lang.test.js`; fixed here (gap 1) |
| CAPRI-01 five dictionaries (ru, en, fr, es, pt) | the core's `labels.js` | ✅ the same files; the settings window shows them | 🧪 | 🧪 | ✅ | `tests/lang.test.js`, `tests/settings.test.js` |
| CAPRI-02 honest availability: one set of flags (`caps`) to menu, guide, setup, chat; window tracking, app list/close/launch, media keys, autostart, Ollama install/launch | `capabilities.js` | ✅ `windowTracking` true (helper built), `appList/appClose/appLaunch/mediaKeys/ollamaInstall/ollamaLaunch` false, `autostart` true (read from `/debug/info` in the live run) | 🧪 the same module; `windowTracking` needs `windows.ps1` in the resources folder (TAURI-12 must put it there) | 🧪 `windowTracking` only on X11/XWayland, `autostart` false | ✅ | `tests/capabilities.test.js`, smoke `windowTracking` |
| CAPRI-03 settings window: ordinary window, one at a time, 720x540 (min 480x360) centred, `#fcee0a` until loaded, shown when the page loads, only her origin in it | `settings-window.js` | ✅ label `settings`, opened through the debug route, `readyState complete`, title `Capri — Settings` | 🧪 | 🧪 | ✅ | smoke `settingsWindow`; `settings_window.rs`; `docs/TAURI_DEV.md` |
| CAPRI-04 settings fields (see section 2 for each) and saving | `settings:set` → `settings-patch.js` | ✅ `initiative` changed through `settings:set`, found in `config.json` | 🧪 | 🧪 | ✅ | smoke `settingChange`; `tests/settings-save.test.js` |
| CAPRI-04 display mode (`render`: auto / gl / software) | read at start; she restarts | ⚠️ not offered: WKWebView chooses its renderer, so the row is left out of the settings window and the tray menu (this task); the value stays in `config.json` | ⚠️ same (WebView2) | ⚠️ same (WebKitGTK) | ⚠️ | `tests/settings-save.test.js` "display mode", `tests/sidecar-platform.test.js`; gap 6 |
| CAPRI-05 initiative (`quiet`/`normal`/`active`) and protection from repeated lines | core JS | ✅ the core is the same JS; the field is set live; the frequency logic is not run for hours | 🧪 | 🧪 | 🧪 | `tests/initiative.test.js` |
| CAPRI-06 CPU/GPU baseline, `frameIn` instead of a callback on every frame | Electron: 39 callbacks/s at 12 draws/s | ✅ `frameIn` works in WKWebView: 39–45 callbacks/s at 11.8 draws/s idle (this task) | 🧪 WebView2 is Chromium: as Electron | 🧪 WebKitGTK not measured | ✅ | `docs/TAURI_PERFORMANCE.md`, `tests/frames.test.js` |
| CAPRI-07 pause when the screen locks or the Mac sleeps: loops stop, "done" kept until she is back | `powerMonitor` | ✅ `power` events from NSWorkspace and the distributed `screenIsLocked` reach the core; the pause itself run live with `/debug/power {away:true}`: 0 callbacks, 0 draws. A real lock was not made (it needs the password) | 🧪 `WM_POWERBROADCAST` + WTS session in a message-only window | ⚠️ sleep only, through logind `PrepareForSleep` (no lock event on Linux, as in Electron) | ✅ | `tests/pause.test.js`, `docs/POWER_EVENTS.md`, `docs/TAURI_NATIVE.md`, performance doc |
| CAPRI-08 / 09 macOS window tracking and sitting on windows | Swift helper `capri-windows`, started by the main process | ✅ the same helper started by the sidecar: `window tracking: on`, windows listed, her own overlay (level 1000) not among them; the demo's terminal appears and goes (this task) | — | — | ✅ | smoke `windowTracking`, `demoTerminal`; `docs/MAC_WINDOW_TRACKING.md` |
| CAPRI-10 Linux X11 window tracking and base sitting | `x11-watch.js` (xprop) | — | — | ⚠️ the watcher is the same JS in the sidecar; **her own window is not excluded** because the sidecar cannot give its X id (`overlay.nativeHandle`, gap 3) | ⚠️ | `tests/x11.test.js`, `docs/LINUX_WINDOW_TRACKING.md` |
| Windows window tracking (`windows.ps1`) | PowerShell watcher | — | ⚠️ the watcher is the same script, started by the sidecar; **her own window is not excluded** (the HWND is `0`, `overlay.nativeHandle`, gap 3) | — | ⚠️ | `tests/mac-window-watch.test.js`, `src/main/windows.js` |
| CAPRI-11 updates: check at start, download, install, notes, restart confirmation | electron-updater, GitHub Releases | ✅ tauri-plugin-updater: a real 0.1.0 → 0.1.1 update run on this Mac with a loopback feed and a test key, plus the refusals (bad signature, broken download, offline). Disabled in dev builds | 🧪 NSIS installer, not run | 🧪 AppImage replaces itself; `.deb` is notify-only (decision logic tested) | ✅ | `docs/TAURI_UPDATES.md`, `tests/updates-tauri.test.js`, `tests/updater-config.test.js` |
| CAPRI-12 settings window in the cyberpunk style (yellow ground, black cut panels, `clip-path`, `mask-image`, fonts) | Chromium | ✅ the real settings window loads in WKWebView; the look was checked page by page in a WKWebView harness at TAURI-03 (0 console errors, 0 CSP violations) | 🧪 WebView2 is Chromium | 🧪 WebKitGTK not run (its CI job exists, never run) | ✅ | `docs/TAURI_WEBKIT_CHECK.md` |

## 2. Settings window: every field

All of them are the core's JS (`settings-view.js`, `settings-patch.js`): the same code and the same checks in both builds, so what differs is only what the system must do.

| Function | Electron | Tauri macOS | Tauri Windows | Tauri Linux | Status | Test / doc |
|---|---|---|---|---|---|---|
| General: language (`lang`, Auto names the language it gives) | ✅ | ✅ set and shown (`ru` on this Mac) | 🧪 | 🧪 | ✅ | `tests/settings-save.test.js` |
| General: start with the system (`autostart`) | login item | ✅ LaunchAgent through tauri-plugin-autostart; the state is told by Rust in `hello`; live with `CAPRI_AUTOSTART_FAKE` (the real Login Items were not touched) | 🧪 Run key | — not offered (no worker), same as Electron | ✅ | `src-tauri/src/autostart.rs`, `docs/TAURI_DEV.md` |
| General: size (`scale`), sound off (`muted`), volume (`volume`) | ✅ | ✅ `setConfig`/`settings:set` reach the page (`capri:config`) | 🧪 | 🧪 | ✅ | `tests/settings-save.test.js` |
| General: screen (`displayId`), follow the pointer (`follow`) | ✅ | ✅ one screen here; two screens by `CAPRI_SCREENS=2` (TAURI-05) | ⚠️ mixed-DPI coordinates (gap 4) | 🧪 | ⚠️ | `docs/TAURI_SPIKE.md` |
| Behaviour: motion, rest, initiative, wander, possess, jealous, pcReact, watchScreen | ✅ | ✅ (`initiative` run live; the rest are the same checks) ; `possess` is disabled with a reason where window tracking is off | 🧪 | 🧪 | ✅ | `tests/settings-save.test.js` |
| AI: assistant, provider, model, address, API key (`saveKey`) | ✅ | ✅ keys sealed with the master key in the Keychain (`kc:`); tests with a test service name | 🧪 Credential Manager | 🧪 Secret Service; no store → keys stay plain text, like Electron without safeStorage | ✅ | `docs/TAURI_NATIVE.md`, `tests/settings-save.test.js` |
| About: version, update row, system line, license | ✅ | ✅ `tauri <version> / node <version>` in the system line | 🧪 | 🧪 | ✅ | `tests/updates-tauri.test.js` |
| Reset settings (`reset`), restart (`restart`) | ✅ | ✅ reset is the core's; restart is `app.relaunch` in Rust (not run: it would replace the process under the probe) | 🧪 | 🧪 | 🧪 | `tests/settings-save.test.js` |

## 3. The shell: tray, menu, shortcuts, overlay, watchers

| Function | Electron | Tauri macOS | Tauri Windows | Tauri Linux | Status | Test / doc |
|---|---|---|---|---|---|---|
| Tray icon and menu built by the core as data (submenus, radios, checks, reminders list, the last menu stays good while open) | `Tray` | ✅ the menu's items present, labels in Russian, a click by id through the debug route | 🧪 left click = `onClick` | ⚠️ the icon needs an indicator host; position not given by the system | ✅ | `docs/TAURI_DEV.md`, `tests/sidecar-platform.test.js`, `menu.rs` tests |
| Tray icon place for the guide arrow (`trayPlace`) | `tray.getBounds()` | ✅ asked from the tray at start and at each menu rebuild (this task); before, only after the pointer touched the icon: `icon: null` | 🧪 | ⚠️ Linux gives no icon bounds, Electron's are zeros there too | ✅ | gap 2; `tray.rs` |
| Application menu (Edit, Quit, Window; Minimize and Close act on the focused window, never the overlay) | `Menu` | ✅ made at start (not clicked) | — none, as in Electron | — none | 🧪 | `menu.rs` tests |
| Global shortcut `Control+Alt+C` (hide/show) | `globalShortcut` | ✅ registered through tauri-plugin-global-shortcut (a refusal is logged) | 🧪 | 🧪 | 🧪 | `shortcuts.rs`, `tests/sidecar-platform.test.js` |
| Single instance: a second launch brings the first forward | `requestSingleInstanceLock` | 🧪 the plugin and the socket `/tmp/capri_desktop_si.sock` are there; a second launch was not tried (the smoke uses its own identifier so it never meets a real Capri) | 🧪 | 🧪 | 🧪 | `docs/TAURI_DEV.md` |
| Overlay: transparent, no frame, level above full-screen windows, all Spaces/desktops, no Dock icon | `BrowserWindow` `screen-saver` level | ✅ `NSWindow level=1000`, `collectionBehavior=0x111`, Accessory policy | 🧪 `WS_EX_TOOLWINDOW`, topmost lifted every 3 s | 🧪 skip-taskbar, sticky | ✅ | `docs/TAURI_SPIKE.md` |
| Overlay clicks: click-through except on her, hit test by a pointer poll in Rust (adaptive 25/12/8 Hz) feeding `mousemove` to the page | `setIgnoreMouseEvents(forward)` | ✅ run in TAURI-05 (clicks on her, through her, drag, throw) | 🧪 `GetCursorPos`, `GetAsyncKeyState` | 🧪 20 Hz poll | ✅ | `docs/TAURI_SPIKE.md`, `overlay/pointer.rs` tests |
| Overlay screens: move to another screen, follow the pointer, mixed DPI | `screen` API | ✅ `screens:move` between two halves of one screen (`CAPRI_SCREENS=2`); no second monitor was available | ⚠️ DIP space of its own, not byte for byte Chromium's with mixed scales (gap 4) | 🧪 | ⚠️ | `overlay/geometry.rs` tests |
| Overlay chat focus: the overlay takes the keyboard while the chat is open and gives it back | `setFocusable` + focus | ✅ run in TAURI-05 (`NSApp activate`, key window, focus back to the app that had it) | 🧪 | 🧪 | ✅ | `docs/TAURI_SPIKE.md` |
| The report card's copy button (a picture of part of her overlay on the clipboard) | `capturePage` | ❌ `overlay.capture` is "unsupported" in the sidecar platform: the button answers `false` (gap 5) | ❌ | ❌ | ❌ | `tests/sidecar-platform.test.js` |
| Window watcher for the overlay's own id (`overlay.nativeHandle`) | native handle | — not needed: the macOS helper skips layer 1000 | ❌ `0` is passed: she can sit on her own window (gap 3) | ❌ `selfXid` gets nothing (gap 3) | ❌ | `src/main/windows.js`, `src/main/linux/x11.js` |
| `overlay.mediaSourceId` (macOS helper's `--self-window`) | media source id | ⚠️ `null`: the helper filters by layer instead; harmless | — | — | ⚠️ | `src/main/mac/window-watch.js` |
| Power events (sleep, wake, lock, unlock, user switch) and idle state | `powerMonitor` | ✅ NSWorkspace and the distributed `screenIsLocked` notifications reach the core (TAURI-07 posted them to the real observers); `getSystemIdleState` from CGEventSource | 🧪 | ⚠️ sleep only | ✅ | `docs/TAURI_NATIVE.md` |
| Hooks of the assistants (Claude Code, Codex, Agy): install into the user's files, `capri-hook` binary, the bridge on `CAPRI_PORT` | Node command | ✅ bridge answered a hook event (`/event`, `{"ok":true}`) and `hooksStatus` read the Codex file; installs are tested only in temporary profiles | 🧪 | 🧪 | ✅ | `tests/hooks.test.js`, `tests/capri-hook-binary.test.js`, `tests/hooks-command.test.js` |
| Keys: sealed in `config.json`, never in the renderer or the logs | `safeStorage` (`enc:`) | ✅ AES-256-GCM under a master key in the Keychain (`kc:`); a test service name in all tests | 🧪 | 🧪 | ✅ | `docs/TAURI_NATIVE.md`, `tests/core-portable.test.js` |
| Migration from the Electron profile (config, memory, sounds, keys, login item, hooks' commands) | — | ✅ run live in TAURI-09 with a real Electron `safeStorage` on a temporary profile | 🧪 | 🧪 | ✅ | `docs/TAURI_MIGRATION_DATA.md`, `tests/migrate.test.js` |
| Screen capture (what "look at my screen", the screenshot and the screen watch use) | `desktopCapturer` | ✅ CoreGraphics if Screen Recording is already allowed (it is on this Mac: a screenshot file was made and removed; without it: no picture, said honestly) | ❌ not written: always "no picture" (gap 7) | ❌ not written (gap 7) | ⚠️ | `docs/TAURI_NATIVE.md` |
| Clipboard, links, files, folders | `clipboard`, `shell` | ✅ text round trip (TAURI-07); only http(s) and the launchers' own schemes open; `openPath` needs an existing absolute path | 🧪 ShellExecute, `explorer /select,` | 🧪 xdg-open, FileManager1 | ✅ | `tests/sidecar-platform.test.js`, `opener.rs` tests |
| Folder picker | `dialog` | 🧪 the plugin; needs a person, tested with a fake | 🧪 | 🧪 | 🧪 | `dialogs.rs` |
| Sounds: Web Audio, her own files in `userData/sounds` (`capri://usersounds/`) | `autoplayPolicy: no-user-gesture-required` | ✅ the page's `AudioContext` resumes without a click and is `running` (checked in the page); the user-sound scheme is served by Rust | 🧪 `http://capri.localhost/` form | 🧪 | ✅ | `assets.rs` tests |
| The demo's fake terminal she sits on and takes over | a `BrowserWindow` | ✅ a Rust window made from the HTML the core sends, shown without focus, seen by the watcher as 620x300 and gone after (this task) | 🧪 | 🧪 | ✅ | smoke `demoTerminal`, `demo.rs`, gap 8 (fixed) |
| The sidecar: starts, restarts after a kill (5 starts in 60 s, backoff), none left at exit | — | ✅ pid changed after a SIGKILL and her page met the new core; no process of ours alive after exit (4 processes counted) | 🧪 | 🧪 | ✅ | smoke `sidecarRestart`, `exitClean`; `sidecar.rs` tests |
| Rights of the windows: one command (`host_invoke`) per page, scope = the window's label, no plugin right | `contextBridge` | ✅ checked from the files and in `cargo test` | 🧪 | 🧪 | ✅ | `tests/tauri-contract.test.js` |

## 4. Commands of the protocol (65)

"Same" = the core's JS answers, the system part is the one named. Every command goes `host_invoke` → sidecar → `core.dispatch.handle`; the integrity test checks that all 65 are served on the sidecar platform, as `send` or `handle`.

| Function | Electron | Tauri macOS | Tauri Windows | Tauri Linux | Status | Test / doc |
|---|---|---|---|---|---|---|
| Page life: `rendererReady`, `rearm`, `setInteractive` | ✅ | ✅ `rendererReady` seen by the smoke; the other two are the pointer path | 🧪 | 🧪 | ✅ | smoke `rendererReady`, `tests/sidecar-overlay.test.js` |
| Place: `cursor`, `screens`, `moveScreen`, `focusOverlay` | ✅ | ✅ answered live: one screen 2560x1440, the cursor inside | 🧪 | 🧪 | ✅ | `tests/sidecar-overlay.test.js` |
| Config: `getConfig`, `setConfig` | ✅ | ✅ run live | 🧪 | 🧪 | ✅ | smoke `coreGetConfig` |
| Sounds: `listSounds` | ✅ | ✅ `[]` in a clean profile | 🧪 | 🧪 | ✅ | `tests/sidecar-platform.test.js` |
| Hooks and the guide: `hooksStatus`, `installHooks`, `claudeFound`, `openClaudeHelp`, `openClaudeFolder`, `trayPlace` | ✅ | ✅ `hooksStatus` and `trayPlace` live; `installHooks` only in temporary profiles | 🧪 | 🧪 | ✅ | `tests/hooks.test.js` |
| Menu: `openMenu` (overlay, `menu:open`) | right click on her | ✅ the menu opens at the pointer (debug route `popup`) | 🧪 | 🧪 | ✅ | `docs/TAURI_DEV.md` |
| Demo: `demoWindow` | ✅ | ✅ run live (the terminal) | 🧪 | 🧪 | ✅ | smoke `demoTerminal` |
| Windows list: `windowsNow` | ✅ | ✅ live, windows in her coordinates | 🧪 | 🧪 | ✅ | smoke `windowTracking` |
| Report card: `copyImage` | ✅ | ❌ answers `false` (gap 5) | ❌ | ❌ | ❌ | `tests/sidecar-platform.test.js` |
| Chat: `chatStatus`, `chatSend`, `chatStop`, `chatMemory`, `chatRemember`, `openOllama` | ✅ | ✅ `chatStatus` live against the local Ollama; `chatSend` answered `ok` from the local Ollama model in 5 s | 🧪 | 🧪 | ✅ | `tests/chat-caps.test.js` |
| Look at the screen: `lookSnap`, `lookSay`, `lookWhere` | ✅ | ✅ `lookSnap` gave a picture id (Screen Recording allowed here) | ❌ no picture (gap 7) | ❌ no picture (gap 7) | ⚠️ | `docs/TAURI_NATIVE.md` |
| PC state: `cpu` | ✅ | ✅ Node's `os` | 🧪 | 🧪 | ✅ | `tests/core-portable.test.js` |
| Setup of a model: `setupInfo`, `ollamaState`, `installOllama`, `startOllama`, `pullModel`, `cancelSetup`, `useProvider`, `keyPage`, `launchThroughOllama` | ✅ | ✅ `setupInfo`, `ollamaState` live (Ollama running here); installing and launching are Windows-only features in both builds | 🧪 `winget`, a terminal window | — | ✅ | `tests/capabilities.test.js` |
| Apps and media: `openApps`, `findApp`, `closeApp`, `findLaunch`, `launch`, `media`, `music`, `youtube`, `roblox`, `openSite` | Windows only; elsewhere "unavailable" | ✅ `openApps` gives `[]` and `media` gives `false` like Electron on macOS; `music`/`youtube`/`openSite` open links through Rust | 🧪 PowerShell and Win32 from the sidecar; `roblox://` asked of the registry at start | — | ✅ | `tests/chat-caps.test.js`, `opener.rs` tests |
| Files: `searchFiles`, `openFile`, `screenshot`, `webSearch` | ✅ | ✅ `searchFiles` live (found files); `screenshot` wrote a file (removed); `webSearch` opens an `https` link through Rust | 🧪 (screenshot: no picture) | 🧪 (screenshot: no picture) | ✅ | `tests/core-portable.test.js` |
| Settings window: `settings.view`, `settings.ready`, `settings.set`, `settings.saveKey`, `settings.reset`, `settings.restart`, `settings.openMenu`, `settings.close` | ✅ | ✅ `view` (4 sections) and `set` live; the others the same dispatch | 🧪 | 🧪 | ✅ | smoke `settingsWindow`, `settingChange` |
| Updates: `updates.check`, `updates.download`, `updates.install`, `updates.page` | ✅ | ✅ live update run (see CAPRI-11) | 🧪 | 🧪 | ✅ | `docs/TAURI_UPDATES.md` |
| Events to the page: `onClaudeEvent`, `onCommand`, `onConfig`, `onResize`, `onWindows`, `onPower`, `onChatDelta`, `onSetupProgress` | ✅ | ✅ `capri://<channel>` events: the power pause (`onPower`) and the settings change (`onConfig`, `onView`) reached the page, and a hook event went in through the bridge; `onChatDelta`/`onSetupProgress` are the same emit path (the chat answer itself came back through the dispatcher) | 🧪 | 🧪 | ✅ | `docs/TAURI_SIDECAR.md` |
| Events to the settings window: `onView`, `onSection`, `updates.onStatus` | ✅ | ✅ `settings:view` sent on a change; the section by the page's hash | 🧪 | 🧪 | ✅ | `settings_window.rs` |
| Voice and sounds in the page (Web Audio, reminders, bond, guide, jealousy, demo mode) | ✅ | ✅ the page is the same files; the guide's arrow finds the tray icon (`trayPlace`); reminders are the core's timers (not waited for) | 🧪 | 🧪 | ✅ | `docs/TAURI_WEBKIT_CHECK.md`, `tests/initiative.test.js` |
| Ollama and LLM providers: the core's `fetch` to localhost and to the providers' APIs | ✅ | ✅ `chatStatus` and `ollamaState` live (they went to the local server from the Node sidecar) | 🧪 | 🧪 | ✅ | `tests/chat-caps.test.js` |

## 5. Gaps found (works in Electron, not in the build as it was)

| # | Gap | Priority | State |
|---|---|---|---|
| 1 | **Language**: a GUI-launched app has no `LANG`, so the sidecar took `en-US` and a Russian Mac got English menus, lines and settings | P1 | **Fixed** here: the list is asked of the system at start (`system-languages.js`), 5 tests, checked live (`lang: ru`) |
| 2 | **Tray icon place**: `trayPlace` gave `icon: null` until the pointer touched the icon, so the guide's arrow had nothing to point at | P2 | **Fixed** here (`tray.rs`: the tray's own rect at start and at each menu rebuild); checked live (`x 1829, y -30, w 34, h 30` in overlay coordinates) |
| 3 | **Her own window is not excluded from the Windows and Linux X11 watchers** (`overlay.nativeHandle` returns zeros): she could sit on her own full-screen window | P1 for Windows/Linux | **Open**, see "Open questions" |
| 4 | **Mixed DPI on Windows**: `screens.toDip` is the identity; a second monitor with another scale gets wrong window rectangles | P2 | **Open** (needs a Windows machine) |
| 5 | **The report card's copy button** does nothing (`overlay.capture` unsupported) | P2 | **Open**, see "Open questions" |
| 6 | **Display mode setting** was shown but ignored by the shell | P3 | **Fixed** here by not offering it where the platform chooses its renderer (`renderModes: false`) |
| 7 | **Screen capture on Windows and Linux** is not written, so "look at my screen", the screenshot and the screen watch always say "no picture" | P1 for Windows/Linux | **Open**, see "Open questions" |
| 8 | **The demo's fake terminal** was "unsupported" in the Tauri build: the demo ran but the terminal never appeared | P2 | **Fixed** here (`demo.rs`; checked live; `webview-data-url` feature of tauri added) |

Smaller notes, no gap: `unsupported: overlay.mediaSourceId` is logged once on macOS (the helper filters by layer); `CAPRI_SCREENS=2` is the only way a second screen was tried; a real screen lock, a real sleep and the system password prompt of the first Keychain read were not exercised; `installHooks` was never run against a real profile (by rule).

## 6. Open questions

1. **Her own window in the Windows and X11 watchers** (gap 3). The watchers read `overlay.nativeHandle()` when they start, which is a moment before the shell has made the window (the sidecar asks Rust asynchronously). Proposal: Rust returns `hwnd` (`window.hwnd()`) or the X11 window id in the answer to `overlay.create`; the platform caches it; the core starts the Windows/X11 watcher from the overlay's `onReady` (or reads the handle on each restart of the watcher). Estimate: Windows half a day, X11 one day (the XID needs the GTK window through `gdk_x11_window_get_xid`, or the watcher filters by `_NET_WM_PID`, which needs no Rust at all and is the cheaper path). Cannot be checked without a Windows and an X11 machine.
2. **Screen capture on Windows and Linux** (gap 7). Windows: `BitBlt`/DXGI duplication in Rust (windows-sys features already half there), 1 day. Linux X11: `XGetImage` through `x11rb` or the `xcap` crate (a new dependency, to be argued), 1 day; Wayland needs the portal and is out of scope for 0.1 (X11/XWayland only). Until then the core already says "no picture" honestly.
3. **Report card copy** (gap 5). Options: `WKWebView takeSnapshot` through `with_webview` (macOS, `objc2-web-kit` dependency), WebView2 `CapturePreview` (Windows), none for WebKitGTK; or draw the card into a canvas in the page (no native part, but a card is DOM, so it needs a small rasterizer). Estimate 1 to 2 days with the canvas path, which is the one that works on all three. Not done: it is a button, not a core function.
4. **Mixed DPI on Windows** (gap 4): per-monitor scale in `geometry.rs` and a real `toDip` in the platform; half a day plus a machine with two monitors.
5. **Everything marked 🧪**: nothing on Windows and Linux was started. TAURI-12 must run `npm run test:smoke:tauri`, `cargo test` and `npm test` on all three systems, and the first Windows/Linux runs of the app are expected to find things.

## 7. Tests added or changed for this task

- `scripts/smoke-test-tauri.js` (`npm run test:smoke:tauri`): see below.
- `tests/tauri-contract.test.js`: capabilities (two files, named windows, only the bridge), the one command in `build.rs`/permission/handler, window labels, CSP, and this document's completeness.
- `tests/sidecar-platform.test.js`: all 65 commands served as `send`/`handle` as the protocol says, read-only commands answer without "unsupported", the set of unsupported methods is exactly `overlay.capture`, `overlay.nativeHandle`, `overlay.mediaSourceId` (the three named in section 3), the demo terminal, no display mode.
- `tests/system-languages.test.js`, `tests/settings-save.test.js` (display mode), `src-tauri/src/demo.rs` tests.

### Smoke for the Tauri build

```
npm run test:smoke:tauri                              # the binary from CARGO_TARGET_DIR (debug), or --release, --bin <file>
node scripts/smoke-test-tauri.js --build --expect-window-tracking
```

`--build` builds the app with its own identifier (`capri.desktop.smoke`, through `TAURI_CONFIG`), so the single-instance socket of a running Capri is not shared. It starts the app with a temporary profile, a free port, a test Keychain service, `CAPRI_NO_MIGRATE=1` and a faked autostart, and checks: her page is ready, the core answers `getConfig`, the settings window opens and loads, a changed field reaches `config.json`, the window watcher is on (`--expect-window-tracking`; also the demo's terminal then), the sidecar comes back with a new pid after a SIGKILL, and no process of ours is alive after `!exit`. It kills only the pids it started, has a 3 minute limit, and exits non-zero with the log tail on a failure. Run here on macOS: all steps pass (about 25 s).
