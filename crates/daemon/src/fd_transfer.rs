//! Transfer file descriptors between processes over a Unix socket using SCM_RIGHTS.
//!
//! Unix allows sending file descriptors as ancillary (out-of-band) data on
//! Unix domain sockets via `sendmsg`/`recvmsg` with `SCM_RIGHTS` control
//! messages. The kernel maps the fd numbers into the receiving process's
//! fd table, so the child process's PTY connection survives the transfer.

use std::io;
use std::os::unix::io::RawFd;

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

    let ret = unsafe { libc::sendmsg(socket, &msg, 0) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

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

    let ret = unsafe { libc::recvmsg(socket, &mut msg, 0) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    if ret == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "connection closed",
        ));
    }

    // Extract fds from the control message
    let cmsg = unsafe { libc::CMSG_FIRSTHDR(&msg) };
    if cmsg.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no control message received",
        ));
    }

    let cmsg_ref = unsafe { &*cmsg };
    if cmsg_ref.cmsg_level != libc::SOL_SOCKET || cmsg_ref.cmsg_type != libc::SCM_RIGHTS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unexpected control message: level={}, type={}",
                cmsg_ref.cmsg_level, cmsg_ref.cmsg_type
            ),
        ));
    }

    let mut fds = vec![0 as RawFd; count];
    unsafe {
        std::ptr::copy_nonoverlapping(libc::CMSG_DATA(cmsg), fds.as_mut_ptr() as *mut u8, fds_size);
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
}
