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
        .send_command(&command)
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
    mut prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    let resumes_headless_provider = matches!(
        &prepared.session,
        PreparedSessionSpawn::Agent {
            resume_session_id: Some(session_id),
            ..
        } if !session_id.trim().is_empty()
    );
    if resumes_headless_provider {
        let compatibility = async {
            let capabilities = daemon
                .capabilities()
                .await
                .map_err(|error| format!("daemon capability negotiation failed: {error}"))?;
            crate::daemon_client::require_provider_resume(&capabilities)
        }
        .await;
        if let Err(error) = compatibility {
            let rollback_db_path = db_path.to_string();
            let rollback_prepared = prepared.clone();
            let rollback = tokio::task::spawn_blocking(move || {
                let db =
                    Db::open(&rollback_db_path).map_err(|e| format!("db rollback error: {e}"))?;
                rollback_prepared_task_for_api(&db, &rollback_prepared)
            })
            .await
            .map_err(|join_error| format!("task resume rollback worker failed: {join_error}"))?;
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; {rollback_error}"),
            });
        }
    }

    let run_id = generate_stage_run_id(&prepared.created_task.task_id);
    prepared
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
    let record_db_path = db_path.to_string();
    let pending = prepared.clone();
    let pending_run_id = run_id.clone();
    tokio::task::spawn_blocking(move || {
        record_spawned_stage_run(&record_db_path, &pending, &pending_run_id)
    })
    .await
    .map_err(|join_error| format!("stage run record worker failed: {join_error}"))??;

    match spawn_prepared_task_for_api(daemon, prepared.clone()).await {
        Ok(created) => {
            let record_db_path = db_path.to_string();
            tokio::task::spawn_blocking(move || {
                let db = Db::open(&record_db_path).map_err(|e| format!("db error: {e}"))?;
                db.start_stage_run(&run_id)
                    .map_err(|e| format!("db error: {e}"))
            })
            .await
            .map_err(|join_error| format!("stage run start worker failed: {join_error}"))??;
            Ok(created)
        }
        Err(error) => {
            let record_db_path = db_path.to_string();
            let failure = error.clone();
            tokio::task::spawn_blocking(move || {
                let db = Db::open(&record_db_path).map_err(|e| format!("db error: {e}"))?;
                record_prepared_task_spawn_failure(&db, &prepared, &run_id, &failure)
            })
            .await
            .map_err(|join_error| format!("spawn diagnostics worker failed: {join_error}"))??;
            Err(error)
        }
    }
}

