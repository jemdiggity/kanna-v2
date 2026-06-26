use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, NewPipelineItem, Repo, TaskStageSource};
use kanna_daemon::protocol::{
    AgentProvider as DaemonAgentProvider, AgentSpawnParams, Command as DaemonCommand,
    Event as DaemonEvent,
};
use serde::Deserialize;
use serde_yaml::Value as YamlValue;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Default, Deserialize)]
struct RepoConfig {
    pipeline: Option<String>,
    setup: Option<Vec<String>>,
    ports: Option<HashMap<String, u16>>,
    workspace: Option<RepoWorkspaceConfig>,
}

#[derive(Default, Deserialize)]
struct RepoWorkspaceConfig {
    path: Option<RepoWorkspacePathConfig>,
}

#[derive(Default, Deserialize)]
struct RepoWorkspacePathConfig {
    prepend: Option<Vec<String>>,
    append: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct PipelineDefinition {
    stages: Vec<PipelineStage>,
}

#[derive(Deserialize)]
struct PipelineStage {
    name: String,
    agent: Option<String>,
    prompt: Option<String>,
    agent_provider: Option<String>,
    transition: Option<String>,
    mode: Option<PipelineStageMode>,
    post_action: Option<PipelinePostAction>,
}

#[derive(Deserialize)]
struct PipelinePostAction {
    name: String,
    agent: Option<String>,
    prompt: Option<String>,
    agent_provider: Option<String>,
    transition: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PipelineStageMode {
    NewTask,
    Continue,
}

#[derive(Default, Deserialize)]
struct AgentFrontmatter {
    agent_provider: Option<YamlValue>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
}

struct AgentDefinition {
    prompt: String,
    agent_providers: Vec<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Vec<String>,
}

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

struct TaskCreationRequest {
    task_prompt: String,
    display_name: Option<String>,
    pipeline_name: Option<String>,
    base_ref: Option<String>,
    stored_base_ref: Option<String>,
    stage_override: Option<String>,
    explicit_provider: Option<String>,
    default_provider: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Vec<String>,
    notify_task_id: Option<String>,
}

#[derive(Clone)]
struct CreatedTask {
    task_id: String,
    repo_id: String,
    title: String,
    stage: String,
    agent_type: String,
    worktree_path: String,
}

#[derive(Clone)]
pub(crate) struct PreparedTaskSpawn {
    created_task: CreatedTask,
    branch: String,
    session_id: String,
    cwd: String,
    env: HashMap<String, String>,
    session: PreparedSessionSpawn,
}

#[derive(Clone)]
pub(crate) enum PreparedSessionSpawn {
    Pty {
        executable: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
        agent_provider: DaemonAgentProvider,
    },
    Agent {
        agent_provider: DaemonAgentProvider,
        prompt: String,
        model: Option<String>,
        permission_mode: Option<String>,
        allowed_tools: Vec<String>,
        system_prompt: String,
        mcp_config_path: Option<String>,
        executable: Option<String>,
    },
}

pub(crate) enum PreparedStageTransition {
    Spawn(Box<PreparedTaskSpawn>),
    Continue(Box<PreparedStageContinue>),
}

pub(crate) struct PreparedStageContinue {
    task_id: String,
    agent_type: String,
    previous_stage: String,
    next_stage: String,
    previous_stage_result: Option<String>,
    previous_active_post_action: Option<String>,
    active_post_action: Option<String>,
    input_text: String,
    input: Vec<u8>,
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

fn remove_prepared_worktree(worktree_path: &str, branch: &str) -> Result<(), String> {
    let worktree = Path::new(worktree_path);
    let repo_path = worktree
        .parent()
        .and_then(|parent| {
            if parent.file_name().and_then(|name| name.to_str()) == Some(".kanna-worktrees") {
                parent.parent()
            } else {
                None
            }
        })
        .ok_or_else(|| format!("cannot derive repo path from worktree path: {worktree_path}"))?;

    let remove_output = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_path])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree remove: {}", e))?;
    if !remove_output.status.success() {
        let fallback_result = std::fs::remove_dir_all(worktree_path);
        if let Err(err) = fallback_result {
            return Err(format!(
                "failed to remove worktree: {}; fallback remove_dir_all failed: {}",
                String::from_utf8_lossy(&remove_output.stderr).trim(),
                err
            ));
        }
    }

    let delete_output = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git branch delete: {}", e))?;
    if !delete_output.status.success() {
        let message = String::from_utf8_lossy(&delete_output.stderr);
        if !message.contains("not found") && !message.contains("not a branch") {
            return Err(format!("failed to delete task branch: {}", message.trim()));
        }
    }

    Ok(())
}

async fn spawn_prepared_task(
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

fn read_repo_config(repo_path: &str) -> Result<RepoConfig, String> {
    let path = Path::new(repo_path).join(".kanna/config.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|e| format!("invalid repo config: {}", e))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(RepoConfig::default()),
        Err(err) => Err(format!("failed to read repo config: {}", err)),
    }
}

fn read_pipeline_definition(
    repo_path: &str,
    pipeline_name: &str,
) -> Result<PipelineDefinition, String> {
    let path = Path::new(repo_path).join(format!(".kanna/pipelines/{pipeline_name}.json"));
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => read_builtin_resource(&format!(".kanna/pipelines/{pipeline_name}.json"))?,
    };
    serde_json::from_str(&content).map_err(|e| format!("invalid pipeline definition: {}", e))
}

fn read_agent_definition(repo_path: &str, agent_name: &str) -> Result<AgentDefinition, String> {
    let path = Path::new(repo_path).join(format!(".kanna/agents/{agent_name}/AGENT.md"));
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => read_builtin_resource(&format!(".kanna/agents/{agent_name}/AGENT.md"))?,
    };
    parse_agent_definition(&content)
}

fn build_target_stage_prompt(
    repo_path: &str,
    stage: &PipelineStage,
    task_prompt: &str,
    prev_result: Option<&str>,
    branch: Option<&str>,
    base_ref: Option<&str>,
    source_worktree_branch: Option<&str>,
) -> Result<String, String> {
    let source_worktree =
        source_worktree_branch.map(|branch| format!("{repo_path}/.kanna-worktrees/{branch}"));
    if let Some(agent_name) = stage.agent.as_deref() {
        let agent = read_agent_definition(repo_path, agent_name)?;
        return Ok(build_stage_prompt(
            &agent.prompt,
            stage.prompt.as_deref(),
            &PromptContext {
                task_prompt: Some(task_prompt),
                prev_result,
                branch,
                base_ref,
                source_worktree: source_worktree.as_deref(),
            },
        ));
    }

    Ok(task_prompt.to_string())
}

fn build_post_action_prompt(
    repo_path: &str,
    post_action: &PipelinePostAction,
    task_prompt: &str,
    prev_result: Option<&str>,
    branch: Option<&str>,
    base_ref: Option<&str>,
    source_worktree_branch: Option<&str>,
) -> Result<String, String> {
    let source_worktree =
        source_worktree_branch.map(|branch| format!("{repo_path}/.kanna-worktrees/{branch}"));
    if let Some(agent_name) = post_action.agent.as_deref() {
        let agent = read_agent_definition(repo_path, agent_name)?;
        return Ok(build_stage_prompt(
            &agent.prompt,
            post_action.prompt.as_deref(),
            &PromptContext {
                task_prompt: Some(task_prompt),
                prev_result,
                branch,
                base_ref,
                source_worktree: source_worktree.as_deref(),
            },
        ));
    }

    Ok(task_prompt.to_string())
}

