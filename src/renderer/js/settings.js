// Her settings window: sections as tabs on the left, the open one on the right. What it shows comes
// from main (settings-view.js), already in her language; it's drawn again whenever main sends a new
// view, keeping the open section. A change is sent to main as it's made; main checks it, saves it
// and tells everyone (her menu, the overlay, this window). What it answers shows in the status line
// at the bottom, or under the field it's about (a key, an address). Keys are only ever sent, never
// read back: the window knows whether one is saved, nothing more. Keyboard: Tab moves through, the
// arrows/Home/End move between sections, Escape closes the window.

import { settingsHost as host } from './host.js';

const tabs = document.getElementById('tabs');
const panels = document.getElementById('panels');
const title = document.getElementById('title');
const closeButton = document.getElementById('close');
const statusLine = document.getElementById('status');
const resetButton = document.getElementById('reset');

// the id of the open section (a link can ask for one: #about from her menu's "Update available")
let current = decodeURIComponent(location.hash.slice(1)) || null;
let view = null;
// kept across redraws: what's typed in a key or address field, the errors under fields, the reset
// confirmation being open
const drafts = {};
const fieldErrors = {};
let resetOpen = false;
let statusTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(id, { focus = false } = {}) {
  const changed = id !== current;
  current = id;
  for (const tab of tabs.children) {
    const on = tab.dataset.id === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const panel of panels.children) panel.hidden = panel.dataset.id !== id;
  if (changed) panels.scrollTop = 0;
}

function say(text, { error = false } = {}) {
  clearTimeout(statusTimer);
  statusLine.textContent = text || '';
  statusLine.classList.toggle('settings__status--error', error);
  // a success fades after a while; an error stays until the next change
  if (!error && text) statusTimer = setTimeout(() => { statusLine.textContent = ''; }, 4000);
}

// main's answer to a change: said in the status line, or under its field
function answer(res, rowId) {
  if (!res) return;
  const t = view.text;
  if (res.ok) {
    if (res.field) fieldErrors[rowId] = res.field; // saved, with a word about it (a key the service didn't take)
    else delete fieldErrors[rowId];
    say(t[res.status] || t.saved);
  } else if (res.error === 'save') {
    say(`${t.saveFailed}${res.code ? ` (${res.code})` : ''}`, { error: true });
  } else if (res.field) {
    fieldErrors[rowId] = res.field;
    say('');
  } else {
    say(t.invalid, { error: true });
  }
  showFieldError(rowId);
}

async function send(patch, rowId) {
  answer(await host.set(patch), rowId);
}

function showFieldError(rowId) {
  const node = document.getElementById(`error-${rowId}`);
  if (!node) return;
  const code = fieldErrors[rowId];
  const t = view.text;
  node.textContent = code ? ({ empty: t.keyEmpty, format: t.keyFormat, rejected: t.keyRejected, url: t.urlInvalid }[code] || t.invalid) : '';
  node.hidden = !code;
  document.getElementById(`field-${rowId}`)?.setAttribute('aria-invalid', String(Boolean(code)));
}

function button(text, onClick, className = 'settings__button') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// The updates of the app (updates.js): what the updater says, the version offered and its notes
// (plain text), the progress, and the buttons that fit. Drawn again on its own as the status moves.
function updateText(st) {
  const t = view.text;
  const v = (text) => (text || '').replaceAll('{version}', st.version || '');
  switch (st.kind) {
    case 'disabled': return { feed: t.updOffFeed, platform: t.updOffPlatform, unconfigured: t.updOffPlatform }[st.reason] || t.updOffDev;
    case 'idle': return t.updIdle;
    case 'checking': return t.updChecking;
    case 'current': return t.updCurrent;
    case 'available': return v(t.updAvailable);
    case 'downloading': return v(t.updDownloading);
    case 'downloaded': return v(t.updDownloaded);
    case 'installing': return v(t.updInstalling);
    case 'error':
      if (st.category === 'network') return t.updNetwork;
      if (st.category === 'signature') return t.updSignature;
      if (st.reason === 'feed') return t.updFeed;
      if (st.reason === 'location') return t.updLocation;
      return `${t.updFailed}: ${st.error}`;
    default: return '';
  }
}

// the keys she will enter again (provider names, never a key), or the general sentence
function bridgeWarningText(w) {
  const t = view.text;
  return w?.keys?.length ? t.updBridgeKeys.replaceAll('{keys}', w.keys.join(', ')) : t.updBridgeSome;
}

