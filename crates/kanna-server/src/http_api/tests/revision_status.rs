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
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = super::unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-branch-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::write(
            repo_root.join(".kanna/workflows/qa.json"),
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
        .args(["commit", "-m", "add workflow"])
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
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
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
                    // The workflow declares no revision_limit, so the default
                    // cap applies and the revising agent is told which round
                    // it is and that the loop is bounded.
                    assert!(command_line.contains("Revision round 1 of 5"));
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
        activity_event_debounce_seconds: 300,
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
    let source = super::actions::wait_for_running_task_stage(&db, "710917fb", "in progress").await;
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
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::sync::mpsc;

    let unique = super::unique_test_suffix();
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
    std::fs::write(repo_root.join(".kanna/workflows/qa.json"), &pipeline_def).unwrap();
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
        .args(["commit", "-m", "add automatic revision workflow"])
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
    // if the repo's current workflow is later customized back to manual.
    // This makes the test distinguish snapshot policy from live definitions.
    let mut current_workflow_def: serde_json::Value = serde_json::from_str(&pipeline_def).unwrap();
    current_workflow_def["stages"][0]["policy"]["revision_transition"] =
        serde_json::json!("manual");
    std::fs::write(
        repo_root.join(".kanna/workflows/qa.json"),
        current_workflow_def.to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/workflows/qa.json"])
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
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
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
        let command = read_test_daemon_command(&mut reader, &mut write_half).await;
        match command {
            DaemonCommand::SubmitInput { session_id, data } => {
                assert_eq!(session_id, revision_session_id);
                let message = String::from_utf8(data).unwrap();
                assert!(message.contains("Commit changes for"));
                assert!(message.contains("record stage completion"));
            }
            other => panic!("expected semantic commit post input, got {other:?}"),
        }
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes())
            .await
            .unwrap();
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
        activity_event_debounce_seconds: 300,
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
            effort: None,
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
            .expect("revision daemon synchronization timed out"),
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
                        "runId": revision_run.id,
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
            .expect("commit post synchronization timed out"),
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
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = super::unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-title-{unique}"));
    init_test_git_repo(&repo_root);
    let kanna_dir = repo_root.join(".kanna");
    std::fs::create_dir_all(kanna_dir.join("workflows")).unwrap();
    std::fs::create_dir_all(kanna_dir.join("agents/revision")).unwrap();
    std::fs::write(
        kanna_dir.join("workflows/revision.json"),
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
        .args(["commit", "-m", "add revision workflow"])
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
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            if super::answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
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
        activity_event_debounce_seconds: 300,
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
    let reviewed =
        super::actions::wait_for_running_task_stage(&db, "review-task", "in progress").await;
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
    assert_eq!(status_json["kspStreamVersion"], 2);
    assert!(status.pairing_code.is_none());
}

/// Repo + config + seeded task for the revision-budget tests: a workflow that
/// caps revision rounds, a task parked at `review` with a running review run,
/// and the round budget already spent.
struct RevisionBudgetFixture {
    config: Config,
    repo_root: PathBuf,
    daemon_dir: PathBuf,
    socket_path: PathBuf,
}

/// The same fixture with its whole revision budget already spent, which is
/// what the exhausted-budget tests need.
fn setup_revision_budget_fixture(label: &str, revision_limit: i64) -> RevisionBudgetFixture {
    setup_revision_budget_fixture_with_spent_rounds(label, revision_limit, revision_limit)
}

fn setup_revision_budget_fixture_with_spent_rounds(
    label: &str,
    revision_limit: i64,
    spent_rounds: i64,
) -> RevisionBudgetFixture {
    let unique = format!("{label}-{}", super::unique_test_suffix());
    let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-budget-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::write(
        repo_root.join(".kanna/workflows/budget.json"),
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
        .args(["commit", "-m", "add budgeted workflow"])
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
        activity_event_debounce_seconds: 300,
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
    // Spend the requested rounds, as a task that has already been
    // round-tripped through review that many times would have.
    for _ in 0..spent_rounds {
        db.try_claim_agent_revision_round("budget-1", 0).unwrap();
    }
    db.insert_stage_run(crate::db::NewStageRun {
        id: "budget-review-run",
        task_id: "budget-1",
        stage: "review",
        kind: "main",
        agent: Some("qa-dispatcher"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
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

/// A permissive fake daemon for a fixture socket: `Kill` is answered with
/// `SessionNotFound`, spawns with `SessionCreated`, anything else with `Ok`.
///
/// When `first_command_seen`/`release` are supplied the daemon reads the first
/// command, reports it, and then waits — holding the detached stage transition
/// open so a test can act inside the window between the HTTP response and the
/// transition landing.
fn spawn_fixture_daemon(
    socket_path: std::path::PathBuf,
    first_command_seen: Option<tokio::sync::oneshot::Sender<()>>,
    release: Option<tokio::sync::oneshot::Receiver<()>>,
) -> tokio::task::JoinHandle<()> {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let mut first_command_seen = first_command_seen;
        let mut release = release;
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            loop {
                let Some(command) =
                    read_test_daemon_command_optional(&mut reader, &mut write_half).await
                else {
                    break;
                };
                if let Some(seen) = first_command_seen.take() {
                    let _ = seen.send(());
                }
                if let Some(gate) = release.take() {
                    let _ = gate.await;
                }
                let response = match command {
                    DaemonCommand::Kill { .. } => DaemonEvent::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    },
                    DaemonCommand::SpawnAgent { session_id, .. }
                    | DaemonCommand::Spawn { session_id, .. } => {
                        DaemonEvent::SessionCreated { session_id }
                    }
                    _ => DaemonEvent::Ok,
                };
                if write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    })
}

/// Poll until the task's revision run for `stage` exists, so assertions run
/// against a transition that actually landed rather than a race.
async fn wait_for_revision_run(db: &Db, task_id: &str, stage: &str) -> crate::db::StageRun {
    for _ in 0..500 {
        if let Some(run) = db
            .list_stage_runs_for_task(task_id)
            .unwrap()
            .into_iter()
            .find(|run| run.stage == stage && run.kind == "main")
        {
            return run;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("no {stage} revision run landed for task {task_id}");
}

fn seed_bound_review_run(db: &Db, task_id: &str, run_id: &str) {
    db.insert_stage_run_with_completion_binding(
        crate::db::NewStageRun {
            id: run_id,
            task_id,
            stage: "review",
            kind: "main",
            agent: Some("review"),
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
        },
        Some("auto"),
        true,
    )
    .unwrap();
}

fn cleanup_revision_budget_fixture(fixture: &RevisionBudgetFixture) {
    let _ = std::fs::remove_file(&fixture.socket_path);
    let _ = std::fs::remove_dir_all(&fixture.daemon_dir);
    let _ = std::fs::remove_dir_all(&fixture.repo_root);
}

/// A review verdict carries two identities: the task route and the immutable
/// review run from the caller's spawn context. This drives two concurrent
/// tasks through the real router and preparation path, proving a crossed pair
/// is refused without spending a round while each legitimate pair remains
/// independent and concludes its own review.
#[tokio::test]
async fn review_run_binding_refuses_cross_task_pair_and_allows_concurrent_verdicts() {
    let fixture = setup_revision_budget_fixture_with_spent_rounds("run-binding", 5, 0);
    assert!(Command::new("git")
        .args(["branch", "task-budget-2"])
        .current_dir(&fixture.repo_root)
        .status()
        .unwrap()
        .success());
    {
        let db = Db::open(&fixture.config.db_path).unwrap();
        // Replace the fixture's original run, as the real spawn lifecycle does.
        db.cancel_running_stage_runs("budget-1").unwrap();
        seed_bound_review_run(&db, "budget-1", "review-run-1");
        db.insert_test_pipeline_item(
            "budget-2",
            "repo-1",
            "Add the other focused fix",
            Some("Add the other focused fix"),
            "review",
            "2026-07-26 10:01:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "budget-2",
            "task-budget-2",
            "budget",
            None,
            "claude",
        )
        .unwrap();
        seed_bound_review_run(&db, "budget-2", "review-run-2");
    }

    // A real task has one active main run. Pin the fixture lifecycle here:
    // a second active review makes the result depend on which run is selected.
    {
        let db = Db::open(&fixture.config.db_path).unwrap();
        for (task, expected) in [("budget-1", "review-run-1"), ("budget-2", "review-run-2")] {
            let active = db
                .list_stage_runs_for_task(task)
                .unwrap()
                .into_iter()
                .filter(|run| run.kind == "main" && run.status == "running")
                .map(|run| run.id)
                .collect::<Vec<_>>();
            assert_eq!(active, [expected]);
        }
    }

    let daemon = spawn_fixture_daemon(fixture.socket_path.clone(), None, None);
    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let request = |task_id: &'static str, run_id: Option<&'static str>, finding: &'static str| {
        Request::post(format!("/v1/tasks/{task_id}/actions/request-revision"))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "runId": run_id,
                    "targetStage": "in progress",
                    "summary": finding,
                    "prompt": format!("Fix {finding}.")
                })
                .to_string(),
            ))
            .unwrap()
    };

    let crossed = app
        .clone()
        .oneshot(request("budget-1", Some("review-run-2"), "crossed finding"))
        .await
        .unwrap();
    let crossed_status = crossed.status();
    let crossed_body = axum::body::to_bytes(crossed.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(crossed_status, StatusCode::CONFLICT);
    let crossed_message = String::from_utf8_lossy(&crossed_body);
    assert!(
        crossed_message.contains("belongs to budget-2"),
        "{crossed_message}"
    );
    assert!(
        crossed_message.contains("No revision was started"),
        "{crossed_message}"
    );
    {
        let db = Db::open(&fixture.config.db_path).unwrap();
        assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 0);
        assert_eq!(
            db.stage_run("review-run-1").unwrap().unwrap().status,
            "running"
        );
        assert_eq!(
            db.stage_run("review-run-2").unwrap().unwrap().status,
            "running"
        );
    }

    let (first, second) = tokio::join!(
        app.clone()
            .oneshot(request("budget-1", None, "first finding")),
        app.clone()
            .oneshot(request("budget-2", Some("review-run-2"), "second finding"))
    );
    for response in [first, second] {
        let response = response.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    }

    let db = Db::open(&fixture.config.db_path).unwrap();
    wait_for_revision_run(&db, "budget-1", "in progress").await;
    wait_for_revision_run(&db, "budget-2", "in progress").await;
    assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 1);
    assert_eq!(db.task_revision_rounds("budget-2").unwrap(), 1);
    let first_review = db.stage_run("review-run-1").unwrap().unwrap();
    let second_review = db.stage_run("review-run-2").unwrap().unwrap();
    assert_eq!(first_review.status, "failed");
    assert_eq!(first_review.feedback.as_deref(), Some("first finding"));
    assert_eq!(second_review.status, "failed");
    assert_eq!(second_review.feedback.as_deref(), Some("second finding"));

    daemon.abort();
    drop(db);
    cleanup_revision_budget_fixture(&fixture);
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
    use tokio::io::{AsyncWriteExt, BufReader};
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
    let task = super::actions::wait_for_running_task_stage(&db, "budget-1", "in progress").await;
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 0);

    // The announced budget is the one the revision leaves behind. Reporting
    // the pre-reset count made a human revision claim a spent budget
    // (`rounds == limit`) beside `exhausted: false`.
    let head = db.latest_task_event_seq().unwrap();
    let revision_events = db
        .list_task_events(
            &crate::db::TaskEventScope::Tasks(vec!["budget-1".to_string()]),
            0,
            head,
            100,
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "task.revision_requested")
        .map(|event| event.payload)
        .collect::<Vec<_>>();
    assert_eq!(revision_events.len(), 1, "{revision_events:?}");
    assert_eq!(revision_events[0]["origin"], "human");
    assert_eq!(revision_events[0]["rounds"], 0);
    assert_eq!(revision_events[0]["limit"], 1);
    assert_eq!(revision_events[0]["exhausted"], false);

    daemon_server.await.unwrap();
    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}

