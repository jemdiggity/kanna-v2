use serde::{Deserialize, Serialize};

/// Controls how the CLI handles tool permission requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Never ask for permission — reject tools that require approval.
    #[serde(rename = "dont-ask")]
    DontAsk,
    /// Auto-accept file edits but ask for other dangerous operations.
    #[serde(rename = "accept-edits")]
    AcceptEdits,
    /// Default CLI behavior — ask for all dangerous operations.
    Default,
}

impl PermissionMode {
    /// Returns the CLI flag value for this permission mode.
    pub fn as_cli_flag(&self) -> &str {
        match self {
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Default => "default",
        }
    }
}

/// The result of a permission check callback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionResult {
    /// Whether the tool use is allowed.
    pub allowed: bool,
    /// Optional reason for denying permission.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl PermissionResult {
    /// Create a result that allows the tool use.
    pub fn allow() -> Self {
        Self {
            allowed: true,
            reason: None,
        }
    }

    /// Create a result that denies the tool use with a reason.
    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            allowed: false,
            reason: Some(reason.into()),
        }
    }
}
