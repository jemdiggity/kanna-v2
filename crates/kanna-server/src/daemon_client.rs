use kanna_daemon::protocol::{Command, Event};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
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
        })
    }

    pub async fn send_command(
        &mut self,
        cmd: &Command,
    ) -> Result<Event, Box<dyn std::error::Error>> {
        let json = serde_json::to_string(cmd)?;
        self.writer.write_all(json.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        let mut line = String::new();
        self.reader.read_line(&mut line).await?;
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
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
