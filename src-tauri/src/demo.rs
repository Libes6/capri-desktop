//! The demo's little fake terminal (TAURI-11): a plain window with a page of its own that she can sit on and
//! take over while the demo runs (Electron: `createDemoTerminal` of platform/electron.js). The core sends the
//! page as HTML; it is shown in a window with no rights (no capability names it: it cannot call the bridge),
//! at the given place, without taking the keyboard. Many ids may exist for a moment (the core closes the old
//! one and opens a new one in the same breath); each window is `demo-<id>`.

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::menu::tell;

#[derive(Debug, Deserialize)]
struct OpenParams {
    id: u64,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    title: Option<String>,
    background: Option<String>,
    #[serde(rename = "alwaysOnTop")]
    always_on_top: Option<bool>,
    html: String,
}

fn label(id: u64) -> String {
    format!("demo-{id}")
}

/// `data:text/html` with the page percent-encoded (a page is text; every byte outside a-z, 0-9 and `-_.~` is escaped).
pub fn data_url(html: &str) -> String {
    let mut out = String::from("data:text/html;charset=utf-8,");
    for b in html.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// "#14101c" -> a colour; anything else: the dark default.
fn parse_color(s: Option<&str>) -> Color {
    let hex = s.unwrap_or("").trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(v) = u32::from_str_radix(hex, 16) {
            return Color((v >> 16) as u8, (v >> 8) as u8, v as u8, 0xff);
        }
    }
    Color(0x14, 0x10, 0x1c, 0xff)
}

pub fn open(app: &AppHandle, params: &Value) -> Result<(), String> {
    let p: OpenParams = serde_json::from_value(params.clone()).map_err(|e| format!("bad demo.open: {e}"))?;
    let name = label(p.id);
    let url = tauri::Url::parse(&data_url(&p.html)).map_err(|e| e.to_string())?;
    let mut builder = WebviewWindowBuilder::new(app, &name, WebviewUrl::External(url))
        .title(p.title.unwrap_or_else(|| "Capri".into()))
        .inner_size(p.width.unwrap_or(620.0), p.height.unwrap_or(300.0))
        .background_color(parse_color(p.background.as_deref()))
        .always_on_top(p.always_on_top.unwrap_or(false))
        .visible(false)
        .focused(false)
        // its page is its page: nothing else loads in it
        .on_navigation(|url| url.scheme() == "data")
        .on_page_load(|win, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = win.show(); // shown, not focused (Electron's showInactive)
            }
        });
    if let (Some(x), Some(y)) = (p.x, p.y) {
        builder = builder.position(x, y);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    let (handle, id) = (app.clone(), p.id);
    win.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            tell(&handle, "demo.closed", json!({ "id": id }));
        }
    });
    Ok(())
}

pub fn close(app: &AppHandle, params: &Value) -> Result<(), String> {
    let id = params["id"].as_u64().ok_or("demo.close needs an id")?;
    if let Some(win) = app.get_webview_window(&label(id)) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_travels_as_a_data_url_that_parses_back() {
        let html = "<body style=\"margin:0\">PS C:\\night &gt; ✓ ok</body>";
        let url = data_url(html);
        assert!(url.starts_with("data:text/html;charset=utf-8,"));
        assert!(!url.contains(' ') && !url.contains('<') && !url.contains('"'));
        let parsed = tauri::Url::parse(&url).expect("a URL");
        assert_eq!(parsed.scheme(), "data");
        let body = url.split_once(',').unwrap().1;
        let bytes: Vec<u8> = {
            let b = body.as_bytes();
            let mut out = Vec::new();
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'%' {
                    out.push(u8::from_str_radix(&body[i + 1..i + 3], 16).unwrap());
                    i += 3;
                } else {
                    out.push(b[i]);
                    i += 1;
                }
            }
            out
        };
        assert_eq!(String::from_utf8(bytes).unwrap(), html);
    }

    #[test]
    fn colours_read_as_the_core_writes_them() {
        assert_eq!(parse_color(Some("#14101c")).0, 0x14);
        assert_eq!(parse_color(Some("#fcee0a")).1, 0xee);
        assert_eq!(parse_color(Some("nonsense")).2, 0x1c);
        assert_eq!(parse_color(None).0, 0x14);
    }
}
