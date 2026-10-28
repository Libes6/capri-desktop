//! Small helpers that reproduce JavaScript semantics the Node hooks rely on
//! (UTF-16 lengths, truthiness, String(), trim()), so the output matches byte for byte.

use serde_json::{Map, Value};

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` on UTF-16 code units. A cut inside a surrogate pair cannot be
/// represented in a Rust string, so the lone half becomes U+FFFD.
pub fn slice16(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            if used < n {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

/// `text.length > max ? text.slice(0, max) + '…' : text`
pub fn clip(s: &str, max: usize) -> String {
    if utf16_len(s) > max {
        let mut out = slice16(s, max);
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

pub fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(true, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)`
pub fn string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 && !n.is_i64() && !n.is_u64() => format!("{}", f as i128),
            _ => n.to_string(),
        },
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { string(Some(x)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `obj.key` for a JSON object; anything else has no such property (as in JS for our keys).
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|m| m.get(key))
}

pub fn get_opt<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(|v| get(v, key))
}

/// `a || b || c ...` : the first truthy operand, else the last operand.
pub fn or<'a>(list: &[Option<&'a Value>]) -> Option<&'a Value> {
    for v in list {
        if truthy(*v) {
            return *v;
        }
    }
    list.last().copied().flatten()
}

/// JSON.stringify turns integral floats like `1.0` into `1`; do the same before serialising.
pub fn normalize(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if !n.is_i64() && !n.is_u64() {
                if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.abs() < 9.0e15 {
                        *v = Value::from(f as i64);
                    } else if !f.is_finite() {
                        *v = Value::Null;
                    }
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize),
        Value::Object(m) => m.values_mut().for_each(normalize),
        _ => {}
    }
}

pub fn to_body(map: Map<String, Value>) -> String {
    let mut v = Value::Object(map);
    normalize(&mut v);
    v.to_string()
}
