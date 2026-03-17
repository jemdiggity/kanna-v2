use std::collections::HashMap;

use crate::types::permissions::PermissionMode;

/// Thinking mode for the Claude session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThinkingMode {
    /// Adaptive thinking (model decides when to think).
    Adaptive,
    /// Thinking is disabled.
    Disabled,
}

impl ThinkingMode {
    /// Returns the CLI flag value.
    pub fn as_cli_flag(&self) -> &str {
        match self {
            ThinkingMode::Adaptive => "adaptive",
            ThinkingMode::Disabled => "disabled",
        }
    }
}

/// Effort level for the Claude session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effort {
    Low,
    Medium,
    High,
    Max,
}

impl Effort {
    /// Returns the CLI flag value.
    pub fn as_cli_flag(&self) -> &str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Max => "max",
        }
    }
}

/// Options for starting a Claude CLI session.
///
/// Use the builder pattern via `SessionOptions::builder()`.
#[derive(Debug, Clone)]
pub struct SessionOptions {
    /// Working directory for the CLI process.
    pub cwd: Option<String>,
    /// Model identifier (e.g., "claude-sonnet-4-6").
    pub model: Option<String>,
    /// Permission mode for tool usage.
    pub permission_mode: Option<PermissionMode>,
    /// Tools that are explicitly allowed.
    pub allowed_tools: Vec<String>,
    /// Tools that are explicitly disallowed.
    pub disallowed_tools: Vec<String>,
    /// Maximum number of conversation turns.
    pub max_turns: Option<u32>,
    /// Maximum budget in USD.
    pub max_budget_usd: Option<f64>,
    /// Resume a previous session by ID.
    pub resume: Option<String>,
    /// Continue the most recent session.
    pub continue_session: bool,
    /// System prompt override.
    pub system_prompt: Option<String>,
    /// Thinking mode.
    pub thinking: Option<ThinkingMode>,
    /// Effort level.
    pub effort: Option<Effort>,
    /// Additional environment variables for the CLI process.
    pub env: HashMap<String, String>,
    /// Whether to include partial/streaming messages.
    pub include_partial_messages: bool,
    /// Additional directories to include in context.
    pub additional_directories: Vec<String>,
    /// Whether a permission callback is registered (adds --permission-prompt-tool stdio).
    pub has_permission_callback: bool,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            cwd: None,
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
            resume: None,
            continue_session: false,
            system_prompt: None,
            thinking: None,
            effort: None,
            env: HashMap::new(),
            include_partial_messages: false,
            additional_directories: Vec::new(),
            has_permission_callback: false,
        }
    }
}

impl SessionOptions {
    /// Create a new builder for session options.
    pub fn builder() -> SessionOptionsBuilder {
        SessionOptionsBuilder::default()
    }

    /// Convert these options into CLI arguments.
    ///
    /// Always includes: `--output-format stream-json --input-format stream-json --verbose`
    pub fn to_cli_args(&self) -> Vec<String> {
        let mut args = vec![
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];

        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(mode) = &self.permission_mode {
            args.push("--permission-mode".to_string());
            args.push(mode.as_cli_flag().to_string());
        }

        if !self.allowed_tools.is_empty() {
            args.push("--allowedTools".to_string());
            args.push(self.allowed_tools.join(","));
        }

        if !self.disallowed_tools.is_empty() {
            args.push("--disallowedTools".to_string());
            args.push(self.disallowed_tools.join(","));
        }

        if let Some(max_turns) = self.max_turns {
            args.push("--max-turns".to_string());
            args.push(max_turns.to_string());
        }

        if let Some(max_budget) = self.max_budget_usd {
            args.push("--max-budget-usd".to_string());
            args.push(max_budget.to_string());
        }

        if let Some(session_id) = &self.resume {
            args.push("--resume".to_string());
            args.push(session_id.clone());
        }

        if self.continue_session {
            args.push("--continue".to_string());
        }

        if let Some(prompt) = &self.system_prompt {
            args.push("--system-prompt".to_string());
            args.push(prompt.clone());
        }

        if let Some(thinking) = &self.thinking {
            args.push("--thinking".to_string());
            args.push(thinking.as_cli_flag().to_string());
        }

        if let Some(effort) = &self.effort {
            args.push("--effort".to_string());
            args.push(effort.as_cli_flag().to_string());
        }

        if self.include_partial_messages {
            args.push("--include-partial-messages".to_string());
        }

        for dir in &self.additional_directories {
            args.push("--add-dir".to_string());
            args.push(dir.clone());
        }

        if self.has_permission_callback {
            args.push("--permission-prompt-tool".to_string());
            args.push("stdio".to_string());
        }

        args
    }
}

