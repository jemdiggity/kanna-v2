//! The browser/local-client boundary on the real LAN listener.
//!
//! These exercise a launched `kanna-server` process over a real socket rather
//! than the in-process router, because what is being asserted lives in the
//! bytes on the wire: the `Host` a rebound page must send, the `Origin` and
//! `Sec-Fetch-*` headers a browser attaches and cannot suppress, and a genuine
//! WebSocket handshake, which no CORS layer ever sees.
//!
//! Every test launches its own server in a temp root on an ephemeral port. No
//! test touches a running instance.

use std::io::Read as _;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::task::JoinHandle;

struct RunningServer {
    child: Child,
    daemon: JoinHandle<()>,
    root: TempDir,
    port: u16,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.daemon.abort();
    }
}

impl RunningServer {
    fn origin(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// The local control credential this server wrote while starting, beside
    /// its pairing store.
    async fn credential(&self) -> String {
        let path = self.root.path().join("task-events.token");
        for _ in 0..100 {
            if let Ok(token) = std::fs::read_to_string(&path) {
                if !token.trim().is_empty() {
                    return token.trim().to_string();
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("server never wrote {}", path.display());
    }
}

fn start_fake_daemon(daemon_dir: &Path) -> JoinHandle<()> {
    std::fs::create_dir_all(daemon_dir).expect("create fake daemon directory");
    let socket_path = kanna_runtime_defaults::socket_path(daemon_dir);
    let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
    std::fs::write(
        daemon_dir.join("daemon.pid"),
        format!("{}\n", std::process::id()),
    )
    .expect("publish fake daemon pid");

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let Ok(command) =
                        serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim())
                    else {
                        return;
                    };
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
                    if write
                        .write_all(
                            format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    })
}

fn toml_string(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn reserve_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve loopback port");
    let port = listener.local_addr().expect("read reserved port").port();
    (listener, port)
}

/// Server processes are heavy and each one binds its own ports; running the
/// whole file's fixtures at once only invites flakes.
static PROCESS_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn launch_server(label: &str) -> RunningServer {
    let (lan, port) = reserve_port();
    let (transfer, transfer_port) = reserve_port();
    let root = tempfile::Builder::new()
        .prefix(&format!("kanna-boundary-{label}-"))
        .tempdir()
        .expect("create server test root");
    let daemon_dir = root.path().join("daemon");
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
             desktop_id = \"desktop-{label}\"\n\
             desktop_secret = \"test-secret\"\n\
             desktop_name = \"Boundary Test\"\n\
             version = \"0.0.0\"\n\
             environment = \"development\"\n\
             lan_host = \"127.0.0.1\"\n\
             lan_port = {port}\n\
             transfer_port = {transfer_port}\n\
             pairing_store_path = \"{}\"\n",
            toml_string(&daemon_dir),
            toml_string(&db_path),
            toml_string(&pairing_store_path),
        ),
    )
    .expect("write server configuration");
    let daemon = start_fake_daemon(&daemon_dir);

