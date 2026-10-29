//! Her overlay window: transparent, frameless, above everything, on every Space, click-through
//! except where she is. TAURI-04 carried over what the spike proved (docs/TAURI_SPIKE.md); TAURI-05
//! makes it the product: hover, the chat's keyboard, screens, sleep and wake.
//!
//! Click-through without `forward: true`: while a Tauri window ignores the cursor its page gets no
//! mouse event at all (and a non-key window gets none either). So a thread reads the pointer and,
//! while it is over the window, hands the page a synthetic `mousemove` at that spot (pointer.rs
//! decides what and when: 25 Hz while it moves, slower while it rests or is away). The page's own
//! logic (app.js: alpha-mask hit test, then `setInteractive`) is unchanged: it answers through the
//! core, which calls `overlay.clickThrough`, and that flips the window here, through `HitGate`, which
//! never takes a window away from a drag. The pointer is also pushed to the core
//! (platform.screens.cursor() is synchronous there).

mod geometry;
mod pointer;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use geometry::Mon;
pub use geometry::Rect;
use pointer::{HitGate, Page, Poller, Timing};

pub const LABEL: &str = "overlay";

/// Her page's end of the pointer: the poll calls it (see pointer.rs). Defined at document start, in every load.
const POINTER_SCRIPT: &str = "(function(){window.__capriPointer=function(x,y){if(x===null){document.dispatchEvent(new Event('mouseleave'));return;}window.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true}));};})();";

/// Window state the poll thread reads (it must not call into the main thread per tick).
struct Cache {
    bounds: Rect,
    monitors: Vec<Mon>,
}
static CACHE: Mutex<Cache> = Mutex::new(Cache { bounds: Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 }, monitors: Vec::new() });
static GATE: Mutex<Option<HitGate>> = Mutex::new(None);
/// The poll should tell her page where the pointer is although it did not move (the window moved, her page loaded).
static NUDGE: AtomicBool = AtomicBool::new(true);
/// The window's place or scale changed (events from the loop): read it again.
static BOUNDS_DIRTY: AtomicBool = AtomicBool::new(true);
static SCREENS_DIRTY: AtomicBool = AtomicBool::new(false);

/// CAPRI_TRACE_POINTER=1: a line for every change of the window's click-through and every move told to
/// the page, with a clock (ms), to measure the way pointer -> page -> core -> window.
fn trace(what: impl FnOnce() -> String) {
    static ON: std::sync::OnceLock<(bool, Instant)> = std::sync::OnceLock::new();
    let (on, t0) = ON.get_or_init(|| (std::env::var_os("CAPRI_TRACE_POINTER").is_some(), Instant::now()));
    if *on {
        println!("[trace {:>8.1}] {}", t0.elapsed().as_secs_f64() * 1000.0, what());
    }
}

fn gate<R>(f: impl FnOnce(&mut HitGate) -> R) -> R {
    let mut g = GATE.lock().unwrap();
    f(g.get_or_insert_with(HitGate::new))
}

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(LABEL).ok_or_else(|| "the overlay window does not exist".to_string())
}

/// The monitors as the core's DIP space is made of them (geometry.rs), read from Tauri and remembered.
fn read_monitors(app: &AppHandle) -> Vec<Mon> {
    let mut found = app.available_monitors().unwrap_or_default();
    if found.is_empty() {
        // the list can be empty for a moment (the app is not through launching, a display is waking)
        found.extend(app.primary_monitor().ok().flatten());
    }
    let mons: Vec<Mon> = found
        .iter()
        .map(|m| Mon {
            name: m.name().cloned().unwrap_or_default(),
            pos: (m.position().x, m.position().y),
            size: (m.size().width, m.size().height),
            work_pos: (m.work_area().position.x, m.work_area().position.y),
            work_size: (m.work_area().size.width, m.work_area().size.height),
            scale: m.scale_factor(),
        })
        .collect();
    if mons.is_empty() {
        // mid-reconfiguration (a display waking, being plugged): the last known list stays
        return CACHE.lock().unwrap().monitors.clone();
    }
    #[cfg(target_os = "macos")]
    if let Some(m) = mons.get(geometry::primary_index(&mons)) {
        crate::mac::PRIMARY_H_PTS.store((m.size.1 as f64 / m.scale).to_bits(), Ordering::Relaxed);
    }
    CACHE.lock().unwrap().monitors = mons.clone();
    mons
}

