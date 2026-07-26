use crate::{daemon_client, http_api, session_replacements};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Clone, Copy)]
enum SubscriptionStream {
    Legacy,
    Versioned,
}

#[derive(Default)]
struct OverlapDeduplicator {
    pending_legacy: VecDeque<String>,
    pending_versioned: VecDeque<String>,
}

impl OverlapDeduplicator {
    const MAX_PENDING: usize = 1024;

    fn fingerprint(event: &kanna_daemon::protocol::Event) -> String {
        serde_json::to_string(event).unwrap_or_else(|_| format!("{event:?}"))
    }

    fn seed(
        legacy: &VecDeque<kanna_daemon::protocol::Event>,
        versioned: &VecDeque<kanna_daemon::protocol::Event>,
    ) -> Self {
        let mut versioned_remaining = versioned.iter().map(Self::fingerprint).collect::<Vec<_>>();
        let mut pending_legacy = VecDeque::new();
        for key in legacy.iter().map(Self::fingerprint) {
            if let Some(index) = versioned_remaining
                .iter()
                .position(|candidate| candidate == &key)
            {
                versioned_remaining.remove(index);
            } else {
                pending_legacy.push_back(key);
            }
        }
        Self {
            pending_legacy,
            pending_versioned: versioned_remaining.into(),
        }
    }

    fn should_emit(
        &mut self,
        stream: SubscriptionStream,
        event: &kanna_daemon::protocol::Event,
    ) -> bool {
        let key = Self::fingerprint(event);
        let (own, opposite) = match stream {
            SubscriptionStream::Legacy => (&mut self.pending_legacy, &mut self.pending_versioned),
            SubscriptionStream::Versioned => {
                (&mut self.pending_versioned, &mut self.pending_legacy)
            }
        };
        if let Some(index) = opposite.iter().position(|candidate| candidate == &key) {
            opposite.remove(index);
            return false;
        }
        own.push_back(key);
        if own.len() > Self::MAX_PENDING {
            own.pop_front();
        }
        true
    }
}

fn merge_negotiation_events(
    legacy: VecDeque<kanna_daemon::protocol::Event>,
    versioned: VecDeque<kanna_daemon::protocol::Event>,
) -> VecDeque<kanna_daemon::protocol::Event> {
    fn fingerprints(events: &[kanna_daemon::protocol::Event]) -> Vec<String> {
        events
            .iter()
            .map(|event| serde_json::to_string(event).unwrap_or_else(|_| format!("{event:?}")))
            .collect()
    }

    fn lcs_lengths(left: &[String], right: &[String]) -> Vec<Vec<usize>> {
        let mut lengths = vec![vec![0; right.len() + 1]; left.len() + 1];
        for left_index in (0..left.len()).rev() {
            for right_index in (0..right.len()).rev() {
                lengths[left_index][right_index] = if left[left_index] == right[right_index] {
                    1 + lengths[left_index + 1][right_index + 1]
                } else {
                    lengths[left_index + 1][right_index].max(lengths[left_index][right_index + 1])
                };
            }
        }
        lengths
    }

    let legacy = legacy.into_iter().collect::<Vec<_>>();
    let versioned = versioned.into_iter().collect::<Vec<_>>();
    let legacy_keys = fingerprints(&legacy);
    let versioned_keys = fingerprints(&versioned);
    let lengths = lcs_lengths(&versioned_keys, &legacy_keys);

    // Events seen only by a legacy receiver that registered first are a
    // prefix of the overlap. Keep that prefix ahead of the versioned
    // chronology rather than guessing that newer version-only events came
    // first.
    let mut versioned_index = 0;
    let mut legacy_index = 0;
    while versioned_index < versioned.len() && legacy_index < legacy.len() {
        if versioned_keys[versioned_index] == legacy_keys[legacy_index] {
            break;
        }
        if lengths[versioned_index + 1][legacy_index] >= lengths[versioned_index][legacy_index + 1]
        {
            versioned_index += 1;
        } else {
            legacy_index += 1;
        }
    }
    if versioned_index == versioned.len() || legacy_index == legacy.len() {
        return legacy.into_iter().chain(versioned).collect();
    }

    let mut merged = legacy[..legacy_index].iter().cloned().collect::<Vec<_>>();
    let remaining_legacy = &legacy[legacy_index..];
    let remaining_legacy_keys = &legacy_keys[legacy_index..];
    let lengths = lcs_lengths(&versioned_keys, remaining_legacy_keys);
    versioned_index = 0;
    legacy_index = 0;
    while versioned_index < versioned.len() && legacy_index < remaining_legacy.len() {
        if versioned_keys[versioned_index] == remaining_legacy_keys[legacy_index] {
            merged.push(versioned[versioned_index].clone());
            versioned_index += 1;
            legacy_index += 1;
        } else if lengths[versioned_index + 1][legacy_index]
            >= lengths[versioned_index][legacy_index + 1]
        {
            // Ties favor the versioned stream, whose extra provider events
            // carry the authoritative chronology omitted from legacy.
            merged.push(versioned[versioned_index].clone());
            versioned_index += 1;
        } else {
            merged.push(remaining_legacy[legacy_index].clone());
            legacy_index += 1;
        }
    }
    merged.extend(versioned[versioned_index..].iter().cloned());
    merged.extend(remaining_legacy[legacy_index..].iter().cloned());
    merged.into()
}

fn persist_provider_session_id(
    state: &http_api::AppState,
    run_id: Option<&str>,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let Some(run_id) = run_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let Some(resume_session_id) = resume_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let db = crate::db::Db::open(&state.config().db_path).map_err(|e| format!("db error: {e}"))?;
    let update = db
        .update_stage_run_provider_session_id(run_id, resume_session_id)
        .map_err(|e| format!("db error: {e}"))?;
    if update.changed {
        state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    }
    Ok(())
}

fn capture_ownershipless_run_id(
    state: &http_api::AppState,
    session_id: &str,
) -> Result<Option<String>, String> {
    let db = crate::db::Db::open(&state.config().db_path).map_err(|e| format!("db error: {e}"))?;
    db.landed_main_run_id_by_session(session_id)
        .map_err(|e| format!("db error: {e}"))
}

fn capture_ownershipless_created_run_id(
    state: &http_api::AppState,
    session_id: &str,
) -> Result<Option<String>, String> {
    let db = crate::db::Db::open(&state.config().db_path).map_err(|e| format!("db error: {e}"))?;
    db.pending_main_run_id_by_session(session_id)
        .and_then(|pending| match pending {
            Some(run_id) => Ok(Some(run_id)),
            None => db.landed_main_run_id_by_session(session_id),
        })
        .map_err(|e| format!("db error: {e}"))
}

fn persist_waiting_prompt(
    state: &http_api::AppState,
    session_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Ok(());
    }
    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    if db
        .update_pipeline_item_waiting_prompt(session_id, prompt)
        .map_err(|error| format!("db error: {error}"))?
    {
        state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    }
    Ok(())
}

