use super::environment::{resolve_headless_agent_executable, run_workspace_setup_commands};
use super::types::{
    CreatedTask, PreparedPostDispatch, PreparedRunWorkspace, PreparedSessionSpawn,
    PreparedStageRerun, PreparedStageRunSpawn, PreparedTaskSpawn, PreparedWorkspaceTeardown,
};
use super::worktree::remove_prepared_worktree;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, NewStageRun};
use crate::http_api::{try_submit_task_input, TaskInputError};
use crate::session_replacements::SessionReplacements;
use kanna_daemon::protocol::{
    AgentSpawnParams, Command as DaemonCommand, Event as DaemonEvent, TerminalSnapshot,
};

pub(crate) fn prepared_task_id(prepared: &PreparedTaskSpawn) -> &str {
    &prepared.created_task.task_id
}

pub(crate) fn rollback_prepared_task_for_api(
    db: &Db,
    prepared: &PreparedTaskSpawn,
) -> Result<(), String> {
    let task_id = prepared_task_id(prepared);
    let db_result = db
        .delete_task_creation_artifacts(task_id)
        .map_err(|e| format!("db rollback error: {}", e));
    let worktree_result = remove_prepared_worktree(&prepared.cwd, &prepared.branch);

    match (db_result, worktree_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(db_err), Ok(())) => Err(db_err),
        (Ok(()), Err(worktree_err)) => Err(worktree_err),
        (Err(db_err), Err(worktree_err)) => Err(format!("{db_err}; {worktree_err}")),
    }
}

pub(super) async fn spawn_prepared_task(
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<CreatedTask, String> {
    if let Some(snapshot) = prepared.recovery_snapshot.as_ref() {
        seed_recovery_snapshot(daemon, &prepared.session_id, snapshot).await?;
    }
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );

    let event = daemon
        .send_command_retrying_successor(&command)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;

    match event {
        DaemonEvent::SessionCreated { .. } => Ok(prepared.created_task),
        DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
        other => Err(format!("unexpected daemon response: {:?}", other)),
    }
}

async fn seed_recovery_snapshot(
    daemon: &mut DaemonClient,
    session_id: &str,
    snapshot: &crate::mobile_api::CreateTaskRecoverySnapshot,
) -> Result<(), String> {
    let event = daemon
        .send_command(&DaemonCommand::SeedSnapshot {
            session_id: session_id.to_string(),
            snapshot: TerminalSnapshot {
                version: 1,
                rows: snapshot.rows,
                cols: snapshot.cols,
                cursor_row: snapshot.cursor_row,
                cursor_col: snapshot.cursor_col,
                cursor_visible: snapshot.cursor_visible,
                saved_at: snapshot.saved_at,
                sequence: snapshot.sequence,
                vt: snapshot.serialized.clone(),
            },
        })
        .await
        .map_err(|error| format!("daemon recovery seed error: {error}"))?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => Err(format!("daemon recovery seed error: {message}")),
        other => Err(format!(
            "unexpected daemon recovery seed response: {other:?}"
        )),
    }
}

pub(crate) async fn spawn_prepared_task_for_api(
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    let created = spawn_prepared_task(daemon, prepared).await?;
    Ok(crate::mobile_api::CreateTaskResponse {
        task_id: created.task_id,
        repo_id: created.repo_id,
        title: created.title,
        prompt: created.prompt,
        stage: created.stage,
        agent_type: created.agent_type,
        worktree_path: Some(created.worktree_path),
    })
}

pub(crate) async fn spawn_prepared_task_for_api_recording_stage_run(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    spawn_prepared_task_for_api_recording_stage_run_detailed(db_path, daemon, prepared)
        .await
        .map_err(PreparedTaskDeliveryError::into_message)
}

pub(crate) enum PreparedTaskDeliveryError {
    BeforeAcknowledgement(String),
    AfterAcknowledgement(String),
}

impl PreparedTaskDeliveryError {
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::BeforeAcknowledgement(message) | Self::AfterAcknowledgement(message) => message,
        }
    }
}

