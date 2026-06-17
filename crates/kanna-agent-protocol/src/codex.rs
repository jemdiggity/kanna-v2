//! Codex CLI adapter: `codex exec --json` JSONL output.
//!
//! Codex has no persistent stdin protocol — every user message is a
//! resume-respawn (`codex exec resume <thread_id> --json`), i.e.
//! [`TurnModel::PerTurn`]. There are no interactive permission requests in
//! exec mode; the session runs under Codex's sandbox/approval policy.
//!
//! Daemon note (phase 2): `codex exec` reads stdin to EOF when it is piped —
//! spawned agent sessions must close the child's stdin immediately or the
//! process waits forever before starting.

use std::collections::HashSet;
use std::time::Instant;

use serde_json::Value;

use crate::adapter::{
    Capabilities, InterruptAction, ProviderAdapter, SpawnCtx, SpawnSpec, TurnModel,
};
use crate::events::{truncate_text, AgentEvent, PermissionDecision, TurnStats, TurnStatus};

/// Adapter for the Codex CLI.
#[derive(Debug, Default)]
pub struct CodexAdapter {
    thread_id: Option<String>,
    /// Item ids whose `ToolCall` was already emitted (on `item.started`), so
    /// `item.completed` only adds the matching `ToolResult`.
    announced_calls: HashSet<String>,
    /// Wall-clock start of the in-flight turn. Codex's `turn.completed` carries
    /// only token usage (no duration/turn count), so we measure both ourselves.
    turn_started_at: Option<Instant>,
    /// Agentic steps (completed items: tool runs, messages) in the current turn
    /// — the closest analog to Claude's `num_turns`.
    turn_steps: u32,
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    fn base_args(ctx: &SpawnCtx) -> Vec<String> {
        let mut args = vec!["exec".to_string()];
        args.extend(Self::permission_args(ctx.permission_mode.as_deref()));
        if let Some(model) = &ctx.model {
            args.push("-m".to_string());
            args.push(model.clone());
        }
        args.push("--json".to_string());
        args
    }

    fn permission_args(permission_mode: Option<&str>) -> Vec<String> {
        match permission_mode {
            None | Some("default" | "dontAsk") => vec!["--yolo".to_string()],
            Some(_) => vec!["--full-auto".to_string()],
        }
    }

    fn translate_item(&mut self, kind: &str, value: &Value, line: &str) -> Vec<AgentEvent> {
        let Some(item) = value.get("item") else {
            return vec![AgentEvent::raw(line)];
        };
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        let completed = kind == "item.completed";

        match item_type {
            "agent_message" => {
                if !completed {
                    return Vec::new();
                }
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if text.is_empty() {
                    return Vec::new();
                }
                let (text, truncated) = truncate_text(text);
                vec![AgentEvent::AssistantText { text, truncated }]
            }
            "reasoning" => {
                if !completed {
                    return Vec::new();
                }
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if text.is_empty() {
                    return Vec::new();
                }
                let (text, truncated) = truncate_text(text);
                vec![AgentEvent::Thinking { text, truncated }]
            }
            "command_execution" => {
                let command = item
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let tool_call = AgentEvent::ToolCall {
                    call_id: item_id.clone(),
                    tool_name: "shell".to_string(),
                    input: serde_json::json!({ "command": command }),
                };
                if !completed {
                    self.announced_calls.insert(item_id);
                    return vec![tool_call];
                }
                let mut events = Vec::new();
                if !self.announced_calls.remove(&item_id) {
                    events.push(tool_call);
                }
                let output = item
                    .get("aggregated_output")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let exit_code = item.get("exit_code").and_then(Value::as_i64);
                let failed = item.get("status").and_then(Value::as_str) == Some("failed");
                let (output, truncated) = truncate_text(output);
                events.push(AgentEvent::ToolResult {
                    call_id: item_id,
                    output,
                    truncated,
                    is_error: failed || exit_code.is_some_and(|c| c != 0),
                });
                events
            }
            "mcp_tool_call" => {
                let server = item.get("server").and_then(Value::as_str).unwrap_or("mcp");
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
                let tool_call = AgentEvent::ToolCall {
                    call_id: item_id.clone(),
                    tool_name: format!("{server}.{tool}"),
                    input: item.get("arguments").cloned().unwrap_or(Value::Null),
                };
                if !completed {
                    self.announced_calls.insert(item_id);
                    return vec![tool_call];
                }
                let mut events = Vec::new();
                if !self.announced_calls.remove(&item_id) {
                    events.push(tool_call);
                }
                let status = item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                events.push(AgentEvent::ToolResult {
                    call_id: item_id,
                    output: status.to_string(),
                    truncated: false,
                    is_error: status == "failed",
                });
                events
            }
            "file_change" => {
                if !completed {
                    return Vec::new();
                }
                let status = item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                vec![
                    AgentEvent::ToolCall {
                        call_id: item_id.clone(),
                        tool_name: "file_change".to_string(),
                        input: item.get("changes").cloned().unwrap_or(Value::Null),
                    },
                    AgentEvent::ToolResult {
                        call_id: item_id,
                        output: status.to_string(),
                        truncated: false,
                        is_error: status == "failed",
                    },
                ]
            }
            "web_search" => {
                if !completed {
                    return Vec::new();
                }
                vec![
                    AgentEvent::ToolCall {
                        call_id: item_id.clone(),
                        tool_name: "web_search".to_string(),
                        input: serde_json::json!({
                            "query": item.get("query").and_then(Value::as_str).unwrap_or_default()
                        }),
                    },
                    AgentEvent::ToolResult {
                        call_id: item_id,
                        output: "completed".to_string(),
                        truncated: false,
                        is_error: false,
                    },
                ]
            }
            "error" => {
                let message = item
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex error item")
                    .to_string();
                vec![AgentEvent::Diagnostic { message }]
            }
            _ => vec![AgentEvent::raw(line)],
        }
    }
}

