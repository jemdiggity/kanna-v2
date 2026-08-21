#![cfg(unix)]

use kanna_daemon::protocol::{
    AgentProvider as DaemonAgentProvider, Command as DaemonCommand, Event as DaemonEvent,
};
use reqwest::{Client, StatusCode};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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

static PROCESS_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

struct ServerPortReservations {
    lan: TcpListener,
    transfer: TcpListener,
}

impl ServerPortReservations {
    fn new() -> Self {
        let lan = TcpListener::bind("127.0.0.1:0").expect("LAN port should be available");
        let transfer = TcpListener::bind("127.0.0.1:0").expect("transfer port should be available");
        assert_ne!(
            lan.local_addr().unwrap().port(),
            transfer.local_addr().unwrap().port()
        );
        Self { lan, transfer }
    }

    fn lan_port(&self) -> u16 {
        self.lan.local_addr().unwrap().port()
    }

    fn transfer_port(&self) -> u16 {
        self.transfer.local_addr().unwrap().port()
    }
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
    // The retired `.kanna/pipelines` directory: repos that still carry it must
    // keep resolving.
    let legacy_workflow_dir = repo.join(".kanna/pipelines");
    let provider_bin = repo.join(".kanna/provider-bin");
    std::fs::create_dir_all(&agent_dir).expect("agent directory should be created");
    std::fs::create_dir_all(&implement_agent_dir)
        .expect("implement agent directory should be created");
    std::fs::create_dir_all(&review_agent_dir).expect("review agent directory should be created");
    std::fs::create_dir_all(&commit_agent_dir).expect("commit agent directory should be created");
    std::fs::create_dir_all(&legacy_workflow_dir).expect("workflow directory should be created");
    std::fs::create_dir_all(&provider_bin).expect("provider directory should be created");
    std::fs::write(repo.join("README.md"), "provider integration fixture\n")
        .expect("README should be written");
    std::fs::write(
        repo.join(".kanna/config.json"),
        json!({
            "agentProviders": {
                "implement": {
                    "provider": "claude",
                    "model": "repo-model"
                }
            },
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
        "---\nname: implement\ndescription: Test implementation agent\nagent_provider: opencode\nmodel: agent-model\n---\n\nImplement $TASK_PROMPT\n",
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
        legacy_workflow_dir.join("ordered.json"),
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
    .expect("ordered provider workflow should be written");
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

fn publish_origin_main(repo: &Path, message: &str) {
    for args in [
        vec!["add", "."],
        vec!["commit", "-m", message],
        vec!["update-ref", "refs/remotes/origin/main", "HEAD"],
    ] {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(repo)
            .status()
            .expect("git command should run");
        assert!(status.success(), "git fixture command should succeed");
    }
}

fn write_server_config(root: &Path, port: u16, transfer_port: u16) -> (PathBuf, PathBuf, PathBuf) {
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

async fn start_server(
    config_path: &Path,
    root: &Path,
    port: u16,
    lan_port_reservation: TcpListener,
    transfer_port_reservation: TcpListener,
) -> Child {
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
    drop(lan_port_reservation);
    drop(transfer_port_reservation);
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
    let (command_tx, mut commands) = mpsc::unbounded_channel();
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.expect("daemon client should connect");
                connections.spawn(serve_fake_daemon_connection(stream, command_tx.clone()));
            }
            command = commands.recv() => {
                let command = command.expect("fake daemon command channel should remain open");
                if matches!(command, DaemonCommand::Spawn { .. } | DaemonCommand::SpawnAgent { .. }) {
                    return command;
                }
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                completed
                    .expect("fake daemon connection set should not be empty")
                    .expect("fake daemon connection handler should complete cleanly");
            }
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
            DaemonCommand::NegotiateProtectedInput { .. } => DaemonEvent::ProtectedInputReady {
                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
            },
            DaemonCommand::Subscribe => DaemonEvent::Ok,
            DaemonCommand::List => DaemonEvent::SessionList {
                sessions: Vec::new(),
            },
            DaemonCommand::Spawn { session_id, .. }
            | DaemonCommand::SpawnAgent { session_id, .. } => DaemonEvent::SessionCreated {
                session_id: session_id.clone(),
            },
            DaemonCommand::Kill { .. } | DaemonCommand::SubmitInput { .. } => DaemonEvent::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                message: "session not found".to_string(),
            },
            other => panic!("unexpected daemon command: {other:?}"),
        };
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .expect("daemon response should be written");
        if !matches!(
            &command,
            DaemonCommand::NegotiateProtectedInput { .. }
                | DaemonCommand::Subscribe
                | DaemonCommand::List
        ) {
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

async fn next_daemon_spawn(commands: &mut mpsc::UnboundedReceiver<DaemonCommand>) -> DaemonCommand {
    loop {
        let command = next_daemon_command(commands).await;
        if matches!(
            command,
            DaemonCommand::Spawn { .. } | DaemonCommand::SpawnAgent { .. }
        ) {
            return command;
        }
    }
}

/// The spawn a codex-stamped task must produce: the codex executable, and no
/// model flag carrying a model written for some other provider.
fn assert_codex_spawn_without_a_foreign_model(
    command: DaemonCommand,
    expected_session_id: &str,
    phase: &str,
) {
    match command {
        DaemonCommand::Spawn {
            session_id, args, ..
        } => {
            assert_eq!(session_id, expected_session_id, "{phase} session id");
            let shell_command = args.last().expect("PTY spawn should carry a shell command");
            assert!(
                shell_command.contains("/.kanna/provider-bin/codex"),
                "{phase} should spawn codex: {shell_command}"
            );
            assert!(
                !shell_command.contains("-m "),
                "{phase} passed a model the stamped provider never asked for: {shell_command}"
            );
            assert!(
                !shell_command.contains("opus"),
                "{phase} leaked the claude-targeted model: {shell_command}"
            );
        }
        other => panic!("expected a codex PTY spawn for {phase}, got {other:?}"),
    }
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
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("ordered-fallback");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let repo = init_provider_repo(&root);
    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, _) = write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let daemon = tokio::spawn(fake_daemon_until_spawn(daemon_dir));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
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
async fn repo_provider_and_model_override_agent_frontmatter_through_http_task_creation() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("repo-preference");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let repo = init_provider_repo(&root);
    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, _) = write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let daemon = tokio::spawn(fake_daemon_until_spawn(daemon_dir));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Use the repo preference",
            "agent": "implement",
            "agentType": "agent"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("repo preference should override unavailable agent frontmatter")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    let task_id = created["taskId"]
        .as_str()
        .expect("task response should include an id");

    match daemon.await.expect("fake daemon should finish") {
        DaemonCommand::SpawnAgent {
            session_id, params, ..
        } => {
            assert_eq!(session_id, task_id);
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            assert_eq!(params.model.as_deref(), Some("repo-model"));
        }
        other => panic!("expected repo-preferred headless spawn, got {other:?}"),
    }

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
    assert_eq!(task["model"], "repo-model");

    stop_server(&mut server).await;
    std::fs::remove_dir_all(root).expect("test root should be removed");
}

#[tokio::test(flavor = "current_thread")]
async fn durable_workflow_provider_lists_fall_back_for_reloaded_stages_and_posts() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("durable-ordered-fallback");
    std::fs::create_dir_all(&root).expect("test root should be created");
    // Declared before the server so unwind/drop order first kills the child,
    // then aborts the fake daemon, and only then removes its filesystem root.
    let mut cleanup = DurableTestCleanup::new(root.clone());
    let repo = init_provider_repo(&root);
    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, db_path) =
        write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let (command_tx, mut commands) = mpsc::unbounded_channel();
    cleanup.track_daemon(tokio::spawn(fake_daemon_persistent(daemon_dir, command_tx)));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Exercise durable provider fallback",
            // Deliberately the retired request key, which `CreateTaskRequest`
            // still accepts as an alias for `workflowName`.
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

