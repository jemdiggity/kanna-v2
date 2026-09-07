//! `kanna-cli task send-raw-input` against a real HTTP fixture.
//!
//! The CLI is the fallback surface an agent reaches for when MCP tools are not
//! available, so what it puts on the wire has to be the same request the MCP
//! adapter makes — and it must never let a shell decide what an escape byte is.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;

fn read_request(stream: &mut TcpStream) -> (String, Option<Value>) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read request");
        assert_ne!(read, 0, "client closed before headers");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).expect("utf8 headers");
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("read request body");
        assert_ne!(read, 0, "client closed before body");
        bytes.extend_from_slice(&buffer[..read]);
    }
    let body = (content_length > 0).then(|| {
        serde_json::from_slice(&bytes[header_end..header_end + content_length])
            .expect("json request body")
    });
    (
        headers.lines().next().expect("request line").to_string(),
        body,
    )
}

fn write_json(stream: &mut TcpStream, status: &str, body: Value) {
    let body = body.to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .expect("write response");
}

fn written_response(task_id: &str) -> Value {
    json!({
        "status": "written",
        "taskId": task_id,
        "sessionPid": 42133,
        "writes": [
            { "index": 0, "key": "down", "bytes": "1b5b42", "class": "draft", "status": "written" },
            { "index": 1, "key": "enter", "bytes": "0d", "class": "submission", "status": "written" }
        ]
    })
}

/// The incident's own invocation: two named keys become one POST carrying
/// exactly those names, in order.
#[test]
fn send_raw_input_posts_named_keys_to_the_raw_input_route() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept raw input");
        let (request, body) = read_request(&mut stream);
        assert!(
            request.starts_with("POST /v1/tasks/spike362c3351/raw-input HTTP/1.1"),
            "{request}"
        );
        assert_eq!(
            body,
            Some(json!({ "keys": ["down", "enter"], "source": "operator" }))
        );
        write_json(&mut stream, "200 OK", written_response("spike362c3351"));
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "send-raw-input",
            "--task-id",
            "spike362c3351",
            "--keys",
            "down,enter",
            "--source",
            "operator",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run send-raw-input");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    let result: Value = serde_json::from_slice(&output.stdout).expect("raw input JSON");
    assert_eq!(result["writes"][0]["bytes"], "1b5b42");
    assert_eq!(result["writes"][1]["class"], "submission");
}

/// Explicit bytes travel as the text the caller typed and are decoded by the
/// server. Nothing in this path asks a shell to produce an escape character,
/// which is the whole reason the flag takes hex rather than a string to
/// interpret.
#[test]
fn send_raw_input_passes_explicit_bytes_through_without_shell_interpretation() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept raw input");
        let (request, body) = read_request(&mut stream);
        assert!(
            request.starts_with("POST /v1/tasks/task-1/raw-input HTTP/1.1"),
            "{request}"
        );
        assert_eq!(body, Some(json!({ "bytes": "1b5b42" })));
        write_json(
            &mut stream,
            "200 OK",
            json!({
                "status": "written",
                "taskId": "task-1",
                "sessionPid": 7,
                "writes": [
                    { "index": 0, "key": null, "bytes": "1b5b42", "class": "draft", "status": "written" }
                ]
            }),
        );
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "send-raw-input",
            "--task-id",
            "task-1",
            "--bytes",
            "1b5b42",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run send-raw-input");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    let result: Value = serde_json::from_slice(&output.stdout).expect("raw input JSON");
    assert_eq!(result["writes"][0]["bytes"], "1b5b42");
    assert!(result["writes"][0]["key"].is_null());
}

