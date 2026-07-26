use std::collections::HashSet;
use std::io::Write as IoWrite;
use std::sync::Arc;

use tokio::sync::broadcast;

use kanna_agent_protocol::{AgentEvent, InterruptAction, PermissionDecision, TurnModel};
use kanna_daemon::agent::{
    self, params_to_ctx, AgentClientWriter, AgentSessionRecord, AgentSessions,
};
use kanna_daemon::protocol::{self, AgentSpawnParams, Event, SessionStatus};

use super::readers::start_agent_readers;
use super::{agent_error, broadcast_event, journal_and_fan_out, log_info, reply, set_status};
use crate::socket::write_event;

#[allow(clippy::too_many_arguments)]
pub async fn handle_spawn_agent(
    session_id: String,
    params: AgentSpawnParams,
    writer: AgentClientWriter,
    broadcast_tx: broadcast::Sender<String>,
    agents: AgentSessions,
    data_dir: std::path::PathBuf,
) {
    let Some(adapter) = agent::make_adapter(params.agent_provider) else {
        reply(
            &writer,
            &agent_error(
                protocol::ErrorCode::AgentSpawnFailed,
                format!(
                    "provider {:?} has no headless adapter",
                    params.agent_provider
                ),
            ),
        )
        .await;
        return;
    };

    let ctx = params_to_ctx(&params);
    let mut spec = adapter.initial_spawn(&ctx);
    if let Some(executable) = &params.executable {
        spec.executable = executable.clone();
    }
    let turn_model = adapter.turn_model();

    // One journal (one sequence space) per session id — see
    // `shared_agent_state`. Resolve the handle now but do NOT append yet: the
    // initiating UserMessage must only enter the journal once this caller has
    // actually WON the id. Appending first would let a rejected duplicate
    // spawn, or a seal-rejected retry, contaminate the winner's transcript.
    let shared = agent::shared_agent_state(&data_dir, &session_id);
    let initiating_prompt = params.prompt.clone();

    // Reserve the id atomically: the existence check and the reservation
    // record land under one lock acquisition, so a concurrent SpawnAgent for
    // the same id is rejected instead of racing to a double spawn. The
    // reservation carries a fresh, never-reused incarnation; the install
    // below only proceeds while that exact incarnation still owns the slot
    // (a Kill in between removes it, and the spawned loser is cleaned up).
    let incarnation = agent::next_agent_incarnation();
    let (cwd, env) = (params.cwd.clone(), params.env.clone());
    {
        let mut registry = agents.lock().await;
        // Seal check and reservation must be atomic: a seal observed after we
        // reserve would leave a ghost the transfer cannot carry.
        if super::agent_handoff_sealed() {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::AgentSpawnFailed,
                    format!(
                        "daemon handoff in progress; retry agent session {session_id} against the new daemon"
                    ),
                ),
            )
            .await;
            return;
        }
        if registry.contains_key(&session_id) {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionAlreadyExists,
                    format!("agent session already exists: {session_id}"),
                ),
            )
            .await;
            return;
        }
        registry.insert(
            session_id.clone(),
            AgentSessionRecord {
                provider: params.agent_provider,
                params,
                adapter: Arc::new(std::sync::Mutex::new(adapter)),
                shared: shared.clone(),
                child: None,
                stdin: None,
                pid: 0,
                child_start: None,
                incarnation,
                spawning: true,
                reservation_is_initial: true,
                provider_session_id: None,
                status: SessionStatus::Busy,
                last_assistant_prompt: None,
                session_allowed_tools: HashSet::new(),
                pending_permissions: HashSet::new(),
                exited: true,
                exit_published: false,
                interrupt_requested: false,
                turn_model,
                created_at: std::time::Instant::now(),
                last_activity_at: std::time::Instant::now(),
                handoff_fds: None,
            },
        );
    }

    // The id is ours: only now does the initiating prompt belong in the
    // journal.
    shared.lock().await.journal.append(AgentEvent::UserMessage {
        text: initiating_prompt,
    });

    log_info(format_args!(
        "[agent] spawn session={} incarnation={} cwd={}",
        session_id, incarnation, cwd
    ));

    let spawned = match agent::spawn_agent_child(&spec, &cwd, &env) {
        Ok(spawned) => spawned,
        Err(error) => {
            // Release the reservation so the id becomes usable again —
            // unless something else already owns the slot.
            {
                let mut registry = agents.lock().await;
                if registry
                    .get(&session_id)
                    .is_some_and(|record| record.incarnation == incarnation)
                {
                    registry.remove(&session_id);
                }
            }
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::AgentSpawnFailed,
                    format!("failed to spawn agent: {error}"),
                ),
            )
            .await;
            return;
        }
    };

    let Some((life, stdout, stderr)) =
        install_respawned_child(&session_id, incarnation, spawned, &agents).await
    else {
        // The session was killed (or the registry sealed for handoff) while
        // the child was spawning; the loser has been cleaned up.
        reply(
            &writer,
            &agent_error(
                protocol::ErrorCode::SessionNotFound,
                format!("agent session {session_id} was closed during spawn"),
            ),
        )
        .await;
        return;
    };

    start_agent_readers(life, stdout, stderr, agents, broadcast_tx.clone());

    let created = Event::SessionCreated {
        session_id: session_id.clone(),
    };
    reply(&writer, &created).await;
    broadcast_event(&broadcast_tx, &created);
    broadcast_event(
        &broadcast_tx,
        &Event::StatusChanged {
            session_id,
            status: SessionStatus::Busy,
            waiting_prompt_snippet: None,
        },
    );
}

