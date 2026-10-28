//! The Tauri shell of Capri (TAURI-04). The core of Capri runs in a Node sidecar; this process owns
//! the windows and the system. Her pages call one command, `host_invoke { scope, name, args }`, which
//! Rust passes to the core as it is (it knows no command names: the core's dispatcher validates and
//! authorizes by scope), and the core's events come back as `capri://<channel>` events to the window
//! they are for. See docs/TAURI_DEV.md and docs/TAURI_SIDECAR.md.

mod assets;
mod autostart;
mod capture;
mod clipboard;
mod dialogs;
mod menu;
#[cfg(target_os = "macos")]
mod mac;
mod opener;
mod overlay;
mod power;
pub mod rpc;
mod secrets;
mod services;
mod settings_window;
mod shortcuts;
pub mod sidecar;
mod tray;
pub mod updater;

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

use rpc::RpcError;
use sidecar::{Handler, RestartPolicy, Sidecar};

/// A safety net, not a limit anyone should meet: a command the core never answers frees its page after this.
fn invoke_timeout() -> Duration {
    Duration::from_millis(std::env::var("CAPRI_INVOKE_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(15 * 60 * 1000))
}

static USER_DATA: OnceLock<PathBuf> = OnceLock::new();

/// Her pages' only door. `scope` is the window's own (a page cannot speak for another window);
/// the core's dispatcher checks the command, its arguments and the scope again.
#[tauri::command]
async fn host_invoke(window: tauri::WebviewWindow, sidecar: State<'_, Sidecar>, scope: String, name: String, args: Option<Vec<Value>>) -> Result<Value, String> {
    if scope != window.label() {
        return Err(format!("forbidden: the {} window cannot call in the {scope} scope", window.label()));
    }
    let params = json!({ "scope": scope, "name": name, "args": args.unwrap_or_default(), "sender": { "label": window.label() } });
    sidecar.request("invoke", params, invoke_timeout()).await.map_err(|e| e.to_string())
}

/// What the sidecar asks and tells (sidecar/main.js and src/main/platform/sidecar.js).
struct Bridge {
    app: AppHandle,
    sidecar: OnceLock<Sidecar>,
    /// the system's key store, capture, clipboard, links, dialogs, idle time (TAURI-07)
    services: services::Services,
}

impl Bridge {
    fn push(&self, method: &str, params: Value) {
        if let Some(s) = self.sidecar.get() {
            s.notify(method, params);
        }
    }

    fn hello(&self) -> Value {
        let app = &self.app;
        let p = app.path();
        let path = |r: tauri::Result<PathBuf>| r.ok().map(|p| p.to_string_lossy().into_owned());
        let user_data = USER_DATA.get().map(|p| p.to_string_lossy().into_owned());
        let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
        let resources = path(p.resource_dir());
        let root = repo_root().map(|r| r.to_string_lossy().into_owned());
        let packaged = false; // until TAURI-12/13: the updater and the feed are Electron's
        let (screens, cursor) = (overlay::screens(app), json!({"x": 0, "y": 0}));
        json!({
            "name": app.config().product_name.clone().unwrap_or_else(|| "Capri".into()),
            "identifier": app.config().identifier,
            "version": app.package_info().version.to_string(),
            "tauri": tauri::VERSION,
            "packaged": packaged,
            "updater": updater::status(app),
            "paths": {
                "userData": user_data, "home": path(p.home_dir()), "desktop": path(p.desktop_dir()),
                "documents": path(p.document_dir()), "downloads": path(p.download_dir()), "pictures": path(p.picture_dir()),
                "music": path(p.audio_dir()), "videos": path(p.video_dir()), "temp": path(p.temp_dir()),
                "exe": exe, "appPath": root.clone().or(resources.clone()), "resources": resources.or(root),
            },
            "screens": screens["list"],
            "cursor": cursor,
            "autostart": autostart::is_enabled(app),
            "locked": power::locked_now(),
        })
    }
}

impl Handler for Bridge {
    fn on_request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let fail = |e: String| RpcError::new(-32000, e);
        let rect = |v: &Value| serde_json::from_value::<overlay::Rect>(v.clone()).map_err(|e| fail(format!("bad rect: {e}")));
        match method {
            "hello" => Ok(self.hello()),
            "overlay.create" => overlay::create(&self.app, rect(&params["area"])?).map(|r| json!(r)).map_err(fail),
            "overlay.setBounds" => overlay::set_bounds(&self.app, rect(&params["rect"])?).map(|r| json!(r)).map_err(fail),
            m if services::handles(m) => self.services.handle(m, &params),
            // tray, menus, settings window, shortcuts, autostart (TAURI-06)
            _ => menu::route_request(&self.app, method, &params).map(|r| r.map_err(fail)).unwrap_or_else(|| Err(RpcError::new(-32601, format!("unknown method {method}")))),
        }
    }

    fn slow(&self, method: &str) -> bool {
        services::slow(method)
    }

    fn on_notification(&self, method: &str, params: Value) {
        match method {
            // an event for one of her windows: "capri://<channel>" (host.js)
            "emit" => {
                let (label, event) = (params["window"].as_str().unwrap_or(""), params["event"].as_str().unwrap_or(""));
                if let Err(e) = self.app.emit_to(label, &format!("capri://{event}"), params["payload"].clone()) {
                    eprintln!("[capri] emit {event} to {label}: {e}");
                }
            }
            "overlay.clickThrough" => overlay::click_through(&self.app, params["on"].as_bool().unwrap_or(true)),
            "overlay.keepOnTop" => overlay::keep_on_top(&self.app),
            "overlay.raise" => overlay::raise(&self.app),
            "overlay.setFocusable" => overlay::set_focusable(&self.app, params["on"].as_bool().unwrap_or(false)),
            "overlay.focus" => overlay::focus(&self.app),
            "overlay.blur" => overlay::blur(&self.app),
            "app.quit" | "app.exit" | "app.relaunch" => {
                // on its own thread: the shutdown waits for the very thread this is called from
                let (app, sidecar, relaunch) = (self.app.clone(), self.sidecar.get().cloned(), method == "app.relaunch");
                let code = params["code"].as_i64().unwrap_or(0) as i32;
                std::thread::spawn(move || {
                    if let Some(s) = sidecar {
                        s.shutdown(Duration::from_secs(2));
                    }
                    if relaunch {
                        app.restart();
                    }
                    app.exit(code);
                });
            }
            m if m.starts_with("updater.") => {
                let sidecar = self.sidecar.get().cloned();
                let notify: updater::Notify = Arc::new(move |method, params| {
                    if let Some(s) = &sidecar {
                        s.notify(method, params);
                    }
                });
                if !updater::handle(&self.app, m, &params, notify) {
                    eprintln!("[capri] unknown updater call from the core: {m}");
                }
            }
            "app.focus" => {} // TAURI-05: the chat takes the keyboard
            "ready" => println!("[capri] core ready (sidecar pid {})", params["pid"]),
            other => {
                if !menu::route_notification(&self.app, other, &params) {
                    eprintln!("[capri] unknown notification from the core: {other}");
                }
            }
        }
    }

    fn on_down(&self, reason: &str, restarting: bool) {
        println!("[capri] core down: {reason} (restarting: {restarting})");
    }
}

/// The project folder when run from a clone (dev): where sidecar/ and src/ are. None when packaged.
fn repo_root() -> Option<PathBuf> {
    if let Some(r) = std::env::var_os("CAPRI_ROOT") {
        return Some(PathBuf::from(r));
    }
    let guess = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent()?.to_path_buf();
    guess.join("sidecar").join("main.js").exists().then_some(guess)
}

/// The sidecar's command: CAPRI_SIDECAR (any executable), else the bundled `capri-sidecar` next to this
/// one (externalBin), else `node sidecar/main.js` from the project folder (dev; CAPRI_NODE names the node).
fn sidecar_command() -> Command {
    if let Some(custom) = std::env::var_os("CAPRI_SIDECAR") {
        return Command::new(custom);
    }
    let bundled = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(if cfg!(windows) { "capri-sidecar.exe" } else { "capri-sidecar" })));
    if let Some(b) = bundled.filter(|b| b.exists()) {
        return Command::new(b);
    }
    let mut c = Command::new(std::env::var_os("CAPRI_NODE").unwrap_or_else(|| "node".into()));
    if let Some(root) = repo_root() {
        c.arg(root.join("sidecar").join("main.js")).env("CAPRI_ROOT", root);
    }
    c
}

