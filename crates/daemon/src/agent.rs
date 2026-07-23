//! Headless agent sessions.
//!
//! An agent session runs a provider CLI (Claude, Codex) headless on plain
//! pipes instead of a PTY. Each stdout line is translated by the provider
//! adapter (crates/kanna-agent-protocol) into neutral [`AgentEvent`]s and
//! appended to a per-session, seq-numbered journal — the agent-session analog
//! of the headless terminal: authoritative while detached, snapshot + live
//! stream on attach, persisted to disk so it survives daemon handoff.

use std::collections::{HashMap, HashSet};
use std::io::Write as IoWrite;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Arc;

use tokio::sync::Mutex;

use kanna_agent_protocol::{
    AgentEvent, ClaudeAdapter, CodexAdapter, OpencodeAdapter, ProviderAdapter, SpawnCtx, SpawnSpec,
    TurnModel,
};

use crate::protocol::{AgentProvider, AgentSpawnParams, SeqAgentEvent, SessionStatus};

/// A single attached client's writer handle (same shape as PTY writers).
pub type AgentClientWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

/// Registry of agent sessions, separate from the PTY `SessionManager`.
pub type AgentSessions = Arc<Mutex<HashMap<String, AgentSessionRecord>>>;

pub fn make_adapter(provider: AgentProvider) -> Option<Box<dyn ProviderAdapter + Send>> {
    match provider {
        AgentProvider::Claude => Some(Box::new(ClaudeAdapter::new())),
        AgentProvider::Codex => Some(Box::new(CodexAdapter::new())),
        AgentProvider::Opencode => Some(Box::new(OpencodeAdapter::new())),
        // PTY-only providers — no headless adapter yet.
        AgentProvider::Copilot | AgentProvider::Antigravity => None,
    }
}

pub fn params_to_ctx(params: &AgentSpawnParams) -> SpawnCtx {
    SpawnCtx {
        prompt: params.prompt.clone(),
        cwd: params.cwd.clone(),
        model: params.model.clone(),
        permission_mode: params.permission_mode.clone(),
        allowed_tools: params.allowed_tools.clone(),
        disallowed_tools: params.disallowed_tools.clone(),
        max_turns: params.max_turns,
        max_budget_usd: params.max_budget_usd,
        system_prompt: params.system_prompt.clone(),
        mcp_config_path: params.mcp_config_path.clone(),
    }
}

/// Map a journaled event to the session status it implies, if any.
pub fn event_status(event: &AgentEvent) -> Option<SessionStatus> {
    match event {
        AgentEvent::TurnStarted { .. }
        | AgentEvent::UserMessage { .. }
        | AgentEvent::AssistantText { .. }
        | AgentEvent::Thinking { .. }
        | AgentEvent::ToolCall { .. }
        | AgentEvent::ToolResult { .. }
        | AgentEvent::ToolProgress { .. } => Some(SessionStatus::Busy),
        AgentEvent::PermissionRequest { .. } => Some(SessionStatus::Waiting),
        AgentEvent::PermissionResolved { .. } => Some(SessionStatus::Busy),
        AgentEvent::TurnCompleted { .. } | AgentEvent::SessionEnded { .. } => {
            Some(SessionStatus::Idle)
        }
        AgentEvent::Diagnostic { .. } | AgentEvent::Raw { .. } => None,
    }
}

/// Append-only event journal: in memory plus an NDJSON file under
/// `<daemon-data>/agent-journals/{session_id}.ndjson`. Each line is a
/// [`SeqAgentEvent`]; the file is reloaded on daemon restart/handoff.
pub struct AgentJournal {
    path: PathBuf,
    metadata_path: PathBuf,
    file: Option<std::fs::File>,
    events: Vec<SeqAgentEvent>,
    provider_session_id: Option<String>,
    /// Disk persistence failed at least once (already reported).
    degraded: bool,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct AgentJournalMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_session_id: Option<String>,
}

impl AgentJournal {
    pub fn journal_dir(data_dir: &Path) -> PathBuf {
        data_dir.join("agent-journals")
    }

