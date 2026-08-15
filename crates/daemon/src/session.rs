use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Weak,
};
use std::time::{Duration, Instant};

use crate::headless_terminal::HeadlessTerminal;
use crate::protocol::{AgentProvider, SessionInfo, SessionState, SessionStatus};
use crate::pty::PtySession;
use kanna_daemon::terminal_perf::{self, TerminalPerfContext};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

pub const STATUS_DETECTION_THROTTLE_MS: u64 = 500;
pub const LOGICAL_INPUT_SUBMIT_DELAY_MS: u64 = 150;

#[derive(Clone)]
pub struct StreamControl {
    stop_requested: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    quiesce_requested: Arc<AtomicBool>,
    quiesced: Arc<AtomicBool>,
    stopped_notify: Arc<Notify>,
    state_notify: Arc<Notify>,
}

impl Default for StreamControl {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamControl {
    pub fn new() -> Self {
        Self {
            stop_requested: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            quiesce_requested: Arc::new(AtomicBool::new(false)),
            quiesced: Arc::new(AtomicBool::new(false)),
            stopped_notify: Arc::new(Notify::new()),
            state_notify: Arc::new(Notify::new()),
        }
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.state_notify.notify_one();
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn mark_stopped(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.quiesced.store(false, Ordering::SeqCst);
        self.stopped_notify.notify_waiters();
        self.state_notify.notify_waiters();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn is_same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.stop_requested, &other.stop_requested)
            && Arc::ptr_eq(&self.stopped, &other.stopped)
    }

    pub fn request_quiesce(&self) {
        self.quiesce_requested.store(true, Ordering::SeqCst);
        self.state_notify.notify_one();
    }

    pub fn resume(&self) {
        self.quiesce_requested.store(false, Ordering::SeqCst);
        self.state_notify.notify_one();
    }

    pub fn quiesce_requested(&self) -> bool {
        self.quiesce_requested.load(Ordering::SeqCst)
    }

    pub fn mark_quiesced(&self) {
        self.quiesced.store(true, Ordering::SeqCst);
        self.state_notify.notify_waiters();
    }

    pub fn mark_resumed(&self) {
        self.quiesced.store(false, Ordering::SeqCst);
        self.state_notify.notify_waiters();
    }

    pub fn is_quiesced(&self) -> bool {
        self.quiesced.load(Ordering::SeqCst)
    }

    pub async fn wait_for_state_change(&self) {
        self.state_notify.notified().await;
    }

    pub async fn wait_until_stopped(&self) {
        loop {
            let notified = self.stopped_notify.notified();
            if self.is_stopped() {
                return;
            }
            notified.await;
        }
    }
}

pub struct SessionRecord {
    pub pty: PtySession,
    pub headless_terminal: HeadlessTerminal,
    pub stream_control: Option<StreamControl>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
    pub operator_input_only: bool,
    pub input_policy_classified: bool,
    pub raw_input_draft_active: bool,
    pub raw_input_draft_state_known: bool,
    pub pending_logical_inputs: Vec<Vec<u8>>,
}

pub struct SessionRuntimeState {
    pub headless_terminal: HeadlessTerminal,
    pub stream_control: Option<StreamControl>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
    pub operator_input_only: bool,
    pub input_policy_classified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingInputKind {
    Raw,
    LogicalMessage,
    LogicalEnter,
}

/// Meaning declared by the terminal input producer. Submission is never
/// inferred from PTY bytes: pasted newlines and control sequences may contain
/// the same bytes as an Enter key without ending the active composer draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawInputKind {
    Draft,
    Submission,
    Control,
}

pub struct PendingInput {
    pub data: Vec<u8>,
    pub kind: PendingInputKind,
    written: Option<oneshot::Sender<()>>,
}

impl PendingInput {
    fn raw(data: Vec<u8>, written: Option<oneshot::Sender<()>>) -> Self {
        Self {
            data,
            kind: PendingInputKind::Raw,
            written,
        }
    }

    fn logical(data: Vec<u8>) -> Self {
        if data.is_empty() {
            Self {
                data: vec![b'\r'],
                kind: PendingInputKind::LogicalEnter,
                written: None,
            }
        } else {
            Self {
                data,
                kind: PendingInputKind::LogicalMessage,
                written: None,
            }
        }
    }

    pub fn advance_logical_message_to_enter(&mut self) -> bool {
        if self.kind != PendingInputKind::LogicalMessage {
            return false;
        }
        self.data.clear();
        self.data.push(b'\r');
        self.kind = PendingInputKind::LogicalEnter;
        true
    }

    pub fn acknowledge_written(mut self) {
        if let Some(written) = self.written.take() {
            let _ = written.send(());
        }
    }
}

#[derive(Debug)]
pub enum InputQueueError {
    Closed,
    CoordinationUnavailable,
    InheritedDraftStateUnknown,
}

struct InputCoordinationState {
    raw_input_draft_active: bool,
    raw_input_draft_state_known: bool,
    logical_inputs: VecDeque<QueuedLogicalInput>,
}

struct QueuedLogicalInput {
    data: Vec<u8>,
    dispatched: bool,
}

impl InputCoordinationState {
    fn from_record(record: &SessionRecord) -> Self {
        Self {
            raw_input_draft_active: record.raw_input_draft_active,
            raw_input_draft_state_known: record.raw_input_draft_state_known,
            logical_inputs: record
                .pending_logical_inputs
                .iter()
                .cloned()
                .map(|data| QueuedLogicalInput {
                    data,
                    dispatched: false,
                })
                .collect(),
        }
    }
}

pub struct MirrorResult {
    pub status: Option<SessionStatus>,
    pub replies: Vec<Vec<u8>>,
}

/// One live PTY master, attributed to the session that owns it, for the
/// exhaustion diagnostics logged when `openpty` reports `ENXIO`.
#[derive(Debug, Eq, PartialEq)]
pub struct PtyMasterAttribution {
    pub session_id: String,
    pub child_pid: u32,
    pub master_fd: std::os::fd::RawFd,
}

/// Every PTY master this daemon currently holds, in a stable order, so an
/// exhaustion log line names which sessions occupy the host pool.
#[derive(Debug, Eq, PartialEq)]
pub struct PtyOccupancySnapshot {
    sessions: Vec<PtyMasterAttribution>,
}

impl PtyOccupancySnapshot {
    pub fn new(mut sessions: Vec<PtyMasterAttribution>) -> Self {
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Self { sessions }
    }
}

impl fmt::Display for PtyOccupancySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "open_master_count={} sessions=[",
            self.sessions.len()
        )?;
        for (index, session) in self.sessions.iter().enumerate() {
            if index > 0 {
                formatter.write_str(", ")?;
            }
            write!(
                formatter,
                "{}(pid={},master_fd={})",
                session.session_id, session.child_pid, session.master_fd
            )?;
        }
        formatter.write_str("]")
    }
}

