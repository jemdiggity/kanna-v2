use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
pub type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RelayMessage {
    #[serde(rename = "auth")]
    Auth { device_token: String },
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

pub async fn connect_to_relay(
    relay_url: &str,
    device_token: &str,
) -> Result<(WsSink, WsStream), Box<dyn std::error::Error>> {
    let (ws_stream, _response) = connect_async(relay_url).await?;
    let (mut sink, stream) = ws_stream.split();

    // Send auth message immediately after connecting
    let auth = RelayMessage::Auth {
        device_token: device_token.to_string(),
    };
    let auth_json = serde_json::to_string(&auth)?;
    sink.send(Message::Text(auth_json.into())).await?;

    log::info!("Authenticated with relay");

    Ok((sink, stream))
}
