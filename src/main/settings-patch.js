'use strict';

// What her settings window may change, checked in main before anything is saved. Pure (no
// platform): main passes what it knows (her languages, the providers, the models, the screens,
// what this computer can do), so every rule can be tested. Anything not listed here is refused:
// the window can't write her memories, keys (they have their own path, checkKey), hooks or history.

const SCALES = [0.45, 0.6, 0.8]; // her menu's Small, Medium, Large
const SCALE_RANGE = [0.3, 1]; // a scale set by hand in the config stays possible
const CHOICES = {
  motion: ['auto', 'full', 'reduced'],
  rest: ['corner', 'taskbar'],
  render: ['auto', 'gl', 'software'],
  initiative: ['quiet', 'normal', 'active'],
};
const BOOLEANS = ['muted', 'follow', 'wander', 'possess', 'jealous', 'pcReact', 'watchScreen', 'autostart'];
// a key: printable, no spaces, of a sensible length
const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;
const URL_MAX = 2048;

// What "Reset settings" puts back to its default, and only that. Not touched: the AI service, its
// model, address and keys, the assistant watched and its hooks, starting with the system (a system
// setting), the display mode (it may be what keeps her window from showing black), and what is
// yours: your name, her persona, your lines, memories, reminders, your bond, the chat history.
const RESET_KEYS = [
  'lang', 'scale', 'muted', 'volume', 'displayId', 'follow',
  'motion', 'rest', 'wander', 'possess', 'jealous', 'pcReact', 'watchScreen', 'initiative',
];

function resetPatch(defaults) {
  return Object.fromEntries(RESET_KEYS.map((key) => [key, defaults[key]]));
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function checkUrl(value) {
  if (typeof value !== 'string') return 'type';
  const url = value.trim();
  if (!url) return null; // empty: no address
  if (url.length > URL_MAX) return 'url';
  try {
    const { protocol } = new URL(url);
    return ['http:', 'https:'].includes(protocol) ? null : 'url';
  } catch {
    return 'url';
  }
}

/**
 * A patch from the window, checked key by key.
 * @param {object} input what the window sent
 * @param {object} ctx  langs, providers (ids), assistants (ids), models (names, or null when none
 *                      are known), displays (ids), features (capabilities.all())
 * @returns {{ ok: true, values: object } | { ok: false, fields: object }}
 *   fields: key -> 'unknown' | 'type' | 'range' | 'choice' | 'unsupported' | 'url'
 */
function checkPatch(input, ctx) {
  if (!isObject(input)) return { ok: false, fields: { '': 'type' } };
  const keys = Object.keys(input);
  if (!keys.length || keys.length > 8) return { ok: false, fields: { '': 'range' } };
  // pairs, made objects at the end (Object.fromEntries): `fields[key] = ...` with key '__proto__'
  // would set the prototype instead, and a patch of only that would pass as valid
  const values = [];
  const fields = [];
  const features = ctx.features || {};
  for (const key of keys) {
    const v = input[key];
    let error = null;
    if (BOOLEANS.includes(key)) {
      if (typeof v !== 'boolean') error = 'type';
      else if (key === 'possess' && v && !features.windowTracking) error = 'unsupported';
      else if (key === 'autostart' && !features.autostart) error = 'unsupported';
    } else if (Object.hasOwn(CHOICES, key)) { // not `in`: 'constructor', '__proto__' are refused as unknown
      if (!CHOICES[key].includes(v)) error = 'choice';
    } else if (key === 'lang') {
      if (v !== 'auto' && !(ctx.langs || []).includes(v)) error = 'choice';
    } else if (key === 'scale') {
      if (!finite(v)) error = 'type';
      else if (v < SCALE_RANGE[0] || v > SCALE_RANGE[1]) error = 'range';
    } else if (key === 'volume') {
      if (!finite(v)) error = 'type';
      else if (v < 0 || v > 1) error = 'range';
    } else if (key === 'displayId') {
      if (!(ctx.displays || []).includes(v)) error = 'choice';
    } else if (key === 'assistant') {
      if (v !== 'none' && !(ctx.assistants || []).includes(v)) error = 'choice';
    } else if (key === 'provider') {
      if (!(ctx.providers || []).includes(v)) error = 'choice';
    } else if (key === 'chatModel') {
      if (typeof v !== 'string' || !(ctx.models || []).includes(v)) error = 'choice';
    } else if (key === 'customUrl') {
      error = checkUrl(v);
    } else {
      error = 'unknown';
    }
    if (error) fields.push([key, error]);
    else values.push([key, typeof v === 'string' ? v.trim() : v]);
  }
  return fields.length ? { ok: false, fields: Object.fromEntries(fields) } : { ok: true, values: Object.fromEntries(values) };
}

/**
 * Checked values -> what goes into the config, and what main does besides.
 * @param {object} values from checkPatch
 * @param {object} cfg    the config as it is
 * @returns {{ patch: object, effects: object }}
 *   effects: autostart (boolean, a system setting), screen (an id: she walks there herself, then
 *   it's saved), watchScreen (she asks first, then saves it), assistantChanged (she says hello)
 */
function toConfig(values, cfg = {}) {
  const patch = {};
  const effects = {};
  for (const [key, v] of Object.entries(values)) {
    if (key === 'autostart') effects.autostart = v;
    else if (key === 'displayId') effects.screen = v;
    else if (key === 'watchScreen') effects.watchScreen = v;
    else if (key === 'assistant') {
      if (v === 'none') patch.claude = false;
      else {
        const other = cfg.assistant !== v;
        Object.assign(patch, { claude: true, assistant: v }, other && { linked: false, welcomed: false });
        if (other) effects.assistantChanged = true;
      }
    } else if (key === 'motion') Object.assign(patch, { motion: v, motionAsked: true }); // as her menu does
    else if (key === 'scale') patch.scale = Math.round(v * 100) / 100;
    else if (key === 'volume') patch.volume = Math.round(v * 100) / 100;
    else patch[key] = v;
  }
  return { patch, effects };
}

/**
 * A new API key typed in the window. Never echoed back, never logged.
 * @param {string} provider  the provider it is for
 * @param {*} key            what was typed
 * @param {string[]} keyed   the providers that take a key
 * @returns {{ ok: true, key: string } | { ok: false, field: 'provider' | 'empty' | 'format' }}
 */
function checkKey(provider, key, keyed) {
  if (!keyed.includes(provider)) return { ok: false, field: 'provider' };
  if (typeof key !== 'string' || !key.trim()) return { ok: false, field: 'empty' };
  const value = key.trim();
  return KEY_PATTERN.test(value) ? { ok: true, key: value } : { ok: false, field: 'format' };
}

module.exports = { SCALES, RESET_KEYS, resetPatch, checkPatch, toConfig, checkKey };
