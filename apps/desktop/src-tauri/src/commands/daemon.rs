mod attachment;
mod connection;
mod protocol;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tauri::Emitter;
use tokio::sync::Mutex;

use crate::daemon_client::DaemonClient;

pub use attachment::ActiveAttachedStream;
use attachment::{
    attached_owner_count, register_attached_owner, remove_window_session_size,
    spawn_attached_stream_task, unregister_attached_owner, update_window_session_size,
};
use connection::{
    daemon_socket_path, ensure_connected, negotiate_protected_input, require_option_mut,
    send_command_expect_ack, send_command_expect_session_created,
};
#[allow(unused_imports)]
pub use protocol::TerminalSnapshotPayload;
use protocol::{parse_ack, parse_agent_provider, parse_error_event, parse_snapshot_response};
pub use protocol::{DaemonCommandError, SessionRecoveryStatePayload};

pub type DaemonState = Arc<Mutex<Option<DaemonClient>>>;
pub type AttachedSessions = Arc<Mutex<HashMap<String, HashSet<String>>>>;
pub type ActiveAttachedStreams = Arc<Mutex<HashMap<String, ActiveAttachedStream>>>;
pub type WindowSessionSizes = Arc<Mutex<HashMap<String, HashMap<String, (u16, u16)>>>>;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    cwd: String,
    executable: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    agent_provider: Option<String>,
    operator_input_only: Option<bool>,
) -> Result<(), DaemonCommandError> {
    let agent_provider = parse_agent_provider(agent_provider)?;
    let operator_input_only = operator_input_only.unwrap_or(false);
    if operator_input_only {
        negotiate_protected_input(&state).await?;
    }
    let cmd = serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "cwd": cwd,
        "executable": executable,
        "args": args,
        "env": env,
        "cols": cols,
        "rows": rows,
        "agent_provider": agent_provider,
        "operator_input_only": operator_input_only,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_session_created(&state, &json).await
}

