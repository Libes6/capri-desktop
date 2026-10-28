//! Links, files and folders (TAURI-07): platform.shell.openExternal / openPath / showItemInFolder, and
//! platform.app.appForProtocol. Done with the `open` crate (macOS `open`, ShellExecute, xdg-open).
//!
//! Which links open. Electron's shell.openExternal opens anything and leaves the choice to its callers;
//! here the shell itself keeps a list of the schemes the core ever sends (src/main/launch.js, core.js):
//! http and https, and the launchers' own (steam, com.epicgames.launcher, spotify, roblox), and
//! `trash:///` (the Linux Trash folder). Anything else (file:, javascript:, data:, ms-*:, a custom
//! scheme) is refused, so a compromised core or a crafted name cannot start an arbitrary handler.

use std::path::Path;

pub const SCHEMES: &[&str] = &["http", "https", "steam", "com.epicgames.launcher", "spotify", "roblox"];
const MAX_URL: usize = 8192;

/// The lower-case scheme of `url` (RFC 3986: a letter, then letters, digits, + - .), or None.
pub fn scheme_of(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once(':')?;
    let mut chars = scheme.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))).then(|| scheme.to_ascii_lowercase())
}

/// The link to open, or why not.
pub fn check_external(url: &str) -> Result<&str, String> {
    if url.is_empty() || url.len() > MAX_URL {
        return Err("not a link to open".into());
    }
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("a link has no spaces or control characters".into());
    }
    let scheme = scheme_of(url).ok_or("not a link")?;
    let rest = &url[scheme.len() + 1..];
    match scheme.as_str() {
        "http" | "https" => {
            let host = rest.strip_prefix("//").ok_or("a web link needs //")?;
            let authority = host.split(['/', '?', '#']).next().unwrap_or("");
            if authority.is_empty() || authority.starts_with('@') || authority.contains('\\') {
                return Err("a web link needs a host".into());
            }
        }
        s if SCHEMES.contains(&s) => {}
        "trash" if rest == "///" => {}
        other => return Err(format!("links of the kind {other}: are not opened")),
    }
    Ok(url)
}

pub fn open_external(url: &str) -> Result<(), String> {
    let url = check_external(url)?;
    open::that_detached(url).map_err(|e| format!("could not open the link: {e}"))
}

/// A path to hand to the system: absolute, no NUL, and there.
pub fn check_path(path: &str) -> Result<&Path, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("not a path".into());
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("the path is not absolute".into());
    }
    std::fs::symlink_metadata(p).map_err(|_| "the path does not exist".to_string())?;
    Ok(p)
}

/// Electron's shell.openPath: "" when it opened, else the reason.
pub fn open_path(path: &str) -> String {
    match check_path(path).and_then(|p| open::that_detached(p).map_err(|e| e.to_string())) {
        Ok(()) => String::new(),
        Err(e) => e,
    }
}

/// The command that shows `path` selected in the file manager: (program, arguments).
pub fn reveal_command(os: &str, path: &str) -> (String, Vec<String>) {
    match os {
        "macos" => ("open".into(), vec!["-R".into(), path.into()]),
        "windows" => ("explorer.exe".into(), vec![format!("/select,{path}")]),
        _ => (
            "dbus-send".into(),
            vec![
                "--session".into(), "--print-reply".into(), "--dest=org.freedesktop.FileManager1".into(), "/org/freedesktop/FileManager1".into(),
                "org.freedesktop.FileManager1.ShowItems".into(), format!("array:string:file://{}", percent_encode(path)), "string:".into(),
            ],
        ),
    }
}

