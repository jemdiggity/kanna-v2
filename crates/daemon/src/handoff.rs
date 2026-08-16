use std::collections::HashMap;
use std::fmt;
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd};
use std::path::PathBuf;
use std::sync::Arc;

use kanna_daemon::{
    protocol::{self, Command, Event},
    recovery::RecoveryManager,
};
use tokio::io::BufReader;
use tokio::sync::{broadcast, Mutex};

use crate::client::SessionSizes;
use crate::daemon_lifecycle::{DaemonLifecycle, DaemonLifecycleState};
use crate::fanout::SessionFanouts;
use crate::paths::lifecycle_audit;
use crate::session::{SessionManager, StreamControl};
use crate::socket::{read_command, write_event};
use crate::successor_auth::SuccessorAuthorizer;
use crate::util::error_event;
use crate::{fd_transfer, pty};

const HANDOFF_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn handoff_response_timeout() -> std::time::Duration {
    #[cfg(debug_assertions)]
    if let Some(timeout_ms) = std::env::var("KANNA_TEST_HANDOFF_RESPONSE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        return std::time::Duration::from_millis(timeout_ms);
    }
    HANDOFF_RESPONSE_TIMEOUT
}

/// The guarantees selected for this transfer. The mode is resolved at the
/// version boundary and carried explicitly so a legacy response can never be
/// mistaken for a transactional snapshot later in adoption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HandoffMode {
    TransactionalV3,
    LegacyV2,
}

impl HandoffMode {
    fn version(self) -> u32 {
        match self {
            Self::TransactionalV3 => protocol::HANDOFF_PROTOCOL_VERSION,
            Self::LegacyV2 => protocol::LEGACY_HANDOFF_PROTOCOL_VERSION,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::TransactionalV3 => "transactional-v3",
            Self::LegacyV2 => "legacy-v2",
        }
    }
}

pub(crate) fn handoff_mode_for_version(version: u32) -> Option<HandoffMode> {
    match version {
        protocol::HANDOFF_PROTOCOL_VERSION => Some(HandoffMode::TransactionalV3),
        protocol::LEGACY_HANDOFF_PROTOCOL_VERSION => Some(HandoffMode::LegacyV2),
        _ => None,
    }
}

/// The daemon this process is replacing, pinned to a verifiable identity.
/// `pid` comes from the pid file but is only trusted for signaling when
/// `authenticated` is set (confirmed against the Unix-socket peer that
/// actually served the handoff) and its start-time identity still matches.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OldDaemon {
    pub(crate) pid: libc::pid_t,
    pub(crate) start: Option<crate::proc_info::StartTime>,
    pub(crate) authenticated: bool,
}

impl OldDaemon {
    /// True while the recorded process is still running (identity-checked;
    /// a zombie or a recycled pid counts as exited).
    pub(crate) fn is_alive(&self) -> bool {
        match self.start {
            Some(start) => crate::proc_info::identity_alive(self.pid, start),
            // No identity available (non-macOS fallback): a liveness probe is
            // the best we can do, but never enough to authorize a kill.
            None => unsafe { libc::kill(self.pid, 0) == 0 },
        }
    }

    pub(crate) fn identity_intact(&self) -> bool {
        self.start
            .is_some_and(|start| crate::proc_info::identity_alive(self.pid, start))
    }

    /// Signal only the authenticated process identity pinned before the
    /// handoff connection was opened. The verified stop/signal window keeps a
    /// recycled pid from becoming a target between validation and SIGKILL.
    pub(crate) fn kill_verified(&self) -> bool {
        self.authenticated
            && self.start.is_some_and(|start| {
                crate::proc_info::kill_process_verified(crate::proc_info::SessionTarget {
                    pid: self.pid,
                    start,
                })
            })
    }
}

pub(crate) struct HandoffResult {
    pub(crate) adopted: Vec<(String, pty::PtySession, protocol::HandoffSession)>,
    pub(crate) adopted_agents: Vec<(protocol::HandoffSession, Vec<std::os::fd::RawFd>)>,
    pub(crate) lost: HashMap<String, String>,
    pub(crate) old_daemon: Option<OldDaemon>,
    pub(crate) abort_start: Option<String>,
}

impl HandoffResult {
    fn empty() -> Self {
        HandoffResult {
            adopted: vec![],
            adopted_agents: vec![],
            lost: HashMap::new(),
            old_daemon: None,
            abort_start: None,
        }
    }
}

