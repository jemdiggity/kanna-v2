use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

#[path = "../../test-support/old_relay_mobile_notification.rs"]
mod old_relay_mobile_notification;

/// Mirrors `ACTIVITY_CONFIRM_DELAY` in `crates/kanna-mcp/src/main.rs`. A read
/// that engaged the confirmation cannot come back faster than this.
const ACTIVITY_CONFIRM_DELAY: Duration = Duration::from_millis(1_000);

#[derive(Debug)]
struct ExpectedRequest {
    method: &'static str,
    path: &'static str,
    body: Option<Value>,
    response_status: &'static str,
    response_body: Value,
}

#[derive(Debug)]
struct ObservedRequest {
    method: String,
    path: String,
    body: Option<Value>,
    authorization: Option<String>,
}

fn read_http_request(stream: &mut TcpStream) -> ObservedRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");

    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read request");
        assert_ne!(read, 0, "client closed connection before headers");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };

    let headers = String::from_utf8(bytes[..header_end].to_vec()).expect("utf8 headers");
    let request_line = headers.lines().next().expect("request line");
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().expect("method").to_string();
    let path = request_parts.next().expect("path").to_string();
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    let authorization = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim().to_string())
    });

    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("read body");
        assert_ne!(read, 0, "client closed connection before body");
        bytes.extend_from_slice(&buffer[..read]);
    }

    let body = if content_length == 0 {
        None
    } else {
        Some(
            serde_json::from_slice(&bytes[header_end..header_end + content_length])
                .expect("json body"),
        )
    };

    ObservedRequest {
        method,
        path,
        body,
        authorization,
    }
}

