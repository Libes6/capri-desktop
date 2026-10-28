//! hooks/capri-hook.js (`slim`) and hooks/capri-codex-hook.js (`adapt`).

use crate::js::{self, clip, get, get_opt, string, truthy, utf16_len};
use serde_json::{Map, Value};

/// Fields Capri actually uses. Everything else stays on the machine.
const KEEP: [&str; 21] = [
    "hook_event_name", "session_id", "cwd", "session_title", "permission_mode",
    "tool_name", "tool_input", "tool_use_id", "duration_ms", "error", "is_interrupt",
    "prompt", "message", "title", "notification_type", "last_assistant_message",
    "agent_id", "agent_type", "source", "reason", "trigger",
];
const BIG: [&str; 5] = ["content", "old_string", "new_string", "new_source", "edits"];
pub const REPLY_MAX: usize = 6000;

/// `trim(value, depth)`; `None` is JavaScript's `undefined`.
pub fn trim(value: &Value, depth: u32) -> Option<Value> {
    match value {
        Value::String(s) => Some(Value::String(clip(s, 280))),
        Value::Array(a) => {
            if depth > 2 {
                return None;
            }
            Some(Value::Array(
                a.iter().take(8).map(|v| trim(v, depth + 1).unwrap_or(Value::Null)).collect(),
            ))
        }
        Value::Object(m) => {
            if depth > 2 {
                return None;
            }
            let mut out = Map::new();
            for (k, v) in m {
                if BIG.contains(&k.as_str()) {
                    let len = match v {
                        Value::String(s) => utf16_len(s),
                        Value::Array(a) => a.len(),
                        _ => 0,
                    };
                    out.insert(format!("{k}_len"), Value::from(len));
                    continue;
                }
                match trim(v, depth + 1) {
                    Some(t) => {
                        out.insert(k.clone(), t);
                    }
                    None => {
                        out.shift_remove(k);
                    }
                }
            }
            Some(Value::Object(out))
        }
        other => Some(other.clone()),
    }
}

pub fn slim(evt: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for key in KEEP {
        if let Some(v) = get(evt, key) {
            if let Some(t) = trim(v, 0) {
                out.insert(key.to_string(), t);
            }
        }
    }
    if let Some(Value::String(reply)) = get(evt, "last_assistant_message") {
        out.insert("last_assistant_message".into(), Value::String(clip(reply, REPLY_MAX)));
    }
    out
}

/// Claude Code: the identity adapter, but the event must be a JSON object (or array, like JS).
pub fn adapt_claude(evt: Value) -> Option<Value> {
    matches!(evt, Value::Object(_) | Value::Array(_)).then_some(evt)
}

