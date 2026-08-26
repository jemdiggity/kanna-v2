use super::*;
use crate::api::{notify_mobile_via_api, wait_task_events_via_api, TaskEventsParams};
use crate::commands::tool::call_catalog_tool_with_task_id;
use crate::models::MobileNotificationRequest;

#[path = "../../../test-support/old_relay_mobile_notification.rs"]
mod old_relay_mobile_notification;

#[tokio::test]
async fn typed_cli_round_trips_the_server_ks1_aggregate_cursor() {
    let aggregate_cursor = "ks1.fixture-with-ke1-machine-cursors";
    let responses = vec![
        http_json_response(
            "200 OK",
            &serde_json::json!({
                "waitOutcome": "events",
                "cursor": aggregate_cursor,
                "events": [{ "seq": 7, "taskId": "task-a", "type": "run.started", "payload": {} }],
                "hasMore": true,
            })
            .to_string(),
        ),
        http_json_response(
            "200 OK",
            &serde_json::json!({
                "waitOutcome": "timeout",
                "cursor": aggregate_cursor,
                "events": [],
                "hasMore": false,
            })
            .to_string(),
        ),
    ];
    let (base_url, server) = serve_http_responses(responses).await;
    let task_ids = vec!["task-a".to_string()];
    let params = |cursor| TaskEventsParams {
        task_ids: &task_ids,
        parent_task_id: None,
        repo_id: None,
        repo_remote_url_hash: None,
        local_only: false,
        include_current_activity: true,
        short_cursor: false,
        from: None,
        cursor,
        timeout_secs: 0,
        limit: Some(100),
    };

    let first = wait_task_events_via_api(&base_url, &params(None))
        .await
        .expect("first CLI wait");
    assert_eq!(first["cursor"], aggregate_cursor);
    let second = wait_task_events_via_api(&base_url, &params(Some(aggregate_cursor)))
        .await
        .expect("resumed CLI wait");
    assert_eq!(second["cursor"], aggregate_cursor);

    let requests = server.await.expect("fixture server");
    assert!(requests[1].starts_with(&format!(
        "GET /v1/task-events?timeoutSecs=0&taskIds=task-a&includeCurrentActivity=true&shortCursor=false&cursor={aggregate_cursor}&limit=100 HTTP/1.1"
    )), "{}", requests[1]);
}

#[test]
fn task_watch_filter_suppresses_only_engine_mechanics() {
    for event_type in [
        "run.started",
        "stage.changed",
        "task.created",
        "task.input_delivered",
    ] {
        assert!(!is_actionable_task_event(&serde_json::json!({
            "type": event_type,
            "payload": {}
        })));
    }
    assert!(!is_actionable_task_event(&serde_json::json!({
        "type": "run.finished",
        "payload": {
            "runId": "run-old",
            "currentTask": { "latestRun": { "id": "run-next", "status": "running" } }
        }
    })));
    for event_type in [
        "run.finished",
        "task.revision_requested",
        "task.awaiting_input",
        "task.pr_created",
        "task.closed",
    ] {
        assert!(is_actionable_task_event(&serde_json::json!({
            "type": event_type,
            "payload": {
                "runId": "run-terminal",
                "currentTask": { "latestRun": { "id": "run-terminal", "status": "failed" } }
            }
        })));
    }
}

#[tokio::test]
async fn task_watch_starts_at_tail_advances_suppressed_cursor_and_exits_on_actionable_batch() {
    let responses = vec![
        http_json_response(
            "200 OK",
            &serde_json::json!({
                "waitOutcome": "events",
                "cursor": "cursor-1",
                "events": [{ "seq": 1, "taskId": "task-a", "type": "run.started", "payload": {} }],
                "hasMore": false
            })
            .to_string(),
        ),
        http_json_response(
            "200 OK",
            &serde_json::json!({
                "waitOutcome": "events",
                "cursor": "cursor-2",
                "events": [{ "seq": 2, "taskId": "task-a", "type": "task.awaiting_input", "payload": { "stage": "review" } }],
                "hasMore": false
            })
            .to_string(),
        ),
    ];
    let (base_url, server) = serve_http_responses(responses).await;
    let mut output = Vec::new();
    watch_task_events(
        &base_url,
        TaskWatchOptions {
            task_ids: vec!["task-a".to_string()],
            repo_id: None,
            cursor: None,
            all_events: false,
            budget_secs: None,
            follow: false,
        },
        &mut output,
    )
    .await
    .expect("watch actionable event");

    let requests = server.await.expect("fixture server");
    assert!(requests[0].contains("taskIds=task-a"));
    assert!(requests[0].contains("from=now"));
    assert!(requests[0].contains("timeoutSecs=240"));
    assert!(!requests[0].contains("cursor="));
    assert!(requests[1].contains("cursor=cursor-1"));
    assert!(!requests[1].contains("from=now"));

    let lines = String::from_utf8(output).unwrap();
    let rows = lines
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["type"], "task.awaiting_input");
    assert_eq!(rows[0]["payload"]["stage"], "review");
    assert_eq!(rows[1]["type"], "watch.cursor");
    assert_eq!(rows[1]["watchOutcome"], "actionable");
    assert_eq!(rows[1]["cursor"], "cursor-2");
}

