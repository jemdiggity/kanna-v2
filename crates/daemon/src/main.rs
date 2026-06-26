mod agent_runtime;
#[cfg(test)]
mod bench;
mod fd_transfer;
mod headless_terminal;
mod pty;
mod session;
mod socket;

use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use kanna_daemon::subprocess_env;
use kanna_daemon::{
    protocol,
    recovery::{RecoveryManager, RecoverySnapshot, SeededRecoverySnapshot},
};
use serde::Serialize;
use tokio::io::unix::AsyncFd;
use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc, Mutex};

/// A single client's writer handle.
type SessionWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

/// Map of session_id → all attached writers (broadcast to all on output).
type SessionWriters = Arc<Mutex<HashMap<String, Vec<SessionWriter>>>>;
type TerminalEmulatorClients = Arc<Mutex<HashMap<String, HashSet<usize>>>>;

/// Per-session size registry: maps client pointer → (cols, rows).
/// Used to compute min(cols) x min(rows) across all attached clients.
type SessionSizes = Arc<Mutex<HashMap<String, HashMap<usize, (u16, u16)>>>>;

/// Map of session_id → list of passive observer writers.
/// Observers receive Output/Exit events but don't join the live terminal writer list.
type SessionObservers =
    Arc<Mutex<HashMap<String, Vec<Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>>>>>;
type LostHandoffSessions = Arc<Mutex<HashMap<String, String>>>;

fn effective_terminal_size(
    client_sizes: &HashMap<usize, (u16, u16)>,
    fallback: (u16, u16),
) -> (u16, u16) {
    let min_cols = client_sizes
        .values()
        .map(|(cols, _)| *cols)
        .min()
        .unwrap_or(fallback.0);
    let min_rows = client_sizes
        .values()
        .map(|(_, rows)| *rows)
        .min()
        .unwrap_or(fallback.1);
    (min_cols, min_rows)
}

async fn session_handle(
    sessions: &Arc<Mutex<SessionManager>>,
    session_id: &str,
) -> Option<Arc<SessionHandle>> {
    sessions.lock().await.get(session_id)
}

struct HandoffResult {
    adopted: Vec<(String, pty::PtySession, protocol::HandoffSession)>,
    adopted_agents: Vec<(protocol::HandoffSession, Vec<std::os::fd::RawFd>)>,
    lost: HashMap<String, String>,
    old_pid: Option<i32>,
    abort_start: Option<String>,
}

impl HandoffResult {
    fn empty() -> Self {
        HandoffResult {
            adopted: vec![],
            adopted_agents: vec![],
            lost: HashMap::new(),
            old_pid: None,
            abort_start: None,
        }
    }
}

#[derive(Debug)]
enum HandoffRequestError {
    ResponseTimeout,
    OldDaemonRefused(String),
    TransferFailed {
        message: String,
        session_infos: Vec<protocol::HandoffSession>,
    },
    Other(String),
}

enum CliAction {
    RunDaemon,
    Exit(i32),
}

fn handle_cli_args() -> CliAction {
    let mut args = std::env::args().skip(1);
    let Some(first) = args.next() else {
        return CliAction::RunDaemon;
    };
    match first.as_str() {
        "--version" | "-V" => {
            println!(
                "kanna-daemon {} ({} @ {})",
                env!("KANNA_VERSION"),
                env!("GIT_BRANCH"),
                env!("GIT_COMMIT")
            );
            CliAction::Exit(0)
        }
        "--help" | "-h" => {
            println!("kanna-daemon\n\nUsage: kanna-daemon [--version] [--help]");
            CliAction::Exit(0)
        }
        _ => CliAction::RunDaemon,
    }
}

impl fmt::Display for HandoffRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HandoffRequestError::ResponseTimeout => {
                write!(f, "timeout reading handoff response")
            }
            HandoffRequestError::OldDaemonRefused(message) => {
                write!(f, "old daemon refused: {}", message)
            }
            HandoffRequestError::TransferFailed { message, .. } => write!(f, "{}", message),
            HandoffRequestError::Other(message) => write!(f, "{}", message),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct HandoffSessionV1 {
    session_id: String,
    pid: u32,
    cwd: String,
    snapshot: protocol::TerminalSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum HandoffEventV1 {
    HandoffReady { sessions: Vec<HandoffSessionV1> },
}

#[derive(Debug, serde::Deserialize)]
struct HandoffSessionV1Wire {
    session_id: String,
    pid: u32,
    cwd: String,
    snapshot: protocol::TerminalSnapshot,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
enum HandoffEventCompat {
    HandoffReady { sessions: Vec<HandoffSessionV1Wire> },
    Error { message: String },
}

#[derive(Debug, serde::Deserialize)]
struct HandoffSessionLegacyWire {
    session_id: String,
    pid: u32,
    cwd: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
enum HandoffEventLegacy {
    HandoffReady {
        sessions: Vec<HandoffSessionLegacyWire>,
    },
    Error {
        message: String,
    },
}
use protocol::{Command, Event, SessionStatus};
use session::{
    MirrorResult, SessionHandle, SessionManager, SessionRecord, StreamControl,
    STATUS_DETECTION_THROTTLE_MS,
};
use socket::{bind_socket, read_command, write_event};

fn recovery_snapshot_to_terminal_snapshot(
    snapshot: RecoverySnapshot,
) -> protocol::TerminalSnapshot {
    protocol::TerminalSnapshot {
        version: 1,
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        cursor_visible: snapshot.cursor_visible,
        saved_at: snapshot.saved_at,
        sequence: snapshot.sequence,
        vt: snapshot.serialized,
    }
}

fn app_support_dir() -> PathBuf {
    kanna_runtime_defaults::daemon_dir_for_current_runtime()
}

fn daemon_data_dir() -> PathBuf {
    app_support_dir()
}

fn socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

fn panic_log_path(dir: &Path, pid: u32, timestamp_secs: u64) -> PathBuf {
    dir.join(format!("kanna-daemon-panic_{pid}_{timestamp_secs}.log"))
}

fn install_panic_hook(dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let timestamp_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let path = panic_log_path(&dir, std::process::id(), timestamp_secs);
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        let message = format!(
            "kanna-daemon panic\npid={}\nthread={}\ninfo={}\n\nbacktrace:\n{}\n",
            std::process::id(),
            thread_name,
            panic_info,
            backtrace
        );

        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, message);
        eprintln!("[panic] wrote daemon crash log to {}", path.display());
        previous(panic_info);
    }));
}

fn handoff_loss_message(reason: impl Into<String>) -> String {
    format!("session lost during daemon handoff: {}", reason.into())
}

async fn replay_current_status(writer: &SessionWriter, session_id: &str, status: SessionStatus) {
    let event = Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
    };
    let _ = write_event(&mut *writer.lock().await, &event).await;
}

fn error_event(code: Option<protocol::ErrorCode>, message: impl Into<String>) -> protocol::Event {
    protocol::Event::Error {
        code,
        message: message.into(),
    }
}

fn should_mirror_output_to_recovery(_has_live_terminal_client: bool) -> bool {
    true
}

#[cfg(test)]
fn should_rebuild_recovery_session_on_live_terminal_transition() -> bool {
    false
}

fn parse_handoff_response(line: &str) -> Result<Vec<protocol::HandoffSession>, String> {
    if let Ok(event) = serde_json::from_str::<Event>(line) {
        return match event {
            Event::HandoffReady { sessions } => Ok(sessions),
            Event::Error { message, .. } => Err(message),
            other => Err(format!("unexpected response: {:?}", other)),
        };
    }

    match serde_json::from_str::<HandoffEventCompat>(line) {
        Ok(HandoffEventCompat::HandoffReady { sessions }) => Ok(sessions
            .into_iter()
            .map(|session| protocol::HandoffSession {
                rows: session.snapshot.rows,
                cols: session.snapshot.cols,
                snapshot: Some(session.snapshot),
                session_id: session.session_id,
                pid: session.pid,
                cwd: session.cwd,
                agent_provider: None,
                status: SessionStatus::Idle,
                kind: protocol::SessionKind::Pty,
                provider_session_id: None,
                agent_fd_count: 0,
                agent_spawn: None,
            })
            .collect()),
        Ok(HandoffEventCompat::Error { message }) => Err(message),
        Err(compat_error) => match serde_json::from_str::<HandoffEventLegacy>(line) {
            Ok(HandoffEventLegacy::HandoffReady { sessions }) => Ok(sessions
                .into_iter()
                .map(|session| protocol::HandoffSession {
                    session_id: session.session_id,
                    pid: session.pid,
                    cwd: session.cwd,
                    rows: 0,
                    cols: 0,
                    snapshot: None,
                    agent_provider: None,
                    status: SessionStatus::Idle,
                    kind: protocol::SessionKind::Pty,
                    provider_session_id: None,
                    agent_fd_count: 0,
                    agent_spawn: None,
                })
                .collect()),
            Ok(HandoffEventLegacy::Error { message }) => Err(message),
            Err(_) => Err(format!("invalid response: {}", compat_error)),
        },
    }
}

fn blank_snapshot(rows: u16, cols: u16) -> protocol::TerminalSnapshot {
    let normalized_rows = if rows == 0 { 24 } else { rows };
    let normalized_cols = if cols == 0 { 80 } else { cols };
    protocol::TerminalSnapshot {
        version: 1,
        rows: normalized_rows,
        cols: normalized_cols,
        cursor_row: 0,
        cursor_col: 0,
        cursor_visible: true,
        saved_at: 0,
        sequence: 0,
        vt: String::new(),
    }
}

async fn register_terminal_emulator_client(
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    writer: &SessionWriter,
) {
    let writer_id = Arc::as_ptr(writer) as usize;
    let mut terminal_clients = terminal_emulator_clients.lock().await;
    let client_ids = terminal_clients.entry(session_id.to_string()).or_default();
    client_ids.insert(writer_id);
}

async fn unregister_terminal_emulator_client(
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    writer: &SessionWriter,
) {
    let writer_id = Arc::as_ptr(writer) as usize;
    let mut terminal_clients = terminal_emulator_clients.lock().await;
    let Some(client_ids) = terminal_clients.get_mut(session_id) else {
        return;
    };
    client_ids.remove(&writer_id);
    let empty = client_ids.is_empty();
    if empty {
        terminal_clients.remove(session_id);
    }
}

