use std::collections::HashMap;

use super::definitions::{RepoDefinitions, WorkflowStage, WorkflowStageTransition};

#[allow(clippy::too_many_arguments)]
pub(super) fn build_target_stage_prompt(
    definitions: &RepoDefinitions,
    repo_path: &str,
    stage: &WorkflowStage,
    task_prompt: &str,
    prev_result: Option<&str>,
    prev_main_result: Option<&str>,
    branch: Option<&str>,
    base_ref: Option<&str>,
    source_worktree_branch: Option<&str>,
    stage_trigger: &str,
) -> Result<String, String> {
    build_target_stage_prompt_with_instructions(
        definitions,
        repo_path,
        stage,
        task_prompt,
        prev_result,
        prev_main_result,
        branch,
        base_ref,
        source_worktree_branch,
        stage_trigger,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_target_stage_prompt_with_instructions(
    definitions: &RepoDefinitions,
    repo_path: &str,
    stage: &WorkflowStage,
    task_prompt: &str,
    prev_result: Option<&str>,
    prev_main_result: Option<&str>,
    branch: Option<&str>,
    base_ref: Option<&str>,
    source_worktree_branch: Option<&str>,
    stage_trigger: &str,
    additional_agent_instructions: Option<&str>,
) -> Result<String, String> {
    let source_worktree =
        source_worktree_branch.map(|branch| format!("{repo_path}/.kanna-worktrees/{branch}"));
    let context = PromptContext {
        task_prompt: Some(task_prompt),
        prev_result,
        prev_main_result,
        branch,
        base_ref,
        source_worktree: source_worktree.as_deref(),
        stage_trigger,
        vars: definitions.config().vars.as_ref(),
    };
    if let Some(agent_name) = stage.agent.as_deref() {
        let agent = definitions.agent(agent_name)?;
        let agent_prompt = [
            agent.prompt.as_str(),
            additional_agent_instructions.unwrap_or(""),
        ]
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        return Ok(build_stage_prompt(
            &agent_prompt,
            stage.prompt.as_deref(),
            &context,
        ));
    }
    // An agent-less stage (or post) still owns its prompt; only when it
    // declares none does the task's own prompt carry over.
    if stage.prompt.is_some() {
        return Ok(build_stage_prompt(
            additional_agent_instructions.unwrap_or(""),
            stage.prompt.as_deref(),
            &context,
        ));
    }

    Ok(build_stage_prompt(
        additional_agent_instructions.unwrap_or(""),
        Some("$TASK_PROMPT"),
        &context,
    ))
}

pub(super) struct PromptContext<'a> {
    pub(super) task_prompt: Option<&'a str>,
    pub(super) prev_result: Option<&'a str>,
    /// Result of the previous **main** run, skipping posts. `$PREV_RESULT`
    /// binds the latest run of any kind, which for a stage following one that
    /// declares a post is the post's result; a stage that needs the previous
    /// stage agent's own report reads this instead.
    pub(super) prev_main_result: Option<&'a str>,
    pub(super) branch: Option<&'a str>,
    pub(super) base_ref: Option<&'a str>,
    pub(super) source_worktree: Option<&'a str>,
    /// How this stage was entered: engine policy, declared operator/manager,
    /// or unspecified for a legacy/undeclared caller.
    pub(super) stage_trigger: &'a str,
    /// Repo-declared config vars (`.kanna/config.json` `vars`), substituted
    /// in the same single pass as the runtime bindings below.
    pub(super) vars: Option<&'a HashMap<String, String>>,
}

/// Names bound by the engine (or, for KANNA_TASK_ID, the session
/// environment). They win over repo config vars and can never be shadowed.
const RESERVED_PROMPT_VARS: &[&str] = &[
    "BASE_REF",
    "BRANCH",
    "KANNA_TASK_ID",
    "PREV_MAIN_RESULT",
    "PREV_RESULT",
    "SOURCE_WORKTREE",
    "STAGE_TRIGGER",
    "TASK_PROMPT",
];

/// Resolve one `$NAME` / `${NAME}` token. `None` means "leave the token
/// literal in the output" (unknown names, and KANNA_TASK_ID which the
/// session resolves from its environment at runtime).
fn prompt_var_value<'a>(name: &str, context: &'a PromptContext<'_>) -> Option<&'a str> {
    match name {
        "TASK_PROMPT" => Some(context.task_prompt.unwrap_or("")),
        "PREV_RESULT" => Some(context.prev_result.unwrap_or("")),
        "PREV_MAIN_RESULT" => Some(context.prev_main_result.unwrap_or("")),
        "BRANCH" => Some(context.branch.unwrap_or("")),
        "BASE_REF" => Some(context.base_ref.unwrap_or("")),
        "SOURCE_WORKTREE" => Some(context.source_worktree.unwrap_or("")),
        "STAGE_TRIGGER" => Some(context.stage_trigger),
        _ if RESERVED_PROMPT_VARS.contains(&name) => None,
        _ => context
            .vars
            .and_then(|vars| vars.get(name))
            .map(String::as_str),
    }
}

/// Single left-to-right substitution pass over one prompt template.
/// Spliced values are appended to the output and never rescanned, so a
/// config var value containing a reserved token (e.g. `$TASK_PROMPT`)
/// stays literal instead of being expanded a second time.
fn substitute_prompt_vars(template: &str, context: &PromptContext<'_>) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut out = String::with_capacity(template.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '$' {
            out.push(chars[index]);
            index += 1;
            continue;
        }

        // ${NAME}
        if chars.get(index + 1) == Some(&'{') {
            if let Some(end) = chars[index + 2..].iter().position(|ch| *ch == '}') {
                let name: String = chars[index + 2..index + 2 + end].iter().collect();
                if let Some(value) = prompt_var_value(&name, context) {
                    out.push_str(value);
                    index += end + 3;
                    continue;
                }
            }
            out.push('$');
            index += 1;
            continue;
        }

        // $NAME — longest run of [A-Za-z0-9_]
        let mut end = index + 1;
        while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
            end += 1;
        }
        if end == index + 1 {
            out.push('$');
            index += 1;
            continue;
        }
        let name: String = chars[index + 1..end].iter().collect();
        if let Some(value) = prompt_var_value(&name, context) {
            out.push_str(value);
            index = end;
        } else {
            out.push('$');
            index += 1;
        }
    }

    out
}

