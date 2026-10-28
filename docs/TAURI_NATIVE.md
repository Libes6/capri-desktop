# Native services of the Tauri build (TAURI-07)

What the system does for the core, in Rust (`src-tauri/src/`), and how the sidecar reaches it. The core runs in Node (`src/main/platform/sidecar.js`) and asks over the JSON-RPC lines of TAURI-04; `services.rs` is the one place that receives those requests. Slow ones (a dialog, the key store, a screen grab, the clipboard) are answered on their own thread, so the sidecar's other messages are not held up behind them.

| Module | platform method | RPC method | macOS | Windows | Linux |
|---|---|---|---|---|---|
| `secrets.rs` | `secrets.*` | `secrets.masterKey` | Keychain (`keyring`, apple-native) | Credential Manager | Secret Service (`sync-secret-service`, needs libdbus-1-dev to build) |
| `power.rs` | `power.on`, `getSystemIdleState` | notification `power`, `power.idle` | NSWorkspace + distributed `screenIsLocked` | message-only window: `WM_POWERBROADCAST`, WTS session | logind `PrepareForSleep` through `gdbus monitor` (no lock events, as in Electron) |
| `capture.rs` | `capture.screen` | `capture.screen`, `capture.permitted` | CGDisplayCreateImage (only if Screen Recording is already allowed) | not done (no picture) | not done (no picture) |
| `clipboard.rs` | `clipboard.writeImage` | `clipboard.writeImage`, `clipboard.writeText` | arboard | arboard | arboard (X11 and Wayland data-control) |
| `opener.rs` | `shell.*`, `app.appForProtocol` | `shell.openExternal`, `shell.openPath`, `shell.showItemInFolder`, `app.appForProtocol` | `open` crate, `open -R`, NSWorkspace | ShellExecute, `explorer /select,`, registry | xdg-open, FileManager1 over `dbus-send`, `xdg-mime` |
| `dialogs.rs` | `dialogs.pickFolder` | `dialogs.pickFolder` | tauri-plugin-dialog | same | same |

## API keys: the master key and `kc:`

The platform's `secrets.encrypt/decrypt` are synchronous, so a call to Rust per key is not possible. The system store holds **one** item, a random 256-bit master key (service `capri.desktop`, account `master-key`); the sidecar fetches it once in `platform.init()` (before the core is made) and seals each API key itself in `config.json`:

```
kc:<base64( 0x01 | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag )>
```

Electron's safeStorage values are `enc:<base64>`. `setup.js createKeys` takes the prefix from `platform.secrets.prefix` (`kc` here, `enc` by default) and reads a key sealed by the other kind as empty: never as a plain key, never as ciphertext handed to a provider. Migrating `enc:` to `kc:` is TAURI-09 (decrypt in the last Electron version, `sealKey` in the Tauri one, or enter again). The keys never reach her pages (the dispatcher's views strip them as before) or any log; the master key goes over the pipe to the sidecar only, and nowhere else.

No key store (a Linux without Secret Service, the keychain denied or locked, a store that does not keep what it is given): `isAvailable()` is false and the core does what it does in Electron without safeStorage: keys stay plain text in config.json. `CAPRI_KEYCHAIN_SERVICE=<name>` uses another service name (tests, try-outs), so the real item is never touched.

## Links, files, folders

`openExternal` opens only `http:`/`https:` (with a host) and the launchers' own schemes the core really uses (`steam:`, `com.epicgames.launcher:`, `spotify:`, `roblox:`), and `trash:///`. Everything else (`file:`, `javascript:`, `data:`, `ms-*:`, custom schemes) is refused in Rust, whoever asks; Electron leaves that to its callers. `openPath` and `showItemInFolder` need an absolute path that exists (`openPath` answers `''` or the reason, like Electron's). The folder picker is used from Rust only: no capability gives her pages a dialog command.

## Screen capture

`CGPreflightScreenCaptureAccess` is only read: nothing asks for the permission or grants it. Without it the answer is "no picture" (null), and the core's own "no picture of the screen" follows. The display is found by its frame (the `bounds` the core passes), not by an id, because the shell's display ids are indices. The image is drawn at the size asked (`width` x `height` pixels) by CoreGraphics, then encoded PNG or JPEG in Rust. The picture of the overlay itself (`overlay.capture`, the report card's copy button) is TAURI-05's.

## Power events

`src/main/power.js` and the macOS window watcher listen for `suspend`, `resume`, `lock-screen`, `unlock-screen`, `user-did-resign-active`, `user-did-become-active`; Rust sends each as a `power` notification `{ event }` and the sidecar re-emits it on `platform.power`. `hello` carries `locked` (read from the session at start), `getSystemIdleState` is `'locked'` from the events, else the idle state Rust last gave (CGEventSourceSecondsSinceLastEventType; refreshed by each call, at most once a second). The distributed lock notifications are delivered on the main run loop; in debug builds `CAPRI_POWER_TEST_NAME=<prefix>` adds `<prefix>.lock` / `<prefix>.unlock` to what is listened to, so the real path can be driven without locking the screen (or setting off password managers that listen for the real names).

## Window watchers

They stay in the sidecar (the helpers are spawned by Node, as in Electron); the power and screen events they use come from the platform as above. A sidecar that is a Node SEA executable (or when `hello.packaged`) is told `CAPRI_RESOURCES=<resources folder>` and looks for `<resources>/bin/capri-windows` (macOS Swift helper) and `<resources>/windows.ps1`; from a clone it uses the source folders. **TAURI-12 must bundle those two files there** (`npm run build:mac-helper` makes the first). The X11 utilities are not files: `linux/x11-watch.js` is in the bundle.

## Checked, and not

Run on macOS (arm64, this machine): all Rust tests; the system store round trip (a `capri.desktop.test.<random>` item made, read, deleted; `CAPRI_LIVE_KEYCHAIN=1`); the clipboard text round trip with the previous text put back (`CAPRI_LIVE_CLIPBOARD=1`); idle seconds; NSWorkspace notifications posted to the real observers; the screen-capture permission read and a refusal without it; protocol lookup. The live run of the whole app is described in the TAURI-07 report.

Never run: everything under `cfg(windows)` (compile-checked only for `x86_64-pc-windows-msvc`: power, registry lookup, `explorer /select,`), everything Linux (logind through `gdbus`, `dbus-send`, `xdg-mime`, Secret Service, arboard on X11/Wayland: not even compiled), screen capture on Windows and Linux (not written), the folder dialog (it needs a person; tested with a fake), the real lock and sleep events, the picture of a permitted screen end to end in the app (this machine's Screen Recording state is not changed).
