use super::state::{AppState, AuthenticatedHttpInvoke, TunneledHttpInvoke};
use crate::pairing::PairingStore;
use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::header::{AUTHORIZATION, COOKIE, SET_COOKIE};
use axum::http::HeaderValue;
use axum::http::{request::Parts, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const DEVICE_ID_HEADER: &str = "x-kanna-device-id";
pub(super) const DEVICE_SECRET_HEADER: &str = "x-kanna-device-secret";
const STREAM_COOKIE_NAME: &str = "kanna_lan_stream";
const STREAM_COOKIE_TTL_SECONDS: u64 = 5 * 60;

/// Marker inserted when a genuine LAN request presented a paired device's
/// id + secret and the secret verified against the pairing store.
#[derive(Debug, Clone)]
pub(super) struct TrustedLanDeviceAccess {
    device_id: String,
}

impl TrustedLanDeviceAccess {
    pub(super) fn device_id(&self) -> &str {
        &self.device_id
    }
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

/// Whether a task-event request may use this desktop's authenticated relay
/// session to fan out across the account. A loopback address is deliberately
/// insufficient because a rebound browser origin can reach it; callers need
/// the owner-only local bearer credential or an already-paired device marker.
/// This never rejects the request: unauthenticated callers retain the native
/// local-only event feed.
#[derive(Debug, Clone, Copy)]
pub(super) struct AccountWideTaskEventAccess(bool);

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

impl FromRequestParts<Arc<AppState>> for AccountWideTaskEventAccess {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let bearer = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().strip_prefix("Bearer "));
        let local_credential_matches = bearer
            .zip(state.local_task_events_token.as_deref())
            .is_some_and(|(presented, expected)| secret_matches(presented, expected));
        let paired_device = parts.extensions.get::<TrustedLanDeviceAccess>().is_some();
        Ok(Self(local_credential_matches || paired_device))
    }
}

impl AccountWideTaskEventAccess {
    pub(super) fn is_authorized(self) -> bool {
        self.0
    }
}

fn secret_matches(presented: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};

    Sha256::digest(presented.as_bytes()) == Sha256::digest(expected.as_bytes())
}

pub(super) fn load_or_create_task_events_token(path: &Path) -> Result<String, String> {
    match read_task_events_token(path) {
        Ok(token) => return Ok(token),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(format!("failed to read {}: {error}", path.display()));
        }
        Err(_) => {}
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("credential path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let token = generate_task_events_token()?;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    match options.open(path) {
        Ok(mut file) => {
            if let Err(error) = file
                .write_all(format!("{token}\n").as_bytes())
                .and_then(|_| file.sync_all())
            {
                drop(file);
                let _ = std::fs::remove_file(path);
                return Err(format!("failed to write {}: {error}", path.display()));
            }
            Ok(token)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_task_events_token(path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))
        }
        Err(error) => Err(format!("failed to create {}: {error}", path.display())),
    }
}

fn read_task_events_token(path: &Path) -> Result<String, std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "credential is not a regular file",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "credential must not grant group or other permissions",
        ));
    }
    let token = std::fs::read_to_string(path)?.trim().to_string();
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "credential must contain a 32-byte hexadecimal token",
        ));
    }
    Ok(token)
}

fn generate_task_events_token() -> Result<String, String> {
    use std::io::Read;

    let mut bytes = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|error| format!("failed to read operating-system randomness: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn unauthorized_privileged_task() -> (StatusCode, String) {
    (
        StatusCode::UNAUTHORIZED,
        "privileged control requires desktop loopback, a paired LAN device, or an authenticated relay".into(),
    )
}

#[derive(Debug, Deserialize, Serialize)]
struct LanStreamClaims {
    device_id: String,
    desktop_id: String,
    exp: u64,
}

pub(super) async fn attach_trusted_lan_device(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    // Tunneled (relay/KSP) dispatches synthesize their requests; device
    // headers are only meaningful on the real LAN listener.
    let mut compatibility_cookie = None;
    if request.extensions().get::<TunneledHttpInvoke>().is_none() {
        let device_id = header_value(&request, DEVICE_ID_HEADER);
        let device_secret = header_value(&request, DEVICE_SECRET_HEADER);
        if let (Some(device_id), Some(device_secret)) = (device_id, device_secret) {
            let config = state.config();
            if let Ok(store) = PairingStore::load(Path::new(&config.pairing_store_path)) {
                if store.verify_device_secret(&config.desktop_id, &device_id, &device_secret) {
                    request.extensions_mut().insert(TrustedLanDeviceAccess {
                        device_id: device_id.clone(),
                    });
                    compatibility_cookie = issue_stream_cookie(config, &device_id);
                }
            }
        } else if let Some(device_id) = stream_cookie_device(&request, state.config()) {
            request
                .extensions_mut()
                .insert(TrustedLanDeviceAccess { device_id });
        }
    }
    let mut response = next.run(request).await;
    if let Some(cookie) =
        compatibility_cookie.and_then(|cookie| HeaderValue::from_str(&cookie).ok())
    {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    response
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

fn issue_stream_cookie(config: &crate::config::Config, device_id: &str) -> Option<String> {
    let signing_secret = stream_cookie_signing_secret(config)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let claims = LanStreamClaims {
        device_id: device_id.to_string(),
        desktop_id: config.desktop_id.clone(),
        exp: now.saturating_add(STREAM_COOKIE_TTL_SECONDS),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(signing_secret.as_bytes()),
    )
    .ok()?;
    Some(format!(
        "{STREAM_COOKIE_NAME}={token}; Path=/v1/stream; Max-Age={STREAM_COOKIE_TTL_SECONDS}; HttpOnly; SameSite=Strict"
    ))
}

fn stream_cookie_device(request: &Request<Body>, config: &crate::config::Config) -> Option<String> {
    let signing_secret = stream_cookie_signing_secret(config)?;
    let token = request
        .headers()
        .get(COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|cookie| cookie.strip_prefix(&format!("{STREAM_COOKIE_NAME}=")))?;
    let claims = decode::<LanStreamClaims>(
        token,
        &DecodingKey::from_secret(signing_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .ok()?
    .claims;
    if claims.desktop_id != config.desktop_id {
        return None;
    }
    let store = PairingStore::load(Path::new(&config.pairing_store_path)).ok()?;
    store
        .is_trusted(&config.desktop_id, &claims.device_id)
        .then_some(claims.device_id)
}

fn stream_cookie_signing_secret(config: &crate::config::Config) -> Option<&str> {
    config
        .desktop_secret
        .as_deref()
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
        .or_else(|| {
            let token = config.device_token.trim();
            (!token.is_empty()).then_some(token)
        })
}
