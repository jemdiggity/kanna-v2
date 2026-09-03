use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::Arc;

use kanna_daemon::recovery::{RecoveryManager, SeededRecoverySnapshot};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::client::{LostHandoffSessions, SessionSizes, TerminalEmulatorClients};
use crate::connection::handle_connection;
use crate::daemon_lifecycle::new_daemon_lifecycle;
use crate::fanout::{session_fanout, SessionFanouts};
use crate::handoff::attempt_handoff;
use crate::output::stream_output;
use crate::paths::{
    app_support_dir, daemon_data_dir, handle_cli_args, init_lifecycle_audit, install_panic_hook,
    lifecycle_audit, publish_current_log_link, CliAction,
};
use crate::session::{PendingInput, SessionHandle, SessionManager, SessionRecord, StreamControl};
use crate::socket::bind_socket;
use crate::successor_auth::SuccessorAuthorizer;
use crate::{agent_runtime, headless_terminal};

struct AdoptedPtyReader {
    session_id: String,
    io_fd: OwnedFd,
    input_rx: mpsc::UnboundedReceiver<PendingInput>,
    stream_control: StreamControl,
    handle: Arc<SessionHandle>,
    rows: u16,
    cols: u16,
}

fn adopted_runtime_status(
    headless_terminal: &mut headless_terminal::HeadlessTerminal,
    agent_provider: Option<kanna_daemon::protocol::AgentProvider>,
    inherited_status: kanna_daemon::protocol::SessionStatus,
) -> Result<(kanna_daemon::protocol::SessionStatus, bool), Box<dyn std::error::Error + Send + Sync>>
{
    let detected_status = headless_terminal.visible_status(agent_provider)?;
    let status_observed = detected_status.is_some()
        || inherited_status != headless_terminal::initial_session_status(agent_provider);
    Ok((detected_status.unwrap_or(inherited_status), status_observed))
}

/// Wait for the replaced daemon to actually exit before this daemon adopts
/// sessions or publishes itself. Liveness is identity-checked (start time),
/// so a zombie or a recycled pid counts as exited. If the old daemon
/// overstays the deadline, it is SIGKILLed — but only after revalidating,
/// immediately before the signal, that the pid is still the authenticated
/// socket peer's process; an unauthenticated or identity-mismatched pid is
/// never signaled (fail closed) and is treated as exited.
async fn wait_for_old_daemon_release(old_daemon: &crate::handoff::OldDaemon) {
    wait_for_old_daemon_release_with(
        old_daemon,
        std::time::Duration::from_secs(5),
        std::time::Duration::from_secs(2),
    )
    .await
}

pub(crate) async fn wait_for_old_daemon_release_with(
    old_daemon: &crate::handoff::OldDaemon,
    exit_deadline: std::time::Duration,
    post_kill_deadline: std::time::Duration,
) {
    let deadline = std::time::Instant::now() + exit_deadline;
    while old_daemon.is_alive() {
        if std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        }

        // Revalidate before the kill: authenticated peer, identity intact.
        let identity_intact = old_daemon.identity_intact();
        if old_daemon.authenticated && identity_intact {
            log::warn!(
                "[handoff] old daemon (pid={}) still alive after {:?}; killing it before adopting sessions",
                old_daemon.pid,
                exit_deadline
            );
            // Freeze-verified: a raw kill here could land on a recycled pid if
            // the old daemon exited between the identity check above and the
            // signal. A verified-stopped process cannot exit, so its pid stays
            // pinned across the window; failure means no signal at all.
            let killed = old_daemon.kill_verified();
            if !killed {
                log::warn!(
                    "[handoff] refused to kill old daemon (pid={}): identity could not be pinned \
                     across the signal window",
                    old_daemon.pid
                );
            }
            let post_kill_deadline = std::time::Instant::now() + post_kill_deadline;
            while old_daemon.is_alive() && std::time::Instant::now() < post_kill_deadline {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        } else {
            log::warn!(
                "[handoff] old daemon (pid={}) overstayed but cannot be authenticated \
                 (authenticated={}, identity_intact={}); refusing to signal and proceeding",
                old_daemon.pid,
                old_daemon.authenticated,
                identity_intact
            );
        }
        break;
    }
}

