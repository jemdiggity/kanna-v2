use super::events::{RuntimeError, RuntimeEvent};
use super::state::ListenerContext;
use super::utils::{
    ensure_peer_is_trusted_for, parse_peer_response_line, parse_peer_terminal_event_line,
    peer_terminal_event_session_id, unexpected_peer_response, write_json_line,
};
use crate::protocol::{PeerRegistryEntry, PeerRequest, PeerResponse, PeerTerminalEvent};
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
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

    let mut response_line = String::new();
    {
        let mut reader = BufReader::new(&mut stream);
        let read = reader.read_line(&mut response_line).await?;
        if read == 0 {
            return Err(RuntimeError::Protocol(format!(
                "peer {} closed observe-session before response",
                peer.peer_id
            )));
        }
    }

    match parse_peer_response_line(&peer.peer_id, "observe-session", &response_line)? {
        PeerResponse::ObserveSession {
            request_id: response_request_id,
            session_id: response_session_id,
        } if response_request_id == request_id && response_session_id == session_id => {}
        PeerResponse::Error { message, .. } => return Err(RuntimeError::Protocol(message)),
        other => return Err(unexpected_peer_response("observe-session", &other)),
    }

    let mut reader = BufReader::new(stream);
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
                event,
            })
            .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
    }
}

pub(super) async fn prepare_session_observer(
    context: &ListenerContext,
    requester_peer_id: &str,
    session_id: &str,
) -> Result<DaemonConnection, RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;

    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Observe {
            session_id: session_id.to_owned(),
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(daemon),
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
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    post_local_kanna_task_action(port, task_id, "advance-stage").await
}

async fn post_local_kanna_task_action(
    port: u16,
    task_id: &str,
    action: &str,
) -> Result<(), RuntimeError> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let path = format!("/v1/tasks/{task_id}/actions/{action}");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
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
             SET previous_stage = COALESCE(previous_stage, stage),
                 stage = 'done',
                 closed_at = datetime('now'),
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
) -> Result<(), RuntimeError> {
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Snapshot {
            session_id: session_id.clone(),
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
    let stream = UnixStream::connect(daemon_socket_path(daemon_dir)).await?;
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

fn daemon_socket_path(daemon_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    daemon_dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}
