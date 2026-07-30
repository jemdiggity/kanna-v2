use kanna_tool_catalog::{
    bundled_catalog, clamp_wait_timeout_secs, resolve_request, wait_resolved_result,
    wait_timeout_result, Catalog, Method, ParamLoc, ParamType, ResponseKind, WaitUntil,
    CLIENT_TOOL_CALL_BUDGET_SECS, DEFAULT_WAIT_TIMEOUT_SECS, MAX_WAIT_TIMEOUT_SECS,
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
            "kanna_wait_events",
            "kanna_notify_mobile",
            "kanna_set_task_notify",
            "kanna_set_task_pipeline",
            "kanna_task_logs",
            "kanna_search_tasks",
            "kanna_list_repo_tasks",
            "kanna_list_agents",
            "kanna_create_task",
            "kanna_signal_agent",
            "kanna_send_task_input",
            "kanna_close_task",
            "kanna_rename_task",
            "kanna_advance_stage",
            "kanna_rerun_stage",
            "kanna_resume_task",
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
    let allowed_tools = &create_task["inputSchema"]["properties"]["allowed_tools"];
    assert_eq!(allowed_tools["type"], json!("array"));
    assert_eq!(allowed_tools["items"], json!({ "type": "string" }));
    assert!(
        create_task["inputSchema"]["properties"]["stage"].is_null(),
        "agent-facing create-task tool should not expose stage overrides"
    );
    let agent = &create_task["inputSchema"]["properties"]["agent"];
    assert_eq!(
        agent["type"],
        json!("string"),
        "create-task must expose the agent override so orchestrators can bind any resolved agent"
    );
    assert!(
        agent["description"]
            .as_str()
            .is_some_and(|description| description.contains("kanna_list_agents")),
        "create-task must point orchestrators at resolved agent discovery"
    );
    assert_eq!(
        create_task["inputSchema"]["properties"]["model"]["description"],
        json!("Model id passed verbatim to the selected agent CLI: Claude uses '--model <id>', Copilot uses '--model=<id>', and Codex/OpenCode use '-m <id>'; Antigravity rejects model overrides. An explicit value overrides agent-definition frontmatter; omit it to use the provider default. Kanna does not maintain a model-id allowlist.")
    );

    let list_agents = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_list_agents")
        .expect("list agents tool");
    let list_description = list_agents["description"]
        .as_str()
        .expect("list agents description");
    for source in ["built_in", "repo_override", "repo_authored"] {
        assert!(
            list_description.contains(source),
            "list-agents must document source value `{source}`"
        );
    }

    let wait = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_wait_task")
        .expect("wait task tool");
    let until = &wait["inputSchema"]["properties"]["until"];
    assert_eq!(until["type"], json!("string"));
    assert_eq!(until["enum"], json!(["finished", "closed"]));
}

#[test]
fn generated_schema_surfaces_descriptions_defaults_and_integer_bounds() {
    let tools = bundled_catalog().tools_list_value();
    let tools = tools.as_array().expect("tools array");

    for tool in tools {
        let properties = tool["inputSchema"]["properties"]
            .as_object()
            .expect("properties object");
        for (name, property) in properties {
            assert!(
                property["description"]
                    .as_str()
                    .is_some_and(|d| !d.is_empty()),
                "{}.{name} must describe itself for agents",
                tool["name"]
            );
        }
    }

    let wait = tools
        .iter()
        .find(|tool| tool["name"] == "kanna_wait_task")
        .expect("wait task tool");
    let timeout = &wait["inputSchema"]["properties"]["timeout_secs"];
    assert_eq!(timeout["default"], json!(DEFAULT_WAIT_TIMEOUT_SECS));
    assert_eq!(timeout["maximum"], json!(MAX_WAIT_TIMEOUT_SECS));
    let poll = &wait["inputSchema"]["properties"]["poll_secs"];
    assert_eq!(poll["default"], json!(3));
    assert_eq!(poll["minimum"], json!(1));
    assert_eq!(
        wait["inputSchema"]["properties"]["until"]["default"],
        json!("finished")
    );
}

