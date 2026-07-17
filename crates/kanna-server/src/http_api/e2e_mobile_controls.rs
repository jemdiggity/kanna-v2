use super::state::{AppState, TunneledHttpInvoke};
use axum::extract::{ConnectInfo, State};
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

const CONTROL_PATH: &str = "/v1/e2e/mobile-machine-controls";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E2eMobileMachineControlsRequest {
    expire_pairing_session: Option<bool>,
    lan_http_enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E2eMobileMachineControlsResponse {
    lan_http_enabled: bool,
    pairing_session_expired: bool,
}

pub(super) async fn update_e2e_mobile_machine_controls(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    tunneled: Option<axum::Extension<TunneledHttpInvoke>>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<E2eMobileMachineControlsRequest>,
) -> Result<Json<E2eMobileMachineControlsResponse>, (StatusCode, String)> {
    require_local_e2e_access(peer, tunneled.is_some())?;

    if let Some(enabled) = request.lan_http_enabled {
        state.e2e_lan_http_enabled.store(enabled, Ordering::SeqCst);
    }

    let mut pairing_session_expired = false;
    if request.expire_pairing_session == Some(true) {
        let mut active = state.pairing_session.lock().await;
        if let Some(active) = active.as_mut() {
            active.session.expires_at_unix_ms = 0;
            pairing_session_expired = true;
        }
    }

    Ok(Json(E2eMobileMachineControlsResponse {
        lan_http_enabled: state.e2e_lan_http_enabled.load(Ordering::SeqCst),
        pairing_session_expired,
    }))
}

pub(super) async fn gate_direct_lan_http(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let direct_lan_disabled = e2e_controls_enabled()
        && !state.e2e_lan_http_enabled.load(Ordering::SeqCst)
        && request.uri().path() != CONTROL_PATH
        && request.extensions().get::<TunneledHttpInvoke>().is_none();
    if direct_lan_disabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "direct LAN HTTP is disabled by the E2E harness",
        )
            .into_response();
    }
    next.run(request).await
}

fn require_local_e2e_access(peer: SocketAddr, tunneled: bool) -> Result<(), (StatusCode, String)> {
    if !e2e_controls_enabled() {
        return Err((StatusCode::NOT_FOUND, "not found".to_string()));
    }
    if !peer.ip().is_loopback() || tunneled {
        return Err((
            StatusCode::FORBIDDEN,
            "E2E mobile controls are only available over direct loopback HTTP".to_string(),
        ));
    }
    Ok(())
}

fn e2e_controls_enabled() -> bool {
    std::env::var("KANNA_E2E_TEST_SQL").ok().as_deref() == Some("1")
}
