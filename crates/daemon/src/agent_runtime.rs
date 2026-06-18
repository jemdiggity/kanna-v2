//! Async orchestration for agent sessions: command handlers, reader threads,
//! journal fan-out. The data structures live in `kanna_daemon::agent`.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write as IoWrite};
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::{
    AgentEvent, InterruptAction, PermissionDecision, SessionEndReason, TurnModel,
};
use kanna_daemon::agent::{
    self, event_status, params_to_ctx, AgentClientWriter, AgentJournal, AgentSessionRecord,
    AgentSessions, AgentShared,
};
use kanna_daemon::protocol::{self, AgentSpawnParams, Event, SessionState, SessionStatus};

use crate::socket::write_event;

fn agent_error(code: protocol::ErrorCode, message: impl Into<String>) -> Event {
    Event::Error {
        code: Some(code),
        message: message.into(),
    }
}

async fn reply(writer: &AgentClientWriter, event: &Event) {
    let _ = write_event(&mut *writer.lock().await, event).await;
}

fn broadcast_event(broadcast_tx: &broadcast::Sender<String>, event: &Event) {
    if let Ok(json) = serde_json::to_string(event) {
        let _ = broadcast_tx.send(json);
    }
}

/// Write an event to every attached writer, dropping writers that fail.
async fn fan_out(writers: &mut Vec<AgentClientWriter>, event: &Event) {
    let mut alive = Vec::with_capacity(writers.len());
    for writer in writers.drain(..) {
        let ok = write_event(&mut *writer.lock().await, event).await.is_ok();
        if ok {
            alive.push(writer);
        }
    }
    *writers = alive;
}

/// Append an event to the session's journal and stream it to attached
/// clients. Returns the assigned seq.
async fn journal_and_fan_out(
    session_id: &str,
    shared: &Arc<Mutex<AgentShared>>,
    event: AgentEvent,
) -> u64 {
    let mut sh = shared.lock().await;
    let entry = sh.journal.append(event);
    let wire = Event::AgentEvent {
        session_id: session_id.to_string(),
        seq: entry.seq,
        event: entry.event,
    };
    fan_out(&mut sh.writers, &wire).await;
    entry.seq
}

fn set_status(
    record: &mut AgentSessionRecord,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
) {
    if record.status == status {
        return;
    }
    record.status = status;
    broadcast_event(
        broadcast_tx,
        &Event::StatusChanged {
            session_id: session_id.to_string(),
            status,
        },
    );
}

/// Spawn the stdout + stderr reader threads for a (re)spawned agent child.
pub fn start_agent_readers(
    session_id: String,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
) {
    {
        let session_id = session_id.clone();
        let agents = agents.clone();
        let broadcast_tx = broadcast_tx.clone();
        tokio::task::spawn_blocking(move || {
            run_agent_reader(session_id, Box::new(stdout), false, agents, broadcast_tx);
        });
    }
    tokio::task::spawn_blocking(move || {
        run_agent_reader(session_id, Box::new(stderr), true, agents, broadcast_tx);
    });
}

fn run_agent_reader(
    session_id: String,
    reader: Box<dyn Read + Send>,
    is_stderr: bool,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
) {
    let rt = tokio::runtime::Handle::current();
    log::info!(
        "[agent] reader start session={} stderr={}",
        session_id,
        is_stderr
    );

    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let events = if is_stderr {
            vec![AgentEvent::Diagnostic { message: line }]
        } else {
            let adapter = rt.block_on(async {
                agents
                    .lock()
                    .await
                    .get(&session_id)
                    .map(|record| record.adapter.clone())
            });
            let Some(adapter) = adapter else {
                // Session removed (killed) — stop reading.
                return;
            };
            let mut guard = match adapter.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.parse_line(&line)
        };

        for event in events {
            rt.block_on(process_event(&session_id, event, &agents, &broadcast_tx));
        }
    }

    log::info!(
        "[agent] reader eof session={} stderr={}",
        session_id,
        is_stderr
    );
    if !is_stderr {
        rt.block_on(handle_child_exit(&session_id, &agents, &broadcast_tx));
    }
}

