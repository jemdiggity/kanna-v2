use std::os::fd::AsRawFd;
use std::sync::Arc;

use kanna_daemon::{
    protocol::{self, Command, Event},
    recovery::{RecoveryManager, SeededRecoverySnapshot},
};
use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, Mutex};

use crate::client::{
    cleanup_client_writer_registries, effective_terminal_size, finish_attach_cutover,
    replay_current_status, unregister_terminal_emulator_client, LostHandoffSessions,
    SessionObservers, SessionSizes, SessionWriters, TerminalEmulatorClients,
};
use crate::handoff::{blank_snapshot, handle_handoff};
use crate::output::stream_output;
use crate::paths::daemon_data_dir;
use crate::session::{SessionHandle, SessionManager, SessionRecord, StreamControl};
use crate::socket::{read_command, write_event};
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
                if subscription_task.is_none() {
                    let mut broadcast_rx = broadcast_tx.subscribe();
                    let writer_broadcast = writer.clone();
                    subscription_task = Some(tokio::spawn(async move {
                        use tokio::io::AsyncWriteExt;
                        while let Ok(msg) = broadcast_rx.recv().await {
                            let mut w = writer_broadcast.lock().await;
                            if w.write_all(msg.as_bytes()).await.is_err()
                                || w.write_all(b"\n").await.is_err()
                                || w.flush().await.is_err()
                            {
                                break;
                            }
                        }
                    }));
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

    if let Some(task) = subscription_task {
        task.abort();
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
pub(crate) async fn handle_command(
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
            let result = match &session {
                Some(session) => session.kill().await,
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("session not found: {}", session_id),
                )),
            };
            let success = result.is_ok();
            if success {
                sessions.lock().await.remove(&session_id);
                // A kill removes the session from the map, so the output
                // reader's exit cleanup is skipped ("current session changed")
                // and would never announce the death. Announce it here —
                // before replying — so every session termination broadcasts
                // exactly one Exit, and a kill-then-respawn of the same
                // session id always orders Exit before the new
                // SessionCreated. `killed` marks it as an orchestrated kill,
                // not the agent finishing.
                let exit_evt = Event::Exit {
                    session_id: session_id.clone(),
                    code: 128 + libc::SIGKILL,
                    resume_session_id: match &session {
                        Some(session) => {
                            session.codex_resume_session_id().await.unwrap_or_default()
                        }
                        None => None,
                    },
                    killed: true,
                };
                if let Ok(json) = serde_json::to_string(&exit_evt) {
                    let _ = broadcast_tx.send(json);
                }
                if let Some(writers) = session_writers.lock().await.get(&session_id) {
                    for w in writers.iter() {
                        let _ = write_event(&mut *w.lock().await, &exit_evt).await;
                    }
                }
                if let Some(observers) = session_observers.lock().await.get(&session_id) {
                    for obs in observers.iter() {
                        let _ = write_event(&mut *obs.lock().await, &exit_evt).await;
                    }
                }
            }
            let killed_writers = session_writers.lock().await.remove(&session_id);
            terminal_emulator_clients.lock().await.remove(&session_id);
            session_sizes.lock().await.remove(&session_id);
            let killed_observers = session_observers.lock().await.remove(&session_id);
            if success {
                // A killed session must reach attached clients the same way a
                // natural exit does, or they keep believing a dead stream is
                // live (the killed session's reader skips its exit broadcast
                // because the session is already gone from the manager).
                // Deliberately per-writer, not on the Subscribe broadcast:
                // subscribers (e.g. completion notify) must not see engine
                // kills as task completion.
                let exit_evt = Event::Exit {
                    session_id: session_id.clone(),
                    code: 128 + libc::SIGKILL,
                    resume_session_id: None,
                    killed: true,
                };
                for client in killed_writers
                    .into_iter()
                    .flatten()
                    .chain(killed_observers.into_iter().flatten())
                {
                    let _ = write_event(&mut *client.lock().await, &exit_evt).await;
                }
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