#[derive(Debug)]
pub(crate) enum HandoffRequestError {
    ResponseTimeout,
    VersionMismatch(String),
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
            HandoffRequestError::VersionMismatch(message) => {
                write!(
                    f,
                    "old daemon reported a handoff version mismatch: {message}"
                )
            }
            HandoffRequestError::OldDaemonRefused(message) => {
                write!(f, "old daemon refused: {}", message)
            }
            HandoffRequestError::TransferFailed { message, .. } => write!(f, "{}", message),
            HandoffRequestError::Other(message) => write!(f, "{}", message),
        }
    }
}

fn handoff_loss_message(reason: impl Into<String>) -> String {
    format!("session lost during daemon handoff: {}", reason.into())
}

pub(crate) fn parse_handoff_response(
    line: &str,
) -> Result<Vec<protocol::HandoffSession>, HandoffRequestError> {
    match serde_json::from_str::<Event>(line)
        .map_err(|error| HandoffRequestError::Other(format!("invalid handoff response: {error}")))?
    {
        Event::HandoffReady { sessions } => Ok(sessions),
        Event::Error {
            code: Some(protocol::ErrorCode::HandoffVersionMismatch),
            message,
        } => Err(HandoffRequestError::VersionMismatch(message)),
        Event::Error { message, .. } => Err(HandoffRequestError::OldDaemonRefused(message)),
        other => Err(HandoffRequestError::Other(format!(
            "unexpected handoff response: {other:?}"
        ))),
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

type HandoffTransfer = (
    Vec<protocol::HandoffSession>,
    Vec<std::os::fd::RawFd>,
    OldDaemon,
);

async fn request_handoff(
    socket_path: &PathBuf,
    mode: HandoffMode,
    expected_pid: libc::pid_t,
    expected_start: Option<crate::proc_info::StartTime>,
) -> Result<HandoffTransfer, HandoffRequestError> {
    let stream = tokio::net::UnixStream::connect(socket_path)
        .await
        .map_err(|e| {
            HandoffRequestError::Other(format!(
                "failed to connect to old daemon at {:?}: {}",
                socket_path, e
            ))
        })?;

    // The socket peer is the process that actually serves this handoff —
    // the authoritative identity of the old daemon, unlike the pid file.
    // Fail closed on disagreement before any protocol exchange: adopting
    // sessions from (and later signaling) a process other than the one
    // daemon.pid names is exactly the confusion this check exists to stop.
    // Peer credentials are MANDATORY: descriptors (and, later, signal
    // authority) must never be accepted from a peer we could not identify.
    // A missing credential result is a refusal, not a soft fallback.
    let peer_pid = crate::proc_info::socket_peer_pid(stream.as_raw_fd());
    match peer_pid {
        None => {
            return Err(HandoffRequestError::Other(
                "could not read the handoff peer's credentials; refusing handoff".to_string(),
            ));
        }
        Some(peer) if peer != expected_pid => {
            return Err(HandoffRequestError::Other(format!(
                "socket peer pid {peer} does not match daemon.pid {expected_pid}; refusing handoff"
            )));
        }
        Some(_) => {}
    }
    // The pid alone is not an identity: authenticate it against the start-time
    // pinned before we connected, so a peer that exited and had its pid
    // recycled cannot pass as the old daemon.
    let peer_identity_ok = |phase: &str| -> Result<(), HandoffRequestError> {
        match expected_start {
            Some(start) if crate::proc_info::identity_matches(expected_pid, start) => Ok(()),
            Some(start) => Err(HandoffRequestError::Other(format!(
                "handoff peer {expected_pid} no longer matches its pinned start identity \
                 {start:?} at {phase}; refusing handoff"
            ))),
            None => Err(HandoffRequestError::Other(format!(
                "handoff peer {expected_pid} has no pinned start identity at {phase}; \
                 refusing handoff"
            ))),
        }
    };
    peer_identity_ok("connect")?;
    let old_daemon = OldDaemon {
        pid: expected_pid,
        start: expected_start,
        authenticated: true,
    };
    log::info!(
        "[handoff] connected to old daemon (peer_pid={:?})",
        peer_pid
    );

    let raw_fd = stream.as_raw_fd();
    let (read_half, write_half) = stream.into_split();
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut writer = write_half;

    let cmd = serde_json::json!({ "type": "Handoff", "version": mode.version() });
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
    log::info!(
        "[handoff] sent Handoff command (mode={}, version={})",
        mode.label(),
        mode.version()
    );

    let mut line = String::new();
    use tokio::io::AsyncBufReadExt;
    tokio::time::timeout(handoff_response_timeout(), reader.read_line(&mut line))
        .await
        .map_err(|_| HandoffRequestError::ResponseTimeout)?
        .map_err(|e| {
            HandoffRequestError::Other(format!("error reading handoff response: {}", e))
        })?;

    log::info!("[handoff] received response: {}", line.trim());
    let session_infos = parse_handoff_response(line.trim())?;

    if mode == HandoffMode::LegacyV2
        && session_infos
            .iter()
            .any(|session| session.operator_input_only)
    {
        return Err(HandoffRequestError::OldDaemonRefused(
            "legacy-v2 handoff contains a protected-input session; refusing adoption".to_string(),
        ));
    }

    if let Err(message) = validate_handoff_fd_counts(&session_infos) {
        // The fd stream is positional: one out-of-protocol count would
        // misassign every subsequent descriptor. Refuse before receiving.
        return Err(HandoffRequestError::TransferFailed {
            message,
            session_infos: session_infos.clone(),
        });
    }

    let expected_fds = expected_handoff_fd_count(&session_infos);
    if expected_fds == 0 {
        peer_identity_ok("metadata ack")?;
        maybe_delay_handoff_ack().await;
        send_handoff_ack(&mut writer, mode.version()).await?;
        wait_for_handoff_release_with(
            &mut reader,
            &old_daemon,
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(2),
        )
        .await?;
        return Ok((session_infos, vec![], old_daemon));
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
    // Re-authenticate immediately before the ACK: these descriptors are only
    // adoptable if the peer that sent them is still the pinned old daemon.
    // On mismatch close every received fd rather than adopting them.
    if let Err(error) = peer_identity_ok("descriptor ack") {
        for fd in &fds {
            unsafe { libc::close(*fd) };
        }
        return Err(error);
    }
    maybe_delay_handoff_ack().await;
    send_handoff_ack(&mut writer, mode.version()).await?;
    if let Err(error) = wait_for_handoff_release_with(
        &mut reader,
        &old_daemon,
        std::time::Duration::from_secs(5),
        std::time::Duration::from_secs(2),
    )
    .await
    {
        for fd in &fds {
            unsafe { libc::close(*fd) };
        }
        return Err(error);
    }
    Ok((session_infos, fds, old_daemon))
}

pub(crate) async fn wait_for_handoff_release_with(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
    old_daemon: &OldDaemon,
    release_deadline: std::time::Duration,
    post_kill_deadline: std::time::Duration,
) -> Result<(), HandoffRequestError> {
    use tokio::io::AsyncBufReadExt;

    async fn wait_for_eof(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    log::debug!(
                        "[handoff] ignoring message while waiting for old daemon release: {}",
                        line.trim()
                    );
                }
            }
        }
    }

    // HandoffAdopted commits descriptor ownership. The incumbent then stops
    // its readers and closes this dedicated connection. EOF is the actual
    // release barrier: process probes alone cannot prove those reader tasks
    // have relinquished the transferred descriptors.
    if tokio::time::timeout(release_deadline, wait_for_eof(reader))
        .await
        .is_ok()
    {
        return Ok(());
    }

    log::warn!(
        "[handoff] old daemon (pid={}) did not close the handoff connection after {:?}",
        old_daemon.pid,
        release_deadline
    );
    if !old_daemon.kill_verified() {
        return Err(HandoffRequestError::Other(format!(
            "old daemon pid {} did not release transferred descriptors and its authenticated \
             identity could not be pinned for termination",
            old_daemon.pid
        )));
    }

    tokio::time::timeout(post_kill_deadline, wait_for_eof(reader))
        .await
        .map_err(|_| {
            HandoffRequestError::Other(format!(
                "old daemon pid {} did not close the handoff connection after verified termination",
                old_daemon.pid
            ))
        })
}

