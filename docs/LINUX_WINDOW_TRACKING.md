# Linux X11 window tracking (CAPRI-10)

> Исторический документ: Electron-версия удалена в TAURI-14 (2026-10-29); упоминания Electron описывают то, с чем сравнивали или что переносили. Электрон-код в репозитории не хранится.

Status: **implemented, not yet verified on a real compositing desktop.** It was developed on macOS. The output parsers are tested on output written from the tools' documented formats, the watcher on faked tool runs, and CI adds a probe on Xvfb + openbox. None of these shows it working on GNOME/KDE/Xfce/Cinnamon under X11. Until someone checks it there, treat Linux sitting as experimental.

## How it works

- `src/main/linux/x11.js`: pure functions that parse `xprop` and `xwininfo` output and build the snapshot the overlay already gets from the Windows helper (`{ fg, taskbar, ai, game, usb, plug, wins: [{ id, x, y, w, h, max }] }`, front window first).
- `src/main/linux/x11-watch.js`: polls every 500 ms. Each poll runs `xprop -root` (`_NET_ACTIVE_WINDOW`, `_NET_CLIENT_LIST_STACKING`, `_NET_CURRENT_DESKTOP`) and `xwininfo -root -tree` (absolute geometry of every window). It reads per-window properties (`_NET_WM_WINDOW_TYPE`, `_NET_WM_STATE`, `_NET_WM_DESKTOP`, `_NET_FRAME_EXTENTS`, `_GTK_FRAME_EXTENTS`, `_NET_WM_PID`) with one `xprop -id` each, but only for new, moved/resized, focused or previously focused windows, plus all windows every 4 s and on a workspace switch. It sends a snapshot only when something changed.
- `src/main/windows.js`: `startWindowWatch()` sends Linux to this adapter, passing it the session from `capabilities.js`. The shared `createFeed()` converts physical pixels to the overlay's DIPs: `screenToDipRect` on Windows, display bounds × `scaleFactor` on X11. Its `onState(ok)` goes to `caps.set('windowTracking', ok)`, so the menu (possession) and the renderer hear when tracking starts or stops.

### What counts as a window to sit on

Included: `NORMAL` and `DIALOG` windows, and windows with no type. A window must also be on the visible workspace (or on all workspaces / sticky), not `HIDDEN` (minimized), not `SKIP_TASKBAR`, and at least 200×120 px. Only Capri's overlay is excluded (by its XID; it also skips the taskbar). Her other windows, such as the demo terminal she takes over, are seats, the same as on Windows. A window's first standard `_NET_WM_WINDOW_TYPE_*` decides its type; vendor types listed before it (Qt's `_KDE_NET_WM_WINDOW_TYPE_OVERRIDE`) are skipped. Excluded types: desktop, dock/panel, menus, tooltips, notifications, splash, toolbar, utility. Maximized (both axes) or fullscreen windows get `max: true`, the same as Windows.

Geometry is the outer frame. The window manager's `_NET_FRAME_EXTENTS` (title bar included) is added, and a GTK client-side-decorated window's transparent shadow (`_GTK_FRAME_EXTENTS`) is removed. When a dock/panel is the active window, `taskbar: true` is set. Windows-only fields (`ai`, `game`, `usb`, `plug`) stay empty on Linux.

## Sessions

| Session (`capabilities.linuxSession`) | Window tracking |
| --- | --- |
| `x11` (`DISPLAY` set, no Wayland) | On, if the tools are present and the WM is EWMH-compliant |
| `xwayland` (Wayland session, Capri running through XWayland) | **Off.** X11 calls only see XWayland clients, so native Wayland windows (most of a GNOME/KDE Wayland desktop) would be missing and the active window would be wrong |
| `wayland` / none | Off |

When tracking is off, Capri keeps the basic overlay (floating, wandering, hooks, chat, reminders). "Possess my windows" shows as unavailable.

## Dependencies

- Debian/Ubuntu: `x11-utils` (provides `xprop` and `xwininfo`). It is now in the `.deb` `Depends` (the list replaces electron-builder's default, which is copied in).
- Fedora: `xprop`, `xwininfo`. Arch: `xorg-xprop`, `xorg-xwininfo`.
- AppImage: cannot pull these in. Install them yourself. Without them the watcher logs `xprop not found: install x11-utils` once and turns tracking off.
- No window manager, or one without EWMH (`_NET_CLIENT_LIST_STACKING` missing): it gives up after 5 failed polls.

## Checked / not checked

Checked (on macOS, in `tests/x11.test.js`):

- parsing of root and window properties, both with and without `-notype`; empty and missing values
- parsing of `xwininfo -tree` with nested frames, names that contain geometry-like text, and negative positions
- filtering by type (vendor types skipped), state, workspace, sticky, own overlay, Capri's other windows, and size; frame and CSD extents; `max`
- px→DIP conversion for scale 1 and 2, two screens, and two screens at 1.5
- watcher: off for `xwayland`/`wayland`/no session without running any tool; on with the tools present; a snapshot only on change; immediate give-up without the tools; give-up after repeated non-EWMH polls; a window closing between calls
- `npm run test:smoke` on macOS (the adapter does not start there)

Not checked (needs a real Linux X11 desktop):

- that recorded output from a real desktop matches the fixtures, e.g. Mutter, KWin, Xfwm, Muffin and openbox frame extents
- `scaleFactor` with fractional/HiDPI scaling (`GDK_SCALE`, `Xft.dpi`). The conversion assumes Chromium's DIP display bounds × factor = X pixels
- multi-monitor layouts with different resolutions or offsets
- closing, moving (500 ms latency while dragging), minimizing, maximizing and switching workspaces in a live session
- the CPU cost of polling with many windows open
- XWayland: confirming that leaving it off is the right call on GNOME/KDE Wayland
- the CI probe (`scripts/x11-probe.js` under Xvfb + openbox + `xmessage`) has not run yet. It is an extra check, not proof that real desktops are supported

When verifying, record the distribution, desktop/WM, session type, scale and monitor layout here.
