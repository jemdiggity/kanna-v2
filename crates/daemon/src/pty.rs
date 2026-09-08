use std::collections::HashMap;
use std::ffi::CString;
use std::io;
#[cfg(test)]
use std::io::Read;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Instant;

const CHILD_EXIT_SETSID: libc::c_int = 120;
const CHILD_EXIT_CONTROLLING_TTY: libc::c_int = 121;
const CHILD_EXIT_DUP_STDIO: libc::c_int = 122;
const CHILD_EXIT_CHDIR: libc::c_int = 123;

fn child_fatal(message: &'static [u8], code: libc::c_int) -> ! {
    unsafe {
        let _ = libc::write(
            libc::STDERR_FILENO,
            message.as_ptr() as *const libc::c_void,
            message.len(),
        );
        libc::_exit(code);
    }
}

fn validate_cwd(cwd: &str) -> io::Result<()> {
    let path = std::path::Path::new(cwd);
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("cwd is not a directory: {}", cwd),
        ));
    }

    std::fs::read_dir(path).map(|_| ())
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }

    let ret = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

fn open_pty(master_fd: &mut RawFd, slave_fd: &mut RawFd) -> io::Result<()> {
    #[cfg(debug_assertions)]
    {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static OPEN_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
        let fail_after = std::env::var("KANNA_TEST_PTY_ENXIO_AFTER")
            .ok()
            .and_then(|value| value.parse::<usize>().ok());
        if fail_after
            .is_some_and(|allowed| OPEN_ATTEMPTS.fetch_add(1, Ordering::Relaxed) == allowed)
        {
            return Err(io::Error::from_raw_os_error(libc::ENXIO));
        }
    }

    let ret = unsafe {
        libc::openpty(
            master_fd,
            slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// True when a PTY spawn error chain contains macOS/Linux `ENXIO`.
///
/// `openpty(3)` reports this when the host PTY pool cannot allocate another
/// pair. Keep the source-chain walk here, next to the allocation boundary, so
/// callers can add occupancy diagnostics without string-matching OS messages.
pub fn is_pty_exhaustion_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(candidate) = current {
        if let Some(io_error) = candidate.downcast_ref::<io::Error>() {
            if io_error.raw_os_error() == Some(libc::ENXIO) {
                return true;
            }
            if let Some(inner) = io_error.get_ref() {
                if is_pty_exhaustion_error(inner) {
                    return true;
                }
            }
        }
        current = candidate.source();
    }
    false
}

/// How confidently this daemon can tie `child_pid` to the process it is
/// supposed to signal. Signals are only ever sent while ownership is
/// provable; once it degrades to `Unproven` the pid may belong to an
/// unrelated process (PID reuse) and must never be targeted again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildOwnership {
    /// This daemon forked the child. The pid cannot be reused until the
    /// child is reaped; `reaped` flips when that happens (locally or by an
    /// out-of-band waiter, observed as `ECHILD`).
    Owned {
        reaped: bool,
        identity: Option<crate::proc_info::StartTime>,
    },
    /// Adopted through handoff with an authenticated start-time identity
    /// (matched against transferred metadata or the live process on this
    /// session's terminal). Re-verified before every signal.
    Adopted {
        identity: crate::proc_info::StartTime,
    },
    /// Identity could never be (or can no longer be) proven — invalid or
    /// stale handoff metadata, or a detected PID reuse. Never signaled.
    Unproven,
}

/// Validate a wire-transferred pid. Rejects 0 (own process group), 1
/// (init / a `-1` group target after negation), and values whose `i32`
/// conversion would go negative and turn `kill(-pid)` into a broadcast.
pub(crate) fn validated_child_pid(raw: u32) -> Option<libc::pid_t> {
    if raw <= 1 || raw > i32::MAX as u32 {
        None
    } else {
        Some(raw as libc::pid_t)
    }
}

#[cfg(test)]
pub(crate) static TEST_INHERITABLE_WINDOW_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// The off-lock half of PTY teardown: the leader has already been frozen
/// under the session lock; the whole-process-table sweep and every SIGKILL
/// run here, on the bounded lifecycle executor.
#[derive(Debug, Clone, Copy)]
pub struct PtyKillPlan {
    leader: Option<libc::pid_t>,
    leader_target: Option<crate::proc_info::SessionTarget>,
    leader_frozen: bool,
    owned: bool,
    tty_dev: Option<u32>,
}

impl PtyKillPlan {
    /// Execute the sweep. `table` optionally supplies a pre-taken process
    /// table snapshot so a many-session teardown scans once instead of
    /// rescanning per session.
    pub fn execute(self, table: Option<&[crate::proc_info::ProcessInfo]>) -> io::Result<()> {
        let frozen = crate::proc_info::freeze_session_processes_with(
            self.leader_target,
            self.tty_dev,
            table,
        );

        let mut primary = Ok(());
        if let Some(pid) = self.leader {
            // Strike only through a leader frozen under verified identity (or
            // our own unreaped child, whose pid is pinned by the pending
            // reap). The re-check guards an external SIGKILL+reuse.
            let still_ours = self.leader_frozen
                && (self.owned
                    || self
                        .leader_target
                        .is_some_and(|t| crate::proc_info::identity_matches(t.pid, t.start)));
            if still_ours {
                let group = unsafe { libc::kill(-pid, libc::SIGKILL) };
                if group != 0 {
                    // Group kill can fail when the group is already gone
                    // (ESRCH) or when its only remaining member is a zombie
                    // awaiting reap (macOS reports EPERM). Fall back to the
                    // direct pid so kill never regresses below single-pid.
                    let direct = unsafe { libc::kill(pid, libc::SIGKILL) };
                    if direct != 0 {
                        primary = Err(io::Error::last_os_error());
                    }
                }
            }
        }
        for target in frozen {
            crate::proc_info::signal_verified(target, libc::SIGKILL);
        }
        primary
    }
}

impl PtyKillPlan {
    /// Strike phase only: the caller has already frozen this plan's teardown
    /// set (see [`execute_batch`]). Requires a successful freeze plus
    /// identity/pending-reap continuity before any group signal.
    fn strike(self, frozen: Vec<crate::proc_info::SessionTarget>) -> io::Result<()> {
        let mut primary = Ok(());
        if let Some(pid) = self.leader {
            let still_ours = self.leader_frozen
                && (self.owned
                    || self
                        .leader_target
                        .is_some_and(|t| crate::proc_info::identity_matches(t.pid, t.start)));
            if still_ours {
                let group = unsafe { libc::kill(-pid, libc::SIGKILL) };
                if group != 0 {
                    let direct = unsafe { libc::kill(pid, libc::SIGKILL) };
                    if direct != 0 {
                        primary = Err(io::Error::last_os_error());
                    }
                }
            }
        }
        for target in frozen {
            crate::proc_info::signal_verified(target, libc::SIGKILL);
        }
        primary
    }

    /// Execute many plans with scan rounds batched across all of them: one
    /// process-table snapshot per round for the whole batch, instead of one
    /// (or more) per session.
    pub fn execute_batch(plans: Vec<PtyKillPlan>) -> Vec<io::Result<()>> {
        let specs: Vec<(Option<crate::proc_info::SessionTarget>, Option<u32>)> = plans
            .iter()
            .map(|plan| (plan.leader_target, plan.tty_dev))
            .collect();
        let frozen_sets = crate::proc_info::freeze_many(&specs);
        plans
            .into_iter()
            .zip(frozen_sets)
            .map(|(plan, frozen)| plan.strike(frozen))
            .collect()
    }
}

/// A PTY session backed by raw libc calls.
/// Stores the master fd directly so it can be extracted for handoff.
pub struct PtySession {
    master_fd: OwnedFd,
    child_pid: libc::pid_t,
    ownership: ChildOwnership,
    /// Slave tty device number — the session's teardown lifecycle boundary.
    tty_dev: Option<u32>,
    pub cwd: String,
    rows: u16,
    cols: u16,
    pub last_active_at: Instant,
}

impl PtySession {
    pub fn spawn(
        executable: &str,
        args: &[String],
        cwd: &str,
        env: &HashMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        validate_cwd(cwd)?;
        let stripped_env_keys = crate::subprocess_env::inherited_env_keys_to_strip();
        let stripped_env_keys_c: Vec<CString> = stripped_env_keys
            .iter()
            .map(|key| {
                CString::new(key.as_str()).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("environment key to strip contains NUL byte: {key:?}"),
                    )
                })
            })
            .collect::<io::Result<_>>()?;
        let env_c: Vec<(CString, CString)> = env
            .iter()
            .map(|(key, value)| {
                let key_c = CString::new(key.as_str()).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("environment key contains NUL byte: {key:?}"),
                    )
                })?;
                let value_c = CString::new(value.as_str()).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("environment value for {key:?} contains NUL byte"),
                    )
                })?;
                Ok((key_c, value_c))
            })
            .collect::<io::Result<_>>()?;
        let cwd_c = CString::new(cwd)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "cwd contains NUL byte"))?;
        let exec_c = CString::new(executable).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "executable contains NUL byte")
        })?;
        let mut argv_c = Vec::with_capacity(args.len() + 1);
        argv_c.push(exec_c.clone());
        for (index, arg) in args.iter().enumerate() {
            argv_c.push(CString::new(arg.as_str()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("argument {index} contains NUL byte"),
                )
            })?);
        }
        let mut argv_ptrs: Vec<*const libc::c_char> =
            argv_c.iter().map(|arg| arg.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());

        let mut master_fd: RawFd = -1;
        let mut slave_fd: RawFd = -1;

        // openpty cannot create the pair CLOEXEC atomically, so hold the
        // process-wide spawn/fd boundary from before the fds exist until
        // after the fork below: no other thread may fork/exec while the pair
        // is inheritable, and no other thread may open an inheritable window
        // while this fork runs.
        let _spawn_boundary = crate::fd::spawn_fd_boundary();

        // Open PTY pair
        open_pty(&mut master_fd, &mut slave_fd)?;

        #[cfg(test)]
        {
            // Widen the inheritable window so tests can prove the boundary
            // excludes concurrent spawns from observing it.
            let window = TEST_INHERITABLE_WINDOW_MS.load(std::sync::atomic::Ordering::Relaxed);
            if window > 0 {
                std::thread::sleep(std::time::Duration::from_millis(window));
            }
        }

        // Mark both ends close-on-exec immediately: the daemon forks/execs
        // many children (other sessions' shells, the recovery sidecar,
        // headless agents), and an inherited master fd keeps the pty
        // allocated in the kernel's global pool for the child's lifetime.
        // The child below gets its stdio via dup2, which clears the flag on
        // the duplicates, so the exec'd session child still owns its tty.
        if let Err(error) =
            crate::fd::set_cloexec(master_fd).and_then(|_| crate::fd::set_cloexec(slave_fd))
        {
            unsafe {
                libc::close(master_fd);
                libc::close(slave_fd);
            }
            return Err(error.into());
        }

        // The slave's device number is the durable lifecycle boundary used at
        // teardown to find every process still on this terminal.
        let tty_dev = {
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstat(slave_fd, &mut st) } == 0 {
                Some(st.st_rdev as u32)
            } else {
                None
            }
        };

        // Set initial size
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe { libc::ioctl(master_fd, libc::TIOCSWINSZ, &ws) };
        if ret != 0 {
            log::warn!(
                "failed to set initial PTY size to {}x{}: {}",
                cols,
                rows,
                io::Error::last_os_error()
            );
        }

        // Fork
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            unsafe {
                libc::close(master_fd);
                libc::close(slave_fd);
            }
            return Err(io::Error::last_os_error().into());
        }

        if pid == 0 {
            // ---- Child process ----
            unsafe {
                // Close master side
                libc::close(master_fd);

                // Create new session and set controlling terminal
                if libc::setsid() < 0 {
                    child_fatal(
                        b"kanna-daemon: failed to create child session with setsid\n",
                        CHILD_EXIT_SETSID,
                    );
                }
                if libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0) < 0 {
                    child_fatal(
                        b"kanna-daemon: failed to set PTY controlling terminal\n",
                        CHILD_EXIT_CONTROLLING_TTY,
                    );
                }

                // Redirect stdio to slave
                if libc::dup2(slave_fd, 0) < 0
                    || libc::dup2(slave_fd, 1) < 0
                    || libc::dup2(slave_fd, 2) < 0
                {
                    child_fatal(
                        b"kanna-daemon: failed to connect child stdio to PTY\n",
                        CHILD_EXIT_DUP_STDIO,
                    );
                }
                if slave_fd > 2 {
                    libc::close(slave_fd);
                }

                // Change directory
                if libc::chdir(cwd_c.as_ptr()) < 0 {
                    child_fatal(
                        b"kanna-daemon: failed to change child working directory\n",
                        CHILD_EXIT_CHDIR,
                    );
                }

                for key_c in &stripped_env_keys_c {
                    libc::unsetenv(key_c.as_ptr());
                }

                // Re-apply explicit per-session overrides after scrubbing any
                // inherited KANNA_/webdriver control-plane env vars.
                for (k_c, v_c) in &env_c {
                    libc::setenv(k_c.as_ptr(), v_c.as_ptr(), 1);
                }

                libc::execvp(exec_c.as_ptr(), argv_ptrs.as_ptr());

                // If exec fails, exit
                let _ = libc::write(
                    libc::STDERR_FILENO,
                    b"kanna-daemon: failed to exec child command\n".as_ptr() as *const libc::c_void,
                    b"kanna-daemon: failed to exec child command\n".len(),
                );
                libc::_exit(127);
            }
        }

        // ---- Parent process ----
        unsafe { libc::close(slave_fd) };

        // Record the child's start-time identity while it is provably ours.
        let identity = crate::proc_info::process_info(pid).map(|info| info.start);
        drop(_spawn_boundary);

        set_nonblocking(master_fd)?;
        let master = unsafe { OwnedFd::from_raw_fd(master_fd) };

        Ok(PtySession {
            master_fd: master,
            child_pid: pid,
            ownership: ChildOwnership::Owned {
                reaped: false,
                identity,
            },
            tty_dev,
            cwd: cwd.to_string(),
            rows,
            cols,
            last_active_at: Instant::now(),
        })
    }

    /// Adopt a session from a transferred master fd (handoff).
    ///
    /// `child_pid_raw` and `child_start` are untrusted wire metadata. Signal
    /// authority comes exclusively from descriptor provenance: the pid must
    /// be in range, live, and have this session's slave tty (derived from
    /// the transferred master fd itself) as its controlling terminal.
    /// Metadata never authorizes signaling — a forged pid+start pair naming
    /// an unrelated live process is rejected because that process is not on
    /// this terminal. The identity recorded for later re-verification is the
    /// live on-terminal process's own start time, not the metadata.
    pub fn adopt(
        master_fd: OwnedFd,
        child_pid_raw: u32,
        child_start: Option<crate::proc_info::StartTime>,
        cwd: String,
        rows: u16,
        cols: u16,
    ) -> Self {
        if let Err(error) = set_nonblocking(master_fd.as_raw_fd()) {
            log::warn!("failed to set adopted PTY master non-blocking: {}", error);
        }
        let tty_dev = crate::proc_info::slave_device_of_master(master_fd.as_raw_fd());
        let (child_pid, ownership) = match validated_child_pid(child_pid_raw) {
            None => {
                log::warn!(
                    "[adopt] rejecting out-of-range handoff pid {}; session will not be signalable",
                    child_pid_raw
                );
                (0, ChildOwnership::Unproven)
            }
            Some(pid) => {
                let ownership = match crate::proc_info::process_info(pid) {
                    None => {
                        log::info!(
                            "[adopt] handoff pid {} is gone; refusing signal targeting (pid may be reused)",
                            pid
                        );
                        ChildOwnership::Unproven
                    }
                    Some(info) => {
                        let on_this_terminal = tty_dev.is_some() && Some(info.tdev) == tty_dev;
                        if on_this_terminal {
                            if child_start.is_some() && child_start != Some(info.start) {
                                log::warn!(
                                    "[adopt] handoff pid {}: transferred start {:?} disagrees \
                                     with live on-terminal process {:?}; trusting the terminal",
                                    pid,
                                    child_start,
                                    info.start
                                );
                            }
                            ChildOwnership::Adopted {
                                identity: info.start,
                            }
                        } else {
                            log::warn!(
                                "[adopt] handoff pid {} is not on this session's terminal \
                                 (metadata start {:?}); refusing signal targeting",
                                pid,
                                child_start
                            );
                            ChildOwnership::Unproven
                        }
                    }
                };
                (pid, ownership)
            }
        };
        PtySession {
            master_fd,
            child_pid,
            ownership,
            tty_dev,
            cwd,
            rows,
            cols,
            last_active_at: Instant::now(),
        }
    }

    /// Clone the master fd for a reader. The returned fd is independently owned.
    #[cfg(test)]
    pub fn try_clone_reader(
        &self,
    ) -> Result<Box<dyn Read + Send>, Box<dyn std::error::Error + Send + Sync>> {
        let new_fd = crate::fd::dup_cloexec(self.master_fd.as_raw_fd())?;
        let file = unsafe { std::fs::File::from_raw_fd(new_fd) };
        Ok(Box::new(file))
    }

    pub fn try_clone_io_fd(&self) -> io::Result<OwnedFd> {
        let new_fd = crate::fd::dup_cloexec(self.master_fd.as_raw_fd())?;
        set_nonblocking(new_fd)?;
        Ok(unsafe { OwnedFd::from_raw_fd(new_fd) })
    }

    /// Clone the master fd for writing (e.g. kitty keyboard responses).
    #[allow(dead_code)]
    pub fn try_clone_writer(&self) -> Result<OwnedFd, Box<dyn std::error::Error + Send + Sync>> {
        let new_fd = crate::fd::dup_cloexec(self.master_fd.as_raw_fd())?;
        Ok(unsafe { OwnedFd::from_raw_fd(new_fd) })
    }

    /// Clone the master fd for handoff while the current daemon keeps
    /// ownership until the adopting daemon acknowledges success.
    pub fn try_clone_handoff_fd(
        &self,
    ) -> Result<OwnedFd, Box<dyn std::error::Error + Send + Sync>> {
        self.try_clone_writer()
    }

    pub fn resize(
        &mut self,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe { libc::ioctl(self.master_fd.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
        if ret != 0 {
            return Err(io::Error::last_os_error().into());
        }
        self.rows = rows;
        self.cols = cols;
        Ok(())
    }

    pub fn pid(&self) -> u32 {
        self.child_pid as u32
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn try_wait(&mut self) -> Option<i32> {
        // Only an owned, unreaped child can be waited on. Adopted children
        // belong to the exited old daemon (waitpid would report ECHILD), and
        // an unproven pid must never be waited on: pid 0 or a stale value
        // would target the wrong process (group).
        if !matches!(self.ownership, ChildOwnership::Owned { reaped: false, .. }) {
            return None;
        }
        let mut status: libc::c_int = 0;
        let ret = unsafe { libc::waitpid(self.child_pid, &mut status, libc::WNOHANG) };
        if ret == self.child_pid {
            self.mark_reaped();
            if libc::WIFEXITED(status) {
                Some(libc::WEXITSTATUS(status))
            } else if libc::WIFSIGNALED(status) {
                Some(128 + libc::WTERMSIG(status))
            } else {
                Some(1)
            }
        } else {
            if ret < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                // Someone else (e.g. the background reaper) already reaped
                // the child. The pid can be reused from here on — ownership
                // is no longer provable.
                self.mark_reaped();
            }
            None
        }
    }

    fn mark_reaped(&mut self) {
        if let ChildOwnership::Owned { reaped, .. } = &mut self.ownership {
            *reaped = true;
        }
    }

    /// Resolve the child pid iff ownership is still provable. Verifies
    /// adopted identities against the live process table and demotes to
    /// `Unproven` on any mismatch (PID reuse) or disappearance.
    fn provable_child(&mut self) -> Option<libc::pid_t> {
        match self.ownership {
            ChildOwnership::Owned { reaped: true, .. } | ChildOwnership::Unproven => None,
            ChildOwnership::Owned { reaped: false, .. } => {
                // An unreaped child's pid cannot be recycled, but detect
                // out-of-band reaping: waitid with WNOWAIT leaves any
                // pending status in place.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                let ret = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        self.child_pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                };
                if ret < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                    self.mark_reaped();
                    return None;
                }
                Some(self.child_pid)
            }
            ChildOwnership::Adopted { identity } => {
                match crate::proc_info::process_info(self.child_pid) {
                    Some(info) if info.start == identity => Some(self.child_pid),
                    observed => {
                        log::info!(
                            "[pty] adopted child {} identity no longer provable \
                             (expected start {:?}, observed {:?}); refusing further signals",
                            self.child_pid,
                            identity,
                            observed.map(|info| info.start)
                        );
                        self.ownership = ChildOwnership::Unproven;
                        None
                    }
                }
            }
        }
    }

    /// Check if the child process is still alive.
    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        match self.ownership {
            ChildOwnership::Owned { reaped: true, .. } | ChildOwnership::Unproven => false,
            ChildOwnership::Owned { reaped: false, .. } => unsafe {
                libc::kill(self.child_pid, 0) == 0
            },
            ChildOwnership::Adopted { identity } => crate::proc_info::process_info(self.child_pid)
                .map(|info| info.start == identity && !info.is_zombie)
                .unwrap_or(false),
        }
    }

    /// Consume the one-shot right to reap the child after a kill. The first
    /// caller gets the exact `(pid, start_time)` identity and the record is
    /// marked reaped in the same
    /// mutation (callers hold the PTY lock), so exactly one background reaper
    /// can ever exist and every later kill/signal sees terminated ownership —
    /// a pid recycled after the real reap can never be targeted.
    pub fn take_reap_token(
        &mut self,
    ) -> Option<(libc::pid_t, Option<crate::proc_info::StartTime>)> {
        match &mut self.ownership {
            ChildOwnership::Owned {
                reaped: reaped @ false,
                identity,
            } => {
                *reaped = true;
                Some((self.child_pid, *identity))
            }
            _ => None,
        }
    }

    /// Start-time identity of the child, when ownership is provable.
    /// Transferred as handoff metadata so the adopting daemon can
    /// authenticate the pid it receives.
    pub fn child_identity(&self) -> Option<crate::proc_info::StartTime> {
        match self.ownership {
            ChildOwnership::Owned { identity, .. } => identity,
            ChildOwnership::Adopted { identity } => Some(identity),
            ChildOwnership::Unproven => None,
        }
    }

    /// Tear down the whole session. Reaping is the caller's responsibility
    /// (see `SessionHandle::kill`): a blocking `waitpid` here can hang
    /// forever when the child is stuck exiting inside the kernel, wedging
    /// the daemon connection that issued the kill.
    ///
    /// `kill(-leader)` alone is not sufficient: interactive shells give each
    /// job its own process group and descendants may `setpgid()`/`setsid()`
    /// away, then survive to pin the PTY. Teardown therefore freezes and
    /// kills the session's full teardown set — descendants of the leader
    /// plus every process whose controlling terminal is this session's
    /// slave — before striking the leader's group. All pid-targeted phases
    /// are gated on provable ownership; the terminal-membership sweep is
    /// self-authenticating (the slave device exists only while this master
    /// is open).
    /// Phase 1 of teardown, cheap enough to run under the session lock:
    /// resolve and freeze the leader (so nothing can fork or reparent), then
    /// hand back the plan for the expensive process-table sweep, which
    /// [`PtyKillPlan::execute`] runs off-lock on the bounded lifecycle
    /// executor. Splitting it keeps whole-table scans and signalling out of
    /// both the PTY mutex and the Tokio worker pool.
    pub fn begin_kill(&mut self) -> PtyKillPlan {
        let leader = self.provable_child();
        let leader_target = leader.and_then(|pid| {
            self.child_identity()
                .map(|start| crate::proc_info::SessionTarget { pid, start })
        });
        let owned = self.owns_child_pid();
        let leader_frozen = match (leader, leader_target) {
            (None, _) => false,
            (Some(pid), _) if owned => {
                unsafe { libc::kill(pid, libc::SIGSTOP) };
                true
            }
            (Some(_), Some(target)) => {
                let stopped = crate::proc_info::stop_verified(target);
                if !stopped {
                    log::info!(
                        "[pty] adopted leader {} failed the verified stop; refusing group strikes",
                        target.pid
                    );
                    self.ownership = ChildOwnership::Unproven;
                }
                stopped
            }
            (Some(_), None) => false,
        };
        if leader_frozen {
            if let Some(pid) = leader {
                unsafe { libc::kill(-pid, libc::SIGSTOP) };
            }
        }
        PtyKillPlan {
            leader,
            leader_target,
            leader_frozen,
            owned,
            tty_dev: self.tty_dev,
        }
    }

    /// Tear this session down on its own — the whole verified plan, just
    /// without a batch to share the freeze window with.
    ///
    /// Not `#[cfg(test)]`: that attribute only applies to THIS crate's test
    /// build, so gating it hides the method from every other crate's tests
    /// (`kanna-server` calls it) while looking like it is still available.
    /// The daemon binary itself always kills in batches, so it is dead code
    /// there while very much alive for the library's consumers.
    #[allow(dead_code)]
    pub fn kill(&mut self) -> io::Result<()> {
        self.begin_kill().execute(None)
    }

    #[allow(dead_code)]
    fn legacy_kill(&mut self) -> io::Result<()> {
        let leader = self.provable_child();
        // Pin the leader to its start-time identity for every later strike in
        // this teardown; the pid alone can be recycled mid-sequence. An
        // owned, unreaped child needs no re-check: its pid is pinned by the
        // pending reap.
        let leader_target = leader.and_then(|pid| {
            self.child_identity()
                .map(|start| crate::proc_info::SessionTarget { pid, start })
        });
        // Freeze first so nothing can fork or reparent mid-teardown. An
        // owned, unreaped child's pid cannot be recycled, so a plain stop is
        // safe; an adopted leader goes through the verified stop protocol
        // (verify → SIGSTOP → re-verify → SIGCONT rollback on mismatch) so a
        // pid recycled inside the window is resumed, never left frozen or
        // group-signaled. Failure demotes ownership so nothing later in this
        // teardown (or any future call) targets the pid again.
        let leader_frozen = match (leader, leader_target) {
            (None, _) => false,
            (Some(pid), _) if self.owns_child_pid() => {
                unsafe { libc::kill(pid, libc::SIGSTOP) };
                true
            }
            (Some(_), Some(target)) => {
                let stopped = crate::proc_info::stop_verified(target);
                if !stopped {
                    log::info!(
                        "[pty] adopted leader {} failed the verified stop; refusing group strikes",
                        target.pid
                    );
                    self.ownership = ChildOwnership::Unproven;
                }
                stopped
            }
            (Some(_), None) => false,
        };
        if leader_frozen {
            if let Some(pid) = leader {
                unsafe { libc::kill(-pid, libc::SIGSTOP) };
            }
        }
        let frozen = crate::proc_info::freeze_session_processes(leader_target, self.tty_dev);

        let mut primary = Ok(());
        if let Some(pid) = leader {
            // Strike only through a leader that was frozen under verified
            // identity (or is our own unreaped child). A verified-stopped
            // process cannot exit on its own, so the pid stays pinned; the
            // identity re-check guards against an external SIGKILL+reuse in
            // the window.
            let still_ours = leader_frozen
                && (self.owns_child_pid()
                    || leader_target
                        .is_some_and(|t| crate::proc_info::identity_matches(t.pid, t.start)));
            if still_ours {
                let group = unsafe { libc::kill(-pid, libc::SIGKILL) };
                if group != 0 {
                    // Group kill can fail when the group is already gone
                    // (ESRCH) or when its only remaining member is a zombie
                    // awaiting reap (macOS reports EPERM for that). Fall back
                    // to the direct child pid so kill never regresses below
                    // single-pid behavior.
                    let direct = unsafe { libc::kill(pid, libc::SIGKILL) };
                    if direct != 0 {
                        primary = Err(io::Error::last_os_error());
                    }
                }
            }
        }
        for target in frozen {
            crate::proc_info::signal_verified(target, libc::SIGKILL);
        }
        primary
    }

    /// True while the child is our own unreaped fork: its pid cannot be
    /// recycled until we reap it, so identity re-checks are unnecessary.
    pub(crate) fn owns_child_pid(&self) -> bool {
        matches!(self.ownership, ChildOwnership::Owned { reaped: false, .. })
    }

    /// Deliver a non-destructive signal (e.g. SIGINT) to the session child.
    ///
    /// Fails closed for adopted/unowned children. `provable_child()` verifies
    /// identity, but for an adopted child nothing pins that identity across the
    /// following `kill(2)`: the process can exit in between and its pid be
    /// recycled, so the signal would land on an unrelated process. Our own
    /// unreaped fork has no such window — its pid cannot be recycled until we
    /// reap it — so only that case is allowed to signal.
    ///
    /// Freezing (as destructive teardown does) is not usable here: a
    /// SIGSTOP/SIGCONT sandwich would change the delivery semantics of the
    /// signal being requested. Adopted sessions are still fully terminable via
    /// `kill()`, whose sweep is authenticated by the transferred master fd.
    pub fn signal(&mut self, sig: i32) -> io::Result<()> {
        let Some(pid) = self.provable_child() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "session child identity is not provable; refusing to signal",
            ));
        };
        if !self.owns_child_pid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "session child {pid} is adopted, so its identity cannot be pinned across                      signal delivery; refusing to signal (teardown remains available)"
                ),
            ));
        }
        let ret = unsafe { libc::kill(pid, sig) };
        if ret == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Get the raw master fd (for handoff inspection).
    #[allow(dead_code)]
    pub fn master_raw_fd(&self) -> RawFd {
        self.master_fd.as_raw_fd()
    }

    /// Extract the master fd without closing it. Consumes the session.
    /// Used during handoff — the fd is transferred to the new daemon.
    #[allow(dead_code)]
    pub fn detach_for_handoff(self) -> (RawFd, libc::pid_t, String, u16, u16) {
        let fd = self.master_fd.as_raw_fd();
        // Prevent OwnedFd from closing the fd on drop
        let rows = self.rows;
        let cols = self.cols;
        std::mem::forget(self.master_fd);
        (fd, self.child_pid, self.cwd, rows, cols)
    }
}

