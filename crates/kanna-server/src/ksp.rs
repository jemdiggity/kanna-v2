//! Kanna Stream Protocol (KSP) endpoint: one multiplexed WebSocket per
//! client carrying agent streams, terminal streams, and task-API requests as
//! task-addressed JSON frames. The same handler serves localhost (the local
//! desktop app), LAN clients, and — via the relay tunnel — cloud clients.
//!
//! Frame schema: `crates/kanna-agent-protocol/src/frames.rs` (TS mirrors in
//! `packages/agent-protocol`).

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message as WsMessage, WebSocket};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use kanna_agent_protocol::{ClientFrame, FrameAgentEvent, ServerFrame, StreamKind};
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent, SessionStatus};

use crate::daemon_client::DaemonClient;
use crate::db::Db;
use crate::http_api::{dispatch_http_invoke, AppState};

#[derive(Debug, serde::Deserialize)]
struct FirebaseLookupResponse {
    users: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    AllowEmpty,
    RequireCredential,
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Length-aware constant-time byte comparison. Returns false for differing
/// lengths without leaking which byte differs via early exit. Avoids a crate
/// dependency for this single credential check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn status_str(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Busy => "busy",
        SessionStatus::Waiting => "waiting",
        SessionStatus::Idle => "idle",
    }
}

pub async fn handle_stream(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (incoming_tx, incoming_rx) = mpsc::channel::<String>(256);
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<String>(256);

    let reader_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_rx.next().await {
            match message {
                WsMessage::Text(text) => {
                    if incoming_tx.send(text.to_string()).await.is_err() {
                        return;
                    }
                }
                WsMessage::Close(_) => return,
                _ => {}
            }
        }
    });
    let writer_task = tokio::spawn(async move {
        while let Some(json) = outgoing_rx.recv().await {
            if ws_tx.send(WsMessage::Text(json.into())).await.is_err() {
                return;
            }
        }
    });

    handle_stream_channels(incoming_rx, outgoing_tx, state, AuthMode::AllowEmpty).await;
    reader_task.abort();
    let _ = writer_task.await;
}

pub async fn handle_tungstenite_stream(
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    state: Arc<AppState>,
    auth_mode: AuthMode,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (incoming_tx, incoming_rx) = mpsc::channel::<String>(256);
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<String>(256);

    let reader_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_rx.next().await {
            match message {
                TungsteniteMessage::Text(text) => {
                    if incoming_tx.send(text.to_string()).await.is_err() {
                        return;
                    }
                }
                TungsteniteMessage::Close(_) => return,
                _ => {}
            }
        }
    });
    let writer_task = tokio::spawn(async move {
        while let Some(json) = outgoing_rx.recv().await {
            if ws_tx
                .send(TungsteniteMessage::Text(json.into()))
                .await
                .is_err()
            {
                return;
            }
        }
    });

    handle_stream_channels(incoming_rx, outgoing_tx, state, auth_mode).await;
    reader_task.abort();
    let _ = writer_task.await;
}

async fn handle_stream_channels(
    mut incoming_rx: mpsc::Receiver<String>,
    outgoing_tx: mpsc::Sender<String>,
    state: Arc<AppState>,
    auth_mode: AuthMode,
) {
    let (frame_tx, frame_rx) = mpsc::channel::<ServerFrame>(256);
    let writer_task = tokio::spawn(write_frames(outgoing_tx, frame_rx));
    let mut conn = StreamConn {
        state,
        frame_tx,
        attachments: HashMap::new(),
        authed: false,
        auth_mode,
    };

    while let Some(message) = incoming_rx.recv().await {
        if is_relay_tunnel_control_message(&message) {
            continue;
        }
        match serde_json::from_str::<ClientFrame>(&message) {
            Ok(frame) => {
                if !conn.handle(frame).await {
                    break;
                }
            }
            Err(error) => {
                conn.error(None, "bad_frame", format!("unparseable frame: {error}"))
                    .await;
            }
        }
    }

    // Abort attachment tasks (each holds a frame_tx clone), then drop our
    // own sender so the writer drains queued frames and exits — aborting it
    // would lose final frames (e.g. the unauthenticated error).
    conn.shutdown();
    drop(conn);
    let _ = writer_task.await;
}

fn is_relay_tunnel_control_message(message: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(message)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|kind| kind.as_str())
                .map(str::to_string)
        })
        .is_some_and(|kind| kind == "tunnel_ready")
}

