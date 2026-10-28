//! Her overlay window: transparent, frameless, above everything, on every Space, click-through
//! except where she is. TAURI-04 carries over what the spike proved (docs/TAURI_SPIKE.md); the
//! polish (chat focus, screens, hover) is TAURI-05.
//!
//! Click-through without `forward: true`: while a Tauri window ignores the cursor its page gets no
//! mouse event at all (and a non-key window gets no mouse-moved events either). So a thread reads the
//! pointer (25 Hz) and, while the pointer is over the window, hands the page a synthetic `mousemove` at that spot. The page's own
//! logic (app.js: alpha-mask hit test, then `setInteractive`) is unchanged: it answers through the
//! core, which calls `overlay.clickThrough`, and that flips the window here. The pointer is also
//! pushed to the core (platform.screens.cursor() is synchronous there).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "overlay";
const POLL_MS: u64 = 40;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Window state the poll thread reads (the poll must not call into the main thread per tick).
struct Cache {
    origin: Mutex<(f64, f64)>,
    size: Mutex<(f64, f64)>,
    scale_bits: AtomicU64,
}
static CACHE: Cache = Cache { origin: Mutex::new((0.0, 0.0)), size: Mutex::new((0.0, 0.0)), scale_bits: AtomicU64::new(0) };
/// Whether the window is click-through now (set by the core's `overlay.clickThrough`).
static IGNORING: AtomicBool = AtomicBool::new(true);

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(LABEL).ok_or_else(|| "the overlay window does not exist".to_string())
}

/// The window's rectangle in DIPs (points), global, origin top-left of the primary screen.
pub fn bounds(win: &WebviewWindow) -> Result<Rect, String> {
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let p = win.outer_position().map_err(|e| e.to_string())?;
    let s = win.outer_size().map_err(|e| e.to_string())?;
    let r = Rect { x: p.x as f64 / scale, y: p.y as f64 / scale, width: s.width as f64 / scale, height: s.height as f64 / scale };
    *CACHE.origin.lock().unwrap() = (r.x, r.y);
    *CACHE.size.lock().unwrap() = (r.width, r.height);
    CACHE.scale_bits.store(scale.to_bits(), Ordering::Relaxed);
    Ok(r)
}

pub fn set_bounds(app: &AppHandle, rect: Rect) -> Result<Rect, String> {
    let win = window(app)?;
    win.set_position(LogicalPosition::new(rect.x, rect.y)).map_err(|e| e.to_string())?;
    win.set_size(LogicalSize::new(rect.width, rect.height)).map_err(|e| e.to_string())?;
    bounds(&win)
}

/// Level 1000 + Spaces flags, on the main thread.
fn apply_level(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || {
            let _ = w.set_always_on_top(true);
            let r = crate::mac::overlay_level(&w);
            println!("[capri] overlay: {r}");
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_always_on_top(true);
}

/// Makes the overlay (or, when it exists already, which means a sidecar that came back, fits it again
/// and reloads her page so that it meets the new core).
pub fn create(app: &AppHandle, area: Rect) -> Result<Rect, String> {
    if let Ok(win) = window(app) {
        let r = set_bounds(app, area)?;
        click_through(app, true);
        let _ = win.eval("location.reload()");
        return Ok(r);
    }
    // built here and not from the config, after the Accessory policy (lib.rs): a window made while the
    // app is a regular one never shows over full-screen apps or on other Spaces (spike, limit 3)
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("src/renderer/index.html".into()))
        .title("Capri")
        .inner_size(area.width, area.height)
        .position(area.x, area.y)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focusable(false)
        .focused(false)
        .accept_first_mouse(true)
        .visible(false);
    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = win.set_ignore_cursor_events(true);
    IGNORING.store(true, Ordering::SeqCst);
    let _ = win.set_always_on_top(true);
    let _ = win.set_visible_on_all_workspaces(true);
    let _ = win.set_skip_taskbar(true);
    let r = bounds(&win)?;
    apply_level(&win);
    let _ = win.show(); // only now: Space membership is decided when the window is first ordered in
    // tauri applies some of the window's config after this: the level again once it is done
    let w2 = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        apply_level(&w2);
    });
    Ok(r)
}

pub fn click_through(app: &AppHandle, on: bool) {
    if IGNORING.swap(on, Ordering::SeqCst) != on {
        println!("[capri] overlay click-through={on}");
    }
    if let Ok(win) = window(app) {
        let _ = win.set_ignore_cursor_events(on);
    }
}

pub fn keep_on_top(app: &AppHandle) {
    if let Ok(win) = window(app) {
        apply_level(&win);
    }
}

