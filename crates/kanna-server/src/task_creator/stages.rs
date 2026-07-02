use crate::config::Config;
use crate::db::Db;

use super::definitions::read_pipeline_definition;
use super::prepare_stage_run_spawn;
use super::prompt::build_target_stage_prompt;
use super::types::{PreparedStageRunSpawn, PreparedStageTransition};
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

    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    prepare_stage_run_spawn(
        db,
        config,
        &repo,
        source_task_id,
        &pipeline_name,
        &current_stage_name,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        task_prompt,
        branch,
        source_task.stage_result.clone(),
        source_task.active_post_action.clone(),
        None,
        source_task.agent_type.as_deref(),
        explicit_provider,
    )
    .map(|spawn| PreparedStageTransition::Run(Box::new(spawn)))
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

    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    prepare_stage_run_spawn(
        db,
        config,
        &repo,
        source_task_id,
        &pipeline_name,
        &current_stage_name,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        task_prompt,
        branch,
        source_task.stage_result.clone(),
        source_task.active_post_action.clone(),
        None,
        source_task.agent_type.as_deref(),
        explicit_provider,
    )
    .map(|spawn| PreparedStageTransition::Run(Box::new(spawn)))
    .map(Some)
}

pub(crate) fn prepare_revision_task_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    target_stage_name: &str,
    revision_prompt: &str,
) -> Result<PreparedStageRunSpawn, String> {
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

    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    prepare_stage_run_spawn(
        db,
        config,
        &repo,
        source_task_id,
        &pipeline_name,
        source_task.stage.as_deref().unwrap_or(""),
        target_stage,
        revision_prompt,
        task_prompt,
        branch,
        source_task.stage_result.clone(),
        source_task.active_post_action.clone(),
        Some(revision_prompt.to_string()),
        source_task.agent_type.as_deref(),
        explicit_provider,
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
        .and_then(|stage| stage.transition.clone()))
}
