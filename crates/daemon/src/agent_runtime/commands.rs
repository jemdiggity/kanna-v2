use std::collections::HashSet;
use std::io::Write as IoWrite;
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::{AgentEvent, InterruptAction, PermissionDecision, TurnModel};
use kanna_daemon::agent::{
    self, params_to_ctx, AgentClientWriter, AgentJournal, AgentSessionRecord, AgentSessions,
    AgentShared,
};
use kanna_daemon::protocol::{self, AgentSpawnParams, Event, SessionStatus};

use super::common::{agent_error, broadcast_event, journal_and_fan_out, reply, set_status};
use super::reader::start_agent_readers;
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
