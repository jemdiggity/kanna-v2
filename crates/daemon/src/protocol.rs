use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use kanna_agent_protocol::{
    AgentEvent as NeutralAgentEvent, AgentProvider, PermissionDecision,
};

/// Transactional lifecycle-fenced and provenance-authenticated handoff.
pub const HANDOFF_PROTOCOL_VERSION: u32 = 3;

/// Deployed pre-transaction handoff retained to preserve stable live sessions.
pub const LEGACY_HANDOFF_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    SessionNotFound,
    SessionAlreadyExists,
    HandoffLost,
    HandoffVersionMismatch,
    PtySpawnFailed,
    PtyCloneFailed,
    HeadlessTerminalInitFailed,
    WriteFailed,
    UnknownSignal,
    AgentSpawnFailed,
    NotAgentSession,
    UnknownPermissionRequest,
}

/// Whether a session is a PTY terminal or a headless agent (NDJSON pipes).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Pty,
    Agent,
}

/// A journaled agent event paired with its sequence number.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeqAgentEvent {
    pub seq: u64,
    pub event: NeutralAgentEvent,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSnapshot {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffSession {
    pub session_id: String,
    pub pid: u32,
    /// Start-time identity of `pid` (`proc_bsdinfo` start seconds/micros),
    /// recorded by the sending daemon while it owned the session. Advisory
    /// only: adopters derive signal authority from descriptor provenance
    /// (the transferred terminal/pipe fds), never from this
    /// sender-controlled value. Absent on legacy senders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_start: Option<(u64, u64)>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: Option<TerminalSnapshot>,
    #[serde(default)]
    pub agent_provider: Option<AgentProvider>,
    #[serde(default)]
    pub status: SessionStatus,
    #[serde(default)]
    pub kind: SessionKind,
    /// Agent sessions: the provider's own session id (for resume), captured
    /// from the stream by the old daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    /// Agent sessions: number of pipe fds transferred for this session
    /// (stdout, stderr, stdin — 0 for already-exited children). PTY sessions
    /// always transfer exactly one master fd and leave this 0.
    #[serde(default)]
    pub agent_fd_count: u8,
    /// Agent sessions: serialized spawn context so the adopting daemon can
    /// resume-respawn after a crash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_spawn: Option<AgentSpawnParams>,
}

/// Everything needed to (re)build a provider adapter spawn for an agent
/// session. Carried in SpawnAgent and across handoff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpawnParams {
    pub agent_provider: AgentProvider,
    pub prompt: String,
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub mcp_config_path: Option<String>,
    /// Optional absolute executable path; otherwise resolved from env PATH.
    #[serde(default)]
    pub executable: Option<String>,
    /// Existing provider conversation to resume instead of starting fresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Busy,
    Waiting,
    #[default]
    Idle,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Spawn {
        session_id: String,
        executable: String,
        args: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        #[serde(default)]
        agent_provider: Option<AgentProvider>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_prelude: Option<Vec<u8>>,
    },
    AttachSnapshot {
        session_id: String,
        #[serde(default)]
        emulate_terminal: bool,
    },
    Detach {
        session_id: String,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    /// Latency-sensitive terminal input. Success is deliberately not
    /// acknowledged, so callers can pipeline ordered bytes without waiting.
    /// Failures are still emitted as asynchronous `Event::Error` values.
    InputNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Ordered terminal resize paired with `InputNoReply` on persistent
    /// control connections. Success has no reply; failures remain observable.
    ResizeNoReply {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Signal {
        session_id: String,
        signal: String,
    },
    Kill {
        session_id: String,
    },
    List,
    Subscribe,
    Observe {
        session_id: String,
    },
    /// Atomic observer cutover: under the session's fanout lock, snapshot the
    /// authoritative headless terminal and register this connection as a
    /// passive observer whose first queued event is that `Event::Snapshot`.
    /// There is no `Ok` reply — the snapshot is the reply, and every later
    /// `Output` is ordered strictly after it. Failures reply `Event::Error`.
    ObserveSnapshot {
        session_id: String,
    },
    Unobserve {
        session_id: String,
    },
    Snapshot {
        session_id: String,
    },
    SeedSnapshot {
        session_id: String,
        snapshot: TerminalSnapshot,
    },
    Handoff {
        version: u32,
    },
    HandoffAdopted {
        version: u32,
    },
    SpawnAgent {
        session_id: String,
        params: AgentSpawnParams,
    },
    AttachAgent {
        session_id: String,
        #[serde(default)]
        from_seq: u64,
    },
    AgentInput {
        session_id: String,
        text: String,
    },
    AgentPermission {
        session_id: String,
        request_id: String,
        decision: PermissionDecision,
    },
    AgentInterrupt {
        session_id: String,
    },
    AgentSetModel {
        session_id: String,
        model: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[allow(clippy::enum_variant_names)]
pub enum Event {
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    Exit {
        session_id: String,
        code: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_session_id: Option<String>,
        /// True when this exit was an orchestrated Kill (stage swap, rerun,
        /// task close) rather than the process ending on its own. Consumers
        /// that treat Exit as an agent-completion signal must skip killed
        /// exits.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        killed: bool,
    },
    StatusChanged {
        session_id: String,
        status: SessionStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        waiting_prompt_snippet: Option<String>,
    },
    ProviderSessionChanged {
        session_id: String,
        provider_session_id: String,
    },
    SessionCreated {
        session_id: String,
    },
    SessionList {
        sessions: Vec<SessionInfo>,
    },
    Ok,
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
        message: String,
    },
    Snapshot {
        session_id: String,
        snapshot: TerminalSnapshot,
    },
    HandoffReady {
        sessions: Vec<HandoffSession>,
    },
    HandoffUnsupported,
    ShuttingDown,
    AgentSnapshot {
        session_id: String,
        /// The seq the live stream continues from (= journal length); a
        /// reconnecting client passes this back as `from_seq`.
        next_seq: u64,
        events: Vec<SeqAgentEvent>,
    },
    AgentEvent {
        session_id: String,
        seq: u64,
        event: NeutralAgentEvent,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub pid: u32,
    pub cwd: String,
    pub state: SessionState,
    pub idle_seconds: u64,
    pub status: SessionStatus,
    #[serde(default)]
    pub kind: SessionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionState {
    Active,
    Suspended,
    Exited(i32),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_spawn_roundtrip() {
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/user".to_string());
        let cmd = Command::Spawn {
            session_id: "abc123".to_string(),
            executable: "/bin/bash".to_string(),
            args: vec!["-l".to_string()],
            cwd: "/tmp".to_string(),
            env,
            cols: 80,
            rows: 24,
            agent_provider: Some(AgentProvider::Codex),
            terminal_prelude: Some(b"stage marker\r\n".to_vec()),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Spawn {
                session_id,
                executable,
                cols,
                rows,
                agent_provider,
                terminal_prelude,
                ..
            } => {
                assert_eq!(session_id, "abc123");
                assert_eq!(executable, "/bin/bash");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                assert_eq!(agent_provider, Some(AgentProvider::Codex));
                assert_eq!(terminal_prelude, Some(b"stage marker\r\n".to_vec()));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_command_spawn_legacy_payload_defaults_terminal_prelude() {
        let decoded: Command = serde_json::from_value(serde_json::json!({
            "type": "Spawn",
            "session_id": "legacy-session",
            "executable": "/bin/bash",
            "args": [],
            "cwd": "/tmp",
            "env": {},
            "cols": 80,
            "rows": 24,
            "agent_provider": "codex"
        }))
        .unwrap();

        assert!(matches!(
            decoded,
            Command::Spawn {
                terminal_prelude: None,
                ..
            }
        ));
    }

    #[test]
    fn test_command_list_roundtrip() {
        let cmd = Command::List;
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"List\""));
        let decoded: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, Command::List));
    }

    #[test]
    fn test_command_input_roundtrip() {
        let cmd = Command::Input {
            session_id: "s1".to_string(),
            data: vec![104, 101, 108, 108, 111],
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Input { session_id, data } => {
                assert_eq!(session_id, "s1");
                assert_eq!(data, b"hello");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_one_way_terminal_commands_roundtrip() {
        let input = Command::InputNoReply {
            session_id: "s1".to_string(),
            data: b"opaque\0bytes".to_vec(),
        };
        let decoded: Command =
            serde_json::from_str(&serde_json::to_string(&input).unwrap()).unwrap();
        match decoded {
            Command::InputNoReply { session_id, data } => {
                assert_eq!(session_id, "s1");
                assert_eq!(data, b"opaque\0bytes");
            }
            _ => panic!("wrong variant"),
        }

        let resize = Command::ResizeNoReply {
            session_id: "s1".to_string(),
            cols: 132,
            rows: 48,
        };
        let decoded: Command =
            serde_json::from_str(&serde_json::to_string(&resize).unwrap()).unwrap();
        match decoded {
            Command::ResizeNoReply {
                session_id,
                cols,
                rows,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(cols, 132);
                assert_eq!(rows, 48);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_output_roundtrip() {
        let evt = Event::Output {
            session_id: "s1".to_string(),
            data: vec![1, 2, 3],
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Output { session_id, data } => {
                assert_eq!(session_id, "s1");
                assert_eq!(data, vec![1, 2, 3]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_exit_roundtrip() {
        let evt = Event::Exit {
            session_id: "s1".to_string(),
            code: 42,
            resume_session_id: Some("019d99a5-aa94-7c73-b786-644cc095c037".to_string()),
            killed: false,
        };
        let json = serde_json::to_string(&evt).unwrap();
        // `killed: false` stays off the wire so older peers see the same shape.
        assert!(!json.contains("killed"));
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Exit {
                session_id,
                code,
                resume_session_id,
                killed,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(code, 42);
                assert_eq!(
                    resume_session_id.as_deref(),
                    Some("019d99a5-aa94-7c73-b786-644cc095c037")
                );
                assert!(!killed);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_exit_killed_roundtrip() {
        let evt = Event::Exit {
            session_id: "s1".to_string(),
            code: -1,
            resume_session_id: None,
            killed: true,
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Exit { killed, .. } => assert!(killed),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_exit_without_killed_field_deserializes() {
        // Events from an older daemon lack `killed`; it must default to false.
        let json = r#"{"type":"Exit","session_id":"s1","code":0}"#;
        let decoded: Event = serde_json::from_str(json).unwrap();
        match decoded {
            Event::Exit { killed, .. } => assert!(!killed),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_ok_roundtrip() {
        let evt = Event::Ok;
        let json = serde_json::to_string(&evt).unwrap();
        assert!(json.contains("\"Ok\""));
        let decoded: Event = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, Event::Ok));
    }

    #[test]
    fn status_changed_roundtrips_optional_waiting_prompt() {
        let event = Event::StatusChanged {
            session_id: "task-1".to_string(),
            status: SessionStatus::Idle,
            waiting_prompt_snippet: Some("The branch is ready for review.".to_string()),
        };

        let json = serde_json::to_string(&event).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();

        assert!(matches!(
            decoded,
            Event::StatusChanged {
                session_id,
                status: SessionStatus::Idle,
                waiting_prompt_snippet: Some(prompt),
            } if session_id == "task-1" && prompt == "The branch is ready for review."
        ));
    }

    #[test]
    fn status_changed_accepts_legacy_payload_without_waiting_prompt() {
        let decoded: Event = serde_json::from_str(
            r#"{"type":"StatusChanged","session_id":"task-1","status":"idle"}"#,
        )
        .unwrap();

        assert!(matches!(
            decoded,
            Event::StatusChanged {
                waiting_prompt_snippet: None,
                ..
            }
        ));
    }

    #[test]
    fn test_command_snapshot_roundtrip() {
        let cmd = Command::Snapshot {
            session_id: "sess-1".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Snapshot { session_id } => assert_eq!(session_id, "sess-1"),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn test_command_seed_snapshot_roundtrip() {
        let cmd = Command::SeedSnapshot {
            session_id: "sess-1".to_string(),
            snapshot: TerminalSnapshot {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 3,
                cursor_col: 4,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
                vt: "seeded".to_string(),
            },
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::SeedSnapshot {
                session_id,
                snapshot,
            } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(snapshot.rows, 24);
                assert_eq!(snapshot.cols, 80);
                assert_eq!(snapshot.vt, "seeded");
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn test_event_snapshot_roundtrip() {
        let evt = Event::Snapshot {
            session_id: "sess-1".to_string(),
            snapshot: TerminalSnapshot {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 10,
                cursor_col: 5,
                cursor_visible: true,
                saved_at: 123,
                sequence: 7,
                vt: "hello".to_string(),
            },
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Snapshot {
                session_id,
                snapshot,
            } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(snapshot.version, 1);
                assert_eq!(snapshot.vt, "hello");
                assert_eq!(snapshot.saved_at, 123);
                assert_eq!(snapshot.sequence, 7);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn test_event_snapshot_defaults_cursor_visible_for_older_payloads() {
        let json = r#"{
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

        let decoded: Event = serde_json::from_str(json).unwrap();
        match decoded {
            Event::Snapshot { snapshot, .. } => {
                assert!(snapshot.cursor_visible);
                assert_eq!(snapshot.vt, "hello");
                assert_eq!(snapshot.saved_at, 0);
                assert_eq!(snapshot.sequence, 0);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn provider_session_changed_roundtrips() {
        let event = Event::ProviderSessionChanged {
            session_id: "task-1".to_string(),
            provider_session_id: "provider-thread".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::ProviderSessionChanged {
                session_id,
                provider_session_id,
            } => {
                assert_eq!(session_id, "task-1");
                assert_eq!(provider_session_id, "provider-thread");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn test_event_snapshot_serialization_includes_recovery_metadata_defaults() {
        let evt = Event::Snapshot {
            session_id: "sess-1".to_string(),
            snapshot: TerminalSnapshot {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 10,
                cursor_col: 5,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
                vt: "hello".to_string(),
            },
        };

        let value = serde_json::to_value(&evt).unwrap();
        assert_eq!(value["snapshot"]["saved_at"], serde_json::json!(0));
        assert_eq!(value["snapshot"]["sequence"], serde_json::json!(0));
    }

    #[test]
    fn test_handoff_ready_roundtrip_without_snapshot() {
        let evt = Event::HandoffReady {
            sessions: vec![HandoffSession {
                session_id: "sess-1".to_string(),
                pid: 42,
                child_start: None,
                cwd: "/tmp".to_string(),
                rows: 24,
                cols: 80,
                snapshot: None,
                agent_provider: None,
                status: SessionStatus::Idle,
                kind: SessionKind::Pty,
                provider_session_id: None,
                agent_fd_count: 0,
                agent_spawn: None,
            }],
        };

        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();

        match decoded {
            Event::HandoffReady { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].session_id, "sess-1");
                assert_eq!(sessions[0].rows, 24);
                assert_eq!(sessions[0].cols, 80);
                assert!(sessions[0].snapshot.is_none());
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn test_handoff_ready_v1_payload_without_geometry_is_rejected() {
        let json = r#"{
            "type":"HandoffReady",
            "sessions":[
                {
                    "session_id":"sess-1",
                    "pid":42,
                    "cwd":"/tmp",
                    "snapshot":{
                        "version":1,
                        "rows":24,
                        "cols":80,
                        "cursor_row":1,
                        "cursor_col":0,
                        "cursor_visible":true,
                        "vt":"hello"
                    }
                }
            ]
        }"#;

        let error = serde_json::from_str::<Event>(json)
            .expect_err("older handoff payloads without geometry should be rejected");
        let message = error.to_string();
        assert!(
            message.contains("rows") || message.contains("cols"),
            "unexpected error: {}",
            message
        );
    }

    #[test]
    fn test_event_error_roundtrip() {
        let evt = Event::Error {
            code: Some(ErrorCode::SessionNotFound),
            message: "something went wrong".to_string(),
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Error { code, message } => {
                assert_eq!(code, Some(ErrorCode::SessionNotFound));
                assert_eq!(message, "something went wrong");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_session_info_roundtrip() {
        let info = SessionInfo {
            session_id: "s1".to_string(),
            pid: 12345,
            cwd: "/home/user".to_string(),
            state: SessionState::Active,
            idle_seconds: 30,
            status: SessionStatus::Idle,
            kind: SessionKind::Pty,
        };
        let json = serde_json::to_string(&info).unwrap();
        let decoded: SessionInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.session_id, "s1");
        assert_eq!(decoded.pid, 12345);
        assert_eq!(decoded.idle_seconds, 30);
        assert!(matches!(decoded.state, SessionState::Active));
    }

    #[test]
    fn test_session_state_exited_roundtrip() {
        let state = SessionState::Exited(1);
        let json = serde_json::to_string(&state).unwrap();
        let decoded: SessionState = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, SessionState::Exited(1)));
    }

    #[test]
    fn test_event_session_list_roundtrip() {
        let evt = Event::SessionList {
            sessions: vec![SessionInfo {
                session_id: "s1".to_string(),
                pid: 999,
                cwd: "/tmp".to_string(),
                state: SessionState::Suspended,
                idle_seconds: 10,
                status: SessionStatus::Idle,
                kind: SessionKind::Pty,
            }],
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::SessionList { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].session_id, "s1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_event_shutting_down_roundtrip() {
        let evt = Event::ShuttingDown;
        let json = serde_json::to_string(&evt).unwrap();
        assert_eq!(json, r#"{"type":"ShuttingDown"}"#);
        let decoded: Event = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, Event::ShuttingDown));
    }

    #[test]
    fn test_command_observe_roundtrip() {
        let cmd = Command::Observe {
            session_id: "s1".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Observe { session_id } => {
                assert_eq!(session_id, "s1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_command_observe_snapshot_roundtrip() {
        let cmd = Command::ObserveSnapshot {
            session_id: "s1".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::ObserveSnapshot { session_id } => {
                assert_eq!(session_id, "s1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_command_unobserve_roundtrip() {
        let cmd = Command::Unobserve {
            session_id: "s1".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Unobserve { session_id } => {
                assert_eq!(session_id, "s1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_command_signal_roundtrip() {
        let cmd = Command::Signal {
            session_id: "s1".to_string(),
            signal: "SIGTERM".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::Signal { session_id, signal } => {
                assert_eq!(session_id, "s1");
                assert_eq!(signal, "SIGTERM");
            }
            _ => panic!("wrong variant"),
        }
    }
}
