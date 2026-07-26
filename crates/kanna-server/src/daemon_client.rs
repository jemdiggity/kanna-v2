use kanna_daemon::protocol::{Command, DaemonCapabilities, Event, SessionInfo};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// Bound on one command round-trip. Daemon commands answer in well under a
/// second when healthy; an unbounded await turns a wedged daemon into
/// silently parked work — on 2026-07-24 every stage transition vanished
/// mid-flight awaiting a Kill response that never came, with nothing
/// logged. Generous so that a merely-busy daemon never trips it.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

pub struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    /// Per-round-trip bound; `COMMAND_TIMEOUT` in production, shrinkable in
    /// tests so timeout behavior is verifiable without a 30s stall.
    command_timeout: Duration,
    /// Set after a timeout: the response to the timed-out command may still
    /// arrive and would pair with the wrong request, so the connection is
    /// unusable.
    poisoned: bool,
    socket_path: PathBuf,
}

pub struct DaemonClientReader {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
}

pub struct DaemonClientWriter {
    writer: tokio::net::unix::OwnedWriteHalf,
}

pub struct DaemonList {
    pub sessions: Vec<SessionInfo>,
    pub capabilities: DaemonCapabilities,
}

fn list_from_event(event: Event) -> Result<DaemonList, String> {
    match event {
        Event::SessionList {
            sessions,
            capabilities,
        } => Ok(DaemonList {
            sessions,
            capabilities: capabilities.unwrap_or_else(DaemonCapabilities::legacy),
        }),
        Event::Error { message, .. } => Err(format!("daemon list error: {message}")),
        other => Err(format!("unexpected daemon list response: {other:?}")),
    }
}

#[cfg(test)]
fn capabilities_from_list_event(event: Event) -> Result<DaemonCapabilities, String> {
    Ok(list_from_event(event)?.capabilities)
}

pub fn require_provider_resume(capabilities: &DaemonCapabilities) -> Result<(), String> {
    if !capabilities.provider_resume || !capabilities.immutable_run_ownership {
        return Err(
            "daemon does not support provider resume with immutable run ownership".to_string(),
        );
    }
    Ok(())
}

impl DaemonClient {
    pub async fn connect(daemon_dir: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(daemon_dir));
        let stream = UnixStream::connect(&socket_path).await.map_err(|e| {
            format!(
                "Failed to connect to daemon at {}: {}",
                socket_path.display(),
                e
            )
        })?;
        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
            command_timeout: COMMAND_TIMEOUT,
            poisoned: false,
            socket_path,
        })
    }

    /// Shrink the round-trip bound so tests can exercise the timeout path
    /// without waiting out the production duration.
    #[cfg(test)]
    pub(crate) fn set_command_timeout_for_test(&mut self, timeout: Duration) {
        self.command_timeout = timeout;
    }

    pub async fn reconnect(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let stream = UnixStream::connect(&self.socket_path).await.map_err(|e| {
            format!(
                "Failed to reconnect to daemon at {}: {}",
                self.socket_path.display(),
                e
            )
        })?;
        let (read_half, write_half) = stream.into_split();
        self.reader = BufReader::new(read_half);
        self.writer = write_half;
        self.poisoned = false;
        Ok(())
    }

    pub async fn send_command(
        &mut self,
        cmd: &Command,
    ) -> Result<Event, Box<dyn std::error::Error>> {
        if self.poisoned {
            return Err(
                "daemon connection unusable after an earlier command timeout; reconnect".into(),
            );
        }
        let json = serde_json::to_string(cmd)?;
        let round_trip = async {
            self.writer.write_all(json.as_bytes()).await?;
            self.writer.write_all(b"\n").await?;
            self.writer.flush().await?;
            let mut line = String::new();
            self.reader.read_line(&mut line).await?;
            let event: Event = serde_json::from_str(line.trim())?;
            Ok(event)
        };
        match tokio::time::timeout(self.command_timeout, round_trip).await {
            Ok(result) => result,
            Err(_) => {
                self.poisoned = true;
                Err(format!(
                    "daemon command timed out after {}s (daemon wedged or overloaded)",
                    self.command_timeout.as_secs()
                )
                .into())
            }
        }
    }

    pub async fn send_one_way(&mut self, cmd: &Command) -> Result<(), Box<dyn std::error::Error>> {
        if self.poisoned {
            return Err(
                "daemon connection unusable after an earlier command timeout; reconnect".into(),
            );
        }
        let json = serde_json::to_string(cmd)?;
        let write = async {
            self.writer.write_all(json.as_bytes()).await?;
            self.writer.write_all(b"\n").await?;
            self.writer.flush().await
        };
        match tokio::time::timeout(self.command_timeout, write).await {
            Ok(result) => result.map_err(Into::into),
            Err(_) => {
                self.poisoned = true;
                Err(format!(
                    "daemon command write timed out after {}s (daemon wedged or overloaded)",
                    self.command_timeout.as_secs()
                )
                .into())
            }
        }
    }

    pub async fn read_event(&mut self) -> Result<Event, Box<dyn std::error::Error>> {
        let mut line = String::new();
        self.reader.read_line(&mut line).await?;
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
    }

    pub async fn list(&mut self) -> Result<DaemonList, Box<dyn std::error::Error>> {
        let event = self.send_command(&Command::List).await?;
        list_from_event(event).map_err(Into::into)
    }

    pub async fn capabilities(&mut self) -> Result<DaemonCapabilities, Box<dyn std::error::Error>> {
        Ok(self.list().await?.capabilities)
    }

    pub fn into_split(self) -> (DaemonClientReader, DaemonClientWriter) {
        (
            DaemonClientReader {
                reader: self.reader,
            },
            DaemonClientWriter {
                writer: self.writer,
            },
        )
    }
}

