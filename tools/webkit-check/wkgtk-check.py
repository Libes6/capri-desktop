#!/usr/bin/env python3
"""TAURI-03: loads a page in WebKitGTK (the engine Tauri uses on Linux), prints console messages and
errors, runs an optional script, saves a PNG snapshot. Needs python3-gi, gir1.2-webkit2-4.1, xvfb.
  xvfb-run -a python3 wkgtk-check.py URL out.png [wait_ms] [sync_js_body_returning_a_string]
Exit 1 on console errors / JS exceptions, 2 on load failure."""
import sys, json
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, GLib, WebKit2

url, out = sys.argv[1], sys.argv[2]
wait = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
probe = sys.argv[4] if len(sys.argv) > 4 else ''
errors = 0
failed = False

CAPTURE = """
(function(){const post=(l,t)=>window.webkit.messageHandlers.console.postMessage(JSON.stringify({l:l,t:String(t)}));
for(const l of ['log','info','warn','error']){const o=console[l].bind(console);console[l]=(...a)=>{post(l,a.map(x=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch(e){return String(x)}}).join(' '));o(...a)}}
window.addEventListener('error',e=>post('error','uncaught: '+e.message+' @ '+e.filename+':'+e.lineno));
window.addEventListener('unhandledrejection',e=>post('error','unhandled rejection: '+(e.reason&&(e.reason.stack||e.reason.message)||e.reason)));
document.addEventListener('securitypolicyviolation',e=>post('error','CSP: '+e.violatedDirective+' '+e.blockedURI));})();
"""

mgr = WebKit2.UserContentManager()
mgr.register_script_message_handler('console')
mgr.add_script(WebKit2.UserScript(CAPTURE, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))

def on_message(_m, result):
    global errors
    d = json.loads(result.get_js_value().to_string())
    if d['l'] == 'error':
        errors += 1
    print('[console.%s] %s' % (d['l'], d['t']), flush=True)
mgr.connect('script-message-received::console', on_message)

view = WebKit2.WebView.new_with_user_content_manager(mgr)
view.get_settings().set_enable_webgl(True)
view.get_settings().set_enable_write_console_messages_to_stdout(False)
win = Gtk.OffscreenWindow()
win.set_default_size(1280, 800)
win.add(view)
win.show_all()

def on_load_failed(_v, _e, uri, err):
    global failed
    print('[load failed] %s %s' % (uri, err.message), flush=True)
    failed = True
    return False
view.connect('load-failed', on_load_failed)

def snapshot():
    def done(v, res):
        global errors
        surface = v.get_snapshot_finish(res)
        surface.write_to_png(out)
        print('[snapshot] %s' % out, flush=True)
        print('[summary] console errors: %d' % errors, flush=True)
        Gtk.main_quit()
        sys.exit(2 if failed else (1 if errors else 0))
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)
    return False

def run_probe():
    if not probe:
        return snapshot()
    def done(v, res):
        global errors
        try:
            val = v.run_javascript_finish(res).get_js_value().to_string()
            print('[eval] %s' % val, flush=True)
        except Exception as e:
            print('[eval failed] %s' % e, flush=True)
            errors += 1
        GLib.timeout_add(400, snapshot)
    view.run_javascript('(function(){' + probe + '})()', None, done)  # synchronous: WebKitGTK does not await a promise
    return False

view.load_uri(url)
GLib.timeout_add(wait, run_probe)
Gtk.main()
