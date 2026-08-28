use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn request_revision_does_not_warn_when_workflow_socket_is_unavailable() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        assert!(request.starts_with("POST /v1/tasks/task-1/actions/request-revision HTTP/1.1"));
        let body = request.split("\r\n\r\n").nth(1).unwrap();
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "targetStage": "in progress",
                "summary": "needs revision",
                "prompt": "Please revise.",
                "runId": "run-review-1",
            })
        );

        let body = r#"{"taskId":"task-2"}"#;
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

    let socket_path = std::env::temp_dir().join(format!(
        "kanna-cli-dead-workflow-{}-{}.sock",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dead_listener = UnixListener::bind(&socket_path).unwrap();
    drop(dead_listener);

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "request-revision",
            "--task-id",
            "task-1",
            "--target-stage",
            "in progress",
            "--summary",
            "needs revision",
            "--prompt",
            "Please revise.",
            "--server-url",
            &format!("http://{address}"),
        ])
        .env_remove(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV)
        .env(kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV, "run-review-1")
        .env("KANNA_SOCKET_PATH", &socket_path)
        .output()
        .unwrap();

    let _ = std::fs::remove_file(socket_path);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "expected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be JSON");
    assert_eq!(stdout, serde_json::json!({ "taskId": "task-2" }));
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
}
