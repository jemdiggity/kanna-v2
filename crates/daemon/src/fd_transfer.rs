//! Transfer file descriptors between processes over a Unix socket using SCM_RIGHTS.
//!
//! Unix allows sending file descriptors as ancillary (out-of-band) data on
//! Unix domain sockets via `sendmsg`/`recvmsg` with `SCM_RIGHTS` control
//! messages. The kernel maps the fd numbers into the receiving process's
//! fd table, so the child process's PTY connection survives the transfer.

use std::io;
use std::os::unix::io::RawFd;
use std::time::{Duration, Instant};

// An SCM_RIGHTS message must be queued atomically, and the peer may still be
// draining a large payload written just before the fd send (the handoff writes
// the whole HandoffReady response first). These bounds are incident-proven: a
// single unretried sendmsg lost a 33-session handoff on 2026-07-24.
const RECV_FDS_RETRY_TIMEOUT: Duration = Duration::from_secs(2);
const RECV_FDS_RETRY_INTERVAL: Duration = Duration::from_millis(5);
const SEND_FDS_RETRY_TIMEOUT: Duration = Duration::from_secs(10);
const SEND_FDS_RETRY_INTERVAL: Duration = Duration::from_millis(5);

/// Send file descriptors over a Unix socket.
///
/// The fds are transferred as ancillary data (SCM_RIGHTS). A single dummy
/// byte is sent as the payload — required by the kernel (sendmsg with
/// ancillary data but no payload is rejected on some platforms).
pub fn send_fds(socket: RawFd, fds: &[RawFd]) -> io::Result<()> {
    if fds.is_empty() {
        return Ok(());
    }

    // Validate fds before attempting transfer
    for &fd in fds {
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid file descriptor: {}", fd),
            ));
        }
    }

    let dummy: [u8; 1] = [0];
    let mut iov = libc::iovec {
        iov_base: dummy.as_ptr() as *mut libc::c_void,
        iov_len: 1,
    };

    // Control message buffer: header + fd payload
    let fds_size = std::mem::size_of_val(fds);
    let cmsg_len = unsafe { libc::CMSG_LEN(fds_size as u32) } as usize;
    let cmsg_space = unsafe { libc::CMSG_SPACE(fds_size as u32) } as usize;
    let mut cmsg_buf = vec![0u8; cmsg_space];

    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsg_buf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = cmsg_space as _;

    // Fill the control message header
    let cmsg: &mut libc::cmsghdr = unsafe { &mut *(libc::CMSG_FIRSTHDR(&msg)) };
    cmsg.cmsg_level = libc::SOL_SOCKET;
    cmsg.cmsg_type = libc::SCM_RIGHTS;
    cmsg.cmsg_len = cmsg_len as _;

    // Copy fd array into the control message data area
    unsafe {
        std::ptr::copy_nonoverlapping(fds.as_ptr() as *const u8, libc::CMSG_DATA(cmsg), fds_size);
    }

    // On a nonblocking socket whose send buffer is still full, macOS rejects
    // an ancillary-bearing message as EMSGSIZE rather than EAGAIN, so EMSGSIZE
    // is a *backpressure* signal here and is retried too — verified by
    // `send_fds_retries_across_socket_backpressure`, where the identical send
    // succeeds once the receiver drains. The bounded deadline is what stops a
    // genuinely oversized payload from retrying forever.
    let deadline = Instant::now() + SEND_FDS_RETRY_TIMEOUT;
    loop {
        let ret = unsafe { libc::sendmsg(socket, &msg, 0) };
        if ret >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        let retryable = error.kind() == io::ErrorKind::WouldBlock
            || matches!(
                error.raw_os_error(),
                Some(libc::EAGAIN)
                    | Some(libc::ENOBUFS)
                    | Some(libc::ENOMEM)
                    | Some(libc::EINTR)
                    | Some(libc::EMSGSIZE)
            );
        if !retryable || Instant::now() >= deadline {
            return Err(error);
        }
        std::thread::sleep(SEND_FDS_RETRY_INTERVAL);
    }
}

/// `recvmsg` flags for an SCM_RIGHTS receive: on Linux, create the
/// descriptors close-on-exec in the kernel. macOS has no such flag, so there
/// the descriptors are marked immediately afterwards inside the spawn/fd
/// boundary (see [`recv_fds`]).
#[cfg(target_os = "linux")]
const RECV_FDS_FLAGS: libc::c_int = libc::MSG_CMSG_CLOEXEC;
#[cfg(not(target_os = "linux"))]
const RECV_FDS_FLAGS: libc::c_int = 0;

