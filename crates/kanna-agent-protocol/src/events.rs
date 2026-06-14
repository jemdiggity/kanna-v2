use serde::{Deserialize, Serialize};

#[cfg(feature = "typescript")]
use ts_rs::TS;

/// Maximum byte length for text payloads in journaled events.
///
/// Oversized payloads (tool output, raw lines) are truncated at translation
/// time so journals stay bounded by conversation length, not output volume.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// Truncate `text` to at most `MAX_TEXT_BYTES` on a char boundary.
///
/// Returns the (possibly shortened) text and whether truncation occurred.
pub fn truncate_text(text: String) -> (String, bool) {
    truncate_text_to(text, MAX_TEXT_BYTES)
}

/// Truncate `text` to at most `max_bytes` on a char boundary.
pub fn truncate_text_to(mut text: String, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    (text, true)
}

/// Statistics reported when a turn completes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct TurnStats {
    /// Wall-clock duration of the turn in milliseconds.
    #[serde(default)]
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
    pub duration_ms: u64,
    /// API-call duration in milliseconds, when the provider reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(type = "number | null"))]
    pub duration_api_ms: Option<u64>,
    /// Number of conversation turns so far.
    #[serde(default)]
    pub num_turns: u32,
    /// Total cost in USD, when the provider reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    /// Input tokens consumed, when the provider reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(type = "number | null"))]
    pub input_tokens: Option<u64>,
    /// Output tokens produced, when the provider reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(type = "number | null"))]
    pub output_tokens: Option<u64>,
}

/// How a completed turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum TurnStatus {
    Success,
    Error,
    MaxTurns,
    MaxBudget,
}

/// Why an agent session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum SessionEndReason {
    /// The provider process exited normally.
    Completed,
    /// The provider process exited with an error.
    Error,
    /// The session was interrupted by the user.
    Interrupted,
    /// The provider process died unexpectedly.
    Crashed,
}

/// A user's answer to a permission request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum PermissionDecision {
    /// Allow this single tool use.
    Allow,
    /// Allow this tool use and auto-allow matching requests for the rest of
    /// the session. The session-scoped rule is enforced by the daemon, not
    /// the provider.
    AllowSession,
    /// Deny the tool use, optionally telling the agent why.
    Deny {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// A provider-neutral agent session event.
///
/// This is the unit the daemon journals per session (with a sequence number)
/// and the only shape any consumer — desktop, kanna-server, relay, mobile —
/// ever sees. Provider adapters translate provider-specific output into these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum AgentEvent {
    /// A turn began (provider process started or accepted a new prompt).
    TurnStarted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// A user message entered the conversation (echo of input).
    UserMessage { text: String },
    /// Assistant prose output.
    AssistantText { text: String, truncated: bool },
    /// Assistant extended thinking.
    Thinking { text: String, truncated: bool },
    /// The assistant invoked a tool.
    ToolCall {
        call_id: String,
        tool_name: String,
        #[cfg_attr(feature = "typescript", ts(type = "unknown"))]
        input: serde_json::Value,
    },
    /// A tool finished and returned output.
    ToolResult {
        call_id: String,
        output: String,
        truncated: bool,
        is_error: bool,
    },
    /// Progress feedback while a tool runs.
    ToolProgress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        message: String,
    },
    /// The provider asked for permission to use a tool.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        #[cfg_attr(feature = "typescript", ts(type = "unknown"))]
        input: serde_json::Value,
    },
    /// A pending permission request was answered (by any attached client).
    PermissionResolved {
        request_id: String,
        decision: PermissionDecision,
    },
    /// A turn finished.
    TurnCompleted {
        status: TurnStatus,
        stats: TurnStats,
    },
    /// The provider process ended.
    SessionEnded {
        reason: SessionEndReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Non-conversational provider output (stderr lines, auth/rate-limit
    /// notices, error detail). Rendered in a collapsed debug section.
    Diagnostic { message: String },
    /// A provider output line the adapter did not recognize. Never dropped.
    Raw { line: String, truncated: bool },
}

impl AgentEvent {
    /// Wrap an unrecognized provider output line, truncating oversized input.
    pub fn raw(line: &str) -> Self {
        let (line, truncated) = truncate_text(line.to_string());
        AgentEvent::Raw { line, truncated }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_is_char_boundary_safe() {
        let s = "é".repeat(MAX_TEXT_BYTES); // 2 bytes per char
        let (out, truncated) = truncate_text(s);
        assert!(truncated);
        assert!(out.len() <= MAX_TEXT_BYTES);
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn truncation_leaves_short_text_alone() {
        let (out, truncated) = truncate_text("hello".to_string());
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    #[test]
    fn agent_event_serde_round_trip() {
        let events = vec![
            AgentEvent::TurnStarted {
                model: Some("claude-sonnet-4-6".into()),
            },
            AgentEvent::UserMessage {
                text: "fix the bug".into(),
            },
            AgentEvent::AssistantText {
                text: "Looking now.".into(),
                truncated: false,
            },
            AgentEvent::Thinking {
                text: "hmm".into(),
                truncated: false,
            },
            AgentEvent::ToolCall {
                call_id: "tu_1".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({"command": "ls"}),
            },
            AgentEvent::ToolResult {
                call_id: "tu_1".into(),
                output: "file.rs".into(),
                truncated: false,
                is_error: false,
            },
            AgentEvent::ToolProgress {
                call_id: Some("tu_1".into()),
                message: "running...".into(),
            },
            AgentEvent::PermissionRequest {
                request_id: "req_1".into(),
                tool_name: "Edit".into(),
                input: serde_json::json!({"file_path": "/x"}),
            },
            AgentEvent::PermissionResolved {
                request_id: "req_1".into(),
                decision: PermissionDecision::Deny {
                    reason: Some("not that file".into()),
                },
            },
            AgentEvent::TurnCompleted {
                status: TurnStatus::Success,
                stats: TurnStats {
                    duration_ms: 1200,
                    num_turns: 2,
                    total_cost_usd: Some(0.04),
                    ..TurnStats::default()
                },
            },
            AgentEvent::SessionEnded {
                reason: SessionEndReason::Completed,
                exit_code: Some(0),
                message: None,
            },
            AgentEvent::Diagnostic {
                message: "stderr noise".into(),
            },
            AgentEvent::Raw {
                line: "{\"type\":\"future\"}".into(),
                truncated: false,
            },
        ];

        for event in events {
            let json = serde_json::to_string(&event).unwrap();
            let back: AgentEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(event, back, "round-trip failed for {json}");
        }
    }

    #[test]
    fn tagging_matches_spec_naming() {
        let json = serde_json::to_value(AgentEvent::TurnStarted { model: None }).unwrap();
        assert_eq!(json["type"], "turn_started");

        let json = serde_json::to_value(AgentEvent::PermissionResolved {
            request_id: "r".into(),
            decision: PermissionDecision::Allow,
        })
        .unwrap();
        assert_eq!(json["type"], "permission_resolved");
        assert_eq!(json["decision"]["kind"], "allow");
    }
}
