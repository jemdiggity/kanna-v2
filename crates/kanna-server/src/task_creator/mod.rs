mod commands;
mod definitions;
mod environment;
mod lifecycle;
mod merge;
mod prompt;
mod provider;
mod resume;
mod stages;
mod types;
mod worktree;

#[cfg(test)]
mod tests;

use crate::config::Config;
use crate::db::{Db, NewPipelineItem, NewStageRun, Repo};
use commands::{
    build_agent_command, build_kanna_preamble, build_task_shell_command,
    build_teardown_shell_command,
};
use definitions::{
    read_agent_definition, read_pipeline_definition, read_repo_config,
    read_task_pipeline_definition, PipelineStage, PipelineStagePolicy, PipelineStageTransition,
    RepoConfig,
};
use environment::{
    apply_workspace_path_env, build_spawn_env, claim_task_ports, resolve_headless_agent_executable,
    write_kanna_mcp_config,
};
use prompt::{build_stage_prompt, PromptContext};
use provider::{resolve_agent_provider, resolve_agent_type, AgentProvider, AgentSessionType};
use std::collections::HashMap;
use types::{
    CreatedTask, ForkedWorkspace, PreparedRunWorkspace, PreparedSessionSpawn, PreparedStageRerun,
    RunWorkspaceSpec, TaskCreationRequest,
};
pub(crate) use types::{
    PreparedStageRunSpawn, PreparedStageTransition, PreparedTaskSpawn, PreparedWorkspaceTeardown,
};
use worktree::{
    create_worktree, fetch_start_point, generate_task_id, merge_branches_into_worktree,
    remove_prepared_worktree, MergeBranchesError,
};

pub(crate) use environment::warm_login_shell_path;
pub(crate) use lifecycle::{
    dispatch_prepared_post_for_api, kill_session_replacing, prepared_task_id,
    rerun_prepared_stage_for_api, rollback_prepared_task_for_api, spawn_prepared_stage_run_for_api,
    spawn_prepared_task_for_api_recording_stage_run, spawn_prepared_task_for_api_with_diagnostics,
    spawn_prepared_workspace_teardown_best_effort,
};
pub(crate) use merge::prepare_merge_agent_for_api;
pub use merge::run_merge_agent;
pub(crate) use stages::{
    prepare_advance_stage_for_api, prepare_revision_task_for_api, prepare_stage_completion_for_api,
    resolve_stage_transition,
};
pub(crate) use worktree::resolve_current_source_worktree_branch;

#[derive(Debug)]
pub(crate) struct DormantMergeConflict {
    pub(crate) base_branch: String,
    pub(crate) remaining_branches: Vec<String>,
    pub(crate) conflicting_branch: String,
    pub(crate) message: String,
}

#[derive(Debug)]
pub(crate) enum DormantStartError {
    MergeConflict(DormantMergeConflict),
    Other(String),
}

impl From<String> for DormantStartError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}

impl std::fmt::Display for DormantStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MergeConflict(conflict) => write!(f, "{}", conflict.message),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

