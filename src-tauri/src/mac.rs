//! macOS-only window and cursor details the spike proved necessary (docs/TAURI_SPIKE.md): Tauri's
//! always-on-top is NSFloatingWindowLevel, her overlay needs NSScreenSaverWindowLevel and the Spaces
//! flags; the cursor is read straight from NSEvent because Tauri's `cursor_position()` is a round
//! trip to the main thread. All of it through objc2, which is already in Tauri's tree.

use std::sync::atomic::{AtomicU64, Ordering};

use objc2::{msg_send, runtime::AnyObject};
use tauri::WebviewWindow;

/// NSScreenSaverWindowLevel: what Electron's 'screen-saver' maps to.
const SCREEN_SAVER_LEVEL: isize = 1000;
/// canJoinAllSpaces | stationary | fullScreenAuxiliary: every Space, over full-screen apps.
const SPACES: usize = 1 | 16 | 256;

/// Height of the primary screen in points (bottom-left to top-left flip); set by the poll.
pub static PRIMARY_H_PTS: AtomicU64 = AtomicU64::new(0);

/// A click on her must not make Capri the active app (and take the keyboard from the app you are typing in):
/// the window becomes one that does not activate on a click. AppKit's `_setPreventsActivation:` is the private
/// call behind that (Electron and Chromium use it for the same: a non-panel NSWindow cannot be made
/// non-activating otherwise). Off while the chat has the keyboard. Returns whether the call was there.
fn prevent_activation(w: &AnyObject, on: bool) -> bool {
    use objc2::sel;
    unsafe {
        let ok: bool = msg_send![w, respondsToSelector: sel!(_setPreventsActivation:)];
        if ok {
            let _: () = msg_send![w, _setPreventsActivation: on];
        }
        ok
    }
}

fn ns_window(win: &WebviewWindow) -> Option<&'static AnyObject> {
    let ptr = win.ns_window().ok()?;
    Some(unsafe { &*(ptr as *const AnyObject) })
}

/// Level 1000 and the Spaces flags. Call it on the main thread, after `set_always_on_top`, which would
/// otherwise put the level back.
pub fn overlay_level(win: &WebviewWindow) -> String {
    let Some(w) = ns_window(win) else { return "no ns_window".into() };
    unsafe {
        let _: () = msg_send![w, setLevel: SCREEN_SAVER_LEVEL];
        let _: () = msg_send![w, setCollectionBehavior: SPACES];
        let _: () = msg_send![w, setHasShadow: false];
        let level: isize = msg_send![w, level];
        let behavior: usize = msg_send![w, collectionBehavior];
        let on_space: bool = msg_send![w, isOnActiveSpace];
        let quiet = prevent_activation(w, true);
        format!("NSWindow level={level} collectionBehavior={behavior:#x} onActiveSpace={on_space} preventsActivation={quiet}")
    }
}

/// Orders the window in front without activating the app (the level keeps it above the rest).
pub fn order_front(win: &WebviewWindow) {
    if let Some(w) = ns_window(win) {
        unsafe {
            let _: () = msg_send![w, orderFrontRegardless];
        }
    }
}

/// The pointer in points, origin top-left of the primary screen: the DIP space of the core.
pub fn cursor_dip() -> Option<(f64, f64)> {
    use objc2::runtime::AnyClass;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct P {
        x: f64,
        y: f64,
    }
    unsafe impl objc2::Encode for P {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGPoint", &[objc2::Encoding::Double, objc2::Encoding::Double]);
    }
    let h = f64::from_bits(PRIMARY_H_PTS.load(Ordering::Relaxed));
    if h <= 0.0 {
        return None;
    }
    let cls = AnyClass::get(c"NSEvent")?;
    let p: P = unsafe { msg_send![cls, mouseLocation] };
    Some((p.x, h - p.y))
}

fn class(name: &std::ffi::CStr) -> Option<&'static objc2::runtime::AnyClass> {
    objc2::runtime::AnyClass::get(name)
}

