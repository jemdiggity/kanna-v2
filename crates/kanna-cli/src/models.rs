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
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignalAgentResponse {
    pub(crate) task_id: String,
    pub(crate) created: bool,
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
    pub(crate) pipeline_name: Option<String>,
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
    pub(crate) pipeline_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
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
}

pub(crate) struct TaskCreateOptions {
    pub(crate) repo_id: String,
    pub(crate) prompt: String,
    pub(crate) display_name: Option<String>,
    pub(crate) pipeline_name: Option<String>,
    pub(crate) base_ref: Option<String>,
    pub(crate) agent_provider: Option<String>,
    pub(crate) agent_type: Option<String>,
    pub(crate) model: Option<String>,
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
