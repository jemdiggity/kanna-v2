//! Integration tests for daemon session reconnection.
//!
//! These tests spawn a real daemon process and communicate with it over
//! Unix sockets, verifying that:
//!   - AttachSnapshot/reattach doesn't split PTY bytes between readers
//!   - Multiple clients can attach and all receive output (broadcast)
//!   - Input after reattach reaches the PTY
//!   - New attachments join the broadcast without disrupting existing ones

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---- Protocol types (mirrored from daemon) ----

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
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        emulate_terminal: bool,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    Snapshot {
        session_id: String,
    },
    Kill {
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
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
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

static TEST_INSTANCE_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Compute the socket path using the same hash the daemon uses.
fn compute_socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
    _dir: PathBuf,
}

impl DaemonHandle {
    fn start() -> Self {
        Self::start_with_env([])
    }

    fn start_with_env<const N: usize>(envs: [(&str, &str); N]) -> Self {
        Self::start_with_options(envs, false)
    }

    fn start_with_fake_recovery<const N: usize>(envs: [(&str, &str); N]) -> Self {
        Self::start_with_options(envs, true)
    }

    fn start_with_options<const N: usize>(envs: [(&str, &str); N], fake_recovery: bool) -> Self {
        let instance = TEST_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "kanna-daemon-test-{}-{}",
            std::process::id(),
            instance
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let socket_path = compute_socket_path(&dir);
        let _ = std::fs::remove_file(&socket_path);
        let pid_path = dir.join("daemon.pid");
        let _ = std::fs::remove_file(&pid_path);

        let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));

        let mut command = Command::new(&daemon_bin);
        command.env("KANNA_DAEMON_DIR", dir.to_str().unwrap());
        if fake_recovery {
            command.env(
                "KANNA_TERMINAL_RECOVERY_BIN",
                write_fake_recovery_sidecar(&dir),
            );
        }
        for (key, value) in envs {
            command.env(key, value);
        }
        let child = command.spawn().expect("failed to start daemon");

        // Wait for this daemon instance to be ready, not merely for a stale socket path to exist.
        for _ in 0..50 {
            let pid_matches = std::fs::read_to_string(&pid_path)
                .ok()
                .and_then(|pid| pid.trim().parse::<u32>().ok())
                == Some(child.id());
            if pid_matches && UnixStream::connect(&socket_path).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        assert!(
            std::fs::read_to_string(&pid_path)
                .ok()
                .and_then(|pid| pid.trim().parse::<u32>().ok())
                == Some(child.id())
                && UnixStream::connect(&socket_path).is_ok(),
            "daemon was not ready at {:?}",
            socket_path
        );

        DaemonHandle {
            child,
            socket_path,
            _dir: dir,
        }
    }

    fn connect(&self) -> ClientConn {
        let stream = UnixStream::connect(&self.socket_path).expect("failed to connect to daemon");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        ClientConn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }
}

fn write_fake_recovery_sidecar(dir: &Path) -> PathBuf {
    let path = dir.join("fake-terminal-recovery");
    std::fs::write(
        &path,
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"StartSession"'*|*'"type":"ResizeSession"'*) printf '{"type":"Ok"}\n' ;;
    *'"type":"GetSnapshot"'*) printf '{"type":"NotFound"}\n' ;;
    *'"type":"FlushAndShutdown"'*) printf '{"type":"Ok"}\n'; exit 0 ;;
    *'"type":"WriteOutput"'*|*'"type":"EndSession"'*) : ;;
    *) printf '{"type":"Error","message":"unexpected fake recovery command"}\n' ;;
  esac
