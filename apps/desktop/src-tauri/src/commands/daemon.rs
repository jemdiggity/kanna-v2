use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::daemon_client::DaemonClient;

pub type DaemonState = Arc<Mutex<Option<DaemonClient>>>;
pub type AttachedSessions = Arc<Mutex<HashMap<String, HashSet<String>>>>;
pub type ActiveAttachedStreams = Arc<Mutex<HashMap<String, ActiveAttachedStream>>>;
pub type WindowSessionSizes = Arc<Mutex<HashMap<String, HashMap<String, (u16, u16)>>>>;

pub struct ActiveAttachedStream {
    attach_id: u64,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DaemonCommandError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl From<String> for DaemonCommandError {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TerminalSnapshotPayload {
    pub version: u32,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    #[serde(default = "default_cursor_visible")]
    pub cursor_visible: bool,
    #[serde(default = "default_saved_at")]
    pub saved_at: u64,
    #[serde(default = "default_sequence")]
    pub sequence: u64,
    pub vt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionRecoveryStatePayload {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(rename = "cursorRow")]
    pub cursor_row: u16,
    #[serde(rename = "cursorCol")]
    pub cursor_col: u16,
    #[serde(rename = "cursorVisible")]
    pub cursor_visible: bool,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
    pub sequence: u64,
}

fn default_cursor_visible() -> bool {
    true
}

fn default_saved_at() -> u64 {
    0
}

fn default_sequence() -> u64 {
    0
}

static NEXT_ATTACH_ID: AtomicU64 = AtomicU64::new(1);
const UNEXPECTED_ACK_EVENT_CODE: &str = "unexpected_ack_event";

fn register_attached_owner(
    attached: &mut HashMap<String, HashSet<String>>,
    session_id: &str,
    owner_label: &str,
) {
    attached
        .entry(session_id.to_string())
        .or_default()
        .insert(owner_label.to_string());
}

fn unregister_attached_owner(
    attached: &mut HashMap<String, HashSet<String>>,
    session_id: &str,
    owner_label: &str,
) -> bool {
    let Some(owners) = attached.get_mut(session_id) else {
        return true;
    };

    owners.remove(owner_label);
    if owners.is_empty() {
        attached.remove(session_id);
        true
    } else {
        false
    }
}

fn clear_attached_owners(attached: &mut HashMap<String, HashSet<String>>, session_id: &str) {
    attached.remove(session_id);
}

fn attached_owner_count(attached: &HashMap<String, HashSet<String>>, session_id: &str) -> usize {
    attached
        .get(session_id)
        .map(HashSet::len)
        .unwrap_or_default()
}

fn effective_window_session_size(window_sizes: &HashMap<String, (u16, u16)>) -> Option<(u16, u16)> {
    let cols = window_sizes.values().map(|(cols, _)| *cols).min()?;
    let rows = window_sizes.values().map(|(_, rows)| *rows).min()?;
    Some((cols, rows))
}

fn update_window_session_size(
    sizes: &mut HashMap<String, HashMap<String, (u16, u16)>>,
    session_id: &str,
    owner_label: &str,
    cols: u16,
    rows: u16,
) -> Option<(u16, u16)> {
    let window_sizes = sizes.entry(session_id.to_string()).or_default();
    window_sizes.insert(owner_label.to_string(), (cols, rows));
    effective_window_session_size(window_sizes)
}

fn remove_window_session_size(
    sizes: &mut HashMap<String, HashMap<String, (u16, u16)>>,
    session_id: &str,
    owner_label: &str,
) -> Option<(u16, u16)> {
    let window_sizes = sizes.get_mut(session_id)?;
    window_sizes.remove(owner_label);
    let effective_size = effective_window_session_size(window_sizes);
    if effective_size.is_none() {
        sizes.remove(session_id);
    }
    effective_size
}

/// Read the Ok/Error ack while already holding the lock.
fn parse_error_event(event: &serde_json::Value) -> DaemonCommandError {
    DaemonCommandError {
        message: event
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("daemon error")
            .to_string(),
        code: event
            .get("code")
            .and_then(|c| c.as_str())
            .map(std::string::ToString::to_string),
    }
}

fn parse_ack(response: &str) -> Result<(), DaemonCommandError> {
    let event: serde_json::Value = serde_json::from_str(response).unwrap_or_default();
    match event.get("type").and_then(|t| t.as_str()) {
        Some("Ok") => Ok(()),
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected ack event: {}", response),
            code: Some(UNEXPECTED_ACK_EVENT_CODE.to_string()),
        }),
    }
}

fn is_retryable_command_error(error: &DaemonCommandError) -> bool {
    error.message.starts_with("failed to write command:")
        || error.message.starts_with("failed to flush command:")
        || error
            .message
            .starts_with("failed to connect to daemon socket:")
        || error.message == "daemon client unavailable"
}

