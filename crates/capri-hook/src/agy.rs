//! hooks/capri-agy-hook.js: Antigravity payload -> a list of (delay, event).

use crate::js::{clip, get, get_opt, is_js_ws, or, slice16, string, truthy, utf16_len};
use crate::slim::REPLY_MAX;
use serde_json::{json, Map, Value};
use std::path::Path;

pub struct Planned {
    pub delay_ms: u64,
    pub evt: Map<String, Value>,
}

/// What the hook prints for Antigravity. "allow" only means "do not block".
pub fn response(hook_type: &str) -> &'static str {
    match hook_type {
        "PreToolUse" => "{\"decision\":\"allow\"}\n",
        "Stop" => "{\"decision\":\"stop\"}\n",
        _ => "{}\n",
    }
}

/// `String(v || "").slice(0, 280)`
fn s280(v: Option<&Value>) -> String {
    if truthy(v) { slice16(&string(v), 280) } else { String::new() }
}

pub fn clean_user_prompt(text: Option<&Value>) -> String {
    if !truthy(text) {
        return String::new();
    }
    let t = string(text);
    let lower = t.to_ascii_lowercase(); // ASCII-only lowering keeps byte offsets identical
    let raw = match lower.find("<user_request>") {
        Some(start) => {
            let from = start + "<user_request>".len();
            match lower[from..].find("</user_request>") {
                Some(end) => &t[from..from + end],
                None => &t[..],
            }
        }
        None => &t[..],
    };
    let mut out = String::new();
    let mut in_ws = false;
    for c in raw.chars() {
        if is_js_ws(c) {
            in_ws = true;
        } else {
            if in_ws && !out.is_empty() {
                out.push(' ');
            }
            in_ws = false;
            out.push(c);
        }
    }
    slice16(&out, 280)
}

pub fn last_assistant_message(transcript: Option<&Value>) -> String {
    let Some(Value::String(path)) = transcript else { return String::new() };
    if path.is_empty() || !Path::new(path).exists() {
        return String::new();
    }
    let Ok(bytes) = std::fs::read(path) else { return String::new() };
    let content = String::from_utf8_lossy(&bytes);
    let content = crate::js::trim(&content);
    for line in content.split('\n').rev() {
        let Ok(step) = serde_json::from_str::<Value>(line) else { continue };
        if get(&step, "type").and_then(Value::as_str) == Some("PLANNER_RESPONSE") {
            let c = get(&step, "content");
            if truthy(c) {
                let text = string(c);
                let reply = crate::js::trim(&text);
                if !reply.is_empty() {
                    return clip(reply, REPLY_MAX);
                }
            }
        }
    }
    String::new()
}

/// Lexical `path.resolve`; `None` for a non-string argument (Node throws).
fn resolve(p: &str, cwd: &str) -> String {
    let win = cfg!(windows);
    let norm = |s: &str| if win { s.replace('\\', "/") } else { s.to_string() };
    let (p, cwd) = (norm(p), norm(cwd));
    let is_abs = |s: &str| s.starts_with('/') || (win && s.as_bytes().get(1) == Some(&b':') && s.as_bytes().get(2) == Some(&b'/'));
    let full = if is_abs(&p) {
        p
    } else if p.is_empty() {
        cwd
    } else {
        format!("{cwd}/{p}")
    };
    let (prefix, rest) = if win && full.as_bytes().get(1) == Some(&b':') { full.split_at(2) } else { ("", full.as_str()) };
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let joined = format!("{prefix}/{}", parts.join("/"));
    if win { joined.replace('/', "\\") } else { joined }
}

fn is_outside_workspace(file: &Value, workspaces: Option<&Value>, cwd: &str) -> bool {
    let Some(Value::Array(ws)) = workspaces else { return false };
    if !truthy(Some(file)) || ws.is_empty() {
        return false;
    }
    let Value::String(f) = file else { return false };
    let resolved = resolve(f, cwd).to_lowercase();
    for w in ws {
        let Value::String(w) = w else { return false };
        if resolved.starts_with(&resolve(w, cwd).to_lowercase()) {
            return false;
        }
    }
    true
}

