use std::fmt;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};

use crate::proc_info::{ProcessIdentity, ProcessInfo};

trait ProcessLookup {
    fn socket_peer_pid(&self, socket_fd: RawFd) -> Option<libc::pid_t>;
    fn process_info(&self, pid: libc::pid_t) -> Option<ProcessInfo>;
    fn process_executable_path(&self, pid: libc::pid_t) -> Option<PathBuf>;
}

struct KernelProcessLookup;

impl ProcessLookup for KernelProcessLookup {
    fn socket_peer_pid(&self, socket_fd: RawFd) -> Option<libc::pid_t> {
        crate::proc_info::socket_peer_pid(socket_fd)
    }

    fn process_info(&self, pid: libc::pid_t) -> Option<ProcessInfo> {
        crate::proc_info::process_info(pid)
    }

    fn process_executable_path(&self, pid: libc::pid_t) -> Option<PathBuf> {
        crate::proc_info::process_executable_path(pid)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SuccessorAuthorizer {
    daemon_executable: PathBuf,
    trusted_launcher_executable: PathBuf,
}

#[derive(Debug)]
pub(crate) struct AuthorizedSuccessor {
    pub(crate) peer: ProcessIdentity,
    pub(crate) parent: ProcessIdentity,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum AuthorizationError {
    SocketPeerUnavailable,
    SenderUnavailable {
        pid: libc::pid_t,
    },
    LauncherUnavailable {
        pid: libc::pid_t,
    },
    SenderIdentityChanged {
        pid: libc::pid_t,
    },
    LauncherIdentityChanged {
        pid: libc::pid_t,
    },
    PeerUnavailable {
        pid: libc::pid_t,
    },
    ParentUnavailable {
        pid: libc::pid_t,
    },
    PeerIdentityChanged {
        pid: libc::pid_t,
    },
    ParentIdentityChanged {
        pid: libc::pid_t,
    },
    PeerExecutableMismatch {
        expected: PathBuf,
        actual: Option<PathBuf>,
    },
    LauncherExecutableMismatch {
        expected: PathBuf,
        actual: Option<PathBuf>,
    },
}

impl fmt::Display for AuthorizationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SocketPeerUnavailable => {
                write!(f, "could not identify handoff socket peer")
            }
            Self::SenderUnavailable { pid } => {
                write!(f, "sending daemon process {pid} is not live")
            }
            Self::LauncherUnavailable { pid } => {
                write!(f, "trusted daemon launcher process {pid} is not live")
            }
            Self::SenderIdentityChanged { pid } => {
                write!(
                    f,
                    "sending daemon identity changed during trust capture ({pid})"
                )
            }
            Self::LauncherIdentityChanged { pid } => {
                write!(
                    f,
                    "daemon launcher identity changed during trust capture ({pid})"
                )
            }
            Self::PeerUnavailable { pid } => {
                write!(f, "successor peer process {pid} is not live")
            }
            Self::ParentUnavailable { pid } => {
                write!(f, "successor parent process {pid} is not live")
            }
            Self::PeerIdentityChanged { pid } => {
                write!(
                    f,
                    "successor peer identity changed during authorization ({pid})"
                )
            }
            Self::ParentIdentityChanged { pid } => {
                write!(
                    f,
                    "successor parent identity changed during authorization ({pid})"
                )
            }
            Self::PeerExecutableMismatch { expected, actual } => write!(
                f,
                "successor executable mismatch (expected {}, got {})",
                expected.display(),
                display_optional_path(actual.as_deref())
            ),
            Self::LauncherExecutableMismatch { expected, actual } => write!(
                f,
                "successor launcher executable mismatch (expected {}, got {})",
                expected.display(),
                display_optional_path(actual.as_deref())
            ),
        }
    }
}

fn display_optional_path(path: Option<&Path>) -> String {
    path.map(|path| path.display().to_string())
        .unwrap_or_else(|| "<unavailable>".to_string())
}

fn live_process<L: ProcessLookup>(lookup: &L, pid: libc::pid_t) -> Option<ProcessInfo> {
    (pid > 1)
        .then(|| lookup.process_info(pid))
        .flatten()
        .filter(|info| info.pid == pid && !info.is_zombie)
}

fn same_process(actual: ProcessInfo, expected: ProcessInfo) -> bool {
    actual.pid == expected.pid
        && actual.start == expected.start
        && actual.ppid == expected.ppid
        && !actual.is_zombie
}

