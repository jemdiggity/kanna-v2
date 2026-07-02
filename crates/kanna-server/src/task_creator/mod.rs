mod commands;
mod continuation;
mod definitions;
mod environment;
mod lifecycle;
mod prompt;
mod provider;
mod stages;
mod types;
mod worktree;

#[cfg(test)]
mod tests;

use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, NewPipelineItem, Repo};
use commands::{build_agent_command, build_kanna_preamble, build_task_shell_command};
use definitions::{read_agent_definition, read_pipeline_definition, read_repo_config};
use environment::{
    apply_workspace_path_env, build_spawn_env, claim_task_ports, resolve_headless_agent_executable,
    write_kanna_mcp_config,
};
use lifecycle::spawn_prepared_task;
use prompt::{build_stage_prompt, PromptContext};
use provider::{resolve_agent_provider, resolve_agent_type, AgentProvider, AgentSessionType};
use std::collections::HashMap;
use types::{CreatedTask, PreparedSessionSpawn, TaskCreationRequest};
pub(crate) use types::{PreparedStageRunSpawn, PreparedStageTransition, PreparedTaskSpawn};
use worktree::{create_worktree, fetch_start_point, generate_task_id};

pub(crate) use lifecycle::{
    continue_prepared_stage_for_api, prepared_task_id, rollback_prepared_task_for_api,
    spawn_prepared_stage_run_for_api, spawn_prepared_task_for_api,
    spawn_prepared_task_for_api_with_rollback,
};
pub(crate) use stages::{
    prepare_advance_stage_for_api, prepare_auto_stage_completion_for_api,
    prepare_revision_task_for_api, resolve_stage_transition,
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
            parent_task_id: None,
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
    let parent_task_id = if let Some(raw_parent_task_id) = request.parent_task_id.as_deref() {
        let parent_task_id = db
            .resolve_pipeline_item_id(raw_parent_task_id)
            .map_err(|e| format!("db error: {}", e))?
            .ok_or_else(|| format!("parent task not found: {}", raw_parent_task_id))?;
        let parent = db
            .get_pipeline_item(&parent_task_id)
            .map_err(|e| format!("db error: {}", e))?
            .ok_or_else(|| format!("parent task not found: {}", parent_task_id))?;
        if parent.repo_id != repo.id {
            return Err(format!(
                "parent task belongs to a different repo: {}",
                parent_task_id
            ));
        }
        Some(parent_task_id)
    } else {
        None
    };

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt: request.prompt.clone(),
            display_name: request.display_name,
            pipeline_name: request.pipeline_name,
            base_ref: request.base_ref,
            stored_base_ref: None,
            stage_override: None,
            explicit_provider,
            default_provider,
            agent_type: request.agent_type,
            model: request.model,
            permission_mode: request.permission_mode,
            allowed_tools: request.allowed_tools.unwrap_or_default(),
            notify_task_id: request.notify_task_id,
            parent_task_id,
        },
    )
}

