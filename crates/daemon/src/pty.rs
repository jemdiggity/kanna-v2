use std::collections::HashMap;
use std::ffi::CString;
use std::io::{self, Read};
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

        // Set master to non-blocking? No — we use blocking reads in stream_output.
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
        PtySession {
            master_fd,
            child_pid,
            cwd,
            rows,
            cols,
            last_active_at: Instant::now(),
        }
    }

    pub fn write_input(&mut self, data: &[u8]) -> io::Result<()> {
        let fd = self.master_fd.as_raw_fd();
        let mut offset = 0;
        while offset < data.len() {
            let n = unsafe {
                libc::write(
                    fd,
                    data[offset..].as_ptr() as *const libc::c_void,
                    data.len() - offset,
                )
            };
            if n < 0 {
                return Err(io::Error::last_os_error());
            }
            offset += n as usize;
        }
        self.last_active_at = Instant::now();
        Ok(())
    }

    /// Clone the master fd for a reader. The returned fd is independently owned.
    pub fn try_clone_reader(
        &self,
    ) -> Result<Box<dyn Read + Send>, Box<dyn std::error::Error + Send + Sync>> {
        let new_fd = unsafe { libc::dup(self.master_fd.as_raw_fd()) };
        if new_fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let file = unsafe { std::fs::File::from_raw_fd(new_fd) };
        Ok(Box::new(file))
    }

    /// Clone the master fd for writing (e.g. kitty keyboard responses).
    #[allow(dead_code)]
    pub fn try_clone_writer(&self) -> Result<OwnedFd, Box<dyn std::error::Error + Send + Sync>> {
        let new_fd = unsafe { libc::dup(self.master_fd.as_raw_fd()) };
        if new_fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(new_fd) })
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

    pub fn kill(&mut self) -> io::Result<()> {
        let ret = unsafe { libc::kill(self.child_pid, libc::SIGKILL) };
        if ret != 0 {
            return Err(io::Error::last_os_error());
        }
        // Reap the child
        unsafe { libc::waitpid(self.child_pid, std::ptr::null_mut(), 0) };
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
        let mut output = String::new();
        reader
            .read_to_string(&mut output)
            .expect("should capture PTY output");

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
}