#[allow(clippy::too_many_arguments)]
fn prepare_continue_stage(
    source_task_id: &str,
    previous_stage: &str,
    next_stage: &str,
    previous_stage_result: Option<String>,
    prompt: &str,
    source_branch: Option<&str>,
    agent_type: &str,
    agent_provider: Option<&str>,
) -> Result<PreparedStageContinue, String> {
    source_branch.ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    Ok(PreparedStageContinue {
        task_id: source_task_id.to_string(),
        agent_type: agent_type.to_string(),
        previous_stage: previous_stage.to_string(),
        next_stage: next_stage.to_string(),
        previous_stage_result,
        previous_active_post_action: None,
        active_post_action: None,
        input_text: prompt.to_string(),
        input: encode_agent_stage_input(prompt, agent_provider),
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_post_action_stage(
    source_task_id: &str,
    current_stage: &str,
    post_action: &PipelinePostAction,
    previous_stage_result: Option<String>,
    prompt: &str,
    source_branch: Option<&str>,
    agent_type: &str,
    agent_provider: Option<&str>,
) -> Result<PreparedStageContinue, String> {
    source_branch.ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    Ok(PreparedStageContinue {
        task_id: source_task_id.to_string(),
        agent_type: agent_type.to_string(),
        previous_stage: current_stage.to_string(),
        next_stage: current_stage.to_string(),
        previous_stage_result,
        previous_active_post_action: None,
        active_post_action: Some(post_action.name.clone()),
        input_text: prompt.to_string(),
        input: encode_agent_stage_input(prompt, agent_provider),
    })
}

fn encode_agent_stage_input(stage_prompt: &str, agent_provider: Option<&str>) -> Vec<u8> {
    let _ = agent_provider;
    format!("\u{1b}[200~{stage_prompt}\u{1b}[201~\r").into_bytes()
}

fn resolve_current_source_worktree_branch(
    repo_path: &str,
    stored_branch: Option<&str>,
) -> Option<String> {
    let stored_branch = stored_branch?;
    let worktree_path = Path::new(repo_path)
        .join(".kanna-worktrees")
        .join(stored_branch);
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(&worktree_path)
        .output();

    let Ok(output) = output else {
        return Some(stored_branch.to_string());
    };
    if !output.status.success() {
        return Some(stored_branch.to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        Some(stored_branch.to_string())
    } else {
        Some(branch)
    }
}

fn read_builtin_resource(relative_path: &str) -> Result<String, String> {
    if let Some(content) = compiled_builtin_resource(relative_path) {
        return Ok(content.to_string());
    }

    let mut dir = std::env::current_dir().map_err(|e| format!("failed to read cwd: {}", e))?;
    for _ in 0..10 {
        let candidate = dir.join(relative_path);
        if candidate.exists() {
            return std::fs::read_to_string(&candidate)
                .map_err(|e| format!("failed to read builtin resource: {}", e));
        }
        if !dir.pop() {
            break;
        }
    }
    Err(format!("resource not found: {}", relative_path))
}

fn compiled_builtin_resource(relative_path: &str) -> Option<&'static str> {
    match relative_path {
        ".kanna/pipelines/default.json" => {
            Some(include_str!("../../../.kanna/pipelines/default.json"))
        }
        ".kanna/pipelines/qa.json" => Some(include_str!("../../../.kanna/pipelines/qa.json")),
        ".kanna/agents/agent-factory/AGENT.md" => Some(include_str!(
            "../../../.kanna/agents/agent-factory/AGENT.md"
        )),
        ".kanna/agents/commit/AGENT.md" => {
            Some(include_str!("../../../.kanna/agents/commit/AGENT.md"))
        }
        ".kanna/agents/config-factory/AGENT.md" => Some(include_str!(
            "../../../.kanna/agents/config-factory/AGENT.md"
        )),
        ".kanna/agents/implement/AGENT.md" => {
            Some(include_str!("../../../.kanna/agents/implement/AGENT.md"))
        }
        ".kanna/agents/merge/AGENT.md" => {
            Some(include_str!("../../../.kanna/agents/merge/AGENT.md"))
        }
        ".kanna/agents/pipeline-factory/AGENT.md" => Some(include_str!(
            "../../../.kanna/agents/pipeline-factory/AGENT.md"
        )),
        ".kanna/agents/pr/AGENT.md" => Some(include_str!("../../../.kanna/agents/pr/AGENT.md")),
        ".kanna/agents/review/AGENT.md" => {
            Some(include_str!("../../../.kanna/agents/review/AGENT.md"))
        }
        _ => None,
    }
}

fn parse_agent_definition(content: &str) -> Result<AgentDefinition, String> {
    let (frontmatter, body) = split_frontmatter(content);
    let fm: AgentFrontmatter = match frontmatter {
        Some(raw) => {
            serde_yaml::from_str(raw).map_err(|e| format!("invalid AGENT.md frontmatter: {}", e))?
        }
        None => AgentFrontmatter::default(),
    };

    Ok(AgentDefinition {
        prompt: body.trim().to_string(),
        agent_providers: parse_agent_providers(fm.agent_provider),
        model: fm.model,
        permission_mode: fm.permission_mode,
        allowed_tools: fm.allowed_tools.unwrap_or_default(),
    })
}

fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let normalized = content.trim_start_matches('\u{feff}');
    let Some(rest) = normalized.strip_prefix("---") else {
        return (None, normalized);
    };
    let Some(rest) = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
    else {
        return (None, normalized);
    };
    if let Some(index) = rest.find("\n---\n") {
        let frontmatter = &rest[..index];
        let body = &rest[index + 5..];
        return (Some(frontmatter), body);
    }
    if let Some(index) = rest.find("\r\n---\r\n") {
        let frontmatter = &rest[..index];
        let body = &rest[index + 7..];
        return (Some(frontmatter), body);
    }
    (None, normalized)
}

fn parse_agent_providers(value: Option<YamlValue>) -> Vec<String> {
    match value {
        Some(YamlValue::Sequence(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        Some(YamlValue::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

struct PromptContext<'a> {
    task_prompt: Option<&'a str>,
    prev_result: Option<&'a str>,
    branch: Option<&'a str>,
    base_ref: Option<&'a str>,
    source_worktree: Option<&'a str>,
}

fn build_stage_prompt(
    agent_prompt: &str,
    stage_prompt: Option<&str>,
    context: &PromptContext<'_>,
) -> String {
    let mut parts = Vec::new();
    if !agent_prompt.trim().is_empty() {
        parts.push(agent_prompt.trim());
    }
    if let Some(stage_prompt) = stage_prompt {
        if !stage_prompt.trim().is_empty() {
            parts.push(stage_prompt.trim());
        }
    }

    parts
        .join("\n\n")
        .replace("$TASK_PROMPT", context.task_prompt.unwrap_or(""))
        .replace("$PREV_RESULT", context.prev_result.unwrap_or(""))
        .replace("$BRANCH", context.branch.unwrap_or(""))
        .replace("$BASE_REF", context.base_ref.unwrap_or(""))
        .replace("$SOURCE_WORKTREE", context.source_worktree.unwrap_or(""))
}

#[derive(Clone, Copy)]
enum AgentProvider {
    Claude,
    Copilot,
    Codex,
    Opencode,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentSessionType {
    Pty,
    Agent,
}

impl AgentSessionType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pty => "pty",
            Self::Agent => "agent",
        }
    }
}

impl AgentProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Copilot => "copilot",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }

    fn to_daemon_provider(self) -> DaemonAgentProvider {
        match self {
            Self::Claude => DaemonAgentProvider::Claude,
            Self::Copilot => DaemonAgentProvider::Copilot,
            Self::Codex => DaemonAgentProvider::Codex,
            Self::Opencode => DaemonAgentProvider::Opencode,
        }
    }
}

fn resolve_agent_type(
    explicit_agent_type: Option<&str>,
    provider: AgentProvider,
) -> Result<AgentSessionType, String> {
    match normalize_agent_type(explicit_agent_type) {
        Some("pty") => Ok(AgentSessionType::Pty),
        Some("agent") => Ok(AgentSessionType::Agent),
        Some(other) => Err(format!("unsupported agent_type: {}", other)),
        None => Ok(match provider {
            AgentProvider::Claude | AgentProvider::Codex | AgentProvider::Opencode => {
                AgentSessionType::Agent
            }
            AgentProvider::Copilot => AgentSessionType::Pty,
        }),
    }
}

fn normalize_agent_type(agent_type: Option<&str>) -> Option<&str> {
    match agent_type {
        Some("sdk") => Some("agent"),
        Some(value) => Some(value),
        None => None,
    }
}

fn resolve_agent_provider(
    explicit_provider: Option<&str>,
    default_provider: Option<&str>,
    stage_provider: Option<&str>,
    agent: Option<&AgentDefinition>,
) -> Result<AgentProvider, String> {
    let mut candidates = Vec::new();
    if let Some(provider) = explicit_provider.or(default_provider).or(stage_provider) {
        candidates.extend(
            provider
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        );
    }
    if candidates.is_empty() {
        candidates.extend(
            agent
                .map(|agent| agent.agent_providers.clone())
                .unwrap_or_default(),
        );
    }

    let parsed = candidates
        .iter()
        .filter_map(|candidate| match candidate.as_str() {
            "claude" => Some(AgentProvider::Claude),
            "copilot" => Some(AgentProvider::Copilot),
            "codex" => Some(AgentProvider::Codex),
            "opencode" => Some(AgentProvider::Opencode),
            _ => None,
        })
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        return Err("no agent provider configured for task creation".to_string());
    }

    for provider in &parsed {
        if binary_available(provider.as_str()) {
            return Ok(*provider);
        }
    }

    Ok(parsed[0])
}

fn binary_available(name: &str) -> bool {
    Command::new("/bin/zsh")
        .args([
            "--login",
            "-i",
            "-c",
            &format!("command -v {} >/dev/null 2>&1", name),
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn generate_task_id() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|byte| format!("{:02x}", byte)).collect())
}

fn fetch_start_point(repo_path: &str, default_branch: Option<&str>) -> Option<String> {
    let branch = default_branch.unwrap_or("main");
    let status = Command::new("git")
        .args(["fetch", "origin", branch])
        .current_dir(repo_path)
        .status()
        .ok()?;
    if status.success() {
        Some(format!("origin/{}", branch))
    } else {
        None
    }
}

fn create_worktree(
    repo_path: &str,
    branch: &str,
    worktree_path: &str,
    start_point: Option<&str>,
) -> Result<(), String> {
    let branch_exists = Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", branch),
        ])
        .current_dir(repo_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    let mut args = vec!["worktree", "add"];
    if branch_exists {
        args.push(worktree_path);
        args.push(branch);
    } else {
        args.push("-b");
        args.push(branch);
        args.push(worktree_path);
        if let Some(start_point) = start_point {
            args.push(start_point);
        }
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree add: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let cargo_dir = Path::new(worktree_path).join(".cargo");
    let _ = std::fs::create_dir_all(&cargo_dir);
    let _ = std::fs::write(
        cargo_dir.join("config.toml"),
        "[build]\ntarget-dir = \".build\"\n",
    );
    Ok(())
}

fn claim_task_ports(
    db: &Db,
    item_id: &str,
    ports: Option<&HashMap<String, u16>>,
) -> Result<HashMap<String, String>, String> {
    let Some(ports) = ports else {
        return Ok(HashMap::new());
    };

    let mut claimed = db
        .list_task_ports()
        .map_err(|e| format!("db error: {}", e))?
        .into_iter()
        .collect::<HashSet<_>>();
    let existing = db
        .list_task_ports_for_item(item_id)
        .map_err(|e| format!("db error: {}", e))?;
    let mut port_env = HashMap::new();

    for (env_name, preferred) in ports {
        if let Some(existing_port) = existing.get(env_name) {
            claimed.insert(*existing_port);
            port_env.insert(env_name.clone(), existing_port.to_string());
            continue;
        }

        let mut candidate = i64::from(*preferred) + 1;
        loop {
            if !claimed.contains(&candidate)
                && db
                    .claim_task_port(item_id, env_name, candidate)
                    .map_err(|e| format!("db error: {}", e))?
            {
                claimed.insert(candidate);
                port_env.insert(env_name.clone(), candidate.to_string());
                break;
            }
            candidate += 1;
            if candidate > 65535 {
                return Err(format!("no free port available near {}", preferred));
            }
        }
    }

    Ok(port_env)
}

fn resolve_workspace_path(worktree_path: &str, entry: &str) -> String {
    let entry_path = Path::new(entry);
    if entry_path.is_absolute() {
        entry_path.to_string_lossy().to_string()
    } else {
        Path::new(worktree_path)
            .join(entry_path)
            .to_string_lossy()
            .to_string()
    }
}

fn apply_workspace_path_env(
    env: &mut HashMap<String, String>,
    worktree_path: &str,
    repo_config: &RepoConfig,
) {
    let Some(path_config) = repo_config
        .workspace
        .as_ref()
        .and_then(|workspace| workspace.path.as_ref())
    else {
        return;
    };

    let prepend_entries = path_config
        .prepend
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|entry| resolve_workspace_path(worktree_path, entry));
    let append_entries = path_config
        .append
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|entry| resolve_workspace_path(worktree_path, entry));
    let existing_path = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();

    let path_parts = prepend_entries
        .chain(std::iter::once(existing_path).filter(|entry| !entry.is_empty()))
        .chain(append_entries)
        .collect::<Vec<_>>();
    if !path_parts.is_empty() {
        env.insert("PATH".to_string(), path_parts.join(":"));
    }
}

