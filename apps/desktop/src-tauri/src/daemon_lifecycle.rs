use tauri::Emitter;

use crate::commands::daemon::DaemonState;
use crate::daemon_client::DaemonClient;
use crate::{commands, daemon_data_dir, daemon_socket_path, subprocess_env};

#[derive(Clone, Copy)]
enum PublishedPid {
    Exact(u32),
    SuccessorOf(u32),
}

impl PublishedPid {
    fn accepts(self, pid: u32) -> bool {
        match self {
            Self::Exact(expected) => pid == expected,
            Self::SuccessorOf(previous) => pid != previous,
        }
    }
}

async fn wait_for_published_daemon_at(
    daemon_dir: &std::path::Path,
    socket_path: &std::path::Path,
    expected: PublishedPid,
) -> Option<DaemonClient> {
    let pid_path = daemon_dir.join("daemon.pid");
    let mut delay = std::time::Duration::from_millis(50);
    for _ in 0..20 {
        tokio::time::sleep(delay).await;
        let published_pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok());
        if let Some(published_pid) = published_pid.filter(|pid| expected.accepts(*pid)) {
            if let Ok(client) = DaemonClient::connect(socket_path).await {
                if client.connected_pid() == published_pid {
                    return Some(client);
                }
            }
        }
        delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(1));
    }
    None
}

pub(crate) async fn wait_for_successor(previous_pid: u32) -> Result<DaemonClient, String> {
    wait_for_published_daemon_at(
        &daemon_data_dir(),
        &daemon_socket_path(),
        PublishedPid::SuccessorOf(previous_pid),
    )
    .await
    .ok_or_else(|| {
        format!("successor daemon was not published and connectable after pid {previous_pid}")
    })
}

fn spawn_daemon_process() -> Result<(std::process::Child, std::path::PathBuf), String> {
    let daemon_bin = kanna_runtime_defaults::resolve_binary_from_candidates(
        "kanna-daemon",
        commands::fs::sidecar_candidates("kanna-daemon"),
        |_| Err("kanna-daemon sidecar binary not found".to_string()),
    )
    .map(std::path::PathBuf::from)?;

    let daemon_dir = daemon_data_dir();
    let inferred_worktree = kanna_runtime_defaults::worktree_root_for_path(&daemon_bin)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| kanna_runtime_defaults::worktree_root_for_path(&path))
        })
        .is_some();
    let is_worktree = std::env::var("KANNA_WORKTREE").is_ok() || inferred_worktree;
    eprintln!(
        "[daemon] spawning {:?} (worktree={}, daemon_dir={:?})",
        daemon_bin, is_worktree, daemon_dir
    );

    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(&daemon_bin);
    let mut explicit_env = Vec::new();
    if is_worktree {
        explicit_env.push(("KANNA_WORKTREE".to_string(), "1".to_string()));
    }
    explicit_env.push((
        "KANNA_DAEMON_DIR".to_string(),
        daemon_dir.to_string_lossy().to_string(),
    ));
    subprocess_env::apply_child_env(&mut cmd, explicit_env);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = unsafe {
        cmd.pre_exec(|| {
            crate::macos::raise_child_nofile_limit();
            libc::setsid();
            Ok(())
        })
        .spawn()
    }
    .map_err(|error| format!("failed to spawn daemon: {error}"))?;

    Ok((child, daemon_dir))
}

/// Always spawn a new daemon. If an old one is running, the new daemon
/// performs a handoff (transfers sessions via SCM_RIGHTS) automatically.
pub(crate) async fn ensure_daemon_running() {
    eprintln!("[daemon] spawning daemon...");

    match spawn_daemon_process() {
        // setsid() in spawn_daemon_process detaches the daemon from our process
        // group so Ctrl+C does not kill it.
        Ok((child, daemon_dir)) => {
            let expected_pid = child.id();

            // Wait for the NEW daemon to be ready:
            // PID file must match our child AND socket must be connectable.
            // This ensures we don't connect to the old daemon during handoff.
            if wait_for_published_daemon_at(
                &daemon_dir,
                &daemon_socket_path(),
                PublishedPid::Exact(expected_pid),
            )
            .await
            .is_some()
            {
                eprintln!("[daemon] spawned and connected (pid={})", expected_pid);
                return;
            }
            eprintln!("[daemon] spawned but could not connect after retries");
        }
        Err(e) => {
            eprintln!("[daemon] {e} — PTY sessions will not work");
        }
    }
}

