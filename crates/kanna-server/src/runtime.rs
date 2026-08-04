use crate::{config::Config, db, http_api, relay};
use std::sync::Arc;

async fn prepare_daemon_generation(
    daemon: &mut crate::daemon_client::DaemonClient,
    db: &db::Db,
) -> Result<u32, String> {
    let connected_pid = daemon.connected_pid();
    daemon.negotiate_protected_input().await?;
    classify_sessions_on_connected_daemon(daemon, db).await?;
    Ok(connected_pid)
}

async fn wait_for_protected_input_generation(
    config: &Config,
    db: &db::Db,
    mut previous_pid: Option<u32>,
) -> u32 {
    let mut retry_delay = std::time::Duration::from_millis(50);
    loop {
        let connection = match previous_pid {
            Some(pid) => crate::daemon_client::wait_for_successor(&config.daemon_dir, pid).await,
            None => crate::daemon_client::DaemonClient::connect(&config.daemon_dir).await,
        };
        let mut daemon = match connection {
            Ok(daemon) => daemon,
            Err(error) => {
                log::warn!(
                    "protected-input daemon generation is not ready; LAN/relay remain unavailable: {error}"
                );
                previous_pid = None;
                tokio::time::sleep(retry_delay).await;
                retry_delay = std::cmp::min(retry_delay * 2, std::time::Duration::from_secs(2));
                continue;
            }
        };
        let connected_pid = daemon.connected_pid();
        match prepare_daemon_generation(&mut daemon, db).await {
            Ok(pid) => return pid,
            Err(error) => {
                log::warn!(
                    "daemon pid {connected_pid} lacks the protected-input contract; waiting for a successor: {error}"
                );
                previous_pid = Some(connected_pid);
            }
        }
    }
}

