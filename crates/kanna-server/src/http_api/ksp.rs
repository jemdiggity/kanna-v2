use super::lan_trust::{BrowserOriginatedRequest, LocalControlCredential, TrustedLanDeviceAccess};
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
    browser: Option<Extension<BrowserOriginatedRequest>>,
    local_credential: Option<Extension<LocalControlCredential>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(
        peer,
        true,
        trusted_lan_device.is_some(),
        browser.is_some(),
        local_credential.is_some(),
    );
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
    browser: Option<Extension<BrowserOriginatedRequest>>,
    local_credential: Option<Extension<LocalControlCredential>>,
) -> axum::response::Response {
    let auth_mode = direct_stream_auth_mode(
        peer,
        false,
        trusted_lan_device.is_some(),
        browser.is_some(),
        local_credential.is_some(),
    );
    let companion_access = direct_stream_companion_access(trusted_lan_device, auth_mode);
    ws.on_upgrade(move |socket| {
        crate::ksp::handle_stream(socket, state, auth_mode, companion_access)
    })
}

fn direct_stream_auth_mode(
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    legacy_v1: bool,
    paired_at_upgrade: bool,
    browser_originated: bool,
    local_credential_at_upgrade: bool,
) -> crate::ksp::AuthMode {
    let peer_is_loopback = peer.is_some_and(|Extension(ConnectInfo(peer))| peer.ip().is_loopback());
    if browser_originated && peer_is_loopback && !local_credential_at_upgrade {
        // A browser reaches loopback as easily as the desktop webview does,
        // and a WebSocket upgrade is not a CORS request — nothing in the
        // browser stops a hostile page from opening this stream. It cannot
        // attach a header to the handshake either, so the credential the
        // header middleware would have demanded is proved in the first `auth`
        // frame instead.
        crate::ksp::AuthMode::RequireLocalControlToken
    } else if peer_is_loopback {
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
