use super::state::AppState;
use crate::db::Db;
use crate::mobile_api::MobileApi;
use axum::extract::Query;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
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
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .list_repo_tasks(&repo_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}