/// CAPRI_DEBUG_STDIN=1 (tests, a look inside): each line of stdin is run as JavaScript in her page and
/// the result printed as `[eval] ...`; a line `!sidecar` prints the sidecar's pid and state, `!kill`
/// kills the sidecar (to watch it come back), `!exit` ends the app.
fn debug_stdin(app: AppHandle) {
    use std::io::BufRead;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let sidecar = app.state::<Sidecar>();
            match line.as_str() {
                "!sidecar" => println!("[debug] sidecar pid={:?} state={:?}", sidecar.pid(), sidecar.state()),
                "!kill" => {
                    if let Some(pid) = sidecar.pid() {
                        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
                    }
                }
                "!exit" => app.exit(0),
                js => {
                    if let Some(w) = app.get_webview_window(overlay::LABEL) {
                        let _ = w.eval_with_callback(js, |r| println!("[eval] {r}"));
                    }
                }
            }
        }
    });
}

fn start_core(app: &AppHandle) {
    let tracker = Arc::new(power::Tracker::default());
    let services = services::Services::new(Arc::new(secrets::SystemBackend), secrets::service_name(), Arc::new(dialogs::SystemPicker(app.clone())), tracker.clone());
    let bridge = Arc::new(Bridge { app: app.clone(), sidecar: OnceLock::new(), services });
    let sidecar = Sidecar::start(sidecar_command, bridge.clone(), RestartPolicy::new(5, Duration::from_secs(60), Duration::from_millis(200)));
    bridge.sidecar.set(sidecar.clone()).ok();
    app.manage(sidecar);
    let pusher = bridge.clone();
    overlay::start_poll(app.clone(), move |method, params| pusher.push(method, params));
    // sleep, wake, lock, user switch: to the core as `power` { event } (on the main thread, which is where this runs)
    let pusher = bridge.clone();
    let sink: power::Sink = Arc::new(move |event| pusher.push("power", json!({ "event": event.name() })));
    app.manage(power::start(tracker, sink));
}

