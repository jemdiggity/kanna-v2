use super::*;

fn assert_no_environment_sensitive_info_instruction(rendered: &str) {
    let normalized = rendered.replace('`', "").to_ascii_lowercase();

    for line in normalized.lines() {
        let mentions_environment_sensitive_operations =
            line.contains("environment-sensitive operation");
        let directs_info_lookup = line.contains("call kanna_info")
            || line.contains("call this")
            || line.contains("run kanna-cli info");

        assert!(
            !(mentions_environment_sensitive_operations && directs_info_lookup),
            "rendered guide must not direct ordinary tasks to identify Kanna runtime before environment-sensitive operations: {line}"
        );
    }
}

#[test]
fn guide_markdown_includes_live_context_and_all_catalog_tools() {
    let task = TaskDetail {
        id: "task-123".to_string(),
        repo_id: "repo-1".to_string(),
        title: "Review branch".to_string(),
        stage: Some("review".to_string()),
        workflow_name: Some("qa".to_string()),
        stage_transition: Some("auto".to_string()),
        activity: Some("working".to_string()),
        runtime_state: Some("busy".to_string()),
        read_state: Some("read".to_string()),
        waiting_prompt_snippet: None,
        agent_type: Some("pty".to_string()),
        agent_provider: Some("claude".to_string()),
        branch: Some("task-task-123".to_string()),
        pr_url: None,
        closed_at: None,
        worktree_path: Some("/tmp/worktree".to_string()),
        commits_ahead: Some(0),
        commits_behind: Some(0),
        base_ref_unresolved: None,
        dirty: false,
        revision_rounds: None,
        revision_limit: None,
        child_task_ids: None,
        latest_run: None,
    };

    let guide = render_guide_markdown(&GuideContext {
        task_id: "task-123".to_string(),
        task: Some(task),
        live_state_error: None,
        catalog: kanna_tool_catalog::bundled_catalog(),
    });

    assert!(guide.contains("You are task `task-123`, stage `review` of workflow `qa` (`auto`)"));
    assert!(guide.contains("Auto stages finish by recording stage completion"));
    assert!(guide.contains(
            "Prefer `kanna-mcp` tools for Kanna task operations; fall back to the instance-local `kanna-cli` from the shell only when MCP tools are unavailable."
        ));
    assert!(guide.contains("Prefer `kanna_complete_stage` to record completion"));
    assert_no_environment_sensitive_info_instruction(&guide);
    assert!(guide.contains("Fallback: `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\""));
    assert!(guide.contains("Advancing follows the next stage policy"));
    assert!(guide.contains("`task.awaiting_input` is a confirmed interactive prompt"));
    assert!(guide.contains("`task.activity_changed` is the provider-neutral fallback"));
    assert!(guide.contains("a task's state has two dimensions"));
    assert!(guide.contains("prompt-only changes while a task remains stopped are visible only"));
    assert!(guide.contains("kanna-cli task watch --repo-id <repo-id>"));
    assert!(guide.contains("MCP clients commonly abort around 300 seconds"));
    assert!(guide.contains("no_live_agent_session"));
    assert!(guide.contains("delivery_uncertain"));
    assert!(guide.contains("## Machine-Local Repository Config"));
    assert!(guide.contains("`.kanna/config.local.json`"));
    assert!(
        guide.contains("`agentProviders`, `workflow`, `ports`, `setup`, `teardown`, and `test`")
    );
    assert!(guide.contains("arrays never concatenate"));
    assert!(guide.contains("https://schemas.kanna.build/config.schema.json"));
    assert!(guide.contains("## Further Topics"));
    for topic in ["config", "workflows", "agents", "tasks", "mobile"] {
        assert!(guide.contains(&format!("`kanna-cli guide {topic}`")));
    }
    for tool in kanna_tool_catalog::bundled_catalog().tools {
        assert!(
            guide.contains(&format!("`{}`", tool.name)),
            "guide missing catalog tool {}",
            tool.name
        );
    }
}