/// Spawn a headless agent session (themed task) in the daemon. The daemon
/// builds the provider command via the kanna-agent-protocol adapters,
/// journals the neutral event stream, and survives app restarts like PTY
/// sessions.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_agent_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    cwd: String,
    env: HashMap<String, String>,
    agent_provider: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    system_prompt: Option<String>,
    mcp_config_path: Option<String>,
    executable: Option<String>,
) -> Result<(), DaemonCommandError> {
    let agent_provider = parse_agent_provider(Some(agent_provider))?;
    let cmd = serde_json::json!({
        "type": "SpawnAgent",
        "session_id": session_id,
        "params": {
            "agent_provider": agent_provider,
            "prompt": prompt,
            "cwd": cwd,
            "env": env,
            "model": model,
            "effort": effort,
            "permission_mode": permission_mode,
            "allowed_tools": allowed_tools.unwrap_or_default(),
            "disallowed_tools": disallowed_tools.unwrap_or_default(),
            "max_turns": max_turns,
            "max_budget_usd": max_budget_usd,
            "system_prompt": system_prompt,
            "mcp_config_path": mcp_config_path.or_else(|| resolve_mcp_config_path(&env, &cwd)),
            "executable": executable,
        },
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_session_created(&state, &json).await
}

fn resolve_mcp_config_path(env: &HashMap<String, String>, cwd: &str) -> Option<String> {
    if let Some(path) = env
        .get("KANNA_MCP_CONFIG")
        .filter(|path| !path.trim().is_empty())
    {
        return Some(path.clone());
    }
    if let Ok(path) = std::env::var("KANNA_MCP_CONFIG") {
        if !path.trim().is_empty() {
            return Some(path);
        }
    }
    let candidate = PathBuf::from(cwd).join(".mcp.json");
    candidate
        .is_file()
        .then(|| candidate.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_session_recovery_state(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<Option<SessionRecoveryStatePayload>, DaemonCommandError> {
    let cmd = serde_json::json!({
        "type": "Snapshot",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = require_option_mut(&mut guard, "daemon client")?;
    client.send_command(&json).await?;
    let response = client.read_event().await?;
    match parse_snapshot_response(&response) {
        Ok(snapshot) => Ok(Some(SessionRecoveryStatePayload {
            serialized: snapshot.vt,
            cols: snapshot.cols,
            rows: snapshot.rows,
            cursor_row: snapshot.cursor_row,
            cursor_col: snapshot.cursor_col,
            cursor_visible: snapshot.cursor_visible,
            saved_at: snapshot.saved_at,
            sequence: snapshot.sequence,
        })),
        Err(message) if message.code.as_deref() == Some("session_not_found") => Ok(None),
        Err(message) => Err(message),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn seed_session_recovery_state(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    serialized: String,
    cols: u16,
    rows: u16,
    cursor_row: u16,
    cursor_col: u16,
    cursor_visible: bool,
) -> Result<(), DaemonCommandError> {
    let cmd = serde_json::json!({
        "type": "SeedSnapshot",
        "session_id": session_id,
        "snapshot": {
            "version": 1,
            "rows": rows,
            "cols": cols,
            "cursor_row": cursor_row,
            "cursor_col": cursor_col,
            "cursor_visible": cursor_visible,
            "vt": serialized,
        },
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_ack(&state, &json).await
}

#[tauri::command]
pub async fn send_input(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    data: Vec<u8>,
    submission_boundary: Option<bool>,
    control_input: Option<bool>,
) -> Result<(), DaemonCommandError> {
    let command_type = if control_input.unwrap_or(false) {
        "InputControl"
    } else if submission_boundary.unwrap_or(false) {
        "InputBoundary"
    } else {
        "Input"
    };
    let cmd = serde_json::json!({
        "type": command_type,
        "session_id": session_id,
        "data": data,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_ack(&state, &json).await
}

pub(crate) async fn authorize_server_process(
    client: &mut DaemonClient,
    pid: u32,
) -> Result<(), DaemonCommandError> {
    let command = serde_json::json!({
        "type": "AuthorizeServer",
        "pid": pid,
    })
    .to_string();
    client.send_command(&command).await?;
    let response = client.read_event().await?;
    parse_ack(&response)
}

#[tauri::command]
pub async fn send_agent_input(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    text: String,
) -> Result<(), DaemonCommandError> {
    let cmd = serde_json::json!({
        "type": "AgentInput",
        "session_id": session_id,
        "text": text,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_ack(&state, &json).await
}

#[tauri::command]
pub async fn resize_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
    window_sizes: tauri::State<'_, WindowSessionSizes>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), DaemonCommandError> {
    let owner_label = window.label().to_string();
    let (cols, rows) = {
        let mut sizes = window_sizes.lock().await;
        update_window_session_size(&mut sizes, &session_id, &owner_label, cols, rows)
            .unwrap_or((cols, rows))
    };
    let cmd = serde_json::json!({
        "type": "Resize",
        "session_id": session_id,
        "cols": cols,
        "rows": rows,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_ack(&state, &json).await
}

#[tauri::command]
pub async fn signal_session(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    signal: String,
) -> Result<(), DaemonCommandError> {
    let cmd = serde_json::json!({
        "type": "Signal",
        "session_id": session_id,
        "signal": signal,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_ack(&state, &json).await
}

#[tauri::command]
pub async fn kill_session(
    state: tauri::State<'_, DaemonState>,
    window_sizes: tauri::State<'_, WindowSessionSizes>,
    session_id: String,
) -> Result<(), DaemonCommandError> {
    let cmd = serde_json::json!({
        "type": "Kill",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    let result = send_command_expect_ack(&state, &json).await;
    if result.is_ok() {
        let mut sizes = window_sizes.lock().await;
        sizes.remove(&session_id);
    }
    result
}

#[tauri::command]
pub async fn list_sessions(
    state: tauri::State<'_, DaemonState>,
) -> Result<Vec<serde_json::Value>, DaemonCommandError> {
    let cmd = serde_json::json!({ "type": "List" });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = require_option_mut(&mut guard, "daemon client")?;
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
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected event: {}", response),
            code: None,
        }),
    }
}

#[tauri::command]
pub async fn attach_session_with_snapshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    attached: tauri::State<'_, AttachedSessions>,
    active_streams: tauri::State<'_, ActiveAttachedStreams>,
    window_sizes: tauri::State<'_, WindowSessionSizes>,
    session_id: String,
) -> Result<(), DaemonCommandError> {
    let owner_label = window.label().to_string();
    let socket_path = daemon_socket_path();
    let mut stream_client = DaemonClient::connect(&socket_path).await?;
    let cmd = serde_json::json!({
        "type": "AttachSnapshot",
        "session_id": session_id,
        "emulate_terminal": true,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    stream_client.send_command(&json).await?;

    let response = stream_client.read_event().await?;
    let snapshot = parse_snapshot_response(&response)?;
    let owner_count = {
        let mut attached_guard = attached.lock().await;
        register_attached_owner(&mut attached_guard, &session_id, &owner_label);
        attached_owner_count(&attached_guard, &session_id)
    };
    eprintln!(
        "[attach] owner_added session={} window={} owners={}",
        session_id, owner_label, owner_count
    );

    if active_streams.lock().await.contains_key(&session_id) {
        eprintln!(
            "[attach] reuse_stream session={} window={} owners={}",
            session_id, owner_label, owner_count
        );
        let payload = serde_json::json!({
            "session_id": &session_id,
            "snapshot": snapshot,
        });
        let _ = window.emit("terminal_snapshot", &payload);
        return Ok(());
    }

    spawn_attached_stream_task(
        app,
        stream_client,
        session_id,
        attached.inner().clone(),
        active_streams.inner().clone(),
        window_sizes.inner().clone(),
        Some(snapshot),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn detach_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
    attached: tauri::State<'_, AttachedSessions>,
    active_streams: tauri::State<'_, ActiveAttachedStreams>,
    window_sizes: tauri::State<'_, WindowSessionSizes>,
    session_id: String,
) -> Result<(), DaemonCommandError> {
    let owner_label = window.label().to_string();
    let remaining_size = {
        let mut sizes = window_sizes.lock().await;
        remove_window_session_size(&mut sizes, &session_id, &owner_label)
    };
    let (should_shutdown, owner_count) = {
        let mut attached_guard = attached.lock().await;
        let should_shutdown =
            unregister_attached_owner(&mut attached_guard, &session_id, &owner_label);
        let owner_count = attached_owner_count(&attached_guard, &session_id);
        (should_shutdown, owner_count)
    };
    eprintln!(
        "[attach] owner_removed session={} window={} owners={} shutdown={}",
        session_id, owner_label, owner_count, should_shutdown
    );
    if should_shutdown {
        if let Some(active_stream) = active_streams.lock().await.remove(&session_id) {
            eprintln!("[attach] shutdown_stream session={}", session_id);
            let _ = active_stream.shutdown.send(());
        }
    } else if let Some((cols, rows)) = remaining_size {
        let cmd = serde_json::json!({
            "type": "Resize",
            "session_id": session_id,
            "cols": cols,
            "rows": rows,
        });
        let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
        ensure_connected(&state).await?;
        let mut guard = state.lock().await;
        let client = require_option_mut(&mut guard, "daemon client")?;
        client.send_command(&json).await?;
        let response = client.read_event().await?;
        parse_ack(&response)?;
    }
    Ok(())
}

#[cfg(test)]
mod server_authorization_tests {
    use super::authorize_server_process;
    use crate::daemon_client::DaemonClient;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn native_desktop_hands_exact_server_pid_to_daemon() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-authorize-server-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(b"{\"type\":\"Ok\"}\n").await.unwrap();
            serde_json::from_str::<serde_json::Value>(&line).unwrap()
        });

        let mut client = DaemonClient::connect(&socket).await.unwrap();
        authorize_server_process(&mut client, 42).await.unwrap();

        let command = server.await.unwrap();
        assert_eq!(command["type"], "AuthorizeServer");
        assert_eq!(command["pid"], 42);
        let _ = std::fs::remove_dir_all(dir);
    }
}
