# Capri (Tauri): in-app updates (TAURI-10)

The behaviour of the Electron build ([UPDATES.md](UPDATES.md), CAPRI-11) and of the user's Gustaf project
(`docs/release.md` → Application behavior, `docs/updater-smoke.md`), on `tauri-plugin-updater`. The rules live
in the same controller (`src/main/updates.js`, `UpdateController`), which runs in the Node core; only the
transport changed. Electron's transports are untouched and still used by the Electron build: `startUpdates`
picks by `platform.updater.transport` (`'tauri'` only on the sidecar platform).

## How it is put together

```
settings window ── updates:check|download|install ──► core (Node sidecar): UpdateController
                                                         │ platform.updater.get().tauri  (platform/sidecar.js)
                    notifications  updater.check|download|install { id }
                                                         ▼
                                           Rust shell: src-tauri/src/updater.rs ── tauri-plugin-updater ── HTTPS ── latest.json, package
                    notifications  updater.progress { id, received, total } · updater.result { id, ok, result | error }
```

- Rust drives the plugin (`app.updater_builder().build()?.check()`, `Update::download`, `Update::install`); the
  webviews never call it and no capability grants the plugin anything (`capabilities/*.json` are unchanged).
- Asked and answered with **notifications**, not requests: the sidecar's stdout reader (`sidecar.rs`) answers
  requests one at a time, and a download must not hold up the overlay's own questions. Every call has an id, a
  time limit on the core's side (check 60 s, download 2 min without progress, install 5 min), and Rust refuses a
  second operation while one runs (`BusyGuard`).
- `download` returns only after the plugin verified the **minisign signature** of the package against the public
  key in the build. The bytes stay in Rust (`Held`), and only they can be installed. A failed verification is
  `error (signature)`; nothing is installed.
- Errors reach the window as the controller's categories: `signature` (minisign, base64, signature text),
  `network` (HTTP, DNS, a feed that does not answer, 5xx, an unreachable download), `other` (+ `reason: feed` when
  the feed has nothing for this system, `reason: location` when the app cannot replace itself: permissions, mount).
  Messages lose query strings, are one line, at most 300 characters.
- Restart: macOS/Linux, `Update::install` replaces the app and the core calls `platform.app.relaunch()` (the
  shell stops the sidecar, then `AppHandle::restart`). The confirmation ("Update and restart") comes **before**
  `install`, in the settings window, as in Electron: `updates:install` runs only with `confirmed === true`.
  Windows: the NSIS installer ends the process itself; the shell stops the sidecar before running it (the sidecar
  is a file of the install) and restarts the app if the installer could not start. `tauri-plugin-process` is not
  used: `AppHandle::restart` is what its `relaunch` calls, and the shell already relaunches that way.

## Statuses and rules (same as CAPRI-11 / Gustaf)

`disabled` (reason) · `idle` · `checking` · `current` · `available` · `downloading` · `downloaded` · `installing` ·
`error` (`network` | `signature` | `other`). "This is the latest version" only after a check that succeeded and
found nothing newer; offline, 5xx, an unpublished feed, an inactive updater are errors. One operation at a time;
one check about 45 s after start plus the manual **Check for updates**; no automatic download, nothing installed
on quit; the restart is confirmed; no secret in the app (the public key is public; the repository is public so the
feed needs no token). Tests: `tests/updates-tauri.test.js` (all statuses, signature/network/other, duplicate
operations, the protocol with Rust) and `src-tauri/src/updater.rs` (`cargo test`).

## When updates are on: only a provisioned build

As Gustaf's `configured()`: the plugin is **registered** and the mode is `install` only if the build's
configuration has a non-empty `plugins.updater.pubkey` and `endpoints` that are all `https://`. The committed
`tauri.conf.json` has no `plugins.updater` (a test pins that), so:

