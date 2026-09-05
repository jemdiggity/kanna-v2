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
            let prompt = payload.prompt;
            Ok(CreateTaskResponse {
                task_id: "task-1".to_string(),
                repo_id: payload.repo_id,
                title: prompt.clone(),
                prompt,
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
    assert_eq!(created.prompt, "Ship it");
    assert_eq!(created.stage, "in progress");
}

async fn assert_created_task_overrides_reach_daemon_spawn(
    provider: AgentProvider,
    model: Option<(&str, &str)>,
    effort: Option<(&str, &str)>,
) {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-http-create-overrides-{}-{unique}",
        provider.as_str()
    ));
    init_test_git_repo(&repo_root);
    let daemon_dir = std::env::temp_dir().join(format!(
        "kanna-http-create-overrides-daemon-{}-{unique}",
        provider.as_str()
    ));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let expected_flags = [model.map(|(_, flag)| flag), effort.map(|(_, flag)| flag)]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id,
                args,
                agent_provider,
                ..
            } => {
                assert_eq!(agent_provider, Some(provider));
                let argv = args.join(" ");
                for expected_flag in expected_flags {
                    assert!(
                        argv.contains(&expected_flag),
                        "spawn argv did not contain {expected_flag:?}: {args:?}"
                    );
                }
                session_id
            }
            other => panic!("expected PTY Spawn command, got {other:?}"),
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
        db_path: Db::test_db_path(&format!(
            "http-api-create-overrides-{}-{unique}",
            provider.as_str()
        )),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-overrides-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let mut request = serde_json::json!({
        "repoId": "repo-1",
        "prompt": format!("Run {} with explicit overrides", provider.as_str()),
        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
        "agentProvider": provider.as_str(),
    });
    if let Some((model, _)) = model {
        request["model"] = serde_json::json!(model);
    }
    if let Some((effort, _)) = effort {
        request["effort"] = serde_json::json!(effort);
    }
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: CreateTaskResponse = from_slice(&body).unwrap();
    let detail =
        crate::mobile_api::MobileApi::new(config.clone(), Db::open(&config.db_path).unwrap())
            .get_task(&created.task_id)
            .unwrap()
            .unwrap();
    assert_eq!(detail.agent_provider.as_deref(), Some(provider.as_str()));
    assert_eq!(detail.model.as_deref(), model.map(|(value, _)| value));
    assert_eq!(detail.effort.as_deref(), effort.map(|(value, _)| value));

    daemon.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_model_reaches_claude_and_codex_daemon_spawn_argv() {
    assert_created_task_overrides_reach_daemon_spawn(
        AgentProvider::Claude,
        Some(("claude-fable-5", "--model 'claude-fable-5'")),
        None,
    )
    .await;
    assert_created_task_overrides_reach_daemon_spawn(
        AgentProvider::Codex,
        Some(("gpt-5.6-codex", "-m 'gpt-5.6-codex'")),
        None,
    )
    .await;
}

#[tokio::test]
async fn create_task_effort_reaches_every_provider_daemon_spawn_argv() {
    let contracts: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../tests/cli-contract/fixtures/task-effort-spawn.json"
    ))
    .unwrap();
    assert_eq!(
        contracts
            .iter()
            .find(|contract| contract["provider"] == "codex")
            .and_then(|contract| contract["effort"].as_str()),
        Some("max"),
        "Codex integration coverage must exercise a model-specific value outside the old fixed list"
    );
    for contract in contracts {
        let provider: AgentProvider = serde_json::from_value(contract["provider"].clone()).unwrap();
        let effort = contract["effort"].as_str().unwrap();
        let expected_flag = contract["ptyFlag"].as_str().unwrap();
        assert_created_task_overrides_reach_daemon_spawn(
            provider,
            None,
            Some((effort, expected_flag)),
        )
        .await;
    }
}

#[tokio::test]
async fn create_task_route_rejects_unsupported_provider_effort_without_persisting_task() {
    let unique = unique_test_suffix();
    let repo_root =
        std::env::temp_dir().join(format!("kanna-http-reject-antigravity-effort-{unique}"));
    init_test_git_repo(&repo_root);
    let state =
        super::test_state_with_seed("desktop-reject-antigravity-effort", "Studio Mac", |db| {
            db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
                .unwrap();
        });
    let app = router(Arc::clone(&state));

    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Use an unsupported effort override",
                        "agentProvider": "antigravity",
                        "agentType": "pty",
                        "effort": "xhigh"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        std::str::from_utf8(&body).unwrap(),
        "effort 'xhigh' is not supported for agent provider 'antigravity' (supported: low, medium, high)"
    );
    let db = Db::open(&state.config.db_path).unwrap();
    assert!(db.list_pipeline_items("repo-1").unwrap().is_empty());

    let _ = std::fs::remove_dir_all(&repo_root);
    let _ = std::fs::remove_file(&state.config.db_path);
}

