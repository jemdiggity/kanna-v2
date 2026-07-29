use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, RwLock, Weak,
};
use std::time::{Duration, Instant};

use crate::codex_session::CodexSessionLocator;
use crate::headless_terminal::HeadlessTerminal;
use crate::protocol::{
    AgentProvider, SessionInfo, SessionState, SessionStatus, INPUT_DELIVERY_REPLAY_WINDOW,
};
use crate::pty::PtySession;
use kanna_daemon::terminal_perf::{self, TerminalPerfContext};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

pub const STATUS_DETECTION_THROTTLE_MS: u64 = 500;

#[derive(Clone)]
pub struct StreamControl {
    stop_requested: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    stopped_notify: Arc<Notify>,
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
            stopped_notify: Arc::new(Notify::new()),
        }
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn mark_stopped(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            self.stopped_notify.notify_waiters();
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub async fn wait_stopped(&self) {
        loop {
            if self.is_stopped() {
                return;
            }
            let notified = self.stopped_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_stopped() {
                return;
            }
            notified.await;
        }
    }

    pub fn is_same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.stop_requested, &other.stop_requested)
            && Arc::ptr_eq(&self.stopped, &other.stopped)
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
    pub run_id: Option<String>,
    pub codex_session_locator: Option<CodexSessionLocator>,
    pub headless_terminal: HeadlessTerminal,
    pub stream_control: Option<StreamControl>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
}

pub struct SessionRuntimeState {
    pub headless_terminal: HeadlessTerminal,
    pub run_id: Option<String>,
    pub codex_session_locator: Option<CodexSessionLocator>,
    pub stream_control: Option<StreamControl>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
}

pub struct MirrorResult {
    pub status: Option<SessionStatus>,
    pub replies: Vec<Vec<u8>>,
}

#[derive(Debug)]
pub struct QueuedInput {
    pub chunks: Vec<QueuedInputChunk>,
    pub delivery_id: Option<String>,
}

#[derive(Debug)]
pub struct QueuedInputChunk {
    pub data: Vec<u8>,
    pub delay_after: Duration,
}

impl QueuedInput {
    fn raw(data: Vec<u8>) -> Self {
        Self {
            chunks: vec![QueuedInputChunk {
                data,
                delay_after: Duration::ZERO,
            }],
            delivery_id: None,
        }
    }

    fn submission(delivery_id: String, message: Vec<u8>, submit_delay: Duration) -> Self {
        let mut chunks = Vec::with_capacity(2);
        if !message.is_empty() {
            chunks.push(QueuedInputChunk {
                data: message,
                delay_after: submit_delay,
            });
        }
        chunks.push(QueuedInputChunk {
            data: vec![b'\r'],
            delay_after: Duration::ZERO,
        });
        Self {
            chunks,
            delivery_id: Some(delivery_id),
        }
    }
}

struct InFlightInputDelivery {
    owner: u64,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
}

#[derive(Default)]
struct InputDeliveryTracker {
    /// Insertion order of `completed`, oldest first, so the window evicts by
    /// age. Kept alongside the set rather than scanned: every submission and
    /// every retry probes membership.
    completed_order: VecDeque<String>,
    completed: HashSet<String>,
    in_flight: HashMap<String, InFlightInputDelivery>,
}

#[derive(Default)]
pub struct InputDeliveryRegistry {
    state: Mutex<InputDeliveryTracker>,
    changed: Notify,
}

// The daemon binary consumes these through connection/handoff/startup; the
// package's library-only target intentionally does not compile those modules.
#[allow(dead_code)]
impl InputDeliveryRegistry {
    pub(crate) async fn is_completed(&self, delivery_id: &str) -> bool {
        self.state.lock().await.completed.contains(delivery_id)
    }

