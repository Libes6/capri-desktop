//! In-app updates (TAURI-10, docs/TAURI_UPDATES.md): `tauri-plugin-updater` driven from Rust on the
//! core's behalf. The core (src/main/updates.js) holds the statuses and the rules; this file does what
//! only the shell can: ask the signed feed, download and verify the package (minisign), replace the
//! app. No webview ever talks to the plugin (no capability grants it anything).
//!
//! The sidecar asks with notifications and hears the answer as a notification, so the stdout reader
//! of the sidecar (sidecar.rs) is never blocked by a download:
//!   `updater.check|download|install` { id }  ->  `updater.result` { id, ok, result | error }
//!                                               `updater.progress` { id, received, total }
//! One operation at a time (the core serializes; this refuses a second one as well).
//!
//! Only a provisioned build updates: the plugin is registered, and `status` says "install", when the
//! configuration has a public key and https endpoints (`configured`), exactly as Gustaf's updater.rs.
//! The key and the endpoint are put into the build (TAURI_CONFIG, scripts/updater-config.js); the
//! committed tauri.conf.json has none, so a build without them is disabled.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
#[cfg(windows)]
use tauri::Manager;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Set at COMPILE time by scripts/updater-smoke-tauri.js only (`CAPRI_LOCAL_UPDATER_TEST=1`): with it, and
/// `dangerousInsecureTransportProtocol: true` in the embedded updater configuration, a plain-http
/// feed on 127.0.0.1 counts as configured. Any other build accepts https only.
const LOCAL_TEST: bool = is_one(option_env!("CAPRI_LOCAL_UPDATER_TEST"));

const fn is_one(v: Option<&str>) -> bool {
    match v {
        Some(s) => s.len() == 1 && s.as_bytes()[0] == b'1',
        None => false,
    }
}

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

fn loopback_http(url: &str) -> bool {
    tauri::Url::parse(url).ok().is_some_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1") && u.username().is_empty() && u.password().is_none())
}

fn configured_with(plugins: &HashMap<String, Value>, local_test: bool) -> bool {
    let Some(config) = plugins.get("updater") else {
        return false;
    };
    let key = config.get("pubkey").and_then(Value::as_str).unwrap_or("");
    let insecure_ok = local_test && config.get("dangerousInsecureTransportProtocol").and_then(Value::as_bool) == Some(true);
    let endpoints = config.get("endpoints").and_then(Value::as_array);
    !key.trim().is_empty()
        && endpoints.is_some_and(|xs| {
            !xs.is_empty() && xs.iter().all(|v| v.as_str().is_some_and(|url| (url.starts_with("https://") && url.len() > 8) || (insecure_ok && loopback_http(url))))
        })
}

/// A public key and https endpoints (or, in a local test build, a loopback one) are in the configuration.
pub fn configured(plugins: &HashMap<String, Value>) -> bool {
    configured_with(plugins, LOCAL_TEST)
}

/// What this installation does about updates: `install` (check, download, install), `notify` (a
/// Linux package: the version is shown, the package manager installs), or `disabled` with a reason
/// the core's texts know (`dev`, `feed`).
pub fn decide(configured: bool, bundled: bool, linux: bool, appimage: bool) -> (&'static str, Option<&'static str>) {
    if !bundled {
        return ("disabled", Some("dev"));
    }
    if !configured {
        return ("disabled", Some("feed"));
    }
    if linux && !appimage {
        return ("notify", None);
    }
    ("install", None)
}

/// Run from an installed bundle: the .app on macOS; an AppImage, a package or an installer elsewhere.
fn bundled() -> bool {
    if cfg!(target_os = "macos") {
        return std::env::current_exe().ok().is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"));
    }
    tauri::utils::platform::bundle_type().is_some()
}

fn appimage() -> bool {
    cfg!(target_os = "linux") && tauri::utils::platform::bundle_type() == Some(tauri::utils::config::BundleType::AppImage)
}

/// The `updater` part of the sidecar's `hello`: what the core builds its controller from.
pub fn status(app: &AppHandle) -> Value {
    let ok = configured(&app.config().plugins.0);
    let (mode, reason) = decide(ok, bundled(), cfg!(target_os = "linux"), appimage());
    let test = LOCAL_TEST && ok && mode != "disabled";
    json!({ "mode": mode, "reason": reason, "test": test })
}

/// Registers the plugin when (and only when) the build is provisioned.
pub fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if configured(&app.config().plugins.0) {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    }
    Ok(())
}

// --- Errors -------------------------------------------------------------------------------------

/// What went wrong, in the core's words: a `signature` failure blocks installation, a `network` one is
/// retried, anything else is `other` (reason `feed`: nothing published for this system).
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub category: &'static str,
    pub reason: Option<&'static str>,
    pub message: String,
}

