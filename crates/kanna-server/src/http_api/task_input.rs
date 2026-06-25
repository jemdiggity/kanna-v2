use super::state::AppState;
use crate::config::Config;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskInputRequest {
    input: String,
}

/// Delay between typing a task-input message and the synthesized Enter.
///
/// The agent CLI coalesces a single bulk write (message text plus a trailing
/// carriage return) as a *paste*, where the CR is folded into the buffer as a
/// literal newline and the message is never submitted. Writing the text and the
/// carriage return as two Input commands separated by a short pause makes the CR
/// register as a discrete Enter keystroke — exactly how a human types then
/// presses Enter. 150ms was validated against the live Claude CLI.
const SUBMIT_ENTER_DELAY_MS: u64 = 150;

/// The message portion of a `/v1/tasks/{id}/input` payload: the caller's text
/// with any trailing CR/LF stripped (callers vary — the CLI may append `\r`, the
/// MCP appends nothing). The Enter is synthesized separately by the handler.
pub(super) fn task_input_message(input: &str) -> &str {
    input.trim_end_matches(['\r', '\n'])
}

/// Send one raw Input command to a daemon session, mapping daemon failures to
/// an HTTP error.
async fn send_session_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    data: Vec<u8>,
) -> Result<(), (axum::http::StatusCode, String)> {
    let event = daemon
        .send_command(&DaemonCommand::Input {
            session_id: session_id.to_string(),
            data,
        })
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, message))
        }
        other => Err((
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("unexpected daemon response: {:?}", other),
        )),
    }
}

pub(crate) async fn submit_task_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    input: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    // Type the message, then press Enter as a discrete keystroke (see
    // SUBMIT_ENTER_DELAY_MS). The daemon stays a raw byte pipe; this submission
    // policy lives here so every client — kanna-cli, kanna-mcp, mobile, and
    // server-side notifications — submits consistently.
    let message = task_input_message(input);
    if !message.is_empty() {
        send_session_input(daemon, session_id, message.as_bytes().to_vec()).await?;
        tokio::time::sleep(std::time::Duration::from_millis(SUBMIT_ENTER_DELAY_MS)).await;
    }
    send_session_input(daemon, session_id, vec![b'\r']).await?;
    Ok(())
}

pub(super) async fn send_task_input(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<TaskInputRequest>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(task_input_sender) = state.task_input_sender.clone() {
        return task_input_sender(task_id, payload.input)
            .map(|_| axum::http::StatusCode::NO_CONTENT)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;

    submit_task_input(&mut daemon, &task_id, &payload.input).await?;

    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(crate) async fn handle_task_terminal_state(
    config: &Config,
    task_id: &str,
    success: bool,
) -> Result<(), String> {
    let pipeline_item_id = {
        let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
        let Some(pipeline_item_id) = db
            .resolve_pipeline_item_id(task_id)
            .map_err(|e| format!("db error: {}", e))?
        else {
            return Ok(());
        };
        db.update_pipeline_item_activity(&pipeline_item_id, "unread")
            .map_err(|e| format!("db error: {}", e))?;
        pipeline_item_id
    };
    notify_task_completion(config, &pipeline_item_id, success).await
}

pub(super) async fn notify_task_completion(
    config: &Config,
    child_id: &str,
    success: bool,
) -> Result<(), String> {
    let notification = {
        let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
        db.claim_task_notification(child_id)
            .map_err(|e| format!("db error: {}", e))?
    };
    let Some(notification) = notification else {
        return Ok(());
    };
    let status = if success { "success" } else { "failure" };
    let message = format!(
        "TASK {} DONE [{}]: {}",
        notification.child_id, status, notification.title
    );
    let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    submit_task_input(&mut daemon, &notification.notify_task_id, &message)
        .await
        .map_err(|(_, message)| message)
}
