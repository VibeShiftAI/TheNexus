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

/// Windows: the tabbed travel shell. One native window carrying three child
/// webviews — "chrome" (the local tab strip, the only webview with IPC),
/// plus "bridge" and "studio" content views that start on local loader pages
/// and hand over to the tunnel hostnames once they answer.
#[cfg(target_os = "windows")]
mod travel {
    use std::sync::Mutex;

    use tauri::{
        webview::{NewWindowFeatures, NewWindowResponse, WebviewBuilder},
        window::WindowBuilder,
        LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Rect, Size, Url,
        WebviewUrl, Window, WindowEvent, Wry,
    };

    /// Logical height of the tab strip, in CSS pixels.
    pub const TAB_BAR_HEIGHT: f64 = 46.0;

    /// Which content tab is showing: "bridge" or "studio".
    pub struct ActiveTab(pub Mutex<String>);

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

    /// Pin the tab strip across the top and fill the rest with content.
    /// Hidden webviews are laid out too, so switching tabs never re-flows.
    pub fn layout(window: &Window) {
        let Ok(size) = window.inner_size() else {
            return;
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let tab_h = ((TAB_BAR_HEIGHT * scale).round() as u32).min(size.height);
        for webview in window.webviews() {
            let bounds = if webview.label() == "chrome" {
                Rect {
                    position: Position::Physical(PhysicalPosition::new(0, 0)),
                    size: Size::Physical(PhysicalSize::new(size.width, tab_h)),
                }
            } else {
                Rect {
                    position: Position::Physical(PhysicalPosition::new(0, tab_h as i32)),
                    size: Size::Physical(PhysicalSize::new(
                        size.width,
                        size.height.saturating_sub(tab_h),
                    )),
                }
            };
            let _ = webview.set_bounds(bounds);
        }
    }

    pub fn build_travel_window(app: &tauri::App) -> tauri::Result<()> {
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
        window.add_child(
            WebviewBuilder::new("bridge", WebviewUrl::App("bridge.html".into()))
                .on_new_window(open_in_browser),
            content_pos,
            content_size,
        )?;
        let studio = window.add_child(
            WebviewBuilder::new("studio", WebviewUrl::App("studio.html".into()))
                .on_new_window(open_in_browser),
            content_pos,
            content_size,
        )?;
        studio.hide()?;

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

        Ok(())
    }

    #[tauri::command]
    pub fn switch_tab(window: Window, state: tauri::State<'_, ActiveTab>, tab: String) {
        if tab != "bridge" && tab != "studio" {
            return;
        }
        for webview in window.webviews() {
            match webview.label() {
                "chrome" => {}
                label if label == tab => {
                    let _ = webview.show();
                }
                _ => {
                    let _ = webview.hide();
                }
            }
        }
        *state.0.lock().unwrap() = tab;
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
        .manage(travel::ActiveTab(Mutex::new("bridge".into())))
        .invoke_handler(tauri::generate_handler![
            travel::switch_tab,
            travel::reload_active
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