#[tokio::test]
async fn task_watch_budget_expiry_is_a_distinct_successful_outcome() {
    let response = http_json_response(
        "200 OK",
        &serde_json::json!({
            "waitOutcome": "timeout",
            "cursor": "tail-cursor",
            "events": [],
            "hasMore": false
        })
        .to_string(),
    );
    let (base_url, server) = serve_single_http_response(response).await;
    let mut output = Vec::new();
    watch_task_events(
        &base_url,
        TaskWatchOptions {
            task_ids: Vec::new(),
            repo_id: Some("repo-1".to_string()),
            cursor: None,
            all_events: false,
            budget_secs: Some(0),
            follow: false,
        },
        &mut output,
    )
    .await
    .expect("quiet expiry is success");
    let request = server.await.expect("fixture server");
    assert!(request.contains("repoId=repo-1"));
    assert!(request.contains("from=now"));
    assert!(request.contains("timeoutSecs=0"));
    let row: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(row["watchOutcome"], "budget_expired");
    assert_eq!(row["cursor"], "tail-cursor");
}

#[tokio::test]
async fn task_watch_all_and_follow_stream_before_quiet_exit() {
    let response = http_json_response(
        "200 OK",
        &serde_json::json!({
            "waitOutcome": "events",
            "cursor": "cursor-follow",
            "events": [{ "seq": 1, "taskId": "task-a", "type": "stage.changed", "payload": {} }],
            "hasMore": false
        })
        .to_string(),
    );
    let (base_url, server) = serve_single_http_response(response).await;
    let mut output = Vec::new();
    watch_task_events(
        &base_url,
        TaskWatchOptions {
            task_ids: vec!["task-a".to_string()],
            repo_id: None,
            cursor: None,
            all_events: true,
            budget_secs: Some(0),
            follow: true,
        },
        &mut output,
    )
    .await
    .expect("follow quiet expiry");
    server.await.expect("fixture server");
    let rows = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows[0]["type"], "stage.changed");
    assert_eq!(rows[1]["watchOutcome"], "following");
    assert_eq!(rows[2]["watchOutcome"], "budget_expired");
    assert_eq!(rows[2]["cursor"], "cursor-follow");
}

#[tokio::test]
async fn catalog_cli_defaults_listing_search_and_watch_to_the_task_repository() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    for (tool, args, expected_path, response_body) in [
        (
            "kanna_list_recent_tasks",
            serde_json::json!({}),
            "/v1/tasks/recent?repoId=repo-current",
            serde_json::json!([]),
        ),
        (
            "kanna_search_tasks",
            serde_json::json!({ "query": "review" }),
            "/v1/tasks/search?query=review&repoId=repo-current",
            serde_json::json!([]),
        ),
        (
            "kanna_wait_events",
            serde_json::json!({ "from": "now", "timeout_secs": 0 }),
            "/v1/task-events?repoId=repo-current&shortCursor=true&from=now&timeoutSecs=0",
            serde_json::json!({
                "waitOutcome": "timeout",
                "cursor": "17",
                "events": [],
                "hasMore": false
            }),
        ),
    ] {
        let responses = vec![
            http_json_response(
                "200 OK",
                &serde_json::json!({
                    "id": "task-current",
                    "repoId": "repo-current",
                    "title": "Manager",
                    "activity": "working"
                })
                .to_string(),
            ),
            http_json_response("200 OK", &response_body.to_string()),
        ];
        let (base_url, server) = serve_http_responses(responses).await;
        call_catalog_tool_with_task_id(&base_url, &catalog, tool, &args, Some("task-current"))
            .await
            .expect("catalog CLI call");
        let requests = server.await.expect("fixture server");
        assert!(
            requests[0].starts_with("GET /v1/tasks/task-current HTTP/1.1"),
            "{}",
            requests[0]
        );
        assert!(
            requests[1].starts_with(&format!("GET {expected_path} HTTP/1.1")),
            "{}",
            requests[1]
        );
    }
}

