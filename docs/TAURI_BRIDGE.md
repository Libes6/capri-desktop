# The bridge release: Electron Capri updates itself into Tauri Capri (TAURI-13)

An installed Electron Capri has one way to learn of a new version: its own updater (CAPRI-11: `electron-updater` and, on a
Mac, `src/main/mac-update.js`), which reads `latest.yml` / `latest-linux.yml` / `latest-mac.yml` of the latest published GitHub
release. The **bridge** is a release whose three `latest*.yml` point at the **Tauri installers**. The Electron app does not know
the difference: it downloads the file, checks its size and sha512, and installs it the way it installs any update. Around that
this task adds: a key hand-over before the install (TAURI-09), a warning when it did not fully work, a Mac relaunch that does not
depend on Electron, an NSIS hook that removes the Electron installation, and the release scripts that write the feeds.

Code: `scripts/bridge-feed.js` (feeds), `bridge.json` (the switch), `scripts/release-tauri.js` / `scripts/draft-release.js` /
`scripts/package-tauri.js` (release folder), `src/main/updates.js` (`isTauriBridge`, `bridgeProblem`, the controller),
`src/main/mac-update.js` (`relaunchBundle`), `src/main/core.js` (`prepareBridge`), `src-tauri/windows/hooks.nsh` (Windows).
Tests: `tests/bridge.test.js`. Data that moves: [TAURI_MIGRATION_DATA.md](TAURI_MIGRATION_DATA.md). Tags, feeds, signatures of the
Tauri updater: [TAURI_UPDATES.md](TAURI_UPDATES.md). Pipeline: [TAURI_RELEASE.md](TAURI_RELEASE.md).

## 1. Two versions matter

| | What | Feed |
|---|---|---|
| **N**, the last Electron release | An ordinary Electron release that contains **this code** (the bridge detection, the hand-over, the Mac relaunch). `bridge.json` is `false`. | Electron installers, ordinary `latest*.yml` |
| **T**, the first Tauri release (`T > N`, semver) | Tauri installers **and** the Electron installers (for downloading by hand), `bridge.json` is `true`. | `latest.json` for Tauri apps, bridge `latest*.yml` for Electron apps |

Only an Electron app that is **already N** hands its keys over before it installs T. An Electron app older than N takes T as well
(its `latest*.yml` is the same file) but without the hand-over: its API keys have to be entered again, its login item is not
released. On a Mac it relaunches the old way (see 4), which still works on the default case-insensitive volume. So N has to be out
for a while before T; nothing in the feed can keep older copies from taking T.

## 2. The sequence

**Maintainer**

1. Release **N** as always (`main`, version bump, both draft jobs, check, publish). It carries this code; `bridge.json` stays `false`.
   Wait until the copies in use have updated (an Electron app also prepares the hand-over 8 s after every start, so a copy that
   runs for a while has `tauri-keys.json` ready even before it is asked).
2. Make **T**: bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `tauri.conf.json` (higher than N).
   Set `bridge.json` to `{ "tauri": true }` in the same commit. Merge to `main`. The two draft jobs run on that commit:
   - the Electron job (`draft-release.js`) uploads the Electron installers and **no** `latest*.yml` (the bridge's are not its to
     overwrite), says so in the notes;
   - the Tauri job (`release-tauri.js assemble` + `draft`) uploads the Tauri files, `latest.json`, `SHA256SUMS`, the Mac **bridge
     zip** (`Capri-T-macOS-arm64-bridge.zip`, made on the Mac runner by `package-tauri.js --collect`) and the three `latest*.yml`
     written from the bytes it uploads (`bridge-feed.js`). `checkRelease` refuses a folder whose feeds do not name this version,
     the `capriBridge: tauri` mark, the Tauri file names, the right sha512 and size.
3. Check the draft ([TAURI_RELEASE.md](TAURI_RELEASE.md) section 5, plus: the three `latest*.yml` name `Capri-T-…` files of this
   draft and carry `capriBridge: tauri`; `latest.json` is there). Publish by hand.
