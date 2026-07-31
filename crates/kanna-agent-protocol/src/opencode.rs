//! Opencode CLI adapter: `opencode run --format json` JSONL output.
//!
//! Opencode runs one non-interactive process per prompt/resume in structured
//! mode. Follow-up user messages respawn with `opencode run --format json
//! --session <session_id>`, so this adapter uses [`TurnModel::PerTurn`].

use std::collections::HashSet;

use serde_json::Value;

use crate::adapter::{
    prompt_with_system_prompt, Capabilities, InterruptAction, ProviderAdapter, SpawnCtx, SpawnSpec,
    TurnModel,
};
use crate::events::{truncate_text, AgentEvent, PermissionDecision, TurnStats, TurnStatus};
use crate::mcp::{opencode_mcp_config_content, read_kanna_mcp_server};

/// Adapter for the Opencode CLI.
#[derive(Debug, Default)]
pub struct OpencodeAdapter {
    session_id: Option<String>,
    announced_calls: HashSet<String>,
    turn_started_timestamp: Option<u64>,
    turn_steps: u32,
}

impl OpencodeAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    fn should_skip_permissions(ctx: &SpawnCtx) -> bool {
        matches!(
            ctx.permission_mode.as_deref(),
            None | Some("default") | Some("dontAsk")
        )
    }

    fn base_args(ctx: &SpawnCtx) -> Vec<String> {
        let mut args = vec![
            "run".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        if !ctx.cwd.trim().is_empty() {
            args.push("--dir".to_string());
            args.push(ctx.cwd.clone());
        }
        if Self::should_skip_permissions(ctx) {
            args.push("--dangerously-skip-permissions".to_string());
        }
        if let Some(model) = &ctx.model {
            args.push("-m".to_string());
            args.push(model.clone());
        }
        if let Some(effort) = &ctx.effort {
            args.push("--variant".to_string());
            args.push(effort.clone());
        }
        args
    }

    fn mcp_env(ctx: &SpawnCtx) -> Vec<(String, String)> {
        ctx.mcp_config_path
            .as_deref()
            .and_then(read_kanna_mcp_server)
            .and_then(|server| opencode_mcp_config_content(&server))
            .map(|content| vec![("OPENCODE_CONFIG_CONTENT".to_string(), content)])
            .unwrap_or_default()
    }

    fn capture_session_id(&mut self, value: &Value) {
        let id = value.get("sessionID").and_then(Value::as_str).or_else(|| {
            value
                .get("part")
                .and_then(|part| part.get("sessionID"))
                .and_then(Value::as_str)
        });
        if let Some(id) = id {
            if !id.is_empty() {
                self.session_id = Some(id.to_string());
            }
        }
    }

    fn timestamp(value: &Value) -> Option<u64> {
        value.get("timestamp").and_then(Value::as_u64)
    }

    fn part<'a>(value: &'a Value, line: &str) -> Result<&'a Value, AgentEvent> {
        value.get("part").ok_or_else(|| AgentEvent::raw(line))
    }

    fn translate_text(&mut self, value: &Value, line: &str) -> Vec<AgentEvent> {
        let Ok(part) = Self::part(value, line) else {
            return vec![AgentEvent::raw(line)];
        };
        let text = part
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if text.is_empty() {
            return Vec::new();
        }
        self.turn_steps += 1;
        let (text, truncated) = truncate_text(text);
        vec![AgentEvent::AssistantText { text, truncated }]
    }

    fn translate_reasoning(&mut self, value: &Value, line: &str) -> Vec<AgentEvent> {
        let Ok(part) = Self::part(value, line) else {
            return vec![AgentEvent::raw(line)];
        };
        let text = part
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if text.is_empty() {
            return Vec::new();
        }
        self.turn_steps += 1;
        let (text, truncated) = truncate_text(text);
        vec![AgentEvent::Thinking { text, truncated }]
    }

    fn translate_tool_use(&mut self, value: &Value, line: &str) -> Vec<AgentEvent> {
        let Ok(part) = Self::part(value, line) else {
            return vec![AgentEvent::raw(line)];
        };
        let Some(call_id) = part
            .get("callID")
            .and_then(Value::as_str)
            .or_else(|| part.get("id").and_then(Value::as_str))
        else {
            return vec![AgentEvent::raw(line)];
        };
        if call_id.is_empty() {
            return vec![AgentEvent::raw(line)];
        }

        let tool_name = part
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let state = part.get("state");
        let status = state
            .and_then(|state| state.get("status"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tool_call = AgentEvent::ToolCall {
            call_id: call_id.to_string(),
            tool_name,
            input: state
                .and_then(|state| state.get("input"))
                .cloned()
                .unwrap_or(Value::Null),
        };

        if !matches!(status, "completed" | "failed" | "error") {
            self.announced_calls.insert(call_id.to_string());
            return vec![tool_call];
        }

        let mut events = Vec::new();
        if !self.announced_calls.remove(call_id) {
            events.push(tool_call);
        }
        let output = state
            .and_then(|state| state.get("output"))
            .or_else(|| {
                state
                    .and_then(|state| state.get("metadata"))
                    .and_then(|metadata| metadata.get("output"))
            })
            .map(value_to_text)
            .unwrap_or_default();
        let exit_code = state
            .and_then(|state| state.get("metadata"))
            .and_then(|metadata| metadata.get("exit"))
            .and_then(Value::as_i64);
        let (output, truncated) = truncate_text(output);
        events.push(AgentEvent::ToolResult {
            call_id: call_id.to_string(),
            output,
            truncated,
            is_error: matches!(status, "failed" | "error") || exit_code.is_some_and(|c| c != 0),
        });
        self.turn_steps += 1;
        events
    }

    fn translate_step_finish(&mut self, value: &Value, line: &str) -> Vec<AgentEvent> {
        let Ok(part) = Self::part(value, line) else {
            return vec![AgentEvent::raw(line)];
        };
        if part.get("reason").and_then(Value::as_str) == Some("tool-calls") {
            return Vec::new();
        }

        let duration_ms = Self::timestamp(value)
            .zip(self.turn_started_timestamp.take())
            .map(|(finished, started)| finished.saturating_sub(started))
            .unwrap_or(0);
        let tokens = part.get("tokens");
        let stats = TurnStats {
            duration_ms,
            num_turns: self.turn_steps,
            total_cost_usd: part.get("cost").and_then(Value::as_f64),
            input_tokens: tokens
                .and_then(|tokens| tokens.get("input"))
                .and_then(Value::as_u64),
            output_tokens: tokens
                .and_then(|tokens| tokens.get("output"))
                .and_then(Value::as_u64),
            ..TurnStats::default()
        };
        self.turn_steps = 0;
        vec![AgentEvent::TurnCompleted {
            status: TurnStatus::Success,
            stats,
        }]
    }

    fn translate_error(&mut self, value: &Value) -> Vec<AgentEvent> {
        let error = value.get("error");
        let name = error
            .and_then(|error| error.get("name"))
            .and_then(Value::as_str);
        let detail = error
            .and_then(|error| error.get("data"))
            .and_then(|data| data.get("message"))
            .and_then(Value::as_str)
            .or_else(|| {
                error
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
            })
            .or_else(|| value.get("message").and_then(Value::as_str));
        let message = match (name, detail) {
            (Some(name), Some(detail)) if !name.is_empty() && !detail.is_empty() => {
                format!("{name}: {detail}")
            }
            (Some(name), _) if !name.is_empty() => name.to_string(),
            (_, Some(detail)) if !detail.is_empty() => detail.to_string(),
            _ => "opencode error".to_string(),
        };
        self.turn_started_timestamp = None;
        self.turn_steps = 0;
        vec![
            AgentEvent::Diagnostic { message },
            AgentEvent::TurnCompleted {
                status: TurnStatus::Error,
                stats: TurnStats::default(),
            },
        ]
    }
}

impl ProviderAdapter for OpencodeAdapter {
    fn provider(&self) -> &'static str {
        "opencode"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            permission_requests: false,
            mid_run_input: false,
        }
    }

    fn turn_model(&self) -> TurnModel {
        TurnModel::PerTurn
    }

    fn initial_spawn(&self, ctx: &SpawnCtx) -> SpawnSpec {
        let mut args = Self::base_args(ctx);
        args.push(prompt_with_system_prompt(
            ctx.system_prompt.as_deref(),
            &ctx.prompt,
        ));
        SpawnSpec {
            executable: "opencode".to_string(),
            args,
            env: Self::mcp_env(ctx),
            initial_stdin: None,
        }
    }

    fn resume_spawn(&self, ctx: &SpawnCtx, session_id: &str, message: &str) -> SpawnSpec {
        let mut args = Self::base_args(ctx);
        args.splice(3..3, ["--session".to_string(), session_id.to_string()]);
        args.push(message.to_string());
        SpawnSpec {
            executable: "opencode".to_string(),
            args,
            env: Self::mcp_env(ctx),
            initial_stdin: None,
        }
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![AgentEvent::raw(line)];
        };
        self.capture_session_id(&value);

        match value.get("type").and_then(Value::as_str) {
            Some("step_start") => {
                self.turn_started_timestamp = Self::timestamp(&value);
                self.turn_steps = 0;
                vec![AgentEvent::TurnStarted { model: None }]
            }
            Some("text") => self.translate_text(&value, line),
            Some("reasoning") => self.translate_reasoning(&value, line),
            Some("tool_use") => self.translate_tool_use(&value, line),
            Some("step_finish") => self.translate_step_finish(&value, line),
            Some("error") => self.translate_error(&value),
            _ => vec![AgentEvent::raw(line)],
        }
    }

    fn provider_session_id(&self) -> Option<String> {
        self.session_id.clone()
    }

    fn encode_input(&mut self, _text: &str) -> Option<String> {
        None
    }

    fn encode_interrupt(&mut self) -> InterruptAction {
        InterruptAction::Signal
    }

    fn encode_permission_response(
        &mut self,
        _request_id: &str,
        _decision: &PermissionDecision,
    ) -> Option<String> {
        None
    }
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_spawn_prepends_system_prompt_to_user_prompt() {
        let adapter = OpencodeAdapter::new();
        let spec = adapter.initial_spawn(&SpawnCtx {
            prompt: "ship it".to_string(),
            system_prompt: Some("Kanna task context".to_string()),
            ..SpawnCtx::default()
        });

        assert_eq!(
            spec.args.last().map(String::as_str),
            Some("Kanna task context\n\n## Your Task\n\nship it")
        );
    }
}
