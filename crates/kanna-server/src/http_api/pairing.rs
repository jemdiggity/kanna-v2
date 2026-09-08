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

/// Only a device proving its own pairing secret can report its installed build.
pub(super) async fn report_mobile_build(
    State(state): State<Arc<AppState>>,
    trusted: Option<Extension<TrustedLanDeviceAccess>>,
    Json(build): Json<pairing_domain::MobileBuildReport>,
) -> Result<StatusCode, (StatusCode, String)> {
    let Some(Extension(trusted)) = trusted else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "build report requires a paired LAN device".into(),
        ));
    };
    if !matches!(build.environment.as_str(), "dev" | "staging" | "prod")
        || !matches!(build.channel.as_str(), "staging" | "production" | "None")
        || !matches!(
            build.source.as_str(),
            "ota" | "embedded" | "development" | "unknown"
        )
        || [
            &build.runtime_version,
            &build.native_version,
            &build.native_build,
            &build.update_id,
        ]
        .into_iter()
        .flatten()
        .any(|value| {
            value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control)
        })
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "invalid mobile build report".into(),
        ));
    }
    let _mutation = state.pairing_persistence_mutation.lock().await;
    let path = std::path::Path::new(&state.config.pairing_store_path);
    let mut store = pairing_domain::PairingStore::load(path)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let device = store
        .trusted_devices
        .get_mut(&state.config.desktop_id)
        .and_then(|devices| {
            devices
                .iter_mut()
                .find(|device| device.device_id == trusted.device_id())
        })
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "device is no longer paired".into(),
        ))?;
    device.mobile_build = Some(pairing_domain::MobileBuildObservation {
        build,
        reported_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    });
    store
        .save(path)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Explicit projection: never return pairing secrets or push credentials.
pub(super) async fn mobile_builds(
    _access: super::lan_trust::DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store =
        pairing_domain::PairingStore::load(std::path::Path::new(&state.config.pairing_store_path))
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let devices: Vec<_> = store
        .trusted_devices
        .get(&state.config.desktop_id)
        .into_iter()
        .flatten()
        .map(|device| {
            serde_json::json!({
                "deviceId": device.device_id,
                "deviceName": device.device_name,
                "build": device.mobile_build,
            })
        })
        .collect();
    Ok(Json(
        serde_json::json!({"desktopId": state.config.desktop_id, "devices": devices}),
    ))
}
