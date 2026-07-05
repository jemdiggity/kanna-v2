use super::types::{
    CreatedTask, PreparedPostDispatch, PreparedSessionSpawn, PreparedStageRerun,
    PreparedStageRunSpawn, PreparedTaskSpawn, PreparedWorkspaceTeardown,
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

pub(crate) async fn spawn_prepared_task_for_api_with_rollback(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    match spawn_prepared_task_for_api_recording_stage_run(db_path, daemon, prepared.clone()).await {
        Ok(created) => Ok(created),
        Err(err) => {
            let db = Db::open(db_path)
                .map_err(|open_err| format!("{err}; rollback failed: db error: {open_err}"))?;
            match rollback_prepared_task_for_api(&db, &prepared) {
                Ok(()) => Err(err),
                Err(rollback_err) => Err(format!("{err}; rollback failed: {rollback_err}")),
            }
        }
    }
}

/// Spawn a new stage run on an existing task: kill the previous stage's
/// agent session and respawn the same daemon session id with the target
/// stage's agent. A stage transition runs in a freshly forked workspace
/// (`forked_workspace`: new branch + worktree from the committed tip) and
/// moves `pipeline_item.branch` with it; post fallbacks and reruns keep the
/// task's current workspace. The task id never changes.
pub(crate) async fn spawn_prepared_stage_run_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    prepared: PreparedStageRunSpawn,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();

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

    let rollback_fork = |error: String| -> String {
        if let Some(fork) = &prepared.forked_workspace {
            if let Err(rollback_err) = remove_prepared_worktree(&fork.worktree_path, &fork.branch) {
                return format!("{error}; fork rollback failed: {rollback_err}");
            }
        }
        error
    };

    if let Err(error) = kill_session_replacing(daemon, replacements, &session_id).await {
        return Err(rollback_fork(error));
    }
    if prepared.forked_workspace.is_some() {
        // The prewarmed shell session points at the previous worktree; kill
        // it so the next ⌘J opens in the forked one.
        if let Err(error) =
            kill_session_replacing(daemon, replacements, &format!("shell-wt-{task_id}")).await
        {
            return Err(rollback_fork(error));
        }
    }

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd.clone(),
        prepared.env,
        prepared.session,
    );
    let event = match daemon.send_command(&command).await {
        Ok(event) => event,
        Err(e) => return Err(rollback_fork(format!("daemon error: {}", e))),
    };
    match event {
        DaemonEvent::SessionCreated { .. } => {}
        DaemonEvent::Error { message, .. } => {
            return Err(rollback_fork(format!("daemon error: {}", message)))
        }
        other => {
            return Err(rollback_fork(format!(
                "unexpected daemon response: {:?}",
                other
            )))
        }
    }

    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    match &prepared.forked_workspace {
        Some(fork) => {
            db.update_pipeline_item_stage_and_branch(&task_id, &prepared.next_stage, &fork.branch)
                .map_err(|e| format!("db error: {}", e))?;
            db.upsert_worktree(
                &format!("wt-{task_id}"),
                &task_id,
                &fork.worktree_path,
                &fork.branch,
            )
            .map_err(|e| format!("db error: {}", e))?;
        }
        None => {
            db.update_pipeline_item_stage(&task_id, &prepared.next_stage)
                .map_err(|e| format!("db error: {}", e))?;
        }
    }
    let run_id = generate_stage_run_id(&task_id);
    db.insert_stage_run(NewStageRun {
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
    })
    .map_err(|e| format!("db error: {}", e))?;

    // The workspace the swap left behind gets its teardown last, once the
    // transition is durable. Best-effort: a teardown that fails to start
    // must never fail a transition that already happened.
    if let Some(teardown) = prepared.workspace_teardown {
        if let Err(error) = spawn_workspace_teardown_for_api(daemon, teardown).await {
            log::warn!("workspace teardown for task {task_id} failed to start: {error}");
        }
    }

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    })
}

/// Spawn a prepared workspace-teardown session in the daemon. Best-effort by
/// contract: callers log failures and continue — cleanup must never fail the
/// transition or close that triggered it.
pub(crate) async fn spawn_workspace_teardown_for_api(
    daemon: &mut DaemonClient,
    teardown: PreparedWorkspaceTeardown,
) -> Result<(), String> {
    let command = DaemonCommand::Spawn {
        session_id: teardown.session_id,
        executable: "/bin/zsh".to_string(),
        args: vec![
            "--login".to_string(),
            "-i".to_string(),
            "-c".to_string(),
            teardown.command,
        ],
        cwd: teardown.cwd,
        env: teardown.env,
        cols: 120,
        rows: 30,
        agent_provider: None,
    };
    let event = daemon
        .send_command(&command)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    match event {
        DaemonEvent::SessionCreated { .. } => Ok(()),
        DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
        other => Err(format!("unexpected daemon response: {:?}", other)),
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
            let (agent, agent_provider, model) = match inherited {
                Some(run) => (run.agent, run.agent_provider, run.model),
                None => (
                    prepared.fallback.stage_agent.clone(),
                    Some(prepared.fallback.agent_provider.clone()),
                    prepared.fallback.model.clone(),
                ),
            };
            let run_id = generate_stage_run_id(&task_id);
            db.insert_stage_run(NewStageRun {
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
            })
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
    prepared: PreparedStageRerun,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();
    let stage = prepared.stage.clone();
    let run_kind = prepared.run_kind;
    let stage_agent = prepared.stage_agent.clone();
    let agent_provider = prepared.agent_provider.clone();
    let model = prepared.model.clone();
    {
        // Reruns cancel whatever was running before the kill, for the same
        // reason stage swaps finish it first: the run record must never
        // claim a dead session is still running.
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        db.cancel_running_stage_runs(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
    }
    kill_session_replacing(daemon, replacements, &session_id).await?;

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd,
        prepared.env,
        prepared.session,
    );

    let event = daemon
        .send_command(&command)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
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
                &session_id,
            )?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
            })
        }
        DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
        other => Err(format!("unexpected daemon response: {:?}", other)),
    }
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
        },
        PreparedSessionSpawn::Agent {
            agent_provider,
            prompt,
            model,
            permission_mode,
            allowed_tools,
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
                disallowed_tools: Vec::new(),
                max_turns: None,
                max_budget_usd: None,
                system_prompt: Some(system_prompt),
                mcp_config_path,
                executable,
            },
        },
    }
}

fn record_spawned_stage_run(db_path: &str, prepared: &PreparedTaskSpawn) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_stage_run_id(&prepared.created_task.task_id);
    db.insert_stage_run(NewStageRun {
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
    session_id: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_stage_run_id(task_id);
    db.insert_stage_run(NewStageRun {
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
