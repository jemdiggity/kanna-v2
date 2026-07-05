use crate::config::Config;
use crate::db::{Db, TaskStageSource};

use super::definitions::{
    post_as_stage, read_pipeline_definition, read_task_pipeline_definition, resolve_stage_position,
    PipelineDefinition, PipelineStage, PipelineStageTransition, StagePosition,
};
use super::prepare_stage_run_spawn;
use super::prompt::{
    build_revision_resume_message, build_revision_task_prompt, build_target_stage_prompt,
};
use super::resume::{claude_transcript_exists, current_branch, rev_parse_head};
use super::types::{
    PreparedPostDispatch, PreparedRunWorkspace, PreparedStageRunSpawn, PreparedStageTransition,
    ResumeWorkspaceSpec, RunWorkspaceSpec,
};
use super::worktree::next_fork_branch;
use super::worktree::resolve_current_source_worktree_branch;
use crate::db::Repo;

/// Everything stage routing needs about the task being transitioned.
struct StageTransitionContext<'a> {
    source_task: &'a TaskStageSource,
    source_task_id: &'a str,
    repo: &'a Repo,
    pipeline_name: &'a str,
    pipeline: &'a PipelineDefinition,
}

fn load_stage_transition_source(
    db: &Db,
    source_task_id: &str,
) -> Result<(TaskStageSource, Repo, String, PipelineDefinition, String), String> {
    let source_task = db
        .get_task_stage_source(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
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
    Ok((
        source_task,
        repo,
        pipeline_name,
        pipeline,
        current_stage_name,
    ))
}

pub(crate) fn prepare_advance_stage_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
) -> Result<PreparedStageTransition, String> {
    let (source_task, repo, pipeline_name, pipeline, current_stage_name) =
        load_stage_transition_source(db, source_task_id)?;
    if source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", source_task_id));
    }
    let open_blockers = db
        .count_open_task_blockers(source_task_id)
        .map_err(|e| format!("db error: {}", e))?;
    if open_blockers > 0 {
        return Err(format!("task is blocked: {}", source_task_id));
    }
    let context = StageTransitionContext {
        source_task: &source_task,
        source_task_id,
        repo: &repo,
        pipeline_name: &pipeline_name,
        pipeline: &pipeline,
    };

    let position = resolve_stage_position(&pipeline, &current_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", current_stage_name))?;
    match position {
        // Legacy in-flight task parked at a folded post name (e.g. `commit`):
        // the post is the current context, so advancing swaps past its owner.
        StagePosition::Post { owner } => prepare_swap_to_index(db, config, &context, owner + 1),
        StagePosition::Stage(index) => {
            let stage = &pipeline.stages[index];
            if let Some(post) = &stage.post {
                let latest = db
                    .latest_stage_run(source_task_id)
                    .map_err(|e| format!("db error: {}", e))?;
                // Dispatch the post unless it already ran for this stage
                // visit: a succeeded post means the transition proceeds, and
                // a still-running post being advanced again is a human
                // override (swap immediately). Failed or cancelled posts are
                // re-dispatched.
                let post_pending = match &latest {
                    Some(run) if run.kind == "post" && run.stage == post.name => {
                        matches!(run.status.as_str(), "failed" | "cancelled")
                    }
                    _ => true,
                };
                if post_pending {
                    return prepare_post_dispatch(db, config, &context, index);
                }
            }
            prepare_swap_to_index(db, config, &context, index + 1)
        }
    }
}