pub(crate) fn prepare_rerun_stage_for_api(
    db: &Db,
    config: &Config,
    task_id: &str,
) -> Result<PreparedStageRerun, String> {
    let source_task = db
        .get_task_stage_source(task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", task_id))?;
    if source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", task_id));
    }
    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {}", task_id))?;
    let repo = db
        .get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", task_id))?;
    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let stage_name = source_task
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", task_id))?;
    let pipeline = read_task_pipeline_definition(
        &repo.path,
        &pipeline_name,
        source_task.pipeline_def.as_deref(),
    )?;
    // A legacy in-flight task can be parked at a folded post name (e.g.
    // `commit`); rerunning it respawns the post as a fresh session.
    let (current_stage, run_kind): (PipelineStage, &'static str) =
        match definitions::resolve_stage_position(&pipeline, &stage_name)
            .ok_or_else(|| format!("stage not found in pipeline: {}", stage_name))?
        {
            definitions::StagePosition::Stage(index) => (pipeline.stages[index].clone(), "main"),
            definitions::StagePosition::Post { owner } => {
                let owner_stage = &pipeline.stages[owner];
                (
                    definitions::post_as_stage(owner_stage)
                        .ok_or_else(|| format!("stage has no post: {}", owner_stage.name))?,
                    "post",
                )
            }
        };
    let current_stage = &current_stage;
    let agent = match current_stage.agent.as_deref() {
        Some(agent_name) => Some(read_agent_definition(&repo.path, agent_name)?),
        None => None,
    };
    let source_worktree = source_task
        .base_ref
        .as_deref()
        .filter(|base_ref| base_ref.starts_with("task-"))
        .map(|base_ref| format!("{}/.kanna-worktrees/{base_ref}", repo.path));
    let prev_result = stages::previous_stage_result(db, task_id, &source_task)?;
    let prompt = build_stage_prompt(
        agent
            .as_ref()
            .map(|agent| agent.prompt.as_str())
            .unwrap_or(""),
        current_stage.prompt.as_deref(),
        &PromptContext {
            task_prompt: source_task.prompt.as_deref(),
            prev_result: prev_result.as_deref(),
            branch: Some(branch),
            base_ref: source_task.base_ref.as_deref(),
            source_worktree: source_worktree.as_deref(),
        },
    );
    let provider = resolve_agent_provider(
        source_task.agent_provider.as_deref(),
        None,
        current_stage.agent_provider.as_deref(),
        agent.as_ref(),
    )?;
    let model = agent.as_ref().and_then(|agent| agent.model.clone());
    let permission_mode = agent
        .as_ref()
        .and_then(|agent| agent.permission_mode.clone());
    let allowed_tools = agent
        .as_ref()
        .map(|agent| agent.allowed_tools.clone())
        .unwrap_or_default();
    let agent_type = resolve_agent_type(source_task.agent_type.as_deref(), provider)?;
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);
    if !std::path::Path::new(&worktree_path).is_dir() {
        let start_point = source_task
            .base_ref
            .clone()
            .or_else(|| fetch_start_point(&repo.path, repo.default_branch.as_deref()));
        create_worktree(&repo.path, branch, &worktree_path, start_point.as_deref())?;
        db.upsert_worktree(&format!("wt-{task_id}"), task_id, &worktree_path, branch)
            .map_err(|e| format!("db error: {}", e))?;
        db.upsert_terminal_session(
            &format!("agent-{task_id}"),
            &repo.id,
            Some(task_id),
            Some("agent"),
            Some(&worktree_path),
            Some(task_id),
        )
        .map_err(|e| format!("db error: {}", e))?;
    }
    let repo_config = read_repo_config(&repo.path)?;
    let worktree_repo_config = read_repo_config(&worktree_path)?;
    let port_env = claim_task_ports(db, task_id, repo_config.ports.as_ref())?;
    let mut spawn_env = build_spawn_env(config, task_id, &port_env)?;
    apply_workspace_path_env(&mut spawn_env, &worktree_path, &worktree_repo_config);
    let mcp_config_path = write_kanna_mcp_config(&config.daemon_dir, task_id, &mut spawn_env)?;
    let stage_setup = current_stage
        .environment
        .as_deref()
        .and_then(|name| pipeline.environments.as_ref()?.get(name))
        .and_then(|environment| environment.setup.clone())
        .unwrap_or_default();
    let stage_run_model = model.clone();
    let (session, provider_session_id) = build_prepared_session(
        provider,
        agent_type,
        task_id,
        &stage_name,
        &pipeline_name,
        Some(current_stage.policy.transition.as_str()),
        prompt,
        model,
        permission_mode,
        allowed_tools,
        mcp_config_path,
        &spawn_env,
        &worktree_path,
        &stage_setup,
        None,
    )?;
    let session_id = db
        .resolve_task_terminal_session_id(task_id)
        .map_err(|e| format!("db error: {}", e))?
        .unwrap_or_else(|| task_id.to_string());
    Ok(PreparedStageRerun {
        task_id: task_id.to_string(),
        session_id,
        stage: current_stage.name.clone(),
        run_kind,
        stage_agent: current_stage.agent.clone(),
        agent_provider: provider.as_str().to_string(),
        model: stage_run_model,
        provider_session_id,
        cwd: worktree_path,
        env: spawn_env,
        session,
    })
}

