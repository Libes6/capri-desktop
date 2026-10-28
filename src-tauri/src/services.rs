//! What the sidecar asks of the system (TAURI-07), one place: parses the request, calls the module
//! that does it (secrets, capture, clipboard, opener, dialogs, power), shapes the answer. The methods
//! and their parameters are those of src/main/platform/sidecar.js:
//!
//!   secrets.masterKey {}                           -> { available, key | reason }
//!   capture.screen { bounds, width, height, format, quality } -> base64 string | null
//!   clipboard.writeImage { png: base64 }           -> true
//!   clipboard.writeText { text }                   -> true
//!   shell.openExternal { url } / shell.openPath { path } / shell.showItemInFolder { path }
//!   dialogs.pickFolder { default }                 -> path | null
//!   capture.permitted {}                           -> bool | null (Screen Recording allowed; asks nothing)
//!   power.idle { threshold }                       -> { seconds | null, state: active|idle|locked|unknown }
//!   app.appForProtocol { url }                     -> bool

use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use crate::rpc::RpcError;
use crate::{capture, clipboard, dialogs, opener, power, secrets};

/// Methods that can block for long (a dialog waits for a person, the key store for the system).
pub fn slow(method: &str) -> bool {
    matches!(method, "dialogs.pickFolder" | "secrets.masterKey" | "capture.screen" | "clipboard.writeImage" | "clipboard.writeText")
}

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        "secrets.masterKey" | "capture.screen" | "clipboard.writeImage" | "clipboard.writeText" | "shell.openExternal" | "shell.openPath"
            | "shell.showItemInFolder" | "dialogs.pickFolder" | "power.idle" | "app.appForProtocol" | "capture.permitted"
    )
}

pub struct Services {
    pub store: Arc<dyn secrets::Backend>,
    pub service: String,
    pub picker: Arc<dyn dialogs::Picker + Send + Sync>,
    pub tracker: Arc<power::Tracker>,
    // kept: on X11 the clipboard's content lives as long as its owner
    board: Mutex<Option<clipboard::System>>,
}

fn fail(message: impl Into<String>) -> RpcError {
    RpcError::new(-32000, message)
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params[key].as_str().ok_or_else(|| fail(format!("{key} is missing")))
}

impl Services {
    pub fn new(store: Arc<dyn secrets::Backend>, service: String, picker: Arc<dyn dialogs::Picker + Send + Sync>, tracker: Arc<power::Tracker>) -> Services {
        Services { store, service, picker, tracker, board: Mutex::new(None) }
    }

    fn with_board(&self, f: impl FnOnce(&mut clipboard::System) -> Result<(), String>) -> Result<Value, RpcError> {
        let mut slot = self.board.lock().unwrap();
        if slot.is_none() {
            *slot = Some(clipboard::System::open().map_err(fail)?);
        }
        f(slot.as_mut().unwrap()).map(|_| json!(true)).map_err(fail)
    }