/// Receive file descriptors from a Unix socket.
///
/// `count` is the expected number of fds. Returns the received fds.
/// The caller is responsible for closing them (or wrapping in OwnedFd).
pub fn recv_fds(socket: RawFd, count: usize) -> io::Result<Vec<RawFd>> {
    if count == 0 {
        return Ok(vec![]);
    }

    let mut dummy = [0u8; 1];
    let mut iov = libc::iovec {
        iov_base: dummy.as_mut_ptr() as *mut libc::c_void,
        iov_len: 1,
    };

    let fds_size = count * std::mem::size_of::<RawFd>();
    let cmsg_space = unsafe { libc::CMSG_SPACE(fds_size as u32) } as usize;
    let mut cmsg_buf = vec![0u8; cmsg_space];

    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsg_buf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = cmsg_space as _;

    // Received fds enter this process inheritable on macOS, which has no
    // MSG_CMSG_CLOEXEC, so the whole receive-and-mark window must be inside
    // the process-wide spawn/fd boundary: no fork/exec may run before the
    // adopted fds are close-on-exec. The boundary is therefore kept on both
    // platforms; Linux merely narrows the window it has to cover, by asking
    // the kernel to create the descriptors close-on-exec in the first place
    // instead of only fencing the gap afterwards. The post-hoc marking below
    // stays as well: it is what macOS relies on, and on Linux it is a no-op
    // on an already-marked descriptor.
    let _spawn_boundary = crate::fd::spawn_fd_boundary();

    let deadline = Instant::now() + RECV_FDS_RETRY_TIMEOUT;
    let ret = loop {
        let ret = unsafe { libc::recvmsg(socket, &mut msg, RECV_FDS_FLAGS) };
        if ret >= 0 {
            break ret;
        }

        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock || Instant::now() >= deadline {
            return Err(error);
        }

        std::thread::sleep(RECV_FDS_RETRY_INTERVAL);
    };
    if ret == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "connection closed",
        ));
    }

    collect_scm_rights_fds(&msg, count)
}

