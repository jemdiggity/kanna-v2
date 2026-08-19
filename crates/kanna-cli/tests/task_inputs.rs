use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;

/// The CLI is the fallback a reviewer reaches for when its MCP client has no
/// `kanna_task_inputs` tool, so it has to hit the same route the catalog
/// declares and it has to render every field of the record. Its typed
/// `TaskInputs` model cannot be shared with `kanna-server`, so the response
/// shape is pinned on both sides — the server half lives in
/// `http_api::tests::input::catalog_task_inputs_tool_reaches_the_recorded_instruction_history`.
#[test]
fn task_inputs_reads_the_recorded_instruction_history_from_the_catalog_route() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = r#"{"taskId":"task 1","total":2,"inputs":[{"id":1,"taskId":"task 1","runId":"run-1","stage":"in progress","source":"operator","message":"Keep the new flag - I changed my mind mid-task.","deliveredAt":"2026-08-20 04:00:00"},{"id":2,"taskId":"task 1","runId":null,"stage":"review","source":"notify","message":"TASK child-1 DONE success: Child task","deliveredAt":"2026-08-20 05:00:00"}]}"#;
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();

        assert!(
            request.starts_with("GET /v1/tasks/task%201/inputs?tail=25 HTTP/1.1"),
            "request should target the catalog's inputs route: {request}"
        );

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
            "task",
            "inputs",
            "--task-id",
            "task 1",
            "--tail",
            "25",
            "--server-url",
            &format!("http://{address}/"),
        ])
        .env("KANNA_SERVER_BASE_URL", "http://127.0.0.1:1")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "expected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().unwrap();

    let stdout: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be JSON");
    assert_eq!(
        stdout,
        serde_json::json!({
            "taskId": "task 1",
            // `total` is the whole history; `inputs` is only the tail window,
            // so a reviewer can see that it was truncated.
            "total": 2,
            "inputs": [
                {
                    "id": 1,
                    "taskId": "task 1",
                    "runId": "run-1",
                    "stage": "in progress",
                    "source": "operator",
                    "message": "Keep the new flag - I changed my mind mid-task.",
                    "deliveredAt": "2026-08-20 04:00:00"
                },
                {
                    "id": 2,
                    "taskId": "task 1",
                    "runId": null,
                    "stage": "review",
                    "source": "notify",
                    "message": "TASK child-1 DONE success: Child task",
                    "deliveredAt": "2026-08-20 05:00:00"
                }
            ]
        })
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
}
