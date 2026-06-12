use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use crate::headless_terminal::HeadlessTerminal;
use crate::protocol::{AgentProvider, SessionInfo, SessionState, SessionStatus};
use crate::pty::PtySession;

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

pub struct SessionManager {
    pub sessions: HashMap<String, SessionRecord>,
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

    pub fn insert(&mut self, session_id: String, session: SessionRecord) {
        self.sessions.insert(session_id, session);
    }

    pub fn get_mut(&mut self, session_id: &str) -> Option<&mut SessionRecord> {
        self.sessions.get_mut(session_id)
    }

    pub fn remove(&mut self, session_id: &str) -> Option<SessionRecord> {
        self.sessions.remove(session_id)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn list(&mut self) -> Vec<SessionInfo> {
        self.sessions
            .iter_mut()
            .map(|(id, session)| {
                let state = match session.pty.try_wait() {
                    Some(code) => SessionState::Exited(code),
                    None => SessionState::Active,
                };
                let idle_seconds = session.pty.last_active_at.elapsed().as_secs();
                SessionInfo {
                    session_id: id.clone(),
                    pid: session.pty.pid(),
                    cwd: session.pty.cwd.clone(),
                    state,
                    idle_seconds,
                    status: session.status,
                    kind: crate::protocol::SessionKind::Pty,
                }
            })
            .collect()
    }

    pub fn update_status(&mut self, session_id: &str, status: SessionStatus) -> bool {
        match self.sessions.get_mut(session_id) {
            Some(session) if session.status != status => {
                session.status = status;
                true
            }
            Some(_) => false,
            None => false,
        }
    }

    pub fn resize(
        &mut self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match self.sessions.get_mut(session_id) {
            Some(session) => {
                session.pty.resize(cols, rows)?;
                session.headless_terminal.resize(cols, rows)?;
                Ok(())
            }
            None => Err(format!("session not found: {}", session_id).into()),
        }
    }

    pub fn signal(&self, session_id: &str, sig: i32) -> std::io::Result<()> {
        match self.sessions.get(session_id) {
            Some(session) => session.pty.signal(sig),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("session not found: {}", session_id),
            )),
        }
    }

    pub fn mirror_output(
        &mut self,
        session_id: &str,
        data: &[u8],
        allow_terminal_replies: bool,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        self.mirror_output_at(
            session_id,
            data,
            allow_terminal_replies,
            Instant::now(),
            status_detection_throttle(),
        )
    }

    fn mirror_output_at(
        &mut self,
        session_id: &str,
        data: &[u8],
        allow_terminal_replies: bool,
        now: Instant,
        throttle: Duration,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        match self.sessions.get_mut(session_id) {
            Some(session) => {
                session.headless_terminal.write(data);
                if allow_terminal_replies {
                    for reply in session.headless_terminal.drain_pty_writes() {
                        session.pty.write_input(&reply)?;
                    }
                } else {
                    session.headless_terminal.drain_pty_writes();
                }
                detect_status_if_due(session, now, throttle)
            }
            None => Err(format!("session not found: {}", session_id).into()),
        }
    }

    pub fn refresh_quiet_status(
        &mut self,
        session_id: &str,
        quiet_for: Duration,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        self.refresh_quiet_status_at(
            session_id,
            quiet_for,
            Instant::now(),
            status_detection_throttle(),
        )
    }

    fn refresh_quiet_status_at(
        &mut self,
        session_id: &str,
        quiet_for: Duration,
        now: Instant,
        throttle: Duration,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(None);
        };

        if session.pty.last_active_at.elapsed() < quiet_for {
            return Ok(None);
        }

        detect_status_if_due(session, now, throttle)
    }

    pub fn debug_status_observation(
        &mut self,
        session_id: &str,
    ) -> Result<Option<StatusObservation>, Box<dyn std::error::Error + Send + Sync>> {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(None);
        };

        Ok(Some(StatusObservation {
            provider: session.agent_provider,
            detected_status: session
                .headless_terminal
                .visible_status(session.agent_provider)?,
            lines: session.headless_terminal.debug_lines(8)?,
        }))
    }

    pub fn codex_resume_session_id(
        &mut self,
        session_id: &str,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(None);
        };

        if session.agent_provider != Some(AgentProvider::Codex) {
            return Ok(None);
        }

        session.headless_terminal.codex_resume_session_id()
    }

    pub fn kill_all(&mut self) {
        for (id, session) in self.sessions.iter_mut() {
            if let Err(e) = session.pty.kill() {
                eprintln!("failed to kill session {}: {}", id, e);
            }
        }
        self.sessions.clear();
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

fn detect_status_if_due(
    session: &mut SessionRecord,
    now: Instant,
    throttle: Duration,
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    detect_headless_terminal_status_if_due(
        &mut session.headless_terminal,
        session.agent_provider,
        session.status,
        &mut session.status_observed,
        &mut session.last_status_check_at,
        now,
        throttle,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use super::{
        replay_headless_terminal_for_benchmark, BenchmarkStatusState, SessionManager, SessionRecord,
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

    #[test]
    fn copilot_startup_busy_does_not_quiet_idle_before_provider_ui_is_visible() {
        let mut manager = SessionManager::new();
        let mut record = spawn_test_record(AgentProvider::Copilot, SessionStatus::Busy).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_millis(500);
        manager.insert("copilot".to_string(), record);

        let status = manager
            .refresh_quiet_status("copilot", Duration::from_millis(150))
            .unwrap();

        assert_eq!(status, None);

        manager
            .remove("copilot")
            .expect("session should exist")
            .pty
            .kill()
            .unwrap();
    }

    #[test]
    fn quiet_refresh_returns_idle_after_busy_footer_disappears() {
        let mut manager = SessionManager::new();
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Busy).unwrap();
        record.status_observed = true;
        record.headless_terminal.write("Header\r\nDone".as_bytes());
        record.pty.last_active_at = Instant::now() - Duration::from_millis(500);
        manager.insert("codex".to_string(), record);

        let status = manager
            .refresh_quiet_status("codex", Duration::from_millis(150))
            .unwrap();

        assert_eq!(status, Some(SessionStatus::Idle));

        manager
            .remove("codex")
            .expect("session should exist")
            .pty
            .kill()
            .unwrap();
    }

    #[test]
    fn debug_status_observation_reports_detected_status_and_lines() {
        let mut manager = SessionManager::new();
        let mut record = spawn_test_record(AgentProvider::Copilot, SessionStatus::Idle).unwrap();
        record
            .headless_terminal
            .write("Header\r\n(Esc to cancel)".as_bytes());
        manager.insert("copilot".to_string(), record);

        let observation = manager
            .debug_status_observation("copilot")
            .unwrap()
            .unwrap();

        assert_eq!(observation.detected_status, Some(SessionStatus::Busy));
        assert_eq!(observation.provider, Some(AgentProvider::Copilot));
        assert!(observation
            .lines
            .iter()
            .any(|line| line.contains("Esc to cancel")));

        manager
            .remove("copilot")
            .expect("session should exist")
            .pty
            .kill()
            .unwrap();
    }

    #[test]
    fn throttles_status_detection_per_session() {
        let mut manager = SessionManager::new();
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        manager.insert("codex".to_string(), record);

        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        let first_status = manager
            .mirror_output_at(
                "codex",
                "Header\r\n• Working (0s • esc to interrupt)\r\n› Run /review".as_bytes(),
                false,
                started_at,
                throttle,
            )
            .unwrap();
        assert_eq!(first_status, Some(SessionStatus::Busy));
        assert!(manager.update_status("codex", SessionStatus::Busy));

        let throttled_status = manager
            .mirror_output_at(
                "codex",
                "\x1b[2J\x1b[HHeader\r\nDone\r\n›".as_bytes(),
                false,
                started_at + Duration::from_millis(100),
                throttle,
            )
            .unwrap();
        assert_eq!(throttled_status, None);

        manager
            .remove("codex")
            .expect("session should exist")
            .pty
            .kill()
            .unwrap();
    }

    #[test]
    fn quiet_refresh_observes_status_after_throttle_window() {
        let mut manager = SessionManager::new();
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        manager.insert("codex".to_string(), record);

        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        let first_status = manager
            .mirror_output_at(
                "codex",
                "Header\r\n• Working (0s • esc to interrupt)\r\n› Run /review".as_bytes(),
                false,
                started_at,
                throttle,
            )
            .unwrap();
        assert_eq!(first_status, Some(SessionStatus::Busy));
        assert!(manager.update_status("codex", SessionStatus::Busy));

        let throttled_status = manager
            .mirror_output_at(
                "codex",
                "\x1b[2J\x1b[HHeader\r\nDone\r\n›".as_bytes(),
                false,
                started_at + Duration::from_millis(100),
                throttle,
            )
            .unwrap();
        assert_eq!(throttled_status, None);

        let early_refresh = manager
            .refresh_quiet_status_at(
                "codex",
                Duration::from_millis(500),
                started_at + Duration::from_millis(300),
                throttle,
            )
            .unwrap();
        assert_eq!(early_refresh, None);

        let refreshed_status = manager
            .refresh_quiet_status_at(
                "codex",
                Duration::from_millis(500),
                started_at + Duration::from_millis(600),
                throttle,
            )
            .unwrap();
        assert_eq!(refreshed_status, Some(SessionStatus::Idle));

        manager
            .remove("codex")
            .expect("session should exist")
            .pty
            .kill()
            .unwrap();
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
