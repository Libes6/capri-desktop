'use strict';

// What her settings window shows, built from the config and what main knows. Pure (no Electron):
// main.js gathers the facts, this turns them into sections of labelled rows in her language.
// A row that can be changed has a `control` saying how (select, toggle, range, key, url) and which
// key of settings-patch.js it sends; main checks what comes back. Keys are never in here: only
// whether one is saved.

const { TRAY, SETTINGS, LANGS } = require('./labels');
const { SCALES } = require('./settings-patch');

const SECTIONS = ['general', 'behavior', 'ai', 'about'];
const OS_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function sizeLabel(t, scale) {
  const named = [[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].find(([, s]) => Math.abs(scale - s) < 0.01);
  return named ? named[0] : `${Math.round((Number(scale) || 0) * 100)} %`;
}

function pick(pairs, value, fallback) {
  return (pairs.find(([v]) => v === value) || [null, fallback])[1];
}

// a select from [value, label] pairs; `value` the one set now
function select(key, pairs, value) {
  return { type: 'select', key, value, options: pairs.map(([v, label]) => ({ value: v, label })) };
}

/**
 * @param {object} facts
 *   cfg: the config, without its keys
 *   lang: the language she speaks now; langSetting: 'auto' or a language; autoLang: what 'auto' gives
 *   assistant: { id, name } she watches, or null when she watches none; hooksInstalled: its hooks are in
 *   assistants: [{ id, name }] she can watch
 *   provider: the label of who answers her chat; providers: [{ id, label, keyed }]
 *   keys: { provider: true } for each provider with a key saved; envKeys: the same, set by the environment
 *   model: the model picked (null: none reached); models: the provider's models (null: not reached)
 *   features: capabilities.all(); autostart: whether she starts with the system right now
 *   screen: { index, count, width, height } of the screen she's on; screens: [{ id, width, height }]
 *   renderNow: the display mode she was started with
 *   about: { version, platform, arch, electron, session }
 *   updates: the updater's view (updates.js), or nothing
 */
function settingsView(facts) {
  const { features = {}, about = {} } = facts;
  const { apiKeys: _never, ...cfg } = facts.cfg || {}; // keys never reach the window, even if passed
  const lang = LANGS.includes(facts.lang) ? facts.lang : 'en';
  const s = SETTINGS[lang];
  const watched = facts.assistant;
  // the menu's labels, with Claude Code swapped for the assistant she watches, as the menu does
  const t = Object.fromEntries(Object.entries(TRAY[lang]).map(([key, value]) =>
    [key, typeof value === 'string' && watched && watched.id !== 'claude' ? value.replaceAll('Claude Code', watched.name) : value]));
  const onOff = (value) => (value ? s.on : s.off);
  const unavailable = (feature, value) => (features[feature] ? value : t.unavailable);
  const toggle = (key, value, extra = {}) => ({ type: 'toggle', key, value: Boolean(value), ...extra });
  const off = (reason) => ({ disabled: true, reason });

  const langSetting = facts.langSetting === 'auto' || !LANGS.includes(facts.langSetting) ? 'auto' : facts.langSetting;
  const autoLabel = t.auto(t.langNames[facts.autoLang] || facts.autoLang || '');
  const langPairs = [['auto', autoLabel], ...LANGS.map((code) => [code, TRAY[code].name])];

  const scale = Number(cfg.scale) || 0.6;
  const scalePairs = [[0.45, t.small], [0.6, t.medium], [0.8, t.large]];
  const scaleNow = SCALES.find((v) => Math.abs(v - scale) < 0.01);
  if (scaleNow === undefined) scalePairs.push([scale, sizeLabel(t, scale)]); // set by hand: kept as it is
  const volume = Math.round((cfg.volume ?? 0.7) * 100);

  const sc = facts.screen;
  const screens = facts.screens || [];
  const current = sc && screens[sc.index];
  const renderPairs = [['auto', t.displayAuto], ['gl', t.displayGl], ['software', t.displaySoftware]];
  const render = cfg.render || 'auto';
  const motionPairs = [['auto', t.motionAuto], ['full', t.motionFull], ['reduced', t.motionReduced]];
  const restPairs = [['corner', t.restCorner], ['taskbar', t.restTaskbar]];
  const initiativePairs = [['quiet', t.initiativeQuiet], ['normal', t.initiativeNormal], ['active', t.initiativeActive]];
  const initiative = initiativePairs.some(([v]) => v === cfg.initiative) ? cfg.initiative : 'normal';

  const providers = facts.providers || [];
  const providerNow = providers.find((p) => p.id === cfg.provider);
  const models = facts.models?.length ? facts.models : null;
  const hasKey = Boolean(facts.keys?.[cfg.provider]);
  const envKey = Boolean(facts.envKeys?.[cfg.provider]);

  const rows = {
    general: [
      { id: 'lang', label: t.lang, value: pick(langPairs, langSetting, autoLabel), control: select('lang', langPairs, langSetting) },
      {
        id: 'autostart',
        label: t.startup,
        value: unavailable('autostart', onOff(facts.autostart)),
        control: toggle('autostart', features.autostart && facts.autostart, features.autostart ? {} : off(t.unavailable)),
      },
      { id: 'scale', label: t.size, value: sizeLabel(t, scale), control: select('scale', scalePairs, scaleNow ?? scale) },
      { id: 'muted', label: t.mute, value: onOff(cfg.muted), control: toggle('muted', cfg.muted) },
      { id: 'volume', label: s.volume, value: `${volume} %`, control: { type: 'range', key: 'volume', value: volume, min: 0, max: 100, step: 5 } },
      {
        id: 'screen',
        label: t.screen,
        value: sc ? `${sc.index + 1} / ${sc.count} — ${sc.width}×${sc.height}` : s.none,
        control: current
          ? {
            ...select('displayId', screens.map((d, i) => [d.id, `${i + 1} — ${d.width}×${d.height}`]), current.id),
            ...(screens.length < 2 && off(s.oneScreen)),
          }
          : undefined,
      },
      { id: 'follow', label: t.follow, value: onOff(cfg.follow !== false), control: toggle('follow', cfg.follow !== false) },
      {
        id: 'render',
        label: t.display,
        value: pick(renderPairs, render, t.displayAuto),
        control: {
          ...select('render', renderPairs, render),
          // read only when she starts: said always, and when the one picked isn't the one running
          note: s.restartNote,
          restart: Boolean(facts.renderNow) && facts.renderNow !== render ? { label: s.restartNeeded, button: s.restartNow } : undefined,
        },
      },
    ],
    behavior: [
      { id: 'motion', label: t.motion, value: pick(motionPairs, cfg.motion, t.motionAuto), control: select('motion', motionPairs, cfg.motion || 'auto') },
      { id: 'rest', label: t.rest, value: pick(restPairs, cfg.rest, t.restCorner), control: select('rest', restPairs, cfg.rest || 'corner') },
      {
        id: 'initiative',
        label: t.initiative,
        value: pick(initiativePairs, initiative, t.initiativeNormal),
        control: { ...select('initiative', initiativePairs, initiative), note: s.initiativeNote },
      },
      { id: 'wander', label: t.wander, value: onOff(cfg.wander), control: toggle('wander', cfg.wander) },
      {
        id: 'possess',
        label: t.possess,
        value: unavailable('windowTracking', onOff(cfg.possess)),
        control: toggle('possess', features.windowTracking && cfg.possess, features.windowTracking ? {} : off(t.unavailable)),
      },
      { id: 'jealous', label: t.jealous, value: onOff(cfg.jealous !== false), control: toggle('jealous', cfg.jealous !== false) },
      { id: 'pcReact', label: t.pcReact, value: onOff(cfg.pcReact !== false), control: toggle('pcReact', cfg.pcReact !== false) },
      {
        id: 'watchScreen',
        label: t.lookAuto,
        value: onOff(Boolean(cfg.watchScreen)),
        control: toggle('watchScreen', cfg.watchScreen, cfg.lookAsked ? {} : { note: s.watchAsks }),
      },
    ],
    ai: [
      {
        id: 'assistant',
        label: t.watch,
        value: watched ? watched.name : t.watchNone,
        control: select('assistant', [...(facts.assistants || []).map((a) => [a.id, a.name]), ['none', t.watchNone]], watched ? watched.id : 'none'),
      },
      ...(watched ? [{ id: 'hooks', label: `${s.hooks} ${watched.name}`, value: onOff(facts.hooksInstalled) }] : []),
      {
        id: 'provider',
        label: s.provider,
        value: facts.provider || s.none,
        control: providers.length ? select('provider', providers.map((p) => [p.id, p.label]), cfg.provider) : undefined,
      },
      ...(providerNow?.keyed ? [{
        id: 'apiKey',
        label: s.key,
        value: hasKey ? s.keySet : s.keyNone,
        control: { type: 'key', provider: cfg.provider, has: hasKey, env: envKey, ...(!hasKey && !envKey && { note: s.keyNeeded }) },
      }] : []),
      ...(cfg.provider === 'custom' ? [{
        id: 'customUrl', label: s.url, value: cfg.customUrl || s.none, control: { type: 'url', key: 'customUrl', value: cfg.customUrl || '' },
      }] : []),
      {
        id: 'model',
        label: s.model,
        value: facts.model || s.none,
        control: models ? select('chatModel', models.map((m) => [m, m]), facts.model) : undefined,
      },
    ],
    about: [
      { id: 'version', label: s.version, value: about.version || s.none },
      ...(facts.updates ? [{ id: 'update', label: s.updates, control: { type: 'update', status: facts.updates } }] : []),
      {
        id: 'system',
        label: s.system,
        value: [OS_NAMES[about.platform] || about.platform, about.arch, about.session].filter(Boolean).join(' · ') || s.none,
      },
      { id: 'electron', label: s.electron, value: about.electron || s.none },
      { id: 'license', label: s.license, value: 'PolyForm Noncommercial 1.0.0' },
    ],
  };
  // plain data for IPC: no undefined left behind
  for (const list of Object.values(rows)) {
    for (const row of list) {
      if (!row.control) delete row.control;
      else if (row.control.restart === undefined) delete row.control.restart;
    }
  }

  // what the window says, in her language (plain strings)
  const text = Object.fromEntries([
    'saved', 'saveFailed', 'invalid', 'moving', 'asks', 'keyPlaceholder', 'keySave', 'keySaved', 'keyEmpty', 'keyFormat',
    'keyRejected', 'keyEnv', 'urlSave', 'urlInvalid', 'reset', 'resetTitle', 'resetWhat', 'resetKeeps', 'resetConfirm',
    'cancel', 'resetDone', 'menuNote',
    ...Object.keys(s).filter((key) => key.startsWith('upd')),
  ].map((key) => [key, s[key]]));

  return {
    lang,
    title: s.title,
    nav: s.nav,
    close: s.close,
    openMenu: s.openMenu,
    text,
    // the note on what's still only in her menu, with a button to open it: at the top of General
    sections: SECTIONS.map((id) => ({
      id, title: s[id], fromMenu: id === 'general',
      // facts.renderModes === false: the platform picks its own renderer (the Tauri build), no display mode to offer
      rows: facts.renderModes === false ? rows[id].filter((r) => r.id !== 'render') : rows[id],
    })),
  };
}

module.exports = { settingsView, SECTIONS };
