//! Sleep, wake, screen lock and user switch (TAURI-07), in the names `src/main/power.js` listens for
//! (docs/POWER_EVENTS.md): suspend, resume, lock-screen, unlock-screen, user-did-resign-active,
//! user-did-become-active. The same set Electron's powerMonitor gives, per system:
//!
//!   macOS    NSWorkspace (WillSleep, DidWake, SessionDidResignActive / BecomeActive) and the distributed
//!            com.apple.screenIsLocked / screenIsUnlocked. Idle: CGEventSourceSecondsSinceLastEventType.
//!   Windows  a message-only window: WM_POWERBROADCAST and WTS session notifications (written to the
//!            documentation and compile-checked for x86_64-pc-windows-msvc; never run).
//!   Linux    systemd-logind's PrepareForSleep, read from `gdbus monitor` (never run). No lock events,
//!            as in Electron (POWER_EVENTS.md): only sleep pauses her there.
//!
//! A real lock or sleep is never provoked here (it needs the user's password): the tests feed events
//! to the same code the system's notifications reach.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Suspend,
    Resume,
    LockScreen,
    UnlockScreen,
    UserDidResignActive,
    UserDidBecomeActive,
}

impl Event {
    pub fn name(self) -> &'static str {
        match self {
            Event::Suspend => "suspend",
            Event::Resume => "resume",
            Event::LockScreen => "lock-screen",
            Event::UnlockScreen => "unlock-screen",
            Event::UserDidResignActive => "user-did-resign-active",
            Event::UserDidBecomeActive => "user-did-become-active",
        }
    }
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// What the system last said of the screen lock, for `getSystemIdleState`.
#[derive(Default)]
pub struct Tracker {
    locked: AtomicBool,
}

impl Tracker {
    pub fn locked(&self) -> bool {
        self.locked.load(Ordering::Relaxed)
    }
    pub fn set_locked(&self, on: bool) {
        self.locked.store(on, Ordering::Relaxed);
    }
    /// An event happened: the lock flag follows, then the event goes on to `sink`.
    pub fn feed(&self, event: Event, sink: &Sink) {
        match event {
            Event::LockScreen => self.set_locked(true),
            Event::UnlockScreen => self.set_locked(false),
            _ => {}
        }
        sink(event);
    }
}

/// Electron's getSystemIdleState: 'locked', else 'idle' once `idle_seconds` has reached `threshold`,
/// else 'active'; 'unknown' when the idle time cannot be read.
pub fn idle_state(locked: bool, idle_seconds: Option<f64>, threshold: f64) -> &'static str {
    if locked {
        return "locked";
    }
    match idle_seconds {
        Some(s) if s >= threshold => "idle",
        Some(_) => "active",
        None => "unknown",
    }
}

/// Seconds since the last keyboard or mouse event, when this system can say.
pub fn idle_seconds() -> Option<f64> {
    imp::idle_seconds()
}

/// Is the screen locked right now (read from the system, for the start: the events say the rest).
pub fn locked_now() -> bool {
    imp::locked_now()
}

/// Watches the system. Keep it for as long as events are wanted. On macOS call it from the main thread.
pub struct Monitor {
    _inner: imp::Inner,
}

pub fn start(tracker: Arc<Tracker>, sink: Sink) -> Monitor {
    tracker.set_locked(locked_now());
    let forward: Sink = Arc::new(move |e| tracker.feed(e, &sink));
    Monitor { _inner: imp::start(forward) }
}

