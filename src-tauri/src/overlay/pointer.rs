//! The pointer poll as a state machine, with no clock, window or thread in it (the thread is
//! overlay.rs's). Tauri passes a click-through window no mouse event at all, so Rust reads the pointer
//! and tells her page. This decides, tick by tick, what to tell and when to look next.
//!
//! Three things come out of a tick:
//! * `core`: the pointer for the core (platform.screens.cursor(), which is synchronous there). Moves are
//!   passed on at most every `core_every_ms`, the last one of a move always follows, and a still
//!   pointer is repeated once a second (the core's `follow` and `overlay:cursor` read it).
//! * `page`: what her page hears. A synthetic `mousemove` at the pointer's place in the window (CSS
//!   px) while the pointer is over the window, a `mouseleave` when it goes out. Not while a mouse
//!   button is down: then the page gets the real events (a drag), and an extra sample taken at
//!   another time would pollute the throw's velocity.
//! * `next_ms`: when to look again. Fast while the pointer moves and for a while after; slower while
//!   it rests, slower still while it is away from her window.
//!
//! `HitGate` is the click-through switch: the page's hit test asks for it through the core, and a
//! request to let clicks through is held while a button is down (a drag must never lose its window
//! because the pointer outran her).

use super::geometry::Rect;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    /// moving, and for `settle_ms` after
    pub fast_ms: u64,
    /// resting over her window
    pub rest_ms: u64,
    /// resting, or moving, away from her window: it is the entering that has to be noticed
    pub away_ms: u64,
    pub settle_ms: u64,
    pub core_every_ms: u64,
    pub heartbeat_ms: u64,
}

