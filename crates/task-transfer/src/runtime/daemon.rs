use super::events::{RuntimeError, RuntimeEvent};
use super::state::ListenerContext;
use super::state::RuntimeEventSender;
use super::utils::{
    ensure_peer_is_trusted_for, parse_peer_response_line, parse_peer_terminal_event_line,
    peer_terminal_event_session_id, unexpected_peer_response, write_json_line,
};
use crate::protocol::{
    PeerRegistryEntry, PeerRequest, PeerResponse, PeerTerminalControl, PeerTerminalEvent,
};
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::path::Path;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixStream};

pub(super) struct DaemonConnection {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

pub(super) struct PeerSessionBridge {
    pub(super) observer_lease_id: String,
    pub(super) incoming_sender: RuntimeEventSender,
    pub(super) control_receiver: Option<tokio::sync::mpsc::Receiver<PeerTerminalControl>>,
}

struct CancellableBoundedLineReader<R> {
    reader: R,
    buffered: Vec<u8>,
}

impl<R> CancellableBoundedLineReader<R>
where
    R: AsyncBufRead + Unpin,
{
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffered: Vec::new(),
        }
    }

    /// Unlike a helper with a stack-local accumulator, this remains safe when
    /// `tokio::select!` cancels the read while daemon output wins the race.
    async fn next_line(
        &mut self,
        max_bytes: usize,
        description: &str,
    ) -> Result<Option<String>, RuntimeError> {
        loop {
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                if self.buffered.is_empty() {
                    return Ok(None);
                }
                return Err(RuntimeError::Protocol(format!(
                    "{description} is missing newline"
                )));
            }
            if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
                if self.buffered.len().saturating_add(newline) > max_bytes {
                    return Err(RuntimeError::Protocol(format!(
                        "{description} exceeds {max_bytes} bytes"
                    )));
                }
                self.buffered.extend_from_slice(&available[..newline]);
                self.reader.consume(newline + 1);
                if self.buffered.last() == Some(&b'\r') {
                    self.buffered.pop();
                }
                let line = std::mem::take(&mut self.buffered);
                return String::from_utf8(line).map(Some).map_err(|_| {
                    RuntimeError::Protocol(format!("{description} is not valid UTF-8"))
                });
            }
            if self.buffered.len().saturating_add(available.len()) > max_bytes {
                return Err(RuntimeError::Protocol(format!(
                    "{description} exceeds {max_bytes} bytes"
                )));
            }
            self.buffered.extend_from_slice(available);
            let consumed = available.len();
            self.reader.consume(consumed);
        }
    }
}

pub(super) async fn stream_peer_session(
    peer: PeerRegistryEntry,
    request_id: String,
    requester_peer_id: String,
    session_id: String,
    sealed_payload: String,
    bridge: PeerSessionBridge,
) -> Result<(), RuntimeError> {
    let PeerSessionBridge {
        observer_lease_id,
        incoming_sender,
        mut control_receiver,
    } = bridge;
    let mut stream = TcpStream::connect(&peer.endpoint).await?;
    write_json_line(
        &mut stream,
        &PeerRequest::ObserveSession {
            request_id: request_id.clone(),
            requester_peer_id,
            session_id: session_id.clone(),
            sealed_payload: Some(sealed_payload),
        },
    )
    .await?;

    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut response_line = String::new();
    let read = reader.read_line(&mut response_line).await?;
    if read == 0 {
        return Err(RuntimeError::Protocol(format!(
            "peer {} closed observe-session before response",
            peer.peer_id
        )));
    }

    match parse_peer_response_line(&peer.peer_id, "observe-session", &response_line)? {
        PeerResponse::ObserveSession {
            request_id: response_request_id,
            session_id: response_session_id,
        } if response_request_id == request_id && response_session_id == session_id => {}
        PeerResponse::Error { message, .. } => return Err(RuntimeError::Protocol(message)),
        other => return Err(unexpected_peer_response("observe-session", &other)),
    }

    let mut lines = reader.lines();
    loop {
        tokio::select! {
            event_line = lines.next_line() => {
                let Some(event_line) = event_line? else {
                    return Ok(());
                };
                let event = parse_peer_terminal_event_line(&peer.peer_id, &session_id, &event_line)?;
                let event_session_id = peer_terminal_event_session_id(&event).to_owned();
                incoming_sender
                    .try_send(RuntimeEvent::TerminalEvent {
                        peer_id: peer.peer_id.clone(),
                        session_id: event_session_id,
                        observer_lease_id: observer_lease_id.clone(),
                        event,
                    })
                    .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
            }
            control = async {
                match control_receiver.as_mut() {
                    Some(receiver) => receiver.recv().await,
                    None => std::future::pending::<Option<PeerTerminalControl>>().await,
                }
            } => {
                let Some(control) = control else {
                    control_receiver = None;
                    continue;
                };
                write_json_line(&mut write_half, &control).await?;
            }
        }
    }
}