fn percent_encode(path: &str) -> String {
    path.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub fn show_item_in_folder(path: &str) -> Result<(), String> {
    let p = check_path(path)?;
    let (program, args) = reveal_command(std::env::consts::OS, path);
    let mut command = std::process::Command::new(program);
    command.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        // no file manager service on Linux: the folder itself
        Err(_) if cfg!(all(unix, not(target_os = "macos"))) => open::that_detached(p.parent().unwrap_or(p)).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Is any application registered for this link ("roblox://", "steam:")? false for what is not a scheme.
pub fn app_for_protocol(url: &str) -> bool {
    match scheme_of(url) {
        Some(s) => imp::registered(&s),
        None => false,
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    pub fn registered(scheme: &str) -> bool {
        let url = NSURL::URLWithString(&NSString::from_str(&format!("{scheme}://")));
        match url {
            Some(url) => NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&url).is_some(),
            None => false,
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};

    pub fn registered(scheme: &str) -> bool {
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: valid NUL-terminated UTF-16 strings and out pointers
        unsafe {
            if RegOpenKeyExW(HKEY_CLASSES_ROOT, wide(scheme).as_ptr(), 0, KEY_READ, &mut key) != 0 {
                return false;
            }
            let found = RegQueryValueExW(key, wide("URL Protocol").as_ptr(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) == 0;
            RegCloseKey(key);
            found
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    pub fn registered(scheme: &str) -> bool {
        std::process::Command::new("xdg-mime")
            .args(["query", "default", &format!("x-scheme-handler/{scheme}")])
            .output()
            .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_links_the_core_sends_pass() {
        for url in [
            "https://www.google.com/search?q=a%20b",
            "http://localhost:3000/x",
            "https://open.spotify.com/search/x",
            "spotify:search:daft%20punk",
            "steam://rungameid/730",
            "com.epicgames.launcher://apps/Fortnite?action=launch&silent=true",
            "roblox://experiences/start?placeId=1",
            "trash:///",
            "HTTPS://Example.com",
        ] {
            assert!(check_external(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn other_schemes_and_odd_links_are_refused() {
        for url in [
            "file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x", "vbscript:x", "ms-msdt:/id", "x-apple.systempreferences:", "capri://app/x",
            "tel:123", "mailto:a@b.c", "trash:///x", "https:", "https://", "https:///x", "http:example.com", "https://@host", "ftp://x", "//example.com", "-a Calculator",
            "https://example.com/a b", "https://example.com/\nfoo", "", "no scheme", "1http://x", "https://\\\\host",
        ] {
            assert!(check_external(url).is_err(), "{url:?}");
        }
        assert!(check_external(&format!("https://a/{}", "x".repeat(9000))).is_err());
    }

    #[test]
    fn schemes_are_read_like_rfc_3986() {
        assert_eq!(scheme_of("Roblox://x").as_deref(), Some("roblox"));
        assert_eq!(scheme_of("com.epicgames.launcher://a").as_deref(), Some("com.epicgames.launcher"));
        assert_eq!(scheme_of("a b://x"), None);
        assert_eq!(scheme_of("://x"), None);
        assert_eq!(scheme_of("nocolon"), None);
    }

    #[test]
    fn paths_must_be_absolute_and_there() {
        assert!(check_path("relative/file").is_err());
        assert!(check_path("").is_err());
        assert!(check_path("/definitely/not/here/capri-7f3a").is_err());
        assert!(check_path("/tmp/x\0y").is_err());
        let dir = std::env::temp_dir();
        assert!(check_path(dir.to_str().unwrap()).is_ok());
        assert_eq!(open_path("relative/file"), "the path is not absolute");
        assert!(!open_path("/definitely/not/here/capri-7f3a").is_empty());
    }

    #[test]
    fn reveal_commands() {
        assert_eq!(reveal_command("macos", "/a/b c.txt"), ("open".to_string(), vec!["-R".to_string(), "/a/b c.txt".to_string()]));
        assert_eq!(reveal_command("windows", r"C:\a b\c.txt").1, vec![r"/select,C:\a b\c.txt".to_string()]);
        let linux = reveal_command("linux", "/a/b c.txt");
        assert!(linux.1.contains(&"array:string:file:///a/b%20c.txt".to_string()), "{linux:?}");
    }

    #[test]
    fn protocol_lookup_is_safe_with_nonsense() {
        assert!(!app_for_protocol("not a url"));
        assert!(!app_for_protocol("capri-nonexistent-scheme-7f3a://"));
        #[cfg(target_os = "macos")]
        assert!(app_for_protocol("https://"), "a browser handles https");
    }
}
