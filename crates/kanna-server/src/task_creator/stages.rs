use crate::config::Config;
use crate::db::{Db, StageProviderOverride, StageTrigger, TaskStageSource};

use super::definitions::{
    parse_stored_workflow_definition, post_as_stage, resolve_stage_position, RepoDefinitions,
    StagePosition, WorkflowDefinition, WorkflowStage, WorkflowStageTransition,
};
use super::prepare_stage_run_spawn;
use super::prompt::{
    build_revision_resume_message, build_revision_task_prompt, build_target_stage_prompt,
    build_target_stage_prompt_with_instructions, RevisionRound,
};
use super::resume::{prepare_resume_workspace, same_cwd};
use super::types::{
    PreparedPostDispatch, PreparedRunWorkspace, PreparedStageRunSpawn, PreparedStageTransition,
    RunWorkspaceSpec,
};
use super::worktree::next_fork_branch;
use super::worktree::resolve_current_source_worktree_branch;
use super::SpawnAgentOverrides;
use super::FALLBACK_WORKFLOW_NAME;
use crate::db::Repo;

pub(super) const REREVIEW_VERDICT_COMPLETION_INSTRUCTION: &str = "Your run is not complete until you have called `kanna_complete_stage` or `kanna_request_revision`; a summary without one of these is an unfinished review.";

/// Everything stage routing needs about the task being transitioned.
struct StageTransitionContext<'a> {
    source_task: &'a TaskStageSource,
    source_task_id: &'a str,
    repo: &'a Repo,
    definitions: &'a RepoDefinitions,
    workflow_name: &'a str,
    workflow: &'a WorkflowDefinition,
}

struct LoadedStageTransitionSource {
    source_task: TaskStageSource,
    repo: Repo,
    definitions: RepoDefinitions,
    workflow_name: String,
    workflow: WorkflowDefinition,
    current_stage_name: String,
}

struct LoadedStageIdentity {
    source_task: TaskStageSource,
    repo: Repo,
}

fn load_stage_identity(db: &Db, source_task_id: &str) -> Result<LoadedStageIdentity, String> {
    let source_task = db
        .get_task_stage_source(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
    let repo = db
        .get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", source_task_id))?;
    Ok(LoadedStageIdentity { source_task, repo })
}

/// Load everything a stage preparation needs, with the task's workspace
/// identity first reconciled onto the branch that actually holds its committed
/// work.
///
/// Every fork below cuts from `source_task.branch`, so that field has to be
/// the task's real committed tip before anything else reads it. A revision
/// round whose commit landed on a workspace the field no longer named used to
/// be dropped by the next fork, and the next reviewer re-raised the same
/// finding — see `work_tip` and its regression tests.
fn load_stage_transition_source(
    db: &Db,
    identity: LoadedStageIdentity,
    source_task_id: &str,
) -> Result<LoadedStageTransitionSource, String> {
    let LoadedStageIdentity {
        mut source_task,
        repo,
    } = identity;
    if source_task.closed_at.is_none() {
        super::work_tip::reconcile_task_work_branch(
            db,
            &repo.path,
            source_task_id,
            &mut source_task,
        )?;
    }
    let definitions = RepoDefinitions::resolve(&repo)?;
    let workflow_name = source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| FALLBACK_WORKFLOW_NAME.to_string());
    let current_stage_name = source_task
        .stage
        .clone()
        .ok_or_else(|| format!("task has no stage: {}", source_task_id))?;
    let workflow =
        definitions.task_workflow(&workflow_name, source_task.pipeline_def.as_deref())?;
    Ok(LoadedStageTransitionSource {
        source_task,
        repo,
        definitions,
        workflow_name,
        workflow,
        current_stage_name,
    })
}

/// The caller-declared context of one explicit stage advance.
///
/// `trigger` says who asked for the advance; `provider_override` is the
/// optional provider/model/effort the next stage must spawn with, carrying its
/// own declared source because the agent that recommends a builder tier is
/// often not the operator who accepts it.
#[derive(Debug, Clone)]
pub(crate) struct StageAdvanceIntent {
    pub(crate) trigger: StageTrigger,
    pub(crate) provider_override: Option<StageProviderOverride>,
}

impl Default for StageAdvanceIntent {
    fn default() -> Self {
        Self {
            trigger: StageTrigger::Unspecified,
            provider_override: None,
        }
    }
}

#[cfg(test)]
pub(crate) fn prepare_advance_stage_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
) -> Result<PreparedStageTransition, String> {
    prepare_advance_stage_for_api_with_intent(
        db,
        config,
        source_task_id,
        StageAdvanceIntent::default(),
    )
}

