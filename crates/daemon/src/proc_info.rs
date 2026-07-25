//! Read-only process metadata and session-scoped teardown sweeps.
//!
//! PTY teardown cannot rely on `kill(-pgid)` alone: interactive shells give
//! every job its own process group, and descendants may call `setpgid()` or
//! `setsid()` themselves. Any survivor keeps the PTY slave open and pins the
//! pty in the kernel's global pool. The durable lifecycle boundary is the
//! terminal itself: a process belongs to a session's teardown set when it is
//! reachable from the session leader through the parent chain, or when its
//! controlling terminal is the session's slave device. On macOS both facts —
//! plus the start-time identity used to detect PID reuse — come from
//! `proc_pidinfo(PROC_PIDTBSDINFO)`.
//!
//! On non-macOS platforms these helpers degrade to "unknown": callers fall
//! back to plain group signaling.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};

/// Start-time identity of a process: `(pbi_start_tvsec, pbi_start_tvusec)`.
/// A (pid, start-time) pair is stable for the life of the process and never
/// survives PID reuse, unlike the bare pid.
pub type StartTime = (u64, u64);

#[derive(Debug, Clone, Copy)]
pub struct ProcessInfo {
    pub pid: libc::pid_t,
    pub ppid: libc::pid_t,
    pub pgid: libc::pid_t,
    /// Controlling terminal device number, or `NO_TTY` when detached.
    pub tdev: u32,
    pub is_zombie: bool,
    pub is_stopped: bool,
    pub start: StartTime,
}

/// `e_tdev` value for processes without a controlling terminal (`NODEV`).
pub const NO_TTY: u32 = u32::MAX;

#[cfg(target_os = "macos")]
mod imp {
    use super::{ProcessInfo, NO_TTY};

    const PROC_ALL_PIDS: u32 = 1;
    const PROC_PIDTBSDINFO: libc::c_int = 3;
    const SSTOP: u32 = 4;
    const SZOMB: u32 = 5;

