use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::AgentEvent;
use kanna_daemon::agent::{AgentClientWriter, AgentSessionRecord, AgentShared};
use kanna_daemon::protocol::{self, Event, SessionStatus};

use crate::socket::write_event;

pub(super) fn agent_error(code: protocol::ErrorCode, message: impl Into<String>) -> Event {
    Event::Error {
        code: Some(code),
        message: message.into(),
    }
}

pub(super) async fn reply(writer: &AgentClientWriter, event: &Event) {
    let _ = write_event(&mut *writer.lock().await, event).await;
}

pub(super) fn broadcast_event(broadcast_tx: &broadcast::Sender<String>, event: &Event) {
    if let Ok(json) = serde_json::to_string(event) {
        let _ = broadcast_tx.send(json);
    }
}

/// Write an event to every attached writer, dropping writers that fail.
pub(super) async fn fan_out(writers: &mut Vec<AgentClientWriter>, event: &Event) {
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
pub(super) async fn journal_and_fan_out(
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

pub(super) fn set_status(
    record: &mut AgentSessionRecord,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
) {
    if record.status == status {
        return;
    }
    record.status = status;
    broadcast_event(
        broadcast_tx,
        &Event::StatusChanged {
            session_id: session_id.to_string(),
            status,
        },
    );
}