#[test]
fn topic_guides_render_from_the_catalog_without_live_task_state() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let mut markdown = Vec::new();
    run_topic_guide_command(&catalog, "workflows", false, &mut markdown).unwrap();
    let markdown = String::from_utf8(markdown).unwrap();
    assert!(markdown.starts_with("# Kanna Workflow Authoring"));
    assert!(markdown.contains("visibility"));

    let mut json = Vec::new();
    run_topic_guide_command(&catalog, "agents", true, &mut json).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(json["topic"], "agents");
    assert!(json["sections"]
        .as_array()
        .is_some_and(|sections| !sections.is_empty()));

    let mut mobile = Vec::new();
    run_topic_guide_command(&catalog, "mobile", false, &mut mobile).unwrap();
    let mobile = String::from_utf8(mobile).unwrap();
    assert_eq!(mobile.trim_end(), catalog.render_guide("mobile").unwrap());
    assert!(mobile.contains("LAN-only"));
    assert!(mobile.contains("state/server-info"));
    assert!(mobile.contains("state/events"));
    let mobile_json = crate::commands::guide::render_topic_guide_json(&catalog, "mobile").unwrap();
    assert_eq!(mobile_json["topic"], "mobile");
    assert_eq!(
        mobile_json["sections"][0]["body"],
        catalog.guide("mobile").unwrap().sections[0].body
    );

    let error = run_topic_guide_command(&catalog, "missing", false, &mut Vec::new())
        .expect_err("unknown topic");
    assert!(error.contains("available topics: config, workflows, agents, tasks"));
}

#[test]
fn guide_markdown_tells_manual_stages_the_user_advances_the_workflow() {
    let task = TaskDetail {
        id: "task-456".to_string(),
        repo_id: "repo-1".to_string(),
        title: "Implement feature".to_string(),
        stage: Some("in progress".to_string()),
        workflow_name: Some("default".to_string()),
        stage_transition: Some("manual".to_string()),
        activity: Some("working".to_string()),
        runtime_state: Some("busy".to_string()),
        read_state: Some("read".to_string()),
        waiting_prompt_snippet: None,
        agent_type: Some("pty".to_string()),
        agent_provider: Some("claude".to_string()),
        branch: Some("task-task-456".to_string()),
        pr_url: None,
        closed_at: None,
        worktree_path: Some("/tmp/worktree".to_string()),
        commits_ahead: Some(0),
        commits_behind: Some(0),
        base_ref_unresolved: None,
        dirty: false,
        revision_rounds: None,
        revision_limit: None,
        child_task_ids: None,
        latest_run: None,
    };

    let guide = render_guide_markdown(&GuideContext {
        task_id: "task-456".to_string(),
        task: Some(task),
        live_state_error: None,
        catalog: kanna_tool_catalog::bundled_catalog(),
    });

    assert!(guide
        .contains("You are task `task-456`, stage `in progress` of workflow `default` (`manual`)"));
    assert!(guide.contains("the user advances the workflow after reviewing your work"));
    assert!(guide.contains("record completion only if this stage's prompt asks for it"));
    assert!(!guide.contains("--status success"));
}

