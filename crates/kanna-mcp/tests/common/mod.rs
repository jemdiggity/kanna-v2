//! A real three-process chain for `kanna-mcp` integration tests: a fixture on
//! the daemon's own socket, a real `kanna-server` process (real SQLite, real
//! HTTP surface), and a real `kanna-mcp` process (real stdio JSON-RPC, real
//! catalog routing).
//!
//! Behaviour that only ever meets a mock server is not proven at all — the
//! defects these tests exist for live in the asynchronous
//! daemon → server → SQLite → HTTP → MCP path, so that whole path is what runs
//! here. Nothing touches `crates/daemon`: the fixture classifies nothing, it
//! replays the frame verdicts a test stages, which is the only way to stage an
//! exact sequence such as the Busy → Idle → Busy of a mid-redraw misread.
//! Everything downstream is real.
//!
//! The server will not open its HTTP listeners until the protected-input
//! generation is negotiated over the daemon socket, so [`start_chain`] is the
//! entry point even for tests that never stage a frame verdict.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Cross-process readiness is eventual. This deadline only contains a fixture
/// process that has exited or can no longer make progress.
pub const EVENTUAL_PROGRESS_GUARD: Duration = Duration::from_secs(30);

/// Mirrors `ACTIVITY_CONFIRM_DELAY` in `crates/kanna-mcp/src/main.rs`. A read
/// that engaged the confirmation cannot come back faster than this, which is
/// what lets tests tell a debounced answer apart from a lucky one.
pub const ACTIVITY_CONFIRM_DELAY: Duration = Duration::from_millis(1_000);