    /// `struct proc_bsdinfo` from `<libproc.h>`.
    #[repr(C)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: libc::uid_t,
        pbi_gid: libc::gid_t,
        pbi_ruid: libc::uid_t,
        pbi_rgid: libc::gid_t,
        pbi_svuid: libc::uid_t,
        pbi_svgid: libc::gid_t,
        rfu_1: u32,
        pbi_comm: [libc::c_char; 16],
        pbi_name: [libc::c_char; 32],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }

    extern "C" {
        fn proc_listpids(
            kind: u32,
            typeinfo: u32,
            buffer: *mut libc::c_void,
            buffersize: libc::c_int,
        ) -> libc::c_int;
        fn proc_pidinfo(
            pid: libc::c_int,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut libc::c_void,
            buffersize: libc::c_int,
        ) -> libc::c_int;
    }

    pub fn process_info(pid: libc::pid_t) -> Option<ProcessInfo> {
        if pid <= 0 {
            return None;
        }
        let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<ProcBsdInfo>() as libc::c_int;
        let ret = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDTBSDINFO,
                0,
                &mut info as *mut ProcBsdInfo as *mut libc::c_void,
                size,
            )
        };
        if ret != size {
            return None;
        }
        Some(ProcessInfo {
            pid,
            ppid: info.pbi_ppid as libc::pid_t,
            pgid: info.pbi_pgid as libc::pid_t,
            tdev: info.e_tdev,
            is_zombie: info.pbi_status == SZOMB,
            is_stopped: info.pbi_status == SSTOP,
            start: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        })
    }

    pub fn all_process_info() -> Vec<ProcessInfo> {
        let bytes = unsafe { proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return Vec::new();
        }
        // Headroom for processes created between the two calls.
        let capacity = bytes as usize / std::mem::size_of::<libc::c_int>() + 64;
        let mut pids = vec![0 as libc::c_int; capacity];
        let bytes = unsafe {
            proc_listpids(
                PROC_ALL_PIDS,
                0,
                pids.as_mut_ptr() as *mut libc::c_void,
                (capacity * std::mem::size_of::<libc::c_int>()) as libc::c_int,
            )
        };
        if bytes <= 0 {
            return Vec::new();
        }
        let count = bytes as usize / std::mem::size_of::<libc::c_int>();
        pids[..count.min(capacity)]
            .iter()
            .filter(|&&pid| pid > 0)
            .filter_map(|&pid| process_info(pid))
            .collect()
    }

    /// Kernel handle of the far end of a pipe held by this process
    /// (`PROC_PIDFDPIPEINFO`). Together with [`pid_holds_pipe_end`] this
    /// gives kernel-authoritative provenance: a transferred pipe fd can be
    /// bound to the exact process holding its peer, independent of any
    /// sender-controlled metadata. Offsets are for the fixed
    /// `pipe_fdinfo` layout (24-byte `proc_fileinfo` + 136-byte
    /// `vinfo_stat` + handle/peer/status u64s = 184 bytes).
    pub fn pipe_peer_handle(fd: std::os::unix::io::RawFd) -> Option<u64> {
        let mut buf = [0u8; PIPE_FDINFO_SIZE];
        let ret = unsafe {
            proc_pidfdinfo(
                std::process::id() as libc::c_int,
                fd,
                PROC_PIDFDPIPEINFO,
                buf.as_mut_ptr() as *mut libc::c_void,
                PIPE_FDINFO_SIZE as libc::c_int,
            )
        };
        if ret != PIPE_FDINFO_SIZE as libc::c_int {
            return None;
        }
        let peer = u64::from_ne_bytes(
            buf[PIPE_PEERHANDLE_OFFSET..PIPE_PEERHANDLE_OFFSET + 8]
                .try_into()
                .ok()?,
        );
        if peer == 0 {
            None
        } else {
            Some(peer)
        }
    }

    /// True when `pid` holds an open pipe descriptor whose kernel handle is
    /// `handle` (i.e. the far end of a pipe we hold).
    pub fn pid_holds_pipe_end(pid: libc::pid_t, handle: u64) -> bool {
        if pid <= 0 || handle == 0 {
            return false;
        }
        let bytes = unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return false;
        }
        const FDINFO_SIZE: usize = 8; // { i32 proc_fd; u32 proc_fdtype }
        let capacity = bytes as usize + 16 * FDINFO_SIZE;
        let mut buf = vec![0u8; capacity];
        let bytes = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDLISTFDS,
                0,
                buf.as_mut_ptr() as *mut libc::c_void,
                capacity as libc::c_int,
            )
        };
        if bytes <= 0 {
            return false;
        }
        let count = bytes as usize / FDINFO_SIZE;
        for index in 0..count {
            let base = index * FDINFO_SIZE;
            let fd = i32::from_ne_bytes(buf[base..base + 4].try_into().unwrap_or([0; 4]));
            let fd_type = u32::from_ne_bytes(buf[base + 4..base + 8].try_into().unwrap_or([0; 4]));
            if fd_type != PROX_FDTYPE_PIPE {
                continue;
            }
            let mut info = [0u8; PIPE_FDINFO_SIZE];
            let ret = unsafe {
                proc_pidfdinfo(
                    pid,
                    fd,
                    PROC_PIDFDPIPEINFO,
                    info.as_mut_ptr() as *mut libc::c_void,
                    PIPE_FDINFO_SIZE as libc::c_int,
                )
            };
            if ret != PIPE_FDINFO_SIZE as libc::c_int {
                continue;
            }
            let their_handle = u64::from_ne_bytes(
                info[PIPE_HANDLE_OFFSET..PIPE_HANDLE_OFFSET + 8]
                    .try_into()
                    .unwrap_or([0; 8]),
            );
            if their_handle == handle {
                return true;
            }
        }
        false
    }

    const PROC_PIDLISTFDS: libc::c_int = 1;
    const PROC_PIDFDPIPEINFO: libc::c_int = 6;
    const PROX_FDTYPE_PIPE: u32 = 6;
    const PIPE_FDINFO_SIZE: usize = 184;
    const PIPE_HANDLE_OFFSET: usize = 160;
    const PIPE_PEERHANDLE_OFFSET: usize = 168;

    extern "C" {
        fn proc_pidfdinfo(
            pid: libc::c_int,
            fd: libc::c_int,
            flavor: libc::c_int,
            buffer: *mut libc::c_void,
            buffersize: libc::c_int,
        ) -> libc::c_int;
    }

    /// Pid of the process on the other end of a connected Unix-domain
    /// socket (`LOCAL_PEERPID`). Authenticates a pid-file claim against the
    /// process actually serving the socket.
    pub fn socket_peer_pid(socket_fd: std::os::unix::io::RawFd) -> Option<libc::pid_t> {
        const SOL_LOCAL: libc::c_int = 0;
        const LOCAL_PEERPID: libc::c_int = 0x002;
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        let ret = unsafe {
            libc::getsockopt(
                socket_fd,
                SOL_LOCAL,
                LOCAL_PEERPID,
                &mut pid as *mut libc::pid_t as *mut libc::c_void,
                &mut len,
            )
        };
        if ret == 0 && pid > 1 {
            Some(pid)
        } else {
            None
        }
    }

    /// Resolve the slave tty device number for a PTY master fd
    /// (`TIOCPTYGNAME` + `stat`). Authoritative binding between a transferred
    /// master fd and the processes on its terminal.
    pub fn slave_device_of_master(master_fd: std::os::unix::io::RawFd) -> Option<u32> {
        // TIOCPTYGNAME copies out up to 128 bytes of slave path.
        const TIOCPTYGNAME: libc::c_ulong = 0x4080_7453;
        let mut buf = [0 as libc::c_char; 128];
        let ret = unsafe { libc::ioctl(master_fd, TIOCPTYGNAME, buf.as_mut_ptr()) };
        if ret != 0 {
            return None;
        }
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::stat(buf.as_ptr(), &mut st) } != 0 {
            return None;
        }
        let dev = st.st_rdev as u32;
        if dev == NO_TTY {
            None
        } else {
            Some(dev)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::ProcessInfo;

    pub fn process_info(_pid: libc::pid_t) -> Option<ProcessInfo> {
        None
    }

    pub fn all_process_info() -> Vec<ProcessInfo> {
        Vec::new()
    }

    pub fn socket_peer_pid(_socket_fd: std::os::unix::io::RawFd) -> Option<libc::pid_t> {
        None
    }

    pub fn slave_device_of_master(_master_fd: std::os::unix::io::RawFd) -> Option<u32> {
        None
    }

    pub fn pipe_peer_handle(_fd: std::os::unix::io::RawFd) -> Option<u64> {
        None
    }

    pub fn pid_holds_pipe_end(_pid: libc::pid_t, _handle: u64) -> bool {
        false
    }
}

