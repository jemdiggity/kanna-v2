use super::state::AppState;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
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

/// A task-input submission failure, distinguishing "the session does not
/// exist" (a post dispatch falls back to spawning a fresh session) from
/// everything else.
#[derive(Debug)]
pub(crate) enum TaskInputError {
    SessionNotFound,
    DefiniteNonDelivery(String),
    Other(String),
}

/// Send one raw Input command to a daemon session.
async fn send_session_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    data: Vec<u8>,
) -> Result<(), TaskInputError> {
    let event = daemon
        .send_command(&DaemonCommand::Input {
            session_id: session_id.to_string(),
            data,
        })
        .await
        .map_err(|e| TaskInputError::Other(format!("daemon error: {}", e)))?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => Err(TaskInputError::SessionNotFound),
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            Err(TaskInputError::SessionNotFound)
        }
        DaemonEvent::Error { message, .. } => Err(TaskInputError::Other(message)),
        other => Err(TaskInputError::Other(format!(
            "unexpected daemon response: {:?}",
            other
        ))),
    }
}

async fn send_idempotent_submission(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    delivery_id: &str,
    message: Vec<u8>,
) -> Result<(), TaskInputError> {
    let command = DaemonCommand::SubmitInput {
        session_id: session_id.to_string(),
        delivery_id: delivery_id.to_string(),
        message,
        submit_delay_ms: SUBMIT_ENTER_DELAY_MS,
    };
    let event = daemon
        .send_command(&command)
        .await
        .map_err(|error| TaskInputError::Other(format!("daemon error: {error}")))?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => Err(TaskInputError::SessionNotFound),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
            message,
        } => Err(TaskInputError::DefiniteNonDelivery(message)),
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            Err(TaskInputError::SessionNotFound)
        }
        DaemonEvent::Error { message, .. } => Err(TaskInputError::Other(message)),
        other => Err(TaskInputError::Other(format!(
            "unexpected daemon response: {:?}",
            other
        ))),
    }
}

/// Submit one complete message-plus-Enter operation under a stable delivery
/// identity. A transport failure may mean the daemon accepted the operation
/// but lost its acknowledgement, so reconnect once and replay the same
/// identity; the daemon deduplicates it at the live session.
pub(crate) async fn try_submit_task_input_idempotently(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    delivery_id: &str,
    input: &str,
) -> Result<(), TaskInputError> {
    let message = task_input_message(input).as_bytes().to_vec();
    match send_idempotent_submission(daemon, session_id, delivery_id, message.clone()).await {
        Err(TaskInputError::Other(first_error)) => {
            daemon.reconnect().await.map_err(|reconnect_error| {
                TaskInputError::Other(format!(
                    "{first_error}; daemon reconnect failed: {reconnect_error}"
                ))
            })?;
            send_idempotent_submission(daemon, session_id, delivery_id, message)
                .await
                .map_err(|error| {
                    let second_error = match error {
                        TaskInputError::SessionNotFound => "session not found".to_string(),
                        TaskInputError::DefiniteNonDelivery(message)
                        | TaskInputError::Other(message) => message,
                    };
                    // The first peer may already have accepted the
                    // submission, and no answer from a replacement peer can
                    // prove otherwise — a session it cannot find may be one
                    // the first peer already wrote to. Stay indeterminate so
                    // the caller keeps its reservation instead of rolling
                    // back and delivering the same post a second time.
                    TaskInputError::Other(format!(
                        "{first_error}; retry after reconnect did not confirm delivery: \
                         {second_error}"
                    ))
                })
        }
        result => result,
    }
}

/// Submit input to a daemon session, reporting a typed error.
pub(crate) async fn try_submit_task_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    input: &str,
) -> Result<(), TaskInputError> {
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

pub(crate) async fn submit_task_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    input: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    try_submit_task_input(daemon, session_id, input)
        .await
        .map_err(|error| match error {
            TaskInputError::SessionNotFound => (
                axum::http::StatusCode::NOT_FOUND,
                format!("session not found: {}", session_id),
            ),
            TaskInputError::DefiniteNonDelivery(message) | TaskInputError::Other(message) => {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message)
            }
        })
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

    let session_id = Db::open(&state.config.db_path)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .resolve_task_terminal_session_id(&task_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {}", task_id),
            )
        })?;

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;

    submit_task_input(&mut daemon, &session_id, &payload.input).await?;

    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(crate) async fn handle_task_terminal_state(
    state: &AppState,
    task_id: &str,
    success: bool,
) -> Result<(), String> {
    let pipeline_item_id = {
        let db = Db::open(&state.config.db_path).map_err(|e| format!("db error: {}", e))?;
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
    state.publish_state_changed(StateChangeScope::Tasks);
    notify_task_completion(state, &pipeline_item_id, success).await
}

pub(super) async fn notify_task_completion(
    state: &AppState,
    child_id: &str,
    success: bool,
) -> Result<(), String> {
    let (notification, notify_session_id) = {
        let config = state.config();
        let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
        let notification = db
            .claim_task_notification(child_id)
            .map_err(|e| format!("db error: {}", e))?;
        let Some(notification) = notification else {
            return Ok(());
        };
        let notify_session_id = db
            .resolve_task_terminal_session_id(&notification.notify_task_id)
            .map_err(|e| format!("db error: {}", e))?
            .unwrap_or_else(|| notification.notify_task_id.clone());
        (notification, notify_session_id)
    };
    state.publish_state_changed(StateChangeScope::Tasks);
    let config = state.config();
    let status = if success { "success" } else { "failure" };
    let message = format!(
        "TASK {} DONE [{}]: {}",
        notification.child_id, status, notification.title
    );
    let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    submit_task_input(&mut daemon, &notify_session_id, &message)
        .await
        .map_err(|(_, message)| message)
}