fn start_http_fixture(
    expected: Vec<ExpectedRequest>,
) -> (String, thread::JoinHandle<Vec<ObservedRequest>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
    let handle = thread::spawn(move || {
        let mut observed = Vec::new();
        for expected_request in expected {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            assert_eq!(request.method, expected_request.method);
            assert_eq!(request.path, expected_request.path);
            assert_eq!(request.body, expected_request.body);
            observed.push(request);

            let body = expected_request.response_body.to_string();
            let response = format!(
                "HTTP/1.1 {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                expected_request.response_status,
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        }
        observed
    });

    (base_url, handle)
}

fn write_json_response(stream: &mut TcpStream, status: &str, body: &Value) {
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .expect("write response");
}

fn start_multi_machine_event_fixture() -> (String, thread::JoinHandle<Vec<ObservedRequest>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
    let handle = thread::spawn(move || {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut handlers = Vec::new();
        for _ in 0..7 {
            let (mut stream, _) = listener.accept().expect("accept request");
            let observed = Arc::clone(&observed);
            handlers.push(thread::spawn(move || {
                let request = read_http_request(&mut stream);
                if request.method == "GET"
                    && request
                        .path
                        .starts_with("/v1/task-events?taskIds=task-local")
                {
                    thread::sleep(Duration::from_millis(100));
                }
                let (status, response_body) = match (request.method.as_str(), request.path.as_str())
                {
                    ("GET", "/v1/status") => ("200 OK", json!({ "desktopId": "desktop-local" })),
                    ("GET", "/v1/cloud/desktops") => (
                        "200 OK",
                        json!({
                            "currentMachineId": "desktop-local",
                            "relayAvailable": true,
                            "machines": [
                                { "id": "desktop-local", "name": "Local", "isLocal": true },
                                { "id": "desktop-studio", "name": null, "isLocal": false }
                            ]
                        }),
                    ),
                    ("GET", "/v1/tasks/task-local") => (
                        "200 OK",
                        json!({ "id": "task-local", "activity": "working" }),
                    ),
                    ("GET", "/v1/tasks/task-remote") => {
                        ("404 Not Found", json!({ "error": "task not found" }))
                    }
                    ("GET", path) if path.starts_with("/v1/task-events?taskIds=task-local") => (
                        "200 OK",
                        json!({
                            "waitOutcome": "timeout",
                            "cursor": "11",
                            "events": [],
                            "hasMore": false
                        }),
                    ),
                    ("POST", "/v1/cloud/desktops/desktop-studio/invoke") => {
                        let body = request.body.as_ref().expect("proxy request body");
                        match body["path"].as_str().expect("proxy path") {
                            "/v1/tasks/task-remote" => (
                                "200 OK",
                                json!({
                                    "status": 200,
                                    "body": { "id": "task-remote", "activity": "working" },
                                    "error": null
                                }),
                            ),
                            path if path.starts_with("/v1/task-events?taskIds=task-remote") => (
                                "200 OK",
                                json!({
                                    "status": 200,
                                    "body": {
                                        "waitOutcome": "events",
                                        "cursor": "29",
                                        "events": [{
                                            "seq": 29,
                                            "taskId": "task-remote",
                                            "type": "run.finished",
                                            "payload": { "status": "succeeded" }
                                        }],
                                        "hasMore": false
                                    },
                                    "error": null
                                }),
                            ),
                            other => panic!("unexpected proxy path: {other}"),
                        }
                    }
                    other => panic!("unexpected request: {other:?}"),
                };
                write_json_response(&mut stream, status, &response_body);
                observed.lock().expect("observed lock").push(request);
            }));
        }
        for handler in handlers {
            handler.join().expect("fixture request handler");
        }
        Arc::try_unwrap(observed)
            .expect("fixture observations still shared")
            .into_inner()
            .expect("observed lock")
    });
    (base_url, handle)
}

fn run_kanna_mcp(base_url: &str, messages: &[Value]) -> Vec<Value> {
    run_kanna_mcp_with_env(base_url, messages, &[])
}

fn run_kanna_mcp_with_env(
    base_url: &str,
    messages: &[Value],
    env_pairs: &[(&str, &str)],
) -> Vec<Value> {
    let binary = env!("CARGO_BIN_EXE_kanna-mcp");
    let mut child = Command::new(binary)
        .args(["serve", "--server-url", base_url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The spawned binary must only see environment configured by the test.
        // Ambient Kanna context changes tool behavior and catalog resolution.
        .env_clear()
        .envs(env_pairs.iter().copied())
        .spawn()
        .expect("spawn kanna-mcp");

    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for message in messages {
            writeln!(stdin, "{}", message).expect("write message");
        }
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait for kanna-mcp");
    assert!(
        output.status.success(),
        "kanna-mcp exited with {:?}; stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );

    String::from_utf8(output.stdout)
        .expect("utf8 stdout")
        .lines()
        .map(|line| serde_json::from_str(line).expect("json-rpc line"))
        .collect()
}

fn run_kanna_mcp_with_response_cursor(
    base_url: &str,
    messages: &[Value],
    cursor_response_index: usize,
    cursor_request_index: usize,
) -> Vec<Value> {
    let binary = env!("CARGO_BIN_EXE_kanna-mcp");
    let mut child = Command::new(binary)
        .args(["serve", "--server-url", base_url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .spawn()
        .expect("spawn kanna-mcp");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut stdout = BufReader::new(stdout);
    let mut responses = Vec::new();

    for (index, message) in messages.iter().enumerate() {
        let mut message = message.clone();
        if index == cursor_request_index {
            let cursor = tool_text(&responses[cursor_response_index])["cursor"]
                .as_str()
                .expect("cursor from prior response")
                .to_string();
            message["params"]["arguments"]["cursor"] = Value::String(cursor);
        }
        writeln!(stdin, "{message}").expect("write MCP message");
        stdin.flush().expect("flush MCP message");
        let mut line = String::new();
        stdout.read_line(&mut line).expect("read MCP response");
        responses.push(serde_json::from_str(&line).expect("JSON-RPC response"));
    }

    drop(stdin);
    let output = child.wait_with_output().expect("wait for kanna-mcp");
    assert!(
        output.status.success(),
        "kanna-mcp exited with {:?}; stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    responses
}

fn spawn_kanna_mcp_for_reload(cwd: &std::path::Path) -> std::process::Child {
    let binary = env!("CARGO_BIN_EXE_kanna-mcp");
    Command::new(binary)
        .args(["serve", "--server-url", "http://127.0.0.1:9"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .spawn()
        .expect("spawn kanna-mcp")
}

fn send_mcp_message(stdin: &mut std::process::ChildStdin, message: Value) {
    writeln!(stdin, "{message}").expect("write mcp message");
    stdin.flush().expect("flush mcp stdin");
}

fn recv_json_line(receiver: &mpsc::Receiver<Value>) -> Value {
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("json-rpc line")
}

fn recv_until_id(receiver: &mpsc::Receiver<Value>, id: i64) -> Value {
    loop {
        let value = recv_json_line(receiver);
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return value;
        }
    }
}

fn recv_until_method(receiver: &mpsc::Receiver<Value>, method: &str) -> Value {
    loop {
        let value = recv_json_line(receiver);
        if value.get("method").and_then(Value::as_str) == Some(method) {
            return value;
        }
    }
}

fn tool_text(response: &Value) -> Value {
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    serde_json::from_str(text).expect("tool json")
}

fn tool_error_text(response: &Value) -> &str {
    assert_eq!(
        response["result"]["isError"],
        json!(true),
        "tool failure should be an isError result: {response}"
    );
    response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool error text")
}

fn info_call(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": "kanna_info", "arguments": {} }
    })
}

fn status_fixture(environment: &str, version: &str, lan_port: u16) -> Value {
    json!({
        "state": "running",
        "desktopId": format!("desktop-{environment}"),
        "desktopName": format!("Kanna {environment}"),
        "version": version,
        "environment": environment,
        "serverVersion": version,
        "lanHost": "192.168.10.8",
        "lanPort": lan_port,
        "pairingCode": "PAIR-SECRET",
        "kspStreamVersion": 2,
        "writePathHealth": {
            "healthy": true,
            "status": "healthy",
            "activeWorkspaceCommands": 1,
            "maxWorkspaceCommands": 4,
            "longRunningWorkspaceCommands": 0,
            "oldestWorkspaceCommandSeconds": null
        },
        "authToken": "AUTH-SECRET",
        "appleCredential": "APPLE-SECRET",
        "githubToken": "GITHUB-SECRET",
        "databasePath": "/secret/kanna.sqlite3"
    })
}

#[test]
fn kanna_info_reports_configured_connection_and_allow_listed_server_identity() {
    for (environment, version, lan_port) in [
        ("staging", "0.0.69-staging.3", 48121),
        ("production", "0.0.69", 48120),
    ] {
        let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: status_fixture(environment, version, lan_port),
        }]);
        let configured_port = base_url
            .rsplit_once(':')
            .expect("fixture URL port")
            .1
            .parse::<u16>()
            .expect("configured port");

        let responses = run_kanna_mcp_with_env(
            &base_url,
            &[info_call(41)],
            &[("KANNA_TASK_ID", "task-runtime-info")],
        );
        let observed = server.join().expect("fixture server");
        assert_eq!(observed.len(), 1);
        let info = tool_text(&responses[0]);

        assert_eq!(info["clientAdapter"]["name"], "kanna-mcp");
        assert_eq!(info["clientAdapter"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(info["clientAdapter"]["mcpProtocolVersion"], "2025-11-25");
        assert_eq!(info["connection"]["effectiveBaseUrl"], base_url);
        assert_eq!(info["connection"]["host"], "127.0.0.1");
        assert_eq!(info["connection"]["port"], configured_port);
        assert_eq!(info["serverStatus"]["available"], true);
        assert_eq!(info["serverStatus"]["environment"], environment);
        assert_eq!(info["serverStatus"]["version"], version);
        assert_eq!(info["serverStatus"]["state"], "running");
        assert_eq!(
            info["serverStatus"]["desktop"],
            json!({
                "id": format!("desktop-{environment}"),
                "name": format!("Kanna {environment}")
            })
        );
        assert_eq!(
            info["lanAdvertisedEndpoint"],
            json!({ "host": "192.168.10.8", "port": lan_port })
        );
        assert_ne!(
            info["connection"]["host"], info["lanAdvertisedEndpoint"]["host"],
            "the configured transport endpoint must stay distinct from LAN advertisement"
        );
        assert_eq!(info["serverStatus"]["capabilityVersions"]["kspStream"], 2);
        assert_eq!(info["serverStatus"]["writePathHealth"]["healthy"], true);
        assert_eq!(info["taskContext"]["taskId"], "task-runtime-info");

        let rendered = info.to_string();
        for forbidden in [
            "pairingCode",
            "PAIR-SECRET",
            "authToken",
            "AUTH-SECRET",
            "APPLE-SECRET",
            "GITHUB-SECRET",
            "databasePath",
            "/secret/kanna.sqlite3",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "kanna_info leaked forbidden status data: {forbidden}"
            );
        }
    }
}

#[test]
fn kanna_info_retains_adapter_and_endpoint_when_status_is_unreachable() {
    let reservation = TcpListener::bind("127.0.0.1:0").expect("reserve unreachable port");
    let port = reservation.local_addr().expect("local address").port();
    drop(reservation);
    let base_url = format!("http://127.0.0.1:{port}");

    let responses = run_kanna_mcp(&base_url, &[info_call(42)]);
    let response = &responses[0];
    assert!(
        response["result"].get("isError").is_none(),
        "status failure is runtime data, not an MCP tool invocation failure"
    );
    let info = tool_text(response);

    assert_eq!(info["clientAdapter"]["name"], "kanna-mcp");
    assert_eq!(info["connection"]["effectiveBaseUrl"], base_url);
    assert_eq!(info["connection"]["port"], port);
    assert_eq!(info["serverStatus"]["available"], false);
    assert!(info["serverStatus"]["error"]
        .as_str()
        .expect("server status error")
        .contains("failed to reach the configured server"));
    assert!(info["serverStatus"]["environment"].is_null());
    assert!(info["lanAdvertisedEndpoint"].is_null());
}

#[test]
fn kanna_info_does_not_echo_status_error_bodies() {
    let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
        method: "GET",
        path: "/v1/status",
        body: None,
        response_status: "503 Service Unavailable",
        response_body: json!({
            "error": "PAIR-SECRET AUTH-SECRET /private/kanna.sqlite3"
        }),
    }]);

    let responses = run_kanna_mcp(&base_url, &[info_call(43)]);
    server.join().expect("fixture server");
    let info = tool_text(&responses[0]);

    assert_eq!(info["serverStatus"]["available"], false);
    assert_eq!(
        info["serverStatus"]["error"],
        "GET /v1/status failed with status 503 Service Unavailable"
    );
    let rendered = info.to_string();
    for forbidden in ["PAIR-SECRET", "AUTH-SECRET", "/private/kanna.sqlite3"] {
        assert!(!rendered.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn serve_hot_reloads_catalog_override_and_notifies_tools_changed() {
    let root = std::env::temp_dir().join(format!("kanna-mcp-stdio-reload-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".kanna")).expect("create .kanna");

    let mut child = spawn_kanna_mcp_for_reload(&root);
    let stdout = child.stdout.take().expect("stdout");
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = line.expect("read stdout line");
            let value = serde_json::from_str::<Value>(&line).expect("json-rpc line");
            sender.send(value).expect("send json-rpc line");
        }
    });

    let mut stdin = child.stdin.take().expect("stdin");
    send_mcp_message(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
    );
    send_mcp_message(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    );

    let _initialize = recv_until_id(&receiver, 1);
    let baseline = recv_until_id(&receiver, 2);
    let baseline_tools = baseline["result"]["tools"]
        .as_array()
        .expect("baseline tools");
    assert!(baseline_tools
        .iter()
        .any(|tool| tool["name"] == "kanna_list_repos"));
    assert!(!baseline_tools
        .iter()
        .any(|tool| tool["name"] == "kanna_custom_ping"));

    let mut catalog = kanna_tool_catalog::bundled_catalog();
    let custom_tool: kanna_tool_catalog::ToolDef = serde_json::from_value(json!({
        "name": "kanna_custom_ping",
        "description": "Custom ping",
        "method": "GET",
        "path": "/v1/ping",
        "response": "json",
        "params": []
    }))
    .expect("custom tool");
    catalog.tools.push(custom_tool);
    let catalog_json = serde_json::to_string(&catalog).expect("serialize catalog");
    std::fs::write(root.join(".kanna/mcp-tools.json"), catalog_json).expect("write catalog");

    let notification = recv_until_method(&receiver, "notifications/tools/list_changed");
    assert_eq!(notification["jsonrpc"], json!("2.0"));

    send_mcp_message(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
    );
    let reloaded = recv_until_id(&receiver, 3);
    let reloaded_tools = reloaded["result"]["tools"]
        .as_array()
        .expect("reloaded tools");
    assert!(reloaded_tools
        .iter()
        .any(|tool| tool["name"] == "kanna_custom_ping"));

    drop(stdin);
    let status = child.wait().expect("wait for child");
    assert!(status.success(), "kanna-mcp exited with {status}");
    reader.join().expect("reader thread");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn serve_forwards_get_and_post_tool_calls_to_configured_http_server() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/repos",
            body: None,
            response_status: "200 OK",
            response_body: json!([{ "id": "repo-1", "name": "kanna" }]),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-1?agentView=true",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "id": "task-1",
                "repoId": "repo-1",
                "title": "Review MCP",
                "stage": "in progress",
                "activity": "working",
                "agentType": "pty",
                "agentProvider": "claude",
                "branch": "task-task-1",
                "prUrl": null,
                "closedAt": null,
                "latestRun": { "id": "run-review-1" }
            }),
        },
        ExpectedRequest {
            method: "POST",
            path: "/v1/tasks/task-1/actions/complete-stage",
            body: Some(json!({
                "status": "success",
                "summary": "QA passed",
                "metadata": { "review": "stdio-http" }
            })),
            response_status: "200 OK",
            response_body: json!({ "taskId": "task-1", "stage": "pr" }),
        },
    ]);

    let responses = run_kanna_mcp(
        &base_url,
        &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": { "name": "kanna_list_repos", "arguments": {} }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "kanna_get_task",
                    "arguments": { "task_id": "task-1" }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "kanna_complete_stage",
                    "arguments": {
                        "task_id": "task-1",
                        "status": "success",
                        "summary": "QA passed",
                        "metadata": { "review": "stdio-http" }
                    }
                }
            }),
        ],
    );

    let observed = server.join().expect("fixture server");
    assert_eq!(observed.len(), 3);
    assert_eq!(responses.len(), 4);
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "kanna-mcp");
    assert_eq!(
        tool_text(&responses[1]),
        json!([{ "id": "repo-1", "name": "kanna" }])
    );
    assert_eq!(
        tool_text(&responses[2]),
        json!({
            "id": "task-1",
            "repoId": "repo-1",
            "title": "Review MCP",
            "stage": "in progress",
            "activity": "working",
            "agentType": "pty",
            "agentProvider": "claude",
            "branch": "task-task-1",
            "prUrl": null,
            "closedAt": null,
            "latestRun": { "id": "run-review-1" }
        })
    );
    assert_eq!(
        tool_text(&responses[3]),
        json!({ "taskId": "task-1", "stage": "pr" })
    );
}

