// The Nexus — native shell for the bridge dashboard.
//
// Two personalities, chosen at compile time:
//
//   macOS (home bridge station): a Tauri v2 window (WKWebView) that loads the
//   local loader page, which hands over to http://localhost:3000 once the
//   dashboard answers.
//
//   Windows (travel shell, for the ARM laptop): a tabbed cockpit that rides
//   the Cloudflare tunnel home. A thin tab strip (child webview, travel.html)
//   switches between BRIDGE (nexus.vibeshiftai.com, behind Cloudflare Access)
//   and GAYGUIDE YOUTUBE (gayguyde.vibeshiftai.com/admin/studio — the
//   TheGayGuyde video-production studio served from the Mac on :3777).
//
// The tray menu carries the ship-systems controls that need native power:
//   - Keep awake: IOKit power assertion on macOS (display + idle sleep);
//     SetThreadExecutionState on Windows.
//   - Always on top: pin the bridge over other windows.
//   - Reload / Show window / Quit.
// Launch-at-login is enabled on first run via tauri-plugin-autostart
// (LaunchAgent on macOS, registry Run key on Windows).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, MenuBuilder, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[cfg(target_os = "macos")]
const KEEP_AWAKE_LABEL: &str = "Keep Mac awake";
#[cfg(target_os = "windows")]
const KEEP_AWAKE_LABEL: &str = "Keep laptop awake";

#[cfg(target_os = "macos")]
const RELOAD_LABEL: &str = "Reload bridge";
#[cfg(target_os = "windows")]
const RELOAD_LABEL: &str = "Reload current tab";

/// IOKit power assertions — direct FFI instead of the keepawake crate, whose
/// apple-sys bindings don't compile on current Rust. Two assertions are held
/// while engaged: display sleep and system idle sleep.
#[cfg(target_os = "macos")]
mod power {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    type IOPMAssertionID = u32;
    const LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> i32;
    }

    pub struct AwakeGuard {
        ids: Vec<IOPMAssertionID>,
    }

    impl AwakeGuard {
        pub fn engage() -> Result<Self, i32> {
            let mut ids = Vec::new();
            for kind in ["PreventUserIdleDisplaySleep", "PreventUserIdleSystemSleep"] {
                let kind_cf = CFString::new(kind);
                let name_cf = CFString::new("The Nexus bridge keep-awake");
                let mut id: IOPMAssertionID = 0;
                let status = unsafe {
                    IOPMAssertionCreateWithName(
                        kind_cf.as_concrete_TypeRef(),
                        LEVEL_ON,
                        name_cf.as_concrete_TypeRef(),
                        &mut id,
                    )
                };
                if status == 0 {
                    ids.push(id);
                } else {
                    for created in &ids {
                        unsafe { IOPMAssertionRelease(*created) };
                    }
                    return Err(status);
                }
            }
            Ok(Self { ids })
        }
    }

    impl Drop for AwakeGuard {
        fn drop(&mut self) {
            for id in &self.ids {
                unsafe { IOPMAssertionRelease(*id) };
            }
        }
    }
}