fn should_clear_daemon_client_after_error(error: &DaemonCommandError) -> bool {
    error.code.as_deref() == Some(UNEXPECTED_ACK_EVENT_CODE)
        || is_retryable_command_error(error)
        || error.message.starts_with("failed to read event:")
        || error.message == "connection closed by daemon"
}

async fn clear_daemon_client(state: &DaemonState) {
    *state.lock().await = None;
}

async fn send_command_expect_ack_once(
    state: &DaemonState,
    json: &str,
) -> Result<(), DaemonCommandError> {
    ensure_connected(state).await?;
    let mut guard = state.lock().await;
    let client = require_option_mut(&mut guard, "daemon client")?;
    client.send_command(json).await?;
    let response = client.read_event().await?;
    parse_ack(&response)
}

async fn clear_client_and_return_error(
    state: &DaemonState,
    error: DaemonCommandError,
) -> Result<(), DaemonCommandError> {
    if should_clear_daemon_client_after_error(&error) {
        clear_daemon_client(state).await;
    }
    Err(error)
}

async fn send_command_expect_ack(
    state: &DaemonState,
    json: &str,
) -> Result<(), DaemonCommandError> {
    match send_command_expect_ack_once(state, json).await {
        Ok(()) => Ok(()),
        Err(error) if is_retryable_command_error(&error) => {
            clear_daemon_client(state).await;
            match send_command_expect_ack_once(state, json).await {
                Ok(()) => Ok(()),
                Err(retry_error) => clear_client_and_return_error(state, retry_error).await,
            }
        }
        Err(error) => clear_client_and_return_error(state, error).await,
    }
}

fn parse_agent_provider(
    agent_provider: Option<String>,
) -> Result<Option<String>, DaemonCommandError> {
    match agent_provider.as_deref() {
        Some("claude") | Some("copilot") | Some("codex") | Some("opencode") => Ok(agent_provider),
        Some(other) => Err(DaemonCommandError {
            message: format!("unsupported agent provider: {other}"),
            code: None,
        }),
        None => Ok(None),
    }
}