pub fn classify(err: &tauri_plugin_updater::Error) -> Failure {
    use tauri_plugin_updater::Error as E;
    let message = redact(&err.to_string());
    let (category, reason) = match err {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => ("signature", None),
        E::Network(_) | E::Reqwest(_) | E::ReleaseNotFound => ("network", None),
        E::TargetNotFound(_) | E::TargetsNotFound(_) | E::UnsupportedArch | E::UnsupportedOs => ("other", Some("feed")),
        E::Io(_) | E::TempDirNotOnSameMountPoint | E::TempDirNotFound | E::FailedToDetermineExtractPath => ("other", Some("location")),
        _ => ("other", None),
    };
    Failure { category, reason, message }
}

/// Messages go to the window and the logs: no query strings (a signed download URL has one), one line.
fn redact(text: &str) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(if word.starts_with("http") { word.split(['?', '#']).next().unwrap_or(word) } else { word });
    }
    out.chars().take(300).collect()
}

fn plain(message: impl Into<String>) -> Failure {
    Failure { category: "other", reason: None, message: message.into() }
}

fn failure_json(f: &Failure) -> Value {
    json!({ "category": f.category, "reason": f.reason, "message": f.message })
}

// --- Operations ---------------------------------------------------------------------------------

pub type Notify = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct Held {
    update: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
struct Runtime {
    busy: AtomicBool,
    held: Mutex<Option<Held>>,
}

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(Runtime::default)
}

struct BusyGuard;
impl BusyGuard {
    fn take() -> Option<BusyGuard> {
        runtime().busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| BusyGuard)
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        runtime().busy.store(false, Ordering::SeqCst);
    }
}

/// Takes `updater.check|download|install` from the sidecar; false for any other method.
pub fn handle(app: &AppHandle, method: &str, params: &Value, notify: Notify) -> bool {
    let op = match method {
        "updater.check" | "updater.download" | "updater.install" => method.trim_start_matches("updater.").to_string(),
        _ => return false,
    };
    let (app, id) = (app.clone(), params["id"].clone());
    tauri::async_runtime::spawn(async move {
        let answer = match run(&app, &op, &id, &notify).await {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(f) => json!({ "id": id, "ok": false, "error": failure_json(&f) }),
        };
        notify("updater.result", answer);
    });
    true
}

async fn run(app: &AppHandle, op: &str, id: &Value, notify: &Notify) -> Result<Value, Failure> {
    let (mode, reason) = decide(configured(&app.config().plugins.0), bundled(), cfg!(target_os = "linux"), appimage());
    if mode == "disabled" {
        return Err(plain(format!("updates are off in this installation ({})", reason.unwrap_or("?"))));
    }
    let _guard = BusyGuard::take().ok_or_else(|| plain("another update operation is running"))?;
    match op {
        "check" => check(app).await,
        "download" if mode == "install" => download(id, notify).await,
        "install" if mode == "install" => install(app),
        _ => Err(plain(format!("{op}: this installation only tells that an update exists (its package manager installs it)"))),
    }
}

async fn check(app: &AppHandle) -> Result<Value, Failure> {
    *runtime().held.lock().unwrap() = None; // what an earlier check found is let go
    let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(|e| classify(&e))?;
    match updater.check().await.map_err(|e| classify(&e))? {
        None => Ok(Value::Null),
        Some(update) => {
            let offer = json!({
                "version": update.version,
                "notes": update.body.clone().unwrap_or_default(),
                "date": update.date.map(|d| d.to_string()),
            });
            *runtime().held.lock().unwrap() = Some(Held { update, bytes: None });
            Ok(offer)
        }
    }
}

async fn download(id: &Value, notify: &Notify) -> Result<Value, Failure> {
    let update = runtime().held.lock().unwrap().as_ref().map(|h| h.update.clone()).ok_or_else(|| plain("nothing to download: check for updates first"))?;
    let (mut received, mut last) = (0u64, Instant::now() - Duration::from_secs(1));
    let progress = |chunk: usize, total: Option<u64>| {
        received += chunk as u64;
        if last.elapsed() >= Duration::from_millis(100) || total == Some(received) {
            last = Instant::now();
            notify("updater.progress", json!({ "id": id, "received": received, "total": total.unwrap_or(0) }));
        }
    };
    // download() verifies the minisign signature against the embedded public key before it returns
    let bytes = update.download(progress, || {}).await.map_err(|e| classify(&e))?;
    if let Some(held) = runtime().held.lock().unwrap().as_mut() {
        held.bytes = Some(bytes);
    }
    Ok(json!({ "version": update.version }))
}

