use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use super::task_blockers::resolve_existing_task_id;
use crate::db::Db;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{
    CONNECTION, CONTENT_LENGTH, COOKIE, FORWARDED, HOST, LOCATION, ORIGIN, SET_COOKIE, UPGRADE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use futures_util::StreamExt as _;
use http_body_util::Limited;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::HashMap;
use std::io::Read as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex, Semaphore};

const ENTER_PATH: &str = "/__kanna_preview__/enter";
const RESERVED_PATH_PREFIX: &str = "/__kanna_preview__/";
const COOKIE_NAME: &str = "kanna_preview";
const IDLE_TTL: Duration = Duration::from_secs(30 * 60);
const HARD_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 16;

type PreviewKey = (String, String);

#[derive(Clone, Default)]
pub(super) struct PreviewSessions {
    sessions: Arc<Mutex<HashMap<PreviewKey, PreviewHandle>>>,
}

struct PreviewHandle {
    generation: String,
    cancel: oneshot::Sender<()>,
}

impl PreviewSessions {
    async fn replace(&self, key: PreviewKey, generation: String, cancel: oneshot::Sender<()>) {
        if let Some(previous) = self
            .sessions
            .lock()
            .await
            .insert(key, PreviewHandle { generation, cancel })
        {
            let _ = previous.cancel.send(());
        }
    }

    async fn remove_if_current(&self, key: &PreviewKey, generation: &str) {
        let mut sessions = self.sessions.lock().await;
        if sessions
            .get(key)
            .is_some_and(|handle| handle.generation == generation)
        {
            sessions.remove(key);
        }
    }

    pub(super) async fn revoke_task(&self, task_id: &str) {
        let mut sessions = self.sessions.lock().await;
        let keys = sessions
            .keys()
            .filter(|(candidate, _)| candidate == task_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(handle) = sessions.remove(&key) {
                let _ = handle.cancel.send(());
            }
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenPreviewRequest {
    port_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPortStatus {
    name: String,
    port: u16,
    listening: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenPreviewResponse {
    port: u16,
    port_name: String,
    enter_path: String,
    expires_at: u64,
    ports: Vec<PreviewPortStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRefusal {
    reason: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    ports: Vec<PreviewPortStatus>,
}

struct PreviewSelection {
    task_id: String,
    worktree_path: String,
    port_name: String,
    port: u16,
    ports: Vec<(String, u16)>,
}

struct PreviewSession {
    db_path: String,
    task_id: String,
    worktree_path: String,
    port_name: String,
    upstream_port: u16,
    enter_secret: String,
    enter_consumed: AtomicBool,
    cookie_value: String,
    hard_expires_at: u64,
    last_activity: AtomicU64,
    last_validated: AtomicU64,
    connections: Arc<Semaphore>,
}

pub(super) async fn open_task_preview(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(payload): Json<OpenPreviewRequest>,
) -> Response {
    let selection = match load_preview_selection(&state, task_id, payload.port_name).await {
        Ok(selection) => selection,
        Err(response) => return response,
    };

    let mut ports = Vec::with_capacity(selection.ports.len());
    for (name, port) in &selection.ports {
        ports.push(PreviewPortStatus {
            name: name.clone(),
            port: *port,
            listening: probe_port(*port).await,
        });
    }
    if !ports
        .iter()
        .any(|candidate| candidate.name == selection.port_name && candidate.listening)
    {
        return (
            StatusCode::CONFLICT,
            Json(PreviewRefusal {
                reason: "not_listening",
                message: format!(
                    "Nothing is listening on {} ({}).",
                    selection.port_name, selection.port
                ),
                ports,
            }),
        )
            .into_response();
    }

    let listener = match TcpListener::bind((state.config.lan_host.as_str(), 0)).await {
        Ok(listener) => listener,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to bind task preview listener: {error}"),
            )
                .into_response();
        }
    };
    let listener_port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to inspect task preview listener: {error}"),
            )
                .into_response();
        }
    };
    let enter_secret = match random_hex_128() {
        Ok(secret) => secret,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    };
    let cookie_value = match random_hex_128() {
        Ok(secret) => secret,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    };
    let now = unix_seconds();
    let hard_expires_at = now.saturating_add(HARD_TTL.as_secs());
    let session = Arc::new(PreviewSession {
        db_path: state.config.db_path.clone(),
        task_id: selection.task_id.clone(),
        worktree_path: selection.worktree_path,
        port_name: selection.port_name.clone(),
        upstream_port: selection.port,
        enter_secret: enter_secret.clone(),
        enter_consumed: AtomicBool::new(false),
        cookie_value,
        hard_expires_at,
        last_activity: AtomicU64::new(now),
        // Force the first navigation to re-check the task after listener
        // setup; the task may have closed or changed workspaces while the
        // listener was being bound.
        last_validated: AtomicU64::new(0),
        connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
    });
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let preview_key = (selection.task_id.clone(), selection.port_name.clone());
    state
        .preview_sessions
        .replace(preview_key.clone(), enter_secret.clone(), cancel_tx)
        .await;

    let listener_session = Arc::clone(&session);
    let listener_sessions = state.preview_sessions.clone();
    let listener_generation = enter_secret.clone();
    tokio::spawn(async move {
        let app = Router::new()
            .route("/{*path}", any(proxy_preview_request))
            .route("/", any(proxy_preview_request))
            .with_state(Arc::clone(&listener_session));
        let idle_session = Arc::clone(&listener_session);
        let shutdown = async move {
            tokio::select! {
                _ = cancel_rx => {},
                _ = wait_for_expiry(idle_session) => {},
            }
        };
        if let Err(error) = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await
        {
            log::warn!("task preview listener stopped with an error: {error}");
        }
        listener_sessions
            .remove_if_current(&preview_key, &listener_generation)
            .await;
    });

    Json(OpenPreviewResponse {
        port: listener_port,
        port_name: selection.port_name,
        enter_path: format!("{ENTER_PATH}?t={enter_secret}"),
        expires_at: hard_expires_at.saturating_mul(1000),
        ports,
    })
    .into_response()
}

pub(super) async fn close_task_preview(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Response {
    let resolved = {
        let db = match Db::open(&state.config.db_path) {
            Ok(db) => db,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {error}"),
                )
                    .into_response();
            }
        };
        match resolve_existing_task_id(&db, &task_id) {
            Ok(task_id) => task_id,
            Err(error) => return error.into_response(),
        }
    };
    state.preview_sessions.revoke_task(&resolved).await;
    StatusCode::NO_CONTENT.into_response()
}