pub struct SessionHandle {
    pub(crate) pty: Mutex<PtySession>,
    /// Set by the first teardown to claim this session. Makes Kill
    /// single-flight per session so concurrent/retried Kill calls cannot
    /// enqueue unbounded whole-table sweep jobs.
    teardown_claimed: std::sync::atomic::AtomicBool,
    state: Mutex<SessionRuntimeState>,
    input_tx: mpsc::UnboundedSender<PendingInput>,
    input_rx: Mutex<Option<mpsc::UnboundedReceiver<PendingInput>>>,
    input_coordination: std::sync::Mutex<InputCoordinationState>,
    /// Permanently fences an outgoing incarnation from publishing output or
    /// mutating id-keyed state after a same-id replacement is allowed.
    retired: AtomicBool,
}

impl SessionHandle {
    pub fn new(record: SessionRecord) -> Self {
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let mut input_coordination = InputCoordinationState::from_record(&record);
        if input_coordination.raw_input_draft_state_known
            && !input_coordination.raw_input_draft_active
        {
            for logical_input in &mut input_coordination.logical_inputs {
                input_tx
                    .send(PendingInput::logical(logical_input.data.clone()))
                    .expect("new session input receiver must be open");
                logical_input.dispatched = true;
            }
        }
        Self {
            pty: Mutex::new(record.pty),
            teardown_claimed: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(SessionRuntimeState {
                headless_terminal: record.headless_terminal,
                stream_control: record.stream_control,
                agent_provider: record.agent_provider,
                status: record.status,
                status_observed: record.status_observed,
                last_status_check_at: record.last_status_check_at,
                operator_input_only: record.operator_input_only,
                input_policy_classified: record.input_policy_classified,
            }),
            input_tx,
            input_rx: Mutex::new(Some(input_rx)),
            input_coordination: std::sync::Mutex::new(input_coordination),
            retired: AtomicBool::new(false),
        }
    }

    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    pub fn enqueue_terminal_reply(&self, data: Vec<u8>) -> Result<(), InputQueueError> {
        self.input_tx
            .send(PendingInput::raw(data, None))
            .map_err(|_| InputQueueError::Closed)
    }

    pub fn enqueue_raw_input(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
    ) -> Result<(), InputQueueError> {
        self.enqueue_raw_input_with_ack(data, kind, None)
    }

    pub fn enqueue_acknowledged_raw_input(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
    ) -> Result<oneshot::Receiver<()>, InputQueueError> {
        let (written_tx, written) = oneshot::channel();
        self.enqueue_raw_input_with_ack(data, kind, Some(written_tx))?;
        Ok(written)
    }

