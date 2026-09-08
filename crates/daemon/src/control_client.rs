//! A minimal client for the daemon's control socket.
//!
//! Line-delimited JSON in, line-delimited JSON out, plus the connected
//! daemon's kernel-reported pid. Two processes outside the daemon need
//! exactly this much and nothing Tauri-shaped: the desktop app's event
//! bridge and the headless worker's supervisor, both of which have to
//! recognise a daemon generation before authorizing a server on it. The
//! server keeps its own richer client.
//!
//! (`client` next door is the daemon's own view of a *connected* client; this
//! is the other direction.)
//!
//! The desktop app still carries its own copy in
//! `apps/desktop/src-tauri/src/daemon_client.rs`. Folding it onto this one
//! would make the desktop depend on the whole daemon crate -- Ghostty and all
//! -- which is a change to the app's dependency graph and its Bazel manifest,
//! not a refactor. Keep the two in step by hand until that is decided.

use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    connected_pid: u32,
}

impl DaemonClient {
    pub async fn connect(socket_path: &Path) -> Result<Self, String> {
        let stream = UnixStream::connect(socket_path)
            .await
            .map_err(|e| format!("failed to connect to daemon socket: {}", e))?;
        let connected_pid = peer_pid(&stream)?;
        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
            connected_pid,
        })
    }

    pub fn connected_pid(&self) -> u32 {
        self.connected_pid
    }

    /// Test-only: stand in for a daemon generation without one running.
    ///
    /// Not `#[cfg(test)]`, because the tests that need it live in the crates
    /// that *use* this client, and a `cfg(test)` item is invisible to them.
    #[doc(hidden)]
    pub fn set_connected_pid_for_test(&mut self, pid: u32) {
        self.connected_pid = pid;
    }

    pub async fn send_command(&mut self, json: &str) -> Result<(), String> {
        let mut line = json.to_string();
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("failed to write command: {}", e))?;
        self.writer
            .flush()
            .await
            .map_err(|e| format!("failed to flush command: {}", e))?;
        Ok(())
    }

    pub async fn read_event(&mut self) -> Result<String, String> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("failed to read event: {}", e))?;
        if n == 0 {
            return Err("connection closed by daemon".to_string());
        }
        Ok(line.trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> Result<u32, String> {
    use std::os::fd::AsRawFd;

    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            std::ptr::addr_of_mut!(pid).cast(),
            &mut length,
        )
    };
    if result == 0 && pid > 0 {
        Ok(pid as u32)
    } else {
        Err(format!(
            "failed to identify connected daemon pid: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(target_os = "linux")]
fn peer_pid(stream: &UnixStream) -> Result<u32, String> {
    use std::os::fd::AsRawFd;

    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of_val(&credentials) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if result == 0 && credentials.pid > 0 {
        Ok(credentials.pid as u32)
    } else {
        Err(format!(
            "failed to identify connected daemon pid: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_pid(_stream: &UnixStream) -> Result<u32, String> {
    Err("connected daemon pid lookup is unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::DaemonClient;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn connect_records_the_socket_peers_pid() {
        let dir = std::env::temp_dir().join(format!(
            "kd-dc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("d.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let accept = tokio::spawn(async move { listener.accept().await.unwrap() });

        let client = DaemonClient::connect(&socket_path).await.unwrap();

        assert_eq!(client.connected_pid(), std::process::id());
        let _ = accept.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
