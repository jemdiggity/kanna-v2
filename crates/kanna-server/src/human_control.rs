use crate::http_api::AppState;
use serde::{Deserialize, Serialize};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

const MAX_REQUEST_BYTES: u64 = 16 * 1024;
const INITIAL_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

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
    _state: Arc<AppState>,
    mut stream: UnixStream,
    trusted_desktop: Arc<Mutex<Option<TrustedDesktopIdentity>>>,
) -> Result<(), String> {
    let peer = authenticate_peer_before_frame(&stream, &trusted_desktop)?;
    let peer_pid = peer.pid;
    let mut line = String::new();
    read_initial_request(&mut stream, &mut line, INITIAL_REQUEST_TIMEOUT).await?;
    let request: HumanControlRequest = serde_json::from_str(line.trim())
        .map_err(|error| format!("invalid native control request: {error}"))?;

    let pinned = {
        let mut trusted = trusted_desktop
            .lock()
            .map_err(|_| "native desktop identity lock was poisoned".to_string())?;
        let current = trusted
            .as_ref()
            .ok_or_else(|| "native desktop parent was not pinned at server launch".to_string())?;
        let prior_is_live = if peer_matches(current, &peer) {
            true
        } else {
            kanna_daemon::proc_info::process_info(current.pid)
                .is_some_and(|process| process.start == current.start)
                && kanna_daemon::proc_info::process_executable_path(current.pid)
                    .and_then(|path| std::fs::canonicalize(path).ok())
                    .is_some_and(|path| path == current.executable)
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
    };
    let mut encoded = serde_json::to_vec(&response)
        .map_err(|error| format!("failed to encode native control response: {error}"))?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| format!("failed to write native control response: {error}"))
}

fn authenticate_peer_before_frame(
    stream: &UnixStream,
    trusted_desktop: &Mutex<Option<TrustedDesktopIdentity>>,
) -> Result<TrustedDesktopIdentity, String> {
    let peer_pid = kanna_daemon::proc_info::socket_peer_pid(stream.as_raw_fd())
        .ok_or_else(|| "native control peer has no kernel identity".to_string())?;
    let initial = kanna_daemon::proc_info::process_info(peer_pid)
        .ok_or_else(|| "native control peer is not live".to_string())?;
    let peer_executable = kanna_daemon::proc_info::process_executable_path(peer_pid)
        .ok_or_else(|| "native control peer executable is unavailable".to_string())?;
    let peer = TrustedDesktopIdentity {
        pid: peer_pid,
        start: initial.start,
        executable: peer_executable.clone(),
    };
    {
        let trusted = trusted_desktop
            .lock()
            .map_err(|_| "native desktop identity lock was poisoned".to_string())?;
        let current = trusted
            .as_ref()
            .ok_or_else(|| "native desktop parent was not pinned at server launch".to_string())?;
        preauthorize_desktop_peer(current, &peer)?;
    }
    Ok(peer)
}

async fn read_initial_request(
    stream: &mut UnixStream,
    line: &mut String,
    timeout: std::time::Duration,
) -> Result<(), String> {
    tokio::time::timeout(
        timeout,
        BufReader::new(stream)
            .take(MAX_REQUEST_BYTES)
            .read_line(line),
    )
    .await
    .map_err(|_| "native control request timed out before the initial frame".to_string())?
    .map_err(|error| format!("failed to read native control request: {error}"))?;
    if line.is_empty() {
        return Err("native control peer closed before sending a request".to_string());
    }
    Ok(())
}

fn peer_matches(left: &TrustedDesktopIdentity, right: &TrustedDesktopIdentity) -> bool {
    left.pid == right.pid && left.start == right.start && left.executable == right.executable
}

fn preauthorize_desktop_peer(
    current: &TrustedDesktopIdentity,
    peer: &TrustedDesktopIdentity,
) -> Result<(), String> {
    if peer_matches(current, peer) {
        return Ok(());
    }
    let prior_is_live = kanna_daemon::proc_info::process_info(current.pid)
        .is_some_and(|process| process.start == current.start)
        && kanna_daemon::proc_info::process_executable_path(current.pid)
            .and_then(|path| std::fs::canonicalize(path).ok())
            .is_some_and(|path| path == current.executable);
    if !prior_is_live && peer.executable == current.executable {
        // Eligible replacement only. Authority is not transferred until its
        // bounded first frame explicitly requests AdoptDesktop.
        return Ok(());
    }
    Err(format!(
        "native control peer is not eligible for desktop authority: pid={}, executable={}",
        peer.pid,
        peer.executable.display()
    ))
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
    use super::{
        authenticate_peer_before_frame, authorize_or_adopt_desktop, peer_matches,
        read_initial_request, TrustedDesktopIdentity,
    };
    use std::sync::Mutex;

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

    #[tokio::test]
    async fn idle_unauthorized_connection_is_rejected_before_the_request_read() {
        let (server, _idle_peer) = tokio::net::UnixStream::pair().unwrap();
        let current_pid = std::process::id() as libc::pid_t;
        let trusted = Mutex::new(Some(identity(
            current_pid,
            kanna_daemon::proc_info::process_info(current_pid)
                .unwrap()
                .start,
            "/tmp/not-the-live-peer-executable",
        )));
        // The rejection this guards is "before the request read": a peer that
        // never sends a frame would otherwise hold the connection open
        // indefinitely, so any bounded return proves it. 30s only catches that
        // unbounded case and never a loaded box.
        let started = std::time::Instant::now();
        assert!(authenticate_peer_before_frame(&server, &trusted).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(30));
    }

    #[tokio::test]
    async fn idle_authorized_peer_has_a_bounded_initial_frame_lifetime() {
        let (mut server, _idle_peer) = tokio::net::UnixStream::pair().unwrap();
        let mut line = String::new();
        let started = std::time::Instant::now();
        let error =
            read_initial_request(&mut server, &mut line, std::time::Duration::from_millis(25))
                .await
                .unwrap_err();
        assert!(error.contains("timed out"));
        // Same shape: an unenforced lifetime never returns at all, so the
        // ceiling only has to be finite. Keep it far above scheduler noise.
        assert!(started.elapsed() < std::time::Duration::from_secs(30));
    }
}
