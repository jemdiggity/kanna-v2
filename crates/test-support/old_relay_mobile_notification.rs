use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tungstenite::{accept, Message, WebSocket};

pub const OLD_RELAY_CANARY: &str = "ya29.old-relay-provider-canary-DO-NOT-LEAK";
pub const SAFE_REJECTION_ERROR: &str = "mobile notification delivery failed (category=relayRejection, correlation=2); retry later and inspect the matching environment's server and relay logs";

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kanna-old-relay-notification-{}-{label}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create server test root");
        Self { path }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct FakeDaemon {
    socket_path: PathBuf,
    _keepalive: mpsc::Sender<()>,
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

pub struct OldRelayMobileNotificationServer {
    child: Child,
    _root: TestRoot,
    _daemon: FakeDaemon,
    relay: Option<thread::JoinHandle<String>>,
    raw_ack_sent: mpsc::Receiver<()>,
    pub base_url: String,
}

impl Drop for OldRelayMobileNotificationServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Mirrors `kanna_runtime_defaults::socket_path`, directory included: these
/// sockets live in `/tmp` on macOS but in `$XDG_RUNTIME_DIR` on Linux when the
/// session manager provides one. A mirror that hardcoded `/tmp` would bind
/// somewhere the server never looks, and the server would wait forever for a
/// daemon generation instead of opening its listeners.
fn daemon_socket_path(daemon_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    daemon_dir.to_path_buf().hash(&mut hasher);
    let hash = hasher.finish() as u32;
    let dir = match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        Some(runtime_dir) if !cfg!(target_os = "macos") && runtime_dir.is_absolute() => runtime_dir,
        _ => PathBuf::from("/tmp"),
    };
    dir.join(format!("kanna-{hash:08x}.sock"))
}