pub(crate) async fn spawn_prepared_task_for_api_recording_stage_run_detailed(
    db_path: &str,
    daemon: &mut DaemonClient,
    mut prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, PreparedTaskDeliveryError> {
    let run_id = generate_stage_run_id(&prepared.created_task.task_id);
    initialize_completion_context(&mut prepared.env, &run_id)
        .map_err(PreparedTaskDeliveryError::BeforeAcknowledgement)?;
    let created = spawn_prepared_task_for_api(daemon, prepared.clone())
        .await
        .map_err(PreparedTaskDeliveryError::BeforeAcknowledgement)?;
    // Spawn bookkeeping is a synchronous SQLite write; several callers run on
    // the shared runtime, so keep it on the blocking pool.
    let record_db_path = db_path.to_string();
    tokio::task::spawn_blocking(move || {
        record_spawned_stage_run(&record_db_path, &prepared, &run_id)
    })
    .await
    .map_err(|join_error| {
        PreparedTaskDeliveryError::AfterAcknowledgement(format!(
            "stage run record worker failed after daemon acknowledgement: {join_error}"
        ))
    })?
    .map_err(PreparedTaskDeliveryError::AfterAcknowledgement)?;
    Ok(created)
}

pub(crate) async fn spawn_prepared_task_for_api_with_diagnostics(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    match spawn_prepared_task_for_api_recording_stage_run(db_path, daemon, prepared.clone()).await {
        Ok(created) => Ok(created),
        Err(err) => {
            let record_db_path = db_path.to_string();
            let spawn_err = err.clone();
            let task_id = prepared.created_task.task_id.clone();
            tokio::task::spawn_blocking(move || {
                let db = Db::open(&record_db_path).map_err(|open_err| {
                    format!("{spawn_err}; diagnostics failed: db error: {open_err}")
                })?;
                record_prepared_task_spawn_failure(&db, &prepared, &spawn_err)
                    .map_err(|record_err| format!("{spawn_err}; diagnostics failed: {record_err}"))
            })
            .await
            .map_err(|join_error| format!("spawn diagnostics worker failed: {join_error}"))??;
            Err(format!("task {task_id} failed to spawn: {err}"))
        }
    }
}

/// Spawn a new stage run on an existing task: kill the previous stage's
/// agent session and respawn the same daemon session id with the target
/// stage's agent. A stage transition runs in a freshly forked workspace
/// (new branch + worktree from the committed tip) and moves
/// `pipeline_item.branch` with it; a resumed revision moves the branch back
/// to the adopted previous workspace; post fallbacks and reruns keep the
/// task's current workspace. The task id never changes.
pub(crate) async fn spawn_prepared_stage_run_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    mut prepared: PreparedStageRunSpawn,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();
    let run_id = generate_stage_run_id(&task_id);
    initialize_completion_context(&mut prepared.env, &run_id)?;
    let teardown_session_id = prepared
        .workspace_teardown
        .as_ref()
        .map(|teardown| teardown.session_id.clone());

    if let Err(error) = super::finish_deferred_stage_setup(&mut prepared) {
        let error = rollback_prepared_stage_fork(&prepared, error);
        return Err(record_stage_transition_failure(db_path, &prepared, error));
    }

    // A manual advance can leave the previous stage's run open (no explicit
    // agent verdict); moving forward treats that work as accepted. Revision
    // paths mark the previous run failed before preparing the new run. This
    // happens BEFORE the kill so the run record never claims a dead session
    // is still running.
    {
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        db.finish_latest_running_stage_run(&task_id, "succeeded", None, None)
            .map_err(|e| format!("db error: {}", e))?;
    }

    // Only a freshly forked workspace is rolled back on failure; a resumed
    // workspace pre-exists this spawn and must survive it.
    if let Err(error) = kill_session_replacing(daemon, replacements, &session_id).await {
        return Err(rollback_prepared_stage_fork(&prepared, error));
    }
    if !matches!(prepared.workspace, PreparedRunWorkspace::Current) {
        // The prewarmed shell session points at the previous worktree; kill
        // it so the next ⌘J opens in the run's workspace.
        if let Err(error) =
            kill_session_replacing(daemon, replacements, &format!("shell-wt-{task_id}")).await
        {
            return Err(rollback_prepared_stage_fork(&prepared, error));
        }
        if let Some(teardown_session_id) = teardown_session_id.as_deref() {
            if let Err(error) =
                kill_session_replacing(daemon, replacements, teardown_session_id).await
            {
                log::warn!(
                    "failed to replace workspace teardown session {teardown_session_id}: {error}"
                );
            }
        }
    }

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd.clone(),
        prepared.env.clone(),
        prepared.terminal_prelude.clone(),
        prepared.session.clone(),
    );
    let event = match daemon.send_command_retrying_successor(&command).await {
        Ok(event) => event,
        Err(e) => {
            return Err(rollback_prepared_stage_fork(
                &prepared,
                format!("daemon error: {}", e),
            ))
        }
    };
    match event {
        DaemonEvent::SessionCreated { .. } => {}
        DaemonEvent::Error { message, .. } => {
            return Err(rollback_prepared_stage_fork(
                &prepared,
                format!("daemon error: {}", message),
            ))
        }
        other => {
            return Err(rollback_prepared_stage_fork(
                &prepared,
                format!("unexpected daemon response: {:?}", other),
            ))
        }
    }

    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    if db
        .get_pipeline_item(&task_id)
        .map_err(|e| format!("db error: {}", e))?
        .map(|item| item.closed_at.is_some())
        .unwrap_or(true)
    {
        if let Err(error) = kill_session_replacing(daemon, replacements, &session_id).await {
            log::warn!("failed to clean up stale stage session {session_id}: {error}");
        }
        return Err(rollback_prepared_stage_fork(
            &prepared,
            format!("task {task_id} closed before stage transition landed"),
        ));
    }
    match &prepared.workspace {
        PreparedRunWorkspace::Forked(workspace) | PreparedRunWorkspace::Resumed(workspace) => {
            if let Err(error) = db.update_pipeline_item_stage_and_branch(
                &task_id,
                &prepared.next_stage,
                &workspace.branch,
            ) {
                if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                    if let Err(kill_error) =
                        kill_session_replacing(daemon, replacements, &session_id).await
                    {
                        log::warn!(
                            "failed to clean up stale stage session {session_id}: {kill_error}"
                        );
                    }
                    return Err(rollback_prepared_stage_fork(
                        &prepared,
                        format!("task {task_id} closed before stage transition landed"),
                    ));
                }
                return Err(format!("db error: {}", error));
            }
            db.upsert_worktree(
                &format!("wt-{task_id}"),
                &task_id,
                &workspace.worktree_path,
                &workspace.branch,
            )
            .map_err(|e| format!("db error: {}", e))?;
        }
        PreparedRunWorkspace::Current => {
            if let Err(error) = db.update_pipeline_item_stage(&task_id, &prepared.next_stage) {
                if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                    if let Err(kill_error) =
                        kill_session_replacing(daemon, replacements, &session_id).await
                    {
                        log::warn!(
                            "failed to clean up stale stage session {session_id}: {kill_error}"
                        );
                    }
                    return Err(rollback_prepared_stage_fork(
                        &prepared,
                        format!("task {task_id} closed before stage transition landed"),
                    ));
                }
                return Err(format!("db error: {}", error));
            }
        }
    }
    db.update_pipeline_item_activity(&task_id, "working")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(&task_id, prepared.provider_session_id.as_deref())
        .map_err(|e| format!("db error: {}", e))?;
    db.insert_stage_run_with_completion_binding(
        NewStageRun {
            id: &run_id,
            task_id: &task_id,
            stage: &prepared.run_stage,
            kind: prepared.run_kind,
            agent: prepared.stage_agent.as_deref(),
            agent_provider: Some(prepared.agent_provider.as_str()),
            model: prepared.model.as_deref(),
            effort: prepared.effort.as_deref(),
            status: "running",
            result: None,
            feedback: prepared.feedback.as_deref(),
            session_id: Some(&session_id),
            provider_session_id: prepared.provider_session_id.as_deref(),
            cwd: Some(&prepared.cwd),
            resumed_from_run_id: prepared.resumed_from_run_id.as_deref(),
        },
        Some(prepared.completion_transition.as_str()),
        true,
    )
    .map_err(|e| format!("db error: {}", e))?;
    if prepared.run_kind == "post" && prepared.run_stage == "approve" {
        db.record_approval_authorization(&task_id, &run_id)
            .map_err(|e| format!("approval authorization error: {e}"))?;
    }
    if let Some(reason) = prepared.resume_fallback_reason.as_deref() {
        db.set_stage_run_resume_fallback_reason(&run_id, reason)
            .map_err(|e| format!("db error: {}", e))?;
    }

    spawn_prepared_workspace_teardown_best_effort(daemon, prepared.workspace_teardown).await;

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    })
}

