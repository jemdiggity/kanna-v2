use super::environment::resolve_binary_from_candidates_with_path_lookup;
use super::prompt::PromptContext;
use super::provider::{AgentProvider, AgentSessionType};
use super::types::{CreatedTask, PreparedSessionSpawn, PreparedStageTransition, PreparedTaskSpawn};
use super::{
    build_agent_command, build_kanna_preamble, build_spawn_env, build_stage_prompt,
    continue_prepared_stage_for_api, prepare_advance_stage_for_api,
    prepare_auto_stage_completion_for_api, prepare_merge_agent_for_api,
    prepare_rerun_stage_for_api, prepare_revision_task_for_api, prepare_task_for_api,
    read_default_agent_provider_setting, resolve_agent_type, spawn_prepared_task,
};
use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::Db;
use crate::mobile_api::CreateTaskRequest;
use kanna_daemon::protocol::AgentProvider as DaemonAgentProvider;
use rusqlite::Connection;
use std::collections::HashMap;
use std::process::Command;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

static TEST_SIDECAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

mod core;
mod revision;
mod spawn;
mod stage;

fn test_daemon_socket_path(daemon_dir: &str) -> std::path::PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let dir = std::path::PathBuf::from(daemon_dir);
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    std::path::PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

async fn spawn_fake_daemon_once(
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
        let response = serde_json::to_string(&kanna_daemon::protocol::Event::Ok).unwrap();
        write_half.write_all(response.as_bytes()).await.unwrap();
        write_half.write_all(b"\n").await.unwrap();
        command
    })
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
    let repo_root = std::env::temp_dir().join(format!("kanna-task-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
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
        .args(["add", "README.md"])
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

fn ensure_test_sidecar(name: &str) -> (std::path::PathBuf, bool) {
    let sidecar_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(name);
    if sidecar_path.exists() {
        return (sidecar_path, false);
    }

    std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
    (sidecar_path, true)
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
