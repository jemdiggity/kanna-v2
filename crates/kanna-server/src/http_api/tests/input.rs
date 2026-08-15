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

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-live/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "input": "One more change" }).to_string(),
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
async fn terminal_state_notification_sends_once_to_notify_target() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
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
        for _ in 0..1 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            match command {
                DaemonCommand::SubmitInput { session_id, data } => {
                    assert_eq!(session_id, "task-parent");
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
        transfer_port: 4455,
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

    super::handle_task_terminal_state(state.as_ref(), "task-child", 0)
        .await
        .unwrap();
    expect_task_state_changed(&mut state_changes).await;
    expect_task_state_changed(&mut state_changes).await;
    let inputs = server.await.unwrap();
    assert_eq!(
        inputs,
        vec![b"TASK task-child DONE [success]: Child Display".to_vec()]
    );

    super::handle_task_terminal_state(state.as_ref(), "task-child", 0)
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

/// Closing a task past the final stage of a pipeline that declares the
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

    /// Pipeline whose final `pr` stage promises the merge handoff, preceded by
    /// a review stage — the shape every failing task in the incident ran.
    fn review_bearing_pipeline_def() -> String {
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
    fn no_review_pipeline_def() -> String {
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

    /// A pipeline that never promised a handoff: closing must stay silent.
    fn plain_pipeline_def() -> String {
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

    /// The incident, reproduced: a review-bearing pipeline whose approve post
    /// reports "Created PR ..." and signals nothing. The task must not close
    /// leaving that PR unannounced.
    #[tokio::test]
    async fn engine_signals_the_merge_master_when_the_approve_post_did_not() {
        let harness = Harness::new(
            "review-gap",
            &review_bearing_pipeline_def(),
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
            &no_review_pipeline_def(),
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

    /// A pipeline whose final stage declares no approve post promised no
    /// merge side effect, so closing it must have none.
    #[tokio::test]
    async fn a_pipeline_without_the_approve_post_closes_without_signalling() {
        let harness = Harness::new(
            "no-post",
            &plain_pipeline_def(),
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
    /// a failed approval, not a finished pipeline: the task stays open, unread,
    /// with the gap on the event feed.
    #[tokio::test]
    async fn a_promised_handoff_with_no_pr_refuses_to_close_the_task() {
        let harness = Harness::new("no-pr", &review_bearing_pipeline_def(), None);

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

/// The three ways a task can end, as one contract.
///
/// `TASK <id> DONE [<status>]` is acted on without re-reading task state, so
/// each ending has to be distinguishable from the payload alone: a clean
/// pipeline finish is `success`, a task closed before it finished its pipeline
/// is `closed`, and only a real failing verdict is `failure`. Daemon `Exit`
/// cannot tell them apart on its own — all three end the same PTY — so these
/// drive the real routes and the real daemon socket rather than the derivation
/// in isolation.
mod completion_notification {
    use super::*;
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    struct NotificationHarness {
        config: Config,
        daemon_dir: PathBuf,
        socket_path: PathBuf,
    }

    impl NotificationHarness {
        fn new(label: &str) -> (Self, UnixListener) {
            let unique = format!("{label}-{}", unique_test_suffix());
            let daemon_dir = std::env::temp_dir().join(format!("kanna-notify-{unique}-daemon"));
            std::fs::create_dir_all(&daemon_dir).unwrap();
            let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
            let _ = std::fs::remove_file(&socket_path);
            let listener = UnixListener::bind(&socket_path).unwrap();
            let config = Config {
                relay_url: "wss://relay.example".to_string(),
                device_token: "device-token".to_string(),
                firebase_project_id: "kanna-local".to_string(),
                firebase_auth_emulator_url: None,
                firebase_firestore_emulator_host: None,
                daemon_dir: daemon_dir.to_string_lossy().to_string(),
                db_path: Db::test_db_path(&format!("notify-{unique}")),
                kanna_cli_path: None,
                desktop_id: "desktop-1".to_string(),
                desktop_secret: Some("desktop-secret".to_string()),
                desktop_name: "Studio Mac".to_string(),
                version: "test-version".to_string(),
                environment: "development".to_string(),
                lan_host: "127.0.0.1".to_string(),
                lan_port: 48120,
                transfer_port: 4455,
                pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
            };
            (
                Self {
                    config,
                    daemon_dir,
                    socket_path,
                },
                listener,
            )
        }

        fn cleanup(self) {
            let _ = std::fs::remove_file(&self.socket_path);
            let _ = std::fs::remove_dir_all(&self.daemon_dir);
        }
    }

    /// Ack every command on the close connection (kills, teardown spawn), then
    /// read the notification the server delivers on its own fresh connection.
    fn serve_close_then_notification(
        listener: UnixListener,
    ) -> tokio::task::JoinHandle<Vec<Vec<u8>>> {
        tokio::spawn(async move {
            let (stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .expect("close never reached the daemon")
                    .unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            // The close connection is drained until it ends; the notification
            // arrives on a second connection because the notify path opens its
            // own client.
            let drain = tokio::spawn(async move {
                loop {
                    let Some(command) =
                        read_test_daemon_command_optional(&mut reader, &mut write_half).await
                    else {
                        return;
                    };
                    let event = match command {
                        DaemonCommand::Spawn { session_id, .. } => {
                            DaemonEvent::SessionCreated { session_id }
                        }
                        _ => DaemonEvent::Ok,
                    };
                    if write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
            let inputs = read_notification(&listener).await;
            drain.abort();
            inputs
        })
    }

    async fn read_notification(listener: &UnixListener) -> Vec<Vec<u8>> {
        let (stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                .await
                .expect("completion notification was never delivered")
                .unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..1 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
                DaemonCommand::SubmitInput { session_id, data } => {
                    assert_eq!(session_id, "task-parent");
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
    }

    fn assert_notified(inputs: Vec<Vec<u8>>, expected: &str) {
        assert_eq!(
            inputs,
            vec![expected.as_bytes().to_vec()],
            "notification payload mismatch; expected {expected}"
        );
    }

    fn seed_notifying_child(db: &Db, run_status: &str) {
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Task event feed for orchestrating agents",
            Some("Task event feed for orchestrating agents"),
            "in progress",
            "2026-07-28 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_notify_task("task-child", "task-parent")
            .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-1",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("claude"),
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
        if run_status != "running" {
            db.finish_stage_run("run-1", run_status, Some("{}"), Some("done"))
                .unwrap();
        }
    }

    /// The regression: a task whose final run succeeded, closed by advancing
    /// past the last pipeline stage, used to report `[failure]` because the
    /// close path hardcoded it and daemon `Exit` was the only other signal.
    #[tokio::test]
    async fn advancing_past_the_final_stage_reports_success() {
        let (harness, listener) = NotificationHarness::new("final-stage");
        let repo_root =
            std::env::temp_dir().join(format!("kanna-notify-repo-{}", unique_test_suffix()));
        init_test_git_repo(&repo_root);

        let db = Db::open_for_tests(&harness.config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        seed_notifying_child(&db, "succeeded");
        db.update_test_pipeline_item_stage_context(
            "task-child",
            "task-child",
            TEST_PROVIDER_NEUTRAL_WORKFLOW,
            None,
            "claude",
        )
        .unwrap();
        drop(db);

        let daemon_server = serve_close_then_notification(listener);
        let app = router(Arc::new(AppState::new(harness.config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-child/actions/advance-stage")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        assert_notified(
            daemon_server.await.unwrap(),
            "TASK task-child DONE [success]: Task event feed for orchestrating agents",
        );
        let db = Db::open(&harness.config.db_path).unwrap();
        assert!(db
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap()
            .closed_at
            .is_some());
        let _ = std::fs::remove_dir_all(&repo_root);
        harness.cleanup();
    }

    /// A direct close reaches no verdict. It used to report `[failure]`, which
    /// sent receiving agents diagnosing a failure that never happened.
    #[tokio::test]
    async fn closing_a_task_directly_reports_closed() {
        let (harness, listener) = NotificationHarness::new("direct-close");
        let db = Db::open_for_tests(&harness.config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        // A succeeded run is on record: `closed` must come from *how* the task
        // ended, not from the last verdict it happened to leave behind.
        seed_notifying_child(&db, "succeeded");
        drop(db);

        let daemon_server = serve_close_then_notification(listener);
        let app = router(Arc::new(AppState::new(harness.config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-child/actions/close")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        assert_notified(
            daemon_server.await.unwrap(),
            "TASK task-child DONE [closed]: Task event feed for orchestrating agents",
        );
        harness.cleanup();
    }

    /// A real failure: the agent reported `failure` through `complete-stage`
    /// and then let its session end cleanly. The PTY exit code says 0; the
    /// terminating run says failed, and the run is what the payload reports.
    #[tokio::test]
    async fn a_failing_verdict_reports_failure_even_on_a_clean_session_exit() {
        let (harness, listener) = NotificationHarness::new("failed-verdict");
        let repo_root =
            std::env::temp_dir().join(format!("kanna-notify-repo-{}", unique_test_suffix()));
        init_test_git_repo(&repo_root);

        let db = Db::open_for_tests(&harness.config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        seed_notifying_child(&db, "running");
        drop(db);

        let state = Arc::new(AppState::new(harness.config.clone()));
        let complete = router(Arc::clone(&state))
            .oneshot(
                Request::post("/v1/tasks/task-child/actions/complete-stage")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "runId": "run-1",
                            "status": "failure",
                            "summary": "could not build the feed"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(complete.status(), StatusCode::OK);

        let daemon_server = tokio::spawn(async move { read_notification(&listener).await });
        handle_task_terminal_state(state.as_ref(), "task-child", 0)
            .await
            .unwrap();

        assert_notified(
            daemon_server.await.unwrap(),
            "TASK task-child DONE [failure]: Task event feed for orchestrating agents",
        );
        let _ = std::fs::remove_dir_all(&repo_root);
        harness.cleanup();
    }

    /// An agent process that dies is a failure whatever verdicts precede it:
    /// the run it was executing never finished.
    #[tokio::test]
    async fn a_dead_agent_process_reports_failure() {
        let (harness, listener) = NotificationHarness::new("dead-agent");
        let db = Db::open_for_tests(&harness.config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        seed_notifying_child(&db, "succeeded");
        drop(db);

        let state = Arc::new(AppState::new(harness.config.clone()));
        let daemon_server = tokio::spawn(async move { read_notification(&listener).await });
        handle_task_terminal_state(state.as_ref(), "task-child", 1)
            .await
            .unwrap();

        assert_notified(
            daemon_server.await.unwrap(),
            "TASK task-child DONE [failure]: Task event feed for orchestrating agents",
        );
        harness.cleanup();
    }
}
