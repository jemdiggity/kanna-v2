use super::commands::ProviderSessionBinding;
use super::definitions::WorkflowStageTransition;
use super::environment::resolve_binary_from_candidates_with_path_lookup;
use super::lifecycle::spawn_prepared_task;
use super::prompt::{build_revision_resume_message, build_revision_task_prompt, PromptContext};
use super::provider::{AgentProvider, AgentSessionType};
use super::types::{CreatedTask, PreparedSessionSpawn, PreparedStageTransition, PreparedTaskSpawn};
use super::{
    build_agent_command, build_kanna_preamble, build_prepared_session, build_spawn_env,
    build_stage_prompt, create_dormant_task_for_api_with_error, prepare_advance_stage_for_api,
    prepare_merge_agent_for_api, prepare_rerun_stage_for_api, prepare_resume_task_for_api,
    prepare_revision_task_for_api, prepare_stage_completion_for_api,
    prepare_start_dormant_task_for_api, prepare_task_for_api, prepare_task_for_api_with_error,
    read_default_agent_provider_setting, reopen_task_for_api, reopen_task_for_api_with_test_hook,
    rerun_prepared_stage_for_api, resolve_agent_type, resolve_initial_terminal_geometry,
    spawn_prepared_stage_run_for_api, spawn_prepared_task_for_api_recording_stage_run,
    spawn_prepared_task_for_api_recording_stage_run_detailed, PrepareTaskError,
    PreparedTaskDeliveryError, ReopenTaskError,
};
use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, NewStageRun};
use crate::mobile_api::CreateTaskRequest;
use kanna_daemon::protocol::AgentProvider as DaemonAgentProvider;
use rusqlite::Connection;
use std::collections::HashMap;
use std::process::Command;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

/// Serializes tests that point `CLAUDE_CONFIG_DIR` at a test-local session
/// store: the variable is process-global, so concurrent writers would read
/// each other's stores.
static CLAUDE_CONFIG_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Same reason as `CLAUDE_CONFIG_DIR_LOCK`, for the Codex rollout store.
static CODEX_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

mod core;
mod local_config;
mod provider_session;
mod recovery;
mod revision;
mod setup;
mod spawn;
mod stage;
mod work_tip;

fn test_daemon_socket_path(daemon_dir: &str) -> std::path::PathBuf {
    kanna_runtime_defaults::socket_path(std::path::Path::new(daemon_dir))
}

async fn read_fake_daemon_command(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> kanna_daemon::protocol::Command {
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
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
        return command;
    }
}

/// Answer a stage-transition terminal-carryover probe the way a daemon with
/// no terminal to carry would: `Snapshot` (sent before the kill) gets
/// session-not-found, so the transition proceeds without a seed, and a
/// `SeedSnapshot` (sent after the kill when a snapshot did arrive) gets `Ok`.
/// Returns whether the command was such a probe. Carryover is best-effort and
/// invisible to the transition, so harnesses scripting the kill/spawn
/// sequence answer probes without recording them; tests about carryover
/// itself read the commands directly instead.
async fn answer_terminal_carryover_probe(
    command: &kanna_daemon::protocol::Command,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> bool {
    let response = match command {
        kanna_daemon::protocol::Command::Snapshot { session_id } => {
            kanna_daemon::protocol::Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                message: format!("session not found: {session_id}"),
            }
        }
        kanna_daemon::protocol::Command::SeedSnapshot { .. } => kanna_daemon::protocol::Event::Ok,
        _ => return false,
    };
    writer
        .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
        .await
        .unwrap();
    true
}

async fn spawn_fake_daemon_session_created_once(
    daemon_dir: String,
) -> tokio::task::JoinHandle<kanna_daemon::protocol::Command> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
        let response = serde_json::to_string(&kanna_daemon::protocol::Event::SessionCreated {
            session_id: "task-1".to_string(),
        })
        .unwrap();
        write_half.write_all(response.as_bytes()).await.unwrap();
        write_half.write_all(b"\n").await.unwrap();
        command
    })
}

/// Fake daemon that accepts one connection, reads the first command, and
/// never replies — the wedged-daemon shape from the 2026-07-24 outage. The
/// connection stays open so the client observes a stall, not an EOF.
async fn spawn_fake_daemon_read_then_stall(daemon_dir: String) -> tokio::task::JoinHandle<()> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        // Best-effort carryover probes are answered so the wedge lands on the
        // first command whose failure the caller must surface (the Kill).
        loop {
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            if !answer_terminal_carryover_probe(&command, &mut write_half).await {
                break;
            }
        }
        std::future::pending::<()>().await;
    })
}

fn test_config(label: &str) -> Config {
    Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: format!("/tmp/kanna-daemon-{label}"),
        db_path: Db::test_db_path(label),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{label}.json"),
    }
}

fn init_git_repo(label: &str) -> std::path::PathBuf {
    let repo_root = init_git_repo_with_provider_fixtures(label, true);
    publish_origin_main(&repo_root, "publish initial fixture definitions");
    repo_root
}

fn run_git_fixture(repo_root: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .expect("run git fixture command");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}\nstdout:\n{}\nstderr:\n{}",
        repo_root.display(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout)
        .expect("git fixture stdout should be UTF-8")
        .trim()
        .to_string()
}

fn publish_origin_main(repo_root: &std::path::Path, message: &str) -> String {
    publish_origin_branch(repo_root, "main", message)
}

