use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::Arc;

use kanna_daemon::recovery::{RecoveryManager, SeededRecoverySnapshot};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::client::{LostHandoffSessions, SessionSizes, TerminalEmulatorClients};
use crate::connection::handle_connection;
use crate::fanout::{session_fanout, SessionFanouts};
use crate::handoff::attempt_handoff;
use crate::output::stream_output;
use crate::paths::{
    app_support_dir, daemon_data_dir, handle_cli_args, install_panic_hook, CliAction,
};
use crate::session::{SessionHandle, SessionManager, SessionRecord, StreamControl};
use crate::socket::bind_socket;
use crate::{agent_runtime, headless_terminal};

struct AdoptedPtyReader {
    session_id: String,
    io_fd: OwnedFd,
    input_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stream_control: StreamControl,
    handle: Arc<SessionHandle>,
    rows: u16,
    cols: u16,
}

pub(crate) async fn run_daemon() {
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
    kanna_daemon::terminal_perf::start_global_watchdog();

    let pid_path = dir.join("daemon.pid");
    let socket_path = kanna_runtime_defaults::socket_path(&dir);

    // Attempt handoff from old daemon (if running)
    let handoff_result = attempt_handoff(&pid_path, &socket_path).await;
    if let Some(message) = handoff_result.abort_start.as_ref() {
        log::error!("[handoff] refusing to start daemon: {}", message);
        eprintln!("kanna-daemon: refusing to start: {message}");
        std::process::exit(1);
    }
    let has_adopted_agents = !handoff_result.adopted_agents.is_empty();

    let sessions: Arc<Mutex<SessionManager>> = Arc::new(Mutex::new(SessionManager::new()));
    let fanouts: SessionFanouts = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
    let lost_handoff_sessions: LostHandoffSessions = Arc::new(Mutex::new(handoff_result.lost));
    let agent_sessions: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(HashMap::new()));
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
            let rows = handoff.rows;
            let cols = handoff.cols;
            let stream_control = StreamControl::new();
            let handle = Arc::new(SessionHandle::new(SessionRecord {
                pty: pty_session,
                headless_terminal,
                stream_control: None,
                agent_provider: handoff.agent_provider,
                status: handoff.status,
                status_observed,
                last_status_check_at: None,
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

    // attempt_handoff returns only after the old daemon closes the dedicated
    // handoff connection, which fences its readers before these start.
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
                reader.handle,
            )
            .await;
        });
    }

    // Adopt handed-off agent sessions after the same handoff barrier.
    if has_adopted_agents {
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
                let fanouts_clone = fanouts.clone();
                let terminal_clients_clone = terminal_emulator_clients.clone();
                let sizes_clone = session_sizes.clone();
                let lost_handoff_clone = lost_handoff_sessions.clone();
                let recovery_clone = recovery_manager.clone();
                let agent_sessions_clone = agent_sessions.clone();
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
