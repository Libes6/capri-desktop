# Moving the user's data from the Electron build to the Tauri build (TAURI-09)

Code: `src/main/migrate.js` (Tauri side, runs in the sidecar before the core is made), `src/main/migrate-prepare.js` and `src/main/keychain-cli.js` (Electron side), `src/main/seal.js` (the `kc:` format shared by both). Tests: `tests/migrate.test.js`.

Nothing of the Electron profile is deleted or changed by the Tauri build. The only thing it removes is `tauri-keys.json`, a file the Electron build made for it (sealed values only).

## The data map

| What | Electron (userData) | Tauri (userData) | How it moves |
|---|---|---|---|
| Folder | macOS `~/Library/Application Support/Capri`; Windows `%APPDATA%\Capri`; Linux `~/.config/Capri` (a clone run with `npm start` uses `capri-desktop`, looked for second) | macOS `~/Library/Application Support/capri.desktop`; Windows `%APPDATA%\capri.desktop`; Linux `~/.local/share/capri.desktop` (Tauri's `app_data_dir`, by identifier) | – |
| Settings, reminders (`reminders`), the bond (`bond`), what she knows of you (`userName`, `persona`, `myLines`, `memories`), language, size, provider and model | `config.json` | `config.json` | Copied, normalised (below). Kept if the new profile already has a config the user changed |
| API keys (`apiKeys`) | in `config.json`: `enc:<base64>` (safeStorage) or plain when safeStorage was unavailable | in `config.json`: `kc:<base64>` | `enc:` via the hand-over file (next section); plain values are sealed `kc:` on the way (when the key store works) |
| Chat history and Claude Code's session | `memory.json` | `memory.json` | Copied if the new profile has none |
| The user's own sounds | `sounds/*.mp3 .wav .ogg .m4a` | `sounds/` | Regular files only (no links, no sub-folders, 64 MB max each), never over an existing file |
| Screen grabs of the dev routes | `captures/` (only `--dev` packaged) | – | Not moved |
| Chromium's own files (`Cache`, `Cookies`, `Local Storage`, `Preferences`, `GPUCache`, `Singleton*`…) | yes | – | Not moved (nothing in them is Capri's) |
| Login item | the system (macOS login item of bundle id `capri.desktop`, Windows Run key), not in `config.json` | the system (plugin autostart: LaunchAgent / Run key) | Electron records its state in `tauri-keys.json`; set in Tauri only if it was on |
| Hooks of the assistants | `~/.claude/settings.json`, `~/.codex/hooks.json`, Antigravity's file: Capri's entries run `ELECTRON_RUN_AS_NODE=1 <Capri> capri-hook.js` | the same files, entries run `"<resources>/bin/capri-hook" --assistant …` | `migrateHooks(bin)` (TAURI-08), only Capri's own entries, backup `*.capri-backup-<time>` |
| The master key of `kc:` | – | the system key store: service `capri.desktop`, account `master-key` | created by the Electron build (or by Tauri if it comes first) |

Config normalisation: `render` is dropped (a Chromium drawing mode); `displayId` goes back to `null` (Electron's display ids are not the Tauri shell's, which are indices), so she starts on the primary screen. Everything else, including fields this version does not know, is kept. A config that is not valid JSON is skipped and noted (the core would read it as empty anyway); the memory and sounds still move.

## What the Tauri build does at a start

