use super::state::AppState;
use crate::pairing::{self as pairing_domain, PairingSession};
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

pub(super) async fn create_pairing_session(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PairingSession>, (axum::http::StatusCode, String)> {
    let session = pairing_domain::create_pairing_session(&state.config)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    {
        let mut pairing_session = state.pairing_session.lock().await;
        *pairing_session = Some(session.clone());
    }
    Ok(Json(session))
}
