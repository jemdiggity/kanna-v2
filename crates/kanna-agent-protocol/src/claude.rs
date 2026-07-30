//! Claude CLI adapter: headless `stream-json` output/input plus the
//! bidirectional control protocol (interrupt, `can_use_tool` permissions).

use claude_agent_sdk::types::control::{
    ControlRequest, ControlRequestEnvelope, ControlResponse, ControlResponseEnvelope,
};
use claude_agent_sdk::types::messages::{
    ContentBlock, Message, ResultMessage, ToolProgressMessage, UserInput,
};
use claude_agent_sdk::types::options::SessionOptions;
use claude_agent_sdk::types::permissions::{PermissionMode, PermissionResult};
use serde_json::Value;

use crate::adapter::{
    Capabilities, InterruptAction, ProviderAdapter, SpawnCtx, SpawnSpec, TurnModel,
};
use crate::events::{truncate_text, AgentEvent, PermissionDecision, TurnStats, TurnStatus};

/// Adapter for the Claude CLI.
#[derive(Debug, Default)]
pub struct ClaudeAdapter {
    session_id: Option<String>,
    next_request_id: u64,
}

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    fn session_options(ctx: &SpawnCtx) -> SessionOptions {
        let mut builder = SessionOptions::builder();
        // Agent mode runs "yolo" by default: no tool sandbox and no approval
        // prompts. This mirrors the PTY-mode convention in the desktop's
        // `agent-permissions.ts`, where an unset mode, `default`, and `dontAsk`
        // all map to `--dangerously-skip-permissions`. Only `acceptEdits` opts
        // back into the sandboxed approval flow with a permission callback.
        let enforced_mode = match ctx.permission_mode.as_deref() {
            Some("acceptEdits") => Some(PermissionMode::AcceptEdits),
            _ => None,
        };
        builder = match enforced_mode {
            Some(mode) => builder.with_permission_callback().permission_mode(mode),
            None => builder.dangerously_skip_permissions(true),
        };
        if let Some(model) = &ctx.model {
            builder = builder.model(model.clone());
        }
        if let Some(effort) = &ctx.effort {
            builder = builder.effort_override(effort.clone());
        }
        if !ctx.allowed_tools.is_empty() {
            builder = builder.allowed_tools(ctx.allowed_tools.clone());
        }
        if !ctx.disallowed_tools.is_empty() {
            builder = builder.disallowed_tools(ctx.disallowed_tools.clone());
        }
        if let Some(max_turns) = ctx.max_turns {
            builder = builder.max_turns(max_turns);
        }
        if let Some(budget) = ctx.max_budget_usd {
            builder = builder.max_budget_usd(budget);
        }
        if let Some(system_prompt) = &ctx.system_prompt {
            builder = builder.system_prompt(system_prompt.clone());
        }
        builder.build()
    }

    fn spawn_spec(
        options: &SessionOptions,
        prompt: &str,
        mcp_config_path: Option<&str>,
    ) -> SpawnSpec {
        // In stream-json input mode the CLI ignores the `-p` prompt argument;
        // the prompt is delivered as the first stdin user message instead.
        let mut args = options.to_cli_args(None);
        // Steering requires stream-json input on every spawn; to_cli_args only
        // adds it for resume/continue sessions.
        if !args.iter().any(|a| a == "--input-format") {
            args.extend(["--input-format".to_string(), "stream-json".to_string()]);
        }
        if let Some(path) = mcp_config_path.filter(|path| !path.trim().is_empty()) {
            args.extend(["--mcp-config".to_string(), path.to_string()]);
        }
        SpawnSpec {
            executable: "claude".to_string(),
            args,
            env: Vec::new(),
            initial_stdin: serde_json::to_string(&UserInput::text(prompt)).ok(),
        }
    }

    fn capture_session_id(&mut self, value: &Value) {
        if let Some(id) = value.get("session_id").and_then(Value::as_str) {
            if !id.is_empty() {
                self.session_id = Some(id.to_string());
            }
        }
    }

    fn translate_assistant_blocks(blocks: &[ContentBlock]) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        for block in blocks {
            match block {
                ContentBlock::Text { text } => {
                    if !text.is_empty() {
                        let (text, truncated) = truncate_text(text.clone());
                        events.push(AgentEvent::AssistantText { text, truncated });
                    }
                }
                ContentBlock::Thinking { thinking } => {
                    // Redacted thinking arrives as an empty string + signature.
                    if !thinking.is_empty() {
                        let (text, truncated) = truncate_text(thinking.clone());
                        events.push(AgentEvent::Thinking { text, truncated });
                    }
                }
                ContentBlock::ToolUse { id, name, input } => {
                    events.push(AgentEvent::ToolCall {
                        call_id: id.clone(),
                        tool_name: name.clone(),
                        input: input.clone(),
                    });
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                } => {
                    let (output, truncated) = truncate_text(stringify_content(content));
                    events.push(AgentEvent::ToolResult {
                        call_id: tool_use_id.clone(),
                        output,
                        truncated,
                        is_error: false,
                    });
                }
            }
        }
        events
    }

    /// Real CLI user messages wrap content as `message.content` (the SDK's
    /// `UserMessage` type predates that shape), so parse from the raw value
    /// and accept both layouts.
    fn translate_user_message(value: &Value) -> Vec<AgentEvent> {
        let content = value
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| value.get("content"));

        let mut events = Vec::new();
        match content {
            Some(Value::String(text)) => {
                events.push(AgentEvent::UserMessage { text: text.clone() });
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {
                            let call_id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let raw = block.get("content").cloned().unwrap_or(Value::Null);
                            let (output, truncated) = truncate_text(stringify_content(&raw));
                            let is_error = block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            events.push(AgentEvent::ToolResult {
                                call_id,
                                output,
                                truncated,
                                is_error,
                            });
                        }
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                events.push(AgentEvent::UserMessage {
                                    text: text.to_string(),
                                });
                            }
                        }
                        _ => events.push(raw_event(&block.to_string())),
                    }
                }
            }
            _ => events.push(raw_event(&value.to_string())),
        }
        events
    }

    fn translate_result(&mut self, result: &ResultMessage) -> Vec<AgentEvent> {
        if !result.session_id().is_empty() {
            self.session_id = Some(result.session_id().to_string());
        }

        let mut events = Vec::new();
        let (status, stats) = match result {
            ResultMessage::Success {
                duration_ms,
                duration_api_ms,
                num_turns,
                total_cost_usd,
                usage,
                ..
            } => (
                TurnStatus::Success,
                turn_stats(
                    *duration_ms,
                    *duration_api_ms,
                    *num_turns,
                    *total_cost_usd,
                    usage,
                ),
            ),
            ResultMessage::ErrorDuringExecution {
                errors,
                duration_ms,
                duration_api_ms,
                num_turns,
                total_cost_usd,
                usage,
                ..
            } => {
                for error in errors {
                    events.push(AgentEvent::Diagnostic {
                        message: error.clone(),
                    });
                }
                (
                    TurnStatus::Error,
                    turn_stats(
                        *duration_ms,
                        *duration_api_ms,
                        *num_turns,
                        *total_cost_usd,
                        usage,
                    ),
                )
            }
            ResultMessage::ErrorMaxTurns {
                duration_ms,
                duration_api_ms,
                num_turns,
                total_cost_usd,
                usage,
                ..
            } => (
                TurnStatus::MaxTurns,
                turn_stats(
                    *duration_ms,
                    *duration_api_ms,
                    *num_turns,
                    *total_cost_usd,
                    usage,
                ),
            ),
            ResultMessage::ErrorMaxBudget {
                duration_ms,
                duration_api_ms,
                num_turns,
                total_cost_usd,
                usage,
                ..
            } => (
                TurnStatus::MaxBudget,
                turn_stats(
                    *duration_ms,
                    *duration_api_ms,
                    *num_turns,
                    *total_cost_usd,
                    usage,
                ),
            ),
        };
        events.push(AgentEvent::TurnCompleted { status, stats });
        events
    }

    fn translate_system(&mut self, value: &Value) -> Vec<AgentEvent> {
        self.capture_session_id(value);
        match value.get("subtype").and_then(Value::as_str) {
            Some("init") => {
                let model = value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                vec![AgentEvent::TurnStarted { model }]
            }
            // Hook lifecycle chatter is recognized and intentionally not
            // journaled — it is per-hook noise, not conversation.
            Some("hook_started") | Some("hook_response") => Vec::new(),
            Some(subtype) => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(subtype);
                vec![AgentEvent::Diagnostic {
                    message: format!("system:{subtype} {message}"),
                }]
            }
            None => vec![AgentEvent::Diagnostic {
                message: "system message without subtype".to_string(),
            }],
        }
    }

    fn translate_tool_progress(progress: &ToolProgressMessage) -> Vec<AgentEvent> {
        let message = progress.content.clone().unwrap_or_default();
        if message.is_empty() {
            return Vec::new();
        }
        vec![AgentEvent::ToolProgress {
            call_id: progress.tool_use_id.clone(),
            message,
        }]
    }
}

