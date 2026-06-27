use super::definitions::{read_agent_definition, PipelinePostAction, PipelineStage};

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

pub(super) fn build_post_action_prompt(
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

pub(super) struct PromptContext<'a> {
    pub(super) task_prompt: Option<&'a str>,
    pub(super) prev_result: Option<&'a str>,
    pub(super) branch: Option<&'a str>,
    pub(super) base_ref: Option<&'a str>,
    pub(super) source_worktree: Option<&'a str>,
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
