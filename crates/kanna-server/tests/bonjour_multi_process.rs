#![cfg(target_os = "macos")]

use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::net::UnixListener;
use tokio::task::JoinHandle;

struct RunningServer {
    child: Child,
    daemon: JoinHandle<()>,
    _root: tempfile::TempDir,
    desktop_id: String,
    environment: String,
    port: u16,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.daemon.abort();
    }
}

fn reserve_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .expect("reserve a test port")
}

fn toml_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn start_fake_daemon(daemon_dir: &Path) -> JoinHandle<()> {
    let socket_path = kanna_runtime_defaults::socket_path(daemon_dir);
    let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
    std::fs::write(
        daemon_dir.join("daemon.pid"),
        format!("{}\n", std::process::id()),
    )
    .expect("publish fake daemon pid");

    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.expect("accept daemon client");
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut reader = AsyncBufReader::new(read);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let command: kanna_daemon::protocol::Command =
                        serde_json::from_str(line.trim()).expect("parse daemon command");
                    let response = match command {
                        kanna_daemon::protocol::Command::NegotiateProtectedInput { .. } => {
                            kanna_daemon::protocol::Event::ProtectedInputReady {
                                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
                            }
                        }
                        kanna_daemon::protocol::Command::List => {
                            kanna_daemon::protocol::Event::SessionList {
                                sessions: Vec::new(),
                            }
                        }
                        _ => kanna_daemon::protocol::Event::Ok,
                    };
                    write
                        .write_all(
                            format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                        )
                        .await
                        .expect("write fake daemon response");
                }
            });
        }
    })
}

fn start_server(label: &str, environment: &str, desktop_id: &str, port: u16) -> RunningServer {
    let root = tempfile::Builder::new()
        .prefix(&format!("kanna-bonjour-{label}-"))
        .tempdir()
        .expect("create Bonjour E2E root");
    let daemon_dir = root.path().join("daemon");
    std::fs::create_dir_all(&daemon_dir).expect("create daemon directory");
    let config_path = root.path().join("server.toml");
    let db_path = root.path().join("kanna.sqlite3");
    let pairing_store_path = root.path().join("pairings.json");
    let transfer_port = reserve_port();
    std::fs::write(
        &config_path,
        format!(
            "relay_url = \"\"\n\
             device_token = \"\"\n\
             firebase_project_id = \"kanna-local\"\n\
             daemon_dir = \"{}\"\n\
             db_path = \"{}\"\n\
             desktop_id = \"{desktop_id}\"\n\
             desktop_secret = \"bonjour-e2e-secret\"\n\
             desktop_name = \"Bonjour {label}\"\n\
             version = \"bonjour-e2e\"\n\
             environment = \"{environment}\"\n\
             lan_host = \"127.0.0.1\"\n\
             lan_port = {port}\n\
             transfer_port = {transfer_port}\n\
             pairing_store_path = \"{}\"\n",
            toml_path(&daemon_dir),
            toml_path(&db_path),
            toml_path(&pairing_store_path),
        ),
    )
    .expect("write server configuration");
    let daemon = start_fake_daemon(&daemon_dir);

    let child = Command::new(env!("CARGO_BIN_EXE_kanna-server"))
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("RUST_LOG", "kanna_server=info")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch kanna-server");

    RunningServer {
        child,
        daemon,
        _root: root,
        desktop_id: desktop_id.to_string(),
        environment: environment.to_string(),
        port,
    }
}

async fn wait_for_status(server: &mut RunningServer) {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/v1/status", server.port);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = server.child.try_wait().expect("poll kanna-server") {
            let mut stderr = String::new();
            if let Some(mut pipe) = server.child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("kanna-server exited with {status}: {stderr}");
        }
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                let status: serde_json::Value = response.json().await.expect("decode status");
                assert_eq!(status["desktopId"], server.desktop_id);
                assert_eq!(status["environment"], server.environment);
                return;
            }
        }
        assert!(Instant::now() < deadline, "timed out waiting for {url}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn dns_sd_zone_until(predicate: impl Fn(&str) -> bool, timeout: Duration) -> String {
    // `script` gives dns-sd a PTY so its diagnostic output is flushed as each
    // externally observable record arrives. This is intentionally the host's
    // resolver, not another in-process mdns_sd daemon.
    let mut child = Command::new("/usr/bin/script")
        .args([
            "-q",
            "/dev/null",
            "/usr/bin/dns-sd",
            "-Z",
            "_kanna-mobile._tcp",
            "local",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("launch dns-sd zone browser");
    let stdout = child.stdout.take().expect("capture dns-sd output");
    let (lines, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = lines.send(line);
        }
    });

    let deadline = Instant::now() + timeout;
    let mut output = String::new();
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                output.push_str(&line);
                output.push('\n');
                if predicate(&output) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    output
}

