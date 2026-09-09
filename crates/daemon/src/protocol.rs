use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn default_true() -> bool {
    true
}

pub use kanna_agent_protocol::{
    AgentEvent as NeutralAgentEvent, AgentProvider, PermissionDecision, TerminalViewerRole,
};

/// Transactional lifecycle-fenced and provenance-authenticated handoff.
pub const HANDOFF_PROTOCOL_VERSION: u32 = 3;

/// Deployed pre-transaction handoff retained to preserve stable live sessions.
pub const LEGACY_HANDOFF_PROTOCOL_VERSION: u32 = 2;

/// Server/daemon contract required before protected terminal sessions may be
/// created or inherited input policy may be classified.
pub const PROTECTED_INPUT_PROTOCOL_VERSION: u32 =
    kanna_runtime_defaults::PROTECTED_INPUT_PROTOCOL_VERSION;
pub const TERMINAL_GEOMETRY_PROTOCOL_VERSION: u32 = 1;

/// Server/daemon contract required before fenced raw terminal input carrying a
/// producer-declared class may be sent.
pub const RAW_INPUT_PROTOCOL_VERSION: u32 =
    kanna_runtime_defaults::terminal_keys::RAW_INPUT_PROTOCOL_VERSION;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    SessionNotFound,
    SessionIncarnationMismatch,
    SessionAlreadyExists,
    HandoffLost,
    HandoffUnauthorized,
    HandoffVersionMismatch,
    PtySpawnFailed,
    PtyCloneFailed,
    HeadlessTerminalInitFailed,
    WriteFailed,
    UnknownSignal,
    AgentSpawnFailed,
    NotAgentSession,
    UnknownPermissionRequest,
    RetryOnSuccessor,
    InputUnauthorized,
    ProtectedInputProtocolRequired,
}

/// Whether a session is a PTY terminal or a headless agent (NDJSON pipes).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Pty,
    Agent,
}

/// What a producer declares one raw terminal write means for the composer.
///
/// This is the wire spelling of the daemon's internal draft/submission/control
/// vocabulary, carried by [`Command::RawInputIfSession`] so that a fenced raw
/// write can say what it is. `Input`/`InputBoundary`/`InputControl` say the
/// same three things by having three command names; a fenced write says it in
/// one field, because the fence itself is the part that must not vary.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RawInputClass {
    /// Bytes belonging to whatever line is being composed. The daemon decides
    /// from their content whether they could actually create a draft.
    Draft,
    /// The producer knows this write submits the current composer.
    Submission,
    /// Terminal control that neither edits nor submits the composer.
    Control,
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
    /// The provider CLI release this session is running, as the sending daemon
    /// probed it. Absent on a sender that predates version-aware detection, in
    /// which case the successor treats the session as unknown-version and
    /// applies every rule measured for its provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_version: Option<String>,
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
    /// When set, generic daemon input is fenced. Only a kernel-authenticated
    /// native desktop connection may write terminal bytes.
    #[serde(default)]
    pub operator_input_only: bool,
    /// New daemons set this for every handoff entry. When absent on an old
    /// daemon's payload, the successor fences input until kanna-server
    /// classifies the adopted session from durable task state.
    #[serde(default)]
    pub input_policy_classified: bool,
    /// Whether raw terminal input has started a composer draft that has not
    /// yet crossed an explicit producer-declared submission boundary.
    #[serde(default)]
    pub raw_input_draft_active: bool,
    /// Current senders always set this. Its absence identifies a legacy
    /// sender whose payload cannot distinguish an empty composer from a real
    /// inherited draft; successors reject logical input observably until a
    /// producer-declared boundary resolves the ambiguity.
    #[serde(default)]
    pub raw_input_draft_state_known: bool,
    /// Bytes this daemon saw typed into the composer since the session's last
    /// producer-declared submission boundary.
    ///
    /// `None` is not zero: it identifies a sender with no ledger to hand over,
    /// and the successor must treat a declared draft it cannot count as a real
    /// one. Only `Some(0)` is the proof that releases a held message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed_draft_bytes: Option<u64>,
    /// Logical messages a *predecessor* accepted but never submitted, in the
    /// order it accepted them.
    ///
    /// Always empty from a current daemon: logical input is never retained,
    /// so there is no queue to hand over. It stays on the wire so that
    /// adopting from a daemon built before 2026-09-08 — which could hold a
    /// message behind a typed draft indefinitely — submits those messages
    /// instead of dropping an owner's words on the upgrade that removed the
    /// hold.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_logical_inputs: Vec<Vec<u8>>,
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
    pub effort: Option<String>,
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Busy,
    Waiting,
    #[default]
    Idle,
}

