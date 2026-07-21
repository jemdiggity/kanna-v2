use super::state::{AppState, TunneledHttpInvoke};
use crate::pairing::PairingStore;
use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::middleware::Next;
use axum::response::Response;
use std::path::Path;
use std::sync::Arc;

pub(super) const DEVICE_ID_HEADER: &str = "x-kanna-device-id";
pub(super) const DEVICE_SECRET_HEADER: &str = "x-kanna-device-secret";

/// Marker inserted when a genuine LAN request presented a paired device's
/// id + secret and the secret verified against the pairing store.
#[derive(Debug, Clone, Copy)]
pub(super) struct TrustedLanDeviceAccess;

pub(super) async fn attach_trusted_lan_device(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    // Tunneled (relay/KSP) dispatches synthesize their requests; device
    // headers are only meaningful on the real LAN listener.
    if request.extensions().get::<TunneledHttpInvoke>().is_none() {
        let device_id = header_value(&request, DEVICE_ID_HEADER);
        let device_secret = header_value(&request, DEVICE_SECRET_HEADER);
        if let (Some(device_id), Some(device_secret)) = (device_id, device_secret) {
            let config = state.config();
            if let Ok(store) = PairingStore::load(Path::new(&config.pairing_store_path)) {
                if store.verify_device_secret(&config.desktop_id, &device_id, &device_secret) {
                    request.extensions_mut().insert(TrustedLanDeviceAccess);
                }
            }
        }
    }
    next.run(request).await
}

fn header_value(request: &Request<Body>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
