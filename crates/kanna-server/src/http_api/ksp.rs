use super::state::AppState;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::Extension;
use std::net::SocketAddr;
use std::sync::Arc;

/// Compatibility endpoint for deployed mobile builds predating paired-device
/// stream credentials. New clients use `/v2/stream`; keep this epoch stable
/// until the minimum supported mobile version has crossed the migration.
pub(super) async fn legacy_ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| {
        crate::ksp::handle_stream(socket, state, crate::ksp::AuthMode::AllowEmpty)
    })
}

pub(super) async fn ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> axum::response::Response {
    let auth_mode = if peer.is_none_or(|Extension(ConnectInfo(peer))| peer.ip().is_loopback()) {
        crate::ksp::AuthMode::AllowEmpty
    } else {
        crate::ksp::AuthMode::RequirePairedDevice
    };
    ws.on_upgrade(move |socket| crate::ksp::handle_stream(socket, state, auth_mode))
}
