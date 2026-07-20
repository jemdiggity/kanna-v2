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
use kanna_daemon::protocol::{AgentSpawnParams, Command as DaemonCommand, Event as DaemonEvent};

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
    let created = spawn_prepared_task_for_api(daemon, prepared.clone()).await?;
    record_spawned_stage_run(db_path, &prepared)?;
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
            let db = Db::open(db_path)
                .map_err(|open_err| format!("{err}; diagnostics failed: db error: {open_err}"))?;
            record_prepared_task_spawn_failure(&db, &prepared, &err)
                .map_err(|record_err| format!("{err}; diagnostics failed: {record_err}"))?;
            Err(format!(
                "task {} failed to spawn: {err}",
                prepared.created_task.task_id
            ))
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
    prepared: PreparedStageRunSpawn,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();
    let teardown_session_id = prepared
        .workspace_teardown
        .as_ref()
        .map(|teardown| teardown.session_id.clone());

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
    let event = match daemon.send_command(&command).await {
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
    let run_id = generate_stage_run_id(&task_id);
    db.insert_stage_run_with_completion_transition(
        NewStageRun {
            id: &run_id,
            task_id: &task_id,
            stage: &prepared.run_stage,
            kind: prepared.run_kind,
            agent: prepared.stage_agent.as_deref(),
            agent_provider: Some(prepared.agent_provider.as_str()),
            model: prepared.model.as_deref(),
            status: "running",
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

    spawn_prepared_workspace_teardown_best_effort(daemon, prepared.workspace_teardown).await;

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    })
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
                    resumed_from_run_id: None,
                },
                Some(prepared.fallback.completion_transition.as_str()),
            )
            .map_err(|e| format!("db error: {}", e))?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
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
    let record_failure = |error: String| match record_rerun_stage_failure(
        db_path,
        &task_id,
        &stage,
        run_kind,
        stage_agent.as_deref(),
        &agent_provider,
        model.as_deref(),
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
        DaemonEvent::SessionCreated { .. } => {
            record_rerun_stage_run(
                db_path,
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
            )?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
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
        .send_command(&DaemonCommand::Kill {
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

fn record_spawned_stage_run(db_path: &str, prepared: &PreparedTaskSpawn) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(
        &prepared.created_task.task_id,
        prepared.provider_session_id.as_deref(),
    )
    .map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_stage_run_id(&prepared.created_task.task_id);
    db.insert_stage_run_with_completion_transition(
        NewStageRun {
            id: &run_id,
            task_id: &prepared.created_task.task_id,
            stage: &prepared.created_task.stage,
            kind: "main",
            agent: prepared.stage_agent.as_deref(),
            agent_provider: Some(prepared.agent_provider.as_str()),
            model: prepared.model.as_deref(),
            status: "running",
            result: None,
            feedback: None,
            session_id: Some(&prepared.session_id),
            provider_session_id: prepared.provider_session_id.as_deref(),
            cwd: Some(&prepared.cwd),
            resumed_from_run_id: None,
        },
        Some(prepared.completion_transition.as_str()),
    )
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
    completion_transition: &str,
    session_id: &str,
    provider_session_id: Option<&str>,
    cwd: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "working")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, provider_session_id)
        .map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_stage_run_id(task_id);
    db.insert_stage_run_with_completion_transition(
        NewStageRun {
            id: &run_id,
            task_id,
            stage,
            kind: run_kind,
            agent: stage_agent,
            agent_provider: Some(agent_provider),
            model,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some(session_id),
            provider_session_id,
            cwd: Some(cwd),
            resumed_from_run_id: None,
        },
        Some(completion_transition),
    )
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