fn record_stage_transition_failure(
    db_path: &str,
    prepared: &PreparedStageRunSpawn,
    error: String,
) -> String {
    let record = (|| -> Result<(), String> {
        let db = Db::open(db_path).map_err(|db_error| format!("db error: {db_error}"))?;
        db.update_pipeline_item_activity(&prepared.task_id, "unread")
            .map_err(|db_error| format!("db error: {db_error}"))?;
        let run_id = generate_stage_run_id(&prepared.task_id);
        let result = format!("failed to start stage {}: {error}", prepared.run_stage);
        db.insert_stage_run_with_completion_transition(
            NewStageRun {
                id: &run_id,
                task_id: &prepared.task_id,
                stage: &prepared.run_stage,
                kind: prepared.run_kind,
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                effort: prepared.effort.as_deref(),
                status: "failed",
                result: Some(&result),
                feedback: prepared.feedback.as_deref(),
                session_id: Some(&prepared.session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: None,
                resumed_from_run_id: prepared.resumed_from_run_id.as_deref(),
            },
            Some(prepared.completion_transition.as_str()),
        )
        .map_err(|db_error| format!("db error: {db_error}"))?;
        if let Some(reason) = prepared.resume_fallback_reason.as_deref() {
            db.set_stage_run_resume_fallback_reason(&run_id, reason)
                .map_err(|db_error| format!("db error: {db_error}"))?;
        }
        Ok(())
    })();
    match record {
        Ok(()) => error,
        Err(record_error) => format!("{error}; failed to record stage failure: {record_error}"),
    }
}

fn rollback_prepared_stage_fork(prepared: &PreparedStageRunSpawn, error: String) -> String {
    if let PreparedRunWorkspace::Forked(fork) = &prepared.workspace {
        if let Err(rollback_err) = remove_prepared_worktree(&fork.worktree_path, &fork.branch) {
            return format!("{error}; fork rollback failed: {rollback_err}");
        }
    }
    error
}

pub(crate) async fn spawn_prepared_workspace_teardown_best_effort(
    daemon: &mut DaemonClient,
    prepared: Option<PreparedWorkspaceTeardown>,
) {
    let Some(prepared) = prepared else {
        return;
    };
    let session_id = prepared.session_id.clone();
    let daemon_dir = prepared.daemon_dir.clone();
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );
    match daemon.send_command_retrying_successor(&command).await {
        Ok(DaemonEvent::SessionCreated { .. }) => {
            tokio::spawn(supervise_teardown_session(
                daemon_dir,
                session_id,
                std::time::Duration::from_secs(10 * 60),
                std::time::Duration::from_secs(30 * 60),
            ));
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            log::warn!("workspace teardown session {session_id} failed to start: {message}");
        }
        Ok(other) => {
            log::warn!(
                "workspace teardown session {session_id} returned unexpected daemon response: {other:?}"
            );
        }
        Err(error) => {
            log::warn!("workspace teardown session {session_id} daemon error: {error}");
        }
    }
}

