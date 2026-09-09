#![cfg(unix)]
//! The desktop's agent provider inventory, end to end through the real server
//! process.
//!
//! Mobile's create-task composer offers the providers a machine reports here.
//! Getting this wrong is not cosmetic: a task created for a provider whose
//! executable does not resolve on that Mac is accepted, gets a worktree and a
//! branch, and then never connects — which is exactly what shipped to the App
//! Store reviewer. So the assertion is made against a running `kanna-server`
//! with a real, restricted PATH rather than against the mapping function.

use kanna_agent_protocol::AgentProvider;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use serde_json::Value;
use std::net::TcpListener;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

/// `find_user_binary` deliberately also looks in `/usr/local/bin` and
/// `/opt/homebrew/bin`, which no test-local HOME can isolate — a spawn would
/// find a CLI there, so the inventory must too. Providers the host exposes
/// there are therefore excluded from the "must be absent" assertions instead of
/// making this test depend on how the machine running it is set up.
fn installed_outside_the_test_fixture(provider: AgentProvider) -> bool {
    ["/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .any(|directory| {
            let candidate = Path::new(directory).join(provider.executable());
            std::fs::metadata(&candidate)
                .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

/// The server does not open its LAN listener until it has a daemon generation,
/// so a stand-in daemon has to answer the handshake. It never spawns anything:
/// this test only reads payloads.
fn spawn_fake_daemon(daemon_dir: PathBuf) -> JoinHandle<()> {
    let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("fake daemon should bind");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(serve_fake_daemon_connection(stream));
        }
    })
}

async fn serve_fake_daemon_connection(stream: tokio::net::UnixStream) {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    loop {
        let mut line = String::new();
        let Ok(bytes_read) = reader.read_line(&mut line).await else {
            return;
        };
        if bytes_read == 0 {
            return;
        }
        let Ok(command) = serde_json::from_str::<DaemonCommand>(line.trim()) else {
            return;
        };
        let response = match &command {
            DaemonCommand::NegotiateProtectedInput { .. } => DaemonEvent::ProtectedInputReady {
                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
            },
            DaemonCommand::List => DaemonEvent::SessionList {
                sessions: Vec::new(),
            },
            _ => DaemonEvent::Ok,
        };
        let encoded = serde_json::to_string(&response).expect("daemon event should serialize");
        if write_half
            .write_all(format!("{encoded}\n").as_bytes())
            .await
            .is_err()
        {
            return;
        }
    }
}

fn unique_test_root(label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "kanna-server-inventory-{label}-{}-{suffix}",
        std::process::id()
    ))
}

struct TestRoot(PathBuf);

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write_executable(path: &Path) {
    std::fs::write(path, "#!/bin/sh\nexit 0\n").expect("fixture should be written");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .expect("fixture should be executable");
}

fn write_server_config(root: &Path, port: u16, transfer_port: u16) -> PathBuf {
    let config_path = root.join("server.toml");
    let daemon_dir = root.join("daemon");
    let fake_kanna_cli = root.join("kanna-cli");
    std::fs::create_dir_all(&daemon_dir).expect("daemon directory should be created");
    write_executable(&fake_kanna_cli);
    let config = format!(
        "relay_url = \"\"\n\
         device_token = \"test-device-token\"\n\
         daemon_dir = \"{}\"\n\
         db_path = \"{}\"\n\
         kanna_cli_path = \"{}\"\n\
         desktop_id = \"desktop-inventory-test\"\n\
         desktop_secret = \"desktop-secret\"\n\
         desktop_name = \"Inventory Test\"\n\
         version = \"test-version\"\n\
         environment = \"development\"\n\
         lan_host = \"127.0.0.1\"\n\
         lan_port = {port}\n\
         transfer_port = {transfer_port}\n\
         pairing_store_path = \"{}\"\n",
        daemon_dir.display(),
        root.join("kanna.db").display(),
        fake_kanna_cli.display(),
        root.join("pairings.json").display(),
    );
    std::fs::write(&config_path, config).expect("server config should be written");
    config_path
}

