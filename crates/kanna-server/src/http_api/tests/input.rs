use super::*;

async fn expect_task_state_changed(
    rx: &mut tokio::sync::broadcast::Receiver<kanna_agent_protocol::ServerFrame>,
) {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("timed out waiting for task state change")
        .expect("state change channel closed");
    assert_eq!(
        frame,
        kanna_agent_protocol::ServerFrame::StateChanged {
            scope: kanna_agent_protocol::StateChangeScope::Tasks,
        }
    );
}

async fn assert_signal_agent_reuses_open_task_with_run_status(run_status: &str) {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-signal-agent-found-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();

    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "merge-session");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
        inputs
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&unique),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-merge",
        "repo-1",
        "Merge master",
        Some("Merge Master"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-merge",
        task_id: "task-merge",
        stage: "in progress",
        kind: "main",
        agent: Some("merge"),
        agent_provider: Some("claude"),
        model: None,
        status: run_status,
        result: None,
        feedback: None,
        session_id: Some("merge-session"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config)));
    let message =
        "MERGE task-feature -> main [PR https://github.com/acme/repo/pull/7]: ship feature";
    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/agents/merge/signal")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "message": message
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(body["taskId"], "task-merge");
    assert_eq!(body["created"], false);
    let inputs = daemon_server.await.unwrap();
    assert_eq!(inputs, vec![message.as_bytes().to_vec(), vec![b'\r']]);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}

#[tokio::test]
async fn signal_agent_route_sends_message_to_open_running_agent_task() {
    assert_signal_agent_reuses_open_task_with_run_status("running").await;
}

#[tokio::test]
async fn signal_agent_route_reuses_open_agent_task_after_successful_turn() {
    assert_signal_agent_reuses_open_task_with_run_status("succeeded").await;
}

#[tokio::test]
async fn signal_agent_route_reuses_open_agent_task_after_failed_turn() {
    assert_signal_agent_reuses_open_task_with_run_status("failed").await;
}

#[tokio::test]
async fn signal_agent_route_creates_pinned_agent_task_when_absent() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-signal-agent-absent-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("{unique}-repo"));
    init_test_git_repo(&repo_root);
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();

    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id, args, ..
            } => {
                assert!(
                    args.iter().any(|arg| arg.contains("MERGE task-ready")),
                    "spawn args should contain the first prompt: {args:?}"
                );
                session_id
            }
            DaemonCommand::SpawnAgent { session_id, params } => {
                assert!(params.prompt.contains("MERGE task-ready"));
                session_id
            }
            other => panic!("expected spawn command, got {other:?}"),
        };
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&DaemonEvent::SessionCreated { session_id }).unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&unique),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let state = Arc::new(super::AppState::new(config.clone()));
    let mut state_changes = state.subscribe_state_changes();
    let app = super::router(Arc::clone(&state));
    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/agents/merge/signal")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "message": "MERGE task-ready -> main: ready"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(body["created"], true);
    let task_id = body["taskId"].as_str().expect("task id");
    expect_task_state_changed(&mut state_changes).await;
    daemon_server.await.unwrap();
    expect_task_state_changed(&mut state_changes).await;

    let db = Db::open(&config.db_path).unwrap();
    let task = db.get_pipeline_item(task_id).unwrap().unwrap();
    assert_eq!(task.repo_id, "repo-1");
    assert_eq!(
        task.prompt.as_deref(),
        Some("MERGE task-ready -> main: ready")
    );
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(task.pinned, Some(1));
    assert_eq!(task.pin_order, Some(0));
    let mut runs = db.list_stage_runs_for_task(task_id).unwrap();
    for _ in 0..20 {
        if !runs.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        runs = db.list_stage_runs_for_task(task_id).unwrap();
    }
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].agent.as_deref(), Some("merge"));
    assert_eq!(runs[0].status, "running");

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn signal_agent_route_detaches_creation_spawn_from_request_future() {
    use kanna_daemon::protocol::Command as DaemonCommand;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-signal-agent-detached-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("{unique}-repo"));
    init_test_git_repo(&repo_root);
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();

    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, _) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
        match command {
            DaemonCommand::Spawn { .. } | DaemonCommand::SpawnAgent { .. } => {}
            other => panic!("expected spawn command, got {other:?}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&unique),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config)));
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        app.oneshot(
            Request::post("/v1/repos/repo-1/agents/merge/signal")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "message": "MERGE task-detached -> main: ready"
                    })
                    .to_string(),
                ))
                .unwrap(),
        ),
    )
    .await
    .expect("signal route must respond without waiting for daemon spawn")
    .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    daemon_server.abort();

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn run_merge_agent_route_uses_merge_agent_runner() {
    let app = super::test_router_with_merge_agent_runner(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            Ok(TaskActionResponse {
                task_id: format!("merge-{task_id}"),
                follow_task: None,
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/run-merge-agent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "merge-task-1");
}

#[test]
fn task_input_message_strips_trailing_terminators() {
    // The Enter is synthesized separately, so the message carries no
    // terminator regardless of what the caller appended.
    assert_eq!(super::task_input_message("continue"), "continue");
    assert_eq!(super::task_input_message("continue\n"), "continue");
    assert_eq!(super::task_input_message("continue\r"), "continue");
    assert_eq!(super::task_input_message("continue\r\n\n"), "continue");
    assert_eq!(super::task_input_message(""), "");
    // Internal newlines are preserved (only trailing ones are stripped).
    assert_eq!(super::task_input_message("a\nb\n"), "a\nb");
}

#[tokio::test]
async fn send_task_input_route_uses_input_sender() {
    let app = super::test_router_with_task_input_sender(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id, input| {
            assert_eq!(task_id, "task-1");
            assert_eq!(input, "continue");
            Ok(())
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "continue"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn submit_task_input_sends_text_then_enter_as_discrete_inputs() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-submit-input-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let daemon_dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "task-target");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
        inputs
    });

    let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir.to_string_lossy())
        .await
        .unwrap();
    super::submit_task_input(&mut daemon, "task-target", "hello\n")
        .await
        .unwrap();
    let inputs = server.await.unwrap();

    assert_eq!(inputs, vec![b"hello".to_vec(), vec![b'\r']]);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}

#[tokio::test]
async fn terminal_state_notification_sends_once_to_notify_target() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-notify-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "task-parent");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
        inputs
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
        firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&unique),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-child",
        "repo-1",
        "Child prompt first line\nsecond line",
        Some("Child Display"),
        "in progress",
        "2026-04-18 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_notify_task("task-child", "task-parent")
        .unwrap();
    drop(db);

    let state = Arc::new(super::AppState::new(config.clone()));
    let mut state_changes = state.subscribe_state_changes();

    super::handle_task_terminal_state(state.as_ref(), "task-child", true)
        .await
        .unwrap();
    expect_task_state_changed(&mut state_changes).await;
    expect_task_state_changed(&mut state_changes).await;
    let inputs = server.await.unwrap();
    assert_eq!(
        inputs,
        vec![
            b"TASK task-child DONE [success]: Child Display".to_vec(),
            vec![b'\r']
        ]
    );

    super::handle_task_terminal_state(state.as_ref(), "task-child", true)
        .await
        .unwrap();
    expect_task_state_changed(&mut state_changes).await;
    let db = Db::open(&config.db_path).unwrap();
    let task = db.get_pipeline_item("task-child").unwrap().unwrap();
    assert_eq!(task.activity.as_deref(), Some("unread"));
    assert!(task.notified_at.is_some());

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}
