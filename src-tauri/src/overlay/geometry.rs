//! Pure geometry of the overlay: what a monitor list means in the core's DIP space, ids that survive
//! a monitor coming and going, and the way back from DIPs to the physical pixels Windows and Linux
//! windows are placed in. No Tauri in here, so the whole of it is unit-tested.
//!
//! The core thinks in DIPs (Electron's unit): macOS points, Windows / Linux device-independent pixels.
//! Tauri hands monitors out in physical pixels with a scale factor each. The DIP space made here is
//! self-consistent: a monitor's DIP origin is its physical origin divided by its own scale, and
//! every conversion (a point on the way in, the window's rectangle on the way out) goes through the
//! monitor it lands on. With one scale for all monitors (always the case on macOS, where Tauri's
//! positions are points times the scale already) it is exactly Electron's. With mixed scales on
//! Windows it is consistent but not byte-identical to Chromium's layout (see docs/TAURI_SPIKE.md).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// One monitor as Tauri reports it: physical pixels and a scale factor.
#[derive(Debug, Clone, PartialEq)]
pub struct Mon {
    pub name: String,
    pub pos: (i32, i32),
    pub size: (u32, u32),
    pub work_pos: (i32, i32),
    pub work_size: (u32, u32),
    pub scale: f64,
}

impl Mon {
    /// The monitor's DIP bounds.
    pub fn bounds(&self) -> Rect {
        let f = self.scale.max(0.01);
        Rect { x: (self.pos.0 as f64 / f).round(), y: (self.pos.1 as f64 / f).round(), width: (self.size.0 as f64 / f).round(), height: (self.size.1 as f64 / f).round() }
    }
    pub fn work_area(&self) -> Rect {
        let f = self.scale.max(0.01);
        Rect {
            x: (self.work_pos.0 as f64 / f).round(),
            y: (self.work_pos.1 as f64 / f).round(),
            width: (self.work_size.0 as f64 / f).round(),
            height: (self.work_size.1 as f64 / f).round(),
        }
    }
    fn phys_contains(&self, x: f64, y: f64) -> bool {
        x >= self.pos.0 as f64 && y >= self.pos.1 as f64 && x < (self.pos.0 as f64 + self.size.0 as f64) && y < (self.pos.1 as f64 + self.size.1 as f64)
    }
    fn dip_contains(&self, x: f64, y: f64) -> bool {
        self.bounds().contains(x, y)
    }
}

/// The primary monitor: the one at the origin (macOS' menu-bar screen and Windows' primary always are),
/// else the first.
pub fn primary_index(mons: &[Mon]) -> usize {
    mons.iter().position(|m| m.pos == (0, 0)).unwrap_or(0)
}

fn fnv(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Ids that stay when another monitor is plugged in or taken out (positions in a list would shift):
/// a hash of the monitor's name, and for monitors that share a name (two of the same model) the order
/// from left to right, then top to bottom. Never 0, and below 2^31 so the core can compute with them
/// (`id * 10 + i` in its two-halves dev mode).
pub fn stable_ids(mons: &[Mon]) -> Vec<u32> {
    let mut order: Vec<usize> = (0..mons.len()).collect();
    order.sort_by_key(|&i| (mons[i].pos.0, mons[i].pos.1));
    let mut ids = vec![0u32; mons.len()];
    let mut seen: Vec<(String, u32)> = Vec::new();
    for i in order {
        let name = mons[i].name.clone();
        let nth = match seen.iter_mut().find(|(n, _)| *n == name) {
            Some((_, c)) => {
                *c += 1;
                *c
            }
            None => {
                seen.push((name.clone(), 0));
                0
            }
        };
        ids[i] = ((fnv(&name) % 100_000) + 1 + nth * 100_000) % 200_000_000 + 1;
    }
    ids
}

/// The core's `Display` list (platform.screens.all()), with `primary` set on one.
pub fn screens_json(mons: &[Mon]) -> Value {
    let ids = stable_ids(mons);
    let primary = primary_index(mons);
    let list: Vec<Value> = mons
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let b = m.bounds();
            json!({
                "id": ids[i],
                "scaleFactor": m.scale,
                "primary": i == primary,
                "bounds": b,
                "workArea": m.work_area(),
                "size": {"width": b.width, "height": b.height},
            })
        })
        .collect();
    json!({ "list": list })
}