pub fn run() {
    let app = tauri::Builder::default()
        // first: a second launch is told to the core, which brings her status up (main.js did the same)
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(s) = app.try_state::<Sidecar>() {
                s.notify("second-instance", json!({ "argv": argv, "cwd": cwd }));
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .register_uri_scheme_protocol("capri", |_ctx, request| match USER_DATA.get() {
            Some(dir) => assets::serve_user_sounds(dir, &request),
            None => tauri::http::Response::builder().status(503).body(Vec::new()).unwrap(),
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![host_invoke])
        .setup(|app| {
            // no Dock icon, no menu bar; before any window is made (see overlay.rs)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // CAPRI_USER_DATA: another profile (tests, a try-out), so the real one is not touched
            let user_data = match std::env::var_os("CAPRI_USER_DATA") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?, // by identifier: .../capri.desktop
            };
            std::fs::create_dir_all(&user_data)?;
            USER_DATA.set(user_data).ok();

            // updates exist only in a provisioned build (a public key and https endpoints, updater.rs)
            updater::initialize(app)?;

            if std::env::var_os("CAPRI_DEBUG_STDIN").is_some() {
                debug_stdin(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Capri shell");

    app.run(|app, event| match event {
        // the core starts once the event loop runs: its first question (hello) asks for the screens,
        // which Tauri answers only from the loop
        RunEvent::Ready => start_core(app),
        // she has no window to speak of: closing the last one does not end her
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(s) = app.try_state::<Sidecar>() {
                s.shutdown(Duration::from_secs(2));
            }
        }
        _ => {}
    });
}