/// The window's rectangle in DIPs, global, origin top-left of the primary screen.
pub fn bounds(win: &WebviewWindow) -> Result<Rect, String> {
    let p = win.outer_position().map_err(|e| e.to_string())?;
    let s = win.outer_size().map_err(|e| e.to_string())?;
    let mut cache = CACHE.lock().unwrap();
    let r = if cfg!(target_os = "macos") {
        // tao: points times the window's scale, on every screen
        let f = win.scale_factor().map_err(|e| e.to_string())?;
        Rect { x: p.x as f64 / f, y: p.y as f64 / f, width: s.width as f64 / f, height: s.height as f64 / f }
    } else {
        geometry::rect_from_physical((p.x, p.y), (s.width, s.height), &cache.monitors)
    };
    cache.bounds = r;
    Ok(r)
}

pub fn set_bounds(app: &AppHandle, rect: Rect) -> Result<Rect, String> {
    let win = window(app)?;
    if cfg!(target_os = "macos") {
        win.set_position(tauri::LogicalPosition::new(rect.x, rect.y)).map_err(|e| e.to_string())?;
        win.set_size(tauri::LogicalSize::new(rect.width, rect.height)).map_err(|e| e.to_string())?;
    } else {
        // Windows / Linux place in physical pixels, and the DIP space has one scale per monitor
        let mons = read_monitors(app);
        let (pos, size) = geometry::rect_to_physical(rect, &mons);
        win.set_position(tauri::PhysicalPosition::new(pos.0, pos.1)).map_err(|e| e.to_string())?;
        win.set_size(tauri::PhysicalSize::new(size.0, size.1)).map_err(|e| e.to_string())?;
    }
    NUDGE.store(true, Ordering::SeqCst);
    bounds(&win)
}

/// Level 1000 + Spaces flags (macOS); topmost, out of the taskbar and Alt+Tab (Windows); skipped by the taskbar and
/// sticky (Linux). On the main thread. Idempotent: it is also what puts her back on top after a sleep.
fn apply_level(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        // not `set_always_on_top`: tao sets its level in a block queued on the main queue, which runs after
        // ours and puts the window back to Floating. Only at creation, where the builder asks for it, and
        // the levels applied again after that (create)
        let _ = win.run_on_main_thread(move || {
            let r = crate::mac::overlay_level(&w);
            println!("[capri] overlay: {r}");
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.set_always_on_top(true);
        let _ = win.set_skip_taskbar(true);
        let _ = win.set_visible_on_all_workspaces(true);
        #[cfg(windows)]
        win32::tool_window(win);
    }
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
        .initialization_script(POINTER_SCRIPT)
        .visible(false);
    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = win.set_ignore_cursor_events(true);
    gate(|g| *g = HitGate::new());
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_always_on_top(true);
    let _ = win.set_visible_on_all_workspaces(true);
    let _ = win.set_skip_taskbar(true);
    // the monitors first (Windows and Linux place in physical pixels), then her place
    let _ = read_monitors(app);
    let _ = set_bounds(app, area);
    let r = bounds(&win)?;
    apply_level(&win);
    let _ = win.show(); // only now: Space membership is decided when the window is first ordered in
    win.on_window_event(|event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => BOUNDS_DIRTY.store(true, Ordering::SeqCst),
        tauri::WindowEvent::ScaleFactorChanged { .. } => {
            BOUNDS_DIRTY.store(true, Ordering::SeqCst);
            SCREENS_DIRTY.store(true, Ordering::SeqCst);
        }
        _ => {}
    });
    // tauri applies some of the window's config after this: the level again once it is done
    let w2 = win.clone();
    std::thread::spawn(move || {
        for wait in [150u64, 550, 1500] {
            std::thread::sleep(Duration::from_millis(wait));
            apply_level(&w2);
        }
    });
    Ok(r)
}

