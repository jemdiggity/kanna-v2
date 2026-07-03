//! Integration tests for daemon handoff (session transfer on upgrade).
//!
//! These tests spawn real daemon processes and verify that:
//!   - New daemon takes over sessions from old daemon
//!   - Child processes survive the transfer
//!   - I/O works through the new daemon after handoff
//!   - Handoff with no active sessions works
//!   - Old daemon exits after handoff

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---- Protocol types ----

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum Cmd {
    Spawn {
        session_id: String,
        executable: String,
        args: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    },
    AttachSnapshot {
        session_id: String,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    Snapshot {
        session_id: String,
    },
    List,
    Subscribe,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionStatus {
    Busy,
    Waiting,
    Idle,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    SessionNotFound,
    SessionAlreadyExists,
    HandoffLost,
    HandoffVersionMismatch,
    PtySpawnFailed,
    PtyCloneFailed,
    HeadlessTerminalInitFailed,
    WriteFailed,
    UnknownSignal,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Evt {
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    Exit {
        session_id: String,
        code: i32,
    },
    SessionCreated {
        session_id: String,
    },
    SessionList {
        sessions: Vec<Value>,
    },
    Snapshot {
        session_id: String,
        snapshot: SnapshotPayload,
    },
    StatusChanged {
        session_id: String,
        status: SessionStatus,
    },
    Ok,
    Error {
        code: Option<ErrorCode>,
        message: String,
    },
    ShuttingDown,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct SnapshotPayload {
    version: u32,
    rows: u16,
    cols: u16,
    cursor_row: u16,
    cursor_col: u16,
    cursor_visible: bool,
    vt: String,
}

// ---- Test harness ----

/// Compute the socket path using the same hash the daemon uses.
fn compute_socket_path(dir: &Path) -> PathBuf {
    kanna_runtime_defaults::socket_path(dir)
}

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
}

impl DaemonHandle {
    /// Start a daemon in the given directory. If a daemon is already running
    /// there (from a previous start), the new one will attempt handoff.
    fn start_in(dir: &PathBuf) -> Self {
        std::fs::create_dir_all(dir).unwrap();

        let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");

        let child = Command::new(&daemon_bin)
            .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
            .spawn()
            .expect("failed to start daemon");

        let expected_pid = child.id();

        // Wait for this specific daemon to be ready (PID file matches + socket works)
        for _ in 0..100 {
            if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    if pid == expected_pid && UnixStream::connect(&socket_path).is_ok() {
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // Verify our daemon is running
        let actual_pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        assert_eq!(actual_pid, expected_pid, "PID file should match our daemon");

        DaemonHandle { child, socket_path }
    }

    fn connect(&self) -> ClientConn {
        let stream = UnixStream::connect(&self.socket_path).expect("failed to connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        ClientConn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl ClientConn {
    fn send(&mut self, cmd: &Cmd) {
        let mut json = serde_json::to_string(cmd).unwrap();
        json.push('\n');
        self.writer.write_all(json.as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    fn recv(&mut self) -> Evt {
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read timed out");
        serde_json::from_str(line.trim())
            .unwrap_or_else(|e| panic!("failed to parse: {} — {:?}", e, line.trim()))
    }

    fn drain_output(&mut self, timeout: Duration) -> Vec<u8> {
        self.writer.set_read_timeout(Some(timeout)).unwrap();
        let mut collected = Vec::new();
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(Evt::Output { data, .. }) = serde_json::from_str(line.trim()) {
                        collected.extend_from_slice(&data);
                    }
                }
                Err(_) => break,
            }
        }
        self.writer
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        collected
    }
}

fn spawn_echo(conn: &mut ClientConn, id: &str) {
    conn.send(&Cmd::Spawn {
        session_id: id.to_string(),
        executable: "/bin/cat".to_string(),
        args: vec![],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });
    match conn.recv() {
        Evt::SessionCreated { .. } => {}
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
}

fn attach(conn: &mut ClientConn, id: &str) {
    conn.send(&Cmd::AttachSnapshot {
        session_id: id.to_string(),
    });
    loop {
        match conn.recv() {
            Evt::Snapshot { .. } => break,
            Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => panic!("attach failed: {:?}: {}", code, message),
            other => panic!("expected Snapshot, got: {:?}", other),
        }
    }
}

fn send_input(conn: &mut ClientConn, id: &str, data: &[u8]) -> Vec<u8> {
    conn.send(&Cmd::Input {
        session_id: id.to_string(),
        data: data.to_vec(),
    });
    let mut output = Vec::new();
    loop {
        match conn.recv() {
            Evt::Ok => break output,
            Evt::Output { data, .. } => output.extend_from_slice(&data),
            Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => panic!("input failed: {:?}: {}", code, message),
            other => panic!("expected Ok, got: {:?}", other),
        }
    }
}

fn send_input_and_wait_for_echo(conn: &mut ClientConn, id: &str, data: &[u8], expected: &str) {
    let mut output = send_input(conn, id, data);
    while !String::from_utf8_lossy(&output).contains(expected) {
        match conn.recv() {
            Evt::Output { data, .. } => output.extend_from_slice(&data),
            Evt::StatusChanged { .. } => continue,
            Evt::Exit { .. } => break,
            other => panic!(
                "expected Output while waiting for {:?}, got: {:?}",
                expected, other
            ),
        }
    }
    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains(expected),
        "expected output {:?}, got: {:?}",
        expected,
        output_str
    );
}

fn request_snapshot(conn: &mut ClientConn, id: &str) -> SnapshotPayload {
    conn.send(&Cmd::Snapshot {
        session_id: id.to_string(),
    });
    loop {
        match conn.recv() {
            Evt::Snapshot {
                session_id,
                snapshot,
            } => {
                assert_eq!(session_id, id);
                break snapshot;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => panic!("snapshot failed: {:?}: {}", code, message),
            other => panic!("expected Snapshot, got: {:?}", other),
        }
    }
}

fn test_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "kanna-handoff-test-{}-{}",
        name,
        std::process::id()
    ))
}

fn cleanup(dir: &PathBuf) {
    let _ = std::fs::remove_file(compute_socket_path(dir));
    let _ = std::fs::remove_dir_all(dir);
}

struct FakeOldDaemon {
    requests: Arc<Mutex<Vec<u32>>>,
    handle: Option<JoinHandle<()>>,
}

impl FakeOldDaemon {
    fn start(
        dir: &PathBuf,
        handler: impl Fn(UnixStream, Arc<Mutex<Vec<u32>>>) + Send + 'static,
    ) -> Self {
        cleanup(dir);
        std::fs::create_dir_all(dir).unwrap();
        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");
        let _ = std::fs::remove_file(&socket_path);
        std::fs::write(&pid_path, std::process::id().to_string()).unwrap();
        let listener = UnixListener::bind(&socket_path).expect("failed to bind fake daemon socket");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = requests.clone();
        let handle = std::thread::spawn(move || {
            handler(
                listener
                    .accept()
                    .expect("fake daemon should receive first handoff request")
                    .0,
                requests_for_thread.clone(),
            );
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        handler(stream, requests_for_thread);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("fake daemon accept failed: {}", error),
                }
            }
        });
        Self {
            requests,
            handle: Some(handle),
        }
    }

    fn request_versions(&self) -> Vec<u32> {
        self.requests.lock().unwrap().clone()
    }

    fn join(mut self) -> Vec<u32> {
        if let Some(handle) = self.handle.take() {
            handle.join().expect("fake daemon thread panicked");
        }
        self.request_versions()
    }
}

impl Drop for FakeOldDaemon {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn read_handoff_version(stream: &mut UnixStream) -> u32 {
    let mut line = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut line)
        .expect("failed to read handoff request");
    let value: Value = serde_json::from_str(line.trim()).expect("invalid handoff command json");
    assert_eq!(value["type"], "Handoff");
    value["version"].as_u64().expect("missing handoff version") as u32
}

fn write_event_line(stream: &mut UnixStream, value: Value) {
    let mut line = serde_json::to_string(&value).unwrap();
    line.push('\n');
    stream.write_all(line.as_bytes()).unwrap();
    stream.flush().unwrap();
}

fn unique_session_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{}-{}-{}", prefix, std::process::id(), nanos)
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => return None,
            Err(error) => panic!("failed to wait for daemon child: {}", error),
        }
    }
}