/// Boots the real server binary with a PATH that holds exactly the given
/// providers — the login shell it falls back to is isolated to a test HOME that
/// exports the same PATH.
async fn start_server(
    root: &Path,
    installed: &[AgentProvider],
    port: u16,
    lan_reservation: TcpListener,
    transfer_reservation: TcpListener,
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
    for provider in installed {
        write_executable(&runtime_bin.join(provider.executable()));
    }

    let login_path_override = format!("export PATH=\"{}\"\n", runtime_bin.to_string_lossy());
    // Written for every shell the login-shell policy can resolve to, because
    // which one that is depends on the machine: zsh on macOS, and on Linux
    // `$SHELL` when it is bash or zsh, else /bin/bash, else /bin/sh. The
    // point of the fixture is that PATH comes from the user's own startup
    // files, so it has to reach whichever files those turn out to be.
    for startup_file in [
        ".zprofile",
        ".zshrc",
        ".bash_profile",
        ".bashrc",
        ".profile",
    ] {
        std::fs::write(home.join(startup_file), &login_path_override)
            .unwrap_or_else(|error| panic!("isolated {startup_file} should be written: {error}"));
    }

    let config_path = root.join("server.toml");
    let mut command = Command::new(server_executable);
    command
        .env_clear()
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("HOME", &home)
        .env("ZDOTDIR", &home)
        .env("XDG_DATA_HOME", data_root)
        // `XDG_RUNTIME_DIR` must survive `env_clear()`: this harness computes
        // the daemon socket path in-process, and on Linux that path lives in
        // the per-user runtime directory. A server that cannot see the
        // variable looks for the socket in `/tmp` instead, never reaches the
        // fake daemon, and so never opens its HTTP listeners.
        .envs(std::env::var_os("XDG_RUNTIME_DIR").map(|dir| ("XDG_RUNTIME_DIR", dir)))
        .env("PATH", &runtime_bin)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    drop(lan_reservation);
    drop(transfer_reservation);
    let mut child = command.spawn().expect("kanna-server should spawn");

    let status_url = format!("http://127.0.0.1:{port}/v1/status");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
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

async fn read_json(url: &str) -> Value {
    reqwest::get(url)
        .await
        .expect("request should reach kanna-server")
        .json()
        .await
        .expect("kanna-server should answer with JSON")
}

fn reported_providers(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("agentProviders should be an array")
        .iter()
        .map(|provider| {
            provider
                .as_str()
                .expect("provider names should be strings")
                .to_string()
        })
        .collect()
}

#[tokio::test]
async fn desktop_payloads_report_only_the_providers_installed_on_the_machine() {
    let root = TestRoot(unique_test_root("restricted"));
    std::fs::create_dir_all(&root.0).expect("test root should be created");
    let lan = TcpListener::bind("127.0.0.1:0").expect("LAN port should be available");
    let transfer = TcpListener::bind("127.0.0.1:0").expect("transfer port should be available");
    let port = lan.local_addr().unwrap().port();
    let transfer_port = transfer.local_addr().unwrap().port();
    write_server_config(&root.0, port, transfer_port);
    let daemon = spawn_fake_daemon(root.0.join("daemon"));

    let mut server = start_server(&root.0, &[AgentProvider::Opencode], port, lan, transfer).await;

    let desktops = read_json(&format!("http://127.0.0.1:{port}/v1/desktops")).await;
    let status = read_json(&format!("http://127.0.0.1:{port}/v1/status")).await;
    server.kill().await.expect("kanna-server should stop");
    server.wait().await.expect("kanna-server should be reaped");
    daemon.abort();

    let listed = reported_providers(&desktops[0]["agentProviders"]);
    let advertised = reported_providers(&status["agentProviders"]);

    // The one provider on this machine's PATH is reported, on both payloads a
    // mobile client learns a desktop through: `/v1/desktops` for a directly
    // addressed LAN desktop, `/v1/status` for the paired-device discovery probe.
    assert!(
        listed.contains(&"opencode".to_string()),
        "installed provider missing from /v1/desktops: {listed:?}",
    );
    assert_eq!(listed, advertised);

    for provider in AgentProvider::ALL {
        if provider == AgentProvider::Opencode || installed_outside_the_test_fixture(provider) {
            continue;
        }
        assert!(
            !listed.contains(&provider.to_string()),
            "{provider} is not installed on this machine but was reported: {listed:?}",
        );
    }
}

#[tokio::test]
async fn a_machine_with_no_agent_cli_reports_an_empty_inventory() {
    let root = TestRoot(unique_test_root("empty"));
    std::fs::create_dir_all(&root.0).expect("test root should be created");
    let lan = TcpListener::bind("127.0.0.1:0").expect("LAN port should be available");
    let transfer = TcpListener::bind("127.0.0.1:0").expect("transfer port should be available");
    let port = lan.local_addr().unwrap().port();
    let transfer_port = transfer.local_addr().unwrap().port();
    write_server_config(&root.0, port, transfer_port);
    let daemon = spawn_fake_daemon(root.0.join("daemon"));

    let mut server = start_server(&root.0, &[], port, lan, transfer).await;
    let desktops = read_json(&format!("http://127.0.0.1:{port}/v1/desktops")).await;
    server.kill().await.expect("kanna-server should stop");
    server.wait().await.expect("kanna-server should be reaped");
    daemon.abort();

    let listed = reported_providers(&desktops[0]["agentProviders"]);
    let host_installed: Vec<String> = AgentProvider::ALL
        .into_iter()
        .filter(|provider| installed_outside_the_test_fixture(*provider))
        .map(|provider| provider.to_string())
        .collect();

    // The field is present and empty rather than absent: mobile reads an absent
    // inventory as "unknown, offer everything" and an empty one as "this
    // machine can run nothing", and blocks creation only for the latter.
    assert!(desktops[0]["agentProviders"].is_array());
    assert_eq!(listed, host_installed);
}