    /// Open (or create) the journal for a session, loading existing events.
    pub fn open(data_dir: &Path, session_id: &str) -> Self {
        let dir = Self::journal_dir(data_dir);
        let path = dir.join(format!("{session_id}.ndjson"));
        let metadata_path = dir.join(format!("{session_id}.meta.json"));

        let mut events = Vec::new();
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<SeqAgentEvent>(line) {
                    Ok(event) => events.push(event),
                    Err(error) => {
                        log::warn!("[agent] skipping corrupt journal line in {path:?}: {error}")
                    }
                }
            }
        }

        let provider_session_id = std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|content| serde_json::from_str::<AgentJournalMetadata>(&content).ok())
            .and_then(|metadata| metadata.provider_session_id);

        let file = std::fs::create_dir_all(&dir)
            .and_then(|_| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
            })
            .map_err(|error| {
                log::error!("[agent] journal disk persistence unavailable for {path:?}: {error}");
                error
            })
            .ok();
        let degraded = file.is_none();

        Self {
            path,
            metadata_path,
            file,
            events,
            provider_session_id,
            degraded,
        }
    }

    /// Append an event; returns its seq. Disk failures degrade to
    /// memory-only (reported once via log + a Diagnostic event from the
    /// caller), never lose the in-memory event.
    pub fn append(&mut self, event: AgentEvent) -> SeqAgentEvent {
        let seq = self.events.len() as u64;
        let entry = SeqAgentEvent { seq, event };
        if let Some(file) = self.file.as_mut() {
            let write_result = serde_json::to_string(&entry)
                .map_err(std::io::Error::other)
                .and_then(|line| writeln!(file, "{line}"));
            if let Err(error) = write_result {
                if !self.degraded {
                    log::error!(
                        "[agent] journal write failed for {:?} (continuing in memory): {}",
                        self.path,
                        error
                    );
                }
                self.degraded = true;
                self.file = None;
            }
        }
        self.events.push(entry.clone());
        entry
    }

    /// True after a disk write has failed; the caller surfaces this once as
    /// a Diagnostic event.
    pub fn is_degraded(&self) -> bool {
        self.degraded
    }

    /// The seq the next appended event will get.
    pub fn next_seq(&self) -> u64 {
        self.events.len() as u64
    }

    pub fn events_from(&self, from_seq: u64) -> Vec<SeqAgentEvent> {
        let start = usize::try_from(from_seq).unwrap_or(usize::MAX);
        if start >= self.events.len() {
            return Vec::new();
        }
        self.events[start..].to_vec()
    }

    pub fn provider_session_id(&self) -> Option<String> {
        self.provider_session_id.clone()
    }

    pub fn latest_assistant_prompt(&self) -> Option<String> {
        self.events
            .iter()
            .rev()
            .find_map(|entry| match &entry.event {
                AgentEvent::AssistantText { text, .. } => {
                    crate::headless_terminal::bound_waiting_prompt(text)
                }
                _ => None,
            })
    }

    pub fn set_provider_session_id(&mut self, provider_session_id: &str) {
        if self.provider_session_id.as_deref() == Some(provider_session_id) {
            return;
        }
        self.provider_session_id = Some(provider_session_id.to_string());
        let metadata = AgentJournalMetadata {
            provider_session_id: self.provider_session_id.clone(),
        };
        let write_result = std::fs::create_dir_all(
            self.metadata_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new(".")),
        )
        .and_then(|_| serde_json::to_string(&metadata).map_err(std::io::Error::other))
        .and_then(|json| std::fs::write(&self.metadata_path, json));
        if let Err(error) = write_result {
            log::warn!(
                "[agent] failed to persist provider session id to {:?}: {}",
                self.metadata_path,
                error
            );
        }
    }

    /// Tool names granted AllowSession, derived from the journal so the
    /// auto-approval rules survive daemon handoff.
    pub fn session_allowed_tools(&self) -> HashSet<String> {
        let mut request_tools: HashMap<String, String> = HashMap::new();
        let mut allowed = HashSet::new();
        for entry in &self.events {
            match &entry.event {
                AgentEvent::PermissionRequest {
                    request_id,
                    tool_name,
                    ..
                } => {
                    request_tools.insert(request_id.clone(), tool_name.clone());
                }
                AgentEvent::PermissionResolved {
                    request_id,
                    decision: kanna_agent_protocol::PermissionDecision::AllowSession,
                } => {
                    if let Some(tool) = request_tools.get(request_id) {
                        allowed.insert(tool.clone());
                    }
                }
                _ => {}
            }
        }
        allowed
    }

    /// Permission requests with no matching resolution — pending prompts a
    /// late-attaching client must still answer.
    pub fn pending_permission_ids(&self) -> HashSet<String> {
        let mut pending = HashSet::new();
        for entry in &self.events {
            match &entry.event {
                AgentEvent::PermissionRequest { request_id, .. } => {
                    pending.insert(request_id.clone());
                }
                AgentEvent::PermissionResolved { request_id, .. } => {
                    pending.remove(request_id);
                }
                _ => {}
            }
        }
        pending
    }

    pub fn remove_file(&mut self) {
        self.file = None;
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "[agent] failed to remove journal {:?}: {}",
                    self.path,
                    error
                );
            }
        }
        if let Err(error) = std::fs::remove_file(&self.metadata_path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "[agent] failed to remove journal metadata {:?}: {}",
                    self.metadata_path,
                    error
                );
            }
        }
    }
}

