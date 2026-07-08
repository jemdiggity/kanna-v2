use kanna_tool_catalog::{
    bundled_catalog, resolve_request, Method, ParamLoc, ParamType, ResponseKind, WaitUntil,
};
use serde_json::json;
use std::fs;

#[test]
fn bundled_catalog_parses_and_declares_all_tools() {
    let catalog = bundled_catalog();
    let names = catalog
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec![
            "kanna_list_repos",
            "kanna_add_repo",
            "kanna_list_recent_tasks",
            "kanna_get_task",
            "kanna_wait_task",
            "kanna_task_logs",
            "kanna_search_tasks",
            "kanna_list_repo_tasks",
            "kanna_create_task",
            "kanna_signal_agent",
            "kanna_send_task_input",
            "kanna_close_task",
            "kanna_rename_task",
            "kanna_advance_stage",
            "kanna_rerun_stage",
            "kanna_block_task",
            "kanna_unblock_task",
            "kanna_set_task_parent",
            "kanna_is_dependent_tasks_exist",
            "kanna_complete_stage",
            "kanna_request_revision",
        ]
    );
}

#[test]
fn generated_schema_preserves_required_order_types_and_enums() {
    let tools = bundled_catalog().tools_list_value();
    let create_task = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_create_task")
        .expect("create task tool");

    assert_eq!(create_task["inputSchema"]["required"], json!(["prompt"]));
    assert_eq!(
        create_task["inputSchema"]["properties"]["allowed_tools"],
        json!({ "type": "array", "items": { "type": "string" } })
    );
    assert!(
        create_task["inputSchema"]["properties"]["stage"].is_null(),
        "agent-facing create-task tool should not expose stage overrides"
    );

    let wait = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_wait_task")
        .expect("wait task tool");
    assert_eq!(
        wait["inputSchema"]["properties"]["until"],
        json!({ "type": "string", "enum": ["finished", "closed"] })
    );
}