fn parse_snapshot_response(response: &str) -> Result<TerminalSnapshotPayload, DaemonCommandError> {
    let event: serde_json::Value =
        serde_json::from_str(response).map_err(|e| DaemonCommandError {
            message: format!("failed to parse event: {}", e),
            code: None,
        })?;

    match event.get("type").and_then(|t| t.as_str()) {
        Some("Snapshot") => {
            serde_json::from_value(event.get("snapshot").cloned().ok_or_else(|| {
                DaemonCommandError {
                    message: "snapshot response missing payload".to_string(),
                    code: None,
                }
            })?)
            .map_err(|e| DaemonCommandError {
                message: format!("failed to parse snapshot payload: {}", e),
                code: None,
            })
        }
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected event: {}", response),
            code: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        attached_owner_count, clear_attached_owners, is_retryable_command_error, parse_ack,
        parse_snapshot_response, register_attached_owner, remove_window_session_size,
        require_option_mut, should_clear_daemon_client_after_error, unregister_attached_owner,
        update_window_session_size, TerminalSnapshotPayload, UNEXPECTED_ACK_EVENT_CODE,
    };
    use std::collections::HashMap;

    #[test]
    fn parse_snapshot_response_defaults_cursor_visible_for_older_payloads() {
        let response = r#"{
            "type":"Snapshot",
            "session_id":"sess-1",
            "snapshot":{
                "version":1,
                "rows":24,
                "cols":80,
                "cursor_row":10,
                "cursor_col":5,
                "vt":"hello"
            }
        }"#;

        let snapshot = parse_snapshot_response(response).expect("snapshot should parse");

        assert_eq!(
            snapshot,
            TerminalSnapshotPayload {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 10,
                cursor_col: 5,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
                vt: "hello".to_string(),
            }
        );
    }

    #[test]
    fn parse_snapshot_response_preserves_recovery_metadata_when_present() {
        let response = r#"{
            "type":"Snapshot",
            "session_id":"sess-1",
            "snapshot":{
                "version":1,
                "rows":24,
                "cols":80,
                "cursor_row":10,
                "cursor_col":5,
                "cursor_visible":false,
                "saved_at":123,
                "sequence":7,
                "vt":"hello"
            }
        }"#;

        let snapshot = parse_snapshot_response(response).expect("snapshot should parse");
        assert_eq!(snapshot.saved_at, 123);
        assert_eq!(snapshot.sequence, 7);
    }

    #[test]
    fn parse_ack_rejects_unexpected_events() {
        let response = r#"{"type":"Output","session_id":"sess-1","data":[65]}"#;

        let error = parse_ack(response).expect_err("output is not a command ack");

        assert_eq!(
            error.message,
            r#"unexpected ack event: {"type":"Output","session_id":"sess-1","data":[65]}"#
        );
        assert_eq!(error.code.as_deref(), Some(UNEXPECTED_ACK_EVENT_CODE));
        assert!(!is_retryable_command_error(&error));
        assert!(should_clear_daemon_client_after_error(&error));
    }

    #[test]
    fn read_failures_are_not_retried_because_command_may_have_run() {
        let error = super::DaemonCommandError {
            message: "failed to read event: reset by peer".to_string(),
            code: None,
        };

        assert!(!is_retryable_command_error(&error));
        assert!(should_clear_daemon_client_after_error(&error));
    }

    #[test]
    fn stale_write_failures_are_retried_after_reconnect() {
        let error = super::DaemonCommandError {
            message: "failed to write command: Broken pipe (os error 32)".to_string(),
            code: None,
        };

        assert!(is_retryable_command_error(&error));
        assert!(should_clear_daemon_client_after_error(&error));
    }

    #[test]
    fn require_option_mut_returns_error_when_missing() {
        let mut value: Option<u8> = None;
        let error = require_option_mut(&mut value, "daemon client")
            .expect_err("missing option should return an error");
        assert_eq!(error, "daemon client unavailable");
    }

    #[test]
    fn detaching_one_window_keeps_shared_session_attached_for_other_windows() {
        let mut attached = HashMap::new();
        register_attached_owner(&mut attached, "task-1", "main");
        register_attached_owner(&mut attached, "task-1", "window-2");

        assert!(!unregister_attached_owner(&mut attached, "task-1", "main"));
        assert_eq!(attached["task-1"].len(), 1);
        assert!(attached["task-1"].contains("window-2"));

        assert!(unregister_attached_owner(
            &mut attached,
            "task-1",
            "window-2"
        ));
        assert!(!attached.contains_key("task-1"));
    }

    #[test]
    fn clearing_a_session_removes_all_window_owners_after_exit() {
        let mut attached = HashMap::new();
        register_attached_owner(&mut attached, "task-1", "main");
        register_attached_owner(&mut attached, "task-1", "window-2");

        clear_attached_owners(&mut attached, "task-1");

        assert!(attached.is_empty());
    }

    #[test]
    fn attached_owner_count_reports_current_window_owners() {
        let mut attached = HashMap::new();
        register_attached_owner(&mut attached, "task-1", "main");
        register_attached_owner(&mut attached, "task-1", "window-2");

        assert_eq!(attached_owner_count(&attached, "task-1"), 2);
        assert_eq!(attached_owner_count(&attached, "missing-task"), 0);
    }

    #[test]
    fn session_size_registry_aggregates_by_window_and_recomputes_on_detach() {
        let mut sizes = HashMap::new();

        assert_eq!(
            update_window_session_size(&mut sizes, "task-1", "main", 120, 40),
            Some((120, 40))
        );
        assert_eq!(
            update_window_session_size(&mut sizes, "task-1", "window-2", 100, 50),
            Some((100, 40))
        );
        assert_eq!(
            update_window_session_size(&mut sizes, "task-1", "main", 90, 30),
            Some((90, 30))
        );
        assert_eq!(
            remove_window_session_size(&mut sizes, "task-1", "main"),
            Some((100, 50))
        );
        assert_eq!(
            remove_window_session_size(&mut sizes, "task-1", "window-2"),
            None
        );
        assert!(!sizes.contains_key("task-1"));
    }
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

