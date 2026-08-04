use std::os::fd::RawFd;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::proc_info::{ProcessInfo, StartTime};

#[derive(Clone, Debug)]
struct DesktopIdentity {
    pid: libc::pid_t,
    start: StartTime,
    executable: PathBuf,
}

pub(crate) struct OperatorAuthorizer {
    trusted: Mutex<DesktopIdentity>,
    trusted_server_executable: Option<PathBuf>,
    trusted_server: Mutex<Option<DesktopIdentity>>,
}

impl OperatorAuthorizer {
    pub(crate) fn capture() -> Result<Self, String> {
        let daemon = live_process(std::process::id() as libc::pid_t)
            .ok_or_else(|| "daemon process identity is unavailable".to_string())?;
        let parent = live_process(daemon.ppid)
            .ok_or_else(|| "daemon launcher identity is unavailable".to_string())?;
        let executable = executable(parent.pid)
            .ok_or_else(|| "daemon launcher executable is unavailable".to_string())?;
        Ok(Self {
            trusted: Mutex::new(DesktopIdentity {
                pid: parent.pid,
                start: parent.start,
                executable,
            }),
            trusted_server_executable: std::env::var_os("KANNA_SERVER_EXECUTABLE")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .and_then(|path| std::fs::canonicalize(path).ok()),
            trusted_server: Mutex::new(None),
        })
    }

    pub(crate) fn authorize(&self, socket_fd: RawFd, adoption: bool) -> Result<(), String> {
        let peer_pid = crate::proc_info::socket_peer_pid(socket_fd)
            .ok_or_else(|| "operator socket peer identity is unavailable".to_string())?;
        let peer =
            live_process(peer_pid).ok_or_else(|| "operator socket peer is not live".to_string())?;
        let peer_executable = executable(peer_pid)
            .ok_or_else(|| "operator socket peer executable is unavailable".to_string())?;

        let selected = {
            let mut trusted = self
                .trusted
                .lock()
                .map_err(|_| "operator identity lock was poisoned".to_string())?;
            let same = peer.pid == trusted.pid
                && peer.start == trusted.start
                && peer_executable == trusted.executable;
            if !same {
                let old_is_live = live_process(trusted.pid).is_some_and(|process| {
                    process.start == trusted.start
                        && executable(trusted.pid).as_ref() == Some(&trusted.executable)
                });
                if !adoption || old_is_live || peer_executable != trusted.executable {
                    return Err(format!(
                        "operator socket peer is not the pinned desktop process: pid={peer_pid}"
                    ));
                }
                *trusted = DesktopIdentity {
                    pid: peer.pid,
                    start: peer.start,
                    executable: peer_executable.clone(),
                };
            }
            trusted.clone()
        };

        let final_peer = live_process(peer_pid)
            .ok_or_else(|| "operator socket peer exited during authorization".to_string())?;
        if final_peer.start != selected.start
            || peer_pid != selected.pid
            || executable(peer_pid).as_ref() != Some(&selected.executable)
        {
            return Err("operator socket peer identity changed during authorization".to_string());
        }
        Ok(())
    }

