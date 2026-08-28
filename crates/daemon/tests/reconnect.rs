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
        #[serde(skip_serializing_if = "Option::is_none")]
        terminal_prelude: Option<Vec<u8>>,
    },
    AttachSnapshot {
        session_id: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        emulate_terminal: bool,
    },
    Observe {
        session_id: String,
    },
    ObserveSnapshot {
        session_id: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    InputBoundary {
        session_id: String,
        data: Vec<u8>,
    },
    InputIfSession {
        session_id: String,
        expected_pid: u32,
        data: Vec<u8>,
    },
    SubmitInput {
        session_id: String,
        data: Vec<u8>,
    },
    InputNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    OperatorInput {
        session_id: String,
        data: Vec<u8>,
    },
    SystemInput {
        session_id: String,
        data: Vec<u8>,
    },
    AuthorizeServer {
        pid: u32,
    },
    ClassifyInput {
        session_id: String,
        operator_input_only: bool,
    },
    ResizeNoReply {
        session_id: String,
        cols: u16,
        rows: u16,
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
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
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
        #[serde(default)]
        killed: bool,
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
    LogicalInputReleased {
        session_id: String,
        session_pid: u32,
    },
    Ok,
    Error {
        code: Option<ErrorCode>,
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    PtySpawnFailed,
    SessionIncarnationMismatch,
    InputUnauthorized,
    ProtectedInputProtocolRequired,
    LogicalInputHeldByDraft,
    #[serde(other)]
    Other,
}

#[test]
fn input_if_session_rejects_a_different_observed_pid() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "fenced-input";
    spawn_echo_session(&mut conn, session_id);

    conn.send(&Cmd::List);
    let pid = match conn.recv() {
        Evt::SessionList { sessions } => sessions
            .iter()
            .find(|session| session["session_id"] == session_id)
            .and_then(|session| session["pid"].as_u64())
            .and_then(|pid| u32::try_from(pid).ok())
            .expect("spawned session should have a pid"),
        other => panic!("expected SessionList, got: {other:?}"),
    };

    conn.send(&Cmd::InputIfSession {
        session_id: session_id.to_string(),
        expected_pid: pid.saturating_add(1),
        data: b"must not reach the PTY\r".to_vec(),
    });
    assert!(matches!(
        conn.recv(),
        Evt::Error {
            code: Some(ErrorCode::SessionIncarnationMismatch),
            ..
        }
    ));

    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match conn.recv() {
        Evt::Snapshot { snapshot, .. } => {
            assert!(!snapshot.vt.contains("must not reach the PTY"));
        }
        other => panic!("expected Snapshot, got: {other:?}"),
    }

    conn.send(&Cmd::InputIfSession {
        session_id: session_id.to_string(),
        expected_pid: pid,
        data: b"fenced input accepted\r".to_vec(),
    });
    assert!(matches!(conn.recv(), Evt::Ok));

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        conn.send(&Cmd::Snapshot {
            session_id: session_id.to_string(),
        });
        match conn.recv() {
            Evt::Snapshot { snapshot, .. } if snapshot.vt.contains("fenced input accepted") => {
                break;
            }
            Evt::Snapshot { .. } if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Evt::Snapshot { snapshot, .. } => {
                panic!("fenced input never reached PTY: {:?}", snapshot.vt)
            }
            other => panic!("expected Snapshot, got: {other:?}"),
        }
    }
}

#[test]
fn queued_logical_inputs_release_as_separate_real_pty_submissions() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "draft-isolation";
    spawn_shell_session(
        &mut conn,
        session_id,
        "stty -echo; while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done",
    );

    conn.send(&Cmd::List);
    let session_pid = match conn.recv() {
        Evt::SessionList { sessions } => sessions
            .iter()
            .find(|session| session["session_id"] == session_id)
            .and_then(|session| session["pid"].as_u64())
            .and_then(|pid| u32::try_from(pid).ok())
            .expect("spawned session should have a pid"),
        other => panic!("expected SessionList, got: {other:?}"),
    };

    conn.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"human draft".to_vec(),
    });
    for message in [
        b"first manager message".as_slice(),
        b"second manager message",
    ] {
        conn.send(&Cmd::SubmitInput {
            session_id: session_id.to_string(),
            data: message.to_vec(),
        });
        // Accepted into the queue, but not submitted — and the daemon says which.
        match conn.recv() {
            Evt::Error { code, .. } => assert_eq!(code, Some(ErrorCode::LogicalInputHeldByDraft)),
            other => panic!("a message held behind a draft must not answer Ok, got: {other:?}"),
        }
    }

    thread::sleep(Duration::from_millis(300));
    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match recv_snapshot(&mut conn, session_id) {
        snapshot if !snapshot.vt.contains("LINE:<") => {}
        snapshot => panic!(
            "logical input submitted into the partial raw draft: {:?}",
            snapshot.vt
        ),
    }

    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    assert!(matches!(subscriber.recv(), Evt::Ok));

    conn.send(&Cmd::InputBoundary {
        session_id: session_id.to_string(),
        data: b"\r".to_vec(),
    });
    expect_ok(&mut conn);

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        conn.send(&Cmd::Snapshot {
            session_id: session_id.to_string(),
        });
        let snapshot = recv_snapshot(&mut conn, session_id);
        let human = snapshot.vt.find("LINE:<human draft>");
        let first = snapshot.vt.find("LINE:<first manager message>");
        let second = snapshot.vt.find("LINE:<second manager message>");
        if let (Some(human), Some(first), Some(second)) = (human, first, second) {
            assert!(
                human < first && first < second,
                "the draft and queued messages must be submitted in FIFO order"
            );
            assert!(!snapshot
                .vt
                .contains("first manager messagesecond manager message"));
            break;
        }
        assert!(
            Instant::now() < deadline,
            "separate submissions did not reach the PTY: {:?}",
            snapshot.vt
        );
        thread::sleep(Duration::from_millis(20));
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    let mut released = 0;
    while released < 2 {
        match subscriber.recv_with_timeout(Duration::from_millis(100)) {
            Ok(Evt::LogicalInputReleased {
                session_id: released_session,
                session_pid: released_pid,
            }) => {
                assert_eq!(released_session, session_id);
                assert_eq!(released_pid, session_pid);
                released += 1;
            }
            Ok(_) | Err(_) if Instant::now() < deadline => {}
            Ok(other) => panic!("timed out after unexpected subscriber event: {other:?}"),
            Err(error) => panic!("timed out waiting for logical release events: {error}"),
        }
    }

    let no_extra_release_deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < no_extra_release_deadline {
        if let Ok(Evt::LogicalInputReleased {
            session_id: released_session,
            ..
        }) = subscriber.recv_with_timeout(Duration::from_millis(25))
        {
            assert_ne!(
                released_session, session_id,
                "each queued message must emit exactly one release event"
            );
        }
    }
}

/// The owner-reported regression: a reply sent from the phone landed as text
/// at the agent's prompt and sat there unsubmitted until someone pressed
/// Enter at that terminal.
///
/// The desktop producer declares every non-Enter keydown a draft, and nothing
/// could un-declare one, so a single navigation key held every later logical
/// delivery — while the delivery itself was answered `Ok` the moment it was
/// queued. This pins both halves: the daemon no longer calls a parked message
/// submitted, and the parked message still goes out untouched at the
/// producer's own boundary rather than being appended to an unsent line.
#[test]
fn a_navigation_key_draft_holds_a_logical_message_and_the_daemon_says_so() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "held-by-draft";
    spawn_shell_session(
        &mut conn,
        session_id,
        "stty -echo; while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done",
    );

    // Cursor-up: a keydown the desktop declares a draft, which leaves nothing
    // unsent at the prompt.
    conn.send(&Cmd::Input {
        session_id: session_id.to_string(),
        data: b"\x1b[A".to_vec(),
    });
    expect_ok(&mut conn);

    conn.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"owner reply".to_vec(),
    });
    match conn.recv() {
        Evt::Error { code, message } => {
            assert_eq!(code, Some(ErrorCode::LogicalInputHeldByDraft));
            assert!(
                message.contains("was not submitted"),
                "the refusal must say the message was not submitted: {message:?}"
            );
        }
        other => panic!("a held message must not be reported as submitted, got: {other:?}"),
    }

    thread::sleep(Duration::from_millis(400));
    let snapshot = recv_snapshot_for(&mut conn, session_id);
    assert!(
        !snapshot.vt.contains("LINE:<"),
        "nothing may reach the PTY while a draft is open: {:?}",
        snapshot.vt
    );

    conn.send(&Cmd::InputBoundary {
        session_id: session_id.to_string(),
        data: b"\r".to_vec(),
    });
    expect_ok(&mut conn);

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = recv_snapshot_for(&mut conn, session_id);
        if snapshot.vt.contains("LINE:<owner reply>") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the held message never reached the PTY after its boundary: {:?}",
            snapshot.vt
        );
        thread::sleep(Duration::from_millis(20));
    }
}

/// The refusal this change exists to end, end to end.
///
/// The Claude CLI paints a tab-to-accept suggestion on its own `❯` line, so no
/// frame will ever read that composer empty and attestation can never clear a
/// declared draft again. A message delivered into such a session was answered
/// `409 input_held_by_draft` — "a human has an unsent line at that terminal" —
/// when nobody had typed a byte into it. What the daemon can prove is its own
/// ledger: zero typed bytes means there is no line to append to, whatever the
/// screen says.
#[test]
fn a_declared_draft_that_typed_nothing_delivers_through_a_rendered_suggestion() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "untyped-composer";
    spawn_claude_shaped_session(
        &mut conn,
        session_id,
        // A composer holding the CLI's suggestion, then a reader loop, so a
        // delivered line is echoed back where the snapshot can see it.
        "stty -echo; printf '\\xe2\\x9d\\xaf check again in a minute\\n'; \
         while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done",
    );

    // A producer declares a draft for something that types nothing.
    conn.send(&Cmd::Input {
        session_id: session_id.to_string(),
        data: Vec::new(),
    });
    expect_ok(&mut conn);

    conn.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"owner reply".to_vec(),
    });
    match conn.recv() {
        Evt::Ok => {}
        Evt::Error { code, message } => {
            panic!("nothing was typed, so nothing could be corrupted: {code:?} {message:?}")
        }
        other => panic!("expected Ok, got: {other:?}"),
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = recv_snapshot_for(&mut conn, session_id);
        if snapshot.vt.contains("LINE:<owner reply>") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the message never reached the PTY: {:?}",
            snapshot.vt
        );
        thread::sleep(Duration::from_millis(20));
    }

    // And the composer is reported as its own labelled field rather than as
    // something the session said.
    conn.send(&Cmd::List);
    match conn.recv() {
        Evt::SessionList { sessions } => {
            let session = sessions
                .iter()
                .find(|session| session["session_id"] == session_id)
                .expect("the session is listed");
            assert_eq!(session["composer_attestation"], "not-typed");
        }
        other => panic!("expected SessionList, got: {other:?}"),
    }
}

/// The other half of the same rule, over the same wire: once a human really
/// has typed, the identical frame proves nothing and the message stays queued
/// for their boundary.
#[test]
fn a_typed_draft_still_holds_a_message_behind_a_rendered_suggestion() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "typed-composer";
    spawn_claude_shaped_session(
        &mut conn,
        session_id,
        "stty -echo; printf '\\xe2\\x9d\\xaf check again in a minute\\n'; \
         while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done",
    );

    conn.send(&Cmd::Input {
        session_id: session_id.to_string(),
        data: b"human draft".to_vec(),
    });
    expect_ok(&mut conn);

    conn.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"owner reply".to_vec(),
    });
    match conn.recv() {
        Evt::Error { code, .. } => assert_eq!(code, Some(ErrorCode::LogicalInputHeldByDraft)),
        other => panic!("a typed draft must still hold the message, got: {other:?}"),
    }

    conn.send(&Cmd::List);
    match conn.recv() {
        Evt::SessionList { sessions } => {
            let session = sessions
                .iter()
                .find(|session| session["session_id"] == session_id)
                .expect("the session is listed");
            assert_eq!(session["composer_attestation"], "typed");
        }
        other => panic!("expected SessionList, got: {other:?}"),
    }
}

