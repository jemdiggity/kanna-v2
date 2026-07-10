#![cfg(unix)]

use kanna_daemon::protocol::{
    AgentProvider as DaemonAgentProvider, Command as DaemonCommand, Event as DaemonEvent,
};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::os::unix::fs::symlink;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::process::{Child, Command};

fn unique_test_root(label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "kanna-server-provider-{label}-{}-{suffix}",
        std::process::id()
    ))
}

fn free_loopback_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback port should be available");
    listener
        .local_addr()
        .expect("loopback listener should have an address")
        .port()
}

fn write_executable(path: &Path) {
    std::fs::write(path, "#!/bin/sh\nexit 0\n").expect("provider fixture should be written");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .expect("provider fixture should be executable");
}

fn init_provider_repo(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    let agent_dir = repo.join(".kanna/agents/fallback");
    let provider_bin = repo.join(".kanna/provider-bin");
    std::fs::create_dir_all(&agent_dir).expect("agent directory should be created");
    std::fs::create_dir_all(&provider_bin).expect("provider directory should be created");
    std::fs::write(repo.join("README.md"), "provider integration fixture\n")
        .expect("README should be written");
    std::fs::write(
        repo.join(".kanna/config.json"),
        json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/provider-bin"]
                }
            }
        })
        .to_string(),
    )
    .expect("repo config should be written");
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: fallback\nagent_provider:\n  - codex\n  - claude\n---\n\n$TASK_PROMPT\n",
    )
    .expect("agent definition should be written");
    write_executable(&provider_bin.join("claude"));
    write_executable(&provider_bin.join("copilot"));

    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Test User"],
        vec!["add", "."],
        vec!["commit", "-m", "init"],
    ] {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(&repo)
            .status()
            .expect("git command should run");
        assert!(status.success(), "git fixture command should succeed");
    }
    repo
}

fn write_server_config(root: &Path, port: u16) -> (PathBuf, PathBuf, PathBuf) {
    let config_path = root.join("server.toml");
    let daemon_dir = root.join("daemon");
    let db_path = root.join("kanna.db");
    let fake_kanna_cli = root.join("kanna-cli");
    std::fs::create_dir_all(&daemon_dir).expect("daemon directory should be created");
    write_executable(&fake_kanna_cli);
    let config = format!(
        "relay_url = \"\"\n\
         device_token = \"test-device-token\"\n\
         daemon_dir = \"{}\"\n\
         db_path = \"{}\"\n\
         kanna_cli_path = \"{}\"\n\
         desktop_id = \"desktop-provider-test\"\n\
         desktop_secret = \"desktop-secret\"\n\
         desktop_name = \"Provider Test\"\n\
         server_version = \"test-version\"\n\
         lan_host = \"127.0.0.1\"\n\
         lan_port = {port}\n\
         pairing_store_path = \"{}\"\n",
        daemon_dir.display(),
        db_path.display(),
        fake_kanna_cli.display(),
        root.join("pairings.json").display(),
    );
    std::fs::write(&config_path, config).expect("server config should be written");
    (config_path, daemon_dir, db_path)
}

async fn start_server(config_path: &Path, root: &Path, port: u16) -> Child {
    let home = root.join("home");
    let data_root = root.join("xdg-data");
    let runtime_bin = root.join("runtime-bin");
    std::fs::create_dir_all(&home).expect("isolated HOME should be created");
    std::fs::create_dir_all(&data_root).expect("isolated data root should be created");
    std::fs::create_dir_all(&runtime_bin).expect("isolated runtime bin should be created");

    let server_executable = runtime_bin.join("kanna-server");
    std::fs::copy(env!("CARGO_BIN_EXE_kanna-server"), &server_executable)
        .expect("kanna-server should be copied away from any build sidecars");
    std::fs::set_permissions(&server_executable, std::fs::Permissions::from_mode(0o755))
        .expect("copied kanna-server should be executable");
    let git = kanna_runtime_defaults::which_binary("git").expect("git should be installed");
    symlink(git, runtime_bin.join("git")).expect("isolated runtime should expose git");
    let isolated_path = runtime_bin.to_string_lossy();
    let login_path_override = format!("export PATH=\"{isolated_path}\"\n");
    std::fs::write(home.join(".zprofile"), &login_path_override)
        .expect("isolated login profile should be written");
    std::fs::write(home.join(".zshrc"), &login_path_override)
        .expect("isolated interactive profile should be written");

    let mut command = Command::new(server_executable);
    command
        .env_clear()
        .env("KANNA_SERVER_CONFIG", config_path)
        .env("HOME", &home)
        .env("ZDOTDIR", &home)
        .env("XDG_DATA_HOME", data_root)
        .env("PATH", runtime_bin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().expect("kanna-server should spawn");
    let status_url = format!("http://127.0.0.1:{port}/v1/status");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);

    while tokio::time::Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .expect("kanna-server process status should be readable")
        {
            panic!("kanna-server exited before becoming ready: {status}");
        }
        if reqwest::get(&status_url)
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return child;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("kanna-server did not become ready at {status_url}");
}

