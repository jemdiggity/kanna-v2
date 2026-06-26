use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::AgentEvent;
use kanna_daemon::agent::{
    self, params_to_ctx, AgentClientWriter, AgentJournal, AgentSessionRecord, AgentSessions,
    AgentShared,
};
use kanna_daemon::protocol::{self, AgentSpawnParams, Event, SessionStatus};

use crate::agent_runtime::common::{agent_error, broadcast_event, reply};
use crate::agent_runtime::reader::start_agent_readers;
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
