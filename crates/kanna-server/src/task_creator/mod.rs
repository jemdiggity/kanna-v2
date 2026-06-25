mod commands;
mod continuation;
mod definitions;
mod environment;
mod lifecycle;
mod prompt;
mod provider;
mod types;
mod worktree;

#[cfg(test)]
mod tests;

use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, NewPipelineItem, Repo, TaskStageSource};
use commands::{build_agent_command, build_kanna_preamble, build_task_shell_command};
use continuation::{prepare_continue_stage, prepare_post_action_stage};
use definitions::{
    read_agent_definition, read_pipeline_definition, read_repo_config, PipelineStageMode,
};
use environment::{
    build_spawn_env, claim_task_ports, resolve_headless_agent_executable, write_kanna_mcp_config,
};
use lifecycle::spawn_prepared_task;
use prompt::{
    build_post_action_prompt, build_stage_prompt, build_target_stage_prompt, PromptContext,
};
use provider::{
    normalize_agent_type, resolve_agent_provider, resolve_agent_type, AgentSessionType,
};
use types::{CreatedTask, PreparedSessionSpawn, TaskCreationRequest};
pub(crate) use types::{PreparedStageTransition, PreparedTaskSpawn};
use worktree::{
    create_worktree, fetch_start_point, generate_task_id, resolve_current_source_worktree_branch,
};

pub(crate) use lifecycle::{
    continue_prepared_stage_for_api, prepared_task_id, rollback_prepared_task_for_api,
    spawn_prepared_task_for_api, spawn_prepared_task_for_api_with_rollback,
};

pub async fn run_merge_agent(
    db: &Db,
    daemon: &mut DaemonClient,
    config: &Config,
    source_task_id: &str,
) -> Result<String, String> {
    let prepared = prepare_merge_agent_for_api(db, config, source_task_id)?;
    spawn_prepared_task(daemon, prepared)
        .await
        .map(|created| created.task_id)
}

pub(crate) fn prepare_merge_agent_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
) -> Result<PreparedTaskSpawn, String> {
    let source_task = db
        .get_pipeline_item(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
    let repo = db
        .get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", source_task_id))?;

    let merge_agent = read_agent_definition(&repo.path, "merge")?;
    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt: merge_agent.prompt,
            display_name: None,
            pipeline_name: None,
            base_ref: None,
            stored_base_ref: None,
            stage_override: None,
            explicit_provider: None,
            default_provider: None,
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            notify_task_id: None,
        },
    )
}

