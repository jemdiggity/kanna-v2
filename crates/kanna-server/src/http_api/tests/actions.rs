use super::*;

#[tokio::test]
async fn http_invoke_dispatches_shared_mobile_post_routes_with_json_body() {
    let received = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let received_for_sender = Arc::clone(&received);
    let state = super::test_state_with_task_input_sender(
        "desktop-1",
        "Studio Mac",
        Arc::new(move |task_id, input| {
            received_for_sender.lock().unwrap().push((task_id, input));
            Ok(())
        }),
    );

    let response = super::dispatch_http_invoke(
        state,
        "POST",
        "/v1/tasks/task-1/input",
        serde_json::json!({
            "input": "continue"
        }),
    )
    .await;

    assert_eq!(response.status, 204);
    assert_eq!(response.body, None);
    assert_eq!(response.error, None);
    assert_eq!(
        *received.lock().unwrap(),
        vec![("task-1".to_string(), "continue".to_string())]
    );
}

#[tokio::test]
async fn close_task_route_uses_task_closer() {
    let app = super::test_router_with_task_closer(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            assert_eq!(task_id, "task-1");
            Ok(())
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn close_pr_task_sends_retarget_instruction_to_running_dependents() {
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
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-close-pr-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-close-pr-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-close-pr-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-a",
        "repo-1",
        "blocker prompt",
        Some("Blocker PR"),
        "pr",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-a",
        "task-a-branch",
        "default",
        None,
        "claude",
    )
    .unwrap();
    db.insert_test_pipeline_item(
        "task-b",
        "repo-1",
        "dependent prompt",
        Some("Dependent"),
        "in progress",
        "2026-07-01T00:01:00Z",
    )
    .unwrap();
    db.insert_test_task_blocker("task-b", "task-a").unwrap();
    db.upsert_worktree(
        "wt-task-b",
        "task-b",
        "/tmp/task-b-worktree",
        "task-b-branch",
    )
    .unwrap();
    db.insert_test_terminal_session(
        "agent-task-b",
        "repo-1",
        "task-b",
        "agent",
        "task-b-session",
    )
    .unwrap();
    drop(db);

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        for index in 0..5 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match (index, command) {
                (0, DaemonCommand::Input { session_id, data }) => {
                    assert_eq!(session_id, "task-b-session");
                    let message = String::from_utf8(data).unwrap();
                    assert!(message.contains("retarget this stacked branch"));
                    assert!(message.contains("task-a-branch"));
                    assert!(message.contains("main"));
                }
                (1, DaemonCommand::Input { session_id, data }) => {
                    assert_eq!(session_id, "task-b-session");
                    assert_eq!(data, vec![b'\r']);
                }
                (2..=4, DaemonCommand::Kill { .. }) => {}
                (_, other) => panic!("unexpected daemon command at {index}: {:?}", other),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
    });

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    daemon_server.await.unwrap();
    let db = Db::open(&config.db_path).unwrap();
    let blocker = db.get_pipeline_item("task-a").unwrap().unwrap();
    assert_eq!(blocker.stage.as_deref(), Some("done"));

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
}

#[tokio::test]
async fn set_task_parent_route_sets_and_clears_parent() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "parent-1",
            "repo-1",
            "parent prompt",
            Some("Parent"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "child-1",
            "repo-1",
            "child prompt",
            Some("Child"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/child-1/actions/set-parent")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "parentTaskId": "parent-1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    assert_eq!(
        db.pipeline_item_parent("child-1").unwrap().as_deref(),
        Some("parent-1")
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/child-1/actions/set-parent")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    assert_eq!(db.pipeline_item_parent("child-1").unwrap(), None);
}

#[tokio::test]
async fn set_task_parent_route_rejects_cycles_self_and_cross_repo() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        for (id, repo_id) in [
            ("parent-1", "repo-1"),
            ("child-1", "repo-1"),
            ("other-1", "repo-2"),
        ] {
            db.insert_test_pipeline_item(
                id,
                repo_id,
                "prompt",
                Some(id),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
        }
        db.update_pipeline_item_parent("child-1", Some("parent-1"))
            .unwrap();
    });
    let app = super::router(state);

    let cycle = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/parent-1/actions/set-parent")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "parentTaskId": "child-1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cycle.status(), StatusCode::BAD_REQUEST);

    let self_parent = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/parent-1/actions/set-parent")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "parentTaskId": "parent-1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(self_parent.status(), StatusCode::BAD_REQUEST);

    let cross_repo = app
        .oneshot(
            Request::post("/v1/tasks/child-1/actions/set-parent")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "parentTaskId": "other-1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cross_repo.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn close_task_route_rejects_parent_with_open_subtasks() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "parent-1",
            "repo-1",
            "parent prompt",
            Some("Parent"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "child-1",
            "repo-1",
            "child prompt",
            Some("Child"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.update_pipeline_item_parent("child-1", Some("parent-1"))
            .unwrap();
    });
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/parent-1/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn close_task_route_resolves_branch_style_task_id() {
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
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-close-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let expected = ["710917fb", "shell-wt-710917fb", "td-710917fb"];

        for expected_session_id in expected {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Kill { session_id } => {
                    assert_eq!(session_id, expected_session_id)
                }
                other => panic!("expected kill command, got {:?}", other),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
    });

    let db_path = Db::test_db_path(&format!("http-close-branch-{unique}"));
    let db = Db::open_for_tests(&db_path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "",
        None,
        "in progress",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "710917fb",
        "task-710917fb",
        "default",
        None,
        "claude",
    )
    .unwrap();
    drop(db);

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
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-close-{unique}.json"),
    };
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-710917fb/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    daemon_server.await.unwrap();

    let db = Db::open(&db_path).expect("reopen db");
    let item = db.get_pipeline_item("710917fb").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("done"));

    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn block_task_route_marks_task_blocked_by_requested_tasks() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "blocked prompt",
            Some("Blocked Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
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
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/block")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "blockerTaskIds": ["blocker-1"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    assert_eq!(
        db.count_test_task_blockers("task-1", "blocker-1").unwrap(),
        1
    );
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.activity.as_deref(), Some("idle"));
    assert_eq!(
        db.get_test_pipeline_item_tags("task-1").unwrap(),
        "[\"blocked\"]"
    );
}