impl DaemonClientReader {
    pub async fn read_event(&mut self) -> Result<Event, Box<dyn std::error::Error>> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line).await?;
        if read == 0 {
            return Err("daemon connection closed".into());
        }
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
    }
}

impl DaemonClientWriter {
    pub async fn send_one_way(&mut self, cmd: &Command) -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_string(cmd)?;
        self.writer.write_all(json.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    fn temp_daemon_dir(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "kanna-daemon-client-test-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[tokio::test]
    async fn timed_out_command_fails_promptly_and_poisons_the_connection() {
        let daemon_dir = temp_daemon_dir("timeout-poison");
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(&daemon_dir));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();

        // Fake daemon over the real socket: accepts and reads the command
        // but never replies — the 2026-07-24 wedge shape — then delivers a
        // reply only after the client has already timed out.
        let (release_late_reply_tx, release_late_reply_rx) = tokio::sync::oneshot::channel::<()>();
        let (late_reply_sent_tx, late_reply_sent_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            release_late_reply_rx.await.unwrap();
            let response = serde_json::to_string(&Event::Ok).unwrap();
            write_half.write_all(response.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            late_reply_sent_tx.send(()).unwrap();
            // Keep the connection open so the client observes a stall or a
            // late reply, never an EOF.
            std::future::pending::<()>().await;
        });

        let mut client = DaemonClient::connect(&daemon_dir).await.unwrap();
        client.set_command_timeout_for_test(Duration::from_millis(200));

        let started = std::time::Instant::now();
        let error = client
            .send_command(&Command::List)
            .await
            .expect_err("a never-answered command must time out");
        assert!(
            error.to_string().contains("timed out"),
            "unexpected error: {error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timeout was not prompt: {:?}",
            started.elapsed()
        );

        // Deliver the stalled command's reply late, then issue another
        // command: it must be rejected as poisoned without reading the
        // socket, so the late reply can never be paired with it.
        release_late_reply_tx.send(()).unwrap();
        late_reply_sent_rx.await.unwrap();
        let error = client
            .send_command(&Command::List)
            .await
            .expect_err("a poisoned connection must reject further commands");
        assert!(
            error
                .to_string()
                .contains("unusable after an earlier command timeout"),
            "unexpected error: {error}"
        );

        server.abort();
        let _ = std::fs::remove_file(&socket_path);
    }

    #[test]
    fn daemon_capabilities_fail_closed_for_legacy_list() {
        let capabilities = capabilities_from_list_event(Event::SessionList {
            sessions: Vec::new(),
            capabilities: None,
        })
        .unwrap();

        assert!(!capabilities.immutable_run_ownership);
        assert!(!capabilities.provider_session_events);
        assert!(!capabilities.provider_resume);
        assert!(require_provider_resume(&capabilities).is_err());
    }

    #[test]
    fn daemon_capabilities_accept_current_resume_support() {
        let capabilities = capabilities_from_list_event(Event::SessionList {
            sessions: Vec::new(),
            capabilities: Some(DaemonCapabilities::current()),
        })
        .unwrap();

        require_provider_resume(&capabilities).unwrap();
    }
}