/// A task on another machine routes through the local server's relay proxy,
/// like every other catalog tool — the raw-input route is not a local-only
/// side door.
#[test]
fn raw_key_input_routes_to_another_machine_through_the_local_proxy() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut status_stream, _) = listener.accept().expect("accept identity");
        let (request, _) = read_request(&mut status_stream);
        assert!(request.starts_with("GET /v1/status HTTP/1.1"), "{request}");
        write_json(
            &mut status_stream,
            "200 OK",
            json!({ "desktopId": "desktop-local" }),
        );

        let (mut proxy_stream, _) = listener.accept().expect("accept proxy");
        let (request, body) = read_request(&mut proxy_stream);
        assert!(
            request.starts_with("POST /v1/cloud/desktops/desktop-studio/invoke HTTP/1.1"),
            "{request}"
        );
        assert_eq!(
            body,
            Some(json!({
                "method": "POST",
                "path": "/v1/tasks/spike362c3351/raw-input",
                "body": { "keys": ["down", "enter"] }
            }))
        );
        write_json(
            &mut proxy_stream,
            "200 OK",
            json!({
                "status": 200,
                "body": written_response("spike362c3351"),
                "error": null
            }),
        );
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "tool",
            "call",
            "kanna_send_task_raw_input",
            "--machine-id",
            "desktop-studio",
            "--arg",
            "task_id=spike362c3351",
            "--arg",
            "keys=down,enter",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run routed raw input");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("fixture server");
    let result: Value = serde_json::from_slice(&output.stdout).expect("raw input JSON");
    assert_eq!(result["sessionPid"], 42133);
    assert_eq!(result["writes"][1]["bytes"], "0d");
}

/// An uncertain delivery must not read as a success to a shell caller: the
/// process exits non-zero and the reason is on stderr, where a script that
/// checks the status code will actually stop.
#[test]
fn an_uncertain_delivery_exits_non_zero_and_names_the_reason() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept raw input");
        let (_, _) = read_request(&mut stream);
        write_json(
            &mut stream,
            "503 Service Unavailable",
            json!({
                "ok": false,
                "reason": "delivery_uncertain",
                "message": "raw terminal input for task task-1 is uncertain: daemon response lost. Read the task's terminal before acting; resending would type the keys twice.",
                "retryable": false,
                "sessionPid": 7,
                "writes": [
                    { "index": 0, "key": "down", "bytes": "1b5b42", "class": "draft", "status": "written" },
                    { "index": 1, "key": "enter", "bytes": "0d", "class": "submission", "status": "uncertain" }
                ]
            }),
        );
    });

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "send-raw-input",
            "--task-id",
            "task-1",
            "--keys",
            "down,enter",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run send-raw-input");

    assert!(
        !output.status.success(),
        "an uncertain delivery is not a success"
    );
    server.join().expect("fixture server");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("delivery_uncertain"), "{stderr}");
    assert!(
        stderr.contains("resending would type the keys twice"),
        "{stderr}"
    );
}

/// Mutually exclusive flags are caught locally, so a mistake costs a message
/// rather than a round trip into somebody's live terminal.
#[test]
fn keys_and_bytes_together_fail_without_contacting_the_server() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = std::thread::spawn(move || listener.accept().is_ok());

    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "send-raw-input",
            "--task-id",
            "task-1",
            "--keys",
            "down",
            "--bytes",
            "1b",
            "--server-url",
            &format!("http://{address}"),
        ])
        .output()
        .expect("run send-raw-input");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("mutually exclusive"), "{stderr}");
    assert!(!server.is_finished(), "no request should have been sent");
}

/// `--list-keys` is the offline discovery path: it prints the shared
/// vocabulary and exits without a server at all.
#[test]
fn list_keys_prints_the_shared_vocabulary_offline() {
    let output = Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
        .args([
            "task",
            "send-raw-input",
            "--task-id",
            "unused",
            "--list-keys",
            "--server-url",
            "http://127.0.0.1:1",
        ])
        .output()
        .expect("run --list-keys");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    for name in kanna_runtime_defaults::terminal_keys::terminal_key_names() {
        assert!(stdout.contains(name), "{name} missing from --list-keys");
    }
    // The redundant spellings appear only in the explanation of why they are
    // absent, never as listed names.
    assert!(
        !stdout
            .lines()
            .any(|line| line.trim() == "ctrl-m" || line.trim() == "ctrl-i"),
        "{stdout}"
    );
    assert!(stdout.contains("`ctrl-i` and `ctrl-m` are absent"));
    assert!(stdout.contains("Only `enter` declares a submission boundary"));
}
