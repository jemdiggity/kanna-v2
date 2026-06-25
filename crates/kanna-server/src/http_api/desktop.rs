use super::state::AppState;
use crate::db::Db;
use crate::mobile_api::MobileApi;
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

pub(super) async fn list_desktops(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::mobile_api::DesktopDescriptor>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let desktops = api
        .list_desktops()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(desktops))
}