pub use imp::{
    all_process_info, pid_holds_pipe_end, pipe_peer_handle, process_info, slave_device_of_master,
    socket_peer_pid,
};

/// True when `pid` currently refers to the process with the given start-time
/// identity (zombie or live). This is the gate for any pid-targeted signal:
/// a recycled pid has a different start time and must never be signaled.
pub fn identity_matches(pid: libc::pid_t, start: StartTime) -> bool {
    process_info(pid).map(|info| info.start == start) == Some(true)
}

/// Like [`identity_matches`], but a zombie counts as exited.
pub fn identity_alive(pid: libc::pid_t, start: StartTime) -> bool {
    process_info(pid).map(|info| info.start == start && !info.is_zombie) == Some(true)
}

/// A teardown target pinned to a start-time identity. Every signal delivered
/// to the target re-verifies the identity first, so a pid recycled between
/// enumeration and signaling is never hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionTarget {
    pub pid: libc::pid_t,
    pub start: StartTime,
}

/// Test-only fault injection: when set to a pid, [`stop_verified`] SIGKILLs
/// that pid after its pre-stop identity check, simulating the target
/// exiting (and its pid becoming reusable) inside the verify→stop window.
#[cfg(test)]
pub(crate) static TEST_KILL_AFTER_STOP_PREVERIFY: std::sync::atomic::AtomicI32 =
    std::sync::atomic::AtomicI32::new(0);