#[test]
fn generated_tools_mark_get_tools_read_only() {
    let catalog = bundled_catalog();
    let tools = catalog.tools_list_value();
    let tools = tools.as_array().expect("tools array");

    for (tool, def) in tools.iter().zip(&catalog.tools) {
        if def.method == kanna_tool_catalog::Method::Get {
            assert_eq!(
                tool["annotations"],
                json!({ "readOnlyHint": true }),
                "{} is a GET tool and should carry a read-only hint",
                def.name
            );
        } else {
            assert!(
                tool.get("annotations").is_none(),
                "{} mutates state and should not claim read-only",
                def.name
            );
        }
    }
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
            "kanna_list_agents",
            json!({ "repo_id": "repo-1" }),
            Method::Get,
            ResponseKind::Json,
            "/v1/repos/repo-1/agents",
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
                "agent_provider": "codex",
                "model": "gpt-5.6-codex",
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
                "agentProvider": "codex",
                "model": "gpt-5.6-codex",
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
            "kanna_rerun_stage",
            json!({ "task_id": "task-1" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/rerun-stage",
            json!({}),
        ),
        (
            "kanna_resume_task",
            json!({ "task_id": "task-1" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/resume",
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
            "kanna_notify_mobile",
            json!({
                "title": "Staging shipped",
                "body": "The staging build is ready.",
                "task_id": "task-1"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/mobile/notifications",
            json!({
                "title": "Staging shipped",
                "body": "The staging build is ready.",
                "taskId": "task-1"
            }),
        ),
        (
            "kanna_set_task_notify",
            json!({ "task_id": "task-child", "notify_task_id": "task-parent" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-child/actions/set-notify",
            json!({ "notifyTaskId": "task-parent" }),
        ),
        (
            "kanna_set_task_notify",
            json!({ "task_id": "task-child" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-child/actions/set-notify",
            json!({}),
        ),
        (
            "kanna_set_task_pipeline",
            json!({ "task_id": "task-child", "pipeline_name": "single-reviewer" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-child/actions/set-pipeline",
            json!({ "pipelineName": "single-reviewer" }),
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
    assert_eq!(wait_spec.timeout_secs, MAX_WAIT_TIMEOUT_SECS);
    assert_eq!(wait_spec.poll_secs, 1);
    assert_eq!(wait_spec.until, WaitUntil::Closed);
}

/// The multi-task wait blocks server-side, so its window is bound by the same
/// client budget as `kanna_wait_task`: the caller's `tools/call` is what dies
/// at 300s, whichever end of the connection is doing the waiting.
#[test]
fn wait_events_is_scoped_cursored_and_bounded_by_the_client_budget() {
    let catalog = bundled_catalog();

    // The watched set is an array in the schema and comma-joined on the wire,
    // so an agent hands over the ids it holds instead of formatting a query.
    let request = resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "task_ids": ["task-a", "task-b"], "cursor": "42" }),
    )
    .expect("wait events");
    assert_eq!(request.method, Method::Get);
    assert_eq!(request.kind, ResponseKind::Json);
    assert_eq!(
        request.path,
        format!("/v1/task-events?taskIds=task-a%2Ctask-b&cursor=42&timeoutSecs={DEFAULT_WAIT_TIMEOUT_SECS}")
    );
    let tools = catalog.tools_list_value();
    let schema = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_wait_events")
        .expect("wait events tool")["inputSchema"]
        .clone();
    assert_eq!(
        schema["properties"]["task_ids"]["items"],
        json!({ "type": "string" }),
        "task_ids must be declared as an array of strings"
    );

    let repo_scoped = resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "repo_id": "repo 1", "timeout_secs": 3600, "limit": 5 }),
    )
    .expect("wait events")
    .path;
    assert_eq!(
        repo_scoped,
        format!("/v1/task-events?repoId=repo%201&timeoutSecs={MAX_WAIT_TIMEOUT_SECS}&limit=5"),
        "an over-long window must be clamped before the client can kill the call"
    );
}

/// The tool description is the only documentation an agent reads before
/// deciding whether the feed answers its question, so every event type the
/// server can emit has to be named there.
#[test]
fn wait_events_documents_every_event_type_the_server_emits() {
    let catalog = bundled_catalog();
    let description = &catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_wait_events")
        .expect("wait events tool")
        .description;

    for event_type in [
        "task.created",
        "run.started",
        "run.finished",
        "stage.changed",
        "task.pr_created",
        "task.revision_requested",
        "task.closed",
        "task.awaiting_input",
    ] {
        assert!(
            description.contains(event_type),
            "kanna_wait_events must document the {event_type} event"
        );
    }
}

// The window-vs-client-budget invariant itself is a compile-time assertion in
// the crate: a wait longer than the client's tools/call timeout is killed
// before it can answer, so it must not be expressible.

#[test]
fn wait_defaults_to_the_bounded_window_without_arguments() {
    let catalog = bundled_catalog();

    let wait = resolve_request(&catalog, "kanna_wait_task", &json!({ "task_id": "task-1" }))
        .expect("wait task")
        .wait
        .expect("wait spec");

    assert_eq!(wait.timeout_secs, DEFAULT_WAIT_TIMEOUT_SECS);
    assert!(wait.timeout_secs < CLIENT_TOOL_CALL_BUDGET_SECS);
    assert_eq!(wait.until, WaitUntil::Finished);
}

/// The cap lives in code, not only in `catalog.json`: `.kanna/mcp-tools.json`
/// overrides the bundled catalog, and an override that asks for a window the
/// client will kill must still be clamped.
#[test]
fn override_catalog_cannot_reintroduce_an_unsurvivable_wait_window() {
    let catalog: Catalog = serde_json::from_str(
        r#"{
          "tools": [{
            "name": "kanna_wait_task",
            "description": "Wait",
            "method": "GET",
            "path": "/v1/tasks/{task_id}",
            "response": "wait",
            "params": [
              { "name": "task_id", "description": "Task id.", "type": "string", "required": true, "location": "path" },
              { "name": "timeout_secs", "description": "Seconds.", "type": "integer", "required": false, "location": "body", "default": 3600, "max": 3600 }
            ]
          }]
        }"#,
    )
    .expect("override catalog parses");

    let defaulted = resolve_request(&catalog, "kanna_wait_task", &json!({ "task_id": "task-1" }))
        .expect("wait task")
        .wait
        .expect("wait spec");
    let explicit = resolve_request(
        &catalog,
        "kanna_wait_task",
        &json!({ "task_id": "task-1", "timeout_secs": 3600 }),
    )
    .expect("wait task")
    .wait
    .expect("wait spec");

    assert_eq!(defaulted.timeout_secs, MAX_WAIT_TIMEOUT_SECS);
    assert_eq!(explicit.timeout_secs, MAX_WAIT_TIMEOUT_SECS);
    assert_eq!(clamp_wait_timeout_secs(3600), MAX_WAIT_TIMEOUT_SECS);
    assert_eq!(clamp_wait_timeout_secs(30), 30);
}

#[test]
fn wait_results_carry_the_task_detail_and_an_outcome_discriminator() {
    let task = json!({ "id": "task-1", "stage": "review", "activity": "running" });

    let resolved = wait_resolved_result(task.clone());
    assert_eq!(resolved["waitOutcome"], json!("resolved"));
    assert_eq!(resolved["id"], json!("task-1"));
    assert_eq!(resolved["stage"], json!("review"));
    assert!(resolved["waitHint"].is_null());

    let timed_out = wait_timeout_result(task, "task-1", MAX_WAIT_TIMEOUT_SECS);
    assert_eq!(timed_out["waitOutcome"], json!("timeout"));
    assert_eq!(timed_out["waitTimeoutSecs"], json!(MAX_WAIT_TIMEOUT_SECS));
    assert_eq!(
        timed_out["id"],
        json!("task-1"),
        "a timed-out wait must still hand back the task state it polled"
    );
    assert_eq!(timed_out["stage"], json!("review"));
    let hint = timed_out["waitHint"].as_str().expect("wait hint");
    assert!(hint.contains("call kanna_wait_task again"), "{hint}");
}

#[test]
fn create_task_maps_agent_override_into_the_request_body() {
    let catalog = bundled_catalog();
    let request = resolve_request(
        &catalog,
        "kanna_create_task",
        &json!({
            "repo_id": "repo-1",
            "prompt": "Specialty review dispatched from task parent-1.",
            "pipeline_name": "specialty-review",
            "agent": "review-security",
            "base_ref": "task-parent-1-2",
            "parent_task_id": "parent-1",
            "notify_task_id": "parent-1"
        }),
    )
    .expect("dispatcher-style create-task call resolves");

    assert_eq!(request.method, Method::Post);
    assert_eq!(request.path, "/v1/tasks");
    assert_eq!(
        request.body,
        json!({
            "repoId": "repo-1",
            "prompt": "Specialty review dispatched from task parent-1.",
            "pipelineName": "specialty-review",
            "agent": "review-security",
            "baseRef": "task-parent-1-2",
            "agentType": "pty",
            "parentTaskId": "parent-1",
            "notifyTaskId": "parent-1"
        })
    );
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
    let unknown_tool = resolve_request(&catalog, "kanna_unknown", &json!({}))
        .expect_err("unknown tool should fail");
    assert!(unknown_tool.starts_with("unknown tool: kanna_unknown"));
    assert!(
        unknown_tool.contains("available tools: kanna_list_repos,"),
        "unknown tool error should list available tools: {unknown_tool}"
    );
}

#[test]
fn type_mismatch_and_unknown_argument_errors_are_actionable() {
    let catalog = bundled_catalog();

    assert_eq!(
        resolve_request(&catalog, "kanna_get_task", &json!({ "task_id": 7 })),
        Err("task_id must be a string".to_string())
    );

    let unknown_arg = resolve_request(
        &catalog,
        "kanna_close_task",
        &json!({ "task_id": "task-1", "force": true }),
    )
    .expect_err("unknown argument should fail");
    assert_eq!(
        unknown_arg,
        "unknown argument: force (kanna_close_task accepts: task_id)"
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

#[test]
fn display_name_documents_the_prompt_fallback_rather_than_a_derivation() {
    // Nothing derives a title from the prompt: an omitted display_name leaves
    // the task titled by the prompt text itself. Describing it as a derivation
    // is what made template-driven fan-outs (the QA dispatcher's specialty
    // children) safe-looking to dispatch unnamed, and they all rendered alike.
    let catalog = bundled_catalog();
    let description = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_create_task")
        .expect("create task")
        .params
        .iter()
        .find(|param| param.name == "display_name")
        .expect("display_name param")
        .description
        .clone()
        .expect("display_name description");

    assert!(
        description.contains("falls back to the prompt text"),
        "display_name must document the prompt fallback: {description}"
    );
    assert!(
        !description.contains("derived from the prompt"),
        "display_name must not promise a derivation: {description}"
    );
}

/// The catalog, not the shape of the text, decides a command-line argument's
/// type. Every declared parameter must round-trip its own CLI spelling: a
/// string stays a string however numeric it looks, and an integer is still an
/// integer when it arrives as text.
#[test]
fn declared_types_decide_cli_argument_parsing_not_the_text() {
    let catalog = bundled_catalog();

    let task_id = catalog
        .find_param("kanna_get_task", "task_id")
        .expect("task_id param");
    assert_eq!(task_id.param_type, ParamType::String);
    assert_eq!(
        task_id.parse_cli_value("57808275").unwrap(),
        json!("57808275")
    );
    assert_eq!(
        task_id.parse_cli_value("5ad2bc89").unwrap(),
        json!("5ad2bc89")
    );
    // A value that parses as JSON of another type is still just text.
    assert_eq!(task_id.parse_cli_value("true").unwrap(), json!("true"));
    assert_eq!(
        task_id.parse_cli_value("{\"a\":1}").unwrap(),
        json!("{\"a\":1}")
    );

    let timeout = catalog
        .find_param("kanna_wait_task", "timeout_secs")
        .expect("timeout_secs param");
    assert_eq!(timeout.param_type, ParamType::Integer);
    assert_eq!(timeout.parse_cli_value("30").unwrap(), json!(30));
    assert_eq!(
        timeout.parse_cli_value("soon").unwrap_err(),
        "timeout_secs must be an unsigned integer, got soon"
    );

    let blockers = catalog
        .find_param("kanna_block_task", "blocker_task_ids")
        .expect("blocker_task_ids param");
    assert_eq!(blockers.param_type, ParamType::StringArray);
    assert_eq!(
        blockers.parse_cli_value("1234, ab12cd").unwrap(),
        json!(["1234", "ab12cd"])
    );
    assert_eq!(
        blockers.parse_cli_value(r#"["1234","ab12cd"]"#).unwrap(),
        json!(["1234", "ab12cd"])
    );
    assert!(blockers
        .parse_cli_value("[1234]")
        .unwrap_err()
        .contains("array of strings"));

    let metadata = catalog
        .find_param("kanna_complete_stage", "metadata")
        .expect("metadata param");
    assert_eq!(metadata.param_type, ParamType::Object);
    assert_eq!(
        metadata
            .parse_cli_value(r#"{"pr_url":"https://example.invalid/pull/1"}"#)
            .unwrap(),
        json!({ "pr_url": "https://example.invalid/pull/1" })
    );
    assert!(metadata
        .parse_cli_value("nope")
        .unwrap_err()
        .contains("must be a JSON object"));

    assert!(catalog.find_param("kanna_get_task", "depth").is_none());
    assert!(catalog
        .find_param("kanna_no_such_tool", "task_id")
        .is_none());
}

/// Every parameter the catalog declares must survive its own CLI spelling and
/// then pass `resolve_request` — the check that failed for all-digit task ids.
#[test]
fn every_declared_parameter_round_trips_a_cli_spelling() {
    for tool in bundled_catalog().tools {
        for param in &tool.params {
            let raw = match param.param_type {
                ParamType::String => param
                    .enum_values
                    .as_ref()
                    .and_then(|values| values.first().cloned())
                    .unwrap_or_else(|| "57808275".to_string()),
                ParamType::Integer => "7".to_string(),
                ParamType::StringArray => "57808275".to_string(),
                ParamType::Object => "{}".to_string(),
            };
            let value = param
                .parse_cli_value(&raw)
                .unwrap_or_else(|e| panic!("{}.{} rejected {raw}: {e}", tool.name, param.name));
            let expected_type_ok = match param.param_type {
                ParamType::String => value.is_string(),
                ParamType::Integer => value.is_u64(),
                ParamType::StringArray => value.is_array(),
                ParamType::Object => value.is_object(),
            };
            assert!(
                expected_type_ok,
                "{}.{} parsed {raw} as {value}",
                tool.name, param.name
            );
        }

        let args = tool
            .params
            .iter()
            .map(|param| {
                let raw = match param.param_type {
                    ParamType::String => param
                        .enum_values
                        .as_ref()
                        .and_then(|values| values.first().cloned())
                        .unwrap_or_else(|| "57808275".to_string()),
                    ParamType::Integer => "7".to_string(),
                    ParamType::StringArray => "57808275".to_string(),
                    ParamType::Object => "{}".to_string(),
                };
                (
                    param.name.clone(),
                    param.parse_cli_value(&raw).expect("cli value"),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        resolve_request(
            &bundled_catalog(),
            &tool.name,
            &serde_json::Value::Object(args),
        )
        .unwrap_or_else(|e| panic!("{} rejected its own CLI spelling: {e}", tool.name));
    }
}