/// `Ok` means submitted, not queued. The message and its terminating Enter
/// are one delivery in two writes separated by the submit delay, so an answer
/// that arrives before that delay elapsed cannot have seen the Enter written.
#[test]
fn submit_input_is_acknowledged_only_after_its_terminating_enter_is_written() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "acknowledged-submit";
    spawn_shell_session(
        &mut conn,
        session_id,
        "stty -echo; while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done",
    );

    let started = Instant::now();
    conn.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"owner reply".to_vec(),
    });
    expect_ok(&mut conn);
    let acknowledged_after = started.elapsed();

    assert!(
        acknowledged_after
            >= Duration::from_millis(kanna_daemon::session::LOGICAL_INPUT_SUBMIT_DELAY_MS),
        "the answer arrived in {acknowledged_after:?}, before the Enter could have been written"
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = recv_snapshot_for(&mut conn, session_id);
        if snapshot.vt.contains("LINE:<owner reply>") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "an acknowledged message never reached the PTY: {:?}",
            snapshot.vt
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn recv_snapshot_for(conn: &mut ClientConn, session_id: &str) -> SnapshotPayload {
    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    recv_snapshot(conn, session_id)
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
fn compute_socket_path(dir: &Path) -> PathBuf {
    kanna_runtime_defaults::socket_path(dir)
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
        command.env_remove("KANNA_TEST_PTY_ENXIO_AFTER");
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

fn daemon_fd_count(pid: u32) -> usize {
    #[cfg(target_os = "macos")]
    {
        let mut fds = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0,
            };
            1024
        ];
        let bytes = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                (fds.len() * std::mem::size_of::<libc::proc_fdinfo>()) as i32,
            )
        };
        assert!(bytes >= 0, "proc_pidinfo failed for pid {pid}");
        bytes as usize / std::mem::size_of::<libc::proc_fdinfo>()
    }

    #[cfg(target_os = "linux")]
    {
        return std::fs::read_dir(format!("/proc/{pid}/fd"))
            .expect("should read daemon fd directory")
            .count();
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        panic!("daemon fd counting is not implemented for this platform");
    }
}

fn wait_for_daemon_fd_count_at_most(pid: u32, limit: usize, timeout: Duration) -> usize {
    let deadline = Instant::now() + timeout;
    let mut last_count = daemon_fd_count(pid);

    while Instant::now() < deadline {
        last_count = daemon_fd_count(pid);
        if last_count <= limit {
            return last_count;
        }
        thread::sleep(Duration::from_millis(50));
    }

    panic!("daemon fd count stayed above {limit}; last count was {last_count}");
}

fn write_fake_recovery_sidecar(dir: &Path) -> PathBuf {
    let path = dir.join("fake-terminal-recovery");
    let log_path = dir.join("fake-terminal-recovery.log");
    std::fs::write(
        &path,
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  case "$line" in
    *'"type":"StartSession"'*|*'"type":"ResizeSession"'*) printf '{{"type":"Ok"}}\n' ;;
    *'"type":"GetSnapshot"'*) printf '{{"type":"NotFound"}}\n' ;;
    *'"type":"FlushAndShutdown"'*) printf '{{"type":"Ok"}}\n'; exit 0 ;;
    *'"type":"WriteOutput"'*|*'"type":"EndSession"'*) : ;;
    *) printf '{{"type":"Error","message":"unexpected fake recovery command"}}\n' ;;
  esac
done
"#,
            log_path.display()
        ),
    )
    .expect("should write fake recovery sidecar");
    let mut permissions = std::fs::metadata(&path)
        .expect("should stat fake recovery sidecar")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&path, permissions).expect("should chmod fake recovery sidecar");
    path
}

fn wait_for_recovery_log(
    daemon: &DaemonHandle,
    predicate: impl Fn(&[Value]) -> bool,
    timeout: Duration,
) -> Vec<Value> {
    let path = daemon._dir.join("fake-terminal-recovery.log");
    let deadline = Instant::now() + timeout;
    loop {
        let commands = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect::<Vec<_>>();
        if predicate(&commands) {
            return commands;
        }
        assert!(
            Instant::now() < deadline,
            "recovery log {:?} never reached expected state; commands={commands:?}",
            path
        );
        thread::sleep(Duration::from_millis(25));
    }
}

fn recovery_output_contains(command: &Value, marker: &[u8]) -> bool {
    if command["type"] != "WriteOutput" {
        return false;
    }
    let Some(data) = command["data"].as_array() else {
        return false;
    };
    let bytes = data
        .iter()
        .filter_map(Value::as_u64)
        .map(|value| value as u8)
        .collect::<Vec<_>>();
    bytes.windows(marker.len()).any(|window| window == marker)
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Clean up temp dir
        let _ = std::fs::remove_dir_all(&self._dir);
    }
}

/// Wait until any daemon log file under this daemon's data dir contains
/// `needle`. Used to assert that socket/mailbox backpressure diagnostics
/// actually fired, so a flood that the OS quietly buffers away fails the
/// test instead of passing vacuously.
fn wait_for_daemon_log(daemon: &DaemonHandle, needle: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let found = std::fs::read_dir(&daemon._dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "log")
            })
            .any(|entry| {
                std::fs::read_to_string(entry.path())
                    .map(|contents| contents.contains(needle))
                    .unwrap_or(false)
            });
        if found {
            return;
        }
        if Instant::now() > deadline {
            panic!("daemon log never contained {needle:?}");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn daemon_log_contents(daemon: &DaemonHandle) -> String {
    std::fs::read_dir(&daemon._dir)
        .expect("should read daemon data directory")
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "log")
        })
        .map(|entry| {
            std::fs::read_to_string(entry.path()).expect("should read daemon log file as UTF-8")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// How long a bare [`ClientConn::recv`] waits for the next daemon event.
///
/// `recv` panics when this expires, so it is a liveness ceiling, not a budget:
/// no test can pass *because* it fired. A test that wants a bounded "nothing
/// arrived" check uses `recv_with_timeout` or `assert_no_event_within`, which
/// set their own timeout and restore this one afterwards. The former 5s value
/// was tight enough to fail a correct run on a box carrying several
/// worktrees' suites, which is the whole failure class this branch removes.
const CLIENT_EVENT_WAIT: Duration = Duration::from_secs(60);

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl ClientConn {
    /// Shrink this connection's socket receive buffer so a non-reading
    /// client saturates kernel buffering after a few KiB instead of letting
    /// the OS absorb an entire test flood.
    fn clamp_recv_buffer(&self, bytes: i32) {
        use std::os::fd::AsRawFd;
        let ret = unsafe {
            libc::setsockopt(
                self.writer.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVBUF,
                (&bytes as *const i32).cast::<libc::c_void>(),
                std::mem::size_of::<i32>() as libc::socklen_t,
            )
        };
        assert_eq!(ret, 0, "failed to clamp SO_RCVBUF");
    }

    fn connect(socket_path: &Path) -> Self {
        let stream = UnixStream::connect(socket_path).expect("failed to connect to daemon");
        stream.set_read_timeout(Some(CLIENT_EVENT_WAIT)).unwrap();
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

    fn send_json(&mut self, cmd: &serde_json::Value) {
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

    fn recv_with_timeout(&mut self, timeout: Duration) -> Result<Evt, String> {
        self.reader
            .get_mut()
            .set_read_timeout(Some(timeout))
            .map_err(|error| format!("failed to set read timeout: {error}"))?;

        let mut line = String::new();
        let result = match self.reader.read_line(&mut line) {
            Ok(0) => Err("connection closed".to_string()),
            Ok(_) => serde_json::from_str(line.trim())
                .map_err(|error| format!("failed to parse event {line:?}: {error}")),
            Err(error) => Err(format!("read failed: {error}")),
        };

        self.reader
            .get_mut()
            .set_read_timeout(Some(CLIENT_EVENT_WAIT))
            .map_err(|error| format!("failed to restore read timeout: {error}"))?;
        result
    }

    fn assert_no_event_within(&mut self, timeout: Duration) {
        self.reader
            .get_mut()
            .set_read_timeout(Some(timeout))
            .expect("failed to set read timeout");

        let mut line = String::new();
        let result = self.reader.read_line(&mut line);

        self.reader
            .get_mut()
            .set_read_timeout(Some(CLIENT_EVENT_WAIT))
            .expect("failed to restore read timeout");

        match result {
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => panic!("unexpected read error while awaiting no event: {error}"),
            Ok(0) => panic!("connection closed while awaiting no event"),
            Ok(_) => {
                let event: Evt = serde_json::from_str(line.trim()).unwrap_or_else(|error| {
                    panic!("failed to parse unexpected event {line:?}: {error}")
                });
                panic!("expected no event within {timeout:?}, got: {event:?}");
            }
        }
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

    /// Like `collect_output_until_contains_with_timeout`, but a subscriber
    /// under load may legitimately observe content through a fanout resync
    /// Snapshot event instead of raw Output bytes; both count.
    fn wait_for_content_with_timeout(&mut self, needle: &str, timeout: Duration) {
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
                Ok(_) => match serde_json::from_str(line.trim()) {
                    Ok(Evt::Output { data, .. }) => {
                        collected.extend_from_slice(&data);
                        if String::from_utf8_lossy(&collected).contains(needle) {
                            self.reader
                                .get_mut()
                                .set_read_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            return;
                        }
                    }
                    Ok(Evt::Snapshot { snapshot, .. }) => {
                        if snapshot.vt.contains(needle) {
                            self.reader
                                .get_mut()
                                .set_read_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            return;
                        }
                        collected.clear();
                    }
                    _ => {}
                },
                Err(_) => {}
            }
        }

        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        panic!(
            "timed out waiting for content {:?} via output or resync snapshot; collected {:?}",
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
        terminal_prelude: None,
    });

    expect_session_created(conn, session_id);
}

fn expect_session_created(conn: &mut ClientConn, session_id: &str) {
    match conn.recv() {
        Evt::SessionCreated { session_id: sid } => assert_eq!(sid, session_id),
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
}

fn expect_ok(conn: &mut ClientConn) {
    loop {
        match conn.recv() {
            Evt::Ok => return,
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => panic!("command failed: {code:?}: {message}"),
            other => panic!("expected Ok, got: {other:?}"),
        }
    }
}

fn recv_snapshot(conn: &mut ClientConn, expected_session_id: &str) -> SnapshotPayload {
    loop {
        match conn.recv() {
            Evt::Snapshot {
                session_id,
                snapshot,
            } => {
                assert_eq!(session_id, expected_session_id);
                return snapshot;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => panic!("snapshot failed: {code:?}: {message}"),
            other => panic!("expected Snapshot, got: {other:?}"),
        }
    }
}

fn expect_session_created_with_timeout(conn: &mut ClientConn, session_id: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for SessionCreated");

        match conn.recv_with_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(Evt::SessionCreated { session_id: sid }) => {
                assert_eq!(sid, session_id);
                return;
            }
            Ok(Evt::Output { .. }) | Ok(Evt::StatusChanged { .. }) | Ok(Evt::Exit { .. }) => {
                continue;
            }
            Ok(Evt::Error { message, .. }) => panic!("spawn failed: {message}"),
            Ok(other) => panic!("expected SessionCreated, got: {:?}", other),
            Err(_) => continue,
        }
    }
}

/// A shell session the daemon reads as a Claude terminal, so the composer
/// matchers apply to whatever the script paints.
fn spawn_claude_shaped_session(conn: &mut ClientConn, session_id: &str, script: &str) {
    conn.send_json(&serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "executable": "/bin/sh",
        "args": ["-c", script],
        "cwd": "/tmp",
        "env": {},
        "cols": 80,
        "rows": 24,
        "agent_provider": "claude",
    }));

    match conn.recv() {
        Evt::SessionCreated { session_id: sid } => assert_eq!(sid, session_id),
        other => panic!("expected SessionCreated, got: {other:?}"),
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
        terminal_prelude: None,
    });

    match conn.recv() {
        Evt::SessionCreated { session_id: sid } => assert_eq!(sid, session_id),
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
}

#[test]
fn protected_session_rejects_generic_daemon_input_and_accepts_authenticated_operator() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "protected-merge-input";
    conn.send_json(&serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "executable": "/bin/cat",
        "args": [],
        "cwd": "/tmp",
        "env": {},
        "cols": 80,
        "rows": 24,
        "operator_input_only": true
    }));
    expect_session_created(&mut conn, session_id);

    conn.send(&Cmd::ClassifyInput {
        session_id: session_id.to_string(),
        operator_input_only: false,
    });
    assert!(matches!(
        conn.recv(),
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        }
    ));

    conn.send(&Cmd::Input {
        session_id: session_id.to_string(),
        data: b"forged merge\r".to_vec(),
    });
    match conn.recv() {
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        } => {}
        other => panic!("generic daemon input was not fenced: {other:?}"),
    }

    conn.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"forged no-reply merge\r".to_vec(),
    });
    assert!(matches!(
        conn.recv(),
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        }
    ));

    conn.send(&Cmd::OperatorInput {
        session_id: session_id.to_string(),
        data: b"operator merge\r".to_vec(),
    });
    assert!(matches!(conn.recv(), Evt::Ok));

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        conn.send(&Cmd::Snapshot {
            session_id: session_id.to_string(),
        });
        match conn.recv() {
            Evt::Snapshot { snapshot, .. } if snapshot.vt.contains("operator merge") => break,
            Evt::Snapshot { .. } if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Evt::Snapshot { snapshot, .. } => {
                panic!(
                    "operator input never reached protected PTY: {:?}",
                    snapshot.vt
                )
            }
            other => panic!("expected protected session snapshot, got {other:?}"),
        }
    }
}