| Build | `status` for the core |
|---|---|
| `npm run tauri:dev`, `cargo build` (not a bundle) | disabled `dev` (macOS: the executable is not inside `X.app/Contents/MacOS`) |
| bundle made without `CAPRI_UPDATER_PUBLIC_KEY` | disabled `feed` |
| macOS `.app`, Windows NSIS, Linux AppImage with a key | `install` |
| Linux `.deb` / other package with a key | `notify`: the check only, the version and notes are shown, the package manager installs |
| `--smoke-test` | disabled `smoke` |

The key and the endpoint are put into the build, never committed: `scripts/updater-config.js` prints the
configuration to merge (`--config`) from the environment variable `CAPRI_UPDATER_PUBLIC_KEY`:

```sh
CAPRI_UPDATER_PUBLIC_KEY="$(cat capri.key.pub)" node scripts/updater-config.js > updater.conf.json
TAURI_SIGNING_PRIVATE_KEY=... TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... \
  cargo tauri build --config src-tauri/tauri.bundle.conf.json --config updater.conf.json
```

The endpoint is fixed in the script: `https://github.com/Libes6/capri-desktop/releases/latest/download/latest.json`
(`createUpdaterArtifacts: true` is in the same configuration: it makes the bundler produce `*.app.tar.gz` /
`*-setup.exe` / `*.AppImage` and their `.sig`). A key that is a path, a private key or plain text is refused.

Plain `http` is accepted only by a binary compiled with `CAPRI_LOCAL_UPDATER_TEST=1` **and** with
`dangerousInsecureTransportProtocol: true` in its embedded configuration, and then only `http://127.0.0.1`
without credentials (`configured_with`, unit-tested). Only the local smoke script builds like that. In such a
build Rust also reports `test: true`, and only then does the core run `CAPRI_UPDATER_SMOKE_STEPS`
(`check,download,install`, restart confirmed) instead of waiting for the settings window.

## The feed: `latest.json`

```json
{ "version": "0.3.0", "notes": "…", "pub_date": "2026-10-28T10:00:00.000Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<.sig text>", "url": "https://github.com/Libes6/capri-desktop/releases/download/fork-v0.3.0/Capri-0.3.0-macOS-arm64.app.tar.gz" },
    "windows-x86_64": { "signature": "…", "url": "…/Capri-0.3.0-Windows-x64-setup.exe" },
    "linux-x86_64":   { "signature": "…", "url": "…/Capri-0.3.0-Linux-x64.AppImage" } } }
```

`node scripts/release-manifest.js <artifacts> <version> [--notes file] [--out dir]` (tests:
`tests/release-manifest.test.js`) takes `<artifacts>/<platform>/` with the one update package of each platform and
its `.sig`, and writes, into `<out>`, the packages under their release names (`Capri-<version>-<OS>-<arch>.<ext>`
as `macOS-arm64.app.tar.gz`, `Windows-x64-setup.exe`, `Linux-x64.AppImage`; copied byte for byte), the `.sig`
files, `SHA256SUMS` and `latest.json`. It fails, and writes nothing, for a missing platform, a missing or empty or
odd signature, two packages for a platform, an empty package, a version that is not stable `X.Y.Z`. An Intel Mac
(`darwin-x86_64`) is optional. No key is read; the URLs name the release's own tag (`fork-vX.Y.Z`), never `/latest/`.
The Tauri names are chosen not to collide with the Electron ones in the same release (`Capri-0.3.0-win-x64.exe`,
`-mac-arm64.zip`, `-linux-x86_64.AppImage`, `-linux-amd64.deb`): capital OS names, other suffixes (a test pins it).
The installers for people (dmg, deb, NSIS) are not in the feed; the CI (TAURI-12) adds them to the draft.

## Tags and releases: not mixing Electron and Tauri