/// A physical point (screen pixels) to DIPs (Windows and Linux; macOS reads points already), through the monitor it is on (else the nearest one).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn point_to_dip(x: f64, y: f64, mons: &[Mon]) -> (f64, f64) {
    let Some(m) = monitor_for_point(x, y, mons) else { return (x, y) };
    let f = m.scale.max(0.01);
    (x / f, y / f)
}

fn monitor_for_point(x: f64, y: f64, mons: &[Mon]) -> Option<&Mon> {
    if let Some(m) = mons.iter().find(|m| m.phys_contains(x, y)) {
        return Some(m);
    }
    let dist = |m: &Mon| {
        let dx = (m.pos.0 as f64 - x).max(0.0).max(x - (m.pos.0 as f64 + m.size.0 as f64 - 1.0));
        let dy = (m.pos.1 as f64 - y).max(0.0).max(y - (m.pos.1 as f64 + m.size.1 as f64 - 1.0));
        dx * dx + dy * dy
    };
    mons.iter().min_by(|a, b| dist(a).partial_cmp(&dist(b)).unwrap_or(std::cmp::Ordering::Equal))
}

/// A window rectangle in physical pixels (where it is) to DIPs. Which monitor it is on is decided by
/// its centre.
pub fn rect_from_physical(pos: (i32, i32), size: (u32, u32), mons: &[Mon]) -> Rect {
    let (cx, cy) = (pos.0 as f64 + size.0 as f64 / 2.0, pos.1 as f64 + size.1 as f64 / 2.0);
    let f = monitor_for_point(cx, cy, mons).map(|m| m.scale).unwrap_or(1.0).max(0.01);
    Rect { x: pos.0 as f64 / f, y: pos.1 as f64 / f, width: size.0 as f64 / f, height: size.1 as f64 / f }
}

