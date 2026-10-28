// TAURI-00 spike page: the real WebGL cut-out (sprite.js, copied unchanged) at 12 fps, a drag, and the
// alpha-mask hit test that answers Rust's cursor events.
import { SpriteRenderer, SPRITE } from './sprite.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const log = (msg) => invoke('log', { msg: String(msg) }).catch(() => {});

const SCALE = 0.6;
const FPS = 12;
const INK = [0.08, 0.06, 0.11];

const loadImage = (src) => new Promise((ok, no) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = () => no(new Error(`cannot load ${src}`));
  img.src = src;
});

// The silhouette at rest (alpha) plus the mirrored right arm the shader adds: same as Capri.buildAlphaMap.
function buildAlphaMap(image) {
  const { width: w, height: h, mirror } = SPRITE;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!SPRITE.armL(x, y) || mirror - x >= w) continue;
      const to = (y * w + mirror - x) * 4 + 3;
      data[to] = Math.max(data[to], data[(y * w + x) * 4 + 3]);
    }
  }
  return data;
}

async function main() {
  const image = await loadImage('capri-full.png');
  const root = document.getElementById('capri');
  const canvas = document.getElementById('sprite');
  let sprite;
  try {
    sprite = new SpriteRenderer(canvas, image);
  } catch (err) {
    log(`AUTOTEST webgl=FAIL ${err.message}`);
    return;
  }
  sprite.resize(SCALE);
  const alpha = buildAlphaMap(image);

  const p = {
    seed: 0, boil: 0.9, hair: 0, head: 0, mane: 0, armL: 0, armR: 0, longL: 1, longR: 1, sit: 0, kickL: 0, kickR: 0,
    smear: [0, 0], echo: [0, 0],
    glitch: 0, glitchSeed: 0, split: 0, collapse: 0, dissolve: 0, sparkle: 1, grade: 1,
    sil: INK, silAmount: 0, misreg: [-2.6, 2.2], alpha: 1,
  };

  const { width: cw, height: ch } = SpriteRenderer.cssSize(SCALE);
  const pos = { x: innerWidth - cw - 80, y: innerHeight - ch - 40 }; // top-left of the canvas
  const place = () => { root.style.transform = `translate(${pos.x}px, ${pos.y}px)`; };
  const report = () => invoke('set_rect', { x: pos.x, y: pos.y, w: cw, h: ch });
  place(); report();

  // ---- 12 fps animation, "on twos" ----
  const stats = { draws: 0, rafs: 0 };
  let frame = 0;
  // A 12 Hz timer, not requestAnimationFrame: rAF would wake the page 60 times a second to draw 12.
  const tick = () => {
    const t = performance.now();
    frame++;
    const s = t / 1000;
    p.seed = (frame * 0.37) % 10;
    p.head = 0.06 * Math.sin(s * 1.3);
    p.hair = 0.5 * Math.sin(s * 0.9);
    p.mane = 0.1 * Math.sin(s * 1.7);
    p.armL = 0.08 * Math.sin(s * 1.1);
    p.armR = 0.08 * Math.sin(s * 1.1 + 1);
    sprite.draw(p);
    stats.draws++;
  };
  setInterval(tick, 1000 / FPS);
  window.__spike = { stats, pos, sprite, p };
  window.__spike.snapshot = () => { const s = { ...stats, t: performance.now() }; return s; };

  // ---- mask hit test: a point in the page -> alpha of the sprite under it ----
  const solidAt = (x, y) => {
    const sx = Math.floor((x - pos.x) / SCALE - SPRITE.pad);
    const sy = Math.floor((y - pos.y) / SCALE - SPRITE.pad);
    if (sx < 0 || sy < 0 || sx >= SPRITE.width || sy >= SPRITE.height) return false;
    return alpha[(sy * SPRITE.width + sx) * 4 + 3] > 40;
  };
  window.__spike.solidAt = solidAt;

  // Rust tells us where the cursor is while it is near her; we say whether it is on her body.
  let over = false;
  // Rust forgets the verdict whenever the cursor leaves her box, so every cursor event is answered
  // (no de-duplication: the page and Rust would drift apart)
  const setOver = (v) => { over = v; invoke('set_hit', { over }); };
  await listen('cursor', (e) => setOver(solidAt(e.payload.x, e.payload.y)));
  const ev = window.__spike.ev = { down: 0, move: 0 };
  addEventListener('mousedown', () => ev.down++, true);
  addEventListener('mousemove', () => ev.move++, true);
  // once the window catches the mouse the page sees it itself: leaving her body releases it quickly
  addEventListener('mousemove', (e) => { if (!drag && solidAt(e.clientX, e.clientY) !== over) setOver(!over); });

  // ---- drag ----
  let drag = null;
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !solidAt(e.clientX, e.clientY)) return;
    drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    invoke('set_dragging', { on: true });
    log(`mousedown on her at (${e.clientX},${e.clientY})`);
  });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    pos.x = e.clientX - drag.dx;
    pos.y = e.clientY - drag.dy;
    place(); report();
  });
  addEventListener('mouseup', (e) => {
    if (!drag) return;
    drag = null;
    invoke('set_dragging', { on: false });
    log(`mouseup, dropped at canvas (${Math.round(pos.x)},${Math.round(pos.y)})`);
    setOver(solidAt(e.clientX, e.clientY));
  });
  addEventListener('resize', () => { log(`resize ${innerWidth}x${innerHeight} dpr=${devicePixelRatio}`); report(); });

  // ---- one-shot self check (also what CI reads) ----
  await new Promise((r) => setTimeout(r, 800));
  const gl = sprite.gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const w = canvas.width, h = canvas.height;
  sprite.draw(p);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let opaque = 0, clear = 0;
  for (let i = 3; i < px.length; i += 4) { if (px[i] > 200) opaque++; else if (px[i] === 0) clear++; }
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  log(`AUTOTEST webgl=${opaque > 1000 ? 'ok' : 'FAIL'} version=${gl.getParameter(gl.VERSION)} renderer=${renderer} ` +
      `canvas=${w}x${h} opaquePx=${opaque} clearPx=${clear} body_bg=${bodyBg} dpr=${devicePixelRatio} ` +
      `viewport=${innerWidth}x${innerHeight} screen=${screen.width}x${screen.height}`);
}

main().catch((err) => log(`AUTOTEST error ${err && err.stack || err}`));
