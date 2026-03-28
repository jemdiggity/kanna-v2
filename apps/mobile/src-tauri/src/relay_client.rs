use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
pub type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

/// Shared WebSocket sink for sending messages to the relay.
pub type RelaySink = Arc<Mutex<Option<WsSink>>>;

/// Map of pending request IDs to oneshot senders awaiting responses.
pub type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>>;

/// Messages exchanged with the relay server.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RelayMessage {
    #[serde(rename = "auth")]
    Auth { id_token: String },
    #[serde(rename = "auth_ok")]
    AuthOk,
    #[serde(rename = "invoke")]
    Invoke {
        id: u64,
        command: String,
        args: serde_json::Value,
    },
    #[serde(rename = "response")]
    Response {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "event")]
    Event {
        name: String,
        payload: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Connect to the relay WebSocket server and start the reader task.
///
/// 1. Opens a WebSocket connection to `relay_url`.
/// 2. Sends an auth message with the user's `id_token`.
/// 3. Waits for an `auth_ok` response.
/// 4. Stores the sink in `RelaySink` state so commands can send messages.
/// 5. Spawns a reader task that routes responses to pending request channels
///    and emits push events as Tauri events.
pub async fn connect(
    app: &tauri::AppHandle,
    relay: &RelaySink,
    pending: &PendingRequests,
    relay_url: &str,
    id_token: &str,
) -> Result<(), String> {
    // Connect to relay WebSocket
    let (ws_stream, _response) = connect_async(relay_url)
        .await
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    let (mut sink, mut stream) = ws_stream.split();

    // Send auth message
    let auth = RelayMessage::Auth {
        id_token: id_token.to_string(),
    };
    let auth_json =
        serde_json::to_string(&auth).map_err(|e| format!("Failed to serialize auth: {}", e))?;
    sink.send(Message::Text(auth_json.into()))
        .await
        .map_err(|e| format!("Failed to send auth: {}", e))?;

    // Wait for auth_ok
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => {
                let parsed: RelayMessage = serde_json::from_str(&text)
                    .map_err(|e| format!("Failed to parse auth response: {}", e))?;
                match parsed {
                    RelayMessage::AuthOk => {
                        log::info!("Relay authentication successful");
                        break;
                    }
                    RelayMessage::Error { message } => {
                        return Err(format!("Relay auth error: {}", message));
                    }
                    _ => {
                        log::warn!("Unexpected message during auth: {:?}", parsed);
                        continue;
                    }
                }
            }
            Some(Ok(_)) => continue, // Ignore ping/pong during auth
            Some(Err(e)) => return Err(format!("WebSocket error during auth: {}", e)),
            None => return Err("WebSocket closed during auth".to_string()),
        }
    }

    // Store the sink for sending commands
    *relay.lock().await = Some(sink);

    // Spawn reader task to handle incoming messages
    let pending_clone = Arc::clone(pending);
    let app_clone = app.clone();
    tokio::spawn(async move {
        reader_loop(&mut stream, &pending_clone, &app_clone).await;
        log::info!("Relay reader task exited");
    });

    Ok(())
}

/// Background task that reads messages from the relay WebSocket.
///
/// - `response` messages are routed to the pending request's oneshot channel.
/// - `event` messages are emitted as Tauri events so the frontend can handle them.
async fn reader_loop(
    stream: &mut WsStream,
    pending: &PendingRequests,
    app: &tauri::AppHandle,
) {
    use tauri::Emitter;

    while let Some(msg_result) = stream.next().await {
        let msg = match msg_result {
            Ok(m) => m,
            Err(e) => {
                log::error!("Relay WebSocket read error: {}", e);
                break;
            }
        };

        match msg {
            Message::Text(text) => {
                let parsed: RelayMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        log::warn!("Failed to parse relay message: {} — raw: {}", e, text);
                        continue;
                    }
                };

                match parsed {
                    RelayMessage::Response { id, data, error } => {
                        let result = match error {
                            Some(e) => Err(e),
                            None => Ok(data.unwrap_or(serde_json::Value::Null)),
                        };
                        let mut map = pending.lock().await;
                        if let Some(tx) = map.remove(&id) {
                            let _ = tx.send(result);
                        } else {
                            log::warn!("Received response for unknown request id: {}", id);
                        }
                    }
                    RelayMessage::Event { name, payload } => {
                        if let Err(e) = app.emit(&name, &payload) {
                            log::error!("Failed to emit Tauri event '{}': {}", name, e);
                        }
                    }
                    RelayMessage::Error { message } => {
                        log::error!("Relay error: {}", message);
                    }
                    _ => {
                        log::warn!("Unexpected relay message in reader: {:?}", parsed);
                    }
                }
            }
            Message::Ping(_) => {
                // tungstenite handles pong automatically
            }
            Message::Close(_) => {
                log::info!("Relay connection closed by server");
                break;
            }
            _ => {}
        }
    }
}