async fn write_frames(
    outgoing_tx: mpsc::Sender<String>,
    mut frame_rx: mpsc::Receiver<ServerFrame>,
) {
    while let Some(frame) = frame_rx.recv().await {
        let Ok(json) = serde_json::to_string(&frame) else {
            continue;
        };
        if outgoing_tx.send(json).await.is_err() {
            return;
        }
    }
}

struct StreamConn {
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    attachments: HashMap<(String, StreamKind), JoinHandle<()>>,
    authed: bool,
    auth_mode: AuthMode,
}

impl StreamConn {
    async fn send(&self, frame: ServerFrame) {
        let _ = self.frame_tx.send(frame).await;
    }

    async fn error(&self, task_id: Option<String>, code: &str, message: String) {
        self.send(ServerFrame::Error {
            task_id,
            code: code.to_string(),
            message,
        })
        .await;
    }

    fn shutdown(&mut self) {
        for (_, task) in self.attachments.drain() {
            task.abort();
        }
    }

    fn resolve_session_id(&self, task_id: &str) -> Result<String, String> {
        Db::open(self.state.config().db_path.as_str())
            .and_then(|db| db.resolve_task_terminal_session_id(task_id))
            .map_err(|error| format!("db error: {error}"))?
            .ok_or_else(|| format!("no session for task {task_id}"))
    }

    /// One-shot daemon command over a fresh connection (unix-socket connects
    /// are cheap and this avoids interleaving with attach streams).
    async fn daemon_command(&self, cmd: DaemonCommand) -> Result<DaemonEvent, String> {
        let mut client = DaemonClient::connect(&self.state.config().daemon_dir)
            .await
            .map_err(|error| format!("daemon error: {error}"))?;
        client
            .send_command(&cmd)
            .await
            .map_err(|error| format!("daemon error: {error}"))
    }

    async fn expect_ok(&self, task_id: &str, cmd: DaemonCommand) {
        match self.daemon_command(cmd).await {
            Ok(DaemonEvent::Ok) => {}
            Ok(DaemonEvent::Error { message, .. }) => {
                self.error(Some(task_id.to_string()), "daemon", message)
                    .await;
            }
            Ok(other) => {
                self.error(
                    Some(task_id.to_string()),
                    "daemon",
                    format!("unexpected daemon reply: {other:?}"),
                )
                .await;
            }
            Err(message) => {
                self.error(Some(task_id.to_string()), "daemon", message)
                    .await;
            }
        }
    }

