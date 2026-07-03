use kanna_agent_protocol::{
    AgentEvent, InterruptAction, OpencodeAdapter, PermissionDecision, ProviderAdapter, SpawnCtx,
    TurnModel, TurnStatus,
};

fn translate_fixture(adapter: &mut OpencodeAdapter, fixture: &str) -> Vec<AgentEvent> {
    fixture
        .lines()
        .flat_map(|line| adapter.parse_line(line))
        .collect()
}

#[test]
fn translates_captured_tool_run() {
    let fixture = r#"{"type":"step_start","timestamp":1767036060000,"sessionID":"ses_fixture","part":{"id":"prt_start","sessionID":"ses_fixture","messageID":"msg_1","type":"step-start","snapshot":"abc123"}}
{"type":"reasoning","timestamp":1767036060500,"sessionID":"ses_fixture","part":{"id":"prt_reason","sessionID":"ses_fixture","messageID":"msg_1","type":"reasoning","text":"I should run the requested command.","time":{"start":1767036060400,"end":1767036060500}}}
{"type":"tool_use","timestamp":1767036061199,"sessionID":"ses_fixture","part":{"id":"prt_tool","sessionID":"ses_fixture","messageID":"msg_1","type":"tool","callID":"call_1","tool":"bash","state":{"status":"completed","input":{"command":"echo opencode-contract","description":"Print fixture text"},"output":"opencode-contract\n","title":"Print fixture text","metadata":{"output":"opencode-contract\n","exit":0,"description":"Print fixture text"},"time":{"start":1767036061123,"end":1767036061173}}}}
{"type":"text","timestamp":1767036064268,"sessionID":"ses_fixture","part":{"id":"prt_text","sessionID":"ses_fixture","messageID":"msg_1","type":"text","text":"done","time":{"start":1767036064265,"end":1767036064265}}}
{"type":"step_finish","timestamp":1767036064273,"sessionID":"ses_fixture","part":{"id":"prt_finish","sessionID":"ses_fixture","messageID":"msg_1","type":"step-finish","reason":"stop","snapshot":"def456","cost":0.001,"tokens":{"input":671,"output":8,"reasoning":3,"cache":{"read":21415,"write":0}}}}"#;
    let mut adapter = OpencodeAdapter::new();
    let events = translate_fixture(&mut adapter, fixture);

    assert_eq!(
        events,
        vec![
            AgentEvent::TurnStarted { model: None },
            AgentEvent::Thinking {
                text: "I should run the requested command.".to_string(),
                truncated: false,
            },
            AgentEvent::ToolCall {
                call_id: "call_1".to_string(),
                tool_name: "bash".to_string(),
                input: serde_json::json!({
                    "command": "echo opencode-contract",
                    "description": "Print fixture text"
                }),
            },
            AgentEvent::ToolResult {
                call_id: "call_1".to_string(),
                output: "opencode-contract\n".to_string(),
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
                    duration_ms: 4273,
                    num_turns: 3,
                    total_cost_usd: Some(0.001),
                    input_tokens: Some(671),
                    output_tokens: Some(8),
                    ..Default::default()
                },
            },
        ]
    );

    assert_eq!(
        adapter.provider_session_id().as_deref(),
        Some("ses_fixture")
    );
}

#[test]
fn running_tool_use_emits_call_without_result() {
    let mut adapter = OpencodeAdapter::new();
    let events = adapter.parse_line(
        r#"{"type":"tool_use","timestamp":1767036061199,"sessionID":"ses_fixture","part":{"id":"prt_tool","sessionID":"ses_fixture","messageID":"msg_1","type":"tool","callID":"call_running","tool":"read","state":{"status":"running","input":{"filePath":"README.md"},"title":"Read README"}}}"#,
    );

    assert_eq!(
        events,
        vec![AgentEvent::ToolCall {
            call_id: "call_running".to_string(),
            tool_name: "read".to_string(),
            input: serde_json::json!({ "filePath": "README.md" }),
        }]
    );
}

#[test]
fn failed_tool_use_marks_result_as_error() {
    let mut adapter = OpencodeAdapter::new();
    let events = adapter.parse_line(
        r#"{"type":"tool_use","timestamp":1767036061199,"sessionID":"ses_fixture","part":{"id":"prt_tool","sessionID":"ses_fixture","messageID":"msg_1","type":"tool","callID":"call_1","tool":"bash","state":{"status":"failed","input":{"command":"false"},"output":"boom","metadata":{"exit":1}}}}"#,
    );

    assert_eq!(events.len(), 2);
    assert!(
        matches!(&events[0], AgentEvent::ToolCall { call_id, tool_name, .. } if call_id == "call_1" && tool_name == "bash")
    );
    assert!(
        matches!(&events[1], AgentEvent::ToolResult { call_id, output, is_error: true, .. } if call_id == "call_1" && output == "boom")
    );
}

#[test]
fn error_event_becomes_diagnostic_and_failed_turn() {
    let mut adapter = OpencodeAdapter::new();
    let events = adapter.parse_line(
        r#"{"type":"error","timestamp":1767036065000,"sessionID":"ses_fixture","error":{"name":"APIError","data":{"message":"Rate limit exceeded","statusCode":429,"isRetryable":true}}}"#,
    );

    assert_eq!(
        events,
        vec![
            AgentEvent::Diagnostic {
                message: "APIError: Rate limit exceeded".to_string(),
            },
            AgentEvent::TurnCompleted {
                status: TurnStatus::Error,
                stats: Default::default(),
            },
        ]
    );
    assert_eq!(
        adapter.provider_session_id().as_deref(),
        Some("ses_fixture")
    );
}

