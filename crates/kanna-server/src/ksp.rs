//! Kanna Stream Protocol (KSP) endpoint: one multiplexed WebSocket per
//! client carrying agent streams, terminal streams, and task-API requests as
//! task-addressed JSON frames. The same handler serves localhost (the local
//! desktop app), LAN clients, and — via the relay tunnel — cloud clients.
//!
//! Frame schema: `crates/kanna-agent-protocol/src/frames.rs` (TS mirrors in
//! `packages/agent-protocol`).

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as WsMessage, WebSocket};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use kanna_agent_protocol::{
    ClientFrame, CompanionEvent, FrameAgentEvent, PermissionDecision, ServerFrame, StreamKind,
};
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
    let mut state_change_rx = state.subscribe_state_changes();
    let state_change_tx = frame_tx.clone();
    let state_change_task = tokio::spawn(async move {
        loop {
            match state_change_rx.recv().await {
                Ok(frame) => {
                    if state_change_tx.send(frame).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    let mut conn = StreamConn {
        state,
        frame_tx,
        attachments: HashMap::new(),
        terminal_controls: HashMap::new(),
        agent_commands: None,
        requests: None,
        companion_event_times: HashMap::new(),
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
    conn.shutdown().await;
    drop(conn);
    state_change_task.abort();
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
    terminal_controls: HashMap<String, TerminalControlHandle>,
    agent_commands: Option<AgentCommandWorker>,
    requests: Option<RequestWorker>,
    companion_event_times: HashMap<(String, String), VecDeque<Instant>>,
    authed: bool,
    auth_mode: AuthMode,
}

const TERMINAL_CONTROL_QUEUE_CAPACITY: usize = 256;
const AGENT_COMMAND_QUEUE_CAPACITY: usize = 256;
const REQUEST_QUEUE_CAPACITY: usize = 32;
const MAX_REQUEST_CONCURRENCY: usize = 4;

enum AgentControlCommand {
    Input(String),
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    Interrupt,
    SetModel(String),
}

impl AgentControlCommand {
    fn into_daemon_command(self, session_id: String) -> DaemonCommand {
        match self {
            Self::Input(text) => DaemonCommand::AgentInput { session_id, text },
            Self::Permission {
                request_id,
                decision,
            } => DaemonCommand::AgentPermission {
                session_id,
                request_id,
                decision,
            },
            Self::Interrupt => DaemonCommand::AgentInterrupt { session_id },
            Self::SetModel(model) => DaemonCommand::AgentSetModel { session_id, model },
        }
    }
}

struct TaskAgentCommand {
    task_id: String,
    command: AgentControlCommand,
}

struct AgentCommandWorker {
    tx: mpsc::Sender<TaskAgentCommand>,
    task: JoinHandle<()>,
}

struct KspRequest {
    id: u64,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
}

struct RequestWorker {
    tx: mpsc::Sender<KspRequest>,
    task: JoinHandle<()>,
}

fn request_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| {
            parallelism
                .get()
                .saturating_sub(1)
                .clamp(1, MAX_REQUEST_CONCURRENCY)
        })
        .unwrap_or(1)
}

enum TerminalControlCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

impl TerminalControlCommand {
    fn into_daemon_command(self, session_id: String) -> DaemonCommand {
        match self {
            Self::Input(data) => DaemonCommand::InputNoReply { session_id, data },
            Self::Resize { cols, rows } => DaemonCommand::ResizeNoReply {
                session_id,
                cols,
                rows,
            },
        }
    }
}

struct TerminalControlHandle {
    session_id: Option<String>,
    tx: mpsc::Sender<TerminalControlCommand>,
    cancel_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

async fn terminal_control_cancelled(cancel_rx: &mut watch::Receiver<bool>) {
    if *cancel_rx.borrow() {
        return;
    }
    let _ = cancel_rx.changed().await;
}

async fn terminal_control_retry_delay(
    attempt: usize,
    cancel_rx: &mut watch::Receiver<bool>,
) -> bool {
    tokio::select! {
        biased;
        _ = terminal_control_cancelled(cancel_rx) => false,
        _ = daemon_stream_retry_delay(attempt) => true,
    }
}

async fn send_task_error(
    frame_tx: &mpsc::Sender<ServerFrame>,
    task_id: &str,
    code: &str,
    message: String,
) {
    let _ = frame_tx
        .send(ServerFrame::Error {
            task_id: Some(task_id.to_string()),
            code: code.to_string(),
            message,
        })
        .await;
}

async fn resolve_task_session_id(db_path: String, task_id: String) -> Result<String, String> {
    let lookup_task_id = task_id.clone();
    tokio::task::spawn_blocking(move || {
        Db::open(db_path.as_str())
            .and_then(|db| db.resolve_task_terminal_session_id(&lookup_task_id))
            .map_err(|error| format!("db error: {error}"))?
            .ok_or_else(|| format!("no session for task {lookup_task_id}"))
    })
    .await
    .map_err(|error| format!("session lookup worker failed: {error}"))?
}

fn direct_terminal_session_id(task_id: &str) -> Option<String> {
    task_id.starts_with("shell-").then(|| task_id.to_string())
}

async fn run_terminal_control(
    state: Arc<AppState>,
    task_id: String,
    initial_session_id: Option<String>,
    mut command_rx: mpsc::Receiver<TerminalControlCommand>,
    mut cancel_rx: watch::Receiver<bool>,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let session_id = match initial_session_id {
        Some(session_id) => session_id,
        None => {
            let resolved = tokio::select! {
                biased;
                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                resolved = resolve_task_session_id(
                    state.config().db_path.clone(),
                    task_id.clone(),
                ) => resolved,
            };
            match resolved {
                Ok(session_id) => session_id,
                Err(message) => {
                    tokio::select! {
                        biased;
                        _ = terminal_control_cancelled(&mut cancel_rx) => return,
                        _ = send_task_error(&frame_tx, &task_id, "no_session", message) => {}
                    }
                    return;
                }
            }
        }
    };
    let daemon_dir = state.config().daemon_dir.clone();
    let mut retry_attempt = 0usize;
    // Do not open an otherwise idle control socket merely because a terminal
    // attached for output. Keep the first command pending across definite
    // connect failures; after the first connection, reconnect proactively so
    // handoff recovery is ready before the next keypress.
    let mut pending_command = Some(tokio::select! {
        biased;
        _ = terminal_control_cancelled(&mut cancel_rx) => return,
        command = command_rx.recv() => {
            let Some(command) = command else {
                return;
            };
            command
        }
    });

    loop {
        let connected = tokio::select! {
            biased;
            _ = terminal_control_cancelled(&mut cancel_rx) => return,
            connected = async {
                DaemonClient::connect(&daemon_dir)
                    .await
                    .map_err(|error| error.to_string())
            } => connected,
        };
        let client = match connected {
            Ok(client) => client,
            Err(error) => {
                log::warn!(
                    "[ksp] terminal control failed to connect (session={session_id}, attempt={retry_attempt}): {error}"
                );
                if !terminal_control_retry_delay(retry_attempt, &mut cancel_rx).await {
                    return;
                }
                retry_attempt += 1;
                continue;
            }
        };
        let (mut daemon_reader, mut daemon_writer) = client.into_split();
        retry_attempt = 0;

        if let Some(command) = pending_command.take() {
            let daemon_command = command.into_daemon_command(session_id.clone());
            let write_result = tokio::select! {
                biased;
                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                result = async {
                    daemon_writer
                        .send_one_way(&daemon_command)
                        .await
                        .map_err(|error| error.to_string())
                } => result,
            };
            if let Err(error) = write_result {
                let message = format!(
                    "terminal command write was ambiguous and will not be retried: {error}"
                );
                log::warn!("[ksp] {message} (session={session_id})");
                tokio::select! {
                    biased;
                    _ = terminal_control_cancelled(&mut cancel_rx) => return,
                    _ = send_task_error(&frame_tx, &task_id, "daemon", message) => {}
                }
                if !terminal_control_retry_delay(retry_attempt, &mut cancel_rx).await {
                    return;
                }
                retry_attempt += 1;
                continue;
            }
        }

        loop {
            tokio::select! {
                biased;
                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                event = async {
                    daemon_reader
                        .read_event()
                        .await
                        .map_err(|error| error.to_string())
                } => {
                    match event {
                        Ok(DaemonEvent::Error { message, .. }) => {
                            tokio::select! {
                                biased;
                                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                                _ = send_task_error(&frame_tx, &task_id, "daemon", message) => {}
                            }
                        }
                        Ok(DaemonEvent::ShuttingDown) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
                command = command_rx.recv() => {
                    let Some(command) = command else {
                        return;
                    };
                    let daemon_command = command.into_daemon_command(session_id.clone());
                    let write_result = tokio::select! {
                        biased;
                        _ = terminal_control_cancelled(&mut cancel_rx) => return,
                        result = async {
                            daemon_writer
                                .send_one_way(&daemon_command)
                                .await
                                .map_err(|error| error.to_string())
                        } => result,
                    };
                    if let Err(error) = write_result {
                        let message = format!(
                            "terminal command write was ambiguous and will not be retried: {error}"
                        );
                        log::warn!("[ksp] {message} (session={session_id})");
                        tokio::select! {
                            biased;
                            _ = terminal_control_cancelled(&mut cancel_rx) => return,
                            _ = send_task_error(&frame_tx, &task_id, "daemon", message) => {}
                        }
                        break;
                    }
                }
            }
        }

        if !terminal_control_retry_delay(retry_attempt, &mut cancel_rx).await {
            return;
        }
        retry_attempt += 1;
    }
}

async fn run_agent_commands(
    state: Arc<AppState>,
    mut command_rx: mpsc::Receiver<TaskAgentCommand>,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    while let Some(TaskAgentCommand { task_id, command }) = command_rx.recv().await {
        let session_id =
            match resolve_task_session_id(state.config().db_path.clone(), task_id.clone()).await {
                Ok(session_id) => session_id,
                Err(message) => {
                    send_task_error(&frame_tx, &task_id, "no_session", message).await;
                    continue;
                }
            };
        let daemon_command = command.into_daemon_command(session_id);
        let result = async {
            let mut client = DaemonClient::connect(&state.config().daemon_dir)
                .await
                .map_err(|error| format!("daemon error: {error}"))?;
            client
                .send_command(&daemon_command)
                .await
                .map_err(|error| format!("daemon error: {error}"))
        }
        .await;
        match result {
            Ok(DaemonEvent::Ok) => {}
            Ok(DaemonEvent::Error { message, .. }) => {
                send_task_error(&frame_tx, &task_id, "daemon", message).await;
            }
            Ok(other) => {
                send_task_error(
                    &frame_tx,
                    &task_id,
                    "daemon",
                    format!("unexpected daemon reply: {other:?}"),
                )
                .await;
            }
            Err(message) => {
                send_task_error(&frame_tx, &task_id, "daemon", message).await;
            }
        }
    }
}

async fn dispatch_ksp_request(
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    request: KspRequest,
) {
    let KspRequest {
        id,
        method,
        path,
        body,
    } = request;
    let runtime = tokio::runtime::Handle::current();
    let result = tokio::task::spawn_blocking(move || {
        runtime.block_on(dispatch_http_invoke(
            state,
            &method,
            &path,
            body.unwrap_or(serde_json::Value::Null),
        ))
    })
    .await;
    let (status, body) = match result {
        Ok(result) => {
            let body = match result.error {
                Some(error) => Some(serde_json::json!({ "error": error })),
                None => result.body,
            };
            (result.status, body)
        }
        Err(error) => (
            500,
            Some(serde_json::json!({
                "error": format!("KSP request worker failed: {error}")
            })),
        ),
    };
    let _ = frame_tx
        .send(ServerFrame::Response { id, status, body })
        .await;
}

async fn run_request_worker(
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    mut request_rx: mpsc::Receiver<KspRequest>,
) {
    let concurrency = request_concurrency();
    let mut active = tokio::task::JoinSet::new();

    loop {
        if active.len() >= concurrency {
            let _ = active.join_next().await;
            continue;
        }

        tokio::select! {
            request = request_rx.recv() => {
                let Some(request) = request else {
                    break;
                };
                active.spawn(dispatch_ksp_request(
                    state.clone(),
                    frame_tx.clone(),
                    request,
                ));
            }
            completed = active.join_next(), if !active.is_empty() => {
                let _ = completed;
            }
        }
    }
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

    async fn shutdown(&mut self) {
        for (_, task) in self.attachments.drain() {
            task.abort();
        }
        let controls = self
            .terminal_controls
            .drain()
            .map(|(_, control)| control)
            .collect::<Vec<_>>();
        for control in &controls {
            let _ = control.cancel_tx.send(true);
        }
        for control in controls {
            let _ = control.task.await;
        }
        if let Some(worker) = self.agent_commands.take() {
            worker.task.abort();
        }
        if let Some(worker) = self.requests.take() {
            worker.task.abort();
        }
    }

    async fn retire_terminal_control(control: TerminalControlHandle) {
        let _ = control.cancel_tx.send(true);
        let _ = control.task.await;
    }

    fn create_terminal_control(
        &self,
        task_id: String,
        session_id: Option<String>,
    ) -> TerminalControlHandle {
        let (tx, command_rx) = mpsc::channel(TERMINAL_CONTROL_QUEUE_CAPACITY);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task = tokio::spawn(run_terminal_control(
            self.state.clone(),
            task_id,
            session_id.clone(),
            command_rx,
            cancel_rx,
            self.frame_tx.clone(),
        ));
        TerminalControlHandle {
            session_id,
            tx,
            cancel_tx,
            task,
        }
    }

    async fn replace_terminal_control_route(&mut self, task_id: &str, session_id: String) {
        let route_matches = self
            .terminal_controls
            .get(task_id)
            .is_some_and(|control| control.session_id.as_deref() == Some(session_id.as_str()));
        if route_matches {
            return;
        }
        if let Some(existing) = self.terminal_controls.remove(task_id) {
            Self::retire_terminal_control(existing).await;
        }
        let control = self.create_terminal_control(task_id.to_string(), Some(session_id));
        self.terminal_controls.insert(task_id.to_string(), control);
    }

    fn enqueue_terminal_control(&mut self, task_id: String, command: TerminalControlCommand) {
        if !self.terminal_controls.contains_key(&task_id) {
            let session_id = task_id.starts_with("shell-").then(|| task_id.to_string());
            let control = self.create_terminal_control(task_id.clone(), session_id);
            self.terminal_controls.insert(task_id.clone(), control);
        }

        let send_result = self
            .terminal_controls
            .get(&task_id)
            .expect("terminal control inserted")
            .tx
            .try_send(command);
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "terminal_busy",
                        "terminal input queue is full".to_string(),
                    )
                    .await;
                });
            }
            Err(TrySendError::Closed(_)) => {
                if let Some(control) = self.terminal_controls.remove(&task_id) {
                    let _ = control.cancel_tx.send(true);
                    control.task.abort();
                }
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "daemon",
                        "terminal control channel closed".to_string(),
                    )
                    .await;
                });
            }
        }
    }

    fn enqueue_agent_command(&mut self, task_id: String, command: AgentControlCommand) {
        if self.agent_commands.is_none() {
            let (tx, command_rx) = mpsc::channel(AGENT_COMMAND_QUEUE_CAPACITY);
            let task = tokio::spawn(run_agent_commands(
                self.state.clone(),
                command_rx,
                self.frame_tx.clone(),
            ));
            self.agent_commands = Some(AgentCommandWorker { tx, task });
        }

        let send_result = self
            .agent_commands
            .as_ref()
            .expect("agent command worker initialized")
            .tx
            .try_send(TaskAgentCommand {
                task_id: task_id.clone(),
                command,
            });
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "agent_busy",
                        "agent command queue is full".to_string(),
                    )
                    .await;
                });
            }
            Err(TrySendError::Closed(_)) => {
                if let Some(worker) = self.agent_commands.take() {
                    worker.task.abort();
                }
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "daemon",
                        "agent command channel closed".to_string(),
                    )
                    .await;
                });
            }
        }
    }

    fn enqueue_request(&mut self, request: KspRequest) {
        if self.requests.is_none() {
            let (tx, request_rx) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
            let task = tokio::spawn(run_request_worker(
                self.state.clone(),
                self.frame_tx.clone(),
                request_rx,
            ));
            self.requests = Some(RequestWorker { tx, task });
        }

        let send_result = self
            .requests
            .as_ref()
            .expect("request worker initialized")
            .tx
            .try_send(request);
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(request)) => {
                let _ = self.frame_tx.try_send(ServerFrame::Response {
                    id: request.id,
                    status: 503,
                    body: Some(serde_json::json!({
                        "error": "KSP request queue is full"
                    })),
                });
            }
            Err(TrySendError::Closed(request)) => {
                if let Some(worker) = self.requests.take() {
                    worker.task.abort();
                }
                let _ = self.frame_tx.try_send(ServerFrame::Response {
                    id: request.id,
                    status: 500,
                    body: Some(serde_json::json!({
                        "error": "KSP request worker is unavailable"
                    })),
                });
            }
        }
    }

    async fn handle_companion_event(
        &mut self,
        task_id: String,
        session_id: String,
        revision: String,
        event: CompanionEvent,
    ) {
        const EVENT_WINDOW: Duration = Duration::from_secs(10);
        const MAX_EVENTS_PER_WINDOW: usize = 30;

        let event_id = event.event_id.clone();
        let key = (task_id.clone(), session_id.clone());
        let now = Instant::now();
        let recent = self.companion_event_times.entry(key.clone()).or_default();
        while recent
            .front()
            .is_some_and(|timestamp| now.duration_since(*timestamp) >= EVENT_WINDOW)
        {
            recent.pop_front();
        }
        if recent.len() >= MAX_EVENTS_PER_WINDOW {
            self.send(ServerFrame::CompanionEventResult {
                task_id,
                event_id,
                accepted: false,
                code: Some("companion_rate_limited".into()),
                message: Some("Too many visual companion selections were sent.".into()),
            })
            .await;
            return;
        }

        let db_path = self.state.config().db_path.clone();
        let append_result = tokio::task::spawn_blocking(move || {
            crate::visual_companion::append_event(
                &db_path,
                &task_id,
                &session_id,
                &revision,
                &event,
            )
        })
        .await;

        let (task_id, result) = match append_result {
            Ok(result) => (key.0.clone(), result),
            Err(_) => (
                key.0.clone(),
                Err(crate::visual_companion::CompanionError::Internal(
                    "visual companion event worker failed".into(),
                )),
            ),
        };
        match result {
            Ok(()) => {
                self.companion_event_times
                    .entry(key)
                    .or_default()
                    .push_back(Instant::now());
                self.send(ServerFrame::CompanionEventResult {
                    task_id,
                    event_id,
                    accepted: true,
                    code: None,
                    message: None,
                })
                .await;
            }
            Err(error) => {
                let (code, message) = match error {
                    crate::visual_companion::CompanionError::StaleRevision => (
                        "companion_stale_revision",
                        "The visual companion changed before the selection arrived.",
                    ),
                    crate::visual_companion::CompanionError::InvalidEvent => (
                        "companion_invalid_event",
                        "The visual companion selection was invalid.",
                    ),
                    _ => (
                        "companion_event_failed",
                        "The visual companion selection could not be recorded.",
                    ),
                };
                self.send(ServerFrame::CompanionEventResult {
                    task_id,
                    event_id,
                    accepted: false,
                    code: Some(code.into()),
                    message: Some(message.into()),
                })
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
                if let Some(task) = self.attachments.remove(&(task_id.clone(), kind)) {
                    task.abort();
                }
                if kind == StreamKind::Terminal {
                    if let Some(control) = self.terminal_controls.remove(&task_id) {
                        Self::retire_terminal_control(control).await;
                    }
                }
            }
            ClientFrame::AgentInput { task_id, text } => {
                self.enqueue_agent_command(task_id, AgentControlCommand::Input(text));
            }
            ClientFrame::AgentPermission {
                task_id,
                request_id,
                decision,
            } => {
                self.enqueue_agent_command(
                    task_id,
                    AgentControlCommand::Permission {
                        request_id,
                        decision,
                    },
                );
            }
            ClientFrame::AgentInterrupt { task_id } => {
                self.enqueue_agent_command(task_id, AgentControlCommand::Interrupt);
            }
            ClientFrame::AgentSetModel { task_id, model } => {
                self.enqueue_agent_command(task_id, AgentControlCommand::SetModel(model));
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
                self.enqueue_terminal_control(task_id, TerminalControlCommand::Input(data));
            }
            ClientFrame::TermResize {
                task_id,
                cols,
                rows,
            } => self
                .enqueue_terminal_control(task_id, TerminalControlCommand::Resize { cols, rows }),
            ClientFrame::CompanionEvent {
                task_id,
                session_id,
                revision,
                event,
            } => {
                self.handle_companion_event(task_id, session_id, revision, event)
                    .await;
            }
            ClientFrame::Request {
                id,
                method,
                path,
                body,
            } => {
                self.enqueue_request(KspRequest {
                    id,
                    method,
                    path,
                    body,
                });
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
        // Replace any existing attachment for this (task, kind).
        if let Some(existing) = self.attachments.remove(&(task_id.clone(), kind)) {
            existing.abort();
        }

        if kind == StreamKind::Companion {
            let key = (task_id.clone(), kind);
            let task = tokio::spawn(stream_companion(
                self.state.config().db_path.clone(),
                task_id,
                self.frame_tx.clone(),
            ));
            self.attachments.insert(key, task);
            return;
        }

        let session_id = match (kind, direct_terminal_session_id(&task_id)) {
            (StreamKind::Terminal, Some(session_id)) => Ok(session_id),
            _ => {
                resolve_task_session_id(self.state.config().db_path.clone(), task_id.clone()).await
            }
        };
        let session_id = match session_id {
            Ok(session_id) => session_id,
            Err(message) => {
                self.error(Some(task_id), "no_session", message).await;
                return;
            }
        };

        if kind == StreamKind::Terminal {
            self.replace_terminal_control_route(&task_id, session_id.clone())
                .await;
        }

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
            StreamKind::Companion => unreachable!("companion attach handled above"),
        };
        self.attachments.insert(key, task);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SentCompanionState {
    Never,
    Unavailable,
    Snapshot {
        session_id: String,
        revision: String,
    },
    SourceError,
}

async fn stream_companion(db_path: String, task_id: String, frame_tx: mpsc::Sender<ServerFrame>) {
    let mut sent = SentCompanionState::Never;
    loop {
        let scan_db_path = db_path.clone();
        let scan_task_id = task_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::visual_companion::current_document(&scan_db_path, &scan_task_id)
        })
        .await;

        let (next_state, frame) = match result {
            Ok(Ok(Some(document))) => (
                SentCompanionState::Snapshot {
                    session_id: document.session_id.clone(),
                    revision: document.revision.clone(),
                },
                ServerFrame::CompanionSnapshot {
                    task_id: task_id.clone(),
                    session_id: document.session_id,
                    revision: document.revision,
                    document_kind: document.document_kind,
                    html: document.html,
                },
            ),
            Ok(Ok(None)) => (
                SentCompanionState::Unavailable,
                ServerFrame::CompanionUnavailable {
                    task_id: task_id.clone(),
                },
            ),
            Ok(Err(_)) | Err(_) => (
                SentCompanionState::SourceError,
                ServerFrame::CompanionError {
                    task_id: task_id.clone(),
                    code: "companion_source_failed".into(),
                    message: "The visual companion could not be read.".into(),
                },
            ),
        };

        if next_state != sent {
            match frame_tx.try_send(frame) {
                Ok(()) => sent = next_state,
                Err(mpsc::error::TrySendError::Full(_)) => {}
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
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
                ..
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
    use kanna_agent_protocol::{CompanionDocumentKind, CompanionEvent};
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

    async fn spawn_fake_control_daemon(
        daemon_dir: String,
        command_count: usize,
    ) -> (
        tokio::task::JoinHandle<usize>,
        mpsc::Receiver<DaemonCommand>,
    ) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake control daemon socket");
        let (command_tx, command_rx) = mpsc::channel(command_count);

        let task = tokio::spawn(async move {
            let mut accepted_connections = 0usize;
            let mut received_commands = 0usize;
            while received_commands < command_count {
                let (stream, _) = listener
                    .accept()
                    .await
                    .expect("accept fake control daemon connection");
                accepted_connections += 1;
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                loop {
                    let mut line = String::new();
                    let read = reader
                        .read_line(&mut line)
                        .await
                        .expect("read fake control daemon command");
                    if read == 0 {
                        break;
                    }
                    let command: DaemonCommand = serde_json::from_str(line.trim())
                        .expect("parse fake control daemon command");
                    let expects_reply = !matches!(
                        &command,
                        DaemonCommand::InputNoReply { .. } | DaemonCommand::ResizeNoReply { .. }
                    );
                    command_tx
                        .send(command)
                        .await
                        .expect("publish fake control daemon command");
                    if expects_reply {
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .expect("write fake control daemon response");
                    }
                    received_commands += 1;
                    if received_commands == command_count {
                        return accepted_connections;
                    }
                }
            }
            accepted_connections
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_with_disconnect(
        daemon_dir: String,
        command_count: usize,
    ) -> (
        tokio::task::JoinHandle<usize>,
        mpsc::Receiver<DaemonCommand>,
    ) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind reconnect daemon socket");
        let (command_tx, command_rx) = mpsc::channel(command_count);

        let task = tokio::spawn(async move {
            for accepted in 1..=command_count {
                let (stream, _) = listener
                    .accept()
                    .await
                    .expect("accept reconnect daemon connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .await
                    .expect("read reconnect daemon command");
                let command: DaemonCommand =
                    serde_json::from_str(line.trim()).expect("parse reconnect daemon command");
                let expects_reply = !matches!(
                    &command,
                    DaemonCommand::InputNoReply { .. } | DaemonCommand::ResizeNoReply { .. }
                );
                command_tx
                    .send(command)
                    .await
                    .expect("publish reconnect daemon command");
                if expects_reply {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .expect("write reconnect daemon response");
                }
                if accepted == command_count {
                    return accepted;
                }
                // Drop both halves so the persistent KSP control worker must
                // reconnect before its next command.
            }
            command_count
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_close_after_first_command(
        daemon_dir: String,
    ) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<DaemonCommand>) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind close-after-input daemon");
        let (command_tx, command_rx) = mpsc::channel(2);

        let task = tokio::spawn(async move {
            for connection_index in 0..2 {
                let (stream, _) = listener.accept().await.expect("accept control connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .await
                    .expect("read terminal input");
                if line.is_empty() {
                    return;
                }
                let command = serde_json::from_str(line.trim()).expect("parse terminal input");
                command_tx
                    .send(command)
                    .await
                    .expect("publish terminal input");
                if connection_index == 1 {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .expect("ack replayed command");
                }
                // The first connection deliberately closes after consuming
                // input, before a success acknowledgement can be observed.
            }
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_without_success_replies(
        daemon_dir: String,
        command_count: usize,
    ) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<DaemonCommand>) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind no-ack control daemon");
        let (command_tx, command_rx) = mpsc::channel(command_count);

        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept control connection");
            let mut reader = BufReader::new(stream);
            for _ in 0..command_count {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .await
                    .expect("read one-way terminal command");
                if line.is_empty() {
                    return;
                }
                let command = serde_json::from_str(line.trim()).expect("parse terminal command");
                command_tx
                    .send(command)
                    .await
                    .expect("publish terminal command");
            }
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_across_connections(
        daemon_dir: String,
    ) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<DaemonCommand>) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind multi-control daemon");
        let (command_tx, command_rx) = mpsc::channel(8);

        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.expect("accept control connection");
                let command_tx = command_tx.clone();
                handlers.spawn(async move {
                    let mut reader = BufReader::new(stream);
                    loop {
                        let mut line = String::new();
                        let read = reader
                            .read_line(&mut line)
                            .await
                            .expect("read terminal command");
                        if read == 0 {
                            return;
                        }
                        let command =
                            serde_json::from_str(line.trim()).expect("parse terminal command");
                        if command_tx.send(command).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });

        (task, command_rx)
    }

    fn assert_command(actual: Option<DaemonCommand>, expected: DaemonCommand) {
        let actual = actual.expect("expected daemon command");
        assert_eq!(
            serde_json::to_value(actual).expect("serialize actual daemon command"),
            serde_json::to_value(expected).expect("serialize expected daemon command"),
        );
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

    async fn recv_frame_with_timeout(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        timeout: Duration,
    ) -> Option<ServerFrame> {
        let message = tokio::time::timeout(timeout, socket.next())
            .await
            .ok()??
            .ok()?;
        match message {
            TungsteniteMessage::Text(text) => serde_json::from_str(&text).ok(),
            _ => None,
        }
    }

    struct KspCompanionFixture {
        config: crate::config::Config,
        db_path: PathBuf,
        worktree: PathBuf,
        temp_dir: tempfile::TempDir,
    }

    impl KspCompanionFixture {
        fn new(label: &str) -> Self {
            let temp_dir = tempfile::tempdir().expect("create KSP companion fixture");
            let db_path = temp_dir.path().join("kanna.sqlite");
            let worktree = temp_dir.path().join("worktree");
            std::fs::create_dir_all(&worktree).unwrap();
            let unique = format!(
                "ksp-companion-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let mut config = test_config(&unique, "KSP Companion");
            config.db_path = db_path.to_string_lossy().to_string();
            config.pairing_store_path = temp_dir
                .path()
                .join("pairings.json")
                .to_string_lossy()
                .to_string();
            let db = Db::open_for_tests(&config.db_path).unwrap();
            db.insert_test_repo_with_path("repo-1", temp_dir.path().to_str().unwrap(), "Repo One")
                .unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Visual companion",
                None,
                "in progress",
                "2026-07-17T00:00:00Z",
            )
            .unwrap();
            db.upsert_worktree("wt-task-1", "task-1", worktree.to_str().unwrap(), "task-1")
                .unwrap();
            Self {
                config,
                db_path,
                worktree,
                temp_dir,
            }
        }

        fn write(&self, relative: &str, bytes: &[u8]) {
            let target = self.worktree.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(target, bytes).unwrap();
        }

        fn activate(&self, session_id: &str, file_name: &str, html: &[u8]) {
            self.write(
                &format!(".superpowers/brainstorm/{session_id}/state/server-info"),
                b"{}",
            );
            self.write(
                &format!(".superpowers/brainstorm/{session_id}/content/{file_name}"),
                html,
            );
        }

        async fn serve(&self) -> String {
            serve_router(crate::http_api::router(Arc::new(AppState::new(
                self.config.clone(),
            ))))
            .await
        }

        fn event(event_id: &str) -> CompanionEvent {
            CompanionEvent {
                event_id: event_id.into(),
                event_type: "click".into(),
                choice: "a".into(),
                text: "Option A".into(),
                element_id: None,
                timestamp: 1_784_268_000_000,
            }
        }
    }

    #[tokio::test]
    async fn companion_attach_streams_latest_transitions_and_detaches() {
        let fixture = KspCompanionFixture::new("attach");
        fixture.activate("123-456", "first.html", b"<h2>First</h2>");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
            },
        )
        .await;

        let first_revision = match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot {
                task_id,
                session_id,
                revision,
                document_kind,
                html,
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(session_id, "123-456");
                assert_eq!(document_kind, CompanionDocumentKind::Fragment);
                assert_eq!(html, "<h2>First</h2>");
                revision
            }
            other => panic!("expected companion snapshot, got {other:?}"),
        };

        std::thread::sleep(Duration::from_millis(15));
        fixture.activate("123-456", "second.html", b"<h2>Second</h2>");
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot { revision, html, .. } => {
                assert_ne!(revision, first_revision);
                assert_eq!(html, "<h2>Second</h2>");
            }
            other => panic!("expected updated companion snapshot, got {other:?}"),
        }
        assert_eq!(
            recv_frame_with_timeout(&mut socket, Duration::from_millis(650)).await,
            None,
            "unchanged content must not produce duplicate snapshots"
        );

        let replacement = fixture.temp_dir.path().join("replacement");
        std::fs::create_dir_all(&replacement).unwrap();
        Db::open(fixture.db_path.to_str().unwrap())
            .unwrap()
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                replacement.to_str().unwrap(),
                "replacement",
            )
            .unwrap();
        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionUnavailable {
                task_id: "task-1".into()
            }
        );

        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
            },
        )
        .await;
        Db::open(fixture.db_path.to_str().unwrap())
            .unwrap()
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                fixture.worktree.to_str().unwrap(),
                "task-1",
            )
            .unwrap();
        assert_eq!(
            recv_frame_with_timeout(&mut socket, Duration::from_millis(650)).await,
            None,
            "detached companions must stop sending updates"
        );
    }

    #[tokio::test]
    async fn companion_attach_reports_unavailable_and_source_errors_specifically() {
        let fixture = KspCompanionFixture::new("unavailable");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
            },
        )
        .await;
        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionUnavailable {
                task_id: "task-1".into()
            }
        );

        fixture.activate("invalid", "layout.html", &[0xff, 0xfe]);
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionError { task_id, code, .. } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(code, "companion_source_failed");
            }
            other => panic!("expected task-scoped companion error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn companion_events_acknowledge_append_validation_and_connection_rate_limit() {
        let fixture = KspCompanionFixture::new("events");
        fixture.activate(
            "123-456",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_document(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        let send_event = |event: CompanionEvent, session_id: String, revision: String| {
            ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id,
                revision,
                event,
            }
        };
        send_frame(
            &mut socket,
            &send_event(
                KspCompanionFixture::event("accepted"),
                document.session_id.clone(),
                document.revision.clone(),
            ),
        )
        .await;
        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                task_id: "task-1".into(),
                event_id: "accepted".into(),
                accepted: true,
                code: None,
                message: None,
            }
        );

        send_frame(
            &mut socket,
            &send_event(
                KspCompanionFixture::event("stale"),
                document.session_id.clone(),
                "old-revision".into(),
            ),
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionEventResult {
                event_id,
                accepted,
                code,
                ..
            } => {
                assert_eq!(event_id, "stale");
                assert!(!accepted);
                assert_eq!(code.as_deref(), Some("companion_stale_revision"));
            }
            other => panic!("expected stale event result, got {other:?}"),
        }

        let mut invalid = KspCompanionFixture::event("invalid");
        invalid.choice.clear();
        send_frame(
            &mut socket,
            &send_event(
                invalid,
                document.session_id.clone(),
                document.revision.clone(),
            ),
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionEventResult { code, .. } => {
                assert_eq!(code.as_deref(), Some("companion_invalid_event"));
            }
            other => panic!("expected invalid event result, got {other:?}"),
        }

        let mut rate_socket = ws_connect(&url).await;
        send_frame(&mut rate_socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut rate_socket).await, ServerFrame::AuthOk);
        for index in 0..30 {
            let event_id = format!("rate-{index}");
            send_frame(
                &mut rate_socket,
                &send_event(
                    KspCompanionFixture::event(&event_id),
                    document.session_id.clone(),
                    document.revision.clone(),
                ),
            )
            .await;
            match recv_frame(&mut rate_socket).await {
                ServerFrame::CompanionEventResult { accepted, .. } => assert!(accepted),
                other => panic!("expected accepted rate event, got {other:?}"),
            }
        }
        send_frame(
            &mut rate_socket,
            &send_event(
                KspCompanionFixture::event("rate-limited"),
                document.session_id,
                document.revision,
            ),
        )
        .await;
        match recv_frame(&mut rate_socket).await {
            ServerFrame::CompanionEventResult { accepted, code, .. } => {
                assert!(!accepted);
                assert_eq!(code.as_deref(), Some("companion_rate_limited"));
            }
            other => panic!("expected rate-limited result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn maximum_companion_scan_does_not_block_terminal_output_for_a_poll_interval() {
        let mut fixture = KspCompanionFixture::new("terminal-responsive");
        let mut html = vec![b'x'; crate::visual_companion::MAX_COMPANION_HTML_BYTES as usize];
        html[..11].copy_from_slice(b"<h2>Busy</h");
        fixture.activate("123-456", "layout.html", &html);

        let daemon_dir = fixture.temp_dir.path().join("daemon");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        fixture.config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        let socket_path = daemon_socket_path_for_dir(&fixture.config.daemon_dir);
        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            assert!(matches!(command, DaemonCommand::AttachSnapshot { .. }));
            let snapshot = DaemonEvent::Snapshot {
                session_id: "daemon-terminal-1".into(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 0,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: String::new(),
                },
            };
            let output = DaemonEvent::Output {
                session_id: "daemon-terminal-1".into(),
                data: b"responsive".to_vec(),
            };
            for event in [snapshot, output] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .unwrap();
            }
        });
        Db::open(fixture.db_path.to_str().unwrap())
            .unwrap()
            .insert_test_terminal_session(
                "terminal-1",
                "repo-1",
                "task-1",
                "agent",
                "daemon-terminal-1",
            )
            .unwrap();

        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
            },
        )
        .await;

        let deadline = tokio::time::Instant::now() + Duration::from_millis(490);
        let mut saw_output = false;
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let Some(frame) = recv_frame_with_timeout(&mut socket, remaining).await else {
                break;
            };
            if matches!(frame, ServerFrame::TermOutput { .. }) {
                saw_output = true;
                break;
            }
        }
        assert!(
            saw_output,
            "terminal output waited for a full companion polling interval"
        );
        daemon.await.unwrap();
        let _ = std::fs::remove_file(socket_path);
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
    async fn ksp_request_cannot_create_pairing_session() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 8,
                method: "POST".into(),
                path: "/v1/pairing/sessions".into(),
                body: None,
            },
        )
        .await;

        match recv_frame(&mut socket).await {
            ServerFrame::Response { id, status, body } => {
                assert_eq!(id, 8);
                assert_eq!(status, 403);
                assert!(!body.is_some_and(|body| body.get("pairingPayload").is_some()));
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
        assert_eq!(
            direct_terminal_session_id("shell-wt-task-1"),
            Some("shell-wt-task-1".to_string()),
        );
        assert_eq!(
            direct_terminal_session_id("shell-repo-repo-1"),
            Some("shell-repo-repo-1".to_string()),
        );
        assert_eq!(direct_terminal_session_id("task-1"), None);
    }

    #[tokio::test]
    async fn terminal_control_reuses_one_connection_and_preserves_command_order() {
        let unique = format!(
            "ksp-terminal-control-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-control", "KSP Terminal Control");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 3).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        let kitty_and_paste = b"\x1b[13;2u\x1b[200~paste\nbody\x1b[201~".to_vec();
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-control-test".into(),
                data_b64: b64(&kitty_and_paste),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-control-test".into(),
                cols: 137,
                rows: 43,
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-control-test".into(),
                data_b64: b64(b"tail"),
            },
        )
        .await;

        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "shell-control-test".into(),
                data: kitty_and_paste,
            },
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::ResizeNoReply {
                session_id: "shell-control-test".into(),
                cols: 137,
                rows: 43,
            },
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "shell-control-test".into(),
                data: b"tail".to_vec(),
            },
        );
        assert_eq!(daemon.await.expect("fake control daemon failed"), 1);

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_input_consumed_before_socket_close_is_not_replayed() {
        let unique = format!(
            "ksp-terminal-at-most-once-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-at-most-once", "KSP At Most Once");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_close_after_first_command(config.daemon_dir.clone()).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(config)))).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-at-most-once".into(),
                data_b64: b64(b"run-once\n"),
            },
        )
        .await;

        let first = commands.recv().await.expect("daemon did not consume input");
        assert_eq!(
            serde_json::to_value(first).unwrap()["data"],
            serde_json::json!([114, 117, 110, 45, 111, 110, 99, 101, 10])
        );
        let replay =
            tokio::time::timeout(std::time::Duration::from_millis(700), commands.recv()).await;
        assert!(replay.is_err(), "ambiguous terminal input was replayed");

        daemon.abort();
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn missing_input_ack_does_not_stall_later_terminal_commands() {
        let unique = format!(
            "ksp-terminal-no-ack-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-no-ack", "KSP No ACK");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_without_success_replies(config.daemon_dir.clone(), 3).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(config)))).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        for frame in [
            ClientFrame::TermInput {
                task_id: "shell-no-ack".into(),
                data_b64: b64(b"first"),
            },
            ClientFrame::TermResize {
                task_id: "shell-no-ack".into(),
                cols: 120,
                rows: 40,
            },
            ClientFrame::TermInput {
                task_id: "shell-no-ack".into(),
                data_b64: b64(b"second"),
            },
        ] {
            send_frame(&mut socket, &frame).await;
        }

        let mut received = Vec::new();
        for _ in 0..3 {
            received.push(
                tokio::time::timeout(std::time::Duration::from_millis(300), commands.recv())
                    .await
                    .expect("missing ACK stalled a later terminal command")
                    .expect("fake daemon command channel closed"),
            );
        }
        let received = received
            .into_iter()
            .map(|command| serde_json::to_value(command).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            received[0]["data"],
            serde_json::json!([102, 105, 114, 115, 116])
        );
        assert_eq!(received[1]["cols"], 120);
        assert_eq!(received[1]["rows"], 40);
        assert_eq!(
            received[2]["data"],
            serde_json::json!([115, 101, 99, 111, 110, 100])
        );

        daemon.await.expect("no-ack daemon failed");
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_input_bypasses_blocked_ksp_request() {
        let unique = format!(
            "ksp-terminal-request-hol-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-request-hol", "KSP Request HOL");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 2).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config.clone())));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-request-hol".into(),
                data_b64: b64(b"warm"),
            },
        )
        .await;
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "shell-request-hol".into(),
                data: b"warm".to_vec(),
            },
        );

        let lock = rusqlite::Connection::open(&config.db_path).expect("open lock connection");
        lock.execute_batch("BEGIN IMMEDIATE; UPDATE settings SET value = value;")
            .expect("hold sqlite write lock");
        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 71,
                method: "PUT".into(),
                path: "/v1/settings/terminalLatencyTest".into(),
                body: Some(serde_json::json!({ "value": "busy" })),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-request-hol".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;

        let command_while_locked =
            tokio::time::timeout(std::time::Duration::from_millis(300), commands.recv()).await;
        lock.execute_batch("ROLLBACK")
            .expect("release sqlite write lock");

        assert_command(
            command_while_locked.expect("terminal input was blocked behind KSP request"),
            DaemonCommand::InputNoReply {
                session_id: "shell-request-hol".into(),
                data: b"responsive".to_vec(),
            },
        );
        assert_eq!(daemon.await.expect("fake control daemon failed"), 1);

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bounded_request_saturation_keeps_terminal_input_responsive() {
        let unique = format!(
            "ksp-request-saturation-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-request-saturation", "KSP Request Saturation");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_without_success_replies(config.daemon_dir.clone(), 1).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(
            config.clone(),
        ))))
        .await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        let lock = rusqlite::Connection::open(&config.db_path).expect("open lock connection");
        lock.execute_batch("BEGIN IMMEDIATE; UPDATE settings SET value = value;")
            .expect("hold sqlite write lock");
        for offset in 0..40u64 {
            send_frame(
                &mut socket,
                &ClientFrame::Request {
                    id: 10_000 + offset,
                    method: "PUT".into(),
                    path: format!("/v1/settings/requestSaturation{offset}"),
                    body: Some(serde_json::json!({ "value": "busy" })),
                },
            )
            .await;
        }
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-request-saturation".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;

        let terminal_command =
            tokio::time::timeout(std::time::Duration::from_millis(300), commands.recv()).await;
        let overflow_response = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            recv_frame(&mut socket),
        )
        .await;
        lock.execute_batch("ROLLBACK")
            .expect("release sqlite write lock");

        assert_command(
            terminal_command.expect("request saturation delayed terminal input"),
            DaemonCommand::InputNoReply {
                session_id: "shell-request-saturation".into(),
                data: b"responsive".to_vec(),
            },
        );
        match overflow_response.expect("unbounded request dispatcher accepted every request") {
            ServerFrame::Response { id, status, .. } => {
                assert!((10_000..10_040).contains(&id));
                assert_eq!(status, 503);
            }
            other => panic!("expected saturated request response, got {other:?}"),
        }

        daemon.await.expect("saturation daemon failed");
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_input_bypasses_agent_command_waiting_for_daemon_reply() {
        let unique = format!(
            "ksp-terminal-agent-hol-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-agent-hol", "KSP Agent HOL");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-agent-hol",
            "repo-1",
            "Agent command HOL",
            None,
            "in progress",
            "2026-07-17T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-agent-hol",
            "repo-1",
            "task-agent-hol",
            "agent",
            "daemon-agent-hol",
        )
        .expect("insert terminal session");
        drop(db);

        let socket_path = daemon_socket_path_for_dir(&config.daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind agent HOL daemon socket");
        let (command_tx, mut command_rx) = mpsc::channel(2);
        let release_agent = Arc::new(tokio::sync::Notify::new());
        let daemon_release = release_agent.clone();
        let daemon = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.expect("accept daemon connection");
                let command_tx = command_tx.clone();
                let release_agent = daemon_release.clone();
                handlers.spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .await
                        .expect("read daemon command");
                    let command: DaemonCommand =
                        serde_json::from_str(line.trim()).expect("parse daemon command");
                    let hold_reply = matches!(command, DaemonCommand::AgentInterrupt { .. });
                    command_tx
                        .send(command)
                        .await
                        .expect("publish daemon command");
                    if hold_reply {
                        release_agent.notified().await;
                    }
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .expect("write daemon response");
                });
            }
            while handlers.join_next().await.is_some() {}
        });

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);
        send_frame(
            &mut socket,
            &ClientFrame::AgentInterrupt {
                task_id: "task-agent-hol".into(),
            },
        )
        .await;
        assert_command(
            command_rx.recv().await,
            DaemonCommand::AgentInterrupt {
                session_id: "daemon-agent-hol".into(),
            },
        );

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-agent-hol".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;
        let input_while_agent_waited =
            tokio::time::timeout(std::time::Duration::from_millis(300), command_rx.recv()).await;
        release_agent.notify_waiters();

        assert_command(
            input_while_agent_waited.expect("terminal input waited for agent command reply"),
            DaemonCommand::InputNoReply {
                session_id: "shell-agent-hol".into(),
                data: b"responsive".to_vec(),
            },
        );
        daemon.await.expect("agent HOL daemon failed");

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_control_reconnects_after_daemon_socket_replacement() {
        let unique = format!(
            "ksp-terminal-control-reconnect-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config(
            "ksp-terminal-control-reconnect",
            "KSP Terminal Control Reconnect",
        );
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_with_disconnect(config.daemon_dir.clone(), 2).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &ClientFrame::Auth { credential: None }).await;
        assert_eq!(recv_frame(&mut socket).await, ServerFrame::AuthOk);

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-control-reconnect".into(),
                data_b64: b64(b"before"),
            },
        )
        .await;
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "shell-control-reconnect".into(),
                data: b"before".to_vec(),
            },
        );
        // The first fake connection closes after consuming the command. Wait
        // beyond the first reconnect delay, matching a real handoff where the
        // replacement daemon is ready before the next keypress arrives.
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-control-reconnect".into(),
                data_b64: b64(b"after"),
            },
        )
        .await;
        assert_command(
            tokio::time::timeout(std::time::Duration::from_secs(2), commands.recv())
                .await
                .expect("control worker did not reconnect"),
            DaemonCommand::InputNoReply {
                session_id: "shell-control-reconnect".into(),
                data: b"after".to_vec(),
            },
        );
        assert_eq!(daemon.await.expect("reconnect daemon failed"), 2);

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_control_route_replacement_uses_the_new_session() {
        let unique = format!(
            "ksp-terminal-route-replacement-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config(
            "ksp-terminal-route-replacement",
            "KSP Terminal Route Replacement",
        );
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 2).await;
        let state = Arc::new(AppState::new(config));
        let (frame_tx, _frame_rx) = mpsc::channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_event_times: HashMap::new(),
            authed: true,
            auth_mode: AuthMode::AllowEmpty,
        };

        conn.replace_terminal_control_route("task-route", "daemon-session-old".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"old".to_vec()),
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "daemon-session-old".into(),
                data: b"old".to_vec(),
            },
        );

        conn.replace_terminal_control_route("task-route", "daemon-session-new".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"new".to_vec()),
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "daemon-session-new".into(),
                data: b"new".to_vec(),
            },
        );
        assert_eq!(daemon.await.expect("route daemon failed"), 2);
        conn.shutdown().await;

        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn route_replacement_cancels_old_worker_during_reconnect_backoff() {
        let unique = format!(
            "ksp-terminal-cancel-backoff-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-cancel-backoff", "KSP Cancel Backoff");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let state = Arc::new(AppState::new(config.clone()));
        let (frame_tx, _frame_rx) = mpsc::channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            agent_commands: None,
            requests: None,
            authed: true,
            auth_mode: AuthMode::AllowEmpty,
        };

        conn.replace_terminal_control_route("task-route", "daemon-session-old".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"stale".to_vec()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        conn.replace_terminal_control_route("task-route", "daemon-session-new".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"fresh".to_vec()),
        );
        let (daemon, mut commands) =
            spawn_fake_control_daemon_across_connections(config.daemon_dir.clone()).await;

        let first = tokio::time::timeout(std::time::Duration::from_secs(2), commands.recv())
            .await
            .expect("replacement worker did not reconnect")
            .expect("fake daemon closed before replacement input");
        let first = serde_json::to_value(first).unwrap();
        assert_eq!(first["session_id"], "daemon-session-new");
        assert_eq!(first["data"], serde_json::json!([102, 114, 101, 115, 104]));

        let stale =
            tokio::time::timeout(std::time::Duration::from_millis(700), commands.recv()).await;
        assert!(stale.is_err(), "cancelled worker delivered stale input");

        daemon.abort();
        conn.shutdown().await;
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_detach_drops_control_socket_resize_ownership() {
        let state = Arc::new(AppState::new(test_config(
            "ksp-terminal-detach-control",
            "KSP Terminal Detach Control",
        )));
        let (frame_tx, _frame_rx) = mpsc::channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            agent_commands: None,
            requests: None,
            authed: true,
            auth_mode: AuthMode::AllowEmpty,
        };
        conn.replace_terminal_control_route("task-detach", "daemon-session-detach".into())
            .await;
        assert!(conn.terminal_controls.contains_key("task-detach"));

        assert!(
            conn.handle(ClientFrame::Detach {
                task_id: "task-detach".into(),
                kind: StreamKind::Terminal,
            })
            .await
        );

        assert!(!conn.terminal_controls.contains_key("task-detach"));
        conn.shutdown().await;
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
                        killed: false,
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