pub(crate) fn prepare_advance_stage_for_api_with_intent(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    intent: StageAdvanceIntent,
) -> Result<PreparedStageTransition, String> {
    let StageAdvanceIntent {
        trigger,
        provider_override,
    } = intent;
    let identity = load_stage_identity(db, source_task_id)?;
    if identity.source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", source_task_id));
    }
    let open_blockers = db
        .count_open_task_blockers(source_task_id)
        .map_err(|e| format!("db error: {}", e))?;
    if open_blockers > 0 {
        return Err(format!("task is blocked: {}", source_task_id));
    }
    let loaded = load_stage_transition_source(db, identity, source_task_id)?;
    let context = StageTransitionContext {
        source_task: &loaded.source_task,
        source_task_id,
        repo: &loaded.repo,
        definitions: &loaded.definitions,
        workflow_name: &loaded.workflow_name,
        workflow: &loaded.workflow,
    };

    let position = resolve_stage_position(&loaded.workflow, &loaded.current_stage_name)
        .ok_or_else(|| format!("stage not found in workflow: {}", loaded.current_stage_name))?;
    match position {
        // Legacy in-flight task parked at a folded post name (e.g. `commit`):
        // the post is the current context, so advancing swaps past its owner.
        StagePosition::Post { owner } => {
            prepare_swap_to_index(db, config, &context, owner + 1, trigger, provider_override)
        }
        StagePosition::Stage(index) => {
            let stage = &loaded.workflow.stages[index];
            if let Some(post) = &stage.post {
                let latest = db
                    .latest_stage_run(source_task_id)
                    .map_err(|e| format!("db error: {}", e))?;
                // Dispatch the post unless it already ran for this stage
                // visit. A repeated advance while it is running is never an
                // override; only the post's verdict may complete the deferred
                // transition. Failed or cancelled posts are re-dispatched.
                let post_pending = match &latest {
                    Some(run) if run.kind == "post" && run.stage == post.name => {
                        if run.status == "running" {
                            return Err(format!(
                                "post is still running for task {source_task_id}: {}",
                                post.name
                            ));
                        }
                        matches!(run.status.as_str(), "failed" | "cancelled")
                    }
                    _ => true,
                };
                if post_pending {
                    // The stage's post owns the transition from here: this
                    // advance only dispatches it, and the swap happens when
                    // the post reports success. An override handed to a
                    // dispatch would be silently dropped at that boundary, so
                    // say so instead of losing it.
                    if let Some(provider_override) = provider_override {
                        return Err(format!(
                            "cannot apply a provider override for the next stage of \
                             {source_task_id}: advancing dispatches this stage's post \
                             ({}), and the transition to {} runs when that post completes. \
                             Requested provider: {}.",
                            post.name,
                            loaded
                                .workflow
                                .stages
                                .get(index + 1)
                                .map(|stage| stage.name.as_str())
                                .unwrap_or("task close"),
                            provider_override.provider,
                        ));
                    }
                    return prepare_post_dispatch(db, config, &context, index, trigger);
                }
            }
            prepare_swap_to_index(db, config, &context, index + 1, trigger, provider_override)
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
#[cfg(test)]
pub(crate) fn prepare_stage_completion_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    finished_run_kind: Option<&str>,
    completion_transition: Option<&str>,
) -> Result<Option<PreparedStageTransition>, String> {
    prepare_stage_completion_for_api_with_trigger(
        db,
        config,
        source_task_id,
        finished_run_kind,
        completion_transition,
        None,
    )
}

pub(crate) fn prepare_stage_completion_for_api_with_trigger(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    finished_run_kind: Option<&str>,
    completion_transition: Option<&str>,
    finished_run_trigger: Option<&str>,
) -> Result<Option<PreparedStageTransition>, String> {
    let identity = load_stage_identity(db, source_task_id)?;
    if identity.source_task.closed_at.is_some() {
        return Ok(None);
    }
    let loaded = load_stage_transition_source(db, identity, source_task_id)?;
    let context = StageTransitionContext {
        source_task: &loaded.source_task,
        source_task_id,
        repo: &loaded.repo,
        definitions: &loaded.definitions,
        workflow_name: &loaded.workflow_name,
        workflow: &loaded.workflow,
    };

    let position = resolve_stage_position(&loaded.workflow, &loaded.current_stage_name)
        .ok_or_else(|| format!("stage not found in workflow: {}", loaded.current_stage_name))?;
    match position {
        // Legacy in-flight task parked at a folded post name: success means
        // the post finished, which always advances past its owner.
        StagePosition::Post { owner } => prepare_swap_to_index(
            db,
            config,
            &context,
            owner + 1,
            stage_trigger_from_stored(finished_run_trigger),
            None,
        )
        .map(Some),
        StagePosition::Stage(index) => {
            let stage = &loaded.workflow.stages[index];
            if finished_run_kind == Some("post") {
                return prepare_swap_to_index(
                    db,
                    config,
                    &context,
                    index + 1,
                    stage_trigger_from_stored(finished_run_trigger),
                    None,
                )
                .map(Some);
            }
            let transition = match completion_transition {
                Some("manual") => WorkflowStageTransition::Manual,
                Some("auto") => WorkflowStageTransition::Auto,
                Some(value) => {
                    return Err(format!("invalid stage run completion transition: {value}"))
                }
                None => stage.policy.transition,
            };
            if transition != WorkflowStageTransition::Auto {
                return Ok(None);
            }
            if stage.post.is_some() {
                return prepare_post_dispatch(db, config, &context, index, StageTrigger::Auto)
                    .map(Some);
            }
            if loaded.workflow.stages.get(index + 1).is_none() {
                // An auto main-run completion never closes the task; only an
                // explicit advance (or a post completion) moves past the
                // final stage.
                return Ok(None);
            }
            prepare_swap_to_index(db, config, &context, index + 1, StageTrigger::Auto, None)
                .map(Some)
        }
    }
}

fn prepare_swap_to_index(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    next_index: usize,
    trigger: StageTrigger,
    provider_override: Option<StageProviderOverride>,
) -> Result<PreparedStageTransition, String> {
    let Some(next_stage) = context.workflow.stages.get(next_index) else {
        // Past the final stage there is no stage to give a provider to, and
        // advancing here closes the task. Refuse rather than accept a value
        // that would decide nothing.
        if let Some(provider_override) = provider_override {
            return Err(format!(
                "cannot apply a provider override for the next stage of {}: this advance                  closes the task, so there is no stage to spawn. Requested provider: {}.",
                context.source_task_id, provider_override.provider,
            ));
        }
        let workspace_teardown = context
            .source_task
            .branch
            .as_deref()
            .zip(context.source_task.stage.as_deref())
            .and_then(|(branch, stage_name)| {
                super::prepare_workspace_teardown_for_transition_close(
                    db,
                    config,
                    context.repo,
                    context.definitions,
                    context.source_task_id,
                    context.workflow,
                    stage_name,
                    branch,
                )
            })
            .map(Box::new);
        return Ok(PreparedStageTransition::Close {
            task_id: context.source_task_id.to_string(),
            workspace_teardown,
        });
    };
    let from_stage = context
        .source_task
        .stage
        .as_deref()
        .ok_or_else(|| format!("task has no stage: {}", context.source_task_id))?;
    let prompt_suffix = if next_stage.agent.as_deref() == Some("review")
        && db
            .latest_stage_run_for_stage(context.source_task_id, &next_stage.name, "main")
            .map_err(|error| format!("db error: {error}"))?
            .is_some()
    {
        Some(REREVIEW_VERDICT_COMPLETION_INSTRUCTION)
    } else {
        None
    };
    let mut run = prepare_stage_run_for_target(
        db,
        config,
        context,
        next_stage,
        &next_stage.name,
        "main",
        None,
        None,
        prompt_suffix,
        trigger,
        provider_override,
    )?;
    run.terminal_prelude = Some(super::terminal_marker::format_stage_transition_marker(
        from_stage,
        &next_stage.name,
    ));
    Ok(PreparedStageTransition::Run(Box::new(run)))
}

fn prepare_post_dispatch(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    owner_index: usize,
    trigger: StageTrigger,
) -> Result<PreparedStageTransition, String> {
    let owner = &context.workflow.stages[owner_index];
    let post_stage =
        post_as_stage(owner).ok_or_else(|| format!("stage has no post: {}", owner.name))?;
    let run_stage = post_stage.name.clone();

    // The fallback spawn resolves the post session and keeps its normal
    // auto-stage prompt. The returned live-session message is recomposed with
    // an explicit completion instruction before the post's task section.
    // `item_stage` stays the owner: a post never moves the task's stage.
    let task_id = context.source_task_id;
    let completion_instruction = format!(
        "When this work is complete, record stage completion: call MCP `kanna_complete_stage {{\"task_id\": \"{task_id}\", \"status\": \"success\", \"summary\": \"...\"}}`; only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"{task_id}\" --status success --summary \"...\"`. Kanna will then advance this task's workflow."
    );
    let (fallback, message) = prepare_stage_run_for_target_returning_prompt(
        db,
        config,
        context,
        &post_stage,
        &owner.name,
        "post",
        post_stage.policy.transition,
        None,
        None,
        SpawnAgentOverrides::default(),
        Some(&completion_instruction),
        None,
        trigger,
        None,
    )?;

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
    target_stage: &WorkflowStage,
    item_stage: &str,
    run_kind: &'static str,
    prompt_override: Option<&str>,
    feedback: Option<String>,
    prompt_suffix: Option<&str>,
    trigger: StageTrigger,
    provider_override: Option<StageProviderOverride>,
) -> Result<PreparedStageRunSpawn, String> {
    // A stage transition otherwise lets the target stage and its agent
    // definition own the provider; an advance-carried override is the one
    // explicit layer above them.
    let agent_overrides = provider_override
        .as_ref()
        .map(SpawnAgentOverrides::from_provider_override)
        .unwrap_or_default();
    prepare_stage_run_for_target_with_provider(
        db,
        config,
        context,
        target_stage,
        item_stage,
        run_kind,
        target_stage.policy.transition,
        prompt_override,
        feedback,
        agent_overrides,
        prompt_suffix,
        trigger,
        provider_override,
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_stage_run_for_target_with_provider(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &WorkflowStage,
    item_stage: &str,
    run_kind: &'static str,
    completion_transition: WorkflowStageTransition,
    prompt_override: Option<&str>,
    feedback: Option<String>,
    agent_overrides: SpawnAgentOverrides,
    prompt_suffix: Option<&str>,
    trigger: StageTrigger,
    provider_override: Option<StageProviderOverride>,
) -> Result<PreparedStageRunSpawn, String> {
    prepare_stage_run_for_target_returning_prompt(
        db,
        config,
        context,
        target_stage,
        item_stage,
        run_kind,
        completion_transition,
        prompt_override,
        feedback,
        agent_overrides,
        None,
        prompt_suffix,
        trigger,
        provider_override,
    )
    .map(|(run, _)| run)
}

#[allow(clippy::too_many_arguments)]
fn prepare_stage_run_for_target_returning_prompt(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &WorkflowStage,
    item_stage: &str,
    run_kind: &'static str,
    completion_transition: WorkflowStageTransition,
    prompt_override: Option<&str>,
    feedback: Option<String>,
    agent_overrides: SpawnAgentOverrides,
    additional_agent_instructions: Option<&str>,
    prompt_suffix: Option<&str>,
    trigger: StageTrigger,
    provider_override: Option<StageProviderOverride>,
) -> Result<(PreparedStageRunSpawn, String), String> {
    let source_task = context.source_task;
    let source_branch =
        resolve_current_source_worktree_branch(&context.repo.path, source_task.branch.as_deref());
    let prev_result = previous_stage_result(db, context.source_task_id, source_task)?;
    let prev_main_result = previous_main_stage_result(db, context.source_task_id)?;
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
    let mut final_prompt = build_target_stage_prompt(
        context.definitions,
        &context.repo.path,
        target_stage,
        task_prompt,
        prev_result.as_deref(),
        prev_main_result.as_deref(),
        prompt_branch.as_deref(),
        source_task.base_ref.as_deref(),
        source_task.branch.as_deref(),
        trigger.as_str(),
    )?;
    if let Some(suffix) = prompt_suffix {
        final_prompt.push_str("\n\n");
        final_prompt.push_str(suffix);
    }
    let returned_prompt = match additional_agent_instructions {
        Some(instructions) => build_target_stage_prompt_with_instructions(
            context.definitions,
            &context.repo.path,
            target_stage,
            task_prompt,
            prev_result.as_deref(),
            prev_main_result.as_deref(),
            prompt_branch.as_deref(),
            source_task.base_ref.as_deref(),
            source_task.branch.as_deref(),
            trigger.as_str(),
            Some(instructions),
        )?,
        None => final_prompt.clone(),
    };
    // Stage transitions let the target stage and agent definition own the
    // provider, model, and effort. Only a real override (for example a
    // revision or recovery pin) is explicit; the task's stored provider
    // remains the final fallback.
    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {}", context.source_task_id))?;

    let mut run = prepare_stage_run_spawn(
        db,
        config,
        context.repo,
        context.definitions,
        context.source_task_id,
        context.workflow_name,
        context.workflow,
        target_stage,
        item_stage,
        run_kind,
        completion_transition,
        workspace_spec,
        final_prompt.clone(),
        branch,
        feedback,
        source_task.agent_type.as_deref(),
        agent_overrides,
        source_task.agent_provider.as_deref(),
        trigger,
        provider_override,
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
            context.definitions,
            context.source_task_id,
            context.workflow,
            departed_stage,
            branch,
        );
    }
    Ok((run, returned_prompt))
}

fn stage_trigger_from_stored(trigger: Option<&str>) -> StageTrigger {
    match trigger {
        Some("auto") => StageTrigger::Auto,
        Some("operator") => StageTrigger::Operator,
        Some("manager") => StageTrigger::Manager,
        _ => StageTrigger::Unspecified,
    }
}

pub(crate) fn previous_stage_result(
    db: &Db,
    source_task_id: &str,
    _source_task: &TaskStageSource,
) -> Result<Option<String>, String> {
    db.latest_finished_stage_run_result(source_task_id)
        .map_err(|e| format!("db error: {}", e))
}

/// Result of the previous stage agent's own run, skipping posts. A stage
/// whose predecessor declares a post (e.g. `in progress` → `commit` →
/// `review`) sees the post's result in `$PREV_RESULT`; this is what binds
/// `$PREV_MAIN_RESULT` so such a stage can still read what the stage agent
/// itself reported.
pub(crate) fn previous_main_stage_result(
    db: &Db,
    source_task_id: &str,
) -> Result<Option<String>, String> {
    db.latest_finished_main_stage_run_result(source_task_id)
        .map_err(|e| format!("db error: {}", e))
}

/// The feedback a revision actually runs on.
///
/// A revision whose reviewer-feedback section is empty is worse than no
/// revision: the agent has nothing to act on, the round is spent anyway, and
/// the verdict that triggered it is lost — so a request that carries no
/// feedback falls back to the verdict recorded on the task's terminating run
/// (its `feedback`, then its result `summary`), which is where a review's
/// findings are already durable. A revision with nothing to act on anywhere is
/// refused rather than started; the caller hands its claimed round back.
///
/// The agent-origin path is refused earlier, at the API boundary, so it can be
/// told to resend its findings. This is the backstop for every other caller.
fn resolve_revision_feedback(
    db: &Db,
    source_task_id: &str,
    requested: &str,
) -> Result<String, String> {
    if !requested.trim().is_empty() {
        return Ok(requested.to_string());
    }
    // The terminating run is the task's latest: a revision request closes the
    // review run before preparing the revision.
    let run = db
        .latest_stage_run(source_task_id)
        .map_err(|error| format!("db error: {error}"))?;
    let recorded = run.as_ref().and_then(|run| {
        run.feedback
            .as_deref()
            .filter(|feedback| !feedback.trim().is_empty())
            .map(str::to_string)
            .or_else(|| stage_run_result_summary(run.result.as_deref()))
    });
    match recorded {
        Some(feedback) => {
            log::warn!(
                "revision for task {source_task_id} carried no feedback; \
                 falling back to the terminating run's recorded verdict"
            );
            Ok(feedback)
        }
        None => Err(format!(
            "revision requires reviewer feedback: the request carried none and task \
             {source_task_id}'s terminating run recorded no verdict to fall back on"
        )),
    }
}

/// The `summary` of a stage run's `{status, summary, metadata}` result JSON,
/// when it has one worth reading.
fn stage_run_result_summary(result: Option<&str>) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(result?)
        .ok()?
        .get("summary")?
        .as_str()
        .filter(|summary| !summary.trim().is_empty())
        .map(str::to_string)
}

pub(crate) fn prepare_revision_task_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    target_stage_name: &str,
    revision_prompt: &str,
    round: Option<RevisionRound>,
) -> Result<PreparedStageRunSpawn, String> {
    let identity = load_stage_identity(db, source_task_id)?;
    if identity.source_task.closed_at.is_some() {
        return Err(format!("task is closed: {}", source_task_id));
    }
    // Whatever the request carried, the agent must be started on real
    // feedback — an empty "Reviewer feedback:" section spends a budgeted
    // round on nothing and silently loses the verdict that triggered it.
    let revision_feedback = resolve_revision_feedback(db, source_task_id, revision_prompt)?;
    let revision_prompt = revision_feedback.as_str();
    let loaded = load_stage_transition_source(db, identity, source_task_id)?;
    let context = StageTransitionContext {
        source_task: &loaded.source_task,
        source_task_id,
        repo: &loaded.repo,
        definitions: &loaded.definitions,
        workflow_name: &loaded.workflow_name,
        workflow: &loaded.workflow,
    };

    let position = resolve_stage_position(&loaded.workflow, target_stage_name)
        .ok_or_else(|| format!("stage not found in workflow: {}", target_stage_name))?;
    let (target_stage, item_stage, run_kind): (WorkflowStage, String, &'static str) = match position
    {
        StagePosition::Stage(index) => {
            let stage = loaded.workflow.stages[index].clone();
            let item_stage = stage.name.clone();
            (stage, item_stage, "main")
        }
        // Revision targeting a post name (legacy `commit` targets): rerun
        // the post as a fresh session with feedback; the task's stage is
        // the post's owner.
        StagePosition::Post { owner } => {
            let owner_stage = &loaded.workflow.stages[owner];
            let post_stage = post_as_stage(owner_stage)
                .ok_or_else(|| format!("stage has no post: {}", owner_stage.name))?;
            (post_stage, owner_stage.name.clone(), "post")
        }
    };

    // Prefer resuming the target stage's previous agent session: it already
    // holds the exploration and decision context the feedback refers to.
    // Every failed precondition falls back to today's fresh-fork behavior.
    let resume_fallback_reason = if run_kind == "main" {
        match prepare_revision_resume(db, config, &context, &target_stage, revision_prompt, round)?
        {
            ResumePreparation::Resumed(prepared) => return Ok(*prepared),
            ResumePreparation::Fallback(reason) => Some(reason),
        }
    } else {
        Some("post runs do not have an independently resumable provider session".to_string())
    };

    // Fresh fallback: compose the original task prompt with the reviewer's
    // feedback so the new agent still sees what the task was — a bare
    // prompt_override would clobber $TASK_PROMPT entirely. The run keeps the
    // task's provider: a revision continues the same stage's work, so the
    // agent def's provider priority list must not switch providers on it.
    // The model and effort come from the stage's own last run for the same
    // reason — a revision that quietly downgrades the model is not the same
    // work.
    let composed_prompt = build_revision_task_prompt(
        loaded.source_task.prompt.as_deref().unwrap_or(""),
        revision_prompt,
        round,
    );
    let last_run = db
        .latest_stage_run_for_stage(source_task_id, &target_stage.name, run_kind)
        .map_err(|error| format!("db error: {error}"))?;
    let agent_overrides = SpawnAgentOverrides {
        provider: loaded.source_task.agent_provider.clone(),
        model: last_run.as_ref().and_then(|run| run.model.clone()),
        effort: last_run.as_ref().and_then(|run| run.effort.clone()),
    };
    let trigger = last_run
        .as_ref()
        .map(|run| stage_trigger_from_stored(Some(&run.trigger)))
        .unwrap_or(StageTrigger::Unspecified);
    let mut prepared = prepare_stage_run_for_target_with_provider(
        db,
        config,
        &context,
        &target_stage,
        &item_stage,
        run_kind,
        target_stage.policy.revision_transition(),
        Some(&composed_prompt),
        Some(revision_prompt.to_string()),
        agent_overrides,
        None,
        trigger,
        // A fresh revision fork re-resolves its provider from the task's stamp
        // rather than reproducing the previous run's, so carrying that run's
        // override record forward could attribute a provider nobody chose.
        // Silence beats a misattribution; the run row still carries the model.
        None,
    )?;
    prepared.resume_fallback_reason = resume_fallback_reason;
    Ok(prepared)
}

/// Why a stage is being restarted in place, and whether the previous run's
/// provider transcript may be used at all.
enum StageRestartIntent {
    /// Operator or API recovery of an interrupted run: prefer the previous
    /// provider session, fall back to a fresh conversation when any resume
    /// precondition fails.
    ResumeProviderSession,
    /// The provider CLI accepted the launch and then rejected the transcript
    /// itself. Asking for it again would fail the same way, so the
    /// replacement must not carry `--resume`.
    FreshAfterRejectedResume {
        /// The still-running resume attempt this replaces. Checked against the
        /// task's latest run so a stale classification cannot restart a stage
        /// that has already moved on.
        rejected_run_id: String,
        reason: String,
    },
}

/// Prepare recovery of the latest interrupted run in the task's existing
/// stage and worktree. The provider transcript is preferred; when any shared
/// resume precondition fails, the same preparation produces a fresh session
/// and carries the exact reason into the replacement run record.
pub(crate) fn prepare_resume_task_for_api(
    db: &Db,
    config: &Config,
    task_id: &str,
) -> Result<PreparedStageRunSpawn, String> {
    prepare_stage_restart(
        db,
        config,
        task_id,
        StageRestartIntent::ResumeProviderSession,
    )
}

/// Prepare the one fresh relaunch a rejected Claude resume is allowed: same
/// task, same stage, same worktree, no `--resume`. The replacement is a plain
/// fresh run, so if the provider rejects it too there is nothing left to
/// classify as a resume failure and the retry cannot repeat.
pub(crate) fn prepare_fresh_restart_after_rejected_resume(
    db: &Db,
    config: &Config,
    task_id: &str,
    rejected_run_id: &str,
    reason: &str,
) -> Result<PreparedStageRunSpawn, String> {
    prepare_stage_restart(
        db,
        config,
        task_id,
        StageRestartIntent::FreshAfterRejectedResume {
            rejected_run_id: rejected_run_id.to_string(),
            reason: reason.to_string(),
        },
    )
}

fn prepare_stage_restart(
    db: &Db,
    config: &Config,
    task_id: &str,
    intent: StageRestartIntent,
) -> Result<PreparedStageRunSpawn, String> {
    let identity = load_stage_identity(db, task_id)?;
    if identity.source_task.closed_at.is_some() {
        return Err(format!("task is closed: {task_id}"));
    }
    let loaded = load_stage_transition_source(db, identity, task_id)?;
    let source_task = &loaded.source_task;
    let run = db
        .latest_stage_run(task_id)
        .map_err(|error| format!("db error: {error}"))?
        .ok_or_else(|| format!("task has no stage run to resume: {task_id}"))?;
    match &intent {
        StageRestartIntent::ResumeProviderSession => {
            if !matches!(run.status.as_str(), "cancelled" | "failed") {
                return Err(format!(
                    "latest run is {}, not cancelled or failed: {}",
                    run.status, task_id
                ));
            }
        }
        // The rejected attempt is deliberately still `running` here: the
        // replacement is prepared before anything is written, so a failed
        // preparation leaves the exit to the caller's normal reporting.
        StageRestartIntent::FreshAfterRejectedResume {
            rejected_run_id, ..
        } => {
            if &run.id != rejected_run_id {
                return Err(format!(
                    "rejected resume attempt {rejected_run_id} is no longer the latest run: {task_id}"
                ));
            }
        }
    }
    let item_stage = source_task
        .stage
        .as_deref()
        .ok_or_else(|| format!("task has no stage: {task_id}"))?;
    let current_position = resolve_stage_position(&loaded.workflow, item_stage)
        .ok_or_else(|| format!("stage not found in workflow: {item_stage}"))?;
    let current_owner = match current_position {
        StagePosition::Stage(index) => index,
        StagePosition::Post { owner } => owner,
    };
    let (target_stage, run_kind, run_owner): (WorkflowStage, &'static str, usize) =
        match resolve_stage_position(&loaded.workflow, &run.stage)
            .ok_or_else(|| format!("stage not found in workflow: {}", run.stage))?
        {
            StagePosition::Stage(index) => (loaded.workflow.stages[index].clone(), "main", index),
            StagePosition::Post { owner } => (
                post_as_stage(&loaded.workflow.stages[owner])
                    .ok_or_else(|| format!("stage has no post: {}", run.stage))?,
                "post",
                owner,
            ),
        };
    if run.kind != run_kind || run_owner != current_owner {
        return Err(format!(
            "latest interrupted run is not the task's current stage: {}",
            run.stage
        ));
    }
    let branch = source_task
        .branch
        .as_deref()
        .ok_or_else(|| format!("task has no branch: {task_id}"))?;
    let current_worktree = format!("{}/.kanna-worktrees/{branch}", loaded.repo.path);
    // Reviewer feedback is only readable from a run that is still running: an
    // interrupted run's `feedback` has already been overwritten with the
    // session-interruption marker, which is bookkeeping, not an instruction.
    let requested_changes = match &intent {
        StageRestartIntent::FreshAfterRejectedResume { .. } => run.feedback.clone(),
        StageRestartIntent::ResumeProviderSession => None,
    };
    let resume = match &intent {
        StageRestartIntent::FreshAfterRejectedResume { reason, .. } => Err(reason.clone()),
        StageRestartIntent::ResumeProviderSession => match run.cwd.as_deref() {
            Some(run_cwd)
                if std::path::Path::new(run_cwd).is_dir()
                    && std::path::Path::new(&current_worktree).is_dir()
                    && !same_cwd(run_cwd, &current_worktree) =>
            {
                Err(
                    "previous run was recorded in a different worktree than the current stage"
                        .into(),
                )
            }
            _ => prepare_resume_workspace(
                run.agent_provider.as_deref(),
                source_task.agent_type.as_deref(),
                run.cwd.as_deref(),
                run.provider_session_id.as_deref(),
                &run.id,
                &current_worktree,
            ),
        },
    };
    let (workspace_spec, final_prompt, resume_fallback_reason) = match resume {
        Ok((_provider, workspace)) => (
            RunWorkspaceSpec::Resume(workspace),
            format!(
                "Kanna recovered this task after its previous terminal session ended before a \
                 stage verdict was recorded. Continue the existing task from the preserved \
                 conversation and worktree context. Review the current state, finish the \
                 interrupted work, and follow the stage completion instructions. \
                 Do not restart the task from scratch.\n\nTask reminder:\n{}",
                source_task.prompt.as_deref().unwrap_or("")
            ),
            None,
        ),
        Err(reason) => {
            log::info!("task resume unavailable for {task_id}: {reason}; spawning fresh");
            let prev_result = previous_stage_result(db, task_id, source_task)?;
            let prev_main_result = previous_main_stage_result(db, task_id)?;
            // A fresh conversation knows only what the prompt tells it. When
            // the interrupted run was a revision, its reviewer feedback is
            // part of what the task is, so it is composed back into the task
            // prompt rather than lost with the transcript.
            let task_prompt = match requested_changes.as_deref() {
                Some(feedback) => build_revision_task_prompt(
                    source_task.prompt.as_deref().unwrap_or(""),
                    feedback,
                    None,
                ),
                None => source_task.prompt.as_deref().unwrap_or("").to_string(),
            };
            let prompt = build_target_stage_prompt(
                &loaded.definitions,
                &loaded.repo.path,
                &target_stage,
                &task_prompt,
                prev_result.as_deref(),
                prev_main_result.as_deref(),
                Some(branch),
                source_task.base_ref.as_deref(),
                source_task.branch.as_deref(),
                &run.trigger,
            )?;
            (RunWorkspaceSpec::Current, prompt, Some(reason))
        }
    };
    let mut prepared = prepare_stage_run_spawn(
        db,
        config,
        &loaded.repo,
        &loaded.definitions,
        task_id,
        &loaded.workflow_name,
        &loaded.workflow,
        &target_stage,
        item_stage,
        run_kind,
        target_stage.policy.transition,
        workspace_spec,
        final_prompt,
        branch,
        // A restarted revision keeps the requested changes on its record, so
        // the run history does not read as an unexplained re-run of the stage.
        requested_changes.clone(),
        source_task.agent_type.as_deref(),
        // Recovery continues the interrupted run: it must respawn with what
        // that run was actually using, not with what the stage would resolve
        // to today.
        SpawnAgentOverrides::from_stage_run(&run),
        source_task.agent_provider.as_deref(),
        stage_trigger_from_stored(Some(&run.trigger)),
        // Reproducing a run reproduces where its provider came from, so the
        // record keeps naming whoever picked this stage's model.
        run.provider_override.clone(),
    )?;
    prepared.resume_fallback_reason = resume_fallback_reason;
    Ok(prepared)
}

enum ResumePreparation {
    Resumed(Box<PreparedStageRunSpawn>),
    Fallback(String),
}

/// Try to prepare a revision as a resumed run of the target stage's previous
/// provider session. Every unavailable precondition becomes a durable
/// fresh-spawn reason on the replacement run.
fn prepare_revision_resume(
    db: &Db,
    config: &Config,
    context: &StageTransitionContext<'_>,
    target_stage: &WorkflowStage,
    revision_prompt: &str,
    round: Option<RevisionRound>,
) -> Result<ResumePreparation, String> {
    let task_id = context.source_task_id;
    let fall_back = |reason: &str| {
        log::info!("revision resume unavailable for task {task_id}: {reason}; forking fresh");
        Ok(ResumePreparation::Fallback(reason.to_string()))
    };

    let run = match db
        .latest_resumable_stage_run(task_id, &target_stage.name)
        .map_err(|e| format!("db error: {}", e))?
    {
        Some(run) => run,
        None => return fall_back("no stage run recorded a provider session"),
    };
    let source_task = context.source_task;
    let Some(current_branch_name) = source_task.branch.as_deref() else {
        return fall_back("task has no branch");
    };
    let current_worktree = format!(
        "{}/.kanna-worktrees/{}",
        context.repo.path, current_branch_name
    );
    let (provider, resume_workspace) = match prepare_resume_workspace(
        run.agent_provider.as_deref(),
        source_task.agent_type.as_deref(),
        run.cwd.as_deref(),
        run.provider_session_id.as_deref(),
        &run.id,
        &current_worktree,
    ) {
        Ok(resume) => resume,
        Err(reason) => return fall_back(&reason),
    };
    let provider_session_id = resume_workspace.provider_session_id.clone();

    let message = build_revision_resume_message(
        source_task.prompt.as_deref().unwrap_or(""),
        revision_prompt,
        task_id,
        target_stage.policy.revision_transition(),
        round,
    );
    // A resumed run continues the recorded run's conversation, so it must
    // resolve to that run's provider — never the agent def's priority list —
    // and keep the model and effort that conversation was held with.
    let agent_overrides = SpawnAgentOverrides {
        provider: Some(provider.as_str().to_string()),
        ..SpawnAgentOverrides::from_stage_run(&run)
    };
    let prepared = prepare_stage_run_spawn(
        db,
        config,
        context.repo,
        context.definitions,
        task_id,
        context.workflow_name,
        context.workflow,
        target_stage,
        &target_stage.name,
        "main",
        target_stage.policy.revision_transition(),
        RunWorkspaceSpec::Resume(resume_workspace),
        message,
        current_branch_name,
        Some(revision_prompt.to_string()),
        source_task.agent_type.as_deref(),
        agent_overrides,
        source_task.agent_provider.as_deref(),
        stage_trigger_from_stored(Some(&run.trigger)),
        run.provider_override.clone(),
    )?;
    // A definition that changed provider or session type since the source run
    // cannot continue that conversation.
    if prepared.agent_provider != provider.as_str()
        || prepared.provider_session_id.as_deref() != Some(provider_session_id.as_str())
    {
        return fall_back("stage no longer resolves to the recorded resumable provider session");
    }
    log::info!(
        "revision resumes task {task_id} stage '{}' from run {} in {}",
        target_stage.name,
        run.id,
        prepared.cwd
    );
    Ok(ResumePreparation::Resumed(Box::new(prepared)))
}

/// How many agent-requested revision rounds a task has spent, and how many
/// its workflow allows. A `limit` of `0` means the workflow opted out of the
/// cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RevisionBudget {
    pub(crate) rounds: i64,
    pub(crate) limit: i64,
}

/// Effective revision-round cap for a task's pinned workflow.
pub(crate) fn resolve_revision_limit(
    repo: &Repo,
    workflow_name: &str,
    workflow_def: Option<&str>,
) -> Result<i64, String> {
    let workflow = match workflow_def.filter(|value| !value.trim().is_empty()) {
        Some(stored) => parse_stored_workflow_definition(stored)?,
        None => RepoDefinitions::resolve(repo)?.workflow(workflow_name)?,
    };
    Ok(workflow.revision_limit())
}

/// Rounds spent plus the workflow's cap for a task, as the revision endpoint
/// needs them before deciding whether to fork another revision run.
pub(crate) fn resolve_revision_budget(
    db: &Db,
    source_task_id: &str,
) -> Result<RevisionBudget, String> {
    let identity = load_stage_identity(db, source_task_id)?;
    let workflow_name = identity
        .source_task
        .pipeline
        .clone()
        .unwrap_or_else(|| FALLBACK_WORKFLOW_NAME.to_string());
    let limit = resolve_revision_limit(
        &identity.repo,
        &workflow_name,
        identity.source_task.pipeline_def.as_deref(),
    )?;
    let rounds = db
        .task_revision_rounds(source_task_id)
        .map_err(|e| format!("db error: {}", e))?;
    Ok(RevisionBudget { rounds, limit })
}

/// The built-in post whose whole job is handing the finished PR to the repo's
/// merge master. A workflow that declares it on a stage is promising the
/// handoff, which is what lets the engine notice when the post finished
/// without delivering one.
const MERGE_APPROVE_POST: &str = "approve";

/// True when the task's pinned stage declares the merge-signaling `approve`
/// post. Pre-change snapshots and custom workflows without that post promise
/// no merge side effect, so nothing may be enforced on their behalf.
pub(crate) fn stage_declares_merge_approve_post(
    repo: &Repo,
    workflow_name: &str,
    workflow_def: Option<&str>,
    stage_name: &str,
) -> Result<bool, String> {
    let workflow = match workflow_def.filter(|value| !value.trim().is_empty()) {
        Some(stored) => parse_stored_workflow_definition(stored)?,
        None => RepoDefinitions::resolve(repo)?.workflow(workflow_name)?,
    };
    let owner = match resolve_stage_position(&workflow, stage_name) {
        Some(StagePosition::Stage(index)) => index,
        Some(StagePosition::Post { owner }) => owner,
        None => return Ok(false),
    };
    Ok(workflow.stages[owner].post.as_ref().is_some_and(|post| {
        post.name == MERGE_APPROVE_POST || post.agent.as_deref() == Some(MERGE_APPROVE_POST)
    }))
}

pub(crate) fn resolve_stage_transition(
    repo: &Repo,
    workflow_name: &str,
    workflow_def: Option<&str>,
    stage_name: &str,
) -> Result<Option<String>, String> {
    let workflow = match workflow_def.filter(|value| !value.trim().is_empty()) {
        Some(stored) => parse_stored_workflow_definition(stored)?,
        None => RepoDefinitions::resolve(repo)?.workflow(workflow_name)?,
    };
    Ok(match resolve_stage_position(&workflow, stage_name) {
        Some(StagePosition::Stage(index)) => Some(
            workflow.stages[index]
                .policy
                .transition
                .as_str()
                .to_string(),
        ),
        // A post always advances on success.
        Some(StagePosition::Post { .. }) => {
            Some(WorkflowStageTransition::Auto.as_str().to_string())
        }
        None => None,
    })
}
