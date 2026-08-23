use super::*;

/// Stage transitions execute on detached tasks (see
/// execute_stage_transition_detached). The stage write lands before the run
/// insert, so route tests must poll for both parts of the durable transition.
pub(super) async fn wait_for_running_task_stage(
    db: &Db,
    task_id: &str,
    expected_stage: &str,
) -> crate::db::TaskStageSource {
    for _ in 0..100 {
        let task = db.get_task_stage_source(task_id).unwrap().unwrap();
        let has_running_stage_run = db
            .list_stage_runs_for_task(task_id)
            .unwrap()
            .iter()
            .any(|run| run.stage == expected_stage && run.status == "running");
        if task.stage.as_deref() == Some(expected_stage) && has_running_stage_run {
            return task;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let task = db.get_task_stage_source(task_id).unwrap().unwrap();
    let runs = db.list_stage_runs_for_task(task_id).unwrap();
    panic!(
        "task {task_id} never completed transition to running stage {expected_stage}; \
         last stage: {:?}, runs: {:?}",
        task.stage, runs
    );
}

async fn wait_for_stage_run(db: &Db, task_id: &str, expected_stage: &str) -> crate::db::StageRun {
    for _ in 0..100 {
        let runs = db.list_stage_runs_for_task(task_id).unwrap();
        if let Some(run) = runs.into_iter().find(|run| run.stage == expected_stage) {
            return run;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("task {task_id} never recorded a run for stage {expected_stage}");
}

fn insert_running_pr_run(db: &Db, task_id: &str, run_id: &str) {
    db.insert_stage_run(crate::db::NewStageRun {
        id: run_id,
        task_id,
        stage: "pr",
        kind: "main",
        agent: Some("pr"),
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

async fn recv_state_change_scope(
    rx: &mut tokio::sync::broadcast::Receiver<kanna_agent_protocol::ServerFrame>,
) -> kanna_agent_protocol::StateChangeScope {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
        .await
        .expect("timed out waiting for state change")
        .expect("state change channel closed");
    let kanna_agent_protocol::ServerFrame::StateChanged { scope } = frame else {
        panic!("expected state change frame, got {frame:?}");
    };
    scope
}

async fn wait_for_task_closed(db: &Db, task_id: &str) -> crate::db::PipelineItem {
    for _ in 0..100 {
        let task = db.get_pipeline_item(task_id).unwrap().unwrap();
        if task.closed_at.is_some() {
            return task;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let task = db.get_pipeline_item(task_id).unwrap().unwrap();
    panic!(
        "task {task_id} was never closed; last closed_at: {:?}",
        task.closed_at
    );
}

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

    let response = crate::http_api::dispatch_authenticated_http_invoke(
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
async fn close_task_route_reports_success_when_post_commit_worktree_cleanup_fails() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = super::unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-broken-repo-{unique}"));
    std::fs::create_dir_all(&repo_root).unwrap();
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-close-cleanup-d-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        for expected in ["task-1", "shell-wt-task-1", "td-task-1"] {
            match read_test_daemon_command(&mut reader, &mut write_half).await {
                DaemonCommand::Kill { session_id } => assert_eq!(session_id, expected),
                other => panic!("expected kill command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-close-cleanup-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-close-cleanup-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    // This is deliberately a directory but not a git repository, so the
    // post-close `git worktree prune` fails after `closed_at` commits.
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "task prompt",
        Some("Task"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let db = Db::open(&config.db_path).unwrap();
    assert!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .closed_at
            .is_some(),
        "the successful response must reflect the committed close"
    );

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn abort_task_creation_succeeds_when_requested_id_is_absent() {
    let app = super::test_router("desktop-1", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/tasks/a1b2c3d4/actions/abort-creation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn abort_task_creation_succeeds_when_requested_id_is_already_closed() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "a1b2c3d4",
            "repo-1",
            "Interrupted create",
            Some("Interrupted create"),
            "in progress",
            "2026-07-25T00:00:00Z",
        )
        .unwrap();
        db.close_pipeline_item("a1b2c3d4").unwrap();
    });

    let response = app
        .oneshot(
            Request::post("/v1/tasks/a1b2c3d4/actions/abort-creation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn abort_task_creation_closes_an_existing_requested_id() {
    let app = super::test_router_with_task_closer(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            assert_eq!(task_id, "a1b2c3d4");
            Ok(())
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/a1b2c3d4/actions/abort-creation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn close_task_route_releases_claimed_ports() {
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
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-close-ports-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        for expected_session_id in ["task-1", "shell-wt-task-1", "td-task-1"] {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            match command {
                DaemonCommand::Kill { session_id } => assert_eq!(session_id, expected_session_id),
                other => panic!("expected kill command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
    });

    let db_path = Db::test_db_path(&format!("http-close-ports-{unique}"));
    let db = Db::open_for_tests(&db_path).expect("open test db");
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
    assert!(db
        .claim_task_port("task-1", "KANNA_DEV_PORT", 1421)
        .unwrap());
    assert!(db
        .claim_task_port("task-1", "KANNA_MOBILE_PORT", 19001)
        .unwrap());
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-close-ports-{unique}.json"),
    };
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let db = Db::open(&db_path).unwrap();
    assert!(db
        .get_pipeline_item("task-1")
        .unwrap()
        .unwrap()
        .closed_at
        .is_some());
    assert!(
        db.list_task_ports_for_item("task-1").unwrap().is_empty(),
        "closing a task must free its claimed ports for later tasks"
    );
    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
}

#[tokio::test]
async fn reopen_task_route_reopens_and_reclaims_ports_from_remote_default_config() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-reopen-ports-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"ports":{"KANNA_DEV_PORT":1420,"API_PORT":3000}}"#,
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/config.json"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "publish port config"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);

    let worktree_path = repo_root.join(".kanna-worktrees").join("task-closed");
    std::fs::create_dir_all(worktree_path.join(".kanna")).unwrap();
    std::fs::write(
        worktree_path.join(".kanna/config.json"),
        r#"{"ports":{"LOCAL_STALE_PORT":9999}}"#,
    )
    .unwrap();

    let db_path = Db::test_db_path(&format!("http-reopen-ports-{unique}"));
    let db = Db::open_for_tests(&db_path).expect("open test db");
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-closed",
        "repo-1",
        "task prompt",
        Some("Task"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-task-closed",
        "task-closed",
        &worktree_path.to_string_lossy(),
        "task-closed",
    )
    .unwrap();
    db.close_pipeline_item("task-closed").unwrap();
    db.insert_test_pipeline_item(
        "task-other",
        "repo-1",
        "other prompt",
        Some("Other"),
        "in progress",
        "2026-04-17 08:00:00",
    )
    .unwrap();
    assert!(db
        .claim_task_port("task-other", "KANNA_DEV_PORT", 1420)
        .unwrap());
    assert!(db.claim_task_port("task-other", "API_PORT", 3000).unwrap());
    drop(db);

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
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
        pairing_store_path: format!("/tmp/kanna-pairings-reopen-ports-{unique}.json"),
    };
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-closed/actions/reopen")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-closed").unwrap().unwrap();
    assert!(item.closed_at.is_none());
    let (port_offset, port_env) = db.get_test_pipeline_item_ports("task-closed").unwrap();
    assert_eq!(port_offset, Some(1421));
    assert_eq!(
        port_env.as_deref(),
        Some(r#"{"API_PORT":"3001","KANNA_DEV_PORT":"1421"}"#)
    );
    let ports = db.list_task_ports_for_item("task-closed").unwrap();
    assert_eq!(ports.get("KANNA_DEV_PORT"), Some(&1421));
    assert_eq!(ports.get("API_PORT"), Some(&3001));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn reopen_task_route_rejects_cloud_identity_conflict_without_claiming_ports() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-reopen-identity-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"ports":{"KANNA_DEV_PORT":1420}}"#,
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/config.json"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "publish port config"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);

    let db_path = Db::test_db_path(&format!("http-reopen-identity-{unique}"));
    let db = Db::open_for_tests(&db_path).expect("open test db");
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-old",
        "repo-1",
        "old prompt",
        Some("Old Task"),
        "in progress",
        "2026-07-25 07:00:00",
    )
    .unwrap();
    assert_eq!(
        db.set_cloud_task_identity("task-old", "task-source-stable")
            .unwrap(),
        crate::db::CloudTaskIdentityWrite::Updated
    );
    db.close_pipeline_item("task-old").unwrap();
    let original = db.get_pipeline_item("task-old").unwrap().unwrap();
    let original_ports = db.get_test_pipeline_item_ports("task-old").unwrap();

    db.insert_test_pipeline_item(
        "task-new",
        "repo-1",
        "new prompt",
        Some("New Task"),
        "in progress",
        "2026-07-25 08:00:00",
    )
    .unwrap();
    assert_eq!(
        db.set_cloud_task_identity("task-new", "task-source-stable")
            .unwrap(),
        crate::db::CloudTaskIdentityWrite::Updated
    );
    drop(db);

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
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
        pairing_store_path: format!("/tmp/kanna-pairings-reopen-identity-{unique}.json"),
    };
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-old/actions/reopen")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let db = Db::open(&db_path).unwrap();
    let unchanged = db.get_pipeline_item("task-old").unwrap().unwrap();
    assert_eq!(unchanged.closed_at, original.closed_at);
    assert_eq!(unchanged.updated_at, original.updated_at);
    assert_eq!(
        db.get_test_pipeline_item_ports("task-old").unwrap(),
        original_ports
    );
    assert!(
        db.list_task_ports_for_item("task-old").unwrap().is_empty(),
        "ownership conflict must not leave claimed task ports"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn mark_read_route_sets_unread_task_idle() {
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
        db.update_pipeline_item_activity("task-1", "unread")
            .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/mark-read")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.activity.as_deref(), Some("idle"));
    assert_eq!(item.activity_revision, 2);
}

#[tokio::test]
async fn mark_read_route_rejects_stale_revision_after_same_second_transitions() {
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
    });
    let db_path = state.config.db_path.clone();
    let db = Db::open(&db_path).unwrap();
    db.update_pipeline_item_activity("task-1", "unread")
        .unwrap();
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET activity_changed_at = '2026-07-25 01:00:00' WHERE id = 'task-1'",
            [],
        )
        .unwrap();
    db.update_pipeline_item_activity("task-1", "working")
        .unwrap();
    db.update_pipeline_item_activity("task-1", "unread")
        .unwrap();
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET activity_changed_at = '2026-07-25 01:00:00' WHERE id = 'task-1'",
            [],
        )
        .unwrap();
    drop(db);
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/mark-read")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "expectedActivityRevision": 1,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.activity.as_deref(), Some("unread"));
    assert_eq!(item.activity_revision, 3);
    assert_eq!(
        item.activity_changed_at.as_deref(),
        Some("2026-07-25 01:00:00")
    );
}

#[tokio::test]
async fn mark_read_route_clears_exact_revision_and_makes_replay_harmless() {
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
        db.update_pipeline_item_activity("task-1", "unread")
            .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let request = || {
        Request::post("/v1/tasks/task-1/actions/mark-read")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "expectedActivityRevision": 1,
                })
                .to_string(),
            ))
            .unwrap()
    };
    let response = app.clone().oneshot(request()).await.unwrap();
    let replay_response = app.oneshot(request()).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(replay_response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.activity.as_deref(), Some("idle"));
    assert_eq!(item.activity_revision, 2);
}

#[tokio::test]
async fn agent_session_id_route_persists_provider_session_id() {
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
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/agent-session-id")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "agentSessionId": "provider-session-1",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let agent_session_id: Option<String> = conn
        .query_row(
            "SELECT agent_session_id FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(agent_session_id.as_deref(), Some("provider-session-1"));
}

#[tokio::test]
async fn close_pr_task_sends_blocker_close_instruction_with_renamed_branch_to_running_dependents() {
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
    // Real git repo: the blocker's worktree branch gets renamed the way the
    // PR-stage agent renames it, so the instruction must carry the renamed
    // branch, not the stored fork name.
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-pr-{unique}"));
    init_test_git_repo(&repo_root);
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-close-pr-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
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

    let blocker_worktree_path = repo_root.join(".kanna-worktrees").join("task-a-branch");
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            "task-a-branch",
            blocker_worktree_path.to_str().unwrap(),
            "main",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "-m", "feat/blocker-renamed"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
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
        for index in 0..4 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            match (index, command) {
                (0, DaemonCommand::SubmitInput { session_id, data }) => {
                    assert_eq!(session_id, "task-b-session");
                    let message = String::from_utf8(data).unwrap();
                    assert!(message.contains("has finished its workflow and closed"));
                    assert!(message.contains("Blocker PR"));
                    assert!(
                        message.contains("`feat/blocker-renamed`"),
                        "message must carry the renamed branch, got: {message}"
                    );
                    assert!(!message.contains("`task-a-branch`"));
                    assert!(message.contains("main"));
                }
                (1..=3, DaemonCommand::Kill { .. }) => {}
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
    assert_eq!(blocker.stage.as_deref(), Some("pr"));
    assert!(blocker.closed_at.is_some());

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
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

/// The downward read of parentage, which `parentTaskId` alone cannot answer.
/// A fan-out orchestrator that lost the ids it created — compaction, a resumed
/// session — rediscovers them from its own task detail.
///
/// The closed child is the point of the test, not a corner of it: a finished
/// child is exactly the one an orchestrator must reconcile, so filtering it out
/// would make an empty `childTaskIds` mean either "nothing dispatched" or
/// "everything already finished" with no way to tell them apart.
#[tokio::test]
async fn get_task_route_reports_child_task_ids_including_closed_children() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for (id, created_at) in [
            ("parent-1", "2026-04-17 07:00:00"),
            ("child-open", "2026-04-17 08:00:00"),
            ("child-closed", "2026-04-17 09:00:00"),
            ("grandchild-1", "2026-04-17 10:00:00"),
            ("unrelated-1", "2026-04-17 11:00:00"),
        ] {
            db.insert_test_pipeline_item(
                id,
                "repo-1",
                "prompt",
                Some(id),
                "in progress",
                created_at,
            )
            .unwrap();
        }
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    // Attach through the real route, so the parentage under test is the one an
    // agent actually writes.
    for (child, parent) in [
        ("child-open", "parent-1"),
        ("child-closed", "parent-1"),
        ("grandchild-1", "child-open"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/tasks/{child}/actions/set-parent"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "parentTaskId": parent }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "set parent of {child}");
    }

    Db::open(&db_path)
        .unwrap()
        .close_pipeline_item("child-closed")
        .unwrap();

    let detail = get_task_detail(&app, "parent-1").await;
    assert_eq!(
        detail.child_task_ids,
        vec!["child-open".to_string(), "child-closed".to_string()],
        "childTaskIds must list direct children oldest first, closed ones included"
    );
    assert_eq!(detail.parent_task_id, None);

    // Direct children only: the parent's view stops at its own fan-out, which
    // is what makes it the same set the parentTaskId event scope delivers.
    let child = get_task_detail(&app, "child-open").await;
    assert_eq!(child.child_task_ids, vec!["grandchild-1".to_string()]);
    assert_eq!(child.parent_task_id.as_deref(), Some("parent-1"));

    // A closed child is still readable and still knows its parent, so the
    // orchestrator can walk back up from anything it rediscovers.
    let closed = get_task_detail(&app, "child-closed").await;
    assert!(closed.closed_at.is_some());
    assert_eq!(closed.parent_task_id.as_deref(), Some("parent-1"));

    // A task nobody parented reports an empty list, not the repo.
    let unrelated = get_task_detail(&app, "unrelated-1").await;
    assert!(unrelated.child_task_ids.is_empty());

    // Branch names resolve here as everywhere else a task id is accepted.
    let by_branch = get_task_detail(&app, "branch-parent-1").await;
    assert_eq!(by_branch.child_task_ids, detail.child_task_ids);
}

async fn get_task_detail(app: &axum::Router, task_id: &str) -> crate::mobile_api::TaskDetail {
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/v1/tasks/{task_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "GET task {task_id}");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    // Decoded through the wire type: this asserts the camelCase `childTaskIds`
    // key the catalog documents actually ships, not just an in-process struct.
    let json: serde_json::Value = from_slice(&bytes).unwrap();
    assert!(
        json.get("childTaskIds").is_some(),
        "task detail must expose childTaskIds: {json}"
    );
    serde_json::from_value(json).unwrap()
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
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
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
    assert_eq!(item.stage.as_deref(), Some("in progress"));
    assert!(item.closed_at.is_some());

    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn close_task_route_tears_down_current_stage_environment_before_repo_teardown() {
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
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-env-teardown-{unique}"));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "teardown": ["echo repo-teardown"]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "environments": {
                "dev": {
                    "teardown": ["echo env-teardown"]
                }
            },
            "stages": [
                { "name": "in progress", "transition": "manual", "environment": "dev" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["add", "README.md", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let source_worktree = repo_root.join(".kanna-worktrees/task-source");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            source_worktree.to_string_lossy().as_ref(),
            "task-source",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-close-env-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let db_path = Db::test_db_path(&format!("http-close-env-teardown-{unique}"));
    let expected_worktree = source_worktree.to_string_lossy().to_string();
    let daemon_db_path = db_path.clone();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let expected_kills = ["task-1", "shell-wt-task-1", "td-task-source"];

        for expected_session_id in expected_kills {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            match command {
                DaemonCommand::Kill { session_id } => assert_eq!(session_id, expected_session_id),
                other => panic!("expected kill command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }

        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let item = Db::open(&daemon_db_path)
            .expect("open db before teardown spawn assertion")
            .get_pipeline_item("task-1")
            .expect("read task before teardown spawn")
            .expect("task exists before teardown spawn");
        assert!(
            item.closed_at.is_some(),
            "close route must mark the task closed before spawning teardown cleanup"
        );
        match command {
            DaemonCommand::Spawn {
                session_id,
                cwd,
                args,
                ..
            } => {
                assert_eq!(session_id, "td-task-source");
                assert_eq!(cwd, expected_worktree);
                let command = args.join(" ");
                let env_index = command
                    .find("echo env-teardown")
                    .expect("environment teardown command should be present");
                let repo_index = command
                    .find("echo repo-teardown")
                    .expect("repo teardown command should be present");
                assert!(env_index < repo_index);
            }
            other => panic!("expected teardown spawn, got {other:?}"),
        }
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&DaemonEvent::SessionCreated {
                        session_id: "td-task-source".to_string()
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let db = Db::open_for_tests(&db_path).expect("open test db");
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Close with teardown",
        Some("Close with teardown"),
        "in progress",
        "2026-07-04 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    db.upsert_worktree(
        "wt-task-1",
        "task-1",
        &source_worktree.to_string_lossy(),
        "task-source",
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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-close-env-{unique}.json"),
    };
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    daemon_server.await.unwrap();

    let db = Db::open(&db_path).expect("reopen db");
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert!(item.closed_at.is_some());

    let _ = std::fs::remove_dir_all(repo_root);
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
}

#[tokio::test]
async fn block_task_route_replaces_existing_blockers() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for id in ["task-1", "blocker-old", "blocker-new"] {
            db.insert_test_pipeline_item(
                id,
                "repo-1",
                "task prompt",
                Some(id),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
        }
        db.insert_test_task_blocker("task-1", "blocker-old")
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
                        "blockerTaskIds": ["blocker-new"]
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
        db.count_test_task_blockers("task-1", "blocker-old")
            .unwrap(),
        0
    );
    assert_eq!(
        db.count_test_task_blockers("task-1", "blocker-new")
            .unwrap(),
        1
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
async fn block_task_route_rejects_multi_hop_circular_dependencies() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for (id, title) in [
            ("task-a", "Task A"),
            ("task-b", "Task B"),
            ("task-c", "Task C"),
        ] {
            db.insert_test_pipeline_item(
                id,
                "repo-1",
                "task prompt",
                Some(title),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
        }
        db.insert_test_task_blocker("task-b", "task-a").unwrap();
        db.insert_test_task_blocker("task-c", "task-b").unwrap();
    });
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/block")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "blockerTaskIds": ["task-c"]
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
async fn unblock_task_route_removes_blockers() {
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
}

#[tokio::test]
async fn pr_completion_starts_dormant_dependent_from_current_branch_optimistically() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-pr-optimistic-{unique}"));
    init_test_git_repo(&repo_root);

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-pr-optimistic-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-pr-optimistic-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-pr-optimistic-{unique}.json"),
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
    db.update_test_pipeline_item_stage_context("task-a", "task-a-stage", "default", None, "claude")
        .unwrap();
    insert_running_pr_run(&db, "task-a", "task-a-pr-run");
    drop(db);

    // The pr-stage agent has already rebased, renamed, and committed on the
    // blocker's worktree branch — the state a `stage-complete` signal reports.
    let blocker_worktree_path = repo_root.join(".kanna-worktrees").join("task-a-stage");
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            "task-a-stage",
            blocker_worktree_path.to_str().unwrap(),
            "main",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "-m", "task-a-pr"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    std::fs::write(
        blocker_worktree_path.join("blocker-output.txt"),
        "blocker output",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", "blocker-output.txt"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "blocker output"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    let blocker_head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&blocker_worktree_path)
        .output()
        .unwrap();
    assert!(blocker_head.status.success());
    let blocker_head = String::from_utf8_lossy(&blocker_head.stdout)
        .trim()
        .to_string();
    let db = Db::open(&config.db_path).unwrap();
    db.upsert_worktree(
        "wt-task-a",
        "task-a",
        &blocker_worktree_path.to_string_lossy(),
        "task-a-stage",
    )
    .unwrap();
    drop(db);

    let state = Arc::new(super::AppState::new(config.clone()));
    let app = super::router(Arc::clone(&state));
    let create_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "repoId": "repo-1",
                        "prompt": "Build on task A",
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
                        "blockerTaskIds": ["task-a"],
                        "recoverySnapshot": {
                            "serialized": "DORMANT-RECOVERY\u{001b}[32m",
                            "cols": 111,
                            "rows": 39,
                            "cursorRow": 12,
                            "cursorCol": 34,
                            "cursorVisible": false,
                            "savedAt": 1785000000555_u64,
                            "sequence": 61
                        }
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
    let mut state_changes = state.subscribe_state_changes();

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let expected_task_id = dependent.task_id.clone();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut spawned = Vec::new();
        let mut recovery_seeded = false;
        loop {
            let Some(command) =
                read_test_daemon_command_optional(&mut reader, &mut write_half).await
            else {
                break;
            };
            match command {
                DaemonCommand::Kill { .. } => {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                DaemonCommand::SeedSnapshot {
                    session_id,
                    snapshot,
                } => {
                    assert_eq!(session_id, expected_task_id);
                    assert_eq!(snapshot.version, 1);
                    assert_eq!(snapshot.vt, "DORMANT-RECOVERY\u{1b}[32m");
                    assert_eq!((snapshot.cols, snapshot.rows), (111, 39));
                    assert_eq!((snapshot.cursor_row, snapshot.cursor_col), (12, 34));
                    assert!(!snapshot.cursor_visible);
                    assert_eq!(snapshot.saved_at, 1_785_000_000_555);
                    assert_eq!(snapshot.sequence, 61);
                    recovery_seeded = true;
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
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert!(recovery_seeded, "Spawn preceded dormant recovery seed");
                    assert_eq!(session_id, expected_task_id);
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    assert_eq!(agent_provider, Some(AgentProvider::Claude));
                    spawned.push((session_id.clone(), cwd));
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert!(recovery_seeded, "SpawnAgent preceded dormant recovery seed");
                    assert_eq!(session_id, expected_task_id);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    spawned.push((session_id.clone(), params.cwd));
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
                other => panic!("unexpected daemon command: {:?}", other),
            }
        }
        spawned
    });

    let complete_response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "task-a-pr-run",
                        "status": "success",
                        "summary": "PR is ready",
                        "metadata": {
                            "pr_url": "https://github.com/acme/repo/pull/7"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(complete_response.status(), StatusCode::OK);
    let spawned = daemon_server.await.unwrap();
    assert_eq!(
        spawned.len(),
        1,
        "pr-stage completion should start the dependent once"
    );
    let state_change_scopes = [
        recv_state_change_scope(&mut state_changes).await,
        recv_state_change_scope(&mut state_changes).await,
        recv_state_change_scope(&mut state_changes).await,
    ];
    assert_eq!(
        state_change_scopes,
        [
            kanna_agent_protocol::StateChangeScope::Tasks,
            kanna_agent_protocol::StateChangeScope::Tasks,
            kanna_agent_protocol::StateChangeScope::Blockers,
        ],
        "complete-stage should notify the task update, then the optimistic dependent-start task/blocker refreshes",
    );

    let db = Db::open(&config.db_path).unwrap();
    // Optimistic: the blocker stays open at pr awaiting human merge...
    let blocker = db.get_pipeline_item("task-a").unwrap().unwrap();
    assert!(blocker.closed_at.is_none());
    assert_eq!(blocker.stage.as_deref(), Some("pr"));
    assert_eq!(blocker.branch.as_deref(), Some("task-a-stage"));
    assert_eq!(
        db.get_pipeline_item_pr_branch("task-a").unwrap().as_deref(),
        Some("task-a-pr")
    );
    assert_eq!(
        blocker.pr_url.as_deref(),
        Some("https://github.com/acme/repo/pull/7")
    );
    // ...while the dependent already runs, stacked on the recorded remote PR
    // head rather than the different local worktree branch.
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.base_ref.as_deref(), Some("task-a-pr"));
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
async fn complete_pr_stage_without_pr_url_leaves_dormant_dependent_unstarted() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-pr-stays-blocked-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-pr-stays-blocked-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-pr-stays-blocked-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-pr-stays-blocked-{unique}.json"),
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
    insert_running_pr_run(&db, "task-a", "task-a-pr-run");
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

    // No PR was created (no pr_url in the verdict), so the blocker is not
    // resolved and dependents must stay dormant.
    let complete_response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "task-a-pr-run",
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
    assert!(
        !socket_path.exists(),
        "completion without a PR should not connect to the daemon for blocked dependents"
    );

    let db = Db::open(&config.db_path).unwrap();
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.activity.as_deref(), Some("idle"));
    assert_eq!(dependent_item.base_ref, None);
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_none());

    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn close_last_blocker_starts_dormant_dependent_from_blocker_branch() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-unblocks-{unique}"));
    init_test_git_repo(&repo_root);

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-close-unblocks-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-close-unblocks-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-close-unblocks-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-a",
        "repo-1",
        "Build prerequisite",
        Some("Prerequisite"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-a", "task-a-stage", "default", None, "claude")
        .unwrap();
    insert_running_pr_run(&db, "task-a", "task-a-pr-run");
    drop(db);

    let blocker_worktree_path = repo_root.join(".kanna-worktrees").join("task-a-stage");
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            "task-a-stage",
            blocker_worktree_path.to_str().unwrap(),
            "main",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "-m", "task-a-pr"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    std::fs::write(
        blocker_worktree_path.join("blocker-output.txt"),
        "blocker output",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", "blocker-output.txt"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "blocker output"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    let blocker_head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&blocker_worktree_path)
        .output()
        .unwrap();
    assert!(blocker_head.status.success());
    let blocker_head = String::from_utf8_lossy(&blocker_head.stdout)
        .trim()
        .to_string();

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
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
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
        let mut spawned = Vec::new();
        loop {
            let Some(command) =
                read_test_daemon_command_optional(&mut reader, &mut write_half).await
            else {
                break;
            };
            match command {
                DaemonCommand::Kill { .. } => {
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
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert_eq!(session_id, expected_task_id);
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    assert_eq!(agent_provider, Some(AgentProvider::Claude));
                    spawned.push((session_id.clone(), cwd));
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(session_id, expected_task_id);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    spawned.push((session_id.clone(), params.cwd));
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
                other => panic!("unexpected daemon command: {:?}", other),
            }
        }
        spawned
    });

    let close_response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(close_response.status(), StatusCode::NO_CONTENT);
    let spawned = daemon_server.await.unwrap();
    assert_eq!(spawned.len(), 1, "close should start the dependent once");

    let db = Db::open(&config.db_path).unwrap();
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.base_ref.as_deref(), Some("task-a-pr"));
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
    assert!(
        std::path::Path::new(&worktree_path)
            .join("blocker-output.txt")
            .exists(),
        "dependent should include committed blocker work"
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
}

/// Config for a blocked-dependent scenario that shares one temp root.
fn dependent_scenario_config(label: &str, unique: &str, daemon_dir: &Path) -> Config {
    Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-{label}-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-{label}-{unique}.json"),
    }
}

/// Fake daemon for the dependent-start scenarios: acknowledges kills, refuses
/// every `Input` as a dead session (the notify target's session is gone), and
/// answers the dependent's spawn. Serves connections until dropped — a close
/// opens one connection for its kills and completion notification opens
/// another — and reports each spawned session id on the returned channel.
fn spawn_dependent_start_daemon(
    listener: tokio::net::UnixListener,
    expected_task_id: String,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};

    let (spawned_tx, spawned_rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let expected_task_id = expected_task_id.clone();
            let spawned_tx = spawned_tx.clone();
            tokio::spawn(async move {
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                while let Some(command) =
                    read_test_daemon_command_optional(&mut reader, &mut write_half).await
                {
                    let response = match command {
                        DaemonCommand::Kill { .. } => DaemonEvent::Ok,
                        DaemonCommand::SubmitInput { .. } => DaemonEvent::Error {
                            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                            message: "session not found".to_string(),
                        },
                        DaemonCommand::Spawn {
                            session_id, cwd, ..
                        } => {
                            assert_eq!(session_id, expected_task_id);
                            assert!(cwd.contains(".kanna-worktrees/task-"));
                            let _ = spawned_tx.send(session_id.clone());
                            DaemonEvent::SessionCreated { session_id }
                        }
                        DaemonCommand::SpawnAgent { session_id, params } => {
                            assert_eq!(session_id, expected_task_id);
                            assert!(params.cwd.contains(".kanna-worktrees/task-"));
                            let _ = spawned_tx.send(session_id.clone());
                            DaemonEvent::SessionCreated { session_id }
                        }
                        other => panic!("unexpected daemon command: {:?}", other),
                    };
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                        )
                        .await
                        .unwrap();
                }
            });
        }
    });
    (handle, spawned_rx)
}

/// The one session id the fake daemon was asked to spawn.
async fn expect_one_spawn(
    spawned: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    context: &str,
) -> String {
    let session_id = tokio::time::timeout(std::time::Duration::from_secs(10), spawned.recv())
        .await
        .unwrap_or_else(|_| panic!("{context}: no dependent spawn arrived"))
        .unwrap_or_else(|| panic!("{context}: fake daemon closed before spawning the dependent"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), spawned.recv())
            .await
            .is_err(),
        "{context}: the dependent was started more than once"
    );
    session_id
}

/// Closing a blocker starts its dormant dependent even when the blocker's own
/// completion notification cannot be delivered.
///
/// Notify delivery used to propagate: a notify target whose agent session had
/// already died turned the close into a 500 *after* `closed_at` was written,
/// and — because the error short-circuited the handler — the unblock sweep
/// that follows it never ran. The task was closed, the caller was told it had
/// failed, and every dependent stayed dormant with no run at all.
#[tokio::test]
async fn close_with_a_dead_notify_target_still_starts_dependents() {
    let unique = unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-notify-dead-{unique}"));
    init_test_git_repo(&repo_root);
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-close-notify-dead-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let config = dependent_scenario_config("close-notify-dead", &unique, &daemon_dir);

    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    for (task_id, prompt) in [("task-a", "Build prerequisite"), ("watcher", "Orchestrate")] {
        db.insert_test_pipeline_item(
            task_id,
            "repo-1",
            prompt,
            Some(prompt),
            "in progress",
            "2026-08-07 00:00:00",
        )
        .unwrap();
    }
    db.update_test_pipeline_item_stage_context("task-a", "task-a-stage", "default", None, "claude")
        .unwrap();
    // The orchestrator that asked to be told when task-a finishes is itself
    // gone: the fake daemon refuses input for every session.
    db.update_pipeline_item_notify_task("task-a", Some("watcher"))
        .unwrap();
    drop(db);
    commit_branch_change(&repo_root, "task-a-stage", "blocker-output.txt", "blocker");

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
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
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

    let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
    let (daemon_server, mut spawned) =
        spawn_dependent_start_daemon(listener, dependent.task_id.clone());

    let close_response = app
        .oneshot(
            Request::post("/v1/tasks/task-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        close_response.status(),
        StatusCode::NO_CONTENT,
        "an undeliverable notification must not fail a close that landed"
    );
    expect_one_spawn(&mut spawned, "close with a dead notify target").await;
    daemon_server.abort();

    let db = Db::open(&config.db_path).unwrap();
    assert!(db
        .get_pipeline_item("task-a")
        .unwrap()
        .unwrap()
        .closed_at
        .is_some());
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.activity.as_deref(), Some("working"));
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_some());
    assert!(
        db.latest_stage_run(&dependent.task_id).unwrap().is_some(),
        "the dependent's first stage run should exist without manual intervention"
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Unblocking past a blocker that never started must work.
///
/// A task carries a `pipeline_item.branch` from the moment it is created, but
/// the branch itself only exists once its first workspace is forked. Handing
/// that name to git failed the whole unblock — "merge: task-… - not something
/// we can merge" — so a dependent could not be released from a blocker that
/// had itself never run. There is nothing to inherit, so the dependent forks
/// from its normal base instead.
#[tokio::test]
async fn unblock_starts_a_dependent_whose_blocker_never_created_its_branch() {
    let unique = unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-unblock-no-branch-{unique}"));
    init_test_git_repo(&repo_root);
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-unblock-no-branch-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let config = dependent_scenario_config("unblock-no-branch", &unique, &daemon_dir);

    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-a",
        "repo-1",
        "Never started",
        Some("Never started"),
        "in progress",
        "2026-08-07 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-a", "task-task-a", "default", None, "claude")
        .unwrap();
    drop(db);
    assert!(
        !git_branch_exists(&repo_root, "task-task-a"),
        "the blocker must have no branch for this scenario"
    );

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
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
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

    let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
    let (daemon_server, mut spawned) =
        spawn_dependent_start_daemon(listener, dependent.task_id.clone());

    let unblock_response = app
        .oneshot(
            Request::post(format!("/v1/tasks/{}/actions/unblock", dependent.task_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = unblock_response.status();
    let body = axum::body::to_bytes(unblock_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "unblock failed: {}",
        String::from_utf8_lossy(&body)
    );
    expect_one_spawn(&mut spawned, "unblock past a branchless blocker").await;
    daemon_server.abort();

    let db = Db::open(&config.db_path).unwrap();
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.activity.as_deref(), Some("working"));
    assert_ne!(
        dependent_item.base_ref.as_deref(),
        Some("task-task-a"),
        "a branch git does not have must never become the dependent's base ref"
    );
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_some());

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

fn commit_branch_change(repo_root: &Path, branch: &str, file: &str, content: &str) -> PathBuf {
    let worktree_path = repo_root.join(".kanna-worktrees").join(branch);
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            branch,
            worktree_path.to_str().unwrap(),
            "main",
        ])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    std::fs::write(worktree_path.join(file), content).unwrap();
    assert!(Command::new("git")
        .args(["add", file])
        .current_dir(&worktree_path)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", &format!("{branch} change")])
        .current_dir(&worktree_path)
        .status()
        .unwrap()
        .success());
    worktree_path
}

fn git_branch_exists(repo_root: &Path, branch: &str) -> bool {
    Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success()
}

#[tokio::test]
async fn request_revision_finalization_error_rolls_back_db_and_prepared_worktree() {
    let unique = super::unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-rollback-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(
        repo_root.join(".kanna/workflows/reviewable.json"),
        serde_json::json!({
            "name": "reviewable",
            "revision_limit": 5,
            "stages": [
                {
                    "name": "in progress",
                    "prompt": "$TASK_PROMPT",
                    "policy": { "transition": "manual" }
                },
                { "name": "review", "policy": { "transition": "auto" } }
            ]
        })
        .to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/workflows/reviewable.json"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add reviewable workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_test_origin_main(&repo_root);
    let source_worktree = commit_branch_change(
        &repo_root,
        "task-revision-fault",
        "work.txt",
        "reviewed work",
    );

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-rollback-d-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-revision-rollback-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-revision-rollback-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "revision-fault",
        "repo-1",
        "Implement reviewed work",
        Some("Reviewed work"),
        "review",
        "2026-08-23 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "revision-fault",
        "task-revision-fault",
        "reviewable",
        None,
        "claude",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-revision-fault",
        "revision-fault",
        &source_worktree.to_string_lossy(),
        "task-revision-fault",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "review-run",
        task_id: "revision-fault",
        stage: "review",
        kind: "main",
        agent: Some("review"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("revision-fault"),
        provider_session_id: None,
        cwd: Some(&source_worktree.to_string_lossy()),
        resumed_from_run_id: None,
    })
    .unwrap();
    db.connection_for_e2e_tests()
        .execute_batch(
            "CREATE TRIGGER fail_revision_requested_event
             BEFORE INSERT ON task_event
             WHEN NEW.type = 'task.revision_requested'
             BEGIN
                 SELECT RAISE(ABORT, 'forced revision finalization failure');
             END;",
        )
        .unwrap();

    let before_task = db.get_pipeline_item("revision-fault").unwrap().unwrap();
    let before_runs = db.list_stage_runs_for_task("revision-fault").unwrap();
    let before_event_seq = db.latest_task_event_seq().unwrap();
    let before_branches = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&repo_root)
        .output()
        .unwrap()
        .stdout;
    let before_worktrees = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_root)
        .output()
        .unwrap()
        .stdout;
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/revision-fault/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "Review found a focused defect",
                        "prompt": "Fix the focused defect"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let db = Db::open(&config.db_path).unwrap();
    let after_task = db.get_pipeline_item("revision-fault").unwrap().unwrap();
    assert_eq!(after_task.stage, before_task.stage);
    assert_eq!(after_task.branch, before_task.branch);
    assert_eq!(after_task.activity, before_task.activity);
    assert_eq!(after_task.revision_rounds, before_task.revision_rounds);
    let after_runs = db.list_stage_runs_for_task("revision-fault").unwrap();
    assert_eq!(after_runs.len(), before_runs.len());
    assert_eq!(after_runs[0].status, "running");
    assert_eq!(after_runs[0].result, None);
    assert_eq!(db.latest_task_event_seq().unwrap(), before_event_seq);
    assert_eq!(
        Command::new("git")
            .args(["branch", "--format=%(refname:short)"])
            .current_dir(&repo_root)
            .output()
            .unwrap()
            .stdout,
        before_branches,
        "a failed request must delete its prepared branch"
    );
    assert_eq!(
        Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&repo_root)
            .output()
            .unwrap()
            .stdout,
        before_worktrees,
        "a failed request must delete its prepared worktree"
    );

    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn conflicting_sibling_blockers_create_integration_task_and_leave_dependent_dormant() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-conflict-integrates-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(repo_root.join("shared.txt"), "base\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "shared.txt"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add shared"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    commit_branch_change(&repo_root, "blocker-a-branch", "shared.txt", "from a\n");
    commit_branch_change(&repo_root, "blocker-b-branch", "shared.txt", "from b\n");

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-conflict-integrates-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-conflict-integrates-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-conflict-integrates-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    for (id, branch) in [
        ("blocker-a", "blocker-a-branch"),
        ("blocker-b", "blocker-b-branch"),
    ] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            "blocker prompt",
            Some(id),
            "in progress",
            "2026-07-01T00:00:00Z",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(id, branch, "default", None, "claude")
            .unwrap();
    }
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
                        "prompt": "Build on both blockers",
                        "displayName": "Dependent Feature",
                        "agentProvider": "claude",
                        "blockerTaskIds": ["blocker-a", "blocker-b"]
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

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let dependent_task_id = dependent.task_id.clone();
    let daemon_server = tokio::spawn(async move {
        loop {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            loop {
                let Some(command) =
                    read_test_daemon_command_optional(&mut reader, &mut write_half).await
                else {
                    break;
                };
                match command {
                    DaemonCommand::Kill { .. } => {
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::SpawnAgent { session_id, params } => {
                        assert_ne!(session_id, dependent_task_id);
                        assert_eq!(params.agent_provider, AgentProvider::Claude);
                        assert!(params.cwd.contains(".kanna-worktrees/task-"));
                        assert!(params.prompt.contains("blocker-b-branch"));
                        assert!(params.prompt.contains("preserving both sides' intent"));
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        return;
                    }
                    DaemonCommand::Spawn {
                        session_id,
                        cwd,
                        agent_provider,
                        ..
                    } => {
                        assert_ne!(session_id, dependent_task_id);
                        assert_eq!(agent_provider, Some(AgentProvider::Claude));
                        assert!(cwd.contains(".kanna-worktrees/task-"));
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        return;
                    }
                    other => panic!("unexpected daemon command: {:?}", other),
                }
            }
        }
    });

    let close_a = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/blocker-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(close_a.status(), StatusCode::NO_CONTENT);
    let close_b = app
        .oneshot(
            Request::post("/v1/tasks/blocker-b/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(close_b.status(), StatusCode::NO_CONTENT);
    tokio::time::timeout(std::time::Duration::from_secs(2), daemon_server)
        .await
        .expect("integration task was not spawned")
        .unwrap();

    let db = Db::open(&config.db_path).unwrap();
    let integration = db
        .search_pipeline_items("Integrate: Dependent Feature")
        .unwrap()
        .into_iter()
        .next()
        .expect("integration task");
    assert_eq!(integration.base_ref.as_deref(), Some("blocker-a-branch"));
    assert_eq!(integration.agent_provider.as_deref(), Some("claude"));
    assert!(
        db.list_task_blocker_ids(&integration.id)
            .unwrap()
            .is_empty(),
        "integration tasks must not have blockers or recursively create integrations"
    );
    assert_eq!(
        db.list_task_blocker_ids(&dependent.task_id).unwrap(),
        vec![integration.id.clone()]
    );
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_none());
    assert!(!repo_root
        .join(".kanna-worktrees")
        .join(format!("task-{}", dependent.task_id))
        .exists());
    assert!(!git_branch_exists(
        &repo_root,
        &format!("task-{}", dependent.task_id)
    ));

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
}

#[tokio::test]
async fn closing_integration_task_starts_dependent_from_integration_branch() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-integration-closes-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(repo_root.join("shared.txt"), "base\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "shared.txt"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add shared"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    commit_branch_change(&repo_root, "blocker-a-branch", "shared.txt", "from a\n");
    commit_branch_change(&repo_root, "blocker-b-branch", "shared.txt", "from b\n");

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-integration-closes-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-integration-closes-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-integration-closes-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    for (id, branch) in [
        ("blocker-a", "blocker-a-branch"),
        ("blocker-b", "blocker-b-branch"),
    ] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            "blocker prompt",
            Some(id),
            "in progress",
            "2026-07-01T00:00:00Z",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(id, branch, "default", None, "claude")
            .unwrap();
    }
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
                        "prompt": "Build on both blockers",
                        "displayName": "Dependent Feature",
                        "agentProvider": "claude",
                        "blockerTaskIds": ["blocker-a", "blocker-b"]
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

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let mut spawned = Vec::new();
        loop {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            loop {
                let Some(command) =
                    read_test_daemon_command_optional(&mut reader, &mut write_half).await
                else {
                    break;
                };
                match command {
                    DaemonCommand::Kill { .. } => {
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::Spawn {
                        session_id, cwd, ..
                    } => {
                        spawned.push((session_id.clone(), cwd));
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        if spawned.len() == 2 {
                            return spawned;
                        }
                    }
                    DaemonCommand::SpawnAgent { session_id, params } => {
                        spawned.push((session_id.clone(), params.cwd));
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        if spawned.len() == 2 {
                            return spawned;
                        }
                    }
                    other => panic!("unexpected daemon command: {:?}", other),
                }
            }
        }
    });

    assert_eq!(
        app.clone()
            .oneshot(
                Request::post("/v1/tasks/blocker-a/actions/close")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.clone()
            .oneshot(
                Request::post("/v1/tasks/blocker-b/actions/close")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );

    let db = Db::open(&config.db_path).unwrap();
    let integration = db
        .search_pipeline_items("Integrate: Dependent Feature")
        .unwrap()
        .into_iter()
        .next()
        .expect("integration task");
    let integration_worktree = db
        .get_task_worktree_path(&integration.id)
        .unwrap()
        .expect("integration worktree");
    std::fs::write(
        Path::new(&integration_worktree).join("shared.txt"),
        "from a\nfrom b\n",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", "shared.txt"])
        .current_dir(&integration_worktree)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "integrate blockers"])
        .current_dir(&integration_worktree)
        .status()
        .unwrap()
        .success());
    let integration_branch = integration.branch.clone().unwrap();
    drop(db);

    let close_integration = app
        .oneshot(
            Request::post(format!("/v1/tasks/{}/actions/close", integration.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(close_integration.status(), StatusCode::NO_CONTENT);

    let spawned = tokio::time::timeout(std::time::Duration::from_secs(2), daemon_server)
        .await
        .expect("dependent was not spawned after integration closed")
        .unwrap();
    assert_eq!(spawned.len(), 2);
    assert_eq!(spawned[0].0, integration.id);
    assert_eq!(spawned[1].0, dependent.task_id);

    let db = Db::open(&config.db_path).unwrap();
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(
        dependent_item.base_ref.as_deref(),
        Some(integration_branch.as_str())
    );
    assert_eq!(dependent_item.activity.as_deref(), Some("working"));
    assert_eq!(
        db.list_task_blocker_ids(&dependent.task_id).unwrap(),
        vec![integration.id.clone()]
    );
    let dependent_worktree = db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .expect("dependent worktree");
    assert_eq!(
        std::fs::read_to_string(Path::new(&dependent_worktree).join("shared.txt")).unwrap(),
        "from a\nfrom b\n"
    );

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
}

#[tokio::test]
async fn renamed_multi_blocker_pr_branches_survive_earlier_worktree_cleanup() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-clean-multi-{unique}"));
    init_test_git_repo(&repo_root);
    let blocker_a_worktree =
        commit_branch_change(&repo_root, "blocker-a-workspace", "a.txt", "from a\n");
    let blocker_b_worktree =
        commit_branch_change(&repo_root, "blocker-b-workspace", "b.txt", "from b\n");
    for (worktree, pr_branch) in [
        (&blocker_a_worktree, "feat/blocker-a"),
        (&blocker_b_worktree, "feat/blocker-b"),
    ] {
        assert!(Command::new("git")
            .args(["branch", "-m", pr_branch])
            .current_dir(worktree)
            .status()
            .unwrap()
            .success());
    }

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-clean-multi-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-clean-multi-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-clean-multi-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    for (id, stored_branch) in [
        ("blocker-a", "blocker-a-workspace"),
        ("blocker-b", "blocker-b-workspace"),
    ] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            "blocker prompt",
            Some(id),
            "pr",
            "2026-07-01T00:00:00Z",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(id, stored_branch, "default", None, "claude")
            .unwrap();
    }
    db.upsert_worktree(
        "wt-blocker-a",
        "blocker-a",
        &blocker_a_worktree.to_string_lossy(),
        "blocker-a-workspace",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-blocker-b",
        "blocker-b",
        &blocker_b_worktree.to_string_lossy(),
        "blocker-b-workspace",
    )
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
                        "prompt": "Build on both blockers",
                        "displayName": "Dependent Feature",
                        "agentProvider": "claude",
                        "blockerTaskIds": ["blocker-a", "blocker-b"]
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
    let db = Db::open(&config.db_path).unwrap();
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_none());
    drop(db);

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let expected_task_id = dependent.task_id.clone();
    let daemon_server = tokio::spawn(async move {
        loop {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            loop {
                let Some(command) =
                    read_test_daemon_command_optional(&mut reader, &mut write_half).await
                else {
                    break;
                };
                match command {
                    DaemonCommand::Kill { .. } => {
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::Spawn { session_id, .. }
                    | DaemonCommand::SpawnAgent { session_id, .. } => {
                        assert_eq!(session_id, expected_task_id);
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        return;
                    }
                    other => panic!("unexpected daemon command: {:?}", other),
                }
            }
        }
    });

    assert_eq!(
        app.clone()
            .oneshot(
                Request::post("/v1/tasks/blocker-a/actions/close")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        db.get_pipeline_item("blocker-a")
            .unwrap()
            .unwrap()
            .branch
            .as_deref(),
        Some("blocker-a-workspace")
    );
    assert_eq!(
        db.get_pipeline_item_pr_branch("blocker-a")
            .unwrap()
            .as_deref(),
        Some("feat/blocker-a")
    );
    assert!(!blocker_a_worktree.exists());
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_none());
    drop(db);

    assert_eq!(
        app.oneshot(
            Request::post("/v1/tasks/blocker-b/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status(),
        StatusCode::NO_CONTENT
    );
    daemon_server.await.unwrap();

    let db = Db::open(&config.db_path).unwrap();
    assert!(db
        .search_pipeline_items("Integrate: Dependent Feature")
        .unwrap()
        .is_empty());
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.base_ref.as_deref(), Some("feat/blocker-a"));
    let dependent_worktree = db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .expect("dependent worktree");
    assert!(Path::new(&dependent_worktree).join("a.txt").exists());
    assert!(Path::new(&dependent_worktree).join("b.txt").exists());

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
}

#[tokio::test]
async fn close_non_final_blocker_leaves_dormant_dependent_unstarted() {
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
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-non-final-{unique}"));
    init_test_git_repo(&repo_root);

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-close-non-final-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-close-non-final-{unique}")),
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
        pairing_store_path: format!("/tmp/kanna-pairings-close-non-final-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    for blocker_id in ["blocker-a", "blocker-b"] {
        db.insert_test_pipeline_item(
            blocker_id,
            "repo-1",
            "blocker prompt",
            Some("Blocker"),
            "in progress",
            "2026-07-01T00:00:00Z",
        )
        .unwrap();
    }
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
                        "prompt": "Wait for both blockers",
                        "blockerTaskIds": ["blocker-a", "blocker-b"]
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

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut spawned = 0usize;
        loop {
            let Some(command) =
                read_test_daemon_command_optional(&mut reader, &mut write_half).await
            else {
                break;
            };
            match command {
                DaemonCommand::Kill { .. } => {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                DaemonCommand::Spawn { .. } | DaemonCommand::SpawnAgent { .. } => {
                    spawned += 1;
                }
                other => panic!("unexpected daemon command: {:?}", other),
            }
        }
        spawned
    });

    let close_response = app
        .oneshot(
            Request::post("/v1/tasks/blocker-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(close_response.status(), StatusCode::NO_CONTENT);
    assert_eq!(daemon_server.await.unwrap(), 0);

    let db = Db::open(&config.db_path).unwrap();
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_none());
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.activity.as_deref(), Some("idle"));

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
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
                follow_task: None,
                revision_budget: None,
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
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
async fn stale_advance_transition_revision_is_rejected_after_owner_transition() {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seeded = super::test_state_with_seed("desktop-advance-cas", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "advance me",
            Some("Advance Me"),
            "in progress",
            "2026-07-26 00:00:00",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-1",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            effort: None,
            status: "succeeded",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
    });
    let config = seeded.config.clone();
    let db_path = config.db_path.clone();
    let app = super::router(Arc::new(AppState::with_stage_advancer(
        config,
        Arc::new({
            let calls = Arc::clone(&calls);
            move |task_id| {
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    Db::open(&db_path)
                        .unwrap()
                        .insert_stage_run(crate::db::NewStageRun {
                            id: "run-2",
                            task_id: &task_id,
                            stage: "review",
                            kind: "main",
                            agent: None,
                            agent_provider: Some("codex"),
                            model: None,
                            effort: None,
                            status: "running",
                            result: None,
                            feedback: None,
                            session_id: Some("task-1"),
                            provider_session_id: None,
                            cwd: None,
                            resumed_from_run_id: None,
                        })
                        .unwrap();
                }
                Ok(TaskActionResponse {
                    task_id,
                    follow_task: None,
                    revision_budget: None,
                })
            }
        }),
    )));
    let request = || {
        Request::post("/v1/tasks/task-1/actions/advance-stage")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "expectedTransitionRevision": "run-1",
                })
                .to_string(),
            ))
            .unwrap()
    };

    let first = app.clone().oneshot(request()).await.unwrap();
    let replay = app.oneshot(request()).await.unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(replay.status(), StatusCode::CONFLICT);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_immediate_advance_requests_share_one_owner_transition() {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let app = super::test_router_with_stage_advancer(
        "desktop-single-flight",
        "Studio Mac",
        Arc::new({
            let calls = Arc::clone(&calls);
            let gate = Arc::clone(&gate);
            move |task_id| {
                assert_eq!(task_id, "task-1");
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    started_tx.send(()).unwrap();
                    let (lock, changed) = &*gate;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = changed.wait(released).unwrap();
                    }
                }
                Ok(TaskActionResponse {
                    task_id,
                    follow_task: None,
                    revision_budget: None,
                })
            }
        }),
    );

    let first = tokio::spawn(
        app.clone().oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        ),
    );
    started_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("first transition did not start");
    let second = tokio::time::timeout(
        std::time::Duration::from_millis(250),
        app.clone().oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("duplicate advance waited for the first transition")
    .unwrap();

    assert_eq!(second.status(), StatusCode::OK);
    let observed_calls = calls.load(std::sync::atomic::Ordering::SeqCst);

    {
        let (lock, changed) = &*gate;
        *lock.lock().unwrap() = true;
        changed.notify_all();
    }
    assert_eq!(first.await.unwrap().unwrap().status(), StatusCode::OK);
    assert_eq!(observed_calls, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn complete_stage_waits_for_competing_advance_stage_mutation() {
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let seeded =
        super::test_state_with_seed("desktop-cross-action-linearization", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "linearize actions",
                Some("Linearize actions"),
                "in progress",
                "2026-07-26 00:00:00",
            )
            .unwrap();
        });
    let mut state = AppState::with_stage_advancer(
        seeded.config.clone(),
        Arc::new({
            let gate = Arc::clone(&gate);
            move |task_id| {
                started_tx.send(()).unwrap();
                let (lock, changed) = &*gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
                Ok(TaskActionResponse {
                    task_id,
                    follow_task: None,
                    revision_budget: None,
                })
            }
        }),
    );
    state.stage_completer = Some(Arc::new(|task_id, _| {
        Ok(TaskActionResponse {
            task_id,
            follow_task: None,
            revision_budget: None,
        })
    }));
    let app = super::router(Arc::new(state));

    let advance = tokio::spawn(
        app.clone().oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        ),
    );
    started_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("advance mutation did not start");

    let mut completion = Box::pin(
        app.clone().oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "test-only-run",
                        "status": "success",
                        "summary": "competing completion",
                    })
                    .to_string(),
                ))
                .unwrap(),
        ),
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut completion)
            .await
            .is_err(),
        "complete-stage interleaved with an active advance-stage mutation",
    );

    {
        let (lock, changed) = &*gate;
        *lock.lock().unwrap() = true;
        changed.notify_all();
    }
    assert_eq!(advance.await.unwrap().unwrap().status(), StatusCode::OK);
    assert_eq!(completion.await.unwrap().status(), StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blocker_replacement_waits_for_competing_advance_stage_mutation() {
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let seeded = super::test_state_with_seed("desktop-blocker-linearization", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for (task_id, prompt) in [("task-1", "linearize blockers"), ("blocker-1", "blocker")] {
            db.insert_test_pipeline_item(
                task_id,
                "repo-1",
                prompt,
                Some(prompt),
                "in progress",
                "2026-07-26 00:00:00",
            )
            .unwrap();
        }
    });
    let db_path = seeded.config.db_path.clone();
    let state = AppState::with_stage_advancer(
        seeded.config.clone(),
        Arc::new({
            let gate = Arc::clone(&gate);
            move |task_id| {
                started_tx.send(()).unwrap();
                let (lock, changed) = &*gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
                Ok(TaskActionResponse {
                    task_id,
                    follow_task: None,
                    revision_budget: None,
                })
            }
        }),
    );
    let app = super::router(Arc::new(state));

    let advance = tokio::spawn(
        app.clone().oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        ),
    );
    started_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("advance mutation did not start");

    let mut block = Box::pin(
        app.clone().oneshot(
            Request::post("/v1/tasks/task-1/actions/block")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "blockerTaskIds": ["blocker-1"] }).to_string(),
                ))
                .unwrap(),
        ),
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut block)
            .await
            .is_err(),
        "blocker replacement interleaved with an active advance-stage mutation",
    );
    assert!(
        Db::open(&db_path)
            .unwrap()
            .list_task_blocker_ids("task-1")
            .unwrap()
            .is_empty(),
        "blocker mutation committed before the lifecycle lease released",
    );

    {
        let (lock, changed) = &*gate;
        *lock.lock().unwrap() = true;
        changed.notify_all();
    }
    assert_eq!(advance.await.unwrap().unwrap().status(), StatusCode::OK);
    assert_eq!(block.await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        Db::open(&db_path)
            .unwrap()
            .list_task_blocker_ids("task-1")
            .unwrap(),
        vec!["blocker-1".to_string()],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dependent_start_waits_for_mutation_lease_and_rechecks_blockers() {
    use tokio::net::UnixListener;

    let seeded = super::test_state_with_seed(
        "desktop-dependent-start-linearization",
        "Studio Mac",
        |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            for (task_id, prompt) in [
                ("dependent-1", "dependent"),
                ("blocker-closed", "closed blocker"),
                ("blocker-new", "new blocker"),
            ] {
                db.insert_test_pipeline_item(
                    task_id,
                    "repo-1",
                    prompt,
                    Some(prompt),
                    "in progress",
                    "2026-07-26 00:00:00",
                )
                .unwrap();
            }
            db.insert_task_blocker("dependent-1", "blocker-closed")
                .unwrap();
            db.close_pipeline_item("blocker-closed").unwrap();
        },
    );
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-dependent-start-linearization-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });

    let mut config = seeded.config.clone();
    config.daemon_dir = daemon_dir.to_string_lossy().into_owned();
    let state = Arc::new(AppState::new(config.clone()));
    let dependent_mutation = state.begin_requested_task_mutation("dependent-1").await;
    let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .unwrap();
    let start_state = Arc::clone(&state);
    let mut start = Box::pin(tokio::spawn(async move {
        super::super::task_blockers::start_dependents_unblocked_by_close_with_daemon(
            &start_state,
            &mut daemon,
            "blocker-closed",
        )
        .await;
    }));

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut start)
            .await
            .is_err(),
        "dependent start must wait for the dependent task's mutation lease",
    );

    Db::open(&config.db_path)
        .unwrap()
        .replace_task_blockers_atomically("dependent-1", &["blocker-new".to_string()])
        .unwrap();
    drop(dependent_mutation);
    tokio::time::timeout(std::time::Duration::from_secs(2), &mut start)
        .await
        .expect("dependent start did not resume after mutation lease release")
        .unwrap();

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        db.list_open_task_blocker_ids("dependent-1").unwrap(),
        vec!["blocker-new".to_string()],
    );
    assert!(db.get_task_worktree_path("dependent-1").unwrap().is_none());

    daemon_server.abort();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
}