pub fn click_through(app: &AppHandle, on: bool) {
    let apply = gate(|g| g.request(on, buttons_down()));
    trace(|| format!("click_through(ignore={on}) -> {apply:?} (menu open: {})", gate(|g| g.menu_is_open())));
    if let (Some(ignore), Ok(win)) = (apply, window(app)) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
    NUDGE.store(true, Ordering::SeqCst);
}

/// Her native menu is about to open (`opened`) or has closed: see `HitGate::menu_opened`. The window calls go to the
/// main thread in the order they are made, so the one made before the menu's popup is applied before the menu
/// takes the thread over, and the one made after it, once the menu has closed.
pub fn menu_state(app: &AppHandle, opened: bool) {
    let ignore = gate(|g| if opened { g.menu_opened(); true } else { g.menu_closed() });
    trace(|| format!("menu {} -> window ignore={ignore}", if opened { "opened" } else { "closed" }));
    if let Ok(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
    NUDGE.store(true, Ordering::SeqCst);
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

/// The chat is about to take the keyboard (false: it is over). A window that cannot become key takes no keys.
pub fn set_focusable(app: &AppHandle, on: bool) {
    if let Ok(win) = window(app) {
        if let Err(e) = win.set_focusable(on) {
            eprintln!("[capri] set_focusable({on}): {e}");
        }
    }
}

/// The overlay takes the keyboard: it becomes the active app's key window (macOS: an Accessory app does not
/// become active by itself), remembering who had the keyboard.
pub fn focus(app: &AppHandle) {
    let Ok(win) = window(app) else { return };
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || println!("[capri] overlay focus: {}", crate::mac::take_keyboard(&w)));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_focus();
}

/// The chat is over: the keyboard goes back to the app that had it. Her clicks stay what the page's hit
/// test says (it keeps answering as the pointer moves).
pub fn blur(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Ok(win) = window(app) {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || println!("[capri] overlay blur: {}", crate::mac::give_keyboard_back(&w)));
    }
    // Windows / Linux: with focusable off the window cannot keep the keyboard; the system hands it on
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Every screen as the core's Display (geometry.rs): DIP bounds and work area, scale factor, stable ids.
pub fn screens(app: &AppHandle) -> Value {
    geometry::screens_json(&read_monitors(app))
}

/// The same for the first hello, which the core cannot do without (no screen, no overlay): asked again for a
/// few seconds if the system has none to give yet.
pub fn screens_for_hello(app: &AppHandle) -> Value {
    for _ in 0..40 {
        let list = screens(app);
        if list["list"].as_array().map_or(false, |l| !l.is_empty()) {
            return list;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("[capri] no screen from the system after 4 s: a 1440x900 one is assumed");
    let m = Mon { name: "unknown".into(), pos: (0, 0), size: (1440, 900), work_pos: (0, 0), work_size: (1440, 900), scale: 1.0 };
    CACHE.lock().unwrap().monitors = vec![m.clone()];
    geometry::screens_json(&[m])
}

/// CAPRI_DEBUG_STDIN `!win`: the overlay window's state, printed.
pub fn debug_state(app: &AppHandle) {
    let Ok(win) = window(app) else { return println!("[win] no overlay") };
    let (b, ignoring) = (CACHE.lock().unwrap().bounds, gate(|g| g.ignoring()));
    println!("[win] bounds={b:?} gate.ignoring={ignoring}");
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || println!("[win] {}", crate::mac::describe(&w)));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win;
}

/// The pointer, DIPs, for the first hello.
pub fn cursor_json(app: &AppHandle) -> Value {
    match cursor_dip(app) {
        Some((x, y)) => json!({"x": x, "y": y}),
        None => json!({"x": 0, "y": 0}),
    }
}

fn cursor_dip(app: &AppHandle) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        crate::mac::cursor_dip()
    }
    #[cfg(windows)]
    {
        let _ = app;
        let (x, y) = win32::cursor()?;
        Some(geometry::point_to_dip(x as f64, y as f64, &CACHE.lock().unwrap().monitors))
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        // Linux: Tauri's own (a main-thread round trip, at most 20 a second here)
        let win = window(app).ok()?;
        let c = win.cursor_position().ok()?;
        Some(geometry::point_to_dip(c.x, c.y, &CACHE.lock().unwrap().monitors))
    }
}

