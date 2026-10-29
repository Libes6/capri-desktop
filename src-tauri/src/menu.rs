//! Menus (TAURI-06): her tray menu built from the data the core sends (src/main/tray-menu.js ->
//! platform/menu-wire.js), the macOS application menu, and the one door the shell's other UI modules
//! (tray, settings window, shortcuts, autostart) are reached through from lib.rs.
//!
//! The wire format is a list of items `{ id?, label?, type?, checked?, enabled?, accelerator?, submenu? }`.
//! Only the ones the core wants clicks on have an `id`; a click goes back as `tray.click { id, checked }`.
//! tauri's menus have no radio item: a radio is a check item that stays checked when clicked.

use std::collections::{HashMap, HashSet};
use std::sync::Once;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

use crate::sidecar::Sidecar;

/// Deep enough for her real menu (3 levels); a template beyond these is refused, not built.
pub const MAX_DEPTH: usize = 6;
pub const MAX_ITEMS: usize = 400;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ItemSpec {
    pub id: Option<String>,
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub checked: Option<bool>,
    pub enabled: Option<bool>,
    pub accelerator: Option<String>,
    pub submenu: Option<Vec<ItemSpec>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Normal,
    Checkbox,
    Radio,
    Separator,
    Submenu,
}

impl ItemSpec {
    pub fn kind(&self) -> Result<Kind, String> {
        if self.submenu.is_some() {
            return Ok(Kind::Submenu);
        }
        match self.kind.as_deref() {
            None | Some("normal") => Ok(Kind::Normal),
            Some("checkbox") => Ok(Kind::Checkbox),
            Some("radio") => Ok(Kind::Radio),
            Some("separator") => Ok(Kind::Separator),
            Some(other) => Err(format!("unknown menu item type {other}")),
        }
    }
}

