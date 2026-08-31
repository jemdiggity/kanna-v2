use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use crate::protocol::{RecoveryCommand, RecoveryResponse};
use crate::session_mirror::SessionMirror;
use crate::snapshot_store::SnapshotStore;

pub struct RecoveryService {
    snapshot_store: SnapshotStore,
    sessions: HashMap<String, TrackedSession>,
    persist_debounce_ms: u64,
    stopping: bool,
}

struct TrackedSession {
    mirror: SessionMirror,
    dirty_since: Option<u64>,
}

const DEFAULT_PERSIST_DEBOUNCE_MS: u64 = 5 * 60 * 1_000;

impl RecoveryService {
    pub fn new(snapshot_store: SnapshotStore) -> Self {
        Self::new_with_persist_debounce_ms(snapshot_store, DEFAULT_PERSIST_DEBOUNCE_MS)
    }

    pub fn new_with_persist_debounce_ms(
        snapshot_store: SnapshotStore,
        persist_debounce_ms: u64,
    ) -> Self {
        Self {
            snapshot_store,
            sessions: HashMap::new(),
            persist_debounce_ms,
            stopping: false,
        }
    }

    pub fn run<R: Read + Send + 'static, W: Write>(
        &mut self,
        input: R,
        mut output: W,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(input);
            loop {
                let mut line = String::new();
                let result = match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => Ok(line),
                    Err(error) => Err(error),
                };
                let failed = result.is_err();
                if tx.send(result).is_err() || failed {
                    // A failed control-channel read is terminal. Re-entering
                    // read_line on a permanently failed descriptor can return
                    // immediately forever and burn a full CPU core after the
                    // daemon is gone.
                    break;
                }
            }
        });

        loop {
            let next_flush_delay = self.next_flush_delay();
            let received = match next_flush_delay {
                Some(delay) => Some(match rx.recv_timeout(delay) {
                    Ok(line) => line?,
                    Err(RecvTimeoutError::Timeout) => {
                        self.flush_due_sessions();
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        self.flush_all_dirty_sessions();
                        break;
                    }
                }),
                None => match rx.recv() {
                    Ok(line) => Some(line?),
                    Err(_) => {
                        self.flush_all_dirty_sessions();
                        break;
                    }
                },
            };

            let Some(line) = received else {
                continue;
            };
            if line.trim().is_empty() {
                continue;
            }

            let (expects_response, response) = match crate::protocol::parse_command(&line) {
                Ok(command) => {
                    let expects_response = command.expects_response();
                    (expects_response, self.handle_command(command))
                }
                Err(message) => (true, RecoveryResponse::Error { message }),
            };

            if expects_response || matches!(response, RecoveryResponse::Error { .. }) {
                output.write_all(
                    crate::protocol::format_response(&response)
                        .map_err(std::io::Error::other)?
                        .as_bytes(),
                )?;
                output.flush()?;
            }

            if self.stopping {
                break;
            }
            if next_flush_delay.is_some() {
                self.flush_due_sessions();
            }
        }

        Ok(())
    }

    pub fn handle_command(&mut self, command: RecoveryCommand) -> RecoveryResponse {
        match command {
            RecoveryCommand::StartSession {
                session_id,
                cols,
                rows,
                resume_from_disk,
            } => self.start_session(session_id, cols, rows, resume_from_disk),
            RecoveryCommand::WriteOutput {
                session_id,
                data,
                sequence,
            } => self.write_output(session_id, &data, sequence),
            RecoveryCommand::ResizeSession {
                session_id,
                cols,
                rows,
            } => self.resize_session(session_id, cols, rows),
            RecoveryCommand::EndSession { session_id } => self.end_session(session_id),
            RecoveryCommand::GetSnapshot { session_id } => self.get_snapshot(session_id),
            RecoveryCommand::FlushAndShutdown => self.flush_and_shutdown(),
        }
    }

    fn start_session(
        &mut self,
        session_id: String,
        cols: u16,
        rows: u16,
        resume_from_disk: bool,
    ) -> RecoveryResponse {
        if self.sessions.contains_key(&session_id) {
            return RecoveryResponse::Error {
                message: format!("Session already exists: {}", session_id),
            };
        }

        let mut mirror = match SessionMirror::new(session_id.clone(), cols, rows) {
            Ok(mirror) => mirror,
            Err(message) => return RecoveryResponse::Error { message },
        };

        if resume_from_disk {
            let snapshot = match self.snapshot_store.require(&session_id) {
                Ok(snapshot) => snapshot,
                Err(message) => return RecoveryResponse::Error { message },
            };
            if let Err(message) = mirror.restore(&snapshot) {
                return RecoveryResponse::Error { message };
            }
        } else if let Err(message) = self.snapshot_store.remove(&session_id) {
            return RecoveryResponse::Error { message };
        }

        self.sessions.insert(
            session_id,
            TrackedSession {
                mirror,
                dirty_since: None,
            },
        );
        RecoveryResponse::Ok
    }

    fn write_output(&mut self, session_id: String, data: &[u8], sequence: u64) -> RecoveryResponse {
        let dirty_since = match self.sessions.get_mut(&session_id) {
            Some(session) => {
                session.mirror.write_output(data, sequence);
                session.dirty_since = Some(now_millis());
                session.dirty_since
            }
            None => {
                return RecoveryResponse::Error {
                    message: format!("Unknown session: {}", session_id),
                };
            }
        };

        if self.should_persist_now(dirty_since) {
            return self.persist_session(&session_id);
        }

        RecoveryResponse::Ok
    }

    fn resize_session(&mut self, session_id: String, cols: u16, rows: u16) -> RecoveryResponse {
        let dirty_since = match self.sessions.get_mut(&session_id) {
            Some(session) => {
                if let Err(message) = session.mirror.resize(cols, rows) {
                    return RecoveryResponse::Error { message };
                }
                session.dirty_since = Some(now_millis());
                session.dirty_since
            }
            None => {
                return RecoveryResponse::Error {
                    message: format!("Unknown session: {}", session_id),
                };
            }
        };

        if self.should_persist_now(dirty_since) {
            return self.persist_session(&session_id);
        }

        RecoveryResponse::Ok
    }

    fn end_session(&mut self, session_id: String) -> RecoveryResponse {
        self.sessions.remove(&session_id);
        match self.snapshot_store.remove(&session_id) {
            Ok(()) => RecoveryResponse::Ok,
            Err(message) => RecoveryResponse::Error { message },
        }
    }

    fn get_snapshot(&mut self, session_id: String) -> RecoveryResponse {
        if let Some(session) = self.sessions.get_mut(&session_id) {
            return match session.mirror.snapshot() {
                Ok(snapshot) => RecoveryResponse::from_snapshot(snapshot),
                Err(message) => RecoveryResponse::Error { message },
            };
        }

        match self.snapshot_store.read(&session_id) {
            Ok(Some(snapshot)) => RecoveryResponse::from_snapshot(snapshot),
            Ok(None) => RecoveryResponse::NotFound,
            Err(message) => RecoveryResponse::Error { message },
        }
    }

    fn flush_and_shutdown(&mut self) -> RecoveryResponse {
        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for session_id in session_ids {
            if let RecoveryResponse::Error { message } = self.persist_session(&session_id) {
                return RecoveryResponse::Error { message };
            }
        }
        self.stopping = true;
        RecoveryResponse::Ok
    }

    fn should_persist_now(&self, dirty_since: Option<u64>) -> bool {
        if self.persist_debounce_ms == 0 {
            return true;
        }

        match dirty_since {
            None => false,
            Some(saved_at) => now_millis().saturating_sub(saved_at) >= self.persist_debounce_ms,
        }
    }

    fn persist_session(&mut self, session_id: &str) -> RecoveryResponse {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return RecoveryResponse::Error {
                message: format!("Unknown session: {}", session_id),
            };
        };

        if session.dirty_since.is_none() {
            return RecoveryResponse::Ok;
        }

        let snapshot = match session.mirror.snapshot() {
            Ok(snapshot) => snapshot,
            Err(message) => return RecoveryResponse::Error { message },
        };

        match self.snapshot_store.write(&snapshot) {
            Ok(()) => {
                session.dirty_since = None;
                RecoveryResponse::Ok
            }
            Err(message) => RecoveryResponse::Error { message },
        }
    }

    fn next_flush_delay(&self) -> Option<Duration> {
        if self.persist_debounce_ms == 0 {
            return Some(Duration::from_millis(0));
        }

        let now = now_millis();
        self.sessions
            .values()
            .filter_map(|session| {
                session.dirty_since.map(|dirty_since| {
                    let elapsed = now.saturating_sub(dirty_since);
                    Duration::from_millis(self.persist_debounce_ms.saturating_sub(elapsed))
                })
            })
            .min()
    }

    fn flush_due_sessions(&mut self) {
        let now = now_millis();
        let session_ids: Vec<String> = self
            .sessions
            .iter()
            .filter_map(|(session_id, session)| {
                session.dirty_since.and_then(|dirty_since| {
                    if now.saturating_sub(dirty_since) >= self.persist_debounce_ms {
                        Some(session_id.clone())
                    } else {
                        None
                    }
                })
            })
            .collect();

        for session_id in session_ids {
            let _ = self.persist_session(&session_id);
        }
    }

    fn flush_all_dirty_sessions(&mut self) {
        let session_ids: Vec<String> = self
            .sessions
            .iter()
            .filter_map(|(session_id, session)| {
                if session.dirty_since.is_some() {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect();

        for session_id in session_ids {
            let _ = self.persist_session(&session_id);
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