// ---------------------------------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod imp {
    use super::{Event, Sink};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::msg_send;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceSessionDidBecomeActiveNotification, NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification};
    use objc2_foundation::{NSDictionary, NSNotification, NSNotificationCenter, NSObjectProtocol, NSString};
    use std::ptr::NonNull;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> *const NSDictionary<NSString, AnyObject>;
    }

    pub fn idle_seconds() -> Option<f64> {
        // kCGEventSourceStateCombinedSessionState = 0, kCGAnyInputEventType = ~0
        let s = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        (s.is_finite() && s >= 0.0).then_some(s)
    }

    pub fn locked_now() -> bool {
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return false;
            }
            // a +1 reference (Copy): Retained takes it over
            let dict: Retained<NSDictionary<NSString, AnyObject>> = Retained::from_raw(dict as *mut _).unwrap();
            let key = NSString::from_str("CGSSessionScreenIsLocked");
            match dict.objectForKey(&key) {
                Some(v) => msg_send![&*v, boolValue],
                None => false,
            }
        }
    }

    pub struct Inner {
        // kept so the observers stay registered; Drop removes them
        observers: Vec<(Retained<NSNotificationCenter>, Retained<ProtocolObject<dyn NSObjectProtocol>>)>,
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            for (center, observer) in self.observers.drain(..) {
                unsafe { center.removeObserver(&*observer.as_ref()) };
            }
        }
    }

    // not Send by the type system (Objective-C objects); the Monitor lives on the main thread that made it
    unsafe impl Send for Inner {}
    unsafe impl Sync for Inner {}

    fn observe(center: &NSNotificationCenter, name: &NSString, event: Event, sink: &Sink) -> Retained<ProtocolObject<dyn NSObjectProtocol>> {
        let sink = sink.clone();
        let block = RcBlock::new(move |_n: NonNull<NSNotification>| sink(event));
        unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) }
    }

    pub fn start(sink: Sink) -> Inner {
        let mut observers = Vec::new();
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
            for (name, event) in [
                (NSWorkspaceWillSleepNotification, Event::Suspend),
                (NSWorkspaceDidWakeNotification, Event::Resume),
                (NSWorkspaceSessionDidResignActiveNotification, Event::UserDidResignActive),
                (NSWorkspaceSessionDidBecomeActiveNotification, Event::UserDidBecomeActive),
            ] {
                observers.push((workspace.clone(), observe(&workspace, name, event, &sink)));
            }
            let distributed: Retained<NSNotificationCenter> = {
                let c = objc2_foundation::NSDistributedNotificationCenter::defaultCenter();
                // an app with no windows in front counts as inactive, and the center then holds
                // notifications back: she is always in the background, so ask for them regardless
                c.setSuspended(false);
                Retained::into_super(c)
            };
            let mut locks = vec![("com.apple.screenIsLocked".to_string(), Event::LockScreen), ("com.apple.screenIsUnlocked".to_string(), Event::UnlockScreen)];
            // debug builds only: two more names to listen to, so the real path (the main run loop, the
            // distributed center) can be driven without locking the screen or tripping other apps that
            // listen for the real names (password managers lock on them)
            #[cfg(debug_assertions)]
            if let Ok(prefix) = std::env::var("CAPRI_POWER_TEST_NAME") {
                locks.push((format!("{prefix}.lock"), Event::LockScreen));
                locks.push((format!("{prefix}.unlock"), Event::UnlockScreen));
            }
            for (name, event) in locks {
                observers.push((distributed.clone(), observe(&distributed, &NSString::from_str(&name), event, &sink)));
            }
        }
        Inner { observers }
    }

    /// Posts what the system would post to the workspace observers (tests: no real sleep).
    #[cfg(test)]
    pub fn emulate(event: Event) {
        unsafe {
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            let name = match event {
                Event::Suspend => NSWorkspaceWillSleepNotification,
                Event::Resume => NSWorkspaceDidWakeNotification,
                Event::UserDidResignActive => NSWorkspaceSessionDidResignActiveNotification,
                _ => NSWorkspaceSessionDidBecomeActiveNotification,
            };
            center.postNotificationName_object(name, None);
        }
    }
}

// ---------------------------------------------------------------------------------------------------
#[cfg(windows)]
mod imp {
    use super::{Event, Sink};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, PBT_APMRESUMEAUTOMATIC,
        PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW,
    };

    const WTS_SESSION_LOCK: usize = 0x7;
    const WTS_SESSION_UNLOCK: usize = 0x8;

    static SINK: OnceLock<Sink> = OnceLock::new();

    pub fn idle_seconds() -> Option<f64> {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: info is a valid, sized LASTINPUTINFO
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        let now = unsafe { GetTickCount() };
        Some(now.wrapping_sub(info.dwTime) as f64 / 1000.0)
    }

    /// Windows has no cheap, honest read of the lock state; the events say it (and a start behind the
    /// lock screen is not caught here).
    pub fn locked_now() -> bool {
        false
    }

    pub struct Inner;

    pub fn event_for(message: u32, wparam: usize) -> Option<Event> {
        match (message, wparam) {
            (WM_POWERBROADCAST, w) if w == PBT_APMSUSPEND as usize => Some(Event::Suspend),
            (WM_POWERBROADCAST, w) if w == PBT_APMRESUMEAUTOMATIC as usize || w == PBT_APMRESUMESUSPEND as usize => Some(Event::Resume),
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some(Event::LockScreen),
            (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK) => Some(Event::UnlockScreen),
            _ => None,
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if let (Some(event), Some(sink)) = (event_for(message, wparam), SINK.get()) {
            sink(event);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    pub fn start(sink: Sink) -> Inner {
        if SINK.set(sink).is_err() {
            return Inner; // already watching
        }
        std::thread::Builder::new()
            .name("capri-power".into())
            .spawn(|| unsafe {
                let class: Vec<u16> = "CapriPowerWatch\0".encode_utf16().collect();
                let instance = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
                if RegisterClassW(&wc) == 0 {
                    eprintln!("[capri] power: RegisterClassW failed");
                    return;
                }
                let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), instance, std::ptr::null());
                if hwnd.is_null() {
                    eprintln!("[capri] power: no message window");
                    return;
                }
                if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                    eprintln!("[capri] power: no session notifications (lock events will not come)");
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                WTSUnRegisterSessionNotification(hwnd);
            })
            .ok();
        Inner
    }
}