pub(super) async fn prepare_session_observer(
    context: &ListenerContext,
    session_id: &str,
) -> Result<(DaemonConnection, kanna_daemon::protocol::TerminalSnapshot), RuntimeError> {
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    let snapshot = observe_session_snapshot(&mut daemon, session_id).await?;
    Ok((daemon, snapshot))
}

/// Atomic observer cutover: the daemon snapshots the authoritative headless
/// terminal and registers this connection as an observer in one step, with
/// the snapshot as the first event — so every later `Output` is strictly
/// after the snapshot and none precedes or is lost to it.
async fn observe_session_snapshot(
    daemon: &mut DaemonConnection,
    session_id: &str,
) -> Result<kanna_daemon::protocol::TerminalSnapshot, RuntimeError> {
    send_daemon_command(
        daemon,
        &DaemonCommand::ObserveSnapshot {
            session_id: session_id.to_owned(),
        },
    )
    .await?;
    match read_daemon_event(daemon).await? {
        DaemonEvent::Snapshot {
            session_id: event_session_id,
            snapshot,
            ..
        } if event_session_id == session_id => Ok(snapshot),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon observe response: {:?}",
            other
        ))),
    }
}

pub(super) async fn requester_peer_public_key(
    context: &ListenerContext,
    requester_peer_id: &str,
) -> Result<x25519_dalek::PublicKey, RuntimeError> {
    let requester_peer = context
        .discovery
        .list_peers(&context.self_peer_id)
        .await?
        .into_iter()
        .find(|peer| peer.peer_id == requester_peer_id)
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "requester peer {} is not currently discovered",
                requester_peer_id
            ))
        })?;
    ensure_peer_is_trusted_for(
        &context.registry_root,
        &context.self_peer_id,
        requester_peer_id,
        &requester_peer.public_key,
    )?;
    Ok(crate::crypto::parse_public_key(&requester_peer.public_key)?)
}

pub(super) async fn send_daemon_input(
    context: &ListenerContext,
    session_id: &str,
    data: Vec<u8>,
    submission_boundary: bool,
    control_input: bool,
) -> Result<(), RuntimeError> {
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &if control_input {
            DaemonCommand::InputControl {
                session_id: session_id.to_owned(),
                data,
            }
        } else if submission_boundary {
            DaemonCommand::InputBoundary {
                session_id: session_id.to_owned(),
                data,
            }
        } else {
            DaemonCommand::Input {
                session_id: session_id.to_owned(),
                data,
            }
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon input response: {:?}",
            other
        ))),
    }
}

pub(super) async fn resize_daemon_session(
    context: &ListenerContext,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), RuntimeError> {
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Resize {
            session_id: session_id.to_owned(),
            cols,
            rows,
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon resize response: {:?}",
            other
        ))),
    }
}

pub(super) async fn close_owner_task(
    context: &ListenerContext,
    task_id: &str,
) -> Result<(), RuntimeError> {
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    post_local_kanna_task_action(port, task_id, "close", &serde_json::json!({})).await
}

pub(super) async fn advance_owner_task_stage(
    context: &ListenerContext,
    task_id: &str,
    expected_transition_revision: Option<&str>,
) -> Result<(), RuntimeError> {
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    let body = expected_transition_revision
        .map(|revision| {
            serde_json::json!({
                "expectedTransitionRevision": revision,
            })
        })
        .unwrap_or_else(|| serde_json::json!({}));
    post_local_kanna_task_action(port, task_id, "advance-stage", &body).await
}

