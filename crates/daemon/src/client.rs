use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use kanna_daemon::protocol::{Event, SessionStatus};
use tokio::sync::Mutex;

use crate::socket::write_event;

/// A single client's writer handle.
pub(crate) type SessionWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

/// Map of session_id -> all attached writers (broadcast to all on output).
pub(crate) type SessionWriters = Arc<Mutex<HashMap<String, Vec<SessionWriter>>>>;
pub(crate) type TerminalEmulatorClients = Arc<Mutex<HashMap<String, HashSet<usize>>>>;

/// Per-session size registry: maps client pointer -> (cols, rows).
/// Used to compute min(cols) x min(rows) across all attached clients.
pub(crate) type SessionSizes = Arc<Mutex<HashMap<String, HashMap<usize, (u16, u16)>>>>;

/// Map of session_id -> list of passive observer writers.
/// Observers receive Output/Exit events but don't join the live terminal writer list.
pub(crate) type SessionObservers =
    Arc<Mutex<HashMap<String, Vec<Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>>>>>;
pub(crate) type LostHandoffSessions = Arc<Mutex<HashMap<String, String>>>;

pub(crate) fn effective_terminal_size(
    client_sizes: &HashMap<usize, (u16, u16)>,
    fallback: (u16, u16),
) -> (u16, u16) {
    let min_cols = client_sizes
        .values()
        .map(|(cols, _)| *cols)
        .min()
        .unwrap_or(fallback.0);
    let min_rows = client_sizes
        .values()
        .map(|(_, rows)| *rows)
        .min()
        .unwrap_or(fallback.1);
    (min_cols, min_rows)
}

pub(crate) async fn replay_current_status(
    writer: &SessionWriter,
    session_id: &str,
    status: SessionStatus,
) {
    let event = Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
        waiting_prompt_snippet: None,
    };
    let _ = write_event(&mut *writer.lock().await, &event).await;
}

async fn register_terminal_emulator_client(
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    writer: &SessionWriter,
) {
    let writer_id = Arc::as_ptr(writer) as usize;
    let mut terminal_clients = terminal_emulator_clients.lock().await;
    let client_ids = terminal_clients.entry(session_id.to_string()).or_default();
    client_ids.insert(writer_id);
}

pub(crate) async fn unregister_terminal_emulator_client(
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    writer: &SessionWriter,
) {
    let writer_id = Arc::as_ptr(writer) as usize;
    let mut terminal_clients = terminal_emulator_clients.lock().await;
    let Some(client_ids) = terminal_clients.get_mut(session_id) else {
        return;
    };
    client_ids.remove(&writer_id);
    let empty = client_ids.is_empty();
    if empty {
        terminal_clients.remove(session_id);
    }
}

pub(crate) async fn cleanup_client_writer_registries(
    writer: &SessionWriter,
    session_writers: &SessionWriters,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_sizes: &SessionSizes,
    session_observers: &SessionObservers,
) {
    let writer_id = Arc::as_ptr(writer) as usize;

    let mut sizes = session_sizes.lock().await;
    for client_sizes in sizes.values_mut() {
        client_sizes.remove(&writer_id);
    }
    sizes.retain(|_, client_sizes| !client_sizes.is_empty());
    drop(sizes);

    let mut terminal_clients = terminal_emulator_clients.lock().await;
    for client_ids in terminal_clients.values_mut() {
        client_ids.remove(&writer_id);
    }
    terminal_clients.retain(|_, client_ids| !client_ids.is_empty());
    drop(terminal_clients);

    let mut writers = session_writers.lock().await;
    for attached_writers in writers.values_mut() {
        attached_writers.retain(|registered| Arc::as_ptr(registered) as usize != writer_id);
    }
    drop(writers);

    let mut observers = session_observers.lock().await;
    for observer_writers in observers.values_mut() {
        observer_writers.retain(|registered| Arc::as_ptr(registered) as usize != writer_id);
    }
    observers.retain(|_, observer_writers| !observer_writers.is_empty());
}

pub(crate) async fn finish_attach_cutover(
    writer: &SessionWriter,
    session_writers: &SessionWriters,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    emulate_terminal: bool,
    initial_event: &Event,
) {
    {
        let mut writers = session_writers.lock().await;
        let mut writer_guard = writer.lock().await;
        writers
            .entry(session_id.to_string())
            .or_default()
            .push(writer.clone());
        drop(writers);

        if emulate_terminal {
            register_terminal_emulator_client(terminal_emulator_clients, session_id, writer).await;
        }

        let _ = write_event(&mut *writer_guard, initial_event).await;
    }
}
