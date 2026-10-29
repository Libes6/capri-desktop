//! The Node sidecar (the core of Capri) as a child process: spawned, listened to, written to, brought
//! back when it falls (a few times, then an honest error), and ended with the app. Messages are the
//! JSON-RPC lines of rpc.rs; the sidecar's stderr is passed on to ours; stdout that is not a message
//! is logged, never fatal.
//!
//! It never outlives the app: the app shuts it down on exit (a `quit` notification, stdin closed, a
//! kill after a grace period), and if the app itself is killed the sidecar reads EOF on its stdin and
//! leaves by itself (sidecar/main.js).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::rpc::{self, Incoming, Pending, RpcError};

/// What the shell does with what the sidecar says.
pub trait Handler: Send + Sync + 'static {
    /// A request from the sidecar; the answer goes back to it.
    fn on_request(&self, method: &str, params: Value) -> Result<Value, RpcError>;
    /// A request that may take long (a dialog, the key store, a screen grab): answered on its own
    /// thread, so the sidecar's other messages are not held up behind it.
    fn slow(&self, _method: &str) -> bool {
        false
    }
    fn on_notification(&self, method: &str, params: Value);
    /// The process ended (`restarting`: another one is coming; false: it gave up or the app is leaving).
    fn on_down(&self, reason: &str, restarting: bool);
}

/// At most `max` restarts within `window`; each waits longer than the one before.
#[derive(Debug, Clone)]
pub struct RestartPolicy {
    pub max: usize,
    pub window: Duration,
    pub base_delay: Duration,
    starts: Vec<Instant>,
}

impl RestartPolicy {
    pub fn new(max: usize, window: Duration, base_delay: Duration) -> Self {
        RestartPolicy { max, window, base_delay, starts: Vec::new() }
    }

    /// The pause before the next start, or None: too many in the window, give up.
    pub fn next(&mut self, now: Instant) -> Option<Duration> {
        self.starts.retain(|t| now.duration_since(*t) < self.window);
        if self.starts.len() >= self.max {
            return None;
        }
        let delay = self.base_delay * (1u32 << self.starts.len().min(6));
        self.starts.push(now);
        Some(delay)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum State {
    Starting,
    Up,
    /// the process is gone and a new one is coming
    Restarting(String),
    /// gave up: the message says why
    Failed(String),
    Stopped,
}

struct Inner {
    pending: Pending,
    stdin: Mutex<Option<ChildStdin>>,
    state: Mutex<State>,
    leaving: AtomicBool,
    pid: Mutex<Option<u32>>,
}

#[derive(Clone)]
pub struct Sidecar {
    inner: Arc<Inner>,
}

impl Sidecar {
    /// Starts the supervisor thread: `command()` makes the command to run (called for every start).
    pub fn start(command: impl Fn() -> Command + Send + 'static, handler: Arc<dyn Handler>, mut policy: RestartPolicy) -> Sidecar {
        let inner = Arc::new(Inner {
            pending: Pending::new(),
            stdin: Mutex::new(None),
            state: Mutex::new(State::Starting),
            leaving: AtomicBool::new(false),
            pid: Mutex::new(None),
        });
        let sidecar = Sidecar { inner: inner.clone() };
        thread::Builder::new()
            .name("sidecar-supervisor".into())
            .spawn(move || supervise(inner, command, handler, &mut policy))
            .expect("sidecar supervisor thread");
        sidecar
    }

    pub fn state(&self) -> State {
        self.inner.state.lock().unwrap().clone()
    }

    pub fn pid(&self) -> Option<u32> {
        *self.inner.pid.lock().unwrap()
    }

    fn write(&self, line: &str) -> Result<(), RpcError> {
        let mut guard = self.inner.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| self.unavailable())?;
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| RpcError::new(-32000, format!("the core is not listening: {e}")))
    }

    fn unavailable(&self) -> RpcError {
        match self.state() {
            State::Failed(why) => RpcError::new(-32000, format!("the Capri core stopped and could not be restarted: {why}")),
            State::Stopped => RpcError::new(-32000, "the Capri core is shut down"),
            _ => RpcError::new(-32000, "the Capri core is restarting, try again in a moment"),
        }
    }

