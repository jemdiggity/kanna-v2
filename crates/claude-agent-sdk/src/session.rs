use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::error::Error;
use crate::types::control::{
    ControlRequest, ControlRequestEnvelope, ControlResponse, ControlResponseEnvelope,
};
use crate::types::messages::{Message, UserInput};
use crate::types::options::SessionOptions;
use crate::types::permissions::PermissionResult;

/// Default timeout for control requests.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

/// Channel buffer size for the message stream.
const MESSAGE_CHANNEL_SIZE: usize = 256;

/// A permission request callback type.
///
/// Receives the tool name, input, and should return a `PermissionResult`.
pub type PermissionCallback = Box<
    dyn Fn(String, serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = PermissionResult> + Send>>
        + Send
        + Sync,
>;

/// A Claude CLI session.
///
/// Manages the lifecycle of a `claude` CLI process, providing:
/// - Sending user messages
/// - Streaming response messages
/// - Control operations (interrupt, set model, etc.)
/// - Permission callback handling
pub struct Session {
    /// Handle for writing to the CLI's stdin.
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    /// Receiver for parsed messages from the CLI's stdout.
    messages_rx: Arc<Mutex<mpsc::Receiver<Result<Message, Error>>>>,
    /// Pending control requests awaiting responses.
    pending_requests: Arc<DashMap<String, oneshot::Sender<serde_json::Value>>>,
    /// The CLI child process.
    child: Arc<Mutex<Option<Child>>>,
    /// Handle for the stdout reader task.
    _reader_handle: tokio::task::JoinHandle<()>,
}

impl Session {
    /// Start a new Claude CLI session with the given options and initial prompt.
    ///
    /// The prompt is passed as a `-p` CLI argument. Use `send()` for follow-up messages.
    pub async fn start(options: SessionOptions, prompt: &str) -> Result<Self, Error> {
        Self::start_with_callback(options, prompt, None).await
    }

    /// Start a new Claude CLI session with a permission callback.
    pub async fn start_with_callback(
        options: SessionOptions,
        prompt: &str,
        permission_callback: Option<PermissionCallback>,
    ) -> Result<Self, Error> {
        let binary = find_claude_binary()?;

        let args = options.to_cli_args(Some(prompt));
        tracing::debug!(binary = %binary.display(), ?args, "Spawning Claude CLI");

        let mut cmd = Command::new(&binary);
        cmd.args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(cwd) = &options.cwd {
            cmd.current_dir(cwd);
        }

        for (key, value) in &options.env {
            cmd.env(key, value);
        }

        let needs_stdin = options.resume.is_some() || options.continue_session;

        let mut child = cmd.spawn().map_err(Error::SpawnFailed)?;

        let child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::SpawnFailed(std::io::Error::other("failed to capture stdin")))?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::SpawnFailed(std::io::Error::other("failed to capture stdout")))?;

        // Spawn stderr reader for debugging
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let mut reader = stderr;
                let _ = reader.read_to_end(&mut buf).await;
                if !buf.is_empty() {
                    eprintln!("[SDK stderr] {}", String::from_utf8_lossy(&buf));
                }
            });
        }

        // For single-turn sessions (no resume/continue), close stdin immediately
        // so the CLI knows we're done and processes the -p prompt without waiting.
        let stdin = if needs_stdin {
            Arc::new(Mutex::new(Some(child_stdin)))
        } else {
            drop(child_stdin);
            Arc::new(Mutex::new(None))
        };
        let (messages_tx, messages_rx) = mpsc::channel(MESSAGE_CHANNEL_SIZE);
        let pending_requests: Arc<DashMap<String, oneshot::Sender<serde_json::Value>>> =
            Arc::new(DashMap::new());

        // Clone references for the reader task
        let pending_clone = Arc::clone(&pending_requests);
        let stdin_clone = Arc::clone(&stdin);

        let reader_handle = tokio::spawn(async move {
            let reader = BufReader::new(child_stdout);
            let mut lines = reader.lines();

            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) => {
                        // EOF — process has closed stdout
                        tracing::debug!("Claude CLI stdout closed");
                        break;
                    }
                    Err(e) => {
                        tracing::error!("Error reading CLI stdout: {}", e);
                        let _ = messages_tx.send(Err(Error::Io(e))).await;
                        break;
                    }
                };

                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }

                // Parse as generic JSON first to inspect the "type" field
                let value: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("Failed to parse CLI output as JSON: {}: {}", e, line);
                        continue;
                    }
                };

                let msg_type = value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                match msg_type.as_str() {
                    "keep_alive" => {
                        tracing::trace!("Received keep_alive");
                        continue;
                    }

                    "control_response" => {
                        // Route to a pending control request
                        match serde_json::from_value::<ControlResponseEnvelope>(value) {
                            Ok(envelope) => {
                                let request_id = envelope.response.request_id().to_string();
                                match envelope.response {
                                    ControlResponse::Success { response, .. } => {
                                        if let Some((_, sender)) =
                                            pending_clone.remove(&request_id)
                                        {
                                            let _ = sender.send(response);
                                        } else {
                                            tracing::warn!(
                                                "No pending request for control_response: {}",
                                                request_id
                                            );
                                        }
                                    }
                                    ControlResponse::Error { error, .. } => {
                                        if let Some((_, sender)) =
                                            pending_clone.remove(&request_id)
                                        {
                                            // Send an error marker as a JSON value
                                            let err_val = serde_json::json!({"error": error});
                                            let _ = sender.send(err_val);
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!("Failed to parse control_response: {}", e);
                            }
                        }
                    }

                    "control_request" => {
                        // CLI is asking us something (e.g., permission check)
                        match serde_json::from_value::<ControlRequestEnvelope>(value) {
                            Ok(envelope) => {
                                let request_id = envelope.request_id.clone();

                                match &envelope.request {
                                    ControlRequest::CanUseTool { tool_name, input } => {
                                        let result = if let Some(ref cb) = permission_callback {
                                            cb(tool_name.clone(), input.clone()).await
                                        } else {
                                            // No callback registered — allow by default
                                            PermissionResult::allow()
                                        };

                                        // Send the permission response back via stdin
                                        let response = ControlResponseEnvelope {
                                            type_field: "control_response".to_string(),
                                            response: ControlResponse::Success {
                                                request_id,
                                                response: serde_json::to_value(&result)
                                                    .unwrap_or_default(),
                                            },
                                        };

                                        if let Ok(json) = serde_json::to_string(&response) {
                                            let mut stdin_guard = stdin_clone.lock().await;
                                            if let Some(ref mut stdin) = *stdin_guard {
                                                let write_result = stdin
                                                    .write_all(format!("{}\n", json).as_bytes())
                                                    .await;
                                                if let Err(e) = write_result {
                                                    tracing::error!(
                                                        "Failed to write permission response: {}",
                                                        e
                                                    );
                                                }
                                            }
                                        }
                                    }
                                    _ => {
                                        tracing::warn!(
                                            "Unhandled control_request subtype from CLI"
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!("Failed to parse control_request: {}", e);
                            }
                        }
                    }

                    "control_cancel_request" => {
                        // CLI is cancelling a pending request — remove from pending map
                        if let Some(request_id) =
                            value.get("request_id").and_then(|v| v.as_str())
                        {
                            pending_clone.remove(request_id);
                            tracing::debug!("Control request cancelled: {}", request_id);
                        }
                    }

                    _ => {
                        // It's an SDK message — try to parse as a Message enum
                        match serde_json::from_value::<Message>(value.clone()) {
                            Ok(msg) => {
                                if messages_tx.send(Ok(msg)).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                eprintln!("[SDK DEBUG] Failed to parse '{}': {} — raw: {}", msg_type, e, &value.to_string()[..200.min(value.to_string().len())]);
                                tracing::warn!(
                                    "Unknown message type '{}', skipping: {}",
                                    msg_type,
                                    e
                                );
                            }
                        }
                    }
                }
            }
        });

        Ok(Session {
            stdin,
            messages_rx: Arc::new(Mutex::new(messages_rx)),
            pending_requests,
            child: Arc::new(Mutex::new(Some(child))),
            _reader_handle: reader_handle,
        })
    }

    /// Send a text message to the CLI session.
    ///
    /// The stream-json input format expects a plain JSON string on stdin.
    pub async fn send(&self, message: impl Into<String>) -> Result<(), Error> {
        let json = serde_json::to_string(&message.into())?;

        let mut stdin_guard = self.stdin.lock().await;
        let stdin = stdin_guard.as_mut().ok_or(Error::SessionClosed)?;
        stdin
            .write_all(format!("{}\n", json).as_bytes())
            .await
            .map_err(Error::Io)?;
        stdin.flush().await.map_err(Error::Io)?;

        Ok(())
    }

    /// Receive the next message from the CLI session.
    ///
    /// Returns `None` when the session has ended (stdout closed).
    pub async fn next_message(&self) -> Option<Result<Message, Error>> {
        let mut rx = self.messages_rx.lock().await;
        rx.recv().await
    }

    /// Interrupt the current operation.
    pub async fn interrupt(&self) -> Result<(), Error> {
        self.send_control_request(ControlRequest::Interrupt).await?;
        Ok(())
    }

    /// Set the model for subsequent turns.
    pub async fn set_model(&self, model: impl Into<String>) -> Result<(), Error> {
        self.send_control_request(ControlRequest::SetModel {
            model: model.into(),
        })
        .await?;
        Ok(())
    }

    /// Set the permission mode.
    pub async fn set_permission_mode(
        &self,
        mode: crate::types::permissions::PermissionMode,
    ) -> Result<(), Error> {
        self.send_control_request(ControlRequest::SetPermissionMode {
            permission_mode: mode.as_cli_flag().to_string(),
        })
        .await?;
        Ok(())
    }

    /// Send a control request and wait for the response.
    async fn send_control_request(
        &self,
        request: ControlRequest,
    ) -> Result<serde_json::Value, Error> {
        let request_id = uuid::Uuid::new_v4().to_string();

        let envelope = ControlRequestEnvelope {
            type_field: "control_request".to_string(),
            request_id: request_id.clone(),
            request,
        };

        let (tx, rx) = oneshot::channel();
        self.pending_requests.insert(request_id.clone(), tx);

        let json = serde_json::to_string(&envelope)?;
        {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = stdin_guard.as_mut().ok_or(Error::SessionClosed)?;
            stdin
                .write_all(format!("{}\n", json).as_bytes())
                .await
                .map_err(Error::Io)?;
            stdin.flush().await.map_err(Error::Io)?;
        }

        // Wait for the response with a timeout
        match tokio::time::timeout(CONTROL_TIMEOUT, rx).await {
            Ok(Ok(value)) => {
                // Check if the response is an error marker
                if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
                    return Err(Error::ControlError(error.to_string()));
                }
                Ok(value)
            }
            Ok(Err(_)) => {
                // Sender dropped — the reader task has exited
                self.pending_requests.remove(&request_id);
                Err(Error::SessionClosed)
            }
            Err(_) => {
                // Timeout
                self.pending_requests.remove(&request_id);
                Err(Error::ControlTimeout(CONTROL_TIMEOUT))
            }
        }
    }

    /// Close the session gracefully.
    ///
    /// Drops stdin (signals EOF to the CLI), then waits for the process to exit.
    /// If the process doesn't exit within 5 seconds, it is killed.
    pub async fn close(&self) {
        // Drop stdin to signal EOF
        {
            let mut stdin_guard = self.stdin.lock().await;
            *stdin_guard = None;
        }

        // Wait for the child process to exit
        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            let timeout_result =
                tokio::time::timeout(Duration::from_secs(5), child.wait()).await;

            match timeout_result {
                Ok(Ok(status)) => {
                    tracing::debug!("Claude CLI exited with status: {}", status);
                }
                Ok(Err(e)) => {
                    tracing::warn!("Error waiting for Claude CLI to exit: {}", e);
                }
                Err(_) => {
                    tracing::warn!("Claude CLI did not exit within 5 seconds, killing");
                    let _ = child.kill().await;
                }
            }
        }
        *child_guard = None;
    }
}

