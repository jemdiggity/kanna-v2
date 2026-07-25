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

        // Legacy journals can contain DUPLICATE seq values: before one shared
        // sequencer per session id existed, two `AgentJournal` handles over
        // this one file each allocated seq from their own in-memory vec. Those
        // duplicates are already on disk, and `append`/`next_seq` assume
        // seq == index, so replay and resume would misbehave. Compile the
        // history into a dense, unique sequence at load, once, atomically.
        if Self::needs_seq_migration(&events) {
            let repaired: Vec<SeqAgentEvent> = events
                .into_iter()
                .enumerate()
                .map(|(index, entry)| SeqAgentEvent {
                    seq: index as u64,
                    event: entry.event,
                })
                .collect();
            match Self::rewrite_atomically(&dir, &path, &repaired) {
                Ok(()) => log::info!(
                    "[agent] migrated {} journal entries in {:?} to a dense unique sequence",
                    repaired.len(),
                    path
                ),
                Err(error) => log::error!(
                    "[agent] failed to migrate duplicate seqs in {:?}: {}                      (continuing with the repaired in-memory history)",
                    path,
                    error
                ),
            }
            events = repaired;
        }

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

    /// True when the loaded history is not already a dense 0..n sequence —
    /// i.e. it contains duplicates or gaps written by an older daemon.
    fn needs_seq_migration(events: &[SeqAgentEvent]) -> bool {
        events
            .iter()
            .enumerate()
            .any(|(index, entry)| entry.seq != index as u64)
    }

    /// Rewrite the journal file so it exactly matches `events`. Atomic: the
    /// replacement is staged in a sibling temp file, flushed, then renamed over
    /// the original, so a crash mid-migration leaves the old file intact rather
    /// than a half-written history.
    fn rewrite_atomically(
        dir: &Path,
        path: &Path,
        events: &[SeqAgentEvent],
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let staging = path.with_extension("ndjson.migrating");
        {
            let mut file = std::fs::File::create(&staging)?;
            for entry in events {
                let line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
                writeln!(file, "{line}")?;
            }
            file.sync_all()?;
        }
        std::fs::rename(&staging, path)
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

/// One `AgentShared` — and therefore exactly one journal and one sequence
/// space — per session id, for the daemon's lifetime.
///
/// The journal is a single append-only file keyed by session id, so two
/// `AgentJournal` instances over that file each allocate `seq` from their own
/// in-memory `events` vec and produce duplicate sequence numbers. That
/// happens whenever a session id has more than one life at once: a stale
/// reader still draining the previous child while the replacement record
/// journals its own events. Sharing the handle makes the sequencer
/// authoritative for the id, which is also the correct transcript semantics
/// (same id, same file, one ordered history).
pub fn shared_agent_state(data_dir: &Path, session_id: &str) -> Arc<Mutex<AgentShared>> {
    let registry = shared_registry();
    let mut guard = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Weak, not strong: the map coordinates OVERLAPPING lives of one id (so
    // they share a sequencer) without owning the state. Once the record and
    // every stale reader are gone the last strong reference drops, releasing
    // the journal file handle, its event vector, and any writer sockets. A
    // strong map would retain all of that for the daemon's lifetime, so
    // repeated session churn would grow memory and fds without bound.
    if let Some(existing) = guard.get(session_id).and_then(std::sync::Weak::upgrade) {
        return existing;
    }
    // Opportunistically drop entries whose lives have all ended.
    guard.retain(|_, weak| weak.strong_count() > 0);
    let fresh = Arc::new(Mutex::new(AgentShared {
        journal: AgentJournal::open(data_dir, session_id),
        writers: Vec::new(),
    }));
    guard.insert(session_id.to_string(), Arc::downgrade(&fresh));
    fresh
}

type SharedRegistry = std::sync::Mutex<HashMap<String, std::sync::Weak<Mutex<AgentShared>>>>;

fn shared_registry() -> &'static SharedRegistry {
    static REGISTRY: std::sync::OnceLock<SharedRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Number of live (still-referenced) shared journal handles. Diagnostics and
/// leak regressions.
pub fn live_shared_agent_states() -> usize {
    let guard = shared_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .values()
        .filter(|weak| weak.strong_count() > 0)
        .count()
}

pub struct AgentSessionRecord {
    pub provider: AgentProvider,
    pub run_id: Option<String>,
    pub params: AgentSpawnParams,
    /// Adapter is shared with the reader thread (sync mutex: parse_line is
    /// CPU-only and never blocks).
    pub adapter: Arc<std::sync::Mutex<Box<dyn ProviderAdapter + Send>>>,
    pub shared: Arc<Mutex<AgentShared>>,
    pub child: Option<Child>,
    pub stdin: Option<ChildStdin>,
    pub pid: u32,
    /// Start-time identity of `pid`, captured while the child was provably
    /// ours (at spawn, or bound via descriptor provenance at adoption).
    /// `None` means the identity was never proven — such pids are refused by
    /// `signal_agent_pid`.
    pub child_start: Option<crate::proc_info::StartTime>,
    /// Process-globally unique, never-reused token for the child slot this
    /// record currently owns. A fresh token is drawn from
    /// [`next_agent_incarnation`] at record creation and at every respawn
    /// reservation, so a reader or installer holding a stale token can never
    /// match a same-id record that was killed and recreated (no ABA).
    pub incarnation: u64,
    /// A (re)spawn is in flight (reserved under the registry lock, resolved
    /// by the same task that reserved it). Concurrent respawns are rejected.
    pub spawning: bool,
    /// True while this record is only an INITIAL SpawnAgent reservation: it
    /// has no child, no pid, and no provider session id, so it cannot resume.
    /// If such a reservation loses its install it must be REMOVED, not rolled
    /// back — a leftover ghost would occupy the id and block both retry and
    /// transfer.
    pub reservation_is_initial: bool,
    pub provider_session_id: Option<String>,
    pub status: SessionStatus,
    pub last_assistant_prompt: Option<String>,
    /// Tool names auto-approved for the rest of the session (AllowSession).
    pub session_allowed_tools: HashSet<String>,
    /// Permission request ids awaiting a decision.
    pub pending_permissions: HashSet<String>,
    pub exited: bool,
    /// Whether a TERMINAL `Event::Exit` has actually been published for this
    /// session. Distinct from `exited`: a per-turn provider exits cleanly
    /// after every turn by design and deliberately publishes NO Exit, so
    /// `exited` alone would make a later Kill of that idle session emit none
    /// at all. Kill announces exactly when this is still false.
    pub exit_published: bool,
    /// Set when the user asks to stop the agent. The child's resulting exit is
    /// then surfaced as an interruption rather than a crash.
    pub interrupt_requested: bool,
    pub turn_model: TurnModel,
    pub created_at: std::time::Instant,
    pub last_activity_at: std::time::Instant,
    /// Dup'd pipe fds reserved for handoff; closed when the child exits.
    pub handoff_fds: Option<AgentHandoffFds>,
}

/// Draw a process-globally unique incarnation token (never zero, never
/// reused). See `AgentSessionRecord::incarnation`.
pub fn next_agent_incarnation() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub struct SpawnedAgentChild {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout: std::process::ChildStdout,
    pub stderr: std::process::ChildStderr,
    pub pid: u32,
    /// Start-time identity of the spawned child (see
    /// `AgentSessionRecord::child_start`).
    pub child_start: Option<crate::proc_info::StartTime>,
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
    /// Duplicate a full pipe bundle close-on-exec. Never leaks a partial
    /// bundle: if any duplication fails, every duplicate already made is
    /// closed before the error is returned. The source fds are untouched.
    pub fn dup_from(
        stdout: std::os::unix::io::RawFd,
        stderr: std::os::unix::io::RawFd,
        stdin: Option<std::os::unix::io::RawFd>,
    ) -> std::io::Result<Self> {
        let stdout_dup = dup_cloexec(stdout)?;
        let stderr_dup = match dup_cloexec(stderr) {
            Ok(fd) => fd,
            Err(error) => {
                unsafe { libc::close(stdout_dup) };
                return Err(error);
            }
        };
        let stdin_dup = match stdin {
            Some(fd) => match dup_cloexec(fd) {
                Ok(fd) => Some(fd),
                Err(error) => {
                    unsafe {
                        libc::close(stdout_dup);
                        libc::close(stderr_dup);
                    }
                    return Err(error);
                }
            },
            None => None,
        };
        Ok(AgentHandoffFds {
            stdout: stdout_dup,
            stderr: stderr_dup,
            stdin: stdin_dup,
        })
    }

    pub fn as_vec(&self) -> Vec<std::os::unix::io::RawFd> {
        let mut fds = vec![self.stdout, self.stderr];
        if let Some(stdin) = self.stdin {
            fds.push(stdin);
        }
        fds
    }

    /// Duplicate this bundle into independently owned descriptors. The
    /// duplicates outlive the record's own cleanup, so a handoff sender can
    /// hold them through sendmsg + acknowledgement even if the child exits
    /// and the record closes its originals in between. Partial duplicates
    /// are closed on failure (Vec<OwnedFd> drop).
    pub fn duplicate_owned(&self) -> std::io::Result<Vec<std::os::unix::io::OwnedFd>> {
        use std::os::unix::io::FromRawFd;
        let mut owned = Vec::new();
        for fd in self.as_vec() {
            let dup = dup_cloexec(fd)?;
            owned.push(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(dup) });
        }
        Ok(owned)
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

    // Fork/exec inside the spawn/fd boundary so this child can never capture
    // another thread's not-yet-CLOEXEC descriptor (e.g. a PTY pair mid-open).
    let mut child = {
        let _spawn_boundary = crate::fd::spawn_fd_boundary();
        command.spawn()?
    };
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

    // Record the child's start-time identity while it is provably ours; every
    // later signal re-verifies it so a recycled pid is never targeted.
    let child_start = crate::proc_info::process_info(pid as libc::pid_t).map(|info| info.start);

    // Duplicate the pipe fds for handoff. Failure degrades gracefully: the
    // session works, it just can't be transferred to a new daemon.
    let handoff_fds = {
        use std::os::unix::io::AsRawFd;
        let stdin_fd = match (stdin_keeps_open, stdin.as_ref()) {
            (true, Some(handle)) => Some(handle.as_raw_fd()),
            _ => None,
        };
        match AgentHandoffFds::dup_from(stdout.as_raw_fd(), stderr.as_raw_fd(), stdin_fd) {
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
        child_start,
        handoff_fds,
    })
}

/// Destructively kill an agent child's process group, closing the
/// identity-check-to-`kill(2)` PID-reuse window.
///
/// macOS has no atomic process reference (no pidfd), so a plain
/// verify-then-signal always leaves a window in which the target can exit and
/// its pid be recycled. The freeze protocol closes it: a process that is
/// verified-stopped cannot exit, so its pid stays allocated (and, being the
/// group leader, keeps its pgid allocated) between the post-stop verification
/// and the kill. If the freeze cannot be established the pid is NOT signaled —
/// fail closed — because an unowned pid offers no other way to pin identity.
pub fn kill_agent_group_verified(
    pid: u32,
    child_start: Option<crate::proc_info::StartTime>,
) -> std::io::Result<()> {
    let refuse = |reason: String| std::io::Error::new(std::io::ErrorKind::NotFound, reason);
    let Some(pid) = crate::pty::validated_child_pid(pid) else {
        return Err(refuse(format!(
            "agent pid {pid} is out of range; refusing to signal"
        )));
    };
    let Some(start) = child_start else {
        return Err(refuse(format!(
            "agent pid {pid} has no start-time identity; refusing to signal"
        )));
    };
    let target = crate::proc_info::SessionTarget { pid, start };
    if !crate::proc_info::stop_verified(target) {
        return Err(refuse(format!(
            "agent pid {pid} could not be frozen under a verified identity; refusing to signal"
        )));
    }
    // The leader is frozen, so nothing under it can fork or reparent away.
    // Tear down the whole DESCENDANT TREE before releasing the leader: an
    // agent CLI spawns helpers, and a helper that called setsid() has left the
    // leader's process group, so `kill(-pid)` alone would leave it running —
    // holding the child's pipes open (blocking reader EOF) and any pty or
    // other descriptor it inherited. The parent-chain walk finds it; each
    // target is frozen and identity-verified before being signalled.
    //
    // Agents have no controlling terminal of their own, so there is no tty
    // device to sweep — the parent chain is the whole boundary here.
    let descendants = crate::proc_info::freeze_session_processes(Some(target), None);
    let group = unsafe { libc::kill(-pid, libc::SIGKILL) };
    let direct_needed = group != 0;
    for descendant in descendants {
        crate::proc_info::signal_verified(descendant, libc::SIGKILL);
    }
    if direct_needed {
        let direct = unsafe { libc::kill(pid, libc::SIGKILL) };
        if direct != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Signal the agent child's process group, but only when the pid can still
/// be proven to be the recorded child: the raw value must be a valid pid
/// (never 0/1 or a value whose negation becomes a broadcast target) and the
/// live process must match the recorded start-time identity. Legacy or
/// unprovable identities are never signaled.
pub fn signal_agent_pid(
    pid: u32,
    child_start: Option<crate::proc_info::StartTime>,
    owned: bool,
    signal: i32,
) -> std::io::Result<()> {
    let refuse = |reason: String| std::io::Error::new(std::io::ErrorKind::NotFound, reason);
    let Some(pid) = crate::pty::validated_child_pid(pid) else {
        return Err(refuse(format!(
            "agent pid {pid} is out of range; refusing to signal"
        )));
    };
    // Fail closed without an owned child handle. `identity_matches` below is a
    // point-in-time check; nothing pins that identity across the following
    // `kill(-pid)`, so an adopted child could exit in the window and its pid
    // (and pgid) be recycled onto an unrelated process group. Only our own
    // unreaped fork is immune, because its pid cannot be recycled until reaped.
    // Destructive teardown does not need this restriction: it freezes the
    // target first (see `kill_agent_group_verified`).
    if !owned {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "agent child {pid} has no owned handle, so its identity cannot be pinned across                  signal delivery; refusing to signal (teardown remains available)"
            ),
        ));
    }
    let Some(start) = child_start else {
        return Err(refuse(format!(
            "agent pid {pid} has no start-time identity; refusing to signal"
        )));
    };
    if !crate::proc_info::identity_matches(pid, start) {
        return Err(refuse(format!(
            "agent pid {pid} no longer matches its recorded identity; refusing to signal"
        )));
    }
    let ret = unsafe { libc::kill(-pid, signal) };
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

    #[test]
    fn signal_agent_pid_refuses_invalid_and_unproven_targets() {
        // Out-of-range raw pids: 0 and 1 become own-group / broadcast kill
        // targets after negation; > i32::MAX wraps negative.
        for raw in [0u32, 1, i32::MAX as u32 + 1, u32::MAX] {
            assert!(
                signal_agent_pid(raw, Some((1, 1)), true, libc::SIGTERM).is_err(),
                "raw pid {raw} must be refused"
            );
        }

        let mut victim = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("victim spawn should succeed");
        // No identity (legacy handoff) — never signalable.
        assert!(signal_agent_pid(victim.id(), None, true, libc::SIGKILL).is_err());
        // Mismatched identity (recycled pid) — never signalable.
        #[cfg(target_os = "macos")]
        {
            let live = crate::proc_info::process_info(victim.id() as libc::pid_t)
                .expect("victim info should resolve");
            assert!(signal_agent_pid(
                victim.id(),
                Some((live.start.0.wrapping_add(1), live.start.1)),
                true,
                libc::SIGKILL
            )
            .is_err());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            victim
                .try_wait()
                .expect("victim wait should succeed")
                .is_none(),
            "victim must survive unproven signals"
        );
        victim.kill().expect("victim cleanup kill");
        victim.wait().expect("victim cleanup wait");
    }

    /// Fault coverage for the final identity-check-to-`kill(2)` window: with
    /// the target changing inside the verify→stop window, the destructive
    /// group kill must fail closed rather than signal a possibly-recycled pid.
    #[cfg(target_os = "macos")]
    #[test]
    fn verified_group_kill_fails_closed_in_the_check_to_signal_window() {
        use std::sync::atomic::Ordering;

        let mut victim = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("victim spawn");
        let pid = victim.id() as libc::pid_t;
        let start = crate::proc_info::process_info(pid).map(|info| info.start);

        crate::proc_info::TEST_KILL_AFTER_STOP_PREVERIFY.store(pid, Ordering::Relaxed);
        let result = kill_agent_group_verified(victim.id(), start);
        crate::proc_info::TEST_KILL_AFTER_STOP_PREVERIFY.store(0, Ordering::Relaxed);
        assert!(
            result.is_err(),
            "a target that changed inside the check-to-signal window must not be signaled"
        );
        let _ = victim.wait();

        // An unowned pid with no provable identity is refused outright.
        assert!(kill_agent_group_verified(pid as u32, None).is_err());
    }

    /// Legacy journals with DUPLICATE seq values (written before one shared
    /// sequencer per session id existed) must be compiled into a dense unique
    /// sequence at load, on disk, before anything replays them.
    #[test]
    fn legacy_duplicate_seqs_are_migrated_densely_at_load() {
        let dir = tempdir::TempDirGuard::new("journal-migration");
        let journal_dir = AgentJournal::journal_dir(dir.path());
        std::fs::create_dir_all(&journal_dir).expect("create journal dir");
        let path = journal_dir.join("legacy.ndjson");

        // Two lives each numbering from 0 — exactly the old-format corruption.
        let lines = [
            r#"{"seq":0,"event":{"type":"user_message","text":"a"}}"#,
            r#"{"seq":1,"event":{"type":"user_message","text":"b"}}"#,
            r#"{"seq":0,"event":{"type":"user_message","text":"c"}}"#,
            r#"{"seq":1,"event":{"type":"user_message","text":"d"}}"#,
        ];
        std::fs::write(
            &path,
            format!(
                "{}
",
                lines.join(
                    "
"
                )
            ),
        )
        .expect("write legacy journal");

        let journal = AgentJournal::open(dir.path(), "legacy");
        let events = journal.events_from(0);
        assert_eq!(events.len(), 4, "every historical event must survive");
        assert_eq!(
            events.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
            "history must be renumbered densely and uniquely, order preserved"
        );
        assert_eq!(journal.next_seq(), 4);

        // The migration is durable: reopening sees the repaired sequence with
        // no second migration needed.
        let reopened = AgentJournal::open(dir.path(), "legacy");
        assert_eq!(
            reopened
                .events_from(0)
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
            "the on-disk file must have been rewritten atomically"
        );
        // No staging file is left behind.
        assert!(!journal_dir.join("legacy.ndjson.migrating").exists());
    }

    /// An already-dense journal is left completely alone (no rewrite).
    #[test]
    fn dense_journals_are_not_migrated() {
        let dir = tempdir::TempDirGuard::new("journal-nomigrate");
        let mut journal = AgentJournal::open(dir.path(), "dense");
        journal.append(AgentEvent::UserMessage {
            text: "one".to_string(),
        });
        journal.append(AgentEvent::UserMessage {
            text: "two".to_string(),
        });
        drop(journal);

        let reopened = AgentJournal::open(dir.path(), "dense");
        assert_eq!(
            reopened
                .events_from(0)
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    /// Descendant-tree teardown: an agent helper that called `setsid()` has
    /// left the leader's process group, so a bare `kill(-pid)` would leave it
    /// alive holding the child's pipes. The parent-chain walk must reach it.
    #[cfg(target_os = "macos")]
    #[test]
    fn verified_group_kill_reaches_setsid_escapee_descendants() {
        if !std::path::Path::new("/usr/bin/perl").exists() {
            eprintln!("skipping: /usr/bin/perl not available");
            return;
        }
        let dir = tempdir::TempDirGuard::new("agent-escapee");
        let pid_file = dir.path().join("escapee.pid");
        // The escapee reports its pid through a FILE, not stdout. Its stdout is
        // a pipe (block-buffered) and it immediately `exec`s, which discards
        // any buffered stdio — so a stdout handshake would never arrive and a
        // blocking read would hang the suite rather than fail.
        let script = format!(
            r#"perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "{}") or die; print $f "$$"; close $f; exec "/bin/sleep","300"' & sleep 300"#,
            pid_file.display()
        );
        let spec = SpawnSpec {
            executable: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script],
            env: Vec::new(),
            initial_stdin: None,
        };
        let mut spawned =
            spawn_agent_child(&spec, "/tmp", &HashMap::new()).expect("spawn tree parent");

        // Bounded wait for the pid file — never an unbounded blocking read.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let escapee: libc::pid_t = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "escapee should report its pid"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        };

        // Wait until it has really left the leader's process group.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match crate::proc_info::process_info(escapee) {
                Some(info) if info.pgid == escapee => break,
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "escapee {escapee} should call setsid"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        kill_agent_group_verified(spawned.pid, spawned.child_start).expect("tree kill");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if unsafe { libc::kill(escapee, 0) } != 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "setsid escapee {escapee} must die with the agent tree"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = spawned.child.wait();
        if let Some(fds) = spawned.handoff_fds.take() {
            fds.close();
        }
    }

    /// The happy path still works: a live child with a provable identity is
    /// frozen and killed.
    #[cfg(target_os = "macos")]
    #[test]
    fn verified_group_kill_terminates_a_provable_child() {
        let spec = SpawnSpec {
            executable: "/bin/sleep".to_string(),
            args: vec!["300".to_string()],
            env: Vec::new(),
            initial_stdin: None,
        };
        let mut spawned =
            spawn_agent_child(&spec, "/tmp", &HashMap::new()).expect("spawn sleep child");
        kill_agent_group_verified(spawned.pid, spawned.child_start)
            .expect("a provable child must be killable");
        let status = spawned.child.wait().expect("wait for killed child");
        assert!(!status.success());
        if let Some(fds) = spawned.handoff_fds.take() {
            fds.close();
        }
    }

    /// Fail closed for unowned children: without an owned `Child` handle
    /// nothing pins the pid across delivery, so the signal is refused rather
    /// than risking an unrelated process group after PID reuse. Destructive
    /// teardown is unaffected (it freezes first).
    #[cfg(target_os = "macos")]
    #[test]
    fn signal_agent_pid_refuses_unowned_children_even_with_matching_identity() {
        let mut victim = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("victim spawn");
        let live = crate::proc_info::process_info(victim.id() as libc::pid_t)
            .expect("victim info should resolve");

        // Identity matches exactly — the only thing missing is ownership.
        let refused = signal_agent_pid(victim.id(), Some(live.start), false, libc::SIGINT);
        assert!(
            refused.is_err(),
            "an unowned child must not be signalled even when its identity matches"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            victim
                .try_wait()
                .expect("victim wait should succeed")
                .is_none(),
            "the refused signal must not have been delivered"
        );

        victim.kill().expect("cleanup kill");
        victim.wait().expect("cleanup wait");

        // The same call with ownership proven is allowed through. This needs a
        // real agent child: `signal_agent_pid` targets the process GROUP, and
        // only `spawn_agent_child` children call setsid() and so lead their own
        // group (a plain Command::spawn child sits in the harness's group, where
        // kill(-pid) is ESRCH).
        let spec = SpawnSpec {
            executable: "/bin/sleep".to_string(),
            args: vec!["300".to_string()],
            env: Vec::new(),
            initial_stdin: None,
        };
        let mut owned_child =
            spawn_agent_child(&spec, "/tmp", &HashMap::new()).expect("spawn agent child");
        assert!(
            signal_agent_pid(
                owned_child.pid,
                owned_child.child_start,
                true,
                libc::SIGTERM
            )
            .is_ok(),
            "an owned child with a matching identity is signalable"
        );
        let _ = owned_child.child.wait();
        if let Some(fds) = owned_child.handoff_fds.take() {
            fds.close();
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn signal_agent_pid_kills_verified_child_group() {
        let spec = SpawnSpec {
            executable: "/bin/sleep".to_string(),
            args: vec!["300".to_string()],
            env: Vec::new(),
            initial_stdin: None,
        };
        let mut spawned =
            spawn_agent_child(&spec, "/tmp", &HashMap::new()).expect("spawn sleep child");
        assert!(
            spawned.child_start.is_some(),
            "spawn must capture the child identity"
        );

        signal_agent_pid(spawned.pid, spawned.child_start, true, libc::SIGKILL)
            .expect("verified identity must be signalable");
        let status = spawned.child.wait().expect("wait for killed child");
        assert!(!status.success(), "child should have been killed");
        if let Some(fds) = spawned.handoff_fds {
            fds.close();
        }
    }

    /// Count how many of this process's fds refer to the given file, so
    /// leak assertions survive fd-number reuse by parallel tests.
    fn fd_refs_to(dev: libc::dev_t, ino: libc::ino_t) -> usize {
        std::fs::read_dir("/dev/fd")
            .expect("read /dev/fd")
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .filter(|&fd| {
                let mut st: libc::stat = unsafe { std::mem::zeroed() };
                let ok = unsafe { libc::fstat(fd, &mut st) } == 0;
                ok && st.st_dev == dev && st.st_ino == ino
            })
            .count()
    }

    #[test]
    fn dup_from_never_leaks_partial_bundles() {
        let mut pipe_fds = [0 as std::os::unix::io::RawFd; 2];
        assert_eq!(unsafe { libc::pipe(pipe_fds.as_mut_ptr()) }, 0);
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::fstat(pipe_read, &mut st) }, 0);
        let baseline = fd_refs_to(st.st_dev, st.st_ino);

        // stdout dup succeeds, then the invalid stderr source fails: the
        // stdout duplicate must be rolled back, not leaked.
        assert!(AgentHandoffFds::dup_from(pipe_read, -1, None).is_err());
        assert_eq!(
            fd_refs_to(st.st_dev, st.st_ino),
            baseline,
            "failed bundle must not leak the stdout duplicate"
        );

        // Same for a failing optional stdin source (both prior dups rolled
        // back). The read end stands in for both pipe sources so every
        // duplicate is visible against one file identity.
        assert!(AgentHandoffFds::dup_from(pipe_read, pipe_read, Some(-1)).is_err());
        assert_eq!(
            fd_refs_to(st.st_dev, st.st_ino),
            baseline,
            "failed bundle must not leak stdout/stderr duplicates"
        );

        // Success duplicates exactly the requested ends and close() releases them.
        let bundle = AgentHandoffFds::dup_from(pipe_read, pipe_read, None)
            .expect("bundle dup should succeed");
        assert_eq!(fd_refs_to(st.st_dev, st.st_ino), baseline + 2);
        bundle.close();
        assert_eq!(fd_refs_to(st.st_dev, st.st_ino), baseline);

        unsafe {
            libc::close(pipe_read);
            libc::close(pipe_write);
        }
    }

    /// Exit-between-metadata-and-fd-send: the handoff sender duplicates the
    /// bundle into owned descriptors, so a child exiting (and its record
    /// closing the originals) between the snapshot and sendmsg can never
    /// invalidate — or worse, redirect via fd-number reuse — the transfer.
    #[test]
    fn duplicated_owned_bundle_survives_record_cleanup() {
        let mut pipe_fds = [0 as std::os::unix::io::RawFd; 2];
        assert_eq!(unsafe { libc::pipe(pipe_fds.as_mut_ptr()) }, 0);
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::fstat(pipe_read, &mut st) }, 0);
        let baseline = fd_refs_to(st.st_dev, st.st_ino);

        let bundle =
            AgentHandoffFds::dup_from(pipe_read, pipe_read, None).expect("bundle dup succeeds");
        let owned = bundle.duplicate_owned().expect("owned dup succeeds");
        assert_eq!(owned.len(), 2);
        assert_eq!(fd_refs_to(st.st_dev, st.st_ino), baseline + 4);

        // Simulate the child exiting and its record closing the originals.
        bundle.close();
        assert_eq!(
            fd_refs_to(st.st_dev, st.st_ino),
            baseline + 2,
            "owned duplicates must survive the record's own cleanup"
        );
        for fd in &owned {
            use std::os::unix::io::AsRawFd;
            assert!(
                (unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) }) >= 0,
                "owned duplicate must stay valid until the sender drops it"
            );
        }
        drop(owned);
        assert_eq!(fd_refs_to(st.st_dev, st.st_ino), baseline);

        unsafe {
            libc::close(pipe_read);
            libc::close(pipe_write);
        }
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
