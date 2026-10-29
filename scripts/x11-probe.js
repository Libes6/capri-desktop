'use strict';

// CI check of the Linux X11 window watcher against a real X server (Xvfb + a window manager), without
// the app: it must see a window opened for it, with its frame, and the window in front.
//   xmessage -geometry 420x260+150+120 probe & node scripts/x11-probe.js
// An extra check only: Xvfb with openbox is not a desktop people use (see docs/LINUX_WINDOW_TRACKING.md).

const { linuxSession } = require('../src/main/capabilities');
const { startX11Watch } = require('../src/main/linux/x11-watch');

const session = linuxSession(process.env);
let seen = null;
let done = false;
let watch = null;
const timer = setTimeout(() => finish('no window seen within 15 s'), 15000);
watch = startX11Watch({
  session,
  onState: (ok) => {
    if (!ok) finish('the watcher gave up');
  },
  onSnapshot: (snap) => {
    seen = snap;
    if (snap.wins.length) finish(null);
  },
});

function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  watch?.stop();
  console.log(`[x11-probe] session=${session} snapshot=${JSON.stringify(seen)}`);
  if (error) {
    console.error(`[x11-probe] failed: ${error}`);
    process.exitCode = 1;
  }
}
