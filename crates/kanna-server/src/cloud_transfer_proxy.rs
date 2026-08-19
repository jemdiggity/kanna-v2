//! Outbound cloud transfer tunnels, owned by `kanna-server`.
//!
//! This cannot ride the server's own relay connection. The relay only honours
//! `tunnel_request` from a socket authenticated with a Firebase user
//! `id_token` (`services/relay/src/router.ts` — `from === "phone"`); the
//! server authenticates as a *desktop* with its device token / desktop secret
//! and is never allowed to open one. The signed-in renderer holds the only
//! Firebase credential, so it pushes and rotates the ID token through
//! `POST /v1/transfers/cloud-proxies` and this module dials the relay with it.
//! Each cloud peer is modelled to the sidecar as a loopback "external peer"
//! pointing at the listener bound here.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

pub type CloudTransferProxyState = Arc<Mutex<HashMap<String, CloudTransferProxyHandle>>>;
const DEFAULT_MAX_PROXY_CONNECTIONS: usize = 16;
const DEFAULT_PROXY_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PRE_SETUP_LOCAL_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy)]
struct ProxyLimits {
    max_connections: usize,
    setup_timeout: Duration,
}

impl Default for ProxyLimits {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_MAX_PROXY_CONNECTIONS,
            setup_timeout: DEFAULT_PROXY_SETUP_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTransferProxyEndpoint {
    pub peer_id: String,
    pub endpoint: String,
}

pub struct CloudTransferProxyHandle {
    desktop_id: String,
    relay_url: String,
    id_token: watch::Sender<String>,
    endpoint: CloudTransferProxyEndpoint,
    cancel: watch::Sender<bool>,
    listener_task: JoinHandle<()>,
}

impl CloudTransferProxyHandle {
    fn matches_route(&self, desktop_id: &str, relay_url: &str) -> bool {
        !self.listener_task.is_finished()
            && self.desktop_id == desktop_id
            && self.relay_url == relay_url
    }

    fn request_stop(&self) {
        let _ = self.cancel.send(true);
    }

    async fn wait_stopped(self) -> Result<(), String> {
        match self.listener_task.await {
            Ok(()) => Ok(()),
            Err(error) if error.is_cancelled() => Ok(()),
            Err(error) => Err(format!(
                "cloud transfer proxy listener failed to stop: {error}"
            )),
        }
    }

    async fn stop(self) -> Result<(), String> {
        self.request_stop();
        self.wait_stopped().await
    }
}

#[derive(Clone)]
struct ProxyConfig {
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: watch::Receiver<String>,
}

#[derive(Debug)]
enum ProxyError {
    Io(std::io::Error),
    WebSocket(tokio_tungstenite::tungstenite::Error),
    Relay(String),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "cloud transfer proxy I/O failed: {error}"),
            Self::WebSocket(error) => {
                write!(formatter, "cloud transfer proxy WebSocket failed: {error}")
            }
            Self::Relay(error) => {
                write!(formatter, "cloud transfer relay rejected tunnel: {error}")
            }
        }
    }
}

impl From<std::io::Error> for ProxyError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for ProxyError {
    fn from(error: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::WebSocket(error)
    }
}

pub async fn ensure_cloud_transfer_proxy_in_state(
    state: &CloudTransferProxyState,
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: String,
) -> Result<CloudTransferProxyEndpoint, String> {
    ensure_cloud_transfer_proxy_with_limits(
        state,
        peer_id,
        desktop_id,
        relay_url,
        id_token,
        ProxyLimits::default(),
    )
    .await
}

