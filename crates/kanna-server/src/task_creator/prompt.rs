use super::definitions::{read_agent_definition, PipelineStage, PipelineStageTransition};

pub(super) fn build_target_stage_prompt(
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
    let context = PromptContext {
        task_prompt: Some(task_prompt),
        prev_result,
        branch,
        base_ref,
        source_worktree: source_worktree.as_deref(),
    };
    if let Some(agent_name) = stage.agent.as_deref() {
        let agent = read_agent_definition(repo_path, agent_name)?;
        return Ok(build_stage_prompt(
            &agent.prompt,
            stage.prompt.as_deref(),
            &context,
        ));
    }
    // An agent-less stage (or post) still owns its prompt; only when it
    // declares none does the task's own prompt carry over.
    if stage.prompt.is_some() {
        return Ok(build_stage_prompt("", stage.prompt.as_deref(), &context));
    }

    Ok(task_prompt.to_string())
}

pub(super) struct PromptContext<'a> {
    pub(super) task_prompt: Option<&'a str>,
    pub(super) prev_result: Option<&'a str>,
    pub(super) branch: Option<&'a str>,
    pub(super) base_ref: Option<&'a str>,
    pub(super) source_worktree: Option<&'a str>,
}

/// Composed revision context: what the task originally was plus what the
/// reviewer wants changed. Used as the `$TASK_PROMPT` substitution when a
/// revision spawns a fresh agent (which otherwise never sees the original
/// task prompt), and as the body of the resume message.
pub(super) fn build_revision_task_prompt(original_task_prompt: &str, feedback: &str) -> String {
    let mut parts = vec!["Review feedback requires changes on this task.".to_string()];
    if !original_task_prompt.trim().is_empty() {
        parts.push(format!("Original task:\n{}", original_task_prompt.trim()));
    }
    parts.push(format!("Reviewer feedback:\n{}", feedback.trim()));
    parts.join("\n\n")
}

/// Next user message for a resumed revision session. The session already
/// carries its agent/stage instructions, so only the revision context is
/// sent — restating the original task prompt re-anchors the turn even if the
/// session has compacted it away — plus a completion reminder in case the
/// standing instructions were compacted too. The reminder follows the target
/// stage's transition policy: only `auto` stages advance on a recorded
/// success; `manual` stages park for the user, so recording success there
/// would just contradict the agent's standing instructions.
pub(super) fn build_revision_resume_message(
    original_task_prompt: &str,
    feedback: &str,
    task_id: &str,
    transition: PipelineStageTransition,
) -> String {
    let completion = match transition {
        PipelineStageTransition::Auto => format!(
            "Address the feedback in this worktree, then record stage completion: call MCP `kanna_complete_stage {{\"task_id\": \"{task_id}\", \"status\": \"success\", \"summary\": \"...\"}}`; only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"{task_id}\" --status success --summary \"...\"`. Kanna will then advance this task's pipeline."
        ),
        PipelineStageTransition::Manual => format!(
            "Address the feedback in this worktree, then finish with a clear summary of what you changed — do not record stage completion; this stage advances manually, so the user reviews the revision and advances the task themselves. If you cannot address the feedback, record failure instead of stopping silently: call MCP `kanna_complete_stage {{\"task_id\": \"{task_id}\", \"status\": \"failure\", \"summary\": \"...\"}}`; only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"{task_id}\" --status failure --summary \"...\"`."
        ),
    };
    format!(
        "{}\n\n{completion}",
        build_revision_task_prompt(original_task_prompt, feedback)
    )
}

pub(super) fn build_stage_prompt(
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
