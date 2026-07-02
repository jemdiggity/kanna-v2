use kanna_daemon::protocol::AgentProvider as DaemonAgentProvider;
use std::collections::HashMap;

pub(super) struct TaskCreationRequest {
    pub(super) task_prompt: String,
    pub(super) display_name: Option<String>,
    pub(super) pipeline_name: Option<String>,
    pub(super) pipeline_def: Option<String>,
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
    pub(super) parent_task_id: Option<String>,
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
    pub(super) stage_agent: Option<String>,
    pub(super) agent_provider: String,
    pub(super) model: Option<String>,
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

/// Stage transitions are durable: an in-pipeline hop starts a new stage run on
/// the SAME task (`Run`), and advancing past the final stage closes the task
/// (`Close`). No transition ever creates a new task or worktree.
pub(crate) enum PreparedStageTransition {
    Run(Box<PreparedStageRunSpawn>),
    Close { task_id: String },
}

pub(crate) struct PreparedStageRerun {
    pub(super) task_id: String,
    pub(super) session_id: String,
    pub(super) stage: String,
    pub(super) stage_agent: Option<String>,
    pub(super) agent_provider: String,
    pub(super) model: Option<String>,
    pub(super) cwd: String,
    pub(super) env: HashMap<String, String>,
    pub(super) session: PreparedSessionSpawn,
}

/// A new stage run spawned in place on an existing task: same task id, same
/// branch, same worktree — only the stage (and agent session) changes.
pub(crate) struct PreparedStageRunSpawn {
    pub(super) task_id: String,
    pub(super) session_id: String,
    pub(super) next_stage: String,
    pub(super) stage_agent: Option<String>,
    pub(super) agent_provider: String,
    pub(super) model: Option<String>,
    pub(super) feedback: Option<String>,
    pub(super) cwd: String,
    pub(super) env: HashMap<String, String>,
    pub(super) session: PreparedSessionSpawn,
}
