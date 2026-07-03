use super::*;

#[tokio::test]
async fn list_desktops_route_returns_configured_desktop() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let response = app
        .oneshot(Request::get("/v1/desktops").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn list_repos_route_returns_repo_summaries() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
    });

    let response = app
        .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let repos: Vec<crate::mobile_api::RepoSummary> = from_slice(&body).unwrap();
    assert_eq!(
        repos,
        vec![
            crate::mobile_api::RepoSummary {
                id: "repo-1".to_string(),
                name: "Repo One".to_string(),
            },
            crate::mobile_api::RepoSummary {
                id: "repo-2".to_string(),
                name: "Repo Two".to_string(),
            },
        ]
    );
}

#[tokio::test]
async fn add_repo_route_registers_existing_git_repo() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-{unique}"));
    init_test_git_repo(&repo_root);
    let app = super::test_router("desktop-1", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                        "name": "Registered Repo"
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
    let repo: crate::mobile_api::RepoDetail = from_slice(&body).unwrap();
    assert_eq!(repo.name, "Registered Repo");
    assert_eq!(repo.default_branch.as_deref(), Some("main"));
    assert_eq!(repo.hidden, Some(0));

    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn add_repo_route_rejects_duplicate_path() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-dupe-{unique}"));
    init_test_git_repo(&repo_root);
    let app = super::test_router("desktop-1", "Studio Mac");
    let body = Body::from(
        serde_json::json!({
            "path": repo_root,
        })
        .to_string(),
    );
    let first = app
        .clone()
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);

    let second = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::CONFLICT);
    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn list_repo_tasks_route_returns_repo_scoped_tasks() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            "task-repo-1",
            "repo-1",
            "repo one prompt",
            Some("Repo One Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-repo-2",
            "repo-2",
            "repo two prompt",
            Some("Repo Two Task"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/repos/repo-1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-repo-1");
    assert_eq!(tasks[0].repo_id, "repo-1");
    assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
}

#[tokio::test]
async fn list_recent_tasks_route_returns_open_tasks_in_updated_order() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-older",
            "repo-1",
            "older prompt",
            Some("Older Task"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-newer",
            "repo-1",
            "newer prompt",
            Some("Newer Task"),
            "pr",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "done prompt",
            Some("Done Task"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();
        db.update_test_pipeline_item_preview("task-newer", Some("Latest agent output preview"))
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/recent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].id, "task-newer");
    assert_eq!(
        tasks[0].snippet.as_deref(),
        Some("Latest agent output preview")
    );
    assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
    assert_eq!(tasks[1].id, "task-older");
}

#[tokio::test]
async fn get_task_route_returns_full_task_detail_by_id() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Review MCP task detail",
            Some("Review MCP"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

    assert_eq!(task.id, "task-1");
    assert_eq!(task.repo_id, "repo-1");
    assert_eq!(task.title, "Review MCP");
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(task.activity.as_deref(), Some("idle"));
    assert_eq!(task.agent_type.as_deref(), Some("pty"));
    assert_eq!(task.agent_provider.as_deref(), Some("claude"));
    assert_eq!(task.branch.as_deref(), Some("branch-task-1"));
    assert_eq!(task.pr_url, None);
    assert_eq!(task.closed_at, None);
    assert_eq!(task.worktree_path, None);
    assert_eq!(task.commits_ahead, 0);
    assert_eq!(task.commits_behind, 0);
    assert!(!task.dirty);
}

#[tokio::test]
async fn update_task_route_persists_display_name_and_get_list_return_new_title() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Original prompt",
            None,
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .clone()
        .oneshot(
            Request::patch("/v1/tasks/task-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "displayName": "Renamed task"
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
    let action: crate::mobile_api::TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(action.task_id, "task-1");

    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.display_name.as_deref(), Some("Renamed task"));
    drop(db);

    let get_response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(get_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();
    assert_eq!(task.title, "Renamed task");

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
    assert_eq!(tasks[0].title, "Renamed task");
}

#[tokio::test]
async fn update_task_route_returns_not_found_for_unknown_task() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = app
        .oneshot(
            Request::patch("/v1/tasks/missing-task")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "displayName": "Still missing"
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
async fn get_task_route_returns_worktree_git_state() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-detail-repo-{unique}"));
    let worktree = std::env::temp_dir().join(format!("kanna-http-detail-worktree-{unique}"));
    init_test_git_repo(&repo_root);
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            "task-detail",
            worktree.to_str().unwrap()
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    std::fs::write(worktree.join("feature.txt"), "feature").unwrap();
    assert!(Command::new("git")
        .args(["add", "feature.txt"])
        .current_dir(&worktree)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "feature"])
        .current_dir(&worktree)
        .status()
        .unwrap()
        .success());
    std::fs::write(worktree.join("dirty.txt"), "dirty").unwrap();

    let worktree_string = worktree.to_string_lossy().to_string();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Review MCP task detail",
            Some("Review MCP"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-detail",
            "default",
            None,
            "claude",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("task-1", "main")
            .unwrap();
        db.upsert_worktree("wt-task-1", "task-1", &worktree_string, "task-detail")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

    assert_eq!(
        task.worktree_path.as_deref(),
        Some(worktree_string.as_str())
    );
    assert_eq!(task.pipeline_name.as_deref(), Some("default"));
    assert_eq!(task.stage_transition.as_deref(), Some("manual"));
    assert_eq!(task.commits_ahead, 1);
    assert_eq!(task.commits_behind, 0);
    assert!(task.dirty);

    let _ = Command::new("git")
        .args(["worktree", "remove", "--force", worktree.to_str().unwrap()])
        .current_dir(&repo_root)
        .status();
    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_dir_all(worktree);
}

