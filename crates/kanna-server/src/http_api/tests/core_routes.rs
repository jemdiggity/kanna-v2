use super::*;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
async fn repo_agent_provider_route_uses_workspace_local_executables() {
    use std::os::unix::fs::PermissionsExt;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-provider-availability-{unique}"));
    init_test_git_repo(&repo_root);
    let provider_dir = repo_root.join(".kanna/provider-bin");
    std::fs::create_dir_all(&provider_dir).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": { "path": { "prepend": [".kanna/provider-bin"] } }
        })
        .to_string(),
    )
    .unwrap();
    let local_antigravity = provider_dir.join("agy");
    std::fs::write(&local_antigravity, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = std::fs::metadata(&local_antigravity).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&local_antigravity, permissions).unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/config.json", ".kanna/provider-bin/agy"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "configure workspace-local provider"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_test_origin_main(&repo_root);

    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
    });
    let response = app
        .oneshot(
            Request::get("/v1/repos/repo-1/agent-providers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert!(json["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| {
            provider["id"] == "antigravity"
                && provider["executable"] == local_antigravity.to_string_lossy().as_ref()
        }));

    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn snapshot_route_returns_ui_hydration_payload() {
    let visible_worktree = std::env::temp_dir().join(format!(
        "kanna-snapshot-visible-worktree-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&visible_worktree);
    std::fs::create_dir_all(&visible_worktree).unwrap();
    let visible_worktree = visible_worktree.to_string_lossy().to_string();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            "task-visible",
            "repo-1",
            "visible prompt",
            Some("Visible Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-blocker",
            "repo-1",
            "blocker prompt",
            Some("Blocker Task"),
            "review",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-closed",
            "repo-1",
            "closed prompt",
            Some("Closed Task"),
            "done",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-closed").unwrap();
        db.insert_task_blocker("task-visible", "task-blocker")
            .unwrap();
        db.upsert_worktree(
            "wt-task-visible",
            "task-visible",
            &visible_worktree,
            "branch-task-visible",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-post",
            task_id: "task-visible",
            stage: "in progress",
            kind: "post",
            agent: Some("commit"),
            agent_provider: Some("claude"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-visible"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        db.set_test_setting("ideCommand", "zed").unwrap();
    });

    let response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["entries"][0]["repo"]["id"], "repo-1");
    assert_eq!(snapshot["entries"][0]["items"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["entries"][0]["items"][0]["id"], "task-visible");
    assert_eq!(snapshot["entries"][0]["items"][0]["has_running_post"], 1);
    assert_eq!(snapshot["entries"][0]["items"][1]["id"], "task-blocker");
    assert_eq!(
        snapshot["taskBlockers"],
        serde_json::json!([{ "blocked_item_id": "task-visible", "blocker_item_id": "task-blocker" }])
    );
    assert_eq!(
        snapshot["worktreePaths"],
        serde_json::json!({ "task-visible": visible_worktree.clone() })
    );
    assert_eq!(snapshot["settings"]["ideCommand"], "zed");

    let _ = std::fs::remove_dir_all(visible_worktree);
}

#[tokio::test]
async fn backup_route_creates_valid_snapshot_while_writes_continue() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });
    let db_path = state.config.db_path.clone();
    let seed_conn = Connection::open(&db_path).unwrap();
    seed_conn
        .execute_batch(
            r#"
                CREATE TABLE backup_probe (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  note TEXT NOT NULL
                );
                INSERT INTO backup_probe (note) VALUES ('seed');
            "#,
        )
        .unwrap();
    drop(seed_conn);
    let app = super::router(state);
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = Arc::clone(&stop);
    let writer_db_path = db_path.clone();
    let writer = std::thread::spawn(move || {
        let conn = Connection::open(writer_db_path).unwrap();
        conn.busy_timeout(std::time::Duration::from_millis(10_000))
            .unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        let mut i = 0;
        while !writer_stop.load(Ordering::Relaxed) {
            let _ = conn.execute(
                "INSERT INTO backup_probe (note) VALUES (?1)",
                [format!("live-{i}")],
            );
            i += 1;
        }
    });

    let response = app
        .oneshot(
            Request::post("/v1/backup")
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();
    let backup_path = payload["backupPath"].as_str().expect("backup path");

    let backup = Connection::open(backup_path).expect("open backup");
    let quick_check: String = backup
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .expect("quick check backup");
    assert_eq!(quick_check, "ok");
    let seed_count: i64 = backup
        .query_row(
            "SELECT COUNT(*) FROM backup_probe WHERE note = 'seed'",
            [],
            |row| row.get(0),
        )
        .expect("seed row copied");
    assert_eq!(seed_count, 1);

    let _ = std::fs::remove_file(backup_path);
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn snapshot_route_records_initialized_tasks_whose_worktree_is_missing() {
    let missing_worktree =
        std::env::temp_dir().join(format!("kanna-missing-worktree-{}", std::process::id()));
    let missing_worktree = missing_worktree.to_string_lossy().to_string();
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-orphan",
            "repo-1",
            "Orphaned task",
            Some("Orphaned Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.upsert_worktree(
            "wt-task-orphan",
            "task-orphan",
            &missing_worktree,
            "branch-task-orphan",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(snapshot["entries"][0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["entries"][0]["items"][0]["id"], "task-orphan");
    assert_eq!(snapshot["entries"][0]["items"][0]["activity"], "unread");
    assert_eq!(snapshot["worktreePaths"], serde_json::json!({}));

    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-orphan").unwrap().unwrap();
    assert!(item.closed_at.is_none());
    assert_eq!(item.activity.as_deref(), Some("unread"));
    let runs = db.list_stage_runs_for_task("task-orphan").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    assert!(runs[0]
        .result
        .as_deref()
        .unwrap_or_default()
        .contains("task workspace missing"));
}

#[tokio::test]
async fn recent_tasks_route_keeps_dormant_tasks_without_worktree_rows() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-dormant",
            "repo-1",
            "Wait for blocker",
            Some("Dormant Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
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
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-dormant");
}

#[tokio::test]
async fn dependent_tasks_exist_route_detects_blockers_and_base_refs_for_task() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "blocker-1",
            "repo-1",
            "blocker prompt",
            Some("Blocker Task"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_branch("blocker-1", "feature/parent")
            .unwrap();
        db.update_test_pipeline_item_pr_url("blocker-1", "https://github.com/acme/repo/pull/7")
            .unwrap();
        db.insert_test_pipeline_item(
            "dependent-blocked",
            "repo-1",
            "dependent prompt",
            Some("Dependent Blocked"),
            "blocked",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "dependent-started",
            "repo-1",
            "started prompt",
            Some("Dependent Started"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("dependent-started", "origin/feature/parent")
            .unwrap();
        db.insert_task_blocker("dependent-blocked", "blocker-1")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/blocker-1/dependent-tasks-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(payload["exists"], true);
    assert_eq!(
        payload["dependentTasks"],
        serde_json::json!([
            {
                "taskId": "dependent-blocked",
                "title": "Dependent Blocked",
                "branch": "branch-dependent-blocked",
                "baseRef": null,
                "reason": "task_blocker"
            },
            {
                "taskId": "dependent-started",
                "title": "Dependent Started",
                "branch": "branch-dependent-started",
                "baseRef": "origin/feature/parent",
                "reason": "base_ref"
            }
        ])
    );
}

#[tokio::test]
async fn dependent_tasks_exist_route_returns_false_for_task_without_dependents() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "standalone prompt",
            Some("Standalone"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_branch("task-1", "feature/standalone")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1/dependent-tasks-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(payload["exists"], false);
    assert_eq!(payload["dependentTasks"], serde_json::json!([]));
}

#[tokio::test]
async fn settings_routes_get_and_put_setting_values() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.set_test_setting("ideCommand", "code").unwrap();
    });

    let initial = app
        .clone()
        .oneshot(
            Request::get("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(initial.status(), StatusCode::OK);
    let initial_body = axum::body::to_bytes(initial.into_body(), usize::MAX)
        .await
        .unwrap();
    let initial_json: serde_json::Value = from_slice(&initial_body).unwrap();
    assert_eq!(
        initial_json,
        serde_json::json!({ "key": "ideCommand", "value": "code" })
    );

    let updated = app
        .clone()
        .oneshot(
            Request::put("/v1/settings/ideCommand")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "value": "zed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated_body = axum::body::to_bytes(updated.into_body(), usize::MAX)
        .await
        .unwrap();
    let updated_json: serde_json::Value = from_slice(&updated_body).unwrap();
    assert_eq!(
        updated_json,
        serde_json::json!({ "key": "ideCommand", "value": "zed" })
    );

    let final_response = app
        .clone()
        .oneshot(
            Request::get("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let final_body = axum::body::to_bytes(final_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let final_json: serde_json::Value = from_slice(&final_body).unwrap();
    assert_eq!(final_json["value"], "zed");

    let deleted = app
        .clone()
        .oneshot(
            Request::delete("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);

    let missing = app
        .oneshot(
            Request::get("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn window_workspace_mutations_do_not_resurrect_a_concurrently_removed_window() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.set_test_setting(
            "window_workspace_v1",
            &serde_json::json!({
                "windows": [
                    {
                        "windowId": "main",
                        "selectedRepoId": null,
                        "selectedItemId": null,
                        "sidebarHidden": false,
                        "sidebarWidth": 260,
                        "order": 0
                    },
                    {
                        "windowId": "window-2",
                        "selectedRepoId": "repo-old",
                        "selectedItemId": null,
                        "sidebarHidden": false,
                        "sidebarWidth": 260,
                        "order": 1
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
    });

    let update_selection = app.clone().oneshot(
        Request::post("/v1/window-workspace/mutations")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation": "updateSelection",
                    "windowId": "window-2",
                    "selectedRepoId": "repo-new",
                    "selectedItemId": "task-new"
                })
                .to_string(),
            ))
            .unwrap(),
    );
    let remove_main = app.clone().oneshot(
        Request::post("/v1/window-workspace/mutations")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation": "remove",
                    "windowId": "main",
                    "observedWindowIds": ["main", "window-2"],
                    "liveWindowIds": ["main", "window-2"]
                })
                .to_string(),
            ))
            .unwrap(),
    );

    let (updated, removed) = tokio::join!(update_selection, remove_main);
    assert_eq!(updated.unwrap().status(), StatusCode::OK);
    assert_eq!(removed.unwrap().status(), StatusCode::OK);

    let final_response = app
        .oneshot(
            Request::get("/v1/settings/window_workspace_v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let final_body = axum::body::to_bytes(final_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let final_json: serde_json::Value = from_slice(&final_body).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(final_json["value"].as_str().unwrap()).unwrap();

    assert_eq!(snapshot["windows"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["windows"][0]["windowId"], "window-2");
    assert_eq!(snapshot["windows"][0]["selectedRepoId"], "repo-new");
    assert_eq!(snapshot["windows"][0]["selectedItemId"], "task-new");
    assert_eq!(snapshot["windows"][0]["order"], 0);
}

#[tokio::test]
async fn operator_events_route_inserts_batched_events() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::post("/v1/operator-events")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "events": [
                            {
                                "eventType": "task_selected",
                                "pipelineItemId": "task-1",
                                "repoId": "repo-1"
                            },
                            {
                                "eventType": "app_blur",
                                "pipelineItemId": null,
                                "repoId": null
                            }
                        ]
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
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(json, serde_json::json!({ "inserted": 2 }));
}

#[tokio::test]
async fn analytics_route_returns_repo_metrics() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt one",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-2",
            "repo-1",
            "prompt two",
            Some("Task Two"),
            "in progress",
            "2026-04-18 08:00:00",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-1", "2026-04-19 08:00:00")
            .unwrap();
        db.insert_test_activity_log("task-1", "working", 30)
            .unwrap();
        db.insert_test_activity_log("task-1", "idle", 60).unwrap();
        db.insert_test_operator_event(
            "task_selected",
            Some("task-1"),
            Some("repo-1"),
            "2026-04-17 08:05:00",
        )
        .unwrap();
        db.insert_test_operator_event(
            "task_selected",
            Some("task-2"),
            Some("repo-1"),
            "2026-04-17 08:07:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/analytics/repos/repo-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(json["hasData"], true);
    assert_eq!(json["taskBuckets"].as_array().unwrap().len(), 1);
    assert_eq!(json["taskBuckets"][0]["created"], 2);
    assert_eq!(json["taskBuckets"][0]["closed"], 1);
    assert_eq!(json["avgTimeInState"]["working"], 30.0);
    assert_eq!(json["avgTimeInState"]["idle"], 60.0);
    assert_eq!(json["hasOperatorData"], true);
    assert!(json["operatorMetrics"]["switchesPerHour"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn patch_repo_route_updates_remote_metadata_and_hidden_state() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::patch("/v1/repos/repo-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "remoteUrl": "git@github.com:kanna/repo-one.git",
                        "remoteUrlHash": "hash-1",
                        "hidden": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let snapshot_response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn task_agent_session_route_persists_provider_session_id() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/agent-session")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "agentSessionId": "claude-session-1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let snapshot_response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(
        snapshot["entries"][0]["items"][0]["agent_session_id"],
        serde_json::json!("claude-session-1")
    );
}

#[tokio::test]
async fn task_activity_routes_persist_runtime_status_and_mark_read() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let busy_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/runtime-status")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "status": "busy", "selected": false }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(busy_response.status(), StatusCode::OK);

    let exited_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/runtime-status")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "status": "idle", "selected": false }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exited_response.status(), StatusCode::OK);

    let unread_snapshot = app
        .clone()
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let unread_body = axum::body::to_bytes(unread_snapshot.into_body(), usize::MAX)
        .await
        .unwrap();
    let unread_json: serde_json::Value = from_slice(&unread_body).unwrap();
    assert_eq!(
        unread_json["entries"][0]["items"][0]["activity"],
        serde_json::json!("unread")
    );

    let mark_read_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/mark-read")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mark_read_response.status(), StatusCode::OK);

    let read_snapshot = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let read_body = axum::body::to_bytes(read_snapshot.into_body(), usize::MAX)
        .await
        .unwrap();
    let read_json: serde_json::Value = from_slice(&read_body).unwrap();
    assert_eq!(
        read_json["entries"][0]["items"][0]["activity"],
        serde_json::json!("idle")
    );
}

#[tokio::test]
async fn task_port_routes_claim_reuse_and_release_allocations() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-2",
            "repo-1",
            "prompt",
            Some("Task Two"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let body = serde_json::json!({
        "ports": { "KANNA_DEV_PORT": 1420 },
        "reservedPorts": [1421],
        "reservedPortOffsets": [2]
    })
    .to_string();
    let first = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/ports")
                .header("content-type", "application/json")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = axum::body::to_bytes(first.into_body(), usize::MAX)
        .await
        .unwrap();
    let first_json: serde_json::Value = from_slice(&first_body).unwrap();
    assert_eq!(first_json["portEnv"]["KANNA_DEV_PORT"], "1423");
    assert_eq!(first_json["firstPort"], 1423);

    let reused = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/ports")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let reused_body = axum::body::to_bytes(reused.into_body(), usize::MAX)
        .await
        .unwrap();
    let reused_json: serde_json::Value = from_slice(&reused_body).unwrap();
    assert_eq!(reused_json["portEnv"]["KANNA_DEV_PORT"], "1423");

    let released = app
        .clone()
        .oneshot(
            Request::delete("/v1/tasks/task-1/ports")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(released.status(), StatusCode::OK);

    let claimed_after_release = app
        .oneshot(
            Request::post("/v1/tasks/task-2/ports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "ports": { "KANNA_DEV_PORT": 1420 } }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let claimed_body = axum::body::to_bytes(claimed_after_release.into_body(), usize::MAX)
        .await
        .unwrap();
    let claimed_json: serde_json::Value = from_slice(&claimed_body).unwrap();
    assert_eq!(claimed_json["portEnv"]["KANNA_DEV_PORT"], "1421");
}

#[tokio::test]
async fn transfer_routes_list_claim_and_fail_pending_incoming_transfers() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_task_transfer(
            "transfer-1",
            "incoming",
            "pending",
            Some(r#"{"task":{},"repo":{}}"#),
        )
        .unwrap();
    });

    let list_response = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/incoming/pending")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let list_json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(list_json["transfers"].as_array().unwrap().len(), 1);
    assert_eq!(list_json["transfers"][0]["id"], "transfer-1");
    assert_eq!(list_json["transfers"][0]["sourcePeerId"], "peer-1");
    assert_eq!(list_json["transfers"][0]["sourceTaskId"], "source-task-1");
    assert_eq!(
        list_json["transfers"][0]["payloadJson"],
        r#"{"task":{},"repo":{}}"#
    );
    assert!(list_json["transfers"][0]["source_peer_id"].is_null());
    assert!(list_json["transfers"][0]["source_task_id"].is_null());
    assert!(list_json["transfers"][0]["payload_json"].is_null());

    let claim_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/claim")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(claim_response.status(), StatusCode::OK);
    let claim_body = axum::body::to_bytes(claim_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let claim_json: serde_json::Value = from_slice(&claim_body).unwrap();
    assert_eq!(claim_json["updated"], true);

    let fail_response = app
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/fail")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "reason": "failed import" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fail_response.status(), StatusCode::OK);
    let fail_body = axum::body::to_bytes(fail_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let fail_json: serde_json::Value = from_slice(&fail_body).unwrap();
    assert_eq!(fail_json["updated"], true);
}

#[tokio::test]
async fn closed_task_identities_route_returns_closed_tasks() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-open",
            "repo-1",
            "open",
            Some("Open"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-older-closed",
            "repo-1",
            "older closed",
            Some("Older Closed"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-older-closed", "2026-04-17 08:00:00")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-closed",
            "repo-1",
            "closed",
            Some("Closed"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-closed", "2026-04-18 08:00:00")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/closed-identities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "tasks": [
                { "id": "task-closed", "repo_id": "repo-1" },
                { "id": "task-older-closed", "repo_id": "repo-1" }
            ]
        })
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
async fn update_task_route_clears_display_name_with_null() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Original prompt",
            Some("Custom title"),
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
                        "displayName": null
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
    assert_eq!(item.display_name, None);
    drop(db);

    let get_response = app
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
    assert_eq!(task.title, "Original prompt");
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
