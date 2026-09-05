use tauri::Emitter;

use serde::{Deserialize, Serialize};

use crate::commands::daemon::DaemonState;
use crate::daemon_client::DaemonClient;
use crate::{commands, daemon_data_dir, daemon_socket_path, subprocess_env};

#[derive(Clone, Copy)]
enum PublishedPid {
    Exact(u32),
    SuccessorOf(u32),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind")]
enum InventoryResource {
    #[serde(rename = "process")]
    Process {
        pid: u32,
        label: String,
        identity: String,
    },
    #[serde(rename = "tmux-server")]
    TmuxServer {
        socket: String,
        #[serde(rename = "socketPath", skip_serializing_if = "Option::is_none")]
        socket_path: Option<String>,
    },
}

#[derive(Deserialize, Serialize)]
struct ProcessInventory {
    version: u8,
    resources: Vec<InventoryResource>,
}

fn process_identity(pid: u32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    let identity = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!identity.is_empty()).then_some(identity)
}

fn abandoned_inventory_owner(lock: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(lock)
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let owner_path = entries
        .iter()
        .find(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("owner-") && name.ends_with(".json")
        })
        .or_else(|| {
            entries
                .iter()
                .find(|entry| entry.file_name() == "owner.json")
        })?
        .path();
    let owner = std::fs::read(&owner_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    if let Some((pid, identity)) = owner.and_then(|value| {
        Some((
            u32::try_from(value.get("pid")?.as_u64()?).ok()?,
            value.get("identity")?.as_str()?.to_string(),
        ))
    }) {
        return (process_identity(pid).as_deref() != Some(identity.as_str())).then_some(owner_path);
    }
    std::fs::metadata(&owner_path)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
        .is_ok_and(|age| age >= std::time::Duration::from_secs(1))
        .then_some(owner_path)
}

fn remove_inventory_owner(lock: &std::path::Path, owner: &std::path::Path) {
    // A stale observer can unlink only the generation it inspected. Atomic
    // rmdir refuses a successor's nonempty directory, unlike rename + rm -r.
    let removed = std::fs::remove_file(owner);
    if removed.is_ok() && owner.file_name().is_some_and(|name| name != "owner.json") {
        if let Err(error) = std::fs::remove_file(lock.join("owner.json")) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("could not remove legacy inventory metadata: {error}");
            }
        }
    }
    if let Err(error) = removed {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "could not remove inventory owner {}: {error}",
                owner.display()
            );
            return;
        }
    }
    if let Err(error) = std::fs::remove_dir(lock) {
        if !matches!(
            error.kind(),
            std::io::ErrorKind::NotFound
                | std::io::ErrorKind::DirectoryNotEmpty
                | std::io::ErrorKind::AlreadyExists
        ) {
            eprintln!(
                "could not remove inventory lock {}: {error}",
                lock.display()
            );
        }
    }
}

fn record_spawned_daemon(worktree: &std::path::Path, pid: u32) -> Result<(), String> {
    let identity = process_identity(pid)
        .ok_or_else(|| format!("could not establish spawn identity for daemon pid {pid}"))?;
    let path = worktree.join(".kanna/kd-state/process-inventory.json");
    let parent = path
        .parent()
        .ok_or_else(|| format!("inventory path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create process inventory directory: {error}"))?;
    let lock = std::path::PathBuf::from(format!("{}.lock", path.display()));
    let owner_name = format!(
        "owner-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let candidate = std::path::PathBuf::from(format!(
            "{}.pending-{}-{}",
            lock.display(),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let owner = serde_json::json!({
            "pid": std::process::id(),
            "identity": process_identity(std::process::id())
                .ok_or_else(|| "could not establish inventory writer identity".to_string())?
        });
        let acquisition = std::fs::create_dir(&candidate)
            .and_then(|()| {
                std::fs::write(candidate.join(&owner_name), owner.to_string())?;
                std::fs::write(candidate.join("owner.json"), owner.to_string())
            })
            .and_then(|()| std::fs::rename(&candidate, &lock));
        match acquisition {
            Ok(()) => break,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                let _ = std::fs::remove_dir_all(&candidate);
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "timed out acquiring process inventory lock: {error}"
                    ));
                }
                if let Some(owner) = abandoned_inventory_owner(&lock) {
                    remove_inventory_owner(&lock, &owner);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&candidate);
                return Err(format!("could not acquire process inventory lock: {error}"));
            }
        }
    }
    let result = (|| {
        let mut inventory = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ProcessInventory>(&bytes).ok())
            .filter(|inventory| inventory.version == 1)
            .unwrap_or(ProcessInventory {
                version: 1,
                resources: Vec::new(),
            });
        inventory.resources.retain(|resource| {
            !matches!(resource, InventoryResource::Process { pid: existing, .. } if *existing == pid)
        });
        inventory.resources.push(InventoryResource::Process {
            pid,
            label: "kanna-daemon".to_string(),
            identity,
        });
        let temp = parent.join(format!(
            "process-inventory.json.tmp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| format!("system clock error: {error}"))?
                .as_nanos()
        ));
        let bytes = serde_json::to_vec_pretty(&inventory)
            .map_err(|error| format!("could not serialize process inventory: {error}"))?;
        std::fs::write(&temp, bytes)
            .map_err(|error| format!("could not write process inventory: {error}"))?;
        std::fs::rename(&temp, &path)
            .map_err(|error| format!("could not publish process inventory: {error}"))
    })();
    remove_inventory_owner(&lock, &lock.join(&owner_name));
    result
}

