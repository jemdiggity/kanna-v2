use super::state::AppState;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use std::sync::Arc;

pub(super) async fn get_snapshot(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::db::UiSnapshot>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let recorded_orphans = crate::mobile_api::record_orphaned_initialized_tasks(&db)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if recorded_orphans {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    let snapshot = db.ui_snapshot().map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    Ok(Json(snapshot))
}
