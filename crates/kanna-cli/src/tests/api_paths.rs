use super::*;

#[test]
fn task_list_uses_recent_tasks_endpoint() {
    assert_eq!(task_list_path(), "/v1/tasks/recent");
}

#[test]
fn repo_task_list_uses_repo_tasks_endpoint() {
    assert_eq!(repo_task_list_path("repo 1"), "/v1/repos/repo%201/tasks");
}

#[test]
fn repo_agent_list_uses_repo_agents_endpoint() {
    assert_eq!(repo_agent_list_path("repo 1"), "/v1/repos/repo%201/agents");
}

#[test]
fn signal_agent_uses_repo_agent_signal_endpoint() {
    assert_eq!(
        signal_agent_path("repo 1", "merge agent"),
        "/v1/repos/repo%201/agents/merge%20agent/signal"
    );
}

#[test]
fn task_search_uses_search_endpoint() {
    assert_eq!(
        task_search_path("review me"),
        "/v1/tasks/search?query=review%20me"
    );
}

#[test]
fn task_get_uses_single_task_endpoint() {
    assert_eq!(task_get_path("task 1"), "/v1/tasks/task%201");
}

#[test]
fn task_children_uses_direct_children_endpoint() {
    assert_eq!(task_children_path("task 1"), "/v1/tasks/task%201/children");
}

#[test]
fn dependent_tasks_exist_uses_task_endpoint() {
    assert_eq!(
        dependent_tasks_exist_path("task 1"),
        "/v1/tasks/task%201/dependent-tasks-exist"
    );
}

#[test]
fn task_logs_uses_task_logs_endpoint() {
    assert_eq!(
        task_logs_path("task 1", Some(25)),
        "/v1/tasks/task%201/logs?tail=25"
    );
    assert_eq!(task_logs_path("task-1", None), "/v1/tasks/task-1/logs");
}

#[test]
fn wait_until_matches_finished_and_closed_states() {
    let mut task: TaskDetail = serde_json::from_value(json!({
        "id": "task-1",
        "repoId": "repo-1",
        "title": "Wait",
        "stage": "in progress",
        "activity": "working",
        "snippet": null,
        "agentType": "pty",
        "agentProvider": "claude",
        "branch": "task-task-1",
        "prUrl": null,
        "closedAt": null,
        "worktreePath": null,
        "commitsAhead": 0,
        "commitsBehind": 0,
        "dirty": false
    }))
    .unwrap();

    assert_eq!(parse_wait_until("finished"), Ok(WaitUntil::Finished));
    assert_eq!(parse_wait_until("closed"), Ok(WaitUntil::Closed));
    assert!(!task_matches_wait_until(&task, WaitUntil::Finished));

    // Read state is not a termination: a working agent whose output nobody
    // read carries `unread` too.
    task.activity = Some("unread".to_string());
    task.read_state = Some("unread".to_string());
    task.runtime_state = Some("busy".to_string());
    assert!(!task_matches_wait_until(&task, WaitUntil::Finished));

    task.runtime_state = Some("exited".to_string());
    assert!(task_matches_wait_until(&task, WaitUntil::Finished));
    assert!(!task_matches_wait_until(&task, WaitUntil::Closed));
    task.closed_at = Some("2026-06-13 00:00:00".to_string());
    assert!(task_matches_wait_until(&task, WaitUntil::Closed));
}

#[test]
fn parses_task_summary_response_shape() {
    let task: TaskSummary = serde_json::from_value(json!({
        "id": "task-1",
        "repoId": "repo-1",
        "title": "Add status command",
        "stage": "in progress",
        "snippet": "working...",
        "activity": "working",
    }))
    .unwrap();

    assert_eq!(task.id, "task-1");
    assert_eq!(task.repo_id, "repo-1");
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(task.activity.as_deref(), Some("working"));
    assert_eq!(task.title, "Add status command");
}

#[test]
fn parses_task_detail_response_shape() {
    let task: TaskDetail = serde_json::from_value(json!({
        "id": "task-1",
        "repoId": "repo-1",
        "title": "Add status command",
        "stage": "in progress",
        "workflowName": "default",
        "stageTransition": "manual",
        "activity": "working",
        "snippet": "working...",
        "agentType": "pty",
        "agentProvider": "claude",
        "branch": "task-task-1",
        "prUrl": null,
        "closedAt": null,
        "worktreePath": "/tmp/worktree",
        "commitsAhead": 2,
        "commitsBehind": 1,
        "dirty": true,
        "latestRun": {
            "id": "run-1",
            "stage": "in progress",
            "kind": "main",
            "status": "succeeded",
            "summary": "done",
            "resumedFromRunId": null,
            "resumeFallbackReason": null,
            "finishedAt": "2026-08-06 09:20:00"
        }
    }))
    .unwrap();

    assert_eq!(task.id, "task-1");
    assert_eq!(task.activity.as_deref(), Some("working"));
    assert_eq!(task.workflow_name.as_deref(), Some("default"));
    assert_eq!(task.stage_transition.as_deref(), Some("manual"));
    assert_eq!(task.agent_provider.as_deref(), Some("claude"));
    assert_eq!(task.branch.as_deref(), Some("task-task-1"));
    assert_eq!(task.worktree_path.as_deref(), Some("/tmp/worktree"));
    assert_eq!(task.commits_ahead, 2);
    assert_eq!(task.commits_behind, 1);
    assert!(task.dirty);
    let latest_run = task.latest_run.expect("latest run");
    assert_eq!(latest_run.id.as_deref(), Some("run-1"));
    assert_eq!(latest_run.status.as_deref(), Some("succeeded"));
    assert_eq!(latest_run.summary.as_deref(), Some("done"));
}

#[test]
fn parses_and_preserves_legacy_latest_run_without_id() {
    let latest_run: TaskLatestRun = serde_json::from_value(json!({
        "stage": "review",
        "kind": "main",
        "status": "succeeded",
        "summary": "PASS: no findings",
        "finishedAt": "2026-08-06 09:20:00"
    }))
    .unwrap();

    assert_eq!(latest_run.id, None);
    assert_eq!(latest_run.status.as_deref(), Some("succeeded"));
    assert_eq!(latest_run.summary.as_deref(), Some("PASS: no findings"));
    assert_eq!(
        serde_json::to_value(latest_run).unwrap(),
        json!({
            "stage": "review",
            "kind": "main",
            "status": "succeeded",
            "summary": "PASS: no findings",
            "finishedAt": "2026-08-06 09:20:00"
        })
    );
}

#[test]
fn parses_and_preserves_empty_legacy_latest_run() {
    let latest_run: TaskLatestRun = serde_json::from_value(json!({})).unwrap();

    assert_eq!(latest_run.id, None);
    assert_eq!(latest_run.status, None);
    assert_eq!(latest_run.summary, None);
    assert_eq!(serde_json::to_value(latest_run).unwrap(), json!({}));
}
