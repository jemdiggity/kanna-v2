//! Headless agent sessions.
//!
//! An agent session runs a provider CLI (Claude, Codex) headless on plain
//! pipes instead of a PTY. Each stdout line is translated by the provider
//! adapter (crates/kanna-agent-protocol) into neutral [`AgentEvent`]s and
//! appended to a per-session, seq-numbered journal — the agent-session analog
//! of the headless terminal: authoritative while detached, snapshot + live
//! stream on attach, persisted to disk so it survives daemon handoff.

use std::collections::{HashMap, HashSet, VecDeque};
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

/// Fill `buf` from the operating system's random source.
///
/// `/dev/urandom` is available on every Unix target Kanna supports, including
/// macOS release hosts and Linux CI, without adding a dynamic dependency.
fn fill_random(buf: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read as _;
    std::fs::File::open("/dev/urandom")?.read_exact(buf)
}

/// Registry of agent sessions, separate from the PTY `SessionManager`.
pub type AgentSessions = Arc<Mutex<AgentRegistry>>;

#[derive(Default)]
pub struct AgentRegistry {
    sessions: HashMap<String, AgentSessionRecord>,
    teardown_tombstones: HashSet<String>,
}

impl AgentRegistry {
    pub fn can_create(&self, session_id: &str) -> bool {
        !self.sessions.contains_key(session_id) && !self.teardown_tombstones.contains(session_id)
    }

    pub fn begin_teardown(&mut self, session_id: &str) -> bool {
        self.teardown_tombstones.insert(session_id.to_string())
    }

    pub fn end_teardown(&mut self, session_id: &str) {
        self.teardown_tombstones.remove(session_id);
    }

    pub fn is_tearing_down(&self, session_id: &str) -> bool {
        self.teardown_tombstones.contains(session_id)
    }
}

impl std::ops::Deref for AgentRegistry {
    type Target = HashMap<String, AgentSessionRecord>;

    fn deref(&self) -> &Self::Target {
        &self.sessions
    }
}

impl std::ops::DerefMut for AgentRegistry {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.sessions
    }
}

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
        effort: params.effort.clone(),
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

#[derive(Debug)]
struct RetryBudget {
    attempts: u32,
    next_attempt_at: Option<std::time::Instant>,
}

impl RetryBudget {
    const BASE: std::time::Duration = std::time::Duration::from_millis(200);
    const MAX: std::time::Duration = std::time::Duration::from_secs(30);

    fn new() -> Self {
        Self {
            attempts: 0,
            next_attempt_at: None,
        }
    }

    fn due(&self) -> bool {
        self.next_attempt_at
            .is_none_or(|at| std::time::Instant::now() >= at)
    }

    fn record_failure(&mut self) {
        self.attempts = self.attempts.saturating_add(1);
        let backoff = Self::BASE
            .saturating_mul(1u32 << self.attempts.min(8))
            .min(Self::MAX);
        self.next_attempt_at = Some(std::time::Instant::now() + backoff);
    }

    fn record_success(&mut self) {
        self.attempts = 0;
        self.next_attempt_at = None;
    }
}

/// Append-only event journal: in memory plus an NDJSON file under
/// `<daemon-data>/agent-journals/{session_id}.ndjson`. Each line is a
/// [`SeqAgentEvent`]; the file is reloaded on daemon restart/handoff.
///
/// Path-based I/O is re-resolved by the kernel on every call, so anything that
/// can create a symlink in (or in place of) the journal directory between two
/// calls redirects the write. Two distinct exposures existed:
///
///   * the DIRECTORY: `agent-journals` itself replaced by a symlink, which
///     `create_dir_all` happily accepts because the target exists as a
///     directory; and
///   * the LEAF: `<session>.ndjson` or `<session>.meta.json` replaced by a
///     symlink, which plain `OpenOptions::open` follows.
///
/// `O_DIRECTORY | O_NOFOLLOW` on the directory refuses the first, and every leaf
/// is opened `O_NOFOLLOW` relative to that descriptor and confirmed to be a
/// regular file, which refuses the second. The descriptor also pins the
/// directory we validated: later operations cannot be redirected by a rename of
/// a path component.
struct JournalDir {
    fd: std::os::unix::io::OwnedFd,
}

