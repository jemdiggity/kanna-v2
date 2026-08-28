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

async fn assert_signal_agent_reuses_open_task_with_run_status(run_status: &str, agent: &str) {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique_prefix = format!(
        "kanna-signal-agent-found-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let (unique, daemon_dir, socket_path, listener) = (0..100)
        .find_map(|attempt| {
            let unique = format!("{unique_prefix}-{attempt}");
            let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
            std::fs::create_dir_all(&daemon_dir).unwrap();
            let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
            match UnixListener::bind(&socket_path) {
                Ok(listener) => Some((unique, daemon_dir, socket_path, listener)),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::AddrInUse | std::io::ErrorKind::AlreadyExists
                    ) =>
                {
                    let _ = std::fs::remove_dir_all(daemon_dir);
                    None
                }
                Err(error) => panic!("failed to bind test daemon socket: {error}"),
            }
        })
        .expect("failed to allocate a collision-free test daemon socket");

    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..1 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            match command {
                DaemonCommand::SubmitInput { session_id, data } => {
                    assert_eq!(session_id, "merge-session");
                    inputs.push(data);
                }
                other => panic!("expected semantic SubmitInput command, got {other:?}"),
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
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-merge",
        "repo-1",
        "Merge master",
        Some("Task Manager"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-merge",
        task_id: "task-merge",
        stage: "in progress",
        kind: "main",
        agent: Some(agent),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
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
    let message = "Please assess whether PR 123 is ready to merge";
    let response = app
        .oneshot(
            Request::post(format!("/v1/repos/repo-1/agents/{agent}/signal"))
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
    assert_eq!(inputs, vec![message.as_bytes().to_vec()]);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}

#[tokio::test]
async fn signal_agent_route_sends_message_to_open_running_agent_task() {
    assert_signal_agent_reuses_open_task_with_run_status("running", "task-manager").await;
}

#[tokio::test]
async fn signal_agent_route_reuses_open_agent_task_after_successful_turn() {
    assert_signal_agent_reuses_open_task_with_run_status("succeeded", "task-manager").await;
}

#[tokio::test]
async fn signal_agent_route_reuses_open_agent_task_after_failed_turn() {
    assert_signal_agent_reuses_open_task_with_run_status("failed", "task-manager").await;
}

#[tokio::test]
async fn generic_merge_signal_delivers_natural_language_to_existing_singleton() {
    assert_signal_agent_reuses_open_task_with_run_status("running", "merge").await;
}

fn seed_approvable_source(db: &Db, task_id: &str, run_id: &str, pr_number: i64) {
    db.insert_test_pipeline_item(
        task_id,
        "repo-1",
        task_id,
        Some(task_id),
        "pr",
        "2026-08-04T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(task_id, task_id, "default", Some("main"), "claude")
        .unwrap();
    db.update_pipeline_item_pr(
        task_id,
        Some(pr_number),
        &format!("https://github.com/acme/repo/pull/{pr_number}"),
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: run_id,
        task_id,
        stage: "approve",
        kind: "post",
        agent: Some("approve"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some(task_id),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
}

fn merge_test_config(unique: &str, daemon_dir: &Path) -> Config {
    Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(unique),
        kanna_cli_path: None,
        desktop_id: "desktop-concurrency".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    }
}

#[tokio::test]
async fn merge_handoff_route_sends_an_ordinary_repo_policy_request() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!("ordinary-merge-signal-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..1 {
            match read_test_daemon_command(&mut reader, &mut write_half).await {
                DaemonCommand::SubmitInput { session_id, data } => {
                    assert_eq!(session_id, "merge-session");
                    inputs.push(data);
                }
                other => panic!("expected SubmitInput command, got {other:?}"),
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

    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    seed_approvable_source(&db, "task-source", "approve-source", 51);
    db.insert_test_pipeline_item(
        "task-merge",
        "repo-1",
        "Merge master",
        Some("Merge Master"),
        "in progress",
        "2026-08-04T00:00:01Z",
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
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("merge-session"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-source/actions/signal-merge-handoff")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "branch": "feature/head",
                        "target": "main",
                        "prUrl": "https://github.com/acme/repo/pull/51",
                        "summary": "Ready for repository policy"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let inputs = daemon_server.await.unwrap();
    assert_eq!(
        inputs,
        vec![b"MERGE feature/head -> main [TASK task-source] [PR https://github.com/acme/repo/pull/51]: Ready for repository policy".to_vec()]
    );

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[tokio::test]
async fn natural_language_merge_signal_creates_pinned_singleton_when_absent() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
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
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id,
                args,
                operator_input_only,
                ..
            } => {
                assert!(
                    args.iter().any(|arg| arg.contains("Assess PR 123")),
                    "spawn args should contain the first prompt: {args:?}"
                );
                assert!(!operator_input_only);
                session_id
            }
            DaemonCommand::SpawnAgent { session_id, params } => {
                assert!(params.prompt.contains("Assess PR 123"));
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
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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
                        "message": "Assess PR 123"
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
    daemon_server.await.unwrap();
    expect_task_state_changed(&mut state_changes).await;

    let db = Db::open(&config.db_path).unwrap();
    let task = db.get_pipeline_item(task_id).unwrap().unwrap();
    assert_eq!(task.repo_id, "repo-1");
    assert_eq!(task.prompt.as_deref(), Some("Assess PR 123"));
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
async fn signal_agent_route_creates_agent_task_with_requested_provider_and_effort() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-signal-agent-overrides-{}-{}",
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
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id, args, ..
            } => {
                assert!(
                    args.iter().any(|arg| arg.contains("--effort 'high'")),
                    "spawn args should carry the requested effort: {args:?}"
                );
                session_id
            }
            other => panic!("expected a pty spawn command, got {other:?}"),
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
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    // The point of the override: the configured default would pick another
    // provider for this singleton agent.
    db.set_setting("defaultAgentProvider", "codex").unwrap();
    drop(db);

    let state = Arc::new(super::AppState::new(config.clone()));
    let mut state_changes = state.subscribe_state_changes();
    let app = super::router(Arc::clone(&state));
    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/agents/task-manager/signal")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "message": "Create task-ready",
                        "agentProvider": "claude",
                        "effort": "high"
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
    assert_eq!(task.agent_provider.as_deref(), Some("claude"));
    let mut runs = db.list_stage_runs_for_task(task_id).unwrap();
    for _ in 0..20 {
        if !runs.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        runs = db.list_stage_runs_for_task(task_id).unwrap();
    }
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].agent.as_deref(), Some("task-manager"));
    assert_eq!(runs[0].agent_provider.as_deref(), Some("claude"));
    assert_eq!(runs[0].effort.as_deref(), Some("high"));

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_dir_all(repo_root);
}

async fn assert_signal_agent_route_rejects_override(
    label: &str,
    overrides: serde_json::Value,
    expected_message: &str,
) {
    let unique = format!(
        "kanna-signal-agent-{label}-{}-{}",
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
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let mut body = serde_json::json!({
        "message": "Create task-ready"
    });
    body.as_object_mut()
        .expect("signal request body should be an object")
        .extend(
            overrides
                .as_object()
                .expect("signal overrides should be an object")
                .clone(),
        );
    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/agents/task-manager/signal")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let message = String::from_utf8(body.to_vec()).unwrap();
    assert!(
        message.contains(expected_message),
        "rejection should explain the invalid override: {message}"
    );

    // A rejected override must not leave a half-created singleton behind.
    let db = Db::open(&config.db_path).unwrap();
    assert!(db
        .find_open_agent_task("repo-1", "task-manager")
        .unwrap()
        .is_none());
    assert!(db.list_pipeline_items("repo-1").unwrap().is_empty());

    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn signal_agent_route_rejects_effort_the_requested_provider_rejects() {
    assert_signal_agent_route_rejects_override(
        "bad-effort",
        serde_json::json!({
            "agentProvider": "claude",
            "effort": "turbo"
        }),
        "effort 'turbo'",
    )
    .await;
}

#[tokio::test]
async fn signal_agent_route_rejects_unsupported_provider() {
    assert_signal_agent_route_rejects_override(
        "bad-provider",
        serde_json::json!({
            "agentProvider": "future-agent"
        }),
        "unsupported agent provider 'future-agent'",
    )
    .await;
}

#[tokio::test]
async fn signal_agent_route_detaches_creation_spawn_from_request_future() {
    use kanna_daemon::protocol::Command as DaemonCommand;
    use tokio::io::BufReader;
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
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
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
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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
            Request::post("/v1/repos/repo-1/agents/task-manager/signal")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "message": "Create task-detached"
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
                revision_budget: None,
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

/// `notify` names a message Kanna generated itself. A caller that could claim
/// it could forge the one label on the record that is not merely declared.
#[tokio::test]
async fn send_task_input_rejects_a_source_a_caller_cannot_be() {
    let unique = format!("task-input-source-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-source",
        "repo-1",
        "Source task",
        Some("Source task"),
        "in progress",
        "2026-08-19 04:00:00",
    )
    .unwrap();
    drop(db);

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-source/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "input": "hello", "source": "notify" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let failure: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(failure["reason"], "invalid_input_source");

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_task_inputs("task-source").unwrap(), 0);
    drop(db);

    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[tokio::test]
async fn send_task_input_rejects_an_in_flight_task_session_change() {
    let unique = format!("task-input-mutating-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-mutating",
        "repo-1",
        "Mutating task",
        Some("Mutating task"),
        "in progress",
        "2026-08-12 04:00:00",
    )
    .unwrap();
    drop(db);

    let state = Arc::new(super::AppState::new(config.clone()));
    let _mutation = state.begin_requested_task_mutation("task-mutating").await;
    let response = super::router(state)
        .oneshot(
            Request::post("/v1/tasks/task-mutating/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "input": "Do not redirect me" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "ok": false,
            "reason": "no_live_agent_session",
            "message": "task task-mutating is changing stage or agent session; input was not delivered; inspect the current run before retrying"
        })
    );

    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[tokio::test]
async fn send_task_input_rejects_a_finished_task_without_a_live_daemon_session() {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, Event as DaemonEvent, SessionInfo, SessionState, SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!("task-input-dead-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while let Some(command) =
            read_test_daemon_command_optional(&mut reader, &mut write_half).await
        {
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    // The daemon can briefly retain the PTY record after its
                    // child exits. Its Input queue can still acknowledge bytes
                    // during that window, but no agent can consume them.
                    sessions: vec![SessionInfo {
                        session_id: "task-finished".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Exited(1),
                        idle_seconds: 0,
                        status: SessionStatus::Idle,
                        kind: Default::default(),
                        logical_input_blocked: false,
                        pending_logical_input_count: None,
                        composer_text: None,
                        composer_attestation: Default::default(),
                    }],
                },
                DaemonCommand::InputIfSession { .. } => DaemonEvent::Ok,
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-finished",
        "repo-1",
        "Finished task",
        Some("Finished task"),
        "in progress",
        "2026-08-12 04:00:00",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-failed",
        task_id: "task-finished",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-finished"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run("run-failed", "failed", Some("agent failed"), None)
        .unwrap();
    rusqlite::Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE stage_run SET finished_at = ? WHERE id = ?",
            ["2026-08-12 04:20:00", "run-failed"],
        )
        .unwrap();
    drop(db);

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-finished/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "input": "Please continue" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "ok": false,
            "reason": "no_live_agent_session",
            "message": "no live agent session for task task-finished; latest run run-failed finished at 2026-08-12 04:20:00 with status failed; use kanna_resume_task to preserve provider context when possible, or kanna_rerun_stage to start fresh",
            "latestRun": {
                "id": "run-failed",
                "status": "failed",
                "finishedAt": "2026-08-12 04:20:00"
            }
        })
    );
    assert!(matches!(
        daemon_server.await.unwrap().as_slice(),
        [DaemonCommand::List]
    ));

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[tokio::test]
async fn send_task_input_delivers_to_a_live_session_after_a_finished_run() {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, Event as DaemonEvent, SessionInfo, SessionState, SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!("task-input-live-finished-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-live".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: SessionStatus::Idle,
                        kind: Default::default(),
                        logical_input_blocked: false,
                        pending_logical_input_count: None,
                        composer_text: None,
                        composer_attestation: Default::default(),
                    }],
                },
                DaemonCommand::SubmitInputIfSession { .. } => DaemonEvent::Ok,
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-live",
        "repo-1",
        "Live task",
        Some("Live task"),
        "in progress",
        "2026-08-12 04:00:00",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-succeeded",
        task_id: "task-live",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-live"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run("run-succeeded", "succeeded", Some("done"), None)
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-live/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "One more change",
                        "source": "operator",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let commands = daemon_server.await.unwrap();
    assert!(matches!(commands[0], DaemonCommand::List));
    assert!(matches!(
        &commands[1],
        DaemonCommand::SubmitInputIfSession { session_id, expected_pid, data }
            if session_id == "task-live" && *expected_pid == 42 && data == b"One more change"
    ));

    // The whole point of the record: a later stage, which never saw this
    // terminal, can still read what was said here. This is the DB -> server ->
    // HTTP readback the review stage depends on.
    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-live/inputs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let inputs: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(inputs["taskId"], "task-live");
    assert_eq!(inputs["total"], 1);
    let recorded = &inputs["inputs"][0];
    assert_eq!(recorded["message"], "One more change");
    assert_eq!(recorded["source"], "operator");
    assert_eq!(recorded["stage"], "in progress");
    assert!(recorded["deliveredAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty()));

    // And task detail reports the count, so a consumer reading only detail
    // cannot conclude from it that nothing was ever sent.
    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-live")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(detail["deliveredInputCount"], 1);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

/// The record is only as reachable as the tool that names it. Neither kanna-mcp
/// nor kanna-cli hand-writes this route: both resolve `kanna_task_inputs` from
/// the shared catalog and send whatever it yields. So a catalog path that
/// drifts from the router turns a reviewer's "what was this task told?" into a
/// 404 — which, from where they sit, is indistinguishable from "nothing was
/// ever sent", the exact failure the record exists to prevent. Drive the real
/// router with the catalog's own resolved request to pin the two together.
#[tokio::test]
async fn catalog_task_inputs_tool_reaches_the_recorded_instruction_history() {
    let state = test_state_with_seed("desktop-catalog-inputs", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task 1",
            "repo-1",
            "Instructed task",
            Some("Instructed task"),
            "in progress",
            "2026-08-20 04:00:00",
        )
        .unwrap();
        db.record_task_input(
            "task 1",
            crate::db::TaskInputSource::Operator,
            "Keep the new flag — I changed my mind mid-task.",
        )
        .unwrap()
        .expect("a seeded task should accept a recorded input");
    });
    let app = router(state);

    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_task_inputs",
        &serde_json::json!({ "task_id": "task 1", "tail": 25 }),
    )
    .expect("the bundled catalog must expose kanna_task_inputs");
    assert_eq!(resolved.method, kanna_tool_catalog::Method::Get);
    assert_eq!(resolved.kind, kanna_tool_catalog::ResponseKind::Json);

    let response = app
        .clone()
        .oneshot(Request::get(&resolved.path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "catalog path {} did not reach the inputs route",
        resolved.path
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let inputs: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(inputs["taskId"], "task 1");
    assert_eq!(inputs["total"], 1);
    let recorded = &inputs["inputs"][0];
    assert_eq!(
        recorded["message"],
        "Keep the new flag — I changed my mind mid-task."
    );
    assert_eq!(recorded["source"], "operator");
    assert_eq!(recorded["stage"], "in progress");
    assert!(recorded["deliveredAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty()));
    // The keys the MCP and CLI consumers deserialize. kanna-cli models this
    // response with a typed struct it cannot share with this crate, so the
    // shape is pinned on both sides — see `kanna-cli/tests/task_inputs.rs`.
    let mut keys = recorded
        .as_object()
        .expect("each record is an object")
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "deliveredAt",
            "id",
            "message",
            "runId",
            "source",
            "stage",
            "taskId"
        ]
    );

    // And the cheap summary on task detail, which is what tells a reviewer the
    // history is worth fetching at all.
    let detail_request = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_get_task",
        &serde_json::json!({ "task_id": "task 1" }),
    )
    .expect("the bundled catalog must expose kanna_get_task");
    let response = app
        .oneshot(
            Request::get(&detail_request.path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(detail["deliveredInputCount"], 1);
}

/// Spawn a fake daemon that reports one live PTY session for `task_id` and
/// answers `expected_commands` commands, returning what it was sent.
fn spawn_live_session_daemon(
    listener: tokio::net::UnixListener,
    task_id: &'static str,
    expected_commands: usize,
) -> tokio::task::JoinHandle<Vec<kanna_daemon::protocol::Command>> {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, Event as DaemonEvent, SessionInfo, SessionState, SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < expected_commands {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: task_id.to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: SessionStatus::Idle,
                        kind: Default::default(),
                        // This helper's sessions accept delivered input; the
                        // refusal path has its own tests on main.
                        logical_input_blocked: false,
                        pending_logical_input_count: None,
                        composer_text: None,
                        composer_attestation: Default::default(),
                    }],
                },
                DaemonCommand::SubmitInputIfSession { .. } => DaemonEvent::Ok,
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    })
}

fn seed_live_task(config: &Config, task_id: &str) {
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        task_id,
        "repo-1",
        "Live task",
        Some("Live task"),
        "in progress",
        "2026-08-19 04:00:00",
    )
    .unwrap();
}

/// A photo sent from the phone has to become a file the agent can open, and
/// the message the agent receives has to name that file. Both halves are
/// asserted here because either alone is useless: a stored image nobody
/// mentions is invisible, and a mentioned path with no file behind it sends
/// the agent to read nothing.
#[tokio::test]
async fn send_task_input_stores_an_attachment_and_names_its_path_in_the_message() {
    use base64::Engine;
    use kanna_daemon::protocol::Command as DaemonCommand;
    use tokio::net::UnixListener;

    let unique = format!("task-input-attachment-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = spawn_live_session_daemon(listener, "task-live", 2);

    let config = merge_test_config(&unique, &daemon_dir);
    seed_live_task(&config, "task-live");

    let image_bytes = b"\x89PNG\r\n\x1a\n pretend pixels".to_vec();
    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-live/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "what is wrong here?",
                        "attachment": {
                            "fileName": "IMG_4821.HEIC",
                            "mediaType": "image/png",
                            "dataBase64": base64::engine::general_purpose::STANDARD
                                .encode(&image_bytes),
                        },
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let directory =
        crate::task_input_attachments::task_attachments_dir(&config.db_path, "task-live");
    let stored: Vec<_> = std::fs::read_dir(&directory)
        .expect("attachment directory")
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(stored.len(), 1, "expected exactly one stored attachment");
    assert_eq!(std::fs::read(&stored[0]).unwrap(), image_bytes);
    let stored_path = stored[0].to_string_lossy().to_string();
    assert!(
        stored_path.contains("IMG_4821-"),
        "stored name should keep a recognisable prefix: {stored_path}"
    );

    let commands = daemon_server.await.unwrap();
    let DaemonCommand::SubmitInputIfSession { data, .. } = &commands[1] else {
        panic!("expected a submission, got {:?}", commands[1]);
    };
    let delivered = String::from_utf8(data.clone()).unwrap();
    assert_eq!(
        delivered,
        format!("what is wrong here? [Attached image: {stored_path}]")
    );
    // One submission, not two: the daemon writes the message and then a
    // carriage return, so a newline here would split the text from the image.
    assert!(!delivered.contains('\n'));

    // The durable record is the delivered text, so a later stage reading the
    // record — in a fresh worktree, with no terminal — can still find the file.
    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-live/inputs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let inputs: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(inputs["inputs"][0]["message"], delivered);

    let _ = std::fs::remove_dir_all(crate::task_input_attachments::attachments_root(
        &config.db_path,
    ));
    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

/// Spawn a fake daemon that reports one live PTY session and then refuses the
/// submission with `code`, returning what it was sent.
fn spawn_refusing_session_daemon(
    listener: tokio::net::UnixListener,
    task_id: &'static str,
    code: kanna_daemon::protocol::ErrorCode,
    message: &'static str,
) -> tokio::task::JoinHandle<Vec<kanna_daemon::protocol::Command>> {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, Event as DaemonEvent, SessionInfo, SessionState, SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: task_id.to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: SessionStatus::Idle,
                        kind: Default::default(),
                        logical_input_blocked: code
                            == kanna_daemon::protocol::ErrorCode::InheritedDraftStateUnknown,
                        pending_logical_input_count: None,
                        composer_text: None,
                        composer_attestation: Default::default(),
                    }],
                },
                DaemonCommand::SubmitInputIfSession { .. } => DaemonEvent::Error {
                    code: Some(code),
                    message: message.to_string(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    })
}

/// A wedged session refuses the message outright and nothing will retry it, so
/// the photo it named is a file no surviving message points at. It goes.
///
/// This is where the attachment path meets the refusal semantics that landed
/// while this work was in review: the answer is the same 409 `input_blocked` a
/// text-only input gets, the ledger stays empty because nothing was delivered,
/// and the difference an attachment makes is only that a file must not be left
/// orphaned behind the refusal.
#[tokio::test]
async fn an_attachment_refused_by_a_blocked_session_is_not_left_on_disk() {
    use base64::Engine;
    use kanna_daemon::protocol::ErrorCode;
    use tokio::net::UnixListener;

    let unique = format!("task-input-attachment-blocked-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = spawn_refusing_session_daemon(
        listener,
        "task-live",
        ErrorCode::InheritedDraftStateUnknown,
        "logical input refused for session task-live: this daemon inherited the session and its \
         composer holds text it never saw typed",
    );

    let config = merge_test_config(&unique, &daemon_dir);
    seed_live_task(&config, "task-live");

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-live/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "look at this",
                        "attachment": {
                            "mediaType": "image/png",
                            "dataBase64": base64::engine::general_purpose::STANDARD
                                .encode(b"\x89PNG pretend"),
                        },
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let failure: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(failure["reason"], "input_blocked");

    let directory =
        crate::task_input_attachments::task_attachments_dir(&config.db_path, "task-live");
    let leftovers: Vec<_> = std::fs::read_dir(&directory)
        .map(|entries| entries.map(|entry| entry.unwrap().path()).collect())
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "a refused attachment must not outlive its message: {leftovers:?}"
    );

    let db = Db::open(&config.db_path).unwrap();
    // Nothing reached the PTY, so nothing is recorded as delivered — the same
    // rule the text-only path follows.
    assert_eq!(db.count_task_inputs("task-live").unwrap(), 0);
    assert_eq!(
        db.get_pipeline_item_input_blocked("task-live")
            .unwrap()
            .as_deref(),
        Some(crate::http_api::INPUT_BLOCKED_INHERITED_DRAFT)
    );
    drop(db);

    let _ = daemon_server.await.unwrap();
    let _ = std::fs::remove_dir_all(crate::task_input_attachments::attachments_root(
        &config.db_path,
    ));
    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

/// A message held behind a human's unsent line is not delivered *yet* — but it
/// is queued at the daemon and goes out when that terminal submits. So the
/// photo it names has to still be there when the agent finally reads the path.
///
/// This is the opposite half of the reconciliation above, and the one a naive
/// "any non-immediate delivery means clean up" rule gets wrong: the caller is
/// told the input is queued behind a draft and nothing is recorded as
/// delivered, yet the file must survive.
#[tokio::test]
async fn an_attachment_held_behind_a_human_draft_stays_on_disk_for_the_queued_message() {
    use base64::Engine;
    use kanna_daemon::protocol::ErrorCode;
    use tokio::net::UnixListener;

    let unique = format!("task-input-attachment-held-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = spawn_refusing_session_daemon(
        listener,
        "task-live",
        ErrorCode::LogicalInputHeldByDraft,
        "logical input held for session task-live: a human line is open at that terminal",
    );

    let config = merge_test_config(&unique, &daemon_dir);
    seed_live_task(&config, "task-live");

    let image_bytes = b"\x89PNG held pixels".to_vec();
    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-live/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "look at this",
                        "attachment": {
                            "mediaType": "image/png",
                            "dataBase64": base64::engine::general_purpose::STANDARD
                                .encode(&image_bytes),
                        },
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let queued: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(queued["status"], "queued");
    assert_eq!(queued["reason"], "input_held_by_draft");

    // The queued message still names this path, so the file has to be here
    // when that terminal submits and the agent goes to read it.
    let directory =
        crate::task_input_attachments::task_attachments_dir(&config.db_path, "task-live");
    let stored: Vec<_> = std::fs::read_dir(&directory)
        .expect("a held attachment keeps its directory")
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(stored.len(), 1, "expected the held attachment to survive");
    assert_eq!(std::fs::read(&stored[0]).unwrap(), image_bytes);

    let db = Db::open(&config.db_path).unwrap();
    // Held is not delivered: the ledger records what reached the agent, and
    // this has not, so it stays empty until the daemon writes it.
    assert_eq!(db.count_task_inputs("task-live").unwrap(), 0);
    // And a human draft is not a wedged session, so nothing is marked blocked.
    assert_eq!(
        db.get_pipeline_item_input_blocked("task-live").unwrap(),
        None
    );
    drop(db);

    let _ = daemon_server.await.unwrap();
    let _ = std::fs::remove_dir_all(crate::task_input_attachments::attachments_root(
        &config.db_path,
    ));
    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

/// A refused attachment must leave nothing behind and must not put a message
/// in front of the agent that names a file which was never written.
#[tokio::test]
async fn send_task_input_refuses_an_oversized_attachment_and_stores_nothing() {
    use base64::Engine;
    use tokio::net::UnixListener;

    let unique = format!("task-input-attachment-oversized-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    // Only the session listing: the submission never happens.
    let daemon_server = spawn_live_session_daemon(listener, "task-live", 1);

    let config = merge_test_config(&unique, &daemon_dir);
    seed_live_task(&config, "task-live");

    let oversized = vec![0_u8; crate::task_input_attachments::MAX_TASK_INPUT_ATTACHMENT_BYTES + 1];
    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-live/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "too big",
                        "attachment": {
                            "mediaType": "image/jpeg",
                            "dataBase64": base64::engine::general_purpose::STANDARD
                                .encode(&oversized),
                        },
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let failure: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(failure["reason"], "attachment_too_large");
    assert!(
        !crate::task_input_attachments::task_attachments_dir(&config.db_path, "task-live").exists()
    );

    let commands = daemon_server.await.unwrap();
    assert_eq!(commands.len(), 1, "the session was never written to");

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[tokio::test]
async fn send_task_input_reports_daemon_write_failure_as_delivery_uncertain() {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, ErrorCode, Event as DaemonEvent, SessionInfo, SessionState,
        SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!("task-input-write-failure-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-write-failed".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: SessionStatus::Idle,
                        kind: Default::default(),
                        logical_input_blocked: false,
                        pending_logical_input_count: None,
                        composer_text: None,
                        composer_attestation: Default::default(),
                    }],
                },
                DaemonCommand::SubmitInputIfSession { .. } => DaemonEvent::Error {
                    code: Some(ErrorCode::WriteFailed),
                    message: "input write failed for session: task-write-failed".to_string(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-write-failed",
        "repo-1",
        "Write failure task",
        Some("Write failure task"),
        "in progress",
        "2026-08-12 04:00:00",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-live",
        task_id: "task-write-failed",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-write-failed"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-write-failed/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "input": "Do not duplicate this" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "ok": false,
            "reason": "delivery_uncertain",
            "message": "terminal input delivery is uncertain: input write failed for session: task-write-failed"
        })
    );
    assert!(matches!(
        daemon_server.await.unwrap().as_slice(),
        [DaemonCommand::List, DaemonCommand::SubmitInputIfSession {
            session_id,
            expected_pid: 42,
            data,
        }] if session_id == "task-write-failed" && data == b"Do not duplicate this"
    ));

    // A record asserting the agent was told something it may never have heard
    // is a worse record than none, so an uncertain delivery writes nothing.
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_task_inputs("task-write-failed").unwrap(), 0);
    drop(db);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

/// The 2026-08-19 wedge, from the sender's side: the daemon refused the
/// delivery, the caller got a 500 that read like a server fault, and the only
/// record of the wedged singleton was inside the failing agent's own stage.
/// The refusal is now its own answer, and the target carries it afterwards.
#[tokio::test]
async fn refused_input_reports_the_unblock_story_and_marks_the_target() {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, ErrorCode, Event as DaemonEvent, SessionInfo, SessionState,
        SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!("task-input-blocked-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-merge".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: SessionStatus::Idle,
                        kind: Default::default(),
                        logical_input_blocked: true,
                        pending_logical_input_count: None,
                        composer_text: None,
                        composer_attestation: Default::default(),
                    }],
                },
                DaemonCommand::SubmitInputIfSession { .. } => DaemonEvent::Error {
                    code: Some(ErrorCode::InheritedDraftStateUnknown),
                    message: "logical input refused for session task-merge: this daemon \
                              inherited the session and its composer holds text it never saw \
                              typed"
                        .to_string(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-merge",
        "repo-1",
        "Merge Master",
        Some("Merge Master"),
        "in progress",
        "2026-08-19 04:00:00",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-live",
        task_id: "task-merge",
        stage: "in progress",
        kind: "main",
        agent: Some("merge"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-merge"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let router = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = router
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-merge/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "input": "MERGE task-743d8c3e -> main" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let failure: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(failure["reason"], "input_blocked");
    assert!(
        failure["message"]
            .as_str()
            .unwrap()
            .contains("composer holds text it never saw typed"),
        "the refusal must carry the daemon's own explanation: {failure}"
    );
    assert!(matches!(
        daemon_server.await.unwrap().as_slice(),
        [
            DaemonCommand::List,
            DaemonCommand::SubmitInputIfSession { .. }
        ]
    ));

    let db = Db::open(&config.db_path).unwrap();
    // Nothing reached the PTY, so nothing is recorded as delivered.
    assert_eq!(db.count_task_inputs("task-merge").unwrap(), 0);
    assert_eq!(
        db.get_pipeline_item_input_blocked("task-merge")
            .unwrap()
            .as_deref(),
        Some(crate::http_api::INPUT_BLOCKED_INHERITED_DRAFT)
    );
    let item = db.get_pipeline_item("task-merge").unwrap().unwrap();
    assert_eq!(
        item.activity.as_deref(),
        Some("unread"),
        "a wedged singleton must stop reading as a healthy idle task"
    );
    drop(db);

    let response = router
        .oneshot(
            Request::get("/v1/tasks/task-merge")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        detail["inputBlocked"],
        serde_json::json!(crate::http_api::INPUT_BLOCKED_INHERITED_DRAFT)
    );

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

/// The 2026-08-20 owner report: a reply sent from the phone sat unsubmitted
/// at the agent's prompt until someone pressed Enter at that terminal, and the
/// phone had been told it was delivered.
///
/// Messages parked behind a human's unsent line are accepted into a visible,
/// durable FIFO. They become distinct delivered rows only as the daemon emits
/// one release edge for each message.
#[tokio::test]
async fn held_inputs_are_visible_and_flush_to_distinct_delivery_rows() {
    use kanna_daemon::protocol::{
        Command as DaemonCommand, ErrorCode, Event as DaemonEvent, SessionInfo, SessionState,
        SessionStatus,
    };
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!("task-input-held-{}", unique_test_suffix());
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let mut commands = Vec::new();
        for _ in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            for _ in 0..2 {
                let command = read_test_daemon_command(&mut reader, &mut write_half).await;
                let response = match &command {
                    DaemonCommand::List => DaemonEvent::SessionList {
                        sessions: vec![SessionInfo {
                            session_id: "task-held".to_string(),
                            pid: 42,
                            cwd: "/tmp".to_string(),
                            state: SessionState::Active,
                            idle_seconds: 0,
                            status: SessionStatus::Idle,
                            kind: Default::default(),
                            logical_input_blocked: false,
                            pending_logical_input_count: None,
                            composer_text: None,
                            composer_attestation: Default::default(),
                        }],
                    },
                    DaemonCommand::SubmitInputIfSession { .. } => DaemonEvent::Error {
                        code: Some(ErrorCode::LogicalInputHeldByDraft),
                        message:
                            "logical input for session task-held was not submitted: a human has \
                                  an unsent line at that terminal"
                                .to_string(),
                    },
                    other => panic!("unexpected daemon command: {other:?}"),
                };
                commands.push(command);
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        }
        commands
    });

    let config = merge_test_config(&unique, &daemon_dir);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-held",
        "repo-1",
        "Held Task",
        Some("implement"),
        "in progress",
        "2026-08-20 04:00:00",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-live",
        task_id: "task-held",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-held"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let router = super::router(Arc::new(super::AppState::new(config.clone())));
    for (index, input) in ["please also update the docs", "then run the tests"]
        .into_iter()
        .enumerate()
    {
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/tasks/task-held/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "input": input }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let queued: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            status,
            StatusCode::ACCEPTED,
            "unexpected response: {queued}"
        );
        assert_eq!(queued["status"], "queued");
        assert_eq!(queued["reason"], "input_held_by_draft");
        assert_eq!(queued["queuedInputCount"], index + 1);
        assert!(queued["message"]
            .as_str()
            .unwrap()
            .contains("unsent line at that terminal"));
    }
    assert!(matches!(
        daemon_server.await.unwrap().as_slice(),
        [
            DaemonCommand::List,
            DaemonCommand::SubmitInputIfSession { .. },
            DaemonCommand::List,
            DaemonCommand::SubmitInputIfSession { .. }
        ]
    ));

    let db = Db::open(&config.db_path).unwrap();
    assert!(
        db.list_task_inputs("task-held", 10).unwrap().is_empty(),
        "a message that was never written must not be recorded as delivered"
    );
    assert_eq!(db.count_queued_task_inputs("task-held").unwrap(), 2);
    let snapshot = db.ui_snapshot().unwrap();
    let held_task = snapshot.entries[0]
        .items
        .iter()
        .find(|item| item.id == "task-held")
        .unwrap();
    assert_eq!(held_task.queued_input_count, 2);
    assert_eq!(
        held_task.queued_input_reason.as_deref(),
        Some("input_held_by_draft")
    );

    assert!(db
        .deliver_next_released_task_input("task-held", 99, true)
        .unwrap()
        .is_none());
    assert!(
        db.list_task_inputs("task-held", 10).unwrap().is_empty(),
        "release evidence from a replacement incarnation must not record delivery"
    );
    db.deliver_next_released_task_input("task-held", 42, false)
        .unwrap();
    db.deliver_next_released_task_input("task-held", 42, false)
        .unwrap();
    let delivered = db.list_task_inputs("task-held", 10).unwrap();
    assert_eq!(
        delivered
            .iter()
            .map(|record| record.message.as_str())
            .collect::<Vec<_>>(),
        ["please also update the docs", "then run the tests"]
    );
    assert_ne!(delivered[0].id, delivered[1].id);
    assert_eq!(db.count_queued_task_inputs("task-held").unwrap(), 0);
    drop(db);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[tokio::test]
