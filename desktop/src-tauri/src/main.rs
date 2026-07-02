// The Nexus — native shell for the bridge dashboard.
//
// A Tauri v2 window (macOS WKWebView) that loads the local loader page, which
// hands over to http://localhost:3000 once the dashboard answers. The tray
// menu carries the ship-systems controls that need native power:
//   - Keep Mac awake: a real IOKit power assertion (display + idle sleep),
//     stronger than the browser Wake Lock the ambient mode holds.
//   - Always on top: pin the bridge over other windows.
//   - Reload bridge / Show window / Quit.
// Launch-at-login is enabled on first run via tauri-plugin-autostart
// (macOS LaunchAgent), consistent with the rest of the Praxis stack.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, MenuBuilder, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

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

/// Holds the live power assertion while "Keep Mac awake" is checked.
/// Dropping the guard releases the assertion.
struct AwakeState(Mutex<Option<power::AwakeGuard>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AwakeState(Mutex::new(None)))
        .setup(|app| {
            // Start on login — enable once; harmless if already enabled.
            let autostart = app.autolaunch();
            if let Ok(false) = autostart.is_enabled() {
                if let Err(err) = autostart.enable() {
                    eprintln!("[nexus] could not enable launch-at-login: {err}");
                }
            }

            let keep_awake =
                CheckMenuItem::with_id(app, "keep_awake", "Keep Mac awake", true, false, None::<&str>)?;
            let on_top =
                CheckMenuItem::with_id(app, "on_top", "Always on top", true, false, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload bridge", true, None::<&str>)?;
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
                                    eprintln!("[nexus] power assertion failed: IOKit status {status}");
                                    let _ = keep_awake_handle.set_checked(false);
                                }
                            }
                        } else {
                            *guard = None; // drop releases the assertions
                        }
                    }
                    "on_top" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let pinned = on_top_handle.is_checked().unwrap_or(false);
                            let _ = window.set_always_on_top(pinned);
                        }
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.location.reload()");
                        }
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
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
