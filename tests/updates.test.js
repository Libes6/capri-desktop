'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UpdateController, updateError, plainNotes, redact, releasePage, isReleasePage,
} = require('../src/main/updates');

const offer = (extra = {}) => ({ version: '0.2.0', notes: '<p>Fixes &amp; more</p>', tag: 'fork-v0.2.0', download: async (p) => p(5, 10), install: async () => {}, ...extra });

test('a build without updates stays disabled and never pretends to check, download or install', async () => {
  for (const reason of ['dev', 'smoke', 'feed']) {
    let checks = 0;
    const c = new UpdateController({ disabled: reason, transport: { check: async () => { checks++; return null; } } });
    await c.check();
    await c.download();
    await c.install(async () => true);
    assert.equal(c.status.kind, 'disabled');
    assert.equal(c.status.reason, reason);
    assert.equal(checks, 0);
  }
});

test('no newer version is "current" only after a check that succeeded', async () => {
  const seen = [];
  const c = new UpdateController({ transport: { check: async () => null }, current: '0.1.0', onChange: (v) => seen.push(v.kind) });
  assert.equal(c.status.kind, 'idle');
  await c.check();
  assert.deepEqual(seen, ['checking', 'current']);
  assert.equal(c.view().current, '0.1.0');
});

test('a network failure is an error to retry, never "current"; a retry can then say current', async () => {
  let offline = true;
  const c = new UpdateController({ transport: { check: async () => { if (offline) throw new Error('net::ERR_INTERNET_DISCONNECTED'); return null; } } });
  await c.check();
  assert.equal(c.status.kind, 'error');
  assert.equal(c.status.category, 'network');
  offline = false;
  await c.check();
  assert.equal(c.status.kind, 'current');
});

test('a feed not published yet (first release, 404) is an error, not "current"', async () => {
  const err = Object.assign(new Error('nothing is published for this system'), { reason: 'feed' });
  const c = new UpdateController({ transport: { check: async () => { throw err; } } });
  await c.check();
  assert.equal(c.status.kind, 'error');
  assert.equal(c.status.reason, 'feed');
  assert.equal(c.status.category, 'other');
});

test('install needs a verified download and a confirmation; declining keeps the download', async () => {
  let installs = 0;
  const c = new UpdateController({ transport: { check: async () => offer({ install: async () => { installs++; } }) } });
  await c.check();
  assert.equal(c.status.kind, 'available');
  assert.equal(c.view().notes, 'Fixes & more'); // HTML of the release notes → plain text
  await c.install(async () => true); // not downloaded yet
  assert.equal(installs, 0);
  await c.download();
  assert.equal(c.status.kind, 'downloaded');
  await c.install(async () => false);
  assert.equal(installs, 0);
  assert.equal(c.status.kind, 'downloaded');
  await c.install(async () => true);
  assert.equal(installs, 1);
  assert.equal(c.status.kind, 'installing');
});

test('a checksum/signature failure blocks installation', async () => {
  let installs = 0;
  const c = new UpdateController({
    transport: {
      check: async () => offer({
        download: async () => { throw Object.assign(new Error('sha512 checksum mismatch, expected abc, got def'), { code: 'ERR_CAPRI_SIGNATURE' }); },
        install: async () => { installs++; },
      }),
    },
  });
  await c.check();
  await c.download();
  assert.equal(c.status.kind, 'error');
  assert.equal(c.status.category, 'signature');
  await c.install(async () => true);
  assert.equal(installs, 0);
});

test('concurrent operations are refused; an install failure allows a new check', async () => {
  let release;
  let checks = 0;
  const c = new UpdateController({
    transport: {
      check: async () => {
        checks++;
        await new Promise((r) => { release = r; });
        return offer({ install: async () => { throw new Error('EACCES: permission denied'); } });
      },
    },
  });
  const first = c.check();
  await c.check();
  await new Promise((r) => setImmediate(r));
  await c.download();
  assert.equal(checks, 1);
  release();
  await first;
  const d1 = c.download();
  const d2 = c.download();
  await Promise.all([d1, d2]);
  assert.equal(c.status.kind, 'downloaded');
  // a second click on "Update and restart" while the dialog is open asks nothing more
  let asked = 0;
  const confirm = async () => { asked++; await new Promise((r) => setTimeout(r, 5)); return true; };
  await Promise.all([c.install(confirm), c.install(confirm)]);
  assert.equal(asked, 1);
  assert.equal(c.status.kind, 'error');
  const retry = c.check();
  await new Promise((r) => setImmediate(r)); // the transport asked again
  release();
  await retry;
  assert.equal(c.status.kind, 'available');
});

