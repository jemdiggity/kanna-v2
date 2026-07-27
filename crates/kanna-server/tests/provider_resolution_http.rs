#![cfg(unix)]

use kanna_daemon::protocol::{
    AgentProvider as DaemonAgentProvider, Command as DaemonCommand, Event as DaemonEvent,
};
use reqwest::{Client, StatusCode};
use rusqlite::{Connection, OpenFlags};
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
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};

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

struct DurableTestCleanup {
    root: PathBuf,
    daemon: Option<JoinHandle<()>>,
}

impl DurableTestCleanup {
    fn new(root: PathBuf) -> Self {
        Self { root, daemon: None }
    }

    fn track_daemon(&mut self, daemon: JoinHandle<()>) {
        self.daemon = Some(daemon);
    }

    async fn stop_daemon(&mut self) {
        if let Some(daemon) = self.daemon.take() {
            daemon.abort();
            let error = daemon
                .await
                .expect_err("fake daemon should run until the cleanup guard cancels it");
            assert!(error.is_cancelled(), "fake daemon failed: {error}");
        }
    }
}

impl Drop for DurableTestCleanup {
    fn drop(&mut self) {
        if let Some(daemon) = self.daemon.take() {
            daemon.abort();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
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
    let implement_agent_dir = repo.join(".kanna/agents/implement");
    let review_agent_dir = repo.join(".kanna/agents/review");
    let commit_agent_dir = repo.join(".kanna/agents/commit");
    let pipeline_dir = repo.join(".kanna/pipelines");
    let provider_bin = repo.join(".kanna/provider-bin");
    std::fs::create_dir_all(&agent_dir).expect("agent directory should be created");
    std::fs::create_dir_all(&implement_agent_dir)
        .expect("implement agent directory should be created");
    std::fs::create_dir_all(&review_agent_dir).expect("review agent directory should be created");
    std::fs::create_dir_all(&commit_agent_dir).expect("commit agent directory should be created");
    std::fs::create_dir_all(&pipeline_dir).expect("pipeline directory should be created");
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
        "---\nname: fallback\ndescription: Test fallback agent\nagent_provider:\n  - codex\n  - claude\n---\n\n$TASK_PROMPT\n",
    )
    .expect("agent definition should be written");
    std::fs::write(
        implement_agent_dir.join("AGENT.md"),
        "---\nname: implement\ndescription: Test implementation agent\n---\n\nImplement $TASK_PROMPT\n",
    )
    .expect("implement agent definition should be written");
    std::fs::write(
        review_agent_dir.join("AGENT.md"),
        "---\nname: review\ndescription: Test review agent\n---\n\nReview $TASK_PROMPT\n",
    )
    .expect("review agent definition should be written");
    std::fs::write(
        commit_agent_dir.join("AGENT.md"),
        "---\nname: commit\ndescription: Test commit agent\n---\n\nCommit $TASK_PROMPT\n",
    )
    .expect("commit agent definition should be written");
    std::fs::write(
        pipeline_dir.join("ordered.json"),
        json!({
            "name": "ordered",
            "stages": [
                {
                    "name": "in progress",
                    "agent": "implement",
                    "agent_provider": "claude",
                    "transition": "manual"
                },
                {
                    "name": "review",
                    "agent": "review",
                    "agent_provider": ["codex", "claude"],
                    "transition": "manual",
                    "post": {
                        "name": "commit",
                        "agent": "commit",
                        "agent_provider": ["codex", "claude"]
                    }
                }
            ]
        })
        .to_string(),
    )
    .expect("ordered provider pipeline should be written");
    write_executable(&provider_bin.join("claude"));

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
    let status = StdCommand::new("git")
        .args(["update-ref", "refs/remotes/origin/main", "HEAD"])
        .current_dir(&repo)
        .status()
        .expect("remote-tracking ref should be published");
    assert!(status.success(), "remote-tracking ref should be published");
    repo
}

fn write_server_config(root: &Path, port: u16) -> (PathBuf, PathBuf, PathBuf) {
    let config_path = root.join("server.toml");
    let daemon_dir = root.join("daemon");
    let db_path = root.join("kanna.db");
    let fake_kanna_cli = root.join("kanna-cli");
    let transfer_port = free_loopback_port();
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
         version = \"test-version\"\n\
         environment = \"development\"\n\
         lan_host = \"127.0.0.1\"\n\
         lan_port = {port}\n\
         transfer_port = {transfer_port}\n\
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
            DaemonCommand::List => {
                write_half
                    .write_all(
                        format!(
                            "{}\n",
                            serde_json::to_string(&DaemonEvent::SessionList {
                                sessions: Vec::new(),
                            })
                            .unwrap()
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("list response should be written");
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

async fn serve_fake_daemon_connection(
    stream: tokio::net::UnixStream,
    commands: mpsc::UnboundedSender<DaemonCommand>,
) {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    loop {
        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .await
            .expect("daemon command should be readable");
        if bytes_read == 0 {
            return;
        }
        let command: DaemonCommand =
            serde_json::from_str(line.trim()).expect("daemon command should be JSON");
        let response = match &command {
            DaemonCommand::Subscribe => DaemonEvent::Ok,
            DaemonCommand::List => DaemonEvent::SessionList {
                sessions: Vec::new(),
            },
            DaemonCommand::Spawn { session_id, .. }
            | DaemonCommand::SpawnAgent { session_id, .. } => DaemonEvent::SessionCreated {
                session_id: session_id.clone(),
            },
            DaemonCommand::Kill { .. } | DaemonCommand::Input { .. } => DaemonEvent::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                message: "session not found".to_string(),
            },
            other => panic!("unexpected daemon command: {other:?}"),
        };
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .expect("daemon response should be written");
        if !matches!(&command, DaemonCommand::Subscribe | DaemonCommand::List) {
            let _ = commands.send(command);
        }
    }
}

async fn fake_daemon_persistent(
    daemon_dir: PathBuf,
    commands: mpsc::UnboundedSender<DaemonCommand>,
) {
    let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("fake daemon should bind");
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.expect("daemon client should connect");
                connections.spawn(serve_fake_daemon_connection(stream, commands.clone()));
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                completed
                    .expect("fake daemon connection set should not be empty")
                    .expect("fake daemon connection handler should complete cleanly");
            }
        }
    }
}

async fn next_daemon_command(
    commands: &mut mpsc::UnboundedReceiver<DaemonCommand>,
) -> DaemonCommand {
    tokio::time::timeout(Duration::from_secs(10), commands.recv())
        .await
        .expect("daemon command should arrive before timeout")
        .expect("fake daemon command channel should remain open")
}

fn assert_claude_agent_spawn(command: DaemonCommand, expected_session_id: &str) {
    match command {
        DaemonCommand::SpawnAgent {
            session_id, params, ..
        } => {
            assert_eq!(session_id, expected_session_id);
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            let executable = params
                .executable
                .expect("headless spawn should include its resolved executable");
            assert!(
                executable.ends_with("/.kanna/provider-bin/claude"),
                "unexpected executable: {executable}"
            );
        }
        other => panic!("expected Claude headless spawn, got {other:?}"),
    }
}

async fn wait_for_task_stage(client: &Client, port: u16, task_id: &str, stage: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let response = client
            .get(format!("http://127.0.0.1:{port}/v1/tasks/{task_id}"))
            .send()
            .await
            .expect("task detail should reach kanna-server")
            .error_for_status()
            .expect("task detail should succeed")
            .json::<Value>()
            .await
            .expect("task detail should be JSON");
        if response["stage"] == stage {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("task {task_id} did not reach stage {stage:?}");
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
    assert_eq!(created["agentType"], "pty");

    let command = daemon.await.expect("fake daemon should finish");
    match command {
        DaemonCommand::Spawn {
            args,
            agent_provider,
            ..
        } => {
            assert_eq!(agent_provider, Some(DaemonAgentProvider::Claude));
            assert!(
                args.iter()
                    .any(|arg| arg.contains("/.kanna/provider-bin/claude")),
                "PTY spawn should include the resolved Claude executable: {args:?}"
            );
        }
        other => panic!("expected PTY spawn, got {other:?}"),
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
async fn durable_pipeline_provider_lists_fall_back_for_reloaded_stages_and_posts() {
    let root = unique_test_root("durable-ordered-fallback");
    std::fs::create_dir_all(&root).expect("test root should be created");
    // Declared before the server so unwind/drop order first kills the child,
    // then aborts the fake daemon, and only then removes its filesystem root.
    let mut cleanup = DurableTestCleanup::new(root.clone());
    let repo = init_provider_repo(&root);
    let port = free_loopback_port();
    let (config_path, daemon_dir, db_path) = write_server_config(&root, port);
    let (command_tx, mut commands) = mpsc::unbounded_channel();
    cleanup.track_daemon(tokio::spawn(fake_daemon_persistent(daemon_dir, command_tx)));
    let mut server = start_server(&config_path, &root, port).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Exercise durable provider fallback",
            "pipelineName": "ordered",
            "agentType": "agent"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("task creation should succeed")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    let task_id = created["taskId"]
        .as_str()
        .expect("task response should include an id")
        .to_string();
    assert_claude_agent_spawn(next_daemon_command(&mut commands).await, &task_id);

    let pipeline_def: String =
        Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("server database should open read-only")
            .query_row(
                "SELECT pipeline_def FROM pipeline_item WHERE id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .expect("created task should persist its pipeline definition");
    let pipeline_def: Value =
        serde_json::from_str(&pipeline_def).expect("stored pipeline definition should be JSON");
    assert_eq!(
        pipeline_def["stages"][0]["agent_provider"],
        json!(["claude"])
    );
    assert_eq!(
        pipeline_def["stages"][1]["agent_provider"],
        json!(["codex", "claude"])
    );
    assert_eq!(
        pipeline_def["stages"][1]["post"]["agent_provider"],
        json!(["codex", "claude"])
    );

    std::fs::remove_file(repo.join(".kanna/pipelines/ordered.json"))
        .expect("source pipeline should be removed after its snapshot is persisted");

    client
        .post(format!(
            "http://127.0.0.1:{port}/v1/tasks/{task_id}/actions/advance-stage"
        ))
        .send()
        .await
        .expect("stage advance should reach kanna-server")
        .error_for_status()
        .expect("stage advance should reload the durable snapshot");
    match next_daemon_command(&mut commands).await {
        DaemonCommand::Kill { session_id } => assert_eq!(session_id, task_id),
        other => panic!("expected task-session kill, got {other:?}"),
    }
    match next_daemon_command(&mut commands).await {
        DaemonCommand::Kill { session_id } => {
            assert_eq!(session_id, format!("shell-wt-{task_id}"))
        }
        other => panic!("expected shell-session kill, got {other:?}"),
    }
    assert_claude_agent_spawn(next_daemon_command(&mut commands).await, &task_id);
    wait_for_task_stage(&client, port, &task_id, "review").await;

    client
        .post(format!(
            "http://127.0.0.1:{port}/v1/tasks/{task_id}/actions/advance-stage"
        ))
        .send()
        .await
        .expect("post advance should reach kanna-server")
        .error_for_status()
        .expect("post advance should reload the durable snapshot");
    match next_daemon_command(&mut commands).await {
        DaemonCommand::Input { session_id, .. } => assert_eq!(session_id, task_id),
        other => panic!("expected post input, got {other:?}"),
    }
    match next_daemon_command(&mut commands).await {
        DaemonCommand::Kill { session_id } => assert_eq!(session_id, task_id),
        other => panic!("expected post fallback kill, got {other:?}"),
    }
    assert_claude_agent_spawn(next_daemon_command(&mut commands).await, &task_id);

    stop_server(&mut server).await;
    cleanup.stop_daemon().await;
}

#[tokio::test(flavor = "current_thread")]
async fn unsupported_headless_provider_is_rejected_before_durable_state_through_http() {
    let root = unique_test_root("headless-rejection");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let repo = init_provider_repo(&root);
    write_executable(&repo.join(".kanna/provider-bin/copilot"));
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