done
"#,
    )
    .expect("should write fake recovery sidecar");
    let mut permissions = std::fs::metadata(&path)
        .expect("should stat fake recovery sidecar")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&path, permissions).expect("should chmod fake recovery sidecar");
    path
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Clean up temp dir
        let _ = std::fs::remove_dir_all(&self._dir);
    }
}

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl ClientConn {
    fn connect(socket_path: &Path) -> Self {
        let stream = UnixStream::connect(socket_path).expect("failed to connect to daemon");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        ClientConn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }

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
            .unwrap_or_else(|e| panic!("failed to parse event: {} — line: {:?}", e, line.trim()))
    }

    /// Read events until we've collected `n` bytes of Output data, or timeout.
    fn collect_output(&mut self, n: usize) -> Vec<u8> {
        let mut collected = Vec::new();
        while collected.len() < n {
            match self.recv() {
                Evt::Output { data, .. } => collected.extend_from_slice(&data),
                Evt::Exit { .. } => break,
                _ => {}
            }
        }
        collected
    }

    fn collect_output_until_contains(&mut self, needle: &str) -> Vec<u8> {
        let mut collected = Vec::new();
        loop {
            match self.recv() {
                Evt::Output { data, .. } => {
                    collected.extend_from_slice(&data);
                    if String::from_utf8_lossy(&collected).contains(needle) {
                        return collected;
                    }
                }
                Evt::Exit { .. } => {
                    panic!(
                        "session exited before output contained {:?}: {:?}",
                        needle,
                        String::from_utf8_lossy(&collected)
                    );
                }
                _ => {}
            }
        }
    }

    /// Drain all pending Output events (non-blocking after first timeout).
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
                Err(_) => break, // timeout
            }
        }
        // Restore default timeout
        self.writer
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        collected
    }

    fn collect_output_until_contains_with_timeout(
        &mut self,
        needle: &str,
        timeout: Duration,
    ) -> Vec<u8> {
        let deadline = Instant::now() + timeout;
        let mut collected = Vec::new();

        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let read_timeout = remaining.min(Duration::from_millis(50));
            self.reader
                .get_mut()
                .set_read_timeout(Some(read_timeout))
                .unwrap();

            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(Evt::Output { data, .. }) = serde_json::from_str(line.trim()) {
                        collected.extend_from_slice(&data);
                        if String::from_utf8_lossy(&collected).contains(needle) {
                            self.reader
                                .get_mut()
                                .set_read_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            return collected;
                        }
                    }
                }
                Err(_) => {}
            }
        }

        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        panic!(
            "timed out waiting for output containing {:?}; collected {:?}",
            needle,
            String::from_utf8_lossy(&collected)
        );
    }
}

fn spawn_echo_session(conn: &mut ClientConn, session_id: &str) {
    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/cat".to_string(),
        args: vec![],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });

    match conn.recv() {
        Evt::SessionCreated { session_id: sid } => assert_eq!(sid, session_id),
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
}

fn spawn_shell_session(conn: &mut ClientConn, session_id: &str, script: &str) {
    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });

    match conn.recv() {
        Evt::SessionCreated { session_id: sid } => assert_eq!(sid, session_id),
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
}

#[test]
fn test_subscriber_receives_session_created_for_spawned_sessions() {
    let daemon = DaemonHandle::start();
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    match subscriber.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Subscribe, got: {:?}", other),
    }

    let mut creator = daemon.connect();
    spawn_echo_session(&mut creator, "sess-created-broadcast");

    match subscriber.recv() {
        Evt::SessionCreated { session_id } => assert_eq!(session_id, "sess-created-broadcast"),
        other => panic!("expected SessionCreated broadcast, got: {:?}", other),
    }
}

fn kill_session(conn: &mut ClientConn, session_id: &str) {
    conn.send(&Cmd::Kill {
        session_id: session_id.to_string(),
    });

    loop {
        match conn.recv() {
            Evt::Ok => break,
            Evt::Output { .. } => continue,
            Evt::StatusChanged { .. } => continue,
            Evt::Exit { .. } => continue,
            Evt::Error { message } => panic!("kill failed: {}", message),
            other => panic!("expected Ok for kill, got: {:?}", other),
        }
    }
}