// ---- Tests ----

#[test]
fn test_version_exits_without_handoff_or_socket() {
    let dir = test_dir("version-no-handoff");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("daemon.pid"), std::process::id().to_string()).unwrap();

    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
    let output = Command::new(&daemon_bin)
        .arg("--version")
        .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
        .output()
        .expect("failed to run daemon --version");

    assert!(
        output.status.success(),
        "--version should exit successfully"
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("kanna-daemon"),
        "--version should print daemon identity, stdout={:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        !compute_socket_path(&dir).exists(),
        "--version must not bind or touch the daemon socket"
    );

    cleanup(&dir);
}

/// If the old daemon accepts the v2 handoff command and then drops the
/// connection, the new daemon cannot know whether sessions were detached.
/// It must not send a second compat handoff request or start a competing
/// daemon while the old daemon is still alive.
#[test]
fn test_handoff_ambiguous_post_send_failure_exits_without_split_brain() {
    let dir = test_dir("ambiguous-no-retry");
    let fake = FakeOldDaemon::start(&dir, |mut stream, requests| {
        let version = read_handoff_version(&mut stream);
        requests.lock().unwrap().push(version);
        drop(stream);
    });

    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
    let mut child = Command::new(&daemon_bin)
        .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
        .spawn()
        .expect("failed to start daemon");
    let status = wait_for_child_exit(&mut child, Duration::from_secs(5))
        .expect("ambiguous handoff must exit instead of starting");
    assert!(
        !status.success(),
        "ambiguous handoff should fail loudly instead of starting fresh"
    );

    let requests = fake.join();
    assert_eq!(
        requests,
        vec![2],
        "ambiguous failure after sending Handoff must not retry compat"
    );

    cleanup(&dir);
}

