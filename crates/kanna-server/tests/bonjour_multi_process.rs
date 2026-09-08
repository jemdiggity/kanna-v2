#![cfg(target_os = "macos")]

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
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

fn start_server(
    label: &str,
    environment: &str,
    desktop_id: &str,
    port: u16,
    advertised_relay_url: Option<&str>,
) -> RunningServer {
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
            "relay_url = \"ws://127.0.0.1:9081\"\n\
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

    let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-server"));
    command
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("RUST_LOG", "kanna_server=info")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(relay_url) = advertised_relay_url {
        command.env("KANNA_ADVERTISED_RELAY_URL", relay_url);
    }
    let child = command.spawn().expect("launch kanna-server");

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

struct DnsSdObservation {
    output: String,
    diagnostics: String,
}

enum BrowserLine {
    Stdout(String),
    Stderr(String),
}

fn assert_valid_push_pairing_material(material: &serde_json::Value, device_id: &str) {
    const CERT_TTL_MS: u64 = 730 * 24 * 60 * 60 * 1_000;
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CertificatePayload<'a> {
        device_id: &'a str,
        issued_at: u64,
        expires_at: u64,
    }
    let identity = &material["desktopPushIdentity"];
    let certificate = &material["pushPairingCert"];
    assert_eq!(certificate["deviceId"], device_id);
    let issued_at = certificate["issuedAt"].as_u64().expect("issuedAt");
    let expires_at = certificate["expiresAt"].as_u64().expect("expiresAt");
    assert_eq!(expires_at - issued_at, CERT_TTL_MS);
    let public_key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(identity["publicKey"].as_str().expect("desktop public key"))
        .expect("decode desktop public key")
        .try_into()
        .expect("32-byte desktop public key");
    let signature = Signature::from_slice(
        &URL_SAFE_NO_PAD
            .decode(
                certificate["signature"]
                    .as_str()
                    .expect("certificate signature"),
            )
            .expect("decode certificate signature"),
    )
    .expect("64-byte certificate signature");
    let mut payload = b"kanna.push-pairing-cert.v1\0".to_vec();
    payload.extend(
        serde_json::to_vec(&CertificatePayload {
            device_id,
            issued_at,
            expires_at,
        })
        .expect("serialize canonical certificate payload"),
    );
    VerifyingKey::from_bytes(&public_key)
        .expect("valid Ed25519 public key")
        .verify(&payload, &signature)
        .expect("desktop-signed pairing certificate");
}

fn spawn_line_reader<R: Read + Send + 'static>(
    stream: R,
    lines: mpsc::Sender<BrowserLine>,
    wrap: fn(String) -> BrowserLine,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if lines.send(wrap(line)).is_err() {
                break;
            }
        }
    })
}

