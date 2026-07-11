use super::definitions::PipelineStageTransition;
use super::environment::resolve_binary_from_candidates_with_path_lookup;
use super::lifecycle::spawn_prepared_task;
use super::prompt::{build_revision_resume_message, PromptContext};
use super::provider::{AgentProvider, AgentSessionType};
use super::types::{CreatedTask, PreparedSessionSpawn, PreparedStageTransition, PreparedTaskSpawn};
use super::{
    build_agent_command, build_kanna_preamble, build_prepared_session, build_spawn_env,
    build_stage_prompt, prepare_advance_stage_for_api, prepare_merge_agent_for_api,
    prepare_rerun_stage_for_api, prepare_revision_task_for_api, prepare_stage_completion_for_api,
    prepare_task_for_api, read_default_agent_provider_setting, rerun_prepared_stage_for_api,
    resolve_agent_type, spawn_prepared_stage_run_for_api,
    spawn_prepared_task_for_api_recording_stage_run,
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

mod core;
mod revision;
mod setup;
mod spawn;
mod stage;

fn test_daemon_socket_path(daemon_dir: &str) -> std::path::PathBuf {
    kanna_runtime_defaults::socket_path(std::path::Path::new(daemon_dir))
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
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: kanna_daemon::protocol::Command = serde_json::from_str(line.trim()).unwrap();
        let response = serde_json::to_string(&kanna_daemon::protocol::Event::SessionCreated {
            session_id: "task-1".to_string(),
        })
        .unwrap();
        write_half.write_all(response.as_bytes()).await.unwrap();
        write_half.write_all(b"\n").await.unwrap();
        command
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
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{label}.json"),
    }
}

fn init_git_repo(label: &str) -> std::path::PathBuf {
    init_git_repo_with_provider_fixtures(label, true)
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
/// Input command (message, then the discrete Enter) and returns every
/// received command once `expected_commands` have arrived.
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
        for _ in 0..expected_commands {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
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
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
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
        for command_index in 0..5 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
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

fn init_git_repo_with_pipeline(
    label: &str,
    pipeline_name: &str,
    stage_name: &str,
    transition: &str,
    provider: &str,
) -> std::path::PathBuf {
    let repo_root = init_git_repo(label);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::write(
        repo_root.join(format!(".kanna/pipelines/{pipeline_name}.json")),
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
        .args(["commit", "-m", "add kanna pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    repo_root
}
