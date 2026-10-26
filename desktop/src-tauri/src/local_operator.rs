//! Fixed, credential-free native bootstrap. The API verifies this executable's
//! running code and TCP peer. Page JS never receives a key or cookie value.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{webview::cookie::{CookieBuilder, SameSite}, Manager};

static RENEWING: AtomicBool = AtomicBool::new(false);
pub const INIT: &str = r#"if (window === window.top && location.origin === 'http://localhost:3000') {
    Object.defineProperty(window, '__NEXUS_LOCAL_OPERATOR__', {value: true});
}"#;

fn session_credentials(response: &str) -> Option<(String, String)> {
    let (headers, body) = response.split_once("\r\n\r\n")?;
    if !headers.lines().next()?.starts_with("HTTP/1.1 201 ") { return None; }
    let cookies: Vec<_> = headers.lines().filter_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("set-cookie") { return None; }
        value.trim().strip_prefix("nexus_local_operator=")
            .and_then(|v| v.split(';').next())
    }).collect();
    if cookies.len() != 1 { return None; }
    let token = cookies[0];
    let (id, signature) = token.split_once('.')?;
    if id.len() != 43 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || signature.len() != 64 || !signature.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return None; }
    let body: serde_json::Value = serde_json::from_str(body).ok()?;
    let proof = body.get("proof")?.as_str()?;
    if proof.len() != 43 || !proof.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return None; }
    Some((token.to_owned(), proof.to_owned()))
}

fn bootstrap() -> Option<(String, String)> {
    let address = "127.0.0.1:4000".parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(12))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    stream.write_all(b"POST /api/operator-session/bootstrap HTTP/1.1\r\nHost: localhost:4000\r\nOrigin: http://localhost:3000\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").ok()?;
    let mut response = String::new();
    stream.take(16384).read_to_string(&mut response).ok()?;
    session_credentials(&response)
}

pub fn renew(app: tauri::AppHandle) {
    if RENEWING.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        let proof = (|| {
            let view = app.get_webview_window("main")?;
            if view.url().ok()?.origin().ascii_serialization() != "http://localhost:3000" { return None; }
            let (token, proof) = bootstrap()?;
            let cookie = CookieBuilder::new("nexus_local_operator", token)
                .domain("localhost").path("/api").http_only(true)
                .same_site(SameSite::Strict).build();
            view.set_cookie(cookie).ok()?;
            Some(proof)
        })();
        RENEWING.store(false, Ordering::SeqCst);
        if let Some(view) = app.get_webview_window("main") {
            // Check the origin in the same evaluation that stores the proof:
            // navigation during bootstrap cannot leak it to a remote page.
            // The separate proof is port/origin-bound; the HttpOnly cookie and
            // operator key are never exposed to JavaScript.
            let value = serde_json::to_string(&proof).unwrap_or_else(|_| "null".into());
            let _ = view.eval(&format!(r#"if (location.origin === 'http://localhost:3000') {{
                let ok = false;
                try {{ const proof = {value}; if (proof) {{ localStorage.setItem('nexus:local-operator-proof', proof); ok = true; }} }} catch (_) {{}}
                window.dispatchEvent(new CustomEvent('nexus:local-operator-ready', {{detail: ok}}));
            }}"#));
        }
        if proof.is_none() { eprintln!("[nexus] local operator session unavailable"); }
    });
}

#[cfg(test)]
mod tests {
    use super::session_credentials;
    #[test]
    fn only_a_successful_well_formed_cookie_can_be_planted() {
        let token = format!("{}.{}", "a".repeat(43), "b".repeat(64));
        let proof = "c".repeat(43);
        let response = format!("HTTP/1.1 201 Created\r\nSet-Cookie: nexus_local_operator={token}; HttpOnly; Path=/api\r\n\r\n{{\"proof\":\"{proof}\"}}");
        assert_eq!(session_credentials(&response), Some((token, proof)));
        assert_eq!(session_credentials(&response.replace("201 Created", "403 Forbidden")), None);
        assert_eq!(session_credentials(&response.replace("nexus_local_operator=", "unrelated=")), None);
        assert_eq!(session_credentials(&response.replace(&"b".repeat(64), "invalid")), None);
        assert_eq!(session_credentials("HTTP/1.1 201 Created\r\n\r\n"), None);
    }
}
