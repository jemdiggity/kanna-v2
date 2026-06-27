use super::*;

#[tokio::test]
async fn create_task_route_uses_task_creator() {
    let app = super::test_router_with_task_creator(
        "desktop-1",
        "Studio Mac",
        Arc::new(|payload| {
            assert_eq!(
                payload.blocker_task_ids,
                Some(vec!["blocker-1".to_string()])
            );
            Ok(CreateTaskResponse {
                task_id: "task-1".to_string(),
                repo_id: payload.repo_id,
                title: payload.prompt,
                stage: "in progress".to_string(),
                agent_type: "agent".to_string(),
                worktree_path: Some("/tmp/worktree".to_string()),
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Ship it",
                        "blockerTaskIds": ["blocker-1"]
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
    let created: CreateTaskResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "task-1");
    assert_eq!(created.repo_id, "repo-1");
    assert_eq!(created.title, "Ship it");
    assert_eq!(created.stage, "in progress");
}

#[tokio::test]
async fn create_task_route_uses_saved_default_agent_provider_when_payload_omits_provider() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root =
        std::env::temp_dir().join(format!("kanna-http-create-default-provider-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir = std::env::temp_dir().join(format!(
        "kanna-http-create-default-provider-daemon-{unique}"
    ));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id,
                cwd,
                agent_provider,
                ..
            } => {
                assert_eq!(agent_provider, Some(AgentProvider::Copilot));
                assert!(cwd.contains(".kanna-worktrees/task-"));
                session_id
            }
            other => panic!("expected spawn command, got {:?}", other),
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
        db_path: Db::test_db_path(&format!("http-api-default-provider-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-default-provider-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.set_test_setting("defaultAgentProvider", "copilot")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Use the saved default provider"
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
    let created: CreateTaskResponse = from_slice(&body).unwrap();
    let db = Db::open(&config.db_path).unwrap();
    let created_source = db.get_task_stage_source(&created.task_id).unwrap().unwrap();
    assert_eq!(created_source.agent_provider.as_deref(), Some("copilot"));

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_sends_kanna_cli_runtime_env_to_daemon_spawn() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-env-{unique}"));
    init_test_git_repo(&repo_root);

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let (kanna_mcp_path, created_test_mcp_sidecar) = ensure_test_sidecar("kanna-mcp");
    let kanna_cli_path_string = kanna_cli_path.to_string_lossy().to_string();
    let kanna_cli_dir = kanna_cli_path
        .parent()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-create-env-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let pipeline_socket_path = pipeline_socket_path_for_daemon_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);

    // Full desktop E2E would require launching the Tauri app plus staged sidecars
    // and a runnable agent CLI. This boundary test keeps the real HTTP handler,
    // task preparation, DB writes, worktree creation, and daemon Spawn contract in scope.
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn({
        let expected_cli_path = kanna_cli_path_string.clone();
        let expected_cli_dir = kanna_cli_dir.clone();
        let expected_db_path = Db::test_db_path(&format!("http-api-create-env-{unique}"));
        let expected_socket_path = pipeline_socket_path.clone();
        async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    let env = params.env;
                    assert_eq!(
                        env.get("KANNA_CLI_PATH").map(String::as_str),
                        Some(expected_cli_path.as_str())
                    );
                    assert_eq!(
                        env.get("KANNA_CLI_DB_PATH").map(String::as_str),
                        Some(expected_db_path.as_str())
                    );
                    assert_eq!(
                        env.get("KANNA_SOCKET_PATH").map(String::as_str),
                        Some(expected_socket_path.as_str())
                    );
                    assert_eq!(
                        env.get("KANNA_SERVER_BASE_URL").map(String::as_str),
                        Some("http://127.0.0.1:48120")
                    );
                    let path = env.get("PATH").expect("PATH should be set for sidecar");
                    assert_eq!(path.split(':').next(), Some(expected_cli_dir.as_str()));
                    session_id
                }
                other => panic!("expected SpawnAgent command, got {:?}", other),
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
        }
    });

    let db_path = Db::test_db_path(&format!("http-api-create-env-{unique}"));
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: db_path.clone(),
        kanna_cli_path: Some(kanna_cli_path_string.clone()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-create-env-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Exercise server-created task spawn env",
                        "agentProvider": "claude"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    if response.status() != StatusCode::OK {
        daemon_server.abort();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        panic!(
            "expected create task to send Spawn env, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: CreateTaskResponse = from_slice(&body).unwrap();
    assert_eq!(created.repo_id, "repo-1");
    assert_eq!(created.stage, "in progress");

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
    if created_test_mcp_sidecar {
        let _ = std::fs::remove_file(&kanna_mcp_path);
    }
}

#[tokio::test]
async fn create_task_route_rejects_invalid_blocker_before_creating_task_or_spawning() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root =
        std::env::temp_dir().join(format!("kanna-http-create-invalid-blocker-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-invalid-blocker-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-invalid-blocker-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-invalid-blocker-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Do not create this task",
                        "blockerTaskIds": ["missing-blocker"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("task not found: missing-blocker"),
        "unexpected body: {}",
        String::from_utf8_lossy(&body)
    );
    assert!(
        !socket_path.exists(),
        "route should reject before daemon connection can be required"
    );
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 0);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        0
    );
    assert!(
        !repo_root.join(".kanna-worktrees").exists(),
        "route should reject before creating a git worktree"
    );

    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_rolls_back_prepared_task_when_daemon_spawn_fails() {
    use kanna_daemon::protocol::{Command as DaemonCommand, ErrorCode, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-spawn-fail-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-spawn-fail-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
        let (session_id, cwd) = match command {
            DaemonCommand::SpawnAgent { session_id, params } => (session_id, params.cwd),
            DaemonCommand::Spawn {
                session_id, cwd, ..
            } => (session_id, cwd),
            other => panic!("expected spawn command, got {:?}", other),
        };
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&DaemonEvent::Error {
                        code: Some(ErrorCode::AgentSpawnFailed),
                        message: "failed to spawn agent: No such file or directory (os error 2)"
                            .to_string(),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        (session_id, cwd)
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-create-spawn-fail-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-create-spawn-fail-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Rollback this failed create",
                        "agentProvider": "codex"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let (task_id, worktree_path) = daemon_server.await.unwrap();
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 0);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        0
    );
    assert!(
        !std::path::Path::new(&worktree_path).exists(),
        "failed spawn should remove prepared worktree {worktree_path}"
    );
    assert!(
        db.get_task_stage_source(&task_id).unwrap().is_none(),
        "failed spawn should remove task row"
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_persists_blocker_before_daemon_spawn() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-blocker-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-blocker-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);

    let db_path = Db::test_db_path(&format!("http-api-create-blocker-{unique}"));
    let db_path_for_daemon = db_path.clone();
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id, cwd, ..
            } => {
                assert!(cwd.contains(".kanna-worktrees/task-"));
                let db = Db::open(&db_path_for_daemon).unwrap();
                assert_eq!(
                    db.count_test_task_blockers(&session_id, "blocker-1")
                        .unwrap(),
                    1,
                    "blocker row must exist before daemon spawn is issued"
                );
                session_id
            }
            DaemonCommand::SpawnAgent { session_id, params } => {
                assert!(params.cwd.contains(".kanna-worktrees/task-"));
                let db = Db::open(&db_path_for_daemon).unwrap();
                assert_eq!(
                    db.count_test_task_blockers(&session_id, "blocker-1")
                        .unwrap(),
                    1,
                    "blocker row must exist before daemon spawn is issued"
                );
                session_id
            }
            other => panic!("expected spawn command, got {:?}", other),
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
        db_path: db_path.clone(),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-create-blocker-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "blocker prompt",
        Some("Blocker Task"),
        "in progress",
        "2026-04-17 08:00:00",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Create after blocker validation",
                        "blockerTaskIds": ["blocker-1"]
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
    let created: CreateTaskResponse = from_slice(&body).unwrap();
    assert_eq!(created.repo_id, "repo-1");
    assert_eq!(created.stage, "in progress");

    daemon_server.await.unwrap();
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        db.count_test_task_blockers(&created.task_id, "blocker-1")
            .unwrap(),
        1
    );
    assert_eq!(
        db.get_test_pipeline_item_tags(&created.task_id).unwrap(),
        "[\"in progress\",\"blocked\"]"
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}
