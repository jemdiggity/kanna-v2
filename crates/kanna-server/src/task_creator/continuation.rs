#![allow(dead_code)]

use super::definitions::PipelinePostAction;
use super::types::PreparedStageContinue;

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_continue_stage(
    source_task_id: &str,
    previous_stage: &str,
    next_stage: &str,
    previous_stage_result: Option<String>,
    prompt: &str,
    source_branch: Option<&str>,
    agent_type: &str,
    stage_agent: Option<&str>,
    agent_provider: Option<&str>,
    follow_task: Option<bool>,
) -> Result<PreparedStageContinue, String> {
    source_branch.ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    Ok(PreparedStageContinue {
        task_id: source_task_id.to_string(),
        agent_type: agent_type.to_string(),
        previous_stage: previous_stage.to_string(),
        next_stage: next_stage.to_string(),
        stage_agent: stage_agent.map(str::to_string),
        agent_provider: agent_provider.map(str::to_string),
        model: None,
        previous_stage_result,
        previous_active_post_action: None,
        active_post_action: None,
        follow_task,
        input_text: prompt.to_string(),
        input: encode_agent_stage_input(prompt, agent_provider),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_post_action_stage(
    source_task_id: &str,
    current_stage: &str,
    post_action: &PipelinePostAction,
    previous_stage_result: Option<String>,
    prompt: &str,
    source_branch: Option<&str>,
    agent_type: &str,
    agent_provider: Option<&str>,
) -> Result<PreparedStageContinue, String> {
    source_branch.ok_or_else(|| format!("task has no branch: {}", source_task_id))?;
    Ok(PreparedStageContinue {
        task_id: source_task_id.to_string(),
        agent_type: agent_type.to_string(),
        previous_stage: current_stage.to_string(),
        next_stage: current_stage.to_string(),
        stage_agent: post_action
            .agent
            .as_deref()
            .or(Some(post_action.name.as_str()))
            .map(str::to_string),
        agent_provider: agent_provider.map(str::to_string),
        model: None,
        previous_stage_result,
        previous_active_post_action: None,
        active_post_action: Some(post_action.name.clone()),
        follow_task: None,
        input_text: prompt.to_string(),
        input: encode_agent_stage_input(prompt, agent_provider),
    })
}

fn encode_agent_stage_input(stage_prompt: &str, agent_provider: Option<&str>) -> Vec<u8> {
    let _ = agent_provider;
    format!("\u{1b}[200~{stage_prompt}\u{1b}[201~\r").into_bytes()
}
