//! `capri://usersounds/<file>`: the sounds the user put in `<userData>/sounds` (the core hands these
//! URLs to her page, src/main/core.js `sounds:list`). The page files themselves come from Tauri's
//! own protocol; this scheme serves nothing else. Windows would see it as http://capri.localhost:
//! the core's URLs need a platform-made base there (TAURI-07).

use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The file a request path names inside `dir`, or None: a path with a separator, `..` or a dot-file.
pub fn resolve(dir: &Path, path: &str) -> Option<PathBuf> {
    let name = percent_decode(path.trim_start_matches('/'))?;
    if name.is_empty() || name.contains(['/', '\\', '\0']) || name.starts_with('.') || name.contains("..") {
        return None;
    }
    Some(dir.join(name))
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

/// `Range: bytes=a-b` -> (start, end inclusive), clamped to `len`.
fn range(header_value: &str, len: usize) -> Option<(usize, usize)> {
    let spec = header_value.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: usize = if a.is_empty() { len.checked_sub(b.parse::<usize>().ok()?)? } else { a.parse().ok()? };
    let end: usize = if a.is_empty() || b.is_empty() { len.checked_sub(1)? } else { b.parse().ok()? };
    (start <= end && start < len).then(|| (start, end.min(len - 1)))
}

pub fn serve_user_sounds(user_data: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    if uri.host() != Some("usersounds") {
        return status(StatusCode::NOT_FOUND);
    }
    let Some(file) = resolve(&user_data.join("sounds"), uri.path()) else { return status(StatusCode::FORBIDDEN) };
    let Ok(bytes) = std::fs::read(&file) else { return status(StatusCode::NOT_FOUND) };
    let base = Response::builder().header(header::CONTENT_TYPE, mime(&file)).header(header::ACCEPT_RANGES, "bytes").header("Access-Control-Allow-Origin", "*");
    match request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| range(v, bytes.len())) {
        Some((a, b)) => base
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {a}-{b}/{}", bytes.len()))
            .body(bytes[a..=b].to_vec())
            .unwrap(),
        None => base.status(StatusCode::OK).body(bytes).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_file_names_inside_the_folder() {
        let dir = Path::new("/data/sounds");
        assert_eq!(resolve(dir, "/hit%20me.mp3"), Some(dir.join("hit me.mp3")));
        for bad in ["/../config.json", "/%2e%2e/x", "/a/b.mp3", "/a%2Fb.mp3", "/..%5Cx", "/.hidden", "/", "/%zz"] {
            assert_eq!(resolve(dir, bad), None, "{bad}");
        }
    }

    #[test]
    fn ranges() {
        assert_eq!(range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(range("bytes=100-", 100), None);
        assert_eq!(range("items=1-2", 100), None);
    }

    #[test]
    fn serves_a_sound_and_refuses_the_rest() {
        let dir = std::env::temp_dir().join(format!("capri-assets-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sounds")).unwrap();
        std::fs::write(dir.join("sounds/a.mp3"), b"0123456789").unwrap();
        std::fs::write(dir.join("secret.txt"), b"no").unwrap();
        let get = |url: &str, range: Option<&str>| {
            let mut b = Request::builder().uri(url);
            if let Some(r) = range { b = b.header("range", r); }
            serve_user_sounds(&dir, &b.body(Vec::new()).unwrap())
        };
        let ok = get("capri://usersounds/a.mp3", None);
        assert_eq!((ok.status(), ok.body().len()), (StatusCode::OK, 10));
        assert_eq!(ok.headers()["content-type"], "audio/mpeg");
        let part = get("capri://usersounds/a.mp3", Some("bytes=2-4"));
        assert_eq!((part.status(), part.body().as_slice()), (StatusCode::PARTIAL_CONTENT, &b"234"[..]));
        assert_eq!(get("capri://usersounds/..%2Fsecret.txt", None).status(), StatusCode::FORBIDDEN);
        assert_eq!(get("capri://usersounds/missing.mp3", None).status(), StatusCode::NOT_FOUND);
        assert_eq!(get("capri://elsewhere/a.mp3", None).status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