pub(super) async fn read_owner_task_file(
    context: &ListenerContext,
    task_id: &str,
    path: &str,
) -> Result<(String, String), RuntimeError> {
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    get_local_kanna_task_file(port, task_id, path).await
}

fn percent_encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

async fn get_local_kanna_task_file(
    port: u16,
    task_id: &str,
    path: &str,
) -> Result<(String, String), RuntimeError> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let request_path = format!(
        "/v1/tasks/{}/files/content?path={}",
        percent_encode_query_value(task_id),
        percent_encode_query_value(path),
    );
    let request = format!(
        "GET {request_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n",
    );
    stream.write_all(request.as_bytes()).await?;

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    let read = reader.read_line(&mut status_line).await?;
    if read == 0 {
        return Err(RuntimeError::Protocol(
            "Kanna server closed without a response".into(),
        ));
    }
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| {
            RuntimeError::Protocol(format!("invalid Kanna server response: {status_line}"))
        })?;

    let mut rest = String::new();
    reader.read_to_string(&mut rest).await?;
    let body = rest
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default();

    if !(200..300).contains(&status) {
        return Err(RuntimeError::Protocol(format!(
            "Kanna server task file read failed with HTTP {status}: {body}"
        )));
    }

    let parsed: serde_json::Value = serde_json::from_str(body).map_err(|error| {
        RuntimeError::Protocol(format!("invalid Kanna server task file response: {error}"))
    })?;
    let file_path = parsed
        .get("path")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            RuntimeError::Protocol("Kanna server task file response is missing path".into())
        })?;
    let content = parsed
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            RuntimeError::Protocol("Kanna server task file response is missing content".into())
        })?;
    Ok((file_path.to_owned(), content.to_owned()))
}

pub(super) async fn mark_owner_task_read(
    context: &ListenerContext,
    task_id: &str,
    expected_activity_revision: i64,
) -> Result<(), RuntimeError> {
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    post_local_kanna_task_action(
        port,
        task_id,
        "mark-read",
        &serde_json::json!({ "expectedActivityRevision": expected_activity_revision }),
    )
    .await
}

async fn post_local_kanna_task_action(
    port: u16,
    task_id: &str,
    action: &str,
    payload: &serde_json::Value,
) -> Result<(), RuntimeError> {
    let encoded_task_id = encode_task_id_path_segment(task_id)?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let path = format!("/v1/tasks/{encoded_task_id}/actions/{action}");
    let body = serde_json::to_string(payload)?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(request.as_bytes()).await?;

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    let read = reader.read_line(&mut status_line).await?;
    if read == 0 {
        return Err(RuntimeError::Protocol(
            "Kanna server closed without a response".into(),
        ));
    }
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| {
            RuntimeError::Protocol(format!("invalid Kanna server response: {status_line}"))
        })?;
    if (200..300).contains(&status) {
        return Ok(());
    }

    let mut response = String::new();
    reader.read_to_string(&mut response).await?;
    Err(RuntimeError::Protocol(format!(
        "Kanna server task action failed with HTTP {status}: {response}"
    )))
}

fn encode_task_id_path_segment(task_id: &str) -> Result<String, RuntimeError> {
    if task_id.len() > 1024 {
        return Err(RuntimeError::Protocol(format!(
            "task ID exceeds 1024 UTF-8 bytes (received {})",
            task_id.len()
        )));
    }
    if task_id.bytes().any(|byte| byte <= 0x1f || byte == 0x7f) {
        return Err(RuntimeError::Protocol(
            "task ID contains an ASCII control character".into(),
        ));
    }

    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(task_id.len());
    for byte in task_id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    Ok(encoded)
}

