//! Starting with the system (TAURI-06): tauri-plugin-autostart. macOS: a LaunchAgent; Windows: the
//! registry's Run key; Linux has none by decision (capabilities.js says `autostart` is not there, the
//! core never asks). The state is read once, for `hello` (the core's platform answers `isEnabled`
//! synchronously from it), and written on `autostart.set`.
//!
//! CAPRI_AUTOSTART_FAKE=<file>: the state is that file's (present: on) and nothing of the system is
//! touched. For tests and try-outs: turning the real autostart on from a dev build would leave a
//! login item behind.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

fn fake() -> Option<PathBuf> {
    std::env::var_os("CAPRI_AUTOSTART_FAKE").map(PathBuf::from)
}

fn fake_get(file: &std::path::Path) -> bool {
    file.exists()
}

fn fake_set(file: &std::path::Path, on: bool) -> Result<(), String> {
    if on {
        std::fs::write(file, b"on").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub fn is_enabled(app: &AppHandle) -> bool {
    if let Some(file) = fake() {
        return fake_get(&file);
    }
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// `{ on }`: errors come back to the core, which puts its idea of the state back.
pub fn set(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let on = params["on"].as_bool().ok_or("autostart.set needs on: true or false")?;
    if let Some(file) = fake() {
        fake_set(&file, on)?;
        return Ok(json!({ "on": on }));
    }
    let launch = app.autolaunch();
    if on { launch.enable() } else { launch.disable() }.map_err(|e| e.to_string())?;
    Ok(json!({ "on": launch.is_enabled().unwrap_or(on) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stand_in_keeps_the_state_in_a_file() {
        let dir = std::env::temp_dir().join(format!("capri-autostart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("state");
        assert!(!fake_get(&file));
        fake_set(&file, true).unwrap();
        assert!(fake_get(&file));
        fake_set(&file, false).unwrap();
        assert!(!fake_get(&file));
        fake_set(&file, false).unwrap(); // off again is fine
        std::fs::remove_dir_all(&dir).ok();
    }
}
