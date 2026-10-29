// Watches the other windows on macOS so Capri can sit on them (prototype, CAPRI-08).
//
// Prints one JSON line on stdout whenever something changes: the window in front and the
// ordinary app windows on the current Space, front first, as frames in global points (origin at
// the top-left corner of the main display, y down: the same space as the DIP screen
// coordinates). No titles, no app names, no contents: only window numbers and rectangles.
//
// Uses CGWindowListCopyWindowInfo for geometry and z-order and NSWorkspace for the active app.
// Neither needs a permission: no Screen Recording (titles are never asked for), no Accessibility.
//
//   capri-windows [--self-window <id>]... [--exclude-pid <pid>]... [--parent <pid>]
//                 [--interval <ms>] [--watch-stdin] [--once] [--probe]
//
// --watch-stdin: exit when stdin reaches EOF (the parent holds a pipe; it closes when it dies).
//
// Build: swiftc -O -target arm64-apple-macos12.0 -o src/main/mac/bin/capri-windows src/main/mac/capri-windows.swift
//        (see docs/MAC_WINDOW_TRACKING.md)

import AppKit
import CoreGraphics
import Foundation

// MARK: arguments

var selfWindows = Set<UInt32>()
var excludedPids = Set<pid_t>([getpid()])
var parentPid: pid_t = 0
var intervalMs = 150.0
var once = false
var probe = false
var watchStdin = false

do {
  var args = CommandLine.arguments.dropFirst().makeIterator()
  while let arg = args.next() {
    switch arg {
    case "--self-window": if let v = args.next(), let n = UInt32(v) { selfWindows.insert(n) }
    case "--exclude-pid": if let v = args.next(), let n = Int32(v) { excludedPids.insert(n) }
    case "--parent": if let v = args.next(), let n = Int32(v) { parentPid = n }
    case "--interval": if let v = args.next(), let n = Double(v) { intervalMs = max(50, min(2000, n)) }
    case "--once": once = true
    case "--probe": probe = true
    case "--watch-stdin": watchStdin = true
    default:
      FileHandle.standardError.write("capri-windows: unknown argument \(arg)\n".data(using: .utf8)!)
      exit(2)
    }
  }
}

// MARK: snapshot

let minWidth = 200.0, minHeight = 120.0, maxWindows = 40

struct Display { let id: UInt32; let frame: CGRect; let visible: CGRect; let scale: Double }

// Displays in the same global top-left space as the windows. NSScreen gives the visible frame
// (without the menu bar and Dock) in Cocoa's bottom-left space; flipped against the main display.
func displays() -> [Display] {
  let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
  return NSScreen.screens.compactMap { screen in
    guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
    let id = number.uint32Value
    let v = screen.visibleFrame
    let visible = CGRect(x: v.minX, y: mainHeight - v.maxY, width: v.width, height: v.height)
    return Display(id: id, frame: CGDisplayBounds(id), visible: visible, scale: Double(screen.backingScaleFactor))
  }
}

func near(_ a: CGRect, _ b: CGRect, _ slack: CGFloat = 2) -> Bool {
  abs(a.minX - b.minX) <= slack && abs(a.minY - b.minY) <= slack
    && abs(a.width - b.width) <= slack && abs(a.height - b.height) <= slack
}

func int(_ v: CGFloat) -> Int { Int(v.rounded()) }

// The lock screen is up (or the login window of a switched-out session): window animations stall
// meanwhile and closed windows can linger in the list, so the snapshot says so and Capri ignores it.
func screenLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func snapshot() -> String {
  let screens = displays()
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let list = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []

  var fg: UInt32? = nil
  var wins: [String] = []
  for info in list {
    // layer 0: ordinary app windows. The menu bar, Dock, Capri's own overlay (screen-saver level),
    // panels and pop-up menus sit on other levels.
    guard (info[kCGWindowLayer as String] as? Int) == 0,
          let number = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
          let dict = info[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: dict)
    else { continue }
    if selfWindows.contains(number) || excludedPids.contains(pid) { continue }
    if let alpha = info[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
    // the front app's top window: it has focus (or the app has none of its own on screen)
    if fg == nil && pid == front { fg = number }
    if frame.width < minWidth || frame.height < minHeight || wins.count >= maxWindows { continue }
    let screen = screens.first { near($0.frame, frame) }
    let full = screen != nil
    let max = full || screens.contains { near($0.visible, frame, 4) }
    wins.append("{\"id\":\(number),\"x\":\(int(frame.minX)),\"y\":\(int(frame.minY)),\"w\":\(int(frame.width)),\"h\":\(int(frame.height)),\"max\":\(max),\"full\":\(full)}")
  }
  let ds = screens.map {
    "{\"id\":\($0.id),\"x\":\(int($0.frame.minX)),\"y\":\(int($0.frame.minY)),\"w\":\(int($0.frame.width)),\"h\":\(int($0.frame.height)),\"scale\":\($0.scale)}"
  }
  let fgJson = fg.map { String($0) } ?? "null"
  return "{\"v\":1,\"locked\":\(screenLocked()),\"fg\":\(fgJson),\"displays\":[\(ds.joined(separator: ","))],\"wins\":[\(wins.joined(separator: ","))]}"
}

// MARK: probe: what this process may see, without asking for anything

func runProbe() {
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
  let others = list.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value != getpid() }
  // kCGWindowName only comes with Screen Recording: counted, never printed
  let named = others.filter { ($0[kCGWindowName as String] as? String).map { !$0.isEmpty } ?? false }.count
  let report = [
    "\"screenRecording\":\(CGPreflightScreenCaptureAccess())", // preflight never prompts
    "\"accessibility\":\(AXIsProcessTrusted())",               // no options: never prompts
    "\"windows\":\(others.count)",
    "\"withTitles\":\(named)",
    "\"displays\":\(displays().count)",
  ]
  print("{\(report.joined(separator: ","))}")
}

// MARK: main loop

setvbuf(stdout, nil, _IOLBF, 0)
// NSScreen and NSWorkspace stay current only with an application object and a run loop; the
// helper never shows in the Dock or takes focus.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

if probe { runProbe(); exit(0) }
// one turn of the run loop first, or NSWorkspace does not know the front app yet
if once { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1)); print(snapshot()); exit(0) }

var last = ""
func tick() {
  let snap = snapshot()
  if snap != last {
    print(snap)
    last = snap
  }
}

// stop with Capri, even if she crashed without telling us: the pipe closes, or the parent is gone
if watchStdin {
  Thread.detachNewThread {
    while FileHandle.standardInput.availableData.count > 0 {}
    exit(0)
  }
}
var ticks = 0
Timer.scheduledTimer(withTimeInterval: intervalMs / 1000, repeats: true) { _ in
  ticks += 1
  if parentPid > 0 && ticks % 20 == 0 && (getppid() != parentPid || kill(parentPid, 0) != 0) { exit(0) }
  tick()
}
// app switches are reported at once rather than on the next tick
NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in tick() }
NotificationCenter.default.addObserver(
  forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in tick() }
tick()
RunLoop.main.run()
