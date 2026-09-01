use super::environment::{resolve_headless_agent_executable, run_workspace_setup_commands};
use super::types::{
    CreatedTask, PreparedPostDispatch, PreparedRunWorkspace, PreparedSessionSpawn,
    PreparedStageRerun, PreparedStageRunSpawn, PreparedTaskSpawn, PreparedWorkspaceTeardown,
};
use super::worktree::remove_prepared_worktree;
use crate::daemon_client::{DaemonClient, SpawnDeliveryError};
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
    spawn_prepared_task_classified(daemon, prepared)
        .await
        .map_err(SpawnPreparedError::into_message)
}

async fn send_session_spawn_command(
    daemon: &mut DaemonClient,
    command: &DaemonCommand,
) -> Result<DaemonEvent, SpawnDeliveryError> {
    if matches!(command, DaemonCommand::Spawn { .. }) {
        daemon.send_spawn_command_retrying_successor(command).await
    } else {
        daemon
            .send_command_retrying_successor(command)
            .await
            .map_err(|error| SpawnDeliveryError::AfterSubmission(error.to_string()))
    }
}

enum SpawnPreparedError {
    BeforeAcknowledgement(String),
    UncertainDelivery(String),
}

impl SpawnPreparedError {
    fn into_message(self) -> String {
        match self {
            Self::BeforeAcknowledgement(message) | Self::UncertainDelivery(message) => message,
        }
    }
}

