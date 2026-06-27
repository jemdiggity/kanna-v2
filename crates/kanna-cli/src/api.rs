use kanna_tool_catalog::WaitUntil as CatalogWaitUntil;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::models::{
    AddRepoRequest, BlockTaskRequest, CompleteStageRequest, CreateTaskRequest, CreateTaskResponse,
    RepoDetail, RepoSummary, RequestRevisionRequest, SetTaskParentRequest, TaskActionResponse,
    TaskDetail, TaskInputRequest, TaskInputResponse, TaskRenameRequest, TaskSummary, WaitUntil,
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

pub(crate) fn task_search_path(query: &str) -> String {
    format!("/v1/tasks/search?query={}", encode_path_segment(query))
}

pub(crate) fn task_get_path(task_id: &str) -> String {
    format!("/v1/tasks/{}", encode_path_segment(task_id))
}

pub(crate) fn task_logs_path(task_id: &str, tail: Option<usize>) -> String {
    let task_id = encode_path_segment(task_id);
    match tail {
        Some(tail) => format!("/v1/tasks/{task_id}/logs?tail={tail}"),
        None => format!("/v1/tasks/{task_id}/logs"),
    }
}

pub(crate) async fn get_json<T: DeserializeOwned>(base_url: &str, path: &str) -> Result<T, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("request failed: {e}"))?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

pub(crate) async fn get_text(base_url: &str, path: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }
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
    let response = response
        .error_for_status()
        .map_err(|e| format!("request failed: {e}"))?;
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
    let response = response
        .error_for_status()
        .map_err(|e| format!("request failed: {e}"))?;
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
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }

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
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::json!({ "ok": true }));
    }
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }
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
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::json!({ "ok": true }));
    }
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }
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

pub(crate) fn task_matches_wait_until(task: &TaskDetail, until: WaitUntil) -> bool {
    match until {
        WaitUntil::Finished => {
            task.closed_at.is_some() || task.activity.as_deref() == Some("unread")
        }
        WaitUntil::Closed => task.closed_at.is_some(),
    }
}

pub(crate) async fn wait_task_via_api(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: WaitUntil,
) -> Result<TaskDetail, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    loop {
        let task = get_task_via_api(base_url, task_id).await?;
        if task_matches_wait_until(&task, until) {
            return Ok(task);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for task {task_id}"));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

pub(crate) fn catalog_task_matches_wait_until(task: &Value, until: CatalogWaitUntil) -> bool {
    let closed = task.get("closedAt").is_some_and(|value| !value.is_null());
    match until {
        CatalogWaitUntil::Finished => {
            closed || task.get("activity").and_then(Value::as_str) == Some("unread")
        }
        CatalogWaitUntil::Closed => closed,
    }
}

pub(crate) async fn wait_catalog_task_via_api(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: CatalogWaitUntil,
) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    let path = task_get_path(task_id);
    loop {
        let task: Value = get_json(base_url, &path).await?;
        if catalog_task_matches_wait_until(&task, until) {
            return Ok(task);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for task {task_id}"));
        }
        tokio::time::sleep(poll_interval).await;
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