#[test]
fn unknown_lines_become_raw() {
    let mut adapter = OpencodeAdapter::new();
    assert!(matches!(
        &adapter.parse_line(r#"{"type":"session.mystery"}"#)[..],
        [AgentEvent::Raw { .. }]
    ));
    assert!(matches!(
        &adapter.parse_line("plain text")[..],
        [AgentEvent::Raw { .. }]
    ));
    assert!(matches!(
        &adapter.parse_line(r#"{"type":"tool_use","part":{"type":"tool"}}"#)[..],
        [AgentEvent::Raw { .. }]
    ));
    assert!(adapter.parse_line("").is_empty());
}

#[test]
fn spawn_args_pin_the_run_json_contract() {
    let adapter = OpencodeAdapter::new();
    let ctx = SpawnCtx {
        prompt: "fix the bug".to_string(),
        model: Some("opencode/big-pickle".to_string()),
        ..Default::default()
    };

    let spec = adapter.initial_spawn(&ctx);
    assert_eq!(spec.executable, "opencode");
    assert_eq!(spec.initial_stdin, None);
    assert_eq!(
        spec.args,
        vec![
            "run",
            "--format",
            "json",
            "--dangerously-skip-permissions",
            "-m",
            "opencode/big-pickle",
            "fix the bug",
        ]
    );

    let resume = adapter.resume_spawn(&ctx, "ses_123", "now add tests");
    assert_eq!(
        resume.args,
        vec![
            "run",
            "--format",
            "json",
            "--session",
            "ses_123",
            "--dangerously-skip-permissions",
            "-m",
            "opencode/big-pickle",
            "now add tests",
        ]
    );
}

fn write_test_mcp_config(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "kanna-agent-protocol-{label}-mcp-{}.json",
        std::process::id()
    ));
    std::fs::write(
        &path,
        serde_json::json!({
            "mcpServers": {
                "kanna-mcp": {
                    "command": "/tmp/kanna-mcp",
                    "args": ["serve"],
                    "env": {
                        "KANNA_SERVER_BASE_URL": "http://127.0.0.1:48120"
                    }
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    path
}

#[test]
fn spawn_env_includes_opencode_mcp_config_for_initial_and_resume_spawns() {
    let adapter = OpencodeAdapter::new();
    let mcp_config = write_test_mcp_config("opencode-adapter");
    let ctx = SpawnCtx {
        prompt: "fix the bug".to_string(),
        mcp_config_path: Some(mcp_config.to_string_lossy().to_string()),
        ..Default::default()
    };

    let initial_env = adapter.initial_spawn(&ctx).env;
    let content = initial_env
        .iter()
        .find_map(|(key, value)| (key == "OPENCODE_CONFIG_CONTENT").then_some(value))
        .expect("OpenCode should receive inline MCP config");
    assert!(content.contains("\"$schema\":\"https://opencode.ai/config.json\""));
    assert!(content.contains("\"mcp\":{\"kanna-mcp\":{\"command\":[\"/tmp/kanna-mcp\",\"serve\"]"));
    assert!(content.contains("\"type\":\"local\""));
    assert!(content.contains("\"enabled\":true"));
    assert!(content.contains("\"KANNA_SERVER_BASE_URL\":\"http://127.0.0.1:48120\""));

    let resume_env = adapter.resume_spawn(&ctx, "ses_123", "continue").env;
    assert!(resume_env
        .iter()
        .any(|(key, value)| key == "OPENCODE_CONFIG_CONTENT" && value == content));

    let _ = std::fs::remove_file(mcp_config);
}

#[test]
fn default_and_dont_ask_modes_skip_permissions() {
    let adapter = OpencodeAdapter::new();

    for permission_mode in [
        None,
        Some("default".to_string()),
        Some("dontAsk".to_string()),
    ] {
        let ctx = SpawnCtx {
            prompt: "fix the bug".to_string(),
            permission_mode,
            ..Default::default()
        };

        let args = adapter.initial_spawn(&ctx).args.join(" ");
        assert!(
            args.contains("--dangerously-skip-permissions"),
            "args should skip permissions, got: {args}"
        );
    }

    let sandboxed = adapter.initial_spawn(&SpawnCtx {
        prompt: "fix the bug".to_string(),
        permission_mode: Some("acceptEdits".to_string()),
        ..Default::default()
    });
    assert!(!sandboxed
        .args
        .contains(&"--dangerously-skip-permissions".to_string()));
}

#[test]
fn adapter_metadata() {
    let mut adapter = OpencodeAdapter::new();
    assert_eq!(adapter.provider(), "opencode");
    assert_eq!(adapter.turn_model(), TurnModel::PerTurn);
    assert!(!adapter.capabilities().permission_requests);
    assert!(!adapter.capabilities().mid_run_input);
    assert!(adapter.encode_input("x").is_none());
    assert_eq!(adapter.encode_interrupt(), InterruptAction::Signal);
    assert!(adapter
        .encode_permission_response("r", &PermissionDecision::Allow)
        .is_none());
    assert!(adapter.encode_set_model("opencode/big-pickle").is_none());
}