    fn enqueue_raw_input_with_ack(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
        written: Option<oneshot::Sender<()>>,
    ) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        let mut routed = vec![PendingInput::raw(data.clone(), written)];
        match kind {
            RawInputKind::Submission => {
                state.raw_input_draft_active = false;
                state.raw_input_draft_state_known = true;
                for logical_input in &mut state.logical_inputs {
                    if !logical_input.dispatched {
                        routed.push(PendingInput::logical(logical_input.data.clone()));
                        logical_input.dispatched = true;
                    }
                }
            }
            RawInputKind::Draft => {
                state.raw_input_draft_active = true;
                state.raw_input_draft_state_known = true;
            }
            RawInputKind::Control => {}
        }
        for input in routed {
            self.input_tx
                .send(input)
                .map_err(|_| InputQueueError::Closed)?;
        }
        Ok(())
    }

    /// Accept one logical message. It is submitted atomically now when no raw
    /// draft exists, or retained until the next producer-declared submission
    /// boundary otherwise.
    pub fn enqueue_logical_input(&self, data: Vec<u8>) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        if !state.raw_input_draft_state_known {
            return Err(InputQueueError::InheritedDraftStateUnknown);
        }
        state.logical_inputs.push_back(QueuedLogicalInput {
            data: data.clone(),
            dispatched: false,
        });
        if state.raw_input_draft_active {
            return Ok(());
        }
        if self.input_tx.send(PendingInput::logical(data)).is_err() {
            state.logical_inputs.pop_back();
            return Err(InputQueueError::Closed);
        }
        if let Some(logical_input) = state.logical_inputs.back_mut() {
            logical_input.dispatched = true;
        }
        Ok(())
    }

    pub fn complete_logical_input(&self) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        state.logical_inputs.pop_front();
        Ok(())
    }

    /// Legacy-v2 handoff payloads cannot preserve terminal draft coordination.
    /// A v2 adopter may ignore the newer wire fields while still acknowledging
    /// adoption, so the current daemon must retain ownership until inherited
    /// draft state is known, the raw draft is inactive, and the accepted
    /// logical-input queue is empty.
    pub fn input_coordination_requires_v3(&self) -> Result<bool, InputQueueError> {
        let state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        Ok(!state.raw_input_draft_state_known
            || state.raw_input_draft_active
            || !state.logical_inputs.is_empty())
    }

    pub async fn try_clone_io_fd(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        self.pty.lock().await.try_clone_io_fd()
    }

    pub async fn take_input_rx(&self) -> Option<mpsc::UnboundedReceiver<PendingInput>> {
        self.input_rx.lock().await.take()
    }

    pub async fn set_stream_control(&self, stream_control: StreamControl) {
        self.state.lock().await.stream_control = Some(stream_control);
    }

    pub async fn operator_input_only(&self) -> bool {
        self.state.lock().await.operator_input_only
    }

    pub async fn classify_input(&self, operator_input_only: bool) {
        let mut state = self.state.lock().await;
        state.operator_input_only = operator_input_only;
        state.input_policy_classified = true;
    }

    pub async fn stream_control(&self) -> Option<StreamControl> {
        self.state.lock().await.stream_control.clone()
    }

    pub async fn owns_stream_control(&self, stream_control: &StreamControl) -> bool {
        self.state
            .lock()
            .await
            .stream_control
            .as_ref()
            .is_some_and(|current| current.is_same_instance(stream_control))
    }

    pub async fn mirror_output(
        &self,
        data: &[u8],
        allow_terminal_replies: bool,
    ) -> Result<MirrorResult, Box<dyn std::error::Error + Send + Sync>> {
        self.mirror_output_at(
            data,
            allow_terminal_replies,
            Instant::now(),
            status_detection_throttle(),
        )
        .await
    }

    async fn mirror_output_at(
        &self,
        data: &[u8],
        allow_terminal_replies: bool,
        now: Instant,
        throttle: Duration,
    ) -> Result<MirrorResult, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        state.headless_terminal.write(data);
        let replies = if allow_terminal_replies {
            state.headless_terminal.drain_pty_writes()
        } else {
            state.headless_terminal.drain_pty_writes();
            Vec::new()
        };
        let status = detect_runtime_status_if_due(&mut state, now, throttle)?;
        Ok(MirrorResult { status, replies })
    }

    pub async fn refresh_quiet_status(
        &self,
        quiet_for: Duration,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        self.refresh_quiet_status_at(quiet_for, Instant::now(), status_detection_throttle())
            .await
    }

    async fn refresh_quiet_status_at(
        &self,
        quiet_for: Duration,
        now: Instant,
        throttle: Duration,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        let last_active_at = self.pty.lock().await.last_active_at;
        if last_active_at.elapsed() < quiet_for {
            return Ok(None);
        }

        let mut state = self.state.lock().await;
        detect_runtime_status_if_due(&mut state, now, throttle)
    }

    pub async fn debug_status_observation(
        &self,
    ) -> Result<StatusObservation, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        let agent_provider = state.agent_provider;
        Ok(StatusObservation {
            provider: agent_provider,
            detected_status: state.headless_terminal.visible_status(agent_provider)?,
            lines: state.headless_terminal.debug_lines(8)?,
        })
    }

    pub async fn codex_resume_session_id(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        if state.agent_provider != Some(AgentProvider::Codex) {
            return Ok(None);
        }

        state.headless_terminal.codex_resume_session_id()
    }

    pub async fn update_status(&self, status: SessionStatus) -> bool {
        let mut state = self.state.lock().await;
        if state.status != status {
            state.status = status;
            true
        } else {
            false
        }
    }

    pub async fn waiting_prompt_snippet(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        let provider = state.agent_provider;
        state.headless_terminal.waiting_prompt_snippet(provider)
    }

    pub async fn status(&self) -> SessionStatus {
        self.state.lock().await.status
    }

    pub async fn agent_provider(&self) -> Option<AgentProvider> {
        self.state.lock().await.agent_provider
    }

    pub async fn snapshot(
        &self,
        session_id: &str,
    ) -> Result<crate::protocol::TerminalSnapshot, Box<dyn std::error::Error + Send + Sync>> {
        let lock_operation = terminal_perf::global_monitor().begin(TerminalPerfContext::new(
            "daemon",
            session_id,
            "snapshot_lock",
        ));
        let mut state = self.state.lock().await;
        lock_operation.finish();

        let serialize_operation = terminal_perf::global_monitor().begin(TerminalPerfContext::new(
            "daemon",
            session_id,
            "snapshot_serialize",
        ));
        let snapshot = state.headless_terminal.snapshot();
        serialize_operation.finish();
        snapshot
    }

    pub async fn rows_cols(&self) -> (u16, u16) {
        let pty = self.pty.lock().await;
        (pty.rows(), pty.cols())
    }

    pub async fn mark_active(&self) {
        self.pty.lock().await.last_active_at = Instant::now();
    }

    pub async fn resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.pty.lock().await.resize(cols, rows)?;
        self.state
            .lock()
            .await
            .headless_terminal
            .resize(cols, rows)?;
        Ok(())
    }

    pub async fn signal(&self, sig: i32) -> std::io::Result<()> {
        self.pty.lock().await.signal(sig)
    }

    /// Claim teardown for this session. Returns true exactly once; later
    /// callers get false and must not enqueue another sweep.
    pub(crate) fn claim_teardown(&self) -> bool {
        self.teardown_claimed
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
    }

    pub async fn kill(&self) -> std::io::Result<()> {
        // Termination ownership is decided atomically under the PTY lock:
        // the kill strike and the one-shot reap token are taken in the same
        // critical section, so concurrent kills spawn exactly one reaper and
        // any later kill/signal on this session sees terminated ownership
        // instead of a pid that may have been recycled after the reap.
        // Single-flight: a repeated or concurrent Kill for this session must
        // not enqueue a second whole-table sweep. The first claimant owns
        // teardown; later callers observe the already-terminated session.
        if !self.claim_teardown() {
            return Ok(());
        }
        // Phase 1 under the lock: freeze the leader and consume the
        // one-shot reap token. No process-table scan or SIGKILL happens here.
        let (plan, reap) = {
            let mut pty = self.pty.lock().await;
            let plan = pty.begin_kill();
            (plan, pty.take_reap_token())
        };
        // Phase 2 off-lock, off the Tokio workers: the whole-process-table
        // sweep and every SIGKILL run on the bounded lifecycle executor.
        let result =
            kanna_daemon::reaper::run_teardown_and_wait::<std::io::Result<()>>(move || {
                plan.execute(None)
            })
            .await
            .unwrap_or_else(|| Err(std::io::Error::other("PTY teardown worker stopped")));
        // Only an owned, unreaped child may be waited on: waitpid on an
        // adopted or unproven pid would either fail or reap an unrelated
        // process-group child.
        if let Some((pid, start)) = reap {
            let ownership =
                kanna_daemon::reaper::ReapOwnership::Pid(kanna_daemon::reaper::ReapIdentity {
                    pid,
                    start,
                });
            if let Err(error) = kanna_daemon::reaper::try_reap(ownership) {
                kanna_daemon::reaper::reap(error.into_ownership()).await;
            }
        }
        result
    }

    pub async fn try_wait(&self) -> Option<i32> {
        self.pty.lock().await.try_wait()
    }

    pub async fn pty_master_attribution(&self, session_id: String) -> PtyMasterAttribution {
        let pty = self.pty.lock().await;
        PtyMasterAttribution {
            session_id,
            child_pid: pty.pid(),
            master_fd: pty.master_raw_fd(),
        }
    }

    pub async fn info(&self, session_id: String) -> SessionInfo {
        let mut pty = self.pty.lock().await;
        let state = match pty.try_wait() {
            Some(code) => SessionState::Exited(code),
            None => SessionState::Active,
        };
        let idle_seconds = pty.last_active_at.elapsed().as_secs();
        let pid = pty.pid();
        let cwd = pty.cwd.clone();
        drop(pty);
        let status = self.status().await;

        SessionInfo {
            session_id,
            pid,
            cwd,
            state,
            idle_seconds,
            status,
            kind: crate::protocol::SessionKind::Pty,
        }
    }

    pub async fn handoff_parts(
        &self,
    ) -> Result<Option<SessionHandoffParts>, Box<dyn std::error::Error + Send + Sync>> {
        let pty = self.pty.lock().await;
        if !pty.is_alive() {
            return Ok(None);
        }
        let pid = pty.pid();
        let child_start = pty.child_identity();
        let cwd = pty.cwd.clone();
        let rows = pty.rows();
        let cols = pty.cols();
        let fd = pty.try_clone_handoff_fd()?;
        drop(pty);

        let mut state = self.state.lock().await;
        let snapshot = state.headless_terminal.snapshot().ok();
        let input_coordination = self
            .input_coordination
            .lock()
            .map_err(|_| "terminal input coordination lock was poisoned")?;
        Ok(Some(SessionHandoffParts {
            pid,
            child_start,
            cwd,
            rows,
            cols,
            snapshot,
            agent_provider: state.agent_provider,
            status: state.status,
            operator_input_only: state.operator_input_only,
            input_policy_classified: state.input_policy_classified,
            raw_input_draft_active: input_coordination.raw_input_draft_active,
            raw_input_draft_state_known: input_coordination.raw_input_draft_state_known,
            pending_logical_inputs: input_coordination
                .logical_inputs
                .iter()
                .map(|logical_input| logical_input.data.clone())
                .collect(),
            fd,
        }))
    }
}

