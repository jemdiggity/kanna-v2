mod commands;
mod config;
mod daemon_client;
mod db;
mod register;
mod relay_client;

use config::Config;
use futures_util::{SinkExt, StreamExt};
use relay_client::RelayMessage;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("register") {
        let relay_url = args
            .get(2)
            .map(|s| s.as_str())
            .unwrap_or("wss://kanna-relay.run.app");
        if let Err(e) = register::register(relay_url).await {
            eprintln!("Registration failed: {}", e);
            std::process::exit(1);
        }
        return;
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

        let (sink, mut stream) =
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

        // Wrap sink in Arc<Mutex> so observer tasks can share it
        let sink = Arc::new(Mutex::new(sink));

        // Track observer tasks per session_id
        let mut observe_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();

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

                            // Special-case: attach_session needs a long-lived daemon connection
                            if command == "attach_session" {
                                let session_id = match args
                                    .get("session_id")
                                    .and_then(|v| v.as_str())
                                {
                                    Some(s) => s.to_string(),
                                    None => {
                                        send_response(
                                            &sink,
                                            id,
                                            Err("missing required arg: session_id".to_string()),
                                        )
                                        .await;
                                        continue;
                                    }
                                };

                                // Cancel existing observer for this session
                                if let Some(handle) = observe_tasks.remove(&session_id) {
                                    handle.abort();
                                    log::info!(
                                        "Aborted existing observer for session {}",
                                        session_id
                                    );
                                }

                                // Create dedicated daemon connection for observing
                                let mut obs_daemon =
                                    match daemon_client::DaemonClient::connect(&config.daemon_dir)
                                        .await
                                    {
                                        Ok(d) => d,
                                        Err(e) => {
                                            log::error!(
                                                "Failed to connect to daemon for observe: {}",
                                                e
                                            );
                                            send_response(
                                                &sink,
                                                id,
                                                Err(format!("daemon connection failed: {}", e)),
                                            )
                                            .await;
                                            continue;
                                        }
                                    };

                                // Send Observe command
                                use kanna_daemon::protocol::{
                                    Command as DaemonCommand, Event as DaemonEvent,
                                };
                                match obs_daemon
                                    .send_command(&DaemonCommand::Observe {
                                        session_id: session_id.clone(),
                                    })
                                    .await
                                {
                                    Ok(DaemonEvent::Ok) => {
                                        // Send success response
                                        send_response(&sink, id, Ok(serde_json::Value::Null))
                                            .await;

                                        // Spawn background task to forward daemon events
                                        let sink_clone = Arc::clone(&sink);
                                        let sid = session_id.clone();
                                        let handle = tokio::spawn(async move {
                                            observer_loop(obs_daemon, &sid, sink_clone).await;
                                        });
                                        observe_tasks.insert(session_id, handle);
                                    }
                                    Ok(DaemonEvent::Error { message }) => {
                                        send_response(
                                            &sink,
                                            id,
                                            Err(format!("daemon error: {}", message)),
                                        )
                                        .await;
                                    }
                                    Ok(other) => {
                                        send_response(
                                            &sink,
                                            id,
                                            Err(format!(
                                                "unexpected daemon response: {:?}",
                                                other
                                            )),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        send_response(
                                            &sink,
                                            id,
                                            Err(format!("daemon error: {}", e)),
                                        )
                                        .await;
                                    }
                                }
                                continue;
                            }

                            // Special-case: detach_session just aborts the observer task
                            if command == "detach_session" {
                                let session_id = match args
                                    .get("session_id")
                                    .and_then(|v| v.as_str())
                                {
                                    Some(s) => s.to_string(),
                                    None => {
                                        send_response(
                                            &sink,
                                            id,
                                            Err("missing required arg: session_id".to_string()),
                                        )
                                        .await;
                                        continue;
                                    }
                                };

                                if let Some(handle) = observe_tasks.remove(&session_id) {
                                    handle.abort();
                                    log::info!("Detached observer for session {}", session_id);
                                }

                                send_response(&sink, id, Ok(serde_json::Value::Null)).await;
                                continue;
                            }

                            // Normal commands: short-lived daemon connection
                            let daemon_result =
                                daemon_client::DaemonClient::connect(&config.daemon_dir).await;

                            let response = match daemon_result {
                                Ok(mut daemon) => {
                                    match commands::handle_invoke(
                                        &command, &args, &db, &mut daemon,
                                    )
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

                            if let Err(e) =
                                sink.lock().await.send(Message::Text(response_json.into())).await
                            {
                                log::error!("Failed to send response: {}", e);
                                break;
                            }
                        }
                        RelayMessage::AuthOk { user_id } => {
                            log::info!("Relay authenticated as user {}", user_id);
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
                    if let Err(e) = sink.lock().await.send(Message::Pong(data)).await {
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

        // Clean up all observer tasks on disconnect
        for (session_id, handle) in observe_tasks.drain() {
            log::info!("Cleaning up observer for session {} on disconnect", session_id);
            handle.abort();
        }

        log::info!("Disconnected from relay. Reconnecting in 5 seconds...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Send a response message through the relay WebSocket.
async fn send_response(
    sink: &Arc<Mutex<relay_client::WsSink>>,
    id: u64,
    result: Result<serde_json::Value, String>,
) {
    let response = match result {
        Ok(data) => RelayMessage::Response {
            id,
            data: Some(data),
            error: None,
        },
        Err(e) => RelayMessage::Response {
            id,
            data: None,
            error: Some(e),
        },
    };

    let json = match serde_json::to_string(&response) {
        Ok(j) => j,
        Err(e) => {
            log::error!("Failed to serialize response: {}", e);
            return;
        }
    };

    if let Err(e) = sink.lock().await.send(Message::Text(json.into())).await {
        log::error!("Failed to send response: {}", e);
    }
}

/// Background task that reads daemon events from an Observe connection
/// and forwards them as relay Event messages through the WebSocket.
async fn observer_loop(
    mut daemon: daemon_client::DaemonClient,
    session_id: &str,
    sink: Arc<Mutex<relay_client::WsSink>>,
) {
    use base64::Engine;
    use kanna_daemon::protocol::Event as DaemonEvent;

    // We process daemon events in a two-phase pattern: first extract data
    // from the non-Send Result (no awaits), then send over the WebSocket.
    // This avoids holding Box<dyn Error> across await points.
    enum Action {
        SendOutput { json: String },
        SendExitAndStop { json: String },
        Stop,
        Continue,
    }

    loop {
        let action = match daemon.read_event().await {
            Ok(DaemonEvent::Output { session_id, data }) => {
                let evt = RelayMessage::Event {
                    name: "terminal_output".to_string(),
                    payload: serde_json::json!({
                        "session_id": session_id,
                        "data_b64": base64::engine::general_purpose::STANDARD.encode(&data),
                    }),
                };
                match serde_json::to_string(&evt) {
                    Ok(j) => Action::SendOutput { json: j },
                    Err(e) => {
                        log::error!("Failed to serialize output event: {}", e);
                        Action::Continue
                    }
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: sid,
                code,
            }) => {
                log::info!("Session {} exited with code {}", sid, code);
                let evt = RelayMessage::Event {
                    name: "session_exit".to_string(),
                    payload: serde_json::json!({
                        "session_id": sid,
                        "code": code,
                    }),
                };
                match serde_json::to_string(&evt) {
                    Ok(j) => Action::SendExitAndStop { json: j },
                    Err(e) => {
                        log::error!("Failed to serialize exit event: {}", e);
                        Action::Stop
                    }
                }
            }
            Err(e) => {
                log::error!("Observer read error for {}: {}", session_id, e);
                Action::Stop
            }
            _ => Action::Continue,
        };

        match action {
            Action::SendOutput { json } => {
                if sink
                    .lock()
                    .await
                    .send(Message::Text(json.into()))
                    .await
                    .is_err()
                {
                    log::info!("WebSocket closed, stopping observer for {}", session_id);
                    break;
                }
            }
            Action::SendExitAndStop { json } => {
                let _ = sink.lock().await.send(Message::Text(json.into())).await;
                break;
            }
            Action::Stop => break,
            Action::Continue => {}
        }
    }
}
