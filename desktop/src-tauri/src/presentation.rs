//! Windows travel-shell display adapter. Remote pages get no Tauri commands.
//! The only entry is a cancelled, top-frame navigation from the configured
//! BRIDGE webview; output is an isolated, read-only renderer in the existing
//! WebView2 profile, with no shell or feedback initialization scripts.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::mpsc::{self, Receiver, SyncSender},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::{
    webview::NewWindowResponse, App, AppHandle, Manager, PhysicalPosition,
    PhysicalSize, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::presentation_policy::{self as policy, PhysicalBounds, SessionState, Target};
use crate::presentation_wire::{self as wire, DisplayCommand, MAX_REQUEST_BYTES, state_name};

const OUTPUT_LABEL: &str = "nexus-presentation";
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const WIRELESS_INSTRUCTIONS: &str = "Press Win+K to choose a Miracast-compatible display in Windows. Choose Extend with Win+P, then refresh displays here. Compatibility depends on the laptop and receiver. Chromecast and AirPlay are not native Windows monitor routes.";

#[derive(Clone)]
struct Bridge {
    label: String,
    origin: String,
}

pub struct NativeBridge {
    bridge: Option<Bridge>,
    sender: SyncSender<Work>,
}

enum Work {
    Request { label: String, raw: String },
    OutputClosed { session_id: String },
    OutputRejected { session_id: String },
    Poll,
}

#[derive(Clone)]
struct NativeTarget {
    target: Target,
    device_interface: String,
    gdi_name: String,
    primary: bool,
    limitations: Vec<String>,
}

struct Inventory {
    observed_ms: u64,
    expires_ms: u64,
    targets: Vec<NativeTarget>,
    limitations: Vec<String>,
}

struct Session {
    id: String,
    target: NativeTarget,
    expires_ms: u64,
    deadline: Instant,
    state: SessionState,
    reason: Option<&'static str>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn bounded_label(value: &str, fallback: &str) -> String {
    // The TypeScript contract counts UTF-16 code units, as JavaScript does.
    let mut units = 0;
    let text: String = value.chars().filter(|c| !c.is_control()).take_while(|c| {
        units += c.len_utf16();
        units <= 160
    }).collect();
    let trimmed = text.trim();
    if trimmed.is_empty() { fallback.into() } else { trimmed.into() }
}

/// Called after the roster resolves. Only the named BRIDGE tab may configure
/// this adapter; being another hosted tab never grants display access.
pub fn install(app: &App, bridge_tab: Option<(&str, &str)>) {
    let bridge = bridge_tab.and_then(|(label, raw_url)| {
        let url = Url::parse(raw_url).ok()?;
        if label != "bridge" || url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { return None; }
        Some(Bridge { label: label.into(), origin: url.origin().ascii_serialization() })
    });
    let (sender, receiver) = mpsc::sync_channel(16);
    app.manage(NativeBridge { bridge: bridge.clone(), sender });
    if let Some(bridge) = bridge {
        let handle = app.handle().clone();
        std::thread::spawn(move || worker(handle, bridge, receiver));
    }
}

pub fn initialization_script(app: &AppHandle, label: &str) -> Option<String> {
    let state = app.state::<NativeBridge>();
    let bridge = state.bridge.as_ref().filter(|bridge| bridge.label == label)?;
    // WebView2 runs initialization scripts in subframes too. Both checks are
    // necessary; the native callback independently checks the current URL.
    Some(wire::initialization_script(&bridge.origin))
}

/// Returns true for every presentation URL, including rejected ones, so a
/// malformed or untrusted request never becomes an external protocol launch.
pub fn intercept(app: &AppHandle, label: &str, url: &Url) -> bool {
    if url.scheme() != "nexus-shell" || url.host_str() != Some("presentation") { return false; }
    let state = app.state::<NativeBridge>();
    if state.bridge.as_ref().map(|bridge| bridge.label.as_str()) != Some(label) { return true; }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || !matches!(url.path(), "" | "/") || url.fragment().is_some() { return true; }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() == 1 && pairs[0].0 == "request" && pairs[0].1.len() <= MAX_REQUEST_BYTES {
        // No blocking operation inside WebView2's navigation callback. The
        // bounded worker rechecks the current document before doing any work.
        let _ = state.sender.try_send(Work::Request { label: label.into(), raw: pairs[0].1.to_string() });
    }
    true
}