#[test]
fn completion_retry_after_a_lost_response_keeps_the_spawned_run_identity() {
    let root = std::env::temp_dir().join(format!(
        "kanna-mcp-completion-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("completion context directory");
    let context_path = root.join("completion.json");
    kanna_tool_catalog::write_completion_context(
        &context_path,
        &kanna_tool_catalog::CompletionContext::new("run-original"),
    )
    .expect("write completion context");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let base_url = format!("http://{}", listener.local_addr().expect("fixture address"));
    let server_context_path = context_path.clone();
    let server = thread::spawn(move || {
        let mut observed = Vec::new();
        for attempt in 0..2 {
            let (mut stream, _) = listener.accept().expect("accept completion request");
            observed.push(read_http_request(&mut stream));
            if attempt == 0 {
                // The server may already have committed this request and started
                // a replacement run; losing the response must not make the
                // adapter rediscover and complete that replacement.
                let attempt_key = observed[0].body.as_ref().unwrap()["completionAttemptKey"]
                    .as_str()
                    .unwrap();
                kanna_tool_catalog::mutate_completion_context(&server_context_path, |current| {
                    let mut context = current.unwrap();
                    context.record_completed_attempt("run-original", attempt_key);
                    context.run_id = "run-post".to_string();
                    Ok(context)
                })
                .expect("server should atomically advance completion context");
                continue;
            }
            let body = json!({ "taskId": "task-1" }).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write retry response");
        }
        observed
    });
    let context_path_string = context_path.to_string_lossy().to_string();
    let call = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "kanna_complete_stage",
            "arguments": {
                "task_id": "task-1",
                "status": "success",
                "summary": "completed once"
            }
        }
    });
    let responses = run_kanna_mcp_with_env(
        &base_url,
        &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
            call.clone(),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": call["params"].clone() }),
        ],
        &[(
            kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV,
            &context_path_string,
        )],
    );

    let observed = server.join().expect("fixture server");
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0].method, "POST");
    assert_eq!(observed[1].method, "POST");
    assert_eq!(observed[0].body, observed[1].body);
    assert_eq!(
        observed[0].body.as_ref().and_then(|body| body.get("runId")),
        Some(&json!("run-original"))
    );
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[1]["result"]["isError"], json!(true));
    assert_eq!(tool_text(&responses[2]), json!({ "taskId": "task-1" }));
    let context =
        kanna_tool_catalog::read_completion_context(&context_path).expect("read completed context");
    assert_eq!(context.run_id, "run-post");
    assert_eq!(
        context.run_for_attempt(
            observed[0].body.as_ref().unwrap()["completionAttemptKey"]
                .as_str()
                .unwrap()
        ),
        Some("run-original")
    );
    std::fs::remove_dir_all(root).expect("remove completion context directory");
}

