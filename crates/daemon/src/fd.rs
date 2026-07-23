//! File-descriptor hygiene helpers.
//!
//! The daemon holds one PTY master (plus reader dups) per session and spawns
//! many children (PTY session shells, the terminal-recovery sidecar, headless
//! agent processes). Any fd without `FD_CLOEXEC` survives `execvp` into every
//! one of those children, and an inherited PTY master keeps its pty allocated
//! in the kernel's global pool (`kern.tty.ptmx_max`, 511 on macOS) for as
//! long as the child lives — even after the daemon closes its own copy. Every
//! long-lived fd the daemon creates must therefore be close-on-exec; children
//! receive exactly the fds they are explicitly given (stdio via `dup2`, which
//! clears the flag on the duplicates).

use std::io;
use std::os::unix::io::RawFd;

/// Set `FD_CLOEXEC` on an existing fd so it never leaks into spawned children.
pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let ret = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Duplicate an fd with close-on-exec so the duplicate never leaks into
/// spawned children.
pub fn dup_cloexec(fd: RawFd) -> io::Result<RawFd> {
    let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if dup < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(dup)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_cloexec(fd: RawFd) -> bool {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0, "fcntl(F_GETFD) failed");
        flags & libc::FD_CLOEXEC != 0
    }

    #[test]
    fn set_cloexec_marks_fd() {
        let mut fds = [0 as RawFd; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        assert!(!is_cloexec(fds[0]), "raw pipe fd should start inheritable");
        set_cloexec(fds[0]).expect("set_cloexec should succeed");
        assert!(is_cloexec(fds[0]));
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }

    #[test]
    fn dup_cloexec_marks_duplicate() {
        let mut fds = [0 as RawFd; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let dup = dup_cloexec(fds[0]).expect("dup_cloexec should succeed");
        assert!(is_cloexec(dup));
        assert!(!is_cloexec(fds[0]), "original fd flags should be untouched");
        unsafe {
            libc::close(dup);
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }
}
