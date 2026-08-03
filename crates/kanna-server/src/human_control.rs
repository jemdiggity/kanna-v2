use crate::http_api::AppState;
use serde::{Deserialize, Serialize};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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
    OverrideApproval { task_id: String, reason: String },
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
    let trusted_desktop = trusted_desktop_identity();
    if trusted_desktop.is_none() {
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
        let trusted_desktop = trusted_desktop.clone();
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
    trusted_desktop: Option<TrustedDesktopIdentity>,
) -> Result<(), String> {
    let peer_pid = kanna_daemon::proc_info::socket_peer_pid(stream.as_raw_fd())
        .ok_or_else(|| "native control peer has no kernel identity".to_string())?;
    let initial = kanna_daemon::proc_info::process_info(peer_pid)
        .ok_or_else(|| "native control peer is not live".to_string())?;
    let peer_executable = kanna_daemon::proc_info::process_executable_path(peer_pid)
        .ok_or_else(|| "native control peer executable is unavailable".to_string())?;
    let trusted_desktop = trusted_desktop
        .ok_or_else(|| "native desktop parent was not pinned at server launch".to_string())?;
    if peer_pid != trusted_desktop.pid
        || initial.start != trusted_desktop.start
        || peer_executable != trusted_desktop.executable
    {
        return Err(format!(
            "native control peer is not the pinned parent desktop process: pid={peer_pid}, executable={}",
            peer_executable.display()
        ));
    }

    let mut line = String::new();
    BufReader::new(&mut stream)
        .take(MAX_REQUEST_BYTES)
        .read_line(&mut line)
        .await
        .map_err(|error| format!("failed to read native control request: {error}"))?;
    let request: HumanControlRequest = serde_json::from_str(line.trim())
        .map_err(|error| format!("invalid native control request: {error}"))?;

    let final_identity = kanna_daemon::proc_info::process_info(peer_pid)
        .ok_or_else(|| "native control peer exited before authorization".to_string())?;
    let final_executable = kanna_daemon::proc_info::process_executable_path(peer_pid)
        .ok_or_else(|| "native control peer executable disappeared".to_string())?;
    if final_identity.start != trusted_desktop.start
        || final_executable != trusted_desktop.executable
        || peer_pid != trusted_desktop.pid
    {
        return Err("native control peer identity changed during authorization".to_string());
    }

    let response = match request {
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
    };
    let mut encoded = serde_json::to_vec(&response)
        .map_err(|error| format!("failed to encode native control response: {error}"))?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| format!("failed to write native control response: {error}"))
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
