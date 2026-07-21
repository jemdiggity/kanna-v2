mod commands;
mod definition_cache;
mod definition_source;
mod definitions;
mod environment;
mod lifecycle;
mod merge;
mod prompt;
mod provider;
mod resume;
mod stages;
mod terminal_marker;
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
pub(crate) use definition_cache::RepoDefinitionsCache;
use definitions::{
    PipelineStage, PipelineStagePolicy, PipelineStageTransition, RepoConfig, RepoDefinitions,
};
use environment::{
    append_executable_parent_to_path, build_spawn_env, build_workspace_search_path,
    claim_task_ports, kanna_server_base_url, resolve_headless_agent_executable,
    resolve_provider_executable, run_workspace_setup_commands, write_kanna_mcp_config,
};
use prompt::{build_stage_prompt, PromptContext};
use provider::{
    normalize_agent_type, resolve_agent_provider, resolve_agent_provider_candidates,
    resolve_agent_type, AgentProvider, AgentSessionType,
};
use std::collections::HashMap;
use std::str::FromStr;
use types::{
    CreatedTask, ForkedWorkspace, PreparedRunWorkspace, PreparedSessionSpawn, PreparedStageRerun,
    RunWorkspaceSpec, TaskCreationRequest,
};
pub(crate) use types::{
    PrepareTaskError, PreparedStageRunSpawn, PreparedStageTransition, PreparedTaskSpawn,
    PreparedWorkspaceTeardown,
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

#[derive(Clone, Debug)]
pub(crate) enum DefinitionLookupError {
    InvalidName(String),
    NotFound(String),
    Other(String),
}

impl std::fmt::Display for DefinitionLookupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(message) | Self::NotFound(message) | Self::Other(message) => {
                formatter.write_str(message)
            }
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoKannaDefinitions {
    revision: Option<String>,
    ref_name: String,
    config: RepoConfig,
    default_pipeline: String,
    pipelines: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionedPipelineDefinition {
    revision: Option<String>,
    definition: definitions::PipelineDefinition,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionedAgentDefinition {
    revision: Option<String>,
    definition: definitions::AgentDefinition,
}

pub(crate) fn load_repo_kanna_definitions(
    cache: &RepoDefinitionsCache,
    repo: &Repo,
) -> Result<RepoKannaDefinitions, DefinitionLookupError> {
    cache.with_definitions(repo, |definitions| {
        let pipelines = definitions
            .pipeline_names()
            .map_err(DefinitionLookupError::Other)?
            .into_iter()
            .filter(|name| validate_definition_component(name, "pipeline name").is_ok())
            .collect();
        let default_pipeline = definitions
            .config()
            .pipeline
            .clone()
            .unwrap_or_else(|| "default".to_string());
        Ok(RepoKannaDefinitions {
            revision: definitions.revision().map(str::to_string),
            ref_name: definitions.ref_name().to_string(),
            config: definitions.config().clone(),
            default_pipeline,
            pipelines,
        })
    })
}

pub(crate) fn load_repo_pipeline_definition(
    cache: &RepoDefinitionsCache,
    repo: &Repo,
    pipeline_name: &str,
) -> Result<RevisionedPipelineDefinition, DefinitionLookupError> {
    validate_definition_component(pipeline_name, "pipeline name")?;
    cache.with_definitions(repo, |definitions| {
        let mut definition = definitions
            .pipeline_optional(pipeline_name)
            .map_err(DefinitionLookupError::Other)?
            .ok_or_else(|| {
                DefinitionLookupError::NotFound(format!(
                    "pipeline definition not found: {pipeline_name}"
                ))
            })?;
        if definition.name.is_none() {
            definition.name = Some(pipeline_name.to_string());
        }
        Ok(RevisionedPipelineDefinition {
            revision: definitions.revision().map(str::to_string),
            definition,
        })
    })
}

pub(crate) fn load_repo_agent_definition(
    cache: &RepoDefinitionsCache,
    repo: &Repo,
    agent_selector: &str,
) -> Result<RevisionedAgentDefinition, DefinitionLookupError> {
    validate_agent_selector(agent_selector)?;
    cache.with_definitions(repo, |definitions| {
        let definition = definitions
            .agent_optional(agent_selector)
            .map_err(DefinitionLookupError::Other)?
            .ok_or_else(|| {
                DefinitionLookupError::NotFound(format!(
                    "agent definition not found: {agent_selector}"
                ))
            })?;
        Ok(RevisionedAgentDefinition {
            revision: definitions.revision().map(str::to_string),
            definition,
        })
    })
}

fn validate_agent_selector(selector: &str) -> Result<(), DefinitionLookupError> {
    let mut parts = selector.split('@');
    let role = parts.next().unwrap_or_default();
    let flavor = parts.next();
    if parts.next().is_some() {
        return Err(DefinitionLookupError::InvalidName(format!(
            "invalid agent selector `{selector}`: expected role or role@flavor"
        )));
    }
    validate_definition_component(role, "agent role")?;
    if let Some(flavor) = flavor {
        validate_definition_component(flavor, "agent flavor")?;
    }
    Ok(())
}

fn validate_definition_component(value: &str, label: &str) -> Result<(), DefinitionLookupError> {
    let invalid = value.is_empty()
        || matches!(value, "." | "..")
        || value
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '\0') || character.is_control());
    if invalid {
        return Err(DefinitionLookupError::InvalidName(format!(
            "invalid {label} `{value}`: expected one nonempty safe path component"
        )));
    }
    Ok(())
}

pub(crate) fn resolve_available_agent_providers(
    repo: &Repo,
) -> Result<Vec<(AgentProvider, String)>, String> {
    let definitions = RepoDefinitions::resolve(repo)?;
    let search_path = build_workspace_search_path(&repo.path, definitions.config());
    Ok(AgentProvider::ALL
        .into_iter()
        .filter_map(|provider| {
            resolve_provider_executable(provider, search_path.as_deref(), &repo.path)
                .ok()
                .map(|executable| (provider, executable))
        })
        .collect())
}

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
    let definitions = RepoDefinitions::resolve(&repo)?;
    let repo_config = definitions.config();
    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let stage_name = source_task
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", task_id))?;
    let pipeline =
        definitions.task_pipeline(&pipeline_name, source_task.pipeline_def.as_deref())?;
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
        Some(agent_name) => Some(definitions.agent(agent_name)?),
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
            vars: repo_config.vars.as_ref(),
        },
    );
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);
    let provider_workspace_root = if std::path::Path::new(&worktree_path).is_dir() {
        worktree_path.as_str()
    } else {
        repo.path.as_str()
    };
    let provider_search_path = build_workspace_search_path(provider_workspace_root, repo_config);
    let provider = resolve_agent_provider(
        None,
        current_stage.agent_provider.as_deref(),
        agent.as_ref(),
        source_task.agent_provider.as_deref(),
        provider_search_path.as_deref(),
        provider_workspace_root,
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
    let port_env = claim_task_ports(db, task_id, repo_config)?;
    let mut spawn_env = build_spawn_env(config, task_id, &port_env, &worktree_path, repo_config)?;
    let mcp_config_path = write_kanna_mcp_config(
        &config.daemon_dir,
        task_id,
        &kanna_server_base_url(config),
        &mut spawn_env,
    )?;
    let stage_setup = current_stage
        .environment
        .as_deref()
        .and_then(|name| pipeline.environments.as_ref()?.get(name))
        .and_then(|environment| environment.setup.clone())
        .unwrap_or_default();
    let defer_headless_setup = agent_type == AgentSessionType::Agent && !stage_setup.is_empty();
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
        Vec::new(),
        None,
        None,
        mcp_config_path,
        &spawn_env,
        &worktree_path,
        &stage_setup,
        defer_headless_setup,
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
        completion_transition: current_stage.policy.transition,
        provider_session_id,
        cwd: worktree_path,
        env: spawn_env,
        deferred_setup: if defer_headless_setup {
            stage_setup
        } else {
            Vec::new()
        },
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
    definitions: &RepoDefinitions,
    task_id: &str,
    pipeline_name: &str,
    pipeline: &definitions::PipelineDefinition,
    target_stage: &PipelineStage,
    item_stage: &str,
    run_kind: &'static str,
    completion_transition: PipelineStageTransition,
    workspace_spec: RunWorkspaceSpec,
    final_prompt: String,
    branch: &str,
    feedback: Option<String>,
    source_agent_type: Option<&str>,
    explicit_provider: Option<String>,
    fallback_provider: Option<&str>,
) -> Result<PreparedStageRunSpawn, String> {
    let agent = match target_stage.agent.as_deref() {
        Some(agent_name) => Some(definitions.agent(agent_name)?),
        None => None,
    };
    let provider_candidates = resolve_agent_provider_candidates(
        explicit_provider.as_deref(),
        target_stage.agent_provider.as_deref(),
        agent.as_ref(),
        fallback_provider,
    )?;
    if provider_candidates.len() == 1 {
        // Session-type compatibility is configuration validation, not an
        // availability probe. Keep this early rejection for a fixed provider
        // while deferring executable selection until setup has completed.
        resolve_agent_type(source_agent_type, provider_candidates[0])?;
    }

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

    let prepared_session = (|| {
        let repo_config = definitions.config();
        let port_env = claim_task_ports(db, task_id, repo_config)?;
        let mut spawn_env =
            build_spawn_env(config, task_id, &port_env, &worktree_path, repo_config)?;
        let mcp_config_path = write_kanna_mcp_config(
            &config.daemon_dir,
            task_id,
            &kanna_server_base_url(config),
            &mut spawn_env,
        )?;
        // A forked workspace is fresh disk: run the repo's worktree setup
        // (the same commands task creation runs) before any stage-specific
        // setup. Current and resumed workspaces are already set up.
        let mut setup = if matches!(workspace, PreparedRunWorkspace::Forked(_)) {
            repo_config.setup.clone().unwrap_or_default()
        } else {
            Vec::new()
        };
        // A post runs in its owning stage's already-initialized workspace.
        // Its fallback session is prepared before input is sent to the live
        // session, so rerunning stage setup here would cause eager side
        // effects even when the fallback is never spawned.
        if run_kind != "post" {
            setup.extend(
                target_stage
                    .environment
                    .as_deref()
                    .and_then(|name| pipeline.environments.as_ref()?.get(name))
                    .and_then(|environment| environment.setup.clone())
                    .unwrap_or_default(),
            );
        }
        run_workspace_setup_commands(&setup, &worktree_path, &spawn_env)?;
        let provider = provider_candidates
            .iter()
            .copied()
            .find(|provider| {
                resolve_provider_executable(
                    *provider,
                    spawn_env.get("PATH").map(String::as_str),
                    &worktree_path,
                )
                .is_ok()
            })
            .ok_or_else(|| {
                format!(
                    "None of the configured agent providers are available: {}.",
                    provider_candidates
                        .iter()
                        .map(|provider| provider.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
        let agent_type = resolve_agent_type(source_agent_type, provider)?;
        let model = agent.as_ref().and_then(|agent| agent.model.clone());
        let permission_mode = agent
            .as_ref()
            .and_then(|agent| agent.permission_mode.clone());
        let allowed_tools = agent
            .as_ref()
            .map(|agent| agent.allowed_tools.clone())
            .unwrap_or_default();
        let stage_run_model = model.clone();
        let (session, provider_session_id) = build_prepared_session(
            provider,
            agent_type,
            task_id,
            &target_stage.name,
            pipeline_name,
            Some(completion_transition.as_str()),
            final_prompt,
            model,
            permission_mode,
            allowed_tools,
            Vec::new(),
            None,
            None,
            mcp_config_path,
            &spawn_env,
            &worktree_path,
            &[],
            false,
            claude_resume.as_deref(),
        )?;
        let session_id = db
            .resolve_task_terminal_session_id(task_id)
            .map_err(|e| format!("db error: {}", e))?
            .unwrap_or_else(|| task_id.to_string());
        Ok::<_, String>((
            spawn_env,
            session,
            provider_session_id,
            session_id,
            provider,
            stage_run_model,
        ))
    })();
    let (spawn_env, session, provider_session_id, session_id, provider, stage_run_model) =
        match prepared_session {
            Ok(prepared) => prepared,
            Err(error) => {
                if let PreparedRunWorkspace::Forked(fork) = &workspace {
                    if let Err(rollback_error) =
                        remove_prepared_worktree(&fork.worktree_path, &fork.branch)
                    {
                        return Err(format!(
                            "{error}; fork preparation rollback failed: {rollback_error}"
                        ));
                    }
                }
                return Err(error);
            }
        };

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
        completion_transition,
        feedback,
        provider_session_id,
        resumed_from_run_id,
        cwd: worktree_path,
        env: spawn_env,
        terminal_prelude: None,
        session,
    })
}

pub(crate) fn prepare_workspace_teardown_for_close(
    db: &Db,
    config: &Config,
    task_id: &str,
) -> Option<PreparedWorkspaceTeardown> {
    match try_prepare_workspace_teardown_for_close(db, config, task_id) {
        Ok(teardown) => teardown,
        Err(error) => {
            log::warn!("failed to prepare workspace teardown for task {task_id}: {error}");
            None
        }
    }
}

fn try_prepare_workspace_teardown_for_close(
    db: &Db,
    config: &Config,
    task_id: &str,
) -> Result<Option<PreparedWorkspaceTeardown>, String> {
    let Some(source_task) = db
        .get_task_stage_source(task_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(None);
    };
    let Some(branch) = source_task.branch.as_deref() else {
        return Ok(None);
    };
    let Some(stage_name) = source_task.stage.as_deref() else {
        return Ok(None);
    };
    let Some(repo) = db
        .get_repo(&source_task.repo_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(None);
    };
    let definitions = RepoDefinitions::resolve(&repo)?;
    let pipeline_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let pipeline =
        definitions.task_pipeline(&pipeline_name, source_task.pipeline_def.as_deref())?;
    Ok(prepare_workspace_teardown_for_transition_close(
        db,
        config,
        &repo,
        &definitions,
        task_id,
        &pipeline,
        stage_name,
        branch,
    ))
}

#[allow(clippy::too_many_arguments)]
pub(in crate::task_creator) fn prepare_workspace_teardown_for_transition_close(
    db: &Db,
    config: &Config,
    repo: &Repo,
    definitions: &RepoDefinitions,
    task_id: &str,
    pipeline: &definitions::PipelineDefinition,
    stage_name: &str,
    branch: &str,
) -> Option<PreparedWorkspaceTeardown> {
    let task_template_teardown = load_task_template_teardown(db, task_id);
    let mut teardown = prepare_workspace_teardown_with_extra(
        db,
        config,
        repo,
        definitions,
        task_id,
        pipeline,
        stage_name,
        branch,
        &task_template_teardown,
    )?;
    append_close_cleanup_to_teardown(&mut teardown, &config.db_path, &repo.path, task_id);
    Some(teardown)
}

pub(in crate::task_creator) fn prepare_workspace_teardown(
    db: &Db,
    config: &Config,
    repo: &Repo,
    definitions: &RepoDefinitions,
    task_id: &str,
    pipeline: &definitions::PipelineDefinition,
    stage_name: &str,
    branch: &str,
) -> Option<PreparedWorkspaceTeardown> {
    prepare_workspace_teardown_with_extra(
        db,
        config,
        repo,
        definitions,
        task_id,
        pipeline,
        stage_name,
        branch,
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_workspace_teardown_with_extra(
    db: &Db,
    config: &Config,
    repo: &Repo,
    definitions: &RepoDefinitions,
    task_id: &str,
    pipeline: &definitions::PipelineDefinition,
    stage_name: &str,
    branch: &str,
    extra_teardown: &[String],
) -> Option<PreparedWorkspaceTeardown> {
    let worktree_path = db
        .get_task_worktree_path(task_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| format!("{}/.kanna-worktrees/{branch}", repo.path));
    if !std::path::Path::new(&worktree_path).is_dir() {
        return None;
    }
    let repo_config = definitions.config();
    let mut teardown = stage_environment_teardown(pipeline, stage_name);
    teardown.extend(extra_teardown.iter().cloned());
    teardown.extend(repo_config.teardown.clone().unwrap_or_default());
    if teardown.is_empty() {
        return None;
    }

    let port_env = claim_task_ports(db, task_id, repo_config).ok()?;
    let spawn_env =
        build_spawn_env(config, task_id, &port_env, &worktree_path, repo_config).ok()?;
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
            agent_provider: AgentProvider::Claude,
        },
    })
}

fn load_task_template_teardown(db: &Db, task_id: &str) -> Vec<String> {
    let stored = match db.get_pipeline_item_agent_spawn_options(task_id) {
        Ok(stored) => stored,
        Err(error) => {
            log::warn!("failed to read task template lifecycle for {task_id}: {error}");
            return Vec::new();
        }
    };
    let Some(stored) = stored else {
        return Vec::new();
    };
    let options: serde_json::Value = match serde_json::from_str(&stored) {
        Ok(options) => options,
        Err(error) => {
            log::warn!("failed to parse task template lifecycle for {task_id}: {error}");
            return Vec::new();
        }
    };
    serde_json::from_value::<crate::mobile_api::TaskTemplateLaunch>(
        options
            .get("taskTemplate")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .map(|template| template.teardown)
    .unwrap_or_default()
}

fn append_close_cleanup_to_teardown(
    teardown: &mut PreparedWorkspaceTeardown,
    db_path: &str,
    repo_path: &str,
    task_id: &str,
) {
    let cleanup = crate::worktree_cleanup::cleanup_closed_task_worktrees_shell_command(
        db_path, repo_path, task_id,
    );
    if let PreparedSessionSpawn::Pty { args, .. } = &mut teardown.session {
        if let Some(command) = args.last_mut() {
            command
                .push_str(" ; printf '\\033[33mCleaning closed task worktrees...\\033[0m\\n' ; ");
            command.push_str(&cleanup);
        }
    }
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
    disallowed_tools: Vec<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    mcp_config_path: Option<String>,
    spawn_env: &HashMap<String, String>,
    worktree_path: &str,
    setup: &[String],
    defer_headless_setup: bool,
    claude_resume: Option<&str>,
) -> Result<(PreparedSessionSpawn, Option<String>), String> {
    Ok(match agent_type {
        AgentSessionType::Pty => {
            // Keep PTY bootstrap visible and in the provider's shell. Setup
            // may create the executable or export state needed by it, so
            // defer PATH lookup until the shell reaches the final command.
            let mut shell_path = spawn_env.get("PATH").cloned();
            let executable = if setup.is_empty() {
                resolve_provider_executable(
                    provider,
                    spawn_env.get("PATH").map(String::as_str),
                    worktree_path,
                )?
            } else {
                // Provider selection can succeed through a cached login-shell
                // PATH or a packaged sidecar even when that directory is not
                // in the process-derived spawn PATH. Keep it as a lower
                // priority fallback: setup-created workspace binaries still
                // lead PATH and win after the command-table refresh.
                if let Ok(resolved) = resolve_provider_executable(
                    provider,
                    spawn_env.get("PATH").map(String::as_str),
                    worktree_path,
                ) {
                    shell_path = append_executable_parent_to_path(shell_path.as_deref(), &resolved);
                }
                provider.executable().to_string()
            };
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
                &executable,
                &final_prompt,
                model.as_deref(),
                permission_mode.as_deref(),
                &allowed_tools,
                &disallowed_tools,
                max_turns,
                max_budget_usd,
                Some(&preamble),
                mcp_config_path.as_deref(),
                Some(worktree_path),
                claude_session.as_ref(),
            );
            let full_cmd = build_task_shell_command(
                &agent_cmd,
                setup,
                spawn_env.get("KANNA_CLI_PATH").map(String::as_str),
                shell_path.as_deref(),
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
                    agent_provider: provider,
                },
                provider_session_id,
            )
        }
        AgentSessionType::Agent => {
            // Headless sessions have no interactive bootstrap shell. Finish
            // setup first so workspace-local executables exist before their
            // absolute path is resolved for the daemon spawn request.
            let headless_executable = if defer_headless_setup {
                None
            } else {
                run_workspace_setup_commands(setup, worktree_path, spawn_env)?;
                resolve_headless_agent_executable(
                    provider,
                    spawn_env.get("PATH").map(String::as_str),
                    worktree_path,
                )?
            };
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
                    agent_provider: provider,
                    prompt: final_prompt,
                    model,
                    permission_mode,
                    allowed_tools,
                    disallowed_tools,
                    max_turns,
                    max_budget_usd,
                    system_prompt,
                    mcp_config_path,
                    executable: headless_executable,
                },
                None,
            )
        }
    })
}