async fn load_preview_selection(
    state: &Arc<AppState>,
    task_id: String,
    port_name: Option<String>,
) -> Result<PreviewSelection, Response> {
    let db = Db::open(&state.config.db_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
            .into_response()
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id).map_err(IntoResponse::into_response)?;
    let item = db
        .get_pipeline_item(&task_id)
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
                .into_response()
        })?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "task not found").into_response())?;
    if item.closed_at.is_some() {
        return Err((
            StatusCode::CONFLICT,
            Json(PreviewRefusal {
                reason: "task_closed",
                message: "Closed tasks cannot open previews.".into(),
                ports: Vec::new(),
            }),
        )
            .into_response());
    }
    let worktree_path = db
        .get_task_worktree_path(&task_id)
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
                .into_response()
        })?
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(PreviewRefusal {
                    reason: "workspace_unavailable",
                    message: "The task workspace is unavailable.".into(),
                    ports: Vec::new(),
                }),
            )
                .into_response()
        })?;
    let mut ports = db
        .list_task_ports_for_item(&task_id)
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
                .into_response()
        })?
        .into_iter()
        .filter_map(|(name, port)| u16::try_from(port).ok().map(|port| (name, port)))
        .filter(|(_, port)| *port != 0)
        .collect::<Vec<_>>();
    ports.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
    let Some((selected_name, selected_port)) = port_name
        .as_deref()
        .and_then(|requested| ports.iter().find(|(name, _)| name == requested))
        .or_else(|| port_name.is_none().then(|| ports.first()).flatten())
    else {
        return Err((
            if ports.is_empty() {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            Json(PreviewRefusal {
                reason: if ports.is_empty() {
                    "no_ports"
                } else {
                    "unknown_port"
                },
                message: port_name.map_or_else(
                    || "This task has no declared preview ports.".into(),
                    |name| format!("The task did not claim a port named {name}."),
                ),
                ports: Vec::new(),
            }),
        )
            .into_response());
    };
    Ok(PreviewSelection {
        task_id,
        worktree_path,
        port_name: selected_name.clone(),
        port: *selected_port,
        ports,
    })
}

