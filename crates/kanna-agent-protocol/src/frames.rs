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
use crate::AgentProvider;

fn default_true() -> bool {
    true
}

/// Which stream of a task to attach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum StreamKind {
    Agent,
    Terminal,
    Companion,
    TaskSummary,
}

/// Optional KSP behaviors that require both peers to agree on wire semantics.
///
/// The set is open on the wire: a peer from the future may advertise
/// capabilities this build has never heard of, and rejecting the whole frame
/// for one unknown string would make the negotiation unable to ever grow.
/// Unknown strings deserialize to [`KspCapability::Unknown`] and are ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum KspCapability {
    CompanionAttachmentEpoch,
    CompanionEventEpoch,
    TermInputBoundary,
    /// The client accepts a *bounded* terminal snapshot (visible screen plus a
    /// window of recent scrollback), pulls older scrollback on demand, and
    /// presents a resume position on re-attach so the server replays the delta
    /// instead of the whole buffer. A client that does not advertise this gets
    /// the unbounded snapshot and the per-attachment daemon stream unchanged.
    TermScrollbackWindow,
    /// The client accepts a bounded recent agent-journal window, requests
    /// older sequence ranges on demand, and retains its existing events when
    /// re-attaching from a non-zero sequence.
    AgentHistoryWindow,
    /// Terminal viewers can register an explicit local/remote role and use
    /// the daemon-owned geometry controller. Without this capability a peer
    /// is legacy and must not be treated as a local controller.
    TerminalGeometry,
    #[serde(other)]
    Unknown,
}

/// The role a terminal viewer declares on the authenticated control path.
/// This is a rendering/ownership role, not an input permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum TerminalViewerRole {
    Local,
    Remote,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CompanionAsset {
    pub name: String,
    pub content_type: String,
    pub digest: String,
    pub data_b64: String,
}

/// A structured selection made in a visual companion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CompanionEvent {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub revision: String,
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

/// Data-model invalidation scopes. A `tasks` frame may carry a versioned task
/// state payload that capable clients can apply in place; otherwise clients
/// re-fetch the snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum StateChangeScope {
    Tasks,
    Repos,
    Blockers,
    Settings,
}

/// Additive, versioned state for one existing task. Version 1 deliberately
/// contains only fields whose changes cannot alter task membership or sidebar
/// ordering. A client that does not understand the version must use the
/// surrounding `StateChanged` scope as a full-snapshot invalidation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct TaskStateChange {
    pub version: u8,
    pub task_id: String,
    pub activity: String,
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
    pub activity_revision: i64,
    pub activity_changed_at: Option<String>,
    pub unread_at: Option<String>,
    pub runtime_state: Option<String>,
    pub read_state: String,
    pub last_output_preview: Option<String>,
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