#[test]
fn serve_infers_create_task_repo_from_current_task_context() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-current",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "id": "task-current",
                "repoId": "repo-current",
                "title": "Current task",
                "stage": "in progress",
                "activity": "working"
            }),
        },
        ExpectedRequest {
            method: "POST",
            path: "/v1/tasks",
            body: Some(json!({
                "repoId": "repo-current",
                "prompt": "Create the child task",
                "agentType": "pty"
            })),
            response_status: "200 OK",
            response_body: json!({
                "taskId": "task-child",
                "repoId": "repo-current",
                "title": "Create the child task",
                "stage": "in progress",
                "agentType": "pty"
            }),
        },
    ]);

    let responses = run_kanna_mcp_with_env(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {
                "name": "kanna_create_task",
                "arguments": {
                    "prompt": "Create the child task"
                }
            }
        })],
        &[("KANNA_TASK_ID", "task-current")],
    );

    let observed = server.join().expect("fixture server");
    assert_eq!(observed.len(), 2);
    assert_eq!(responses.len(), 1);
    assert_eq!(
        tool_text(&responses[0]),
        json!({
            "taskId": "task-child",
            "repoId": "repo-current",
            "title": "Create the child task",
            "stage": "in progress",
            "agentType": "pty"
        })
    );
}

#[test]
fn serve_defaults_listing_search_and_tail_watch_to_current_task_repo() {
    let current_task = json!({
        "id": "task-current",
        "repoId": "repo-current",
        "title": "Current task",
        "stage": "in progress",
        "activity": "working"
    });
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-current",
            body: None,
            response_status: "200 OK",
            response_body: current_task.clone(),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/recent?repoId=repo-current",
            body: None,
            response_status: "200 OK",
            response_body: json!([]),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-current",
            body: None,
            response_status: "200 OK",
            response_body: current_task.clone(),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/search?query=review&repoId=repo-current",
            body: None,
            response_status: "200 OK",
            response_body: json!([]),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-current",
            body: None,
            response_status: "200 OK",
            response_body: current_task,
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/task-events?repoId=repo-current&shortCursor=true&from=now&timeoutSecs=0",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "waitOutcome": "timeout",
                "cursor": "kh1.tail",
                "events": [],
                "hasMore": false
            }),
        },
    ]);

    let responses = run_kanna_mcp_with_env(
        &base_url,
        &[
            json!({
                "jsonrpc": "2.0", "id": 13, "method": "tools/call",
                "params": { "name": "kanna_list_recent_tasks", "arguments": {} }
            }),
            json!({
                "jsonrpc": "2.0", "id": 14, "method": "tools/call",
                "params": { "name": "kanna_search_tasks", "arguments": { "query": "review" } }
            }),
            json!({
                "jsonrpc": "2.0", "id": 15, "method": "tools/call",
                "params": { "name": "kanna_wait_events", "arguments": { "from": "now", "timeout_secs": 0 } }
            }),
        ],
        &[("KANNA_TASK_ID", "task-current")],
    );

    assert_eq!(server.join().expect("fixture server").len(), 6);
    assert!(
        responses
            .iter()
            .all(|response| response.get("error").is_none()
                && response["result"]["content"].is_array()),
        "{responses:#?}"
    );
}

#[test]
fn serve_routes_task_listing_and_creation_to_an_explicit_machine() {
    let proxy_path = "/v1/cloud/desktops/desktop-studio/invoke";
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "POST",
            path: proxy_path,
            body: Some(json!({
                "method": "GET",
                "path": "/v1/tasks/recent",
                "body": null
            })),
            response_status: "200 OK",
            response_body: json!({
                "status": 200,
                "body": [{
                    "id": "task-remote",
                    "repoId": "repo-remote",
                    "title": "Remote task",
                    "stage": "in progress",
                    "activity": "working"
                }],
                "error": null
            }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "POST",
            path: proxy_path,
            body: Some(json!({
                "method": "POST",
                "path": "/v1/tasks",
                "body": {
                    "repoId": "repo-remote",
                    "prompt": "Run this on the Studio",
                    "agentType": "pty"
                }
            })),
            response_status: "200 OK",
            response_body: json!({
                "status": 200,
                "body": {
                    "taskId": "task-created-remote",
                    "repoId": "repo-remote",
                    "title": "Run this on the Studio",
                    "stage": "in progress",
                    "agentType": "pty"
                },
                "error": null
            }),
        },
    ]);

    let responses = run_kanna_mcp(
        &base_url,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 30,
                "method": "tools/call",
                "params": {
                    "name": "kanna_list_recent_tasks",
                    "arguments": { "machine_id": "desktop-studio" }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 31,
                "method": "tools/call",
                "params": {
                    "name": "kanna_create_task",
                    "arguments": {
                        "machine_id": "desktop-studio",
                        "repo_id": "repo-remote",
                        "prompt": "Run this on the Studio"
                    }
                }
            }),
        ],
    );

    server.join().expect("fixture server");
    assert_eq!(tool_text(&responses[0])[0]["id"], "task-remote");
    assert_eq!(tool_text(&responses[1])["taskId"], "task-created-remote");
}