fn dns_sd_zone_until(predicate: impl Fn(&str) -> bool, timeout: Duration) -> DnsSdObservation {
    // This is intentionally the host's resolver, not another in-process
    // mdns_sd daemon. A browser that exits before the deadline is retried and
    // its status/stderr are retained so a failure explains the host condition.
    let deadline = Instant::now() + timeout;
    let mut diagnostics = String::new();
    loop {
        let mut child = Command::new("/usr/bin/dns-sd")
            .args(["-Z", "_kanna-mobile._tcp", "local"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("launch dns-sd zone browser");
        let stdout = child.stdout.take().expect("capture dns-sd stdout");
        let stderr = child.stderr.take().expect("capture dns-sd stderr");
        let (lines, receiver) = mpsc::channel();
        let stdout_reader = spawn_line_reader(stdout, lines.clone(), BrowserLine::Stdout);
        let stderr_reader = spawn_line_reader(stderr, lines, BrowserLine::Stderr);
        let mut output = String::new();
        let mut stderr_output = String::new();
        let mut early_exit: Option<ExitStatus> = None;
        let mut matched = false;

        while Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(BrowserLine::Stdout(line)) => {
                    output.push_str(&line);
                    output.push('\n');
                    if predicate(&output) {
                        matched = true;
                        break;
                    }
                }
                Ok(BrowserLine::Stderr(line)) => {
                    stderr_output.push_str(&line);
                    stderr_output.push('\n');
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {}
            }
            if let Some(status) = child.try_wait().expect("poll dns-sd browser") {
                early_exit = Some(status);
                break;
            }
        }

        if early_exit.is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        if matched || Instant::now() >= deadline {
            if !matched {
                diagnostics.push_str(&format!(
                    "dns-sd remained active until the observation deadline; stderr:\n{stderr_output}"
                ));
            }
            return DnsSdObservation {
                output,
                diagnostics,
            };
        }

        let status = early_exit.expect("unmatched browser stopped before the deadline");
        diagnostics.push_str(&format!(
            "dns-sd exited early with {status}; stderr:\n{stderr_output}stdout:\n{output}\n"
        ));
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DiscoveredService {
    port: Option<u16>,
    txt_desktop_id: Option<String>,
}

fn discovered_services(zone: &str) -> std::collections::HashMap<String, DiscoveredService> {
    let mut services = std::collections::HashMap::new();
    for line in zone.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(record_index) = fields
            .iter()
            .position(|field| *field == "SRV" || *field == "TXT")
        else {
            continue;
        };
        let Some(owner) = fields.first() else {
            continue;
        };
        let service = services
            .entry((*owner).to_string())
            .or_insert_with(DiscoveredService::default);
        match fields[record_index] {
            "SRV" => {
                service.port = fields
                    .get(record_index + 3)
                    .and_then(|port| port.parse().ok());
            }
            "TXT" => {
                service.txt_desktop_id = fields.get(record_index + 1).and_then(|txt| {
                    txt.trim_matches('"')
                        .strip_prefix("desktopId=")
                        .map(str::to_string)
                });
            }
            _ => unreachable!(),
        }
    }
    services
}

fn discovered_service(zone: &str, desktop_id: &str) -> Option<DiscoveredService> {
    discovered_services(zone)
        .into_iter()
        .find_map(|(_owner, service)| {
            (service.txt_desktop_id.as_deref() == Some(desktop_id) && service.port.is_some())
                .then_some(service)
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
            start_server(
                label,
                environment,
                desktop_id,
                reserve_port(),
                (*label == "staging").then_some("ws://172.16.0.193:9081"),
            )
        })
        .collect();
    for server in &mut servers {
        wait_for_status(server).await;
    }

    let zone = dns_sd_zone_until(
        |output| {
            servers.iter().all(|server| {
                discovered_service(output, &server.desktop_id)
                    .is_some_and(|service| service.port == Some(server.port))
            })
        },
        Duration::from_secs(15),
    );
    for server in &servers {
        let discovered = discovered_service(&zone.output, &server.desktop_id);
        assert!(
            discovered.as_ref().is_some_and(|service| {
                service.port == Some(server.port)
                    && service.txt_desktop_id.as_deref() == Some(&server.desktop_id)
            }),
            "missing exact TXT desktopId {} and SRV port {} from dns-sd output:\n{}\n{}",
            server.desktop_id,
            server.port,
            zone.output,
            zone.diagnostics
        );
    }

    // Follow the same boundary as a phone after discovery: the SRV/TXT pair
    // selects this real server and its port, then the pairing session is
    // claimed over that server's LAN HTTP surface.
    let qr_desktop_id = &identities[1].2;
    let discovered = discovered_service(&zone.output, qr_desktop_id)
        .expect("QR desktopId must select a discovered TXT/SRV pair");
    let discovered_port = discovered.port.expect("discovered SRV port");
    assert_eq!(
        discovered.txt_desktop_id.as_deref(),
        Some(qr_desktop_id.as_str())
    );
    let client = reqwest::Client::new();
    let pairing: serde_json::Value = client
        .post(format!(
            "http://127.0.0.1:{}/v1/pairing/sessions",
            discovered_port
        ))
        .send()
        .await
        .expect("create pairing session through real server")
        .error_for_status()
        .expect("pairing session response")
        .json()
        .await
        .expect("decode pairing session");
    assert_eq!(pairing["desktopId"], qr_desktop_id.as_str());
    let pairing_payload = pairing["pairingPayload"]
        .as_str()
        .expect("pairing session must carry its QR payload");
    let pairing_prefix = format!("KANNA1:{}:", qr_desktop_id.to_ascii_uppercase());
    let scanned_code = pairing_payload
        .strip_prefix(&pairing_prefix)
        .expect("decode the exact generated compact QR payload");
    assert_eq!(
        scanned_code,
        pairing["code"].as_str().expect("pairing code")
    );
    let claimed: serde_json::Value = client
        .post(format!(
            "http://127.0.0.1:{}/v1/pairing/sessions/claim",
            discovered_port
        ))
        .json(&serde_json::json!({
            "code": scanned_code,
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
    assert_eq!(claimed["desktopId"], qr_desktop_id.as_str());
    assert_eq!(claimed["desktopPushIdentity"]["environment"], "staging");
    // KD puts this phone-reachable URL in KANNA_ADVERTISED_RELAY_URL for the
    // desktop process. Prove the real server's pairing boundary prefers it to
    // the loopback relay_url in server.toml.
    assert_eq!(
        claimed["desktopPushIdentity"]["relayUrl"],
        "ws://172.16.0.193:9081"
    );
    assert_valid_push_pairing_material(&claimed, "bonjour-e2e-phone");

    let unauthenticated_reissue = client
        .post(format!(
            "http://127.0.0.1:{}/v1/pairing/push-certificate",
            discovered_port
        ))
        .send()
        .await
        .expect("attempt unauthenticated pairing certificate re-issue");
    assert_eq!(
        unauthenticated_reissue.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let reissued: serde_json::Value = client
        .post(format!(
            "http://127.0.0.1:{}/v1/pairing/push-certificate",
            discovered_port
        ))
        .header("x-kanna-device-id", "bonjour-e2e-phone")
        .header(
            "x-kanna-device-secret",
            claimed["deviceSecret"]
                .as_str()
                .expect("pairing device secret"),
        )
        .send()
        .await
        .expect("re-issue pairing certificate through discovered server")
        .error_for_status()
        .expect("pairing certificate re-issue response")
        .json()
        .await
        .expect("decode re-issued pairing certificate");
    assert_eq!(
        reissued["desktopPushIdentity"]["publicKey"],
        claimed["desktopPushIdentity"]["publicKey"]
    );
    assert_eq!(
        reissued["desktopPushIdentity"]["relayUrl"],
        "ws://172.16.0.193:9081"
    );
    assert_valid_push_pairing_material(&reissued, "bonjour-e2e-phone");

    let removed = servers.swap_remove(1);
    let removed_id = removed.desktop_id.clone();
    let removed_port = removed.port;
    drop(removed);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after_shutdown = dns_sd_zone_until(
        |output| {
            servers
                .iter()
                .all(|server| discovered_service(output, &server.desktop_id).is_some())
        },
        Duration::from_secs(5),
    );
    assert!(
        discovered_service(&after_shutdown.output, &removed_id)
            .is_none_or(|service| service.port != Some(removed_port)),
        "shutdown record remained visible:\n{}\n{}",
        after_shutdown.output,
        after_shutdown.diagnostics
    );

    let replacement_port = reserve_port();
    let mut replacement = start_server(
        "staging-restarted",
        "staging",
        &removed_id,
        replacement_port,
        None,
    );
    wait_for_status(&mut replacement).await;
    let after_restart = dns_sd_zone_until(
        |output| {
            discovered_service(output, &removed_id)
                .is_some_and(|service| service.port == Some(replacement_port))
        },
        Duration::from_secs(10),
    );
    let restarted = discovered_service(&after_restart.output, &removed_id);
    assert_eq!(
        restarted,
        Some(DiscoveredService {
            port: Some(replacement_port),
            txt_desktop_id: Some(removed_id.clone()),
        }),
        "replacement record missing or mismatched:\n{}\n{}",
        after_restart.output,
        after_restart.diagnostics
    );
    assert_ne!(
        restarted.and_then(|service| service.port),
        Some(removed_port)
    );
}
