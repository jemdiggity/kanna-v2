use crate::relay_client::{PendingRequests, RelayMessage, RelaySink};
use futures_util::SinkExt;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;
use tokio_tungstenite::tungstenite::Message;

/// Monotonically increasing request ID for correlating invoke/response pairs.
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Send an invoke message over the relay WebSocket and wait for the response.
///
/// Each call:
/// 1. Allocates a unique request ID.
/// 2. Registers a oneshot channel in the pending requests map.
/// 3. Serializes and sends `{"type":"invoke","id":N,"command":"...","args":{}}`.
/// 4. Awaits the oneshot receiver — the reader task will route the matching
///    response to this channel.
async fn invoke_remote(
    relay: &RelaySink,
    pending: &PendingRequests,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();

    // Register the pending request before sending (avoid race with reader)
    pending.lock().await.insert(id, tx);

    // Build the invoke message
    let msg = RelayMessage::Invoke {
        id,
        command: command.to_string(),
        args,
    };
    let msg_json =
        serde_json::to_string(&msg).map_err(|e| format!("Failed to serialize invoke: {}", e))?;

    // Send over WebSocket
    {
        let mut sink_guard = relay.lock().await;
        let sink = sink_guard
            .as_mut()
            .ok_or_else(|| "Not connected to relay".to_string())?;
        sink.send(Message::Text(msg_json.into()))
            .await
            .map_err(|e| {
                // Clean up the pending request on send failure
                let _ = pending.try_lock().map(|mut map| map.remove(&id));
                format!("Failed to send invoke: {}", e)
            })?;
    }

    // Wait for the response from the reader task
    rx.await.map_err(|_| "Request cancelled (relay disconnected)".to_string())?
}

// ---------------------------------------------------------------------------
// Tauri commands — each proxies through invoke_remote to the desktop relay
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_pipeline_items(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    repo_id: String,
) -> Result<serde_json::Value, String> {
    invoke_remote(&relay, &pending, "list_pipeline_items", json!({ "repo_id": repo_id })).await
}

#[tauri::command]
pub async fn get_pipeline_item(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    id: String,
) -> Result<serde_json::Value, String> {
    invoke_remote(&relay, &pending, "get_pipeline_item", json!({ "id": id })).await
}

#[tauri::command]
pub async fn list_sessions(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
) -> Result<serde_json::Value, String> {
    invoke_remote(&relay, &pending, "list_sessions", json!({})).await
}

#[tauri::command]
pub async fn attach_session(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    invoke_remote(&relay, &pending, "attach_session", json!({ "session_id": session_id })).await
}

#[tauri::command]
pub async fn detach_session(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    invoke_remote(&relay, &pending, "detach_session", json!({ "session_id": session_id })).await
}

#[tauri::command]
pub async fn send_input(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    session_id: String,
    data: Vec<u8>,
) -> Result<serde_json::Value, String> {
    // Convert byte array to string for the relay protocol
    let data_str = String::from_utf8_lossy(&data).to_string();
    invoke_remote(
        &relay,
        &pending,
        "send_input",
        json!({ "session_id": session_id, "data": data_str }),
    )
    .await
}

#[tauri::command]
pub async fn resize_session(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<serde_json::Value, String> {
    invoke_remote(
        &relay,
        &pending,
        "resize_session",
        json!({ "session_id": session_id, "cols": cols, "rows": rows }),
    )
    .await
}

#[tauri::command]
pub async fn db_select(
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    query: String,
    bind_values: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    invoke_remote(
        &relay,
        &pending,
        "db_select",
        json!({ "query": query, "bind_values": bind_values }),
    )
    .await
}

#[tauri::command]
pub async fn connect_relay(
    app: tauri::AppHandle,
    relay: State<'_, RelaySink>,
    pending: State<'_, PendingRequests>,
    relay_url: String,
    id_token: String,
) -> Result<(), String> {
    crate::relay_client::connect(&app, &relay, &pending, &relay_url, &id_token).await
}
