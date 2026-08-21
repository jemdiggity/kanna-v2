use super::*;
use crate::db::NewRepo;
use serde_json::Value;
use std::sync::{Arc, Mutex};

fn repo_command_router() -> (tempfile::TempDir, axum::Router) {
    let temp = tempfile::tempdir().expect("temporary repo");
    let repo_path = temp.path().to_string_lossy().into_owned();
    let app = test_router_with_seed("repo-commands", "Studio Mac", move |db| {
        db.insert_repo(NewRepo {
            id: "repo-1",
            path: &repo_path,
            name: "Kanna",
            default_branch: Some("main"),
        })
        .expect("insert repo");
    });
    (temp, app)
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    serde_json::from_slice(&bytes).expect("JSON response")
}

#[tokio::test]
async fn lists_repo_commands_with_revision_and_groups() {
    let (_temp, app) = repo_command_router();
    let response = app
        .oneshot(
            Request::get("/v1/repos/repo-1/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["repoId"], "repo-1");
    assert!(body["revision"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(body["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .any(|command| command["group"] == "configure"));
    assert!(body["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .any(|command| {
            command["id"] == "custom:task-manager"
                && command["label"] == "Task Manager"
                && command["group"] == "automation"
        }));
}

#[tokio::test]
async fn rejects_a_stale_revision_before_running_a_command() {
    let (_temp, app) = repo_command_router();
    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/commands/factory:create-agent/run")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"catalogRevision":"stale"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn unknown_repositories_and_commands_return_not_found() {
    let (_temp, app) = repo_command_router();
    let missing_repo = app
        .clone()
        .oneshot(
            Request::get("/v1/repos/missing/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_repo.status(), StatusCode::NOT_FOUND);

    let catalog = app
        .clone()
        .oneshot(
            Request::get("/v1/repos/repo-1/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let revision = response_json(catalog).await["revision"]
        .as_str()
        .unwrap()
        .to_string();
    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/commands/custom:missing/run")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "catalogRevision": revision }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runs_factory_commands_through_the_shared_task_creator() {
    let temp = tempfile::tempdir().expect("temporary repo");
    let repo_path = temp.path().to_string_lossy().into_owned();
    let captured = Arc::new(Mutex::new(None));
    let captured_request = Arc::clone(&captured);
    let app = test_router_with_seed_and_task_creator(
        "repo-command-run",
        "Studio Mac",
        move |db| {
            db.insert_repo(NewRepo {
                id: "repo-1",
                path: &repo_path,
                name: "Kanna",
                default_branch: Some("main"),
            })
            .expect("insert repo");
        },
        Arc::new(move |request| {
            *captured_request.lock().expect("capture request") = Some(request);
            Ok(CreateTaskResponse {
                task_id: "created-command-task".to_string(),
                repo_id: "repo-1".to_string(),
                title: "Create Agent".to_string(),
                prompt: "Help me create a new agent definition for this repository.".to_string(),
                stage: "in progress".to_string(),
                agent_type: "pty".to_string(),
                worktree_path: Some("/tmp/worktree".to_string()),
            })
        }),
    );
    let catalog = app
        .clone()
        .oneshot(
            Request::get("/v1/repos/repo-1/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let revision = response_json(catalog).await["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/commands/factory:create-agent/run")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "catalogRevision": revision }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        serde_json::json!({
            "taskId": "created-command-task",
            "reused": false,
            "ownerDesktopId": "repo-command-run",
            "ownerLocalRepoId": "repo-1",
            "ownerLocalTaskId": "created-command-task"
        })
    );
    let request = captured
        .lock()
        .expect("captured request")
        .take()
        .expect("task request");
    assert_eq!(request.repo_id, "repo-1");
    assert_eq!(
        request.prompt,
        "Help me create a new agent definition for this repository."
    );
    assert_eq!(request.display_name.as_deref(), Some("Create Agent"));
}

#[tokio::test]
async fn custom_command_passes_stable_template_identity_and_teardown_to_task_creation() {
    let temp = tempfile::tempdir().expect("temporary repo");
    let task_dir = temp.path().join(".kanna/tasks/selected");
    std::fs::create_dir_all(&task_dir).expect("custom task directory");
    std::fs::write(
        task_dir.join("agent.md"),
        "---\nname: Duplicate label\nteardown: [printf selected-cleanup]\n---\nRun selected.\n",
    )
    .expect("custom task definition");
    let repo_path = temp.path().to_string_lossy().into_owned();
    let captured = Arc::new(Mutex::new(None));
    let captured_request = Arc::clone(&captured);
    let app = test_router_with_seed_and_task_creator(
        "repo-command-custom-run",
        "Studio Mac",
        move |db| {
            db.insert_repo(NewRepo {
                id: "repo-1",
                path: &repo_path,
                name: "Kanna",
                default_branch: Some("main"),
            })
            .expect("insert repo");
        },
        Arc::new(move |request| {
            *captured_request.lock().expect("capture request") = Some(request);
            Ok(CreateTaskResponse {
                task_id: "created-custom-task".to_string(),
                repo_id: "repo-1".to_string(),
                title: "Duplicate label".to_string(),
                prompt: "Run selected.".to_string(),
                stage: "in progress".to_string(),
                agent_type: "pty".to_string(),
                worktree_path: Some("/tmp/worktree".to_string()),
            })
        }),
    );
    let catalog = app
        .clone()
        .oneshot(
            Request::get("/v1/repos/repo-1/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let revision = response_json(catalog).await["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let response = app
        .oneshot(
            Request::post("/v1/repos/repo-1/commands/custom%3Aselected/run")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "catalogRevision": revision }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let request = captured
        .lock()
        .expect("captured request")
        .take()
        .expect("task request");
    assert_eq!(
        request.task_template,
        Some(crate::mobile_api::TaskTemplateLaunch {
            id: "custom:selected".to_string(),
            teardown: vec!["printf selected-cleanup".to_string()],
        })
    );
}
