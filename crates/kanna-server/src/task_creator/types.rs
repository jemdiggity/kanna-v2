use kanna_daemon::protocol::AgentProvider as DaemonAgentProvider;
use std::collections::HashMap;

pub(super) struct TaskCreationRequest {
    pub(super) task_prompt: String,
    pub(super) display_name: Option<String>,
    pub(super) pipeline_name: Option<String>,
    pub(super) base_ref: Option<String>,
    pub(super) stored_base_ref: Option<String>,
    pub(super) stage_override: Option<String>,
    pub(super) explicit_provider: Option<String>,
    pub(super) default_provider: Option<String>,
    pub(super) agent_type: Option<String>,
    pub(super) model: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) allowed_tools: Vec<String>,
    pub(super) notify_task_id: Option<String>,
}

#[derive(Clone)]
pub(super) struct CreatedTask {
    pub(super) task_id: String,
    pub(super) repo_id: String,
    pub(super) title: String,
    pub(super) stage: String,
    pub(super) agent_type: String,
    pub(super) worktree_path: String,
}

#[derive(Clone)]
pub(crate) struct PreparedTaskSpawn {
    pub(super) created_task: CreatedTask,
    pub(super) branch: String,
    pub(super) session_id: String,
    pub(super) cwd: String,
    pub(super) env: HashMap<String, String>,
    pub(super) session: PreparedSessionSpawn,
}

#[derive(Clone)]
pub(crate) enum PreparedSessionSpawn {
    Pty {
        executable: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
        agent_provider: DaemonAgentProvider,
    },
    Agent {
        agent_provider: DaemonAgentProvider,
        prompt: String,
        model: Option<String>,
        permission_mode: Option<String>,
        allowed_tools: Vec<String>,
        system_prompt: String,
        mcp_config_path: Option<String>,
        executable: Option<String>,
    },
}

pub(crate) enum PreparedStageTransition {
    Spawn(Box<PreparedTaskSpawn>),
    Continue(Box<PreparedStageContinue>),
}

pub(crate) struct PreparedStageContinue {
    pub(super) task_id: String,
    pub(super) agent_type: String,
    pub(super) previous_stage: String,
    pub(super) next_stage: String,
    pub(super) previous_stage_result: Option<String>,
    pub(super) previous_active_post_action: Option<String>,
    pub(super) active_post_action: Option<String>,
    pub(super) input_text: String,
    pub(super) input: Vec<u8>,
}