    drop(lan);
    drop(transfer);
    let child = Command::new(env!("CARGO_BIN_EXE_kanna-server"))
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("RUST_LOG", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch kanna-server test process");

    let mut server = RunningServer {
        child,
        daemon,
        root,
        port,
    };
    wait_until_listening(&mut server).await;
    server
}

async fn wait_until_listening(server: &mut RunningServer) {
    let mut last = "never connected".to_string();
    for _ in 0..400 {
        if let Some(status) = server.child.try_wait().expect("poll server process") {
            let mut stderr = String::new();
            if let Some(mut pipe) = server.child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("kanna-server exited with {status}: {stderr}");
        }
        match try_request(server.port, "GET", "/v1/status", &server.origin(), &[]).await {
            Ok(response) if response.status == 200 => return,
            Ok(response) => last = format!("HTTP {}: {}", response.status, response.body),
            Err(error) => last = error,
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "timed out waiting for kanna-server on port {}: {last}",
        server.port
    );
}

struct RawResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl RawResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Issue one HTTP/1.1 request byte-for-byte.
///
/// Written by hand rather than through `reqwest` because these tests turn on
/// headers a well-behaved client insists on owning — `Host` above all.
async fn request(
    port: u16,
    method: &str,
    path: &str,
    host: &str,
    headers: &[(&str, &str)],
) -> RawResponse {
    try_request(port, method, path, host, headers)
        .await
        .unwrap_or_else(|error| panic!("{method} {path} failed: {error}"))
}

async fn try_request(
    port: u16,
    method: &str,
    path: &str,
    host: &str,
    headers: &[(&str, &str)],
) -> Result<RawResponse, String> {
    let mut wire = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in headers {
        wire.push_str(&format!("{name}: {value}\r\n"));
    }
    wire.push_str("\r\n");

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|error| format!("connect: {error}"))?;
    stream
        .write_all(wire.as_bytes())
        .await
        .map_err(|error| format!("write: {error}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|error| format!("read: {error}"))?;
    Ok(parse_response(&String::from_utf8_lossy(&raw)))
}

fn parse_response(raw: &str) -> RawResponse {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or_else(|| panic!("unparsable status line: {status_line:?}"));
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();
    RawResponse {
        status,
        headers,
        body: body.to_string(),
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

#[tokio::test]
async fn local_process_clients_keep_their_loopback_authority() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("local-process").await;

    // The shape every non-browser client has: no `Origin`, no `Sec-Fetch-*`,
    // and an address for a `Host`. The CLI, the MCP server, the sidecars and
    // every running agent send exactly this, and none of them was asked to
    // start carrying a token.
    let response = request(server.port, "GET", "/v1/repos", &server.origin(), &[]).await;
    assert_eq!(
        response.status, 200,
        "a local process client must keep loopback authority: {}",
        response.body
    );
}

#[tokio::test]
async fn a_browser_without_the_local_credential_is_refused() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("hostile-origin").await;

    for (label, headers) in [
        (
            "a cross-origin fetch",
            vec![("Origin", "http://attacker.example")],
        ),
        (
            "a page that only reveals itself through fetch metadata",
            vec![("Sec-Fetch-Site", "cross-site"), ("Sec-Fetch-Mode", "cors")],
        ),
        (
            "a page pointed at the loopback origin itself",
            vec![("Origin", "http://127.0.0.1:3000")],
        ),
    ] {
        for path in ["/v1/status", "/v1/repos", "/v1/snapshot"] {
            let response = request(server.port, "GET", path, &server.origin(), &headers).await;
            assert_eq!(
                response.status, 403,
                "{label} must be refused on {path}, got {} {}",
                response.status, response.body
            );
        }
    }

    // A privileged control, not just a read.
    let response = request(
        server.port,
        "POST",
        "/v1/tasks/whatever/actions/close",
        &server.origin(),
        &[
            ("Origin", "http://attacker.example"),
            ("Content-Length", "0"),
        ],
    )
    .await;
    assert_eq!(response.status, 403, "body: {}", response.body);
}

#[tokio::test]
async fn a_browser_with_an_invalid_credential_is_refused() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("invalid-credential").await;
    let credential = server.credential().await;

    for (label, presented) in [
        ("an empty credential", String::new()),
        ("a guessed credential", "0".repeat(credential.len())),
        ("a truncated credential", credential[..32].to_string()),
    ] {
        let authorization = format!("Bearer {presented}");
        let response = request(
            server.port,
            "GET",
            "/v1/repos",
            &server.origin(),
            &[
                ("Origin", "http://attacker.example"),
                ("Authorization", authorization.as_str()),
            ],
        )
        .await;
        assert_eq!(response.status, 403, "{label} must be refused");
    }
}

#[tokio::test]
async fn the_desktop_webview_is_served_when_it_presents_the_credential() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("desktop-webview").await;
    let credential = server.credential().await;
    let authorization = format!("Bearer {credential}");

    // The webview's real shape: a cross-origin fetch from the Tauri origin,
    // carrying the credential only a process running as the user can read.
    let response = request(
        server.port,
        "GET",
        "/v1/repos",
        &server.origin(),
        &[
            ("Origin", "tauri://localhost"),
            ("Sec-Fetch-Site", "cross-site"),
            ("Sec-Fetch-Mode", "cors"),
            ("Authorization", authorization.as_str()),
        ],
    )
    .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    assert_eq!(
        response.header("access-control-allow-origin"),
        Some("tauri://localhost"),
        "the webview must be allowed to read its own response"
    );

    // The dedicated header is accepted for the same reason `Authorization` is.
    let response = request(
        server.port,
        "GET",
        "/v1/repos",
        &server.origin(),
        &[
            ("Origin", "http://localhost:1420"),
            ("X-Kanna-Local-Token", credential.as_str()),
        ],
    )
    .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
}

#[tokio::test]
async fn a_rebound_host_is_refused_even_though_it_looks_local() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("dns-rebinding").await;