fn attach(conn: &mut ClientConn, session_id: &str) {
    conn.send(&Cmd::AttachSnapshot {
        session_id: session_id.to_string(),
        emulate_terminal: false,
    });

    match conn.recv() {
        Evt::Snapshot {
            session_id: sid, ..
        } => assert_eq!(sid, session_id),
        Evt::Error { message } => panic!("attach failed: {}", message),
        other => panic!("expected Snapshot, got: {:?}", other),
    }
}

fn attach_emulating_terminal(conn: &mut ClientConn, session_id: &str) {
    conn.send(&Cmd::AttachSnapshot {
        session_id: session_id.to_string(),
        emulate_terminal: true,
    });

    match conn.recv() {
        Evt::Snapshot {
            session_id: sid, ..
        } => assert_eq!(sid, session_id),
        Evt::Error { message } => panic!("attach failed: {}", message),
        other => panic!("expected Snapshot, got: {:?}", other),
    }
}

fn attach_snapshot_and_capture(conn: &mut ClientConn, session_id: &str) -> SnapshotPayload {
    conn.send(&Cmd::AttachSnapshot {
        session_id: session_id.to_string(),
        emulate_terminal: true,
    });

    match conn.recv() {
        Evt::Snapshot {
            session_id: sid,
            snapshot,
        } => {
            assert_eq!(sid, session_id);
            snapshot
        }
        Evt::Error { message } => panic!("attach snapshot failed: {}", message),
        other => panic!("expected Snapshot, got: {:?}", other),
    }
}

fn request_snapshot(conn: &mut ClientConn, session_id: &str) -> SnapshotPayload {
    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });

    match conn.recv() {
        Evt::Snapshot {
            session_id: sid,
            snapshot,
        } => {
            assert_eq!(sid, session_id);
            snapshot
        }
        Evt::Error { message } => panic!("snapshot failed: {}", message),
        other => panic!("expected Snapshot, got: {:?}", other),
    }
}

fn spawn_hidden_prefix_session(conn: &mut ClientConn, session_id: &str, cwd: &Path) {
    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'EARLY-HIDDEN-0001\\r\\n'; printf '\\033[2J\\033[HSNAPSHOT-VISIBLE-0001\\r\\n'; : > ready; while [ ! -f go ]; do sleep 0.01; done; printf 'AFTER-ATTACH-0001\\r\\n'".to_string(),
        ],
        cwd: cwd.display().to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });

    match conn.recv() {
        Evt::SessionCreated { session_id: sid } => assert_eq!(sid, session_id),
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
}

fn atomic_attach_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kanna-atomic-attach-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn wait_for_file(path: &Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    panic!("timed out waiting for file {:?}", path);
}

fn release_hidden_prefix_session(dir: &Path) {
    std::fs::write(dir.join("go"), b"go").unwrap();
}