#[tokio::test]
async fn create_task_route_rejects_invalid_requested_task_ids_before_creation() {
    let create_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let create_calls_for_creator = Arc::clone(&create_calls);
    let app = super::test_router_with_task_creator(
        "desktop-invalid-task-id",
        "Studio Mac",
        Arc::new(move |payload| {
            create_calls_for_creator.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let prompt = payload.prompt;
            Ok(CreateTaskResponse {
                task_id: "generated1".to_string(),
                repo_id: payload.repo_id,
                title: prompt.clone(),
                prompt,
                stage: "in progress".to_string(),
                agent_type: "agent".to_string(),
                worktree_path: Some("/tmp/worktree".to_string()),
            })
        }),
    );

    for task_id in [
        "0123456",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
        "ABCDEF12",
        "0123456-",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::put(format!("/v1/tasks/{task_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "Ship it"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{task_id}");
    }

    assert_eq!(create_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn requested_task_id_validation_keeps_64_hex_mobile_compatibility() {
    let legacy_mobile_task_id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    assert_eq!(legacy_mobile_task_id.len(), 64);
    assert!(crate::http_api::tasks::validate_requested_task_id(legacy_mobile_task_id).is_ok());
}

#[tokio::test]
async fn create_task_route_rejects_invalid_recovery_snapshot_geometry() {
    let create_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let create_calls_for_creator = Arc::clone(&create_calls);
    let app = super::test_router_with_task_creator(
        "desktop-invalid-recovery",
        "Studio Mac",
        Arc::new(move |_| {
            create_calls_for_creator.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            panic!("invalid recovery snapshot reached task creation")
        }),
    );

    for recovery_snapshot in [
        serde_json::json!({
            "serialized": "snapshot",
            "cols": 0,
            "rows": 24,
            "cursorRow": 0,
            "cursorCol": 0,
            "cursorVisible": true,
            "savedAt": 1,
            "sequence": 1
        }),
        serde_json::json!({
            "serialized": "snapshot",
            "cols": 80,
            "rows": 24,
            "cursorRow": 24,
            "cursorCol": 0,
            "cursorVisible": true,
            "savedAt": 1,
            "sequence": 1
        }),
        serde_json::json!({
            "serialized": "snapshot",
            "cols": 80,
            "rows": 24,
            "cursorRow": 0,
            "cursorCol": 80,
            "cursorVisible": true,
            "savedAt": 1,
            "sequence": 1
        }),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "invalid recovery",
                            "recoverySnapshot": recovery_snapshot
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(create_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn concurrent_requested_task_creation_is_rejected_until_owner_failure_releases_flight() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    let task_id = "c1d2e3f4a5b60718";
    let create_calls = Arc::new(AtomicUsize::new(0));
    let create_calls_for_creator = Arc::clone(&create_calls);
    let (owner_started_tx, owner_started_rx) = mpsc::channel();
    let (release_owner_tx, release_owner_rx) = mpsc::channel();
    let release_owner_rx = Arc::new(std::sync::Mutex::new(Some(release_owner_rx)));
    let release_owner_rx_for_creator = Arc::clone(&release_owner_rx);
    let app = super::test_router_with_task_creator(
        "desktop-concurrent-task-id",
        "Studio Mac",
        Arc::new(move |payload| {
            let call = create_calls_for_creator.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                owner_started_tx.send(()).unwrap();
                let release = release_owner_rx_for_creator.lock().unwrap().take().unwrap();
                release.recv_timeout(Duration::from_secs(5)).unwrap();
                return Err("owner failed".to_string());
            }

            let prompt = payload.prompt;
            Ok(CreateTaskResponse {
                task_id: task_id.to_string(),
                repo_id: payload.repo_id,
                title: prompt.clone(),
                prompt,
                stage: "in progress".to_string(),
                agent_type: "agent".to_string(),
                worktree_path: Some("/tmp/worktree".to_string()),
            })
        }),
    );
    let request_body = serde_json::json!({
        "repoId": "repo-1",
        "prompt": "Ship exactly once"
    })
    .to_string();

    let owner_app = app.clone();
    let owner_body = request_body.clone();
    let owner = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(
                owner_app.oneshot(
                    Request::put(format!("/v1/tasks/{task_id}"))
                        .header("content-type", "application/json")
                        .body(Body::from(owner_body))
                        .unwrap(),
                ),
            )
            .unwrap()
    });
    owner_started_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap();

    let concurrent_response = app
        .clone()
        .oneshot(
            Request::put(format!("/v1/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(request_body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    let concurrent_status = concurrent_response.status();
    let concurrent_body = axum::body::to_bytes(concurrent_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let create_calls_while_owner_held = create_calls.load(Ordering::SeqCst);

    release_owner_tx.send(()).unwrap();
    let owner_response = owner.join().unwrap();

    assert_eq!(concurrent_status, StatusCode::CONFLICT);
    assert_eq!(
        String::from_utf8(concurrent_body.to_vec()).unwrap(),
        format!("task creation already in progress: {task_id}")
    );
    assert_eq!(create_calls_while_owner_held, 1);
    assert_eq!(owner_response.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let retry_response = app
        .oneshot(
            Request::put(format!("/v1/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(request_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(retry_response.status(), StatusCode::OK);
    assert_eq!(create_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn abort_waits_for_requested_creation_and_owns_the_id_until_release() {
    let task_id = "c1d2e3f4a5b60718";
    let state = super::test_state_with_seed("desktop-abort-create-flight", "Studio Mac", |_| {});
    let create_flight = state
        .begin_requested_task_creation(task_id)
        .expect("begin requested create");
    let abort_state = Arc::clone(&state);
    let abort = tokio::spawn(async move { abort_state.begin_requested_task_abort(task_id).await });

    tokio::task::yield_now().await;
    assert!(!abort.is_finished());

    drop(create_flight);
    let abort_flight = tokio::time::timeout(std::time::Duration::from_secs(1), abort)
        .await
        .expect("abort should acquire released task id")
        .expect("abort acquisition task");
    assert!(
        state.begin_requested_task_creation(task_id).is_none(),
        "create must be rejected while abort owns the requested id"
    );

    drop(abort_flight);
    assert!(
        state.begin_requested_task_creation(task_id).is_some(),
        "requested id should be reusable after abort releases it"
    );
}

#[tokio::test]
async fn create_task_route_round_trips_and_replays_eight_hex_requested_id() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let task_id = "a1b2c3d4";
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-replay-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-create-replay-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        match command {
            DaemonCommand::SeedSnapshot {
                session_id,
                snapshot,
            } => {
                assert_eq!(session_id, task_id);
                assert_eq!(snapshot.version, 1);
                assert_eq!(snapshot.vt, "RECOVERY\u{1b}[31m");
                assert_eq!((snapshot.cols, snapshot.rows), (101, 37));
                assert_eq!((snapshot.cursor_row, snapshot.cursor_col), (9, 17));
                assert!(!snapshot.cursor_visible);
                assert_eq!(snapshot.saved_at, 1_785_000_000_000);
                assert_eq!(snapshot.sequence, 44);
            }
            other => panic!("expected seed snapshot command, got {other:?}"),
        }
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes())
            .await
            .unwrap();

        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id, cwd, ..
            } => {
                assert_eq!(session_id, task_id);
                assert!(cwd.ends_with(&format!("/task-{task_id}")));
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
        db_path: Db::test_db_path(&format!("http-api-create-replay-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-replay-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let request_body = serde_json::json!({
        "repoId": "repo-1",
        "prompt": "Ship idempotently",
        "displayName": "Idempotent task",
        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
        "agentProvider": "claude",
        "recoverySnapshot": {
            "serialized": "RECOVERY\u{001b}[31m",
            "cols": 101,
            "rows": 37,
            "cursorRow": 9,
            "cursorCol": 17,
            "cursorVisible": false,
            "savedAt": 1785000000000_u64,
            "sequence": 44
        }
    })
    .to_string();
    let first_response = app
        .clone()
        .oneshot(
            Request::put(format!("/v1/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(request_body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_body = axum::body::to_bytes(first_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: CreateTaskResponse = from_slice(&first_body).unwrap();
    assert_eq!(created.task_id, task_id);

    daemon_server.await.unwrap();
    std::fs::remove_file(&socket_path).unwrap();

    let replay_response = app
        .oneshot(
            Request::put(format!("/v1/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(request_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(replay_response.status(), StatusCode::OK);
    let replay_body = axum::body::to_bytes(replay_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let replayed: CreateTaskResponse = from_slice(&replay_body).unwrap();
    assert_eq!(replayed, created);

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 1);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 1);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        1
    );
    assert_eq!(db.list_stage_runs_for_task(task_id).unwrap().len(), 1);
    assert!(
        db.get_create_task_intent(task_id).unwrap().is_none(),
        "successful initial spawn should clear the create intent"
    );

    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn requested_task_retry_repairs_prepare_before_daemon_spawn() {
    use kanna_daemon::protocol::{Command as DaemonCommand, ErrorCode, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let task_id = "d1e2f3a4b5c60718";
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-repair-{unique}"));
    init_test_git_repo(&repo_root);
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-create-repair-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-create-repair-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-repair-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let resume_session_id = "364643cc-5e6d-48fc-86ca-ca7764380900";
    let request_body = serde_json::json!({
        "repoId": "repo-1",
        "prompt": "Repair the interrupted spawn",
        "displayName": "Prepared intent repair",
        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
        "agentProvider": "claude",
        "agentType": "pty",
        "terminalCols": 132,
        "terminalRows": 43,
        "model": "claude-repair-model",
        "permissionMode": "acceptEdits",
        "allowedTools": ["Read", "Bash"],
        "disallowedTools": ["WebFetch"],
        "maxTurns": 17,
        "maxBudgetUsd": 4.25,
        "setupCmds": ["printf 'prepared-intent-setup\\n'"],
        "resumeSessionId": resume_session_id,
        "recoverySnapshot": {
            "serialized": "REPAIRED-RECOVERY\u{001b}[2J",
            "cols": 132,
            "rows": 43,
            "cursorRow": 21,
            "cursorCol": 42,
            "cursorVisible": true,
            "savedAt": 1785000000123_u64,
            "sequence": 87
        }
    })
    .to_string();
    let first = app
        .clone()
        .oneshot(
            Request::put(format!("/v1/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(request_body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 1);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 1);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        1
    );
    assert!(db.list_stage_runs_for_task(task_id).unwrap().is_empty());
    let stored_intent: serde_json::Value = serde_json::from_str(
        &db.get_create_task_intent(task_id)
            .unwrap()
            .expect("prepared task should retain its create intent"),
    )
    .unwrap();
    assert_eq!(
        stored_intent["resumeSessionId"],
        serde_json::json!(resume_session_id)
    );
    assert_eq!(
        stored_intent["setupCmds"],
        serde_json::json!(["printf 'prepared-intent-setup\\n'"])
    );
    assert_eq!(
        stored_intent["allowedTools"],
        serde_json::json!(["Read", "Bash"])
    );
    assert_eq!(
        stored_intent["_kannaResolved"]["model"],
        serde_json::json!("claude-repair-model")
    );
    assert_eq!(
        stored_intent["_kannaResolved"]["initialTerminalGeometry"],
        serde_json::json!([132, 43])
    );
    assert_eq!(
        stored_intent["_kannaResolved"]["recoverySnapshot"]["serialized"],
        serde_json::json!("REPAIRED-RECOVERY\u{1b}[2J")
    );
    let interrupted_worktree = db
        .get_task_worktree_path(task_id)
        .unwrap()
        .expect("prepared worktree path");
    let remove = std::process::Command::new("git")
        .args(["worktree", "remove", "--force", &interrupted_worktree])
        .current_dir(&repo_root)
        .output()
        .expect("remove prepared worktree");
    assert!(
        remove.status.success(),
        "remove prepared worktree failed: {}",
        String::from_utf8_lossy(&remove.stderr)
    );
    let branch = format!("task-{task_id}");
    let delete_branch = std::process::Command::new("git")
        .args(["branch", "-D", &branch])
        .current_dir(&repo_root)
        .output()
        .expect("delete prepared branch");
    assert!(
        delete_branch.status.success(),
        "delete prepared branch failed: {}",
        String::from_utf8_lossy(&delete_branch.stderr)
    );
    db.delete_worktree_rows_for_task(task_id)
        .expect("remove interrupted worktree row");
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
    std::fs::write(
        repo_root
            .join(".kanna/workflows")
            .join(format!("{TEST_PROVIDER_NEUTRAL_WORKFLOW}.json")),
        serde_json::json!({
            "name": TEST_PROVIDER_NEUTRAL_WORKFLOW,
            "stages": [{
                "name": "in progress",
                "prompt": "MUTATED-DEFINITION-$TASK_PROMPT",
                "setup": ["printf 'mutated-definition-setup\\n'"],
                "policy": { "transition": "auto" }
            }]
        })
        .to_string(),
    )
    .expect("mutate definitions after interrupted preparation");
    drop(db);

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut command_count = 0usize;
        loop {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            command_count += 1;
            match command {
                DaemonCommand::Kill { .. } => {
                    write_half
                        .write_all(
                            format!(
                                "{}\n",
                                serde_json::to_string(&DaemonEvent::Error {
                                    code: Some(ErrorCode::SessionNotFound),
                                    message: "session not found".to_string(),
                                })
                                .unwrap()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                DaemonCommand::SeedSnapshot {
                    session_id,
                    snapshot,
                } => {
                    assert_eq!(session_id, task_id);
                    assert_eq!(snapshot.version, 1);
                    assert_eq!(snapshot.vt, "REPAIRED-RECOVERY\u{1b}[2J");
                    assert_eq!((snapshot.cols, snapshot.rows), (132, 43));
                    assert_eq!((snapshot.cursor_row, snapshot.cursor_col), (21, 42));
                    assert!(snapshot.cursor_visible);
                    assert_eq!(snapshot.saved_at, 1_785_000_000_123);
                    assert_eq!(snapshot.sequence, 87);
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                DaemonCommand::Spawn {
                    session_id,
                    args,
                    cols,
                    rows,
                    ..
                } => {
                    assert_eq!(session_id, task_id);
                    assert_eq!((cols, rows), (132, 43));
                    let command = args.join(" ");
                    for expected in [
                        "prepared-intent-setup",
                        "--resume '364643cc-5e6d-48fc-86ca-ca7764380900'",
                        "--model 'claude-repair-model'",
                        "--allowedTools Read,Bash",
                        "--disallowedTools WebFetch",
                        "--max-turns 17",
                        "--max-budget-usd 4.25",
                        "Repair the interrupted spawn",
                    ] {
                        assert!(
                            command.contains(expected),
                            "repaired spawn did not preserve `{expected}`: {command}"
                        );
                    }
                    assert!(
                        !command.contains("MUTATED-DEFINITION")
                            && !command.contains("mutated-definition-setup"),
                        "repaired spawn re-read mutated repo definitions: {command}"
                    );
                    write_half
                        .write_all(
                            format!(
                                "{}\n",
                                serde_json::to_string(&DaemonEvent::SessionCreated { session_id })
                                    .unwrap()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    break;
                }
                DaemonCommand::SpawnAgent { .. } => {
                    panic!("prepared intent requested a PTY spawn")
                }
                other => panic!("unexpected repair command: {other:?}"),
            }
        }
        command_count
    });

    let retry = app
        .oneshot(
            Request::put(format!("/v1/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(request_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(retry.status(), StatusCode::OK);
    let command_count = daemon_server.await.unwrap();
    assert_eq!(command_count, 3);

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 1);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 1);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        1
    );
    let runs = db.list_stage_runs_for_task(task_id).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "running");
    assert_eq!(runs[0].session_id.as_deref(), Some(task_id));
    assert_eq!(
        runs[0].provider_session_id.as_deref(),
        Some(resume_session_id)
    );
    assert!(
        db.get_create_task_intent(task_id).unwrap().is_none(),
        "running stage run should clear the prepared create intent"
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_rejects_requested_task_id_with_mismatched_task_data() {
    let task_id = "b1c2d3e4f5a60718";
    let app = super::test_router_with_seed("desktop-create-task-mismatch", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            task_id,
            "repo-1",
            "Original prompt",
            Some("Original title"),
            "review",
            "2026-07-15 00:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_agent_type(task_id, "agent")
            .unwrap();
    });

    for (repo_id, prompt) in [
        ("repo-1", "Different prompt"),
        ("repo-2", "Original prompt"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::put(format!("/v1/tasks/{task_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": repo_id,
                            "prompt": prompt
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
}

#[test]
fn create_task_prepare_error_replays_only_requested_id_collision() {
    let task_id = "d1e2f3a4b5c60718";
    let state = super::test_state_with_seed("desktop-create-task-race", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            task_id,
            "repo-1",
            "Race prompt",
            Some("Race title"),
            "review",
            "2026-07-15 00:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_agent_type(task_id, "agent")
            .unwrap();
        db.upsert_worktree(
            "wt-create-race",
            task_id,
            "/tmp/task-create-race",
            "task-d1e2f3a4b5c60718",
        )
        .unwrap();
    });
    let db = Db::open(&state.config.db_path).unwrap();

    let replayed = super::super::tasks::resolve_create_task_prepare_error(
        &db,
        crate::task_creator::PrepareTaskError::RequestedTaskIdAlreadyExists,
        Some((task_id, "repo-1", "Race prompt")),
    )
    .unwrap();
    assert_eq!(
        replayed,
        CreateTaskResponse {
            task_id: task_id.to_string(),
            repo_id: "repo-1".to_string(),
            title: "Race title".to_string(),
            prompt: "Race prompt".to_string(),
            stage: "review".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: Some("/tmp/task-create-race".to_string()),
        }
    );

    let unrelated = super::super::tasks::resolve_create_task_prepare_error(
        &db,
        crate::task_creator::PrepareTaskError::Other("setup failed".to_string()),
        Some((task_id, "repo-1", "Race prompt")),
    )
    .unwrap_err();
    assert_eq!(unrelated.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(unrelated.1, "setup failed");

    let invalid = super::super::tasks::resolve_create_task_prepare_error(
        &db,
        crate::task_creator::PrepareTaskError::InvalidRequest(
            "model overrides are not supported for agent provider 'antigravity'".to_string(),
        ),
        None,
    )
    .unwrap_err();
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        invalid.1,
        "model overrides are not supported for agent provider 'antigravity'"
    );
}

#[tokio::test]
async fn create_task_route_uses_saved_default_agent_provider_when_payload_omits_provider() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
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
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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
                        "prompt": "Use the saved default provider",
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW
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
    assert_eq!(created.task_id.len(), 8);
    assert!(created
        .task_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    let db = Db::open(&config.db_path).unwrap();
    let created_source = db.get_task_stage_source(&created.task_id).unwrap().unwrap();
    assert_eq!(created_source.agent_provider.as_deref(), Some("copilot"));

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_runs_a_non_review_builtin_agent_in_the_first_stage() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-commit-agent-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-commit-agent-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id,
                args,
                agent_provider,
                ..
            } => {
                assert_eq!(agent_provider, Some(AgentProvider::Claude));
                let command = args.join(" ");
                assert!(
                    command.contains("Your job is to commit the relevant changes"),
                    "spawn did not contain the built-in commit definition: {command}"
                );
                assert!(
                    command.contains("Commit this task through the named agent"),
                    "spawn lost the task prompt: {command}"
                );
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
        db_path: Db::test_db_path(&format!("http-api-create-commit-agent-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-commit-agent-{unique}.json"),
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
                        "prompt": "Commit this task through the named agent",
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agent": "commit"
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
    let run = db
        .latest_stage_run(&created.task_id)
        .unwrap()
        .expect("first stage run");
    assert_eq!(run.agent.as_deref(), Some("commit"));
    assert_eq!(run.stage, "in progress");
    assert_eq!(run.status, "running");

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_persists_display_name_alias_and_returns_it_as_title() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-title-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-create-title-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id, cwd, ..
            } => {
                assert!(cwd.contains(".kanna-worktrees/task-"));
                session_id
            }
            DaemonCommand::SpawnAgent { session_id, params } => {
                assert!(params.cwd.contains(".kanna-worktrees/task-"));
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
        db_path: Db::test_db_path(&format!("http-api-create-title-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-title-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "This is the full agent prompt that should not become the title",
                        "display_name": "Short task title",
                        "agentProvider": "claude"
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
    assert_eq!(created.title, "Short task title");

    daemon_server.await.unwrap();

    let db = Db::open(&config.db_path).unwrap();
    let item = db.get_pipeline_item(&created.task_id).unwrap().unwrap();
    assert_eq!(
        item.prompt.as_deref(),
        Some("This is the full agent prompt that should not become the title")
    );
    assert_eq!(item.display_name.as_deref(), Some("Short task title"));

    let get_response = app
        .clone()
        .oneshot(
            Request::get(format!("/v1/tasks/{}", created.task_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(get_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();
    assert_eq!(detail.title, "Short task title");

    let list_response = app
        .oneshot(
            Request::get("/v1/tasks/recent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(
        tasks.first().map(|task| task.title.as_str()),
        Some("Short task title")
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_preserves_stage_override_for_transferred_tasks() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-stage-override-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/qa.json"),
        serde_json::json!({
            "stages": [
                {
                    "name": "in progress",
                    "transition": "manual",
                    "agent_provider": "claude",
                    "prompt": "Implement this first: $TASK_PROMPT"
                },
                {
                    "name": "pr",
                    "transition": "manual",
                    "agent_provider": "claude",
                    "prompt": "Open the pull request"
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add qa workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-stage-override-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();

    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::SpawnAgent { session_id, params } => {
                assert_eq!(params.prompt, "Ship safely");
                let system_prompt = params.system_prompt.expect("system prompt");
                assert!(system_prompt.contains("stage `pr`"));
                assert!(!system_prompt.contains("stage `in progress`"));
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
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-stage-override-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-stage-override-{unique}.json"),
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
                        "prompt": "Ship safely",
                        "workflowName": "single-reviewer",
                        "stage": "pr",
                        "agentProvider": "claude",
                        "agentType": "agent"
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
    assert_eq!(created.stage, "pr");

    let db = Db::open(&config.db_path).unwrap();
    let created_source = db.get_task_stage_source(&created.task_id).unwrap().unwrap();
    assert_eq!(created_source.stage.as_deref(), Some("pr"));

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_sends_kanna_cli_runtime_env_to_daemon_spawn() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard().await;

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
    let workflow_socket_path = workflow_socket_path_for_daemon_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);

    // Full desktop E2E would require launching the Tauri app plus staged sidecars
    // and a runnable agent CLI. This boundary test keeps the real HTTP handler,
    // task preparation, DB writes, worktree creation, and daemon Spawn contract in scope.
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn({
        let expected_cli_path = kanna_cli_path_string.clone();
        let expected_cli_dir = kanna_cli_dir.clone();
        let expected_socket_path = workflow_socket_path.clone();
        async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let session_id = match command {
                DaemonCommand::Spawn {
                    session_id,
                    cwd,
                    env,
                    ..
                } => {
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    assert_eq!(
                        env.get("KANNA_CLI_PATH").map(String::as_str),
                        Some(expected_cli_path.as_str())
                    );
                    assert_eq!(env.get("KANNA_CLI_DB_PATH"), None);
                    assert_eq!(
                        env.get("KANNA_SOCKET_PATH").map(String::as_str),
                        Some(expected_socket_path.as_str())
                    );
                    assert_eq!(
                        env.get("KANNA_SERVER_BASE_URL").map(String::as_str),
                        Some("http://127.0.0.1:48120")
                    );
                    let path = env.get("PATH").expect("PATH should be set for sidecar");
                    assert!(
                        std::env::split_paths(path)
                            .any(|entry| entry == std::path::Path::new(&expected_cli_dir)),
                        "PATH should include the Kanna CLI directory: {path}"
                    );
                    session_id
                }
                other => panic!("expected Spawn command, got {:?}", other),
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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
async fn create_task_route_preserves_failed_prepare_diagnostics() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-bad-base-{unique}"));
    init_test_git_repo(&repo_root);

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: std::env::temp_dir()
            .join(format!("kanna-http-create-bad-base-daemon-{unique}"))
            .to_string_lossy()
            .to_string(),
        db_path: Db::test_db_path(&format!("http-api-create-bad-base-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-bad-base-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .clone()
        .oneshot(
            Request::put("/v1/tasks/f1a2b3c4d5e60718")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Keep diagnostics for this failed task",
                        "baseRef": "refs/heads/does-not-exist"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("task "));
    assert!(body.contains("failed to prepare"));

    let db = Db::open(&config.db_path).unwrap();
    let items = db.list_recent_pipeline_items().unwrap();
    assert_eq!(items.len(), 1);
    let task_id = items[0].id.clone();
    assert_eq!(task_id, "f1a2b3c4d5e60718");
    assert_eq!(items[0].activity.as_deref(), Some("unread"));
    let runs = db.list_stage_runs_for_task(&task_id).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    assert!(runs[0]
        .result
        .as_deref()
        .unwrap_or_default()
        .contains("failed to prepare task"));
    drop(db);

    let logs_response = app
        .oneshot(
            Request::get(format!("/v1/tasks/{task_id}/logs"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logs_response.status(), StatusCode::OK);
    let logs = axum::body::to_bytes(logs_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let logs = String::from_utf8_lossy(&logs);
    assert!(logs.contains("failed to prepare task"));
    assert!(logs.contains("refs/heads/does-not-exist"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_refuses_an_unresolvable_recorded_default_branch() {
    let unique = unique_test_suffix();
    let repo_root =
        std::env::temp_dir().join(format!("kanna-http-create-unresolvable-default-{unique}"));
    init_test_git_repo(&repo_root);
    let state =
        super::test_state_with_seed("desktop-create-unresolvable-default", "Studio Mac", |db| {
            db.insert_repo(crate::db::NewRepo {
                id: "repo-1",
                path: &repo_root.to_string_lossy(),
                name: "Repo One",
                default_branch: Some("recorded-but-missing"),
            })
            .unwrap();
        });
    let app = super::router(Arc::clone(&state));

    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Do not guess a task base",
                        "agentProvider": "codex",
                        "agentType": "agent"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = String::from_utf8_lossy(&body);
    assert!(
        body.contains("cannot resolve default branch `recorded-but-missing`"),
        "unexpected creation error: {body}"
    );
    assert!(
        body.contains("origin/recorded-but-missing"),
        "error must identify the attempted remote branch: {body}"
    );
    assert!(
        !repo_root.join(".kanna-worktrees").exists(),
        "an unresolved base must not create a worktree from checkout HEAD"
    );

    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_file(&state.config.db_path);
}

#[tokio::test]
async fn create_task_route_with_blocker_creates_dormant_task_without_spawning() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-dormant-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-dormant-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-create-dormant-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-dormant-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "Build prerequisite",
        Some("Prerequisite"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "blocker-1",
        "task-blocker-branch",
        "default",
        None,
        "claude",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::put("/v1/tasks/a2b3c4d5e6f70819")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Wait for the prerequisite",
                        "blockerTaskIds": ["blocker-1"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    if response.status() != StatusCode::OK {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        panic!(
            "expected blocked task creation to skip daemon spawn, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: CreateTaskResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "a2b3c4d5e6f70819");
    assert_eq!(created.repo_id, "repo-1");
    assert_eq!(created.stage, "in progress");
    assert_eq!(created.worktree_path, None);

    let db = Db::open(&config.db_path).unwrap();
    let created_item = db.get_pipeline_item(&created.task_id).unwrap().unwrap();
    assert_eq!(created_item.activity.as_deref(), Some("idle"));
    assert_eq!(created_item.base_ref, None);
    assert_eq!(
        db.count_test_task_blockers(&created.task_id, "blocker-1")
            .unwrap(),
        1
    );
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        0
    );
    assert!(
        !repo_root
            .join(".kanna-worktrees")
            .join(created_item.branch.as_deref().unwrap())
            .exists(),
        "blocked task should not create a worktree until it first runs"
    );
    assert!(
        !socket_path.exists(),
        "blocked task creation should not require a daemon connection"
    );

    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_with_only_closed_blockers_spawns_immediately() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-create-closed-blocker-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-create-closed-blocker-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::Spawn {
                session_id,
                cwd,
                agent_provider,
                ..
            } => {
                assert!(cwd.contains(".kanna-worktrees/task-"));
                assert_eq!(agent_provider, Some(AgentProvider::Claude));
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
        db_path: Db::test_db_path(&format!("http-api-create-closed-blocker-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-create-closed-blocker-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "Build prerequisite",
        Some("Prerequisite"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.close_pipeline_item("blocker-1").unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "All blockers are already closed",
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
                        "agentType": "pty",
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
    assert!(created.worktree_path.is_some());
    daemon_server.await.unwrap();

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        db.count_test_task_blockers(&created.task_id, "blocker-1")
            .unwrap(),
        1
    );
    let created_item = db.get_pipeline_item(&created.task_id).unwrap().unwrap();
    assert_eq!(created_item.activity.as_deref(), Some("working"));
    assert!(db
        .get_task_worktree_path(&created.task_id)
        .unwrap()
        .is_some());

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_preserves_failed_recovery_seed_diagnostics_without_spawning() {
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
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let session_id = match command {
            DaemonCommand::SeedSnapshot {
                session_id,
                snapshot,
            } => {
                assert_eq!(snapshot.vt, "SEED-MUST-ACK");
                session_id
            }
            other => panic!("expected recovery seed command, got {other:?}"),
        };
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&DaemonEvent::Error {
                        code: None,
                        message: "recovery store unavailable".to_string(),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut unexpected = String::new();
        let bytes = reader.read_line(&mut unexpected).await.unwrap();
        assert_eq!(
            bytes, 0,
            "Spawn followed a failed recovery seed: {unexpected}"
        );
        session_id
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-create-spawn-fail-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Rollback this failed create",
                        "agentProvider": "codex",
                        "recoverySnapshot": {
                            "serialized": "SEED-MUST-ACK",
                            "cols": 80,
                            "rows": 24,
                            "cursorRow": 0,
                            "cursorCol": 0,
                            "cursorVisible": true,
                            "savedAt": 1785000000999_u64,
                            "sequence": 9
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("task "));
    assert!(body.contains("recovery seed"));
    let task_id = daemon_server.await.unwrap();
    let db = Db::open(&config.db_path).unwrap();
    let worktree_path = db
        .get_task_worktree_path(&task_id)
        .unwrap()
        .expect("failed seed preserves prepared worktree row");
    assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 1);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 1);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        1
    );
    assert!(
        std::path::Path::new(&worktree_path).exists(),
        "failed spawn should preserve prepared worktree {worktree_path}"
    );
    let created_item = db.get_pipeline_item(&task_id).unwrap().unwrap();
    assert_eq!(created_item.activity.as_deref(), Some("unread"));
    let runs = db.list_stage_runs_for_task(&task_id).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    assert!(runs[0]
        .result
        .as_deref()
        .unwrap_or_default()
        .contains("failed to spawn task"));
    drop(db);

    let logs_response = app
        .oneshot(
            Request::get(format!("/v1/tasks/{task_id}/logs"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logs_response.status(), StatusCode::OK);
    let logs = axum::body::to_bytes(logs_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let logs = String::from_utf8_lossy(&logs);
    assert!(logs.contains("failed to spawn task"));
    assert!(logs.contains("recovery store unavailable"));

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::process::Command::new("git")
        .args(["worktree", "remove", "--force", &worktree_path])
        .current_dir(&repo_root)
        .status();
    let _ = std::process::Command::new("git")
        .args(["branch", "-D", &format!("task-{task_id}")])
        .current_dir(&repo_root)
        .status();
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn create_task_route_persists_blocker_without_daemon_spawn() {
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        db.count_test_task_blockers(&created.task_id, "blocker-1")
            .unwrap(),
        1
    );
    assert_eq!(created.worktree_path, None);
    assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
    assert_eq!(
        db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
        0
    );
    assert!(
        !socket_path.exists(),
        "blocked task creation should not open or require a daemon socket"
    );

    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}