pub fn raise(app: &AppHandle) {
    if let Ok(win) = window(app) {
        apply_level(&win);
        #[cfg(target_os = "macos")]
        {
            let w = win.clone();
            let _ = win.run_on_main_thread(move || crate::mac::order_front(&w));
        }
    }
}

pub fn set_focusable(app: &AppHandle, on: bool) {
    if let Ok(win) = window(app) {
        if let Err(e) = win.set_focusable(on) {
            eprintln!("[capri] set_focusable({on}): {e}");
        }
    }
}

pub fn focus(app: &AppHandle) {
    if let Ok(win) = window(app) {
        let _ = win.set_focus();
    }
}

pub fn blur(_app: &AppHandle) {
    // nothing to hand the focus to without a Dock icon; TAURI-05 (chat focus)
}

/// Every screen as the core's Display: DIP bounds and work area, scale factor. Ids are 1-based
/// positions in Tauri's list. (macOS and Linux positions are logical already once divided by the
/// monitor's scale; Windows' mixed-DPI case is TAURI-05's.)
pub fn screens(app: &AppHandle) -> Value {
    let monitors = app.available_monitors().unwrap_or_default();
    let list: Vec<Value> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let f = m.scale_factor();
            let (p, s, w) = (m.position(), m.size(), m.work_area());
            let rect = |x: f64, y: f64, w: f64, h: f64| json!({"x": (x / f).round(), "y": (y / f).round(), "width": (w / f).round(), "height": (h / f).round()});
            json!({
                "id": i + 1,
                "scaleFactor": f,
                "bounds": rect(p.x as f64, p.y as f64, s.width as f64, s.height as f64),
                "workArea": rect(w.position.x as f64, w.position.y as f64, w.size.width as f64, w.size.height as f64),
                "size": {"width": (s.width as f64 / f).round(), "height": (s.height as f64 / f).round()},
            })
        })
        .collect();
    if let Ok(Some(m)) = app.primary_monitor() {
        #[cfg(target_os = "macos")]
        crate::mac::PRIMARY_H_PTS.store((m.size().height as f64 / m.scale_factor()).to_bits(), Ordering::Relaxed);
        let _ = m;
    }
    json!({ "list": list })
}

fn cursor_dip(app: &AppHandle) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        crate::mac::cursor_dip()
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows / Linux: Tauri's own (a main-thread round trip; its cost there is not measured yet)
        let win = window(app).ok()?;
        let c = win.cursor_position().ok()?;
        let f = f64::from_bits(CACHE.scale_bits.load(Ordering::Relaxed)).max(1.0);
        let (ox, oy) = *CACHE.origin.lock().unwrap();
        // cursor_position is physical in the screen's space; the window's origin is DIP
        let _ = (ox, oy);
        Some((c.x / f, c.y / f))
    }
}

/// The poll: 25 times a second. `push(method, params)` tells the core (cursor, screens).
pub fn start_poll(app: AppHandle, push: impl Fn(&str, Value) + Send + 'static) {
    std::thread::Builder::new()
        .name("overlay-poll".into())
        .spawn(move || {
            let mut last: Option<(f64, f64)> = None;
            let mut last_sent = std::time::Instant::now() - Duration::from_secs(10);
            let mut last_screens = Value::Null;
            let mut n: u32 = 0;
            loop {
                std::thread::sleep(Duration::from_millis(POLL_MS));
                // window geometry and the screens change rarely: once a second, and not from this thread's hot path
                if n % 25 == 0 {
                    if let Ok(win) = window(&app) {
                        let _ = bounds(&win);
                    }
                    let now = screens(&app);
                    if now != last_screens {
                        if !last_screens.is_null() {
                            push("screens", now.clone());
                        }
                        last_screens = now;
                    }
                }
                n = n.wrapping_add(1);
                let Some((x, y)) = cursor_dip(&app) else { continue };
                let moved = last != Some((x, y));
                if moved || last_sent.elapsed() > Duration::from_secs(1) {
                    push("cursor", json!({"x": x, "y": y}));
                    last_sent = std::time::Instant::now();
                }
                // also while she takes clicks: an app that is not the active one gets no mouse-moved events
                // on a window that is not key, so the page would never hear the pointer leave her
                if moved {
                    let (ox, oy) = *CACHE.origin.lock().unwrap();
                    let (w, h) = *CACHE.size.lock().unwrap();
                    let (cx, cy) = (x - ox, y - oy);
                    if cx >= 0.0 && cy >= 0.0 && cx < w && cy < h {
                        if let Ok(win) = window(&app) {
                            let _ = win.eval(format!(
                                "window.dispatchEvent(new MouseEvent('mousemove',{{clientX:{cx:.1},clientY:{cy:.1},bubbles:true}}))"
                            ));
                        }
                    }
                }
                last = Some((x, y));
            }
        })
        .expect("overlay poll thread");
}