function fillUpdate(box, st) {
  const t = view.text;
  const focused = box.contains(document.activeElement) ? document.activeElement.id : null;
  const busy = ['checking', 'downloading', 'installing'].includes(st.kind);
  const state = el('p', `settings__updateState${st.kind === 'error' ? ' settings__updateState--error' : ''}`, updateText(st));
  state.id = 'update-state';
  state.setAttribute('role', 'status');
  const nodes = [state];
  if (st.version && st.kind !== 'error') nodes.push(el('p', 'settings__hint', `${t.updOffered}: ${st.current} → ${st.version}`));
  if (st.mode === 'notify' && st.version) nodes.push(el('p', 'settings__hint', t.updPackage));
  // the update that moves her to the Tauri build (TAURI-13), and what could not be carried over for it
  if (st.bridge && st.version && st.kind !== 'error') nodes.push(el('p', 'settings__hint', t.updBridge));
  const warning = st.bridgeWarning && bridgeWarningText(st.bridgeWarning);
  if (warning) {
    const warn = el('p', 'settings__updateState settings__updateState--error', warning);
    warn.id = 'update-bridge-warning';
    warn.setAttribute('role', 'alert');
    nodes.push(warn);
  }
  if (st.kind === 'downloading') {
    const bar = el('progress', 'settings__progress');
    bar.id = 'update-progress';
    if (st.total) Object.assign(bar, { max: st.total, value: Math.min(st.received, st.total) });
    const mb = (n) => (n / 1048576).toFixed(1);
    nodes.push(bar, el('p', 'settings__hint', st.total ? `${Math.floor((st.received / st.total) * 100)} % · ${mb(st.received)} / ${mb(st.total)} MB` : `${mb(st.received || 0)} MB`));
  }
  const actions = el('div', 'settings__actions settings__actions--start');
  const add = (id, text, fn, className) => {
    const b = button(text, fn, className);
    b.id = id;
    actions.append(b);
    return b;
  };
  if (st.kind !== 'disabled') add('update-check', t.updCheck, () => host.updates.check()).disabled = busy;
  if (st.kind === 'available' && st.canDownload) add('update-download', t.updDownload, () => host.updates.download(), 'settings__button settings__button--primary');
  if (st.kind === 'downloaded') add('update-install', st.bridgeWarning ? t.updBridgeAnyway : t.updInstall, () => confirmUpdate(st.version, st.bridgeWarning), 'settings__button settings__button--primary');
  if (st.version && (st.mode === 'notify' || st.kind === 'error')) add('update-page', t.updPage, () => host.updates.page());
  if (actions.children.length) nodes.push(actions);
  if (st.notes && st.kind !== 'error') {
    const notes = el('div', 'settings__notes', st.notes); // text, never HTML
    notes.id = 'update-notes';
    notes.setAttribute('aria-label', t.updNotes);
    nodes.push(el('p', 'settings__label', t.updNotes), notes);
  }
  box.replaceChildren(...nodes);
  const again = focused && document.getElementById(focused);
  if (again && !again.disabled) again.focus();
  else if (focused) (box.querySelector('button:not([disabled])') || box.closest('.settings__panel'))?.focus();
}