async fn spawn_prepared_task_classified(
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<CreatedTask, SpawnPreparedError> {
    if let Some(snapshot) = prepared.recovery_snapshot.as_ref() {
        seed_recovery_snapshot(daemon, &prepared.session_id, snapshot)
            .await
            .map_err(SpawnPreparedError::BeforeAcknowledgement)?;
    }
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
        false,
    );

    let event =
        send_session_spawn_command(daemon, &command)
            .await
            .map_err(|error| match error {
                SpawnDeliveryError::BeforeSubmission(message) => {
                    SpawnPreparedError::BeforeAcknowledgement(format!(
                        "daemon spawn failed before submission: {message}"
                    ))
                }
                SpawnDeliveryError::AfterSubmission(message) => {
                    SpawnPreparedError::UncertainDelivery(format!(
                        "daemon spawn response lost after submission began: {message}"
                    ))
                }
            })?;

    match event {
        DaemonEvent::SessionCreated { .. } => Ok(prepared.created_task),
        DaemonEvent::Error { message, .. } => Err(SpawnPreparedError::BeforeAcknowledgement(
            format!("daemon error: {message}"),
        )),
        other => Err(SpawnPreparedError::BeforeAcknowledgement(format!(
            "unexpected daemon response: {other:?}"
        ))),
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

/// Fetch the outgoing session's terminal and flatten it into the history seed
/// for its replacement (`terminal_window::carryover_seed_snapshot`). `None` —
/// a session without a terminal, a terminal with no primary-screen content, or
/// any daemon error — means the replacement starts blank, exactly as before
/// carryover existed. The daemon serves a live session's terminal directly and
/// falls back to its persisted recovery snapshot for a dead one, so a post
/// fallback whose session already exited still carries its history.
async fn fetch_terminal_carryover(
    daemon: &mut DaemonClient,
    session_id: &str,
) -> Option<TerminalSnapshot> {
    let event = match daemon
        .send_command_retrying_successor(&DaemonCommand::Snapshot {
            session_id: session_id.to_string(),
        })
        .await
    {
        Ok(event) => event,
        Err(error) => {
            log::warn!(
                "[stage-carryover] failed to snapshot outgoing session {session_id}: {error}"
            );
            return None;
        }
    };
    match event {
        DaemonEvent::Snapshot { snapshot, .. } => {
            crate::terminal_window::carryover_seed_snapshot(&snapshot)
        }
        DaemonEvent::Error { message, .. } => {
            log::info!("[stage-carryover] no terminal to carry over for {session_id}: {message}");
            None
        }
        other => {
            log::warn!(
                "[stage-carryover] unexpected daemon snapshot response for {session_id}: {other:?}"
            );
            None
        }
    }
}

/// Seed the flattened history under the replacement session. Best-effort: the
/// stage transition already committed to the replacement, and losing carryover
/// only costs scrollback.
async fn seed_terminal_carryover(
    daemon: &mut DaemonClient,
    session_id: &str,
    snapshot: &TerminalSnapshot,
) {
    let event = daemon
        .send_command(&DaemonCommand::SeedSnapshot {
            session_id: session_id.to_string(),
            snapshot: snapshot.clone(),
        })
        .await;
    match event {
        Ok(DaemonEvent::Ok) => {}
        Ok(DaemonEvent::Error { message, .. }) => {
            log::warn!("[stage-carryover] daemon refused history seed for {session_id}: {message}");
        }
        Ok(other) => {
            log::warn!(
                "[stage-carryover] unexpected daemon seed response for {session_id}: {other:?}"
            );
        }
        Err(error) => {
            log::warn!("[stage-carryover] failed to seed history for {session_id}: {error}");
        }
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
    let mut completion_context = initialize_completion_context(
        &mut prepared.env,
        &prepared.created_task.task_id,
        &run_id,
        daemon.daemon_dir(),
    )
    .map_err(PreparedTaskDeliveryError::BeforeAcknowledgement)?;
    // Publish the immutable completion identity before the child can become
    // live. An acknowledged (or transport-uncertain) Spawn must never leave a
    // process whose run exists only in its environment.
    let record_db_path = db_path.to_string();
    let record_prepared = prepared.clone();
    let record_run_id = run_id.clone();
    tokio::task::spawn_blocking(move || {
        record_spawned_stage_run(&record_db_path, &record_prepared, &record_run_id)
    })
    .await
    .map_err(|join_error| {
        PreparedTaskDeliveryError::BeforeAcknowledgement(format!(
            "stage run record worker failed before daemon spawn: {join_error}"
        ))
    })?
    .map_err(PreparedTaskDeliveryError::BeforeAcknowledgement)?;
    let created = match spawn_prepared_task_classified(daemon, prepared.clone()).await {
        Ok(created) => created,
        Err(SpawnPreparedError::BeforeAcknowledgement(message)) => {
            let record_db_path = db_path.to_string();
            let record_prepared = prepared.clone();
            let record_message = message.clone();
            let diagnostic = tokio::task::spawn_blocking(move || {
                let db = Db::open(&record_db_path).map_err(|error| format!("db error: {error}"))?;
                record_prepared_task_spawn_failure(&db, &record_prepared, &record_message)
            })
            .await;
            let message = match diagnostic {
                Ok(Ok(())) => message,
                Ok(Err(error)) => format!("{message}; diagnostics failed: {error}"),
                Err(error) => format!("{message}; diagnostics worker failed: {error}"),
            };
            return Err(PreparedTaskDeliveryError::BeforeAcknowledgement(message));
        }
        Err(SpawnPreparedError::UncertainDelivery(message)) => {
            // The daemon may have created the agent even though its
            // acknowledgement was lost. Preserve the context that process
            // received; the caller quarantines this task instead of retrying.
            completion_context.persist();
            return Err(PreparedTaskDeliveryError::AfterAcknowledgement(message));
        }
    };
    // From this point the daemon has acknowledged a process which owns this
    // path. Keep it even if later database bookkeeping fails.
    completion_context.persist();
    let created = crate::mobile_api::CreateTaskResponse {
        task_id: created.task_id,
        repo_id: created.repo_id,
        title: created.title,
        prompt: created.prompt,
        stage: created.stage,
        agent_type: created.agent_type,
        worktree_path: Some(created.worktree_path),
    };
    Ok(created)
}

pub(crate) async fn spawn_prepared_task_for_api_with_diagnostics(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    match spawn_prepared_task_for_api_recording_stage_run_detailed(
        db_path,
        daemon,
        prepared.clone(),
    )
    .await
    {
        Ok(created) => Ok(created),
        Err(PreparedTaskDeliveryError::AfterAcknowledgement(err)) => Err(format!(
            "task {} spawn delivery is uncertain: {err}",
            prepared.created_task.task_id
        )),
        Err(PreparedTaskDeliveryError::BeforeAcknowledgement(err)) => {
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
    let mut completion_context =
        initialize_completion_context(&mut prepared.env, &task_id, &run_id, daemon.daemon_dir())?;
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
    //
    // The outgoing main run is resolved here too, while it is still the only
    // main run this session has served: the replacement run is inserted below
    // and reuses the same session id, so after that point "the session's
    // latest run" names the wrong conversation. A stage's post shares the
    // session but is not what a revision reopens, so the main run is the
    // identity carried into the kill.
    let outgoing_run_id = {
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        let outgoing_run_id = db
            .latest_main_stage_run_id_for_session(&task_id, &session_id)
            .map_err(|e| format!("db error: {}", e))?;
        db.finish_latest_running_stage_run(&task_id, "succeeded", None, None)
            .map_err(|e| format!("db error: {}", e))?;
        outgoing_run_id
    };

    // Capture the outgoing session's terminal before the kill discards it, so
    // the replacement session can be seeded with its primary-screen history
    // and the user can scroll back past the stage boundary. Best-effort in
    // both directions: a task must never fail to advance over terminal
    // continuity, and a missing terminal simply means a blank start.
    let terminal_carryover = if matches!(prepared.session, PreparedSessionSpawn::Pty { .. }) {
        fetch_terminal_carryover(daemon, &session_id).await
    } else {
        None
    };

    // Only a freshly forked workspace is rolled back on failure; a resumed
    // workspace pre-exists this spawn and must survive it.
    if let Err(error) = kill_session_replacing_for_run(
        daemon,
        replacements,
        &session_id,
        outgoing_run_id.as_deref(),
    )
    .await
    {
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

    // The kill above deleted the session's persisted recovery snapshot, so the
    // seed must land after it (mirroring the rerun transfer-seed ordering).
    if let Some(snapshot) = terminal_carryover.as_ref() {
        seed_terminal_carryover(daemon, &session_id, snapshot).await;
    }

    record_stage_transition_run(db_path, &prepared, &run_id)?;

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd.clone(),
        prepared.env.clone(),
        prepared.terminal_prelude.clone(),
        prepared.session.clone(),
        prepared.stage_agent.as_deref() == Some("merge"),
    );
    let event = match send_session_spawn_command(daemon, &command).await {
        Ok(event) => event,
        Err(SpawnDeliveryError::AfterSubmission(message)) => {
            // Once Spawn has crossed the socket, response loss cannot prove
            // that the daemon did not create the process. Keep the immutable
            // completion identity available to any surviving child.
            completion_context.persist();
            return Err(format!("daemon spawn delivery is uncertain: {message}"));
        }
        Err(SpawnDeliveryError::BeforeSubmission(message)) => {
            let error = format!("daemon spawn failed before submission: {message}");
            fail_bound_stage_run(db_path, &task_id, &run_id, &error);
            return Err(rollback_prepared_stage_fork(&prepared, error));
        }
    };
    match event {
        DaemonEvent::SessionCreated { .. } => {
            // SessionCreated is the daemon's commit point. All bookkeeping
            // below remains fallible, but the acknowledged child already has
            // this path in its environment and must never lose the artifact.
            completion_context.persist();
        }
        DaemonEvent::Error { message, .. } => {
            let error = format!("daemon error: {message}");
            fail_bound_stage_run(db_path, &task_id, &run_id, &error);
            return Err(rollback_prepared_stage_fork(&prepared, error));
        }
        other => {
            completion_context.persist();
            return Err(format!(
                "daemon spawn delivery is uncertain after unexpected response: {other:?}"
            ));
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
        let error = format!("task {task_id} closed before stage transition landed");
        fail_bound_stage_run(db_path, &task_id, &run_id, &error);
        return Err(rollback_prepared_stage_fork(&prepared, error));
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
                    let error = format!("task {task_id} closed before stage transition landed");
                    fail_bound_stage_run(db_path, &task_id, &run_id, &error);
                    return Err(rollback_prepared_stage_fork(&prepared, error));
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
                    let error = format!("task {task_id} closed before stage transition landed");
                    fail_bound_stage_run(db_path, &task_id, &run_id, &error);
                    return Err(rollback_prepared_stage_fork(&prepared, error));
                }
                return Err(format!("db error: {}", error));
            }
        }
    }
    db.update_pipeline_item_activity(&task_id, "working")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(&task_id, prepared.provider_session_id.as_deref())
        .map_err(|e| format!("db error: {}", e))?;
    spawn_prepared_workspace_teardown_best_effort(daemon, prepared.workspace_teardown).await;

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    })
}

fn record_stage_transition_run(
    db_path: &str,
    prepared: &PreparedStageRunSpawn,
    run_id: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {e}"))?;
    db.with_immediate_transaction(|db| -> rusqlite::Result<()> {
        db.insert_stage_run_with_completion_binding(
            NewStageRun {
                id: run_id,
                task_id: &prepared.task_id,
                stage: &prepared.run_stage,
                kind: prepared.run_kind,
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                effort: prepared.effort.as_deref(),
                status: "running",
                result: None,
                feedback: prepared.feedback.as_deref(),
                session_id: Some(&prepared.session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: Some(&prepared.cwd),
                resumed_from_run_id: prepared.resumed_from_run_id.as_deref(),
            },
            Some(prepared.completion_transition.as_str()),
            true,
        )?;
        if let Some(reason) = prepared.resume_fallback_reason.as_deref() {
            db.set_stage_run_resume_fallback_reason(run_id, reason)?;
        }
        Ok(())
    })
    .map_err(|e| format!("db error: {e}"))
}

fn fail_bound_stage_run(db_path: &str, task_id: &str, run_id: &str, error: &str) {
    let result = format!("failed to start stage run: {error}");
    let record = Db::open(db_path).and_then(|db| {
        db.finish_stage_run(run_id, "failed", Some(&result), Some("stage spawn failed"))?;
        db.update_pipeline_item_activity(task_id, "unread")?;
        db.update_pipeline_item_agent_session_id(task_id, None)
    });
    if let Err(record_error) = record {
        log::warn!("failed to terminate rejected stage run {run_id}: {record_error}");
    }
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

pub(crate) fn rollback_prepared_stage_run_for_api(
    prepared: &PreparedStageRunSpawn,
    error: String,
) -> String {
    rollback_prepared_stage_fork(prepared, error)
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
    let db_path = prepared.db_path.clone();
    let task_id = prepared.task_id.clone();
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
        false,
    );
    match daemon.send_command_retrying_successor(&command).await {
        Ok(DaemonEvent::SessionCreated { .. }) => {
            tokio::spawn(supervise_teardown_session(
                daemon_dir,
                session_id,
                db_path,
                task_id,
                std::time::Duration::from_secs(10 * 60),
                std::time::Duration::from_secs(30 * 60),
            ));
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            log::warn!("workspace teardown session {session_id} failed to start: {message}");
            record_teardown_failure(&db_path, &task_id, &session_id, &message);
        }
        Ok(other) => {
            log::warn!(
                "workspace teardown session {session_id} returned unexpected daemon response: {other:?}"
            );
            record_teardown_failure(
                &db_path,
                &task_id,
                &session_id,
                &format!("unexpected daemon response: {other:?}"),
            );
        }
        Err(error) => {
            log::warn!("workspace teardown session {session_id} daemon error: {error}");
            record_teardown_failure(&db_path, &task_id, &session_id, &error.to_string());
        }
    }
}

async fn supervise_teardown_session(
    daemon_dir: String,
    session_id: String,
    db_path: String,
    task_id: String,
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
            record_teardown_failure(
                &db_path,
                &task_id,
                &session_id,
                &format!("timed out after {}s", hard_timeout.as_secs()),
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

fn record_teardown_failure(db_path: &str, task_id: &str, session_id: &str, error: &str) {
    let result = Db::open(db_path).and_then(|db| {
        db.append_task_event(
            task_id,
            crate::db::TaskEventKind::TeardownFailed,
            serde_json::json!({ "sessionId": session_id, "error": error }),
        )
    });
    if let Err(db_error) = result {
        log::error!("failed to record teardown failure event for task {task_id}: {db_error}");
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
) -> Result<PostDispatchOutcome, String> {
    let task_id = prepared.task_id.clone();
    let inherited_run_id = Db::open(db_path)
        .map_err(|e| format!("db error: {e}"))?
        .latest_stage_run(&task_id)
        .map_err(|e| format!("db error: {e}"))?
        .map(|run| run.id);
    if inherited_run_id
        .as_deref()
        .is_some_and(|run_id| uses_legacy_completion_context(daemon.daemon_dir(), &task_id, run_id))
    {
        // A surviving pre-upgrade adapter can still overwrite its unlocked
        // legacy context after receiving the main-run response. Do not
        // continue that process into a post: replace it with a newly spawned
        // post whose private run-scoped context is server-owned.
        return spawn_prepared_stage_run_for_api(db_path, daemon, replacements, prepared.fallback)
            .await
            .map(|response| PostDispatchOutcome {
                response,
                held_by_raw_draft: false,
            });
    }
    let held_by_raw_draft =
        match try_submit_task_input(daemon, &prepared.session_id, &prepared.message).await {
            Ok(()) => false,
            // The daemon accepted this semantic message and owns its automatic
            // release after the human submits the draft. Record the post run now
            // just as for an immediate write: otherwise the queued post would be
            // invisible and its eventual completion would still be bound to the
            // preceding main run.
            Err(TaskInputError::HeldByRawDraft(_)) => true,
            Err(TaskInputError::SessionNotFound) => {
                return spawn_prepared_stage_run_for_api(
                    db_path,
                    daemon,
                    replacements,
                    prepared.fallback,
                )
                .await
                .map(|response| PostDispatchOutcome {
                    response,
                    held_by_raw_draft: false,
                });
            }
            // A blocked session is alive and refusing, so falling back to a fresh
            // spawn would run the post twice against one live agent. Report the
            // refusal — its message carries what unblocks it.
            Err(
                TaskInputError::Other(message)
                | TaskInputError::Uncertain(message)
                | TaskInputError::InputBlocked(message),
            ) => return Err(message),
        };
    {
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
            advance_server_completion_context(daemon.daemon_dir(), inherited_run_id, &run_id);
        }
        Ok(PostDispatchOutcome {
            response: crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            },
            held_by_raw_draft,
        })
    }
}

pub(crate) struct PostDispatchOutcome {
    pub(crate) response: crate::mobile_api::TaskActionResponse,
    pub(crate) held_by_raw_draft: bool,
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
    let mut completion_context =
        initialize_completion_context(&mut prepared.env, &task_id, &run_id, daemon.daemon_dir())?;
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

    // The run row and artifact form one durable identity and must both exist
    // before Spawn can make the child observable.
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

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
        stage_agent.as_deref() == Some("merge"),
    );

    let event = match send_session_spawn_command(daemon, &command).await {
        Ok(event) => event,
        Err(SpawnDeliveryError::AfterSubmission(message)) => {
            completion_context.persist();
            return Err(format!("daemon spawn delivery is uncertain: {message}"));
        }
        Err(SpawnDeliveryError::BeforeSubmission(message)) => {
            return Err(record_failure(format!(
                "daemon spawn failed before submission: {message}"
            )));
        }
    };
    match event {
        DaemonEvent::SessionCreated { .. } => {
            completion_context.persist();
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        DaemonEvent::Error { message, .. } => {
            let error = format!("daemon error: {message}");
            fail_bound_stage_run(db_path, &task_id, &run_id, &error);
            Err(error)
        }
        other => {
            completion_context.persist();
            Err(format!(
                "daemon spawn delivery is uncertain after unexpected response: {other:?}"
            ))
        }
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
    kill_session_replacing_for_run(daemon, replacements, session_id, None).await
}

/// Kill a session as part of an orchestrated replacement, naming the stage run
/// that session was serving.
///
/// The daemon reports a provider's own resume id (Codex's rollout uuid) on the
/// `Exit` it broadcasts for the kill, and that id is the outgoing run's only
/// record of its conversation. Only the killer knows which run that is: the
/// Kill response carries no id, and by the time the watcher sees the `Exit`
/// the replacement run has usually taken the same session id.
pub(crate) async fn kill_session_replacing_for_run(
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    session_id: &str,
    outgoing_run_id: Option<&str>,
) -> Result<(), String> {
    replacements.begin_for_run(session_id, outgoing_run_id);
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
    operator_input_only: bool,
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
            operator_input_only,
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
    let latest_run = db
        .latest_stage_run(task_id)
        .map_err(|e| format!("db error: {e}"))?;
    let bound_run = match latest_run {
        Some(run)
            if db
                .stage_run_completion_bound(&run.id)
                .map_err(|e| format!("db error: {e}"))? =>
        {
            Some(run)
        }
        _ => None,
    };
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, prepared.provider_session_id.as_deref())
        .map_err(|e| format!("db error: {}", e))?;
    if let Some(run) = bound_run {
        if run.status == "failed" && run.feedback.as_deref() == Some("task spawn failed") {
            return Ok(());
        }
        if matches!(run.status.as_str(), "running" | "cancelled") {
            return db
                .finish_stage_run(&run.id, "failed", Some(&result), Some("task spawn failed"))
                .map_err(|e| format!("db error: {e}"));
        }
    }
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
    _task_id: &str,
    run_id: &str,
    daemon_dir: &str,
) -> Result<CompletionContextArtifact, String> {
    let daemon_dir = std::path::PathBuf::from(daemon_dir);
    let path = daemon_dir
        .join("runtime")
        .join("completion")
        .join(format!("{run_id}.json"));
    kanna_tool_catalog::write_completion_context(
        &path,
        &kanna_tool_catalog::CompletionContext::new(run_id),
    )?;
    env.insert(
        kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV.to_string(),
        run_id.to_string(),
    );
    env.insert(
        kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV.to_string(),
        path.to_string_lossy().to_string(),
    );
    Ok(CompletionContextArtifact { path, keep: false })
}

struct CompletionContextArtifact {
    path: std::path::PathBuf,
    keep: bool,
}

impl CompletionContextArtifact {
    fn persist(&mut self) {
        self.keep = true;
    }
}

impl Drop for CompletionContextArtifact {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        for path in [&self.path, &self.path.with_extension("lock")] {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "failed to roll back completion context {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }
}

pub(crate) fn remove_completion_contexts(daemon_dir: &str, task_id: &str) {
    let daemon_dir = std::path::Path::new(daemon_dir);
    remove_task_completion_contexts_in(&completion_directory(daemon_dir), task_id, None);
    remove_task_completion_contexts_in(
        &legacy_shared_completion_directory(daemon_dir),
        task_id,
        None,
    );
}

pub(crate) fn prune_completion_contexts_on_startup(daemon_dir: &str, db: &Db) {
    let Ok(tasks) = db.list_task_completion_runs() else {
        log::warn!("failed to list open tasks while pruning completion contexts");
        return;
    };
    let daemon_dir = std::path::Path::new(daemon_dir);
    let directory = completion_directory(daemon_dir);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        prune_known_legacy_completion_contexts(
            &legacy_shared_completion_directory(daemon_dir),
            &tasks,
            db,
        );
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.ends_with(".json") {
            upgrade_legacy_completion_context(&path, db);
        }
        let belongs_to_open_task = tasks.iter().any(|(task_id, open, latest_run_id)| {
            if !open {
                return false;
            }
            if name == format!("task-{task_id}.json") || name == format!("task-{task_id}.lock") {
                return true;
            }
            if !name.starts_with(&format!("run-{task_id}-")) {
                return false;
            }
            let context_path = if name.ends_with(".json") {
                path.clone()
            } else {
                path.with_extension("json")
            };
            latest_run_id.as_deref().is_some_and(|run_id| {
                kanna_tool_catalog::read_completion_context(&context_path)
                    .is_ok_and(|context| context.run_id == run_id)
            })
        });
        if !belongs_to_open_task {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "failed to prune orphaned completion context {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }
    prune_known_legacy_completion_contexts(
        &legacy_shared_completion_directory(daemon_dir),
        &tasks,
        db,
    );
}

fn completion_directory(daemon_dir: &std::path::Path) -> std::path::PathBuf {
    daemon_dir.join("runtime").join("completion")
}

fn legacy_shared_completion_directory(daemon_dir: &std::path::Path) -> std::path::PathBuf {
    kanna_runtime_defaults::socket_path(&daemon_dir.join("pipeline"))
        .parent()
        .unwrap_or(daemon_dir)
        .join("runtime")
        .join("completion")
}

fn remove_task_completion_contexts_in(
    directory: &std::path::Path,
    task_id: &str,
    keep: Option<&std::path::Path>,
) {
    let prefixes = [format!("run-{task_id}-"), format!("task-{task_id}.")];
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if keep.is_some_and(|keep| path == keep || path == keep.with_extension("lock")) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if prefixes.iter().any(|prefix| name.starts_with(prefix)) {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "failed to remove stale completion context {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }
}

fn prune_known_legacy_completion_contexts(
    directory: &std::path::Path,
    tasks: &[(String, bool, Option<String>)],
    db: &Db,
) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some((_, open, latest_run_id)) = tasks
            .iter()
            .find(|(task_id, _, _)| name.starts_with(&format!("run-{task_id}-")))
        else {
            // This shared /tmp directory can contain another Kanna instance's
            // contexts. Never delete a task id absent from this database.
            continue;
        };
        let json_path = if name.ends_with(".json") {
            path.clone()
        } else {
            path.with_extension("json")
        };
        if name.ends_with(".json") {
            upgrade_legacy_completion_context(&json_path, db);
        }
        let keep = *open
            && latest_run_id.as_deref().is_some_and(|run_id| {
                kanna_tool_catalog::read_completion_context(&json_path)
                    .is_ok_and(|context| context.run_id == run_id)
            });
        if !keep {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn spawned_run_id_from_context_path(path: &std::path::Path) -> Option<&str> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| stem.starts_with("run-"))
}

fn completion_attempt_keys_from_result(result: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(result) else {
        return Vec::new();
    };
    let mut candidates = vec![value.clone()];
    if let Some(object) = value.as_object() {
        let mut compact = object.clone();
        compact.retain(|_, value| !value.is_null());
        if compact != *object {
            candidates.push(serde_json::Value::Object(compact));
        }
    }
    candidates
        .iter()
        .filter_map(|candidate| kanna_tool_catalog::completion_attempt_key(candidate).ok())
        .collect()
}

fn continued_running_post_for_spawned_run(
    db: &Db,
    spawned_run_id: &str,
) -> Option<crate::db::StageRun> {
    let spawned = db.stage_run(spawned_run_id).ok().flatten()?;
    if !matches!(spawned.status.as_str(), "succeeded" | "failed") {
        return None;
    }
    let latest = db.latest_stage_run(&spawned.task_id).ok().flatten()?;
    (latest.id != spawned.id
        && latest.kind == "post"
        && latest.status == "running"
        && latest.session_id.is_some()
        && latest.session_id == spawned.session_id
        && latest.provider_session_id == spawned.provider_session_id
        && latest.cwd == spawned.cwd)
        .then_some(latest)
}

/// Compile the short-lived context format from the previous release into the
/// retry-safe format. That format could contain a successor `runId` but no
/// history after main -> post rebinding. The run-scoped filename is immutable,
/// and the completed original run's persisted result reconstructs the exact
/// adapter attempt keys without trusting mutable prose.
fn upgrade_legacy_completion_context(path: &std::path::Path, db: &Db) {
    let Some(filename_run_id) = spawned_run_id_from_context_path(path).map(str::to_string) else {
        return;
    };
    let Ok(context) = kanna_tool_catalog::read_completion_context(path) else {
        return;
    };
    let spawned_run_id = context
        .spawned_run_id
        .as_deref()
        .unwrap_or(&filename_run_id)
        .to_string();
    let needs_identity = context.spawned_run_id.is_none();
    let continued_post = continued_running_post_for_spawned_run(db, &spawned_run_id);
    let needs_rebind = context.run_id == spawned_run_id && continued_post.is_some();
    let needs_attempts = (context.run_id != spawned_run_id || needs_rebind)
        && context.completed_attempts.is_empty()
        && context.completed_run_id.is_none();
    if !needs_identity && !needs_attempts && !needs_rebind {
        return;
    }
    let keys = if needs_attempts {
        db.stage_run(&spawned_run_id)
            .ok()
            .flatten()
            .filter(|run| matches!(run.status.as_str(), "succeeded" | "failed"))
            .and_then(|run| run.result)
            .map(|result| completion_attempt_keys_from_result(&result))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Err(error) = kanna_tool_catalog::mutate_completion_context(path, |current| {
        let mut current =
            current.ok_or_else(|| format!("completion context {} disappeared", path.display()))?;
        current.spawned_run_id = Some(spawned_run_id.clone());
        current.legacy_writer = true;
        if let Some(post) = continued_post.as_ref() {
            current.run_id = post.id.clone();
        }
        for key in &keys {
            current.record_completed_attempt(&spawned_run_id, key);
        }
        Ok(current)
    }) {
        log::warn!(
            "failed to upgrade legacy completion context {}: {error}",
            path.display()
        );
    }
}

/// Resolve a retry sent by a surviving pre-upgrade adapter. Such an adapter
/// can overwrite the context without participating in the new lock/history
/// protocol after its original response is lost. The immutable filename plus
/// the database's exact completed result remains server-owned authority.
pub(crate) fn resolve_legacy_completion_retry_run(
    daemon_dir: &str,
    db: &Db,
    task_id: &str,
    presented_run_id: &str,
    attempt_key: &str,
) -> Option<String> {
    let daemon_dir = std::path::Path::new(daemon_dir);
    for directory in [
        completion_directory(daemon_dir),
        legacy_shared_completion_directory(daemon_dir),
    ] {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let Some(spawned_run_id) = spawned_run_id_from_context_path(&path) else {
                continue;
            };
            if !spawned_run_id.starts_with(&format!("run-{task_id}-")) {
                continue;
            }
            let Ok(context) = kanna_tool_catalog::read_completion_context(&path) else {
                continue;
            };
            // A historical artifact is relevant only when the submitting
            // adapter actually read (or restored) that artifact's current
            // binding. Matching completion prose alone is not lineage proof:
            // a later independent run may legitimately return the same body.
            if context.run_id != presented_run_id {
                continue;
            }
            let Ok(Some(run)) = db.stage_run(spawned_run_id) else {
                continue;
            };
            let matches_completed_attempt = run.task_id == task_id
                && matches!(run.status.as_str(), "succeeded" | "failed")
                && run.result.as_deref().is_some_and(|result| {
                    completion_attempt_keys_from_result(result)
                        .iter()
                        .any(|candidate| candidate == attempt_key)
                });
            if matches_completed_attempt {
                return Some(spawned_run_id.to_string());
            }
            // A pre-upgrade adapter can overwrite the rebound context after
            // startup and restore runId to the immutable filename run. The
            // durable same-session post relation proves that the live process
            // was continued, rather than freshly spawned; bind its new verdict
            // to that post while retaining exact retries above on the original.
            if context.run_id == presented_run_id && presented_run_id == spawned_run_id {
                if let Some(post) = continued_running_post_for_spawned_run(db, spawned_run_id) {
                    return Some(post.id);
                }
            }
        }
    }
    // The immediately preceding task-scoped format has no immutable run in
    // its filename. Only use this fallback when that legacy file itself is
    // rebound to the presented run, then reconstruct one unambiguous exact
    // result match. Two identical earlier verdicts deliberately conflict.
    let task_context_path = completion_directory(daemon_dir).join(format!("task-{task_id}.json"));
    let has_rebound_task_context = kanna_tool_catalog::read_completion_context(&task_context_path)
        .is_ok_and(|context| {
            (context.spawned_run_id.is_none() || context.legacy_writer)
                && context.run_id == presented_run_id
        });
    if !has_rebound_task_context {
        return None;
    }
    let matches = db
        .list_stage_runs_for_task(task_id)
        .ok()?
        .into_iter()
        .filter(|run| run.id != presented_run_id)
        .filter(|run| matches!(run.status.as_str(), "succeeded" | "failed"))
        .filter(|run| {
            run.result.as_deref().is_some_and(|result| {
                completion_attempt_keys_from_result(result)
                    .iter()
                    .any(|candidate| candidate == attempt_key)
            })
        })
        .map(|run| run.id)
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0].clone())
}

fn advance_server_completion_context(daemon_dir: &str, inherited_run_id: &str, new_run_id: &str) {
    let daemon_dir = std::path::Path::new(daemon_dir);
    let private_path = completion_directory(daemon_dir).join(format!("{inherited_run_id}.json"));
    let legacy_path =
        legacy_shared_completion_directory(daemon_dir).join(format!("{inherited_run_id}.json"));
    let path = if private_path.exists() {
        private_path
    } else {
        legacy_path
    };
    if let Err(error) = kanna_tool_catalog::mutate_completion_context(&path, |current| {
        let mut context =
            current.ok_or_else(|| format!("completion context {} disappeared", path.display()))?;
        if context.run_id != inherited_run_id {
            return Err(format!(
                "refusing to advance completion context {} from unexpected run {}",
                path.display(),
                context.run_id
            ));
        }
        context.run_id = new_run_id.to_string();
        Ok(context)
    }) {
        log::warn!(
            "failed to bind completion context from {inherited_run_id} to {new_run_id}: {error}"
        );
    }
}

fn uses_legacy_completion_context(daemon_dir: &str, task_id: &str, run_id: &str) -> bool {
    let daemon_dir = std::path::Path::new(daemon_dir);
    let directory = completion_directory(daemon_dir);
    let private_path = directory.join(format!("{run_id}.json"));
    if private_path.exists() {
        return kanna_tool_catalog::read_completion_context(&private_path)
            .is_ok_and(|context| context.spawned_run_id.is_none() || context.legacy_writer);
    }
    let task_path = directory.join(format!("task-{task_id}.json"));
    if task_path.exists() {
        return kanna_tool_catalog::read_completion_context(&task_path)
            .is_ok_and(|context| context.spawned_run_id.is_none() || context.legacy_writer);
    }
    let shared_path = legacy_shared_completion_directory(daemon_dir).join(format!("{run_id}.json"));
    shared_path.exists()
        && kanna_tool_catalog::read_completion_context(&shared_path)
            .is_ok_and(|context| context.spawned_run_id.is_none() || context.legacy_writer)
}

#[cfg(test)]
mod successor_retry_tests {
    use super::{
        advance_server_completion_context, fetch_terminal_carryover, initialize_completion_context,
        kill_session_replacing, legacy_shared_completion_directory,
        prune_completion_contexts_on_startup, remove_completion_contexts,
        resolve_legacy_completion_retry_run, seed_terminal_carryover,
        uses_legacy_completion_context,
    };
    use crate::daemon_client::DaemonClient;
    use crate::session_replacements::SessionReplacements;
    use kanna_daemon::protocol::{Command, ErrorCode, Event, TerminalSnapshot};
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
        let mut artifact = initialize_completion_context(
            &mut env,
            "task-main",
            "run-main",
            &daemon_dir.to_string_lossy(),
        )
        .unwrap();
        artifact.persist();
        advance_server_completion_context(&daemon_dir.to_string_lossy(), "run-main", "run-post");
        let path = std::path::PathBuf::from(
            env.get(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV)
                .unwrap(),
        );
        let context = kanna_tool_catalog::read_completion_context(&path).unwrap();
        assert_eq!(context.run_id, "run-post");
        assert_eq!(context.completed_attempt_key, None);
        std::fs::remove_dir_all(daemon_dir).unwrap();
    }

    #[test]
    fn startup_and_close_bound_completion_context_artifacts() {
        let unique = format!(
            "completion-context-prune-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(&unique);
        let completion_dir = daemon_dir.join("runtime/completion");
        std::fs::create_dir_all(&completion_dir).unwrap();
        let db_path = crate::db::Db::test_db_path(&unique);
        let db = crate::db::Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-open",
            "repo-1",
            "Open",
            Some("Open"),
            "in progress",
            "2026-08-04T00:00:00Z",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-current",
            task_id: "task-open",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-open"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();

        let current_legacy = completion_dir.join("run-task-open-current.json");
        kanna_tool_catalog::write_completion_context(
            &current_legacy,
            &kanna_tool_catalog::CompletionContext::new("run-current"),
        )
        .unwrap();
        let stale_legacy = completion_dir.join("run-task-open-stale.json");
        kanna_tool_catalog::write_completion_context(
            &stale_legacy,
            &kanna_tool_catalog::CompletionContext::new("run-stale"),
        )
        .unwrap();
        let current_task = completion_dir.join("task-task-open.json");
        kanna_tool_catalog::write_completion_context(
            &current_task,
            &kanna_tool_catalog::CompletionContext::new("run-current"),
        )
        .unwrap();
        std::fs::write(completion_dir.join("task-task-open.tmp-crash"), b"partial").unwrap();
        let closed_task = completion_dir.join("task-task-closed.json");
        kanna_tool_catalog::write_completion_context(
            &closed_task,
            &kanna_tool_catalog::CompletionContext::new("run-closed"),
        )
        .unwrap();
        let shared_dir = legacy_shared_completion_directory(&daemon_dir);
        std::fs::create_dir_all(&shared_dir).unwrap();
        let shared_stale = shared_dir.join(format!("run-task-open-{unique}.json"));
        kanna_tool_catalog::write_completion_context(
            &shared_stale,
            &kanna_tool_catalog::CompletionContext::new("run-stale"),
        )
        .unwrap();
        let foreign = shared_dir.join(format!("run-foreign-{unique}.json"));
        kanna_tool_catalog::write_completion_context(
            &foreign,
            &kanna_tool_catalog::CompletionContext::new("run-foreign"),
        )
        .unwrap();

        prune_completion_contexts_on_startup(&daemon_dir.to_string_lossy(), &db);
        assert!(current_legacy.exists());
        assert!(current_legacy.with_extension("lock").exists());
        assert!(current_task.exists());
        assert!(current_task.with_extension("lock").exists());
        assert!(!stale_legacy.exists());
        assert!(!stale_legacy.with_extension("lock").exists());
        assert!(!closed_task.exists());
        assert!(!completion_dir.join("task-task-open.tmp-crash").exists());
        assert!(!shared_stale.exists());
        assert!(!shared_stale.with_extension("lock").exists());
        assert!(foreign.exists(), "another instance's context must survive");

        remove_completion_contexts(&daemon_dir.to_string_lossy(), "task-open");
        assert!(std::fs::read_dir(&completion_dir).unwrap().next().is_none());
        drop(db);
        let _ = std::fs::remove_file(db_path);
        let _ = std::fs::remove_file(&foreign);
        let _ = std::fs::remove_file(foreign.with_extension("lock"));
        std::fs::remove_dir_all(daemon_dir).unwrap();
    }

    #[test]
    fn startup_compiles_rebound_old_format_context_from_immutable_spawn_identity() {
        let unique = format!(
            "completion-context-upgrade-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(&unique);
        let completion_dir = daemon_dir.join("runtime/completion");
        std::fs::create_dir_all(&completion_dir).unwrap();
        let db_path = crate::db::Db::test_db_path(&unique);
        let db = crate::db::Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-old",
            "repo-1",
            "Old context",
            Some("Old context"),
            "in progress",
            "2026-08-04T00:00:00Z",
        )
        .unwrap();
        let summary = "main result whose response was lost";
        let result = serde_json::json!({
            "status": "success",
            "summary": summary,
            "metadata": null,
        })
        .to_string();
        let run =
            |id: &'static str, kind: &'static str, status: &'static str| crate::db::NewStageRun {
                id,
                task_id: "task-old",
                stage: "in progress",
                kind,
                agent: Some("implement"),
                agent_provider: Some("codex"),
                model: None,
                effort: None,
                status,
                result: None,
                feedback: None,
                session_id: Some("task-old"),
                provider_session_id: None,
                cwd: None,
                resumed_from_run_id: None,
            };
        db.insert_stage_run_with_completion_binding(
            run("run-task-old-main", "main", "running"),
            None,
            true,
        )
        .unwrap();
        db.finish_stage_run(
            "run-task-old-main",
            "succeeded",
            Some(&result),
            Some(summary),
        )
        .unwrap();
        db.insert_stage_run_with_completion_binding(
            run("run-task-old-post", "post", "running"),
            None,
            true,
        )
        .unwrap();
        let path = completion_dir.join("run-task-old-main.json");
        // The old adapter's unlocked post-response write won and restored the
        // original run id even though the same process is now running a post.
        std::fs::write(&path, r#"{"runId":"run-task-old-main"}"#).unwrap();
        let attempt_key = kanna_tool_catalog::completion_attempt_key(&serde_json::json!({
            "status": "success",
            "summary": summary,
        }))
        .unwrap();

        prune_completion_contexts_on_startup(&daemon_dir.to_string_lossy(), &db);
        let upgraded = kanna_tool_catalog::read_completion_context(&path).unwrap();
        assert_eq!(
            upgraded.spawned_run_id.as_deref(),
            Some("run-task-old-main")
        );
        assert_eq!(upgraded.run_id, "run-task-old-post");
        assert!(upgraded.legacy_writer);
        assert!(uses_legacy_completion_context(
            &daemon_dir.to_string_lossy(),
            "task-old",
            "run-task-old-main",
        ));
        assert_eq!(
            upgraded.run_for_attempt(&attempt_key),
            Some("run-task-old-main")
        );

        // Even if a surviving old adapter overwrites the upgraded file, the
        // server resolves its stale successor binding from DB + filename.
        std::fs::write(&path, r#"{"runId":"run-task-old-main"}"#).unwrap();
        assert_eq!(
            resolve_legacy_completion_retry_run(
                &daemon_dir.to_string_lossy(),
                &db,
                "task-old",
                "run-task-old-main",
                &attempt_key,
            )
            .as_deref(),
            Some("run-task-old-main")
        );
        let post_attempt = kanna_tool_catalog::completion_attempt_key(&serde_json::json!({
            "status": "success",
            "summary": "commit post completed",
        }))
        .unwrap();
        assert_eq!(
            resolve_legacy_completion_retry_run(
                &daemon_dir.to_string_lossy(),
                &db,
                "task-old",
                "run-task-old-main",
                &post_attempt,
            )
            .as_deref(),
            Some("run-task-old-post")
        );

        drop(db);
        let _ = std::fs::remove_file(db_path);
        std::fs::remove_dir_all(daemon_dir).unwrap();
    }

    #[test]
    fn successor_context_is_private_and_failed_preparation_rolls_it_back() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-private-completion-context-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let mut predecessor_env = std::collections::HashMap::new();
        let mut predecessor = initialize_completion_context(
            &mut predecessor_env,
            "task-race",
            "run-task-race-main",
            &daemon_dir.to_string_lossy(),
        )
        .unwrap();
        predecessor.persist();
        let predecessor_path = std::path::PathBuf::from(
            predecessor_env
                .get(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV)
                .unwrap(),
        );

        let successor_path = {
            let mut successor_env = std::collections::HashMap::new();
            let _uncommitted = initialize_completion_context(
                &mut successor_env,
                "task-race",
                "run-task-race-successor",
                &daemon_dir.to_string_lossy(),
            )
            .unwrap();
            std::path::PathBuf::from(
                successor_env
                    .get(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV)
                    .unwrap(),
            )
        };

        assert_eq!(
            kanna_tool_catalog::read_completion_context(&predecessor_path)
                .unwrap()
                .run_id,
            "run-task-race-main"
        );
        assert!(!successor_path.exists());
        assert!(!successor_path.with_extension("lock").exists());
        std::fs::remove_dir_all(daemon_dir).unwrap();
    }

    #[tokio::test]
    async fn stage_carryover_flattens_the_outgoing_terminal_into_the_replacement_seed() {
        let daemon_dir =
            std::env::temp_dir().join(format!("kanna-stage-carryover-test-{}", std::process::id()));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let pid_path = daemon_dir.join("daemon.pid");
        let _ = std::fs::remove_file(&socket_path);
        std::fs::write(&pid_path, "41\n").unwrap();
        let listener = UnixListener::bind(&socket_path).unwrap();

        // A scripted daemon serving one connection: the outgoing session's
        // snapshot (setup output on the primary screen, a Claude-shaped TUI on
        // the alternate one), then the kill, then the history seed.
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut commands = Vec::new();
            for _ in 0..3 {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: Command = serde_json::from_str(&line).unwrap();
                let reply = match &command {
                    Command::Snapshot { session_id } => Event::Snapshot {
                        session_id: session_id.clone(),
                        snapshot: TerminalSnapshot {
                            version: 1,
                            rows: 24,
                            cols: 80,
                            cursor_row: 10,
                            cursor_col: 5,
                            cursor_visible: false,
                            saved_at: 0,
                            sequence: 0,
                            vt: "setup output\r\ndone\x1b[?1049h\x1b[2JTUI FRAME\x1b[?1002h"
                                .to_string(),
                        },
                        agent_provider: None,
                    },
                    _ => Event::Ok,
                };
                commands.push(command);
                write_half
                    .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                    .await
                    .unwrap();
                write_half.write_all(b"\n").await.unwrap();
                write_half.flush().await.unwrap();
            }
            commands
        });

        let mut daemon = DaemonClient::connect(daemon_dir.to_str().unwrap())
            .await
            .unwrap();
        daemon.set_connected_pid_for_test(41);
        let replacements = SessionReplacements::default();

        let carryover = fetch_terminal_carryover(&mut daemon, "swap-me")
            .await
            .expect("primary-screen content must produce a carryover seed");
        kill_session_replacing(&mut daemon, &replacements, "swap-me")
            .await
            .unwrap();
        seed_terminal_carryover(&mut daemon, "swap-me", &carryover).await;

        let commands = server.await.unwrap();
        assert!(
            matches!(&commands[0], Command::Snapshot { session_id } if session_id == "swap-me")
        );
        assert!(matches!(&commands[1], Command::Kill { session_id } if session_id == "swap-me"));
        let Command::SeedSnapshot {
            session_id,
            snapshot,
        } = &commands[2]
        else {
            panic!(
                "third command must be the history seed, got {:?}",
                commands[2]
            );
        };
        assert_eq!(session_id, "swap-me");
        assert!(snapshot.vt.starts_with("setup output\r\ndone"));
        assert!(!snapshot.vt.contains("\x1b[?1049h"));
        assert!(!snapshot.vt.contains("TUI FRAME"));
        assert!(!snapshot.vt.contains("\x1b[?1002h"));
        // The fetched cursor described the alt screen; the seed pins it to the
        // bottom row so the replacement's output lands below the history.
        assert_eq!(snapshot.cursor_row, 23);
        assert_eq!(snapshot.cursor_col, 0);
        assert!(snapshot.cursor_visible);
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(Path::new(&daemon_dir));
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
            replacements.consume("replace-me").replaced,
            "the one replacement marker must remain for the daemon's one Exit"
        );
        assert!(
            !replacements.consume("replace-me").replaced,
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
            !replacements.consume("replace-once").replaced,
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
    use crate::db::{NewPipelineItem, TaskEventScope};
    use kanna_daemon::protocol::{SessionInfo, SessionKind, SessionState, SessionStatus};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    fn teardown_event_db(suffix: &str, task_id: &str) -> String {
        let path = Db::test_db_path(suffix);
        let db = Db::open_for_tests(&path).unwrap();
        db.insert_test_repo("repo-teardown", "Teardown").unwrap();
        db.insert_pipeline_item(NewPipelineItem {
            id: task_id,
            repo_id: "repo-teardown",
            prompt: "test",
            display_name: None,
            pipeline: "no-review",
            stage: "in progress",
            branch: "test",
            agent_type: "developer",
            agent_provider: "claude",
            activity: "idle",
            port_offset: None,
            port_env_json: None,
            agent_spawn_options_json: None,
            base_ref: None,
            notify_task_id: None,
            parent_task_id: None,
            pipeline_def: None,
        })
        .unwrap();
        path
    }

    fn assert_teardown_event(path: &str, task_id: &str, session_id: &str, error: &str) {
        let db = Db::open(path).unwrap();
        let events = db
            .list_task_events(
                &TaskEventScope::Tasks(vec![task_id.to_string()]),
                0,
                i64::MAX,
                10,
            )
            .unwrap();
        let event = events
            .iter()
            .find(|event| event.event_type == "task.teardown_failed")
            .unwrap();
        assert_eq!(event.payload["sessionId"], session_id);
        assert_eq!(event.payload["error"], error);
    }

    #[tokio::test]
    async fn teardown_start_failure_is_persisted_in_task_event_feed() {
        let task_id = "task-teardown-start-failure";
        let session_id = "td-start-failure";
        let db_path = teardown_event_db("teardown-start-failure", task_id);
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-teardown-start-failure-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            let response = DaemonEvent::Error {
                code: None,
                message: "spawn refused".to_string(),
            };
            write
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .await
                .unwrap();
            write.write_all(b"\n").await.unwrap();
        });
        let mut daemon = DaemonClient::connect(daemon_dir.to_str().unwrap())
            .await
            .unwrap();
        spawn_prepared_workspace_teardown_best_effort(
            &mut daemon,
            Some(PreparedWorkspaceTeardown {
                session_id: session_id.to_string(),
                daemon_dir: daemon_dir.to_string_lossy().to_string(),
                db_path: db_path.clone(),
                task_id: task_id.to_string(),
                cwd: "/tmp".to_string(),
                env: std::collections::HashMap::new(),
                session: PreparedSessionSpawn::Pty {
                    executable: "/bin/sh".to_string(),
                    args: vec![],
                    cols: 80,
                    rows: 24,
                    agent_provider: kanna_daemon::protocol::AgentProvider::Claude,
                },
            }),
        )
        .await;
        server.await.unwrap();
        assert_teardown_event(
            &db_path,
            task_id,
            session_id,
            "daemon refused protected-input protocol 3: spawn refused",
        );
        let _ = std::fs::remove_file(db_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn teardown_session_is_killed_at_its_deadline() {
        let task_id = "task-teardown-deadline";
        let db_path = teardown_event_db("teardown-deadline", task_id);
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
                                logical_input_blocked: false,
                                pending_logical_input_count: None,
                                composer_text: None,
                                composer_attestation: Default::default(),
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
                db_path.clone(),
                task_id.to_string(),
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
        assert_teardown_event(&db_path, task_id, "td-task-1", "timed out after 0s");
        let _ = std::fs::remove_file(db_path);
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
                                logical_input_blocked: false,
                                pending_logical_input_count: None,
                                composer_text: None,
                                composer_attestation: Default::default(),
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
                "/tmp/kanna-missing-teardown-transient-test.db".to_string(),
                "task-transient".to_string(),
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
