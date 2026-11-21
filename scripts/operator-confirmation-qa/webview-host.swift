// Webview host for the operator-confirmation live check (task 5e513530).
//
//   webview-host http://127.0.0.1:<port> http://127.0.0.1:<port>/check?client=webview
//
// Hosts the check page the way the desktop app hosts the dashboard on macOS
// (desktop/src-tauri/src/local_operator.rs, renew): the page loads in a
// WebKit webview; native code (not the page) then sends the bootstrap request
// with the dashboard Origin, plants the HttpOnly session cookie through the
// webview cookie API, and stores the proof with one evaluation that first
// checks the page origin, then fires `nexus:local-operator-ready`. The data
// store is non-persistent, so nothing outlives the run. The cookie and proof
// stay inside this process: nothing secret is passed on the command line or
// printed. live-check.cjs starts this binary and pins its process in place of
// the desktop app's code-signature pin, because the installed app only talks
// to the live :4000. It stands in for the desktop app; it is not the app, so
// its runs are component evidence for the webview path.
import AppKit
import Foundation
import WebKit

func log(_ line: String) {
    FileHandle.standardError.write(Data("[webview-host] \(line)\n".utf8))
}

/// Both URLs must be plain http on 127.0.0.1 and the same port.
func parseArguments() -> (page: URL, port: Int) {
    let arguments = CommandLine.arguments
    guard arguments.count == 3,
          let origin = URL(string: arguments[1]), let page = URL(string: arguments[2]),
          origin.scheme == "http", origin.host == "127.0.0.1", let port = origin.port,
          page.scheme == "http", page.host == "127.0.0.1", page.port == port else {
        log("usage: webview-host http://127.0.0.1:<port> http://127.0.0.1:<port>/check?client=webview")
        exit(64)
    }
    return (page, port)
}
let (page, port) = parseArguments()
let originText = "http://127.0.0.1:\(port)"
let proofCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

/// The native bootstrap: a plain HTTP request from this process, exactly one
/// session cookie and a well-formed proof, or nothing. It waits for an answer
/// as long as the desktop app's own bootstrap read does (12 seconds,
/// desktop/src-tauri/src/local_operator.rs, `set_read_timeout`).
func bootstrap(_ done: @escaping (HTTPCookie?, String?) -> Void) {
    let url = URL(string: "\(originText)/api/operator-session/bootstrap")!
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
    request.httpMethod = "POST"
    request.setValue(originText, forHTTPHeaderField: "Origin")
    request.httpBody = Data()
    let session = URLSession(configuration: .ephemeral)
    session.dataTask(with: request) { data, response, error in
        defer { session.finishTasksAndInvalidate() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 201, let data = data,
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let proof = body["proof"] as? String, proof.count == 43,
              proof.unicodeScalars.allSatisfy({ proofCharacters.contains($0) }) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            log("bootstrap refused (HTTP \(status)\(error.map { ", \($0.localizedDescription)" } ?? ""))")
            return done(nil, nil)
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).filter { $0.name == "nexus_local_operator" }
        guard cookies.count == 1, cookies[0].isHTTPOnly, cookies[0].path == "/api" else {
            log("bootstrap answered without exactly one HttpOnly /api session cookie")
            return done(nil, nil)
        }
        done(cookies[0], proof)
    }.resume()
}

final class Host: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var renewed = false
    var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Keep App Nap from stretching the run while the screen is locked.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "Nexus confirmation live check")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 960, height: 720), configuration: configuration)
        webView.navigationDelegate = self
        // Behind the lock screen every window counts as occluded, and WebKit
        // then suspends the hidden page while a request is pending. Treat the
        // window as visible, as it is when Robert uses the app.
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if webView.responds(to: occlusion) {
            typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(webView.method(for: occlusion), to: Setter.self)(webView, occlusion, false)
            log("window occlusion detection off, so the page stays active while the screen is locked")
        } else {
            log("window occlusion detection cannot be turned off on this WebKit")
        }
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 960, height: 720),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Nexus confirmation live check (synthetic, webview host)"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        log("loading the check page")
        webView.load(URLRequest(url: page))
        // Copy the page's own log lines (step ids and response codes, nothing
        // secret) into this process's log for the evidence. Reading it also
        // keeps the page process awake between steps. The harness ends this
        // process when it finishes; if the harness itself is gone (this
        // process was handed to launchd), stop too, however long the run was.
        let harness = getppid()
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            if getppid() != harness {
                log("the harness that started this host is gone; stopping")
                exit(3)
            }
            self?.mirrorPageLog()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    var mirrored = 0
    func mirrorPageLog() {
        webView.evaluateJavaScript("(document.getElementById('log') || {}).textContent || ''") { value, _ in
            guard let text = value as? String else { return }
            let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
            guard lines.count > self.mirrored else { return }
            for line in lines[self.mirrored...] { log("page: \(line)") }
            self.mirrored = lines.count
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !renewed else { return }
        renewed = true
        // As the desktop app does: renew only for the expected page origin.
        guard let url = webView.url, url.scheme == "http", url.host == "127.0.0.1", url.port == port else {
            log("the loaded page is not on \(originText); no session")
            return
        }
        bootstrap { cookie, proof in
            DispatchQueue.main.async {
                guard let cookie = cookie, let proof = proof else { return self.announce(proof: nil) }
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    log("bootstrap answered 201; HttpOnly session cookie planted in the webview store")
                    self.announce(proof: proof)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("page load failed: \(error.localizedDescription)")
    }

    /// The origin check and the store happen in one evaluation, so a
    /// navigation in between cannot hand the proof to another page.
    func announce(proof: String?) {
        let value = proof.map { "'\($0)'" } ?? "null"
        let script = """
        if (location.origin === '\(originText)') {
            let ok = false;
            try { const proof = \(value); if (proof) { localStorage.setItem('nexus:local-operator-proof', proof); ok = true; } } catch (_) {}
            window.dispatchEvent(new CustomEvent('nexus:local-operator-ready', { detail: ok }));
        }
        true;
        """
        webView.evaluateJavaScript(script) { _, error in
            log(error == nil ? "proof evaluation ran (stored: \(proof != nil))" : "proof evaluation failed: \(error!.localizedDescription)")
        }
    }
}

let app = NSApplication.shared
let host = Host()
app.delegate = host
app.setActivationPolicy(.accessory)
app.run()
