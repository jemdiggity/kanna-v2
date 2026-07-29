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

fn seed_task(db: &Db, id: &str, repo_id: &str, pipeline: &str, parent_task_id: Option<&str>) {
    db.insert_pipeline_item(NewPipelineItem {
        id,
        repo_id,
        prompt: "recent pipelines task",
        display_name: None,
        pipeline,
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
    .expect("insert pipeline item");
}

async fn recent_pipelines(app: &axum::Router, repo_id: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/v1/repos/{repo_id}/recent-pipelines"))
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
            "expected JSON for /v1/repos/{repo_id}/recent-pipelines ({status}), got {:?}: {error}",
            String::from_utf8_lossy(&body)
        )
    });
    (status, value)
}

#[tokio::test]
async fn recent_pipelines_route_reports_the_repo_history_newest_first() {
    let app = test_router_with_seed("recent-pipelines", "Studio Mac", |db| {
        seed_repo(db, "repo-1");
        seed_repo(db, "repo-2");
        seed_task(db, "task-1", "repo-1", "default", None);
        seed_task(db, "task-2", "repo-1", "single-reviewer", None);
        seed_task(db, "task-3", "repo-1", "default", None);
        // A dispatched specialty review is not a pipeline the operator chose.
        seed_task(db, "task-4", "repo-1", "specialty-review", Some("task-2"));
        seed_task(db, "task-5", "repo-2", "specialized-reviewers", None);
    });

    let (status, body) = recent_pipelines(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "pipelines": ["default", "single-reviewer"] }),
    );

    let (status, body) = recent_pipelines(&app, "repo-2").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "pipelines": ["specialized-reviewers"] }),
    );

    let (status, body) = recent_pipelines(&app, "repo-unknown").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::json!({ "pipelines": [] }));
}

/// The response-loss path: a create commits its task row, the caller never sees
/// the response, the task is later closed (possibly from another window), and
/// the app restarts. The remembered pipeline has to survive all three, which is
/// why this reads durable rows instead of the closed-task-free snapshot.
#[tokio::test]
async fn recent_pipelines_route_survives_a_closed_task_and_a_restart() {
    let state = test_state_with_seed("recent-pipelines-restart", "Studio Mac", |db| {
        seed_repo(db, "repo-1");
        seed_task(db, "task-1", "repo-1", "single-reviewer", None);
    });
    let db_path = state.config().db_path.clone();
    let app = router(Arc::clone(&state));

    let (status, body) = recent_pipelines(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "pipelines": ["single-reviewer"] }),
    );

    // Closed by another writer while this server is still up.
    let closer = Db::open(&db_path).expect("open db as another writer");
    closer.close_pipeline_item("task-1").expect("close task");
    drop(closer);

    let (status, body) = recent_pipelines(&app, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "pipelines": ["single-reviewer"] }),
    );

    // Restart: a fresh server over the same database file.
    let mut restarted_config = state.config().clone();
    restarted_config.desktop_id = "recent-pipelines-restarted".to_string();
    drop(app);
    drop(state);
    let restarted = router(Arc::new(AppState::new(restarted_config)));

    let (status, body) = recent_pipelines(&restarted, "repo-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({ "pipelines": ["single-reviewer"] }),
    );
}