async fn process_event(
    session_id: &str,
    event: AgentEvent,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    // Registry pass: capture provider session id, permission bookkeeping,
    // status derivation, auto-allow.
    let mut auto_resolve: Option<String> = None;
    let mut provider_session_to_persist: Option<String> = None;
    let shared = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(session_id) else {
            return;
        };
        record.last_activity_at = std::time::Instant::now();

        {
            let provider_session_id = match record.adapter.lock() {
                Ok(adapter) => adapter.provider_session_id(),
                Err(poisoned) => poisoned.into_inner().provider_session_id(),
            };
            if provider_session_id.is_some() {
                record.provider_session_id = provider_session_id.clone();
                provider_session_to_persist = provider_session_id;
            }
        }

        match &event {
            AgentEvent::PermissionRequest {
                request_id,
                tool_name,
                ..
            } => {
                if record.session_allowed_tools.contains(tool_name) {
                    let line = match record.adapter.lock() {
                        Ok(mut adapter) => adapter
                            .encode_permission_response(request_id, &PermissionDecision::Allow),
                        Err(poisoned) => poisoned
                            .into_inner()
                            .encode_permission_response(request_id, &PermissionDecision::Allow),
                    };
                    if let (Some(line), Some(stdin)) = (line, record.stdin.as_mut()) {
                        if writeln!(stdin, "{line}")
                            .and_then(|_| stdin.flush())
                            .is_ok()
                        {
                            auto_resolve = Some(request_id.clone());
                        }
                    }
                }
                if auto_resolve.is_none() {
                    record.pending_permissions.insert(request_id.clone());
                }
            }
            AgentEvent::PermissionResolved { request_id, .. } => {
                record.pending_permissions.remove(request_id);
            }
            _ => {}
        }

        if let Some(next) = event_status(&event) {
            // An auto-approved request never surfaces as Waiting.
            let next = if auto_resolve.is_some() {
                SessionStatus::Busy
            } else {
                next
            };
            set_status(record, broadcast_tx, session_id, next);
        }

        record.shared.clone()
    };

    if let Some(provider_session_id) = provider_session_to_persist {
        let mut sh = shared.lock().await;
        sh.journal.set_provider_session_id(&provider_session_id);
    }

    journal_and_fan_out(session_id, &shared, event).await;
    if let Some(request_id) = auto_resolve {
        journal_and_fan_out(
            session_id,
            &shared,
            AgentEvent::PermissionResolved {
                request_id,
                decision: PermissionDecision::AllowSession,
            },
        )
        .await;
    }
}