4. **Keep `bridge.json` true in every later release** until the Electron copies have gone (TAURI-14 decides when): an Electron app
   reads the `latest*.yml` of the *latest* release only, and a release without them gives it a 404 ("no update information").

**User (Electron N installed)**

1. Capri checks (45 s after start, or her settings, About, Check). It offers `T`; the About box adds that this update moves Capri to
   its new version and that settings, memory and hooks come along.
2. Download: the installer, verified (sha512, size).
3. "Update and restart", confirmed. **Before** anything is replaced, Capri hands over: each `enc:` key is opened with Electron's
   `safeStorage`, sealed again as `kc:` under the Tauri key store's master key, written to `tauri-keys.json` beside her config
   (`prepareTauriMigration({ releaseAutostart: true })`, which also takes Electron's login item off once its state is in the file).
4. If everything is in the file: the install goes on. If **not** (no key store tool, `safeStorage` unavailable, a key that did not
   open, the file not written): the update is **not blocked**. The About box shows which providers' keys will have to be entered
   again (or a general sentence), the button becomes "Update anyway", and a second confirmation repeats it. Only then does the
   install go on. Nothing is shown when there was nothing to carry over.
5. The installer runs (per system below); the Tauri Capri starts, imports config, memory, sounds, keys, the login item and the hooks
   (`migrate.js`, marker `migrated-from-electron.json`) and says once, in her words, which keys were lost.

If the install itself fails after the hand-over, the login item that was released is switched on again (nothing was replaced).

## 3. What makes an update a bridge (and only that one)

`isTauriBridge(info)` in `updates.js`: the `latest*.yml` has `capriBridge: tauri` **and** every file it names (`files[].url`, `path`)
has a Tauri release name (`Capri-X.Y.Z-(macOS|Windows|Linux)-…`; the Electron names are `-mac-`, `-win-`, `-linux-`). electron-updater
keeps unknown fields of the yml, so the mark reaches the app. A normal Electron update has neither, so it is never prepared, the
login item is never released for it, and nothing about the Electron to Electron path changes. Mark without Tauri names, or Tauri names
without the mark: not a bridge (the 8-second background hand-over has still run, so the keys are usually there anyway).

## 4. By system

### macOS (Apple Silicon: the only Mac the Electron build ever had)

`latest-mac.yml` lists one file: `Capri-T-macOS-arm64-bridge.zip`, made by `ditto -c -k --keepParent Capri.app` from the Tauri bundle
(`package-tauri.js bridgeZip`; the name has `arm64` and `.zip`, which is what `pickZip` wants). `mac-update.js` downloads it, checks
size and sha512, unpacks with `ditto` next to the bundle, and checks: one `.app`, a folder, **bundle id `capri.desktop`**, **version
= the version offered** (`CFBundleShortVersionString`), a code signature present (`codesign -d`: the Tauri bundle is ad-hoc signed,
which passes), removes the quarantine attribute, renames the running bundle to `.Capri-previous.app`, moves the new one in, relaunches.

What was different from an Electron to Electron update, and what was done:

- The executable is `Contents/MacOS/capri` (and `capri-sidecar`), not `Capri`. Electron's `app.relaunch()` execs the **old path**
  `…/Contents/MacOS/Capri`; it works only because the default volume is case-insensitive. Now a bridge relaunch is
  `mac.relaunchBundle`: a detached `/bin/sh` that waits for this process to exit (up to 30 s) and runs `/usr/bin/open <bundle>`. The
  path and pid are arguments, never part of the script text. The Tauri app is then started by the system (parent `launchd`), not as a
  child of the dying Electron.
- The backup `.Capri-previous.app` (the Electron app, 300+ MB, hidden) would stay forever: nobody runs `mac-update.js`'s cleanup any
  more. The Tauri build's `startTauriUpdates` calls `cleanup()` at its start, before anything else. **If the Tauri app does not
  start, the backup is still there**: see section 6.
- Same bundle id, so the system permissions (screen recording, automation) can stay granted for the same *path and identity*; an
  ad-hoc identity changes with every build, so macOS may ask again (TAURI_RELEASE.md section 6).
- The Tauri bundle is signed ad-hoc with the JIT entitlements; `codesign --verify --deep --strict` passes on the swapped bundle.

Needs the app to be where it can replace itself (not in a DMG, not translocated, a writable folder): otherwise the user is told
before anything is downloaded, as before.

### Windows (NSIS, per user)

`latest.yml` lists `Capri-T-Windows-x64-setup.exe`, the Tauri NSIS installer itself (the same file as in the release, no copy).
electron-updater (`NsisUpdater.doInstall`, read in `electron-updater` 6.6.2) runs: `<setup> --updated /S --force-run
[--package-file=…]` (`/D=` only if the app sets an install directory, which Capri does not). What the Tauri template (tauri-bundler
2.10 `installer.nsi`) does with that:

| Argument | Tauri NSIS |
|---|---|
| `/S` | NSIS silent mode; the template's `${Silent}` branches: no pages, the desktop shortcut is created |
| `--updated`, `--force-run`, `--package-file=` | not read by the template: ignored, harmless |
| `/D=` | NSIS's own (last argument, no quotes); not given |
| *(restart)* | the template restarts the app only on `/R`; Electron's installer does it for `--force-run` |

Two things differ from Electron's installer, solved by `src-tauri/windows/hooks.nsh` (`bundle.windows.nsis.installerHooks` in
`tauri.bundle.conf.json`):

