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
    cleanup_client_writer_registries, effective_terminal_size, register_terminal_emulator_client,
    unregister_terminal_emulator_client, LostHandoffSessions, SessionSizes,
    TerminalEmulatorClients,
};
use crate::daemon_lifecycle::{DaemonLifecycle, DaemonLifecycleState};
use crate::fanout::{
    existing_session_fanout, session_fanout, SessionFanout, SessionFanouts, SubscriberKind,
};
use crate::handoff::{blank_snapshot, handle_handoff};
use crate::operator_auth::OperatorAuthorizer;
use crate::output::{handle_output_chunk, stream_output};
use crate::paths::daemon_data_dir;
use crate::session::{
    pty_occupancy_snapshot, LogicalInputAccepted, RawInputKind, SessionHandle, SessionManager,
    SessionRecord, StreamControl, WriteOutcome,
};
use crate::socket::{read_command, write_event};
use crate::successor_auth::SuccessorAuthorizer;
use crate::util::{error_event, recovery_snapshot_to_terminal_snapshot};
use crate::{agent_runtime, headless_terminal, pty};

/// The whole unblock story, in the one line the caller actually reads.
///
/// The old wording ("retry after explicit terminal submission") described the
/// daemon's internal rule rather than what anyone should do about it, and the
/// only way to satisfy it was for a human to type into another agent's
/// terminal. Attestation has already failed by the time this is written, so
/// what is left really is a human decision about text on that screen.
fn inherited_draft_state_unknown_message(session_id: &str) -> String {
    format!(
        "logical input refused for session {session_id}: this daemon inherited the session and \
         its composer holds text it never saw typed, so submitting would append to someone \
         else's unsent line; open that session's terminal and submit or clear the line. An empty \
         composer unblocks itself with no human."
    )
}

/// Why a logical message is sitting in the queue instead of at the prompt.
///
/// Named separately from the inherited-draft refusal because the fix is
/// different: nothing is wrong with this daemon's knowledge, a human simply
/// has an unsent line open at that terminal, and the message goes out the
/// moment they submit it.
fn logical_input_held_by_draft_message(session_id: &str) -> String {
    format!(
        "logical input for session {session_id} was not submitted: a human has an unsent line at \
         that terminal, and appending to it would submit a sentence nobody wrote. The message is \
         queued and will be written when that terminal submits — do not send it again."
    )
}

/// Deliver one logical message, resolving withheld draft state from the
/// terminal first when the frame proves the composer is empty.
///
/// Both reasons a message is withheld — an inherited state this daemon never
/// observed, and a declared draft no producer can un-declare — are answered by
/// the same evidence, so both consult attestation before the message is
/// refused or parked. Attestation runs only on those paths: a session with a
/// known-idle draft state pays nothing for it.
async fn enqueue_logical_input_with_attestation(
    session: &Arc<SessionHandle>,
    data: Vec<u8>,
) -> Result<LogicalInputAccepted, crate::session::InputQueueError> {
    let first = session.enqueue_logical_input(data.clone());
    let withheld = match &first {
        Err(crate::session::InputQueueError::InheritedDraftStateUnknown) => true,
        Ok(accepted) => accepted.held_by_raw_draft,
        Err(_) => false,
    };
    if !withheld {
        return first;
    }
    match session.attest_empty_composer().await {
        Ok(true) => match first {
            // Attestation dispatched the message this call already queued,
            // carrying its own acknowledgement. Queuing it again would write
            // it twice.
            Ok(accepted) => Ok(LogicalInputAccepted {
                written: accepted.written,
                held_by_raw_draft: false,
            }),
            // The refusal happened before the message reached the queue, so it
            // still has to be submitted.
            Err(_) => session.enqueue_logical_input(data),
        },
        Ok(false) => first,
        Err(error) => {
            log::warn!("[input] composer attestation failed: {error}");
            first
        }
    }
}