#[tokio::test]
async fn rerun_stage_route_uses_stage_rerunner() {
    let app = super::test_router_with_stage_rerunner(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            assert_eq!(task_id, "task-1");
            Ok(TaskActionResponse {
                task_id: "task-1".to_string(),
                follow_task: None,
                revision_budget: None,
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/rerun-stage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let rerun: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(rerun.task_id, "task-1");
}

#[tokio::test]
async fn advance_stage_route_records_stage_run_for_spawned_next_task() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-advance-stage-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nname: Reviewer\ndescription: Test review agent\nagent_provider: claude\n---\nReview task $TASK_PROMPT",
    )
    .unwrap();
    let setup_started = repo_root.join("setup-started");
    let setup_finished = repo_root.join("setup-finished");
    let release_setup = repo_root.join("release-setup");
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "setup": [format!(
                "touch '{}'; while [ ! -e '{}' ]; do sleep 0.05; done; touch '{}'",
                setup_started.display(),
                release_setup.display(),
                setup_finished.display()
            )]
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
        .args(["commit", "-m", "add workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-advance-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        loop {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            let session_id = match command {
                // Durable stage swap kills the previous session in place
                // before respawning the same session id.
                DaemonCommand::Kill { .. } => {
                    let response = DaemonEvent::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    };
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                        )
                        .await
                        .unwrap();
                    continue;
                }
                DaemonCommand::Spawn {
                    session_id,
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert_eq!(agent_provider, Some(AgentProvider::Claude));
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    session_id
                }
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    session_id
                }
                other => panic!("expected stage advance spawn command, got {:?}", other),
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
            break;
        }
    });

    let (kanna_cli_path, created_sidecar) = ensure_test_kanna_cli_sidecar();
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-advance-stage-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-advance-stage-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "source-1",
        "repo-1",
        "Implement it",
        Some("Implement it"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "source-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
        "claude",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        app.oneshot(
            Request::post("/v1/tasks/source-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("advance-stage must return while repository setup is running")
    .unwrap();

    if response.status() != StatusCode::OK {
        daemon_server.abort();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        panic!(
            "expected advance-stage to succeed, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "source-1");
    let setup_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    while !setup_started.exists() && tokio::time::Instant::now() < setup_deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(setup_started.exists(), "detached setup never started");
    assert!(
        !setup_finished.exists(),
        "setup should still be waiting after the HTTP response"
    );
    std::fs::write(&release_setup, "").unwrap();

    // The transition executes on a detached task (the request's caller may
    // be the session being replaced); wait for it to land.
    let db = Db::open(&config.db_path).unwrap();
    let source = wait_for_running_task_stage(&db, "source-1", "review").await;

    // Durable stage swap: the SAME task moves to `review` with a new main
    // run on the same session id; nothing is closed or recreated.
    assert_eq!(source.stage.as_deref(), Some("review"));
    assert!(source.closed_at.is_none());
    let runs = db.list_stage_runs_for_task("source-1").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].stage, "review");
    assert_eq!(runs[0].kind, "main");
    assert_eq!(runs[0].agent.as_deref(), Some("reviewer"));
    assert_eq!(runs[0].agent_provider.as_deref(), Some("claude"));
    assert_eq!(runs[0].status, "running");
    assert_eq!(runs[0].session_id.as_deref(), Some("source-1"));

    daemon_server.await.unwrap();
    if created_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn advance_stage_route_notifies_after_detached_setup_failure_is_persisted() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-advance-failure-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nname: Reviewer\ndescription: Test review agent\nagent_provider: claude\n---\nReview task $TASK_PROMPT",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "setup": ["printf 'route setup failed\\n'; exit 23"]
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
        .args(["commit", "-m", "add failing setup"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-failure-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let kanna_cli_path = daemon_dir.join("kanna-cli");
    std::fs::write(&kanna_cli_path, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&kanna_cli_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    // Accept (and immediately EOF) connections for the whole test: a
    // single-accept fake would strand later connections in the closed
    // listener's backlog, hanging the detached worker until the daemon
    // command timeout instead of failing fast.
    let (first_contact_tx, first_contact_rx) = tokio::sync::oneshot::channel();
    let daemon_server = tokio::spawn(async move {
        let (_stream, _) = daemon_listener.accept().await.unwrap();
        let _ = first_contact_tx.send(());
        loop {
            let Ok((_stream, _)) = daemon_listener.accept().await else {
                break;
            };
        }
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-advance-failure-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-advance-failure-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "source-1",
        "repo-1",
        "Implement it",
        Some("Implement it"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "source-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
        "claude",
    )
    .unwrap();
    drop(db);

    let state = Arc::new(super::AppState::new(config.clone()));
    let mut state_changes = state.subscribe_state_changes();
    let app = super::router(Arc::clone(&state));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/source-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        recv_state_change_scope(&mut state_changes).await,
        kanna_agent_protocol::StateChangeScope::Tasks,
        "the route should publish its immediate accepted-state notification"
    );
    assert_eq!(
        recv_state_change_scope(&mut state_changes).await,
        kanna_agent_protocol::StateChangeScope::Tasks,
        "the detached worker should publish again after persisting setup failure"
    );

    let db = Db::open(&config.db_path).unwrap();
    let item = db.get_pipeline_item("source-1").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("in progress"));
    assert_eq!(item.activity.as_deref(), Some("unread"));
    let failed = db.latest_stage_run("source-1").unwrap().unwrap();
    assert_eq!(failed.stage, "review");
    assert_eq!(failed.status, "failed");
    assert!(
        failed
            .result
            .as_deref()
            .is_some_and(|result| result.contains("route setup failed")),
        "failed run should retain setup diagnostics: {:?}",
        failed.result
    );

    tokio::time::timeout(std::time::Duration::from_secs(5), first_contact_rx)
        .await
        .expect("the detached worker should contact the daemon")
        .unwrap();
    daemon_server.abort();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn advance_stage_detached_transition_aborts_when_task_closes_before_stage_write() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::sync::oneshot;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-advance-close-race-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent_provider": "claude" }
  ]
}"#,
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-advance-close-race-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let (spawn_seen_tx, spawn_seen_rx) = oneshot::channel::<()>();
    let (release_spawn_tx, release_spawn_rx) = oneshot::channel::<()>();
    let (cleanup_seen_tx, cleanup_seen_rx) = oneshot::channel::<String>();
    let daemon_server = tokio::spawn(async move {
        let mut spawn_seen_tx = Some(spawn_seen_tx);
        let mut release_spawn_rx = Some(release_spawn_rx);
        let mut cleanup_seen_tx = Some(cleanup_seen_tx);
        'connections: loop {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            loop {
                let Some(command) =
                    read_test_daemon_command_optional(&mut reader, &mut write_half).await
                else {
                    continue 'connections;
                };
                if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                    continue;
                }
                match command {
                    DaemonCommand::Kill { session_id, .. } if session_id == "source-1" => {
                        let response = DaemonEvent::Error {
                            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                            message: "session not found".to_string(),
                        };
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&response).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::Kill { session_id, .. } if session_id == "shell-wt-source-1" => {
                        let response = DaemonEvent::Error {
                            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                            message: "session not found".to_string(),
                        };
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&response).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::Spawn {
                        session_id,
                        cwd,
                        agent_provider,
                        ..
                    } => {
                        assert_eq!(agent_provider, Some(AgentProvider::Claude));
                        assert!(cwd.contains(".kanna-worktrees/task-"));
                        if let Some(tx) = spawn_seen_tx.take() {
                            tx.send(()).unwrap();
                        }
                        release_spawn_rx.take().unwrap().await.unwrap();
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::SpawnAgent { session_id, params } => {
                        assert_eq!(params.agent_provider, AgentProvider::Claude);
                        assert!(params.cwd.contains(".kanna-worktrees/task-"));
                        if let Some(tx) = spawn_seen_tx.take() {
                            tx.send(()).unwrap();
                        }
                        release_spawn_rx.take().unwrap().await.unwrap();
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::SessionCreated {
                                        session_id
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    DaemonCommand::Kill { session_id, .. } => {
                        if let Some(tx) = cleanup_seen_tx.take() {
                            tx.send(session_id).unwrap();
                        }
                        write_half
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::to_string(&DaemonEvent::Exit {
                                        session_id: "source-1".to_string(),
                                        code: 0,
                                        resume_session_id: None,
                                        killed: true,
                                    })
                                    .unwrap()
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        break;
                    }
                    other => panic!(
                        "unexpected daemon command during advance/close race: {:?}",
                        other
                    ),
                }
            }
        }
    });

    let (kanna_cli_path, created_sidecar) = ensure_test_kanna_cli_sidecar();
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-advance-close-race-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-advance-close-race-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "source-1",
        "repo-1",
        "Implement it",
        Some("Implement it"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "source-1",
        "task-source",
        "default",
        None,
        "claude",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/source-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    spawn_seen_rx.await.unwrap();
    let db = Db::open(&config.db_path).unwrap();
    db.close_pipeline_item("source-1").unwrap();
    assert!(db
        .get_pipeline_item("source-1")
        .unwrap()
        .unwrap()
        .closed_at
        .is_some());
    drop(db);
    release_spawn_tx.send(()).unwrap();

    // Generous because a short window turns "the cleanup did not happen yet"
    // into the silently-skipped branch below on a loaded box, not a failure.
    let cleanup_session_id =
        tokio::time::timeout(std::time::Duration::from_secs(10), cleanup_seen_rx)
            .await
            .ok()
            .map(|received| received.unwrap());
    if let Some(cleanup_session_id) = cleanup_session_id {
        assert_eq!(cleanup_session_id, "source-1");
        daemon_server.await.unwrap();
    } else {
        daemon_server.abort();
    }

    let db = Db::open(&config.db_path).unwrap();
    let task = db.get_pipeline_item("source-1").unwrap().unwrap();
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(task.branch.as_deref(), Some("task-source"));
    assert!(task.closed_at.is_some());
    let runs = db.list_stage_runs_for_task("source-1").unwrap();
    let review = runs
        .iter()
        .find(|run| run.stage == "review")
        .expect("the acknowledged child keeps a durable diagnostic identity");
    assert_eq!(review.status, "failed");
    assert!(review
        .result
        .as_deref()
        .unwrap_or_default()
        .contains("closed before stage transition landed"));

    if created_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn advance_stage_route_closes_final_stage_and_tears_down_environment_before_repo() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-final-close-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "teardown": ["echo repo-teardown"]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "environments": {
                "dev": {
                    "teardown": ["echo env-teardown"]
                }
            },
            "stages": [
                { "name": "in progress", "transition": "manual", "environment": "dev" }
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
        .args(["commit", "-m", "add teardown workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let source_worktree = repo_root.join(".kanna-worktrees/task-source");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            source_worktree.to_string_lossy().as_ref(),
            "task-source",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-final-close-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let db_path = Db::test_db_path(&format!("http-api-final-close-{unique}"));
    let expected_worktree = source_worktree.to_string_lossy().to_string();
    let daemon_db_path = db_path.clone();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let expected_kills = ["task-1", "shell-wt-task-1", "td-task-source"];

        for expected_session_id in expected_kills {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            match command {
                DaemonCommand::Kill { session_id } => assert_eq!(session_id, expected_session_id),
                other => panic!("expected kill command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }

        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        let item = Db::open(&daemon_db_path)
            .expect("open db before final-stage teardown spawn assertion")
            .get_pipeline_item("task-1")
            .expect("read task before final-stage teardown spawn")
            .expect("task exists before final-stage teardown spawn");
        assert!(
            item.closed_at.is_some(),
            "final-stage close must mark the task closed before spawning teardown cleanup"
        );
        match command {
            DaemonCommand::Spawn {
                session_id,
                cwd,
                args,
                ..
            } => {
                assert_eq!(session_id, "td-task-source");
                assert_eq!(cwd, expected_worktree);
                let command = args.join(" ");
                let env_index = command
                    .find("echo env-teardown")
                    .expect("environment teardown command should be present");
                let repo_index = command
                    .find("echo repo-teardown")
                    .expect("repo teardown command should be present");
                assert!(
                    env_index < repo_index,
                    "environment teardown should run before repo teardown: {command}"
                );
            }
            other => panic!("expected teardown spawn, got {other:?}"),
        }
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&DaemonEvent::SessionCreated {
                        session_id: "td-task-source".to_string()
                    })
                    .unwrap()
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
        db_path,
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
        pairing_store_path: format!("/tmp/kanna-pairings-final-close-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Ship it",
        Some("Ship it"),
        "in progress",
        "2026-07-04 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    db.upsert_worktree(
        "wt-task-1",
        "task-1",
        &source_worktree.to_string_lossy(),
        "task-source",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    daemon_server.await.unwrap();

    let db = Db::open(&config.db_path).unwrap();
    let task = wait_for_task_closed(&db, "task-1").await;
    assert_eq!(task.stage.as_deref(), Some("in progress"));

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
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
                follow_task: None,
                revision_budget: None,
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "test-stage-completer-run",
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
async fn complete_stage_route_finishes_latest_running_stage_run() {
    let repo_temp = tempfile::Builder::new()
        .prefix("kanna-http-complete-stage-run-")
        .tempdir()
        .unwrap();
    let repo_root = repo_temp.path().join("repo");
    init_test_git_repo(&repo_root);
    let repo_path = repo_root.to_string_lossy().to_string();
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", move |db| {
        db.insert_test_repo_with_path("repo-1", &repo_path, "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Implement it",
            Some("Implement it"),
            "in progress",
            "2026-07-02 00:00:00",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-1",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("codex"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "run-1",
                        "status": "success",
                        "summary": "implemented",
                        "metadata": { "pr_url": "https://github.com/acme/repo/pull/41" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    let stage_result = serde_json::json!({
        "status": "success",
        "summary": "implemented",
        "metadata": { "pr_url": "https://github.com/acme/repo/pull/41" }
    })
    .to_string();
    assert!(stage_result.contains("\"status\":\"success\""));
    assert!(stage_result.contains("implemented"));
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs[0].status, "succeeded");
    assert_eq!(runs[0].result.as_deref(), Some(stage_result.as_str()));
    assert_eq!(runs[0].feedback.as_deref(), Some("implemented"));
    assert!(runs[0].finished_at.is_some());

    // The verdict's PR URL is denormalized onto the task for the header link.
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(
        item.pr_url.as_deref(),
        Some("https://github.com/acme/repo/pull/41")
    );
    assert_eq!(item.pr_number, Some(41));
}

#[tokio::test]
async fn delayed_completion_cannot_finish_a_replacement_run() {
    let state = super::test_state_with_seed("desktop-stale-completion", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Replace the failed run",
            Some("Replace the failed run"),
            "in progress",
            "2026-08-04 00:00:00",
        )
        .unwrap();
        let insert = |id: &str, status: &str| {
            db.insert_stage_run(crate::db::NewStageRun {
                id,
                task_id: "task-1",
                stage: "in progress",
                kind: "main",
                agent: Some("implement"),
                agent_provider: Some("codex"),
                model: None,
                effort: None,
                status,
                result: None,
                feedback: None,
                session_id: Some("task-1"),
                provider_session_id: None,
                cwd: None,
                resumed_from_run_id: None,
            })
            .unwrap();
        };
        // Deliberately reverse lexical id order: insertion lineage, not UUID
        // ordering within SQLite's one-second timestamp precision, is current.
        insert("zz-run-old", "failed");
        insert("aa-run-replacement", "running");
    });
    let db_path = state.config.db_path.clone();
    let response = super::router(state)
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "zz-run-old",
                        "status": "success",
                        "summary": "late success from the replaced process"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let db = Db::open(&db_path).unwrap();
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(
        runs.iter()
            .find(|run| run.id == "aa-run-replacement")
            .unwrap()
            .status,
        "running"
    );
}

#[tokio::test]
async fn timed_out_completion_retry_is_idempotent_after_a_replacement_run_starts() {
    let summary = "post completed before the response arrived";
    let stage_result = serde_json::json!({
        "status": "success",
        "summary": summary,
        "metadata": null,
    })
    .to_string();
    let state = super::test_state_with_seed("desktop-completion-retry", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Complete exactly one run",
            Some("Completion retry"),
            "in progress",
            "2026-08-04 00:00:00",
        )
        .unwrap();
        let run = |id: &'static str, status: &'static str| crate::db::NewStageRun {
            id,
            task_id: "task-1",
            stage: "in progress",
            kind: "post",
            agent: Some("commit"),
            agent_provider: Some("codex"),
            model: None,
            effort: None,
            status,
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        };
        db.insert_stage_run_with_completion_binding(run("run-original", "running"), None, true)
            .unwrap();
        db.finish_stage_run(
            "run-original",
            "succeeded",
            Some(&stage_result),
            Some(summary),
        )
        .unwrap();
        db.insert_stage_run_with_completion_binding(run("run-replacement", "running"), None, true)
            .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let response = super::router(state)
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "run-original",
                        "completionAttemptKey": "same-verdict",
                        "status": "success",
                        "summary": summary
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
        db.stage_run("run-replacement").unwrap().unwrap().status,
        "running"
    );
}

#[tokio::test]
async fn pre_upgrade_adapter_cannot_complete_rebound_post_after_lost_main_response() {
    let summary = "main completed before the response was lost";
    let stage_result = serde_json::json!({
        "status": "success",
        "summary": summary,
        "metadata": null,
    })
    .to_string();
    let state =
        super::test_state_with_seed("desktop-legacy-completion-retry", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Complete exactly one run",
                Some("Legacy completion retry"),
                "in progress",
                "2026-08-04 00:00:00",
            )
            .unwrap();
            let run = |id: &'static str, kind: &'static str, status: &'static str| {
                crate::db::NewStageRun {
                    id,
                    task_id: "task-1",
                    stage: "in progress",
                    kind,
                    agent: Some("implement"),
                    agent_provider: Some("codex"),
                    model: None,
                    effort: None,
                    status,
                    result: None,
                    feedback: None,
                    session_id: Some("task-1"),
                    provider_session_id: None,
                    cwd: None,
                    resumed_from_run_id: None,
                }
            };
            db.insert_stage_run_with_completion_binding(
                run("run-task-1-original", "main", "running"),
                None,
                true,
            )
            .unwrap();
            db.finish_stage_run(
                "run-task-1-original",
                "succeeded",
                Some(&stage_result),
                Some(summary),
            )
            .unwrap();
            db.insert_stage_run_with_completion_binding(
                run("run-task-1-post", "post", "running"),
                None,
                true,
            )
            .unwrap();
        });
    let db_path = state.config.db_path.clone();
    let context_dir = std::path::Path::new(&state.config.daemon_dir).join("runtime/completion");
    std::fs::create_dir_all(&context_dir).unwrap();
    // Exact short-lived old format after its unlocked post-200 write raced
    // with server rebinding: no immutable identity and no retry history.
    std::fs::write(
        context_dir.join("run-task-1-original.json"),
        r#"{"runId":"run-task-1-post"}"#,
    )
    .unwrap();
    let request_without_binding = serde_json::json!({
        "status": "success",
        "summary": summary,
    });
    let attempt_key = kanna_tool_catalog::completion_attempt_key(&request_without_binding).unwrap();

    let response = super::router(state)
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        // A surviving old adapter reads the rebound successor
                        // and cannot see the new history fields.
                        "runId": "run-task-1-post",
                        "completionAttemptKey": attempt_key,
                        "status": "success",
                        "summary": summary,
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
        db.stage_run("run-task-1-post").unwrap().unwrap().status,
        "running"
    );
}

#[tokio::test]
async fn distinct_current_run_with_identical_verdict_is_not_rewritten_to_history() {
    let summary = "the same deterministic verdict";
    let stage_result = serde_json::json!({
        "status": "failure",
        "summary": summary,
        "metadata": null,
    })
    .to_string();
    let state = super::test_state_with_seed(
        "desktop-distinct-identical-completion",
        "Studio Mac",
        |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Repeat deterministic work",
                Some("Repeat deterministic work"),
                "in progress",
                "2026-08-04 00:00:00",
            )
            .unwrap();
            let run = |id: &'static str, status: &'static str| crate::db::NewStageRun {
                id,
                task_id: "task-1",
                stage: "in progress",
                kind: "main",
                agent: Some("implement"),
                agent_provider: Some("codex"),
                model: None,
                effort: None,
                status,
                result: None,
                feedback: None,
                session_id: Some("task-1"),
                provider_session_id: None,
                cwd: None,
                resumed_from_run_id: None,
            };
            db.insert_stage_run_with_completion_binding(
                run("run-task-1-old", "running"),
                Some("manual"),
                true,
            )
            .unwrap();
            db.finish_stage_run(
                "run-task-1-old",
                "failed",
                Some(&stage_result),
                Some(summary),
            )
            .unwrap();
            db.insert_stage_run_with_completion_binding(
                run("run-task-1-new", "running"),
                Some("manual"),
                true,
            )
            .unwrap();
        },
    );
    let db_path = state.config.db_path.clone();
    let seeded = Db::open(&db_path)
        .unwrap()
        .latest_stage_run("task-1")
        .unwrap()
        .unwrap();
    assert_eq!(seeded.id, "run-task-1-new");
    assert_eq!(seeded.completion_transition.as_deref(), Some("manual"));
    let context_dir = std::path::Path::new(&state.config.daemon_dir).join("runtime/completion");
    std::fs::create_dir_all(&context_dir).unwrap();
    std::fs::write(
        context_dir.join("run-task-1-old.json"),
        r#"{"runId":"run-task-1-old"}"#,
    )
    .unwrap();
    let request_without_binding = serde_json::json!({
        "status": "failure",
        "summary": summary,
    });
    let attempt_key = kanna_tool_catalog::completion_attempt_key(&request_without_binding).unwrap();

    let response = super::router(state)
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "run-task-1-new",
                        "completionAttemptKey": attempt_key,
                        "status": "failure",
                        "summary": summary,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&response_body)
    );
    let db = Db::open(&db_path).unwrap();
    assert_eq!(
        db.stage_run("run-task-1-new").unwrap().unwrap().status,
        "failed"
    );
}

#[tokio::test]
async fn missing_run_id_is_legacy_only_and_cannot_complete_a_new_bound_run() {
    let seed = |db: &Db, task_id: &'static str, run_id: &'static str, bound: bool| {
        db.insert_test_pipeline_item(
            task_id,
            "repo-1",
            "Compatibility completion",
            Some("Compatibility completion"),
            "in progress",
            "2026-08-04 00:00:00",
        )
        .unwrap();
        db.insert_stage_run_with_completion_binding(
            crate::db::NewStageRun {
                id: run_id,
                task_id,
                stage: "in progress",
                kind: "main",
                agent: Some("implement"),
                agent_provider: Some("codex"),
                model: None,
                effort: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some(task_id),
                provider_session_id: None,
                cwd: None,
                resumed_from_run_id: None,
            },
            None,
            bound,
        )
        .unwrap();
    };
    let state = super::test_state_with_seed("desktop-completion-compat", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        seed(db, "task-legacy", "run-legacy", false);
        seed(db, "task-bound", "run-bound", true);
    });
    let app = super::router(state);
    let request = |task_id: &'static str| {
        Request::post(format!("/v1/tasks/{task_id}/actions/complete-stage"))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "status": "failure",
                    "summary": "legacy client verdict"
                })
                .to_string(),
            ))
            .unwrap()
    };

    assert_eq!(
        app.clone()
            .oneshot(request("task-legacy"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK,
        "an upgraded server must accept a surviving old client for a pre-upgrade run"
    );
    assert_eq!(
        app.oneshot(request("task-bound")).await.unwrap().status(),
        StatusCode::CONFLICT,
        "newly spawned runs must require their fixed identity"
    );
}

#[tokio::test]
async fn complete_stage_route_parses_pr_url_from_summary_fallback() {
    let repo_temp = tempfile::Builder::new()
        .prefix("kanna-http-complete-stage-summary-")
        .tempdir()
        .unwrap();
    let repo_root = repo_temp.path().join("repo");
    init_test_git_repo(&repo_root);
    let repo_path = repo_root.to_string_lossy().to_string();
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", move |db| {
        db.insert_test_repo_with_path("repo-1", &repo_path, "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Ship it",
            Some("Ship it"),
            "in progress",
            "2026-07-03 00:00:00",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-1",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: Some("pr"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    // No metadata: agents reporting through plain kanna-cli put the URL in
    // the summary.
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "run-1",
                        "status": "success",
                        "summary": "Created PR https://github.com/acme/repo/pull/7 from add-feature."
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(
        item.pr_url.as_deref(),
        Some("https://github.com/acme/repo/pull/7")
    );
    assert_eq!(item.pr_number, Some(7));
}

#[tokio::test]
async fn complete_stage_success_after_failed_post_refinishes_run_and_transitions() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-post-refinish-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual",
      "post": { "name": "commit", "prompt": "Commit $TASK_PROMPT" } },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nagent_provider: claude\n---\nReview task $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-post-refinish-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        loop {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            let response = match &command {
                DaemonCommand::Kill { .. } => DaemonEvent::Error {
                    code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                    message: "session not found".to_string(),
                },
                DaemonCommand::Spawn { session_id, .. } => DaemonEvent::SessionCreated {
                    session_id: session_id.clone(),
                },
                DaemonCommand::SpawnAgent { session_id, .. } => DaemonEvent::SessionCreated {
                    session_id: session_id.clone(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            let done = matches!(
                &command,
                DaemonCommand::Spawn { .. } | DaemonCommand::SpawnAgent { .. }
            );
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            if done {
                break;
            }
        }
        let _ = AgentProvider::Claude;
    });

    let (kanna_cli_path, created_sidecar) = ensure_test_kanna_cli_sidecar();
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-post-refinish-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-post-refinish-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement it",
        Some("Implement it"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-main",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run("run-main", "succeeded", None, None)
        .unwrap();
    // The post ran and honestly reported failure; the task is parked with no
    // running run.
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-post",
        task_id: "task-1",
        stage: "commit",
        kind: "post",
        agent: None,
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run("run-post", "failed", None, Some("dirty worktree"))
        .unwrap();
    drop(db);

    // The agent recovers (cleans up, commits) and sends a late success
    // verdict: it must re-finish the SAME post run and perform the post's
    // deferred transition to `review`.
    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "run-post",
                        "status": "success",
                        "summary": "cleaned up and committed"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    daemon_server.await.unwrap();

    // The deferred transition executes on a detached task; wait for it.
    // The stage landed on is the built-in `no-review` workflow's second stage:
    // this repo's `.kanna` fixture is committed but never published to
    // origin/main, which is where definitions resolve from, so it never
    // takes effect. What this test asserts is the transition itself, not
    // which workflow supplied the stage name.
    let db = Db::open(&config.db_path).unwrap();
    let task = wait_for_running_task_stage(&db, "task-1", "pr").await;
    assert_eq!(task.stage.as_deref(), Some("pr"));
    assert!(task.closed_at.is_none());

    let next_stage_run = wait_for_stage_run(&db, "task-1", "pr").await;
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    let post_run = runs.iter().find(|run| run.id == "run-post").unwrap();
    assert_eq!(post_run.status, "succeeded", "late verdict wins");
    assert_eq!(
        post_run.feedback.as_deref(),
        Some("cleaned up and committed")
    );
    assert_eq!(next_stage_run.status, "running");

    if created_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
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
                        "runId": "missing-run",
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
                        "runId": "closed-run",
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

/// The advance-stage handler's prepare step resolves repository definitions
/// (which runs `git fetch origin`) and forks the next workspace — synchronous
/// git work that historically ran directly on a Tokio runtime worker. On the
/// shared runtime that also carries every KSP terminal stream, that starved
/// terminal output and input for the duration of the transition (frozen
/// terminals, delayed echo — recovered only by detaching and reattaching the
/// task's terminal). Run the real route on a current-thread runtime with a
/// deliberately slow `git fetch origin` and require the runtime to stay
/// responsive throughout: the blocking work must live on the blocking pool.
#[tokio::test(flavor = "current_thread")]
async fn advance_stage_route_stays_responsive_while_prepare_blocks_on_git() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-advance-block-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nname: Reviewer\ndescription: Test review agent\nagent_provider: claude\n---\nReview task $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    super::add_slow_fetch_origin(&repo_root, 2);

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-advance-block-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        loop {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            let session_id = match command {
                DaemonCommand::Kill { .. } => {
                    let response = DaemonEvent::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    };
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                        )
                        .await
                        .unwrap();
                    continue;
                }
                DaemonCommand::Spawn { session_id, .. } => session_id,
                DaemonCommand::SpawnAgent { session_id, .. } => session_id,
                other => panic!("expected stage advance spawn command, got {:?}", other),
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
            break;
        }
    });

    let (kanna_cli_path, created_sidecar) = ensure_test_kanna_cli_sidecar();
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-advance-block-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-advance-block-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "source-1",
        "repo-1",
        "Implement it",
        Some("Implement it"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "source-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
        "claude",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let request = tokio::spawn(
        app.oneshot(
            Request::post("/v1/tasks/source-1/actions/advance-stage")
                .body(Body::empty())
                .unwrap(),
        ),
    );

    // While the request (and its ~2s blocked `git fetch origin`) is in
    // flight, this current-thread runtime must keep scheduling promptly. If
    // the prepare step ran on the runtime thread, one wakeup would stall for
    // the full fetch duration.
    let (response, max_drift) = super::await_measuring_runtime_drift(request).await;
    assert!(
        max_drift < super::MAX_RUNTIME_DRIFT,
        "stage advance prepare blocked the async runtime for {max_drift:?}"
    );

    let response = response.unwrap();
    if response.status() != StatusCode::OK {
        daemon_server.abort();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        panic!(
            "expected advance-stage to succeed, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }

    // The detached transition also runs blocking git/SQLite work; it must
    // complete (and therefore must run off the runtime thread) while this
    // current-thread test keeps polling.
    let db = Db::open(&config.db_path).unwrap();
    let source = wait_for_running_task_stage(&db, "source-1", "review").await;
    assert_eq!(source.stage.as_deref(), Some("review"));

    daemon_server.await.unwrap();
    if created_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Closing a task's last blocker starts its dormant dependents inline in the
/// close handler. Dependent preparation resolves repository definitions
/// (`git fetch origin`) and creates/merges the dependent worktree —
/// synchronous git work that historically ran directly on a Tokio runtime
/// worker and froze every KSP terminal stream for its duration. Run the real
/// manual-close route on a current-thread runtime with a deliberately slow
/// fetch and require the runtime to stay responsive throughout, then prove
/// the dependent still lands once the blocked fetch resolves.
#[tokio::test(flavor = "current_thread")]
async fn close_last_blocker_stays_responsive_while_dependent_prepare_blocks() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-close-unblock-block-{unique}"));
    init_test_git_repo(&repo_root);

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-close-unblock-block-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-close-unblock-block-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-close-unblock-block-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-a",
        "repo-1",
        "Build prerequisite",
        Some("Prerequisite"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-a", "task-a-stage", "default", None, "claude")
        .unwrap();
    insert_running_pr_run(&db, "task-a", "task-a-pr-run");
    drop(db);

    let blocker_worktree_path = commit_branch_change(
        &repo_root,
        "task-a-stage",
        "blocker-output.txt",
        "blocker output",
    );
    let blocker_head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&blocker_worktree_path)
        .output()
        .unwrap();
    assert!(blocker_head.status.success());
    let blocker_head = String::from_utf8_lossy(&blocker_head.stdout)
        .trim()
        .to_string();

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
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
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

    // Only now make definition fetches slow: the dormant dependent's
    // preparation during the close is the blocked section under test.
    super::add_slow_fetch_origin(&repo_root, 2);

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let expected_task_id = dependent.task_id.clone();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut spawned = Vec::new();
        loop {
            let Some(command) =
                read_test_daemon_command_optional(&mut reader, &mut write_half).await
            else {
                break;
            };
            match command {
                DaemonCommand::Kill { .. } => {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                DaemonCommand::Spawn { session_id, .. } => {
                    assert_eq!(session_id, expected_task_id);
                    spawned.push(session_id.clone());
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(session_id, expected_task_id);
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    spawned.push(session_id.clone());
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
                other => panic!("unexpected daemon command: {:?}", other),
            }
        }
        spawned
    });

    let close_request = tokio::spawn(
        app.oneshot(
            Request::post("/v1/tasks/task-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        ),
    );
    let (close_response, max_drift) = super::await_measuring_runtime_drift(close_request).await;
    assert!(
        max_drift < super::MAX_RUNTIME_DRIFT,
        "dependent start during manual close blocked the async runtime for {max_drift:?}"
    );
    assert_eq!(close_response.unwrap().status(), StatusCode::NO_CONTENT);

    // The dependent still lands after the blocked fetch resolves: spawned
    // once, worktree created on the blocker's branch tip.
    let spawned = daemon_server.await.unwrap();
    assert_eq!(spawned.len(), 1, "close should start the dependent once");
    let db = Db::open(&config.db_path).unwrap();
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
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

/// The parked-PR completion path (`complete-stage` at a manual pr stage with
/// a PR url) optimistically starts dormant dependents inline in the handler.
/// Same hazard and same requirement as the manual close: dependent
/// preparation must not occupy the runtime, and the dependent must still
/// land once its blocked definition fetch resolves.
#[tokio::test(flavor = "current_thread")]
async fn complete_pr_stage_stays_responsive_while_dependent_prepare_blocks() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _sidecar_guard = crate::test_sidecar_guard();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-pr-optimistic-block-{unique}"));
    init_test_git_repo(&repo_root);

    let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-pr-optimistic-block-daemon-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-pr-optimistic-block-{unique}")),
        kanna_cli_path: Some(kanna_cli_path.to_string_lossy().to_string()),
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-pr-optimistic-block-{unique}.json"),
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
    db.update_test_pipeline_item_stage_context("task-a", "task-a-stage", "default", None, "claude")
        .unwrap();
    insert_running_pr_run(&db, "task-a", "task-a-pr-run");
    drop(db);

    let blocker_worktree_path = commit_branch_change(
        &repo_root,
        "task-a-stage",
        "blocker-output.txt",
        "blocker output",
    );
    assert!(Command::new("git")
        .args(["branch", "-m", "task-a-pr"])
        .current_dir(&blocker_worktree_path)
        .status()
        .unwrap()
        .success());
    let db = Db::open(&config.db_path).unwrap();
    db.upsert_worktree(
        "wt-task-a",
        "task-a",
        &blocker_worktree_path.to_string_lossy(),
        "task-a-stage",
    )
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
                        "workflowName": TEST_PROVIDER_NEUTRAL_WORKFLOW,
                        "agentProvider": "claude",
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

    // Only now make definition fetches slow: the dormant dependent's
    // preparation during the parked-PR completion is the blocked section
    // under test.
    super::add_slow_fetch_origin(&repo_root, 2);

    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let expected_task_id = dependent.task_id.clone();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut spawned = Vec::new();
        loop {
            let Some(command) =
                read_test_daemon_command_optional(&mut reader, &mut write_half).await
            else {
                break;
            };
            match command {
                DaemonCommand::Kill { .. } => {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                DaemonCommand::Spawn { session_id, .. } => {
                    assert_eq!(session_id, expected_task_id);
                    spawned.push(session_id.clone());
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(session_id, expected_task_id);
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    spawned.push(session_id.clone());
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
                other => panic!("unexpected daemon command: {:?}", other),
            }
        }
        spawned
    });

    let complete_request = tokio::spawn(
        app.oneshot(
            Request::post("/v1/tasks/task-a/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "runId": "task-a-pr-run",
                        "status": "success",
                        "summary": "PR is ready",
                        "metadata": { "pr_url": "https://github.com/acme/repo/pull/7" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        ),
    );
    let (complete_response, max_drift) =
        super::await_measuring_runtime_drift(complete_request).await;
    assert!(
        max_drift < super::MAX_RUNTIME_DRIFT,
        "optimistic dependent start during pr completion blocked the async runtime for {max_drift:?}"
    );
    assert_eq!(complete_response.unwrap().status(), StatusCode::OK);

    let spawned = daemon_server.await.unwrap();
    assert_eq!(
        spawned.len(),
        1,
        "pr-stage completion should start the dependent once"
    );
    let db = Db::open(&config.db_path).unwrap();
    let blocker = db.get_pipeline_item("task-a").unwrap().unwrap();
    assert!(blocker.closed_at.is_none());
    assert_eq!(blocker.stage.as_deref(), Some("pr"));
    let dependent_item = db.get_pipeline_item(&dependent.task_id).unwrap().unwrap();
    assert_eq!(dependent_item.base_ref.as_deref(), Some("task-a-pr"));
    assert_eq!(dependent_item.activity.as_deref(), Some("working"));
    assert!(db
        .get_task_worktree_path(&dependent.task_id)
        .unwrap()
        .is_some());

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
    if created_test_sidecar {
        let _ = std::fs::remove_file(&kanna_cli_path);
    }
}