    /// Returns false when the connection should close.
    async fn handle(&mut self, frame: ClientFrame) -> bool {
        if !self.authed {
            return match frame {
                ClientFrame::Auth { credential } => self.handle_auth(credential).await,
                _ => {
                    self.error(None, "unauthenticated", "first frame must be auth".into())
                        .await;
                    false
                }
            };
        }

        match frame {
            ClientFrame::Auth { .. } => {
                self.send(ServerFrame::AuthOk).await;
            }
            ClientFrame::Attach {
                task_id,
                kind,
                from_seq,
            } => {
                self.attach(task_id, kind, from_seq).await;
            }
            ClientFrame::Detach { task_id, kind } => {
                if let Some(task) = self.attachments.remove(&(task_id, kind)) {
                    task.abort();
                }
            }
            ClientFrame::AgentInput { task_id, text } => match self.resolve_session_id(&task_id) {
                Ok(session_id) => {
                    self.expect_ok(&task_id, DaemonCommand::AgentInput { session_id, text })
                        .await;
                }
                Err(message) => self.error(Some(task_id), "no_session", message).await,
            },
            ClientFrame::AgentPermission {
                task_id,
                request_id,
                decision,
            } => match self.resolve_session_id(&task_id) {
                Ok(session_id) => {
                    self.expect_ok(
                        &task_id,
                        DaemonCommand::AgentPermission {
                            session_id,
                            request_id,
                            decision,
                        },
                    )
                    .await;
                }
                Err(message) => self.error(Some(task_id), "no_session", message).await,
            },
            ClientFrame::AgentInterrupt { task_id } => match self.resolve_session_id(&task_id) {
                Ok(session_id) => {
                    self.expect_ok(&task_id, DaemonCommand::AgentInterrupt { session_id })
                        .await;
                }
                Err(message) => self.error(Some(task_id), "no_session", message).await,
            },
            ClientFrame::TermInput { task_id, data_b64 } => {
                let data = match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                    Ok(data) => data,
                    Err(error) => {
                        self.error(Some(task_id), "bad_frame", format!("bad base64: {error}"))
                            .await;
                        return true;
                    }
                };
                match self.resolve_session_id(&task_id) {
                    Ok(session_id) => {
                        self.expect_ok(&task_id, DaemonCommand::Input { session_id, data })
                            .await;
                    }
                    Err(message) => self.error(Some(task_id), "no_session", message).await,
                }
            }
            ClientFrame::TermResize {
                task_id,
                cols,
                rows,
            } => match self.resolve_session_id(&task_id) {
                Ok(session_id) => {
                    self.expect_ok(
                        &task_id,
                        DaemonCommand::Resize {
                            session_id,
                            cols,
                            rows,
                        },
                    )
                    .await;
                }
                Err(message) => self.error(Some(task_id), "no_session", message).await,
            },
            ClientFrame::Request {
                id,
                method,
                path,
                body,
            } => {
                let result = dispatch_http_invoke(
                    self.state.clone(),
                    &method,
                    &path,
                    body.unwrap_or(serde_json::Value::Null),
                )
                .await;
                let body = match result.error {
                    Some(error) => Some(serde_json::json!({ "error": error })),
                    None => result.body,
                };
                self.send(ServerFrame::Response {
                    id,
                    status: result.status,
                    body,
                })
                .await;
            }
        }
        true
    }

    async fn handle_auth(&mut self, credential: Option<String>) -> bool {
        let valid = match self.auth_mode {
            AuthMode::AllowEmpty => true,
            AuthMode::RequireCredential => match credential.as_deref() {
                Some(value) => self.credential_matches(value).await,
                None => false,
            },
        };

        if !valid {
            self.error(None, "unauthorized", "invalid stream credential".into())
                .await;
            return false;
        }

        self.authed = true;
        self.send(ServerFrame::AuthOk).await;
        true
    }

    async fn credential_matches(&self, credential: &str) -> bool {
        // A non-empty credential is a precondition, not a pass: the secret
        // comparison is the actual gate. Compared in constant time so a
        // remote (tunnel) caller cannot use response timing as an oracle.
        if credential.is_empty() {
            return false;
        }
        let config = self.state.config();
        let secret_ok = config
            .desktop_secret
            .as_deref()
            .is_some_and(|secret| constant_time_eq(secret.as_bytes(), credential.as_bytes()));
        let token_ok = !config.device_token.is_empty()
            && constant_time_eq(config.device_token.as_bytes(), credential.as_bytes());
        if secret_ok || token_ok {
            return true;
        }

        match verify_firebase_id_token_against_auth_emulator(config, credential).await {
            Ok(valid) => valid,
            Err(error) => {
                log::warn!("failed to verify KSP Firebase credential: {error}");
                false
            }
        }
    }

    async fn attach(&mut self, task_id: String, kind: StreamKind, from_seq: u64) {
        let session_id = match self.resolve_session_id(&task_id) {
            Ok(session_id) => session_id,
            Err(message) => {
                self.error(Some(task_id), "no_session", message).await;
                return;
            }
        };

        // Replace any existing attachment for this (task, kind).
        if let Some(existing) = self.attachments.remove(&(task_id.clone(), kind)) {
            existing.abort();
        }

        let frame_tx = self.frame_tx.clone();
        let daemon_dir = self.state.config().daemon_dir.clone();
        let key = (task_id.clone(), kind);
        let task = match kind {
            StreamKind::Agent => tokio::spawn(stream_agent(
                daemon_dir, task_id, session_id, from_seq, frame_tx,
            )),
            StreamKind::Terminal => {
                tokio::spawn(stream_terminal(daemon_dir, task_id, session_id, frame_tx))
            }
        };
        self.attachments.insert(key, task);
    }
}

async fn verify_firebase_id_token_against_auth_emulator(
    config: &crate::config::Config,
    id_token: &str,
) -> Result<bool, String> {
    let Some(auth_emulator_url) = config.firebase_auth_emulator_url.as_deref() else {
        return Ok(false);
    };
    let base_url = auth_emulator_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Ok(false);
    }

    let url = format!(
        "{base_url}/identitytoolkit.googleapis.com/v1/accounts:lookup?key={}",
        config.firebase_project_id
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to build Firebase ID token verifier: {error}"))?;
    let response = client
        .post(url)
        .json(&serde_json::json!({ "idToken": id_token }))
        .send()
        .await
        .map_err(|error| format!("failed to verify Firebase ID token: {error}"))?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let body = response
        .json::<FirebaseLookupResponse>()
        .await
        .map_err(|error| format!("failed to parse Firebase ID token lookup response: {error}"))?;
    Ok(body.users.is_some_and(|users| !users.is_empty()))
}

