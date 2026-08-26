use super::lan_trust::TrustedLanDeviceAccess;
use super::state::{AppState, TunneledHttpInvoke};
use crate::pairing::{
    self as pairing_domain, PairingCertificateError, PairingClaimError, PairingClaimRequest,
    PairingClaimResponse, PairingSession, PushPairingMaterial,
};
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use std::net::SocketAddr;
use std::sync::Arc;

pub(super) async fn remove_trusted_device(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(device_id): axum::extract::Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !peer.ip().is_loopback() || tunneled.is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            "trusted devices can only be removed from the desktop app".to_string(),
        ));
    }
    if device_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "device id is required".to_string()));
    }
    match state.remove_trusted_device(&device_id).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err((
            StatusCode::NOT_FOUND,
            "trusted device not found".to_string(),
        )),
        Err(error) => Err((StatusCode::INTERNAL_SERVER_ERROR, error)),
    }
}

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
    let _persistence_mutation = state.pairing_persistence_mutation.lock().await;
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

pub(super) async fn reissue_push_pairing_certificate(
    State(state): State<Arc<AppState>>,
    trusted: Option<Extension<TrustedLanDeviceAccess>>,
) -> Result<Json<PushPairingMaterial>, (StatusCode, String)> {
    let Some(Extension(trusted)) = trusted else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "pairing certificate re-issue requires a paired LAN device".to_string(),
        ));
    };
    let _persistence_mutation = state.pairing_persistence_mutation.lock().await;
    pairing_domain::reissue_push_pairing_certificate(&state.config, trusted.device_id())
        .map(Json)
        .map_err(|error| {
            let status = match error {
                PairingCertificateError::NotPaired => StatusCode::UNAUTHORIZED,
                PairingCertificateError::IdentityChanged => StatusCode::CONFLICT,
                PairingCertificateError::Persistence(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, error.to_string())
        })
}