pub(super) async fn stream_daemon_session(
    daemon: DaemonConnection,
    stream: TcpStream,
    session_id: String,
    initial_snapshot: kanna_daemon::protocol::TerminalSnapshot,
) -> Result<(), RuntimeError> {
    const MAX_TERMINAL_CONTROL_LINE_BYTES: usize = 64 * 1024;
    const MAX_TERMINAL_INPUT_BYTES: usize = 4 * 1024;
    let (peer_read_half, mut peer_write_half) = stream.into_split();
    let mut peer_lines = CancellableBoundedLineReader::new(BufReader::new(peer_read_half));
    let mut daemon_lines = daemon.reader.lines();
    let mut daemon_writer = daemon.writer;

    // The cutover snapshot from ObserveSnapshot is forwarded first; the
    // daemon guarantees every Output on this connection is ordered after it.
    write_json_line(
        &mut peer_write_half,
        &PeerTerminalEvent::Snapshot {
            session_id: session_id.clone(),
            snapshot: serde_json::to_value(initial_snapshot)?,
        },
    )
    .await?;

    loop {
        tokio::select! {
            daemon_line = daemon_lines.next_line() => {
                let Some(daemon_line) = daemon_line? else {
                    return Err(RuntimeError::Protocol("daemon closed observer stream".into()));
                };
                let event: DaemonEvent = serde_json::from_str(&daemon_line)?;
                if forward_daemon_terminal_event(
                    &mut peer_write_half,
                    &session_id,
                    event,
                ).await? {
                    return Ok(());
                }
            }
            control_line = peer_lines.next_line(
                MAX_TERMINAL_CONTROL_LINE_BYTES,
                "terminal control",
            ) => {
                let Some(control_line) = control_line? else {
                    return Ok(());
                };
                let control: PeerTerminalControl = serde_json::from_str(&control_line)?;
                apply_peer_terminal_control(
                    &mut daemon_writer,
                    &session_id,
                    control,
                    MAX_TERMINAL_INPUT_BYTES,
                ).await?;
            }
        }
    }
}

async fn forward_daemon_terminal_event<W>(
    peer_writer: &mut W,
    session_id: &str,
    event: DaemonEvent,
) -> Result<bool, RuntimeError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let (event, finished) = match event {
        DaemonEvent::Snapshot {
            session_id: event_session_id,
            snapshot,
            ..
        } if event_session_id == session_id => (
            Some(PeerTerminalEvent::Snapshot {
                session_id: event_session_id,
                snapshot: serde_json::to_value(snapshot)?,
            }),
            false,
        ),
        DaemonEvent::Output {
            session_id: event_session_id,
            data,
        } if event_session_id == session_id => (
            Some(PeerTerminalEvent::Output {
                session_id: event_session_id,
                data,
            }),
            false,
        ),
        DaemonEvent::Exit {
            session_id: event_session_id,
            code,
            ..
        } if event_session_id == session_id => (
            Some(PeerTerminalEvent::Exit {
                session_id: event_session_id,
                code,
            }),
            true,
        ),
        DaemonEvent::Error { message, .. } => (
            Some(PeerTerminalEvent::Error {
                session_id: session_id.to_owned(),
                message,
            }),
            true,
        ),
        _ => (None, false),
    };
    if let Some(event) = event {
        write_json_line(peer_writer, &event).await?;
    }
    Ok(finished)
}

async fn apply_peer_terminal_control<W>(
    daemon_writer: &mut W,
    session_id: &str,
    control: PeerTerminalControl,
    max_input_bytes: usize,
) -> Result<(), RuntimeError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let command = match control {
        PeerTerminalControl::Input {
            session_id: control_session_id,
            data,
            submission_boundary,
            control_input,
        } if control_session_id == session_id => {
            if data.len() > max_input_bytes {
                return Err(RuntimeError::Protocol(format!(
                    "terminal input exceeds {max_input_bytes} bytes"
                )));
            }
            if control_input {
                DaemonCommand::InputControlNoReply {
                    session_id: control_session_id,
                    data,
                }
            } else if submission_boundary {
                DaemonCommand::InputBoundaryNoReply {
                    session_id: control_session_id,
                    data,
                }
            } else {
                DaemonCommand::InputNoReply {
                    session_id: control_session_id,
                    data,
                }
            }
        }
        PeerTerminalControl::Resize {
            session_id: control_session_id,
            cols,
            rows,
        } if control_session_id == session_id => DaemonCommand::ResizeNoReply {
            session_id: control_session_id,
            cols,
            rows,
        },
        _ => {
            return Err(RuntimeError::Protocol(
                "terminal control session does not match observation".into(),
            ));
        }
    };
    write_daemon_command(daemon_writer, &command).await
}

