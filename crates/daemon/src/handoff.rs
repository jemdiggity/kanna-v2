use std::collections::HashMap;
use std::fmt;
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd};
use std::path::PathBuf;
use std::sync::Arc;

use kanna_daemon::{
    protocol::{self, Command, Event, SessionStatus},
    recovery::RecoveryManager,
};
use serde::Serialize;
use tokio::io::BufReader;
use tokio::sync::{broadcast, Mutex};

use crate::client::{SessionObservers, SessionSizes, SessionWriters};
use crate::session::{SessionManager, StreamControl};
use crate::socket::{read_command, write_event};
use crate::util::error_event;
use crate::{fd_transfer, pty};

/// Current handoff protocol version. Both sides must agree.
const HANDOFF_VERSION: u32 = 2;
const HANDOFF_COMPAT_VERSION: u32 = 1;
const HANDOFF_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) struct HandoffResult {
    pub(crate) adopted: Vec<(String, pty::PtySession, protocol::HandoffSession)>,
    pub(crate) adopted_agents: Vec<(protocol::HandoffSession, Vec<std::os::fd::RawFd>)>,
    pub(crate) lost: HashMap<String, String>,
    pub(crate) old_pid: Option<i32>,
    pub(crate) abort_start: Option<String>,
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
pub(crate) enum HandoffRequestError {
    ResponseTimeout,
    OldDaemonRefused(String),
    TransferFailed {
        message: String,
        session_infos: Vec<protocol::HandoffSession>,
    },
    Other(String),
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
pub(crate) struct HandoffSessionV1 {
    pub(crate) session_id: String,
    pub(crate) pid: u32,
    pub(crate) cwd: String,
    pub(crate) snapshot: protocol::TerminalSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub(crate) enum HandoffEventV1 {
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

fn handoff_loss_message(reason: impl Into<String>) -> String {
    format!("session lost during daemon handoff: {}", reason.into())
}

pub(crate) fn parse_handoff_response(line: &str) -> Result<Vec<protocol::HandoffSession>, String> {
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

pub(crate) fn blank_snapshot(rows: u16, cols: u16) -> protocol::TerminalSnapshot {
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

pub(crate) fn should_try_compat_handoff_after_error(error: &HandoffRequestError) -> bool {
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
pub(crate) async fn attempt_handoff(pid_path: &PathBuf, socket_path: &PathBuf) -> HandoffResult {
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

/// Handle a handoff request from a new daemon.
/// Collects all live sessions, sends metadata + master fds, then exits.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_handoff(
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
