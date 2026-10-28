'use strict';

// Tauri's frontendDist for Capri (TAURI-04): her real pages, with no bundler. The pages reach outside
// src/renderer by relative paths (../../assets/capri/..., ../../../node_modules/@fontsource/...), so
// the staged folder keeps the repository's layout and holds only what they need:
//   src-tauri/frontend/src/renderer/**   the pages, scripts, styles
//   src-tauri/frontend/assets/**         her pictures
//   src-tauri/frontend/node_modules/@fontsource/<font>/files/<the files tokens.css names>
// and the window opens src/renderer/index.html.  node scripts/stage-frontend.js [--out dir]

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// every url('...') of the styles that points into node_modules
function fontFiles() {
  const dir = path.join(ROOT, 'src', 'renderer', 'styles');
  const files = new Set();
  for (const css of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const text = fs.readFileSync(path.join(dir, css), 'utf8');
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]*node_modules\/[^'")]+)['"]?\s*\)/g)) {
      files.add(path.normalize(path.join(dir, m[1])));
    }
  }
  return [...files];
}

function stage(out = path.join(ROOT, 'src-tauri', 'frontend')) {
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'src', 'renderer'), path.join(out, 'src', 'renderer'));
  copyDir(path.join(ROOT, 'assets'), path.join(out, 'assets'));
  const fonts = fontFiles();
  for (const file of fonts) {
    if (!fs.existsSync(file)) throw new Error(`missing font file ${path.relative(ROOT, file)} (npm install)`);
    const rel = path.relative(ROOT, file);
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.copyFileSync(file, path.join(out, rel));
  }
  return { out, fonts: fonts.length };
}

if (require.main === module) {
  const at = process.argv.indexOf('--out');
  const { out, fonts } = stage(at > 0 ? path.resolve(process.argv[at + 1]) : undefined);
  console.log(`staged her pages in ${path.relative(ROOT, out) || out} (${fonts} font files)`);
}

module.exports = { stage, fontFiles };