    let workflow_def_json: String =
        Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("server database should open read-only")
            .query_row(
                "SELECT pipeline_def FROM pipeline_item WHERE id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .expect("created task should persist its workflow definition");
    let workflow_def: Value = serde_json::from_str(&workflow_def_json)
        .expect("stored workflow definition should be JSON");
    assert_eq!(
        workflow_def["stages"][0]["agent_provider"],
        json!(["claude"])
    );
    assert_eq!(
        workflow_def["stages"][1]["agent_provider"],
        json!(["codex", "claude"])
    );
    assert_eq!(
        workflow_def["stages"][1]["post"]["agent_provider"],
        json!(["codex", "claude"])
    );

    std::fs::remove_file(repo.join(".kanna/pipelines/ordered.json"))
        .expect("source workflow should be removed after its snapshot is persisted");

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
        DaemonCommand::SubmitInput { session_id, .. } => assert_eq!(session_id, task_id),
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

/// The incident this layer exists for: one machine's provider CLI is wedged
/// and the only lever used to be a commit to `origin/main`, because definitions
/// are resolved from there. A `.kanna/config.local.json` that never reaches git
/// must reach the spawn.
#[tokio::test(flavor = "current_thread")]
async fn a_machine_local_agent_provider_reorder_reaches_a_spawn_without_any_commit() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("local-config-override");
    std::fs::create_dir_all(&root).expect("test root should be created");
    // The committed config prefers claude with `repo-model` for `implement`.
    let repo = init_provider_repo(&root);
    std::fs::write(
        repo.join(".kanna/config.local.json"),
        json!({
            "agentProviders": {
                // codex leads and is not installed here, so the ordered
                // fallback lands on claude — the reorder an operator reaches
                // for when the leading provider is the wedged one. The model
                // belongs to codex, the candidate it was written beside.
                "implement": {"provider": ["codex", "claude"], "model": "local-model"}
            }
        })
        .to_string(),
    )
    .expect("machine-local repo config should be written");
    let status = StdCommand::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(&repo)
        .output()
        .expect("git status should run");
    assert!(
        String::from_utf8_lossy(&status.stdout).contains("?? .kanna/config.local.json"),
        "the override must apply while it is still uncommitted"
    );

    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, db_path) =
        write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let daemon = tokio::spawn(fake_daemon_until_spawn(daemon_dir));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let manifest = client
        .get(format!(
            "http://127.0.0.1:{port}/v1/repos/{repo_id}/kanna-definitions"
        ))
        .send()
        .await
        .expect("definition manifest should reach kanna-server")
        .error_for_status()
        .expect("definition manifest should succeed")
        .json::<Value>()
        .await
        .expect("definition manifest should be JSON");
    assert_eq!(
        manifest["config"]["localOverride"]["keys"],
        json!(["agentProviders"])
    );
    assert!(
        manifest["config"]["localOverride"]["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("/.kanna/config.local.json")),
        "manifest should name the local file: {manifest}"
    );

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Use the machine-local preference",
            "agent": "implement",
            "agentType": "agent"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("machine-local preference should resolve to an available provider")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    let task_id = created["taskId"]
        .as_str()
        .expect("task response should include an id");

    match daemon.await.expect("fake daemon should finish") {
        DaemonCommand::SpawnAgent {
            session_id, params, ..
        } => {
            assert_eq!(session_id, task_id);
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            // The local entry wrote `local-model` beside its leading
            // candidate, codex; claude is the outage fallback behind it and
            // runs on its own default. That the model is absent rather than
            // the committed `repo-model` is what proves the uncommitted file
            // replaced the committed entry.
            assert_eq!(params.model, None);
        }
        other => panic!("expected machine-local headless spawn, got {other:?}"),
    }

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
    assert_eq!(task["model"], Value::Null);

    // The persisted spawn options have to agree with the stamp. The row is
    // first written with the *leading* candidate's pair (codex, here, with
    // `local-model`), and only availability decides that the task actually
    // binds to claude — so without a restamp the column would keep a model
    // belonging to a provider the task is not running. No HTTP surface
    // exposes the column once the task has a run (task detail answers from
    // the latest `stage_run`), so it is read from the server's database
    // directly. The desktop's recover-session action reads exactly this pair
    // (`apps/desktop/src/stores/sessions.ts`) and would rebuild
    // `codex -m local-model` from a mismatched row.
    let (stamped_provider, spawn_options): (String, Option<String>) =
        Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("server database should open read-only")
            .query_row(
                "SELECT agent_provider, agent_spawn_options FROM pipeline_item WHERE id = ?1",
                [&task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("created task should persist its agent binding");
    assert_eq!(stamped_provider, "claude");
    let spawn_options: Value = serde_json::from_str(
        &spawn_options.expect("created task should persist its spawn options"),
    )
    .expect("stored spawn options should be JSON");
    assert_eq!(
        spawn_options["model"],
        Value::Null,
        "persisted spawn options must not carry a model written for another provider"
    );
    assert_eq!(spawn_options["effort"], Value::Null);

    stop_server(&mut server).await;
    std::fs::remove_dir_all(root).expect("test root should be removed");
}

/// A task's provider stamp is immutable, and a machine-local
/// `agentProviders` entry deliberately does not rebind an already-stamped
/// open task. What it must never do is hand that task a *foreign model*: a
/// local entry pointing `implement` at claude/opus respawned codex-stamped
/// tasks as `codex -m opus`, which the Codex CLI rejects outright
/// ("The 'opus' model is not supported when using Codex with a ChatGPT
/// account."), parking them unread with raw JSON in the terminal
/// (2026-08-17). The pair has to resolve from coherent layers, at creation
/// and at every respawn.
#[tokio::test(flavor = "current_thread")]
async fn a_stamped_provider_never_takes_a_local_model_written_for_another_provider() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("stamped-provider-foreign-model");
    std::fs::create_dir_all(&root).expect("test root should be created");
    // The committed config prefers claude with `repo-model` for `implement`.
    let repo = init_provider_repo(&root);
    // Task worktrees are cut from `origin/main`, so the second provider
    // executable has to be published there like the first one.
    write_executable(&repo.join(".kanna/provider-bin/codex"));
    publish_origin_main(&repo, "publish the codex provider fixture");
    // The incident's machine-local override: this machine's claude, with a
    // claude model id.
    std::fs::write(
        repo.join(".kanna/config.local.json"),
        json!({
            "agentProviders": {
                "implement": {"provider": "claude", "model": "opus"}
            }
        })
        .to_string(),
    )
    .expect("machine-local repo config should be written");

    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, _) = write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let (command_tx, mut commands) = mpsc::unbounded_channel();
    let daemon = tokio::spawn(fake_daemon_persistent(daemon_dir, command_tx));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
    let client = Client::new();
    let repo_id = register_repo(&client, port, &repo).await;

    let manifest = client
        .get(format!(
            "http://127.0.0.1:{port}/v1/repos/{repo_id}/kanna-definitions"
        ))
        .send()
        .await
        .expect("definition manifest should reach kanna-server")
        .error_for_status()
        .expect("definition manifest should succeed")
        .json::<Value>()
        .await
        .expect("definition manifest should be JSON");
    assert_eq!(
        manifest["config"]["localOverride"]["keys"],
        json!(["agentProviders"]),
        "the local layer must be in force for this test to mean anything"
    );

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Stay on the stamped provider",
            "agent": "implement",
            "agentProvider": "codex",
            "agentType": "pty"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("an explicitly stamped provider should still create a task")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    let task_id = created["taskId"]
        .as_str()
        .expect("task response should include an id")
        .to_string();

    assert_codex_spawn_without_a_foreign_model(
        next_daemon_spawn(&mut commands).await,
        &task_id,
        "task creation",
    );

    // The respawn: same stamp, same local override, still a valid codex
    // invocation rather than `codex -m 'opus'`.
    client
        .post(format!(
            "http://127.0.0.1:{port}/v1/tasks/{task_id}/actions/rerun-stage"
        ))
        .send()
        .await
        .expect("stage rerun should reach kanna-server")
        .error_for_status()
        .expect("stage rerun should be accepted");

    assert_codex_spawn_without_a_foreign_model(
        next_daemon_spawn(&mut commands).await,
        &task_id,
        "stage rerun",
    );

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
    assert_eq!(task["agentProvider"], "codex");
    assert_eq!(task["model"], Value::Null);

    // The same local entry still binds a task that has no stamp of its own —
    // the fix narrows nothing about how the escape hatch works.
    let unstamped = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Take the machine-local preference",
            "agent": "implement",
            "agentType": "pty"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("the machine-local preference should resolve")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    let unstamped_id = unstamped["taskId"]
        .as_str()
        .expect("task response should include an id")
        .to_string();
    match next_daemon_spawn(&mut commands).await {
        DaemonCommand::Spawn {
            session_id, args, ..
        } => {
            assert_eq!(session_id, unstamped_id);
            let shell_command = args.last().expect("PTY spawn should carry a shell command");
            assert!(
                shell_command.contains("/.kanna/provider-bin/claude"),
                "unstamped task should take the local provider: {shell_command}"
            );
            assert!(
                shell_command.contains("--model 'opus'"),
                "unstamped task should take the local model: {shell_command}"
            );
        }
        other => panic!("expected an unstamped PTY spawn, got {other:?}"),
    }

    stop_server(&mut server).await;
    daemon.abort();
    std::fs::remove_dir_all(root).expect("test root should be removed");
}

#[tokio::test(flavor = "current_thread")]
async fn unsupported_headless_provider_is_rejected_before_durable_state_through_http() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("headless-rejection");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let repo = init_provider_repo(&root);
    write_executable(&repo.join(".kanna/provider-bin/copilot"));
    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, _) = write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let (command_tx, _commands) = mpsc::unbounded_channel();
    let daemon = tokio::spawn(fake_daemon_persistent(daemon_dir, command_tx));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
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
    daemon.abort();
    assert!(daemon.await.unwrap_err().is_cancelled());
    std::fs::remove_dir_all(root).expect("test root should be removed");
}