fn contains_record(zone: &str, desktop_id: &str, port: u16) -> bool {
    zone.lines().any(|line| {
        line.contains(desktop_id)
            && line.contains(" SRV ")
            && line
                .split_whitespace()
                .any(|field| field == port.to_string())
    })
}

#[tokio::test]
async fn distinct_real_servers_publish_and_clean_up_through_macos_bonjour() {
    let suffix = format!("{}-{}", std::process::id(), reserve_port());
    let identities = [
        ("dev", "development", format!("bonjour-dev-{suffix}")),
        ("staging", "staging", format!("bonjour-staging-{suffix}")),
        (
            "production",
            "production",
            format!("bonjour-production-{suffix}"),
        ),
    ];
    let mut servers: Vec<RunningServer> = identities
        .iter()
        .map(|(label, environment, desktop_id)| {
            start_server(label, environment, desktop_id, reserve_port())
        })
        .collect();
    for server in &mut servers {
        wait_for_status(server).await;
    }

    let zone = dns_sd_zone_until(
        |output| {
            servers
                .iter()
                .all(|server| contains_record(output, &server.desktop_id, server.port))
        },
        Duration::from_secs(15),
    );
    for server in &servers {
        assert!(
            contains_record(&zone, &server.desktop_id, server.port),
            "missing {} on port {} from dns-sd output:\n{zone}",
            server.desktop_id,
            server.port
        );
    }

    // Follow the same boundary as a phone after discovery: the SRV/TXT pair
    // selects this real server and its port, then the pairing session is
    // claimed over that server's LAN HTTP surface.
    let discovered = &servers[0];
    let client = reqwest::Client::new();
    let pairing: serde_json::Value = client
        .post(format!(
            "http://127.0.0.1:{}/v1/pairing/sessions",
            discovered.port
        ))
        .send()
        .await
        .expect("create pairing session through real server")
        .error_for_status()
        .expect("pairing session response")
        .json()
        .await
        .expect("decode pairing session");
    assert_eq!(pairing["desktopId"], discovered.desktop_id);
    let claimed: serde_json::Value = client
        .post(format!(
            "http://127.0.0.1:{}/v1/pairing/sessions/claim",
            discovered.port
        ))
        .json(&serde_json::json!({
            "code": pairing["code"],
            "deviceId": "bonjour-e2e-phone",
            "deviceName": "Bonjour E2E Phone"
        }))
        .send()
        .await
        .expect("claim pairing session through discovered server")
        .error_for_status()
        .expect("pairing claim response")
        .json()
        .await
        .expect("decode pairing claim");
    assert_eq!(claimed["desktopId"], discovered.desktop_id);

    let removed = servers.swap_remove(1);
    let removed_id = removed.desktop_id.clone();
    let removed_port = removed.port;
    drop(removed);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after_shutdown = dns_sd_zone_until(
        |output| {
            servers
                .iter()
                .all(|server| output.contains(&server.desktop_id))
        },
        Duration::from_secs(5),
    );
    assert!(
        !contains_record(&after_shutdown, &removed_id, removed_port),
        "shutdown record remained visible:\n{after_shutdown}"
    );

    let replacement_port = reserve_port();
    let mut replacement = start_server(
        "staging-restarted",
        "staging",
        &removed_id,
        replacement_port,
    );
    wait_for_status(&mut replacement).await;
    let after_restart = dns_sd_zone_until(
        |output| contains_record(output, &removed_id, replacement_port),
        Duration::from_secs(10),
    );
    assert!(contains_record(
        &after_restart,
        &removed_id,
        replacement_port
    ));
    assert!(!contains_record(&after_restart, &removed_id, removed_port));
}
