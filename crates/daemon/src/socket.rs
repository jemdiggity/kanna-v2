use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

use crate::protocol::{Command, Event};

pub fn bind_socket(path: &Path) -> std::io::Result<UnixListener> {
    // Remove stale socket file if it exists
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    UnixListener::bind(path)
}

pub async fn read_command<R>(reader: &mut BufReader<R>) -> Option<Command>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Ok(0) => None, // EOF
        Ok(_) => {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            match serde_json::from_str(trimmed) {
                Ok(cmd) => Some(cmd),
                Err(e) => {
                    eprintln!(
                        "failed to deserialize command: {} — input: {:?}",
                        e, trimmed
                    );
                    None
                }
            }
        }
        Err(e) => {
            eprintln!("error reading from socket: {}", e);
            None
        }
    }
}

pub async fn write_event<W>(writer: &mut W, event: &Event) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let mut json = serde_json::to_string(event)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    json.push('\n');
    writer.write_all(json.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}
