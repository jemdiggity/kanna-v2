use serde::{Deserialize, Serialize};

#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct DesktopDescriptor {
    pub id: String,
    pub name: String,
    pub connection_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct RepoSummary {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct RepoDetail {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub hidden: Option<i64>,
    pub sort_order: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct MobileServerStatus {
    pub state: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub server_version: Option<String>,
    pub lan_host: String,
    pub lan_port: u16,
    pub pairing_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct TaskSummary {
    pub id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: Option<String>,
    pub activity: Option<String>,
    pub snippet: Option<String>,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct TaskDetail {
    pub id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: Option<String>,
    pub pipeline_name: Option<String>,
    pub stage_transition: Option<String>,
    pub activity: Option<String>,
    pub snippet: Option<String>,
    pub agent_type: Option<String>,
    pub agent_provider: Option<String>,
    pub branch: Option<String>,
    pub pr_url: Option<String>,
    pub closed_at: Option<String>,
    pub worktree_path: Option<String>,
    pub commits_ahead: i64,
    pub commits_behind: i64,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct AddRepoRequest {
    pub path: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CreateTaskRequest {
    pub repo_id: String,
    pub prompt: String,
    #[serde(alias = "display_name")]
    pub display_name: Option<String>,
    pub pipeline_name: Option<String>,
    pub base_ref: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub blocker_task_ids: Option<Vec<String>>,
    pub notify_task_id: Option<String>,
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CreateTaskResponse {
    pub task_id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: String,
    pub agent_type: String,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CompleteStageRequest {
    pub status: String,
    pub summary: String,
    #[cfg_attr(feature = "typescript", ts(type = "unknown"))]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct RequestRevisionRequest {
    pub target_stage: String,
    pub summary: String,
    pub prompt: String,
    #[cfg_attr(feature = "typescript", ts(type = "unknown"))]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct BlockTaskRequest {
    pub blocker_task_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct SetTaskParentRequest {
    #[serde(default)]
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct TaskActionResponse {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_task: Option<bool>,
}
