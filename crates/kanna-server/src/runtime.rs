use crate::{config::Config, db, http_api, relay};
use std::sync::Arc;

async fn prepare_daemon_generation(
    daemon: &mut crate::daemon_client::DaemonClient,
) -> Result<u32, String> {
    let connected_pid = daemon.connected_pid();
    daemon.negotiate_protected_input().await?;
    let mut retry_delay = std::time::Duration::from_millis(50);
    while !classify_sessions_on_connected_daemon(daemon).await {
        log::warn!(
            "daemon pid {connected_pid} protected-input classification is incomplete; all unclassified sessions remain fenced and classification will retry"
        );
        tokio::time::sleep(retry_delay).await;
        retry_delay = std::cmp::min(retry_delay * 2, std::time::Duration::from_secs(2));
    }
    Ok(connected_pid)
}

/// Which wait is reporting. Startup runs before `http_api::serve` binds, so a
/// daemon it cannot reach really does leave LAN and relay unavailable. The
/// steady-state maintenance loop runs behind a listener that is already
/// serving; saying the same thing there names an outage that is not happening
/// and sent the 2026-08-06 incident investigation after the wrong system.
#[derive(Clone, Copy)]
enum ProtectedInputWait {
    Startup,
    SteadyState,
}

impl ProtectedInputWait {
    fn degraded(self) -> &'static str {
        match self {
            Self::Startup => "LAN/relay have not started yet",
            Self::SteadyState => {
                "the LAN/relay API keeps serving; only protected-input \
                 classification of new daemon sessions is deferred"
            }
        }
    }
}

/// Establish the protected-input contract on whichever daemon is serving now,
/// retrying until one accepts it, and hand back the connection it was
/// established on.
async fn establish_protected_input_generation(
    config: &Config,
    wait: ProtectedInputWait,
) -> crate::daemon_client::DaemonClient {
    let mut retry_delay = std::time::Duration::from_millis(50);
    // Set only when a *connected* daemon refuses the contract because it is
    // already handing off. That successor is imminent and unannounced, which
    // is the one question `wait_for_successor`'s bounded poll answers. "Has
    // this healthy daemon been replaced yet?" is a different question, and
    // asking it here — of a daemon nothing was replacing — is what spun this
    // module until 2026-08-08: the bounded wait expired every ~17s, the
    // expiry read as a connection failure, and the retry re-negotiated with
    // the same daemon forever.
    let mut awaiting_successor_to: Option<u32> = None;
    loop {
        // Both connectors report a boxed non-`Send` error. Reduced to its text
        // here so that nothing un-`Send` is alive across the retry sleep below
        // and this future can be spawned as a task, not only polled inside a
        // `select!`.
        let connection = match awaiting_successor_to {
            Some(pid) => crate::daemon_client::wait_for_successor(&config.daemon_dir, pid)
                .await
                .map_err(|error| error.to_string()),
            None => crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
                .await
                .map_err(|error| error.to_string()),
        };
        let mut daemon = match connection {
            Ok(daemon) => daemon,
            Err(error) => {
                log::warn!(
                    "protected-input daemon generation is not ready; {}: {error}",
                    wait.degraded()
                );
                awaiting_successor_to = None;
                tokio::time::sleep(retry_delay).await;
                retry_delay = std::cmp::min(retry_delay * 2, std::time::Duration::from_secs(2));
                continue;
            }
        };
        let connected_pid = daemon.connected_pid();
        match prepare_daemon_generation(&mut daemon).await {
            Ok(_) => return daemon,
            Err(error) => {
                log::warn!(
                    "daemon pid {connected_pid} lacks the protected-input contract; waiting for a successor: {error}"
                );
                awaiting_successor_to = Some(connected_pid);
            }
        }
    }
}

