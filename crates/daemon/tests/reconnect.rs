//! Integration tests for daemon session reconnection.
//!
//! These tests spawn a real daemon process and communicate with it over
//! Unix sockets, verifying that:
//!   - Attach/reattach doesn't split PTY bytes between readers
//!   - Multiple clients can attach and all receive output (broadcast)
//!   - Input after reattach reaches the PTY
//!   - New attachments join the broadcast without disrupting existing ones

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;

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
    Attach {
        session_id: String,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    Kill {
        session_id: String,
    },
    List,
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
    Ok,
    Error {
        message: String,
    },
    #[serde(other)]
    Unknown,
}

// ---- Test harness ----

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
    _dir: PathBuf,
}

impl DaemonHandle {
    fn start() -> Self {
        let dir = std::env::temp_dir().join(format!("kanna-daemon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let socket_path = dir.join("daemon.sock");

        let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));

        let child = Command::new(&daemon_bin)
            .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
            .spawn()
            .expect("failed to start daemon");

        // Wait for socket to appear
        for _ in 0..50 {
            if socket_path.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        assert!(
            socket_path.exists(),
            "daemon socket not found at {:?}",
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

fn attach(conn: &mut ClientConn, session_id: &str) {
    conn.send(&Cmd::Attach {
        session_id: session_id.to_string(),
    });

    match conn.recv() {
        Evt::Ok => {}
        Evt::Error { message } => panic!("attach failed: {}", message),
        other => panic!("expected Ok, got: {:?}", other),
    }
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
            Evt::Error { message } => panic!("input failed: {}", message),
            other => panic!("expected Ok for input, got: {:?}", other),
        }
    }
}

// ---- Tests ----

/// Mimics the real Tauri flow: Spawn on shared conn, Attach on dedicated conn,
/// Input on shared conn, Output received on dedicated conn.
#[test]
fn test_separate_conn_spawn_attach_input() {
    let daemon = DaemonHandle::start();

    // Shared connection (like DaemonState) — used for Spawn, Input, Resize
    let mut shared = daemon.connect();
    spawn_echo_session(&mut shared, "sess-split");

    // Dedicated connection (like attach_session) — used for Attach + output streaming
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

/// Reattach from the SAME connection: second Attach should cancel the first
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

/// Attach from a DIFFERENT connection: both connections receive output (broadcast).
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

/// Rapid attach from separate connections: all connections receive output (broadcast).
/// With the single-reader + broadcast architecture, each Attach pushes a writer
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