async fn ensure_cloud_transfer_proxy_with_limits(
    state: &CloudTransferProxyState,
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: String,
    limits: ProxyLimits,
) -> Result<CloudTransferProxyEndpoint, String> {
    validate_nonblank("peer id", &peer_id)?;
    validate_nonblank("desktop id", &desktop_id)?;
    validate_nonblank("ID token", &id_token)?;
    validate_relay_url(&relay_url)?;
    if limits.max_connections == 0 || limits.setup_timeout.is_zero() {
        return Err("cloud transfer proxy limits must be positive".into());
    }

    let mut proxies = state.lock().await;
    if let Some(existing) = proxies.get(&peer_id) {
        if existing.matches_route(&desktop_id, &relay_url) {
            existing.id_token.send_replace(id_token);
            return Ok(existing.endpoint.clone());
        }
    }

    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|error| format!("failed to bind cloud transfer proxy: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("failed to read cloud transfer proxy address: {error}"))?;
    let endpoint = CloudTransferProxyEndpoint {
        peer_id: peer_id.clone(),
        endpoint: address.to_string(),
    };

    // Bind the replacement before stopping the old listener. Besides avoiding a
    // service gap, this guarantees a new endpoint for sidecars still holding
    // the previous route.
    if let Some(existing) = proxies.remove(&peer_id) {
        existing.stop().await?;
    }

    let (id_token, id_token_receiver) = watch::channel(id_token);
    let config = ProxyConfig {
        peer_id: peer_id.clone(),
        desktop_id: desktop_id.clone(),
        relay_url: relay_url.clone(),
        id_token: id_token_receiver,
    };
    let (cancel, cancel_receiver) = watch::channel(false);
    let listener_task = tokio::spawn(run_proxy_listener(
        listener,
        config,
        cancel_receiver,
        limits,
    ));

    proxies.insert(
        peer_id,
        CloudTransferProxyHandle {
            desktop_id,
            relay_url,
            id_token,
            endpoint: endpoint.clone(),
            cancel,
            listener_task,
        },
    );
    Ok(endpoint)
}

pub async fn remove_cloud_transfer_proxy_in_state(
    state: &CloudTransferProxyState,
    peer_id: &str,
) -> Result<(), String> {
    validate_nonblank("peer id", peer_id)?;
    let handle = state.lock().await.remove(peer_id);
    if let Some(handle) = handle {
        handle.stop().await?;
    }
    Ok(())
}

pub async fn clear_cloud_transfer_proxies_in_state(
    state: &CloudTransferProxyState,
) -> Result<(), String> {
    let handles = {
        let mut proxies = state.lock().await;
        proxies
            .drain()
            .map(|(_, handle)| handle)
            .collect::<Vec<_>>()
    };
    for handle in &handles {
        handle.request_stop();
    }
    let mut errors = Vec::new();
    for handle in handles {
        if let Err(error) = handle.wait_stopped().await {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn validate_nonblank(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{name} must not be blank"))
    } else {
        Ok(())
    }
}

fn validate_relay_url(relay_url: &str) -> Result<(), String> {
    let request = relay_url
        .into_client_request()
        .map_err(|error| format!("invalid relay URL: {error}"))?;
    let uri = request.uri();
    let host = uri
        .host()
        .ok_or_else(|| "relay URL must include an authority".to_string())?;
    match uri.scheme_str() {
        Some("wss") => Ok(()),
        Some("ws") if is_explicit_loopback_host(host) => Ok(()),
        Some("ws") => Err("relay URL must use wss:// for non-loopback relay hosts".to_string()),
        _ => Err("relay URL must use ws:// or wss://".to_string()),
    }
}

fn is_explicit_loopback_host(host: &str) -> bool {
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    let ip_literal = normalized
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&normalized);
    normalized == "localhost"
        || normalized.ends_with(".localhost")
        || ip_literal
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

async fn run_proxy_listener(
    listener: TcpListener,
    config: ProxyConfig,
    mut cancel: watch::Receiver<bool>,
    limits: ProxyLimits,
) {
    let mut connections = JoinSet::new();
    let mut next_connection_id = 1_u64;
    let connection_permits = Arc::new(Semaphore::new(limits.max_connections));

    loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, _)) => {
                        let permit = match Arc::clone(&connection_permits).try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                drop(socket);
                                continue;
                            }
                        };
                        let connection_id = next_connection_id;
                        next_connection_id = next_connection_id.saturating_add(1);
                        connections.spawn(run_proxy_connection(
                            socket,
                            config.clone(),
                            connection_id,
                            cancel.clone(),
                            permit,
                            limits.setup_timeout,
                        ));
                    }
                    Err(error) => {
                        log::warn!("cloud transfer proxy listener accept failed: {error}");
                        break;
                    }
                }
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                if let Err(error) = result {
                    log::warn!("cloud transfer proxy connection task failed: {error}");
                }
            }
        }
    }

    while let Some(result) = connections.join_next().await {
        if let Err(error) = result {
            log::warn!("cloud transfer proxy connection task failed during shutdown: {error}");
        }
    }
}

async fn run_proxy_connection(
    mut local: TcpStream,
    config: ProxyConfig,
    connection_id: u64,
    mut cancel: watch::Receiver<bool>,
    _permit: OwnedSemaphorePermit,
    setup_timeout: Duration,
) {
    let result = tokio::select! {
        result = connect_and_bridge(
            &mut local,
            &config,
            connection_id,
            cancel.clone(),
            setup_timeout,
        ) => result,
        changed = cancel.changed() => {
            if changed.is_err() || *cancel.borrow() {
                let _ = local.shutdown().await;
            }
            Ok(())
        }
    };
    if let Err(error) = result {
        log::warn!(
            "cloud transfer proxy peer {} connection failed: {}",
            config.peer_id,
            error
        );
    }
}