#[tokio::test]
async fn notify_mobile_surfaces_only_the_fixed_server_rejection_error() {
    use old_relay_mobile_notification::{
        OldRelayMobileNotificationServer, OLD_RELAY_CANARY, SAFE_REJECTION_ERROR,
    };

    let server = OldRelayMobileNotificationServer::start("cli").await;

    let error = notify_mobile_via_api(
        &server.base_url,
        &MobileNotificationRequest {
            title: "Provider call rejected".to_string(),
            body: "Exercise the safe relay error.".to_string(),
            task_id: None,
        },
    )
    .await
    .expect_err("relay dependency rejection should remain an HTTP error");
    let logs = server.finish();

    assert!(error.contains(SAFE_REJECTION_ERROR));
    assert!(!error.contains(OLD_RELAY_CANARY));
    assert!(!logs.contains(OLD_RELAY_CANARY));
}

#[tokio::test]
async fn advance_stage_posts_to_task_action_path_with_empty_json_body() {
    let response = http_json_response("200 OK", "{\"taskId\":\"next-task-1\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = advance_stage_via_api(&base_url, "task-123").await.unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "next-task-1");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/advance-stage HTTP/1.1"));
    assert!(request.contains("content-type: application/json"));
    assert!(request.ends_with("{}"));
}

#[tokio::test]
async fn signal_merge_handoff_posts_the_resolved_policy_request_details() {
    let response = http_json_response(
        "200 OK",
        r#"{"taskId":"merge-master-task","created":false}"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;
    let request_body = build_merge_handoff_request(
        "task-task-123-4".to_string(),
        "main".to_string(),
        Some("https://example.invalid/pull/1".to_string()),
        "approved".to_string(),
    );

    let response = signal_merge_handoff_via_api(&base_url, "task-123", &request_body)
        .await
        .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(response.task_id, "merge-master-task");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/signal-merge-handoff HTTP/1.1"));
    assert!(request.ends_with(
        r#"{"branch":"task-task-123-4","target":"main","prUrl":"https://example.invalid/pull/1","summary":"approved"}"#
    ));
    assert!(!request.contains("overrideRecord"));
    assert!(!request.contains("approvalGate"));
}

#[tokio::test]
async fn rerun_stage_posts_to_task_action_path_with_empty_json_body() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = rerun_stage_via_api(&base_url, "task-123").await.unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-123");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/rerun-stage HTTP/1.1"));
    assert!(request.contains("content-type: application/json"));
    assert!(request.ends_with("{}"));
}

#[tokio::test]
async fn set_task_workflow_posts_camel_case_workflow_name() {
    let response = http_json_response(
        "200 OK",
        r#"{"taskId":"task-123","workflowName":"single-reviewer","stage":"in progress","revisionRounds":2,"revisionLimit":3}"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let updated = set_task_workflow_via_api(
        &base_url,
        "task-123",
        &SetTaskWorkflowRequest {
            workflow_name: "single-reviewer".to_string(),
        },
    )
    .await
    .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(updated.workflow_name, "single-reviewer");
    assert_eq!(updated.revision_rounds, 2);
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/set-workflow HTTP/1.1"));
    assert!(request.ends_with(r#"{"workflowName":"single-reviewer"}"#));
}

#[tokio::test]
async fn resume_task_posts_to_task_action_path_with_empty_json_body() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = resume_task_via_api(&base_url, "task-123").await.unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-123");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/resume HTTP/1.1"));
    assert!(request.contains("content-type: application/json"));
    assert!(request.ends_with("{}"));
}