/// SIGSTOP `target` under the verified stop protocol: verify identity, stop,
/// then verify again — if the post-stop identity no longer matches (the pid
/// was recycled inside the window), roll the stop back with SIGCONT and
/// report failure so an unrelated process is never left frozen or targeted.
pub fn stop_verified(target: SessionTarget) -> bool {
    if target.pid <= 1 {
        return false;
    }
    if !identity_matches(target.pid, target.start) {
        return false;
    }
    #[cfg(test)]
    {
        use std::sync::atomic::Ordering;
        if TEST_KILL_AFTER_STOP_PREVERIFY.load(Ordering::Relaxed) == target.pid {
            unsafe { libc::kill(target.pid, libc::SIGKILL) };
            // Let the kill land so the post-stop verification sees it.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    if unsafe { libc::kill(target.pid, libc::SIGSTOP) } != 0 {
        return false;
    }
    if identity_matches(target.pid, target.start) {
        true
    } else {
        log::warn!(
            "[proc] stopped pid {} no longer matches identity {:?}; rolling back with SIGCONT",
            target.pid,
            target.start
        );
        unsafe { libc::kill(target.pid, libc::SIGCONT) };
        false
    }
}

/// Destructively kill a single process, closing the identity-check-to-`kill(2)`
/// PID-reuse window. macOS has no atomic process reference, so the freeze
/// protocol substitutes for one: a verified-stopped process cannot exit, so its
/// pid stays allocated between the post-stop verification and the kill. Returns
/// false (no signal sent) when the freeze cannot be established — fail closed.
pub fn kill_process_verified(target: SessionTarget) -> bool {
    if !stop_verified(target) {
        log::info!(
            "[proc] refusing to kill pid {}: could not freeze it under a verified identity",
            target.pid
        );
        return false;
    }
    unsafe { libc::kill(target.pid, libc::SIGKILL) == 0 }
}

/// Send `sig` to `target` only if its start-time identity still matches.
/// Returns whether the signal was delivered.
pub fn signal_verified(target: SessionTarget, sig: libc::c_int) -> bool {
    if target.pid <= 1 {
        return false;
    }
    if !identity_matches(target.pid, target.start) {
        log::info!(
            "[proc] refusing signal {} to pid {}: start identity {:?} no longer matches",
            sig,
            target.pid,
            target.start
        );
        return false;
    }
    unsafe { libc::kill(target.pid, sig) == 0 }
}

/// Freeze the teardown sets of MANY sessions, batching by scan round: each
/// round takes exactly ONE process-table snapshot and applies it to every
/// session still discovering new processes. Bulk teardown therefore costs one
/// scan per round instead of one (or more) per session.
pub fn freeze_many(specs: &[(Option<SessionTarget>, Option<u32>)]) -> Vec<Vec<SessionTarget>> {
    const MAX_PASSES: usize = 8;
    let self_pid = std::process::id() as libc::pid_t;
    let mut stopped: Vec<Vec<SessionTarget>> = vec![Vec::new(); specs.len()];
    let mut stopped_pids: Vec<BTreeSet<libc::pid_t>> = vec![BTreeSet::new(); specs.len()];
    let mut active: Vec<bool> = vec![true; specs.len()];

    for _ in 0..MAX_PASSES {
        if !active.iter().any(|&a| a) {
            break;
        }
        // One snapshot for this whole round.
        let infos = all_process_info();
        let mut children_by_ppid: HashMap<libc::pid_t, Vec<libc::pid_t>> = HashMap::new();
        let mut info_by_pid: HashMap<libc::pid_t, &ProcessInfo> = HashMap::new();
        for info in &infos {
            children_by_ppid
                .entry(info.ppid)
                .or_default()
                .push(info.pid);
            info_by_pid.insert(info.pid, info);
        }

        for (index, (leader, tty_dev)) in specs.iter().enumerate() {
            if !active[index] {
                continue;
            }
            let targets = session_targets(
                *leader,
                *tty_dev,
                &infos,
                &children_by_ppid,
                &info_by_pid,
                self_pid,
            );
            let fresh: Vec<libc::pid_t> =
                targets.difference(&stopped_pids[index]).copied().collect();
            if fresh.is_empty() {
                active[index] = false;
                continue;
            }
            for pid in fresh {
                let Some(&info) = info_by_pid.get(&pid) else {
                    continue;
                };
                let target = SessionTarget {
                    pid,
                    start: info.start,
                };
                if stop_verified(target) {
                    stopped[index].push(target);
                    stopped_pids[index].insert(pid);
                }
            }
        }
    }
    stopped
}

/// Compute one session's teardown membership from an already-taken snapshot.
/// Traversal (`visited`) is tracked separately from membership so an
/// on-terminal intermediate is still walked for its own detached children.
fn session_targets(
    leader: Option<SessionTarget>,
    tty_dev: Option<u32>,
    infos: &[ProcessInfo],
    children_by_ppid: &HashMap<libc::pid_t, Vec<libc::pid_t>>,
    info_by_pid: &HashMap<libc::pid_t, &ProcessInfo>,
    self_pid: libc::pid_t,
) -> BTreeSet<libc::pid_t> {
    let mut targets: BTreeSet<libc::pid_t> = BTreeSet::new();
    if let Some(dev) = tty_dev {
        if dev != NO_TTY {
            targets.extend(
                infos
                    .iter()
                    .filter(|info| info.tdev == dev)
                    .map(|info| info.pid),
            );
        }
    }
    // Only walk the leader's subtree while its identity still holds — a
    // recycled leader pid must not donate an unrelated subtree.
    let verified_root = leader.filter(|root| {
        info_by_pid
            .get(&root.pid)
            .map(|info| info.start == root.start)
            == Some(true)
    });
    if let Some(root) = verified_root {
        let mut visited: BTreeSet<libc::pid_t> = BTreeSet::new();
        let mut frontier = vec![root.pid];
        while let Some(pid) = frontier.pop() {
            for &child in children_by_ppid.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
                if child != root.pid && visited.insert(child) {
                    targets.insert(child);
                    frontier.push(child);
                }
            }
        }
    }
    targets.retain(|pid| info_by_pid.get(pid).map(|info| info.is_zombie) != Some(true));
    targets.remove(&self_pid);
    if let Some(root) = leader {
        targets.remove(&root.pid);
    }
    targets.retain(|&pid| pid > 1);
    targets
}