    pub(crate) async fn completed_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .await
            .completed_order
            .iter()
            .cloned()
            .collect()
    }

    pub(crate) async fn wait_for_all_in_flight(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().await.in_flight.is_empty() {
                return;
            }
            changed.await;
        }
    }

    pub(crate) async fn wait_for_existing(&self, delivery_id: &str) -> Option<Result<(), String>> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let mut state = self.state.lock().await;
        if state.completed.contains(delivery_id) {
            return Some(Ok(()));
        }
        let in_flight = state.in_flight.get_mut(delivery_id)?;
        in_flight.waiters.push(reply_tx);
        drop(state);
        Some(
            reply_rx
                .await
                .unwrap_or_else(|_| Err("input submission completion was dropped".to_string())),
        )
    }

    /// Record a completed delivery, evicting the oldest identities beyond the
    /// replay window.
    fn record_completed(state: &mut InputDeliveryTracker, delivery_id: String) {
        if state.completed.insert(delivery_id.clone()) {
            state.completed_order.push_back(delivery_id);
        }
        while state.completed_order.len() > INPUT_DELIVERY_REPLAY_WINDOW {
            if let Some(evicted) = state.completed_order.pop_front() {
                state.completed.remove(&evicted);
            }
        }
    }

    pub(crate) async fn restore_completed_ids(&self, delivery_ids: Vec<String>) {
        let mut state = self.state.lock().await;
        for delivery_id in delivery_ids {
            Self::record_completed(&mut state, delivery_id);
        }
    }
}

static NEXT_INPUT_DELIVERY_OWNER: AtomicU64 = AtomicU64::new(1);

pub struct SessionHandle {
    pub(crate) pty: Mutex<PtySession>,
    /// Set by the first teardown to claim this session. Makes Kill
    /// single-flight per session so concurrent/retried Kill calls cannot
    /// enqueue unbounded whole-table sweep jobs.
    teardown_claimed: std::sync::atomic::AtomicBool,
    state: Mutex<SessionRuntimeState>,
    input_tx: mpsc::UnboundedSender<QueuedInput>,
    input_rx: Mutex<Option<mpsc::UnboundedReceiver<QueuedInput>>>,
    /// Daemon-scoped live-post identities shared by every session
    /// incarnation. The action request id is stable across reconnects and is
    /// handed to a replacement daemon, so replay after a lost acknowledgement
    /// cannot enqueue the post twice.
    input_deliveries: RwLock<Arc<InputDeliveryRegistry>>,
    input_delivery_owner: u64,
    input_submissions_frozen: AtomicBool,
    input_submissions_accepting: AtomicBool,
    input_submissions_changed: Notify,
    /// Permanently fences an outgoing incarnation from publishing output or
    /// mutating id-keyed state after a same-id replacement is allowed.
    retired: AtomicBool,
    codex_discovery_cancellation: CodexDiscoveryCancellation,
}

