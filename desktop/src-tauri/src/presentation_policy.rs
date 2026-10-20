//! Platform-independent display admission rules. The Windows adapter supplies
//! device-interface identities and physical coordinates; this module never
//! discovers displays on another host's behalf.

pub const INVENTORY_TTL_MS: u64 = 30_000;
pub const SESSION_TTL_MS: u64 = 30 * 60_000;
pub const MAX_TARGETS: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub struct PhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[derive(Clone, Debug)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub bounds: PhysicalBounds,
    pub available: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState { Active, Stopped, Disconnected, Expired, Failed }

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

pub fn target_id(source: &str, device_interface: &str) -> Option<String> {
    // EDD_GET_DEVICE_INTERFACE_NAME, never a GDI adapter ordinal such as
    // \\.\DISPLAY1. IDs are installation-scoped; paths never leave the shell.
    if !valid_id(source) || !device_interface.starts_with(r"\\?\") || device_interface.len() > 1024 {
        return None;
    }
    let key = format!("{source}\0{}", device_interface.to_ascii_lowercase());
    // FNV-1a 128 is an identifier, not an authentication token. Inventory also
    // rejects collisions; no session selection falls back to a friendly name.
    let mut hash: u128 = 0x6c62272e07bb014262b821756295c58d;
    for byte in key.bytes() {
        hash ^= byte as u128;
        hash = hash.wrapping_mul(0x0000000001000000000000000000013b);
    }
    Some(format!("windows-monitor:{hash:032x}"))
}

pub fn select_target(targets: &[Target], selection: &str, observed_ms: u64, expires_ms: u64, now_ms: u64) -> Result<usize, &'static str> {
    if expires_ms <= now_ms || observed_ms > now_ms || expires_ms <= observed_ms
        || expires_ms - observed_ms > INVENTORY_TTL_MS {
        return Err("stale_inventory");
    }
    let mut matches = targets.iter().enumerate().filter(|(_, target)| target.id == selection);
    let selected = matches.next().ok_or("target_not_found")?;
    if matches.next().is_some() { return Err("ambiguous_target"); }
    if targets.len() < 2 { return Err("single_display"); }
    if targets.len() > MAX_TARGETS || !selected.1.available { return Err("target_unavailable"); }
    Ok(selected.0)
}

/// Origins are canonical `Url::origin().ascii_serialization()` values from
/// native URL parsing. A caller must not pass an arbitrary URL as an origin.
pub fn bridge_admitted(configured_origin: &str, current_origin: &str, top_frame: bool) -> bool {
    top_frame && configured_origin.starts_with("https://") && current_origin == configured_origin
}

pub fn output_url(origin: &str, session_id: &str) -> Option<String> {
    if !origin.starts_with("https://") || !valid_id(session_id) { return None; }
    Some(format!("{origin}/presentation/index.html#mode=controller&session={session_id}"))
}

pub fn output_admitted(candidate: &str, origin: &str, session_id: &str) -> bool {
    if output_url(origin, session_id).as_deref() == Some(candidate) { return true; }
    let prefix = format!("blob:{origin}/");
    let Some(uuid) = candidate.strip_prefix(&prefix) else { return false; };
    uuid.len() == 36 && uuid.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

pub fn next_state(state: SessionState, expired: bool, same_target_and_geometry: bool) -> SessionState {
    if state != SessionState::Active { return state; }
    if expired { SessionState::Expired }
    else if !same_target_and_geometry { SessionState::Disconnected }
    else { state }
}

fn leap(year: u32) -> bool { year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) }
fn month_days(year: u32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 => Some(if leap(year) { 29 } else { 28 }),
        _ => None,
    }
}