/// Prepare a new stage run to be spawned on an existing task. Used for stage
/// advance, auto-advance, revisions, and dead-session post fallbacks
/// (`run_kind = "post"`, where `item_stage` stays the owning stage and
/// `target_stage` is the post viewed as a stage).
///
/// `RunWorkspaceSpec::Fork` forks a fresh workspace for the run: a new branch
/// and worktree created from the task's current branch tip (only committed
/// work crosses a stage boundary — the stage's post committed it).
/// `RunWorkspaceSpec::Resume` adopts a previous run's worktree and resumes
/// its agent-CLI session; `Current` keeps the task's current workspace (post
/// fallbacks, reruns).
#[allow(clippy::too_many_arguments)]
pub(in crate::task_creator) fn prepare_stage_run_spawn(
    db: &Db,
    config: &Config,
    repo: &Repo,
    task_id: &str,
    pipeline_name: &str,
    pipeline: &definitions::PipelineDefinition,
    target_stage: &PipelineStage,
    item_stage: &str,
    run_kind: &'static str,
    workspace_spec: RunWorkspaceSpec,
    final_prompt: String,
    branch: &str,
    feedback: Option<String>,
    source_agent_type: Option<&str>,
    explicit_provider: Option<String>,
) -> Result<PreparedStageRunSpawn, String> {
    let agent = match target_stage.agent.as_deref() {
        Some(agent_name) => Some(read_agent_definition(&repo.path, agent_name)?),
        None => None,
    };
    let provider = resolve_agent_provider(
        explicit_provider.as_deref(),
        None,
        target_stage.agent_provider.as_deref(),
        agent.as_ref(),
    )?;
    let agent_type = resolve_agent_type(source_agent_type, provider)?;
    let model = agent.as_ref().and_then(|agent| agent.model.clone());
    let stage_run_model = model.clone();
    let permission_mode = agent
        .as_ref()
        .and_then(|agent| agent.permission_mode.clone());
    let allowed_tools = agent
        .as_ref()
        .map(|agent| agent.allowed_tools.clone())
        .unwrap_or_default();

    let (workspace, claude_resume, resumed_from_run_id) = match workspace_spec {
        RunWorkspaceSpec::Fork {
            branch: fork_branch,
        } => {
            // Fork from the branch actually checked out in the current
            // worktree (agents may have renamed it — the PR agent does).
            let start_point =
                worktree::resolve_current_source_worktree_branch(&repo.path, Some(branch))
                    .unwrap_or_else(|| branch.to_string());
            let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, fork_branch);
            create_worktree(&repo.path, &fork_branch, &worktree_path, Some(&start_point))?;
            (
                PreparedRunWorkspace::Forked(ForkedWorkspace {
                    branch: fork_branch,
                    worktree_path,
                }),
                None,
                None,
            )
        }
        RunWorkspaceSpec::Resume(resume) => (
            PreparedRunWorkspace::Resumed(ForkedWorkspace {
                branch: resume.branch,
                worktree_path: resume.cwd,
            }),
            Some(resume.provider_session_id),
            Some(resume.resumed_from_run_id),
        ),
        RunWorkspaceSpec::Current => (PreparedRunWorkspace::Current, None, None),
    };
    let worktree_path = match &workspace {
        PreparedRunWorkspace::Forked(workspace) | PreparedRunWorkspace::Resumed(workspace) => {
            workspace.worktree_path.clone()
        }
        PreparedRunWorkspace::Current => format!("{}/.kanna-worktrees/{}", repo.path, branch),
    };

    let repo_config = read_repo_config(&repo.path)?;
    let worktree_repo_config = read_repo_config(&worktree_path)?;
    let port_env = claim_task_ports(db, task_id, repo_config.ports.as_ref())?;
    let mut spawn_env = build_spawn_env(config, task_id, &port_env)?;
    apply_workspace_path_env(&mut spawn_env, &worktree_path, &worktree_repo_config);
    let mcp_config_path = write_kanna_mcp_config(&config.daemon_dir, task_id, &mut spawn_env)?;
    // A forked workspace is fresh disk: run the repo's worktree setup (the
    // same commands task creation runs) before any stage-specific setup.
    // Current and resumed workspaces are already set up.
    let mut setup = if matches!(workspace, PreparedRunWorkspace::Forked(_)) {
        worktree_repo_config.setup.clone().unwrap_or_default()
    } else {
        Vec::new()
    };
    setup.extend(
        target_stage
            .environment
            .as_deref()
            .and_then(|name| pipeline.environments.as_ref()?.get(name))
            .and_then(|environment| environment.setup.clone())
            .unwrap_or_default(),
    );
    let (session, provider_session_id) = build_prepared_session(
        provider,
        agent_type,
        task_id,
        &target_stage.name,
        pipeline_name,
        Some(target_stage.policy.transition.as_str()),
        final_prompt,
        model,
        permission_mode,
        allowed_tools,
        mcp_config_path,
        &spawn_env,
        &worktree_path,
        &setup,
        claude_resume.as_deref(),
    )?;
    let session_id = db
        .resolve_task_terminal_session_id(task_id)
        .map_err(|e| format!("db error: {}", e))?
        .unwrap_or_else(|| task_id.to_string());

    Ok(PreparedStageRunSpawn {
        task_id: task_id.to_string(),
        session_id,
        next_stage: item_stage.to_string(),
        run_stage: target_stage.name.clone(),
        run_kind,
        workspace,
        workspace_teardown: None,
        stage_agent: target_stage.agent.clone(),
        agent_provider: provider.as_str().to_string(),
        model: stage_run_model,
        feedback,
        provider_session_id,
        resumed_from_run_id,
        cwd: worktree_path,
        env: spawn_env,
        session,
    })
}

pub(crate) fn prepare_workspace_teardown_for_close(
    db: &Db,
    config: &Config,
    task_id: &str,
) -> Option<PreparedWorkspaceTeardown> {
    let source_task = db.get_task_stage_source(task_id).ok().flatten()?;
    let branch = source_task.branch.as_deref()?;
    let stage_name = source_task.stage.as_deref()?;
    let repo = db.get_repo(&source_task.repo_id).ok().flatten()?;
    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let pipeline = read_task_pipeline_definition(
        &repo.path,
        &pipeline_name,
        source_task.pipeline_def.as_deref(),
    )
    .ok()?;
    prepare_workspace_teardown(db, config, &repo, task_id, &pipeline, stage_name, branch)
}

pub(in crate::task_creator) fn prepare_workspace_teardown(
    db: &Db,
    config: &Config,
    repo: &Repo,
    task_id: &str,
    pipeline: &definitions::PipelineDefinition,
    stage_name: &str,
    branch: &str,
) -> Option<PreparedWorkspaceTeardown> {
    let worktree_path = db
        .get_task_worktree_path(task_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| format!("{}/.kanna-worktrees/{branch}", repo.path));
    if !std::path::Path::new(&worktree_path).is_dir() {
        return None;
    }
    let repo_config = read_repo_config(&repo.path).ok()?;
    let worktree_repo_config = read_repo_config(&worktree_path).unwrap_or_default();
    let mut teardown = stage_environment_teardown(pipeline, stage_name);
    teardown.extend(worktree_repo_config.teardown.clone().unwrap_or_default());
    if teardown.is_empty() {
        return None;
    }

    let port_env = claim_task_ports(db, task_id, repo_config.ports.as_ref()).ok()?;
    let mut spawn_env = build_spawn_env(config, task_id, &port_env).ok()?;
    apply_workspace_path_env(&mut spawn_env, &worktree_path, &worktree_repo_config);
    let session_id = format!("td-{branch}");
    let shell_command = build_teardown_shell_command(&teardown);
    Some(PreparedWorkspaceTeardown {
        session_id,
        cwd: worktree_path,
        env: spawn_env,
        session: PreparedSessionSpawn::Pty {
            executable: "/bin/zsh".to_string(),
            args: vec![
                "--login".to_string(),
                "-i".to_string(),
                "-c".to_string(),
                shell_command,
            ],
            cols: 80,
            rows: 24,
            agent_provider: AgentProvider::Claude.to_daemon_provider(),
        },
    })
}