#[test]
#[ignore = "fixture invoked by old_server_cannot_spawn_on_a_new_daemon_without_negotiation"]
fn unnegotiated_server_spawn_child() {
    let Some(socket_path) = std::env::var_os("KANNA_UNNEGOTIATED_SPAWN_SOCKET") else {
        return;
    };
    let stream = UnixStream::connect(socket_path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut connection = ClientConn {
        reader: BufReader::new(stream.try_clone().unwrap()),
        writer: stream,
    };
    connection.send_json(&serde_json::json!({
        "type": "Spawn",
        "session_id": "old-server-merge",
        "executable": "/bin/cat",
        "args": [],
        "cwd": "/tmp",
        "env": {},
        "cols": 80,
        "rows": 24
    }));
    assert!(matches!(
        connection.recv(),
        Evt::Error {
            code: Some(ErrorCode::ProtectedInputProtocolRequired),
            ..
        }
    ));
}

#[test]
fn old_server_cannot_spawn_on_a_new_daemon_without_negotiation() {
    let current_executable = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let daemon = DaemonHandle::start_with_env([(
        "KANNA_SERVER_EXECUTABLE",
        current_executable.to_str().unwrap(),
    )]);
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "unnegotiated_server_spawn_child",
            "--ignored",
            "--nocapture",
        ])
        .env("KANNA_UNNEGOTIATED_SPAWN_SOCKET", &daemon.socket_path)
        .status()
        .expect("spawn old-server fixture");
    assert!(status.success());
}

#[test]
#[ignore = "fixture invoked by privileged_input_rejects_a_separate_process_impersonator"]
fn privileged_input_impersonation_child() {
    let Some(socket_path) = std::env::var_os("KANNA_IMPERSONATION_SOCKET") else {
        return;
    };
    let session_id = std::env::var("KANNA_IMPERSONATION_SESSION").unwrap();
    let stream = UnixStream::connect(socket_path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut conn = ClientConn {
        reader: BufReader::new(stream.try_clone().unwrap()),
        writer: stream,
    };
    let commands = [
        Cmd::AuthorizeServer {
            pid: std::process::id(),
        },
        Cmd::OperatorInput {
            session_id: session_id.clone(),
            data: b"forged operator\r".to_vec(),
        },
        Cmd::SystemInput {
            session_id: session_id.clone(),
            data: b"forged system\r".to_vec(),
        },
        Cmd::ClassifyInput {
            session_id,
            operator_input_only: false,
        },
    ];
    for command in commands {
        conn.send(&command);
        assert!(matches!(
            conn.recv(),
            Evt::Error {
                code: Some(ErrorCode::InputUnauthorized),
                ..
            }
        ));
    }
}

#[test]
fn privileged_input_rejects_a_separate_process_impersonator() {
    let current_executable = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let daemon = DaemonHandle::start_with_env([(
        "KANNA_SERVER_EXECUTABLE",
        current_executable.to_str().unwrap(),
    )]);
    let mut conn = daemon.connect();
    let session_id = "protected-cross-process";
    conn.send_json(&serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "executable": "/bin/cat",
        "args": [],
        "cwd": "/tmp",
        "env": {},
        "cols": 80,
        "rows": 24,
        "operator_input_only": true
    }));
    expect_session_created(&mut conn, session_id);

    conn.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(conn.recv(), Evt::Ok));
    let audit = std::fs::read_to_string(daemon._dir.join("kanna-daemon-lifecycle.log"))
        .expect("server authorization should be durably audited");
    assert!(
        audit.contains(&format!(
            "pid={} event=server_authorized server_pid={} scope=protected_system_input",
            daemon.child.id(),
            std::process::id()
        )),
        "authorization audit must identify both exact processes: {audit}"
    );

    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "privileged_input_impersonation_child",
            "--ignored",
            "--nocapture",
        ])
        .env("KANNA_IMPERSONATION_SOCKET", &daemon.socket_path)
        .env("KANNA_IMPERSONATION_SESSION", session_id)
        .status()
        .expect("spawn separate impersonator process");
    assert!(status.success(), "impersonator fixture assertions failed");

    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    let snapshot = loop {
        match conn.recv() {
            Evt::Snapshot { snapshot, .. } => break snapshot,
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            other => panic!("expected protected session snapshot, got {other:?}"),
        }
    };
    assert!(!snapshot.vt.contains("forged operator"));
    assert!(!snapshot.vt.contains("forged system"));
}

#[test]
fn authenticated_server_declassifies_a_legacy_session_for_ordinary_input() {
    let current_executable = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let daemon = DaemonHandle::start_with_env([(
        "KANNA_SERVER_EXECUTABLE",
        current_executable.to_str().unwrap(),
    )]);
    let mut conn = daemon.connect();
    let session_id = "ordinary-system-input";
    conn.send_json(&serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "executable": "/bin/cat",
        "args": [],
        "cwd": "/tmp",
        "env": {},
        "cols": 80,
        "rows": 24,
        "operator_input_only": true
    }));
    expect_session_created(&mut conn, session_id);

    conn.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(conn.recv(), Evt::Ok));
    conn.send(&Cmd::ClassifyInput {
        session_id: session_id.to_string(),
        operator_input_only: false,
    });
    assert!(matches!(conn.recv(), Evt::Ok));
    conn.send(&Cmd::Input {
        session_id: session_id.to_string(),
        data: b"ordinary policy request\r".to_vec(),
    });
    loop {
        match conn.recv() {
            Evt::Ok => break,
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            other => panic!("expected ordinary input acknowledgement, got {other:?}"),
        }
    }
    // The `Evt::Ok` above is a write acknowledgement, not a render: `/bin/cat`
    // still has to echo the bytes back through the PTY and the daemon still has
    // to feed them to the vt parser. Asserting on one snapshot taken right
    // after the ack raced that under load; poll until the text lands, the way
    // the sibling declassification tests already do.
    wait_for_snapshot(&mut conn, session_id, "ordinary policy request");
}

#[test]
fn pty_spawn_enxio_reports_live_daemon_occupancy() {
    let daemon = DaemonHandle::start_with_env([("KANNA_TEST_PTY_ENXIO_AFTER", "1")]);
    let mut conn = daemon.connect();
    let live_session_id = "sess-live-before-enxio";
    let failed_session_id = "sess-forced-enxio";

    spawn_echo_session(&mut conn, live_session_id);

    conn.send(&Cmd::List);
    let sessions = expect_session_list_with_timeout(&mut conn, Duration::from_secs(5));
    let live_pid = sessions
        .iter()
        .find(|session| session["session_id"] == live_session_id)
        .and_then(|session| session["pid"].as_u64())
        .expect("live PTY session should have a registry PID");

    conn.send(&Cmd::Spawn {
        session_id: failed_session_id.to_string(),
        executable: "/bin/cat".to_string(),
        args: vec![],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });

    match conn.recv() {
        Evt::Error {
            code: Some(ErrorCode::PtySpawnFailed),
            message,
        } => assert!(
            message.contains("failed to spawn PTY"),
            "unexpected spawn error: {message}"
        ),
        other => panic!("expected PtySpawnFailed, got: {other:?}"),
    }

    let log_marker = format!("[pty-exhaustion] failed_session={failed_session_id}");
    wait_for_daemon_log(&daemon, &log_marker, Duration::from_secs(5));
    let logs = daemon_log_contents(&daemon);
    let exhaustion_log = logs
        .lines()
        .find(|line| line.contains(&log_marker))
        .expect("daemon log should contain the PTY exhaustion record");

    assert!(
        exhaustion_log.contains(&format!("daemon_pid={}", daemon.child.id())),
        "exhaustion log should identify the daemon process: {exhaustion_log}"
    );
    assert!(
        exhaustion_log.contains("open_master_count=1"),
        "exhaustion log should count the live PTY master: {exhaustion_log}"
    );

    let attribution_prefix = format!("{live_session_id}(pid={live_pid},master_fd=");
    let master_fd = exhaustion_log
        .split_once(&attribution_prefix)
        .and_then(|(_, suffix)| suffix.split_once(')'))
        .and_then(|(fd, _)| fd.parse::<i32>().ok())
        .expect("exhaustion log should attribute a numeric master fd to the live session");
    assert!(
        master_fd >= 0,
        "exhaustion log should contain an open master fd: {exhaustion_log}"
    );
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

#[test]
fn stage_transition_prelude_precedes_process_output_in_snapshot() {
    let daemon = DaemonHandle::start();
    let mut conn = daemon.connect();
    let session_id = "sess-stage-transition-prelude";
    let dir = atomic_attach_dir("stage-transition-prelude");
    let prelude = "\r\n\x1b[2m━━ Stage advanced: in progress → review ━━\x1b[0m\r\n"
        .as_bytes()
        .to_vec();

    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'NEW_STAGE_PROCESS_OUTPUT\\n'; : > ready; sleep 2".to_string(),
        ],
        cwd: dir.display().to_string(),
        env: HashMap::new(),
        cols: 100,
        rows: 24,
        terminal_prelude: Some(prelude),
    });
    expect_session_created(&mut conn, session_id);
    wait_for_file(&dir.join("ready"));
    // `ready` proves the process wrote to the PTY, not that the daemon has
    // mirrored it yet; wait until the headless terminal caught up before
    // asserting on an attach snapshot.
    wait_for_snapshot(&mut conn, session_id, "NEW_STAGE_PROCESS_OUTPUT");

    let snapshot = attach_snapshot_and_capture(&mut conn, session_id);
    let marker_index = snapshot
        .vt
        .find("Stage advanced: in progress → review")
        .expect("snapshot should contain the stage transition prelude");
    let process_index = snapshot
        .vt
        .find("NEW_STAGE_PROCESS_OUTPUT")
        .expect("snapshot should contain process output");
    assert!(
        marker_index < process_index,
        "stage marker must precede process output in snapshot: {}",
        snapshot.vt
    );

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn test_subscriber_receives_exit_for_pty_sessions() {
    let daemon = DaemonHandle::start();
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    match subscriber.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Subscribe, got: {:?}", other),
    }

    let mut creator = daemon.connect();
    spawn_shell_session(&mut creator, "sess-exit-broadcast", "printf ready; exit 0");

    loop {
        match subscriber.recv() {
            Evt::SessionCreated { .. } | Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            Evt::Exit {
                session_id,
                code,
                killed,
            } => {
                assert!(!killed, "natural exit must not be marked killed");
                assert_eq!(session_id, "sess-exit-broadcast");
                assert_eq!(code, 0);
                break;
            }
            other => panic!("expected Exit broadcast, got: {:?}", other),
        }
    }
}