fn map_tool(tool_call: Option<&Value>) -> (Value, Value) {
    let name_v = get_opt(tool_call, "name");
    let name_v = if truthy(name_v) { name_v } else { None };
    let name = name_v.and_then(Value::as_str).unwrap_or("");
    let empty = json!({});
    let args = {
        let a = get_opt(tool_call, "args");
        if truthy(a) { a.unwrap() } else { &empty }
    };
    let a = |k: &str| get(args, k);
    let or_empty = |list: &[Option<&Value>]| -> Value {
        match or(list) {
            Some(v) if truthy(Some(v)) => v.clone(),
            _ => Value::String(String::new()),
        }
    };
    let len16 = |v: Option<&Value>| match v {
        Some(Value::String(s)) => utf16_len(s),
        _ => 0,
    };
    match name {
        "read_file" | "view_file" | "view_file_outline" | "view_code_item" => (
            "Read".into(),
            json!({"file_path": or_empty(&[a("Path"), a("AbsolutePath"), a("File")])}),
        ),
        "write_file" | "write_to_file" => (
            "Write".into(),
            json!({"file_path": or_empty(&[a("Path"), a("TargetFile")]), "content_len": len16(a("Content"))}),
        ),
        "edit_file" | "replace_file_content" | "multi_replace_file_content" => (
            "Edit".into(),
            json!({"file_path": or_empty(&[a("Path"), a("TargetFile")]),
                   "old_string_len": len16(a("Target")), "new_string_len": len16(a("Replacement"))}),
        ),
        "run_command" => (
            "PowerShell".into(),
            json!({"command": s280(a("CommandLine")),
                   "description": s280(or(&[a("toolSummary"), a("CommandLine")]))}),
        ),
        "grep_search" => ("Grep".into(), json!({"pattern": s280(a("Query"))})),
        "find_by_name" | "list_dir" => {
            let star = Value::String("*".into());
            ("Glob".into(), json!({"pattern": s280(or(&[a("Pattern"), a("DirectoryPath"), Some(&star)]))}))
        }
        "search_web" => ("WebSearch".into(), json!({"query": s280(a("query"))})),
        "read_url_content" => ("WebFetch".into(), json!({"url": s280(a("Url"))})),
        "invoke_subagent" => {
            let sub = Value::String("subagent".into());
            let agent = Value::String("agent".into());
            (
                "Agent".into(),
                json!({"description": s280(or(&[a("Role"), a("TypeName"), Some(&sub)])),
                       "subagent_type": slice16(&string(if truthy(a("TypeName")) { a("TypeName") } else { Some(&agent) }), 100)}),
            )
        }
        "ask_question" => {
            let q = match a("questions") {
                Some(Value::Array(v)) => v.first().and_then(|f| get(f, "question")),
                _ => None,
            };
            ("AskUserQuestion".into(), json!({"question": s280(q)}))
        }
        _ => (
            name_v.cloned().unwrap_or_else(|| "Tool".into()),
            json!({}),
        ),
    }
}

fn evt(base: &Map<String, Value>, fields: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut m = base.clone();
    for (k, v) in fields {
        m.insert(k.to_string(), v);
    }
    m
}

fn merge(mut m: Map<String, Value>, tool: (Value, Value)) -> Map<String, Value> {
    m.insert("tool_name".into(), tool.0);
    m.insert("tool_input".into(), tool.1);
    m
}

fn plan(delay_ms: u64, evt: Map<String, Value>) -> Planned {
    Planned { delay_ms, evt }
}

fn str_of(v: &Value, k: &str) -> Value {
    get(v, k).cloned().unwrap_or(Value::Null)
}