/// A DIP rectangle (what the core asks for) to the physical position and size to give the window: the
/// monitor is the one whose DIP bounds hold the rectangle's centre, its scale does the rest.
pub fn rect_to_physical(r: Rect, mons: &[Mon]) -> ((i32, i32), (u32, u32)) {
    let (cx, cy) = (r.x + r.width / 2.0, r.y + r.height / 2.0);
    let m = mons.iter().find(|m| m.dip_contains(cx, cy)).or_else(|| mons.get(primary_index(mons)));
    let f = m.map(|m| m.scale).unwrap_or(1.0).max(0.01);
    (((r.x * f).round() as i32, (r.y * f).round() as i32), ((r.width * f).round().max(1.0) as u32, (r.height * f).round().max(1.0) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(name: &str, x: i32, y: i32, w: u32, h: u32, scale: f64) -> Mon {
        Mon { name: name.into(), pos: (x, y), size: (w, h), work_pos: (x, y + (24.0 * scale) as i32), work_size: (w, h - (24.0 * scale) as u32), scale }
    }

    #[test]
    fn one_retina_screen_is_in_points() {
        let m = mon("Built-in", 0, 0, 2560, 1664, 2.0);
        assert_eq!(m.bounds(), Rect { x: 0.0, y: 0.0, width: 1280.0, height: 832.0 });
        assert_eq!(m.work_area(), Rect { x: 0.0, y: 24.0, width: 1280.0, height: 808.0 });
    }

    #[test]
    fn macos_positions_are_points_times_each_monitors_own_scale() {
        // tao: a screen right of the retina one starts at 1280 pt; on a 1x screen that is 1280 "pixels",
        // on a second retina screen 2560. Divided by its own scale either way it is 1280 pt.
        let a = mon("Built-in", 0, 0, 2560, 1664, 2.0);
        let plain = mon("DELL", 1280, 0, 1920, 1080, 1.0);
        let retina = mon("Studio", 2560, 0, 5120, 2880, 2.0);
        assert_eq!(plain.bounds(), Rect { x: 1280.0, y: 0.0, width: 1920.0, height: 1080.0 });
        assert_eq!(retina.bounds(), Rect { x: 1280.0, y: 0.0, width: 2560.0, height: 1440.0 });
        // a screen to the left and above, in negative points
        let left = mon("Side", -1920, -1080, 1920, 1080, 1.0);
        assert_eq!(left.bounds().x, -1920.0);
        assert_eq!(primary_index(&[left, a]), 1);
    }

    #[test]
    fn primary_is_the_one_at_the_origin_whatever_the_order() {
        let a = mon("Side", -1920, 0, 1920, 1080, 1.0);
        let b = mon("Main", 0, 0, 2560, 1440, 1.0);
        assert_eq!(primary_index(&[a.clone(), b.clone()]), 1);
        let json = screens_json(&[a, b]);
        assert_eq!(json["list"][0]["primary"], false);
        assert_eq!(json["list"][1]["primary"], true);
        assert_eq!(json["list"][0]["bounds"]["x"], -1920.0);
    }

    #[test]
    fn ids_are_stable_when_a_monitor_comes_and_goes_and_distinct_for_twins() {
        let a = mon("Built-in", 0, 0, 2560, 1664, 2.0);
        let b = mon("LG", 1280, 0, 1920, 1080, 1.0);
        let c = mon("LG", 3200, 0, 1920, 1080, 1.0);
        let all = stable_ids(&[a.clone(), b.clone(), c.clone()]);
        assert_eq!(all.iter().collect::<std::collections::HashSet<_>>().len(), 3);
        // the second LG goes away, the first keeps its id; the built-in screen too
        let without = stable_ids(&[a.clone(), b.clone()]);
        assert_eq!(without, vec![all[0], all[1]]);
        // listed in another order, the same monitors have the same ids
        let shuffled = stable_ids(&[c, a, b]);
        assert_eq!(shuffled[0], all[2]);
        assert_eq!(shuffled[1], all[0]);
        assert!(all.iter().all(|&i| i > 0 && i < 1_000_000_000));
    }

    #[test]
    fn mixed_dpi_round_trips_through_the_monitor_it_lands_on() {
        // Windows: a 150% laptop screen and a 100% monitor to its right, physical pixels
        let a = mon("Laptop", 0, 0, 2880, 1800, 1.5);
        let b = mon("Dell", 2880, 0, 1920, 1080, 1.0);
        let all = [a, b];
        // her window covers the Dell: 1920x1056 DIPs at its DIP origin
        let want = Rect { x: 2880.0, y: 0.0, width: 1920.0, height: 1056.0 };
        let (pos, size) = rect_to_physical(want, &all);
        assert_eq!((pos, size), ((2880, 0), (1920, 1056)));
        assert_eq!(rect_from_physical(pos, size, &all), want);
        // and over the laptop screen: 1920 x 1152 DIPs = 2880 x 1728 physical
        let laptop = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1152.0 };
        let (pos, size) = rect_to_physical(laptop, &all);
        assert_eq!((pos, size), ((0, 0), (2880, 1728)));
        assert_eq!(rect_from_physical(pos, size, &all), laptop);
        // the cursor on each
        assert_eq!(point_to_dip(300.0, 150.0, &all), (200.0, 100.0));
        assert_eq!(point_to_dip(3000.0, 100.0, &all), (3000.0, 100.0));
    }

    #[test]
    fn a_point_outside_every_monitor_goes_to_the_nearest() {
        let a = mon("A", 0, 0, 1000, 1000, 2.0);
        let b = mon("B", 1000, 0, 1000, 1000, 1.0);
        // far right of b: still b's scale
        assert_eq!(point_to_dip(5000.0, 10.0, &[a.clone(), b.clone()]), (5000.0, 10.0));
        // above a
        assert_eq!(point_to_dip(100.0, -50.0, &[a, b]), (50.0, -25.0));
    }

    #[test]
    fn no_monitor_is_not_a_crash() {
        assert_eq!(point_to_dip(3.0, 4.0, &[]), (3.0, 4.0));
        let (pos, size) = rect_to_physical(Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 }, &[]);
        assert_eq!((pos, size), ((1, 2), (3, 4)));
        assert_eq!(screens_json(&[])["list"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn screens_json_has_what_the_core_reads() {
        let j = screens_json(&[mon("Built-in", 0, 0, 2560, 1664, 2.0)]);
        let d = &j["list"][0];
        assert_eq!(d["scaleFactor"], 2.0);
        assert_eq!(d["size"]["width"], 1280.0);
        assert_eq!(d["workArea"]["y"], 24.0);
        assert!(d["id"].as_u64().unwrap() > 0);
    }
}