pub struct SessionHandoffParts {
    pub pid: u32,
    /// Start-time identity of the child, so the adopting daemon can
    /// authenticate the pid against the live process table.
    pub child_start: Option<crate::proc_info::StartTime>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: Option<crate::protocol::TerminalSnapshot>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub operator_input_only: bool,
    pub input_policy_classified: bool,
    pub raw_input_draft_active: bool,
    pub raw_input_draft_state_known: bool,
    pub pending_logical_inputs: Vec<Vec<u8>>,
    pub fd: std::os::fd::OwnedFd,
}

pub struct SessionManager {
    pub sessions: HashMap<String, Arc<SessionHandle>>,
    lifecycle_locks: HashMap<String, Weak<Mutex<()>>>,
    /// Ids whose outgoing incarnation is still being torn down. A same-id
    /// Spawn must not install while the old session's id-keyed state (fanout,
    /// terminal clients, sizes, recovery) is still being cleared, or that
    /// cleanup would clobber the replacement's state.
    teardown_tombstones: std::collections::HashSet<String>,
    /// Bumped on every handoff snapshot; adoption revalidates against it.
    handoff_epoch: u64,
    /// True between a handoff snapshot and its commit-or-abort. Published
    /// through a watch channel so a task that must not act while sealed can
    /// park until the transfer resolves, with no lost-wakeup race and no
    /// polling.
    sealed_for_handoff: tokio::sync::watch::Sender<bool>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

pub struct StatusObservation {
    pub provider: Option<AgentProvider>,
    pub detected_status: Option<SessionStatus>,
    pub lines: Vec<String>,
}

pub struct BenchmarkStatusState {
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
}

impl BenchmarkStatusState {
    #[allow(dead_code)]
    pub fn new(status: SessionStatus) -> Self {
        Self {
            status,
            status_observed: false,
            last_status_check_at: None,
        }
    }
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            sessions: HashMap::new(),
            lifecycle_locks: HashMap::new(),
            teardown_tombstones: std::collections::HashSet::new(),
            handoff_epoch: 0,
            sealed_for_handoff: tokio::sync::watch::Sender::new(false),
        }
    }

    /// Seal the manager for a handoff transfer and return the epoch the
    /// snapshot was taken at. While sealed, `insert` is refused: a PTY
    /// session spawned after the snapshot would be lost when this daemon
    /// exits (its master fd is never transferred), and a killed session must
    /// not be reinserted behind the transfer. The seal lifts if the handoff
    /// aborts and this daemon keeps serving.
    pub fn seal_for_handoff(&mut self) -> u64 {
        // `send_replace`, never `send`: `send` reports failure and skips the
        // update when no receiver exists, and receivers here are transient —
        // they only exist while a task is parked on the seal.
        self.sealed_for_handoff.send_replace(true);
        self.handoff_epoch += 1;
        self.handoff_epoch
    }

    pub fn unseal_for_handoff(&mut self) {
        // Wakes everyone parked in `seal_lifted` — the handoff aborted, so
        // this daemon keeps serving and owns its sessions again.
        self.sealed_for_handoff.send_replace(false);
    }

    pub fn is_sealed_for_handoff(&self) -> bool {
        *self.sealed_for_handoff.borrow()
    }

    /// How many tasks are currently parked waiting for the seal to lift.
    /// Test-only: lets a regression prove a task really reached the fence
    /// instead of sleeping and hoping.
    #[cfg(test)]
    pub fn seal_waiter_count(&self) -> usize {
        self.sealed_for_handoff.receiver_count()
    }

    /// Wait until no handoff transfer is in flight.
    ///
    /// Returns a future deliberately detached from the manager lock: callers
    /// take it while holding the lock and await it after releasing, and
    /// `watch` re-reads the current value on entry, so a seal that lifts in
    /// that gap resolves immediately instead of parking forever.
    ///
    /// A COMMITTED handoff never lifts the seal — this daemon exits instead —
    /// so a waiter on the commit path is dropped with the process, which is
    /// exactly the intent: the successor now owns that session.
    pub fn seal_lifted(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let mut rx = self.sealed_for_handoff.subscribe();
        async move {
            // An error means the manager is gone; the daemon is shutting down
            // and there is nothing left to reconcile.
            let _ = rx.wait_for(|sealed| !*sealed).await;
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn handoff_epoch(&self) -> u64 {
        self.handoff_epoch
    }

    /// Insert a session unless the manager is sealed for an in-flight
    /// handoff. Returns false when refused, so the caller can fail the Spawn
    /// loudly instead of silently stranding the child.
    #[must_use]
    pub fn insert_unless_sealed(
        &mut self,
        session_id: String,
        session: Arc<SessionHandle>,
    ) -> bool {
        if self.is_sealed_for_handoff() || self.teardown_tombstones.contains(&session_id) {
            return false;
        }
        if let Some(previous) = self.sessions.insert(session_id, session) {
            previous.retire();
        }
        true
    }

    /// Mark `session_id` as being torn down. Held until the outgoing
    /// incarnation's Exit is published and all of its id-keyed state is
    /// cleared, so a replacement can never install into a half-cleaned slot.
    /// Returns false if a teardown is already in flight for the id.
    #[must_use]
    pub fn begin_teardown(&mut self, session_id: &str) -> bool {
        self.teardown_tombstones.insert(session_id.to_string())
    }

    pub fn end_teardown(&mut self, session_id: &str) {
        self.teardown_tombstones.remove(session_id);
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_tearing_down(&self, session_id: &str) -> bool {
        self.teardown_tombstones.contains(session_id)
    }

    pub fn insert(&mut self, session_id: String, session: Arc<SessionHandle>) {
        if let Some(previous) = self.sessions.insert(session_id, session) {
            previous.retire();
        }
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.get(session_id).cloned()
    }

    pub fn remove(&mut self, session_id: &str) -> Option<Arc<SessionHandle>> {
        let removed = self.sessions.remove(session_id);
        if let Some(session) = removed.as_ref() {
            session.retire();
        }
        removed
    }

    /// Remove `session_id` only if it still maps to `expected` — the exact
    /// incarnation the caller resolved. A same-id session installed in the
    /// meantime is left alone, so teardown of an old incarnation can never
    /// evict its replacement.
    pub fn remove_if_same(
        &mut self,
        session_id: &str,
        expected: &Arc<SessionHandle>,
    ) -> Option<Arc<SessionHandle>> {
        let matches = self
            .sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected));
        if matches {
            let removed = self.sessions.remove(session_id);
            if let Some(session) = removed.as_ref() {
                session.retire();
            }
            removed
        } else {
            None
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn handles(&self) -> Vec<(String, Arc<SessionHandle>)> {
        self.sessions
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_current(&self, session_id: &str, session: &Arc<SessionHandle>) -> bool {
        self.sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
    }

    pub fn lifecycle_lock(&mut self, session_id: &str) -> Arc<Mutex<()>> {
        self.lifecycle_locks
            .retain(|_, lifecycle| lifecycle.strong_count() > 0);
        if let Some(lifecycle) = self.lifecycle_locks.get(session_id).and_then(Weak::upgrade) {
            return lifecycle;
        }

        let lifecycle = Arc::new(Mutex::new(()));
        self.lifecycle_locks
            .insert(session_id.to_string(), Arc::downgrade(&lifecycle));
        lifecycle
    }

    pub fn kill_all_handles(&mut self) -> Vec<(String, Arc<SessionHandle>)> {
        let handles = self.handles();
        for (_, session) in &handles {
            session.retire();
        }
        self.sessions.clear();
        handles
    }

    /// Kill every session with scan rounds batched across all of them (one
    /// process-table snapshot per round for the whole batch).
    ///
    /// Phase 1 (freeze + reap token) runs under each session's own lock; the
    /// sweep runs on the lifecycle executor.
    ///
    /// Ordering is load-bearing: every kill plan must COMPLETE before its
    /// reap token is handed to the reaper. Reaping first would let the child's
    /// pid be recycled while the plan still holds it as a signal target.
    pub async fn kill_all_with_shared_scan(&mut self) -> Vec<(String, Arc<SessionHandle>)> {
        let handles = self.kill_all_handles();
        let mut ids = Vec::with_capacity(handles.len());
        let mut plans = Vec::with_capacity(handles.len());
        let mut reap_pids = Vec::with_capacity(handles.len());
        for (id, handle) in &handles {
            if !handle.claim_teardown() {
                continue; // already being torn down (single-flight)
            }
            let (plan, pid) = {
                let mut pty = handle.pty.lock().await;
                let plan = pty.begin_kill();
                (plan, pty.take_reap_token())
            };
            ids.push(id.clone());
            plans.push(plan);
            reap_pids.push(pid);
        }
        if !plans.is_empty() {
            let batch_ids = ids.clone();
            let results = kanna_daemon::reaper::run_teardown_and_wait(move || {
                crate::pty::PtyKillPlan::execute_batch(plans)
            })
            .await;
            if let Some(results) = results {
                for (id, result) in batch_ids.iter().zip(results) {
                    if let Err(error) = result {
                        log::warn!("[kill-all] session {} teardown failed: {}", id, error);
                    }
                }
            }
            // Only now may the children be reaped.
            for (pid, start) in reap_pids.into_iter().flatten() {
                let ownership =
                    kanna_daemon::reaper::ReapOwnership::Pid(kanna_daemon::reaper::ReapIdentity {
                        pid,
                        start,
                    });
                if let Err(error) = kanna_daemon::reaper::try_reap(ownership) {
                    kanna_daemon::reaper::reap(error.into_ownership()).await;
                }
            }
        }
        handles
    }

    #[allow(dead_code)]
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// A live PTY session whose child exits on its own almost immediately,
    /// for tests that need to observe the natural-exit path.
    pub fn spawn_exiting_record(
        stream_control: &StreamControl,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let pty = PtySession::spawn(
            "/bin/sh",
            &[String::from("-c"), String::from("exit 0")],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )?;
        Ok(SessionRecord {
            pty,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: Some(stream_control.clone()),
            agent_provider: None,
            status: SessionStatus::Idle,
            status_observed: false,
            last_status_check_at: None,
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            pending_logical_inputs: Vec::new(),
        })
    }

    /// A minimal live PTY session record for lifecycle tests.
    pub fn spawn_sleeper_record() -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>
    {
        let pty = PtySession::spawn(
            "/bin/sh",
            &[String::from("-c"), String::from("sleep 30")],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )?;
        Ok(SessionRecord {
            pty,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: None,
            agent_provider: None,
            status: SessionStatus::Idle,
            status_observed: false,
            last_status_check_at: None,
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            pending_logical_inputs: Vec::new(),
        })
    }
}

/// Attribute every live PTY master to its session for exhaustion diagnostics.
pub async fn pty_occupancy_snapshot(sessions: &Arc<Mutex<SessionManager>>) -> PtyOccupancySnapshot {
    let handles = sessions.lock().await.handles();
    let mut attribution = Vec::with_capacity(handles.len());
    for (session_id, session) in handles {
        attribution.push(session.pty_master_attribution(session_id).await);
    }
    PtyOccupancySnapshot::new(attribution)
}

fn status_detection_throttle() -> Duration {
    Duration::from_millis(STATUS_DETECTION_THROTTLE_MS)
}

fn detect_headless_terminal_status_if_due(
    headless_terminal: &mut HeadlessTerminal,
    agent_provider: Option<AgentProvider>,
    status: SessionStatus,
    status_observed: &mut bool,
    last_status_check_at: &mut Option<Instant>,
    now: Instant,
    throttle: Duration,
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    if last_status_check_at
        .is_some_and(|last_check_at| now.saturating_duration_since(last_check_at) < throttle)
    {
        return Ok(None);
    }

    *last_status_check_at = Some(now);

    let visible_status = headless_terminal.visible_status(agent_provider)?;
    if let Some(next_status) = visible_status {
        *status_observed = true;
        return Ok(if status != next_status {
            Some(next_status)
        } else {
            None
        });
    }

    Ok(
        if *status_observed && matches!(status, SessionStatus::Busy | SessionStatus::Waiting) {
            Some(SessionStatus::Idle)
        } else {
            None
        },
    )
}

#[allow(dead_code)]
pub fn replay_headless_terminal_for_benchmark(
    headless_terminal: &mut HeadlessTerminal,
    agent_provider: Option<AgentProvider>,
    state: &mut BenchmarkStatusState,
    benchmark_started_at: Instant,
    chunk_at_ms: u64,
    data: &[u8],
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    headless_terminal.write(data);
    headless_terminal.drain_pty_writes();

    let now = benchmark_started_at
        .checked_add(Duration::from_millis(chunk_at_ms))
        .unwrap_or(benchmark_started_at);

    detect_headless_terminal_status_if_due(
        headless_terminal,
        agent_provider,
        state.status,
        &mut state.status_observed,
        &mut state.last_status_check_at,
        now,
        status_detection_throttle(),
    )
}

fn detect_runtime_status_if_due(
    state: &mut SessionRuntimeState,
    now: Instant,
    throttle: Duration,
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    detect_headless_terminal_status_if_due(
        &mut state.headless_terminal,
        state.agent_provider,
        state.status,
        &mut state.status_observed,
        &mut state.last_status_check_at,
        now,
        throttle,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{
        replay_headless_terminal_for_benchmark, BenchmarkStatusState, PtyMasterAttribution,
        PtyOccupancySnapshot, RawInputKind, SessionHandle, SessionManager, SessionRecord,
        StreamControl,
    };
    use crate::bench::transcript::{BenchmarkMode, BenchmarkProvider, TranscriptSpec};
    use crate::headless_terminal::{initial_session_status, HeadlessTerminal};
    use crate::protocol::{AgentProvider, SessionStatus};
    use crate::pty::PtySession;

    fn spawn_test_record(
        provider: AgentProvider,
        status: SessionStatus,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let pty = PtySession::spawn(
            "/bin/sh",
            &[String::from("-c"), String::from("sleep 10")],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )?;

        Ok(SessionRecord {
            pty,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: None,
            agent_provider: Some(provider),
            status,
            status_observed: false,
            last_status_check_at: None,
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            pending_logical_inputs: Vec::new(),
        })
    }

    fn spawn_test_handle(
        provider: AgentProvider,
        status: SessionStatus,
    ) -> Result<Arc<SessionHandle>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Arc::new(SessionHandle::new(spawn_test_record(
            provider, status,
        )?)))
    }

    #[tokio::test]
    async fn kill_returns_and_releases_pty_lock_before_child_is_reaped() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();

        handle.kill().await.unwrap();

        // The pty mutex must be free as soon as kill returns; the old code
        // held it through a blocking reap of the child.
        assert!(handle.pty.try_lock().is_ok());
    }

    #[tokio::test]
    async fn acknowledged_input_completes_only_after_the_writer_accepts_it() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        let mut written = handle
            .enqueue_acknowledged_raw_input(b"merge request".to_vec(), RawInputKind::Draft)
            .expect("enqueue input");

        assert!(
            written.try_recv().is_err(),
            "enqueueing alone must not acknowledge the input"
        );
        let pending = input_rx.recv().await.expect("pending input");
        assert_eq!(pending.data, b"merge request");
        assert!(
            written.try_recv().is_err(),
            "dequeueing alone must not acknowledge the input"
        );

        pending.acknowledge_written();
        written.await.expect("PTY writer acknowledgement");
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn logical_input_waits_for_a_raw_draft_boundary_and_keeps_fifo_order() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        let draft = input_rx.recv().await.expect("raw draft input");
        assert_eq!(draft.kind, super::PendingInputKind::Raw);
        assert_eq!(draft.data, b"human draft");

        handle
            .enqueue_logical_input(b"manager one".to_vec())
            .expect("queue first logical input");
        handle
            .enqueue_logical_input(b"manager two".to_vec())
            .expect("queue second logical input");
        assert!(
            input_rx.try_recv().is_err(),
            "logical messages must stay out of the PTY writer while the draft is active"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue raw submission boundary");
        let boundary = input_rx.recv().await.expect("raw boundary");
        let first = input_rx.recv().await.expect("first logical input");
        let second = input_rx.recv().await.expect("second logical input");
        assert_eq!(boundary.kind, super::PendingInputKind::Raw);
        assert_eq!(boundary.data, b"\r");
        assert_eq!(first.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(first.data, b"manager one");
        assert_eq!(second.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(second.data, b"manager two");

        handle
            .enqueue_raw_input(b"next draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue next raw draft");
        let next_draft = input_rx.recv().await.expect("next raw draft");
        assert_eq!(next_draft.kind, super::PendingInputKind::Raw);
        assert_eq!(next_draft.data, b"next draft");

        handle
            .enqueue_logical_input(b"manager three".to_vec())
            .expect("queue behind the next draft");
        assert!(input_rx.try_recv().is_err());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn embedded_newlines_in_bracketed_paste_are_not_submission_boundaries() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        let _draft = input_rx.recv().await.expect("raw draft input");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("queue logical input");

        let paste = b"\x1b[200~ continued\nsecond line\x1b[201~".to_vec();
        handle
            .enqueue_raw_input(paste.clone(), RawInputKind::Draft)
            .expect("enqueue multiline paste continuation");
        let continuation = input_rx.recv().await.expect("paste continuation");
        assert_eq!(continuation.kind, super::PendingInputKind::Raw);
        assert_eq!(continuation.data, paste);
        assert!(
            input_rx.try_recv().is_err(),
            "embedded paste newline must not release the logical message"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue producer-declared submission boundary");
        assert_eq!(input_rx.recv().await.expect("boundary").data, b"\r");
        assert_eq!(
            input_rx.recv().await.expect("logical message").data,
            b"manager message"
        );
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_control_does_not_create_or_clear_a_draft_or_strand_logical_input() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"human draft");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("queue logical input");

        let mouse_report = b"\x1b[<65;1;1M".to_vec();
        handle
            .enqueue_raw_input(mouse_report.clone(), RawInputKind::Control)
            .expect("enqueue terminal control");
        assert_eq!(input_rx.recv().await.expect("control").data, mouse_report);
        assert!(
            input_rx.try_recv().is_err(),
            "control input must not clear the real human draft"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue submission boundary");
        assert_eq!(input_rx.recv().await.expect("boundary").data, b"\r");
        assert_eq!(
            input_rx.recv().await.expect("logical message").data,
            b"manager message"
        );
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_control_on_a_clear_composer_cannot_strand_the_next_logical_input() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        let mouse_report = b"\x1b[<65;1;1M".to_vec();
        handle
            .enqueue_raw_input(mouse_report.clone(), RawInputKind::Control)
            .expect("enqueue mobile terminal control");
        assert_eq!(input_rx.recv().await.expect("control").data, mouse_report);

        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input after control");
        let logical = input_rx
            .try_recv()
            .expect("control input must not strand logical delivery behind a phantom draft");
        assert_eq!(logical.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(logical.data, b"manager message");
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn accepted_logical_input_remains_in_the_handoff_snapshot_until_written() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();

        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");
        let parts = handle
            .handoff_parts()
            .await
            .expect("snapshot session")
            .expect("live session");
        assert_eq!(parts.pending_logical_inputs, [b"manager message".to_vec()]);

        handle.complete_logical_input().expect("complete input");
        let parts = handle
            .handoff_parts()
            .await
            .expect("snapshot session")
            .expect("live session");
        assert!(parts.pending_logical_inputs.is_empty());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn legacy_unknown_draft_state_refuses_logical_input_until_explicit_boundary() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert!(matches!(
            handle.enqueue_logical_input(b"manager message".to_vec()),
            Err(super::InputQueueError::InheritedDraftStateUnknown)
        ));
        assert!(input_rx.try_recv().is_err());

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("explicit producer boundary");
        assert_eq!(input_rx.recv().await.expect("boundary").data, b"\r");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("logical retry after boundary");
        assert_eq!(
            input_rx.recv().await.expect("logical retry").data,
            b"manager message"
        );
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn legacy_handoff_input_stays_fenced_until_one_way_classification() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.operator_input_only = true;
        record.input_policy_classified = false;
        let handle = SessionHandle::new(record);

        assert!(handle.operator_input_only().await);
        handle.classify_input(false).await;
        assert!(!handle.operator_input_only().await);
        handle.classify_input(true).await;
        assert!(handle.operator_input_only().await);
        handle.classify_input(false).await;
        assert!(!handle.operator_input_only().await);
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_kills_are_single_flight_and_block_later_signals() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();

        // Both kills succeed, but termination ownership is taken exactly
        // once: the reap token is consumed under the PTY lock, so only one
        // background reaper can exist and a pid recycled after the reap can
        // never be targeted through this session.
        let (first, second) = tokio::join!(handle.kill(), handle.kill());
        first.expect("first kill should succeed");
        second.expect("second kill should be a safe no-op");

        assert!(
            handle.pty.lock().await.take_reap_token().is_none(),
            "the reap token must have been consumed exactly once"
        );
        assert!(
            handle.signal(libc::SIGTERM).await.is_err(),
            "signals after termination must be refused"
        );
    }

    #[tokio::test]
    async fn session_manager_distinguishes_same_id_handle_incarnations() {
        let old = spawn_test_handle(AgentProvider::Codex, SessionStatus::Busy).unwrap();
        let replacement = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut manager = SessionManager::new();

        manager.insert("task-same-id".to_string(), Arc::clone(&old));
        assert!(manager.is_current("task-same-id", &old));

        manager.insert("task-same-id".to_string(), Arc::clone(&replacement));
        assert!(!manager.is_current("task-same-id", &old));
        assert!(manager.is_current("task-same-id", &replacement));
        assert!(
            old.is_retired(),
            "replacing a session id must fence the old reader incarnation"
        );
        assert!(!replacement.is_retired());

        old.kill().await.unwrap();
        replacement.kill().await.unwrap();
    }

    #[tokio::test]
    async fn stream_control_waits_for_stop_acknowledgement() {
        let control = StreamControl::new();
        let reader_control = control.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            reader_control.mark_stopped();
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(100), control.wait_until_stopped())
                .await
                .is_ok(),
            "reader stop acknowledgement should wake the kill path"
        );
    }

    #[tokio::test]
    async fn copilot_startup_busy_does_not_quiet_idle_before_provider_ui_is_visible() {
        let handle = spawn_test_handle(AgentProvider::Copilot, SessionStatus::Busy).unwrap();
        handle.pty.lock().await.last_active_at = Instant::now() - Duration::from_millis(500);

        let status = handle
            .refresh_quiet_status(Duration::from_millis(150))
            .await
            .unwrap();

        assert_eq!(status, None);

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn quiet_refresh_returns_idle_after_busy_footer_disappears() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Busy).unwrap();
        record.status_observed = true;
        record.headless_terminal.write("Header\r\nDone".as_bytes());
        record.pty.last_active_at = Instant::now() - Duration::from_millis(500);
        let handle = Arc::new(SessionHandle::new(record));

        let status = handle
            .refresh_quiet_status(Duration::from_millis(150))
            .await
            .unwrap();

        assert_eq!(status, Some(SessionStatus::Idle));

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn debug_status_observation_reports_detected_status_and_lines() {
        let mut record = spawn_test_record(AgentProvider::Copilot, SessionStatus::Idle).unwrap();
        record
            .headless_terminal
            .write("Header\r\n(Esc to cancel)".as_bytes());
        let handle = Arc::new(SessionHandle::new(record));

        let observation = handle.debug_status_observation().await.unwrap();

        assert_eq!(observation.detected_status, Some(SessionStatus::Busy));
        assert_eq!(observation.provider, Some(AgentProvider::Copilot));
        assert!(observation
            .lines
            .iter()
            .any(|line| line.contains("Esc to cancel")));

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn throttles_status_detection_per_session() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        let handle = Arc::new(SessionHandle::new(record));

        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        let first_status = handle
            .mirror_output_at(
                "Header\r\n• Working (0s • esc to interrupt)\r\n› Run /review".as_bytes(),
                false,
                started_at,
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(first_status.status, Some(SessionStatus::Busy));
        assert!(handle.update_status(SessionStatus::Busy).await);

        let throttled_status = handle
            .mirror_output_at(
                "\x1b[2J\x1b[HHeader\r\nDone\r\n›".as_bytes(),
                false,
                started_at + Duration::from_millis(100),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(throttled_status.status, None);

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn quiet_refresh_observes_status_after_throttle_window() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        let handle = Arc::new(SessionHandle::new(record));

        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        let first_status = handle
            .mirror_output_at(
                "Header\r\n• Working (0s • esc to interrupt)\r\n› Run /review".as_bytes(),
                false,
                started_at,
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(first_status.status, Some(SessionStatus::Busy));
        assert!(handle.update_status(SessionStatus::Busy).await);

        let throttled_status = handle
            .mirror_output_at(
                "\x1b[2J\x1b[HHeader\r\nDone\r\n›".as_bytes(),
                false,
                started_at + Duration::from_millis(100),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(throttled_status.status, None);

        let early_refresh = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(300),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(early_refresh, None);

        let refreshed_status = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(600),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(refreshed_status, Some(SessionStatus::Idle));

        handle.kill().await.unwrap();
    }

    #[test]
    fn benchmark_replay_updates_status_without_real_pty_io() {
        let transcript =
            TranscriptSpec::new(BenchmarkProvider::Codex, BenchmarkMode::Steady).build();
        let mut headless_terminal = HeadlessTerminal::new(120, 40, 10_000).unwrap();
        let started_at = Instant::now();
        let mut state =
            BenchmarkStatusState::new(initial_session_status(Some(AgentProvider::Codex)));

        for chunk in &transcript.chunks {
            let changed = replay_headless_terminal_for_benchmark(
                &mut headless_terminal,
                Some(AgentProvider::Codex),
                &mut state,
                started_at,
                chunk.at_ms,
                &chunk.bytes,
            )
            .unwrap();

            if let Some(next) = changed {
                state.status = next;
            }
        }

        assert!(matches!(
            state.status,
            SessionStatus::Busy | SessionStatus::Idle
        ));
        assert!(state.status_observed);
    }

    #[test]
    fn pty_exhaustion_occupancy_is_sorted_and_attributed() {
        let snapshot = PtyOccupancySnapshot::new(vec![
            PtyMasterAttribution {
                session_id: "zeta".to_string(),
                child_pid: 42,
                master_fd: 12,
            },
            PtyMasterAttribution {
                session_id: "alpha".to_string(),
                child_pid: 7,
                master_fd: 9,
            },
        ]);

        assert_eq!(
            snapshot.to_string(),
            "open_master_count=2 sessions=[alpha(pid=7,master_fd=9), zeta(pid=42,master_fd=12)]"
        );
    }
}
