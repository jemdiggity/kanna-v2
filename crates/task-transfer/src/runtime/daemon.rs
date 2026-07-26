use super::events::{RuntimeError, RuntimeEvent};
use super::state::ListenerContext;
use super::utils::{
    ensure_peer_is_trusted_for, parse_peer_response_line, parse_peer_terminal_event_line,
    peer_terminal_event_session_id, unexpected_peer_response, write_json_line,
};
use crate::protocol::{PeerRegistryEntry, PeerRequest, PeerResponse, PeerTerminalEvent};
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixStream};
use tokio::sync::mpsc;

pub(super) struct DaemonConnection {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

pub(super) async fn stream_peer_session(
    peer: PeerRegistryEntry,
    request_id: String,
    requester_peer_id: String,
    session_id: String,
    observer_lease_id: String,
    incoming_sender: mpsc::UnboundedSender<RuntimeEvent>,
) -> Result<(), RuntimeError> {
    let mut stream = TcpStream::connect(&peer.endpoint).await?;
    write_json_line(
        &mut stream,
        &PeerRequest::ObserveSession {
            request_id: request_id.clone(),
            requester_peer_id,
            session_id: session_id.clone(),
        },
    )
    .await?;

    let mut reader = BufReader::new(stream);
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

    loop {
        let mut event_line = String::new();
        let read = reader.read_line(&mut event_line).await?;
        if read == 0 {
            return Ok(());
        }
        let event = parse_peer_terminal_event_line(&peer.peer_id, &session_id, &event_line)?;
        let event_session_id = peer_terminal_event_session_id(&event).to_owned();
        incoming_sender
            .send(RuntimeEvent::TerminalEvent {
                peer_id: peer.peer_id.clone(),
                session_id: event_session_id,
                observer_lease_id: observer_lease_id.clone(),
                event,
            })
            .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
    }
}

pub(super) async fn prepare_session_observer(
    context: &ListenerContext,
    requester_peer_id: &str,
    session_id: &str,
) -> Result<(DaemonConnection, kanna_daemon::protocol::TerminalSnapshot), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;

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
        } if event_session_id == session_id => Ok(snapshot),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon observe response: {:?}",
            other
        ))),
    }
}

async fn ensure_requester_peer_trusted(
    context: &ListenerContext,
    requester_peer_id: &str,
) -> Result<(), RuntimeError> {
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
    Ok(())
}

pub(super) async fn send_daemon_input(
    context: &ListenerContext,
    requester_peer_id: &str,
    session_id: &str,
    data: Vec<u8>,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Input {
            session_id: session_id.to_owned(),
            data,
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
    requester_peer_id: &str,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
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
    requester_peer_id: &str,
    task_id: &str,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    for session_id in [
        task_id.to_owned(),
        format!("shell-wt-{task_id}"),
        format!("td-{task_id}"),
    ] {
        kill_daemon_session_if_present(context, &session_id).await?;
    }
    close_pipeline_item_in_db(context, task_id)?;
    Ok(())
}

pub(super) async fn advance_owner_task_stage(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
    expected_transition_revision: Option<&str>,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
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
    requester_peer_id: &str,
    task_id: &str,
    path: &str,
) -> Result<(String, String), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
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
    requester_peer_id: &str,
    task_id: &str,
    expected_activity_revision: i64,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
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

async fn kill_daemon_session_if_present(
    context: &ListenerContext,
    session_id: &str,
) -> Result<(), RuntimeError> {
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Kill {
            session_id: session_id.to_owned(),
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => Ok(()),
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            Ok(())
        }
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon kill response: {:?}",
            other
        ))),
    }
}

fn close_pipeline_item_in_db(context: &ListenerContext, task_id: &str) -> Result<(), RuntimeError> {
    let db_path = context
        .db_path
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("database path is not configured".into()))?;
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|error| RuntimeError::Protocol(format!("db error: {error}")))?;
    let rows = conn
        .execute(
            "UPDATE pipeline_item
             SET closed_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ?",
            [task_id],
        )
        .map_err(|error| RuntimeError::Protocol(format!("db error: {error}")))?;
    if rows == 0 {
        return Err(RuntimeError::Protocol(format!("task not found: {task_id}")));
    }
    Ok(())
}

