// TAURI-00 spike: a transparent, frameless, always-on-top, click-through overlay with a WebGL sprite.
//
// Click-through without `forward: true`: Tauri has only `set_ignore_cursor_events(bool)`; while it is
// on, the page gets no mouse events at all (not even mousemove). So Rust polls the cursor, tells the
// page where it is when it is near the character, the page answers with an alpha-mask hit test, and
// Rust flips the window between "ignore" and "catch" accordingly.

use std::io::BufRead;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

const POLL_MS: u64 = 40;

#[derive(Default)]
struct Hit {
    /// character's bounding box in the page's CSS px: x, y, w, h (None until the page reports it)
    rect: Option<[f64; 4]>,
    /// the page's alpha-mask verdict for the last cursor position it was told about
    over: bool,
    /// the page is dragging the character: keep catching the mouse wherever it goes
    dragging: bool,
    /// current state of the window
    ignoring: bool,
}

struct Shared {
    hit: Mutex<Hit>,
    start: Instant,
    ticks: AtomicU64,
    flips: AtomicU64,
    max_tick_us: AtomicU64,
}

impl Shared {
    fn log(&self, msg: &str) {
        println!("[{:>8.3}] {}", self.start.elapsed().as_secs_f64(), msg);
    }
}

#[derive(Serialize, Clone)]
struct Cursor {
    x: f64,
    y: f64,
}

#[tauri::command]
fn set_rect(s: State<Arc<Shared>>, x: f64, y: f64, w: f64, h: f64) {
    s.hit.lock().unwrap().rect = Some([x, y, w, h]);
}

#[tauri::command]
fn set_hit(s: State<Arc<Shared>>, over: bool) {
    s.hit.lock().unwrap().over = over;
}

#[tauri::command]
fn set_dragging(s: State<Arc<Shared>>, on: bool) {
    s.log(&format!("dragging={on}"));
    s.hit.lock().unwrap().dragging = on;
}

#[tauri::command]
fn log(s: State<Arc<Shared>>, msg: String) {
    s.log(&format!("page: {msg}"));
}

#[tauri::command]
fn exit(app: AppHandle) {
    app.exit(0);
}

/// Put the window on monitor `idx` (covering all of it) and report scale factor.
#[tauri::command]
fn move_to_monitor(app: AppHandle, s: State<Arc<Shared>>, idx: usize) -> Result<String, String> {
    let win = app.get_webview_window("overlay").ok_or("no window")?;
    let r = cover_monitor(&win, Some(idx))?;
    s.log(&format!("move_to_monitor({idx}) -> {r}"));
    Ok(r)
}

fn cover_monitor(win: &WebviewWindow, idx: Option<usize>) -> Result<String, String> {
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let m = match idx {
        Some(i) => monitors.get(i).cloned(),
        None => win.current_monitor().map_err(|e| e.to_string())?.or_else(|| win.primary_monitor().ok().flatten()),
    }
    .ok_or("no monitor")?;
    let (p, z) = (m.position(), m.size());
    win.set_position(PhysicalPosition::new(p.x, p.y)).map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(z.width, z.height)).map_err(|e| e.to_string())?;
    Ok(format!(
        "monitor '{}' pos=({},{}) size={}x{} scale={} (of {} monitors)",
        m.name().cloned().unwrap_or_default(), p.x, p.y, z.width, z.height, m.scale_factor(), monitors.len()
    ))
}

#[cfg(target_os = "macos")]
fn mac_debug(win: &WebviewWindow, cmd: &str) -> String {
    use objc2::{msg_send, runtime::AnyObject};
    let Ok(ptr) = win.ns_window() else { return "no ns_window".into() };
    let w: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
    unsafe {
        if cmd == "reshow" { let nil: *const AnyObject = std::ptr::null(); let _: () = msg_send![w, orderOut: nil]; let _: () = msg_send![w, orderFrontRegardless]; }
        let nsapp: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
        let policy: isize = msg_send![nsapp, activationPolicy];
        let spaces: bool = msg_send![objc2::class!(NSScreen), screensHaveSeparateSpaces];
        let on_space: bool = msg_send![w, isOnActiveSpace];
        if cmd == "front" { let _: () = msg_send![w, orderFrontRegardless]; }
        if let Some(h) = cmd.strip_prefix("behavior ") {
            let b = usize::from_str_radix(h, 16).unwrap_or(0);
            let _: () = msg_send![w, setCollectionBehavior: b];
        }
        let style: usize = msg_send![w, styleMask];
        let vis: bool = msg_send![w, isVisible];
        let occ: usize = msg_send![w, occlusionState];
        let beh: usize = msg_send![w, collectionBehavior];
        let lvl: isize = msg_send![w, level];
        let cls = w.class().name().to_string_lossy().into_owned();
        format!("policy={policy} separateSpaces={spaces} onActiveSpace={on_space} class={cls} styleMask={style:#x} isVisible={vis} occlusionState={occ:#x} behavior={beh:#x} level={lvl}")
    }
}