fn publish_origin_branch(repo_root: &std::path::Path, branch: &str, message: &str) -> String {
    run_git_fixture(repo_root, &["add", "."]);
    let staged_status = Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo_root)
        .status()
        .expect("check staged fixture changes");
    match staged_status.code() {
        Some(0) => {}
        Some(1) => {
            run_git_fixture(repo_root, &["commit", "-m", message]);
        }
        status => panic!(
            "git diff --cached --quiet failed in {} with status {status:?}",
            repo_root.display()
        ),
    }

    let revision = run_git_fixture(repo_root, &["rev-parse", "HEAD"]);
    run_git_fixture(
        repo_root,
        &[
            "update-ref",
            &format!("refs/remotes/origin/{branch}"),
            revision.as_str(),
        ],
    );
    revision
}

fn init_git_repo_without_provider_fixtures(label: &str) -> std::path::PathBuf {
    init_git_repo_with_provider_fixtures(label, false)
}

fn init_git_repo_with_provider_fixtures(
    label: &str,
    with_provider_fixtures: bool,
) -> std::path::PathBuf {
    let repo_root = std::env::temp_dir().join(format!("kanna-task-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    if with_provider_fixtures {
        install_test_provider_binaries(&repo_root);
    }
    assert!(Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    repo_root
}

fn install_test_provider_binaries(repo_root: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    let bin_dir = repo_root.join(".kanna/test-provider-bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    for provider in AgentProvider::ALL {
        let path = bin_dir.join(provider.executable());
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
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
}

/// Fake daemon for post dispatch into a live session: replies `Ok` to each
/// semantic input command and returns every received command once
/// `expected_commands` have arrived.
async fn spawn_fake_daemon_input_ok(
    daemon_dir: String,
    expected_commands: usize,
) -> tokio::task::JoinHandle<Vec<kanna_daemon::protocol::Command>> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < expected_commands {
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            if answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            commands.push(command);
            let response = serde_json::to_string(&kanna_daemon::protocol::Event::Ok).unwrap();
            write_half.write_all(response.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
        }
        commands
    })
}

/// Fake daemon for a forked stage transition: replies to any number of
/// leading `Kill` commands (agent session, then the stale worktree shell),
/// then `SessionCreated` to each spawn, returning every command once
/// `expected_spawns` spawns have arrived (a transition that tears down the
/// left workspace sends a second spawn for the teardown session).
async fn spawn_fake_daemon_fork_transition(
    daemon_dir: String,
    expected_spawns: usize,
) -> tokio::task::JoinHandle<Vec<kanna_daemon::protocol::Command>> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        let mut spawns = 0;
        loop {
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            if answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            let response = match &command {
                kanna_daemon::protocol::Command::Kill { .. } => kanna_daemon::protocol::Event::Ok,
                kanna_daemon::protocol::Command::Spawn { session_id, .. }
                | kanna_daemon::protocol::Command::SpawnAgent { session_id, .. } => {
                    spawns += 1;
                    kanna_daemon::protocol::Event::SessionCreated {
                        session_id: session_id.clone(),
                    }
                }
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            if spawns >= expected_spawns {
                break;
            }
        }
        commands
    })
}

/// Fake daemon for a forked stage transition that also starts a detached
/// workspace teardown session after the replacement stage has spawned.
async fn spawn_fake_daemon_fork_transition_with_teardown(
    daemon_dir: String,
) -> tokio::task::JoinHandle<Vec<kanna_daemon::protocol::Command>> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 5 {
            let command_index = commands.len();
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            if answer_terminal_carryover_probe(&command, &mut write_half).await {
                continue;
            }
            let response = match &command {
                kanna_daemon::protocol::Command::Kill { .. } => kanna_daemon::protocol::Event::Ok,
                kanna_daemon::protocol::Command::Spawn { session_id, .. }
                | kanna_daemon::protocol::Command::SpawnAgent { session_id, .. } => {
                    kanna_daemon::protocol::Event::SessionCreated {
                        session_id: session_id.clone(),
                    }
                }
                other => panic!("unexpected daemon command: {other:?}"),
            };
            if command_index < 3 {
                assert!(
                    matches!(command, kanna_daemon::protocol::Command::Kill { .. }),
                    "expected leading kill command, got {command:?}"
                );
            }
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    })
}

fn insert_finished_stage_run(db: &Db, task_id: &str, stage: &str, result: &str) {
    db.insert_stage_run(NewStageRun {
        id: &format!("{task_id}-{stage}-run"),
        task_id,
        stage,
        kind: "main",
        agent: Some("test-agent"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some(task_id),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run(
        &format!("{task_id}-{stage}-run"),
        "succeeded",
        Some(result),
        Some("done"),
    )
    .unwrap();
}

struct ScopedTestSidecar {
    path: std::path::PathBuf,
    remove_on_drop: bool,
}

impl ScopedTestSidecar {
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for ScopedTestSidecar {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn ensure_test_sidecar(name: &str) -> ScopedTestSidecar {
    use std::os::unix::fs::PermissionsExt;

    let sidecar_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(name);
    if sidecar_path.exists() {
        return ScopedTestSidecar {
            path: sidecar_path,
            remove_on_drop: false,
        };
    }

    std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = std::fs::metadata(&sidecar_path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&sidecar_path, permissions).unwrap();
    ScopedTestSidecar {
        path: sidecar_path,
        remove_on_drop: true,
    }
}

fn init_git_repo_with_workflow(
    label: &str,
    workflow_name: &str,
    stage_name: &str,
    transition: &str,
    provider: &str,
) -> std::path::PathBuf {
    let repo_root = init_git_repo(label);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(format!(".kanna/workflows/{workflow_name}.json")),
        serde_json::json!({
            "stages": [
                {
                    "name": stage_name,
                    "transition": transition,
                    "agent_provider": provider,
                    "prompt": "$TASK_PROMPT"
                },
                { "name": "pr", "transition": "manual" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add kanna workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_origin_main(&repo_root, "publish kanna workflow fixture");
    repo_root
}
