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
//! `proc_pidinfo(PROC_PIDTBSDINFO)`; on Linux they come from `procfs`.
//!
//! The two backends answer the same questions, but Linux's answers carry
//! different guarantees in three places — start-time resolution, "no
//! controlling terminal", and pipe provenance. Each is documented on the
//! Linux `imp` module below, because callers depend on the difference.
//!
//! On every other platform these helpers degrade to "unknown": callers fall
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
        fn proc_pidpath(
            pid: libc::c_int,
            buffer: *mut libc::c_void,
            buffersize: u32,
        ) -> libc::c_int;
    }

    pub fn process_executable_path(pid: libc::pid_t) -> Option<std::path::PathBuf> {
        use std::os::unix::ffi::OsStringExt;

        if pid <= 1 {
            return None;
        }
        const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;
        let mut path = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
        let read = unsafe {
            proc_pidpath(
                pid,
                path.as_mut_ptr().cast(),
                PROC_PIDPATHINFO_MAXSIZE as u32,
            )
        };
        if read <= 0 {
            return None;
        }
        let path_len = path[..read as usize]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(read as usize);
        if path_len == 0 {
            return None;
        }
        path.truncate(path_len);
        Some(std::path::PathBuf::from(std::ffi::OsString::from_vec(path)))
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

    /// Authenticate one transferred descriptor as a genuine end of a pipe
    /// shared with `pid`. Three independent facts must hold:
    ///
    /// 1. the descriptor really is a pipe (not a socket, file, or tty),
    /// 2. our side is open in the direction the role requires — a descriptor
    ///    we will READ (the child's stdout/stderr) must not be writable, and
    ///    one we will WRITE (the child's stdin) must not be readable, and
    /// 3. the kernel's peer handle for it is held by `pid`.
    ///
    /// Together these make the descriptor itself the authority, so no
    /// sender-supplied claim about what an fd is has to be believed.
    pub fn pipe_end_belongs_to(
        fd: std::os::unix::io::RawFd,
        pid: libc::pid_t,
        end: super::PipeEnd,
    ) -> bool {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return false;
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
            return false;
        }
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return false;
        }
        let expected = match end {
            super::PipeEnd::Read => libc::O_RDONLY,
            super::PipeEnd::Write => libc::O_WRONLY,
        };
        if flags & libc::O_ACCMODE != expected {
            return false;
        }
        pipe_peer_handle(fd).map(|peer| pid_holds_pipe_end(pid, peer)) == Some(true)
    }
}

/// Linux backend.
///
/// Every fact the macOS backend gets from `proc_pidinfo` comes from
/// `procfs` here. Three of the primitives differ in *guarantee*, not just in
/// spelling, and callers depend on the difference:
///
/// * **`StartTime` resolution is 10 ms**, not microseconds: `starttime` in
///   `/proc/<pid>/stat` is measured in clock ticks (`_SC_CLK_TCK` is 100).
///   Processes spawned back to back routinely share a tick, so `StartTime`
///   alone distinguishes far less than it does on macOS. The identity used
///   everywhere is the `(pid, start)` *pair*, which is still unique: a pid is
///   not reused until the whole `pid_max` space (4194304 by default) wraps,
///   which cannot happen inside one 10 ms tick.
/// * **"no controlling terminal" is `tty_nr == 0`**, not `NODEV`. It is
///   mapped to [`NO_TTY`] here so the teardown sweep does not treat every
///   detached process as sharing a terminal.
/// * **Both ends of a pipe share one inode.** There is no distinct "far end"
///   handle to bind to, so [`pipe_end_belongs_to`] proves the weaker — but
///   still kernel-authoritative — statement documented on it.
///
/// Every lookup fails *safe*: an unreadable or vanished `/proc` entry (a
/// different uid, a non-dumpable process, an exit racing the scan) reads as
/// "unavailable", never as "alive" or "matching".
#[cfg(target_os = "linux")]
mod imp {
    use super::{ProcessInfo, NO_TTY};
    use std::io::Read;

