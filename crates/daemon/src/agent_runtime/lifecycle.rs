use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_agent_protocol::{AgentEvent, SessionEndReason, TurnModel};
use kanna_daemon::agent::{
    self, AgentClientWriter, AgentJournal, AgentSessionRecord, AgentSessions, AgentShared,
};
use kanna_daemon::protocol::{self, Event, SessionState, SessionStatus};

use super::common::{broadcast_event, fan_out};
use super::reader::start_agent_readers;

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