test('a new check releases the previous update (its download)', async () => {
  let closes = 0;
  const c = new UpdateController({ transport: { check: async () => offer({ close: async () => { closes++; } }) } });
  await c.check();
  await c.download();
  await c.check();
  assert.equal(closes, 1);
  assert.equal(c.status.kind, 'available');
});

test('notify mode (a .deb) shows the version and its page but downloads nothing', async () => {
  const c = new UpdateController({ mode: 'notify', transport: { check: async () => ({ version: '0.2.0', tag: 'fork-v0.2.0' }) } });
  await c.check();
  assert.equal(c.status.kind, 'available');
  assert.equal(c.view().canDownload, false);
  assert.equal(c.view().page, 'https://github.com/Libes6/capri-desktop/releases/tag/fork-v0.2.0');
  await c.download();
  assert.equal(c.status.kind, 'available');
});

test('errors are sorted by kind and carry no query strings or stacks', () => {
  assert.equal(updateError(new Error('getaddrinfo ENOTFOUND github.com')).category, 'network');
  assert.equal(updateError(new Error('HttpError: 503 Service Unavailable')).category, 'network');
  assert.equal(updateError(new Error('Update bundle version mismatch: 0.1.0 instead of 0.2.0')).category, 'signature');
  assert.equal(updateError(Object.assign(new Error('x'), { code: 'ERR_CAPRI_LOCATION' })).reason, 'location');
  assert.equal(updateError(new Error('EACCES')).category, 'other');
  const message = redact('failed https://objects.githubusercontent.com/a/b.zip?X-Amz-Signature=secret&token=1 here\n    at foo (bar.js:1)');
  assert.equal(message, 'failed https://objects.githubusercontent.com/a/b.zip here');
  assert.doesNotMatch(redact('Cannot parse releases feed: x,\nXML:\n<feed>secret</feed>'), /feed>/);
});

test('release notes become plain text, and only this repository\'s release pages open', () => {
  assert.equal(plainNotes('<h2>New</h2><ul><li>One &lt;b&gt;</li><li>Two&#33;</li></ul><script>x</script>'), 'New\n• One <b>\n• Two!');
  assert.equal(plainNotes([{ version: '0.2.0', note: 'A' }]), '0.2.0\nA');
  assert.equal(plainNotes(null), '');
  assert.equal(releasePage(null, '0.3.0'), 'https://github.com/Libes6/capri-desktop/releases/tag/fork-v0.3.0');
  assert.equal(isReleasePage(releasePage('fork-v0.3.0')), true);
  assert.equal(isReleasePage('https://github.com/Libes6/capri-desktop/releases/latest'), true);
  assert.equal(isReleasePage('https://evil.example/releases/tag/x'), false);
  assert.equal(isReleasePage('file:///etc/passwd'), false);
});

test('About shows the updater in every language, with all its texts', () => {
  const { settingsView } = require('../src/main/settings-view');
  const { SETTINGS, TRAY, LANGS } = require('../src/main/labels');
  const keys = Object.keys(SETTINGS.en).filter((k) => k.startsWith('upd')).sort();
  assert.ok(keys.length >= 20);
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(SETTINGS[lang]).filter((k) => k.startsWith('upd')).sort(), keys, lang);
    assert.match(TRAY[lang].updateAvailable('0.2.0'), /0\.2\.0/);
    const view = settingsView({ lang, cfg: {}, updates: { kind: 'available', version: '0.2.0', current: '0.1.0', mode: 'install' } });
    const about = view.sections.find((s) => s.id === 'about');
    const row = about.rows.find((r) => r.id === 'update');
    assert.equal(row.control.type, 'update');
    assert.equal(row.control.status.version, '0.2.0');
    for (const key of keys) assert.equal(typeof view.text[key], 'string', `${lang}.${key}`);
  }
  const without = settingsView({ lang: 'en', cfg: {} });
  assert.equal(without.sections.find((s) => s.id === 'about').rows.some((r) => r.id === 'update'), false);
});

