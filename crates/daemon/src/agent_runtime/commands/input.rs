use std::io::Write as IoWrite;

use tokio::sync::broadcast;

use kanna_agent_protocol::{AgentEvent, PermissionDecision, TurnModel};
use kanna_daemon::agent::{self, params_to_ctx, AgentClientWriter, AgentSessions};
use kanna_daemon::protocol::{self, Event, SessionStatus};

use crate::agent_runtime::common::{agent_error, journal_and_fan_out, reply, set_status};
use crate::agent_runtime::reader::start_agent_readers;

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