fn exit_still_owns_active_run(
    state: &http_api::AppState,
    session_id: &str,
    run_id: Option<&str>,
) -> Result<bool, String> {
    let Some(run_id) = run_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(false);
    };
    crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?
        .is_active_main_run_owner(run_id, session_id)
        .map_err(|error| format!("db error: {error}"))
}

fn apply_watcher_runtime_status(
    state: &http_api::AppState,
    session_id: &str,
    status: kanna_daemon::protocol::SessionStatus,
) -> Result<(), String> {
    // Busy is selection-independent: every live observer agrees it means
    // working, so the watcher remains an authoritative writer even while a
    // terminal client is attached. Idle/waiting still belong to the attached
    // client because only it knows whether the task is selected (idle) or
    // unselected (unread).
    if state.terminal_attachments().is_attached(session_id)
        && !matches!(status, kanna_daemon::protocol::SessionStatus::Busy)
    {
        return Ok(());
    }

    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(());
    };
    let Some(item) = db
        .get_pipeline_item(&task_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(());
    };
    if item.closed_at.is_some() {
        return Ok(());
    }

    let status = match status {
        kanna_daemon::protocol::SessionStatus::Busy => "busy",
        kanna_daemon::protocol::SessionStatus::Waiting => "waiting",
        kanna_daemon::protocol::SessionStatus::Idle => "idle",
    };
    let Some(activity) = http_api::task_activity::activity_for_runtime_status(
        item.activity.as_deref(),
        status,
        false,
    ) else {
        return Ok(());
    };

    db.update_pipeline_item_activity(&task_id, activity)
        .map_err(|error| format!("db error: {error}"))?;
    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    Ok(())
}

async fn reconcile_detached_terminal_status(
    state: &http_api::AppState,
    session_id: &str,
) -> Result<(), String> {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};

    // A new attachment may have acquired a lease after the final-drop
    // notification was queued. In that case its snapshot owns reconciliation.
    if state.terminal_attachments().is_attached(session_id) {
        return Ok(());
    }

    let config = state.config();
    let mut daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|error| format!("daemon detach reconciliation connection failed: {error}"))?;
    match daemon
        .send_command(&DaemonCommand::List)
        .await
        .map_err(|error| format!("daemon detach reconciliation list failed: {error}"))?
    {
        DaemonEvent::SessionList { sessions, .. } => {
            if let Some(session) = sessions
                .into_iter()
                .find(|session| session.session_id == session_id)
            {
                // The runtime-status helper re-checks the lease after the
                // daemon round-trip, closing a concurrent reattach race for
                // selection-dependent idle/waiting updates.
                apply_watcher_runtime_status(state, session_id, session.status)?;
            }
            Ok(())
        }
        DaemonEvent::Error { message, .. } => Err(format!(
            "daemon detach reconciliation list error: {message}"
        )),
        other => Err(format!(
            "unexpected daemon detach reconciliation list response: {other:?}"
        )),
    }
}

pub(crate) async fn terminal_detach_reconciliation_loop(
    state: Arc<http_api::AppState>,
    mut detached: mpsc::UnboundedReceiver<String>,
) {
    while let Some(session_id) = detached.recv().await {
        if let Err(error) = reconcile_detached_terminal_status(&state, &session_id).await {
            log::warn!(
                "failed to reconcile detached terminal status for {}: {}",
                session_id,
                error
            );
        }
    }
}

