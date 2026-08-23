//! The revision-round budget has to survive the typed CLI fallback.
//!
//! `kanna-cli` is what agents use when MCP tools are unavailable, and the
//! review agents are told to read `revisionRounds`/`revisionLimit` from
//! `task get` and `revisionBudget` from `request-revision`. Both commands
//! re-serialize a typed model, so a field missing from that model is silently
//! dropped: a no-MCP agent would read a parked task as a started revision and
//! keep going. These tests drive the real binary against a stub server and
//! assert the fields reach stdout.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Serves one HTTP request with `body`, returning the request text.
fn serve_once(body: &'static str) -> (std::net::SocketAddr, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 8192];
        let bytes_read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
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
        request
    });
    (address, handle)
}

/// A dead workflow socket, so `request-revision` does not warn about it.
fn dead_workflow_socket(label: &str) -> std::path::PathBuf {
    // Kept short deliberately: a unix socket path has to fit in SUN_LEN, and
    // the macOS temp dir already spends most of it.
    let socket_path = std::env::temp_dir().join(format!(
        "kn-{label}-{}-{}.sock",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            % 1_000_000
    ));
    let listener = UnixListener::bind(&socket_path).unwrap();
    drop(listener);
    socket_path
}

#[test]
fn task_get_prints_the_revision_round_budget() {
    let (address, server) = serve_once(
        r#"{"id":"task-1","repoId":"repo-1","title":"Task One","stage":"review",
            "commitsAhead":0,"commitsBehind":0,"dirty":false,
            "revisionRounds":2,"revisionLimit":3}"#,
    );

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "get",
            "--task-id",
            "task-1",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .unwrap();

    let request = server.join().unwrap();
    assert!(
        request.starts_with("GET /v1/tasks/task-1?agentView=true HTTP/1.1"),
        "{request}"
    );
    assert!(
        output.status.success(),
        "expected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be JSON");
    assert_eq!(stdout["revisionRounds"], serde_json::json!(2));
    assert_eq!(stdout["revisionLimit"], serde_json::json!(3));
}

#[test]
fn task_get_omits_the_budget_when_the_server_does_not_send_it() {
    // An older desktop server predating the budget must still deserialize.
    let (address, server) = serve_once(
        r#"{"id":"task-1","repoId":"repo-1","title":"Task One","stage":"review",
            "commitsAhead":0,"commitsBehind":0,"dirty":false}"#,
    );

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "get",
            "--task-id",
            "task-1",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .unwrap();

    server.join().unwrap();
    assert!(
        output.status.success(),
        "expected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be JSON");
    assert!(stdout.get("revisionRounds").is_none(), "{stdout}");
    assert!(stdout.get("revisionLimit").is_none(), "{stdout}");
}

#[test]
fn request_revision_prints_a_started_revision_budget() {
    let (address, server) = serve_once(
        r#"{"taskId":"task-1","revisionBudget":{"rounds":2,"limit":3,"exhausted":false,
            "message":"Revision round 2 of 3 started."}}"#,
    );
    let socket_path = dead_workflow_socket("started");

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "request-revision",
            "--task-id",
            "task-1",
            "--target-stage",
            "in progress",
            "--summary",
            "QA failed",
            "--prompt",
            "Fix the failing typecheck.",
            "--server-url",
            &format!("http://{address}"),
        ])
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
    assert_eq!(stdout["revisionBudget"]["rounds"], serde_json::json!(2));
    assert_eq!(stdout["revisionBudget"]["limit"], serde_json::json!(3));
    assert_eq!(
        stdout["revisionBudget"]["exhausted"],
        serde_json::json!(false)
    );
    assert_eq!(
        stdout["revisionBudget"]["message"],
        serde_json::json!("Revision round 2 of 3 started.")
    );
}

#[test]
fn request_revision_prints_an_exhausted_revision_budget() {
    // The case that matters most: nothing started and the task is parked. An
    // agent that cannot see `exhausted` would retry or assume it was revised.
    let (address, server) = serve_once(
        r#"{"taskId":"task-1","revisionBudget":{"rounds":3,"limit":3,"exhausted":true,
            "message":"No revision was started: this task has already used its 3 automatic revision round(s)."}}"#,
    );
    let socket_path = dead_workflow_socket("exhausted");

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "request-revision",
            "--task-id",
            "task-1",
            "--target-stage",
            "in progress",
            "--summary",
            "QA failed",
            "--prompt",
            "Fix the failing typecheck.",
            "--server-url",
            &format!("http://{address}"),
        ])
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
    assert_eq!(
        stdout["revisionBudget"]["exhausted"],
        serde_json::json!(true)
    );
    assert_eq!(stdout["revisionBudget"]["rounds"], serde_json::json!(3));
    assert_eq!(stdout["revisionBudget"]["limit"], serde_json::json!(3));
    assert!(
        stdout["revisionBudget"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("No revision was started")),
        "the parked reason must reach the agent: {stdout}"
    );
}