#[test]
fn task_session_requires_explicit_repo_for_sibling_machine_listings() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
    ]);

    let responses = run_kanna_mcp_with_env(
        &base_url,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 32,
                "method": "tools/call",
                "params": {
                    "name": "kanna_list_recent_tasks",
                    "arguments": { "machine_id": "desktop-studio" }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 33,
                "method": "tools/call",
                "params": {
                    "name": "kanna_search_tasks",
                    "arguments": {
                        "machine_id": "desktop-studio",
                        "query": "review"
                    }
                }
            }),
        ],
        &[("KANNA_TASK_ID", "task-current")],
    );

    let observed = server.join().expect("fixture server");
    assert_eq!(observed.len(), 2);
    for response in responses {
        let message = tool_error_text(&response);
        assert!(message.contains("repo_id is required"), "{message}");
        assert!(message.contains("desktop-studio"), "{message}");
        assert!(
            message.contains("repository IDs are machine-local"),
            "{message}"
        );
        assert!(message.contains("kanna_list_repos"), "{message}");
    }
}

#[test]
fn explicit_self_machine_id_uses_local_http_without_relay_discovery() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/recent",
            body: None,
            response_status: "200 OK",
            response_body: json!([]),
        },
    ]);

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {
                "name": "kanna_list_recent_tasks",
                "arguments": { "machine_id": "desktop-local" }
            }
        })],
    );

    let observed = server.join().expect("fixture server");
    assert_eq!(tool_text(&responses[0]), json!([]));
    assert!(observed
        .iter()
        .all(|request| request.path != "/v1/cloud/desktops" && !request.path.contains("/invoke")));
}

#[test]
fn tools_list_advertises_machine_routing_on_operational_tools() {
    let responses = run_kanna_mcp(
        "http://127.0.0.1:9",
        &[json!({
            "jsonrpc": "2.0",
            "id": 32,
            "method": "tools/list"
        })],
    );
    let tools = responses[0]["result"]["tools"].as_array().unwrap();
    let list_machines = tools
        .iter()
        .find(|tool| tool["name"] == "kanna_list_machines")
        .expect("machine discovery tool");
    assert!(list_machines["inputSchema"]["properties"]["machine_id"].is_null());
    let list_tasks = tools
        .iter()
        .find(|tool| tool["name"] == "kanna_list_recent_tasks")
        .expect("task listing tool");
    assert_eq!(
        list_tasks["inputSchema"]["properties"]["machine_id"]["type"],
        "string"
    );
    let complete_stage = tools
        .iter()
        .find(|tool| tool["name"] == "kanna_complete_stage")
        .expect("complete stage tool");
    assert!(complete_stage["inputSchema"]["properties"]["machine_id"].is_null());
}

#[test]
fn complete_stage_rejects_remote_machine_without_issuing_http() {
    let (base_url_tx, base_url_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        base_url_tx
            .send(format!(
                "http://{}",
                listener.local_addr().expect("local addr")
            ))
            .expect("send base url");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");
        thread::sleep(Duration::from_millis(200));
        assert!(
            listener.accept().is_err(),
            "remote stage completion should not issue HTTP requests"
        );
    });
    let base_url = base_url_rx.recv().expect("base url");

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 33,
            "method": "tools/call",
            "params": {
                "name": "kanna_complete_stage",
                "arguments": {
                    "machine_id": "desktop-studio",
                    "task_id": "task-remote",
                    "status": "success",
                    "summary": "should stay local"
                }
            }
        })],
    );

    server.join().expect("fixture server");
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], json!(33));
    assert_eq!(
        tool_error_text(&responses[0]),
        "kanna_complete_stage cannot target another machine; an agent can only complete its own local stage"
    );
}

#[test]
fn serve_lists_machines_through_the_local_server() {
    let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
        method: "GET",
        path: "/v1/cloud/desktops",
        body: None,
        response_status: "200 OK",
        response_body: json!({
            "currentMachineId": "desktop-local",
            "relayAvailable": true,
            "machines": [
                { "id": "desktop-local", "name": "Local Mac", "isLocal": true },
                { "id": "desktop-studio", "name": null, "isLocal": false }
            ]
        }),
    }]);
    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 33,
            "method": "tools/call",
            "params": { "name": "kanna_list_machines", "arguments": {} }
        })],
    );

    server.join().expect("fixture server");
    let result = tool_text(&responses[0]);
    assert_eq!(result["currentMachineId"], "desktop-local");
    assert_eq!(result["machines"][1]["id"], "desktop-studio");
}

#[test]
fn wait_events_discovers_task_owners_and_waits_across_machines() {
    let (base_url, server) = start_multi_machine_event_fixture();
    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 34,
            "method": "tools/call",
            "params": {
                "name": "kanna_wait_events",
                "arguments": {
                    "task_ids": ["task-local", "task-remote"],
                    "timeout_secs": 5
                }
            }
        })],
    );

    let observed = server.join().expect("fixture server");
    let result = tool_text(&responses[0]);
    assert_eq!(result["waitOutcome"], "events", "{result}");
    assert_eq!(result["events"][0]["taskId"], "task-remote");
    assert_eq!(result["events"][0]["machineId"], "desktop-studio");
    assert!(result["cursor"]
        .as_str()
        .is_some_and(|cursor| cursor.starts_with("kmh1.")));
    assert_eq!(result["cursor"].as_str().map(str::len), Some(13));
    assert_eq!(result["machineErrors"], json!([]));

    assert!(observed.iter().any(|request| {
        request.method == "GET"
            && request
                .path
                .starts_with("/v1/task-events?taskIds=task-local")
    }));
    assert!(observed.iter().any(|request| {
        request.method == "POST"
            && request.path == "/v1/cloud/desktops/desktop-studio/invoke"
            && request.body.as_ref().is_some_and(|body| {
                body["path"]
                    .as_str()
                    .is_some_and(|path| path.starts_with("/v1/task-events?taskIds=task-remote"))
            })
    }));
}

#[test]
fn repo_wait_reads_the_local_credential_file_and_sends_bearer_authorization() {
    let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
        method: "GET",
        path: "/v1/task-events?repoId=repo-1&shortCursor=true&timeoutSecs=0",
        body: None,
        response_status: "200 OK",
        response_body: json!({
            "waitOutcome": "timeout",
            "cursor": "ks1.fixture",
            "events": [],
            "hasMore": false,
            "machineErrors": []
        }),
    }]);
    let token_path = std::env::temp_dir().join(format!(
        "kanna-mcp-task-events-token-{}",
        std::process::id()
    ));
    std::fs::write(&token_path, "fixture-local-token\n").expect("write token fixture");
    let token_path_string = token_path.to_string_lossy().to_string();
    let responses = run_kanna_mcp_with_env(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 341,
            "method": "tools/call",
            "params": {
                "name": "kanna_wait_events",
                "arguments": { "repo_id": "repo-1", "timeout_secs": 0 }
            }
        })],
        &[("KANNA_TASK_EVENTS_TOKEN_PATH", token_path_string.as_str())],
    );

    let observed = server.join().expect("fixture server");
    let _ = std::fs::remove_file(token_path);
    assert_eq!(tool_text(&responses[0])["cursor"], "ks1.fixture");
    assert_eq!(observed.len(), 1);
    assert_eq!(
        observed[0].authorization.as_deref(),
        Some("Bearer fixture-local-token")
    );
}