/// Validate a received `msghdr`'s ancillary data and extract exactly
/// `expected` SCM_RIGHTS descriptors, marked close-on-exec.
///
/// Every malformed shape — truncated control data (`MSG_CTRUNC`), a control
/// message that is not `SOL_SOCKET`/`SCM_RIGHTS`, a `cmsg_len` that is too
/// short or overruns the control buffer, a non-integral descriptor payload,
/// or a descriptor count other than `expected` — is an error. Only
/// descriptors actually present in valid SCM_RIGHTS payloads are ever
/// touched, and on failure exactly those are closed: nothing here can
/// fabricate, close, or mutate an fd (such as fd 0) that was never received.
fn collect_scm_rights_fds(msg: &libc::msghdr, expected: usize) -> io::Result<Vec<RawFd>> {
    fn close_all(fds: &[RawFd]) {
        for &fd in fds {
            unsafe { libc::close(fd) };
        }
    }
    fn invalid(message: String) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, message)
    }

    let truncated = msg.msg_flags & libc::MSG_CTRUNC != 0;
    let control_start = msg.msg_control as usize;
    // `msg_controllen` is `socklen_t` on macOS and `size_t` on Linux, so this
    // conversion is a cast on one platform and a no-op on the other. Either
    // way a value that does not fit is treated as an empty control buffer,
    // which makes every control message below fail the bounds check.
    let control_end = control_start + usize::try_from(msg.msg_controllen).unwrap_or(0);
    let header_len = unsafe { libc::CMSG_LEN(0) } as usize;
    let fd_size = std::mem::size_of::<RawFd>();

    let mut fds: Vec<RawFd> = Vec::new();
    // A shape error that must not stop the walk, because descriptors may still be
    // sitting in later SCM_RIGHTS messages waiting to be closed.
    let mut deferred: Option<String> = None;
    let mut cmsg = unsafe { libc::CMSG_FIRSTHDR(msg) };
    while !cmsg.is_null() {
        let cmsg_ref = unsafe { &*cmsg };
        let cmsg_addr = cmsg as usize;
        let cmsg_len = cmsg_ref.cmsg_len as usize;
        if cmsg_len < header_len || cmsg_addr < control_start || cmsg_addr + cmsg_len > control_end
        {
            close_all(&fds);
            return Err(invalid(if truncated {
                "control message truncated (MSG_CTRUNC)".to_string()
            } else {
                format!("invalid control message length: {}", cmsg_len)
            }));
        }
        if cmsg_ref.cmsg_level != libc::SOL_SOCKET || cmsg_ref.cmsg_type != libc::SCM_RIGHTS {
            // Record and KEEP WALKING. Returning here would leak every descriptor
            // carried by SCM_RIGHTS messages behind this header: `recvmsg` has
            // already installed them in this process's fd table, so a bundle like
            // `[SCM_CREDS, SCM_RIGHTS(a, b)]` left a and b open forever — and they
            // arrive inheritable, so the next child spawned pinned them. The walk
            // continues purely to inventory what has to be closed.
            if deferred.is_none() {
                deferred = Some(format!(
                    "unexpected control message: level={}, type={}",
                    cmsg_ref.cmsg_level, cmsg_ref.cmsg_type
                ));
            }
            cmsg = unsafe { libc::CMSG_NXTHDR(msg, cmsg) };
            continue;
        }
        let data_len = cmsg_len - header_len;
        if !data_len.is_multiple_of(fd_size) {
            // `cmsg_len` is already bounds-checked above, so advancing is safe;
            // keep walking for the same reason as a foreign header.
            if deferred.is_none() {
                deferred = Some(format!(
                    "SCM_RIGHTS payload of {} bytes is not a whole number of fds",
                    data_len
                ));
            }
            cmsg = unsafe { libc::CMSG_NXTHDR(msg, cmsg) };
            continue;
        }
        let data = unsafe { libc::CMSG_DATA(cmsg) };
        for index in 0..data_len / fd_size {
            let mut fd: RawFd = -1;
            unsafe {
                std::ptr::copy_nonoverlapping(
                    data.add(index * fd_size),
                    &mut fd as *mut RawFd as *mut u8,
                    fd_size,
                );
            }
            fds.push(fd);
        }
        cmsg = unsafe { libc::CMSG_NXTHDR(msg, cmsg) };
    }

    if let Some(reason) = deferred {
        close_all(&fds);
        return Err(invalid(reason));
    }
    if truncated {
        close_all(&fds);
        return Err(invalid(
            "control message truncated (MSG_CTRUNC)".to_string(),
        ));
    }
    if fds.is_empty() {
        return Err(invalid("no control message received".to_string()));
    }
    if fds.len() != expected {
        close_all(&fds);
        return Err(invalid(format!(
            "expected {} transferred fds, received {}",
            expected,
            fds.len()
        )));
    }

    // Mark close-on-exec so adopted PTY masters never leak into children
    // spawned by the adopting daemon.
    for &fd in &fds {
        if let Err(error) = crate::fd::set_cloexec(fd) {
            close_all(&fds);
            return Err(error);
        }
    }

    Ok(fds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn socketpair() -> (RawFd, RawFd) {
        let mut fds = [0 as RawFd; 2];
        let ret =
            unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(ret, 0, "socketpair failed");
        (fds[0], fds[1])
    }

    fn is_cloexec(fd: RawFd) -> bool {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0, "F_GETFD failed for fd {fd}");
        flags & libc::FD_CLOEXEC != 0
    }

    /// Pin the platform primitive itself: on Linux the kernel creates the
    /// descriptor close-on-exec, so the inheritable window `spawn_fd_boundary`
    /// exists to fence never opens at all. A sender's own FD_CLOEXEC does not
    /// travel over SCM_RIGHTS -- that is what makes the flag necessary -- so
    /// the descriptor is deliberately sent as an inheritable one.
    #[test]
    fn the_recv_flags_decide_whether_the_kernel_marks_the_descriptor() {
        let (s1, s2) = socketpair();
        let mut pipe_fds = [0 as RawFd; 2];
        unsafe { libc::pipe(pipe_fds.as_mut_ptr()) };
        assert!(!is_cloexec(pipe_fds[0]), "sent fd should be inheritable");

        send_fds(s1, &[pipe_fds[0]]).unwrap();

        // Receive by hand so the post-hoc marking in `recv_fds` cannot mask
        // what the kernel did.
        let mut dummy = [0u8; 1];
        let mut iov = libc::iovec {
            iov_base: dummy.as_mut_ptr().cast(),
            iov_len: 1,
        };
        let space = unsafe { libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) } as usize;
        let mut cmsg_buf = vec![0u8; space];
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cmsg_buf.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        assert!(unsafe { libc::recvmsg(s2, &mut msg, RECV_FDS_FLAGS) } > 0);
        let cmsg = unsafe { libc::CMSG_FIRSTHDR(&msg) };
        assert!(!cmsg.is_null());
        let mut received: RawFd = -1;
        unsafe {
            std::ptr::copy_nonoverlapping(
                libc::CMSG_DATA(cmsg),
                (&mut received as *mut RawFd).cast::<u8>(),
                std::mem::size_of::<RawFd>(),
            )
        };

        #[cfg(target_os = "linux")]
        assert!(
            is_cloexec(received),
            "MSG_CMSG_CLOEXEC must make the kernel mark the descriptor"
        );
        #[cfg(not(target_os = "linux"))]
        assert!(
            !is_cloexec(received),
            "without MSG_CMSG_CLOEXEC the descriptor arrives inheritable, \
             which is exactly why `spawn_fd_boundary` must fence the window"
        );

        unsafe {
            libc::close(received);
            libc::close(pipe_fds[0]);
            libc::close(pipe_fds[1]);
            libc::close(s1);
            libc::close(s2);
        }
    }

    #[test]
    fn test_send_recv_single_fd() {
        let (s1, s2) = socketpair();

        // Create a pipe — we'll transfer the read end
        let mut pipe_fds = [0 as RawFd; 2];
        unsafe { libc::pipe(pipe_fds.as_mut_ptr()) };
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);

        // Send the read fd
        send_fds(s1, &[pipe_read]).unwrap();
        unsafe { libc::close(pipe_read) }; // Close our copy

        // Receive it on the other side
        let received = recv_fds(s2, 1).unwrap();
        assert_eq!(received.len(), 1);

        // Write to pipe, read from transferred fd
        let msg = b"hello";
        unsafe { libc::write(pipe_write, msg.as_ptr() as *const _, msg.len()) };

        let mut buf = [0u8; 5];
        let n = unsafe { libc::read(received[0], buf.as_mut_ptr() as *mut _, buf.len()) };
        assert_eq!(n, 5);
        assert_eq!(&buf, b"hello");

        // Cleanup
        unsafe {
            libc::close(s1);
            libc::close(s2);
            libc::close(pipe_write);
            libc::close(received[0]);
        }
    }

    #[test]
    fn test_send_recv_multiple_fds() {
        let (s1, s2) = socketpair();

        // Create 3 pipes
        let mut pipes = Vec::new();
        let mut read_fds = Vec::new();
        for _ in 0..3 {
            let mut fds = [0 as RawFd; 2];
            unsafe { libc::pipe(fds.as_mut_ptr()) };
            read_fds.push(fds[0]);
            pipes.push((fds[0], fds[1]));
        }

        // Send all read fds
        send_fds(s1, &read_fds).unwrap();
        for &fd in &read_fds {
            unsafe { libc::close(fd) };
        }

        // Receive them
        let received = recv_fds(s2, 3).unwrap();
        assert_eq!(received.len(), 3);

        // Verify each one works
        for (i, &(_, write_fd)) in pipes.iter().enumerate() {
            let msg = format!("pipe{}", i);
            unsafe { libc::write(write_fd, msg.as_ptr() as *const _, msg.len()) };

            let mut buf = [0u8; 16];
            let n = unsafe { libc::read(received[i], buf.as_mut_ptr() as *mut _, buf.len()) };
            assert_eq!(&buf[..n as usize], msg.as_bytes());
        }

        // Cleanup
        unsafe {
            libc::close(s1);
            libc::close(s2);
            for &(_, w) in &pipes {
                libc::close(w);
            }
            for &fd in &received {
                libc::close(fd);
            }
        }
    }

    #[test]
    fn test_received_fds_are_close_on_exec() {
        let (s1, s2) = socketpair();

        let mut pipe_fds = [0 as RawFd; 2];
        assert_eq!(unsafe { libc::pipe(pipe_fds.as_mut_ptr()) }, 0);
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);

        send_fds(s1, &[pipe_read]).unwrap();
        let received = recv_fds(s2, 1).unwrap();
        assert_eq!(received.len(), 1);

        // Adopted fds (e.g. handoff PTY masters) must never leak into
        // children spawned by the receiving daemon.
        let flags = unsafe { libc::fcntl(received[0], libc::F_GETFD) };
        assert!(flags >= 0, "fcntl(F_GETFD) failed");
        assert!(
            flags & libc::FD_CLOEXEC != 0,
            "received fd should be close-on-exec"
        );

        unsafe {
            libc::close(s1);
            libc::close(s2);
            libc::close(pipe_read);
            libc::close(pipe_write);
            libc::close(received[0]);
        }
    }

    #[test]
    fn test_send_empty() {
        let (s1, s2) = socketpair();
        send_fds(s1, &[]).unwrap();
        // No recv needed — nothing was sent
        unsafe {
            libc::close(s1);
            libc::close(s2);
        }
    }

    #[test]
    fn test_invalid_fd_rejected() {
        let (s1, s2) = socketpair();
        let result = send_fds(s1, &[9999]);
        assert!(result.is_err());
        unsafe {
            libc::close(s1);
            libc::close(s2);
        }
    }

    /// Build a msghdr over a hand-crafted control buffer so malformed
    /// ancillary shapes can be exercised without kernel cooperation. The
    /// returned msghdr points into the returned buffer; keep both alive.
    fn crafted_control(
        fds: &[RawFd],
        level: libc::c_int,
        ctype: libc::c_int,
        len_override: Option<usize>,
        flags: libc::c_int,
    ) -> (Vec<u8>, libc::msghdr) {
        let fds_size = std::mem::size_of_val(fds);
        let space = unsafe { libc::CMSG_SPACE(fds_size as u32) } as usize;
        let mut buf = vec![0u8; space];
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_control = buf.as_mut_ptr() as *mut libc::c_void;
        msg.msg_controllen = space as _;
        msg.msg_flags = flags;
        let cmsg = unsafe { &mut *libc::CMSG_FIRSTHDR(&msg) };
        cmsg.cmsg_level = level;
        cmsg.cmsg_type = ctype;
        cmsg.cmsg_len =
            len_override.unwrap_or(unsafe { libc::CMSG_LEN(fds_size as u32) } as usize) as _;
        unsafe {
            std::ptr::copy_nonoverlapping(
                fds.as_ptr() as *const u8,
                libc::CMSG_DATA(libc::CMSG_FIRSTHDR(&msg)),
                fds_size,
            );
        }
        (buf, msg)
    }

    fn probe_pipe() -> (RawFd, RawFd) {
        let mut fds = [0 as RawFd; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (fds[0], fds[1])
    }

    /// Identity of the open file behind an fd. Closure assertions must
    /// compare file identity rather than probe the fd number: a concurrent
    /// test can reuse a just-closed number immediately.
    fn fd_file_identity(fd: RawFd) -> (libc::dev_t, libc::ino_t) {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::fstat(fd, &mut st) },
            0,
            "fstat should succeed"
        );
        (st.st_dev, st.st_ino)
    }

    fn fd_still_refers_to(fd: RawFd, identity: (libc::dev_t, libc::ino_t)) -> bool {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut st) } != 0 {
            return false;
        }
        (st.st_dev, st.st_ino) == identity
    }

    #[test]
    fn collect_rejects_wrong_control_level_without_touching_fds() {
        let (probe, probe_write) = probe_pipe();
        let pipe_identity = fd_file_identity(probe);
        let (_buf, msg) = crafted_control(&[probe], libc::IPPROTO_TCP, libc::SCM_RIGHTS, None, 0);
        let error = collect_scm_rights_fds(&msg, 1).expect_err("wrong level must be rejected");
        assert!(error.to_string().contains("unexpected control message"));
        assert!(
            fd_still_refers_to(probe, pipe_identity),
            "fds in a non-rights control message were never received and must not be closed"
        );
        unsafe {
            libc::close(probe);
            libc::close(probe_write);
        }
    }

    #[test]
    fn collect_rejects_wrong_control_type_without_touching_fds() {
        let (probe, probe_write) = probe_pipe();
        let pipe_identity = fd_file_identity(probe);
        let (_buf, msg) = crafted_control(&[probe], libc::SOL_SOCKET, 0x99, None, 0);
        let error = collect_scm_rights_fds(&msg, 1).expect_err("wrong type must be rejected");
        assert!(error.to_string().contains("unexpected control message"));
        assert!(fd_still_refers_to(probe, pipe_identity));
        unsafe {
            libc::close(probe);
            libc::close(probe_write);
        }
    }

    #[test]
    fn collect_rejects_invalid_cmsg_lengths() {
        let header_len = unsafe { libc::CMSG_LEN(0) } as usize;
        let (probe, probe_write) = probe_pipe();
        let pipe_identity = fd_file_identity(probe);

        // Shorter than a header.
        let (_buf, msg) = crafted_control(
            &[probe],
            libc::SOL_SOCKET,
            libc::SCM_RIGHTS,
            Some(header_len - 1),
            0,
        );
        let error = collect_scm_rights_fds(&msg, 1).expect_err("undersized cmsg_len");
        assert!(error.to_string().contains("invalid control message length"));

        // Overruns the control buffer.
        let (_buf, msg) = crafted_control(
            &[probe],
            libc::SOL_SOCKET,
            libc::SCM_RIGHTS,
            Some(unsafe { libc::CMSG_SPACE(4) } as usize + 16),
            0,
        );
        let error = collect_scm_rights_fds(&msg, 1).expect_err("overrunning cmsg_len");
        assert!(error.to_string().contains("invalid control message length"));

        // Payload that is not a whole number of descriptors.
        let (_buf, msg) = crafted_control(
            &[probe],
            libc::SOL_SOCKET,
            libc::SCM_RIGHTS,
            Some(header_len + 2),
            0,
        );
        let error = collect_scm_rights_fds(&msg, 1).expect_err("fractional fd payload");
        assert!(error.to_string().contains("whole number of fds"));

        assert!(
            fd_still_refers_to(probe, pipe_identity),
            "malformed shapes must not close caller fds"
        );
        unsafe {
            libc::close(probe);
            libc::close(probe_write);
        }
    }

    #[test]
    fn collect_rejects_short_fd_count_and_closes_only_received() {
        let (probe, probe_write) = probe_pipe();
        let pipe_identity = fd_file_identity(probe);
        let received = unsafe { libc::fcntl(probe, libc::F_DUPFD_CLOEXEC, 0) };
        assert!(received >= 0);
        let (_buf, msg) = crafted_control(&[received], libc::SOL_SOCKET, libc::SCM_RIGHTS, None, 0);
        let error = collect_scm_rights_fds(&msg, 2).expect_err("short fd count");
        assert!(error
            .to_string()
            .contains("expected 2 transferred fds, received 1"));
        assert!(
            !fd_still_refers_to(received, pipe_identity),
            "received fd must be closed on error"
        );
        assert!(
            fd_still_refers_to(probe, pipe_identity),
            "unrelated fds must stay open"
        );
        unsafe {
            libc::close(probe);
            libc::close(probe_write);
        }
    }

    #[test]
    fn collect_rejects_extra_fd_count_and_closes_all_received() {
        let (probe, probe_write) = probe_pipe();
        let pipe_identity = fd_file_identity(probe);
        let first = unsafe { libc::fcntl(probe, libc::F_DUPFD_CLOEXEC, 0) };
        let second = unsafe { libc::fcntl(probe, libc::F_DUPFD_CLOEXEC, 0) };
        assert!(first >= 0 && second >= 0);
        let (_buf, msg) = crafted_control(
            &[first, second],
            libc::SOL_SOCKET,
            libc::SCM_RIGHTS,
            None,
            0,
        );
        let error = collect_scm_rights_fds(&msg, 1).expect_err("extra fd count");
        assert!(error
            .to_string()
            .contains("expected 1 transferred fds, received 2"));
        assert!(
            !fd_still_refers_to(first, pipe_identity) && !fd_still_refers_to(second, pipe_identity),
            "all received fds must be closed on error"
        );
        assert!(fd_still_refers_to(probe, pipe_identity));
        unsafe {
            libc::close(probe);
            libc::close(probe_write);
        }
    }

    #[test]
    fn collect_rejects_truncated_control_data_and_closes_received() {
        let (probe, probe_write) = probe_pipe();
        let pipe_identity = fd_file_identity(probe);
        let received = unsafe { libc::fcntl(probe, libc::F_DUPFD_CLOEXEC, 0) };
        assert!(received >= 0);
        let (_buf, msg) = crafted_control(
            &[received],
            libc::SOL_SOCKET,
            libc::SCM_RIGHTS,
            None,
            libc::MSG_CTRUNC,
        );
        let error = collect_scm_rights_fds(&msg, 1).expect_err("truncated control data");
        assert!(error.to_string().contains("MSG_CTRUNC"));
        assert!(
            !fd_still_refers_to(received, pipe_identity),
            "received fd must be closed on error"
        );
        assert!(fd_still_refers_to(probe, pipe_identity));
        unsafe {
            libc::close(probe);
            libc::close(probe_write);
        }
    }

    /// The pre-fix parser copied `expected` descriptors regardless of how
    /// many arrived, then marked and later closed fabricated fd 0. A count
    /// mismatch over a real socket must error without mutating stdin.
    #[test]
    fn recv_count_mismatch_over_socket_does_not_mutate_unrelated_fds() {
        let stdin_flags_before = unsafe { libc::fcntl(0, libc::F_GETFD) };

        let (s1, s2) = socketpair();
        let mut pipe_fds = [0 as RawFd; 2];
        assert_eq!(unsafe { libc::pipe(pipe_fds.as_mut_ptr()) }, 0);
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);

        send_fds(s1, &[pipe_read]).unwrap();
        let error = recv_fds(s2, 2).expect_err("count mismatch must be rejected");
        assert!(
            error.to_string().contains("received 1") || error.to_string().contains("MSG_CTRUNC"),
            "unexpected error: {error}"
        );

        let stdin_flags_after = unsafe { libc::fcntl(0, libc::F_GETFD) };
        assert_eq!(
            stdin_flags_before, stdin_flags_after,
            "stdin flags must not be mutated by a malformed transfer"
        );

        unsafe {
            libc::close(s1);
            libc::close(s2);
            libc::close(pipe_read);
            libc::close(pipe_write);
        }
    }

    /// More fds on the wire than the receive buffer expects: the kernel
    /// truncates the control data and the transfer must be rejected.
    #[test]
    fn recv_truncated_transfer_is_rejected() {
        let (s1, s2) = socketpair();
        let mut probes = Vec::new();
        for _ in 0..3 {
            probes.push(probe_pipe());
        }
        let read_ends: Vec<RawFd> = probes.iter().map(|&(read, _)| read).collect();
        send_fds(s1, &read_ends).unwrap();
        let error = recv_fds(s2, 1).expect_err("truncated transfer must be rejected");
        assert!(
            error.to_string().contains("MSG_CTRUNC")
                || error.to_string().contains("expected 1 transferred fds"),
            "unexpected error: {error}"
        );
        unsafe {
            libc::close(s1);
            libc::close(s2);
            for (read, write) in probes {
                libc::close(read);
                libc::close(write);
            }
        }
    }

    /// Backpressure: SCM_RIGHTS send against a socket whose buffer is full
    /// must retry under its bounded deadline rather than abandoning the
    /// handoff. The receiver drains after a delay, so the send must succeed.
    #[test]
    fn send_fds_retries_across_socket_backpressure() {
        let (s1, s2) = socketpair();
        // Non-blocking sender + a tiny send buffer makes EAGAIN reachable.
        let flags = unsafe { libc::fcntl(s1, libc::F_GETFL) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(s1, libc::F_SETFL, flags | libc::O_NONBLOCK) },
            0
        );
        // Realistic (not pathologically tiny) buffer: small enough to fill,
        // large enough that the ancillary message still FITS — otherwise the
        // kernel returns EMSGSIZE, which is a permanent error and correctly
        // not retried.
        let small: libc::c_int = 8192;
        unsafe {
            libc::setsockopt(
                s1,
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                &small as *const libc::c_int as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
        // Fill the pipe so the ancillary send meets real backpressure.
        let filler = [0u8; 1024];
        for _ in 0..256 {
            let ret =
                unsafe { libc::send(s1, filler.as_ptr() as *const libc::c_void, filler.len(), 0) };
            if ret < 0 {
                break;
            }
        }

        let (pipe_read, pipe_write) = probe_pipe();
        // Drain concurrently so the retry window can make progress.
        // The receiver must be non-blocking too: a blocking `recv` would hang
        // this thread forever once the buffer is drained.
        let s2_flags = unsafe { libc::fcntl(s2, libc::F_GETFL) };
        assert!(s2_flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(s2, libc::F_SETFL, s2_flags | libc::O_NONBLOCK) },
            0
        );
        let drainer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            let mut sink = [0u8; 4096];
            let deadline = Instant::now() + Duration::from_millis(400);
            while Instant::now() < deadline {
                let ret = unsafe {
                    libc::recv(s2, sink.as_mut_ptr() as *mut libc::c_void, sink.len(), 0)
                };
                if ret == 0 {
                    break;
                }
                if ret < 0 {
                    // EAGAIN: nothing buffered right now.
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            s2
        });

        let result = send_fds(s1, &[pipe_read]);
        let s2 = drainer.join().expect("drainer should not panic");
        assert!(
            result.is_ok(),
            "send must retry across backpressure, got {result:?}"
        );

        unsafe {
            libc::close(s1);
            libc::close(s2);
            libc::close(pipe_read);
            libc::close(pipe_write);
        }
    }

    #[test]
    fn test_send_fds_retries_until_peer_drains_backlog() {
        let (s1, s2) = socketpair();

        let flags = unsafe { libc::fcntl(s1, libc::F_GETFL) };
        assert!(flags >= 0, "failed to read socket flags");
        let set_ret = unsafe { libc::fcntl(s1, libc::F_SETFL, flags | libc::O_NONBLOCK) };
        assert_eq!(set_ret, 0, "failed to enable nonblocking mode");

        // Fill the send buffer the way a handoff does: a large response
        // written immediately before the fds.
        let junk = [0u8; 8192];
        let mut queued: usize = 0;
        loop {
            let n = unsafe { libc::send(s1, junk.as_ptr() as *const _, junk.len(), 0) };
            if n < 0 {
                let error = io::Error::last_os_error();
                assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
                break;
            }
            queued += n as usize;
        }
        assert!(queued > 0, "expected to fill the socket send buffer");

        let mut pipe_fds = [0 as RawFd; 2];
        assert_eq!(
            unsafe { libc::pipe(pipe_fds.as_mut_ptr()) },
            0,
            "pipe failed"
        );
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);

        // Drain the backlog from the peer after a delay, mimicking the
        // adopting daemon still reading the response line.
        let drainer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let mut remaining = queued;
            let mut buf = [0u8; 8192];
            while remaining > 0 {
                let want = remaining.min(buf.len());
                let n = unsafe { libc::read(s2, buf.as_mut_ptr() as *mut _, want) };
                assert!(n > 0, "peer read failed while draining backlog");
                remaining -= n as usize;
            }
            s2
        });

        // Must retry through the full buffer instead of failing on the
        // first EAGAIN/EMSGSIZE.
        send_fds(s1, &[pipe_read]).unwrap();
        unsafe { libc::close(pipe_read) };

        let s2 = drainer.join().unwrap();
        let received = recv_fds(s2, 1).unwrap();
        assert_eq!(received.len(), 1);

        let msg = b"drain";
        unsafe { libc::write(pipe_write, msg.as_ptr() as *const _, msg.len()) };
        let mut buf = [0u8; 5];
        let n = unsafe { libc::read(received[0], buf.as_mut_ptr() as *mut _, buf.len()) };
        assert_eq!(n, 5);
        assert_eq!(&buf, b"drain");

        unsafe {
            libc::close(s1);
            libc::close(s2);
            libc::close(pipe_write);
            libc::close(received[0]);
        }
    }

    #[test]
    fn test_recv_fds_retries_would_block_until_fds_arrive() {
        let (s1, s2) = socketpair();

        let flags = unsafe { libc::fcntl(s2, libc::F_GETFL) };
        assert!(flags >= 0, "failed to read socket flags");
        let set_ret = unsafe { libc::fcntl(s2, libc::F_SETFL, flags | libc::O_NONBLOCK) };
        assert_eq!(set_ret, 0, "failed to enable nonblocking mode");

        let mut pipe_fds = [0 as RawFd; 2];
        let pipe_ret = unsafe { libc::pipe(pipe_fds.as_mut_ptr()) };
        assert_eq!(pipe_ret, 0, "pipe failed");
        let (pipe_read, pipe_write) = (pipe_fds[0], pipe_fds[1]);

        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            send_fds(s1, &[pipe_read]).unwrap();
            unsafe {
                libc::close(pipe_read);
                libc::close(s1);
            }
        });

        let received = recv_fds(s2, 1).unwrap();
        assert_eq!(received.len(), 1);

        let msg = b"retry";
        unsafe { libc::write(pipe_write, msg.as_ptr() as *const _, msg.len()) };

        let mut buf = [0u8; 5];
        let n = unsafe { libc::read(received[0], buf.as_mut_ptr() as *mut _, buf.len()) };
        assert_eq!(n, 5);
        assert_eq!(&buf, b"retry");

        sender.join().unwrap();

        unsafe {
            libc::close(s2);
            libc::close(pipe_write);
            libc::close(received[0]);
        }
    }

    /// A descriptor on a fresh, already-unlinked temp file, plus its identity.
    ///
    /// Files rather than pipes: macOS reports the same dev/ino for distinct pipes,
    /// so a pipe fd that was correctly closed and whose number was reused by a
    /// parallel test is indistinguishable from one that leaked. A regular file has
    /// a unique inode, which makes "is this still the same object" answerable.
    fn probe_file() -> (RawFd, (libc::dev_t, libc::ino_t)) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("kanna-fdprobe-{}-{seq}", std::process::id()));
        let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).expect("path");
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600 as libc::c_uint,
            )
        };
        assert!(fd >= 0, "failed to create probe file {path:?}");
        unsafe { libc::unlink(c.as_ptr()) };
        (fd, fd_file_identity(fd))
    }

    /// Build a two-message ancillary chain: a foreign header, then SCM_RIGHTS.
    fn crafted_foreign_then_rights(fds: &[RawFd]) -> (Vec<u8>, libc::msghdr) {
        let rights_size = std::mem::size_of_val(fds);
        let space = unsafe { libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) } as usize
            + unsafe { libc::CMSG_SPACE(rights_size as u32) } as usize;
        let mut buf = vec![0u8; space];
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_control = buf.as_mut_ptr() as *mut libc::c_void;
        msg.msg_controllen = space as _;
        unsafe {
            let one = libc::CMSG_FIRSTHDR(&msg);
            (*one).cmsg_level = libc::SOL_SOCKET;
            (*one).cmsg_type = libc::SCM_RIGHTS.wrapping_add(1);
            (*one).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
            let two = libc::CMSG_NXTHDR(&msg, one);
            assert!(!two.is_null(), "control buffer too small for a second cmsg");
            (*two).cmsg_level = libc::SOL_SOCKET;
            (*two).cmsg_type = libc::SCM_RIGHTS;
            (*two).cmsg_len = libc::CMSG_LEN(rights_size as u32) as _;
            std::ptr::copy_nonoverlapping(
                fds.as_ptr() as *const u8,
                libc::CMSG_DATA(two),
                rights_size,
            );
        }
        (buf, msg)
    }

    /// Descriptors carried BEHIND an unexpected header must still be closed.
    ///
    /// The walk used to return at the first foreign control message. `recvmsg` has
    /// already installed every SCM_RIGHTS descriptor in this process's fd table by
    /// then, so a chain like `[foreign, SCM_RIGHTS(a, b)]` was refused while a and
    /// b stayed open — inheritable, and therefore pinned in the next child spawned.
    #[test]
    fn collect_closes_descriptors_carried_behind_a_foreign_header() {
        let (a, a_id) = probe_file();
        let (b, b_id) = probe_file();
        let (_buf, msg) = crafted_foreign_then_rights(&[a, b]);

        let error = collect_scm_rights_fds(&msg, 2)
            .expect_err("a chain containing a foreign control message must be refused");
        assert!(
            error.to_string().contains("unexpected control message"),
            "unexpected error: {error}"
        );
        assert!(
            !fd_still_refers_to(a, a_id),
            "descriptor {a} behind the foreign header leaked"
        );
        assert!(
            !fd_still_refers_to(b, b_id),
            "descriptor {b} behind the foreign header leaked"
        );
    }
}