#[cfg(test)]
mod tests {
    use super::{is_pty_exhaustion_error, PtySession};
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::io::Read;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    unsafe fn set_env_var(key: &str, value: &str) {
        let key = CString::new(key).expect("env key should be valid");
        let value = CString::new(value).expect("env value should be valid");
        assert_eq!(libc::setenv(key.as_ptr(), value.as_ptr(), 1), 0);
    }

    unsafe fn unset_env_var(key: &str) {
        let key = CString::new(key).expect("env key should be valid");
        assert_eq!(libc::unsetenv(key.as_ptr()), 0);
    }

    #[test]
    fn spawn_rejects_unreadable_working_directories() {
        let result = PtySession::spawn(
            "/bin/sh",
            &["-lc".to_string(), "exit 0".to_string()],
            "/path/that/does/not/exist",
            &HashMap::new(),
            80,
            24,
        );

        match result {
            Ok(_) => panic!("spawn should fail for a missing cwd"),
            Err(error) => assert!(error.to_string().contains("cwd is not a directory")),
        }
    }

    #[test]
    fn spawn_rejects_executable_paths_with_nul_bytes_before_fork() {
        let result = PtySession::spawn(
            "/bin/sh\0nope",
            &["-lc".to_string(), "exit 0".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        );

        match result {
            Ok(_) => panic!("spawn should fail before fork for an executable path with NUL bytes"),
            Err(error) => assert!(
                error.to_string().contains("executable contains NUL byte"),
                "unexpected error: {error}"
            ),
        }
    }

    #[test]
    fn spawn_rejects_arguments_with_nul_bytes_before_fork() {
        let result = PtySession::spawn(
            "/bin/sh",
            &["-lc".to_string(), "printf nope\0ignored".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        );

        match result {
            Ok(_) => panic!("spawn should fail before fork for argv with NUL bytes"),
            Err(error) => assert!(
                error.to_string().contains("argument 1 contains NUL byte"),
                "unexpected error: {error}"
            ),
        }
    }

    #[test]
    fn kill_terminates_the_entire_pty_process_group() {
        let root = std::env::temp_dir().join(format!(
            "kanna-daemon-pty-group-kill-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let pid_file = root.join("grandchild.pid");
        let mut session = PtySession::spawn(
            "/bin/sh",
            &[
                "-c".to_string(),
                format!(
                    "(trap '' HUP TERM; while :; do sleep 1; done) & echo $! > '{}'; wait",
                    pid_file.display()
                ),
            ],
            root.to_string_lossy().as_ref(),
            &HashMap::new(),
            80,
            24,
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let grandchild: i32 = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse() {
                    break pid;
                }
            }
            assert!(std::time::Instant::now() < deadline, "pid file missing");
            std::thread::sleep(std::time::Duration::from_millis(10));
        };

        session.kill().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let alive = unsafe { libc::kill(grandchild, 0) == 0 };
            if !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild {grandchild} survived PTY kill"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = session.try_wait();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn spawn_does_not_inherit_kanna_control_plane_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_TMUX_SESSION", "leaked-session");
            set_env_var("KANNA_DB_PATH", "/tmp/leaked.db");
            set_env_var("TAURI_WEBDRIVER_PORT", "4555");
        }

        let session = PtySession::spawn(
            "/bin/sh",
            &[
                "-lc".to_string(),
                "printf '%s|%s|%s' \"${KANNA_TMUX_SESSION:-}\" \"${KANNA_DB_PATH:-}\" \"${TAURI_WEBDRIVER_PORT:-}\""
                    .to_string(),
            ],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");

        let mut reader = session
            .try_clone_reader()
            .expect("reader clone should succeed");
        let mut output = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut buf = [0u8; 128];
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    output.extend_from_slice(&buf[..n]);
                    if String::from_utf8_lossy(&output).contains("||") {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("should capture PTY output: {error}"),
            }
        }
        let output = String::from_utf8_lossy(&output).to_string();

        unsafe {
            unset_env_var("KANNA_TMUX_SESSION");
            unset_env_var("KANNA_DB_PATH");
            unset_env_var("TAURI_WEBDRIVER_PORT");
        }

        assert!(
            output.contains("||"),
            "unexpected PTY env output: {output:?}"
        );
    }

    fn read_pty_output_until(
        session: &PtySession,
        predicate: impl Fn(&str) -> bool,
        timeout: std::time::Duration,
    ) -> String {
        let mut reader = session
            .try_clone_reader()
            .expect("reader clone should succeed");
        let mut output = Vec::new();
        let deadline = std::time::Instant::now() + timeout;
        let mut buf = [0u8; 256];
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    output.extend_from_slice(&buf[..n]);
                    if predicate(&String::from_utf8_lossy(&output)) {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("should capture PTY output: {error}"),
            }
        }
        String::from_utf8_lossy(&output).to_string()
    }

