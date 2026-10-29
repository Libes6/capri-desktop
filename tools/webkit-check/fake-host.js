// A fake host for the renderer, for pages opened outside Tauri (webkit-check). Answers with
// the test data the server put in window.__FAKE_DATA__, logs each command, and lets a probe push
// events: window.__fakeEmit('scope', 'capri:command', { name: 'status' }).
(() => {
  const D = window.__FAKE_DATA__;
  const listeners = { overlay: {}, settings: {} };
  const log = (scope, what, args) => console.log(`[fake-host ${scope}] ${what} ${JSON.stringify(args ?? '')}`.slice(0, 200));
  const same = (v) => Promise.resolve(v);

  const overlay = {
    getConfig: () => D.config, screens: () => D.screens, listSounds: () => [], hooksStatus: () => ({ installed: true }),
    cursor: () => ({ x: 400, y: 400, inside: true, display: 1 }), windowsNow: () => null, claudeFound: () => true,
    chatStatus: () => ({ ok: false, error: 'offline', provider: 'ollama' }), chatMemory: () => [], openApps: () => [],
    cpu: () => 10, setConfig: (patch) => ({ ...D.config, ...patch }), moveScreen: () => ({ ok: true }), demoWindow: () => false,
  };
  const settings = {
    view: () => D.view, set: (patch) => ({ ok: true, patch }), saveKey: () => ({ ok: true }), reset: () => ({ ok: true }),
    'updates.check': () => D.view.updates, 'updates.download': () => null, 'updates.install': () => null,
  };
  const table = { overlay, settings };

  const make = (scope) => ({
    invoke(name, args = []) {
      log(scope, name, args);
      const fn = table[scope][name];
      return same(fn ? fn(...args) : undefined);
    },
    on(event, cb) {
      (listeners[scope][event] ||= new Set()).add(cb);
      return () => listeners[scope][event].delete(cb);
    },
  });
  window.__CAPRI_HOST__ = { overlay: make('overlay'), settings: make('settings') };
  window.__fakeEmit = (scope, event, payload) => (listeners[scope][event] || []).forEach((cb) => cb(payload));
})();
