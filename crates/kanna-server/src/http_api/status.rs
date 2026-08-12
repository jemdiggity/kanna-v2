use super::lan_trust::TrustedLanDeviceAccess;
use super::state::{AppState, TunneledHttpInvoke};
use super::task_files::AuthenticatedTaskFileAccess;
use axum::extract::ConnectInfo;
use axum::extract::State;
use axum::Extension;
use axum::Json;
use std::net::SocketAddr;
use std::sync::Arc;

pub(super) async fn status(
    State(state): State<Arc<AppState>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    trusted_lan_device: Option<Extension<TrustedLanDeviceAccess>>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    authenticated_invoke: Option<Extension<AuthenticatedTaskFileAccess>>,
) -> Result<Json<crate::mobile_api::MobileServerStatus>, (axum::http::StatusCode, String)> {
    let mut status = state.mobile_server_status().await;
    let direct_local = tunneled.is_none()
        && peer
            .as_ref()
            .is_none_or(|Extension(ConnectInfo(peer))| peer.ip().is_loopback());
    let authenticated_relay = tunneled.is_some() && authenticated_invoke.is_some();
    if !direct_local && trusted_lan_device.is_none() && !authenticated_relay {
        // Pre-capability-routing mobile builds interpret a running LAN status
        // as permission to project an account task onto this endpoint. Mark
        // unpaired LAN access unavailable so those clients retain their
        // already-authenticated relay stream instead of opening strict KSP v2
        // without a paired-device credential.
        status.state = "pairing_required".to_string();
    }
    Ok(Json(status))
}