fn build_spawn_env(
    config: &Config,
    task_id: &str,
    port_env: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::from([
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "kanna".to_string()),
        ("KANNA_WORKTREE".to_string(), "1".to_string()),
        ("KANNA_TASK_ID".to_string(), task_id.to_string()),
        ("KANNA_CLI_DB_PATH".to_string(), config.db_path.clone()),
        (
            "KANNA_SOCKET_PATH".to_string(),
            pipeline_socket_path(&config.daemon_dir),
        ),
        (
            "KANNA_SERVER_BASE_URL".to_string(),
            format!("http://127.0.0.1:{}", config.lan_port),
        ),
    ]);
    env.extend(port_env.clone());
    let kanna_cli_path = if let Some(path) = config
        .kanna_cli_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string)
    {
        Some(path)
    } else {
        which_binary("kanna-cli")?
    };
    if let Some(path) = kanna_cli_path {
        if let Some(parent) = Path::new(&path).parent() {
            let runtime_path = prepend_path_entry(
                std::env::var("PATH").ok().as_deref(),
                parent.to_string_lossy().as_ref(),
            );
            env.insert("PATH".to_string(), runtime_path);
        }
        env.insert("KANNA_CLI_PATH".to_string(), path);
    }

    if let Ok(Some(path)) = which_binary("kanna-mcp") {
        if let Some(parent) = Path::new(&path).parent() {
            let existing_path = env
                .get("PATH")
                .cloned()
                .or_else(|| std::env::var("PATH").ok());
            let runtime_path =
                prepend_path_entry(existing_path.as_deref(), parent.to_string_lossy().as_ref());
            env.insert("PATH".to_string(), runtime_path);
        }
        env.insert("KANNA_MCP_PATH".to_string(), path);
    }
    Ok(env)
}

fn write_kanna_mcp_config(
    daemon_dir: &str,
    task_id: &str,
    env: &mut HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(mcp_path) = env.get("KANNA_MCP_PATH").cloned() else {
        return Ok(None);
    };
    let server_base_url = env
        .get("KANNA_SERVER_BASE_URL")
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:48120".to_string());
    let config_path = Path::new(daemon_dir)
        .join("runtime")
        .join("mcp")
        .join(format!("{task_id}.json"));
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create Kanna MCP config directory: {e}"))?;
    }
    let config = serde_json::json!({
        "mcpServers": {
            "kanna-mcp": {
                "command": mcp_path,
                "args": ["serve"],
                "env": {
                    "KANNA_SERVER_BASE_URL": server_base_url
                }
            }
        }
    });
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("failed to render Kanna MCP config: {e}"))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("failed to write Kanna MCP config: {e}"))?;
    let path = config_path.to_string_lossy().to_string();
    env.insert("KANNA_MCP_CONFIG".to_string(), path.clone());
    Ok(Some(path))
}

fn which_binary(name: &str) -> Result<Option<String>, String> {
    resolve_binary_from_candidates(name, sidecar_candidates(name), None).map(Some)
}

fn resolve_headless_agent_executable(
    provider: AgentProvider,
    path: Option<&str>,
) -> Result<Option<String>, String> {
    match provider {
        AgentProvider::Claude | AgentProvider::Codex | AgentProvider::Opencode => {
            which_binary_with_path(provider.as_str(), path)
        }
        AgentProvider::Copilot => Ok(None),
    }
}

fn which_binary_with_path(name: &str, path: Option<&str>) -> Result<Option<String>, String> {
    resolve_binary_from_candidates(name, sidecar_candidates(name), path).map(Some)
}

fn resolve_binary_from_candidates(
    name: &str,
    candidates: Vec<PathBuf>,
    path: Option<&str>,
) -> Result<String, String> {
    resolve_binary_from_candidates_with_path_lookup(name, candidates, |name| {
        if let Some(path) = path {
            return resolve_binary_from_path(name, path)
                .ok_or_else(|| format!("binary '{}' not found in PATH", name));
        }

        let output = Command::new("/bin/zsh")
            .args(["--login", "-i", "-c", &format!("command -v {}", name)])
            .output()
            .map_err(|e| format!("failed to locate {}: {}", name, e))?;

        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }

        Err(format!("binary '{}' not found in PATH", name))
    })
}

fn resolve_binary_from_path(name: &str, path: &str) -> Option<String> {
    path.split(':')
        .filter(|entry| !entry.is_empty())
        .map(|entry| Path::new(entry).join(name))
        .find(|candidate| is_executable_file(candidate))
        .map(|candidate| candidate.to_string_lossy().to_string())
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn resolve_binary_from_candidates_with_path_lookup<F>(
    name: &str,
    candidates: Vec<PathBuf>,
    path_lookup: F,
) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    path_lookup(name)
}

fn current_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    {
        "x86_64-apple-darwin"
    }
}

fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    std::env::current_exe()
        .ok()
        .map(|exe| sidecar_candidates_for_exe(&exe, name))
        .unwrap_or_default()
}

fn sidecar_candidates_for_exe(current_exe: &Path, name: &str) -> Vec<PathBuf> {
    let Some(exe_dir) = current_exe.parent() else {
        return Vec::new();
    };

    let sidecar_name = format!("{}-{}", name, current_target_triple());
    let mut candidates = vec![exe_dir.join(&sidecar_name), exe_dir.join(name)];

    if let (Some(build_root), Some(profile_dir)) = (exe_dir.parent(), exe_dir.file_name()) {
        if build_root.file_name().is_some_and(|dir| dir == ".build")
            && matches!(profile_dir.to_str(), Some("debug" | "release"))
        {
            let triple_dir = build_root.join(current_target_triple()).join(profile_dir);
            candidates.push(triple_dir.join(name));
            candidates.push(triple_dir.join(&sidecar_name));
        }
    }

    candidates.push(exe_dir.join("../Resources").join(&sidecar_name));
    candidates.push(exe_dir.join("../Resources").join(name));
    candidates
}

fn prepend_path_entry(path: Option<&str>, entry: &str) -> String {
    let existing_entries = path
        .unwrap_or_default()
        .split(':')
        .filter(|part| !part.is_empty() && *part != entry);
    std::iter::once(entry)
        .chain(existing_entries)
        .collect::<Vec<_>>()
        .join(":")
}

fn build_agent_command(
    provider: &AgentProvider,
    prompt: &str,
    model: Option<&str>,
    permission_mode: Option<&str>,
    allowed_tools: &[String],
    kanna_preamble: Option<&str>,
    mcp_config_path: Option<&str>,
) -> String {
    let prompt_with_fallback = match provider {
        AgentProvider::Claude => prompt.to_string(),
        AgentProvider::Copilot | AgentProvider::Codex | AgentProvider::Opencode => {
            // TODO: Use native system-prompt flags for these providers once Kanna
            // has verified stable CLI support for them. Until then, prepend the
            // short preamble to the prompt body so the task remains Kanna-aware.
            match kanna_preamble {
                Some(preamble) if !preamble.is_empty() => format!("{preamble}\n\n{prompt}"),
                _ => prompt.to_string(),
            }
        }
    };
    let escaped_prompt = shell_single_quote(&prompt_with_fallback);
    match provider {
        AgentProvider::Claude => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("--model {}", model));
            }
            if !allowed_tools.is_empty() {
                flags.push(format!("--allowedTools {}", allowed_tools.join(",")));
            }
            if let Some(preamble) = kanna_preamble {
                flags.push(format!(
                    "--append-system-prompt '{}'",
                    shell_single_quote(preamble)
                ));
            }
            if let Some(mcp_config_path) = mcp_config_path {
                flags.push(format!(
                    "--mcp-config '{}'",
                    shell_single_quote(mcp_config_path)
                ));
            }
            format!("claude {} '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Copilot => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("--model={}", model));
            }
            if !allowed_tools.is_empty() {
                for tool in allowed_tools {
                    flags.push(format!("--allow-tool={}", tool));
                }
            }
            format!("copilot {} -i '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Codex => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("-m {}", model));
            }
            format!("codex {} '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Opencode => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("-m {}", model));
            }
            let executable = which_binary("opencode")
                .ok()
                .flatten()
                .unwrap_or_else(|| "opencode".to_string());
            let mut parts = vec![
                format!("'{}'", shell_single_quote(&executable)),
                "run".to_string(),
                "--interactive".to_string(),
            ];
            parts.extend(flags);
            if !prompt.is_empty() {
                parts.push(format!("'{}'", escaped_prompt));
            }
            parts.join(" ")
        }
    }
}