fn buttons_down() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::mac::pressed_buttons() & 0b11 != 0
    }
    #[cfg(windows)]
    {
        win32::buttons_down()
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        false
    }
}

fn tell_page(win: &WebviewWindow, page: Page) {
    match page {
        Page::None => {}
        Page::Move(x, y) => {
            trace(|| format!("move {x:.0},{y:.0}"));
            let _ = win.eval(format!("window.__capriPointer&&window.__capriPointer({x:.1},{y:.1})"));
        }
        Page::Leave => {
            let _ = win.eval("window.__capriPointer&&window.__capriPointer(null)");
        }
    }
}

/// A wake from sleep, or anything else that stopped this process for seconds: her place on top, her click-through
/// state and the screens are put right again (the Electron build's rearmOverlay does this on resume / unlock;
/// the core's does too when it hears the power events, this is for when it does not).
fn after_stall(app: &AppHandle) {
    if let Ok(win) = window(app) {
        apply_level(&win);
        // not while her menu is open: she would take the clicks meant for it
        if !gate(|g| g.menu_is_open()) {
            let ignoring = gate(|g| g.ignoring());
            let _ = win.set_ignore_cursor_events(ignoring);
        }
        #[cfg(target_os = "macos")]
        {
            let w = win.clone();
            let _ = win.run_on_main_thread(move || crate::mac::order_front(&w));
        }
    }
    SCREENS_DIRTY.store(true, Ordering::SeqCst);
    BOUNDS_DIRTY.store(true, Ordering::SeqCst);
    NUDGE.store(true, Ordering::SeqCst);
}

