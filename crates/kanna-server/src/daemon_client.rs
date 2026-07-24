use kanna_daemon::protocol::{Command, Event};
use std::path::Path;
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
    /// Set after a timeout: the response to the timed-out command may still
    /// arrive and would pair with the wrong request, so the connection is
    /// unusable.
    poisoned: bool,
}

pub struct DaemonClientReader {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
}

pub struct DaemonClientWriter {
    writer: tokio::net::unix::OwnedWriteHalf,
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
            poisoned: false,
        })
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
        match tokio::time::timeout(COMMAND_TIMEOUT, round_trip).await {
            Ok(result) => result,
            Err(_) => {
                self.poisoned = true;
                Err(format!(
                    "daemon command timed out after {}s (daemon wedged or overloaded)",
                    COMMAND_TIMEOUT.as_secs()
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