/// Journal + attached writers behind one lock so attach (snapshot, then join
/// the live stream) is atomic against concurrent appends.
pub struct AgentShared {
    pub journal: AgentJournal,
    pub writers: Vec<AgentClientWriter>,
}

pub struct AgentSessionRecord {
    pub provider: AgentProvider,
    pub params: AgentSpawnParams,
    /// Adapter is shared with the reader thread (sync mutex: parse_line is
    /// CPU-only and never blocks).
    pub adapter: Arc<std::sync::Mutex<Box<dyn ProviderAdapter + Send>>>,
    pub shared: Arc<Mutex<AgentShared>>,
    pub child: Option<Child>,
    pub stdin: Option<ChildStdin>,
    pub pid: u32,
    pub provider_session_id: Option<String>,
    pub status: SessionStatus,
    pub last_assistant_prompt: Option<String>,
    /// Tool names auto-approved for the rest of the session (AllowSession).
    pub session_allowed_tools: HashSet<String>,
    /// Permission request ids awaiting a decision.
    pub pending_permissions: HashSet<String>,
    pub exited: bool,
    /// Set when the user asks to stop the agent. The child's resulting exit is
    /// then surfaced as an interruption rather than a crash.
    pub interrupt_requested: bool,
    pub turn_model: TurnModel,
    pub created_at: std::time::Instant,
    pub last_activity_at: std::time::Instant,
    /// Dup'd pipe fds reserved for handoff; closed when the child exits.
    pub handoff_fds: Option<AgentHandoffFds>,
}

pub struct SpawnedAgentChild {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout: std::process::ChildStdout,
    pub stderr: std::process::ChildStderr,
    pub pid: u32,
    pub handoff_fds: Option<AgentHandoffFds>,
}

/// Duplicated pipe fds held for daemon handoff: transferring these via
/// SCM_RIGHTS keeps the child's pipes open across the daemon swap.
#[derive(Debug, Clone, Copy)]
pub struct AgentHandoffFds {
    pub stdout: std::os::unix::io::RawFd,
    pub stderr: std::os::unix::io::RawFd,
    pub stdin: Option<std::os::unix::io::RawFd>,
}

impl AgentHandoffFds {
    pub fn as_vec(&self) -> Vec<std::os::unix::io::RawFd> {
        let mut fds = vec![self.stdout, self.stderr];
        if let Some(stdin) = self.stdin {
            fds.push(stdin);
        }
        fds
    }

    pub fn close(self) {
        for fd in self.as_vec() {
            unsafe { libc::close(fd) };
        }
    }
}

/// Duplicate an fd with close-on-exec so it never leaks into spawned
/// children.
pub use crate::fd::dup_cloexec;