/// A throwaway directory for one server's config, database, and daemon
/// directory, removed with the server it belongs to.
struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kanna-mcp-activity-debounce-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create server test root");
        Self { path }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub struct RunningServer {
    child: Child,
    _root: TestRoot,
    pub base_url: String,
    daemon_dir: PathBuf,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct RunningMcp {
    child: Child,
    stdin: std::process::ChildStdin,
    responses: mpsc::Receiver<Value>,
}

impl Drop for RunningMcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `cargo test` builds every selected package's binaries before running any
/// test, so the workspace lane (`./kd test rust`) always has this sibling.
/// Building it here instead would nest a cargo invocation inside a cargo
/// invocation, so a missing binary is reported rather than papered over.
fn kanna_server_binary() -> PathBuf {
    let path = Path::new(env!("CARGO_BIN_EXE_kanna-mcp"))
        .parent()
        .expect("kanna-mcp binary directory")
        .join("kanna-server");
    assert!(
        path.exists(),
        "kanna-server binary is missing at {}; this test drives the real server, \
         so run `cargo test --workspace` or `cargo build -p kanna-server` first",
        path.display()
    );
    path
}

fn toml_string(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

async fn launch_server(label: &str) -> RunningServer {
    let lan = TcpListener::bind(("127.0.0.1", 0)).expect("reserve LAN port");
    let transfer = TcpListener::bind(("127.0.0.1", 0)).expect("reserve transfer port");
    let port = lan.local_addr().expect("lan addr").port();
    let transfer_port = transfer.local_addr().expect("transfer addr").port();

    let root = TestRoot::new(label);
    let daemon_dir = root.path.join("daemon");
    std::fs::create_dir_all(&daemon_dir).expect("create daemon directory");
    let config_path = root.path.join("server.toml");
    std::fs::write(
        &config_path,
        format!(
            "relay_url = \"\"\n\
             device_token = \"\"\n\
             firebase_project_id = \"kanna-local\"\n\
             daemon_dir = \"{}\"\n\
             db_path = \"{}\"\n\
             desktop_id = \"desktop-activity-debounce\"\n\
             desktop_secret = \"test-secret\"\n\
             desktop_name = \"Activity Debounce\"\n\
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

    drop(lan);
    drop(transfer);
    let child = Command::new(kanna_server_binary())
        .env("KANNA_SERVER_CONFIG", &config_path)
        .env("KANNA_E2E_TEST_SQL", "1")
        .env("RUST_LOG", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch kanna-server");

    RunningServer {
        child,
        _root: root,
        base_url: format!("http://127.0.0.1:{port}"),
        daemon_dir,
    }
}

async fn wait_for_server(server: &mut RunningServer) {
    let client = reqwest::Client::new();
    let status_url = format!("{}/v1/status", server.base_url);
    let deadline = Instant::now() + EVENTUAL_PROGRESS_GUARD;
    loop {
        if let Some(status) = server.child.try_wait().expect("poll server process") {
            let mut stderr = String::new();
            if let Some(mut pipe) = server.child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("kanna-server exited with {status}: {stderr}");
        }
        let last_error = match client.get(&status_url).send().await {
            Ok(response) if response.status().is_success() => return,
            Ok(response) => format!("HTTP {}", response.status()),
            Err(error) => error.to_string(),
        };
        assert!(
            Instant::now() < deadline,
            "kanna-server never became ready within the hang-containment guard: {last_error}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn execute_sql(server: &RunningServer, sql: &str, params: Value) {
    let response = reqwest::Client::new()
        .post(format!("{}/v1/e2e/sql", server.base_url))
        .json(&json!({ "sql": sql, "params": params, "query": false }))
        .send()
        .await
        .expect("send e2e sql");
    assert!(
        response.status().is_success(),
        "e2e sql failed: {}",
        response.text().await.unwrap_or_default()
    );
}

/// Seeds the repository every seeded task hangs off. Idempotent per server.
async fn seed_repo(server: &RunningServer) {
    execute_sql(
        server,
        "INSERT OR IGNORE INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
         VALUES (?, ?, ?, 'main', 0, 0, datetime('now'), datetime('now'))",
        json!(["repo-1", "/tmp/repo-kanna-mcp-tests", "Repo One"]),
    )
    .await;
}

/// Seeds an open task sitting at `activity`, with no stage run yet.
pub async fn seed_task(server: &RunningServer, task_id: &str, activity: &str) {
    seed_repo(server).await;
    execute_sql(
        server,
        "INSERT INTO pipeline_item (
            id, repo_id, prompt, stage, branch, agent_type, activity,
            pinned, pin_order, display_name, created_at, updated_at, pipeline,
            initial_pipeline, agent_provider
         ) VALUES (?, 'repo-1', 'Test prompt', 'in progress', ?, 'pty', ?,
                   0, NULL, 'Test task', datetime('now'), datetime('now'), 'default',
                   'default', 'claude')",
        json!([task_id, format!("branch-{task_id}"), activity]),
    )
    .await;
}

/// Seeds an open task that is mid-turn, which is the only state where a dropped
/// busy marker can do damage.
pub async fn seed_working_task(server: &RunningServer, task_id: &str) {
    seed_task(server, task_id, "working").await;
}

/// Records a stage run against a task, exactly as the engine's own writes leave
/// it: a terminal `status` carries a `finished_at`, a live one does not.
pub async fn seed_stage_run(server: &RunningServer, task_id: &str, run_id: &str, status: &str) {
    let finished = matches!(status, "succeeded" | "failed" | "cancelled");
    execute_sql(
        server,
        "INSERT INTO stage_run (id, task_id, stage, kind, agent, status, result, started_at, finished_at)
         VALUES (?, ?, 'in progress', 'main', 'review-security', ?, ?, datetime('now'),
                 CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)",
        json!([
            run_id,
            task_id,
            status,
            json!({ "status": status, "summary": "seeded verdict" }).to_string(),
            i32::from(finished),
        ]),
    )
    .await;
}

/// Reads the task straight off the server, bypassing the MCP layer, so a test
/// can assert what the stored activity was before the debounce saw it.
pub async fn stored_activity(server: &RunningServer, task_id: &str) -> String {
    let task = reqwest::Client::new()
        .get(format!("{}/v1/tasks/{task_id}", server.base_url))
        .send()
        .await
        .expect("get task")
        .json::<Value>()
        .await
        .expect("task json");
    task["activity"]
        .as_str()
        .expect("task activity")
        .to_string()
}

/// The runtime dimension as the server reports it, straight off the HTTP
/// surface. `Value::Null` before any session has been classified.
pub async fn stored_runtime_state(server: &RunningServer, task_id: &str) -> Value {
    let task = reqwest::Client::new()
        .get(format!("{}/v1/tasks/{task_id}", server.base_url))
        .send()
        .await
        .expect("get task")
        .json::<Value>()
        .await
        .expect("task json");
    task["runtimeState"].clone()
}

/// Daemon events are applied by the watcher on its own task, so a test that
/// wants to act on a stored runtime state has to wait for it rather than
/// assume the write already landed.
pub async fn await_stored_runtime_state(server: &RunningServer, task_id: &str, expected: &str) {
    let deadline = Instant::now() + EVENTUAL_PROGRESS_GUARD;
    loop {
        if stored_runtime_state(server, task_id).await == json!(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "runtimeState never became {expected}; it is {}",
            stored_runtime_state(server, task_id).await
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Daemon events are applied by the watcher on its own task, so a test that
/// wants to act on a stored activity has to wait for it rather than assume the
/// write already landed.
pub async fn await_stored_activity(server: &RunningServer, task_id: &str, expected: &str) {
    let deadline = Instant::now() + EVENTUAL_PROGRESS_GUARD;
    loop {
        if stored_activity(server, task_id).await == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "activity never became {expected}; it is {}",
            stored_activity(server, task_id).await
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The daemon socket path for a daemon directory.
///
/// This mirrors `kanna_runtime_defaults::socket_path`, which is how
/// `kanna-server` finds the daemon. kanna-mcp does not depend on that crate,
/// and adding a dependency for a test-only helper would force a bazel
/// crate-universe repin of `crates/kanna-mcp/Cargo.lock`. If the two ever
/// diverge the server simply never connects here, and the subscribe handshake
/// below times out with that message.
fn daemon_socket_path(daemon_dir: &Path) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    daemon_dir.to_path_buf().hash(&mut hasher);
    let hash = hasher.finish() as u32;
    // The directory is part of the mirror too: macOS has no per-user runtime
    // directory so these sockets live in `/tmp`, while on Linux they go in
    // `$XDG_RUNTIME_DIR` when the session manager provides one, because a
    // shared `/tmp` socket path is pre-creatable by any local user there.
    let dir = match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        Some(runtime_dir) if !cfg!(target_os = "macos") && runtime_dir.is_absolute() => runtime_dir,
        _ => PathBuf::from("/tmp"),
    };
    dir.join(format!("kanna-{hash:08x}.sock"))
}

/// A stand-in for the PTY daemon that speaks its wire protocol: it establishes
/// the protected-input generation required before the server opens its HTTP
/// listeners, answers the watcher's `Subscribe` and control `List` commands,
/// then pushes `StatusChanged` events on the subscription. It classifies
/// nothing — the verdicts come from the test, which is what lets a test stage
/// the exact frame sequence a real misread produces. `crates/daemon` is not
/// involved.
pub struct FakeDaemon {
    events: mpsc::Sender<String>,
    subscribed: mpsc::Receiver<()>,
    socket_path: PathBuf,
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

impl FakeDaemon {
    /// Pushes the daemon's verdict for one rendered frame of a task's session.
    pub fn classify(&self, task_id: &str, status: &str) {
        self.events
            .send(format!(
                "{{\"type\":\"StatusChanged\",\"session_id\":\"{task_id}\",\"status\":\"{status}\"}}"
            ))
            .expect("send status event");
    }

    /// Ends a task's agent session the way a real one ends when the process
    /// exits on its own: not an orchestrated `Kill`, so the server treats it
    /// as the session terminating rather than being replaced.
    pub fn exit(&self, task_id: &str, code: i32) {
        self.events
            .send(format!(
                "{{\"type\":\"Exit\",\"session_id\":\"{task_id}\",\"code\":{code},\
                 \"resume_session_id\":null,\"killed\":false}}"
            ))
            .expect("send exit event");
    }

    pub fn await_subscription(&self) {
        self.subscribed
            .recv_timeout(Duration::from_secs(30))
            .expect(
                "kanna-server never completed the daemon subscribe/list handshake; \
                 if kanna_runtime_defaults::socket_path changed, daemon_socket_path here \
                 must change with it",
            );
    }
}

fn spawn_fake_daemon(daemon_dir: &Path) -> FakeDaemon {
    let socket_path = daemon_socket_path(daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
    let (events, event_queue) = mpsc::channel::<String>();
    let (handshake_done, subscribed) = mpsc::channel::<()>();

    thread::spawn(move || {
        // Production starts the terminal watcher before the protected-input
        // startup gate, so either connection can win the race. Accept both
        // lifecycles in their natural order while requiring every command.
        let mut generation_ready = None;
        let mut geometry_ready = false;
        let mut watcher_listed = false;
        let mut subscription = None;
        while generation_ready.is_none()
            || !geometry_ready
            || !watcher_listed
            || subscription.is_none()
        {
            let (mut connection, _) = listener.accept().expect("accept daemon connection");
            let mut reader =
                BufReader::new(connection.try_clone().expect("clone daemon connection"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("read daemon command");

            if line.contains("NegotiateProtectedInput") {
                assert!(
                    generation_ready.is_none(),
                    "duplicate protected-input negotiation"
                );
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
                // Hold the connection for the rest of the fixture's life. A
                // real daemon does not hang up after negotiating, and the
                // server reads a closed generation connection as "this daemon
                // has been replaced" and negotiates with its successor.
                generation_ready = Some(connection);
            } else if line.contains("NegotiateTerminalGeometry") {
                assert!(
                    generation_ready.is_some(),
                    "terminal geometry negotiated before protected-input setup"
                );
                assert!(!geometry_ready, "duplicate terminal geometry negotiation");
                writeln!(
                    connection,
                    "{{\"type\":\"TerminalGeometryReady\",\"version\":1}}",
                )
                .expect("acknowledge terminal geometry negotiation");
                geometry_ready = true;
            } else if line.contains("Subscribe") {
                assert!(subscription.is_none(), "duplicate subscription");
                writeln!(connection, "{{\"type\":\"Ok\"}}").expect("acknowledge subscribe");
                subscription = Some(connection);
            } else {
                assert!(line.contains("List"), "expected daemon command, got {line}");
                assert!(!watcher_listed, "duplicate watcher list");
                writeln!(connection, "{{\"type\":\"SessionList\",\"sessions\":[]}}")
                    .expect("answer watcher list");
                watcher_listed = true;
            }
        }

        let _generation = generation_ready.expect("protected-input generation established");
        let mut subscription = subscription.expect("subscription established");
        if handshake_done.send(()).is_err() {
            return;
        }

        while let Ok(event) = event_queue.recv() {
            if writeln!(subscription, "{event}").is_err() {
                return;
            }
        }
    });

    FakeDaemon {
        events,
        subscribed,
        socket_path,
    }
}

fn launch_mcp(server: &RunningServer) -> RunningMcp {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kanna-mcp"))
        .args(["serve", "--server-url", &server.base_url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn kanna-mcp");
    let stdout = child.stdout.take().expect("mcp stdout");
    let (sender, responses) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                return;
            };
            if sender.send(value).is_err() {
                return;
            }
        }
    });
    let stdin = child.stdin.take().expect("mcp stdin");
    let mut mcp = RunningMcp {
        child,
        stdin,
        responses,
    };
    // Draining `initialize` first keeps process startup out of the timings the
    // tests below measure.
    mcp.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }));
    let initialized = mcp.recv();
    assert_eq!(initialized["result"]["serverInfo"]["name"], "kanna-mcp");
    mcp
}

impl RunningMcp {
    pub fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write mcp message");
        self.stdin.flush().expect("flush mcp stdin");
    }

    pub fn recv(&self) -> Value {
        self.recv_within(Duration::from_secs(20))
    }

    /// A wait tool is allowed to block for its whole window, so a test that
    /// calls one needs a receive budget longer than that window.
    pub fn recv_within(&self, timeout: Duration) -> Value {
        self.responses
            .recv_timeout(timeout)
            .expect("mcp response line")
    }

    pub fn call_tool(&mut self, id: i64, name: &str, arguments: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }));
    }

    pub fn call_get_task(&mut self, id: i64, task_id: &str) {
        self.call_tool(id, "kanna_get_task", json!({ "task_id": task_id }));
    }

    pub fn recv_task(&self) -> Value {
        self.recv_task_within(Duration::from_secs(20))
    }

    pub fn recv_task_within(&self, timeout: Duration) -> Value {
        let response = self.recv_within(timeout);
        assert!(response.get("error").is_none(), "{response}");
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text");
        assert_ne!(
            response["result"]["isError"],
            json!(true),
            "tool call failed: {text}"
        );
        serde_json::from_str(text).expect("tool result json")
    }
}

/// Brings up the whole chain — fake daemon on the real daemon socket, real
/// kanna-server, real kanna-mcp — with nothing seeded. The daemon fixture is
/// not optional even for tests that stage no frame verdicts: the server holds
/// its HTTP listeners closed until the protected-input generation is
/// negotiated over that socket.
pub async fn start_bare_chain(label: &str) -> (RunningServer, FakeDaemon, RunningMcp) {
    let mut server = launch_server(label).await;
    let daemon = spawn_fake_daemon(&server.daemon_dir);
    wait_for_server(&mut server).await;
    daemon.await_subscription();
    let mcp = launch_mcp(&server);
    (server, daemon, mcp)
}

/// [`start_bare_chain`] with `task_id` already seeded mid-turn, which is the
/// only state where a dropped busy marker can do damage.
pub async fn start_chain(label: &str, task_id: &str) -> (RunningServer, FakeDaemon, RunningMcp) {
    let mut server = launch_server(label).await;
    let daemon = spawn_fake_daemon(&server.daemon_dir);
    wait_for_server(&mut server).await;
    daemon.await_subscription();
    seed_working_task(&server, task_id).await;
    let mcp = launch_mcp(&server);

    daemon.classify(task_id, "busy");
    await_stored_activity(&server, task_id, "working").await;
    (server, daemon, mcp)
}