async fn supervise_teardown_session(
    daemon_dir: String,
    session_id: String,
    soft_timeout: std::time::Duration,
    hard_timeout: std::time::Duration,
) {
    tokio::time::sleep(soft_timeout).await;
    match daemon_session_presence(&daemon_dir, &session_id).await {
        DaemonSessionPresence::Absent => return,
        DaemonSessionPresence::Present => {
            log::warn!(
                "workspace teardown session {session_id} exceeded soft threshold of {}s",
                soft_timeout.as_secs()
            );
        }
        DaemonSessionPresence::Unknown => {
            log::warn!(
                "could not determine whether workspace teardown session {session_id} exceeded its \
                 soft threshold; preserving hard-deadline supervision"
            );
        }
    }
    tokio::time::sleep(hard_timeout.saturating_sub(soft_timeout)).await;
    let retry_interval = std::time::Duration::from_secs(1);
    let mut timeout_logged = false;
    loop {
        if daemon_session_presence(&daemon_dir, &session_id).await == DaemonSessionPresence::Absent
        {
            return;
        }
        if !timeout_logged {
            timeout_logged = true;
            log::error!(
                "workspace teardown session {session_id} timed out after {}s; killing process group",
                hard_timeout.as_secs()
            );
        }
        match DaemonClient::connect(&daemon_dir)
            .await
            .map_err(|error| error.to_string())
        {
            Ok(mut daemon) => match daemon
                .send_command(&DaemonCommand::Kill {
                    session_id: session_id.clone(),
                })
                .await
            {
                Ok(DaemonEvent::Ok) => return,
                Ok(other) => {
                    log::warn!(
                        "unexpected daemon response while killing timed-out teardown session \
                         {session_id}: {other:?}"
                    );
                }
                Err(error) => {
                    log::warn!("failed to kill timed-out teardown session {session_id}: {error}");
                }
            },
            Err(error) => {
                log::warn!("failed to reconnect for teardown kill {session_id}: {error}");
            }
        }
        tokio::time::sleep(retry_interval).await;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DaemonSessionPresence {
    Present,
    Absent,
    Unknown,
}

pub(crate) async fn daemon_session_presence(
    daemon_dir: &str,
    session_id: &str,
) -> DaemonSessionPresence {
    let Ok(mut daemon) = DaemonClient::connect(daemon_dir).await else {
        return DaemonSessionPresence::Unknown;
    };
    match daemon.send_command(&DaemonCommand::List).await {
        Ok(DaemonEvent::SessionList { sessions }) => {
            if sessions
                .iter()
                .any(|session| session.session_id == session_id)
            {
                DaemonSessionPresence::Present
            } else {
                DaemonSessionPresence::Absent
            }
        }
        Ok(other) => {
            log::warn!(
                "unexpected daemon response while checking task session {session_id}: {other:?}"
            );
            DaemonSessionPresence::Unknown
        }
        Err(error) => {
            log::warn!("failed to check task session {session_id}: {error}");
            DaemonSessionPresence::Unknown
        }
    }
}

/// Dispatch a stage's post into the task's live agent session; when the
/// session is dead, fall back to spawning the post as a fresh session with
/// the post's agent. Either way the execution is recorded as a `stage_run`
/// with `kind = 'post'` and the task's stage does not change.
pub(crate) async fn dispatch_prepared_post_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    prepared: PreparedPostDispatch,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    match try_submit_task_input(daemon, &prepared.session_id, &prepared.message).await {
        Ok(()) => {
            let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
            // The live session keeps whatever agent is already running;
            // attribute the post run to it rather than to the post's
            // fallback agent binding.
            let inherited = db
                .latest_stage_run(&task_id)
                .map_err(|e| format!("db error: {}", e))?;
            let inherited_run_id = inherited.as_ref().map(|run| run.id.clone());
            db.finish_latest_running_stage_run(&task_id, "succeeded", None, None)
                .map_err(|e| format!("db error: {}", e))?;
            // The post continues the inherited run's live agent session, so
            // its provider session id and cwd carry over too.
            let (agent, agent_provider, model, effort, provider_session_id, cwd) = match inherited {
                Some(run) => (
                    run.agent,
                    run.agent_provider,
                    run.model,
                    run.effort,
                    run.provider_session_id,
                    run.cwd,
                ),
                None => (
                    prepared.fallback.stage_agent.clone(),
                    Some(prepared.fallback.agent_provider.clone()),
                    prepared.fallback.model.clone(),
                    prepared.fallback.effort.clone(),
                    None,
                    Some(prepared.fallback.cwd.clone()),
                ),
            };
            let run_id = generate_stage_run_id(&task_id);
            db.insert_stage_run_with_completion_binding(
                NewStageRun {
                    id: &run_id,
                    task_id: &task_id,
                    stage: &prepared.run_stage,
                    kind: "post",
                    agent: agent.as_deref(),
                    agent_provider: agent_provider.as_deref(),
                    model: model.as_deref(),
                    effort: effort.as_deref(),
                    status: "running",
                    result: None,
                    feedback: None,
                    session_id: Some(&prepared.session_id),
                    provider_session_id: provider_session_id.as_deref(),
                    cwd: cwd.as_deref(),
                    resumed_from_run_id: None,
                },
                Some(prepared.fallback.completion_transition.as_str()),
                true,
            )
            .map_err(|e| format!("db error: {}", e))?;
            if let Some(inherited_run_id) = inherited_run_id.as_deref() {
                advance_server_completion_context(
                    &prepared.fallback.env,
                    inherited_run_id,
                    &run_id,
                );
            }
            if prepared.run_stage == "approve" {
                db.record_approval_authorization(&task_id, &run_id)
                    .map_err(|e| format!("approval authorization error: {e}"))?;
            }
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        Err(TaskInputError::SessionNotFound) => {
            spawn_prepared_stage_run_for_api(db_path, daemon, replacements, prepared.fallback).await
        }
        Err(TaskInputError::Other(message)) => Err(message),
    }
}

pub(crate) async fn rerun_prepared_stage_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    mut prepared: PreparedStageRerun,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();
    let stage = prepared.stage.clone();
    let run_kind = prepared.run_kind;
    let stage_agent = prepared.stage_agent.clone();
    let agent_provider = prepared.agent_provider.clone();
    let model = prepared.model.clone();
    let effort = prepared.effort.clone();
    let completion_transition = prepared.completion_transition;
    let provider_session_id = prepared.provider_session_id.clone();
    let cwd = prepared.cwd.clone();
    let run_id = generate_stage_run_id(&task_id);
    initialize_completion_context(&mut prepared.env, &run_id)?;
    let record_failure = |error: String| match record_rerun_stage_failure(
        db_path,
        &task_id,
        &stage,
        run_kind,
        stage_agent.as_deref(),
        &agent_provider,
        model.as_deref(),
        effort.as_deref(),
        &session_id,
        provider_session_id.as_deref(),
        &cwd,
        &error,
    ) {
        Ok(()) => error,
        Err(record_error) => {
            format!("{error}; failed to record stage rerun failure: {record_error}")
        }
    };
    {
        // Reruns cancel whatever was running before the kill, for the same
        // reason stage swaps finish it first: the run record must never
        // claim a dead session is still running.
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        db.cancel_running_stage_runs(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
    }
    kill_session_replacing(daemon, replacements, &session_id).await?;
    if let Err(error) = prepare_deferred_rerun_setup(&mut prepared) {
        return Err(record_failure(error));
    }
    if let Some(snapshot) = prepared.recovery_snapshot.as_ref() {
        if let Err(error) = seed_recovery_snapshot(daemon, &session_id, snapshot).await {
            return Err(record_failure(error));
        }
    }

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );

    let event = match daemon.send_command_retrying_successor(&command).await {
        Ok(event) => event,
        Err(error) => return Err(record_failure(format!("daemon error: {error}"))),
    };
    match event {
        DaemonEvent::SessionCreated { .. } => {
            record_rerun_stage_run(
                db_path,
                &task_id,
                &stage,
                run_kind,
                stage_agent.as_deref(),
                &agent_provider,
                model.as_deref(),
                effort.as_deref(),
                completion_transition.as_str(),
                &session_id,
                provider_session_id.as_deref(),
                &cwd,
                &run_id,
            )?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        DaemonEvent::Error { message, .. } => {
            Err(record_failure(format!("daemon error: {message}")))
        }
        other => Err(record_failure(format!(
            "unexpected daemon response: {other:?}"
        ))),
    }
}

fn prepare_deferred_rerun_setup(prepared: &mut PreparedStageRerun) -> Result<(), String> {
    if prepared.deferred_setup.is_empty() {
        return Ok(());
    }
    run_workspace_setup_commands(&prepared.deferred_setup, &prepared.cwd, &prepared.env)?;
    let PreparedSessionSpawn::Agent {
        agent_provider,
        executable,
        ..
    } = &mut prepared.session
    else {
        return Err("deferred rerun setup requires a headless agent session".to_string());
    };
    *executable = resolve_headless_agent_executable(
        *agent_provider,
        prepared.env.get("PATH").map(String::as_str),
        &prepared.cwd,
    )?;
    Ok(())
}

/// Kill a session as part of an orchestrated replacement (stage swap, rerun,
/// close). The replacement entry is registered BEFORE the Kill is sent —
/// the daemon broadcasts the resulting Exit concurrently with the Kill
/// response — and cancelled when the session turns out not to exist (no
/// Exit will come, and a stale entry would swallow a future legitimate one).
pub(crate) async fn kill_session_replacing(
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    session_id: &str,
) -> Result<(), String> {
    replacements.begin(session_id);
    let kill = daemon
        .send_command_retrying_successor(&DaemonCommand::Kill {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|e| {
            replacements.cancel(session_id);
            format!("daemon error: {}", e)
        })?;
    match kill {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => {
            replacements.cancel(session_id);
            Ok(())
        }
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            replacements.cancel(session_id);
            Ok(())
        }
        DaemonEvent::Error { message, .. } => {
            replacements.cancel(session_id);
            Err(format!("daemon error: {}", message))
        }
        other => {
            replacements.cancel(session_id);
            Err(format!("unexpected daemon response: {:?}", other))
        }
    }
}

fn spawn_session_command(
    session_id: String,
    cwd: String,
    env: std::collections::HashMap<String, String>,
    terminal_prelude: Option<Vec<u8>>,
    session: PreparedSessionSpawn,
) -> DaemonCommand {
    match session {
        PreparedSessionSpawn::Pty {
            executable,
            args,
            cols,
            rows,
            agent_provider,
        } => DaemonCommand::Spawn {
            session_id,
            executable,
            args,
            cwd,
            env,
            cols,
            rows,
            agent_provider: Some(agent_provider),
            terminal_prelude,
        },
        PreparedSessionSpawn::Agent {
            agent_provider,
            prompt,
            model,
            effort,
            permission_mode,
            allowed_tools,
            disallowed_tools,
            max_turns,
            max_budget_usd,
            system_prompt,
            mcp_config_path,
            executable,
        } => DaemonCommand::SpawnAgent {
            session_id,
            params: AgentSpawnParams {
                agent_provider,
                prompt,
                cwd,
                env,
                model,
                effort,
                permission_mode,
                allowed_tools,
                disallowed_tools,
                max_turns,
                max_budget_usd,
                system_prompt: Some(system_prompt),
                mcp_config_path,
                executable,
            },
        },
    }
}

fn record_spawned_stage_run(
    db_path: &str,
    prepared: &PreparedTaskSpawn,
    run_id: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.with_immediate_transaction(|db| {
        db.update_pipeline_item_agent_session_id(
            &prepared.created_task.task_id,
            prepared.provider_session_id.as_deref(),
        )?;
        db.insert_stage_run_with_completion_binding(
            NewStageRun {
                id: run_id,
                task_id: &prepared.created_task.task_id,
                stage: &prepared.created_task.stage,
                kind: "main",
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                effort: prepared.effort.as_deref(),
                status: "running",
                result: None,
                feedback: None,
                session_id: Some(&prepared.session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: Some(&prepared.cwd),
                resumed_from_run_id: None,
            },
            Some(prepared.completion_transition.as_str()),
            true,
        )?;
        db.delete_create_task_intent(&prepared.created_task.task_id)
    })
    .map_err(|e| format!("db error: {}", e))
}

fn record_prepared_task_spawn_failure(
    db: &Db,
    prepared: &PreparedTaskSpawn,
    error: &str,
) -> Result<(), String> {
    let task_id = prepared.created_task.task_id.as_str();
    let result = format!("failed to spawn task {task_id}: {error}");
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, prepared.provider_session_id.as_deref())
        .map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_stage_run_id(task_id);
    db.insert_stage_run(NewStageRun {
        id: &run_id,
        task_id,
        stage: &prepared.created_task.stage,
        kind: "main",
        agent: prepared.stage_agent.as_deref(),
        agent_provider: Some(prepared.agent_provider.as_str()),
        model: prepared.model.as_deref(),
        effort: prepared.effort.as_deref(),
        status: "failed",
        result: Some(&result),
        feedback: Some("task spawn failed"),
        session_id: Some(&prepared.session_id),
        provider_session_id: prepared.provider_session_id.as_deref(),
        cwd: Some(&prepared.cwd),
        resumed_from_run_id: None,
    })
    .map_err(|e| format!("db error: {}", e))
}

#[allow(clippy::too_many_arguments)]
fn record_rerun_stage_run(
    db_path: &str,
    task_id: &str,
    stage: &str,
    run_kind: &'static str,
    stage_agent: Option<&str>,
    agent_provider: &str,
    model: Option<&str>,
    effort: Option<&str>,
    completion_transition: &str,
    session_id: &str,
    provider_session_id: Option<&str>,
    cwd: &str,
    run_id: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.with_immediate_transaction(|db| {
        db.cancel_running_stage_runs(task_id)?;
        db.update_pipeline_item_activity(task_id, "working")?;
        db.update_pipeline_item_agent_session_id(task_id, provider_session_id)?;
        db.insert_stage_run_with_completion_binding(
            NewStageRun {
                id: run_id,
                task_id,
                stage,
                kind: run_kind,
                agent: stage_agent,
                agent_provider: Some(agent_provider),
                model,
                effort,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some(session_id),
                provider_session_id,
                cwd: Some(cwd),
                resumed_from_run_id: None,
            },
            Some(completion_transition),
            true,
        )?;
        db.delete_create_task_intent(task_id)
    })
    .map_err(|e| format!("db error: {}", e))
}

#[allow(clippy::too_many_arguments)]
fn record_rerun_stage_failure(
    db_path: &str,
    task_id: &str,
    stage: &str,
    run_kind: &'static str,
    stage_agent: Option<&str>,
    agent_provider: &str,
    model: Option<&str>,
    effort: Option<&str>,
    session_id: &str,
    provider_session_id: Option<&str>,
    cwd: &str,
    error: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, None)
        .map_err(|e| format!("db error: {}", e))?;
    let result = format!("failed to rerun stage {stage}: {error}");
    let run_id = generate_stage_run_id(task_id);
    db.insert_stage_run(NewStageRun {
        id: &run_id,
        task_id,
        stage,
        kind: run_kind,
        agent: stage_agent,
        agent_provider: Some(agent_provider),
        model,
        effort,
        status: "failed",
        result: Some(&result),
        feedback: Some("stage rerun failed"),
        session_id: Some(session_id),
        provider_session_id,
        cwd: Some(cwd),
        resumed_from_run_id: None,
    })
    .map_err(|e| format!("db error: {}", e))
}

fn generate_stage_run_id(task_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("run-{task_id}-{nanos}")
}

fn initialize_completion_context(
    env: &mut std::collections::HashMap<String, String>,
    run_id: &str,
) -> Result<(), String> {
    let daemon_dir = env
        .get("KANNA_SOCKET_PATH")
        .and_then(|path| std::path::Path::new(path).parent())
        .ok_or_else(|| "spawn environment has no Kanna daemon directory".to_string())?;
    let path = daemon_dir
        .join("runtime")
        .join("completion")
        .join(format!("{run_id}.json"));
    kanna_tool_catalog::write_completion_context(
        &path,
        &kanna_tool_catalog::CompletionContext {
            run_id: run_id.to_string(),
            completed_attempt_key: None,
        },
    )?;
    env.insert(
        kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV.to_string(),
        run_id.to_string(),
    );
    env.insert(
        kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV.to_string(),
        path.to_string_lossy().to_string(),
    );
    Ok(())
}

fn advance_server_completion_context(
    env: &std::collections::HashMap<String, String>,
    inherited_run_id: &str,
    new_run_id: &str,
) {
    let Some(daemon_dir) = env
        .get("KANNA_SOCKET_PATH")
        .and_then(|path| std::path::Path::new(path).parent())
    else {
        return;
    };
    let path = daemon_dir
        .join("runtime")
        .join("completion")
        .join(format!("{inherited_run_id}.json"));
    let Ok(mut context) = kanna_tool_catalog::read_completion_context(&path) else {
        return;
    };
    if context.run_id != inherited_run_id {
        log::warn!(
            "refusing to advance completion context {} from unexpected run {}",
            path.display(),
            context.run_id
        );
        return;
    }
    context.run_id = new_run_id.to_string();
    context.completed_attempt_key = None;
    if let Err(error) = kanna_tool_catalog::write_completion_context(&path, &context) {
        log::warn!(
            "failed to bind completion context from {inherited_run_id} to {new_run_id}: {error}"
        );
    }
}

#[cfg(test)]
mod successor_retry_tests {
    use super::{
        advance_server_completion_context, initialize_completion_context, kill_session_replacing,
    };
    use crate::daemon_client::DaemonClient;
    use crate::session_replacements::SessionReplacements;
    use kanna_daemon::protocol::{ErrorCode, Event};
    use std::path::Path;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    #[test]
    fn continued_post_context_is_server_bound_to_the_exact_new_run() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-completion-context-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let mut env = std::collections::HashMap::from([(
            "KANNA_SOCKET_PATH".to_string(),
            kanna_runtime_defaults::socket_path(&daemon_dir)
                .to_string_lossy()
                .to_string(),
        )]);
        initialize_completion_context(&mut env, "run-main").unwrap();
        advance_server_completion_context(&env, "run-main", "run-post");
        let path = std::path::PathBuf::from(
            env.get(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV)
                .unwrap(),
        );
        let context = kanna_tool_catalog::read_completion_context(&path).unwrap();
        assert_eq!(context.run_id, "run-post");
        assert_eq!(context.completed_attempt_key, None);
        std::fs::remove_dir_all(daemon_dir).unwrap();
    }

    #[tokio::test]
    async fn replacement_bookkeeping_survives_successor_retry_until_the_single_exit() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-replacement-successor-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let pid_path = daemon_dir.join("daemon.pid");
        let _ = std::fs::remove_file(&socket_path);
        std::fs::write(&pid_path, "41\n").unwrap();
        let old_listener = UnixListener::bind(&socket_path).unwrap();
        let socket_for_server = socket_path.clone();
        let pid_for_server = pid_path.clone();

        let server = tokio::spawn(async move {
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut first = String::new();
            BufReader::new(read_half)
                .read_line(&mut first)
                .await
                .unwrap();
            let refusal = Event::Error {
                code: Some(ErrorCode::RetryOnSuccessor),
                message: "retry".to_string(),
            };
            write_half
                .write_all(serde_json::to_string(&refusal).unwrap().as_bytes())
                .await
                .unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            drop(write_half);
            let _ = std::fs::remove_file(&socket_for_server);

            let successor = UnixListener::bind(&socket_for_server).unwrap();
            std::fs::write(&pid_for_server, format!("{}\n", std::process::id())).unwrap();
            let (stream, _) = successor.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut second = String::new();
            BufReader::new(read_half)
                .read_line(&mut second)
                .await
                .unwrap();
            write_half
                .write_all(serde_json::to_string(&Event::Ok).unwrap().as_bytes())
                .await
                .unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            (first, second)
        });

        let mut daemon = DaemonClient::connect(daemon_dir.to_str().unwrap())
            .await
            .unwrap();
        daemon.set_connected_pid_for_test(41);
        let replacements = SessionReplacements::default();

        kill_session_replacing(&mut daemon, &replacements, "replace-me")
            .await
            .unwrap();

        assert!(
            replacements.consume("replace-me"),
            "the one replacement marker must remain for the daemon's one Exit"
        );
        assert!(
            !replacements.consume("replace-me"),
            "a duplicate Exit must not be classified as another replacement"
        );
        let (first, second) = server.await.unwrap();
        assert_eq!(first, second, "Kill must be replayed byte-for-byte");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(Path::new(&daemon_dir));
    }

    #[tokio::test]
    async fn replacement_bookkeeping_cancels_when_successor_refuses_the_single_replay() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-replacement-successor-cap-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let pid_path = daemon_dir.join("daemon.pid");
        let _ = std::fs::remove_file(&socket_path);
        std::fs::write(&pid_path, "41\n").unwrap();
        let old_listener = UnixListener::bind(&socket_path).unwrap();
        let socket_for_server = socket_path.clone();
        let pid_for_server = pid_path.clone();

        let server = tokio::spawn(async move {
            let refusal = serde_json::to_string(&Event::Error {
                code: Some(ErrorCode::RetryOnSuccessor),
                message: "retry".to_string(),
            })
            .unwrap();
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut first = String::new();
            BufReader::new(read_half)
                .read_line(&mut first)
                .await
                .unwrap();
            write_half.write_all(refusal.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            drop(write_half);
            let _ = std::fs::remove_file(&socket_for_server);

            let successor = UnixListener::bind(&socket_for_server).unwrap();
            std::fs::write(&pid_for_server, format!("{}\n", std::process::id())).unwrap();
            let (stream, _) = successor.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut second = String::new();
            BufReader::new(read_half)
                .read_line(&mut second)
                .await
                .unwrap();
            write_half.write_all(refusal.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            (first, second)
        });

        let mut daemon = DaemonClient::connect(daemon_dir.to_str().unwrap())
            .await
            .unwrap();
        daemon.set_connected_pid_for_test(41);
        let replacements = SessionReplacements::default();

        let error = kill_session_replacing(&mut daemon, &replacements, "replace-once")
            .await
            .expect_err("a second refusal must be surfaced");

        assert!(error.contains("daemon error: retry"));
        assert!(
            !replacements.consume("replace-once"),
            "terminal retry exhaustion must cancel replacement bookkeeping"
        );
        let (first, second) = server.await.unwrap();
        assert_eq!(first, second, "the one replay must stay byte-for-byte");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(Path::new(&daemon_dir));
    }
}