async fn stop_server(child: &mut Child) {
    child.kill().await.expect("kanna-server should stop");
    child.wait().await.expect("kanna-server should be reaped");
}

async fn register_repo(client: &Client, port: u16, repo: &Path) -> String {
    let response = client
        .post(format!("http://127.0.0.1:{port}/v1/repos"))
        .json(&json!({ "path": repo, "name": "Provider Test Repo" }))
        .send()
        .await
        .expect("repo registration should reach kanna-server")
        .error_for_status()
        .expect("repo registration should succeed")
        .json::<Value>()
        .await
        .expect("repo response should be JSON");
    response["id"]
        .as_str()
        .expect("repo response should include an id")
        .to_string()
}

async fn fake_daemon_until_spawn(daemon_dir: PathBuf) -> DaemonCommand {
    let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("fake daemon should bind");
    let mut subscribers = Vec::new();

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .expect("daemon client should connect");
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("daemon command should be readable");
        let command: DaemonCommand =
            serde_json::from_str(line.trim()).expect("daemon command should be JSON");
        match command {
            DaemonCommand::Subscribe => {
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .expect("subscribe response should be written");
                subscribers.push(write_half);
            }
            command @ (DaemonCommand::Spawn { .. } | DaemonCommand::SpawnAgent { .. }) => {
                let session_id = match &command {
                    DaemonCommand::Spawn { session_id, .. }
                    | DaemonCommand::SpawnAgent { session_id, .. } => session_id.clone(),
                    _ => unreachable!(),
                };
                write_half
                    .write_all(
                        format!(
                            "{}\n",
                            serde_json::to_string(&DaemonEvent::SessionCreated { session_id })
                                .unwrap()
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("spawn response should be written");
                return command;
            }
            other => panic!("unexpected daemon command: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn ordered_agent_candidates_fall_back_through_the_http_task_creation_path() {
    let root = unique_test_root("ordered-fallback");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let repo = init_provider_repo(&root);
    let port = free_loopback_port();
    let (config_path, daemon_dir, _) = write_server_config(&root, port);
    let daemon = tokio::spawn(fake_daemon_until_spawn(daemon_dir));
    let mut server = start_server(&config_path, &root, port).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let providers = client
        .get(format!(
            "http://127.0.0.1:{port}/v1/repos/{repo_id}/agent-providers"
        ))
        .send()
        .await
        .expect("provider request should reach kanna-server")
        .error_for_status()
        .expect("provider request should succeed")
        .json::<Value>()
        .await
        .expect("provider response should be JSON");
    let provider_ids = providers["providers"]
        .as_array()
        .expect("provider response should include an array")
        .iter()
        .filter_map(|provider| provider["id"].as_str())
        .collect::<Vec<_>>();
    assert!(!provider_ids.contains(&"codex"));
    assert!(provider_ids.contains(&"claude"));

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Use the available provider",
            "agent": "fallback"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("task creation should fall back to the available provider")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    assert_eq!(created["agentType"], "agent");

    let command = daemon.await.expect("fake daemon should finish");
    match command {
        DaemonCommand::SpawnAgent { params, .. } => {
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            let executable = params
                .executable
                .expect("headless spawn should include its resolved executable");
            assert!(
                executable.ends_with("/.kanna/provider-bin/claude"),
                "unexpected executable: {executable}"
            );
        }
        other => panic!("expected headless spawn, got {other:?}"),
    }

    let task_id = created["taskId"]
        .as_str()
        .expect("task response should include an id");
    let task = client
        .get(format!("http://127.0.0.1:{port}/v1/tasks/{task_id}"))
        .send()
        .await
        .expect("task detail should reach kanna-server")
        .error_for_status()
        .expect("task detail should succeed")
        .json::<Value>()
        .await
        .expect("task detail should be JSON");
    assert_eq!(task["agentProvider"], "claude");

    stop_server(&mut server).await;
    std::fs::remove_dir_all(root).expect("test root should be removed");
}

#[tokio::test(flavor = "current_thread")]
async fn unsupported_headless_provider_is_rejected_before_durable_state_through_http() {
    let root = unique_test_root("headless-rejection");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let repo = init_provider_repo(&root);
    let port = free_loopback_port();
    let (config_path, _, _) = write_server_config(&root, port);
    let mut server = start_server(&config_path, &root, port).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let response = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Do not persist this task",
            "agentProvider": "copilot",
            "agentType": "agent"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server");
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = response
        .text()
        .await
        .expect("error body should be readable");
    assert!(
        body.contains("provider copilot does not support headless agent sessions"),
        "unexpected response: {body}"
    );

    let tasks = client
        .get(format!("http://127.0.0.1:{port}/v1/repos/{repo_id}/tasks"))
        .send()
        .await
        .expect("task list should reach kanna-server")
        .error_for_status()
        .expect("task list should succeed")
        .json::<Vec<Value>>()
        .await
        .expect("task list should be JSON");
    assert!(tasks.is_empty(), "rejected task must not be persisted");
    assert!(
        !repo.join(".kanna-worktrees").exists(),
        "rejected task must not create the worktree root"
    );

    stop_server(&mut server).await;
    std::fs::remove_dir_all(root).expect("test root should be removed");
}
