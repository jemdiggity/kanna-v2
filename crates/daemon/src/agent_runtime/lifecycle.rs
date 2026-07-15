use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::{AgentEvent, SessionEndReason, TurnModel};
use kanna_daemon::agent::{self, AgentClientWriter, AgentSessions, AgentShared};
use kanna_daemon::protocol::{self, Event, SessionState, SessionStatus};

use super::{broadcast_event, fan_out};

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
        // An exited session already broadcast its Exit from the reader; a
        // live session killed here never reaches that path, so announce the
        // death now. Every termination must broadcast exactly one Exit —
        // consume-once kill orchestration (SessionReplacements) depends on it.
        broadcast_event(
            broadcast_tx,
            &Event::Exit {
                session_id: session_id.to_string(),
                code: -1,
                resume_session_id: None,
                killed: true,
            },
        );
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
            waiting_prompt_snippet: None,
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
