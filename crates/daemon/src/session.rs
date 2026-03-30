use std::collections::HashMap;

use kanna_daemon::protocol::{SessionInfo, SessionState};
use crate::pty::PtySession;

pub struct SessionManager {
    pub sessions: HashMap<String, PtySession>,
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            sessions: HashMap::new(),
        }
    }

    pub fn insert(&mut self, session_id: String, session: PtySession) {
        self.sessions.insert(session_id, session);
    }

    pub fn get_mut(&mut self, session_id: &str) -> Option<&mut PtySession> {
        self.sessions.get_mut(session_id)
    }

    pub fn remove(&mut self, session_id: &str) -> Option<PtySession> {
        self.sessions.remove(session_id)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn list(&mut self) -> Vec<SessionInfo> {
        self.sessions
            .iter_mut()
            .map(|(id, session)| {
                let state = match session.try_wait() {
                    Some(code) => SessionState::Exited(code),
                    None => SessionState::Active,
                };
                let idle_seconds = session.last_active_at.elapsed().as_secs();
                SessionInfo {
                    session_id: id.clone(),
                    pid: session.pid(),
                    cwd: session.cwd.clone(),
                    state,
                    idle_seconds,
                    snapshot: None,
                    cols: None,
                    rows: None,
                }
            })
            .collect()
    }

    pub fn resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match self.sessions.get(session_id) {
            Some(session) => session.resize(cols, rows),
            None => Err(format!("session not found: {}", session_id).into()),
        }
    }

    pub fn signal(&self, session_id: &str, sig: i32) -> std::io::Result<()> {
        match self.sessions.get(session_id) {
            Some(session) => session.signal(sig),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("session not found: {}", session_id),
            )),
        }
    }

    pub fn kill_all(&mut self) {
        for (id, session) in self.sessions.iter_mut() {
            if let Err(e) = session.kill() {
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
