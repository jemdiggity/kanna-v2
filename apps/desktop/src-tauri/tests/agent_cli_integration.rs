/// Integration tests: Tauri agent layer ↔ Claude CLI.
///
/// Verifies the full chain: spawn Claude CLI process → receive structured
/// NDJSON messages through the buffered session pattern → session completes.
///
/// Layer 1 tests the SDK Session directly.
/// Layer 2 tests the BufferedSession pattern used by the Tauri commands
///         (background drainer task + poll-from-buffer).
///
/// Requires `claude` binary in PATH with valid auth.
/// Run: cargo test -p kanna-desktop --test agent_cli_integration -- --ignored --nocapture
use claude_agent_sdk::{Message, PermissionMode, Session, SessionOptions};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

// ── Layer 1: SDK session ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn sdk_session_produces_assistant_and_result() {
    // Test through the SDK
    eprintln!("[test] Creating SDK session...");
    let session = Session::start(
        SessionOptions::builder()
            .cwd("/tmp")
            .max_turns(1)
            .permission_mode(PermissionMode::DontAsk)
            .build(),
        "Respond with exactly: SDK_TEST_OK",
    )
    .await
    .expect("Failed to start — is `claude` in PATH with valid auth?");
    eprintln!("[test] Session created, polling messages...");

    let mut types: Vec<String> = Vec::new();
    let mut poll_count = 0;
    loop {
        poll_count += 1;
        eprintln!("[test] poll #{}", poll_count);
        match session.next_message().await {
            Some(Ok(msg)) => {
                let t = msg_type(&msg);
                eprintln!("[sdk] message: {}", t);
                types.push(t.to_string());
                if matches!(msg, Message::Result(_)) {
                    break;
                }
            }
            Some(Err(e)) => {
                eprintln!("[sdk] error: {}", e);
                break;
            }
            None => {
                eprintln!("[sdk] stream ended (None)");
                break;
            }
        }
    }
    session.close().await;

    assert!(!types.is_empty(), "no messages received (polled {} times)", poll_count);
    assert!(types.contains(&"assistant".into()), "missing assistant: {:?}", types);
    assert!(types.contains(&"result".into()), "missing result: {:?}", types);
}

// ── Layer 2: Buffered session (mirrors Tauri command pattern) ───────────

/// The buffer + finished flag that the Tauri commands expose to the frontend.
/// The drainer task owns the Session and pushes serialized messages here.
struct Buffered {
    buffer: Arc<Mutex<Vec<serde_json::Value>>>,
    finished: Arc<Mutex<bool>>,
}

/// Start a session with a background drainer — same architecture as
/// `create_agent_session` in commands/agent.rs, minus the DashMap.
async fn start_buffered(prompt: &str) -> Buffered {
    let session = Session::start(
        SessionOptions::builder()
            .cwd("/tmp")
            .max_turns(1)
            .permission_mode(PermissionMode::DontAsk)
            .build(),
        prompt,
    )
    .await
    .expect("start failed");

    let buffer: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(Mutex::new(false));
    let buf = Arc::clone(&buffer);
    let fin = Arc::clone(&finished);

    tokio::spawn(async move {
        loop {
            match session.next_message().await {
                Some(Ok(m)) => {
                    if let Ok(val) = serde_json::to_value(&m) {
                        buf.lock().await.push(val);
                    }
                }
                Some(Err(e)) => {
                    eprintln!("[drainer] error: {}", e);
                    *fin.lock().await = true;
                    break;
                }
                None => {
                    *fin.lock().await = true;
                    break;
                }
            }
        }
        // Session dropped here — CLI process cleaned up
    });

    Buffered { buffer, finished }
}

/// Poll the buffer exactly as `agent_next_message` does.
/// Returns None when session is done, Some({"type":"waiting"}) when idle.
async fn poll(b: &Buffered) -> Option<serde_json::Value> {
    {
        let mut buf = b.buffer.lock().await;
        if !buf.is_empty() {
            return Some(buf.remove(0));
        }
    }
    if *b.finished.lock().await {
        return None;
    }
    Some(serde_json::json!({"type": "waiting"}))
}

/// Drain all messages from a buffered session until result or timeout.
async fn drain_until_result(b: &Buffered, timeout_secs: u64) -> Vec<String> {
    let mut types = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        if tokio::time::Instant::now() > deadline {
            panic!("Timed out after {}s. Types seen: {:?}", timeout_secs, types);
        }
        match poll(b).await {
            Some(msg) => {
                let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                if t == "waiting" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
                eprintln!("[buffered] {}", t);
                types.push(t.clone());
                if t == "result" {
                    break;
                }
            }
            None => break,
        }
    }
    types
}

#[tokio::test]
#[ignore]
async fn buffered_session_drains_all_messages() {
    let b = start_buffered("Respond with exactly: BUFFERED_OK").await;
    let types = drain_until_result(&b, 120).await;

    assert!(types.contains(&"assistant".into()), "no assistant: {:?}", types);
    assert!(types.contains(&"result".into()), "no result: {:?}", types);
    assert!(*b.finished.lock().await, "finished flag not set");
}

#[tokio::test]
#[ignore]
async fn concurrent_sessions_are_independent() {
    let a = start_buffered("Respond with exactly: ALPHA").await;
    let b = start_buffered("Respond with exactly: BRAVO").await;

    let types_a = drain_until_result(&a, 120).await;
    let types_b = drain_until_result(&b, 120).await;

    assert!(types_a.contains(&"result".into()), "session a: {:?}", types_a);
    assert!(types_b.contains(&"result".into()), "session b: {:?}", types_b);
}

#[tokio::test]
#[ignore]
async fn result_contains_session_id_and_duration() {
    let b = start_buffered("Say hello").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let mut result_msg: Option<serde_json::Value> = None;

    loop {
        if tokio::time::Instant::now() > deadline {
            panic!("Timed out");
        }
        match poll(&b).await {
            Some(msg) => {
                let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                if t == "waiting" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
                if t == "result" {
                    result_msg = Some(msg);
                    break;
                }
            }
            None => break,
        }
    }

    let r = result_msg.expect("no result message");
    assert!(r.get("session_id").is_some(), "missing session_id: {}", r);
    assert!(r.get("num_turns").is_some(), "missing num_turns");
    assert!(r.get("duration_ms").is_some(), "missing duration_ms");
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn msg_type(msg: &Message) -> &'static str {
    match msg {
        Message::Assistant(_) => "assistant",
        Message::User(_) => "user",
        Message::Result(_) => "result",
        Message::System(_) => "system",
        Message::StreamEvent(_) => "stream_event",
        Message::ToolProgress(_) => "tool_progress",
        Message::AuthStatus(_) => "auth_status",
        Message::RateLimit(_) => "rate_limit",
        Message::PromptSuggestion(_) => "prompt_suggestion",
    }
}
