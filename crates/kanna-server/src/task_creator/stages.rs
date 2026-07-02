use crate::config::Config;
use crate::db::{Db, TaskStageSource};

use super::continuation::prepare_continue_stage;
use super::definitions::{
    read_pipeline_definition, PipelineStageExecution, PipelineStageTransition,
};
use super::prepare_task_spawn;
use super::prompt::build_target_stage_prompt;
use super::provider::normalize_agent_type;
use super::types::{PreparedStageTransition, PreparedTaskSpawn, TaskCreationRequest};
use super::worktree::resolve_current_source_worktree_branch;

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
    let source_branch =
        resolve_current_source_worktree_branch(&repo.path, source_task.branch.as_deref());
    let display_name = resolve_inherited_task_title(db, &source_task)?;

    let next_stage = pipeline
        .stages
        .get(current_stage_index + 1)
        .ok_or_else(|| format!("task already at final stage: {}", current_stage_name))?;

    let task_prompt = build_target_stage_prompt(
        &repo.path,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        None,
        source_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
    )?;
    let explicit_provider = if next_stage.agent.is_some() {
        None
    } else {
        source_task.agent_provider.clone()
    };

    if next_stage.policy.execution == Some(PipelineStageExecution::Continue) {
        return Ok(PreparedStageTransition::Continue(Box::new(
            prepare_continue_stage(
                source_task_id,
                &current_stage_name,
                &next_stage.name,
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
            parent_task_id: None,
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
    if current_stage.policy.transition != PipelineStageTransition::Auto {
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
        None,
        source_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
    )?;
    let explicit_provider = if next_stage.agent.is_some() {
        None
    } else {
        source_task.agent_provider.clone()
    };

    if next_stage.policy.execution == Some(PipelineStageExecution::Continue) {
        return prepare_continue_stage(
            source_task_id,
            &current_stage_name,
            &next_stage.name,
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
            parent_task_id: None,
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
        None,
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
            parent_task_id: None,
        },
    )
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
        .map(|stage| match stage.policy.transition {
            PipelineStageTransition::Manual => "manual".to_string(),
            PipelineStageTransition::Auto => "auto".to_string(),
        }))
}