async fn proxy_preview_request(
    State(session): State<Arc<PreviewSession>>,
    mut request: Request<Body>,
) -> Response {
    let path = request.uri().path();
    if path == ENTER_PATH {
        if request.method() != Method::GET || !consume_enter_secret(&session, request.uri()) {
            return StatusCode::NOT_FOUND.into_response();
        }
        if !session_is_current(&session).await {
            return StatusCode::NOT_FOUND.into_response();
        }
        session
            .last_activity
            .store(unix_seconds(), Ordering::Release);
        return (
            StatusCode::FOUND,
            [
                (LOCATION, HeaderValue::from_static("/")),
                (
                    SET_COOKIE,
                    HeaderValue::from_str(&format!(
                        "{COOKIE_NAME}={}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax",
                        session.cookie_value,
                        IDLE_TTL.as_secs()
                    ))
                    .unwrap_or_else(|_| HeaderValue::from_static("")),
                ),
            ],
        )
            .into_response();
    }
    if path.starts_with(RESERVED_PATH_PREFIX)
        || !cookie_matches(&session, request.headers())
        || !session_is_current(&session).await
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() == Method::CONNECT
        || request.uri().scheme().is_some()
        || request.uri().authority().is_some()
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    session
        .last_activity
        .store(unix_seconds(), Ordering::Release);

    let permit = match Arc::clone(&session.connections).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let is_upgrade = is_websocket_upgrade(request.headers());
    let client_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut request));
    rewrite_request(&mut request, session.upstream_port, is_upgrade);
    let client: Client<HttpConnector, Body> = Client::builder(TokioExecutor::new()).build_http();
    let mut upstream = match client.request(request).await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("The task dev server could not serve this request: {error}"),
            )
                .into_response();
        }
    };
    rewrite_response_headers(upstream.headers_mut(), session.upstream_port);

    if is_upgrade && upstream.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut upstream);
        let Some(client_upgrade) = client_upgrade else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        tokio::spawn(async move {
            let Ok(client_stream) = client_upgrade.await else {
                return;
            };
            let Ok(upstream_stream) = upstream_upgrade.await else {
                return;
            };
            let mut client_stream = TokioIo::new(client_stream);
            let mut upstream_stream = TokioIo::new(upstream_stream);
            let _permit = permit;
            let _ = tokio::io::copy_bidirectional(&mut client_stream, &mut upstream_stream).await;
        });
        let (parts, _body) = upstream.into_parts();
        return Response::from_parts(parts, Body::empty());
    }

    let (parts, body) = upstream.into_parts();
    let stream = Body::new(body).into_data_stream().map(move |chunk| {
        let _keep_connection_slot = &permit;
        chunk
    });
    Response::from_parts(parts, Body::from_stream(stream))
}

fn rewrite_request(request: &mut Request<Body>, port: u16, preserve_upgrade: bool) {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    if let Ok(uri) = format!("http://127.0.0.1:{port}{path_and_query}").parse::<Uri>() {
        *request.uri_mut() = uri;
    }
    let connection_headers = connection_header_names(request.headers());
    strip_proxy_headers(request.headers_mut());
    if !preserve_upgrade {
        for name in connection_headers {
            request.headers_mut().remove(name);
        }
        for name in [CONNECTION, UPGRADE] {
            request.headers_mut().remove(name);
        }
    }
    request.headers_mut().remove(CONTENT_LENGTH);
    if let Ok(host) = HeaderValue::from_str(&format!("localhost:{port}")) {
        request.headers_mut().insert(HOST, host.clone());
        if preserve_upgrade && request.headers().contains_key(ORIGIN) {
            if let Ok(origin) = HeaderValue::from_str(&format!("http://localhost:{port}")) {
                request.headers_mut().insert(ORIGIN, origin);
            }
        }
    }
    let body = std::mem::replace(request.body_mut(), Body::empty());
    *request.body_mut() = Body::new(Limited::new(body, MAX_REQUEST_BODY_BYTES));
}

