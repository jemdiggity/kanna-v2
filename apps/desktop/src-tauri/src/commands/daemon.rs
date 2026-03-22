use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::daemon_client::DaemonClient;

pub type DaemonState = Arc<Mutex<Option<DaemonClient>>>;

/// Send a command and read the Ok/Error response, discarding it.
async fn send_and_ack(state: &DaemonState) -> Result<(), String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("daemon not connected")?;
    let response = client.read_event().await?;
    let event: serde_json::Value = serde_json::from_str(&response).unwrap_or_default();
    if let Some("Error") = event.get("type").and_then(|t| t.as_str()) {
        let msg = event.get("message").and_then(|m| m.as_str()).unwrap_or("daemon error");
        return Err(msg.to_string());
    }
    Ok(())
}

fn daemon_socket_path() -> PathBuf {
    crate::daemon_socket_path()
}

async fn ensure_connected(state: &DaemonState) -> Result<(), String> {
    let mut guard = state.lock().await;
    if guard.is_none() {
        let socket_path = daemon_socket_path();
        let client = DaemonClient::connect(&socket_path).await?;
        *guard = Some(client);
    }
    Ok(())
}

#[tauri::command]
pub async fn spawn_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    cwd: String,
    executable: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "cwd": cwd,
        "executable": executable,
        "args": args,
        "env": env,
        "cols": cols,
        "rows": rows,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;

    // Read response — expect SessionCreated or Error
    let response = client.read_event().await?;
    let event: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| format!("bad response: {}", e))?;
    match event.get("type").and_then(|t| t.as_str()) {
        Some("SessionCreated") => Ok(()),
        Some("Error") => {
            let msg = event.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
            Err(msg.to_string())
        }
        _ => Err(format!("unexpected spawn response: {}", response)),
    }
}

#[tauri::command]
pub async fn send_input(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Input",
        "session_id": session_id,
        "data": data,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;
    let _ = client.read_event().await; // consume Ok
    Ok(())
}

#[tauri::command]
pub async fn resize_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Resize",
        "session_id": session_id,
        "cols": cols,
        "rows": rows,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;
    let _ = client.read_event().await; // consume Ok
    Ok(())
}

#[tauri::command]
pub async fn signal_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    signal: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Signal",
        "session_id": session_id,
        "signal": signal,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    {
        let mut guard = state.lock().await;
        guard.as_mut().unwrap().send_command(&json).await?;
    }
    send_and_ack(&state).await
}

#[tauri::command]
pub async fn kill_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Kill",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    {
        let mut guard = state.lock().await;
        guard.as_mut().unwrap().send_command(&json).await?;
    }
    send_and_ack(&state).await
}

#[tauri::command]
pub async fn list_sessions(
    state: tauri::State<'_, DaemonState>,
) -> Result<Vec<serde_json::Value>, String> {
    let cmd = serde_json::json!({ "type": "List" });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;
    let response = client.read_event().await?;

    let event: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| format!("failed to parse event: {}", e))?;

    match event.get("type").and_then(|t| t.as_str()) {
        Some("SessionList") => {
            let sessions = event
                .get("sessions")
                .and_then(|s| s.as_array())
                .cloned()
                .unwrap_or_default();
            Ok(sessions)
        }
        Some("Error") => {
            let msg = event
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            Err(msg.to_string())
        }
        _ => Err(format!("unexpected event: {}", response)),
    }
}

#[tauri::command]
pub async fn attach_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    // Create a dedicated connection for this session's output streaming.
    // This avoids mixing Output events with command responses.
    let socket_path = daemon_socket_path();
    let mut stream_client = DaemonClient::connect(&socket_path).await?;

    // Send Attach command
    let cmd = serde_json::json!({ "type": "Attach", "session_id": session_id });
    stream_client.send_command(&serde_json::to_string(&cmd).unwrap()).await?;

    // Read the Ok/Error response
    let response = stream_client.read_event().await?;
    let event: serde_json::Value = serde_json::from_str(&response).map_err(|e| e.to_string())?;
    if let Some("Error") = event.get("type").and_then(|t| t.as_str()) {
        let msg = event.get("message").and_then(|m| m.as_str()).unwrap_or("attach failed");
        return Err(msg.to_string());
    }

    // Spawn a background task to read Output/Exit events and emit Tauri events
    let sid = session_id.clone();
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        loop {
            match stream_client.read_event().await {
                Ok(line) => {
                    let event: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    match event.get("type").and_then(|t| t.as_str()) {
                        Some("Output") => {
                            // Convert data array to base64 string for efficient transfer
                            // The raw number array can be large and slow to serialize
                            if let Some(data) = event.get("data").and_then(|d| d.as_array()) {
                                let bytes: Vec<u8> = data.iter()
                                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                                    .collect();
                                use base64::Engine;
                                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                                let payload = serde_json::json!({
                                    "session_id": event.get("session_id"),
                                    "data_b64": b64,
                                });
                                let _ = app.emit("terminal_output", &payload);
                                // Detect sandbox/permission prompts waiting for user input.
                                // These prompts bypass --dangerously-skip-permissions and no
                                // Claude Code hook fires for them, so we scan PTY output.
                                if bytes.windows(21).any(|w| w == b"Do you want to allow") {
                                    let hook = serde_json::json!({
                                        "session_id": event.get("session_id"),
                                        "event": "WaitingForInput",
                                    });
                                    let _ = app.emit("hook_event", &hook);
                                }
                            } else {
                                let _ = app.emit("terminal_output", &event);
                            }
                        }
                        Some("Exit") => {
                            let _ = app.emit("session_exit", &event);
                            break;
                        }
                        _ => {}
                    }
                }
                Err(_) => break,
            }
        }
        eprintln!("[attach] output stream ended for session {}", sid);
    });

    Ok(())
}

#[tauri::command]
pub async fn detach_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Detach",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    guard.as_mut().unwrap().send_command(&json).await
}