What exists: `fork-vX.Y.Z` (this fork's Electron releases, `electron-updater` reads them) and the inherited `v0.x`
(old, upstream). Facts that decide the scheme:

- `releases/latest` (so `…/latest/download/latest.json`) is the newest **published** (not draft, not
  pre-release) release **by creation date**, not by version or tag name. electron-updater's GitHub provider
  also takes the newest non-pre-release release and reads `latest*.yml` from *that* release's tag.
- So one published release is read by both worlds, and what it holds decides who can update from it.

Rules:

1. **One version line, one tag scheme: `fork-vX.Y.Z`.** The Tauri build has the same `X.Y.Z` as the Electron
   `package.json` of the same commit. No separate `tauri-v*` tags: a second line would make "latest" ambiguous.
   The inherited `v0.x` releases stay as they are; never re-publish or edit one into "latest".
2. **Until the bridge (TAURI-13) is released, no Tauri release is published.** The CI (TAURI-12) only makes
   **drafts**; a draft is invisible to `latest` and to electron-updater. Trial builds of the Tauri app that need a
   public feed are published as **pre-releases**, which neither `latest` nor electron-updater
   (`allowPrerelease = false`) ever sees.
3. **The bridge release (and every release after it, until Electron is removed in TAURI-14) carries both feeds**:
   `latest.yml` / `latest-mac.yml` / `latest-linux.yml` (+ the Electron assets, which TAURI-13 points at the Tauri
   installers) **and** `latest.json` (+ the Tauri assets above). An Electron user updates through the first, a
   Tauri user through the second; the file names do not overlap.
4. **After the first Tauri build is installed anywhere, never publish a release without `latest.json`**: a Tauri
   app asking `latest/download/latest.json` of such a release gets a 404, which it reports honestly as
   `error (other, feed)` and never as "current", but it cannot update until a complete release is published.
   TAURI-12's workflow should fail a draft without it.
5. A feed names the immutable tag of its own release, so a feed fetched before a newer release keeps meaning the
   same files. The plugin offers only a version greater than the installed one (no downgrade).
6. Key rotation is not possible for installed apps (they trust the embedded public key): losing the private key
   means installing a new build by hand. Back it up.

## What is needed on GitHub (nothing is done by this task)

1. Generate the key pair yourself, outside the repository: `cargo tauri signer generate -w ~/.tauri/capri.key`
   (with a password). Keep the backup safe.
2. Repository **variable** `CAPRI_UPDATER_PUBLIC_KEY`: the content of `capri.key.pub` (not a path).
3. Repository **secrets** `TAURI_SIGNING_PRIVATE_KEY` (content of `capri.key`) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. For the draft job of TAURI-12: Actions with `contents: write` for the workflow token; the repository public.
   No Apple/Windows certificate is needed for updates (macOS is ad-hoc signed, `bundle.macOS.signingIdentity "-"`,
   and the Windows installer is not Authenticode-signed: SmartScreen may warn).

## By system

| System | Installation | What the app does | Checked |
|---|---|---|---|
| macOS arm64 | `.app` (ad-hoc signature) | the plugin unpacks `.app.tar.gz` and replaces the bundle (`mac-update.js` is not used); the core relaunches | **live, here** (below) |
| Windows x64 | NSIS | the plugin runs the installer (`/P` passive, `/R` restarts the app) and the process ends | not run |
| Linux x64 | AppImage | the plugin replaces the AppImage file (needs write access to its folder); the core relaunches | not run |
| Linux x64 | `.deb` | `notify`: version and notes, nothing downloaded or installed by the app | decision logic unit-tested only |

Needs the app to be where it can replace itself: not in a mounted DMG, not in a read-only folder. A failure to
replace is `error (other, location)` and the app stays as it was.

## macOS bundle: what the local test found

- The bundler signs even ad-hoc bundles with the **hardened runtime**; the Node sidecar (V8 needs JIT memory) then
  dies at start with SIGTRAP in `pthread_jit_write_protect_np`. `src-tauri/Entitlements.plist`
  (`allow-jit`, `allow-unsigned-executable-memory`) fixes it; `tauri.bundle.conf.json` names it and sets
  `signingIdentity: "-"`. TAURI-12 should keep both.
- `cargo tauri build` refuses a `frontendDist` that contains a `node_modules` folder, so `stage-frontend.js` now
  stages the fonts under `vendor/` and rewrites the staged styles to match.
- A Tauri app of the identifier `capri.desktop` takes the single-instance lock `/tmp/capri_desktop_si.sock`: a
  second copy (any build, any worktree) exits at once after telling the first. The test build therefore uses the
  identifier `capri.desktop.updatertest`, which also keeps it away from a running ordinary Capri.

## Local update test (macOS)

`node scripts/updater-smoke-tauri.js` (needs the Tauri CLI: `cargo install tauri-cli --root <dir> --version '^2'`,
then `PATH=<dir>/bin:$PATH`, or `CAPRI_TAURI_CLI`). Everything goes in a scratch folder **outside** the repository
(`<out>`); nothing touches the checkout, GitHub, tags or releases, and the app runs from `<out>`, never from
`/Applications`, with its own profile (`CAPRI_USER_DATA`) and hook port (`CAPRI_PORT`).

```sh
node scripts/updater-smoke-tauri.js build <out>     # test key (`cargo tauri signer generate`, empty password, <out>/keys),
                                                    # isolated copy of the sources, bundles 0.1.0 and 0.1.1 signed with it
node scripts/updater-smoke-tauri.js serve <out>     # http://127.0.0.1:47833/latest.json  (second terminal)
node scripts/updater-smoke-tauri.js run <out> check,download,install   # a fresh 0.1.0 copy, steps, its log
node scripts/updater-smoke-tauri.js mode <out> current|update|bad-signature|broken-download|offline
```

The test key is good for nothing else, is never printed, and the private key is never in the repository. The
server modes: `update` (0.1.1 offered), `current` (0.1.0), `bad-signature` (one bit of the signature flipped),
`broken-download` (503 on the package), `offline` (503 on the feed). Stop the server to try a refused connection.
The settings window of the Tauri build is TAURI-06's, so the steps are run by the core itself
(`CAPRI_UPDATER_SMOKE_STEPS`, only in this test build); the buttons and the confirmation dialog of the window are
the same code as in Electron and are not exercised here.

### Result of the run on this Mac (macOS 26, Apple Silicon, 2026-10-28)

Two ad-hoc-signed bundles (0.1.0 and 0.1.1, `capri.desktop.updatertest`, 42 MB `.app.tar.gz`) signed with a
freshly generated test key, a loopback feed, the app run from a scratch folder with a temporary profile:

| Mode | Steps | Result in the app's log |
|---|---|---|
| `update` | check, download, install | `checking`, `available 0.1.1`, `downloaded 0.1.1`, `installing 0.1.1`; the bundle in place now reads 0.1.1 and passes `codesign --verify --deep --strict`; the app restarted, printed `tauri install 0.1.1`, `checking`, `current`; the profile was kept |
| `current` | check | `current` |
| `bad-signature` | check, download, install | `available 0.1.1`, then `error (signature): The signature verification failed`; no `installing`, the bundle stays 0.1.0 |
| `broken-download` | check, download, install | `available 0.1.1`, then `error (network)`: download 503; nothing installed |
| `offline` (feed 503) | check | `error (network)`, never `current` |
| server stopped | check | `error (network)`: connection refused, never `current` |

Not run: Windows (NSIS) and Linux (AppImage, deb): the code paths are there and the decision logic is unit-tested,
but nothing was executed on those systems. Not exercised either: the settings window's buttons and the restart
confirmation dialog (TAURI-06 makes that window in the Tauri shell), a real GitHub feed, a notarized or
Developer ID build, an app installed in `/Applications` or in a read-only place.
