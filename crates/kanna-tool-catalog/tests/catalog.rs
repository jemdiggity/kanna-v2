use kanna_tool_catalog::{
    args_with_self_exclusion, bundled_catalog, clamp_wait_timeout_secs, repo_context_task_id,
    resolve_request, resolve_request_with_repo_context, runtime_info_snapshot,
    task_event_self_exclusion, task_value_matches_wait_until, wait_resolved_result,
    wait_timeout_result, Catalog, Method, ParamLoc, ParamType, ResponseKind,
    RuntimeAdapterIdentity, WaitUntil, CLIENT_TOOL_CALL_BUDGET_SECS, DEFAULT_WAIT_TIMEOUT_SECS,
    MAX_WAIT_TIMEOUT_SECS,
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
            "kanna_info",
            "kanna_list_machines",
            "kanna_guide",
            "kanna_list_repos",
            "kanna_add_repo",
            "kanna_reconcile_repo_metadata",
            "kanna_list_recent_tasks",
            "kanna_get_task",
            "kanna_list_task_children",
            "kanna_wait_task",
            "kanna_wait_events",
            "kanna_notify_mobile",
            "kanna_set_task_workflow",
            "kanna_task_logs",
            "kanna_task_inputs",
            "kanna_search_tasks",
            "kanna_list_repo_tasks",
            "kanna_list_agents",
            "kanna_create_task",
            "kanna_signal_agent",
            "kanna_signal_merge_handoff",
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
fn bundled_guides_are_topic_addressable_and_drive_schema_descriptions() {
    let catalog = bundled_catalog();
    assert_eq!(
        catalog.guide_topics(),
        vec!["config", "workflows", "agents", "tasks"]
    );
    let config = catalog.render_guide("config").expect("config guide");
    assert!(config.contains("# Kanna Repository Configuration"));
    assert!(config.contains("arrays never concatenate"));
    assert!(config.contains("layer-coherent"));
    assert!(catalog
        .render_guide("workflows")
        .expect("workflow guide")
        .contains("Visibility belongs to the effective definition"));
    assert!(catalog
        .render_guide("agents")
        .expect("agent guide")
        .contains("EXTEND.md"));

    let request = resolve_request(&catalog, "kanna_guide", &json!({ "topic": "config" }))
        .expect("resolve guide");
    assert_eq!(request.kind, ResponseKind::Guide);
    assert!(request
        .local_response
        .is_some_and(|response| response["content"]
            .as_str()
            .is_some_and(|content| content.contains("Kanna Repository Configuration"))));
    assert!(catalog
        .config_schema_descriptions()
        .contains_key("/properties/agentProviders"));
}

#[test]
fn checked_in_config_schema_descriptions_match_catalog_guides() {
    let schema_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.kanna/config.schema.json");
    let schema: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(schema_path).expect("read checked-in config schema"),
    )
    .expect("parse checked-in config schema");

    for (pointer, description) in bundled_catalog().config_schema_descriptions() {
        let node = if pointer.is_empty() {
            &schema
        } else {
            schema
                .pointer(pointer)
                .unwrap_or_else(|| panic!("catalog guide references missing schema path {pointer}"))
        };
        assert_eq!(
            node["description"],
            json!(description),
            "schema description at {pointer} drifted from the catalog guide"
        );
    }
}