pub(crate) async fn terminal_state_watcher_loop(
    state: Arc<http_api::AppState>,
    replacements: session_replacements::SessionReplacements,
) {
    loop {
        if let Err(error) = terminal_state_watcher_once(&state, &replacements).await {
            log::warn!("terminal state watcher reconnecting after error: {}", error);
        }
        // Exits broadcast while disconnected are lost along with their
        // replacement entries; stale entries must not swallow future Exits.
        replacements.clear();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn terminal_state_watcher_once(
    state: &http_api::AppState,
    replacements: &session_replacements::SessionReplacements,
) -> Result<(), String> {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};

    struct SubscriptionAttempt {
        events: mpsc::UnboundedReceiver<Result<DaemonEvent, String>>,
        writer: daemon_client::DaemonClientWriter,
        accepted: bool,
        rejection: Option<String>,
        buffered: VecDeque<DaemonEvent>,
    }

    async fn subscribe(
        mut daemon: daemon_client::DaemonClient,
        command: DaemonCommand,
    ) -> Result<SubscriptionAttempt, String> {
        daemon
            .send_one_way(&command)
            .await
            .map_err(|error| error.to_string())?;
        let (mut reader, writer) = daemon.into_split();
        let (event_tx, mut events) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let event = match reader.read_event().await {
                    Ok(event) => Ok(event),
                    Err(error) => Err(error.to_string()),
                };
                let stop = event.is_err();
                if event_tx.send(event).is_err() || stop {
                    break;
                }
            }
        });
        let mut buffered = VecDeque::new();
        loop {
            match events
                .recv()
                .await
                .ok_or_else(|| "daemon subscription reader stopped".to_string())??
            {
                DaemonEvent::Ok => {
                    return Ok(SubscriptionAttempt {
                        events,
                        writer,
                        accepted: true,
                        rejection: None,
                        buffered,
                    });
                }
                DaemonEvent::Error { message, .. } => {
                    return Ok(SubscriptionAttempt {
                        events,
                        writer,
                        accepted: false,
                        rejection: Some(message),
                        buffered,
                    });
                }
                event => buffered.push_back(event),
            }
        }
    }

    let config = state.config();
    // Start a legacy overlap before awaiting the versioned acknowledgement.
    // Current daemons accept both and the versioned stream wins; old daemons
    // can close the unknown versioned connection while the legacy receiver is
    // already registered and buffering events.
    let versioned_daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon connection failed: {}", e))?;
    let legacy_daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("legacy daemon connection failed: {}", e))?;
    let (versioned, legacy) = tokio::join!(
        subscribe(
            versioned_daemon,
            DaemonCommand::SubscribeEvents {
                version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION,
            },
        ),
        subscribe(legacy_daemon, DaemonCommand::Subscribe),
    );
    let legacy = legacy.map_err(|error| format!("legacy daemon subscribe failed: {error}"))?;
    if !legacy.accepted {
        return Err(format!(
            "legacy daemon subscribe error: {}",
            legacy.rejection.unwrap_or_else(|| "rejected".to_string())
        ));
    }
    let SubscriptionAttempt {
        events: legacy_events,
        writer: legacy_writer,
        buffered: legacy_buffered,
        ..
    } = legacy;
    let (
        mut versioned_events,
        mut legacy_events,
        _versioned_writer,
        _legacy_writer,
        mut buffered_events,
        mut overlap_deduplicator,
    ) = match versioned {
        Ok(versioned) if versioned.accepted => {
            let overlap_deduplicator =
                OverlapDeduplicator::seed(&legacy_buffered, &versioned.buffered);
            (
                Some(versioned.events),
                Some(legacy_events),
                Some(versioned.writer),
                Some(legacy_writer),
                // The legacy overlap may have registered first. Preserve
                // events received only there before the versioned
                // acknowledgement and collapse shared broadcasts.
                merge_negotiation_events(legacy_buffered, versioned.buffered),
                overlap_deduplicator,
            )
        }
        Ok(versioned) => {
            log::info!(
                "daemon rejected versioned event stream ({}); using legacy stream",
                versioned
                    .rejection
                    .unwrap_or_else(|| "rejected".to_string())
            );
            (
                None,
                Some(legacy_events),
                None,
                Some(legacy_writer),
                legacy_buffered,
                OverlapDeduplicator::default(),
            )
        }
        Err(error) => {
            log::info!("versioned event stream unavailable ({error}); using legacy stream");
            (
                None,
                Some(legacy_events),
                None,
                Some(legacy_writer),
                legacy_buffered,
                OverlapDeduplicator::default(),
            )
        }
    };

    let mut control = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon control connection failed: {}", e))?;
    let daemon_list = control
        .list()
        .await
        .map_err(|e| format!("daemon list failed: {}", e))?;
    let strict_run_ownership = daemon_list.capabilities.immutable_run_ownership;
    let mut ownershipless_sessions = HashMap::new();
    for session in daemon_list.sessions {
        if !strict_run_ownership || session.run_id.is_none() {
            let captured = match capture_ownershipless_run_id(state, &session.session_id) {
                Ok(run_id) => run_id,
                Err(error) => {
                    log::warn!(
                        "failed to capture legacy run ownership for {}: {}",
                        session.session_id,
                        error
                    );
                    None
                }
            };
            ownershipless_sessions.insert(session.session_id.clone(), captured);
        }
        if let Err(error) = apply_watcher_runtime_status(state, &session.session_id, session.status)
        {
            log::warn!(
                "failed to reconcile terminal status for {}: {}",
                session.session_id,
                error
            );
        }
    }
    let mut saw_shutdown = false;
    loop {
        let (event, buffered_before_list, event_stream) = loop {
            if let Some(event) = buffered_events.pop_front() {
                break (event, true, None);
            }
            let overlapping = versioned_events.is_some() && legacy_events.is_some();
            let (stream, received) = match (versioned_events.as_mut(), legacy_events.as_mut()) {
                (Some(versioned), Some(legacy)) => {
                    tokio::select! {
                        // During overlap, legacy is the stream that can
                        // contain events emitted before the versioned
                        // acknowledgement. Drain anything already queued
                        // there before observing later versioned events.
                        biased;
                        event = legacy.recv() => (SubscriptionStream::Legacy, event),
                        event = versioned.recv() => (SubscriptionStream::Versioned, event),
                    }
                }
                (Some(versioned), None) => (SubscriptionStream::Versioned, versioned.recv().await),
                (None, Some(legacy)) => (SubscriptionStream::Legacy, legacy.recv().await),
                (None, None) => {
                    if saw_shutdown {
                        return Ok(());
                    }
                    return Err("all daemon event subscriptions closed".to_string());
                }
            };
            match received {
                Some(Ok(event))
                    if !overlapping || overlap_deduplicator.should_emit(stream, &event) =>
                {
                    break (event, false, Some(stream));
                }
                Some(Ok(_)) => continue,
                Some(Err(error)) => {
                    log::warn!("daemon event subscription closed after error: {error}");
                }
                None => {
                    log::warn!("daemon event subscription closed");
                }
            }
            match stream {
                SubscriptionStream::Legacy => legacy_events = None,
                SubscriptionStream::Versioned => versioned_events = None,
            }
        };
        match event {
            DaemonEvent::StatusChanged {
                session_id,
                status,
                waiting_prompt_snippet,
            } => {
                if let Some(prompt) = waiting_prompt_snippet {
                    if let Err(error) = persist_waiting_prompt(state, &session_id, &prompt) {
                        log::warn!(
                            "failed to persist waiting prompt for {}: {}",
                            session_id,
                            error
                        );
                    }
                }
                if let Err(error) = apply_watcher_runtime_status(state, &session_id, status) {
                    log::warn!(
                        "failed to apply terminal status for {}: {}",
                        session_id,
                        error
                    );
                }
            }
            DaemonEvent::ProviderSessionChanged {
                session_id,
                run_id,
                provider_session_id,
            } => {
                let ownershipless =
                    !strict_run_ownership || ownershipless_sessions.contains_key(&session_id);
                let persisted = if run_id.is_some() {
                    persist_provider_session_id(
                        state,
                        run_id.as_deref(),
                        Some(&provider_session_id),
                    )
                } else if ownershipless {
                    persist_provider_session_id(
                        state,
                        ownershipless_sessions
                            .get(&session_id)
                            .and_then(|run_id| run_id.as_deref()),
                        Some(&provider_session_id),
                    )
                } else {
                    Ok(())
                };
                if let Err(error) = persisted {
                    log::warn!(
                        "failed to persist provider session id for {}: {}",
                        session_id,
                        error
                    );
                }
            }
            DaemonEvent::Exit {
                session_id,
                run_id,
                code,
                killed,
                resume_session_id,
            } => {
                let ownershipless =
                    !strict_run_ownership || ownershipless_sessions.contains_key(&session_id);
                let ownershipless_run_id = ownershipless_sessions
                    .remove(&session_id)
                    .flatten()
                    .or_else(|| {
                        if ownershipless && buffered_before_list {
                            match capture_ownershipless_run_id(state, &session_id) {
                                Ok(run_id) => run_id,
                                Err(error) => {
                                    log::warn!(
                                        "failed to capture buffered legacy exit ownership for {}: {}",
                                        session_id,
                                        error
                                    );
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    });
                // Consume the replacement entry even when the event is
                // self-describing — a leftover entry would swallow a future
                // legitimate Exit for the same session id.
                let replacement = replacements.take(&session_id);
                let persisted = if run_id.is_some() {
                    persist_provider_session_id(
                        state,
                        run_id.as_deref(),
                        resume_session_id.as_deref(),
                    )
                } else if let Some(Some(source_run_id)) = replacement.as_ref() {
                    persist_provider_session_id(
                        state,
                        Some(source_run_id),
                        resume_session_id.as_deref(),
                    )
                } else if replacement.is_some() {
                    // An orchestrated legacy kill without captured immutable
                    // ownership must not resolve its stale handle against the
                    // newest run for the reused task session id.
                    Ok(())
                } else if ownershipless {
                    persist_provider_session_id(
                        state,
                        ownershipless_run_id.as_deref(),
                        resume_session_id.as_deref(),
                    )
                } else {
                    Ok(())
                };
                if let Err(error) = persisted {
                    log::warn!(
                        "failed to persist terminal resume session id for {}: {}",
                        session_id,
                        error
                    );
                }
                if replacement.is_some() || killed {
                    // Orchestrated kill (stage swap, rerun, close) — not the
                    // agent finishing.
                    continue;
                }
                let owns_active_run = if run_id.is_some() {
                    exit_still_owns_active_run(state, &session_id, run_id.as_deref())
                } else if ownershipless {
                    exit_still_owns_active_run(state, &session_id, ownershipless_run_id.as_deref())
                } else {
                    Ok(false)
                };
                match owns_active_run {
                    Ok(true) => {}
                    Ok(false) => {
                        log::info!(
                            "ignoring stale or unowned terminal exit for session {} run {:?}",
                            session_id,
                            run_id
                        );
                        continue;
                    }
                    Err(error) => {
                        log::warn!(
                            "failed to verify terminal exit ownership for {}: {}",
                            session_id,
                            error
                        );
                        continue;
                    }
                }
                let success = code == 0;
                if let Err(error) =
                    http_api::handle_task_terminal_state(state, &session_id, success).await
                {
                    log::warn!(
                        "failed to handle terminal state for {} (success={}): {}",
                        session_id,
                        success,
                        error
                    );
                }
            }
            DaemonEvent::SessionCreated { session_id, run_id } => {
                if run_id.is_none() {
                    // An existing binding belongs to an older session whose
                    // delayed events precede its replacement Exit. Once that
                    // Exit removes the binding, the replacement's immediate
                    // ownershipless SessionCreated may claim the reserved
                    // pending successor before it lands.
                    if !ownershipless_sessions.contains_key(&session_id) {
                        let captured =
                            match capture_ownershipless_created_run_id(state, &session_id) {
                                Ok(run_id) => run_id,
                                Err(error) => {
                                    log::warn!(
                                        "failed to capture legacy created-run ownership for {}: {}",
                                        session_id,
                                        error
                                    );
                                    None
                                }
                            };
                        ownershipless_sessions.insert(session_id, captured);
                    }
                } else {
                    ownershipless_sessions.remove(&session_id);
                }
            }
            DaemonEvent::ShuttingDown => {
                saw_shutdown = true;
                match event_stream {
                    Some(SubscriptionStream::Legacy) => legacy_events = None,
                    Some(SubscriptionStream::Versioned) => versioned_events = None,
                    None => return Ok(()),
                }
                if versioned_events.is_none() && legacy_events.is_none() {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::{Db, NewStageRun};
    use kanna_daemon::protocol::{
        Command as DaemonCommand, Event as DaemonEvent, SessionInfo, SessionState,
    };
    use std::path::{Path, PathBuf};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::time::{timeout, Duration};

    fn unique_name(prefix: &str) -> String {
        format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn overlap_deduplicator_emits_each_cross_stream_event_once() {
        let event = DaemonEvent::StatusChanged {
            session_id: "task-child".to_string(),
            status: kanna_daemon::protocol::SessionStatus::Busy,
            waiting_prompt_snippet: None,
        };
        let mut deduplicator = OverlapDeduplicator::default();

        assert!(deduplicator.should_emit(SubscriptionStream::Legacy, &event));
        assert!(!deduplicator.should_emit(SubscriptionStream::Versioned, &event));
        assert!(deduplicator.should_emit(SubscriptionStream::Versioned, &event));
        assert!(!deduplicator.should_emit(SubscriptionStream::Legacy, &event));
    }

    fn daemon_socket_path_for_dir(daemon_dir: &Path) -> PathBuf {
        kanna_runtime_defaults::socket_path(daemon_dir)
    }

    fn test_config(unique: &str, daemon_dir: &Path) -> Config {
        Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(unique),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
        }
    }

    fn seed_notifying_task(config: &Config) {
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Child prompt",
            Some("Child Display"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_notify_task("task-child", "task-parent")
            .unwrap();
    }

    fn seed_plain_task(config: &Config) {
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Child prompt",
            Some("Child Display"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    }

    fn bind_daemon_listener(daemon_dir: &Path) -> (UnixListener, PathBuf) {
        std::fs::create_dir_all(daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        (UnixListener::bind(&socket_path).unwrap(), socket_path)
    }

    async fn expect_subscribe(listener: &UnixListener) -> tokio::net::unix::OwnedWriteHalf {
        expect_subscribe_with_sessions(listener, Vec::new()).await
    }

    async fn expect_subscribe_with_sessions(
        listener: &UnixListener,
        sessions: Vec<SessionInfo>,
    ) -> tokio::net::unix::OwnedWriteHalf {
        expect_subscribe_with_list(
            listener,
            sessions,
            kanna_daemon::protocol::DaemonCapabilities::current(),
        )
        .await
    }

    async fn expect_subscribe_with_list(
        listener: &UnixListener,
        sessions: Vec<SessionInfo>,
        capabilities: kanna_daemon::protocol::DaemonCapabilities,
    ) -> tokio::net::unix::OwnedWriteHalf {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
            DaemonCommand::SubscribeEvents { version } => {
                assert_eq!(
                    version,
                    kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION
                );
            }
            other => panic!("expected SubscribeEvents command, got {other:?}"),
        }
        write_event(&mut write_half, &DaemonEvent::Ok).await;

        let (legacy_stream, _) = listener.accept().await.unwrap();
        let (legacy_read, mut legacy_write) = legacy_stream.into_split();
        let mut legacy_reader = BufReader::new(legacy_read);
        let mut legacy_line = String::new();
        legacy_reader.read_line(&mut legacy_line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(legacy_line.trim()).unwrap() {
            DaemonCommand::Subscribe => {}
            other => panic!("expected overlapping Subscribe command, got {other:?}"),
        }
        write_event(&mut legacy_write, &DaemonEvent::Ok).await;

        let (control_stream, _) = listener.accept().await.unwrap();
        let (control_read, mut control_write) = control_stream.into_split();
        let mut control_reader = BufReader::new(control_read);
        let mut control_line = String::new();
        control_reader.read_line(&mut control_line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(control_line.trim()).unwrap() {
            DaemonCommand::List => {}
            other => panic!("expected List command, got {other:?}"),
        }
        write_event(
            &mut control_write,
            &DaemonEvent::SessionList {
                sessions,
                capabilities: Some(capabilities),
            },
        )
        .await;
        write_half
    }

    async fn write_event(writer: &mut tokio::net::unix::OwnedWriteHalf, event: &DaemonEvent) {
        writer
            .write_all(format!("{}\n", serde_json::to_string(event).unwrap()).as_bytes())
            .await
            .unwrap();
    }

    async fn write_raw_event(writer: &mut tokio::net::unix::OwnedWriteHalf, event: &str) {
        writer.write_all(event.as_bytes()).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
    }

    async fn expect_no_notification_connection(listener: &UnixListener) {
        match timeout(Duration::from_millis(150), listener.accept()).await {
            Err(_) => {}
            Ok(Ok(_)) => panic!("killed exit unexpectedly opened a notification connection"),
            Ok(Err(error)) => panic!("failed while checking for notification connection: {error}"),
        }
    }

    async fn expect_completion_notification(listener: &UnixListener) -> Vec<Vec<u8>> {
        let (stream, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("notification connection was not opened")
            .unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "task-parent");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_event(&mut write_half, &DaemonEvent::Ok).await;
        }
        inputs
    }

    #[tokio::test]
    async fn watcher_negotiates_versioned_subscription_when_daemon_advertises_it() {
        let unique = unique_name("terminal-watcher-versioned-subscription");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_keeps_and_deduplicates_overlap_events_when_versioned_stream_wins() {
        let unique = unique_name("terminal-watcher-versioned-overlap-exit");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let exit = DaemonEvent::Exit {
            session_id: "task-child".to_string(),
            run_id: None,
            code: 0,
            resume_session_id: None,
            killed: false,
        };
        let created = DaemonEvent::SessionCreated {
            session_id: "task-child".to_string(),
            run_id: None,
        };

        let server = tokio::spawn(async move {
            let (versioned_stream, _) = listener.accept().await.unwrap();
            let (versioned_read, mut versioned_write) = versioned_stream.into_split();
            let mut versioned_reader = BufReader::new(versioned_read);
            let mut line = String::new();
            versioned_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::SubscribeEvents { .. }
            ));

            let (legacy_stream, _) = listener.accept().await.unwrap();
            let (legacy_read, mut legacy_write) = legacy_stream.into_split();
            let mut legacy_reader = BufReader::new(legacy_read);
            line.clear();
            legacy_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));

            // ProviderSessionChanged is filtered from legacy. It must stay
            // ahead of the shared Exit/SessionCreated pair when the buffers
            // are merged, and the shared pair must not be replayed.
            write_event(
                &mut versioned_write,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: None,
                    provider_session_id: "provider-before-exit".to_string(),
                },
            )
            .await;
            write_event(&mut legacy_write, &exit).await;
            write_event(&mut versioned_write, &exit).await;
            write_event(&mut legacy_write, &created).await;
            write_event(&mut versioned_write, &created).await;
            write_event(&mut legacy_write, &DaemonEvent::Ok).await;
            write_event(&mut versioned_write, &DaemonEvent::Ok).await;

            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            line.clear();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-child".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: kanna_daemon::protocol::SessionStatus::Idle,
                        kind: Default::default(),
                        run_id: None,
                    }],
                    capabilities: Some(kanna_daemon::protocol::DaemonCapabilities::current()),
                },
            )
            .await;
            write_event(&mut versioned_write, &DaemonEvent::ShuttingDown).await;
        });

        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();
        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let provider_session_id: Option<String> = rusqlite::Connection::open(&config.db_path)
            .unwrap()
            .query_row(
                "SELECT provider_session_id FROM stage_run WHERE id = 'run-current'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            provider_session_id.as_deref(),
            Some("provider-before-exit"),
            "the version-only provider event must remain ahead of shared lifecycle events"
        );
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        assert!(
            state_changes.try_recv().is_err(),
            "shared overlap events must be applied exactly once"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    fn assert_task_not_completed(config: &Config) {
        let db = Db::open(&config.db_path).unwrap();
        let task = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(task.activity.as_deref(), Some("idle"));
        assert!(task.notified_at.is_none());
    }

    fn assert_task_completed(config: &Config) {
        let db = Db::open(&config.db_path).unwrap();
        let task = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(task.activity.as_deref(), Some("unread"));
        assert!(task.notified_at.is_some());
    }

    fn assert_task_agent_session_id(config: &Config, expected: &str) {
        let conn = rusqlite::Connection::open(&config.db_path).unwrap();
        let actual: Option<String> = conn
            .query_row(
                "SELECT agent_session_id FROM pipeline_item WHERE id = ?",
                ["task-child"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(actual.as_deref(), Some(expected));
    }

    #[tokio::test]
    async fn watcher_ignores_killed_exit_without_completion_side_effects() {
        let unique = unique_name("terminal-watcher-killed");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: None,
                    code: 0,
                    resume_session_id: None,
                    killed: true,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_not_completed(&config);
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_ignores_delayed_exit_from_replaced_run() {
        let unique = unique_name("terminal-watcher-delayed-old-exit");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        for (id, stage, status) in [
            ("run-old", "in progress", "succeeded"),
            ("run-replacement", "review", "running"),
        ] {
            db.insert_stage_run(NewStageRun {
                id,
                task_id: "task-child",
                stage,
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status,
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        }
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-old".to_string()),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_not_completed(&config);
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_exit_resume_session_id() {
        let unique = unique_name("terminal-watcher-resume-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-current".to_string()),
                    code: 0,
                    resume_session_id: Some("019d99a5-aa94-7c73-b786-644cc095c037".to_string()),
                    killed: false,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_agent_session_id(&config, "019d99a5-aa94-7c73-b786-644cc095c037");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn mixed_version_ownershipless_natural_exit_completes_and_preserves_provider_handle() {
        for (label, capabilities) in [
            (
                "old-daemon",
                kanna_daemon::protocol::DaemonCapabilities::legacy(),
            ),
            (
                "adopted-session",
                kanna_daemon::protocol::DaemonCapabilities::current(),
            ),
        ] {
            let unique = unique_name(&format!("terminal-watcher-{label}-natural-exit"));
            let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
            let config = test_config(&unique, &daemon_dir);
            seed_notifying_task(&config);
            Db::open(&config.db_path)
                .unwrap()
                .insert_stage_run(NewStageRun {
                    id: "run-current",
                    task_id: "task-child",
                    stage: "in progress",
                    kind: "main",
                    agent: None,
                    agent_provider: Some("codex"),
                    model: None,
                    status: "running",
                    result: None,
                    feedback: None,
                    session_id: Some("task-child"),
                    provider_session_id: None,
                    cwd: Some("/tmp/task-child"),
                    resumed_from_run_id: None,
                })
                .unwrap();
            let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

            let server = tokio::spawn(async move {
                let sessions = vec![SessionInfo {
                    session_id: "task-child".to_string(),
                    pid: 42,
                    cwd: "/tmp/task-child".to_string(),
                    state: SessionState::Active,
                    idle_seconds: 0,
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    kind: Default::default(),
                    run_id: None,
                }];
                let mut subscriber =
                    expect_subscribe_with_list(&listener, sessions, capabilities).await;
                write_event(
                    &mut subscriber,
                    &DaemonEvent::Exit {
                        session_id: "task-child".to_string(),
                        run_id: None,
                        code: 0,
                        resume_session_id: Some("codex-thread-from-exit".to_string()),
                        killed: false,
                    },
                )
                .await;
                let inputs = expect_completion_notification(&listener).await;
                write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
                inputs
            });

            timeout(
                Duration::from_secs(2),
                terminal_state_watcher_once(
                    &http_api::AppState::new(config.clone()),
                    &session_replacements::SessionReplacements::default(),
                ),
            )
            .await
            .expect("watcher did not finish")
            .unwrap();
            assert_eq!(server.await.unwrap().len(), 2);
            assert_task_completed(&config);
            assert_task_agent_session_id(&config, "codex-thread-from-exit");
            let run = Db::open(&config.db_path)
                .unwrap()
                .latest_stage_run("task-child")
                .unwrap()
                .unwrap();
            assert_eq!(
                run.provider_session_id.as_deref(),
                Some("codex-thread-from-exit")
            );

            let _ = std::fs::remove_file(socket_path);
            let _ = std::fs::remove_dir_all(daemon_dir);
        }
    }

    #[tokio::test]
    async fn mixed_version_ownershipless_replacement_exit_does_not_stamp_pending_successor() {
        for (label, capabilities) in [
            (
                "old-daemon",
                kanna_daemon::protocol::DaemonCapabilities::legacy(),
            ),
            (
                "adopted-session",
                kanna_daemon::protocol::DaemonCapabilities::current(),
            ),
        ] {
            let unique = unique_name(&format!("terminal-watcher-{label}-replacement-exit"));
            let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
            let config = test_config(&unique, &daemon_dir);
            seed_notifying_task(&config);
            let db = Db::open(&config.db_path).unwrap();
            db.insert_stage_run(NewStageRun {
                id: "run-source",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
            let expected = db.task_action_state("task-child").unwrap();
            db.replace_current_run_with_pending(
                NewStageRun {
                    id: "run-successor",
                    task_id: "task-child",
                    stage: "review",
                    kind: "main",
                    agent: None,
                    agent_provider: Some("codex"),
                    model: None,
                    status: "pending",
                    result: None,
                    feedback: None,
                    session_id: Some("task-child"),
                    provider_session_id: None,
                    cwd: Some("/tmp/task-child-2"),
                    resumed_from_run_id: None,
                },
                Some("manual"),
                &expected,
                "cancelled",
                None,
                None,
            )
            .unwrap();
            drop(db);

            let replacements = session_replacements::SessionReplacements::default();
            replacements.begin_for_run("task-child", Some("run-source"));
            let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
            let server = tokio::spawn(async move {
                let sessions = vec![SessionInfo {
                    session_id: "task-child".to_string(),
                    pid: 42,
                    cwd: "/tmp/task-child".to_string(),
                    state: SessionState::Active,
                    idle_seconds: 0,
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    kind: Default::default(),
                    run_id: None,
                }];
                let mut subscriber =
                    expect_subscribe_with_list(&listener, sessions, capabilities).await;
                write_event(
                    &mut subscriber,
                    &DaemonEvent::Exit {
                        session_id: "task-child".to_string(),
                        run_id: None,
                        code: 0,
                        resume_session_id: Some("old-codex-thread".to_string()),
                        killed: false,
                    },
                )
                .await;
                write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
                expect_no_notification_connection(&listener).await;
            });

            timeout(
                Duration::from_secs(2),
                terminal_state_watcher_once(
                    &http_api::AppState::new(config.clone()),
                    &replacements,
                ),
            )
            .await
            .expect("watcher did not finish")
            .unwrap();
            server.await.unwrap();

            let db = Db::open(&config.db_path).unwrap();
            let runs = db.list_stage_runs_for_task("task-child").unwrap();
            assert_eq!(
                runs.iter()
                    .find(|run| run.id == "run-successor")
                    .and_then(|run| run.provider_session_id.as_deref()),
                None,
                "old ownershipless Exit must not stamp the pending successor"
            );
            let task_session_id: Option<String> = rusqlite::Connection::open(&config.db_path)
                .unwrap()
                .query_row(
                    "SELECT agent_session_id FROM pipeline_item WHERE id = ?1",
                    ["task-child"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(task_session_id, None);
            let task = db.get_pipeline_item("task-child").unwrap().unwrap();
            assert_eq!(task.activity.as_deref(), Some("working"));
            assert!(task.notified_at.is_none());

            let _ = std::fs::remove_file(socket_path);
            let _ = std::fs::remove_dir_all(daemon_dir);
        }
    }

    #[tokio::test]
    async fn ownershipless_created_event_binds_pending_successor_through_land_and_exit() {
        let unique = unique_name("terminal-watcher-pending-created-land-exit");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        db.insert_stage_run(NewStageRun {
            id: "run-source",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: None,
            cwd: Some("/tmp/task-child"),
            resumed_from_run_id: None,
        })
        .unwrap();
        let expected = db.task_action_state("task-child").unwrap();
        db.replace_current_run_with_pending(
            NewStageRun {
                id: "run-successor",
                task_id: "task-child",
                stage: "review",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "pending",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child-2"),
                resumed_from_run_id: None,
            },
            Some("manual"),
            &expected,
            "cancelled",
            None,
            None,
        )
        .unwrap();
        drop(db);

        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let server_db_path = config.db_path.clone();
        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe_with_list(
                &listener,
                Vec::new(),
                kanna_daemon::protocol::DaemonCapabilities::legacy(),
            )
            .await;
            write_event(
                &mut subscriber,
                &DaemonEvent::SessionCreated {
                    session_id: "task-child".to_string(),
                    run_id: None,
                },
            )
            .await;
            write_event(
                &mut subscriber,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: None,
                    provider_session_id: "successor-provider".to_string(),
                },
            )
            .await;

            let db = Db::open(&server_db_path).unwrap();
            for _ in 0..100 {
                if db
                    .latest_stage_run("task-child")
                    .unwrap()
                    .is_some_and(|run| {
                        run.provider_session_id.as_deref() == Some("successor-provider")
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(
                db.latest_stage_run("task-child")
                    .unwrap()
                    .unwrap()
                    .provider_session_id
                    .as_deref(),
                Some("successor-provider"),
                "ownershipless SessionCreated must bind the reserved successor"
            );
            db.land_stage_run(
                "task-child",
                "run-successor",
                "review",
                Some("task-child-2"),
                None,
            )
            .unwrap();
            drop(db);

            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: None,
                    code: 0,
                    resume_session_id: Some("successor-provider".to_string()),
                    killed: false,
                },
            )
            .await;
            let inputs = expect_completion_notification(&listener).await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            inputs
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        assert_eq!(server.await.unwrap().len(), 2);
        assert_task_completed(&config);
        let runs = Db::open(&config.db_path)
            .unwrap()
            .list_stage_runs_for_task("task-child")
            .unwrap();
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-successor")
                .and_then(|run| run.provider_session_id.as_deref()),
            Some("successor-provider")
        );
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-source")
                .and_then(|run| run.provider_session_id.as_deref()),
            None
        );

        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn ownershipless_provider_event_stays_pinned_after_successor_lands() {
        let unique = unique_name("terminal-watcher-ownershipless-provider-after-land");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-source",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let server_db_path = config.db_path.clone();

        let server = tokio::spawn(async move {
            let sessions = vec![SessionInfo {
                session_id: "task-child".to_string(),
                pid: 42,
                cwd: "/tmp/task-child".to_string(),
                state: SessionState::Active,
                idle_seconds: 0,
                status: kanna_daemon::protocol::SessionStatus::Busy,
                kind: Default::default(),
                run_id: None,
            }];
            let mut subscriber = expect_subscribe_with_list(
                &listener,
                sessions,
                kanna_daemon::protocol::DaemonCapabilities::legacy(),
            )
            .await;

            let db = Db::open(&server_db_path).unwrap();
            for _ in 0..100 {
                if db
                    .get_pipeline_item("task-child")
                    .unwrap()
                    .is_some_and(|task| task.activity.as_deref() == Some("working"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(
                db.get_pipeline_item("task-child")
                    .unwrap()
                    .unwrap()
                    .activity
                    .as_deref(),
                Some("working"),
                "watcher must capture subscribe-time ownership before successor landing"
            );
            let expected = db.task_action_state("task-child").unwrap();
            db.replace_current_run_with_pending(
                NewStageRun {
                    id: "run-successor",
                    task_id: "task-child",
                    stage: "review",
                    kind: "main",
                    agent: None,
                    agent_provider: Some("codex"),
                    model: None,
                    status: "pending",
                    result: None,
                    feedback: None,
                    session_id: Some("task-child"),
                    provider_session_id: None,
                    cwd: Some("/tmp/task-child-2"),
                    resumed_from_run_id: None,
                },
                Some("manual"),
                &expected,
                "cancelled",
                None,
                None,
            )
            .unwrap();
            db.land_stage_run(
                "task-child",
                "run-successor",
                "review",
                Some("task-child-1"),
                None,
            )
            .unwrap();
            drop(db);

            write_event(
                &mut subscriber,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: None,
                    provider_session_id: "provider-from-source".to_string(),
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        let runs = Db::open(&config.db_path)
            .unwrap()
            .list_stage_runs_for_task("task-child")
            .unwrap();
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-source")
                .and_then(|run| run.provider_session_id.as_deref()),
            Some("provider-from-source")
        );
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-successor")
                .and_then(|run| run.provider_session_id.as_deref()),
            None,
            "a delayed ownershipless event must not resolve against the landed successor"
        );

        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_killed_exit_resume_id_on_completed_stage_run() {
        let unique = unique_name("terminal-watcher-killed-resume-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        db.insert_stage_run(NewStageRun {
            id: "run-implement",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status: "succeeded",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: None,
            cwd: Some("/tmp/task-child"),
            resumed_from_run_id: None,
        })
        .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-implement".to_string()),
                    code: 137,
                    resume_session_id: Some("codex-thread".to_string()),
                    killed: true,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        let run = Db::open(&config.db_path)
            .unwrap()
            .latest_stage_run("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(run.provider_session_id.as_deref(), Some("codex-thread"));
        assert_task_not_completed(&config);
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_live_headless_provider_session_id() {
        let unique = unique_name("terminal-watcher-live-provider-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        db.insert_stage_run(NewStageRun {
            id: "run-implement",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("opencode"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: None,
            cwd: Some("/tmp/task-child"),
            resumed_from_run_id: None,
        })
        .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-implement".to_string()),
                    provider_session_id: "opencode-session".to_string(),
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let run = Db::open(&config.db_path)
            .unwrap()
            .latest_stage_run("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(run.provider_session_id.as_deref(), Some("opencode-session"));
        assert_task_agent_session_id(&config, "opencode-session");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn delayed_old_provider_event_updates_only_its_owning_main_run() {
        let unique = unique_name("terminal-watcher-delayed-provider-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        for (id, stage, kind, status, provider_session_id) in [
            ("run-old", "in progress", "main", "succeeded", None),
            ("run-post", "commit", "post", "succeeded", None),
            (
                "run-replacement",
                "review",
                "main",
                "running",
                Some("replacement-thread"),
            ),
        ] {
            db.insert_stage_run(NewStageRun {
                id,
                task_id: "task-child",
                stage,
                kind,
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status,
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        }
        db.update_pipeline_item_agent_session_id("task-child", Some("replacement-thread"))
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-old".to_string()),
                    provider_session_id: "old-thread".to_string(),
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let runs = Db::open(&config.db_path)
            .unwrap()
            .list_stage_runs_for_task("task-child")
            .unwrap();
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-old")
                .and_then(|run| run.provider_session_id.as_deref()),
            Some("old-thread")
        );
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-post")
                .and_then(|run| run.provider_session_id.as_deref()),
            None
        );
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-replacement")
                .and_then(|run| run.provider_session_id.as_deref()),
            Some("replacement-thread")
        );
        assert_task_agent_session_id(&config, "replacement-thread");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_only_changed_waiting_prompts() {
        let unique = unique_name("terminal-watcher-waiting-prompt");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            for _ in 0..2 {
                write_event(
                    &mut subscriber,
                    &DaemonEvent::StatusChanged {
                        session_id: "task-child".to_string(),
                        status: kanna_daemon::protocol::SessionStatus::Idle,
                        waiting_prompt_snippet: Some("Ready for review".to_string()),
                    },
                )
                .await;
            }
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &state,
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        assert_eq!(
            db.get_pipeline_item("task-child")
                .unwrap()
                .unwrap()
                .last_output_preview
                .as_deref(),
            Some("Ready for review")
        );
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        assert!(matches!(
            state_changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_consumes_replacement_entry_even_for_killed_exit() {
        let unique = unique_name("terminal-watcher-killed-consumes-replacement");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let replacements = session_replacements::SessionReplacements::default();
        replacements.begin("task-child");
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-current".to_string()),
                    code: -1,
                    resume_session_id: None,
                    killed: true,
                },
            )
            .await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-current".to_string()),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            )
            .await;
            let inputs = expect_completion_notification(&listener).await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            inputs
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(&http_api::AppState::new(config.clone()), &replacements),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        let inputs = server.await.unwrap();

        assert_eq!(
            inputs,
            vec![
                b"TASK task-child DONE [success]: Child Display".to_vec(),
                vec![b'\r']
            ]
        );
        assert_task_completed(&config);
        assert!(
            !replacements.consume("task-child"),
            "replacement entry should have been consumed by the killed exit"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_replacement_fallback_ignores_exit_without_killed_field() {
        let unique = unique_name("terminal-watcher-legacy-replacement");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let replacements = session_replacements::SessionReplacements::default();
        replacements.begin("task-child");
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_raw_event(
                &mut subscriber,
                r#"{"type":"Exit","session_id":"task-child","code":0}"#,
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(&http_api::AppState::new(config.clone()), &replacements),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_not_completed(&config);
        assert!(
            !replacements.consume("task-child"),
            "legacy replacement entry should have been consumed"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_applies_unattached_busy_as_working() {
        let unique = unique_name("terminal-watcher-unattached-busy");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_falls_back_to_legacy_stream_when_versioned_subscribe_is_rejected() {
        let unique = unique_name("terminal-watcher-legacy-subscription");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (versioned_stream, _) = listener.accept().await.unwrap();
            let (versioned_read, mut versioned_write) = versioned_stream.into_split();
            let mut versioned_reader = BufReader::new(versioned_read);
            let mut line = String::new();
            versioned_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::SubscribeEvents { .. }
            ));
            write_event(
                &mut versioned_write,
                &DaemonEvent::Error {
                    code: None,
                    message: "unknown command".to_string(),
                },
            )
            .await;

            let (subscriber_stream, _) = listener.accept().await.unwrap();
            let (subscriber_read, mut subscriber_write) = subscriber_stream.into_split();
            let mut subscriber_reader = BufReader::new(subscriber_read);
            line.clear();
            subscriber_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));
            write_event(&mut subscriber_write, &DaemonEvent::Ok).await;

            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            line.clear();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: Vec::new(),
                    capabilities: None,
                },
            )
            .await;
            write_event(&mut subscriber_write, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_keeps_legacy_exit_after_legacy_ack_until_versioned_ack() {
        let unique = unique_name("terminal-watcher-legacy-post-ack-exit");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (versioned_stream, _) = listener.accept().await.unwrap();
            let (versioned_read, mut versioned_write) = versioned_stream.into_split();
            let mut versioned_reader = BufReader::new(versioned_read);
            let mut line = String::new();
            versioned_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::SubscribeEvents { .. }
            ));

            let (legacy_stream, _) = listener.accept().await.unwrap();
            let (legacy_read, mut legacy_write) = legacy_stream.into_split();
            let mut legacy_reader = BufReader::new(legacy_read);
            line.clear();
            legacy_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));

            write_event(&mut legacy_write, &DaemonEvent::Ok).await;
            write_event(
                &mut legacy_write,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-current".to_string()),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            )
            .await;
            tokio::task::yield_now().await;
            write_event(&mut versioned_write, &DaemonEvent::Ok).await;

            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            line.clear();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: Vec::new(),
                    capabilities: Some(kanna_daemon::protocol::DaemonCapabilities::current()),
                },
            )
            .await;
            write_event(&mut versioned_write, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        let item = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_buffers_legacy_exit_between_versioned_close_and_subscribe_ack() {
        let unique = unique_name("terminal-watcher-legacy-negotiation-exit");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (versioned_stream, _) = listener.accept().await.unwrap();
            let (versioned_read, mut versioned_write) = versioned_stream.into_split();
            let mut versioned_reader = BufReader::new(versioned_read);
            let mut line = String::new();
            versioned_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::SubscribeEvents { .. }
            ));
            write_event(
                &mut versioned_write,
                &DaemonEvent::Error {
                    code: None,
                    message: "unknown command".to_string(),
                },
            )
            .await;
            drop(versioned_write);

            let (legacy_stream, _) = listener.accept().await.unwrap();
            let (legacy_read, mut legacy_write) = legacy_stream.into_split();
            let mut legacy_reader = BufReader::new(legacy_read);
            line.clear();
            legacy_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));
            write_event(
                &mut legacy_write,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    run_id: None,
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            )
            .await;
            write_event(&mut legacy_write, &DaemonEvent::Ok).await;

            let Ok(Ok((control_stream, _))) =
                timeout(Duration::from_secs(2), listener.accept()).await
            else {
                return;
            };
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            line.clear();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: Vec::new(),
                    capabilities: None,
                },
            )
            .await;
            write_event(&mut legacy_write, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        let item = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_applies_unattached_idle_from_working_as_unread() {
        let unique = unique_name("terminal-watcher-unattached-idle");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "working")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_applies_attached_busy_as_working() {
        let unique = unique_name("terminal-watcher-attached-busy");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "unread")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();
        let _attachment = state.terminal_attachments().attach("task-child");

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_skips_attached_idle_status() {
        let unique = unique_name("terminal-watcher-attached-idle");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "working")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let _attachment = state.terminal_attachments().attach("task-child");

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn final_detach_reconciliation_lists_once_and_applies_session_status() {
        let unique = unique_name("terminal-detach-reconcile");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "working")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let detached = state
            .terminal_attachments()
            .take_detach_receiver()
            .expect("detach receiver should be available");
        let worker = tokio::spawn(terminal_detach_reconciliation_loop(
            Arc::clone(&state),
            detached,
        ));
        let attachment = state.terminal_attachments().attach("task-child");

        let server = tokio::spawn(async move {
            let (stream, _) = timeout(Duration::from_secs(2), listener.accept())
                .await
                .expect("detach reconciliation did not connect")
                .unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut write_half,
                &DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-child".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: kanna_daemon::protocol::SessionStatus::Idle,
                        kind: Default::default(),
                        run_id: None,
                    }],
                    capabilities: None,
                },
            )
            .await;

            assert!(timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err());
        });

        drop(attachment);
        server.await.unwrap();
        worker.abort();
        let _ = worker.await;

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn detach_reconciliation_is_skipped_while_refcount_is_positive() {
        let unique = unique_name("terminal-detach-still-attached");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let _attachment = state.terminal_attachments().attach("task-child");

        reconcile_detached_terminal_status(&state, "task-child")
            .await
            .unwrap();
        assert!(timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err());

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("idle"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_reconciles_unattached_status_from_subscribe_time_list() {
        let unique = unique_name("terminal-watcher-list-reconcile");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe_with_sessions(
                &listener,
                vec![SessionInfo {
                    session_id: "task-child".to_string(),
                    pid: 42,
                    cwd: "/tmp".to_string(),
                    state: SessionState::Active,
                    idle_seconds: 0,
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    kind: Default::default(),
                    run_id: None,
                }],
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_preserves_provider_event_emitted_before_list_reconciliation() {
        let unique = unique_name("terminal-watcher-list-interleaved-status");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("opencode"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (subscriber_stream, _) = listener.accept().await.unwrap();
            let (subscriber_read, mut subscriber_write) = subscriber_stream.into_split();
            let mut subscriber_reader = BufReader::new(subscriber_read);
            let mut line = String::new();
            subscriber_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::SubscribeEvents {
                    version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION
                }
            ));
            write_event(&mut subscriber_write, &DaemonEvent::Ok).await;

            let (legacy_stream, _) = listener.accept().await.unwrap();
            let (legacy_read, mut legacy_write) = legacy_stream.into_split();
            let mut legacy_reader = BufReader::new(legacy_read);
            line.clear();
            legacy_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));
            write_event(&mut legacy_write, &DaemonEvent::Ok).await;

            write_event(
                &mut subscriber_write,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-current".to_string()),
                    provider_session_id: "provider-before-list".to_string(),
                },
            )
            .await;

            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            line.clear();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-child".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: kanna_daemon::protocol::SessionStatus::Busy,
                        kind: Default::default(),
                        run_id: None,
                    }],
                    capabilities: Some(kanna_daemon::protocol::DaemonCapabilities::current()),
                },
            )
            .await;
            write_event(&mut subscriber_write, &DaemonEvent::ShuttingDown).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        assert_task_agent_session_id(&config, "provider-before-list");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }
}