/// Checks a template and lists the clickable ids with their kinds. Refuses: a type that is none of
/// the known, an item with no label, a repeated id, a template too deep or too large.
pub fn validate(items: &[ItemSpec]) -> Result<Vec<(String, Kind)>, String> {
    fn walk(items: &[ItemSpec], depth: usize, count: &mut usize, seen: &mut HashSet<String>, out: &mut Vec<(String, Kind)>) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(format!("menu deeper than {MAX_DEPTH} levels"));
        }
        for item in items {
            *count += 1;
            if *count > MAX_ITEMS {
                return Err(format!("menu with more than {MAX_ITEMS} items"));
            }
            let kind = item.kind()?;
            if kind != Kind::Separator && item.label.is_none() {
                return Err("a menu item without a label".into());
            }
            if let Some(id) = &item.id {
                if !seen.insert(id.clone()) {
                    return Err(format!("menu id {id} used twice"));
                }
                out.push((id.clone(), kind));
            }
            if let Some(sub) = &item.submenu {
                walk(sub, depth + 1, count, seen, out)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(items, 1, &mut 0, &mut HashSet::new(), &mut out)?;
    Ok(out)
}

/// What a click is told to the core as: a checkbox says what it is now, a radio is always picked.
pub fn click_payload(id: &str, kind: Kind, checked_after: bool) -> Value {
    json!({ "id": id, "checked": if kind == Kind::Radio { true } else { checked_after } })
}

/// What a built item lets us do after a click.
pub enum Handle {
    Plain,
    Check(CheckMenuItem<Wry>),
    Radio(CheckMenuItem<Wry>),
}

pub struct Built {
    pub menu: Menu<Wry>,
    pub handles: HashMap<String, Handle>,
}

fn make_item(app: &AppHandle, spec: &ItemSpec, handles: &mut HashMap<String, Handle>, serial: &mut usize) -> Result<Box<dyn IsMenuItem<Wry>>, String> {
    let e = |e: tauri::Error| e.to_string();
    let kind = spec.kind()?;
    // tauri wants an id for each item: the core's, or one of ours for those it does not click on
    let id = spec.id.clone().unwrap_or_else(|| {
        *serial += 1;
        format!("~{serial}")
    });
    let label = spec.label.clone().unwrap_or_default();
    let enabled = spec.enabled.unwrap_or(true);
    // an accelerator tauri cannot read must not cost the item
    let accel = spec.accelerator.as_deref();
    Ok(match kind {
        Kind::Separator => Box::new(PredefinedMenuItem::separator(app).map_err(e)?),
        Kind::Submenu => {
            let mut children: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
            for child in spec.submenu.as_deref().unwrap_or(&[]) {
                children.push(make_item(app, child, handles, serial)?);
            }
            let refs: Vec<&dyn IsMenuItem<Wry>> = children.iter().map(|c| c.as_ref()).collect();
            Box::new(Submenu::with_items(app, label, enabled, &refs).map_err(e)?)
        }
        Kind::Normal => {
            let item = MenuItem::with_id(app, id.clone(), &label, enabled, accel).or_else(|_| MenuItem::with_id(app, id.clone(), &label, enabled, None::<&str>)).map_err(e)?;
            if spec.id.is_some() {
                handles.insert(id, Handle::Plain);
            }
            Box::new(item)
        }
        Kind::Checkbox | Kind::Radio => {
            let checked = spec.checked.unwrap_or(false);
            let item = CheckMenuItem::with_id(app, id.clone(), &label, enabled, checked, accel).or_else(|_| CheckMenuItem::with_id(app, id.clone(), &label, enabled, checked, None::<&str>)).map_err(e)?;
            handles.insert(id, if kind == Kind::Radio { Handle::Radio(item.clone()) } else { Handle::Check(item.clone()) });
            Box::new(item)
        }
    })
}

/// A real menu from the template (validated first).
pub fn build(app: &AppHandle, items: &[ItemSpec]) -> Result<Built, String> {
    validate(items)?;
    let mut handles = HashMap::new();
    let mut serial = 0;
    let mut built: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for item in items {
        built.push(make_item(app, item, &mut handles, &mut serial)?);
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|c| c.as_ref()).collect();
    let menu = Menu::with_items(app, &refs).map_err(|e| e.to_string())?;
    Ok(Built { menu, handles })
}

/// Tells the core something (a notification to the sidecar).
pub fn tell(app: &AppHandle, method: &str, params: Value) {
    if let Some(s) = app.try_state::<Sidecar>() {
        s.notify(method, params);
    }
}

// --- the application menu (macOS) ---------------------------------------------------------------

const APP_MINIMIZE: &str = "app:minimize";
const APP_CLOSE: &str = "app:close";
const APP_QUIT: &str = "app:quit";

/// macOS: the keyboard shortcuts of text fields (Cmd+C, V, X, A, Z) come from the application menu, and
/// without one they do nothing in her settings window (pasting a key). A small one: the app with
/// Quit, Edit, Window. No DevTools or Reload. Window's Minimize and Close are not the predefined items:
/// Cmd+W / Cmd+M would close or minimize her overlay too, focused while you type in her chat, and with
/// no Dock icon there would be no getting her back; they act on the focused window unless it is the
/// overlay. Windows and Linux have no application menu (text fields have their shortcuts without one).
pub fn install_app_menu(app: &AppHandle) -> Result<(), String> {
    ensure_events(app);
    #[cfg(target_os = "macos")]
    {
        let e = |e: tauri::Error| e.to_string();
        let name = app.package_info().name.clone();
        let name = app.config().product_name.clone().unwrap_or(name);
        let quit = MenuItem::with_id(app, APP_QUIT, format!("Quit {name}"), true, Some("CmdOrCtrl+Q")).map_err(e)?;
        let about = PredefinedMenuItem::about(app, None, None).map_err(e)?;
        let sep = || PredefinedMenuItem::separator(app).map_err(e);
        let (s1, s2, s3) = (sep()?, sep()?, sep()?);
        let hide = PredefinedMenuItem::hide(app, None).map_err(e)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None).map_err(e)?;
        let app_menu = Submenu::with_items(app, &name, true, &[&about, &s1, &hide, &hide_others, &s2, &quit]).map_err(e)?;
        let (undo, redo) = (PredefinedMenuItem::undo(app, None).map_err(e)?, PredefinedMenuItem::redo(app, None).map_err(e)?);
        let (cut, copy, paste, all) = (
            PredefinedMenuItem::cut(app, None).map_err(e)?,
            PredefinedMenuItem::copy(app, None).map_err(e)?,
            PredefinedMenuItem::paste(app, None).map_err(e)?,
            PredefinedMenuItem::select_all(app, None).map_err(e)?,
        );
        let edit = Submenu::with_items(app, "Edit", true, &[&undo, &redo, &s3, &cut, &copy, &paste, &all]).map_err(e)?;
        let minimize = MenuItem::with_id(app, APP_MINIMIZE, "Minimize", true, Some("CmdOrCtrl+M")).map_err(e)?;
        let close = MenuItem::with_id(app, APP_CLOSE, "Close Window", true, Some("CmdOrCtrl+W")).map_err(e)?;
        let window = Submenu::with_items(app, "Window", true, &[&minimize, &close]).map_err(e)?;
        let menu = Menu::with_items(app, &[&app_menu, &edit, &window]).map_err(e)?;
        app.set_menu(menu).map_err(e)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app.remove_menu();
    }
    Ok(())
}

