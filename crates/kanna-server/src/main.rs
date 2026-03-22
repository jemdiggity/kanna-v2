mod commands;
mod config;
mod daemon_client;
mod db;
mod relay_client;

use config::Config;
use futures_util::{SinkExt, StreamExt};
use relay_client::RelayMessage;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("register") {
        eprintln!("Registration not yet implemented");
        std::process::exit(1);
    }

    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    log::info!("kanna-server starting, relay: {}", config.relay_url);

    let db = match db::Db::open(&config.db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to open database at {}: {}", config.db_path, e);
            std::process::exit(1);
        }
    };

    log::info!("Database opened: {}", config.db_path);

    // Reconnection loop
    loop {
        log::info!("Connecting to relay at {}...", config.relay_url);

        let (mut sink, mut stream) =
            match relay_client::connect_to_relay(&config.relay_url, &config.device_token).await {
                Ok(pair) => pair,
                Err(e) => {
                    log::error!("Failed to connect to relay: {}", e);
                    log::info!("Retrying in 5 seconds...");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };

        log::info!("Connected to relay");

        // Message processing loop
        while let Some(msg_result) = stream.next().await {
            let msg = match msg_result {
                Ok(m) => m,
                Err(e) => {
                    log::error!("WebSocket error: {}", e);
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
                        RelayMessage::Invoke { id, command, args } => {
                            log::info!("Invoke #{}: {}", id, command);

                            // Connect to daemon for each invoke (short-lived connection)
                            let daemon_result =
                                daemon_client::DaemonClient::connect(&config.daemon_dir).await;

                            let response = match daemon_result {
                                Ok(mut daemon) => {
                                    match commands::handle_invoke(&command, &args, &db, &mut daemon)
                                        .await
                                    {
                                        Ok(data) => RelayMessage::Response {
                                            id,
                                            data: Some(data),
                                            error: None,
                                        },
                                        Err(e) => {
                                            log::error!("Invoke #{} error: {}", id, e);
                                            RelayMessage::Response {
                                                id,
                                                data: None,
                                                error: Some(e),
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!(
                                        "Failed to connect to daemon for invoke #{}: {}",
                                        id,
                                        e
                                    );
                                    RelayMessage::Response {
                                        id,
                                        data: None,
                                        error: Some(format!("daemon connection failed: {}", e)),
                                    }
                                }
                            };

                            let response_json = match serde_json::to_string(&response) {
                                Ok(j) => j,
                                Err(e) => {
                                    log::error!("Failed to serialize response: {}", e);
                                    continue;
                                }
                            };

                            if let Err(e) = sink.send(Message::Text(response_json.into())).await {
                                log::error!("Failed to send response: {}", e);
                                break;
                            }
                        }
                        RelayMessage::Error { message } => {
                            log::error!("Relay error: {}", message);
                        }
                        other => {
                            log::warn!("Unexpected relay message: {:?}", other);
                        }
                    }
                }
                Message::Ping(data) => {
                    if let Err(e) = sink.send(Message::Pong(data)).await {
                        log::error!("Failed to send pong: {}", e);
                        break;
                    }
                }
                Message::Close(_) => {
                    log::info!("Relay closed connection");
                    break;
                }
                _ => {}
            }
        }

        log::info!("Disconnected from relay. Reconnecting in 5 seconds...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