#[tokio::test]
async fn get_task_via_api_fetches_single_task_path() {
    let response = http_json_response(
        "200 OK",
        r#"{
                "id": "task-123",
                "repoId": "repo-1",
                "title": "Wanted",
                "stage": "pr",
                "activity": "unread",
                "snippet": null,
                "agentType": "pty",
                "agentProvider": "claude",
                "branch": "task-task-123",
                "prUrl": "https://github.com/acme/kanna/pull/1",
                "closedAt": null,
                "worktreePath": null,
                "commitsAhead": 0,
                "commitsBehind": 0,
                "dirty": false,
                "childTaskIds": ["child-open", "child-closed"]
            }"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let task = get_task_via_api(&base_url, "task-123").await.unwrap();
    let request = handle.await.unwrap();

    assert_eq!(task.id, "task-123");
    assert_eq!(task.activity.as_deref(), Some("unread"));
    assert_eq!(
        task.child_task_ids.as_deref(),
        Some(["child-open".to_string(), "child-closed".to_string()].as_slice())
    );
    assert_eq!(
        serde_json::to_value(&task).unwrap()["childTaskIds"],
        json!(["child-open", "child-closed"]),
        "the typed CLI must not drop the downward task view when it re-serializes the response"
    );
    assert!(request.starts_with("GET /v1/tasks/task-123?agentView=true HTTP/1.1"));
}

#[tokio::test]
async fn list_task_children_via_api_fetches_and_preserves_verdicts() {
    let response = http_json_response(
        "200 OK",
        r#"[{
            "id":"child-1",
            "agent":"review-security",
            "workflowName":"specialty-review",
            "createdAt":"2026-08-06 09:00:00",
            "closedAt":"2026-08-06 09:30:00",
            "latestRun":{
                "id":"run-1",
                "stage":"review",
                "kind":"main",
                "status":"succeeded",
                "summary":"PASS: no security findings",
                "resumedFromRunId":null,
                "resumeFallbackReason":null,
                "finishedAt":"2026-08-06 09:20:00"
            }
        }]"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let children = list_task_children_via_api(&base_url, "task 123")
        .await
        .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(children.len(), 1);
    assert_eq!(children[0].id, "child-1");
    assert_eq!(children[0].agent.as_deref(), Some("review-security"));
    assert_eq!(
        children[0]
            .latest_run
            .as_ref()
            .and_then(|run| run.summary.as_deref()),
        Some("PASS: no security findings")
    );
    let rendered = serde_json::to_value(&children).unwrap();
    assert_eq!(
        rendered[0]["workflowName"],
        json!("specialty-review"),
        "the typed CLI must not drop the workflow identity when printing JSON"
    );
    assert_eq!(
        rendered[0]["latestRun"]["status"],
        json!("succeeded"),
        "the typed CLI must not drop the durable verdict when printing JSON"
    );
    assert!(request.starts_with("GET /v1/tasks/task%20123/children HTTP/1.1"));
}

fn child_task_body(runtime_state: &str) -> String {
    // A wait reads the runtime dimension; `activity` follows it here only so
    // the body stays the shape the server actually sends.
    let activity = match runtime_state {
        "busy" => "working",
        _ => "unread",
    };
    json!({
        "id": "child-1",
        "repoId": "repo-1",
        "title": "Specialty review",
        "stage": "review",
        "activity": activity,
        "runtimeState": runtime_state,
        "readState": if activity == "unread" { "unread" } else { "read" },
        "snippet": null,
        "agentType": "pty",
        "agentProvider": "claude",
        "branch": "task-child-1",
        "prUrl": null,
        "closedAt": null,
        "worktreePath": null,
        "commitsAhead": 0,
        "commitsBehind": 0,
        "dirty": false
    })
    .to_string()
}