impl SuccessorAuthorizer {
    pub(crate) fn capture() -> Result<Self, AuthorizationError> {
        Self::capture_with(std::process::id() as libc::pid_t, &KernelProcessLookup)
    }

    fn capture_with<L: ProcessLookup>(
        sender_pid: libc::pid_t,
        lookup: &L,
    ) -> Result<Self, AuthorizationError> {
        let sender = live_process(lookup, sender_pid)
            .ok_or(AuthorizationError::SenderUnavailable { pid: sender_pid })?;
        let launcher_pid = sender.ppid;
        let launcher = live_process(lookup, launcher_pid)
            .ok_or(AuthorizationError::LauncherUnavailable { pid: launcher_pid })?;

        let daemon_executable = lookup.process_executable_path(sender_pid).ok_or_else(|| {
            AuthorizationError::PeerExecutableMismatch {
                expected: PathBuf::from("<current daemon executable>"),
                actual: None,
            }
        })?;
        let trusted_launcher_executable =
            lookup
                .process_executable_path(launcher_pid)
                .ok_or_else(|| AuthorizationError::LauncherExecutableMismatch {
                    expected: PathBuf::from("<current launcher executable>"),
                    actual: None,
                })?;

        let final_daemon_executable = lookup.process_executable_path(sender_pid);
        if final_daemon_executable.as_ref() != Some(&daemon_executable) {
            return Err(AuthorizationError::PeerExecutableMismatch {
                expected: daemon_executable,
                actual: final_daemon_executable,
            });
        }
        let final_launcher_executable = lookup.process_executable_path(launcher_pid);
        if final_launcher_executable.as_ref() != Some(&trusted_launcher_executable) {
            return Err(AuthorizationError::LauncherExecutableMismatch {
                expected: trusted_launcher_executable,
                actual: final_launcher_executable,
            });
        }

        let final_launcher = live_process(lookup, launcher_pid)
            .ok_or(AuthorizationError::LauncherIdentityChanged { pid: launcher_pid })?;
        if !same_process(final_launcher, launcher) {
            return Err(AuthorizationError::LauncherIdentityChanged { pid: launcher_pid });
        }
        let final_sender = live_process(lookup, sender_pid)
            .ok_or(AuthorizationError::SenderIdentityChanged { pid: sender_pid })?;
        if !same_process(final_sender, sender) {
            return Err(AuthorizationError::SenderIdentityChanged { pid: sender_pid });
        }

        Ok(Self {
            daemon_executable,
            trusted_launcher_executable,
        })
    }

    #[cfg(test)]
    fn from_paths(
        daemon_executable: impl Into<PathBuf>,
        trusted_launcher_executable: impl Into<PathBuf>,
    ) -> Self {
        Self {
            daemon_executable: daemon_executable.into(),
            trusted_launcher_executable: trusted_launcher_executable.into(),
        }
    }

    pub(crate) fn authorize(
        &self,
        socket_fd: RawFd,
    ) -> Result<AuthorizedSuccessor, AuthorizationError> {
        self.authorize_with(socket_fd, &KernelProcessLookup)
    }