fn get_agent_permission_flags(
    provider: AgentProvider,
    permission_mode: Option<&str>,
) -> Vec<String> {
    let normalized = match permission_mode {
        Some("default") | None => None,
        other => other,
    };

    match provider {
        AgentProvider::Claude => match normalized {
            None | Some("dontAsk") => vec!["--dangerously-skip-permissions".to_string()],
            Some(mode) => vec![format!("--permission-mode {}", mode)],
        },
        AgentProvider::Copilot => vec!["--yolo".to_string()],
        AgentProvider::Codex => match normalized {
            None | Some("dontAsk") => vec!["--yolo".to_string()],
            Some(_) => vec!["--full-auto".to_string()],
        },
        AgentProvider::Opencode => match normalized {
            None | Some("dontAsk") => vec!["--dangerously-skip-permissions".to_string()],
            Some(_) => Vec::new(),
        },
    }
}

fn build_task_shell_command(
    agent_cmd: &str,
    setup_cmds: &[String],
    kanna_cli_path: Option<&str>,
) -> String {
    let mut command_parts = Vec::new();
    if let Some(kanna_cli_path) = kanna_cli_path {
        let quoted = shell_single_quote(kanna_cli_path);
        command_parts.push(format!("export KANNA_CLI_PATH='{}'", quoted));
        if let Some(parent) = Path::new(kanna_cli_path).parent() {
            let parent = shell_single_quote(parent.to_string_lossy().as_ref());
            command_parts.push(format!("export PATH='{}':\"$PATH\"", parent));
        }
    }

    if !setup_cmds.is_empty() {
        let setup_parts = setup_cmds
            .iter()
            .map(|cmd| {
                format!(
                    "printf '\\033[2m$ %s\\033[0m\\n' '{}' && {}",
                    shell_single_quote(cmd),
                    cmd
                )
            })
            .collect::<Vec<_>>()
            .join(" && ");
        command_parts.push(format!(
            "printf '\\033[33mRunning startup...\\033[0m\\n' && {} && printf '\\n'",
            setup_parts
        ));
    }

    command_parts.push(agent_cmd.to_string());
    command_parts.join(" && ")
}