async fn cleanup_client_writer_registries(
    writer: &SessionWriter,
    session_writers: &SessionWriters,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_sizes: &SessionSizes,
    session_observers: &SessionObservers,
) {
    let writer_id = Arc::as_ptr(writer) as usize;

    let mut sizes = session_sizes.lock().await;
    for client_sizes in sizes.values_mut() {
        client_sizes.remove(&writer_id);
    }
    sizes.retain(|_, client_sizes| !client_sizes.is_empty());
    drop(sizes);

    let mut terminal_clients = terminal_emulator_clients.lock().await;
    for client_ids in terminal_clients.values_mut() {
        client_ids.remove(&writer_id);
    }
    terminal_clients.retain(|_, client_ids| !client_ids.is_empty());
    drop(terminal_clients);

    let mut writers = session_writers.lock().await;
    for attached_writers in writers.values_mut() {
        attached_writers.retain(|registered| Arc::as_ptr(registered) as usize != writer_id);
    }
    drop(writers);

    let mut observers = session_observers.lock().await;
    for observer_writers in observers.values_mut() {
        observer_writers.retain(|registered| Arc::as_ptr(registered) as usize != writer_id);
    }
    observers.retain(|_, observer_writers| !observer_writers.is_empty());
}

async fn finish_attach_cutover(
    writer: &SessionWriter,
    session_writers: &SessionWriters,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    emulate_terminal: bool,
    initial_event: &Event,
) {
    {
        let mut writers = session_writers.lock().await;
        let mut writer_guard = writer.lock().await;
        writers
            .entry(session_id.to_string())
            .or_default()
            .push(writer.clone());
        drop(writers);

        if emulate_terminal {
            register_terminal_emulator_client(terminal_emulator_clients, session_id, writer).await;
        }

        let _ = write_event(&mut *writer_guard, initial_event).await;
    }
}

async fn request_handoff(
    socket_path: &PathBuf,
    version: u32,
) -> Result<(Vec<protocol::HandoffSession>, Vec<std::os::fd::RawFd>), HandoffRequestError> {
    let stream = tokio::net::UnixStream::connect(socket_path)
        .await
        .map_err(|e| {
            HandoffRequestError::Other(format!(
                "failed to connect to old daemon at {:?}: {}",
                socket_path, e
            ))
        })?;

    log::info!("[handoff] connected to old daemon");

    let raw_fd = stream.as_raw_fd();
    let (read_half, write_half) = stream.into_split();
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut writer = write_half;

    let cmd = serde_json::json!({ "type": "Handoff", "version": version });
    let mut json = serde_json::to_string(&cmd).map_err(|e| {
        HandoffRequestError::Other(format!("failed to serialize handoff command: {}", e))
    })?;
    json.push('\n');
    use tokio::io::AsyncWriteExt;
    writer.write_all(json.as_bytes()).await.map_err(|e| {
        HandoffRequestError::Other(format!("failed to send handoff command: {}", e))
    })?;
    writer.flush().await.map_err(|e| {
        HandoffRequestError::Other(format!("failed to flush handoff command: {}", e))
    })?;
    log::info!("[handoff] sent Handoff command (version={})", version);

    let mut line = String::new();
    use tokio::io::AsyncBufReadExt;
    tokio::time::timeout(HANDOFF_RESPONSE_TIMEOUT, reader.read_line(&mut line))
        .await
        .map_err(|_| HandoffRequestError::ResponseTimeout)?
        .map_err(|e| {
            HandoffRequestError::Other(format!("error reading handoff response: {}", e))
        })?;

    log::info!("[handoff] received response: {}", line.trim());
    let session_infos =
        parse_handoff_response(line.trim()).map_err(HandoffRequestError::OldDaemonRefused)?;

    let expected_fds = expected_handoff_fd_count(&session_infos);
    if expected_fds == 0 {
        send_handoff_ack(&mut writer, version).await?;
        return Ok((session_infos, vec![]));
    }

    log::info!(
        "[handoff] receiving {} fds via SCM_RIGHTS (raw_fd={})",
        expected_fds,
        raw_fd
    );
    let fds = fd_transfer::recv_fds(raw_fd, expected_fds).map_err(|e| {
        HandoffRequestError::TransferFailed {
            message: format!("failed to receive session fds: {}", e),
            session_infos: session_infos.clone(),
        }
    })?;
    send_handoff_ack(&mut writer, version).await?;
    Ok((session_infos, fds))
}

async fn send_handoff_ack(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    version: u32,
) -> Result<(), HandoffRequestError> {
    use tokio::io::AsyncWriteExt;

    let ack = serde_json::to_string(&Command::HandoffAdopted { version })
        .map_err(|e| HandoffRequestError::Other(format!("failed to serialize handoff ack: {e}")))?;
    let write_result = async {
        writer.write_all(format!("{ack}\n").as_bytes()).await?;
        writer.flush().await
    }
    .await;
    match write_result {
        Ok(()) => Ok(()),
        Err(error) if version == HANDOFF_COMPAT_VERSION => {
            log::info!(
                "[handoff] compat peer closed before adoption ack; continuing for legacy daemon: {}",
                error
            );
            Ok(())
        }
        Err(error) => Err(HandoffRequestError::Other(format!(
            "failed to send handoff ack: {error}"
        ))),
    }
}

/// PTY sessions transfer exactly one master fd; agent sessions transfer
/// `agent_fd_count` pipe fds (0 when the child already exited).
fn expected_handoff_fd_count(session_infos: &[protocol::HandoffSession]) -> usize {
    session_infos
        .iter()
        .map(|info| match info.kind {
            protocol::SessionKind::Pty => 1,
            protocol::SessionKind::Agent => info.agent_fd_count as usize,
        })
        .sum()
}

#[tokio::main]
async fn main() {
    match handle_cli_args() {
        CliAction::RunDaemon => {}
        CliAction::Exit(code) => std::process::exit(code),
    }

    let dir = app_support_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create app support dir");
    install_panic_hook(dir.clone());

    // Log to file + stderr
    let _ = flexi_logger::Logger::try_with_env_or_str("info")
        .unwrap()
        .log_to_file(
            flexi_logger::FileSpec::default()
                .directory(&dir)
                .discriminant(std::process::id().to_string()),
        )
        .duplicate_to_stderr(flexi_logger::Duplicate::Info)
        .start();

    let pid_path = dir.join("daemon.pid");
    let socket_path = socket_path(&dir);

    // Attempt handoff from old daemon (if running)
    let handoff_result = attempt_handoff(&pid_path, &socket_path).await;
    if let Some(message) = handoff_result.abort_start.as_ref() {
        log::error!("[handoff] refusing to start daemon: {}", message);
        eprintln!("kanna-daemon: refusing to start: {message}");
        std::process::exit(1);
    }

    let sessions: Arc<Mutex<SessionManager>> = Arc::new(Mutex::new(SessionManager::new()));
    let session_writers: SessionWriters = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
    let session_observers: SessionObservers = Arc::new(Mutex::new(HashMap::new()));
    let lost_handoff_sessions: LostHandoffSessions = Arc::new(Mutex::new(handoff_result.lost));
    let agent_sessions: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(HashMap::new()));
    let recovery_manager = RecoveryManager::start().await;
    let (broadcast_tx, _) = broadcast::channel::<String>(256);

    // Adopt handed-off sessions and persist their handed-off snapshots immediately so the
    // recovery sidecar has durable state before any post-restart attach occurs.
    if !handoff_result.adopted.is_empty() {
        let mut mgr = sessions.lock().await;
        for (session_id, pty_session, handoff) in handoff_result.adopted {
            let mut headless_terminal = match handoff.snapshot.as_ref() {
                Some(snapshot) => {
                    log::info!(
                        "[handoff] adopted session {} (pid={}) snapshot rows={} cols={} cursor=({}, {}) visible={} vt_len={}",
                        session_id,
                        pty_session.pid(),
                        snapshot.rows,
                        snapshot.cols,
                        snapshot.cursor_row,
                        snapshot.cursor_col,
                        snapshot.cursor_visible,
                        snapshot.vt.len()
                    );
                    if let Err(error) = recovery_manager.seed_snapshot(
                        &session_id,
                        &SeededRecoverySnapshot {
                            serialized: snapshot.vt.clone(),
                            cols: snapshot.cols,
                            rows: snapshot.rows,
                            cursor_row: snapshot.cursor_row,
                            cursor_col: snapshot.cursor_col,
                            cursor_visible: snapshot.cursor_visible,
                        },
                    ) {
                        log::warn!(
                            "[recovery] failed to seed adopted snapshot for session {}: {}",
                            session_id,
                            error
                        );
                    }
                    headless_terminal::HeadlessTerminal::from_handoff(
                        Some(snapshot),
                        handoff.cols,
                        handoff.rows,
                        10_000,
                    )
                    .expect("failed to create headless terminal for adopted session")
                }
                None => {
                    log::info!(
                        "[handoff] adopted session {} (pid={}) without snapshot rows={} cols={}",
                        session_id,
                        pty_session.pid(),
                        handoff.rows,
                        handoff.cols
                    );
                    headless_terminal::HeadlessTerminal::from_handoff(
                        None,
                        handoff.cols,
                        handoff.rows,
                        10_000,
                    )
                    .expect("failed to create headless terminal for adopted session")
                }
            };
            let status_observed = matches!(
                headless_terminal.visible_status(handoff.agent_provider),
                Ok(Some(_))
            ) || handoff.status
                != headless_terminal::initial_session_status(handoff.agent_provider);
            let handle = Arc::new(SessionHandle::new(SessionRecord {
                pty: pty_session,
                headless_terminal,
                stream_control: None,
                agent_provider: handoff.agent_provider,
                status: handoff.status,
                status_observed,
                last_status_check_at: None,
            }));
            mgr.insert(session_id, handle);
            // Note: no stream_output started — client must AttachSnapshot to start streaming.
        }
    }

    // Adopt handed-off agent sessions. Wait for the old daemon to exit first:
    // its blocked reader threads hold the same pipes until then, and its
    // final journal appends must land before we reload from disk.
    if !handoff_result.adopted_agents.is_empty() {
        if let Some(old_pid) = handoff_result.old_pid {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while unsafe { libc::kill(old_pid, 0) } == 0 {
                if std::time::Instant::now() >= deadline {
                    log::warn!(
                        "[handoff] old daemon (pid={}) still alive after 5s; killing it before adopting agent sessions",
                        old_pid
                    );
                    unsafe { libc::kill(old_pid, libc::SIGKILL) };
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        for (info, fds) in handoff_result.adopted_agents {
            agent_runtime::adopt_agent_session(
                info,
                fds,
                agent_sessions.clone(),
                broadcast_tx.clone(),
                daemon_data_dir(),
            )
            .await;
        }
    }

    // Write our PID and publish the socket only after adopted sessions are restored.
    let pid = std::process::id();
    std::fs::write(&pid_path, pid.to_string()).expect("Failed to write PID file");

    let listener = bind_socket(&socket_path).expect("Failed to bind Unix socket");

    log::info!(
        "kanna-daemon v{} ({} @ {}) starting, pid={}, socket={:?}",
        env!("KANNA_VERSION"),
        env!("GIT_BRANCH"),
        env!("GIT_COMMIT"),
        pid,
        socket_path
    );

    let pid_path_clone = pid_path.clone();
    let socket_path_clone = socket_path.clone();
    let sessions_shutdown = sessions.clone();
    let recovery_shutdown = recovery_manager.clone();
    tokio::spawn(async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to register SIGTERM handler");
        sigterm.recv().await;
        log::info!("kanna-daemon shutting down");
        recovery_shutdown.flush_and_shutdown().await;
        let handles = sessions_shutdown.lock().await.kill_all_handles();
        for (id, session) in handles {
            if let Err(error) = session.kill().await {
                eprintln!("failed to kill session {}: {}", id, error);
            }
        }
        let _ = std::fs::remove_file(&pid_path_clone);
        let _ = std::fs::remove_file(&socket_path_clone);
        std::process::exit(0);
    });

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let sessions_clone = sessions.clone();
                let broadcast_tx_clone = broadcast_tx.clone();
                let writers_clone = session_writers.clone();
                let terminal_clients_clone = terminal_emulator_clients.clone();
                let sizes_clone = session_sizes.clone();
                let observers_clone = session_observers.clone();
                let lost_handoff_clone = lost_handoff_sessions.clone();
                let recovery_clone = recovery_manager.clone();
                let agent_sessions_clone = agent_sessions.clone();
                tokio::spawn(async move {
                    handle_connection(
                        stream,
                        sessions_clone,
                        broadcast_tx_clone,
                        writers_clone,
                        terminal_clients_clone,
                        sizes_clone,
                        observers_clone,
                        lost_handoff_clone,
                        recovery_clone,
                        agent_sessions_clone,
                    )
                    .await;
                });
            }
            Err(e) => {
                log::error!("accept error: {}", e);
            }
        }
    }
}