fn trusted_view(app: &AppHandle, bridge: &Bridge, label: &str) -> bool {
    if bridge.label != label { return false; }
    app.get_webview(label).and_then(|view| view.url().ok()).map(|url| {
        // Tauri 2.11.5 / wry 0.55.1 bind this callback to WebView2's
        // NavigationStarting, not FrameNavigationStarting (top frame only).
        policy::bridge_admitted(&bridge.origin, &url.origin().ascii_serialization(), true)
            && url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
    }).unwrap_or(false)
}

fn reply(app: &AppHandle, bridge: &Bridge, label: &str, result: &Value) {
    if !trusted_view(app, bridge, label) { return; }
    let Some(view) = app.get_webview(label) else { return; };
    // Recheck in JS as well, in case navigation races the native URL check.
    let _ = view.eval(&wire::result_script(&bridge.origin, result));
}

fn failure(request_id: &str, code: &str, message: &str) -> Value {
    json!({ "requestId": request_id, "ok": false, "code": code, "message": message })
}

fn status(request_id: &str, session: &Option<Session>) -> Value {
    wire::status_result(request_id, session.as_ref().map(|session|
        (session.id.as_str(), session.state, session.reason)))
}

fn close_output(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OUTPUT_LABEL) {
        // Blank before native teardown; no dashboard navigation or placeholder
        // with operator controls is ever used on this window.
        let _ = window.eval("window.stop(); document.documentElement.replaceChildren(); document.documentElement.style.background='#000';");
        let _ = window.hide();
        let _ = window.destroy();
    }
}

fn poll_session(app: &AppHandle, source: &Result<String, String>, session: &mut Option<Session>) {
    let Some(active) = session.as_mut().filter(|session| session.state == SessionState::Active) else { return; };
    let expired = now_ms() >= active.expires_ms || Instant::now() >= active.deadline;
    let same_target = !expired && source.as_ref().ok().and_then(|source| enumerate(app, source).ok())
        .map(|inventory| inventory.targets.iter().any(|target| {
            target.target.available && target.target.id == active.target.target.id
                && target.device_interface.eq_ignore_ascii_case(&active.target.device_interface)
                && target.target.bounds == active.target.target.bounds
                && target.gdi_name == active.target.gdi_name
        })).unwrap_or(false);
    let same_window = app.get_webview_window(OUTPUT_LABEL).and_then(|window| window.current_monitor().ok().flatten())
        .and_then(|monitor| monitor.name().cloned()).as_deref() == Some(active.target.gdi_name.as_str());
    let next = policy::next_state(active.state, expired, same_target && same_window);
    if next != active.state {
        active.state = next;
        active.reason = Some(if expired { "Presentation expired. Start a new session to continue." }
            else { "The selected display disconnected or changed. Refresh displays and explicitly start again." });
        close_output(app);
    }
}

