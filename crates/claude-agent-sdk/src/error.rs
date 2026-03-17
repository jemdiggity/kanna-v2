use std::time::Duration;

/// Errors that can occur when using the Claude Agent SDK.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The Claude CLI binary was not found in any of the searched locations.
    #[error("Claude CLI binary not found")]
    BinaryNotFound,

    /// Failed to spawn the Claude CLI process.
    #[error("Failed to spawn Claude CLI: {0}")]
    SpawnFailed(#[source] std::io::Error),

    /// JSON serialization or deserialization error.
    #[error("JSON serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// A control request timed out waiting for a response.
    #[error("Control request timed out after {0:?}")]
    ControlTimeout(Duration),

    /// A control request returned an error.
    #[error("Control request failed: {0}")]
    ControlError(String),

    /// The session has been closed.
    #[error("Session closed")]
    SessionClosed,

    /// The CLI process exited with a non-zero exit code.
    #[error("Process exited with code {0}")]
    ProcessExited(i32),

    /// An I/O error occurred while communicating with the CLI process.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
