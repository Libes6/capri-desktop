'use strict';

// Her tray menu on the wire to the Rust shell (TAURI-06). The core builds the menu as data, a template
// of { label, type, checked, enabled, accelerator, click, submenu } (tray-menu.js), with click
// callbacks in it. Callbacks cannot cross the pipe: each clickable item gets an id, the plain
// description goes to Rust (which builds a real menu with tauri::menu), and a click comes back as
// { id, checked } to be turned into the callback again.
//
//   wire = serializeMenu(template, generation)
//   wire.items   [{ id?, label?, type?, checked?, enabled?, accelerator?, submenu? }]   (JSON)
//   wire.clicks  Map id -> the template's item
//   runClick(wire.clicks, id, checked, log)   calls item.click with the item as it is after the click

const TYPES = new Set(['normal', 'checkbox', 'radio', 'separator']);

// ids are `t<generation>.<n>`: the generation says which menu a click was made on
function serializeMenu(template, generation) {
  const clicks = new Map();
  let n = 0;
  const walk = (items) => items.map((item) => {
    const out = {};
    if (item.type === 'separator') return { type: 'separator' };
    if (item.label !== undefined) out.label = String(item.label);
    if (item.type !== undefined) {
      if (!TYPES.has(item.type)) throw new Error(`menu: unknown item type ${item.type}`);
      out.type = item.type;
    }
    if (item.checked !== undefined) out.checked = Boolean(item.checked);
    if (item.enabled !== undefined) out.enabled = Boolean(item.enabled);
    if (item.accelerator) out.accelerator = String(item.accelerator);
    if (item.submenu) out.submenu = walk(item.submenu);
    if (typeof item.click === 'function') {
      out.id = `t${generation}.${n++}`;
      clicks.set(out.id, item);
    }
    return out;
  });
  return { generation, items: walk(template), clicks };
}

// A click as the template's handlers take it: the item after the click (a checkbox flipped, a radio
// picked). `checked` is what Rust says the item is now.
function runClick(clicks, id, checked, log = () => {}) {
  const item = clicks.get(id);
  if (!item) {
    log(`menu click on an unknown item ${id}`);
    return false;
  }
  const after = item.type === 'checkbox' || item.type === 'radio' ? { ...item, checked: Boolean(checked) } : { ...item };
  try {
    item.click(after);
  } catch (err) {
    log(`menu click ${item.label}: ${err.message}`);
  }
  return true;
}

// the clicks of the last few menus stay good: a menu being open while it is rebuilt is still clicked
function createClickBook(keep = 3) {
  const books = [];
  return {
    add(wire) {
      books.push(wire);
      while (books.length > keep) books.shift();
    },
    click(id, checked, log) {
      for (let i = books.length - 1; i >= 0; i--) if (books[i].clicks.has(id)) return runClick(books[i].clicks, id, checked, log);
      return runClick(new Map(), id, checked, log);
    },
  };
}

module.exports = { serializeMenu, runClick, createClickBook };