#[test]
fn test_interrupted_handoff_leaves_old_daemon_session_usable() {
    let dir = test_dir("interrupted-old-usable");
    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();
    spawn_echo(&mut conn_a, "sess-interrupted");
    attach(&mut conn_a, "sess-interrupted");
    send_input_and_wait_for_echo(
        &mut conn_a,
        "sess-interrupted",
        b"before-interrupt\n",
        "before-interrupt",
    );

    let socket_path = compute_socket_path(&dir);
    let mut handoff = UnixStream::connect(&socket_path).expect("connect to old daemon");
    let request = serde_json::json!({ "type": "Handoff", "version": 2 });
    writeln!(handoff, "{}", serde_json::to_string(&request).unwrap()).unwrap();
    handoff.flush().unwrap();
    let mut reader = BufReader::new(handoff.try_clone().unwrap());
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("old daemon should send handoff metadata");
    assert!(
        line.contains("HandoffReady"),
        "expected HandoffReady, got {line:?}"
    );
    drop(handoff);

    send_input_and_wait_for_echo(
        &mut conn_a,
        "sess-interrupted",
        b"after-interrupt\n",
        "after-interrupt",
    );

    drop(daemon_a);
    cleanup(&dir);
}

/// If the new daemon receives session metadata but the SCM_RIGHTS fd transfer
/// fails while the old daemon is still alive, it must not bind a competing
/// daemon over the same app state.
#[test]
fn test_handoff_fd_transfer_failure_exits_without_split_brain() {
    let dir = test_dir("fd-transfer-lost");
    let lost_session_id = unique_session_id("lost-session");
    let fake_session_id = lost_session_id.clone();
    let fake = FakeOldDaemon::start(&dir, move |mut stream, requests| {
        let version = read_handoff_version(&mut stream);
        requests.lock().unwrap().push(version);
        write_event_line(
            &mut stream,
            serde_json::json!({
                "type": "HandoffReady",
                "sessions": [{
                    "session_id": fake_session_id,
                    "pid": std::process::id(),
                    "cwd": "/tmp",
                    "rows": 24,
                    "cols": 80,
                    "snapshot": {
                        "version": 1,
                        "rows": 24,
                        "cols": 80,
                        "cursor_row": 0,
                        "cursor_col": 0,
                        "cursor_visible": true,
                        "saved_at": 0,
                        "sequence": 0,
                        "vt": "metadata survived handoff failure"
                    },
                    "status": "idle"
                }]
            }),
        );
        drop(stream);
    });

    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
    let mut child = Command::new(&daemon_bin)
        .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
        .spawn()
        .expect("failed to start daemon");
    let status = wait_for_child_exit(&mut child, Duration::from_secs(5))
        .expect("fd transfer failure must exit instead of starting");
    assert!(
        !status.success(),
        "fd transfer failure should fail loudly instead of starting fresh"
    );

    let requests = fake.join();
    assert_eq!(
        requests,
        vec![2],
        "fd transfer failure after metadata must not retry compat"
    );

    cleanup(&dir);
}