#[tokio::test]
async fn get_task_route_accepts_branch_name_alias() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Review MCP task detail",
            Some("Review MCP"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/branch-task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

    assert_eq!(task.id, "task-1");
    assert_eq!(task.branch.as_deref(), Some("branch-task-1"));
}

#[tokio::test]
async fn get_task_route_returns_not_found_for_unknown_task() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/missing-task")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn task_logs_route_renders_agent_journal_tail() {
    let task_id = format!(
        "task-agent-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let journal_dir = PathBuf::from("/tmp/kanna-daemon").join("agent-journals");
    std::fs::create_dir_all(&journal_dir).unwrap();
    let journal_path = journal_dir.join(format!("{task_id}.ndjson"));
    let lines = [
        serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
            seq: 0,
            event: AgentEvent::AssistantText {
                text: "first assistant".to_string(),
                truncated: false,
            },
        })
        .unwrap(),
        serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
            seq: 1,
            event: AgentEvent::ToolResult {
                call_id: "call-1".to_string(),
                output: "tool output".to_string(),
                truncated: false,
                is_error: false,
            },
        })
        .unwrap(),
        serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
            seq: 2,
            event: AgentEvent::AssistantText {
                text: "second assistant".to_string(),
                truncated: false,
            },
        })
        .unwrap(),
    ]
    .join("\n");
    std::fs::write(&journal_path, lines).unwrap();

    let seeded_task_id = task_id.clone();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", move |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            &seeded_task_id,
            "repo-1",
            "Read logs",
            Some("Read logs"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_agent_type(&seeded_task_id, "agent")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get(format!("/v1/tasks/{task_id}/logs?tail=2"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&body),
        "tool result: tool output\nsecond assistant"
    );

    let _ = std::fs::remove_file(journal_path);
}

#[tokio::test]
async fn http_invoke_dispatches_shared_mobile_get_routes() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-newer",
            "repo-1",
            "newer prompt",
            Some("Newer Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
    });

    let repos = super::dispatch_http_invoke(
        Arc::clone(&state),
        "GET",
        "/v1/repos",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(repos.status, 200);
    assert_eq!(
        repos.body,
        Some(serde_json::json!([
            {
                "id": "repo-1",
                "name": "Repo One"
            }
        ]))
    );
    assert_eq!(repos.error, None);

    let recent = super::dispatch_http_invoke(
        Arc::clone(&state),
        "GET",
        "/v1/tasks/recent",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(recent.status, 200);
    assert_eq!(recent.body.as_ref().unwrap()[0]["id"], "task-newer");
    assert_eq!(recent.body.as_ref().unwrap()[0]["activity"], "idle");
    assert_eq!(recent.error, None);
}

#[tokio::test]
async fn search_tasks_route_filters_by_query_text() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-merge",
            "repo-1",
            "follow up on merge conflicts",
            Some("Merge Cleanup"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-other",
            "repo-1",
            "write release notes",
            Some("Docs"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "merge old branch",
            Some("Done Merge"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/search?query=merge")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-merge");
    assert_eq!(tasks[0].title, "Merge Cleanup");
    assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
}

#[tokio::test]
async fn create_pairing_session_route_returns_pairing_payload() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let response = app
        .oneshot(
            Request::post("/v1/pairing/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let pairing: crate::pairing::PairingSession = from_slice(&body).unwrap();
    assert_eq!(pairing.desktop_id, "desktop-1");
    assert_eq!(pairing.desktop_name, "Studio Mac");
    assert_eq!(pairing.lan_port, 48120);
    assert_eq!(pairing.code.len(), 6);
}

#[tokio::test]
async fn create_pairing_session_route_uses_local_identity_without_desktop_secret() {
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-local-pairing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&daemon_dir);

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: crate::db::Db::test_db_path("http-local-pairing"),
        kanna_cli_path: None,
        desktop_id: "desktop-local".to_string(),
        desktop_secret: None,
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: PathBuf::from("/tmp/kanna-pairings-http-local.json")
            .to_string_lossy()
            .to_string(),
    };
    let _ = crate::db::Db::open_for_tests(&config.db_path).unwrap();
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::post("/v1/pairing/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let pairing: crate::pairing::PairingSession = from_slice(&body).unwrap();
    assert_eq!(pairing.desktop_id, "desktop-local");
    assert_eq!(pairing.desktop_name, "Studio Mac");
    assert_eq!(pairing.code.len(), 6);

    let _ = std::fs::remove_dir_all(daemon_dir);
}