// Test-only: force the directory fsync to fail, so the durability-propagation
// path can be exercised. A directory fsync does not fail on a healthy
// filesystem, so this is the only practical way to cover it.
#[cfg(test)]
thread_local! {
    static TEST_FAIL_DIR_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl JournalDir {
    /// Create the journal directory if needed, then open it in a way that
    /// refuses a symlink standing in for it.
    fn open(path: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&path)?;
        let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has NUL"))?;
        // O_NOFOLLOW makes this fail with ELOOP when the final component is a
        // symlink, even one pointing at a real directory.
        let raw = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            fd: unsafe { std::os::unix::io::FromRawFd::from_raw_fd(raw) },
        })
    }

    fn raw(&self) -> std::os::unix::io::RawFd {
        std::os::unix::io::AsRawFd::as_raw_fd(&self.fd)
    }

    /// `openat` relative to this directory, refusing symlinks and anything that
    /// is not a regular file.
    ///
    /// `O_NONBLOCK` is used for the open itself so that a FIFO planted at the
    /// name cannot block the daemon in `open`; it is cleared once the descriptor
    /// is confirmed regular. `O_NOFOLLOW` alone would not cover that case.
    fn open_file(&self, name: &str, flags: libc::c_int) -> std::io::Result<std::fs::File> {
        let c_name = std::ffi::CString::new(name)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "name has NUL"))?;
        let raw = unsafe {
            libc::openat(
                self.raw(),
                c_name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600 as libc::c_uint,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let file: std::fs::File = unsafe { std::os::unix::io::FromRawFd::from_raw_fd(raw) };

        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(raw, &mut stat) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{name:?} in the journal directory is not a regular file"),
            ));
        }

        // Clear O_NONBLOCK now that the target is known to be a regular file;
        // leaving it set would change read/write semantics.
        let current = unsafe { libc::fcntl(raw, libc::F_GETFL) };
        if current < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(raw, libc::F_SETFL, current & !libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(file)
    }

    fn read(&self, name: &str) -> std::io::Result<Vec<u8>> {
        use std::io::Read as _;
        let mut file = self.open_file(name, libc::O_RDONLY)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    fn rename(&self, from: &str, to: &str) -> std::io::Result<()> {
        let from_c = std::ffi::CString::new(from)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "name has NUL"))?;
        let to_c = std::ffi::CString::new(to)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "name has NUL"))?;
        let ret = unsafe { libc::renameat(self.raw(), from_c.as_ptr(), self.raw(), to_c.as_ptr()) };
        if ret < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// `unlinkat` relative to this directory.
    ///
    /// Returns the error so callers that are deleting a session's real files can
    /// report a genuine failure; staging cleanup discards it.
    fn unlink(&self, name: &str) -> std::io::Result<()> {
        let c_name = std::ffi::CString::new(name)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "name has NUL"))?;
        if unsafe { libc::unlinkat(self.raw(), c_name.as_ptr(), 0) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// fsync the DIRECTORY, so a rename into it survives a crash.
    fn sync(&self) -> std::io::Result<()> {
        // Thread-local, like the other fault injections in this crate: a
        // process-global flag made an unrelated parallel test's write fail.
        #[cfg(test)]
        if TEST_FAIL_DIR_SYNC.with(|slot| slot.get()) {
            return Err(std::io::Error::from_raw_os_error(libc::EIO));
        }
        if unsafe { libc::fsync(self.raw()) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

pub struct AgentJournal {
    /// `None` when the journal directory could not be opened safely.
    dir: Option<JournalDir>,
    /// File NAMES within `dir`. All I/O uses these with `*at` calls; the `PathBuf`s
    /// below exist only for log messages.
    file_name: String,
    metadata_name: String,
    path: PathBuf,
    metadata_path: PathBuf,
    file: Option<std::fs::File>,
    events: Vec<SeqAgentEvent>,
    provider_session_id: Option<String>,
    pending_provider_session_id: Option<String>,
    /// Disk persistence failed at least once (already reported).
    degraded: bool,
    repair_needed: bool,
    repair_retry: RetryBudget,
    metadata_retry: RetryBudget,
    #[cfg(test)]
    metadata_publish_attempts: u32,
    #[cfg(test)]
    history_rewrite_attempts: u32,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct AgentJournalMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_session_id: Option<String>,
}

impl AgentJournal {
    /// A journal that keeps events in memory and never touches disk.
    ///
    /// Used when the journal directory cannot be opened safely. The paths and
    /// leaf names are empty because nothing must ever open them.
    fn memory_only() -> Self {
        Self {
            dir: None,
            file_name: String::new(),
            metadata_name: String::new(),
            path: PathBuf::new(),
            metadata_path: PathBuf::new(),
            file: None,
            events: Vec::new(),
            provider_session_id: None,
            pending_provider_session_id: None,
            degraded: true,
            repair_needed: false,
            repair_retry: RetryBudget::new(),
            metadata_retry: RetryBudget::new(),
            #[cfg(test)]
            metadata_publish_attempts: 0,
            #[cfg(test)]
            history_rewrite_attempts: 0,
        }
    }

    pub fn journal_dir(data_dir: &Path) -> PathBuf {
        data_dir.join("agent-journals")
    }

    /// Open (or create) the journal for a session, loading existing events.
    pub fn open(data_dir: &Path, session_id: &str) -> Self {
        // Protocol callers reject invalid ids before spawning or registering
        // sessions. This check is the backstop at the point where journal paths
        // are derived, so a future missed boundary cannot write outside the
        // journal directory or alias another session's files.
        if !crate::session_id::is_safe(session_id) {
            log::error!(
                "[agent] refusing to derive journal names from unsafe session id \
                 {session_id:?}; running memory-only"
            );
            return Self::memory_only();
        }

        let dir_path = Self::journal_dir(data_dir);
        let file_name = format!("{session_id}.ndjson");
        let metadata_name = format!("{session_id}.meta.json");
        let path = dir_path.join(&file_name);
        let metadata_path = dir_path.join(&metadata_name);

        // Open the directory ONCE, refusing a symlink in its place, and perform
        // every later operation relative to this descriptor.
        let dir = match JournalDir::open(dir_path) {
            Ok(dir) => dir,
            Err(error) => {
                log::error!(
                    "[agent] refusing to use journal directory for {path:?}: {error}; \
                     running memory-only"
                );
                return Self::memory_only();
            }
        };

        let mut events = Vec::new();
        if let Ok(content) = dir
            .read(&file_name)
            .and_then(|bytes| String::from_utf8(bytes).map_err(std::io::Error::other))
        {
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

        let provider_session_id = dir
            .read(&metadata_name)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|content| serde_json::from_str::<AgentJournalMetadata>(&content).ok())
            .and_then(|metadata| metadata.provider_session_id);

        // Legacy journals can contain DUPLICATE seq values: before one shared
        // sequencer per session id existed, two `AgentJournal` handles over
        // this one file each allocated seq from their own in-memory vec. Those
        // duplicates are already on disk, and `append`/`next_seq` assume
        // seq == index, so replay and resume would misbehave. Compile the
        // history into a dense, unique sequence at load, once, atomically.
        let mut migration_unconfirmed = false;
        if Self::needs_seq_migration(&events) {
            let repaired: Vec<SeqAgentEvent> = events
                .into_iter()
                .enumerate()
                .map(|(index, entry)| SeqAgentEvent {
                    seq: index as u64,
                    event: entry.event,
                })
                .collect();
            match Self::rewrite_atomically(&dir, &file_name, &repaired) {
                Ok(()) => log::info!(
                    "[agent] migrated {} journal entries in {:?} to a dense unique sequence",
                    repaired.len(),
                    path
                ),
                Err(error) => {
                    migration_unconfirmed = true;
                    log::error!(
                        "[agent] failed to migrate duplicate seqs in {:?}: {}                      (continuing with the repaired in-memory history)",
                        path,
                        error
                    );
                }
            }
            events = repaired;
        }

        let file = if migration_unconfirmed {
            None
        } else {
            dir.open_file(&file_name, libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT)
                .map_err(|error| {
                    log::error!(
                        "[agent] journal disk persistence unavailable for {path:?}: {error}"
                    );
                    error
                })
                .ok()
        };
        let degraded = file.is_none();

        Self {
            dir: Some(dir),
            file_name,
            metadata_name,
            path,
            metadata_path,
            file,
            events,
            provider_session_id,
            pending_provider_session_id: None,
            degraded,
            repair_needed: migration_unconfirmed,
            repair_retry: RetryBudget::new(),
            metadata_retry: RetryBudget::new(),
            #[cfg(test)]
            metadata_publish_attempts: 0,
            #[cfg(test)]
            history_rewrite_attempts: 0,
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
        dir: &JournalDir,
        name: &str,
        events: &[SeqAgentEvent],
    ) -> std::io::Result<()> {
        let mut body = Vec::new();
        for entry in events {
            let line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
            body.extend_from_slice(line.as_bytes());
            body.push(b'\n');
        }
        Self::replace_durably(dir, name, &body)
    }

    /// Write `contents` to `name` within `dir` atomically and durably.
    ///
    /// Every step is relative to the directory descriptor, so no part of this
    /// re-resolves a path that could have been swapped for a symlink since the
    /// directory was validated. Three things matter here beyond that:
    ///
    ///   * the staging file is created `O_CREAT | O_EXCL`, which refuses an existing
    ///     path — symlink included — so nothing pre-planted at the name can capture
    ///     the write. `File::create` on the old fixed `<session>.ndjson.migrating`
    ///     followed such a symlink. The name is also unpredictable, which is a
    ///     separate benefit: a pre-planted REGULAR file cannot wedge the rewrite
    ///     forever, as it would with a fixed name;
    ///   * the directory is fsynced after the rename, or the rename itself can be
    ///     lost on a crash even though the file contents were synced; and
    ///   * that fsync's failure is PROPAGATED, because reporting a durable write
    ///     that is not durable lets the caller clear retry state it still needs.
    fn replace_durably(dir: &JournalDir, name: &str, contents: &[u8]) -> std::io::Result<()> {
        Self::replace_durably_with_nonce_source(dir, name, contents, || {
            let mut nonce = [0u8; 12];
            fill_random(&mut nonce)?;
            Ok(nonce)
        })
    }

    fn replace_durably_with_nonce_source(
        dir: &JournalDir,
        name: &str,
        contents: &[u8],
        mut next_nonce: impl FnMut() -> std::io::Result<[u8; 12]>,
    ) -> std::io::Result<()> {
        let mut attempt = 0;
        let (staging, mut file) = loop {
            let nonce = next_nonce()?;
            let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
            let candidate = format!("{name}.tmp.{suffix}");
            match dir.open_file(&candidate, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL) {
                Ok(file) => break (candidate, file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => {
                    attempt += 1;
                }
                Err(error) => return Err(error),
            }
        };

        let staged = file.write_all(contents).and_then(|_| file.sync_all());
        drop(file);
        if let Err(error) = staged {
            let _ = dir.unlink(&staging);
            return Err(error);
        }
        if let Err(error) = dir.rename(&staging, name) {
            let _ = dir.unlink(&staging);
            return Err(error);
        }
        dir.sync()
    }

    /// Append an event; returns its seq. Disk failures degrade to
    /// memory-only (reported once via log + a Diagnostic event from the
    /// caller), never lose the in-memory event.
    pub fn append(&mut self, event: AgentEvent) -> SeqAgentEvent {
        let repair_due = self.repair_needed && self.repair_retry.due();
        let metadata_due = self.pending_provider_session_id.is_some() && self.metadata_retry.due();
        if repair_due || metadata_due {
            self.retry_pending_durable_work(repair_due, metadata_due);
        }

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
                self.repair_needed = true;
                self.repair_retry.record_failure();
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

    #[cfg(test)]
    fn repair_needed_for_test(&self) -> bool {
        self.repair_needed
    }

    #[cfg(test)]
    fn pending_provider_session_id_for_test(&self) -> bool {
        self.pending_provider_session_id.is_some()
    }

    #[cfg(test)]
    fn metadata_attempts_for_test(&self) -> u32 {
        self.metadata_publish_attempts
    }

    #[cfg(test)]
    fn history_rewrite_attempts_for_test(&self) -> u32 {
        self.history_rewrite_attempts
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

        let repeats_pending =
            self.pending_provider_session_id.as_deref() == Some(provider_session_id);
        if repeats_pending {
            if !self.metadata_retry.due() {
                return;
            }
        } else {
            self.metadata_retry.record_success();
        }

        if self.publish_provider_session_id(provider_session_id) {
            self.provider_session_id = Some(provider_session_id.to_string());
            self.pending_provider_session_id = None;
            self.metadata_retry.record_success();
        } else {
            self.pending_provider_session_id = Some(provider_session_id.to_string());
            self.metadata_retry.record_failure();
        }
    }

    fn publish_provider_session_id(&mut self, provider_session_id: &str) -> bool {
        #[cfg(test)]
        {
            self.metadata_publish_attempts += 1;
        }

        let metadata = AgentJournalMetadata {
            provider_session_id: Some(provider_session_id.to_string()),
        };
        // Atomic, not `fs::write`. A plain write TRUNCATES first, so a crash
        // mid-write leaves the metadata empty or half-written and the provider
        // session id is gone — which silently costs the session its `--resume`
        // capability. Staged under an unpredictable name, fsynced, renamed, and the
        // directory fsynced so the rename survives a crash too.
        let write_result = match self.dir.as_ref() {
            Some(dir) => serde_json::to_string(&metadata)
                .map_err(std::io::Error::other)
                .and_then(|json| Self::replace_durably(dir, &self.metadata_name, json.as_bytes())),
            None => Err(std::io::Error::other(
                "journal directory is unavailable for durable metadata",
            )),
        };
        if let Err(error) = write_result {
            log::warn!(
                "[agent] failed to persist provider session id to {:?}: {}",
                self.metadata_path,
                error
            );
            return false;
        }
        true
    }

    fn retry_pending_durable_work(&mut self, repair_due: bool, metadata_due: bool) {
        if metadata_due {
            if let Some(pending) = self.pending_provider_session_id.clone() {
                if self.publish_provider_session_id(&pending) {
                    self.provider_session_id = Some(pending);
                    self.pending_provider_session_id = None;
                    self.metadata_retry.record_success();
                } else {
                    self.metadata_retry.record_failure();
                }
            }
        }

        if repair_due {
            #[cfg(test)]
            {
                self.history_rewrite_attempts += 1;
            }
            let Some(dir) = self.dir.as_ref() else {
                self.repair_retry.record_failure();
                return;
            };
            match Self::rewrite_atomically(dir, &self.file_name, &self.events) {
                Ok(()) => match dir.open_file(
                    &self.file_name,
                    libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT,
                ) {
                    Ok(file) => {
                        self.file = Some(file);
                        self.repair_needed = false;
                        self.degraded = false;
                        self.repair_retry.record_success();
                    }
                    Err(error) => {
                        log::debug!(
                            "[agent] rewrote {:?} but could not reopen it: {}",
                            self.path,
                            error
                        );
                        self.repair_retry.record_failure();
                    }
                },
                Err(error) => {
                    log::debug!(
                        "[agent] deferred journal repair for {:?} still failing: {}",
                        self.path,
                        error
                    );
                    self.repair_retry.record_failure();
                }
            }
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

    /// Delete this session's history and metadata.
    ///
    /// Both removals go through the PINNED directory descriptor. Path-based
    /// `remove_file` re-resolves `agent-journals` on every call, so a directory
    /// swapped for a symlink between open and deletion made this unlink two files
    /// of the attacker's choosing anywhere on the filesystem.
    pub fn remove_file(&mut self) {
        self.file = None;
        let Some(dir) = self.dir.as_ref() else {
            // Memory-only: no path was ever derived, so there is nothing on disk.
            return;
        };
        for (name, path) in [
            (&self.file_name, &self.path),
            (&self.metadata_name, &self.metadata_path),
        ] {
            match dir.unlink(name) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log::warn!("[agent] failed to remove {path:?}: {error}"),
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

const EXIT_UNPUBLISHED: u8 = 0;
const EXIT_PUBLISHING: u8 = 1;
const EXIT_PUBLISHED: u8 = 2;

struct ExitPublicationInner {
    state: std::sync::atomic::AtomicU8,
    published: tokio::sync::Notify,
}

/// Single-owner terminal Exit publication state for one incarnation.
///
/// Claiming and completion are distinct: publication becomes complete only
/// after the terminal journal entry, fan-out, and Exit broadcast finish.
#[derive(Clone)]
pub struct ExitPublication {
    inner: Arc<ExitPublicationInner>,
}

impl ExitPublication {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ExitPublicationInner {
                state: std::sync::atomic::AtomicU8::new(EXIT_UNPUBLISHED),
                published: tokio::sync::Notify::new(),
            }),
        }
    }

    pub fn try_claim(&self) -> bool {
        self.inner
            .state
            .compare_exchange(
                EXIT_UNPUBLISHED,
                EXIT_PUBLISHING,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn is_published(&self) -> bool {
        self.inner.state.load(std::sync::atomic::Ordering::Acquire) == EXIT_PUBLISHED
    }

    pub fn complete(&self) {
        self.inner
            .state
            .store(EXIT_PUBLISHED, std::sync::atomic::Ordering::Release);
        self.inner.published.notify_waiters();
    }

    pub async fn wait_until_published(&self) {
        loop {
            let notified = self.inner.published.notified();
            if self.is_published() {
                return;
            }
            notified.await;
        }
    }
}

impl Default for ExitPublication {
    fn default() -> Self {
        Self::new()
    }
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
    pub exit_publication: ExitPublication,
    /// Set when the user asks to stop the agent. The child's resulting exit is
    /// then surfaced as an interruption rather than a crash.
    pub interrupt_requested: bool,
    pub turn_model: TurnModel,
    pub created_at: std::time::Instant,
    pub last_activity_at: std::time::Instant,
    /// Dup'd pipe fds reserved for handoff; closed when the child exits.
    pub handoff_fds: Option<AgentHandoffFds>,
}

/// Draw a process-global, never-reused incarnation token. Exhaustion is a
/// fatal invariant violation rather than wrapping into an old token.
pub fn next_agent_incarnation() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_update(
        std::sync::atomic::Ordering::Relaxed,
        std::sync::atomic::Ordering::Relaxed,
        |current| current.checked_add(1),
    )
    .expect("agent incarnation space exhausted")
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
#[derive(Debug, Clone, Copy)]
struct AgentKillPlan {
    pid: libc::pid_t,
    target: crate::proc_info::SessionTarget,
}

impl AgentKillPlan {
    fn prepare(
        raw_pid: u32,
        child_start: Option<crate::proc_info::StartTime>,
    ) -> std::io::Result<Self> {
        let refuse = |reason: String| std::io::Error::new(std::io::ErrorKind::NotFound, reason);
        let Some(pid) = crate::pty::validated_child_pid(raw_pid) else {
            return Err(refuse(format!(
                "agent pid {raw_pid} is out of range; refusing to signal"
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
        // Freeze the whole process group while the shared parent-chain
        // snapshot is taken so no descendant can fork or reparent away.
        unsafe {
            libc::kill(-pid, libc::SIGSTOP);
        }
        Ok(Self { pid, target })
    }

    fn strike(self, descendants: Vec<crate::proc_info::SessionTarget>) -> std::io::Result<()> {
        let group = unsafe { libc::kill(-self.pid, libc::SIGKILL) };
        let direct_needed = group != 0;
        for descendant in descendants {
            crate::proc_info::signal_verified(descendant, libc::SIGKILL);
        }
        if direct_needed {
            let direct = unsafe { libc::kill(self.pid, libc::SIGKILL) };
            if direct != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

/// Kill multiple verified agent groups while sharing each process-table
/// discovery round across the batch. Invalid or stale requests fail
/// independently and results preserve input order.
pub fn kill_agent_groups_verified(
    requests: &[(u32, Option<crate::proc_info::StartTime>)],
) -> Vec<std::io::Result<()>> {
    let prepared: Vec<_> = requests
        .iter()
        .map(|(pid, start)| AgentKillPlan::prepare(*pid, *start))
        .collect();
    let specs: Vec<_> = prepared
        .iter()
        .filter_map(|result| result.as_ref().ok())
        .map(|plan| (Some(plan.target), None))
        .collect();
    let mut frozen = crate::proc_info::freeze_many(&specs).into_iter();

    prepared
        .into_iter()
        .map(|result| match result {
            Ok(plan) => plan.strike(frozen.next().unwrap_or_default()),
            Err(error) => Err(error),
        })
        .collect()
}

pub fn kill_agent_group_verified(
    pid: u32,
    child_start: Option<crate::proc_info::StartTime>,
) -> std::io::Result<()> {
    kill_agent_groups_verified(&[(pid, child_start)])
        .into_iter()
        .next()
        .unwrap_or_else(|| {
            Err(std::io::Error::other(
                "agent kill batch returned no result for one request",
            ))
        })
}

struct AgentTeardownRequest {
    pid: u32,
    child_start: Option<crate::proc_info::StartTime>,
    completion: tokio::sync::oneshot::Sender<std::io::Result<()>>,
}

#[derive(Default)]
struct AgentTeardownState {
    pending: VecDeque<AgentTeardownRequest>,
    scheduled: bool,
}

#[derive(Default)]
struct AgentTeardownBatcher {
    state: std::sync::Mutex<AgentTeardownState>,
    requests: std::sync::atomic::AtomicU64,
    batches: std::sync::atomic::AtomicU64,
    lifecycle_jobs: std::sync::atomic::AtomicU64,
}

fn agent_teardown_batcher() -> &'static AgentTeardownBatcher {
    static BATCHER: std::sync::OnceLock<AgentTeardownBatcher> = std::sync::OnceLock::new();
    BATCHER.get_or_init(AgentTeardownBatcher::default)
}

fn run_agent_teardown_batches() {
    let batcher = agent_teardown_batcher();
    // Let one concurrent close burst collect before taking the shared process
    // snapshot. This runs on the lifecycle owner, never a Tokio worker.
    std::thread::sleep(std::time::Duration::from_millis(1));

    loop {
        let batch: Vec<_> = {
            let mut state = batcher
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.pending.is_empty() {
                state.scheduled = false;
                return;
            }
            state.pending.drain(..).collect()
        };
        batcher
            .batches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let requests: Vec<_> = batch
            .iter()
            .map(|request| (request.pid, request.child_start))
            .collect();
        let mut results = kill_agent_groups_verified(&requests).into_iter();
        for request in batch {
            let result = results.next().unwrap_or_else(|| {
                Err(std::io::Error::other(
                    "agent kill batch returned fewer results than requests",
                ))
            });
            let _ = request.completion.send(result);
        }
    }
}

/// Route one verified agent teardown through the central bounded lifecycle
/// executor. Concurrent requests share one lifecycle job and process-table
/// snapshot batch; each caller still receives its own ordered result.
pub async fn kill_agent_group_batched(
    pid: u32,
    child_start: Option<crate::proc_info::StartTime>,
) -> Option<std::io::Result<()>> {
    let (completion, result) = tokio::sync::oneshot::channel();
    let batcher = agent_teardown_batcher();
    let should_schedule = {
        let mut state = batcher
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.pending.push_back(AgentTeardownRequest {
            pid,
            child_start,
            completion,
        });
        batcher
            .requests
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if state.scheduled {
            false
        } else {
            state.scheduled = true;
            true
        }
    };

    if should_schedule {
        batcher
            .lifecycle_jobs
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let job: crate::reaper::TeardownJob = Box::new(run_agent_teardown_batches);
        match crate::reaper::try_run_teardown(job) {
            crate::reaper::TeardownAdmission::Accepted => {}
            crate::reaper::TeardownAdmission::Full(job) => {
                crate::reaper::run_teardown(job).await;
            }
        }
    }

    result.await.ok()
}

/// `(requests, shared process-snapshot batches, lifecycle jobs)` since daemon
/// startup. Used for diagnostics and concurrency regression coverage.
pub fn agent_teardown_stats() -> (u64, u64, u64) {
    let batcher = agent_teardown_batcher();
    (
        batcher.requests.load(std::sync::atomic::Ordering::Relaxed),
        batcher.batches.load(std::sync::atomic::Ordering::Relaxed),
        batcher
            .lifecycle_jobs
            .load(std::sync::atomic::Ordering::Relaxed),
    )
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
    fn temp_journal_base(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kanna-jdir-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A symlink standing in for the journal DIRECTORY must not redirect a write.
    ///
    /// `create_dir_all` accepts such a symlink — its target exists as a directory —
    /// and every path-based open then followed it, so a canary outside the data
    /// directory received the journal. `O_DIRECTORY | O_NOFOLLOW` refuses it.
    #[test]
    fn a_symlinked_journal_directory_is_refused_and_the_canary_stays_empty() {
        let base = temp_journal_base("dirsymlink");
        let canary_dir = base.join("canary-target");
        std::fs::create_dir_all(&canary_dir).expect("canary dir");
        std::os::unix::fs::symlink(&canary_dir, AgentJournal::journal_dir(&base))
            .expect("plant directory symlink");

        let mut journal = AgentJournal::open(&base, "victim");
        journal.append(AgentEvent::Diagnostic {
            message: "must not be written through a symlink".to_string(),
        });
        journal.set_provider_session_id("must-not-land-either");

        assert!(
            journal.is_degraded(),
            "a symlinked journal directory must degrade to memory-only"
        );
        let leaked: Vec<_> = std::fs::read_dir(&canary_dir)
            .expect("canary readable")
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        assert!(
            leaked.is_empty(),
            "a symlinked journal directory redirected writes into {canary_dir:?}: {leaked:?}"
        );

        let _ = std::fs::remove_file(AgentJournal::journal_dir(&base));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A symlink standing in for a journal LEAF must not redirect a write either.
    #[test]
    fn a_symlinked_journal_leaf_is_refused_and_the_canary_stays_empty() {
        let base = temp_journal_base("leafsymlink");
        let journal_dir = AgentJournal::journal_dir(&base);
        std::fs::create_dir_all(&journal_dir).expect("journal dir");
        let canary = base.join("canary-file");
        std::fs::write(&canary, b"").expect("canary");

        std::os::unix::fs::symlink(&canary, journal_dir.join("victim.ndjson"))
            .expect("plant history symlink");
        let mut journal = AgentJournal::open(&base, "victim");
        journal.append(AgentEvent::Diagnostic {
            message: "must not follow the leaf symlink".to_string(),
        });
        assert_eq!(
            std::fs::read(&canary).expect("canary readable"),
            Vec::<u8>::new(),
            "a symlinked history leaf redirected the append into the canary"
        );

        std::os::unix::fs::symlink(&canary, journal_dir.join("meta.meta.json"))
            .expect("plant metadata symlink");
        let mut meta_journal = AgentJournal::open(&base, "meta");
        meta_journal.set_provider_session_id("must-not-be-written-through-a-symlink");
        assert_eq!(
            std::fs::read(&canary).expect("canary readable"),
            Vec::<u8>::new(),
            "a symlinked metadata leaf redirected the persist into the canary"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn exclusive_staging_rejects_symlink_and_regular_file_collisions_then_retries() {
        let base = temp_journal_base("staging");
        let journal_path = AgentJournal::journal_dir(&base);
        let dir = JournalDir::open(journal_path.clone()).expect("journal dir");
        let canary = base.join("staging-canary");
        std::fs::write(&canary, b"").expect("canary");

        let symlink_nonce = [0u8; 12];
        let regular_nonce = [1u8; 12];
        let usable_nonce = [2u8; 12];
        let candidate = |nonce: [u8; 12]| {
            let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
            journal_path.join(format!("dup.ndjson.tmp.{suffix}"))
        };
        std::os::unix::fs::symlink(&canary, candidate(symlink_nonce))
            .expect("plant staging symlink");
        std::fs::write(candidate(regular_nonce), b"regular collision")
            .expect("plant regular staging file");
        let mut nonces = [symlink_nonce, regular_nonce, usable_nonce].into_iter();

        AgentJournal::replace_durably_with_nonce_source(&dir, "dup.ndjson", b"replacement", || {
            nonces
                .next()
                .ok_or_else(|| std::io::Error::other("nonce sequence exhausted"))
        })
        .expect("collisions should be retried");

        assert_eq!(
            std::fs::read(&canary).expect("canary readable"),
            Vec::<u8>::new(),
            "O_CREAT | O_EXCL must refuse the pre-existing symlink"
        );
        assert_eq!(
            std::fs::read(candidate(regular_nonce)).expect("regular collision survives"),
            b"regular collision",
            "the random retry must leave a pre-existing regular file untouched"
        );
        assert_eq!(
            dir.read("dup.ndjson").expect("replacement readable"),
            b"replacement"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_fifo_journal_leaf_is_rejected_without_blocking_open() {
        let base = temp_journal_base("fifo");
        let journal_dir = AgentJournal::journal_dir(&base);
        std::fs::create_dir_all(&journal_dir).expect("journal dir");
        let fifo = journal_dir.join("victim.ndjson");
        let fifo_c =
            std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);

        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let journal = AgentJournal::open(&base, "victim");
            let _ = sender.send(journal.is_degraded());
            let _ = std::fs::remove_dir_all(&base);
        });

        assert_eq!(
            receiver.recv_timeout(std::time::Duration::from_secs(2)),
            Ok(true),
            "opening a planted FIFO must return promptly and degrade persistence"
        );
    }

    #[test]
    fn journal_io_stays_in_the_pinned_directory_after_the_path_is_replaced() {
        let base = temp_journal_base("pinned");
        let journal_path = AgentJournal::journal_dir(&base);
        let pinned_path = base.join("pinned-original");
        let canary_path = base.join("canary-target");

        let mut journal = AgentJournal::open(&base, "victim");
        journal.append(AgentEvent::Diagnostic {
            message: "before directory replacement".to_string(),
        });
        std::fs::rename(&journal_path, &pinned_path).expect("rename open journal directory");
        std::fs::create_dir_all(&canary_path).expect("canary dir");
        std::fs::write(canary_path.join("victim.ndjson"), b"history canary")
            .expect("history canary");
        std::fs::write(canary_path.join("victim.meta.json"), b"metadata canary")
            .expect("metadata canary");
        std::os::unix::fs::symlink(&canary_path, &journal_path)
            .expect("replace journal path with symlink");

        journal.append(AgentEvent::Diagnostic {
            message: "after directory replacement".to_string(),
        });
        journal.set_provider_session_id("provider-session");
        journal.remove_file();

        assert_eq!(
            std::fs::read(canary_path.join("victim.ndjson")).expect("history canary survives"),
            b"history canary"
        );
        assert_eq!(
            std::fs::read(canary_path.join("victim.meta.json")).expect("metadata canary survives"),
            b"metadata canary"
        );
        assert!(
            std::fs::read_dir(&pinned_path)
                .expect("pinned directory readable")
                .next()
                .is_none(),
            "both real journal leaves must be removed from the pinned directory"
        );

        let _ = std::fs::remove_file(&journal_path);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn durable_replace_propagates_directory_sync_failure() {
        let base = temp_journal_base("dirsync");
        let dir = JournalDir::open(AgentJournal::journal_dir(&base)).expect("journal directory");

        TEST_FAIL_DIR_SYNC.with(|slot| slot.set(true));
        let result = AgentJournal::replace_durably(&dir, "metadata.json", b"durable contents");
        TEST_FAIL_DIR_SYNC.with(|slot| slot.set(false));

        assert_eq!(
            result
                .expect_err("directory fsync failure must be returned")
                .raw_os_error(),
            Some(libc::EIO)
        );
        assert_eq!(
            dir.read("metadata.json")
                .expect("renamed file remains readable"),
            b"durable contents"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn verified_group_kill_batch_keeps_results_ordered_and_independent() {
        let spec = SpawnSpec {
            executable: "/bin/sleep".to_string(),
            args: vec!["300".to_string()],
            env: Vec::new(),
            initial_stdin: None,
        };
        let mut spawned =
            spawn_agent_child(&spec, "/tmp", &HashMap::new()).expect("spawn agent child");

        let results =
            kill_agent_groups_verified(&[(0, Some((1, 1))), (spawned.pid, spawned.child_start)]);
        assert_eq!(results.len(), 2);
        assert!(
            results[0].is_err(),
            "invalid first request must fail in place"
        );
        assert!(
            results[1].is_ok(),
            "valid second request must still execute"
        );
        assert!(
            !spawned.child.wait().expect("wait killed child").success(),
            "the valid child must be killed"
        );
        if let Some(fds) = spawned.handoff_fds.take() {
            fds.close();
        }
    }
    use std::io::Read;

    fn with_failing_dir_sync<T>(body: impl FnOnce() -> T) -> T {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                TEST_FAIL_DIR_SYNC.with(|slot| slot.set(false));
            }
        }

        TEST_FAIL_DIR_SYNC.with(|slot| slot.set(true));
        let _reset = Reset;
        body()
    }

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
        #[cfg(any(target_os = "macos", target_os = "linux"))]
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    /// Sustained disk failure must not turn each event into another full-history
    /// rewrite or provider-metadata publication attempt.
    #[test]
    fn sustained_disk_failure_does_not_retry_durable_work_per_event() {
        let dir = tempdir::TempDirGuard::new("journal-sustained");
        let journal_dir = AgentJournal::journal_dir(dir.path());
        std::fs::create_dir_all(&journal_dir).expect("journal dir");
        std::fs::write(
            journal_dir.join("busy.ndjson"),
            b"{\"seq\":0,\"event\":{\"type\":\"diagnostic\",\"message\":\"a\"}}\n\
              {\"seq\":0,\"event\":{\"type\":\"diagnostic\",\"message\":\"b\"}}\n",
        )
        .expect("seed duplicate sequence");

        with_failing_dir_sync(|| {
            let mut journal = AgentJournal::open(dir.path(), "busy");
            assert!(journal.repair_needed_for_test());
            journal.set_provider_session_id("provider-sustained");
            assert!(journal.pending_provider_session_id_for_test());

            let metadata_before = journal.metadata_attempts_for_test();
            let rewrites_before = journal.history_rewrite_attempts_for_test();
            for index in 0..500 {
                journal.append(AgentEvent::Diagnostic {
                    message: format!("event-{index}"),
                });
            }

            assert!(
                journal.metadata_attempts_for_test() - metadata_before <= 5,
                "metadata publication retried per event"
            );
            assert!(
                journal.history_rewrite_attempts_for_test() - rewrites_before <= 5,
                "full-history repair retried per event"
            );
            assert_eq!(journal.next_seq(), 502);
        });
    }

    #[test]
    fn repeated_production_style_set_and_append_honors_metadata_budget() {
        let dir = tempdir::TempDirGuard::new("journal-metadata-budget");
        let mut journal = AgentJournal::open(dir.path(), "prod");

        with_failing_dir_sync(|| {
            let before = journal.metadata_attempts_for_test();
            for index in 0..300 {
                journal.set_provider_session_id("provider-prod");
                journal.append(AgentEvent::Diagnostic {
                    message: format!("event-{index}"),
                });
            }

            assert!(
                journal.metadata_attempts_for_test() - before <= 5,
                "metadata setter bypassed its retry budget"
            );
            assert!(journal.pending_provider_session_id_for_test());
            assert_eq!(journal.provider_session_id(), None);
            assert_eq!(journal.next_seq(), 300);
        });
    }

    #[test]
    fn pending_durable_work_retries_after_its_backoff() {
        let dir = tempdir::TempDirGuard::new("journal-retry-recovery");
        let journal_dir = AgentJournal::journal_dir(dir.path());
        std::fs::create_dir_all(&journal_dir).expect("journal dir");
        std::fs::write(
            journal_dir.join("recover.ndjson"),
            b"{\"seq\":0,\"event\":{\"type\":\"diagnostic\",\"message\":\"a\"}}\n\
              {\"seq\":0,\"event\":{\"type\":\"diagnostic\",\"message\":\"b\"}}\n",
        )
        .expect("seed duplicate sequence");

        let mut journal = with_failing_dir_sync(|| {
            let mut journal = AgentJournal::open(dir.path(), "recover");
            journal.set_provider_session_id("provider-recovered");
            journal
        });
        assert!(journal.repair_needed_for_test());
        assert!(journal.pending_provider_session_id_for_test());

        std::thread::sleep(std::time::Duration::from_millis(450));
        journal.append(AgentEvent::Diagnostic {
            message: "retry trigger".to_string(),
        });

        assert!(!journal.repair_needed_for_test());
        assert!(!journal.pending_provider_session_id_for_test());
        assert_eq!(
            journal.provider_session_id().as_deref(),
            Some("provider-recovered")
        );
        assert_eq!(journal.next_seq(), 3);
    }

    #[test]
    fn a_new_provider_id_gets_a_fresh_metadata_budget() {
        let dir = tempdir::TempDirGuard::new("journal-new-provider-id");
        let mut journal = AgentJournal::open(dir.path(), "fresh");

        with_failing_dir_sync(|| {
            journal.set_provider_session_id("first-id");
        });
        assert!(journal.pending_provider_session_id_for_test());

        journal.set_provider_session_id("second-id");
        assert_eq!(journal.provider_session_id().as_deref(), Some("second-id"));
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    #[test]
    fn unsafe_session_ids_never_open_journal_files() {
        let dir = tempdir::TempDirGuard::new("agent-journal-unsafe-id");

        for session_id in ["../escape", "Agent", "caf\u{e9}"] {
            let mut journal = AgentJournal::open(dir.path(), session_id);
            assert!(
                journal.is_degraded(),
                "{session_id:?} must use a memory-only journal"
            );
            journal.append(AgentEvent::TurnStarted { model: None });
            journal.set_provider_session_id("provider-session");
        }

        assert!(!dir.path().join("escape.ndjson").exists());
        assert!(!dir.path().join("escape.meta.json").exists());
        assert!(!dir.path().join("agent-journals/Agent.ndjson").exists());
        assert!(!dir.path().join("agent-journals/Agent.meta.json").exists());
        assert!(!dir.path().join("agent-journals/caf\u{e9}.ndjson").exists());
        assert!(!dir
            .path()
            .join("agent-journals/caf\u{e9}.meta.json")
            .exists());
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

    #[test]
    fn agent_incarnations_are_never_zero_or_reused() {
        let mut seen = HashSet::new();
        for _ in 0..10_000 {
            let incarnation = next_agent_incarnation();
            assert_ne!(incarnation, 0);
            assert!(seen.insert(incarnation), "incarnation token was reused");
        }
    }

    #[tokio::test]
    async fn exit_publication_is_single_owner_and_completes_last() {
        let publication = ExitPublication::new();
        assert!(publication.try_claim());
        assert!(!publication.try_claim());
        assert!(!publication.is_published());

        publication.complete();
        publication.wait_until_published().await;
        assert!(publication.is_published());
    }

    #[test]
    fn teardown_tombstone_reserves_the_session_id_until_cleanup_finishes() {
        let mut registry = AgentRegistry::default();
        assert!(registry.can_create("same-id"));
        assert!(registry.begin_teardown("same-id"));
        assert!(!registry.can_create("same-id"));
        registry.end_teardown("same-id");
        assert!(registry.can_create("same-id"));
    }
}