fn cleanup_atomic_attach_dir(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn wait_for_snapshot(conn: &mut ClientConn, session_id: &str, needle: &str) -> SnapshotPayload {
    for _ in 0..50 {
        let snapshot = request_snapshot(conn, session_id);
        if snapshot.vt.contains(needle) {
            return snapshot;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    panic!(
        "snapshot for session {:?} never contained {:?}",
        session_id, needle
    );
}

fn send_input(conn: &mut ClientConn, session_id: &str, data: &[u8]) {
    conn.send(&Cmd::Input {
        session_id: session_id.to_string(),
        data: data.to_vec(),
    });

    // The Ok response may be preceded by Output events
    loop {
        match conn.recv() {
            Evt::Ok => break,
            Evt::Output { .. } => continue,
            Evt::StatusChanged { .. } => continue,
            Evt::Error { message } => panic!("input failed: {}", message),
            other => panic!("expected Ok for input, got: {:?}", other),
        }
    }
}

// ---- Tests ----

/// Mimics the real Tauri flow: Spawn on shared conn, AttachSnapshot on dedicated conn,
/// Input on shared conn, Output received on dedicated conn.
#[test]
fn test_separate_conn_spawn_attach_input() {
    let daemon = DaemonHandle::start();

    // Shared connection (like DaemonState) — used for Spawn, Input, Resize
    let mut shared = daemon.connect();
    spawn_echo_session(&mut shared, "sess-split");

    // Dedicated connection (like attach_session_with_snapshot) — used for snapshot + output streaming
    let mut dedicated = daemon.connect();
    attach(&mut dedicated, "sess-split");
    dedicated.drain_output(Duration::from_millis(200));

    // Send input on the SHARED connection (different from attach connection)
    send_input(&mut shared, "sess-split", b"hello\n");

    // Output should arrive on the DEDICATED connection
    let output = dedicated.collect_output(5);
    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains("hello"),
        "output should arrive on dedicated attach connection, got: {:?}",
        output_str
    );
}

/// Basic: spawn, attach, send input, receive output.
#[test]
fn test_spawn_attach_io() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();

    spawn_echo_session(&mut conn, "sess-1");
    attach(&mut conn, "sess-1");

    send_input(&mut conn, "sess-1", b"hello\n");

    let output = conn.collect_output(6);
    assert!(
        String::from_utf8_lossy(&output).contains("hello"),
        "expected 'hello' in output, got: {:?}",
        String::from_utf8_lossy(&output)
    );
}

#[test]
fn test_stale_reader_does_not_remove_respawned_session_with_same_id() {
    let daemon = DaemonHandle::start();
    let mut shared = daemon.connect();

    spawn_shell_session(
        &mut shared,
        "sess-respawn",
        "printf 'OLD_READY\\r\\n'; while true; do sleep 1; done",
    );

    let mut first_attach = daemon.connect();
    attach(&mut first_attach, "sess-respawn");
    let old_output = first_attach.collect_output_until_contains("OLD_READY");
    assert!(
        String::from_utf8_lossy(&old_output).contains("OLD_READY"),
        "old session precondition failed: {:?}",
        String::from_utf8_lossy(&old_output)
    );

    kill_session(&mut shared, "sess-respawn");

    spawn_shell_session(
        &mut shared,
        "sess-respawn",
        "printf 'NEW_READY\\r\\n'; while true; do sleep 1; done",
    );

    let mut second_attach = daemon.connect();
    attach(&mut second_attach, "sess-respawn");
    let new_output = second_attach.collect_output_until_contains("NEW_READY");
    assert!(
        String::from_utf8_lossy(&new_output).contains("NEW_READY"),
        "respawned session output should remain visible, got {:?}",
        String::from_utf8_lossy(&new_output)
    );

    std::thread::sleep(Duration::from_millis(250));
    let snapshot = request_snapshot(&mut shared, "sess-respawn");
    assert!(
        snapshot.vt.contains("NEW_READY"),
        "respawned session should survive stale cleanup, got {:?}",
        snapshot.vt
    );
}

#[test]
fn test_attach_snapshot_replays_current_status() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();

    spawn_echo_session(&mut conn, "sess-status");
    attach(&mut conn, "sess-status");

    match conn.recv() {
        Evt::StatusChanged { session_id, status } => {
            assert_eq!(session_id, "sess-status");
            assert!(matches!(status, SessionStatus::Idle));
        }
        other => panic!(
            "expected StatusChanged after attach snapshot, got: {:?}",
            other
        ),
    }
}

