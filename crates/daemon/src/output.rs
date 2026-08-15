use std::collections::VecDeque;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::time::{Duration, Instant};

use kanna_daemon::{
    protocol::{self, Event, SessionStatus},
    recovery::RecoveryManager,
    terminal_perf::{self, TerminalPerfContext, OUTPUT_GAP_THRESHOLD, STALL_THRESHOLD},
};
use tokio::io::unix::AsyncFd;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::client::{SessionSizes, TerminalEmulatorClients};
use crate::daemon_lifecycle::{DaemonLifecycle, DaemonLifecycleState};
use crate::fanout::{
    existing_session_fanout, session_fanout, EnqueueReport, EventLine, SessionFanout,
    SessionFanouts,
};
use crate::session::{
    MirrorResult, PendingInput, PendingInputKind, SessionHandle, SessionManager, StreamControl,
    LOGICAL_INPUT_SUBMIT_DELAY_MS, STATUS_DETECTION_THROTTLE_MS,
};

const STATUS_IDLE_FLUSH_MS: u64 = STATUS_DETECTION_THROTTLE_MS;
const STAGE_MIRROR_OUTPUT: &str = "mirror_output";
const STAGE_DETECT_STATUS: &str = "detect_status";
const STAGE_RECOVERY_WRITE: &str = "recovery_write";

fn schedule_lag_recovery_retry(fanout: Arc<SessionFanout>) {
    if fanout
        .recovery_retry_scheduled
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(STATUS_IDLE_FLUSH_MS)).await;
        fanout
            .recovery_retry_scheduled
            .store(false, std::sync::atomic::Ordering::Release);
        fanout.recovery_notify.notify_one();
    });
}

