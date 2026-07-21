use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tempfile::TempDir;

struct RunningServer {
    child: Child,
    _root: TempDir,
    port: u16,
    status_url: String,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn two_free_loopback_ports() -> (u16, u16) {
    let first = TcpListener::bind(("127.0.0.1", 0)).expect("bind first loopback port");
    let second = TcpListener::bind(("127.0.0.1", 0)).expect("bind second loopback port");
    let first_port = first.local_addr().expect("read first loopback port").port();
    let second_port = second
        .local_addr()
        .expect("read second loopback port")
        .port();
    assert_ne!(first_port, second_port);
    (first_port, second_port)
}

fn free_loopback_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("bind loopback port")
        .local_addr()
        .expect("read loopback port")
        .port()
}

fn registered_config_path(root: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        root.join("Library")
            .join("Application Support")
            .join("Kanna")
            .join("server.toml")
    }
    #[cfg(not(target_os = "macos"))]
    {
        root.join("Kanna").join("server.toml")
    }
}

fn toml_string(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn launch_server(
    label: &str,
    desktop_id: &str,
    desktop_name: &str,
    version: &str,
    environment: &str,
    port: u16,
) -> RunningServer {
    let root = tempfile::Builder::new()
        .prefix(&format!("kanna-status-{label}-"))
        .tempdir()
        .expect("create server test root");
    let daemon_dir = root.path().join("daemon");
    std::fs::create_dir_all(&daemon_dir).expect("create daemon directory");
    let db_path = root.path().join("kanna.sqlite3");
    let pairing_store_path = root.path().join("pairings.json");
    let config_path = root.path().join("server.toml");
    std::fs::write(
        &config_path,
        format!(
            "relay_url = \"\"\n\
             device_token = \"\"\n\
             firebase_project_id = \"kanna-local\"\n\
             daemon_dir = \"{}\"\n\
             db_path = \"{}\"\n\
             desktop_id = \"{desktop_id}\"\n\
             desktop_secret = \"test-secret\"\n\
             desktop_name = \"{desktop_name}\"\n\
             version = \"{version}\"\n\
             environment = \"{environment}\"\n\
             lan_host = \"127.0.0.1\"\n\
             lan_port = {port}\n\
             pairing_store_path = \"{}\"\n",
            toml_string(&daemon_dir),
            toml_string(&db_path),
            toml_string(&pairing_store_path),
        ),
    )
    .expect("write server configuration");

    let child = Command::new(env!("CARGO_BIN_EXE_kanna-server"))
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("RUST_LOG", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch kanna-server test process");

    RunningServer {
        child,
        _root: root,
        port,
        status_url: format!("http://127.0.0.1:{port}/v1/status"),
    }
}

async fn wait_for_status(server: &mut RunningServer) -> Value {
    let client = reqwest::Client::new();
    let mut last_error = String::new();
    for _ in 0..100 {
        if let Some(status) = server.child.try_wait().expect("poll server process") {
            let mut stderr = String::new();
            if let Some(mut pipe) = server.child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("kanna-server exited with {status}: {stderr}");
        }

        match client.get(&server.status_url).send().await {
            Ok(response) if response.status().is_success() => {
                return response.json().await.expect("decode status response JSON");
            }
            Ok(response) => last_error = format!("HTTP {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "timed out waiting for kanna-server at {}: {last_error}",
        server.status_url
    );
}

#[tokio::test]
async fn production_and_staging_processes_report_exact_build_identity_over_http() {
    let (production_port, staging_port) = two_free_loopback_ports();
    let mut production = launch_server(
        "production",
        "desktop-production",
        "Production Mac",
        "0.0.69",
        "production",
        production_port,
    );
    let mut staging = launch_server(
        "staging",
        "desktop-staging",
        "Staging Mac",
        "0.0.69-staging.1",
        "staging",
        staging_port,
    );

    let (production_status, staging_status) = tokio::join!(
        wait_for_status(&mut production),
        wait_for_status(&mut staging),
    );

    assert_eq!(
        production_status,
        json!({
            "state": "running",
            "desktopId": "desktop-production",
            "desktopName": "Production Mac",
            "version": "0.0.69",
            "environment": "production",
            "serverVersion": "0.0.69",
            "lanHost": "127.0.0.1",
            "lanPort": production.port,
            "pairingCode": null
        })
    );
    assert_eq!(
        staging_status,
        json!({
            "state": "running",
            "desktopId": "desktop-staging",
            "desktopName": "Staging Mac",
            "version": "0.0.69-staging.1",
            "environment": "staging",
            "serverVersion": "0.0.69-staging.1",
            "lanHost": "127.0.0.1",
            "lanPort": staging.port,
            "pairingCode": null
        })
    );
}

#[tokio::test]
async fn register_emits_a_startable_development_config_with_build_identity() {
    let root = tempfile::Builder::new()
        .prefix("kanna-status-register-")
        .tempdir()
        .expect("create registration test root");
    let register_output = Command::new(env!("CARGO_BIN_EXE_kanna-server"))
        .arg("register")
        .arg("wss://relay.example.test")
        .env("HOME", root.path())
        .env("XDG_DATA_HOME", root.path())
        .output()
        .expect("run kanna-server register");
    assert!(
        register_output.status.success(),
        "registration failed: {}",
        String::from_utf8_lossy(&register_output.stderr)
    );

    let config_path = registered_config_path(root.path());
    let registered_config = std::fs::read_to_string(&config_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", config_path.display()));
    let expected_version = include_str!("../../../VERSION").trim();
    assert!(registered_config.contains(&format!("version = \"{expected_version}\"")));
    assert!(registered_config.contains("environment = \"development\""));

    let port = free_loopback_port();
    writeln!(
        OpenOptions::new()
            .append(true)
            .open(&config_path)
            .expect("open registered config"),
        "lan_host = \"127.0.0.1\"\nlan_port = {port}"
    )
    .expect("configure registered server loopback port");

    let child = Command::new(env!("CARGO_BIN_EXE_kanna-server"))
        .env("HOME", root.path())
        .env("XDG_DATA_HOME", root.path())
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("RUST_LOG", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start kanna-server from registered config");
    let mut server = RunningServer {
        child,
        _root: root,
        port,
        status_url: format!("http://127.0.0.1:{port}/v1/status"),
    };

    let status = wait_for_status(&mut server).await;

    assert_eq!(status["version"], expected_version);
    assert_eq!(status["environment"], "development");
    assert_eq!(status["serverVersion"], expected_version);
}
