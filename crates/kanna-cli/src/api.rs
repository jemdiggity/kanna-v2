use kanna_tool_catalog::{
    clamp_wait_timeout_secs, task_state_matches_wait_until, task_value_matches_wait_until,
    wait_resolved_result, wait_timeout_result, WaitTaskState, WaitUntil as CatalogWaitUntil,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::env;

use crate::models::{
    AddRepoRequest, BlockTaskRequest, CompleteStageRequest, CreateTaskRequest, CreateTaskResponse,
    DependentTasksExistResponse, MergeHandoffRequest, MobileNotificationRequest,
    MobileNotificationResponse, RepoDetail, RepoSummary, RequestRevisionRequest,
    ResolvedAgentDefinition, SetTaskNotifyRequest, SetTaskParentRequest, SetTaskWorkflowRequest,
    SetTaskWorkflowResponse, SignalAgentRequest, SignalAgentResponse, TaskActionResponse,
    TaskChild, TaskDetail, TaskInputRequest, TaskInputResponse, TaskInputs, TaskRenameRequest,
    TaskSummary, WaitUntil,
};

pub(crate) fn join_server_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

pub(crate) fn encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

pub(crate) fn task_list_path() -> &'static str {
    "/v1/tasks/recent"
}

pub(crate) fn repo_task_list_path(repo_id: &str) -> String {
    format!("/v1/repos/{}/tasks", encode_path_segment(repo_id))
}

pub(crate) fn repo_agent_list_path(repo_id: &str) -> String {
    format!("/v1/repos/{}/agents", encode_path_segment(repo_id))
}

pub(crate) fn signal_agent_path(repo_id: &str, agent: &str) -> String {
    format!(
        "/v1/repos/{}/agents/{}/signal",
        encode_path_segment(repo_id),
        encode_path_segment(agent)
    )
}

pub(crate) fn task_search_path(query: &str) -> String {
    format!("/v1/tasks/search?query={}", encode_path_segment(query))
}

pub(crate) fn task_get_path(task_id: &str) -> String {
    format!("/v1/tasks/{}", encode_path_segment(task_id))
}

pub(crate) fn task_children_path(task_id: &str) -> String {
    format!("{}/children", task_get_path(task_id))
}

pub(crate) fn dependent_tasks_exist_path(task_id: &str) -> String {
    format!("{}/dependent-tasks-exist", task_get_path(task_id))
}

/// Query for the multi-task event wait. Keys are camelCase because the server
/// deserializes them with the same casing the MCP catalog sends.
pub(crate) struct TaskEventsParams<'a> {
    pub(crate) task_ids: &'a [String],
    pub(crate) parent_task_id: Option<&'a str>,
    pub(crate) repo_id: Option<&'a str>,
    pub(crate) repo_remote_url_hash: Option<&'a str>,
    pub(crate) local_only: bool,
    pub(crate) cursor: Option<&'a str>,
    pub(crate) timeout_secs: u64,
    pub(crate) limit: Option<i64>,
}

pub(crate) fn task_events_path(params: &TaskEventsParams<'_>) -> String {
    let mut query = vec![format!(
        "timeoutSecs={}",
        clamp_wait_timeout_secs(params.timeout_secs)
    )];
    if !params.task_ids.is_empty() {
        query.push(format!(
            "taskIds={}",
            encode_path_segment(&params.task_ids.join(","))
        ));
    }
    if let Some(parent_task_id) = params.parent_task_id {
        query.push(format!(
            "parentTaskId={}",
            encode_path_segment(parent_task_id)
        ));
    }
    if let Some(repo_id) = params.repo_id {
        query.push(format!("repoId={}", encode_path_segment(repo_id)));
    }
    if let Some(repo_remote_url_hash) = params.repo_remote_url_hash {
        query.push(format!(
            "repoRemoteUrlHash={}",
            encode_path_segment(repo_remote_url_hash)
        ));
    }
    if params.local_only {
        query.push("localOnly=true".to_string());
    }
    if let Some(cursor) = params.cursor {
        query.push(format!("cursor={}", encode_path_segment(cursor)));
    }
    if let Some(limit) = params.limit {
        query.push(format!("limit={limit}"));
    }
    format!("/v1/task-events?{}", query.join("&"))
}

