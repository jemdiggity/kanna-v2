use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::{AgentEvent, SessionEndReason, TurnModel};
use kanna_daemon::agent::{self, AgentClientWriter, AgentSessions, AgentShared};
use kanna_daemon::protocol::{self, Event, SessionState, SessionStatus};

use super::{broadcast_event, publish_terminal_exit};

/// Outcome of a Kill against the agent registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKillOutcome {
    /// The session was removed and its single Exit published.
    Killed,
    /// No agent session by that id — the caller may try the PTY registry.
    NotFound,
    /// A handoff transfer is in flight and this session is already inside the
    /// successor's snapshot. Refuse; the client retries against the new daemon.
    HandoffInFlight,
}

/// Kill an agent session (task close): SIGKILL the child's process group,
/// journal the end, drop the record. The journal file stays on disk until
/// task cleanup.
pub async fn kill_agent_session(
    session_id: &str,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) -> AgentKillOutcome {
    // Fence the Kill against an in-flight handoff, testing the seal in the
    // SAME registry lock acquisition that removes the session. Reading the
    // seal outside this critical section is not enough: the snapshot could
    // capture the session between an unsealed read and the removal, so this
    // daemon would answer Ok while the successor resurrected the very session
    // it just acknowledged killing.
    //
    // The seal is armed before the snapshot acquires this lock, which leaves
    // exactly two orderings, both correct:
    //   - Kill takes the lock first: it reads an unsealed registry, removes
    //     the session, and the later snapshot simply does not see it.
    //   - The snapshot takes the lock first: the seal is already armed, so
    //     Kill reads it as sealed and refuses.
    let claim = {
        let mut registry = agents.lock().await;
        if super::agent_handoff_sealed() {
            Err(())
        } else {
            let record = registry.remove(session_id);
            if record.is_some() {
                let _ = registry.begin_teardown(session_id);
            }
            Ok(record)
        }
    };
    let record = match claim {
        Err(()) => return AgentKillOutcome::HandoffInFlight,
        Ok(record) => record,
    };
    let Some(mut record) = record else {
        return AgentKillOutcome::NotFound;
    };
    if !record.exited {
        match agent::kill_agent_group_batched(record.pid, record.child_start).await {
            Some(Err(error)) => super::log_info(format_args!(
                "[agent] kill {}: group signal refused: {}",
                session_id, error
            )),
            None => super::log_info(format_args!(
                "[agent] kill {}: lifecycle executor stopped before group teardown completed",
                session_id
            )),
            Some(Ok(())) => {}
        }
        if let Some(mut child) = record.child.take() {
            let _ = child.kill();
            if let Err(error) = kanna_daemon::reaper::try_reap_child(child, record.child_start) {
                kanna_daemon::reaper::reap(error.into_ownership()).await;
            }
        }
    }
    if let Some(fds) = record.handoff_fds.take() {
        fds.close();
    }
    // Close the child's stdin explicitly, and drop the record (with it, the
    // stdout/stderr pipe handles the readers were given). The child is dead
    // and its whole descendant tree with it, so the read ends see EOF and the
    // reader tasks exit instead of lingering on inherited descriptors.
    drop(record.stdin.take());
    let published_here = publish_terminal_exit(
        session_id,
        &record.shared,
        &record.exit_publication,
        AgentEvent::SessionEnded {
            reason: SessionEndReason::Interrupted,
            exit_code: None,
            message: Some("session killed".to_string()),
        },
        Event::Exit {
            session_id: session_id.to_string(),
            code: -1,
            resume_session_id: None,
            killed: true,
        },
        broadcast_tx,
    )
    .await;
    if !published_here {
        record.exit_publication.wait_until_published().await;
    }
    record.shared.lock().await.writers.clear();
    broadcast_event(
        broadcast_tx,
        &Event::StatusChanged {
            session_id: session_id.to_string(),
            status: SessionStatus::Idle,
            waiting_prompt_snippet: None,
        },
    );
    agents.lock().await.end_teardown(session_id);
    AgentKillOutcome::Killed
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
                // Agent sessions carry no terminal composer: their input is
                // structured NDJSON, never a draft that could be concatenated.
                logical_input_blocked: false,
                composer_text: None,
                composer_attestation: protocol::ComposerAttestation::NotTyped,
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