/// Install a freshly (re)spawned child into its session record, but only
/// while the reserving incarnation still owns the record and the registry
/// has not been sealed for handoff. A session removed (killed), recreated
/// (fresh incarnation — no ABA), or sealed during the spawn leaves an orphan
/// child — it is SIGKILLed, reaped, and its handoff dups closed here instead
/// of leaking. When the reservation is rejected only because the registry was
/// sealed for handoff, the reservation is rolled back (`spawning = false`) so
/// an aborted handoff cannot leave the session permanently refusing resumes.
/// Returns the installed child's reader life plus its pipes.
pub(crate) async fn install_respawned_child(
    session_id: &str,
    incarnation: u64,
    spawned: agent::SpawnedAgentChild,
    agents: &AgentSessions,
) -> Option<(
    super::readers::ReaderLife,
    std::process::ChildStdout,
    std::process::ChildStderr,
)> {
    let agent::SpawnedAgentChild {
        child,
        stdin,
        stdout,
        stderr,
        pid,
        child_start,
        handoff_fds,
    } = spawned;

    enum InstallOutcome {
        Installed(super::readers::ReaderLife),
        Orphan(std::process::Child, Option<agent::AgentHandoffFds>),
    }

    let outcome = {
        let mut registry = agents.lock().await;
        let sealed = super::agent_handoff_sealed();
        match registry.get_mut(session_id) {
            Some(record) if record.incarnation == incarnation && !sealed => {
                // A previous per-turn child may still be running; reap it in
                // the background so it never zombifies (its readers are gated
                // by their older incarnation).
                let previous_start = record.child_start;
                if let Some(previous) = record.child.take() {
                    if let Err(error) =
                        kanna_daemon::reaper::try_reap_child(previous, previous_start)
                    {
                        tokio::spawn(kanna_daemon::reaper::reap(error.into_ownership()));
                    }
                }
                record.child = Some(child);
                record.stdin = stdin;
                record.pid = pid;
                record.child_start = child_start;
                record.exited = false;
                record.spawning = false;
                record.reservation_is_initial = false;
                if let Some(stale) = record.handoff_fds.take() {
                    stale.close();
                }
                record.handoff_fds = handoff_fds;
                InstallOutcome::Installed(super::readers::ReaderLife {
                    session_id: session_id.to_string(),
                    incarnation,
                    adapter: record.adapter.clone(),
                    shared: record.shared.clone(),
                })
            }
            other => {
                // Roll the reservation back when the ONLY reason we lost is
                // the handoff seal: if that handoff then aborts, the session
                // must still accept resumes instead of being wedged with
                // `spawning = true` forever. A superseded/removed record is
                // not ours to touch.
                if sealed {
                    let remove_ghost = match other {
                        Some(record) if record.incarnation == incarnation => {
                            if record.reservation_is_initial {
                                // No child, no pid, no provider session id: a
                                // rollback would leave a ghost occupying the
                                // id that can neither resume nor transfer.
                                true
                            } else {
                                record.spawning = false;
                                log_info(format_args!(
                                    "[agent] session {session_id}: rolled back resume reservation \
                                     rejected by the handoff seal"
                                ));
                                false
                            }
                        }
                        _ => false,
                    };
                    if remove_ghost {
                        registry.remove(session_id);
                        log_info(format_args!(
                            "[agent] session {session_id}: removed initial reservation rejected \
                             by the handoff seal"
                        ));
                    }
                }
                InstallOutcome::Orphan(child, handoff_fds)
            }
        }
    };
    match outcome {
        InstallOutcome::Installed(life) => Some((life, stdout, stderr)),
        InstallOutcome::Orphan(orphan, orphan_fds) => {
            log_info(format_args!(
                "[agent] session {} removed, superseded, or sealed during spawn; \
                 killing orphan child {}",
                session_id,
                orphan.id()
            ));
            let _ = agent::kill_agent_group_verified(orphan.id(), child_start);
            if let Err(error) = kanna_daemon::reaper::try_reap_child(orphan, child_start) {
                kanna_daemon::reaper::reap(error.into_ownership()).await;
            }
            if let Some(fds) = orphan_fds {
                fds.close();
            }
            None
        }
    }
}