`startMigration` (in `sidecar/main.js`, after the platform's `init()` fetched the master key, before the core exists):

1. `CAPRI_NO_MIGRATE=1`, or `CAPRI_USER_DATA` set without `CAPRI_ELECTRON_USER_DATA` (a test or try-out profile on purpose): nothing, and the real Electron folder is never looked at.
2. Marker `migrated-from-electron.json` present: not imported again. Only keys still on their way (see below) are handled.
3. No Electron profile found (nothing of Capri's in it): nothing, no marker.
4. Each file by a temporary file and a rename: a crash leaves a whole file or none. A file that already exists in the new profile is never overwritten; the one exception is a `config.json` that holds only defaults (a Tauri start nobody has used), which is replaced and kept as `config.json.pre-migration`. A failure of one copy (full disk, permission) means no marker; the next start finishes what is missing and writes nothing twice.
5. Keys (next section), login item, hooks, and the marker `{ version, at, app, source, copied[], keys{moved, lost, pending}, autostart, hooks, notices }`.

Hooks are also looked at at every later start (the binary's path moves when the app is updated or moved): only entries that are Capri's and differ from the current command are rewritten, with a backup; without the binary (`CAPRI_HOOK_BIN`, or `<resources>/bin/capri-hook`, delivered by TAURI-12) nothing is touched.

## API keys: `enc:` to `kc:`

Electron's `safeStorage` is Chromium's os_crypt: its key is a "Capri Safe Storage" Keychain item on macOS, DPAPI + `Local State` on Windows, libsecret/kwallet on Linux. Another process cannot open it reliably (on macOS it asks the user's permission for someone else's item), so the Electron build, which can, does the work before it is replaced (`prepareTauriMigration`, called 8 s after each start, and by TAURI-13 just before installing the update with `releaseAutostart: true`):

1. `safeStorage.decryptString` each `enc:` key.
2. Master key: the one in the system key store (service `capri.desktop`, or `CAPRI_KEYCHAIN_SERVICE`; account `master-key`) if there is one, else a new random 256-bit key put there and read back.
3. Each key sealed as `kc:<base64(0x01 | nonce | AES-256-GCM | tag)>` (the same code as the sidecar's, `seal.js`) and written to `<Electron userData>/tauri-keys.json` with `sha256(enc value)` of its source, and the login item's state. No plain key is written anywhere; the master key goes to the store through stdin (macOS `security -i`, Linux `secret-tool`).
4. Any failure (no tool, no store, the store keeps nothing, safeStorage down): no keys are written, `keysSkipped` says why, Electron's data are untouched.

The Tauri build, for each provider that had an `enc:` key and has none yet in the new config: the sealed value must match the source (`sha256`) and open with the platform's master key; then it is put in the new config as it is. Afterwards `tauri-keys.json` is removed. If the key store is down at that start, the file waits and the next start tries again (`keys.pending` in the marker). A key that cannot be carried over is left out of the config (never copied as ciphertext, never taken as a plain key) and listed as `keys.lost`; her page then says (once per launch, at most 3 launches, in the 5 languages, `keysLost` in `lines.js`): she could not carry the key over, enter it again in her menu, AI model, API key. The normal "no key" flow of her chat also asks for it.

### Limits by system

| | Status |
|---|---|
| macOS | Checked live: real Electron 44 `safeStorage` (mock keychain, a temporary profile) wrote `tauri-keys.json` and the test item (`capri.desktop.test.<random>`, removed afterwards) through `security`; the Tauri app (Rust `keyring`) read it, verified the key and put `kc:` in a temporary profile. **A system password prompt appears at the first read by the Tauri app**: the item is made by `/usr/bin/security`, so macOS asks "capri wants to access the key capri.desktop in your keychain" and wants the login password (Always Allow makes it stick). Not allowing it means no key store for that run: the core then behaves as TAURI-07 says (keys plain in config.json), and the keys are lost from the migration. A build signed with the same team on both sides could avoid the prompt by creating the item from a helper in Electron's own signed app instead of `security` (not done). |
| Windows | Written, not run. `cmdkey /generic:master-key.capri.desktop /user:master-key /pass:<key>` (target as in keyring's `"{user}.{service}"`; the key is briefly a command line argument; `cmdkey` stores UTF-16 which keyring reads, unverified). An item already there cannot be read by `cmdkey`, so it is never overwritten: the keys then are not handed over (re-enter). |
| Linux | Written, not run. `secret-tool store/lookup` with the attributes keyring's sync-secret-service uses (`service`, `username`, `target=default`, `application=rust-keyring`), the secret on stdin. Without Secret Service nothing is handed over and the keys are re-entered. Linux has no login item here (as before). |

If a key did not move, the user enters it again (her menu, AI model, API key, or her chat asks). The old key is still in the Electron app's profile.

## Login item

The config holds no autostart setting; the Electron build writes the state of its login item into `tauri-keys.json` (`autostart`). On the import, if it was `true` and the system has the feature (macOS, Windows), the Tauri build calls `platform.autostart.set(true)`; if it was `false` or unknown it does nothing. The Tauri build cannot remove Electron's entry (macOS: SMAppService under the same bundle id; Windows: the same Run value name, which the plugin overwrites): the Electron build removes its own when it hands over with `releaseAutostart` (TAURI-13 passes it at install time). In tests `CAPRI_AUTOSTART_FAKE=<file>` replaces the system; the real login items were never touched.

## Going back to the Electron build

Nothing was deleted: install the last Electron release again and it opens its own profile as it was (its `config.json` was never changed by the Tauri build; whatever the user did in the Tauri build since stays in the Tauri profile and is not carried back). To bring the hooks back:

- the Electron build's menu item "Install hooks" (or `npm run hooks:install` / `hooks:codex:install` / `hooks:agy:install`) rewrites Capri's entries, `capri-hook` ones included, to the Electron/Node command, without duplicates;
- or only the commands: `node scripts/install-hooks.js --revert` (Claude Code), and `revertHooks()` of `src/main/assistants.js` for all three (`hooks-command.js revertFile`, same safety as the migration: only Capri's entries, a backup, an unreadable file left alone; idempotent; the migration can then be run again).
- The login item: turn it on again in the Electron build's settings if the Tauri one replaced it.
- The master key item (`capri.desktop` / `master-key`) is left in the key store and is harmless; delete it in Keychain Access / Credential Manager if wanted (the Tauri build's `kc:` keys then cannot be opened).
- To import again: remove `migrated-from-electron.json` (and `config.json` if you want the Electron settings to win).
