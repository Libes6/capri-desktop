# Capri (Tauri): packages, CI and releases (TAURI-12)

How the Tauri build is packaged, what `.github/workflows/tauri-release.yml` does, what has to be set up on GitHub, and
how a draft is checked before somebody publishes it. The formats of the feed, the signature and the tag rules are in
[TAURI_UPDATES.md](TAURI_UPDATES.md); the sidecar in [TAURI_SIDECAR.md](TAURI_SIDECAR.md). Pattern: the Gustaf project's
`release-build.yml` and `docs/release.md`. This is the only release pipeline (the Electron one was removed in TAURI-14).

## 1. Packaging on one machine

```sh
cargo install tauri-cli --locked --version '=2.12.4' --root ~/tools/tauri-cli     # once, outside the repository
export CAPRI_TAURI_CLI=~/tools/tauri-cli/bin/cargo-tauri                           # or put cargo-tauri on PATH and use `cargo tauri`
npm ci --ignore-scripts                                                            # no install script is needed
npm run tauri:package                                                              # this machine's platform
```

`scripts/package-tauri.js` does, in this order (each step is native to the machine: Node SEA and the Swift helper cannot
be cross-built):

1. stages her pages (`stage-frontend.js`);
2. builds the sidecar (`build-sidecar.js --target <triple>`) into `src-tauri/binaries/capri-sidecar-<triple>[.exe]`, the name
   `externalBin` wants (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`);
3. builds `capri-hook` (`crates/capri-hook`, `--release --locked`) into `src-tauri/resources/bin/`;
4. macOS: builds the window helper (`build-mac-helper.js --required`) into `resources/bin/capri-windows`; Windows: copies
   `src/main/windows.ps1` to `resources/windows.ps1`;
5. `cargo tauri build --bundles <app,dmg | nsis | appimage,deb>` with three merged configurations: `tauri.bundle.conf.json`
   (externalBin, `Entitlements.plist`, ad-hoc identity `-`), the `bundle.resources` map made by the script (the paths above
   become `Resources/bin/capri-hook`, `Resources/bin/capri-windows`, `windows.ps1`: where `findHookBin`,
   `mac/window-watch.js` and `windows.js` look) and, with `CAPRI_UPDATER_PUBLIC_KEY`, `scripts/updater-config.js`;
6. verifies the result without installing it: macOS the files inside `Capri.app` + `codesign --verify --deep --strict` + the
   JIT entitlements on the sidecar; Linux the file list of the `.deb`; Windows the NSIS file list through 7-Zip;
7. `--collect <dir>` copies the installers and the update package with its `.sig` to `<dir>/<platform>/`.

Everything generated (`src-tauri/binaries`, `resources`, `frontend`, `target`) is git-ignored. Options: `--no-updates`,
`--require-updates` (a release build must have updates on), `--bundles`, `--skip-build`; `npm run tauri:package:verify` only
re-checks. `CAPRI_APP_IDENTIFIER` replaces the identifier for a test build (the single-instance socket is named after it).
**Without `CAPRI_UPDATER_PUBLIC_KEY` the package has updates off and the script says so**; with it the private key
(`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`) must be there or the script stops.

`npm run tauri:package-smoke -- <executable> [--expect-window-tracking]` (`scripts/package-smoke.js`) starts a packaged app with
a temporary profile (`CAPRI_USER_DATA`) and its own bridge port, waits for the core's
`listening on 127.0.0.1:<port>` line, `GET /health`, on macOS `window tracking: on`, and stops the process it started. The
fuller scenario is TAURI-11's `smoke-test-tauri.js`.

## 2. The workflow `tauri-release.yml`

| Trigger | Builds | Update key | Draft release |
|---|---|---|---|
| `pull_request` to `main` / `feat/tauri` | all four platforms | no (no secrets): updates OFF, a warning | no |
| `push` to `feat/tauri` | all four | yes, if configured | **no** (the commit is not main's) |
| `push` to `main` | all four | **required** | yes, `fork-v<version>`; skipped if that version is already public |
| `workflow_dispatch` (+ input `draft`, `notes`) | all four | required when `draft` | only with `draft: true`; refuses a public version |

Why this scheme: tags are `fork-vX.Y.Z` (TAURI_UPDATES.md), and a release is one tag at one commit. The Tauri job drafts from
`main`, in the push that changed it, and the script refuses to put files into a draft that already holds files that are not
its own from **another** commit. Trial builds that need a public feed are published by a human as pre-releases.

Jobs: **plan** (ubuntu; `contents: write` only because drafts are invisible to a read token; versions of `package.json`,
`Cargo.toml`, `tauri.conf.json` must agree; asks GitHub whether the tag's release is none / draft / published) → **build**
(matrix `macos-15` arm64, `macos-15-intel`, `windows-latest`, `ubuntu-24.04`; `fail-fast: false`) → **draft**
(`contents: write`; concurrency group `capri-fork-release`, so two drafts never run at once).

The build job: Node 22 (npm cache), stable Rust with `Swatinem/rust-cache`, Linux packages (`libwebkit2gtk-4.1-dev`, GTK,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `libssl-dev`, `libdbus-1-dev` for the key store, `libxdo-dev`,
Xvfb/openbox/picom/`x11-utils` for the run check), `npm ci --ignore-scripts`, `npm test`, `cargo test` of the shell (after `stage-frontend.js`: the shell embeds `src-tauri/frontend` at compile time, so a clean checkout does not compile without it) and of
`capri-hook`, the Tauri CLI (pinned, cached right after it is built), then `package-tauri.js --collect` with the secrets given to that step only (never on a pull request: it gets none, even from this repository), then
the run check of the **package**: macOS the `.app` itself (+ helper and `capri-hook` present, window tracking on); Windows the
NSIS installer is run silently into a temp folder and the installed `capri.exe` started; Linux the `.deb` unpacked and its
`usr/bin/capri` started under Xvfb. Artifacts `tauri-<platform>`, 14 days.

The draft job: `release-tauri.js assemble` (release names, `.sig`, `.dmg`/`.deb`, `SHA256SUMS`, `latest.json`; fails for a
missing platform/installer/signature, odd version) → `verify-signatures.js` (the minisign signatures of every package against
the public key, the same check the app's updater makes) → `release-tauri.js draft`: re-checks the folder (feed URLs name
`fork-vX.Y.Z` and files that are there, `.sig` = the feed's signature, every hash), then creates or updates the **draft**
(`draft: true` is the only value ever sent; a public release stops it; a tag that exists at another commit stops it), replaces
only its own assets, deletes its own stale ones (never a file that is not its own), and keeps its notes between
`<!-- capri-tauri:begin/end -->` markers. `latest.json` is
uploaded last. The tag is created by GitHub when a human publishes the draft.

No secret reaches `npm test`, `cargo test` or the smoke steps. Actions are pinned to major versions (`@v4`, `@stable` for the
Rust toolchain).

## 3. What the maintainer sets up on GitHub

Nothing is set by this task.

1. A key pair outside the repository: `cargo tauri signer generate -w ~/.tauri/capri.key` (with a password). Back it up: an
   installed app trusts only this key, and it cannot be rotated for installed copies.
2. Repository **variable** `CAPRI_UPDATER_PUBLIC_KEY` = the content of `capri.key.pub` (not a path).
3. Repository **secrets** `TAURI_SIGNING_PRIVATE_KEY` (the content of `capri.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Actions must be allowed to run; the workflows declare their own permissions (`contents: read` by default, `contents: write` only in the plan and draft jobs), so the repository's default token permission may stay read-only only if the workflow-level request is honoured; if drafts fail with 403, set Settings → Actions → General → Workflow permissions to read and write.
5. The repository is public (the feed `releases/latest/download/latest.json` carries no token).
6. Optional: protect `main` / require review so that a push to `main` is deliberate; every push to `main` that does not bump
   the version rebuilds and re-drafts the same version until somebody publishes it.

Without 2 and 3 the workflow still builds (pull requests, `feat/tauri`, a manual run without `draft`) but the packages have
updates off and no `.sig`; a run that has to make a draft stops with an explanation.

## 4. Tags and releases

One tag per version: `fork-vX.Y.Z`, the same `X.Y.Z` in `package.json`, `Cargo.toml` and `tauri.conf.json` (checked by the
workflow and by a test). The draft holds `Capri-X-Windows-x64-setup.exe`, `-Linux-x64.AppImage`, `-Linux-x64.deb`,
`-macOS-arm64.dmg`, `-macOS-arm64.app.tar.gz` (+ `-macOS-x64.*` if the Intel row is built), `latest.json`, one `.sig` per update
package and `SHA256SUMS`. The draft job runs one at a time (concurrency group `capri-fork-release`); if a third run queues,
GitHub drops the older waiting one: re-run it.

## 5. Checking a draft before publishing

A published release is read at once by installed apps (`latest.json`), so check the draft, then publish by hand:

- [ ] `latest.json` is there and its `version` is X; its three (four with Intel) URLs name `releases/download/fork-vX.Y.Z/...` and files of this draft.
- [ ] Each update package has its `.sig` (`.app.tar.gz.sig`, `-setup.exe.sig`, `.AppImage.sig`) and it equals the `signature` in `latest.json`.
- [ ] `SHA256SUMS` lists the Tauri installers (dmg, deb, packages): `sha256sum -c SHA256SUMS` on the downloaded files.
- [ ] Optionally re-verify: `CAPRI_UPDATER_PUBLIC_KEY=... node scripts/verify-signatures.js <folder of downloaded files>`.
- [ ] The commit named in the draft is the commit the jobs built (the notes block shows it) and is on `main`.
- [ ] Install each platform's installer on a clean machine at least once (macOS: right-click → Open; Windows: SmartScreen "More info").
- [ ] It is not marked pre-release by mistake.

## 6. Limits

- macOS: ad-hoc signature only, no Developer ID, no notarization: Gatekeeper asks to open the app the first time.  Screen-recording and other permissions may be asked again after an update because the ad-hoc identity changes with every build.
- Windows: the NSIS installer is not Authenticode-signed: SmartScreen warns.
- Linux: `.deb` has no in-app install (the app only tells there is an update); the AppImage updates itself.
- The Node SEA sidecar is the largest part of the package (about 111 MB of the 118 MB `.app`); TAURI-15 is about removing it.
- Updates need the key described above; a build made without it never updates.

## 7. What was run, and what was not

Run on this Mac (macOS 26, Apple Silicon, 2026-10-29), with a throw-away test key made in a temporary folder (not in the
repository) and the identifier `capri.desktop.packtest`: the whole of `npm run tauri:package` (sidecar SEA, `capri-hook`, Swift
helper, `cargo tauri build --bundles app,dmg` with the update configuration, signing, verification, collect) in 158 s with a
cold Cargo cache for `src-tauri`.

| Artifact | Tauri 0.1.0 | Electron 0.1.0 (`dist/` of the main checkout) |
|---|---|---|
| `.app` | 118 MB (`capri` 11.6 MB, `capri-sidecar` 111 MB, `capri-hook` 0.4 MB, `capri-windows` 0.12 MB) | 318 MB |
| `.dmg` | 44.3 MB | 143.0 MB |
| update package | `.app.tar.gz` 45.4 MB | `.zip` 135.9 MB |

The `.app` passes `codesign --verify --deep --strict`; the sidecar carries the `allow-jit` and
`allow-unsigned-executable-memory` entitlements. A copy of the `.app` outside `/Applications`, with a temporary profile
(`CAPRI_USER_DATA`, its own port): the sidecar started, the core said `listening`, `GET /health` answered,
`window tracking: on (macOS helper)` appeared, the overlay window was created (`NSWindow level=1000`), the update status was
`tauri install` (the key was in that build). `findHookBin` found `Contents/Resources/bin/capri-hook`. The user's real
`~/.claude/settings.json` and `~/.codex/hooks.json` were not touched (modification times unchanged). The signature of the
`.app.tar.gz` was verified against the test public key with `verify-signatures.js` (and a changed byte was refused). Also run:
`npm test` (332 tests), `npm run test:smoke` (the Electron build), `cargo test` of the shell (92 tests), YAML parse of both
workflows and `bash -n` of every `run` block (no `actionlint` on this Mac).

**Not run:** the workflow itself on GitHub (no push was made); Windows (NSIS, 7-Zip listing, silent install, the SEA build
without the Mach-O flag, postject through `npm exec`); Linux (apt list, AppImage/`.deb` bundling, `dpkg-deb` listing, run under
Xvfb); the Intel Mac row; the draft job against the GitHub API (`gh api` calls: the decisions are unit-tested, the calls are
not); a real key and secrets; a Developer ID or notarized build. `npm ci --ignore-scripts` on a clean machine was not run: the
sidecar build falls back to `npm exec postject@1.0.0-alpha.6` when the optional `postject` is not installed. Expect to fix
small things on the first CI run of each platform.