#[cfg(test)]
pub(crate) fn prepare_task_for_api(
    db: &Db,
    config: &Config,
    request: crate::mobile_api::CreateTaskRequest,
) -> Result<PreparedTaskSpawn, String> {
    prepare_task_for_api_with_error(db, config, request, None).map_err(|error| error.to_string())
}

pub(crate) fn prepare_task_for_api_with_error(
    db: &Db,
    config: &Config,
    request: crate::mobile_api::CreateTaskRequest,
    requested_task_id: Option<String>,
) -> Result<PreparedTaskSpawn, PrepareTaskError> {
    let repo = db
        .get_repo(&request.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found: {}", request.repo_id))?;

    let initial_terminal_geometry =
        resolve_initial_terminal_geometry(request.terminal_cols, request.terminal_rows);
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
            )
            .into());
        }
        Some(parent_task_id)
    } else {
        None
    };

    prepare_task_spawn_with_error(
        db,
        config,
        &repo,
        TaskCreationRequest {
            requested_task_id,
            task_prompt: request.prompt.clone(),
            display_name: request.display_name,
            pipeline_name: request.pipeline_name,
            pipeline_def: None,
            base_ref: request.base_ref,
            stored_base_ref: None,
            stage_override: request.stage,
            agent: request.agent,
            explicit_provider,
            default_provider,
            agent_type: request.agent_type,
            initial_terminal_geometry,
            model: request.model,
            permission_mode: request.permission_mode,
            allowed_tools: request.allowed_tools.unwrap_or_default(),
            disallowed_tools: request.disallowed_tools.unwrap_or_default(),
            max_turns: request.max_turns,
            max_budget_usd: request.max_budget_usd,
            setup_cmds: request.setup_cmds.unwrap_or_default(),
            task_template: request.task_template,
            resume_session_id: request.resume_session_id,
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
        description: None,
        stages: vec![PipelineStage {
            name: "in progress".to_string(),
            description: None,
            agent: Some(agent_name.to_string()),
            prompt: Some("$TASK_PROMPT".to_string()),
            agent_provider: None,
            environment: None,
            policy: PipelineStagePolicy {
                transition: PipelineStageTransition::Manual,
                revision_transition: None,
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
            requested_task_id: None,
            task_prompt: message.to_string(),
            display_name,
            pipeline_name: Some(pipeline_name),
            pipeline_def: Some(pipeline_def),
            base_ref: None,
            stored_base_ref: None,
            stage_override: None,
            agent: None,
            explicit_provider: None,
            default_provider,
            agent_type: None,
            initial_terminal_geometry: None,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: Vec::new(),
            task_template: None,
            resume_session_id: None,
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
        description: None,
        stages: vec![PipelineStage {
            name: "in progress".to_string(),
            description: None,
            agent: None,
            prompt: Some("$TASK_PROMPT".to_string()),
            agent_provider: None,
            environment: None,
            policy: PipelineStagePolicy {
                transition: PipelineStageTransition::Auto,
                revision_transition: None,
            },
            post: Some(definitions::PipelinePost {
                name: "commit".to_string(),
                description: None,
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
            requested_task_id: None,
            task_prompt: prompt,
            display_name: Some(format!("Integrate: {dependent_name}")),
            pipeline_name: Some(pipeline_name),
            pipeline_def: Some(pipeline_def),
            base_ref: Some(base_ref.to_string()),
            stored_base_ref: Some(base_ref.to_string()),
            stage_override: None,
            agent: None,
            explicit_provider: dependent.agent_provider,
            default_provider: None,
            agent_type: dependent.agent_type,
            initial_terminal_geometry: None,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: Vec::new(),
            task_template: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: Some(dependent_task_id.to_string()),
        },
    )
}

pub(crate) fn create_dormant_task_for_api_with_error(
    db: &Db,
    request: crate::mobile_api::CreateTaskRequest,
    requested_task_id: Option<String>,
) -> Result<crate::mobile_api::CreateTaskResponse, PrepareTaskError> {
    let repo = db
        .get_repo(&request.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found: {}", request.repo_id))?;
    let definitions = RepoDefinitions::resolve(&repo)?;
    let repo_config = definitions.config();

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
            )
            .into());
        }
        Some(parent_task_id)
    } else {
        None
    };

    let pipeline_name = request
        .pipeline_name
        .or(repo_config.pipeline.clone())
        .unwrap_or_else(|| "default".to_string());
    let pipeline = definitions.pipeline(&pipeline_name)?;
    let pipeline_def_json =
        serde_json::to_string(&pipeline).map_err(|e| format!("serialize error: {}", e))?;
    let stage = if let Some(stage_name) = request.stage.as_deref() {
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
        Some(definitions.agent(agent_name)?)
    } else {
        None
    };
    let provider_search_path = build_workspace_search_path(&repo.path, repo_config);
    let provider = resolve_agent_provider(
        explicit_provider.as_deref(),
        stage.agent_provider.as_deref(),
        agent.as_ref(),
        default_provider.as_deref(),
        provider_search_path.as_deref(),
        &repo.path,
    )?;
    let agent_type = resolve_agent_type(request.agent_type.as_deref(), provider)?;
    let has_requested_task_id = requested_task_id.is_some();
    let task_id = match requested_task_id {
        Some(task_id) => task_id,
        None => generate_task_id()?,
    };
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
        agent_spawn_options_json: None,
        base_ref: None,
        notify_task_id: request.notify_task_id.as_deref(),
        parent_task_id: parent_task_id.as_deref(),
    })
    .map_err(|error| classify_pipeline_item_insert_error(error, has_requested_task_id))?;

    let prompt = request.prompt;
    let title = request.display_name.unwrap_or_else(|| prompt.clone());
    Ok(crate::mobile_api::CreateTaskResponse {
        task_id,
        repo_id: repo.id,
        title,
        prompt,
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
    let definitions = RepoDefinitions::resolve(&repo)?;
    let repo_config = definitions.config();

    let pipeline_name = item
        .pipeline
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let pipeline = definitions.task_pipeline(&pipeline_name, item.pipeline_def.as_deref())?;
    let stage_name = item
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", task_id))?;
    let stage = pipeline
        .stages
        .iter()
        .find(|stage| stage.name == stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", stage_name))?;
    let stage_agent = stage.agent.clone();
    let agent = if let Some(agent_name) = stage_agent.as_deref() {
        Some(definitions.agent(agent_name)?)
    } else {
        None
    };
    let provider_search_path = build_workspace_search_path(&repo.path, repo_config);
    let provider = resolve_agent_provider(
        None,
        stage.agent_provider.as_deref(),
        agent.as_ref(),
        item.agent_provider.as_deref(),
        provider_search_path.as_deref(),
        &repo.path,
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
            vars: repo_config.vars.as_ref(),
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

    let port_env = match claim_task_ports(db, task_id, repo_config) {
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

    let mut spawn_env =
        match build_spawn_env(config, task_id, &port_env, &worktree_path, repo_config) {
            Ok(spawn_env) => spawn_env,
            Err(error) => return Err(rollback_start(error.into())),
        };
    let mcp_config_path = match write_kanna_mcp_config(
        &config.daemon_dir,
        task_id,
        &kanna_server_base_url(config),
        &mut spawn_env,
    ) {
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
        Vec::new(),
        None,
        None,
        mcp_config_path,
        &spawn_env,
        &worktree_path,
        repo_config.setup.as_deref().unwrap_or(&[]),
        false,
        None,
    ) {
        Ok(prepared) => prepared,
        Err(error) => return Err(rollback_start(error.into())),
    };
    let prompt = item.prompt.clone().unwrap_or_default();
    let title = item
        .display_name
        .clone()
        .or_else(|| (!prompt.is_empty()).then(|| prompt.clone()))
        .unwrap_or_else(|| task_id.to_string());

    Ok(Some(PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: task_id.to_string(),
            repo_id: repo.id.clone(),
            title,
            prompt,
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
        completion_transition: stage.policy.transition,
        provider_session_id,
        session,
    }))
}

fn read_default_agent_provider_setting(db: &Db) -> Result<Option<String>, String> {
    let provider = db
        .get_setting("defaultAgentProvider")
        .map_err(|e| format!("db error: {}", e))?;
    let provider = provider
        .as_deref()
        .and_then(|provider| AgentProvider::from_str(provider).ok())
        .unwrap_or(AgentProvider::Claude);
    Ok(Some(provider.as_str().to_string()))
}

// Cap API-selected grids so the daemon headless terminal's 10k-row scrollback
// byte budget stays about 63 MiB; 320x256 remains far above expected mobile/iPad grids.
const MAX_INITIAL_TERMINAL_COLS: u16 = 320;
const MAX_INITIAL_TERMINAL_ROWS: u16 = 256;

fn resolve_initial_terminal_geometry(cols: Option<u16>, rows: Option<u16>) -> Option<(u16, u16)> {
    match (cols, rows) {
        (Some(cols), Some(rows))
            if cols > 0
                && cols <= MAX_INITIAL_TERMINAL_COLS
                && rows > 0
                && rows <= MAX_INITIAL_TERMINAL_ROWS =>
        {
            Some((cols, rows))
        }
        _ => None,
    }
}

struct ResolvedTaskSpawn {
    original_prompt: String,
    display_name: Option<String>,
    pipeline_name: String,
    pipeline_def_json: String,
    stage_name: String,
    stage_transition: PipelineStageTransition,
    stage_agent: Option<String>,
    provider_candidates: Vec<AgentProvider>,
    requested_agent_type: Option<String>,
    initial_terminal_geometry: Option<(u16, u16)>,
    stage_setup: Vec<String>,
    final_prompt: String,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Vec<String>,
    disallowed_tools: Vec<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    setup_cmds: Vec<String>,
    task_template: Option<crate::mobile_api::TaskTemplateLaunch>,
    resume_session_id: Option<String>,
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
    prepare_task_spawn_with_error(db, config, repo, request).map_err(|error| error.to_string())
}

fn prepare_task_spawn_with_error(
    db: &Db,
    config: &Config,
    repo: &Repo,
    request: TaskCreationRequest,
) -> Result<PreparedTaskSpawn, PrepareTaskError> {
    let definitions = RepoDefinitions::resolve(repo)?;
    let repo_config = definitions.config();
    let requested_task_id = request.requested_task_id.clone();
    let has_requested_task_id = requested_task_id.is_some();
    let resolved = resolve_task_spawn(repo, request, &definitions)?;
    let stage_run_model = resolved.model.clone();
    let provisional_provider = *resolved
        .provider_candidates
        .first()
        .ok_or_else(|| "No agent provider configured for this request.".to_string())?;
    // This binding exists only while the workspace and its setup are being
    // prepared. Do not validate the requested session type against the first
    // candidate here: setup may install a later, compatible fallback.
    let provisional_agent_type = resolve_agent_type(None, provisional_provider)?;

    let task_id = match requested_task_id {
        Some(task_id) => task_id,
        None => generate_task_id()?,
    };
    let branch = format!("task-{}", task_id);
    let worktree_path = format!("{}/.kanna-worktrees/{}", repo.path, branch);

    insert_new_task_record(
        db,
        repo,
        &task_id,
        &branch,
        &resolved,
        provisional_provider,
        provisional_agent_type,
        has_requested_task_id,
    )?;

    let prepared = (|| {
        let port_env = claim_task_ports(db, &task_id, repo_config)?;
        persist_task_ports(db, &task_id, &port_env)?;

        create_new_task_worktree(
            db,
            repo,
            &task_id,
            &branch,
            &worktree_path,
            resolved.base_ref.as_deref(),
        )?;

        prepare_new_task_session(
            config,
            &task_id,
            &worktree_path,
            &port_env,
            repo_config,
            &resolved,
        )
    })();
    let PreparedNewTaskSession {
        spawn_env,
        session,
        provider_session_id,
        provider,
        agent_type,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(err) => {
            record_task_prepare_failure(db, &task_id, &worktree_path, &resolved, &err)?;
            return Err(format!("task {task_id} failed to prepare: {err}").into());
        }
    };
    db.update_pipeline_item_agent_binding(&task_id, provider.as_str(), agent_type.as_str())
        .map_err(|error| format!("db error: {error}"))?;
    let title = resolved
        .display_name
        .clone()
        .unwrap_or_else(|| resolved.original_prompt.clone());

    Ok(PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: task_id.clone(),
            repo_id: repo.id.clone(),
            title,
            prompt: resolved.original_prompt,
            stage: resolved.stage_name,
            agent_type: agent_type.as_str().to_string(),
            worktree_path: worktree_path.clone(),
        },
        branch,
        session_id: task_id,
        cwd: worktree_path,
        env: spawn_env,
        stage_agent: resolved.stage_agent,
        agent_provider: provider.as_str().to_string(),
        model: stage_run_model,
        completion_transition: resolved.stage_transition,
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
        agent_provider: resolved
            .provider_candidates
            .first()
            .map(|provider| provider.as_str()),
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
    _repo: &Repo,
    request: TaskCreationRequest,
    definitions: &RepoDefinitions,
) -> Result<ResolvedTaskSpawn, String> {
    let repo_config = definitions.config();
    let original_prompt = request.task_prompt.clone();
    let display_name = request.display_name.clone();
    let pipeline_name = request
        .pipeline_name
        .clone()
        .or(repo_config.pipeline.clone())
        .unwrap_or_else(|| "default".to_string());
    let pipeline = definitions.task_pipeline(&pipeline_name, request.pipeline_def.as_deref())?;
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

    let stage_agent = request.agent.clone().or_else(|| stage.agent.clone());
    let agent = if let Some(agent_name) = stage_agent.as_deref() {
        Some(definitions.agent(agent_name)?)
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
                vars: repo_config.vars.as_ref(),
            },
        )
    };

    let provider_candidates = resolve_agent_provider_candidates(
        request.explicit_provider.as_deref(),
        if request.agent.is_some() {
            None
        } else {
            stage.agent_provider.as_deref()
        },
        agent.as_ref(),
        if request.agent.is_some() {
            None
        } else {
            request.default_provider.as_deref()
        },
    )?;
    if provider_candidates.len() == 1 {
        resolve_agent_type(request.agent_type.as_deref(), provider_candidates[0])?;
    }
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
    let disallowed_tools = request.disallowed_tools;
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
        stage_transition: stage.policy.transition,
        stage_agent,
        provider_candidates,
        requested_agent_type: request.agent_type,
        initial_terminal_geometry: request.initial_terminal_geometry,
        stage_setup: stage
            .environment
            .as_deref()
            .and_then(|name| pipeline.environments.as_ref()?.get(name))
            .and_then(|environment| environment.setup.clone())
            .unwrap_or_default(),
        final_prompt,
        model,
        permission_mode,
        allowed_tools,
        disallowed_tools,
        max_turns: request.max_turns,
        max_budget_usd: request.max_budget_usd,
        setup_cmds: request.setup_cmds,
        task_template: request.task_template,
        resume_session_id: request.resume_session_id,
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
    provider: AgentProvider,
    agent_type: AgentSessionType,
    has_requested_task_id: bool,
) -> Result<(), PrepareTaskError> {
    let agent_spawn_options_json = agent_spawn_options_json(resolved)?;
    let result = db.insert_pipeline_item(NewPipelineItem {
        id: task_id,
        repo_id: &repo.id,
        prompt: &resolved.original_prompt,
        display_name: resolved.display_name.as_deref(),
        pipeline: &resolved.pipeline_name,
        pipeline_def: Some(&resolved.pipeline_def_json),
        stage: &resolved.stage_name,
        branch,
        agent_type: agent_type.as_str(),
        agent_provider: provider.as_str(),
        activity: "working",
        port_offset: None,
        port_env_json: None,
        agent_spawn_options_json: Some(&agent_spawn_options_json),
        base_ref: resolved.stored_base_ref.as_deref(),
        notify_task_id: resolved.notify_task_id.as_deref(),
        parent_task_id: resolved.parent_task_id.as_deref(),
    });
    match result {
        Ok(()) => Ok(()),
        Err(error) => Err(classify_pipeline_item_insert_error(
            error,
            has_requested_task_id,
        )),
    }
}

fn classify_pipeline_item_insert_error(
    error: rusqlite::Error,
    has_requested_task_id: bool,
) -> PrepareTaskError {
    if has_requested_task_id && is_pipeline_item_primary_key_violation(&error) {
        PrepareTaskError::RequestedTaskIdAlreadyExists
    } else {
        PrepareTaskError::Other(format!("db error: {error}"))
    }
}

fn is_pipeline_item_primary_key_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, message)
            if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                && message.as_deref() == Some("UNIQUE constraint failed: pipeline_item.id")
    )
}