/// Probe geometry support before the first KSP client is authenticated. The
/// KSP capability is a server-to-daemon contract as well as a client claim;
/// advertising it only after a terminal control socket exists would deadlock
/// a new client because it correctly suppresses registration against an old
/// owner. Use a separate connection so an old daemon closing on the unknown
/// probe command cannot poison the protected-input generation connection.
async fn establish_terminal_geometry_capability(config: &Config) -> bool {
    let Ok(mut daemon) = crate::daemon_client::DaemonClient::connect(&config.daemon_dir).await
    else {
        return false;
    };
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            daemon.send_command(&kanna_daemon::protocol::Command::NegotiateTerminalGeometry {
                version: kanna_daemon::protocol::TERMINAL_GEOMETRY_PROTOCOL_VERSION,
            }),
        )
        .await,
        Ok(Ok(kanna_daemon::protocol::Event::TerminalGeometryReady { version }))
            if version == kanna_daemon::protocol::TERMINAL_GEOMETRY_PROTOCOL_VERSION
    )
}

/// Re-establish the contract on every *new* daemon generation, and only on a
/// new one.
///
/// A daemon that keeps serving is not an event, so this parks on the
/// connection the contract was negotiated over and costs nothing until that
/// daemon stops serving it: no negotiation, no session classification, no log
/// line. Every daemon that replaces this one — handoff, crash, restart —
/// closes that connection on its way out, so the wake-up is prompt without
/// anything polling for it.
async fn maintain_protected_input_generations(
    config: Config,
    state: Arc<http_api::AppState>,
    mut daemon: crate::daemon_client::DaemonClient,
) {
    loop {
        let previous_pid = daemon.connected_pid();
        let ended = daemon.wait_until_disconnected().await;
        // No KSP connection may continue to advertise the old generation's
        // geometry authority while the successor is being probed. The state
        // update also wakes active KSP handlers so they reconnect and
        // authenticate against the successor's verdict.
        state.invalidate_terminal_geometry_capability(previous_pid);
        log::info!(
            "daemon pid {previous_pid} ended its protected-input generation ({ended}); \
             re-establishing the policy on its successor"
        );
        daemon =
            establish_protected_input_generation(&config, ProtectedInputWait::SteadyState).await;
        let daemon_pid = daemon.connected_pid();
        let geometry_supported = establish_terminal_geometry_capability(&config).await;
        state.set_terminal_geometry_capability(daemon_pid, geometry_supported);
        log::info!(
            "protected-input and terminal geometry policies established on successor daemon pid {} (geometry_supported={geometry_supported})",
            daemon_pid
        );
    }
}