#[test]
fn test_kill_delivers_killed_exit_to_attached_clients_and_subscribers() {
    let daemon = DaemonHandle::start();

    let mut creator = daemon.connect();
    spawn_echo_session(&mut creator, "sess-kill-notify");

    // Subscribe after the spawn so the subscriber only sees post-kill traffic.
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    match subscriber.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Subscribe, got: {:?}", other),
    }

    let mut attached = daemon.connect();
    attached.send(&Cmd::AttachSnapshot {
        session_id: "sess-kill-notify".to_string(),
        emulate_terminal: true,
    });
    match attached.recv() {
        Evt::Snapshot { session_id, .. } => assert_eq!(session_id, "sess-kill-notify"),
        other => panic!("expected Snapshot, got: {:?}", other),
    }

    let mut killer = daemon.connect();
    kill_session(&mut killer, "sess-kill-notify");

    // The attached client must learn the session died, exactly like a natural
    // exit — otherwise it keeps a live-looking but permanently silent stream.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for kill Exit");
        match attached.recv_with_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(Evt::Exit {
                session_id,
                code,
                killed,
            }) => {
                assert_eq!(session_id, "sess-kill-notify");
                assert_eq!(code, 128 + libc::SIGKILL);
                assert!(killed, "Kill-command exits must be marked killed");
                break;
            }
            Ok(Evt::Output { .. }) | Ok(Evt::StatusChanged { .. }) => continue,
            Ok(other) => panic!("expected Exit after kill, got: {:?}", other),
            Err(_) => continue,
        }
    }

    // Subscribers also need the killed Exit so orchestration can order a
    // session replacement before the new SessionCreated broadcast. The killed
    // marker lets higher-level completion watchers ignore engine kills.
    loop {
        match subscriber.recv() {
            Evt::SessionCreated { .. } | Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            Evt::Exit {
                session_id, killed, ..
            } => {
                assert_eq!(session_id, "sess-kill-notify");
                assert!(killed, "Kill-command exits must be marked killed");
                break;
            }
            other => panic!("expected killed Exit broadcast, got: {:?}", other),
        }
    }
}

