use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::db::{Db, TaskInputSource};
use crate::task_input_attachments::{
    compose_input_with_attachment, discard_stored_attachment, store_task_input_attachment,
    TaskInputAttachment,
};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
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
    /// Who is speaking, declared by the caller: `operator` or `manager`.
    /// Omitted means `unspecified`, which is what desktop, mobile, and CLI
    /// deliveries record. The server cannot verify the claim — it only records
    /// it beside the message it can verify was delivered.
    #[serde(default)]
    source: Option<String>,
    /// One image the caller attached. Carried as base64 in the same JSON body
    /// the text arrives in, because that body is the only shape both mobile
    /// transports share: the relay tunnels a desktop invocation as JSON, and
    /// the LAN client posts the same JSON to the same route. One encoding
    /// means one handler and one durable record, and the payload is capped
    /// small enough that multipart would buy nothing.
    #[serde(default)]
    attachment: Option<TaskInputAttachment>,
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
    ///
    /// This is a lost round trip, never a message the daemon decided to hold:
    /// a live session always writes what it is given.
    Uncertain(String),
}

/// Write one semantic logical message into a daemon session.
///
/// The daemon types the text and its submission boundary as one write. It does
/// not consult the composer, so there is no held, parked, or refused answer to
/// map here: the message reaches the PTY, the session is gone, or the round
/// trip was lost.
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
) -> Result<Response, TaskInputHttpError> {
    #[cfg(test)]
    if let Some(task_input_sender) = state.task_input_sender.clone() {
        return task_input_sender(task_id, payload.input)
            .map(|_| axum::http::StatusCode::NO_CONTENT.into_response())
            .map_err(|message| {
                task_input_http_error(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "task_input_unavailable",
                    message,
                    None,
                )
            });
    }

    let source = match payload.source.as_deref() {
        Some(declared) => TaskInputSource::from_caller_declared(declared).map_err(|message| {
            task_input_http_error(
                axum::http::StatusCode::BAD_REQUEST,
                "invalid_input_source",
                message,
                None,
            )
        })?,
        None => TaskInputSource::Unspecified,
    };
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

    // Stored only once a live session is known: a file written for an input
    // that was never going to be delivered is a leak with no message to name
    // it. If the submission below fails the file is discarded again. The write
    // itself goes to the blocking pool with the rest of the handler's
    // filesystem work — megabytes of decode and disk on a runtime worker would
    // stall every KSP terminal stream the same runtime carries.
    let stored_attachment = match payload.attachment.clone() {
        Some(attachment) => {
            let db_path = state.config.db_path.clone();
            let attachment_task_id = task_id.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    store_task_input_attachment(&db_path, &attachment_task_id, &attachment)
                })
                .await
                .map_err(|error| {
                    task_input_http_error(
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "attachment_write_failed",
                        format!("task input attachment worker failed: {error}"),
                        None,
                    )
                })?
                .map_err(|error| {
                    task_input_http_error(error.status(), error.reason(), error.message(), None)
                })?,
            )
        }
        None => None,
    };
    // What the agent actually receives, and — because an attachment is a file
    // path the agent reads — what the durable record must say. There is no
    // separate attachment column: the record's contract is the text that
    // entered the session, and that text names the path.
    let delivered_input = match stored_attachment.as_ref() {
        Some(path) => compose_input_with_attachment(&payload.input, &path.to_string_lossy()),
        None => payload.input.clone(),
    };

    let delivered =
        try_submit_task_input_if_session(&mut daemon, &task_id, live_session_pid, &delivered_input)
            .await;
    if let Err(error) = &delivered {
        // Whether the file outlives a failed submission is decided by one
        // question: can the message naming it still reach the agent? An
        // `Uncertain` round trip may already have put the path in front of it,
        // so the file stays. Every other failure means the message is gone for
        // good, and a file no surviving message names is a leak.
        let message_may_still_arrive = matches!(error, TaskInputError::Uncertain(_));
        if let (Some(path), false) = (stored_attachment.as_ref(), message_may_still_arrive) {
            discard_stored_attachment(path);
        }
    }

    delivered.map_err(|error| {
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

    // Recorded only now, because the daemon has answered that these bytes
    // reached the PTY. An uncertain delivery is deliberately not recorded: a
    // row claiming text reached the agent when it may not have is a worse
    // record than a missing one.
    let db_path = state.config.db_path.clone();
    let record_task_id = task_id.clone();
    let record_message = task_input_message(&delivered_input).to_string();
    let recorded = tokio::task::spawn_blocking(move || {
        let db = Db::open(&db_path)?;
        db.record_task_input(&record_task_id, source, &record_message)
    })
    .await;
    match recorded {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            log::error!("task input reached task {task_id}, but its durable record failed: {error}")
        }
        Err(error) => {
            log::error!("task input reached task {task_id}, but the record worker failed: {error}")
        }
    }
    state.publish_state_changed(StateChangeScope::Tasks);

    Ok(axum::http::StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn handle_task_terminal_state(
    state: &AppState,
    task_id: &str,
    exit_code: i32,
) -> Result<(), String> {
    // A Claude session that exited because it could not resume its transcript
    // never ran the stage at all. Relaunching it fresh happens before any of
    // the bookkeeping below, so the dead attempt cannot finalize the run
    // against work that has not been done.
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
    let summary = format!(
        "agent session exited before recording a stage verdict (exit code {exit_code}); \
         use kanna_resume_task to recover provider context"
    );
    // Keep the agent-facing three-word completion vocabulary on the durable
    // run/event surfaces after removing PTY completion messages. The database
    // run status remains its established succeeded/failed/cancelled enum.
    let result = serde_json::json!({
        "status": if exit_code == 0 { "success" } else { "failure" },
        "summary": summary,
    })
    .to_string();
    if mark_task_session_interrupted(&state.config.db_path, task_id, interrupted_status, &result)?
        .is_none()
    {
        return Ok(());
    }
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(())
}

pub(crate) fn mark_task_session_interrupted(
    db_path: &str,
    task_or_session_id: &str,
    status: &str,
    reason: &str,
) -> Result<Option<String>, String> {
    mark_task_session_interrupted_inner(db_path, task_or_session_id, status, reason, true)
}

/// Finish a run whose daemon session was proven absent immediately before a
/// provider-aware replacement is prepared. This keeps the durable
/// `run.finished` boundary without briefly advertising the task as awaiting a
/// manual stage advance between the dead run and its recovery run.
pub(crate) fn mark_task_session_interrupted_for_recovery(
    db_path: &str,
    task_or_session_id: &str,
    status: &str,
    reason: &str,
) -> Result<Option<String>, String> {
    mark_task_session_interrupted_inner(db_path, task_or_session_id, status, reason, false)
}

fn mark_task_session_interrupted_inner(
    db_path: &str,
    task_or_session_id: &str,
    status: &str,
    reason: &str,
    emit_awaiting_advance: bool,
) -> Result<Option<String>, String> {
    let latest_run_summary = serde_json::from_str::<serde_json::Value>(reason)
        .ok()
        .and_then(|result| result.get("summary")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| reason.to_string());
    let db = Db::open(db_path).map_err(|error| format!("db error: {error}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(task_or_session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(None);
    };
    db.with_immediate_transaction(|db| {
        db.update_pipeline_item_activity(&task_id, "unread")?;
        // The runtime dimension's terminal value. The daemon only classifies
        // live sessions, so without this the last live verdict — usually
        // `busy` — would outlive the process that earned it.
        db.update_pipeline_item_runtime_status(&task_id, "exited", None)?;
        let finished = db.finish_latest_running_stage_run(
            &task_id,
            status,
            Some(reason),
            Some(SESSION_INTERRUPTION_FEEDBACK),
        )?;
        if emit_awaiting_advance
            && finished.as_ref().is_some_and(|run| {
                run.kind == "main" && run.completion_transition.as_deref() == Some("manual")
            })
        {
            db.append_task_event(
                &task_id,
                crate::db::TaskEventKind::AwaitingAdvance,
                serde_json::json!({
                    "runtimeState": "exited",
                    "latestRunStatus": status,
                    "latestRunSummary": latest_run_summary,
                }),
            )?;
        }
        Ok::<_, rusqlite::Error>(())
    })
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
