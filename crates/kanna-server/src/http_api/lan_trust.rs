use super::state::{AppState, AuthenticatedHttpInvoke, TunneledHttpInvoke};
use crate::pairing::PairingStore;
use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::header::{
    ACCESS_CONTROL_REQUEST_METHOD, AUTHORIZATION, CONNECTION, COOKIE, HOST, SET_COOKIE, UPGRADE,
};
use axum::http::{request::Parts, Request, StatusCode};
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const DEVICE_ID_HEADER: &str = "x-kanna-device-id";
pub(super) const DEVICE_SECRET_HEADER: &str = "x-kanna-device-secret";
/// Header a local non-browser client may use instead of `Authorization` when
/// that one is already spent on something else.
pub(super) const LOCAL_CREDENTIAL_HEADER: &str = "x-kanna-local-token";
/// Headers a browser attaches to every request it makes and that page script
/// cannot set (both are forbidden header names). Their presence is what marks
/// a request as browser-originated; see `browser_originated`.
const FETCH_METADATA_HEADERS: [&str; 4] = [
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
];
/// KSP upgrade paths. A browser cannot attach a header to a WebSocket
/// handshake, so these authenticate in-band instead — see `http_api::ksp`.
const STREAM_UPGRADE_PATHS: [&str; 2] = ["/v1/stream", "/v2/stream"];
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

/// Marker inserted when a request on the real listener presented this
/// desktop's local control credential. It is the only authority a browser can
/// hold here, because a cross-origin page cannot read the credential file.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LocalControlCredential;

/// Marker inserted when a request on the real listener is browser-originated:
/// it carried an `Origin` or a `Sec-Fetch-*` header, both of which a browser
/// sets itself and page script cannot forge.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BrowserOriginatedRequest;

/// Whether a browser made this request.
///
/// `Origin` is attached to every cross-origin fetch/XHR and to every
/// non-simple request; the `Sec-Fetch-*` set is attached to *every* request by
/// Chrome 76+, Firefox 90+ and Safari 16.4+. Both are forbidden header names,
/// so no page can suppress or spoof them. A local process client (the CLI, the
/// MCP server, a sidecar, `curl`) sends neither.
pub(crate) fn browser_originated(headers: &HeaderMap) -> bool {
    headers.contains_key(axum::http::header::ORIGIN)
        || FETCH_METADATA_HEADERS
            .iter()
            .any(|name| headers.contains_key(*name))
}

/// Whether the request presented this desktop's local control credential.
fn presented_local_credential(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.local_task_events_token.as_deref() else {
        return false;
    };
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().strip_prefix("Bearer "))
        .map(str::trim);
    let explicit = headers
        .get(LOCAL_CREDENTIAL_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    [bearer, explicit]
        .into_iter()
        .flatten()
        .filter(|presented| !presented.is_empty())
        .any(|presented| secret_matches(presented, expected))
}

/// The host a loopback caller addressed, lowercased and without its port.
///
/// Prefers the `Host` header (HTTP/1.1) and falls back to the URI authority
/// (HTTP/2 `:authority`). `None` means the request named no host at all.
fn requested_host(request: &Request<Body>) -> Option<String> {
    let raw = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| request.uri().authority().map(|a| a.as_str().to_string()))?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    // `[::1]:48120` keeps its brackets around the colons; everything else
    // loses a single trailing `:port`.
    let host = match raw.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => raw.split(':').next().unwrap_or(raw),
    };
    let host = host.trim_end_matches('.');
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether a loopback caller addressed this server by an address rather than a
/// name it could have been rebound to.
///
/// DNS rebinding is the one browser attack that leaves no `Origin` to inspect:
/// the page at `http://attacker.example` re-resolves that name to `127.0.0.1`,
/// so its own fetches are *same-origin* and carry neither `Origin` nor a
/// cross-site `Sec-Fetch-Site`. What the rebound request cannot change is the
/// `Host` it must send, which still names the attacker's domain. An IP literal
/// or `localhost` cannot be rebound, so those are the only hosts a loopback
/// caller may use.
fn loopback_host_is_addressable(host: &str) -> bool {
    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok()
}

fn rejected(status: StatusCode, message: &str, request: &Request<Body>) -> Response {
    log::warn!(
        "{} {} rejected at the local-client boundary: {message}",
        request.method(),
        request.uri().path()
    );
    (status, message.to_string()).into_response()
}