/// A reviewer that asks for a revision without findings would start an agent
/// on an empty "Reviewer feedback:" section: the revising agent has nothing to
/// act on, the budgeted round is spent proving that, and the verdict is lost.
/// The request is refused at the boundary instead — with no round spent and
/// the review run left open — so the reviewer can resend the findings.
#[tokio::test]
async fn agent_revision_request_without_feedback_is_refused_without_spending_a_round() {
    let fixture = setup_revision_budget_fixture_with_spent_rounds("empty-feedback", 5, 0);

    // No daemon is listening: a refused request must start nothing, so it
    // cannot need one.
    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/budget-1/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": "Inventory cleanup still has crash and concurrency gaps",
                        "prompt": "   \n  "
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
    let message = String::from_utf8_lossy(&body);
    assert!(
        message.contains("`prompt` must contain the findings"),
        "the reviewer must be told what to resend: {message}"
    );
    assert!(
        message.contains("no revision round was spent"),
        "the reviewer must be told retrying is free: {message}"
    );

    let db = Db::open(&fixture.config.db_path).unwrap();
    assert_eq!(
        db.task_revision_rounds("budget-1").unwrap(),
        0,
        "a refused request must not spend a round"
    );
    let task = db.get_task_stage_source("budget-1").unwrap().unwrap();
    assert_eq!(task.stage.as_deref(), Some("review"));
    let runs = db.list_stage_runs_for_task("budget-1").unwrap();
    assert_eq!(runs.len(), 1, "no revision run may be created");
    // The review run is left open so the reviewer's retry records the verdict
    // it is about to send, rather than closing it on an empty one.
    assert_eq!(runs[0].status, "running");
    assert_eq!(runs[0].result, None);

    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}