/// Fault-injection hook for the cross-version lifecycle regression. Holding
/// the adopter immediately before ACK creates a deterministic window after
/// the legacy sender has transferred its snapshot and descriptors but before
/// that sender commits the handoff. Normal daemon processes never set this.
async fn maybe_delay_handoff_ack() {
    if let Some(delay_ms) = std::env::var("KANNA_TEST_HANDOFF_ACK_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&value| value > 0)
    {
        log::warn!(
            "[handoff] TEST HOOK: delaying adoption acknowledgement by {}ms",
            delay_ms
        );
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
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
        Err(error) => Err(HandoffRequestError::Other(format!(
            "failed to send handoff ack: {error}"
        ))),
    }
}

/// Agent sessions may only transfer protocol-shaped pipe bundles: nothing
/// for an exited child, stdout+stderr, or stdout+stderr+stdin. Any other
/// count is a corrupt or hostile wire value that would misalign the
/// positional fd stream for every later session.
pub(crate) fn validate_handoff_fd_counts(
    session_infos: &[protocol::HandoffSession],
) -> Result<(), String> {
    match session_infos.iter().find(|info| {
        info.kind == protocol::SessionKind::Agent && !matches!(info.agent_fd_count, 0 | 2 | 3)
    }) {
        Some(info) => Err(format!(
            "agent session {} declares invalid fd count {} (protocol allows 0, 2, or 3)",
            info.session_id, info.agent_fd_count
        )),
        None => Ok(()),
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

pub(crate) fn legacy_fallback_after_error(error: &HandoffRequestError) -> Option<HandoffMode> {
    match error {
        HandoffRequestError::VersionMismatch(_) => Some(HandoffMode::LegacyV2),
        HandoffRequestError::ResponseTimeout
        | HandoffRequestError::OldDaemonRefused(_)
        | HandoffRequestError::TransferFailed { .. }
        | HandoffRequestError::Other(_) => None,
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
    lifecycle_audit(format_args!(
        "event=handoff_check pid_file={} socket={}",
        pid_path.display(),
        socket_path.display()
    ));

    // Check if the old daemon is running. The pid file is untrusted input:
    // parse it strictly (a negative or oversized value would turn later
    // signals into process-group or broadcast targets) and pin the process
    // to its start-time identity; a zombie or recycled pid counts as exited.
    let pid_file_pid = match std::fs::read_to_string(pid_path) {
        Ok(s) => match s
            .trim()
            .parse::<u32>()
            .ok()
            .and_then(pty::validated_child_pid)
        {
            Some(pid) => pid,
            None => {
                log::info!("[handoff] pid file has invalid content: {:?}", s.trim());
                lifecycle_audit(format_args!(
                    "event=handoff_skipped reason=invalid_pid_file content={:?}",
                    s.trim()
                ));
                return HandoffResult::empty();
            }
        },
        Err(e) => {
            log::info!("[handoff] no pid file: {}", e);
            lifecycle_audit(format_args!(
                "event=handoff_skipped reason=no_pid_file error={e}"
            ));
            return HandoffResult::empty();
        }
    };
    // Pin the exact (pid, start) identity BEFORE connecting. Everything that
    // follows — the peer-continuity check, the release wait, and any kill —
    // uses this pinned pair; it is never replaced by a later sample, so a
    // peer that exits mid-handoff and has its pid recycled can never be
    // signaled.
    let pinned_start = match crate::proc_info::process_info(pid_file_pid) {
        Some(info) if !info.is_zombie => Some(info.start),
        observed => {
            log::info!(
                "[handoff] pid file contains {} but process is not running (observed {:?})",
                pid_file_pid,
                observed
            );
            lifecycle_audit(format_args!(
                "event=handoff_skipped reason=incumbent_not_running old_pid={} observed={observed:?}",
                pid_file_pid
            ));
            return HandoffResult::empty();
        }
    };

    log::info!(
        "[handoff] old daemon detected (pid={}), connecting to {:?}",
        pid_file_pid,
        socket_path
    );
    lifecycle_audit(format_args!(
        "event=handoff_attempt old_pid={} mode={} timeout_ms={}",
        pid_file_pid,
        HandoffMode::TransactionalV3.label(),
        handoff_response_timeout().as_millis()
    ));

    // Ambiguous failures retain the pre-connect identity only for liveness
    // reporting. request_handoff returns the authenticated, continuously
    // verified identity on success; this fallback must never be killable.
    let unauthenticated_old_daemon = OldDaemon {
        pid: pid_file_pid,
        // The pre-connect sample, never a fresh one: re-sampling after the
        // ACK would silently re-pin a recycled pid.
        start: pinned_start,
        authenticated: false,
    };
    let old_pid = pid_file_pid;

    let initial_mode = HandoffMode::TransactionalV3;
    let (session_infos, fds, used_mode, old_daemon) = match request_handoff(
        socket_path,
        initial_mode,
        pid_file_pid,
        pinned_start,
    )
    .await
    {
        Ok((session_infos, fds, old_daemon)) => (session_infos, fds, initial_mode, old_daemon),
        Err(error) => {
            log::info!(
                "[handoff] mode {} (version {}) failed: {}",
                initial_mode.label(),
                initial_mode.version(),
                error
            );
            let Some(legacy_mode) = legacy_fallback_after_error(&error) else {
                log::info!(
                    "[handoff] not attempting legacy fallback after ambiguous {} failure",
                    initial_mode.label()
                );
                lifecycle_audit(format_args!(
                    "event=handoff_aborted old_pid={} mode={} reason={error} incumbent_retained=true",
                    old_pid,
                    initial_mode.label()
                ));
                return HandoffResult {
                    adopted: vec![],
                    adopted_agents: vec![],
                    lost: lost_sessions_from_handoff_error(&error),
                    old_daemon: Some(unauthenticated_old_daemon),
                    abort_start: Some(format!(
                        "old daemon pid {old_pid} is alive but handoff failed ambiguously: {error}"
                    )),
                };
            };
            log::warn!(
                "[handoff] selected legacy-v2 mode; stable sessions will transfer, \
                 but concurrent Spawn/Kill is outside a provable snapshot boundary"
            );
            match request_handoff(socket_path, legacy_mode, pid_file_pid, pinned_start).await {
                Ok((session_infos, fds, old_daemon)) => {
                    log::info!(
                        "[handoff] legacy fallback accepted (mode={}, version={})",
                        legacy_mode.label(),
                        legacy_mode.version()
                    );
                    (session_infos, fds, legacy_mode, old_daemon)
                }
                Err(legacy_error) => {
                    log::info!(
                        "[handoff] legacy mode {} also failed: {}",
                        legacy_mode.label(),
                        legacy_error
                    );
                    lifecycle_audit(format_args!(
                        "event=handoff_aborted old_pid={} mode={} reason={legacy_error} incumbent_retained=true",
                        old_pid,
                        legacy_mode.label()
                    ));
                    return HandoffResult {
                        adopted: vec![],
                        adopted_agents: vec![],
                        lost: lost_sessions_from_handoff_error(&legacy_error),
                        old_daemon: Some(unauthenticated_old_daemon),
                        abort_start: Some(format!(
                            "old daemon pid {old_pid} is alive but legacy handoff failed: {legacy_error}"
                        )),
                    };
                }
            }
        }
    };

    if session_infos.is_empty() {
        log::info!("[handoff] no sessions to adopt");
        lifecycle_audit(format_args!(
            "event=handoff_adopted old_pid={} mode={} sessions=[]",
            old_pid,
            used_mode.label()
        ));
        return HandoffResult {
            old_daemon: Some(old_daemon),
            ..HandoffResult::empty()
        };
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
        "[handoff] received {} fds using mode {} (version {}): {:?}",
        fds.len(),
        used_mode.label(),
        used_mode.version(),
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
        let lost_ids = session_infos
            .iter()
            .map(|info| info.session_id.as_str())
            .collect::<Vec<_>>();
        lifecycle_audit(format_args!(
            "event=handoff_aborted old_pid={} mode={} reason=fd_count_mismatch expected_fds={} received_fds={} affected_sessions={lost_ids:?} incumbent_retained=true",
            old_pid,
            used_mode.label(),
            expected_fds,
            fds.len()
        ));
        return HandoffResult {
            lost,
            old_daemon: Some(old_daemon),
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
                // Liveness is only probed through a validated pid: a raw 0 or
                // out-of-range value would turn kill(pid, 0) into a process-
                // group or broadcast probe.
                let alive = pty::validated_child_pid(info.pid)
                    .map(|pid| unsafe { libc::kill(pid, 0) } == 0)
                    .unwrap_or(false);
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
                    info.pid,
                    info.child_start,
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
    let adopted_ids = adopted
        .iter()
        .map(|(session_id, _, _)| session_id.as_str())
        .chain(
            adopted_agents
                .iter()
                .map(|(info, _)| info.session_id.as_str()),
        )
        .collect::<Vec<_>>();
    lifecycle_audit(format_args!(
        "event=handoff_adopted old_pid={} mode={} sessions={adopted_ids:?}",
        old_pid,
        used_mode.label()
    ));
    HandoffResult {
        adopted,
        adopted_agents,
        lost: HashMap::new(),
        old_daemon: Some(old_daemon),
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
    fanouts: SessionFanouts,
    session_sizes: SessionSizes,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    broadcast_tx: broadcast::Sender<String>,
    recovery_manager: RecoveryManager,
    agent_sessions: kanna_daemon::agent::AgentSessions,
    daemon_lifecycle: DaemonLifecycle,
    successor_authorizer: Arc<SuccessorAuthorizer>,
) -> bool {
    log::info!(
        "[handoff] received Handoff request (version={}, current_version={})",
        version,
        protocol::HANDOFF_PROTOCOL_VERSION
    );
    lifecycle_audit(format_args!(
        "event=handoff_request_received version={} current_version={}",
        version,
        protocol::HANDOFF_PROTOCOL_VERSION
    ));

    #[cfg(debug_assertions)]
    if let Some(delay_ms) = std::env::var("KANNA_TEST_HANDOFF_RESPONSE_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|delay_ms| *delay_ms > 0)
    {
        log::warn!("[handoff] TEST HOOK: delaying response by {}ms", delay_ms);
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    let Some(mode) = handoff_mode_for_version(version) else {
        log::info!("[handoff] version mismatch, rejecting");
        lifecycle_audit(format_args!(
            "event=handoff_refused reason=version_mismatch requested_version={version}"
        ));
        let evt = error_event(
            Some(protocol::ErrorCode::HandoffVersionMismatch),
            format!(
                "handoff version mismatch: expected {} or {}, got {}",
                protocol::HANDOFF_PROTOCOL_VERSION,
                protocol::LEGACY_HANDOFF_PROTOCOL_VERSION,
                version
            ),
        );
        let _ = write_event(&mut *writer.lock().await, &evt).await;
        return false;
    };
    log::info!(
        "[handoff] accepted mode {} (version={})",
        mode.label(),
        mode.version()
    );

    // Authentication is intentionally before lifecycle ownership acquisition
    // and registry sealing. A connection that merely possesses the public
    // daemon socket must never fence mutations, snapshot a session, or receive
    // a descriptor.
    let authorized_successor =
        match successor_authorizer.authorize_then(socket_fd, |authorized| authorized) {
            Ok(authorized) => authorized,
            Err(error) => {
                log::warn!("[handoff] refusing unauthorized successor: {}", error);
                lifecycle_audit(format_args!(
                    "event=handoff_refused reason=unauthorized error={error}"
                ));
                let evt = error_event(
                    Some(protocol::ErrorCode::HandoffUnauthorized),
                    format!("handoff successor is not authorized: {error}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return false;
            }
        };
    log::info!(
        "[handoff] authorized successor peer={} parent={}",
        authorized_successor.peer.pid,
        authorized_successor.parent.pid
    );
    lifecycle_audit(format_args!(
        "event=handoff_authorized successor_pid={} launcher_pid={} mode={}",
        authorized_successor.peer.pid,
        authorized_successor.parent.pid,
        mode.label()
    ));

    // Seal both live registries from snapshot capture through ACK resolution.
    // Spawn/Kill/natural-exit hold read guards around their mutations, so an
    // adopted snapshot cannot omit a new session or retain a killed/replaced
    // incarnation.
    let mut daemon_lifecycle_guard = daemon_lifecycle.write().await;
    if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
        let evt = error_event(None, "daemon handoff already committed");
        let _ = write_event(&mut *writer.lock().await, &evt).await;
        return false;
    }

    if mode == HandoffMode::LegacyV2 {
        let handles = sessions.lock().await.handles();
        for (session_id, handle) in handles {
            if handle.operator_input_only().await {
                lifecycle_audit(format_args!(
                    "event=handoff_refused reason=protected_input_requires_v3 session={session_id}"
                ));
                let event = error_event(
                    Some(protocol::ErrorCode::HandoffVersionMismatch),
                    format!("legacy-v2 handoff cannot transfer protected session: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &event).await;
                return false;
            }
            match handle.input_coordination_requires_v3() {
                Ok(true) => {
                    lifecycle_audit(format_args!(
                        "event=handoff_refused reason=draft_coordination_requires_v3 session={session_id}"
                    ));
                    let event = error_event(
                        Some(protocol::ErrorCode::HandoffVersionMismatch),
                        format!(
                            "legacy-v2 handoff cannot transfer terminal draft coordination: {session_id}"
                        ),
                    );
                    let _ = write_event(&mut *writer.lock().await, &event).await;
                    return false;
                }
                Ok(false) => {}
                Err(error) => {
                    lifecycle_audit(format_args!(
                        "event=handoff_refused reason=draft_coordination_unavailable session={session_id}"
                    ));
                    let event = error_event(
                        None,
                        format!(
                            "legacy-v2 handoff could not inspect terminal draft coordination for {session_id}: {error:?}"
                        ),
                    );
                    let _ = write_event(&mut *writer.lock().await, &event).await;
                    return false;
                }
            }
        }
    }

    // Snapshot and clone fds without removing ownership. The old daemon keeps
    // serving sessions unless the adopting daemon explicitly ACKs success.
    // Fence concurrent PTY Spawn/Kill for the duration of the transfer: a
    // session spawned after this snapshot would never have its master fd
    // transferred (silently lost when this daemon exits), and a killed
    // session must not be reinserted behind the snapshot. The seal lifts on
    // every abort path below; a committed handoff keeps it until exit.
    let pty_epoch = sessions.lock().await.seal_for_handoff();
    let handles = sessions.lock().await.handles();
    log::info!(
        "[handoff] found {} sessions in manager (epoch {})",
        handles.len(),
        pty_epoch
    );
    let mut controls = Vec::new();
    for (_, handle) in &handles {
        if let Some(control) = handle.stream_control().await {
            controls.push(control);
        }
    }
    for control in &controls {
        control.request_quiesce();
    }
    let quiesce_started = std::time::Instant::now();
    while quiesce_started.elapsed() < std::time::Duration::from_secs(2)
        && controls
            .iter()
            .any(|control| !control.is_quiesced() && !control.is_stopped())
    {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    if controls
        .iter()
        .any(|control| !control.is_quiesced() && !control.is_stopped())
    {
        log::warn!("[handoff] timed out quiescing PTY readers; rolling back");
        lifecycle_audit(format_args!(
            "event=handoff_rolled_back reason=pty_reader_quiesce_timeout"
        ));
        for control in &controls {
            control.resume();
        }
        sessions.lock().await.unseal_for_handoff();
        return false;
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
                    child_start: parts.child_start,
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
                    operator_input_only: parts.operator_input_only,
                    input_policy_classified: parts.input_policy_classified,
                    raw_input_draft_active: parts.raw_input_draft_active,
                    raw_input_draft_state_known: parts.raw_input_draft_state_known,
                    pending_logical_inputs: parts.pending_logical_inputs,
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
    // Collect agent sessions for both v3 and the retained full-v2 payload.
    // Duplicated agent pipe fds owned by this function: they stay valid
    // through sendmsg and the adoption acknowledgement even if a child exits
    // and its record closes the originals in between (a closed-and-reused
    // raw fd number must never be transferred). Dropped — and closed — when
    // this function returns on any path.
    let mut agent_fd_guards: Vec<std::os::fd::OwnedFd> = Vec::new();
    // The current sender provides its hardened guarantees even when a
    // deployed v2 adopter asks for the legacy wire epoch.
    let mut handoff_seal = Some(crate::agent_runtime::AgentHandoffSealGuard::arm());
    // Seal the agent registry before snapshotting it: an in-flight
    // (re)spawn installer that lands after this point cleans up its
    // child instead of installing into a daemon that is about to exit
    // (the child resumes via its journal on the adopting daemon).
    // The seal is lifted again only if this handoff fails and the
    // daemon keeps serving.
    let settle_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let still_spawning = agent_sessions
            .lock()
            .await
            .values()
            .any(|record| record.spawning);
        if !still_spawning || std::time::Instant::now() >= settle_deadline {
            if still_spawning {
                log::warn!(
                    "[handoff] agent spawns still in flight at snapshot; transferring them as exited"
                );
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let agent_records = agent_sessions.lock().await;
    for (id, record) in agent_records.iter() {
        let (agent_fd_count, session_fds) = match (record.exited, record.handoff_fds) {
            (false, Some(bundle)) => match bundle.duplicate_owned() {
                Ok(owned) => {
                    use std::os::unix::io::AsRawFd;
                    let raw: Vec<std::os::fd::RawFd> =
                        owned.iter().map(|fd| fd.as_raw_fd()).collect();
                    agent_fd_guards.extend(owned);
                    (raw.len() as u8, raw)
                }
                Err(error) => {
                    log::warn!(
                        "[handoff] failed to duplicate pipe bundle for agent session {}: {}; transferring as exited",
                        id,
                        error
                    );
                    (0, Vec::new())
                }
            },
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
            child_start: record.child_start,
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
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            pending_logical_inputs: Vec::new(),
        });
        fds.extend(session_fds);
    }
    drop(agent_records);

    log::info!(
        "[handoff] collected {} live sessions ({} dead)",
        infos.len(),
        dead_count
    );
    let transfer_ids = infos
        .iter()
        .map(|info| info.session_id.clone())
        .collect::<Vec<_>>();
    lifecycle_audit(format_args!(
        "event=handoff_snapshot mode={} live_sessions={transfer_ids:?} skipped_dead={dead_count}",
        mode.label()
    ));

    #[cfg(debug_assertions)]
    if let Ok(marker_path) = std::env::var("KANNA_DAEMON_TEST_HANDOFF_SNAPSHOT_MARKER") {
        if let Err(error) = std::fs::write(&marker_path, b"snapshot-complete") {
            log::warn!(
                "[handoff] failed to write snapshot-window marker {}: {}",
                marker_path,
                error
            );
        }
        if let Ok(release_path) = std::env::var("KANNA_DAEMON_TEST_HANDOFF_SNAPSHOT_RELEASE") {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while !std::path::Path::new(&release_path).exists()
                && std::time::Instant::now() < deadline
            {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
    }

    log::info!(
        "[handoff] sending HandoffReady with {} sessions",
        infos.len()
    );

    // v2 deployed adopters understand this full payload and ignore optional
    // metadata fields introduced by hardened senders.
    let evt = Event::HandoffReady { sessions: infos };
    if let Err(error) = write_event(&mut *writer.lock().await, &evt).await {
        log::error!("[handoff] failed to write HandoffReady: {}", error);
        lifecycle_audit(format_args!(
            "event=handoff_rolled_back reason=handoff_ready_write_failed error={error} sessions_retained={transfer_ids:?}"
        ));
        for control in &controls {
            control.resume();
        }
        for fd in cloned_pty_fds.drain(..) {
            unsafe { libc::close(fd) };
        }
        sessions.lock().await.unseal_for_handoff();
        return false;
    }

    // Flush the writer before sending fds
    {
        use tokio::io::AsyncWriteExt;
        if let Err(error) = writer.lock().await.flush().await {
            log::error!("[handoff] failed to flush HandoffReady: {}", error);
            lifecycle_audit(format_args!(
                "event=handoff_rolled_back reason=handoff_ready_flush_failed error={error} sessions_retained={transfer_ids:?}"
            ));
            for control in &controls {
                control.resume();
            }
            for fd in cloned_pty_fds.drain(..) {
                unsafe { libc::close(fd) };
            }
            sessions.lock().await.unseal_for_handoff();
            return false;
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
                lifecycle_audit(format_args!(
                    "event=handoff_rolled_back reason=fd_send_failed error={e} sessions_retained={transfer_ids:?}"
                ));
                for control in &controls {
                    control.resume();
                }
                for fd in cloned_pty_fds.drain(..) {
                    unsafe { libc::close(fd) };
                }
                sessions.lock().await.unseal_for_handoff();
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
            lifecycle_audit(format_args!(
                "event=handoff_committed successor_pid={} sessions={transfer_ids:?}",
                authorized_successor.peer.pid
            ));
            // The transfer is committed: keep the agent registry sealed for
            // the remainder of this (exiting) daemon's life.
            if let Some(seal) = handoff_seal.take() {
                seal.defuse();
            }
        }
        Ok(Some(other)) => {
            log::warn!("[handoff] expected HandoffAdopted, got {:?}", other);
            lifecycle_audit(format_args!(
                "event=handoff_rolled_back reason=unexpected_ack ack={other:?} sessions_retained={transfer_ids:?}"
            ));
            for control in &controls {
                control.resume();
            }
            for fd in cloned_pty_fds.drain(..) {
                unsafe { libc::close(fd) };
            }
            sessions.lock().await.unseal_for_handoff();
            return false;
        }
        Ok(None) => {
            log::warn!("[handoff] adopting daemon disconnected before ack");
            lifecycle_audit(format_args!(
                "event=handoff_rolled_back reason=disconnect_before_ack sessions_retained={transfer_ids:?}"
            ));
            for control in &controls {
                control.resume();
            }
            for fd in cloned_pty_fds.drain(..) {
                unsafe { libc::close(fd) };
            }
            sessions.lock().await.unseal_for_handoff();
            return false;
        }
        Err(_) => {
            log::warn!("[handoff] timed out waiting for adoption ack");
            lifecycle_audit(format_args!(
                "event=handoff_rolled_back reason=ack_timeout sessions_retained={transfer_ids:?}"
            ));
            for control in &controls {
                control.resume();
            }
            for fd in cloned_pty_fds.drain(..) {
                unsafe { libc::close(fd) };
            }
            sessions.lock().await.unseal_for_handoff();
            return false;
        }
    }

    *daemon_lifecycle_guard = DaemonLifecycleState::HandoffCommitted;
    drop(daemon_lifecycle_guard);

    // Fault-injection hook for the delayed-old-reader regression: simulate a
    // daemon that is slow to relinquish its PTY readers after acknowledging
    // adoption. The adopting daemon must not publish (pid file/socket) until
    // this process has exited, so a delay here must delay publication, not
    // split output. No effect unless the test env var is set.
    if let Some(delay_ms) = std::env::var("KANNA_TEST_HANDOFF_RELEASE_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&value| value > 0)
    {
        log::warn!(
            "[handoff] TEST HOOK: delaying reader release by {}ms",
            delay_ms
        );
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
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

    // Clear all subscriber fanouts after adoption succeeds; stream_output
    // tasks will end as this process exits and clients should reconnect to
    // the new daemon.
    fanouts.lock().await.clear();
    session_sizes.lock().await.clear();

    for fd in cloned_pty_fds.drain(..) {
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
    lifecycle_audit(format_args!(
        "event=handoff_sender_exit successor_pid={} transferred_sessions={transfer_ids:?}",
        authorized_successor.peer.pid
    ));
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