pub fn build_events(hook_type: &str, payload: &Value, process_cwd: &str) -> Vec<Planned> {
    let ws = get(payload, "workspacePaths");
    let conv = get(payload, "conversationId");
    let first_ws = match ws {
        Some(Value::Array(a)) if truthy(a.first()) => a.first().cloned(),
        _ => None,
    };
    let mut base = Map::new();
    base.insert(
        "session_id".into(),
        Value::String(format!("agy:{}", if truthy(conv) { string(conv) } else { "session".into() })),
    );
    base.insert("cwd".into(), first_ws.unwrap_or_else(|| Value::String(process_cwd.into())));
    let cwd_for_resolve = process_cwd;

    match hook_type {
        "SessionStart" => vec![plan(
            0,
            evt(&base, vec![("hook_event_name", "SessionStart".into()), ("source", "startup".into())]),
        )],
        "PreInvocation" => {
            let n = get(payload, "invocationNum");
            let over_one = truthy(n)
                && match n {
                    Some(Value::Number(x)) => x.as_f64().map_or(false, |f| f > 1.0),
                    Some(Value::String(s)) => crate::js::trim(s).parse::<f64>().map_or(false, |f| f > 1.0),
                    _ => false,
                };
            if over_one {
                return vec![];
            }
            let prompt = clean_user_prompt(get(payload, "lastUserInput"));
            if prompt.is_empty() {
                return vec![];
            }
            vec![plan(0, evt(&base, vec![("hook_event_name", "UserPromptSubmit".into()), ("prompt", prompt.into())]))]
        }
        "PreToolUse" => {
            let tool_call = get(payload, "toolCall");
            let mapped = map_tool(tool_call);
            let tool_name = get_opt(tool_call, "name").and_then(Value::as_str).unwrap_or("").to_string();
            let file_path = get(&mapped.1, "file_path").cloned().unwrap_or(Value::String(String::new()));
            let mut events = vec![plan(
                0,
                merge(evt(&base, vec![("hook_event_name", "PreToolUse".into())]), mapped.clone()),
            )];
            let notify = |delay: u64, nt: &str, title: Option<&str>, msg: Value| {
                let mut f = vec![("hook_event_name", Value::from("Notification")), ("notification_type", nt.into())];
                if let Some(t) = title {
                    f.push(("title", t.into()));
                }
                f.push(("message", msg));
                plan(delay, evt(&base, f))
            };
            if tool_name == "run_command" {
                let ti = &mapped.1;
                let ps = Value::String("PowerShell".into());
                let msg = or(&[get(ti, "command"), get(ti, "description"), Some(&ps)]);
                events.push(notify(350, "permission_prompt", Some("Permission needed"), msg.cloned().unwrap_or(Value::Null)));
            } else if tool_name == "ask_question" {
                let q = get(&mapped.1, "question");
                let fallback = Value::String("Antigravity has a question for you".into());
                events.push(notify(250, "elicitation_dialog", Some("Question"), or(&[q, Some(&fallback)]).cloned().unwrap()));
            } else if truthy(Some(&file_path)) && is_outside_workspace(&file_path, ws, cwd_for_resolve) {
                events.push(notify(350, "permission_prompt", Some("Permission needed"), file_path.clone()));
            } else if tool_name == "invoke_subagent" {
                events.push(plan(
                    200,
                    evt(&base, vec![("hook_event_name", "SubagentStart".into()), ("agent_type", str_of(&mapped.1, "subagent_type"))]),
                ));
            }
            events
        }
        "PostToolUse" => {
            let tool_call = get(payload, "toolCall");
            let mapped = map_tool(tool_call);
            let err = get(payload, "error");
            let mut events = Vec::new();
            if truthy(err) {
                let mut e = merge(evt(&base, vec![("hook_event_name", "PostToolUseFailure".into())]), mapped.clone());
                e.insert("error".into(), s280(err).into());
                events.push(plan(0, e));
            } else {
                events.push(plan(0, merge(evt(&base, vec![("hook_event_name", "PostToolUse".into())]), mapped.clone())));
            }
            if get_opt(tool_call, "name").and_then(Value::as_str) == Some("invoke_subagent") {
                events.push(plan(
                    100,
                    evt(&base, vec![("hook_event_name", "SubagentStop".into()), ("agent_type", str_of(&mapped.1, "subagent_type"))]),
                ));
            }
            events
        }
        "Stop" => {
            let err = get(payload, "error");
            let term = get(payload, "terminationReason");
            if term.and_then(Value::as_str) == Some("ERROR") || truthy(err) {
                let fallback = Value::String("Error".into());
                let e = or(&[err, term, Some(&fallback)]);
                return vec![plan(0, evt(&base, vec![("hook_event_name", "StopFailure".into()), ("error", s280(e).into())]))];
            }
            let reply = last_assistant_message(get(payload, "transcriptPath"));
            vec![plan(0, evt(&base, vec![("hook_event_name", "Stop".into()), ("last_assistant_message", reply.into())]))]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bodies(t: &str, p: Value) -> Vec<String> {
        build_events(t, &p, "/cwd").into_iter().map(|e| crate::js::to_body(e.evt)).collect()
    }

    #[test]
    fn responses_never_block() {
        assert_eq!(response("PreToolUse"), "{\"decision\":\"allow\"}\n");
        assert_eq!(response("Stop"), "{\"decision\":\"stop\"}\n");
        assert_eq!(response("Whatever"), "{}\n");
    }

    #[test]
    fn run_command_emits_tool_and_permission() {
        let b = bodies("PreToolUse", json!({"conversationId":"c1","workspacePaths":["/project"],
            "toolCall":{"name":"run_command","args":{"CommandLine":"npm test"}}}));
        assert_eq!(b[0], r#"{"session_id":"agy:c1","cwd":"/project","hook_event_name":"PreToolUse","tool_name":"PowerShell","tool_input":{"command":"npm test","description":"npm test"}}"#);
        assert_eq!(b[1], r#"{"session_id":"agy:c1","cwd":"/project","hook_event_name":"Notification","notification_type":"permission_prompt","title":"Permission needed","message":"npm test"}"#);
    }

    #[test]
    fn outside_workspace_file_asks_permission() {
        let p = json!({"workspacePaths":["/project"],"toolCall":{"name":"read_file","args":{"Path":"/etc/passwd"}}});
        assert_eq!(bodies("PreToolUse", p).len(), 2);
        let p = json!({"workspacePaths":["/project"],"toolCall":{"name":"read_file","args":{"Path":"/project/a/../b.rs"}}});
        assert_eq!(bodies("PreToolUse", p).len(), 1);
        let p = json!({"workspacePaths":["/project"],"toolCall":{"name":"read_file","args":{"Path":"/project/../x"}}});
        assert_eq!(bodies("PreToolUse", p).len(), 2);
    }

    #[test]
    fn prompt_extraction_and_first_invocation_only() {
        let p = json!({"lastUserInput":"x <USER_REQUEST>  fix \n  the bug </user_request> y"});
        assert_eq!(bodies("PreInvocation", p)[0].contains(r#""prompt":"fix the bug""#), true);
        assert!(bodies("PreInvocation", json!({"invocationNum": 2, "lastUserInput":"hi"})).is_empty());
        assert!(bodies("PreInvocation", json!({})).is_empty());
    }

    #[test]
    fn stop_variants() {
        let b = bodies("Stop", json!({"error":"boom"}));
        assert!(b[0].contains(r#""hook_event_name":"StopFailure""#) && b[0].contains(r#""error":"boom""#));
        let b = bodies("Stop", json!({"terminationReason":"ERROR"}));
        assert!(b[0].contains(r#""error":"ERROR""#));
        let b = bodies("Stop", json!({"conversationId":"c"}));
        assert!(b[0].ends_with(r#""hook_event_name":"Stop","last_assistant_message":""}"#));
    }

    #[test]
    fn subagent_events() {
        let b = bodies("PreToolUse", json!({"toolCall":{"name":"invoke_subagent","args":{"TypeName":"explorer"}}}));
        assert_eq!(b.len(), 2);
        assert!(b[1].contains(r#""hook_event_name":"SubagentStart","agent_type":"explorer""#));
        let b = bodies("PostToolUse", json!({"toolCall":{"name":"invoke_subagent","args":{}}}));
        assert!(b[1].contains(r#""hook_event_name":"SubagentStop","agent_type":"agent""#));
    }

    #[test]
    fn transcript_reply_is_the_last_planner_response() {
        let dir = std::env::temp_dir().join(format!("capri-hook-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.jsonl");
        std::fs::write(&f, "{\"type\":\"PLANNER_RESPONSE\",\"content\":\"first\"}\nnot json\n{\"type\":\"PLANNER_RESPONSE\",\"content\":\"  last \"}\n{\"type\":\"X\"}\n").unwrap();
        assert_eq!(last_assistant_message(Some(&json!(f.to_str().unwrap()))), "last");
        std::fs::remove_dir_all(&dir).ok();
    }
}