/// Test-only: run the stdin-delivery and status phases of AgentInput with an
/// explicitly chosen planning incarnation, so a kill+recreate interleaving can
/// be driven deterministically.
#[cfg(test)]
pub(crate) async fn deliver_planned_input_for_test(
    session_id: &str,
    planned_incarnation: u64,
    text: &str,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(session_id) else {
            return;
        };
        if record.incarnation != planned_incarnation {
            log_info(format_args!(
                "[agent] dropping input for session {session_id}: incarnation changed \
                 between planning and stdin write"
            ));
            return;
        }
        if let Some(stdin) = record.stdin.as_mut() {
            let _ = writeln!(stdin, "{text}").and_then(|_| stdin.flush());
        }
    }
    let mut registry = agents.lock().await;
    match registry.get_mut(session_id) {
        Some(record) if record.incarnation == planned_incarnation => {
            set_status(record, broadcast_tx, session_id, SessionStatus::Busy, None);
        }
        _ => {}
    }
}

pub async fn handle_attach_agent(
    session_id: String,
    from_seq: u64,
    writer: AgentClientWriter,
    agents: AgentSessions,
) {
    let shared = {
        let registry = agents.lock().await;
        match registry.get(&session_id) {
            Some(record) => record.shared.clone(),
            None => {
                drop(registry);
                reply(
                    &writer,
                    &agent_error(
                        protocol::ErrorCode::SessionNotFound,
                        format!("agent session not found: {session_id}"),
                    ),
                )
                .await;
                return;
            }
        }
    };

    // Snapshot and writer registration under one lock: no event can be
    // appended between the snapshot and joining the live stream.
    let mut sh = shared.lock().await;
    let snapshot = Event::AgentSnapshot {
        session_id: session_id.clone(),
        next_seq: sh.journal.next_seq(),
        events: sh.journal.events_from(from_seq),
    };
    if write_event(&mut *writer.lock().await, &snapshot)
        .await
        .is_err()
    {
        return;
    }
    let writer_ptr = Arc::as_ptr(&writer) as usize;
    if !sh
        .writers
        .iter()
        .any(|w| Arc::as_ptr(w) as usize == writer_ptr)
    {
        sh.writers.push(writer);
    }
}

