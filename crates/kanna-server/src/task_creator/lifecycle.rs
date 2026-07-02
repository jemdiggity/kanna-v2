use super::types::{
    CreatedTask, PreparedSessionSpawn, PreparedStageRerun, PreparedStageRunSpawn, PreparedTaskSpawn,
};
use super::worktree::remove_prepared_worktree;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, NewStageRun};
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

/// Spawn a new stage run in place on an existing task: kill the previous
/// stage's agent session, respawn the same daemon session id with the target
/// stage's agent, and transition `pipeline_item.stage` on the same task. The
/// task keeps its id, branch, and worktree.
pub(crate) async fn spawn_prepared_stage_run_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedStageRunSpawn,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();

    kill_session_if_present(daemon, &session_id).await?;

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
        DaemonEvent::SessionCreated { .. } => {}
        DaemonEvent::Error { message, .. } => return Err(format!("daemon error: {}", message)),
        other => return Err(format!("unexpected daemon response: {:?}", other)),
    }

    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    // A manual advance can leave the previous stage's run open (no explicit
    // agent verdict); moving forward treats that work as accepted. Revision
    // paths mark the previous run failed before preparing the new run.
    db.finish_latest_running_stage_run(&task_id, "succeeded", None, None)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_stage(&task_id, &prepared.next_stage)
        .map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_stage_run_id(&task_id);
    db.insert_stage_run(NewStageRun {
        id: &run_id,
        task_id: &task_id,
        stage: &prepared.next_stage,
        agent: prepared.stage_agent.as_deref(),
        agent_provider: Some(prepared.agent_provider.as_str()),
        model: prepared.model.as_deref(),
        status: "running",
        result: None,
        feedback: prepared.feedback.as_deref(),
        session_id: Some(&session_id),
    })
    .map_err(|e| format!("db error: {}", e))?;

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    })
}

pub(crate) async fn rerun_prepared_stage_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedStageRerun,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let task_id = prepared.task_id.clone();
    let session_id = prepared.session_id.clone();
    let stage = prepared.stage.clone();
    let stage_agent = prepared.stage_agent.clone();
    let agent_provider = prepared.agent_provider.clone();
    let model = prepared.model.clone();
    kill_session_if_present(daemon, &session_id).await?;

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

async fn kill_session_if_present(
    daemon: &mut DaemonClient,
    session_id: &str,
) -> Result<(), String> {
    let kill = daemon
        .send_command(&DaemonCommand::Kill {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    match kill {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => Ok(()),
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            Ok(())
        }
        DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
        other => Err(format!("unexpected daemon response: {:?}", other)),
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

fn record_rerun_stage_run(
    db_path: &str,
    task_id: &str,
    stage: &str,
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