    pub fn handle(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "secrets.masterKey" => Ok(secrets::master_key_answer(self.store.as_ref(), &self.service)),
            "capture.screen" => {
                let bounds: capture::Bounds = serde_json::from_value(params["bounds"].clone()).map_err(|e| fail(format!("bad bounds: {e}")))?;
                let (w, h) = (params["width"].as_f64().unwrap_or(0.0), params["height"].as_f64().unwrap_or(0.0));
                let format = capture::Format::parse(params["format"].as_str().unwrap_or("png")).ok_or_else(|| fail("unknown format"))?;
                let quality = params["quality"].as_u64().unwrap_or(72).min(100) as u8;
                capture::screen(bounds, w, h, format, quality).map(|b| b.map_or(Value::Null, |b| json!(STANDARD.encode(b)))).map_err(fail)
            }
            "clipboard.writeImage" => {
                let png = STANDARD.decode(text(params, "png")?).map_err(|e| fail(format!("png is not base64: {e}")))?;
                // decoded first: what is not a PNG never reaches (or opens) the clipboard
                let (w, h, rgba) = clipboard::decode_png(&png).map_err(fail)?;
                self.with_board(|b| clipboard::Board::set_image(b, w, h, &rgba))
            }
            "clipboard.writeText" => {
                let t = text(params, "text")?.to_string();
                self.with_board(|b| clipboard::write_text(b, &t))
            }
            "shell.openExternal" => opener::open_external(text(params, "url")?).map(|_| Value::Null).map_err(fail),
            "shell.openPath" => Ok(json!(opener::open_path(text(params, "path")?))),
            "shell.showItemInFolder" => opener::show_item_in_folder(text(params, "path")?).map(|_| Value::Null).map_err(fail),
            "dialogs.pickFolder" => Ok(json!(dialogs::pick_folder(self.picker.as_ref(), params["default"].as_str()))),
            "power.idle" => {
                let seconds = power::idle_seconds();
                let state = power::idle_state(self.tracker.locked(), seconds, params["threshold"].as_f64().unwrap_or(60.0));
                Ok(json!({ "seconds": seconds, "state": state }))
            }
            "capture.permitted" => Ok(json!(capture::permitted())),
            "app.appForProtocol" => Ok(json!(opener::app_for_protocol(text(params, "url")?))),
            other => Err(RpcError::new(-32601, format!("unknown method {other}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::tests::Memory;
    use std::path::{Path, PathBuf};

    struct Picked(Option<PathBuf>);
    impl dialogs::Picker for Picked {
        fn pick_folder(&self, _start: Option<&Path>) -> Option<PathBuf> {
            self.0.clone()
        }
    }

    fn services() -> Services {
        Services::new(Arc::new(Memory::default()), "svc".into(), Arc::new(Picked(Some("/Users/x/p".into()))), Default::default())
    }

    #[test]
    fn every_handled_method_is_known_and_slow_ones_are_handled() {
        let all = ["secrets.masterKey", "capture.screen", "clipboard.writeImage", "clipboard.writeText", "shell.openExternal", "shell.openPath", "shell.showItemInFolder", "dialogs.pickFolder", "power.idle", "app.appForProtocol"];
        for m in all {
            assert!(handles(m), "{m}");
        }
        assert!(!handles("overlay.create") && !handles("hello"));
        assert!(slow("dialogs.pickFolder") && !slow("shell.openExternal"));
        assert_eq!(services().handle("nope", &json!({})).unwrap_err().code, -32601);
    }

    #[test]
    fn the_master_key_is_asked_once_and_stays() {
        let s = services();
        let a = s.handle("secrets.masterKey", &json!({})).unwrap();
        assert_eq!(a["available"], json!(true));
        assert_eq!(s.handle("secrets.masterKey", &json!({})).unwrap(), a);
    }

    #[test]
    fn links_that_are_not_allowed_fail_without_opening_anything() {
        let s = services();
        for url in ["file:///etc/hosts", "javascript:alert(1)", "capri://x"] {
            assert!(s.handle("shell.openExternal", &json!({ "url": url })).is_err(), "{url}");
        }
        assert!(s.handle("shell.openExternal", &json!({})).is_err());
        assert_eq!(s.handle("shell.openPath", &json!({ "path": "relative" })).unwrap(), json!("the path is not absolute"));
        assert!(s.handle("shell.showItemInFolder", &json!({ "path": "/no/such/capri-7f3a" })).is_err());
    }

    #[test]
    fn the_folder_dialog_answers_with_a_path() {
        assert_eq!(services().handle("dialogs.pickFolder", &json!({ "default": null })).unwrap(), json!("/Users/x/p"));
        let none = Services::new(Arc::new(Memory::default()), "s".into(), Arc::new(Picked(None)), Default::default());
        assert_eq!(none.handle("dialogs.pickFolder", &json!({})).unwrap(), Value::Null);
    }

    #[test]
    fn capture_and_clipboard_check_their_input() {
        let s = services();
        assert!(s.handle("capture.screen", &json!({})).is_err());
        let bounds = json!({"x": 0, "y": 0, "width": 100, "height": 100});
        assert!(s.handle("capture.screen", &json!({"bounds": bounds, "width": 0, "height": 10, "format": "png"})).is_err());
        assert!(s.handle("capture.screen", &json!({"bounds": bounds, "width": 10, "height": 10, "format": "bmp"})).is_err());
        // not base64, and base64 of something that is not a PNG: refused before any clipboard is opened
        assert!(s.handle("clipboard.writeImage", &json!({"png": "***"})).is_err());
        assert!(s.handle("clipboard.writeImage", &json!({"png": STANDARD.encode("hello")})).is_err());
    }

    #[test]
    fn power_idle_answers() {
        let s = services();
        let v = s.handle("power.idle", &json!({})).unwrap();
        assert!(v.get("seconds").is_some());
        assert_ne!(v["state"], json!("locked"));
        s.tracker.set_locked(true);
        assert_eq!(s.handle("power.idle", &json!({})).unwrap()["state"], json!("locked"));
    }
}