async fn write_daemon_command<W>(
    writer: &mut W,
    command: &DaemonCommand,
) -> Result<(), RuntimeError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let encoded = serde_json::to_vec(command)?;
    writer.write_all(&encoded).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

async fn connect_daemon(daemon_dir: &Path) -> Result<DaemonConnection, RuntimeError> {
    let stream = UnixStream::connect(kanna_runtime_defaults::socket_path(daemon_dir)).await?;
    let (read_half, write_half) = stream.into_split();
    Ok(DaemonConnection {
        reader: BufReader::new(read_half),
        writer: write_half,
    })
}

async fn send_daemon_command(
    daemon: &mut DaemonConnection,
    command: &DaemonCommand,
) -> Result<(), RuntimeError> {
    write_daemon_command(&mut daemon.writer, command).await
}

async fn read_daemon_event(daemon: &mut DaemonConnection) -> Result<DaemonEvent, RuntimeError> {
    let mut line = String::new();
    let read = daemon.reader.read_line(&mut line).await?;
    if read == 0 {
        return Err(RuntimeError::Protocol(
            "daemon closed observer stream".into(),
        ));
    }
    Ok(serde_json::from_str(line.trim())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_daemon::protocol::TerminalSnapshot;
    use tokio::io::duplex;
    use tokio::net::{TcpListener, UnixListener};

    fn terminal_snapshot(vt: &str) -> TerminalSnapshot {
        TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: vt.to_string(),
        }
    }

    #[tokio::test]
    async fn bounded_control_reader_retains_partial_line_when_select_cancels_read() {
        let (mut writer, reader) = duplex(64);
        let mut reader = CancellableBoundedLineReader::new(BufReader::new(reader));
        writer.write_all(b"{\"type\":\"in").await.unwrap();

        let timed_out = tokio::time::timeout(
            std::time::Duration::from_millis(10),
            reader.next_line(64, "test control"),
        )
        .await;
        assert!(timed_out.is_err(), "partial line unexpectedly completed");

        writer.write_all(b"put\"}\n").await.unwrap();
        assert_eq!(
            reader.next_line(64, "test control").await.unwrap(),
            Some("{\"type\":\"input\"}".to_string())
        );
    }

    /// The atomic cutover snapshot remains first while protocol-v4 input and
    /// resize controls travel back over that same stream in FIFO order.
    #[tokio::test]
    async fn observer_stream_is_duplex_and_preserves_snapshot_output_order() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "task-transfer-duplex-observe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");

        let fake_daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut lines = BufReader::new(read_half).lines();
            let observe_line = lines
                .next_line()
                .await
                .expect("read observe result")
                .expect("observe command");
            assert!(observe_line.contains("ObserveSnapshot"));
            let snapshot = DaemonEvent::Snapshot {
                session_id: "sess-duplex".to_string(),
                snapshot: terminal_snapshot("READY"),
                agent_provider: None,
            };
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&snapshot).unwrap()).as_bytes())
                .await
                .expect("write snapshot");

            let input_line = lines
                .next_line()
                .await
                .expect("read input result")
                .expect("input command");
            let input: DaemonCommand = serde_json::from_str(&input_line).expect("parse input");
            match input {
                DaemonCommand::InputNoReply { session_id, data } => {
                    assert_eq!(session_id, "sess-duplex");
                    assert_eq!(data, b"abc\x7f");
                }
                other => panic!("expected InputNoReply, got {other:?}"),
            }

            let resize_line = lines
                .next_line()
                .await
                .expect("read resize result")
                .expect("resize command");
            let resize: DaemonCommand = serde_json::from_str(&resize_line).expect("parse resize");
            match resize {
                DaemonCommand::ResizeNoReply {
                    session_id,
                    cols,
                    rows,
                } => {
                    assert_eq!(session_id, "sess-duplex");
                    assert_eq!(cols, 120);
                    assert_eq!(rows, 36);
                }
                other => panic!("expected ResizeNoReply, got {other:?}"),
            }

            for event in [
                DaemonEvent::Output {
                    session_id: "sess-duplex".to_string(),
                    data: b"abc\x08 \x08".to_vec(),
                },
                DaemonEvent::Exit {
                    session_id: "sess-duplex".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            ] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .expect("write daemon event");
            }
        });

        let mut daemon = connect_daemon(&daemon_dir).await.expect("connect daemon");
        let snapshot = observe_session_snapshot(&mut daemon, "sess-duplex")
            .await
            .expect("observe snapshot");

        let tcp = TcpListener::bind("127.0.0.1:0").await.expect("bind peer");
        let addr = tcp.local_addr().expect("local addr");
        let peer = tokio::spawn(async move {
            let (stream, _) = tcp.accept().await.expect("accept peer stream");
            let (read_half, mut write_half) = stream.into_split();
            let mut lines = BufReader::new(read_half).lines();
            let snapshot_line = lines
                .next_line()
                .await
                .expect("read snapshot result")
                .expect("snapshot event");
            let snapshot: serde_json::Value = serde_json::from_str(&snapshot_line).unwrap();
            assert_eq!(snapshot["type"], "snapshot");
            assert_eq!(snapshot["snapshot"]["vt"], "READY");

            for control in [
                PeerTerminalControl::Input {
                    session_id: "sess-duplex".to_string(),
                    data: b"abc\x7f".to_vec(),
                    submission_boundary: false,
                    control_input: false,
                },
                PeerTerminalControl::Resize {
                    session_id: "sess-duplex".to_string(),
                    cols: 120,
                    rows: 36,
                },
            ] {
                write_json_line(&mut write_half, &control)
                    .await
                    .expect("write terminal control");
            }

            let mut event_types = Vec::new();
            while let Some(line) = lines.next_line().await.expect("read peer event") {
                let event: serde_json::Value = serde_json::from_str(&line).expect("parse event");
                event_types.push(event["type"].as_str().unwrap().to_string());
            }
            event_types
        });
        let peer_stream = TcpStream::connect(addr).await.expect("connect peer");

        stream_daemon_session(daemon, peer_stream, "sess-duplex".to_string(), snapshot)
            .await
            .expect("stream duplex session");
        fake_daemon.await.expect("fake daemon");
        assert_eq!(peer.await.expect("peer task"), ["output", "exit"]);

        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    async fn spawn_fake_kanna_server(
        status_line: &'static str,
        body: &'static str,
    ) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake kanna server");
        let port = listener.local_addr().expect("local addr").port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut request_line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                reader
                    .read_line(&mut request_line)
                    .await
                    .expect("read request line");
            }
            let response = format!(
                "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            request_line
        });
        (port, handle)
    }

    /// The owner-side file read percent-encodes the query, parses the JSON
    /// body, and returns the served path and content.
    #[tokio::test]
    async fn local_kanna_task_file_read_parses_response_body() {
        let (port, request) = spawn_fake_kanna_server(
            "HTTP/1.1 200 OK",
            r#"{"path":"src dir/app.ts","content":"remote body"}"#,
        )
        .await;

        let (path, content) = get_local_kanna_task_file(port, "task-1", "src dir/app.ts")
            .await
            .expect("read task file");
        assert_eq!(path, "src dir/app.ts");
        assert_eq!(content, "remote body");

        let request_line = request.await.expect("request line");
        assert!(
            request_line
                .starts_with("GET /v1/tasks/task-1/files/content?path=src%20dir%2Fapp.ts HTTP/1.1"),
            "unexpected request line: {request_line:?}"
        );
    }

    /// Non-2xx responses surface the status and body as a protocol error
    /// instead of being parsed as file content.
    #[tokio::test]
    async fn local_kanna_task_file_read_reports_http_errors() {
        let (port, _request) =
            spawn_fake_kanna_server("HTTP/1.1 404 Not Found", r#"{"error":"file not found"}"#)
                .await;

        let error = get_local_kanna_task_file(port, "task-1", "missing.ts")
            .await
            .expect_err("expected http error");
        let message = error.to_string();
        assert!(
            message.contains("HTTP 404") && message.contains("file not found"),
            "unexpected error: {message}"
        );
    }
}
