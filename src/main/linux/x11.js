'use strict';

// Linux X11 window tracking, the pure half: what `xprop` and `xwininfo` (x11-utils) print, turned
// into the same snapshot the Windows helper sends (windows.ps1). No X connection here, so it is
// tested on recorded output; x11-watch.js runs the tools.
//
// EWMH gives what we need from the window manager: the window in front (_NET_ACTIVE_WINDOW), the
// managed windows bottom to top (_NET_CLIENT_LIST_STACKING), the workspace shown, and per window
// its type, state, workspace and frame. Geometry comes from one `xwininfo -root -tree`.

// What the watcher asks xprop, on the root window and on each managed window.
const ROOT_PROPS = ['_NET_ACTIVE_WINDOW', '_NET_CLIENT_LIST_STACKING', '_NET_CURRENT_DESKTOP'];
const WINDOW_PROPS = ['_NET_WM_WINDOW_TYPE', '_NET_WM_STATE', '_NET_WM_DESKTOP', '_NET_FRAME_EXTENTS', '_GTK_FRAME_EXTENTS', '_NET_WM_PID'];

const ALL_DESKTOPS = 0xFFFFFFFF; // _NET_WM_DESKTOP of a window shown on every workspace
const MAX_WINDOWS = 40;          // as many as the Windows helper sends
const MIN_W = 200;               // smaller ones are no seat (same as Windows)
const MIN_H = 120;

// Window types she may sit on. A window without a type is a normal one (EWMH). Desktop, dock,
// menus, tooltips, notifications, splash screens, toolbars and utility palettes are left out.
const SEATS = new Set(['NORMAL', 'DIALOG']);

// "0x3a00007" -> 60817415; anything else -> null
function xid(text) {
  const m = /^0x([0-9a-f]+)$/i.exec(String(text).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return n > 0 ? n : null;
}

// xprop's output, with or without -notype, as { NAME: string[] | null } (null: not set).
//   _NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007
//   _NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1e00004, 0x3a00007
//   _NET_FRAME_EXTENTS(CARDINAL) = 1, 1, 37, 1
//   _NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ
//   _NET_WM_STATE(ATOM) =
//   _GTK_FRAME_EXTENTS:  not found.
function parseXprop(text) {
  const props = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const m = /^([A-Z0-9_]+)(?:\([^)]*\))?\s*(?::\s*window id #\s*|=\s*|:\s*)(.*)$/i.exec(line);
    if (!m) continue;
    const [, name, rest] = m;
    if (/^not found\.?$/i.test(rest) || /^no such atom/i.test(rest)) {
      props[name] = null;
      continue;
    }
    props[name] = rest.trim() === '' ? [] : rest.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return props;
}

const numbers = (values) => (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n));

// The root window: which window is in front, the managed ones top first, the workspace shown.
// Without _NET_CLIENT_LIST_STACKING the window manager is not EWMH (or there is none): null.
function parseRoot(text) {
  const p = parseXprop(text);
  if (!Array.isArray(p._NET_CLIENT_LIST_STACKING)) return null;
  const desktop = numbers(p._NET_CURRENT_DESKTOP)[0];
  return {
    active: p._NET_ACTIVE_WINDOW ? xid(p._NET_ACTIVE_WINDOW[0]) : null,
    stacking: p._NET_CLIENT_LIST_STACKING.map(xid).filter(Boolean).reverse(), // EWMH: bottom to top
    desktop: Number.isFinite(desktop) ? desktop : null,
  };
}

// One managed window's properties, as what decides whether she can sit on it.
function parseWindow(text) {
  const p = parseXprop(text);
  const atoms = (name, prefix) => (p[name] || []).map((a) => a.replace(prefix, ''));
  // EWMH: the types in order of preference, the first one the window manager knows wins, so
  // vendor types listed first (Qt's _KDE_NET_WM_WINDOW_TYPE_OVERRIDE) are skipped
  const types = (p._NET_WM_WINDOW_TYPE || []).filter((a) => a.startsWith('_NET_WM_WINDOW_TYPE_'));
  const extents = (name) => {
    const [left, right, top, bottom] = numbers(p[name]);
    return [left, right, top, bottom].every(Number.isFinite) ? { left, right, top, bottom } : null;
  };
  const desktop = numbers(p._NET_WM_DESKTOP)[0];
  const pid = numbers(p._NET_WM_PID)[0];
  return {
    types: types.map((a) => a.replace(/^_NET_WM_WINDOW_TYPE_/, '')),
    state: atoms('_NET_WM_STATE', /^_NET_WM_STATE_/),
    desktop: Number.isFinite(desktop) ? desktop : null,
    frame: extents('_NET_FRAME_EXTENTS'), // the window manager's decorations around it
    csd: extents('_GTK_FRAME_EXTENTS'),   // a GTK window's own shadow, inside it
    pid: Number.isFinite(pid) ? pid : null,
  };
}