/// The MCP-less surface has to survive the same loop: an oversized window is
/// clamped, running out of it is a timeout outcome rather than an error, and
/// calling again picks the task up where it was left.
#[tokio::test(start_paused = true)]
async fn wait_task_via_api_clamps_its_window_and_resumes_after_a_timeout() {
    let body = std::sync::Arc::new(std::sync::Mutex::new(child_task_body("busy")));
    let base_url = serve_repeating_http_response(body.clone()).await;

    let started = tokio::time::Instant::now();
    let outcome = wait_task_via_api(&base_url, "child-1", 600, 3, WaitUntil::Finished)
        .await
        .unwrap();
    let waited = started.elapsed();

    match outcome {
        WaitTaskOutcome::TimedOut { task, timeout_secs } => {
            assert_eq!(timeout_secs, MAX_WAIT_TIMEOUT_SECS);
            assert_eq!(task.id, "child-1");
            assert_eq!(task.stage.as_deref(), Some("review"));
            assert_eq!(task.activity.as_deref(), Some("working"));
        }
        WaitTaskOutcome::Resolved(task) => panic!("unexpected resolve: {task:?}"),
    }
    assert!(
        waited.as_secs() <= CLIENT_TOOL_CALL_BUDGET_SECS,
        "a 600s request must still answer inside the {CLIENT_TOOL_CALL_BUDGET_SECS}s client budget"
    );

    *body.lock().unwrap() = child_task_body("exited");
    let outcome = wait_task_via_api(&base_url, "child-1", 600, 3, WaitUntil::Finished)
        .await
        .unwrap();

    match outcome {
        WaitTaskOutcome::Resolved(task) => {
            assert_eq!(task.id, "child-1");
            assert_eq!(task.stage.as_deref(), Some("review"));
            assert_eq!(task.runtime_state.as_deref(), Some("exited"));
        }
        WaitTaskOutcome::TimedOut { task, .. } => panic!("unexpected timeout: {task:?}"),
    }
}

#[tokio::test]
async fn dependent_tasks_exist_via_api_fetches_and_decodes_dependent_tasks() {
    let response = http_json_response(
        "200 OK",
        r#"{"exists":true,"dependentTasks":[{"taskId":"dependent-1","title":"Dependent task","branch":"feature/child","baseRef":"origin/feature/parent","reason":"base_ref"}]}"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let result = dependent_tasks_exist_via_api(&base_url, "task-123")
        .await
        .unwrap();
    let request = handle.await.unwrap();

    assert!(result.exists);
    assert_eq!(result.dependent_tasks[0].task_id, "dependent-1");
    assert_eq!(result.dependent_tasks[0].reason, "base_ref");
    assert!(request.starts_with("GET /v1/tasks/task-123/dependent-tasks-exist HTTP/1.1"));
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({
            "exists": true,
            "dependentTasks": [{
                "taskId": "dependent-1",
                "title": "Dependent task",
                "branch": "feature/child",
                "baseRef": "origin/feature/parent",
                "reason": "base_ref"
            }]
        })
    );
}

#[tokio::test]
async fn close_task_posts_to_close_action_path() {
    let response = "HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\n".to_string();
    let (base_url, handle) = serve_single_http_response(response).await;

    close_task_via_api(&base_url, "task-123").await.unwrap();
    let request = handle.await.unwrap();

    assert!(request.starts_with("POST /v1/tasks/task-123/actions/close HTTP/1.1"));
}

#[tokio::test]
async fn signal_agent_posts_message_to_repo_agent_signal_path() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-merge\",\"created\":false}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = signal_agent_via_api(
        &base_url,
        "repo-1",
        "merge",
        &SignalAgentRequest {
            message: "Please merge task task-1".to_string(),
            agent_provider: None,
            effort: None,
        },
    )
    .await
    .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-merge");
    assert!(!action.created);
    assert!(request.starts_with("POST /v1/repos/repo-1/agents/merge/signal HTTP/1.1"));
    assert!(request.contains(r#"{"message":"Please merge task task-1"}"#));
}

#[tokio::test]
async fn rename_task_patches_task_update_path_with_display_name() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = rename_task_via_api(
        &base_url,
        "task-123",
        &TaskRenameRequest {
            display_name: "Renamed task".to_string(),
        },
    )
    .await
    .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-123");
    assert!(request.starts_with("PATCH /v1/tasks/task-123 HTTP/1.1"));
    assert!(request.contains(r#"{"displayName":"Renamed task"}"#));
}

#[tokio::test]
async fn set_task_parent_posts_camel_case_parent_id() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = set_task_parent_via_api(
        &base_url,
        "task-123",
        &SetTaskParentRequest {
            parent_task_id: Some("parent-1".to_string()),
        },
    )
    .await
    .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-123");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/set-parent HTTP/1.1"));
    assert!(request.contains(r#"{"parentTaskId":"parent-1"}"#));
}

#[tokio::test]
async fn set_task_parent_omits_parent_id_when_clearing() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    set_task_parent_via_api(&base_url, "task-123", &SetTaskParentRequest::default())
        .await
        .unwrap();
    let request = handle.await.unwrap();

    assert!(request.starts_with("POST /v1/tasks/task-123/actions/set-parent HTTP/1.1"));
    assert!(request.ends_with("{}"));
}