#[test]
fn observe_snapshot_registration_is_ordered_before_a_concurrent_kill_exit() {
    let daemon = DaemonHandle::start_with_env([("KANNA_DAEMON_TEST_REGISTRATION_PAUSE_MS", "250")]);
    let mut creator = daemon.connect();
    spawn_shell_session(
        &mut creator,
        "sess-observe-kill-race",
        "printf 'OLD_READY\\r\\n'; sleep 30",
    );

    let mut observer = daemon.connect();
    observer.send(&Cmd::ObserveSnapshot {
        session_id: "sess-observe-kill-race".into(),
    });
    wait_for_daemon_log(
        &daemon,
        "[registration-test-pause] operation=observe_snapshot session=sess-observe-kill-race",
        Duration::from_secs(2),
    );

    let mut killer = daemon.connect();
    killer.send(&Cmd::Kill {
        session_id: "sess-observe-kill-race".into(),
    });

    assert!(matches!(
        observer.recv(),
        Evt::Snapshot { ref session_id, .. } if session_id == "sess-observe-kill-race"
    ));
    loop {
        match observer.recv() {
            Evt::Exit {
                session_id, killed, ..
            } => {
                assert_eq!(session_id, "sess-observe-kill-race");
                assert!(killed);
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected observer events followed by final Exit, got {other:?}"),
        }
    }
    wait_for_ok(&mut killer, "kill after observe snapshot registration");
    assert!(
        observer
            .recv_with_timeout(Duration::from_millis(250))
            .is_err(),
        "a stale observer must receive no Snapshot or StatusChanged after its final Exit",
    );
}

#[test]
fn attach_snapshot_registration_is_ordered_before_a_concurrent_kill_exit() {
    let daemon = DaemonHandle::start_with_env([("KANNA_DAEMON_TEST_REGISTRATION_PAUSE_MS", "250")]);
    let mut creator = daemon.connect();
    spawn_shell_session(
        &mut creator,
        "sess-attach-kill-race",
        "printf 'OLD_READY\\r\\n'; sleep 30",
    );

    let mut attached = daemon.connect();
    attached.send(&Cmd::AttachSnapshot {
        session_id: "sess-attach-kill-race".into(),
        emulate_terminal: false,
    });
    wait_for_daemon_log(
        &daemon,
        "[registration-test-pause] operation=attach_snapshot session=sess-attach-kill-race",
        Duration::from_secs(2),
    );

    let mut killer = daemon.connect();
    killer.send(&Cmd::Kill {
        session_id: "sess-attach-kill-race".into(),
    });

    assert!(matches!(
        attached.recv(),
        Evt::Snapshot { ref session_id, .. } if session_id == "sess-attach-kill-race"
    ));
    loop {
        match attached.recv() {
            Evt::Exit {
                session_id, killed, ..
            } => {
                assert_eq!(session_id, "sess-attach-kill-race");
                assert!(killed);
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected attached events followed by final Exit, got {other:?}"),
        }
    }
    wait_for_ok(&mut killer, "kill after attach snapshot registration");
    assert!(
        attached
            .recv_with_timeout(Duration::from_millis(250))
            .is_err(),
        "a stale attachment must receive no Snapshot or StatusChanged after its final Exit",
    );
}

#[test]
fn same_id_respawn_waits_until_kill_finishes_stale_fanout_cleanup() {
    let daemon =
        DaemonHandle::start_with_env([("KANNA_DAEMON_TEST_KILL_AFTER_EXIT_PAUSE_MS", "1200")]);
    let mut creator = daemon.connect();
    spawn_shell_session(&mut creator, "sess-kill-respawn-race", "sleep 30");
    let mut stale_attached = daemon.connect();
    attach(&mut stale_attached, "sess-kill-respawn-race");

    let mut killer = daemon.connect();
    killer.send(&Cmd::Kill {
        session_id: "sess-kill-respawn-race".into(),
    });
    wait_for_daemon_log(
        &daemon,
        "[kill-test-pause] session=sess-kill-respawn-race",
        Duration::from_secs(4),
    );

    let mut respawner = daemon.connect();
    respawner.send(&Cmd::Spawn {
        session_id: "sess-kill-respawn-race".into(),
        executable: "/bin/sh".into(),
        args: vec!["-c".into(), "printf 'NEW_READY\\r\\n'; sleep 30".into()],
        cwd: "/tmp".into(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    assert!(
        respawner
            .recv_with_timeout(Duration::from_millis(100))
            .is_err(),
        "same-id respawn must remain queued while killed incarnation cleanup holds lifecycle",
    );

    wait_for_ok(&mut killer, "kill before same-id respawn");
    expect_session_created_with_timeout(
        &mut respawner,
        "sess-kill-respawn-race",
        Duration::from_secs(2),
    );
    let snapshot = observe_snapshot(&mut respawner, "sess-kill-respawn-race");
    let mut new_output = snapshot.vt;
    while !new_output.contains("NEW_READY") {
        match respawner.recv() {
            Evt::Output { data, .. } => new_output.push_str(&String::from_utf8_lossy(&data)),
            Evt::StatusChanged { .. } => {}
            other => panic!("expected replacement output, got {other:?}"),
        }
    }

    loop {
        match stale_attached.recv() {
            Evt::Exit { killed, .. } => {
                assert!(killed);
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected stale attachment Exit, got {other:?}"),
        }
    }
    assert!(
        stale_attached
            .recv_with_timeout(Duration::from_millis(250))
            .is_err(),
        "replacement Snapshot or StatusChanged leaked into the stale incarnation fanout",
    );
}

/// A stage swap kills a session id and immediately respawns it with the next
/// stage's agent. Subscribers must observe the old incarnation's Exit before
/// the new incarnation's SessionCreated — the desktop terminal rebinds on
/// SessionCreated, and kill orchestration (SessionReplacements) consumes
/// exactly one Exit per kill.
#[test]
fn test_kill_then_respawn_broadcasts_exit_before_session_created() {
    let daemon = DaemonHandle::start();
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    match subscriber.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Subscribe, got: {:?}", other),
    }

    let mut creator = daemon.connect();
    spawn_shell_session(&mut creator, "sess-swap", "sleep 30");
    // Drain the first incarnation's SessionCreated broadcast.
    loop {
        match subscriber.recv() {
            Evt::SessionCreated { session_id } => {
                assert_eq!(session_id, "sess-swap");
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected SessionCreated broadcast, got: {:?}", other),
        }
    }

    kill_session(&mut creator, "sess-swap");
    spawn_shell_session(&mut creator, "sess-swap", "sleep 30");

    let mut saw_killed_exit = false;
    loop {
        match subscriber.recv() {
            Evt::Exit {
                session_id, killed, ..
            } => {
                assert_eq!(session_id, "sess-swap");
                assert!(killed);
                saw_killed_exit = true;
            }
            Evt::SessionCreated { session_id } => {
                assert_eq!(session_id, "sess-swap");
                assert!(
                    saw_killed_exit,
                    "respawn SessionCreated must be preceded by the killed Exit"
                );
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected Exit then SessionCreated, got: {:?}", other),
        }
    }
}

/// Stress the kill/respawn ordering: the claimed incarnation's reader must
/// never publish a natural `killed: false` Exit, and every respawn's
/// SessionCreated must be preceded by exactly one killed Exit. Regression for
/// the widened teardown window (kill now awaits the lifecycle executor).
#[test]
fn test_kill_then_respawn_ordering_holds_under_repetition() {
    let daemon = DaemonHandle::start();
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    match subscriber.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Subscribe, got: {:?}", other),
    }

    let mut creator = daemon.connect();
    spawn_shell_session(&mut creator, "sess-stress", "sleep 30");
    loop {
        match subscriber.recv() {
            Evt::SessionCreated { session_id } => {
                assert_eq!(session_id, "sess-stress");
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected SessionCreated, got: {:?}", other),
        }
    }

    for round in 0..6 {
        kill_session(&mut creator, "sess-stress");
        spawn_shell_session(&mut creator, "sess-stress", "sleep 30");

        let mut saw_killed_exit = false;
        loop {
            match subscriber.recv() {
                Evt::Exit {
                    session_id, killed, ..
                } => {
                    assert_eq!(session_id, "sess-stress");
                    assert!(
                        killed,
                        "round {round}: a claimed incarnation must not publish a natural Exit"
                    );
                    assert!(
                        !saw_killed_exit,
                        "round {round}: exactly one Exit per termination"
                    );
                    saw_killed_exit = true;
                }
                Evt::SessionCreated { session_id } => {
                    assert_eq!(session_id, "sess-stress");
                    assert!(
                        saw_killed_exit,
                        "round {round}: respawn SessionCreated must follow the killed Exit"
                    );
                    break;
                }
                Evt::Output { .. } | Evt::StatusChanged { .. } => {}
                other => panic!(
                    "round {round}: expected Exit then SessionCreated, got: {:?}",
                    other
                ),
            }
        }
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
            Evt::Error { message, .. } => panic!("kill failed: {}", message),
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
        Evt::Error { message, .. } => panic!("attach failed: {}", message),
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
        Evt::Error { message, .. } => panic!("attach failed: {}", message),
        other => panic!("expected Snapshot, got: {:?}", other),
    }
}

fn observe(conn: &mut ClientConn, session_id: &str) {
    conn.send(&Cmd::Observe {
        session_id: session_id.to_string(),
    });
    wait_for_ok(conn, "observe");
}

/// Atomic observer cutover: the reply is the authoritative snapshot itself,
/// queued ahead of all later output.
fn observe_snapshot(conn: &mut ClientConn, session_id: &str) -> SnapshotPayload {
    conn.send(&Cmd::ObserveSnapshot {
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
        Evt::Error { message, .. } => panic!("observe snapshot failed: {}", message),
        other => panic!(
            "expected Snapshot as the first observer event, got: {:?}",
            other
        ),
    }
}

fn resize(conn: &mut ClientConn, session_id: &str, cols: u16, rows: u16) {
    conn.send(&Cmd::Resize {
        session_id: session_id.to_string(),
        cols,
        rows,
    });
    wait_for_ok(conn, "resize");
}

fn wait_for_ok(conn: &mut ClientConn, action: &str) {
    loop {
        match conn.recv() {
            Evt::Ok => break,
            Evt::Output { .. } => continue,
            Evt::StatusChanged { .. } => continue,
            Evt::Error { message, .. } => panic!("{action} failed: {message}"),
            other => panic!("expected Ok for {action}, got: {:?}", other),
        }
    }
}

fn wait_for_ok_with_timeout(conn: &mut ClientConn, action: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for Ok after {action}"
        );

        match conn.recv_with_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(Evt::Ok) => break,
            Ok(Evt::Output { .. }) | Ok(Evt::StatusChanged { .. }) => continue,
            Ok(Evt::Error { message, .. }) => panic!("{action} failed: {message}"),
            Ok(other) => panic!("expected Ok for {action}, got: {:?}", other),
            Err(_) => continue,
        }
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
        Evt::Error { message, .. } => panic!("attach snapshot failed: {}", message),
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
        Evt::Error { message, .. } => panic!("snapshot failed: {}", message),
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
        terminal_prelude: None,
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

/// Polls snapshots until `needle` appears in the rendered screen.
///
/// This is a liveness wait, not a latency budget: a write acknowledgement is
/// not a render, and the text this waits for either arrives or never does. The
/// ceiling therefore only has to be finite and far enough above scheduler
/// noise that a box running several worktrees' suites cannot trip it — the
/// former bound of 50 polls at 50ms was a 2.5s absolute deadline, tight enough
/// to fail a correct run under load.
fn wait_for_snapshot(conn: &mut ClientConn, session_id: &str, needle: &str) -> SnapshotPayload {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let snapshot = request_snapshot(conn, session_id);
        if snapshot.vt.contains(needle) {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "snapshot for session {:?} never contained {:?}",
            session_id,
            needle
        );
        std::thread::sleep(Duration::from_millis(50));
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
            Evt::StatusChanged { .. } => continue,
            Evt::Error { message, .. } => panic!("input failed: {}", message),
            other => panic!("expected Ok for input, got: {:?}", other),
        }
    }
}

fn expect_session_list_with_timeout(conn: &mut ClientConn, timeout: Duration) -> Vec<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for SessionList");

        match conn.recv_with_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(Evt::SessionList { sessions }) => return sessions,
            Ok(Evt::Output { .. }) | Ok(Evt::StatusChanged { .. }) => continue,
            Ok(Evt::Error { message, .. }) => panic!("list failed: {message}"),
            Ok(other) => panic!("expected SessionList, got: {:?}", other),
            Err(_) => continue,
        }
    }
}

fn session_list_contains(sessions: &[Value], session_id: &str) -> bool {
    sessions
        .iter()
        .any(|session| session["session_id"] == session_id)
}

// ---- Tests ----

#[test]
fn attach_snapshot_delivers_snapshot_then_initial_status() {
    let daemon = DaemonHandle::start();
    let mut creator = daemon.connect();
    spawn_echo_session(&mut creator, "sess-initial-status");

    let mut attached = daemon.connect();
    attached.send(&Cmd::AttachSnapshot {
        session_id: "sess-initial-status".to_string(),
        emulate_terminal: true,
    });

    match attached.recv() {
        Evt::Snapshot { session_id, .. } => {
            assert_eq!(session_id, "sess-initial-status");
        }
        other => panic!("expected initial Snapshot, got: {other:?}"),
    }
    match attached.recv() {
        Evt::StatusChanged { session_id, status } => {
            assert_eq!(session_id, "sess-initial-status");
            assert_eq!(status, SessionStatus::Idle);
        }
        other => panic!("expected initial StatusChanged after Snapshot, got: {other:?}"),
    }
}

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
fn input_ok_waits_for_pty_write_and_acknowledged_input_reaches_output() {
    let daemon = DaemonHandle::start();

    let mut control = daemon.connect();
    spawn_shell_session(
        &mut control,
        "sess-input-ack-stalled",
        "i=0; while :; do i=$((i + 1)); printf 'INPUT-ACK-STALLED-%06d\\r\\n' \"$i\"; done",
    );

    let mut stalled_output = daemon.connect();
    attach(&mut stalled_output, "sess-input-ack-stalled");
    let warmup = stalled_output
        .collect_output_until_contains_with_timeout("INPUT-ACK-STALLED-", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&warmup).contains("INPUT-ACK-STALLED-"),
        "test precondition failed: stalled session output did not arrive"
    );

    let mut stalled_input = daemon.connect();
    stalled_input.send(&Cmd::Input {
        session_id: "sess-input-ack-stalled".to_string(),
        // This is much larger than the PTY input buffer, which cannot drain
        // because the child never reads stdin.
        data: vec![b'x'; 16 * 1024 * 1024],
    });

    // Parsing the large JSON command is synchronous work. Wait for a separate
    // command to complete so the assertion below measures the PTY write, not
    // command parsing time. Input handling enqueues before it yields awaiting
    // the acknowledgement, allowing List to run only after that point.
    control.send(&Cmd::List);
    let sessions = expect_session_list_with_timeout(&mut control, Duration::from_secs(15));
    assert!(
        session_list_contains(&sessions, "sess-input-ack-stalled"),
        "stalled input session should remain live: {sessions:?}"
    );

    stalled_input.assert_no_event_within(Duration::from_millis(500));

    spawn_echo_session(&mut control, "sess-input-ack-echo");
    let mut output = daemon.connect();
    attach(&mut output, "sess-input-ack-echo");

    let mut echo_input = daemon.connect();
    echo_input.send(&Cmd::Input {
        session_id: "sess-input-ack-echo".to_string(),
        data: b"acknowledged-input\n".to_vec(),
    });
    wait_for_ok_with_timeout(
        &mut echo_input,
        "acknowledged echo input",
        Duration::from_secs(2),
    );

    let echoed = output
        .collect_output_until_contains_with_timeout("acknowledged-input", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&echoed).contains("acknowledged-input"),
        "acknowledged input should appear in session output"
    );
}

#[test]
fn empty_input_is_acknowledged_for_a_live_session() {
    let daemon = DaemonHandle::start();

    let mut control = daemon.connect();
    spawn_echo_session(&mut control, "sess-empty-input-ack");

    let mut input = daemon.connect();
    input.send(&Cmd::Input {
        session_id: "sess-empty-input-ack".to_string(),
        data: Vec::new(),
    });
    wait_for_ok_with_timeout(&mut input, "empty input", Duration::from_secs(2));
}

#[test]
fn stalled_pty_input_does_not_block_daemon_or_stop_output_reader() {
    let daemon = DaemonHandle::start();

    let mut control = daemon.connect();
    spawn_shell_session(
        &mut control,
        "sess-stalled-input",
        "i=0; while :; do i=$((i + 1)); printf 'STALLED-OUTPUT-%06d\\r\\n' \"$i\"; done",
    );
    spawn_echo_session(&mut control, "sess-independent");

    let mut attached = daemon.connect();
    attach(&mut attached, "sess-stalled-input");
    let warmup = attached
        .collect_output_until_contains_with_timeout("STALLED-OUTPUT-", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&warmup).contains("STALLED-OUTPUT-"),
        "test precondition failed: spammer output did not arrive"
    );

    let socket_path = daemon.socket_path.clone();
    let input_thread = thread::spawn(move || {
        let mut input_conn = ClientConn::connect(&socket_path);
        let oversized_input = vec![b'x'; 16 * 1024 * 1024];
        input_conn.send(&Cmd::Input {
            session_id: "sess-stalled-input".to_string(),
            data: oversized_input,
        });
        let _ = input_conn.recv_with_timeout(Duration::from_secs(10));
    });

    thread::sleep(Duration::from_millis(300));

    let continued_output = attached
        .collect_output_until_contains_with_timeout("STALLED-OUTPUT-", Duration::from_millis(700));
    assert!(
        String::from_utf8_lossy(&continued_output).contains("STALLED-OUTPUT-"),
        "output reader should keep draining while input to the same PTY is backpressured"
    );

    let mut management = daemon.connect();
    management.send(&Cmd::List);
    let sessions = expect_session_list_with_timeout(&mut management, Duration::from_millis(700));
    assert!(
        sessions
            .iter()
            .any(|session| session["session_id"] == "sess-independent"),
        "unrelated session should still be visible while another session input is backpressured: {sessions:?}"
    );

    management.send(&Cmd::Resize {
        session_id: "sess-independent".to_string(),
        cols: 100,
        rows: 30,
    });
    wait_for_ok_with_timeout(
        &mut management,
        "resize independent",
        Duration::from_millis(700),
    );

    management.send(&Cmd::Kill {
        session_id: "sess-independent".to_string(),
    });
    wait_for_ok_with_timeout(
        &mut management,
        "kill independent",
        Duration::from_millis(700),
    );

    let _ = input_thread.join();
}

