use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

use crate::daemon_client::DaemonClient;

pub type DaemonState = Arc<Mutex<Option<DaemonClient>>>;
pub type AttachedSessions = Arc<Mutex<HashSet<String>>>;

const CLAUDE_SPINNERS: &[char] = &['✻', '✽', '✶', '✳', '✢', '⏺'];
const SCAN_BUFFER_CAP: usize = 4096;
const SCAN_FLUSH_MS: u64 = 150;
// Claude's status bar marker (⏵, U+23F5). Present in every status bar redraw.
const STATUS_BAR_MARKER: char = '⏵';
// Text shown in status bar ONLY while Claude is actively processing.
// Stripped of ANSI, spaces become empty (cursor movement codes removed).
const CLAUDE_WORKING_INDICATOR: &str = "esctointerrupt";

#[derive(Clone, Debug, PartialEq)]
enum AgentProvider {
    Claude,
    Copilot,
}

#[derive(Clone, Debug, PartialEq)]
enum AgentState {
    Idle,
    Working,
}

struct SessionScanState {
    buffer: String,
    last_data_at: Instant,
    state: AgentState,
    provider: AgentProvider,
}

impl SessionScanState {
    fn new(provider: AgentProvider) -> Self {
        Self {
            buffer: String::new(),
            last_data_at: Instant::now(),
            state: AgentState::Idle,
            provider,
        }
    }

    fn append(&mut self, text: &str) {
        self.buffer.push_str(text);
        self.last_data_at = Instant::now();
        if self.buffer.len() > SCAN_BUFFER_CAP {
            let mut drain_to = self.buffer.len() - SCAN_BUFFER_CAP;
            // Advance to the next char boundary to avoid panicking on multi-byte
            // UTF-8 chars (spinners ✻✽✶, emoji 🍌, box-drawing, etc.)
            while drain_to < self.buffer.len() && !self.buffer.is_char_boundary(drain_to) {
                drain_to += 1;
            }
            self.buffer.drain(..drain_to);
        }
    }

    /// Called on each fragment. Returns events to emit.
    ///
    /// Claude detection uses two deterministic signals:
    /// - Spinner chars (✻✽✶✳✢⏺) → Working (immediate)
    /// - Status bar frame (⏵) without "esctointerrupt" → Idle (deterministic)
    fn on_fragment(&mut self, text: &str) -> Vec<&'static str> {
        let mut events = Vec::new();

        match self.provider {
            AgentProvider::Claude => {
                let has_status_bar = text.contains(STATUS_BAR_MARKER);

                if has_status_bar {
                    // Status bar frame: check for working indicator
                    if text.contains(CLAUDE_WORKING_INDICATOR) {
                        if self.state != AgentState::Working {
                            self.state = AgentState::Working;
                            events.push("ClaudeWorking");
                        }
                    } else if self.state != AgentState::Idle {
                        // Status bar without "esc to interrupt" → turn is done
                        self.state = AgentState::Idle;
                        events.push("ClaudeIdle");
                    }
                } else if text.chars().any(|c| CLAUDE_SPINNERS.contains(&c)) {
                    // Small spinner fragment (no status bar) → working
                    if self.state != AgentState::Working {
                        self.state = AgentState::Working;
                        events.push("ClaudeWorking");
                    }
                }

                if text.contains("Do you want to allow") {
                    events.push("WaitingForInput");
                }
            }
            AgentProvider::Copilot => {
                if text.contains("Thinking") {
                    if self.state != AgentState::Working {
                        self.state = AgentState::Working;
                    }
                    events.push("CopilotThinking");
                }
                let has_idle_prompt = text.contains('\u{276F}');
                if has_idle_prompt && !text.contains("Thinking") {
                    if self.state != AgentState::Idle {
                        self.state = AgentState::Idle;
                    }
                    events.push("CopilotIdle");
                }
                if text.contains("Operation cancelled") {
                    events.push("Interrupted");
                }
            }
        }

        // Shared text pattern checks
        if text.contains("Interrupted") {
            self.state = AgentState::Idle;
            events.push("Interrupted");
        }

        events
    }

    /// Called by the timer. Just clears stale buffer data.
    /// State transitions are handled deterministically in on_fragment.
    fn check_idle(&mut self) -> Vec<&'static str> {
        self.buffer.clear();
        Vec::new()
    }
}

