//! Kanna Stream Protocol (KSP) frames.
//!
//! One multiplexed WebSocket per client carries every stream and request,
//! with task-id-tagged JSON frames. The same frames flow over localhost
//! (local desktop), the LAN port (LAN clients), and the relay tunnel (cloud
//! clients) — the transport is the only difference.
//!
//! Frames are task-addressed: kanna-server owns the task → daemon-session
//! lookup; clients never see daemon session ids.

use serde::{Deserialize, Serialize};

#[cfg(feature = "typescript")]
use ts_rs::TS;

use crate::events::{AgentEvent, PermissionDecision};

/// Which stream of a task to attach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum StreamKind {
    Agent,
    Terminal,
}

/// A journaled agent event paired with its sequence number (wire mirror of
/// the daemon's journal entries).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct FrameAgentEvent {
    pub seq: u64,
    pub event: AgentEvent,
}

/// Frames sent by clients to kanna-server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum ClientFrame {
    /// First frame on every connection. Localhost connections from the
    /// owning desktop may pass no credential; LAN/tunnel clients pass the
    /// pairing credential or identity token.
    Auth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credential: Option<String>,
    },
    /// Attach to a task's stream; agent streams replay journal events with
    /// `seq >= from_seq` before going live.
    Attach {
        task_id: String,
        kind: StreamKind,
        #[serde(default)]
        from_seq: u64,
    },
    Detach {
        task_id: String,
        kind: StreamKind,
    },
    /// Send a user message to a themed task (works mid-run — steering).
    AgentInput {
        task_id: String,
        text: String,
    },
    AgentPermission {
        task_id: String,
        request_id: String,
        decision: PermissionDecision,
    },
    AgentInterrupt {
        task_id: String,
    },
    /// Raw terminal input for PTY tasks (base64 bytes).
    TermInput {
        task_id: String,
        data_b64: String,
    },
    TermResize {
        task_id: String,
        cols: u16,
        rows: u16,
    },
    /// Request/response escape hatch for the task API (list/create/actions).
    /// Replaces both REST calls and the legacy relay Invoke vocabulary.
    Request {
        id: u64,
        method: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "unknown"))]
        body: Option<serde_json::Value>,
    },
}

/// Frames sent by kanna-server to clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum ServerFrame {
    AuthOk,
    /// Agent attach reply: the replayed journal tail plus the seq the live
    /// stream continues from. A reconnecting client passes `next_seq` back
    /// as `from_seq`.
    AgentSnapshot {
        task_id: String,
        next_seq: u64,
        events: Vec<FrameAgentEvent>,
    },
    AgentEvent {
        task_id: String,
        seq: u64,
        event: AgentEvent,
    },
    /// Terminal attach reply: serialized terminal state to hydrate xterm.
    TermSnapshot {
        task_id: String,
        cols: u16,
        rows: u16,
        data_b64: String,
    },
    TermOutput {
        task_id: String,
        data_b64: String,
    },
    StatusChanged {
        task_id: String,
        /// `busy` | `waiting` | `idle` (mirrors daemon SessionStatus).
        status: String,
    },
    SessionExit {
        task_id: String,
        code: i32,
    },
    Response {
        id: u64,
        status: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "unknown"))]
        body: Option<serde_json::Value>,
    },
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_frame_round_trip() {
        let frames = vec![
            ClientFrame::Auth { credential: None },
            ClientFrame::Attach {
                task_id: "t1".into(),
                kind: StreamKind::Agent,
                from_seq: 7,
            },
            ClientFrame::AgentInput {
                task_id: "t1".into(),
                text: "go".into(),
            },
            ClientFrame::AgentPermission {
                task_id: "t1".into(),
                request_id: "r1".into(),
                decision: PermissionDecision::Allow,
            },
            ClientFrame::AgentInterrupt {
                task_id: "t1".into(),
            },
            ClientFrame::TermInput {
                task_id: "t2".into(),
                data_b64: "aGk=".into(),
            },
            ClientFrame::Request {
                id: 1,
                method: "POST".into(),
                path: "/v1/tasks".into(),
                body: Some(serde_json::json!({"prompt": "x"})),
            },
        ];
        for frame in frames {
            let json = serde_json::to_string(&frame).unwrap();
            let back: ClientFrame = serde_json::from_str(&json).unwrap();
            assert_eq!(frame, back, "round-trip failed for {json}");
        }
    }

    #[test]
    fn server_frame_round_trip_and_tagging() {
        let frame = ServerFrame::AgentEvent {
            task_id: "t1".into(),
            seq: 3,
            event: AgentEvent::AssistantText {
                text: "hi".into(),
                truncated: false,
            },
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "agent_event");
        assert_eq!(json["event"]["type"], "assistant_text");

        let back: ServerFrame = serde_json::from_value(json).unwrap();
        assert_eq!(frame, back);
    }

    #[test]
    fn attach_defaults_from_seq() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"type":"attach","task_id":"t","kind":"agent"}"#).unwrap();
        assert_eq!(
            frame,
            ClientFrame::Attach {
                task_id: "t".into(),
                kind: StreamKind::Agent,
                from_seq: 0,
            }
        );
    }
}
