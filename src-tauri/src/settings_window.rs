//! Her settings window (TAURI-06): an ordinary window apart from the overlay, label `settings`, made
//! from the real src/renderer/settings.html. One at a time: asking again brings the open one forward
//! with the focus (and the section, if one is asked). It takes the mouse and the keyboard like any
//! window; closing it leaves her where she is (lib.rs does not let the last window end the app).
//! Behaviour of src/main/settings-window.js: 720x540 (min 480x360) centered in the work area, page
//! colour #fcee0a while it loads, shown when the page is up, no other site in it, no popups.
//!
//! Her pages' channels: capabilities/settings.json gives this window the bridge command and events,
//! the overlay's gives it the same two; lib.rs refuses a `scope` that is not the window's own, and the
//! core's dispatcher checks it again (the overlay cannot use the settings scope and the other way round).

use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::menu::tell;

pub const LABEL: &str = "settings";
const PAGE: &str = "src/renderer/settings.html";
const BACKGROUND: Color = Color(0xfc, 0xee, 0x0a, 0xff);
const MIN: (f64, f64) = (480.0, 360.0);

#[derive(Debug, Deserialize, Default)]
pub struct Bounds {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OpenParams {
    pub title: Option<String>,
    pub bounds: Option<Bounds>,
    pub section: Option<String>,
}

/// The page asked for, with the section as the fragment (settings.js reads location.hash).
pub fn page_path(section: Option<&str>) -> String {
    match section.filter(|s| !s.is_empty()) {
        Some(s) => format!("{PAGE}#{}", encode(s)),
        None => PAGE.to_string(),
    }
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Only her own page may be in the window.
pub fn allowed_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"), // Windows' form of the same origin
        _ => false,
    }
}

/// macOS: she has no Dock icon (Accessory), and a window of such an app does not get the keyboard until
/// the app is brought forward (what Electron's `app.focus({ steal: true })` was for).
#[cfg(target_os = "macos")]
fn activate_app(app: &AppHandle) {
    use objc2::runtime::{AnyClass, AnyObject};
    let _ = app.run_on_main_thread(|| unsafe {
        if let Some(cls) = AnyClass::get(c"NSApplication") {
            let ns_app: *mut AnyObject = objc2::msg_send![cls, sharedApplication];
            if !ns_app.is_null() {
                let _: () = objc2::msg_send![ns_app, activateIgnoringOtherApps: true];
            }
        }
    });
}
#[cfg(not(target_os = "macos"))]
fn activate_app(_app: &AppHandle) {}

fn bring_forward(app: &AppHandle, win: &WebviewWindow) {
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    activate_app(app);
    let _ = win.show();
    let _ = win.set_focus();
}

pub fn open(app: &AppHandle, params: &Value) -> Result<(), String> {
    let p: OpenParams = serde_json::from_value(params.clone()).map_err(|e| format!("bad settings.open: {e}"))?;
    let section = p.section.as_deref().filter(|s| !s.is_empty());
    if let Some(win) = app.get_webview_window(LABEL) {
        if let Some(s) = section {
            let _ = app.emit_to(LABEL, "capri://settings:section", s);
        }
        bring_forward(app, &win);
        return Ok(());
    }
    let b = p.bounds.unwrap_or_default();
    let (w, h) = (b.width.unwrap_or(720.0), b.height.unwrap_or(540.0));
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page_path(section).into()))
        .title(p.title.unwrap_or_else(|| "Capri".into()))
        .inner_size(w, h)
        .min_inner_size(MIN.0, MIN.1)
        .background_color(BACKGROUND)
        .maximizable(false)
        .visible(false)
        .focused(true)
        // its page stays its page: no other site in it (and no popups: tauri opens none unasked)
        .on_navigation(allowed_url)
        .on_page_load(|win, payload| {
            if payload.event() == PageLoadEvent::Finished {
                bring_forward(win.app_handle(), &win);
            }
        });
    if let (Some(x), Some(y)) = (b.x, b.y) {
        builder = builder.position(x, y);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    // closed: the core is told (its `isOpen` and `owns` go by it), unless a new one is up already
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if handle.get_webview_window(LABEL).is_none() {
                tell(&handle, "settings.closed", json!({}));
            }
        }
    });
    // the page did not say it loaded (a failing page): shown anyway, so it can be seen and closed
    let (a, w2) = (app.clone(), win.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        if matches!(w2.is_visible(), Ok(false)) {
            bring_forward(&a, &w2);
        }
    });
    Ok(())
}

pub fn close(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_title(app: &AppHandle, params: &Value) -> Result<(), String> {
    if let (Some(win), Some(title)) = (app.get_webview_window(LABEL), params["title"].as_str()) {
        win.set_title(title).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Debug (CAPRI_DEBUG): JavaScript run in the settings page, the result as JSON text.
pub fn eval(app: &AppHandle, params: &Value) -> Result<Value, String> {
    if std::env::var_os("CAPRI_DEBUG").is_none() {
        return Err("debug requests need CAPRI_DEBUG".into());
    }
    let win = app.get_webview_window(LABEL).ok_or("the settings window is not open")?;
    let js = params["js"].as_str().ok_or("eval needs js")?;
    let (tx, rx) = mpsc::channel();
    win.eval_with_callback(js, move |r| {
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    let text = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "no result in 5 s".to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_and_the_section_asked() {
        assert_eq!(page_path(None), "src/renderer/settings.html");
        assert_eq!(page_path(Some("")), "src/renderer/settings.html");
        assert_eq!(page_path(Some("about")), "src/renderer/settings.html#about");
        assert_eq!(page_path(Some("a b/#")), "src/renderer/settings.html#a%20b%2F%23");
    }

    #[test]
    fn only_her_own_origin_is_let_in() {
        let ok = |u: &str| allowed_url(&u.parse().unwrap());
        assert!(ok("tauri://localhost/src/renderer/settings.html"));
        assert!(ok("http://tauri.localhost/src/renderer/settings.html"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("http://localhost:1420/"));
    }

    #[test]
    fn the_core_s_open_request_is_read() {
        let p: OpenParams = serde_json::from_value(json!({
            "title": "Capri — settings", "bounds": { "x": 280, "y": 130, "width": 720, "height": 540 }, "section": null
        }))
        .unwrap();
        assert_eq!(p.bounds.unwrap().width, Some(720.0));
        assert!(p.section.is_none());
        let bare: OpenParams = serde_json::from_value(json!({ "bounds": { "width": 720, "height": 540 } })).unwrap();
        assert!(bare.bounds.unwrap().x.is_none());
    }
}
