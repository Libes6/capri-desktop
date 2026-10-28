'use strict';

// --smoke-test (npm run test:smoke): the real app runs, and once the overlay says it is up, her
// settings window is opened, a field is changed as a person would, and Escape closes it. This is
// the Electron shell's (it drives Electron's windows through platform.native), not the core's.

const fs = require('node:fs');
const { LANGS } = require('../labels');
const lang = require('../lang');

function createSmoke({ core, platform }) {
  const config = core.config;
  const overlayWin = () => platform.native.overlay();
  const { BrowserWindow } = platform.native.electron;
  // --smoke-test: her settings window opens with its sections, asking again brings back the same
  // one, Escape closes it, and the overlay is still there after.
  let settingsReady = null; // resolves the wait for the settings page to say it's up
  function waitSettingsReady(ms = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('settings page never got ready')), ms);
      settingsReady = (info) => {
        clearTimeout(timer);
        settingsReady = null;
        resolve(info);
      };
    });
  }
  // One field changed through the window as a person would (her volume slider): it must reach the
  // config, the file on disk, the overlay, and come back to the window in the status line.
  async function smokeSettingsChange(win) {
    const target = config.load().volume === 0.3 ? 0.5 : 0.3;
    await win.webContents.executeJavaScript(`(() => {
      const range = document.getElementById('field-volume');
      range.value = '${Math.round(target * 100)}';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const poll = async (check, what) => {
      for (let i = 0; i < 30; i++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`settings change: ${what}`);
    };
    await poll(() => config.load().volume === target, 'config not updated');
    await poll(() => JSON.parse(fs.readFileSync(config.file(), 'utf8')).volume === target, 'config file not written');
    await poll(async () => (await overlayWin().webContents.executeJavaScript('window.dev?.voice?.volume')) === target, 'overlay not updated');
    await poll(async () => (await win.webContents.executeJavaScript(
      `(() => { const s = document.getElementById('status'); return Boolean(s.textContent) && !s.classList.contains('settings__status--error') && document.getElementById('field-volume').value; })()`)) === String(Math.round(target * 100)), 'window did not say it was saved');
    return `volume=${target}`;
  }

  async function smokeSettings() {
    const settings = core.settings(); // made when the core started
    const ready = waitSettingsReady();
    const win = settings.open();
    const info = await ready;
    if (info?.sections !== 4) throw new Error(`settings shows ${info?.sections} sections`);
    if (settings.open() !== win) throw new Error('a second settings window opened');
    const windows = BrowserWindow.getAllWindows().length;
    // its fonts come through tokens.css (@import): they must load from the settings page too
    const fonts = await win.webContents.executeJavaScript(
      `Promise.all(['700 16px "Chakra Petch"', '400 13px "JetBrains Mono"'].map((f) => document.fonts.load(f).then((l) => l.length)))`);
    if (fonts.some((n) => !n)) throw new Error(`settings fonts did not load: ${fonts}`);
    // drawn again with the focus on a control: the focus stays on it
    await win.webContents.executeJavaScript(`document.getElementById('menu-general').focus()`);
    settings.update();
    const kept = await win.webContents.executeJavaScript(
      `new Promise((r) => setTimeout(() => r(document.activeElement?.id || null), 300))`);
    if (kept !== 'menu-general') throw new Error(`focus lost when the settings were drawn again (${kept})`);
    const changed = await smokeSettingsChange(win);
    // a field's hint is read with it: its display mode always says when it's taken into account
    const described = await win.webContents.executeJavaScript(`(() => {
      const ids = (document.getElementById('field-render')?.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      return ids.length > 0 && ids.every((id) => document.getElementById(id)?.textContent);
    })()`);
    if (!described) throw new Error('settings hints not tied to their fields (aria-describedby)');
    // shown first (ready-to-show may come after the page said it's ready), then Escape, sent again
    // until it lands: on Xvfb or a CI desktop a key can go before the window really has the focus
    if (!win.isVisible()) await new Promise((resolve) => { win.once('show', resolve); setTimeout(resolve, 5000); });
    let closed = false;
    win.once('closed', () => { closed = true; });
    for (let i = 0; i < 10 && !closed; i++) {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!closed) throw new Error('Escape did not close the settings window');
    if (settings.isOpen() || !overlayWin() || overlayWin().isDestroyed()) throw new Error('closing the settings touched the overlay');
    // opened again after closing: a new window, the one before is gone
    const again = waitSettingsReady();
    const second = settings.open();
    await again;
    if (second === win) throw new Error('the closed settings window came back');
    settings.close();
    console.log(`[capri] smoke settings: ok (sections=${info.sections}, focus=${info.focused}, windows=${windows}, ${changed})`);
  }


  // what the core tells the shell: the overlay is up, the settings page is up
  const notify = {
    rendererReady: () => {
      const cfg = config.load();
      console.log(`[capri] smoke ready: ${process.platform}/${process.arch} lang=${core.resolveLang(cfg.lang)} (${lang.langSetting(cfg.lang, LANGS)})`);
      smokeSettings().then(() => platform.app.quit(), (err) => {
        console.error('[capri] smoke settings failed:', err?.message ?? err);
        platform.app.exit(1);
      });
    },
    settingsReady: (info) => settingsReady?.(info),
  };

  return { notify };
}

module.exports = { createSmoke };