#[test]
fn kill_keeps_same_management_connection_responsive() {
    let daemon = DaemonHandle::start();
    let mut management = daemon.connect();

    spawn_shell_session(
        &mut management,
        "sess-kill-responsive",
        "while :; do sleep 1; done",
    );

    management.send(&Cmd::Kill {
        session_id: "sess-kill-responsive".to_string(),
    });
    wait_for_ok_with_timeout(&mut management, "kill session", Duration::from_millis(700));

    management.send(&Cmd::List);
    let sessions = expect_session_list_with_timeout(&mut management, Duration::from_millis(700));
    assert!(
        !session_list_contains(&sessions, "sess-kill-responsive"),
        "killed session should be removed before the same management connection continues: {sessions:?}"
    );

    management.send(&Cmd::Spawn {
        session_id: "sess-after-kill".to_string(),
        executable: "/bin/cat".to_string(),
        args: vec![],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created_with_timeout(
        &mut management,
        "sess-after-kill",
        Duration::from_millis(700),
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
    first_attach.send(&Cmd::AttachSnapshot {
        session_id: "sess-respawn".to_string(),
        emulate_terminal: false,
    });
    let old_ready_in_snapshot = match first_attach.recv() {
        Evt::Snapshot {
            session_id,
            snapshot,
        } => {
            assert_eq!(session_id, "sess-respawn");
            snapshot.vt.contains("OLD_READY")
        }
        Evt::Error { message, .. } => panic!("attach failed: {message}"),
        other => panic!("expected Snapshot, got: {other:?}"),
    };
    if !old_ready_in_snapshot {
        first_attach.wait_for_content_with_timeout("OLD_READY", Duration::from_secs(5));
    }

    kill_session(&mut shared, "sess-respawn");

    spawn_shell_session(
        &mut shared,
        "sess-respawn",
        "printf 'NEW_READY\\r\\n'; while true; do sleep 1; done",
    );

    let mut second_attach = daemon.connect();
    second_attach.send(&Cmd::AttachSnapshot {
        session_id: "sess-respawn".to_string(),
        emulate_terminal: false,
    });
    let ready_in_snapshot = match second_attach.recv() {
        Evt::Snapshot {
            session_id,
            snapshot,
        } => {
            assert_eq!(session_id, "sess-respawn");
            snapshot.vt.contains("NEW_READY")
        }
        Evt::Error { message, .. } => panic!("attach failed: {message}"),
        other => panic!("expected Snapshot, got: {other:?}"),
    };
    if !ready_in_snapshot {
        second_attach.wait_for_content_with_timeout("NEW_READY", Duration::from_secs(5));
    }

    std::thread::sleep(Duration::from_millis(250));
    let snapshot = wait_for_snapshot(&mut shared, "sess-respawn", "NEW_READY");
    assert!(
        snapshot.vt.contains("NEW_READY"),
        "respawned session should survive stale cleanup, got {:?}",
        snapshot.vt
    );
}

#[test]
fn same_id_reuse_waits_for_old_reader_exit_and_recovery_teardown() {
    let daemon = DaemonHandle::start_with_fake_recovery([(
        "KANNA_DAEMON_TEST_SLOW_RECOVERY_WRITE_MS",
        "1200",
    )]);
    let session_id = "sess-linearized-reuse";
    let old_marker = b"OLD_INCARNATION";
    let release_path = daemon._dir.join("release-old-output");

    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    match subscriber.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Subscribe, got: {other:?}"),
    }

    let mut creator = daemon.connect();
    spawn_shell_session(
        &mut creator,
        session_id,
        &format!(
            "while [ ! -f '{}' ]; do sleep 0.01; done; printf 'OLD_INCARNATION\\r\\n'; while :; do sleep 1; done",
            release_path.display()
        ),
    );

    match subscriber.recv() {
        Evt::SessionCreated {
            session_id: created,
        } => {
            assert_eq!(created, session_id);
        }
        other => panic!("expected initial SessionCreated, got: {other:?}"),
    }

    let mut observer = daemon.connect();
    observer.send(&Cmd::Observe {
        session_id: session_id.to_string(),
    });
    match observer.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok for Observe, got: {other:?}"),
    }
    std::fs::write(&release_path, b"go").unwrap();
    loop {
        match observer.recv() {
            Evt::Output {
                session_id: output_session,
                data,
            } if data
                .windows(old_marker.len())
                .any(|window| window == old_marker) =>
            {
                assert_eq!(output_session, session_id);
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected old output before replacement, got: {other:?}"),
        }
    }

    let mut killer = daemon.connect();
    killer.send(&Cmd::Kill {
        session_id: session_id.to_string(),
    });
    wait_for_daemon_log(
        &daemon,
        "[kill] session=sess-linearized-reuse",
        Duration::from_secs(2),
    );
    thread::sleep(Duration::from_millis(50));

    let mut replacement = daemon.connect();
    replacement.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'NEW_INCARNATION\\r\\n'; while :; do sleep 1; done".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created_with_timeout(&mut replacement, session_id, Duration::from_secs(4));
    wait_for_ok_with_timeout(&mut killer, "kill old incarnation", Duration::from_secs(4));

    let mut saw_old_exit = false;
    loop {
        match subscriber.recv() {
            Evt::Exit {
                session_id: exited,
                killed,
                ..
            } => {
                assert_eq!(exited, session_id);
                assert!(killed, "old incarnation Exit must be marked killed");
                saw_old_exit = true;
            }
            Evt::SessionCreated {
                session_id: created,
            } => {
                assert_eq!(created, session_id);
                assert!(
                    saw_old_exit,
                    "replacement SessionCreated preceded the old reader's Exit"
                );
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => {}
            other => panic!("expected old Exit then replacement SessionCreated, got: {other:?}"),
        }
    }

    let commands = wait_for_recovery_log(
        &daemon,
        |commands| {
            commands
                .iter()
                .filter(|command| command["type"] == "StartSession")
                .count()
                >= 2
                && commands
                    .iter()
                    .any(|command| recovery_output_contains(command, old_marker))
                && commands
                    .iter()
                    .any(|command| command["type"] == "EndSession")
        },
        Duration::from_secs(4),
    );
    let replacement_start = commands
        .iter()
        .enumerate()
        .filter(|(_, command)| command["type"] == "StartSession")
        .nth(1)
        .map(|(index, _)| index)
        .expect("replacement recovery session should start");
    assert!(
        commands[..replacement_start]
            .iter()
            .any(|command| recovery_output_contains(command, old_marker)),
        "old recovery output must finish before replacement start: {commands:?}"
    );
    assert!(
        commands[..replacement_start]
            .iter()
            .any(|command| command["type"] == "EndSession"),
        "old recovery teardown must finish before replacement start: {commands:?}"
    );
    assert!(
        !commands[replacement_start + 1..]
            .iter()
            .any(|command| recovery_output_contains(command, old_marker)
                || command["type"] == "EndSession"),
        "old recovery work escaped after replacement start: {commands:?}"
    );

    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        match subscriber.recv_with_timeout(Duration::from_millis(25)) {
            Ok(Evt::Output { data, .. }) => assert!(
                !data
                    .windows(old_marker.len())
                    .any(|window| window == old_marker),
                "old output escaped after replacement SessionCreated"
            ),
            Ok(Evt::StatusChanged { .. }) => {
                panic!("old status escaped after replacement SessionCreated")
            }
            Ok(Evt::Exit { .. }) => panic!("old Exit escaped after replacement SessionCreated"),
            Ok(Evt::SessionCreated { .. } | Evt::Snapshot { .. } | Evt::Ok | Evt::Unknown) => {}
            Ok(Evt::SessionList { .. } | Evt::LogicalInputReleased { .. } | Evt::Error { .. }) => {}
            Err(_) => {}
        }
    }
}

#[test]
fn natural_exit_finalization_precedes_same_id_replacement_creation() {
    let daemon = DaemonHandle::start_with_fake_recovery([(
        "KANNA_DAEMON_TEST_NATURAL_EXIT_FINALIZE_PAUSE_MS",
        "1200",
    )]);
    let session_id = "sess-natural-linearized-reuse";
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    wait_for_ok_with_timeout(
        &mut subscriber,
        "subscribe before natural-exit reuse",
        Duration::from_secs(15),
    );

    let mut creator = daemon.connect();
    creator.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'OLD_NATURAL_INCARNATION\\r\\n'".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created_with_timeout(&mut creator, session_id, Duration::from_secs(15));

    let natural_exit_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = natural_exit_deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for the old incarnation's natural Exit"
        );
        match subscriber.recv_with_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(Evt::SessionCreated {
                session_id: created,
            }) => assert_eq!(created, session_id),
            Ok(Evt::Exit {
                session_id: exited,
                killed,
                ..
            }) => {
                assert_eq!(exited, session_id);
                assert!(!killed);
                break;
            }
            Ok(Evt::Output { .. }) | Ok(Evt::StatusChanged { .. }) | Err(_) => {}
            Ok(other) => panic!("expected natural session lifecycle event, got: {other:?}"),
        }
    }

    let mut replacement = daemon.connect();
    replacement.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'NEW_NATURAL_INCARNATION\\r\\n'; while :; do sleep 1; done".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    assert!(
        replacement
            .recv_with_timeout(Duration::from_millis(250))
            .is_err(),
        "same-id Spawn escaped while natural-exit recovery teardown was still in flight",
    );
    expect_session_created_with_timeout(&mut replacement, session_id, Duration::from_secs(4));

    let commands = wait_for_recovery_log(
        &daemon,
        |commands| {
            commands
                .iter()
                .filter(|command| command["type"] == "StartSession")
                .count()
                >= 2
                && commands
                    .iter()
                    .any(|command| command["type"] == "EndSession")
        },
        Duration::from_secs(4),
    );
    let replacement_start = commands
        .iter()
        .enumerate()
        .filter(|(_, command)| command["type"] == "StartSession")
        .nth(1)
        .map(|(index, _)| index)
        .expect("replacement recovery session should start");
    assert!(
        commands[..replacement_start]
            .iter()
            .any(|command| command["type"] == "EndSession"),
        "old natural-exit recovery teardown must precede replacement start: {commands:?}",
    );
    assert!(
        !commands[replacement_start + 1..]
            .iter()
            .any(|command| command["type"] == "EndSession"),
        "stale natural-exit teardown targeted the replacement incarnation: {commands:?}",
    );

    let mut attached = daemon.connect();
    attach(&mut attached, session_id);
    let output = attached.collect_output_until_contains("NEW_NATURAL_INCARNATION");
    assert!(
        String::from_utf8_lossy(&output).contains("NEW_NATURAL_INCARNATION"),
        "replacement terminal lost its fanout during stale natural-exit cleanup",
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

/// Cross the real socket, PTY reader, headless terminal, status timer, and
/// broadcast path. The byte structure is taken from the checked-in Codex
/// v0.140 capture (`tests/tui-fidelity/fixtures/codex-pwd-tool.ansi`): title
/// spinner updates plus DEC synchronized-output redraws. A parked composer
/// must converge to Idle and a later cosmetic redraw must not publish Busy.
#[test]
fn codex_idle_chrome_repaints_do_not_reactivate_a_real_daemon_session() {
    let daemon = DaemonHandle::start();
    let mut subscriber = daemon.connect();
    subscriber.send(&Cmd::Subscribe);
    assert!(matches!(subscriber.recv(), Evt::Ok));

    let script = concat!(
        "printf '\\033[?2026h\\033[2J\\033[H• Working (43s • esc to interrupt)\\r\\n",
        "› Improve documentation in @filename\\r\\n",
        "gpt-5.5 high · /tmp/kanna-codex-fixture-root\\033[?2026l'; ",
        "sleep 1; ",
        "printf '\\033[?2026h\\033[2J\\033[H• Finished the requested work.\\r\\n",
        "› Improve documentation in @filename\\r\\n",
        "gpt-5.5 high · /tmp/kanna-codex-fixture-root\\033[?2026l'; ",
        "sleep 1; ",
        "printf '\\033]0;⠹ kanna-codex-fixture-root\\007",
        "\\033[?2026h\\033[2J\\033[H• Working (43s • esc to interrupt)\\r\\n'; ",
        "sleep 1; ",
        "printf '\\033[2J\\033[H• Finished the requested work.\\r\\n",
        "› Improve documentation in @filename\\r\\n",
        "gpt-5.5 high · /tmp/kanna-codex-fixture-root\\033[?2026l'; ",
        "sleep 3",
    );
    let session_id = "codex-idle-chrome";
    let mut control = daemon.connect();
    control.send_json(&serde_json::json!({
        "type": "Spawn",
        "session_id": session_id,
        "executable": "/bin/sh",
        "args": ["-c", script],
        "cwd": "/tmp",
        "env": {},
        "cols": 120,
        "rows": 40,
        "agent_provider": "codex",
    }));
    expect_session_created(&mut control, session_id);

    let idle_deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let remaining = idle_deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "parked Codex session never became idle"
        );
        match subscriber.recv_with_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(Evt::StatusChanged {
                session_id: id,
                status: SessionStatus::Idle,
            }) if id == session_id => break,
            Ok(_) | Err(_) => continue,
        }
    }

    let repaint_deadline = Instant::now() + Duration::from_millis(2_500);
    while Instant::now() < repaint_deadline {
        match subscriber.recv_with_timeout(Duration::from_millis(100)) {
            Ok(Evt::StatusChanged {
                session_id: id,
                status: SessionStatus::Busy,
            }) if id == session_id => {
                panic!("idle Codex chrome repaint reactivated the session")
            }
            Ok(_) | Err(_) => {}
        }
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

/// One-way terminal control preserves FIFO order and emits no success events.
#[test]
fn test_one_way_terminal_control_pipelines_without_success_replies() {
    let daemon = DaemonHandle::start();

    let mut setup = daemon.connect();
    spawn_echo_session(&mut setup, "sess-one-way");

    let mut output = daemon.connect();
    attach(&mut output, "sess-one-way");
    output.drain_output(Duration::from_millis(200));

    let mut input = daemon.connect();
    input.send(&Cmd::InputNoReply {
        session_id: "sess-one-way".to_string(),
        data: b"ordered-".to_vec(),
    });
    input.send(&Cmd::ResizeNoReply {
        session_id: "sess-one-way".to_string(),
        cols: 111,
        rows: 39,
    });
    input.send(&Cmd::InputNoReply {
        session_id: "sess-one-way".to_string(),
        data: b"bytes\n".to_vec(),
    });

    assert!(
        input.recv_with_timeout(Duration::from_millis(150)).is_err(),
        "successful one-way terminal commands must not emit acknowledgements"
    );
    let echoed =
        output.collect_output_until_contains_with_timeout("ordered-bytes", Duration::from_secs(2));
    assert!(
        String::from_utf8_lossy(&echoed).contains("ordered-bytes"),
        "later input should not wait for an earlier success reply"
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

/// The subscriber-isolation probes assert strict wall-clock bounds while
/// flooding a PTY; running two floods concurrently starves each other's
/// bounds on loaded machines, so they serialize among themselves.
static FLOOD_PROBE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn non_reading_attached_client_does_not_block_healthy_terminal_output() {
    let _flood_probe_guard = FLOOD_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let daemon = DaemonHandle::start();
    let session_id = "sess-slow-terminal-consumer";
    let dir = atomic_attach_dir("slow-terminal-consumer");

    let mut control = daemon.connect();
    control.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            // Small enough that a healthy client parses the whole flood well
            // inside the strict bound even on a loaded machine, large enough
            // to saturate a non-reading subscriber's socket buffers.
            "while [ ! -f go ]; do sleep 0.01; done; head -c 16384 /dev/zero | tr '\\000' X; printf '\\r\\nFLOOD_DONE\\r\\n'; cat"
                .to_string(),
        ],
        cwd: dir.display().to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created(&mut control, session_id);

    // Both clients attach before the flood. `stalled` never reads another
    // byte, reproducing a WebSocket/KSP consumer that has stopped draining
    // terminal frames; its clamped receive buffer guarantees its socket
    // saturates within the first few chunks instead of the OS absorbing the
    // whole flood.
    let mut stalled = daemon.connect();
    stalled.clamp_recv_buffer(4096);
    attach(&mut stalled, session_id);
    let mut healthy = daemon.connect();
    attach(&mut healthy, session_id);

    let flood_started = Instant::now();
    std::fs::write(dir.join("go"), b"go").unwrap();

    // Zero-delay requirement: the healthy client must receive the entire
    // flood while the stalled client's socket is saturated. The regression
    // this guards is the 500ms per-chunk write timeout being paid for every
    // chunk the stalled subscriber cannot take — a 16 KiB flood into a
    // 4096-byte receive buffer, so seconds, not milliseconds. The ceiling
    // therefore only has to be an order of magnitude under that, which keeps
    // it out of reach of scheduler noise on a box running several suites.
    healthy.collect_output_until_contains_with_timeout("FLOOD_DONE", Duration::from_millis(2_000));
    let flood_latency = flood_started.elapsed();
    assert!(
        flood_latency < Duration::from_millis(2_000),
        "healthy delivery must not wait on the stalled subscriber; took {flood_latency:?}"
    );

    control.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"HEALTHY_MARKER\n".to_vec(),
    });
    let output = healthy
        .collect_output_until_contains_with_timeout("HEALTHY_MARKER", Duration::from_millis(2_000));
    let output = String::from_utf8_lossy(&output);
    let marker = output
        .find("HEALTHY_MARKER")
        .expect("healthy reader should observe input while the stalled client is saturated");
    if let Some(flood_done) = output.find("FLOOD_DONE") {
        assert!(
            flood_done < marker,
            "healthy output must remain ordered: {output:?}"
        );
    }

    // Later chunks must keep taking the ordinary fast path.
    control.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"SECOND_HEALTHY_MARKER\n".to_vec(),
    });
    let second = healthy.collect_output_until_contains_with_timeout(
        "SECOND_HEALTHY_MARKER",
        Duration::from_millis(300),
    );
    assert!(String::from_utf8_lossy(&second).contains("SECOND_HEALTHY_MARKER"));

    // Prove real socket backpressure occurred on the stalled subscriber's
    // writer stream: its socket write must have blocked long enough to emit
    // a stall diagnostic. Without this the flood could fit entirely inside
    // kernel buffers and the test would pass without testing anything.
    wait_for_daemon_log(
        &daemon,
        "stage=attached_writer event=stall",
        Duration::from_secs(5),
    );

    drop(stalled);
    cleanup_atomic_attach_dir(&dir);
}

