# TAURI-11: the CAPRI-06/07 measurements, repeated on the Tauri build

Date: 2026-10-29. One machine, a lot of noise, no big conclusions. The Electron numbers of `docs/PERFORMANCE.md` were taken on another day; this time Electron was measured again in the same hour, with the same script family, between the Tauri runs.

## Setup

| | |
|---|---|
| Machine | MacBook, Apple M4 (10 cores), 24 GB, macOS 26 (Darwin 25.6), arm64, one display 2560x1440, scale 1; overlay 2560x1312 |
| Tauri build | `cargo build --release` of this branch (Tauri 2.12, WKWebView; `lto`, `codegen-units = 1`), the sidecar run as `node sidecar/main.js` (not the 106 MB Node SEA executable), helper `capri-windows` built, `window tracking: on` |
| Electron build | `electron .` from the repository's `node_modules` (44.x), `--dev` |
| Profile | temporary, `welcomed`, `motionAsked`, `lang: en`, `initiative: quiet`; own port, own Keychain service (removed afterwards); no hooks installed |
| Load | other Electron apps, builds of neighbouring worktrees; load average 4.7 to 8 during the runs (`uptime`). Later runs were busier than the first |
| Screen | never locked; `paused` is her pause through `/debug/power { away: true }` (the screen stays on), as in CAPRI-07 |