/// Answer one `SubmitInput`, waiting for the terminating Enter to reach the
/// PTY before calling the message submitted.
async fn logical_input_event(
    session: &Arc<SessionHandle>,
    session_id: &str,
    data: Vec<u8>,
) -> Event {
    let accepted = match enqueue_logical_input_with_attestation(session, data).await {
        Ok(accepted) => accepted,
        Err(crate::session::InputQueueError::InheritedDraftStateUnknown) => {
            return error_event(
                Some(protocol::ErrorCode::InheritedDraftStateUnknown),
                inherited_draft_state_unknown_message(session_id),
            )
        }
        Err(_) => {
            return error_event(
                Some(protocol::ErrorCode::WriteFailed),
                format!("input queue closed for session: {session_id}"),
            )
        }
    };
    if accepted.held_by_raw_draft {
        return error_event(
            Some(protocol::ErrorCode::LogicalInputHeldByDraft),
            logical_input_held_by_draft_message(session_id),
        );
    }
    match accepted.written.await {
        Ok(WriteOutcome::Written) => Event::Ok,
        Ok(WriteOutcome::SubmissionUnproven) => error_event(
            Some(protocol::ErrorCode::LogicalInputSubmissionUnproven),
            format!(
                "logical input for session {session_id} reached the terminal but its submission \
                 could not be proven: the terminal never settled after the message, so no Enter \
                 was written and the text is parked at that composer. Do not retry it; a human \
                 at that terminal decides what happens to it"
            ),
        ),
        Ok(WriteOutcome::NotWritten) => error_event(
            Some(protocol::ErrorCode::InheritedDraftStateUnknown),
            inherited_draft_state_unknown_message(session_id),
        ),
        Err(_) => error_event(
            Some(protocol::ErrorCode::WriteFailed),
            format!(
                "logical input for session {session_id} was accepted but its terminal writer \
                 ended before the message was submitted; inspect that terminal before retrying"
            ),
        ),
    }
}

async fn session_handle(
    sessions: &Arc<Mutex<SessionManager>>,
    session_id: &str,
) -> Option<Arc<SessionHandle>> {
    sessions.lock().await.get(session_id)
}

async fn registration_is_current(
    sessions: &Arc<Mutex<SessionManager>>,
    fanouts: &SessionFanouts,
    session_id: &str,
    session: &Arc<SessionHandle>,
    fanout: &Arc<SessionFanout>,
) -> bool {
    if !sessions.lock().await.is_current(session_id, session) {
        return false;
    }
    existing_session_fanout(fanouts, session_id)
        .await
        .is_some_and(|current| Arc::ptr_eq(&current, fanout))
}