async fn submit_task_input_sends_one_semantic_daemon_message() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
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
        for _ in 0..1 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            match command {
                DaemonCommand::SubmitInput { session_id, data } => {
                    assert_eq!(session_id, "task-target");
                    inputs.push(data);
                }
                other => panic!("expected SubmitInput command, got {other:?}"),
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

    assert_eq!(inputs, vec![b"hello".to_vec()]);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}

#[tokio::test]
async fn terminal_exit_with_legacy_notify_registration_uses_events_not_task_input() {
    let unique = format!(
        "kanna-completion-event-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: std::env::temp_dir()
            .join(format!("{unique}-no-daemon"))
            .to_string_lossy()
            .to_string(),
        db_path: Db::test_db_path(&unique),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    for (id, title) in [("task-child", "Child"), ("task-parent", "Parent")] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            title,
            Some(title),
            "in progress",
            "2026-08-26 10:00:00",
        )
        .unwrap();
    }
    db.update_test_pipeline_item_notify_task("task-child", "task-parent")
        .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-child",
        task_id: "task-child",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-child"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let state = Arc::new(AppState::new(config.clone()));
    handle_task_terminal_state(state.as_ref(), "task-child", 17)
        .await
        .unwrap();

    let db = Db::open(&config.db_path).unwrap();
    let child = db.get_pipeline_item("task-child").unwrap().unwrap();
    assert_eq!(child.activity.as_deref(), Some("unread"));
    assert_eq!(child.runtime_status.as_deref(), Some("exited"));
    assert!(
        child.notified_at.is_none(),
        "legacy notification was claimed"
    );
    assert!(
        db.list_task_inputs("task-parent", 10).unwrap().is_empty(),
        "completion wrote into the target's durable input ledger"
    );
    drop(db);

    let response = router(state)
        .oneshot(
            Request::get("/v1/task-events?taskIds=task-child&timeoutSecs=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let finished = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "run.finished")
        .expect("run.finished remains observable through the wait surface");
    assert_eq!(finished["payload"]["status"], "failed");
    let result: serde_json::Value =
        serde_json::from_str(finished["payload"]["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["status"], "failure");
}

/// Closing a task past the final stage of a workflow that declares the
/// merge-signaling `approve` post.
///
/// The post is injected into whatever agent session the pr stage left running,
/// so whether the merge master hears about the PR cannot depend on that agent
/// having read and obeyed the post prompt — in the incident this covers, four
/// review-bearing tasks in a row had their pr-stage main run cut short, the
/// post landed in a pr agent that had not created the PR yet, and each task
/// closed with an open PR nobody was told about. These drive the real
/// complete-stage route, the real close path, and a real daemon socket, so
/// they fail if the engine ever goes back to trusting the prompt.
mod merge_handoff_on_close {
    use super::*;
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use std::sync::Mutex;
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    /// Workflow whose final `pr` stage promises the merge handoff, preceded by
    /// a review stage — the shape every failing task in the incident ran.
    fn review_bearing_workflow_def() -> String {
        serde_json::json!({
            "name": "single-reviewer",
            "stages": [
                {
                    "name": "review",
                    "agent": "review",
                    "prompt": "Review $BRANCH",
                    "policy": { "transition": "auto" }
                },
                {
                    "name": "pr",
                    "agent": "pr",
                    "prompt": "Create a PR for $BRANCH",
                    "policy": { "transition": "manual" },
                    "post": {
                        "name": "approve",
                        "agent": "approve",
                        "prompt": "Approve the PR for $BRANCH and signal the merge master."
                    }
                }
            ]
        })
        .to_string()
    }

    /// The control: same final stage, same approve post, no review stage. This
    /// is the path that kept working during the incident, and it must keep
    /// producing exactly one handoff.
    fn no_review_workflow_def() -> String {
        serde_json::json!({
            "name": "no-review",
            "stages": [
                {
                    "name": "pr",
                    "agent": "pr",
                    "prompt": "Create a PR for $BRANCH",
                    "policy": { "transition": "manual" },
                    "post": {
                        "name": "approve",
                        "agent": "approve",
                        "prompt": "Approve the PR for $BRANCH and signal the merge master."
                    }
                }
            ]
        })
        .to_string()
    }

    /// A workflow that never promised a handoff: closing must stay silent.
    fn plain_workflow_def() -> String {
        serde_json::json!({
            "name": "plain",
            "stages": [
                {
                    "name": "pr",
                    "agent": "pr",
                    "prompt": "Create a PR for $BRANCH",
                    "policy": { "transition": "manual" }
                }
            ]
        })
        .to_string()
    }

    struct Harness {
        config: Config,
        repo_root: std::path::PathBuf,
        daemon_dir: std::path::PathBuf,
        socket_path: PathBuf,
        inputs: Arc<Mutex<Vec<(String, Vec<u8>)>>>,
    }

    impl Harness {
        /// Seed a repo, a resident merge master on `merge-session`, and a
        /// source task parked at `pr` with a running approve post — the state
        /// a `complete-stage` verdict from that post arrives into.
        fn new(label: &str, pipeline_def: &str, pr_url: Option<&str>) -> Self {
            let unique = format!("merge-close-{label}-{}", unique_test_suffix());
            let repo_root = std::env::temp_dir().join(format!("{unique}-repo"));
            init_test_git_repo(&repo_root);
            let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
            std::fs::create_dir_all(&daemon_dir).unwrap();
            let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
            let _ = std::fs::remove_file(&socket_path);
            let listener = UnixListener::bind(&socket_path).unwrap();
            let inputs = spawn_recording_daemon(listener);

            let config = merge_test_config(&unique, &daemon_dir);
            let db = Db::open_for_tests(&config.db_path).unwrap();
            db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
                .unwrap();
            db.insert_test_pipeline_item(
                "task-source",
                "repo-1",
                "Source prompt",
                Some("Ship the thing"),
                "pr",
                "2026-08-07T00:00:00Z",
            )
            .unwrap();
            db.update_test_pipeline_item_stage_context(
                "task-source",
                "task-source",
                "single-reviewer",
                None,
                "claude",
            )
            .unwrap();
            db.update_test_pipeline_item_pipeline_def("task-source", pipeline_def)
                .unwrap();
            if let Some(pr_url) = pr_url {
                db.update_pipeline_item_pr("task-source", Some(91), pr_url)
                    .unwrap();
            }
            db.insert_stage_run(crate::db::NewStageRun {
                id: "run-approve",
                task_id: "task-source",
                stage: "approve",
                kind: "post",
                agent: Some("pr"),
                agent_provider: Some("claude"),
                model: None,
                effort: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-source"),
                provider_session_id: None,
                cwd: None,
                resumed_from_run_id: None,
            })
            .unwrap();
            db.insert_test_pipeline_item(
                "task-merge",
                "repo-1",
                "Merge master",
                Some("Merge Master"),
                "in progress",
                "2026-08-07T00:00:01Z",
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
                effort: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("merge-session"),
                provider_session_id: None,
                cwd: None,
                resumed_from_run_id: None,
            })
            .unwrap();
            drop(db);

            Self {
                config,
                repo_root,
                daemon_dir,
                socket_path,
                inputs,
            }
        }

        /// The approve post's verdict, exactly as the failing tasks reported
        /// it: a success naming the PR it created, with no approval and no
        /// merge signal.
        async fn complete_approve_post(&self, summary: &str) -> StatusCode {
            super::router(Arc::new(super::AppState::new(self.config.clone())))
                .oneshot(
                    Request::post("/v1/tasks/task-source/actions/complete-stage")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::json!({
                                "runId": "run-approve",
                                "status": "success",
                                "summary": summary,
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
                .status()
        }

        fn merge_messages(&self) -> Vec<String> {
            self.inputs
                .lock()
                .unwrap()
                .iter()
                .filter(|(session_id, data)| session_id == "merge-session" && data != b"\r")
                .map(|(_, data)| String::from_utf8_lossy(data).to_string())
                .collect()
        }

        async fn wait_for_merge_messages(&self, expected: usize) -> Vec<String> {
            for _ in 0..200 {
                let messages = self.merge_messages();
                if messages.len() >= expected {
                    return messages;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            panic!(
                "merge master never received {expected} message(s); got {:?}",
                self.merge_messages()
            );
        }

        fn db(&self) -> Db {
            Db::open(&self.config.db_path).unwrap()
        }

        fn cleanup(self) {
            let _ = std::fs::remove_file(&self.socket_path);
            let _ = std::fs::remove_dir_all(&self.daemon_dir);
            let _ = std::fs::remove_dir_all(&self.repo_root);
            let _ = std::fs::remove_file(&self.config.db_path);
        }
    }

    /// A daemon that answers every command and records the session input it
    /// was handed. The close path and the merge signal each open their own
    /// connection, so this accepts as many as the server makes.
    fn spawn_recording_daemon(listener: UnixListener) -> Arc<Mutex<Vec<(String, Vec<u8>)>>> {
        let inputs: Arc<Mutex<Vec<(String, Vec<u8>)>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&inputs);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let recorded = Arc::clone(&recorded);
                tokio::spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    while let Some(command) =
                        read_test_daemon_command_optional(&mut reader, &mut write_half).await
                    {
                        let response = match command {
                            DaemonCommand::SubmitInput { session_id, data } => {
                                recorded.lock().unwrap().push((session_id, data));
                                DaemonEvent::Ok
                            }
                            DaemonCommand::Spawn { session_id, .. }
                            | DaemonCommand::SpawnAgent { session_id, .. } => {
                                DaemonEvent::SessionCreated { session_id }
                            }
                            _ => DaemonEvent::Ok,
                        };
                        if write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&response).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                });
            }
        });
        inputs
    }

    async fn wait_for_closed(db: &Db, task_id: &str) {
        for _ in 0..200 {
            if db
                .get_pipeline_item(task_id)
                .unwrap()
                .unwrap()
                .closed_at
                .is_some()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("task {task_id} never closed");
    }

    fn task_events_of_type(db: &Db, task_id: &str, event_type: &str) -> Vec<serde_json::Value> {
        let head = db.latest_task_event_seq().unwrap();
        db.list_task_events(
            &crate::db::TaskEventScope::Tasks(vec![task_id.to_string()]),
            0,
            head,
            200,
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == event_type)
        .map(|event| event.payload)
        .collect()
    }

    fn merge_event_sources(db: &Db, task_id: &str) -> Vec<String> {
        task_events_of_type(db, task_id, "task.merge_signaled")
            .into_iter()
            .map(|payload| payload["source"].as_str().unwrap_or("").to_string())
            .collect()
    }

    /// The incident, reproduced: a review-bearing workflow whose approve post
    /// reports "Created PR ..." and signals nothing. The task must not close
    /// leaving that PR unannounced.
    #[tokio::test]
    async fn engine_signals_the_merge_master_when_the_approve_post_did_not() {
        let harness = Harness::new(
            "review-gap",
            &review_bearing_workflow_def(),
            Some("https://github.com/acme/repo/pull/91"),
        );

        assert_eq!(
            harness
                .complete_approve_post("Created PR https://github.com/acme/repo/pull/91")
                .await,
            StatusCode::OK
        );

        let messages = harness.wait_for_merge_messages(1).await;
        assert_eq!(messages.len(), 1, "expected exactly one merge request");
        assert!(
            messages[0].contains("[PR https://github.com/acme/repo/pull/91]")
                && messages[0].contains("[TASK task-source]")
                && messages[0].starts_with("MERGE "),
            "merge master received {:?}",
            messages[0]
        );

        let db = harness.db();
        wait_for_closed(&db, "task-source").await;
        assert!(db.task_merge_signaled_at("task-source").unwrap().is_some());
        assert_eq!(merge_event_sources(&db, "task-source"), vec!["engine"]);
        drop(db);
        harness.cleanup();
    }

    /// The control: the no-review path, where the approve post signals for
    /// itself. The engine must record that and send nothing of its own —
    /// a second MERGE line would be a duplicate request, not a backstop.
    #[tokio::test]
    async fn a_post_that_signalled_for_itself_is_not_signalled_again() {
        let harness = Harness::new(
            "no-review-control",
            &no_review_workflow_def(),
            Some("https://github.com/acme/repo/pull/91"),
        );

        let signal = super::router(Arc::new(super::AppState::new(harness.config.clone())))
            .oneshot(
                Request::post("/v1/tasks/task-source/actions/signal-merge-handoff")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "branch": "feature/head",
                            "target": "main",
                            "prUrl": "https://github.com/acme/repo/pull/91",
                            "summary": "Ready for repository policy"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(signal.status(), StatusCode::OK);
        let signalled = harness.wait_for_merge_messages(1).await;
        assert_eq!(signalled[0], "MERGE feature/head -> main [TASK task-source] [PR https://github.com/acme/repo/pull/91]: Ready for repository policy");

        assert_eq!(
            harness
                .complete_approve_post(
                    "Approved PR and signaled merge master: https://github.com/acme/repo/pull/91"
                )
                .await,
            StatusCode::OK
        );

        let db = harness.db();
        wait_for_closed(&db, "task-source").await;
        assert_eq!(
            harness.merge_messages().len(),
            1,
            "the engine must not duplicate a handoff the post already delivered"
        );
        assert_eq!(merge_event_sources(&db, "task-source"), vec!["agent"]);
        drop(db);
        harness.cleanup();
    }

    /// A workflow whose final stage declares no approve post promised no
    /// merge side effect, so closing it must have none.
    #[tokio::test]
    async fn a_workflow_without_the_approve_post_closes_without_signalling() {
        let harness = Harness::new(
            "no-post",
            &plain_workflow_def(),
            Some("https://github.com/acme/repo/pull/91"),
        );
        let db = harness.db();
        db.finish_stage_run("run-approve", "succeeded", None, None)
            .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-pr-main",
            task_id: "task-source",
            stage: "pr",
            kind: "main",
            agent: Some("pr"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-source"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        drop(db);

        let advance = super::router(Arc::new(super::AppState::new(harness.config.clone())))
            .oneshot(
                Request::post("/v1/tasks/task-source/actions/advance-stage")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(advance.status(), StatusCode::OK);

        let db = harness.db();
        wait_for_closed(&db, "task-source").await;
        assert!(harness.merge_messages().is_empty());
        assert!(db.task_merge_signaled_at("task-source").unwrap().is_none());
        drop(db);
        harness.cleanup();
    }

    /// The stage promised a handoff and there is nothing to hand off. That is
    /// a failed approval, not a finished workflow: the task stays open, unread,
    /// with the gap on the event feed.
    #[tokio::test]
    async fn a_promised_handoff_with_no_pr_refuses_to_close_the_task() {
        let harness = Harness::new("no-pr", &review_bearing_workflow_def(), None);

        assert_eq!(
            harness
                .complete_approve_post("Nothing to approve, but reporting success anyway")
                .await,
            StatusCode::OK
        );

        let db = harness.db();
        let mut gap_events = Vec::new();
        for _ in 0..200 {
            gap_events = task_events_of_type(&db, "task-source", "task.merge_handoff_missing");
            if !gap_events.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert_eq!(gap_events.len(), 1, "the skipped handoff must be reported");

        let task = db.get_pipeline_item("task-source").unwrap().unwrap();
        assert!(
            task.closed_at.is_none(),
            "a task that owes an unsent merge handoff must not close"
        );
        assert_eq!(task.stage.as_deref(), Some("pr"));
        assert_eq!(task.activity.as_deref(), Some("unread"));
        assert!(harness.merge_messages().is_empty());
        drop(db);
        harness.cleanup();
    }
}
