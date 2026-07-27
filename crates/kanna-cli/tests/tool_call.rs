use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;

#[test]
fn generic_complete_stage_tool_call_binds_current_run_id_into_http_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        assert!(request.starts_with("POST /v1/tasks/task-current/actions/complete-stage HTTP/1.1"));
        assert!(request.contains(
            r#"{"runId":"run-current","status":"success","summary":"current run completed"}"#
        ));

        let body = r#"{"taskId":"task-current"}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .unwrap();
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "tool",
            "call",
            "kanna_complete_stage",
            "--json",
            r#"{"task_id":"task-current","status":"success","summary":"current run completed"}"#,
            "--server-url",
            &format!("http://{address}"),
        ])
        .env("KANNA_STAGE_RUN_ID", "run-current")
        .output()
        .unwrap();

    server.join().unwrap();
    assert!(
        output.status.success(),
        "expected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn generic_complete_stage_tool_call_supports_old_override_catalog() {
    let root = std::env::temp_dir().join(format!(
        "kanna-cli-old-completion-override-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".kanna")).unwrap();
    let mut catalog = kanna_tool_catalog::bundled_catalog();
    catalog
        .tools
        .iter_mut()
        .find(|tool| tool.name == "kanna_complete_stage")
        .unwrap()
        .params
        .retain(|param| param.name != "run_id" && param.name != "completion_attempt");
    std::fs::write(
        root.join(".kanna/mcp-tools.json"),
        serde_json::to_vec(&catalog).unwrap(),
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        assert!(request.starts_with("POST /v1/tasks/task-current/actions/complete-stage HTTP/1.1"));
        assert!(request.contains(
            r#"{"completionAttempt":"attempt-current","runId":"run-current","status":"success","summary":"completed through old override"}"#
        ));

        let body = r#"{"taskId":"task-current"}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .unwrap();
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "tool",
            "call",
            "kanna_complete_stage",
            "--json",
            r#"{"task_id":"task-current","status":"success","summary":"completed through old override","run_id":"caller-supplied-current-run","completion_attempt":"attempt-current"}"#,
            "--server-url",
            &format!("http://{address}"),
        ])
        .current_dir(&root)
        .env("KANNA_STAGE_RUN_ID", "run-current")
        .output()
        .unwrap();

    if output.status.success() {
        server.join().unwrap();
    }
    assert!(
        output.status.success(),
        "expected command to support an old override catalog, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(root);
}
