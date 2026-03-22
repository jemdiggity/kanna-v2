use claude_agent_sdk::{PermissionMode, Session, SessionOptions};
use dashmap::DashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

/// Buffer for agent messages. The drainer task pushes messages here,
/// the frontend polls them via `agent_next_message`.
pub struct BufferedSession {
    buffer: Mutex<Vec<serde_json::Value>>,
    finished: Mutex<bool>,
}

/// Shared state holding all active agent sessions, keyed by session ID.
pub type AgentState = Arc<DashMap<String, BufferedSession>>;

/// Create a new agent session, starting a Claude CLI process.
///
/// Spawns a background drainer task that reads messages from the Claude CLI
/// and pushes them into the session's buffer. The frontend polls the buffer
/// via `agent_next_message`.
#[tauri::command]
pub async fn create_agent_session(
    state: State<'_, AgentState>,
    session_id: String,
    cwd: String,
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
    allowed_tools: Option<Vec<String>>,
    disallowed_tools: Option<Vec<String>>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    permission_mode: Option<String>,
) -> Result<(), String> {
    let mut builder = SessionOptions::builder()
        .cwd(&cwd)
        .permission_mode(parse_permission_mode(permission_mode.as_deref()));

    if let Some(sp) = &system_prompt {
        builder = builder.system_prompt(sp);
    }
    if let Some(m) = &model {
        builder = builder.model(m);
    }
    if let Some(tools) = allowed_tools {
        builder = builder.allowed_tools(tools);
    }
    if let Some(tools) = disallowed_tools {
        builder = builder.disallowed_tools(tools);
    }
    if let Some(mt) = max_turns {
        builder = builder.max_turns(mt);
    }
    if let Some(budget) = max_budget_usd {
        builder = builder.max_budget_usd(budget);
    }

    let session = Session::start(builder.build(), &prompt)
        .await
        .map_err(|e| e.to_string())?;

    // Insert the buffer into state BEFORE spawning the drainer.
    // This guarantees the entry exists when the frontend starts polling.
    state.insert(
        session_id.clone(),
        BufferedSession {
            buffer: Mutex::new(Vec::new()),
            finished: Mutex::new(false),
        },
    );

    // The drainer task owns the Session. It reads messages and pushes them
    // into the DashMap entry's buffer. The Session is NOT stored in the map —
    // this avoids holding a DashMap Ref guard across .await points.
    let state_clone = state.inner().clone();
    let sid = session_id;
    tokio::spawn(async move {
        loop {
            // Read next message from Claude CLI. This blocks until a message
            // arrives or the CLI process exits.
            let msg = session.next_message().await;
            match msg {
                Some(Ok(m)) => {
                    if let Ok(val) = serde_json::to_value(&m) {
                        // Push into buffer — acquire DashMap Ref only briefly
                        if let Some(entry) = state_clone.get(&sid) {
                            entry.buffer.lock().await.push(val);
                        } else {
                            // Entry removed (session closed) — stop draining
                            break;
                        }
                    }
                }
                Some(Err(e)) => {
                    eprintln!("[agent drainer] error for {}: {}", sid, e);
                    if let Some(entry) = state_clone.get(&sid) {
                        *entry.finished.lock().await = true;
                    }
                    break;
                }
                None => {
                    // CLI process exited — mark session finished
                    if let Some(entry) = state_clone.get(&sid) {
                        *entry.finished.lock().await = true;
                    }
                    break;
                }
            }
        }
        // Session dropped here — CLI process cleaned up
    });

    Ok(())
}

/// Poll the next message from an agent session.
///
/// Returns `null` when the session has ended and all buffered messages have been consumed.
#[tauri::command]
pub async fn agent_next_message(
    state: State<'_, AgentState>,
    session_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let entry = state.get(&session_id).ok_or("Session not found")?;

    {
        let mut buf = entry.buffer.lock().await;
        if !buf.is_empty() {
            return Ok(Some(buf.remove(0)));
        }
    }

    if *entry.finished.lock().await {
        return Ok(None);
    }

    // Buffer empty, not finished — wait briefly then check again
    drop(entry);
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let entry = state.get(&session_id).ok_or("Session not found")?;
    let mut buf = entry.buffer.lock().await;
    if !buf.is_empty() {
        return Ok(Some(buf.remove(0)));
    }

    if *entry.finished.lock().await {
        return Ok(None);
    }

    Ok(Some(serde_json::json!({"type": "waiting"})))
}

/// Send a follow-up message to an active agent session.
#[tauri::command]
pub async fn agent_send_message(
    _state: State<'_, AgentState>,
    _session_id: String,
    _message: String,
) -> Result<(), String> {
    Err("Multi-turn send not yet supported".into())
}

/// Interrupt the current agent operation.
#[tauri::command]
pub async fn agent_interrupt(
    _state: State<'_, AgentState>,
    _session_id: String,
) -> Result<(), String> {
    Err("Interrupt not yet supported".into())
}

/// Close an agent session and clean up resources.
#[tauri::command]
pub async fn agent_close_session(
    state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    // Removing from the map signals the drainer to stop (it checks for entry existence)
    state.remove(&session_id);
    Ok(())
}

fn parse_permission_mode(mode: Option<&str>) -> PermissionMode {
    match mode {
        Some("acceptEdits") | Some("accept-edits") => PermissionMode::AcceptEdits,
        Some("default") => PermissionMode::Default,
        _ => PermissionMode::DontAsk,
    }
}
