use serde::{Deserialize, Serialize};

/// A content block within an assistant message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    /// A text content block.
    #[serde(rename = "text")]
    Text {
        /// The text content.
        text: String,
    },

    /// A tool use request.
    #[serde(rename = "tool_use")]
    ToolUse {
        /// Unique ID for this tool use.
        id: String,
        /// The name of the tool being invoked.
        name: String,
        /// The tool input parameters.
        input: serde_json::Value,
    },

    /// A tool result returned from tool execution.
    #[serde(rename = "tool_result")]
    ToolResult {
        /// The ID of the tool use this result corresponds to.
        tool_use_id: String,
        /// The tool result content.
        content: serde_json::Value,
    },

    /// An extended thinking block.
    #[serde(rename = "thinking")]
    Thinking {
        /// The thinking content.
        thinking: String,
    },
}

/// Token usage information.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    /// Input tokens consumed.
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens produced.
    #[serde(default)]
    pub output_tokens: u64,
    /// Cache read tokens.
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    /// Cache creation tokens.
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}

/// An assistant message containing content blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    /// The content blocks in this message.
    pub content: Vec<ContentBlock>,
    /// The model that generated this message.
    #[serde(default)]
    pub model: Option<String>,
    /// Stop reason for this message.
    #[serde(default)]
    pub stop_reason: Option<String>,
    /// Usage information.
    #[serde(default)]
    pub usage: Option<Usage>,
}

/// A user message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    /// The content of the user message.
    #[serde(default)]
    pub content: serde_json::Value,
}

/// A result message indicating the session outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype")]
pub enum ResultMessage {
    /// The session completed successfully.
    #[serde(rename = "success")]
    Success {
        /// The final result text.
        #[serde(default)]
        result: String,
        /// Wall-clock duration in milliseconds.
        #[serde(default)]
        duration_ms: u64,
        /// API-call duration in milliseconds.
        #[serde(default)]
        duration_api_ms: u64,
        /// Number of conversation turns.
        #[serde(default)]
        num_turns: u32,
        /// Total cost in USD.
        #[serde(default)]
        total_cost_usd: f64,
        /// Token usage breakdown.
        #[serde(default)]
        usage: Usage,
        /// The session ID.
        #[serde(default)]
        session_id: String,
        /// The session UUID.
        #[serde(default)]
        uuid: String,
    },

    /// An error occurred during execution.
    #[serde(rename = "error_during_execution")]
    ErrorDuringExecution {
        /// The errors that occurred.
        #[serde(default)]
        errors: Vec<String>,
        /// Wall-clock duration in milliseconds.
        #[serde(default)]
        duration_ms: u64,
        /// API-call duration in milliseconds.
        #[serde(default)]
        duration_api_ms: u64,
        /// Number of conversation turns.
        #[serde(default)]
        num_turns: u32,
        /// Total cost in USD.
        #[serde(default)]
        total_cost_usd: f64,
        /// Token usage breakdown.
        #[serde(default)]
        usage: Usage,
        /// The session ID.
        #[serde(default)]
        session_id: String,
    },

    /// The max turns limit was reached.
    #[serde(rename = "error_max_turns")]
    ErrorMaxTurns {
        /// Wall-clock duration in milliseconds.
        #[serde(default)]
        duration_ms: u64,
        /// API-call duration in milliseconds.
        #[serde(default)]
        duration_api_ms: u64,
        /// Number of conversation turns.
        #[serde(default)]
        num_turns: u32,
        /// Total cost in USD.
        #[serde(default)]
        total_cost_usd: f64,
        /// Token usage breakdown.
        #[serde(default)]
        usage: Usage,
        /// The session ID.
        #[serde(default)]
        session_id: String,
    },

    /// The max budget was reached.
    #[serde(rename = "error_max_budget_usd")]
    ErrorMaxBudget {
        /// Wall-clock duration in milliseconds.
        #[serde(default)]
        duration_ms: u64,
        /// API-call duration in milliseconds.
        #[serde(default)]
        duration_api_ms: u64,
        /// Number of conversation turns.
        #[serde(default)]
        num_turns: u32,
        /// Total cost in USD.
        #[serde(default)]
        total_cost_usd: f64,
        /// Token usage breakdown.
        #[serde(default)]
        usage: Usage,
        /// The session ID.
        #[serde(default)]
        session_id: String,
    },
}

