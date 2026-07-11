//! Async orchestration for agent sessions: command handlers, reader threads,
//! journal fan-out. The data structures live in `kanna_daemon::agent`.

mod adoption;
mod commands;
mod lifecycle;
mod readers;

use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::AgentEvent;
use kanna_daemon::agent::{AgentClientWriter, AgentSessionRecord, AgentShared};
use kanna_daemon::protocol::{self, Event, SessionStatus};

pub use adoption::adopt_agent_session;
pub use commands::{
    handle_agent_input, handle_agent_interrupt, handle_agent_permission, handle_agent_set_model,
    handle_attach_agent, handle_spawn_agent,
};
pub use lifecycle::{
    agent_session_infos, cleanup_agent_writer, detach_agent_writer, kill_agent_session,
};

use crate::socket::write_event;

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
