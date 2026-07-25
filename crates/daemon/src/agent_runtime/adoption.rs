use std::sync::Arc;

use tokio::sync::broadcast;

use kanna_daemon::agent::{self, AgentSessionRecord, AgentSessions};
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
    use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};

    // Take ownership of every transferred fd immediately: any early return
    // below closes them all through Drop instead of leaking.
    let owned_fds: Vec<OwnedFd> = fds
        .into_iter()
        .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
        .collect();

    // Protocol-valid pipe bundles are stdout+stderr with optional stdin
    // (2 or 3 fds) or nothing for an exited child. The receive path already
    // enforced this; re-check so a bad bundle can never misindex below.
    if !matches!(owned_fds.len(), 0 | 2 | 3) {
        log_error(format_args!(
            "[agent] adopted session {} carries invalid fd bundle of {}; dropping fds",
            info.session_id,
            owned_fds.len()
        ));
        return;
    }

    let Some(params) = info.agent_spawn else {
        log_error(format_args!(
            "[agent] adopted session {} has no spawn params; dropping",
            info.session_id
        ));
        return;
    };
    let Some(adapter) = agent::make_adapter(params.agent_provider) else {
        log_error(format_args!(
            "[agent] adopted session {} has unsupported provider {:?}; dropping",
            info.session_id, params.agent_provider
        ));
        return;
    };
    let turn_model = adapter.turn_model();

    // One journal (one sequence space) per session id.
    let shared = agent::shared_agent_state(&data_dir, &info.session_id);
    let (
        last_assistant_prompt,
        journal_provider_session_id,
        pending_permissions,
        session_allowed_tools,
    ) = {
        let sh = shared.lock().await;
        (
            sh.journal.latest_assistant_prompt(),
            sh.journal.provider_session_id(),
            sh.journal.pending_permission_ids(),
            sh.journal.session_allowed_tools(),
        )
    };
    let provider_session_id = info
        .provider_session_id
        .clone()
        .or(journal_provider_session_id);

    // Authenticate the transferred pid before it can ever be a signal
    // target. The pid and any `child_start` metadata are sender-controlled
    // wire values — a forged pair naming an unrelated live process (whose
    // start time an attacker can read) must never gain signal authority.
    // The authority here is descriptor provenance: the claimed pid must
    // itself hold the far end of the transferred stdout pipe, which the
    // kernel reports (`pipe_peerhandle`) for the fd we received. This also
    // authenticates live agents from older senders that never transferred
    // identity metadata, keeping them interruptable/killable across the
    // upgrade. A pid that fails provenance is treated as exited and stays
    // permanently non-signalable.
    let (process_present, child_start) = match crate::pty::validated_child_pid(info.pid) {
        None => {
            log_warn(format_args!(
                "[agent] adopted session {}: out-of-range pid {}; treating child as exited",
                info.session_id, info.pid
            ));
            (false, None)
        }
        Some(pid) => match crate::proc_info::process_info(pid) {
            None => (false, None),
            Some(live) => {
                let holds_pipe = owned_fds
                    .first()
                    .and_then(|stdout| crate::proc_info::pipe_peer_handle(stdout.as_raw_fd()))
                    .map(|peer| crate::proc_info::pid_holds_pipe_end(pid, peer))
                    == Some(true);
                if holds_pipe {
                    if info.child_start.is_some() && info.child_start != Some(live.start) {
                        log_warn(format_args!(
                            "[agent] adopted session {}: transferred start {:?} disagrees with \
                             pipe-bound process {:?}; trusting the pipe provenance",
                            info.session_id, info.child_start, live.start
                        ));
                    }
                    (!live.is_zombie, Some(live.start))
                } else {
                    if !owned_fds.is_empty() {
                        log_warn(format_args!(
                            "[agent] adopted session {}: pid {} does not hold the transferred \
                             pipe; treating child as exited and refusing signal targeting",
                            info.session_id, info.pid
                        ));
                    }
                    (false, None)
                }
            }
        },
    };
    let alive = process_present && owned_fds.len() >= 2;

    let mut record = AgentSessionRecord {
        provider: params.agent_provider,
        params,
        adapter: Arc::new(std::sync::Mutex::new(adapter)),
        shared,
        child: None,
        stdin: None,
        pid: info.pid,
        child_start,
        incarnation: kanna_daemon::agent::next_agent_incarnation(),
        spawning: false,
        reservation_is_initial: false,
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
        drop(owned_fds);
        agents.lock().await.insert(info.session_id, record);
        return;
    }

    // Reserve a fresh dup set for the NEXT handoff before wrapping the
    // transferred fds into owned handles. Partial duplicates are cleaned up
    // inside dup_from; the originals stay owned either way.
    record.handoff_fds = match agent::AgentHandoffFds::dup_from(
        owned_fds[0].as_raw_fd(),
        owned_fds[1].as_raw_fd(),
        owned_fds.get(2).map(AsRawFd::as_raw_fd),
    ) {
        Ok(bundle) => Some(bundle),
        Err(error) => {
            log_warn(format_args!(
                "[agent] adopted session {}: failed to reserve handoff dups: {}",
                info.session_id, error
            ));
            None
        }
    };

    let mut owned_iter = owned_fds.into_iter();
    let stdout =
        std::process::ChildStdout::from(owned_iter.next().expect("bundle length checked above"));
    let stderr =
        std::process::ChildStderr::from(owned_iter.next().expect("bundle length checked above"));
    record.stdin = owned_iter.next().map(std::process::ChildStdin::from);

    log_info(format_args!(
        "[agent] adopted live session {} (pid={}, provider={:?})",
        info.session_id, info.pid, record.provider
    ));
    let session_id = info.session_id.clone();
    // Capture the reader's own identity before the record moves into the
    // registry: readers must never resolve these by session id.
    let life = super::readers::ReaderLife {
        session_id,
        incarnation: record.incarnation,
        adapter: record.adapter.clone(),
        shared: record.shared.clone(),
    };
    agents.lock().await.insert(info.session_id, record);
    start_agent_readers(life, stdout, stderr, agents, broadcast_tx);
}
