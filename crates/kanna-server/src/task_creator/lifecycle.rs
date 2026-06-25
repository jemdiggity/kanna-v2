use super::types::{CreatedTask, PreparedSessionSpawn, PreparedStageContinue, PreparedTaskSpawn};
use super::worktree::remove_prepared_worktree;
use crate::daemon_client::DaemonClient;
use crate::db::Db;
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
    let command = match prepared.session {
        PreparedSessionSpawn::Pty {
            executable,
            args,
            cols,
            rows,
            agent_provider,
        } => DaemonCommand::Spawn {
            session_id: prepared.session_id,
            executable,
            args,
            cwd: prepared.cwd,
            env: prepared.env,
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
            session_id: prepared.session_id,
            params: AgentSpawnParams {
                agent_provider,
                prompt,
                cwd: prepared.cwd,
                env: prepared.env,
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
    };

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

pub(crate) async fn spawn_prepared_task_for_api_with_rollback(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    match spawn_prepared_task_for_api(daemon, prepared.clone()).await {
        Ok(created) => Ok(created),
        Err(err) => {
            let db = Db::open(db_path)
                .map_err(|db_err| format!("{err}; rollback failed: db error: {db_err}"))?;
            match rollback_prepared_task_for_api(&db, &prepared) {
                Ok(()) => Err(err),
                Err(rollback_err) => Err(format!("{err}; rollback failed: {rollback_err}")),
            }
        }
    }
}

pub(crate) async fn continue_prepared_stage_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedStageContinue,
) -> Result<crate::mobile_api::TaskActionResponse, String> {
    let session_id = {
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        let session_id = db
            .resolve_task_terminal_session_id(&prepared.task_id)
            .map_err(|e| format!("db error: {}", e))?
            .ok_or_else(|| format!("task not found: {}", prepared.task_id))?;
        if let Some(active_post_action) = prepared.active_post_action.as_deref() {
            db.update_pipeline_item_active_post_action(&prepared.task_id, active_post_action)
                .map_err(|e| format!("db error: {}", e))?;
            if let Err(err) = db.clear_pipeline_item_stage_result(&prepared.task_id) {
                let _ = db.update_pipeline_item_post_action_state(
                    &prepared.task_id,
                    prepared.previous_active_post_action.as_deref(),
                    prepared.previous_stage_result.as_deref(),
                );
                return Err(format!("db error: {}", err));
            }
        } else {
            db.update_pipeline_item_stage(&prepared.task_id, &prepared.next_stage)
                .map_err(|e| format!("db error: {}", e))?;
            if let Err(err) = db.clear_pipeline_item_stage_result(&prepared.task_id) {
                let _ = db.update_pipeline_item_stage(&prepared.task_id, &prepared.previous_stage);
                return Err(format!("db error: {}", err));
            }
        }
        session_id
    };

    let command = match prepared.agent_type.as_str() {
        "agent" => DaemonCommand::AgentInput {
            session_id,
            text: prepared.input_text.clone(),
        },
        _ => DaemonCommand::Input {
            session_id,
            data: prepared.input,
        },
    };

    let event = daemon.send_command(&command).await.map_err(|e| {
        let _ = rollback_continue_stage(
            db_path,
            &prepared.task_id,
            &prepared.previous_stage,
            prepared.previous_stage_result.as_deref(),
            prepared.previous_active_post_action.as_deref(),
        );
        format!("daemon error: {}", e)
    })?;

    match event {
        DaemonEvent::Ok => Ok(crate::mobile_api::TaskActionResponse {
            task_id: prepared.task_id,
        }),
        DaemonEvent::Error { message, .. } => {
            let _ = rollback_continue_stage(
                db_path,
                &prepared.task_id,
                &prepared.previous_stage,
                prepared.previous_stage_result.as_deref(),
                prepared.previous_active_post_action.as_deref(),
            );
            Err(format!("daemon error: {}", message))
        }
        other => {
            let _ = rollback_continue_stage(
                db_path,
                &prepared.task_id,
                &prepared.previous_stage,
                prepared.previous_stage_result.as_deref(),
                prepared.previous_active_post_action.as_deref(),
            );
            Err(format!("unexpected daemon response: {:?}", other))
        }
    }
}

fn rollback_continue_stage(
    db_path: &str,
    task_id: &str,
    previous_stage: &str,
    previous_stage_result: Option<&str>,
    previous_active_post_action: Option<&str>,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_stage_state(task_id, previous_stage, previous_stage_result)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_post_action_state(
        task_id,
        previous_active_post_action,
        previous_stage_result,
    )
    .map_err(|e| format!("db error: {}", e))
}
