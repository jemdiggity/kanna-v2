use std::future::Future;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::time::Duration;

use kanna_daemon::{
    protocol::{self, Command, Event},
    recovery::{RecoveryManager, SeededRecoverySnapshot},
};
use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, Mutex};

use crate::client::{
    cleanup_client_writer_registries, effective_terminal_size, register_terminal_emulator_client,
    unregister_terminal_emulator_client, LostHandoffSessions, SessionSizes,
    TerminalEmulatorClients,
};
use crate::fanout::{session_fanout, SessionFanouts, SubscriberKind};
use crate::handoff::{blank_snapshot, handle_handoff};
use crate::output::{handle_output_chunk, stream_output};
use crate::paths::daemon_data_dir;
use crate::session::{
    CodexDiscoveryCancellation, SessionHandle, SessionManager, SessionRecord, StreamControl,
};
use crate::socket::{read_command, write_event};

pub(crate) fn subscription_allows(message: &str, event_stream_version: u32) -> bool {
    if event_stream_version >= protocol::CURRENT_EVENT_STREAM_VERSION {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(message)
        .ok()
        .and_then(|value| value.get("type")?.as_str().map(str::to_string))
        .is_none_or(|event_type| event_type != "ProviderSessionChanged")
}

const CODEX_DISCOVERY_DEADLINE: Duration = Duration::from_secs(10);
const CODEX_DISCOVERY_INITIAL_BACKOFF: Duration = Duration::from_millis(25);
const CODEX_DISCOVERY_MAX_BACKOFF: Duration = Duration::from_millis(500);

enum CodexDiscoveryPoll {
    Found(String),
    Pending,
    Stop,
}

async fn poll_codex_discovery<F, Fut>(
    cancellation: CodexDiscoveryCancellation,
    deadline: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    mut scan: F,
) -> Option<String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = CodexDiscoveryPoll>,
{
    let expires_at = tokio::time::Instant::now() + deadline;
    let mut backoff = initial_backoff;
    loop {
        if cancellation.is_cancelled() {
            return None;
        }
        let scan_result = tokio::select! {
            result = scan() => result,
            _ = cancellation.cancelled() => return None,
            _ = tokio::time::sleep_until(expires_at) => return None,
        };
        match scan_result {
            CodexDiscoveryPoll::Found(provider_session_id) => return Some(provider_session_id),
            CodexDiscoveryPoll::Stop => return None,
            CodexDiscoveryPoll::Pending => {}
        }
        let now = tokio::time::Instant::now();
        if now >= expires_at {
            return None;
        }
        let sleep_for = backoff.min(expires_at.saturating_duration_since(now));
        tokio::select! {
            _ = tokio::time::sleep(sleep_for) => {}
            _ = cancellation.cancelled() => return None,
        }
        backoff = backoff.saturating_mul(2).min(max_backoff);
    }
}

fn start_subscription(
    subscription_task: &mut Option<tokio::task::JoinHandle<()>>,
    event_stream_version: u32,
    broadcast_tx: &broadcast::Sender<String>,
    writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
) {
    if subscription_task.is_some() {
        return;
    }
    let mut broadcast_rx = broadcast_tx.subscribe();
    let writer_broadcast = Arc::clone(writer);
    *subscription_task = Some(tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Ok(msg) = broadcast_rx.recv().await {
            if !subscription_allows(&msg, event_stream_version) {
                continue;
            }
            let mut writer = writer_broadcast.lock().await;
            if writer.write_all(msg.as_bytes()).await.is_err()
                || writer.write_all(b"\n").await.is_err()
                || writer.flush().await.is_err()
            {
                break;
            }
        }
    }));
}
use crate::util::{error_event, recovery_snapshot_to_terminal_snapshot};
use crate::{agent_runtime, headless_terminal, pty};