#[tokio::test]
async fn guide_json_fetches_env_task_id_and_includes_workflow_context_and_tools() {
    let response = http_json_response(
        "200 OK",
        r#"{
                "id": "task-123",
                "repoId": "repo-1",
                "title": "Add guide coverage",
                "stage": "verify",
                "workflowName": "qa",
                "stageTransition": "auto",
                "activity": "working",
                "snippet": null,
                "agentType": "agent",
                "agentProvider": "claude",
                "branch": "task-task-123",
                "prUrl": null,
                "closedAt": null,
                "worktreePath": "/tmp/repo/.kanna-worktrees/task-task-123",
                "commitsAhead": 0,
                "commitsBehind": 0,
                "dirty": false
            }"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let context = build_guide_context(
        &[
            ("KANNA_TASK_ID", "task-123"),
            ("KANNA_SERVER_BASE_URL", base_url.as_str()),
        ],
        None,
    )
    .await;
    let guide = render_guide_json(&context).unwrap();
    let request = handle.await.unwrap();

    assert!(request.starts_with("GET /v1/tasks/task-123?agentView=true HTTP/1.1"));
    assert_eq!(guide["taskId"], "task-123");
    assert_eq!(guide["task"]["workflowName"], "qa");
    assert_eq!(guide["task"]["stage"], "verify");
    assert_eq!(guide["task"]["stageTransition"], "auto");
    assert!(guide["workflow"]["advanceStage"]
        .as_str()
        .unwrap()
        .contains("continue stages reuse the current task and session"));
    assert!(guide["workflow"]["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|operation| operation.as_str()
            == Some("prefer kanna-mcp tools for Kanna task operations")));
    for operation in guide["workflow"]["operations"]
        .as_array()
        .expect("workflow operations")
    {
        assert_no_environment_sensitive_info_instruction(
            operation.as_str().expect("workflow operation must be text"),
        );
    }
    for tool in guide["tools"].as_array().expect("catalog tools") {
        assert_no_environment_sensitive_info_instruction(
            tool["description"]
                .as_str()
                .expect("catalog tool description must be text"),
        );
    }
    assert!(guide["workflow"]["completeStage"]
        .as_str()
        .unwrap()
        .contains("Prefer kanna_complete_stage"));
    assert_eq!(guide["localRepoConfig"]["path"], ".kanna/config.local.json");
    assert_eq!(
        guide["localRepoConfig"]["schema"],
        "https://schemas.kanna.build/config.schema.json"
    );
    assert!(guide["localRepoConfig"]["guidance"]
        .as_array()
        .is_some_and(|lines| lines.iter().any(|line| line
            .as_str()
            .is_some_and(|line| line.contains("arrays never concatenate")))));
    let event_supervision = guide["workflow"]["eventSupervision"]
        .as_array()
        .expect("event supervision guidance");
    assert!(event_supervision.iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.contains("task.awaiting_input") && line.contains("confirmed"))
    }));
    assert!(event_supervision.iter().any(|line| {
        line.as_str().is_some_and(|line| {
            line.contains("no_live_agent_session") && line.contains("delivery_uncertain")
        })
    }));
    assert!(event_supervision.iter().any(|line| {
        line.as_str().is_some_and(|line| {
            line.contains("task.activity_changed") && line.contains("waitingPromptSnippet")
        })
    }));
    assert!(event_supervision.iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.contains("prompt-only changes") && line.contains("polling"))
    }));
    assert!(guide["workflow"]["prBoundary"]
        .as_str()
        .unwrap()
        .contains("Do not push a branch or create a pull request"));
    let tool_names = guide["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(tool_names.contains(&"kanna_create_task"));
    assert!(tool_names.contains(&"kanna_complete_stage"));
    assert!(tool_names.contains(&"kanna_request_revision"));
}

#[tokio::test]
async fn guide_json_command_fetches_env_task_id_and_prints_workflow_context_and_tools() {
    let response = http_json_response(
        "200 OK",
        r#"{
                "id": "task-456",
                "repoId": "repo-1",
                "title": "Wire guide command",
                "stage": "implement",
                "workflowName": "revision",
                "stageTransition": "manual",
                "activity": "working",
                "snippet": null,
                "agentType": "pty",
                "agentProvider": "copilot",
                "branch": "task-task-456",
                "prUrl": null,
                "closedAt": null,
                "worktreePath": "/tmp/repo/.kanna-worktrees/task-task-456",
                "commitsAhead": 0,
                "commitsBehind": 0,
                "dirty": false
            }"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;
    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "guide",
        "--json",
        "--server-url",
        base_url.as_str(),
    ])
    .unwrap();
    let crate::Commands::Guide {
        topic,
        json,
        server_url,
    } = cli.command
    else {
        panic!("expected guide command");
    };
    assert_eq!(topic, None);
    let mut output = Vec::new();

    run_guide_command(
        json,
        server_url.as_deref(),
        &[("KANNA_TASK_ID", "task-456")],
        &mut output,
    )
    .await
    .unwrap();
    let request = handle.await.unwrap();
    let guide: serde_json::Value = serde_json::from_slice(&output).unwrap();

    assert!(request.starts_with("GET /v1/tasks/task-456?agentView=true HTTP/1.1"));
    assert_eq!(guide["taskId"], "task-456");
    assert_eq!(guide["task"]["workflowName"], "revision");
    assert_eq!(guide["task"]["stage"], "implement");
    assert_eq!(guide["task"]["stageTransition"], "manual");
    assert!(guide["workflow"]["manualTransition"]
        .as_str()
        .unwrap()
        .contains("manual stages wait"));
    assert!(guide["workflow"]["advanceStage"]
        .as_str()
        .unwrap()
        .contains("next stage policy"));
    assert!(guide["workflow"]["completeStage"]
        .as_str()
        .unwrap()
        .contains("stage-complete"));
    assert!(guide["workflow"]["eventSupervision"]
        .as_array()
        .is_some_and(|lines| lines.len() == 5));
    let tool_names = guide["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(tool_names.contains(&"kanna_create_task"));
    assert!(tool_names.contains(&"kanna_complete_stage"));
    assert!(tool_names.contains(&"kanna_request_revision"));
}
