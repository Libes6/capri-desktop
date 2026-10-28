//! JSON-RPC 2.0 lines between this shell and the Node sidecar (sidecar/rpc.js is the other half).
//! One JSON object per line. A message with `method` and `id` is a request, with `method` and no
//! `id` a notification, with `id` and `result` or `error` an answer. The ids of the two directions
//! are each sender's own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    /// the core's own code (a ProtocolError's: unknown / forbidden / invalid), when it gave one
    pub kind: Option<String>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), kind: None }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            Some(kind) => write!(f, "{kind}: {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: u64, result: Result<Value, RpcError> },
}

pub fn parse_line(line: &str) -> Result<Incoming, String> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| format!("not JSON ({e}): {}", line.chars().take(120).collect::<String>()))?;
    let obj = v.as_object().ok_or("not an object")?;
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = obj.get("method").and_then(Value::as_str) {
        return Ok(match obj.get("id") {
            Some(id) if !id.is_null() => Incoming::Request { id: id.clone(), method: method.to_string(), params },
            _ => Incoming::Notification { method: method.to_string(), params },
        });
    }
    let id = obj.get("id").and_then(Value::as_u64).ok_or("an answer without a numeric id")?;
    if let Some(err) = obj.get("error").filter(|e| !e.is_null()) {
        return Ok(Incoming::Response {
            id,
            result: Err(RpcError {
                code: err.get("code").and_then(Value::as_i64).unwrap_or(-32000),
                message: err.get("message").and_then(Value::as_str).unwrap_or("error").to_string(),
                kind: err.pointer("/data/code").and_then(Value::as_str).map(str::to_string),
            }),
        });
    }
    Ok(Incoming::Response { id, result: Ok(obj.get("result").cloned().unwrap_or(Value::Null)) })
}

pub fn request_line(id: u64, method: &str, params: &Value) -> String {
    format!("{}\n", json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
}

pub fn notification_line(method: &str, params: &Value) -> String {
    format!("{}\n", json!({"jsonrpc": "2.0", "method": method, "params": params}))
}

pub fn response_line(id: &Value, result: Result<Value, RpcError>) -> String {
    match result {
        Ok(v) => format!("{}\n", json!({"jsonrpc": "2.0", "id": id, "result": v})),
        Err(e) => format!("{}\n", json!({"jsonrpc": "2.0", "id": id, "error": {"code": e.code, "message": e.message}})),
    }
}

type Answer = Result<Value, RpcError>;

/// The requests this side has sent and is waiting on.
#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    map: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
}

impl Pending {
    pub fn new() -> Self {
        Pending { next: AtomicU64::new(1), map: Mutex::new(HashMap::new()) }
    }

    pub fn register(&self) -> (u64, oneshot::Receiver<Answer>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.map.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    /// An answer came. false: nobody waits for it any more (it had timed out).
    pub fn resolve(&self, id: u64, answer: Answer) -> bool {
        match self.map.lock().unwrap().remove(&id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    pub fn forget(&self, id: u64) {
        self.map.lock().unwrap().remove(&id);
    }

    /// The sidecar is gone: everything waiting fails now, not at its timeout.
    pub fn fail_all(&self, message: &str) -> usize {
        let drained: Vec<_> = self.map.lock().unwrap().drain().collect();
        let n = drained.len();
        for (_, tx) in drained {
            let _ = tx.send(Err(RpcError::new(-32000, message)));
        }
        n
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

/// Waits for an answer at most `timeout`; the request is forgotten when it does not come.
pub async fn wait(pending: &Pending, id: u64, rx: oneshot::Receiver<Answer>, method: &str, timeout: Duration) -> Answer {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) => Err(RpcError::new(-32000, format!("{method}: the core went away"))),
        Err(_) => {
            pending.forget(id);
            Err(RpcError::new(-32001, format!("{method}: no answer in {} ms", timeout.as_millis())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests_notifications_and_answers() {
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":3,"method":"hello","params":{"a":1}}"#).unwrap(),
            Incoming::Request { id: json!(3), method: "hello".into(), params: json!({"a": 1}) }
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","method":"emit","params":[1]}"#).unwrap(),
            Incoming::Notification { method: "emit".into(), params: json!([1]) }
        );
        assert_eq!(parse_line(r#"{"id":5,"result":{"ok":true}}"#).unwrap(), Incoming::Response { id: 5, result: Ok(json!({"ok": true})) });
        // a null id is a notification, not a request
        assert!(matches!(parse_line(r#"{"id":null,"method":"x"}"#).unwrap(), Incoming::Notification { .. }));
    }

    #[test]
    fn parses_errors_with_the_cores_code() {
        let line = r#"{"id":9,"error":{"code":-32000,"message":"nope","data":{"code":"forbidden"}}}"#;
        match parse_line(line).unwrap() {
            Incoming::Response { id: 9, result: Err(e) } => {
                assert_eq!(e.kind.as_deref(), Some("forbidden"));
                assert_eq!(e.to_string(), "forbidden: nope");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn refuses_what_is_not_a_message() {
        assert!(parse_line("[capri] update: disabled").is_err());
        assert!(parse_line("[1,2]").is_err());
        assert!(parse_line(r#"{"result":1}"#).is_err());
    }

    #[test]
    fn lines_round_trip() {
        let line = request_line(4, "invoke", &json!({"name": "x"}));
        assert!(line.ends_with('\n'));
        assert!(matches!(parse_line(&line).unwrap(), Incoming::Request { method, .. } if method == "invoke"));
        let ans = response_line(&json!(4), Err(RpcError::new(-1, "bad")));
        assert!(matches!(parse_line(&ans).unwrap(), Incoming::Response { id: 4, result: Err(_) }));
    }

    #[tokio::test]
    async fn an_answer_resolves_and_a_missing_one_times_out() {
        let p = Pending::new();
        let (id, rx) = p.register();
        assert!(p.resolve(id, Ok(json!(1))));
        assert_eq!(wait(&p, id, rx, "a", Duration::from_secs(1)).await.unwrap(), json!(1));

        let (id, rx) = p.register();
        let err = wait(&p, id, rx, "slow", Duration::from_millis(30)).await.unwrap_err();
        assert_eq!(err.code, -32001);
        assert_eq!(p.len(), 0, "forgotten");
        assert!(!p.resolve(id, Ok(json!(2))), "a late answer is dropped");
    }

    #[tokio::test]
    async fn fail_all_fails_everything_waiting_at_once() {
        let p = Pending::new();
        let (a, ra) = p.register();
        let (b, rb) = p.register();
        assert_eq!(p.fail_all("sidecar exited"), 2);
        assert!(wait(&p, a, ra, "a", Duration::from_secs(5)).await.unwrap_err().message.contains("sidecar exited"));
        assert!(wait(&p, b, rb, "b", Duration::from_secs(5)).await.is_err());
    }
}