async fn session_handle(
    sessions: &Arc<Mutex<SessionManager>>,
    session_id: &str,
) -> Option<Arc<SessionHandle>> {
    sessions.lock().await.get(session_id)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_connection(
    stream: UnixStream,
    sessions: Arc<Mutex<SessionManager>>,
    broadcast_tx: broadcast::Sender<String>,
    fanouts: SessionFanouts,
    terminal_emulator_clients: TerminalEmulatorClients,
    session_sizes: SessionSizes,
    lost_handoff_sessions: LostHandoffSessions,
    recovery_manager: RecoveryManager,
    agent_sessions: kanna_daemon::agent::AgentSessions,
) {
    // Keep the raw fd for SCM_RIGHTS (used by Handoff)
    let raw_fd = stream.as_raw_fd();
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));

    let mut subscription_task: Option<tokio::task::JoinHandle<()>> = None;

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
                    fanouts.clone(),
                    session_sizes.clone(),
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
                start_subscription(&mut subscription_task, 1, &broadcast_tx, &writer);
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(Command::SubscribeEvents { version }) => {
                if version != protocol::CURRENT_EVENT_STREAM_VERSION {
                    let event =
                        error_event(None, format!("unsupported event stream version: {version}"));
                    let _ = write_event(&mut *writer.lock().await, &event).await;
                    continue;
                }
                start_subscription(&mut subscription_task, version, &broadcast_tx, &writer);
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
                let fanout = session_fanout(&fanouts, &session_id).await;
                fanout.state.lock().await.register(
                    &session_id,
                    SubscriberKind::Observer,
                    &writer,
                    &[],
                );
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(Command::ObserveSnapshot { session_id }) => {
                let Some(session) = session_handle(&sessions, &session_id).await else {
                    let evt = error_event(
                        Some(protocol::ErrorCode::SessionNotFound),
                        format!("session not found: {}", session_id),
                    );
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    continue;
                };
                // Atomic observer cutover: like AttachSnapshot, the snapshot
                // and the registration happen under the session fanout lock
                // the ingestion loop holds across (mirror -> enqueue), and
                // the snapshot is the observer's first queued event — so a
                // chunk is either fully inside the snapshot or delivered as
                // Output strictly after it, never lost and never doubled.
                let fanout = session_fanout(&fanouts, &session_id).await;
                let mut fanout_state = fanout.state.lock().await;
                let snapshot = match session.snapshot(&session_id).await {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        let (rows, cols) = session.rows_cols().await;
                        log::warn!(
                            "[observe_snapshot] snapshot not ready for session {}: {}; falling back to blank snapshot",
                            session_id,
                            error
                        );
                        blank_snapshot(rows, cols)
                    }
                };
                fanout_state.register(
                    &session_id,
                    SubscriberKind::Observer,
                    &writer,
                    &[Event::Snapshot {
                        session_id: session_id.clone(),
                        snapshot,
                    }],
                );
                drop(fanout_state);
            }
            Some(Command::Unobserve { session_id }) => {
                if let Some(fanout) =
                    crate::fanout::existing_session_fanout(&fanouts, &session_id).await
                {
                    fanout
                        .state
                        .lock()
                        .await
                        .remove(SubscriberKind::Observer, Arc::as_ptr(&writer) as usize);
                }
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(command) => {
                handle_command(
                    command,
                    sessions.clone(),
                    writer.clone(),
                    broadcast_tx.clone(),
                    fanouts.clone(),
                    terminal_emulator_clients.clone(),
                    session_sizes.clone(),
                    lost_handoff_sessions.clone(),
                    recovery_manager.clone(),
                    agent_sessions.clone(),
                )
                .await;
            }
        }
    }

    if let Some(task) = subscription_task {
        task.abort();
    }

    // Connection dropped: remove every registry entry that owns or indexes this
    // writer so dead Unix socket fds cannot survive on idle sessions.
    let remaining_sizes = cleanup_client_writer_registries(
        &writer,
        &fanouts,
        &terminal_emulator_clients,
        &session_sizes,
    )
    .await;
    for (session_id, cols, rows) in remaining_sizes {
        let resized = match session_handle(&sessions, &session_id).await {
            Some(session) => session.resize(cols, rows).await.is_ok(),
            None => false,
        };
        if resized {
            recovery_manager
                .resize_session(&session_id, cols, rows)
                .await;
        }
    }
    agent_runtime::cleanup_agent_writer(&agent_sessions, &writer).await;
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_command(
    command: Command,
    sessions: Arc<Mutex<SessionManager>>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    broadcast_tx: broadcast::Sender<String>,
    fanouts: SessionFanouts,
    terminal_emulator_clients: TerminalEmulatorClients,
    session_sizes: SessionSizes,
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
            terminal_prelude,
        } => {
            let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
            let _lifecycle_guard = lifecycle.lock().await;
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
            let run_id = env.get("KANNA_STAGE_RUN_ID").cloned();
            let codex_session_locator =
                crate::codex_session::CodexSessionLocator::before_spawn(agent_provider, &cwd, &env);

            match pty::PtySession::spawn(&executable, &args, &cwd, &env, cols, rows) {
                Ok(mut pty_session) => {
                    // Keep the authoritative duplicate check, one-shot seed
                    // consumption, and insertion under the same lock. Otherwise
                    // a losing concurrent Spawn can consume the seed before the
                    // winning session is registered.
                    let mut mgr = sessions.lock().await;
                    if mgr.contains(&session_id) {
                        drop(mgr);
                        let evt = error_event(
                            Some(protocol::ErrorCode::SessionAlreadyExists),
                            format!("session already exists: {}", session_id),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                    if mgr.is_sealed_for_handoff() || mgr.is_tearing_down(&session_id) {
                        drop(mgr);
                        log::warn!(
                            "[spawn] refusing session {}: handoff transfer or teardown in flight",
                            session_id
                        );
                        let _ = pty_session.kill();
                        let evt = error_event(
                            Some(protocol::ErrorCode::PtySpawnFailed),
                            format!(
                                "daemon handoff or session teardown in progress; retry session {session_id}"
                            ),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                    let stream_control = StreamControl::new();
                    let seeded_snapshot =
                        match recovery_manager.take_seeded_snapshot_for_start(&session_id) {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                drop(mgr);
                                let evt = error_event(
                                    None,
                                    format!(
                                        "failed to load seeded recovery snapshot for {}: {}",
                                        session_id, error
                                    ),
                                );
                                let _ = write_event(&mut *writer.lock().await, &evt).await;
                                return;
                            }
                        };
                    let terminal_snapshot = seeded_snapshot
                        .clone()
                        .map(recovery_snapshot_to_terminal_snapshot);
                    let headless_terminal = match terminal_snapshot.as_ref() {
                        Some(snapshot) => {
                            headless_terminal::HeadlessTerminal::from_snapshot(snapshot, 10_000)
                        }
                        None => headless_terminal::HeadlessTerminal::new(cols, rows, 10_000),
                    };
                    let headless_terminal = match headless_terminal {
                        Ok(headless_terminal) => headless_terminal,
                        Err(e) => {
                            drop(mgr);
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
                        run_id: run_id.clone(),
                        codex_session_locator,
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
                            drop(mgr);
                            let evt = error_event(
                                Some(protocol::ErrorCode::PtyCloneFailed),
                                format!("failed to clone PTY fd: {}", e),
                            );
                            let _ = write_event(&mut *writer.lock().await, &evt).await;
                            return;
                        }
                    };
                    let Some(input_rx) = handle.take_input_rx().await else {
                        drop(mgr);
                        let evt = error_event(None, "failed to take PTY input queue".to_string());
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    };
                    if !mgr.insert_unless_sealed(session_id.clone(), Arc::clone(&handle)) {
                        drop(mgr);
                        log::warn!(
                            "[spawn] refusing session {}: handoff transfer or teardown in flight",
                            session_id
                        );
                        let _ = handle.kill().await;
                        let evt = error_event(
                            Some(protocol::ErrorCode::PtySpawnFailed),
                            format!(
                                "daemon handoff or session teardown in progress; retry session {session_id}"
                            ),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                    drop(mgr);

                    let (recovery_cols, recovery_rows) = seeded_snapshot
                        .as_ref()
                        .map(|snapshot| (snapshot.cols, snapshot.rows))
                        .unwrap_or((cols, rows));
                    let resume_seeded_snapshot = seeded_snapshot.is_some();
                    if let Err(error) = recovery_manager
                        .start_session(
                            &session_id,
                            recovery_cols,
                            recovery_rows,
                            resume_seeded_snapshot,
                        )
                        .await
                    {
                        log::warn!(
                            "[recovery] failed to start mirrored session {} (resume_seeded_snapshot={}): {}",
                            session_id,
                            resume_seeded_snapshot,
                            error
                        );
                    }

                    // Start stream_output immediately so startup output
                    // (including kitty keyboard mode push) is captured.
                    session_fanout(&fanouts, &session_id)
                        .await
                        .state
                        .lock()
                        .await
                        .mark_streaming();
                    // Establish the session on both the request connection and
                    // runtime event stream before any prelude, provider
                    // discovery, output, status, or Exit can be observed.
                    let evt = Event::SessionCreated {
                        session_id: session_id.clone(),
                        run_id,
                    };
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    if let Ok(json) = serde_json::to_string(&evt) {
                        let _ = broadcast_tx.send(json);
                    }

                    if agent_provider == Some(protocol::AgentProvider::Codex) {
                        let discovery_session_id = session_id.clone();
                        let discovery_session = Arc::clone(&handle);
                        let discovery_sessions = Arc::clone(&sessions);
                        let discovery_broadcast = broadcast_tx.clone();
                        let discovery_cancellation =
                            discovery_session.codex_discovery_cancellation();
                        tokio::spawn(async move {
                            let found = poll_codex_discovery(
                                discovery_cancellation,
                                CODEX_DISCOVERY_DEADLINE,
                                CODEX_DISCOVERY_INITIAL_BACKOFF,
                                CODEX_DISCOVERY_MAX_BACKOFF,
                                || {
                                    let discovery_sessions = Arc::clone(&discovery_sessions);
                                    let discovery_session = Arc::clone(&discovery_session);
                                    let discovery_session_id = discovery_session_id.clone();
                                    async move {
                                        let still_current = discovery_sessions
                                            .lock()
                                            .await
                                            .get(&discovery_session_id)
                                            .is_some_and(|current| {
                                                Arc::ptr_eq(&current, &discovery_session)
                                            });
                                        if !still_current {
                                            return CodexDiscoveryPoll::Stop;
                                        }
                                        match discovery_session.codex_resume_session_id().await {
                                            Ok(Some(provider_session_id)) => {
                                                CodexDiscoveryPoll::Found(provider_session_id)
                                            }
                                            Ok(None) => CodexDiscoveryPoll::Pending,
                                            Err(error) => {
                                                log::warn!(
                                                    "[codex-session] discovery failed for {}: {}",
                                                    discovery_session_id,
                                                    error
                                                );
                                                CodexDiscoveryPoll::Pending
                                            }
                                        }
                                    }
                                },
                            )
                            .await;
                            if let Some(provider_session_id) = found {
                                let event = Event::ProviderSessionChanged {
                                    session_id: discovery_session_id,
                                    run_id: discovery_session.run_id().await,
                                    provider_session_id,
                                };
                                if let Ok(json) = serde_json::to_string(&event) {
                                    let _ = discovery_broadcast.send(json);
                                }
                            }
                        });
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

                    if let Some(prelude) = terminal_prelude
                        .as_deref()
                        .filter(|bytes| !bytes.is_empty())
                    {
                        handle_output_chunk(
                            &session_id,
                            prelude,
                            0,
                            &handle,
                            &broadcast_tx,
                            &fanouts,
                            &terminal_emulator_clients,
                            &recovery_manager,
                        )
                        .await;
                    }

                    let sid = session_id.clone();
                    let sessions_exit = sessions.clone();
                    let fanouts_for_stream = fanouts.clone();
                    let terminal_clients_for_stream = terminal_emulator_clients.clone();
                    let sizes_for_stream = session_sizes.clone();
                    let recovery_for_stream = recovery_manager.clone();
                    let broadcast_for_stream = broadcast_tx.clone();
                    tokio::spawn(async move {
                        stream_output(
                            sid,
                            io_fd,
                            input_rx,
                            stream_control,
                            broadcast_for_stream,
                            fanouts_for_stream,
                            terminal_clients_for_stream,
                            sessions_exit,
                            sizes_for_stream,
                            recovery_for_stream,
                            handle,
                        )
                        .await;
                    });
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
                if let Some(fanout) =
                    crate::fanout::existing_session_fanout(&fanouts, &session_id).await
                {
                    fanout
                        .state
                        .lock()
                        .await
                        .remove(SubscriberKind::Attached, Arc::as_ptr(&writer) as usize);
                }

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

        Command::InputNoReply { session_id, data } => {
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };

            if session.enqueue_input(data).is_err() {
                let evt = error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
            }
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

            let fanout = session_fanout(&fanouts, &session_id).await;
            let is_streaming = fanout.state.lock().await.streaming();
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

                let fanouts_for_stream = fanouts.clone();
                let terminal_clients_for_stream = terminal_emulator_clients.clone();
                let sizes_for_stream = session_sizes.clone();
                let recovery_for_stream = recovery_manager.clone();
                let sessions_for_stream = sessions.clone();
                let session_id_for_stream = session_id.clone();
                let handle_for_stream = Arc::clone(&session);
                fanout.state.lock().await.mark_streaming();
                tokio::spawn(async move {
                    stream_output(
                        session_id_for_stream,
                        io_fd,
                        input_rx,
                        stream_control,
                        broadcast_tx.clone(),
                        fanouts_for_stream,
                        terminal_clients_for_stream,
                        sessions_for_stream,
                        sizes_for_stream,
                        recovery_for_stream,
                        handle_for_stream,
                    )
                    .await;
                });
            }

            // Atomic snapshot-to-live cutover: the ingestion loop holds the
            // same fanout lock across (mirror -> enqueue), so the snapshot
            // taken here and the registration behind it cannot interleave
            // with a chunk — the client sees each chunk exactly once, either
            // inside the snapshot or as live output queued after it.
            let mut fanout_state = fanout.state.lock().await;
            let snapshot = match session.snapshot(&session_id).await {
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
            let initial_events = [
                Event::Snapshot {
                    session_id: session_id.clone(),
                    snapshot,
                },
                Event::StatusChanged {
                    session_id: session_id.clone(),
                    status: session.status().await,
                    waiting_prompt_snippet: None,
                },
            ];
            fanout_state.register(
                &session_id,
                SubscriberKind::Attached,
                &writer,
                &initial_events,
            );
            if emulate_terminal {
                register_terminal_emulator_client(&terminal_emulator_clients, &session_id, &writer)
                    .await;
            }
            drop(fanout_state);
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

        Command::ResizeNoReply {
            session_id,
            cols,
            rows,
        } => {
            // One persistent control socket owns one size entry. Commands on
            // that socket are read in order, preserving resize/input ordering.
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
            match result {
                Ok(_) => {
                    recovery_manager
                        .resize_session(&session_id, eff_cols, eff_rows)
                        .await;
                }
                Err(error) => {
                    let evt = error_event(None, error.to_string());
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                }
            }
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

        Command::Kill {
            session_id,
            expected_run_id,
        } => {
            let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
            let _lifecycle_guard = lifecycle.lock().await;
            log::info!(
                "[kill] session={} expected_run_id={:?}",
                session_id,
                expected_run_id
            );
            // Fence Kill with the handoff transaction: the snapshot has
            // already been taken and sent, so removing the session here would
            // let the successor resurrect it from that snapshot. Refuse and
            // let the client retry against the new daemon.
            if session_handle(&sessions, &session_id).await.is_none() {
                match agent_runtime::kill_agent_session(
                    &session_id,
                    expected_run_id.as_deref(),
                    &agent_sessions,
                    &broadcast_tx,
                )
                .await
                {
                    agent_runtime::AgentKillOutcome::Killed => {
                        let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
                        return;
                    }
                    agent_runtime::AgentKillOutcome::HandoffInFlight => {
                        // Same contract as the PTY branch below: the snapshot
                        // already holds this session, so acknowledging the kill
                        // would let the successor resurrect it.
                        log::warn!(
                            "[kill] refusing agent session {}: handoff transfer in flight",
                            session_id
                        );
                        let evt = error_event(
                            Some(protocol::ErrorCode::HandoffLost),
                            format!(
                                "daemon handoff in progress; retry killing session {session_id} against the new daemon"
                            ),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                    agent_runtime::AgentKillOutcome::OwnershipMismatch => {
                        let evt = error_event(
                            Some(protocol::ErrorCode::SessionOwnershipMismatch),
                            format!(
                                "session ownership changed: {session_id} is not owned by run {}",
                                expected_run_id.as_deref().unwrap_or_default()
                            ),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                    // Not an agent session — fall through to the PTY registry.
                    agent_runtime::AgentKillOutcome::NotFound => {}
                }
            }
            if let Some(expected) = expected_run_id.as_deref() {
                let candidate = sessions.lock().await.get(&session_id);
                if let Some(candidate) = candidate {
                    if candidate.run_id().await.as_deref() != Some(expected) {
                        let evt = error_event(
                            Some(protocol::ErrorCode::SessionOwnershipMismatch),
                            format!(
                                "session ownership changed: {session_id} is not owned by run {expected}"
                            ),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                }
            }
            // Claim the exact incarnation BEFORE tearing it down, and do it in
            // the same lock acquisition that resolved it. Teardown awaits the
            // lifecycle executor, so leaving the session in the map across
            // that await lets its reader observe the child's death and publish
            // a natural `killed: false` Exit first — which both races the
            // orchestrated Exit and can land after a same-id respawn's
            // SessionCreated. Removing it up front makes the reader's exit
            // cleanup skip ("current session changed"), leaving exactly one
            // authoritative Exit, published here before any same-id spawn can
            // be accepted.
            let claim = {
                let mut mgr = sessions.lock().await;
                // The seal test and the claim share this one acquisition —
                // the same synchronization boundary the handoff snapshot uses
                // — so a snapshot can never be taken between them and
                // resurrect a Kill this daemon already acknowledged.
                if mgr.is_sealed_for_handoff() {
                    Err(())
                } else {
                    let taken = mgr
                        .get(&session_id)
                        .and_then(|handle| mgr.remove_if_same(&session_id, &handle));
                    if taken.is_some() {
                        // Guard the id until this teardown has published its
                        // Exit and cleared every id-keyed registry. Without it
                        // a same-id Spawn could install between the claim and
                        // the cleanup below, and then have its own fanout,
                        // terminal-client and size entries wiped by that
                        // cleanup.
                        let _ = mgr.begin_teardown(&session_id);
                    }
                    Ok(taken)
                }
            };
            let session = match claim {
                Err(()) => {
                    log::warn!(
                        "[kill] refusing session {}: handoff transfer in flight",
                        session_id
                    );
                    let evt = error_event(
                        Some(protocol::ErrorCode::HandoffLost),
                        format!(
                            "daemon handoff in progress; retry killing session {session_id} against the new daemon"
                        ),
                    );
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    return;
                }
                Ok(session) => session,
            };
            let stream_control = match &session {
                Some(session) => {
                    let control = session.stream_control().await;
                    if let Some(control) = control.as_ref() {
                        control.request_stop();
                    }
                    control
                }
                None => None,
            };
            let (owned_run_id, cached_resume_session_id) = match &session {
                Some(session) => (
                    session.run_id().await,
                    match session.codex_resume_session_id().await {
                        Ok(value) => value,
                        Err(error) => {
                            log::warn!(
                                "[kill] failed to cache codex resume session id for {}: {}",
                                session_id,
                                error
                            );
                            None
                        }
                    },
                ),
                None => (None, None),
            };
            if let Some(session) = &session {
                session.cancel_codex_discovery();
            }
            let result = match &session {
                Some(session) => session.kill().await,
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("session not found: {}", session_id),
                )),
            };
            if result.is_ok() {
                if let Some(control) = stream_control.as_ref() {
                    control.wait_until_stopped().await;
                }
            }

            let killed_fanout = fanouts.lock().await.remove(&session_id);
            if result.is_ok() {
                // The lifecycle guard keeps a same-id Spawn on another
                // connection behind the old reader's stop acknowledgement,
                // killed Exit, and recovery teardown. The manager claim above
                // independently ensures the handoff snapshot and this Kill
                // agree on the exact outgoing incarnation.
                let exit_evt = Event::Exit {
                    session_id: session_id.clone(),
                    run_id: owned_run_id,
                    code: 128 + libc::SIGKILL,
                    resume_session_id: cached_resume_session_id,
                    killed: true,
                };
                if let Ok(json) = serde_json::to_string(&exit_evt) {
                    let _ = broadcast_tx.send(json);
                }
                // A killed session must reach attached clients and observers
                // the same way a natural exit does, or they keep believing a
                // dead stream is live. Exactly one Exit per subscriber,
                // queued behind any not-yet-delivered output; a subscriber
                // that is still lagging is disconnected so it observes EOF.
                if let Some(fanout) = &killed_fanout {
                    fanout.state.lock().await.deliver_final(&exit_evt);
                }
                recovery_manager.end_session(&session_id).await;
            }
            drop(killed_fanout);
            terminal_emulator_clients.lock().await.remove(&session_id);
            session_sizes.lock().await.remove(&session_id);
            // Every id-keyed registry is now clear and the Exit is published:
            // a replacement may install after this lifecycle guard releases.
            sessions.lock().await.end_teardown(&session_id);
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) => error_event(None, e.to_string()),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::List => {
            let handles = sessions.lock().await.handles();
            let mut sessions_list = Vec::with_capacity(handles.len());
            let mut immutable_run_ownership = true;
            for (id, session) in handles {
                // ShellModal sessions are user-owned terminals, not task
                // processes. They intentionally have no stage-run owner and
                // must not downgrade task process ownership negotiation.
                if !id.starts_with("shell-") {
                    immutable_run_ownership &= session.run_id().await.is_some();
                }
                sessions_list.push(session.info(id).await);
            }
            sessions_list.extend(agent_runtime::agent_session_infos(&agent_sessions).await);
            immutable_run_ownership &= agent_sessions
                .lock()
                .await
                .values()
                .all(|record| record.run_id.is_some());
            let mut capabilities = protocol::DaemonCapabilities::current();
            capabilities.immutable_run_ownership = immutable_run_ownership;
            let evt = Event::SessionList {
                sessions: sessions_list,
                capabilities: Some(capabilities),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Snapshot { session_id } => {
            let live_snapshot = {
                match session_handle(&sessions, &session_id).await {
                    Some(session) => Some(session.snapshot(&session_id).await),
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
            let evt = match recovery_manager.seed_snapshot_for_next_start(
                &session_id,
                &SeededRecoverySnapshot {
                    serialized: snapshot.vt,
                    cols: snapshot.cols,
                    rows: snapshot.rows,
                    cursor_row: snapshot.cursor_row,
                    cursor_col: snapshot.cursor_col,
                    cursor_visible: snapshot.cursor_visible,
                    saved_at: snapshot.saved_at,
                    sequence: snapshot.sequence,
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

        Command::Subscribe | Command::SubscribeEvents { .. } => {
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::Observe { .. } | Command::ObserveSnapshot { .. } | Command::Unobserve { .. } => {
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

#[cfg(test)]
mod codex_discovery_tests {
    use super::{poll_codex_discovery, CodexDiscoveryPoll};
    use crate::session::CodexDiscoveryCancellation;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn no_metadata_discovery_has_bounded_scans_and_prompt_cancellation() {
        let scans = Arc::new(AtomicUsize::new(0));
        let scans_for_poll = Arc::clone(&scans);
        let result = poll_codex_discovery(
            CodexDiscoveryCancellation::default(),
            Duration::from_millis(45),
            Duration::from_millis(5),
            Duration::from_millis(20),
            move || {
                scans_for_poll.fetch_add(1, Ordering::SeqCst);
                async { CodexDiscoveryPoll::Pending }
            },
        )
        .await;
        assert_eq!(result, None);
        assert!(
            (1..=5).contains(&scans.load(Ordering::SeqCst)),
            "deadline/backoff must bound metadata scans, got {}",
            scans.load(Ordering::SeqCst)
        );

        let cancellation = CodexDiscoveryCancellation::default();
        let cancellation_for_poll = cancellation.clone();
        let scans = Arc::new(AtomicUsize::new(0));
        let scans_for_poll = Arc::clone(&scans);
        let prompt = tokio::spawn(async move {
            poll_codex_discovery(
                cancellation_for_poll,
                Duration::from_secs(30),
                Duration::from_secs(5),
                Duration::from_secs(5),
                move || {
                    scans_for_poll.fetch_add(1, Ordering::SeqCst);
                    async {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        CodexDiscoveryPoll::Pending
                    }
                },
            )
            .await
        });
        while scans.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        cancellation.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), prompt)
                .await
                .expect("cancelled discovery prompt must tear down promptly")
                .unwrap(),
            None
        );
    }
}