    // DNS rebinding is the browser attack that leaves nothing else to inspect:
    // the page re-resolves its own domain to 127.0.0.1, so its fetches are
    // same-origin and carry no `Origin` and no cross-site `Sec-Fetch-Site`.
    // The one thing it cannot rewrite is the `Host` it must send.
    for host in [
        "attacker.example",
        "kanna.attacker.example",
        "localtest.me",
        "studio.local",
    ] {
        let response = request(server.port, "GET", "/v1/repos", host, &[]).await;
        assert_eq!(
            response.status, 403,
            "a loopback caller addressing {host} must be refused: {}",
            response.body
        );
    }

    // Addresses and `localhost` cannot be rebound, so they stay served.
    for host in [
        format!("127.0.0.1:{}", server.port),
        format!("localhost:{}", server.port),
        format!("[::1]:{}", server.port),
    ] {
        let response = request(server.port, "GET", "/v1/repos", &host, &[]).await;
        assert_eq!(
            response.status, 200,
            "a loopback caller addressing {host} must be served: {}",
            response.body
        );
    }
}

#[tokio::test]
async fn omitting_the_host_header_does_not_launder_a_browser_past_the_boundary() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("no-host").await;

    // Hyper serves an HTTP/1.1 request that omits `Host` rather than refusing
    // it, so the `Host` check alone could be skipped. That buys a page
    // nothing: every browser sends `Host` on every request and page script
    // cannot suppress it, and the request still declares itself a browser's
    // through the headers it cannot suppress either.
    let hostless_browser = hostless_request(
        server.port,
        &[
            ("Origin", "http://attacker.example"),
            ("Sec-Fetch-Site", "cross-site"),
        ],
    )
    .await;
    assert_eq!(
        hostless_browser.status, 403,
        "body: {}",
        hostless_browser.body
    );

    // A local process client that omits it keeps the authority it already had.
    let hostless_local = hostless_request(server.port, &[]).await;
    assert_eq!(hostless_local.status, 200, "body: {}", hostless_local.body);
}

/// An HTTP/1.1 request with no `Host` line at all, which `request` cannot
/// express because it always writes one.
async fn hostless_request(port: u16, headers: &[(&str, &str)]) -> RawResponse {
    let mut wire = String::from("GET /v1/repos HTTP/1.1\r\nConnection: close\r\n");
    for (name, value) in headers {
        wire.push_str(&format!("{name}: {value}\r\n"));
    }
    wire.push_str("\r\n");

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to test server");
    stream
        .write_all(wire.as_bytes())
        .await
        .expect("write hostless request");
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .expect("read hostless response");
    parse_response(&String::from_utf8_lossy(&raw))
}