fn stage_environment_teardown(
    pipeline: &definitions::PipelineDefinition,
    stage_name: &str,
) -> Vec<String> {
    let environment_name = match definitions::resolve_stage_position(pipeline, stage_name) {
        Some(definitions::StagePosition::Stage(index)) => {
            pipeline.stages[index].environment.as_ref()
        }
        Some(definitions::StagePosition::Post { owner }) => {
            pipeline.stages[owner].environment.as_ref()
        }
        None => None,
    };
    environment_name
        .and_then(|name| pipeline.environments.as_ref()?.get(name))
        .and_then(|environment| environment.teardown.clone())
        .unwrap_or_default()
}

/// Build the daemon spawn for a stage run's agent session. For Claude PTY
/// sessions the returned string is the run's provider session id: a fresh
/// spawn assigns a new UUID (`--session-id`) and a revision resume reopens
/// `claude_resume` (`--resume`). Other providers/session types return `None`
/// — their sessions have no Kanna-known resume handle on this path.
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
    mcp_config_path: Option<String>,
    spawn_env: &HashMap<String, String>,
    worktree_path: &str,
    setup: &[String],
    claude_resume: Option<&str>,
) -> Result<(PreparedSessionSpawn, Option<String>), String> {
    Ok(match agent_type {
        AgentSessionType::Pty => {
            let claude_session = match (provider, claude_resume) {
                (AgentProvider::Claude, Some(session_id)) => Some(
                    commands::ClaudeSessionBinding::Resume(session_id.to_string()),
                ),
                (AgentProvider::Claude, None) => Some(commands::ClaudeSessionBinding::Assign(
                    worktree::generate_agent_session_uuid()?,
                )),
                _ => None,
            };
            let provider_session_id = claude_session.as_ref().map(|binding| match binding {
                commands::ClaudeSessionBinding::Assign(session_id)
                | commands::ClaudeSessionBinding::Resume(session_id) => session_id.clone(),
            });
            let preamble = build_kanna_preamble(
                &provider,
                task_id,
                stage_name,
                pipeline_name,
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
                Some(worktree_path),
                claude_session.as_ref(),
            );
            let full_cmd = build_task_shell_command(
                &agent_cmd,
                setup,
                spawn_env.get("KANNA_CLI_PATH").map(String::as_str),
                spawn_env.get("PATH").map(String::as_str),
            );
            (
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
                },
                provider_session_id,
            )
        }
        AgentSessionType::Agent => {
            let headless_executable = resolve_headless_agent_executable(
                provider,
                spawn_env.get("PATH").map(String::as_str),
                worktree_path,
            )?;
            let system_prompt = build_kanna_preamble(
                &provider,
                task_id,
                stage_name,
                pipeline_name,
                stage_transition,
                mcp_config_path.as_deref(),
            );
            (
                PreparedSessionSpawn::Agent {
                    agent_provider: provider.to_daemon_provider(),
                    prompt: final_prompt,
                    model,
                    permission_mode,
                    allowed_tools,
                    system_prompt,
                    mcp_config_path,
                    executable: headless_executable,
                },
                None,
            )
        }
    })
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
            pipeline_def: None,
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

pub(crate) fn prepare_singleton_agent_task_for_api(
    db: &Db,
    config: &Config,
    repo_id: &str,
    agent_name: &str,
    message: &str,
) -> Result<PreparedTaskSpawn, String> {
    let repo = db
        .get_repo(repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found: {}", repo_id))?;
    let default_provider = read_default_agent_provider_setting(db)?;
    let pipeline_name = format!("singleton-{agent_name}");
    let pipeline = definitions::PipelineDefinition {
        name: Some(pipeline_name.clone()),
        stages: vec![PipelineStage {
            name: "in progress".to_string(),
            agent: Some(agent_name.to_string()),
            prompt: Some("$TASK_PROMPT".to_string()),
            agent_provider: None,
            environment: None,
            policy: PipelineStagePolicy {
                transition: PipelineStageTransition::Manual,
            },
            post: None,
        }],
        environments: None,
    };
    let pipeline_def =
        serde_json::to_string(&pipeline).map_err(|e| format!("serialize error: {}", e))?;
    let display_name = if agent_name == "merge" {
        Some("Merge Master".to_string())
    } else {
        Some(format!("{agent_name} agent"))
    };

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt: message.to_string(),
            display_name,
            pipeline_name: Some(pipeline_name),
            pipeline_def: Some(pipeline_def),
            base_ref: None,
            stored_base_ref: None,
            stage_override: None,
            explicit_provider: None,
            default_provider,
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            notify_task_id: None,
            parent_task_id: None,
        },
    )
}