Method: `scripts/perf-probe-tauri.js --launch` (new) for Tauri and `scripts/perf-probe.js` for Electron: 8 s warm-up, then 45 s per state. CPU is the difference of `ps` cputime of every process of the app (the Tauri app and its sidecar, and WebKit's `Web Content`, `Graphics and Media` and `Networking` services found with `lsappinfo`; the Electron main, renderer, GPU and utility processes), in % of one core. GPU is the `accumulatedGPUTime` of the GPU process from `ioreg` (% of wall time). `requestAnimationFrame` callbacks and sprite draws per second are counted inside the page by the same wrappers in both probes. Wakeups come from `top` and swing by a factor of two between runs: they are listed but nothing is concluded from them. States: `idle` (panel hidden, no moves), `chat` (her chat panel open), `hidden` (stowed, only the chip), `paused` (her pause), `work` (a Claude Code session: events every 2.5 s).

Runs: Tauri r1, r2, r3 (r1 before the others, in a different order of states, and its `chat` window did not hold the chat open, so that cell is dropped); Electron e1, e2 (in e2 the chat did not open: dropped).

## Results (CPU, % of one core, all processes of the app together)

| State | Electron (same hour) | Tauri release | Electron, doc of CAPRI-06/07 |
|---|---|---|---|
| idle | 11.1, 15.4 | 13.3, 16.2, 17.9 | 11.9 (after) |
| chat | 14.0 (n=1) | 17.6, 15.9 | 13.2 |
| hidden | 8.0, 9.3 | 10.7, 11.0, 10.4 | 9.7 |
| paused | 2.2, 7.1 | 1.6, 7.8, 6.7 | 3.1 |
| work | 18.9, 21.1 | 11.1, 27.0, 30.2 | 17.8 |

Where the CPU is, idle (typical run): Tauri: app process (Rust and WebKit's UI side) 4.9 to 6.9, Web Content 3.9 to 5.4, Graphics and Media 4.4 to 5.7, sidecar 0.1 to 0.2. Electron: main 0.6 to 3.7, renderer 4.6 to 6.2, GPU 4.2 to 4.7, utility 0.2 to 0.4, window helper 0.9 to 1.0 (the Tauri sidecar's helper is counted as a child of the sidecar in the app's list and is under 0.1).

| State | rAF callbacks/s, Electron | rAF/s, Tauri | draws/s, Electron | draws/s, Tauri | GPU time of the GPU process %, Electron | GPU time %, Tauri |
|---|---|---|---|---|---|---|
| idle | 34 to 39 | 40 to 42 | 12 | 11.7 to 11.9 | 1.2, 1.2 | 2.8, 3.7, 3.6 |
| chat | 37 | 37 to 38 | 12 | 11.8 to 11.9 | 1.6 | 3.7, 3.0 |
| hidden | 24 | 26 | 0 | 0 | 0.6, 0.7 | 1.0, 0.9 (r1 is a counter reset: dropped) |
| paused | 0 | 0 | 0 | 0 | 0 | 0 |
| work | 56 to 57 | 69 to 73 | 12 | 11.8 to 11.9 | 2.1, 2.6 | 4.0, 7.9, 8.9 |

## What this says (and what it does not)

- **`frameIn` works in WKWebView.** The expected problem, a page drawing 60 callbacks a second (what the spike saw before CAPRI-06), is gone: idle is 40 callbacks/s at 11.8 draws/s, the same as Electron after CAPRI-06 (34 to 39), and `hidden` is 26 against 24. Her loop waits for the refresh its next draw is due on in both. Nothing was changed in the renderer, because there is nothing to fix in it.
- **`paused` and `hidden` behave as in Electron**: 0 callbacks, 0 draws, and the GPU time goes to zero in `paused` (the CAPRI-07 pause works the same under WebKit). The total CPU of `paused` swings from 1.6 to 7.8 with the machine's load (Electron 2.2 to 7.1 the same way), so no figure there is a conclusion.
- **Idle and chat cost more on Tauri**: total CPU about 3 to 5 points of one core above Electron in the same hour (13 to 18 against 11 to 15), and the GPU process's GPU time about three times Electron's (3 % against 1.2 %), in every one of three runs. On a 24 GB M4 that is small, but it is real and it is the one place the Tauri build is plainly worse. It is not the page's own draws (12/s in both) and not the sidecar (under 0.3 %).
- **Where the Tauri extra CPU is**: the app process (4.9 to 6.9 against Electron's main 0.6 to 3.7). A `sample` of the process at idle shows the main thread blocked in `mach_msg` 98 % of the time; the rest is WebKit applying the web process's layer-tree commits (`RemoteLayerTreeDrawingAreaProxy::commitLayerTree`, IOSurface contents) and nothing of ours: the pointer poll does not show up. In WKWebView that work is in the UI process, in Electron it is in the GPU process, so part of this difference is a move of the same cost between processes, not extra cost.
- **Wakeups**: 24 to 59 a second in Tauri idle against 23 to 24 in Electron, but the Tauri runs differ from each other by the same factor (24.6, 31, 59), so nothing is concluded. The shell's own contribution is the pointer poll (12 Hz at rest over her window, 8 Hz outside); no unneeded timer was found. The "wakeups" the task suspected from rAF are not there.
- **`work` is the one state that needs a second look**: 11.1 in the first Tauri run and 27 to 30 in the next two, with the GPU process at 4, 8 and 9 % of GPU time against Electron's 2.1 and 2.6. The same code, the same events. The first run was on a quieter machine; the second and third were on a busier one (the `paused` cells went from 1.6 to 7). With n=3 and this spread, the only honest statement is: on a loaded machine `work` costs on Tauri about 1.4 times Electron's CPU and 3 times its GPU time. The likely contributor is the full-window `fx` canvas (2560x1312) that glyphs and the ticker draw on at 24 fps: a WebKit canvas of that size is a 3 MB IOSurface handed to the compositor at every draw. Not changed: no profile proves it, and the fix (clear and draw only the dirty rectangle, or a smaller canvas) belongs to the renderer for both builds.

Nothing was optimized in this task. The only things the probe found in the code path were a probe bug (the `lsappinfo` parser stopped at the window helper, so the WebKit services were not counted) and the missing states; both are in the script.

## Not measured

- Windows (WebView2 is Chromium, so Electron's numbers are the better guess) and Linux (WebKitGTK).
- The packaged `.app`, the 106 MB sidecar executable (start time is in `docs/TAURI_SIDECAR.md`), debug builds (13.8 % at idle in the spike).
- A real lock or sleep, Retina or 120 Hz, several monitors, energy (`powermetrics` needs root).
- Memory: RSS per process is in the probe's JSON (`--out`) but not compared here.
- `work` and `chat` with n=2 or 3 each; `sleep`, `dozed` and `reduced` of the Electron probe were not run for Tauri.

## How to repeat

```
export CARGO_TARGET_DIR=<outside the repo>
npm run tauri:stage && (cd src-tauri && cargo build --release)
node scripts/perf-probe-tauri.js --launch --bin $CARGO_TARGET_DIR/release/capri --states idle,chat,hidden,paused,work --secs 45 --warm 8 --out result.json
node scripts/perf-probe.js --states idle,work,chat,hidden,paused --secs 45 --warmup 8 --out electron.json     # Electron, same hour
```

`--launch` starts its own copy of the app with a temporary profile and port, drives it with the sidecar's debug routes and the debug stdin (`CAPRI_DEBUG_STDIN`), and removes the profile and its Keychain test item. Do not lock the screen or run other builds meanwhile.