async fn connect_and_bridge(
    local: &mut TcpStream,
    config: &ProxyConfig,
    connection_id: u64,
    cancel: watch::Receiver<bool>,
    setup_timeout: Duration,
) -> Result<(), ProxyError> {
    let mut setup = Box::pin(timeout(
        setup_timeout,
        establish_relay(config, connection_id),
    ));
    let mut pending_local = Vec::new();
    let mut cancel = cancel;
    let mut buffer = [0_u8; 8192];
    let mut relay = loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Ok(());
                }
            }
            read = local.read(&mut buffer) => {
                let count = read?;
                if count == 0 {
                    return Ok(());
                }
                if pending_local.len().saturating_add(count) > MAX_PRE_SETUP_LOCAL_BYTES {
                    return Err(ProxyError::Relay(
                        "local transfer request exceeded the pre-setup buffer limit".into(),
                    ));
                }
                pending_local.extend_from_slice(&buffer[..count]);
            }
            result = &mut setup => {
                break result
                    .map_err(|_| ProxyError::Relay("relay tunnel setup timed out".into()))??;
            }
        }
    };
    if !pending_local.is_empty() {
        relay.send(Message::Binary(pending_local.into())).await?;
    }
    bridge(local, &mut relay, cancel).await
}

async fn establish_relay(
    config: &ProxyConfig,
    connection_id: u64,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    ProxyError,
> {
    let (mut relay, _) = tokio_tungstenite::connect_async(&config.relay_url).await?;
    let id_token = config.id_token.borrow().clone();
    relay
        .send(Message::Text(
            serde_json::json!({
                "type": "auth",
                "id_token": id_token,
            })
            .to_string()
            .into(),
        ))
        .await?;
    await_auth_ok(&mut relay).await?;

    let request_id = format!("cloud-transfer-{}-{connection_id}", config.peer_id);
    relay
        .send(Message::Text(
            serde_json::json!({
                "type": "tunnel_request",
                "id": request_id,
                "desktopId": config.desktop_id,
                "service": "task-transfer",
            })
            .to_string()
            .into(),
        ))
        .await?;
    await_tunnel_ready(&mut relay, &config.desktop_id).await?;
    Ok(relay)
}

async fn await_auth_ok<S>(
    relay: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<(), ProxyError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = relay
        .next()
        .await
        .ok_or_else(|| ProxyError::Relay("relay closed before auth_ok".to_string()))??;
    let Message::Text(text) = frame else {
        return Err(ProxyError::Relay("expected auth_ok text frame".to_string()));
    };
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| ProxyError::Relay(format!("invalid auth response: {error}")))?;
    if value.get("type").and_then(|kind| kind.as_str()) != Some("auth_ok") {
        return Err(ProxyError::Relay(
            "expected auth_ok relay response".to_string(),
        ));
    }
    if value
        .get("userId")
        .and_then(|user_id| user_id.as_str())
        .is_none_or(|user_id| user_id.trim().is_empty())
    {
        return Err(ProxyError::Relay(
            "auth_ok response omitted userId".to_string(),
        ));
    }
    let supports_task_transfer = value
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("tunnelServices"))
        .and_then(|services| services.as_array())
        .is_some_and(|services| {
            services
                .iter()
                .any(|service| service.as_str() == Some("task-transfer"))
        });
    if !supports_task_transfer {
        return Err(ProxyError::Relay(
            "relay does not advertise task-transfer tunnel support".to_string(),
        ));
    }
    Ok(())
}

async fn await_tunnel_ready<S>(
    relay: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_desktop_id: &str,
) -> Result<(), ProxyError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = relay
        .next()
        .await
        .ok_or_else(|| ProxyError::Relay("relay closed before tunnel_ready".to_string()))??;
    let Message::Text(text) = frame else {
        return Err(ProxyError::Relay(
            "expected tunnel_ready text frame".to_string(),
        ));
    };
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| ProxyError::Relay(format!("invalid tunnel response: {error}")))?;
    if value.get("type").and_then(|kind| kind.as_str()) != Some("tunnel_ready") {
        let relay_error = value
            .get("error")
            .and_then(|error| error.as_str())
            .unwrap_or("expected tunnel_ready relay response");
        return Err(ProxyError::Relay(relay_error.to_string()));
    }
    if value
        .get("tunnelId")
        .and_then(|id| id.as_str())
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err(ProxyError::Relay(
            "tunnel_ready response omitted tunnelId".to_string(),
        ));
    }
    if value.get("desktopId").and_then(|id| id.as_str()) != Some(expected_desktop_id) {
        return Err(ProxyError::Relay(
            "tunnel_ready desktopId mismatch".to_string(),
        ));
    }
    if value.get("service").and_then(|service| service.as_str()) != Some("task-transfer") {
        return Err(ProxyError::Relay(
            "tunnel_ready service mismatch".to_string(),
        ));
    }
    Ok(())
}

