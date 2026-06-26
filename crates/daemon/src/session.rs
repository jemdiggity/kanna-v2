use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use crate::headless_terminal::HeadlessTerminal;
use crate::protocol::{AgentProvider, SessionInfo, SessionState, SessionStatus};
use crate::pty::PtySession;
use tokio::sync::{mpsc, Mutex};

pub const STATUS_DETECTION_THROTTLE_MS: u64 = 500;

#[derive(Clone)]
pub struct StreamControl {
    stop_requested: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
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
        }
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn mark_stopped(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn is_same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.stop_requested, &other.stop_requested)
            && Arc::ptr_eq(&self.stopped, &other.stopped)
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
}

pub struct SessionRuntimeState {
    pub headless_terminal: HeadlessTerminal,
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

pub struct SessionHandle {
    pty: Mutex<PtySession>,
    state: Mutex<SessionRuntimeState>,
    input_tx: mpsc::UnboundedSender<Vec<u8>>,
    input_rx: Mutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>,
}

impl SessionHandle {
    pub fn new(record: SessionRecord) -> Self {
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        Self {
            pty: Mutex::new(record.pty),
            state: Mutex::new(SessionRuntimeState {
                headless_terminal: record.headless_terminal,
                stream_control: record.stream_control,
                agent_provider: record.agent_provider,
                status: record.status,
                status_observed: record.status_observed,
                last_status_check_at: record.last_status_check_at,
            }),
            input_tx,
            input_rx: Mutex::new(Some(input_rx)),
        }
    }

    pub fn enqueue_input(&self, data: Vec<u8>) -> Result<(), mpsc::error::SendError<Vec<u8>>> {
        self.input_tx.send(data)
    }

    pub async fn try_clone_io_fd(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        self.pty.lock().await.try_clone_io_fd()
    }

    pub async fn take_input_rx(&self) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
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

    pub async fn status(&self) -> SessionStatus {
        self.state.lock().await.status
    }

    pub async fn snapshot(
        &self,
    ) -> Result<crate::protocol::TerminalSnapshot, Box<dyn std::error::Error + Send + Sync>> {
        self.state.lock().await.headless_terminal.snapshot()
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

    pub async fn kill(&self) -> std::io::Result<()> {
        self.pty.lock().await.kill()
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
        let cwd = pty.cwd.clone();
        let rows = pty.rows();
        let cols = pty.cols();
        let fd = pty.try_clone_handoff_fd()?;
        drop(pty);

        let mut state = self.state.lock().await;
        let snapshot = state.headless_terminal.snapshot().ok();
        Ok(Some(SessionHandoffParts {
            pid,
            cwd,
            rows,
            cols,
            snapshot,
            agent_provider: state.agent_provider,
            status: state.status,
            fd,
        }))
    }
}

pub struct SessionHandoffParts {
    pub pid: u32,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: Option<crate::protocol::TerminalSnapshot>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub fd: std::os::fd::OwnedFd,
}

pub struct SessionManager {
    pub sessions: HashMap<String, Arc<SessionHandle>>,
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
        }
    }

    pub fn insert(&mut self, session_id: String, session: Arc<SessionHandle>) {
        self.sessions.insert(session_id, session);
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.get(session_id).cloned()
    }

    pub fn remove(&mut self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.remove(session_id)
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

    pub fn kill_all_handles(&mut self) -> Vec<(String, Arc<SessionHandle>)> {
        let handles = self.handles();
        self.sessions.clear();
        handles
    }

    #[allow(dead_code)]
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
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
        replay_headless_terminal_for_benchmark, BenchmarkStatusState, SessionHandle, SessionRecord,
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
