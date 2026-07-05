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

impl PreparedTaskSpawn {
    pub(crate) fn task_id(&self) -> &str {
        &self.created_task.task_id
    }
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
/// the SAME task (`Run`), a stage with pending tail work dispatches its post
/// into the running session (`Post`), and advancing past the final stage
/// closes the task (`Close`). No transition ever creates a new task or
/// worktree.
pub(crate) enum PreparedStageTransition {
    Run(Box<PreparedStageRunSpawn>),
    Post(Box<PreparedPostDispatch>),
    Close {
        task_id: String,
        /// Teardown for the final workspace the close leaves behind.
        workspace_teardown: Option<PreparedWorkspaceTeardown>,
    },
}

/// Cleanup for a workspace the task is leaving: the workspace repo config's
/// `teardown` commands, ready to run best-effort as a detached daemon session
/// in the old worktree. The session id derives from the workspace's stored
/// branch (`td-<branch>`) so concurrent teardowns of different workspaces
/// never collide, and neither does the desktop's close-time `td-<task-id>`
/// session.
#[derive(Clone)]
pub(crate) struct PreparedWorkspaceTeardown {
    pub(super) session_id: String,
    pub(super) cwd: String,
    pub(super) env: HashMap<String, String>,
    pub(super) command: String,
}

/// A stage's post, ready to be injected into the task's live agent session.
/// `fallback` spawns the post as a fresh session (with the post's agent) when
/// the live session turns out to be dead.
pub(crate) struct PreparedPostDispatch {
    pub(super) task_id: String,
    pub(super) session_id: String,
    /// Post prompt (with $VAR substitution) plus the completion reminder,
    /// submitted through the task-input path.
    pub(super) message: String,
    /// Run-history label: the post's name.
    pub(super) run_stage: String,
    pub(super) fallback: PreparedStageRunSpawn,
}

pub(crate) struct PreparedStageRerun {
    pub(super) task_id: String,
    pub(super) session_id: String,
    /// Run-history label: the stage name, or the post name when rerunning a
    /// legacy task parked at a folded post stage.
    pub(super) stage: String,
    pub(super) run_kind: &'static str,
    pub(super) stage_agent: Option<String>,
    pub(super) agent_provider: String,
    pub(super) model: Option<String>,
    pub(super) cwd: String,
    pub(super) env: HashMap<String, String>,
    pub(super) session: PreparedSessionSpawn,
}

/// A stage-run workspace forked from the task's committed tip: swaps get a
/// fresh branch + worktree (N worktrees, N branches, one PR — the PR agent
/// renames the final random branch into something meaningful). The previous
/// worktree stays on disk until cleanup; only committed work crosses the
/// boundary.
pub(crate) struct ForkedWorkspace {
    pub(super) branch: String,
    pub(super) worktree_path: String,
}

/// A new stage run spawned on an existing task: same task id, but a swap runs
/// in a freshly forked workspace (`forked_workspace`), while a post fallback
/// or rerun keeps the task's current one.
pub(crate) struct PreparedStageRunSpawn {
    pub(super) task_id: String,
    pub(super) session_id: String,
    /// Value written to `pipeline_item.stage`. For a post fallback spawn this
    /// is the owning stage (a post never moves the task's stage).
    pub(super) next_stage: String,
    /// Run-history label (`stage_run.stage`): the stage name, or the post's
    /// name for a post fallback spawn.
    pub(super) run_stage: String,
    /// `stage_run.kind`: "main" or "post".
    pub(super) run_kind: &'static str,
    /// Present when this run forked a fresh workspace; the spawn updates
    /// `pipeline_item.branch` and the worktree record, and rolls the fork
    /// back if the daemon spawn fails.
    pub(super) forked_workspace: Option<ForkedWorkspace>,
    /// Teardown for the workspace this run leaves behind (forked swaps only);
    /// spawned after the transition succeeds, never on rollback.
    pub(super) workspace_teardown: Option<PreparedWorkspaceTeardown>,
    pub(super) stage_agent: Option<String>,
    pub(super) agent_provider: String,
    pub(super) model: Option<String>,
    pub(super) feedback: Option<String>,
    pub(super) cwd: String,
    pub(super) env: HashMap<String, String>,
    pub(super) session: PreparedSessionSpawn,
}