/// Explicit protocol version mismatch is the safe case for falling back to the
/// compat handoff version.
#[test]
fn test_handoff_explicit_version_mismatch_retries_compat() {
    let dir = test_dir("version-mismatch-compat");
    let fake = FakeOldDaemon::start(&dir, |mut stream, requests| {
        let version = read_handoff_version(&mut stream);
        requests.lock().unwrap().push(version);
        if version == 2 {
            write_event_line(
                &mut stream,
                serde_json::json!({
                    "type": "Error",
                    "code": "handoff_version_mismatch",
                    "message": "handoff version mismatch: expected 1, got 2"
                }),
            );
        } else {
            write_event_line(
                &mut stream,
                serde_json::json!({
                    "type": "HandoffReady",
                    "sessions": []
                }),
            );
        }
    });

    let daemon = DaemonHandle::start_in(&dir);
    let requests = fake.join();
    assert_eq!(
        requests,
        vec![2, 1],
        "explicit version mismatch should retry exactly once with compat"
    );

    let mut conn = daemon.connect();
    spawn_echo(&mut conn, "fresh-after-compat-fallback");
    attach(&mut conn, "fresh-after-compat-fallback");

    drop(daemon);
    cleanup(&dir);
}

/// Handoff transfers a live session to the new daemon.
/// Child process (/bin/cat) survives and I/O works through daemon B.
#[test]
fn test_handoff_transfers_session() {
    let dir = test_dir("transfer");

    // Daemon A: spawn a session
    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();
    spawn_echo(&mut conn_a, "sess-handoff");
    attach(&mut conn_a, "sess-handoff");
    send_input(&mut conn_a, "sess-handoff", b"before\n");
    conn_a.drain_output(Duration::from_millis(500));

    // Daemon B: starts in same dir, triggers handoff from A
    drop(conn_a); // Close client connection to A
    let daemon_b = DaemonHandle::start_in(&dir);
    // start_in waits for B's PID in the PID file, so A is already gone

    // Connect to B and attach to the handed-off session
    let mut conn_b = daemon_b.connect();
    attach(&mut conn_b, "sess-handoff");

    // Send input — should work through daemon B
    send_input_and_wait_for_echo(
        &mut conn_b,
        "sess-handoff",
        b"after-handoff\n",
        "after-handoff",
    );

    drop(daemon_b);
    cleanup(&dir);
}