    /// `/proc/<pid>/exe`. The link carries a ` (deleted)` suffix once the
    /// binary behind it is replaced or unlinked, and that suffix is
    /// deliberately **not** stripped: callers compare these paths byte for
    /// byte as a trust root, and a replaced binary must fail the comparison.
    /// Binaries are therefore upgraded by replacing the file and restarting
    /// the process, never live underneath a running one.
    pub fn process_executable_path(pid: libc::pid_t) -> Option<std::path::PathBuf> {
        if pid <= 1 {
            return None;
        }
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }

    /// Read the whole of a small `/proc` file. `read_to_string` is used
    /// rather than `fs::read_to_string` because `/proc` files report size 0
    /// and the latter would allocate nothing up front; correctness is the
    /// same, this just avoids a needless stat.
    fn read_proc(path: &str) -> Option<String> {
        let mut file = std::fs::File::open(path).ok()?;
        let mut contents = String::new();
        file.read_to_string(&mut contents).ok()?;
        Some(contents)
    }

    /// Parse the fields of `/proc/<pid>/stat` we need.
    ///
    /// `comm` (field 2) is the executable's basename, unquoted and
    /// parenthesised, and may itself contain spaces *and* parentheses — so
    /// the split is at the **last** `)`, never on whitespace.
    fn parse_stat(pid: libc::pid_t, stat: &str) -> Option<ProcessInfo> {
        let rest = &stat[stat.rfind(')')? + 1..];
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // `fields[0]` is field 3 (`state`), so field N is `fields[N - 3]`.
        let field = |n: usize| fields.get(n - 3).copied();

        let state = field(3)?;
        let ppid: libc::pid_t = field(4)?.parse().ok()?;
        let pgid: libc::pid_t = field(5)?.parse().ok()?;
        // `tty_nr` is a signed int in procfs; 0 means "no controlling
        // terminal", which the rest of this module spells `NO_TTY`.
        let tty_nr: i32 = field(7)?.parse().ok()?;
        let starttime: u64 = field(22)?.parse().ok()?;

        Some(ProcessInfo {
            pid,
            ppid,
            pgid,
            tdev: if tty_nr == 0 { NO_TTY } else { tty_nr as u32 },
            is_zombie: state == "Z",
            // `t` is tracing-stop; it is as stopped as `T` for teardown.
            is_stopped: state == "T" || state == "t",
            start: (starttime, 0),
        })
    }

    pub fn process_info(pid: libc::pid_t) -> Option<ProcessInfo> {
        if pid <= 0 {
            return None;
        }
        parse_stat(pid, &read_proc(&format!("/proc/{pid}/stat"))?)
    }

