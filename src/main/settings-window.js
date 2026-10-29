'use strict';

// Her settings window: an ordinary window, apart from the overlay (made and kept by Rust,
// src-tauri/src/settings_window.rs; the controller is platform/sidecar.js). What both sides share
// is its size: 720x540 (min 480x360), centered in the work area.

const WIDTH = 720;
const HEIGHT = 540;
// the page colour of settings.css (--cp-yellow), so the window doesn't flash another colour while it loads
const BACKGROUND = '#fcee0a';

// the window's rectangle: its size, centered in the work area `a` ({ x, y, width, height }) when there is one
function settingsBounds(a) {
  if (!a) return { width: WIDTH, height: HEIGHT };
  const width = Math.min(WIDTH, a.width);
  const height = Math.min(HEIGHT, a.height);
  return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
}

module.exports = { settingsBounds, WIDTH, HEIGHT, BACKGROUND };