/// If snapshot generation fails during handoff, the live PTY should still move
/// to the new daemon and remain interactive.
#[test]
fn test_handoff_keeps_live_session_when_snapshot_fails() {
    let dir = test_dir("snapshot-failure");

    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();

    conn_a.send(&Cmd::Spawn {
        session_id: "sess-degraded".to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf '\\033[?2026h'; exec /bin/cat".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });
    match conn_a.recv() {
        Evt::SessionCreated { .. } => {}
        other => panic!("expected SessionCreated, got: {:?}", other),
    }

    attach(&mut conn_a, "sess-degraded");
    conn_a.drain_output(Duration::from_millis(500));
    drop(conn_a);

    let daemon_b = DaemonHandle::start_in(&dir);
    let mut conn_b = daemon_b.connect();
    attach(&mut conn_b, "sess-degraded");
    send_input_and_wait_for_echo(
        &mut conn_b,
        "sess-degraded",
        b"after-handoff\n",
        "after-handoff",
    );

    let snapshot = request_snapshot(&mut conn_b, "sess-degraded");
    assert_eq!(snapshot.version, 1);
    assert_eq!(snapshot.rows, 24);
    assert_eq!(snapshot.cols, 80);
    assert!(snapshot.cursor_visible);
    assert!(
        snapshot.vt.contains("after-handoff"),
        "degraded session should start recovery mirroring after adoption, got: {:?}",
        snapshot.vt
    );
    let _cursor = (snapshot.cursor_row, snapshot.cursor_col);

    drop(conn_b);
    let daemon_c = DaemonHandle::start_in(&dir);
    let mut conn_c = daemon_c.connect();
    attach(&mut conn_c, "sess-degraded");
    send_input_and_wait_for_echo(
        &mut conn_c,
        "sess-degraded",
        b"after-second-handoff\n",
        "after-second-handoff",
    );

    drop(daemon_c);
    cleanup(&dir);
}

/// Handoff with no active sessions — new daemon starts fresh.
#[test]
fn test_handoff_empty() {
    let dir = test_dir("empty");

    let _daemon_a = DaemonHandle::start_in(&dir);
    // Don't create any sessions

    // Daemon B: handoff with no sessions
    let daemon_b = DaemonHandle::start_in(&dir);

    // B should work for new sessions
    let mut conn = daemon_b.connect();
    spawn_echo(&mut conn, "fresh-session");
    attach(&mut conn, "fresh-session");
    send_input_and_wait_for_echo(&mut conn, "fresh-session", b"works\n", "works");

    drop(daemon_b);
    cleanup(&dir);
}

/// Multiple sessions survive handoff.
#[test]
fn test_handoff_multiple_sessions() {
    let dir = test_dir("multi");

    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn = daemon_a.connect();

    // Spawn 3 sessions
    for i in 0..3 {
        spawn_echo(&mut conn, &format!("sess-{}", i));
        let mut attach_conn = daemon_a.connect();
        attach(&mut attach_conn, &format!("sess-{}", i));
        send_input(
            &mut attach_conn,
            &format!("sess-{}", i),
            format!("init-{}\n", i).as_bytes(),
        );
        attach_conn.drain_output(Duration::from_millis(200));
    }

    drop(conn);

    // Daemon B
    let daemon_b = DaemonHandle::start_in(&dir);
    std::thread::sleep(Duration::from_millis(200));

    // Verify all 3 sessions work through B
    for i in 0..3 {
        let mut c = daemon_b.connect();
        attach(&mut c, &format!("sess-{}", i));
        send_input_and_wait_for_echo(
            &mut c,
            &format!("sess-{}", i),
            format!("via-b-{}\n", i).as_bytes(),
            &format!("via-b-{}", i),
        );
    }

    drop(daemon_b);
    cleanup(&dir);
}

/// Two subscribed clients both receive ShuttingDown when handoff is triggered.
#[test]
fn test_handoff_broadcasts_shutting_down() {
    let dir = test_dir("shutdown-broadcast");

    let daemon_a = DaemonHandle::start_in(&dir);

    // Two subscriber clients
    let mut sub_a = daemon_a.connect();
    sub_a.send(&Cmd::Subscribe);
    match sub_a.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok, got {:?}", other),
    }

    let mut sub_b = daemon_a.connect();
    sub_b.send(&Cmd::Subscribe);
    match sub_b.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok, got {:?}", other),
    }

    // Set read timeouts before handoff (sockets may close during handoff)
    sub_a
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    sub_b
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();

    // Trigger handoff by starting daemon B in same dir
    let _daemon_b = DaemonHandle::start_in(&dir);

    let evt_a = sub_a.recv();
    assert!(
        matches!(evt_a, Evt::ShuttingDown),
        "sub_a should get ShuttingDown, got: {:?}",
        evt_a
    );

    let evt_b = sub_b.recv();
    assert!(
        matches!(evt_b, Evt::ShuttingDown),
        "sub_b should get ShuttingDown, got: {:?}",
        evt_b
    );

    cleanup(&dir);
}
