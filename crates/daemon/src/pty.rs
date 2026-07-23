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

/// A PTY session backed by raw libc calls.
/// Stores the master fd directly so it can be extracted for handoff.
pub struct PtySession {
    master_fd: OwnedFd,
    child_pid: libc::pid_t,
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

        // Open PTY pair
        let ret = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ret != 0 {
            return Err(io::Error::last_os_error().into());
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

        set_nonblocking(master_fd)?;
        let master = unsafe { OwnedFd::from_raw_fd(master_fd) };

        Ok(PtySession {
            master_fd: master,
            child_pid: pid,
            cwd: cwd.to_string(),
            rows,
            cols,
            last_active_at: Instant::now(),
        })
    }

    /// Adopt a session from a transferred master fd (handoff).
    #[allow(dead_code)]
    /// The child process is not owned — use kill(pid, 0) to check liveness.
    pub fn adopt(
        master_fd: OwnedFd,
        child_pid: libc::pid_t,
        cwd: String,
        rows: u16,
        cols: u16,
    ) -> Self {
        if let Err(error) = set_nonblocking(master_fd.as_raw_fd()) {
            log::warn!("failed to set adopted PTY master non-blocking: {}", error);
        }
        PtySession {
            master_fd,
            child_pid,
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
        let mut status: libc::c_int = 0;
        let ret = unsafe { libc::waitpid(self.child_pid, &mut status, libc::WNOHANG) };
        if ret == self.child_pid {
            if libc::WIFEXITED(status) {
                Some(libc::WEXITSTATUS(status))
            } else if libc::WIFSIGNALED(status) {
                Some(128 + libc::WTERMSIG(status))
            } else {
                Some(1)
            }
        } else {
            None
        }
    }

    /// Check if the child process is still alive (works for non-owned processes too).
    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        unsafe { libc::kill(self.child_pid, 0) == 0 }
    }

    /// Send SIGKILL to the child's whole process group. Reaping is the
    /// caller's responsibility (see `SessionHandle::kill`): a blocking
    /// `waitpid` here can hang forever when the child is stuck exiting inside
    /// the kernel, wedging the daemon connection that issued the kill.
    ///
    /// The spawned child called `setsid()`, so `child_pid` is its process
    /// group leader. Killing only the direct child (typically a shell)
    /// orphans its descendants — agent CLIs that then live forever, keep the
    /// PTY slave open (blocking master-EOF cleanup), and pin every PTY master
    /// they inherited. Kill the group so the whole session tree dies; fall
    /// back to the single pid if the group is already gone.
    pub fn kill(&mut self) -> io::Result<()> {
        let ret = unsafe { libc::kill(-self.child_pid, libc::SIGKILL) };
        if ret == 0 {
            return Ok(());
        }
        // Group kill can fail when the group is already gone (ESRCH) or when
        // its only remaining member is a zombie awaiting reap (macOS reports
        // EPERM for that). Fall back to the direct child pid so kill never
        // regresses below the old single-pid behavior.
        let ret = unsafe { libc::kill(self.child_pid, libc::SIGKILL) };
        if ret != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn signal(&self, sig: i32) -> io::Result<()> {
        let ret = unsafe { libc::kill(self.child_pid, sig) };
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
    use super::PtySession;
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
        while session.try_wait().is_none() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn spawn_fd_lister() -> PtySession {
        PtySession::spawn(
            "/bin/sh",
            &[
                "-c".to_string(),
                "ls /dev/fd; echo FD_LIST_DONE".to_string(),
            ],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )
        .expect("fd lister spawn should succeed")
    }

    fn read_fd_set(session: &PtySession) -> std::collections::BTreeSet<u32> {
        let output = read_pty_output_until(
            session,
            |text| text.contains("FD_LIST_DONE"),
            std::time::Duration::from_secs(5),
        );
        assert!(
            output.contains("FD_LIST_DONE"),
            "fd listing should complete: {output:?}"
        );
        output
            .split_whitespace()
            .filter_map(|token| token.parse::<u32>().ok())
            .collect()
    }

    fn kill_and_reap(mut session: PtySession) {
        session.kill().expect("kill should succeed");
        while session.try_wait().is_none() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn spawned_children_do_not_inherit_prior_sessions_pty_masters() {
        // Control: what a child sees with no other session alive. The test
        // harness may hold its own inheritable fds; calibrate against them
        // instead of assuming a fixed stdio-only baseline.
        let control = spawn_fd_lister();
        let control_fds = read_fd_set(&control);
        kill_and_reap(control);

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

        // Session B must see exactly the control fd set. Before the
        // FD_CLOEXEC fix it inherited session A's master (and every other
        // daemon-held master), pinning those ptys in the kernel's global
        // pool for its lifetime.
        let session_b = spawn_fd_lister();
        let b_fds = read_fd_set(&session_b);
        let leaked: Vec<u32> = b_fds.difference(&control_fds).copied().collect();
        assert!(
            leaked.is_empty(),
            "child spawned while session A is alive should not inherit extra fds, got {leaked:?} beyond control set {control_fds:?}"
        );

        kill_and_reap(session_a);
        kill_and_reap(session_b);
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
        while session.try_wait().is_none() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

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
}
