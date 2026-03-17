use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::daemon_client::DaemonClient;

pub type DaemonState = Arc<Mutex<Option<DaemonClient>>>;

fn daemon_socket_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Kanna")
        .join("daemon.sock")
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
    guard.as_mut().unwrap().send_command(&json).await
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
    guard.as_mut().unwrap().send_command(&json).await
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
    guard.as_mut().unwrap().send_command(&json).await
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
    let mut guard = state.lock().await;
    guard.as_mut().unwrap().send_command(&json).await
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
    let mut guard = state.lock().await;
    guard.as_mut().unwrap().send_command(&json).await
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
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "type": "Attach",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    guard.as_mut().unwrap().send_command(&json).await
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