#[test]
fn test_atomic_attach_snapshot_uses_headless_terminal_snapshot_without_raw_replay() {
    let daemon = DaemonHandle::start();
    let mut shared = daemon.connect();
    let dir = atomic_attach_dir("snapshot");
    spawn_hidden_prefix_session(&mut shared, "sess-atomic-snapshot", &dir);
    wait_for_file(&dir.join("ready"));

    let detached_snapshot =
        wait_for_snapshot(&mut shared, "sess-atomic-snapshot", "SNAPSHOT-VISIBLE-0001");
    assert!(
        !detached_snapshot.vt.contains("EARLY-HIDDEN-0001"),
        "test precondition failed: early prefix should not survive in snapshot, got {:?}",
        detached_snapshot.vt
    );

    let mut attached = daemon.connect();
    let snapshot = attach_snapshot_and_capture(&mut attached, "sess-atomic-snapshot");
    assert!(
        snapshot.vt.contains("SNAPSHOT-VISIBLE-0001"),
        "attach snapshot should include the current visible screen, got {:?}",
        snapshot.vt
    );
    assert!(
        !snapshot.vt.contains("EARLY-HIDDEN-0001"),
        "test precondition failed: snapshot unexpectedly contains the hidden prefix, got {:?}",
        snapshot.vt
    );

    release_hidden_prefix_session(&dir);
    let later_output = attached.collect_output_until_contains("AFTER-ATTACH-0001");
    let observed = format!("{}{}", snapshot.vt, String::from_utf8_lossy(&later_output));
    assert!(
        observed.contains("AFTER-ATTACH-0001"),
        "attach snapshot should continue streaming after attach, got {:?}",
        observed
    );
    assert!(
        !observed.contains("EARLY-HIDDEN-0001"),
        "attach snapshot should not append raw pre-attach bytes absent from the headless terminal snapshot, got {:?}",
        observed
    );
    cleanup_atomic_attach_dir(&dir);
}

/// Reattach from the SAME connection: second AttachSnapshot should cancel the first
/// stream_output and the new attach should receive all bytes.
#[test]
fn test_reattach_same_connection_no_split_bytes() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();

    spawn_echo_session(&mut conn, "sess-reattach");
    attach(&mut conn, "sess-reattach");

    // Send some initial data
    send_input(&mut conn, "sess-reattach", b"before\n");
    // Drain the output from first attach
    conn.drain_output(Duration::from_millis(500));

    // Reattach on the same connection
    attach(&mut conn, "sess-reattach");

    // Now send new data and verify ALL bytes arrive (no split)
    let test_data = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ\n";
    send_input(&mut conn, "sess-reattach", test_data);

    let output = conn.collect_output(26);
    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        "expected full alphabet in output (no split bytes), got: {:?}",
        output_str
    );
}

/// AttachSnapshot from a DIFFERENT connection: both connections receive output (broadcast).
#[test]
fn test_reattach_new_connection_no_split_bytes() {
    let daemon = DaemonHandle::start();

    // Connection 1: spawn and attach
    let mut conn1 = daemon.connect();
    spawn_echo_session(&mut conn1, "sess-reconnect");
    attach(&mut conn1, "sess-reconnect");

    // Send data on conn1
    send_input(&mut conn1, "sess-reconnect", b"initial\n");
    conn1.drain_output(Duration::from_millis(500));

    // Connection 2: joins the broadcast — both conn1 and conn2 receive output
    let mut conn2 = daemon.connect();
    attach(&mut conn2, "sess-reconnect");

    // Send data — should arrive on conn2 (and conn1 too, via broadcast)
    let test_data = b"0123456789ABCDEF\n";
    send_input(&mut conn2, "sess-reconnect", test_data);

    let output = conn2.collect_output(16);
    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains("0123456789ABCDEF"),
        "expected full data on new connection, got: {:?}",
        output_str
    );
}

