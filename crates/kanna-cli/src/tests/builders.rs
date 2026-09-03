use super::*;

#[test]
fn builds_complete_stage_payload() {
    let request = build_complete_stage_request(
        Some("run-1".to_string()),
        None,
        "success".to_string(),
        "review passed".to_string(),
        Some(json!({ "coverage": "sufficient" })),
    );

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "runId": "run-1",
            "status": "success",
            "summary": "review passed",
            "metadata": { "coverage": "sufficient" },
        })
    );
}

#[test]
fn builds_merge_handoff_without_approval_state() {
    let request = build_merge_handoff_request(
        "task-task-1-4".to_string(),
        "main".to_string(),
        Some("https://example.invalid/pull/1".to_string()),
        "approved".to_string(),
    );

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "branch": "task-task-1-4",
            "target": "main",
            "prUrl": "https://example.invalid/pull/1",
            "summary": "approved",
        })
    );
}

#[test]
fn renders_stage_complete_confirmation_for_same_task_response() {
    let rendered = render_stage_complete_confirmation("task-1", "success", "task-1");

    assert_eq!(
        rendered,
        "Stage completion recorded for task task-1 (status: success)."
    );
}

#[test]
fn renders_stage_complete_confirmation_for_advanced_task_response() {
    let rendered = render_stage_complete_confirmation("task-1", "success", "task-2");

    assert_eq!(
        rendered,
        "Stage completion recorded for task task-1 (status: success); advanced to task task-2."
    );
}

#[test]
fn builds_request_revision_payload() {
    let request = build_request_revision_request(
        "in progress".to_string(),
        "missing e2e coverage".to_string(),
        "Add e2e coverage for task creation.".to_string(),
        None,
    );

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "targetStage": "in progress",
            "summary": "missing e2e coverage",
            "prompt": "Add e2e coverage for task creation.",
        })
    );
}

#[test]
fn builds_send_task_input_payload() {
    let request =
        build_send_task_input_request("Please fix the failing typecheck".to_string(), None);

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "input": "Please fix the failing typecheck",
        })
    );
}

/// A declared source rides with the message so the durable record says who
/// was speaking; omitting it stays absent rather than becoming a claim.
#[test]
fn builds_send_task_input_payload_with_a_declared_source() {
    let request = build_send_task_input_request(
        "The owner asked for swipe-only pinning".to_string(),
        Some("operator".to_string()),
    );

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "input": "The owner asked for swipe-only pinning",
            "source": "operator",
        })
    );
}

#[test]
fn builds_signal_agent_payload() {
    let request = build_signal_agent_request("Please merge task task-1".to_string(), None, None);

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "message": "Please merge task task-1",
        })
    );
}

#[test]
fn builds_signal_agent_payload_with_provider_and_effort_overrides() {
    let request = build_signal_agent_request(
        "Please merge task task-1".to_string(),
        Some("claude".to_string()),
        Some("high".to_string()),
    );

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "message": "Please merge task task-1",
            "agentProvider": "claude",
            "effort": "high",
        })
    );
}

#[test]
fn builds_add_repo_payload() {
    let request =
        build_add_repo_request("/Users/me/project".to_string(), Some("Project".to_string()));

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "path": "/Users/me/project",
            "name": "Project",
        })
    );
}

#[test]
fn builds_reconcile_repo_metadata_payload() {
    assert_eq!(
        serde_json::to_value(build_reconcile_repo_metadata_request(false)).unwrap(),
        json!({ "apply": false })
    );
}

#[test]
fn send_task_input_payload_passes_message_through_unchanged() {
    // The server owns submission; the CLI sends the message verbatim.
    let request = build_send_task_input_request("continue\n".to_string(), None);

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "input": "continue\n",
        })
    );
}

#[tokio::test]
async fn send_task_input_posts_input_to_task_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]);
        assert!(request.starts_with("POST /v1/tasks/task-1/input HTTP/1.1"));
        assert!(request.contains(r#"{"input":"continue"}"#));

        stream
            .write_all(b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\n")
            .unwrap();
    });

    let response = send_task_input_via_api(
        &format!("http://{address}"),
        "task-1",
        &build_send_task_input_request("continue".to_string(), None),
    )
    .await;

    server.join().unwrap();
    assert_eq!(response, Ok(TaskInputResponse { ok: true }));
}

#[tokio::test]
async fn send_task_input_preserves_http_error_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let _ = stream.read(&mut buffer).unwrap();

        stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 21\r\n\r\ntask task-1 not found",
                )
                .unwrap();
    });

    let response = send_task_input_via_api(
        &format!("http://{address}"),
        "task-1",
        &build_send_task_input_request("continue".to_string(), None),
    )
    .await;

    server.join().unwrap();
    assert_eq!(
        response,
        Err("request failed with status 404 Not Found: task task-1 not found".to_string())
    );
}

#[test]
fn builds_camel_case_task_request_payload() {
    let request = build_create_task_request(TaskCreateOptions {
        repo_id: "repo-1".to_string(),
        prompt: "Ship it".to_string(),
        display_name: Some("Short task title".to_string()),
        workflow_name: Some("default".to_string()),
        base_ref: Some("origin/main".to_string()),
        agent: Some("review-security".to_string()),
        agent_provider: Some("claude".to_string()),
        agent_type: Some("agent".to_string()),
        model: Some("sonnet".to_string()),
        effort: Some("high".to_string()),
        permission_mode: Some("dontAsk".to_string()),
        allowed_tool: vec!["Bash".to_string(), "Edit".to_string()],
        blocker_task_id: vec!["blocker-1".to_string(), "blocker-2".to_string()],
        parent_task: None,
    });

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "repoId": "repo-1",
            "prompt": "Ship it",
            "displayName": "Short task title",
            "workflowName": "default",
            "baseRef": "origin/main",
            "agent": "review-security",
            "agentProvider": "claude",
            "agentType": "agent",
            "model": "sonnet",
            "effort": "high",
            "permissionMode": "dontAsk",
            "allowedTools": ["Bash", "Edit"],
            "blockerTaskIds": ["blocker-1", "blocker-2"],
        })
    );
}

#[test]
fn builds_block_task_payload() {
    let request = build_block_task_request(vec!["blocker-1".to_string(), "blocker-2".to_string()]);

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "blockerTaskIds": ["blocker-1", "blocker-2"],
        })
    );
}

#[test]
fn builds_task_request_defaults_to_pty_agent_type_when_flag_absent() {
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

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "repoId": "repo-1",
            "prompt": "Use the saved default provider",
            "agentType": "pty",
        })
    );
}