fn rewrite_response_headers(headers: &mut HeaderMap, port: u16) {
    let connection_headers = connection_header_names(headers);
    if !is_websocket_upgrade(headers) {
        for name in connection_headers {
            headers.remove(name);
        }
        for name in [CONNECTION, UPGRADE] {
            headers.remove(name);
        }
    }
    strip_proxy_headers(headers);
    if let Some(location) = headers
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    {
        for origin in [
            format!("http://localhost:{port}"),
            format!("http://127.0.0.1:{port}"),
        ] {
            if let Some(relative) = location.strip_prefix(&origin) {
                if relative.starts_with('/') {
                    if let Ok(value) = HeaderValue::from_str(relative) {
                        headers.insert(LOCATION, value);
                    }
                    break;
                }
            }
        }
    }
}

fn strip_proxy_headers(headers: &mut HeaderMap) {
    headers.remove(FORWARDED);
    let names = headers
        .keys()
        .filter(|name| name.as_str().starts_with("x-forwarded-"))
        .cloned()
        .collect::<Vec<_>>();
    for name in names {
        headers.remove(name);
    }
    for name in [
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
    ] {
        headers.remove(name);
    }
}

fn connection_header_names(headers: &HeaderMap) -> Vec<HeaderName> {
    headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|value| HeaderName::from_bytes(value.trim().as_bytes()).ok())
        .collect()
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && headers
            .get(CONNECTION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
}

fn consume_enter_secret(session: &PreviewSession, uri: &Uri) -> bool {
    let presented = uri
        .query()
        .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("t=")));
    presented.is_some_and(|secret| secret_matches(secret, &session.enter_secret))
        && session
            .enter_consumed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
}

fn cookie_matches(session: &PreviewSession, headers: &HeaderMap) -> bool {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .map(str::trim)
        .filter_map(|cookie| cookie.strip_prefix(&format!("{COOKIE_NAME}=")))
        .any(|value| secret_matches(value, &session.cookie_value))
}

fn secret_matches(presented: &str, expected: &str) -> bool {
    let presented = Sha256::digest(presented.as_bytes());
    let expected = Sha256::digest(expected.as_bytes());
    presented
        .iter()
        .zip(expected.iter())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

async fn session_is_current(session: &PreviewSession) -> bool {
    let now = unix_seconds();
    if now >= session.hard_expires_at {
        return false;
    }
    if session.last_validated.load(Ordering::Acquire) == now {
        return true;
    }
    let db_path = session.db_path.clone();
    let task_id = session.task_id.clone();
    let worktree_path = session.worktree_path.clone();
    let port_name = session.port_name.clone();
    let port = i64::from(session.upstream_port);
    let current = tokio::task::spawn_blocking(move || {
        let Ok(db) = Db::open(&db_path) else {
            return false;
        };
        let Ok(Some(item)) = db.get_pipeline_item(&task_id) else {
            return false;
        };
        if item.closed_at.is_some() {
            return false;
        }
        let Ok(Some(current_worktree)) = db.get_task_worktree_path(&task_id) else {
            return false;
        };
        if current_worktree != worktree_path {
            return false;
        }
        db.list_task_ports_for_item(&task_id)
            .ok()
            .and_then(|ports| ports.get(&port_name).copied())
            == Some(port)
    })
    .await
    .unwrap_or(false);
    if current {
        session.last_validated.store(now, Ordering::Release);
    }
    current
}

async fn probe_port(port: u16) -> bool {
    tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn wait_for_expiry(session: Arc<PreviewSession>) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let now = unix_seconds();
        if now >= session.hard_expires_at
            || now.saturating_sub(session.last_activity.load(Ordering::Acquire))
                >= IDLE_TTL.as_secs()
            || !session_is_current(&session).await
        {
            return;
        }
    }
}