    fn authorize_with<L: ProcessLookup>(
        &self,
        socket_fd: RawFd,
        lookup: &L,
    ) -> Result<AuthorizedSuccessor, AuthorizationError> {
        let peer_pid = lookup
            .socket_peer_pid(socket_fd)
            .ok_or(AuthorizationError::SocketPeerUnavailable)?;
        let peer = live_process(lookup, peer_pid)
            .ok_or(AuthorizationError::PeerUnavailable { pid: peer_pid })?;
        let peer_executable = lookup.process_executable_path(peer_pid);
        if peer_executable.as_ref() != Some(&self.daemon_executable) {
            return Err(AuthorizationError::PeerExecutableMismatch {
                expected: self.daemon_executable.clone(),
                actual: peer_executable,
            });
        }

        let parent_pid = peer.ppid;
        let parent = live_process(lookup, parent_pid)
            .ok_or(AuthorizationError::ParentUnavailable { pid: parent_pid })?;
        let parent_executable = lookup.process_executable_path(parent_pid);
        if parent_executable.as_ref() != Some(&self.trusted_launcher_executable) {
            return Err(AuthorizationError::LauncherExecutableMismatch {
                expected: self.trusted_launcher_executable.clone(),
                actual: parent_executable,
            });
        }

        let final_peer_executable = lookup.process_executable_path(peer_pid);
        if final_peer_executable.as_ref() != Some(&self.daemon_executable) {
            return Err(AuthorizationError::PeerExecutableMismatch {
                expected: self.daemon_executable.clone(),
                actual: final_peer_executable,
            });
        }
        let final_parent_executable = lookup.process_executable_path(parent_pid);
        if final_parent_executable.as_ref() != Some(&self.trusted_launcher_executable) {
            return Err(AuthorizationError::LauncherExecutableMismatch {
                expected: self.trusted_launcher_executable.clone(),
                actual: final_parent_executable,
            });
        }

        let final_parent = live_process(lookup, parent_pid)
            .ok_or(AuthorizationError::ParentIdentityChanged { pid: parent_pid })?;
        if !same_process(final_parent, parent) {
            return Err(AuthorizationError::ParentIdentityChanged { pid: parent_pid });
        }
        let final_peer = live_process(lookup, peer_pid)
            .ok_or(AuthorizationError::PeerIdentityChanged { pid: peer_pid })?;
        if !same_process(final_peer, peer) {
            return Err(AuthorizationError::PeerIdentityChanged { pid: peer_pid });
        }

        Ok(AuthorizedSuccessor {
            peer: ProcessIdentity {
                pid: peer.pid,
                start: peer.start,
            },
            parent: ProcessIdentity {
                pid: parent.pid,
                start: parent.start,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::proc_info::{ProcessInfo, NO_TTY};

    #[derive(Default)]
    struct FakeLookup {
        peer_pid: Option<libc::pid_t>,
        processes: RefCell<HashMap<libc::pid_t, VecDeque<Option<ProcessInfo>>>>,
        paths: RefCell<HashMap<libc::pid_t, VecDeque<Option<PathBuf>>>>,
    }

    impl FakeLookup {
        fn with_peer_pid(mut self, pid: libc::pid_t) -> Self {
            self.peer_pid = Some(pid);
            self
        }

        fn with_processes(
            self,
            pid: libc::pid_t,
            observations: impl IntoIterator<Item = Option<ProcessInfo>>,
        ) -> Self {
            self.processes
                .borrow_mut()
                .insert(pid, observations.into_iter().collect());
            self
        }

        fn with_paths<P: AsRef<Path>>(
            self,
            pid: libc::pid_t,
            observations: impl IntoIterator<Item = Option<P>>,
        ) -> Self {
            self.paths.borrow_mut().insert(
                pid,
                observations
                    .into_iter()
                    .map(|path| path.map(|path| path.as_ref().to_path_buf()))
                    .collect(),
            );
            self
        }
    }

    impl ProcessLookup for FakeLookup {
        fn socket_peer_pid(&self, _socket_fd: std::os::fd::RawFd) -> Option<libc::pid_t> {
            self.peer_pid
        }

        fn process_info(&self, pid: libc::pid_t) -> Option<ProcessInfo> {
            self.processes
                .borrow_mut()
                .get_mut(&pid)
                .and_then(VecDeque::pop_front)
                .flatten()
        }

        fn process_executable_path(&self, pid: libc::pid_t) -> Option<PathBuf> {
            self.paths
                .borrow_mut()
                .get_mut(&pid)
                .and_then(VecDeque::pop_front)
                .flatten()
        }
    }

    fn process(pid: libc::pid_t, ppid: libc::pid_t, start: (u64, u64)) -> ProcessInfo {
        ProcessInfo {
            pid,
            ppid,
            pgid: pid,
            tdev: NO_TTY,
            is_zombie: false,
            is_stopped: false,
            start,
        }
    }

    fn zombie(pid: libc::pid_t, ppid: libc::pid_t, start: (u64, u64)) -> ProcessInfo {
        ProcessInfo {
            is_zombie: true,
            ..process(pid, ppid, start)
        }
    }

    fn matching_lookup() -> FakeLookup {
        FakeLookup::default()
            .with_peer_pid(200)
            .with_processes(
                200,
                [
                    Some(process(200, 100, (2, 0))),
                    Some(process(200, 100, (2, 0))),
                ],
            )
            .with_paths(200, [Some("/app/kanna-daemon"), Some("/app/kanna-daemon")])
            .with_processes(
                100,
                [Some(process(100, 1, (1, 0))), Some(process(100, 1, (1, 0)))],
            )
            .with_paths(100, [Some("/app/Kanna"), Some("/app/Kanna")])
    }

    #[test]
    fn captures_launcher_path_while_original_parent_is_live() {
        let lookup = FakeLookup::default()
            .with_processes(
                300,
                [
                    Some(process(300, 250, (3, 0))),
                    Some(process(300, 250, (3, 0))),
                ],
            )
            .with_paths(300, [Some("/app/kanna-daemon"), Some("/app/kanna-daemon")])
            .with_processes(
                250,
                [Some(process(250, 1, (2, 0))), Some(process(250, 1, (2, 0)))],
            )
            .with_paths(250, [Some("/app/Kanna"), Some("/app/Kanna")]);

        let policy = SuccessorAuthorizer::capture_with(300, &lookup).unwrap();

        assert_eq!(policy.daemon_executable, PathBuf::from("/app/kanna-daemon"));
        assert_eq!(
            policy.trusted_launcher_executable,
            PathBuf::from("/app/Kanna")
        );
    }

    #[test]
    fn authorizes_matching_daemon_with_live_trusted_direct_parent() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");

        let authorization = policy.authorize_with(7, &matching_lookup()).unwrap();

        assert_eq!(authorization.peer.pid, 200);
        assert_eq!(authorization.peer.start, (2, 0));
        assert_eq!(authorization.parent.pid, 100);
        assert_eq!(authorization.parent.start, (1, 0));
    }

    #[test]
    fn rejects_peer_executable_mismatch() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let lookup = matching_lookup().with_paths(200, [Some("/tmp/socket-client")]);

        assert!(matches!(
            policy.authorize_with(7, &lookup),
            Err(AuthorizationError::PeerExecutableMismatch { .. })
        ));
    }

    #[test]
    fn rejects_launcher_executable_mismatch() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let lookup = matching_lookup().with_paths(100, [Some("/bin/zsh")]);

        assert!(matches!(
            policy.authorize_with(7, &lookup),
            Err(AuthorizationError::LauncherExecutableMismatch { .. })
        ));
    }

    #[test]
    fn rejects_missing_or_zombie_direct_parent() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let missing = matching_lookup().with_processes(100, [None]);
        assert!(matches!(
            policy.authorize_with(7, &missing),
            Err(AuthorizationError::ParentUnavailable { .. })
        ));

        let zombie_parent = matching_lookup().with_processes(100, [Some(zombie(100, 1, (1, 0)))]);
        assert!(matches!(
            policy.authorize_with(7, &zombie_parent),
            Err(AuthorizationError::ParentUnavailable { .. })
        ));
    }

