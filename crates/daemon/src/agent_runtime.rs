//! Async orchestration for agent sessions: command handlers, reader threads,
//! journal fan-out. The data structures live in `kanna_daemon::agent`.

mod adoption;
mod commands;
mod lifecycle;
pub(crate) mod readers;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

use kanna_agent_protocol::AgentEvent;
use kanna_daemon::agent::{
    AgentClientWriter, AgentEventLine, AgentSessionRecord, AgentShared, AgentSubscriber,
};
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
    AgentKillOutcome,
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

const AGENT_SUBSCRIBER_MAILBOX_MAX_BYTES: usize = 8 * 1024 * 1024;

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

#[cfg(debug_assertions)]
async fn wait_at_agent_writer_test_barrier() {
    let Some(root) = std::env::var_os("KANNA_TEST_AGENT_WRITER_BARRIER") else {
        return;
    };
    let root = std::path::Path::new(&root);
    let _ = std::fs::create_dir_all(root);
    let _ = std::fs::write(root.join("blocked"), b"");
    while !root.join("release").exists() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

fn serialize_agent_event(event: &Event) -> Option<Arc<str>> {
    match serde_json::to_string(event) {
        Ok(mut json) => {
            json.push('\n');
            Some(Arc::from(json))
        }
        Err(error) => {
            log_error(format_args!(
                "[agent] failed to serialize client event: {error}"
            ));
            None
        }
    }
}

fn disconnect_agent_subscriber(subscriber: AgentSubscriber) {
    subscriber.cancelled.store(true, Ordering::Release);
    subscriber.writer_task.abort();
    let writer = subscriber.writer;
    tokio::spawn(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(100), async {
            let _ = writer.lock().await.shutdown().await;
        })
        .await;
    });
}

fn cancel_agent_subscriber(subscriber: &AgentSubscriber) {
    subscriber.cancelled.store(true, Ordering::Release);
}

fn enqueue_agent_event(writers: &mut Vec<AgentSubscriber>, event: &Event) {
    let Some(line) = serialize_agent_event(event) else {
        return;
    };
    let mut index = 0;
    while index < writers.len() {
        let subscriber = &writers[index];
        let line_bytes = line.len();
        let pending = subscriber.pending_bytes.load(Ordering::Relaxed);
        if subscriber.tx.is_closed()
            || pending.saturating_add(line_bytes) > AGENT_SUBSCRIBER_MAILBOX_MAX_BYTES
        {
            disconnect_agent_subscriber(writers.remove(index));
            continue;
        }
        subscriber
            .pending_bytes
            .fetch_add(line_bytes, Ordering::Relaxed);
        if let Err(dropped) = subscriber.tx.send(AgentEventLine {
            line: Arc::clone(&line),
            initial_delivery: false,
            delivered: None,
        }) {
            subscriber
                .pending_bytes
                .fetch_sub(dropped.0.line.len(), Ordering::Relaxed);
            disconnect_agent_subscriber(writers.remove(index));
            continue;
        }
        index += 1;
    }
}

fn spawn_agent_writer_task(
    writer: AgentClientWriter,
    mut rx: mpsc::UnboundedReceiver<AgentEventLine>,
    pending_bytes: Arc<AtomicUsize>,
    cancelled: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(mut item) = rx.recv().await {
            #[cfg(debug_assertions)]
            if !item.initial_delivery {
                wait_at_agent_writer_test_barrier().await;
            }
            let result = {
                let mut guard = writer.lock().await;
                if cancelled.load(Ordering::Acquire) {
                    Err(std::io::Error::other("agent subscriber cancelled"))
                } else {
                    match guard.write_all(item.line.as_bytes()).await {
                        Ok(()) => guard.flush().await,
                        Err(error) => Err(error),
                    }
                }
            };
            pending_bytes.fetch_sub(item.line.len(), Ordering::Relaxed);
            if let Some(delivered) = item.delivered.take() {
                let _ = delivered.send(result.is_ok());
            }
            if result.is_err() {
                return;
            }
        }
    })
}

fn register_agent_subscriber(
    writers: &mut Vec<AgentSubscriber>,
    writer: AgentClientWriter,
    snapshot: &Event,
) -> Option<oneshot::Receiver<bool>> {
    let writer_id = Arc::as_ptr(&writer) as usize;
    writers.retain(|subscriber| {
        if subscriber.writer_id == writer_id {
            cancel_agent_subscriber(subscriber);
            false
        } else {
            true
        }
    });

    let line = serialize_agent_event(snapshot)?;
    let (tx, rx) = mpsc::unbounded_channel();
    let pending_bytes = Arc::new(AtomicUsize::new(line.len()));
    let cancelled = Arc::new(AtomicBool::new(false));
    let writer_task = spawn_agent_writer_task(
        writer.clone(),
        rx,
        Arc::clone(&pending_bytes),
        Arc::clone(&cancelled),
    );
    let (delivered_tx, delivered_rx) = oneshot::channel();
    if tx
        .send(AgentEventLine {
            line,
            initial_delivery: true,
            delivered: Some(delivered_tx),
        })
        .is_err()
    {
        writer_task.abort();
        return None;
    }
    writers.push(AgentSubscriber {
        writer_id,
        tx,
        pending_bytes,
        cancelled,
        writer,
        writer_task,
    });
    Some(delivered_rx)
}

fn remove_agent_subscriber(writers: &mut Vec<AgentSubscriber>, writer_id: usize) {
    writers.retain(|subscriber| {
        if subscriber.writer_id == writer_id {
            cancel_agent_subscriber(subscriber);
            false
        } else {
            true
        }
    });
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
    enqueue_agent_event(&mut sh.writers, &wire);
    entry.seq
}

/// Append only while the originating child still owns the shared journal.
async fn journal_and_fan_out_for_generation(
    session_id: &str,
    shared: &Arc<Mutex<AgentShared>>,
    spawn_generation: u64,
    event: AgentEvent,
) -> bool {
    let mut sh = shared.lock().await;
    if sh.spawn_generation != spawn_generation {
        return false;
    }
    let entry = sh.journal.append(event);
    let wire = Event::AgentEvent {
        session_id: session_id.to_string(),
        seq: entry.seq,
        event: entry.event,
    };
    enqueue_agent_event(&mut sh.writers, &wire);
    true
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