async fn maintain_protected_input_generations(config: Config, mut pid: u32) {
    let db = loop {
        match db::Db::open(&config.db_path) {
            Ok(db) => break db,
            Err(error) => {
                log::error!(
                    "failed to open the classification database for daemon generation monitoring: {error}"
                );
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    };
    loop {
        pid = wait_for_protected_input_generation(&config, &db, Some(pid)).await;
        log::info!("protected-input policy established on successor daemon pid {pid}");
    }
}

async fn classify_sessions_on_connected_daemon(
    daemon: &mut crate::daemon_client::DaemonClient,
    db: &db::Db,
) -> Result<(), String> {
    let sessions = match daemon
        .send_command(&kanna_daemon::protocol::Command::List)
        .await
    {
        Ok(kanna_daemon::protocol::Event::SessionList { sessions }) => sessions,
        Ok(event) => {
            return Err(format!(
                "failed to list daemon sessions for input classification: {event:?}"
            ));
        }
        Err(error) => {
            return Err(format!(
                "failed to list daemon sessions for input classification: {error}"
            ));
        }
    };
    for session in sessions {
        let session_id = session.session_id;
        let operator_input_only = match db.session_requires_operator_input(&session_id) {
            Ok(value) => value,
            Err(error) => {
                return Err(format!(
                    "failed to resolve input policy for existing session {session_id}: {error}"
                ));
            }
        };
        match daemon
            .send_command(&kanna_daemon::protocol::Command::ClassifyInput {
                session_id: session_id.clone(),
                operator_input_only,
            })
            .await
        {
            Ok(kanna_daemon::protocol::Event::Ok) => {}
            Ok(event) => {
                return Err(format!(
                    "daemon refused input classification for session {session_id}: {event:?}"
                ))
            }
            Err(error) => {
                return Err(format!(
                    "failed to classify existing session {session_id}: {error}"
                ));
            }
        }
    }
    Ok(())
}

async fn run_human_control_service(state: Arc<http_api::AppState>) {
    match crate::human_control::serve(state).await {
        Ok(()) => log::warn!("native human control exited unexpectedly"),
        Err(err) => log::error!("native human control failed: {err}"),
    }
    // The LAN/relay API remains useful if this optional privileged channel
    // cannot bind. Overrides fail closed because HTTP has no native fallback.
    std::future::pending::<()>().await;
}

pub(crate) async fn run_server_services(
    config: Config,
    db: db::Db,
    http_state: Arc<http_api::AppState>,
) {
    crate::task_creator::prune_completion_contexts_on_startup(&config.daemon_dir, &db);
    let protected_input_pid = wait_for_protected_input_generation(&config, &db, None).await;
    let protected_input_maintenance =
        maintain_protected_input_generations(config.clone(), protected_input_pid);
    if config.relay_url.trim().is_empty() {
        tokio::select! {
            result = http_api::serve(Arc::clone(&http_state)) => match result {
                Ok(()) => log::warn!("LAN API exited unexpectedly"),
                Err(err) => log::error!("LAN API failed: {}", err),
            },
            _ = run_human_control_service(http_state) => {},
            _ = protected_input_maintenance => {},
        }
        return;
    }

    let human_control_state = Arc::clone(&http_state);
    tokio::select! {
        result = http_api::serve(Arc::clone(&http_state)) => match result {
            Ok(()) => log::warn!("LAN API exited unexpectedly"),
            Err(err) => log::error!("LAN API failed: {}", err),
        },
        result = relay::run_relay_loop(config, db, http_state) => match result {
            Ok(()) => log::warn!("relay loop exited unexpectedly"),
            Err(err) => log::error!("relay loop failed: {}", err),
        },
        _ = run_human_control_service(human_control_state) => {},
        _ = protected_input_maintenance => {},
    }
}

#[cfg(test)]
mod tests {
    use crate::{config::Config, db, http_api, relay_client::RelayMessage};
    use futures_util::{SinkExt, StreamExt};
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt},
        net::TcpListener,
        time::Duration,
    };
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    }

    fn unique_path(label: &str, extension: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "kanna-server-{label}-{}-{}.{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                extension,
            ))
            .to_string_lossy()
            .to_string()
    }

    #[tokio::test]
    async fn two_renderer_clients_share_one_authoritative_relay_publisher() {
        let relay_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_addr = relay_listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let publications = Arc::new(AtomicUsize::new(0));
        let relay_connections = Arc::clone(&connections);
        let relay_publications = Arc::clone(&publications);
        let fake_relay = tokio::spawn(async move {
            loop {
                let (stream, _) = relay_listener.accept().await.unwrap();
                relay_connections.fetch_add(1, Ordering::SeqCst);
                let publications = Arc::clone(&relay_publications);
                tokio::spawn(async move {
                    let mut socket = accept_async(stream).await.unwrap();
                    let auth = socket.next().await.unwrap().unwrap();
                    assert!(matches!(auth, Message::Text(_)));
                    socket
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "auth_ok",
                                "userId": "user-1",
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let message: RelayMessage = serde_json::from_str(&text).unwrap();
                        if let RelayMessage::TaskSnapshotPublish { id, .. } = message {
                            publications.fetch_add(1, Ordering::SeqCst);
                            socket
                                .send(Message::Text(
                                    serde_json::json!({
                                        "type": "task_snapshot_ack",
                                        "id": id,
                                        "ok": true,
                                    })
                                    .to_string()
                                    .into(),
                                ))
                                .await
                                .unwrap();
                        }
                    }
                });
            }
        });

        let db_path = unique_path("singleton-publisher", "sqlite");
        let pairing_store_path = unique_path("singleton-publisher-pairings", "json");
        let daemon_dir = unique_path("singleton-publisher-daemon", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let daemon_socket = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let daemon_listener = tokio::net::UnixListener::bind(&daemon_socket).unwrap();
        std::fs::write(
            std::path::Path::new(&daemon_dir).join("daemon.pid"),
            format!("{}\n", std::process::id()),
        )
        .unwrap();
        let fake_daemon = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut reader = tokio::io::BufReader::new(read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
                kanna_daemon::protocol::Command::NegotiateProtectedInput { .. }
            ));
            write
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(
                            &kanna_daemon::protocol::Event::ProtectedInputReady {
                                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
                            }
                        )
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
                kanna_daemon::protocol::Command::List
            ));
            write
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&kanna_daemon::protocol::Event::SessionList {
                            sessions: Vec::new(),
                        })
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let lan_port = free_port().await;
        let config = Config {
            relay_url: format!("ws://{relay_addr}"),
            device_token: String::new(),
            firebase_project_id: "kanna-local".into(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.clone(),
            db_path: db_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".into(),
            desktop_secret: Some("desktop-secret".into()),
            desktop_name: "Studio Mac".into(),
            version: "test-version".into(),
            environment: "development".into(),
            lan_host: "127.0.0.1".into(),
            lan_port,
            transfer_port: 4455,
            pairing_store_path: pairing_store_path.clone(),
        };
        let database = db::Db::open_for_tests(&db_path).unwrap();
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let runtime = super::run_server_services(config, database, state);
        tokio::pin!(runtime);
        let assertions = async {
            let status_url = format!("http://127.0.0.1:{lan_port}/v1/status");
            let client = reqwest::Client::new();
            for _ in 0..40 {
                if client.get(&status_url).send().await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            let (first_window, second_window) = tokio::join!(
                client.get(&status_url).send(),
                client.get(&status_url).send(),
            );
            assert!(first_window.unwrap().status().is_success());
            assert!(second_window.unwrap().status().is_success());

            tokio::time::timeout(Duration::from_secs(2), async {
                while publications.load(Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("singleton publisher did not reconcile");
            tokio::time::sleep(Duration::from_millis(650)).await;

            assert_eq!(connections.load(Ordering::SeqCst), 1);
            assert_eq!(publications.load(Ordering::SeqCst), 1);

            let reconnect = client
                .post(format!("{status_url}/../cloud/relay/actions/reconnect"))
                .send()
                .await
                .unwrap();
            assert_eq!(reconnect.status(), reqwest::StatusCode::NO_CONTENT);
            tokio::time::timeout(Duration::from_secs(7), async {
                while connections.load(Ordering::SeqCst) < 2 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("relay did not reconnect after the local session revocation signal");
            assert_eq!(connections.load(Ordering::SeqCst), 2);
        };
        tokio::select! {
            _ = &mut runtime => panic!("server runtime exited before singleton assertions"),
            _ = assertions => {}
        }

        fake_relay.abort();
        fake_daemon.abort();
        let _ = std::fs::remove_file(db_path);
        let _ = std::fs::remove_file(pairing_store_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }
}