1. **Where**: electron-builder installs one-click per user into `%LOCALAPPDATA%\Programs\Capri` with its own uninstall entry
   (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\9c5def90-78d9-5c70-9c3f-c0c732c63009`, the UUID v5 of the appId
   `capri.desktop`; a test checks the constant); Tauri installs into `%LOCALAPPDATA%\Capri` with the entry `…\Uninstall\Capri`.
   `NSIS_HOOK_PREINSTALL` finds the Electron entry, copies its `Uninstall Capri.exe` out of its folder and runs it the way
   electron-builder's own installer removes the previous version (`/S /KEEP_APP_DATA /currentuser --updated _?=<dir>`, waiting for it),
   then removes the leftovers. No `--delete-app-data`: `%APPDATA%\Capri` stays (that is where the migration reads from). The old
   shortcuts go with the old installation, the Tauri installer creates its own. Without the hook there would be **two Capris**.
   If the Electron folder is gone but its registry entries remain, only the entries are removed.
2. **Restart**: `NSIS_HOOK_POSTINSTALL` starts `capri.exe` as the user when `--force-run` was given (and `/R` was not).

`CheckIfAppIsRunning` of the template looks for `$INSTDIR\capri.exe` (Restart Manager on that path), not the running Electron
`Capri.exe`; Electron's own uninstaller closes the Electron app, as it does for Electron updates. electron-updater tries a
differential download first: there is no `.blockmap` for the Tauri installer, it logs that and downloads the whole file.

**Not run on Windows.** The hook and the argument analysis come from the sources above; `makensis` was not available on the
author's Mac either, so the `.nsh` is checked only by a test (the constant, balanced macros) and by reading. First CI/VM run: install
Electron N, then run `<setup>.exe --updated /S --force-run` from a console and look for: one Capri in "Installed apps", one Start
menu entry, Capri running from `%LOCALAPPDATA%\Capri`, `%APPDATA%\Capri` still there. The installer is not Authenticode-signed;
electron-updater checks a publisher name only if `app-update.yml` has one (it does not).

### Linux AppImage

`latest-linux.yml` lists `Capri-T-Linux-x64.AppImage`. electron-updater's `AppImageUpdater` downloads it (full download, no
blockmap), replaces the file `$APPIMAGE` points to (keeping its name and place), makes it executable and starts it. The Tauri
AppImage is an ordinary AppImage; its first start imports the Electron profile (`~/.config/Capri`). **Not run on Linux.**

### Linux .deb

No change: the app only tells there is a version and opens the release page. The Tauri `.deb` is a different package than the Electron
one; the user installs it by hand (and can remove the Electron package). Both can be installed side by side (section 7).

## 5. Trust

The Electron path trusts what it always did: the yml and the file come from this repository's GitHub release over HTTPS, and the
sha512 and size of the yml are checked (macOS: also by `mac-update.js`). The minisign `.sig` of the Tauri updater is **not**
checked on the bridge path (the Electron app does not know the key); the Tauri build's own updates verify it from then on. The bridge
feeds are written by the Tauri job from the bytes it uploads, and `checkRelease` re-checks every hash before the draft is made.

## 6. Going back

Nothing of the Electron profile was changed or deleted ([TAURI_MIGRATION_DATA.md](TAURI_MIGRATION_DATA.md), "Going back"). If the
Tauri Capri does not start or is not wanted:

1. Download the last Electron installer of release N (or any older Electron release) from the GitHub releases page and install it:
   macOS: replace `Capri.app` (drag from the DMG); Windows: run the Electron `-win-x64.exe` (it installs per user into
   `%LOCALAPPDATA%\Programs\Capri`; uninstall the Tauri one in "Installed apps" first if it started, or both exist); Linux: use
   the Electron AppImage / `.deb`. The Electron app opens its own profile as it was.
   macOS shortcut: if the Tauri app **never started**, `.Capri-previous.app` (hidden, beside `Capri.app`; `ls -a /Applications`)
   still holds the Electron app: delete `Capri.app`, rename `.Capri-previous.app` to `Capri.app`. After the Tauri app has started once,
   that backup is gone.
2. Hooks: the Electron menu item "Install hooks" (or `npm run hooks:install`, `hooks:codex:install`, `hooks:agy:install`) rewrites
   Capri's entries to the Electron command, without duplicates; only the commands: `node scripts/install-hooks.js --revert` and
   `revertHooks()` in `src/main/assistants.js`.
3. Login item: switch it on again in the Electron settings if the Tauri one replaced it.
4. Keys: the Electron `config.json` still has its `enc:` values; the Tauri master key item (`capri.desktop` / `master-key`) is harmless.
5. Because an Electron app takes the latest release, going back works for good only if a newer Electron release (or a release
   without the bridge) is published, or the Electron app's updates are ignored: its next check would offer T again, and it always asks
   before installing. To stop the offer, publish a fixed release with a higher version, or turn the bridge off in a new release.

## 7. Electron and Tauri installed at the same time

The bridge replaces the Electron install on macOS (same path), Windows (the hook) and the AppImage (same file). It can still happen
(Linux packages, a Tauri build installed by hand next to a Mac or Windows Electron copy that the hook did not see). What each does:

- **Single instance**: the Electron app locks its own profile (`SingletonLock` in its user data); the Tauri app uses the single-instance
  plugin (a socket named after the identifier, `/tmp/capri_desktop_si.sock` on macOS/Linux). The two locks are separate, so **both can
  run**. Two characters on the screen, both listening for the assistants' hooks.
- **Hook port**: both default to `127.0.0.1:47823`. The second to start finds it busy (`EADDRINUSE`, reported in its log) and
  receives no events; the first one gets all of them.
- **Hooks**: one set of entries in `~/.claude/settings.json` etc. The last of "Install hooks" (Electron) or the Tauri migration / its
  start-up check wins; each rewrites only Capri's own entries.
- **Login item**: two entries (macOS: two bundle ids or paths; Windows: the same Run value name is overwritten by the Tauri plugin, so
  one). When the Tauri build is set up from `tauri-keys.json`, the hand-over has already taken Electron's login item off.
- **Profiles**: separate folders (Electron `Capri`, Tauri `capri.desktop`); changes after the import do not travel between them.

## 8. What was run, and what was not

Live on this Mac (macOS 26, Apple Silicon, 2026-10-29), everything in a scratch folder: test builds with the bundle id
`capri.desktop.bridgetest` (Electron 0.1.0 from an isolated copy of this branch as `updater-smoke.js` does, `capriUpdaterTest`, a
loopback feed on `127.0.0.1:47862`; Tauri 0.1.1 from `package-tauri.js --collect` with `CAPRI_BRIDGE=1`; the feed folder from
`release-tauri.js assemble`), a throw-away profile for each build (`--user-data-dir`, `CAPRI_USER_DATA`), the Chromium mock keychain
for Electron's `safeStorage`, a test Keychain service `capri.desktop.test.<random>` (removed afterwards), the hook folders redirected
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGY_CONFIG_DIR`). The real profile, `~/.claude`, `~/.codex`, real login items and the real
Keychain items were not touched. No dialog blocked the run (the test service item is created with `CAPRI_KEYCHAIN_OPEN_ACL=1`, tests only; the real flow asks once, section 9).

