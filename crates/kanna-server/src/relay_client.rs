use crate::{cloud_task_publisher::CloudTaskSnapshotEnvelope, config::Config};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::fmt;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
pub type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNotificationDelivery {
    pub accepted_count: u64,
    pub failed_count: u64,
    #[serde(default)]
    pub failure_reasons: Vec<MobileNotificationFailureReason>,
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
    },
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
    },
    #[serde(rename = "mobile_notification_publish")]
    MobileNotificationPublish {
        id: String,
        notification: MobileNotificationPayload,
    },
    #[serde(rename = "mobile_notification_ack")]
    MobileNotificationAck {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery: Option<MobileNotificationDelivery>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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
            tunnel_id,
        },
        None => RelayMessage::Auth {
            device_token: Some(config.device_token.clone()),
            desktop_id: Some(config.desktop_id.clone()),
            desktop_secret: None,
            tunnel_id,
        },
    }
}

pub async fn connect_to_relay(
    config: &Config,
) -> Result<(WsSink, WsStream), Box<dyn std::error::Error + Send + Sync>> {
    let (ws_stream, _response) = connect_async(&config.relay_url).await?;
    let (mut sink, stream) = ws_stream.split();

    // Send auth message immediately after connecting
    let auth = build_auth_message(config, None);
    let auth_json = serde_json::to_string(&auth)?;
    sink.send(Message::Text(auth_json.into())).await?;

    log::info!("Authenticated with relay");

    Ok((sink, stream))
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
    use crate::config::Config;

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
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        }
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

        let super::RelayMessage::TaskSnapshotAck { id, ok, error } = message else {
            panic!("expected task snapshot ack");
        };
        assert_eq!(id, "task-snapshot-9");
        assert!(!ok);
        assert_eq!(error.as_deref(), Some("credential revoked"));
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