pub(crate) fn prepare_advance_stage_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
) -> Result<PreparedStageTransition, String> {
    let source_task = db
        .get_task_stage_source(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
    if source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", source_task_id));
    }
    let repo = db
        .get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", source_task_id))?;

    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let current_stage_name = source_task
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", source_task_id))?;
    let pipeline = read_pipeline_definition(&repo.path, &pipeline_name)?;
    let current_stage_index = pipeline
        .stages
        .iter()
        .position(|stage| stage.name == current_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", current_stage_name))?;
    let current_stage = &pipeline.stages[current_stage_index];
    let source_branch =
        resolve_current_source_worktree_branch(&repo.path, source_task.branch.as_deref());
    let display_name = resolve_inherited_task_title(db, &source_task)?;

    if source_task.active_post_action.is_none() {
        if let Some(post_action) = current_stage.post_action.as_ref() {
            let task_prompt = build_post_action_prompt(
                &repo.path,
                post_action,
                source_task.prompt.as_deref().unwrap_or(""),
                source_task.stage_result.as_deref(),
                source_branch.as_deref(),
                source_task.base_ref.as_deref(),
                source_task.branch.as_deref(),
            )?;
            return Ok(PreparedStageTransition::Continue(Box::new(
                prepare_post_action_stage(
                    source_task_id,
                    &current_stage_name,
                    post_action,
                    source_task.stage_result.clone(),
                    &task_prompt,
                    source_task.branch.as_deref(),
                    normalize_agent_type(source_task.agent_type.as_deref()).unwrap_or("pty"),
                    post_action
                        .agent_provider
                        .as_deref()
                        .or(source_task.agent_provider.as_deref()),
                )?,
            )));
        }
    }

    let next_stage = pipeline
        .stages
        .get(current_stage_index + 1)
        .ok_or_else(|| format!("task already at final stage: {}", current_stage_name))?;

    let task_prompt = build_target_stage_prompt(
        &repo.path,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        source_task.stage_result.as_deref(),
        source_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
    )?;
    let explicit_provider = if next_stage.agent.is_some() {
        None
    } else {
        source_task.agent_provider.clone()
    };

    if next_stage.mode == Some(PipelineStageMode::Continue) {
        return Ok(PreparedStageTransition::Continue(Box::new(
            prepare_continue_stage(
                source_task_id,
                &current_stage_name,
                &next_stage.name,
                source_task.stage_result.clone(),
                &task_prompt,
                source_task.branch.as_deref(),
                normalize_agent_type(source_task.agent_type.as_deref()).unwrap_or("pty"),
                source_task.agent_provider.as_deref(),
            )?,
        )));
    }

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt,
            display_name,
            pipeline_name: Some(pipeline_name),
            base_ref: source_branch,
            stored_base_ref: source_task.base_ref,
            stage_override: Some(next_stage.name.clone()),
            explicit_provider,
            default_provider: None,
            agent_type: source_task.agent_type,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            notify_task_id: None,
        },
    )
    .map(|spawn| PreparedStageTransition::Spawn(Box::new(spawn)))
}

fn resolve_inherited_task_title(
    db: &Db,
    source_task: &TaskStageSource,
) -> Result<Option<String>, String> {
    if let Some(title) = non_empty_string(source_task.display_name.clone()) {
        return Ok(Some(title));
    }
    if let Some(title) = non_empty_string(source_task.issue_title.clone()) {
        return Ok(Some(title));
    }
    if let Some(reviewed_branch) =
        extract_reviewed_branch_from_prompt(source_task.prompt.as_deref().unwrap_or(""))
    {
        if let Some(title) = db
            .get_pipeline_item_title_by_repo_branch(&source_task.repo_id, reviewed_branch)
            .map_err(|e| format!("db error: {}", e))?
        {
            return Ok(Some(title));
        }
    }
    Ok(non_empty_string(source_task.prompt.clone()))
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.filter(|candidate| !candidate.trim().is_empty())
}

