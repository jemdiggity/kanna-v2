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
        if executable(peer_pid).as_ref() != Some(expected) {
            return Err("system-input peer is not the pinned kanna-server executable".to_string());
        }
        let final_peer = live_process(peer_pid)
            .ok_or_else(|| "system-input peer exited during authorization".to_string())?;
        if final_peer.start != peer.start || executable(peer_pid).as_ref() != Some(expected) {
            return Err("system-input peer identity changed during authorization".to_string());
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