fn should_try_compat_handoff_after_error(error: &HandoffRequestError) -> bool {
    match error {
        HandoffRequestError::OldDaemonRefused(message) => {
            message.contains("handoff version mismatch")
        }
        HandoffRequestError::ResponseTimeout
        | HandoffRequestError::TransferFailed { .. }
        | HandoffRequestError::Other(_) => false,
    }
}

fn lost_sessions_from_handoff_error(error: &HandoffRequestError) -> HashMap<String, String> {
    match error {
        HandoffRequestError::TransferFailed {
            message,
            session_infos,
        } => {
            let reason = handoff_loss_message(message);
            session_infos
                .iter()
                .map(|info| (info.session_id.clone(), reason.clone()))
                .collect()
        }
        _ => HashMap::new(),
    }
}

/// Try to take over sessions from an existing daemon.
/// Returns adopted (session_id, PtySession, TerminalSnapshot) tuples plus any
/// sessions that were lost during daemon handoff.
async fn attempt_handoff(pid_path: &PathBuf, socket_path: &PathBuf) -> HandoffResult {
    log::info!(
        "[handoff] checking for old daemon: pid_path={:?}, socket_path={:?}",
        pid_path,
        socket_path
    );

    // Check if old daemon is running
    let old_pid = match std::fs::read_to_string(pid_path) {
        Ok(s) => match s.trim().parse::<i32>() {
            Ok(pid) if unsafe { libc::kill(pid, 0) } == 0 => pid,
            Ok(pid) => {
                log::info!(
                    "[handoff] pid file contains {} but process is not running",
                    pid
                );
                return HandoffResult::empty();
            }
            _ => {
                log::info!("[handoff] pid file has invalid content: {:?}", s.trim());
                return HandoffResult::empty();
            }
        },
        Err(e) => {
            log::info!("[handoff] no pid file: {}", e);
            return HandoffResult::empty();
        }
    };

    log::info!(
        "[handoff] old daemon detected (pid={}), connecting to {:?}",
        old_pid,
        socket_path
    );

    let (session_infos, fds, used_version) = match request_handoff(socket_path, HANDOFF_VERSION)
        .await
    {
        Ok((session_infos, fds)) => (session_infos, fds, HANDOFF_VERSION),
        Err(error) => {
            log::info!("[handoff] version {} failed: {}", HANDOFF_VERSION, error);
            if !should_try_compat_handoff_after_error(&error) {
                log::info!(
                    "[handoff] not attempting compatible fallback after ambiguous version {} failure",
                    HANDOFF_VERSION
                );
                return HandoffResult {
                    adopted: vec![],
                    adopted_agents: vec![],
                    lost: lost_sessions_from_handoff_error(&error),
                    old_pid: Some(old_pid),
                    abort_start: Some(format!(
                        "old daemon pid {old_pid} is alive but handoff failed ambiguously: {error}"
                    )),
                };
            }
            match request_handoff(socket_path, HANDOFF_COMPAT_VERSION).await {
                Ok((session_infos, fds)) => {
                    log::info!(
                        "[handoff] fell back to compatible handoff version {}",
                        HANDOFF_COMPAT_VERSION
                    );
                    (session_infos, fds, HANDOFF_COMPAT_VERSION)
                }
                Err(compat_error) => {
                    log::info!(
                        "[handoff] compatible handoff version {} also failed: {}",
                        HANDOFF_COMPAT_VERSION,
                        compat_error
                    );
                    return HandoffResult {
                        adopted: vec![],
                        adopted_agents: vec![],
                        lost: lost_sessions_from_handoff_error(&compat_error),
                        old_pid: Some(old_pid),
                        abort_start: Some(format!(
                            "old daemon pid {old_pid} is alive but compatible handoff failed: {compat_error}"
                        )),
                    };
                }
            }
        }
    };

    if session_infos.is_empty() {
        log::info!("[handoff] no sessions to adopt");
        return HandoffResult::empty();
    }

    for (i, info) in session_infos.iter().enumerate() {
        log::info!(
            "[handoff] session {}/{}: id={}, pid={}, cwd={}",
            i + 1,
            session_infos.len(),
            info.session_id,
            info.pid,
            info.cwd
        );
    }

    log::info!(
        "[handoff] received {} fds using handoff version {}: {:?}",
        fds.len(),
        used_version,
        fds
    );

    let expected_fds = expected_handoff_fd_count(&session_infos);
    if fds.len() != expected_fds {
        let reason = handoff_loss_message(format!(
            "fd count mismatch during handoff: expected {}, got {}",
            expected_fds,
            fds.len()
        ));
        let lost = session_infos
            .iter()
            .map(|info| (info.session_id.clone(), reason.clone()))
            .collect();
        log::info!(
            "[handoff] fd count mismatch: got {}, expected {}",
            fds.len(),
            expected_fds
        );
        return HandoffResult {
            lost,
            old_pid: Some(old_pid),
            abort_start: Some(format!(
                "old daemon pid {old_pid} sent an invalid handoff fd count"
            )),
            ..HandoffResult::empty()
        };
    }

    // Build adopted sessions, consuming fds in session order.
    let mut adopted = Vec::new();
    let mut adopted_agents = Vec::new();
    let mut fd_iter = fds.into_iter();
    for info in session_infos {
        match info.kind {
            protocol::SessionKind::Agent => {
                let count = info.agent_fd_count as usize;
                let session_fds: Vec<_> = fd_iter.by_ref().take(count).collect();
                log::info!(
                    "[handoff] adopting agent session {} (child_pid={}, fds={:?})",
                    info.session_id,
                    info.pid,
                    session_fds
                );
                adopted_agents.push((info, session_fds));
            }
            protocol::SessionKind::Pty => {
                let Some(fd) = fd_iter.next() else {
                    // Unreachable given the count check above.
                    log::error!("[handoff] ran out of fds adopting {}", info.session_id);
                    break;
                };
                let session_id = info.session_id.clone();
                let alive = unsafe { libc::kill(info.pid as i32, 0) } == 0;
                log::info!(
                    "[handoff] adopting session {} (fd={}, child_pid={}, alive={}, rows={}, cols={}, snapshot={})",
                    session_id,
                    fd,
                    info.pid,
                    alive,
                    info.rows,
                    info.cols,
                    info.snapshot.is_some()
                );
                let owned_fd = unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fd) };
                let session = pty::PtySession::adopt(
                    owned_fd,
                    info.pid as libc::pid_t,
                    info.cwd.clone(),
                    info.rows,
                    info.cols,
                );
                adopted.push((session_id, session, info));
            }
        }
    }

    log::info!(
        "[handoff] complete, adopted {} pty + {} agent sessions",
        adopted.len(),
        adopted_agents.len()
    );
    HandoffResult {
        adopted,
        adopted_agents,
        lost: HashMap::new(),
        old_pid: Some(old_pid),
        abort_start: None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_connection(
    stream: UnixStream,
    sessions: Arc<Mutex<SessionManager>>,
    broadcast_tx: broadcast::Sender<String>,
    session_writers: SessionWriters,
    terminal_emulator_clients: TerminalEmulatorClients,
    session_sizes: SessionSizes,
    session_observers: SessionObservers,
    lost_handoff_sessions: LostHandoffSessions,
    recovery_manager: RecoveryManager,
    agent_sessions: kanna_daemon::agent::AgentSessions,
) {
    // Keep the raw fd for SCM_RIGHTS (used by Handoff)
    let raw_fd = stream.as_raw_fd();
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));

    let subscribed = Arc::new(std::sync::atomic::AtomicBool::new(false));

    loop {
        let cmd = read_command(&mut reader).await;
        match cmd {
            None => break,
            Some(Command::Handoff { version }) => {
                let should_close = handle_handoff(
                    version,
                    raw_fd,
                    &mut reader,
                    sessions.clone(),
                    session_writers.clone(),
                    session_sizes.clone(),
                    session_observers.clone(),
                    writer.clone(),
                    broadcast_tx.clone(),
                    recovery_manager.clone(),
                    agent_sessions.clone(),
                )
                .await;
                if should_close {
                    break; // Connection ends after successful handoff
                }
            }
            Some(Command::HandoffAdopted { .. }) => {
                let evt = error_event(None, "unexpected handoff adoption acknowledgement");
                let _ = write_event(&mut *writer.lock().await, &evt).await;
            }
            Some(Command::Subscribe) => {
                if !subscribed.load(std::sync::atomic::Ordering::Relaxed) {
                    subscribed.store(true, std::sync::atomic::Ordering::Relaxed);
                    let mut broadcast_rx = broadcast_tx.subscribe();
                    let writer_broadcast = writer.clone();
                    tokio::spawn(async move {
                        use tokio::io::AsyncWriteExt;
                        while let Ok(msg) = broadcast_rx.recv().await {
                            let mut w = writer_broadcast.lock().await;
                            let _ = w.write_all(msg.as_bytes()).await;
                            let _ = w.write_all(b"\n").await;
                            let _ = w.flush().await;
                        }
                    });
                }
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(Command::Observe { session_id }) => {
                let mgr = sessions.lock().await;
                if !mgr.contains(&session_id) {
                    let evt = error_event(
                        Some(protocol::ErrorCode::SessionNotFound),
                        format!("session not found: {}", session_id),
                    );
                    drop(mgr);
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    continue;
                }
                drop(mgr);
                let mut observers = session_observers.lock().await;
                observers
                    .entry(session_id.clone())
                    .or_insert_with(Vec::new)
                    .push(writer.clone());
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(Command::Unobserve { session_id }) => {
                let mut observers = session_observers.lock().await;
                if let Some(list) = observers.get_mut(&session_id) {
                    let writer_ptr = Arc::as_ptr(&writer);
                    list.retain(|w| Arc::as_ptr(w) != writer_ptr);
                    if list.is_empty() {
                        observers.remove(&session_id);
                    }
                }
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(command) => {
                handle_command(
                    command,
                    sessions.clone(),
                    writer.clone(),
                    broadcast_tx.clone(),
                    session_writers.clone(),
                    terminal_emulator_clients.clone(),
                    session_sizes.clone(),
                    session_observers.clone(),
                    lost_handoff_sessions.clone(),
                    recovery_manager.clone(),
                    agent_sessions.clone(),
                )
                .await;
            }
        }
    }

    // Connection dropped: remove every registry entry that owns or indexes this
    // writer so dead Unix socket fds cannot survive on idle sessions.
    cleanup_client_writer_registries(
        &writer,
        &session_writers,
        &terminal_emulator_clients,
        &session_sizes,
        &session_observers,
    )
    .await;
    agent_runtime::cleanup_agent_writer(&agent_sessions, &writer).await;
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    command: Command,
    sessions: Arc<Mutex<SessionManager>>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    broadcast_tx: broadcast::Sender<String>,
    session_writers: SessionWriters,
    terminal_emulator_clients: TerminalEmulatorClients,
    session_sizes: SessionSizes,
    session_observers: SessionObservers,
    lost_handoff_sessions: LostHandoffSessions,
    recovery_manager: RecoveryManager,
    agent_sessions: kanna_daemon::agent::AgentSessions,
) {
    match command {
        Command::Spawn {
            session_id,
            executable,
            args,
            cwd,
            env,
            cols,
            rows,
            agent_provider,
        } => {
            log::info!(
                "[spawn] session={} executable={} cwd={} cols={} rows={}",
                session_id,
                executable,
                cwd,
                cols,
                rows
            );
            if sessions.lock().await.contains(&session_id) {
                log::warn!("[spawn] session already exists: {}", session_id);
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionAlreadyExists),
                    format!("session already exists: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            lost_handoff_sessions.lock().await.remove(&session_id);

            match pty::PtySession::spawn(&executable, &args, &cwd, &env, cols, rows) {
                Ok(pty_session) => {
                    let stream_control = StreamControl::new();
                    let headless_terminal =
                        match headless_terminal::HeadlessTerminal::new(cols, rows, 10_000) {
                            Ok(headless_terminal) => headless_terminal,
                            Err(e) => {
                                let evt = error_event(
                                    Some(protocol::ErrorCode::HeadlessTerminalInitFailed),
                                    format!("failed to create headless terminal: {}", e),
                                );
                                let _ = write_event(&mut *writer.lock().await, &evt).await;
                                return;
                            }
                        };
                    let handle = Arc::new(SessionHandle::new(SessionRecord {
                        pty: pty_session,
                        headless_terminal,
                        stream_control: Some(stream_control.clone()),
                        agent_provider,
                        status: headless_terminal::initial_session_status(agent_provider),
                        status_observed: false,
                        last_status_check_at: None,
                    }));
                    let io_fd = match handle.try_clone_io_fd().await {
                        Ok(fd) => fd,
                        Err(e) => {
                            let evt = error_event(
                                Some(protocol::ErrorCode::PtyCloneFailed),
                                format!("failed to clone PTY fd: {}", e),
                            );
                            let _ = write_event(&mut *writer.lock().await, &evt).await;
                            return;
                        }
                    };
                    let Some(input_rx) = handle.take_input_rx().await else {
                        let evt = error_event(None, "failed to take PTY input queue".to_string());
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    };
                    {
                        let mut mgr = sessions.lock().await;
                        if mgr.contains(&session_id) {
                            let evt = error_event(
                                Some(protocol::ErrorCode::SessionAlreadyExists),
                                format!("session already exists: {}", session_id),
                            );
                            let _ = write_event(&mut *writer.lock().await, &evt).await;
                            return;
                        }
                        mgr.insert(session_id.clone(), Arc::clone(&handle));
                    }

                    if let Err(error) = recovery_manager
                        .start_session(&session_id, cols, rows, false)
                        .await
                    {
                        log::warn!(
                            "[recovery] failed to start mirrored session {}: {}",
                            session_id,
                            error
                        );
                    }

                    // Start stream_output immediately so startup output
                    // (including kitty keyboard mode push) is captured.
                    session_writers
                        .lock()
                        .await
                        .insert(session_id.clone(), Vec::new());

                    let sid = session_id.clone();
                    let sessions_exit = sessions.clone();
                    let writers_for_stream = session_writers.clone();
                    let terminal_clients_for_stream = terminal_emulator_clients.clone();
                    let sizes_for_stream = session_sizes.clone();
                    let observers_for_stream = session_observers.clone();
                    let recovery_for_stream = recovery_manager.clone();
                    let broadcast_for_stream = broadcast_tx.clone();
                    tokio::spawn(async move {
                        stream_output(
                            sid,
                            io_fd,
                            input_rx,
                            stream_control,
                            broadcast_for_stream,
                            writers_for_stream,
                            terminal_clients_for_stream,
                            sessions_exit,
                            sizes_for_stream,
                            observers_for_stream,
                            recovery_for_stream,
                            handle,
                        )
                        .await;
                    });

                    let evt = Event::SessionCreated {
                        session_id: session_id.clone(),
                    };
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    if let Ok(json) = serde_json::to_string(&evt) {
                        let _ = broadcast_tx.send(json);
                    }
                }
                Err(e) => {
                    let evt = error_event(
                        Some(protocol::ErrorCode::PtySpawnFailed),
                        format!("failed to spawn PTY: {}", e),
                    );
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                }
            }
        }

        Command::Detach { session_id } => {
            log::info!("[detach] session={}", session_id);
            let evt = if sessions.lock().await.contains(&session_id) {
                let mut writers = session_writers.lock().await;
                if let Some(vec) = writers.get_mut(&session_id) {
                    let ptr = Arc::as_ptr(&writer) as usize;
                    vec.retain(|w| Arc::as_ptr(w) as usize != ptr);
                }
                drop(writers);

                // Remove this client from the size registry and recompute
                {
                    let mut sizes = session_sizes.lock().await;
                    if let Some(client_sizes) = sizes.get_mut(&session_id) {
                        let writer_id = Arc::as_ptr(&writer) as usize;
                        client_sizes.remove(&writer_id);
                        if !client_sizes.is_empty() {
                            let (min_cols, min_rows) =
                                effective_terminal_size(client_sizes, (80, 24));
                            drop(sizes);
                            let resized = match session_handle(&sessions, &session_id).await {
                                Some(session) => session.resize(min_cols, min_rows).await.is_ok(),
                                None => false,
                            };
                            if resized {
                                recovery_manager
                                    .resize_session(&session_id, min_cols, min_rows)
                                    .await;
                            }
                        }
                    }
                }
                unregister_terminal_emulator_client(
                    &terminal_emulator_clients,
                    &session_id,
                    &writer,
                )
                .await;

                Event::Ok
            } else if agent_runtime::detach_agent_writer(&agent_sessions, &session_id, &writer)
                .await
            {
                Event::Ok
            } else {
                error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {}", session_id),
                )
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Input { session_id, data } => {
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };

            let evt = match session.enqueue_input(data) {
                Ok(()) => Event::Ok,
                Err(_) => error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {}", session_id),
                ),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::AttachSnapshot {
            session_id,
            emulate_terminal,
        } => {
            log::info!("[attach_snapshot] session={}", session_id);
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let lost_message = lost_handoff_sessions.lock().await.get(&session_id).cloned();
                let evt = error_event(
                    Some(if lost_message.is_some() {
                        protocol::ErrorCode::HandoffLost
                    } else {
                        protocol::ErrorCode::SessionNotFound
                    }),
                    lost_message.unwrap_or_else(|| format!("session not found: {}", session_id)),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };

            let is_streaming = session_writers.lock().await.contains_key(&session_id);
            if !is_streaming {
                log::info!(
                    "[attach_snapshot] starting stream_output on first attach for adopted/non-streaming session {}",
                    session_id
                );
                let stream_control = StreamControl::new();
                session.set_stream_control(stream_control.clone()).await;
                let io_fd = match session.try_clone_io_fd().await {
                    Ok(fd) => fd,
                    Err(e) => {
                        let evt = error_event(
                            Some(protocol::ErrorCode::PtyCloneFailed),
                            format!("failed to clone PTY fd: {}", e),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                };
                let Some(input_rx) = session.take_input_rx().await else {
                    let evt = error_event(None, "PTY input queue already in use".to_string());
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    return;
                };
                let (recovery_rows, recovery_cols) = session.rows_cols().await;

                let resume_from_disk = recovery_manager.has_persisted_snapshot(&session_id);
                if let Err(error) = recovery_manager
                    .start_session(&session_id, recovery_cols, recovery_rows, resume_from_disk)
                    .await
                {
                    log::warn!(
                        "[recovery] failed to start mirrored adopted session {} (resume_from_disk={}): {}",
                        session_id,
                        resume_from_disk,
                        error
                    );
                }

                let writers_for_stream = session_writers.clone();
                let terminal_clients_for_stream = terminal_emulator_clients.clone();
                let sizes_for_stream = session_sizes.clone();
                let observers_for_stream = session_observers.clone();
                let recovery_for_stream = recovery_manager.clone();
                let sessions_for_stream = sessions.clone();
                let session_id_for_stream = session_id.clone();
                let handle_for_stream = Arc::clone(&session);
                session_writers
                    .lock()
                    .await
                    .insert(session_id.clone(), Vec::new());
                tokio::spawn(async move {
                    stream_output(
                        session_id_for_stream,
                        io_fd,
                        input_rx,
                        stream_control,
                        broadcast_tx.clone(),
                        writers_for_stream,
                        terminal_clients_for_stream,
                        sessions_for_stream,
                        sizes_for_stream,
                        observers_for_stream,
                        recovery_for_stream,
                        handle_for_stream,
                    )
                    .await;
                });
            }

            let snapshot = match session.snapshot().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let (rows, cols) = session.rows_cols().await;
                    log::warn!(
                        "[attach_snapshot] snapshot not ready for session {}: {}; falling back to blank snapshot",
                        session_id,
                        error
                    );
                    blank_snapshot(rows, cols)
                }
            };

            let snapshot_event = Event::Snapshot {
                session_id: session_id.clone(),
                snapshot,
            };
            finish_attach_cutover(
                &writer,
                &session_writers,
                &terminal_emulator_clients,
                &session_id,
                emulate_terminal,
                &snapshot_event,
            )
            .await;

            replay_current_status(&writer, &session_id, session.status().await).await;
        }

        Command::Resize {
            session_id,
            cols,
            rows,
        } => {
            // Update this client's size and compute effective min across all attached clients
            let writer_id = Arc::as_ptr(&writer) as usize;
            let (eff_cols, eff_rows) = {
                let mut sizes = session_sizes.lock().await;
                let client_sizes = sizes.entry(session_id.clone()).or_default();
                client_sizes.insert(writer_id, (cols, rows));
                effective_terminal_size(client_sizes, (cols, rows))
            };

            let result = match session_handle(&sessions, &session_id).await {
                Some(session) => session.resize(eff_cols, eff_rows).await,
                None => Err(format!("session not found: {}", session_id).into()),
            };
            let success = result.is_ok();
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) => error_event(None, e.to_string()),
            };
            if success {
                recovery_manager
                    .resize_session(&session_id, eff_cols, eff_rows)
                    .await;
            }
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Signal { session_id, signal } => {
            log::info!("[signal] session={} signal={}", session_id, signal);
            let sig = match signal.as_str() {
                "SIGINT" => libc::SIGINT,
                "SIGTSTP" => libc::SIGTSTP,
                "SIGCONT" => libc::SIGCONT,
                "SIGTERM" => libc::SIGTERM,
                "SIGKILL" => libc::SIGKILL,
                "SIGWINCH" => libc::SIGWINCH,
                other => {
                    let evt = error_event(
                        Some(protocol::ErrorCode::UnknownSignal),
                        format!("unknown signal: {}", other),
                    );
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    return;
                }
            };
            let result = match session_handle(&sessions, &session_id).await {
                Some(session) => session.signal(sig).await,
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("session not found: {}", session_id),
                )),
            };
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    error_event(Some(protocol::ErrorCode::SessionNotFound), e.to_string())
                }
                Err(e) => error_event(None, e.to_string()),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Kill { session_id } => {
            log::info!("[kill] session={}", session_id);
            if session_handle(&sessions, &session_id).await.is_none()
                && agent_runtime::kill_agent_session(&session_id, &agent_sessions, &broadcast_tx)
                    .await
            {
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
                return;
            }
            let session = session_handle(&sessions, &session_id).await;
            let result = match session {
                Some(session) => session.kill().await,
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("session not found: {}", session_id),
                )),
            };
            let success = result.is_ok();
            if success {
                sessions.lock().await.remove(&session_id);
            }
            session_writers.lock().await.remove(&session_id);
            terminal_emulator_clients.lock().await.remove(&session_id);
            session_sizes.lock().await.remove(&session_id);
            session_observers.lock().await.remove(&session_id);
            if success {
                recovery_manager.end_session(&session_id).await;
            }
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) => error_event(None, e.to_string()),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::List => {
            let handles = sessions.lock().await.handles();
            let mut sessions_list = Vec::with_capacity(handles.len());
            for (id, session) in handles {
                sessions_list.push(session.info(id).await);
            }
            sessions_list.extend(agent_runtime::agent_session_infos(&agent_sessions).await);
            let evt = Event::SessionList {
                sessions: sessions_list,
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Snapshot { session_id } => {
            let live_snapshot = {
                match session_handle(&sessions, &session_id).await {
                    Some(session) => Some(session.snapshot().await),
                    None => None,
                }
            };
            let evt = match live_snapshot {
                Some(Ok(snapshot)) => {
                    log::info!(
                        "[snapshot] session={} served from live headless terminal rows={} cols={} cursor=({}, {}) visible={} vt_len={}",
                        session_id,
                        snapshot.rows,
                        snapshot.cols,
                        snapshot.cursor_row,
                        snapshot.cursor_col,
                        snapshot.cursor_visible,
                        snapshot.vt.len()
                    );
                    Event::Snapshot {
                        session_id,
                        snapshot,
                    }
                }
                Some(Err(error)) => error_event(
                    None,
                    format!("failed to snapshot live session {}: {}", session_id, error),
                ),
                None => match recovery_manager.get_snapshot(&session_id).await {
                    Ok(Some(snapshot)) => {
                        log::info!(
                            "[snapshot] session={} served from recovery rows={} cols={} cursor=({}, {}) visible={} vt_len={}",
                            session_id,
                            snapshot.rows,
                            snapshot.cols,
                            snapshot.cursor_row,
                            snapshot.cursor_col,
                            snapshot.cursor_visible,
                            snapshot.serialized.len()
                        );
                        Event::Snapshot {
                            session_id,
                            snapshot: recovery_snapshot_to_terminal_snapshot(snapshot),
                        }
                    }
                    Ok(None) => error_event(
                        Some(protocol::ErrorCode::SessionNotFound),
                        format!("session not found: {}", session_id),
                    ),
                    Err(error) => error_event(None, error),
                },
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::SeedSnapshot {
            session_id,
            snapshot,
        } => {
            let evt = match recovery_manager.seed_snapshot(
                &session_id,
                &SeededRecoverySnapshot {
                    serialized: snapshot.vt,
                    cols: snapshot.cols,
                    rows: snapshot.rows,
                    cursor_row: snapshot.cursor_row,
                    cursor_col: snapshot.cursor_col,
                    cursor_visible: snapshot.cursor_visible,
                },
            ) {
                Ok(()) => Event::Ok,
                Err(message) => Event::Error {
                    code: None,
                    message,
                },
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Handoff { .. } | Command::HandoffAdopted { .. } => {
            // Handled in handle_connection before dispatch
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::Subscribe => {
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::Observe { .. } | Command::Unobserve { .. } => {
            // Handled in handle_connection before dispatch
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::SpawnAgent { session_id, params } => {
            agent_runtime::handle_spawn_agent(
                session_id,
                params,
                writer,
                broadcast_tx,
                agent_sessions,
                daemon_data_dir(),
            )
            .await;
        }

        Command::AttachAgent {
            session_id,
            from_seq,
        } => {
            agent_runtime::handle_attach_agent(session_id, from_seq, writer, agent_sessions).await;
        }

        Command::AgentInput { session_id, text } => {
            agent_runtime::handle_agent_input(
                session_id,
                text,
                writer,
                broadcast_tx,
                agent_sessions,
            )
            .await;
        }

        Command::AgentPermission {
            session_id,
            request_id,
            decision,
        } => {
            agent_runtime::handle_agent_permission(
                session_id,
                request_id,
                decision,
                writer,
                broadcast_tx,
                agent_sessions,
            )
            .await;
        }

        Command::AgentInterrupt { session_id } => {
            agent_runtime::handle_agent_interrupt(session_id, writer, agent_sessions).await;
        }

        Command::AgentSetModel { session_id, model } => {
            agent_runtime::handle_agent_set_model(session_id, model, writer, agent_sessions).await;
        }
    }
}

/// Current handoff protocol version. Both sides must agree.
const HANDOFF_VERSION: u32 = 2;
const HANDOFF_COMPAT_VERSION: u32 = 1;
const HANDOFF_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Handle a handoff request from a new daemon.
/// Collects all live sessions, sends metadata + master fds, then exits.
#[allow(clippy::too_many_arguments)]
async fn handle_handoff(
    version: u32,
    socket_fd: std::os::unix::io::RawFd,
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
    sessions: Arc<Mutex<SessionManager>>,
    session_writers: SessionWriters,
    session_sizes: SessionSizes,
    session_observers: SessionObservers,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    broadcast_tx: broadcast::Sender<String>,
    recovery_manager: RecoveryManager,
    agent_sessions: kanna_daemon::agent::AgentSessions,
) -> bool {
    log::info!(
        "[handoff] received Handoff request (version={}, our_version={})",
        version,
        HANDOFF_VERSION
    );

    if version != HANDOFF_VERSION && version != HANDOFF_COMPAT_VERSION {
        log::info!("[handoff] version mismatch, rejecting");
        let evt = error_event(
            Some(protocol::ErrorCode::HandoffVersionMismatch),
            format!(
                "handoff version mismatch: expected {} or {}, got {}",
                HANDOFF_VERSION, HANDOFF_COMPAT_VERSION, version
            ),
        );
        let _ = write_event(&mut *writer.lock().await, &evt).await;
        return false;
    }

    // Snapshot and clone fds without removing ownership. The old daemon keeps
    // serving sessions unless the adopting daemon explicitly ACKs success.
    let handles = sessions.lock().await.handles();
    log::info!("[handoff] found {} sessions in manager", handles.len());
    let mut controls = Vec::new();
    for (_, handle) in &handles {
        if let Some(control) = handle.stream_control().await {
            controls.push(control);
        }
    }

    let mut infos = Vec::new();
    let mut fds = Vec::new();
    let mut cloned_pty_fds = Vec::new();
    let mut dead_count = 0;

    for (id, handle) in &handles {
        match handle.handoff_parts().await {
            Ok(Some(parts)) => {
                let pid = parts.pid;
                let cwd = parts.cwd;
                let rows = parts.rows;
                let cols = parts.cols;
                log::info!(
                    "[handoff] snapshotting session {} (pid={}, cwd={})",
                    id,
                    pid,
                    cwd
                );
                let snapshot = match parts.snapshot {
                    Some(snapshot) => {
                        log::info!(
                            "[handoff] snapshot session={} rows={} cols={} cursor=({}, {}) visible={} vt_len={}",
                            id,
                            snapshot.rows,
                            snapshot.cols,
                            snapshot.cursor_row,
                            snapshot.cursor_col,
                            snapshot.cursor_visible,
                            snapshot.vt.len()
                        );
                        Some(snapshot)
                    }
                    None => {
                        log::error!(
                            "[handoff] failed to snapshot session {} (pid={}, cwd={})",
                            id,
                            pid,
                            cwd
                        );
                        None
                    }
                };
                let fd = parts.fd.into_raw_fd();
                if snapshot.is_some() {
                    log::info!(
                        "[handoff] cloned session {} (pid={}, fd={}, cwd={}, rows={}, cols={})",
                        id,
                        pid,
                        fd,
                        cwd,
                        rows,
                        cols
                    );
                } else {
                    log::info!(
                        "[handoff] cloned degraded session {} (pid={}, fd={}, cwd={}, rows={}, cols={})",
                        id,
                        pid,
                        fd,
                        cwd,
                        rows,
                        cols
                    );
                }
                infos.push(protocol::HandoffSession {
                    session_id: id.clone(),
                    pid,
                    cwd,
                    rows,
                    cols,
                    snapshot,
                    agent_provider: parts.agent_provider,
                    status: parts.status,
                    kind: protocol::SessionKind::Pty,
                    provider_session_id: None,
                    agent_fd_count: 0,
                    agent_spawn: None,
                });
                fds.push(fd);
                cloned_pty_fds.push(fd);
            }
            Ok(None) => {
                log::info!("[handoff] session {} is dead, skipping", id);
                dead_count += 1;
            }
            Err(error) => {
                log::error!("[handoff] failed to prepare session {}: {}", id, error);
                dead_count += 1;
            }
        }
    }

    // Collect agent sessions (v2 payloads only — v1 daemons cannot adopt
    // them; their children keep running detached with journals on disk).
    if version == HANDOFF_VERSION {
        let agent_records = agent_sessions.lock().await;
        for (id, record) in agent_records.iter() {
            let fd_bundle = record.handoff_fds;
            let (agent_fd_count, session_fds) = match (record.exited, fd_bundle) {
                (false, Some(bundle)) => {
                    let session_fds = bundle.as_vec();
                    (session_fds.len() as u8, session_fds)
                }
                _ => (0, Vec::new()),
            };
            log::info!(
                "[handoff] transferring agent session {} (pid={}, fds={:?})",
                id,
                record.pid,
                session_fds
            );
            infos.push(protocol::HandoffSession {
                session_id: id.clone(),
                pid: record.pid,
                cwd: record.params.cwd.clone(),
                rows: 0,
                cols: 0,
                snapshot: None,
                agent_provider: Some(record.provider),
                status: record.status,
                kind: protocol::SessionKind::Agent,
                provider_session_id: record.provider_session_id.clone(),
                agent_fd_count,
                agent_spawn: Some(record.params.clone()),
            });
            fds.extend(session_fds);
        }
    } else if !agent_sessions.lock().await.is_empty() {
        log::warn!(
            "[handoff] peer requested v{} handoff; agent sessions are not transferable and stay orphaned",
            version
        );
    }

    log::info!(
        "[handoff] collected {} live sessions ({} dead)",
        infos.len(),
        dead_count
    );

    log::info!(
        "[handoff] sending HandoffReady with {} sessions",
        infos.len()
    );

    if version == HANDOFF_COMPAT_VERSION {
        let compat_sessions = infos
            .into_iter()
            .map(|session| HandoffSessionV1 {
                session_id: session.session_id,
                pid: session.pid,
                cwd: session.cwd,
                snapshot: session
                    .snapshot
                    .unwrap_or_else(|| blank_snapshot(session.rows, session.cols)),
            })
            .collect();
        let evt = HandoffEventV1::HandoffReady {
            sessions: compat_sessions,
        };
        match serde_json::to_string(&evt) {
            Ok(mut compat_json) => {
                compat_json.push('\n');
                use tokio::io::AsyncWriteExt;
                if let Err(error) = writer.lock().await.write_all(compat_json.as_bytes()).await {
                    log::error!("[handoff] failed to write compat HandoffReady: {}", error);
                }
            }
            Err(error) => {
                log::error!(
                    "[handoff] failed to serialize compat HandoffReady: {}",
                    error
                );
            }
        }
    } else {
        // Send HandoffReady with session metadata
        let evt = Event::HandoffReady { sessions: infos };
        if let Err(error) = write_event(&mut *writer.lock().await, &evt).await {
            log::error!("[handoff] failed to write HandoffReady: {}", error);
        }
    }

    // Flush the writer before sending fds
    {
        use tokio::io::AsyncWriteExt;
        if let Err(error) = writer.lock().await.flush().await {
            log::error!("[handoff] failed to flush HandoffReady: {}", error);
        }
    }
    log::info!("[handoff] HandoffReady sent and flushed");

    // Send master fds via SCM_RIGHTS
    if !fds.is_empty() {
        log::info!(
            "[handoff] sending {} fds via SCM_RIGHTS (socket_fd={}): {:?}",
            fds.len(),
            socket_fd,
            fds
        );
        match fd_transfer::send_fds(socket_fd, &fds) {
            Ok(()) => log::info!("[handoff] fds sent successfully"),
            Err(e) => {
                log::info!("[handoff] failed to send fds: {} (kind={:?})", e, e.kind());
                for fd in cloned_pty_fds {
                    unsafe { libc::close(fd) };
                }
                return false;
            }
        }
    } else {
        log::info!("[handoff] no fds to send");
    }

    let ack = tokio::time::timeout(std::time::Duration::from_secs(5), read_command(reader)).await;
    match ack {
        Ok(Some(Command::HandoffAdopted {
            version: ack_version,
        })) if ack_version == version => {
            log::info!("[handoff] adopting daemon acknowledged handoff");
        }
        Ok(Some(other)) => {
            log::warn!("[handoff] expected HandoffAdopted, got {:?}", other);
            for fd in cloned_pty_fds {
                unsafe { libc::close(fd) };
            }
            return false;
        }
        Ok(None) => {
            log::warn!("[handoff] adopting daemon disconnected before ack");
            for fd in cloned_pty_fds {
                unsafe { libc::close(fd) };
            }
            return false;
        }
        Err(_) => {
            log::warn!("[handoff] timed out waiting for adoption ack");
            for fd in cloned_pty_fds {
                unsafe { libc::close(fd) };
            }
            return false;
        }
    }

    for control in &controls {
        control.request_stop();
    }
    let stop_started = std::time::Instant::now();
    while stop_started.elapsed() < std::time::Duration::from_secs(2) {
        if controls.iter().all(StreamControl::is_stopped) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // Clear all writer slots after adoption succeeds; stream_output tasks will
    // end as this process exits and clients should reconnect to the new daemon.
    session_writers.lock().await.clear();
    session_sizes.lock().await.clear();
    session_observers.lock().await.clear();

    for fd in cloned_pty_fds {
        let ret = unsafe { libc::close(fd) };
        if ret != 0 {
            log::warn!(
                "[handoff] failed to close transferred fd {}: {}",
                fd,
                std::io::Error::last_os_error()
            );
        }
    }
    log::info!("[handoff] closed cloned PTY fd copies");

    // Broadcast ShuttingDown so subscribed clients know not to reconnect to this daemon.
    let shutdown_evt = Event::ShuttingDown;
    if let Ok(json) = serde_json::to_string(&shutdown_evt) {
        let _ = broadcast_tx.send(json);
    }

    recovery_manager.flush_and_shutdown().await;

    log::info!(
        "[handoff] complete, exiting in 500ms (pid={})",
        std::process::id()
    );
    // Use a blocking thread to exit — std::process::exit from an async context
    // can hang if tokio tasks are still running.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(500));
        log::info!("[handoff] exiting now");
        std::process::exit(0);
    });
    // Give subscriber tasks time to flush the ShuttingDown event to their sockets.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    true
}

const STATUS_IDLE_FLUSH_MS: u64 = STATUS_DETECTION_THROTTLE_MS;

/// Runs in a blocking thread for the entire lifetime of a session.
/// ONE reader per session — never duplicated. Output is broadcast to all
/// currently attached clients via the SessionWriters map.
#[allow(clippy::too_many_arguments)]
async fn stream_output(
    session_id: String,
    io_fd: std::os::fd::OwnedFd,
    mut input_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stream_control: StreamControl,
    broadcast_tx: broadcast::Sender<String>,
    session_writers: SessionWriters,
    terminal_emulator_clients: TerminalEmulatorClients,
    sessions: Arc<Mutex<SessionManager>>,
    session_sizes: SessionSizes,
    session_observers: SessionObservers,
    recovery_manager: RecoveryManager,
    session: Arc<SessionHandle>,
) {
    let async_fd = match AsyncFd::new(io_fd) {
        Ok(fd) => fd,
        Err(error) => {
            log::error!(
                "[stream] failed to register PTY fd with AsyncFd for session {}: {}",
                session_id,
                error
            );
            stream_control.mark_stopped();
            return;
        }
    };
    let mut buf = [0u8; 4096];
    let mut chunk_count: usize = 0;
    let mut pending_input: VecDeque<Vec<u8>> = VecDeque::new();
    let mut pending_offset = 0usize;
    let mut status_interval =
        tokio::time::interval(std::time::Duration::from_millis(STATUS_IDLE_FLUSH_MS));
    log::info!("[stream] start session={}", session_id);

    loop {
        if stream_control.stop_requested() {
            log::info!("[stream] stop requested session={}", session_id);
            stream_control.mark_stopped();
            return;
        }

        tokio::select! {
            biased;

            maybe_input = input_rx.recv() => {
                if let Some(input) = maybe_input {
                    pending_input.push_back(input);
                }
            }

            writable = async_fd.writable(), if !pending_input.is_empty() => {
                let Ok(mut guard) = writable else {
                    log::error!("[stream] writable readiness failed session={}", session_id);
                    break;
                };
                let Some(front) = pending_input.front() else {
                    continue;
                };
                let result = guard.try_io(|inner| {
                    let fd = inner.get_ref().as_raw_fd();
                    let slice = &front[pending_offset..];
                    let n = unsafe {
                        libc::write(fd, slice.as_ptr().cast::<libc::c_void>(), slice.len())
                    };
                    if n < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(n as usize)
                    }
                });
                match result {
                    Ok(Ok(0)) => {}
                    Ok(Ok(n)) => {
                        session.mark_active().await;
                        pending_offset += n;
                        if pending_offset >= front.len() {
                            pending_input.pop_front();
                            pending_offset = 0;
                        }
                    }
                    Ok(Err(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Ok(Err(error)) => {
                        log::error!("[stream] PTY write error session={} error={}", session_id, error);
                        break;
                    }
                    Err(_would_block) => {}
                }
            }

            readable = async_fd.readable() => {
                let Ok(mut guard) = readable else {
                    log::error!("[stream] readable readiness failed session={}", session_id);
                    break;
                };
                let result = guard.try_io(|inner| {
                    let fd = inner.get_ref().as_raw_fd();
                    let n = unsafe {
                        libc::read(fd, buf.as_mut_ptr().cast::<libc::c_void>(), buf.len())
                    };
                    if n < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(n as usize)
                    }
                });
                match result {
                    Ok(Ok(0)) => {
                        log::info!("[stream] eof session={} chunks={}", session_id, chunk_count);
                        break;
                    }
                    Ok(Ok(n)) => {
                        if stream_control.stop_requested() {
                            log::info!(
                                "[stream] dropping late chunk after stop request session={} bytes={}",
                                session_id,
                                n
                            );
                            stream_control.mark_stopped();
                            return;
                        }
                        if !session.owns_stream_control(&stream_control).await {
                            log::info!(
                                "[stream] stale reader stopped before mirroring session={} bytes={}",
                                session_id,
                                n
                            );
                            stream_control.mark_stopped();
                            return;
                        }
                        chunk_count += 1;
                        if chunk_count <= 5 {
                            log::info!(
                                "[stream] chunk session={} chunk={} bytes={}",
                                session_id,
                                chunk_count,
                                n
                            );
                        }
                        let data = buf[..n].to_vec();
                        handle_output_chunk(
                            &session_id,
                            &data,
                            &session,
                            &broadcast_tx,
                            &session_writers,
                            &terminal_emulator_clients,
                            &session_sizes,
                            &session_observers,
                            &recovery_manager,
                        )
                        .await;
                    }
                    Ok(Err(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Ok(Err(error)) => {
                        log::info!(
                            "[stream] read error session={} kind={:?} error={}",
                            session_id,
                            error.kind(),
                            error
                        );
                        log::error!("PTY read error for session {}: {}", session_id, error);
                        break;
                    }
                    Err(_would_block) => {}
                }
            }

            _ = status_interval.tick() => {
                match session
                    .refresh_quiet_status(std::time::Duration::from_millis(STATUS_IDLE_FLUSH_MS))
                    .await
                {
                    Ok(Some(status)) => {
                        log_status_observation(&session, &session_id, "quiet_refresh").await;
                        emit_status_changed(&session, &broadcast_tx, &session_id, status).await;
                    }
                    Ok(None) => {
                        log_status_observation(&session, &session_id, "quiet_refresh").await;
                    }
                    Err(error) => {
                        log::warn!(
                            "[status] failed quiet status refresh for session {}: {}",
                            session_id,
                            error
                        );
                    }
                }
            }
        }
    }

    if !session.owns_stream_control(&stream_control).await {
        log::info!(
            "[stream] stale reader skipped exit cleanup session={} chunks={}",
            session_id,
            chunk_count
        );
        stream_control.mark_stopped();
        return;
    }

    let exit_code = session.try_wait().await.unwrap_or(0);
    let resume_session_id = match session.codex_resume_session_id().await {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "[stream] failed to read codex resume session id for {}: {}",
                session_id,
                error
            );
            None
        }
    };
    {
        let mut mgr = sessions.lock().await;
        if mgr
            .get(&session_id)
            .is_some_and(|current| Arc::ptr_eq(&current, &session))
        {
            mgr.remove(&session_id);
        } else {
            log::info!(
                "[stream] current session changed before exit cleanup session={} chunks={}",
                session_id,
                chunk_count
            );
            stream_control.mark_stopped();
            return;
        }
    }

    let evt = Event::Exit {
        session_id: session_id.clone(),
        code: exit_code,
        resume_session_id: resume_session_id.clone(),
    };
    recovery_manager.end_session(&session_id).await;
    // Broadcast Exit to all attached writers, then remove the session entry.
    // session_writers and writers_cleanup are the same Arc — use a single lock.
    let mut writers = session_writers.lock().await;
    if let Some(vec) = writers.get(&session_id) {
        for w in vec.iter() {
            let _ = write_event(&mut *w.lock().await, &evt).await;
        }
    }
    writers.remove(&session_id);
    drop(writers);
    terminal_emulator_clients.lock().await.remove(&session_id);
    session_sizes.lock().await.remove(&session_id);

    // Tee Exit event to passive observers concurrently, then clean up
    let mut observers_guard = session_observers.lock().await;
    if let Some(observer_list) = observers_guard.remove(&session_id) {
        let obs_evt = Event::Exit {
            session_id: session_id.clone(),
            code: exit_code,
            resume_session_id,
        };
        futures::future::join_all(observer_list.iter().map(|obs| {
            let evt = obs_evt.clone();
            let obs = obs.clone();
            async move {
                let _ = write_event(&mut *obs.lock().await, &evt).await;
            }
        }))
        .await;
    }
    log::info!(
        "[stream] exit session={} code={} chunks={}",
        session_id,
        exit_code,
        chunk_count
    );
    stream_control.mark_stopped();
    log::info!("[stream] end session={} chunks={}", session_id, chunk_count);
}

#[allow(clippy::too_many_arguments)]
async fn handle_output_chunk(
    session_id: &str,
    data: &[u8],
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    session_writers: &SessionWriters,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_sizes: &SessionSizes,
    session_observers: &SessionObservers,
    recovery_manager: &RecoveryManager,
) {
    let has_live_terminal_client = {
        let terminal_clients = terminal_emulator_clients.lock().await;
        !terminal_clients
            .get(session_id)
            .is_none_or(|client_ids| client_ids.is_empty())
    };
    let allow_terminal_replies = !has_live_terminal_client;
    match session.mirror_output(data, allow_terminal_replies).await {
        Ok(MirrorResult { status, replies }) => {
            for reply in replies {
                if session.enqueue_input(reply).is_err() {
                    log::warn!(
                        "[stream] dropped terminal reply because input queue is closed session={}",
                        session_id
                    );
                }
            }
            if let Some(status) = status {
                log_status_observation(session, session_id, "mirror_output").await;
                emit_status_changed(session, broadcast_tx, session_id, status).await;
            } else {
                log_status_observation(session, session_id, "mirror_output").await;
            }
        }
        Err(error) => {
            log::error!(
                "failed to mirror PTY output into headless terminal for session {}: {}",
                session_id,
                error
            );
        }
    }

    // Check if observers exist before cloning data (avoids clone on hot path with zero observers)
    let has_observers = {
        let guard = session_observers.lock().await;
        guard.get(session_id).is_some_and(|list| !list.is_empty())
    };

    let obs_data = if has_observers {
        Some(data.to_vec())
    } else {
        None
    };

    let evt = Event::Output {
        session_id: session_id.to_string(),
        data: data.to_vec(),
    };
    let attached_writers = {
        let writers = session_writers.lock().await;
        writers.get(session_id).cloned().unwrap_or_default()
    };
    if !attached_writers.is_empty() {
        let mut failed = Vec::new();
        for (i, w) in attached_writers.iter().enumerate() {
            if write_event(&mut *w.lock().await, &evt).await.is_err() {
                failed.push(i);
            }
        }
        if !failed.is_empty() {
            // Collect writer_ids before removing so we can clean session_sizes.
            let failed_ids: Vec<usize> = failed
                .iter()
                .map(|&i| Arc::as_ptr(&attached_writers[i]) as usize)
                .collect();
            let mut writers = session_writers.lock().await;
            if let Some(vec) = writers.get_mut(session_id) {
                vec.retain(|writer| !failed_ids.contains(&(Arc::as_ptr(writer) as usize)));
            }
            drop(writers);
            let mut sizes = session_sizes.lock().await;
            if let Some(client_sizes) = sizes.get_mut(session_id) {
                for wid in &failed_ids {
                    client_sizes.remove(wid);
                }
            }
            drop(sizes);
            let mut terminal_clients = terminal_emulator_clients.lock().await;
            if let Some(client_ids) = terminal_clients.get_mut(session_id) {
                for wid in &failed_ids {
                    client_ids.remove(wid);
                }
                if client_ids.is_empty() {
                    terminal_clients.remove(session_id);
                }
            }
        }
    }

    if should_mirror_output_to_recovery(has_live_terminal_client) {
        let sequence = recovery_manager.next_sequence(session_id);
        recovery_manager
            .write_output(session_id, data, sequence)
            .await;
    }

    // Tee output to passive observers concurrently, removing dead ones.
    if let Some(obs_data) = obs_data {
        let mut observers_guard = session_observers.lock().await;
        if let Some(observer_list) = observers_guard.get_mut(session_id) {
            let obs_evt = Event::Output {
                session_id: session_id.to_string(),
                data: obs_data,
            };
            let results = futures::future::join_all(observer_list.iter().map(|obs| {
                let evt = obs_evt.clone();
                let obs = obs.clone();
                async move { write_event(&mut *obs.lock().await, &evt).await }
            }))
            .await;
            let mut i = 0;
            observer_list.retain(|_| {
                let ok = results[i].is_ok();
                i += 1;
                ok
            });
            if observer_list.is_empty() {
                observers_guard.remove(session_id);
            }
        }
    }
}

async fn emit_status_changed(
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
) {
    let changed = session.update_status(status).await;
    if !changed {
        return;
    }

    if let Ok(json) = serde_json::to_string(&Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
    }) {
        let _ = broadcast_tx.send(json);
    }
}

fn format_status_observation_log(
    session_id: &str,
    source: &str,
    provider: Option<protocol::AgentProvider>,
    detected_status: Option<SessionStatus>,
    lines: &[String],
) -> String {
    let provider = match provider {
        Some(protocol::AgentProvider::Claude) => "claude",
        Some(protocol::AgentProvider::Copilot) => "copilot",
        Some(protocol::AgentProvider::Codex) => "codex",
        Some(protocol::AgentProvider::Opencode) => "opencode",
        None => "none",
    };
    let detected = match detected_status {
        Some(SessionStatus::Busy) => "busy",
        Some(SessionStatus::Waiting) => "waiting",
        Some(SessionStatus::Idle) => "idle",
        None => "none",
    };

    format!(
        "[headless-terminal-debug] session={} source={} provider={} detected={} lines={:?}",
        session_id, source, provider, detected, lines
    )
}

async fn log_status_observation(session: &Arc<SessionHandle>, session_id: &str, source: &str) {
    if !log::log_enabled!(log::Level::Debug) {
        return;
    }

    let observation = session.debug_status_observation().await;

    match observation {
        Ok(observation) if observation.provider.is_some() => {
            log::debug!(
                "{}",
                format_status_observation_log(
                    session_id,
                    source,
                    observation.provider,
                    observation.detected_status,
                    &observation.lines,
                )
            );
        }
        Ok(_) => {}
        Err(error) => {
            log::warn!(
                "[headless-terminal-debug] failed to collect status observation for session {} from {}: {}",
                session_id,
                source,
                error
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> protocol::TerminalSnapshot {
        protocol::TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 2,
            cursor_col: 3,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "hello".to_string(),
        }
    }

    #[test]
    fn parse_handoff_response_accepts_v2_payload() {
        let line = serde_json::to_string(&Event::HandoffReady {
            sessions: vec![protocol::HandoffSession {
                session_id: "s1".to_string(),
                pid: 42,
                cwd: "/tmp".to_string(),
                rows: 24,
                cols: 80,
                snapshot: None,
                agent_provider: None,
                status: SessionStatus::Idle,
                kind: protocol::SessionKind::Pty,
                provider_session_id: None,
                agent_fd_count: 0,
                agent_spawn: None,
            }],
        })
        .unwrap();

        let sessions = parse_handoff_response(&line).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s1");
        assert!(sessions[0].snapshot.is_none());
        assert_eq!(sessions[0].rows, 24);
        assert_eq!(sessions[0].cols, 80);
    }

    #[test]
    fn parse_handoff_response_accepts_v1_payload() {
        let line = serde_json::to_string(&HandoffEventV1::HandoffReady {
            sessions: vec![HandoffSessionV1 {
                session_id: "s1".to_string(),
                pid: 42,
                cwd: "/tmp".to_string(),
                snapshot: sample_snapshot(),
            }],
        })
        .unwrap();

        let sessions = parse_handoff_response(&line).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s1");
        assert_eq!(sessions[0].rows, 24);
        assert_eq!(sessions[0].cols, 80);
        assert_eq!(sessions[0].snapshot.as_ref().unwrap().vt, "hello");
    }

    #[test]
    fn parse_handoff_response_accepts_v0_0_30_session_info_payload() {
        // Kanna 0.0.30 sent protocol::SessionInfo entries for handoff version 1.
        let line = serde_json::json!({
            "type": "HandoffReady",
            "sessions": [{
                "session_id": "s1",
                "pid": 42,
                "cwd": "/tmp",
                "state": "Active",
                "idle_seconds": 0
            }]
        })
        .to_string();

        let sessions = parse_handoff_response(&line).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s1");
        assert_eq!(sessions[0].pid, 42);
        assert_eq!(sessions[0].cwd, "/tmp");
        assert_eq!(sessions[0].rows, 0);
        assert_eq!(sessions[0].cols, 0);
        assert!(sessions[0].snapshot.is_none());
    }

    #[test]
    fn blank_snapshot_uses_dimensions_for_compat_handoff() {
        let snapshot = blank_snapshot(45, 120);
        assert_eq!(snapshot.rows, 45);
        assert_eq!(snapshot.cols, 120);
        assert_eq!(snapshot.cursor_row, 0);
        assert_eq!(snapshot.cursor_col, 0);
        assert!(snapshot.vt.is_empty());
    }

    #[test]
    fn blank_snapshot_normalizes_zero_dimensions_for_compat_handoff() {
        let snapshot = blank_snapshot(0, 0);
        assert_eq!(snapshot.rows, 24);
        assert_eq!(snapshot.cols, 80);
        assert_eq!(snapshot.cursor_row, 0);
        assert_eq!(snapshot.cursor_col, 0);
        assert!(snapshot.vt.is_empty());
    }

    #[test]
    fn format_status_observation_log_includes_session_source_status_and_lines() {
        let lines = vec!["Header".to_string(), "(Esc to cancel)".to_string()];

        let log_line = format_status_observation_log(
            "dbaa5b9d",
            "mirror_output",
            Some(protocol::AgentProvider::Copilot),
            Some(SessionStatus::Busy),
            &lines,
        );

        assert!(log_line.contains("session=dbaa5b9d"));
        assert!(log_line.contains("source=mirror_output"));
        assert!(log_line.contains("provider=copilot"));
        assert!(log_line.contains("detected=busy"));
        assert!(log_line.contains("Esc to cancel"));
    }

    #[test]
    fn recovery_output_is_mirrored_even_with_live_terminal_client() {
        assert!(should_mirror_output_to_recovery(false));
        assert!(should_mirror_output_to_recovery(true));
    }

    #[test]
    fn effective_terminal_size_uses_minimum_attached_client_dimensions() {
        let mut clients = HashMap::new();
        clients.insert(1, (220, 48));

        assert_eq!(effective_terminal_size(&clients, (80, 24)), (220, 48));

        clients.insert(2, (100, 30));

        assert_eq!(effective_terminal_size(&clients, (80, 24)), (100, 30));
    }

    #[tokio::test]
    async fn connection_drop_cleanup_removes_attached_and_observer_writers() {
        let session_writers: SessionWriters = Arc::new(Mutex::new(HashMap::new()));
        let terminal_emulator_clients: TerminalEmulatorClients =
            Arc::new(Mutex::new(HashMap::new()));
        let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
        let session_observers: SessionObservers = Arc::new(Mutex::new(HashMap::new()));
        let mut writers_to_drop = Vec::new();

        for idx in 0..64 {
            let (_client, server) = UnixStream::pair().expect("should create UnixStream pair");
            let (_read_half, write_half) = server.into_split();
            let writer = Arc::new(Mutex::new(write_half));
            let writer_id = Arc::as_ptr(&writer) as usize;
            let session_id = format!("session-{}", idx % 4);

            session_writers
                .lock()
                .await
                .entry(session_id.clone())
                .or_default()
                .push(writer.clone());
            terminal_emulator_clients
                .lock()
                .await
                .entry(session_id.clone())
                .or_default()
                .insert(writer_id);
            session_sizes
                .lock()
                .await
                .entry(session_id.clone())
                .or_default()
                .insert(writer_id, (80, 24));
            session_observers
                .lock()
                .await
                .entry(session_id)
                .or_default()
                .push(writer.clone());

            writers_to_drop.push(writer);
        }

        let attached_count: usize = session_writers.lock().await.values().map(Vec::len).sum();
        let observer_count: usize = session_observers.lock().await.values().map(Vec::len).sum();
        assert_eq!(attached_count, 64);
        assert_eq!(observer_count, 64);

        for writer in &writers_to_drop {
            cleanup_client_writer_registries(
                writer,
                &session_writers,
                &terminal_emulator_clients,
                &session_sizes,
                &session_observers,
            )
            .await;
        }

        let attached_count: usize = session_writers.lock().await.values().map(Vec::len).sum();
        assert_eq!(attached_count, 0);
        assert!(terminal_emulator_clients.lock().await.is_empty());
        assert!(session_sizes.lock().await.is_empty());
        assert!(session_observers.lock().await.is_empty());
    }

    #[test]
    fn panic_log_path_lives_under_daemon_dir() {
        assert_eq!(
            panic_log_path(Path::new("/tmp/kanna-daemon-test"), 42, 1234),
            PathBuf::from("/tmp/kanna-daemon-test/kanna-daemon-panic_42_1234.log")
        );
    }

    #[test]
    fn stream_output_prioritizes_live_delivery_before_recovery_persistence() {
        let source = include_str!("main.rs");
        let stream_body = source
            .split("fn stream_output(")
            .nth(1)
            .expect("stream_output function should exist");

        let live_delivery_index = stream_body
            .find("let evt = Event::Output")
            .expect("stream_output should emit live Output events");
        let headless_mirror_index = stream_body
            .find(".mirror_output(data")
            .expect("stream_output should mirror output into the headless terminal");
        let recovery_write_index = stream_body
            .find(".write_output(session_id")
            .expect("stream_output should persist output for recovery");

        assert!(
            headless_mirror_index < live_delivery_index,
            "headless mirroring must stay before live delivery so new attaches cannot snapshot stale terminal state",
        );
        assert!(
            live_delivery_index < recovery_write_index,
            "live terminal output should be emitted before recovery persistence so interactive echo is not delayed by bookkeeping",
        );
    }

    #[test]
    fn attach_cutover_locks_session_writer_registry_before_client_writer() {
        let source = include_str!("main.rs");
        let cutover_body = source
            .split("async fn finish_attach_cutover(")
            .nth(1)
            .expect("finish_attach_cutover function should exist")
            .split("async fn request_handoff(")
            .next()
            .expect("finish_attach_cutover body should be bounded by request_handoff");

        let registry_lock_index = cutover_body
            .find("let mut writers = session_writers.lock().await")
            .expect("attach cutover should lock the session writer registry");
        let writer_lock_index = cutover_body
            .find("let mut writer_guard = writer.lock().await")
            .expect("attach cutover should lock the client writer");
        let write_initial_event_index = cutover_body
            .find("write_event(&mut *writer_guard, initial_event)")
            .expect("attach cutover should write the initial snapshot while holding the writer");

        assert!(
            registry_lock_index < writer_lock_index,
            "attach cutover must not hold a client writer while waiting for the session writer registry; stream_output takes those locks in registry -> writer order",
        );
        assert!(
            writer_lock_index < write_initial_event_index,
            "attach cutover must hold the client writer until the initial snapshot is written so live output cannot precede the Snapshot response",
        );
    }

    #[test]
    fn live_terminal_transitions_do_not_rebuild_recovery_sessions() {
        assert!(!should_rebuild_recovery_session_on_live_terminal_transition());
    }

    #[test]
    fn timeout_after_handoff_command_is_not_safe_for_compat_retry() {
        assert!(!should_try_compat_handoff_after_error(
            &HandoffRequestError::ResponseTimeout
        ));
    }

    #[test]
    fn explicit_handoff_version_mismatch_is_safe_for_compat_retry() {
        assert!(should_try_compat_handoff_after_error(
            &HandoffRequestError::OldDaemonRefused(
                "handoff version mismatch: expected 1, got 2".to_string(),
            )
        ));
    }
}