#[test]
fn resolves_expected_requests_for_every_bundled_tool() {
    let catalog = bundled_catalog();
    let cases = [
        (
            "kanna_list_repos",
            json!({}),
            Method::Get,
            ResponseKind::Json,
            "/v1/repos",
            json!({}),
        ),
        (
            "kanna_add_repo",
            json!({ "path": "/Users/me/project", "name": "Project" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/repos",
            json!({ "path": "/Users/me/project", "name": "Project" }),
        ),
        (
            "kanna_list_recent_tasks",
            json!({}),
            Method::Get,
            ResponseKind::Json,
            "/v1/tasks/recent",
            json!({}),
        ),
        (
            "kanna_get_task",
            json!({ "task_id": "task 1" }),
            Method::Get,
            ResponseKind::Json,
            "/v1/tasks/task%201",
            json!({}),
        ),
        (
            "kanna_task_logs",
            json!({ "task_id": "task 1", "tail": 25 }),
            Method::Get,
            ResponseKind::Text,
            "/v1/tasks/task%201/logs?tail=25",
            json!({}),
        ),
        (
            "kanna_search_tasks",
            json!({ "query": "review me" }),
            Method::Get,
            ResponseKind::Json,
            "/v1/tasks/search?query=review%20me",
            json!({}),
        ),
        (
            "kanna_list_repo_tasks",
            json!({ "repo_id": "repo-1" }),
            Method::Get,
            ResponseKind::Json,
            "/v1/repos/repo-1/tasks",
            json!({}),
        ),
        (
            "kanna_create_task",
            json!({
                "prompt": "Inferred repo task"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks",
            json!({
                "prompt": "Inferred repo task",
                "agentType": "pty"
            }),
        ),
        (
            "kanna_create_task",
            json!({
                "repo_id": "repo-1",
                "prompt": "Blocked work",
                "display_name": "Short task title",
                "agent_type": "agent",
                "blocker_task_ids": ["blocker-1", "blocker-2"]
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks",
            json!({
                "repoId": "repo-1",
                "prompt": "Blocked work",
                "displayName": "Short task title",
                "agentType": "agent",
                "blockerTaskIds": ["blocker-1", "blocker-2"]
            }),
        ),
        (
            "kanna_create_task",
            json!({
                "repo_id": "repo-1",
                "prompt": "Child",
                "notify_task_id": "task-parent"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks",
            json!({
                "repoId": "repo-1",
                "prompt": "Child",
                "agentType": "pty",
                "notifyTaskId": "task-parent"
            }),
        ),
        (
            "kanna_create_task",
            json!({
                "repo_id": "repo-1",
                "prompt": "Subtask",
                "parent_task_id": "task-parent"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks",
            json!({
                "repoId": "repo-1",
                "prompt": "Subtask",
                "agentType": "pty",
                "parentTaskId": "task-parent"
            }),
        ),
        (
            "kanna_signal_agent",
            json!({
                "repo_id": "repo-1",
                "agent": "merge",
                "message": "MERGE task-1 -> main: ready"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/repos/repo-1/agents/merge/signal",
            json!({
                "message": "MERGE task-1 -> main: ready"
            }),
        ),
        (
            "kanna_send_task_input",
            json!({ "task_id": "task-1", "input": "continue" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/input",
            json!({ "input": "continue" }),
        ),
        (
            "kanna_close_task",
            json!({ "task_id": "task-1" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/close",
            json!({}),
        ),
        (
            "kanna_rename_task",
            json!({ "task_id": "task 1", "display_name": "Renamed task" }),
            Method::Patch,
            ResponseKind::Json,
            "/v1/tasks/task%201",
            json!({ "displayName": "Renamed task" }),
        ),
        (
            "kanna_advance_stage",
            json!({ "task_id": "task-1" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/advance-stage",
            json!({}),
        ),
        (
            "kanna_block_task",
            json!({ "task_id": "task-1", "blocker_task_ids": ["blocker-1"] }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/block",
            json!({ "blockerTaskIds": ["blocker-1"] }),
        ),
        (
            "kanna_unblock_task",
            json!({ "task_id": "task-1" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/unblock",
            json!({}),
        ),
        (
            "kanna_set_task_parent",
            json!({ "task_id": "task-1", "parent_task_id": "task-parent" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/set-parent",
            json!({ "parentTaskId": "task-parent" }),
        ),
        (
            "kanna_set_task_parent",
            json!({ "task_id": "task-1" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/set-parent",
            json!({}),
        ),
        (
            "kanna_is_dependent_tasks_exist",
            json!({ "task_id": "task-1" }),
            Method::Get,
            ResponseKind::Json,
            "/v1/tasks/task-1/dependent-tasks-exist",
            json!({}),
        ),
        (
            "kanna_complete_stage",
            json!({
                "task_id": "task-1",
                "status": "success",
                "summary": "done",
                "metadata": { "review": "passed" }
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/complete-stage",
            json!({
                "status": "success",
                "summary": "done",
                "metadata": { "review": "passed" }
            }),
        ),
        (
            "kanna_request_revision",
            json!({
                "task_id": "task-1",
                "summary": "needs work",
                "prompt": "fix it"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/request-revision",
            json!({
                "targetStage": "in progress",
                "summary": "needs work",
                "prompt": "fix it"
            }),
        ),
    ];

    for (name, args, method, kind, path, body) in cases {
        let request = resolve_request(&catalog, name, &args).expect(name);
        assert_eq!(request.method, method, "{name}");
        assert_eq!(request.kind, kind, "{name}");
        assert_eq!(request.path, path, "{name}");
        assert_eq!(request.body, body, "{name}");
    }

    let wait = resolve_request(
        &catalog,
        "kanna_wait_task",
        &json!({ "task_id": "task 1", "timeout_secs": 999, "poll_secs": 0, "until": "closed" }),
    )
    .expect("wait task");
    assert_eq!(wait.kind, ResponseKind::Wait);
    assert_eq!(wait.method, Method::Get);
    assert_eq!(wait.path, "/v1/tasks/task%201");
    let wait_spec = wait.wait.expect("wait spec");
    assert_eq!(wait_spec.task_id, "task 1");
    assert_eq!(wait_spec.timeout_secs, 600);
    assert_eq!(wait_spec.poll_secs, 1);
    assert_eq!(wait_spec.until, WaitUntil::Closed);
}

#[test]
fn create_task_rejects_undeclared_stage_override_argument() {
    let catalog = bundled_catalog();
    let err = resolve_request(
        &catalog,
        "kanna_create_task",
        &json!({
            "repo_id": "repo-1",
            "prompt": "Jump to PR",
            "stage": "pr"
        }),
    )
    .expect_err("stage should not be accepted by agent-facing create-task tools");

    assert!(err.contains("unknown argument: stage"));
}

#[test]
fn preserves_validation_error_strings() {
    let catalog = bundled_catalog();

    assert_eq!(
        resolve_request(&catalog, "kanna_search_tasks", &json!({})),
        Err("missing required argument: query".to_string())
    );
    assert_eq!(
        resolve_request(
            &catalog,
            "kanna_create_task",
            &json!({ "repo_id": "repo-1", "prompt": "x", "allowed_tools": [1] })
        ),
        Err("allowed_tools must be an array of strings".to_string())
    );
    assert_eq!(
        resolve_request(
            &catalog,
            "kanna_task_logs",
            &json!({ "task_id": "task-1", "tail": "25" })
        ),
        Err("tail must be an unsigned integer".to_string())
    );
    assert_eq!(
        resolve_request(
            &catalog,
            "kanna_rename_task",
            &json!({ "task_id": "task-1" })
        ),
        Err("missing required argument: display_name".to_string())
    );
    assert_eq!(
        resolve_request(
            &catalog,
            "kanna_complete_stage",
            &json!({ "task_id": "task-1", "status": "maybe", "summary": "done" })
        ),
        Err("status must be success or failure".to_string())
    );
    assert_eq!(
        resolve_request(
            &catalog,
            "kanna_wait_task",
            &json!({ "task_id": "task-1", "until": "later" })
        ),
        Err("until must be finished or closed, got later".to_string())
    );
    assert_eq!(
        resolve_request(&catalog, "kanna_unknown", &json!({})),
        Err("unknown tool: kanna_unknown".to_string())
    );
}

#[test]
fn load_catalog_uses_override_and_falls_back_with_warning() {
    let root = std::env::temp_dir().join(format!("kanna-tool-catalog-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".kanna")).expect("create .kanna");
    let override_path = root.join(".kanna/mcp-tools.json");
    fs::write(
        &override_path,
        r#"{
          "tools": [{
            "name": "kanna_test_tool",
            "description": "Test tool",
            "method": "GET",
            "path": "/v1/test",
            "response": "json",
            "params": []
          }]
        }"#,
    )
    .expect("write override");

    let loaded = kanna_tool_catalog::load_catalog(&root);
    assert_eq!(loaded.catalog.tools[0].name, "kanna_test_tool");
    assert_eq!(
        loaded.watch_source.as_deref(),
        Some(override_path.as_path())
    );
    assert_eq!(loaded.warning, None);

    fs::write(&override_path, "{").expect("write invalid override");
    let loaded = kanna_tool_catalog::load_catalog(&root);
    assert!(loaded.warning.expect("warning").contains("failed to parse"));
    assert_eq!(loaded.catalog.tools[0].name, "kanna_list_repos");
    assert_eq!(
        loaded.watch_source.as_deref(),
        Some(override_path.as_path())
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn catalog_types_are_deserialized_from_manifest_values() {
    let catalog = bundled_catalog();
    let create_task = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_create_task")
        .expect("create task");
    let params = create_task
        .params
        .iter()
        .map(|param| {
            (
                param.name.as_str(),
                param.param_type,
                param.location,
                param.key.as_deref(),
            )
        })
        .collect::<Vec<_>>();

    assert!(params.contains(&("repo_id", ParamType::String, ParamLoc::Body, Some("repoId"))));
    assert!(params.contains(&(
        "display_name",
        ParamType::String,
        ParamLoc::Body,
        Some("displayName"),
    )));
    assert!(params.contains(&(
        "agent_type",
        ParamType::String,
        ParamLoc::Body,
        Some("agentType"),
    )));
    assert!(params.contains(&(
        "blocker_task_ids",
        ParamType::StringArray,
        ParamLoc::Body,
        Some("blockerTaskIds"),
    )));
    assert!(params.contains(&(
        "parent_task_id",
        ParamType::String,
        ParamLoc::Body,
        Some("parentTaskId"),
    )));
}
