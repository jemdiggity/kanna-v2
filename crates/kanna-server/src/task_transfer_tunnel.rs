use crate::relay_client::{RelayMessage, TunnelService};
use futures_util::{SinkExt, StreamExt};
use std::fmt;
use std::net::{Ipv4Addr, SocketAddr};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::WebSocketStream;

#[derive(Debug)]
pub(crate) enum TunnelError {
    Io(std::io::Error),
    WebSocket(tungstenite::Error),
    MissingReadyFrame,
    InvalidReadyFrame(String),
    UnexpectedTunnelId { expected: String, actual: String },
    UnexpectedService { actual: TunnelService },
    UnexpectedTextFrame,
    UnexpectedFrame,
}

impl fmt::Display for TunnelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "task-transfer tunnel I/O failed: {error}"),
            Self::WebSocket(error) => {
                write!(formatter, "task-transfer tunnel WebSocket failed: {error}")
            }
            Self::MissingReadyFrame => formatter.write_str("relay closed before tunnel_ready"),
            Self::InvalidReadyFrame(error) => {
                write!(
                    formatter,
                    "invalid task-transfer tunnel_ready frame: {error}"
                )
            }
            Self::UnexpectedTunnelId { expected, actual } => write!(
                formatter,
                "task-transfer tunnel_ready id mismatch: expected {expected}, got {actual}"
            ),
            Self::UnexpectedService { actual } => write!(
                formatter,
                "task-transfer tunnel_ready service mismatch: got {actual:?}"
            ),
            Self::UnexpectedTextFrame => {
                formatter.write_str("unexpected text frame in task-transfer tunnel")
            }
            Self::UnexpectedFrame => {
                formatter.write_str("unexpected WebSocket frame in task-transfer tunnel")
            }
        }
    }
}

impl std::error::Error for TunnelError {}

impl From<std::io::Error> for TunnelError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<tungstenite::Error> for TunnelError {
    fn from(error: tungstenite::Error) -> Self {
        Self::WebSocket(error)
    }
}

pub(crate) async fn bridge_task_transfer_tunnel<S>(
    mut websocket: WebSocketStream<S>,
    transfer_port: u16,
    expected_tunnel_id: String,
) -> Result<(), TunnelError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    validate_ready_frame(&mut websocket, &expected_tunnel_id).await?;

    let transfer_address = SocketAddr::from((Ipv4Addr::LOCALHOST, transfer_port));
    let mut sidecar = TcpStream::connect(transfer_address).await?;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        tokio::select! {
            read = sidecar.read(&mut buffer) => {
                let count = read?;
                if count == 0 {
                    break;
                }
                websocket
                    .send(Message::Binary(buffer[..count].to_vec().into()))
                    .await?;
            }
            frame = websocket.next() => {
                match frame.transpose()? {
                    Some(Message::Binary(bytes)) => sidecar.write_all(&bytes).await?,
                    Some(Message::Close(_)) | None => break,
                    Some(Message::Ping(bytes)) => websocket.send(Message::Pong(bytes)).await?,
                    Some(Message::Pong(_)) => {}
                    Some(Message::Text(_)) => return Err(TunnelError::UnexpectedTextFrame),
                    Some(Message::Frame(_)) => return Err(TunnelError::UnexpectedFrame),
                }
            }
        }
    }

    Ok(())
}

