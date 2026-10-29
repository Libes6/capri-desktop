'use strict';

// The sidecar's dev routes (127.0.0.1:CAPRI_PORT/debug/<route>), on only with CAPRI_DEBUG=1 (the
// Electron build's are shell/debug.js, --dev). For trying the Tauri shell without touching the real
// pointer or keyboard: her menu as the core has it, a click on an item, the settings window.
//   info                                     { pid, rendererReady, features } (the Tauri smoke test)
//   invoke    { scope, name, args }          a command of her pages through the dispatcher
//   power     { away } | { event }           her pause, without locking the screen
//   command   { name, ... }                  a command to her page, as her menu would send
//   menu      { click: 'label' }             her menu as labels; a click on the item with that label
//   popup                                    the menu at the pointer over her overlay
//   tray      { fire: 'id' }                 the menu as Rust holds it ({ icon, items }); a click on an id
//   settings  { open, close, js, key, ... }  her settings window: open/close, JavaScript run in its page
//                                            (the result), a key pressed in it ({ key: 'Escape' })

function createDebugHandler({ core, platform, seen = {} }) {
  const rust = (method, params = {}) => platform.debugRequest(method, params);
  const settings = () => core.settings();

  return async function debugHandler(route, body) {
    if (route === 'info') {
      return { ok: true, pid: process.pid, rendererReady: Boolean(seen.rendererReady), features: core.caps().all(), platform: process.platform };
    }
    if (route === 'invoke') {
      // a command of her pages through the dispatcher, as host_invoke does (the Tauri smoke test)
      const value = await core.dispatch.handle(String(body.name), Array.isArray(body.args) ? body.args : [], { label: body.scope === 'settings' ? 'settings' : 'overlay' });
      return { ok: true, value: value === undefined ? null : value };
    }
    if (route === 'power') {
      // her pause without locking anything (as the Electron shell's route): { away: true | false } held until
      // said otherwise, or { event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume' }
      if (typeof body.away === 'boolean') core.power()?.test(body.away);
      else if (body.event) core.power()?.emit(String(body.event));
      return { ok: true, value: core.power()?.state() ?? null };
    }
    if (route === 'command') {
      core.command(body.name, body);
      return { ok: true };
    }
    if (route === 'menu') {
      if (body.click) core.menu.click(body.click);
      return { ok: true, value: core.menu.labels() };
    }
    if (route === 'tray') {
      if (body.fire) await rust('tray.fire', { id: body.fire });
      return { ok: true, value: await rust('tray.describe') };
    }
    if (route === 'popup') {
      // right click on her (menu:open from the overlay): her menu opens at the pointer
      core.ipc.on['menu:open']?.(undefined, { label: 'overlay' });
      return { ok: true };
    }
    if (route === 'settings') {
      if (body.open === true) settings().open(body.section);
      if (body.open === false) settings().close();
      if (body.key && settings().isOpen()) {
        // a key pressed in its page, as a keydown on the focused element
        const init = JSON.stringify({ key: String(body.key), shiftKey: Boolean(body.shift), bubbles: true, cancelable: true });
        const js = `(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', ${init})); true`;
        return { ok: true, value: await rust('settings.eval', { js }) };
      }
      if (body.js && settings().isOpen()) return { ok: true, value: await rust('settings.eval', { js: String(body.js) }) };
      return { ok: true, value: settings().isOpen() };
    }
    throw new Error('unknown debug route');
  };
}

module.exports = { createDebugHandler };
