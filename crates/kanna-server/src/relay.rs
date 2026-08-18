use crate::{
    cloud_task_publisher::{map_ui_snapshot, PublisherState, PublisherStep},
    commands,
    config::Config,
    daemon_client, db, http_api, relay_client, task_transfer_tunnel,
};
use futures_util::{SinkExt, StreamExt};
use relay_client::{RelayId, RelayInvoke, RelayMessage, TunnelService};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;

const RELAY_PING_INTERVAL: Duration = Duration::from_secs(30);
const RELAY_PONG_TIMEOUT: Duration = Duration::from_secs(75);
const TASK_SNAPSHOT_POLL_INTERVAL: Duration = Duration::from_millis(500);

enum PendingDesktopRequest {
    ListActive {
        response: tokio::sync::oneshot::Sender<Result<Vec<String>, String>>,
    },
    Invoke {
        response: tokio::sync::oneshot::Sender<Result<crate::http_api::HttpInvokeResponse, String>>,
    },
}

fn cloud_task_publication_enabled(desktop_secret: Option<&str>) -> bool {
    desktop_secret.is_some_and(|secret| !secret.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayKeepaliveAction {
    SendPing,
    Reconnect,
}

struct RelayKeepalive {
    pending_ping_sent_at: Option<Instant>,
}

impl RelayKeepalive {
    fn new() -> Self {
        Self {
            pending_ping_sent_at: None,
        }
    }

    fn on_inbound_message(&mut self, _now: Instant) {
        self.pending_ping_sent_at = None;
    }

    fn on_ping_tick(&mut self, now: Instant) -> RelayKeepaliveAction {
        if let Some(sent_at) = self.pending_ping_sent_at {
            if now.duration_since(sent_at) >= RELAY_PONG_TIMEOUT {
                return RelayKeepaliveAction::Reconnect;
            }
            return RelayKeepaliveAction::SendPing;
        }

        self.pending_ping_sent_at = Some(now);
        RelayKeepaliveAction::SendPing
    }
}

pub(crate) async fn run_relay_loop(
    config: Config,
    db: db::Db,
    http_state: Arc<http_api::AppState>,
) -> Result<(), String> {
    let mut publisher = PublisherState::new();
    let mut mobile_notification_requests = http_state.take_mobile_notification_requests()?;
    let mut desktop_relay_requests = http_state.take_desktop_relay_requests()?;
    let mut next_mobile_notification_id = 1_u64;
    let mut next_desktop_request_id = 1_u64;

    // Reconnection loop
    loop {
        http_state.set_desktop_routing_available(false);
        http_state.set_mobile_notifications_available(false);
        log::info!("Connecting to relay at {}...", config.relay_url);

        let (sink, mut stream) = match relay_client::connect_to_relay(&config).await {
            Ok(pair) => pair,
            Err(e) => {
                log::error!("Failed to connect to relay: {}", e);
                log::info!("Retrying in 5 seconds...");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };

        log::info!("Connected to relay");

        // Wrap sink in Arc<Mutex> so observer tasks can share it
        let sink = Arc::new(Mutex::new(sink));

        // Track observer tasks per session_id
        let mut observe_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();
        let mut pending_mobile_notifications = HashMap::new();
        let mut pending_desktop_requests = HashMap::new();
        // HTTP invokes dispatch off the read loop; this caps how many run at
        // once so a burst cannot exhaust the blocking pool. Mirrors the KSP
        // request worker's CPU-aware concurrency.
        let invoke_permits = Arc::new(RelayHttpInvokePermits::new(
            crate::ksp::request_concurrency(),
        ));
        let mut keepalive = RelayKeepalive::new();
        let mut ping_interval = tokio::time::interval(RELAY_PING_INTERVAL);
        ping_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ping_interval.tick().await;
        let mut publication_interval = tokio::time::interval(TASK_SNAPSHOT_POLL_INTERVAL);
        publication_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let publication_enabled = cloud_task_publication_enabled(config.desktop_secret.as_deref());
        let mut authenticated_user_id: Option<String> = None;
        let mut routing_generation = 0;

        // Message processing loop
        loop {
            let msg = tokio::select! {
                _ = http_state.wait_for_cloud_relay_reconnect() => {
                    log::info!("Cloud relay reconnect requested by the local desktop");
                    break;
                }
                _ = publication_interval.tick(), if publication_enabled => {
                    match db.ui_snapshot() {
                        Ok(snapshot) => publisher.observe(map_ui_snapshot(
                            &config.desktop_id,
                            &config.desktop_name,
                            crate::agent_inventory::installed_agent_providers(),
                            snapshot,
                        )),
                        Err(error) => log::warn!("Failed to build cloud task snapshot: {error}"),
                    }
                    match publisher.next_step(Instant::now()) {
                        PublisherStep::Publish(request) => {
                            let message = RelayMessage::TaskSnapshotPublish {
                                id: request.id,
                                snapshot: request.snapshot,
                            };
                            if let Err(error) = send_relay_response_message(&sink, message).await {
                                log::error!("Failed to publish cloud task snapshot: {error}");
                                break;
                            }
                        }
                        PublisherStep::Reconnect => {
                            log::warn!("Cloud task snapshot retries exhausted; reconnecting relay");
                            break;
                        }
                        PublisherStep::Wait => {}
                    }
                    continue;
                }
                request = mobile_notification_requests.recv() => {
                    let Some(request) = request else {
                        return Err("mobile notification request channel closed".to_string());
                    };
                    if !http_state.mobile_notifications_available() {
                        let _ = request.response.send(Err(
                            "mobile notification relay is unavailable".to_string(),
                        ));
                        continue;
                    }

                    let id = format!(
                        "mobile-notification:{}:{}",
                        config.desktop_id, next_mobile_notification_id
                    );
                    next_mobile_notification_id =
                        next_mobile_notification_id.wrapping_add(1).max(1);
                    pending_mobile_notifications.insert(id.clone(), request.response);
                    let message = RelayMessage::MobileNotificationPublish {
                        id: id.clone(),
                        notification: request.notification,
                    };
                    if let Err(error) = send_relay_response_message(&sink, message).await {
                        if let Some(response) = pending_mobile_notifications.remove(&id) {
                            let _ = response.send(Err(error.clone()));
                        }
                        log::error!("Failed to publish mobile notification: {error}");
                        break;
                    }
                    continue;
                }
                request = desktop_relay_requests.recv() => {
                    let Some(request) = request else {
                        return Err("desktop relay request channel closed".to_string());
                    };
                    let id = format!(
                        "desktop-request:{}:{}",
                        config.desktop_id, next_desktop_request_id
                    );
                    next_desktop_request_id = next_desktop_request_id.wrapping_add(1).max(1);
                    let (request_generation, message, pending) = match request {
                        http_api::DesktopRelayRequest::ListActive { generation, response } => (
                            generation,
                            RelayMessage::Invoke {
                                id: RelayId::String(id.clone()),
                                desktop_id: None,
                                request: RelayInvoke::Command {
                                    command: "list_active_desktops".to_string(),
                                    args: serde_json::json!({}),
                                },
                            },
                            PendingDesktopRequest::ListActive { response },
                        ),
                        http_api::DesktopRelayRequest::Invoke {
                            generation,
                            desktop_id,
                            method,
                            path,
                            body,
                            response,
                        } => (
                            generation,
                            RelayMessage::Invoke {
                                id: RelayId::String(id.clone()),
                                desktop_id: Some(desktop_id),
                                request: RelayInvoke::Http { method, path, body },
                            },
                            PendingDesktopRequest::Invoke { response },
                        ),
                    };
                    if request_generation != routing_generation {
                        fail_pending_desktop_request(
                            pending,
                            "desktop relay connection changed before the request was sent"
                                .to_string(),
                        );
                        continue;
                    }
                    pending_desktop_requests.insert(id.clone(), pending);
                    if let Err(error) = send_relay_response_message(&sink, message).await {
                        if let Some(request) = pending_desktop_requests.remove(&id) {
                            fail_pending_desktop_request(request, error.clone());
                        }
                        log::error!("Failed to send desktop relay request: {error}");
                        break;
                    }
                    continue;
                }
                _ = ping_interval.tick() => {
                    match keepalive.on_ping_tick(Instant::now()) {
                        RelayKeepaliveAction::SendPing => {
                            if let Err(e) = sink.lock().await.send(Message::Ping(Vec::new().into())).await {
                                log::error!("Failed to send relay ping: {}", e);
                                break;
                            }
                        }
                        RelayKeepaliveAction::Reconnect => {
                            log::warn!("Relay keepalive timed out; reconnecting");
                            break;
                        }
                    }
                    continue;
                }
                msg_result = stream.next() => {
                    let Some(msg_result) = msg_result else {
                        log::info!("Relay WebSocket stream ended");
                        break;
                    };
                    match msg_result {
                        Ok(m) => m,
                        Err(e) => {
                            log::error!("WebSocket error: {}", e);
                            break;
                        }
                    }
                }
            };
            keepalive.on_inbound_message(Instant::now());

            match msg {
                Message::Text(text) => {
                    let parsed: RelayMessage = match serde_json::from_str(&text) {
                        Ok(m) => m,
                        Err(e) => {
                            log::warn!("Failed to parse relay message: {} — raw: {}", e, text);
                            continue;
                        }
                    };

                    match parsed {
                        RelayMessage::Invoke { id, request, .. } => match request {
                            RelayInvoke::Command { command, args } => {
                                log::info!("Invoke #{}: {}", id, command);

                                // Special-case: observe_session needs a long-lived daemon connection
                                if command == "observe_session" {
                                    let session_id =
                                        match args.get("session_id").and_then(|v| v.as_str()) {
                                            Some(s) => s.to_string(),
                                            None => {
                                                send_response(
                                                    &sink,
                                                    id,
                                                    Err("missing required arg: session_id"
                                                        .to_string()),
                                                )
                                                .await;
                                                continue;
                                            }
                                        };

                                    // Cancel existing observer for this session
                                    if let Some(handle) = observe_tasks.remove(&session_id) {
                                        handle.abort();
                                        log::info!(
                                            "Aborted existing observer for session {}",
                                            session_id
                                        );
                                    }

                                    // Create dedicated daemon connection for observing
                                    let mut obs_daemon = match daemon_client::DaemonClient::connect(
                                        &config.daemon_dir,
                                    )
                                    .await
                                    {
                                        Ok(d) => d,
                                        Err(e) => {
                                            log::error!(
                                                "Failed to connect to daemon for observe: {}",
                                                e
                                            );
                                            send_response(
                                                &sink,
                                                id,
                                                Err(format!("daemon connection failed: {}", e)),
                                            )
                                            .await;
                                            continue;
                                        }
                                    };

                                    // Atomic observer cutover: the reply to
                                    // ObserveSnapshot is the authoritative
                                    // snapshot itself, queued ahead of every
                                    // later Output on this connection — no
                                    // pre-snapshot Output to discard, no
                                    // Output racing ahead of the snapshot.
                                    use kanna_daemon::protocol::{
                                        Command as DaemonCommand, Event as DaemonEvent,
                                    };
                                    match obs_daemon
                                        .send_command(&DaemonCommand::ObserveSnapshot {
                                            session_id: session_id.clone(),
                                        })
                                        .await
                                    {
                                        Ok(DaemonEvent::Snapshot { snapshot, .. }) => {
                                            // Send success response
                                            send_response(&sink, id, Ok(serde_json::Value::Null))
                                                .await;

                                            // Spawn background task to forward the cutover
                                            // snapshot and then every later daemon event.
                                            let sink_clone = Arc::clone(&sink);
                                            let sid = session_id.clone();
                                            let handle = tokio::spawn(async move {
                                                observer_loop(
                                                    obs_daemon, &sid, sink_clone, snapshot,
                                                )
                                                .await;
                                            });
                                            observe_tasks.insert(session_id, handle);
                                        }
                                        Ok(DaemonEvent::Error { message, .. }) => {
                                            send_response(
                                                &sink,
                                                id,
                                                Err(format!("daemon error: {}", message)),
                                            )
                                            .await;
                                        }
                                        Ok(other) => {
                                            send_response(
                                                &sink,
                                                id,
                                                Err(format!(
                                                    "unexpected daemon response: {:?}",
                                                    other
                                                )),
                                            )
                                            .await;
                                        }
                                        Err(e) => {
                                            send_response(
                                                &sink,
                                                id,
                                                Err(format!("daemon error: {}", e)),
                                            )
                                            .await;
                                        }
                                    }
                                    continue;
                                }

                                // Special-case: unobserve_session just aborts the observer task
                                if command == "unobserve_session" {
                                    let session_id =
                                        match args.get("session_id").and_then(|v| v.as_str()) {
                                            Some(s) => s.to_string(),
                                            None => {
                                                send_response(
                                                    &sink,
                                                    id,
                                                    Err("missing required arg: session_id"
                                                        .to_string()),
                                                )
                                                .await;
                                                continue;
                                            }
                                        };

                                    if let Some(handle) = observe_tasks.remove(&session_id) {
                                        handle.abort();
                                        log::info!("Detached observer for session {}", session_id);
                                    }

                                    send_response(&sink, id, Ok(serde_json::Value::Null)).await;
                                    continue;
                                }

                                // Normal commands: short-lived daemon connection
                                let daemon_result =
                                    daemon_client::DaemonClient::connect(&config.daemon_dir).await;

                                let response = match daemon_result {
                                    Ok(mut daemon) => {
                                        match commands::handle_invoke(
                                            &command,
                                            &args,
                                            &db,
                                            &mut daemon,
                                            &config,
                                            &http_state.session_replacements(),
                                        )
                                        .await
                                        {
                                            Ok(data) => RelayMessage::Response {
                                                id,
                                                data: Some(data),
                                                error: None,
                                                status: None,
                                                body: None,
                                            },
                                            Err(e) => {
                                                log::error!("Invoke #{} error: {}", id, e);
                                                RelayMessage::Response {
                                                    id,
                                                    data: None,
                                                    error: Some(e),
                                                    status: None,
                                                    body: None,
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        log::error!(
                                            "Failed to connect to daemon for invoke #{}: {}",
                                            id,
                                            e
                                        );
                                        RelayMessage::Response {
                                            id,
                                            data: None,
                                            error: Some(format!("daemon connection failed: {}", e)),
                                            status: None,
                                            body: None,
                                        }
                                    }
                                };

                                if let Err(e) = send_relay_response_message(&sink, response).await {
                                    log::error!("{}", e);
                                    break;
                                }
                            }
                            RelayInvoke::Http { method, path, body } => {
                                log::info!("HTTP invoke #{}: {} {}", id, method, path);

                                if let Err(e) = dispatch_relay_http_invoke(
                                    Arc::clone(&http_state),
                                    Arc::clone(&sink),
                                    Arc::clone(&invoke_permits),
                                    RelayHttpInvokeRequest {
                                        id,
                                        method,
                                        path,
                                        body,
                                        authenticated_user_id: authenticated_user_id.clone(),
                                    },
                                )
                                .await
                                {
                                    log::error!("{}", e);
                                    break;
                                }
                            }
                        },
                        RelayMessage::AuthOk {
                            user_id,
                            capabilities,
                        } => {
                            log::info!("Relay authenticated as user {}", user_id);
                            authenticated_user_id = Some(user_id.clone());
                            if capabilities
                                .desktop_routing
                                .as_ref()
                                .is_some_and(|capability| capability.version >= 1)
                            {
                                routing_generation = http_state.set_desktop_routing_available(true);
                            } else {
                                http_state.set_desktop_routing_available(false);
                            }
                            publisher.on_authenticated(
                                capabilities
                                    .task_snapshot_publication
                                    .map(|capability| capability.version),
                            );
                            http_state.set_mobile_notifications_available(
                                capabilities
                                    .mobile_notifications
                                    .is_some_and(|capability| capability.version >= 1),
                            );
                        }
                        RelayMessage::TaskSnapshotAck { id, ok, error } => {
                            if let Err(message) =
                                publisher.on_ack(&id, ok, error.clone(), Instant::now())
                            {
                                log::warn!("{message}");
                            } else if !ok {
                                log::warn!(
                                    "Relay rejected cloud task snapshot {id}: {}",
                                    error.as_deref().unwrap_or("unknown error")
                                );
                            }
                        }
                        RelayMessage::MobileNotificationAck {
                            id,
                            ok,
                            delivery,
                            error,
                        } => {
                            let Some(response) = pending_mobile_notifications.remove(&id) else {
                                log::warn!(
                                    "Ignoring mobile notification ack for unknown request {id}"
                                );
                                continue;
                            };
                            let result = if ok {
                                delivery.ok_or_else(|| {
                                    "relay accepted mobile notification without delivery status"
                                        .to_string()
                                })
                            } else {
                                Err(error.unwrap_or_else(|| {
                                    "relay rejected mobile notification".to_string()
                                }))
                            };
                            let _ = response.send(result);
                        }
                        RelayMessage::Response {
                            id,
                            data,
                            error,
                            status,
                            body,
                        } => {
                            let id = id.to_string();
                            let Some(request) = pending_desktop_requests.remove(&id) else {
                                log::warn!("Ignoring relay response for unknown request {id}");
                                continue;
                            };
                            resolve_pending_desktop_request(request, data, error, status, body);
                        }
                        RelayMessage::TunnelEstablish {
                            desktop_id,
                            tunnel_id,
                            service,
                        } => {
                            if desktop_id != config.desktop_id {
                                log::warn!(
                                    "Ignoring tunnel {} for unexpected desktop {}",
                                    tunnel_id,
                                    desktop_id
                                );
                                continue;
                            }
                            let tunnel_config = config.clone();
                            let tunnel_state = Arc::clone(&http_state);
                            tokio::spawn(async move {
                                log::info!(
                                    "Dialing relay tunnel {} for service {:?}",
                                    tunnel_id,
                                    service
                                );
                                match relay_client::connect_tunnel_to_relay(
                                    &tunnel_config,
                                    tunnel_id.clone(),
                                )
                                .await
                                {
                                    Ok(socket) => match service {
                                        TunnelService::Ksp => {
                                            crate::ksp::handle_tungstenite_stream(
                                                socket,
                                                tunnel_state,
                                                relay_tunnel_ksp_auth_mode(),
                                            )
                                            .await;
                                        }
                                        TunnelService::TaskTransfer => {
                                            match tunnel_state
                                                .transfer_sidecar()
                                                .ensure_running_for_inbound_tunnel()
                                                .await
                                            {
                                                Ok(_) => {
                                                    let result =
                                                        task_transfer_tunnel::bridge_task_transfer_tunnel(
                                                            socket,
                                                            tunnel_config.transfer_port,
                                                            tunnel_id.clone(),
                                                        )
                                                        .await;
                                                    if let Err(error) = result {
                                                        log::error!(
                                                            "Task-transfer relay tunnel {} failed: {}",
                                                            tunnel_id,
                                                            error
                                                        );
                                                    }
                                                }
                                                Err(error) => log::error!(
                                                    "Task-transfer relay tunnel {} could not start the sidecar: {}",
                                                    tunnel_id,
                                                    error
                                                ),
                                            }
                                        }
                                    },
                                    Err(error) => {
                                        log::error!(
                                            "Failed to establish relay tunnel {}: {}",
                                            tunnel_id,
                                            error
                                        );
                                    }
                                }
                                log::info!("Relay tunnel {} closed", tunnel_id);
                            });
                        }
                        RelayMessage::Error { message } => {
                            log::error!("Relay error: {}", message);
                        }
                        other => {
                            log::warn!("Unexpected relay message: {:?}", other);
                        }
                    }
                }
                Message::Ping(data) => {
                    if let Err(e) = sink.lock().await.send(Message::Pong(data)).await {
                        log::error!("Failed to send pong: {}", e);
                        break;
                    }
                }
                Message::Pong(_) => {}
                Message::Close(_) => {
                    log::info!("Relay closed connection");
                    break;
                }
                _ => {}
            }
        }

        // Clean up all observer tasks on disconnect
        http_state.set_desktop_routing_available(false);
        http_state.set_mobile_notifications_available(false);
        publisher.on_disconnected();
        for (_, response) in pending_mobile_notifications.drain() {
            let _ = response.send(Err("mobile notification relay disconnected".to_string()));
        }
        for (_, request) in pending_desktop_requests.drain() {
            fail_pending_desktop_request(request, "desktop relay disconnected".to_string());
        }
        for (session_id, handle) in observe_tasks.drain() {
            log::info!(
                "Cleaning up observer for session {} on disconnect",
                session_id
            );
            handle.abort();
        }

        log::info!("Disconnected from relay. Reconnecting in 5 seconds...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Send a response message through the relay WebSocket.
async fn send_response(
    sink: &Arc<Mutex<relay_client::WsSink>>,
    id: RelayId,
    result: Result<serde_json::Value, String>,
) {
    let response = match result {
        Ok(data) => RelayMessage::Response {
            id,
            data: Some(data),
            error: None,
            status: None,
            body: None,
        },
        Err(e) => RelayMessage::Response {
            id,
            data: None,
            error: Some(e),
            status: None,
            body: None,
        },
    };

    if let Err(e) = send_relay_response_message(sink, response).await {
        log::error!("Failed to send response: {}", e);
    }
}

fn fail_pending_desktop_request(request: PendingDesktopRequest, error: String) {
    match request {
        PendingDesktopRequest::ListActive { response } => {
            let _ = response.send(Err(error));
        }
        PendingDesktopRequest::Invoke { response } => {
            let _ = response.send(Err(error));
        }
    }
}

fn resolve_pending_desktop_request(
    request: PendingDesktopRequest,
    data: Option<serde_json::Value>,
    error: Option<String>,
    status: Option<u16>,
    body: Option<serde_json::Value>,
) {
    match request {
        PendingDesktopRequest::ListActive { response } => {
            let result = match error {
                Some(error) => Err(error),
                None => data
                    .and_then(|value| value.get("desktopIds").cloned())
                    .ok_or_else(|| "relay returned an invalid active-desktop response".to_string())
                    .and_then(|value| {
                        serde_json::from_value::<Vec<String>>(value)
                            .map_err(|error| format!("relay returned invalid desktop ids: {error}"))
                    }),
            };
            let _ = response.send(result);
        }
        PendingDesktopRequest::Invoke { response } => {
            let status = status.unwrap_or_else(|| if error.is_some() { 502 } else { 200 });
            let _ = response.send(Ok(crate::http_api::HttpInvokeResponse {
                status,
                body: body.or(data),
                error,
            }));
        }
    }
}

/// Dispatch a relay HTTP invoke off the read loop, driven from the blocking
/// pool: invoke handlers can run synchronous git/SQLite work (task lifecycle
/// preparation), which must not occupy a runtime worker or stall relay
/// message processing. Responses are id-addressed, so completion order does
/// not matter. Returns `Err` only when the saturation response could not be
/// written to the relay sink (the caller reconnects).
pub(crate) struct RelayHttpInvokeRequest {
    pub(crate) id: relay_client::RelayId,
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) body: serde_json::Value,
    pub(crate) authenticated_user_id: Option<String>,
}

/// Separate budgets keep long-poll task event watches from consuming every
/// permit needed by the mobile client's short REST requests.
pub(crate) struct RelayHttpInvokePermits {
    short: Arc<tokio::sync::Semaphore>,
    long_poll: Arc<tokio::sync::Semaphore>,
}

impl RelayHttpInvokePermits {
    pub(crate) fn new(concurrency: usize) -> Self {
        Self {
            short: Arc::new(tokio::sync::Semaphore::new(concurrency)),
            long_poll: Arc::new(tokio::sync::Semaphore::new(concurrency)),
        }
    }

    pub(crate) fn for_path(&self, path: &str) -> Arc<tokio::sync::Semaphore> {
        if path.split('?').next() == Some("/v1/task-events") {
            Arc::clone(&self.long_poll)
        } else {
            Arc::clone(&self.short)
        }
    }
}

pub(crate) async fn dispatch_relay_http_invoke(
    http_state: Arc<http_api::AppState>,
    sink: Arc<Mutex<relay_client::WsSink>>,
    invoke_permits: Arc<RelayHttpInvokePermits>,
    request: RelayHttpInvokeRequest,
) -> Result<(), String> {
    let RelayHttpInvokeRequest {
        id,
        method,
        path,
        body,
        authenticated_user_id,
    } = request;
    let permit = match invoke_permits.for_path(&path).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let response = RelayMessage::Response {
                id,
                data: None,
                error: Some("desktop is busy; too many concurrent requests".to_string()),
                status: Some(503),
                body: None,
            };
            return send_relay_response_message(&sink, response).await;
        }
    };
    tokio::spawn(async move {
        let _permit = permit;
        let handle = tokio::runtime::Handle::current();
        let dispatched = tokio::task::spawn_blocking(move || {
            handle.block_on(async move {
                match authenticated_user_id {
                    Some(actor) => {
                        http_api::dispatch_authenticated_relay_http_invoke(
                            http_state, actor, &method, &path, body,
                        )
                        .await
                    }
                    None => {
                        http_api::dispatch_authenticated_http_invoke(
                            http_state, &method, &path, body,
                        )
                        .await
                    }
                }
            })
        })
        .await;
        let response = match dispatched {
            Ok(invoke_response) => RelayMessage::Response {
                id,
                data: None,
                error: invoke_response.error,
                status: Some(invoke_response.status),
                body: invoke_response.body,
            },
            Err(join_error) => RelayMessage::Response {
                id,
                data: None,
                error: Some(format!("invoke worker failed: {join_error}")),
                status: Some(500),
                body: None,
            },
        };
        if let Err(e) = send_relay_response_message(&sink, response).await {
            log::error!("{}", e);
        }
    });
    Ok(())
}

async fn send_relay_response_message(
    sink: &Arc<Mutex<relay_client::WsSink>>,
    response: RelayMessage,
) -> Result<(), String> {
    let json = match serde_json::to_string(&response) {
        Ok(j) => j,
        Err(e) => {
            return Err(format!("failed to serialize response: {}", e));
        }
    };

    if let Err(e) = sink.lock().await.send(Message::Text(json.into())).await {
        return Err(format!("failed to send response: {}", e));
    }

    Ok(())
}

fn relay_snapshot_event(
    session_id: &str,
    snapshot: kanna_daemon::protocol::TerminalSnapshot,
) -> RelayMessage {
    RelayMessage::Event {
        name: "terminal_snapshot".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "snapshot": snapshot,
        }),
    }
}

fn relay_output_event(session_id: &str, data: Vec<u8>) -> RelayMessage {
    use base64::Engine;

    RelayMessage::Event {
        name: "terminal_output".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "data_b64": base64::engine::general_purpose::STANDARD.encode(&data),
        }),
    }
}

fn relay_exit_event(session_id: &str, code: i32) -> RelayMessage {
    RelayMessage::Event {
        name: "session_exit".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "code": code,
        }),
    }
}