/// Mouse buttons down right now (bit 0 left, 1 right, ...), from NSEvent: a class method, readable from any thread.
pub fn pressed_buttons() -> usize {
    match class(c"NSEvent") {
        Some(cls) => unsafe { msg_send![cls, pressedMouseButtons] },
        None => 0,
    }
}

/// The pid of the app in front, if it is not Capri.
pub fn frontmost_other_pid() -> Option<i32> {
    let cls = class(c"NSWorkspace")?;
    unsafe {
        let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
        if ws.is_null() {
            return None;
        }
        let app: *mut AnyObject = msg_send![ws, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        (pid != std::process::id() as i32).then_some(pid)
    }
}

/// The app that had the keyboard before the chat took it (0: none).
static PREVIOUS_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// The chat is open: Capri becomes the active app and her window the key window, so that her field takes
/// the keys. The app in front until now is remembered (and, with `yield_to`, told that Capri may take
/// the activation: macOS 14+ lets an app activate only when the active one allows it). Main thread.
pub fn take_keyboard(win: &WebviewWindow) -> String {
    use std::sync::atomic::Ordering::SeqCst;
    let Some(w) = ns_window(win) else { return "no ns_window".into() };
    let before = frontmost_other_pid();
    if let Some(p) = before {
        PREVIOUS_PID.store(p, SeqCst);
    }
    prevent_activation(w, false);
    unsafe {
        if let Some(cls) = class(c"NSApplication") {
            let app: *mut AnyObject = msg_send![cls, sharedApplication];
            if !app.is_null() {
                let _: () = msg_send![app, activateIgnoringOtherApps: true];
            }
        }
        let nil: *const AnyObject = std::ptr::null();
        let _: () = msg_send![w, makeKeyAndOrderFront: nil];
        let key: bool = msg_send![w, isKeyWindow];
        format!("keyboard taken (was in front: {before:?}), key={key}")
    }
}

/// The chat is closed: the keyboard goes back to the app that had it, and her window stops being key.
pub fn give_keyboard_back(win: &WebviewWindow) -> String {
    use std::sync::atomic::Ordering::SeqCst;
    let mut prev = PREVIOUS_PID.swap(0, SeqCst);
    if frontmost_other_pid().is_some() {
        prev = 0; // you went to another app meanwhile: it keeps the keyboard
    }
    let mut told = format!("keyboard given back to {prev}");
    if let Some(w) = ns_window(win) {
        prevent_activation(w, true);
    }
    unsafe {
        if prev > 0 {
            if let Some(cls) = class(c"NSRunningApplication") {
                let app: *mut AnyObject = msg_send![cls, runningApplicationWithProcessIdentifier: prev];
                if !app.is_null() {
                    // 2: NSApplicationActivateIgnoringOtherApps
                    let ok: bool = msg_send![app, activateWithOptions: 2usize];
                    told = format!("{told} (activate: {ok})");
                }
            }
        }
        if let Some(w) = ns_window(win) {
            let key: bool = msg_send![w, isKeyWindow];
            told = format!("{told}, still key={key}");
        }
    }
    told
}

#[allow(dead_code)]
/// A short look at the window for the logs: level, flags, whether it is on the current Space, key, ignoring clicks.
pub fn describe(win: &WebviewWindow) -> String {
    let Some(w) = ns_window(win) else { return "no ns_window".into() };
    unsafe {
        let level: isize = msg_send![w, level];
        let behavior: usize = msg_send![w, collectionBehavior];
        let on_space: bool = msg_send![w, isOnActiveSpace];
        let key: bool = msg_send![w, isKeyWindow];
        let ignores: bool = msg_send![w, ignoresMouseEvents];
        let visible: bool = msg_send![w, isVisible];
        format!("level={level} behavior={behavior:#x} onActiveSpace={on_space} key={key} ignoresMouse={ignores} visible={visible}")
    }
}
