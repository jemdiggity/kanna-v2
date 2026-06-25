use super::*;

#[test]
fn formats_task_list_as_script_friendly_json_rows() {
    let tasks = vec![TaskSummary {
        id: "task-1".to_string(),
        repo_id: "repo-1".to_string(),
        title: "Add status command".to_string(),
        stage: Some("in progress".to_string()),
        snippet: Some("working...".to_string()),
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
            snippet: None,
            activity: Some("unread".to_string()),
        },
        TaskSummary {
            id: "task-123-extra".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Wrong".to_string(),
            stage: Some("in progress".to_string()),
            snippet: None,
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

#[test]
fn reports_clear_task_not_found_error() {
    assert_eq!(
        task_not_found_error("missing-task"),
        "Task 'missing-task' was not found".to_string()
    );
}