fn build_prompt_section(
    heading: &str,
    template: &str,
    context: &PromptContext<'_>,
) -> Option<String> {
    let template = template.trim();
    if template.is_empty() {
        return None;
    }

    let body = substitute_prompt_vars(template, context);
    if body.trim().is_empty() {
        return None;
    }

    Some(format!("{heading}\n\n{body}"))
}

/// Which capped revision round a run is, when the workflow caps them. Told to
/// the revising agent so it knows the loop is bounded and that widening the
/// task is not an option. Human-requested revisions carry no round: they are
/// the human's call, and they hand the budget back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RevisionRound {
    pub(crate) number: i64,
    pub(crate) limit: i64,
}

impl RevisionRound {
    fn instructions(&self) -> String {
        let mut text = format!(
            "Revision round {} of {} for this task. Address exactly what the feedback below asks \
for, inside the original task's scope: do not rebuild, refactor, or re-architect code the \
feedback does not name, and do not add work the original task did not ask for. If a finding is \
out of scope, wrong, or would grow this task into a larger project, say so in your summary \
instead of implementing it.",
            self.number, self.limit
        );
        if self.number >= self.limit {
            text.push_str(
                " This is the final automatic revision round: if review is not satisfied after \
it, Kanna parks the task for its human rather than starting another round.",
            );
        }
        text
    }
}

/// Composed revision context: what the task originally was plus what the
/// reviewer wants changed. Used as the `$TASK_PROMPT` substitution when a
/// revision spawns a fresh agent (which otherwise never sees the original
/// task prompt), and as the body of the resume message.
pub(super) fn build_revision_task_prompt(
    original_task_prompt: &str,
    feedback: &str,
    round: Option<RevisionRound>,
) -> String {
    let mut parts = vec!["Review feedback requires changes on this task.".to_string()];
    if let Some(round) = round {
        parts.push(round.instructions());
    }
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
    transition: WorkflowStageTransition,
    round: Option<RevisionRound>,
) -> String {
    let completion = match transition {
        WorkflowStageTransition::Auto => format!(
            "Address the feedback in this worktree, then record stage completion: call MCP `kanna_complete_stage {{\"task_id\": \"{task_id}\", \"status\": \"success\", \"summary\": \"...\"}}`; only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"{task_id}\" --status success --summary \"...\"`. Kanna will then advance this task's workflow."
        ),
        WorkflowStageTransition::Manual => format!(
            "Address the feedback in this worktree, then finish with a clear summary of what you changed — do not record stage completion; this stage advances manually, so the user reviews the revision and advances the task themselves. If you cannot address the feedback, record failure instead of stopping silently: call MCP `kanna_complete_stage {{\"task_id\": \"{task_id}\", \"status\": \"failure\", \"summary\": \"...\"}}`; only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"{task_id}\" --status failure --summary \"...\"`."
        ),
    };
    format!(
        "{}\n\n{completion}",
        build_revision_task_prompt(original_task_prompt, feedback, round)
    )
}

pub(super) fn build_stage_prompt(
    agent_prompt: &str,
    stage_prompt: Option<&str>,
    context: &PromptContext<'_>,
) -> String {
    let mut sections = Vec::new();
    if let Some(section) = build_prompt_section("## Agent Instructions", agent_prompt, context) {
        sections.push(section);
    }
    if let Some(stage_prompt) = stage_prompt {
        if let Some(section) = build_prompt_section("## Your Task", stage_prompt, context) {
            sections.push(section);
        }
    }

    sections.join("\n\n")
}
