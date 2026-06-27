use super::state::AppState;
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

pub(super) async fn status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::mobile_api::MobileServerStatus>, (axum::http::StatusCode, String)> {
    Ok(Json(state.mobile_server_status().await))
}
