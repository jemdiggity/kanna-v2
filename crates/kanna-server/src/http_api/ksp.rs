use super::state::AppState;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::Extension;
use std::net::SocketAddr;
use std::sync::Arc;

pub(super) async fn legacy_ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    // Deployed mobile clients connect to /v1/stream without a device
    // credential. Keep this explicit compatibility lane until the minimum
    // supported mobile version can be raised; authenticated LAN streaming is
    // negotiated through /v2/stream.
    ws.on_upgrade(move |socket| {
        crate::ksp::handle_stream(socket, state, crate::ksp::AuthMode::AllowEmpty)
    })
}

pub(super) async fn ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(peer);
    ws.on_upgrade(move |socket| crate::ksp::handle_stream(socket, state, auth_mode))
}

fn direct_stream_auth_mode(
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> crate::ksp::AuthMode {
    if peer.is_none_or(|Extension(ConnectInfo(peer))| peer.ip().is_loopback()) {
        crate::ksp::AuthMode::AllowEmpty
    } else {
        crate::ksp::AuthMode::RequirePairedDevice
    }
}
