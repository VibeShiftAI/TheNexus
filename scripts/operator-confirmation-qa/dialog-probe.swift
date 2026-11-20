// Native probe for the operator-confirmation live check (task 5e513530).
//
//   dialog-probe session                     console lock state
//   dialog-probe window <pid> [waitSeconds]  the on-screen window owned by <pid>
//   dialog-probe read <pid> [waitSeconds]    the dialog's text and buttons (Accessibility)
//   dialog-probe press <pid> <title> [wait]  press the one button titled <title>
//
// <pid> must be the osascript child that live-check.cjs itself started; `read`
// and `press` refuse any other process (it must be an osascript child of the
// probe's own parent). Each mode prints one JSON line.
// `window` uses the window server list, which still answers while the screen
// is locked. `read` and `press` use Accessibility, which macOS withholds from
// windows behind the lock screen. That `press` works at all on an unlocked
// screen is the limit the contract documents: a same-user process holding the
// Accessibility permission can answer the dialog, so it proves a click, not
// who clicked.
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
    FileHandle.standardError.write(Data("usage: dialog-probe session | window <pid> [wait] | read <pid> [wait] | press <pid> <title> [wait]\n".utf8))
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

guard args.count >= 3, let pid = pid_t(args[2]), pid > 1 else { usage() }
let wanted = mode == "press" ? (args.count > 3 ? args[3] : "") : ""
let waitIndex = mode == "press" ? 4 : 3
let wait = args.count > waitIndex ? (Double(args[waitIndex]) ?? 6) : 6
let deadline = Date().addingTimeInterval(wait)
var report: [String: Any] = ["mode": mode, "pid": Int(pid)]

if mode == "window" {
    repeat {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        if let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }) {
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

guard ["read", "press"].contains(mode) else { usage() }
if mode == "press" && wanted.isEmpty { usage() }

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
// children of the API process, so this tool cannot read or answer them.
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
    let element: AXUIElement
}

func walk(_ element: AXUIElement, into items: inout [Item], depth: Int = 0) {
    guard depth < 12 else { return }
    let role = attribute(element, kAXRoleAttribute as String) as? String ?? ""
    let text = (attribute(element, kAXValueAttribute as String) as? String)
        ?? (attribute(element, kAXTitleAttribute as String) as? String) ?? ""
    items.append(Item(role: role, text: text, element: element))
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
if mode == "press" {
    let matches = items.filter { $0.role == kAXButtonRole as String && $0.text == wanted }
    guard matches.count == 1 else {
        report["error"] = "expected exactly one button titled \(wanted), found \(matches.count)"
        emit(report, code: 3)
    }
    let result = AXUIElementPerformAction(matches[0].element, kAXPressAction as CFString)
    report["press_result"] = Int(result.rawValue)
    if result == .success { report["pressed"] = wanted }
    emit(report, code: result == .success ? 0 : 4)
}
emit(report)
