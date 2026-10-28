#!/usr/bin/env bash
# Runs the release spike inside a virtual X11 desktop and leaves spike.log + screenshot.png in the cwd
# (spike/tauri-overlay/src-tauri). Used by .github/workflows/tauri-spike.yml.
set -u
BIN="$PWD/target/release/capri-overlay-spike"
export GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 SPIKE_EXIT_AFTER=30
xvfb-run -a -s "-screen 0 1920x1080x24 +extension Composite +extension RANDR" bash -c '
  openbox >/dev/null 2>&1 &
  picom --backend xrender >/dev/null 2>&1 &
  sleep 2
  "'"$BIN"'" > spike.log 2>&1 &
  APP=$!
  sleep 10
  # the character stands near the bottom-right corner (www/main.js): aim at her body, screenshot, then empty desktop
  xdotool mousemove 1734 881
  sleep 1
  import -window root screenshot.png
  xdotool mousemove 100 100
  sleep 1
  wait $APP
'
cat spike.log
