use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::db::Db;
pub(crate) use crate::task_input_queue::TaskInputError;
use crate::task_input_queue::{validate_task_input, TaskInputSource};
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use kanna_daemon::protocol::{
    Command as DaemonCommand, Event as DaemonEvent, SessionKind, SessionState,
};
use std::sync::Arc;

pub(crate) const SESSION_INTERRUPTION_FEEDBACK: &str =
    "session ended without a recorded stage verdict";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskInputRequest {
    input: String,
    #[serde(default)]
    source: TaskInputSource,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskInputFailure {
    ok: bool,
    reason: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_run: Option<TaskInputFailureRun>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskInputFailureRun {
    id: String,
    status: String,
    finished_at: Option<String>,
}

pub(super) type TaskInputHttpError = (axum::http::StatusCode, Json<TaskInputFailure>);

fn task_input_http_error(
    status: axum::http::StatusCode,
    reason: &'static str,
    message: String,
    latest_run: Option<TaskInputFailureRun>,
) -> TaskInputHttpError {
    (
        status,
        Json(TaskInputFailure {
            ok: false,
            reason,
            message,
            latest_run,
        }),
    )
}

fn map_task_input_error((status, message): (axum::http::StatusCode, String)) -> TaskInputHttpError {
    let reason = if status == axum::http::StatusCode::NOT_FOUND {
        "task_not_found"
    } else {
        "task_input_unavailable"
    };
    task_input_http_error(status, reason, message, None)
}

/// Submit input through the server-owned per-session queue, reporting a typed
/// error so post dispatch can fall back only on a definite missing session.
pub(crate) async fn try_submit_task_input(
    coordinator: &crate::task_input_queue::TaskInputCoordinator,
    task_id: &str,
    session_id: &str,
    source: TaskInputSource,
    input: &str,
) -> Result<(), TaskInputError> {
    coordinator
        .submit_message(task_id, session_id, source, input)
        .await
}

/// Submit ordinary input to a task session and map delivery failures to HTTP.
pub(crate) async fn submit_task_input(
    state: &AppState,
    task_id: &str,
    session_id: &str,
    source: TaskInputSource,
    input: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    try_submit_task_input(&state.task_input, task_id, session_id, source, input)
        .await
        .map_err(|error| match error {
            TaskInputError::SessionNotFound => (
                axum::http::StatusCode::NOT_FOUND,
                format!("session not found: {}", session_id),
            ),
            TaskInputError::Other(message) => {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message)
            }
            TaskInputError::Uncertain(message) => (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                format!("terminal input delivery is uncertain: {message}"),
            ),
        })
}

pub(super) async fn send_task_input(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<TaskInputRequest>,
) -> Result<axum::http::StatusCode, TaskInputHttpError> {
    validate_task_input(payload.source, &payload.input).map_err(|message| {
        task_input_http_error(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_task_input",
            message,
            None,
        )
    })?;
    #[cfg(test)]
    if let Some(task_input_sender) = state.task_input_sender.clone() {
        return task_input_sender(task_id, payload.input, payload.source)
            .map(|_| axum::http::StatusCode::NO_CONTENT)
            .map_err(|message| {
                task_input_http_error(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "task_input_unavailable",
                    message,
                    None,
                )
            });
    }

    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id)
        .await
        .map_err(map_task_input_error)?;
    let Some(_task_input) = state.try_begin_requested_task_input(&task_id) else {
        return Err(task_input_http_error(
            axum::http::StatusCode::CONFLICT,
            "no_live_agent_session",
            format!(
                "task {task_id} is changing stage or agent session; input was not delivered; inspect the current run before retrying"
            ),
            None,
        ));
    };
    let route_epoch = state.task_input.route_epoch(&task_id);
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|error| {
            task_input_http_error(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "daemon_unavailable",
                format!("could not verify a live agent session for task {task_id}: {error}"),
                None,
            )
        })?;

    let sessions = match daemon.send_command(&DaemonCommand::List).await {
        Ok(DaemonEvent::SessionList { sessions }) => sessions,
        Ok(other) => {
            return Err(task_input_http_error(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "daemon_state_unknown",
                format!(
                    "could not verify a live agent session for task {task_id}: unexpected daemon response: {other:?}"
                ),
                None,
            ));
        }
        Err(error) => {
            return Err(task_input_http_error(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "daemon_state_unknown",
                format!("could not verify a live agent session for task {task_id}: {error}"),
                None,
            ));
        }
    };
    let live_session = sessions
        .iter()
        .find(|session| {
            session.session_id == task_id
                && session.kind == SessionKind::Pty
                && matches!(&session.state, SessionState::Active)
        })
        .map(|session| (session.pid, session.status));
    let Some((live_session_pid, live_session_status)) = live_session else {
        let db_path = state.config.db_path.clone();
        let latest_run_task_id = task_id.clone();
        let latest_run =
            super::blocking::run_handler_blocking("task input latest run", move || {
                let db = Db::open(&db_path).map_err(|error| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("db error: {error}"),
                    )
                })?;
                db.latest_stage_run(&latest_run_task_id).map_err(|error| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("db error: {error}"),
                    )
                })
            })
            .await
            .map_err(map_task_input_error)?;
        let latest_run = latest_run.map(|run| TaskInputFailureRun {
            id: run.id,
            status: run.status,
            finished_at: run.finished_at,
        });
        let detail = match latest_run.as_ref() {
            Some(run) => match run.finished_at.as_deref() {
                Some(finished_at) => format!(
                    "latest run {} finished at {finished_at} with status {}",
                    run.id, run.status
                ),
                None => format!(
                    "latest run {} has status {} and no recorded finish time",
                    run.id, run.status
                ),
            },
            None => "the task has no recorded stage run".to_string(),
        };
        return Err(task_input_http_error(
            axum::http::StatusCode::CONFLICT,
            "no_live_agent_session",
            format!(
                "no live agent session for task {task_id}; {detail}; use kanna_resume_task to \
                 preserve provider context when possible, or kanna_rerun_stage to start fresh"
            ),
            latest_run,
        ));
    };

    if payload.source == TaskInputSource::QuickAction
        && live_session_status == kanna_daemon::protocol::SessionStatus::Waiting
    {
        return Err(task_input_http_error(
            axum::http::StatusCode::CONFLICT,
            "quick_action_awaiting_reply",
            "quick actions cannot submit while the agent is awaiting an operator reply".to_string(),
            None,
        ));
    }

    state
        .task_input
        .submit_message_if_session_at_route_epoch(
            &task_id,
            &task_id,
            live_session_pid,
            payload.source,
            &payload.input,
            route_epoch,
        )
        .await
        .map_err(|error| {
            let (status, reason, message) = match error {
                TaskInputError::SessionNotFound => (
                    axum::http::StatusCode::CONFLICT,
                    "no_live_agent_session",
                    format!(
                        "the live agent session changed before input could be delivered to task {task_id}; retry only after inspecting the current run"
                    ),
                ),
                TaskInputError::Uncertain(message) => (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "delivery_uncertain",
                    format!("terminal input delivery is uncertain: {message}"),
                ),
                TaskInputError::Other(message) => (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "task_input_failed",
                    message,
                ),
            };
            task_input_http_error(status, reason, message, None)
        })?;

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
    /// The task advanced past its final workflow stage — a normal completion.
    WorkflowCompleted,
    /// The task was closed directly (sidebar ⇧⌘⌫ or `POST /v1/tasks/{id}/close`)
    /// without finishing its workflow.
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
    /// The task ran to a clean end: it reached the end of its workflow, or its
    /// session ended with no failing verdict against it.
    Success,
    /// The task's terminating run reported failure, or its agent process died.
    Failure,
    /// The task was closed before finishing its workflow. Not a failure — no
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
/// the PTY exited, and a task that reached the end of its workflow behind a
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
    // A Claude session that exited because it could not resume its transcript
    // never ran the stage at all. Relaunching it fresh happens before any of
    // the bookkeeping below, so the dead attempt cannot finalize the run or
    // fire a completion notification against work that has not been done.
    match super::resume_recovery::recover_rejected_claude_resume(state, task_id, exit_code).await {
        super::resume_recovery::RejectedResumeRecovery::Relaunched => return Ok(()),
        super::resume_recovery::RejectedResumeRecovery::RelaunchFailed(error) => {
            log::warn!(
                "fresh relaunch after a rejected claude resume failed for {task_id}: {error}; \
                 reporting the original failure"
            );
        }
        super::resume_recovery::RejectedResumeRecovery::NotApplicable => {}
    }
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
    let notification_state = state.clone();
    tokio::spawn(async move {
        notify_task_completion_best_effort(
            &notification_state,
            &pipeline_item_id,
            TaskCompletionTrigger::AgentSessionExit { exit_code },
        )
        .await;
    });
    Ok(())
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

/// Deliver a completion notification after the task's terminal state change
/// has already committed.
///
/// A notify target whose own session has since died is a routine outcome
/// (orchestrators can finish before their children do). The task state must
/// not be reported as failed after its durable mutation landed. Log and
/// continue.
pub(super) async fn notify_task_completion_best_effort(
    state: &AppState,
    child_id: &str,
    trigger: TaskCompletionTrigger,
) {
    if let Err(error) = notify_task_completion(state, child_id, trigger).await {
        log::warn!("failed to deliver completion notification for task {child_id}: {error}");
    }
}

pub(crate) async fn notify_task_completion(
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
    let message = format!(
        "TASK {} DONE [{}]: {}",
        notification.child_id,
        status.as_str(),
        notification.title
    );
    state
        .task_input
        .submit_message(
            &notification.notify_task_id,
            &notification.notify_task_id,
            TaskInputSource::CompletionNotification,
            &message,
        )
        .await
        .map_err(|error| match error {
            TaskInputError::SessionNotFound => {
                format!("session not found: {}", notification.notify_task_id)
            }
            TaskInputError::Other(message) | TaskInputError::Uncertain(message) => message,
        })
}