    /// A request to the sidecar and its answer; fails at `timeout`, or at once when the sidecar goes.
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        let (id, rx) = self.inner.pending.register();
        if let Err(e) = self.write(&rpc::request_line(id, method, &params)) {
            self.inner.pending.forget(id);
            return Err(e);
        }
        rpc::wait(&self.inner.pending, id, rx, method, timeout).await
    }

    /// Fire and forget. Dropped (and logged) when the sidecar is not there.
    pub fn notify(&self, method: &str, params: Value) {
        if let Err(e) = self.write(&rpc::notification_line(method, &params)) {
            eprintln!("[capri] notify {method} dropped: {e}");
        }
    }

    /// The app is leaving: ask the core to stop, close its stdin, kill it if it lingers.
    pub fn shutdown(&self, grace: Duration) {
        self.inner.leaving.store(true, Ordering::SeqCst);
        self.notify("quit", Value::Null);
        self.inner.stdin.lock().unwrap().take(); // EOF: the sidecar leaves on its own
        let until = Instant::now() + grace;
        while Instant::now() < until && self.pid().is_some() {
            thread::sleep(Duration::from_millis(20));
        }
        if let Some(pid) = self.pid() {
            eprintln!("[capri] sidecar {pid} did not leave in time, killing it");
            kill(pid);
            let until = Instant::now() + Duration::from_secs(1);
            while Instant::now() < until && self.pid().is_some() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        *self.inner.state.lock().unwrap() = State::Stopped;
    }

    /// Kills the process without telling the supervisor to stop (the test of the restart, `kill -9`).
    #[cfg(test)]
    fn kill_now(&self) {
        if let Some(pid) = self.pid() {
            kill(pid);
        }
    }
}

#[cfg(unix)]
fn kill(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

#[cfg(windows)]
fn kill(pid: u32) {
    let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status();
}

fn set_state(inner: &Inner, state: State) {
    *inner.state.lock().unwrap() = state;
}

fn supervise(inner: Arc<Inner>, command: impl Fn() -> Command, handler: Arc<dyn Handler>, policy: &mut RestartPolicy) {
    loop {
        if inner.leaving.load(Ordering::SeqCst) {
            break;
        }
        let Some(delay) = policy.next(Instant::now()) else {
            let why = format!("{} starts within {} s", policy.max, policy.window.as_secs());
            set_state(&inner, State::Failed(why.clone()));
            handler.on_down(&why, false);
            return;
        };
        thread::sleep(delay);
        // the app began to leave while this slept: no new process for an app that is going
        if inner.leaving.load(Ordering::SeqCst) {
            break;
        }
        let mut cmd = command();
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[capri] cannot start the sidecar: {e}");
                set_state(&inner, State::Restarting(e.to_string()));
                handler.on_down(&format!("cannot start: {e}"), true);
                continue;
            }
        };
        *inner.pid.lock().unwrap() = Some(child.id());
        *inner.stdin.lock().unwrap() = child.stdin.take();
        if inner.leaving.load(Ordering::SeqCst) {
            // shutdown() ran between the check above and now and found nothing to close: the EOF ends it
            inner.stdin.lock().unwrap().take();
        }
        set_state(&inner, State::Up);
        eprintln!("[capri] sidecar started, pid {}", child.id());

        let stderr = child.stderr.take().map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                eprintln!("{line}");
            }
        }));
        let reader = child.stdout.take().map(|out| {
            let (inner, handler) = (inner.clone(), handler.clone());
            thread::spawn(move || read_loop(out, &inner, &handler))
        });

        let status = wait_for_exit(&mut child);
        *inner.pid.lock().unwrap() = None;
        inner.stdin.lock().unwrap().take();
        // a grandchild that inherited the pipes can hold them open after the sidecar is gone: do not wait for it
        for t in [reader, stderr].into_iter().flatten() {
            join_within(t, PIPE_LINGER);
        }
        let failed = inner.pending.fail_all("the Capri core stopped");
        let reason = format!("exited with {status} ({failed} requests dropped)");
        if inner.leaving.load(Ordering::SeqCst) {
            handler.on_down(&reason, false);
            break;
        }
        eprintln!("[capri] sidecar {reason}");
        set_state(&inner, State::Restarting(reason.clone()));
        handler.on_down(&reason, true);
    }
    set_state(&inner, State::Stopped);
}