pub(crate) async fn run_daemon() {
    match handle_cli_args() {
        CliAction::RunDaemon => {}
        CliAction::Exit(code) => std::process::exit(code),
    }

    let dir = app_support_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create app support dir");
    match init_lifecycle_audit(&dir) {
        Ok(path) => lifecycle_audit(format_args!(
            "event=startup_begin daemon_dir={} audit_log={} executable={} parent_pid={}",
            dir.display(),
            path.display(),
            std::env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| format!("<unavailable: {error}>")),
            unsafe { libc::getppid() }
        )),
        Err(error) => eprintln!(
            "kanna-daemon: failed to initialize lifecycle audit in {}: {error}",
            dir.display()
        ),
    }
    install_panic_hook(dir.clone());

    // Log to a timestamped per-process file + stderr. The stable symlink and
    // lifecycle audit make the active daemon discoverable without guessing
    // its pid or relying on this logger to initialize successfully.
    let logger_result = flexi_logger::Logger::try_with_env_or_str("info").and_then(|logger| {
        logger
            .log_to_file(
                flexi_logger::FileSpec::default()
                    .directory(&dir)
                    .discriminant(std::process::id().to_string()),
            )
            .format(flexi_logger::detailed_format)
            .duplicate_to_stderr(flexi_logger::Duplicate::Info)
            .start()
    });
    let _logger_handle = match logger_result {
        Ok(handle) => {
            lifecycle_audit(format_args!("event=logger_ready"));
            Some(handle)
        }
        Err(error) => {
            lifecycle_audit(format_args!(
                "event=logger_failed error={error:?} fallback=lifecycle_audit"
            ));
            None
        }
    };
    kanna_daemon::terminal_perf::start_global_watchdog();

    // Capture the app/test launcher executable while it is still our direct
    // parent. The daemon can outlive and be reparented after that launcher
    // exits, but future successors must have a live direct parent at the same
    // trusted executable path.
    let successor_authorizer = match SuccessorAuthorizer::capture() {
        Ok(authorizer) => Arc::new(authorizer),
        Err(error) => {
            log::error!(
                "[handoff] refusing to start without successor trust root: {}",
                error
            );
            lifecycle_audit(format_args!(
                "event=startup_aborted phase=successor_trust_root reason={error}"
            ));
            eprintln!("kanna-daemon: could not capture launcher trust root: {error}");
            std::process::exit(1);
        }
    };
    let operator_authorizer = match crate::operator_auth::OperatorAuthorizer::capture() {
        Ok(authorizer) => Arc::new(authorizer),
        Err(error) => {
            log::error!("refusing to start without operator trust root: {error}");
            eprintln!("kanna-daemon: could not capture operator trust root: {error}");
            std::process::exit(1);
        }
    };

    let pid_path = dir.join("daemon.pid");
    let socket_path = kanna_runtime_defaults::socket_path(&dir);

    // Attempt handoff from old daemon (if running)
    let handoff_result = attempt_handoff(&pid_path, &socket_path).await;
    if let Some(message) = handoff_result.abort_start.as_ref() {
        log::error!("[handoff] refusing to start daemon: {}", message);
        lifecycle_audit(format_args!(
            "event=startup_aborted phase=handoff reason={message}"
        ));
        eprintln!("kanna-daemon: refusing to start: {message}");
        std::process::exit(1);
    }
    let has_adopted_agents = !handoff_result.adopted_agents.is_empty();

    // Release-complete barrier: the old daemon keeps its PTY readers (and
    // agent pipe readers) until after it acknowledges adoption, then stops
    // them and exits. Wait for its authenticated exit before adopting
    // anything or publishing this daemon (pid file + socket), so two daemons
    // can never consume the same PTY output concurrently. The barrier only
    // matters when sessions were actually transferred — without adopted
    // sessions there are no shared descriptors to split, and the peer (which
    // may be a test harness speaking the protocol) is not ours to kill.
    let adopted_any_sessions =
        !handoff_result.adopted.is_empty() || !handoff_result.adopted_agents.is_empty();
    if adopted_any_sessions {
        if let Some(old_daemon) = handoff_result.old_daemon {
            wait_for_old_daemon_release(&old_daemon).await;
            // Publishing while the previous owner still holds these sessions
            // would put two daemons on the same descriptors. If it never
            // released, abort instead of publishing: the sessions stay with
            // the live old daemon, which is recoverable, whereas a split
            // owner is not.
            if old_daemon.is_alive() {
                log::error!(
                    "[handoff] old daemon (pid={}) still owns adopted sessions; refusing to publish",
                    old_daemon.pid
                );
                lifecycle_audit(format_args!(
                    "event=startup_aborted phase=release_barrier old_pid={} reason=incumbent_still_owns_sessions",
                    old_daemon.pid
                ));
                eprintln!(
                    "kanna-daemon: refusing to start: previous daemon (pid={}) never released ownership",
                    old_daemon.pid
                );
                std::process::exit(1);
            }
        }
    }

    let sessions: Arc<Mutex<SessionManager>> = Arc::new(Mutex::new(SessionManager::new()));
    let fanouts: SessionFanouts = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
    let lost_handoff_sessions: LostHandoffSessions = Arc::new(Mutex::new(handoff_result.lost));
    let agent_sessions: kanna_daemon::agent::AgentSessions =
        Arc::new(Mutex::new(Default::default()));
    let daemon_lifecycle = new_daemon_lifecycle();
    let recovery_manager = RecoveryManager::start().await;
    let (broadcast_tx, _) = broadcast::channel::<String>(256);
    let mut adopted_pty_readers = Vec::new();

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
                            saved_at: snapshot.saved_at,
                            sequence: snapshot.sequence,
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
            // The snapshot is the live frame quiesced by the old daemon. Its
            // rendered verdict is newer evidence than the status field being
            // transferred beside it, which may be the conservative startup
            // `Busy` value the old classifier never managed to replace.
            let (status, status_observed) = match adopted_runtime_status(
                &mut headless_terminal,
                handoff.agent_provider,
                handoff.status,
            ) {
                Ok(derived) => derived,
                Err(error) => {
                    log::warn!(
                        "[handoff] failed to re-derive runtime status for adopted session {}: {}",
                        session_id,
                        error
                    );
                    (
                        handoff.status,
                        handoff.status
                            != headless_terminal::initial_session_status(handoff.agent_provider),
                    )
                }
            };
            if status != handoff.status {
                log::info!(
                    "[handoff] re-derived adopted session {} status from live snapshot: {:?} -> {:?}",
                    session_id,
                    handoff.status,
                    status
                );
            }
            let rows = handoff.rows;
            let cols = handoff.cols;
            let stream_control = StreamControl::new();
            let handle = Arc::new(SessionHandle::new(SessionRecord {
                pty: pty_session,
                headless_terminal,
                stream_control: None,
                agent_provider: handoff.agent_provider,
                status,
                status_observed,
                last_status_check_at: None,
                operator_input_only: handoff.operator_input_only
                    || !handoff.input_policy_classified,
                input_policy_classified: handoff.input_policy_classified,
                raw_input_draft_active: handoff.raw_input_draft_active,
                raw_input_draft_state_known: handoff.raw_input_draft_state_known,
                // A sender with no ledger hands over `None`, which holds like
                // a real draft rather than reading as proven-empty.
                typed_draft_bytes: handoff.typed_draft_bytes,
                pending_logical_inputs: handoff.pending_logical_inputs,
            }));
            let reader = match handle.try_clone_io_fd().await {
                Ok(io_fd) => match handle.take_input_rx().await {
                    Some(input_rx) => {
                        handle.set_stream_control(stream_control.clone()).await;
                        Some(AdoptedPtyReader {
                            session_id: session_id.clone(),
                            io_fd,
                            input_rx,
                            stream_control,
                            handle: Arc::clone(&handle),
                            rows,
                            cols,
                        })
                    }
                    None => {
                        log::warn!(
                            "[handoff] adopted PTY input queue was already taken for {}",
                            session_id
                        );
                        None
                    }
                },
                Err(error) => {
                    log::warn!(
                        "[handoff] failed to clone adopted PTY fd for {}: {}",
                        session_id,
                        error
                    );
                    None
                }
            };
            mgr.insert(session_id, handle);
            if let Some(reader) = reader {
                adopted_pty_readers.push(reader);
            }
        }
    }

    // The release barrier above fences the old readers before these start.
    // Adopted PTYs begin streaming immediately so detached task activity
    // remains authoritative even before a terminal client first attaches.
    for reader in adopted_pty_readers {
        let resume_from_disk = recovery_manager.has_persisted_snapshot(&reader.session_id);
        if let Err(error) = recovery_manager
            .start_session(
                &reader.session_id,
                reader.cols,
                reader.rows,
                resume_from_disk,
            )
            .await
        {
            log::warn!(
                "[recovery] failed to start adopted session {} (resume_from_disk={}): {}",
                reader.session_id,
                resume_from_disk,
                error
            );
        }

        session_fanout(&fanouts, &reader.session_id)
            .await
            .state
            .lock()
            .await
            .mark_streaming();
        let sessions_for_stream = sessions.clone();
        let fanouts_for_stream = fanouts.clone();
        let terminal_clients_for_stream = terminal_emulator_clients.clone();
        let sizes_for_stream = session_sizes.clone();
        let recovery_for_stream = recovery_manager.clone();
        let broadcast_for_stream = broadcast_tx.clone();
        let daemon_lifecycle_for_stream = daemon_lifecycle.clone();
        tokio::spawn(async move {
            stream_output(
                reader.session_id,
                reader.io_fd,
                reader.input_rx,
                reader.stream_control,
                broadcast_for_stream,
                fanouts_for_stream,
                terminal_clients_for_stream,
                sessions_for_stream,
                sizes_for_stream,
                recovery_for_stream,
                daemon_lifecycle_for_stream,
                reader.handle,
            )
            .await;
        });
    }

    // Adopt handed-off agent sessions after the same release barrier. It
    // guarantees the old daemon exited: its blocked reader threads held the
    // same pipes until then, and its final journal appends must land before
    // we reload from disk.
    if has_adopted_agents {
        for (info, fds) in handoff_result.adopted_agents {
            agent_runtime::adopt_agent_session(
                info,
                fds,
                agent_sessions.clone(),
                broadcast_tx.clone(),
                daemon_data_dir(),
                daemon_lifecycle.clone(),
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
    match publish_current_log_link(&dir, pid) {
        Ok(target) => lifecycle_audit(format_args!(
            "event=current_log_published link={} target={}",
            dir.join("kanna-daemon.log").display(),
            target.display()
        )),
        Err(error) => lifecycle_audit(format_args!(
            "event=current_log_publish_failed error={error}"
        )),
    }
    let published_sessions = sessions.lock().await.session_ids();
    let published_agent_sessions = agent_sessions
        .lock()
        .await
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    lifecycle_audit(format_args!(
        "event=daemon_published socket={} pty_sessions={:?} agent_sessions={:?}",
        socket_path.display(),
        published_sessions,
        published_agent_sessions
    ));

    let pid_path_clone = pid_path.clone();
    let socket_path_clone = socket_path.clone();
    let sessions_shutdown = sessions.clone();
    let recovery_shutdown = recovery_manager.clone();
    tokio::spawn(async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to register SIGTERM handler");
        sigterm.recv().await;
        log::info!("kanna-daemon shutting down");
        let session_ids = sessions_shutdown.lock().await.session_ids();
        lifecycle_audit(format_args!(
            "event=sigterm_shutdown sessions_to_kill={session_ids:?}"
        ));
        recovery_shutdown.flush_and_shutdown().await;
        // Scan rounds batched across every session. This awaits plan
        // completion, so teardown finishes before the exit below; the bounded
        // timeout keeps a wedged sweep from blocking shutdown forever.
        let teardown = async {
            sessions_shutdown
                .lock()
                .await
                .kill_all_with_shared_scan()
                .await
        };
        if tokio::time::timeout(std::time::Duration::from_secs(10), teardown)
            .await
            .is_err()
        {
            log::warn!("[shutdown] session teardown did not finish within 10s; exiting anyway");
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
                let fanouts_clone = fanouts.clone();
                let terminal_clients_clone = terminal_emulator_clients.clone();
                let sizes_clone = session_sizes.clone();
                let lost_handoff_clone = lost_handoff_sessions.clone();
                let recovery_clone = recovery_manager.clone();
                let agent_sessions_clone = agent_sessions.clone();
                let daemon_lifecycle_clone = daemon_lifecycle.clone();
                let successor_authorizer_clone = successor_authorizer.clone();
                let operator_authorizer_clone = operator_authorizer.clone();
                tokio::spawn(async move {
                    handle_connection(
                        stream,
                        sessions_clone,
                        broadcast_tx_clone,
                        fanouts_clone,
                        terminal_clients_clone,
                        sizes_clone,
                        lost_handoff_clone,
                        recovery_clone,
                        agent_sessions_clone,
                        daemon_lifecycle_clone,
                        successor_authorizer_clone,
                        operator_authorizer_clone,
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

#[cfg(test)]
mod adopted_runtime_status_tests {
    use crate::headless_terminal::HeadlessTerminal;
    use kanna_daemon::protocol::{AgentProvider, SessionStatus, TerminalSnapshot};

    #[test]
    fn handoff_rederives_idle_from_incident_frame_instead_of_inheriting_busy() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/claude/idle-composer-2.1.259-280x81.json"
        ))
        .unwrap();
        let snapshot: TerminalSnapshot =
            serde_json::from_value(fixture["snapshot"].clone()).unwrap();
        let mut terminal = HeadlessTerminal::from_snapshot(&snapshot, 10_000).unwrap();

        let (status, observed) = super::adopted_runtime_status(
            &mut terminal,
            Some(AgentProvider::Claude),
            SessionStatus::Busy,
        )
        .unwrap();

        assert_eq!(status, SessionStatus::Idle);
        assert!(observed);
    }
}
