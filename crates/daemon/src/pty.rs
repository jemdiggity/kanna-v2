use std::collections::HashMap;
use std::ffi::CString;
use std::io::{self, Read};
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Instant;

/// A PTY session backed by raw libc calls.
/// Stores the master fd directly so it can be extracted for handoff.
pub struct PtySession {
    master_fd: OwnedFd,
    child_pid: libc::pid_t,
    pub cwd: String,
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
        let mut master_fd: RawFd = -1;
        let mut slave_fd: RawFd = -1;

        // Open PTY pair
        let ret = unsafe { libc::openpty(&mut master_fd, &mut slave_fd, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
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
        unsafe { libc::ioctl(master_fd, libc::TIOCSWINSZ, &ws) };

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
                libc::setsid();
                libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0);

                // Redirect stdio to slave
                libc::dup2(slave_fd, 0);
                libc::dup2(slave_fd, 1);
                libc::dup2(slave_fd, 2);
                if slave_fd > 2 {
                    libc::close(slave_fd);
                }

                // Change directory
                let cwd_c = CString::new(cwd).unwrap_or_else(|_| CString::new("/tmp").unwrap());
                libc::chdir(cwd_c.as_ptr());

                // Set environment variables
                for (k, v) in env {
                    if let (Ok(k_c), Ok(v_c)) = (CString::new(k.as_str()), CString::new(v.as_str())) {
                        libc::setenv(k_c.as_ptr(), v_c.as_ptr(), 1);
                    }
                }

                // Build argv
                let exec_c = CString::new(executable).unwrap();
                let mut argv_c: Vec<CString> = Vec::with_capacity(args.len() + 1);
                argv_c.push(exec_c.clone());
                for arg in args {
                    argv_c.push(CString::new(arg.as_str()).unwrap_or_else(|_| CString::new("").unwrap()));
                }
                let mut argv_ptrs: Vec<*const libc::c_char> = argv_c.iter().map(|s| s.as_ptr()).collect();
                argv_ptrs.push(std::ptr::null());

                libc::execvp(exec_c.as_ptr(), argv_ptrs.as_ptr());

                // If exec fails, exit
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
            last_active_at: Instant::now(),
        })
    }

    /// Adopt a session from a transferred master fd (handoff).
    #[allow(dead_code)]
    /// The child process is not owned — use kill(pid, 0) to check liveness.
    pub fn adopt(master_fd: OwnedFd, child_pid: libc::pid_t, cwd: String) -> Self {
        PtySession {
            master_fd,
            child_pid: child_pid,
            cwd,
            last_active_at: Instant::now(),
        }
    }

    pub fn write_input(&mut self, data: &[u8]) -> io::Result<()> {
        let fd = self.master_fd.as_raw_fd();
        let mut offset = 0;
        while offset < data.len() {
            let n = unsafe {
                libc::write(fd, data[offset..].as_ptr() as *const libc::c_void, data.len() - offset)
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
    pub fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, Box<dyn std::error::Error + Send + Sync>> {
        let new_fd = unsafe { libc::dup(self.master_fd.as_raw_fd()) };
        if new_fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let file = unsafe { std::fs::File::from_raw_fd(new_fd) };
        Ok(Box::new(file))
    }

    /// Clone the master fd for writing (e.g. kitty keyboard responses).
    pub fn try_clone_writer(&self) -> Result<OwnedFd, Box<dyn std::error::Error + Send + Sync>> {
        let new_fd = unsafe { libc::dup(self.master_fd.as_raw_fd()) };
        if new_fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(new_fd) })
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
        Ok(())
    }

    pub fn pid(&self) -> u32 {
        self.child_pid as u32
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
    pub fn detach_for_handoff(self) -> (RawFd, libc::pid_t, String) {
        let fd = self.master_fd.as_raw_fd();
        // Prevent OwnedFd from closing the fd on drop
        std::mem::forget(self.master_fd);
        (fd, self.child_pid, self.cwd)
    }
}
