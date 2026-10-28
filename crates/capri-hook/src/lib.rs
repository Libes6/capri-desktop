//! capri-hook: reads an assistant hook event on stdin and forwards it to Capri's local bridge.
//! Behaviour mirrors hooks/capri-hook.js, capri-codex-hook.js and capri-agy-hook.js.
//! Rule #1: never get in the assistant's way. Always exit 0, give up fast.

pub mod agy;
pub mod http;
pub mod js;
pub mod slim;

use serde_json::Value;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Assistant {
    Claude,
    Codex,
    Agy,
}

#[derive(Debug, PartialEq)]
pub struct Cli {
    pub assistant: Assistant,
    pub hook_type: String,
}

/// `--assistant claude|codex|agy [HookType]` or `claude|codex|agy [HookType]`.
/// The hook type is only used by Antigravity (default PreToolUse, like the JS hook).
pub fn parse_args(args: &[String]) -> Cli {
    let mut assistant = None;
    let mut rest = Vec::new();
    let mut i = 0;
    let pick = |s: &str| match s {
        "claude" => Some(Assistant::Claude),
        "codex" => Some(Assistant::Codex),
        "agy" => Some(Assistant::Agy),
        _ => None,
    };
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--assistant" {
            assistant = args.get(i + 1).and_then(|v| pick(v)).or(assistant);
            i += 1;
        } else if let Some(v) = a.strip_prefix("--assistant=") {
            assistant = pick(v).or(assistant);
        } else if assistant.is_none() && rest.is_empty() && pick(a).is_some() {
            assistant = pick(a);
        } else if !a.starts_with("--") {
            rest.push(a.to_string());
        }
        i += 1;
    }
    Cli {
        assistant: assistant.unwrap_or(Assistant::Claude),
        hook_type: rest.into_iter().next().filter(|s| !s.is_empty()).unwrap_or_else(|| "PreToolUse".into()),
    }
}

const STDIN_CAP_UNITS: usize = 8 * 1024 * 1024;
const TOTAL_CLAUDE: Duration = Duration::from_millis(2000);
const TOTAL_AGY: Duration = Duration::from_millis(2200);

fn read_stdin(limit: Duration) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 65536];
        let mut stdin = std::io::stdin().lock();
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > 32 * 1024 * 1024 {
                        let _ = tx.send(None);
                        return;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let _ = tx.send((js::utf16_len(&text) <= STDIN_CAP_UNITS).then_some(text));
    });
    rx.recv_timeout(limit).ok().flatten()
}

/// Runs the hook; returns what to print on stdout. The process always exits 0.
pub fn run(cli: &Cli, port: u16, started: Instant, read: impl FnOnce(Duration) -> Option<String>) -> String {
    match cli.assistant {
        Assistant::Claude | Assistant::Codex => {
            let deadline = started + TOTAL_CLAUDE;
            let Some(raw) = read(deadline.saturating_duration_since(Instant::now())) else { return String::new() };
            let Ok(evt) = serde_json::from_str::<Value>(&raw) else { return String::new() };
            let adapted = if cli.assistant == Assistant::Codex { slim::adapt_codex(evt) } else { slim::adapt_claude(evt) };
            let Some(evt) = adapted else { return String::new() };
            let body = js::to_body(slim::slim(&evt));
            http::post_event(port, &body, Duration::from_millis(800), deadline);
            String::new()
        }
        Assistant::Agy => {
            let deadline = started + TOTAL_AGY;
            let answer = agy::response(&cli.hook_type).to_string();
            let Some(raw) = read(deadline.saturating_duration_since(Instant::now())) else { return answer };
            let payload = if js::trim(&raw).is_empty() {
                Value::Object(Default::default())
            } else {
                match serde_json::from_str::<Value>(&raw) {
                    Ok(v) => v,
                    Err(_) => return answer,
                }
            };
            if payload.is_null() {
                return answer; // the JS hook crashes here (exit 1); we stay quiet and exit 0
            }
            let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            for item in agy::build_events(&cli.hook_type, &payload, &cwd) {
                if item.delay_ms > 0 {
                    let left = deadline.saturating_duration_since(Instant::now());
                    std::thread::sleep(Duration::from_millis(item.delay_ms).min(left));
                }
                if Instant::now() >= deadline {
                    break;
                }
                http::post_event(port, &js::to_body(item.evt), Duration::from_millis(600), deadline);
            }
            answer
        }
    }
}

/// Process entry point: never panics outward, never exits non-zero.
pub fn main_entry() -> ! {
    let started = Instant::now();
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = parse_args(&args);
    let port = http::port_from(std::env::var("CAPRI_PORT").ok().as_deref());
    let out = std::panic::catch_unwind(|| run(&cli, port, started, read_stdin))
        .unwrap_or_else(|_| if cli.assistant == Assistant::Agy { agy::response(&cli.hook_type).into() } else { String::new() });
    let mut so = std::io::stdout();
    let _ = so.write_all(out.as_bytes());
    let _ = so.flush();
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn args_flags_and_positionals() {
        assert_eq!(parse_args(&a(&[])), Cli { assistant: Assistant::Claude, hook_type: "PreToolUse".into() });
        assert_eq!(parse_args(&a(&["--assistant", "codex"])).assistant, Assistant::Codex);
        assert_eq!(parse_args(&a(&["--assistant=agy", "Stop"])), Cli { assistant: Assistant::Agy, hook_type: "Stop".into() });
        assert_eq!(parse_args(&a(&["agy", "SessionStart"])).hook_type, "SessionStart");
        assert_eq!(parse_args(&a(&["--assistant", "agy", "PostToolUse"])).hook_type, "PostToolUse");
    }

    #[test]
    fn garbage_input_prints_nothing_for_claude_and_json_for_agy() {
        let cli = Cli { assistant: Assistant::Codex, hook_type: "x".into() };
        assert_eq!(run(&cli, 1, Instant::now(), |_| Some("invalid".into())), "");
        assert_eq!(run(&cli, 1, Instant::now(), |_| Some("null".into())), "");
        assert_eq!(run(&cli, 1, Instant::now(), |_| Some("[]".into())), "");
        let agy = Cli { assistant: Assistant::Agy, hook_type: "Stop".into() };
        assert_eq!(run(&agy, 1, Instant::now(), |_| Some("invalid".into())), "{\"decision\":\"stop\"}\n");
        assert_eq!(run(&agy, 1, Instant::now(), |_| None), "{\"decision\":\"stop\"}\n");
    }
}