fn extract_reviewed_branch_from_prompt(prompt: &str) -> Option<&str> {
    let marker = "Review branch ";
    let after_marker = prompt.split_once(marker)?.1;
    let branch = after_marker
        .split_whitespace()
        .next()?
        .trim_matches(|ch: char| matches!(ch, ',' | '.' | ':' | ';'));
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

pub(crate) fn prepare_auto_stage_completion_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
) -> Result<Option<PreparedStageTransition>, String> {
    let source_task = db
        .get_task_stage_source(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
    if source_task.closed_at.is_some() {
        return Ok(None);
    }
    let repo = db
        .get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", source_task_id))?;

    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let current_stage_name = source_task
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", source_task_id))?;
    let pipeline = read_pipeline_definition(&repo.path, &pipeline_name)?;
    let current_stage_index = pipeline
        .stages
        .iter()
        .position(|stage| stage.name == current_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", current_stage_name))?;
    let current_stage = &pipeline.stages[current_stage_index];
    if let Some(active_post_action) = source_task.active_post_action.as_deref() {
        let Some(post_action) = current_stage.post_action.as_ref() else {
            return Ok(None);
        };
        if post_action.name != active_post_action
            || post_action.transition.as_deref() != Some("auto")
        {
            return Ok(None);
        }
        db.clear_pipeline_item_active_post_action(source_task_id)
            .map_err(|e| format!("db error: {}", e))?;
    } else if current_stage.transition.as_deref() != Some("auto") {
        return Ok(None);
    }
    let Some(next_stage) = pipeline.stages.get(current_stage_index + 1) else {
        return Ok(None);
    };
    let source_branch =
        resolve_current_source_worktree_branch(&repo.path, source_task.branch.as_deref());
    let display_name = resolve_inherited_task_title(db, &source_task)?;

    let task_prompt = build_target_stage_prompt(
        &repo.path,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        source_task.stage_result.as_deref(),
        source_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
    )?;
    let explicit_provider = if next_stage.agent.is_some() {
        None
    } else {
        source_task.agent_provider.clone()
    };

    if next_stage.mode == Some(PipelineStageMode::Continue) {
        return prepare_continue_stage(
            source_task_id,
            &current_stage_name,
            &next_stage.name,
            source_task.stage_result.clone(),
            &task_prompt,
            source_task.branch.as_deref(),
            normalize_agent_type(source_task.agent_type.as_deref()).unwrap_or("pty"),
            source_task.agent_provider.as_deref(),
        )
        .map(|continuation| PreparedStageTransition::Continue(Box::new(continuation)))
        .map(Some);
    }

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt,
            display_name,
            pipeline_name: Some(pipeline_name),
            base_ref: source_branch,
            stored_base_ref: source_task.base_ref,
            stage_override: Some(next_stage.name.clone()),
            explicit_provider,
            default_provider: None,
            agent_type: source_task.agent_type,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            notify_task_id: None,
        },
    )
    .map(|spawn| PreparedStageTransition::Spawn(Box::new(spawn)))
    .map(Some)
}

pub(crate) fn prepare_revision_task_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    target_stage_name: &str,
    revision_prompt: &str,
) -> Result<PreparedTaskSpawn, String> {
    let source_task = db
        .get_task_stage_source(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
    if source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", source_task_id));
    }
    let repo = db
        .get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", source_task_id))?;

    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let pipeline = read_pipeline_definition(&repo.path, &pipeline_name)?;
    let target_stage = pipeline
        .stages
        .iter()
        .find(|stage| stage.name == target_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", target_stage_name))?;
    let source_branch =
        resolve_current_source_worktree_branch(&repo.path, source_task.branch.as_deref());
    let display_name = resolve_inherited_task_title(db, &source_task)?;

    let task_prompt = build_target_stage_prompt(
        &repo.path,
        target_stage,
        revision_prompt,
        source_task.stage_result.as_deref(),
        source_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
    )?;
    let explicit_provider = if target_stage.agent.is_some() {
        None
    } else {
        source_task.agent_provider.clone()
    };

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt,
            display_name,
            pipeline_name: Some(pipeline_name),
            base_ref: source_branch,
            stored_base_ref: source_task.base_ref,
            stage_override: Some(target_stage.name.clone()),
            explicit_provider,
            default_provider: None,
            agent_type: source_task.agent_type,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            notify_task_id: None,
        },
    )
}

pub(crate) fn prepare_task_for_api(
    db: &Db,
    config: &Config,
    request: crate::mobile_api::CreateTaskRequest,
) -> Result<PreparedTaskSpawn, String> {
    let repo = db
        .get_repo(&request.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found: {}", request.repo_id))?;

    let explicit_provider = request.agent_provider;
    let default_provider = if explicit_provider.is_none() {
        read_default_agent_provider_setting(db)?
    } else {
        None
    };

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt: request.prompt.clone(),
            display_name: None,
            pipeline_name: request.pipeline_name,
            base_ref: request.base_ref,
            stored_base_ref: None,
            stage_override: request.stage,
            explicit_provider,
            default_provider,
            agent_type: request.agent_type,
            model: request.model,
            permission_mode: request.permission_mode,
            allowed_tools: request.allowed_tools.unwrap_or_default(),
            notify_task_id: request.notify_task_id,
        },
    )
}

