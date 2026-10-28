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
        format!("NSWindow level={level} collectionBehavior={behavior:#x} onActiveSpace={on_space}")
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
