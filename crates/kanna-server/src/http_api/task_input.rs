use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::db::Db;
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

/// The message portion of a `/v1/tasks/{id}/input` payload: the caller's text
/// with any trailing CR/LF stripped (callers vary — the CLI may append `\r`, the
/// MCP appends nothing). The daemon delivers it as one logical submission.
pub(super) fn task_input_message(input: &str) -> &str {
    input.trim_end_matches(['\r', '\n'])
}

/// A task-input submission failure, distinguishing "the session does not
/// exist" (a post dispatch falls back to spawning a fresh session) from
/// everything else.
pub(crate) enum TaskInputError {
    SessionNotFound,
    Other(String),
    /// Submission may have reached the PTY even though its response was lost.
    /// Retrying this result could duplicate terminal bytes.
    Uncertain(String),
}

/// Queue one semantic logical message in a daemon session. The daemon owns the
/// raw-draft boundary because it is the only process that observes every raw
/// terminal writer and survives frontend/server reconnects.
async fn send_logical_session_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    expected_pid: Option<u32>,
    data: Vec<u8>,
) -> Result<(), TaskInputError> {
    let command = match expected_pid {
        Some(expected_pid) => DaemonCommand::SubmitInputIfSession {
            session_id: session_id.to_string(),
            expected_pid,
            data,
        },
        None => DaemonCommand::SubmitInput {
            session_id: session_id.to_string(),
            data,
        },
    };
    let event = daemon
        .send_command(&command)
        .await
        .map_err(|e| TaskInputError::Uncertain(format!("daemon response lost: {e}")))?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => Err(TaskInputError::SessionNotFound),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionIncarnationMismatch),
            ..
        } => Err(TaskInputError::SessionNotFound),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
            message,
        } => Err(TaskInputError::Uncertain(message)),
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
    try_submit_task_input_to_session(daemon, session_id, None, input).await
}

/// Submit input to the PTY process ID observed during live-session
/// discovery. A same-id replacement is rejected rather than receiving input
/// intended for the old run.
async fn try_submit_task_input_if_session(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    expected_pid: u32,
    input: &str,
) -> Result<(), TaskInputError> {
    try_submit_task_input_to_session(daemon, session_id, Some(expected_pid), input).await
}

async fn try_submit_task_input_to_session(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    expected_pid: Option<u32>,
    input: &str,
) -> Result<(), TaskInputError> {
    // Every logical caller — kanna-cli, kanna-mcp, mobile, and server-side
    // notifications — enters the daemon as one semantic message. It either
    // submits atomically now or waits behind a raw human draft there.
    let message = task_input_message(input);
    send_logical_session_input(
        daemon,
        session_id,
        expected_pid,
        message.as_bytes().to_vec(),
    )
    .await
}

/// Submit ordinary input to a task session and map delivery failures to HTTP.
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
    #[cfg(test)]
    if let Some(task_input_sender) = state.task_input_sender.clone() {
        return task_input_sender(task_id, payload.input)
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
    let Some(_task_mutation) = state.try_begin_requested_task_mutation(&task_id) else {
        return Err(task_input_http_error(
            axum::http::StatusCode::CONFLICT,
            "no_live_agent_session",
            format!(
                "task {task_id} is changing stage or agent session; input was not delivered; inspect the current run before retrying"
            ),
            None,
        ));
    };
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
    let live_session_pid = sessions
        .iter()
        .find(|session| {
            session.session_id == task_id
                && session.kind == SessionKind::Pty
                && matches!(&session.state, SessionState::Active)
        })
        .map(|session| session.pid);
    let Some(live_session_pid) = live_session_pid else {
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

    try_submit_task_input_if_session(&mut daemon, &task_id, live_session_pid, &payload.input)
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
    // The runtime dimension's terminal value. The daemon only classifies live
    // sessions, so without this the last live verdict — usually `busy` —
    // would outlive the process that earned it, and a wait for the task to
    // finish would have nothing but read state to key on.
    db.update_pipeline_item_runtime_status(&task_id, "exited", None)
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

/// Reconcile a task whose daemon session the caller has just proven still
/// alive: reopen the run a terminal-loss path interrupted, and drop the
/// `exited` runtime verdict that path recorded.
///
/// The two are cleared independently on purpose. The return value still means
/// "an interrupted run was reopened" — the resume and requested-id-repair
/// routes branch on it, and a live session with nothing to restore must keep
/// reporting a conflict rather than a restore. But the stale `exited` has to
/// go either way: it says the agent process is gone, `WaitUntil::Finished`
/// resolves on it, and nothing self-heals it, because the daemon only writes a
/// runtime status when a session's classification *changes* and a live session
/// that keeps working emits no such change. The watcher's own restore call
/// pairs with `apply_watcher_runtime_status`, which then writes the live
/// verdict over the cleared value; the HTTP callers have no such pairing.
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
    db.clear_exited_runtime_status(&task_id)
        .map_err(|error| format!("db error: {error}"))?;
    db.restore_latest_interrupted_stage_run(&task_id, SESSION_INTERRUPTION_FEEDBACK)
        .map_err(|error| format!("db error: {error}"))
}

/// Deliver a completion notification for a task whose close has already
/// committed.
///
/// By this point the close is durable: the workflow item is closed, its
/// sessions are gone, and its worktrees are cleaned up. A notify target whose
/// own session has since died is a routine outcome (orchestrators close
/// before their children do), and reporting it as a failed close is worse
/// than losing the message — the caller sees a 500 for a close that landed
/// and either retries it or treats the task as still open. Log and continue.
pub(super) async fn notify_task_completion_best_effort(
    state: &AppState,
    child_id: &str,
    trigger: TaskCompletionTrigger,
) {
    if let Err(error) = notify_task_completion(state, child_id, trigger).await {
        log::warn!("failed to deliver completion notification for closed task {child_id}: {error}");
    }
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