#[test]
fn generated_schema_preserves_required_order_types_and_enums() {
    let tools = bundled_catalog().tools_list_value();
    let info = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_info")
        .expect("info tool");
    assert_eq!(
        info["inputSchema"]["properties"]["machine_id"]["type"],
        json!("string")
    );
    assert_eq!(info["annotations"], json!({ "readOnlyHint": true }));

    let list_task_children = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_list_task_children")
        .expect("list task children tool");
    assert_eq!(
        list_task_children["annotations"],
        json!({ "readOnlyHint": true })
    );
    assert_eq!(
        list_task_children["inputSchema"]["required"],
        json!(["task_id"])
    );
    assert_eq!(
        list_task_children["inputSchema"]["properties"]["task_id"]["type"],
        json!("string")
    );
    assert!(
        list_task_children["description"]
            .as_str()
            .is_some_and(|description| description.contains("workflowName")),
        "list-task-children must document the workflow identity used to classify runless children"
    );

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
    assert_eq!(
        create_task["inputSchema"]["properties"]["effort"]["description"],
        json!("Provider-native reasoning effort passed without normalization. Codex uses model_reasoning_effort and validates against the selected model; Claude uses --effort (low|medium|high|xhigh|max); Copilot uses --effort (none|minimal|low|medium|high|xhigh|max); OpenCode uses --variant and validates against the selected model; Antigravity uses --effort (low|medium|high). Explicit task effort overrides repo agentProviders effort, then layered agent-definition frontmatter.")
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

    let complete_stage = tools
        .as_array()
        .expect("tools array")
        .iter()
        .find(|tool| tool["name"] == "kanna_complete_stage")
        .expect("complete stage tool");
    assert!(complete_stage["inputSchema"]["properties"]["machine_id"].is_null());
}

#[test]
fn task_input_and_resume_descriptions_document_delivery_and_recovery_contracts() {
    let tools = bundled_catalog().tools_list_value();
    let tools = tools.as_array().expect("tools array");
    let description = |name: &str| {
        tools
            .iter()
            .find(|tool| tool["name"] == name)
            .and_then(|tool| tool["description"].as_str())
            .unwrap_or_else(|| panic!("missing description for {name}"))
    };

    let send_input = description("kanna_send_task_input");
    for required in [
        "live daemon PTY session",
        "PTY process ID",
        "queues the logical message FIFO",
        "daemon handoff",
        "never carried into a later run or stage",
        "no_live_agent_session",
        "kanna_resume_task",
        "kanna_rerun_stage",
        // A refusal a caller cannot tell from a transient fault is a caller
        // that retries forever against a session only a human can unblock.
        "input_blocked",
        "retrying changes nothing",
        // A held message was accepted but not delivered. A caller that cannot
        // name this outcome resends and queues a second copy of a message the
        // daemon already holds.
        "input_held_by_draft",
        "do not send it again",
    ] {
        assert!(
            send_input.contains(required),
            "send-task-input must document `{required}`"
        );
    }

    // Both signal tools reach the same daemon refusal through
    // signal_agent.rs, so both have to name it where they name their others.
    for name in ["kanna_signal_agent", "kanna_signal_merge_handoff"] {
        assert!(
            description(name).contains("input_held_by_draft"),
            "{name} must document `input_held_by_draft`"
        );
    }

    let resume = description("kanna_resume_task");
    for required in [
        "cancelled or failed",
        "resumeFallbackReason",
        "older server",
        "kanna_rerun_stage",
    ] {
        assert!(
            resume.contains(required),
            "resume-task must document `{required}`"
        );
    }
}

#[test]
fn runtime_info_snapshot_allow_lists_status_and_keeps_identity_boundaries_separate() {
    let info = runtime_info_snapshot(
        "http://127.0.0.1:49199",
        RuntimeAdapterIdentity {
            name: "kanna-mcp",
            version: "0.1.0",
            mcp_protocol_version: Some("2025-11-25"),
            task_id: Some("task-safe"),
        },
        Ok(json!({
            "state": "running",
            "desktopId": "desktop-safe",
            "desktopName": "Safe Mac",
            "version": "9.8.7-staging.1",
            "environment": "staging",
            "serverVersion": "ignored-alias",
            "lanHost": "10.0.0.4",
            "lanPort": 48121,
            "pairingCode": "PAIR-SECRET",
            "kspStreamVersion": 2,
            "writePathHealth": {
                "healthy": true,
                "status": "healthy",
                "activeWorkspaceCommands": 0,
                "maxWorkspaceCommands": 4,
                "longRunningWorkspaceCommands": 0,
                "oldestWorkspaceCommandSeconds": null
            },
            "authToken": "AUTH-SECRET",
            "databasePath": "/private/kanna.db"
        })),
        &["kanna_info".to_string()],
    );

    assert_eq!(
        info["connection"]["effectiveBaseUrl"],
        "http://127.0.0.1:49199"
    );
    assert_eq!(info["connection"]["port"], 49199);
    assert_eq!(info["serverStatus"]["environment"], "staging");
    assert_eq!(info["serverStatus"]["version"], "9.8.7-staging.1");
    assert_eq!(
        info["lanAdvertisedEndpoint"],
        json!({ "host": "10.0.0.4", "port": 48121 })
    );
    assert_eq!(info["taskContext"]["taskId"], "task-safe");
    let rendered = info.to_string();
    for forbidden in [
        "PAIR-SECRET",
        "AUTH-SECRET",
        "/private/kanna.db",
        "pairingCode",
    ] {
        assert!(!rendered.contains(forbidden), "leaked {forbidden}");
    }
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
fn removed_approval_override_is_not_an_agent_tool() {
    let catalog = bundled_catalog();

    assert!(catalog
        .tools
        .iter()
        .all(|tool| tool.name != "kanna_override_approval"));
    let advance = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_advance_stage")
        .expect("advance tool");
    assert_eq!(advance.params.len(), 3);
    assert_eq!(advance.params[0].name, "machine_id");
    assert_eq!(advance.params[0].location, ParamLoc::Routing);
    assert_eq!(advance.params[1].name, "task_id");
    assert_eq!(advance.params[2].name, "source");
    assert_eq!(advance.params[2].location, ParamLoc::Body);
}

#[test]
fn resolves_expected_requests_for_every_bundled_tool() {
    let catalog = bundled_catalog();
    let cases = [
        (
            "kanna_info",
            json!({}),
            Method::Get,
            ResponseKind::RuntimeInfo,
            "/v1/status",
            json!({}),
        ),
        (
            "kanna_list_machines",
            json!({}),
            Method::Get,
            ResponseKind::Json,
            "/v1/cloud/desktops",
            json!({}),
        ),
        (
            "kanna_guide",
            json!({ "topic": "config" }),
            Method::Get,
            ResponseKind::Guide,
            "",
            json!({ "topic": "config" }),
        ),
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
            "/v1/tasks/task%201?agentView=true",
            json!({}),
        ),
        (
            "kanna_list_task_children",
            json!({ "task_id": "task 1" }),
            Method::Get,
            ResponseKind::Json,
            "/v1/tasks/task%201/children",
            json!({}),
        ),
        (
            "kanna_task_logs",
            json!({ "task_id": "task 1", "tail": 25 }),
            Method::Get,
            ResponseKind::Text,
            "/v1/tasks/task%201/logs?tail=25&agentView=true",
            json!({}),
        ),
        (
            "kanna_task_inputs",
            json!({ "task_id": "task 1", "tail": 25 }),
            Method::Get,
            ResponseKind::Json,
            "/v1/tasks/task%201/inputs?tail=25",
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
                "effort": "xhigh",
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
                "effort": "xhigh",
                "blockerTaskIds": ["blocker-1", "blocker-2"]
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
            "kanna_signal_merge_handoff",
            json!({
                "task_id": "task-1",
                "branch": "task-task-1-4",
                "target": "main",
                "pr_url": "https://example.invalid/pull/1",
                "summary": "approved"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/signal-merge-handoff",
            json!({
                "branch": "task-task-1-4",
                "target": "main",
                "prUrl": "https://example.invalid/pull/1",
                "summary": "approved"
            }),
        ),
        (
            "kanna_signal_agent",
            json!({
                "repo_id": "repo-1",
                "agent": "merge",
                "message": "MERGE task-1 -> main: ready",
                "agent_provider": "claude",
                "effort": "high"
            }),
            Method::Post,
            ResponseKind::Json,
            "/v1/repos/repo-1/agents/merge/signal",
            json!({
                "message": "MERGE task-1 -> main: ready",
                "agentProvider": "claude",
                "effort": "high"
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
            json!({ "task_id": "task-1", "source": "manager" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-1/actions/advance-stage",
            json!({ "source": "manager" }),
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
            "kanna_set_task_workflow",
            json!({ "task_id": "task-child", "workflow_name": "single-reviewer" }),
            Method::Post,
            ResponseKind::Json,
            "/v1/tasks/task-child/actions/set-workflow",
            json!({ "workflowName": "single-reviewer" }),
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
        assert_eq!(request.machine_id, None, "{name}");
    }

    let routed = resolve_request(
        &catalog,
        "kanna_get_task",
        &json!({ "machine_id": "desktop-studio", "task_id": "task-1" }),
    )
    .expect("routed task");
    assert_eq!(routed.machine_id.as_deref(), Some("desktop-studio"));
    assert_eq!(routed.path, "/v1/tasks/task-1?agentView=true");
    assert_eq!(routed.body, json!({}));

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
        format!("/v1/task-events?taskIds=task-a%2Ctask-b&shortCursor=true&cursor=42&timeoutSecs={DEFAULT_WAIT_TIMEOUT_SECS}")
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
        format!("/v1/task-events?repoId=repo%201&shortCursor=true&timeoutSecs={MAX_WAIT_TIMEOUT_SECS}&limit=5"),
        "an over-long window must be clamped before the client can kill the call"
    );

    // The scope a fan-out can name after losing the ids it created. Without it
    // the only alternative is the whole repo, and the caller filters the noise.
    let parent_scoped = resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "parent_task_id": "parent 1" }),
    )
    .expect("wait events")
    .path;
    assert_eq!(
        parent_scoped,
        format!("/v1/task-events?parentTaskId=parent%201&shortCursor=true&timeoutSecs={DEFAULT_WAIT_TIMEOUT_SECS}")
    );
    let description = &catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_wait_events")
        .expect("wait events tool")
        .description;
    assert!(
        description.contains("short cursor handle")
            && description.contains("constant-size cursor")
            && description.contains("read checkpoint")
            && description.contains("never rewinds acknowledged events")
            && description.contains("without cursor growth"),
        "the parent scope must document its bounded reparenting semantics: {description}"
    );
    assert!(
        description.contains("kanna-cli task watch")
            && description.contains("clamped to 240 seconds")
            && description.contains("abort tools/call around 300 seconds"),
        "the MCP wait must route arbitrarily long watches to the CLI process: {description}"
    );
}

#[test]
fn task_session_repo_defaulting_is_shared_by_every_catalog_client() {
    let catalog = bundled_catalog();
    let current_task = json!({ "id": "manager-1", "repoId": "repo-current" });

    for (tool, args, expected_path) in [
        (
            "kanna_list_recent_tasks",
            json!({}),
            "/v1/tasks/recent?repoId=repo-current",
        ),
        (
            "kanna_search_tasks",
            json!({ "query": "review" }),
            "/v1/tasks/search?query=review&repoId=repo-current",
        ),
        (
            "kanna_wait_events",
            json!({ "from": "now", "timeout_secs": 0 }),
            "/v1/task-events?repoId=repo-current&shortCursor=true&from=now&timeoutSecs=0",
        ),
    ] {
        assert_eq!(
            repo_context_task_id(tool, &args, Some("manager-1"), None),
            Ok(Some("manager-1".to_string()))
        );
        assert_eq!(
            resolve_request_with_repo_context(&catalog, tool, &args, Some(&current_task))
                .expect("resolve inferred repository request")
                .path,
            expected_path
        );
    }

    let create_args = json!({ "prompt": "child work" });
    assert_eq!(
        repo_context_task_id("kanna_create_task", &create_args, Some("manager-1"), None),
        Ok(Some("manager-1".to_string()))
    );
    assert_eq!(
        resolve_request_with_repo_context(
            &catalog,
            "kanna_create_task",
            &create_args,
            Some(&current_task)
        )
        .expect("resolve inferred create")
        .body["repoId"],
        "repo-current"
    );
}

#[test]
fn explicit_repository_and_machine_wide_scopes_win_over_task_context() {
    let catalog = bundled_catalog();
    let explicit = resolve_request_with_repo_context(
        &catalog,
        "kanna_wait_events",
        &json!({ "repo_id": "repo-explicit" }),
        Some(&json!({ "repoId": "repo-current" })),
    )
    .expect("resolve explicit repository");
    assert!(explicit.path.contains("repoId=repo-explicit"));

    for (tool, args) in [
        ("kanna_wait_events", json!({ "repo_id": "repo-explicit" })),
        (
            "kanna_wait_events",
            json!({ "repo_remote_url_hash": "remote-hash" }),
        ),
        ("kanna_wait_events", json!({ "task_ids": ["task-a"] })),
        ("kanna_wait_events", json!({ "parent_task_id": "parent-a" })),
        ("kanna_list_recent_tasks", json!({ "all_repos": true })),
        (
            "kanna_search_tasks",
            json!({ "query": "x", "all_machines": true }),
        ),
    ] {
        assert_eq!(
            repo_context_task_id(tool, &args, Some("manager-1"), None),
            Ok(None),
            "{tool} should preserve its explicit scope"
        );
    }

    let error = repo_context_task_id(
        "kanna_wait_events",
        &json!({}),
        Some("manager-1"),
        Some("desktop-peer"),
    )
    .expect_err("a local task repo id cannot scope a remote machine");
    assert!(error.contains("repo_id is required"));
    assert!(error.contains("desktop-peer"));
    assert!(error.contains("repository IDs are machine-local"));
}

/// `parentTaskId` upward and `childTaskIds` downward are the same relation read
/// from both ends. An agent that only ever hears about the upward half has no
/// way back to a child it forgot, so the tool description has to name the
/// downward half and say that closed children are in it.
#[test]
fn get_task_documents_the_downward_view_of_parentage() {
    let catalog = bundled_catalog();
    let description = &catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_get_task")
        .expect("get task tool")
        .description;

    assert!(
        description.contains("childTaskIds"),
        "kanna_get_task must document childTaskIds: {description}"
    );
    assert!(
        description.contains("closed"),
        "kanna_get_task must say closed children are included, or an empty list \
         reads as 'nothing was dispatched': {description}"
    );
}

/// An agent supervising tasks reads only the tool description before deciding
/// which field answers "is this task alive?". Naming `activity` without saying
/// what it blends is what produced false quiet alarms against running agents.
#[test]
fn get_task_documents_both_state_dimensions_and_which_one_means_alive() {
    let catalog = bundled_catalog();
    let description = &catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_get_task")
        .expect("get task tool")
        .description;

    for field in ["runtimeState", "readState", "activity"] {
        assert!(
            description.contains(field),
            "kanna_get_task must document {field}: {description}"
        );
    }
    for value in ["busy", "waiting", "idle", "exited"] {
        assert!(
            description.contains(value),
            "kanna_get_task must name the runtime value {value}: {description}"
        );
    }
    assert!(
        description.contains("blend"),
        "kanna_get_task must say activity blends the two dimensions rather than          reporting either: {description}"
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
        "task.activity_changed",
        "task.merge_signaled",
        "task.merge_handoff_missing",
        "task.input_delivered",
        "task.input_blocked",
        "task.transfer_finalizing",
    ] {
        assert!(
            description.contains(event_type),
            "kanna_wait_events must document the {event_type} event"
        );
    }

    assert!(
        description.contains("server-debounced")
            && description.contains("every activity direction")
            && description.contains("latestRunFinishedWithoutCompletion")
            && description.contains("no waiting-prompt placeholder")
            && description.contains("follow-up polling"),
        "kanna_wait_events must document the complete provider-neutral settled activity contract: {description}"
    );
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
fn create_task_preserves_parent_for_genuine_dispatch_fan_out() {
    let catalog = bundled_catalog();
    let request = resolve_request(
        &catalog,
        "kanna_create_task",
        &json!({
            "repo_id": "repo-1",
            "prompt": "Specialty review dispatched from task parent-1.",
            "workflow_name": "specialty-review",
            "agent": "review-security",
            "base_ref": "task-parent-1-2",
            "parent_task_id": "parent-1"
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
            "workflowName": "specialty-review",
            "agent": "review-security",
            "baseRef": "task-parent-1-2",
            "agentType": "pty",
            "parentTaskId": "parent-1"
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
        unknown_tool.contains(
            "available tools: kanna_info, kanna_list_machines, kanna_guide, kanna_list_repos,"
        ),
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
        "unknown argument: force (kanna_close_task accepts: machine_id, task_id)"
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
    assert_eq!(loaded.catalog.tools[0].name, "kanna_info");
    assert_eq!(loaded.catalog.tools[1].name, "kanna_list_machines");
    assert_eq!(loaded.catalog.tools[2].name, "kanna_guide");
    assert_eq!(loaded.catalog.tools[3].name, "kanna_test_tool");
    assert_eq!(
        loaded.catalog.guide_topics(),
        vec!["config", "workflows", "agents", "tasks"]
    );
    assert_eq!(
        loaded.watch_source.as_deref(),
        Some(override_path.as_path())
    );
    assert_eq!(loaded.warning, None);

    fs::write(&override_path, "{").expect("write invalid override");
    let loaded = kanna_tool_catalog::load_catalog(&root);
    assert!(loaded.warning.expect("warning").contains("failed to parse"));
    assert_eq!(loaded.catalog.tools[0].name, "kanna_info");
    assert_eq!(
        loaded.watch_source.as_deref(),
        Some(override_path.as_path())
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn catalog_override_cannot_replace_safe_kanna_info_declaration() {
    let root = std::env::temp_dir().join(format!(
        "kanna-tool-catalog-info-override-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".kanna")).expect("create .kanna");
    fs::write(
        root.join(".kanna/mcp-tools.json"),
        r#"{
          "tools": [{
            "name": "kanna_info",
            "description": "Unsafe raw status passthrough",
            "method": "GET",
            "path": "/v1/status",
            "response": "json",
            "params": [{
              "name": "leak",
              "type": "string",
              "required": false,
              "location": "query"
            }]
          }]
        }"#,
    )
    .expect("write override");

    let loaded = kanna_tool_catalog::load_catalog(&root);
    let info = loaded.catalog.tools.first().expect("required info tool");
    assert_eq!(info.name, "kanna_info");
    assert_eq!(info.path, "/v1/status");
    assert_eq!(info.response_kind, ResponseKind::RuntimeInfo);
    assert_eq!(info.params.len(), 1);
    assert_eq!(info.params[0].name, "machine_id");
    assert_eq!(info.params[0].location, ParamLoc::Routing);
    assert!(info.description.contains("authoritative server"));

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

#[test]
fn task_creation_guidance_uses_wait_surfaces_and_semantic_hierarchy() {
    let catalog = bundled_catalog();
    let create = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "kanna_create_task")
        .expect("create task");
    let description = create.description.as_str();
    let parent = create
        .params
        .iter()
        .find(|param| param.name == "parent_task_id")
        .and_then(|param| param.description.as_deref())
        .expect("parent_task_id description");
    assert!(description.contains("Ordinary durable repository work is top-level by default"));
    assert!(description.contains("Observe completion through kanna_wait_events"));
    assert!(parent.contains("genuine semantic subtask"));
    assert!(parent.contains("Omit for ordinary top-level work"));
    assert!(create
        .params
        .iter()
        .all(|param| param.name != "notify_task_id"));

    let error = resolve_request(
        &catalog,
        "kanna_create_task",
        &json!({
            "repo_id": "repo-1",
            "prompt": "Investigate flaky staging release",
            "notify_task_id": "task-manager-1"
        }),
    )
    .expect_err("retired notify_task_id must not resolve");
    assert!(
        error.contains("unknown argument: notify_task_id"),
        "{error}"
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
                ParamType::Boolean => "true".to_string(),
                ParamType::StringArray => "57808275".to_string(),
                ParamType::Object => "{}".to_string(),
            };
            let value = param
                .parse_cli_value(&raw)
                .unwrap_or_else(|e| panic!("{}.{} rejected {raw}: {e}", tool.name, param.name));
            let expected_type_ok = match param.param_type {
                ParamType::String => value.is_string(),
                ParamType::Integer => value.is_u64(),
                ParamType::Boolean => value.is_boolean(),
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
                    ParamType::Boolean => "true".to_string(),
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

/// The wait predicate that `kanna_wait_task` resolves on. `Finished` means a
/// termination was recorded — never that a display value happens to read
/// `unread`, which an actively working task whose output nobody read also
/// carries.
#[test]
fn finished_is_decided_by_a_recorded_termination_not_the_activity_flag() {
    let finished_but_idle = json!({
        "activity": "idle",
        "runtimeState": "idle",
        "closedAt": null,
        "latestRun": { "status": "failed" },
    });
    assert!(
        task_value_matches_wait_until(&finished_but_idle, WaitUntil::Finished),
        "a terminal stage run means finished whatever activity settled to"
    );
    assert!(
        !task_value_matches_wait_until(&finished_but_idle, WaitUntil::Closed),
        "finished is not closed"
    );

    // `idle` on its own is also what a task that has not started its first run
    // looks like, so it must not resolve by itself — on either dimension.
    let never_started = json!({
        "activity": "idle",
        "runtimeState": null,
        "closedAt": null,
        "latestRun": null,
    });
    assert!(!task_value_matches_wait_until(
        &never_started,
        WaitUntil::Finished
    ));
    let parked_at_composer = json!({
        "activity": "idle",
        "runtimeState": "idle",
        "closedAt": null,
        "latestRun": null,
    });
    assert!(!task_value_matches_wait_until(
        &parked_at_composer,
        WaitUntil::Finished
    ));

    let still_running = json!({
        "activity": "working",
        "runtimeState": "busy",
        "closedAt": null,
        "latestRun": { "status": "running" },
    });
    assert!(!task_value_matches_wait_until(
        &still_running,
        WaitUntil::Finished
    ));

    // `cancelled` is the transient state a rerun, resume, or close passes
    // through on the way to a replacement run, so it is not terminal.
    let cancelled = json!({
        "activity": "idle",
        "runtimeState": "busy",
        "closedAt": null,
        "latestRun": { "status": "cancelled" },
    });
    assert!(!task_value_matches_wait_until(
        &cancelled,
        WaitUntil::Finished
    ));

    // The regression this predicate exists to prevent: an agent that is busy
    // inside a long call, whose latest output the operator has not read. The
    // display value says `unread` on both, and only the runtime dimension
    // tells them apart.
    let busy_but_unread = json!({
        "activity": "unread",
        "runtimeState": "busy",
        "closedAt": null,
        "latestRun": { "status": "running" },
    });
    assert!(
        !task_value_matches_wait_until(&busy_but_unread, WaitUntil::Finished),
        "unread is read state; a busy agent has not finished"
    );

    // An agent session that ended without recording a verdict is a
    // termination, and is what the old `unread` clause was standing in for. An
    // agent that parks without its process ending is not covered by it — see
    // `task_state_matches_wait_until`.
    let session_exited = json!({
        "activity": "unread",
        "runtimeState": "exited",
        "closedAt": null,
        "latestRun": { "status": "cancelled" },
    });
    assert!(task_value_matches_wait_until(
        &session_exited,
        WaitUntil::Finished
    ));
    assert!(!task_value_matches_wait_until(
        &session_exited,
        WaitUntil::Closed
    ));

    let closed = json!({ "activity": "idle", "closedAt": "2026-08-13T22:00:00Z" });
    assert!(task_value_matches_wait_until(&closed, WaitUntil::Finished));
    assert!(task_value_matches_wait_until(&closed, WaitUntil::Closed));
}

/// A server that predates the split sends no `runtimeState`. The wait must
/// still work off the terminal `stage_run`, and must not start resolving on
/// read state again to compensate.
#[test]
fn a_detail_without_the_runtime_dimension_falls_back_to_the_terminal_run() {
    let unread_only = json!({ "activity": "unread", "closedAt": null, "latestRun": null });
    assert!(!task_value_matches_wait_until(
        &unread_only,
        WaitUntil::Finished
    ));
    let terminal_run = json!({
        "activity": "unread",
        "closedAt": null,
        "latestRun": { "status": "succeeded" },
    });
    assert!(task_value_matches_wait_until(
        &terminal_run,
        WaitUntil::Finished
    ));
}

fn skew_info(server_status: serde_json::Value, client_tools: &[String]) -> serde_json::Value {
    runtime_info_snapshot(
        "http://127.0.0.1:49199",
        RuntimeAdapterIdentity {
            name: "kanna-mcp",
            version: "0.1.0",
            mcp_protocol_version: None,
            task_id: None,
        },
        Ok(server_status),
        client_tools,
    )
}

fn status_with(agent_api_tools: serde_json::Value) -> serde_json::Value {
    let mut status = json!({
        "state": "running",
        "desktopId": "desktop-1",
        "desktopName": "Mac",
        "version": "0.1.0",
        "environment": "development",
        "lanHost": "127.0.0.1",
        "lanPort": 48120,
    });
    if !agent_api_tools.is_null() {
        status["agentApiTools"] = agent_api_tools;
    }
    status
}

/// An agent whose instructions mandate a tool has to be able to tell "the
/// server says there are none" from "this server cannot be asked". Without
/// this, that difference only shows up as a 404, which is indistinguishable
/// from an ordinary not-found.
#[test]
fn kanna_info_reports_tools_the_connected_server_cannot_serve() {
    let client_tools = [
        "kanna_info".to_string(),
        "kanna_get_task".to_string(),
        "kanna_list_task_children".to_string(),
    ];

    let current = skew_info(
        status_with(json!([
            "kanna_info",
            "kanna_get_task",
            "kanna_list_task_children"
        ])),
        &client_tools,
    );
    assert_eq!(current["agentApi"]["status"], "current");
    assert_eq!(current["agentApi"]["unavailableTools"], json!([]));

    // The observed skew: a released app that predates `kanna_list_task_children`.
    let behind = skew_info(
        status_with(json!(["kanna_info", "kanna_get_task"])),
        &client_tools,
    );
    assert_eq!(behind["agentApi"]["status"], "server_behind");
    assert_eq!(
        behind["agentApi"]["unavailableTools"],
        json!(["kanna_list_task_children"])
    );

    // A server old enough not to advertise at all is itself the signal.
    let unknown = skew_info(status_with(json!(null)), &client_tools);
    assert_eq!(unknown["agentApi"]["status"], "unknown");
    assert_eq!(
        unknown["agentApi"]["serverAdvertisesCapabilities"],
        json!(false)
    );

    // An unreachable server reports `unknown` rather than omitting the block,
    // which would read as "no skew".
    let unreachable = runtime_info_snapshot(
        "http://127.0.0.1:49199",
        RuntimeAdapterIdentity {
            name: "kanna-mcp",
            version: "0.1.0",
            mcp_protocol_version: None,
            task_id: None,
        },
        Err("connection refused".to_string()),
        &client_tools,
    );
    assert_eq!(unreachable["agentApi"]["status"], "unknown");
}

/// Self-exclusion is catalog policy so `kanna-mcp` and `kanna-cli tool call`
/// cannot drift: a repository-scoped wait from inside a task session drops the
/// caller's own task, explicit task/parent scopes are taken literally, and
/// `include_self` is the documented way to opt out.
#[test]
fn wait_events_self_exclusion_is_shared_catalog_policy() {
    let catalog = bundled_catalog();

    let defaulted = args_with_self_exclusion(
        "kanna_wait_events",
        &json!({ "from": "now" }),
        Some("manager-1"),
    )
    .expect("apply policy");
    assert_eq!(defaulted["exclude_task_ids"], json!(["manager-1"]));
    let resolved = resolve_request_with_repo_context(
        &catalog,
        "kanna_wait_events",
        &defaulted,
        Some(&json!({ "repoId": "repo-current" })),
    )
    .expect("resolve defaulted wait");
    assert_eq!(
        resolved.path,
        "/v1/task-events?repoId=repo-current&excludeTaskIds=manager-1&shortCursor=true&from=now&timeoutSecs=240"
    );

    let explicit_repo = args_with_self_exclusion(
        "kanna_wait_events",
        &json!({ "repo_id": "repo-explicit", "exclude_task_ids": ["other", "manager-1"] }),
        Some("manager-1"),
    )
    .expect("apply policy");
    assert_eq!(
        explicit_repo["exclude_task_ids"],
        json!(["other", "manager-1"])
    );

    let remote_hash = args_with_self_exclusion(
        "kanna_wait_events",
        &json!({ "repo_remote_url_hash": "hash", "exclude_task_ids": ["other"] }),
        Some("manager-1"),
    )
    .expect("apply policy");
    assert_eq!(
        remote_hash["exclude_task_ids"],
        json!(["other", "manager-1"])
    );

    for repository_scope_with_empty_literal in [
        json!({ "repo_id": "repo-explicit", "task_ids": [] }),
        json!({ "repo_id": "repo-explicit", "task_ids": [" "] }),
        json!({ "repo_id": "repo-explicit", "parent_task_id": "" }),
        json!({ "repo_id": "repo-explicit", "parent_task_id": null }),
    ] {
        let filtered = args_with_self_exclusion(
            "kanna_wait_events",
            &repository_scope_with_empty_literal,
            Some("manager-1"),
        )
        .expect("apply policy");
        assert_eq!(
            filtered["exclude_task_ids"],
            json!(["manager-1"]),
            "empty literal scopes fall through to repository scope"
        );
    }

    for literal in [
        json!({ "task_ids": ["manager-1", "child-a"] }),
        json!({ "parent_task_id": "manager-1" }),
    ] {
        let unchanged = args_with_self_exclusion("kanna_wait_events", &literal, Some("manager-1"))
            .expect("apply policy");
        assert_eq!(unchanged, literal, "explicit scopes are taken literally");
    }

    let included = args_with_self_exclusion(
        "kanna_wait_events",
        &json!({ "repo_id": "repo-explicit", "include_self": true, "exclude_task_ids": ["other"] }),
        Some("manager-1"),
    )
    .expect("apply policy");
    assert_eq!(
        included,
        json!({ "repo_id": "repo-explicit", "exclude_task_ids": ["other"] })
    );

    let outside_session =
        args_with_self_exclusion("kanna_wait_events", &json!({ "repo_id": "repo-1" }), None)
            .expect("apply policy");
    assert_eq!(outside_session, json!({ "repo_id": "repo-1" }));

    let other_tool = args_with_self_exclusion(
        "kanna_list_recent_tasks",
        &json!({ "limit": 5 }),
        Some("manager-1"),
    )
    .expect("apply policy");
    assert_eq!(other_tool, json!({ "limit": 5 }));

    let error = args_with_self_exclusion(
        "kanna_wait_events",
        &json!({ "include_self": "yes" }),
        Some("manager-1"),
    )
    .expect_err("include_self must be boolean");
    assert!(error.contains("include_self must be a boolean"), "{error}");

    assert_eq!(
        task_event_self_exclusion(false, false, Some("  ")),
        None,
        "a blank task id is not a session"
    );
}

/// `include_self` is advertised and validated like every other argument but
/// never reaches the wire: the server has no notion of "self".
#[test]
fn include_self_is_a_client_only_parameter() {
    let catalog = bundled_catalog();
    let include_self = catalog
        .find_param("kanna_wait_events", "include_self")
        .expect("include_self declared");
    assert_eq!(include_self.location, ParamLoc::Client);
    assert_eq!(include_self.param_type, ParamType::Boolean);
    let exclude = catalog
        .find_param("kanna_wait_events", "exclude_task_ids")
        .expect("exclude_task_ids declared");
    assert_eq!(exclude.location, ParamLoc::Query);
    assert_eq!(exclude.param_type, ParamType::StringArray);
    assert_eq!(exclude.key.as_deref(), Some("excludeTaskIds"));

    let resolved = resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "repo_id": "repo-1", "include_self": true, "exclude_task_ids": ["a", "b"], "timeout_secs": 0 }),
    )
    .expect("resolve");
    assert_eq!(
        resolved.path,
        "/v1/task-events?repoId=repo-1&excludeTaskIds=a%2Cb&shortCursor=true&timeoutSecs=0"
    );

    let schema = bundled_catalog().tools_list_value();
    let wait_events = schema
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "kanna_wait_events")
        .expect("wait events tool");
    let properties = &wait_events["inputSchema"]["properties"];
    assert!(properties.get("include_self").is_some());
    assert!(properties.get("exclude_task_ids").is_some());
    assert!(wait_events["description"]
        .as_str()
        .expect("description")
        .contains("excludes the calling task's own events by default"));
}