// the control of a row, by its type (settings-view.js)
function control(row) {
  const c = row.control;
  if (c.type === 'update') {
    const box = el('div', 'settings__control settings__update');
    box.id = 'update-box';
    fillUpdate(box, c.status);
    return box;
  }
  const id = `field-${row.id}`;
  const box = el('div', 'settings__control');
  let input;
  if (c.type === 'select') {
    input = el('select', 'settings__select');
    c.options.forEach((o, i) => {
      const option = el('option', null, o.label);
      option.value = String(i);
      option.selected = o.value === c.value;
      input.append(option);
    });
    input.addEventListener('change', () => send({ [c.key]: c.options[Number(input.value)].value }, row.id));
    box.append(input);
  } else if (c.type === 'toggle') {
    input = el('input', 'settings__switch');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = c.value;
    input.addEventListener('change', () => send({ [c.key]: input.checked }, row.id));
    box.append(input);
  } else if (c.type === 'range') {
    input = el('input', 'settings__range');
    Object.assign(input, { type: 'range', min: c.min, max: c.max, step: c.step, value: c.value });
    const out = el('output', 'settings__rangeValue', `${c.value} %`);
    out.htmlFor = id;
    input.addEventListener('input', () => { out.textContent = `${input.value} %`; });
    input.addEventListener('change', () => send({ [c.key]: Number(input.value) / 100 }, row.id));
    box.append(input, out);
  } else if (c.type === 'key' || c.type === 'url') {
    // typed, then saved with its button (or Enter); a key is never filled in from what's saved
    const t = view.text;
    const line = el('div', 'settings__inline');
    input = el('input', 'settings__input');
    input.type = c.type === 'key' ? 'password' : 'url';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (c.type === 'key') input.placeholder = t.keyPlaceholder;
    input.value = drafts[row.id] ?? (c.type === 'url' ? c.value : '');
    input.addEventListener('input', () => {
      drafts[row.id] = input.value;
      if (fieldErrors[row.id]) {
        delete fieldErrors[row.id];
        showFieldError(row.id);
      }
    });
    const save = async () => {
      const res = c.type === 'key' ? await host.saveKey(c.provider, input.value) : await host.set({ [c.key]: input.value });
      if (res?.ok) {
        delete drafts[row.id];
        if (c.type === 'key') input.value = '';
      }
      answer(res && !res.ok && res.fields?.[c.key] ? { ok: false, field: res.fields[c.key] } : res, row.id);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    const saveButton = button(c.type === 'key' ? t.keySave : t.urlSave, save);
    saveButton.id = `save-${row.id}`;
    line.append(input, saveButton);
    box.append(line);
    if (c.type === 'key' && c.env) {
      const env = el('p', 'settings__hint', t.keyEnv);
      env.id = `hint-${row.id}-env`;
      box.append(env);
    }
    const error = el('p', 'settings__fieldError');
    error.id = `error-${row.id}`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    box.append(error);
  }
  input.id = id;
  if (c.disabled) input.disabled = true;
  for (const [i, text] of [c.reason, c.note].entries()) {
    if (!text) continue;
    const hint = el('p', 'settings__hint', text);
    hint.id = `hint-${row.id}-${i}`;
    box.append(hint);
  }
  // read with the field by a screen reader: its hints (why it's off, what it does) and its error
  const described = [...box.querySelectorAll('.settings__hint, .settings__fieldError')].map((node) => node.id);
  if (described.length) input.setAttribute('aria-describedby', described.join(' '));
  if (c.restart) {
    const line = el('div', 'settings__restart');
    line.append(el('p', 'settings__restartText', c.restart.label), button(c.restart.button, () => host.restart()));
    box.append(line);
  }
  return box;
}

function section(s) {
  const panel = el('section', 'settings__panel');
  panel.id = `panel-${s.id}`;
  panel.dataset.id = s.id;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${s.id}`);
  panel.append(el('h2', 'settings__heading', s.title));
  if (s.fromMenu) {
    const note = el('div', 'settings__note');
    const menu = button(view.openMenu, () => host.openMenu());
    menu.id = `menu-${s.id}`;
    note.append(el('p', 'settings__noteText', view.text.menuNote), menu);
    panel.append(note);
  }
  const list = el('div', 'settings__rows');
  for (const row of s.rows) {
    const item = el('div', 'settings__row');
    item.dataset.id = row.id;
    // a field to type in: the label above it, the whole width for it
    if (['key', 'url', 'update'].includes(row.control?.type)) item.classList.add('settings__row--wide');
    if (row.control?.type === 'update') {
      item.append(el('span', 'settings__label', row.label), control(row));
    } else if (row.control) {
      const label = el('label', 'settings__label', row.label);
      label.htmlFor = `field-${row.id}`;
      // a key: whether one is saved, by the label
      if (row.control.type === 'key') label.append(el('span', 'settings__keyState', row.value));
      item.append(label, control(row));
    } else {
      item.append(el('span', 'settings__label', row.label), el('span', 'settings__value', row.value));
    }
    list.append(item);
  }
  panel.append(list);
  if (s.id === 'about') panel.tabIndex = 0; // read-only content: reachable with Tab, and scrollable with the arrows
  return panel;
}

// "Reset settings…": what it resets and what it leaves, then a confirmation
function resetBox() {
  const t = view.text;
  const box = el('div', 'settings__confirm');
  box.id = 'reset-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'reset-title');
  const heading = el('h2', 'settings__heading', t.resetTitle);
  heading.id = 'reset-title';
  const yes = button(t.resetConfirm, async () => {
    const res = await host.reset();
    resetOpen = false;
    showReset();
    answer(res && res.ok ? { ok: true, status: 'resetDone' } : res, 'reset');
    resetButton.focus();
  }, 'settings__button settings__button--danger');
  yes.id = 'reset-confirm';
  const no = button(t.cancel, () => {
    resetOpen = false;
    showReset();
    resetButton.focus();
  });
  no.id = 'reset-cancel';
  const actions = el('div', 'settings__actions');
  actions.append(no, yes);
  box.append(heading, el('p', 'settings__noteText', t.resetWhat), el('p', 'settings__noteText', t.resetKeeps), actions);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      // the focus stays in the confirmation while it's open
      e.preventDefault();
      (document.activeElement === no ? yes : no).focus();
    }
    if (e.key === 'Escape') {
      e.preventDefault(); // closes the confirmation, not the window
      no.click();
    }
  });
  return box;
}

// "Update and restart": asked once more, over the window, before main installs and restarts
function confirmUpdate(version, warning = null) {
  const t = view.text;
  document.getElementById('update-confirm-box')?.remove();
  const box = el('div', 'settings__confirm');
  box.id = 'update-confirm-box';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'update-confirm-title');
  const heading = el('h2', 'settings__heading', (warning ? t.updBridgeConfirm : t.updConfirm).replaceAll('{version}', version));
  heading.id = 'update-confirm-title';
  const done = () => {
    box.remove();
    (document.getElementById('update-install') || document.getElementById('update-check'))?.focus();
  };
  const no = button(t.updLater, done);
  no.id = 'update-confirm-no';
  const yes = button(t.updInstall, () => {
    box.remove();
    host.updates.install(true);
  }, 'settings__button settings__button--primary');
  yes.id = 'update-confirm-yes';
  const actions = el('div', 'settings__actions');
  actions.append(no, yes);
  box.append(heading, el('p', 'settings__noteText', warning ? bridgeWarningText(warning) : t.updConfirmDetail), actions);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === no ? yes : no).focus();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      done();
    }
  });
  document.body.append(box);
  no.focus();
}

function showReset() {
  document.getElementById('reset-box')?.remove();
  resetButton.setAttribute('aria-expanded', String(resetOpen));
  if (resetOpen) document.body.append(resetBox());
}

function render(next) {
  view = next;
  document.documentElement.lang = view.lang;
  document.title = view.title;
  title.textContent = view.title;
  tabs.setAttribute('aria-label', view.nav);
  closeButton.textContent = view.close;
  resetButton.textContent = view.text.reset;
  // drawn again (the config changed, often from her menu opened here): the focus stays on the same
  // control, not dropped to the page, and the open section stays scrolled where it was
  const focused = document.activeElement?.id;
  const scroll = panels.scrollTop;
  tabs.replaceChildren(...view.sections.map((s) => {
    const tab = el('button', 'settings__tab', s.title);
    tab.type = 'button';
    tab.id = `tab-${s.id}`;
    tab.dataset.id = s.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${s.id}`);
    tab.addEventListener('click', () => select(s.id));
    return tab;
  }));
  panels.replaceChildren(...view.sections.map(section));
  const ids = view.sections.map((s) => s.id);
  const same = ids.includes(current);
  select(same ? current : ids[0]);
  if (same) panels.scrollTop = scroll;
  const again = focused && document.getElementById(focused);
  for (const rowId of Object.keys(fieldErrors)) showFieldError(rowId);
  showReset();
  if (again && !again.closest('[hidden]')) again.focus();
}

tabs.addEventListener('keydown', (e) => {
  const list = [...tabs.children];
  const at = list.findIndex((tab) => tab.dataset.id === current);
  const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  select(list[(to + list.length) % list.length].dataset.id, { focus: true });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    host.close();
  }
});
closeButton.addEventListener('click', () => host.close());
resetButton.addEventListener('click', () => {
  resetOpen = !resetOpen;
  showReset();
  if (resetOpen) document.getElementById('reset-cancel')?.focus();
});

host.onView(render);
host.onSection((id) => view?.sections.some((s) => s.id === id) && select(id, { focus: true }));
host.updates.onStatus((status) => {
  const box = document.getElementById('update-box');
  if (!box || !view) return;
  const row = view.sections.flatMap((s) => s.rows).find((r) => r.id === 'update');
  if (row) row.control.status = status; // kept for the next full redraw
  fillUpdate(box, status);
});
render(await host.view());
tabs.querySelector('[aria-selected="true"]')?.focus();
host.ready({ sections: view.sections.length, focused: document.activeElement?.id || null });