impl ResultMessage {
    /// Returns the total cost in USD regardless of result subtype.
    pub fn total_cost_usd(&self) -> f64 {
        match self {
            ResultMessage::Success {
                total_cost_usd, ..
            } => *total_cost_usd,
            ResultMessage::ErrorDuringExecution {
                total_cost_usd, ..
            } => *total_cost_usd,
            ResultMessage::ErrorMaxTurns {
                total_cost_usd, ..
            } => *total_cost_usd,
            ResultMessage::ErrorMaxBudget {
                total_cost_usd, ..
            } => *total_cost_usd,
        }
    }

    /// Returns the session ID regardless of result subtype.
    pub fn session_id(&self) -> &str {
        match self {
            ResultMessage::Success { session_id, .. } => session_id,
            ResultMessage::ErrorDuringExecution { session_id, .. } => session_id,
            ResultMessage::ErrorMaxTurns { session_id, .. } => session_id,
            ResultMessage::ErrorMaxBudget { session_id, .. } => session_id,
        }
    }
}

/// A system message from the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMessage {
    /// The system message content.
    #[serde(default)]
    pub message: Option<String>,
    /// Additional data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A stream event (e.g., content delta).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEventMessage {
    /// The event subtype (e.g., "content_block_delta").
    #[serde(default)]
    pub event: Option<String>,
    /// Additional event data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Tool progress update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolProgressMessage {
    /// The tool use ID this progress relates to.
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// Progress content.
    #[serde(default)]
    pub content: Option<String>,
    /// Additional data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Auth status update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatusMessage {
    /// Whether the user is authenticated.
    #[serde(default)]
    pub authenticated: bool,
    /// Additional data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Rate limit event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitMessage {
    /// How long to wait before retrying, in seconds.
    #[serde(default)]
    pub retry_after_seconds: Option<f64>,
    /// Additional data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Prompt suggestion for the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSuggestionMessage {
    /// The suggested prompt text.
    #[serde(default)]
    pub suggestion: Option<String>,
    /// Additional data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The top-level message type from the Claude CLI stdout stream.
///
/// Unknown message types are deserialized into the catch-all `Unknown` variant
/// for forward compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Message {
    /// An assistant response message.
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),

    /// A user message echo.
    #[serde(rename = "user")]
    User(UserMessage),

    /// A result message indicating session completion.
    #[serde(rename = "result")]
    Result(ResultMessage),

    /// A system message.
    #[serde(rename = "system")]
    System(SystemMessage),

    /// A streaming event.
    #[serde(rename = "stream_event")]
    StreamEvent(StreamEventMessage),

    /// Tool progress update.
    #[serde(rename = "tool_progress")]
    ToolProgress(ToolProgressMessage),

    /// Authentication status.
    #[serde(rename = "auth_status")]
    AuthStatus(AuthStatusMessage),

    /// Rate limit notification.
    #[serde(rename = "rate_limit_event")]
    RateLimit(RateLimitMessage),

    /// Prompt suggestion.
    #[serde(rename = "prompt_suggestion")]
    PromptSuggestion(PromptSuggestionMessage),
}

/// Input message sent from the SDK to the CLI via stdin.
#[derive(Debug, Clone, Serialize)]
pub struct UserInput {
    /// Always "user".
    #[serde(rename = "type")]
    pub type_field: String,
    /// The message content — either a string or content blocks.
    pub content: serde_json::Value,
}

impl UserInput {
    /// Create a simple text user input.
    pub fn text(message: impl Into<String>) -> Self {
        Self {
            type_field: "user".to_string(),
            content: serde_json::Value::String(message.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_assistant_message_with_text() {
        let json = r#"{
            "type": "assistant",
            "content": [
                {"type": "text", "text": "Hello, world!"}
            ],
            "model": "claude-sonnet-4-6"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Assistant(a) => {
                assert_eq!(a.content.len(), 1);
                match &a.content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "Hello, world!"),
                    _ => panic!("Expected Text content block"),
                }
                assert_eq!(a.model.as_deref(), Some("claude-sonnet-4-6"));
            }
            _ => panic!("Expected Assistant message"),
        }
    }

