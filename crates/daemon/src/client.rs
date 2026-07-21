use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::fanout::SessionFanouts;

/// A single client's writer handle.
pub(crate) type SessionWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

pub(crate) type TerminalEmulatorClients = Arc<Mutex<HashMap<String, HashSet<usize>>>>;

/// Per-session size registry: maps client pointer -> (cols, rows).
/// Used to compute min(cols) x min(rows) across all attached clients.
pub(crate) type SessionSizes = Arc<Mutex<HashMap<String, HashMap<usize, (u16, u16)>>>>;

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

pub(crate) async fn register_terminal_emulator_client(
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
    fanouts: &SessionFanouts,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_sizes: &SessionSizes,
) -> Vec<(String, u16, u16)> {
    let writer_id = Arc::as_ptr(writer) as usize;

    let mut sizes = session_sizes.lock().await;
    let mut remaining_sizes = Vec::new();
    for (session_id, client_sizes) in sizes.iter_mut() {
        let removed = client_sizes.remove(&writer_id).is_some();
        if removed && !client_sizes.is_empty() {
            let (cols, rows) = effective_terminal_size(client_sizes, (80, 24));
            remaining_sizes.push((session_id.clone(), cols, rows));
        }
    }
    sizes.retain(|_, client_sizes| !client_sizes.is_empty());
    drop(sizes);

    let mut terminal_clients = terminal_emulator_clients.lock().await;
    for client_ids in terminal_clients.values_mut() {
        client_ids.remove(&writer_id);
    }
    terminal_clients.retain(|_, client_ids| !client_ids.is_empty());
    drop(terminal_clients);

    let session_fanouts: Vec<Arc<crate::fanout::SessionFanout>> =
        fanouts.lock().await.values().cloned().collect();
    for fanout in session_fanouts {
        fanout
            .state
            .lock()
            .await
            .remove_writer_everywhere(writer_id);
    }

    remaining_sizes
}