/// The compose-side backstop for every caller the boundary refusal does not
/// cover: a revision request that carries no feedback of its own still starts
/// the agent on the verdict recorded on the terminating review run, so a
/// review's findings reach the implementer instead of being dropped.
#[tokio::test]
async fn revision_prompt_falls_back_to_the_review_verdict_when_the_request_has_no_feedback() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    const VERDICT: &str = "Inventory cleanup still has unsafe bare-pid daemon killing";

    let fixture = setup_revision_budget_fixture("verdict-fallback", 1);

    let daemon_listener = UnixListener::bind(&fixture.socket_path).unwrap();
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
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert!(
                        params
                            .prompt
                            .contains(&format!("Reviewer feedback:\n{VERDICT}")),
                        "revision prompt lost the review verdict: {}",
                        params.prompt
                    );
                    session_id
                }
                DaemonCommand::Spawn {
                    session_id, args, ..
                } => {
                    let command_line = args.join(" ");
                    assert!(
                        command_line.contains(&format!("Reviewer feedback:\n{VERDICT}")),
                        "revision prompt lost the review verdict: {command_line}"
                    );
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

    // A human request is never refused for empty feedback, so it is what
    // exercises the compose-side fallback end to end.
    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let response = app
        .oneshot(
            Request::post("/v1/tasks/budget-1/actions/request-revision")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "targetStage": "in progress",
                        "summary": VERDICT,
                        "prompt": "",
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
            "revision must fall back to the recorded verdict, got {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }

    let db = Db::open(&fixture.config.db_path).unwrap();
    super::actions::wait_for_running_task_stage(&db, "budget-1", "in progress").await;
    let revision_run = wait_for_revision_run(&db, "budget-1", "in progress").await;
    assert_eq!(
        revision_run.feedback.as_deref(),
        Some(VERDICT),
        "the revision run must record the feedback the agent actually got"
    );

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
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    const DECLINED_MARKER: &str = "DECLINED: the migration finding is out of scope for this task.";
    const COMMIT_SUMMARY: &str = "committed 2 files for review";

    let unique = super::unique_test_suffix();
    let repo_root = std::env::temp_dir().join(format!("kanna-http-prev-main-{unique}"));
    init_test_git_repo(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/prevmain.json"),
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
        .args(["commit", "-m", "add prev-main workflow"])
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
                    let Some(command) =
                        read_test_daemon_command_optional(&mut reader, &mut write_half).await
                    else {
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
        activity_event_debounce_seconds: 300,
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
            effort: None,
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
                        "runId": "prevmain-impl-run",
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
    let post_run = post_run.expect("the commit post was not dispatched");

    // 2. The commit post reports its own, different result and finishes,
    //    which performs the transition into the review stage.
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/prevmain-1/actions/complete-stage")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "runId": post_run.id, "status": "success", "summary": COMMIT_SUMMARY })
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
    // $PREV_RESULT keeps its documented meaning for the workflows that want
    // the post's result.
    assert!(
        latest_field.contains(COMMIT_SUMMARY),
        "$PREV_RESULT must still carry the latest run's result: {latest_field}"
    );

    let mut transitioned_stage = None;
    for _ in 0..200 {
        let item = db.get_pipeline_item("prevmain-1").unwrap().unwrap();
        if item.stage.as_deref() == Some("review") {
            transitioned_stage = item.stage;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(transitioned_stage.as_deref(), Some("review"));

    daemon_server.abort();
    drop(db);
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_dir_all(&daemon_dir);
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// The cap is the load-bearing behavior of the revision budget, so it must not
/// be bypassable by request timing. Two agent requests arriving together at
/// the task's last free slot must not both be admitted: reading the count and
/// spending it are one atomic claim, and one revision action runs at a time
/// per task. Drives the real router, DB, and stage preparation, because a unit
/// test of `RevisionBudget::exhausted` cannot prove that wiring.
#[tokio::test]
async fn concurrent_agent_revision_requests_cannot_spend_past_the_budget() {
    // Limit 2 with one round already spent: exactly one slot remains, so two
    // concurrent requests contend for it.
    let fixture = setup_revision_budget_fixture("race", 2);
    {
        let db = Db::open(&fixture.config.db_path).unwrap();
        db.release_agent_revision_round("budget-1").unwrap();
        assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 1);
    }

    // A real (if fake) daemon, so the winning request's detached transition
    // completes and can be asserted on.
    let daemon = spawn_fixture_daemon(fixture.socket_path.clone(), None, None);

    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let request = || {
        Request::post("/v1/tasks/budget-1/actions/request-revision")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "targetStage": "in progress",
                    "summary": "QA failed: review-ui",
                    "prompt": "Fix the finding."
                })
                .to_string(),
            ))
            .unwrap()
    };
    let (first, second) = tokio::join!(
        app.clone().oneshot(request()),
        app.clone().oneshot(request())
    );

    let mut started = 0;
    let mut refused = 0;
    for response in [first.unwrap(), second.unwrap()] {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        match status {
            // Serialized behind the winner, then observed the spent budget.
            StatusCode::OK => {
                let action: TaskActionResponse = from_slice(&body).unwrap();
                let budget = action.revision_budget.expect("revision budget reported");
                if budget.exhausted {
                    refused += 1;
                } else {
                    started += 1;
                }
                assert!(
                    budget.rounds <= budget.limit,
                    "a response must never report more rounds than the limit: {budget:?}"
                );
            }
            // Rejected as a concurrent revision for the same task.
            StatusCode::CONFLICT => {
                let message = String::from_utf8_lossy(&body);
                assert!(
                    message.contains("already in progress"),
                    "conflict must say why: {message}"
                );
                refused += 1;
            }
            other => panic!(
                "unexpected status {other}: {}",
                String::from_utf8_lossy(&body)
            ),
        }
    }

    assert_eq!(
        (started, refused),
        (1, 1),
        "exactly one revision may start and the other must be refused"
    );

    let db = Db::open(&fixture.config.db_path).unwrap();
    // The invariant: the stored count never passes the configured cap.
    assert_eq!(
        db.task_revision_rounds("budget-1").unwrap(),
        2,
        "the last slot must be spent exactly once"
    );
    // The winner's transition must actually land — "no runs at all" would
    // satisfy a bare upper bound while proving nothing.
    wait_for_revision_run(&db, "budget-1", "in progress").await;
    let revision_runs = db
        .list_stage_runs_for_task("budget-1")
        .unwrap()
        .into_iter()
        .filter(|run| run.stage == "in progress" && run.kind == "main")
        .count();
    assert_eq!(
        revision_runs, 1,
        "exactly one revision run must land, found {revision_runs}"
    );

    daemon.abort();
    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}

/// A human request is never refused by the budget, but it must not race an
/// agent's claim either: the two would otherwise both start a revision on one
/// task, and the human's reset would collide with the agent's increment.
#[tokio::test]
async fn concurrent_human_and_agent_revision_requests_are_serialized() {
    let fixture = setup_revision_budget_fixture("overlap", 1);
    {
        // Budget already spent, so the agent request is the one that must not
        // start anything even if it wins the race.
        let db = Db::open(&fixture.config.db_path).unwrap();
        assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 1);
    }

    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let build = |origin: &str| {
        Request::post("/v1/tasks/budget-1/actions/request-revision")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "targetStage": "in progress",
                    "summary": "needs another pass",
                    "prompt": "Fix the finding.",
                    "origin": origin
                })
                .to_string(),
            ))
            .unwrap()
    };
    let (agent, human) = tokio::join!(
        app.clone().oneshot(build("agent")),
        app.clone().oneshot(build("human"))
    );

    let mut outcomes = Vec::new();
    for response in [agent.unwrap(), human.unwrap()] {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        if status == StatusCode::OK {
            let action: TaskActionResponse = from_slice(&body).unwrap();
            let budget = action.revision_budget.expect("revision budget reported");
            outcomes.push(if budget.exhausted {
                "parked"
            } else {
                "started"
            });
            assert!(budget.rounds <= budget.limit, "{budget:?}");
        } else {
            assert_eq!(status, StatusCode::CONFLICT);
            outcomes.push("conflict");
        }
    }

    // Whichever order they land in, at most one revision starts: the human's
    // (never refused by the budget) or none, when the human lost the flight.
    assert!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == "started")
            .count()
            <= 1,
        "at most one revision may start: {outcomes:?}"
    );
    assert!(
        outcomes.contains(&"conflict") || outcomes.contains(&"parked"),
        "the losing or over-budget request must be refused: {outcomes:?}"
    );

    let db = Db::open(&fixture.config.db_path).unwrap();
    // The agent can never push the count past the cap, and a human revision
    // that ran resets it to 0.
    let rounds = db.task_revision_rounds("budget-1").unwrap();
    assert!(
        rounds <= 1,
        "rounds must never exceed the limit, got {rounds}"
    );

    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}