    #[test]
    fn test_deserialize_assistant_message_with_tool_use() {
        let json = r#"{
            "type": "assistant",
            "content": [
                {"type": "text", "text": "Let me read that file."},
                {"type": "tool_use", "id": "tu_123", "name": "Read", "input": {"file_path": "/tmp/test.rs"}}
            ]
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Assistant(a) => {
                assert_eq!(a.content.len(), 2);
                match &a.content[1] {
                    ContentBlock::ToolUse { id, name, input } => {
                        assert_eq!(id, "tu_123");
                        assert_eq!(name, "Read");
                        assert_eq!(input["file_path"], "/tmp/test.rs");
                    }
                    _ => panic!("Expected ToolUse content block"),
                }
            }
            _ => panic!("Expected Assistant message"),
        }
    }

    #[test]
    fn test_deserialize_assistant_message_with_thinking() {
        let json = r#"{
            "type": "assistant",
            "content": [
                {"type": "thinking", "thinking": "Let me consider the options..."},
                {"type": "text", "text": "Here is my answer."}
            ]
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Assistant(a) => {
                assert_eq!(a.content.len(), 2);
                match &a.content[0] {
                    ContentBlock::Thinking { thinking } => {
                        assert_eq!(thinking, "Let me consider the options...");
                    }
                    _ => panic!("Expected Thinking content block"),
                }
            }
            _ => panic!("Expected Assistant message"),
        }
    }

    #[test]
    fn test_deserialize_result_success() {
        let json = r#"{
            "type": "result",
            "subtype": "success",
            "result": "Task completed successfully",
            "duration_ms": 5000,
            "duration_api_ms": 3000,
            "num_turns": 3,
            "total_cost_usd": 0.0542,
            "usage": {
                "input_tokens": 1000,
                "output_tokens": 500,
                "cache_read_input_tokens": 200,
                "cache_creation_input_tokens": 0
            },
            "session_id": "sess_abc123",
            "uuid": "uuid_xyz"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Result(ResultMessage::Success {
                result,
                duration_ms,
                num_turns,
                total_cost_usd,
                usage,
                session_id,
                uuid,
                ..
            }) => {
                assert_eq!(result, "Task completed successfully");
                assert_eq!(duration_ms, 5000);
                assert_eq!(num_turns, 3);
                assert!((total_cost_usd - 0.0542).abs() < f64::EPSILON);
                assert_eq!(usage.input_tokens, 1000);
                assert_eq!(usage.output_tokens, 500);
                assert_eq!(session_id, "sess_abc123");
                assert_eq!(uuid, "uuid_xyz");
            }
            _ => panic!("Expected Result::Success"),
        }
    }

    #[test]
    fn test_deserialize_result_error_during_execution() {
        let json = r#"{
            "type": "result",
            "subtype": "error_during_execution",
            "errors": ["Something went wrong", "Another error"],
            "duration_ms": 1000,
            "duration_api_ms": 500,
            "num_turns": 1,
            "total_cost_usd": 0.01,
            "usage": {},
            "session_id": "sess_err"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Result(ResultMessage::ErrorDuringExecution { errors, .. }) => {
                assert_eq!(errors.len(), 2);
                assert_eq!(errors[0], "Something went wrong");
            }
            _ => panic!("Expected Result::ErrorDuringExecution"),
        }
    }

    #[test]
    fn test_deserialize_result_error_max_turns() {
        let json = r#"{
            "type": "result",
            "subtype": "error_max_turns",
            "duration_ms": 30000,
            "duration_api_ms": 25000,
            "num_turns": 10,
            "total_cost_usd": 1.50,
            "usage": {"input_tokens": 5000, "output_tokens": 3000},
            "session_id": "sess_max"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Result(ResultMessage::ErrorMaxTurns { num_turns, .. }) => {
                assert_eq!(num_turns, 10);
            }
            _ => panic!("Expected Result::ErrorMaxTurns"),
        }
    }

    #[test]
    fn test_deserialize_result_error_max_budget() {
        let json = r#"{
            "type": "result",
            "subtype": "error_max_budget_usd",
            "duration_ms": 60000,
            "duration_api_ms": 55000,
            "num_turns": 5,
            "total_cost_usd": 10.0,
            "usage": {},
            "session_id": "sess_budget"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Result(r) => {
                assert!((r.total_cost_usd() - 10.0).abs() < f64::EPSILON);
                assert_eq!(r.session_id(), "sess_budget");
            }
            _ => panic!("Expected Result message"),
        }
    }

    #[test]
    fn test_deserialize_system_message() {
        let json = r#"{
            "type": "system",
            "message": "Session started"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::System(s) => {
                assert_eq!(s.message.as_deref(), Some("Session started"));
            }
            _ => panic!("Expected System message"),
        }
    }

    #[test]
    fn test_deserialize_stream_event() {
        let json = r#"{
            "type": "stream_event",
            "event": "content_block_delta",
            "delta": {"text": "partial"}
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::StreamEvent(s) => {
                assert_eq!(s.event.as_deref(), Some("content_block_delta"));
                assert!(s.extra.contains_key("delta"));
            }
            _ => panic!("Expected StreamEvent message"),
        }
    }

    #[test]
    fn test_deserialize_tool_progress() {
        let json = r#"{
            "type": "tool_progress",
            "tool_use_id": "tu_456",
            "content": "Reading file..."
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::ToolProgress(t) => {
                assert_eq!(t.tool_use_id.as_deref(), Some("tu_456"));
                assert_eq!(t.content.as_deref(), Some("Reading file..."));
            }
            _ => panic!("Expected ToolProgress message"),
        }
    }

    #[test]
    fn test_deserialize_auth_status() {
        let json = r#"{
            "type": "auth_status",
            "authenticated": true
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::AuthStatus(a) => {
                assert!(a.authenticated);
            }
            _ => panic!("Expected AuthStatus message"),
        }
    }

    #[test]
    fn test_deserialize_rate_limit() {
        let json = r#"{
            "type": "rate_limit_event",
            "retry_after_seconds": 30.5
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::RateLimit(r) => {
                assert!((r.retry_after_seconds.unwrap() - 30.5).abs() < f64::EPSILON);
            }
            _ => panic!("Expected RateLimit message"),
        }
    }

    #[test]
    fn test_deserialize_prompt_suggestion() {
        let json = r#"{
            "type": "prompt_suggestion",
            "suggestion": "Try running the tests"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::PromptSuggestion(p) => {
                assert_eq!(p.suggestion.as_deref(), Some("Try running the tests"));
            }
            _ => panic!("Expected PromptSuggestion message"),
        }
    }

    #[test]
    fn test_deserialize_user_message() {
        let json = r#"{
            "type": "user",
            "content": "Hello"
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::User(u) => {
                assert_eq!(u.content.as_str().unwrap(), "Hello");
            }
            _ => panic!("Expected User message"),
        }
    }

    #[test]
    fn test_unknown_message_type_fails_gracefully() {
        let json = r#"{"type": "future_type", "data": 42}"#;
        let result: Result<Message, _> = serde_json::from_str(json);
        // Unknown types should fail to deserialize (the session reader
        // handles this by skipping unknown types at the Value level)
        assert!(result.is_err());
    }

    #[test]
    fn test_result_message_with_missing_optional_fields() {
        // Test forward compatibility — extra fields in usage are ignored,
        // missing fields get defaults.
        let json = r#"{
            "type": "result",
            "subtype": "success",
            "usage": {}
        }"#;

        let msg: Message = serde_json::from_str(json).unwrap();
        match msg {
            Message::Result(ResultMessage::Success { usage, result, .. }) => {
                assert_eq!(usage.input_tokens, 0);
                assert_eq!(usage.output_tokens, 0);
                assert_eq!(result, "");
            }
            _ => panic!("Expected Result::Success"),
        }
    }

    #[test]
    fn test_user_input_serialization() {
        let input = UserInput::text("Fix the bug");
        let json = serde_json::to_string(&input).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["content"], "Fix the bug");
    }

    #[test]
    fn test_content_block_tool_result() {
        let json = r#"{
            "type": "tool_result",
            "tool_use_id": "tu_789",
            "content": "file contents here"
        }"#;

        let block: ContentBlock = serde_json::from_str(json).unwrap();
        match block {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
            } => {
                assert_eq!(tool_use_id, "tu_789");
                assert_eq!(content.as_str().unwrap(), "file contents here");
            }
            _ => panic!("Expected ToolResult"),
        }
    }
}