/// Routes a stage-run completion verdict (`complete-stage` with
/// status=success). `finished_run_kind` identifies the run that just
/// finished: a `post` completion performs the deferred swap regardless of
/// the stage's transition policy (the gate was passed when the post was
/// dispatched); a `main` completion follows the stage's policy — `auto`
/// dispatches the stage's post (or swaps when there is none), `manual`
/// parks the task.
pub(crate) fn prepare_stage_completion_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    finished_run_kind: Option<&str>,
) -> Result<Option<PreparedStageTransition>, String> {
    let (source_task, repo, pipeline_name, pipeline, current_stage_name) =
        load_stage_transition_source(db, source_task_id)?;
    if source_task.closed_at.is_some() {
        return Ok(None);
    }
    let context = StageTransitionContext {
        source_task: &source_task,
        source_task_id,
        repo: &repo,
        pipeline_name: &pipeline_name,
        pipeline: &pipeline,
    };

    let position = resolve_stage_position(&pipeline, &current_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", current_stage_name))?;
    match position {
        // Legacy in-flight task parked at a folded post name: success means
        // the post finished, which always advances past its owner.
        StagePosition::Post { owner } => {
            prepare_swap_to_index(db, config, &context, owner + 1).map(Some)
        }
        StagePosition::Stage(index) => {
            let stage = &pipeline.stages[index];
            if finished_run_kind == Some("post") {
                return prepare_swap_to_index(db, config, &context, index + 1).map(Some);
            }
            if stage.policy.transition != PipelineStageTransition::Auto {
                return Ok(None);
            }
            if stage.post.is_some() {
                return prepare_post_dispatch(db, config, &context, index).map(Some);
            }
            if pipeline.stages.get(index + 1).is_none() {
                // An auto main-run completion never closes the task; only an
                // explicit advance (or a post completion) moves past the
                // final stage.
                return Ok(None);
            }
            prepare_swap_to_index(db, config, &context, index + 1).map(Some)
        }
    }
}

fn prepare_swap_to_index(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    next_index: usize,
) -> Result<PreparedStageTransition, String> {
    let Some(next_stage) = context.pipeline.stages.get(next_index) else {
        return Ok(PreparedStageTransition::Close {
            task_id: context.source_task_id.to_string(),
            workspace_teardown: super::prepare_workspace_teardown_for_close(
                db,
                config,
                context.source_task_id,
            )
            .map(Box::new),
        });
    };
    prepare_stage_run_for_target(
        db,
        config,
        context,
        next_stage,
        &next_stage.name,
        "main",
        None,
        None,
    )
    .map(|run| PreparedStageTransition::Run(Box::new(run)))
}

fn prepare_post_dispatch(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    owner_index: usize,
) -> Result<PreparedStageTransition, String> {
    let owner = &context.pipeline.stages[owner_index];
    let post_stage =
        post_as_stage(owner).ok_or_else(|| format!("stage has no post: {}", owner.name))?;
    let run_stage = post_stage.name.clone();

    // The fallback spawn doubles as the source of the composed post prompt
    // (post agent body + post prompt with $VAR substitution) and the resolved
    // session id. `item_stage` stays the owner: a post never moves the
    // task's stage.
    let (fallback, final_prompt) = prepare_stage_run_for_target_returning_prompt(
        db,
        config,
        context,
        &post_stage,
        &owner.name,
        "post",
        None,
        None,
        None,
    )?;
    let message = format!(
        "{final_prompt}\n\nWhen this work is complete, record stage completion: prefer MCP `kanna_complete_stage`; fallback: `kanna-cli stage-complete --task-id \"{}\" --status success --summary \"...\"`. Kanna will then advance this task's pipeline.",
        context.source_task_id
    );

    Ok(PreparedStageTransition::Post(Box::new(
        PreparedPostDispatch {
            task_id: context.source_task_id.to_string(),
            session_id: fallback.session_id.clone(),
            message,
            run_stage,
            fallback,
        },
    )))
}

#[allow(clippy::too_many_arguments)]
fn prepare_stage_run_for_target(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &PipelineStage,
    item_stage: &str,
    run_kind: &'static str,
    prompt_override: Option<&str>,
    feedback: Option<String>,
) -> Result<PreparedStageRunSpawn, String> {
    prepare_stage_run_for_target_with_provider(
        db,
        config,
        context,
        target_stage,
        item_stage,
        run_kind,
        prompt_override,
        feedback,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_stage_run_for_target_with_provider(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &PipelineStage,
    item_stage: &str,
    run_kind: &'static str,
    prompt_override: Option<&str>,
    feedback: Option<String>,
    provider_override: Option<String>,
) -> Result<PreparedStageRunSpawn, String> {
    prepare_stage_run_for_target_returning_prompt(
        db,
        config,
        context,
        target_stage,
        item_stage,
        run_kind,
        prompt_override,
        feedback,
        provider_override,
    )
    .map(|(run, _)| run)
}

#[allow(clippy::too_many_arguments)]
fn prepare_stage_run_for_target_returning_prompt(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &PipelineStage,
    item_stage: &str,
    run_kind: &'static str,
    prompt_override: Option<&str>,
    feedback: Option<String>,
    provider_override: Option<String>,
) -> Result<(PreparedStageRunSpawn, String), String> {
    let source_task = context.source_task;
    let source_branch =
        resolve_current_source_worktree_branch(&context.repo.path, source_task.branch.as_deref());
    let prev_result = previous_stage_result(db, context.source_task_id, source_task)?;
    let task_prompt = prompt_override
        .or(source_task.prompt.as_deref())
        .unwrap_or("");
    // Stage transitions fork a fresh workspace from the task's committed
    // tip, named `task-<taskid>-<n>` — the durable task id plus a workspace
    // counter (N worktrees, N branches, one PR — the PR agent renames the
    // final branch into something meaningful). Posts run inside the stage,
    // so their fallback spawn keeps the stage's workspace.
    let workspace_spec = if run_kind == "main" {
        RunWorkspaceSpec::Fork {
            branch: next_fork_branch(&context.repo.path, context.source_task_id)?,
        }
    } else {
        RunWorkspaceSpec::Current
    };
    let prompt_branch = match &workspace_spec {
        RunWorkspaceSpec::Fork { branch } => Some(branch.clone()),
        _ => source_branch.clone(),
    };
    let final_prompt = build_target_stage_prompt(
        &context.repo.path,
        target_stage,
        task_prompt,
        prev_result.as_deref(),
        prompt_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
    )?;
    // Stage transitions let the target stage's agent definition own the
    // provider; a `provider_override` (revisions) pins it instead — a
    // revision reruns the same stage's work and must keep the provider that
    // work actually ran with, not re-resolve from the def's priority list.
    let explicit_provider = provider_override.or_else(|| {
        if target_stage.agent.is_some() {
            None
        } else {
            source_task.agent_provider.clone()
        }
    });
    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {}", context.source_task_id))?;

    let mut run = prepare_stage_run_spawn(
        db,
        config,
        context.repo,
        context.source_task_id,
        context.pipeline_name,
        context.pipeline,
        target_stage,
        item_stage,
        run_kind,
        workspace_spec,
        final_prompt.clone(),
        branch,
        feedback,
        source_task.agent_type.as_deref(),
        explicit_provider,
    )?;
    if matches!(run.workspace, PreparedRunWorkspace::Forked(_)) {
        let departed_stage = source_task
            .stage
            .as_deref()
            .ok_or_else(|| format!("task has no stage: {}", context.source_task_id))?;
        run.workspace_teardown = super::prepare_workspace_teardown(
            db,
            config,
            context.repo,
            context.source_task_id,
            context.pipeline,
            departed_stage,
            branch,
        );
    }
    Ok((run, final_prompt))
}

pub(crate) fn previous_stage_result(
    db: &Db,
    source_task_id: &str,
    _source_task: &TaskStageSource,
) -> Result<Option<String>, String> {
    db.latest_finished_stage_run_result(source_task_id)
        .map_err(|e| format!("db error: {}", e))
}

pub(crate) fn prepare_revision_task_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    target_stage_name: &str,
    revision_prompt: &str,
) -> Result<PreparedStageRunSpawn, String> {
    let (source_task, repo, pipeline_name, pipeline, _current_stage_name) =
        load_stage_transition_source(db, source_task_id)?;
    if source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", source_task_id));
    }
    let context = StageTransitionContext {
        source_task: &source_task,
        source_task_id,
        repo: &repo,
        pipeline_name: &pipeline_name,
        pipeline: &pipeline,
    };

    let position = resolve_stage_position(&pipeline, target_stage_name)
        .ok_or_else(|| format!("stage not found in pipeline: {}", target_stage_name))?;
    let (target_stage, item_stage, run_kind): (PipelineStage, String, &'static str) = match position
    {
        StagePosition::Stage(index) => {
            let stage = pipeline.stages[index].clone();
            let item_stage = stage.name.clone();
            (stage, item_stage, "main")
        }
        // Revision targeting a post name (legacy `commit` targets): rerun
        // the post as a fresh session with feedback; the task's stage is
        // the post's owner.
        StagePosition::Post { owner } => {
            let owner_stage = &pipeline.stages[owner];
            let post_stage = post_as_stage(owner_stage)
                .ok_or_else(|| format!("stage has no post: {}", owner_stage.name))?;
            (post_stage, owner_stage.name.clone(), "post")
        }
    };

    // Prefer resuming the target stage's previous agent session: it already
    // holds the exploration and decision context the feedback refers to.
    // Every failed precondition falls back to today's fresh-fork behavior.
    if run_kind == "main" {
        if let Some(prepared) =
            prepare_revision_resume(db, config, &context, &target_stage, revision_prompt)?
        {
            return Ok(prepared);
        }
    }

    // Fresh fallback: compose the original task prompt with the reviewer's
    // feedback so the new agent still sees what the task was — a bare
    // prompt_override would clobber $TASK_PROMPT entirely. The run keeps the
    // task's provider: a revision continues the same stage's work, so the
    // agent def's provider priority list must not switch providers on it.
    let composed_prompt =
        build_revision_task_prompt(source_task.prompt.as_deref().unwrap_or(""), revision_prompt);
    prepare_stage_run_for_target_with_provider(
        db,
        config,
        &context,
        &target_stage,
        &item_stage,
        run_kind,
        Some(&composed_prompt),
        Some(revision_prompt.to_string()),
        source_task.agent_provider.clone(),
    )
}

/// Try to prepare a revision as a resumed run of the target stage's previous
/// agent session, in that run's own worktree. Returns `Ok(None)` — fresh-fork
/// fallback — when any precondition fails: no recorded resumable run, a
/// non-Claude provider, the worktree or CLI transcript gone, or the worktree
/// no longer holding exactly the task's committed tip.
fn prepare_revision_resume(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &PipelineStage,
    revision_prompt: &str,
) -> Result<Option<PreparedStageRunSpawn>, String> {
    let task_id = context.source_task_id;
    let fall_back = |reason: &str| {
        log::info!("revision resume unavailable for task {task_id}: {reason}; forking fresh");
        Ok(None)
    };

    let run = match db
        .latest_resumable_stage_run(task_id, &target_stage.name)
        .map_err(|e| format!("db error: {}", e))?
    {
        Some(run) => run,
        None => return fall_back("no stage run recorded a provider session"),
    };
    if run.agent_provider.as_deref() != Some("claude") {
        return fall_back("previous run's provider does not support resume");
    }
    let (Some(provider_session_id), Some(run_cwd)) =
        (run.provider_session_id.clone(), run.cwd.clone())
    else {
        return fall_back("previous run recorded no session id or cwd");
    };
    let Some(resume_head) = rev_parse_head(&run_cwd) else {
        return fall_back("previous run's worktree is gone");
    };
    let source_task = context.source_task;
    let Some(current_branch_name) = source_task.branch.as_deref() else {
        return fall_back("task has no branch");
    };
    let current_worktree = format!(
        "{}/.kanna-worktrees/{}",
        context.repo.path, current_branch_name
    );
    let Some(current_head) = rev_parse_head(&current_worktree) else {
        return fall_back("task's current worktree is gone");
    };
    if resume_head != current_head {
        return fall_back("previous run's worktree diverged from the committed tip");
    }
    let Some(resume_branch) = current_branch(&run_cwd) else {
        return fall_back("previous run's worktree has no checked-out branch");
    };
    if !claude_transcript_exists(&run_cwd, &provider_session_id) {
        return fall_back("no CLI transcript for the previous session");
    }

    let message = build_revision_resume_message(
        source_task.prompt.as_deref().unwrap_or(""),
        revision_prompt,
        task_id,
    );
    // A resumed run continues the recorded run's conversation, so it must
    // resolve to that run's provider — never the agent def's priority list.
    let explicit_provider = run.agent_provider.clone();
    let resumed_from_run_id = run.id.clone();
    let prepared = prepare_stage_run_spawn(
        db,
        config,
        context.repo,
        task_id,
        context.pipeline_name,
        context.pipeline,
        target_stage,
        &target_stage.name,
        "main",
        RunWorkspaceSpec::Resume(ResumeWorkspaceSpec {
            cwd: run_cwd,
            branch: resume_branch,
            provider_session_id: provider_session_id.clone(),
            resumed_from_run_id,
        }),
        message,
        current_branch_name,
        Some(revision_prompt.to_string()),
        source_task.agent_type.as_deref(),
        explicit_provider,
    )?;
    // The stage's current definition must still resolve to a resumable
    // Claude PTY session; a def that changed provider or session type since
    // the recorded run cannot continue that run's conversation. Nothing was
    // created on disk for the resume, so discarding it is safe.
    if prepared.agent_provider != "claude"
        || prepared.provider_session_id.as_deref() != Some(provider_session_id.as_str())
    {
        return fall_back("stage no longer resolves to a resumable Claude session");
    }
    log::info!(
        "revision resumes task {task_id} stage '{}' from run {} in {}",
        target_stage.name,
        run.id,
        prepared.cwd
    );
    Ok(Some(prepared))
}

pub(crate) fn resolve_stage_transition(
    repo_path: &str,
    pipeline_name: &str,
    stage_name: &str,
) -> Result<Option<String>, String> {
    let pipeline = read_pipeline_definition(repo_path, pipeline_name)?;
    Ok(match resolve_stage_position(&pipeline, stage_name) {
        Some(StagePosition::Stage(index)) => Some(
            pipeline.stages[index]
                .policy
                .transition
                .as_str()
                .to_string(),
        ),
        // A post always advances on success.
        Some(StagePosition::Post { .. }) => {
            Some(PipelineStageTransition::Auto.as_str().to_string())
        }
        None => None,
    })
}
