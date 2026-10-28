//! Global shortcuts (TAURI-06): tauri-plugin-global-shortcut, with the accelerator names the core uses
//! ('Control+Alt+C' for hide/show, core.js). A press goes to the core as `shortcut { id }`; the core
//! holds the function (platform/sidecar.js). There is no capability for this: only Rust calls the
//! plugin, her pages never can.

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::menu::tell;

/// Electron's accelerator ('Control+Alt+C', 'CmdOrCtrl+Shift+K') as the plugin's shortcut.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    // the plugin knows 'ctrl'/'control', 'alt'/'option', 'shift', 'super'/'cmd'/'command', 'commandorcontrol'/'cmdorctrl'
    accelerator.trim().parse::<Shortcut>().map_err(|e| format!("bad accelerator {accelerator:?}: {e}"))
}

/// `{ id, accelerator }` -> `{ ok }`; false when another app holds it.
pub fn register(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_str().ok_or("register needs an id")?.to_string();
    let shortcut = parse(params["accelerator"].as_str().ok_or("register needs an accelerator")?)?;
    let gs = app.global_shortcut();
    if gs.is_registered(shortcut) {
        let _ = gs.unregister(shortcut);
    }
    let result = gs.on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            tell(app, "shortcut", json!({ "id": id }));
        }
    });
    match result {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

pub fn unregister_all(app: &AppHandle) -> Result<(), String> {
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn the_cores_accelerator_is_read() {
        let s = parse("Control+Alt+C").unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyC));
        assert_eq!(parse(" Ctrl+Alt+C ").unwrap(), s);
        assert!(parse("CmdOrCtrl+Shift+K").is_ok());
    }

    #[test]
    fn nonsense_is_refused() {
        assert!(parse("").is_err());
        assert!(parse("Control+Alt+").is_err());
        assert!(parse("Banana+C").is_err());
    }
}