pub fn parse_iso_ms(value: &str) -> Option<u64> {
    let b = value.as_bytes();
    if b.len() < 20 || b.len() > 30 || b[4] != b'-' || b[7] != b'-'
        || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b.last() != Some(&b'Z') {
        return None;
    }
    let number = |start: usize, end: usize| -> Option<u32> {
        let mut number = 0;
        for byte in b.get(start..end)? {
            if !byte.is_ascii_digit() { return None; }
            number = number * 10 + (byte - b'0') as u32;
        }
        Some(number)
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < 1970 || day == 0 || day > month_days(year, month)? || hour > 23 || minute > 59 || second > 59 { return None; }
    let fraction = if b.len() == 20 { 0 } else {
        if b[19] != b'.' || b.len() < 22 { return None; }
        let digits = b.len() - 21;
        let value = number(20, b.len() - 1)?;
        if digits <= 3 { value * 10u32.pow((3 - digits) as u32) }
        else { value / 10u32.pow((digits - 3) as u32) }
    };
    let mut days = 0u64;
    for y in 1970..year { days += if leap(y) { 366 } else { 365 }; }
    for m in 1..month { days += month_days(year, m)? as u64; }
    days += (day - 1) as u64;
    Some((((days * 24 + hour as u64) * 60 + minute as u64) * 60 + second as u64) * 1000 + fraction as u64)
}

pub fn iso_ms(value: u64) -> String {
    let mut days = value / 86_400_000;
    let mut year = 1970;
    loop {
        let length = if leap(year) { 366 } else { 365 };
        if days < length { break; }
        days -= length;
        year += 1;
    }
    let mut month = 1;
    while days >= month_days(year, month).unwrap() as u64 {
        days -= month_days(year, month).unwrap() as u64;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", days + 1,
        (value / 3_600_000) % 24, (value / 60_000) % 60, (value / 1000) % 60, value % 1000)
}

pub fn session_expiry(value: &str, now_ms: u64) -> Result<u64, &'static str> {
    let expiry = parse_iso_ms(value).ok_or("invalid_expiry")?;
    if expiry <= now_ms { return Err("expired"); }
    if expiry - now_ms > SESSION_TTL_MS { return Err("invalid_expiry"); }
    Ok(expiry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, name: &str) -> Target {
        Target { id: id.into(), name: name.into(), available: true,
            bounds: PhysicalBounds { x: -3840, y: 200, width: 3840, height: 2160, scale_factor: 2.0 } }
    }

    #[test]
    fn identity_uses_device_interface_and_installation_not_order_or_friendly_name() {
        let a = target_id("windows-installation-a", r"\\?\DISPLAY#ACM123#monitor-a").unwrap();
        let b = target_id("windows-installation-a", r"\\?\DISPLAY#ACM123#monitor-b").unwrap();
        assert_ne!(a, b);
        assert_ne!(a, target_id("windows-installation-b", r"\\?\DISPLAY#ACM123#monitor-a").unwrap());
        assert_eq!(a, target_id("windows-installation-a", r"\\?\display#acm123#MONITOR-A").unwrap());
        assert!(valid_id(&a));
        assert!(target_id("windows-installation-a", "").is_none());
        assert!(target_id("windows-installation-a", r"\\.\DISPLAY1").is_none());
    }

    #[test]
    fn exact_selection_never_guesses_same_friendly_names_and_preserves_physical_geometry() {
        let targets = vec![target("id-a", "Living Room TV"), target("id-b", "Living Room TV")];
        assert_eq!(select_target(&targets, "Living Room TV", 100, 30_100, 101), Err("target_not_found"));
        let selected = select_target(&targets, "id-b", 100, 30_100, 101).unwrap();
        assert_eq!(targets[selected].id, "id-b");
        assert_eq!(targets[selected].bounds.x, -3840);
        assert_eq!(targets[selected].bounds.width, 3840);
        let reordered = vec![targets[1].clone(), targets[0].clone()];
        assert_eq!(select_target(&reordered, "id-b", 100, 30_100, 101), Ok(0));
    }

    #[test]
    fn selection_fails_closed_for_stale_missing_duplicate_and_single_display() {
        let a = target("id-a", "Panel");
        let b = target("id-b", "TV");
        assert_eq!(select_target(&[a.clone(), b.clone()], "id-a", 100, 30_100, 30_100), Err("stale_inventory"));
        assert_eq!(select_target(&[a.clone(), b.clone()], "id-a", 100, 30_101, 101), Err("stale_inventory"));
        assert_eq!(select_target(&[a.clone(), b.clone()], "missing", 100, 30_100, 101), Err("target_not_found"));
        assert_eq!(select_target(&[a.clone(), a.clone()], "id-a", 100, 30_100, 101), Err("ambiguous_target"));
        assert_eq!(select_target(&[a.clone()], "id-a", 100, 30_100, 101), Err("single_display"));
        let mut unavailable = b;
        unavailable.available = false;
        assert_eq!(select_target(&[a, unavailable], "id-b", 100, 30_100, 101), Err("target_unavailable"));
    }

    #[test]
    fn bridge_requires_current_exact_https_origin_and_top_frame() {
        let origin = "https://nexus.vibeshiftai.com";
        assert!(bridge_admitted(origin, origin, true));
        for other in ["https://nexus.vibeshiftai.com.evil.test", "http://nexus.vibeshiftai.com", "https://nexus.vibeshiftai.com:444", "null"] {
            assert!(!bridge_admitted(origin, other, true));
        }
        assert!(!bridge_admitted(origin, origin, false));
        assert!(!bridge_admitted("null", "null", true));
    }

    #[test]
    fn output_only_admits_pinned_presentation_and_same_origin_blob_media() {
        let origin = "https://nexus.vibeshiftai.com";
        let page = output_url(origin, "session-1").unwrap();
        assert_eq!(page, "https://nexus.vibeshiftai.com/presentation/index.html#mode=controller&session=session-1");
        assert!(output_admitted(&page, origin, "session-1"));
        assert!(output_admitted("blob:https://nexus.vibeshiftai.com/01234567-89ab-cdef-0123-456789abcdef", origin, "session-1"));
        for other in ["https://nexus.vibeshiftai.com/", "https://nexus.vibeshiftai.com/presentation/index.html#mode=controller&session=other", "https://evil.test/presentation/index.html#mode=controller&session=session-1", "blob:https://nexus.vibeshiftai.com.evil.test/01234567-89ab-cdef-0123-456789abcdef", "blob:https://nexus.vibeshiftai.com/../../../", "tauri://localhost/index.html", "javascript:alert(1)"] {
            assert!(!output_admitted(other, origin, "session-1"), "admitted {other}");
        }
        assert!(output_url(origin, "session&mode=operator").is_none());
    }

    #[test]
    fn unplug_expiry_and_stop_are_terminal_until_an_explicit_new_start() {
        assert_eq!(next_state(SessionState::Active, false, true), SessionState::Active);
        assert_eq!(next_state(SessionState::Active, false, false), SessionState::Disconnected);
        assert_eq!(next_state(SessionState::Active, true, true), SessionState::Expired);
        for terminal in [SessionState::Stopped, SessionState::Disconnected, SessionState::Expired, SessionState::Failed] {
            assert_eq!(next_state(terminal, false, true), terminal);
        }
    }

    #[test]
    fn iso_timestamps_and_session_lifetimes_are_bounded_and_calendar_valid() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        for value in ["2026-10-20T12:34:56.789Z", "2024-02-29T23:59:59.000Z", "2000-02-29T00:00:00.001Z"] {
            assert_eq!(iso_ms(parse_iso_ms(value).unwrap()), value);
        }
        for invalid in ["2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+01:00", "invalid", "2026-01-01T00:00:00.Z"] {
            assert_eq!(parse_iso_ms(invalid), None, "accepted {invalid}");
        }
        let now = parse_iso_ms("2026-10-20T12:00:00.000Z").unwrap();
        assert_eq!(session_expiry("2026-10-20T12:30:00.000Z", now), Ok(now + SESSION_TTL_MS));
        assert_eq!(session_expiry("2026-10-20T12:30:00.001Z", now), Err("invalid_expiry"));
        assert_eq!(session_expiry("2026-10-20T12:00:00.000Z", now), Err("expired"));
    }
}