pub async fn handle_agent_input(
    session_id: String,
    text: String,
    writer: AgentClientWriter,
    broadcast_tx: broadcast::Sender<String>,
    agents: AgentSessions,
) {
    enum Plan {
        StdinLine(String),
        Respawn(kanna_agent_protocol::SpawnSpec, u64),
    }

    let (plan, shared, planned_incarnation) = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(&session_id) else {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionNotFound,
                    format!("agent session not found: {session_id}"),
                ),
            )
            .await;
            return;
        };

        // Every later phase (stdin write, journaling, status mutation) is
        // gated on the incarnation observed here, so a kill+recreate of the
        // same session id mid-flight can neither deliver this input to the
        // replacement child nor mark it Busy.
        let planned_incarnation = record.incarnation;
        let live_stdin =
            !record.exited && record.stdin.is_some() && record.turn_model == TurnModel::Persistent;
        let plan = if live_stdin {
            let line = match record.adapter.lock() {
                Ok(mut adapter) => adapter.encode_input(&text),
                Err(poisoned) => poisoned.into_inner().encode_input(&text),
            };
            match line {
                Some(line) => Plan::StdinLine(line),
                None => {
                    drop(registry);
                    reply(
                        &writer,
                        &agent_error(
                            protocol::ErrorCode::WriteFailed,
                            "provider does not accept stdin input",
                        ),
                    )
                    .await;
                    return;
                }
            }
        } else {
            // Resume-respawn: per-turn providers take this path for every
            // message; persistent providers after a crash/exit.
            let Some(provider_session_id) = record.provider_session_id.clone() else {
                drop(registry);
                reply(
                    &writer,
                    &agent_error(
                        protocol::ErrorCode::WriteFailed,
                        "agent session has no provider session id to resume",
                    ),
                )
                .await;
                return;
            };
            if record.spawning {
                drop(registry);
                reply(
                    &writer,
                    &agent_error(
                        protocol::ErrorCode::WriteFailed,
                        "agent resume already in progress; retry after it completes",
                    ),
                )
                .await;
                return;
            }
            let ctx = params_to_ctx(&record.params);
            let mut spec = match record.adapter.lock() {
                Ok(adapter) => adapter.resume_spawn(&ctx, &provider_session_id, &text),
                Err(poisoned) => {
                    poisoned
                        .into_inner()
                        .resume_spawn(&ctx, &provider_session_id, &text)
                }
            };
            if let Some(executable) = &record.params.executable {
                spec.executable = executable.clone();
            }
            // Reserve a fresh, never-reused incarnation under the registry
            // lock: concurrent inputs see `spawning` and are rejected above,
            // and installers/readers holding a stale token can never match a
            // record that was killed and recreated under the same id (no
            // ABA).
            record.spawning = true;
            record.incarnation = agent::next_agent_incarnation();
            Plan::Respawn(spec, record.incarnation)
        };
        let shared = registry.get(&session_id).map(|r| r.shared.clone());
        (plan, shared, planned_incarnation)
    };

    let Some(shared) = shared else { return };

    let delivered_incarnation = match &plan {
        Plan::StdinLine(_) => planned_incarnation,
        Plan::Respawn(_, reserved) => *reserved,
    };
    match plan {
        Plan::StdinLine(line) => {
            let write_result = {
                let mut registry = agents.lock().await;
                let Some(record) = registry.get_mut(&session_id) else {
                    return;
                };
                if record.incarnation != planned_incarnation {
                    // The session was killed and recreated (or respawned)
                    // between planning and writing: this input belongs to the
                    // previous life and must not reach the new child. Answer
                    // the client with a retryable error — never leave the
                    // connection alive with the caller waiting forever.
                    drop(registry);
                    log_info(format_args!(
                        "[agent] dropping input for session {session_id}: incarnation changed \
                         between planning and stdin write"
                    ));
                    reply(
                        &writer,
                        &agent_error(
                            protocol::ErrorCode::SessionNotFound,
                            format!(
                                "agent session {session_id} was replaced while the input was in \
                                 flight; retry against the current session"
                            ),
                        ),
                    )
                    .await;
                    return;
                }
                match record.stdin.as_mut() {
                    Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
                    None => Err(std::io::Error::other("stdin closed")),
                }
            };
            if let Err(error) = write_result {
                reply(
                    &writer,
                    &agent_error(
                        protocol::ErrorCode::WriteFailed,
                        format!("failed to write agent input: {error}"),
                    ),
                )
                .await;
                return;
            }
        }
        Plan::Respawn(spec, generation) => {
            let (cwd, env) = {
                let registry = agents.lock().await;
                match registry.get(&session_id) {
                    Some(record) => (record.params.cwd.clone(), record.params.env.clone()),
                    None => {
                        drop(registry);
                        reply(
                            &writer,
                            &agent_error(
                                protocol::ErrorCode::SessionNotFound,
                                format!("agent session {session_id} disappeared before resuming"),
                            ),
                        )
                        .await;
                        return;
                    }
                }
            };
            match agent::spawn_agent_child(&spec, &cwd, &env) {
                Ok(spawned) => {
                    let Some((life, stdout, stderr)) =
                        install_respawned_child(&session_id, generation, spawned, &agents).await
                    else {
                        // The install lost to a kill/recreate or to the
                        // handoff seal. Both are retryable and both must be
                        // reported: silently returning leaves the client
                        // waiting for a reply that never comes.
                        let sealed = super::agent_handoff_sealed();
                        let (code, message) = if sealed {
                            (
                                protocol::ErrorCode::HandoffLost,
                                format!(
                                    "daemon handoff in progress; retry input for agent session \
                                     {session_id} against the new daemon"
                                ),
                            )
                        } else {
                            (
                                protocol::ErrorCode::SessionNotFound,
                                format!(
                                    "agent session {session_id} was replaced while resuming; \
                                     retry against the current session"
                                ),
                            )
                        };
                        reply(&writer, &agent_error(code, message)).await;
                        return;
                    };
                    start_agent_readers(life, stdout, stderr, agents.clone(), broadcast_tx.clone());
                }
                Err(error) => {
                    // Release the reservation so later inputs can retry.
                    {
                        let mut registry = agents.lock().await;
                        if let Some(record) = registry.get_mut(&session_id) {
                            if record.incarnation == generation {
                                record.spawning = false;
                            }
                        }
                    }
                    reply(
                        &writer,
                        &agent_error(
                            protocol::ErrorCode::AgentSpawnFailed,
                            format!("failed to resume agent: {error}"),
                        ),
                    )
                    .await;
                    return;
                }
            }
        }
    }

    // Journal into the life that actually accepted this input (`shared` was
    // captured at planning time), never into a replacement record's
    // transcript.
    journal_and_fan_out(&session_id, &shared, AgentEvent::UserMessage { text }).await;
    {
        let mut registry = agents.lock().await;
        match registry.get_mut(&session_id) {
            Some(record) if record.incarnation == delivered_incarnation => {
                set_status(
                    record,
                    &broadcast_tx,
                    &session_id,
                    SessionStatus::Busy,
                    None,
                );
            }
            _ => {
                // Killed/recreated/respawned since delivery: marking the
                // current record Busy would attribute this turn to a child
                // that never received it.
                log_info(format_args!(
                    "[agent] skipping Busy status for session {session_id}: incarnation changed \
                     after input delivery"
                ));
            }
        }
    }
    reply(&writer, &Event::Ok).await;
}