/// Enumerate and freeze (SIGSTOP) every live process that belongs to a PTY
/// session's teardown set, so none of them can fork or reparent while the
/// caller delivers SIGKILL. Membership: descendants of `leader` via the
/// parent chain, plus any process whose controlling terminal is `tty_dev`.
/// The leader itself, pid 0/1, this process, and zombies are excluded.
///
/// Traversal is tracked separately from membership: an intermediate that is
/// already a member (e.g. an on-terminal child) is still walked, so its own
/// detached descendants are found.
///
/// Each SIGSTOP is identity-guarded: the target's start time is re-verified
/// immediately before stopping, and if the identity no longer matches right
/// after the stop (the pid was recycled in the window), the stop is rolled
/// back with SIGCONT and the pid is dropped. A successfully frozen process
/// cannot exit, so its (pid, start) pair stays valid for the caller's kill.
///
/// Repeats until a pass discovers nothing new (a stopped process cannot
/// fork, so the frontier only shrinks). Returns the frozen identity-pinned
/// targets; the caller delivers SIGKILL through [`signal_verified`].
///
/// Boundary: a descendant that both left the session (`setsid`) and was
/// reparented past the leader before enumeration is a genuine daemonized
/// process and is intentionally out of scope.
pub fn freeze_session_processes(
    leader: Option<SessionTarget>,
    tty_dev: Option<u32>,
) -> Vec<SessionTarget> {
    freeze_session_processes_with(leader, tty_dev, None)
}

