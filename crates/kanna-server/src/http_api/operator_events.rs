use super::state::AppState;
use crate::db::{Db, NewOperatorEvent};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OperatorEventInput {
    event_type: String,
    pipeline_item_id: Option<String>,
    repo_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PostOperatorEventsRequest {
    events: Vec<OperatorEventInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PostOperatorEventsResponse {
    inserted: usize,
}

pub(super) async fn post_operator_events(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PostOperatorEventsRequest>,
) -> Result<Json<PostOperatorEventsResponse>, (axum::http::StatusCode, String)> {
    if payload.events.is_empty() {
        return Ok(Json(PostOperatorEventsResponse { inserted: 0 }));
    }

    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let events = payload
        .events
        .iter()
        .map(|event| NewOperatorEvent {
            event_type: event.event_type.as_str(),
            pipeline_item_id: event.pipeline_item_id.as_deref(),
            repo_id: event.repo_id.as_deref(),
        })
        .collect::<Vec<_>>();
    let inserted = db.insert_operator_events(&events).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    Ok(Json(PostOperatorEventsResponse { inserted }))
}
