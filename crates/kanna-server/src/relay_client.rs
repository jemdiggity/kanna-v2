use crate::{cloud_task_publisher::CloudTaskSnapshotEnvelope, config::Config};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{Error as TungsteniteError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
pub type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

pub(crate) const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub enum RelayConnectError {
    TimedOut { timeout: Duration },
    Failed(Box<dyn std::error::Error + Send + Sync>),
}

impl fmt::Display for RelayConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimedOut { timeout } => write!(
                formatter,
                "connect timed out after {} seconds",
                timeout.as_secs_f64()
            ),
            Self::Failed(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for RelayConnectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::TimedOut { .. } => None,
            Self::Failed(error) => Some(error.as_ref()),
        }
    }
}

const MAX_RELAY_HTTP_ERROR_REASON_BYTES: usize = 512;

#[derive(Debug)]
struct RelayHttpUpgradeError {
    status: String,
    reason: Option<String>,
}

impl fmt::Display for RelayHttpUpgradeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HTTP error: {}", self.status)?;
        if let Some(reason) = &self.reason {
            write!(f, ": {reason}")?;
        }
        Ok(())
    }
}

impl std::error::Error for RelayHttpUpgradeError {}

fn normalize_relay_http_error_reason(body: &[u8]) -> Option<String> {
    let body = std::str::from_utf8(body).ok()?;
    let mut normalized = String::new();
    let mut pending_space = false;
    let mut truncated = false;

    for character in body.chars() {
        if character.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if character.is_control() {
            return None;
        }

        let space_bytes = usize::from(pending_space);
        if normalized.len() + space_bytes + character.len_utf8() > MAX_RELAY_HTTP_ERROR_REASON_BYTES
        {
            truncated = true;
            break;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.push(character);
    }

    if normalized.is_empty() {
        return None;
    }
    if truncated {
        while normalized.len() + '…'.len_utf8() > MAX_RELAY_HTTP_ERROR_REASON_BYTES {
            normalized.pop();
        }
        normalized.push('…');
    }
    Some(normalized)
}

fn relay_connect_error(error: TungsteniteError) -> Box<dyn std::error::Error + Send + Sync> {
    match error {
        TungsteniteError::Http(response) => Box::new(RelayHttpUpgradeError {
            status: response.status().to_string(),
            reason: response
                .body()
                .as_deref()
                .and_then(normalize_relay_http_error_reason),
        }),
        error => Box::new(error),
    }
}

pub struct RelayAuthentication {
    pub user_id: String,
    pub capabilities: RelayCapabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountAuthProbe {
    Authorized,
    Rejected,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelService {
    #[default]
    Ksp,
    TaskTransfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RelayId {
    String(String),
    Number(u64),
}

impl fmt::Display for RelayId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(id) => f.write_str(id),
            Self::Number(id) => write!(f, "{id}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RelayInvoke {
    Command {
        command: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    Http {
        method: String,
        path: String,
        #[serde(default)]
        body: serde_json::Value,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCapabilities {
    #[serde(default)]
    pub task_snapshot_publication: Option<TaskSnapshotPublicationCapability>,
    #[serde(default)]
    pub mobile_notifications: Option<MobileNotificationsCapability>,
    #[serde(default)]
    pub desktop_routing: Option<DesktopRoutingCapability>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskSnapshotPublicationCapability {
    pub version: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MobileNotificationsCapability {
    pub version: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopRoutingCapability {
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNotificationPayload {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Ask the relay to resolve the delivery targets and explain a zero-target
    /// result without sending anything or spending rate-limit budget. This is
    /// how the desktop learns whether the signed-in account currently has a
    /// registered push device, through the one code path that decides it.
    /// Encoded as the distinct `mobile_notification_probe` wire message, so it
    /// is never serialized as part of this notification payload.
    #[serde(skip)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNotificationDelivery {
    pub accepted_count: u64,
    pub failed_count: u64,
    #[serde(default)]
    pub failure_reasons: Vec<MobileNotificationFailureReason>,
    /// Distinct device tokens the relay resolved. Absent from acknowledgements
    /// of a relay that predates the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targeted_device_count: Option<u64>,
    /// Why nothing was targeted; present exactly when the relay resolved zero
    /// devices. Never carries a token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_devices_reason: Option<MobileNotificationNoDevicesReason>,
}

/// The relay's explanation for a zero-target delivery, read from the account's
/// push-registration records: `neverRegistered`, `unregistered` (the mobile app
/// retired it, `retiredAt`), `tokenRejected` (the push provider rejected the
/// token as `providerCode` during a delivery for `retiredByDesktopId` at
/// `retiredAt`), or `unknown` (retired before the relay recorded why).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNotificationNoDevicesReason {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_by_desktop_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNotificationFailureReason {
    pub provider_code: String,
    pub category: String,
    pub count: u64,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RelayMessage {
    #[serde(rename = "auth")]
    Auth {
        #[serde(skip_serializing_if = "Option::is_none")]
        device_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        desktop_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        desktop_secret: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tunnel_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        anon_pub_key: Option<String>,
    },
    #[serde(rename = "auth_challenge")]
    AuthChallenge { nonce: String },
    #[serde(rename = "auth_proof")]
    AuthProof { signature: String },
    #[serde(rename = "invoke")]
    Invoke {
        id: RelayId,
        #[serde(rename = "desktopId", skip_serializing_if = "Option::is_none")]
        desktop_id: Option<String>,
        #[serde(flatten)]
        request: RelayInvoke,
    },
    #[serde(rename = "response")]
    Response {
        id: RelayId,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<serde_json::Value>,
    },
    #[serde(rename = "task_snapshot_publish")]
    TaskSnapshotPublish {
        id: String,
        snapshot: CloudTaskSnapshotEnvelope,
    },
    #[serde(rename = "task_snapshot_ack")]
    TaskSnapshotAck {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default)]
        retryable: bool,
    },
    #[serde(rename = "mobile_notification_publish")]
    MobileNotificationPublish {
        id: String,
        notification: MobileNotificationPayload,
    },
    /// Resolve notification targets without sending. Requires relay
    /// capability `mobileNotifications.version >= 2`; its distinct type keeps
    /// the operation safe even if a probe reaches an older relay.
    #[serde(rename = "mobile_notification_probe")]
    MobileNotificationProbe { id: String },
    #[serde(rename = "mobile_notification_ack")]
    MobileNotificationAck {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery: Option<MobileNotificationDelivery>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "anonymous_push_revoke")]
    AnonymousPushRevoke {
        id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    #[serde(rename = "event")]
    Event {
        name: String,
        payload: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "auth_ok")]
    AuthOk {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(default)]
        capabilities: RelayCapabilities,
    },
    #[serde(rename = "tunnel_establish")]
    TunnelEstablish {
        #[serde(rename = "desktopId")]
        desktop_id: String,
        #[serde(rename = "tunnelId")]
        tunnel_id: String,
        #[serde(default)]
        service: TunnelService,
    },
    #[serde(rename = "tunnel_ready")]
    TunnelReady {
        #[serde(rename = "desktopId")]
        desktop_id: String,
        #[serde(rename = "tunnelId")]
        tunnel_id: String,
        #[serde(default)]
        service: TunnelService,
    },
}

fn build_auth_message(config: &Config, tunnel_id: Option<String>) -> RelayMessage {
    match &config.desktop_secret {
        Some(desktop_secret) => RelayMessage::Auth {
            device_token: None,
            desktop_id: Some(config.desktop_id.clone()),
            desktop_secret: Some(desktop_secret.clone()),
            anon_pub_key: if tunnel_id.is_none() {
                crate::pairing::anonymous_push_public_key(config).ok()
            } else {
                None
            },
            tunnel_id,
        },
        None => match crate::pairing::anonymous_push_public_key(config) {
            Ok(public_key) => RelayMessage::Auth {
                device_token: None,
                desktop_id: None,
                desktop_secret: None,
                tunnel_id,
                anon_pub_key: Some(public_key),
            },
            Err(_) => RelayMessage::Auth {
                device_token: Some(config.device_token.clone()),
                desktop_id: Some(config.desktop_id.clone()),
                desktop_secret: None,
                tunnel_id,
                anon_pub_key: None,
            },
        },
    }
}

pub async fn connect_to_relay(
    config: &Config,
    timeout: Duration,
) -> Result<(WsSink, WsStream, Option<RelayAuthentication>), RelayConnectError> {
    match tokio::time::timeout(timeout, connect_to_relay_inner(config)).await {
        Ok(result) => result.map_err(RelayConnectError::Failed),
        Err(_) => Err(RelayConnectError::TimedOut { timeout }),
    }
}

async fn connect_to_relay_inner(
    config: &Config,
) -> Result<(WsSink, WsStream, Option<RelayAuthentication>), Box<dyn std::error::Error + Send + Sync>>
{
    let (ws_stream, _response) = connect_async(&config.relay_url)
        .await
        .map_err(relay_connect_error)?;
    let (mut sink, mut stream) = ws_stream.split();

    // Send auth message immediately after connecting
    let auth = build_auth_message(config, None);
    let anonymous_auth = matches!(
        &auth,
        RelayMessage::Auth {
            anon_pub_key: Some(_),
            ..
        }
    );
    let auth_json = serde_json::to_string(&auth)?;
    sink.send(Message::Text(auth_json.into())).await?;

    let authentication = if anonymous_auth {
        let challenge = stream
            .next()
            .await
            .ok_or("relay closed before anonymous auth challenge")??;
        let RelayMessage::AuthChallenge { nonce } =
            serde_json::from_str::<RelayMessage>(challenge.to_text()?)?
        else {
            return Err("relay did not issue an anonymous auth challenge".into());
        };
        let (_, signature) = crate::pairing::sign_anonymous_push_auth_challenge(config, &nonce)?;
        sink.send(Message::Text(
            serde_json::to_string(&RelayMessage::AuthProof { signature })?.into(),
        ))
        .await?;
        let auth_ok = stream
            .next()
            .await
            .ok_or("relay closed before anonymous auth completed")??;
        parse_authentication(auth_ok, "anonymous push")?
    } else {
        let auth_ok = stream
            .next()
            .await
            .ok_or("relay closed before authentication completed")??;
        parse_authentication(auth_ok, "desktop")?
    };

    log::info!("Authenticated with relay");

    Ok((sink, stream, Some(authentication)))
}

fn parse_authentication(
    message: Message,
    credential_kind: &str,
) -> Result<RelayAuthentication, Box<dyn std::error::Error + Send + Sync>> {
    let text = message.to_text().map_err(|error| {
        format!("relay returned a non-text {credential_kind} authentication frame: {error}")
    })?;
    let parsed = serde_json::from_str::<RelayMessage>(text).map_err(|error| {
        let preview = normalize_relay_http_error_reason(text.as_bytes())
            .unwrap_or_else(|| "<empty or non-printable body>".to_string());
        format!(
            "relay returned invalid JSON during {credential_kind} authentication: {error}; body: {preview}"
        )
    })?;
    match parsed {
        RelayMessage::AuthOk {
            user_id,
            capabilities,
        } => Ok(RelayAuthentication {
            user_id,
            capabilities,
        }),
        RelayMessage::Error { message } => {
            Err(format!("relay refused {credential_kind} authentication: {message}").into())
        }
        _ => Err(format!("relay refused {credential_kind} authentication").into()),
    }
}

pub async fn connect_anonymous_push_to_relay(
    config: &Config,
) -> Result<(WsSink, WsStream), Box<dyn std::error::Error + Send + Sync>> {
    let public_key = crate::pairing::anonymous_push_public_key(config)?;
    let (ws_stream, _) = connect_async(&config.relay_url).await?;
    let (mut sink, mut stream) = ws_stream.split();
    sink.send(Message::Text(
        serde_json::to_string(&RelayMessage::Auth {
            device_token: None,
            desktop_id: None,
            desktop_secret: None,
            tunnel_id: None,
            anon_pub_key: Some(public_key),
        })?
        .into(),
    ))
    .await?;
    let challenge = stream
        .next()
        .await
        .ok_or("relay closed before anonymous auth challenge")??;
    let RelayMessage::AuthChallenge { nonce } =
        serde_json::from_str::<RelayMessage>(challenge.to_text()?)?
    else {
        return Err("relay did not issue an anonymous auth challenge".into());
    };
    let (_, signature) = crate::pairing::sign_anonymous_push_auth_challenge(config, &nonce)?;
    sink.send(Message::Text(
        serde_json::to_string(&RelayMessage::AuthProof { signature })?.into(),
    ))
    .await?;
    let auth_ok = stream
        .next()
        .await
        .ok_or("relay closed before anonymous auth completed")??;
    if !matches!(
        serde_json::from_str::<RelayMessage>(auth_ok.to_text()?)?,
        RelayMessage::AuthOk { .. }
    ) {
        return Err("relay refused anonymous push authentication".into());
    }
    Ok((sink, stream))
}

/// Distinguish a signed-out desktop (the relay authoritatively rejected its
/// local credential) from a relay outage. The caller uses only the former to
/// enter the lazy anonymous notification mode; outages retain normal account
/// reconnect behavior.
pub async fn probe_account_auth(config: &Config) -> AccountAuthProbe {
    if config.desktop_secret.is_none() {
        return AccountAuthProbe::Rejected;
    }
    let attempt = async {
        let (mut socket, _) = connect_async(&config.relay_url).await?;
        socket
            .send(Message::Text(
                serde_json::to_string(&build_auth_message(config, None))?.into(),
            ))
            .await?;
        while let Some(frame) = socket.next().await {
            match frame? {
                Message::Text(text) => match serde_json::from_str::<RelayMessage>(&text) {
                    Ok(RelayMessage::AuthChallenge { nonce }) => {
                        let Ok((_, signature)) =
                            crate::pairing::sign_anonymous_push_auth_challenge(config, &nonce)
                        else {
                            return Ok(AccountAuthProbe::Unavailable);
                        };
                        socket
                            .send(Message::Text(
                                serde_json::to_string(&RelayMessage::AuthProof { signature })?
                                    .into(),
                            ))
                            .await?;
                    }
                    Ok(RelayMessage::AuthOk { .. }) => {
                        let _ = socket.close(None).await;
                        return Ok(AccountAuthProbe::Authorized);
                    }
                    _ => {}
                },
                Message::Close(frame) => {
                    return Ok(
                        if frame
                            .as_ref()
                            .is_some_and(|frame| u16::from(frame.code) == 4005)
                        {
                            AccountAuthProbe::Rejected
                        } else {
                            AccountAuthProbe::Unavailable
                        },
                    );
                }
                _ => {}
            }
        }
        Ok::<AccountAuthProbe, Box<dyn std::error::Error + Send + Sync>>(
            AccountAuthProbe::Unavailable,
        )
    };
    match tokio::time::timeout(std::time::Duration::from_secs(10), attempt).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) | Err(_) => AccountAuthProbe::Unavailable,
    }
}

pub async fn connect_tunnel_to_relay(
    config: &Config,
    tunnel_id: String,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, Box<dyn std::error::Error + Send + Sync>> {
    let (mut ws_stream, _response) = connect_async(&config.relay_url).await?;

    let auth = build_auth_message(config, Some(tunnel_id.clone()));
    ws_stream
        .send(Message::Text(serde_json::to_string(&auth)?.into()))
        .await?;

    Ok(ws_stream)
}

#[cfg(test)]
mod tests {
    use super::{Duration, Message};
    use crate::config::Config;
    use futures_util::StreamExt;

    async fn start_refusing_relay(body: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind refusing relay");
        let address = listener.local_addr().expect("refusing relay address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept relay client");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.expect("read upgrade request");
                assert!(
                    read > 0,
                    "relay client closed before sending upgrade headers"
                );
                request.extend_from_slice(&chunk[..read]);
            }
            let headers = format!(
                "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            stream
                .write_all(headers.as_bytes())
                .await
                .expect("write refusal headers");
            stream.write_all(&body).await.expect("write refusal body");
            stream.shutdown().await.expect("finish refusal response");
        });
        (format!("ws://{address}"), server)
    }

    fn test_config() -> Config {
        Config {
            relay_url: "ws://127.0.0.1:9080".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: "/tmp/kanna.db".to_string(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: None,
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        }
    }

    #[tokio::test]
    async fn authentication_acknowledgement_is_inside_the_connect_timeout() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind auth-stalling relay");
        let address = listener.local_addr().expect("auth-stalling relay address");
        let relay = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept relay TCP");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept relay WebSocket");
            let auth = socket
                .next()
                .await
                .expect("auth request")
                .expect("valid auth request");
            assert!(matches!(auth, Message::Text(_)));
            socket.next().await
        });
        let mut config = test_config();
        config.relay_url = format!("ws://{address}");

        let error = match super::connect_to_relay(&config, Duration::from_millis(100)).await {
            Ok(_) => panic!("relay connected without an auth acknowledgement"),
            Err(error) => error,
        };
        assert!(matches!(error, super::RelayConnectError::TimedOut { .. }));
        let close = tokio::time::timeout(Duration::from_secs(1), relay)
            .await
            .expect("timed-out auth socket stayed open")
            .expect("auth-stalling relay task failed");
        assert!(!matches!(close, Some(Ok(_))));
    }

    #[tokio::test]
    async fn connection_error_includes_normalized_real_http_refusal_reason() {
        let (relay_url, server) = start_refusing_relay(
            b"  too many unauthenticated\r\nconnections from this address\t\n".to_vec(),
        )
        .await;
        let mut config = test_config();
        config.relay_url = relay_url;

        let error = match super::connect_to_relay(&config, Duration::from_secs(1)).await {
            Ok(_) => panic!("HTTP refusal unexpectedly upgraded to WebSocket"),
            Err(error) => error,
        };
        server.await.expect("refusing relay task");

        assert_eq!(
            error.to_string(),
            "HTTP error: 429 Too Many Requests: too many unauthenticated connections from this address"
        );
    }

    #[test]
    fn invalid_http_refusal_body_keeps_status_only_fallback() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(503)
            .body(Some(vec![0xff, 0xfe]))
            .unwrap();
        let error =
            super::relay_connect_error(tokio_tungstenite::tungstenite::Error::Http(response));

        assert_eq!(error.to_string(), "HTTP error: 503 Service Unavailable");
    }

    #[test]
    fn http_refusal_reason_is_bounded_in_utf8_bytes() {
        let reason = super::normalize_relay_http_error_reason("é".repeat(400).as_bytes()).unwrap();

        assert!(reason.len() <= super::MAX_RELAY_HTTP_ERROR_REASON_BYTES);
        assert!(reason.ends_with('…'));
    }

    #[test]
    fn build_auth_message_uses_legacy_device_token_when_desktop_secret_is_missing() {
        let auth = super::build_auth_message(&test_config(), None);
        let payload = serde_json::to_value(auth).unwrap();

        assert_eq!(
            payload,
            serde_json::json!({
                "type": "auth",
                "device_token": "device-token",
                "desktop_id": "desktop-1"
            })
        );
    }

    #[test]
    fn build_auth_message_prefers_desktop_credentials_when_available() {
        let mut config = test_config();
        config.desktop_secret = Some("desktop-secret".to_string());

        let auth = super::build_auth_message(&config, None);
        let payload = serde_json::to_value(auth).unwrap();

        assert_eq!(
            payload,
            serde_json::json!({
                "type": "auth",
                "desktop_id": "desktop-1",
                "desktop_secret": "desktop-secret"
            })
        );
    }

    #[test]
    fn build_auth_message_adds_the_pair_scoped_identity_to_account_auth() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = test_config();
        config.desktop_secret = Some("desktop-secret".to_string());
        config.pairing_store_path = temp.path().join("pairings.json").display().to_string();
        let mut active = Some(crate::pairing::create_active_pairing_session(&config).unwrap());
        let code = active.as_ref().unwrap().session.code.clone();
        let claimed = crate::pairing::claim_pairing_session(
            &config,
            &mut active,
            crate::pairing::PairingClaimRequest {
                code,
                device_id: "phone-dual-auth".to_string(),
                device_name: "Kanna Mobile".to_string(),
            },
        )
        .unwrap();

        let payload = serde_json::to_value(super::build_auth_message(&config, None)).unwrap();

        assert_eq!(payload["desktop_id"], "desktop-1");
        assert_eq!(payload["desktop_secret"], "desktop-secret");
        assert_eq!(
            payload["anon_pub_key"],
            claimed.desktop_push_identity.public_key
        );
    }

    #[test]
    fn build_auth_message_includes_tunnel_id_for_tunnel_socket() {
        let mut config = test_config();
        config.desktop_secret = Some("desktop-secret".to_string());

        let auth = super::build_auth_message(&config, Some("tunnel-1".to_string()));
        let payload = serde_json::to_value(auth).unwrap();

        assert_eq!(
            payload,
            serde_json::json!({
                "type": "auth",
                "desktop_id": "desktop-1",
                "desktop_secret": "desktop-secret",
                "tunnel_id": "tunnel-1"
            })
        );
    }

    #[test]
    fn task_snapshot_ack_deserializes_for_server_retry_state() {
        let message: super::RelayMessage = serde_json::from_value(serde_json::json!({
            "type": "task_snapshot_ack",
            "id": "task-snapshot-9",
            "ok": false,
            "error": "credential revoked"
        }))
        .expect("task snapshot ack should deserialize");

        let super::RelayMessage::TaskSnapshotAck {
            id,
            ok,
            error,
            retryable,
        } = message
        else {
            panic!("expected task snapshot ack");
        };
        assert_eq!(id, "task-snapshot-9");
        assert!(!ok);
        assert!(!retryable);
        assert_eq!(error.as_deref(), Some("credential revoked"));

        let retryable: super::RelayMessage = serde_json::from_value(serde_json::json!({
            "type": "task_snapshot_ack",
            "id": "task-snapshot-10",
            "ok": false,
            "error": "firestore unavailable",
            "retryable": true
        }))
        .expect("retryable task snapshot ack should deserialize");
        assert!(matches!(
            retryable,
            super::RelayMessage::TaskSnapshotAck {
                retryable: true,
                ..
            }
        ));
    }

    #[test]
    fn tunnel_establish_deserializes_task_transfer_service() {
        let message: super::RelayMessage = serde_json::from_value(serde_json::json!({
            "type": "tunnel_establish",
            "desktopId": "desktop-1",
            "tunnelId": "tunnel-transfer-1",
            "service": "task-transfer"
        }))
        .expect("task-transfer tunnel should deserialize");

        let super::RelayMessage::TunnelEstablish {
            desktop_id,
            tunnel_id,
            service,
        } = message
        else {
            panic!("expected tunnel establish");
        };
        assert_eq!(desktop_id, "desktop-1");
        assert_eq!(tunnel_id, "tunnel-transfer-1");
        assert_eq!(service, super::TunnelService::TaskTransfer);
    }

    #[test]
    fn tunnel_establish_defaults_missing_service_to_ksp() {
        let message: super::RelayMessage = serde_json::from_value(serde_json::json!({
            "type": "tunnel_establish",
            "desktopId": "desktop-1",
            "tunnelId": "tunnel-ksp-1"
        }))
        .expect("legacy KSP tunnel should deserialize");

        let super::RelayMessage::TunnelEstablish { service, .. } = message else {
            panic!("expected tunnel establish");
        };
        assert_eq!(service, super::TunnelService::Ksp);
    }

    #[test]
    fn numeric_invoke_id_round_trips_in_response() {
        let invoke: super::RelayMessage = serde_json::from_value(serde_json::json!({
            "type": "invoke",
            "id": 42,
            "command": "list_repos",
            "args": {}
        }))
        .expect("numeric relay invoke should deserialize");

        let super::RelayMessage::Invoke { id, .. } = invoke else {
            panic!("expected invoke message");
        };

        let response = super::RelayMessage::Response {
            id,
            data: Some(serde_json::json!([])),
            error: None,
            status: None,
            body: None,
        };
        let serialized = serde_json::to_value(response).unwrap();

        assert_eq!(serialized["id"], 42);
    }

    #[tokio::test]
    async fn http_style_invoke_dispatches_status_and_echoes_string_id() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let invoke: super::RelayMessage = serde_json::from_value(serde_json::json!({
            "type": "invoke",
            "id": "http-1",
            "method": "GET",
            "path": "/v1/status",
            "body": null
        }))
        .expect("HTTP-style relay invoke should deserialize");

        let super::RelayMessage::Invoke { id, request, .. } = invoke else {
            panic!("expected invoke message");
        };
        let super::RelayInvoke::Http { method, path, body } = request else {
            panic!("expected HTTP invoke message");
        };
        assert_eq!(method, "GET");
        assert_eq!(path, "/v1/status");
        assert_eq!(body, serde_json::Value::Null);

        let app = crate::http_api::router(std::sync::Arc::new(crate::http_api::AppState::new(
            test_config(),
        )));
        let status_response = app
            .oneshot(Request::get("/v1/status").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(status_response.status(), axum::http::StatusCode::OK);

        let body = axum::body::to_bytes(status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let mut status_body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        // This test pins the relay envelope, not the catalog's contents — that
        // list is asserted in `crates/kanna-tool-catalog/tests/catalog.rs`.
        let advertised = status_body
            .as_object_mut()
            .and_then(|body| body.remove("agentApiTools"));
        assert!(
            advertised.is_some_and(|tools| tools.as_array().is_some_and(|tools| !tools.is_empty())),
            "status must advertise the agent-API surface so clients can detect version skew"
        );
        // Likewise the provider inventory: which agent CLIs resolve depends on
        // the machine running the test. Its contents are asserted against a
        // controlled PATH in `tests/agent_provider_inventory_http.rs`.
        let inventory = status_body
            .as_object_mut()
            .and_then(|body| body.remove("agentProviders"));
        assert!(
            inventory.is_some_and(|providers| providers.is_array()),
            "status must report which agent providers this machine can run"
        );

        let response = super::RelayMessage::Response {
            id,
            data: None,
            error: None,
            status: Some(200),
            body: Some(status_body),
        };
        let serialized = serde_json::to_value(response).unwrap();

        assert_eq!(
            serialized,
            serde_json::json!({
                "type": "response",
                "id": "http-1",
                "status": 200,
                "body": {
                    "state": "running",
                    "desktopId": "desktop-1",
                    "desktopName": "Studio Mac",
                    "version": "test-version",
                    "environment": "development",
                    "serverVersion": "test-version",
                    "kspStreamVersion": 2,
                "taskInputAttachmentVersion": 1,
                    "lanHost": "127.0.0.1",
                    "lanPort": 48120,
                    "pairingCode": null,
                    "writePathHealth": {
                        "healthy": true,
                        "status": "healthy",
                        "activeWorkspaceCommands": 0,
                        "maxWorkspaceCommands": 4,
                        "longRunningWorkspaceCommands": 0,
                        "oldestWorkspaceCommandSeconds": null
                    }
                }
            })
        );
    }
}