| Step | Result |
|---|---|
| Electron 0.1.0 starts with a synthetic `config.json` (two `enc:` keys made by a real `safeStorage`), memory, a sound, Claude hooks of the Electron kind | ran; 8 s later `tauri-keys.json` held two `kc:` values, the test Keychain item existed |
| Check (About) | "Version 0.1.1 is available", plus the bridge hint (`isTauriBridge` true on the real electron-updater info) |
| Download | the 44 MB bridge zip, "downloaded and verified" (size and sha512 from the generated `latest-mac.yml`) |
| Update and restart, confirmed | `Capri.app` replaced: `CFBundleShortVersionString 0.1.1`, id `capri.desktop.bridgetest`, executable `capri`, `codesign --verify --deep --strict` ok; backup `.Capri-previous.app` beside it; the Electron process gone; **the Tauri app started about 2 s later, parent `launchd`** (started by `open`), with the test environment handed over |
| Import | `migrated-from-electron.json` written: config, memory, sounds copied; keys `moved: [openai, mistral]` (`kc:` in the new `config.json`, no plain key, no `enc:`); user name, memories, reminder, bond, language, persona, lines present; 12 Claude hook entries rewritten to `…/Contents/Resources/bin/capri-hook --assistant claude`; the app answered `/health` |
| Second run, key store tool made unavailable to Electron (`PATH`) | at install: warning in the About box naming OpenAI and Mistral, nothing installed yet, "Update anyway" (role `alert`); a second confirmation with the same text; then the same swap and start; marker `keys.lost: [openai, mistral]`, `notices: 1`, no key in the new config; the hidden Electron backup was **removed by the Tauri app at its start** |
| Cleanup | test processes stopped by pid, test Keychain item deleted, the test identifier's Caches/WebKit/Preferences entries removed |

Found and fixed during the run: the shell reports `packaged: false` until it is provisioned, so the backup cleanup must not be gated
on `isPackaged()`; and the relaunched app by `open` inherits nothing from the process, so the local test builds hand their test
variables over with `open --env` (only a build with `capriUpdaterTest`, whitelisted names).

**Not run**: Windows (NSIS over NSIS, the hook, `--force-run`), Linux (AppImage replace, `.deb`), the Intel Mac row, the login item
release on a real login item (unit-tested; the test bundles had none), a real GitHub release and the CI jobs with `bridge.json` true,
an older Electron (before N) taking the bridge zip, an Electron app in `/Applications` with App Management, Gatekeeper on a real
download, the "keys moved" case through a real macOS Keychain prompt (the real flow asks once, see TAURI_MIGRATION_DATA.md).

## 9. To do by hand

- Windows VM: the check in section 4. Linux VM: AppImage from N to T; `.deb`: only the notice.
- A Mac with a real Electron N in `/Applications`: update to T; look for the one Keychain prompt at the first start of T ("capri wants
  to use … `capri.desktop`"), which is the master key the Electron app made with `security`; "Always Allow".
- Decide when N is released and how long to wait before T; keep `bridge.json` true afterwards (section 2).