fn spawn_fake_daemon(daemon_dir: &Path) -> (FakeDaemon, mpsc::Receiver<()>) {
    let socket_path = daemon_socket_path(daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
    let (keepalive, keepalive_rx) = mpsc::channel::<()>();
    let (handshake_done, subscribed) = mpsc::channel::<()>();

    thread::spawn(move || {
        let mut generation_ready = None;
        let mut watcher_listed = false;
        let mut subscription = None;
        while generation_ready.is_none() || !watcher_listed || subscription.is_none() {
            let (mut connection, _) = listener.accept().expect("accept daemon connection");
            let mut reader =
                BufReader::new(connection.try_clone().expect("clone daemon connection"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("read daemon command");

            if line.contains("NegotiateProtectedInput") {
                writeln!(
                    connection,
                    "{{\"type\":\"ProtectedInputReady\",\"version\":{}}}",
                    kanna_runtime_defaults::PROTECTED_INPUT_PROTOCOL_VERSION,
                )
                .expect("acknowledge protected-input negotiation");
                line.clear();
                reader
                    .read_line(&mut line)
                    .expect("read generation list command");
                assert!(line.contains("List"), "expected List, got {line}");
                writeln!(connection, "{{\"type\":\"SessionList\",\"sessions\":[]}}")
                    .expect("answer generation list");
                generation_ready = Some(connection);
            } else if line.contains("Subscribe") {
                writeln!(connection, "{{\"type\":\"Ok\"}}").expect("acknowledge subscribe");
                subscription = Some(connection);
            } else {
                assert!(line.contains("List"), "expected daemon command, got {line}");
                writeln!(connection, "{{\"type\":\"SessionList\",\"sessions\":[]}}")
                    .expect("answer watcher list");
                watcher_listed = true;
            }
        }

        let _generation = generation_ready.expect("protected-input generation established");
        let _subscription = subscription.expect("daemon subscription established");
        if handshake_done.send(()).is_ok() {
            let _ = keepalive_rx.recv();
        }
    });

    (
        FakeDaemon {
            socket_path,
            _keepalive: keepalive,
        },
        subscribed,
    )
}

fn toml_string(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn workspace_binary(name: &str) -> PathBuf {
    let executable = std::env::current_exe().expect("current test executable");
    let executable_dir = executable.parent().expect("test executable directory");
    let binary_dir = if executable_dir
        .file_name()
        .is_some_and(|name| name == "deps")
    {
        executable_dir.parent().expect("workspace binary directory")
    } else {
        executable_dir
    };
    let direct_binary = binary_dir.join(name);
    let binary = if direct_binary.exists() {
        direct_binary
    } else {
        binary_dir
            .ancestors()
            .find(|path| path.file_name().is_some_and(|part| part == "cargo-build"))
            .and_then(Path::parent)
            .map(|target_dir| target_dir.join("debug").join(name))
            .unwrap_or(direct_binary)
    };
    assert!(
        binary.exists(),
        "{name} binary is missing at {}; this test drives the real server, so run `cargo test --workspace` or `cargo build -p kanna-server` first",
        binary.display()
    );
    binary
}

fn read_json_message(socket: &mut WebSocket<TcpStream>) -> Value {
    loop {
        match socket.read().expect("read relay frame") {
            Message::Text(text) => return serde_json::from_str(&text).expect("relay JSON"),
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .expect("answer relay ping"),
            _ => {}
        }
    }
}

fn spawn_old_relay(
    listener: TcpListener,
    raw_ack_sent: mpsc::Sender<()>,
) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept server relay connection");
        let mut socket = accept(stream).expect("accept relay WebSocket");
        let auth = read_json_message(&mut socket);
        assert_eq!(auth["type"], "auth");
        socket
            .send(Message::Text(
                json!({
                    "type": "auth_ok",
                    "userId": "operator-1",
                    "capabilities": {
                        "mobileNotifications": { "version": 1 }
                    }
                })
                .to_string()
                .into(),
            ))
            .expect("send relay authentication acknowledgement");

        let mut notification_count = 0;
        loop {
            let publish = read_json_message(&mut socket);
            if publish["type"] != "mobile_notification_publish" {
                continue;
            }
            notification_count += 1;
            let acknowledgement = if notification_count == 1 {
                assert_eq!(publish["notification"]["title"], "Fixture readiness");
                json!({
                    "type": "mobile_notification_ack",
                    "id": publish["id"],
                    "ok": true,
                    "delivery": {
                        "acceptedCount": 1,
                        "failedCount": 0,
                        "failureReasons": []
                    }
                })
            } else {
                assert_eq!(publish["notification"]["title"], "Provider call rejected");
                let raw_error = format!(
                    "Firebase Admin request rejected: Authorization: Bearer {OLD_RELAY_CANARY}; project=kanna-secret-project; response={{\"tokenDiagnostics\":\"raw-device-token-diagnostic\"}}"
                );
                let acknowledgement = json!({
                    "type": "mobile_notification_ack",
                    "id": publish["id"],
                    "ok": false,
                    "error": raw_error
                });
                socket
                    .send(Message::Text(acknowledgement.to_string().into()))
                    .expect("send old-relay rejection acknowledgement");
                raw_ack_sent
                    .send(())
                    .expect("record old-relay acknowledgement");
                return acknowledgement.to_string();
            };
            socket
                .send(Message::Text(acknowledgement.to_string().into()))
                .expect("send relay acknowledgement");
        }
    })
}

impl OldRelayMobileNotificationServer {
    pub async fn start(label: &str) -> Self {
        let lan = TcpListener::bind(("127.0.0.1", 0)).expect("reserve LAN port");
        let transfer = TcpListener::bind(("127.0.0.1", 0)).expect("reserve transfer port");
        let relay_listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind old relay stand-in");
        let port = lan.local_addr().expect("LAN address").port();
        let transfer_port = transfer.local_addr().expect("transfer address").port();
        let relay_address = relay_listener.local_addr().expect("relay address");

        let root = TestRoot::new(label);
        let daemon_dir = root.path.join("daemon");
        std::fs::create_dir_all(&daemon_dir).expect("create daemon directory");
        let (daemon, daemon_ready) = spawn_fake_daemon(&daemon_dir);
        let config_path = root.path.join("server.toml");
        std::fs::write(
            &config_path,
            format!(
                "relay_url = \"ws://{relay_address}\"\n\
                 device_token = \"device-token\"\n\
                 firebase_project_id = \"kanna-local\"\n\
                 daemon_dir = \"{}\"\n\
                 db_path = \"{}\"\n\
                 desktop_id = \"desktop-old-relay-test\"\n\
                 desktop_secret = \"desktop-secret\"\n\
                 desktop_name = \"Old Relay Test\"\n\
                 version = \"0.0.0-test\"\n\
                 environment = \"development\"\n\
                 lan_host = \"127.0.0.1\"\n\
                 lan_port = {port}\n\
                 transfer_port = {transfer_port}\n\
                 pairing_store_path = \"{}\"\n",
                toml_string(&daemon_dir),
                toml_string(&root.path.join("kanna.sqlite3")),
                toml_string(&root.path.join("pairings.json")),
            ),
        )
        .expect("write server configuration");

        let (raw_ack_tx, raw_ack_sent) = mpsc::channel();
        let relay = spawn_old_relay(relay_listener, raw_ack_tx);
        drop(lan);
        drop(transfer);
        let child = Command::new(workspace_binary("kanna-server"))
            .env("KANNA_SERVER_CONFIG", &config_path)
            .env("RUST_LOG", "kanna_server=warn")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("launch kanna-server");
        let base_url = format!("http://127.0.0.1:{port}");
        let mut fixture = Self {
            child,
            _root: root,
            _daemon: daemon,
            relay: Some(relay),
            raw_ack_sent,
            base_url,
        };
        fixture.wait_until_ready().await;
        daemon_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("server did not complete daemon startup handshake");
        fixture
    }

    async fn wait_until_ready(&mut self) {
        let client = reqwest::Client::new();
        let status_url = format!("{}/v1/status", self.base_url);
        let mut last_error = String::new();
        for _ in 0..200 {
            if let Some(status) = self.child.try_wait().expect("poll server process") {
                let mut stderr = String::new();
                if let Some(mut pipe) = self.child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                panic!("kanna-server exited with {status}: {stderr}");
            }
            match client.get(&status_url).send().await {
                Ok(response) if response.status().is_success() => {
                    let readiness = client
                        .post(format!("{}/v1/mobile/notifications", self.base_url))
                        .json(&json!({
                            "title": "Fixture readiness",
                            "body": "Establish the server-owned correlation sequence."
                        }))
                        .send()
                        .await;
                    if matches!(readiness, Ok(response) if response.status().is_success()) {
                        return;
                    }
                    last_error = "mobile notification relay is not ready".to_string();
                }
                Ok(response) => last_error = format!("HTTP {}", response.status()),
                Err(error) => last_error = error.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("kanna-server never became ready: {last_error}");
    }

    pub fn finish(mut self) -> String {
        self.raw_ack_sent
            .recv_timeout(Duration::from_secs(5))
            .expect("client request never reached the old relay stand-in");
        let raw_ack = self
            .relay
            .take()
            .expect("relay fixture")
            .join()
            .expect("relay fixture thread");
        self.child.kill().expect("stop kanna-server");
        self.child.wait().expect("reap kanna-server");
        let mut stderr = Vec::new();
        self.child
            .stderr
            .take()
            .expect("server stderr")
            .read_to_end(&mut stderr)
            .expect("collect server logs");
        let logs = String::from_utf8(stderr).expect("UTF-8 server logs");
        assert!(
            raw_ack.contains(OLD_RELAY_CANARY),
            "fixture did not inject the old-relay canary: {raw_ack}"
        );
        assert!(
            !logs.contains(OLD_RELAY_CANARY),
            "old-relay acknowledgement leaked to server logs: {logs}"
        );
        logs
    }
}