#[test]
fn all_local_event_wait_does_not_require_relay_discovery() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-local",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "id": "task-local", "activity": "working" }),
        },
        ExpectedRequest {
            method: "GET",
            path:
                "/v1/task-events?taskIds=task-local&localOnly=true&shortCursor=true&timeoutSecs=5",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "waitOutcome": "events",
                "cursor": "12",
                "events": [{
                    "seq": 12,
                    "taskId": "task-local",
                    "type": "stage.changed",
                    "payload": {}
                }],
                "hasMore": false
            }),
        },
    ]);
    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 35,
            "method": "tools/call",
            "params": {
                "name": "kanna_wait_events",
                "arguments": { "task_ids": ["task-local"], "timeout_secs": 5 }
            }
        })],
    );

    server.join().expect("fixture server");
    let result = tool_text(&responses[0]);
    assert_eq!(result["waitOutcome"], "events", "{result}");
    assert_eq!(result["events"][0]["machineId"], "desktop-local");
}

#[test]
fn short_aggregate_cursor_preserves_continuity_across_calls() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-local",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "id": "task-local" }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/task-events?taskIds=task-local&localOnly=true&shortCursor=true&timeoutSecs=0",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "waitOutcome": "events",
                "cursor": "12",
                "events": [{ "seq": 12, "taskId": "task-local", "type": "run.started", "payload": {} }],
                "hasMore": false
            }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/task-events?taskIds=task-local&localOnly=true&shortCursor=true&cursor=12&timeoutSecs=0",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "waitOutcome": "events",
                "cursor": "13",
                "events": [{ "seq": 13, "taskId": "task-local", "type": "run.finished", "payload": {} }],
                "hasMore": false
            }),
        },
    ]);
    let calls = [
        json!({
            "jsonrpc": "2.0", "id": 351, "method": "tools/call",
            "params": { "name": "kanna_wait_events", "arguments": {
                "task_ids": ["task-local"], "timeout_secs": 0
            }}
        }),
        // Filled by the test harness below after the first response would be
        // impossible over static input, so use the documented short handle's
        // deterministic shape through a direct two-call MCP session fixture.
        json!({
            "jsonrpc": "2.0", "id": 352, "method": "tools/call",
            "params": { "name": "kanna_wait_events", "arguments": {
                "task_ids": ["task-local"], "cursor": "__FIRST_CURSOR__", "timeout_secs": 0
            }}
        }),
    ];

    let responses = run_kanna_mcp_with_response_cursor(&base_url, &calls, 0, 1);
    server.join().expect("fixture server");
    let first = tool_text(&responses[0]);
    let second = tool_text(&responses[1]);
    assert!(first["cursor"]
        .as_str()
        .is_some_and(|value| value.starts_with("kmh1.")));
    assert_eq!(first["events"][0]["seq"], 12);
    assert_eq!(second["events"][0]["seq"], 13);
    assert_ne!(first["cursor"], second["cursor"]);
}

#[test]
fn routed_cursor_rejection_invalidates_the_fan_in_checkpoint() {
    let cursor_body = serde_json::to_vec(&json!({
        "localMachineId": "desktop-local",
        "taskIdsByMachine": { "desktop-studio": ["task-remote"] },
        "cursorsByMachine": { "desktop-studio": "ksh1.deadbeef" }
    }))
    .expect("encode cursor body");
    let cursor = format!(
        "km1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cursor_body)
    );
    let machine_path = "/v1/task-events?taskIds=task-remote&localOnly=true&shortCursor=true&cursor=ksh1.deadbeef&timeoutSecs=0";
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/status",
            body: None,
            response_status: "200 OK",
            response_body: json!({ "desktopId": "desktop-local" }),
        },
        ExpectedRequest {
            method: "POST",
            path: "/v1/cloud/desktops/desktop-studio/invoke",
            body: Some(json!({
                "method": "GET",
                "path": machine_path,
                "body": null
            })),
            response_status: "200 OK",
            response_body: json!({
                "status": 400,
                "body": "task-event cursor handle is invalid or expired; restart without a cursor to safely replay retained history",
                "error": "task-event cursor handle is invalid or expired; restart without a cursor to safely replay retained history"
            }),
        },
    ]);
    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 353,
            "method": "tools/call",
            "params": {
                "name": "kanna_wait_events",
                "arguments": {
                    "task_ids": ["task-remote"],
                    "cursor": cursor,
                    "timeout_secs": 0
                }
            }
        })],
    );

    server.join().expect("fixture server");
    let error = tool_error_text(&responses[0]);
    assert!(error.contains("machine desktop-studio rejected its embedded task-event cursor"));
    assert!(error.contains("restart kanna_wait_events without a cursor"));
    assert!(error.contains("replay retained history"));
    assert!(
        !error.contains("kmh1."),
        "must not return a continuation: {error}"
    );
}

#[test]
fn aggregate_cursor_rejects_a_stale_or_tampered_local_machine_identity() {
    let cursor_body = serde_json::to_vec(&json!({
        "localMachineId": "desktop-stale",
        "taskIdsByMachine": { "desktop-stale": ["task-local"] },
        "cursorsByMachine": {}
    }))
    .expect("encode cursor body");
    let cursor = format!(
        "km1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cursor_body)
    );
    let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
        method: "GET",
        path: "/v1/status",
        body: None,
        response_status: "200 OK",
        response_body: json!({ "desktopId": "desktop-local" }),
    }]);

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 36,
            "method": "tools/call",
            "params": {
                "name": "kanna_wait_events",
                "arguments": {
                    "task_ids": ["task-local"],
                    "cursor": cursor,
                    "timeout_secs": 0
                }
            }
        })],
    );

    server.join().expect("fixture server");
    assert_eq!(
        tool_error_text(&responses[0]),
        "multi-machine event cursor belongs to local machine desktop-stale, but this client is connected to desktop-local"
    );
}

/// Serves `GET /v1/tasks/{id}` from a mutable body for as many polls as a wait
/// makes, so a test can flip a child task from running to finished between
/// waits without pinning the exact poll count.
fn start_task_detail_fixture(state: Arc<Mutex<Value>>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
    let polls = Arc::new(AtomicUsize::new(0));
    let served = polls.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                return;
            };
            let request = read_http_request(&mut stream);
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/v1/tasks/child-1?agentView=true");
            served.fetch_add(1, Ordering::SeqCst);
            let body = state.lock().expect("state lock").to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });

    (base_url, polls)
}