#[tokio::test(flavor = "current_thread")]
async fn checkout_then_create_task_succeeds_through_running_server() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let root = unique_test_root("repo-checkout-create");
    std::fs::create_dir_all(&root).expect("test root should be created");
    let remote = init_provider_repo(&root);
    let remote_url = format!("file://{}", remote.display());
    let remote_url_hash = format!("{:x}", Sha256::digest(remote_url.as_bytes()));
    let ports = ServerPortReservations::new();
    let port = ports.lan_port();
    let (config_path, daemon_dir, _) = write_server_config(&root, port, ports.transfer_port());
    let ServerPortReservations { lan, transfer } = ports;
    let (command_tx, mut commands) = mpsc::unbounded_channel();
    let daemon = tokio::spawn(fake_daemon_persistent(daemon_dir, command_tx));
    let mut server = start_server(&config_path, &root, port, lan, transfer).await;
    let client = Client::new();

    let started = client
        .post(format!("http://127.0.0.1:{port}/v1/repo-checkouts"))
        .json(&json!({
            "name": "provider-clone",
            "remoteUrl": remote_url,
            "remoteUrlHash": remote_url_hash,
        }))
        .send()
        .await
        .expect("checkout request should reach kanna-server")
        .error_for_status()
        .expect("checkout request should start")
        .json::<Value>()
        .await
        .expect("checkout response should be JSON");
    let operation_id = started["id"].as_str().expect("checkout id");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let checkout = loop {
        let operation = client
            .get(format!(
                "http://127.0.0.1:{port}/v1/repo-checkouts/{operation_id}"
            ))
            .send()
            .await
            .expect("checkout status should reach kanna-server")
            .error_for_status()
            .expect("checkout status should succeed")
            .json::<Value>()
            .await
            .expect("checkout status should be JSON");
        if operation["state"] != "running" {
            break operation;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "repository checkout timed out"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(checkout["state"], "done", "{checkout}");
    let repo_id = checkout["repoId"].as_str().expect("checked-out repo id");

    let created = client
        .post(format!("http://127.0.0.1:{port}/v1/tasks"))
        .json(&json!({
            "repoId": repo_id,
            "prompt": "Create after remote checkout",
            "agent": "fallback"
        }))
        .send()
        .await
        .expect("task creation should reach kanna-server")
        .error_for_status()
        .expect("task creation should succeed after checkout")
        .json::<Value>()
        .await
        .expect("task response should be JSON");
    assert!(created["taskId"].as_str().is_some());
    let spawned = tokio::time::timeout(Duration::from_secs(5), commands.recv())
        .await
        .expect("daemon spawn should arrive")
        .expect("daemon command channel should remain open");
    assert!(matches!(spawned, DaemonCommand::Spawn { .. }));
    assert!(root.join("home/.kanna/repos/provider-clone/.git").is_dir());

    stop_server(&mut server).await;
    daemon.abort();
    assert!(daemon.await.unwrap_err().is_cancelled());
    std::fs::remove_dir_all(root).expect("test root should be removed");
}
