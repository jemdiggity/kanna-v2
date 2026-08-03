use super::state::{
    AppState, AuthenticatedHttpInvoke, AuthenticatedHumanHttpInvoke, TunneledHttpInvoke,
};
use crate::pairing::PairingStore;
use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::{request::Parts, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::path::Path;
use std::sync::Arc;

pub(super) const DEVICE_ID_HEADER: &str = "x-kanna-device-id";
pub(super) const DEVICE_SECRET_HEADER: &str = "x-kanna-device-secret";
pub(super) const HUMAN_ACTION_HEADER: &str = "x-kanna-human-action";
pub(super) const APPROVAL_OVERRIDE_ACTION: &str = "approval-override";

/// Marker inserted when a genuine LAN request presented a paired device's
/// id + secret and the secret verified against the pairing store.
#[derive(Debug, Clone, Copy)]
pub(super) struct TrustedLanDeviceAccess;

#[derive(Debug, Clone)]
struct TrustedLanDeviceIdentity(String);

/// Deliberate human authority for approval overrides. This extractor is not
/// used by ordinary advance routes. Native desktop overrides use the
/// peer-authenticated Unix control channel; HTTP accepts only a paired LAN
/// device or a relay-authenticated human account.
#[derive(Debug, Clone)]
pub(super) struct HumanApprovalOverrideAccess {
    pub(super) actor: String,
    pub(super) channel: String,
}

/// Authorization extractor for privileged task controls.
///
/// Production listener requests always carry `ConnectInfo`. A missing peer is
/// accepted only for in-process router tests and callers; tunneled requests
/// must still carry the explicit authenticated marker, so a synthesized
/// loopback address can never elevate an unauthenticated tunnel.
#[derive(Debug, Clone, Copy)]
pub(super) struct PrivilegedTaskAccess;

/// Authority reserved for the desktop process talking to its own real HTTP
/// listener. Unlike ordinary privileged controls, paired LAN devices and
/// authenticated tunnels cannot satisfy this extractor.
#[derive(Debug, Clone, Copy)]
pub(super) struct DesktopLocalAccess;

impl FromRequestParts<Arc<AppState>> for PrivilegedTaskAccess {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        privileged_task_access(&parts.extensions)
    }
}

impl FromRequestParts<Arc<AppState>> for DesktopLocalAccess {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        if parts.extensions.get::<TunneledHttpInvoke>().is_none()
            && parts
                .extensions
                .get::<ConnectInfo<std::net::SocketAddr>>()
                .is_some_and(|ConnectInfo(peer)| peer.ip().is_loopback())
        {
            return Ok(Self);
        }
        Err((
            StatusCode::UNAUTHORIZED,
            "control requires a direct desktop loopback connection".into(),
        ))
    }
}

impl FromRequestParts<Arc<AppState>> for HumanApprovalOverrideAccess {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        privileged_task_access(&parts.extensions)?;

        if let Some(identity) = parts.extensions.get::<AuthenticatedHumanHttpInvoke>() {
            return Ok(Self {
                actor: identity.actor.clone(),
                channel: identity.channel.clone(),
            });
        }
        if parts.extensions.get::<TunneledHttpInvoke>().is_some() {
            return Err((
                StatusCode::UNAUTHORIZED,
                "approval override requires an authenticated human channel".into(),
            ));
        }
        let deliberate = parts
            .headers
            .get(HUMAN_ACTION_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == APPROVAL_OVERRIDE_ACTION);
        if !deliberate {
            return Err((
                StatusCode::BAD_REQUEST,
                "approval override requires an explicit human action".into(),
            ));
        }
        if let Some(identity) = parts.extensions.get::<TrustedLanDeviceIdentity>() {
            return Ok(Self {
                actor: identity.0.clone(),
                channel: "paired_lan_device".into(),
            });
        }
        Err((
            StatusCode::UNAUTHORIZED,
            "desktop approval override requires the native control channel".into(),
        ))
    }
}

fn unauthorized_privileged_task() -> (StatusCode, String) {
    (
        StatusCode::UNAUTHORIZED,
        "privileged control requires desktop loopback, a paired LAN device, or an authenticated relay".into(),
    )
}

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
                    request
                        .extensions_mut()
                        .insert(TrustedLanDeviceIdentity(device_id));
                }
            }
        }
    }
    next.run(request).await
}

pub(super) async fn require_privileged_task_access(request: Request<Body>, next: Next) -> Response {
    if is_privileged_task_route(request.method(), request.uri().path())
        && privileged_task_access(request.extensions()).is_err()
    {
        return unauthorized_privileged_task().into_response();
    }
    next.run(request).await
}

fn is_privileged_task_route(method: &axum::http::Method, path: &str) -> bool {
    if path == "/v1/cloud/relay/actions/reconnect" {
        return method != axum::http::Method::OPTIONS;
    }
    if path == "/v1/transfers" || path.starts_with("/v1/transfers/") {
        return method != axum::http::Method::OPTIONS;
    }
    if path != "/v1/tasks" && !path.starts_with("/v1/tasks/") {
        return false;
    }
    method != axum::http::Method::GET
        && method != axum::http::Method::HEAD
        && method != axum::http::Method::OPTIONS
}

fn privileged_task_access(
    extensions: &axum::http::Extensions,
) -> Result<PrivilegedTaskAccess, (StatusCode, String)> {
    if extensions.get::<TunneledHttpInvoke>().is_some() {
        return extensions
            .get::<AuthenticatedHttpInvoke>()
            .map(|_| PrivilegedTaskAccess)
            .ok_or_else(unauthorized_privileged_task);
    }
    if extensions.get::<TrustedLanDeviceAccess>().is_some()
        || extensions
            .get::<ConnectInfo<std::net::SocketAddr>>()
            .is_none_or(|ConnectInfo(peer)| peer.ip().is_loopback())
    {
        return Ok(PrivilegedTaskAccess);
    }
    Err(unauthorized_privileged_task())
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