/// A child task in one runtime state. `activity` follows it the way the server
/// derives the display value, so the fixture stays the shape a real response
/// has — but the wait reads `runtimeState`.
fn child_task(runtime_state: &str) -> Value {
    let (activity, read_state) = match runtime_state {
        "busy" => ("working", "read"),
        _ => ("unread", "unread"),
    };
    json!({
        "id": "child-1",
        "repoId": "repo-1",
        "title": "Specialty review",
        "stage": "review",
        "activity": activity,
        "runtimeState": runtime_state,
        "readState": read_state,
        "branch": "task-child-1",
        "prUrl": null,
        "closedAt": null
    })
}

/// A dispatcher waiting on child tasks calls this tool in a loop across
/// separate MCP processes. A wait that runs out its window must come back as a
/// normal result carrying the task state, so the next call resumes the loop.
#[test]
fn serve_returns_wait_timeouts_as_results_the_agent_can_call_again() {
    let state = Arc::new(Mutex::new(child_task("busy")));
    let (base_url, polls) = start_task_detail_fixture(state.clone());
    let wait_call = json!({
        "jsonrpc": "2.0",
        "id": 20,
        "method": "tools/call",
        "params": {
            "name": "kanna_wait_task",
            "arguments": { "task_id": "child-1", "timeout_secs": 2, "poll_secs": 1 }
        }
    });

    let responses = run_kanna_mcp(&base_url, std::slice::from_ref(&wait_call));

    assert_eq!(responses.len(), 1);
    assert_ne!(
        responses[0]["result"]["isError"],
        json!(true),
        "a wait that runs out its window is a normal result: {}",
        responses[0]
    );
    let timed_out = tool_text(&responses[0]);
    assert_eq!(timed_out["waitOutcome"], json!("timeout"));
    assert_eq!(timed_out["waitTimeoutSecs"], json!(2));
    assert_eq!(timed_out["id"], json!("child-1"));
    assert_eq!(timed_out["stage"], json!("review"));
    assert_eq!(timed_out["runtimeState"], json!("busy"));
    assert!(timed_out["waitHint"]
        .as_str()
        .is_some_and(|hint| hint.contains("call kanna_wait_task again")));

    *state.lock().expect("state lock") = child_task("exited");
    let responses = run_kanna_mcp(&base_url, &[wait_call]);

    let resolved = tool_text(&responses[0]);
    assert_eq!(resolved["waitOutcome"], json!("resolved"));
    assert_eq!(resolved["id"], json!("child-1"));
    assert_eq!(resolved["stage"], json!("review"));
    assert_eq!(resolved["runtimeState"], json!("exited"));
    assert!(resolved["waitHint"].is_null());
    assert!(
        polls.load(Ordering::SeqCst) >= 2,
        "the first wait should have polled before giving up"
    );
}

#[test]
fn serve_reports_http_failures_as_tool_error_results() {
    let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
        method: "GET",
        path: "/v1/repos",
        body: None,
        response_status: "503 Service Unavailable",
        response_body: json!({ "error": "offline" }),
    }]);

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": { "name": "kanna_list_repos", "arguments": {} }
        })],
    );

    server.join().expect("fixture server");
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], json!(9));
    let message = tool_error_text(&responses[0]);
    assert!(message.contains("GET /v1/repos failed with status 503"));
    assert!(
        message.contains("offline"),
        "error message should include the response body: {message}"
    );
}

#[tokio::test]
async fn notify_mobile_surfaces_only_the_fixed_server_rejection_error() {
    use old_relay_mobile_notification::{
        OldRelayMobileNotificationServer, OLD_RELAY_CANARY, SAFE_REJECTION_ERROR,
    };

    let server = OldRelayMobileNotificationServer::start("mcp").await;

    let responses = run_kanna_mcp(
        &server.base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 91,
            "method": "tools/call",
            "params": {
                "name": "kanna_notify_mobile",
                "arguments": {
                    "title": "Provider call rejected",
                    "body": "Exercise the server relay boundary."
                }
            }
        })],
    );

    let logs = server.finish();
    assert_eq!(responses.len(), 1);
    let message = tool_error_text(&responses[0]);
    assert!(
        message.contains(SAFE_REJECTION_ERROR),
        "unexpected MCP error: {message}"
    );
    assert!(!message.contains(OLD_RELAY_CANARY));
    assert!(!responses[0].to_string().contains(OLD_RELAY_CANARY));
    assert!(!logs.contains(OLD_RELAY_CANARY));
}

#[test]
fn serve_reports_server_error_bodies_for_failed_actions() {
    let (base_url, server) = start_http_fixture(vec![ExpectedRequest {
        method: "POST",
        path: "/v1/tasks/task-1/actions/request-revision",
        body: Some(json!({
            "targetStage": "in progress",
            "summary": "QA failed",
            "prompt": "Add the missing coverage."
        })),
        response_status: "500 Internal Server Error",
        response_body: json!("failed to create worktree: No space left on device"),
    }]);

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "kanna_request_revision",
                "arguments": {
                    "task_id": "task-1",
                    "target_stage": "in progress",
                    "summary": "QA failed",
                    "prompt": "Add the missing coverage."
                }
            }
        })],
    );

    server.join().expect("fixture server");
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], json!(10));
    let message = tool_error_text(&responses[0]);
    assert!(
        message.contains("POST /v1/tasks/task-1/actions/request-revision failed with status 500")
    );
    assert!(
        message.contains("No space left on device"),
        "error message should include the response body: {message}"
    );
}

#[test]
fn serve_reports_tool_argument_errors_as_tool_error_results() {
    let (base_url_tx, base_url_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        base_url_tx
            .send(format!(
                "http://{}",
                listener.local_addr().expect("local addr")
            ))
            .expect("send base url");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");
        thread::sleep(Duration::from_millis(200));
        assert!(
            listener.accept().is_err(),
            "invalid params should not issue HTTP requests"
        );
    });
    let base_url = base_url_rx.recv().expect("base url");

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "kanna_search_tasks",
                "arguments": {}
            }
        })],
    );

    server.join().expect("fixture server");
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], json!(11));
    assert_eq!(
        tool_error_text(&responses[0]),
        "missing required argument: query"
    );
}

#[test]
fn listing_tools_reject_repo_id_with_all_machines_without_issuing_http_requests() {
    let (base_url_tx, base_url_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        base_url_tx
            .send(format!(
                "http://{}",
                listener.local_addr().expect("local addr")
            ))
            .expect("send base url");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");
        thread::sleep(Duration::from_millis(200));
        assert!(
            listener.accept().is_err(),
            "invalid listing scopes should be rejected before HTTP routing"
        );
    });
    let base_url = base_url_rx.recv().expect("base url");

    let responses = run_kanna_mcp(
        &base_url,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 41,
                "method": "tools/call",
                "params": {
                    "name": "kanna_list_recent_tasks",
                    "arguments": { "repo_id": "repo-local", "all_machines": true }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 42,
                "method": "tools/call",
                "params": {
                    "name": "kanna_search_tasks",
                    "arguments": {
                        "query": "review",
                        "repo_id": "repo-local",
                        "all_machines": true
                    }
                }
            }),
        ],
    );

    server.join().expect("fixture server");
    assert_eq!(responses.len(), 2);
    for response in responses {
        let message = tool_error_text(&response);
        assert!(message.contains("repo_id and all_machines"), "{message}");
        assert!(
            message.contains("repository IDs are machine-local"),
            "{message}"
        );
    }
}

