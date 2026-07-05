use super::state::AppState;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use std::sync::Arc;

pub(super) async fn get_repo_analytics(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<crate::db::RepoAnalytics>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let analytics = db.repo_analytics(&repo_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    Ok(Json(analytics))
}
