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
fn stage_complete_retry_reuses_the_fixed_spawned_run_after_a_lost_response() {
    let root = std::env::temp_dir().join(format!(
        "kanna-cli-completion-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let context_path = root.join("completion.json");
    kanna_tool_catalog::write_completion_context(
        &context_path,
        &kanna_tool_catalog::CompletionContext {
            run_id: "run-original".to_string(),
            completed_attempt_key: None,
        },
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut first, _) = listener.accept().unwrap();
        let first_body = read_json_request(&mut first);
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
        Command::new(env!("CARGO_BIN_EXE_kanna-cli"))
            .args([
                "tool",
                "call",
                "kanna_complete_stage",
                "--json",
                r#"{"task_id":"task-1","status":"success","summary":"completed once"}"#,
                "--server-url",
                &format!("http://{address}"),
            ])
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
    assert_eq!(context.run_id, "run-original");
    assert!(context.completed_attempt_key.is_some());
    std::fs::remove_dir_all(root).unwrap();
}
