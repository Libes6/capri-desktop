//! Her tray icon (TAURI-06). The icon is the Electron build's (assets/icons/tray.png, in colour: not a
//! template image there either). The menu is the core's data (menu.rs builds it); a click on an item goes
//! back to the core as `tray.click`. As in the Electron build: on macOS the icon opens the menu; on
//! Windows and Linux a left click is the core's `onClick` (her status) and a right click opens the menu.
//! The same menu opens at the pointer over her overlay (right click on her) or her settings window.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{ContextMenu, Menu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::menu::{self, Built, Handle, ItemSpec, Kind};

const ICON: &[u8] = include_bytes!("../../assets/icons/tray.png");
const TRAY_ID: &str = "capri";

struct State {
    tray: Option<TrayIcon>,
    menu: Option<Menu<Wry>>,
    handles: HashMap<String, Handle>,
    // the menu before this one: it may be open while it is rebuilt, and its click still counts
    previous: HashMap<String, Handle>,
}

struct TrayState(Mutex<State>);

fn state(app: &AppHandle) -> tauri::State<'_, TrayState> {
    if app.try_state::<TrayState>().is_none() {
        app.manage(TrayState(Mutex::new(State { tray: None, menu: None, handles: HashMap::new(), previous: HashMap::new() })));
    }
    app.state::<TrayState>()
}

/// The icon, once; asking again changes nothing.
pub fn create(app: &AppHandle) -> Result<(), String> {
    let st = state(app);
    let mut st = st.0.lock().unwrap();
    if st.tray.is_some() {
        return Ok(());
    }
    menu::ensure_events(app);
    let icon = Image::from_bytes(ICON).map_err(|e| e.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Capri")
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| on_icon_event(tray.app_handle(), &event));
    if let Some(m) = &st.menu {
        builder = builder.menu(m);
    }
    st.tray = Some(builder.build(app).map_err(|e| e.to_string())?);
    // the system places the icon a moment after it is made
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        push_bounds(&handle);
    });
    Ok(())
}

/// The icon's place for the core (her guide points at it). The events above carry it, but only once the pointer
/// touches the icon; `push_bounds` asks the tray itself, so it is known before that (Electron's `tray.getBounds()`).
fn tell_rect(app: &AppHandle, r: &tauri::Rect) {
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    let (p, s) = (r.position.to_logical::<f64>(scale), r.size.to_logical::<f64>(scale));
    menu::tell(app, "tray.bounds", json!({ "x": p.x.round(), "y": p.y.round(), "width": s.width.round(), "height": s.height.round() }));
}

fn push_bounds(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let st = state(&handle);
        let rect = st.0.lock().ok().and_then(|st| st.tray.as_ref().and_then(|t| t.rect().ok().flatten()));
        if let Some(r) = rect {
            tell_rect(&handle, &r);
        }
    });
}

fn on_icon_event(app: &AppHandle, event: &TrayIconEvent) {
    let rect = match event {
        TrayIconEvent::Click { rect, .. } | TrayIconEvent::Enter { rect, .. } | TrayIconEvent::Move { rect, .. } | TrayIconEvent::Leave { rect, .. } | TrayIconEvent::DoubleClick { rect, .. } => Some(rect),
        _ => None,
    };
    if let Some(r) = rect {
        tell_rect(app, r);
    }
    // a left click on Windows and Linux (the menu is the right click's there)
    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        if !cfg!(target_os = "macos") {
            menu::tell(app, "tray.iconClick", json!({}));
        }
    }
}

/// A new menu from the core's data replaces the old one.
pub fn set_menu(app: &AppHandle, params: &Value) -> Result<(), String> {
    let items: Vec<ItemSpec> = serde_json::from_value(params["items"].clone()).map_err(|e| format!("bad menu: {e}"))?;
    let Built { menu, handles } = menu::build(app, &items)?;
    create(app)?;
    let st = state(app);
    let mut st = st.0.lock().unwrap();
    if let Some(tray) = &st.tray {
        tray.set_menu(Some(menu.clone())).map_err(|e| e.to_string())?;
    }
    st.menu = Some(menu);
    st.previous = std::mem::replace(&mut st.handles, handles);
    drop(st);
    push_bounds(app); // the menu bar's icons move when others come and go
    Ok(())
}

/// A click on one of her items (menu.rs hands it over): what it is now, back to the core.
pub fn on_item(app: &AppHandle, id: &str) {
    let st = state(app);
    let st = st.0.lock().unwrap();
    let Some(handle) = st.handles.get(id).or_else(|| st.previous.get(id)) else { return };
    let kind = match handle {
        Handle::Plain => Kind::Normal,
        Handle::Check(_) => Kind::Checkbox,
        Handle::Radio(_) => Kind::Radio,
    };
    let checked = match Some(handle) {
        // a check item toggles itself when clicked: what it shows now is what the core is told
        Some(Handle::Check(item)) => item.is_checked().unwrap_or(false),
        // a radio stays picked
        Some(Handle::Radio(item)) => {
            let _ = item.set_checked(true);
            true
        }
        _ => false,
    };
    menu::tell(app, "tray.click", menu::click_payload(id, kind, checked));
}

/// Her menu at the pointer, over the overlay (right click on her) or the settings window. On a thread of
/// its own: the menu takes over the main thread until it is closed, and the core's messages go on.
pub fn popup(app: &AppHandle, params: &Value) -> Result<(), String> {
    let label = if params["window"].as_str() == Some("settings") { crate::settings_window::LABEL } else { crate::overlay::LABEL };
    let Some(win) = app.get_webview_window(label) else { return Ok(()) };
    let st = state(app);
    let Some(m) = st.0.lock().unwrap().menu.clone() else { return Ok(()) };
    std::thread::spawn(move || {
        if let Err(e) = m.popup(win.as_ref().window()) {
            eprintln!("[capri] tray popup: {e}");
        }
    });
    Ok(())
}

/// Debug (CAPRI_DEBUG): the menu as Rust holds it, `{ id: kind-and-state }`.
pub fn describe(app: &AppHandle) -> Result<Value, String> {
    debug_only()?;
    let st = state(app);
    let st = st.0.lock().unwrap();
    let mut out = serde_json::Map::new();
    for (id, handle) in &st.handles {
        let v = match handle {
            Handle::Plain => json!("item"),
            Handle::Check(i) => json!({ "checkbox": i.is_checked().unwrap_or(false) }),
            Handle::Radio(i) => json!({ "radio": i.is_checked().unwrap_or(false) }),
        };
        out.insert(id.clone(), v);
    }
    Ok(json!({ "icon": st.tray.is_some(), "items": out }))
}

/// Debug (CAPRI_DEBUG): a click on an item as the menu event does it (a check item is toggled first,
/// as the system would have done).
pub fn fire(app: &AppHandle, params: &Value) -> Result<Value, String> {
    debug_only()?;
    let id = params["id"].as_str().ok_or("fire needs an id")?;
    {
        let st = state(app);
        let st = st.0.lock().unwrap();
        if let Some(Handle::Check(item)) = st.handles.get(id) {
            let now = item.is_checked().unwrap_or(false);
            let _ = item.set_checked(!now);
        }
    }
    on_item(app, id);
    Ok(json!(true))
}

fn debug_only() -> Result<(), String> {
    if std::env::var_os("CAPRI_DEBUG").is_some() { Ok(()) } else { Err("debug requests need CAPRI_DEBUG".into()) }
}