/// Per-attachment forwarding task: its own daemon connection attaches to the
/// agent session, relays the snapshot, then streams live events until either
/// side closes.
async fn stream_agent(
    daemon_dir: String,
    task_id: String,
    session_id: String,
    from_seq: u64,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let send_error = |message: String| {
        let frame_tx = frame_tx.clone();
        let task_id = task_id.clone();
        async move {
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: "daemon".to_string(),
                    message,
                })
                .await;
        }
    };

    let connected = DaemonClient::connect(&daemon_dir)
        .await
        .map_err(|error| error.to_string());
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            send_error(format!("daemon error: {error}")).await;
            return;
        }
    };

    let reply = client
        .send_command(&DaemonCommand::AttachAgent {
            session_id: session_id.clone(),
            from_seq,
        })
        .await
        .map_err(|error| error.to_string());
    match reply {
        Ok(DaemonEvent::AgentSnapshot {
            next_seq, events, ..
        }) => {
            let events = events
                .into_iter()
                .map(|entry| FrameAgentEvent {
                    seq: entry.seq,
                    event: entry.event,
                })
                .collect();
            if frame_tx
                .send(ServerFrame::AgentSnapshot {
                    task_id: task_id.clone(),
                    next_seq,
                    events,
                })
                .await
                .is_err()
            {
                return;
            }
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            send_error(message).await;
            return;
        }
        Ok(other) => {
            send_error(format!("unexpected attach reply: {other:?}")).await;
            return;
        }
        Err(error) => {
            send_error(format!("daemon error: {error}")).await;
            return;
        }
    }

    loop {
        match client.read_event().await.map_err(|error| error.to_string()) {
            Ok(DaemonEvent::AgentEvent {
                session_id: event_session,
                seq,
                event,
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::AgentEvent {
                        task_id: task_id.clone(),
                        seq,
                        event,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Ok(DaemonEvent::StatusChanged {
                session_id: event_session,
                status,
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::StatusChanged {
                        task_id: task_id.clone(),
                        status: status_str(status).to_string(),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: event_session,
                code,
                ..
            }) if event_session == session_id => {
                let _ = frame_tx
                    .send(ServerFrame::SessionExit {
                        task_id: task_id.clone(),
                        code,
                    })
                    .await;
                // The session may resume (provider respawn); keep streaming.
            }
            Ok(DaemonEvent::ShuttingDown) | Err(_) => {
                // Daemon restart: the client reconnects and re-attaches with
                // its last seq; nothing to do here.
                return;
            }
            Ok(_) => {}
        }
    }
}

/// Terminal stream: daemon AttachSnapshot returns the authoritative headless
/// terminal snapshot first, then the same connection receives live Output.
async fn stream_terminal(
    daemon_dir: String,
    task_id: String,
    session_id: String,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let connected = DaemonClient::connect(&daemon_dir)
        .await
        .map_err(|error| error.to_string());
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: "daemon".to_string(),
                    message: format!("daemon error: {error}"),
                })
                .await;
            return;
        }
    };
    let attach_reply = client
        .send_command(&DaemonCommand::AttachSnapshot {
            session_id: session_id.clone(),
            emulate_terminal: true,
        })
        .await
        .map_err(|error| error.to_string());
    match attach_reply {
        Ok(DaemonEvent::Snapshot { snapshot, .. }) => {
            let frame = ServerFrame::TermSnapshot {
                task_id: task_id.clone(),
                cols: snapshot.cols,
                rows: snapshot.rows,
                data_b64: b64(snapshot.vt.as_bytes()),
            };
            if frame_tx.send(frame).await.is_err() {
                return;
            }
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            let code = if message.contains("session not found") {
                "session_not_found"
            } else {
                "daemon"
            };
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: code.to_string(),
                    message,
                })
                .await;
            return;
        }
        Ok(other) => {
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: "daemon".to_string(),
                    message: format!("unexpected attach reply: {other:?}"),
                })
                .await;
            return;
        }
        Err(error) => {
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: "daemon".to_string(),
                    message: format!("daemon error: {error}"),
                })
                .await;
            return;
        }
    }

    loop {
        match client.read_event().await.map_err(|error| error.to_string()) {
            Ok(DaemonEvent::Output {
                session_id: event_session,
                data,
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::TermOutput {
                        task_id: task_id.clone(),
                        data_b64: b64(&data),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: event_session,
                code,
                ..
            }) if event_session == session_id => {
                let _ = frame_tx
                    .send(ServerFrame::SessionExit { task_id, code })
                    .await;
                return;
            }
            Ok(DaemonEvent::ShuttingDown) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    fn test_config(desktop_id: &str, desktop_name: &str) -> crate::config::Config {
        crate::config::Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: crate::db::Db::test_db_path(desktop_id),
            desktop_id: desktop_id.to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: desktop_name.to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}.json"),
        }
    }

    async fn serve_test_router() -> String {
        let router = crate::http_api::test_router("ksp-test", "KSP Test");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("ws://{addr}/v1/stream")
    }

    async fn ws_connect(
        url: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .expect("ws connect");
        socket
    }

    async fn send_frame(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        frame: &ClientFrame,
    ) {
        let json = serde_json::to_string(frame).expect("serialize frame");
        socket
            .send(TungsteniteMessage::Text(json.into()))
            .await
            .expect("send frame");
    }

    async fn recv_frame(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> ServerFrame {
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
                .await
                .expect("timed out waiting for frame")
                .expect("socket closed")
                .expect("socket error");
            if let TungsteniteMessage::Text(text) = message {
                return serde_json::from_str(&text).expect("parse server frame");
            }
        }
    }

    #[tokio::test]
    async fn auth_handshake_then_request_dispatch() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        // Request frames route into the same task API the REST endpoints use.
        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 7,
                method: "GET".into(),
                path: "/v1/status".into(),
                body: None,
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::Response { id, status, body } => {
                assert_eq!(id, 7);
                assert_eq!(status, 200);
                let body = body.expect("status body");
                assert_eq!(body["desktopId"], "ksp-test");
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn frames_before_auth_are_rejected() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(
            &mut socket,
            &ClientFrame::AgentInterrupt {
                task_id: "t1".into(),
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthenticated"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn attach_unknown_task_reports_no_session() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "missing-task".into(),
                kind: StreamKind::Agent,
                from_seq: 0,
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::Error { code, task_id, .. } => {
                assert_eq!(code, "no_session");
                assert_eq!(task_id.as_deref(), Some("missing-task"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn relay_tunnel_control_frames_are_ignored_by_ksp() {
        assert!(is_relay_tunnel_control_message(
            r#"{"type":"tunnel_ready","tunnelId":"t1","desktopId":"desktop-1"}"#
        ));
        assert!(!is_relay_tunnel_control_message(
            r#"{"type":"auth","credential":"token"}"#
        ));
    }

    #[tokio::test]
    async fn tunnel_stream_rejects_missing_or_bad_credential() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-auth-test",
            "KSP Auth Test",
        )));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            outgoing_tx,
            state,
            AuthMode::RequireCredential,
        ));

        incoming_tx
            .send(serde_json::to_string(&ClientFrame::Auth { credential: None }).unwrap())
            .await
            .unwrap();
        let frame: ServerFrame =
            serde_json::from_str(&outgoing_rx.recv().await.expect("error frame")).unwrap();
        match frame {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn tunnel_stream_accepts_desktop_secret_credential() {
        let mut config = test_config("ksp-auth-ok", "KSP Auth OK");
        config.desktop_secret = Some("desktop-secret".to_string());
        let state = Arc::new(crate::http_api::AppState::new(config));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            outgoing_tx,
            state,
            AuthMode::RequireCredential,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: Some("desktop-secret".to_string()),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let frame: ServerFrame =
            serde_json::from_str(&outgoing_rx.recv().await.expect("auth ok frame")).unwrap();
        assert_eq!(frame, ServerFrame::AuthOk);
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn tunnel_stream_rejects_wrong_nonempty_credential() {
        // Regression guard: a non-empty credential must not pass on the
        // strength of being non-empty — the secret comparison is the gate.
        let mut config = test_config("ksp-auth-wrong", "KSP Auth Wrong");
        config.desktop_secret = Some("desktop-secret".to_string());
        let state = Arc::new(crate::http_api::AppState::new(config));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            outgoing_tx,
            state,
            AuthMode::RequireCredential,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: Some("not-the-secret".to_string()),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let frame: ServerFrame =
            serde_json::from_str(&outgoing_rx.recv().await.expect("error frame")).unwrap();
        match frame {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        drop(incoming_tx);
        let _ = task.await;
    }
}