fn build_kanna_preamble(
    provider: &AgentProvider,
    task_id: &str,
    stage_name: &str,
    pipeline_name: &str,
    transition: Option<&str>,
    mcp_config_path: Option<&str>,
) -> String {
    let provider_name = provider.as_str();
    let transition = transition.unwrap_or("manual");
    let mut lines = vec![
        "## Kanna Task Context".to_string(),
        format!(
            "You are `{provider_name}` running inside Kanna task `{task_id}`, stage `{stage_name}` of pipeline `{pipeline_name}` with transition `{transition}`."
        ),
        "You are not running inside a Kanna sandbox; use the normal shell tools available in this worktree.".to_string(),
    ];
    if mcp_config_path.is_some() {
        lines.push(
            "An instance-local `kanna-mcp` config is available at `KANNA_MCP_CONFIG`.".to_string(),
        );
        if matches!(provider, AgentProvider::Claude) {
            lines.push(
                "Claude is launched with this config via `--mcp-config`, so Kanna MCP tools should be available automatically."
                    .to_string(),
            );
        }
    }
    lines.extend([
        "Prefer `kanna-mcp` tools for Kanna task operations when your agent client exposes them.".to_string(),
        "If MCP tools are unavailable, fall back to the instance-local `kanna-cli`; it is exported as `KANNA_CLI_PATH` and its directory is prepended to `PATH`.".to_string(),
        "Use `kanna-cli guide` for the generated fallback CLI manual and current workflow semantics.".to_string(),
        "When this stage is complete, prefer MCP `kanna_complete_stage`; fallback: `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary \"...\"`.".to_string(),
    ]);
    lines.join("\n")
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

fn shell_single_quote(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn pipeline_socket_path(daemon_dir: &str) -> String {
    let dir = PathBuf::from(daemon_dir).join("pipeline");
    short_socket_path(&dir).to_string_lossy().to_string()
}

fn short_socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

#[cfg(test)]
mod tests {
    use super::{
        build_spawn_env, build_stage_prompt, continue_prepared_stage_for_api,
        prepare_advance_stage_for_api, prepare_merge_agent_for_api, prepare_revision_task_for_api,
        prepare_task_for_api, read_default_agent_provider_setting, resolve_agent_type,
        resolve_binary_from_candidates_with_path_lookup, spawn_prepared_task, AgentProvider,
        AgentSessionType, CreatedTask, DaemonAgentProvider, PreparedSessionSpawn,
        PreparedStageTransition, PreparedTaskSpawn, PromptContext,
    };
    use crate::config::Config;
    use crate::daemon_client::DaemonClient;
    use crate::db::Db;
    use crate::mobile_api::CreateTaskRequest;
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::process::Command;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    #[test]
    fn build_stage_prompt_replaces_base_ref() {
        let prompt = build_stage_prompt(
            "Review changes since $BASE_REF.",
            Some("Current branch $BRANCH."),
            &PromptContext {
                task_prompt: None,
                prev_result: None,
                branch: Some("task-source"),
                base_ref: Some("origin/main"),
                source_worktree: Some("/tmp/repo/.kanna-worktrees/task-source"),
            },
        );

        assert_eq!(
            prompt,
            "Review changes since origin/main.\n\nCurrent branch task-source."
        );
    }

    #[test]
    fn resolve_agent_type_normalizes_legacy_sdk_to_agent() {
        assert!(matches!(
            resolve_agent_type(Some("sdk"), AgentProvider::Claude),
            Ok(AgentSessionType::Agent)
        ));
    }

    #[test]
    fn resolve_agent_type_defaults_opencode_to_agent_but_allows_explicit_pty() {
        assert!(matches!(
            resolve_agent_type(None, AgentProvider::Opencode),
            Ok(AgentSessionType::Agent)
        ));
        assert!(matches!(
            resolve_agent_type(Some("pty"), AgentProvider::Opencode),
            Ok(AgentSessionType::Pty)
        ));
    }

    #[test]
    fn build_agent_command_adds_claude_kanna_preamble_as_system_prompt() {
        let preamble = super::build_kanna_preamble(
            &AgentProvider::Claude,
            "task-123",
            "review",
            "qa",
            Some("auto"),
            None,
        );

        let command = super::build_agent_command(
            &AgentProvider::Claude,
            "Review the branch.",
            None,
            Some("dontAsk"),
            &[],
            Some(&preamble),
            None,
        );

        assert!(command.contains("--append-system-prompt '"));
        assert!(command.contains("task-123"));
        assert!(command.contains("stage `review`"));
        assert!(command.contains("pipeline `qa`"));
        assert!(command.contains("transition `auto`"));
        assert!(command.contains("kanna-cli guide"));
        assert!(command.contains("You are not running inside a Kanna sandbox"));
        let mcp_index = command
            .find("Prefer `kanna-mcp` tools for Kanna task operations")
            .expect("preamble should prefer MCP tools");
        let cli_index = command
            .find("If MCP tools are unavailable, fall back to the instance-local `kanna-cli`")
            .expect("preamble should describe CLI fallback");
        assert!(mcp_index < cli_index);
        assert!(cli_index < command.find("kanna-cli guide").unwrap());
        assert!(command.contains("KANNA_CLI_PATH"));
    }

    fn test_daemon_socket_path(daemon_dir: &str) -> std::path::PathBuf {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let dir = std::path::PathBuf::from(daemon_dir);
        let mut hasher = DefaultHasher::new();
        dir.hash(&mut hasher);
        let hash = hasher.finish() as u32;
        std::path::PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
    }

    async fn spawn_fake_daemon_once(
        daemon_dir: String,
    ) -> tokio::task::JoinHandle<kanna_daemon::protocol::Command> {
        let socket_path = test_daemon_socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
            let response = serde_json::to_string(&kanna_daemon::protocol::Event::Ok).unwrap();
            write_half.write_all(response.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
            command
        })
    }

    async fn spawn_fake_daemon_session_created_once(
        daemon_dir: String,
    ) -> tokio::task::JoinHandle<kanna_daemon::protocol::Command> {
        let socket_path = test_daemon_socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
            let response = serde_json::to_string(&kanna_daemon::protocol::Event::SessionCreated {
                session_id: "task-1".to_string(),
            })
            .unwrap();
            write_half.write_all(response.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
            command
        })
    }

    fn test_config(label: &str) -> Config {
        Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: format!("/tmp/kanna-daemon-{label}"),
            db_path: Db::test_db_path(label),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-{label}.json"),
        }
    }

    fn init_git_repo(label: &str) -> std::path::PathBuf {
        let repo_root =
            std::env::temp_dir().join(format!("kanna-task-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(&repo_root).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        repo_root
    }

    fn ensure_test_sidecar(name: &str) -> (std::path::PathBuf, bool) {
        let sidecar_path = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(name);
        if sidecar_path.exists() {
            return (sidecar_path, false);
        }

        std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
        (sidecar_path, true)
    }

    fn init_git_repo_with_pipeline(
        label: &str,
        pipeline_name: &str,
        stage_name: &str,
        transition: &str,
        provider: &str,
    ) -> std::path::PathBuf {
        let repo_root = init_git_repo(label);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::write(
            repo_root.join(format!(".kanna/pipelines/{pipeline_name}.json")),
            serde_json::json!({
                "stages": [
                    {
                        "name": stage_name,
                        "transition": transition,
                        "agent_provider": provider,
                        "prompt": "$TASK_PROMPT"
                    },
                    { "name": "pr", "transition": "manual" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "add kanna pipeline"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        repo_root
    }

    #[test]
    fn resolve_binary_prefers_sidecar_candidate_before_path_lookup() {
        let temp_root = std::env::temp_dir().join(format!(
            "kanna-server-sidecar-resolver-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&temp_root);
        std::fs::create_dir_all(&temp_root).unwrap();
        let sidecar = temp_root.join("kanna-cli");
        std::fs::write(&sidecar, "#!/bin/sh\n").unwrap();

        let resolved = resolve_binary_from_candidates_with_path_lookup(
            "kanna-cli",
            vec![sidecar.clone()],
            |_| Ok("/usr/local/bin/kanna-cli".to_string()),
        )
        .expect("sidecar candidate should resolve");

        assert_eq!(resolved, sidecar.to_string_lossy());
    }

    #[test]
    fn build_spawn_env_prepends_kanna_cli_directory_to_path() {
        let mut config = test_config("spawn-env-kanna-cli-path");
        let (kanna_cli_path, created_test_sidecar) = ensure_test_sidecar("kanna-cli");
        let (kanna_mcp_path, created_test_mcp_sidecar) = ensure_test_sidecar("kanna-mcp");
        config.kanna_cli_path = Some(kanna_cli_path.to_string_lossy().to_string());
        let env = build_spawn_env(&config, "task-1", &HashMap::new()).unwrap();
        let cli_path = env
            .get("KANNA_CLI_PATH")
            .expect("test host should resolve kanna-cli");
        let cli_dir = std::path::Path::new(cli_path)
            .parent()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let path = env.get("PATH").expect("PATH should be provided");

        assert_eq!(path.split(':').next(), Some(cli_dir.as_str()));
        if created_test_sidecar {
            let _ = std::fs::remove_file(kanna_cli_path);
        }
        if created_test_mcp_sidecar {
            let _ = std::fs::remove_file(kanna_mcp_path);
        }
    }

    #[test]
    fn prepare_task_defaults_to_agent_session_for_claude_and_codex() {
        for provider in ["claude", "codex"] {
            let label = format!("agent-default-{provider}");
            let repo_root = init_git_repo(&label);
            let config = test_config(&label);
            let db = Db::open_for_tests(&config.db_path).unwrap();
            db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
                .unwrap();

            let prepared = prepare_task_for_api(
                &db,
                &config,
                CreateTaskRequest {
                    repo_id: "repo-1".to_string(),
                    prompt: format!("Use {provider}"),
                    pipeline_name: None,
                    base_ref: None,
                    stage: None,
                    agent_provider: Some(provider.to_string()),
                    agent_type: None,
                    model: Some("model-a".to_string()),
                    permission_mode: Some("dontAsk".to_string()),
                    allowed_tools: Some(vec!["Bash".to_string()]),
                    notify_task_id: None,
                    blocker_task_ids: None,
                },
            )
            .unwrap();

            let created = db
                .list_pipeline_items("repo-1")
                .unwrap()
                .into_iter()
                .find(|item| item.id == prepared.created_task.task_id)
                .unwrap();
            assert_eq!(created.agent_type.as_deref(), Some("agent"));
            assert!(matches!(
                prepared.session,
                PreparedSessionSpawn::Agent { .. }
            ));

            let _ = std::fs::remove_dir_all(&repo_root);
        }
    }

    #[test]
    fn prepare_codex_agent_uses_resolved_executable_for_headless_spawn() {
        let (codex_sidecar, created_sidecar) = ensure_test_sidecar("codex");
        let repo_root = init_git_repo("codex-headless-executable");
        let config = test_config("codex-headless-executable");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();

        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use codex".to_string(),
                pipeline_name: None,
                base_ref: None,
                stage: None,
                agent_provider: Some("codex".to_string()),
                agent_type: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                notify_task_id: None,
                blocker_task_ids: None,
            },
        )
        .unwrap();

        match prepared.session {
            PreparedSessionSpawn::Agent { executable, .. } => {
                let executable = executable.expect("codex executable should be resolved");
                assert_eq!(executable, codex_sidecar.to_string_lossy());
            }
            _ => panic!("expected agent session"),
        }

        if created_sidecar {
            let _ = std::fs::remove_file(&codex_sidecar);
        }
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_headless_agent_uses_worktree_workspace_path_for_executable_resolution() {
        use std::os::unix::fs::PermissionsExt;

        let repo_root = init_git_repo("headless-workspace-path");
        let config = test_config("headless-workspace-path");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();

        let fake_bin = repo_root.join(".kanna/fake-bin");
        std::fs::create_dir_all(&fake_bin).unwrap();
        let fake_codex = fake_bin.join("codex");
        std::fs::write(&fake_codex, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&fake_codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            repo_root.join(".kanna/config.json"),
            serde_json::json!({
                "workspace": {
                    "path": {
                        "prepend": [".kanna/fake-bin"]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "add workspace path"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use codex".to_string(),
                pipeline_name: None,
                base_ref: None,
                stage: None,
                agent_provider: Some("codex".to_string()),
                agent_type: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                notify_task_id: None,
                blocker_task_ids: None,
            },
        )
        .unwrap();

        let expected = std::path::Path::new(&prepared.cwd).join(".kanna/fake-bin/codex");
        match prepared.session {
            PreparedSessionSpawn::Agent { executable, .. } => {
                assert_eq!(
                    executable.as_deref(),
                    Some(expected.to_string_lossy().as_ref())
                );
            }
            _ => panic!("expected agent session"),
        }

        let path = prepared
            .env
            .get("PATH")
            .expect("spawn env should include PATH");
        let expected_dir = expected.parent().unwrap().to_string_lossy().to_string();
        assert_eq!(path.split(':').next(), Some(expected_dir.as_str()));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_task_defaults_to_pty_session_for_copilot() {
        let repo_root = init_git_repo("copilot-pty-default");
        let config = test_config("copilot-pty-default");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();

        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use copilot".to_string(),
                pipeline_name: None,
                base_ref: None,
                stage: None,
                agent_provider: Some("copilot".to_string()),
                agent_type: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                notify_task_id: None,
                blocker_task_ids: None,
            },
        )
        .unwrap();

        let created = db
            .list_pipeline_items("repo-1")
            .unwrap()
            .into_iter()
            .find(|item| item.id == prepared.created_task.task_id)
            .unwrap();
        assert_eq!(created.agent_type.as_deref(), Some("pty"));
        assert!(matches!(prepared.session, PreparedSessionSpawn::Pty { .. }));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn spawn_prepared_task_sends_spawn_agent_for_agent_sessions() {
        let config = test_config("spawn-prepared-agent-command");
        let daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
        let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();
        let prepared = PreparedTaskSpawn {
            created_task: CreatedTask {
                task_id: "task-1".to_string(),
                repo_id: "repo-1".to_string(),
                title: "Agent task".to_string(),
                stage: "in progress".to_string(),
                agent_type: "agent".to_string(),
                worktree_path: "/tmp/worktree".to_string(),
            },
            branch: "task-1".to_string(),
            session_id: "task-1".to_string(),
            cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
            env: HashMap::new(),
            session: PreparedSessionSpawn::Agent {
                agent_provider: DaemonAgentProvider::Claude,
                prompt: "Do work".to_string(),
                model: Some("sonnet".to_string()),
                permission_mode: Some("dontAsk".to_string()),
                allowed_tools: vec!["Bash".to_string()],
                system_prompt: "Kanna context".to_string(),
                mcp_config_path: None,
                executable: None,
            },
        };

        let created = spawn_prepared_task(&mut client, prepared).await.unwrap();
        let command = daemon.await.unwrap();

        assert_eq!(created.task_id, "task-1");
        match command {
            kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
                assert_eq!(session_id, "task-1");
                assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
                assert_eq!(params.prompt, "Do work");
                assert_eq!(params.model.as_deref(), Some("sonnet"));
                assert_eq!(params.permission_mode.as_deref(), Some("dontAsk"));
                assert_eq!(params.allowed_tools, vec!["Bash".to_string()]);
                assert_eq!(params.cwd, "/tmp/repo/.kanna-worktrees/task-1");
                assert_eq!(params.system_prompt.as_deref(), Some("Kanna context"));
                assert_eq!(params.executable, None);
            }
            other => panic!("expected SpawnAgent, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn prepared_agent_task_spawn_includes_task_specific_kanna_context() {
        let repo_root =
            init_git_repo_with_pipeline("agent-kanna-context", "qa", "verify", "auto", "claude");
        let config = test_config("agent-kanna-context");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Exercise Kanna context".to_string(),
                pipeline_name: Some("qa".to_string()),
                base_ref: None,
                stage: Some("verify".to_string()),
                agent_provider: Some("claude".to_string()),
                agent_type: Some("agent".to_string()),
                model: None,
                permission_mode: None,
                allowed_tools: None,
                blocker_task_ids: None,
                notify_task_id: None,
            },
        )
        .unwrap();
        let task_id = prepared.created_task.task_id.clone();
        let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

        let created = spawn_prepared_task(&mut daemon, prepared).await.unwrap();
        let command = fake_daemon.await.unwrap();

        assert_eq!(created.task_id, task_id);
        match command {
            kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
                assert_eq!(session_id, task_id);
                let mcp_config = params
                    .env
                    .get("KANNA_MCP_CONFIG")
                    .expect("spawn env should include instance-local MCP config");
                assert!(
                    mcp_config.contains("/runtime/mcp/"),
                    "MCP config should be generated in the instance runtime area"
                );
                assert!(
                    !mcp_config.contains(".kanna-worktrees/"),
                    "MCP config should not be generated inside the repo worktree"
                );
                let mcp_config_json: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(mcp_config).unwrap()).unwrap();
                assert_eq!(
                    mcp_config_json["mcpServers"]["kanna-mcp"]["command"],
                    params.env["KANNA_MCP_PATH"]
                );
                assert_eq!(
                    mcp_config_json["mcpServers"]["kanna-mcp"]["args"],
                    serde_json::json!(["serve"])
                );
                assert_eq!(
                    mcp_config_json["mcpServers"]["kanna-mcp"]["env"]["KANNA_SERVER_BASE_URL"],
                    params.env["KANNA_SERVER_BASE_URL"]
                );
                let system_prompt = params.system_prompt.expect("system prompt should be sent");
                assert!(system_prompt.contains(&format!("task `{task_id}`")));
                assert!(system_prompt.contains("stage `verify`"));
                assert!(system_prompt.contains("pipeline `qa`"));
                assert!(system_prompt.contains("transition `auto`"));
                assert!(system_prompt.contains("instance-local `kanna-mcp` config is available"));
                assert!(system_prompt.contains("Claude is launched with this config"));
                assert!(
                    system_prompt.contains("Prefer `kanna-mcp` tools for Kanna task operations")
                );
                assert!(system_prompt.contains(
                    "If MCP tools are unavailable, fall back to the instance-local `kanna-cli`"
                ));
                assert!(system_prompt.contains("KANNA_CLI_PATH"));
                assert!(system_prompt.contains("kanna-cli guide"));
                assert!(system_prompt.contains("kanna-cli stage-complete"));
            }
            other => panic!("expected SpawnAgent, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn prepared_claude_pty_task_spawn_passes_kanna_context_as_append_system_prompt() {
        let repo_root = init_git_repo_with_pipeline(
            "claude-pty-kanna-context",
            "qa",
            "implement",
            "manual",
            "claude",
        );
        let config = test_config("claude-pty-kanna-context");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use Claude PTY".to_string(),
                pipeline_name: Some("qa".to_string()),
                base_ref: None,
                stage: Some("implement".to_string()),
                agent_provider: Some("claude".to_string()),
                agent_type: Some("pty".to_string()),
                model: None,
                permission_mode: None,
                allowed_tools: None,
                blocker_task_ids: None,
                notify_task_id: None,
            },
        )
        .unwrap();
        let task_id = prepared.created_task.task_id.clone();
        let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

        spawn_prepared_task(&mut daemon, prepared).await.unwrap();
        let command = fake_daemon.await.unwrap();

        match command {
            kanna_daemon::protocol::Command::Spawn {
                session_id, args, ..
            } => {
                assert_eq!(session_id, task_id);
                let shell_command = args.last().expect("shell command argument");
                assert!(shell_command.contains("claude "));
                assert!(shell_command.contains("--mcp-config"));
                assert!(shell_command.contains("/runtime/mcp/"));
                assert!(shell_command.contains("--append-system-prompt"));
                assert!(shell_command.contains(&format!("task `{task_id}`")));
                assert!(shell_command.contains("stage `implement`"));
                assert!(shell_command.contains("pipeline `qa`"));
                assert!(shell_command.contains("transition `manual`"));
                assert!(shell_command.contains("kanna-cli stage-complete"));
                assert!(shell_command.contains("'Use Claude PTY'"));
            }
            other => panic!("expected Spawn, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn prepared_non_claude_pty_task_spawn_prepends_kanna_context_to_prompt() {
        let repo_root = init_git_repo_with_pipeline(
            "copilot-pty-kanna-context",
            "qa",
            "implement",
            "manual",
            "copilot",
        );
        let config = test_config("copilot-pty-kanna-context");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use Copilot PTY".to_string(),
                pipeline_name: Some("qa".to_string()),
                base_ref: None,
                stage: Some("implement".to_string()),
                agent_provider: Some("copilot".to_string()),
                agent_type: Some("pty".to_string()),
                model: None,
                permission_mode: None,
                allowed_tools: None,
                blocker_task_ids: None,
                notify_task_id: None,
            },
        )
        .unwrap();
        let task_id = prepared.created_task.task_id.clone();
        let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

        spawn_prepared_task(&mut daemon, prepared).await.unwrap();
        let command = fake_daemon.await.unwrap();

        match command {
            kanna_daemon::protocol::Command::Spawn {
                session_id, args, ..
            } => {
                assert_eq!(session_id, task_id);
                let shell_command = args.last().expect("shell command argument");
                assert!(shell_command.contains("copilot "));
                assert!(!shell_command.contains("--append-system-prompt"));
                let context_index = shell_command
                    .find("## Kanna Task Context")
                    .expect("Kanna context should be prompt-prepended");
                let prompt_index = shell_command
                    .find("Use Copilot PTY")
                    .expect("original prompt should be retained");
                assert!(context_index < prompt_index);
                assert!(shell_command.contains(&format!("task `{task_id}`")));
                assert!(shell_command.contains("stage `implement`"));
                assert!(shell_command.contains("pipeline `qa`"));
                assert!(shell_command.contains("transition `manual`"));
                assert!(shell_command.contains("kanna-cli stage-complete"));
            }
            other => panic!("expected Spawn, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn build_spawn_env_prefers_configured_kanna_cli_path() {
        let mut config = test_config("spawn-env-configured-kanna-cli-path");
        config.kanna_cli_path =
            Some("/Applications/Kanna.app/Contents/MacOS/kanna-cli".to_string());

        let env = build_spawn_env(&config, "task-1", &HashMap::new()).unwrap();

        assert_eq!(
            env.get("KANNA_CLI_PATH").map(String::as_str),
            Some("/Applications/Kanna.app/Contents/MacOS/kanna-cli")
        );
        assert!(env
            .get("PATH")
            .expect("PATH should be set for sidecars")
            .split(':')
            .any(|entry| entry == "/Applications/Kanna.app/Contents/MacOS"));
    }

    #[test]
    fn prepare_merge_agent_creates_in_progress_task() {
        let repo_root =
            std::env::temp_dir().join(format!("kanna-merge-agent-task-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(&repo_root).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = test_config("prepare-merge-agent-in-progress");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Create a PR",
            Some("Create a PR"),
            "pr",
            "2026-06-07 00:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-task-1",
            "default",
            None,
            "claude",
        )
        .unwrap();

        let prepared = prepare_merge_agent_for_api(&db, &config, "task-1").unwrap();

        assert_eq!(prepared.created_task.repo_id, "repo-1");
        assert_eq!(prepared.created_task.stage, "in progress");
        assert!(prepared.created_task.title.contains("merge agent"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_advance_stage_builds_next_stage_task_from_previous_branch() {
        let repo_root =
            std::env::temp_dir().join(format!("kanna-stage-advance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "pr", "transition": "manual", "agent": "reviewer", "prompt": "Review branch $BRANCH against $BASE_REF with result $PREV_RESULT" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/reviewer/AGENT.md"),
            "---\nagent_provider: claude\n---\nReview task: $TASK_PROMPT",
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "add kanna config"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-old-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("advance-stage-helper"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Fix the mobile shell",
            Some("Mobile shell"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-old-branch",
            "default",
            Some("{\"status\":\"success\"}"),
            "copilot",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("task-1", "origin/main")
            .unwrap();

        let prepared = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
            PreparedStageTransition::Spawn(prepared) => prepared,
            PreparedStageTransition::Continue(_) => panic!("expected new task transition"),
        };
        let created_source = db
            .get_task_stage_source(&prepared.created_task.task_id)
            .unwrap()
            .unwrap();

        assert_eq!(prepared.created_task.repo_id, "repo-1");
        assert_eq!(prepared.created_task.stage, "pr");
        assert_eq!(prepared.created_task.title, "Mobile shell");
        assert_eq!(prepared.created_task.agent_type, "pty");
        assert_eq!(created_source.display_name.as_deref(), Some("Mobile shell"));
        assert_eq!(created_source.agent_type.as_deref(), Some("pty"));
        assert_eq!(
            created_source.prompt.as_deref(),
            Some("Review task: Fix the mobile shell\n\nReview branch task-old-branch against origin/main with result {\"status\":\"success\"}")
        );
        assert_eq!(created_source.base_ref.as_deref(), Some("origin/main"));
        assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
    }

    #[test]
    fn prepare_advance_stage_uses_current_source_worktree_branch_after_rename() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-advance-renamed-source-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "pr", "transition": "manual", "agent": "reviewer", "prompt": "Review branch $BRANCH against $BASE_REF" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/reviewer/AGENT.md"),
            "---\nagent_provider: claude\n---\nReview task: $TASK_PROMPT",
        )
        .unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-old-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let source_worktree = repo_root.join(".kanna-worktrees/task-old-branch");
        assert!(Command::new("git")
            .args([
                "worktree",
                "add",
                source_worktree.to_string_lossy().as_ref(),
                "task-old-branch",
            ])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "-m", "renamed/source-branch"])
            .current_dir(&source_worktree)
            .status()
            .unwrap()
            .success());
        assert!(!Command::new("git")
            .args(["rev-parse", "--verify", "task-old-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: std::env::temp_dir()
                .join(format!("kanna-daemon-continue-{}", std::process::id()))
                .to_string_lossy()
                .to_string(),
            db_path: Db::test_db_path("advance-stage-renamed-source"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Fix the mobile shell",
            Some("Mobile shell"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-old-branch",
            "default",
            Some("{\"status\":\"success\"}"),
            "copilot",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("task-1", "origin/dev")
            .unwrap();

        let prepared = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
            PreparedStageTransition::Spawn(prepared) => prepared,
            PreparedStageTransition::Continue(_) => panic!("expected new task transition"),
        };

        assert_eq!(prepared.created_task.repo_id, "repo-1");
        assert_eq!(prepared.created_task.stage, "pr");
        assert_eq!(prepared.created_task.title, "Mobile shell");
        let created_source = db
            .get_task_stage_source(&prepared.created_task.task_id)
            .unwrap()
            .unwrap();
        assert_eq!(created_source.display_name.as_deref(), Some("Mobile shell"));
        assert_eq!(
            created_source.prompt.as_deref(),
            Some("Review task: Fix the mobile shell\n\nReview branch renamed/source-branch against origin/dev")
        );
        assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn prepare_advance_stage_continues_commit_stage_in_same_task_and_worktree() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-advance-continue-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "commit", "transition": "auto", "mode": "continue", "agent": "commit", "prompt": "Commit $TASK_PROMPT from $BRANCH after $PREV_RESULT" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/commit/AGENT.md"),
            "---\nagent_provider: claude\n---\nCommit agent",
        )
        .unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-source"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        let source_worktree = repo_root.join(".kanna-worktrees/task-source");
        assert!(Command::new("git")
            .args([
                "worktree",
                "add",
                source_worktree.to_string_lossy().as_ref(),
                "task-source",
            ])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("advance-stage-continue"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Fix stage promotion",
            Some("Fix stage promotion"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-source",
            "default",
            Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
            "claude",
        )
        .unwrap();
        db.update_test_pipeline_item_agent_type("task-1", "sdk")
            .unwrap();

        let prepared = prepare_advance_stage_for_api(&db, &config, "task-1").unwrap();
        let continuation = match prepared {
            PreparedStageTransition::Continue(continuation) => continuation,
            PreparedStageTransition::Spawn(_) => panic!("expected continue transition"),
        };

        assert_eq!(continuation.task_id, "task-1");
        assert_eq!(continuation.agent_type, "agent");
        assert_eq!(continuation.previous_stage, "in progress");
        assert_eq!(continuation.next_stage, "commit");
        assert_eq!(
            String::from_utf8(continuation.input.clone()).unwrap(),
            "\u{1b}[200~Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}\u{1b}[201~\r"
        );
        assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-agent-1",
        )
        .unwrap();

        let fake_daemon = spawn_fake_daemon_once(config.daemon_dir.clone()).await;
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
        let continued =
            continue_prepared_stage_for_api(&config.db_path, &mut daemon, *continuation)
                .await
                .unwrap();
        let command = fake_daemon.await.unwrap();
        assert_eq!(continued.task_id, "task-1");
        match command {
            kanna_daemon::protocol::Command::AgentInput { session_id, text } => {
                assert_eq!(session_id, "daemon-agent-1");
                assert_eq!(
                    text,
                    "Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}"
                );
            }
            other => panic!("expected daemon agent input command, got {:?}", other),
        }
        let updated_source = db.get_task_stage_source("task-1").unwrap().unwrap();
        assert_eq!(updated_source.stage.as_deref(), Some("commit"));
        assert_eq!(updated_source.branch.as_deref(), Some("task-source"));
        assert_eq!(updated_source.stage_result, None);
        assert_eq!(updated_source.closed_at, None);
        assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_advance_stage_rejects_closed_source_task_even_when_stage_is_active() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-advance-closed-source-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual", "mode": "continue" }
  ]
}"#,
        )
        .unwrap();

        let config = test_config("advance-stage-closed-source");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Fix stage promotion",
            Some("Fix stage promotion"),
            "review",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-source",
            "default",
            Some("{\"status\":\"success\",\"summary\":\"reviewed\"}"),
            "claude",
        )
        .unwrap();
        Connection::open(&config.db_path)
            .unwrap()
            .execute(
                "UPDATE pipeline_item SET closed_at = datetime('now') WHERE id = ?",
                ["task-1"],
            )
            .unwrap();

        let err = match prepare_advance_stage_for_api(&db, &config, "task-1") {
            Ok(_) => panic!("closed task should not prepare a stage transition"),
            Err(err) => err,
        };

        assert!(
            err.contains("task is closed: task-1"),
            "unexpected error: {err}"
        );

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn prepare_advance_stage_enters_post_action_without_changing_stage() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-advance-post-action-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    {
      "name": "in progress",
      "transition": "manual",
      "post_action": {
        "name": "commit",
        "transition": "auto",
        "agent": "commit",
        "prompt": "Commit $TASK_PROMPT from $BRANCH after $PREV_RESULT"
      }
    },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/commit/AGENT.md"),
            "---\nagent_provider: claude\n---\nCommit agent",
        )
        .unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-source"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        let source_worktree = repo_root.join(".kanna-worktrees/task-source");
        assert!(Command::new("git")
            .args([
                "worktree",
                "add",
                source_worktree.to_string_lossy().as_ref(),
                "task-source",
            ])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: std::env::temp_dir()
                .join(format!("kanna-daemon-post-action-{}", std::process::id()))
                .to_string_lossy()
                .to_string(),
            db_path: Db::test_db_path("advance-stage-post-action"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Fix stage promotion",
            Some("Fix stage promotion"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-source",
            "default",
            Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
            "claude",
        )
        .unwrap();

        let prepared = prepare_advance_stage_for_api(&db, &config, "task-1").unwrap();
        let continuation = match prepared {
            PreparedStageTransition::Continue(continuation) => continuation,
            PreparedStageTransition::Spawn(_) => panic!("expected post-action continuation"),
        };

        assert_eq!(continuation.task_id, "task-1");
        assert_eq!(continuation.previous_stage, "in progress");
        assert_eq!(continuation.next_stage, "in progress");
        assert_eq!(continuation.active_post_action.as_deref(), Some("commit"));
        assert_eq!(
            String::from_utf8(continuation.input.clone()).unwrap(),
            "\u{1b}[200~Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}\u{1b}[201~\r"
        );

        let fake_daemon = spawn_fake_daemon_once(config.daemon_dir.clone()).await;
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
        let continued =
            continue_prepared_stage_for_api(&config.db_path, &mut daemon, *continuation)
                .await
                .unwrap();
        let command = fake_daemon.await.unwrap();
        assert_eq!(continued.task_id, "task-1");
        match command {
            kanna_daemon::protocol::Command::Input { session_id, data } => {
                assert_eq!(session_id, "task-1");
                assert_eq!(
                    String::from_utf8(data).unwrap(),
                    "\u{1b}[200~Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}\u{1b}[201~\r"
                );
            }
            other => panic!("expected daemon input command, got {:?}", other),
        }
        let updated_source = db.get_task_stage_source("task-1").unwrap().unwrap();
        assert_eq!(updated_source.stage.as_deref(), Some("in progress"));
        assert_eq!(updated_source.active_post_action.as_deref(), Some("commit"));
        assert_eq!(updated_source.stage_result, None);
        assert_eq!(updated_source.closed_at, None);
        assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_auto_stage_completion_from_commit_creates_pr_task_from_original_branch() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-auto-pr-after-continue-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/pr")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "commit", "transition": "auto", "mode": "continue" },
    { "name": "pr", "transition": "manual", "agent": "pr", "prompt": "Create PR for $BRANCH from $SOURCE_WORKTREE after $PREV_RESULT" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/pr/AGENT.md"),
            "---\nagent_provider: claude\n---\nPR agent for $TASK_PROMPT",
        )
        .unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-source"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        let source_worktree = repo_root.join(".kanna-worktrees/task-source");
        assert!(Command::new("git")
            .args([
                "worktree",
                "add",
                source_worktree.to_string_lossy().as_ref(),
                "task-source",
            ])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("auto-pr-after-continue"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Fix stage promotion",
            Some("Fix stage promotion"),
            "commit",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-source",
            "default",
            Some("{\"status\":\"success\",\"summary\":\"committed\"}"),
            "claude",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("task-1", "origin/main")
            .unwrap();

        let prepared =
            super::prepare_auto_stage_completion_for_api(&db, &config, "task-1").unwrap();
        let spawn = match prepared {
            Some(PreparedStageTransition::Spawn(spawn)) => spawn,
            Some(PreparedStageTransition::Continue(_)) => panic!("expected pr task spawn"),
            None => panic!("expected auto transition"),
        };

        assert_eq!(spawn.created_task.repo_id, "repo-1");
        assert_eq!(spawn.created_task.stage, "pr");
        assert_ne!(spawn.created_task.task_id, "task-1");
        assert_eq!(spawn.created_task.title, "Fix stage promotion");
        let created_source = db
            .get_task_stage_source(&spawn.created_task.task_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            created_source.display_name.as_deref(),
            Some("Fix stage promotion")
        );
        let expected_prompt = format!(
            "PR agent for Fix stage promotion\n\nCreate PR for task-source from {} after {{\"status\":\"success\",\"summary\":\"committed\"}}",
            source_worktree.to_string_lossy()
        );
        assert_eq!(
            created_source.prompt.as_deref(),
            Some(expected_prompt.as_str())
        );
        assert!(spawn.cwd.contains(".kanna-worktrees/task-"));
        assert!(!spawn.cwd.ends_with("task-source"));
        assert_eq!(created_source.base_ref.as_deref(), Some("origin/main"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_task_uses_builtin_default_pipeline_when_repo_has_no_local_default_pipeline() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-task-default-pipeline-fallback-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(&repo_root).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("default-pipeline-fallback"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();

        let original_cwd = std::env::current_dir().unwrap();
        let unrelated_cwd = std::env::temp_dir().join(format!(
            "kanna-task-default-pipeline-unrelated-cwd-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&unrelated_cwd);
        std::fs::create_dir_all(&unrelated_cwd).unwrap();
        std::env::set_current_dir(&unrelated_cwd).unwrap();

        let prepared_result = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Implement the fallback".to_string(),
                pipeline_name: None,
                base_ref: None,
                stage: None,
                agent_provider: Some("codex".to_string()),
                agent_type: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                blocker_task_ids: None,
                notify_task_id: None,
            },
        );
        std::env::set_current_dir(original_cwd).unwrap();
        let prepared = prepared_result.unwrap();

        assert_eq!(prepared.created_task.stage, "in progress");
        assert_eq!(prepared.created_task.title, "Implement the fallback");
        let branch = format!("task-{}", prepared.session_id);
        let worktree_count = db
            .count_test_worktrees_for_task(&prepared.created_task.task_id, &prepared.cwd, &branch)
            .unwrap();
        assert_eq!(worktree_count, 1);
        let terminal_session_id = db
            .resolve_task_terminal_session_id(&prepared.created_task.task_id)
            .unwrap();
        assert_eq!(
            terminal_session_id.as_deref(),
            Some(prepared.session_id.as_str())
        );
    }

    #[test]
    fn prepare_task_uses_default_agent_provider_setting_when_request_omits_provider() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-task-default-agent-provider-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(&repo_root).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("default-agent-provider"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.set_test_setting("defaultAgentProvider", "copilot")
            .unwrap();

        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use the configured default provider".to_string(),
                pipeline_name: None,
                base_ref: None,
                stage: None,
                agent_provider: None,
                agent_type: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                blocker_task_ids: None,
                notify_task_id: None,
            },
        )
        .unwrap();
        let created_source = db
            .get_task_stage_source(&prepared.created_task.task_id)
            .unwrap()
            .unwrap();

        assert_eq!(created_source.agent_provider.as_deref(), Some("copilot"));

        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: "Use the explicit provider".to_string(),
                pipeline_name: None,
                base_ref: None,
                stage: None,
                agent_provider: Some("codex".to_string()),
                agent_type: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                blocker_task_ids: None,
                notify_task_id: None,
            },
        )
        .unwrap();
        let created_source = db
            .get_task_stage_source(&prepared.created_task.task_id)
            .unwrap()
            .unwrap();

        assert_eq!(created_source.agent_provider.as_deref(), Some("codex"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn default_agent_provider_setting_falls_back_to_claude_when_unset() {
        let db_path = Db::test_db_path("default-agent-provider-unset");
        let db = Db::open_for_tests(&db_path).unwrap();

        let provider = read_default_agent_provider_setting(&db).unwrap();

        assert_eq!(provider.as_deref(), Some("claude"));
    }

    #[test]
    fn prepare_revision_task_builds_target_stage_task_from_reviewed_branch() {
        let repo_root =
            std::env::temp_dir().join(format!("kanna-stage-revision-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "auto" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/implement/AGENT.md"),
            "---\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-reviewed-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("revision-stage-helper"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "review-task",
            "repo-1",
            "Fix the mobile shell",
            Some("Mobile shell"),
            "review",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "review-task",
            "task-reviewed-branch",
            "qa",
            Some("{\"status\":\"failure\",\"summary\":\"missing e2e\"}"),
            "copilot",
        )
        .unwrap();

        let prepared = prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Add e2e coverage for task creation.",
        )
        .unwrap();

        assert_eq!(prepared.created_task.repo_id, "repo-1");
        assert_eq!(prepared.created_task.stage, "in progress");
        assert_eq!(prepared.created_task.title, "Mobile shell");
        assert_eq!(prepared.created_task.agent_type, "pty");
        let created_source = db
            .get_pipeline_item(&prepared.created_task.task_id)
            .unwrap()
            .unwrap();
        assert_eq!(created_source.display_name.as_deref(), Some("Mobile shell"));
        assert_eq!(created_source.agent_type.as_deref(), Some("pty"));
        assert_eq!(
            created_source.prompt.as_deref(),
            Some("Implement revision:\nAdd e2e coverage for task creation.\n\nAdd e2e coverage for task creation.")
        );
        assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
    }

    #[tokio::test]
    async fn prepared_revision_agent_task_spawn_sends_task_specific_kanna_context() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-revision-spawn-context-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "auto", "agent_provider": "claude", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-reviewed-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = test_config("revision-agent-spawn-kanna-context");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "review-task",
            "repo-1",
            "Review branch task-reviewed-branch.",
            Some("Mobile shell"),
            "review",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "review-task",
            "task-reviewed-branch",
            "qa",
            Some("{\"status\":\"failure\",\"summary\":\"missing e2e\"}"),
            "claude",
        )
        .unwrap();
        db.update_test_pipeline_item_agent_type("review-task", "agent")
            .unwrap();
        let prepared = prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Add integration coverage for spawned Kanna context.",
        )
        .unwrap();
        let task_id = prepared.created_task.task_id.clone();
        let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

        let created = spawn_prepared_task(&mut daemon, prepared).await.unwrap();
        let command = fake_daemon.await.unwrap();

        assert_eq!(created.task_id, task_id);
        match command {
            kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
                assert_eq!(session_id, task_id);
                assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
                assert!(params.cwd.contains(".kanna-worktrees/task-"));
                let system_prompt = params.system_prompt.expect("system prompt should be sent");
                assert!(system_prompt.contains(&format!("task `{task_id}`")));
                assert!(system_prompt.contains("stage `in progress`"));
                assert!(system_prompt.contains("pipeline `qa`"));
                assert!(system_prompt.contains("transition `auto`"));
                assert!(system_prompt.contains("instance-local `kanna-mcp` config is available"));
                assert!(system_prompt.contains("Claude is launched with this config"));
                assert!(
                    system_prompt.contains("Prefer `kanna-mcp` tools for Kanna task operations")
                );
                assert!(system_prompt.contains(
                    "If MCP tools are unavailable, fall back to the instance-local `kanna-cli`"
                ));
                assert!(system_prompt.contains("kanna-cli guide"));
                assert!(system_prompt.contains("kanna-cli stage-complete"));
                assert!(system_prompt.contains("KANNA_CLI_PATH"));
            }
            other => panic!("expected SpawnAgent, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_revision_task_rejects_closed_source_task_even_when_stage_is_active() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-revision-closed-source-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();

        let config = test_config("revision-stage-closed-source");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "review-task",
            "repo-1",
            "Fix the mobile shell",
            Some("Mobile shell"),
            "review",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "review-task",
            "task-reviewed-branch",
            "qa",
            Some("{\"status\":\"failure\",\"summary\":\"needs revision\"}"),
            "claude",
        )
        .unwrap();
        Connection::open(&config.db_path)
            .unwrap()
            .execute(
                "UPDATE pipeline_item SET closed_at = datetime('now') WHERE id = ?",
                ["review-task"],
            )
            .unwrap();

        let err = match prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Add more tests",
        ) {
            Ok(_) => panic!("closed task should not prepare a revision task"),
            Err(err) => err,
        };

        assert!(
            err.contains("task is closed: review-task"),
            "unexpected error: {err}"
        );

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_revision_task_recovers_title_from_reviewed_branch_when_review_title_is_missing() {
        let repo_root = std::env::temp_dir().join(format!(
            "kanna-stage-revision-title-recovery-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "auto" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/implement/AGENT.md"),
            "---\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", "README.md", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-reviewed-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-review-branch"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("revision-title-recovery"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "source-task",
            "repo-1",
            "Original implementation instructions",
            Some("cloud/mobile"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "source-task",
            "task-reviewed-branch",
            "qa",
            Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
            "codex",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "review-task",
            "repo-1",
            "You are a QA review agent.\n\nReview branch task-reviewed-branch for task quality and test coverage against base origin/main. Original task: Original implementation instructions.",
            None,
            "review",
            "2026-04-17 07:01:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "review-task",
            "task-review-branch",
            "qa",
            Some("{\"status\":\"failure\",\"summary\":\"missing e2e\"}"),
            "codex",
        )
        .unwrap();

        let prepared = prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Add e2e coverage for task creation.",
        )
        .unwrap();
        let created_source = db
            .get_pipeline_item(&prepared.created_task.task_id)
            .unwrap()
            .unwrap();

        assert_eq!(prepared.created_task.title, "cloud/mobile");
        assert_eq!(created_source.display_name.as_deref(), Some("cloud/mobile"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }
}