#[tokio::test]
async fn block_task_route_rejects_circular_dependencies() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "task prompt",
            Some("Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "blocker-1",
            "repo-1",
            "blocker prompt",
            Some("Blocker"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_task_blocker("blocker-1", "task-1").unwrap();
    });
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/block")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "blockerTaskIds": ["blocker-1"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unblock_task_route_removes_blockers_and_blocked_tag() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "blocked prompt",
            Some("Blocked Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
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
        db.insert_test_task_blocker("task-1", "blocker-1").unwrap();
        db.set_test_pipeline_item_tags("task-1", "[\"blocked\"]")
            .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/unblock")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    assert_eq!(
        db.count_test_task_blockers("task-1", "blocker-1").unwrap(),
        0
    );
    assert_eq!(db.get_test_pipeline_item_tags("task-1").unwrap(), "[]");
}

#[tokio::test]
async fn complete_pr_stage_starts_dormant_dependent_from_blocker_branch() {
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
    let repo_root = std::env::temp_dir().join(format!("kanna-http-pr-unblocks-{unique}"));
    init_test_git_repo(&repo_root);
    assert!(Command::new("git")
        .args(["checkout", "-b", "task-a"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    std::fs::write(repo_root.join("feature-a.txt"), "from blocker").unwrap();
    assert!(Command::new("git")
        .args(["add", "feature-a.txt"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "feature a"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["checkout", "main"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let blocker_head = Command::new("git")
        .args(["rev-parse", "task-a"])
        .current_dir(&repo_root)
        .output()
        .unwrap();
    assert!(blocker_head.status.success());
    let blocker_head = String::from_utf8_lossy(&blocker_head.stdout)
        .trim()
        .to_string();

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-pr-unblocks-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-pr-unblocks-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-pr-unblocks-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-a",
        "repo-1",
        "Build prerequisite",
        Some("Prerequisite"),
        "pr",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-a", "task-a", "default", None, "claude")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let create_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Build on task A",
                        "blockerTaskIds": ["task-a"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(create_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let dependent: CreateTaskResponse = from_slice(&body).unwrap();
    assert_eq!(dependent.worktree_path, None);

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let expected_task_id = dependent.task_id.clone();
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
                assert_eq!(session_id, expected_task_id);
                assert!(cwd.contains(".kanna-worktrees/task-"));
                assert_eq!(agent_provider, Some(AgentProvider::Claude));
                session_id
            }
            DaemonCommand::SpawnAgent { session_id, params } => {
                assert_eq!(session_id, expected_task_id);
                assert!(params.cwd.contains(".kanna-worktrees/task-"));
                assert_eq!(params.agent_provider, AgentProvider::Claude);
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
    });

    let complete_response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "status": "success",
                        "summary": "PR is ready"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(complete_response.status(), StatusCode::OK);
    daemon_server.await.unwrap();

    let db = Db::open(&config.db_path).unwrap();
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.base_ref.as_deref(), Some("task-a"));
    assert_eq!(dependent_item.activity.as_deref(), Some("working"));
    let worktree_path = db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .expect("dependent worktree");
    let dependent_head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&worktree_path)
        .output()
        .unwrap();
    assert!(dependent_head.status.success());
    assert_eq!(
        String::from_utf8_lossy(&dependent_head.stdout).trim(),
        blocker_head
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
}

#[tokio::test]
async fn advance_stage_route_uses_stage_advancer() {
    let app = super::test_router_with_stage_advancer(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            assert_eq!(task_id, "task-1");
            Ok(TaskActionResponse {
                task_id: "task-2".to_string(),
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
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
    assert_eq!(created.task_id, "task-2");
}

#[tokio::test]
async fn complete_stage_route_uses_stage_completer() {
    let app = super::test_router_with_stage_completer(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id, payload| {
            assert_eq!(task_id, "task-1");
            assert_eq!(payload.status, "success");
            assert_eq!(payload.summary, "review passed");
            assert_eq!(
                payload.metadata,
                Some(serde_json::json!({ "coverage": "sufficient" }))
            );
            Ok(TaskActionResponse {
                task_id: "task-2".to_string(),
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "status": "success",
                        "summary": "review passed",
                        "metadata": { "coverage": "sufficient" }
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
    let created: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "task-2");
}

#[tokio::test]
async fn complete_stage_missing_task_returns_not_found() {
    let app = super::test_router("desktop-1", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/tasks/missing-task/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "status": "success",
                        "summary": "done"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn complete_stage_for_already_closed_task_is_idempotent() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Implement it",
            Some("Implement it"),
            "in progress",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        db.close_pipeline_item("task-1").unwrap();
    });

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "status": "success",
                        "summary": "done again"
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
    let completed: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(completed.task_id, "task-1");
}