fn read_default_agent_provider_setting(db: &Db) -> Result<Option<String>, String> {
    let provider = db
        .get_setting("defaultAgentProvider")
        .map_err(|e| format!("db error: {}", e))?;
    Ok(match provider.as_deref() {
        Some("claude" | "copilot" | "codex" | "opencode" | "antigravity") => provider,
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
        parent_task_id: request.parent_task_id.as_deref(),
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
    db.insert_stage_run(
        &format!("run-1-{}-{}", stage_slug(&stage_name), task_id),
        &task_id,
        &stage_name,
        "running",
        Some(&task_id),
        None,
    )
    .map_err(|e| format!("db error: {}", e))?;
    let worktree_repo_config = read_repo_config(&worktree_path)?;
    let mut spawn_env = build_spawn_env(config, &task_id, &port_env)?;
    apply_workspace_path_env(&mut spawn_env, &worktree_path, &worktree_repo_config);
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
            let headless_executable = resolve_headless_agent_executable(
                provider,
                spawn_env.get("PATH").map(String::as_str),
            )?;
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

#[allow(clippy::too_many_arguments)]
pub(in crate::task_creator) fn prepare_stage_run_spawn(
    db: &Db,
    config: &Config,
    repo: &Repo,
    task_id: &str,
    pipeline_name: &str,
    previous_stage: &str,
    next_stage: &definitions::PipelineStage,
    task_prompt: &str,
    final_prompt: String,
    branch: &str,
    previous_stage_result: Option<String>,
    previous_active_post_action: Option<String>,
    feedback: Option<String>,
    source_agent_type: Option<&str>,
    explicit_provider: Option<String>,
) -> Result<PreparedStageRunSpawn, String> {
    let agent = if let Some(agent_name) = next_stage.agent.as_deref() {
        Some(read_agent_definition(&repo.path, agent_name)?)
    } else {
        None
    };
    let provider = resolve_agent_provider(
        explicit_provider.as_deref(),
        None,
        next_stage.agent_provider.as_deref(),
        agent.as_ref(),
    )?;
    let agent_type = resolve_agent_type(source_agent_type, provider)?;
    let model = agent.as_ref().and_then(|agent| agent.model.clone());
    let permission_mode = agent
        .as_ref()
        .and_then(|agent| agent.permission_mode.clone());
    let allowed_tools = agent
        .as_ref()
        .map(|agent| agent.allowed_tools.clone())
        .unwrap_or_default();
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);
    let worktree_repo_config = read_repo_config(&worktree_path)?;
    let mut spawn_env = build_spawn_env(config, task_id, &HashMap::new())?;
    apply_workspace_path_env(&mut spawn_env, &worktree_path, &worktree_repo_config);
    let mcp_config_path = write_kanna_mcp_config(&config.daemon_dir, task_id, &mut spawn_env)?;
    let run_number = db
        .count_stage_runs_for_task(task_id)
        .map_err(|e| format!("db error: {}", e))?
        + 1;
    let session_id = format!(
        "run-{run_number}-{}-{task_id}",
        stage_slug(&next_stage.name)
    );
    let session = build_prepared_session(
        provider,
        agent_type,
        task_id,
        &next_stage.name,
        pipeline_name,
        next_stage.transition.as_deref(),
        final_prompt,
        model,
        permission_mode,
        allowed_tools,
        mcp_config_path.as_deref(),
        &spawn_env,
        worktree_repo_config.setup.as_deref().unwrap_or(&[]),
    )?;

    Ok(PreparedStageRunSpawn {
        created_task: CreatedTask {
            task_id: task_id.to_string(),
            repo_id: repo.id.clone(),
            title: task_prompt.to_string(),
            stage: next_stage.name.clone(),
            agent_type: agent_type.as_str().to_string(),
            worktree_path: worktree_path.clone(),
        },
        task_id: task_id.to_string(),
        repo_id: repo.id.clone(),
        previous_stage: previous_stage.to_string(),
        next_stage: next_stage.name.clone(),
        previous_stage_result,
        previous_active_post_action,
        feedback,
        session_id,
        cwd: worktree_path,
        env: spawn_env,
        session,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_prepared_session(
    provider: AgentProvider,
    agent_type: AgentSessionType,
    task_id: &str,
    stage_name: &str,
    pipeline_name: &str,
    stage_transition: Option<&str>,
    final_prompt: String,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Vec<String>,
    mcp_config_path: Option<&str>,
    spawn_env: &HashMap<String, String>,
    setup: &[String],
) -> Result<PreparedSessionSpawn, String> {
    Ok(match agent_type {
        AgentSessionType::Pty => {
            let preamble = build_kanna_preamble(
                &provider,
                task_id,
                stage_name,
                pipeline_name,
                stage_transition,
                mcp_config_path,
            );
            let agent_cmd = build_agent_command(
                &provider,
                &final_prompt,
                model.as_deref(),
                permission_mode.as_deref(),
                &allowed_tools,
                Some(&preamble),
                mcp_config_path,
            );
            let full_cmd = build_task_shell_command(
                &agent_cmd,
                setup,
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
            let headless_executable = resolve_headless_agent_executable(
                provider,
                spawn_env.get("PATH").map(String::as_str),
            )?;
            let system_prompt = build_kanna_preamble(
                &provider,
                task_id,
                stage_name,
                pipeline_name,
                stage_transition,
                mcp_config_path,
            );
            PreparedSessionSpawn::Agent {
                agent_provider: provider.to_daemon_provider(),
                prompt: final_prompt,
                model,
                permission_mode,
                allowed_tools,
                system_prompt,
                mcp_config_path: mcp_config_path.map(str::to_string),
                executable: headless_executable,
            }
        }
    })
}

fn stage_slug(stage_name: &str) -> String {
    let mut slug = String::new();
    for ch in stage_name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}