    pub fn all_process_info() -> Vec<ProcessInfo> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::pid_t>().ok())
            // A pid that exits mid-scan is "gone", not an error.
            .filter_map(process_info)
            .collect()
    }

    /// Inode of the pipe behind `fd`. On Linux both ends of a pipe share one
    /// inode, so this identifies the *pipe*, not an end of it — see
    /// [`pipe_end_belongs_to`].
    pub fn pipe_peer_handle(fd: std::os::unix::io::RawFd) -> Option<u64> {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return None;
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
            return None;
        }
        let inode = stat.st_ino;
        if inode == 0 {
            None
        } else {
            Some(inode)
        }
    }

    /// True when `pid` holds pipe `handle` open in `mode` (`O_RDONLY` or
    /// `O_WRONLY`). The descriptor is located through
    /// `/proc/<pid>/fd/<n>` → `pipe:[<inode>]` and its direction read from
    /// `/proc/<pid>/fdinfo/<n>`'s octal `flags:` line.
    fn pid_holds_pipe_end_in_mode(pid: libc::pid_t, handle: u64, mode: libc::c_int) -> bool {
        if pid <= 0 || handle == 0 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            return false;
        };
        let wanted = format!("pipe:[{handle}]");
        for entry in entries.flatten() {
            let Ok(link) = std::fs::read_link(entry.path()) else {
                continue;
            };
            if link.to_str() != Some(wanted.as_str()) {
                continue;
            }
            let Some(fd_name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(fdinfo) = read_proc(&format!("/proc/{pid}/fdinfo/{fd_name}")) else {
                continue;
            };
            let Some(flags) = fdinfo.lines().find_map(|line| {
                let value = line.strip_prefix("flags:")?.trim();
                libc::c_int::from_str_radix(value, 8).ok()
            }) else {
                continue;
            };
            if flags & libc::O_ACCMODE == mode {
                return true;
            }
        }
        false
    }

    /// True when `pid` holds pipe `handle` open at all, in either direction.
    /// Kept for symmetry with the macOS backend; authentication goes through
    /// [`pipe_end_belongs_to`], which also pins the direction.
    pub fn pid_holds_pipe_end(pid: libc::pid_t, handle: u64) -> bool {
        pid_holds_pipe_end_in_mode(pid, handle, libc::O_RDONLY)
            || pid_holds_pipe_end_in_mode(pid, handle, libc::O_WRONLY)
    }

    pub fn socket_peer_pid(socket_fd: std::os::unix::io::RawFd) -> Option<libc::pid_t> {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let ret = unsafe {
            libc::getsockopt(
                socket_fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut libc::ucred as *mut libc::c_void,
                &mut len,
            )
        };
        // Frozen at `connect()`, exactly like macOS's `LOCAL_PEERPID`: the
        // pid survives the peer's exit, so live identity rechecks stay
        // mandatory at every use site.
        if ret == 0 && cred.pid > 1 {
            Some(cred.pid)
        } else {
            None
        }
    }

    /// Resolve the slave tty device number for a PTY master fd
    /// (`TIOCGPTN` + `stat` of `/dev/pts/<n>`). The kernel's
    /// `new_encode_dev()` (what `/proc/<pid>/stat` reports as `tty_nr`) and
    /// glibc's `st_rdev` agree bit for bit in the 32-bit range, so the value
    /// compares directly against [`ProcessInfo::tdev`]. A device that does
    /// not fit 32 bits (only reachable for `major > 0xfff`) fails safe.
    pub fn slave_device_of_master(master_fd: std::os::unix::io::RawFd) -> Option<u32> {
        let mut pty_number: libc::c_uint = 0;
        let ret = unsafe {
            libc::ioctl(
                master_fd,
                libc::TIOCGPTN,
                &mut pty_number as *mut libc::c_uint,
            )
        };
        if ret != 0 {
            return None;
        }
        let path = std::ffi::CString::new(format!("/dev/pts/{pty_number}")).ok()?;
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::stat(path.as_ptr(), &mut st) } != 0 {
            return None;
        }
        let dev = u32::try_from(st.st_rdev).ok()?;
        if dev == NO_TTY {
            None
        } else {
            Some(dev)
        }
    }

    /// Authenticate one transferred descriptor as a genuine end of a pipe
    /// shared with `pid`. Three independent facts must hold:
    ///
    /// 1. the descriptor really is a pipe (not a socket, file, or tty),
    /// 2. our side is open in the direction the role requires — a descriptor
    ///    we will READ (the child's stdout/stderr) must not be writable, and
    ///    one we will WRITE (the child's stdin) must not be readable, and
    /// 3. `pid` holds *this same pipe* open in the **opposite** direction.
    ///
    /// Point 3 is deliberately weaker than the macOS backend's claim, and the
    /// difference is a kernel one: on Linux both ends of a pipe share a single
    /// inode, so no "far end" handle exists to bind to. The strongest fact
    /// procfs can prove is "some descriptor in `pid` refers to this pipe and
    /// is open the other way round" — it cannot prove that descriptor is the
    /// *only* far end. That is still kernel-authoritative and still
    /// independent of anything the sender claims, which is what the callers
    /// rely on; it just may not be stated more strongly than this.
    pub fn pipe_end_belongs_to(
        fd: std::os::unix::io::RawFd,
        pid: libc::pid_t,
        end: super::PipeEnd,
    ) -> bool {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return false;
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
            return false;
        }
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return false;
        }
        let (ours, theirs) = match end {
            super::PipeEnd::Read => (libc::O_RDONLY, libc::O_WRONLY),
            super::PipeEnd::Write => (libc::O_WRONLY, libc::O_RDONLY),
        };
        if flags & libc::O_ACCMODE != ours {
            return false;
        }
        let Some(handle) = pipe_peer_handle(fd) else {
            return false;
        };
        pid_holds_pipe_end_in_mode(pid, handle, theirs)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// `comm` is the raw executable basename: it may contain spaces and
        /// parentheses, so the field split must key off the LAST `)`.
        #[test]
        fn stat_with_parens_and_spaces_in_comm_parses() {
            let stat = "4242 (we ird) (name)) S 7 9 9 1027 4242 4194304 100 0 0 0 1 2 3 4 20 0 1 0 987654 1 2 3";
            let info = parse_stat(4242, stat).expect("stat should parse");
            assert_eq!(info.pid, 4242);
            assert_eq!(info.ppid, 7);
            assert_eq!(info.pgid, 9);
            assert_eq!(info.tdev, 1027);
            assert!(!info.is_zombie);
            assert!(!info.is_stopped);
            assert_eq!(info.start, (987654, 0));
        }

        /// `tty_nr == 0` is Linux's "no controlling terminal". Left as 0 it
        /// would make every detached process look like it shares device 0,
        /// and the teardown sweep would kill unrelated processes.
        #[test]
        fn no_controlling_terminal_maps_to_no_tty() {
            let stat = "5 (x) S 1 5 5 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 42 0 0";
            let info = parse_stat(5, stat).expect("stat should parse");
            assert_eq!(info.tdev, NO_TTY);
        }

        #[test]
        fn zombie_and_both_stopped_states_are_recognised() {
            let with_state = |state: &str| {
                let stat =
                    format!("5 (x) {state} 1 5 5 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 42 0 0");
                parse_stat(5, &stat).expect("stat should parse")
            };
            assert!(with_state("Z").is_zombie);
            assert!(with_state("T").is_stopped);
            // Tracing stop is as stopped as SIGSTOP for teardown purposes.
            assert!(with_state("t").is_stopped);
            assert!(!with_state("S").is_zombie);
            assert!(!with_state("S").is_stopped);
        }

        /// A pipe end must not authenticate against a peer holding the SAME
        /// direction: on Linux both ends share an inode, so direction is the
        /// only thing separating "the far end" from a dup of our own end.
        #[test]
        fn pipe_end_requires_the_peer_to_hold_the_opposite_direction() {
            let mut fds = [0 as libc::c_int; 2];
            assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
            let (read_end, write_end) = (fds[0], fds[1]);
            let me = std::process::id() as libc::pid_t;

            // We hold both ends, so we are our own peer in both directions.
            assert!(pipe_end_belongs_to(
                read_end,
                me,
                super::super::PipeEnd::Read
            ));
            assert!(pipe_end_belongs_to(
                write_end,
                me,
                super::super::PipeEnd::Write
            ));

            // Dropping the write end leaves nobody holding the opposite
            // direction, so the read end no longer authenticates.
            unsafe { libc::close(write_end) };
            assert!(!pipe_end_belongs_to(
                read_end,
                me,
                super::super::PipeEnd::Read
            ));

            // A read end presented as a write end is refused outright.
            assert!(!pipe_end_belongs_to(
                read_end,
                me,
                super::super::PipeEnd::Write
            ));
            unsafe { libc::close(read_end) };
        }

        /// The guarantee `stop_verified`'s fault injection depends on: an
        /// unreaped zombie keeps its full `/proc` identity, so the pid is
        /// pinned and cannot have been recycled. It disappears only on reap.
        #[test]
        fn an_unreaped_zombie_keeps_its_identity_and_loses_it_on_reap() {
            let mut victim = std::process::Command::new("/bin/sleep")
                .arg("300")
                .spawn()
                .expect("victim spawn should succeed");
            let pid = victim.id() as libc::pid_t;
            let live = process_info(pid).expect("live victim should resolve");

            victim.kill().expect("victim kill");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match process_info(pid) {
                    Some(info) if info.is_zombie => {
                        assert_eq!(
                            info.start, live.start,
                            "a zombie must keep the identity that pins its pid"
                        );
                        break;
                    }
                    _ => {
                        assert!(std::time::Instant::now() < deadline, "victim should zombie");
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
            }

            victim.wait().expect("victim reaped");
            assert!(
                process_info(pid).is_none_or(|info| info.start != live.start),
                "a reaped pid must no longer answer with the old identity"
            );
        }

        #[test]
        fn socket_peer_pid_reports_this_process_over_a_socketpair() {
            let mut fds = [0 as libc::c_int; 2];
            assert_eq!(
                unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) },
                0
            );
            assert_eq!(
                socket_peer_pid(fds[0]),
                Some(std::process::id() as libc::pid_t)
            );
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use super::ProcessInfo;

    pub fn process_executable_path(_pid: libc::pid_t) -> Option<std::path::PathBuf> {
        None
    }

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

    pub fn pipe_end_belongs_to(
        _fd: std::os::unix::io::RawFd,
        _pid: libc::pid_t,
        _end: super::PipeEnd,
    ) -> bool {
        false
    }
}

