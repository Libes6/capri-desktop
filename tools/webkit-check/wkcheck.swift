// TAURI-03: loads a page in a real WKWebView (the engine Tauri uses on macOS), prints its console
// output and errors, optionally evaluates a script, and saves a snapshot as PNG.
//   wkcheck --url URL --out file.png [--width 1280] [--height 800] [--wait 2500] [--eval 'js']
//           [--transparent] [--count-rect 'js returning [x,y,w,h]']
// --transparent: the web view draws no background, as the Tauri overlay does; the snapshot keeps its alpha.
// --count-rect: after the snapshot, counts the pixels with some alpha/non-background in that rectangle.
// Exit status 1 when the console had errors, 2 when the page failed to load.
import Cocoa
import WebKit

var url = "", out = "", evalJS = "", countRect = ""
var width = 1280.0, height = 800.0, waitMs = 2500.0
var transparent = false
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  switch a {
  case "--url": url = args.removeFirst()
  case "--out": out = args.removeFirst()
  case "--width": width = Double(args.removeFirst()) ?? width
  case "--height": height = Double(args.removeFirst()) ?? height
  case "--wait": waitMs = Double(args.removeFirst()) ?? waitMs
  case "--eval": evalJS = args.removeFirst()
  case "--count-rect": countRect = args.removeFirst()
  case "--transparent": transparent = true
  default: FileHandle.standardError.write("unknown arg \(a)\n".data(using: .utf8)!); exit(64)
  }
}

let capture = """
(function () {
  const post = (level, text) => window.webkit.messageHandlers.console.postMessage({ level, text: String(text) });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const old = console[level].bind(console);
    console[level] = (...a) => { post(level, a.map((x) => { try { return typeof x === 'string' ? x : (x instanceof Error ? (x.stack || x.message) : JSON.stringify(x)); } catch (e) { return String(x); } }).join(' ')); old(...a); };
  }
  window.addEventListener('error', (e) => post('error', 'uncaught: ' + e.message + ' @ ' + (e.filename || '') + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => post('error', 'unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  document.addEventListener('securitypolicyviolation', (e) => post('error', 'CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));
  window.addEventListener('error', (e) => { const t = e.target; if (t && t !== window && (t.src || t.href)) post('error', 'resource failed: ' + (t.src || t.href)); }, true);
})();
"""

class Handler: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  var errors = 0
  var failed = false
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any], let level = d["level"] as? String, let text = d["text"] as? String else { return }
    if level == "error" { errors += 1 }
    print("[console.\(level)] \(text)")
  }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("[load failed] \(e)"); failed = true }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { print("[load failed] \(e)"); failed = true }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { print("[console.error] web content process terminated"); errors += 1 }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let handler = Handler()
let config = WKWebViewConfiguration()
config.userContentController.add(handler, name: "console")
config.userContentController.addUserScript(WKUserScript(source: capture, injectionTime: .atDocumentStart, forMainFrameOnly: false))
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
view.navigationDelegate = handler
if transparent { view.setValue(false, forKey: "drawsBackground") }
let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.isOpaque = !transparent
window.backgroundColor = transparent ? .clear : .white
window.contentView = view
window.setFrameOrigin(NSPoint(x: 40, y: 40))
window.orderFrontRegardless()

func finish(_ code: Int32) -> Never { exit(code) }

func countPixels(_ image: NSImage, _ rect: [Double]) -> String {
  guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return "no image" }
  let scale = Double(cg.width) / width
  let rw = cg.width, rh = cg.height
  guard let ctx = CGContext(data: nil, width: rw, height: rh, bitsPerComponent: 8, bytesPerRow: rw * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return "no ctx" }
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: rw, height: rh))
  guard let data = ctx.data else { return "no data" }
  let p = data.bindMemory(to: UInt8.self, capacity: rw * rh * 4)
  let x0 = max(0, Int(rect[0] * scale)), y0 = max(0, Int(rect[1] * scale))
  let x1 = min(rw, Int((rect[0] + rect[2]) * scale)), y1 = min(rh, Int((rect[1] + rect[3]) * scale))
  var visible = 0, total = 0
  for y in y0..<max(y0, y1) { for x in x0..<max(x0, x1) {
    total += 1
    let i = (y * rw + x) * 4
    if p[i + 3] > 16 { visible += 1 }
  } }
  return "visible=\(visible) of \(total) pixels (alpha>16), image \(rw)x\(rh)"
}

func snapshot() {
  let cfg = WKSnapshotConfiguration()
  cfg.snapshotWidth = NSNumber(value: width)
  view.takeSnapshot(with: cfg) { image, error in
    guard let image = image else { print("[snapshot failed] \(String(describing: error))"); finish(2) }
    if !out.isEmpty, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
      try? png.write(to: URL(fileURLWithPath: out))
      print("[snapshot] \(out) \(Int(image.size.width))x\(Int(image.size.height))")
    }
    if countRect.isEmpty { print("[summary] console errors: \(handler.errors)"); finish(handler.failed ? 2 : (handler.errors > 0 ? 1 : 0)) }
    view.evaluateJavaScript(countRect) { r, e in
      if let r = r as? [Double] { print("[count-rect] \(r) -> \(countPixels(image, r))") } else { print("[count-rect failed] \(String(describing: r)) \(String(describing: e))") }
      print("[summary] console errors: \(handler.errors)")
      finish(handler.failed ? 2 : (handler.errors > 0 ? 1 : 0))
    }
  }
}

view.load(URLRequest(url: URL(string: url)!))
DispatchQueue.main.asyncAfter(deadline: .now() + waitMs / 1000) {
  if evalJS.isEmpty { snapshot(); return }
  view.callAsyncJavaScript(evalJS, arguments: [:], in: nil, in: .page) { result in
    switch result {
    case .success(let v): print("[eval] \(String(describing: v))")
    case .failure(let e): print("[eval failed] \(e)"); handler.errors += 1
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { snapshot() }
  }
}
app.run()
