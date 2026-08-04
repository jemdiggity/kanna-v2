use std::path::PathBuf;

use crate::daemon_client::DaemonClient;

use super::protocol::{
    is_retryable_command_error, parse_ack, parse_session_created,
    should_clear_daemon_client_after_error, DaemonCommandError,
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

async fn send_command_once<T>(
    state: &DaemonState,
    json: &str,
    parse: fn(&str) -> Result<T, DaemonCommandError>,
) -> (Option<u32>, Result<T, DaemonCommandError>) {
    if let Err(error) = ensure_connected(state).await {
        return (None, Err(error.into()));
    }
    let mut guard = state.lock().await;
    let client = match require_option_mut(&mut guard, "daemon client") {
        Ok(client) => client,
        Err(error) => return (None, Err(error.into())),
    };
    let connected_pid = Some(client.connected_pid());
    let result = async {
        client.send_command(json).await?;
        let response = client.read_event().await?;
        parse(&response)
    }
    .await;
    (connected_pid, result)
}

async fn clear_client_after_error(state: &DaemonState, error: &DaemonCommandError) {
    if should_clear_daemon_client_after_error(error) {
        clear_daemon_client(state).await;
    }
}

async fn send_command_with_successor_retry<T, Wait, WaitFuture>(
    state: &DaemonState,
    json: &str,
    parse: fn(&str) -> Result<T, DaemonCommandError>,
    wait_for_successor: Wait,
) -> Result<T, DaemonCommandError>
where
    Wait: FnOnce(u32) -> WaitFuture,
    WaitFuture: std::future::Future<Output = Result<DaemonClient, String>>,
{
    let (connected_pid, first_result) = send_command_once(state, json, parse).await;
    match first_result {
        Ok(value) => Ok(value),
        Err(error) if is_retryable_command_error(&error) => {
            let Some(connected_pid) = connected_pid else {
                clear_client_after_error(state, &error).await;
                return Err(error);
            };
            clear_daemon_client(state).await;
            let successor = wait_for_successor(connected_pid)
                .await
                .map_err(DaemonCommandError::from)?;
            *state.lock().await = Some(successor);

            let (_, retry_result) = send_command_once(state, json, parse).await;
            if let Err(error) = &retry_result {
                clear_client_after_error(state, error).await;
            }
            retry_result
        }
        Err(error) => {
            clear_client_after_error(state, &error).await;
            Err(error)
        }
    }
}

pub(super) async fn send_command_expect_ack(
    state: &DaemonState,
    json: &str,
) -> Result<(), DaemonCommandError> {
    send_command_with_successor_retry(state, json, parse_ack, |previous_pid| async move {
        crate::daemon_lifecycle::wait_for_successor(previous_pid).await
    })
    .await
}

pub(super) async fn send_command_expect_ack_bounded(
    state: &DaemonState,
    json: &str,
    timeout: std::time::Duration,
) -> Result<(), DaemonCommandError> {
    match tokio::time::timeout(timeout, send_command_expect_ack(state, json)).await {
        Ok(result) => result,
        Err(_) => {
            // `read_event` may have consumed part of an acknowledgement before
            // cancellation. Retire the entire stream so no later command can
            // observe that acknowledgement as its own.
            clear_daemon_client(state).await;
            Err(DaemonCommandError::from(
                "daemon command acknowledgement timed out".to_string(),
            ))
        }
    }
}

pub(super) async fn send_command_expect_session_created(
    state: &DaemonState,
    json: &str,
) -> Result<(), DaemonCommandError> {
    send_command_with_successor_retry(
        state,
        json,
        parse_session_created,
        |previous_pid| async move {
            crate::daemon_lifecycle::wait_for_successor(previous_pid).await
        },
    )
    .await
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
    use super::{
        require_option_mut, send_command_expect_ack_bounded, send_command_with_successor_retry,
        DaemonState,
    };
    use crate::commands::daemon::protocol::{parse_ack, parse_session_created};
    use crate::daemon_client::DaemonClient;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::sync::Mutex;

    #[test]
    fn require_option_mut_returns_error_when_missing() {
        let mut value: Option<u8> = None;
        let error = require_option_mut(&mut value, "daemon client")
            .expect_err("missing option should return an error");
        assert_eq!(error, "daemon client unavailable");
    }

    #[tokio::test]
    async fn explicit_successor_refusal_waits_and_replays_identical_command_once() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-dsr-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let old_socket = dir.join("o.sock");
        let successor_socket = dir.join("s.sock");
        let old_listener = UnixListener::bind(&old_socket).unwrap();
        let successor_listener = UnixListener::bind(&successor_socket).unwrap();
        let command = r#"{"type":"Kill","session_id":"exact-incarnation"}"#;

        let old_server = tokio::spawn(async move {
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write
                .write_all(
                    b"{\"type\":\"Error\",\"code\":\"retry_on_successor\",\"message\":\"retry\"}\n",
                )
                .await
                .unwrap();
            line
        });
        let successor_server = tokio::spawn(async move {
            let (stream, _) = successor_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(b"{\"type\":\"Ok\"}\n").await.unwrap();
            line
        });

        let mut old_client = DaemonClient::connect(&old_socket).await.unwrap();
        old_client.set_connected_pid_for_test(41);
        let state: DaemonState = Arc::new(Mutex::new(Some(old_client)));
        let wait_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let wait_calls_in_retry = wait_calls.clone();

        send_command_with_successor_retry(&state, command, parse_ack, move |previous_pid| {
            let successor_socket = successor_socket.clone();
            async move {
                assert_eq!(previous_pid, 41);
                wait_calls_in_retry.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                DaemonClient::connect(&successor_socket).await
            }
        })
        .await
        .unwrap();

        assert_eq!(wait_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(old_server.await.unwrap(), format!("{command}\n"));
        assert_eq!(successor_server.await.unwrap(), format!("{command}\n"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_second_successor_refusal_is_surfaced_without_a_third_attempt() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-dsr-cap-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let old_socket = dir.join("o.sock");
        let successor_socket = dir.join("s.sock");
        let old_listener = UnixListener::bind(&old_socket).unwrap();
        let successor_listener = UnixListener::bind(&successor_socket).unwrap();
        let command = r#"{"type":"Spawn","session_id":"only-once"}"#;
        let refusal =
            b"{\"type\":\"Error\",\"code\":\"retry_on_successor\",\"message\":\"retry\"}\n";

        let old_server = tokio::spawn(async move {
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(refusal).await.unwrap();
            line
        });
        let successor_server = tokio::spawn(async move {
            let (stream, _) = successor_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(refusal).await.unwrap();
            line
        });

        let mut old_client = DaemonClient::connect(&old_socket).await.unwrap();
        old_client.set_connected_pid_for_test(41);
        let state: DaemonState = Arc::new(Mutex::new(Some(old_client)));

        let error = send_command_with_successor_retry(
            &state,
            command,
            parse_session_created,
            move |_| async move { DaemonClient::connect(&successor_socket).await },
        )
        .await
        .expect_err("the successor's second refusal must be surfaced");

        assert_eq!(error.code.as_deref(), Some("retry_on_successor"));
        assert_eq!(old_server.await.unwrap(), format!("{command}\n"));
        assert_eq!(successor_server.await.unwrap(), format!("{command}\n"));
        assert!(
            state.lock().await.is_none(),
            "the twice-refusing successor connection must be discarded"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn timed_out_ack_retires_stream_before_the_next_command() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-slow-ack-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let old_socket = dir.join("old.sock");
        let new_socket = dir.join("new.sock");
        let old_listener = UnixListener::bind(&old_socket).unwrap();
        let new_listener = UnixListener::bind(&new_socket).unwrap();

        let old_server = tokio::spawn(async move {
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(b"{\"type\":").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = write.write_all(b"\"Ok\"}\n").await;
            line
        });
        let new_server = tokio::spawn(async move {
            let (stream, _) = new_listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(b"{\"type\":\"Ok\"}\n").await.unwrap();
            line
        });

        let old_client = DaemonClient::connect(&old_socket).await.unwrap();
        let state: DaemonState = Arc::new(Mutex::new(Some(old_client)));
        let first = r#"{"type":"OperatorInput","data":[97]}"#;
        let error =
            send_command_expect_ack_bounded(&state, first, std::time::Duration::from_millis(20))
                .await
                .expect_err("the partial acknowledgement must time out");
        assert!(error.message.contains("timed out"));
        assert!(state.lock().await.is_none());

        *state.lock().await = Some(DaemonClient::connect(&new_socket).await.unwrap());
        let second = r#"{"type":"Resize","cols":90}"#;
        send_command_expect_ack_bounded(&state, second, std::time::Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(old_server.await.unwrap(), format!("{first}\n"));
        assert_eq!(new_server.await.unwrap(), format!("{second}\n"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