/// Input after reattach reaches the PTY and produces output.
#[test]
fn test_input_works_after_reattach() {
    let daemon = DaemonHandle::start();

    let mut conn1 = daemon.connect();
    spawn_echo_session(&mut conn1, "sess-input");
    attach(&mut conn1, "sess-input");
    conn1.drain_output(Duration::from_millis(200));

    // Reattach on new connection
    let mut conn2 = daemon.connect();
    attach(&mut conn2, "sess-input");
    conn2.drain_output(Duration::from_millis(500));

    // Type something
    send_input(&mut conn2, "sess-input", b"post-reattach\n");

    let output = conn2.collect_output(13);
    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains("post-reattach"),
        "input after reattach should produce output, got: {:?}",
        output_str
    );
}

/// Two clients attached to the same session both receive output (broadcast model).
#[test]
fn test_broadcast_both_clients_receive_output() {
    let daemon = DaemonHandle::start();

    let mut shared = daemon.connect();
    spawn_echo_session(&mut shared, "sess-broadcast");

    // Two dedicated connections, both attach to the same session
    let mut client_a = daemon.connect();
    attach(&mut client_a, "sess-broadcast");
    client_a.drain_output(Duration::from_millis(200));

    let mut client_b = daemon.connect();
    attach(&mut client_b, "sess-broadcast");
    client_b.drain_output(Duration::from_millis(200));

    // Send input
    send_input(&mut shared, "sess-broadcast", b"BROADCAST\n");

    // Both clients should receive the output
    let output_a = client_a.collect_output(9);
    let output_b = client_b.collect_output(9);
    assert!(
        String::from_utf8_lossy(&output_a).contains("BROADCAST"),
        "client A should receive broadcast output, got: {:?}",
        String::from_utf8_lossy(&output_a)
    );
    assert!(
        String::from_utf8_lossy(&output_b).contains("BROADCAST"),
        "client B should receive broadcast output, got: {:?}",
        String::from_utf8_lossy(&output_b)
    );
}

#[test]
fn test_concurrent_attach_snapshot_cutover_keeps_snapshot_first_and_streaming_live_output() {
    let daemon = DaemonHandle::start();
    let mut shared = daemon.connect();
    spawn_shell_session(
        &mut shared,
        "sess-cutover",
        "i=0; while true; do i=$((i + 1)); printf 'CUTOVER-%04d\\r\\n' \"$i\"; sleep 0.01; done",
    );

    let mut observer = daemon.connect();
    wait_for_snapshot(&mut observer, "sess-cutover", "CUTOVER-");

    let mut handles = Vec::new();
    for index in 0..8 {
        let socket_path = daemon.socket_path.clone();
        handles.push(thread::spawn(move || {
            let mut conn = ClientConn::connect(&socket_path);
            let snapshot = attach_snapshot_and_capture(&mut conn, "sess-cutover");
            assert!(
                snapshot.vt.contains("CUTOVER-"),
                "attach {index} snapshot should include the current terminal state, got {:?}",
                snapshot.vt
            );

            let output =
                conn.collect_output_until_contains_with_timeout("CUTOVER-", Duration::from_secs(2));
            assert!(
                String::from_utf8_lossy(&output).contains("CUTOVER-"),
                "attach {index} should keep receiving live output after cutover"
            );
        }));
    }

    for handle in handles {
        handle.join().expect("attach worker should not panic");
    }

    let mut final_attach = daemon.connect();
    let final_snapshot = attach_snapshot_and_capture(&mut final_attach, "sess-cutover");
    assert!(
        final_snapshot.vt.contains("CUTOVER-"),
        "final attach should still receive a snapshot after concurrent cutovers, got {:?}",
        final_snapshot.vt
    );
    let output =
        final_attach.collect_output_until_contains_with_timeout("CUTOVER-", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&output).contains("CUTOVER-"),
        "final attach should still receive live output after concurrent cutovers"
    );
}

