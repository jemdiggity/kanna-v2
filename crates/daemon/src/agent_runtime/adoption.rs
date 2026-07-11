use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use kanna_daemon::agent::{self, AgentJournal, AgentSessionRecord, AgentSessions, AgentShared};
use kanna_daemon::protocol::{self, SessionStatus};

use super::readers::start_agent_readers;
use super::{log_error, log_info, log_warn};

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
        log_error(format_args!(
            "[agent] adopted session {} has no spawn params; dropping",
            info.session_id
        ));
        close_fds(&fds);
        return;
    };
    let Some(adapter) = agent::make_adapter(params.agent_provider) else {
        log_error(format_args!(
            "[agent] adopted session {} has unsupported provider {:?}; dropping",
            info.session_id, params.agent_provider
        ));
        close_fds(&fds);
        return;
    };
    let turn_model = adapter.turn_model();

    let journal = AgentJournal::open(&data_dir, &info.session_id);
    let last_assistant_prompt = journal.latest_assistant_prompt();
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
        last_assistant_prompt,
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
        log_info(format_args!(
            "[agent] adopted exited session {} (pid={}); resume available via journal",
            info.session_id, info.pid
        ));
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
            log_warn(format_args!(
                "[agent] adopted session {}: failed to reserve handoff dups: {}",
                info.session_id, error
            ));
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

    log_info(format_args!(
        "[agent] adopted live session {} (pid={}, provider={:?})",
        info.session_id, info.pid, record.provider
    ));
    let session_id = info.session_id.clone();
    agents.lock().await.insert(info.session_id, record);
    start_agent_readers(session_id, stdout, stderr, agents, broadcast_tx);
}
