use std::path::PathBuf;

use crate::daemon_client::DaemonClient;

use super::protocol::{
    is_retryable_command_error, parse_ack, should_clear_daemon_client_after_error,
    DaemonCommandError,
};
use super::DaemonState;

pub(super) fn daemon_socket_path() -> PathBuf {
    crate::daemon_socket_path()
}

pub(super) async fn ensure_connected(state: &DaemonState) -> Result<(), String> {
    let mut guard = state.lock().await;
    if guard.is_none() {
        let socket_path = daemon_socket_path();
        let client = DaemonClient::connect(&socket_path).await?;
        *guard = Some(client);
    }
    Ok(())
}

pub(super) async fn clear_daemon_client(state: &DaemonState) {
    *state.lock().await = None;
}

async fn send_command_expect_ack_once(
    state: &DaemonState,
    json: &str,
) -> Result<(), DaemonCommandError> {
    ensure_connected(state).await?;
    let mut guard = state.lock().await;
    let client = require_option_mut(&mut guard, "daemon client")?;
    client.send_command(json).await?;
    let response = client.read_event().await?;
    parse_ack(&response)
}

async fn clear_client_and_return_error(
    state: &DaemonState,
    error: DaemonCommandError,
) -> Result<(), DaemonCommandError> {
    if should_clear_daemon_client_after_error(&error) {
        clear_daemon_client(state).await;
    }
    Err(error)
}

pub(super) async fn send_command_expect_ack(
    state: &DaemonState,
    json: &str,
) -> Result<(), DaemonCommandError> {
    match send_command_expect_ack_once(state, json).await {
        Ok(()) => Ok(()),
        Err(error) if is_retryable_command_error(&error) => {
            clear_daemon_client(state).await;
            match send_command_expect_ack_once(state, json).await {
                Ok(()) => Ok(()),
                Err(retry_error) => clear_client_and_return_error(state, retry_error).await,
            }
        }
        Err(error) => clear_client_and_return_error(state, error).await,
    }
}

pub(super) fn require_option_mut<'a, T>(
    value: &'a mut Option<T>,
    context: &str,
) -> Result<&'a mut T, String> {
    value
        .as_mut()
        .ok_or_else(|| format!("{context} unavailable"))
}

#[cfg(test)]
mod tests {
    use super::require_option_mut;

    #[test]
    fn require_option_mut_returns_error_when_missing() {
        let mut value: Option<u8> = None;
        let error = require_option_mut(&mut value, "daemon client")
            .expect_err("missing option should return an error");
        assert_eq!(error, "daemon client unavailable");
    }
}