#[test]
fn stalled_observer_does_not_delay_healthy_subscriber_or_pty_ingestion() {
    let _flood_probe_guard = FLOOD_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let daemon = DaemonHandle::start();
    let session_id = "sess-stalled-observer";
    let dir = atomic_attach_dir("stalled-observer");

    let mut control = daemon.connect();
    control.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while [ ! -f go ]; do sleep 0.01; done; head -c 65536 /dev/zero | tr '\\000' X; printf '\\r\\nFLOOD_DONE\\r\\n'; cat"
                .to_string(),
        ],
        cwd: dir.display().to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created(&mut control, session_id);

    // A passive observer that stops reading models the relay observer whose
    // shared WebSocket sink is under backpressure (the cloud-workspace
    // remote terminal path). Its daemon-side write historically had no
    // timeout at all, so this saturation froze PTY ingestion indefinitely.
    // The clamped receive buffer guarantees the saturation actually happens
    // instead of the OS absorbing the whole flood.
    let mut stalled_observer = daemon.connect();
    stalled_observer.clamp_recv_buffer(4096);
    observe(&mut stalled_observer, session_id);

    let mut healthy = daemon.connect();
    attach(&mut healthy, session_id);

    std::fs::write(dir.join("go"), b"go").unwrap();

    healthy.collect_output_until_contains_with_timeout("FLOOD_DONE", Duration::from_millis(1_500));

    // PTY ingestion itself must keep advancing while the observer is
    // saturated: new input has to reach the authoritative headless terminal.
    control.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"OBSERVER_ISOLATION_MARKER\n".to_vec(),
    });
    healthy.collect_output_until_contains_with_timeout(
        "OBSERVER_ISOLATION_MARKER",
        Duration::from_millis(350),
    );
    wait_for_snapshot(&mut control, session_id, "OBSERVER_ISOLATION_MARKER");

    // Prove the observer's writer stream really hit socket backpressure —
    // the isolation above is only meaningful if its socket write blocked.
    wait_for_daemon_log(
        &daemon,
        "stage=observer_write event=stall",
        Duration::from_secs(5),
    );

    drop(stalled_observer);
    cleanup_atomic_attach_dir(&dir);
}

#[test]
fn overflowing_subscriber_resyncs_from_fresh_snapshot_without_delaying_healthy() {
    let _flood_probe_guard = FLOOD_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // A small per-subscriber byte budget lets a modest flood overflow the
    // mailbox without pushing megabytes through debug-build JSON parsing.
    let daemon =
        DaemonHandle::start_with_env([("KANNA_DAEMON_TEST_SUBSCRIBER_MAILBOX_MAX_BYTES", "16384")]);
    let session_id = "sess-overflowing-subscriber";
    let dir = atomic_attach_dir("overflowing-subscriber");

    let mut control = daemon.connect();
    control.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            // Enough serialized volume to overflow the reduced byte budget on
            // top of the kernel socket buffers.
            "while [ ! -f go ]; do sleep 0.01; done; head -c 32768 /dev/zero | tr '\\000' X; printf '\\r\\nFLOOD_DONE\\r\\n'; cat"
                .to_string(),
        ],
        cwd: dir.display().to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created(&mut control, session_id);

    let mut stalled = daemon.connect();
    stalled.clamp_recv_buffer(4096);
    attach(&mut stalled, session_id);
    let mut healthy = daemon.connect();
    attach(&mut healthy, session_id);

    std::fs::write(dir.join("go"), b"go").unwrap();

    // The healthy subscriber observes the end of the flood promptly while the
    // stalled subscriber's backlog overflows its byte budget.
    healthy.wait_for_content_with_timeout("FLOOD_DONE", Duration::from_secs(5));

    // The lagging subscriber is not disconnected: once it resumes reading and
    // drains its bounded backlog, the daemon resynchronizes it in place with
    // a fresh authoritative snapshot that contains the content it missed.
    stalled.wait_for_content_with_timeout("FLOOD_DONE", Duration::from_secs(15));

    // After the resync the recovered subscriber streams live output again,
    // and the session stayed healthy for everyone.
    control.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"POST_OVERFLOW_MARKER\n".to_vec(),
    });
    healthy.wait_for_content_with_timeout("POST_OVERFLOW_MARKER", Duration::from_millis(500));
    stalled.wait_for_content_with_timeout("POST_OVERFLOW_MARKER", Duration::from_secs(5));
    wait_for_snapshot(&mut control, session_id, "POST_OVERFLOW_MARKER");

    // Prove the byte-budget overflow and the in-place resync actually
    // happened rather than the kernel quietly buffering the whole flood.
    wait_for_daemon_log(
        &daemon,
        "stage=attached_writer event=lag",
        Duration::from_secs(5),
    );
    wait_for_daemon_log(
        &daemon,
        "stage=attached_writer event=recovered",
        Duration::from_secs(5),
    );

    cleanup_atomic_attach_dir(&dir);
}