#[tokio::test]
async fn advance_stage_surfaces_http_errors() {
    let response = http_json_response("409 Conflict", "{\"error\":\"task not accepted yet\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let error = advance_stage_via_api(&base_url, "task-123")
        .await
        .unwrap_err();
    let request = handle.await.unwrap();

    assert!(request.starts_with("POST /v1/tasks/task-123/actions/advance-stage HTTP/1.1"));
    assert!(error.contains("409 Conflict"));
    assert!(error.contains("task not accepted yet"));
}

#[tokio::test]
async fn request_revision_surfaces_server_error_body() {
    let response = http_json_response(
        "500 Internal Server Error",
        "failed to create worktree: No space left on device",
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let error = request_revision_via_api(
        &base_url,
        "task-123",
        &build_request_revision_request(
            "in progress".to_string(),
            "QA failed".to_string(),
            "Add the missing coverage.".to_string(),
            None,
        ),
    )
    .await
    .unwrap_err();
    let request = handle.await.unwrap();

    assert!(request.starts_with("POST /v1/tasks/task-123/actions/request-revision HTTP/1.1"));
    assert!(error.contains("500 Internal Server Error"));
    assert!(error.contains("No space left on device"));
}

#[tokio::test]
async fn get_task_surfaces_server_error_body() {
    let response = http_json_response("500 Internal Server Error", "db error: disk I/O error");
    let (base_url, handle) = serve_single_http_response(response).await;

    let error = get_task_via_api(&base_url, "task-123").await.unwrap_err();
    handle.await.unwrap();

    assert!(error.contains("500 Internal Server Error"));
    assert!(error.contains("db error: disk I/O error"));
}

#[tokio::test]
async fn block_task_posts_to_task_action_path() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = block_task_via_api(
        &base_url,
        "task-123",
        &build_block_task_request(vec!["blocker-1".to_string()]),
    )
    .await
    .unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-123");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/block HTTP/1.1"));
    assert!(request.contains(r#"{"blockerTaskIds":["blocker-1"]}"#));
}

#[tokio::test]
async fn unblock_task_posts_to_task_action_path() {
    let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
    let (base_url, handle) = serve_single_http_response(response).await;

    let action = unblock_task_via_api(&base_url, "task-123").await.unwrap();
    let request = handle.await.unwrap();

    assert_eq!(action.task_id, "task-123");
    assert!(request.starts_with("POST /v1/tasks/task-123/actions/unblock HTTP/1.1"));
    assert!(request.ends_with("{}"));
}

#[tokio::test]
async fn create_task_via_api_posts_default_agent_type_without_agent_provider_when_flags_absent() {
    let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 1024];
        let (body_start, content_length) = loop {
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(n > 0, "client closed before sending request body");
            received.extend_from_slice(&buffer[..n]);
            if let Some(header_end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                let header_text = String::from_utf8(received[..header_end].to_vec()).unwrap();
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .or_else(|| line.strip_prefix("Content-Length: "))
                    })
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                break (header_end + 4, content_length);
            }
        };
        while received.len() < body_start + content_length {
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(n > 0, "client closed before sending full request body");
            received.extend_from_slice(&buffer[..n]);
        }
        let body =
            String::from_utf8(received[body_start..body_start + content_length].to_vec()).unwrap();
        let response_body = serde_json::json!({
            "taskId": "task-1",
            "repoId": "repo-1",
            "title": "Use the saved default provider",
            "stage": "in progress",
        })
        .to_string();
        stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        response_body.len(),
                        response_body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        body
    });

    let request = build_create_task_request(TaskCreateOptions {
        repo_id: "repo-1".to_string(),
        prompt: "Use the saved default provider".to_string(),
        display_name: None,
        workflow_name: None,
        base_ref: None,
        agent: None,
        agent_provider: None,
        agent_type: None,
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tool: Vec::new(),
        blocker_task_id: Vec::new(),
        parent_task: None,
    });

    let created = create_task_via_api(&format!("http://{addr}"), &request)
        .await
        .unwrap();
    let body = server.await.unwrap();

    assert_eq!(created.task_id, "task-1");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        json!({
            "repoId": "repo-1",
            "prompt": "Use the saved default provider",
            "agentType": "pty",
        })
    );
}
