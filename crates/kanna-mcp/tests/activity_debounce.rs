//! The activity debounce spans three processes: the daemon classifies a
//! terminal frame, `kanna-server` folds that verdict into `pipeline_item
//! .activity`, and `kanna-mcp` is what an orchestrator actually reads. A
//! smoother proven only against a mock server proves nothing about that chain,
//! so this test drives a real `kanna-server` process (real SQLite, real HTTP
//! surface) and a real `kanna-mcp` process (real stdio JSON-RPC, real catalog
//! routing).
//!
//! The daemon's verdict enters through `POST /v1/tasks/{id}/actions/runtime
//! -status`, which is the same `activity_for_runtime_status` transition the
//! terminal watcher applies to a daemon `StatusChanged` event. Cargo cannot
//! link a second crate's binary into this test, so the daemon → server half of
//! the hop is covered next to the watcher itself, by
//! `watcher_parks_activity_at_unread_for_a_single_spurious_idle_frame` in
//! `crates/kanna-server/src/terminal_watcher.rs`.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Mirrors `ACTIVITY_CONFIRM_DELAY` in `crates/kanna-mcp/src/main.rs`. A read
/// that engaged the confirmation cannot come back faster than this, which is
/// what lets these tests tell a debounced answer apart from a lucky one.
const ACTIVITY_CONFIRM_DELAY: Duration = Duration::from_millis(1_000);

const TASK_ID: &str = "task-debounce";

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

struct RunningServer {
    child: Child,
    _root: TestRoot,
    base_url: String,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct RunningMcp {
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

    let mut server = RunningServer {
        child,
        _root: root,
        base_url: format!("http://127.0.0.1:{port}"),
    };
    wait_for_server(&mut server).await;
    server
}

async fn wait_for_server(server: &mut RunningServer) {
    let client = reqwest::Client::new();
    let status_url = format!("{}/v1/status", server.base_url);
    let mut last_error = String::new();
    for _ in 0..200 {
        if let Some(status) = server.child.try_wait().expect("poll server process") {
            let mut stderr = String::new();
            if let Some(mut pipe) = server.child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("kanna-server exited with {status}: {stderr}");
        }
        match client.get(&status_url).send().await {
            Ok(response) if response.status().is_success() => return,
            Ok(response) => last_error = format!("HTTP {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("kanna-server never became ready: {last_error}");
}

async fn execute_sql(server: &RunningServer, sql: &str, params: Value) {
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

/// Seeds an open task that is mid-turn, which is the only state where a dropped
/// busy marker can do damage.
async fn seed_working_task(server: &RunningServer) {
    execute_sql(
        server,
        "INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
         VALUES (?, ?, ?, 'main', 0, 0, datetime('now'), datetime('now'))",
        json!(["repo-1", "/tmp/repo-activity-debounce", "Repo One"]),
    )
    .await;
    execute_sql(
        server,
        "INSERT INTO pipeline_item (
            id, repo_id, prompt, stage, branch, agent_type, activity,
            pinned, pin_order, display_name, created_at, updated_at, pipeline,
            initial_pipeline, agent_provider
         ) VALUES (?, 'repo-1', 'Debounce prompt', 'in progress', ?, 'pty', 'working',
                   0, NULL, 'Debounce task', datetime('now'), datetime('now'), 'default',
                   'default', 'claude')",
        json!([TASK_ID, format!("branch-{TASK_ID}")]),
    )
    .await;
}

/// Applies a daemon-derived terminal status the way the terminal watcher does
/// for a detached session, and returns the activity transition the server made
/// (`null` when the status changed nothing).
async fn apply_runtime_status(server: &RunningServer, status: &str) -> Value {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/tasks/{TASK_ID}/actions/runtime-status",
            server.base_url
        ))
        .json(&json!({ "status": status, "selected": false }))
        .send()
        .await
        .expect("send runtime status");
    assert!(
        response.status().is_success(),
        "runtime status failed: {}",
        response.text().await.unwrap_or_default()
    );
    response.json::<Value>().await.expect("runtime status json")
}

/// Reads the task straight off the server, bypassing the MCP layer, so a test
/// can assert what the stored activity was before the debounce saw it.
async fn stored_activity(server: &RunningServer) -> String {
    let task = reqwest::Client::new()
        .get(format!("{}/v1/tasks/{TASK_ID}", server.base_url))
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
    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write mcp message");
        self.stdin.flush().expect("flush mcp stdin");
    }

    fn recv(&self) -> Value {
        self.responses
            .recv_timeout(Duration::from_secs(20))
            .expect("mcp response line")
    }

    fn call_get_task(&mut self, id: i64) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": "kanna_get_task", "arguments": { "task_id": TASK_ID } }
        }));
    }

    fn recv_task(&self) -> Value {
        let response = self.recv();
        assert!(response.get("error").is_none(), "{response}");
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text");
        assert_ne!(
            response["result"]["isError"],
            json!(true),
            "kanna_get_task failed: {text}"
        );
        serde_json::from_str(text).expect("task json")
    }
}

#[tokio::test]
async fn a_spurious_idle_frame_between_busy_frames_is_not_reported_as_a_stopped_agent() {
    let server = launch_server("spurious-idle").await;
    seed_working_task(&server).await;
    let mut mcp = launch_mcp(&server);

    // The dropped busy marker: one frame classified idle while the agent is
    // mid-turn, which the server stores as a stopped-looking activity.
    assert_eq!(
        apply_runtime_status(&server, "idle").await["activity"],
        json!("unread")
    );
    assert_eq!(stored_activity(&server).await, "unread");

    let started = Instant::now();
    mcp.call_get_task(2);
    // The agent was never idle: the next frame carries the marker again, well
    // inside the confirmation window.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        apply_runtime_status(&server, "busy").await["activity"],
        json!("working"),
        "the stored activity must still have been the spurious stop when the read started"
    );
    let task = mcp.recv_task();
    let elapsed = started.elapsed();

    assert_eq!(
        task["activity"],
        json!("working"),
        "a single mid-redraw frame must not surface as a stopped agent"
    );
    assert!(
        elapsed >= ACTIVITY_CONFIRM_DELAY,
        "the answer must have come from a confirmation read, not from a lucky first read (took {elapsed:?})"
    );
}

#[tokio::test]
async fn a_genuine_stop_is_reported_within_the_confirmation_delay() {
    let server = launch_server("genuine-stop").await;
    seed_working_task(&server).await;
    let mut mcp = launch_mcp(&server);

    assert_eq!(
        apply_runtime_status(&server, "idle").await["activity"],
        json!("unread")
    );

    let started = Instant::now();
    mcp.call_get_task(2);
    let task = mcp.recv_task();
    let elapsed = started.elapsed();

    assert_eq!(
        task["activity"],
        json!("unread"),
        "a stop that holds keeps its own activity value: {task}"
    );
    assert!(
        elapsed >= ACTIVITY_CONFIRM_DELAY,
        "a stop is only reported after it is confirmed (took {elapsed:?})"
    );
    assert!(
        elapsed < ACTIVITY_CONFIRM_DELAY * 5,
        "the debounce must stay a small, bounded cost (took {elapsed:?})"
    );
}
