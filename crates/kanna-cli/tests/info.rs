use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;

#[test]
fn info_uses_exact_server_url_and_shared_safe_snapshot() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept status request");
        let mut buffer = [0_u8; 4096];
        let bytes_read = stream.read(&mut buffer).expect("read status request");
        let request = String::from_utf8_lossy(&buffer[..bytes_read]);
        assert!(request.starts_with("GET /v1/status HTTP/1.1"));

        let body = json!({
            "state": "running",
            "desktopId": "desktop-cli-staging",
            "desktopName": "CLI Staging Mac",
            "version": "1.2.3-staging.4",
            "environment": "staging",
            "serverVersion": "1.2.3-staging.4",
            "lanHost": "10.0.0.9",
            "lanPort": 48121,
            "pairingCode": "PAIR-SECRET",
            "kspStreamVersion": 2,
            "writePathHealth": {
                "healthy": true,
                "status": "healthy",
                "activeWorkspaceCommands": 0,
                "maxWorkspaceCommands": 4,
                "longRunningWorkspaceCommands": 0,
                "oldestWorkspaceCommandSeconds": null
            }
        })
        .to_string();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .expect("write status response");
    });

    let base_url = format!("http://{address}/");
    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args(["info", "--server-url", &base_url])
        .env("KANNA_SERVER_BASE_URL", "http://127.0.0.1:1")
        .env("KANNA_TASK_ID", "task-cli-info")
        .output()
        .expect("run kanna-cli info");

    assert!(
        output.status.success(),
        "kanna-cli info failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    let info: Value = serde_json::from_slice(&output.stdout).expect("info JSON");
    assert_eq!(info["clientAdapter"]["name"], "kanna-cli");
    assert!(info["clientAdapter"]["mcpProtocolVersion"].is_null());
    assert_eq!(info["connection"]["effectiveBaseUrl"], base_url);
    assert_eq!(info["connection"]["port"], address.port());
    assert_eq!(info["serverStatus"]["environment"], "staging");
    assert_eq!(info["serverStatus"]["version"], "1.2.3-staging.4");
    assert_eq!(info["taskContext"]["taskId"], "task-cli-info");
    assert!(!info.to_string().contains("PAIR-SECRET"));
}