#[derive(Clone, Default)]
pub struct CodexDiscoveryCancellation {
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CodexDiscoveryCancellation {
    pub fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::SeqCst) {
            self.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

impl SessionHandle {
    pub fn new(record: SessionRecord) -> Self {
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        Self {
            pty: Mutex::new(record.pty),
            teardown_claimed: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(SessionRuntimeState {
                headless_terminal: record.headless_terminal,
                run_id: record.run_id,
                codex_session_locator: record.codex_session_locator,
                stream_control: record.stream_control,
                agent_provider: record.agent_provider,
                status: record.status,
                status_observed: record.status_observed,
                last_status_check_at: record.last_status_check_at,
            }),
            input_tx,
            input_rx: Mutex::new(Some(input_rx)),
            input_deliveries: RwLock::new(Arc::new(InputDeliveryRegistry::default())),
            input_delivery_owner: NEXT_INPUT_DELIVERY_OWNER.fetch_add(1, Ordering::Relaxed),
            input_submissions_frozen: AtomicBool::new(false),
            input_submissions_accepting: AtomicBool::new(true),
            input_submissions_changed: Notify::new(),
            retired: AtomicBool::new(false),
            codex_discovery_cancellation: CodexDiscoveryCancellation::default(),
        }
    }

    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
        // SessionManager removal/replacement is the admission boundary. A
        // command that resolved this incarnation before the manager change
        // must not insert a new delivery after a retry observes it missing.
        self.input_submissions_accepting
            .store(false, Ordering::SeqCst);
        self.input_submissions_changed.notify_waiters();
    }

    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    pub fn enqueue_input(&self, data: Vec<u8>) -> Result<(), mpsc::error::SendError<QueuedInput>> {
        self.input_tx.send(QueuedInput::raw(data))
    }

    pub async fn enqueue_input_submission(
        &self,
        delivery_id: String,
        message: Vec<u8>,
        submit_delay: Duration,
    ) -> Result<(), String> {
        let (reply_rx, should_enqueue) = loop {
            let unfrozen = self.input_submissions_changed.notified();
            tokio::pin!(unfrozen);
            unfrozen.as_mut().enable();
            if self.input_submissions_frozen.load(Ordering::SeqCst) {
                unfrozen.await;
                continue;
            }
            if !self.input_submissions_accepting.load(Ordering::SeqCst) {
                return Err("input writer is no longer accepting submissions".to_string());
            }

            let registry = self.input_delivery_registry();
            let (reply_tx, reply_rx) = oneshot::channel();
            let mut deliveries = registry.state.lock().await;
            // Recheck under the registry lock. Handoff freezes before taking
            // this same lock, and writer shutdown closes admission before
            // draining it, so neither boundary can miss this insertion.
            if self.input_submissions_frozen.load(Ordering::SeqCst) {
                continue;
            }
            if !self.input_submissions_accepting.load(Ordering::SeqCst) {
                return Err("input writer is no longer accepting submissions".to_string());
            }
            if deliveries.completed.contains(&delivery_id) {
                return Ok(());
            }
            if let Some(in_flight) = deliveries.in_flight.get_mut(&delivery_id) {
                in_flight.waiters.push(reply_tx);
                break (reply_rx, false);
            }
            deliveries.in_flight.insert(
                delivery_id.clone(),
                InFlightInputDelivery {
                    owner: self.input_delivery_owner,
                    waiters: vec![reply_tx],
                },
            );
            break (reply_rx, true);
        };

        if should_enqueue
            && self
                .input_tx
                .send(QueuedInput::submission(
                    delivery_id.clone(),
                    message,
                    submit_delay,
                ))
                .is_err()
        {
            self.complete_input_submission(
                &delivery_id,
                Err("input queue closed before submission".to_string()),
            )
            .await;
        }
        reply_rx
            .await
            .unwrap_or_else(|_| Err("input submission completion was dropped".to_string()))
    }

    pub async fn complete_input_submission(&self, delivery_id: &str, result: Result<(), String>) {
        let registry = self.input_delivery_registry();
        let mut deliveries = registry.state.lock().await;
        let waiters = match deliveries.in_flight.get(delivery_id) {
            Some(in_flight) if in_flight.owner == self.input_delivery_owner => deliveries
                .in_flight
                .remove(delivery_id)
                .map(|in_flight| in_flight.waiters)
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        if result.is_ok() && !waiters.is_empty() {
            InputDeliveryRegistry::record_completed(&mut deliveries, delivery_id.to_string());
        }
        drop(deliveries);
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
        registry.changed.notify_waiters();
        self.input_submissions_changed.notify_waiters();
    }

    pub async fn fail_all_input_submissions(&self, message: &str) {
        // Close admission before taking the registry lock. A racing submitter
        // rechecks this flag under that lock, so it either joins the drain or
        // receives a definite WriteFailed response.
        self.input_submissions_accepting
            .store(false, Ordering::SeqCst);
        let registry = self.input_delivery_registry();
        let mut deliveries = registry.state.lock().await;
        let delivery_ids = deliveries
            .in_flight
            .iter()
            .filter_map(|(delivery_id, in_flight)| {
                (in_flight.owner == self.input_delivery_owner).then_some(delivery_id.clone())
            })
            .collect::<Vec<_>>();
        let mut waiters = Vec::new();
        for delivery_id in delivery_ids {
            if let Some(in_flight) = deliveries.in_flight.remove(&delivery_id) {
                waiters.extend(in_flight.waiters);
            }
        }
        drop(deliveries);
        for waiter in waiters {
            let _ = waiter.send(Err(message.to_string()));
        }
        registry.changed.notify_waiters();
        self.input_submissions_changed.notify_waiters();
    }

    fn input_delivery_registry(&self) -> Arc<InputDeliveryRegistry> {
        self.input_deliveries
            .read()
            .expect("input delivery registry poisoned")
            .clone()
    }

    fn bind_input_delivery_registry(&self, registry: Arc<InputDeliveryRegistry>) {
        *self
            .input_deliveries
            .write()
            .expect("input delivery registry poisoned") = registry;
    }

    /// Stop admitting new input submissions. The handoff orchestrator in the
    /// daemon binary owns the freeze so it can bound the barrier that follows;
    /// the library-only target does not compile that module.
    #[allow(dead_code)]
    pub(crate) async fn freeze_input_submissions(&self) {
        self.input_submissions_frozen.store(true, Ordering::SeqCst);
        // Synchronize with a submitter that passed the first atomic check.
        let registry = self.input_delivery_registry();
        drop(registry.state.lock().await);
    }

    fn unfreeze_input_submissions(&self) {
        self.input_submissions_frozen.store(false, Ordering::SeqCst);
        self.input_submissions_changed.notify_waiters();
    }

    pub async fn try_clone_io_fd(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        self.pty.lock().await.try_clone_io_fd()
    }

    pub async fn take_input_rx(&self) -> Option<mpsc::UnboundedReceiver<QueuedInput>> {
        self.input_rx.lock().await.take()
    }

    pub async fn set_stream_control(&self, stream_control: StreamControl) {
        self.state.lock().await.stream_control = Some(stream_control);
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
        let probe = {
            let state = self.state.lock().await;
            let Some(locator) = state.codex_session_locator.as_ref() else {
                return Ok(None);
            };
            if let Some(id) = locator.accepted_id() {
                return Ok(Some(id));
            }
            locator.discovery_probe()
        };
        let Some(probe) = probe else {
            return Ok(None);
        };
        let candidate = tokio::task::spawn_blocking(move || probe.discover()).await?;
        let mut state = self.state.lock().await;
        Ok(state
            .codex_session_locator
            .as_mut()
            .and_then(|locator| locator.accept_discovered(candidate)))
    }

    pub fn codex_discovery_cancellation(&self) -> CodexDiscoveryCancellation {
        self.codex_discovery_cancellation.clone()
    }

    pub fn cancel_codex_discovery(&self) {
        self.codex_discovery_cancellation.cancel();
    }

    pub async fn run_id(&self) -> Option<String> {
        self.state.lock().await.run_id.clone()
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
        let (plan, pid) = {
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
            .unwrap_or(Ok(()));
        // Only an owned, unreaped child may be waited on: waitpid on an
        // adopted or unproven pid would either fail or reap an unrelated
        // process-group child.
        if let Some(pid) = pid {
            reap_child_in_background(pid);
        }
        result
    }

    pub async fn try_wait(&self) -> Option<i32> {
        self.pty.lock().await.try_wait()
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
        let run_id = self.run_id().await;

        SessionInfo {
            session_id,
            pid,
            cwd,
            state,
            idle_seconds,
            status,
            kind: crate::protocol::SessionKind::Pty,
            run_id,
        }
    }

    pub async fn handoff_parts(
        &self,
    ) -> Result<Option<SessionHandoffParts>, Box<dyn std::error::Error + Send + Sync>> {
        // The caller freezes input submissions and waits out the registry
        // barrier before snapshotting any handle — bounded, so PTY
        // backpressure on one session cannot wedge the whole transfer.
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

        let provider_session_id = self.codex_resume_session_id().await?;
        let mut state = self.state.lock().await;
        let snapshot = state.headless_terminal.snapshot().ok();
        let codex_session = state
            .codex_session_locator
            .as_ref()
            .map(CodexSessionLocator::handoff_state);
        Ok(Some(SessionHandoffParts {
            pid,
            child_start,
            run_id: state.run_id.clone(),
            cwd,
            rows,
            cols,
            snapshot,
            agent_provider: state.agent_provider,
            provider_session_id,
            codex_session,
            status: state.status,
            fd,
        }))
    }
}

pub struct SessionHandoffParts {
    pub pid: u32,
    /// Start-time identity of the child, so the adopting daemon can
    /// authenticate the pid against the live process table.
    pub child_start: Option<crate::proc_info::StartTime>,
    pub run_id: Option<String>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: Option<crate::protocol::TerminalSnapshot>,
    pub agent_provider: Option<AgentProvider>,
    pub provider_session_id: Option<String>,
    pub codex_session: Option<crate::protocol::CodexSessionHandoff>,
    pub status: SessionStatus,
    pub fd: std::os::fd::OwnedFd,
}

pub struct SessionManager {
    pub sessions: HashMap<String, Arc<SessionHandle>>,
    lifecycle_locks: HashMap<String, Weak<Mutex<()>>>,
    input_deliveries: Arc<InputDeliveryRegistry>,
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
            input_deliveries: Arc::new(InputDeliveryRegistry::default()),
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
        for session in self.sessions.values() {
            session.unfreeze_input_submissions();
        }
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
        session.bind_input_delivery_registry(Arc::clone(&self.input_deliveries));
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
        session.bind_input_delivery_registry(Arc::clone(&self.input_deliveries));
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

    pub fn input_delivery_registry(&self) -> Arc<InputDeliveryRegistry> {
        Arc::clone(&self.input_deliveries)
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
            for pid in reap_pids.into_iter().flatten() {
                kanna_daemon::reaper::reap_pid(pid);
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
            run_id: None,
            codex_session_locator: None,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: Some(stream_control.clone()),
            agent_provider: None,
            status: SessionStatus::Idle,
            status_observed: false,
            last_status_check_at: None,
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
            run_id: None,
            codex_session_locator: None,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: None,
            agent_provider: None,
            status: SessionStatus::Idle,
            status_observed: false,
            last_status_check_at: None,
        })
    }
}

fn status_detection_throttle() -> Duration {
    Duration::from_millis(STATUS_DETECTION_THROTTLE_MS)
}

/// Hand a SIGKILLed PTY child to the central reaper. Never blocks the async
/// runtime, and — unlike the old 60-second give-up — never abandons the
/// child: an abandoned zombie keeps its pty slot allocated for the daemon's
/// remaining life, which is precisely the exhaustion this branch fixes.
/// Ownership is one-shot; the caller has already consumed the reap token.
fn reap_child_in_background(pid: libc::pid_t) {
    kanna_daemon::reaper::reap_pid(pid);
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
        replay_headless_terminal_for_benchmark, BenchmarkStatusState, InputDeliveryRegistry,
        SessionHandle, SessionManager, SessionRecord, StreamControl,
    };
    use crate::bench::transcript::{BenchmarkMode, BenchmarkProvider, TranscriptSpec};
    use crate::headless_terminal::{initial_session_status, HeadlessTerminal};
    use crate::protocol::{AgentProvider, SessionStatus, INPUT_DELIVERY_REPLAY_WINDOW};
    use crate::pty::PtySession;
    use tokio::sync::Mutex;

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
            run_id: None,
            codex_session_locator: None,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: None,
            agent_provider: Some(provider),
            status,
            status_observed: false,
            last_status_check_at: None,
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
    async fn input_submission_enqueues_message_and_enter_once_under_delivery_identity() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        let first_handle = Arc::clone(&handle);
        let first = tokio::spawn(async move {
            first_handle
                .enqueue_input_submission(
                    "action-1".to_string(),
                    b"finish the post".to_vec(),
                    Duration::from_millis(150),
                )
                .await
        });
        let queued = input_rx.recv().await.expect("atomic submission");
        assert!(
            !first.is_finished(),
            "the daemon must not acknowledge before both queued chunks are written"
        );
        assert_eq!(queued.delivery_id.as_deref(), Some("action-1"));
        assert_eq!(queued.chunks.len(), 2);
        assert_eq!(queued.chunks[0].data, b"finish the post");
        assert_eq!(queued.chunks[0].delay_after, Duration::from_millis(150));
        assert_eq!(queued.chunks[1].data, vec![b'\r']);
        assert!(queued.chunks[1].delay_after.is_zero());

        let concurrent_retry_handle = Arc::clone(&handle);
        let concurrent_retry = tokio::spawn(async move {
            concurrent_retry_handle
                .enqueue_input_submission(
                    "action-1".to_string(),
                    b"finish the post".to_vec(),
                    Duration::from_millis(150),
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            matches!(
                input_rx.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "a retry that joins an in-flight delivery must not enqueue a second batch"
        );

        handle.complete_input_submission("action-1", Ok(())).await;
        first.await.unwrap().unwrap();
        concurrent_retry.await.unwrap().unwrap();
        handle
            .enqueue_input_submission(
                "action-1".to_string(),
                b"finish the post".to_vec(),
                Duration::from_millis(150),
            )
            .await
            .unwrap();
        assert!(
            matches!(
                input_rx.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "retrying the same durable delivery must not enqueue it twice"
        );
    }

    #[tokio::test]
    async fn completed_input_identity_survives_session_removal_and_replacement() {
        let first = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut first_rx = first.take_input_rx().await.expect("first input queue");
        let mut manager = SessionManager::new();
        manager.insert("task-1".to_string(), Arc::clone(&first));

        let submitting = {
            let first = Arc::clone(&first);
            tokio::spawn(async move {
                first
                    .enqueue_input_submission(
                        "durable-action".to_string(),
                        b"finish the post".to_vec(),
                        Duration::from_millis(150),
                    )
                    .await
            })
        };
        let queued = first_rx.recv().await.expect("first submission");
        assert_eq!(queued.delivery_id.as_deref(), Some("durable-action"));
        let registry = manager.input_delivery_registry();
        assert!(
            !registry.is_completed("durable-action").await,
            "the retry's first completed-ID check races before writer acknowledgement"
        );
        let retry_wait = {
            let registry = Arc::clone(&registry);
            tokio::spawn(async move { registry.wait_for_existing("durable-action").await })
        };
        tokio::task::yield_now().await;
        assert!(
            !retry_wait.is_finished(),
            "a retry must join the daemon-scoped in-flight delivery"
        );
        manager.remove("task-1");
        first
            .complete_input_submission("durable-action", Ok(()))
            .await;
        assert!(
            registry.is_completed("durable-action").await,
            "a retry that sees the session missing must catch completion on its second check"
        );
        submitting.await.unwrap().unwrap();
        assert_eq!(retry_wait.await.unwrap(), Some(Ok(())));

        let replacement = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut replacement_rx = replacement
            .take_input_rx()
            .await
            .expect("replacement input queue");
        manager.insert("task-1".to_string(), Arc::clone(&replacement));
        replacement
            .enqueue_input_submission(
                "durable-action".to_string(),
                b"finish the post".to_vec(),
                Duration::from_millis(150),
            )
            .await
            .expect("replacement sees daemon-level completed identity");
        assert!(
            matches!(
                replacement_rx.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "lost-ack replay must not enqueue a second PTY sequence"
        );
    }

    #[tokio::test]
    async fn completed_input_identities_evict_beyond_the_replay_window() {
        let registry = InputDeliveryRegistry::default();
        registry
            .restore_completed_ids(
                (0..=INPUT_DELIVERY_REPLAY_WINDOW)
                    .map(|index| format!("delivery-{index:03}"))
                    .collect(),
            )
            .await;

        let restored = registry.completed_ids().await;
        assert_eq!(
            restored.len(),
            INPUT_DELIVERY_REPLAY_WINDOW,
            "the daemon-scoped tombstone set must stay bounded across handoffs"
        );
        assert_eq!(restored.first().map(String::as_str), Some("delivery-001"));
        assert_eq!(restored.last().map(String::as_str), Some("delivery-128"));
        assert!(!registry.is_completed("delivery-000").await);
        assert!(registry.is_completed("delivery-128").await);
    }

    #[tokio::test]
    async fn handoff_registry_barrier_includes_delivery_from_a_removed_session() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        let mut manager = SessionManager::new();
        manager.insert("task-1".to_string(), Arc::clone(&handle));

        let submitting = {
            let handle = Arc::clone(&handle);
            tokio::spawn(async move {
                handle
                    .enqueue_input_submission(
                        "removed-during-kill".to_string(),
                        b"finish the post".to_vec(),
                        Duration::ZERO,
                    )
                    .await
            })
        };
        input_rx.recv().await.expect("queued submission");

        let removed = manager.remove("task-1").expect("session claimed by kill");
        manager.seal_for_handoff();
        let registry = manager.input_delivery_registry();
        let barrier = {
            let registry = Arc::clone(&registry);
            tokio::spawn(async move { registry.wait_for_all_in_flight().await })
        };
        tokio::task::yield_now().await;
        assert!(
            !barrier.is_finished(),
            "handoff must wait for a delivery owned by a just-removed session"
        );

        removed
            .complete_input_submission("removed-during-kill", Ok(()))
            .await;
        submitting.await.unwrap().unwrap();
        barrier.await.unwrap();
        assert_eq!(
            registry.completed_ids().await,
            vec!["removed-during-kill"],
            "the completed identity must be present before handoff snapshots it"
        );
    }

    #[tokio::test]
    async fn handoff_snapshot_freezes_new_submissions_until_abort_unseals() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        let manager = Arc::new(Mutex::new(SessionManager::new()));
        manager
            .lock()
            .await
            .insert("task-1".to_string(), Arc::clone(&handle));

        let first_submit = {
            let handle = Arc::clone(&handle);
            tokio::spawn(async move {
                handle
                    .enqueue_input_submission(
                        "before-handoff".to_string(),
                        b"first".to_vec(),
                        Duration::ZERO,
                    )
                    .await
            })
        };
        input_rx.recv().await.expect("first queued submission");

        manager.lock().await.seal_for_handoff();
        // The orchestrator's barrier: freeze every handle, then wait out the
        // daemon-wide registry before snapshotting any of them.
        handle.freeze_input_submissions().await;
        let snapshot_barrier = {
            let registry = manager.lock().await.input_delivery_registry();
            tokio::spawn(async move { registry.wait_for_all_in_flight().await })
        };
        tokio::task::yield_now().await;
        assert!(
            !snapshot_barrier.is_finished(),
            "handoff must wait for an already admitted submission"
        );
        handle
            .complete_input_submission("before-handoff", Ok(()))
            .await;
        first_submit.await.unwrap().unwrap();
        snapshot_barrier.await.unwrap();
        assert!(handle.handoff_parts().await.unwrap().is_some());

        let after_snapshot = {
            let handle = Arc::clone(&handle);
            tokio::spawn(async move {
                handle
                    .enqueue_input_submission(
                        "after-snapshot".to_string(),
                        b"second".to_vec(),
                        Duration::ZERO,
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(
            !after_snapshot.is_finished(),
            "a sealed handoff must not admit input after its identity snapshot"
        );
        assert!(matches!(
            input_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        manager.lock().await.unseal_for_handoff();
        input_rx
            .recv()
            .await
            .expect("submission queued after abort");
        handle
            .complete_input_submission("after-snapshot", Ok(()))
            .await;
        after_snapshot.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn input_submission_fails_if_the_writer_stops_between_message_and_enter() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        let submit_handle = Arc::clone(&handle);
        let submit = tokio::spawn(async move {
            submit_handle
                .enqueue_input_submission(
                    "action-between".to_string(),
                    b"finish the post".to_vec(),
                    Duration::from_millis(150),
                )
                .await
        });
        let queued = input_rx.recv().await.expect("atomic submission");
        assert_eq!(queued.chunks[0].data, b"finish the post");
        assert_eq!(queued.chunks[1].data, vec![b'\r']);

        handle
            .complete_input_submission(
                "action-between",
                Err("PTY write failed before Enter".to_string()),
            )
            .await;
        assert_eq!(
            submit.await.unwrap().unwrap_err(),
            "PTY write failed before Enter"
        );
    }

    #[tokio::test]
    async fn stopped_writer_rejects_submissions_admitted_after_the_drain() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .fail_all_input_submissions("PTY writer stopped")
            .await;

        assert!(handle
            .enqueue_input_submission(
                "after-writer-stop".to_string(),
                b"must not queue".to_vec(),
                Duration::ZERO,
            )
            .await
            .is_err());
        assert!(matches!(
            input_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
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
}
