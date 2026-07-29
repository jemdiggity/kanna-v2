use std::sync::Arc;

use tokio::sync::broadcast;

use kanna_daemon::agent::{self, AgentSessionRecord, AgentSessions};
use kanna_daemon::protocol::{self, SessionStatus};

use super::readers::start_agent_readers;
use super::{log_error, log_info, log_warn};

/// Authenticate EVERY descriptor in a transferred agent bundle against the
/// claimed child pid — never just the first one.
///
/// The sender picks which descriptors accompany the pid, so a bundle whose
/// stdout is a genuine pipe to the claimed child while its stderr or stdin
/// points elsewhere is descriptor confusion with real consequences: the
/// stderr reader would journal a foreign process's bytes as this agent's
/// output, and the stdin handle would carry the operator's prompts — the
/// agent's whole input stream — into a descriptor the child does not own.
/// Each fd must be a pipe, open on our side in the direction its role
/// requires, whose far end is held by that same pid.
///
/// Failure rejects the WHOLE bundle rather than adopting a half-authentic
/// session: the caller then treats the child as exited, which closes every
/// transferred fd and leaves the session resumable from its journal.
fn bundle_is_authentic(
    session_id: &str,
    pid: libc::pid_t,
    owned_fds: &[std::os::unix::io::OwnedFd],
) -> bool {
    use crate::proc_info::PipeEnd;
    use std::os::unix::io::AsRawFd;

    // An empty bundle authenticates nothing; stdout+stderr are mandatory.
    if owned_fds.len() < 2 {
        return false;
    }
    // Bundle order is fixed by the send path: stdout, stderr, optional stdin.
    const ROLES: [(&str, PipeEnd); 3] = [
        ("stdout", PipeEnd::Read),
        ("stderr", PipeEnd::Read),
        ("stdin", PipeEnd::Write),
    ];
    owned_fds.iter().zip(ROLES).all(|(fd, (role, end))| {
        let ok = crate::proc_info::pipe_end_belongs_to(fd.as_raw_fd(), pid, end);
        if !ok {
            log_warn(format_args!(
                "[agent] adopted session {}: transferred {} is not a pipe owned by pid {} \
                     in the expected direction; rejecting the whole bundle",
                session_id, role, pid
            ));
        }
        ok
    })
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
    // itself hold the far end of every transferred pipe, which the kernel
    // reports (`pipe_peerhandle`) for the fds we received. This also
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
                let holds_pipe = bundle_is_authentic(&info.session_id, pid, &owned_fds);
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
                            "[agent] adopted session {}: pid {} does not own the transferred \
                             descriptor bundle; treating child as exited and refusing signal \
                             targeting",
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
        exit_publication: agent::ExitPublication::new(),
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
    let life = super::readers::ReaderLife::new(
        session_id,
        record.incarnation,
        record.adapter.clone(),
        record.shared.clone(),
    );
    agents.lock().await.insert(info.session_id, record);
    start_agent_readers(life, stdout, stderr, agents, broadcast_tx);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};

    /// A live child holding real pipes, plus its authentic bundle in send
    /// order (stdout, stderr, stdin).
    struct Piped {
        child: std::process::Child,
        pid: libc::pid_t,
        fds: Vec<OwnedFd>,
    }

    impl Piped {
        fn spawn() -> Self {
            // `cat` blocks reading stdin, so the child stays alive holding
            // all three pipe ends for the duration of the test.
            let mut child = std::process::Command::new("/bin/cat")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn a piped child");
            let pid = child.id() as libc::pid_t;
            let fds = vec![
                OwnedFd::from(child.stdout.take().expect("stdout")),
                OwnedFd::from(child.stderr.take().expect("stderr")),
                OwnedFd::from(child.stdin.take().expect("stdin")),
            ];
            Self { child, pid, fds }
        }
    }

    impl Drop for Piped {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// A pipe whose far end WE hold — a forged descriptor: structurally a
    /// real pipe, but not shared with the child.
    fn foreign_pipe() -> (OwnedFd, OwnedFd) {
        let mut ends = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(ends.as_mut_ptr()) }, 0, "pipe()");
        unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) }
    }

    #[test]
    fn an_authentic_bundle_passes() {
        let piped = Piped::spawn();
        assert!(
            bundle_is_authentic("auth", piped.pid, &piped.fds),
            "every fd really is a pipe shared with the child"
        );
        // Optional stdin is genuinely optional.
        assert!(bundle_is_authentic("auth", piped.pid, &piped.fds[..2]));
    }

    /// The exact gap this closes: authenticating only stdout accepted a
    /// bundle whose OTHER descriptors came from anywhere at all.
    #[test]
    fn a_bundle_with_a_forged_stderr_is_rejected_whole() {
        let piped = Piped::spawn();
        let (foreign_read, _foreign_write) = foreign_pipe();

        let forged = vec![
            piped.fds[0].try_clone().expect("dup stdout"),
            foreign_read,
            piped.fds[2].try_clone().expect("dup stdin"),
        ];
        // Genuine stdout — the old check's entire basis.
        assert!(crate::proc_info::pipe_end_belongs_to(
            forged[0].as_raw_fd(),
            piped.pid,
            crate::proc_info::PipeEnd::Read
        ));
        assert!(
            !bundle_is_authentic("forged-stderr", piped.pid, &forged),
            "a genuine stdout must not launder a foreign stderr"
        );
    }

    /// Same for stdin, where the consequence is worse: we WRITE the
    /// operator's prompts into whatever that descriptor is.
    #[test]
    fn a_bundle_with_a_forged_stdin_is_rejected_whole() {
        let piped = Piped::spawn();
        let (_foreign_read, foreign_write) = foreign_pipe();

        let forged = vec![
            piped.fds[0].try_clone().expect("dup stdout"),
            piped.fds[1].try_clone().expect("dup stderr"),
            foreign_write,
        ];
        assert!(
            !bundle_is_authentic("forged-stdin", piped.pid, &forged),
            "agent input must never be written into a pipe the child does not own"
        );
    }

    /// Direction is checked, not just ownership: handing the child's stdin
    /// (our write end) in the stdout slot must fail even though that pipe IS
    /// shared with the child.
    #[test]
    fn a_bundle_with_a_swapped_direction_is_rejected() {
        let piped = Piped::spawn();
        let swapped = vec![
            piped.fds[2].try_clone().expect("dup stdin"),
            piped.fds[1].try_clone().expect("dup stderr"),
        ];
        assert!(
            !bundle_is_authentic("swapped", piped.pid, &swapped),
            "a write end presented as stdout is not a readable child stream"
        );
    }

    /// A descriptor that is not a pipe at all is rejected before any peer
    /// lookup — sockets and files must never become agent streams.
    #[test]
    fn a_non_pipe_descriptor_is_rejected() {
        let piped = Piped::spawn();
        let mut socks = [0 as libc::c_int; 2];
        assert_eq!(
            unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, socks.as_mut_ptr()) },
            0,
            "socketpair()"
        );
        let (sock, _peer) = unsafe {
            (
                OwnedFd::from_raw_fd(socks[0]),
                OwnedFd::from_raw_fd(socks[1]),
            )
        };

        let forged = vec![sock, piped.fds[1].try_clone().expect("dup stderr")];
        assert!(
            !bundle_is_authentic("socket", piped.pid, &forged),
            "a socket is not a pipe"
        );
    }

    /// An empty or truncated bundle authenticates nothing.
    #[test]
    fn an_incomplete_bundle_is_rejected() {
        let piped = Piped::spawn();
        assert!(!bundle_is_authentic("empty", piped.pid, &[]));
        assert!(!bundle_is_authentic("short", piped.pid, &piped.fds[..1]));
    }
}