/// The poll. `push(method, params)` tells the core (cursor, screens).
pub fn start_poll(app: AppHandle, push: impl Fn(&str, Value) + Send + 'static) {
    std::thread::Builder::new()
        .name("overlay-poll".into())
        .spawn(move || {
            let timing = if cfg!(target_os = "linux") { Timing::LINUX } else { Timing::DEFAULT };
            let mut poller = Poller::new(timing);
            let start = Instant::now();
            let mut last_wall = SystemTime::now();
            let mut last_screens = Value::Null; // what the core was told
            let mut seen_screens = Value::Null; // what the last look found: a change is told once it is seen twice
            let mut last_screens_at: Option<Instant> = None;
            let mut last_bounds_at = Instant::now();
            let mut last_top = Instant::now();
            let fixed = std::env::var_os("CAPRI_POLL_FIXED").is_some();
            let mut wait_ms = timing.fast_ms;
            let (mut busy, mut ticks, mut stats_at) = (Duration::ZERO, 0u32, Instant::now());
            loop {
                std::thread::sleep(Duration::from_millis(wait_ms));
                let tick_start = Instant::now();
                // the process was stopped (a sleep, a stall): the window may have been put anywhere
                let wall = SystemTime::now();
                if wall.duration_since(last_wall).map_or(false, |gap| gap > Duration::from_secs(5)) {
                    println!("[capri] overlay: woke after a stall, level and screens set again");
                    after_stall(&app);
                }
                last_wall = wall;

                // the monitors once a second (plus whenever a scale changed or we woke): there is no event for a
                // resolution or arrangement change; the window's own place from the loop's events
                if SCREENS_DIRTY.swap(false, Ordering::SeqCst) || last_screens_at.map_or(true, |t| t.elapsed() >= Duration::from_secs(1)) {
                    last_screens_at = Some(Instant::now());
                    let now = screens(&app);
                    if last_screens.is_null() {
                        last_screens = now.clone(); // the first look is what hello told
                    } else if now != last_screens && now == seen_screens {
                        // a change that the next look confirms (a display being reconfigured shows odd lists for a moment)
                        println!("[capri] screens changed: {}", now["list"].as_array().map_or(0, |l| l.len()));
                        push("screens", now.clone());
                        // her window follows the core's refit; the level is put again meanwhile
                        keep_on_top(&app);
                        last_screens = now.clone();
                    }
                    seen_screens = now;
                }
                if BOUNDS_DIRTY.swap(false, Ordering::SeqCst) || last_bounds_at.elapsed() >= Duration::from_secs(5) {
                    last_bounds_at = Instant::now();
                    if let Ok(win) = window(&app) {
                        let _ = bounds(&win);
                    }
                }
                // Windows: the taskbar comes up over a topmost window when it is clicked
                #[cfg(windows)]
                if last_top.elapsed() >= Duration::from_secs(3) {
                    last_top = Instant::now();
                    keep_on_top(&app);
                }
                #[cfg(not(windows))]
                let _ = &mut last_top;

                let buttons = buttons_down();
                if let Some(ignore) = gate(|g| g.release(buttons)) {
                    if let Ok(win) = window(&app) {
                        let _ = win.set_ignore_cursor_events(ignore);
                    }
                }
                let win_rect = CACHE.lock().unwrap().bounds;
                let out = poller.tick(start.elapsed().as_millis() as u64, cursor_dip(&app), win_rect, buttons, NUDGE.swap(false, Ordering::SeqCst));
                if let Some((x, y)) = out.core {
                    push("cursor", json!({"x": x, "y": y}));
                }
                if out.page != Page::None {
                    if let Ok(win) = window(&app) {
                        tell_page(&win, out.page);
                    }
                }
                // CAPRI_POLL_FIXED=1: always the fast rate (to measure what the slower ones save)
                wait_ms = if fixed { timing.fast_ms } else { out.next_ms };
                busy += tick_start.elapsed();
                ticks += 1;
                if stats_at.elapsed() >= Duration::from_secs(30) {
                    let secs = stats_at.elapsed().as_secs_f64();
                    trace(|| format!("poll: {:.1} ticks/s, {:.0} us per tick, {:.3}% of one core (wall, blocking calls included)", ticks as f64 / secs, busy.as_micros() as f64 / ticks.max(1) as f64, busy.as_secs_f64() / secs * 100.0));
                    (busy, ticks, stats_at) = (Duration::ZERO, 0, Instant::now());
                }
            }
        })
        .expect("overlay poll thread");
}

/// What the Windows build needs of user32, declared here so that no crate is added for it. Never run on this
/// machine (TAURI-05 was done on macOS): a Windows CI run is its test.
#[cfg(windows)]
mod win32 {
    use tauri::WebviewWindow;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
        fn GetAsyncKeyState(vk: i32) -> i16;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x80;
    const WS_EX_APPWINDOW: isize = 0x0004_0000;

    /// The pointer in physical pixels of the virtual desktop.
    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = Point { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
    }

    /// Left or right button down (0x01 / 0x02).
    pub fn buttons_down() -> bool {
        unsafe { (GetAsyncKeyState(0x01) as u16 | GetAsyncKeyState(0x02) as u16) & 0x8000 != 0 }
    }

    /// WS_EX_TOOLWINDOW: out of Alt+Tab and the taskbar, as an Electron 'toolbar' window is.
    pub fn tool_window(win: &WebviewWindow) {
        if let Ok(hwnd) = win.hwnd() {
            let h = hwnd.0 as isize;
            unsafe {
                let style = GetWindowLongPtrW(h, GWL_EXSTYLE);
                let want = (style | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
                if want != style {
                    SetWindowLongPtrW(h, GWL_EXSTYLE, want);
                }
            }
        }
    }
}