pub(super) async fn stream_daemon_session(
    mut daemon: DaemonConnection,
    mut stream: TcpStream,
    session_id: String,
    initial_snapshot: kanna_daemon::protocol::TerminalSnapshot,
) -> Result<(), RuntimeError> {
    // The cutover snapshot from ObserveSnapshot is forwarded first; the
    // daemon guarantees every Output on this connection is ordered after it.
    write_json_line(
        &mut stream,
        &PeerTerminalEvent::Snapshot {
            session_id: session_id.clone(),
            snapshot: serde_json::to_value(initial_snapshot)?,
        },
    )
    .await?;

    loop {
        match read_daemon_event(&mut daemon).await? {
            DaemonEvent::Snapshot {
                session_id: event_session_id,
                snapshot,
            } if event_session_id == session_id => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Snapshot {
                        session_id: event_session_id,
                        snapshot: serde_json::to_value(snapshot)?,
                    },
                )
                .await?;
            }
            DaemonEvent::Output {
                session_id: event_session_id,
                data,
            } if event_session_id == session_id => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Output {
                        session_id: event_session_id,
                        data,
                    },
                )
                .await?;
            }
            DaemonEvent::Exit {
                session_id: event_session_id,
                code,
                ..
            } if event_session_id == session_id => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Exit {
                        session_id: event_session_id,
                        code,
                    },
                )
                .await?;
                return Ok(());
            }
            DaemonEvent::Error { message, .. } => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Error {
                        session_id,
                        message,
                    },
                )
                .await?;
                return Ok(());
            }
            _ => {}
        }
    }
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
    let encoded = serde_json::to_vec(command)?;
    daemon.writer.write_all(&encoded).await?;
    daemon.writer.write_all(b"\n").await?;
    daemon.writer.flush().await?;
    Ok(())
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

    /// The observer registers through the atomic ObserveSnapshot cutover and
    /// the peer stream carries the snapshot first, then every later Output
    /// in order, then the exit — nothing forwarded before the snapshot.
    #[tokio::test]
    async fn observer_stream_forwards_cutover_snapshot_before_output() {
        let daemon_dir = std::env::temp_dir().join(format!(
            "task-transfer-observe-{}-{}",
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
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read observe snapshot command");
            assert!(
                line.contains("ObserveSnapshot"),
                "expected ObserveSnapshot command, got {line:?}"
            );

            let events = [
                DaemonEvent::Snapshot {
                    session_id: "sess-transfer".to_string(),
                    snapshot: terminal_snapshot("CUTOVER"),
                },
                DaemonEvent::Output {
                    session_id: "sess-transfer".to_string(),
                    data: b"after-cutover".to_vec(),
                },
                DaemonEvent::Exit {
                    session_id: "sess-transfer".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            ];
            for event in events {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .expect("write daemon event");
            }
        });

        let mut daemon = connect_daemon(&daemon_dir).await.expect("connect daemon");
        let snapshot = observe_session_snapshot(&mut daemon, "sess-transfer")
            .await
            .expect("observe snapshot");
        assert_eq!(snapshot.vt, "CUTOVER");

        let tcp = TcpListener::bind("127.0.0.1:0").await.expect("bind peer");
        let addr = tcp.local_addr().expect("local addr");
        let peer_reader = tokio::spawn(async move {
            let (stream, _) = tcp.accept().await.expect("accept peer stream");
            let mut reader = BufReader::new(stream);
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.expect("read peer line") == 0 {
                    break;
                }
                lines.push(line);
            }
            lines
        });
        let peer_stream = TcpStream::connect(addr).await.expect("connect peer");

        stream_daemon_session(daemon, peer_stream, "sess-transfer".to_string(), snapshot)
            .await
            .expect("stream session");
        fake_daemon.await.expect("fake daemon");
        let lines = peer_reader.await.expect("peer reader");

        let events: Vec<serde_json::Value> = lines
            .iter()
            .map(|line| serde_json::from_str(line.trim()).expect("parse peer event"))
            .collect();
        assert_eq!(events.len(), 3, "peer events: {events:?}");
        assert_eq!(events[0]["type"], "snapshot");
        assert_eq!(events[0]["snapshot"]["vt"], "CUTOVER");
        assert_eq!(events[1]["type"], "output");
        assert_eq!(events[2]["type"], "exit");

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