/// How long the sidecar's pipes may stay open after it exited (a process it started can hold them).
const PIPE_LINGER: Duration = Duration::from_millis(1500);

fn join_within(handle: thread::JoinHandle<()>, limit: Duration) {
    let until = Instant::now() + limit;
    while !handle.is_finished() && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    if handle.is_finished() {
        let _ = handle.join();
    } // else: left to end by itself
}

fn wait_for_exit(child: &mut Child) -> String {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.to_string(),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => return format!("an error ({e})"),
        }
    }
}

fn read_loop(out: impl std::io::Read, inner: &Arc<Inner>, handler: &Arc<dyn Handler>) {
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        match rpc::parse_line(&line) {
            Ok(Incoming::Response { id, result }) => {
                inner.pending.resolve(id, result);
            }
            Ok(Incoming::Notification { method, params }) => handler.on_notification(&method, params),
            Ok(Incoming::Request { id, method, params }) => {
                let slow = handler.slow(&method);
                let answer = move |inner: &Inner, handler: &Arc<dyn Handler>| {
                    let line = rpc::response_line(&id, handler.on_request(&method, params));
                    if let Some(stdin) = inner.stdin.lock().unwrap().as_mut() {
                        let _ = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush());
                    }
                };
                if slow {
                    let (inner, handler) = (inner.clone(), handler.clone());
                    thread::spawn(move || answer(&inner, &handler));
                } else {
                    answer(inner, handler);
                }
            }
            Err(why) => eprintln!("[capri] sidecar stdout: {why}"),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Recorder {
        downs: Mutex<Vec<(String, bool)>>,
        notes: Mutex<Vec<(String, Value)>>,
        requests: AtomicUsize,
    }
    impl Handler for Recorder {
        fn on_request(&self, method: &str, _params: Value) -> Result<Value, RpcError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            Ok(Value::String(format!("hi {method}")))
        }
        fn on_notification(&self, method: &str, params: Value) {
            self.notes.lock().unwrap().push((method.to_string(), params));
        }
        fn on_down(&self, reason: &str, restarting: bool) {
            self.downs.lock().unwrap().push((reason.to_string(), restarting));
        }
    }

    fn sh(script: &'static str) -> impl Fn() -> Command {
        move || {
            let mut c = Command::new("sh");
            c.args(["-c", script]);
            c
        }
    }

    fn wait_until(what: &str, check: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if check() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for: {what}");
    }

    #[test]
    fn restart_policy_backs_off_and_gives_up() {
        let mut p = RestartPolicy::new(3, Duration::from_secs(60), Duration::from_millis(100));
        let t = Instant::now();
        assert_eq!(p.next(t), Some(Duration::from_millis(100)));
        assert_eq!(p.next(t), Some(Duration::from_millis(200)));
        assert_eq!(p.next(t), Some(Duration::from_millis(400)));
        assert_eq!(p.next(t), None);
        // the window passes: allowed again, from the start
        assert_eq!(p.next(t + Duration::from_secs(61)), Some(Duration::from_millis(100)));
    }

    #[tokio::test]
    async fn requests_get_their_answers_and_notifications_and_requests_reach_the_handler() {
        // reads one line, then answers it (id 1) and sends a notification and a request of its own
        let script = r#"read l; printf '%s\n' '{"jsonrpc":"2.0","method":"ready","params":{"n":1}}' '{"jsonrpc":"2.0","id":7,"method":"hello"}' '{"jsonrpc":"2.0","id":1,"result":"pong"}'; read l2; sleep 5"#;
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(sh(script), h.clone(), RestartPolicy::new(3, Duration::from_secs(60), Duration::from_millis(1)));
        wait_until("up", || s.state() == State::Up);
        let r = s.request("ping", Value::Null, Duration::from_secs(5)).await.unwrap();
        assert_eq!(r, Value::String("pong".into()));
        wait_until("notification", || !h.notes.lock().unwrap().is_empty());
        assert_eq!(h.notes.lock().unwrap()[0].0, "ready");
        assert_eq!(h.requests.load(Ordering::SeqCst), 1);
        s.shutdown(Duration::from_secs(1));
        assert_eq!(s.pid(), None);
    }

    #[tokio::test]
    async fn a_request_that_is_not_answered_times_out() {
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(sh("sleep 30"), h, RestartPolicy::new(3, Duration::from_secs(60), Duration::from_millis(1)));
        wait_until("up", || s.state() == State::Up);
        let e = s.request("slow", Value::Null, Duration::from_millis(80)).await.unwrap_err();
        assert_eq!(e.code, -32001);
        s.shutdown(Duration::from_millis(100));
        assert_eq!(s.pid(), None, "killed after the grace period");
    }

    #[tokio::test]
    async fn a_killed_sidecar_fails_what_waits_and_comes_back() {
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(sh("sleep 30"), h.clone(), RestartPolicy::new(5, Duration::from_secs(60), Duration::from_millis(10)));
        wait_until("up", || s.state() == State::Up);
        let first = s.pid().unwrap();
        let waiting = { let s = s.clone(); tokio::spawn(async move { s.request("never", Value::Null, Duration::from_secs(20)).await }) };
        tokio::time::sleep(Duration::from_millis(100)).await;
        s.kill_now();
        let e = waiting.await.unwrap().unwrap_err();
        assert!(e.message.contains("core"), "{e:?}");
        wait_until("restarted", || s.state() == State::Up && s.pid().is_some_and(|p| p != first));
        assert_eq!(h.downs.lock().unwrap()[0].1, true, "told it is restarting");
        s.shutdown(Duration::from_millis(100));
    }

    #[tokio::test]
    async fn a_sidecar_that_keeps_dying_is_given_up_with_an_honest_error() {
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(sh("exit 3"), h.clone(), RestartPolicy::new(3, Duration::from_secs(60), Duration::from_millis(5)));
        wait_until("failed", || matches!(s.state(), State::Failed(_)));
        let e = s.request("x", Value::Null, Duration::from_secs(1)).await.unwrap_err();
        assert!(e.message.contains("could not be restarted"), "{e:?}");
        let downs = h.downs.lock().unwrap();
        assert_eq!(downs.len(), 4, "three exits that restart, and the one that gives up");
        assert_eq!(downs.last().unwrap().1, false);
    }

    #[test]
    fn a_process_holding_the_pipes_open_does_not_stop_the_restarts() {
        // the sidecar exits at once, but a child it left behind keeps its stdout: the reader would never see EOF
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(sh("sleep 8 & exit 3"), h, RestartPolicy::new(2, Duration::from_secs(60), Duration::from_millis(5)));
        wait_until("failed", || matches!(s.state(), State::Failed(_)));
    }

    #[test]
    fn nothing_is_started_for_an_app_that_is_leaving() {
        use std::sync::atomic::AtomicUsize;
        let starts = Arc::new(AtomicUsize::new(0));
        let counted = starts.clone();
        let command = move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let mut c = Command::new("sh");
            c.args(["-c", "exit 1"]);
            c
        };
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(command, h, RestartPolicy::new(5, Duration::from_secs(60), Duration::from_millis(300)));
        wait_until("first start", || starts.load(Ordering::SeqCst) == 1);
        wait_until("restarting", || matches!(s.state(), State::Restarting(_)));
        s.shutdown(Duration::from_millis(100)); // the supervisor is asleep before the second start (600 ms)
        thread::sleep(Duration::from_millis(1000));
        assert_eq!(starts.load(Ordering::SeqCst), 1, "no start after shutdown");
    }

    #[test]
    fn a_command_that_cannot_be_spawned_is_retried_then_given_up() {
        let h = Arc::new(Recorder::default());
        let s = Sidecar::start(|| Command::new("/nonexistent/capri-sidecar"), h, RestartPolicy::new(2, Duration::from_secs(60), Duration::from_millis(5)));
        wait_until("failed", || matches!(s.state(), State::Failed(_)));
    }
}