/// Where a re-attaching terminal client's rendered buffer stopped.
///
/// `stream_id` names the server's tap generation the offset belongs to: a
/// daemon reconnect restarts the byte stream, so an offset is only meaningful
/// within its own generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct TermResumePosition {
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
    pub stream_id: u64,
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
    pub offset: u64,
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
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        capabilities: Vec<KspCapability>,
    },
    /// Attach to a task's stream; agent streams replay journal events with
    /// `seq >= from_seq` before going live.
    Attach {
        task_id: String,
        kind: StreamKind,
        #[serde(default)]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        from_seq: u64,
        // Omitted by older clients, preserving complete companion bundles.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include_assets: Option<bool>,
        // Omitted by older clients. Servers must emit legacy, unchunked
        // snapshots unless the client explicitly opts into bounded chunks.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        accept_snapshot_chunks: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
        /// Terminal streams only. Where this client's rendered buffer stopped,
        /// so the server can replay the missed bytes instead of re-shipping the
        /// whole terminal. Ignored unless the client negotiated
        /// [`KspCapability::TermScrollbackWindow`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        term_resume: Option<TermResumePosition>,
    },
    Detach {
        task_id: String,
        kind: StreamKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
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
    /// Raw terminal input which the producer explicitly identifies as a
    /// current-composer submission event.
    TermInputBoundary {
        task_id: String,
        data_b64: String,
    },
    /// Raw terminal control that neither edits nor submits the composer.
    /// Producers use this for mouse/scroll/focus reports so those controls
    /// cannot create a phantom draft that strands logical task messages.
    TermInputControl {
        task_id: String,
        data_b64: String,
    },
    TermResize {
        task_id: String,
        cols: u16,
        rows: u16,
    },
    /// Register the viewer before it sends input or resize. Registration is
    /// bound to this authenticated KSP connection by kanna-server and then
    /// to the daemon control attachment.
    TermViewerRegister {
        task_id: String,
        viewer_id: String,
        role: TerminalViewerRole,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        generation: u64,
        cols: u16,
        rows: u16,
        #[serde(default = "default_true")]
        visible: bool,
    },
    TermViewerTakeover {
        task_id: String,
    },
    TermViewerRelease {
        task_id: String,
    },
    /// Pull one bounded chunk of scrollback older than what the client holds.
    /// `before_line` indexes the retained history identified by `history_id`,
    /// counted from its oldest retained line; a client walks it downward until
    /// `remaining_lines` reaches zero.
    TermScrollbackRequest {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        request_id: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        history_id: u64,
        before_line: u32,
        max_lines: u32,
    },
    /// Pull a bounded journal range immediately before `before_seq`, never
    /// crossing `after_seq`. The lower fence lets a reconnect backfill only
    /// the gap and never re-ship events the client already retained.
    AgentHistoryRequest {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        request_id: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        before_seq: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        after_seq: u64,
        max_events: u32,
    },
    /// Send a structured selection back to the currently displayed visual
    /// companion. The server validates both session and revision before
    /// appending it to the companion event stream.
    CompanionEvent {
        task_id: String,
        session_id: String,
        revision: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
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
    AuthOk {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        stream_kinds: Vec<StreamKind>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        capabilities: Vec<KspCapability>,
    },
    /// Agent attach reply: the replayed journal tail plus the seq the live
    /// stream continues from. A reconnecting client passes `next_seq` back
    /// as `from_seq`.
    AgentSnapshot {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        next_seq: u64,
        events: Vec<FrameAgentEvent>,
        /// Oldest sequence included in a capability-gated recent window.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        history_start_seq: Option<u64>,
        /// Lower bound for on-demand history. On reconnect this is the
        /// `from_seq` presented by the client, not the beginning of the
        /// journal, so already-held events are never requested again.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        history_from_seq: Option<u64>,
        /// True when the client must retain its existing transcript and merge
        /// this window by sequence rather than replacing it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resumed: Option<bool>,
    },
    /// One bounded answer to `agent_history_request`, ordered oldest-first.
    AgentHistoryChunk {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        request_id: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        start_seq: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        end_seq: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        after_seq: u64,
        events: Vec<FrameAgentEvent>,
    },
    AgentEvent {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        seq: u64,
        event: AgentEvent,
    },
    /// Terminal attach reply: serialized terminal state to hydrate xterm.
    ///
    /// For a client that negotiated [`KspCapability::TermScrollbackWindow`],
    /// `data_b64` carries only the bounded window (visible screen plus recent
    /// scrollback) and the fields below describe what was left behind and where
    /// the live byte stream continues. They are omitted entirely for every
    /// other client, whose snapshot is the whole terminal exactly as before.
    TermSnapshot {
        task_id: String,
        cols: u16,
        rows: u16,
        data_b64: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_provider: Option<AgentProvider>,
        /// The tap generation `stream_offset` belongs to.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        stream_id: Option<u64>,
        /// Byte offset in that generation at which this snapshot is valid; the
        /// client adds each `term_output` frame's decoded length to it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        stream_offset: Option<u64>,
        /// Identifies the retained scrollback history this window was cut from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        history_id: Option<u64>,
        /// Lines of older scrollback the server retained and will serve through
        /// `term_scrollback_request`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scrollback_lines: Option<u32>,
    },
    /// Terminal re-attach reply when the server can replay: the client keeps
    /// the buffer it already rendered and the missed bytes follow as ordinary
    /// `term_output` frames. Sent *instead of* a snapshot.
    TermResumed {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        stream_id: u64,
        /// The offset the replay starts at — the position the client presented.
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        offset: u64,
        cols: u16,
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_provider: Option<AgentProvider>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        history_id: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scrollback_lines: Option<u32>,
    },
    /// One bounded chunk of scrollback older than the client's buffer, in reply
    /// to a `term_scrollback_request`. `data_b64` is prepended above what the
    /// client holds. `remaining_lines` is how much older history is still
    /// retained below `start_line`.
    TermScrollbackChunk {
        task_id: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        request_id: u64,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        history_id: u64,
        start_line: u32,
        end_line: u32,
        data_b64: String,
        remaining_lines: u32,
    },
    TermOutput {
        task_id: String,
        data_b64: String,
    },
    /// Debounced live state used by task cards while list views are visible.
    TaskSummary {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snippet: Option<String>,
        activity: String,
        runtime_state: String,
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        revision: u64,
    },
    /// Latest visual companion document for a task.
    CompanionSnapshot {
        task_id: String,
        session_id: String,
        revision: String,
        document_kind: CompanionDocumentKind,
        html: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_origin: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        assets: Vec<CompanionAsset>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
    },
    /// One bounded segment of a serialized `CompanionSnapshot`. KSP emits
    /// these instead of a single maximum-size WebSocket data message so
    /// terminal and control frames can run between segments.
    CompanionSnapshotChunk {
        task_id: String,
        transfer_id: String,
        index: u32,
        count: u32,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
    },
    /// The task currently has no active visual companion.
    CompanionUnavailable {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
    },
    /// Acknowledgement for one structured companion event.
    CompanionEventResult {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<String>,
        event_id: String,
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
    },
    /// A task-scoped companion source failure, kept separate from generic KSP
    /// errors so other task stream handlers are unaffected.
    CompanionError {
        task_id: String,
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "typescript", ts(type = "number"))]
        attachment_epoch: Option<u64>,
    },
    StatusChanged {
        task_id: String,
        // `busy` | `waiting` | `idle` (mirrors daemon SessionStatus).
        status: String,
    },
    StateChanged {
        scope: StateChangeScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_state: Option<TaskStateChange>,
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
    fn auth_with_unknown_capability_strings_still_parses() {
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"auth","capabilities":["companion_event_epoch","capability_from_the_future"]}"#,
        )
        .expect("an unknown capability string must not fail the Auth frame");
        let ClientFrame::Auth { capabilities, .. } = frame else {
            panic!("expected an auth frame");
        };
        assert_eq!(
            capabilities,
            vec![KspCapability::CompanionEventEpoch, KspCapability::Unknown],
        );
    }

    #[test]
    fn client_frame_round_trip() {
        let frames = vec![
            ClientFrame::Auth {
                credential: None,
                capabilities: vec![
                    KspCapability::CompanionEventEpoch,
                    KspCapability::TermInputBoundary,
                ],
            },
            ClientFrame::Attach {
                task_id: "t1".into(),
                kind: StreamKind::Agent,
                from_seq: 7,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
                term_resume: None,
            },
            ClientFrame::Attach {
                task_id: "t2".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
                term_resume: Some(TermResumePosition {
                    stream_id: 4,
                    offset: 8192,
                }),
            },
            ClientFrame::TermScrollbackRequest {
                task_id: "t2".into(),
                request_id: 9,
                history_id: 4,
                before_line: 200,
                max_lines: 100,
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
            ClientFrame::TermInputBoundary {
                task_id: "t2".into(),
                data_b64: "DQ==".into(),
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

        let summary = ServerFrame::TaskSummary {
            task_id: "t1".into(),
            snippet: Some("working".into()),
            activity: "working".into(),
            runtime_state: "busy".into(),
            revision: 9,
        };
        let summary_json = serde_json::to_value(&summary).unwrap();
        assert_eq!(summary_json["type"], "task_summary");
        assert_eq!(
            serde_json::from_value::<ServerFrame>(summary_json).unwrap(),
            summary
        );
    }

    #[test]
    fn auth_ok_stream_kinds_are_backward_compatible() {
        let old: ServerFrame = serde_json::from_value(serde_json::json!({
            "type": "auth_ok"
        }))
        .unwrap();
        assert_eq!(
            old,
            ServerFrame::AuthOk {
                stream_kinds: Vec::new(),
                capabilities: Vec::new(),
            }
        );

        let current = ServerFrame::AuthOk {
            stream_kinds: vec![
                StreamKind::Agent,
                StreamKind::Terminal,
                StreamKind::Companion,
            ],
            capabilities: vec![
                KspCapability::CompanionAttachmentEpoch,
                KspCapability::CompanionEventEpoch,
                KspCapability::TermInputBoundary,
            ],
        };
        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::json!({
                "type": "auth_ok",
                "stream_kinds": ["agent", "terminal", "companion"],
                "capabilities": [
                    "companion_attachment_epoch",
                    "companion_event_epoch",
                    "term_input_boundary"
                ]
            })
        );
    }

    #[test]
    fn state_changed_frame_round_trip_and_tagging() {
        let frame = ServerFrame::StateChanged {
            scope: StateChangeScope::Tasks,
            task_state: None,
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "state_changed");
        assert_eq!(json["scope"], "tasks");

        let back: ServerFrame = serde_json::from_value(json).unwrap();
        assert_eq!(frame, back);

        let legacy: ServerFrame = serde_json::from_value(serde_json::json!({
            "type": "state_changed",
            "scope": "tasks"
        }))
        .unwrap();
        assert_eq!(frame, legacy);

        let scoped = ServerFrame::StateChanged {
            scope: StateChangeScope::Tasks,
            task_state: Some(TaskStateChange {
                version: 1,
                task_id: "task-1".into(),
                activity: "unread".into(),
                activity_revision: 7,
                activity_changed_at: Some("2026-09-03T18:30:00Z".into()),
                unread_at: Some("2026-09-03T18:30:00Z".into()),
                runtime_state: Some("busy".into()),
                read_state: "unread".into(),
                last_output_preview: Some("running".into()),
            }),
        };
        let scoped_json = serde_json::to_value(&scoped).unwrap();
        assert_eq!(scoped_json["task_state"]["version"], 1);
        assert_eq!(scoped_json["task_state"]["task_id"], "task-1");
        assert_eq!(
            serde_json::from_value::<ServerFrame>(scoped_json).unwrap(),
            scoped
        );
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
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
                term_resume: None,
            }
        );

        let asset_free: ClientFrame = serde_json::from_str(
            r#"{"type":"attach","task_id":"t","kind":"companion","include_assets":false}"#,
        )
        .unwrap();
        assert_eq!(
            asset_free,
            ClientFrame::Attach {
                task_id: "t".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: Some(false),
                accept_snapshot_chunks: None,
                attachment_epoch: None,
                term_resume: None,
            }
        );
        assert_eq!(
            serde_json::to_value(asset_free).unwrap()["include_assets"],
            false
        );
    }

    #[test]
    fn companion_attach_chunk_capability_is_optional_and_round_trips() {
        let legacy: ClientFrame = serde_json::from_value(serde_json::json!({
            "type": "attach",
            "task_id": "task-1",
            "kind": "companion"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::json!({
                "type": "attach",
                "task_id": "task-1",
                "kind": "companion",
                "from_seq": 0
            })
        );

        let capable = serde_json::json!({
            "type": "attach",
            "task_id": "task-1",
            "kind": "companion",
            "from_seq": 0,
            "accept_snapshot_chunks": true
        });
        let parsed: ClientFrame = serde_json::from_value(capable.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), capable);
    }

    #[test]
    fn companion_attachment_epochs_are_optional_and_round_trip() {
        for value in [
            serde_json::json!({
                "type": "attach",
                "task_id": "task-1",
                "kind": "companion",
                "from_seq": 0,
                "attachment_epoch": 7
            }),
            serde_json::json!({
                "type": "detach",
                "task_id": "task-1",
                "kind": "companion",
                "attachment_epoch": 7
            }),
        ] {
            let parsed: ClientFrame = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }

        for value in [
            serde_json::json!({
                "type": "companion_snapshot",
                "task_id": "task-1",
                "session_id": "session-1",
                "revision": "revision-1",
                "document_kind": "fragment",
                "html": "<h2>Hello</h2>",
                "attachment_epoch": 7
            }),
            serde_json::json!({
                "type": "companion_snapshot_chunk",
                "task_id": "task-1",
                "transfer_id": "transfer-1",
                "index": 0,
                "count": 1,
                "data": "{}",
                "attachment_epoch": 7
            }),
            serde_json::json!({
                "type": "companion_unavailable",
                "task_id": "task-1",
                "attachment_epoch": 7
            }),
            serde_json::json!({
                "type": "companion_error",
                "task_id": "task-1",
                "code": "companion_source_failed",
                "message": "failed",
                "attachment_epoch": 7
            }),
        ] {
            let parsed: ServerFrame = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }

        let legacy_attach: ClientFrame = serde_json::from_value(serde_json::json!({
            "type": "attach",
            "task_id": "task-1",
            "kind": "companion"
        }))
        .unwrap();
        assert!(serde_json::to_value(legacy_attach)
            .unwrap()
            .get("attachment_epoch")
            .is_none());
    }

    #[test]
    fn companion_frames_round_trip_and_preserve_wire_names() {
        let event = CompanionEvent {
            session_id: "123-456".into(),
            revision: "sha256:abc".into(),
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
            attachment_epoch: Some(7),
            event: event.clone(),
        };
        let client_json = serde_json::to_value(&client).unwrap();
        assert_eq!(client_json["type"], "companion_event");
        assert_eq!(client_json["attachment_epoch"], 7);
        assert_eq!(client_json["event"]["type"], "click");
        assert_eq!(client_json["event"]["id"], serde_json::Value::Null);
        assert_eq!(
            serde_json::from_value::<ClientFrame>(client_json).unwrap(),
            client
        );

        let asset = CompanionAsset {
            name: "layout.png".into(),
            content_type: "image/png".into(),
            digest: "asset-digest".into(),
            data_b64: "aGVsbG8=".into(),
        };
        let snapshot = ServerFrame::CompanionSnapshot {
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            revision: "revision-1".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<h2>Hello</h2>".into(),
            source_origin: Some("http://localhost:52341".into()),
            assets: vec![asset.clone()],
            attachment_epoch: None,
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["source_origin"], "http://localhost:52341");
        assert_eq!(json["assets"][0]["name"], "layout.png");
        assert_eq!(
            serde_json::from_value::<ServerFrame>(json).unwrap(),
            snapshot
        );
        let defaulted_snapshot = serde_json::from_value::<ServerFrame>(serde_json::json!({
            "type": "companion_snapshot",
            "task_id": "task-1",
            "session_id": "session-1",
            "revision": "revision-1",
            "document_kind": "fragment",
            "html": "<h2>Hello</h2>"
        }))
        .unwrap();
        assert_eq!(
            defaulted_snapshot,
            ServerFrame::CompanionSnapshot {
                task_id: "task-1".into(),
                session_id: "session-1".into(),
                revision: "revision-1".into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "<h2>Hello</h2>".into(),
                source_origin: None,
                assets: Vec::new(),
                attachment_epoch: None,
            }
        );
        let defaulted_json = serde_json::to_value(defaulted_snapshot).unwrap();
        assert!(defaulted_json.get("source_origin").is_none());
        assert!(defaulted_json.get("assets").is_none());
        assert_eq!(
            serde_json::to_value(StreamKind::Companion).unwrap(),
            "companion"
        );

        let unavailable = serde_json::to_value(ServerFrame::CompanionUnavailable {
            task_id: "task-1".into(),
            attachment_epoch: None,
        })
        .unwrap();
        assert_eq!(unavailable["type"], "companion_unavailable");

        let result = ServerFrame::CompanionEventResult {
            task_id: "task-1".into(),
            session_id: Some("session-1".into()),
            revision: Some("revision-1".into()),
            event_id: "event-1".into(),
            accepted: false,
            code: Some("companion_stale_revision".into()),
            message: Some("The companion changed before the selection arrived.".into()),
            attachment_epoch: Some(7),
        };
        let result_json = serde_json::to_value(&result).unwrap();
        assert_eq!(result_json["type"], "companion_event_result");
        assert_eq!(result_json["session_id"], "session-1");
        assert_eq!(result_json["revision"], "revision-1");
        assert_eq!(result_json["event_id"], "event-1");
        assert_eq!(result_json["accepted"], false);
        assert_eq!(result_json["attachment_epoch"], 7);
        #[derive(Deserialize)]
        struct LegacyCompanionEventResult {
            event_id: String,
            accepted: bool,
        }
        let legacy_view =
            serde_json::from_value::<LegacyCompanionEventResult>(result_json.clone()).unwrap();
        assert_eq!(legacy_view.event_id, "event-1");
        assert!(!legacy_view.accepted);
        assert_eq!(
            serde_json::from_value::<ServerFrame>(result_json).unwrap(),
            result
        );
        let legacy_result = serde_json::json!({
            "type": "companion_event_result",
            "task_id": "task-1",
            "event_id": "legacy-event",
            "accepted": true
        });
        assert!(matches!(
            serde_json::from_value::<ServerFrame>(legacy_result).unwrap(),
            ServerFrame::CompanionEventResult {
                session_id: None,
                revision: None,
                attachment_epoch: None,
                ..
            }
        ));

        let error = ServerFrame::CompanionError {
            task_id: "task-1".into(),
            code: "companion_source_failed".into(),
            message: "The visual companion could not be read.".into(),
            attachment_epoch: None,
        };
        let error_json = serde_json::to_value(&error).unwrap();
        assert_eq!(error_json["type"], "companion_error");
        assert_eq!(error_json["task_id"], "task-1");
        assert_eq!(
            serde_json::from_value::<ServerFrame>(error_json).unwrap(),
            error
        );
    }

    #[test]
    fn legacy_unbound_companion_events_remain_deserializable() {
        let frame: ClientFrame = serde_json::from_value(serde_json::json!({
            "type": "companion_event",
            "task_id": "task-1",
            "session_id": "session-1",
            "revision": "revision-1",
            "event": {
                "event_id": "event-1",
                "type": "click",
                "choice": "a",
                "text": "A",
                "id": null,
                "timestamp": 1
            }
        }))
        .unwrap();
        let ClientFrame::CompanionEvent {
            event,
            attachment_epoch,
            ..
        } = frame
        else {
            panic!("expected companion event");
        };
        assert!(event.session_id.is_empty());
        assert!(event.revision.is_empty());
        assert_eq!(attachment_epoch, None);
    }
}