/// The window an application-menu command is for: the focused one, never the overlay.
fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.label() != crate::overlay::LABEL && w.is_focused().unwrap_or(false))
}

fn on_app_item(app: &AppHandle, id: &str) {
    match id {
        APP_MINIMIZE => {
            if let Some(w) = focused_window(app) {
                let _ = w.minimize();
            }
        }
        APP_CLOSE => {
            if let Some(w) = focused_window(app) {
                let _ = w.close();
            }
        }
        // the app's own quit: the core is stopped first (as `app.quit` from the core does, lib.rs); the
        // predefined Quit would be refused by the "she lives on" rule
        APP_QUIT => {
            let (app, sidecar) = (app.clone(), app.try_state::<Sidecar>().map(|s| s.inner().clone()));
            std::thread::spawn(move || {
                if let Some(s) = sidecar {
                    s.shutdown(Duration::from_secs(2));
                }
                app.exit(0);
            });
        }
        _ => {}
    }
}

/// One handler for every menu: `app:` ids are the application menu's, the others the tray's.
pub fn ensure_events(app: &AppHandle) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        app.on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id.starts_with("app:") {
                on_app_item(app, id);
            } else {
                crate::tray::on_item(app, id);
            }
        });
    });
}

// --- the door from lib.rs -----------------------------------------------------------------------

/// A request of the core that is for these modules; None when it is not.
pub fn route_request(app: &AppHandle, method: &str, params: &Value) -> Option<Result<Value, String>> {
    Some(match method {
        "shortcuts.register" => crate::shortcuts::register(app, params),
        "autostart.set" => crate::autostart::set(app, params),
        "settings.eval" => crate::settings_window::eval(app, params),
        "tray.describe" => crate::tray::describe(app),
        "tray.fire" => crate::tray::fire(app, params),
        _ => return None,
    })
}