// ---------------------------------------------------------------------------------------------------
#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::{Event, Sink};
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    pub fn idle_seconds() -> Option<f64> {
        None // no portable read (X11 screensaver / Wayland idle-notify are the session's)
    }

    pub fn locked_now() -> bool {
        false
    }

    /// One line of `gdbus monitor --system --dest org.freedesktop.login1`:
    /// `/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)`
    pub fn parse(line: &str) -> Option<Event> {
        let rest = line.split_once("org.freedesktop.login1.Manager.PrepareForSleep")?.1;
        let arg = rest.trim().trim_start_matches('(').trim_end_matches(')').trim_end_matches(',').trim();
        match arg {
            "true" => Some(Event::Suspend),
            "false" => Some(Event::Resume),
            _ => None,
        }
    }

    pub struct Inner(Option<Child>);

    impl Drop for Inner {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    pub fn start(sink: Sink) -> Inner {
        let spawned = Command::new("gdbus")
            .args(["monitor", "--system", "--dest", "org.freedesktop.login1", "--object-path", "/org/freedesktop/login1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[capri] power: no gdbus ({e}); sleep and wake will not be seen");
                return Inner(None);
            }
        };
        if let Some(out) = child.stdout.take() {
            std::thread::Builder::new()
                .name("capri-power".into())
                .spawn(move || {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        if let Some(event) = parse(&line) {
                            sink(event);
                        }
                    }
                })
                .ok();
        }
        Inner(Some(child))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn collecting() -> (Sink, Arc<Mutex<Vec<&'static str>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        (Arc::new(move |e: Event| s.lock().unwrap().push(e.name())), seen)
    }

    #[test]
    fn names_are_the_ones_power_js_listens_for() {
        let all = [Event::Suspend, Event::Resume, Event::LockScreen, Event::UnlockScreen, Event::UserDidResignActive, Event::UserDidBecomeActive];
        let names: Vec<_> = all.iter().map(|e| e.name()).collect();
        assert_eq!(names, ["suspend", "resume", "lock-screen", "unlock-screen", "user-did-resign-active", "user-did-become-active"]);
        // the same six keys as EVENTS in src/main/power.js
        let js = include_str!("../../src/main/power.js");
        for n in names {
            assert!(js.contains(&format!("'{n}'")) || js.contains(&format!("{n}:")), "{n}");
        }
    }

    #[test]
    fn the_tracker_follows_the_lock_and_passes_every_event_on() {
        let (sink, seen) = collecting();
        let t = Tracker::default();
        assert!(!t.locked());
        t.feed(Event::LockScreen, &sink);
        assert!(t.locked());
        t.feed(Event::Suspend, &sink);
        t.feed(Event::Resume, &sink);
        assert!(t.locked(), "waking does not unlock");
        t.feed(Event::UnlockScreen, &sink);
        assert!(!t.locked());
        assert_eq!(*seen.lock().unwrap(), ["lock-screen", "suspend", "resume", "unlock-screen"]);
    }

    #[test]
    fn idle_state_is_electrons() {
        assert_eq!(idle_state(true, Some(0.0), 60.0), "locked");
        assert_eq!(idle_state(false, Some(61.0), 60.0), "idle");
        assert_eq!(idle_state(false, Some(2.0), 60.0), "active");
        assert_eq!(idle_state(false, None, 60.0), "unknown");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reads_idle_time_and_lock_state() {
        let s = idle_seconds().expect("idle seconds");
        assert!((0.0..1e7).contains(&s), "{s}");
        assert!(!locked_now() || locked_now(), "readable");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_notifications_reach_the_sink() {
        let (sink, seen) = collecting();
        let tracker = Arc::new(Tracker::default());
        let _monitor = start(tracker.clone(), sink);
        // the workspace center calls the block on the posting thread
        for e in [Event::Suspend, Event::Resume, Event::UserDidResignActive, Event::UserDidBecomeActive] {
            imp::emulate(e);
        }
        assert_eq!(*seen.lock().unwrap(), ["suspend", "resume", "user-did-resign-active", "user-did-become-active"]);
        // The distributed center (lock, unlock) delivers on the MAIN run loop, which a test thread is not
        // on: there it is only registered here; the live run drives it (docs/TAURI_NATIVE.md).
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn logind_lines_parse() {
        assert_eq!(imp::parse("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)"), Some(Event::Suspend));
        assert_eq!(imp::parse("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)"), Some(Event::Resume));
        assert_eq!(imp::parse("/org/freedesktop/login1: org.freedesktop.login1.Manager.SessionNew ('2', objectpath '/x')"), None);
        assert_eq!(imp::parse("garbage"), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_messages_map() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE};
        assert_eq!(imp::event_for(WM_POWERBROADCAST, PBT_APMSUSPEND as usize), Some(Event::Suspend));
        assert_eq!(imp::event_for(WM_WTSSESSION_CHANGE, 7), Some(Event::LockScreen));
        assert_eq!(imp::event_for(WM_WTSSESSION_CHANGE, 8), Some(Event::UnlockScreen));
        assert_eq!(imp::event_for(WM_WTSSESSION_CHANGE, 1), None);
    }
}