pub(crate) fn prepare_integration_task_for_api(
    db: &Db,
    config: &Config,
    dependent_task_id: &str,
    base_ref: &str,
    branches_to_merge: &[String],
) -> Result<PreparedTaskSpawn, String> {
    let dependent = db
        .get_pipeline_item(dependent_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", dependent_task_id))?;
    let repo = db
        .get_repo(&dependent.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", dependent_task_id))?;
    let dependent_name = dependent
        .display_name
        .clone()
        .or_else(|| dependent.prompt.clone())
        .unwrap_or_else(|| dependent_task_id.to_string());
    let branch_list = branches_to_merge
        .iter()
        .map(|branch| format!("- `{branch}`"))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "Integrate blocker branches for dependent task `{dependent_task_id}`.\n\n\
Start from base branch `{base_ref}`. Merge these blocker branches in order:\n\n\
{branch_list}\n\n\
Resolve any conflicts preserving both sides' intent. Run the repo's relevant checks. \
Commit the reconciled result. Do not push or open a PR. When complete, record stage \
completion with status success so Kanna can run the commit post and close this integration task."
    );
    let pipeline_name = "integration".to_string();
    let pipeline = definitions::PipelineDefinition {
        name: Some(pipeline_name.clone()),
        stages: vec![PipelineStage {
            name: "in progress".to_string(),
            agent: None,
            prompt: Some("$TASK_PROMPT".to_string()),
            agent_provider: None,
            environment: None,
            policy: PipelineStagePolicy {
                transition: PipelineStageTransition::Auto,
            },
            post: Some(definitions::PipelinePost {
                name: "commit".to_string(),
                agent: Some("commit".to_string()),
                prompt: Some(format!(
                    "Commit the reconciled blocker integration for dependent task {dependent_task_id}."
                )),
                agent_provider: None,
            }),
        }],
        environments: None,
    };
    let pipeline_def =
        serde_json::to_string(&pipeline).map_err(|e| format!("serialize error: {}", e))?;

    prepare_task_spawn(
        db,
        config,
        &repo,
        TaskCreationRequest {
            task_prompt: prompt,
            display_name: Some(format!("Integrate: {dependent_name}")),
            pipeline_name: Some(pipeline_name),
            pipeline_def: Some(pipeline_def),
            base_ref: Some(base_ref.to_string()),
            stored_base_ref: Some(base_ref.to_string()),
            stage_override: None,
            explicit_provider: dependent.agent_provider,
            default_provider: None,
            agent_type: dependent.agent_type,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            notify_task_id: None,
            parent_task_id: Some(dependent_task_id.to_string()),
        },
    )
}

pub(crate) fn create_dormant_task_for_api(
    db: &Db,
    request: crate::mobile_api::CreateTaskRequest,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
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

    let repo_config = read_repo_config(&repo.path)?;
    let pipeline_name = request
        .pipeline_name
        .or(repo_config.pipeline.clone())
        .unwrap_or_else(|| "default".to_string());
    let pipeline = read_pipeline_definition(&repo.path, &pipeline_name)?;
    let pipeline_def_json =
        serde_json::to_string(&pipeline).map_err(|e| format!("serialize error: {}", e))?;
    let stage = pipeline
        .stages
        .first()
        .ok_or_else(|| format!("pipeline has no stages: {}", pipeline_name))?;
    let agent = if let Some(agent_name) = stage.agent.as_deref() {
        Some(read_agent_definition(&repo.path, agent_name)?)
    } else {
        None
    };
    let provider = resolve_agent_provider(
        explicit_provider.as_deref(),
        default_provider.as_deref(),
        stage.agent_provider.as_deref(),
        agent.as_ref(),
    )?;
    let agent_type = resolve_agent_type(request.agent_type.as_deref(), provider)?;
    let task_id = generate_task_id()?;
    let branch = format!("task-{}", task_id);
    let stage_name = stage.name.clone();

    db.insert_pipeline_item(NewPipelineItem {
        id: &task_id,
        repo_id: &repo.id,
        prompt: &request.prompt,
        display_name: request.display_name.as_deref(),
        pipeline: &pipeline_name,
        pipeline_def: Some(&pipeline_def_json),
        stage: &stage_name,
        branch: &branch,
        agent_type: agent_type.as_str(),
        agent_provider: provider.as_str(),
        activity: "idle",
        port_offset: None,
        port_env_json: None,
        base_ref: None,
        notify_task_id: request.notify_task_id.as_deref(),
        parent_task_id: parent_task_id.as_deref(),
    })
    .map_err(|e| format!("db error: {}", e))?;

    Ok(crate::mobile_api::CreateTaskResponse {
        task_id,
        repo_id: repo.id,
        title: request.display_name.unwrap_or(request.prompt),
        stage: stage_name,
        agent_type: agent_type.as_str().to_string(),
        worktree_path: None,
    })
}

pub(crate) fn prepare_start_dormant_task_for_api(
    db: &Db,
    config: &Config,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<Option<PreparedTaskSpawn>, DormantStartError> {
    if db
        .get_task_worktree_path(task_id)
        .map_err(|e| format!("db error: {}", e))?
        .is_some()
    {
        return Ok(None);
    }

    let item = db
        .get_pipeline_item(task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", task_id))?;
    if item.closed_at.is_some() {
        return Ok(None);
    }
    let repo = db
        .get_repo(&item.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", task_id))?;
    if !std::path::Path::new(&repo.path).exists() {
        return Ok(None);
    }

    let repo_config = read_repo_config(&repo.path)?;
    let pipeline_name = item
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let pipeline =
        read_task_pipeline_definition(&repo.path, &pipeline_name, item.pipeline_def.as_deref())?;
    let stage_name = item
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", task_id))?;
    let stage = pipeline
        .stages
        .iter()
        .find(|stage| stage.name == stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", stage_name))?;
    let agent = if let Some(agent_name) = stage.agent.as_deref() {
        Some(read_agent_definition(&repo.path, agent_name)?)
    } else {
        None
    };
    let provider = resolve_agent_provider(
        item.agent_provider.as_deref(),
        None,
        stage.agent_provider.as_deref(),
        agent.as_ref(),
    )?;
    let agent_type = resolve_agent_type(item.agent_type.as_deref(), provider)?;
    let branch = item
        .branch
        .clone()
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or_else(|| format!("task-{}", task_id));
    let previous_base_ref = item.base_ref.clone();
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);
    let base_ref = blocker_branches
        .first()
        .cloned()
        .or_else(|| item.base_ref.clone())
        .or_else(|| fetch_start_point(&repo.path, repo.default_branch.as_deref()));

    let final_prompt = build_stage_prompt(
        agent
            .as_ref()
            .map(|agent| agent.prompt.as_str())
            .unwrap_or(""),
        stage.prompt.as_deref(),
        &PromptContext {
            task_prompt: item.prompt.as_deref(),
            prev_result: None,
            branch: base_ref.as_deref(),
            base_ref: base_ref.as_deref(),
            source_worktree: None,
        },
    );

    let model = agent.as_ref().and_then(|agent| agent.model.clone());
    let permission_mode = agent
        .as_ref()
        .and_then(|agent| agent.permission_mode.clone());
    let allowed_tools = agent
        .as_ref()
        .map(|agent| agent.allowed_tools.clone())
        .unwrap_or_default();

    create_worktree(&repo.path, &branch, &worktree_path, base_ref.as_deref())?;

    let rollback_start = |error: DormantStartError| -> DormantStartError {
        let db_result = db
            .delete_dormant_task_start_artifacts(task_id, previous_base_ref.as_deref())
            .map_err(|e| format!("db rollback error: {}", e));
        let worktree_result = remove_prepared_worktree(&worktree_path, &branch);
        if let Err(rollback_error) = db_result.and(worktree_result) {
            return DormantStartError::Other(format!("{error}; rollback failed: {rollback_error}"));
        }
        error
    };

    if blocker_branches.len() > 1 {
        if let Err(error) = merge_branches_into_worktree(&worktree_path, &blocker_branches[1..]) {
            let dormant_error = match error {
                MergeBranchesError::Conflict(conflict) => {
                    DormantStartError::MergeConflict(DormantMergeConflict {
                        base_branch: blocker_branches[0].clone(),
                        remaining_branches: blocker_branches[1..].to_vec(),
                        conflicting_branch: conflict.branch,
                        message: conflict.message,
                    })
                }
                MergeBranchesError::Other(message) => DormantStartError::Other(message),
            };
            return Err(rollback_start(dormant_error));
        }
    }
    if let Err(error) = db
        .upsert_worktree(&format!("wt-{task_id}"), task_id, &worktree_path, &branch)
        .map_err(|e| format!("db error: {}", e))
    {
        return Err(rollback_start(error.into()));
    }
    if let Err(error) = db
        .upsert_terminal_session(
            &format!("agent-{task_id}"),
            &repo.id,
            Some(task_id),
            Some("agent"),
            Some(&worktree_path),
            Some(task_id),
        )
        .map_err(|e| format!("db error: {}", e))
    {
        return Err(rollback_start(error.into()));
    }

    let port_env = match claim_task_ports(db, task_id, repo_config.ports.as_ref()) {
        Ok(port_env) => port_env,
        Err(error) => return Err(rollback_start(error.into())),
    };
    if let Err(error) = persist_task_ports(db, task_id, &port_env) {
        return Err(rollback_start(error.into()));
    }
    if let Err(error) = db
        .update_pipeline_item_base_ref_and_activity(task_id, base_ref.as_deref(), "working")
        .map_err(|e| format!("db error: {}", e))
    {
        return Err(rollback_start(error.into()));
    }

    let worktree_repo_config = match read_repo_config(&worktree_path) {
        Ok(repo_config) => repo_config,
        Err(error) => return Err(rollback_start(error.into())),
    };
    let mut spawn_env = match build_spawn_env(config, task_id, &port_env) {
        Ok(spawn_env) => spawn_env,
        Err(error) => return Err(rollback_start(error.into())),
    };
    apply_workspace_path_env(&mut spawn_env, &worktree_path, &worktree_repo_config);
    let mcp_config_path = match write_kanna_mcp_config(&config.daemon_dir, task_id, &mut spawn_env)
    {
        Ok(path) => path,
        Err(error) => return Err(rollback_start(error.into())),
    };
    let stage_run_model = model.clone();
    let (session, provider_session_id) = match build_prepared_session(
        provider,
        agent_type,
        task_id,
        &stage_name,
        &pipeline_name,
        Some(stage.policy.transition.as_str()),
        final_prompt,
        model,
        permission_mode,
        allowed_tools,
        mcp_config_path,
        &spawn_env,
        &worktree_path,
        worktree_repo_config.setup.as_deref().unwrap_or(&[]),
        None,
    ) {
        Ok(prepared) => prepared,
        Err(error) => return Err(rollback_start(error.into())),
    };
    let title = item
        .display_name
        .clone()
        .or_else(|| item.prompt.clone())
        .unwrap_or_else(|| task_id.to_string());

    Ok(Some(PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: task_id.to_string(),
            repo_id: repo.id.clone(),
            title,
            stage: stage_name,
            agent_type: agent_type.as_str().to_string(),
            worktree_path: worktree_path.clone(),
        },
        branch,
        session_id: task_id.to_string(),
        cwd: worktree_path,
        env: spawn_env,
        stage_agent: stage.agent.clone(),
        agent_provider: provider.as_str().to_string(),
        model: stage_run_model,
        provider_session_id,
        session,
    }))
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

struct ResolvedTaskSpawn {
    original_prompt: String,
    display_name: Option<String>,
    pipeline_name: String,
    pipeline_def_json: String,
    stage_name: String,
    stage_transition: &'static str,
    stage_agent: Option<String>,
    provider: AgentProvider,
    agent_type: AgentSessionType,
    final_prompt: String,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Vec<String>,
    base_ref: Option<String>,
    stored_base_ref: Option<String>,
    notify_task_id: Option<String>,
    parent_task_id: Option<String>,
}

pub(in crate::task_creator) fn prepare_task_spawn(
    db: &Db,
    config: &Config,
    repo: &Repo,
    request: TaskCreationRequest,
) -> Result<PreparedTaskSpawn, String> {
    let repo_config = read_repo_config(&repo.path)?;
    let resolved = resolve_task_spawn(repo, request, &repo_config)?;
    let stage_run_provider = resolved.provider.as_str().to_string();
    let stage_run_model = resolved.model.clone();

    let task_id = generate_task_id()?;
    let branch = format!("task-{}", task_id);
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);

    insert_new_task_record(db, repo, &task_id, &branch, &resolved)?;

    let prepared = (|| {
        let port_env = claim_task_ports(db, &task_id, repo_config.ports.as_ref())?;
        persist_task_ports(db, &task_id, &port_env)?;

        create_new_task_worktree(
            db,
            repo,
            &task_id,
            &branch,
            &worktree_path,
            resolved.base_ref.as_deref(),
        )?;

        prepare_new_task_session(config, &task_id, &worktree_path, &port_env, &resolved)
    })();
    let PreparedNewTaskSession {
        spawn_env,
        session,
        provider_session_id,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(err) => {
            record_task_prepare_failure(db, &task_id, &worktree_path, &resolved, &err)?;
            return Err(format!("task {task_id} failed to prepare: {err}"));
        }
    };
    let title = resolved
        .display_name
        .clone()
        .unwrap_or_else(|| resolved.original_prompt.clone());

    Ok(PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: task_id.clone(),
            repo_id: repo.id.clone(),
            title,
            stage: resolved.stage_name,
            agent_type: resolved.agent_type.as_str().to_string(),
            worktree_path: worktree_path.clone(),
        },
        branch,
        session_id: task_id,
        cwd: worktree_path,
        env: spawn_env,
        stage_agent: resolved.stage_agent,
        agent_provider: stage_run_provider,
        model: stage_run_model,
        provider_session_id,
        session,
    })
}

