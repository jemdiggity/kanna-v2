use super::*;

#[test]
fn formats_task_list_as_script_friendly_json_rows() {
    let tasks = vec![TaskSummary {
        id: "task-1".to_string(),
        repo_id: "repo-1".to_string(),
        title: "Add status command".to_string(),
        stage: Some("in progress".to_string()),
        waiting_prompt_snippet: Some("working...".to_string()),
        activity: Some("working".to_string()),
    }];

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&format_task_list(&tasks).unwrap()).unwrap(),
        json!([
            {
                "id": "task-1",
                "repoId": "repo-1",
                "stage": "in progress",
                "activity": "working",
                "title": "Add status command",
            }
        ])
    );
}

#[test]
fn formats_task_status_for_exact_task_id_only() {
    let tasks = vec![
        TaskSummary {
            id: "task-123".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Wanted".to_string(),
            stage: Some("pr".to_string()),
            waiting_prompt_snippet: None,
            activity: Some("unread".to_string()),
        },
        TaskSummary {
            id: "task-123-extra".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Wrong".to_string(),
            stage: Some("in progress".to_string()),
            waiting_prompt_snippet: None,
            activity: Some("working".to_string()),
        },
    ];

    let row = find_task_status_row(&tasks, "task-123").unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&format_task_status(&row).unwrap()).unwrap(),
        json!({
            "id": "task-123",
            "repoId": "repo-1",
            "stage": "pr",
            "activity": "unread",
            "title": "Wanted",
        })
    );
}

fn wait_task_detail(activity: &str) -> TaskDetail {
    serde_json::from_value(json!({
        "id": "child-1",
        "repoId": "repo-1",
        "title": "Specialty review",
        "stage": "review",
        "activity": activity,
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
    }))
    .unwrap()
}

/// `kanna-cli task wait` prints what the MCP tool returns, so an agent without
/// MCP support loops on the same `waitOutcome` field.
#[test]
fn renders_wait_outcomes_with_the_same_discriminator_the_mcp_tool_returns() {
    let resolved = render_wait_outcome(
        WaitTaskOutcome::Resolved(wait_task_detail("unread")),
        "child-1",
    )
    .unwrap();

    assert_eq!(resolved["waitOutcome"], json!("resolved"));
    assert_eq!(resolved["id"], json!("child-1"));
    assert_eq!(resolved["activity"], json!("unread"));
    assert!(resolved["waitHint"].is_null());

    let timed_out = render_wait_outcome(
        WaitTaskOutcome::TimedOut {
            task: wait_task_detail("working"),
            timeout_secs: MAX_WAIT_TIMEOUT_SECS,
        },
        "child-1",
    )
    .unwrap();

    assert_eq!(timed_out["waitOutcome"], json!("timeout"));
    assert_eq!(timed_out["waitTimeoutSecs"], json!(MAX_WAIT_TIMEOUT_SECS));
    assert_eq!(timed_out["stage"], json!("review"));
    assert_eq!(timed_out["activity"], json!("working"));
    assert!(timed_out["waitHint"]
        .as_str()
        .is_some_and(|hint| hint.contains("call kanna_wait_task again")));
}

#[test]
fn reports_clear_task_not_found_error() {
    assert_eq!(
        task_not_found_error("missing-task"),
        "Task 'missing-task' was not found".to_string()
    );
}