/// The browser/local-client authority boundary for the real LAN listener.
///
/// Everything reaching `kanna-server` over loopback used to be privileged by
/// its peer address alone, which is exactly what a web page the user happens
/// to open can reach. This classifies each request instead:
///
/// - **Tunneled** dispatches (relay, KSP) synthesize their own requests and
///   carry their own authenticated marker; they never pass through here.
/// - **Browser-originated** requests must present the local control
///   credential. A cross-origin page cannot read it, so it cannot forge one.
///   The KSP upgrade paths are the exception, because a browser cannot attach
///   a header to a WebSocket handshake — they prove the same credential in
///   band instead (`http_api::ksp`).
/// - **Local process** requests (no `Origin`, no `Sec-Fetch-*`) keep today's
///   loopback authority. A process running as the user already holds it: it
///   can read the credential file, the database, and every worktree. Making
///   the CLI, the MCP server, the sidecars and every running agent present a
///   token would be a migration, not a boundary.
/// - A **CORS preflight** carries no credential and grants none, so it passes
///   through to the CORS layer; the request it precedes is still classified.
pub(super) async fn require_local_client_authority(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if request.extensions().get::<TunneledHttpInvoke>().is_some() {
        return next.run(request).await;
    }

    let peer_is_loopback = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .is_none_or(|ConnectInfo(peer)| peer.ip().is_loopback());
    let from_browser = browser_originated(request.headers());

    // A caller that omits `Host` entirely is not a browser — every browser
    // sends it, on every request, and page script cannot suppress it — so
    // omitting it buys a rebound page nothing. Hyper does serve such a
    // request, and it stays in the local-process class below, which a local
    // process was already in.
    if peer_is_loopback {
        if let Some(host) = requested_host(&request) {
            if !loopback_host_is_addressable(&host) {
                return rejected(
                    StatusCode::FORBIDDEN,
                    "loopback requests must address this server by IP or localhost",
                    &request,
                );
            }
        }
    }

    let has_credential = presented_local_credential(&state, request.headers());
    if has_credential {
        request.extensions_mut().insert(LocalControlCredential);
    }
    // A device that proved its pairing secret carries that device's authority
    // whatever client shape it arrives in; pairing, not the address or the
    // absence of an `Origin`, is what a hostile page cannot obtain.
    let paired_device = request
        .extensions()
        .get::<TrustedLanDeviceAccess>()
        .is_some();
    if from_browser {
        request.extensions_mut().insert(BrowserOriginatedRequest);
        if !has_credential
            && !paired_device
            && !is_cors_preflight(&request)
            && !is_stream_upgrade(&request)
        {
            return rejected(
                StatusCode::FORBIDDEN,
                "browser requests must present this desktop's local control credential or a paired device secret",
                &request,
            );
        }
    }

    next.run(request).await
}

/// A preflight asks what a later request would be allowed to do. It carries no
/// credential, and the answer authorizes nothing on its own — the request it
/// precedes is classified like any other.
///
/// The CORS layer is mounted *inside* this one (see `router`), so a preflight
/// does reach here and must be let through to it.
fn is_cors_preflight(request: &Request<Body>) -> bool {
    request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(ACCESS_CONTROL_REQUEST_METHOD)
}

fn is_stream_upgrade(request: &Request<Body>) -> bool {
    STREAM_UPGRADE_PATHS.contains(&request.uri().path())
        && header_contains_token(request.headers(), &CONNECTION, "upgrade")
        && header_contains_token(request.headers(), &UPGRADE, "websocket")
}

fn header_contains_token(
    headers: &HeaderMap,
    name: &axum::http::header::HeaderName,
    token: &str,
) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
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

pub(super) async fn require_http_access(request: Request<Body>, next: Next) -> Response {
    // Deny by default, including GET/HEAD and preflight. Only discovery and
    // authentication bootstrap may run before the caller proves pairing.
    let path = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map_or(request.uri().path(), |path| path.as_str());
    let bootstrap = matches!(
        (request.method().as_str(), path),
        ("GET" | "HEAD", "/v1/status" | "/v1/stream" | "/v2/stream")
            | ("POST", "/v1/pairing/sessions/claim")
    );
    if !bootstrap && privileged_task_access(request.extensions()).is_err() {
        return unauthorized_privileged_task().into_response();
    }
    next.run(request).await
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host_of(raw: &str) -> Option<String> {
        let request = Request::builder()
            .uri("/v1/repos")
            .header(HOST, raw)
            .body(Body::empty())
            .expect("build request");
        requested_host(&request)
    }

    #[test]
    fn the_addressed_host_drops_its_port_and_case() {
        assert_eq!(host_of("127.0.0.1:48120").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_of("LocalHost:48120").as_deref(), Some("localhost"));
        assert_eq!(host_of("localhost").as_deref(), Some("localhost"));
        // A trailing dot is the fully-qualified spelling of the same name.
        assert_eq!(host_of("localhost.:48120").as_deref(), Some("localhost"));
        // IPv6 literals keep the colons inside their brackets.
        assert_eq!(host_of("[::1]:48120").as_deref(), Some("::1"));
        assert_eq!(host_of("[::1]").as_deref(), Some("::1"));
        assert_eq!(host_of("  ").as_deref(), None);
    }

    #[test]
    fn only_addresses_and_localhost_are_addressable_from_loopback() {
        for host in ["127.0.0.1", "0.0.0.0", "::1", "localhost", "192.168.1.42"] {
            assert!(
                loopback_host_is_addressable(host),
                "{host} cannot be rebound and must stay addressable"
            );
        }
        // Every one of these is a name a hostile page could point at 127.0.0.1.
        for host in [
            "attacker.example",
            "kanna.attacker.example",
            "localtest.me",
            "localhost.attacker.example",
            "studio.local",
            "127.0.0.1.attacker.example",
        ] {
            assert!(
                !loopback_host_is_addressable(host),
                "{host} is a DNS name and must be refused"
            );
        }
    }

    #[test]
    fn a_browser_is_recognised_by_headers_it_cannot_suppress() {
        let browser_headers = [
            ("origin", "https://attacker.example"),
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-mode", "cors"),
            ("sec-fetch-dest", "empty"),
            ("sec-fetch-user", "?1"),
        ];
        for (name, value) in browser_headers {
            let mut headers = HeaderMap::new();
            headers.insert(name, HeaderValue::from_static(value));
            assert!(
                browser_originated(&headers),
                "{name} must mark a request as a browser's"
            );
        }

        // What a local process client sends. `Referer` and `User-Agent` are
        // deliberately not in the set: both are settable by any client, so
        // treating them as proof would refuse ordinary tooling.
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", HeaderValue::from_static("kanna-cli/0.0.0"));
        headers.insert("accept", HeaderValue::from_static("application/json"));
        assert!(!browser_originated(&headers));
    }
}