fn agent_spawn_options_json(resolved: &ResolvedTaskSpawn) -> Result<String, String> {
    serde_json::to_string(&serde_json::json!({
        "model": resolved.model,
        "permissionMode": resolved.permission_mode,
        "allowedTools": resolved.allowed_tools,
        "disallowedTools": resolved.disallowed_tools,
        "maxTurns": resolved.max_turns,
        "maxBudgetUsd": resolved.max_budget_usd,
        "taskTemplate": resolved.task_template,
    }))
    .map_err(|e| format!("serialize error: {}", e))
}

fn persist_task_ports(
    db: &Db,
    task_id: &str,
    port_env: &HashMap<String, String>,
) -> Result<(), String> {
    let first_port = port_env
        .values()
        .filter_map(|value| value.parse::<i64>().ok())
        .min();
    let port_env_json = if port_env.is_empty() {
        None
    } else {
        let ordered: std::collections::BTreeMap<&String, &String> = port_env.iter().collect();
        Some(serde_json::to_string(&ordered).map_err(|e| format!("serialize error: {}", e))?)
    };
    db.update_pipeline_item_ports(task_id, first_port, port_env_json.as_deref())
        .map_err(|e| format!("db error: {}", e))
}

pub(crate) fn reopen_task_for_api(db: &Db, task_or_branch_id: &str) -> Result<String, String> {
    let task_id = db
        .resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {task_or_branch_id}"))?;
    let item = db
        .get_pipeline_item(&task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {task_id}"))?;
    let repo = db
        .get_repo(&item.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {task_id}"))?;
    let definitions = RepoDefinitions::resolve(&repo)?;

    db.release_task_ports(&task_id)
        .map_err(|e| format!("db error: {}", e))?;
    let port_env = claim_task_ports(db, &task_id, definitions.config())?;
    persist_task_ports(db, &task_id, &port_env)?;
    db.reopen_pipeline_item(&task_id)
        .map_err(|e| format!("db error: {}", e))?;
    Ok(task_id)
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
    provider: AgentProvider,
    agent_type: AgentSessionType,
}

fn prepare_new_task_session(
    config: &Config,
    task_id: &str,
    worktree_path: &str,
    port_env: &HashMap<String, String>,
    repo_config: &RepoConfig,
    resolved: &ResolvedTaskSpawn,
) -> Result<PreparedNewTaskSession, String> {
    let mut spawn_env = build_spawn_env(config, task_id, port_env, worktree_path, repo_config)?;
    let mcp_config_path = write_kanna_mcp_config(
        &config.daemon_dir,
        task_id,
        &kanna_server_base_url(config),
        &mut spawn_env,
    )?;
    let setup = new_task_setup_cmds(repo_config, &resolved.stage_setup, &resolved.setup_cmds);
    let requested_headless = matches!(
        normalize_agent_type(resolved.requested_agent_type.as_deref()),
        Some("agent")
    );
    let resolve_available_provider = || {
        resolved
            .provider_candidates
            .iter()
            .copied()
            .find(|provider| {
                resolve_provider_executable(
                    *provider,
                    spawn_env.get("PATH").map(String::as_str),
                    worktree_path,
                )
                .is_ok()
            })
            .ok_or_else(|| {
                format!(
                    "None of the configured agent providers are available: {}.",
                    resolved
                        .provider_candidates
                        .iter()
                        .map(|provider| provider.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    };
    let (provider, agent_type, session_setup) = if requested_headless {
        // Headless sessions have no terminal for visible bootstrap output.
        // Preserve post-setup provider discovery so setup may install any of
        // the configured fallback candidates before we resolve an absolute
        // executable for SpawnAgent.
        run_workspace_setup_commands(&setup, worktree_path, &spawn_env)?;
        let provider = resolve_available_provider()?;
        let agent_type = resolve_agent_type(resolved.requested_agent_type.as_deref(), provider)?;
        (provider, agent_type, &[][..])
    } else if setup.is_empty() {
        // With no bootstrap to defer, preserve ordered availability fallback
        // and keep launching the already-resolved executable directly.
        let provider = resolve_available_provider()?;
        let agent_type = resolve_agent_type(resolved.requested_agent_type.as_deref(), provider)?;
        (provider, agent_type, &[][..])
    } else {
        // PTY setup belongs in the daemon shell so users see commands and
        // output before the agent starts. Bind configured precedence now;
        // setup may make that provider executable available later on PATH.
        let provider = *resolved
            .provider_candidates
            .first()
            .ok_or_else(|| "No agent provider configured for this request.".to_string())?;
        let agent_type = resolve_agent_type(resolved.requested_agent_type.as_deref(), provider)?;
        (provider, agent_type, setup.as_slice())
    };
    let (mut session, provider_session_id) = build_prepared_session(
        provider,
        agent_type,
        task_id,
        &resolved.stage_name,
        &resolved.pipeline_name,
        Some(resolved.stage_transition.as_str()),
        resolved.final_prompt.clone(),
        resolved.model.clone(),
        resolved.permission_mode.clone(),
        resolved.allowed_tools.clone(),
        resolved.disallowed_tools.clone(),
        resolved.max_turns,
        resolved.max_budget_usd,
        mcp_config_path,
        &spawn_env,
        worktree_path,
        session_setup,
        false,
        resolved.resume_session_id.as_deref(),
    )?;
    if let Some((initial_cols, initial_rows)) = resolved.initial_terminal_geometry {
        if let PreparedSessionSpawn::Pty { cols, rows, .. } = &mut session {
            *cols = initial_cols;
            *rows = initial_rows;
        }
    }
    Ok(PreparedNewTaskSession {
        spawn_env,
        session,
        provider_session_id,
        provider,
        agent_type,
    })
}

fn new_task_setup_cmds(
    repo_config: &RepoConfig,
    stage_setup: &[String],
    request_setup_cmds: &[String],
) -> Vec<String> {
    let mut setup = repo_config.setup.clone().unwrap_or_default();
    setup.extend(stage_setup.iter().cloned());
    setup.extend(request_setup_cmds.iter().cloned());
    setup
}