/// A task summary as the three list routes return it. `activity` is written
/// from the daemon's per-frame verdict, so a listing can carry the same
/// mid-redraw misread a detail read can.
fn summary_with_activity(id: &str, activity: &str) -> Value {
    json!({
        "id": id,
        "repoId": "repo-1",
        "repoName": "kanna",
        "title": "Specialty review",
        "stage": "review",
        "activity": activity,
        "agentType": "pty",
        "blockedByTaskIds": []
    })
}

/// Two reads of the same list route, disagreeing the way a flapping classifier
/// makes them disagree.
fn flapping_list_route(path: &'static str) -> Vec<ExpectedRequest> {
    vec![
        ExpectedRequest {
            method: "GET",
            path,
            body: None,
            response_status: "200 OK",
            response_body: json!([
                summary_with_activity("child-1", "working"),
                summary_with_activity("child-2", "unread")
            ]),
        },
        ExpectedRequest {
            method: "GET",
            path,
            body: None,
            response_status: "200 OK",
            response_body: json!([
                summary_with_activity("child-1", "working"),
                summary_with_activity("child-2", "working")
            ]),
        },
    ]
}

/// `kanna_list_recent_tasks`, `kanna_search_tasks`, and `kanna_list_repo_tasks`
/// all return `TaskSummary` arrays, and each builds its route differently — a
/// bare path, a query parameter, and a path parameter. All three must confirm a
/// stopped-looking item against a re-read of that same route.
#[test]
fn serve_confirms_a_transient_stop_on_every_task_list_route() {
    let routes: [(&'static str, &str, Value); 3] = [
        ("/v1/tasks/recent", "kanna_list_recent_tasks", json!({})),
        (
            "/v1/tasks/search?query=review",
            "kanna_search_tasks",
            json!({ "query": "review" }),
        ),
        (
            "/v1/repos/repo-1/tasks",
            "kanna_list_repo_tasks",
            json!({ "repo_id": "repo-1" }),
        ),
    ];

    for (path, tool, arguments) in routes {
        let (base_url, server) = start_http_fixture(flapping_list_route(path));

        let responses = run_kanna_mcp(
            &base_url,
            &[json!({
                "jsonrpc": "2.0",
                "id": 20,
                "method": "tools/call",
                "params": { "name": tool, "arguments": arguments }
            })],
        );

        let observed = server.join().expect("fixture server");
        assert_eq!(
            observed.len(),
            2,
            "{tool} should confirm the listing with one re-read of {path}"
        );
        let tasks = tool_text(&responses[0]);
        assert_eq!(
            tasks[1]["activity"],
            json!("working"),
            "{tool} leaked a transient stop: {tasks}"
        );
    }
}

#[test]
fn serve_reports_a_held_stop_on_a_task_list_route_within_the_confirmation_delay() {
    let held = json!([
        summary_with_activity("child-1", "working"),
        summary_with_activity("child-2", "unread")
    ]);
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/recent",
            body: None,
            response_status: "200 OK",
            response_body: held.clone(),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/recent",
            body: None,
            response_status: "200 OK",
            response_body: held,
        },
    ]);

    let started = std::time::Instant::now();
    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": { "name": "kanna_list_recent_tasks", "arguments": {} }
        })],
    );
    let elapsed = started.elapsed();

    server.join().expect("fixture server");
    let tasks = tool_text(&responses[0]);
    assert_eq!(
        tasks[1]["activity"],
        json!("unread"),
        "a held stop must still surface, with its own activity value: {tasks}"
    );
    assert!(
        elapsed >= ACTIVITY_CONFIRM_DELAY,
        "the answer must have come from a confirmation read (took {elapsed:?})"
    );
    assert!(
        elapsed < ACTIVITY_CONFIRM_DELAY * 10,
        "the confirmation must stay a small bounded cost (took {elapsed:?})"
    );
}

/// An unavailable second sample is not a confirmation. Reporting the first one
/// anyway would surface exactly the false stop this exists to suppress, so the
/// call fails instead.
#[test]
fn serve_fails_get_task_when_the_confirmation_read_fails() {
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-1?agentView=true",
            body: None,
            response_status: "200 OK",
            response_body: json!({
                "id": "task-1",
                "repoId": "repo-1",
                "title": "Review MCP",
                "stage": "in progress",
                "activity": "unread",
                "closedAt": null
            }),
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-1?agentView=true",
            body: None,
            response_status: "503 Service Unavailable",
            response_body: json!({ "error": "server restarting" }),
        },
    ]);

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "tools/call",
            "params": { "name": "kanna_get_task", "arguments": { "task_id": "task-1" } }
        })],
    );

    let observed = server.join().expect("fixture server");
    assert_eq!(observed.len(), 2);
    let message = tool_error_text(&responses[0]);
    assert!(
        !message.contains("\"activity\""),
        "the unconfirmed stopped sample must not be reported: {message}"
    );
    assert!(
        message.contains("confirming re-read"),
        "the failure should say the stop went unconfirmed: {message}"
    );
}

#[test]
fn serve_does_not_resolve_a_wait_when_the_confirmation_read_fails() {
    let finished = json!({
        "id": "task-1",
        "repoId": "repo-1",
        "title": "Review MCP",
        "stage": "in progress",
        "activity": "unread",
        "closedAt": null
    });
    let (base_url, server) = start_http_fixture(vec![
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-1?agentView=true",
            body: None,
            response_status: "200 OK",
            response_body: finished,
        },
        ExpectedRequest {
            method: "GET",
            path: "/v1/tasks/task-1?agentView=true",
            body: None,
            response_status: "503 Service Unavailable",
            response_body: json!({ "error": "server restarting" }),
        },
    ]);

    let responses = run_kanna_mcp(
        &base_url,
        &[json!({
            "jsonrpc": "2.0",
            "id": 23,
            "method": "tools/call",
            "params": {
                "name": "kanna_wait_task",
                "arguments": { "task_id": "task-1", "timeout_secs": 30, "poll_secs": 1 }
            }
        })],
    );

    server.join().expect("fixture server");
    let message = tool_error_text(&responses[0]);
    assert!(
        !message.contains("resolved"),
        "an unconfirmed stop must not resolve the wait: {message}"
    );
}