/// The window that the simultaneous-request test cannot reach: after the
/// handler has answered 200 but before the detached transition has landed.
///
/// The response has to come first — the transition kills and respawns the
/// caller's own session — so for that whole window the task's stage, branch,
/// and session are still the pre-revision ones. A second request admitted
/// there would spend another budget slot and prepare a workspace from state
/// the in-flight transition is about to replace. The per-task guard therefore
/// belongs to the detached worker, not to the handler.
#[tokio::test]
async fn a_second_revision_is_refused_until_the_detached_transition_lands() {
    // Deliberate slack in the budget (limit 3, nothing spent): without the
    // guard the second request is not stopped by exhaustion, so it would
    // really claim another round and prepare another workspace from the stale
    // task state — the failure mode under test, rather than the easier case
    // where the budget happens to catch it.
    let fixture = setup_revision_budget_fixture("window", 3);
    {
        let db = Db::open(&fixture.config.db_path).unwrap();
        for _ in 0..3 {
            db.release_agent_revision_round("budget-1").unwrap();
        }
        assert_eq!(db.task_revision_rounds("budget-1").unwrap(), 0);
    }

    // The daemon holds the first transition open at its first command.
    let (first_command_tx, first_command_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let daemon = spawn_fixture_daemon(
        fixture.socket_path.clone(),
        Some(first_command_tx),
        Some(release_rx),
    );

    let app = super::router(Arc::new(super::AppState::new(fixture.config.clone())));
    let request = |run_id: Option<&str>| {
        let mut body = serde_json::json!({
            "targetStage": "in progress",
            "summary": "QA failed: review-ui",
            "prompt": "Fix the finding."
        });
        if let Some(run_id) = run_id {
            body["runId"] = serde_json::Value::String(run_id.to_string());
        }
        Request::post("/v1/tasks/budget-1/actions/request-revision")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    let first = app.clone().oneshot(request(None)).await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let body = axum::body::to_bytes(first.into_body(), usize::MAX)
        .await
        .unwrap();
    let started: TaskActionResponse = from_slice(&body).unwrap();
    let budget = started.revision_budget.expect("revision budget reported");
    assert!(!budget.exhausted);
    assert_eq!(budget.rounds, 1);

    // The response has landed; the transition is now mid-flight, blocked on
    // the daemon. This is the window under test.
    tokio::time::timeout(std::time::Duration::from_secs(10), first_command_rx)
        .await
        .expect("the detached transition never reached the daemon")
        .expect("daemon gate dropped");

    let second = app.clone().oneshot(request(None)).await.unwrap();
    let second_status = second.status();
    let second_body = axum::body::to_bytes(second.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        second_status,
        StatusCode::CONFLICT,
        "a revision arriving before the first landed must be refused: {}",
        String::from_utf8_lossy(&second_body)
    );

    {
        // Refusing must not have spent a round or prepared a second workspace,
        // even though the budget had room for one.
        let db = Db::open(&fixture.config.db_path).unwrap();
        assert_eq!(
            db.task_revision_rounds("budget-1").unwrap(),
            1,
            "a refused request must not spend a budget slot"
        );
        let workspaces = std::fs::read_dir(fixture.repo_root.join(".kanna-worktrees"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert!(
            workspaces <= 1,
            "a refused request must not fork a second workspace, found {workspaces}"
        );
    }

    let _ = release_tx.send(());

    let db = Db::open(&fixture.config.db_path).unwrap();
    let revision_run = wait_for_revision_run(&db, "budget-1", "in progress").await;
    let revision_runs = db
        .list_stage_runs_for_task("budget-1")
        .unwrap()
        .into_iter()
        .filter(|run| run.stage == "in progress" && run.kind == "main")
        .count();
    assert_eq!(
        revision_runs, 1,
        "exactly one revision run may land, found {revision_runs}"
    );
    assert_eq!(
        db.task_revision_rounds("budget-1").unwrap(),
        1,
        "exactly one round may be spent while the transition was in flight"
    );

    // Once the worker exits the task is claimable again — the guard is tied to
    // the transition, not held forever. With budget still available, the next
    // request is admitted, which is the released-guard proof.
    let mut third_status = StatusCode::CONFLICT;
    let mut third_body = Vec::new();
    for _ in 0..250 {
        let third = app
            .clone()
            .oneshot(request(Some(&revision_run.id)))
            .await
            .unwrap();
        third_status = third.status();
        third_body = axum::body::to_bytes(third.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        if third_status != StatusCode::CONFLICT {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        third_status,
        StatusCode::OK,
        "the guard must release when the transition finishes: {}",
        String::from_utf8_lossy(&third_body)
    );
    let admitted: TaskActionResponse = from_slice(&third_body).unwrap();
    let admitted_budget = admitted.revision_budget.expect("revision budget reported");
    assert!(
        !admitted_budget.exhausted,
        "budget remained, so the request after the transition must be admitted"
    );
    assert_eq!(
        admitted_budget.rounds, 2,
        "the admitted request spends the next round"
    );

    daemon.abort();
    drop(db);
    cleanup_revision_budget_fixture(&fixture);
}