fn worker(app: AppHandle, bridge: Bridge, receiver: Receiver<Work>) {
    let source = installation_id(&app);
    let mut session: Option<Session> = None;
    loop {
        let work = receiver.recv_timeout(POLL_INTERVAL);
        match work {
            Err(mpsc::RecvTimeoutError::Disconnected) => { close_output(&app); return; }
            Err(mpsc::RecvTimeoutError::Timeout) | Ok(Work::Poll) => {
                poll_session(&app, &source, &mut session);
            },
            Ok(Work::OutputClosed { session_id }) => {
                if let Some(active) = session.as_mut().filter(|s| s.id == session_id && s.state == SessionState::Active) {
                    active.state = SessionState::Stopped;
                    active.reason = Some("Presentation window closed.");
                }
            }
            Ok(Work::OutputRejected { session_id }) => {
                if let Some(active) = session.as_mut().filter(|s| s.id == session_id && s.state == SessionState::Active) {
                    active.state = SessionState::Failed;
                    active.reason = Some("The presentation page tried to leave its allowed URL. Renew sign-in in the controller and start again if authentication expired.");
                    close_output(&app);
                }
            }
            Ok(Work::Request { label, raw }) => {
                poll_session(&app, &source, &mut session);
                if !trusted_view(&app, &bridge, &label) { continue; }
                let command = match wire::parse_request(&raw) {
                    Some(command) => command,
                    _ => {
                        if let Some(id) = serde_json::from_str::<Value>(&raw).ok().and_then(|v| v.get("requestId").and_then(Value::as_str).map(str::to_owned)).filter(|id| policy::valid_id(id)) {
                            reply(&app, &bridge, &label, &failure(&id, "invalid_request", "The display request is invalid."));
                        }
                        continue;
                    }
                };
                let request_id = command.request_id().to_string();
                let result = match command {
                    DisplayCommand::Status { .. } => status(&request_id, &session),
                    DisplayCommand::Stop { .. } => {
                        if let Some(active) = session.as_mut() {
                            active.state = SessionState::Stopped;
                            active.reason = Some("Stopped by the controller.");
                        }
                        close_output(&app);
                        status(&request_id, &session)
                    }
                    DisplayCommand::WirelessPicker { .. } => json!({ "requestId": request_id,
                        "ok": true, "code": "manual_wireless_picker", "message": WIRELESS_INSTRUCTIONS }),
                    DisplayCommand::Discover { .. } => match &source {
                        Ok(source) => match enumerate(&app, source) {
                            Ok(inventory) => json!({ "requestId": request_id, "ok": true, "inventory": inventory.to_wire(source) }),
                            Err(message) => failure(&request_id, "enumeration_failed", &message),
                        },
                        Err(message) => failure(&request_id, "source_identity_unavailable", message),
                    },
                    DisplayCommand::Start { target_id, session_id, expires_at, .. } => {
                        match &source {
                            Ok(source) => start(&app, &bridge, source, &request_id, &target_id, &session_id, &expires_at, &mut session),
                            Err(message) => failure(&request_id, "source_identity_unavailable", message),
                        }
                    }
                };
                reply(&app, &bridge, &label, &result);
            }
        }
    }
}

