'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { systemLanguages, parseDefaultsList, parseLines, fromEnv, normalizeTag } = require('../src/main/platform/system-languages');
const lang = require('../src/main/lang');

test('tags: regions and encodings are cut, C and POSIX are nothing', () => {
  assert.equal(normalizeTag('ru_RU.UTF-8'), 'ru-RU');
  assert.equal(normalizeTag('de_DE@euro'), 'de-DE');
  assert.equal(normalizeTag('pt-BR'), 'pt-BR');
  assert.equal(normalizeTag('C'), null);
  assert.equal(normalizeTag('POSIX'), null);
  assert.equal(normalizeTag(''), null);
  assert.equal(normalizeTag('not a tag!'), null);
});

test('macOS: the list `defaults read -g AppleLanguages` prints, in order', () => {
  assert.deepEqual(parseDefaultsList('(\n    "ru-RU",\n    "en-RU"\n)\n'), ['ru-RU', 'en-RU']);
  assert.deepEqual(parseDefaultsList('(\n    "zh-Hans-CN",\n    en\n)'), ['zh-Hans-CN', 'en']);
  assert.deepEqual(parseDefaultsList(''), []);
});

test('Windows: one tag a line; Linux: LANGUAGE first, then LC_ALL, LC_MESSAGES, LANG', () => {
  assert.deepEqual(parseLines('fr-FR\r\nen-US\r\n'), ['fr-FR', 'en-US']);
  assert.deepEqual(fromEnv({ LANGUAGE: 'es_ES:en', LANG: 'en_US.UTF-8' }), ['es-ES', 'en', 'en-US']);
  assert.deepEqual(fromEnv({ LANG: 'C' }), []);
  assert.deepEqual(fromEnv({}), []);
});

test('systemLanguages asks the system where it keeps the list and never throws', async () => {
  const asked = [];
  const run = async (cmd, args) => { asked.push([cmd, ...args]); return cmd.endsWith('defaults') ? '(\n"ru-RU",\n"en-RU"\n)' : 'fr-FR\nen-US'; };
  assert.deepEqual(await systemLanguages({ platform: 'darwin', run }), ['ru-RU', 'en-RU']);
  assert.deepEqual(asked[0], ['/usr/bin/defaults', 'read', '-g', 'AppleLanguages']);
  assert.deepEqual(await systemLanguages({ platform: 'win32', run }), ['fr-FR', 'en-US']);
  assert.deepEqual(await systemLanguages({ platform: 'linux', env: { LANG: 'pt_BR.UTF-8' }, run }), ['pt-BR']);
  assert.deepEqual(await systemLanguages({ platform: 'darwin', run: async () => { throw new Error('no'); } }), []);
});

test('the list decides her language as in Electron: a Russian Mac gets Russian even without LANG', async () => {
  const preferred = await systemLanguages({ platform: 'darwin', run: async () => '("ru-RU", "en-RU")' });
  assert.equal(lang.resolveLang('auto', { preferred, fallback: ['en-US'] }, ['ru', 'en', 'fr', 'es', 'pt']), 'ru');
});