async fn validate_ready_frame<S>(
    websocket: &mut WebSocketStream<S>,
    expected_tunnel_id: &str,
) -> Result<(), TunnelError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let frame = websocket
        .next()
        .await
        .ok_or(TunnelError::MissingReadyFrame)??;
    let Message::Text(text) = frame else {
        return Err(TunnelError::InvalidReadyFrame(
            "expected text control frame".to_string(),
        ));
    };
    let ready = serde_json::from_str::<RelayMessage>(&text)
        .map_err(|error| TunnelError::InvalidReadyFrame(error.to_string()))?;
    let RelayMessage::TunnelReady {
        tunnel_id, service, ..
    } = ready
    else {
        return Err(TunnelError::InvalidReadyFrame(
            "expected tunnel_ready message".to_string(),
        ));
    };
    if tunnel_id != expected_tunnel_id {
        return Err(TunnelError::UnexpectedTunnelId {
            expected: expected_tunnel_id.to_string(),
            actual: tunnel_id,
        });
    }
    if service != TunnelService::TaskTransfer {
        return Err(TunnelError::UnexpectedService { actual: service });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::{timeout, Duration};
    use tokio_tungstenite::tungstenite::{protocol::Role, Message};
    use tokio_tungstenite::WebSocketStream;

    async fn websocket_pair() -> (
        WebSocketStream<tokio::io::DuplexStream>,
        WebSocketStream<tokio::io::DuplexStream>,
    ) {
        let (client_io, desktop_io) = tokio::io::duplex(256 * 1024);
        tokio::join!(
            WebSocketStream::from_raw_socket(client_io, Role::Client, None),
            WebSocketStream::from_raw_socket(desktop_io, Role::Server, None),
        )
    }

    async fn loopback_listener() -> (TcpListener, u16) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind transfer sidecar");
        let port = listener.local_addr().expect("sidecar address").port();
        (listener, port)
    }

    async fn send_ready(
        socket: &mut WebSocketStream<tokio::io::DuplexStream>,
        tunnel_id: &str,
        service: &str,
    ) {
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "tunnel_ready",
                    "desktopId": "desktop-destination",
                    "tunnelId": tunnel_id,
                    "service": service,
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send tunnel ready");
    }

    async fn accept_sidecar(listener: &TcpListener) -> TcpStream {
        timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("bridge did not connect to transfer sidecar")
            .expect("accept transfer sidecar")
            .0
    }

    #[tokio::test]
    async fn task_transfer_tunnel_bridges_binary_frames_and_tcp_bytes() {
        let (transfer_listener, transfer_port) = loopback_listener().await;
        let (mut client_ws, desktop_ws) = websocket_pair().await;
        let bridge = tokio::spawn(super::bridge_task_transfer_tunnel(
            desktop_ws,
            transfer_port,
            "tunnel-1".to_string(),
        ));

        send_ready(&mut client_ws, "tunnel-1", "task-transfer").await;
        let mut sidecar_socket = accept_sidecar(&transfer_listener).await;

        client_ws
            .send(Message::Binary(b"source\n".to_vec().into()))
            .await
            .expect("send source bytes");
        let mut source = [0_u8; 7];
        sidecar_socket
            .read_exact(&mut source)
            .await
            .expect("read source bytes");
        assert_eq!(&source, b"source\n");

        sidecar_socket
            .write_all(b"destination\n")
            .await
            .expect("send destination bytes");
        let destination = timeout(Duration::from_secs(2), client_ws.next())
            .await
            .expect("bridge did not return destination bytes")
            .expect("websocket closed")
            .expect("websocket frame");
        assert_eq!(
            destination,
            Message::Binary(b"destination\n".to_vec().into())
        );

        client_ws.close(None).await.expect("close source websocket");
        bridge
            .await
            .expect("bridge task panicked")
            .expect("bridge failed");
    }

    #[tokio::test]
    async fn task_transfer_tunnel_rejects_wrong_tunnel_id_before_connecting_sidecar() {
        let (transfer_listener, transfer_port) = loopback_listener().await;
        let (mut client_ws, desktop_ws) = websocket_pair().await;
        let bridge = tokio::spawn(super::bridge_task_transfer_tunnel(
            desktop_ws,
            transfer_port,
            "expected-tunnel".to_string(),
        ));

        send_ready(&mut client_ws, "other-tunnel", "task-transfer").await;

        let error = bridge
            .await
            .expect("bridge task panicked")
            .expect_err("wrong tunnel id must fail");
        assert!(matches!(
            error,
            super::TunnelError::UnexpectedTunnelId { .. }
        ));
        assert!(
            timeout(Duration::from_millis(100), transfer_listener.accept())
                .await
                .is_err(),
            "bridge connected before validating tunnel id"
        );
    }

    #[tokio::test]
    async fn task_transfer_tunnel_rejects_wrong_service_before_connecting_sidecar() {
        let (transfer_listener, transfer_port) = loopback_listener().await;
        let (mut client_ws, desktop_ws) = websocket_pair().await;
        let bridge = tokio::spawn(super::bridge_task_transfer_tunnel(
            desktop_ws,
            transfer_port,
            "tunnel-1".to_string(),
        ));

        send_ready(&mut client_ws, "tunnel-1", "ksp").await;

        let error = bridge
            .await
            .expect("bridge task panicked")
            .expect_err("wrong service must fail");
        assert!(matches!(
            error,
            super::TunnelError::UnexpectedService { .. }
        ));
        assert!(
            timeout(Duration::from_millis(100), transfer_listener.accept())
                .await
                .is_err(),
            "bridge connected before validating tunnel service"
        );
    }

    #[tokio::test]
    async fn task_transfer_tunnel_rejects_text_after_ready() {
        let (transfer_listener, transfer_port) = loopback_listener().await;
        let (mut client_ws, desktop_ws) = websocket_pair().await;
        let bridge = tokio::spawn(super::bridge_task_transfer_tunnel(
            desktop_ws,
            transfer_port,
            "tunnel-1".to_string(),
        ));

        send_ready(&mut client_ws, "tunnel-1", "task-transfer").await;
        let _sidecar_socket = accept_sidecar(&transfer_listener).await;
        client_ws
            .send(Message::Text("not transfer bytes".into()))
            .await
            .expect("send invalid text frame");

        let error = bridge
            .await
            .expect("bridge task panicked")
            .expect_err("text data frame must fail");
        assert!(matches!(error, super::TunnelError::UnexpectedTextFrame));
    }

    #[tokio::test]
    async fn task_transfer_tunnel_answers_ping_and_closes_cleanly() {
        let (transfer_listener, transfer_port) = loopback_listener().await;
        let (mut client_ws, desktop_ws) = websocket_pair().await;
        let bridge = tokio::spawn(super::bridge_task_transfer_tunnel(
            desktop_ws,
            transfer_port,
            "tunnel-1".to_string(),
        ));

        send_ready(&mut client_ws, "tunnel-1", "task-transfer").await;
        let _sidecar_socket = accept_sidecar(&transfer_listener).await;
        client_ws
            .send(Message::Ping(b"alive".to_vec().into()))
            .await
            .expect("send ping");

        let pong = timeout(Duration::from_secs(2), client_ws.next())
            .await
            .expect("bridge did not answer ping")
            .expect("websocket closed")
            .expect("websocket frame");
        assert_eq!(pong, Message::Pong(b"alive".to_vec().into()));

        client_ws.close(None).await.expect("close websocket");
        bridge
            .await
            .expect("bridge task panicked")
            .expect("bridge close failed");
    }
}