#[tokio::test]
async fn a_preflight_is_answered_but_authorizes_nothing() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("preflight").await;

    // The webview's `Authorization` header makes every one of its requests
    // non-simple, so a preflight precedes each. A preflight carries no
    // credential and must still be answered, or the app cannot talk to its
    // own server at all.
    let preflight = request(
        server.port,
        "OPTIONS",
        "/v1/repos",
        &server.origin(),
        &[
            ("Origin", "tauri://localhost"),
            ("Access-Control-Request-Method", "GET"),
            ("Access-Control-Request-Headers", "authorization"),
        ],
    )
    .await;
    assert!(
        preflight.status == 200 || preflight.status == 204,
        "preflight must be answered, got {}",
        preflight.status
    );
    assert_eq!(
        preflight.header("access-control-allow-origin"),
        Some("tauri://localhost")
    );

    // Answering the preflight authorized nothing: the request it preceded is
    // still refused without the credential.
    let hostile_preflight = request(
        server.port,
        "OPTIONS",
        "/v1/repos",
        &server.origin(),
        &[
            ("Origin", "http://attacker.example"),
            ("Access-Control-Request-Method", "GET"),
        ],
    )
    .await;
    assert!(
        hostile_preflight.status == 200 || hostile_preflight.status == 204,
        "got {}",
        hostile_preflight.status
    );
    let follow_up = request(
        server.port,
        "GET",
        "/v1/repos",
        &server.origin(),
        &[("Origin", "http://attacker.example")],
    )
    .await;
    assert_eq!(follow_up.status, 403, "body: {}", follow_up.body);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

use futures_util::{SinkExt as _, StreamExt as _};
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::Message;

async fn open_stream(
    port: u16,
    path: &str,
    origin: Option<&str>,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = format!("ws://127.0.0.1:{port}{path}")
        .into_client_request()
        .expect("build websocket request");
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", origin.parse().expect("origin header value"));
        request.headers_mut().insert(
            "sec-fetch-mode",
            "websocket".parse().expect("fetch mode header value"),
        );
    }
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("open KSP stream");
    socket
}

/// Send an `auth` frame and report whether the server accepted it.
async fn authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    credential: Option<&str>,
) -> bool {
    let frame = match credential {
        Some(credential) => serde_json::json!({ "type": "auth", "credential": credential }),
        None => serde_json::json!({ "type": "auth" }),
    };
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .expect("send auth frame");
    loop {
        match tokio::time::timeout(Duration::from_secs(10), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let parsed: serde_json::Value =
                    serde_json::from_str(&text).expect("decode server frame");
                match parsed.get("type").and_then(|value| value.as_str()) {
                    Some("auth_ok") => return true,
                    Some("error") => return false,
                    _ => continue,
                }
            }
            Ok(Some(Ok(_))) => continue,
            // A refusal may arrive as a close instead of an error frame.
            Ok(Some(Err(_)) | None) => return false,
            Err(_) => panic!("timed out waiting for the server's auth answer"),
        }
    }
}

#[tokio::test]
async fn a_browser_websocket_upgrade_must_prove_the_local_credential_in_band() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("browser-stream").await;
    let credential = server.credential().await;

    for path in ["/v1/stream", "/v2/stream"] {
        // No CORS layer constrains a WebSocket handshake, and a browser cannot
        // attach a header to one — so the credential is proved in band.
        let mut hostile = open_stream(server.port, path, Some("http://attacker.example")).await;
        assert!(
            !authenticate(&mut hostile, None).await,
            "an empty in-band credential must not authenticate a browser stream on {path}"
        );

        let mut guessing = open_stream(server.port, path, Some("http://attacker.example")).await;
        assert!(
            !authenticate(&mut guessing, Some(&"0".repeat(credential.len()))).await,
            "a guessed credential must not authenticate a browser stream on {path}"
        );

        let mut webview = open_stream(server.port, path, Some("tauri://localhost")).await;
        assert!(
            authenticate(&mut webview, Some(&credential)).await,
            "the desktop webview must authenticate on {path}"
        );
    }
}

#[tokio::test]
async fn a_local_process_websocket_upgrade_keeps_its_loopback_authority() {
    let _fixture_guard = PROCESS_FIXTURE_LOCK.lock().await;
    let server = launch_server("local-stream").await;

    for path in ["/v1/stream", "/v2/stream"] {
        let mut socket = open_stream(server.port, path, None).await;
        assert!(
            authenticate(&mut socket, None).await,
            "a non-browser loopback stream must keep empty in-band auth on {path}"
        );
    }
}