pub(crate) async fn spawn_prepared_task_for_api_with_diagnostics(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    match spawn_prepared_task_for_api_recording_stage_run(db_path, daemon, prepared.clone()).await {
        Ok(created) => Ok(created),
        Err(err) => Err(format!(
            "task {} failed to spawn: {err}",
            prepared.created_task.task_id
        )),
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
    let teardown_session_id = prepared
        .workspace_teardown
        .as_ref()
        .map(|teardown| teardown.session_id.clone());

    if prepared.resumed_from_run_id.is_some() {
        let capabilities = daemon
            .capabilities()
            .await
            .map_err(|error| format!("daemon capability negotiation failed: {error}"))?;
        crate::daemon_client::require_provider_resume(&capabilities)?;
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

    // Establish immutable ownership before the daemon can emit lifecycle
    // events. The same token is inherited by the child process and echoed by
    // the daemon on SessionCreated, ProviderSessionChanged, and Exit.
    let run_id = generate_stage_run_id(&task_id);
    prepared
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
    if let Some(provider_session_id) = prepared.provider_session_id.as_ref() {
        prepared.env.insert(
            "KANNA_PROVIDER_SESSION_ID".to_string(),
            provider_session_id.clone(),
        );
    }
    {
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        db.insert_stage_run_with_completion_transition(
            NewStageRun {
                id: &run_id,
                task_id: &task_id,
                stage: &prepared.run_stage,
                kind: prepared.run_kind,
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                status: "pending",
                result: None,
                feedback: prepared.feedback.as_deref(),
                session_id: Some(&session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: Some(&prepared.cwd),
                resumed_from_run_id: prepared.resumed_from_run_id.as_deref(),
            },
            Some(prepared.completion_transition.as_str()),
        )
        .map_err(|e| format!("db error: {}", e))?;
    }

    // Only a freshly forked workspace is rolled back on failure; a resumed
    // workspace pre-exists this spawn and must survive it.
    if let Err(error) = kill_session_replacing_if_owned(
        daemon,
        replacements,
        &session_id,
        prepared.expected_source.process_run_id.as_deref(),
    )
    .await
    {
        return Err(fail_prepared_stage_spawn(
            db_path, &run_id, &prepared, error,
        ));
    }
    if !matches!(prepared.workspace, PreparedRunWorkspace::Current) {
        // The prewarmed shell session points at the previous worktree; kill
        // it so the next ⌘J opens in the run's workspace.
        if let Err(error) =
            kill_session_replacing(daemon, replacements, &format!("shell-wt-{task_id}")).await
        {
            return Err(fail_prepared_stage_spawn(
                db_path, &run_id, &prepared, error,
            ));
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
    let event = match daemon.send_command(&command).await {
        Ok(event) => event,
        Err(e) => {
            return Err(fail_prepared_stage_spawn(
                db_path,
                &run_id,
                &prepared,
                format!("daemon error: {}", e),
            ))
        }
    };
    match event {
        DaemonEvent::SessionCreated {
            run_id: Some(created_run_id),
            ..
        } if created_run_id == run_id => {}
        DaemonEvent::SessionCreated { run_id: None, .. }
            if prepared.resumed_from_run_id.is_none() => {}
        DaemonEvent::SessionCreated {
            run_id: created_run_id,
            ..
        } => {
            let ownership_error = format!(
                "daemon returned mismatched run ownership (expected {run_id}, got {created_run_id:?})"
            );
            if let Err(cleanup_error) =
                kill_session_replacing(daemon, replacements, &session_id).await
            {
                log::warn!(
                    "failed to clean up mismatched stage session {session_id}: {cleanup_error}"
                );
            }
            return Err(fail_prepared_stage_spawn(
                db_path,
                &run_id,
                &prepared,
                ownership_error,
            ));
        }
        DaemonEvent::Error { message, .. } => {
            return Err(fail_prepared_stage_spawn(
                db_path,
                &run_id,
                &prepared,
                format!("daemon error: {}", message),
            ))
        }
        other => {
            return Err(fail_prepared_stage_spawn(
                db_path,
                &run_id,
                &prepared,
                format!("unexpected daemon response: {:?}", other),
            ))
        }
    }

    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    let worktree_id = format!("wt-{task_id}");
    let (branch, worktree) = match &prepared.workspace {
        PreparedRunWorkspace::Forked(workspace) | PreparedRunWorkspace::Resumed(workspace) => (
            Some(workspace.branch.as_str()),
            Some((
                worktree_id.as_str(),
                workspace.worktree_path.as_str(),
                workspace.branch.as_str(),
            )),
        ),
        PreparedRunWorkspace::Current => (None, None),
    };
    if let Err(error) = db.land_stage_run(&task_id, &run_id, &prepared.next_stage, branch, worktree)
    {
        if let Err(kill_error) = kill_session_replacing(daemon, replacements, &session_id).await {
            log::warn!("failed to clean up unlanded stage session {session_id}: {kill_error}");
        }
        let message = format!("task {task_id} stage transition could not land: {error}");
        return Err(if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
            rollback_closed_stage_spawn(db_path, &run_id, &prepared, message)
        } else {
            fail_prepared_stage_spawn(db_path, &run_id, &prepared, message)
        });
    }

    spawn_prepared_workspace_teardown_best_effort(daemon, prepared.workspace_teardown).await;

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    })
}

fn fail_prepared_stage_spawn(
    db_path: &str,
    run_id: &str,
    prepared: &PreparedStageRunSpawn,
    error: String,
) -> String {
    let recorded_error = match Db::open(db_path).and_then(|db| {
        db.finish_stage_run(run_id, "failed", Some(&error), Some("stage spawn failed"))
    }) {
        Ok(()) => error,
        Err(db_error) => format!("{error}; failed to record stage spawn failure: {db_error}"),
    };
    rollback_prepared_stage_fork(prepared, recorded_error)
}

fn rollback_closed_stage_spawn(
    db_path: &str,
    run_id: &str,
    prepared: &PreparedStageRunSpawn,
    error: String,
) -> String {
    let rollback_error = match Db::open(db_path)
        .and_then(|db| db.delete_unstarted_stage_run_and_restore_provider_session_id(run_id))
    {
        Ok(()) => error,
        Err(db_error) => format!("{error}; failed to roll back unstarted stage run: {db_error}"),
    };
    rollback_prepared_stage_fork(prepared, rollback_error)
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
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );
    match daemon.send_command(&command).await {
        Ok(DaemonEvent::SessionCreated { .. }) => {}
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
            let completion_owner_run_id = inherited.as_ref().map(|run| {
                if run.kind == "post" {
                    run.resumed_from_run_id
                        .clone()
                        .unwrap_or_else(|| run.id.clone())
                } else {
                    run.id.clone()
                }
            });
            db.finish_latest_running_stage_run(&task_id, "succeeded", None, None)
                .map_err(|e| format!("db error: {}", e))?;
            // The post continues the inherited run's live agent session, so
            // its provider session id and cwd carry over too.
            let (agent, agent_provider, model, provider_session_id, cwd) = match inherited {
                Some(run) => (
                    run.agent,
                    run.agent_provider,
                    run.model,
                    run.provider_session_id,
                    run.cwd,
                ),
                None => (
                    prepared.fallback.stage_agent.clone(),
                    Some(prepared.fallback.agent_provider.clone()),
                    prepared.fallback.model.clone(),
                    None,
                    Some(prepared.fallback.cwd.clone()),
                ),
            };
            let run_id = generate_stage_run_id(&task_id);
            db.insert_stage_run_with_completion_transition(
                NewStageRun {
                    id: &run_id,
                    task_id: &task_id,
                    stage: &prepared.run_stage,
                    kind: "post",
                    agent: agent.as_deref(),
                    agent_provider: agent_provider.as_deref(),
                    model: model.as_deref(),
                    status: "running",
                    result: None,
                    feedback: None,
                    session_id: Some(&prepared.session_id),
                    provider_session_id: provider_session_id.as_deref(),
                    cwd: cwd.as_deref(),
                    // The live process cannot change its immutable environment
                    // when a post is injected. Record the main run that owns
                    // this post so its CLI-shaped verdict remains authorized.
                    resumed_from_run_id: completion_owner_run_id.as_deref(),
                },
                Some(prepared.fallback.completion_transition.as_str()),
            )
            .map_err(|e| format!("db error: {}", e))?;
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
    let completion_transition = prepared.completion_transition;
    let provider_session_id = prepared.provider_session_id.clone();
    let cwd = prepared.cwd.clone();
    {
        // Reruns cancel whatever was running before the kill, for the same
        // reason stage swaps finish it first: the run record must never
        // claim a dead session is still running.
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        db.cancel_running_stage_runs(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
    }
    kill_session_replacing(daemon, replacements, &session_id).await?;

    let run_id = generate_stage_run_id(&task_id);
    prepared
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
    record_rerun_stage_run(
        db_path,
        &run_id,
        &task_id,
        &stage,
        run_kind,
        stage_agent.as_deref(),
        &agent_provider,
        model.as_deref(),
        completion_transition.as_str(),
        &session_id,
        provider_session_id.as_deref(),
        &cwd,
        "pending",
    )?;
    let record_failure = |error: String| match record_rerun_stage_failure(
        db_path, &run_id, &task_id, &stage, &error,
    ) {
        Ok(()) => error,
        Err(record_error) => {
            format!("{error}; failed to record stage rerun failure: {record_error}")
        }
    };
    if let Err(error) = kill_session_replacing_if_owned(
        daemon,
        replacements,
        &session_id,
        prepared.expected_source.process_run_id.as_deref(),
    )
    .await
    {
        return Err(record_failure(error));
    }
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

    let event = match daemon.send_command(&command).await {
        Ok(event) => event,
        Err(error) => return Err(record_failure(format!("daemon error: {error}"))),
    };
    match event {
        DaemonEvent::SessionCreated {
            run_id: Some(created_run_id),
            ..
        } if created_run_id == run_id => {
            start_rerun_stage_run(db_path, &run_id, &task_id, provider_session_id.as_deref())?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        DaemonEvent::SessionCreated { run_id: None, .. } => {
            start_rerun_stage_run(db_path, &run_id, &task_id, provider_session_id.as_deref())?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        DaemonEvent::SessionCreated {
            run_id: created_run_id,
            ..
        } => {
            let mut error = format!(
                "daemon returned mismatched run ownership (expected {run_id}, got {created_run_id:?})"
            );
            if let Err(kill_error) = kill_session_replacing(daemon, replacements, &session_id).await
            {
                error.push_str(&format!(
                    "; failed to kill mismatched session: {kill_error}"
                ));
            }
            Err(record_failure(error))
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
    kill_session_replacing_if_owned(daemon, replacements, session_id, None).await
}

pub(crate) async fn kill_session_replacing_if_owned(
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    session_id: &str,
    expected_run_id: Option<&str>,
) -> Result<(), String> {
    replacements.begin_for_run(session_id, expected_run_id);
    let mut kill = daemon
        .send_command(&DaemonCommand::Kill {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|e| {
            replacements.cancel(session_id);
            format!("daemon error: {}", e)
        })?;
    if matches!(
        kill,
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionOwnershipMismatch),
            ..
        }
    ) && expected_run_id.is_some()
    {
        let capabilities = daemon
            .send_command(&DaemonCommand::List)
            .await
            .map_err(|error| {
                replacements.cancel(session_id);
                format!("daemon capability negotiation failed after ownership mismatch: {error}")
            })?;
        if matches!(
            capabilities,
            DaemonEvent::SessionList {
                ref sessions,
                capabilities: Some(ref capabilities),
                ..
            } if !capabilities.immutable_run_ownership
                && sessions.iter().any(|session| {
                    session.session_id == session_id && session.run_id.is_none()
                })
        ) {
            kill = daemon
                .send_command(&DaemonCommand::Kill {
                    session_id: session_id.to_string(),
                    expected_run_id: None,
                })
                .await
                .map_err(|error| {
                    replacements.cancel(session_id);
                    format!("daemon error after legacy ownership negotiation: {error}")
                })?;
        }
    }
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
            permission_mode,
            allowed_tools,
            disallowed_tools,
            max_turns,
            max_budget_usd,
            system_prompt,
            mcp_config_path,
            executable,
            resume_session_id,
        } => DaemonCommand::SpawnAgent {
            session_id,
            params: AgentSpawnParams {
                agent_provider,
                prompt,
                cwd,
                env,
                model,
                permission_mode,
                allowed_tools,
                disallowed_tools,
                max_turns,
                max_budget_usd,
                system_prompt: Some(system_prompt),
                mcp_config_path,
                executable,
                resume_session_id,
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
        db.insert_stage_run_with_completion_transition(
            NewStageRun {
                id: run_id,
                task_id: &prepared.created_task.task_id,
                stage: &prepared.created_task.stage,
                kind: "main",
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                status: "pending",
                result: None,
                feedback: None,
                session_id: Some(&prepared.session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: Some(&prepared.cwd),
                resumed_from_run_id: None,
            },
            Some(prepared.completion_transition.as_str()),
        )?;
        db.delete_create_task_intent(&prepared.created_task.task_id)
    })
    .map_err(|e| format!("db error: {}", e))
}

fn record_prepared_task_spawn_failure(
    db: &Db,
    prepared: &PreparedTaskSpawn,
    run_id: &str,
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
    db.finish_stage_run(run_id, "failed", Some(&result), Some("task spawn failed"))
        .map_err(|e| format!("db error: {}", e))
}

#[allow(clippy::too_many_arguments)]
fn record_rerun_stage_run(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    stage: &str,
    run_kind: &'static str,
    stage_agent: Option<&str>,
    agent_provider: &str,
    model: Option<&str>,
    completion_transition: &str,
    session_id: &str,
    provider_session_id: Option<&str>,
    cwd: &str,
    status: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.with_immediate_transaction(|db| {
        db.insert_stage_run_with_completion_transition(
            NewStageRun {
                id: run_id,
                task_id,
                stage,
                kind: run_kind,
                agent: stage_agent,
                agent_provider: Some(agent_provider),
                model,
                status,
                result: None,
                feedback: None,
                session_id: Some(session_id),
                provider_session_id,
                cwd: Some(cwd),
                resumed_from_run_id: None,
            },
            Some(completion_transition),
        )?;
        db.delete_create_task_intent(task_id)
    })
    .map_err(|e| format!("db error: {}", e))
}

fn start_rerun_stage_run(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    provider_session_id: Option<&str>,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, provider_session_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.start_stage_run(run_id)
        .map_err(|e| format!("db error: {}", e))
}

fn record_rerun_stage_failure(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    stage: &str,
    error: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, None)
        .map_err(|e| format!("db error: {}", e))?;
    let result = format!("failed to rerun stage {stage}: {error}");
    db.finish_stage_run(run_id, "failed", Some(&result), Some("stage rerun failed"))
        .map_err(|e| format!("db error: {}", e))
}

fn generate_stage_run_id(task_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("run-{task_id}-{nanos}")
}