/// Find the Claude CLI binary.
///
/// Searches the following locations in order:
/// 1. `~/.local/bin/claude`
/// 2. `/usr/local/bin/claude`
/// 3. `~/.npm/bin/claude`
/// 4. Falls back to `which claude`
pub fn find_claude_binary() -> Result<PathBuf, Error> {
    let home = std::env::var("HOME").unwrap_or_default();

    let candidates = [
        format!("{}/.local/bin/claude", home),
        "/usr/local/bin/claude".to_string(),
        format!("{}/.npm/bin/claude", home),
    ];

    for candidate in &candidates {
        let path = PathBuf::from(candidate);
        if path.exists() {
            tracing::debug!(path = %path.display(), "Found Claude CLI binary");
            return Ok(path);
        }
    }

    // Fall back to `which claude`
    match std::process::Command::new("which")
        .arg("claude")
        .output()
    {
        Ok(output) if output.status.success() => {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                let path = PathBuf::from(&path_str);
                tracing::debug!(path = %path.display(), "Found Claude CLI via which");
                return Ok(path);
            }
        }
        _ => {}
    }

    Err(Error::BinaryNotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_claude_binary_does_not_panic() {
        // This test just verifies the function doesn't panic.
        // It may return Ok or BinaryNotFound depending on the environment.
        let _ = find_claude_binary();
    }
}