fn relay_error_event(session_id: &str, message: String) -> RelayMessage {
    RelayMessage::Event {
        name: "terminal_error".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "message": message,
        }),
    }
}

fn relay_tunnel_ksp_auth_mode() -> crate::ksp::AuthMode {
    crate::ksp::AuthMode::AlreadyAuthenticated
}

async fn send_relay_event(sink: &Arc<Mutex<relay_client::WsSink>>, event: RelayMessage) -> bool {
    match serde_json::to_string(&event) {
        Ok(json) => sink
            .lock()
            .await
            .send(Message::Text(json.into()))
            .await
            .is_ok(),
        Err(error) => {
            log::error!("Failed to serialize relay event: {}", error);
            true
        }
    }
}

/// Background task that forwards the atomic cutover snapshot from
/// `ObserveSnapshot` and then every later daemon event as relay Event
/// messages through the WebSocket. Because the snapshot was queued ahead of
/// live output on the same connection, ordering is exact: nothing is
/// discarded before the snapshot and no Output precedes it.
async fn observer_loop(
    mut daemon: daemon_client::DaemonClient,
    session_id: &str,
    sink: Arc<Mutex<relay_client::WsSink>>,
    initial_snapshot: kanna_daemon::protocol::TerminalSnapshot,
) {
    use kanna_daemon::protocol::Event as DaemonEvent;

    if !send_relay_event(&sink, relay_snapshot_event(session_id, initial_snapshot)).await {
        log::info!(
            "WebSocket closed while sending initial snapshot for {}",
            session_id
        );
        return;
    }

    // We process daemon events in a two-phase pattern: first extract data
    // from the non-Send Result (no awaits), then send over the WebSocket.
    // This avoids holding Box<dyn Error> across await points.
    enum Action {
        Send { event: RelayMessage },
        SendAndStop { event: RelayMessage },
        Stop,
        Continue,
    }

    loop {
        let action = match daemon.read_event().await {
            Ok(DaemonEvent::Output { session_id, data }) => Action::Send {
                event: relay_output_event(&session_id, data),
            },
            // The daemon resynchronizes a subscriber that lagged behind live
            // output by sending a fresh authoritative snapshot mid-stream.
            Ok(DaemonEvent::Snapshot {
                session_id: sid,
                snapshot,
                ..
            }) => Action::Send {
                event: relay_snapshot_event(&sid, snapshot),
            },
            Ok(DaemonEvent::Exit {
                session_id: sid,
                code,
                ..
            }) => {
                log::info!("Session {} exited with code {}", sid, code);
                Action::SendAndStop {
                    event: relay_exit_event(&sid, code),
                }
            }
            Err(e) => {
                log::error!("Observer read error for {}: {}", session_id, e);
                Action::Stop
            }
            _ => Action::Continue,
        };

        match action {
            Action::Send { event } => {
                if !send_relay_event(&sink, event).await {
                    log::info!("WebSocket closed, stopping observer for {}", session_id);
                    break;
                }
            }
            Action::SendAndStop { event } => {
                let _ = send_relay_event(&sink, event).await;
                break;
            }
            Action::Stop => break,
            Action::Continue => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_daemon::protocol::TerminalSnapshot;

    #[test]
    fn relay_snapshot_event_preserves_terminal_snapshot_payload() {
        let snapshot = TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 2,
            cursor_col: 3,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "restored".to_string(),
        };

        let event = relay_snapshot_event("task-1", snapshot);

        match event {
            RelayMessage::Event { name, payload } => {
                assert_eq!(name, "terminal_snapshot");
                assert_eq!(payload["session_id"], "task-1");
                assert_eq!(payload["snapshot"]["vt"], "restored");
                assert_eq!(payload["snapshot"]["cursor_row"], 2);
            }
            other => panic!("expected terminal_snapshot relay event, got {other:?}"),
        }
    }

    #[test]
    fn relay_output_event_keeps_live_output_as_base64() {
        let event = relay_output_event("task-1", b"live".to_vec());

        match event {
            RelayMessage::Event { name, payload } => {
                assert_eq!(name, "terminal_output");
                assert_eq!(payload["session_id"], "task-1");
                assert_eq!(payload["data_b64"], "bGl2ZQ==");
            }
            other => panic!("expected terminal_output relay event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn mobile_notification_endpoint_hands_off_to_capable_relay() {
        use tokio::time::timeout;
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

        let relay_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind relay stand-in");
        let relay_address = relay_listener.local_addr().expect("relay address");
        let unique = format!(
            "relay-mobile-notification-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let database_path = crate::db::Db::test_db_path(&unique);
        let config = Config {
            relay_url: format!("ws://{relay_address}"),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: format!("/tmp/{unique}-daemon"),
            db_path: database_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-push".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Push Test Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            pairing_store_path: format!("/tmp/{unique}-pairings.json"),
        };
        let database = crate::db::Db::open_for_tests(&database_path).expect("open test db");
        let state = Arc::new(http_api::AppState::new(config.clone()));

        let relay_server = tokio::spawn(async move {
            let (stream, _) = relay_listener.accept().await.expect("accept relay");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept websocket");
            let auth = socket
                .next()
                .await
                .expect("auth message")
                .expect("auth frame");
            assert!(matches!(auth, TungsteniteMessage::Text(_)));
            socket
                .send(TungsteniteMessage::Text(
                    serde_json::json!({
                        "type": "auth_ok",
                        "userId": "operator-1",
                        "capabilities": {
                            "mobileNotifications": { "version": 1 }
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("send auth ack");

            while let Some(message) = socket.next().await {
                let TungsteniteMessage::Text(text) = message.expect("relay frame") else {
                    continue;
                };
                let value: serde_json::Value =
                    serde_json::from_str(&text).expect("parse relay message");
                if value["type"] != "mobile_notification_publish" {
                    continue;
                }
                assert_eq!(value["notification"]["title"], "Staging shipped");
                assert_eq!(value["notification"]["body"], "The staging build is ready.");
                assert_eq!(value["notification"]["taskId"], "task-123");
                socket
                    .send(TungsteniteMessage::Text(
                        serde_json::json!({
                            "type": "mobile_notification_ack",
                            "id": value["id"],
                            "ok": true,
                            "delivery": {
                                "acceptedCount": 2,
                                "failedCount": 0
                            }
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .expect("send notification ack");
                return;
            }
            panic!("relay disconnected before mobile notification");
        });

        let relay_loop = run_relay_loop(config, database, Arc::clone(&state));
        tokio::pin!(relay_loop);
        let endpoint_request = async {
            timeout(Duration::from_secs(2), async {
                while !state.mobile_notifications_available() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("relay capability was not advertised");
            let unauthenticated = http_api::dispatch_http_invoke(
                Arc::clone(&state),
                "POST",
                "/v1/mobile/notifications",
                serde_json::json!({
                    "title": "Spoofed staging status",
                    "body": "This must not reach the operator."
                }),
            )
            .await;
            assert_eq!(
                unauthenticated.status,
                axum::http::StatusCode::UNAUTHORIZED.as_u16()
            );

            http_api::dispatch_authenticated_http_invoke(
                Arc::clone(&state),
                "POST",
                "/v1/mobile/notifications",
                serde_json::json!({
                    "title": "Staging shipped",
                    "body": "The staging build is ready.",
                    "taskId": "task-123"
                }),
            )
            .await
        };
        tokio::pin!(endpoint_request);
        let response = tokio::select! {
            response = &mut endpoint_request => response,
            result = &mut relay_loop => panic!("relay loop exited early: {result:?}"),
        };
        assert_eq!(response.status, 200, "{response:?}");
        assert_eq!(
            response.body,
            Some(serde_json::json!({
                "status": "accepted",
                "acceptedCount": 2,
                "failedCount": 0
            }))
        );

        relay_server.await.expect("relay server");
        let _ = std::fs::remove_file(database_path);
    }

    #[tokio::test]
    async fn desktop_relay_request_round_trips_an_http_invoke_over_the_relay_loop() {
        use tokio::time::timeout;
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

        let relay_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind relay stand-in");
        let relay_address = relay_listener.local_addr().expect("relay address");
        let unique = format!(
            "relay-desktop-invoke-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let database_path = crate::db::Db::test_db_path(&unique);
        let config = Config {
            relay_url: format!("ws://{relay_address}"),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: format!("/tmp/{unique}-daemon"),
            db_path: database_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-source".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Source Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            pairing_store_path: format!("/tmp/{unique}-pairings.json"),
        };
        let database = crate::db::Db::open_for_tests(&database_path).expect("open test db");
        let state = Arc::new(http_api::AppState::new(config.clone()));

        let relay_server = tokio::spawn(async move {
            let (stream, _) = relay_listener.accept().await.expect("accept relay");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept websocket");
            let _auth = socket
                .next()
                .await
                .expect("auth message")
                .expect("auth frame");
            socket
                .send(TungsteniteMessage::Text(
                    serde_json::json!({
                        "type": "auth_ok",
                        "userId": "operator-1",
                        "capabilities": {
                            "desktopRouting": { "version": 1 }
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("send auth ack");

            while let Some(message) = socket.next().await {
                let TungsteniteMessage::Text(text) = message.expect("relay frame") else {
                    continue;
                };
                let value: serde_json::Value =
                    serde_json::from_str(&text).expect("parse relay message");
                if value["type"] != "invoke" {
                    continue;
                }
                assert_eq!(value["desktopId"], "desktop-target");
                assert_eq!(value["method"], "GET");
                assert_eq!(value["path"], "/v1/tasks/recent");
                socket
                    .send(TungsteniteMessage::Text(
                        serde_json::json!({
                            "type": "response",
                            "id": value["id"],
                            "status": 200,
                            "body": [{ "id": "task-on-target" }]
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .expect("send desktop response");
                return;
            }
            panic!("relay disconnected before desktop invoke");
        });

        let relay_loop = run_relay_loop(config, database, Arc::clone(&state));
        tokio::pin!(relay_loop);
        let endpoint_request = async {
            timeout(Duration::from_secs(2), async {
                while !state.desktop_routing_available() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("desktop relay routing did not become available");
            state
                .invoke_relay_desktop(
                    "desktop-target".to_string(),
                    "GET".to_string(),
                    "/v1/tasks/recent".to_string(),
                    serde_json::Value::Null,
                )
                .await
        };
        tokio::pin!(endpoint_request);
        let response = tokio::select! {
            response = &mut endpoint_request => response,
            result = &mut relay_loop => panic!("relay loop exited early: {result:?}"),
        };
        let response = response.expect("desktop relay response");
        assert_eq!(response.status, 200, "{response:?}");
        assert_eq!(
            response.body,
            Some(serde_json::json!([{ "id": "task-on-target" }]))
        );

        relay_server.await.expect("relay server");
        let _ = std::fs::remove_file(database_path);
    }

    /// Drives the real `observer_loop` against a fake daemon connection and
    /// a real WebSocket sink: the initial snapshot, live output, the daemon's
    /// mid-stream lag-resync Snapshot, output after it, and the exit must all
    /// be forwarded in order as relay events.
    #[tokio::test]
    async fn observer_loop_forwards_mid_stream_snapshot_resync_then_live_output() {
        use kanna_daemon::protocol::Event as DaemonEvent;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

        fn terminal_snapshot(vt: &str) -> TerminalSnapshot {
            TerminalSnapshot {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 0,
                cursor_col: 0,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
                vt: vt.to_string(),
            }
        }

        let unique = format!(
            "relay-observer-resync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener =
            tokio::net::UnixListener::bind(&socket_path).expect("bind fake daemon socket");

        let fake_daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            // The relay registers with the atomic ObserveSnapshot cutover;
            // the reply is the snapshot itself, queued ahead of live output.
            reader
                .read_line(&mut line)
                .await
                .expect("read observe snapshot command");
            assert!(
                line.contains("ObserveSnapshot"),
                "expected ObserveSnapshot command, got {line:?}"
            );

            let events = [
                DaemonEvent::Snapshot {
                    session_id: "sess-observer".to_string(),
                    snapshot: terminal_snapshot("INITIAL"),
                    agent_provider: None,
                },
                DaemonEvent::Output {
                    session_id: "sess-observer".to_string(),
                    data: b"live-before".to_vec(),
                },
                DaemonEvent::Snapshot {
                    session_id: "sess-observer".to_string(),
                    snapshot: terminal_snapshot("RESYNCED"),
                    agent_provider: None,
                },
                DaemonEvent::Output {
                    session_id: "sess-observer".to_string(),
                    data: b"live-after".to_vec(),
                },
                DaemonEvent::Exit {
                    session_id: "sess-observer".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            ];
            for event in events {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .expect("write daemon event");
            }
        });

        let tcp = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind relay stand-in");
        let addr = tcp.local_addr().expect("local addr");
        let relay_server = tokio::spawn(async move {
            let (stream, _) = tcp.accept().await.expect("accept ws");
            let mut ws =
                tokio_tungstenite::accept_async(tokio_tungstenite::MaybeTlsStream::Plain(stream))
                    .await
                    .expect("ws handshake");
            let mut messages = Vec::new();
            while let Some(Ok(message)) = ws.next().await {
                if let TungsteniteMessage::Text(text) = message {
                    messages.push(text.to_string());
                }
            }
            messages
        });

        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .expect("connect ws");
        let (sink, _read) = ws.split();
        let sink = Arc::new(Mutex::new(sink));

        let mut daemon = daemon_client::DaemonClient::connect(daemon_dir.to_str().unwrap())
            .await
            .expect("connect fake daemon");
        // Same flow as the observe_session handler: the ObserveSnapshot
        // reply is the cutover snapshot, handed to the forwarding loop.
        let initial_snapshot = match daemon
            .send_command(&kanna_daemon::protocol::Command::ObserveSnapshot {
                session_id: "sess-observer".to_string(),
            })
            .await
            .expect("observe snapshot")
        {
            DaemonEvent::Snapshot { snapshot, .. } => snapshot,
            other => panic!("expected Snapshot reply, got {other:?}"),
        };
        observer_loop(daemon, "sess-observer", sink.clone(), initial_snapshot).await;
        fake_daemon.await.expect("fake daemon");
        sink.lock().await.close().await.expect("close ws");
        let messages = relay_server.await.expect("relay server");

        let events: Vec<serde_json::Value> = messages
            .iter()
            .map(|message| serde_json::from_str(message).expect("parse relay message"))
            .collect();
        let names: Vec<&str> = events
            .iter()
            .map(|event| event["name"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            names,
            [
                "terminal_snapshot",
                "terminal_output",
                "terminal_snapshot",
                "terminal_output",
                "session_exit",
            ],
            "observer relay events out of order: {events:?}"
        );
        assert_eq!(events[0]["payload"]["snapshot"]["vt"], "INITIAL");
        assert_eq!(events[2]["payload"]["snapshot"]["vt"], "RESYNCED");

        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn relay_loop_republishes_after_an_unacknowledged_disconnect_with_persistent_state() {
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

        async fn receive_publication(
            listener: &tokio::net::TcpListener,
        ) -> (
            String,
            serde_json::Value,
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        ) {
            let (stream, _) = listener.accept().await.expect("accept relay connection");
            let mut ws = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept websocket");
            let auth = ws.next().await.expect("auth message").expect("valid auth");
            let TungsteniteMessage::Text(auth) = auth else {
                panic!("expected text auth")
            };
            let auth: serde_json::Value = serde_json::from_str(&auth).expect("parse auth");
            assert_eq!(auth["type"], "auth");
            ws.send(TungsteniteMessage::Text(
                serde_json::json!({ "type": "auth_ok", "userId": "user-1" })
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send auth_ok");

            loop {
                let message = ws
                    .next()
                    .await
                    .expect("publication message")
                    .expect("valid publication");
                let TungsteniteMessage::Text(text) = message else {
                    continue;
                };
                let message: serde_json::Value =
                    serde_json::from_str(&text).expect("parse relay message");
                if message["type"] == "task_snapshot_publish" {
                    return (
                        message["id"].as_str().expect("publication id").to_string(),
                        message["snapshot"].clone(),
                        ws,
                    );
                }
            }
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake relay");
        let relay_addr = listener.local_addr().expect("relay address");
        let unique = format!(
            "relay-publisher-reconnect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let db_path = db::Db::test_db_path(&unique);
        let config = Config {
            relay_url: format!("ws://{relay_addr}"),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: std::env::temp_dir()
                .join(&unique)
                .to_string_lossy()
                .to_string(),
            db_path: db_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48_120,
            transfer_port: 4455,
            pairing_store_path: std::env::temp_dir()
                .join(format!("{unique}-pairings.json"))
                .to_string_lossy()
                .to_string(),
        };
        let database = db::Db::open_for_tests(&db_path).expect("open test database");
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let relay_loop = run_relay_loop(config, database, state);
        tokio::pin!(relay_loop);

        let publications = tokio::time::timeout(Duration::from_secs(15), async {
            tokio::select! {
                publications = async {
                    let (first_id, first_snapshot, mut first_connection) =
                        receive_publication(&listener).await;
                    first_connection
                        .close(None)
                        .await
                        .expect("disconnect first relay connection without ack");
                    let (second_id, second_snapshot, mut second_connection) =
                        receive_publication(&listener).await;
                    second_connection
                        .close(None)
                        .await
                        .expect("close second relay connection");
                    (first_id, first_snapshot, second_id, second_snapshot)
                } => publications,
                result = &mut relay_loop => {
                    panic!("relay loop exited before reconnecting: {result:?}")
                }
            }
        })
        .await
        .expect("relay did not reconnect and republish");

        assert_eq!(publications.0, "task-snapshot-1");
        assert_eq!(publications.1["schemaVersion"], 1);
        assert_eq!(publications.2, "task-snapshot-2");
        assert_eq!(publications.3["schemaVersion"], 1);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn relay_tunnel_ksp_auth_is_already_satisfied_by_relay() {
        assert_eq!(
            relay_tunnel_ksp_auth_mode(),
            crate::ksp::AuthMode::AlreadyAuthenticated
        );
    }

    #[tokio::test]
    async fn relay_dispatches_task_transfer_tunnel_to_configured_sidecar_port() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::time::timeout;
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

        let relay_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind relay stand-in");
        let relay_address = relay_listener.local_addr().expect("relay address");
        let transfer_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind transfer sidecar stand-in");
        let transfer_port = transfer_listener
            .local_addr()
            .expect("transfer address")
            .port();

        let relay_server = tokio::spawn(async move {
            let (primary_stream, _) = relay_listener
                .accept()
                .await
                .expect("accept primary relay connection");
            let mut primary = tokio_tungstenite::accept_async(primary_stream)
                .await
                .expect("accept primary websocket");
            let auth = primary
                .next()
                .await
                .expect("primary auth frame")
                .expect("valid primary auth");
            assert!(matches!(auth, TungsteniteMessage::Text(_)));

            primary
                .send(TungsteniteMessage::Text(
                    serde_json::json!({
                        "type": "tunnel_establish",
                        "desktopId": "desktop-destination",
                        "tunnelId": "transfer-tunnel-1",
                        "service": "task-transfer",
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("request task-transfer tunnel");

            let (tunnel_stream, _) = timeout(Duration::from_secs(2), relay_listener.accept())
                .await
                .expect("desktop did not dial task-transfer tunnel")
                .expect("accept tunnel relay connection");
            let mut tunnel = tokio_tungstenite::accept_async(tunnel_stream)
                .await
                .expect("accept tunnel websocket");
            let tunnel_auth = tunnel
                .next()
                .await
                .expect("tunnel auth frame")
                .expect("valid tunnel auth");
            let TungsteniteMessage::Text(tunnel_auth) = tunnel_auth else {
                panic!("expected text tunnel auth");
            };
            let tunnel_auth: serde_json::Value =
                serde_json::from_str(&tunnel_auth).expect("parse tunnel auth");
            assert_eq!(tunnel_auth["tunnel_id"], "transfer-tunnel-1");

            tunnel
                .send(TungsteniteMessage::Text(
                    serde_json::json!({
                        "type": "tunnel_ready",
                        "desktopId": "desktop-destination",
                        "tunnelId": "transfer-tunnel-1",
                        "service": "task-transfer",
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("send tunnel_ready");
            tunnel
                .send(TungsteniteMessage::Binary(
                    b"source-through-relay".to_vec().into(),
                ))
                .await
                .expect("send source bytes");

            let destination = timeout(Duration::from_secs(2), tunnel.next())
                .await
                .expect("desktop did not return destination bytes")
                .expect("tunnel closed")
                .expect("valid destination frame");
            tunnel.close(None).await.expect("close tunnel");
            destination
        });

        let unique = format!(
            "relay-task-transfer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        );
        let db_path = db::Db::test_db_path(&unique);
        let config = Config {
            relay_url: format!("ws://{relay_address}"),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: std::env::temp_dir()
                .join(&unique)
                .to_string_lossy()
                .to_string(),
            db_path: db_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-destination".to_string(),
            desktop_secret: None,
            desktop_name: "Destination Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48_120,
            transfer_port,
            pairing_store_path: std::env::temp_dir()
                .join(format!("{unique}-pairings.json"))
                .to_string_lossy()
                .to_string(),
        };
        let database = db::Db::open_for_tests(&db_path).expect("open test database");
        let state = Arc::new(http_api::AppState::new(config.clone()));
        // `transfer_listener` above stands in for the sidecar on the configured
        // port; the supervisor must not race it by spawning a real one.
        state.transfer_sidecar().assume_externally_owned_for_test();
        let relay_loop = run_relay_loop(config, database, state);
        tokio::pin!(relay_loop);

        let destination = timeout(Duration::from_secs(3), async {
            tokio::select! {
                destination = async {
                    let (mut sidecar, _) = transfer_listener
                        .accept()
                        .await
                        .expect("accept sidecar bridge");
                    let mut source = [0_u8; 20];
                    sidecar
                        .read_exact(&mut source)
                        .await
                        .expect("read source relay bytes");
                    assert_eq!(&source, b"source-through-relay");
                    sidecar
                        .write_all(b"destination-through-sidecar")
                        .await
                        .expect("send destination sidecar bytes");
                    relay_server.await.expect("relay stand-in task")
                } => destination,
                result = &mut relay_loop => {
                    panic!("relay loop exited before bridging task transfer: {result:?}")
                }
            }
        })
        .await
        .expect("relay did not bridge task-transfer tunnel");
        assert_eq!(
            destination,
            TungsteniteMessage::Binary(b"destination-through-sidecar".to_vec().into())
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn relay_keepalive_reconnects_after_missed_pong_timeout() {
        let start = tokio::time::Instant::now();
        let mut keepalive = RelayKeepalive::new();

        assert_eq!(
            keepalive.on_ping_tick(start),
            RelayKeepaliveAction::SendPing
        );
        assert_eq!(
            keepalive.on_ping_tick(start + RELAY_PING_INTERVAL),
            RelayKeepaliveAction::SendPing
        );
        assert_eq!(
            keepalive.on_ping_tick(start + RELAY_PONG_TIMEOUT),
            RelayKeepaliveAction::Reconnect
        );
    }

    #[test]
    fn relay_keepalive_clears_pending_ping_on_any_inbound_message() {
        let start = tokio::time::Instant::now();
        let mut keepalive = RelayKeepalive::new();

        assert_eq!(
            keepalive.on_ping_tick(start),
            RelayKeepaliveAction::SendPing
        );
        keepalive.on_inbound_message(start + RELAY_PONG_TIMEOUT / 2);

        assert_eq!(
            keepalive.on_ping_tick(start + RELAY_PONG_TIMEOUT),
            RelayKeepaliveAction::SendPing
        );
    }

    #[test]
    fn cloud_task_publication_requires_desktop_specific_credentials() {
        assert!(!cloud_task_publication_enabled(None));
        assert!(!cloud_task_publication_enabled(Some("")));
        assert!(cloud_task_publication_enabled(Some("desktop-secret")));
    }
}