pub async fn handle_agent_permission(
    session_id: String,
    request_id: String,
    decision: PermissionDecision,
    writer: AgentClientWriter,
    broadcast_tx: broadcast::Sender<String>,
    agents: AgentSessions,
) {
    let shared = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(&session_id) else {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionNotFound,
                    format!("agent session not found: {session_id}"),
                ),
            )
            .await;
            return;
        };

        // First decision wins; later answers to the same request are stale.
        if !record.pending_permissions.remove(&request_id) {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::UnknownPermissionRequest,
                    format!("no pending permission request: {request_id}"),
                ),
            )
            .await;
            return;
        }

        let line = match record.adapter.lock() {
            Ok(mut adapter) => adapter.encode_permission_response(&request_id, &decision),
            Err(poisoned) => poisoned
                .into_inner()
                .encode_permission_response(&request_id, &decision),
        };
        let Some(line) = line else {
            record.pending_permissions.insert(request_id.clone());
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::NotAgentSession,
                    "provider does not support permission responses",
                ),
            )
            .await;
            return;
        };

        let write_result = match record.stdin.as_mut() {
            Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
            None => Err(std::io::Error::other("stdin closed")),
        };
        if let Err(error) = write_result {
            record.pending_permissions.insert(request_id.clone());
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::WriteFailed,
                    format!("failed to write permission response: {error}"),
                ),
            )
            .await;
            return;
        }

        if let PermissionDecision::AllowSession = &decision {
            // Find the tool name from the journaled request so future
            // matching requests auto-approve.
            let shared = record.shared.clone();
            let tool = {
                let sh = shared.lock().await;
                sh.journal
                    .events_from(0)
                    .into_iter()
                    .rev()
                    .find_map(|entry| match entry.event {
                        AgentEvent::PermissionRequest {
                            request_id: ref id,
                            ref tool_name,
                            ..
                        } if *id == request_id => Some(tool_name.clone()),
                        _ => None,
                    })
            };
            if let Some(tool) = tool {
                record.session_allowed_tools.insert(tool);
            }
        }

        set_status(
            record,
            &broadcast_tx,
            &session_id,
            SessionStatus::Busy,
            None,
        );
        record.shared.clone()
    };

    journal_and_fan_out(
        &session_id,
        &shared,
        AgentEvent::PermissionResolved {
            request_id,
            decision,
        },
    )
    .await;
    reply(&writer, &Event::Ok).await;
}