/// SetThreadExecutionState keeps the laptop (and display) awake while the
/// returned guard lives. The flags are per-thread: both `engage` and the
/// drop run on the main thread (tray menu handler), so the ES_CONTINUOUS
/// bookkeeping stays consistent.
#[cfg(target_os = "windows")]
mod power {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(es_flags: u32) -> u32;
    }

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

    pub struct AwakeGuard;

    impl AwakeGuard {
        pub fn engage() -> Result<Self, i32> {
            let previous = unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
            };
            if previous == 0 {
                Err(0)
            } else {
                Ok(Self)
            }
        }
    }

    impl Drop for AwakeGuard {
        fn drop(&mut self) {
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}

/// Holds the live power assertion while "Keep … awake" is checked.
/// Dropping the guard releases the assertion.
struct AwakeState(Mutex<Option<power::AwakeGuard>>);

/// macOS: the classic single-webview bridge window.
#[cfg(target_os = "macos")]
fn build_bridge_window(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindowBuilder};

    // Main bridge window — built in code (not tauri.conf.json) so we
    // can attach the new-window handler: target=_blank links (e.g.
    // the [STATUS REPORT] cards in chat) open in the system default
    // browser. Without a handler WKWebView's new-window request goes
    // nowhere and the click is a silent no-op.
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("The Nexus")
        .inner_size(1512.0, 945.0)
        .min_inner_size(900.0, 600.0)
        .theme(Some(tauri::Theme::Dark))
        .on_new_window(|url, _features| {
            let scheme = url.scheme();
            if scheme == "http" || scheme == "https" {
                if let Err(err) = open::that(url.as_str()) {
                    eprintln!("[nexus] could not open {url} in the browser: {err}");
                }
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Windows: the tabbed travel shell. One native window carrying child
/// webviews — "chrome" (the local tab strip) plus one content webview per
/// entry in `TABS`, each starting on the local loader page and handing over
/// to its tunnel hostname once it answers. Local app pages get IPC; the
/// remote content that replaces them gets none.
#[cfg(target_os = "windows")]
mod travel {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use serde::Serialize;
    use tauri::{
        webview::{cookie::CookieBuilder, NewWindowFeatures, NewWindowResponse, WebviewBuilder},
        window::WindowBuilder,
        LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Rect,
        Size, Url, WebviewUrl, Window, WindowEvent, Wry,
    };

    /// Logical height of the tab strip, in CSS pixels.
    pub const TAB_BAR_HEIGHT: f64 = 46.0;

    /// One tab in the travel shell. `hosted` marks a page that renders the
    /// tab strip inside its own header (the bridge dashboard) — the native
    /// strip hides while such a tab is active, so the app shows ONE header.
    #[derive(Clone, Serialize, serde::Deserialize)]
    pub struct TabDef {
        pub id: String,
        pub label: String,
        pub url: String,
        pub accent: String,
        #[serde(default)]
        pub hosted: bool,
    }

    /// The resolved tab roster, fetched from `/api/tabs` at launch (so tab
    /// changes are a dashboard-settings edit, no rebuild) with these baked-in
    /// defaults as the offline fallback. First entry is the startup tab.
    pub struct Roster(pub Vec<TabDef>);

    /// Where the shell asks for its roster — same Access-gated hostname the
    /// updater uses, authorized by the same service token.
    const ROSTER_URL: &str = "https://nexus.vibeshiftai.com/api/tabs";

    /// Praxis feedback widget, mounted on every content tab so feedback can
    /// be filed from the road. The project/token pair must be registered in
    /// the relay's FEEDBACK_PROJECT_TOKENS (tokens route, they don't guard).
    const FEEDBACK_WIDGET_URL: &str = "https://vibeshiftai.com/feedback/widget.js";
    const FEEDBACK_PROJECT: &str = "the-nexus";
    const FEEDBACK_TOKEN: &str = "nx_pub_7381315e";

    /// Initialization script that mounts the feedback widget. Runs at
    /// document creation on every navigation in the webview: skips frames,
    /// the local loader, and pages that ship their own widget embed (their
    /// per-site config wins over the shell's generic one).
    fn feedback_widget_script(tab: &TabDef) -> String {
        format!(
            r#"(function () {{
  if (window.self !== window.top) return;
  if (location.protocol !== "https:") return;
  function mount() {{
    if (window.PraxisFeedback) return;
    if (document.querySelector("script[data-project][src*='widget']")) return;
    var s = document.createElement("script");
    s.defer = true;
    s.src = "{url}";
    s.dataset.project = "{project}";
    s.dataset.token = "{token}";
    s.dataset.position = "bottom-right";
    s.dataset.accent = "{accent}";
    s.dataset.label = "Send feedback to Praxis";
    s.dataset.appVersion = "travel-shell/{version}/{tab_id}";
    document.head.appendChild(s);
  }}
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", mount);
  }} else {{
    mount();
  }}
}})();"#,
            url = FEEDBACK_WIDGET_URL,
            project = FEEDBACK_PROJECT,
            token = FEEDBACK_TOKEN,
            accent = tab.accent,
            version = env!("CARGO_PKG_VERSION"),
            tab_id = tab.id,
        )
    }

    fn tab(id: &str, label: &str, url: &str, accent: &str, hosted: bool) -> TabDef {
        TabDef {
            id: id.into(),
            label: label.into(),
            url: url.into(),
            accent: accent.into(),
            hosted,
        }
    }

    /// Baked-in fallback roster — keep loosely in sync with DEFAULT_TABS in
    /// TheNexus/server/routes/tabs.js, which is what the shell normally gets.
    fn default_tabs() -> Vec<TabDef> {
        vec![
            tab("bridge", "BRIDGE", "https://nexus.vibeshiftai.com", "#22d3ee", true),
            tab("studio", "GAYGUIDE YOUTUBE", "https://gayguyde.vibeshiftai.com/admin/studio", "#f472b6", false),
            tab("families", "FAMILIES", "https://families.vibeshiftai.com", "#fbbf24", false),
            // Production Firebase Hosting — the same surface the phones use.
            // Public hostname, no tunnel or Access; device tokens gate it.
            tab("choresmaxxer", "CHORESMAXXER", "https://choresmaxxer.web.app", "#4ade80", false),
            tab("homefinder", "HOMEFINDER", "https://lab.vibeshiftai.com/p/nyc-home-finder", "#f87171", false),
            tab("lars", "LARS", "https://lars.vibeshiftai.com", "#facc15", false),
            tab("worlds", "WORLDS", "https://lab.vibeshiftai.com/p/impossible-worlds-field-guide", "#a78bfa", false),
            // THE LAB — the Project Hub: every board project's space, where
            // new experiments land before they earn a tab of their own.
            tab("lab", "THE LAB", "https://lab.vibeshiftai.com", "#e2e8f0", false),
        ]
    }

    /// A usable roster entry: sane id, https URL, #rrggbb accent. Anything
    /// else from the remote roster is dropped rather than trusted.
    fn tab_is_valid(tab: &TabDef) -> bool {
        !tab.id.is_empty()
            && tab.id.len() <= 32
            && tab.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !tab.label.trim().is_empty()
            && tab.label.len() <= 28
            && Url::parse(&tab.url).map(|u| u.scheme() == "https").unwrap_or(false)
            && tab.accent.len() == 7
            && tab.accent.starts_with('#')
            && tab.accent[1..].chars().all(|c| c.is_ascii_hexdigit())
    }

    /// Pull the roster from the node server, riding the Access service token.
    /// Any failure (no token, edge bounce, bad JSON) falls back to the baked
    /// defaults — a dead tunnel must never brick the shell.
    fn fetch_remote_tabs(app: &tauri::AppHandle) -> Option<Vec<TabDef>> {
        #[derive(serde::Deserialize)]
        struct RosterBody {
            tabs: Vec<TabDef>,
        }

        let token = read_service_token(app);
        let tls = native_tls::TlsConnector::new().ok()?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(std::sync::Arc::new(tls))
            .redirects(0)
            .timeout(Duration::from_secs(4))
            .build();
        let mut request = agent.get(ROSTER_URL);
        if let Some(token) = &token {
            request = request
                .set("CF-Access-Client-Id", &token.client_id)
                .set("CF-Access-Client-Secret", &token.client_secret);
        }
        let body = match request.call() {
            Ok(response) => response.into_string().ok()?,
            Err(err) => {
                eprintln!("[nexus] roster fetch failed ({ROSTER_URL}): {err}");
                return None;
            }
        };
        let parsed: RosterBody = match serde_json::from_str(&body) {
            Ok(parsed) => parsed,
            Err(err) => {
                eprintln!("[nexus] roster response is not JSON (Access bounce?): {err}");
                return None;
            }
        };
        let tabs: Vec<TabDef> = parsed.tabs.into_iter().filter(tab_is_valid).collect();
        if tabs.is_empty() {
            eprintln!("[nexus] remote roster had no usable tabs — using defaults");
            return None;
        }
        println!(
            "[nexus] roster from server: {}",
            tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join(", ")
        );
        Some(tabs)
    }

    /// Which content tab is showing (a `TabDef::id`).
    pub struct ActiveTab(pub Mutex<String>);

    /// Flipped once the Access service-token exchange finished (or was
    /// skipped — no token file, exchange failed). Loaders hold their first
    /// connection attempt on this so they never race the session cookie
    /// into an interactive Access login page.
    pub struct AuthGate(pub AtomicBool);

    /// Service-token credentials, dropped by hand on the travel laptop at
    /// %APPDATA%\com.praxis.nexus-bridge\access-token.json — never bundled
    /// into the (public-repo) binary. Used both to plant Access session
    /// cookies in the webviews and to authorize the self-updater's pull.
    #[derive(serde::Deserialize, Clone)]
    struct ServiceToken {
        client_id: String,
        client_secret: String,
    }

    /// Read the Access service token from the app config dir, if present.
    /// Absent file = interactive Access login (cookies) + unauthenticated
    /// updater pull (which Access will simply bounce) — both non-fatal.
    fn read_service_token(app: &tauri::AppHandle) -> Option<ServiceToken> {
        let path = app.path().app_config_dir().ok()?.join("access-token.json");
        let raw = std::fs::read_to_string(&path).ok()?;
        match serde_json::from_str(&raw) {
            Ok(token) => Some(token),
            Err(err) => {
                eprintln!("[nexus] {} is not valid JSON: {err}", path.display());
                None
            }
        }
    }

    /// target=_blank links (YouTube Studio, status-report cards) open in the
    /// system default browser instead of dying inside WebView2.
    fn open_in_browser(url: Url, _features: NewWindowFeatures) -> NewWindowResponse<Wry> {
        let scheme = url.scheme();
        if scheme == "http" || scheme == "https" {
            if let Err(err) = open::that(url.as_str()) {
                eprintln!("[nexus] could not open {url} in the browser: {err}");
            }
        }
        NewWindowResponse::Deny
    }

    /// Exchange the service token for a `CF_Authorization` session cookie:
    /// one request per host with the CF-Access-Client-Id/Secret headers;
    /// Access answers with the cookie when a Service Auth policy matches.
    /// Redirects stay off — the Set-Cookie is on the first response.
    fn fetch_access_cookie(agent: &ureq::Agent, host: &str, token: &ServiceToken) -> Option<String> {
        let result = agent
            .get(&format!("https://{host}/"))
            .set("CF-Access-Client-Id", &token.client_id)
            .set("CF-Access-Client-Secret", &token.client_secret)
            .call();
        let response = match result {
            Ok(response) => response,
            // 4xx/5xx still carries headers worth checking (and logging).
            Err(ureq::Error::Status(_, response)) => response,
            Err(err) => {
                eprintln!("[nexus] Access exchange request failed for {host}: {err}");
                return None;
            }
        };
        for header in response.all("set-cookie") {
            if let Some(rest) = header.strip_prefix("CF_Authorization=") {
                let value = rest.split(';').next().unwrap_or("").trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        eprintln!(
            "[nexus] no CF_Authorization cookie from {host} (status {}) — is the service token in a Service Auth policy on that app?",
            response.status()
        );
        None
    }

    /// Background startup pass: for every unique tab host, trade the service
    /// token for a session cookie and plant it in the shared WebView2 cookie
    /// store (any webview handle reaches the same profile). Silent no-op
    /// when no token file exists — tabs fall back to interactive login.
    fn exchange_and_inject(app: &tauri::AppHandle, window: &Window) {
        let Some(token) = read_service_token(app) else {
            println!("[nexus] no access-token.json — using interactive Access login");
            return;
        };
        let Some(chrome) = window.webviews().into_iter().find(|w| w.label() == "chrome") else {
            return;
        };
        let Ok(tls) = native_tls::TlsConnector::new() else {
            eprintln!("[nexus] could not initialize TLS for the Access exchange");
            return;
        };
        let agent = ureq::AgentBuilder::new()
            .tls_connector(std::sync::Arc::new(tls))
            .redirects(0)
            .timeout(Duration::from_secs(6))
            .build();

        let mut seen_hosts: Vec<String> = Vec::new();
        let tabs = app.state::<Roster>().0.clone();
        for tab in &tabs {
            let Some(host) = Url::parse(&tab.url).ok().and_then(|u| u.host_str().map(String::from))
            else {
                continue;
            };
            if seen_hosts.contains(&host) {
                continue;
            }
            seen_hosts.push(host.clone());
            let Some(jwt) = fetch_access_cookie(&agent, &host, &token) else {
                continue;
            };
            let cookie = CookieBuilder::new("CF_Authorization", jwt)
                .domain(host.clone())
                .path("/")
                .secure(true)
                .http_only(true)
                .build();
            match chrome.set_cookie(cookie) {
                Ok(()) => println!("[nexus] Access session planted for {host}"),
                Err(err) => eprintln!("[nexus] could not set Access cookie for {host}: {err}"),
            }
        }
    }

    /// Self-update: ask the tunnel endpoint (`plugins.updater.endpoints` in
    /// tauri.windows.conf.json) whether a newer signed build is published,
    /// carrying the Access service token so the request clears the same wall
    /// the tabs do. If so, prompt and install, then restart. Signature is
    /// verified against the baked-in pubkey before anything is applied, so a
    /// compromised endpoint can't ship an unsigned binary. Runs on its own
    /// thread — a slow or absent endpoint never delays the UI.
    fn check_for_updates(app: tauri::AppHandle) {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        use tauri_plugin_updater::UpdaterExt;

        let token = read_service_token(&app);
        let outcome = tauri::async_runtime::block_on(async {
            let mut builder = app.updater_builder();
            if let Some(token) = &token {
                builder = builder
                    .header("CF-Access-Client-Id", &token.client_id)?
                    .header("CF-Access-Client-Secret", &token.client_secret)?;
            }
            builder.build()?.check().await
        });

        let update = match outcome {
            Ok(Some(update)) => update,
            Ok(None) => {
                println!("[nexus] already up to date");
                return;
            }
            Err(err) => {
                eprintln!("[nexus] update check failed: {err}");
                return;
            }
        };

        let prompt = format!(
            "The Nexus {} is available (you have {}).\n\nDownload and install it now? The app will restart.",
            update.version, update.current_version
        );
        let accepted = app
            .dialog()
            .message(prompt)
            .title("The Nexus — update available")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if !accepted {
            println!("[nexus] update {} deferred by user", update.version);
            return;
        }

        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => {
                println!("[nexus] update installed; restarting");
                app.restart();
            }
            Err(err) => {
                eprintln!("[nexus] update install failed: {err}");
                let _ = app
                    .dialog()
                    .message(format!("The update could not be installed:\n{err}"))
                    .title("The Nexus")
                    .blocking_show();
            }
        }
    }

    /// True when the active tab's page hosts the strip itself (the bridge
    /// header) — the native strip stays hidden and content gets full height.
    fn active_tab_is_hosted(window: &Window) -> bool {
        let app = window.app_handle();
        let active = app.state::<ActiveTab>().0.lock().unwrap().clone();
        app.state::<Roster>()
            .0
            .iter()
            .find(|t| t.id == active)
            .map(|t| t.hosted)
            .unwrap_or(false)
    }

    /// Pin the tab strip across the top and fill the rest with content —
    /// unless the active tab hosts its own strip, in which case the native
    /// strip collapses and content takes the whole window (ONE header).
    /// Hidden webviews are laid out too, so switching tabs never re-flows.
    pub fn layout(window: &Window) {
        let Ok(size) = window.inner_size() else {
            return;
        };
        let hosted = active_tab_is_hosted(window);
        let scale = window.scale_factor().unwrap_or(1.0);
        let tab_h = if hosted {
            0
        } else {
            ((TAB_BAR_HEIGHT * scale).round() as u32).min(size.height)
        };
        for webview in window.webviews() {
            if webview.label() == "chrome" {
                let _ = if hosted { webview.hide() } else { webview.show() };
                let _ = webview.set_bounds(Rect {
                    position: Position::Physical(PhysicalPosition::new(0, 0)),
                    size: Size::Physical(PhysicalSize::new(size.width, tab_h.max(1))),
                });
            } else {
                let _ = webview.set_bounds(Rect {
                    position: Position::Physical(PhysicalPosition::new(0, tab_h as i32)),
                    size: Size::Physical(PhysicalSize::new(
                        size.width,
                        size.height.saturating_sub(tab_h),
                    )),
                });
            }
        }
    }

    /// The one true tab switch — used by the native strip's IPC command and
    /// the hosted header's intercepted `/__shell/switch/<id>` navigations.
    /// Shows/hides content webviews, re-lays-out (strip visibility can flip),
    /// and syncs the highlight in both the native strip and hosted headers.
    fn do_switch(window: &Window, tab: &str) {
        let app = window.app_handle();
        let roster = app.state::<Roster>();
        if !roster.0.iter().any(|t| t.id == tab) {
            return;
        }
        let hosted_ids: Vec<String> =
            roster.0.iter().filter(|t| t.hosted).map(|t| t.id.clone()).collect();
        *app.state::<ActiveTab>().0.lock().unwrap() = tab.to_string();
        for webview in window.webviews() {
            match webview.label() {
                "chrome" => {
                    let _ = webview.eval(&format!(
                        "window.__setActiveTab && window.__setActiveTab({});",
                        serde_json::to_string(tab).unwrap_or_default()
                    ));
                }
                label if label == tab => {
                    let _ = webview.show();
                }
                _ => {
                    let _ = webview.hide();
                }
            }
            if hosted_ids.iter().any(|id| id == webview.label()) {
                let js_id = serde_json::to_string(tab).unwrap_or_default();
                let _ = webview.eval(&format!(
                    "window.__NEXUS_SHELL__ && (window.__NEXUS_SHELL__.active = {js_id}, \
                     window.dispatchEvent(new CustomEvent('nexus-shell-active', {{ detail: {js_id} }})));"
                ));
            }
        }
        layout(window);
    }

    pub fn build_travel_window(app: &tauri::App) -> tauri::Result<()> {
        // Resolve the roster before any webview exists: server copy if the
        // tunnel answers (tab changes without a rebuild), baked-in defaults
        // otherwise. Managed state — everything else reads it from there.
        let tabs = fetch_remote_tabs(app.handle()).unwrap_or_else(default_tabs);
        app.manage(ActiveTab(Mutex::new(tabs[0].id.clone())));
        app.manage(Roster(tabs.clone()));

        let window = WindowBuilder::new(app, "main")
            .title("The Nexus")
            .inner_size(1400.0, 900.0)
            .min_inner_size(900.0, 600.0)
            .theme(Some(tauri::Theme::Dark))
            .build()?;

        // Rough initial bounds; layout() below sets the exact ones.
        let content_size = LogicalSize::new(1400.0, 900.0 - TAB_BAR_HEIGHT);
        let content_pos = LogicalPosition::new(0.0, TAB_BAR_HEIGHT);

        window.add_child(
            WebviewBuilder::new("chrome", WebviewUrl::App("travel.html".into())),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1400.0, TAB_BAR_HEIGHT),
        )?;

        // Hosted pages (the bridge) render the strip inside their own header:
        // they get the roster injected as `window.__NEXUS_SHELL__`, and their
        // tab clicks navigate to /__shell/switch/<id>, which we intercept
        // here and turn into a native switch — remote pages get no IPC.
        let shell_global = format!(
            "window.__NEXUS_SHELL__ = {{ tabs: {}, active: {} }};",
            serde_json::to_string(
                &tabs
                    .iter()
                    .map(|t| serde_json::json!({ "id": t.id, "label": t.label, "accent": t.accent }))
                    .collect::<Vec<_>>()
            )
            .unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&tabs[0].id).unwrap_or_default(),
        );

        for (index, tab) in tabs.iter().enumerate() {
            let mut builder = WebviewBuilder::new(tab.id.clone(), WebviewUrl::App("loader.html".into()))
                .initialization_script(&feedback_widget_script(tab))
                .on_new_window(open_in_browser);
            if tab.hosted {
                let nav_app = app.handle().clone();
                builder = builder
                    .initialization_script(&shell_global)
                    .on_navigation(move |url| {
                        let switch_target = if url.scheme() == "nexus-shell" {
                            url.host_str().map(String::from)
                        } else if let Some(rest) = url.path().strip_prefix("/__shell/switch/") {
                            Some(rest.trim_matches('/').to_string())
                        } else {
                            None
                        };
                        let Some(target) = switch_target else {
                            return true; // a real navigation — let it through
                        };
                        let handle = nav_app.clone();
                        let _ = nav_app.run_on_main_thread(move || {
                            if let Some(window) = handle.get_window("main") {
                                do_switch(&window, &target);
                            }
                        });
                        false // cancel — the "navigation" was a switch request
                    });
            }
            let webview = window.add_child(builder, content_pos, content_size)?;
            if index != 0 {
                webview.hide()?;
            }
        }

        layout(&window);
        let handle = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
            ) {
                layout(&handle);
            }
        });

        // Trade the Access service token for session cookies off the main
        // thread; loaders wait on the AuthGate before first contact.
        let app_handle = app.handle().clone();
        let window_handle = window.clone();
        std::thread::spawn(move || {
            exchange_and_inject(&app_handle, &window_handle);
            app_handle
                .state::<AuthGate>()
                .0
                .store(true, Ordering::Release);
        });

        // Look for a newer signed build on its own thread, after a short beat
        // so the window is up before any prompt appears.
        let updater_handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            check_for_updates(updater_handle);
        });

        Ok(())
    }

    /// Tab roster for the chrome strip.
    #[tauri::command]
    pub fn list_tabs(state: tauri::State<'_, Roster>) -> Vec<TabDef> {
        state.0.clone()
    }

    /// The calling webview's own tab entry — loaders ask who they are.
    #[tauri::command]
    pub fn tab_config(webview: tauri::Webview, state: tauri::State<'_, Roster>) -> Option<TabDef> {
        state.0.iter().find(|t| t.id == webview.label()).cloned()
    }

    /// True once the service-token exchange settled (either way).
    #[tauri::command]
    pub fn auth_ready(state: tauri::State<'_, AuthGate>) -> bool {
        state.0.load(Ordering::Acquire)
    }

    #[tauri::command]
    pub fn switch_tab(window: Window, tab: String) {
        do_switch(&window, &tab);
    }

    #[tauri::command]
    pub fn reload_active(window: Window, state: tauri::State<'_, ActiveTab>) {
        let active = state.0.lock().unwrap().clone();
        for webview in window.webviews() {
            if webview.label() == active {
                let _ = webview.eval("window.location.reload()");
            }
        }
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AwakeState(Mutex::new(None)));

    #[cfg(target_os = "windows")]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // ActiveTab + Roster are managed in build_travel_window, after the
        // roster is resolved (server copy or baked defaults).
        .manage(travel::AuthGate(std::sync::atomic::AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            travel::switch_tab,
            travel::reload_active,
            travel::list_tabs,
            travel::tab_config,
            travel::auth_ready
        ]);

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            build_bridge_window(app)?;
            #[cfg(target_os = "windows")]
            travel::build_travel_window(app)?;

            // Start on login — enable once; harmless if already enabled.
            let autostart = app.autolaunch();
            if let Ok(false) = autostart.is_enabled() {
                if let Err(err) = autostart.enable() {
                    eprintln!("[nexus] could not enable launch-at-login: {err}");
                }
            }

            let keep_awake = CheckMenuItem::with_id(
                app,
                "keep_awake",
                KEEP_AWAKE_LABEL,
                true,
                false,
                None::<&str>,
            )?;
            let on_top =
                CheckMenuItem::with_id(app, "on_top", "Always on top", true, false, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", RELOAD_LABEL, true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit The Nexus", true, None::<&str>)?;

            let menu = MenuBuilder::new(app)
                .item(&keep_awake)
                .item(&on_top)
                .separator()
                .item(&reload)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            let keep_awake_handle = keep_awake.clone();
            let on_top_handle = on_top.clone();

            TrayIconBuilder::with_id("nexus-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("The Nexus")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "keep_awake" => {
                        let enabled = keep_awake_handle.is_checked().unwrap_or(false);
                        let state = app.state::<AwakeState>();
                        let mut guard = state.0.lock().unwrap();
                        if enabled {
                            match power::AwakeGuard::engage() {
                                Ok(awake) => *guard = Some(awake),
                                Err(status) => {
                                    eprintln!("[nexus] power assertion failed: status {status}");
                                    let _ = keep_awake_handle.set_checked(false);
                                }
                            }
                        } else {
                            *guard = None; // drop releases the assertions
                        }
                    }
                    "on_top" => {
                        if let Some(window) = app.get_window("main") {
                            let pinned = on_top_handle.is_checked().unwrap_or(false);
                            let _ = window.set_always_on_top(pinned);
                        }
                    }
                    "reload" => {
                        if let Some(window) = app.get_window("main") {
                            #[cfg(target_os = "windows")]
                            let active =
                                app.state::<travel::ActiveTab>().0.lock().unwrap().clone();
                            for webview in window.webviews() {
                                #[cfg(target_os = "windows")]
                                if webview.label() != active {
                                    continue;
                                }
                                let _ = webview.eval("window.location.reload()");
                            }
                        }
                    }
                    "show" => {
                        if let Some(window) = app.get_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running The Nexus shell");
}