fn read_default_agent_provider_setting(db: &Db) -> Result<Option<String>, String> {
    let provider = db
        .get_setting("defaultAgentProvider")
        .map_err(|e| format!("db error: {}", e))?;
    Ok(match provider.as_deref() {
        Some("claude" | "copilot" | "codex" | "opencode") => provider,
        _ => Some("claude".to_string()),
    })
}

fn prepare_task_spawn(
    db: &Db,
    config: &Config,
    repo: &Repo,
    request: TaskCreationRequest,
) -> Result<PreparedTaskSpawn, String> {
    let original_prompt = request.task_prompt.clone();
    let display_name = request.display_name.clone();
    let repo_config = read_repo_config(&repo.path)?;
    let pipeline_name = request
        .pipeline_name
        .or(repo_config.pipeline.clone())
        .unwrap_or_else(|| "default".to_string());
    let pipeline = read_pipeline_definition(&repo.path, &pipeline_name)?;
    let stage = if let Some(stage_name) = request.stage_override.as_deref() {
        pipeline
            .stages
            .iter()
            .find(|stage| stage.name == stage_name)
            .ok_or_else(|| format!("stage not found in pipeline: {}", stage_name))?
    } else {
        pipeline
            .stages
            .first()
            .ok_or_else(|| format!("pipeline has no stages: {}", pipeline_name))?
    };

    let agent = if let Some(agent_name) = stage.agent.as_deref() {
        Some(read_agent_definition(&repo.path, agent_name)?)
    } else {
        None
    };

    let final_prompt = if request.stage_override.is_some() {
        original_prompt.clone()
    } else {
        build_stage_prompt(
            agent
                .as_ref()
                .map(|agent| agent.prompt.as_str())
                .unwrap_or(""),
            stage.prompt.as_deref(),
            &PromptContext {
                task_prompt: Some(&request.task_prompt),
                prev_result: None,
                branch: request.base_ref.as_deref(),
                base_ref: request
                    .stored_base_ref
                    .as_deref()
                    .or(request.base_ref.as_deref()),
                source_worktree: None,
            },
        )
    };

    let provider = resolve_agent_provider(
        request.explicit_provider.as_deref(),
        request.default_provider.as_deref(),
        stage.agent_provider.as_deref(),
        agent.as_ref(),
    )?;
    let model = request
        .model
        .or_else(|| agent.as_ref().and_then(|agent| agent.model.clone()));
    let permission_mode = request.permission_mode.or_else(|| {
        agent
            .as_ref()
            .and_then(|agent| agent.permission_mode.clone())
    });
    let allowed_tools = if request.allowed_tools.is_empty() {
        agent
            .as_ref()
            .map(|agent| agent.allowed_tools.clone())
            .unwrap_or_default()
    } else {
        request.allowed_tools
    };
    let agent_type = resolve_agent_type(request.agent_type.as_deref(), provider)?;
    let headless_executable = if matches!(agent_type, AgentSessionType::Agent) {
        resolve_headless_agent_executable(provider)?
    } else {
        None
    };

    let task_id = generate_task_id()?;
    let branch = format!("task-{}", task_id);
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);
    let stage_name = request
        .stage_override
        .as_deref()
        .unwrap_or(stage.name.as_str())
        .to_string();
    let stage_transition = stage.transition.as_deref();
    let tags_json = serde_json::to_string(&vec![stage_name.clone()])
        .map_err(|e| format!("serialize error: {}", e))?;

    db.insert_pipeline_item(NewPipelineItem {
        id: &task_id,
        repo_id: &repo.id,
        prompt: &original_prompt,
        display_name: display_name.as_deref(),
        pipeline: &pipeline_name,
        stage: &stage_name,
        tags_json: &tags_json,
        branch: &branch,
        agent_type: agent_type.as_str(),
        agent_provider: provider.as_str(),
        activity: "working",
        port_offset: None,
        port_env_json: None,
        base_ref: request
            .stored_base_ref
            .as_deref()
            .or(request.base_ref.as_deref()),
        notify_task_id: request.notify_task_id.as_deref(),
    })
    .map_err(|e| format!("db error: {}", e))?;

    let port_env = claim_task_ports(db, &task_id, repo_config.ports.as_ref())?;
    let first_port = port_env
        .values()
        .next()
        .and_then(|value| value.parse::<i64>().ok());
    let port_env_json = if port_env.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&port_env).map_err(|e| format!("serialize error: {}", e))?)
    };
    db.update_pipeline_item_ports(&task_id, first_port, port_env_json.as_deref())
        .map_err(|e| format!("db error: {}", e))?;

    let start_point = request
        .base_ref
        .clone()
        .or_else(|| fetch_start_point(&repo.path, repo.default_branch.as_deref()));
    create_worktree(&repo.path, &branch, &worktree_path, start_point.as_deref())?;
    db.upsert_worktree(&format!("wt-{task_id}"), &task_id, &worktree_path, &branch)
        .map_err(|e| format!("db error: {}", e))?;
    db.upsert_terminal_session(
        &format!("agent-{task_id}"),
        &repo.id,
        Some(&task_id),
        Some("agent"),
        Some(&worktree_path),
        Some(&task_id),
    )
    .map_err(|e| format!("db error: {}", e))?;
    let worktree_repo_config = read_repo_config(&worktree_path)?;
    let mut spawn_env = build_spawn_env(config, &task_id, &port_env)?;
    let mcp_config_path = write_kanna_mcp_config(&config.daemon_dir, &task_id, &mut spawn_env)?;
    let session = match agent_type {
        AgentSessionType::Pty => {
            let preamble = build_kanna_preamble(
                &provider,
                &task_id,
                &stage_name,
                &pipeline_name,
                stage_transition,
                mcp_config_path.as_deref(),
            );
            let agent_cmd = build_agent_command(
                &provider,
                &final_prompt,
                model.as_deref(),
                permission_mode.as_deref(),
                &allowed_tools,
                Some(&preamble),
                mcp_config_path.as_deref(),
            );
            let full_cmd = build_task_shell_command(
                &agent_cmd,
                worktree_repo_config.setup.as_deref().unwrap_or(&[]),
                spawn_env.get("KANNA_CLI_PATH").map(String::as_str),
            );
            PreparedSessionSpawn::Pty {
                executable: "/bin/zsh".to_string(),
                args: vec![
                    "--login".to_string(),
                    "-i".to_string(),
                    "-c".to_string(),
                    full_cmd,
                ],
                cols: 80,
                rows: 24,
                agent_provider: provider.to_daemon_provider(),
            }
        }
        AgentSessionType::Agent => {
            let system_prompt = build_kanna_preamble(
                &provider,
                &task_id,
                &stage_name,
                &pipeline_name,
                stage_transition,
                mcp_config_path.as_deref(),
            );
            PreparedSessionSpawn::Agent {
                agent_provider: provider.to_daemon_provider(),
                prompt: final_prompt,
                model,
                permission_mode,
                allowed_tools,
                system_prompt,
                mcp_config_path,
                executable: headless_executable,
            }
        }
    };
    let title = request
        .display_name
        .clone()
        .unwrap_or_else(|| original_prompt.clone());

    Ok(PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: task_id.clone(),
            repo_id: repo.id.clone(),
            title,
            stage: stage_name,
            agent_type: agent_type.as_str().to_string(),
            worktree_path: worktree_path.clone(),
        },
        branch,
        session_id: task_id,
        cwd: worktree_path,
        env: spawn_env,
        session,
    })
}

pub(crate) fn resolve_stage_transition(
    repo_path: &str,
    pipeline_name: &str,
    stage_name: &str,
) -> Result<Option<String>, String> {
    let pipeline = read_pipeline_definition(repo_path, pipeline_name)?;
    Ok(pipeline
        .stages
        .iter()
        .find(|stage| stage.name == stage_name)
        .and_then(|stage| stage.transition.clone()))
}