async fn bridge<S>(
    local: &mut TcpStream,
    relay: &mut tokio_tungstenite::WebSocketStream<S>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), ProxyError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    let _ = relay.close(None).await;
                    let _ = local.shutdown().await;
                    break;
                }
            }
            read = local.read(&mut buffer) => {
                let count = read?;
                if count == 0 {
                    let _ = relay.close(None).await;
                    break;
                }
                relay
                    .send(Message::Binary(buffer[..count].to_vec().into()))
                    .await?;
            }
            frame = relay.next() => {
                match frame.transpose()? {
                    Some(Message::Binary(bytes)) => local.write_all(&bytes).await?,
                    Some(Message::Close(_)) | None => {
                        let _ = local.shutdown().await;
                        break;
                    }
                    Some(Message::Ping(bytes)) => relay.send(Message::Pong(bytes)).await?,
                    Some(Message::Pong(_)) => {}
                    Some(Message::Text(_)) | Some(Message::Frame(_)) => {
                        return Err(ProxyError::Relay(
                            "unexpected non-binary relay tunnel frame".to_string(),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex;
    use tokio::time::{sleep, timeout, Duration, Instant};
    use tokio_tungstenite::accept_async;
    use tokio_tungstenite::tungstenite::Message;

    use super::{
        clear_cloud_transfer_proxies_in_state, ensure_cloud_transfer_proxy_in_state,
        ensure_cloud_transfer_proxy_with_limits, remove_cloud_transfer_proxy_in_state,
        validate_relay_url, CloudTransferProxyState, ProxyLimits,
    };

    const TEST_TIMEOUT: Duration = Duration::from_secs(3);

    async fn test_relay() -> (String, TcpListener) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind relay");
        let address = listener.local_addr().expect("relay address");
        (format!("ws://{address}"), listener)
    }

    fn state() -> CloudTransferProxyState {
        Arc::new(Mutex::new(Default::default()))
    }

    async fn wait_for_endpoint_release(endpoint: &str) {
        let deadline = Instant::now() + TEST_TIMEOUT;
        loop {
            match TcpListener::bind(endpoint).await {
                Ok(listener) => {
                    drop(listener);
                    return;
                }
                Err(_) if Instant::now() < deadline => {
                    sleep(Duration::from_millis(10)).await;
                }
                Err(error) => {
                    panic!("proxy endpoint {endpoint} was not released: {error}");
                }
            }
        }
    }

    async fn next_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let message = timeout(TEST_TIMEOUT, socket.next())
            .await
            .expect("timed out waiting for relay frame")
            .expect("relay socket closed")
            .expect("relay websocket error");
        let Message::Text(text) = message else {
            panic!("expected relay text frame, got {message:?}");
        };
        serde_json::from_str(&text).expect("valid relay JSON")
    }

    async fn authenticate_and_ready<S>(
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
        expected_token: &str,
        expected_peer: &str,
        expected_desktop: &str,
        expected_connection_id: u64,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        assert_eq!(
            next_json(socket).await,
            json!({"type": "auth", "id_token": expected_token})
        );

        // The tunnel request must not be sent before authentication succeeds.
        assert!(timeout(Duration::from_millis(75), socket.next())
            .await
            .is_err());
        socket
            .send(Message::Text(
                json!({
                    "type": "auth_ok",
                    "userId": "user-a",
                    "capabilities": { "tunnelServices": ["ksp", "task-transfer"] },
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send auth_ok");

        let request = next_json(socket).await;
        assert_eq!(
            request,
            json!({
                "type": "tunnel_request",
                "id": format!("cloud-transfer-{expected_peer}-{expected_connection_id}"),
                "desktopId": expected_desktop,
                "service": "task-transfer",
            })
        );
        socket
            .send(Message::Text(
                json!({
                    "type": "tunnel_ready",
                    "tunnelId": "relay-tunnel-1",
                    "desktopId": expected_desktop,
                    "service": "task-transfer",
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send tunnel_ready");
    }

    #[tokio::test]
    async fn proxy_authenticates_requests_task_transfer_and_bridges_both_directions() {
        let (relay_url, relay_listener) = test_relay().await;
        let state = state();
        let endpoint = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".to_string(),
            "desktop-b".to_string(),
            relay_url,
            "id-token-a".to_string(),
        )
        .await
        .expect("ensure proxy");

        assert!(endpoint.endpoint.starts_with("127.0.0.1:"));
        let mut sidecar = TcpStream::connect(&endpoint.endpoint)
            .await
            .expect("connect sidecar to proxy");
        let (relay_tcp, _) = timeout(TEST_TIMEOUT, relay_listener.accept())
            .await
            .expect("proxy did not connect to relay")
            .expect("accept relay connection");
        let mut relay = accept_async(relay_tcp).await.expect("accept websocket");

        authenticate_and_ready(&mut relay, "id-token-a", "peer-b", "desktop-b", 1).await;

        sidecar
            .write_all(b"sidecar-to-relay")
            .await
            .expect("write sidecar bytes");
        let relay_frame = timeout(TEST_TIMEOUT, relay.next())
            .await
            .expect("relay did not receive bytes")
            .expect("relay socket closed")
            .expect("relay websocket error");
        assert_eq!(
            relay_frame,
            Message::Binary(b"sidecar-to-relay".to_vec().into())
        );

        relay
            .send(Message::Binary(b"relay-to-sidecar".to_vec().into()))
            .await
            .expect("write relay bytes");
        let mut bytes = vec![0; b"relay-to-sidecar".len()];
        timeout(TEST_TIMEOUT, sidecar.read_exact(&mut bytes))
            .await
            .expect("sidecar did not receive bytes")
            .expect("read sidecar bytes");
        assert_eq!(bytes, b"relay-to-sidecar");

        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxies");
    }

    #[tokio::test]
    async fn malformed_auth_or_ready_frames_close_the_local_connection() {
        for response in [
            json!({"type": "event", "name": "not-auth-ok"}),
            json!({"type": "auth_ok", "userId": ""}),
            json!({"type": "auth_ok", "userId": "user-a"}),
            json!({
                "type": "auth_ok",
                "userId": "user-a",
                "capabilities": { "tunnelServices": ["ksp", "task-transfer"] },
            }),
        ] {
            let (relay_url, relay_listener) = test_relay().await;
            let state = state();
            let endpoint = ensure_cloud_transfer_proxy_in_state(
                &state,
                "peer-b".into(),
                "desktop-b".into(),
                relay_url,
                "token".into(),
            )
            .await
            .expect("ensure proxy");
            let mut sidecar = TcpStream::connect(&endpoint.endpoint)
                .await
                .expect("connect sidecar");
            let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
            let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
            assert_eq!(
                next_json(&mut relay).await,
                json!({"type": "auth", "id_token": "token"})
            );
            relay
                .send(Message::Text(response.to_string().into()))
                .await
                .expect("send response");

            if response["capabilities"]["tunnelServices"]
                .as_array()
                .is_some_and(|services| services.iter().any(|service| service == "task-transfer"))
            {
                let _request = next_json(&mut relay).await;
                relay
                    .send(Message::Text(
                        json!({
                            "type": "tunnel_ready",
                            "tunnelId": "",
                            "desktopId": "desktop-b",
                            "service": "task-transfer",
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .expect("send malformed ready");
            }

            let mut byte = [0_u8; 1];
            assert_eq!(
                timeout(TEST_TIMEOUT, sidecar.read(&mut byte))
                    .await
                    .expect("proxy did not close malformed tunnel")
                    .expect("read local socket"),
                0
            );
            clear_cloud_transfer_proxies_in_state(&state)
                .await
                .expect("clear proxy");
        }
    }

    #[tokio::test]
    async fn current_client_does_not_send_task_transfer_request_to_previous_relay() {
        let (relay_url, relay_listener) = test_relay().await;
        let state = state();
        let endpoint = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url,
            "token".into(),
        )
        .await
        .expect("ensure proxy");
        let mut sidecar = TcpStream::connect(&endpoint.endpoint)
            .await
            .expect("connect sidecar");
        let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
        let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
        let _auth = next_json(&mut relay).await;
        relay
            .send(Message::Text(
                json!({"type": "auth_ok", "userId": "user-a"})
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send previous-relay auth_ok");

        let next = timeout(Duration::from_millis(250), relay.next()).await;
        if let Ok(Some(Ok(Message::Text(text)))) = next {
            panic!("sent task-transfer request to previous relay: {text}");
        }
        let mut byte = [0_u8; 1];
        assert_eq!(
            timeout(TEST_TIMEOUT, sidecar.read(&mut byte))
                .await
                .expect("proxy did not reject previous relay")
                .expect("read local socket"),
            0,
        );
        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxy");
    }

    #[tokio::test]
    async fn ready_frame_must_match_desktop_and_task_transfer_service() {
        for ready in [
            json!({
                "type": "tunnel_ready",
                "tunnelId": "tunnel-1",
                "desktopId": "desktop-other",
                "service": "task-transfer",
            }),
            json!({
                "type": "tunnel_ready",
                "tunnelId": "tunnel-1",
                "desktopId": "desktop-b",
                "service": "ksp",
            }),
            json!({
                "type": "response",
                "id": "cloud-transfer-peer-b-1",
                "error": "Desktop offline",
            }),
        ] {
            let (relay_url, relay_listener) = test_relay().await;
            let state = state();
            let endpoint = ensure_cloud_transfer_proxy_in_state(
                &state,
                "peer-b".into(),
                "desktop-b".into(),
                relay_url,
                "token".into(),
            )
            .await
            .expect("ensure proxy");
            let mut sidecar = TcpStream::connect(&endpoint.endpoint)
                .await
                .expect("connect sidecar");
            let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
            let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
            let _auth = next_json(&mut relay).await;
            relay
                .send(Message::Text(
                    json!({
                        "type": "auth_ok",
                        "userId": "user-a",
                        "capabilities": { "tunnelServices": ["ksp", "task-transfer"] },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("send auth_ok");
            let _request = next_json(&mut relay).await;
            relay
                .send(Message::Text(ready.to_string().into()))
                .await
                .expect("send invalid ready");

            let mut byte = [0_u8; 1];
            assert_eq!(
                timeout(TEST_TIMEOUT, sidecar.read(&mut byte))
                    .await
                    .expect("proxy did not close invalid tunnel")
                    .expect("read local socket"),
                0
            );
            clear_cloud_transfer_proxies_in_state(&state)
                .await
                .expect("clear proxy");
        }
    }

    #[tokio::test]
    async fn validation_rejects_invalid_configuration_without_binding() {
        let state = state();
        for (peer, desktop, relay, token) in [
            ("", "desktop-b", "ws://127.0.0.1:9", "token"),
            ("peer-b", " ", "ws://127.0.0.1:9", "token"),
            ("peer-b", "desktop-b", "http://127.0.0.1:9", "token"),
            ("peer-b", "desktop-b", "ws://", "token"),
            ("peer-b", "desktop-b", "ws://127.0.0.1:9", "\n"),
        ] {
            assert!(
                ensure_cloud_transfer_proxy_in_state(
                    &state,
                    peer.into(),
                    desktop.into(),
                    relay.into(),
                    token.into(),
                )
                .await
                .is_err(),
                "accepted invalid proxy configuration: {peer:?} {desktop:?} {relay:?}"
            );
        }
        assert!(state.lock().await.is_empty());
    }

    #[test]
    fn relay_url_validation_requires_tls_for_non_loopback_hosts() {
        for relay_url in [
            "ws://relay.example.com/task-transfer",
            "ws://192.168.1.20:8080",
            "ws://10.0.2.2:8080",
        ] {
            assert!(
                validate_relay_url(relay_url).is_err(),
                "accepted plaintext non-loopback relay URL: {relay_url}",
            );
        }

        for relay_url in [
            "wss://relay.example.com/task-transfer",
            "ws://localhost:8080",
            "ws://dev.localhost:8080",
            "ws://127.0.0.1:8080",
            "ws://[::1]:8080",
        ] {
            assert!(
                validate_relay_url(relay_url).is_ok(),
                "rejected secure or explicit loopback relay URL: {relay_url}",
            );
        }
    }

    #[tokio::test]
    async fn refreshed_auth_keeps_the_endpoint_and_the_next_connection_uses_the_new_token() {
        let (relay_url, relay_listener) = test_relay().await;
        let state = state();
        let first = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url.clone(),
            "token-a".into(),
        )
        .await
        .expect("first proxy");
        let mut first_sidecar = TcpStream::connect(&first.endpoint)
            .await
            .expect("connect first sidecar");
        let (first_relay_tcp, _) = relay_listener.accept().await.expect("accept first relay");
        let mut first_relay = accept_async(first_relay_tcp)
            .await
            .expect("accept first websocket");
        authenticate_and_ready(&mut first_relay, "token-a", "peer-b", "desktop-b", 1).await;

        let refreshed = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url.clone(),
            "token-b".into(),
        )
        .await
        .expect("refresh proxy authentication");
        assert_eq!(refreshed, first);

        let _second_sidecar = TcpStream::connect(&refreshed.endpoint)
            .await
            .expect("connect second sidecar");
        let (second_relay_tcp, _) = relay_listener.accept().await.expect("accept second relay");
        let mut second_relay = accept_async(second_relay_tcp)
            .await
            .expect("accept second websocket");
        authenticate_and_ready(&mut second_relay, "token-b", "peer-b", "desktop-b", 2).await;

        first_relay
            .send(Message::Binary(b"still-open".to_vec().into()))
            .await
            .expect("write through original tunnel");
        let mut original_bytes = [0_u8; 10];
        first_sidecar
            .read_exact(&mut original_bytes)
            .await
            .expect("read original tunnel after refresh");
        assert_eq!(&original_bytes, b"still-open");

        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxies");
    }

    #[tokio::test]
    async fn finished_listener_is_never_reused() {
        let (relay_url, _relay_listener) = test_relay().await;
        let state = state();
        let first = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url.clone(),
            "token".into(),
        )
        .await
        .expect("first proxy");
        {
            let proxies = state.lock().await;
            proxies
                .get("peer-b")
                .expect("stored proxy")
                .listener_task
                .abort();
        }
        tokio::task::yield_now().await;

        let replacement = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url,
            "token".into(),
        )
        .await
        .expect("replace dead proxy");
        assert_ne!(replacement.endpoint, first.endpoint);
        wait_for_endpoint_release(&first.endpoint).await;

        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxies");
    }

    #[tokio::test]
    async fn remove_and_clear_close_listeners_and_active_sockets() {
        let state = state();
        let (relay_url_b, relay_listener_b) = test_relay().await;
        let endpoint_b = ensure_cloud_transfer_proxy_in_state(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url_b,
            "token".into(),
        )
        .await
        .expect("peer b");
        let mut sidecar_b = TcpStream::connect(&endpoint_b.endpoint)
            .await
            .expect("connect peer b");
        let (relay_tcp_b, _) = relay_listener_b.accept().await.expect("accept peer b");
        let mut relay_b = accept_async(relay_tcp_b).await.expect("websocket peer b");
        authenticate_and_ready(&mut relay_b, "token", "peer-b", "desktop-b", 1).await;

        remove_cloud_transfer_proxy_in_state(&state, "peer-b")
            .await
            .expect("remove peer b");
        wait_for_endpoint_release(&endpoint_b.endpoint).await;
        let mut byte = [0_u8; 1];
        assert_eq!(
            timeout(TEST_TIMEOUT, sidecar_b.read(&mut byte))
                .await
                .expect("remove did not close active local socket")
                .expect("read removed socket"),
            0
        );
        assert!(timeout(TEST_TIMEOUT, relay_b.next())
            .await
            .expect("remove did not close active relay socket")
            .is_some());

        let mut active = Vec::new();
        for (peer, desktop) in [("peer-c", "desktop-c"), ("peer-d", "desktop-d")] {
            let (relay_url, relay_listener) = test_relay().await;
            let endpoint = ensure_cloud_transfer_proxy_in_state(
                &state,
                peer.into(),
                desktop.into(),
                relay_url,
                "token".into(),
            )
            .await
            .expect("ensure proxy");
            let sidecar = TcpStream::connect(&endpoint.endpoint)
                .await
                .expect("connect sidecar");
            let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
            let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
            authenticate_and_ready(&mut relay, "token", peer, desktop, 1).await;
            active.push((endpoint, sidecar, relay));
        }

        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxies");
        assert!(state.lock().await.is_empty());
        for (endpoint, mut sidecar, mut relay) in active {
            wait_for_endpoint_release(&endpoint.endpoint).await;
            assert_eq!(
                timeout(TEST_TIMEOUT, sidecar.read(&mut byte))
                    .await
                    .expect("clear did not close active local socket")
                    .expect("read cleared socket"),
                0
            );
            assert!(timeout(TEST_TIMEOUT, relay.next())
                .await
                .expect("clear did not close active relay socket")
                .is_some());
        }
    }

    #[tokio::test]
    async fn stalled_auth_is_bounded_by_the_setup_deadline() {
        let (relay_url, relay_listener) = test_relay().await;
        let state = state();
        let endpoint = ensure_cloud_transfer_proxy_with_limits(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url,
            "token".into(),
            ProxyLimits {
                max_connections: 2,
                setup_timeout: Duration::from_millis(75),
            },
        )
        .await
        .expect("ensure proxy");
        let mut sidecar = TcpStream::connect(&endpoint.endpoint)
            .await
            .expect("connect sidecar");
        let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
        let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
        let _auth = next_json(&mut relay).await;

        let mut byte = [0_u8; 1];
        assert_eq!(
            timeout(TEST_TIMEOUT, sidecar.read(&mut byte))
                .await
                .expect("stalled auth did not close locally")
                .expect("read local close"),
            0,
        );
        assert!(timeout(TEST_TIMEOUT, relay.next())
            .await
            .expect("stalled auth did not close relay")
            .is_some());
        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxy");
    }

    #[tokio::test]
    async fn stalled_tunnel_ready_is_bounded_by_the_setup_deadline() {
        let (relay_url, relay_listener) = test_relay().await;
        let state = state();
        let endpoint = ensure_cloud_transfer_proxy_with_limits(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url,
            "token".into(),
            ProxyLimits {
                max_connections: 2,
                setup_timeout: Duration::from_millis(100),
            },
        )
        .await
        .expect("ensure proxy");
        let mut sidecar = TcpStream::connect(&endpoint.endpoint)
            .await
            .expect("connect sidecar");
        let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
        let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
        let _auth = next_json(&mut relay).await;
        relay
            .send(Message::Text(
                json!({
                    "type": "auth_ok",
                    "userId": "user-a",
                    "capabilities": { "tunnelServices": ["task-transfer"] },
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send auth ok");
        let _request = next_json(&mut relay).await;

        let mut byte = [0_u8; 1];
        assert_eq!(
            timeout(TEST_TIMEOUT, sidecar.read(&mut byte))
                .await
                .expect("stalled tunnel-ready did not close locally")
                .expect("read local close"),
            0,
        );
        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxy");
    }

    #[tokio::test]
    async fn requester_disconnect_cancels_stalled_setup() {
        for send_auth_ok in [false, true] {
            let (relay_url, relay_listener) = test_relay().await;
            let state = state();
            let endpoint = ensure_cloud_transfer_proxy_with_limits(
                &state,
                "peer-b".into(),
                "desktop-b".into(),
                relay_url,
                "token".into(),
                ProxyLimits {
                    max_connections: 2,
                    setup_timeout: TEST_TIMEOUT,
                },
            )
            .await
            .expect("ensure proxy");
            let sidecar = TcpStream::connect(&endpoint.endpoint)
                .await
                .expect("connect sidecar");
            let (relay_tcp, _) = relay_listener.accept().await.expect("accept relay");
            let mut relay = accept_async(relay_tcp).await.expect("accept websocket");
            let _auth = next_json(&mut relay).await;
            if send_auth_ok {
                relay
                    .send(Message::Text(
                        json!({
                            "type": "auth_ok",
                            "userId": "user-a",
                            "capabilities": { "tunnelServices": ["task-transfer"] },
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .expect("send auth ok");
                let _request = next_json(&mut relay).await;
            }
            drop(sidecar);

            // Liveness, not latency: a setup that was never cancelled sends
            // nothing at all, so the ceiling only has to be finite.
            assert!(timeout(Duration::from_secs(10), relay.next())
                .await
                .expect("local EOF did not cancel stalled setup")
                .is_some());
            clear_cloud_transfer_proxies_in_state(&state)
                .await
                .expect("clear proxy");
        }
    }

    #[tokio::test]
    async fn connection_cap_rejects_setup_work_before_spawning_another_relay() {
        let (relay_url, relay_listener) = test_relay().await;
        let state = state();
        let endpoint = ensure_cloud_transfer_proxy_with_limits(
            &state,
            "peer-b".into(),
            "desktop-b".into(),
            relay_url,
            "token".into(),
            ProxyLimits {
                max_connections: 1,
                setup_timeout: TEST_TIMEOUT,
            },
        )
        .await
        .expect("ensure proxy");
        let _first = TcpStream::connect(&endpoint.endpoint)
            .await
            .expect("connect first sidecar");
        let (relay_tcp, _) = relay_listener.accept().await.expect("accept first relay");
        let _first_relay = accept_async(relay_tcp)
            .await
            .expect("accept first websocket");

        let mut second = TcpStream::connect(&endpoint.endpoint)
            .await
            .expect("connect second sidecar");
        assert!(timeout(Duration::from_millis(150), relay_listener.accept())
            .await
            .is_err());
        let mut byte = [0_u8; 1];
        assert_eq!(
            timeout(Duration::from_secs(10), second.read(&mut byte))
                .await
                .expect("saturated proxy did not close second requester")
                .expect("read saturated requester"),
            0,
        );
        clear_cloud_transfer_proxies_in_state(&state)
            .await
            .expect("clear proxy");
    }
}
