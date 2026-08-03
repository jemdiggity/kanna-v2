use crate::http_api::AppState;
use serde::{Deserialize, Serialize};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

const MAX_REQUEST_BYTES: u64 = 16 * 1024;

#[derive(Clone)]
struct TrustedDesktopIdentity {
    pid: libc::pid_t,
    start: kanna_daemon::proc_info::StartTime,
    executable: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum HumanControlRequest {
    AdoptDesktop,
    OverrideApproval { task_id: String, reason: String },
    TerminalInput { task_id: String, data_b64: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HumanControlResponse {
    ok: bool,
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn socket_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    kanna_runtime_defaults::human_control_socket_path(daemon_dir.as_ref())
}

pub async fn serve(state: Arc<AppState>) -> Result<(), String> {
    let socket_path = socket_path(&state.config().daemon_dir);
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create native control directory: {error}"))?;
    }
    if let Err(error) = std::fs::remove_file(&socket_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("failed to replace native control socket: {error}"));
        }
    }
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("failed to bind native control socket: {error}"))?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to protect native control socket: {error}"))?;
    let trusted_desktop = Arc::new(Mutex::new(trusted_desktop_identity()));
    if trusted_desktop
        .lock()
        .is_ok_and(|identity| identity.is_none())
    {
        log::warn!(
            "native human control has no pinned parent desktop identity; requests will fail"
        );
    }
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("native control accept failed: {error}"))?;
        let state = Arc::clone(&state);
        let trusted_desktop = Arc::clone(&trusted_desktop);
        tokio::spawn(async move {
            if let Err(error) = handle_connection(state, stream, trusted_desktop).await {
                log::warn!("native human control rejected request: {error}");
            }
        });
    }
}

async fn handle_connection(
    state: Arc<AppState>,
    mut stream: UnixStream,
    trusted_desktop: Arc<Mutex<Option<TrustedDesktopIdentity>>>,
) -> Result<(), String> {
    let peer_pid = kanna_daemon::proc_info::socket_peer_pid(stream.as_raw_fd())
        .ok_or_else(|| "native control peer has no kernel identity".to_string())?;
    let initial = kanna_daemon::proc_info::process_info(peer_pid)
        .ok_or_else(|| "native control peer is not live".to_string())?;
    let peer_executable = kanna_daemon::proc_info::process_executable_path(peer_pid)
        .ok_or_else(|| "native control peer executable is unavailable".to_string())?;
    let mut line = String::new();
    BufReader::new(&mut stream)
        .take(MAX_REQUEST_BYTES)
        .read_line(&mut line)
        .await
        .map_err(|error| format!("failed to read native control request: {error}"))?;
    let request: HumanControlRequest = serde_json::from_str(line.trim())
        .map_err(|error| format!("invalid native control request: {error}"))?;

    let pinned = {
        let mut trusted = trusted_desktop
            .lock()
            .map_err(|_| "native desktop identity lock was poisoned".to_string())?;
        let current = trusted
            .as_ref()
            .ok_or_else(|| "native desktop parent was not pinned at server launch".to_string())?;
        let peer = TrustedDesktopIdentity {
            pid: peer_pid,
            start: initial.start,
            executable: peer_executable.clone(),
        };
        let prior_is_live = if peer_matches(current, &peer) {
            true
        } else {
            let prior_is_live = kanna_daemon::proc_info::process_info(current.pid)
                .is_some_and(|process| process.start == current.start)
                && kanna_daemon::proc_info::process_executable_path(current.pid)
                    .and_then(|path| std::fs::canonicalize(path).ok())
                    .is_some_and(|path| path == current.executable);
            prior_is_live
        };
        let selected = authorize_or_adopt_desktop(
            current,
            &peer,
            matches!(&request, HumanControlRequest::AdoptDesktop),
            prior_is_live,
        )?;
        *trusted = Some(selected);
        trusted
            .as_ref()
            .cloned()
            .ok_or_else(|| "native desktop identity disappeared".to_string())?
    };

    let final_identity = kanna_daemon::proc_info::process_info(peer_pid)
        .ok_or_else(|| "native control peer exited before authorization".to_string())?;
    let final_executable = kanna_daemon::proc_info::process_executable_path(peer_pid)
        .ok_or_else(|| "native control peer executable disappeared".to_string())?;
    if final_identity.start != pinned.start
        || final_executable != pinned.executable
        || peer_pid != pinned.pid
    {
        return Err("native control peer identity changed during authorization".to_string());
    }

    let response = match request {
        HumanControlRequest::AdoptDesktop => HumanControlResponse {
            ok: true,
            status: 200,
            body: Some(serde_json::json!({ "adopted": true })),
            error: None,
        },
        HumanControlRequest::OverrideApproval { task_id, reason } => {
            match crate::http_api::record_approval_override(
                Arc::clone(&state),
                task_id,
                reason,
                state.config().desktop_id.clone(),
                "native_desktop_process".into(),
            )
            .await
            {
                Ok(gate) => HumanControlResponse {
                    ok: true,
                    status: 200,
                    body: serde_json::to_value(gate).ok(),
                    error: None,
                },
                Err((status, error)) => HumanControlResponse {
                    ok: false,
                    status: status.as_u16(),
                    body: None,
                    error: Some(error),
                },
            }
        }
        HumanControlRequest::TerminalInput { task_id, data_b64 } => {
            match submit_native_terminal_input(Arc::clone(&state), task_id, data_b64).await {
                Ok(()) => HumanControlResponse {
                    ok: true,
                    status: 204,
                    body: Some(serde_json::Value::Null),
                    error: None,
                },
                Err(error) => HumanControlResponse {
                    ok: false,
                    status: 500,
                    body: None,
                    error: Some(error),
                },
            }
        }
    };
    let mut encoded = serde_json::to_vec(&response)
        .map_err(|error| format!("failed to encode native control response: {error}"))?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| format!("failed to write native control response: {error}"))
}

