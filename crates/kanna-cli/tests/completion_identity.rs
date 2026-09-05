use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;

fn read_json_request(stream: &mut TcpStream) -> serde_json::Value {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read request headers");
        assert_ne!(read, 0, "client closed before request headers");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    assert!(headers.starts_with("POST /v1/tasks/task-1/actions/complete-stage HTTP/1.1"));
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':').and_then(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().expect("content length"))
            })
        })
        .expect("content-length header");
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("read request body");
        assert_ne!(read, 0, "client closed before request body");
        bytes.extend_from_slice(&buffer[..read]);
    }
    serde_json::from_slice(&bytes[header_end..header_end + content_length]).expect("JSON body")
}

#[test]
fn lost_response_retry_cannot_complete_or_restore_a_server_rebound_post_context() {
    assert_lost_response_retry(false);
}

#[test]
fn direct_stage_complete_retry_cannot_complete_or_restore_a_server_rebound_post_context() {
    assert_lost_response_retry(true);
}

fn assert_lost_response_retry(direct_stage_complete: bool) {
    let root = std::env::temp_dir().join(format!(
        "kanna-cli-completion-{}-{}-{}",
        std::process::id(),
        if direct_stage_complete {
            "direct"
        } else {
            "tool"
        },
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let context_path = root.join("completion.json");
    kanna_tool_catalog::write_completion_context(
        &context_path,
        &kanna_tool_catalog::CompletionContext::new("run-original"),
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server_context_path = context_path.clone();
    let server = std::thread::spawn(move || {
        let (mut first, _) = listener.accept().unwrap();
        let first_body = read_json_request(&mut first);
        let attempt_key = first_body["completionAttemptKey"].as_str().unwrap();
        kanna_tool_catalog::mutate_completion_context(&server_context_path, |current| {
            let mut context = current.unwrap();
            context.record_completed_attempt("run-original", attempt_key);
            context.run_id = "run-post".to_string();
            Ok(context)
        })
        .unwrap();
        drop(first);
        let (mut second, _) = listener.accept().unwrap();
        let second_body = read_json_request(&mut second);
        let response_body = r#"{"taskId":"task-1"}"#;
        second
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .as_bytes(),
            )
            .unwrap();
        (first_body, second_body)
    });

    let run = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-cli"));
        if direct_stage_complete {
            command.args([
                "stage-complete",
                "--task-id",
                "task-1",
                "--status",
                "success",
                "--summary",
                "completed once",
                "--server-url",
                &format!("http://{address}"),
            ]);
        } else {
            command.args([
                "tool",
                "call",
                "kanna_complete_stage",
                "--json",
                r#"{"task_id":"task-1","status":"success","summary":"completed once"}"#,
                "--server-url",
                &format!("http://{address}"),
            ]);
        }
        command
            .env(
                kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV,
                &context_path,
            )
            .output()
            .unwrap()
    };
    let first = run();
    assert!(!first.status.success(), "the dropped response should fail");
    let second = run();
    assert!(
        second.status.success(),
        "retry failed: {}",
        String::from_utf8_lossy(&second.stderr)
    );

    let (first_body, second_body) = server.join().unwrap();
    assert_eq!(first_body, second_body);
    assert_eq!(first_body["runId"], "run-original");
    assert_eq!(
        first_body["completionAttemptKey"],
        second_body["completionAttemptKey"]
    );
    let context = kanna_tool_catalog::read_completion_context(&context_path).unwrap();
    assert_eq!(context.run_id, "run-post");
    assert_eq!(
        context.run_for_attempt(first_body["completionAttemptKey"].as_str().unwrap()),
        Some("run-original")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn contextless_completion_retries_always_send_the_same_key() {
    for direct in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                bodies.push(read_json_request(&mut stream));
                if attempt == 1 {
                    let body = r#"{"taskId":"task-1"}"#;
                    write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }
            }
            bodies
        });
        for attempt in 0..2 {
            let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-cli"));
            if direct {
                command.args([
                    "stage-complete",
                    "--task-id",
                    "task-1",
                    "--status",
                    "success",
                    "--summary",
                    "completed once",
                ]);
            } else {
                command.args([
                    "tool",
                    "call",
                    "kanna_complete_stage",
                    "--json",
                    r#"{"task_id":"task-1","status":"success","summary":"completed once"}"#,
                ]);
            }
            let output = command
                .args(["--server-url", &format!("http://{address}")])
                .env_remove(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV)
                .env_remove(kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV)
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                attempt == 1,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let bodies = server.join().unwrap();
        assert_eq!(bodies[0], bodies[1]);
        assert!(bodies[0]
            .get("runId")
            .is_none_or(serde_json::Value::is_null));
        assert_eq!(
            bodies[0]["completionAttemptKey"],
            kanna_tool_catalog::completion_attempt_key(&bodies[0]).unwrap()
        );
    }
}
