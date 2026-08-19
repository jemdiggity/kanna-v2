use super::*;
use crate::db::{NewPipelineItem, NewRepo};
use serde_json::{from_slice, Value};

fn seed_repo(db: &Db, id: &str) {
    db.insert_repo(NewRepo {
        id,
        path: &format!("/tmp/{id}"),
        name: id,
        default_branch: Some("main"),
    })
    .expect("insert repo");
}

fn seed_task(db: &Db, id: &str, repo_id: &str, workflow_name: &str, parent_task_id: Option<&str>) {
    db.insert_pipeline_item(NewPipelineItem {
        id,
        repo_id,
        prompt: "recent workflows task",
        display_name: None,
        pipeline: workflow_name,
        pipeline_def: None,
        stage: "in progress",
        branch: &format!("task-{id}"),
        agent_type: "pty",
        agent_provider: "claude",
        activity: "idle",
        port_offset: None,
        port_env_json: None,
        agent_spawn_options_json: None,
        base_ref: None,
        notify_task_id: None,
        parent_task_id,
    })
    .expect("insert workflow item");
}

fn run_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A repo whose definitions resolve: local commits only, so the manifest
/// offers exactly the compiled built-in workflows. `files` are published to
/// `origin/main` when non-empty, making repo-authored definitions visible.
fn definitions_repo(label: &str, files: &[(&str, String)]) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::Builder::new()
        .prefix(&format!("kanna-recent-workflows-{label}-"))
        .tempdir()
        .unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "--initial-branch", "main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Kanna Test"]);
    for (path, contents) in files {
        let full = repo.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, contents).unwrap();
    }
    std::fs::write(repo.join("README.md"), "recent workflows fixture\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "publish definitions"]);
    if !files.is_empty() {
        let origin = temp.path().join("origin.git");
        run_git(temp.path(), &["init", "--bare", origin.to_str().unwrap()]);
        run_git(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        run_git(&repo, &["push", "-u", "origin", "main"]);
    }
    (temp, repo)
}

fn seed_repo_at_path(db: &Db, id: &str, path: &str) {
    db.insert_repo(NewRepo {
        id,
        path,
        name: id,
        default_branch: Some("main"),
    })
    .expect("insert repo");
}

async fn recent_workflows(app: &axum::Router, repo_id: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/v1/repos/{repo_id}/recent-workflows"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = from_slice(&body).unwrap_or_else(|error| {
        panic!(
            "expected JSON for /v1/repos/{repo_id}/recent-workflows ({status}), got {:?}: {error}",
            String::from_utf8_lossy(&body)
        )
    });
    (status, value)
}

#[tokio::test]
async fn recent_workflows_route_reports_the_repo_history_newest_first() {
    let app = test_router_with_seed("recent-workflows", "Studio Mac", |db| {
        seed_repo(db, "repo-1");
        seed_repo(db, "repo-2");
        seed_task(db, "task-1", "repo-1", "default", None);
        seed_task(db, "task-2", "repo-1", "single-reviewer", None);
        seed_task(db, "task-3", "repo-1", "default", None);
        // A dispatched specialty review is not a workflow the operator chose.
        seed_task(db, "task-4", "repo-1", "specialty-review", Some("task-2"));
        seed_task(db, "task-5", "repo-2", "specialized-reviewers", None);
    });

    let (status, body) = recent_workflows(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({
            "workflows": ["default", "single-reviewer"],
            "pipelines": ["default", "single-reviewer"]
        }),
    );

    let (status, body) = recent_workflows(&app, "repo-2").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({
            "workflows": ["specialized-reviewers"],
            "pipelines": ["specialized-reviewers"]
        }),
    );

    let (status, body) = recent_workflows(&app, "repo-unknown").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "workflows": [], "pipelines": [] })
    );
}

/// The response-loss path: a create commits its task row, the caller never sees
/// the response, the task is later closed (possibly from another window), and
/// the app restarts. The remembered workflow has to survive all three, which is
/// why this reads durable rows instead of the closed-task-free snapshot.
#[tokio::test]
async fn recent_workflows_route_survives_a_closed_task_and_a_restart() {
    let state = test_state_with_seed("recent-workflows-restart", "Studio Mac", |db| {
        seed_repo(db, "repo-1");
        seed_task(db, "task-1", "repo-1", "single-reviewer", None);
    });
    let db_path = state.config().db_path.clone();
    let app = router(Arc::clone(&state));

    let (status, body) = recent_workflows(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({
            "workflows": ["single-reviewer"],
            "pipelines": ["single-reviewer"]
        }),
    );

    // Closed by another writer while this server is still up.
    let closer = Db::open(&db_path).expect("open db as another writer");
    closer.close_pipeline_item("task-1").expect("close task");
    drop(closer);

    let (status, body) = recent_workflows(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({
            "workflows": ["single-reviewer"],
            "pipelines": ["single-reviewer"]
        }),
    );

    // Restart: a fresh server over the same database file.
    let mut restarted_config = state.config().clone();
    restarted_config.desktop_id = "recent-workflows-restarted".to_string();
    drop(app);
    drop(state);
    let restarted = router(Arc::new(AppState::new(restarted_config)));

    let (status, body) = recent_workflows(&restarted, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({
            "workflows": ["single-reviewer"],
            "pipelines": ["single-reviewer"]
        }),
    );
}

/// The sticky new-task default keeps the first recent name the repo still
/// offers, so a durable row naming a retired built-in (`default`, `qa`) must
/// be served as its current name — otherwise the rename silently drops the
/// operator's last choice and the picker falls back to the configured
/// default. Canonicalizing can collapse a retired name into a newer row's
/// current name; the collapsed name keeps its newest position.
#[tokio::test]
async fn recent_workflows_route_serves_retired_builtin_names_as_their_current_name() {
    let (_temp, repo) = definitions_repo("canonical", &[]);
    let repo_path = repo.to_string_lossy().to_string();
    let app = test_router_with_seed("recent-workflows-canonical", "Studio Mac", move |db| {
        seed_repo_at_path(db, "repo-1", &repo_path);
        seed_task(db, "task-1", "repo-1", "single-reviewer", None);
        seed_task(db, "task-2", "repo-1", "no-review", None);
        // Newest: a task created before the `default` -> `no-review` rename.
        seed_task(db, "task-3", "repo-1", "default", None);
    });

    let (status, body) = recent_workflows(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({
            "workflows": ["no-review", "single-reviewer"],
            "pipelines": ["no-review", "single-reviewer"]
        }),
    );
}

/// A repo shipping its own workflow under a retired built-in name makes that
/// name a real choice: the stored name must be served verbatim, not
/// canonicalized away to the built-in it once aliased.
#[tokio::test]
async fn recent_workflows_route_keeps_a_repo_authored_workflow_named_like_a_retired_builtin() {
    let (_temp, repo) = definitions_repo(
        "authored",
        &[(
            ".kanna/workflows/default.json",
            serde_json::json!({
                "name": "default",
                "stages": [{"name": "in progress", "policy": {"transition": "manual"}}]
            })
            .to_string(),
        )],
    );
    let repo_path = repo.to_string_lossy().to_string();
    let app = test_router_with_seed("recent-workflows-authored", "Studio Mac", move |db| {
        seed_repo_at_path(db, "repo-1", &repo_path);
        seed_task(db, "task-1", "repo-1", "default", None);
    });

    let (status, body) = recent_workflows(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "workflows": ["default"], "pipelines": ["default"] })
    );
}
