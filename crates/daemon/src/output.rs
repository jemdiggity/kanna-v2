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

use crate::client::{SessionObservers, SessionSizes, SessionWriters, TerminalEmulatorClients};
use crate::session::{
    MirrorResult, SessionHandle, SessionManager, StreamControl, STATUS_DETECTION_THROTTLE_MS,
};
use crate::socket::write_event;

const STATUS_IDLE_FLUSH_MS: u64 = STATUS_DETECTION_THROTTLE_MS;
const STAGE_MIRROR_OUTPUT: &str = "mirror_output";
const STAGE_DETECT_STATUS: &str = "detect_status";
const STAGE_ATTACHED_WRITER: &str = "attached_writer";
const STAGE_RECOVERY_WRITE: &str = "recovery_write";
const STAGE_OBSERVER_WRITE: &str = "observer_write";

pub(crate) const DAEMON_TERMINAL_PERF_STAGES: [&str; 7] = [
    STAGE_MIRROR_OUTPUT,
    STAGE_DETECT_STATUS,
    STAGE_ATTACHED_WRITER,
    STAGE_RECOVERY_WRITE,
    STAGE_OBSERVER_WRITE,
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
    let mut previous_read_at = None;
    let mut previous_slow_stage = None;
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
                if stream_control.stop_requested() {
                    log::info!("[stream] stop requested session={}", session_id);
                    stream_control.mark_stopped();
                    return;
                }
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
                if stream_control.stop_requested() {
                    log::info!("[stream] stop requested session={}", session_id);
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
        killed: false,
    };
    if let Ok(json) = serde_json::to_string(&evt) {
        let _ = broadcast_tx.send(json);
    }
    recovery_manager.end_session(&session_id).await;
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

    let mut observers_guard = session_observers.lock().await;
    if let Some(observer_list) = observers_guard.remove(&session_id) {
        let obs_evt = Event::Exit {
            session_id: session_id.clone(),
            code: exit_code,
            resume_session_id,
            killed: false,
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
pub(crate) async fn handle_output_chunk(
    session_id: &str,
    data: &[u8],
    chunk: u64,
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    session_writers: &SessionWriters,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_sizes: &SessionSizes,
    session_observers: &SessionObservers,
    recovery_manager: &RecoveryManager,
) -> Option<&'static str> {
    let mut slow_stage = None;
    let has_live_terminal_client = {
        let terminal_clients = terminal_emulator_clients.lock().await;
        !terminal_clients
            .get(session_id)
            .is_none_or(|client_ids| client_ids.is_empty())
    };
    let allow_terminal_replies = !has_live_terminal_client;
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
    match mirror_result {
        Ok(MirrorResult { status, replies }) => {
            for reply in replies {
                if session.enqueue_input(reply).is_err() {
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
                emit_status_changed(session, broadcast_tx, session_id, status).await;
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
            let write_started = Instant::now();
            let write_operation = terminal_perf::global_monitor().begin(perf_context(
                session_id,
                STAGE_ATTACHED_WRITER,
                chunk,
                data.len(),
            ));
            let result = write_event(&mut *w.lock().await, &evt).await;
            write_operation.finish();
            note_slow_stage(write_started, STAGE_ATTACHED_WRITER, &mut slow_stage);
            if result.is_err() {
                failed.push(i);
            }
        }
        if !failed.is_empty() {
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
                let context = perf_context(session_id, STAGE_OBSERVER_WRITE, chunk, data.len());
                async move {
                    let started_at = Instant::now();
                    let operation = terminal_perf::global_monitor().begin(context);
                    let result = write_event(&mut *obs.lock().await, &evt).await;
                    operation.finish();
                    (result, started_at.elapsed() >= STALL_THRESHOLD)
                }
            }))
            .await;
            if results.iter().any(|(_, stalled)| *stalled) {
                slow_stage.get_or_insert(STAGE_OBSERVER_WRITE);
            }
            let mut i = 0;
            observer_list.retain(|_| {
                let ok = results[i].0.is_ok();
                i += 1;
                ok
            });
            if observer_list.is_empty() {
                observers_guard.remove(session_id);
            }
        }
    }
    slow_stage
}

async fn emit_status_changed(
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
) {
    if !session.update_status(status).await {
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

    if let Ok(json) = serde_json::to_string(&Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
        waiting_prompt_snippet,
    }) {
        let _ = broadcast_tx.send(json);
    }
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
