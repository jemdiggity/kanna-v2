use super::state::AppState;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackupResponse {
    backup_path: String,
}

pub(super) async fn create_backup(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BackupResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let backup_path = db.backup_database(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("backup error: {}", e),
        )
    })?;
    Ok(Json(BackupResponse {
        backup_path: backup_path.to_string_lossy().to_string(),
    }))
}