/// As [`freeze_session_processes`], but `table` may supply an already-taken
/// process-table snapshot for the FIRST pass. Many-session teardown takes one
/// snapshot and shares it across every session instead of each session
/// rescanning the whole table. Later passes rescan only when the previous
/// pass discovered new processes (a stopped process cannot fork, so the
/// frontier only shrinks and the common case is a single extra confirming
/// scan).
pub fn freeze_session_processes_with(
    leader: Option<SessionTarget>,
    tty_dev: Option<u32>,
    table: Option<&[ProcessInfo]>,
) -> Vec<SessionTarget> {
    const MAX_PASSES: usize = 8;
    let self_pid = std::process::id() as libc::pid_t;
    let mut stopped: Vec<SessionTarget> = Vec::new();
    let mut stopped_pids: BTreeSet<libc::pid_t> = BTreeSet::new();
    let mut supplied = table;

    for _ in 0..MAX_PASSES {
        let owned_infos;
        let infos: &[ProcessInfo] = match supplied.take() {
            Some(table) => table,
            None => {
                owned_infos = all_process_info();
                &owned_infos
            }
        };
        let mut children_by_ppid: HashMap<libc::pid_t, Vec<libc::pid_t>> = HashMap::new();
        let mut info_by_pid: HashMap<libc::pid_t, &ProcessInfo> = HashMap::new();
        for info in infos {
            children_by_ppid
                .entry(info.ppid)
                .or_default()
                .push(info.pid);
            info_by_pid.insert(info.pid, info);
        }

        let mut targets: BTreeSet<libc::pid_t> = BTreeSet::new();
        if let Some(dev) = tty_dev {
            if dev != NO_TTY {
                targets.extend(
                    infos
                        .iter()
                        .filter(|info| info.tdev == dev)
                        .map(|info| info.pid),
                );
            }
        }
        // Only walk the leader's subtree while the leader's identity still
        // holds — a recycled leader pid must not donate an unrelated subtree.
        let verified_root = leader.filter(|root| {
            info_by_pid
                .get(&root.pid)
                .map(|info| info.start == root.start)
                == Some(true)
        });
        if let Some(root) = verified_root {
            // `visited` tracks traversal; `targets` tracks membership. An
            // on-terminal intermediate is already a member, but its own
            // children must still be walked.
            let mut visited: BTreeSet<libc::pid_t> = BTreeSet::new();
            let mut frontier = vec![root.pid];
            while let Some(pid) = frontier.pop() {
                for &child in children_by_ppid.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
                    if child != root.pid && visited.insert(child) {
                        targets.insert(child);
                        frontier.push(child);
                    }
                }
            }
        }
        // Zombies need no signal (and their children were still traversed).
        targets.retain(|pid| info_by_pid.get(pid).map(|info| info.is_zombie) != Some(true));
        targets.remove(&self_pid);
        if let Some(root) = leader {
            targets.remove(&root.pid);
        }
        targets.retain(|&pid| pid > 1);

        let fresh: Vec<libc::pid_t> = targets.difference(&stopped_pids).copied().collect();
        if fresh.is_empty() {
            break;
        }
        for pid in fresh {
            let Some(&info) = info_by_pid.get(&pid) else {
                continue;
            };
            let target = SessionTarget {
                pid,
                start: info.start,
            };
            // Verified stop protocol: a pid recycled inside the window gets
            // resumed and dropped instead of staying wrongly frozen.
            if stop_verified(target) {
                stopped.push(target);
                stopped_pids.insert(pid);
            }
        }
    }

    stopped
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn process_info_reports_own_process_correctly() {
        let info = process_info(std::process::id() as libc::pid_t)
            .expect("own process info should resolve");
        assert_eq!(info.pid, std::process::id() as libc::pid_t);
        assert_eq!(info.ppid, unsafe { libc::getppid() });
        assert_eq!(info.pgid, unsafe { libc::getpgrp() });
        assert!(!info.is_zombie);
        assert!(info.start.0 > 0, "start seconds should be a real timestamp");
    }

    /// Fault injection for PID reuse between snapshot and kill: a target
    /// whose recorded start time no longer matches the live process (here, a
    /// deliberately wrong identity standing in for a recycled pid) must
    /// never be signaled.
    #[test]
    fn signal_verified_refuses_stale_identity_and_accepts_current() {
        let mut victim = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("victim spawn should succeed");
        let pid = victim.id() as libc::pid_t;
        let live = process_info(pid).expect("victim info should resolve");

        let stale = SessionTarget {
            pid,
            start: (live.start.0.wrapping_add(1), live.start.1),
        };
        assert!(
            !signal_verified(stale, libc::SIGKILL),
            "stale identity must refuse to signal"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            victim
                .try_wait()
                .expect("victim wait should succeed")
                .is_none(),
            "victim must survive a stale-identity signal"
        );

        let current = SessionTarget {
            pid,
            start: live.start,
        };
        assert!(
            signal_verified(current, libc::SIGKILL),
            "matching identity must deliver the signal"
        );
        victim.wait().expect("victim reaped");
    }

    /// Fault injection for the verify→SIGSTOP window: the target dies (and
    /// its pid becomes reusable) after the pre-stop identity check. The
    /// protocol must detect the post-stop mismatch, roll back with SIGCONT,
    /// and report failure — never leave an unrelated process stopped.
    #[test]
    fn stop_verified_rolls_back_when_target_changes_inside_the_window() {
        use std::sync::atomic::Ordering;

        let mut victim = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("victim spawn should succeed");
        let pid = victim.id() as libc::pid_t;
        let live = process_info(pid).expect("victim info should resolve");
        let target = SessionTarget {
            pid,
            start: live.start,
        };

        TEST_KILL_AFTER_STOP_PREVERIFY.store(pid, Ordering::Relaxed);
        let stopped = stop_verified(target);
        TEST_KILL_AFTER_STOP_PREVERIFY.store(0, Ordering::Relaxed);
        assert!(
            !stopped,
            "a target that changed inside the verify→stop window must be rejected"
        );
        victim.wait().expect("victim reaped");

        // The plain path still stops a stable target (and identity survives).
        let mut stable = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("stable spawn should succeed");
        let stable_pid = stable.id() as libc::pid_t;
        let stable_live = process_info(stable_pid).expect("stable info should resolve");
        let stable_target = SessionTarget {
            pid: stable_pid,
            start: stable_live.start,
        };
        assert!(stop_verified(stable_target), "stable target must stop");
        assert!(
            process_info(stable_pid).is_some_and(|info| info.is_stopped),
            "stable target should be stopped"
        );
        assert!(signal_verified(stable_target, libc::SIGKILL));
        stable.wait().expect("stable reaped");
    }

    /// Fault injection for a recycled leader between enumeration and freeze:
    /// a leader whose identity no longer matches must not donate its subtree
    /// to the teardown set, and nothing may be left frozen.
    #[test]
    fn freeze_ignores_subtree_of_leader_with_mismatched_identity() {
        let mut parent = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 300 & wait"])
            .spawn()
            .expect("parent spawn should succeed");
        let parent_pid = parent.id() as libc::pid_t;
        let live = process_info(parent_pid).expect("parent info should resolve");

        // Wait for the descendant to exist.
        let descendant = {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if let Some(child) = all_process_info()
                    .into_iter()
                    .find(|info| info.ppid == parent_pid)
                {
                    break child.pid;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "descendant should appear"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };

        let stale_leader = SessionTarget {
            pid: parent_pid,
            start: (live.start.0.wrapping_add(1), live.start.1),
        };
        let frozen = freeze_session_processes(Some(stale_leader), None);
        assert!(
            frozen.is_empty(),
            "a mismatched leader identity must not donate a teardown set: {frozen:?}"
        );
        let descendant_info = process_info(descendant).expect("descendant should still exist");
        assert!(
            !descendant_info.is_stopped,
            "descendant of a mismatched leader must not be frozen"
        );

        // The genuine identity walks (and freezes) the subtree.
        let real_leader = SessionTarget {
            pid: parent_pid,
            start: live.start,
        };
        let frozen = freeze_session_processes(Some(real_leader), None);
        assert!(
            frozen.iter().any(|target| target.pid == descendant),
            "matching leader identity must freeze its descendants: {frozen:?}"
        );

        for target in frozen {
            signal_verified(target, libc::SIGKILL);
        }
        parent.kill().expect("parent cleanup kill");
        parent.wait().expect("parent cleanup wait");
    }

    #[test]
    fn slave_device_of_master_matches_slave_rdev() {
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let ret = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert_eq!(ret, 0, "openpty should succeed");
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::fstat(slave, &mut st) }, 0);
        assert_eq!(
            slave_device_of_master(master),
            Some(st.st_rdev as u32),
            "master-derived slave device should match the slave's rdev"
        );
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
    }
}
