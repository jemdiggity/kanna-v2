use super::state::{db_write_error, AppState};
use super::task_blockers::resolve_existing_task_id;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PutTaskAgentSessionRequest {
    agent_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskAgentSessionResponse {
    task_id: String,
}

pub(super) async fn put_task_agent_session(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(payload): Json<PutTaskAgentSessionRequest>,
) -> Result<Json<TaskAgentSessionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    let agent_session_id = payload
        .agent_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    db.update_pipeline_item_agent_session_id(&task_id, agent_session_id)
        .map_err(|e| db_write_error("db error", e))?;
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(TaskAgentSessionResponse { task_id }))
}