// `xwininfo -root -tree`: every window's absolute position and size, by id. Names may hold
// anything, so a line is read from its end: "  800x600+0+0  +100+50" (the last pair is absolute).
//      0x1e00004 "Terminal": ("gnome-terminal-server" "Gnome-terminal")  800x600+0+0  +100+50
function parseTree(text) {
  const rects = new Map();
  const re = /^\s*(0x[0-9a-f]+)\b.*?\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+([+-]-?\d+)([+-]-?\d+)\s*$/i;
  const coord = (s) => (s.startsWith('+') ? Number(s.slice(1)) : Number(s));
  for (const line of String(text).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const id = xid(m[1]);
    if (id) rects.set(id, { x: coord(m[4]), y: coord(m[5]), w: Number(m[2]), h: Number(m[3]) });
  }
  return rects;
}

// The window as one sees it: with the window manager's frame (title bar included, where she sits),
// without the transparent shadow a GTK window draws around itself.
function outerRect(rect, info) {
  let { x, y, w, h } = rect;
  const f = info.frame;
  if (f) {
    x -= f.left; y -= f.top; w += f.left + f.right; h += f.top + f.bottom;
  }
  const c = info.csd;
  if (c) {
    x += c.left; y += c.top; w -= c.left + c.right; h -= c.top + c.bottom;
  }
  return { x, y, w, h };
}

const typeOf = (info) => (info.types.length ? info.types[0] : 'NORMAL');

// Can she sit on it: a normal window or dialog, shown (not minimized), on the workspace in view,
// listed in the taskbar. Her other windows (the demo terminal, test windows) are seats, as on
// Windows: only the overlay is left out, by id (buildSnapshot), and it skips the taskbar anyway.
function isSeat(info, { desktop }) {
  if (!SEATS.has(typeOf(info))) return false;
  if (info.state.includes('HIDDEN') || info.state.includes('SKIP_TASKBAR')) return false;
  const onDesktop = info.desktop == null || desktop == null || info.desktop === ALL_DESKTOPS
    || info.desktop === desktop || info.state.includes('STICKY');
  return onDesktop;
}

// The snapshot, in the Windows helper's format (physical pixels of the X screen, front first):
//   { fg, taskbar, ai, game, usb, plug, wins: [{ id, x, y, w, h, max }] }
// `infos`: id -> parseWindow(); `rects`: parseTree(); `self`: { id } of Capri's overlay.
// What only Windows reports (other AIs in front, games, USB sticks) stays empty.
function buildSnapshot({ root, infos, rects, self = {} }) {
  const wins = [];
  for (const id of root.stacking) {
    if (wins.length >= MAX_WINDOWS) break;
    if (id === self.id) continue;
    const info = infos.get(id);
    const rect = rects.get(id);
    if (!info || !rect || !isSeat(info, { desktop: root.desktop })) continue;
    const r = outerRect(rect, info);
    if (r.w < MIN_W || r.h < MIN_H) continue;
    const max = info.state.includes('FULLSCREEN')
      || (info.state.includes('MAXIMIZED_VERT') && info.state.includes('MAXIMIZED_HORZ'));
    wins.push({ id, x: r.x, y: r.y, w: r.w, h: r.h, max });
  }
  const front = root.active ? infos.get(root.active) : null;
  return {
    fg: root.active || 0,
    // a panel clicked comes up in front (Windows: the taskbar), she gets back over it
    taskbar: Boolean(front && typeOf(front) === 'DOCK'),
    ai: [], game: null, usb: [], plug: null,
    wins,
  };
}

// X11 pixels -> DIPs. The toolkit on X11 scales the whole X screen by the display's factor;
// each display's DIP bounds times its scaleFactor are its pixels. The display holding the rect's
// centre (or the first one) converts it.
function pxToDip(rect, displays) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const px = (d) => {
    const s = d.scaleFactor || 1;
    return { x: d.bounds.x * s, y: d.bounds.y * s, w: d.bounds.width * s, h: d.bounds.height * s, s };
  };
  const list = (displays || []).filter((d) => d && d.bounds);
  if (!list.length) return { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
  const d = list.find((it) => {
    const p = px(it);
    return cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h;
  }) || list[0];
  const p = px(d);
  return {
    x: d.bounds.x + (rect.x - p.x) / p.s,
    y: d.bounds.y + (rect.y - p.y) / p.s,
    width: rect.w / p.s,
    height: rect.h / p.s,
  };
}

// The overlay's X window id, from the window's native handle (an XID in an unsigned long).
function selfXid(handle) {
  if (!handle || !handle.length) return null;
  const n = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
  return n > 0 ? n : null;
}

module.exports = {
  ROOT_PROPS, WINDOW_PROPS, ALL_DESKTOPS,
  xid, parseXprop, parseRoot, parseWindow, parseTree, outerRect, isSeat, buildSnapshot, pxToDip, selfXid,
};
