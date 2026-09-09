// aic-fg —— 「本机侧因果归还前台」的观测/执行 helper（只在 macOS 上存在）。
// ## 协议（stdin 每行一条命令，stdout 每行一条 JSON 事件）
//   arm <ttlMs>   武装；ttl 到期自动解除
//   confirm       结果因到达
//   disarm        主动解除
//   ping          → {"t":"pong"}
// stdin 到 EOF（父进程退出）就自杀，不留孤儿。

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let CONFIRM_WINDOW_MS = 600.0

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
func esc(_ s: String) -> String {
  s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
}
func emit(_ fields: [(String, String)]) {
  let body = fields.map { "\"\($0.0)\":\($0.1)" }.joined(separator: ",")
  print("{\(body)}")
}
func str(_ s: String?) -> String { s == nil ? "null" : "\"\(esc(s!))\"" }
func num(_ d: Double) -> String { String(Int(d.rounded())) }

final class Guard: NSObject {
  var front: NSRunningApplication? = NSWorkspace.shared.frontmostApplication
  var armBase: NSRunningApplication?
  var armUntil: Double = 0
  var stealer: NSRunningApplication?
  var stealAt: Double = 0

  @objc func onActivate(_ n: Notification) {
    let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    front = app
    let t = nowMs()
    guard t <= armUntil, let base = armBase, let app else { return }
    if app.processIdentifier == base.processIdentifier {
      stealer = nil
      stealAt = 0
      return
    }
    stealer = app
    stealAt = t
    emit([("t", "\"steal\""), ("ms", num(t)), ("to", str(app.bundleIdentifier ?? app.localizedName))])
  }

  func arm(_ ttlMs: Double) {
    let t = nowMs()
    armUntil = t + ttlMs
    armBase = front
    stealer = nil
    stealAt = 0
    emit([("t", "\"armed\""), ("ms", num(t)), ("base", str(armBase?.bundleIdentifier ?? armBase?.localizedName)), ("until", num(armUntil))])
  }

  func disarm() {
    armUntil = 0
    armBase = nil
    stealer = nil
    stealAt = 0
    emit([("t", "\"disarmed\""), ("ms", num(nowMs()))])
  }

  func confirm() {
    let t = nowMs()
    func skip(_ why: String) { emit([("t", "\"skip\""), ("ms", num(t)), ("why", "\"\(why)\"")]) }
    if t > armUntil { return skip("not-armed") }
    guard let base = armBase else { return skip("no-base") }
    if stealAt == 0 { return skip("no-steal") }
    if t - stealAt > CONFIRM_WINDOW_MS { return skip("late") }
    if base.isTerminated { return skip("base-gone") }
    if let f = front, let s = stealer, f.processIdentifier != s.processIdentifier { return skip("moved") }
    let ok = base.activate(options: [])
    emit([
      ("t", "\"restore\""), ("ms", num(t)), ("to", str(base.bundleIdentifier ?? base.localizedName)),
      ("ok", ok ? "true" : "false"), ("stealMs", num(stealAt)), ("exposureMs", num(t - stealAt)),
    ])
    stealAt = 0
    stealer = nil
  }
}

let g = Guard()
NSWorkspace.shared.notificationCenter.addObserver(
  g, selector: #selector(Guard.onActivate(_:)),
  name: NSWorkspace.didActivateApplicationNotification, object: nil)

var inbuf = ""
FileHandle.standardInput.readabilityHandler = { fh in
  let d = fh.availableData
  if d.isEmpty { exit(0) }
  inbuf += String(decoding: d, as: UTF8.self)
  while let i = inbuf.firstIndex(of: "\n") {
    let line = String(inbuf[inbuf.startIndex..<i]).trimmingCharacters(in: .whitespaces)
    inbuf = String(inbuf[inbuf.index(after: i)...])
    let parts = line.split(separator: " ").map(String.init)
    guard let cmd = parts.first else { continue }
    DispatchQueue.main.async {
      switch cmd {
      case "arm": g.arm(parts.count > 1 ? (Double(parts[1]) ?? 5000) : 5000)
      case "confirm": g.confirm()
      case "disarm": g.disarm()
      case "ping": emit([("t", "\"pong\""), ("ms", num(nowMs()))])
      case "quit": exit(0)
      default: break
      }
    }
  }
}

emit([("t", "\"ready\""), ("ms", num(nowMs())), ("front", str(g.front?.bundleIdentifier ?? g.front?.localizedName)), ("pid", String(ProcessInfo.processInfo.processIdentifier))])
RunLoop.main.run()