#[test]
fn stream_output_prioritizes_live_delivery_before_recovery_persistence() {
    // The desktop E2E runner can prove user-visible input/render latency through
    // the real app stack, but it cannot deterministically make only recovery
    // persistence slow for a live daemon. This daemon-level hook supplies that
    // missing control point and guards the ordering that protects PTY echo.
    let daemon = DaemonHandle::start_with_fake_recovery([(
        "KANNA_DAEMON_TEST_SLOW_RECOVERY_WRITE_MS",
        "1200",
    )]);

    let mut shared = daemon.connect();
    spawn_echo_session(&mut shared, "sess-slow-recovery");

    let mut attached = daemon.connect();
    attach(&mut attached, "sess-slow-recovery");
    attached.drain_output(Duration::from_millis(200));

    let marker = "LIVE_BEFORE_SLOW_RECOVERY";
    let started = Instant::now();
    send_input(
        &mut shared,
        "sess-slow-recovery",
        format!("{marker}\n").as_bytes(),
    );

    let output =
        attached.collect_output_until_contains_with_timeout(marker, Duration::from_millis(700));
    assert!(
        String::from_utf8_lossy(&output).contains(marker),
        "attached PTY client should receive echoed input before slow recovery bookkeeping"
    );
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "live PTY echo should not wait for the injected recovery persistence delay"
    );
}

/// When a live client is attached, the daemon-side recovery terminal must not
/// inject its own terminal-query replies into the PTY. The real frontend
/// terminal will answer those queries itself.
#[test]
fn test_attached_client_suppresses_headless_terminal_replies() {
    let daemon = DaemonHandle::start();

    let mut shared = daemon.connect();
    shared.send(&Cmd::Spawn {
        session_id: "sess-terminal-query".to_string(),
        executable: "/usr/bin/perl".to_string(),
        args: vec![
            "-e".to_string(),
            r#"$|=1; system('stty raw -echo'); my $start = ''; sysread(STDIN, $start, 1); print "\e[c"; my $rin = ''; vec($rin, fileno(STDIN), 1) = 1; my $rout = $rin; if (select($rout, undef, undef, 0.2) > 0) { my $buf = ''; sysread(STDIN, $buf, 64); print $buf if length $buf; }"#.to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });
    match shared.recv() {
        Evt::SessionCreated { session_id } => assert_eq!(session_id, "sess-terminal-query"),
        other => panic!("expected SessionCreated, got: {:?}", other),
    }

    let mut attached = daemon.connect();
    attach_emulating_terminal(&mut attached, "sess-terminal-query");
    attached.drain_output(Duration::from_millis(200));

    // Kick the helper process after the live client is attached so any reply it
    // sees can only come from the daemon-side headless terminal.
    send_input(&mut shared, "sess-terminal-query", b"x");

    let query = b"\x1b[c";
    let output = attached.drain_output(Duration::from_millis(300));
    assert_eq!(
        output, query,
        "attached sessions should not receive extra daemon-generated terminal replies"
    );
}

/// Rapid attach from separate connections: all connections receive output (broadcast).
/// With the single-reader + broadcast architecture, each AttachSnapshot pushes a writer
/// to the broadcast Vec. The final connection (and all earlier ones) receive output.
#[test]
fn test_rapid_reattach() {
    let daemon = DaemonHandle::start();

    let mut conn_spawn = daemon.connect();
    spawn_echo_session(&mut conn_spawn, "sess-rapid");

    // Rapid reattach: 5 connections attach in quick succession (no delays)
    for _ in 0..5 {
        let mut c = daemon.connect();
        attach(&mut c, "sess-rapid");
    }

    // Final connection should get clean output
    let mut final_conn = daemon.connect();
    attach(&mut final_conn, "sess-rapid");
    final_conn.drain_output(Duration::from_millis(300));

    send_input(&mut final_conn, "sess-rapid", b"RAPID_TEST_DATA\n");

    let output = final_conn.collect_output(15);
    let output_str = String::from_utf8_lossy(&output);
    assert!(
        output_str.contains("RAPID_TEST_DATA"),
        "after rapid reattach, output should be intact, got: {:?}",
        output_str
    );
}
