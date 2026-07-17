use super::state::{AppState, TunneledHttpInvoke};
use crate::pairing::{
    self as pairing_domain, PairingClaimError, PairingClaimRequest, PairingClaimResponse,
    PairingSession,
};
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use std::net::SocketAddr;
use std::sync::Arc;

pub(super) async fn create_pairing_session(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PairingSession>, (axum::http::StatusCode, String)> {
    if !peer.ip().is_loopback() || tunneled.is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            "pairing sessions can only be started from the desktop app".to_string(),
        ));
    }
    let active = pairing_domain::create_active_pairing_session(&state.config)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let session = active.session.clone();
    {
        let mut pairing_session = state.pairing_session.lock().await;
        *pairing_session = Some(active);
    }
    Ok(Json(session))
}

pub(super) async fn claim_pairing_session(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PairingClaimRequest>,
) -> Result<Json<PairingClaimResponse>, (StatusCode, String)> {
    let mut active = state.pairing_session.lock().await;
    pairing_domain::claim_pairing_session(&state.config, &mut active, request)
        .map(Json)
        .map_err(|error| {
            let status = match error {
                PairingClaimError::InvalidRequest | PairingClaimError::InvalidCode => {
                    StatusCode::BAD_REQUEST
                }
                PairingClaimError::Expired => StatusCode::GONE,
                PairingClaimError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
                PairingClaimError::NoActiveSession => StatusCode::CONFLICT,
                PairingClaimError::Persistence(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, error.to_string())
        })
}