fn record_task_prepare_failure(
    db: &Db,
    task_id: &str,
    worktree_path: &str,
    resolved: &ResolvedTaskSpawn,
    error: &str,
) -> Result<(), String> {
    let result = format!("failed to prepare task {task_id}: {error}");
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    let run_id = generate_failure_run_id(task_id);
    db.insert_stage_run(NewStageRun {
        id: &run_id,
        task_id,
        stage: &resolved.stage_name,
        kind: "main",
        agent: resolved.stage_agent.as_deref(),
        agent_provider: Some(resolved.provider.as_str()),
        model: resolved.model.as_deref(),
        status: "failed",
        result: Some(&result),
        feedback: Some("task preparation failed"),
        session_id: Some(task_id),
        provider_session_id: None,
        cwd: Some(worktree_path),
        resumed_from_run_id: None,
    })
    .map_err(|e| format!("db error: {}", e))?;
    Ok(())
}

fn generate_failure_run_id(task_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("run-{task_id}-{nanos}")
}

fn resolve_task_spawn(
    repo: &Repo,
    request: TaskCreationRequest,
    repo_config: &RepoConfig,
) -> Result<ResolvedTaskSpawn, String> {
    let original_prompt = request.task_prompt.clone();
    let display_name = request.display_name.clone();
    let pipeline_name = request
        .pipeline_name
        .clone()
        .or(repo_config.pipeline.clone())
        .unwrap_or_else(|| "default".to_string());
    let pipeline = if request.pipeline_def.is_some() {
        read_task_pipeline_definition(&repo.path, &pipeline_name, request.pipeline_def.as_deref())?
    } else {
        read_pipeline_definition(&repo.path, &pipeline_name)?
    };
    let pipeline_def_json =
        serde_json::to_string(&pipeline).map_err(|e| format!("serialize error: {}", e))?;
    let stage = if let Some(stage_name) = request.stage_override.as_deref() {
        pipeline
            .stages
            .iter()
            .find(|stage| stage.name == stage_name)
            .ok_or_else(|| format!("stage not found in pipeline: {}", stage_name))?
            .clone()
    } else {
        pipeline
            .stages
            .first()
            .ok_or_else(|| format!("pipeline has no stages: {}", pipeline_name))?
            .clone()
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
    let stage_name = request
        .stage_override
        .as_deref()
        .unwrap_or(stage.name.as_str())
        .to_string();
    let stored_base_ref = request
        .stored_base_ref
        .clone()
        .or_else(|| request.base_ref.clone());

    Ok(ResolvedTaskSpawn {
        original_prompt,
        display_name,
        pipeline_name,
        pipeline_def_json,
        stage_name,
        stage_transition: stage.policy.transition.as_str(),
        stage_agent: stage.agent,
        provider,
        agent_type,
        final_prompt,
        model,
        permission_mode,
        allowed_tools,
        base_ref: request.base_ref,
        stored_base_ref,
        notify_task_id: request.notify_task_id,
        parent_task_id: request.parent_task_id,
    })
}

fn insert_new_task_record(
    db: &Db,
    repo: &Repo,
    task_id: &str,
    branch: &str,
    resolved: &ResolvedTaskSpawn,
) -> Result<(), String> {
    db.insert_pipeline_item(NewPipelineItem {
        id: task_id,
        repo_id: &repo.id,
        prompt: &resolved.original_prompt,
        display_name: resolved.display_name.as_deref(),
        pipeline: &resolved.pipeline_name,
        pipeline_def: Some(&resolved.pipeline_def_json),
        stage: &resolved.stage_name,
        branch,
        agent_type: resolved.agent_type.as_str(),
        agent_provider: resolved.provider.as_str(),
        activity: "working",
        port_offset: None,
        port_env_json: None,
        base_ref: resolved.stored_base_ref.as_deref(),
        notify_task_id: resolved.notify_task_id.as_deref(),
        parent_task_id: resolved.parent_task_id.as_deref(),
    })
    .map_err(|e| format!("db error: {}", e))
}

fn persist_task_ports(
    db: &Db,
    task_id: &str,
    port_env: &HashMap<String, String>,
) -> Result<(), String> {
    let first_port = port_env
        .values()
        .next()
        .and_then(|value| value.parse::<i64>().ok());
    let port_env_json = if port_env.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&port_env).map_err(|e| format!("serialize error: {}", e))?)
    };
    db.update_pipeline_item_ports(task_id, first_port, port_env_json.as_deref())
        .map_err(|e| format!("db error: {}", e))
}

