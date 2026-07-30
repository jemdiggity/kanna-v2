use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::sync::Arc;

pub(crate) const SESSION_INTERRUPTION_FEEDBACK: &str =
    "session ended without a recorded stage verdict";

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
/// carriage return as two acknowledged Input commands separated by a short
/// pause makes the CR register as a discrete Enter keystroke — exactly how a
/// human types then presses Enter. The daemon acknowledges Input only after it
/// reaches the PTY, so this delay cannot begin while the message is still
/// queued. 150ms was validated against the live Claude CLI.
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
pub(crate) enum TaskInputError {
    SessionNotFound,
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
            TaskInputError::Other(message) => {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message)
            }
        })
}

pub(super) async fn send_task_input(
    _access: PrivilegedTaskAccess,
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

/// What ended a task, as known by the caller that fires its completion
/// notification.
///
/// Daemon `Exit` alone cannot tell these apart — the agent erroring, the task
/// advancing past its final stage, and a human closing the task from the
/// sidebar all end the same PTY the same way — so the trigger is passed in and
/// the reported status is derived from it together with the task's own
/// terminating run.
#[derive(Debug, Clone, Copy)]
pub(crate) enum TaskCompletionTrigger {
    /// The task's agent session ended on its own: an unkilled daemon `Exit`.
    AgentSessionExit { exit_code: i32 },
    /// The task advanced past its final pipeline stage — a normal completion.
    PipelineCompleted,
    /// The task was closed directly (sidebar ⇧⌘⌫ or `POST /v1/tasks/{id}/close`)
    /// without finishing its pipeline.
    DirectClose,
}

/// The status word in `TASK <id> DONE [<status>]: <title>`.
///
/// Three states, not two. An orchestrating agent acts on this payload without
/// re-reading task state — that is the whole point of `notify_task_id` — so
/// "a human cancelled this" must not read the same as "the work failed", and
/// neither may read the same as a clean finish. The vocabulary is closed:
/// receivers match these three words exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskCompletionStatus {
    /// The task ran to a clean end: it reached the end of its pipeline, or its
    /// session ended with no failing verdict against it.
    Success,
    /// The task's terminating run reported failure, or its agent process died.
    Failure,
    /// The task was closed before finishing its pipeline. Not a failure — no
    /// verdict was reached at all.
    Closed,
}

impl TaskCompletionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Closed => "closed",
        }
    }
}

/// Derive the reported status from the task's real outcome.
///
/// A direct close reached no verdict, so it reports `closed` whatever state the
/// task was in. Otherwise the terminating `stage_run` decides: an agent that
/// reported failure and then let its session end is a failure however cleanly
/// the PTY exited, and a task that reached the end of its pipeline behind a
/// succeeded run is a success even though closing it killed the session.
fn derive_task_completion_status(
    db: &Db,
    task_id: &str,
    trigger: TaskCompletionTrigger,
) -> Result<TaskCompletionStatus, String> {
    match trigger {
        TaskCompletionTrigger::DirectClose => return Ok(TaskCompletionStatus::Closed),
        // A dead agent process is a failure regardless of any recorded verdict:
        // the run it was executing never finished.
        TaskCompletionTrigger::AgentSessionExit { exit_code } if exit_code != 0 => {
            return Ok(TaskCompletionStatus::Failure)
        }
        _ => {}
    }
    let status = db
        .latest_finished_stage_run_status(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    Ok(match status.as_deref() {
        Some("failed") => TaskCompletionStatus::Failure,
        _ => TaskCompletionStatus::Success,
    })
}

pub(crate) async fn handle_task_terminal_state(
    state: &AppState,
    task_id: &str,
    exit_code: i32,
) -> Result<(), String> {
    let interrupted_status = if exit_code == 0 {
        "cancelled"
    } else {
        "failed"
    };
    let result = format!(
        "agent session exited before recording a stage verdict (exit code {exit_code}); \
         use kanna_resume_task to recover provider context"
    );
    let Some(pipeline_item_id) =
        mark_task_session_interrupted(&state.config.db_path, task_id, interrupted_status, &result)?
    else {
        return Ok(());
    };
    state.publish_state_changed(StateChangeScope::Tasks);
    notify_task_completion(
        state,
        &pipeline_item_id,
        TaskCompletionTrigger::AgentSessionExit { exit_code },
    )
    .await
}

pub(crate) fn mark_task_session_interrupted(
    db_path: &str,
    task_or_session_id: &str,
    status: &str,
    reason: &str,
) -> Result<Option<String>, String> {
    let db = Db::open(db_path).map_err(|error| format!("db error: {error}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(task_or_session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(None);
    };
    db.update_pipeline_item_activity(&task_id, "unread")
        .map_err(|error| format!("db error: {error}"))?;
    db.finish_latest_running_stage_run(
        &task_id,
        status,
        Some(reason),
        Some(SESSION_INTERRUPTION_FEEDBACK),
    )
    .map_err(|error| format!("db error: {error}"))?;
    Ok(Some(task_id))
}

pub(crate) fn restore_task_run_for_live_session(
    db_path: &str,
    task_or_session_id: &str,
) -> Result<bool, String> {
    let db = Db::open(db_path).map_err(|error| format!("db error: {error}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(task_or_session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(false);
    };
    db.restore_latest_interrupted_stage_run(&task_id, SESSION_INTERRUPTION_FEEDBACK)
        .map_err(|error| format!("db error: {error}"))
}

pub(super) async fn notify_task_completion(
    state: &AppState,
    child_id: &str,
    trigger: TaskCompletionTrigger,
) -> Result<(), String> {
    let (notification, status) = {
        let config = state.config();
        let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
        // Derive before claiming: the claim is one-shot, so a failure to read
        // the outcome must not burn the notification on a wrong status.
        let status = derive_task_completion_status(&db, child_id, trigger)?;
        let notification = db
            .claim_task_notification(child_id)
            .map_err(|e| format!("db error: {}", e))?;
        (notification, status)
    };
    let Some(notification) = notification else {
        return Ok(());
    };
    state.publish_state_changed(StateChangeScope::Tasks);
    let config = state.config();
    let message = format!(
        "TASK {} DONE [{}]: {}",
        notification.child_id,
        status.as_str(),
        notification.title
    );
    let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    submit_task_input(&mut daemon, &notification.notify_task_id, &message)
        .await
        .map_err(|(_, message)| message)
}
