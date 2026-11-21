// Native probe for the operator-confirmation live check (task 5e513530).
//
//   dialog-probe session                    console lock state
//   dialog-probe window <pid> [waitSeconds] the on-screen window owned by <pid>, once it appears
//   dialog-probe watch <pid> [waitSeconds]  whether that window is still on screen after waitSeconds
//   dialog-probe read <pid> [waitSeconds]   the dialog's text and buttons (Accessibility, read only)
//
// The probe only looks. It has no mode that clicks, presses or types, so the
// live check cannot answer a dialog: an answer comes from a click on the
// dialog itself, and osascript reports it. Each mode prints one JSON line.
// `window` and `watch` use the window server list, which still answers while
// the screen is locked. `read` uses Accessibility, which macOS withholds from
// windows behind the lock screen, and it refuses any process but an osascript
// child of the probe's own parent (the harness), so it cannot read the live
// API's dialogs.
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ report: [String: Any], code: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func usage() -> Never {
    FileHandle.standardError.write(Data("usage: dialog-probe session | window <pid> [wait] | watch <pid> [wait] | read <pid> [wait]\n".utf8))
    exit(64)
}

let args = CommandLine.arguments
guard args.count >= 2 else { usage() }
let mode = args[1]

if mode == "session" {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    emit(["mode": mode,
          "locked": (session["CGSSessionScreenIsLocked"] as? Bool) ?? false,
          "on_console": (session[kCGSessionOnConsoleKey as String] as? Bool) ?? false])
}

guard ["window", "watch", "read"].contains(mode), args.count >= 3, let pid = pid_t(args[2]), pid > 1 else { usage() }
let wait = args.count > 3 ? (Double(args[3]) ?? 6) : 6
let started = Date()
let deadline = started.addingTimeInterval(wait)
var report: [String: Any] = ["mode": mode, "pid": Int(pid)]

func windowOf(_ pid: pid_t) -> [String: Any]? {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    return windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) })
}
func elapsedMs() -> Int { Int(Date().timeIntervalSince(started) * 1000) }

if mode == "window" {
    repeat {
        if let window = windowOf(pid) {
            report["found"] = true
            report["owner"] = window[kCGWindowOwnerName as String] as? String ?? ""
            report["layer"] = window[kCGWindowLayer as String] as? Int ?? -1
            report["window_id"] = window[kCGWindowNumber as String] as? Int ?? -1
            report["bounds"] = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
            emit(report)
        }
        if Date() >= deadline { break }
        usleep(100_000)
    } while true
    report["found"] = false
    emit(report)
}

if mode == "watch" {
    // Looks every 100 ms; reports as soon as the window is gone, or that it
    // was still there when `wait` seconds had passed.
    repeat {
        if windowOf(pid) == nil {
            report["still_open"] = false
            report["watched_ms"] = elapsedMs()
            emit(report)
        }
        if Date() >= deadline { break }
        usleep(100_000)
    } while true
    report["still_open"] = true
    report["watched_ms"] = elapsedMs()
    emit(report)
}

/// The kernel's record of `pid`, or nil once it is gone.
func kernelRecord(_ pid: pid_t) -> kinfo_proc? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info
}
func commandName(_ info: kinfo_proc) -> String {
    var name = info.kp_proc.p_comm
    let capacity = MemoryLayout.size(ofValue: name)
    return withUnsafePointer(to: &name) {
        $0.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) }
    }
}
// Accessibility only for a dialog the calling harness started itself: an
// osascript child of this probe's own parent. A live API's dialogs are
// children of the API process, so this tool cannot read them.
guard let target = kernelRecord(pid), target.kp_eproc.e_ppid == getppid(), commandName(target) == "osascript" else {
    report["error"] = "pid \(pid) is not an osascript dialog started by this probe's parent process"
    emit(report, code: 5)
}
report["trusted"] = AXIsProcessTrusted()

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var result: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}

struct Item {
    let role: String
    let text: String
}

func walk(_ element: AXUIElement, into items: inout [Item], depth: Int = 0) {
    guard depth < 12 else { return }
    let role = attribute(element, kAXRoleAttribute as String) as? String ?? ""
    let text = (attribute(element, kAXValueAttribute as String) as? String)
        ?? (attribute(element, kAXTitleAttribute as String) as? String) ?? ""
    items.append(Item(role: role, text: text))
    // Behind the lock screen macOS answers with the application element at
    // every level; stop instead of walking that echo.
    if role == kAXApplicationRole as String && depth > 0 { return }
    for child in (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] {
        walk(child, into: &items, depth: depth + 1)
    }
}

let app = AXUIElementCreateApplication(pid)
var items: [Item] = []
var dialog: AXUIElement?
repeat {
    for candidate in (attribute(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
        var found: [Item] = []
        walk(candidate, into: &found)
        let hasButton = found.contains { $0.role == kAXButtonRole as String }
        let hasText = found.contains { $0.role == kAXStaticTextRole as String && !$0.text.isEmpty }
        if hasButton && hasText { dialog = candidate; items = found; break }
    }
    if dialog != nil || Date() >= deadline { break }
    usleep(100_000)
} while true
guard let window = dialog else {
    report["error"] = "no readable dialog for this process within \(wait)s (Accessibility sees no buttons or text; the screen may be locked)"
    emit(report, code: 2)
}
report["title"] = attribute(window, kAXTitleAttribute as String) as? String ?? ""
report["texts"] = items.filter { $0.role == kAXStaticTextRole as String }.map { $0.text }
report["buttons"] = items.filter { $0.role == kAXButtonRole as String }.map { $0.text }
emit(report)
