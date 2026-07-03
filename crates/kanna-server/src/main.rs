mod bonjour;
mod commands;
mod config;
mod daemon_client;
mod db;
mod http_api;
mod ksp;
mod mobile_api;
mod pairing;
mod register;
mod relay_client;
mod session_replacements;
mod task_creator;

use config::Config;
use futures_util::{SinkExt, StreamExt};
use relay_client::{RelayId, RelayInvoke, RelayMessage};
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
            .cloned()
            .or_else(|| std::env::var("KANNA_RELAY_URL").ok())
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty());
        let Some(relay_url) = relay_url else {
            eprintln!("Registration requires a relay URL argument or KANNA_RELAY_URL.");
            std::process::exit(1);
        };
        if let Err(e) = register::register(&relay_url).await {
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

    let relay_url = config.relay_url.trim().to_string();
    log::info!(
        "kanna-server starting, relay: {}",
        if relay_url.is_empty() {
            "(disabled)"
        } else {
            &relay_url
        }
    );

    let heartbeat_config = config.clone();
    tokio::spawn(async move {
        loop {
            log::info!("desktop heartbeat tick for {}", heartbeat_config.desktop_id);
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    let db = match db::Db::open(&config.db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to open database at {}: {}", config.db_path, e);
            std::process::exit(1);
        }
    };

    log::info!("Database opened: {}", config.db_path);

    let _mobile_bonjour = bonjour::MobileBonjourAdvertisement::start(
        &config.desktop_name,
        &config.desktop_id,
        config.lan_port,
    )
    .map_err(|error| {
        log::warn!("mobile Bonjour advertisement unavailable: {}", error);
        error
    })
    .ok();

    // Capture the login-shell PATH before the first stage action needs it —
    // loading zshrc costs seconds and must never sit on a request path.
    tokio::task::spawn_blocking(task_creator::warm_login_shell_path);

    let http_state = Arc::new(http_api::AppState::new(config.clone()));
    let session_replacements = http_state.session_replacements();
    let terminal_state_config = config.clone();
    tokio::spawn(async move {
        terminal_state_watcher_loop(terminal_state_config, session_replacements).await;
    });
    let lan_task = tokio::spawn(http_api::serve(Arc::clone(&http_state)));
    if relay_url.is_empty() {
        match lan_task.await {
            Ok(Ok(())) => log::warn!("LAN API exited unexpectedly"),
            Ok(Err(err)) => log::error!("LAN API failed: {}", err),
            Err(err) => log::error!("LAN API task join error: {}", err),
        }
    } else {
        let relay_loop = run_relay_loop(config, db, http_state);
        tokio::pin!(relay_loop);

        tokio::select! {
            result = lan_task => match result {
                Ok(Ok(())) => log::warn!("LAN API exited unexpectedly"),
                Ok(Err(err)) => log::error!("LAN API failed: {}", err),
                Err(err) => log::error!("LAN API task join error: {}", err),
            },
            result = &mut relay_loop => match result {
                Ok(()) => log::warn!("relay loop exited unexpectedly"),
                Err(err) => log::error!("relay loop failed: {}", err),
            },
        };
    }
}

async fn terminal_state_watcher_loop(
    config: Config,
    replacements: session_replacements::SessionReplacements,
) {
    loop {
        if let Err(error) = terminal_state_watcher_once(&config, &replacements).await {
            log::warn!("terminal state watcher reconnecting after error: {}", error);
        }
        // Exits broadcast while disconnected are lost along with their
        // replacement entries; stale entries must not swallow future Exits.
        replacements.clear();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn terminal_state_watcher_once(
    config: &Config,
    replacements: &session_replacements::SessionReplacements,
) -> Result<(), String> {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};

    let mut daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon connection failed: {}", e))?;
    match daemon
        .send_command(&DaemonCommand::Subscribe)
        .await
        .map_err(|e| format!("daemon subscribe failed: {}", e))?
    {
        DaemonEvent::Ok => {}
        DaemonEvent::Error { message, .. } => {
            return Err(format!("daemon subscribe error: {}", message));
        }
        other => return Err(format!("unexpected daemon subscribe response: {:?}", other)),
    }

    loop {
        match daemon
            .read_event()
            .await
            .map_err(|e| format!("daemon read failed: {}", e))?
        {
            DaemonEvent::Exit {
                session_id, code, ..
            } => {
                if replacements.consume(&session_id) {
                    // Orchestrated kill (stage swap, rerun, close) — not the
                    // agent finishing.
                    continue;
                }
                let success = code == 0;
                if let Err(error) =
                    http_api::handle_task_terminal_state(config, &session_id, success).await
                {
                    log::warn!(
                        "failed to handle terminal state for {} (success={}): {}",
                        session_id,
                        success,
                        error
                    );
                }
            }
            DaemonEvent::ShuttingDown => return Ok(()),
            _ => {}
        }
    }
}

async fn run_relay_loop(
    config: Config,
    db: db::Db,
    http_state: Arc<http_api::AppState>,
) -> Result<(), String> {
    // Reconnection loop
    loop {
        log::info!("Connecting to relay at {}...", config.relay_url);

        let (sink, mut stream) = match relay_client::connect_to_relay(&config).await {
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
                        RelayMessage::Invoke { id, request } => match request {
                            RelayInvoke::Command { command, args } => {
                                log::info!("Invoke #{}: {}", id, command);

                                // Special-case: observe_session needs a long-lived daemon connection
                                if command == "observe_session" {
                                    let session_id =
                                        match args.get("session_id").and_then(|v| v.as_str()) {
                                            Some(s) => s.to_string(),
                                            None => {
                                                send_response(
                                                    &sink,
                                                    id,
                                                    Err("missing required arg: session_id"
                                                        .to_string()),
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
                                    let mut obs_daemon = match daemon_client::DaemonClient::connect(
                                        &config.daemon_dir,
                                    )
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

                                            // Spawn background task to replay the current snapshot and
                                            // forward later daemon events.
                                            let sink_clone = Arc::clone(&sink);
                                            let sid = session_id.clone();
                                            let handle = tokio::spawn(async move {
                                                observer_loop(obs_daemon, &sid, sink_clone).await;
                                            });
                                            observe_tasks.insert(session_id, handle);
                                        }
                                        Ok(DaemonEvent::Error { message, .. }) => {
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

                                // Special-case: unobserve_session just aborts the observer task
                                if command == "unobserve_session" {
                                    let session_id =
                                        match args.get("session_id").and_then(|v| v.as_str()) {
                                            Some(s) => s.to_string(),
                                            None => {
                                                send_response(
                                                    &sink,
                                                    id,
                                                    Err("missing required arg: session_id"
                                                        .to_string()),
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
                                            &command,
                                            &args,
                                            &db,
                                            &mut daemon,
                                            &config,
                                            &http_state.session_replacements(),
                                        )
                                        .await
                                        {
                                            Ok(data) => RelayMessage::Response {
                                                id,
                                                data: Some(data),
                                                error: None,
                                                status: None,
                                                body: None,
                                            },
                                            Err(e) => {
                                                log::error!("Invoke #{} error: {}", id, e);
                                                RelayMessage::Response {
                                                    id,
                                                    data: None,
                                                    error: Some(e),
                                                    status: None,
                                                    body: None,
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
                                            status: None,
                                            body: None,
                                        }
                                    }
                                };

                                if let Err(e) = send_relay_response_message(&sink, response).await {
                                    log::error!("{}", e);
                                    break;
                                }
                            }
                            RelayInvoke::Http { method, path, body } => {
                                log::info!("HTTP invoke #{}: {} {}", id, method, path);

                                let invoke_response = http_api::dispatch_http_invoke(
                                    Arc::clone(&http_state),
                                    &method,
                                    &path,
                                    body,
                                )
                                .await;
                                let response = RelayMessage::Response {
                                    id,
                                    data: None,
                                    error: invoke_response.error,
                                    status: Some(invoke_response.status),
                                    body: invoke_response.body,
                                };

                                if let Err(e) = send_relay_response_message(&sink, response).await {
                                    log::error!("{}", e);
                                    break;
                                }
                            }
                        },
                        RelayMessage::AuthOk { user_id } => {
                            log::info!("Relay authenticated as user {}", user_id);
                        }
                        RelayMessage::TunnelEstablish {
                            desktop_id,
                            tunnel_id,
                        } => {
                            if desktop_id != config.desktop_id {
                                log::warn!(
                                    "Ignoring tunnel {} for unexpected desktop {}",
                                    tunnel_id,
                                    desktop_id
                                );
                                continue;
                            }
                            let tunnel_config = config.clone();
                            let tunnel_state = Arc::clone(&http_state);
                            tokio::spawn(async move {
                                log::info!("Dialing relay tunnel {}", tunnel_id);
                                match relay_client::connect_tunnel_to_relay(
                                    &tunnel_config,
                                    tunnel_id.clone(),
                                )
                                .await
                                {
                                    Ok(socket) => {
                                        crate::ksp::handle_tungstenite_stream(
                                            socket,
                                            tunnel_state,
                                            relay_tunnel_ksp_auth_mode(),
                                        )
                                        .await;
                                        log::info!("Relay tunnel {} closed", tunnel_id);
                                    }
                                    Err(error) => {
                                        log::error!(
                                            "Failed to establish relay tunnel {}: {}",
                                            tunnel_id,
                                            error
                                        );
                                    }
                                }
                            });
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
            log::info!(
                "Cleaning up observer for session {} on disconnect",
                session_id
            );
            handle.abort();
        }

        log::info!("Disconnected from relay. Reconnecting in 5 seconds...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Send a response message through the relay WebSocket.
async fn send_response(
    sink: &Arc<Mutex<relay_client::WsSink>>,
    id: RelayId,
    result: Result<serde_json::Value, String>,
) {
    let response = match result {
        Ok(data) => RelayMessage::Response {
            id,
            data: Some(data),
            error: None,
            status: None,
            body: None,
        },
        Err(e) => RelayMessage::Response {
            id,
            data: None,
            error: Some(e),
            status: None,
            body: None,
        },
    };

    if let Err(e) = send_relay_response_message(sink, response).await {
        log::error!("Failed to send response: {}", e);
    }
}

async fn send_relay_response_message(
    sink: &Arc<Mutex<relay_client::WsSink>>,
    response: RelayMessage,
) -> Result<(), String> {
    let json = match serde_json::to_string(&response) {
        Ok(j) => j,
        Err(e) => {
            return Err(format!("failed to serialize response: {}", e));
        }
    };

    if let Err(e) = sink.lock().await.send(Message::Text(json.into())).await {
        return Err(format!("failed to send response: {}", e));
    }

    Ok(())
}

fn relay_snapshot_event(
    session_id: &str,
    snapshot: kanna_daemon::protocol::TerminalSnapshot,
) -> RelayMessage {
    RelayMessage::Event {
        name: "terminal_snapshot".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "snapshot": snapshot,
        }),
    }
}

fn relay_output_event(session_id: &str, data: Vec<u8>) -> RelayMessage {
    use base64::Engine;

    RelayMessage::Event {
        name: "terminal_output".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "data_b64": base64::engine::general_purpose::STANDARD.encode(&data),
        }),
    }
}

fn relay_exit_event(session_id: &str, code: i32) -> RelayMessage {
    RelayMessage::Event {
        name: "session_exit".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "code": code,
        }),
    }
}

fn relay_error_event(session_id: &str, message: String) -> RelayMessage {
    RelayMessage::Event {
        name: "terminal_error".to_string(),
        payload: serde_json::json!({
            "session_id": session_id,
            "message": message,
        }),
    }
}

fn relay_tunnel_ksp_auth_mode() -> crate::ksp::AuthMode {
    crate::ksp::AuthMode::AllowEmpty
}

async fn send_relay_event(sink: &Arc<Mutex<relay_client::WsSink>>, event: RelayMessage) -> bool {
    match serde_json::to_string(&event) {
        Ok(json) => sink
            .lock()
            .await
            .send(Message::Text(json.into()))
            .await
            .is_ok(),
        Err(error) => {
            log::error!("Failed to serialize relay event: {}", error);
            true
        }
    }
}

enum ObserverStart {
    Continue,
    Stop,
}

async fn send_initial_snapshot_event(
    daemon: &mut daemon_client::DaemonClient,
    session_id: &str,
    sink: &Arc<Mutex<relay_client::WsSink>>,
) -> Option<ObserverStart> {
    use kanna_daemon::protocol::{Command as DaemonCommand, ErrorCode, Event as DaemonEvent};

    let snapshot_result = daemon
        .send_command(&DaemonCommand::Snapshot {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|error| format!("daemon snapshot error: {}", error));
    let mut event = match snapshot_result {
        Ok(event) => event,
        Err(message) => {
            return send_relay_event(sink, relay_error_event(session_id, message))
                .await
                .then_some(ObserverStart::Stop);
        }
    };

    loop {
        match event {
            DaemonEvent::Snapshot { snapshot, .. } => {
                return send_relay_event(sink, relay_snapshot_event(session_id, snapshot))
                    .await
                    .then_some(ObserverStart::Continue);
            }
            DaemonEvent::Exit {
                session_id: sid,
                code,
                ..
            } => {
                return send_relay_event(sink, relay_exit_event(&sid, code))
                    .await
                    .then_some(ObserverStart::Stop);
            }
            DaemonEvent::Error {
                code: Some(ErrorCode::SessionNotFound),
                ..
            } => return Some(ObserverStart::Continue),
            DaemonEvent::Error { message, .. } => {
                return send_relay_event(sink, relay_error_event(session_id, message))
                    .await
                    .then_some(ObserverStart::Stop);
            }
            DaemonEvent::Output { .. } | DaemonEvent::StatusChanged { .. } => {}
            _ => {}
        }

        let read_result = daemon
            .read_event()
            .await
            .map_err(|error| format!("daemon snapshot error: {}", error));
        event = match read_result {
            Ok(event) => event,
            Err(message) => {
                return send_relay_event(sink, relay_error_event(session_id, message))
                    .await
                    .then_some(ObserverStart::Stop);
            }
        };
    }
}

/// Background task that reads daemon events from an Observe connection
/// and forwards them as relay Event messages through the WebSocket.
async fn observer_loop(
    mut daemon: daemon_client::DaemonClient,
    session_id: &str,
    sink: Arc<Mutex<relay_client::WsSink>>,
) {
    use kanna_daemon::protocol::Event as DaemonEvent;

    match send_initial_snapshot_event(&mut daemon, session_id, &sink).await {
        Some(ObserverStart::Continue) => {}
        Some(ObserverStart::Stop) => return,
        None => {
            log::info!(
                "WebSocket closed while sending initial snapshot for {}",
                session_id
            );
            return;
        }
    }

    // We process daemon events in a two-phase pattern: first extract data
    // from the non-Send Result (no awaits), then send over the WebSocket.
    // This avoids holding Box<dyn Error> across await points.
    enum Action {
        Send { event: RelayMessage },
        SendAndStop { event: RelayMessage },
        Stop,
        Continue,
    }

    loop {
        let action = match daemon.read_event().await {
            Ok(DaemonEvent::Output { session_id, data }) => Action::Send {
                event: relay_output_event(&session_id, data),
            },
            Ok(DaemonEvent::Exit {
                session_id: sid,
                code,
                ..
            }) => {
                log::info!("Session {} exited with code {}", sid, code);
                Action::SendAndStop {
                    event: relay_exit_event(&sid, code),
                }
            }
            Err(e) => {
                log::error!("Observer read error for {}: {}", session_id, e);
                Action::Stop
            }
            _ => Action::Continue,
        };

        match action {
            Action::Send { event } => {
                if !send_relay_event(&sink, event).await {
                    log::info!("WebSocket closed, stopping observer for {}", session_id);
                    break;
                }
            }
            Action::SendAndStop { event } => {
                let _ = send_relay_event(&sink, event).await;
                break;
            }
            Action::Stop => break,
            Action::Continue => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_daemon::protocol::TerminalSnapshot;

    #[test]
    fn relay_snapshot_event_preserves_terminal_snapshot_payload() {
        let snapshot = TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 2,
            cursor_col: 3,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "restored".to_string(),
        };

        let event = relay_snapshot_event("task-1", snapshot);

        match event {
            RelayMessage::Event { name, payload } => {
                assert_eq!(name, "terminal_snapshot");
                assert_eq!(payload["session_id"], "task-1");
                assert_eq!(payload["snapshot"]["vt"], "restored");
                assert_eq!(payload["snapshot"]["cursor_row"], 2);
            }
            other => panic!("expected terminal_snapshot relay event, got {other:?}"),
        }
    }

    #[test]
    fn relay_output_event_keeps_live_output_as_base64() {
        let event = relay_output_event("task-1", b"live".to_vec());

        match event {
            RelayMessage::Event { name, payload } => {
                assert_eq!(name, "terminal_output");
                assert_eq!(payload["session_id"], "task-1");
                assert_eq!(payload["data_b64"], "bGl2ZQ==");
            }
            other => panic!("expected terminal_output relay event, got {other:?}"),
        }
    }

    #[test]
    fn relay_tunnel_ksp_auth_is_already_satisfied_by_relay() {
        assert_eq!(
            relay_tunnel_ksp_auth_mode(),
            crate::ksp::AuthMode::AllowEmpty
        );
    }
}
