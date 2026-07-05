use super::*;

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
        "---\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
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
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
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

    daemon_server.await.unwrap();
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
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
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
async fn status_route_reflects_pairing_session() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let pairing_response = app
        .clone()
        .oneshot(
            Request::post("/v1/pairing/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

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

    assert_eq!(status.desktop_name, "Studio Mac");
    assert_eq!(status.state, "running");
    assert!(status.pairing_code.is_some());
}