impl ProviderAdapter for ClaudeAdapter {
    fn provider(&self) -> &'static str {
        "claude"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            permission_requests: true,
            mid_run_input: true,
        }
    }

    fn turn_model(&self) -> TurnModel {
        TurnModel::Persistent
    }

    fn initial_spawn(&self, ctx: &SpawnCtx) -> SpawnSpec {
        Self::spawn_spec(
            &Self::session_options(ctx),
            &ctx.prompt,
            ctx.mcp_config_path.as_deref(),
        )
    }

    fn resume_spawn(&self, ctx: &SpawnCtx, session_id: &str, message: &str) -> SpawnSpec {
        let mut options = Self::session_options(ctx);
        options.resume = Some(session_id.to_string());
        Self::spawn_spec(&options, message, ctx.mcp_config_path.as_deref())
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![raw_event(line)];
        };

        match value.get("type").and_then(Value::as_str) {
            Some("control_request") => {
                match serde_json::from_value::<ControlRequestEnvelope>(value.clone()) {
                    Ok(envelope) => match envelope.request {
                        ControlRequest::CanUseTool { tool_name, input } => {
                            vec![AgentEvent::PermissionRequest {
                                request_id: envelope.request_id,
                                tool_name,
                                input,
                            }]
                        }
                        _ => vec![AgentEvent::Diagnostic {
                            message: format!("unexpected control request from CLI: {line}"),
                        }],
                    },
                    Err(_) => vec![raw_event(line)],
                }
            }
            // Acks for our own control requests (e.g. interrupt) carry no
            // conversational content.
            Some("control_response") | Some("control_cancel_request") => Vec::new(),
            Some("user") => Self::translate_user_message(&value),
            Some("system") => self.translate_system(&value),
            _ => match serde_json::from_value::<Message>(value) {
                Ok(Message::Assistant(assistant)) => {
                    Self::translate_assistant_blocks(&assistant.message.content)
                }
                Ok(Message::Result(result)) => self.translate_result(&result),
                Ok(Message::ToolProgress(progress)) => Self::translate_tool_progress(&progress),
                Ok(Message::StreamEvent(_)) | Ok(Message::PromptSuggestion(_)) => Vec::new(),
                Ok(Message::AuthStatus(auth)) => vec![AgentEvent::Diagnostic {
                    message: format!("auth_status authenticated={}", auth.authenticated),
                }],
                Ok(Message::RateLimit(_)) => vec![AgentEvent::Diagnostic {
                    message: "rate limit event".to_string(),
                }],
                // User/System are handled above from the raw value.
                Ok(Message::User(_)) | Ok(Message::System(_)) => Vec::new(),
                Err(_) => vec![raw_event(line)],
            },
        }
    }

    fn provider_session_id(&self) -> Option<String> {
        self.session_id.clone()
    }

    fn encode_input(&mut self, text: &str) -> Option<String> {
        serde_json::to_string(&UserInput::text(text)).ok()
    }

    fn encode_interrupt(&mut self) -> InterruptAction {
        self.next_request_id += 1;
        let envelope = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: format!("kanna-req-{}", self.next_request_id),
            request: ControlRequest::Interrupt,
        };
        match serde_json::to_string(&envelope) {
            Ok(line) => InterruptAction::StdinLine(line),
            // Serialization of this static shape cannot fail; fall back to a
            // signal rather than dropping the interrupt.
            Err(_) => InterruptAction::Signal,
        }
    }

    fn encode_set_model(&mut self, model: &str) -> Option<String> {
        self.next_request_id += 1;
        let envelope = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: format!("kanna-req-{}", self.next_request_id),
            request: ControlRequest::SetModel {
                model: model.to_string(),
            },
        };
        serde_json::to_string(&envelope).ok()
    }

    fn encode_permission_response(
        &mut self,
        request_id: &str,
        decision: &PermissionDecision,
    ) -> Option<String> {
        // AllowSession is enforced daemon-side as an auto-approval rule; on
        // the wire it is a plain allow.
        let result = match decision {
            PermissionDecision::Allow | PermissionDecision::AllowSession => {
                PermissionResult::allow()
            }
            PermissionDecision::Deny { reason } => PermissionResult::deny(
                reason
                    .clone()
                    .unwrap_or_else(|| "denied by user".to_string()),
            ),
        };
        let envelope = ControlResponseEnvelope {
            type_field: "control_response".to_string(),
            response: ControlResponse::Success {
                request_id: request_id.to_string(),
                response: serde_json::to_value(result).ok()?,
            },
        };
        serde_json::to_string(&envelope).ok()
    }
}

fn turn_stats(
    duration_ms: u64,
    duration_api_ms: u64,
    num_turns: u32,
    total_cost_usd: f64,
    usage: &claude_agent_sdk::types::messages::Usage,
) -> TurnStats {
    TurnStats {
        duration_ms,
        duration_api_ms: Some(duration_api_ms),
        num_turns,
        total_cost_usd: Some(total_cost_usd),
        input_tokens: Some(usage.input_tokens),
        output_tokens: Some(usage.output_tokens),
    }
}

/// Flatten tool-result content (string, content-block array, or arbitrary
/// JSON) into displayable text.
fn stringify_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let texts: Vec<String> = blocks
                .iter()
                .map(|b| match b.get("text").and_then(Value::as_str) {
                    Some(text) => text.to_string(),
                    None => b.to_string(),
                })
                .collect();
            texts.join("\n")
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn raw_event(line: &str) -> AgentEvent {
    AgentEvent::raw(line)
}
