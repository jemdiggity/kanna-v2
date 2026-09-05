use super::lan_trust::TrustedLanDeviceAccess;
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
    trusted_lan_device: Option<Extension<TrustedLanDeviceAccess>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(peer, true, trusted_lan_device.is_some());
    let companion_access = direct_stream_companion_access(trusted_lan_device, auth_mode);
    ws.on_upgrade(move |socket| {
        crate::ksp::handle_stream(socket, state, auth_mode, companion_access)
    })
}

pub(super) async fn ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    trusted_lan_device: Option<Extension<TrustedLanDeviceAccess>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(peer, false, trusted_lan_device.is_some());
    let companion_access = direct_stream_companion_access(trusted_lan_device, auth_mode);
    ws.on_upgrade(move |socket| {
        crate::ksp::handle_stream(socket, state, auth_mode, companion_access)
    })
}

fn direct_stream_auth_mode(
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    legacy_v1: bool,
    paired_at_upgrade: bool,
) -> crate::ksp::AuthMode {
    if peer.is_some_and(|Extension(ConnectInfo(peer))| peer.ip().is_loopback()) {
        crate::ksp::AuthMode::AllowEmpty
    } else if legacy_v1 && paired_at_upgrade {
        // Preserve legacy header/cookie-authenticated readers. They have
        // already proved pairing; empty in-band auth still grants only the
        // existing read-only access, not privileged frames.
        crate::ksp::AuthMode::LegacyReadOnlyOrPaired
    } else {
        // An upgrade alone grants no data access, including on v1. A caller
        // without upgrade-time pairing must prove it in the first Auth frame.
        crate::ksp::AuthMode::RequirePairedDevice
    }
}

/// Companion streams need a verified paired device: upgrade-time device
/// headers or the stream cookie. An in-band paired credential can still earn
/// companion access during `Auth`; a bare loopback stream cannot — the local
/// desktop uses the companion bridge, not KSP, for its own server.
fn direct_stream_companion_access(
    trusted_lan_device: Option<Extension<TrustedLanDeviceAccess>>,
    _auth_mode: crate::ksp::AuthMode,
) -> bool {
    trusted_lan_device.is_some()
}