    #[test]
    fn rejects_peer_start_identity_change_at_final_recheck() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let lookup = matching_lookup().with_processes(
            200,
            [
                Some(process(200, 100, (2, 0))),
                Some(process(200, 100, (9, 0))),
            ],
        );

        assert!(matches!(
            policy.authorize_with(7, &lookup),
            Err(AuthorizationError::PeerIdentityChanged { .. })
        ));
    }

    #[test]
    fn rejects_parent_start_identity_change_at_final_recheck() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let lookup = matching_lookup().with_processes(
            100,
            [Some(process(100, 1, (1, 0))), Some(process(100, 1, (9, 0)))],
        );

        assert!(matches!(
            policy.authorize_with(7, &lookup),
            Err(AuthorizationError::ParentIdentityChanged { .. })
        ));
    }

    #[test]
    fn rejects_direct_parent_change_at_final_recheck() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let lookup = matching_lookup().with_processes(
            200,
            [
                Some(process(200, 100, (2, 0))),
                Some(process(200, 101, (2, 0))),
            ],
        );

        assert!(matches!(
            policy.authorize_with(7, &lookup),
            Err(AuthorizationError::PeerIdentityChanged { .. })
        ));
    }

    #[test]
    fn rejects_exec_path_changes_at_final_recheck() {
        let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
        let peer_exec = matching_lookup()
            .with_paths(200, [Some("/app/kanna-daemon"), Some("/tmp/socket-client")]);
        assert!(matches!(
            policy.authorize_with(7, &peer_exec),
            Err(AuthorizationError::PeerExecutableMismatch { .. })
        ));

        let parent_exec = matching_lookup().with_paths(100, [Some("/app/Kanna"), Some("/bin/zsh")]);
        assert!(matches!(
            policy.authorize_with(7, &parent_exec),
            Err(AuthorizationError::LauncherExecutableMismatch { .. })
        ));
    }
}