fn random_hex_128() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|error| format!("failed to read operating-system randomness: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::{Message, WebSocketUpgrade};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    use tower::ServiceExt as _;

    #[test]
    fn request_rewrite_targets_only_loopback_and_removes_forwarding_headers() {
        let mut request = Request::builder()
            .uri("/assets/app.js?fresh=1")
            .header("host", "192.0.2.10:55000")
            .header("x-forwarded-host", "attacker.example")
            .header("connection", "keep-alive, x-remove-me")
            .header("x-remove-me", "secret")
            .body(Body::empty())
            .expect("request");

        rewrite_request(&mut request, 8471, false);

        assert_eq!(request.uri(), "http://127.0.0.1:8471/assets/app.js?fresh=1");
        assert_eq!(request.headers()[HOST], "localhost:8471");
        assert!(!request.headers().contains_key("x-forwarded-host"));
        assert!(!request.headers().contains_key("x-remove-me"));
        assert!(!request.headers().contains_key(CONNECTION));
    }

    #[test]
    fn location_rewrite_keeps_the_preview_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            LOCATION,
            HeaderValue::from_static("http://localhost:8471/project.html"),
        );
        rewrite_response_headers(&mut headers, 8471);
        assert_eq!(headers[LOCATION], "/project.html");
    }

    #[test]
    fn enter_and_cookie_credentials_are_independent() {
        let session = PreviewSession {
            db_path: String::new(),
            task_id: "task".into(),
            worktree_path: "workspace".into(),
            port_name: "PORT".into(),
            upstream_port: 8471,
            enter_secret: "enter-secret".into(),
            enter_consumed: AtomicBool::new(false),
            cookie_value: "cookie-secret".into(),
            hard_expires_at: u64::MAX,
            last_activity: AtomicU64::new(0),
            last_validated: AtomicU64::new(0),
            connections: Arc::new(Semaphore::new(1)),
        };
        assert!(consume_enter_secret(
            &session,
            &"/__kanna_preview__/enter?t=enter-secret"
                .parse()
                .expect("uri")
        ));
        assert!(!consume_enter_secret(
            &session,
            &"/__kanna_preview__/enter?t=enter-secret"
                .parse()
                .expect("uri")
        ));
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("other=x; kanna_preview=cookie-secret"),
        );
        assert!(cookie_matches(&session, &headers));
        headers.insert(
            COOKIE,
            HeaderValue::from_static("kanna_preview=enter-secret"),
        );
        assert!(!cookie_matches(&session, &headers));
    }

    #[tokio::test]
    async fn paired_api_open_proxies_only_after_enter_and_delete_revokes_listener() {
        let upstream_listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind upstream");
        let upstream_port = upstream_listener
            .local_addr()
            .expect("upstream address")
            .port();
        let upstream = Router::new()
            .route(
                "/ws",
                axum::routing::get(
                    move |headers: HeaderMap, upgrade: WebSocketUpgrade| async move {
                        assert_eq!(
                            headers.get(HOST).and_then(|value| value.to_str().ok()),
                            Some(format!("localhost:{upstream_port}").as_str())
                        );
                        assert_eq!(
                            headers.get(ORIGIN).and_then(|value| value.to_str().ok()),
                            Some(format!("http://localhost:{upstream_port}").as_str())
                        );
                        upgrade.on_upgrade(|mut socket| async move {
                            socket
                                .send(Message::Text("hmr-ready".into()))
                                .await
                                .expect("send websocket fixture");
                        })
                    },
                ),
            )
            .route(
                "/{*path}",
                axum::routing::get(move |headers: HeaderMap| async move {
                    assert_eq!(
                        headers.get(HOST).and_then(|value| value.to_str().ok()),
                        Some(format!("localhost:{upstream_port}").as_str())
                    );
                    "proxied"
                }),
            );
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream_listener, upstream)
                .await
                .expect("serve upstream");
        });

        let state = crate::http_api::test_state_with_seed("desktop-preview", "Preview Mac", |db| {
            db.insert_test_repo("repo-preview", "Preview Repo")
                .expect("insert repo");
            db.insert_test_pipeline_item(
                "task-preview",
                "repo-preview",
                "build a site",
                Some("Preview Task"),
                "in progress",
                "2026-09-03 00:00:00",
            )
            .expect("insert task");
            db.upsert_worktree(
                "worktree-preview",
                "task-preview",
                "/tmp/task-preview",
                "task-preview",
            )
            .expect("insert worktree");
            assert!(db
                .claim_task_port("task-preview", "DEV_PORT", i64::from(upstream_port))
                .expect("claim port"));
        });
        let pairing_path = std::path::PathBuf::from(&state.config().pairing_store_path);
        let mut pairing_store = crate::pairing::PairingStore::default();
        pairing_store.add_trusted_device(
            &state.config().desktop_id,
            "preview-phone",
            "Preview Phone",
            &crate::pairing::hash_device_secret("preview-secret"),
        );
        pairing_store.save(&pairing_path).expect("save pairing");
        let api = crate::http_api::router(Arc::clone(&state));

        let mut unauthenticated = Request::post("/v1/tasks/task-preview/preview")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .expect("unauthenticated request");
        unauthenticated
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [192, 168, 1, 30],
                49152,
            ))));
        assert_eq!(
            api.clone()
                .oneshot(unauthenticated)
                .await
                .expect("unauthenticated response")
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let mut open_request = Request::post("/v1/tasks/task-preview/preview")
            .header("content-type", "application/json")
            .header("x-kanna-device-id", "preview-phone")
            .header("x-kanna-device-secret", "preview-secret")
            .body(Body::from("{}"))
            .expect("open request");
        open_request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [192, 168, 1, 30],
                49152,
            ))));
        let open = api
            .clone()
            .oneshot(open_request)
            .await
            .expect("open response");
        assert_eq!(open.status(), StatusCode::OK);
        let body = axum::body::to_bytes(open.into_body(), usize::MAX)
            .await
            .expect("open body");
        let opened: serde_json::Value = serde_json::from_slice(&body).expect("open json");
        assert_eq!(opened["portName"], "DEV_PORT");
        assert_eq!(opened["ports"][0]["listening"], true);
        let listener_port = opened["port"].as_u64().expect("listener port");
        let enter_path = opened["enterPath"].as_str().expect("enter path");
        let base = format!("http://127.0.0.1:{listener_port}");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        assert_eq!(
            client
                .get(format!("{base}/project.html"))
                .send()
                .await
                .expect("uncookied request")
                .status(),
            StatusCode::NOT_FOUND
        );
        let enter = client
            .get(format!("{base}{enter_path}"))
            .send()
            .await
            .expect("enter request");
        assert_eq!(enter.status(), StatusCode::FOUND);
        assert_eq!(enter.headers()[LOCATION], "/");
        let cookie = enter.headers()[SET_COOKIE]
            .to_str()
            .expect("set-cookie")
            .split(';')
            .next()
            .expect("cookie pair")
            .to_string();
        assert_eq!(
            client
                .get(format!("{base}{enter_path}"))
                .send()
                .await
                .expect("replayed enter request")
                .status(),
            StatusCode::NOT_FOUND
        );
        let proxied = client
            .get(format!("{base}/project.html"))
            .header(COOKIE, cookie.clone())
            .send()
            .await
            .expect("proxied request");
        assert_eq!(proxied.status(), StatusCode::OK);
        assert_eq!(proxied.text().await.expect("proxied body"), "proxied");

        let mut websocket_request = format!("ws://127.0.0.1:{listener_port}/ws")
            .into_client_request()
            .expect("websocket request");
        websocket_request.headers_mut().insert(
            COOKIE,
            HeaderValue::from_str(&cookie).expect("cookie header"),
        );
        websocket_request.headers_mut().insert(
            ORIGIN,
            HeaderValue::from_str(&base).expect("preview origin"),
        );
        let (mut websocket, _) = tokio_tungstenite::connect_async(websocket_request)
            .await
            .expect("proxied websocket");
        assert_eq!(
            websocket
                .next()
                .await
                .expect("websocket frame")
                .expect("websocket message"),
            tokio_tungstenite::tungstenite::Message::Text("hmr-ready".into())
        );
        websocket.close(None).await.expect("close websocket");

        let mut close_request = Request::delete("/v1/tasks/task-preview/preview")
            .header("x-kanna-device-id", "preview-phone")
            .header("x-kanna-device-secret", "preview-secret")
            .body(Body::empty())
            .expect("close request");
        close_request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [192, 168, 1, 30],
                49152,
            ))));
        let closed = api.oneshot(close_request).await.expect("close response");
        assert_eq!(closed.status(), StatusCode::NO_CONTENT);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(reqwest::get(format!("{base}/")).await.is_err());

        upstream_task.abort();
        let _ = std::fs::remove_file(pairing_path);
    }
}