/// A notification of the core that is for these modules; false when it is not.
pub fn route_notification(app: &AppHandle, method: &str, params: &Value) -> bool {
    let result = match method {
        "tray.create" => crate::tray::create(app),
        "tray.setMenu" => crate::tray::set_menu(app, params),
        "tray.popup" => crate::tray::popup(app, params),
        "app.installMenu" => install_app_menu(app),
        "settings.open" => crate::settings_window::open(app, params),
        "settings.close" => crate::settings_window::close(app),
        "demo.open" => crate::demo::open(app, params),
        "demo.close" => crate::demo::close(app, params),
        "settings.reset" => crate::settings_window::close(app),
        "settings.title" => crate::settings_window::set_title(app, params),
        "shortcuts.unregisterAll" => crate::shortcuts::unregister_all(app),
        _ => return false,
    };
    if let Err(e) = result {
        eprintln!("[capri] {method}: {e}");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> Vec<ItemSpec> {
        serde_json::from_value(v).expect("a template")
    }

    /// The shape platform/menu-wire.js sends (see tests/menu-wire.test.js for the other side).
    fn sample() -> Value {
        json!([
            { "label": "Online · port 47823", "enabled": false },
            { "type": "separator" },
            { "id": "t1.0", "label": "Teleport" },
            { "id": "t1.1", "label": "Hide", "accelerator": "Ctrl+Alt+C" },
            { "label": "Size", "submenu": [
                { "id": "t1.2", "label": "Small", "type": "radio", "checked": false },
                { "id": "t1.3", "label": "Medium", "type": "radio", "checked": true },
            ]},
            { "label": "Sound", "submenu": [
                { "id": "t1.4", "label": "Mute", "type": "checkbox", "checked": true },
                { "type": "separator" },
                { "label": "Languages", "submenu": [{ "id": "t1.5", "label": "English", "type": "radio", "checked": true }] },
            ]},
        ])
    }

    #[test]
    fn a_template_of_the_core_is_read_and_its_clickable_ids_listed_in_order() {
        let items = parse(sample());
        assert_eq!(items.len(), 6);
        assert_eq!(items[0].enabled, Some(false));
        assert_eq!(items[4].submenu.as_ref().unwrap()[1].checked, Some(true));
        let ids = validate(&items).unwrap();
        assert_eq!(
            ids,
            vec![
                ("t1.0".to_string(), Kind::Normal),
                ("t1.1".to_string(), Kind::Normal),
                ("t1.2".to_string(), Kind::Radio),
                ("t1.3".to_string(), Kind::Radio),
                ("t1.4".to_string(), Kind::Checkbox),
                ("t1.5".to_string(), Kind::Radio),
            ]
        );
    }

    #[test]
    fn kinds_come_from_the_type_and_a_submenu_wins() {
        let k = |v: Value| parse(json!([v]))[0].kind();
        assert_eq!(k(json!({"label": "a"})), Ok(Kind::Normal));
        assert_eq!(k(json!({"label": "a", "type": "checkbox"})), Ok(Kind::Checkbox));
        assert_eq!(k(json!({"type": "separator"})), Ok(Kind::Separator));
        assert_eq!(k(json!({"label": "a", "submenu": []})), Ok(Kind::Submenu));
        assert!(k(json!({"label": "a", "type": "banana"})).is_err());
    }

    #[test]
    fn a_bad_template_is_refused_not_built() {
        let dup = parse(json!([{"id": "x", "label": "a"}, {"id": "x", "label": "b"}]));
        assert!(validate(&dup).unwrap_err().contains("twice"));
        let nameless = parse(json!([{"id": "x"}]));
        assert!(validate(&nameless).unwrap_err().contains("label"));
        let unknown = parse(json!([{"label": "a", "type": "banana"}]));
        assert!(validate(&unknown).is_err());
        // too deep
        let mut deep = json!([{"id": "leaf", "label": "x"}]);
        for _ in 0..MAX_DEPTH {
            deep = json!([{"label": "level", "submenu": deep}]);
        }
        assert!(validate(&parse(deep)).unwrap_err().contains("deeper"));
        // too large
        let many: Vec<Value> = (0..=MAX_ITEMS).map(|i| json!({"id": format!("i{i}"), "label": "x"})).collect();
        assert!(validate(&parse(json!(many))).unwrap_err().contains("more than"));
    }

    #[test]
    fn a_click_is_told_as_the_item_is_after_it() {
        assert_eq!(click_payload("t1.0", Kind::Normal, false), json!({"id": "t1.0", "checked": false}));
        assert_eq!(click_payload("t1.4", Kind::Checkbox, false), json!({"id": "t1.4", "checked": false}));
        assert_eq!(click_payload("t1.4", Kind::Checkbox, true), json!({"id": "t1.4", "checked": true}));
        // a radio picked stays picked, whatever the check item toggled to
        assert_eq!(click_payload("t1.2", Kind::Radio, false), json!({"id": "t1.2", "checked": true}));
    }

    #[test]
    fn the_wire_format_of_the_core_is_what_the_structs_read() {
        // every key menu-wire.js can write
        let item: ItemSpec = serde_json::from_value(json!({
            "id": "t3.9", "label": "L", "type": "checkbox", "checked": false, "enabled": false, "accelerator": "Ctrl+Alt+C"
        }))
        .unwrap();
        assert_eq!(item.id.as_deref(), Some("t3.9"));
        assert_eq!(item.accelerator.as_deref(), Some("Ctrl+Alt+C"));
        assert_eq!(item.kind(), Ok(Kind::Checkbox));
    }
}
