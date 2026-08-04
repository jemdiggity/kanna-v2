use super::*;

#[test]
fn guide_markdown_includes_live_context_and_all_catalog_tools() {
    let task = TaskDetail {
        id: "task-123".to_string(),
        repo_id: "repo-1".to_string(),
        title: "Review branch".to_string(),
        stage: Some("review".to_string()),
        pipeline_name: Some("qa".to_string()),
        stage_transition: Some("auto".to_string()),
        activity: Some("working".to_string()),
        snippet: None,
        agent_type: Some("pty".to_string()),
        agent_provider: Some("claude".to_string()),
        branch: Some("task-task-123".to_string()),
        pr_url: None,
        closed_at: None,
        worktree_path: Some("/tmp/worktree".to_string()),
        commits_ahead: 0,
        commits_behind: 0,
        dirty: false,
        revision_rounds: None,
        revision_limit: None,
        child_task_ids: None,
        approval_gate: None,
        latest_run: None,
    };

    let guide = render_guide_markdown(&GuideContext {
        task_id: "task-123".to_string(),
        task: Some(task),
        live_state_error: None,
        catalog: kanna_tool_catalog::bundled_catalog(),
    });

    assert!(guide.contains("You are task `task-123`, stage `review` of pipeline `qa` (`auto`)"));
    assert!(guide.contains("Auto stages finish by recording stage completion"));
    assert!(guide.contains(
            "Prefer `kanna-mcp` tools for Kanna task operations; fall back to the instance-local `kanna-cli` from the shell only when MCP tools are unavailable."
        ));
    assert!(guide.contains("Prefer `kanna_complete_stage` to record completion"));
    assert!(guide.contains("Before environment-sensitive operations"));
    assert!(guide.contains("call `kanna_info`"));
    assert!(guide.contains("run `kanna-cli info`"));
    assert!(guide.contains("Fallback: `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\""));
    assert!(guide.contains("Advancing follows the next stage policy"));
    for tool in kanna_tool_catalog::bundled_catalog().tools {
        assert!(
            guide.contains(&format!("`{}`", tool.name)),
            "guide missing catalog tool {}",
            tool.name
        );
    }
}

#[test]
fn guide_markdown_tells_manual_stages_the_user_advances_the_pipeline() {
    let task = TaskDetail {
        id: "task-456".to_string(),
        repo_id: "repo-1".to_string(),
        title: "Implement feature".to_string(),
        stage: Some("in progress".to_string()),
        pipeline_name: Some("default".to_string()),
        stage_transition: Some("manual".to_string()),
        activity: Some("working".to_string()),
        snippet: None,
        agent_type: Some("pty".to_string()),
        agent_provider: Some("claude".to_string()),
        branch: Some("task-task-456".to_string()),
        pr_url: None,
        closed_at: None,
        worktree_path: Some("/tmp/worktree".to_string()),
        commits_ahead: 0,
        commits_behind: 0,
        dirty: false,
        revision_rounds: None,
        revision_limit: None,
        child_task_ids: None,
        approval_gate: None,
        latest_run: None,
    };

    let guide = render_guide_markdown(&GuideContext {
        task_id: "task-456".to_string(),
        task: Some(task),
        live_state_error: None,
        catalog: kanna_tool_catalog::bundled_catalog(),
    });

    assert!(guide
        .contains("You are task `task-456`, stage `in progress` of pipeline `default` (`manual`)"));
    assert!(guide.contains("the user advances the pipeline after reviewing your work"));
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
                "pipelineName": "qa",
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

    assert!(request.starts_with("GET /v1/tasks/task-123 HTTP/1.1"));
    assert_eq!(guide["taskId"], "task-123");
    assert_eq!(guide["task"]["pipelineName"], "qa");
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
    assert!(guide["workflow"]["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|operation| operation.as_str()
            == Some("call kanna_info before environment-sensitive operations and use its authoritative connected-server identity")));
    assert!(guide["workflow"]["completeStage"]
        .as_str()
        .unwrap()
        .contains("Prefer kanna_complete_stage"));
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
                "pipelineName": "revision",
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
    let crate::Commands::Guide { json, server_url } = cli.command else {
        panic!("expected guide command");
    };
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

    assert!(request.starts_with("GET /v1/tasks/task-456 HTTP/1.1"));
    assert_eq!(guide["taskId"], "task-456");
    assert_eq!(guide["task"]["pipelineName"], "revision");
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