#[test]
fn overflowing_observer_resyncs_with_fresh_snapshot_then_live_output() {
    let _flood_probe_guard = FLOOD_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let daemon =
        DaemonHandle::start_with_env([("KANNA_DAEMON_TEST_SUBSCRIBER_MAILBOX_MAX_BYTES", "16384")]);
    let session_id = "sess-overflowing-observer";
    let dir = atomic_attach_dir("overflowing-observer");

    let mut control = daemon.connect();
    control.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while [ ! -f go ]; do sleep 0.01; done; head -c 32768 /dev/zero | tr '\\000' X; printf '\\r\\nFLOOD_DONE\\r\\n'; cat"
                .to_string(),
        ],
        cwd: dir.display().to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created(&mut control, session_id);

    let mut observer = daemon.connect();
    observer.clamp_recv_buffer(4096);
    observe(&mut observer, session_id);
    let mut healthy = daemon.connect();
    attach(&mut healthy, session_id);

    std::fs::write(dir.join("go"), b"go").unwrap();

    healthy.wait_for_content_with_timeout("FLOOD_DONE", Duration::from_secs(5));
    wait_for_daemon_log(
        &daemon,
        "stage=observer_write event=lag",
        Duration::from_secs(5),
    );

    // Once the observer resumes reading and drains its bounded backlog, the
    // daemon resyncs it in place: it must observe a fresh mid-stream Snapshot
    // event containing the content it missed…
    let resync_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(
            Instant::now() < resync_deadline,
            "observer never received a resync snapshot containing the missed flood tail"
        );
        match observer.recv_with_timeout(Duration::from_millis(100)) {
            Ok(Evt::Snapshot { snapshot, .. }) if snapshot.vt.contains("FLOOD_DONE") => break,
            Ok(_) | Err(_) => {}
        }
    }
    match observer.recv() {
        Evt::StatusChanged { session_id, status } => {
            assert_eq!(session_id, "sess-overflowing-observer");
            assert_eq!(status, SessionStatus::Idle);
        }
        other => panic!("expected current status after resync snapshot, got: {other:?}"),
    }
    wait_for_daemon_log(
        &daemon,
        "stage=observer_write event=recovered",
        Duration::from_secs(5),
    );

    // …followed by live Output again.
    control.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"OBSERVER_FRESH_MARKER\n".to_vec(),
    });
    let fresh = observer.collect_output_until_contains_with_timeout(
        "OBSERVER_FRESH_MARKER",
        Duration::from_secs(5),
    );
    assert!(String::from_utf8_lossy(&fresh).contains("OBSERVER_FRESH_MARKER"));

    cleanup_atomic_attach_dir(&dir);
}

#[test]
fn same_connection_reattach_discards_stale_backlog_behind_fresh_snapshot() {
    let _flood_probe_guard = FLOOD_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let daemon = DaemonHandle::start();
    let session_id = "sess-reattach-cutover-boundary";
    let dir = atomic_attach_dir("reattach-cutover-boundary");

    let mut control = daemon.connect();
    control.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            // 'S' fill marks stale pre-reattach output; the flood exceeds the
            // clamped socket buffers so the subject's mailbox holds a backlog
            // when it re-attaches.
            "while [ ! -f go ]; do sleep 0.01; done; head -c 65536 /dev/zero | tr '\\000' S; printf '\\r\\nSTALE_DONE\\r\\n'; : > flooded; cat"
                .to_string(),
        ],
        cwd: dir.display().to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        terminal_prelude: None,
    });
    expect_session_created(&mut control, session_id);

    let mut subject = daemon.connect();
    subject.clamp_recv_buffer(4096);
    attach(&mut subject, session_id);

    // Build pending output the subject has not read.
    std::fs::write(dir.join("go"), b"go").unwrap();
    wait_for_file(&dir.join("flooded"));
    thread::sleep(Duration::from_millis(300));

    // Re-attach on the same connection while the backlog is queued. The fresh
    // Snapshot must be the cutover boundary: queued Output from the replaced
    // registration must never be delivered after it.
    subject.send(&Cmd::AttachSnapshot {
        session_id: session_id.to_string(),
        emulate_terminal: false,
    });

    // Drain until the reattach Snapshot arrives (stale output before it is
    // expected — it was already on the wire or in socket buffers).
    let snapshot_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            Instant::now() < snapshot_deadline,
            "reattach snapshot never arrived"
        );
        if let Ok(Evt::Snapshot {
            session_id: sid, ..
        }) = subject.recv_with_timeout(Duration::from_millis(100))
        {
            assert_eq!(sid, session_id);
            break;
        }
    }

    // Everything after the Snapshot must be post-cutover: request fresh live
    // output and require that no stale flood bytes appear before it.
    control.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"FRESH_AFTER_REATTACH\n".to_vec(),
    });
    let post_snapshot_deadline = Instant::now() + Duration::from_secs(10);
    let mut post_snapshot_output = Vec::new();
    loop {
        assert!(
            Instant::now() < post_snapshot_deadline,
            "fresh output never arrived after the reattach snapshot; got {:?}",
            String::from_utf8_lossy(&post_snapshot_output)
        );
        match subject.recv_with_timeout(Duration::from_millis(100)) {
            Ok(Evt::Output { data, .. }) => {
                post_snapshot_output.extend_from_slice(&data);
                let text = String::from_utf8_lossy(&post_snapshot_output);
                assert!(
                    !text.contains("SSSSSSSS"),
                    "stale pre-reattach output was delivered after the fresh snapshot: {text:?}"
                );
                if text.contains("FRESH_AFTER_REATTACH") {
                    break;
                }
            }
            Ok(Evt::Snapshot { .. }) => {
                panic!("unexpected extra snapshot after the reattach cutover")
            }
            Ok(_) | Err(_) => {}
        }
    }

    cleanup_atomic_attach_dir(&dir);
}

/// Observer cutover must be atomic while output is actively flowing: the
/// snapshot is the observer's first event, and every numbered line lands in
/// exactly one of {snapshot, later Output} — no losses, no duplicates.
#[test]
fn observe_snapshot_cutover_partitions_live_output_exactly() {
    let daemon = DaemonHandle::start();
    let session_id = "sess-observe-cutover";
    let mut control = daemon.connect();
    spawn_shell_session(
        &mut control,
        session_id,
        "i=0; while :; do i=$((i + 1)); printf 'CUT-%06d\\r\\n' \"$i\"; sleep 0.005; done",
    );
    wait_for_snapshot(&mut control, session_id, "CUT-");

    // Register mid-stream so the cutover happens between live chunks.
    let mut observer = daemon.connect();
    let snapshot = observe_snapshot(&mut observer, session_id);

    fn parse_numbers(text: &str) -> Vec<u64> {
        let mut numbers = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find("CUT-") {
            let digits = &rest[start + 4..];
            let end = digits
                .char_indices()
                .find(|(_, c)| !c.is_ascii_digit())
                .map(|(i, _)| i)
                .unwrap_or(digits.len());
            // Only complete 6-digit numbers count; a trailing partial line
            // (mid-write at the boundary) is resolved by the Output side.
            if end == 6 {
                numbers.push(digits[..6].parse::<u64>().unwrap());
            }
            rest = &digits[end..];
        }
        numbers
    }

    let snapshot_numbers = parse_numbers(&snapshot.vt);
    let last_in_snapshot = *snapshot_numbers
        .last()
        .expect("snapshot should contain numbered output");

    // Collect live output until well past the boundary.
    let mut live = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    let live_numbers = loop {
        assert!(
            Instant::now() < deadline,
            "observer never received enough live output after the snapshot"
        );
        match observer.recv_with_timeout(Duration::from_millis(200)) {
            Ok(Evt::Output { data, .. }) => {
                live.extend_from_slice(&data);
                let numbers = parse_numbers(&String::from_utf8_lossy(&live));
                if numbers.len() >= 15 {
                    break numbers;
                }
            }
            Ok(Evt::Snapshot { .. }) => panic!("unexpected extra snapshot after observer cutover"),
            Ok(_) | Err(_) => {}
        }
    };

    // Exact partition at the boundary: live output continues at the very
    // next number after the snapshot (nothing lost, nothing duplicated)
    // and stays contiguous.
    assert_eq!(
        live_numbers[0],
        last_in_snapshot + 1,
        "snapshot ended at {last_in_snapshot}; live output must continue exactly there: {live_numbers:?}"
    );
    for window in live_numbers.windows(2) {
        assert_eq!(
            window[1],
            window[0] + 1,
            "live output after the cutover must stay contiguous: {live_numbers:?}"
        );
    }
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
    // The injected persistence delay and the latency ceiling below move
    // together: live echo has to land an order of magnitude inside the delay,
    // not merely beat it. Raising both keeps that ratio while leaving the
    // ceiling well clear of what a loaded box adds to a PTY round trip.
    let daemon = DaemonHandle::start_with_fake_recovery([(
        "KANNA_DAEMON_TEST_SLOW_RECOVERY_WRITE_MS",
        "6000",
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
        attached.collect_output_until_contains_with_timeout(marker, Duration::from_millis(3_000));
    assert!(
        String::from_utf8_lossy(&output).contains(marker),
        "attached PTY client should receive echoed input before slow recovery bookkeeping"
    );
    assert!(
        started.elapsed() < Duration::from_millis(3_000),
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
        terminal_prelude: None,
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

#[test]
fn connection_drop_cleanup_removes_attached_and_observer_writers() {
    let daemon = DaemonHandle::start();
    let mut shared = daemon.connect();
    spawn_shell_session(
        &mut shared,
        "sess-fd-cleanup",
        "while true; do sleep 1; done",
    );

    {
        let mut warmup = daemon.connect();
        attach_emulating_terminal(&mut warmup, "sess-fd-cleanup");
        resize(&mut warmup, "sess-fd-cleanup", 100, 30);
        observe(&mut warmup, "sess-fd-cleanup");
    }

    thread::sleep(Duration::from_millis(250));
    let baseline = daemon_fd_count(daemon.child.id());
    let client_count = 64;
    let mut clients = Vec::with_capacity(client_count);

    for index in 0..client_count {
        let mut client = daemon.connect();
        attach_emulating_terminal(&mut client, "sess-fd-cleanup");
        resize(&mut client, "sess-fd-cleanup", 100 + (index % 5) as u16, 30);
        observe(&mut client, "sess-fd-cleanup");
        clients.push(client);
    }

    let inflated = daemon_fd_count(daemon.child.id());
    assert!(
        inflated >= baseline + client_count / 2,
        "daemon fd count should grow while real attached/observer clients are connected; baseline={baseline}, inflated={inflated}"
    );

    drop(clients);

    let final_count =
        wait_for_daemon_fd_count_at_most(daemon.child.id(), baseline + 6, Duration::from_secs(5));
    assert!(
        final_count <= baseline + 6,
        "daemon fd count should return near baseline after client drops; baseline={baseline}, final={final_count}"
    );
}

#[test]
fn connection_drop_cleanup_removes_subscriber_writers() {
    let daemon = DaemonHandle::start();

    thread::sleep(Duration::from_millis(250));
    let baseline = daemon_fd_count(daemon.child.id());
    let client_count = 64;
    let mut clients = Vec::with_capacity(client_count);

    for _ in 0..client_count {
        let mut client = daemon.connect();
        client.send(&Cmd::Subscribe);
        match client.recv() {
            Evt::Ok => {}
            other => panic!("expected Ok for Subscribe, got: {:?}", other),
        }
        clients.push(client);
    }

    let inflated = daemon_fd_count(daemon.child.id());
    assert!(
        inflated >= baseline + client_count / 2,
        "daemon fd count should grow while subscriber clients are connected; baseline={baseline}, inflated={inflated}"
    );

    drop(clients);

    let final_count =
        wait_for_daemon_fd_count_at_most(daemon.child.id(), baseline + 6, Duration::from_secs(5));
    assert!(
        final_count <= baseline + 6,
        "daemon fd count should return near baseline after subscriber drops; baseline={baseline}, final={final_count}"
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