async fn classify_sessions_on_connected_daemon(
    daemon: &mut crate::daemon_client::DaemonClient,
) -> bool {
    let sessions = match daemon
        .send_command(&kanna_daemon::protocol::Command::List)
        .await
    {
        Ok(kanna_daemon::protocol::Event::SessionList { sessions }) => sessions,
        Ok(event) => {
            log::error!("failed to list daemon sessions for input classification: {event:?}");
            return false;
        }
        Err(error) => {
            log::error!("failed to list daemon sessions for input classification: {error}");
            return false;
        }
    };
    let mut complete = true;
    for session in sessions {
        if session.kind != kanna_daemon::protocol::SessionKind::Pty {
            continue;
        }
        let session_id = session.session_id;
        // Clear the retired native-terminal-only policy on every daemon
        // generation. This also upgrades merge singletons inherited across a
        // server restart or daemon handoff to ordinary task/KSP input.
        let operator_input_only = false;
        match daemon
            .send_command(&kanna_daemon::protocol::Command::ClassifyInput {
                session_id: session_id.clone(),
                operator_input_only,
            })
            .await
        {
            Ok(kanna_daemon::protocol::Event::Ok)
            | Ok(kanna_daemon::protocol::Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                ..
            }) => {}
            Ok(event) => {
                complete = false;
                log::error!(
                    "daemon refused input classification for session {session_id}; if inherited and unclassified, it remains fenced while this authenticated generation retries it: {event:?}"
                );
            }
            Err(error) => {
                complete = false;
                log::error!(
                    "failed to classify existing session {session_id}; if inherited and unclassified, it remains fenced while this authenticated generation retries it: {error}"
                );
            }
        }
    }
    complete
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
    let mut protected_input_daemon =
        establish_protected_input_generation(&config, ProtectedInputWait::Startup).await;
    let daemon_pid = protected_input_daemon.connected_pid();
    let geometry_supported = establish_terminal_geometry_capability(&config).await;
    http_state.set_terminal_geometry_capability(daemon_pid, geometry_supported);
    crate::task_creator::reconcile_lifecycle_operations_on_startup(
        &mut protected_input_daemon,
        &config.db_path,
        &db,
    )
    .await;
    let protected_input_maintenance = maintain_protected_input_generations(
        config.clone(),
        Arc::clone(&http_state),
        protected_input_daemon,
    );
    // The transfer engine is a peer of the LAN API, not a child of it: a
    // transfer must keep making progress whether or not anything is connected.
    //
    // Its own task, not a `select!` branch beside the listener and the relay. A
    // transfer acquires repositories, and even with every git and tar call on
    // the blocking pool the engine holds `.await`s across whole clones; sharing
    // a task with `http_api::serve` and `run_relay_loop` would mean a slow
    // acquisition stops accepting LAN connections and stops answering relay
    // pings — and `RELAY_PONG_TIMEOUT` is 75s, so a long enough clone would tear
    // the relay down and take mobile offline.
    tokio::spawn(crate::transfer_engine::run(Arc::clone(&http_state)));
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
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt},
        net::{TcpListener, UnixListener},
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

    fn listed_session(
        session_id: &str,
        kind: kanna_daemon::protocol::SessionKind,
    ) -> kanna_daemon::protocol::SessionInfo {
        kanna_daemon::protocol::SessionInfo {
            session_id: session_id.to_string(),
            pid: 1,
            cwd: "/tmp".to_string(),
            state: kanna_daemon::protocol::SessionState::Active,
            idle_seconds: 0,
            status: kanna_daemon::protocol::SessionStatus::Idle,
            kind,
            logical_input_blocked: false,
            pending_logical_input_count: None,
            composer_text: None,
            composer_attestation: Default::default(),
        }
    }

    async fn serve_generation_replay(
        listener: UnixListener,
        sessions: Vec<kanna_daemon::protocol::SessionInfo>,
        classify_responses: Vec<kanna_daemon::protocol::Event>,
    ) -> Vec<kanna_daemon::protocol::Command> {
        let mut responses = vec![
            kanna_daemon::protocol::Event::ProtectedInputReady {
                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
            },
            kanna_daemon::protocol::Event::SessionList { sessions },
        ];
        responses.extend(classify_responses);
        serve_generation_script(listener, responses).await
    }

    async fn serve_generation_script(
        listener: UnixListener,
        responses: Vec<kanna_daemon::protocol::Event>,
    ) -> Vec<kanna_daemon::protocol::Command> {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read);
        let mut commands = Vec::new();
        for response in responses {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            commands.push(serde_json::from_str(line.trim()).unwrap());
            write
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    }

    #[tokio::test]
    async fn generation_readiness_clears_retired_policy_on_inherited_ptys() {
        let daemon_dir = unique_path("mixed-generation-replay", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(serve_generation_replay(
            listener,
            vec![
                listed_session("pty-session", kanna_daemon::protocol::SessionKind::Pty),
                listed_session(
                    "headless-session",
                    kanna_daemon::protocol::SessionKind::Agent,
                ),
            ],
            vec![kanna_daemon::protocol::Event::Ok],
        ));
        let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir)
            .await
            .unwrap();

        super::prepare_daemon_generation(&mut daemon).await.unwrap();

        let commands = server.await.unwrap();
        assert!(matches!(
            commands.as_slice(),
            [
                kanna_daemon::protocol::Command::NegotiateProtectedInput { .. },
                kanna_daemon::protocol::Command::List,
                kanna_daemon::protocol::Command::ClassifyInput {
                    session_id,
                    operator_input_only: false,
                },
            ] if session_id == "pty-session"
        ));
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[test]
    fn terminal_geometry_probe_publishes_generation_and_result_together() {
        let config = daemon_only_config(&unique_path("geometry-capability", "dir"));
        let state = Arc::new(http_api::AppState::new(config));
        state.set_terminal_geometry_capability(2, true);

        let writer_state = Arc::clone(&state);
        let writer = thread::spawn(move || {
            for daemon_pid in 3..10_000 {
                writer_state
                    .set_terminal_geometry_capability(daemon_pid, daemon_pid.is_multiple_of(2));
            }
        });
        for _ in 0..10_000 {
            let capability = state.terminal_geometry_capability();
            assert_eq!(
                capability.supported,
                capability.daemon_pid.is_multiple_of(2)
            );
        }
        writer.join().unwrap();
    }

    #[tokio::test]
    async fn generation_readiness_tolerates_pty_disappearing_during_replay() {
        let daemon_dir = unique_path("disappearing-generation-replay", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(serve_generation_replay(
            listener,
            vec![listed_session(
                "short-lived-pty",
                kanna_daemon::protocol::SessionKind::Pty,
            )],
            vec![kanna_daemon::protocol::Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                message: "session exited after inventory".to_string(),
            }],
        ));
        let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir)
            .await
            .unwrap();
        let expected_pid = daemon.connected_pid();

        assert_eq!(
            super::prepare_daemon_generation(&mut daemon).await.unwrap(),
            expected_pid,
        );

        let commands = server.await.unwrap();
        assert!(matches!(
            commands.last(),
            Some(kanna_daemon::protocol::Command::ClassifyInput { session_id, .. })
                if session_id == "short-lived-pty"
        ));
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn generation_readiness_retries_list_failure_before_becoming_ready() {
        let daemon_dir = unique_path("list-retry-generation-replay", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(serve_generation_script(
            listener,
            vec![
                kanna_daemon::protocol::Event::ProtectedInputReady {
                    version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
                },
                kanna_daemon::protocol::Event::Error {
                    code: None,
                    message: "temporary list failure".to_string(),
                },
                kanna_daemon::protocol::Event::SessionList {
                    sessions: vec![listed_session(
                        "still-fenced-until-listed",
                        kanna_daemon::protocol::SessionKind::Pty,
                    )],
                },
                kanna_daemon::protocol::Event::Ok,
            ],
        ));
        let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir)
            .await
            .unwrap();

        super::prepare_daemon_generation(&mut daemon).await.unwrap();

        let commands = server.await.unwrap();
        assert!(matches!(
            commands.as_slice(),
            [
                kanna_daemon::protocol::Command::NegotiateProtectedInput { .. },
                kanna_daemon::protocol::Command::List,
                kanna_daemon::protocol::Command::List,
                kanna_daemon::protocol::Command::ClassifyInput {
                    session_id,
                    operator_input_only: false,
                },
            ] if session_id == "still-fenced-until-listed"
        ));
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn generation_readiness_continues_after_mid_list_refusal() {
        let daemon_dir = unique_path("refused-generation-replay", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let sessions = vec![
            listed_session("first-pty", kanna_daemon::protocol::SessionKind::Pty),
            listed_session("refused-pty", kanna_daemon::protocol::SessionKind::Pty),
            listed_session("last-pty", kanna_daemon::protocol::SessionKind::Pty),
        ];
        let server = tokio::spawn(serve_generation_script(
            listener,
            vec![
                kanna_daemon::protocol::Event::ProtectedInputReady {
                    version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
                },
                kanna_daemon::protocol::Event::SessionList {
                    sessions: sessions.clone(),
                },
                kanna_daemon::protocol::Event::Ok,
                kanna_daemon::protocol::Event::Error {
                    code: Some(kanna_daemon::protocol::ErrorCode::InputUnauthorized),
                    message: "temporary classification refusal".to_string(),
                },
                kanna_daemon::protocol::Event::Ok,
                kanna_daemon::protocol::Event::SessionList { sessions },
                kanna_daemon::protocol::Event::Ok,
                kanna_daemon::protocol::Event::Ok,
                kanna_daemon::protocol::Event::Ok,
            ],
        ));
        let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir)
            .await
            .unwrap();

        super::prepare_daemon_generation(&mut daemon).await.unwrap();

        let commands = server.await.unwrap();
        let classified: Vec<_> = commands
            .iter()
            .filter_map(|command| match command {
                kanna_daemon::protocol::Command::ClassifyInput { session_id, .. } => {
                    Some(session_id.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            classified,
            [
                "first-pty",
                "refused-pty",
                "last-pty",
                "first-pty",
                "refused-pty",
                "last-pty"
            ]
        );
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn previous_daemon_protocol_blocks_http_until_a_supporting_successor_exists() {
        let daemon_dir = unique_path("previous-daemon-generation", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (negotiated_tx, negotiated_rx) = tokio::sync::oneshot::channel();
        let previous_daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut reader = tokio::io::BufReader::new(read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
            assert!(matches!(
                command,
                kanna_daemon::protocol::Command::NegotiateProtectedInput {
                    version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION
                }
            ));
            negotiated_tx.send(()).unwrap();
            let refusal = kanna_daemon::protocol::Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::ProtectedInputProtocolRequired),
                message: "protected-input protocol mismatch".to_string(),
            };
            write
                .write_all(format!("{}\n", serde_json::to_string(&refusal).unwrap()).as_bytes())
                .await
                .unwrap();
            // Keep the previous generation published. The server must wait
            // for a different daemon PID instead of serving against this one.
            std::future::pending::<()>().await
        });

        let db_path = unique_path("previous-daemon-generation", "sqlite");
        let mut config = daemon_only_config(&daemon_dir);
        config.db_path = db_path.clone();
        config.lan_port = free_port().await;
        let database = db::Db::open_for_tests(&db_path).unwrap();
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let services = super::run_server_services(config.clone(), database, state);
        tokio::pin!(services);
        let assertions = async {
            tokio::time::timeout(Duration::from_secs(2), negotiated_rx)
                .await
                .expect("server never negotiated with the previous daemon")
                .unwrap();
            let status_url = format!("http://127.0.0.1:{}/v1/status", config.lan_port);
            let response = reqwest::Client::new().get(status_url).send().await;
            assert!(
                response.is_err(),
                "HTTP must not bind while the daemon lacks fenced task input"
            );
        };
        tokio::pin!(assertions);
        tokio::select! {
            _ = &mut services => {
                panic!("server services exited instead of waiting for a supporting successor")
            }
            _ = &mut assertions => {}
        }

        previous_daemon.abort();
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
        let _ = std::fs::remove_file(db_path);
    }

    fn daemon_only_config(daemon_dir: &str) -> Config {
        Config {
            relay_url: String::new(),
            device_token: String::new(),
            firebase_project_id: "kanna-local".into(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string(),
            db_path: String::new(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".into(),
            desktop_secret: None,
            desktop_name: "Studio Mac".into(),
            version: "test-version".into(),
            environment: "development".into(),
            lan_host: "127.0.0.1".into(),
            lan_port: 0,
            transfer_port: 0,
            activity_event_debounce_seconds: 300,
            pairing_store_path: String::new(),
        }
    }

    /// The daemon side of one generation setup: acknowledge the negotiation,
    /// then report an empty session inventory.
    fn answer_generation_command(
        command: &kanna_daemon::protocol::Command,
        negotiations: &AtomicUsize,
    ) -> kanna_daemon::protocol::Event {
        match command {
            kanna_daemon::protocol::Command::NegotiateProtectedInput { version } => {
                negotiations.fetch_add(1, Ordering::SeqCst);
                kanna_daemon::protocol::Event::ProtectedInputReady { version: *version }
            }
            kanna_daemon::protocol::Command::List => kanna_daemon::protocol::Event::SessionList {
                sessions: Vec::new(),
            },
            other => panic!("unexpected daemon command {other:?}"),
        }
    }

    /// Answers a generation's commands and then behaves like a live daemon:
    /// the connection stays open, waiting for a command that never comes.
    /// Returns only when the server hangs up.
    async fn serve_live_generation(
        stream: tokio::net::UnixStream,
        negotiations: Arc<AtomicUsize>,
    ) -> Vec<kanna_daemon::protocol::Command> {
        let (read, mut write) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read);
        let mut commands = Vec::new();
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => return commands,
                Ok(_) => {}
            }
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
            let response = answer_generation_command(&command, &negotiations);
            commands.push(command);
            write
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
    }

    /// Serves exactly one generation setup — the negotiation and the session
    /// inventory that follows it — then hangs up, so the caller learns when
    /// the server has finished establishing the policy here.
    async fn serve_generation_setup(
        stream: tokio::net::UnixStream,
        negotiations: Arc<AtomicUsize>,
    ) -> Vec<kanna_daemon::protocol::Command> {
        let (read, mut write) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read);
        let mut commands = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
            let response = answer_generation_command(&command, &negotiations);
            commands.push(command);
            write
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    }

    /// A daemon that is never replaced must be negotiated with exactly once,
    /// however long the server runs. Before 2026-08-08 the maintenance loop
    /// treated "no successor appeared" as a failed wait and re-ran the whole
    /// generation setup — negotiation plus a `List` and a `ClassifyInput` per
    /// PTY — roughly every 17 seconds for the life of the server.
    #[tokio::test(start_paused = true)]
    async fn a_stable_daemon_is_negotiated_with_once() {
        let daemon_dir = unique_path("stable-generation", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let negotiations = Arc::new(AtomicUsize::new(0));
        let connections = Arc::new(AtomicUsize::new(0));
        let daemon_negotiations = Arc::clone(&negotiations);
        let daemon_connections = Arc::clone(&connections);
        let fake_daemon = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                daemon_connections.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(serve_live_generation(
                    stream,
                    Arc::clone(&daemon_negotiations),
                ));
            }
        });

        let config = daemon_only_config(&daemon_dir);
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let daemon = super::establish_protected_input_generation(
            &config,
            super::ProtectedInputWait::Startup,
        )
        .await;
        let maintenance = tokio::spawn(super::maintain_protected_input_generations(
            config, state, daemon,
        ));
        // The clock is paused, so this is 10 minutes of the loop's own time —
        // more than thirty of the old spin's cycles — without 10 minutes of
        // wall clock.
        tokio::time::sleep(Duration::from_secs(600)).await;

        assert!(
            !maintenance.is_finished(),
            "maintenance loop exited while the daemon was still serving"
        );
        assert_eq!(
            negotiations.load(Ordering::SeqCst),
            1,
            "a daemon that keeps serving must be negotiated with exactly once"
        );
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "a daemon that keeps serving must not be reconnected to"
        );

        maintenance.abort();
        fake_daemon.abort();
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    /// The other half of the same contract: a daemon that really is replaced
    /// must have the policy re-established on its successor, promptly and
    /// without anyone asking the server to look.
    #[tokio::test]
    async fn a_replaced_daemon_gets_its_successor_negotiated() {
        let daemon_dir = unique_path("replaced-generation", "dir");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(std::path::Path::new(&daemon_dir));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let negotiations = Arc::new(AtomicUsize::new(0));
        let daemon_negotiations = Arc::clone(&negotiations);
        let successor_socket = socket_path.clone();
        let (retire_outgoing, retired) = tokio::sync::oneshot::channel::<()>();
        let fake_daemons = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let outgoing = tokio::spawn(serve_live_generation(
                stream,
                Arc::clone(&daemon_negotiations),
            ));
            retired.await.unwrap();
            // Exit the way a handed-off daemon does: the outgoing daemon drops
            // its connections and its socket, and only then does the successor
            // become reachable.
            outgoing.abort();
            drop(listener);
            let _ = std::fs::remove_file(&successor_socket);
            let successor = UnixListener::bind(&successor_socket).unwrap();
            let (stream, _) = successor.accept().await.unwrap();
            let commands = serve_generation_setup(stream, Arc::clone(&daemon_negotiations)).await;
            let (stream, _) = successor.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut reader = tokio::io::BufReader::new(read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
                kanna_daemon::protocol::Command::NegotiateTerminalGeometry { version }
                    if version == kanna_daemon::protocol::TERMINAL_GEOMETRY_PROTOCOL_VERSION
            ));
            write
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(
                            &kanna_daemon::protocol::Event::TerminalGeometryReady {
                                version: kanna_daemon::protocol::TERMINAL_GEOMETRY_PROTOCOL_VERSION,
                            }
                        )
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            commands
        });

        let config = daemon_only_config(&daemon_dir);
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let daemon = super::establish_protected_input_generation(
            &config,
            super::ProtectedInputWait::Startup,
        )
        .await;
        assert_eq!(negotiations.load(Ordering::SeqCst), 1);
        let maintenance = tokio::spawn(super::maintain_protected_input_generations(
            config,
            Arc::clone(&state),
            daemon,
        ));
        retire_outgoing.send(()).unwrap();

        let successor_commands = tokio::time::timeout(Duration::from_secs(30), fake_daemons)
            .await
            .expect("the successor daemon was never negotiated with")
            .expect("successor fixture should not panic");
        assert_eq!(negotiations.load(Ordering::SeqCst), 2);
        assert!(
            state.terminal_geometry_supported(),
            "attach-only viewers must see the successor geometry capability"
        );
        maintenance.abort();
        assert!(
            matches!(
                successor_commands.as_slice(),
                [
                    kanna_daemon::protocol::Command::NegotiateProtectedInput { .. },
                    kanna_daemon::protocol::Command::List,
                ]
            ),
            "successor generation received {successor_commands:?}"
        );
        let _ = std::fs::remove_dir_all(daemon_dir);
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
            // A real daemon keeps serving after the generation is established,
            // and the server holds that connection for as long as it does.
            // Answer the independent geometry probe before holding the
            // generation connection open. This models an attach-only viewer
            // discovering the capability without first creating a control
            // worker.
            let (geometry_stream, _) = daemon_listener.accept().await.unwrap();
            let (geometry_read, mut geometry_write) = geometry_stream.into_split();
            let mut geometry_reader = tokio::io::BufReader::new(geometry_read);
            line.clear();
            geometry_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
                kanna_daemon::protocol::Command::NegotiateTerminalGeometry { .. }
            ));
            geometry_write
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(
                            &kanna_daemon::protocol::Event::TerminalGeometryReady {
                                version: kanna_daemon::protocol::TERMINAL_GEOMETRY_PROTOCOL_VERSION,
                            }
                        )
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            // Hanging up the protected-input connection would tell the server
            // its daemon had been replaced. Aborted with the task below.
            std::future::pending::<()>().await;
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
            activity_event_debounce_seconds: 300,
            pairing_store_path: pairing_store_path.clone(),
        };
        let database = db::Db::open_for_tests(&db_path).unwrap();
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let runtime = super::run_server_services(config, database, state);
        tokio::pin!(runtime);
        let assertions = async {
            let status_url = format!("http://127.0.0.1:{lan_port}/v1/status");
            let client = reqwest::Client::new();
            for _ in 0..200 {
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