fn install(app: &AppHandle) -> Result<Value, Failure> {
    let (update, bytes) = {
        let held = runtime().held.lock().unwrap();
        let h = held.as_ref().ok_or_else(|| plain("nothing to install: check for updates first"))?;
        (h.update.clone(), h.bytes.clone().ok_or_else(|| plain("nothing to install: the download is not verified yet"))?)
    };
    // Windows: the installer replaces files and exits this process; the sidecar (a file of the
    // install) must not be running then. If the install fails, the app starts again.
    #[cfg(windows)]
    if let Some(s) = app.try_state::<crate::sidecar::Sidecar>() {
        s.shutdown(Duration::from_secs(2));
    }
    match update.install(bytes) {
        Ok(()) => Ok(json!({ "version": update.version })), // macOS, Linux: the core relaunches
        Err(e) => {
            #[cfg(windows)]
            app.restart();
            #[cfg(not(windows))]
            let _ = app;
            Err(classify(&e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error;

    fn plugins(v: Value) -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("updater".into(), v);
        m
    }

    #[test]
    fn only_signed_https_configuration_enables_updates() {
        assert!(!configured_with(&HashMap::new(), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "", "endpoints": ["https://updates.example.test"]})), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "  ", "endpoints": ["https://updates.example.test"]})), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "k", "endpoints": []})), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "k"})), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "k", "endpoints": ["http://insecure.example.test"]})), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "k", "endpoints": ["https://ok.test/a", "http://insecure.example.test"]})), false));
        assert!(!configured_with(&plugins(json!({"pubkey": "k", "endpoints": ["https://"]})), false));
        assert!(configured_with(&plugins(json!({"pubkey": "k", "endpoints": ["https://github.com/Libes6/capri-desktop/releases/latest/download/latest.json"]})), false));
    }

    #[test]
    fn plain_http_needs_the_local_test_build_the_flag_and_loopback() {
        let loop_cfg = |flag: Value, url: &str| plugins(json!({"pubkey": "k", "endpoints": [url], "dangerousInsecureTransportProtocol": flag}));
        // an ordinary build: never, whatever the config says
        assert!(!configured_with(&loop_cfg(json!(true), "http://127.0.0.1:47833/latest.json"), false));
        // a local test build still wants the config flag, and loopback, and no credentials
        assert!(configured_with(&loop_cfg(json!(true), "http://127.0.0.1:47833/latest.json"), true));
        assert!(!configured_with(&loop_cfg(json!(false), "http://127.0.0.1:47833/latest.json"), true));
        assert!(!configured_with(&loop_cfg(json!(null), "http://127.0.0.1:47833/latest.json"), true));
        assert!(!configured_with(&loop_cfg(json!(true), "http://evil.example.test/latest.json"), true));
        assert!(!configured_with(&loop_cfg(json!(true), "http://user:pw@127.0.0.1:1/x"), true));
        assert!(!configured_with(&loop_cfg(json!(true), "http://127.0.0.1.evil.test/x"), true));
        assert!(!LOCAL_TEST, "the unit tests are not built as a local updater test");
    }

    #[test]
    fn the_mode_follows_provisioning_the_bundle_and_the_linux_package() {
        assert_eq!(decide(true, false, false, false), ("disabled", Some("dev")));
        assert_eq!(decide(false, true, false, false), ("disabled", Some("feed")));
        assert_eq!(decide(true, true, false, false), ("install", None)); // macOS, Windows
        assert_eq!(decide(true, true, true, true), ("install", None)); // AppImage
        assert_eq!(decide(true, true, true, false), ("notify", None)); // deb
        assert_eq!(decide(false, true, true, false), ("disabled", Some("feed")));
    }

    #[test]
    fn errors_are_told_apart_for_the_core() {
        assert_eq!(classify(&Error::Network("Download request failed with status: 503".into())).category, "network");
        assert_eq!(classify(&Error::ReleaseNotFound).category, "network");
        assert_eq!(classify(&Error::SignatureUtf8("x".into())).category, "signature");
        let none = classify(&Error::TargetNotFound("linux-x86_64".into()));
        assert_eq!((none.category, none.reason), ("other", Some("feed")));
        assert_eq!(classify(&Error::EmptyEndpoints).category, "other");
    }

    #[test]
    fn messages_lose_query_strings_and_stay_short() {
        let f = classify(&Error::Network("GET https://objects.example/x.tar.gz?X-Amz-Signature=secret failed".into()));
        assert!(!f.message.contains("secret"), "{}", f.message);
        assert!(f.message.contains("https://objects.example/x.tar.gz"));
        assert!(redact(&"a ".repeat(500)).chars().count() <= 300);
    }

    #[test]
    fn a_second_operation_is_refused_while_one_runs() {
        let first = BusyGuard::take().expect("free");
        assert!(BusyGuard::take().is_none());
        drop(first);
        assert!(BusyGuard::take().is_some());
    }

    #[test]
    fn the_feed_the_release_script_writes_is_one_the_plugin_reads() {
        // shape of scripts/release-manifest.js output (tests/release-manifest.test.js checks the script)
        let feed = json!({
            "version": "0.2.0", "notes": "n", "pub_date": "2026-10-28T10:00:00Z",
            "platforms": { "darwin-aarch64": { "signature": "c2ln", "url": "https://github.com/Libes6/capri-desktop/releases/download/fork-v0.2.0/Capri-0.2.0-macOS-arm64.app.tar.gz" } }
        });
        let release: tauri_plugin_updater::RemoteRelease = serde_json::from_value(feed).expect("parsed");
        assert_eq!(release.version.to_string(), "0.2.0");
        assert_eq!(release.signature("darwin-aarch64").unwrap(), "c2ln");
        assert!(release.download_url("darwin-aarch64").unwrap().as_str().ends_with("Capri-0.2.0-macOS-arm64.app.tar.gz"));
        assert!(release.download_url("linux-x86_64").is_err());
    }
}