#[cfg(target_os = "macos")]
fn mac_overlay_level(win: &WebviewWindow) -> String {
    let behavior = std::env::var("SPIKE_BEHAVIOR").ok().and_then(|v| usize::from_str_radix(v.trim_start_matches("0x"), 16).ok()).unwrap_or(1 | 16 | 256);
    use objc2::{msg_send, runtime::AnyObject};
    let Ok(ptr) = win.ns_window() else { return "no ns_window".into() };
    let w: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
    unsafe {
        // NSScreenSaverWindowLevel (the 'screen-saver' level)
        let _: () = msg_send![w, setLevel: 1000isize];
        // canJoinAllSpaces | stationary | fullScreenAuxiliary: every Space, over full-screen apps
        let _: () = msg_send![w, setCollectionBehavior: behavior];
        let _: () = msg_send![w, setHasShadow: false];
        let level: isize = msg_send![w, level];
        let got: usize = msg_send![w, collectionBehavior];
        format!("NSWindow level={level} collectionBehavior={got:#x}")
    }
}

static PRIMARY_H_PTS: AtomicU64 = AtomicU64::new(0);
static SCALE_BITS: AtomicU64 = AtomicU64::new(0);

/// Cursor in physical screen px. macOS: NSEvent.mouseLocation is thread-safe, so no main-thread hop.
fn cursor_physical(win: &WebviewWindow) -> Result<PhysicalPosition<f64>, tauri::Error> {
    #[cfg(target_os = "macos")]
    if std::env::var_os("SPIKE_TAO_CURSOR").is_none() {
        use objc2::{msg_send, runtime::AnyClass};
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct P { x: f64, y: f64 }
        unsafe impl objc2::Encode for P {
            const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGPoint", &[objc2::Encoding::Double, objc2::Encoding::Double]);
        }
        if let Some(cls) = AnyClass::get(c"NSEvent") {
            let p: P = unsafe { msg_send![cls, mouseLocation] };
            // bottom-left origin in points on the primary screen -> top-left origin in physical px
            let h_pts = f64::from_bits(PRIMARY_H_PTS.load(Ordering::Relaxed));
            if h_pts > 0.0 {
                let f = f64::from_bits(SCALE_BITS.load(Ordering::Relaxed));
                return Ok(PhysicalPosition::new(p.x * f, (h_pts - p.y) * f));
            }
        }
    }
    win.cursor_position()
}

fn poll_loop(app: AppHandle, shared: Arc<Shared>) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let _ = win.set_ignore_cursor_events(true);
    shared.hit.lock().unwrap().ignoring = true;
    let mut last: Option<(f64, f64)> = None;
    // outer_position / scale_factor are synchronous round trips to the main thread: cached, refreshed 1/s
    let (mut origin, mut scale, mut n) = (PhysicalPosition::new(0, 0), 1.0, 0u32);
    loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        let t0 = Instant::now();
        if n % 25 == 0 {
            if let Ok(o) = win.outer_position() { origin = o; }
            scale = win.scale_factor().unwrap_or(1.0);
            SCALE_BITS.store(scale.to_bits(), Ordering::Relaxed);
            if let Ok(Some(m)) = win.primary_monitor() {
                PRIMARY_H_PTS.store((m.size().height as f64 / m.scale_factor()).to_bits(), Ordering::Relaxed);
            }
        }
        n = n.wrapping_add(1);
        let Ok(cur) = cursor_physical(&win) else { continue };
        // physical screen px -> the page's CSS px
        let (x, y) = ((cur.x - origin.x as f64) / scale, (cur.y - origin.y as f64) / scale);

        let (want_ignore, ask_page) = {
            let h = shared.hit.lock().unwrap();
            let inside = h.rect.map_or(false, |[rx, ry, rw, rh]| x >= rx && x <= rx + rw && y >= ry && y <= ry + rh);
            if h.dragging { (false, false) } else if inside { (!h.over, true) } else { (true, false) }
        };
        if ask_page && last != Some((x, y)) {
            let _ = win.emit("cursor", Cursor { x, y });
        }
        if !ask_page && !shared.hit.lock().unwrap().dragging {
            // left the box: next entry starts from "not over her" until the page says otherwise
            shared.hit.lock().unwrap().over = false;
        }
        last = Some((x, y));

        let changed = {
            let mut h = shared.hit.lock().unwrap();
            let c = h.ignoring != want_ignore;
            h.ignoring = want_ignore;
            c
        };
        if changed {
            let _ = win.set_ignore_cursor_events(want_ignore);
            shared.flips.fetch_add(1, Ordering::Relaxed);
            shared.log(&format!("ignore_cursor_events={want_ignore} cursor_css=({x:.0},{y:.0})"));
        }
        let us = t0.elapsed().as_micros() as u64;
        shared.max_tick_us.fetch_max(us, Ordering::Relaxed);
        shared.ticks.fetch_add(1, Ordering::Relaxed);
    }
}

