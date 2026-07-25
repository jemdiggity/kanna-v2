//! Async orchestration for agent sessions: command handlers, reader threads,
//! journal fan-out. The data structures live in `kanna_daemon::agent`.

mod adoption;
mod commands;
mod lifecycle;
pub(crate) mod readers;

use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::AgentEvent;
use kanna_daemon::agent::{AgentClientWriter, AgentSessionRecord, AgentShared};
use kanna_daemon::protocol::{self, Event, SessionStatus};

pub use adoption::adopt_agent_session;
#[cfg(test)]
pub(crate) use commands::deliver_planned_input_for_test;
#[cfg(test)]
pub(crate) use commands::install_respawned_child;
pub use commands::{
    handle_agent_input, handle_agent_interrupt, handle_agent_permission, handle_agent_set_model,
    handle_attach_agent, handle_spawn_agent,
};
pub use lifecycle::{
    agent_session_infos, cleanup_agent_writer, detach_agent_writer, kill_agent_session,
};

use crate::socket::write_event;

/// Sealed while this daemon is (or has finished) transferring its agent
/// sessions to a successor. Once sealed, in-flight spawn installers must
/// treat their record as lost and clean up the spawned child: an install
/// landing after the transfer snapshot would strand a live child in a
/// process that is about to exit. Unsealed again only if the handoff fails
/// and this daemon keeps serving.
static AGENT_HANDOFF_SEAL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn agent_handoff_sealed() -> bool {
    AGENT_HANDOFF_SEAL.load(std::sync::atomic::Ordering::SeqCst)
}

pub(crate) fn seal_agent_handoff() {
    AGENT_HANDOFF_SEAL.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub(crate) fn unseal_agent_handoff() {
    AGENT_HANDOFF_SEAL.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// The seal is process-global (a daemon hands off exactly once), so tests
/// that either arm it or assert that an install succeeds must not overlap.
/// Both kinds acquire this serializer.
#[cfg(test)]
pub(crate) fn seal_test_serializer() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// RAII seal for an in-progress agent handoff: arming seals the registry;
/// dropping the guard lifts the seal again (the handoff failed and this
/// daemon keeps serving) unless it was defused on the success path.
pub(crate) struct AgentHandoffSealGuard {
    defused: bool,
}

impl AgentHandoffSealGuard {
    pub(crate) fn arm() -> Self {
        seal_agent_handoff();
        AgentHandoffSealGuard { defused: false }
    }

    /// Keep the seal permanently (successful handoff; this daemon exits).
    pub(crate) fn defuse(mut self) {
        self.defused = true;
    }
}

impl Drop for AgentHandoffSealGuard {
    fn drop(&mut self) {
        if !self.defused {
            unseal_agent_handoff();
        }
    }
}

fn agent_error(code: protocol::ErrorCode, message: impl Into<String>) -> Event {
    Event::Error {
        code: Some(code),
        message: message.into(),
    }
}

async fn reply(writer: &AgentClientWriter, event: &Event) {
    let _ = write_event(&mut *writer.lock().await, event).await;
}

fn broadcast_event(broadcast_tx: &broadcast::Sender<String>, event: &Event) {
    if let Ok(json) = serde_json::to_string(event) {
        let _ = broadcast_tx.send(json);
    }
}

fn log_error(message: std::fmt::Arguments<'_>) {
    log::error!("{message}");
}

fn log_info(message: std::fmt::Arguments<'_>) {
    log::info!("{message}");
}

fn log_warn(message: std::fmt::Arguments<'_>) {
    log::warn!("{message}");
}

/// Write an event to every attached writer, dropping writers that fail.
async fn fan_out(writers: &mut Vec<AgentClientWriter>, event: &Event) {
    let mut alive = Vec::with_capacity(writers.len());
    for writer in writers.drain(..) {
        let ok = write_event(&mut *writer.lock().await, event).await.is_ok();
        if ok {
            alive.push(writer);
        }
    }
    *writers = alive;
}

/// Append an event to the session's journal and stream it to attached
/// clients. Returns the assigned seq.
async fn journal_and_fan_out(
    session_id: &str,
    shared: &Arc<Mutex<AgentShared>>,
    event: AgentEvent,
) -> u64 {
    let mut sh = shared.lock().await;
    let entry = sh.journal.append(event);
    let wire = Event::AgentEvent {
        session_id: session_id.to_string(),
        seq: entry.seq,
        event: entry.event,
    };
    fan_out(&mut sh.writers, &wire).await;
    entry.seq
}

fn set_status(
    record: &mut AgentSessionRecord,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
    waiting_prompt_snippet: Option<String>,
) {
    if record.status == status {
        return;
    }
    record.status = status;
    broadcast_event(
        broadcast_tx,
        &status_changed_event(session_id, status, waiting_prompt_snippet),
    );
}

fn status_changed_event(
    session_id: &str,
    status: SessionStatus,
    waiting_prompt_snippet: Option<String>,
) -> Event {
    Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
        waiting_prompt_snippet: if matches!(status, SessionStatus::Waiting | SessionStatus::Idle) {
            waiting_prompt_snippet
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_agent_status_carries_latest_assistant_prompt() {
        let event = status_changed_event(
            "agent-1",
            SessionStatus::Idle,
            Some("Ready for review".to_string()),
        );

        assert!(matches!(
            event,
            Event::StatusChanged {
                waiting_prompt_snippet: Some(prompt),
                ..
            } if prompt == "Ready for review"
        ));
    }
}