    #[test]
    fn spawn_marks_pty_master_and_clones_close_on_exec() {
        let session = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 5".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");

        let cloexec = |fd: std::os::unix::io::RawFd| {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(flags >= 0, "fcntl(F_GETFD) failed");
            flags & libc::FD_CLOEXEC != 0
        };
        assert!(
            cloexec(session.master_raw_fd()),
            "master fd must be close-on-exec"
        );
        let io_fd = session.try_clone_io_fd().expect("io clone should succeed");
        assert!(
            cloexec(std::os::unix::io::AsRawFd::as_raw_fd(&io_fd)),
            "io clone must be close-on-exec"
        );

        let mut session = session;
        session.kill().expect("kill should succeed");
        reap_within(&mut session, "spawned session");
    }

    /// Spawn a child that classifies each fd above its own stdio as tty or
    /// other. A leaked PTY master shows up as a tty — the invariant that
    /// actually matters. Numeric fd-set diffs are NOT usable for this: fd
    /// numbers are per-process, and other tests in this binary spawn
    /// concurrently, so unrelated numbers legitimately differ.
    fn spawn_fd_classifier() -> PtySession {
        PtySession::spawn(
            "/bin/sh",
            &[
                "-c".to_string(),
                "for i in 3 4 5 6 7 8 9 10 11 12; do if [ -e /dev/fd/$i ]; then \
                 if [ -t $i ]; then echo FD$i=tty; else echo FD$i=other; fi; fi; done; \
                 echo FD_LIST_DONE"
                    .to_string(),
            ],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("fd classifier spawn should succeed")
    }

    fn read_inherited_ttys(session: &PtySession) -> Vec<String> {
        let output = read_pty_output_until(
            session,
            |text| text.contains("FD_LIST_DONE"),
            std::time::Duration::from_secs(5),
        );
        assert!(
            output.contains("FD_LIST_DONE"),
            "fd classification should complete: {output:?}"
        );
        output
            .split_whitespace()
            .filter(|token| token.starts_with("FD") && token.ends_with("=tty"))
            .map(|token| token.to_string())
            .collect()
    }

    fn kill_and_reap(mut session: PtySession) {
        session.kill().expect("kill should succeed");
        reap_within(&mut session, "killed session");
    }

    #[test]
    fn spawned_children_do_not_inherit_prior_sessions_pty_masters() {
        // Session A holds a PTY master (and an io-dup) open in this (the
        // daemon's) process.
        let session_a = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 30".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("session A spawn should succeed");
        let _io_dup = session_a
            .try_clone_io_fd()
            .expect("io clone should succeed");

        // Session B must not see ANY tty above its own stdio. Before the
        // FD_CLOEXEC fix it inherited session A's master (and every other
        // daemon-held master), pinning those ptys in the kernel's global pool
        // for its lifetime.
        let session_b = spawn_fd_classifier();
        let inherited_ttys = read_inherited_ttys(&session_b);
        assert!(
            inherited_ttys.is_empty(),
            "child spawned while session A is alive inherited a tty fd (a PTY master leak): \
             {inherited_ttys:?}"
        );

        kill_and_reap(session_a);
        kill_and_reap(session_b);
    }

    fn write_to_master(session: &PtySession, bytes: &[u8]) {
        use std::os::unix::io::AsRawFd;
        let writer = session
            .try_clone_writer()
            .expect("writer clone should succeed");
        let fd = writer.as_raw_fd();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut written = 0;
        while written < bytes.len() {
            let ret = unsafe {
                libc::write(
                    fd,
                    bytes[written..].as_ptr() as *const libc::c_void,
                    bytes.len() - written,
                )
            };
            if ret > 0 {
                written += ret as usize;
                continue;
            }
            let error = std::io::Error::last_os_error();
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::WouldBlock,
                "master write should only fail transiently: {error}"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "timed out writing to PTY master"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    fn parse_announced_pid(output: &str, marker: &str) -> Option<libc::pid_t> {
        // The command echo also contains the literal marker followed by
        // `$!`; only a digits token after the marker is the real pid.
        output
            .split(marker)
            .skip(1)
            .filter_map(|rest| rest.split_whitespace().next()?.parse::<libc::pid_t>().ok())
            .next()
    }

    /// Reaps a killed session, bounded.
    ///
    /// A macOS PTY child can wedge mid-exit and never become reapable. An
    /// unbounded poll turns that into a `./kd test all` that hangs forever
    /// with no output — the whole gate stuck on one line — instead of a test
    /// that says what happened. The bound is a liveness ceiling, not a budget:
    /// a healthy reap takes milliseconds.
    fn reap_within(session: &mut PtySession, message: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while session.try_wait().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "{message}: killed session never became reapable (pid {})",
                session.pid()
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn assert_dies_within(pid: libc::pid_t, timeout: std::time::Duration, message: &str) {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{message} (pid {pid})"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_terminates_descendant_processes() {
        // The shell backgrounds a grandchild; non-interactive sh has no job
        // control, so the grandchild stays in the session's process group.
        let mut session = PtySession::spawn(
            "/bin/sh",
            &[
                "-c".to_string(),
                "sleep 300 & echo GRANDCHILD_PID $!; wait".to_string(),
            ],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");

        let output = read_pty_output_until(
            &session,
            |text| text.contains("GRANDCHILD_PID "),
            std::time::Duration::from_secs(5),
        );
        let grandchild: libc::pid_t = output
            .split("GRANDCHILD_PID ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|token| token.parse().ok())
            .unwrap_or_else(|| panic!("grandchild pid should be printed: {output:?}"));

        session.kill().expect("kill should succeed");
        reap_within(&mut session, "killed session");

        // The grandchild must die with the session's process group instead of
        // being orphaned to launchd (where it would pin PTYs forever).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let alive = unsafe { libc::kill(grandchild, 0) } == 0;
            if !alive {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild {grandchild} should be killed with the session's process group"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// Production shape: an interactive zsh gives every background job its
    /// own process group, so `kill(-leader)` alone never reaches the job.
    /// An interactive, job-control-capable shell to drive teardown fixtures
    /// with. It is deliberately the platform's own rather than one fixed
    /// path: a stock Ubuntu image ships no `zsh` at all, and bash gives every
    /// background job its own process group exactly as zsh does, which is the
    /// premise this fixture needs.
    #[cfg(target_os = "macos")]
    const INTERACTIVE_SHELL: (&str, &[&str]) = ("/bin/zsh", &["-f", "-i"]);
    #[cfg(target_os = "linux")]
    const INTERACTIVE_SHELL: (&str, &[&str]) = ("/bin/bash", &["--norc", "--noprofile", "-i"]);

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn kill_terminates_interactive_shell_jobs_in_their_own_process_groups() {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "dumb".to_string());
        let (shell, shell_args) = INTERACTIVE_SHELL;
        let shell_args: Vec<String> = shell_args.iter().map(|arg| arg.to_string()).collect();
        let mut session = PtySession::spawn(shell, &shell_args, "/tmp", &env, 120, 32)
            .expect("interactive shell spawn should succeed");
        write_to_master(&session, b"sleep 300 & echo JOB_START $!\r");
        let output = read_pty_output_until(
            &session,
            |text| parse_announced_pid(text, "JOB_START ").is_some(),
            std::time::Duration::from_secs(10),
        );
        let job = parse_announced_pid(&output, "JOB_START ")
            .unwrap_or_else(|| panic!("job pid should be announced: {output:?}"));

        // Regression premise: the job must actually live in a process group
        // other than the leader's, exactly like a real agent CLI under an
        // interactive shell.
        let leader = session.pid() as libc::pid_t;
        let job_info =
            crate::proc_info::process_info(job).expect("background job should be inspectable");
        assert_ne!(
            job_info.pgid, leader,
            "an interactive shell should place the job in its own process group"
        );

        session.kill().expect("kill should succeed");
        reap_within(&mut session, "killed session");
        assert_dies_within(
            job,
            std::time::Duration::from_secs(5),
            "background job in a foreign process group should die with the session",
        );
    }

    /// A descendant that calls `setsid()` leaves both the leader's process
    /// group and the controlling terminal; only the parent-chain walk can
    /// find it.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn kill_terminates_descendants_that_escape_with_setsid() {
        if !std::path::Path::new("/usr/bin/perl").exists() {
            eprintln!("skipping: /usr/bin/perl not available on this host");
            return;
        }
        let script = r#"perl -MPOSIX -e 'POSIX::setsid(); exec "/bin/sleep", "300"' & echo ESCAPEE $!; wait"#;
        let mut session = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), script.to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");
        let output = read_pty_output_until(
            &session,
            |text| parse_announced_pid(text, "ESCAPEE ").is_some(),
            std::time::Duration::from_secs(10),
        );
        let escapee = parse_announced_pid(&output, "ESCAPEE ")
            .unwrap_or_else(|| panic!("escapee pid should be announced: {output:?}"));

        // Wait until the escapee has provably left the session (its own
        // process group) so the kill below cannot win via plain group kill.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match crate::proc_info::process_info(escapee) {
                Some(info) if info.pgid == escapee => break,
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "escapee {escapee} should call setsid: {output:?}"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        session.kill().expect("kill should succeed");
        reap_within(&mut session, "killed session");
        assert_dies_within(
            escapee,
            std::time::Duration::from_secs(5),
            "setsid-escaped descendant should die with the session",
        );
    }

    /// Forces the openpty→CLOEXEC window wide open on one thread while
    /// another spawns a child; the spawn/fd boundary must keep the window
    /// invisible to the concurrently spawned child.
    #[test]
    fn concurrent_spawns_cannot_observe_the_inheritable_pty_window() {
        use std::sync::atomic::Ordering;

        super::TEST_INHERITABLE_WINDOW_MS.store(150, Ordering::Relaxed);
        let spawner = std::thread::spawn(|| {
            PtySession::spawn(
                "/bin/sh",
                &["-c".to_string(), "sleep 30".to_string()],
                "/tmp",
                &HashMap::new(),
                80,
                24,
            )
        });
        // Land the concurrent spawn inside the forced window.
        std::thread::sleep(std::time::Duration::from_millis(30));
        let lister = PtySession::spawn(
            "/bin/sh",
            &[
                "-c".to_string(),
                "for i in 3 4 5 6 7 8 9 10 11 12; do if [ -e /dev/fd/$i ]; then \
                 if [ -t $i ]; then echo FD$i=tty; else echo FD$i=other; fi; fi; done; \
                 echo FD_LIST_DONE"
                    .to_string(),
            ],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("fd classifier spawn should succeed");
        let output = read_pty_output_until(
            &lister,
            |text| text.contains("FD_LIST_DONE"),
            std::time::Duration::from_secs(5),
        );
        assert!(
            output.contains("FD_LIST_DONE"),
            "fd classification should complete: {output:?}"
        );
        let listed: Vec<String> = output
            .split_whitespace()
            .filter(|token| token.starts_with("FD") && token.contains('='))
            .map(|token| token.to_string())
            .collect();
        super::TEST_INHERITABLE_WINDOW_MS.store(0, Ordering::Relaxed);
        let session = spawner
            .join()
            .expect("spawner thread should not panic")
            .expect("spawn should succeed");

        // Assert the PRECISE invariant — the concurrently spawning session's
        // master (and its slave, which is master+1 at openpty time) must not
        // appear in the child's fd table. A set-difference against an earlier
        // "control" listing is not usable here: other tests in this binary
        // spawn concurrently, so unrelated fd numbers legitimately differ and
        // made this test flaky under parallel execution.
        // fd NUMBERS are per-process, so neither the parent's master number nor
        // a diff against another child's numeric fd set is meaningful here
        // (other tests in this binary spawn concurrently and legitimately
        // change what the harness holds — that made the numeric diff flaky).
        // Test the actual invariant instead: a leaked PTY master would appear
        // in the child as a TTY on some fd above its own stdio.
        let inherited_ttys: Vec<&String> = listed
            .iter()
            .filter(|entry| entry.ends_with("=tty"))
            .collect();
        assert!(
            inherited_ttys.is_empty(),
            "child spawned during another session's pre-CLOEXEC window inherited a tty fd \
             (a PTY master leak): {inherited_ttys:?}"
        );

        kill_and_reap(session);
        kill_and_reap(lister);
    }

    fn exited_session_master() -> PtySession {
        let mut donor = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), "exit 0".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("donor spawn should succeed");
        reap_within(&mut donor, "donor session");
        donor
    }

    /// Invalid wire pids (0 targets the caller's own process group after
    /// negation; large u32s convert to negative pids and become broadcast
    /// targets) must never be signaled. Surviving this test at all proves no
    /// group/broadcast SIGKILL was sent.
    #[test]
    fn adopt_refuses_invalid_handoff_pid_targets() {
        for raw in [0u32, 1, i32::MAX as u32 + 1, u32::MAX] {
            let donor = exited_session_master();
            let fd = donor
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed");
            let mut adopted = PtySession::adopt(fd, raw, None, "/tmp".to_string(), 24, 80);
            assert!(
                !adopted.is_alive(),
                "invalid pid {raw} must not be considered alive"
            );
            adopted.kill().unwrap_or_else(|error| {
                panic!("kill for invalid pid {raw} must be a safe no-op: {error}")
            });
            assert!(
                adopted.signal(libc::SIGTERM).is_err(),
                "signal for invalid pid {raw} must be refused"
            );
        }
    }

    /// A stale handoff pid that now belongs to an unrelated process (PID
    /// reuse) fails identity authentication and must never be signaled.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn adopt_refuses_signaling_unrelated_reused_pids() {
        let mut victim = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .expect("victim spawn should succeed");
        let victim_pid = victim.id();

        let donor = exited_session_master();
        // No transferred identity (legacy metadata): the victim is not on
        // this session's terminal, so authentication must fail.
        let mut adopted = PtySession::adopt(
            donor
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed"),
            victim_pid,
            None,
            "/tmp".to_string(),
            24,
            80,
        );
        assert!(!adopted.is_alive());
        adopted.kill().expect("kill must not error");
        assert!(adopted.signal(libc::SIGTERM).is_err());

        // Transferred identity that does not match the live process (the
        // transferred child died; the pid was recycled): same refusal.
        let mut adopted_stale = PtySession::adopt(
            donor
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed"),
            victim_pid,
            Some((1, 1)),
            "/tmp".to_string(),
            24,
            80,
        );
        assert!(!adopted_stale.is_alive());
        adopted_stale.kill().expect("kill must not error");

        // Forged handoff: metadata names an unrelated live process WITH its
        // correct start time (start times are readable by anyone). Metadata
        // must never grant signal authority — the victim is not on the
        // transferred terminal, so the adoption stays unprovable.
        let forged_identity =
            crate::proc_info::process_info(victim_pid as libc::pid_t).map(|info| info.start);
        assert!(forged_identity.is_some(), "victim identity should resolve");
        let mut adopted_forged = PtySession::adopt(
            donor
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed"),
            victim_pid,
            forged_identity,
            "/tmp".to_string(),
            24,
            80,
        );
        assert!(
            !adopted_forged.is_alive(),
            "forged metadata with a correct start time must not authenticate"
        );
        adopted_forged.kill().expect("kill must not error");
        assert!(adopted_forged.signal(libc::SIGTERM).is_err());

        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            victim
                .try_wait()
                .expect("victim wait should succeed")
                .is_none(),
            "unrelated process holding a reused pid must survive adopted-session teardown"
        );
        victim.kill().expect("victim cleanup kill");
        victim.wait().expect("victim cleanup wait");
    }

    /// Fail closed for adopted children: `signal()` verifies identity, but
    /// nothing pins it across the following `kill(2)` for a child we did not
    /// fork, so an adopted session refuses non-destructive signals. Teardown
    /// (which freezes first, and whose sweep is authenticated by the
    /// transferred master fd) remains available.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn adopted_sessions_refuse_non_destructive_signals_but_stay_killable() {
        let mut session = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 300".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");
        let leader = session.pid();

        // Our own fork accepts a signal: its pid cannot be recycled.
        session
            .signal(0)
            .expect("an owned child accepts signal delivery");

        // Wait for the controlling terminal so the adoption authenticates.
        let slave_dev = crate::proc_info::slave_device_of_master(session.master_raw_fd())
            .expect("slave device should resolve");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match crate::proc_info::process_info(leader as libc::pid_t) {
                Some(info) if info.tdev == slave_dev => break,
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "leader should acquire its controlling terminal"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        let mut adopted = PtySession::adopt(
            session
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed"),
            leader,
            session.child_identity(),
            "/tmp".to_string(),
            24,
            80,
        );
        assert!(
            adopted.is_alive(),
            "adoption should authenticate the leader"
        );
        assert!(
            adopted.signal(libc::SIGINT).is_err(),
            "an adopted child must refuse non-destructive signal delivery"
        );
        // But teardown still works.
        adopted.kill().expect("adopted teardown should succeed");
        reap_within(&mut session, "killed session");
        assert_dies_within(
            leader as libc::pid_t,
            std::time::Duration::from_secs(5),
            "adopted leader should still be killable",
        );
    }

    /// Positive path: a live transferred leader authenticates either through
    /// matching start-time metadata (new daemons) or through its controlling
    /// terminal (legacy daemons without identity metadata), and stays
    /// killable after handoff.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn adopt_authenticates_live_leaders_and_kills_them() {
        let mut session = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 300".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");
        let leader = session.pid();

        // Terminal authentication needs the child to have completed its
        // setsid()+TIOCSCTTY startup. Real handoffs adopt long-established
        // sessions, so waiting here mirrors production rather than racing
        // the child's first instructions.
        let slave_dev = crate::proc_info::slave_device_of_master(session.master_raw_fd())
            .expect("slave device should resolve");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match crate::proc_info::process_info(leader as libc::pid_t) {
                Some(info) if info.tdev == slave_dev => break,
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "leader should acquire its controlling terminal"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        let adopted_meta = PtySession::adopt(
            session
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed"),
            leader,
            session.child_identity(),
            "/tmp".to_string(),
            24,
            80,
        );
        assert!(
            adopted_meta.is_alive(),
            "identity-authenticated adoption should see the live leader"
        );

        let mut adopted_tty = PtySession::adopt(
            session
                .try_clone_handoff_fd()
                .expect("handoff clone should succeed"),
            leader,
            None,
            "/tmp".to_string(),
            24,
            80,
        );
        assert!(
            adopted_tty.is_alive(),
            "terminal-authenticated adoption should see the live leader"
        );

        adopted_tty.kill().expect("adopted kill should succeed");
        reap_within(&mut session, "killed session");
        assert_dies_within(
            leader as libc::pid_t,
            std::time::Duration::from_secs(5),
            "adopted leader should die",
        );
    }

    /// Membership must not stop traversal: an on-terminal intermediate is
    /// already in the teardown set via its controlling tty, but its own
    /// detached (setsid) grandchild is only reachable by walking through it.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn kill_reaches_detached_grandchildren_behind_on_terminal_intermediates() {
        if !std::path::Path::new("/usr/bin/perl").exists() {
            eprintln!("skipping: /usr/bin/perl not available on this host");
            return;
        }
        // leader sh → intermediate sh (keeps the terminal) → perl setsid
        // grandchild (no terminal, own session).
        let script = r#"/bin/sh -c "perl -MPOSIX -e 'POSIX::setsid(); exec \"/bin/sleep\", \"300\"' & echo ESCAPEE \$!; wait" & wait"#;
        let mut session = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), script.to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");
        let leader = session.pid() as libc::pid_t;
        let slave_dev = crate::proc_info::slave_device_of_master(session.master_raw_fd())
            .expect("slave device should resolve");

        let output = read_pty_output_until(
            &session,
            |text| parse_announced_pid(text, "ESCAPEE ").is_some(),
            std::time::Duration::from_secs(10),
        );
        let escapee = parse_announced_pid(&output, "ESCAPEE ")
            .unwrap_or_else(|| panic!("escapee pid should be announced: {output:?}"));

        // Wait for setsid, then pin down the regression premise: the
        // escapee's parent is an on-terminal intermediate that is not the
        // leader, and the escapee itself has left the terminal.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let escapee_info = loop {
            match crate::proc_info::process_info(escapee) {
                Some(info) if info.pgid == escapee => break info,
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "escapee {escapee} should call setsid: {output:?}"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        };
        assert_ne!(
            escapee_info.ppid, leader,
            "escapee must hang off an intermediate, not the leader"
        );
        let intermediate = crate::proc_info::process_info(escapee_info.ppid)
            .expect("intermediate should be inspectable");
        assert_eq!(
            intermediate.tdev, slave_dev,
            "intermediate must be on the session terminal (already a member)"
        );
        assert_ne!(
            escapee_info.tdev, slave_dev,
            "escapee must have detached from the terminal"
        );

        session.kill().expect("kill should succeed");
        reap_within(&mut session, "killed session");
        assert_dies_within(
            escapee,
            std::time::Duration::from_secs(5),
            "detached grandchild behind an on-terminal intermediate should die with the session",
        );
    }

    /// Termination ownership is one-shot: the first kill takes the reap
    /// token; later signals are rejected and later kills are safe no-ops, so
    /// a pid recycled after the reap can never be targeted through this
    /// session again.
    #[test]
    fn take_reap_token_is_one_shot_and_blocks_later_signals() {
        let mut session = PtySession::spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 30".to_string()],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("spawn should succeed");

        session.kill().expect("kill should succeed");
        let token = session.take_reap_token();
        let (pid, start) = token.expect("first take should yield the reap token");
        assert!(
            start.is_some(),
            "owned PTY reap tokens must retain their start-time identity"
        );
        assert!(
            session.take_reap_token().is_none(),
            "reap token must be one-shot"
        );
        assert!(
            session.signal(libc::SIGTERM).is_err(),
            "signals after termination must be refused"
        );
        assert!(
            session.try_wait().is_none(),
            "try_wait must not race the token holder for the reap"
        );
        session
            .kill()
            .expect("kill after termination must be a safe no-op");

        // The token holder performs the real reap.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let ret = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
            if ret == pid {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "killed child should be reapable"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn pty_exhaustion_detection_finds_enxio_in_error_chain() {
        let nested = std::io::Error::other(std::io::Error::from_raw_os_error(libc::ENXIO));
        assert!(is_pty_exhaustion_error(&nested));

        let other = std::io::Error::from_raw_os_error(libc::EMFILE);
        assert!(!is_pty_exhaustion_error(&other));
    }
}