async fn test_pause_from_env(variable: &str, message: String) {
    let Some(milliseconds) = std::env::var(variable)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    else {
        return;
    };
    log::info!("{message}");
    tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
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
    daemon_lifecycle: DaemonLifecycle,
    successor_authorizer: Arc<SuccessorAuthorizer>,
    operator_authorizer: Arc<OperatorAuthorizer>,
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
                    daemon_lifecycle.clone(),
                    successor_authorizer.clone(),
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
            Some(Command::AdoptOperator) => {
                let event = match operator_authorizer.authorize(raw_fd, true) {
                    Ok(()) => Event::Ok,
                    Err(message) => {
                        error_event(Some(protocol::ErrorCode::InputUnauthorized), message)
                    }
                };
                let _ = write_event(&mut *writer.lock().await, &event).await;
            }
            Some(Command::AuthorizeServer { pid }) => {
                let event = match operator_authorizer.authorize_server_process(raw_fd, pid) {
                    Ok(()) => Event::Ok,
                    Err(message) => {
                        error_event(Some(protocol::ErrorCode::InputUnauthorized), message)
                    }
                };
                let _ = write_event(&mut *writer.lock().await, &event).await;
            }
            Some(Command::NegotiateProtectedInput { version }) => {
                let event = match operator_authorizer
                    .negotiate_protected_input(raw_fd, version)
                    .await
                {
                    // Negotiation authenticates this server generation, but
                    // deliberately does not alter any session. A legacy PTY
                    // remains fail-closed until its own ClassifyInput command
                    // succeeds.
                    Ok(()) => Event::ProtectedInputReady { version },
                    Err(message) => error_event(
                        Some(protocol::ErrorCode::ProtectedInputProtocolRequired),
                        message,
                    ),
                };
                let _ = write_event(&mut *writer.lock().await, &event).await;
            }
            Some(Command::NegotiateRawInput { version }) => {
                // A pure capability answer: it authorizes nothing and touches
                // no session, so the caller may treat any failure as proof
                // that no byte reached a PTY.
                let event = if version == protocol::RAW_INPUT_PROTOCOL_VERSION {
                    Event::RawInputReady { version }
                } else {
                    error_event(
                        None,
                        format!(
                            "unsupported raw-input protocol {version}; this daemon speaks {}",
                            protocol::RAW_INPUT_PROTOCOL_VERSION
                        ),
                    )
                };
                let _ = write_event(&mut *writer.lock().await, &event).await;
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
                let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
                let _lifecycle_guard = lifecycle.lock().await;
                test_pause_from_env(
                    "KANNA_DAEMON_TEST_REGISTRATION_PAUSE_MS",
                    format!("[registration-test-pause] operation=observe session={session_id}"),
                )
                .await;
                let Some(session) = session_handle(&sessions, &session_id).await else {
                    let evt = error_event(
                        Some(protocol::ErrorCode::SessionNotFound),
                        format!("session not found: {}", session_id),
                    );
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    continue;
                };
                let fanout = session_fanout(&fanouts, &session_id).await;
                let mut fanout_state = fanout.state.lock().await;
                if !registration_is_current(&sessions, &fanouts, &session_id, &session, &fanout)
                    .await
                {
                    let evt = error_event(
                        Some(protocol::ErrorCode::SessionNotFound),
                        format!("session incarnation changed: {}", session_id),
                    );
                    drop(fanout_state);
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    continue;
                }
                fanout_state.register(&session_id, SubscriberKind::Observer, &writer, &[]);
                drop(fanout_state);
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(Command::ObserveSnapshot { session_id }) => {
                let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
                let _lifecycle_guard = lifecycle.lock().await;
                test_pause_from_env(
                    "KANNA_DAEMON_TEST_REGISTRATION_PAUSE_MS",
                    format!(
                        "[registration-test-pause] operation=observe_snapshot session={session_id}"
                    ),
                )
                .await;
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
                if !registration_is_current(&sessions, &fanouts, &session_id, &session, &fanout)
                    .await
                {
                    let evt = error_event(
                        Some(protocol::ErrorCode::SessionNotFound),
                        format!("session incarnation changed: {}", session_id),
                    );
                    drop(fanout_state);
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    continue;
                }
                fanout_state.register(
                    &session_id,
                    SubscriberKind::Observer,
                    &writer,
                    &[Event::Snapshot {
                        session_id: session_id.clone(),
                        snapshot,
                        agent_provider: session.agent_provider().await,
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
                    daemon_lifecycle.clone(),
                    raw_fd,
                    operator_authorizer.clone(),
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
    daemon_lifecycle: DaemonLifecycle,
    raw_fd: std::os::fd::RawFd,
    operator_authorizer: Arc<OperatorAuthorizer>,
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
            operator_input_only,
        } => {
            if let Err(message) = operator_authorizer.authorize_spawn(raw_fd) {
                let evt = error_event(
                    Some(protocol::ErrorCode::ProtectedInputProtocolRequired),
                    format!("protected-input negotiation required before PTY spawn: {message}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            // A PTY id also reaches the recovery snapshot path. Reject before
            // any lock -- an unsafe id is invalid whatever the daemon's
            // lifecycle state, and "retry against the adopting daemon" would be
            // the wrong answer for it.
            if !kanna_daemon::session_id::is_safe(&session_id) {
                log::warn!("[spawn] rejecting unsafe session id {session_id:?}");
                let evt = error_event(
                    Some(protocol::ErrorCode::PtySpawnFailed),
                    format!("invalid session id: {session_id:?}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; retry against the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
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
                        headless_terminal,
                        stream_control: Some(stream_control.clone()),
                        agent_provider,
                        status: headless_terminal::initial_session_status(agent_provider),
                        status_observed: false,
                        last_status_check_at: None,
                        operator_input_only,
                        input_policy_classified: true,
                        raw_input_draft_active: false,
                        raw_input_draft_state_known: true,
                        // A session this daemon spawns is attested from its
                        // first byte: nothing has been typed into it yet, and
                        // every keystroke from here is counted.
                        typed_draft_bytes: Some(0),
                        pending_logical_inputs: Vec::new(),
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
                    let daemon_lifecycle_for_stream = daemon_lifecycle.clone();
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
                            daemon_lifecycle_for_stream,
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
                    if pty::is_pty_exhaustion_error(e.as_ref()) {
                        let occupancy = pty_occupancy_snapshot(&sessions).await;
                        log::error!(
                            "[pty-exhaustion] failed_session={} daemon_pid={} error={} {}",
                            session_id,
                            std::process::id(),
                            e,
                            occupancy
                        );
                    }
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

        command @ (Command::Input { .. }
        | Command::InputBoundary { .. }
        | Command::InputControl { .. }) => {
            let (session_id, data, kind) = match command {
                Command::Input { session_id, data } => (session_id, data, RawInputKind::Draft),
                Command::InputBoundary { session_id, data } => {
                    (session_id, data, RawInputKind::Submission)
                }
                Command::InputControl { session_id, data } => {
                    (session_id, data, RawInputKind::Control)
                }
                _ => unreachable!("input command pattern already matched"),
            };
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; send input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };

            if session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("session requires authenticated operator input: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            let evt = match session.enqueue_acknowledged_raw_input(data, kind) {
                Ok(written) => match written.await {
                    Ok(_) => Event::Ok,
                    Err(_) => error_event(
                        Some(protocol::ErrorCode::WriteFailed),
                        format!("input write failed for session: {}", session_id),
                    ),
                },
                Err(_) => error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {}", session_id),
                ),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        command @ (Command::InputIfSession { .. } | Command::RawInputIfSession { .. }) => {
            let (session_id, expected_pid, data, kind) = match command {
                Command::InputIfSession {
                    session_id,
                    expected_pid,
                    data,
                } => (session_id, expected_pid, data, RawInputKind::Draft),
                Command::RawInputIfSession {
                    session_id,
                    expected_pid,
                    data,
                    class,
                } => (
                    session_id,
                    expected_pid,
                    data,
                    match class {
                        protocol::RawInputClass::Draft => RawInputKind::Draft,
                        protocol::RawInputClass::Submission => RawInputKind::Submission,
                        protocol::RawInputClass::Control => RawInputKind::Control,
                    },
                ),
                _ => unreachable!("fenced input command pattern already matched"),
            };
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; send input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };

            let actual_pid = session.pty.lock().await.pid();
            if actual_pid != expected_pid {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionIncarnationMismatch),
                    format!(
                        "session incarnation changed for {session_id}: expected pid {expected_pid}, found {actual_pid}"
                    ),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            if session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("session requires authenticated operator input: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            let evt = match session.enqueue_acknowledged_raw_input(data, kind) {
                Ok(written) => match written.await {
                    Ok(_) => Event::Ok,
                    Err(_) => error_event(
                        Some(protocol::ErrorCode::WriteFailed),
                        format!("input write failed for session: {session_id}"),
                    ),
                },
                Err(_) => error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {session_id}"),
                ),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::SubmitInput { session_id, data } => {
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; submit input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };
            if session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("session requires authenticated operator input: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let evt = logical_input_event(&session, &session_id, data).await;
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::SubmitInputIfSession {
            session_id,
            expected_pid,
            data,
        } => {
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; submit input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };
            let actual_pid = session.pty.lock().await.pid();
            if actual_pid != expected_pid {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionIncarnationMismatch),
                    format!(
                        "session incarnation changed for {session_id}: expected pid {expected_pid}, found {actual_pid}"
                    ),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            if session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("session requires authenticated operator input: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let evt = logical_input_event(&session, &session_id, data).await;
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        command @ (Command::InputNoReply { .. }
        | Command::InputBoundaryNoReply { .. }
        | Command::InputControlNoReply { .. }) => {
            let (session_id, data, kind) = match command {
                Command::InputNoReply { session_id, data } => {
                    (session_id, data, RawInputKind::Draft)
                }
                Command::InputBoundaryNoReply { session_id, data } => {
                    (session_id, data, RawInputKind::Submission)
                }
                Command::InputControlNoReply { session_id, data } => {
                    (session_id, data, RawInputKind::Control)
                }
                _ => unreachable!("input command pattern already matched"),
            };
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; send input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };

            if session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("session requires authenticated operator input: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            if session.enqueue_raw_input(data, kind).is_err() {
                let evt = error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {}", session_id),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
            }
        }

        Command::OperatorInput { session_id, data } => {
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; send input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            if let Err(message) = operator_authorizer.authorize(raw_fd, false) {
                let evt = error_event(Some(protocol::ErrorCode::InputUnauthorized), message);
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };
            if !session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("operator input is not enabled for session: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let evt = match session.enqueue_acknowledged_raw_input(data, RawInputKind::Draft) {
                Ok(written) => match written.await {
                    Ok(_) => Event::Ok,
                    Err(_) => error_event(
                        Some(protocol::ErrorCode::WriteFailed),
                        format!("input write failed for session: {session_id}"),
                    ),
                },
                Err(_) => error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {session_id}"),
                ),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::SystemInput { session_id, data } => {
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; send input to the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            if let Err(message) = operator_authorizer.authorize_system_input(raw_fd) {
                let evt = error_event(Some(protocol::ErrorCode::InputUnauthorized), message);
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };
            if !session.operator_input_only().await {
                let evt = error_event(
                    Some(protocol::ErrorCode::InputUnauthorized),
                    format!("system input is not enabled for session: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let evt = match session.enqueue_acknowledged_raw_input(data, RawInputKind::Draft) {
                Ok(written) => match written.await {
                    Ok(_) => Event::Ok,
                    Err(_) => error_event(
                        Some(protocol::ErrorCode::WriteFailed),
                        format!("input write failed for session: {session_id}"),
                    ),
                },
                Err(_) => error_event(
                    Some(protocol::ErrorCode::WriteFailed),
                    format!("input queue closed for session: {session_id}"),
                ),
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::ClassifyInput {
            session_id,
            operator_input_only,
        } => {
            if let Err(message) = operator_authorizer.authorize_system_input(raw_fd) {
                let evt = error_event(Some(protocol::ErrorCode::InputUnauthorized), message);
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; reclassify on the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
            let _lifecycle_guard = lifecycle.lock().await;
            let Some(session) = session_handle(&sessions, &session_id).await else {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session not found: {session_id}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            };
            session.classify_input(operator_input_only).await;
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::AttachSnapshot {
            session_id,
            emulate_terminal,
        } => {
            log::info!("[attach_snapshot] session={}", session_id);
            let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
            let _lifecycle_guard = lifecycle.lock().await;
            test_pause_from_env(
                "KANNA_DAEMON_TEST_REGISTRATION_PAUSE_MS",
                format!("[registration-test-pause] operation=attach_snapshot session={session_id}"),
            )
            .await;
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
                        daemon_lifecycle.clone(),
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
            if !registration_is_current(&sessions, &fanouts, &session_id, &session, &fanout).await {
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("session incarnation changed: {}", session_id),
                );
                drop(fanout_state);
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let initial_events = [
                Event::Snapshot {
                    session_id: session_id.clone(),
                    snapshot,
                    agent_provider: session.agent_provider().await,
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

        Command::Kill { session_id } => {
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; retry against the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
            let _lifecycle_guard = lifecycle.lock().await;
            log::info!("[kill] session={}", session_id);
            // Fence Kill with the handoff transaction: the snapshot has
            // already been taken and sent, so removing the session here would
            // let the successor resurrect it from that snapshot. Refuse and
            // let the client retry against the new daemon.
            if session_handle(&sessions, &session_id).await.is_none() {
                match agent_runtime::kill_agent_session(&session_id, &agent_sessions, &broadcast_tx)
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
                            Some(protocol::ErrorCode::RetryOnSuccessor),
                            format!(
                                "daemon handoff in progress; retry killing session {session_id} against the new daemon"
                            ),
                        );
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                    // Not an agent session — fall through to the PTY registry.
                    agent_runtime::AgentKillOutcome::NotFound => {}
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
                        Some(protocol::ErrorCode::RetryOnSuccessor),
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
                // A killed session must reach attached clients and observers
                // the same way a natural exit does, or they keep believing a
                // dead stream is live. Exactly one Exit per subscriber,
                // queued behind any not-yet-delivered output; a subscriber
                // that is still lagging is disconnected so it observes EOF.
                if let Some(fanout) = &killed_fanout {
                    fanout.state.lock().await.deliver_final(&exit_evt);
                }
                test_pause_from_env(
                    "KANNA_DAEMON_TEST_KILL_AFTER_EXIT_PAUSE_MS",
                    format!("[kill-test-pause] session={session_id}"),
                )
                .await;
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
            // A live-session miss falls through to a persisted snapshot read.
            if !kanna_daemon::session_id::is_safe(&session_id) {
                log::warn!("[snapshot] rejecting unsafe session id {session_id:?}");
                let evt = error_event(
                    Some(protocol::ErrorCode::SessionNotFound),
                    format!("invalid session id: {session_id:?}"),
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            let live_snapshot = {
                match session_handle(&sessions, &session_id).await {
                    Some(session) => Some((
                        session.snapshot(&session_id).await,
                        session.agent_provider().await,
                    )),
                    None => None,
                }
            };
            let evt = match live_snapshot {
                Some((Ok(snapshot), agent_provider)) => {
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
                        agent_provider,
                    }
                }
                Some((Err(error), _)) => error_event(
                    None,
                    format!("failed to snapshot live session {}: {}", session_id, error),
                ),
                None => match recovery_manager.get_snapshot(&session_id).await {
                    Ok(Some(snapshot)) => {
                        log::info!(
                            "[snapshot] session={} served from recovery rows={} cols={} cursor=({:?}, {:?}) visible={:?} vt_len={}",
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
                            agent_provider: None,
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
            if !kanna_daemon::session_id::is_safe(&session_id) {
                log::warn!("[seed-snapshot] rejecting unsafe session id {session_id:?}");
                let evt = error_event(None, format!("invalid session id: {session_id:?}"));
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

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

        Command::Subscribe => {
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::Observe { .. } | Command::ObserveSnapshot { .. } | Command::Unobserve { .. } => {
            // Handled in handle_connection before dispatch
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::SpawnAgent { session_id, params } => {
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; retry against the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            agent_runtime::handle_spawn_agent(
                session_id,
                params,
                writer,
                broadcast_tx,
                agent_sessions,
                daemon_data_dir(),
                daemon_lifecycle.clone(),
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
            let daemon_lifecycle_guard = daemon_lifecycle.read().await;
            if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
                let evt = error_event(
                    Some(protocol::ErrorCode::RetryOnSuccessor),
                    "daemon handoff already committed; retry against the adopting daemon",
                );
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }
            agent_runtime::handle_agent_input(
                session_id,
                text,
                writer,
                broadcast_tx,
                agent_sessions,
                daemon_lifecycle.clone(),
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

        Command::AdoptOperator
        | Command::AuthorizeServer { .. }
        | Command::NegotiateProtectedInput { .. }
        | Command::NegotiateRawInput { .. } => {
            let event = error_event(None, "unexpected nested authority command");
            let _ = write_event(&mut *writer.lock().await, &event).await;
        }
    }
}
