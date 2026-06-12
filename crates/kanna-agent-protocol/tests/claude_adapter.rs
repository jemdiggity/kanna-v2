use kanna_agent_protocol::{
    AgentEvent, ClaudeAdapter, InterruptAction, PermissionDecision, ProviderAdapter, SpawnCtx,
    TurnModel, TurnStatus,
};
use serde_json::Value;

fn translate_fixture(adapter: &mut ClaudeAdapter, fixture: &str) -> Vec<AgentEvent> {
    fixture
        .lines()
        .flat_map(|line| adapter.parse_line(line))
        .collect()
}

#[test]
fn translates_captured_tool_run() {
    let fixture = include_str!("fixtures/claude-tool-run.ndjson");
    let mut adapter = ClaudeAdapter::new();
    let events = translate_fixture(&mut adapter, fixture);

    assert_eq!(
        events,
        vec![
            AgentEvent::TurnStarted {
                model: Some("claude-fable-5".to_string()),
            },
            AgentEvent::ToolCall {
                call_id: "toolu_01SDTmHWQGNoFkD5cYXqkbBb".to_string(),
                tool_name: "Bash".to_string(),
                input: serde_json::json!({
                    "command": "echo kanna-fixture",
                    "description": "Echo kanna-fixture"
                }),
            },
            AgentEvent::Diagnostic {
                message: "rate limit event".to_string(),
            },
            AgentEvent::ToolResult {
                call_id: "toolu_01SDTmHWQGNoFkD5cYXqkbBb".to_string(),
                output: "kanna-fixture".to_string(),
                truncated: false,
                is_error: false,
            },
            AgentEvent::AssistantText {
                text: "done".to_string(),
                truncated: false,
            },
            AgentEvent::TurnCompleted {
                status: TurnStatus::Success,
                stats: kanna_agent_protocol::TurnStats {
                    duration_ms: 9532,
                    duration_api_ms: Some(8858),
                    num_turns: 2,
                    total_cost_usd: Some(0.7426269999999999),
                    input_tokens: Some(6742),
                    output_tokens: Some(105),
                },
            },
        ]
    );

    assert_eq!(
        adapter.provider_session_id().as_deref(),
        Some("c7319eb6-19ce-46e8-bc86-718497ab0223")
    );
}

#[test]
fn permission_request_round_trip() {
    let mut adapter = ClaudeAdapter::new();
    let events = adapter.parse_line(
        r#"{"type":"control_request","request_id":"req_perm_1","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{"file_path":"/x"}}}"#,
    );
    assert_eq!(
        events,
        vec![AgentEvent::PermissionRequest {
            request_id: "req_perm_1".to_string(),
            tool_name: "Edit".to_string(),
            input: serde_json::json!({"file_path": "/x"}),
        }]
    );

    let allow = adapter
        .encode_permission_response("req_perm_1", &PermissionDecision::Allow)
        .expect("claude supports permission responses");
    let allow: Value = serde_json::from_str(&allow).unwrap();
    assert_eq!(allow["type"], "control_response");
    assert_eq!(allow["response"]["subtype"], "success");
    assert_eq!(allow["response"]["request_id"], "req_perm_1");
    assert_eq!(allow["response"]["response"]["allowed"], true);

    let deny = adapter
        .encode_permission_response(
            "req_perm_1",
            &PermissionDecision::Deny {
                reason: Some("wrong file".to_string()),
            },
        )
        .unwrap();
    let deny: Value = serde_json::from_str(&deny).unwrap();
    assert_eq!(deny["response"]["response"]["allowed"], false);
    assert_eq!(deny["response"]["response"]["reason"], "wrong file");

    // AllowSession is a plain allow on the wire (session rule is daemon-side).
    let session = adapter
        .encode_permission_response("req_perm_1", &PermissionDecision::AllowSession)
        .unwrap();
    let session: Value = serde_json::from_str(&session).unwrap();
    assert_eq!(session["response"]["response"]["allowed"], true);
}

#[test]
fn interrupt_is_a_control_request_line() {
    let mut adapter = ClaudeAdapter::new();
    match adapter.encode_interrupt() {
        InterruptAction::StdinLine(line) => {
            let value: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(value["type"], "control_request");
            assert_eq!(value["request"]["subtype"], "interrupt");
            assert!(value["request_id"]
                .as_str()
                .unwrap()
                .starts_with("kanna-req-"));
        }
        InterruptAction::Signal => panic!("claude interrupt should use stdin"),
    }
}

#[test]
fn input_is_a_stream_json_user_message() {
    let mut adapter = ClaudeAdapter::new();
    let line = adapter.encode_input("keep going").unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["type"], "user");
    assert_eq!(value["message"]["role"], "user");
    assert_eq!(value["message"]["content"], "keep going");
}

#[test]
fn spawn_args_pin_the_stream_json_contract() {
    let adapter = ClaudeAdapter::new();
    let ctx = SpawnCtx {
        prompt: "fix the bug".to_string(),
        model: Some("claude-fable-5".to_string()),
        permission_mode: Some("acceptEdits".to_string()),
        allowed_tools: vec!["Bash".to_string()],
        max_turns: None,
        max_budget_usd: None,
        system_prompt: None,
    };

    let spec = adapter.initial_spawn(&ctx);
    assert_eq!(spec.executable, "claude");
    let args = spec.args.join(" ");
    assert!(args.contains("-p"));
    assert!(args.contains("--output-format stream-json"));
    assert!(args.contains("--input-format stream-json"));
    assert!(args.contains("--permission-mode acceptEdits"));
    assert!(args.contains("--allowedTools Bash"));
    assert!(args.contains("--permission-prompt-tool stdio"));

    // The prompt is NOT an argument — stream-json input mode ignores the -p
    // prompt; it goes to stdin as an enveloped user message.
    assert!(!args.contains("fix the bug"));
    let stdin: Value =
        serde_json::from_str(&spec.initial_stdin.expect("prompt must go to stdin")).unwrap();
    assert_eq!(stdin["type"], "user");
    assert_eq!(stdin["message"]["content"], "fix the bug");

    let resume = adapter.resume_spawn(&ctx, "sess-123", "continue please");
    let resume_args = resume.args.join(" ");
    assert!(resume_args.contains("--resume sess-123"));
    assert!(resume_args.contains("--input-format stream-json"));
    let stdin: Value =
        serde_json::from_str(&resume.initial_stdin.expect("message must go to stdin")).unwrap();
    assert_eq!(stdin["message"]["content"], "continue please");
}

#[test]
fn plain_user_message_and_garbage_lines() {
    let mut adapter = ClaudeAdapter::new();

    let events =
        adapter.parse_line(r#"{"type":"user","message":{"role":"user","content":"hello there"}}"#);
    assert_eq!(
        events,
        vec![AgentEvent::UserMessage {
            text: "hello there".to_string(),
        }]
    );

    let events = adapter.parse_line("not json at all");
    assert!(matches!(&events[..], [AgentEvent::Raw { line, .. }] if line == "not json at all"));

    let events = adapter.parse_line(r#"{"type":"some_future_message","x":1}"#);
    assert!(matches!(&events[..], [AgentEvent::Raw { .. }]));

    assert!(adapter.parse_line("").is_empty());
}

#[test]
fn adapter_metadata() {
    let adapter = ClaudeAdapter::new();
    assert_eq!(adapter.provider(), "claude");
    assert_eq!(adapter.turn_model(), TurnModel::Persistent);
    assert!(adapter.capabilities().permission_requests);
    assert!(adapter.capabilities().mid_run_input);
}