async fn spawn_attached_stream_task(
    app: tauri::AppHandle,
    stream_client: DaemonClient,
    session_id: String,
    attached: AttachedSessions,
    active_streams: ActiveAttachedStreams,
    window_sizes: WindowSessionSizes,
    initial_snapshot: Option<TerminalSnapshotPayload>,
) {
    let attach_id = NEXT_ATTACH_ID.fetch_add(1, Ordering::Relaxed);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    if let Some(previous) = active_streams.lock().await.insert(
        session_id.clone(),
        ActiveAttachedStream {
            attach_id,
            shutdown: shutdown_tx,
        },
    ) {
        let _ = previous.shutdown.send(());
    }

    let sid = session_id.clone();
    let app = app.clone();
    let attached_clone = attached.clone();
    let active_streams_clone = active_streams.clone();
    let window_sizes_clone = window_sizes.clone();
    tauri::async_runtime::spawn(async move {
        let mut exited_normally = false;
        let mut detached_intentionally = false;
        let mut output_event_count: usize = 0;
        let mut stream_client = stream_client;

        if let Some(snapshot) = initial_snapshot {
            let payload = serde_json::json!({
                "session_id": &sid,
                "snapshot": snapshot,
            });
            let _ = app.emit("terminal_snapshot", &payload);
        }

        loop {
            let line = tokio::select! {
                _ = &mut shutdown_rx => {
                    detached_intentionally = true;
                    if let Ok(cmd) = serde_json::to_string(&serde_json::json!({
                        "type": "Detach",
                        "session_id": &sid,
                    })) {
                        let _ = stream_client.send_command(&cmd).await;
                        if let Ok(response) = stream_client.read_event().await {
                            let _ = parse_ack(&response);
                        }
                    }
                    break;
                }
                line = stream_client.read_event() => match line {
                    Ok(line) => line,
                    Err(_) => break,
                }
            };
            let event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match event.get("type").and_then(|t| t.as_str()) {
                Some("Output") => {
                    output_event_count += 1;
                    if output_event_count <= 5 {
                        let byte_len = event
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|d| d.len())
                            .unwrap_or(0);
                        eprintln!(
                            "[attach] output session={} chunk={} bytes={}",
                            sid, output_event_count, byte_len
                        );
                    }
                    // Terminal bytes are delivered through kanna-server KSP
                    // term_output frames. This legacy stream task remains only
                    // for lifecycle forwarding until the command is fully retired.
                }
                Some("Exit") => {
                    {
                        let mut attached_guard = attached_clone.lock().await;
                        clear_attached_owners(&mut attached_guard, &sid);
                    }
                    {
                        let mut sizes_guard = window_sizes_clone.lock().await;
                        sizes_guard.remove(&sid);
                    }
                    eprintln!("[attach] exit event session={}", sid);
                    let _ = app.emit("session_exit", &event);
                    exited_normally = true;
                    break;
                }
                Some("StatusChanged") => {
                    let _ = app.emit("status_changed", &event);
                }
                _ => {}
            }
        }
        let removed = active_streams_clone.lock().await.remove(&sid);
        let replaced_by_newer_stream = removed
            .as_ref()
            .is_some_and(|stream| stream.attach_id != attach_id);
        if replaced_by_newer_stream {
            if let Some(stream) = removed {
                active_streams_clone
                    .lock()
                    .await
                    .insert(sid.clone(), stream);
            }
        } else {
            {
                let mut attached_guard = attached_clone.lock().await;
                clear_attached_owners(&mut attached_guard, &sid);
            }
            {
                let mut sizes_guard = window_sizes_clone.lock().await;
                sizes_guard.remove(&sid);
            }
        }
        if !replaced_by_newer_stream && !exited_normally && !detached_intentionally {
            let payload = serde_json::json!({
                "session_id": &sid,
            });
            let _ = app.emit("session_stream_lost", &payload);
            eprintln!("[attach] emitted session_stream_lost session={}", sid);
        }
        eprintln!("[attach] output stream ended for session {}", sid);
    });
}

fn require_option_mut<'a, T>(value: &'a mut Option<T>, context: &str) -> Result<&'a mut T, String> {
    value
        .as_mut()
        .ok_or_else(|| format!("{context} unavailable"))
}

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
) -> Result<(), DaemonCommandError> {
    let agent_provider = parse_agent_provider(agent_provider)?;
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
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = require_option_mut(&mut guard, "daemon client")?;
    client.send_command(&json).await?;

    // Read response — expect SessionCreated or Error
    let response = client.read_event().await?;
    let event: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| format!("bad response: {}", e))?;
    match event.get("type").and_then(|t| t.as_str()) {
        Some("SessionCreated") => Ok(()),
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected spawn response: {}", response),
            code: None,
        }),
    }
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
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    system_prompt: Option<String>,
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
            "permission_mode": permission_mode,
            "allowed_tools": allowed_tools.unwrap_or_default(),
            "disallowed_tools": disallowed_tools.unwrap_or_default(),
            "max_turns": max_turns,
            "max_budget_usd": max_budget_usd,
            "system_prompt": system_prompt,
            "executable": executable,
        },
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = require_option_mut(&mut guard, "daemon client")?;
    client.send_command(&json).await?;

    let response = client.read_event().await?;
    let event: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| format!("bad response: {}", e))?;
    match event.get("type").and_then(|t| t.as_str()) {
        Some("SessionCreated") => Ok(()),
        Some("Error") => Err(parse_error_event(&event)),
        _ => Err(DaemonCommandError {
            message: format!("unexpected spawn response: {}", response),
            code: None,
        }),
    }
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
) -> Result<(), DaemonCommandError> {
    let cmd = serde_json::json!({
        "type": "Input",
        "session_id": session_id,
        "data": data,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    send_command_expect_ack(&state, &json).await
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
