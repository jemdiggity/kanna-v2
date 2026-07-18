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
    Companion,
}

/// Whether the companion content is an HTML fragment that Kanna must frame
/// or a complete HTML document that Kanna can render as-is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum CompanionDocumentKind {
    Fragment,
    FullDocument,
}

/// A structured selection made in a visual companion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CompanionEvent {
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub choice: String,
    pub text: String,
    #[serde(rename = "id")]
    pub element_id: Option<String>,
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
    pub timestamp: u64,
}

/// Coarse data-model invalidation scopes. Clients should re-fetch the
/// snapshot rather than applying row-level deltas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum StateChangeScope {
    Tasks,
    Repos,
    Blockers,
    Settings,
}

/// A journaled agent event paired with its sequence number (wire mirror of
/// the daemon's journal entries).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct FrameAgentEvent {
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
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
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
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
    /// Switch the model for a themed task mid-session.
    AgentSetModel {
        task_id: String,
        model: String,
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
    /// Send a structured selection back to the currently displayed visual
    /// companion. The server validates both session and revision before
    /// appending it to the companion event stream.
    CompanionEvent {
        task_id: String,
        session_id: String,
        revision: String,
        event: CompanionEvent,
    },
    /// Request/response escape hatch for the task API (list/create/actions).
    /// Replaces both REST calls and the legacy relay Invoke vocabulary.
    Request {
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
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
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        next_seq: u64,
        events: Vec<FrameAgentEvent>,
    },
    AgentEvent {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
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
    /// Latest visual companion document for a task.
    CompanionSnapshot {
        task_id: String,
        session_id: String,
        revision: String,
        document_kind: CompanionDocumentKind,
        html: String,
    },
    /// The task currently has no active visual companion.
    CompanionUnavailable {
        task_id: String,
    },
    /// Acknowledgement for one structured companion event.
    CompanionEventResult {
        task_id: String,
        event_id: String,
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A task-scoped companion source failure, kept separate from generic KSP
    /// errors so other task stream handlers are unaffected.
    CompanionError {
        task_id: String,
        code: String,
        message: String,
    },
    StatusChanged {
        task_id: String,
        // `busy` | `waiting` | `idle` (mirrors daemon SessionStatus).
        status: String,
    },
    StateChanged {
        scope: StateChangeScope,
    },
    SessionExit {
        task_id: String,
        code: i32,
    },
    Response {
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
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
    fn state_changed_frame_round_trip_and_tagging() {
        let frame = ServerFrame::StateChanged {
            scope: StateChangeScope::Tasks,
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "state_changed");
        assert_eq!(json["scope"], "tasks");

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

    #[test]
    fn companion_frames_round_trip_and_preserve_wire_names() {
        let event = CompanionEvent {
            event_id: "event-1".into(),
            event_type: "click".into(),
            choice: "a".into(),
            text: "Option A".into(),
            element_id: None,
            timestamp: 1_784_268_000_000,
        };
        let client = ClientFrame::CompanionEvent {
            task_id: "task-1".into(),
            session_id: "123-456".into(),
            revision: "sha256:abc".into(),
            event: event.clone(),
        };
        let client_json = serde_json::to_value(&client).unwrap();
        assert_eq!(client_json["type"], "companion_event");
        assert_eq!(client_json["event"]["type"], "click");
        assert_eq!(client_json["event"]["id"], serde_json::Value::Null);
        assert_eq!(
            serde_json::from_value::<ClientFrame>(client_json).unwrap(),
            client
        );

        let snapshot = ServerFrame::CompanionSnapshot {
            task_id: "task-1".into(),
            session_id: "123-456".into(),
            revision: "sha256:abc".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<h2>Choose</h2>".into(),
        };
        assert_eq!(
            serde_json::from_value::<ServerFrame>(serde_json::to_value(&snapshot).unwrap())
                .unwrap(),
            snapshot
        );
        assert_eq!(
            serde_json::to_value(StreamKind::Companion).unwrap(),
            "companion"
        );

        let unavailable = serde_json::to_value(ServerFrame::CompanionUnavailable {
            task_id: "task-1".into(),
        })
        .unwrap();
        assert_eq!(unavailable["type"], "companion_unavailable");

        let result = ServerFrame::CompanionEventResult {
            task_id: "task-1".into(),
            event_id: "event-1".into(),
            accepted: false,
            code: Some("companion_stale_revision".into()),
            message: Some("The companion changed before the selection arrived.".into()),
        };
        let result_json = serde_json::to_value(&result).unwrap();
        assert_eq!(result_json["type"], "companion_event_result");
        assert_eq!(result_json["event_id"], "event-1");
        assert_eq!(result_json["accepted"], false);
        assert_eq!(
            serde_json::from_value::<ServerFrame>(result_json).unwrap(),
            result
        );

        let error = ServerFrame::CompanionError {
            task_id: "task-1".into(),
            code: "companion_source_failed".into(),
            message: "The visual companion could not be read.".into(),
        };
        let error_json = serde_json::to_value(&error).unwrap();
        assert_eq!(error_json["type"], "companion_error");
        assert_eq!(error_json["task_id"], "task-1");
        assert_eq!(
            serde_json::from_value::<ServerFrame>(error_json).unwrap(),
            error
        );
    }
}