async fn handle_child_exit(
    session_id: &str,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    let (shared, code, per_turn, interrupted) = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(session_id) else {
            return;
        };
        let code = record
            .child
            .as_mut()
            .and_then(|child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        record.child = None;
        record.stdin = None;
        record.exited = true;
        let interrupted = std::mem::replace(&mut record.interrupt_requested, false);
        if let Some(fds) = record.handoff_fds.take() {
            fds.close();
        }
        set_status(record, broadcast_tx, session_id, SessionStatus::Idle);
        let per_turn = matches!(record.turn_model, TurnModel::PerTurn);
        (record.shared.clone(), code, per_turn, interrupted)
    };

    // A user-initiated stop signals the child to exit; surface it as an
    // interruption (never a crash) and end the turn so the UI stops showing
    // activity. Per-turn sessions stay usable — the next message respawns the
    // provider.
    let reason = if interrupted {
        SessionEndReason::Interrupted
    } else if per_turn && code == 0 {
        // Per-turn providers exit after every turn by design — process churn is
        // an implementation detail, not a session event.
        return;
    } else if code == 0 {
        SessionEndReason::Completed
    } else {
        SessionEndReason::Crashed
    };
    journal_and_fan_out(
        session_id,
        &shared,
        AgentEvent::SessionEnded {
            reason,
            exit_code: Some(code),
            message: None,
        },
    )
    .await;
    broadcast_event(
        broadcast_tx,
        &Event::Exit {
            session_id: session_id.to_string(),
            code,
            resume_session_id: None,
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub async fn handle_spawn_agent(
    session_id: String,
    params: AgentSpawnParams,
    writer: AgentClientWriter,
    broadcast_tx: broadcast::Sender<String>,
    agents: AgentSessions,
    data_dir: std::path::PathBuf,
) {
    if agents.lock().await.contains_key(&session_id) {
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

    log::info!(
        "[agent] spawn session={} provider={:?} cwd={}",
        session_id,
        params.agent_provider,
        params.cwd
    );

    let spawned = match agent::spawn_agent_child(&spec, &params.cwd, &params.env) {
        Ok(spawned) => spawned,
        Err(error) => {
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

    let mut journal = AgentJournal::open(&data_dir, &session_id);
    // The provider does not echo the initiating prompt — journal it so the
    // conversation record is complete.
    journal.append(AgentEvent::UserMessage {
        text: params.prompt.clone(),
    });

    let shared = Arc::new(Mutex::new(AgentShared {
        journal,
        writers: Vec::new(),
    }));

    let record = AgentSessionRecord {
        provider: params.agent_provider,
        params,
        adapter: Arc::new(std::sync::Mutex::new(adapter)),
        shared,
        child: Some(spawned.child),
        stdin: spawned.stdin,
        pid: spawned.pid,
        provider_session_id: None,
        status: SessionStatus::Busy,
        session_allowed_tools: HashSet::new(),
        pending_permissions: HashSet::new(),
        exited: false,
        interrupt_requested: false,
        turn_model,
        created_at: std::time::Instant::now(),
        last_activity_at: std::time::Instant::now(),
        handoff_fds: spawned.handoff_fds,
    };
    agents.lock().await.insert(session_id.clone(), record);

    start_agent_readers(
        session_id.clone(),
        spawned.stdout,
        spawned.stderr,
        agents,
        broadcast_tx.clone(),
    );

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
        },
    );
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
        Respawn(kanna_agent_protocol::SpawnSpec),
    }

    let (plan, shared) = {
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
            Plan::Respawn(spec)
        };
        (plan, registry.get(&session_id).map(|r| r.shared.clone()))
    };

    let Some(shared) = shared else { return };

    match plan {
        Plan::StdinLine(line) => {
            let write_result = {
                let mut registry = agents.lock().await;
                let Some(record) = registry.get_mut(&session_id) else {
                    return;
                };
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
        Plan::Respawn(spec) => {
            let (cwd, env) = {
                let registry = agents.lock().await;
                let Some(record) = registry.get(&session_id) else {
                    return;
                };
                (record.params.cwd.clone(), record.params.env.clone())
            };
            match agent::spawn_agent_child(&spec, &cwd, &env) {
                Ok(spawned) => {
                    {
                        let mut registry = agents.lock().await;
                        let Some(record) = registry.get_mut(&session_id) else {
                            return;
                        };
                        record.child = Some(spawned.child);
                        record.stdin = spawned.stdin;
                        record.pid = spawned.pid;
                        record.exited = false;
                        if let Some(stale) = record.handoff_fds.take() {
                            stale.close();
                        }
                        record.handoff_fds = spawned.handoff_fds;
                    }
                    start_agent_readers(
                        session_id.clone(),
                        spawned.stdout,
                        spawned.stderr,
                        agents.clone(),
                        broadcast_tx.clone(),
                    );
                }
                Err(error) => {
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

    journal_and_fan_out(&session_id, &shared, AgentEvent::UserMessage { text }).await;
    {
        let mut registry = agents.lock().await;
        if let Some(record) = registry.get_mut(&session_id) {
            set_status(record, &broadcast_tx, &session_id, SessionStatus::Busy);
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

        set_status(record, &broadcast_tx, &session_id, SessionStatus::Busy);
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
                    // surfaced as an interruption, not a crash.
                    record.interrupt_requested = true;
                    agent::signal_agent_pid(record.pid, libc::SIGINT)
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

/// Kill an agent session (task close): SIGKILL the child's process group,
/// journal the end, drop the record. The journal file stays on disk until
/// task cleanup.
pub async fn kill_agent_session(
    session_id: &str,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) -> bool {
    let record = agents.lock().await.remove(session_id);
    let Some(mut record) = record else {
        return false;
    };
    if !record.exited {
        let _ = agent::signal_agent_pid(record.pid, libc::SIGKILL);
        if let Some(mut child) = record.child.take() {
            let _ = child.wait();
        }
    }
    if let Some(fds) = record.handoff_fds.take() {
        fds.close();
    }
    let mut sh = record.shared.lock().await;
    let entry = sh.journal.append(AgentEvent::SessionEnded {
        reason: SessionEndReason::Interrupted,
        exit_code: None,
        message: Some("session killed".to_string()),
    });
    let wire = Event::AgentEvent {
        session_id: session_id.to_string(),
        seq: entry.seq,
        event: entry.event,
    };
    fan_out(&mut sh.writers, &wire).await;
    broadcast_event(
        broadcast_tx,
        &Event::StatusChanged {
            session_id: session_id.to_string(),
            status: SessionStatus::Idle,
        },
    );
    true
}

/// Merge agent sessions into a List response.
pub async fn agent_session_infos(agents: &AgentSessions) -> Vec<protocol::SessionInfo> {
    let mut registry = agents.lock().await;
    registry
        .iter_mut()
        .map(|(id, record)| {
            let state = if record.exited {
                // Per-turn providers idle between turns; report active so the
                // session isn't reaped as dead.
                if record.turn_model == TurnModel::PerTurn {
                    SessionState::Active
                } else {
                    SessionState::Exited(-1)
                }
            } else {
                SessionState::Active
            };
            protocol::SessionInfo {
                session_id: id.clone(),
                pid: record.pid,
                cwd: record.params.cwd.clone(),
                state,
                idle_seconds: record.last_activity_at.elapsed().as_secs(),
                status: record.status,
                kind: protocol::SessionKind::Agent,
            }
        })
        .collect()
}

/// Remove a dropped client's writer from all agent sessions.
pub async fn cleanup_agent_writer(agents: &AgentSessions, writer: &AgentClientWriter) {
    let shareds: Vec<Arc<Mutex<AgentShared>>> = {
        let registry = agents.lock().await;
        registry.values().map(|r| r.shared.clone()).collect()
    };
    let writer_ptr = Arc::as_ptr(writer) as usize;
    for shared in shareds {
        let mut sh = shared.lock().await;
        sh.writers.retain(|w| Arc::as_ptr(w) as usize != writer_ptr);
    }
}

/// Adopt an agent session transferred from the old daemon: reopen the
/// journal from disk (the old daemon flushed every append), rebuild the
/// adapter, and — unlike adopted PTY sessions — restart the readers
/// immediately, because the journal must capture output while detached.
///
/// Call only after the old daemon has exited: its blocked reader threads
/// hold the same pipes until then.
pub async fn adopt_agent_session(
    info: protocol::HandoffSession,
    fds: Vec<std::os::unix::io::RawFd>,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
    data_dir: std::path::PathBuf,
) {
    use std::os::unix::io::FromRawFd;

    let close_fds = |fds: &[std::os::unix::io::RawFd]| {
        for fd in fds {
            unsafe { libc::close(*fd) };
        }
    };

    let Some(params) = info.agent_spawn else {
        log::error!(
            "[agent] adopted session {} has no spawn params; dropping",
            info.session_id
        );
        close_fds(&fds);
        return;
    };
    let Some(adapter) = agent::make_adapter(params.agent_provider) else {
        log::error!(
            "[agent] adopted session {} has unsupported provider {:?}; dropping",
            info.session_id,
            params.agent_provider
        );
        close_fds(&fds);
        return;
    };
    let turn_model = adapter.turn_model();

    let journal = AgentJournal::open(&data_dir, &info.session_id);
    let provider_session_id = info
        .provider_session_id
        .clone()
        .or_else(|| journal.provider_session_id());
    let pending_permissions = journal.pending_permission_ids();
    let session_allowed_tools = journal.session_allowed_tools();
    let shared = Arc::new(Mutex::new(AgentShared {
        journal,
        writers: Vec::new(),
    }));

    let alive =
        info.agent_fd_count > 0 && fds.len() >= 2 && unsafe { libc::kill(info.pid as i32, 0) } == 0;

    let mut record = AgentSessionRecord {
        provider: params.agent_provider,
        params,
        adapter: Arc::new(std::sync::Mutex::new(adapter)),
        shared,
        child: None,
        stdin: None,
        pid: info.pid,
        provider_session_id,
        status: if alive {
            info.status
        } else {
            SessionStatus::Idle
        },
        session_allowed_tools,
        pending_permissions,
        exited: !alive,
        interrupt_requested: false,
        turn_model,
        created_at: std::time::Instant::now(),
        last_activity_at: std::time::Instant::now(),
        handoff_fds: None,
    };

    if !alive {
        log::info!(
            "[agent] adopted exited session {} (pid={}); resume available via journal",
            info.session_id,
            info.pid
        );
        close_fds(&fds);
        agents.lock().await.insert(info.session_id, record);
        return;
    }

    // Reserve a fresh dup set for the NEXT handoff before wrapping the
    // transferred fds into owned handles.
    let dup_bundle = (|| -> std::io::Result<agent::AgentHandoffFds> {
        Ok(agent::AgentHandoffFds {
            stdout: agent::dup_cloexec(fds[0])?,
            stderr: agent::dup_cloexec(fds[1])?,
            stdin: match fds.get(2) {
                Some(fd) => Some(agent::dup_cloexec(*fd)?),
                None => None,
            },
        })
    })();
    record.handoff_fds = match dup_bundle {
        Ok(bundle) => Some(bundle),
        Err(error) => {
            log::warn!(
                "[agent] adopted session {}: failed to reserve handoff dups: {}",
                info.session_id,
                error
            );
            None
        }
    };

    let stdout =
        std::process::ChildStdout::from(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fds[0]) });
    let stderr =
        std::process::ChildStderr::from(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fds[1]) });
    record.stdin = fds.get(2).map(|fd| {
        std::process::ChildStdin::from(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(*fd) })
    });

    log::info!(
        "[agent] adopted live session {} (pid={}, provider={:?})",
        info.session_id,
        info.pid,
        record.provider
    );
    let session_id = info.session_id.clone();
    agents.lock().await.insert(info.session_id, record);
    start_agent_readers(session_id, stdout, stderr, agents, broadcast_tx);
}

/// Detach one client's writer from one agent session.
pub async fn detach_agent_writer(
    agents: &AgentSessions,
    session_id: &str,
    writer: &AgentClientWriter,
) -> bool {
    let shared = {
        let registry = agents.lock().await;
        match registry.get(session_id) {
            Some(record) => record.shared.clone(),
            None => return false,
        }
    };
    let writer_ptr = Arc::as_ptr(writer) as usize;
    let mut sh = shared.lock().await;
    sh.writers.retain(|w| Arc::as_ptr(w) as usize != writer_ptr);
    true
}