/// Builder for `SessionOptions`.
#[derive(Debug, Default)]
pub struct SessionOptionsBuilder {
    options: SessionOptions,
}

impl SessionOptionsBuilder {
    /// Set the working directory for the CLI process.
    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.options.cwd = Some(cwd.into());
        self
    }

    /// Set the model identifier.
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.options.model = Some(model.into());
        self
    }

    /// Set the permission mode.
    pub fn permission_mode(mut self, mode: PermissionMode) -> Self {
        self.options.permission_mode = Some(mode);
        self
    }

    /// Set the list of allowed tools.
    pub fn allowed_tools(mut self, tools: Vec<impl Into<String>>) -> Self {
        self.options.allowed_tools = tools.into_iter().map(Into::into).collect();
        self
    }

    /// Set the list of disallowed tools.
    pub fn disallowed_tools(mut self, tools: Vec<impl Into<String>>) -> Self {
        self.options.disallowed_tools = tools.into_iter().map(Into::into).collect();
        self
    }

    /// Set the maximum number of turns.
    pub fn max_turns(mut self, n: u32) -> Self {
        self.options.max_turns = Some(n);
        self
    }

    /// Set the maximum budget in USD.
    pub fn max_budget_usd(mut self, budget: f64) -> Self {
        self.options.max_budget_usd = Some(budget);
        self
    }

    /// Resume a previous session by ID.
    pub fn resume(mut self, session_id: impl Into<String>) -> Self {
        self.options.resume = Some(session_id.into());
        self
    }

    /// Continue the most recent session.
    pub fn continue_session(mut self) -> Self {
        self.options.continue_session = true;
        self
    }

    /// Set a system prompt override.
    pub fn system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.options.system_prompt = Some(prompt.into());
        self
    }

    /// Set the thinking mode.
    pub fn thinking(mut self, mode: ThinkingMode) -> Self {
        self.options.thinking = Some(mode);
        self
    }

    /// Set the effort level.
    pub fn effort(mut self, effort: Effort) -> Self {
        self.options.effort = Some(effort);
        self
    }

    /// Add an environment variable for the CLI process.
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.options.env.insert(key.into(), value.into());
        self
    }

    /// Enable inclusion of partial/streaming messages.
    pub fn include_partial_messages(mut self) -> Self {
        self.options.include_partial_messages = true;
        self
    }

    /// Add an additional directory to include in context.
    pub fn add_directory(mut self, dir: impl Into<String>) -> Self {
        self.options.additional_directories.push(dir.into());
        self
    }

    /// Mark that a permission callback will be registered.
    ///
    /// This causes `--permission-prompt-tool stdio` to be passed to the CLI.
    pub fn with_permission_callback(mut self) -> Self {
        self.options.has_permission_callback = true;
        self
    }

    /// Build the session options.
    pub fn build(self) -> SessionOptions {
        self.options
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_args_always_present() {
        let opts = SessionOptions::builder().build();
        let args = opts.to_cli_args();
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--input-format".to_string()));
        assert!(args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn test_model_flag() {
        let opts = SessionOptions::builder()
            .model("claude-sonnet-4-6")
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[idx + 1], "claude-sonnet-4-6");
    }

    #[test]
    fn test_permission_mode_flag() {
        let opts = SessionOptions::builder()
            .permission_mode(PermissionMode::AcceptEdits)
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "accept-edits");
    }

    #[test]
    fn test_permission_mode_dont_ask() {
        let opts = SessionOptions::builder()
            .permission_mode(PermissionMode::DontAsk)
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "dont-ask");
    }

    #[test]
    fn test_allowed_tools_csv() {
        let opts = SessionOptions::builder()
            .allowed_tools(vec!["Read", "Edit", "Bash"])
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(args[idx + 1], "Read,Edit,Bash");
    }

    #[test]
    fn test_disallowed_tools_csv() {
        let opts = SessionOptions::builder()
            .disallowed_tools(vec!["Bash"])
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--disallowedTools").unwrap();
        assert_eq!(args[idx + 1], "Bash");
    }

    #[test]
    fn test_max_turns_flag() {
        let opts = SessionOptions::builder().max_turns(10).build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--max-turns").unwrap();
        assert_eq!(args[idx + 1], "10");
    }

    #[test]
    fn test_max_budget_flag() {
        let opts = SessionOptions::builder().max_budget_usd(5.0).build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--max-budget-usd").unwrap();
        assert_eq!(args[idx + 1], "5");
    }

    #[test]
    fn test_resume_flag() {
        let opts = SessionOptions::builder()
            .resume("session-123")
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[idx + 1], "session-123");
    }

    #[test]
    fn test_continue_flag() {
        let opts = SessionOptions::builder().continue_session().build();
        let args = opts.to_cli_args();
        assert!(args.contains(&"--continue".to_string()));
    }

    #[test]
    fn test_system_prompt_flag() {
        let opts = SessionOptions::builder()
            .system_prompt("You are a helpful assistant")
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--system-prompt").unwrap();
        assert_eq!(args[idx + 1], "You are a helpful assistant");
    }

    #[test]
    fn test_thinking_flag() {
        let opts = SessionOptions::builder()
            .thinking(ThinkingMode::Adaptive)
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--thinking").unwrap();
        assert_eq!(args[idx + 1], "adaptive");
    }

    #[test]
    fn test_thinking_disabled_flag() {
        let opts = SessionOptions::builder()
            .thinking(ThinkingMode::Disabled)
            .build();
        let args = opts.to_cli_args();
        let idx = args.iter().position(|a| a == "--thinking").unwrap();
        assert_eq!(args[idx + 1], "disabled");
    }

    #[test]
    fn test_effort_flags() {
        for (effort, expected) in [
            (Effort::Low, "low"),
            (Effort::Medium, "medium"),
            (Effort::High, "high"),
            (Effort::Max, "max"),
        ] {
            let opts = SessionOptions::builder().effort(effort).build();
            let args = opts.to_cli_args();
            let idx = args.iter().position(|a| a == "--effort").unwrap();
            assert_eq!(args[idx + 1], expected);
        }
    }

    #[test]
    fn test_include_partial_messages_flag() {
        let opts = SessionOptions::builder()
            .include_partial_messages()
            .build();
        let args = opts.to_cli_args();
        assert!(args.contains(&"--include-partial-messages".to_string()));
    }

    #[test]
    fn test_additional_directories_flag() {
        let opts = SessionOptions::builder()
            .add_directory("/path/to/dir1")
            .add_directory("/path/to/dir2")
            .build();
        let args = opts.to_cli_args();
        let positions: Vec<_> = args
            .iter()
            .enumerate()
            .filter(|(_, a)| a.as_str() == "--add-dir")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(positions.len(), 2);
        assert_eq!(args[positions[0] + 1], "/path/to/dir1");
        assert_eq!(args[positions[1] + 1], "/path/to/dir2");
    }

    #[test]
    fn test_permission_callback_flag() {
        let opts = SessionOptions::builder()
            .with_permission_callback()
            .build();
        let args = opts.to_cli_args();
        let idx = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .unwrap();
        assert_eq!(args[idx + 1], "stdio");
    }

    #[test]
    fn test_no_optional_flags_when_not_set() {
        let opts = SessionOptions::builder().build();
        let args = opts.to_cli_args();
        // Should only have the 5 always-present args
        assert_eq!(args.len(), 5);
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--permission-mode".to_string()));
        assert!(!args.contains(&"--continue".to_string()));
    }

    #[test]
    fn test_full_builder_chain() {
        let opts = SessionOptions::builder()
            .cwd("/my/project")
            .model("claude-opus-4-6")
            .permission_mode(PermissionMode::DontAsk)
            .allowed_tools(vec!["Read", "Bash"])
            .max_turns(5)
            .max_budget_usd(2.5)
            .system_prompt("Be concise")
            .thinking(ThinkingMode::Adaptive)
            .effort(Effort::High)
            .include_partial_messages()
            .add_directory("/extra")
            .with_permission_callback()
            .env("MY_VAR", "my_val")
            .build();

        assert_eq!(opts.cwd.as_deref(), Some("/my/project"));
        assert_eq!(opts.model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(opts.env.get("MY_VAR").map(|s| s.as_str()), Some("my_val"));

        let args = opts.to_cli_args();
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"--permission-mode".to_string()));
        assert!(args.contains(&"--allowedTools".to_string()));
        assert!(args.contains(&"--max-turns".to_string()));
        assert!(args.contains(&"--max-budget-usd".to_string()));
        assert!(args.contains(&"--system-prompt".to_string()));
        assert!(args.contains(&"--thinking".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        assert!(args.contains(&"--add-dir".to_string()));
        assert!(args.contains(&"--permission-prompt-tool".to_string()));
    }
}
