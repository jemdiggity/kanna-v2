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
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use kanna_agent_protocol::{ClientFrame, FrameAgentEvent, ServerFrame, StreamKind};
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent, SessionStatus};

use crate::daemon_client::DaemonClient;
use crate::db::Db;
use crate::http_api::{dispatch_http_invoke, AppState};

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn status_str(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Busy => "busy",
        SessionStatus::Waiting => "waiting",
        SessionStatus::Idle => "idle",
    }
}

pub async fn handle_stream(socket: WebSocket, state: Arc<AppState>) {
    let (ws_tx, mut ws_rx) = socket.split();
    let (frame_tx, frame_rx) = mpsc::channel::<ServerFrame>(256);
    let writer_task = tokio::spawn(write_frames(ws_tx, frame_rx));

    let mut conn = StreamConn {
        state,
        frame_tx,
        attachments: HashMap::new(),
        authed: false,
    };

    while let Some(Ok(message)) = ws_rx.next().await {
        let text = match message {
            WsMessage::Text(text) => text,
            WsMessage::Close(_) => break,
            _ => continue,
        };
        match serde_json::from_str::<ClientFrame>(&text) {
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

async fn write_frames(
    mut ws_tx: SplitSink<WebSocket, WsMessage>,
    mut frame_rx: mpsc::Receiver<ServerFrame>,
) {
    while let Some(frame) = frame_rx.recv().await {
        let Ok(json) = serde_json::to_string(&frame) else {
            continue;
        };
        if ws_tx.send(WsMessage::Text(json.into())).await.is_err() {
            return;
        }
    }
}

struct StreamConn {
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    attachments: HashMap<(String, StreamKind), JoinHandle<()>>,
    authed: bool,
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
                ClientFrame::Auth { .. } => {
                    // Trust model parity with the existing LAN API: reaching
                    // this socket (localhost, LAN port, or an authenticated
                    // relay tunnel) is the credential today. Pairing-token
                    // verification lands with the tunnel work (phase 4).
                    self.authed = true;
                    self.send(ServerFrame::AuthOk).await;
                    true
                }
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
}