/// Resolve an executable name against the spawn env's PATH (falling back to
/// the daemon's own PATH). Absolute/relative paths pass through.
pub fn resolve_executable(name: &str, env: &HashMap<String, String>) -> PathBuf {
    if name.contains('/') {
        return PathBuf::from(name);
    }
    let path_var = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

/// Spawn the provider child headless: plain pipes, own session (`setsid`) so
/// it survives daemon exit, stdin primed per the spec (initial user message
/// for stream-json providers, closed immediately for per-turn providers,
/// which block reading piped stdin to EOF).
pub fn spawn_agent_child(
    spec: &SpawnSpec,
    cwd: &str,
    env: &HashMap<String, String>,
) -> std::io::Result<SpawnedAgentChild> {
    let executable = resolve_executable(&spec.executable, env);
    let mut command = std::process::Command::new(&executable);
    command
        .args(&spec.args)
        .current_dir(cwd)
        .envs(env)
        .envs(spec.env.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Detach from the daemon's process group so daemon restarts and Ctrl+C
    // never reach the agent child (same as PTY children).
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = command.spawn()?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("agent child spawned without stdout pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("agent child spawned without stderr pipe"))?;
    let mut stdin = child.stdin.take();
    // Keep stdin's dup decision until after the initial write below.
    let stdin_keeps_open = spec.initial_stdin.is_some();

    match &spec.initial_stdin {
        Some(line) => {
            if let Some(handle) = stdin.as_mut() {
                handle.write_all(line.as_bytes())?;
                handle.write_all(b"\n")?;
                handle.flush()?;
            }
        }
        None => {
            // Close stdin: per-turn providers (codex exec) read piped stdin
            // to EOF before starting.
            stdin = None;
        }
    }

    // Duplicate the pipe fds for handoff. Failure degrades gracefully: the
    // session works, it just can't be transferred to a new daemon.
    let handoff_fds = {
        use std::os::unix::io::AsRawFd;
        let dup_all = || -> std::io::Result<AgentHandoffFds> {
            let stdout_dup = dup_cloexec(stdout.as_raw_fd())?;
            let stderr_dup = match dup_cloexec(stderr.as_raw_fd()) {
                Ok(fd) => fd,
                Err(error) => {
                    unsafe { libc::close(stdout_dup) };
                    return Err(error);
                }
            };
            let stdin_dup = match (stdin_keeps_open, stdin.as_ref()) {
                (true, Some(handle)) => match dup_cloexec(handle.as_raw_fd()) {
                    Ok(fd) => Some(fd),
                    Err(error) => {
                        unsafe { libc::close(stdout_dup) };
                        unsafe { libc::close(stderr_dup) };
                        return Err(error);
                    }
                },
                _ => None,
            };
            Ok(AgentHandoffFds {
                stdout: stdout_dup,
                stderr: stderr_dup,
                stdin: stdin_dup,
            })
        };
        match dup_all() {
            Ok(fds) => Some(fds),
            Err(error) => {
                log::warn!("[agent] failed to dup pipes for handoff (pid={pid}): {error}");
                None
            }
        }
    };

    Ok(SpawnedAgentChild {
        child,
        stdin,
        stdout,
        stderr,
        pid,
        handoff_fds,
    })
}

/// Signal the agent child's process group.
pub fn signal_agent_pid(pid: u32, signal: i32) -> std::io::Result<()> {
    let target = -(pid as i32);
    let ret = unsafe { libc::kill(target, signal) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn opencode_has_headless_adapter() {
        let adapter = make_adapter(AgentProvider::Opencode).expect("opencode adapter exists");
        assert_eq!(adapter.provider(), "opencode");
        assert_eq!(adapter.turn_model(), TurnModel::PerTurn);
    }

    #[test]
    fn spawn_agent_child_uses_requested_process_cwd() {
        let dir = tempdir::TempDirGuard::new("agent-child-cwd");
        let spec = SpawnSpec {
            executable: "/bin/pwd".to_string(),
            args: Vec::new(),
            env: Vec::new(),
            initial_stdin: None,
        };

        let mut spawned = spawn_agent_child(&spec, dir.path().to_str().unwrap(), &HashMap::new())
            .expect("spawn pwd child");
        let mut output = String::new();
        spawned
            .stdout
            .read_to_string(&mut output)
            .expect("read pwd output");
        let status = spawned.child.wait().expect("wait for pwd child");

        assert!(status.success());
        let actual = std::fs::canonicalize(output.trim()).expect("canonicalize pwd output");
        let expected = std::fs::canonicalize(dir.path()).expect("canonicalize temp cwd");
        assert_eq!(actual, expected);
    }

    fn journal_in_temp() -> (tempdir::TempDirGuard, AgentJournal) {
        let dir = tempdir::TempDirGuard::new("agent-journal-test");
        let journal = AgentJournal::open(dir.path(), "sess-1");
        (dir, journal)
    }

    // Minimal temp-dir helper (no external dev-dependency).
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct TempDirGuard(PathBuf);

        impl TempDirGuard {
            pub fn new(prefix: &str) -> Self {
                let pid = std::process::id();
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0);
                let path = std::env::temp_dir().join(format!("{prefix}-{pid}-{nanos}"));
                std::fs::create_dir_all(&path).expect("create temp dir");
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn journal_appends_and_replays_with_seq() {
        let (_dir, mut journal) = journal_in_temp();
        assert_eq!(journal.next_seq(), 0);

        let first = journal.append(AgentEvent::TurnStarted { model: None });
        let second = journal.append(AgentEvent::AssistantText {
            text: "hi".into(),
            truncated: false,
        });
        assert_eq!(first.seq, 0);
        assert_eq!(second.seq, 1);
        assert_eq!(journal.next_seq(), 2);

        assert_eq!(journal.events_from(0).len(), 2);
        let tail = journal.events_from(1);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].seq, 1);
        assert!(journal.events_from(99).is_empty());
    }

    #[test]
    fn journal_returns_latest_bounded_assistant_text() {
        let (_dir, mut journal) = journal_in_temp();
        journal.append(AgentEvent::AssistantText {
            text: "Older response".into(),
            truncated: false,
        });
        journal.append(AgentEvent::ToolResult {
            call_id: "tool-1".into(),
            output: "ignored tool output".into(),
            truncated: false,
            is_error: false,
        });
        journal.append(AgentEvent::AssistantText {
            text: "Latest answer\nwith spacing".into(),
            truncated: false,
        });

        assert_eq!(
            journal.latest_assistant_prompt().as_deref(),
            Some("Latest answer with spacing")
        );
    }

    #[test]
    fn journal_persists_and_reloads_from_disk() {
        let dir = tempdir::TempDirGuard::new("agent-journal-reload");
        {
            let mut journal = AgentJournal::open(dir.path(), "sess-2");
            journal.append(AgentEvent::TurnStarted { model: None });
            journal.append(AgentEvent::AssistantText {
                text: "persisted".into(),
                truncated: false,
            });
        }

        let reloaded = AgentJournal::open(dir.path(), "sess-2");
        assert_eq!(reloaded.next_seq(), 2);
        let events = reloaded.events_from(0);
        assert!(
            matches!(&events[1].event, AgentEvent::AssistantText { text, .. } if text == "persisted")
        );
    }

    #[test]
    fn journal_tracks_pending_permissions() {
        let (_dir, mut journal) = journal_in_temp();
        journal.append(AgentEvent::PermissionRequest {
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            input: serde_json::json!({}),
        });
        journal.append(AgentEvent::PermissionRequest {
            request_id: "r2".into(),
            tool_name: "Edit".into(),
            input: serde_json::json!({}),
        });
        journal.append(AgentEvent::PermissionResolved {
            request_id: "r1".into(),
            decision: kanna_agent_protocol::PermissionDecision::Allow,
        });

        let pending = journal.pending_permission_ids();
        assert_eq!(pending.len(), 1);
        assert!(pending.contains("r2"));
    }

    #[test]
    fn event_status_mapping() {
        assert_eq!(
            event_status(&AgentEvent::PermissionRequest {
                request_id: "r".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({}),
            }),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(
            event_status(&AgentEvent::TurnCompleted {
                status: kanna_agent_protocol::TurnStatus::Success,
                stats: Default::default(),
            }),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            event_status(&AgentEvent::Diagnostic {
                message: "x".into()
            }),
            None
        );
    }

    #[test]
    fn resolve_executable_uses_env_path() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        let resolved = resolve_executable("sh", &env);
        assert!(
            resolved.is_absolute(),
            "expected absolute path: {resolved:?}"
        );
        assert!(resolved.ends_with("sh"));

        let passthrough = resolve_executable("/opt/custom/claude", &env);
        assert_eq!(passthrough, PathBuf::from("/opt/custom/claude"));
    }
}
