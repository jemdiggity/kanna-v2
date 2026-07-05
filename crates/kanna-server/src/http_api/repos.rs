use super::state::AppState;
use crate::db::{Db, PipelineItem};
use crate::mobile_api::MobileApi;
use axum::extract::Query;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;

pub(super) async fn list_repos(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::mobile_api::RepoSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let repos = api
        .list_repos()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(repos))
}

pub(super) async fn add_repo(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<crate::mobile_api::AddRepoRequest>,
) -> Result<Json<crate::mobile_api::RepoDetail>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let repo = api.add_repo(payload).map_err(|e| {
        let status = match &e {
            crate::mobile_api::AddRepoError::InvalidPath(_) => axum::http::StatusCode::BAD_REQUEST,
            crate::mobile_api::AddRepoError::DuplicatePath => axum::http::StatusCode::CONFLICT,
            crate::mobile_api::AddRepoError::Internal(_) => {
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, e.message())
    })?;
    state.publish_state_changed(StateChangeScope::Repos);
    state.publish_state_changed(StateChangeScope::Repos);
    Ok(Json(repo))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct RepoByPathQuery {
    path: String,
}

pub(super) async fn get_repo_by_path(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RepoByPathQuery>,
) -> Result<Json<crate::db::SnapshotRepo>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let repo = db
        .get_snapshot_repo_by_path(&query.path)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {e}"),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found for path: {}", query.path),
            )
        })?;
    Ok(Json(repo))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PatchRepoRequest {
    name: Option<String>,
    #[serde(default)]
    remote_url: Option<Option<String>>,
    #[serde(default)]
    remote_url_hash: Option<Option<String>>,
    hidden: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PatchRepoResponse {
    repo_id: String,
}

pub(super) async fn patch_repo(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
    Json(payload): Json<PatchRepoRequest>,
) -> Result<Json<PatchRepoResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    db.patch_repo(
        &repo_id,
        payload.name.as_deref(),
        payload.remote_url.as_ref().map(|value| value.as_deref()),
        payload
            .remote_url_hash
            .as_ref()
            .map(|value| value.as_deref()),
        payload.hidden,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => (
            axum::http::StatusCode::NOT_FOUND,
            format!("repo not found: {repo_id}"),
        ),
        e => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        ),
    })?;
    state.publish_state_changed(StateChangeScope::Repos);
    Ok(Json(PatchRepoResponse { repo_id }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReorderReposRequest {
    ordered_ids: Vec<String>,
}

pub(super) async fn reorder_repos(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReorderReposRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    db.reorder_repos(&payload.ordered_ids).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    state.publish_state_changed(StateChangeScope::Repos);
    Ok(Json(
        serde_json::json!({ "updated": payload.ordered_ids.len() }),
    ))
}

pub(super) async fn list_repo_tasks(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(repo_id): axum::extract::Path<String>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    if crate::mobile_api::record_orphaned_initialized_tasks(&db)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .list_repo_tasks(&repo_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DependentTaskInfo {
    task_id: String,
    title: String,
    branch: Option<String>,
    base_ref: Option<String>,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DependentTasksExistResponse {
    exists: bool,
    dependent_tasks: Vec<DependentTaskInfo>,
}

pub(super) async fn dependent_tasks_exist(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<DependentTasksExistResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = db
        .resolve_pipeline_item_id(&task_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    let task = db
        .get_pipeline_item(&task_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    let repo = db
        .get_repo(&task.repo_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found: {}", task.repo_id),
            )
        })?;
    let branch = resolve_task_branch(&repo.path, &task).ok_or_else(|| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("task has no branch: {task_id}"),
        )
    })?;
    let open_items = db.list_pipeline_items(&task.repo_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;

    let mut dependent_tasks = Vec::new();
    let mut seen = HashSet::new();

    let dependent_ids = db.list_tasks_blocked_by(&task_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    for dependent_id in dependent_ids {
        let Some(dependent) = db.get_pipeline_item(&dependent_id).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        else {
            continue;
        };
        if dependent.closed_at.is_none() && dependent.repo_id == task.repo_id {
            push_dependent_task(&mut dependent_tasks, &mut seen, dependent, "task_blocker");
        }
    }

    for item in open_items {
        if ref_matches_branch(item.base_ref.as_deref(), &branch) {
            push_dependent_task(&mut dependent_tasks, &mut seen, item, "base_ref");
        }
    }

    Ok(Json(DependentTasksExistResponse {
        exists: !dependent_tasks.is_empty(),
        dependent_tasks,
    }))
}

fn push_dependent_task(
    dependent_tasks: &mut Vec<DependentTaskInfo>,
    seen: &mut HashSet<(String, String)>,
    item: PipelineItem,
    reason: &str,
) {
    let key = (item.id.clone(), reason.to_string());
    if !seen.insert(key) {
        return;
    }
    let title = item
        .display_name
        .clone()
        .or(item.prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    dependent_tasks.push(DependentTaskInfo {
        task_id: item.id,
        title,
        branch: item.branch,
        base_ref: item.base_ref,
        reason: reason.to_string(),
    });
}

fn resolve_task_branch(repo_path: &str, item: &PipelineItem) -> Option<String> {
    let stored_branch = item.branch.as_deref();
    let live_branch =
        crate::task_creator::resolve_current_source_worktree_branch(repo_path, stored_branch);
    live_branch
        .as_deref()
        .or(stored_branch)
        .and_then(normalize_branch_ref)
}

fn ref_matches_branch(value: Option<&str>, branch: &str) -> bool {
    value
        .and_then(normalize_branch_ref)
        .as_deref()
        .is_some_and(|normalized| normalized == branch)
}

fn normalize_branch_ref(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        trimmed
            .strip_prefix("refs/remotes/origin/")
            .or_else(|| trimmed.strip_prefix("refs/heads/"))
            .or_else(|| trimmed.strip_prefix("origin/"))
            .unwrap_or(trimmed)
            .to_string(),
    )
}
