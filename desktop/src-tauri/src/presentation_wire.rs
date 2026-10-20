//! Correlated native wire contract. Keep compatible with the shared
//! nexus-shared/src/presentations.ts contract without granting remote IPC.
use serde::Deserialize;
use serde_json::{json, Value};
use crate::presentation_policy::{self as policy, SessionState};

pub const MAX_REQUEST_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DisplayCommand {
    Discover { #[serde(rename = "requestId")] request_id: String },
    Status { #[serde(rename = "requestId")] request_id: String },
    Stop { #[serde(rename = "requestId")] request_id: String },
    WirelessPicker { #[serde(rename = "requestId")] request_id: String },
    Start {
        #[serde(rename = "requestId")] request_id: String,
        #[serde(rename = "targetId")] target_id: String,
        #[serde(rename = "sessionId")] session_id: String,
        #[serde(rename = "expiresAt")] expires_at: String,
    },
}

impl DisplayCommand {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Discover { request_id } | Self::Status { request_id }
            | Self::Stop { request_id } | Self::WirelessPicker { request_id }
            | Self::Start { request_id, .. } => request_id,
        }
    }
}

pub fn parse_request(raw: &str) -> Option<DisplayCommand> {
    if raw.len() > MAX_REQUEST_BYTES { return None; }
    let command: DisplayCommand = serde_json::from_str(raw).ok()?;
    if !policy::valid_id(command.request_id()) { return None; }
    if let DisplayCommand::Start { target_id, session_id, expires_at, .. } = &command {
        if !policy::valid_id(target_id) || !policy::valid_id(session_id) || policy::parse_iso_ms(expires_at).is_none() { return None; }
    }
    Some(command)
}

pub fn initialization_script(origin: &str) -> String {
    let origin = serde_json::to_string(origin).unwrap();
    format!("if (window.self === window.top && window.location.origin === {origin}) {{ Object.defineProperty(window, '__NEXUS_DISPLAYS__', {{ value: Object.freeze({{version:1,platform:'windows'}}), configurable:false, writable:false }}); }}")
}

pub fn result_script(origin: &str, result: &Value) -> String {
    let origin = serde_json::to_string(origin).unwrap();
    format!("if (window.self === window.top && location.origin === {origin}) window.dispatchEvent(new CustomEvent('nexus:display-result', {{ detail: {result} }}));")
}

pub fn state_name(state: SessionState) -> &'static str {
    match state {
        SessionState::Active => "active", SessionState::Stopped => "stopped",
        SessionState::Disconnected => "disconnected", SessionState::Expired => "expired",
        SessionState::Failed => "failed",
    }
}

pub fn status_result(request_id: &str, session: Option<(&str, SessionState, Option<&str>)>) -> Value {
    match session {
        Some((id, state, reason)) => {
            let mut result = json!({ "requestId": request_id, "ok": true,
                "sessionId": id, "state": state_name(state) });
            if let Some(reason) = reason { result["message"] = json!(reason); }
            result
        },
        None => json!({ "requestId": request_id, "ok": true, "sessionId": null, "state": "stopped" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_correlated_narrow_commands_without_arbitrary_urls() {
        let start = r#"{"requestId":"r-1","action":"start","targetId":"windows-monitor:abc","sessionId":"s-1","expiresAt":"2026-10-20T12:30:00.000Z"}"#;
        assert!(matches!(parse_request(start), Some(DisplayCommand::Start { .. })));
        for action in ["discover", "status", "stop", "wireless-picker"] {
            assert!(parse_request(&json!({"requestId":"r-2","action":action}).to_string()).is_some());
        }
        for value in [
            json!({"requestId":"r-1","action":"start","targetId":"t","sessionId":"s","expiresAt":"2026-10-20T12:30:00Z","url":"https://evil.test"}),
            json!({"requestId":"r-1","action":"stop","sessionId":"s"}),
            json!({"requestId":"r-1","action":"start","targetId":"t","sessionId":"s","expiresAt":"invalid"}),
            json!({"requestId":"r-1","action":"launch","url":"https://example.test"}),
            json!({"requestId":"","action":"discover"}),
            json!({"action":"discover"}),
        ] { assert!(parse_request(&value.to_string()).is_none(), "accepted {value}"); }
        assert!(parse_request(&" ".repeat(MAX_REQUEST_BYTES + 1)).is_none());
    }

    #[test]
    fn status_preserves_terminal_session_identity_and_omits_absent_messages() {
        let active = status_result("request-1", Some(("session-1", SessionState::Active, None)));
        assert_eq!(active, json!({"requestId":"request-1","ok":true,"sessionId":"session-1","state":"active"}));
        for state in [SessionState::Stopped, SessionState::Disconnected, SessionState::Expired, SessionState::Failed] {
            let result = status_result("request-2", Some(("session-1", state, Some("reason"))));
            assert_eq!(result["sessionId"], "session-1");
            assert_eq!(result["state"], state_name(state));
            assert_eq!(result["message"], "reason");
        }
        assert_eq!(status_result("request-3", None)["sessionId"], Value::Null);
    }
}