/// Read the Ok/Error ack while already holding the lock.
fn parse_ack(response: &str) -> Result<(), String> {
    let event: serde_json::Value = serde_json::from_str(response).unwrap_or_default();
    if let Some("Error") = event.get("type").and_then(|t| t.as_str()) {
        let msg = event
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("daemon error");
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
            let msg = event
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
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
    let mut guard = state.lock().await;
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;
    let response = client.read_event().await?;
    parse_ack(&response)
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
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;
    let response = client.read_event().await?;
    parse_ack(&response)
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

pub async fn attach_session_inner(
    app: &tauri::AppHandle,
    session_id: String,
    attached: &AttachedSessions,
    agent_provider: Option<String>,
) -> Result<(), String> {
    // Create a dedicated connection for this session's output streaming.
    // This avoids mixing Output events with command responses.
    let socket_path = daemon_socket_path();
    let mut stream_client = DaemonClient::connect(&socket_path).await?;

    // Send Attach command
    let cmd = serde_json::json!({ "type": "Attach", "session_id": session_id });
    stream_client
        .send_command(&serde_json::to_string(&cmd).unwrap())
        .await?;

    // Read the Ok/Error response
    let response = stream_client.read_event().await?;
    let event: serde_json::Value = serde_json::from_str(&response).map_err(|e| e.to_string())?;
    if let Some("Error") = event.get("type").and_then(|t| t.as_str()) {
        let msg = event
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("attach failed");
        return Err(msg.to_string());
    }

    // Track this session as attached
    attached.lock().await.insert(session_id.clone());

    // Determine the agent provider for pattern matching
    let provider = match agent_provider.as_deref() {
        Some("copilot") => AgentProvider::Copilot,
        _ => AgentProvider::Claude,
    };

    // Spawn a background task to read Output/Exit events and emit Tauri events
    let sid = session_id.clone();
    let app = app.clone();
    let attached_clone = attached.clone();
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let scan_state = std::sync::Arc::new(tokio::sync::Mutex::new(SessionScanState::new(provider)));

        // Spawn a flush timer task
        let scan_state_timer = scan_state.clone();
        let app_timer = app.clone();
        let sid_timer = sid.clone();
        let flush_handle = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(SCAN_FLUSH_MS)).await;
                let mut state = scan_state_timer.lock().await;
                if state.buffer.is_empty() {
                    continue;
                }
                if state.last_data_at.elapsed() >= std::time::Duration::from_millis(SCAN_FLUSH_MS) {
                    let events = state.check_idle();
                    for event_name in events {
                        let hook = serde_json::json!({
                            "session_id": &sid_timer,
                            "event": event_name,
                        });
                        let _ = app_timer.emit("hook_event", &hook);
                    }
                }
            }
        });

        // On Err (connection lost / daemon restart) we intentionally do NOT
        // remove from attached so the re-attach coordinator can re-attach.
        while let Ok(line) = stream_client.read_event().await {
            let event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match event.get("type").and_then(|t| t.as_str()) {
                Some("Output") => {
                    // Convert data array to base64 string for efficient transfer
                    // The raw number array can be large and slow to serialize
                    if let Some(data) = event.get("data").and_then(|d| d.as_array()) {
                        let bytes: Vec<u8> = data
                            .iter()
                            .filter_map(|v| v.as_u64().map(|n| n as u8))
                            .collect();
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let payload = serde_json::json!({
                            "session_id": event.get("session_id"),
                            "data_b64": b64,
                        });
                        let _ = app.emit("terminal_output", &payload);

                        // Strip ANSI escape sequences to get clean text for pattern matching.
                        // Copilot's TUI uses per-character color codes (shimmer effect),
                        // so raw byte matching (e.g. b"Thinking") won't work.
                        let stripped = {
                            let mut out = Vec::with_capacity(bytes.len());
                            let mut i = 0;
                            while i < bytes.len() {
                                if bytes[i] == 0x1b {
                                    i += 1;
                                    if i < bytes.len() && bytes[i] == b'[' {
                                        i += 1;
                                        while i < bytes.len()
                                            && !(bytes[i] >= 0x40 && bytes[i] <= 0x7e)
                                        {
                                            i += 1;
                                        }
                                        if i < bytes.len() {
                                            i += 1;
                                        }
                                    } else if i < bytes.len() && bytes[i] == b']' {
                                        i += 1;
                                        while i < bytes.len()
                                            && bytes[i] != 0x07
                                            && bytes[i] != 0x1b
                                        {
                                            i += 1;
                                        }
                                        if i < bytes.len() {
                                            i += 1;
                                        }
                                        if i < bytes.len() && bytes[i] == b'\\' {
                                            i += 1;
                                        }
                                    } else {
                                        if i < bytes.len() {
                                            i += 1;
                                        }
                                    }
                                } else if bytes[i] >= 0x20 || bytes[i] == b'\n' {
                                    out.push(bytes[i]);
                                    i += 1;
                                } else {
                                    i += 1;
                                }
                            }
                            out
                        };
                        let text = String::from_utf8_lossy(&stripped);
                        let text = text.trim();

                        if !text.is_empty() {
                            eprintln!("[pty-scan] sid={} {:?}", sid, text);

                            let mut state = scan_state.lock().await;
                            state.append(text);

                            // Check fragment for immediate events (spinner → working,
                            // text patterns like Interrupted/WaitingForInput).
                            // Idle detection is handled by the timer via check_idle().
                            let events = state.on_fragment(text);
                            for event_name in events {
                                let hook = serde_json::json!({
                                    "session_id": event.get("session_id"),
                                    "event": event_name,
                                });
                                let _ = app.emit("hook_event", &hook);
                            }
                        }
                    } else {
                        let _ = app.emit("terminal_output", &event);
                    }
                }
                Some("Exit") => {
                    // Session exited normally — remove from tracked set
                    flush_handle.abort();
                    attached_clone.lock().await.remove(&sid);
                    let _ = app.emit("session_exit", &event);
                    break;
                }
                _ => {}
            }
        }
        eprintln!("[attach] output stream ended for session {}", sid);
    });

    Ok(())
}

#[tauri::command]
pub async fn attach_session(
    app: tauri::AppHandle,
    attached: tauri::State<'_, AttachedSessions>,
    session_id: String,
    agent_provider: Option<String>,
) -> Result<(), String> {
    attach_session_inner(&app, session_id, &attached, agent_provider).await
}

#[tauri::command]
pub async fn detach_session(
    state: tauri::State<'_, DaemonState>,
    attached: tauri::State<'_, AttachedSessions>,
    session_id: String,
) -> Result<(), String> {
    attached.lock().await.remove(&session_id);
    let cmd = serde_json::json!({
        "type": "Detach",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    let client = guard.as_mut().unwrap();
    client.send_command(&json).await?;
    let response = client.read_event().await?;
    parse_ack(&response)
}
