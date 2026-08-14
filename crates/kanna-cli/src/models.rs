use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct RepoSummary {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoDetail {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) default_branch: Option<String>,
    pub(crate) hidden: Option<i64>,
    pub(crate) sort_order: Option<i64>,
    pub(crate) created_at: Option<String>,
    pub(crate) last_opened_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddRepoRequest {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignalAgentRequest {
    pub(crate) message: String,
    /// Only honored when the signal creates the singleton agent task; a
    /// running agent keeps the provider its session was spawned with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignalAgentResponse {
    pub(crate) task_id: String,
    pub(crate) created: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeHandoffRequest {
    pub(crate) branch: String,
    pub(crate) target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pr_url: Option<String>,
    pub(crate) summary: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedAgentDefinition {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) default_provider: Option<String>,
    pub(crate) default_model: Option<String>,
    pub(crate) default_effort: Option<String>,
    pub(crate) source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSummary {
    pub(crate) id: String,
    pub(crate) repo_id: String,
    pub(crate) title: String,
    pub(crate) stage: Option<String>,
    pub(crate) activity: Option<String>,
    pub(crate) snippet: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskDetail {
    pub(crate) id: String,
    pub(crate) repo_id: String,
    pub(crate) title: String,
    pub(crate) stage: Option<String>,
    pub(crate) workflow_name: Option<String>,
    pub(crate) stage_transition: Option<String>,
    pub(crate) activity: Option<String>,
    pub(crate) snippet: Option<String>,
    pub(crate) agent_type: Option<String>,
    pub(crate) agent_provider: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) pr_url: Option<String>,
    pub(crate) closed_at: Option<String>,
    pub(crate) worktree_path: Option<String>,
    pub(crate) commits_ahead: i64,
    pub(crate) commits_behind: i64,
    pub(crate) dirty: bool,
    /// Agent-requested revision rounds spent, and the cap the task's workflow
    /// allows (`0` = unlimited). Optional so a desktop server predating the
    /// revision budget still deserializes; when the server sends them, a
    /// no-MCP agent reading `kanna-cli task get` sees the same budget an MCP
    /// caller sees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revision_rounds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revision_limit: Option<i64>,
    /// Direct children returned by a current server, including closed tasks.
    /// Keep this optional so a CLI talking to an older server does not turn an
    /// unavailable downward view into a misleading empty child set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) child_task_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) latest_run: Option<TaskLatestRun>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskLatestRun {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resumed_from_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resume_fallback_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) finished_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskChild {
    pub(crate) id: String,
    pub(crate) agent: Option<String>,
    /// Absence is contract-bearing here, unlike the other fields: a server new
    /// enough to serve this route always sends a `workflow` (the column is NOT
    /// NULL), so a missing `workflowName` means the responding server predates
    /// the discriminator. Skipping `None` keeps that signal intact through the
    /// typed fallback instead of laundering an old server's omission into an
    /// explicit `null` the dispatcher would have to classify differently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) workflow_name: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) closed_at: Option<String>,
    pub(crate) latest_run: Option<TaskLatestRun>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DependentTaskInfo {
    pub(crate) task_id: String,
    pub(crate) title: String,
    pub(crate) branch: Option<String>,
    pub(crate) base_ref: Option<String>,
    pub(crate) reason: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DependentTasksExistResponse {
    pub(crate) exists: bool,
    pub(crate) dependent_tasks: Vec<DependentTaskInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskStatusRow {
    pub(crate) id: String,
    pub(crate) repo_id: String,
    pub(crate) stage: String,
    pub(crate) activity: String,
    pub(crate) title: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskRequest {
    pub(crate) repo_id: String,
    pub(crate) prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workflow_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) blocker_task_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notify_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent_task_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskResponse {
    pub(crate) task_id: String,
    pub(crate) repo_id: String,
    pub(crate) title: String,
    pub(crate) stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) worktree_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteStageRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completion_attempt_key: Option<String>,
    pub(crate) status: String,
    pub(crate) summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestRevisionRequest {
    pub(crate) target_stage: String,
    pub(crate) summary: String,
    pub(crate) prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskInputRequest {
    pub(crate) input: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRenameRequest {
    pub(crate) display_name: String,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskParentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent_task_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskNotifyRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notify_task_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileNotificationRequest {
    pub(crate) title: String,
    pub(crate) body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) task_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileNotificationResponse {
    pub(crate) status: String,
    pub(crate) accepted_count: u64,
    pub(crate) failed_count: u64,
    #[serde(default)]
    pub(crate) failure_reasons: Vec<MobileNotificationFailureReason>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileNotificationFailureReason {
    pub(crate) provider_code: String,
    pub(crate) category: String,
    pub(crate) count: u64,
    pub(crate) message: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskWorkflowRequest {
    pub(crate) workflow_name: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskWorkflowResponse {
    pub(crate) task_id: String,
    pub(crate) workflow_name: String,
    pub(crate) stage: String,
    pub(crate) revision_rounds: i64,
    pub(crate) revision_limit: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlockTaskRequest {
    pub(crate) blocker_task_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskInputResponse {
    pub(crate) ok: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskActionResponse {
    pub(crate) task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) follow_task: Option<bool>,
    /// Where the task stands against its revision-round budget after a
    /// `request-revision`, and whether a revision actually started. Dropping
    /// it here would hide `exhausted` from no-MCP agents, who would read a
    /// parked task as a started revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revision_budget: Option<RevisionBudgetStatus>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionBudgetStatus {
    pub(crate) rounds: i64,
    pub(crate) limit: i64,
    pub(crate) exhausted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

pub(crate) struct TaskCreateOptions {
    pub(crate) repo_id: String,
    pub(crate) prompt: String,
    pub(crate) display_name: Option<String>,
    pub(crate) workflow_name: Option<String>,
    pub(crate) base_ref: Option<String>,
    pub(crate) agent: Option<String>,
    pub(crate) agent_provider: Option<String>,
    pub(crate) agent_type: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) allowed_tool: Vec<String>,
    pub(crate) blocker_task_id: Vec<String>,
    pub(crate) notify_task: Option<String>,
    pub(crate) parent_task: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitUntil {
    Finished,
    Closed,
}
