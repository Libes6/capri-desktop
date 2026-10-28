'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { langBase, langSetting, resolveLang } = require('../src/main/lang');
const { TRAY, LANGS } = require('../src/main/labels');
const { createConfig } = require('../src/main/config');
const { createFakePlatform } = require('../src/main/platform/fake');

const sys = (preferred, fallback = []) => ({ preferred, fallback });

test('her languages are the five dictionaries', () => {
  assert.deepEqual([...LANGS].sort(), ['en', 'es', 'fr', 'pt', 'ru']);
});

test('regional and odd tags normalise to dictionary keys', () => {
  assert.equal(langBase('ru-RU'), 'ru');
  assert.equal(langBase('en_US'), 'en');
  assert.equal(langBase('pt-BR'), 'pt');
  assert.equal(langBase('ES-419'), 'es');
  assert.equal(langBase('fr_CA.UTF-8'), 'fr');
  assert.equal(langBase('zh-Hans-CN'), 'zh');
  for (const odd of ['', '   ', 'C', 'POSIX', null, undefined, 42, {}]) assert.equal(langBase(odd), '');
});

test('auto: a supported system locale, including its regional variants', () => {
  assert.equal(resolveLang('auto', sys(['ru-RU']), LANGS), 'ru');
  assert.equal(resolveLang('auto', sys(['en_US']), LANGS), 'en');
  assert.equal(resolveLang('auto', sys(['pt-BR']), LANGS), 'pt');
  assert.equal(resolveLang('auto', sys(['fr-CA']), LANGS), 'fr');
  assert.equal(resolveLang('auto', sys(['es-MX']), LANGS), 'es');
});

test('auto: the first supported language of the preference list wins', () => {
  assert.equal(resolveLang('auto', sys(['de-DE', 'pt-PT', 'ru-RU']), LANGS), 'pt');
  assert.equal(resolveLang('auto', sys(['ja', 'zh-Hans-CN', 'ru', 'en-US']), LANGS), 'ru');
  assert.equal(resolveLang('auto', sys(['en-GB', 'fr-FR']), LANGS), 'en');
});

test('auto: a fully unsupported preference list falls back to English, not to the region locale', () => {
  assert.equal(resolveLang('auto', sys(['de-DE', 'ja-JP', 'zh-Hans-CN']), LANGS), 'en');
  assert.equal(resolveLang('auto', sys(['de-DE'], ['fr-FR', 'ru']), LANGS), 'en');
});

test('auto: with no preference list, the system locale decides, English otherwise', () => {
  assert.equal(resolveLang('auto', sys([], ['ru_RU', 'en-US']), LANGS), 'ru');
  assert.equal(resolveLang('auto', sys(['', 'C'], ['', 'es-ES']), LANGS), 'es');
  assert.equal(resolveLang('auto', sys([], ['de-DE']), LANGS), 'en');
  assert.equal(resolveLang('auto', sys([], []), LANGS), 'en');
  assert.equal(resolveLang('auto', {}, LANGS), 'en');
  assert.equal(resolveLang('auto', undefined, LANGS), 'en');
});

test('an explicit supported choice beats the system', () => {
  assert.equal(resolveLang('fr', sys(['ru-RU']), LANGS), 'fr');
  assert.equal(resolveLang('en', sys(['pt-BR', 'ru']), LANGS), 'en');
  assert.equal(resolveLang('ru', sys(['de-DE']), LANGS), 'ru');
  assert.equal(langSetting('ru', LANGS), 'ru');
});

test('missing, empty or unknown settings from an old config count as auto', () => {
  for (const old of [undefined, null, '', 'de', 'klingon', 'zh-CN', 42, {}, 'AUTO']) {
    assert.equal(langSetting(old, LANGS), 'auto', String(old));
    assert.equal(resolveLang(old, sys(['ru-RU']), LANGS), 'ru', String(old));
    assert.equal(resolveLang(old, sys(['de-DE']), LANGS), 'en', String(old));
  }
  assert.equal(langSetting('auto', LANGS), 'auto');
  assert.equal(langSetting('pt-BR', LANGS), 'pt'); // a regional value kept by hand still means its language
});

test('auto is kept as auto and follows the system at each start', () => {
  const setting = langSetting('auto', LANGS);
  assert.equal(resolveLang(setting, sys(['ru-RU', 'en-US']), LANGS), 'ru'); // first start
  assert.equal(resolveLang(setting, sys(['es-ES', 'ru-RU']), LANGS), 'es'); // the user reordered the system's languages
  assert.equal(setting, 'auto');
});

test('first start with a fresh profile and with an old config without lang', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-lang-'));
  try {
    const load = () => createConfig({ platform: createFakePlatform({ userData: dir }) });
    let cfg = load().load(true);
    assert.equal(cfg.lang, 'auto');
    assert.equal(resolveLang(cfg.lang, sys(['pt-BR']), LANGS), 'pt');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ scale: 1, welcomed: true }));
    cfg = load().load(true);
    assert.equal(cfg.lang, 'auto');
    assert.equal(resolveLang(cfg.lang, sys(['ru-RU']), LANGS), 'ru');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ lang: 'de' }));
    cfg = load().load(true);
    assert.equal(resolveLang(cfg.lang, sys(['de-DE']), LANGS), 'en');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A dictionary's shape: its keys, deep, plural objects ({ one, other, ... }) counting as one value.
function shape(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'other' in value) return [prefix];
  return Object.entries(value).flatMap(([key, v]) => shape(v, prefix ? `${prefix}.${key}` : key)).sort();
}

test('every tray dictionary has the same keys, and Auto names the language it gives', () => {
  const keys = shape(TRAY.en);
  for (const code of LANGS) {
    const t = TRAY[code];
    assert.deepEqual(shape(t), keys, code);
    assert.deepEqual(Object.keys(t.langNames).sort(), [...LANGS].sort(), code);
    for (const other of LANGS) assert.ok(t.langNames[other], `${code}.langNames.${other}`);
    assert.equal(typeof t.auto, 'function', code);
    assert.ok(t.auto(t.langNames[code]).includes(t.langNames[code]), code);
  }
  assert.equal(TRAY.ru.auto(TRAY.ru.langNames.ru), 'Автоматически: русский');
  assert.equal(TRAY.en.auto(TRAY.en.langNames.en), 'Automatic: English');
});

test('her lines: same keys in every language, English for a language she does not speak', async () => {
  const { linesFor } = await import(pathToFileURL(path.resolve(__dirname, '../src/renderer/js/lines.js')).href);
  for (const assistant of ['claude', 'codex', 'agy']) {
    const keys = shape(linesFor('en', assistant));
    for (const code of LANGS) assert.deepEqual(shape(linesFor(code, assistant)), keys, `${assistant}:${code}`);
    for (const missing of ['de', '', undefined, 'auto']) {
      assert.deepEqual(linesFor(missing, assistant), linesFor('en', assistant), `${assistant}:${missing}`);
    }
  }
});