fn peer_matches(left: &TrustedDesktopIdentity, right: &TrustedDesktopIdentity) -> bool {
    left.pid == right.pid && left.start == right.start && left.executable == right.executable
}

fn authorize_or_adopt_desktop(
    current: &TrustedDesktopIdentity,
    peer: &TrustedDesktopIdentity,
    adoption_requested: bool,
    prior_is_live: bool,
) -> Result<TrustedDesktopIdentity, String> {
    if peer_matches(current, peer) {
        return Ok(current.clone());
    }
    if adoption_requested && !prior_is_live && peer.executable == current.executable {
        return Ok(peer.clone());
    }
    Err(format!(
        "native control peer is not the pinned desktop process: pid={}, executable={}",
        peer.pid,
        peer.executable.display()
    ))
}

async fn submit_native_terminal_input(
    state: Arc<AppState>,
    task_id: String,
    data_b64: String,
) -> Result<(), String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|error| format!("invalid terminal input: {error}"))?;
    if data.is_empty() {
        return Ok(());
    }
    let session_id = if task_id.starts_with("shell-") {
        task_id
    } else {
        let db_path = state.config().db_path.clone();
        tokio::task::spawn_blocking(move || {
            crate::db::Db::open(&db_path)
                .map_err(|error| format!("db error: {error}"))?
                .resolve_task_terminal_session_id(&task_id)
                .map_err(|error| format!("db error: {error}"))?
                .ok_or_else(|| format!("no session for task {task_id}"))
        })
        .await
        .map_err(|error| format!("terminal session lookup failed: {error}"))??
    };
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config().daemon_dir)
        .await
        .map_err(|error| format!("daemon error: {error}"))?;
    crate::http_api::send_raw_session_input(&mut daemon, &session_id, data)
        .await
        .map_err(|error| match error {
            crate::http_api::TaskInputError::SessionNotFound => {
                format!("session not found: {session_id}")
            }
            crate::http_api::TaskInputError::Other(message)
            | crate::http_api::TaskInputError::Uncertain(message) => message,
        })
}

fn trusted_desktop_identity() -> Option<TrustedDesktopIdentity> {
    let current = kanna_daemon::proc_info::process_info(std::process::id() as libc::pid_t)?;
    let parent = kanna_daemon::proc_info::process_info(current.ppid)?;
    let executable = kanna_daemon::proc_info::process_executable_path(current.ppid)?;
    let executable = std::fs::canonicalize(executable).ok()?;
    if let Some(expected) = std::env::var_os("KANNA_DESKTOP_EXECUTABLE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .and_then(|path| std::fs::canonicalize(path).ok())
    {
        if executable != expected {
            log::error!(
                "server parent executable {} does not match configured desktop executable {}",
                executable.display(),
                expected.display()
            );
            return None;
        }
    }
    Some(TrustedDesktopIdentity {
        pid: current.ppid,
        start: parent.start,
        executable,
    })
}

#[cfg(test)]
mod tests {
    use super::{authorize_or_adopt_desktop, peer_matches, TrustedDesktopIdentity};

    fn identity(pid: libc::pid_t, start: (u64, u64), executable: &str) -> TrustedDesktopIdentity {
        TrustedDesktopIdentity {
            pid,
            start,
            executable: executable.into(),
        }
    }

    #[test]
    fn surviving_server_transfers_authority_only_after_the_old_desktop_exits() {
        let old = identity(41, (10, 1), "/Applications/Kanna.app/Contents/MacOS/Kanna");
        let restarted = identity(52, (20, 2), "/Applications/Kanna.app/Contents/MacOS/Kanna");

        assert!(authorize_or_adopt_desktop(&old, &restarted, false, false).is_err());
        assert!(authorize_or_adopt_desktop(&old, &restarted, true, true).is_err());
        let adopted = authorize_or_adopt_desktop(&old, &restarted, true, false).unwrap();
        assert!(peer_matches(&adopted, &restarted));
        assert!(authorize_or_adopt_desktop(
            &old,
            &identity(52, (20, 2), "/tmp/forged-kanna"),
            true,
            false,
        )
        .is_err());
    }
}