fn main() {
    let shared = Arc::new(Shared {
        hit: Mutex::new(Hit::default()),
        start: Instant::now(),
        ticks: AtomicU64::new(0),
        flips: AtomicU64::new(0),
        max_tick_us: AtomicU64::new(0),
    });
    let setup_shared = shared.clone();

    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![set_rect, set_hit, set_dragging, log, exit, move_to_monitor])
        .setup(move |app| {
            let shared = setup_shared.clone();
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon, no menu bar

            // The window is created here, after the activation policy: a window made while the app is still a
            // "regular" one (config windows are) never shows on other Spaces / over full-screen apps.
            let win = tauri::WebviewWindowBuilder::new(app, "overlay", tauri::WebviewUrl::App("index.html".into()))
                .title("Capri")
                .inner_size(800.0, 600.0)
                .position(0.0, 0.0)
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
                .visible(false)
                .focused(false)
                .accept_first_mouse(true)
                .build()?;
            let r = cover_monitor(&win, None).unwrap_or_else(|e| format!("cover_monitor failed: {e}"));
            shared.log(&format!("window=created {r}"));
            let _ = win.set_always_on_top(true);
            let _ = win.set_visible_on_all_workspaces(true);
            let _ = win.set_skip_taskbar(true);
            // after the calls above: tao's always-on-top would otherwise reset the level (we saw layer 5)
            #[cfg(target_os = "macos")]
            {
                shared.log(&mac_overlay_level(&win));
                let _ = win.show(); // only now: Space membership is decided when the window is first ordered in
                // tauri applies some window config after setup: set the level again once it is done
                let (w2, s2) = (win.clone(), shared.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(700));
                    let w3 = w2.clone();
                    let _ = w2.run_on_main_thread(move || s2.log(&format!("later: {}", mac_overlay_level(&w3))));
                });
            }
            #[cfg(not(target_os = "macos"))]
            let _ = win.show();
            shared.log(&format!(
                "always_on_top={:?} scale={:?} inner={:?} visible={:?}",
                win.is_always_on_top(), win.scale_factor(), win.inner_size(), win.is_visible()
            ));

            // cursor poll
            let (h, s) = (app.handle().clone(), shared.clone());
            std::thread::spawn(move || poll_loop(h, s));

            // 5 s stats
            let s = shared.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                s.log(&format!(
                    "stats ticks={} flips={} max_tick_us={}",
                    s.ticks.load(Ordering::Relaxed), s.flips.load(Ordering::Relaxed), s.max_tick_us.load(Ordering::Relaxed)
                ));
            });

            // test hook: every stdin line is evaluated as JS in the overlay page
            let h = app.handle().clone();
            let shared2 = shared.clone();
            std::thread::spawn(move || {
                let shared = shared2;
                for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                    if let Some(w) = h.get_webview_window("overlay") {
                        if let Some(cmd) = line.strip_prefix('!') {
                            #[cfg(target_os = "macos")]
                            {
                                let (w2, s2, c) = (w.clone(), shared.clone(), cmd.to_string());
                                let _ = w.run_on_main_thread(move || s2.log(&format!("debug {c}: {}", mac_debug(&w2, &c))));
                            }
                        } else {
                            let _ = w.eval(&line);
                        }
                    }
                }
            });

            // CI: leave after N seconds
            if let Some(secs) = std::env::var("SPIKE_EXIT_AFTER").ok().and_then(|v| v.parse::<u64>().ok()) {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(secs));
                    h.exit(0);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}
