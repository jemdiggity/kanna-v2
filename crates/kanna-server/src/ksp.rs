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

mod auth;

use auth::verify_firebase_id_token;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    AllowEmpty,
    #[allow(dead_code)]
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

    fn resolve_terminal_session_id(&self, task_id: &str) -> Result<String, String> {
        if task_id.starts_with("shell-") {
            return Ok(task_id.to_string());
        }
        self.resolve_session_id(task_id)
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
            ClientFrame::AgentSetModel { task_id, model } => {
                match self.resolve_session_id(&task_id) {
                    Ok(session_id) => {
                        self.expect_ok(
                            &task_id,
                            DaemonCommand::AgentSetModel { session_id, model },
                        )
                        .await;
                    }
                    Err(message) => self.error(Some(task_id), "no_session", message).await,
                }
            }
            ClientFrame::TermInput { task_id, data_b64 } => {
                let data = match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                    Ok(data) => data,
                    Err(error) => {
                        self.error(Some(task_id), "bad_frame", format!("bad base64: {error}"))
                            .await;
                        return true;
                    }
                };
                match self.resolve_terminal_session_id(&task_id) {
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
            } => match self.resolve_terminal_session_id(&task_id) {
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

        match verify_firebase_id_token(config, credential).await {
            Ok(valid) => valid,
            Err(error) => {
                log::warn!("failed to verify KSP Firebase credential: {error}");
                false
            }
        }
    }

    async fn attach(&mut self, task_id: String, kind: StreamKind, from_seq: u64) {
        let session_id = match match kind {
            StreamKind::Agent => self.resolve_session_id(&task_id),
            StreamKind::Terminal => self.resolve_terminal_session_id(&task_id),
        } {
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

/// Reconnect backoff for a daemon connection lost mid-stream (daemon
/// restart/handoff). The last entry repeats, mirroring the desktop event
/// bridge's reconnect policy: sessions survive daemon restarts, so the
/// attachment stays alive and transparently re-attaches rather than leaving
/// the client silently frozen on a dead stream.
const DAEMON_STREAM_RETRY_DELAYS_MS: [u64; 5] = [250, 500, 1000, 2000, 5000];

async fn daemon_stream_retry_delay(attempt: usize) {
    let delay = DAEMON_STREAM_RETRY_DELAYS_MS[attempt.min(DAEMON_STREAM_RETRY_DELAYS_MS.len() - 1)];
    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
}

/// How a single attach-and-forward run over one daemon connection ended.
enum StreamRunEnd {
    /// The stream is definitively over (client gone, session exited, or a
    /// fatal daemon reply was forwarded to the client). Stop the attachment.
    Done,
    /// The daemon connection dropped mid-stream (restart/handoff/crash).
    /// The session may still be alive in the replacement daemon; re-attach.
    DaemonLost,
}

/// Per-attachment forwarding task: its own daemon connection attaches to the
/// agent session, relays the snapshot, then streams live events. If the
/// daemon connection is lost after a successful attach, re-attaches with
/// backoff from the last forwarded seq so clients resume seamlessly.
async fn stream_agent(
    daemon_dir: String,
    task_id: String,
    session_id: String,
    from_seq: u64,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let mut next_from_seq = from_seq;
    let mut attached_once = false;
    let mut retry_attempt = 0usize;
    loop {
        match stream_agent_once(
            &daemon_dir,
            &task_id,
            &session_id,
            &mut next_from_seq,
            &mut attached_once,
            &frame_tx,
        )
        .await
        {
            StreamRunEnd::Done => return,
            StreamRunEnd::DaemonLost => {
                log::warn!(
                    "[ksp] agent stream lost daemon connection (session={session_id}, attempt={retry_attempt}); re-attaching"
                );
                daemon_stream_retry_delay(retry_attempt).await;
                retry_attempt += 1;
            }
        }
    }
}

async fn stream_agent_once(
    daemon_dir: &str,
    task_id: &str,
    session_id: &str,
    next_from_seq: &mut u64,
    attached_once: &mut bool,
    frame_tx: &mpsc::Sender<ServerFrame>,
) -> StreamRunEnd {
    let send_error = |message: String| {
        let frame_tx = frame_tx.clone();
        let task_id = task_id.to_string();
        async move {
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
        }
    };
    // Before the first successful attach, transport failures are surfaced to
    // the client (it has never seen this stream, so an error beats silence).
    // After that, they mean the daemon went away mid-stream: re-attach.
    let transport_failure = |attached_once: bool| {
        if attached_once {
            StreamRunEnd::DaemonLost
        } else {
            StreamRunEnd::Done
        }
    };

    let connected = DaemonClient::connect(daemon_dir)
        .await
        .map_err(|error| error.to_string());
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            if !*attached_once {
                send_error(format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    };

    let reply = client
        .send_command(&DaemonCommand::AttachAgent {
            session_id: session_id.to_string(),
            from_seq: *next_from_seq,
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
            *next_from_seq = next_seq;
            *attached_once = true;
            if frame_tx
                .send(ServerFrame::AgentSnapshot {
                    task_id: task_id.to_string(),
                    next_seq,
                    events,
                })
                .await
                .is_err()
            {
                return StreamRunEnd::Done;
            }
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            send_error(message).await;
            return StreamRunEnd::Done;
        }
        Ok(other) => {
            send_error(format!("unexpected attach reply: {other:?}")).await;
            return StreamRunEnd::Done;
        }
        Err(error) => {
            if !*attached_once {
                send_error(format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    }

    loop {
        match client.read_event().await.map_err(|error| error.to_string()) {
            Ok(DaemonEvent::AgentEvent {
                session_id: event_session,
                seq,
                event,
            }) if event_session == session_id => {
                *next_from_seq = seq + 1;
                if frame_tx
                    .send(ServerFrame::AgentEvent {
                        task_id: task_id.to_string(),
                        seq,
                        event,
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::StatusChanged {
                session_id: event_session,
                status,
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::StatusChanged {
                        task_id: task_id.to_string(),
                        status: status_str(status).to_string(),
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: event_session,
                code,
                ..
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::SessionExit {
                        task_id: task_id.to_string(),
                        code,
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
                // The session may resume (provider respawn); keep streaming.
            }
            Ok(DaemonEvent::ShuttingDown) | Err(_) => {
                return StreamRunEnd::DaemonLost;
            }
            Ok(_) => {}
        }
    }
}

/// Terminal stream: daemon AttachSnapshot returns the authoritative headless
/// terminal snapshot first, then the same connection receives live Output.
/// If the daemon connection is lost after a successful attach (daemon
/// restart/handoff), re-attaches with backoff; the fresh snapshot resyncs the
/// client instead of leaving it frozen on a dead stream.
async fn stream_terminal(
    daemon_dir: String,
    task_id: String,
    session_id: String,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let mut attached_once = false;
    let mut retry_attempt = 0usize;
    loop {
        match stream_terminal_once(
            &daemon_dir,
            &task_id,
            &session_id,
            &mut attached_once,
            &frame_tx,
        )
        .await
        {
            StreamRunEnd::Done => return,
            StreamRunEnd::DaemonLost => {
                log::warn!(
                    "[ksp] terminal stream lost daemon connection (session={session_id}, attempt={retry_attempt}); re-attaching"
                );
                daemon_stream_retry_delay(retry_attempt).await;
                retry_attempt += 1;
            }
        }
    }
}

async fn stream_terminal_once(
    daemon_dir: &str,
    task_id: &str,
    session_id: &str,
    attached_once: &mut bool,
    frame_tx: &mpsc::Sender<ServerFrame>,
) -> StreamRunEnd {
    let send_error = |code: &'static str, message: String| {
        let frame_tx = frame_tx.clone();
        let task_id = task_id.to_string();
        async move {
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: code.to_string(),
                    message,
                })
                .await;
        }
    };
    // Before the first successful attach, transport failures are surfaced to
    // the client (it has never seen this stream, so an error beats silence).
    // After that, they mean the daemon went away mid-stream: re-attach.
    let transport_failure = |attached_once: bool| {
        if attached_once {
            StreamRunEnd::DaemonLost
        } else {
            StreamRunEnd::Done
        }
    };

    let connected = DaemonClient::connect(daemon_dir)
        .await
        .map_err(|error| error.to_string());
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            if !*attached_once {
                send_error("daemon", format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    };
    let attach_reply = client
        .send_command(&DaemonCommand::AttachSnapshot {
            session_id: session_id.to_string(),
            emulate_terminal: true,
        })
        .await
        .map_err(|error| error.to_string());
    match attach_reply {
        Ok(DaemonEvent::Snapshot { snapshot, .. }) => {
            *attached_once = true;
            let frame = ServerFrame::TermSnapshot {
                task_id: task_id.to_string(),
                cols: snapshot.cols,
                rows: snapshot.rows,
                data_b64: b64(snapshot.vt.as_bytes()),
            };
            if frame_tx.send(frame).await.is_err() {
                return StreamRunEnd::Done;
            }
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            let code = if message.contains("session not found") {
                "session_not_found"
            } else {
                "daemon"
            };
            send_error(code, message).await;
            return StreamRunEnd::Done;
        }
        Ok(other) => {
            send_error("daemon", format!("unexpected attach reply: {other:?}")).await;
            return StreamRunEnd::Done;
        }
        Err(error) => {
            if !*attached_once {
                send_error("daemon", format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
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
                        task_id: task_id.to_string(),
                        data_b64: b64(&data),
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: event_session,
                code,
                ..
            }) if event_session == session_id => {
                let _ = frame_tx
                    .send(ServerFrame::SessionExit {
                        task_id: task_id.to_string(),
                        code,
                    })
                    .await;
                return StreamRunEnd::Done;
            }
            Ok(DaemonEvent::ShuttingDown) | Err(_) => return StreamRunEnd::DaemonLost,
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    fn test_config(desktop_id: &str, desktop_name: &str) -> crate::config::Config {
        crate::config::Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: crate::db::Db::test_db_path(desktop_id),
            kanna_cli_path: None,
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
        serve_router(router).await
    }

    async fn serve_router(router: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("ws://{addr}/v1/stream")
    }

    fn daemon_socket_path_for_dir(daemon_dir: &str) -> PathBuf {
        kanna_runtime_defaults::socket_path(std::path::Path::new(daemon_dir))
    }

    async fn spawn_fake_daemon_once(daemon_dir: String) -> tokio::task::JoinHandle<DaemonCommand> {
        spawn_fake_daemon_once_with_response(daemon_dir, DaemonEvent::Ok).await
    }

    async fn spawn_fake_daemon_once_with_response(
        daemon_dir: String,
        response: DaemonEvent,
    ) -> tokio::task::JoinHandle<DaemonCommand> {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read daemon command");
            let command: DaemonCommand =
                serde_json::from_str(line.trim()).expect("parse daemon command");
            let response = serde_json::to_string(&response).expect("serialize daemon response");
            write_half
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("write daemon response");
            command
        })
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
    fn shell_terminal_ids_resolve_directly_to_daemon_sessions() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-shell-terminal",
            "KSP Shell Terminal",
        )));
        let (frame_tx, _frame_rx) = mpsc::channel(1);
        let conn = StreamConn {
            state,
            frame_tx,
            attachments: HashMap::new(),
            authed: true,
            auth_mode: AuthMode::AllowEmpty,
        };

        assert_eq!(
            conn.resolve_terminal_session_id("shell-wt-task-1"),
            Ok("shell-wt-task-1".to_string()),
        );
        assert_eq!(
            conn.resolve_terminal_session_id("shell-repo-repo-1"),
            Ok("shell-repo-repo-1".to_string()),
        );
    }

    #[tokio::test]
    async fn terminal_stream_preserves_snapshot_and_split_multibyte_output_bytes() {
        let unique = format!(
            "ksp-terminal-bytes-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            let (stream, _) = daemon_listener
                .accept()
                .await
                .expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read attach snapshot command");
            let command: DaemonCommand =
                serde_json::from_str(line.trim()).expect("parse attach snapshot command");
            match command {
                DaemonCommand::AttachSnapshot {
                    session_id,
                    emulate_terminal,
                } => {
                    assert_eq!(session_id, "daemon-terminal-1");
                    assert!(emulate_terminal);
                }
                other => panic!("expected AttachSnapshot command, got {other:?}"),
            }

            let snapshot = DaemonEvent::Snapshot {
                session_id: "daemon-terminal-1".to_string(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 1,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: "╭─界─╮\n".to_string(),
                },
            };
            let output_prefix = DaemonEvent::Output {
                session_id: "daemon-terminal-1".to_string(),
                data: vec![0xf0, 0x9f],
            };
            let output_suffix = DaemonEvent::Output {
                session_id: "daemon-terminal-1".to_string(),
                data: vec![0x98, 0x80, b'\n'],
            };
            let exit = DaemonEvent::Exit {
                session_id: "daemon-terminal-1".to_string(),
                code: 0,
                resume_session_id: None,
                killed: false,
            };

            for event in [snapshot, output_prefix, output_suffix, exit] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .expect("write daemon event");
            }
        });

        let mut config = test_config("ksp-terminal-bytes", "KSP Terminal Bytes");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Terminal bytes",
            None,
            "in progress",
            "2026-06-20T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-terminal-1",
        )
        .expect("insert terminal session");

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
            },
        )
        .await;

        let decode = |data_b64: String| {
            base64::engine::general_purpose::STANDARD
                .decode(data_b64)
                .expect("decode terminal frame")
        };

        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot {
                task_id,
                cols,
                rows,
                data_b64,
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                assert_eq!(decode(data_b64), "╭─界─╮\n".as_bytes());
            }
            other => panic!("expected terminal snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { task_id, data_b64 } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(decode(data_b64), vec![0xf0, 0x9f]);
            }
            other => panic!("expected first terminal output, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { task_id, data_b64 } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(decode(data_b64), vec![0x98, 0x80, b'\n']);
            }
            other => panic!("expected second terminal output, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::SessionExit { task_id, code } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(code, 0);
            }
            other => panic!("expected session exit, got {other:?}"),
        }

        daemon.await.expect("fake daemon task failed");
        drop(socket);
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_stream_reattaches_after_daemon_connection_loss() {
        let unique = format!(
            "ksp-terminal-reattach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let session_id = "shell-wt-reattach-1";

        // A daemon that dies after the first attach (connection dropped with
        // no Exit event — the handoff/restart shape) and then serves a second
        // attach from its replacement.
        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            for round in 0..2u32 {
                let (stream, _) = daemon_listener
                    .accept()
                    .await
                    .expect("accept daemon connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("read command");
                let command: DaemonCommand =
                    serde_json::from_str(line.trim()).expect("parse command");
                match command {
                    DaemonCommand::AttachSnapshot {
                        session_id: attached,
                        ..
                    } => assert_eq!(attached, "shell-wt-reattach-1"),
                    other => panic!("expected AttachSnapshot, got {other:?}"),
                }

                let vt = if round == 0 {
                    "before restart"
                } else {
                    "after restart"
                };
                let mut events = vec![
                    DaemonEvent::Snapshot {
                        session_id: "shell-wt-reattach-1".to_string(),
                        snapshot: kanna_daemon::protocol::TerminalSnapshot {
                            version: 1,
                            rows: 24,
                            cols: 80,
                            cursor_row: 0,
                            cursor_col: 0,
                            cursor_visible: true,
                            saved_at: 0,
                            sequence: 0,
                            vt: vt.to_string(),
                        },
                    },
                    DaemonEvent::Output {
                        session_id: "shell-wt-reattach-1".to_string(),
                        data: format!("output {round}").into_bytes(),
                    },
                ];
                if round == 1 {
                    events.push(DaemonEvent::Exit {
                        session_id: "shell-wt-reattach-1".to_string(),
                        code: 0,
                        resume_session_id: None,
                    });
                }
                for event in events {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                        )
                        .await
                        .expect("write daemon event");
                }
                // round 0: drop the connection here without an Exit event.
            }
        });

        let mut config = test_config("ksp-terminal-reattach", "KSP Terminal Reattach");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: session_id.into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
            },
        )
        .await;

        let decode = |data_b64: String| {
            base64::engine::general_purpose::STANDARD
                .decode(data_b64)
                .expect("decode terminal frame")
        };

        // First attach: snapshot + output, then the daemon connection dies.
        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"before restart");
            }
            other => panic!("expected first snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"output 0");
            }
            other => panic!("expected first output, got {other:?}"),
        }

        // The stream must transparently re-attach (no client action, no error
        // frame) and resync with a fresh snapshot instead of going silent.
        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"after restart");
            }
            other => panic!("expected re-attach snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"output 1");
            }
            other => panic!("expected post-restart output, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::SessionExit { code, .. } => assert_eq!(code, 0),
            other => panic!("expected session exit, got {other:?}"),
        }

        daemon.await.expect("fake daemon task failed");
        drop(socket);
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn agent_stream_reattaches_from_last_seq_after_daemon_connection_loss() {
        let unique = format!(
            "ksp-agent-reattach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            // Round 0: attach from seq 0, snapshot to next_seq=2, one live
            // event at seq 2, then the connection dies without warning.
            // Round 1: the replacement daemon must be asked for seq 3.
            for round in 0..2u32 {
                let (stream, _) = daemon_listener
                    .accept()
                    .await
                    .expect("accept daemon connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("read command");
                let command: DaemonCommand =
                    serde_json::from_str(line.trim()).expect("parse command");
                let from_seq = match command {
                    DaemonCommand::AttachAgent {
                        session_id,
                        from_seq,
                    } => {
                        assert_eq!(session_id, "daemon-agent-reattach-1");
                        from_seq
                    }
                    other => panic!("expected AttachAgent, got {other:?}"),
                };
                if round == 0 {
                    assert_eq!(from_seq, 0);
                } else {
                    assert_eq!(
                        from_seq, 3,
                        "re-attach must resume from the last forwarded seq"
                    );
                }

                let events = if round == 0 {
                    vec![
                        DaemonEvent::AgentSnapshot {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            next_seq: 2,
                            events: vec![],
                        },
                        DaemonEvent::AgentEvent {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            seq: 2,
                            event: kanna_daemon::protocol::NeutralAgentEvent::AssistantText {
                                text: "before restart".to_string(),
                                truncated: false,
                            },
                        },
                    ]
                } else {
                    vec![
                        DaemonEvent::AgentSnapshot {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            next_seq: 3,
                            events: vec![],
                        },
                        DaemonEvent::AgentEvent {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            seq: 3,
                            event: kanna_daemon::protocol::NeutralAgentEvent::AssistantText {
                                text: "after restart".to_string(),
                                truncated: false,
                            },
                        },
                    ]
                };
                for event in events {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                        )
                        .await
                        .expect("write daemon event");
                }
            }
        });

        let mut config = test_config("ksp-agent-reattach", "KSP Agent Reattach");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Agent reattach",
            None,
            "in progress",
            "2026-07-05T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-agent-reattach-1",
        )
        .expect("insert terminal session");

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Agent,
                from_seq: 0,
            },
        )
        .await;

        match recv_frame(&mut socket).await {
            ServerFrame::AgentSnapshot { next_seq, .. } => assert_eq!(next_seq, 2),
            other => panic!("expected first agent snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::AgentEvent { seq, .. } => assert_eq!(seq, 2),
            other => panic!("expected first agent event, got {other:?}"),
        }
        // Daemon connection lost; the stream re-attaches from seq 3 and keeps
        // flowing without any client-side action.
        match recv_frame(&mut socket).await {
            ServerFrame::AgentSnapshot { next_seq, .. } => assert_eq!(next_seq, 3),
            other => panic!("expected re-attach agent snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::AgentEvent { seq, .. } => assert_eq!(seq, 3),
            other => panic!("expected post-restart agent event, got {other:?}"),
        }

        daemon.await.expect("fake daemon task failed");
        drop(socket);
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn shell_terminal_attach_routes_directly_to_daemon_session() {
        let unique = format!(
            "ksp-shell-attach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-shell-attach", "KSP Shell Attach");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let daemon = spawn_fake_daemon_once_with_response(
            config.daemon_dir.clone(),
            DaemonEvent::Snapshot {
                session_id: "shell-wt-task-1".to_string(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 0,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: "shell prompt".to_string(),
                },
            },
        )
        .await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "shell-wt-task-1".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
            },
        )
        .await;

        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot {
                task_id,
                cols,
                rows,
                data_b64,
            } => {
                assert_eq!(task_id, "shell-wt-task-1");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(data_b64.as_bytes())
                    .expect("decode terminal snapshot");
                assert_eq!(String::from_utf8(decoded).unwrap(), "shell prompt");
            }
            other => panic!("expected TermSnapshot, got {other:?}"),
        }

        let command = tokio::time::timeout(std::time::Duration::from_secs(5), daemon)
            .await
            .expect("timed out waiting for daemon command")
            .expect("fake daemon task failed");
        match command {
            DaemonCommand::AttachSnapshot {
                session_id,
                emulate_terminal,
            } => {
                assert_eq!(session_id, "shell-wt-task-1");
                assert!(emulate_terminal);
            }
            other => panic!("expected AttachSnapshot command, got {other:?}"),
        }

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn agent_set_model_frame_routes_to_daemon_command() {
        let unique = format!(
            "ksp-set-model-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-set-model", "KSP Set Model");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Switch models",
            None,
            "in progress",
            "2026-06-17T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-agent-1",
        )
        .expect("insert terminal session");

        let daemon = spawn_fake_daemon_once(config.daemon_dir.clone()).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::AgentSetModel {
                task_id: "task-1".into(),
                model: "claude-haiku-4-5-20251001".into(),
            },
        )
        .await;

        let command = tokio::time::timeout(std::time::Duration::from_secs(5), daemon)
            .await
            .expect("timed out waiting for daemon command")
            .expect("fake daemon task failed");
        match command {
            DaemonCommand::AgentSetModel { session_id, model } => {
                assert_eq!(session_id, "daemon-agent-1");
                assert_eq!(model, "claude-haiku-4-5-20251001");
            }
            other => panic!("expected AgentSetModel command, got {other:?}"),
        }

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
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