fn files_of_patch(command: &str) -> Vec<String> {
    command
        .split(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        .filter_map(|line| {
            let rest = line.strip_prefix("*** ")?;
            let rest = ["Update", "Add", "Delete"].iter().find_map(|k| rest.strip_prefix(k))?;
            let name = rest.strip_prefix(" File: ")?;
            (!name.is_empty()).then(|| js::trim(name).to_string())
        })
        .collect()
}

/// Codex: translate its lifecycle hooks into Capri's vocabulary. Observe only.
/// `None` means the JS adapter returned null or threw: nothing is sent.
pub fn adapt_codex(evt: Value) -> Option<Value> {
    let map = evt.as_object()?;
    if !matches!(map.get("hook_event_name"), Some(Value::String(_))) {
        return None;
    }
    let name = get(&evt, "hook_event_name").and_then(Value::as_str).unwrap_or("").to_string();
    let tool_name = map.get("tool_name");
    let tool_input = map.get("tool_input");
    let sid = map.get("session_id");
    let sid = if truthy(sid) { string(sid) } else { "default".into() };

    let mut out = map.clone();
    out.insert("session_id".into(), Value::String(format!("codex:{sid}")));

    if name == "PermissionRequest" {
        out.insert("hook_event_name".into(), "Notification".into());
        out.insert("notification_type".into(), "permission_prompt".into());
        let desc = get_opt(tool_input, "description");
        let msg = if truthy(desc) {
            desc.cloned().unwrap_or(Value::Null)
        } else {
            let t = if truthy(tool_name) { string(tool_name) } else { "tool".into() };
            Value::String(format!("Codex needs approval: {t}"))
        };
        out.insert("message".into(), msg);
    }
    let tn = tool_name.and_then(Value::as_str);
    if tn == Some("apply_patch") {
        out.insert("tool_name".into(), "Edit".into());
        let c = get_opt(tool_input, "command");
        let cmd = if truthy(c) { string(c) } else { String::new() };
        let files = files_of_patch(&cmd);
        let mut ti = Map::new();
        if let Some(first) = files.first() {
            ti.insert("file_path".into(), first.clone().into());
        }
        ti.insert("file_paths".into(), Value::Array(files.into_iter().map(Value::from).collect()));
        out.insert("tool_input".into(), Value::Object(ti));
    }
    if tn == Some("exec_command") || tn == Some("shell_command") {
        out.insert("tool_name".into(), "Bash".into());
        let mut ti = tool_input.and_then(Value::as_object).cloned().unwrap_or_default();
        let cmd = js::or(&[get_opt(tool_input, "cmd"), get_opt(tool_input, "command")]);
        match cmd {
            Some(v) => {
                ti.insert("command".into(), v.clone());
            }
            None => {
                ti.shift_remove("command");
            }
        }
        out.insert("tool_input".into(), Value::Object(ti));
    }
    if name == "PreToolUse" && tn == Some("request_user_input") {
        out.insert("hook_event_name".into(), "Notification".into());
        out.insert("notification_type".into(), "agent_needs_input".into());
        let message = match get_opt(tool_input, "questions") {
            None | Some(Value::Null) => None,
            Some(Value::Array(qs)) => {
                let mut parts = Vec::new();
                for q in qs {
                    if q.is_null() {
                        return None; // q.question on null throws in JS: nothing is sent
                    }
                    let v = js::or(&[get(q, "question"), get(q, "title")]);
                    if truthy(v) {
                        parts.push(string(v));
                    }
                }
                Some(parts.join("\n"))
            }
            Some(_) => return None, // .map is not a function: throws in JS
        };
        let msg = match message {
            Some(m) if !m.is_empty() => m,
            _ => "Codex needs your input.".into(),
        };
        out.insert("message".into(), msg.into());
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body(v: Value) -> String {
        js::to_body(slim(&v))
    }

    #[test]
    fn keeps_only_known_fields_in_order() {
        let b = body(json!({"zzz": 1, "cwd": "/p", "hook_event_name": "Stop", "tool_output": "secret"}));
        assert_eq!(b, r#"{"hook_event_name":"Stop","cwd":"/p"}"#);
    }

    #[test]
    fn trims_long_strings_arrays_and_edit_payloads() {
        let long = "я".repeat(300);
        let b = body(json!({"hook_event_name":"PreToolUse","prompt": long,
            "tool_input": {"content": "abc", "old_string": "x", "edits": [1,2], "list": [1,2,3,4,5,6,7,8,9,10],
                           "deep": {"a": {"b": {"c": 1}}}, "nested": {"s": "q"}}}));
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v["prompt"].as_str().unwrap().chars().count(), 281);
        assert_eq!(v["tool_input"]["content_len"], 3);
        assert_eq!(v["tool_input"]["old_string_len"], 1);
        assert_eq!(v["tool_input"]["edits_len"], 2);
        assert_eq!(v["tool_input"]["list"].as_array().unwrap().len(), 8);
        assert_eq!(v["tool_input"]["deep"], json!({"a": {}}));
        assert!(v["tool_input"].get("content").is_none());
    }

    #[test]
    fn depth_limit_drops_objects_and_nulls_array_items() {
        let v = trim(&json!({"a": {"b": {"c": {"d": 1}}}, "l": [[[[1]]]]}), 0).unwrap();
        assert_eq!(v, json!({"a": {"b": {}}, "l": [[null]]}));
    }

    #[test]
    fn reply_gets_a_longer_limit() {
        let b = body(json!({"last_assistant_message": "x".repeat(7000)}));
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v["last_assistant_message"].as_str().unwrap().chars().count(), 6001);
    }

    #[test]
    fn utf16_units_count_like_javascript() {
        // emoji is two UTF-16 units: 279 'a' + emoji = 281 units > 280
        let s = format!("{}😀", "a".repeat(279));
        assert_eq!(clip(&s, 280).chars().count(), 281); // 279 a + U+FFFD + ellipsis
    }

    #[test]
    fn codex_translates_permission_and_patch_and_shell() {
        let p = adapt_codex(json!({"hook_event_name":"PermissionRequest","session_id":"s","tool_name":"Bash","tool_input":{"description":"Allow?"}})).unwrap();
        assert_eq!(p["hook_event_name"], "Notification");
        assert_eq!(p["session_id"], "codex:s");
        assert_eq!(p["message"], "Allow?");
        let p = adapt_codex(json!({"hook_event_name":"PermissionRequest"})).unwrap();
        assert_eq!(p["message"], "Codex needs approval: tool");
        assert_eq!(p["session_id"], "codex:default");
        let p = adapt_codex(json!({"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Update File: a.js\n*** Add File: b.js \r\n*** Move File: c"}})).unwrap();
        assert_eq!(p["tool_input"], json!({"file_path":"a.js","file_paths":["a.js","b.js"]}));
        let p = adapt_codex(json!({"hook_event_name":"PreToolUse","tool_name":"exec_command","tool_input":{"cmd":"ls","workdir":"/"}})).unwrap();
        assert_eq!(p["tool_name"], "Bash");
        assert_eq!(p["tool_input"], json!({"cmd":"ls","workdir":"/","command":"ls"}));
        let p = adapt_codex(json!({"hook_event_name":"PreToolUse","tool_name":"request_user_input","tool_input":{"questions":[{"question":"A?"},{"title":"B"},{}]}})).unwrap();
        assert_eq!(p["message"], "A?\nB");
        assert_eq!(p["notification_type"], "agent_needs_input");
    }

    #[test]
    fn codex_rejects_what_js_rejects() {
        assert!(adapt_codex(json!(null)).is_none());
        assert!(adapt_codex(json!([])).is_none());
        assert!(adapt_codex(json!({"hook_event_name": 5})).is_none());
        assert!(adapt_codex(json!({"hook_event_name":"PreToolUse","tool_name":"request_user_input","tool_input":{"questions":[null]}})).is_none());
    }
}