#[cfg(test)]
mod teardown_deadline_tests {
    use super::*;
    use kanna_daemon::protocol::{SessionInfo, SessionKind, SessionState, SessionStatus};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn teardown_session_is_killed_at_its_deadline() {
        let daemon_dir =
            std::env::temp_dir().join(format!("kanna-teardown-deadline-{}", std::process::id()));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            for expected in ["List", "List", "Kill"] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                match (&command, expected) {
                    (DaemonCommand::List, "List") => {
                        let response = DaemonEvent::SessionList {
                            sessions: vec![SessionInfo {
                                session_id: "td-task-1".to_string(),
                                pid: 42,
                                cwd: "/tmp".to_string(),
                                state: SessionState::Active,
                                idle_seconds: 0,
                                status: SessionStatus::Busy,
                                kind: SessionKind::Pty,
                            }],
                        };
                        write
                            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                            .await
                            .unwrap();
                        write.write_all(b"\n").await.unwrap();
                    }
                    (DaemonCommand::Kill { session_id }, "Kill") => {
                        assert_eq!(session_id, "td-task-1");
                        write
                            .write_all(serde_json::to_string(&DaemonEvent::Ok).unwrap().as_bytes())
                            .await
                            .unwrap();
                        write.write_all(b"\n").await.unwrap();
                    }
                    _ => panic!("unexpected command {command:?}, expected {expected}"),
                }
            }
        });

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            supervise_teardown_session(
                daemon_dir.to_string_lossy().to_string(),
                "td-task-1".to_string(),
                std::time::Duration::from_millis(20),
                std::time::Duration::from_millis(50),
            ),
        )
        .await
        .expect("teardown supervision should finish after issuing Kill");

        tokio::time::timeout(std::time::Duration::from_secs(1), server)
            .await
            .expect("deadline monitor should issue Kill")
            .unwrap();
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn transient_soft_probe_failure_preserves_teardown_hard_deadline() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-teardown-transient-probe-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            for expected in ["ListError", "List", "Kill"] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                match (&command, expected) {
                    (DaemonCommand::List, "ListError") => {
                        // Simulate a daemon handoff/socket failure after the
                        // request is accepted but before a response arrives.
                    }
                    (DaemonCommand::List, "List") => {
                        let response = DaemonEvent::SessionList {
                            sessions: vec![SessionInfo {
                                session_id: "td-task-transient".to_string(),
                                pid: 42,
                                cwd: "/tmp".to_string(),
                                state: SessionState::Active,
                                idle_seconds: 0,
                                status: SessionStatus::Busy,
                                kind: SessionKind::Pty,
                            }],
                        };
                        write
                            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                            .await
                            .unwrap();
                        write.write_all(b"\n").await.unwrap();
                    }
                    (DaemonCommand::Kill { session_id }, "Kill") => {
                        assert_eq!(session_id, "td-task-transient");
                        write
                            .write_all(serde_json::to_string(&DaemonEvent::Ok).unwrap().as_bytes())
                            .await
                            .unwrap();
                        write.write_all(b"\n").await.unwrap();
                    }
                    _ => panic!("unexpected command {command:?}, expected {expected}"),
                }
            }
        });

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            supervise_teardown_session(
                daemon_dir.to_string_lossy().to_string(),
                "td-task-transient".to_string(),
                std::time::Duration::from_millis(20),
                std::time::Duration::from_millis(50),
            ),
        )
        .await
        .expect("teardown supervision should finish after issuing Kill");

        tokio::time::timeout(std::time::Duration::from_secs(1), server)
            .await
            .expect("transient soft probe failure must not cancel the hard-deadline kill")
            .unwrap();
        let _ = std::fs::remove_dir_all(daemon_dir);
    }
}