// `pipe_peer_handle`/`pid_holds_pipe_end` stay module-private on purpose:
// on their own they answer "is this fd's far end held by that pid", which is
// only half an authentication. Callers must go through
// [`pipe_end_belongs_to`], which also proves the fd is a pipe and is open in
// the direction its role requires.
pub use imp::{
    all_process_info, pipe_end_belongs_to, process_executable_path, process_info,
    slave_device_of_master, socket_peer_pid,
};

/// Which end of a pipe WE hold, and therefore which access mode a genuine
/// transferred descriptor for that role must have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeEnd {
    /// We read from it: the child's stdout or stderr.
    Read,
    /// We write to it: the child's stdin.
    Write,
}

/// True when `pid` currently refers to the process with the given start-time
/// identity. This is the gate for any pid-targeted signal: a recycled pid has
/// a different start time and must never be signaled.
///
/// Zombies differ by platform, and the difference is the kernel's, not a
/// choice: macOS's `proc_pidinfo` stops reporting a process the moment it
/// dies, so a zombie never matches there, while Linux keeps `/proc/<pid>`
/// fully readable until the parent reaps it, so a zombie does match. Linux is
/// the safer of the two -- an unreaped zombie *pins* its pid, so a match
/// cannot be a recycled process -- and callers that need liveness rather than
/// identity already use [`identity_alive`].
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
            // On Linux an unreaped zombie keeps `/proc/<pid>` -- and with it
            // the full start-time identity -- readable, so SIGKILL alone does
            // not release the pid and does not simulate the recycling this
            // fixture is about. Reaping does. (macOS needs no equivalent:
            // `proc_pidinfo` already reports a zombie as gone, so the pid
            // there stops matching the moment the target dies. The
            // consequence is that macOS exercises the post-stop rollback
            // branch below while Linux takes the `kill` failure path; both
            // assert the property that matters -- a target that changed
            // inside the window is never reported frozen.)
            #[cfg(target_os = "linux")]
            {
                let mut status: libc::c_int = 0;
                unsafe { libc::waitpid(target.pid, &mut status, 0) };
            }
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

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
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
        // The injection may already have reaped it (see `stop_verified`).
        let _ = victim.wait();

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
        // `kill` returning is delivery, not observation: the reported state
        // catches up a moment later, so poll rather than read once. The
        // protocol's own guarantee is that a stopped process cannot exit,
        // which this only has to confirm eventually.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !process_info(stable_pid).is_some_and(|info| info.is_stopped) {
            assert!(
                std::time::Instant::now() < deadline,
                "stable target should be stopped: {:?}",
                process_info(stable_pid)
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
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