// `attached_writer` and `observer_write` are emitted by the per-subscriber
// writer tasks in `fanout.rs`; they no longer run inside the ingestion loop.
#[cfg(test)]
pub(crate) const DAEMON_TERMINAL_PERF_STAGES: [&str; 7] = [
    STAGE_MIRROR_OUTPUT,
    STAGE_DETECT_STATUS,
    "attached_writer",
    STAGE_RECOVERY_WRITE,
    "observer_write",
    "snapshot_lock",
    "snapshot_serialize",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DaemonOutputGapCause {
    PriorStage(&'static str),
    PtySourceSilence,
}

pub(crate) fn classify_output_gap(
    previous_read_at: Option<Instant>,
    read_at: Instant,
    previous_slow_stage: Option<&'static str>,
) -> Option<(Duration, DaemonOutputGapCause)> {
    let duration = read_at.saturating_duration_since(previous_read_at?);
    if duration < OUTPUT_GAP_THRESHOLD {
        return None;
    }
    Some((
        duration,
        previous_slow_stage
            .map(DaemonOutputGapCause::PriorStage)
            .unwrap_or(DaemonOutputGapCause::PtySourceSilence),
    ))
}

fn perf_context(
    session_id: &str,
    stage: &'static str,
    chunk: u64,
    bytes: usize,
) -> TerminalPerfContext {
    let mut context = TerminalPerfContext::new("daemon", session_id, stage);
    context.chunk = chunk;
    context.bytes = bytes;
    context
}

fn note_slow_stage(
    started_at: Instant,
    stage: &'static str,
    previous_slow_stage: &mut Option<&'static str>,
) {
    if started_at.elapsed() >= STALL_THRESHOLD && previous_slow_stage.is_none() {
        *previous_slow_stage = Some(stage);
    }
}

pub(crate) fn should_mirror_output_to_recovery(_has_live_terminal_client: bool) -> bool {
    true
}

#[cfg(test)]
pub(crate) fn should_rebuild_recovery_session_on_live_terminal_transition() -> bool {
    false
}

/// Runs for the entire lifetime of a session. One task owns both PTY reads and
/// PTY writes so input cannot block output delivery.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stream_output(
    session_id: String,
    io_fd: std::os::fd::OwnedFd,
    mut input_rx: mpsc::UnboundedReceiver<PendingInput>,
    stream_control: StreamControl,
    broadcast_tx: broadcast::Sender<String>,
    fanouts: SessionFanouts,
    terminal_emulator_clients: TerminalEmulatorClients,
    sessions: Arc<Mutex<SessionManager>>,
    session_sizes: SessionSizes,
    recovery_manager: RecoveryManager,
    daemon_lifecycle: DaemonLifecycle,
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
    let mut previous_read_at = None;
    let mut previous_slow_stage = None;
    let mut pending_input: VecDeque<PendingInput> = VecDeque::new();
    let mut pending_offset = 0usize;
    let mut logical_submit_at: Option<Instant> = None;
    let mut status_interval =
        tokio::time::interval(std::time::Duration::from_millis(STATUS_IDLE_FLUSH_MS));
    let session_fanout = session_fanout(&fanouts, &session_id).await;
    log::info!("[stream] start session={}", session_id);

    #[cfg(debug_assertions)]
    if let Some(delay_ms) = std::env::var("KANNA_TEST_PTY_INPUT_READER_PAUSE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|delay_ms| *delay_ms > 0)
    {
        log::warn!(
            "[stream] TEST HOOK: pausing PTY input reader session={} delay_ms={}",
            session_id,
            delay_ms
        );
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }

    loop {
        if stream_control.stop_requested() || session.is_retired() {
            log::info!("[stream] stopped retired reader session={}", session_id);
            stream_control.mark_stopped();
            return;
        }
        if stream_control.quiesce_requested() {
            while let Ok(input) = input_rx.try_recv() {
                if input.data.is_empty() && input.kind == PendingInputKind::Raw {
                    input.acknowledge_written();
                } else {
                    pending_input.push_back(input);
                }
            }
        }
        if stream_control.quiesce_requested() && pending_input.is_empty() {
            stream_control.mark_quiesced();
            while stream_control.quiesce_requested() {
                if stream_control.stop_requested() || session.is_retired() {
                    log::info!("[stream] stopped quiesced reader session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
                stream_control.wait_for_state_change().await;
            }
            stream_control.mark_resumed();
            continue;
        }

        tokio::select! {
            biased;

            maybe_input = input_rx.recv(), if !stream_control.quiesce_requested() => {
                if let Some(input) = maybe_input {
                    if input.data.is_empty() && input.kind == PendingInputKind::Raw {
                        input.acknowledge_written();
                    } else {
                        pending_input.push_back(input);
                    }
                }
            }

            _ = tokio::time::sleep_until(
                logical_submit_at.unwrap_or_else(Instant::now).into()
            ), if logical_submit_at.is_some() => {
                logical_submit_at = None;
            }

            writable = async_fd.writable(), if !pending_input.is_empty() && logical_submit_at.is_none() => {
                let Ok(mut guard) = writable else {
                    log::error!("[stream] writable readiness failed session={}", session_id);
                    break;
                };
                if stream_control.stop_requested() || session.is_retired() {
                    log::info!("[stream] stopped retired reader session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
                let Some(front) = pending_input.front() else {
                    continue;
                };
                let result = guard.try_io(|inner| {
                    let fd = inner.get_ref().as_raw_fd();
                    let slice = &front.data[pending_offset..];
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
                        if pending_offset >= front.data.len() {
                            let advanced_to_enter = pending_input
                                .front_mut()
                                .is_some_and(PendingInput::advance_logical_message_to_enter);
                            if advanced_to_enter {
                                pending_offset = 0;
                                logical_submit_at = Some(
                                    Instant::now()
                                        + Duration::from_millis(LOGICAL_INPUT_SUBMIT_DELAY_MS),
                                );
                            } else {
                                let completed = pending_input
                                    .pop_front()
                                    .expect("pending input disappeared before completion");
                                if completed.kind == PendingInputKind::LogicalEnter
                                    && session.complete_logical_input().is_err()
                                {
                                    log::error!(
                                        "[stream] logical input coordination failed session={}",
                                        session_id
                                    );
                                    break;
                                }
                                completed.acknowledge_written();
                                pending_offset = 0;
                            }
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
                if stream_control.stop_requested() || session.is_retired() {
                    log::info!("[stream] stopped retired reader session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
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
                        if stream_control.stop_requested() || session.is_retired() {
                            log::info!(
                                "[stream] dropping late chunk from retired reader session={} bytes={}",
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
                        let read_at = Instant::now();
                        chunk_count += 1;
                        if let Some((duration, cause)) =
                            classify_output_gap(previous_read_at, read_at, previous_slow_stage)
                        {
                            let mut context =
                                perf_context(&session_id, "pty_read", chunk_count as u64, n);
                            context.prior_stage = Some(match cause {
                                DaemonOutputGapCause::PriorStage(stage) => stage,
                                DaemonOutputGapCause::PtySourceSilence => "pty_source_silence",
                            });
                            terminal_perf::emit_gap(context, duration);
                        }
                        previous_read_at = Some(read_at);
                        if chunk_count <= 5 {
                            log::info!(
                                "[stream] chunk session={} chunk={} bytes={}",
                                session_id,
                                chunk_count,
                                n
                            );
                        }
                        let data = buf[..n].to_vec();
                        previous_slow_stage = handle_output_chunk(
                            &session_id,
                            &data,
                            chunk_count as u64,
                            &session,
                            &broadcast_tx,
                            &fanouts,
                            &terminal_emulator_clients,
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

            _ = session_fanout.recovery_notify.notified() => {
                if stream_control.stop_requested() || session.is_retired() {
                    log::info!("[stream] stopped retired reader session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
                resync_drained_subscribers(&session_id, &session, &session_fanout).await;
            }

            _ = stream_control.wait_for_state_change() => {}

            _ = status_interval.tick() => {
                if stream_control.stop_requested() || session.is_retired() {
                    log::info!("[stream] stopped retired reader session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
                // A lagged subscriber that finishes draining while the PTY is
                // quiet must not wait for the next chunk to resynchronize.
                if let Some(fanout) = existing_session_fanout(&fanouts, &session_id).await {
                    if fanout.state.lock().await.has_drained_lagged() {
                        resync_drained_subscribers(&session_id, &session, &fanout).await;
                    }
                }
                if stream_control.stop_requested() || session.is_retired() {
                    log::info!("[stream] stopped retired reader session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
                match session
                    .refresh_quiet_status(std::time::Duration::from_millis(STATUS_IDLE_FLUSH_MS))
                    .await
                {
                    Ok(Some(status)) => {
                        if stream_control.stop_requested() || session.is_retired() {
                            log::info!("[stream] stopped retired reader session={}", session_id);
                            stream_control.mark_stopped();
                            return;
                        }
                        log_status_observation(&session, &session_id, "quiet_refresh").await;
                        emit_status_changed(
                            &session,
                            &broadcast_tx,
                            &fanouts,
                            &session_id,
                            status,
                        )
                        .await;
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

    if stream_control.stop_requested()
        || session.is_retired()
        || !session.owns_stream_control(&stream_control).await
    {
        log::info!(
            "[stream] stopped reader skipped exit cleanup session={} chunks={}",
            session_id,
            chunk_count
        );
        stream_control.mark_stopped();
        return;
    }

    // Natural EOF participates in the same per-id lifecycle serialization as
    // Spawn and Kill. Without this guard, removing the old handle opened a
    // window where a replacement could be inserted before the old reader's
    // Exit, recovery teardown, and id-keyed fanout/client cleanup.
    let daemon_lifecycle_guard = daemon_lifecycle.read().await;
    if *daemon_lifecycle_guard != DaemonLifecycleState::Running {
        stream_control.mark_stopped();
        return;
    }
    let lifecycle = sessions.lock().await.lifecycle_lock(&session_id);
    let _lifecycle_guard = lifecycle.lock().await;
    if stream_control.stop_requested()
        || session.is_retired()
        || !session.owns_stream_control(&stream_control).await
    {
        log::info!(
            "[stream] reader retired before serialized exit cleanup session={} chunks={}",
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
    // A child that dies while a handoff transfer is in flight must not have
    // its death published here. The snapshot already captured this session
    // and sent its master fd, so the successor owns it: broadcasting an Exit
    // now would tear down, in every connected client, a session the new
    // daemon is about to serve — and the successor publishes its own Exit for
    // the same death, so clients would see it twice.
    //
    // Park until the transfer resolves rather than dropping the death on the
    // floor. A committed handoff exits this process, so this task dies with
    // it and the successor is left as the single authority. An ABORTED
    // handoff lifts the seal, and cleanup below proceeds normally — with the
    // `Arc::ptr_eq` revalidation covering anything that reused the id while
    // we were parked.
    let sealed = {
        let mgr = sessions.lock().await;
        mgr.is_sealed_for_handoff().then(|| mgr.seal_lifted())
    };
    if let Some(seal_lifted) = sealed {
        log::info!(
            "[stream] session={} exited during a handoff transfer; deferring its Exit to the \
             transfer outcome",
            session_id
        );
        seal_lifted.await;
    }

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
        resume_session_id,
        killed: false,
    };
    if let Ok(json) = serde_json::to_string(&evt) {
        let _ = broadcast_tx.send(json);
    }
    if let Some(delay_ms) = std::env::var("KANNA_DAEMON_TEST_NATURAL_EXIT_FINALIZE_PAUSE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
    recovery_manager.end_session(&session_id).await;
    // Deliver Exit through every subscriber mailbox, then drop the fanout so
    // writer tasks drain their queues and finish. A subscriber that is still
    // lagging is disconnected instead; its client observes EOF, reconnects,
    // and finds the session gone.
    if let Some(fanout) = fanouts.lock().await.remove(&session_id) {
        fanout.state.lock().await.deliver_final(&evt);
    }
    terminal_emulator_clients.lock().await.remove(&session_id);
    session_sizes.lock().await.remove(&session_id);
    log::info!(
        "[stream] exit session={} code={} chunks={}",
        session_id,
        exit_code,
        chunk_count
    );
    stream_control.mark_stopped();
    log::info!("[stream] end session={} chunks={}", session_id, chunk_count);
}

/// Mirrors one PTY chunk into the headless terminal and enqueues it to every
/// subscriber mailbox. Never awaits client socket or WebSocket progress: live
/// delivery is `try_send` into bounded per-subscriber mailboxes drained by
/// dedicated writer tasks, and a subscriber whose mailbox overflows is
/// disconnected for snapshot resync instead of delaying anyone.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_output_chunk(
    session_id: &str,
    data: &[u8],
    chunk: u64,
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    fanouts: &SessionFanouts,
    terminal_emulator_clients: &TerminalEmulatorClients,
    recovery_manager: &RecoveryManager,
) -> Option<&'static str> {
    if session.is_retired() {
        return None;
    }

    let mut slow_stage = None;
    let has_live_terminal_client = {
        let terminal_clients = terminal_emulator_clients.lock().await;
        !terminal_clients
            .get(session_id)
            .is_none_or(|client_ids| client_ids.is_empty())
    };
    if session.is_retired() {
        return None;
    }
    let allow_terminal_replies = !has_live_terminal_client;

    // The fanout lock spans (mirror -> enqueue) so the AttachSnapshot cutover
    // (snapshot -> register), which takes the same lock, sees each chunk
    // either fully in the snapshot or fully enqueued behind it.
    let fanout = existing_session_fanout(fanouts, session_id).await;
    let mut fanout_state = match fanout.as_ref() {
        Some(fanout) => Some(fanout.state.lock().await),
        None => None,
    };
    if session.is_retired() {
        return None;
    }

    let mirror_started = Instant::now();
    let mirror_operation = terminal_perf::global_monitor().begin(perf_context(
        session_id,
        STAGE_MIRROR_OUTPUT,
        chunk,
        data.len(),
    ));
    let mirror_result = session.mirror_output(data, allow_terminal_replies).await;
    mirror_operation.finish();
    note_slow_stage(mirror_started, STAGE_MIRROR_OUTPUT, &mut slow_stage);

    // Kill/replacement can retire the handle while terminal mirroring is in
    // progress. The old headless terminal is private, but nothing after this
    // point may escape under a session id now owned by a replacement.
    if session.is_retired() {
        return slow_stage;
    }

    let evt = Event::Output {
        session_id: session_id.to_string(),
        data: data.to_vec(),
    };
    let report = fanout_state.as_mut().and_then(|state| {
        EventLine::serialize(&evt, chunk, data.len()).map(|line| state.enqueue(&line))
    });
    drop(fanout_state);
    if let Some(report) = report {
        terminal_perf::emit_events(report.newly_lagged);
        if report.resync_ready {
            if let Some(fanout) = fanout.as_ref() {
                resync_drained_subscribers(session_id, session, fanout).await;
            }
        }
    }

    match mirror_result {
        Ok(MirrorResult { status, replies }) => {
            for reply in replies {
                if session.enqueue_terminal_reply(reply).is_err() {
                    log::warn!(
                        "[stream] dropped terminal reply because input queue is closed session={}",
                        session_id
                    );
                }
            }
            let status_started = Instant::now();
            let status_operation = terminal_perf::global_monitor().begin(perf_context(
                session_id,
                STAGE_DETECT_STATUS,
                chunk,
                data.len(),
            ));
            if let Some(status) = status {
                log_status_observation(session, session_id, "mirror_output").await;
                if session.is_retired() {
                    return slow_stage;
                }
                emit_status_changed(session, broadcast_tx, fanouts, session_id, status).await;
            } else {
                log_status_observation(session, session_id, "mirror_output").await;
            }
            status_operation.finish();
            note_slow_stage(status_started, STAGE_DETECT_STATUS, &mut slow_stage);
        }
        Err(error) => {
            log::error!(
                "failed to mirror PTY output into headless terminal for session {}: {}",
                session_id,
                error
            );
        }
    }

    if !session.is_retired() && should_mirror_output_to_recovery(has_live_terminal_client) {
        let sequence = recovery_manager.next_sequence(session_id);
        let recovery_started = Instant::now();
        let recovery_operation = terminal_perf::global_monitor().begin(perf_context(
            session_id,
            STAGE_RECOVERY_WRITE,
            chunk,
            data.len(),
        ));
        recovery_manager
            .write_output(session_id, data, sequence)
            .await;
        recovery_operation.finish();
        note_slow_stage(recovery_started, STAGE_RECOVERY_WRITE, &mut slow_stage);
    }

    slow_stage
}

/// Resync every lagged-but-drained subscriber of this session from a fresh
/// authoritative snapshot. The snapshot is taken and queued under the fanout
/// lock so no chunk can interleave between them.
async fn resync_drained_subscribers(
    session_id: &str,
    session: &Arc<SessionHandle>,
    fanout: &Arc<SessionFanout>,
) {
    let mut fanout_state = fanout.state.lock().await;
    if !fanout_state.has_drained_lagged() {
        return;
    }
    let snapshot = match session.snapshot(session_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            log::warn!(
                "[fanout] resync snapshot not ready for session {}: {}; retrying on a later chunk",
                session_id,
                error
            );
            schedule_lag_recovery_retry(Arc::clone(fanout));
            return;
        }
    };
    if session.is_retired() {
        return;
    }
    let recovery_events = [
        Event::Snapshot {
            session_id: session_id.to_string(),
            snapshot,
            agent_provider: session.agent_provider().await,
        },
        Event::StatusChanged {
            session_id: session_id.to_string(),
            status: session.status().await,
            waiting_prompt_snippet: None,
        },
    ];
    let recovered = fanout_state.resync_drained(&recovery_events);
    drop(fanout_state);
    terminal_perf::emit_events(recovered);
}

async fn emit_status_changed(
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    fanouts: &SessionFanouts,
    session_id: &str,
    status: SessionStatus,
) {
    if session.is_retired() {
        return;
    }
    if !session.update_status(status).await {
        return;
    }
    if session.is_retired() {
        return;
    }

    let waiting_prompt_snippet = if matches!(status, SessionStatus::Waiting | SessionStatus::Idle) {
        match session.waiting_prompt_snippet().await {
            Ok(prompt) => prompt,
            Err(error) => {
                log::warn!(
                    "failed to extract waiting prompt for session {}: {}",
                    session_id,
                    error
                );
                None
            }
        }
    } else {
        None
    };
    if session.is_retired() {
        return;
    }

    let event = Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
        waiting_prompt_snippet,
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = broadcast_tx.send(json);
    }

    if session.is_retired() {
        return;
    }
    if let Some(report) = fanout_status_changed(fanouts, session_id, &event).await {
        terminal_perf::emit_events(report.newly_lagged);
        if report.resync_ready {
            if let Some(fanout) = existing_session_fanout(fanouts, session_id).await {
                resync_drained_subscribers(session_id, session, &fanout).await;
            }
        }
    }
}

pub(crate) async fn fanout_status_changed(
    fanouts: &SessionFanouts,
    session_id: &str,
    event: &Event,
) -> Option<EnqueueReport> {
    let fanout = existing_session_fanout(fanouts, session_id).await?;
    let line = EventLine::serialize(event, 0, 0)?;
    let report = fanout.state.lock().await.enqueue(&line);
    Some(report)
}

pub(crate) fn format_status_observation_log(
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
        Some(protocol::AgentProvider::Antigravity) => "antigravity",
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
    use super::{schedule_lag_recovery_retry, STATUS_IDLE_FLUSH_MS};
    use crate::fanout::SessionFanout;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn persistent_snapshot_failure_cannot_immediately_renotify_recovery() {
        let fanout = Arc::new(SessionFanout::new());

        for _ in 0..3 {
            schedule_lag_recovery_retry(Arc::clone(&fanout));
            assert!(
                tokio::time::timeout(Duration::from_millis(1), fanout.recovery_notify.notified())
                    .await
                    .is_err(),
                "a failed snapshot must not immediately make the biased recovery branch ready",
            );
            tokio::time::advance(Duration::from_millis(STATUS_IDLE_FLUSH_MS)).await;
            tokio::time::timeout(Duration::from_millis(1), fanout.recovery_notify.notified())
                .await
                .expect("failed lag recovery should retry after the bounded interval");
        }
    }
}