fn create_new_task_worktree(
    db: &Db,
    repo: &Repo,
    task_id: &str,
    branch: &str,
    worktree_path: &str,
    base_ref: Option<&str>,
) -> Result<(), String> {
    let start_point = base_ref
        .map(str::to_string)
        .or_else(|| fetch_start_point(&repo.path, repo.default_branch.as_deref()));
    create_worktree(&repo.path, branch, worktree_path, start_point.as_deref())?;
    db.upsert_worktree(&format!("wt-{task_id}"), task_id, worktree_path, branch)
        .map_err(|e| format!("db error: {}", e))?;
    db.upsert_terminal_session(
        &format!("agent-{task_id}"),
        &repo.id,
        Some(task_id),
        Some("agent"),
        Some(worktree_path),
        Some(task_id),
    )
    .map_err(|e| format!("db error: {}", e))
}

struct PreparedNewTaskSession {
    spawn_env: HashMap<String, String>,
    session: PreparedSessionSpawn,
    provider_session_id: Option<String>,
}

fn prepare_new_task_session(
    config: &Config,
    task_id: &str,
    worktree_path: &str,
    port_env: &HashMap<String, String>,
    resolved: &ResolvedTaskSpawn,
) -> Result<PreparedNewTaskSession, String> {
    let worktree_repo_config = read_repo_config(worktree_path)?;
    let mut spawn_env = build_spawn_env(config, task_id, port_env)?;
    apply_workspace_path_env(&mut spawn_env, worktree_path, &worktree_repo_config);
    let mcp_config_path = write_kanna_mcp_config(&config.daemon_dir, task_id, &mut spawn_env)?;
    let (session, provider_session_id) = build_prepared_session(
        resolved.provider,
        resolved.agent_type,
        task_id,
        &resolved.stage_name,
        &resolved.pipeline_name,
        Some(resolved.stage_transition),
        resolved.final_prompt.clone(),
        resolved.model.clone(),
        resolved.permission_mode.clone(),
        resolved.allowed_tools.clone(),
        mcp_config_path,
        &spawn_env,
        worktree_path,
        worktree_repo_config.setup.as_deref().unwrap_or(&[]),
        None,
    )?;
    Ok(PreparedNewTaskSession {
        spawn_env,
        session,
        provider_session_id,
    })
}