impl ProviderAdapter for CodexAdapter {
    fn provider(&self) -> &'static str {
        "codex"
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
        args.push(ctx.prompt.clone());
        SpawnSpec {
            executable: "codex".to_string(),
            args,
            env: Vec::new(),
            initial_stdin: None,
        }
    }

    fn resume_spawn(&self, ctx: &SpawnCtx, session_id: &str, message: &str) -> SpawnSpec {
        let mut args = vec![
            "exec".to_string(),
            "resume".to_string(),
            session_id.to_string(),
        ];
        args.extend(Self::permission_args(ctx.permission_mode.as_deref()));
        if let Some(model) = &ctx.model {
            args.push("-m".to_string());
            args.push(model.clone());
        }
        args.push("--json".to_string());
        args.push(message.to_string());
        SpawnSpec {
            executable: "codex".to_string(),
            args,
            env: Vec::new(),
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

        match value.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                if let Some(id) = value.get("thread_id").and_then(Value::as_str) {
                    self.thread_id = Some(id.to_string());
                }
                Vec::new()
            }
            Some("turn.started") => {
                self.turn_started_at = Some(Instant::now());
                self.turn_steps = 0;
                vec![AgentEvent::TurnStarted { model: None }]
            }
            Some(kind @ ("item.started" | "item.updated" | "item.completed")) => {
                if kind == "item.updated" {
                    // Incremental output updates; the completed item carries
                    // the full aggregated output.
                    return Vec::new();
                }
                let events = self.translate_item(kind, &value, line);
                // Count each recognized completed item (tool run or message) as
                // an agentic step. Unrecognized items surface as `Raw` and are
                // not steps, so they don't inflate the turn count.
                if kind == "item.completed"
                    && !events.is_empty()
                    && !events.iter().all(|e| matches!(e, AgentEvent::Raw { .. }))
                {
                    self.turn_steps += 1;
                }
                events
            }
            Some("turn.completed") => {
                let usage = value.get("usage");
                let stats = TurnStats {
                    duration_ms: self
                        .turn_started_at
                        .take()
                        .map(|started| started.elapsed().as_millis() as u64)
                        .unwrap_or(0),
                    num_turns: self.turn_steps,
                    input_tokens: usage
                        .and_then(|u| u.get("input_tokens"))
                        .and_then(Value::as_u64),
                    output_tokens: usage
                        .and_then(|u| u.get("output_tokens"))
                        .and_then(Value::as_u64),
                    ..TurnStats::default()
                };
                self.turn_steps = 0;
                vec![AgentEvent::TurnCompleted {
                    status: TurnStatus::Success,
                    stats,
                }]
            }
            Some("turn.failed") => {
                let message = value
                    .get("error")
                    .map(|e| {
                        e.get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| e.to_string())
                    })
                    .unwrap_or_else(|| "turn failed".to_string());
                vec![
                    AgentEvent::Diagnostic { message },
                    AgentEvent::TurnCompleted {
                        status: TurnStatus::Error,
                        stats: TurnStats::default(),
                    },
                ]
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex error")
                    .to_string();
                vec![AgentEvent::Diagnostic { message }]
            }
            _ => vec![AgentEvent::raw(line)],
        }
    }

    fn provider_session_id(&self) -> Option<String> {
        self.thread_id.clone()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_spawn_uses_yolo_permissions_by_default() {
        let adapter = CodexAdapter::new();
        let spec = adapter.initial_spawn(&SpawnCtx {
            prompt: "ship it".to_string(),
            ..SpawnCtx::default()
        });

        assert_eq!(spec.args, vec!["exec", "--yolo", "--json", "ship it"]);
    }

    #[test]
    fn initial_spawn_maps_dont_ask_to_yolo() {
        let adapter = CodexAdapter::new();
        let spec = adapter.initial_spawn(&SpawnCtx {
            prompt: "ship it".to_string(),
            permission_mode: Some("dontAsk".to_string()),
            ..SpawnCtx::default()
        });

        assert_eq!(spec.args, vec!["exec", "--yolo", "--json", "ship it"]);
    }

    #[test]
    fn resume_spawn_preserves_yolo_permissions() {
        let adapter = CodexAdapter::new();
        let spec = adapter.resume_spawn(
            &SpawnCtx {
                permission_mode: Some("default".to_string()),
                ..SpawnCtx::default()
            },
            "thread-1",
            "continue",
        );

        assert_eq!(
            spec.args,
            vec!["exec", "resume", "thread-1", "--yolo", "--json", "continue"],
        );
    }

    #[test]
    fn explicit_non_yolo_permission_uses_full_auto() {
        let adapter = CodexAdapter::new();
        let spec = adapter.initial_spawn(&SpawnCtx {
            prompt: "ship it".to_string(),
            permission_mode: Some("acceptEdits".to_string()),
            ..SpawnCtx::default()
        });

        assert_eq!(spec.args, vec!["exec", "--full-auto", "--json", "ship it"]);
    }
}
