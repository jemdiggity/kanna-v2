use crate::config::Config;
use crate::db::{Db, TaskStageSource};

use super::definitions::{
    read_pipeline_definition, read_task_pipeline_definition, PipelineStageTransition,
};
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
    let open_blockers = db
        .count_open_task_blockers(source_task_id)
        .map_err(|e| format!("db error: {}", e))?;
    if open_blockers > 0 {
        return Err(format!("task is blocked: {}", source_task_id));
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
    let pipeline = read_task_pipeline_definition(
        &repo.path,
        &pipeline_name,
        source_task.pipeline_def.as_deref(),
    )?;
    let current_stage_index = pipeline
        .stages
        .iter()
        .position(|stage| stage.name == current_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", current_stage_name))?;
    let source_branch =
        resolve_current_source_worktree_branch(&repo.path, source_task.branch.as_deref());
    let prev_result = previous_stage_result(db, source_task_id, &source_task)?;

    let Some(next_stage) = pipeline.stages.get(current_stage_index + 1) else {
        return Ok(PreparedStageTransition::Close {
            task_id: source_task_id.to_string(),
        });
    };

    let task_prompt = build_target_stage_prompt(
        &repo.path,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        prev_result.as_deref(),
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
        &pipeline,
        next_stage,
        task_prompt,
        branch,
        None,
        source_task.agent_type.as_deref(),
        explicit_provider,
    )
    .map(|run| PreparedStageTransition::Run(Box::new(run)))
}

pub(crate) fn previous_stage_result(
    db: &Db,
    source_task_id: &str,
    _source_task: &TaskStageSource,
) -> Result<Option<String>, String> {
    db.latest_finished_stage_run_result(source_task_id)
        .map_err(|e| format!("db error: {}", e))
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
    let pipeline = read_task_pipeline_definition(
        &repo.path,
        &pipeline_name,
        source_task.pipeline_def.as_deref(),
    )?;
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
    let prev_result = previous_stage_result(db, source_task_id, &source_task)?;
    let task_prompt = build_target_stage_prompt(
        &repo.path,
        next_stage,
        source_task.prompt.as_deref().unwrap_or(""),
        prev_result.as_deref(),
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
        &pipeline,
        next_stage,
        task_prompt,
        branch,
        None,
        source_task.agent_type.as_deref(),
        explicit_provider,
    )
    .map(|run| Some(PreparedStageTransition::Run(Box::new(run))))
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
    let pipeline = read_task_pipeline_definition(
        &repo.path,
        &pipeline_name,
        source_task.pipeline_def.as_deref(),
    )?;
    let target_stage = pipeline
        .stages
        .iter()
        .find(|stage| stage.name == target_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", target_stage_name))?;
    let source_branch =
        resolve_current_source_worktree_branch(&repo.path, source_task.branch.as_deref());
    let prev_result = previous_stage_result(db, source_task_id, &source_task)?;

    let task_prompt = build_target_stage_prompt(
        &repo.path,
        target_stage,
        revision_prompt,
        prev_result.as_deref(),
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
        &pipeline,
        target_stage,
        task_prompt,
        branch,
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
        .map(|stage| stage.policy.transition.as_str().to_string()))
}