fn start(app: &AppHandle, bridge: &Bridge, source: &str, request_id: &str,
    target_id: &str, session_id: &str, expires_at: &str, session: &mut Option<Session>) -> Value {
    if !policy::valid_id(target_id) || !policy::valid_id(session_id) {
        return failure(request_id, "invalid_request", "Choose an exact display ID and a valid presentation session.");
    }
    let now = now_ms();
    let expires_ms = match policy::session_expiry(expires_at, now) {
        Ok(expiry) => expiry,
        Err(code) => return failure(request_id, code, "The presentation session has expired or has an invalid lifetime."),
    };
    if let Some(active) = session.as_ref().filter(|s| s.state == SessionState::Active) {
        if active.id == session_id && active.target.target.id == target_id && active.expires_ms == expires_ms {
            return status(request_id, session);
        }
        return failure(request_id, "active_session", "Stop the current presentation before starting another.");
    }
    // Always enumerate here. A stale UI inventory, friendly name, or recycled
    // adapter ordinal can never select a different receiver.
    let inventory = match enumerate(app, source) {
        Ok(inventory) => inventory,
        Err(message) => return failure(request_id, "enumeration_failed", &message),
    };
    let targets: Vec<_> = inventory.targets.iter().map(|target| target.target.clone()).collect();
    let selected = match policy::select_target(&targets, target_id, inventory.observed_ms, inventory.expires_ms, now_ms()) {
        Ok(index) => inventory.targets[index].clone(),
        Err(code) => return failure(request_id, code, if code == "single_display" {
            "Only one independent desktop display is available. Connect another display and choose Extend in Windows before presenting."
        } else { "The exact display is no longer available. Refresh the display list and select it again." }),
    };
    let page = policy::output_url(&bridge.origin, session_id).and_then(|url| Url::parse(&url).ok()).unwrap();
    close_output(app);
    let origin = bridge.origin.clone();
    let pinned_session = session_id.to_string();
    let navigation_sender = app.state::<NativeBridge>().sender.clone();
    // The default data directory is intentionally the existing shared
    // WebView2 profile. No cookies or credentials are copied into JS/URLs.
    let output = WebviewWindowBuilder::new(app, OUTPUT_LABEL, WebviewUrl::External(page))
        .title("Nexus presentation")
        .visible(false).focused(false).focusable(false)
        .decorations(false).resizable(false).skip_taskbar(true)
        .disable_drag_drop_handler().devtools(false)
        // Output never needs a bundled app page, including inside a frame.
        // Do not let one acquire a local origin's Tauri command privileges.
        .on_web_resource_request(|request, response| {
            let local_app_resource = Url::parse(&request.uri().to_string()).map(|url|
                url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
            ).unwrap_or(false);
            if local_app_resource {
                *response.status_mut() = tauri::http::StatusCode::FORBIDDEN;
                *response.body_mut() = Vec::<u8>::new().into();
            }
        })
        .on_navigation(move |url| {
            let admitted = policy::output_admitted(url.as_str(), &origin, &pinned_session);
            if !admitted {
                let _ = navigation_sender.try_send(Work::OutputRejected { session_id: pinned_session.clone() });
            }
            admitted
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build();
    let mut active = Session { id: session_id.into(), target: selected.clone(), expires_ms,
        deadline: Instant::now() + Duration::from_millis(expires_ms.saturating_sub(now_ms())),
        state: SessionState::Active, reason: None };
    let output = match output {
        Ok(window) => window,
        Err(_) => {
            active.state = SessionState::Failed;
            active.reason = Some("Windows could not create the presentation window.");
            *session = Some(active);
            let mut result = status(request_id, session);
            result["ok"] = json!(false);
            result["code"] = json!("window_failed");
            return result;
        }
    };
    let sender = app.state::<NativeBridge>().sender.clone();
    let closed_session = session_id.to_string();
    output.on_window_event(move |event| {
        let work = match event {
            WindowEvent::Destroyed => Work::OutputClosed { session_id: closed_session.clone() },
            WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => Work::Poll,
            _ => return,
        };
        let _ = sender.try_send(work);
    });
    let bounds = &selected.target.bounds;
    let placement = output.set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| output.set_size(PhysicalSize::new(bounds.width, bounds.height)))
        .and_then(|_| output.set_fullscreen(true));
    *session = Some(active);
    // Window creation may take time. Re-enumerate and compare the exact
    // identity and physical topology before exposing any output pixels.
    poll_session(app, &Ok(source.into()), session);
    if session.as_ref().unwrap().state == SessionState::Active {
        if placement.is_err() || output.show().is_err() {
            let active = session.as_mut().unwrap();
            active.state = SessionState::Failed;
            active.reason = Some("Windows could not place the output on the selected display.");
            close_output(app);
        }
    }
    let mut result = status(request_id, session);
    if session.as_ref().unwrap().state != SessionState::Active {
        result["ok"] = json!(false);
        result["code"] = json!(state_name(session.as_ref().unwrap().state));
    }
    result
}

impl Inventory {
    fn to_wire(&self, source: &str) -> Value {
        let observed = policy::iso_ms(self.observed_ms);
        let name = bounded_label(&std::env::var("COMPUTERNAME").unwrap_or_default(), "Windows travel shell");
        let targets: Vec<_> = self.targets.iter().map(|native| {
            let target = &native.target;
            let bounds = &target.bounds;
            json!({ "id": target.id, "name": target.name, "sourceDeviceId": source,
                "method": "windows-monitor", "availability": if target.available { "available" } else { "unavailable" },
                "observedAt": observed, "capabilities": ["ambient", "focus", "document", "day-plan"],
                "limitations": native.limitations, "isPrimary": native.primary,
                "bounds": { "x": bounds.x, "y": bounds.y, "width": bounds.width,
                    "height": bounds.height, "scaleFactor": bounds.scale_factor } })
        }).collect();
        json!({ "version": 1, "sourceDevice": { "id": source, "name": name, "platform": "windows" },
            "observedAt": observed, "expiresAt": policy::iso_ms(self.expires_ms),
            "status": if self.targets.iter().any(|target| target.target.available) { "available" } else { "unavailable" },
            "targets": targets, "limitations": self.limitations })
    }
}

fn enumerate(app: &AppHandle, source: &str) -> Result<Inventory, String> {
    let observed_ms = now_ms();
    let monitors = app.available_monitors().map_err(|_| "Windows display enumeration failed.".to_string())?;
    let primary = app.primary_monitor().ok().flatten().and_then(|monitor| monitor.name().cloned());
    let controller = app.get_window("main").and_then(|window| window.current_monitor().ok().flatten()).and_then(|monitor| monitor.name().cloned());
    let mut inventory = Inventory { observed_ms, expires_ms: observed_ms + policy::INVENTORY_TTL_MS,
        targets: Vec::new(), limitations: vec![
            "Lists displays attached to this Windows desktop, including wireless displays only after Windows connects them. It does not scan for Chromecast or AirPlay receivers.".into(),
            "Device identity is tied to this installation and the Windows monitor device interface. Changing ports, drivers or reinstalling can change it; refresh and select again.".into(),
        ] };
    let single = monitors.len() < 2;
    if single { inventory.limitations.push("Only one independent desktop display is available. Connect a second display and use Win+P > Extend; presentation is unavailable on a single or duplicated desktop.".into()); }
    if monitors.len() > policy::MAX_TARGETS { inventory.limitations.push("Only the first 32 desktop displays are reported.".into()); }
    for monitor in monitors.into_iter().take(policy::MAX_TARGETS) {
        let Some(gdi_name) = monitor.name() else { continue; };
        let devices = monitor_devices(gdi_name);
        let unambiguous = devices.len() == 1;
        if devices.is_empty() {
            if inventory.limitations.len() < 12 { inventory.limitations.push(format!("{} has no reliable Windows monitor identity and cannot be selected.", bounded_label(gdi_name, "Display"))); }
        }
        for (device_interface, description) in devices {
            if inventory.targets.len() >= policy::MAX_TARGETS { break; }
            let Some(id) = policy::target_id(source, &device_interface) else { continue; };
            if let Some(duplicate) = inventory.targets.iter_mut().find(|target| target.target.id == id) {
                duplicate.target.available = false;
                let message = "Windows reported a duplicate device identity. Selection is disabled.";
                if !duplicate.limitations.iter().any(|limitation| limitation == message) {
                    duplicate.limitations.push(message.into());
                }
                continue;
            }
            let position = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();
            if size.width == 0 || size.height == 0 || !scale.is_finite() || scale <= 0.0 { continue; }
            let mut limitations = vec!["Read-only presentation. Stop it from the controller; disconnecting or changing the selected display closes the output.".into()];
            if !unambiguous { limitations.push("Windows maps more than one monitor to this desktop surface. Switch to Extend and refresh; ambiguous output is disabled.".into()); }
            if single { limitations.push("A second independent desktop display is required.".into()); }
            if controller.as_ref() == Some(gdi_name) { limitations.push("This is the controller's current display. Presenting here covers that screen; move the controller to the other display first.".into()); }
            let name = bounded_label(&description, "Windows monitor");
            if description.trim().is_empty() || description.to_ascii_lowercase().contains("generic") {
                limitations.push("Windows supplied only a generic monitor name. Use its exact ID and bounds to distinguish it.".into());
            }
            inventory.targets.push(NativeTarget {
                target: Target { id, name, available: unambiguous && !single,
                    bounds: PhysicalBounds { x: position.x, y: position.y, width: size.width, height: size.height, scale_factor: scale } },
                device_interface, gdi_name: gdi_name.clone(), primary: primary.as_ref() == Some(gdi_name), limitations,
            });
        }
    }
    Ok(inventory)
}

#[repr(C)]
struct DisplayDevice {
    cb: u32,
    device_name: [u16; 32],
    device_string: [u16; 128],
    state_flags: u32,
    device_id: [u16; 128],
    device_key: [u16; 128],
}
const _: [(); 840] = [(); std::mem::size_of::<DisplayDevice>()];

#[link(name = "user32")]
extern "system" {
    fn EnumDisplayDevicesW(device: *const u16, index: u32, info: *mut DisplayDevice, flags: u32) -> i32;
}

fn wide_string(value: &[u16]) -> Option<String> {
    let end = value.iter().position(|c| *c == 0)?;
    String::from_utf16(&value[..end]).ok()
}

fn monitor_devices(gdi_name: &str) -> Vec<(String, String)> {
    let name: Vec<u16> = gdi_name.encode_utf16().chain(Some(0)).collect();
    let mut result = Vec::new();
    // Microsoft: EDD_GET_DEVICE_INTERFACE_NAME returns the OS-registered
    // per-monitor GUID_DEVINTERFACE_MONITOR path in DeviceID. Tauri's name
    // (\\.\DISPLAYn) is only the join key, never the persisted target ID.
    for index in 0..policy::MAX_TARGETS as u32 {
        let mut info: DisplayDevice = unsafe { std::mem::zeroed() };
        info.cb = std::mem::size_of::<DisplayDevice>() as u32;
        if unsafe { EnumDisplayDevicesW(name.as_ptr(), index, &mut info, 1) } == 0 { break; }
        if info.state_flags & 1 == 0 { continue; } // DISPLAY_DEVICE_ACTIVE
        let Some(identity) = wide_string(&info.device_id) else { continue; };
        if !identity.is_empty() {
            result.push((identity, wide_string(&info.device_string).unwrap_or_default()));
        }
    }
    result
}

#[repr(C)]
struct Guid { data1: u32, data2: u16, data3: u16, data4: [u8; 8] }

#[link(name = "ole32")]
extern "system" { fn CoCreateGuid(guid: *mut Guid) -> i32; }

fn installation_id(app: &AppHandle) -> Result<String, String> {
    let config = app.path().app_config_dir().map_err(|_| "The app configuration directory is unavailable.")?;
    fs::create_dir_all(&config).map_err(|_| "The display installation identity could not be stored.")?;
    let path = config.join("presentation-source-id");
    let read = || -> Result<String, String> {
        let id = fs::read_to_string(&path).map_err(|_| "The display installation identity could not be read.".to_string())?;
        if !id.starts_with("windows:") || !policy::valid_id(&id) { return Err("The stored display installation identity is invalid.".into()); }
        Ok(id)
    };
    if path.exists() { return read(); }
    let mut guid: Guid = unsafe { std::mem::zeroed() };
    if unsafe { CoCreateGuid(&mut guid) } < 0 { return Err("Windows could not create a display installation identity.".into()); }
    let id = format!("windows:{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid.data1, guid.data2, guid.data3, guid.data4[0], guid.data4[1], guid.data4[2], guid.data4[3], guid.data4[4], guid.data4[5], guid.data4[6], guid.data4[7]);
    match OpenOptions::new().create_new(true).write(true).open(&path) {
        Ok(mut file) => { file.write_all(id.as_bytes()).and_then(|_| file.sync_all()).map_err(|_| "The display installation identity could not be stored.")?; Ok(id) }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read(),
        Err(_) => Err("The display installation identity could not be stored.".into()),
    }
}
