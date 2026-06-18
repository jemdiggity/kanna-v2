use kanna_agent_protocol::{
    AgentEvent, CodexAdapter, InterruptAction, PermissionDecision, ProviderAdapter, SpawnCtx,
    TurnModel, TurnStatus,
};

fn translate_fixture(adapter: &mut CodexAdapter, fixture: &str) -> Vec<AgentEvent> {
    fixture
        .lines()
        .flat_map(|line| adapter.parse_line(line))
        .collect()
}

#[test]
fn translates_captured_tool_run() {
    let fixture = include_str!("fixtures/codex-tool-run.jsonl");
    let mut adapter = CodexAdapter::new();
    let events = translate_fixture(&mut adapter, fixture);

    assert_eq!(
        events,
        vec![
            AgentEvent::TurnStarted { model: None },
            AgentEvent::AssistantText {
                text: "Checking the skill file first.".to_string(),
                truncated: false,
            },
            AgentEvent::ToolCall {
                call_id: "item_1".to_string(),
                tool_name: "shell".to_string(),
                input: serde_json::json!({
                    "command": "/bin/zsh -lc \"sed -n '1,160p' /tmp/fixture/SKILL.md\""
                }),
            },
            AgentEvent::ToolResult {
                call_id: "item_1".to_string(),
                output: "---\nname: using-superpowers\n---\n".to_string(),
                truncated: false,
                is_error: false,
            },
            AgentEvent::ToolCall {
                call_id: "item_2".to_string(),
                tool_name: "shell".to_string(),
                input: serde_json::json!({ "command": "/bin/zsh -lc 'echo kanna-fixture'" }),
            },
            AgentEvent::ToolResult {
                call_id: "item_2".to_string(),
                output: "kanna-fixture\n".to_string(),
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
                    // Codex reports no turn count; we derive it from the four
                    // completed items (message + 2 commands + message). Duration
                    // is wall-clock, ~0ms for this synchronous in-process run.
                    num_turns: 4,
                    input_tokens: Some(38046),
                    output_tokens: Some(129),
                    ..Default::default()
                },
            },
        ]
    );

    assert_eq!(
        adapter.provider_session_id().as_deref(),
        Some("019eba69-1858-70a1-b740-8bce01ef9e7e")
    );
}

#[test]
fn completed_item_without_started_emits_call_and_result() {
    let mut adapter = CodexAdapter::new();
    let events = adapter.parse_line(
        r#"{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"ls","aggregated_output":"x\n","exit_code":1,"status":"completed"}}"#,
    );
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], AgentEvent::ToolCall { call_id, .. } if call_id == "item_9"));
    assert!(
        matches!(&events[1], AgentEvent::ToolResult { call_id, is_error: true, .. } if call_id == "item_9"),
        "non-zero exit must be an error result"
    );
}

#[test]
fn turn_failure_and_errors() {
    let mut adapter = CodexAdapter::new();

    let events =
        adapter.parse_line(r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#);
    assert_eq!(
        events,
        vec![
            AgentEvent::Diagnostic {
                message: "model overloaded".to_string(),
            },
            AgentEvent::TurnCompleted {
                status: TurnStatus::Error,
                stats: Default::default(),
            },
        ]
    );

    let events = adapter.parse_line(r#"{"type":"error","message":"boom"}"#);
    assert_eq!(
        events,
        vec![AgentEvent::Diagnostic {
            message: "boom".to_string(),
        }]
    );
}

#[test]
fn unknown_lines_become_raw() {
    let mut adapter = CodexAdapter::new();
    assert!(matches!(
        &adapter.parse_line(r#"{"type":"session.mystery"}"#)[..],
        [AgentEvent::Raw { .. }]
    ));
    assert!(matches!(
        &adapter.parse_line("plain text")[..],
        [AgentEvent::Raw { .. }]
    ));
    assert!(matches!(
        &adapter.parse_line(
            r#"{"type":"item.completed","item":{"id":"i","type":"todo_list","items":[]}}"#
        )[..],
        [AgentEvent::Raw { .. }]
    ));
    assert!(adapter.parse_line("").is_empty());
}

#[test]
fn spawn_args_pin_the_exec_json_contract() {
    let adapter = CodexAdapter::new();
    let ctx = SpawnCtx {
        prompt: "fix the bug".to_string(),
        model: Some("gpt-5.5".to_string()),
        ..Default::default()
    };

    let spec = adapter.initial_spawn(&ctx);
    assert_eq!(spec.executable, "codex");
    // codex blocks on piped stdin — the daemon must close it (no initial write).
    assert_eq!(spec.initial_stdin, None);
    assert_eq!(
        spec.args,
        vec![
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "-m",
            "gpt-5.5",
            "--json",
            "fix the bug",
        ]
    );

    let resume = adapter.resume_spawn(&ctx, "thread-1", "now add tests");
    assert_eq!(
        resume.args,
        vec![
            "exec",
            "resume",
            "thread-1",
            "--dangerously-bypass-approvals-and-sandbox",
            "-m",
            "gpt-5.5",
            "--json",
            "now add tests",
        ]
    );
}

#[test]
fn default_and_dont_ask_modes_bypass_exec_sandbox_and_approvals() {
    let adapter = CodexAdapter::new();

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
            args.contains("--dangerously-bypass-approvals-and-sandbox"),
            "args should bypass approvals and sandbox, got: {args}"
        );

        let resume_args = adapter
            .resume_spawn(&ctx, "thread-1", "continue")
            .args
            .join(" ");
        assert!(
            resume_args.contains("--dangerously-bypass-approvals-and-sandbox"),
            "resume args should bypass approvals and sandbox, got: {resume_args}"
        );
    }
}

#[test]
fn adapter_metadata() {
    let mut adapter = CodexAdapter::new();
    assert_eq!(adapter.provider(), "codex");
    assert_eq!(adapter.turn_model(), TurnModel::PerTurn);
    assert!(!adapter.capabilities().permission_requests);
    assert!(!adapter.capabilities().mid_run_input);
    assert!(adapter.encode_input("x").is_none());
    assert_eq!(adapter.encode_interrupt(), InterruptAction::Signal);
    assert!(adapter
        .encode_permission_response("r", &PermissionDecision::Allow)
        .is_none());
    // Codex has no in-band model switch; the daemon applies it on respawn.
    assert!(adapter.encode_set_model("gpt-5-codex").is_none());
}
