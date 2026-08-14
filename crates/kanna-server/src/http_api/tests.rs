pub(super) use super::task_files::AuthenticatedTaskFileAccess;
pub(super) use super::test_support::{
    test_router, test_router_with_merge_agent_runner, test_router_with_revision_requester,
    test_router_with_seed, test_router_with_seed_and_task_creator, test_router_with_stage_advancer,
    test_router_with_stage_completer, test_router_with_stage_rerunner,
    test_router_with_task_closer, test_router_with_task_creator,
    test_router_with_task_input_sender, test_state_with_seed, test_state_with_task_input_sender,
};
pub(super) use super::{dispatch_http_invoke, handle_task_terminal_state, router, AppState};
use crate::config::Config;
use crate::db::Db;
use crate::mobile_api::{CreateTaskResponse, MobileServerStatus, TaskActionResponse};
pub(super) use crate::task_input_queue::task_input_message;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use kanna_agent_protocol::{AgentEvent, AgentProvider};
use serde_json::from_slice;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tower::ServiceExt;

async fn read_test_daemon_command(
    reader: &mut tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> kanna_daemon::protocol::Command {
    read_test_daemon_command_optional(reader, writer)
        .await
        .expect("fake daemon connection closed before the expected command")
}

async fn read_test_daemon_command_optional(
    reader: &mut tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Option<kanna_daemon::protocol::Command> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        let command = serde_json::from_str(line.trim()).unwrap();
        if matches!(
            command,
            kanna_daemon::protocol::Command::NegotiateProtectedInput { .. }
        ) {
            let response = kanna_daemon::protocol::Event::ProtectedInputReady {
                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
            };
            writer
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            continue;
        }
        return Some(command);
    }
}

fn daemon_socket_path_for_dir(daemon_dir: &str) -> PathBuf {
    kanna_runtime_defaults::socket_path(Path::new(daemon_dir))
}

static TEST_UNIQUE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Process-unique suffix for a test's temp repo, database, and daemon
/// directory. The wall clock alone is not enough: two tests that start within
/// the same tick read the same nanoseconds and derive the same paths, and a
/// daemon socket path is a hash of the daemon directory — so the loser
/// unlinks the winner's socket, binds its own, and one test's spawn lands on
/// the other's listener. The counter makes the suffix unique regardless of
/// clock resolution or scheduling.
fn unique_test_suffix() -> String {
    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};

    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos(),
        TEST_UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn workflow_socket_path_for_daemon_dir(daemon_dir: &str) -> String {
    let dir = PathBuf::from(daemon_dir).join("pipeline");
    kanna_runtime_defaults::socket_path(&dir)
        .to_string_lossy()
        .to_string()
}

fn ensure_test_kanna_cli_sidecar() -> (PathBuf, bool) {
    ensure_test_sidecar("kanna-cli")
}

fn ensure_test_sidecar(name: &str) -> (PathBuf, bool) {
    use std::os::unix::fs::PermissionsExt;

    let sidecar_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(name);
    if sidecar_path.exists() {
        return (sidecar_path, false);
    }

    std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = std::fs::metadata(&sidecar_path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&sidecar_path, permissions).unwrap();
    (sidecar_path, true)
}

const TEST_PROVIDER_NEUTRAL_WORKFLOW: &str = "test-provider-neutral";

fn init_test_git_repo(repo_root: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::remove_dir_all(repo_root);
    let workflow_dir = repo_root.join(".kanna/workflows");
    let provider_bin_dir = repo_root.join(".kanna/test-provider-bin");
    std::fs::create_dir_all(&workflow_dir).unwrap();
    std::fs::create_dir_all(&provider_bin_dir).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/test-provider-bin"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        workflow_dir.join(format!("{TEST_PROVIDER_NEUTRAL_WORKFLOW}.json")),
        serde_json::json!({
            "name": TEST_PROVIDER_NEUTRAL_WORKFLOW,
            "stages": [{
                "name": "in progress",
                "prompt": "$TASK_PROMPT",
                "policy": { "transition": "manual" }
            }]
        })
        .to_string(),
    )
    .unwrap();
    for provider in AgentProvider::ALL {
        let fixture = provider_bin_dir.join(provider.executable());
        std::fs::write(&fixture, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    publish_test_origin_main(repo_root);
}

fn publish_test_origin_main(repo_root: &Path) {
    assert!(Command::new("git")
        .args(["update-ref", "refs/remotes/origin/main", "HEAD"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
}

/// Give the repo a remote whose transport blocks: `git fetch origin` runs
/// this ssh command, which sleeps well past the responsiveness threshold
/// before failing. Definition resolution treats the failed fetch as a
/// warning and continues from the local `origin/main` ref, so routes still
/// succeed — the sleep only makes any on-runtime fetch observable as
/// scheduler drift.
fn add_slow_fetch_origin(repo_root: &Path, sleep_secs: u32) {
    use std::os::unix::fs::PermissionsExt;

    let slow_ssh = repo_root.join("slow-ssh.sh");
    std::fs::write(
        &slow_ssh,
        format!("#!/bin/sh\nsleep {sleep_secs}\nexit 1\n"),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&slow_ssh).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&slow_ssh, perms).unwrap();
    assert!(Command::new("git")
        .args(["remote", "add", "origin", "fakehost:definitions.git"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "core.sshCommand", &slow_ssh.to_string_lossy()])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
}

/// Await a spawned request on a current-thread runtime while measuring
/// scheduler lateness: every wakeup's delay beyond the 25ms probe tick is
/// runtime drift, whether the wakeup is the late tick itself or the request
/// completing behind it. Synchronous work executed on the runtime thread
/// shows up as one interval far exceeding the tick.
async fn await_measuring_runtime_drift<T>(
    mut request: tokio::task::JoinHandle<T>,
) -> (T, std::time::Duration) {
    use std::time::{Duration, Instant};

    let tick = Duration::from_millis(25);
    let mut max_drift = Duration::ZERO;
    loop {
        let started = Instant::now();
        let finished = tokio::select! {
            finished = &mut request => Some(finished),
            _ = tokio::time::sleep(tick) => None,
        };
        let drift = started.elapsed().saturating_sub(tick);
        max_drift = max_drift.max(drift);
        if let Some(finished) = finished {
            return (finished.expect("request task panicked"), max_drift);
        }
    }
}

mod actions;
mod core_routes;
mod create_task;
mod e2e_sql_routes;
mod input;
mod recent_workflows;
mod relay_dispatch;
mod repo_commands;
mod repo_definitions;
mod revision_status;
mod task_events;
mod transfers;
mod workflow_switch;