impl Timing {
    /// 25 Hz while it matters. Linux: 50 ms (the Electron build's hit-testing period there).
    pub const DEFAULT: Timing = Timing { fast_ms: 40, rest_ms: 80, away_ms: 120, settle_ms: 1500, core_every_ms: 100, heartbeat_ms: 1000 };
    pub const LINUX: Timing = Timing { fast_ms: 50, rest_ms: 80, away_ms: 120, settle_ms: 1500, core_every_ms: 50, heartbeat_ms: 1000 };
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Page {
    None,
    /// a mousemove at these CSS px, relative to the window
    Move(f64, f64),
    Leave,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Out {
    pub core: Option<(f64, f64)>,
    pub page: Page,
    pub next_ms: u64,
}

pub struct Poller {
    timing: Timing,
    last: Option<(f64, f64)>,
    last_move_ms: Option<u64>,
    last_core_ms: Option<u64>,
    core_pending: bool,
    page_inside: bool,
}

impl Poller {
    pub fn new(timing: Timing) -> Self {
        Poller { timing, last: None, last_move_ms: None, last_core_ms: None, core_pending: false, page_inside: false }
    }

    /// `nudge`: the window moved, or her page just loaded: tell the page where the pointer is even though it did not move.
    pub fn tick(&mut self, now_ms: u64, cursor: Option<(f64, f64)>, win: Rect, button_down: bool, nudge: bool) -> Out {
        let Some((x, y)) = cursor else {
            return Out { core: None, page: Page::None, next_ms: self.timing.away_ms };
        };
        let moved = match self.last {
            Some((lx, ly)) => (lx - x).abs() > 0.01 || (ly - y).abs() > 0.01,
            None => true,
        };
        self.last = Some((x, y));
        if moved {
            self.last_move_ms = Some(now_ms);
            self.core_pending = true;
        }

        let due = |last: Option<u64>, every: u64| last.map_or(true, |t| now_ms.saturating_sub(t) >= every);
        let core = if (self.core_pending && due(self.last_core_ms, self.timing.core_every_ms)) || due(self.last_core_ms, self.timing.heartbeat_ms) {
            self.last_core_ms = Some(now_ms);
            self.core_pending = false;
            Some((x, y))
        } else {
            None
        };

        let inside = win.contains(x, y);
        let page = if inside {
            if !button_down && (moved || nudge || !self.page_inside) {
                self.page_inside = true;
                Page::Move(x - win.x, y - win.y)
            } else {
                Page::None
            }
        } else if self.page_inside {
            self.page_inside = false;
            Page::Leave
        } else {
            Page::None
        };

        let recently = self.last_move_ms.map_or(false, |t| now_ms.saturating_sub(t) < self.timing.settle_ms);
        let next_ms = if recently || button_down {
            self.timing.fast_ms
        } else if inside {
            self.timing.rest_ms
        } else {
            self.timing.away_ms
        };
        Out { core, page, next_ms }
    }
}

/// The click-through switch (`ignoring` = clicks go to the apps below).
#[derive(Debug)]
pub struct HitGate {
    ignoring: bool,
    held: bool,
}

impl HitGate {
    pub fn new() -> Self {
        HitGate { ignoring: true, held: false }
    }
    pub fn ignoring(&self) -> bool {
        self.ignoring
    }
    /// The core asks for click-through on or off. Returns what to apply to the window now, if anything.
    /// A window that takes clicks and is asked to let them through while a button is down keeps taking them
    /// until the button is up (`release` then does it).
    pub fn request(&mut self, ignore: bool, button_down: bool) -> Option<bool> {
        if ignore && !self.ignoring && button_down {
            self.held = true;
            return None;
        }
        self.held = false;
        self.ignoring = ignore;
        Some(ignore)
    }
    /// Called every tick: the held request, once no button is down.
    pub fn release(&mut self, button_down: bool) -> Option<bool> {
        if self.held && !button_down {
            self.held = false;
            self.ignoring = true;
            return Some(true);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: Rect = Rect { x: 100.0, y: 50.0, width: 800.0, height: 600.0 };
    fn poller() -> Poller {
        Poller::new(Timing::DEFAULT)
    }

    #[test]
    fn moving_over_the_window_tells_the_page_in_css_px_and_keeps_the_fast_rate() {
        let mut p = poller();
        let o = p.tick(0, Some((300.0, 200.0)), WIN, false, false);
        assert_eq!(o.page, Page::Move(200.0, 150.0));
        assert_eq!(o.next_ms, 40);
        let o = p.tick(40, Some((310.0, 200.0)), WIN, false, false);
        assert_eq!(o.page, Page::Move(210.0, 150.0));
    }

    #[test]
    fn a_resting_pointer_costs_nothing_and_slows_the_poll_after_the_settle_time() {
        let mut p = poller();
        p.tick(0, Some((300.0, 200.0)), WIN, false, false);
        let o = p.tick(40, Some((300.0, 200.0)), WIN, false, false);
        assert_eq!((o.page, o.next_ms), (Page::None, 40)); // still settling
        let o = p.tick(1600, Some((300.0, 200.0)), WIN, false, false);
        assert_eq!((o.page, o.next_ms), (Page::None, 80));
        // it starts to move again: back to fast at once
        let o = p.tick(1680, Some((301.0, 200.0)), WIN, false, false);
        assert_eq!(o.page, Page::Move(201.0, 150.0));
        assert_eq!(o.next_ms, 40);
    }

    #[test]
    fn away_from_the_window_it_is_slow_and_leaving_is_said_once() {
        let mut p = poller();
        p.tick(0, Some((300.0, 200.0)), WIN, false, false);
        let o = p.tick(40, Some((20.0, 20.0)), WIN, false, false);
        assert_eq!(o.page, Page::Leave);
        let o = p.tick(80, Some((21.0, 20.0)), WIN, false, false);
        assert_eq!(o.page, Page::None);
        let o = p.tick(2000, Some((21.0, 20.0)), WIN, false, false);
        assert_eq!((o.page, o.next_ms), (Page::None, 120));
        // coming back in is heard at once
        let o = p.tick(2120, Some((150.0, 80.0)), WIN, false, false);
        assert_eq!(o.page, Page::Move(50.0, 30.0));
    }

    #[test]
    fn a_pointer_that_starts_outside_never_gets_a_leave() {
        let mut p = poller();
        assert_eq!(p.tick(0, Some((5.0, 5.0)), WIN, false, true).page, Page::None);
    }

    #[test]
    fn while_a_button_is_down_the_page_hears_nothing_from_here() {
        let mut p = poller();
        p.tick(0, Some((300.0, 200.0)), WIN, false, false);
        let o = p.tick(40, Some((400.0, 260.0)), WIN, true, false);
        assert_eq!((o.page, o.next_ms), (Page::None, 40));
        // the button is up and the pointer did not move since: the page has the real events, nothing more
        let o = p.tick(80, Some((400.0, 260.0)), WIN, false, false);
        assert_eq!(o.page, Page::None);
    }

    #[test]
    fn entering_the_window_with_a_button_down_is_told_after_the_release() {
        let mut p = poller();
        p.tick(0, Some((5.0, 5.0)), WIN, false, false);
        assert_eq!(p.tick(40, Some((200.0, 100.0)), WIN, true, false).page, Page::None);
        assert_eq!(p.tick(80, Some((200.0, 100.0)), WIN, false, false).page, Page::Move(100.0, 50.0));
    }

    #[test]
    fn a_nudge_says_where_a_still_pointer_is() {
        let mut p = poller();
        p.tick(0, Some((300.0, 200.0)), WIN, false, false);
        // the window moved 50 px right under a still pointer
        let moved = Rect { x: 150.0, ..WIN };
        let o = p.tick(40, Some((300.0, 200.0)), moved, false, true);
        assert_eq!(o.page, Page::Move(150.0, 150.0));
    }

    #[test]
    fn the_core_hears_moves_at_most_every_100ms_the_last_move_always_and_a_rest_once_a_second() {
        let mut p = poller();
        assert_eq!(p.tick(0, Some((1.0, 1.0)), WIN, false, false).core, Some((1.0, 1.0)));
        assert_eq!(p.tick(40, Some((2.0, 1.0)), WIN, false, false).core, None);
        assert_eq!(p.tick(80, Some((3.0, 1.0)), WIN, false, false).core, None);
        assert_eq!(p.tick(120, Some((4.0, 1.0)), WIN, false, false).core, Some((4.0, 1.0)));
        // stops at 5: the last position follows once the period is over
        assert_eq!(p.tick(160, Some((5.0, 1.0)), WIN, false, false).core, None);
        assert_eq!(p.tick(240, Some((5.0, 1.0)), WIN, false, false).core, Some((5.0, 1.0)));
        // then silence, but for the heartbeat
        assert_eq!(p.tick(500, Some((5.0, 1.0)), WIN, false, false).core, None);
        assert_eq!(p.tick(1300, Some((5.0, 1.0)), WIN, false, false).core, Some((5.0, 1.0)));
    }

    #[test]
    fn no_pointer_reading_is_slow_and_silent() {
        let mut p = poller();
        let o = p.tick(0, None, WIN, false, false);
        assert_eq!((o.core, o.page, o.next_ms), (None, Page::None, 120));
    }

    #[test]
    fn linux_looks_every_50ms() {
        let mut p = Poller::new(Timing::LINUX);
        assert_eq!(p.tick(0, Some((300.0, 200.0)), WIN, false, false).next_ms, 50);
    }

    #[test]
    fn a_drag_keeps_its_window_even_when_asked_to_let_clicks_through() {
        let mut g = HitGate::new();
        assert_eq!(g.request(false, false), Some(false)); // she is hit: the window takes clicks
        assert!(!g.ignoring());
        // button down (dragging), the page's hit test lets go for a moment: held
        assert_eq!(g.request(true, true), None);
        assert!(!g.ignoring());
        assert_eq!(g.release(true), None);
        // the button is up: now it lets them through
        assert_eq!(g.release(false), Some(true));
        assert!(g.ignoring());
        assert_eq!(g.release(false), None);
    }

    #[test]
    fn a_held_request_is_dropped_when_the_page_wants_the_window_again() {
        let mut g = HitGate::new();
        g.request(false, false);
        assert_eq!(g.request(true, true), None);
        assert_eq!(g.request(false, true), Some(false));
        assert_eq!(g.release(false), None);
        assert!(!g.ignoring());
    }

    #[test]
    fn click_through_on_with_no_button_is_immediate_and_a_rearm_pair_is_both_applied() {
        let mut g = HitGate::new();
        assert_eq!(g.request(false, false), Some(false));
        assert_eq!(g.request(true, false), Some(true));
        assert_eq!(g.request(true, false), Some(true));
    }
}