    pub(crate) fn authorize_system_input(&self, socket_fd: RawFd) -> Result<(), String> {
        let expected = self
            .trusted_server_executable
            .as_ref()
            .ok_or_else(|| "daemon has no pinned kanna-server executable".to_string())?;
        let peer_pid = crate::proc_info::socket_peer_pid(socket_fd)
            .ok_or_else(|| "system-input socket peer identity is unavailable".to_string())?;
        let peer = live_process(peer_pid)
            .ok_or_else(|| "system-input socket peer is not live".to_string())?;
        let peer_executable = executable(peer_pid)
            .ok_or_else(|| "system-input peer executable is unavailable".to_string())?;
        if &peer_executable != expected {
            return Err("system-input peer is not the pinned kanna-server executable".to_string());
        }

        let selected = {
            let mut trusted_server = self
                .trusted_server
                .lock()
                .map_err(|_| "server identity lock was poisoned".to_string())?;
            let pinned_server_is_live = trusted_server.as_ref().is_some_and(|identity| {
                live_process(identity.pid).is_some_and(|process| {
                    process.start == identity.start
                        && executable(identity.pid).as_ref() == Some(&identity.executable)
                })
            });
            if !pinned_server_is_live {
                // Initial server/daemon startup is deliberately concurrent.
                // Only the exact direct child of the pinned desktop may
                // bootstrap itself or replace an exited server; a surviving
                // server is pinned explicitly.
                let trusted_desktop = self
                    .trusted
                    .lock()
                    .map_err(|_| "operator identity lock was poisoned".to_string())?
                    .clone();
                let desktop_is_live = live_process(trusted_desktop.pid).is_some_and(|process| {
                    process.start == trusted_desktop.start
                        && executable(trusted_desktop.pid).as_ref()
                            == Some(&trusted_desktop.executable)
                });
                if !desktop_is_live || peer.ppid != trusted_desktop.pid {
                    return Err(
                        "system-input peer is not the pinned kanna-server process".to_string()
                    );
                }
                *trusted_server = Some(DesktopIdentity {
                    pid: peer.pid,
                    start: peer.start,
                    executable: peer_executable.clone(),
                });
            }
            trusted_server
                .clone()
                .ok_or_else(|| "server process identity is unavailable".to_string())?
        };
        if peer.pid != selected.pid
            || peer.start != selected.start
            || peer_executable != selected.executable
        {
            return Err("system-input peer is not the pinned kanna-server process".to_string());
        }
        let final_peer = live_process(peer_pid)
            .ok_or_else(|| "system-input peer exited during authorization".to_string())?;
        if final_peer.start != selected.start
            || peer_pid != selected.pid
            || executable(peer_pid).as_ref() != Some(&selected.executable)
        {
            return Err("system-input peer identity changed during authorization".to_string());
        }
        Ok(())
    }

    pub(crate) fn authorize_server_process(
        &self,
        socket_fd: RawFd,
        server_pid: u32,
    ) -> Result<(), String> {
        self.authorize(socket_fd, true)?;
        let server_pid = libc::pid_t::try_from(server_pid)
            .map_err(|_| "kanna-server pid is out of range".to_string())?;
        let expected = self
            .trusted_server_executable
            .as_ref()
            .ok_or_else(|| "daemon has no pinned kanna-server executable".to_string())?;
        let server = live_process(server_pid)
            .ok_or_else(|| "kanna-server process is not live".to_string())?;
        let server_executable = executable(server_pid)
            .ok_or_else(|| "kanna-server executable is unavailable".to_string())?;
        if &server_executable != expected {
            return Err("kanna-server process does not match the pinned executable".to_string());
        }

        let selected = DesktopIdentity {
            pid: server.pid,
            start: server.start,
            executable: server_executable,
        };
        {
            let mut trusted_server = self
                .trusted_server
                .lock()
                .map_err(|_| "server identity lock was poisoned".to_string())?;
            if let Some(current) = trusted_server.as_ref() {
                let current_is_live = live_process(current.pid).is_some_and(|process| {
                    process.start == current.start
                        && executable(current.pid).as_ref() == Some(&current.executable)
                });
                if current_is_live
                    && (current.pid != selected.pid || current.start != selected.start)
                {
                    return Err(
                        "a different live kanna-server process is already pinned".to_string()
                    );
                }
            }
            *trusted_server = Some(selected.clone());
        }

        let final_server = live_process(server_pid)
            .ok_or_else(|| "kanna-server exited during authorization".to_string())?;
        if final_server.start != selected.start
            || executable(server_pid).as_ref() != Some(&selected.executable)
        {
            return Err("kanna-server identity changed during authorization".to_string());
        }
        Ok(())
    }
}

fn live_process(pid: libc::pid_t) -> Option<ProcessInfo> {
    (pid > 1)
        .then(|| crate::proc_info::process_info(pid))
        .flatten()
        .filter(|process| process.pid == pid && !process.is_zombie)
}

fn executable(pid: libc::pid_t) -> Option<PathBuf> {
    crate::proc_info::process_executable_path(pid).and_then(|path| std::fs::canonicalize(path).ok())
}
