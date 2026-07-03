use std::collections::HashMap;
use std::sync::Arc;

use kanna_daemon::recovery::{RecoveryManager, SeededRecoverySnapshot};
use tokio::sync::{broadcast, Mutex};

use crate::client::{
    LostHandoffSessions, SessionObservers, SessionSizes, SessionWriters, TerminalEmulatorClients,
};
use crate::connection::handle_connection;
use crate::handoff::attempt_handoff;
use crate::paths::{
    app_support_dir, daemon_data_dir, handle_cli_args, install_panic_hook, CliAction,
};
use crate::session::{SessionHandle, SessionManager, SessionRecord};
use crate::socket::bind_socket;
use crate::{agent_runtime, headless_terminal};

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

    let pid_path = dir.join("daemon.pid");
    let socket_path = kanna_runtime_defaults::socket_path(&dir);

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