fn spawn_inventoried_daemon(
    cmd: &mut std::process::Command,
    worktree: Option<&std::path::Path>,
) -> Result<std::process::Child, String> {
    use std::os::unix::process::CommandExt;
    let mut child = unsafe {
        cmd.pre_exec(|| {
            crate::macos::raise_child_nofile_limit();
            libc::setsid();
            Ok(())
        })
        .spawn()
    }
    .map_err(|error| format!("failed to spawn daemon: {error}"))?;
    if let Some(worktree) = worktree {
        if let Err(error) = record_spawned_daemon(worktree, child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("failed to inventory spawned daemon: {error}"));
        }
    }
    Ok(child)
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
    let inferred_worktree =
        kanna_runtime_defaults::worktree_root_for_path(&daemon_bin).or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| kanna_runtime_defaults::worktree_root_for_path(&path))
        });
    let is_worktree = std::env::var("KANNA_WORKTREE").is_ok() || inferred_worktree.is_some();
    eprintln!(
        "[daemon] spawning {:?} (worktree={}, daemon_dir={:?})",
        daemon_bin, is_worktree, daemon_dir
    );

    let mut cmd = std::process::Command::new(&daemon_bin);
    let mut explicit_env = Vec::new();
    if is_worktree {
        explicit_env.push(("KANNA_WORKTREE".to_string(), "1".to_string()));
        if let Some(worktree) = inferred_worktree.as_ref() {
            explicit_env.push((
                "KANNA_PROCESS_INVENTORY_PATH".to_string(),
                worktree
                    .join(".kanna/kd-state/process-inventory.json")
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
    }
    explicit_env.push((
        "KANNA_DAEMON_DIR".to_string(),
        daemon_dir.to_string_lossy().to_string(),
    ));
    if let Ok(server_bin) = kanna_runtime_defaults::resolve_binary_from_candidates(
        "kanna-server",
        commands::fs::sidecar_candidates("kanna-server"),
        |_| Err("kanna-server sidecar binary not found".to_string()),
    ) {
        explicit_env.push(("KANNA_SERVER_EXECUTABLE".to_string(), server_bin));
    }
    subprocess_env::apply_child_env(&mut cmd, explicit_env);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = spawn_inventoried_daemon(&mut cmd, inferred_worktree.as_deref())?;

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

async fn authorize_server_generation(
    event_client: &mut DaemonClient,
    server_pid_receiver: &mut tokio::sync::watch::Receiver<Option<u32>>,
) -> Result<u32, String> {
    let server_pid = loop {
        if let Some(pid) = *server_pid_receiver.borrow_and_update() {
            break pid;
        }
        server_pid_receiver
            .changed()
            .await
            .map_err(|_| "kanna-server process identity channel closed".to_string())?;
    };
    crate::commands::daemon::authorize_server_process(event_client, server_pid)
        .await
        .map_err(|error| format!("{error:?}"))?;
    Ok(server_pid)
}

struct AuthorizationRetryBackoff {
    next_delay: std::time::Duration,
    last_log: Option<std::time::Instant>,
}

impl AuthorizationRetryBackoff {
    fn new() -> Self {
        Self {
            next_delay: std::time::Duration::from_millis(100),
            last_log: None,
        }
    }

    fn failure(&mut self) -> (std::time::Duration, bool) {
        let now = std::time::Instant::now();
        let should_log = self
            .last_log
            .is_none_or(|last| now.duration_since(last) >= std::time::Duration::from_secs(5));
        if should_log {
            self.last_log = Some(now);
        }
        let delay = self.next_delay;
        self.next_delay = std::cmp::min(self.next_delay * 2, std::time::Duration::from_secs(2));
        (delay, should_log)
    }

    fn reset(&mut self) {
        self.next_delay = std::time::Duration::from_millis(100);
        self.last_log = None;
    }
}

/// Spawn the lifecycle bridge: a background task that reads non-output events
/// from a dedicated daemon subscription and emits them as Tauri events.
/// Terminal bytes now flow through KSP `term_*` frames on kanna-server.
/// This bridge stays until daemon_ready, hooks, status, and session exits have
/// KSP equivalents for the desktop app.
pub(crate) fn spawn_event_bridge(
    app: tauri::AppHandle,
    daemon_state: DaemonState,
    mut server_pid_receiver: tokio::sync::watch::Receiver<Option<u32>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut authorization_backoff = AuthorizationRetryBackoff::new();
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

            if let Err(error) =
                authorize_server_generation(&mut event_client, &mut server_pid_receiver).await
            {
                let (delay, should_log) = authorization_backoff.failure();
                if should_log {
                    eprintln!(
                        "[event-bridge] failed to authorize kanna-server on daemon generation; retrying with backoff: {error}"
                    );
                }
                tokio::time::sleep(delay).await;
                continue;
            }
            authorization_backoff.reset();

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

    #[test]
    fn stale_inventory_recovery_preserves_a_replacement_writer() {
        for old_name in ["owner-old.json", "owner.json"] {
            let temp = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../.tmp")
                .join(format!(
                    "inventory-lock-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            std::fs::create_dir_all(&temp).unwrap();
            let lock = temp.join("inventory.lock");
            std::fs::create_dir(&lock).unwrap();
            std::fs::write(
                lock.join(old_name),
                r#"{"pid":999999999,"identity":"gone"}"#,
            )
            .unwrap();
            let stale = super::abandoned_inventory_owner(&lock).unwrap();
            // The old writer exits and another publishes before recovery acts.
            std::fs::remove_dir_all(&lock).unwrap();
            std::fs::create_dir(&lock).unwrap();
            let owner = serde_json::json!({
                "pid": std::process::id(),
                "identity": super::process_identity(std::process::id()).unwrap()
            })
            .to_string();
            let current = lock.join("owner-current.json");
            std::fs::write(&current, &owner).unwrap();
            std::fs::write(lock.join("owner.json"), owner).unwrap();
            super::remove_inventory_owner(&lock, &stale);
            assert!(current.exists(), "stale recovery removed a live generation");
            assert!(super::abandoned_inventory_owner(&lock).is_none());
            super::remove_inventory_owner(&lock, &current);
            assert!(!lock.exists());
            std::fs::remove_dir_all(temp).unwrap();
        }
    }

    use super::{
        authorize_server_generation, process_identity, spawn_inventoried_daemon,
        wait_for_published_daemon_at, AuthorizationRetryBackoff, InventoryResource,
        ProcessInventory, PublishedPid,
    };
    use crate::daemon_client::DaemonClient;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    #[test]
    fn production_spawn_path_publishes_identity_for_kd_cleanup() {
        let worktree = std::env::temp_dir().join(format!(
            "kanna-daemon-inventory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&worktree).unwrap();
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30");
        let child = spawn_inventoried_daemon(&mut command, Some(&worktree)).unwrap();
        let child_pid = child.id();
        let mut unrelated = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();

        let inventory: ProcessInventory = serde_json::from_slice(
            &std::fs::read(worktree.join(".kanna/kd-state/process-inventory.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(inventory.resources.len(), 1);
        match &inventory.resources[0] {
            InventoryResource::Process {
                pid,
                label,
                identity,
            } => {
                assert_eq!(*pid, child_pid);
                assert_eq!(label, "kanna-daemon");
                assert_eq!(Some(identity.clone()), process_identity(*pid));
            }
            InventoryResource::TmuxServer { .. } => panic!("expected daemon process record"),
        }
        // Keep the child owned and actively waited while kd terminates it. If
        // the Child is merely dropped, this test process remains its parent
        // and the terminated process can stay visible to `ps` as a zombie.
        // kd then correctly sees the same process identity until the test
        // harness eventually reaps it. Waiting in parallel makes process exit
        // the synchronization event and matches the production daemon, whose
        // parent does not retain a Rust Child handle.
        let reaper = std::thread::spawn(move || {
            let mut child = child;
            child.wait()
        });

        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let script = format!(
            r#"import {{ executeDevDownWithContext }} from './src/tasks/registry.ts'; import {{ nodeCommandRunner }} from './src/runtime/process.ts'; executeDevDownWithContext({{ killDaemon: true }}, {{ runner: nodeCommandRunner, context: {{ repoRoot: {}, ports: {{}}, env: {{ KANNA_DAEMON_DIR: {} }}, tmux: {{ server: 'kanna-rust-inventory-test', session: 'kanna-rust-inventory-test' }} }} }}).then((result) => {{ if (!result.ok) {{ console.error(result.message); process.exitCode = 1; }} }}).catch((error) => {{ console.error(error); process.exitCode = 1; }});"#,
            serde_json::to_string(&worktree).unwrap(),
            serde_json::to_string(&worktree.join(".kanna-daemon")).unwrap()
        );
        let cleanup = std::process::Command::new("pnpm")
            .args(["exec", "tsx", "-e", &script])
            .current_dir(repo_root.join("tools/kd"))
            .status()
            .unwrap();
        assert!(cleanup.success());
        let child_status = reaper.join().unwrap().unwrap();
        assert!(!child_status.success());
        assert!(process_identity(child_pid).is_none());
        assert!(process_identity(unrelated.id()).is_some());
        assert!(!worktree
            .join(".kanna/kd-state/process-inventory.json")
            .exists());

        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        std::fs::remove_dir_all(worktree).unwrap();
    }

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

    #[tokio::test]
    async fn every_daemon_generation_receives_the_current_server_authorization() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-generation-auth-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let (server_pid_tx, mut server_pid_rx) = tokio::sync::watch::channel(Some(42));

        for generation in ["first", "replacement"] {
            let socket = dir.join(format!("{generation}.sock"));
            let listener = UnixListener::bind(&socket).unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                BufReader::new(read).read_line(&mut line).await.unwrap();
                write.write_all(b"{\"type\":\"Ok\"}\n").await.unwrap();
                serde_json::from_str::<serde_json::Value>(&line).unwrap()
            });
            let mut client = DaemonClient::connect(&socket).await.unwrap();
            assert_eq!(
                authorize_server_generation(&mut client, &mut server_pid_rx)
                    .await
                    .unwrap(),
                42
            );
            let command = server.await.unwrap();
            assert_eq!(command["type"], "AuthorizeServer");
            assert_eq!(command["pid"], 42);
        }

        drop(server_pid_tx);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn persistent_authorization_rejection_backs_off_without_subscribing_or_log_storming() {
        let dir = std::path::PathBuf::from("/tmp").join(format!(
            "kd-persistent-auth-rejection-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("d.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let mut commands = Vec::new();
            for _ in 0..4 {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                BufReader::new(read).read_line(&mut line).await.unwrap();
                commands.push(serde_json::from_str::<serde_json::Value>(&line).unwrap());
                write
                    .write_all(
                        b"{\"type\":\"Error\",\"code\":\"input_unauthorized\",\"message\":\"rejected\"}\n",
                    )
                    .await
                    .unwrap();
            }
            commands
        });
        let (_server_pid_tx, mut server_pid_rx) = tokio::sync::watch::channel(Some(42));
        let mut backoff = AuthorizationRetryBackoff::new();
        let mut logged = 0;
        let started = std::time::Instant::now();
        for expected_delay in [100, 200, 400, 800] {
            let mut client = DaemonClient::connect(&socket).await.unwrap();
            assert!(authorize_server_generation(&mut client, &mut server_pid_rx)
                .await
                .is_err());
            let (delay, should_log) = backoff.failure();
            assert_eq!(delay, std::time::Duration::from_millis(expected_delay));
            logged += usize::from(should_log);
            tokio::time::sleep(delay).await;
        }
        assert!(started.elapsed() >= std::time::Duration::from_millis(1_500));
        assert_eq!(logged, 1, "persistent refusal should be rate-limited");
        let commands = server.await.unwrap();
        assert_eq!(commands.len(), 4);
        assert!(commands
            .iter()
            .all(|command| command["type"] == "AuthorizeServer"));
        assert!(commands
            .iter()
            .all(|command| command["type"] != "Subscribe"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
