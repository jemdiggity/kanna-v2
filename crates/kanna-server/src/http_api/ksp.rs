use super::state::AppState;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::Extension;
use std::net::SocketAddr;
use std::sync::Arc;

pub(super) async fn legacy_ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(peer, true);
    ws.on_upgrade(move |socket| crate::ksp::handle_stream(socket, state, auth_mode))
}

pub(super) async fn ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(peer, false);
    ws.on_upgrade(move |socket| crate::ksp::handle_stream(socket, state, auth_mode))
}

fn direct_stream_auth_mode(
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    legacy_v1: bool,
) -> crate::ksp::AuthMode {
    if peer.is_some_and(|Extension(ConnectInfo(peer))| peer.ip().is_loopback()) {
        crate::ksp::AuthMode::AllowEmpty
    } else if legacy_v1 {
        crate::ksp::AuthMode::LegacyReadOnlyOrPaired
    } else {
        crate::ksp::AuthMode::RequirePairedDevice
    }
}
