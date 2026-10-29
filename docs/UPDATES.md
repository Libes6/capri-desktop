# Capri: in-app updates (CAPRI-11)

> The Tauri build updates through `tauri-plugin-updater`, same controller and rules: [TAURI_UPDATES.md](TAURI_UPDATES.md).

Installed copies of Capri learn about a new **published** release of the fork
[Libes6/capri-desktop](https://github.com/Libes6/capri-desktop/releases) and update from it. The behaviour follows
the user's Gustaf project (`docs/release.md` → Application behavior, `docs/updater-smoke.md`, `UpdateController`);
Gustaf is Tauri, Capri is Electron, so the behaviour was carried over, not the code.

Code: `src/main/updates.js` (controller, transports, which installations update), `src/main/mac-update.js`
(macOS install), wiring in `src/main/main.js`, UI in Settings → About (`src/renderer/js/settings.js`), texts in
`src/main/labels.js`. Tests: `tests/updates.test.js`, `tests/update-feed.test.js`, `tests/mac-update.test.js`,
`tests/release.test.js`.

## Behaviour

- One check about 45 s after start (skipped if a check was already asked for), plus **Check for updates** in
  Settings → About. No periodic polling, no automatic download, nothing installed on quit
  (`autoDownload=false`, `autoInstallOnAppQuit=false`, `allowPrerelease=false`, `allowDowngrade=false`).
- Statuses as in Gustaf: `disabled` (with a reason), `idle`, `checking`, `current`, `available`, `downloading`,
  `downloaded`, `installing`, `error` with category `network`, `signature` (checksum/verification) or `other`
  (`reason: feed` when no update files are published yet, `reason: location` when a Mac copy cannot replace itself).
- "This is the latest version" appears **only** after a check that succeeded and found nothing newer. Offline,
  HTTP 5xx, a missing feed (first release, 404), an inactive updater: an error, retried with Check.
- One operation at a time: a second check, download or install while one runs is ignored.
- **Download** is explicit. **Update and restart** appears only after a download that passed verification, and
  asks once more in a confirmation over the window (Later keeps the download). Then the app installs and restarts.
- About shows the installed version, the status, `installed → offered` version, the release notes as plain text
  (GitHub's HTML stripped, put in with `textContent`), progress (bytes / %), and the buttons that fit.
- Her menu shows **Update available: X…** while a version is offered; it opens Settings on About.
- She may mention the new version once per session through the initiative system (`ambient` kind): nothing at
  the Quiet level, never over a chat or prompt.
- IPC: `updates:check|download|install|page` from the settings preload only, each handler checks
  `settings.owns(e.sender)`; `updates:install` installs only with `confirmed === true` from the window's
  confirmation. `updates:page` opens only `https://github.com/Libes6/capri-desktop/releases/tag/…` (or `/latest`).
- Logs: `[capri] update: <status>`; error messages lose query strings (signed download URLs), feed XML and
  stacks, and are cut to 300 characters. No token exists in the app; none is needed for a public repository.
- Only a packaged app updates. `npm start`/`--dev` from source: disabled "Updates work only in the installed app";
  `--smoke-test`: disabled; a build without this repository's feed: disabled.

## By system

| System | Installation | What the app does |
| --- | --- | --- |
| Windows x64 | NSIS one-click, per user | electron-updater `NsisUpdater`: download (sha512 from `latest.yml`, blockmap for differential download), then `quitAndInstall(silent, runAfter)`. The installer is not Authenticode-signed; electron-updater's publisher check is skipped because no `publisherName` is configured. |
| Linux x64 | AppImage (`$APPIMAGE` set) | electron-updater `AppImageUpdater`: download (sha512 from `latest-linux.yml`), replaces the AppImage file, restarts. Needs write access to the AppImage's folder. |
| Linux x64 | `.deb` (no `$APPIMAGE`) | Check only (electron-updater picks `DebUpdater` from `resources/package-type`): the new version, its notes and **Open download page**, with "Installed from a package: update with your package manager, or download the new package by hand". No download, no `pkexec`/`sudo` from the app. |
| macOS arm64 | DMG / ZIP, no Developer ID | electron-updater's check; our own download and bundle swap (below), not Squirrel.Mac. |

### macOS without a Developer ID

electron-updater's `MacUpdater` (6.6.2, `out/MacUpdater.js`) downloads the zip and hands it to Electron's native
`autoUpdater`, i.e. Squirrel.Mac, through a local proxy. Squirrel.Mac installs an update only when the new bundle's
code signature satisfies the running app's designated requirement; Electron documents that the app must be signed
for automatic updates on macOS. Our builds are not even ad-hoc *bundle*-signed: with
`CSC_IDENTITY_AUTO_DISCOVERY=false` electron-builder skips signing, and the bundle carries only the linker's
ad-hoc signature of the Electron executable:

```
$ codesign -dv Capri.app        → flags=0x20002(adhoc,linker-signed)  Sealed Resources=none  Identifier=Electron
$ codesign --verify Capri.app   → code has no resources but signature indicates they must be present
```

So Squirrel.Mac cannot accept these updates (an ad-hoc designated requirement is the cdhash, different in every
build anyway). As Gustaf's Tauri updater does with its `.app.tar.gz`, `mac-update.js` installs by itself:

1. Before downloading: the bundle must be replaceable. Run from a DMG or `/Volumes/…`, translocated by Gatekeeper
   (`/AppTranslocation/`), or in a folder it may not write → error "Capri can't replace itself where it is. Move
   Capri.app to Applications…" with **Open download page**. Nothing is downloaded.
2. The arm64 zip of `latest-mac.yml` is downloaded into a temporary folder through electron-updater's HTTP
   executor (redirects, proxy, its own sha512 check), with progress.
3. Size and sha512 are checked again by us against `latest-mac.yml`; on mismatch the file is deleted
   (`signature` error, nothing installed).
4. On confirmation: `ditto -x -k` into `.Capri-update-staging` next to the bundle; exactly one `.app` inside;
   `CFBundleIdentifier` equal to the running app's (`capri.desktop`), `CFBundleShortVersionString` equal to the
   offered version; `codesign -d` must find a signature (Apple Silicon runs no unsigned code; `--verify` cannot be
   used, see above); `xattr -dr com.apple.quarantine`.
5. The running bundle is renamed to `.Capri-previous.app`, the new one moved into its place (same folder: atomic
   renames); if the second rename fails the first is undone. Then `app.relaunch()` + `app.quit()`.
6. The next start removes `.Capri-previous.app`, a leftover staging folder and old `capri-update-XXXXXX`
   downloads in the temporary folder.

If the new version does not start, the previous one is in `.Capri-previous.app` next to `Capri.app` until the next
successful start (show hidden files with Cmd+Shift+. in Finder).

**Difference from Gustaf (integrity).** Gustaf verifies a minisign signature made with a private key kept in
GitHub Secrets, independent of the files' host. Capri checks the sha512 listed in `latest*.yml` **of the same
release**, over HTTPS from GitHub. That protects against corrupted or truncated downloads and a tampered CDN, but
not against someone able to replace release assets (they can replace the yml too). A possible later improvement is
a separate update-signing key (Ed25519/minisign) with the private key in GitHub Secrets and the public key in the
app; it needs secrets and was deliberately not done here. Developer ID signing would also let a future version use
Squirrel.Mac and remove the Gatekeeper first-launch step.

Not verified on a real install: replacing a bundle in `/Applications` on macOS 13+, where the "App Management"
privacy control may ask for permission or refuse (it would surface as an install error with the previous bundle
put back). The local test below replaced a bundle in an ordinary folder. A user who opened Capri through
"Open Anyway" from Downloads may be translocated: the app then says to move it to Applications.

## Feed, provider and tag

`package.json` → `build.publish`: `{ provider: github, owner: Libes6, repo: capri-desktop, releaseType: release }`.
electron-builder writes it into `resources/app-update.yml` and generates `latest*.yml`; `--publish never` stays,
the token-less app only reads public URLs. `updates.js` (`readFeed`) refuses any other feed.

How electron-updater 6.6.2 `GitHubProvider` reads releases (`out/providers/GitHubProvider.js`), with
`allowPrerelease=false`:

1. `GET https://github.com/Libes6/capri-desktop/releases.atom` (titles and notes),
2. `GET https://github.com/Libes6/capri-desktop/releases/latest` with `Accept: application/json` → `tag_name`, used
   **verbatim** — no prefix stripped, no semver parse of the tag,
3. `GET …/releases/download/<tag>/latest-mac.yml` (`latest.yml` on Windows, `latest-linux.yml` on Linux x64): the
   **version comes from this file** and is compared with semver to the installed one; files resolve to
   `…/releases/download/<tag>/<name>`.

The tag is parsed only with `fullChangelog=true` (`/\/tag\/v?([^/]+)$/`), which Capri leaves off. So `fork-vX.Y.Z`
works as it is (`tests/update-feed.test.js` runs the real provider against a fake GitHub). Switching to `vX.Y.Z` is
not possible anyway: the fork inherits the author's tags `v0.1.0 … v0.4.4`. The inherited tags play no part: only
the release GitHub marks *Latest* in this repository counts. Drafts are invisible to the public endpoint, so a
draft offers nothing until a person publishes it.

Generic provider on `https://github.com/Libes6/capri-desktop/releases/latest/download/` (Gustaf's `latest.json`
approach) would work as well, since it reads the same yml. It was not chosen: it loses the release notes as edited
on GitHub at publication (it only has notes baked into the yml at build time) and the tag for the release-page
link. Both have the same small race if a release is published between reading the yml and downloading.

Notes:
- `fork-v0.1.0` is published without `latest*.yml` and installs of 0.1.0 have no updater. Until the first release
  made with this change is published, a build with it reports "No update information is published yet" (feed
  error), never "latest version".
- Publishing an older version after a newer one would make GitHub mark it Latest; installed newer copies ignore it
  (no downgrades), older ones would be offered it.
- `semver`: a release must have a higher `package.json` version than the installed one.

## Release pipeline

- electron-builder (`npm run dist:*`, `--publish never`) now writes `latest.yml` (NSIS), `latest-linux.yml`
  (AppImage and DEB entries), `latest-mac.yml` (zip, and dmg) and blockmaps: `Capri-X-win-x64.exe.blockmap`,
  `Capri-X-mac-arm64.zip.blockmap`, `Capri-X-mac-arm64.dmg.blockmap` (the AppImage embeds its own).
- `.github/workflows/build.yml` uploads `dist/latest*.yml` and `dist/*.blockmap` with the installers (not
  `builder-debug.yml`).
- `scripts/draft-release.js` requires all of them, checks that every `latest*.yml` names this version, lists only
  release assets under their exact names (`artifactName` `Capri-${version}-${os}-${arch}.${ext}`), with matching
  sha512 and size, and offers `.exe` / `.AppImage` / `.zip`; uploads them into the **draft** with the installers and
  lists them in `SHA256SUMS.txt`. It never publishes. No signing, secrets or automatic publication were added.

### What the maintainer does on GitHub

Nothing new to configure (no secrets, variables or permissions). For a release:

1. Bump the version (higher than the installed one) and merge to `main` as before; the workflow builds the draft.
2. Check the draft has the six update files next to the installers; edit the release notes (shown in the app as
   plain text).
3. Publish the draft by hand and keep it marked **Latest**. Only then do installed copies see it.
4. Keep the repository and its releases public (the app has no token).

## Local test (macOS)

`scripts/updater-smoke.js` (not packaged) builds two test apps from an isolated copy of the checkout and serves a
loopback feed, as Gustaf's `docs/updater-smoke.md`. Nothing touches the checkout, GitHub, a tag or a release.

```sh
OUT=/some/folder/outside/the/checkout
node scripts/updater-smoke.js build "$OUT"        # $OUT/0.1.0/Capri.app, $OUT/0.1.1/{zip, latest-mac.yml}
node scripts/updater-smoke.js serve "$OUT"        # http://127.0.0.1:47832/
node scripts/updater-smoke.js mode "$OUT" offline # update | current | offline | bad-sha | missing
```

The copy's `package.json` gets the test version, `capriUpdaterTest: true` and a generic feed on
`http://127.0.0.1:47832/`; only such a build accepts a loopback feed (`readFeed`), an ordinary build reads this
repository's GitHub releases only. Run the test copy with its own data and port, never the real profile:

```sh
ditto "$OUT/0.1.0/Capri.app" /tmp/capri-test/Capri.app
CAPRI_PORT=47901 /tmp/capri-test/Capri.app/Contents/MacOS/Capri --dev --user-data-dir=/tmp/capri-test-data
```

Settings → About: Check (offers 0.1.1) → Download → Update and restart → confirm. After the restart About shows
0.1.1 and Check says latest version. Switch the server's mode before installing to see the failures. In `--dev` the
debug bridge (`POST http://127.0.0.1:47901/debug/settings {"js": "…"}`) can drive the window.

### Result on this Mac (2026-10-28, macOS 26.7 arm64, test builds from the CAPRI-11 working tree)

| Step | Result |
| --- | --- |
| Feed offline (503) | "Could not reach GitHub…" (network), not "latest version" |
| Feed missing (404) | "No update information is published yet." |
| Feed at 0.1.0 | "This is the latest version" |
| Zip with altered bytes (`bad-sha`) | electron-updater's sha512 check refused it: verification error, download deleted, Install not offered |
| Normal feed | 0.1.1 offered, menu item "Доступно обновление 0.1.1…", 130 MB downloaded and verified |
| Confirmation | Later closes it and keeps the download; Update and restart installs |
| Install | bundle replaced by 0.1.1, app relaunched by itself with the same arguments, backup removed at start; About 0.1.1; Check → latest version |
| Bundle in a read-only folder | "Capri can't replace itself…" + Open download page, nothing downloaded |

Found and fixed during this test: `codesign --verify` cannot be used (see above; the builds above already had
the fix); the startup check overrode a download made before it, and a download never installed stayed in the
temporary folder (both fixed after the run and covered by unit tests, not re-run in this cycle).

Not verified: Windows NSIS and Linux AppImage updates on real systems, `.deb` notification, a real GitHub
release (none published with update files), `/Applications` and App Management, Gatekeeper translocation on a
real download, her optional line on screen, and the "Open download page" click (unit-tested only).

## The bridge to the Tauri build (TAURI-13)

A release whose `latest*.yml` carry `capriBridge: tauri` and name Tauri files replaces this app by the Tauri build. For that update
(and only that one: `isTauriBridge` in `updates.js`) the controller first calls `prepareBridge` (the key hand-over of TAURI-09 with
`releaseAutostart`); a hand-over that did not fully work does not block the update but shows a warning with the providers whose keys
must be entered again and asks again ("Update anyway"). On a Mac a bridge update is relaunched through `open`, not
`app.relaunch()`. Everything else of this document is unchanged for Electron to Electron updates. See [TAURI_BRIDGE.md](TAURI_BRIDGE.md).
