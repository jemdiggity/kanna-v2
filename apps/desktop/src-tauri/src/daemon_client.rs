use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

impl DaemonClient {
    pub async fn connect(socket_path: &PathBuf) -> Result<Self, String> {
        let stream = UnixStream::connect(socket_path)
            .await
            .map_err(|e| format!("failed to connect to daemon socket: {}", e))?;
        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
        })
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
