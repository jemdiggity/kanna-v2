use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;

#[test]
fn dependent_tasks_exist_uses_server_url_and_prints_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();

        assert!(request.starts_with("GET /v1/tasks/task%201/dependent-tasks-exist HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("\r\nhost: {address}\r\n")),
            "request should target the explicit server URL: {request}"
        );

        let body = r#"{"exists":true,"dependentTasks":[{"taskId":"dependent-1","title":"Dependent task","branch":"feature/child","baseRef":"origin/feature/parent","reason":"base_ref"}]}"#;
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
            "dependent-tasks-exist",
            "--task-id",
            "task 1",
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
            "exists": true,
            "dependentTasks": [{
                "taskId": "dependent-1",
                "title": "Dependent task",
                "branch": "feature/child",
                "baseRef": "origin/feature/parent",
                "reason": "base_ref"
            }]
        })
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
}