pub async fn handle_agent_interrupt(
    session_id: String,
    writer: AgentClientWriter,
    agents: AgentSessions,
) {
    let result = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(&session_id) else {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionNotFound,
                    format!("agent session not found: {session_id}"),
                ),
            )
            .await;
            return;
        };

        let action = match record.adapter.lock() {
            Ok(mut adapter) => adapter.encode_interrupt(),
            Err(poisoned) => poisoned.into_inner().encode_interrupt(),
        };
        match action {
            InterruptAction::StdinLine(line) => match record.stdin.as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
                None => Err(std::io::Error::other("stdin closed")),
            },
            InterruptAction::Signal => {
                if record.exited {
                    Ok(())
                } else {
                    // The signal makes the child exit; flag it so the exit is
                    // surfaced as an interruption, not a crash. The signal is
                    // identity-verified: an unprovable or recycled pid is
                    // refused rather than targeted.
                    record.interrupt_requested = true;
                    // `child.is_some()` is the ownership proof: only our own
                    // unreaped fork has a pid that cannot be recycled between
                    // the identity check and delivery. An adopted child is
                    // refused (fail closed) rather than risking an unrelated
                    // process group.
                    let owned = record.child.is_some();
                    agent::signal_agent_pid(record.pid, record.child_start, owned, libc::SIGINT)
                }
            }
        }
    };

    match result {
        Ok(()) => reply(&writer, &Event::Ok).await,
        Err(error) => {
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::WriteFailed,
                    format!("failed to interrupt agent: {error}"),
                ),
            )
            .await
        }
    }
}

/// Switch the agent's model. The new model is stored on the session so any
/// future spawn uses it (the only mechanism for per-turn providers); for live
/// persistent providers, a `set_model` control line is also written to stdin so
/// the change takes effect immediately.
pub async fn handle_agent_set_model(
    session_id: String,
    model: String,
    writer: AgentClientWriter,
    agents: AgentSessions,
) {
    let result = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(&session_id) else {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionNotFound,
                    format!("agent session not found: {session_id}"),
                ),
            )
            .await;
            return;
        };

        record.params.model = Some(model.clone());
        let line = match record.adapter.lock() {
            Ok(mut adapter) => adapter.encode_set_model(&model),
            Err(poisoned) => poisoned.into_inner().encode_set_model(&model),
        };
        match line {
            Some(line) if !record.exited => match record.stdin.as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
                // No live stdin to steer; the stored model covers the next spawn.
                None => Ok(()),
            },
            _ => Ok(()),
        }
    };

    match result {
        Ok(()) => reply(&writer, &Event::Ok).await,
        Err(error) => {
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::WriteFailed,
                    format!("failed to set agent model: {error}"),
                ),
            )
            .await
        }
    }
}
