use kanna_agent_protocol::AgentProvider;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DaemonCommandError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl From<String> for DaemonCommandError {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TerminalSnapshotPayload {
    pub version: u32,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    #[serde(default = "default_cursor_visible")]
    pub cursor_visible: bool,
    #[serde(default = "default_saved_at")]
    pub saved_at: u64,
    #[serde(default = "default_sequence")]
    pub sequence: u64,
    pub vt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionRecoveryStatePayload {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(rename = "cursorRow")]
    pub cursor_row: u16,
    #[serde(rename = "cursorCol")]
    pub cursor_col: u16,
    #[serde(rename = "cursorVisible")]
    pub cursor_visible: bool,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
    pub sequence: u64,
}

fn default_cursor_visible() -> bool {
    true
}

fn default_saved_at() -> u64 {
    0
}

fn default_sequence() -> u64 {
    0
}

pub(super) const UNEXPECTED_ACK_EVENT_CODE: &str = "unexpected_ack_event";

/// Read the Ok/Error ack while already holding the lock.
pub(super) fn parse_error_event(event: &serde_json::Value) -> DaemonCommandError {
    DaemonCommandError {
        message: event
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("daemon error")
            .to_string(),
        code: event
            .get("code")
            .and_then(|c| c.as_str())
            .map(std::string::ToString::to_string),
    }
}

pub(super) fn parse_ack(response: &str) -> Result<(), DaemonCommandError> {
    let event: serde_json::Value = serde_json::from_str(response).unwrap_or_default();
    match event.get("type").and_then(|t| t.as_str()) {
        Some("Ok") => Ok(()),
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected ack event: {}", response),
            code: Some(UNEXPECTED_ACK_EVENT_CODE.to_string()),
        }),
    }
}

pub(super) fn is_retryable_command_error(error: &DaemonCommandError) -> bool {
    error.message.starts_with("failed to write command:")
        || error.message.starts_with("failed to flush command:")
        || error
            .message
            .starts_with("failed to connect to daemon socket:")
        || error.message == "daemon client unavailable"
}

pub(super) fn should_clear_daemon_client_after_error(error: &DaemonCommandError) -> bool {
    error.code.as_deref() == Some(UNEXPECTED_ACK_EVENT_CODE)
        || is_retryable_command_error(error)
        || error.message.starts_with("failed to read event:")
        || error.message == "connection closed by daemon"
}

pub(super) fn parse_agent_provider(
    agent_provider: Option<String>,
) -> Result<Option<String>, DaemonCommandError> {
    match agent_provider {
        Some(provider) => AgentProvider::from_str(&provider)
            .map(|_| Some(provider))
            .map_err(|message| DaemonCommandError {
                message,
                code: None,
            }),
        None => Ok(None),
    }
}

pub(super) fn parse_snapshot_response(
    response: &str,
) -> Result<TerminalSnapshotPayload, DaemonCommandError> {
    let event: serde_json::Value =
        serde_json::from_str(response).map_err(|e| DaemonCommandError {
            message: format!("failed to parse event: {}", e),
            code: None,
        })?;

    match event.get("type").and_then(|t| t.as_str()) {
        Some("Snapshot") => {
            serde_json::from_value(event.get("snapshot").cloned().ok_or_else(|| {
                DaemonCommandError {
                    message: "snapshot response missing payload".to_string(),
                    code: None,
                }
            })?)
            .map_err(|e| DaemonCommandError {
                message: format!("failed to parse snapshot payload: {}", e),
                code: None,
            })
        }
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected event: {}", response),
            code: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_retryable_command_error, parse_ack, parse_agent_provider, parse_snapshot_response,
        should_clear_daemon_client_after_error, DaemonCommandError, TerminalSnapshotPayload,
        UNEXPECTED_ACK_EVENT_CODE,
    };

    #[test]
    fn parse_agent_provider_uses_the_shared_protocol_registry() {
        for provider in kanna_agent_protocol::AgentProvider::ALL {
            assert_eq!(
                parse_agent_provider(Some(provider.as_str().to_string())).unwrap(),
                Some(provider.as_str().to_string())
            );
        }
        assert!(parse_agent_provider(Some("future-provider".to_string())).is_err());
    }

    #[test]
    fn parse_snapshot_response_defaults_cursor_visible_for_older_payloads() {
        let response = r#"{
            "type":"Snapshot",
            "session_id":"sess-1",
            "snapshot":{
                "version":1,
                "rows":24,
                "cols":80,
                "cursor_row":10,
                "cursor_col":5,
                "vt":"hello"
            }
        }"#;

        let snapshot = parse_snapshot_response(response).expect("snapshot should parse");

        assert_eq!(
            snapshot,
            TerminalSnapshotPayload {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 10,
                cursor_col: 5,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
                vt: "hello".to_string(),
            }
        );
    }

    #[test]
    fn parse_snapshot_response_preserves_recovery_metadata_when_present() {
        let response = r#"{
            "type":"Snapshot",
            "session_id":"sess-1",
            "snapshot":{
                "version":1,
                "rows":24,
                "cols":80,
                "cursor_row":10,
                "cursor_col":5,
                "cursor_visible":false,
                "saved_at":123,
                "sequence":7,
                "vt":"hello"
            }
        }"#;

        let snapshot = parse_snapshot_response(response).expect("snapshot should parse");
        assert_eq!(snapshot.saved_at, 123);
        assert_eq!(snapshot.sequence, 7);
    }

    #[test]
    fn parse_ack_rejects_unexpected_events() {
        let response = r#"{"type":"Output","session_id":"sess-1","data":[65]}"#;

        let error = parse_ack(response).expect_err("output is not a command ack");

        assert_eq!(
            error.message,
            r#"unexpected ack event: {"type":"Output","session_id":"sess-1","data":[65]}"#
        );
        assert_eq!(error.code.as_deref(), Some(UNEXPECTED_ACK_EVENT_CODE));
        assert!(!is_retryable_command_error(&error));
        assert!(should_clear_daemon_client_after_error(&error));
    }

    #[test]
    fn read_failures_are_not_retried_because_command_may_have_run() {
        let error = DaemonCommandError {
            message: "failed to read event: reset by peer".to_string(),
            code: None,
        };

        assert!(!is_retryable_command_error(&error));
        assert!(should_clear_daemon_client_after_error(&error));
    }

    #[test]
    fn stale_write_failures_are_retried_after_reconnect() {
        let error = DaemonCommandError {
            message: "failed to write command: Broken pipe (os error 32)".to_string(),
            code: None,
        };

        assert!(is_retryable_command_error(&error));
        assert!(should_clear_daemon_client_after_error(&error));
    }
}