/// Exercise the production app -> daemon successor topology from real E2E tests.
#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn spawn_replacement_daemon_for_e2e() -> Result<u32, String> {
    if std::env::var("KANNA_E2E_TEST_SQL").as_deref() != Ok("1") {
        return Err("replacement daemon spawning is only available in E2E runs".to_string());
    }

    let (child, _) = spawn_daemon_process()?;
    Ok(child.id())
}

/// Connect to the daemon with exponential backoff. Used by the event bridge
/// to wait for the daemon to become available after a restart.
async fn connect_with_backoff() -> Option<DaemonClient> {
    let socket_path = daemon_socket_path();
    let mut delay = std::time::Duration::from_millis(50);
    for attempt in 1..=30 {
        match DaemonClient::connect(&socket_path).await {
            Ok(client) => {
                eprintln!("[reconnect] connected on attempt {}", attempt);
                return Some(client);
            }
            Err(_) => {
                tokio::time::sleep(delay).await;
                delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(2));
            }
        }
    }
    eprintln!("[reconnect] failed to connect after 30 attempts");
    None
}

/// Spawn the lifecycle bridge: a background task that reads non-output events
/// from a dedicated daemon subscription and emits them as Tauri events.
/// Terminal bytes now flow through KSP `term_*` frames on kanna-server.
/// This bridge stays until daemon_ready, hooks, status, and session exits have
/// KSP equivalents for the desktop app.
pub(crate) fn spawn_event_bridge(app: tauri::AppHandle, daemon_state: DaemonState) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Connect (with backoff for reconnection after daemon restart)
            let mut event_client = match connect_with_backoff().await {
                Some(c) => c,
                None => {
                    // Crash recovery: 30 attempts (~30s) of backoff exhausted with no daemon.
                    // The backoff itself prevents thundering herd — if another app instance
                    // spawned a replacement daemon, we'd have connected during backoff.
                    eprintln!("[event-bridge] backoff exhausted, attempting daemon spawn");
                    ensure_daemon_running().await;
                    match connect_with_backoff().await {
                        Some(c) => c,
                        None => {
                            eprintln!("[event-bridge] cannot connect after spawn, giving up");
                            return;
                        }
                    }
                }
            };

            // Subscribe to hook event broadcasts
            let _ = event_client
                .send_command(&serde_json::json!({"type":"Subscribe"}).to_string())
                .await;
            let _ = event_client.read_event().await; // consume Ok

            eprintln!("[event-bridge] connected and subscribed to daemon events");
            let _ = app.emit("daemon_ready", ());

            // Inner read loop
            loop {
                match event_client.read_event().await {
                    Ok(line) => {
                        let event: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        match event.get("type").and_then(|t| t.as_str()) {
                            Some("ShuttingDown") => {
                                eprintln!("[event-bridge] received ShuttingDown, reconnecting...");
                                break;
                            }
                            Some("Exit") => {
                                let _ = app.emit("session_exit", &event);
                            }
                            Some("HookEvent") => {
                                let _ = app.emit("hook_event", &event);
                            }
                            Some("SessionCreated") => {
                                let _ = app.emit("session_created", &event);
                            }
                            _ => {}
                        }
                    }
                    Err(_) => {
                        eprintln!("[event-bridge] daemon connection lost, reconnecting...");
                        break;
                    }
                }
            }

            // Clear command connection so next use reconnects
            *daemon_state.lock().await = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{wait_for_published_daemon_at, PublishedPid};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn successor_boundary_requires_a_different_published_connectable_peer() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-dl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("d.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        std::fs::write(dir.join("daemon.pid"), format!("{}\n", std::process::id())).unwrap();
        let accept = tokio::spawn(async move { listener.accept().await.unwrap() });

        let client = wait_for_published_daemon_at(
            &dir,
            &socket_path,
            PublishedPid::SuccessorOf(std::process::id() + 1),
        )
        .await
        .expect("different published daemon should become ready");

        assert_eq!(client.connected_pid(), std::process::id());
        let _ = accept.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