pub(crate) fn task_inputs_path(task_id: &str, tail: Option<usize>) -> String {
    let task_id = encode_path_segment(task_id);
    match tail {
        Some(tail) => format!("/v1/tasks/{task_id}/inputs?tail={tail}"),
        None => format!("/v1/tasks/{task_id}/inputs"),
    }
}

pub(crate) fn task_logs_path(task_id: &str, tail: Option<usize>) -> String {
    let task_id = encode_path_segment(task_id);
    match tail {
        Some(tail) => format!("/v1/tasks/{task_id}/logs?tail={tail}"),
        None => format!("/v1/tasks/{task_id}/logs"),
    }
}

pub(crate) async fn get_json<T: DeserializeOwned>(base_url: &str, path: &str) -> Result<T, String> {
    let mut request = reqwest::Client::new().get(join_server_url(base_url, path));
    if path.split('?').next() == Some("/v1/task-events") {
        if let Some(token) = read_task_events_token_from_env()? {
            request = request.bearer_auth(token);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = require_success(response).await?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

fn read_task_events_token_from_env() -> Result<Option<String>, String> {
    const TOKEN_PATH_ENV: &str = "KANNA_TASK_EVENTS_TOKEN_PATH";
    let Some(path) = env::var(TOKEN_PATH_ENV)
        .ok()
        .filter(|path| !path.trim().is_empty())
    else {
        return Ok(None);
    };
    let token = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {TOKEN_PATH_ENV} {path}: {error}"))?;
    let token = token.trim();
    if token.is_empty() {
        return Err(format!("{TOKEN_PATH_ENV} {path} is empty"));
    }
    Ok(Some(token.to_string()))
}

/// Surface the response body on HTTP errors — the server puts its actual
/// error message there, and a bare status code is undiagnosable for agents.
pub(crate) async fn require_success(
    response: reqwest::Response,
) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response
        .text()
        .await
        .unwrap_or_else(|e| format!("failed to read error body: {e}"));
    Err(format!("request failed with status {status}: {body}"))
}

pub(crate) async fn get_text(base_url: &str, path: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = require_success(response).await?;
    response
        .text()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

pub(crate) async fn post_json<B: Serialize, T: DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &B,
) -> Result<T, String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = require_success(response).await?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

pub(crate) async fn patch_json<B: Serialize, T: DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &B,
) -> Result<T, String> {
    let response = reqwest::Client::new()
        .patch(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = require_success(response).await?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

pub(crate) async fn post_no_content_json<B: Serialize>(
    base_url: &str,
    path: &str,
    body: &B,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    require_success(response).await?;

    Ok(())
}

pub(crate) async fn post_catalog_json(
    base_url: &str,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let response = require_success(response).await?;
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

pub(crate) async fn patch_catalog_json(
    base_url: &str,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .patch(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let response = require_success(response).await?;
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

pub(crate) async fn list_repos_via_api(base_url: &str) -> Result<Vec<RepoSummary>, String> {
    get_json(base_url, "/v1/repos").await
}

pub(crate) async fn add_repo_via_api(
    base_url: &str,
    request: &AddRepoRequest,
) -> Result<RepoDetail, String> {
    post_json(base_url, "/v1/repos", request).await
}

pub(crate) async fn signal_agent_via_api(
    base_url: &str,
    repo_id: &str,
    agent: &str,
    request: &SignalAgentRequest,
) -> Result<SignalAgentResponse, String> {
    post_json(base_url, &signal_agent_path(repo_id, agent), request).await
}

pub(crate) async fn signal_merge_handoff_via_api(
    base_url: &str,
    task_id: &str,
    request: &MergeHandoffRequest,
) -> Result<SignalAgentResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/signal-merge-handoff"),
        request,
    )
    .await
}

pub(crate) async fn list_repo_agents_via_api(
    base_url: &str,
    repo_id: &str,
) -> Result<Vec<ResolvedAgentDefinition>, String> {
    get_json(base_url, &repo_agent_list_path(repo_id)).await
}

pub(crate) async fn list_tasks_via_api(base_url: &str) -> Result<Vec<TaskSummary>, String> {
    get_json(base_url, task_list_path()).await
}

pub(crate) async fn list_repo_tasks_via_api(
    base_url: &str,
    repo_id: &str,
) -> Result<Vec<TaskSummary>, String> {
    get_json(base_url, &repo_task_list_path(repo_id)).await
}

pub(crate) async fn search_tasks_via_api(
    base_url: &str,
    query: &str,
) -> Result<Vec<TaskSummary>, String> {
    get_json(base_url, &task_search_path(query)).await
}

pub(crate) async fn get_task_via_api(base_url: &str, task_id: &str) -> Result<TaskDetail, String> {
    get_json(base_url, &task_get_path(task_id)).await
}

pub(crate) async fn list_task_children_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<Vec<TaskChild>, String> {
    get_json(base_url, &task_children_path(task_id)).await
}

pub(crate) async fn dependent_tasks_exist_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<DependentTasksExistResponse, String> {
    get_json(base_url, &dependent_tasks_exist_path(task_id)).await
}

pub(crate) async fn task_inputs_via_api(
    base_url: &str,
    task_id: &str,
    tail: Option<usize>,
) -> Result<TaskInputs, String> {
    get_json(base_url, &task_inputs_path(task_id, tail)).await
}

pub(crate) async fn task_logs_via_api(
    base_url: &str,
    task_id: &str,
    tail: Option<usize>,
) -> Result<String, String> {
    get_text(base_url, &task_logs_path(task_id, tail)).await
}

pub(crate) fn parse_wait_until(value: &str) -> Result<WaitUntil, String> {
    match value {
        "finished" => Ok(WaitUntil::Finished),
        "closed" => Ok(WaitUntil::Closed),
        other => Err(format!("--until must be finished or closed, got {other}")),
    }
}

/// Shares `kanna-tool-catalog`'s predicate rather than restating it: a
/// termination — a terminal `stage_run`, an exited agent session, or a closed
/// task — decides `Finished`, never the blended `activity` display value.
pub(crate) fn task_matches_wait_until(task: &TaskDetail, until: WaitUntil) -> bool {
    task_state_matches_wait_until(
        WaitTaskState {
            closed: task.closed_at.is_some(),
            runtime_state: task.runtime_state.as_deref(),
            latest_run_status: task
                .latest_run
                .as_ref()
                .and_then(|run| run.status.as_deref()),
        },
        match until {
            WaitUntil::Finished => CatalogWaitUntil::Finished,
            WaitUntil::Closed => CatalogWaitUntil::Closed,
        },
    )
}

/// The typed CLI mirrors the MCP tool: a wait that runs out its (bounded)
/// window reports the task's latest detail rather than failing, so an agent
/// without MCP support loops on the same discriminator.
pub(crate) enum WaitTaskOutcome {
    Resolved(TaskDetail),
    TimedOut { task: TaskDetail, timeout_secs: u64 },
}

pub(crate) async fn wait_task_via_api(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: WaitUntil,
) -> Result<WaitTaskOutcome, String> {
    let timeout_secs = clamp_wait_timeout_secs(timeout_secs);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    loop {
        let task = get_task_via_api(base_url, task_id).await?;
        if task_matches_wait_until(&task, until) {
            return Ok(WaitTaskOutcome::Resolved(task));
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(WaitTaskOutcome::TimedOut { task, timeout_secs });
        }
        tokio::time::sleep(poll_interval.min(deadline - now)).await;
    }
}

pub(crate) fn catalog_task_matches_wait_until(task: &Value, until: CatalogWaitUntil) -> bool {
    task_value_matches_wait_until(task, until)
}

pub(crate) async fn wait_catalog_task_via_api(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: CatalogWaitUntil,
) -> Result<Value, String> {
    let timeout_secs = clamp_wait_timeout_secs(timeout_secs);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    let path = task_get_path(task_id);
    loop {
        let task: Value = get_json(base_url, &path).await?;
        if catalog_task_matches_wait_until(&task, until) {
            return Ok(wait_resolved_result(task));
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(wait_timeout_result(task, task_id, timeout_secs));
        }
        tokio::time::sleep(poll_interval.min(deadline - now)).await;
    }
}

pub(crate) async fn create_task_via_api(
    base_url: &str,
    request: &CreateTaskRequest,
) -> Result<CreateTaskResponse, String> {
    post_json(base_url, "/v1/tasks", request).await
}

pub(crate) async fn complete_stage_via_api(
    base_url: &str,
    task_id: &str,
    request: &CompleteStageRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/complete-stage"),
        request,
    )
    .await
}

pub(crate) async fn request_revision_via_api(
    base_url: &str,
    task_id: &str,
    request: &RequestRevisionRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/request-revision"),
        request,
    )
    .await
}

pub(crate) async fn send_task_input_via_api(
    base_url: &str,
    task_id: &str,
    request: &TaskInputRequest,
) -> Result<TaskInputResponse, String> {
    post_no_content_json(base_url, &format!("/v1/tasks/{task_id}/input"), request)
        .await
        .map(|_| TaskInputResponse { ok: true })
}

pub(crate) async fn rename_task_via_api(
    base_url: &str,
    task_id: &str,
    request: &TaskRenameRequest,
) -> Result<TaskActionResponse, String> {
    patch_json(base_url, &task_get_path(task_id), request).await
}

pub(crate) async fn wait_task_events_via_api(
    base_url: &str,
    params: &TaskEventsParams<'_>,
) -> Result<Value, String> {
    get_json(base_url, &task_events_path(params)).await
}

pub(crate) async fn set_task_notify_via_api(
    base_url: &str,
    task_id: &str,
    request: &SetTaskNotifyRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/set-notify"),
        request,
    )
    .await
}

pub(crate) async fn notify_mobile_via_api(
    base_url: &str,
    request: &MobileNotificationRequest,
) -> Result<MobileNotificationResponse, String> {
    post_json(base_url, "/v1/mobile/notifications", request).await
}

pub(crate) async fn set_task_parent_via_api(
    base_url: &str,
    task_id: &str,
    request: &SetTaskParentRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/set-parent"),
        request,
    )
    .await
}

pub(crate) async fn set_task_workflow_via_api(
    base_url: &str,
    task_id: &str,
    request: &SetTaskWorkflowRequest,
) -> Result<SetTaskWorkflowResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/set-workflow"),
        request,
    )
    .await
}

pub(crate) async fn advance_stage_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/advance-stage"),
        &serde_json::json!({}),
    )
    .await
}

pub(crate) async fn rerun_stage_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/rerun-stage"),
        &serde_json::json!({}),
    )
    .await
}

pub(crate) async fn resume_task_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/resume"),
        &serde_json::json!({}),
    )
    .await
}

pub(crate) async fn block_task_via_api(
    base_url: &str,
    task_id: &str,
    request: &BlockTaskRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/block"),
        request,
    )
    .await
}

pub(crate) async fn unblock_task_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/unblock"),
        &serde_json::json!({}),
    )
    .await
}

pub(crate) async fn close_task_via_api(base_url: &str, task_id: &str) -> Result<(), String> {
    post_no_content_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/close"),
        &serde_json::json!({}),
    )
    .await
}
