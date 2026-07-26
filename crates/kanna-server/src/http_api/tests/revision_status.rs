use super::*;
use axum::extract::ConnectInfo;

#[tokio::test]
async fn request_revision_route_uses_revision_requester() {
    let app = super::test_router_with_revision_requester(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id, payload| {
            assert_eq!(task_id, "review-task");
            assert_eq!(payload.target_stage, "in progress");
            assert_eq!(payload.summary, "missing e2e coverage");
            assert_eq!(payload.prompt, "Add e2e coverage for task creation.");
            Ok(TaskActionResponse {
                task_id: "revision-task".to_string(),
                follow_task: None,
                revision_budget: None,
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/review-task/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "missing e2e coverage",
                        "prompt": "Add e2e coverage for task creation."
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
    assert_eq!(created.task_id, "revision-task");
}

#[tokio::test]
async fn request_revision_error_body_survives_error_logging_middleware() {
    let app = super::test_router("desktop-revision-error", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/tasks/missing-task/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "QA failed",
                        "prompt": "Add the missing coverage."
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    // The error-logging middleware buffers error bodies to record them; the
    // client must still receive the original status and message.
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let message = String::from_utf8_lossy(&body);
    assert!(
        message.contains("task not found: missing-task"),
        "error body should reach the client: {message}"
    );
}

#[tokio::test]
async fn request_revision_route_resolves_branch_style_task_id() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-branch-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "auto" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        "---\nname: Implement\ndescription: Test implementation agent\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-710917fb"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    // Full daemon/agent E2E would require staged sidecars plus a runnable agent CLI.
    // This fake daemon keeps the real HTTP handler, DB lookup, revision preparation,
    // Spawn protocol, stage-result persistence, and source-task close in scope.
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                // A durable revision replaces the task's session in place:
                // the previous session is killed before the respawn.
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    session_id
                }
                DaemonCommand::Spawn {
                    session_id,
                    args,
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert_eq!(agent_provider, Some(AgentProvider::Claude));
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    let command_line = args.join(" ");
                    assert!(command_line.contains("Implement revision:"));
                    assert!(command_line.contains("Add e2e coverage for task creation."));
                    // The pipeline declares no revision_limit, so the default
                    // cap applies and the revising agent is told which round
                    // it is and that the loop is bounded.
                    assert!(command_line.contains("Revision round 1 of 3"));
                    session_id
                }
                other => panic!("expected revision spawn command, got {:?}", other),
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-revision-branch-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        pairing_store_path: format!("/tmp/kanna-pairings-revision-branch-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "Review branch",
        Some("Review branch"),
        "review",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("710917fb", "task-710917fb", "qa", None, "claude")
        .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-710917fb/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "missing e2e coverage",
                        "prompt": "Add e2e coverage for task creation."
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
            "expected request revision to resolve branch-style task id, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "710917fb");

    // Durable revision: the SAME task moves back to the target stage with a
    // new stage run carrying the feedback; nothing is closed and no new task
    // is created. The respawn executes on a detached task; wait for it.
    let db = Db::open(&config.db_path).unwrap();
    let source = super::actions::wait_for_task_stage(&db, "710917fb", "in progress").await;
    assert_eq!(source.stage.as_deref(), Some("in progress"));
    assert!(source.closed_at.is_none());

    let runs = db.list_stage_runs_for_task("710917fb").unwrap();
    let revision_run = runs.last().expect("revision stage run recorded");
    assert_eq!(revision_run.stage, "in progress");
    assert_eq!(revision_run.kind, "main");
    assert_eq!(revision_run.status, "running");
    assert_eq!(
        revision_run.feedback.as_deref(),
        Some("Add e2e coverage for task creation.")
    );
    // An agent-requested revision spends one round of the task's budget.
    assert_eq!(db.task_revision_rounds("710917fb").unwrap(), 1);

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn automatic_revision_completion_dispatches_commit_post_through_http_routes() {
    use kanna_daemon::protocol::{AgentProvider, Command as DaemonCommand, Event as DaemonEvent};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::sync::mpsc;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-loop-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    let pipeline_def = serde_json::json!({
        "name": "qa",
        "stages": [
            {
                "name": "in progress",
                "policy": {
                    "transition": "manual",
                    "revision_transition": "auto"
                },
                "agent": "implement",
                "prompt": "$TASK_PROMPT",
                "post": {
                    "name": "commit",
                    "prompt": "Commit changes for $TASK_PROMPT"
                }
            },
            {
                "name": "review",
                "policy": { "transition": "auto" }
            }
        ]
    })
    .to_string();
    std::fs::write(repo_root.join(".kanna/pipelines/qa.json"), &pipeline_def).unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        "---\nname: Implement\ndescription: Test implementation agent\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add automatic revision pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-reviewed"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    // The durable task remains pinned to the automatic revision policy even
    // if the repo's current pipeline is later customized back to manual.
    // This makes the test distinguish snapshot policy from live definitions.
    let mut current_pipeline_def: serde_json::Value = serde_json::from_str(&pipeline_def).unwrap();
    current_pipeline_def["stages"][0]["policy"]["revision_transition"] =
        serde_json::json!("manual");
    std::fs::write(
        repo_root.join(".kanna/pipelines/qa.json"),
        current_pipeline_def.to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/pipelines/qa.json"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "customize future revisions as manual"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-loop-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let (sync_tx, mut sync_rx) = mpsc::unbounded_channel();
    let daemon_server = tokio::spawn(async move {
        // The revision request replaces the review session with a fresh
        // implementer session on the first detached daemon connection.
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let revision_session_id = loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let (response, spawned_session_id) = match command {
                DaemonCommand::Kill { .. } => (
                    DaemonEvent::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    },
                    None,
                ),
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(params.agent_provider, AgentProvider::Claude);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    assert!(params.prompt.contains("Add the missing server coverage."));
                    (
                        DaemonEvent::SessionCreated {
                            session_id: session_id.clone(),
                        },
                        Some(session_id),
                    )
                }
                DaemonCommand::Spawn {
                    session_id,
                    args,
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert_eq!(agent_provider, Some(AgentProvider::Claude));
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    assert!(args.join(" ").contains("Add the missing server coverage."));
                    (
                        DaemonEvent::SessionCreated {
                            session_id: session_id.clone(),
                        },
                        Some(session_id),
                    )
                }
                other => panic!("unexpected revision daemon command: {other:?}"),
            };
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            if let Some(session_id) = spawned_session_id {
                sync_tx.send("revision spawned").unwrap();
                break session_id;
            }
        };
        drop(write_half);

        // Successful completion must dispatch the commit post without an
        // advance-stage request. A live session receives the post as typed
        // input on the completion route's detached daemon connection.
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        for input_index in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, revision_session_id);
                    if input_index == 0 {
                        let message = String::from_utf8(data).unwrap();
                        assert!(message.contains("Commit changes for"));
                        assert!(message.contains("record stage completion"));
                    } else {
                        assert_eq!(data, vec![b'\r']);
                    }
                }
                other => panic!("expected commit post input, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
        sync_tx.send("commit dispatched").unwrap();
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-revision-loop-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        pairing_store_path: format!("/tmp/kanna-pairings-revision-loop-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Original implementation prompt.",
        Some("Automatic revision loop"),
        "review",
        "2026-07-17 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-reviewed",
        "qa",
        None,
        "claude",
    )
    .unwrap();
    db.update_test_pipeline_item_pipeline_def("review-task", &pipeline_def)
        .unwrap();
    db.insert_stage_run_with_completion_transition(
        crate::db::NewStageRun {
            id: "review-run",
            task_id: "review-task",
            stage: "review",
            kind: "main",
            agent: None,
            agent_provider: Some("claude"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("review-task"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        },
        Some("auto"),
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let revision_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/review-task/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "missing server coverage",
                        "prompt": "Add the missing server coverage."
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revision_response.status(), StatusCode::OK);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), sync_rx.recv())
            .await
            .expect("revision daemon synchronization timed out")
            .as_deref(),
        Some("revision spawned")
    );

    let db = Db::open(&config.db_path).unwrap();
    let mut revision_run = None;
    for _ in 0..100 {
        if let Some(run) = db.latest_stage_run("review-task").unwrap() {
            if run.stage == "in progress" && run.status == "running" {
                revision_run = Some(run);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let revision_run = revision_run.expect("revision stage run was not persisted");
    assert_eq!(revision_run.kind, "main");
    assert_eq!(revision_run.completion_transition.as_deref(), Some("auto"));

    let completion_response = app
        .oneshot(
            Request::post("/v1/tasks/review-task/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "status": "success",
                        "summary": "revision complete"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(completion_response.status(), StatusCode::OK);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), sync_rx.recv())
            .await
            .expect("commit post synchronization timed out")
            .as_deref(),
        Some("commit dispatched")
    );
    daemon_server.await.unwrap();

    let mut post_run = None;
    for _ in 0..100 {
        let runs = db.list_stage_runs_for_task("review-task").unwrap();
        if let Some(run) = runs
            .into_iter()
            .find(|run| run.kind == "post" && run.stage == "commit" && run.status == "running")
        {
            post_run = Some(run);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        post_run.is_some(),
        "automatic completion did not start the commit post"
    );
    let revision_run = db
        .list_stage_runs_for_task("review-task")
        .unwrap()
        .into_iter()
        .find(|run| run.id == revision_run.id)
        .unwrap();
    assert_eq!(revision_run.status, "succeeded");
    let item = db.get_pipeline_item("review-task").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("in progress"));
    assert_eq!(item.activity.as_deref(), Some("working"));

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn request_revision_route_preserves_title_and_sends_revision_prompt() {
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
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-title-{unique}"));
    init_test_git_repo(&repo_root);
    let kanna_dir = repo_root.join(".kanna");
    std::fs::create_dir_all(kanna_dir.join("pipelines")).unwrap();
    std::fs::create_dir_all(kanna_dir.join("agents/revision")).unwrap();
    std::fs::write(
        kanna_dir.join("pipelines/revision.json"),
        serde_json::json!({
            "name": "revision",
            "stages": [
                {
                    "name": "in progress",
                    "transition": "manual",
                    "agent": "revision"
                },
                { "name": "review", "transition": "auto" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        kanna_dir.join("agents/revision/AGENT.md"),
        [
            "---",
            "name: Revision",
            "description: Test revision agent",
            "agent_provider: codex",
            "---",
            "Implement revision:",
            "$TASK_PROMPT",
            "",
        ]
        .join("\n"),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add revision pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-reviewed"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-daemon-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                // A durable revision replaces the task's session in place:
                // the previous session is killed before the respawn.
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(params.agent_provider, AgentProvider::Codex);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    assert!(params.prompt.contains("Implement revision:"));
                    // A fresh revision agent gets the composed context: the
                    // original task prompt plus the reviewer's feedback.
                    assert!(params
                        .prompt
                        .contains("Reviewer feedback:\nAdd E2E coverage for title preservation."));
                    assert!(params
                        .prompt
                        .contains("Original task:\nOriginal task prompt for revision context."));
                    session_id
                }
                DaemonCommand::Spawn {
                    session_id,
                    args,
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert_eq!(agent_provider, Some(AgentProvider::Codex));
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    let command_line = args.join(" ");
                    assert!(command_line.contains("Implement revision:"));
                    assert!(command_line
                        .contains("Reviewer feedback:\nAdd E2E coverage for title preservation."));
                    assert!(command_line
                        .contains("Original task:\nOriginal task prompt for revision context."));
                    session_id
                }
                other => panic!("expected revision spawn command, got {:?}", other),
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-revision-title-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        pairing_store_path: format!("/tmp/kanna-pairings-revision-title-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Original task prompt for revision context.",
        Some("Preserved review title"),
        "review",
        "2026-05-12 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-reviewed",
        "revision",
        Some("{\"status\":\"success\",\"summary\":\"ready for review\"}"),
        "codex",
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/review-task/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "missing title coverage",
                        "prompt": "Add E2E coverage for title preservation."
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
    assert_eq!(created.task_id, "review-task");

    // Durable revision: the SAME task keeps its identity and title; only the
    // stage moves back and a new run carries the revision feedback. The
    // respawn executes on a detached task; wait for it.
    let db = Db::open(&config.db_path).unwrap();
    let reviewed = super::actions::wait_for_task_stage(&db, "review-task", "in progress").await;
    assert_eq!(reviewed.stage.as_deref(), Some("in progress"));
    assert!(reviewed.closed_at.is_none());
    assert_eq!(
        reviewed.display_name.as_deref(),
        Some("Preserved review title")
    );
    assert_eq!(
        reviewed.prompt.as_deref(),
        Some("Original task prompt for revision context."),
        "revision must not overwrite the task's original prompt"
    );

    daemon_server.await.unwrap();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn status_route_does_not_expose_pairing_secret() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let mut pairing_request = Request::post("/v1/pairing/sessions")
        .body(Body::empty())
        .unwrap();
    pairing_request
        .extensions_mut()
        .insert(ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49152,
        ))));
    let pairing_response = app.clone().oneshot(pairing_request).await.unwrap();

    assert_eq!(pairing_response.status(), StatusCode::OK);

    let status_response = app
        .oneshot(Request::get("/v1/status").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(status_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(status_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let status: MobileServerStatus = from_slice(&body).unwrap();
    let status_json: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(status.desktop_name, "Studio Mac");
    assert_eq!(status.state, "running");
    assert_eq!(status_json["version"], "test-version");
    assert_eq!(status_json["environment"], "development");
    assert_eq!(status_json["serverVersion"], "test-version");
    assert!(status.pairing_code.is_none());
}

/// Repo + config + seeded task for the revision-budget tests: a pipeline that
/// caps revision rounds, a task parked at `review` with a running review run,
/// and the round budget already spent.
struct RevisionBudgetFixture {
    config: Config,
    repo_root: PathBuf,
    daemon_dir: PathBuf,
    socket_path: PathBuf,
}

fn setup_revision_budget_fixture(label: &str, revision_limit: i64) -> RevisionBudgetFixture {
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = format!(
        "{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-budget-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(
        repo_root.join(".kanna/pipelines/budget.json"),
        serde_json::json!({
            "name": "budget",
            "revision_limit": revision_limit,
            "stages": [
                {
                    "name": "in progress",
                    "prompt": "$TASK_PROMPT",
                    "policy": { "transition": "manual" }
                },
                { "name": "review", "policy": { "transition": "auto" } },
                { "name": "pr", "policy": { "transition": "manual" } }
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
        .args(["commit", "-m", "add budgeted pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-budget-1"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-budget-d-{unique}"));
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
        db_path: Db::test_db_path(&format!("http-api-revision-budget-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        pairing_store_path: format!("/tmp/kanna-pairings-revision-budget-{unique}.json"),
    };

    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "budget-1",
        "repo-1",
        "Add a focused fix",
        Some("Add a focused fix"),
        "review",
        "2026-07-26 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "budget-1",
        "task-budget-1",
        "budget",
        None,
        "claude",
    )
    .unwrap();
    // Spend the whole budget, as a task that has already been round-tripped
    // through review this many times would have.
    for _ in 0..revision_limit {
        db.bump_task_revision_rounds("budget-1").unwrap();
    }
    db.insert_stage_run(crate::db::NewStageRun {
        id: "budget-review-run",
        task_id: "budget-1",
        stage: "review",
        kind: "main",
        agent: Some("qa-dispatcher"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("budget-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    RevisionBudgetFixture {
        config,
        repo_root,
        daemon_dir,
        socket_path,
    }
}

fn cleanup_revision_budget_fixture(fixture: &RevisionBudgetFixture) {
    let _ = std::fs::remove_file(&fixture.socket_path);
    let _ = std::fs::remove_dir_all(&fixture.daemon_dir);
    let _ = std::fs::remove_dir_all(&fixture.repo_root);
}

#[tokio::test]
async fn agent_revision_request_parks_the_task_once_the_round_budget_is_spent() {
    let fixture = setup_revision_budget_fixture("agent", 2);

    // No daemon is listening: an exhausted budget must start nothing, so the
    // request cannot need one.
    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/budget-1/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "QA failed: review-ui",
                        "prompt": "Rebuild the sidebar with a different layout."
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
    let action: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(action.task_id, "budget-1");
    let budget = action.revision_budget.expect("revision budget reported");
    assert!(budget.exhausted);
    assert_eq!(budget.rounds, 2);
    assert_eq!(budget.limit, 2);
    assert!(
        budget.message.contains("parked"),
        "the agent must be told why nothing started: {}",
        budget.message
    );

    let db = Db::open(&fixture.config.db_path).unwrap();
    let task = db.get_task_stage_source("budget-1").unwrap().unwrap();
    // Parked: the task stays where it was, and no round was spent on a
    // revision that never happened.
    assert_eq!(task.stage.as_deref(), Some("review"));
    assert_eq!(task.branch.as_deref(), Some("task-budget-1"));
    assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 2);
    assert_eq!(
        db.get_pipeline_item("budget-1")
            .unwrap()
            .unwrap()
            .activity
            .as_deref(),
        Some("unread"),
        "a parked task must surface to its human"
    );

    // The review verdict is still recorded, with the requested changes kept as
    // the run's feedback so nothing the reviewer found is lost.
    let runs = db.list_stage_runs_for_task("budget-1").unwrap();
    assert_eq!(runs.len(), 1, "no revision run may be created");
    let review_run = &runs[0];
    assert_eq!(review_run.status, "failed");
    assert_eq!(
        review_run.feedback.as_deref(),
        Some("Rebuild the sidebar with a different layout.")
    );
    let result: serde_json::Value =
        serde_json::from_str(review_run.result.as_deref().unwrap()).unwrap();
    let summary = result["summary"].as_str().unwrap();
    assert!(summary.contains("Parked for human review"), "{summary}");
    assert!(summary.contains("QA failed: review-ui"), "{summary}");

    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}

#[tokio::test]
async fn human_revision_request_ignores_the_budget_and_hands_it_back() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let fixture = setup_revision_budget_fixture("human", 1);

    // Fake daemon: the human-requested revision must reach a real spawn even
    // though the agent budget is spent.
    let daemon_listener = UnixListener::bind(&fixture.socket_path).unwrap();
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = daemon_listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
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
                DaemonCommand::SpawnAgent { session_id, .. } => session_id,
                DaemonCommand::Spawn { session_id, .. } => session_id,
                other => panic!("expected revision spawn command, got {:?}", other),
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

    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/budget-1/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "needs one more pass",
                        "prompt": "Fix the failing typecheck.",
                        "origin": "human"
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
        cleanup_revision_budget_fixture(&fixture);
        panic!(
            "human revision must not be refused by the agent budget, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let action: TaskActionResponse = from_slice(&body).unwrap();
    let budget = action.revision_budget.expect("revision budget reported");
    assert!(!budget.exhausted);
    assert_eq!(budget.rounds, 0, "the budget is handed back to the agents");
    assert_eq!(budget.limit, 1);

    let db = Db::open(&fixture.config.db_path).unwrap();
    let task = super::actions::wait_for_task_stage(&db, "budget-1", "in progress").await;
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 0);

    daemon_server.await.unwrap();
    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}

/// `$PREV_RESULT` binds the latest finished run of any kind, so for a review
/// stage whose predecessor declares a commit post it is the *commit* agent's
/// result — the implementer's own report, including work it declined, is not
/// reachable through it. `$PREV_MAIN_RESULT` binds the previous main run.
/// This drives the real chain (implementation main run -> commit post ->
/// stage transition -> review prompt) through the router, because the bug
/// lives in how stage-run persistence, post completion, and prompt
/// substitution meet.
#[tokio::test]
async fn review_prompt_receives_the_implementer_result_while_prev_result_keeps_the_post_result() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    const DECLINED_MARKER: &str = "DECLINED: the migration finding is out of scope for this task.";
    const COMMIT_SUMMARY: &str = "committed 2 files for review";

    let unique = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-prev-main-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/prevmain.json"),
        serde_json::json!({
            "name": "prevmain",
            "stages": [
                {
                    "name": "in progress",
                    "policy": { "transition": "auto" },
                    "agent": "implement",
                    "prompt": "$TASK_PROMPT",
                    "post": { "name": "commit", "prompt": "Commit for $TASK_PROMPT" }
                },
                {
                    "name": "review",
                    "policy": { "transition": "manual" },
                    "agent": "reviewer",
                    "prompt": "IMPLEMENTER_RESULT[$PREV_MAIN_RESULT]\nLATEST_RESULT[$PREV_RESULT]"
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    for agent in ["implement", "reviewer"] {
        std::fs::write(
            repo_root.join(format!(".kanna/agents/{agent}/AGENT.md")),
            format!("---\nname: {agent}\ndescription: Test {agent} agent\nagent_provider: claude\n---\nRun {agent}."),
        )
        .unwrap();
    }
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add prev-main pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    super::publish_test_origin_main(&repo_root);
    assert!(Command::new("git")
        .args(["branch", "task-prevmain"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let daemon_dir = std::env::temp_dir().join(format!("kanna-http-prev-main-d-{unique}"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let daemon_listener = UnixListener::bind(&socket_path).unwrap();

    // Records every prompt the daemon is asked to spawn, so the review
    // stage's rendered prompt can be inspected after the transition.
    let spawned_prompts: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&spawned_prompts);
    let daemon_server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = daemon_listener.accept().await else {
                return;
            };
            let recorder = Arc::clone(&recorder);
            tokio::spawn(async move {
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {}
                    }
                    let Ok(command) = serde_json::from_str::<DaemonCommand>(line.trim()) else {
                        return;
                    };
                    let response = match command {
                        DaemonCommand::Kill { .. } => DaemonEvent::Error {
                            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                            message: "session not found".to_string(),
                        },
                        DaemonCommand::SpawnAgent { session_id, params } => {
                            recorder.lock().unwrap().push(params.prompt.clone());
                            DaemonEvent::SessionCreated { session_id }
                        }
                        DaemonCommand::Spawn {
                            session_id, args, ..
                        } => {
                            recorder.lock().unwrap().push(args.join(" "));
                            DaemonEvent::SessionCreated { session_id }
                        }
                        DaemonCommand::Input { .. } => DaemonEvent::Ok,
                        _ => DaemonEvent::Ok,
                    };
                    if write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&format!("http-api-prev-main-{unique}")),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        pairing_store_path: format!("/tmp/kanna-pairings-prev-main-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "prevmain-1",
        "repo-1",
        "Original implementation prompt.",
        Some("Prev main result"),
        "in progress",
        "2026-07-27 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "prevmain-1",
        "task-prevmain",
        "prevmain",
        None,
        "claude",
    )
    .unwrap();
    db.insert_stage_run_with_completion_transition(
        crate::db::NewStageRun {
            id: "prevmain-impl-run",
            task_id: "prevmain-1",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("claude"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("prevmain-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        },
        Some("auto"),
    )
    .unwrap();
    drop(db);

    let app = super::router(Arc::new(super::AppState::new(config.clone())));

    // 1. The implementation main run reports what it did — and what it
    //    declined. Auto completion dispatches the commit post.
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/prevmain-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "status": "success",
                        "summary": format!("Implemented the fix. {DECLINED_MARKER}")
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let db = Db::open(&config.db_path).unwrap();
    let mut post_run = None;
    for _ in 0..200 {
        if let Some(run) = db
            .list_stage_runs_for_task("prevmain-1")
            .unwrap()
            .into_iter()
            .find(|run| run.kind == "post" && run.stage == "commit")
        {
            post_run = Some(run);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(post_run.is_some(), "the commit post was not dispatched");

    // 2. The commit post reports its own, different result and finishes,
    //    which performs the transition into the review stage.
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/prevmain-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "status": "success", "summary": COMMIT_SUMMARY })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let mut review_prompt = None;
    for _ in 0..200 {
        if let Some(prompt) = spawned_prompts
            .lock()
            .unwrap()
            .iter()
            .find(|prompt| prompt.contains("IMPLEMENTER_RESULT["))
            .cloned()
        {
            review_prompt = Some(prompt);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let review_prompt = review_prompt.expect("the review stage never spawned with its prompt");

    let implementer_field = review_prompt
        .split("IMPLEMENTER_RESULT[")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("IMPLEMENTER_RESULT field")
        .to_string();
    let latest_field = review_prompt
        .split("LATEST_RESULT[")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("LATEST_RESULT field")
        .to_string();

    // $PREV_MAIN_RESULT carries the implementer's report, declined finding
    // and all — this is what the QA dispatcher reads to know an earlier
    // finding was never addressed.
    assert!(
        implementer_field.contains(DECLINED_MARKER),
        "the review stage must receive the implementer's declined finding: {implementer_field}"
    );
    assert!(
        !implementer_field.contains(COMMIT_SUMMARY),
        "the implementer binding must not be the commit post's result: {implementer_field}"
    );
    // $PREV_RESULT keeps its documented meaning for the pipelines that want
    // the post's result.
    assert!(
        latest_field.contains(COMMIT_SUMMARY),
        "$PREV_RESULT must still carry the latest run's result: {latest_field}"
    );

    let item = db.get_pipeline_item("prevmain-1").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("review"));

    daemon_server.abort();
    drop(db);
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}
