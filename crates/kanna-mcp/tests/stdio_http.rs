use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

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

    ObservedRequest { method, path, body }
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

fn spawn_kanna_mcp_for_reload(cwd: &std::path::Path) -> std::process::Child {
    let binary = env!("CARGO_BIN_EXE_kanna-mcp");
    Command::new(binary)
        .args(["serve", "--server-url", "http://127.0.0.1:9"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
            path: "/v1/tasks/task-1",
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
                "closedAt": null
            }),
        },
        ExpectedRequest {
            method: "POST",
            path: "/v1/tasks/task-1/actions/complete-stage",
            body: Some(json!({
                "status": "success",
                "summary": "QA passed",
                "runId": "run-current",
                "metadata": { "review": "stdio-http" }
            })),
            response_status: "200 OK",
            response_body: json!({ "taskId": "task-1", "stage": "pr" }),
        },
    ]);

    let responses = run_kanna_mcp_with_env(
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
        &[("KANNA_STAGE_RUN_ID", "run-current")],
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
            "closedAt": null
        })
    );
    assert_eq!(
        tool_text(&responses[3]),
        json!({ "taskId": "task-1", "stage": "pr" })
    );
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