/// What this daemon can prove about the text rendered on a session's composer
/// line.
///
/// The frame cannot answer it: a human's unsent line and the CLI's own
/// tab-to-accept suggestion are painted the same shape, and reading the
/// suggestion as a draft is what wedged a task for a day. What *can* answer it
/// is the daemon's own record of the keystrokes it accepted for a session it
/// spawned, which is why this verdict travels beside the composer text
/// everywhere the text goes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ComposerAttestation {
    /// Keystrokes reached this composer since the last producer-declared
    /// submission boundary. Anything rendered there may be a human's unsent
    /// line, so it is treated as one.
    Typed,
    /// An attested session with zero typed bytes since its last boundary.
    /// Nobody here typed anything, so whatever the `❯` line renders is the
    /// provider's own chrome or suggestion — not session content, and not
    /// anything a reader may act on.
    NotTyped,
    /// Inherited from before attestation: this daemon never watched what was
    /// typed, so it can prove nothing either way and says so.
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    /// Negotiate the generic-input fence with the exact kanna-server process.
    /// The daemon pins the caller's kernel identity for this generation.
    NegotiateProtectedInput {
        version: u32,
    },
    /// Prove this daemon understands [`Command::RawInputIfSession`] before any
    /// raw key is sent. A daemon that predates it cannot deserialize that
    /// command and closes the connection without answering, which is
    /// indistinguishable from a daemon that died mid-write — so the capability
    /// is asked for by a command that touches no PTY. A failure here therefore
    /// proves nothing was written, which is what lets the server answer
    /// "unsupported" instead of "uncertain".
    NegotiateRawInput {
        version: u32,
    },
    /// Probe whether this daemon understands viewer roles and controller
    /// registration. Older daemons close the connection on this unknown
    /// command, allowing kanna-server to fall back to legacy sizing.
    NegotiateTerminalGeometry {
        version: u32,
    },
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
        /// Absolute path to the provider CLI this shell command line will run.
        ///
        /// `executable` is the login shell that runs repo setup before the
        /// agent, so the daemon cannot find the CLI by looking at its own
        /// child. The server resolved this path to build the command line, and
        /// the daemon probes it for the CLI version its detection rules are
        /// selected by. Absent on an older server, and on every non-agent
        /// session: the version is then unknown, which applies every rule
        /// measured for the provider.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_executable: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_prelude: Option<Vec<u8>>,
        #[serde(default)]
        operator_input_only: bool,
    },
    AttachSnapshot {
        session_id: String,
        #[serde(default)]
        emulate_terminal: bool,
    },
    Detach {
        session_id: String,
    },
    /// Terminal input whose success response is sent only after every byte has
    /// been written to the PTY. Callers can use the acknowledgement as an
    /// ordering barrier before sending a later, discrete keystroke.
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    /// Acknowledged raw input carrying an explicit producer-known composer
    /// submission boundary.
    InputBoundary {
        session_id: String,
        data: Vec<u8>,
    },
    /// Acknowledged producer-declared terminal control that neither edits nor
    /// submits the task composer (for example a mouse wheel report).
    InputControl {
        session_id: String,
        data: Vec<u8>,
    },
    /// Acknowledged terminal input fenced to the PTY process ID observed
    /// by a preceding `List`. This prevents normal task-id reuse between discovery
    /// and delivery from redirecting input into a replacement stage or rerun.
    InputIfSession {
        session_id: String,
        expected_pid: u32,
        data: Vec<u8>,
    },
    /// Acknowledged raw terminal input fenced to an observed PTY process ID and
    /// carrying the producer's declared composer meaning.
    ///
    /// `InputIfSession` classifies every fenced write as a draft, which is
    /// right for a keystroke and wrong for an Enter: a CR declared a draft
    /// arms the typed-byte ledger against a composer the Enter just emptied,
    /// and every later delivered message is then held behind a line nobody
    /// typed. Agent-facing raw key input needs both the fence and the
    /// declaration, so it says which it is.
    RawInputIfSession {
        session_id: String,
        expected_pid: u32,
        data: Vec<u8>,
        class: RawInputClass,
    },
    /// One logical message for a PTY session. Unlike raw terminal input, the
    /// daemon keeps the message and its synthesized Enter atomic, frames
    /// multiline text as one bracketed paste when the terminal requested that
    /// mode, and defers the delivery while a raw composer draft is active.
    SubmitInput {
        session_id: String,
        data: Vec<u8>,
    },
    /// Logical input fenced to the PTY process ID observed by `List`.
    SubmitInputIfSession {
        session_id: String,
        expected_pid: u32,
        data: Vec<u8>,
    },
    /// Latency-sensitive terminal input. Success is deliberately not
    /// acknowledged, so callers can pipeline ordered bytes without waiting.
    /// Failures are still emitted as asynchronous `Event::Error` values.
    InputNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    /// `InputNoReply` whose terminal producer explicitly knows the event
    /// submits the current composer. Embedded CR/LF bytes never imply this.
    InputBoundaryNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    /// Latency-sensitive producer-declared terminal control. It preserves the
    /// current draft state and cannot release queued logical messages.
    InputControlNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    /// Process-authenticated native operator input for protected sessions.
    OperatorInput {
        session_id: String,
        data: Vec<u8>,
    },
    /// Server-originated, machine-protocol input for a protected session.
    /// The daemon authenticates the peer's exact process identity; this is not
    /// exposed by agent-facing HTTP, KSP, MCP, or CLI surfaces.
    SystemInput {
        session_id: String,
        data: Vec<u8>,
    },
    /// Transfer native operator authority after the previously pinned desktop
    /// has exited. Carries no reusable credential; the daemon authenticates
    /// the socket peer from kernel process metadata.
    AdoptOperator,
    /// Pin the exact kanna-server process authorized to submit protected
    /// system input. Only the kernel-authenticated native desktop may perform
    /// this handoff; the pid is revalidated with start time and executable.
    AuthorizeServer {
        pid: u32,
    },
    /// Server-authenticated classification for an adopted legacy session.
    /// The authenticated server may clear retired policies after an upgrade.
    ClassifyInput {
        session_id: String,
        operator_input_only: bool,
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
    /// Atomically register the authenticated viewer and its initial measured
    /// dimensions. Subsequent ResizeNoReply requests from the same control
    /// connection only affect the elected controller.
    RegisterViewer {
        session_id: String,
        viewer_id: String,
        role: TerminalViewerRole,
        generation: u64,
        cols: u16,
        rows: u16,
        #[serde(default = "default_true")]
        visible: bool,
    },
    TakeoverViewer {
        session_id: String,
    },
    ReleaseViewer {
        session_id: String,
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
    ProtectedInputReady {
        version: u32,
    },
    /// This daemon speaks the fenced raw-input contract at `version`.
    RawInputReady {
        version: u32,
    },
    TerminalGeometryReady {
        version: u32,
    },
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
    SessionCreated {
        session_id: String,
    },
    /// The composer line, and what this daemon can prove about it, changed.
    ///
    /// Emitted on the edge from the session's own status loop rather than
    /// folded into `StatusChanged`, because the composer moves on its own
    /// edges: a suggestion appears, a human starts typing, a boundary clears
    /// the ledger — none of which is a status transition.
    ComposerChanged {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        composer_text: Option<String>,
        composer_attestation: ComposerAttestation,
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
        /// Provider that owns the live terminal session. Reconnect clients
        /// use this runtime fact rather than task configuration when applying
        /// provider-specific snapshot behavior.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_provider: Option<AgentProvider>,
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
    /// The text rendered on this session's composer line, when its frame draws
    /// a readable one. Reported as its own field — never folded into a status
    /// snippet — so a reader cannot mistake it for something the session said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_text: Option<String>,
    /// What the daemon can prove about that text. Absent on a daemon that
    /// predates the field, which reports `unknown` — the honest answer for a
    /// daemon with no ledger.
    #[serde(default)]
    pub composer_attestation: ComposerAttestation,
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
            agent_executable: None,
            terminal_prelude: Some(b"stage marker\r\n".to_vec()),
            operator_input_only: false,
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
                operator_input_only: false,
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
    fn test_command_input_if_session_roundtrip() {
        let cmd = Command::InputIfSession {
            session_id: "s1".to_string(),
            expected_pid: 42,
            data: b"hello".to_vec(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: Command = serde_json::from_str(&json).unwrap();
        match decoded {
            Command::InputIfSession {
                session_id,
                expected_pid,
                data,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(expected_pid, 42);
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
            agent_provider: Some(AgentProvider::Claude),
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::Snapshot {
                session_id,
                snapshot,
                agent_provider,
            } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(snapshot.version, 1);
                assert_eq!(snapshot.vt, "hello");
                assert_eq!(snapshot.saved_at, 123);
                assert_eq!(snapshot.sequence, 7);
                assert_eq!(agent_provider, Some(AgentProvider::Claude));
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
            agent_provider: None,
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
                cli_version: None,
                status: SessionStatus::Idle,
                kind: SessionKind::Pty,
                provider_session_id: None,
                agent_fd_count: 0,
                agent_spawn: None,
                operator_input_only: false,
                input_policy_classified: true,
                raw_input_draft_active: true,
                raw_input_draft_state_known: true,
                typed_draft_bytes: Some(9),
                pending_logical_inputs: vec![b"manager message".to_vec()],
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
                assert!(sessions[0].raw_input_draft_active);
                assert!(sessions[0].raw_input_draft_state_known);
                assert_eq!(
                    sessions[0].pending_logical_inputs,
                    [b"manager message".to_vec()]
                );
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn test_older_handoff_payload_marks_raw_draft_state_unknown() {
        let json = r#"{
            "type":"HandoffReady",
            "sessions":[{
                "session_id":"sess-1",
                "pid":42,
                "cwd":"/tmp",
                "rows":24,
                "cols":80,
                "snapshot":null
            }]
        }"#;

        let decoded: Event = serde_json::from_str(json).unwrap();
        match decoded {
            Event::HandoffReady { sessions } => {
                assert!(!sessions[0].raw_input_draft_active);
                assert!(!sessions[0].raw_input_draft_state_known);
                assert!(sessions[0].pending_logical_inputs.is_empty());
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
    fn retry_on_successor_error_roundtrips_with_its_stable_wire_name() {
        let json = serde_json::to_string(&Event::Error {
            code: Some(ErrorCode::RetryOnSuccessor),
            message: "daemon handoff already committed; retry against the adopting daemon"
                .to_string(),
        })
        .unwrap();
        assert!(json.contains(r#""code":"retry_on_successor""#));
        match serde_json::from_str::<Event>(&json).unwrap() {
            Event::Error { code, message } => {
                assert_eq!(code, Some(ErrorCode::RetryOnSuccessor));
                assert!(message.contains("retry against the adopting daemon"));
            }
            other => panic!("expected Error, got {other:?}"),
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
            composer_text: None,
            composer_attestation: ComposerAttestation::NotTyped,
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
                composer_text: Some("half typed".to_string()),
                composer_attestation: ComposerAttestation::Typed,
            }],
        };
        let json = serde_json::to_string(&evt).unwrap();
        let decoded: Event = serde_json::from_str(&json).unwrap();
        match decoded {
            Event::SessionList { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].session_id, "s1");
                assert_eq!(sessions[0].composer_attestation, ComposerAttestation::Typed);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn session_list_from_a_daemon_without_the_composer_fields_reports_unknown() {
        let json = r#"{
            "type":"SessionList",
            "sessions":[{
                "session_id":"s1",
                "pid":1,
                "cwd":"/tmp",
                "state":"Active",
                "idle_seconds":0,
                "status":"idle"
            }]
        }"#;

        match serde_json::from_str::<Event>(json).unwrap() {
            Event::SessionList { sessions } => {
                assert_eq!(
                    sessions[0].composer_attestation,
                    ComposerAttestation::Unknown
                );
                assert_eq!(sessions[0].composer_text, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// A predecessor built before the input hold was removed may still be
    /// holding an owner's message. Its payload has to keep decoding, because
    /// the adopting daemon submits what it finds there rather than dropping
    /// somebody's words on the upgrade that removed the hold.
    #[test]
    fn a_legacy_handoff_payload_still_carries_its_retained_messages() {
        let json = r#"{
            "type":"HandoffReady",
            "sessions":[{
                "session_id":"sess-1",
                "pid":42,
                "cwd":"/tmp",
                "rows":24,
                "cols":80,
                "snapshot":null,
                "pending_logical_inputs":[[104,105]]
            }]
        }"#;

        match serde_json::from_str::<Event>(json).unwrap() {
            Event::HandoffReady { sessions } => {
                assert_eq!(sessions[0].pending_logical_inputs, [b"hi".to_vec()]);
            }
            other => panic!("wrong variant: {other:?}"),
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
