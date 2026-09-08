#![cfg(any(target_os = "macos", target_os = "linux"))]

//! Integration tests for daemon handoff (session transfer on upgrade).
//!
//! These tests spawn real daemon processes and verify that:
//!   - New daemon takes over sessions from old daemon
//!   - Child processes survive the transfer
//!   - I/O works through the new daemon after handoff
//!   - Handoff with no active sessions works
//!   - Old daemon exits after handoff

mod support;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kanna_daemon::protocol::{AgentProvider, AgentSpawnParams, NeutralAgentEvent, SeqAgentEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Eventual process/socket progress in these integration fixtures has no
/// product latency contract. This deadline only contains a wedged child.
const EVENTUAL_PROGRESS_GUARD: Duration = Duration::from_secs(30);

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
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_provider: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        operator_input_only: bool,
    },
    AttachSnapshot {
        session_id: String,
    },
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    InputBoundary {
        session_id: String,
        data: Vec<u8>,
    },
    InputNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    InputBoundaryNoReply {
        session_id: String,
        data: Vec<u8>,
    },
    SubmitInput {
        session_id: String,
        data: Vec<u8>,
    },
    ClassifyInput {
        session_id: String,
        operator_input_only: bool,
    },
    AuthorizeServer {
        pid: u32,
    },
    NegotiateProtectedInput {
        version: u32,
    },
    Snapshot {
        session_id: String,
    },
    Kill {
        session_id: String,
    },
    Signal {
        session_id: String,
        signal: String,
    },
    SpawnAgent {
        session_id: String,
        params: AgentSpawnParams,
    },
    AttachAgent {
        session_id: String,
        from_seq: u64,
    },
    AgentInput {
        session_id: String,
        text: String,
    },
    List,
    Subscribe,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
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
    HandoffUnauthorized,
    HandoffVersionMismatch,
    PtySpawnFailed,
    PtyCloneFailed,
    HeadlessTerminalInitFailed,
    WriteFailed,
    UnknownSignal,
    AgentSpawnFailed,
    NotAgentSession,
    UnknownPermissionRequest,
    RetryOnSuccessor,
    InputUnauthorized,
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
    ComposerChanged {
        session_id: String,
        composer_text: Option<String>,
        composer_attestation: String,
    },
    AgentSnapshot {
        session_id: String,
        next_seq: u64,
        events: Vec<SeqAgentEvent>,
    },
    AgentEvent {
        session_id: String,
        seq: u64,
        event: NeutralAgentEvent,
    },
    Ok,
    ProtectedInputReady {
        version: u32,
    },
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

/// Wait for the exact daemon generation to publish a connectable socket.
///
/// The PID file is written immediately before the socket is bound, so seeing
/// the new PID alone is not readiness. Production clients require both this
/// PID and a connectable socket (and then authenticate the peer PID); the test
/// harness must observe the same publication boundary.
fn wait_for_published_socket(pid_path: &Path, socket_path: &Path, expected_pid: u32) -> UnixStream {
    let deadline = Instant::now() + EVENTUAL_PROGRESS_GUARD;
    let mut last_pid;
    let mut last_connect_error = None;
    loop {
        last_pid = std::fs::read_to_string(pid_path)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok());
        if last_pid == Some(expected_pid) {
            match UnixStream::connect(socket_path) {
                Ok(stream) => return stream,
                Err(error) => last_connect_error = Some(error),
            }
        }
        assert!(
            Instant::now() < deadline,
            "daemon {expected_pid} never published a connectable socket at {} (published pid: \
             {last_pid:?}, last connect error: {last_connect_error:?})",
            socket_path.display(),
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
    daemon_dir: PathBuf,
}

impl DaemonHandle {
    /// Start a daemon in the given directory. If a daemon is already running
    /// there (from a previous start), the new one will attempt handoff.
    fn start_in(dir: &PathBuf) -> Self {
        Self::start_in_with_env(dir, &[])
    }

    fn start_in_with_env(dir: &PathBuf, extra_env: &[(&str, &str)]) -> Self {
        Self::start_binary_in_with_env(
            Path::new(env!("CARGO_BIN_EXE_kanna-daemon")),
            dir,
            extra_env,
        )
    }

    fn start_binary_in(binary: &Path, dir: &PathBuf) -> Self {
        Self::start_binary_in_with_env(binary, dir, &[])
    }

    fn start_binary_in_with_env(binary: &Path, dir: &PathBuf, extra_env: &[(&str, &str)]) -> Self {
        std::fs::create_dir_all(dir).unwrap();

        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");

        let mut command = Command::new(binary);
        command.env("KANNA_DAEMON_DIR", dir.to_str().unwrap());
        command.stdout(Stdio::null()).stderr(Stdio::null());
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let child = command.spawn().expect("failed to start daemon");

        let expected_pid = child.id();

        // This is an eventual readiness invariant, not a ten-second startup
        // contract. The helper returns only after the socket is usable.
        drop(wait_for_published_socket(
            &pid_path,
            &socket_path,
            expected_pid,
        ));

        // Verify our daemon is running
        let actual_pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        assert_eq!(actual_pid, expected_pid, "PID file should match our daemon");

        DaemonHandle {
            child,
            socket_path,
            daemon_dir: dir.clone(),
        }
    }

    fn start_in_with_path_env(dir: &PathBuf, extra_env: &[(&str, &Path)]) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");
        let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-daemon"));
        command.env("KANNA_DAEMON_DIR", dir.to_str().unwrap());
        command.stdout(Stdio::null()).stderr(Stdio::null());
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let child = command.spawn().expect("failed to start daemon");
        let expected_pid = child.id();
        drop(wait_for_published_socket(
            &pid_path,
            &socket_path,
            expected_pid,
        ));
        let actual_pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(0);
        assert_eq!(actual_pid, expected_pid, "PID file should match our daemon");
        DaemonHandle {
            child,
            socket_path,
            daemon_dir: dir.clone(),
        }
    }

    fn connect(&self) -> ClientConn {
        self.connect_with_read_timeout(Duration::from_secs(5))
    }

    fn connect_with_read_timeout(&self, read_timeout: Duration) -> ClientConn {
        let stream = UnixStream::connect(&self.socket_path).expect("failed to connect");
        stream.set_read_timeout(Some(read_timeout)).unwrap();
        ClientConn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }

    fn wait_for_log(&self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let pid = self.child.id().to_string();
            let log = std::fs::read_dir(&self.daemon_dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    name.starts_with("kanna-daemon_") && name.contains(&pid)
                })
                .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
                .collect::<Vec<_>>()
                .join("\n");
            if log.contains(needle) || Instant::now() >= deadline {
                return log;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_replacement_without_wait(dir: &Path, extra_env: &[(&str, &str)]) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-daemon"));
    command
        .env("KANNA_DAEMON_DIR", dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    command.spawn().expect("failed to start replacement daemon")
}

fn install_test_daemon_at(source: &Path, destination: &Path) {
    let staged = destination.with_extension(format!("next-{}", std::process::id()));
    std::fs::copy(source, &staged).expect("stage daemon executable");
    std::fs::rename(&staged, destination).expect("install daemon executable");
}

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

/// A delivered logical message is never withheld: whatever is on that
/// composer, the daemon writes the message and its submission boundary. These
/// tests are about that delivery surviving a handoff.
fn expect_delivered(connection: &mut ClientConn) {
    loop {
        match connection.recv() {
            Evt::Ok => break,
            Evt::Output { .. } | Evt::StatusChanged { .. } | Evt::ComposerChanged { .. } => {
                continue
            }
            other => panic!("expected a delivered answer, got: {other:?}"),
        }
    }
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

    fn try_round_trip_until(
        &mut self,
        cmd: &Cmd,
        expected: impl Fn(&Evt) -> bool,
    ) -> Result<Evt, String> {
        let mut json = serde_json::to_string(cmd).map_err(|error| error.to_string())?;
        json.push('\n');
        self.writer
            .write_all(json.as_bytes())
            .and_then(|_| self.writer.flush())
            .map_err(|error| error.to_string())?;
        loop {
            let mut line = String::new();
            let read = self
                .reader
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Err("daemon disconnected before replying".to_string());
            }
            let event: Evt =
                serde_json::from_str(line.trim()).map_err(|error| format!("{error}: {line:?}"))?;
            if expected(&event) {
                return Ok(event);
            }
            match event {
                Evt::StatusChanged { .. } => {}
                Evt::Error { code, message } => {
                    return Err(format!("daemon returned {code:?}: {message}"));
                }
                other => return Err(format!("unexpected daemon reply: {other:?}")),
            }
        }
    }

    fn recv_with_timeout(&mut self, timeout: Duration) -> Result<Evt, String> {
        self.reader
            .get_mut()
            .set_read_timeout(Some(timeout))
            .map_err(|error| format!("set read timeout: {error}"))?;
        let mut line = String::new();
        let result = match self.reader.read_line(&mut line) {
            Ok(0) => Err("connection closed".to_string()),
            Ok(_) => serde_json::from_str(line.trim())
                .map_err(|error| format!("failed to parse {line:?}: {error}")),
            Err(error) => Err(format!("read failed: {error}")),
        };
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|error| format!("restore read timeout: {error}"))?;
        result
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
        agent_provider: None,
        operator_input_only: false,
    });
    loop {
        match conn.recv() {
            Evt::SessionCreated { .. } => break,
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            other => panic!("expected SessionCreated, got: {:?}", other),
        }
    }
}

/// A session that paints provider frames and then parks, the way a singleton
/// agent sits between requests. The script keeps the child alive, so the
/// session stays adoptable and its raw input stays observable.
fn spawn_provider_frame(
    conn: &mut ClientConn,
    id: &str,
    provider: &str,
    script: &str,
    env: HashMap<String, String>,
) {
    conn.send(&Cmd::Spawn {
        session_id: id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        cwd: "/tmp".to_string(),
        env,
        cols: 80,
        rows: 24,
        agent_provider: Some(provider.to_string()),
        operator_input_only: false,
    });
    loop {
        match conn.recv() {
            Evt::SessionCreated { .. } => break,
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            other => panic!("expected SessionCreated, got: {:?}", other),
        }
    }
}

/// What `List` says about one session's composer attestation — the field
/// kanna-server reconciles onto the task on every daemon generation.
fn session_composer_attestation(conn: &mut ClientConn, session_id: &str) -> String {
    conn.send(&Cmd::List);
    loop {
        match conn.recv() {
            Evt::SessionList { sessions } => {
                let session = sessions
                    .iter()
                    .find(|session| session["session_id"] == session_id)
                    .unwrap_or_else(|| panic!("{session_id} missing from List"));
                return session["composer_attestation"]
                    .as_str()
                    .expect("a listed session reports an attestation")
                    .to_string();
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } | Evt::ComposerChanged { .. } => {
                continue
            }
            other => panic!("expected SessionList, got: {other:?}"),
        }
    }
}

fn expect_session_created_with_timeout(conn: &mut ClientConn, session_id: &str, timeout: Duration) {
    match conn.recv_with_timeout(timeout) {
        Ok(Evt::SessionCreated {
            session_id: created,
        }) => assert_eq!(created, session_id),
        other => panic!("expected SessionCreated for {session_id}, got: {other:?}"),
    }
}

fn kill_session(conn: &mut ClientConn, id: &str) {
    conn.send(&Cmd::Kill {
        session_id: id.to_string(),
    });
    loop {
        match conn.recv() {
            Evt::Ok => break,
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => panic!("kill failed: {:?}: {}", code, message),
            other => panic!("expected Ok after Kill, got: {:?}", other),
        }
    }
}

fn recv_fds_nonblocking(socket_fd: std::os::fd::RawFd) -> Vec<std::os::fd::RawFd> {
    let mut payload = [0u8; 1];
    let mut iov = libc::iovec {
        iov_base: payload.as_mut_ptr().cast(),
        iov_len: payload.len(),
    };
    let mut control = [0u8; 256];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = control.len() as _;

    let received = unsafe { libc::recvmsg(socket_fd, &mut message, libc::MSG_DONTWAIT) };
    if received < 0 {
        let error = std::io::Error::last_os_error();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::WouldBlock,
            "unexpected recvmsg error: {error}"
        );
        return Vec::new();
    }

    let mut fds = Vec::new();
    let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    while !header.is_null() {
        let current = unsafe { &*header };
        if current.cmsg_level == libc::SOL_SOCKET && current.cmsg_type == libc::SCM_RIGHTS {
            let header_len = unsafe { libc::CMSG_LEN(0) as usize };
            let payload_len = (current.cmsg_len as usize).saturating_sub(header_len);
            let count = payload_len / std::mem::size_of::<std::os::fd::RawFd>();
            let data = unsafe { libc::CMSG_DATA(header).cast::<std::os::fd::RawFd>() };
            for index in 0..count {
                fds.push(unsafe { *data.add(index) });
            }
        }
        header = unsafe { libc::CMSG_NXTHDR(&message, header) };
    }
    fds
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

fn wait_for_session_status(
    conn: &mut ClientConn,
    session_id: &str,
    expected: SessionStatus,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;
    let expected = serde_json::to_value(expected).unwrap();
    loop {
        conn.send(&Cmd::List);
        match conn.recv() {
            Evt::SessionList { sessions } => {
                if sessions.iter().any(|session| {
                    session["session_id"] == session_id && session["status"] == expected
                }) {
                    return;
                }
            }
            Evt::Error { code, message } => panic!("list failed: {:?}: {}", code, message),
            other => panic!("expected SessionList, got: {:?}", other),
        }
        assert!(
            Instant::now() < deadline,
            "session {session_id:?} never reached status {expected:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
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

fn send_input_boundary(conn: &mut ClientConn, id: &str, data: &[u8]) -> Vec<u8> {
    conn.send(&Cmd::InputBoundary {
        session_id: id.to_string(),
        data: data.to_vec(),
    });
    let mut output = Vec::new();
    loop {
        match conn.recv() {
            Evt::Ok => break output,
            Evt::Output { data, .. } => output.extend_from_slice(&data),
            Evt::StatusChanged { .. } => continue,
            Evt::Error { code, message } => {
                panic!("boundary input failed: {:?}: {}", code, message)
            }
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

fn send_input_boundary_and_wait_for_echo(
    conn: &mut ClientConn,
    id: &str,
    data: &[u8],
    expected: &str,
) {
    let mut output = send_input_boundary(conn, id, data);
    while !String::from_utf8_lossy(&output).contains(expected) {
        match conn.recv() {
            Evt::Output { data, .. } => output.extend_from_slice(&data),
            Evt::StatusChanged { .. } => continue,
            Evt::Exit { .. } => break,
            other => panic!("expected Output while waiting for {expected:?}, got: {other:?}"),
        }
    }
    assert!(String::from_utf8_lossy(&output).contains(expected));
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
                        stream
                            .set_nonblocking(false)
                            .expect("fake daemon stream should become blocking");
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

fn read_handoff_adopted(stream: &mut UnixStream, expected_version: u32) {
    let mut line = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut line)
        .expect("failed to read handoff acknowledgement");
    let value: Value =
        serde_json::from_str(line.trim()).expect("invalid handoff acknowledgement json");
    assert_eq!(value["type"], "HandoffAdopted");
    assert_eq!(value["version"], expected_version);
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

const STEERABLE_AGENT: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"handoff-v2-agent","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from v2"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"handoff-v2-agent"}'
while read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"steered after handoff"}]}}'
  echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":2,"total_cost_usd":0.02,"usage":{},"session_id":"handoff-v2-agent"}'
done
"#;

fn write_steerable_agent(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = dir.join("handoff-v2-agent.sh");
    std::fs::write(&path, STEERABLE_AGENT).expect("write fake agent");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("make fake agent executable");
    path
}

fn agent_params(script: &Path, prompt: &str) -> AgentSpawnParams {
    AgentSpawnParams {
        agent_provider: AgentProvider::Claude,
        prompt: prompt.to_string(),
        cwd: script
            .parent()
            .expect("fake agent parent")
            .to_string_lossy()
            .to_string(),
        env: HashMap::new(),
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tools: Vec::new(),
        disallowed_tools: Vec::new(),
        max_turns: None,
        max_budget_usd: None,
        system_prompt: None,
        mcp_config_path: None,
        executable: Some(script.to_string_lossy().to_string()),
    }
}

fn spawn_agent(conn: &mut ClientConn, id: &str, script: &Path, prompt: &str) {
    conn.send(&Cmd::SpawnAgent {
        session_id: id.to_string(),
        params: agent_params(script, prompt),
    });
    loop {
        match conn.recv() {
            Evt::SessionCreated { session_id } if session_id == id => return,
            Evt::StatusChanged { .. } => {}
            Evt::Error { code, message } => {
                panic!("spawn agent failed for {id}: {code:?}: {message}")
            }
            other => panic!("expected agent SessionCreated, got {other:?}"),
        }
    }
}

fn wait_for_agent_turn(conn: &mut ClientConn, id: &str) {
    conn.send(&Cmd::AttachAgent {
        session_id: id.to_string(),
        from_seq: 0,
    });
    loop {
        match conn.recv() {
            Evt::AgentSnapshot {
                session_id, events, ..
            } if session_id == id => {
                if events
                    .iter()
                    .any(|entry| matches!(entry.event, NeutralAgentEvent::TurnCompleted { .. }))
                {
                    return;
                }
            }
            Evt::AgentEvent {
                session_id, event, ..
            } if session_id == id => {
                if matches!(event, NeutralAgentEvent::TurnCompleted { .. }) {
                    return;
                }
            }
            Evt::StatusChanged { .. } => {}
            Evt::Error { code, message } => {
                panic!("attach agent failed for {id}: {code:?}: {message}")
            }
            other => panic!("unexpected event waiting for agent turn: {other:?}"),
        }
    }
}

fn assert_agent_steers_after_handoff(conn: &mut ClientConn, id: &str) {
    wait_for_agent_turn(conn, id);
    conn.send(&Cmd::AgentInput {
        session_id: id.to_string(),
        text: "still alive?".to_string(),
    });

    let mut saw_text = false;
    let mut saw_completion = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !(saw_text && saw_completion) {
        match conn.recv() {
            Evt::AgentEvent {
                session_id, event, ..
            } if session_id == id => match event {
                NeutralAgentEvent::AssistantText { text, .. }
                    if text == "steered after handoff" =>
                {
                    saw_text = true;
                }
                NeutralAgentEvent::TurnCompleted { .. } => saw_completion = true,
                _ => {}
            },
            Evt::Ok | Evt::StatusChanged { .. } => {}
            Evt::Error { code, message } => {
                panic!("agent input failed for {id}: {code:?}: {message}")
            }
            other => panic!("unexpected event steering adopted agent: {other:?}"),
        }
    }
    assert!(saw_text, "adopted agent did not emit steered response");
    assert!(
        saw_completion,
        "adopted agent did not complete steered turn"
    );
}

fn run_successful_lifecycle_churn(conn: &mut ClientConn, script: &Path) -> usize {
    let mut completed = 0;
    for sequence in 1..=4 {
        let pty_id = format!("churn-pty-{sequence}");
        let cycle = conn
            .try_round_trip_until(
                &Cmd::Spawn {
                    session_id: pty_id.clone(),
                    executable: "/bin/cat".to_string(),
                    args: Vec::new(),
                    cwd: "/tmp".to_string(),
                    env: HashMap::new(),
                    cols: 80,
                    rows: 24,
                    agent_provider: None,
                    operator_input_only: false,
                },
                |event| matches!(event, Evt::SessionCreated { session_id } if session_id == &pty_id),
            )
            .and_then(|_| {
                conn.try_round_trip_until(
                    &Cmd::Kill {
                        session_id: pty_id,
                    },
                    |event| matches!(event, Evt::Ok),
                )
            });
        if cycle.is_err() {
            break;
        }

        let agent_id = format!("churn-agent-{sequence}");
        let cycle = conn
            .try_round_trip_until(
                &Cmd::SpawnAgent {
                    session_id: agent_id.clone(),
                    params: agent_params(script, "churn"),
                },
                |event| matches!(event, Evt::SessionCreated { session_id } if session_id == &agent_id),
            )
            .and_then(|_| {
                conn.try_round_trip_until(
                    &Cmd::Kill {
                        session_id: agent_id,
                    },
                    |event| matches!(event, Evt::Ok),
                )
            });
        if cycle.is_err() {
            break;
        }
        completed += 1;
    }
    completed
}

fn daemon_logs(dir: &Path) -> String {
    let mut logs = String::new();
    for entry in std::fs::read_dir(dir).expect("read daemon directory") {
        let path = entry.expect("daemon directory entry").path();
        let is_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("kanna-daemon_") && name.ends_with(".log"));
        if is_log {
            logs.push_str(&std::fs::read_to_string(path).unwrap_or_default());
        }
    }
    logs
}

fn wait_for_daemon_log_contains(dir: &Path, needle: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if daemon_logs(dir).contains(needle) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("expected daemon logs to contain {needle:?} within {timeout:?}");
}

fn assert_daemon_log_contains(dir: &Path, needle: &str) {
    let logs = daemon_logs(dir);
    assert!(
        logs.contains(needle),
        "expected daemon logs to contain {needle:?}"
    );
}

// ---- Tests ----

#[test]
fn previous_daemon_fixture_is_the_shipped_v2_binary() {
    let Some(binary) = support::previous_daemon::binary_or_skip(
        "previous_daemon_fixture_is_the_shipped_v2_binary",
    ) else {
        return;
    };
    let output = Command::new(binary)
        .arg("--version")
        .output()
        .expect("run previous daemon");
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("kanna-daemon"));
}

#[test]
fn authenticated_generations_reclassify_only_unclassified_legacy_handoff_sessions() {
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "authenticated_generations_reclassify_only_unclassified_legacy_handoff_sessions",
    ) else {
        return;
    };
    let dir = test_dir("legacy-protected-input-reclassification");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).expect("create cross-version daemon directory");
    let mut legacy = DaemonHandle::start_binary_in(&previous, &dir);
    for session_id in ["legacy-unclassified", "deliberately-protected"] {
        spawn_echo(&mut legacy.connect(), session_id);
    }

    let server_executable = std::fs::canonicalize(std::env::current_exe().unwrap())
        .unwrap()
        .to_string_lossy()
        .to_string();
    let mut first_successor = DaemonHandle::start_in_with_env(
        &dir,
        &[("KANNA_SERVER_EXECUTABLE", server_executable.as_str())],
    );
    assert!(
        wait_for_child_exit(&mut legacy.child, EVENTUAL_PROGRESS_GUARD).is_some(),
        "legacy daemon should hand its sessions to the first successor"
    );

    let mut control = first_successor.connect();
    control.send(&Cmd::Input {
        session_id: "legacy-unclassified".to_string(),
        data: b"before negotiation\n".to_vec(),
    });
    assert!(matches!(
        control.recv(),
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        }
    ));
    control.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(control.recv(), Evt::Ok));
    control.send(&Cmd::NegotiateProtectedInput {
        version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
    });
    assert!(matches!(
        control.recv(),
        Evt::ProtectedInputReady {
            version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION
        }
    ));
    control.send(&Cmd::Input {
        session_id: "legacy-unclassified".to_string(),
        data: b"negotiation alone must not open the fence\n".to_vec(),
    });
    assert!(matches!(
        control.recv(),
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        }
    ));
    control.send(&Cmd::ClassifyInput {
        session_id: "legacy-unclassified".to_string(),
        operator_input_only: false,
    });
    assert!(matches!(control.recv(), Evt::Ok));
    control.send(&Cmd::ClassifyInput {
        session_id: "deliberately-protected".to_string(),
        operator_input_only: true,
    });
    assert!(matches!(control.recv(), Evt::Ok));
    drop(control);

    let mut second_successor = spawn_replacement_without_wait(
        &dir,
        &[("KANNA_SERVER_EXECUTABLE", server_executable.as_str())],
    );
    assert!(
        wait_for_child_exit(&mut first_successor.child, EVENTUAL_PROGRESS_GUARD).is_some(),
        "first successor should hand its sessions to the next generation"
    );
    let second_pid = second_successor.id();
    let stream = wait_for_published_socket(
        &dir.join("daemon.pid"),
        &compute_socket_path(&dir),
        second_pid,
    );
    stream
        .set_read_timeout(Some(EVENTUAL_PROGRESS_GUARD))
        .unwrap();
    let mut adopted = ClientConn {
        reader: BufReader::new(stream.try_clone().unwrap()),
        writer: stream,
    };
    adopted.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(adopted.recv(), Evt::Ok));
    adopted.send(&Cmd::NegotiateProtectedInput {
        version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
    });
    assert!(matches!(adopted.recv(), Evt::ProtectedInputReady { .. }));

    adopted.send(&Cmd::Input {
        session_id: "legacy-unclassified".to_string(),
        data: b"accepted after negotiation\n".to_vec(),
    });
    assert!(matches!(adopted.recv(), Evt::Ok));
    adopted.send(&Cmd::Input {
        session_id: "deliberately-protected".to_string(),
        data: b"must remain fenced\n".to_vec(),
    });
    assert!(matches!(
        adopted.recv(),
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        }
    ));

    let _ = second_successor.kill();
    let _ = second_successor.wait();
    drop(first_successor);
    drop(legacy);
    cleanup(&dir);
}

#[test]
fn shipped_v2_hands_stable_pty_and_agent_to_v3_during_lifecycle_churn() {
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "shipped_v2_hands_stable_pty_and_agent_to_v3_during_lifecycle_churn",
    ) else {
        return;
    };
    let dir = test_dir("v2-v3-race");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).expect("create cross-version daemon directory");
    let script = write_steerable_agent(&dir);
    let mut old = DaemonHandle::start_binary_in(&previous, &dir);

    spawn_echo(&mut old.connect(), "stable-pty");
    spawn_agent(
        &mut old.connect(),
        "stable-agent",
        &script,
        "before handoff",
    );
    let mut old_pty = old.connect();
    attach(&mut old_pty, "stable-pty");
    send_input_and_wait_for_echo(&mut old_pty, "stable-pty", b"before\n", "before");
    wait_for_agent_turn(&mut old.connect(), "stable-agent");

    // Keep the management connection open before takeover so this test
    // exercises the deployed v2 daemon after it has already sent the
    // non-transactional snapshot. The current adopter's test hook holds ACK
    // long enough to prove a complete PTY + agent lifecycle cycle overlaps
    // that pre-commit transfer window.
    let mut old_churn = old.connect();
    drop(old_pty);
    let old_pid = old.child.id();
    let classifier_dir = dir.clone();
    let (v2_rejected_tx, v2_rejected_rx) = std::sync::mpsc::sync_channel(1);
    let classifier = std::thread::spawn(move || {
        let connect = || {
            let stream = UnixStream::connect(compute_socket_path(&classifier_dir))
                .expect("classifier connects to daemon");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            ClientConn {
                reader: BufReader::new(stream.try_clone().unwrap()),
                writer: stream,
            }
        };
        let mut incumbent = connect();
        incumbent
            .try_round_trip_until(&Cmd::List, |event| matches!(event, Evt::SessionList { .. }))
            .expect("v2 List remains compatible");
        let rejected = incumbent.try_round_trip_until(
            &Cmd::ClassifyInput {
                session_id: "stable-pty".to_string(),
                operator_input_only: false,
            },
            |event| matches!(event, Evt::Ok),
        );
        assert!(
            rejected.is_err(),
            "shipped v2 must reject the unknown classification command"
        );
        v2_rejected_tx.send(()).unwrap();

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let published = std::fs::read_to_string(classifier_dir.join("daemon.pid"))
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if published.is_some_and(|pid| pid != old_pid) {
                if let Ok(stream) = UnixStream::connect(compute_socket_path(&classifier_dir)) {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut successor = ClientConn {
                        reader: BufReader::new(stream.try_clone().unwrap()),
                        writer: stream,
                    };
                    successor
                        .try_round_trip_until(
                            &Cmd::AuthorizeServer {
                                pid: std::process::id(),
                            },
                            |event| matches!(event, Evt::Ok),
                        )
                        .expect("native desktop pins the server process on the successor");
                    successor
                        .try_round_trip_until(
                            &Cmd::ClassifyInput {
                                session_id: "stable-pty".to_string(),
                                operator_input_only: false,
                            },
                            |event| matches!(event, Evt::Ok),
                        )
                        .expect("published v3 successor accepts classification");
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "classifier never reached the published v3 successor"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    v2_rejected_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("classification must race the shipped v2 incumbent");
    let current_dir = dir.clone();
    let server_executable = std::fs::canonicalize(std::env::current_exe().unwrap())
        .unwrap()
        .to_string_lossy()
        .to_string();
    let current_start = std::thread::spawn(move || {
        DaemonHandle::start_in_with_env(
            &current_dir,
            &[
                ("KANNA_TEST_HANDOFF_ACK_DELAY_MS", "1500"),
                ("KANNA_SERVER_EXECUTABLE", server_executable.as_str()),
            ],
        )
    });
    wait_for_daemon_log_contains(
        &dir,
        "TEST HOOK: delaying adoption acknowledgement",
        Duration::from_secs(5),
    );
    let cycles = run_successful_lifecycle_churn(&mut old_churn, &script);
    assert!(
        cycles > 0,
        "the deployed v2 daemon must complete PTY and agent lifecycle churn after its snapshot \
         was transferred but before the current adopter ACKed"
    );
    drop(old_churn);
    let current = current_start.join().expect("current daemon start thread");
    classifier.join().expect("classification retry thread");

    assert!(
        wait_for_child_exit(&mut old.child, Duration::from_secs(10)).is_some(),
        "v2 incumbent should exit after its snapshot is adopted"
    );
    let mut current_pty = current.connect();
    attach(&mut current_pty, "stable-pty");
    // Server-style classification began against shipped v2, retried only
    // after v3 was published, and unfenced this ordinary inherited PTY.
    send_input_and_wait_for_echo(&mut current_pty, "stable-pty", b"after\n", "after");
    let mut current_agent = current.connect();
    assert_agent_steers_after_handoff(&mut current_agent, "stable-agent");
    assert_daemon_log_contains(&dir, "selected legacy-v2 mode");

    drop(current_pty);
    drop(current);
    drop(old);
    cleanup(&dir);
}

#[test]
fn shipped_v2_adoption_delivers_logical_input_over_an_inherited_draft() {
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "shipped_v2_adoption_delivers_logical_input_over_an_inherited_draft",
    ) else {
        return;
    };
    let dir = test_dir("v2-unknown-draft");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).expect("create cross-version daemon directory");
    let mut old = DaemonHandle::start_binary_in(&previous, &dir);

    for session_id in ["legacy-empty", "legacy-draft"] {
        spawn_echo(&mut old.connect(), session_id);
    }
    let mut old_draft = old.connect();
    attach(&mut old_draft, "legacy-draft");
    send_input(&mut old_draft, "legacy-draft", b"protected draft");
    drop(old_draft);

    let server_executable = std::fs::canonicalize(std::env::current_exe().unwrap())
        .unwrap()
        .to_string_lossy()
        .to_string();
    let current = DaemonHandle::start_in_with_env(
        &dir,
        &[("KANNA_SERVER_EXECUTABLE", server_executable.as_str())],
    );
    assert!(
        wait_for_child_exit(&mut old.child, Duration::from_secs(10)).is_some(),
        "v2 incumbent should exit after adoption"
    );

    let mut control = current.connect();
    control.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(control.recv(), Evt::Ok));
    for session_id in ["legacy-empty", "legacy-draft"] {
        control.send(&Cmd::ClassifyInput {
            session_id: session_id.to_string(),
            operator_input_only: false,
        });
        assert!(matches!(control.recv(), Evt::Ok));
        // The adopted composer cannot be attested, and that is a fact about
        // what may be *read* from it — never a reason to withhold a delivery.
        assert_eq!(
            session_composer_attestation(&mut control, session_id),
            "unknown"
        );
    }

    let mut adopted = current.connect();
    attach(&mut adopted, "legacy-draft");
    send_input_boundary(&mut adopted, "legacy-draft", b"\r");
    control.send(&Cmd::SubmitInput {
        session_id: "legacy-draft".to_string(),
        data: b"manager message".to_vec(),
    });
    expect_delivered(&mut control);

    let deadline = Instant::now() + Duration::from_secs(3);
    let snapshot = loop {
        let snapshot = request_snapshot(&mut adopted, "legacy-draft");
        if snapshot.vt.contains("manager message") {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "logical retry was not delivered");
        std::thread::sleep(Duration::from_millis(20));
    };
    let draft = snapshot.vt.find("protected draft").expect("draft survived");
    let manager = snapshot
        .vt
        .find("manager message")
        .expect("manager delivered");
    assert!(draft < manager);
    assert!(!snapshot.vt.contains("protected draftmanager message"));

    drop(adopted);
    drop(control);
    drop(current);
    drop(old);
    cleanup(&dir);
}

/// An adopted session's composer earns its attestation from the frame the
/// agent draws on its own — no attach, no keystroke, no human.
///
/// Delivery never depended on it after 2026-09-08, and both sessions here take
/// their message. What the attestation still decides is whether anything may
/// *read* the text on that composer as somebody's words.
#[test]
fn shipped_v2_adoption_attests_a_provably_empty_composer_without_a_human() {
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "shipped_v2_adoption_attests_a_provably_empty_composer_without_a_human",
    ) else {
        return;
    };
    let dir = test_dir("v2-empty-composer");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).expect("create cross-version daemon directory");
    let release_path = dir.join("release-composer");
    let mut old = DaemonHandle::start_binary_in(&previous, &dir);

    let mut release_env = HashMap::new();
    release_env.insert(
        "KANNA_HANDOFF_RELEASE".to_string(),
        release_path.to_string_lossy().into_owned(),
    );
    let mut spawner = old.connect();
    // Draws its composer only after the release marker, so the adopted session
    // is still unresolved when the subscriber is listening and the frame that
    // resolves it arrives with no keystroke behind it.
    spawn_provider_frame(
        &mut spawner,
        "empty-composer",
        "claude",
        "printf 'Working on it'; while [ ! -f \"$KANNA_HANDOFF_RELEASE\" ]; do sleep 0.05; done; \
         printf '\\033[2J\\033[HDone.\\r\\n\\342\\235\\257 '; exec /bin/cat",
        release_env,
    );
    spawn_provider_frame(
        &mut spawner,
        "drafted-composer",
        "claude",
        "printf '\\033[2J\\033[HDone.\\r\\n\\342\\235\\257 half typed thought'; exec /bin/cat",
        HashMap::new(),
    );
    drop(spawner);

    let server_executable = std::fs::canonicalize(std::env::current_exe().unwrap())
        .unwrap()
        .to_string_lossy()
        .to_string();
    let current = DaemonHandle::start_in_with_env(
        &dir,
        &[("KANNA_SERVER_EXECUTABLE", server_executable.as_str())],
    );
    assert!(
        wait_for_child_exit(&mut old.child, Duration::from_secs(10)).is_some(),
        "v2 incumbent should exit after adoption"
    );

    let mut control = current.connect();
    control.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(control.recv(), Evt::Ok));
    for session_id in ["empty-composer", "drafted-composer"] {
        control.send(&Cmd::ClassifyInput {
            session_id: session_id.to_string(),
            operator_input_only: false,
        });
        assert!(matches!(control.recv(), Evt::Ok));
        // Nothing here watched these composers being typed into, so nothing
        // may read what is on them as an instruction.
        assert_eq!(
            session_composer_attestation(&mut control, session_id),
            "unknown"
        );
    }

    let mut subscriber = current.connect();
    subscriber.send(&Cmd::Subscribe);
    assert!(matches!(subscriber.recv(), Evt::Ok));

    // No attach, no keystroke, no human: the frame the agent draws on its own
    // is the whole evidence.
    std::fs::write(&release_path, b"go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match subscriber.recv_with_timeout(Duration::from_millis(500)) {
            Ok(Evt::ComposerChanged {
                session_id,
                composer_attestation,
                ..
            }) if session_id == "empty-composer" && composer_attestation == "not-typed" => break,
            Ok(_) => {}
            Err(error) => assert!(
                error.contains("read failed") || error.contains("timed out"),
                "subscriber failed: {error}"
            ),
        }
        assert!(
            Instant::now() < deadline,
            "an inherited empty composer never announced that nobody typed on it"
        );
    }
    assert_eq!(
        session_composer_attestation(&mut control, "empty-composer"),
        "not-typed"
    );

    control.send(&Cmd::SubmitInput {
        session_id: "empty-composer".to_string(),
        data: b"MERGE task-743d8c3e -> main".to_vec(),
    });
    expect_delivered(&mut control);

    // The other composer holds text nobody here saw typed. It keeps saying so
    // — and takes the delivery anyway, which is the collision the owner chose
    // over a message that never arrives.
    assert_eq!(
        session_composer_attestation(&mut control, "drafted-composer"),
        "unknown"
    );
    control.send(&Cmd::SubmitInput {
        session_id: "drafted-composer".to_string(),
        data: b"MERGE task-743d8c3e -> main".to_vec(),
    });
    expect_delivered(&mut control);

    let mut adopted = current.connect();
    attach(&mut adopted, "empty-composer");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = request_snapshot(&mut adopted, "empty-composer");
        if snapshot.vt.contains("MERGE task-743d8c3e") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the attested delivery never reached the PTY"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    attach(&mut adopted, "drafted-composer");
    let deadline = Instant::now() + Duration::from_secs(5);
    let snapshot = loop {
        let snapshot = request_snapshot(&mut adopted, "drafted-composer");
        if snapshot.vt.contains("MERGE task-743d8c3e") {
            break snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "the delivery never reached the drafted composer"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        snapshot.vt.contains("half typed thought"),
        "the inherited draft is still there; the message landed after it"
    );

    drop(adopted);
    drop(subscriber);
    drop(control);
    drop(current);
    drop(old);
    cleanup(&dir);
}

#[test]
fn current_v3_stable_path_hands_pty_and_agent_to_shipped_v2_adopter() {
    // Socket reads are the event-driven synchronization in this cross-version
    // test. Their timeout contains a wedged fixture; five seconds is not a
    // daemon handoff latency contract and is too narrow under full-suite load.
    let eventual_read_timeout = Duration::from_secs(30);
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "current_v3_stable_path_hands_pty_and_agent_to_shipped_v2_adopter",
    ) else {
        return;
    };
    let dir = test_dir("v3-v2-adopter");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).expect("create cross-version daemon directory");
    let script = write_steerable_agent(&dir);
    let stable_daemon = dir.join("stable-kanna-daemon");
    install_test_daemon_at(
        Path::new(env!("CARGO_BIN_EXE_kanna-daemon")),
        &stable_daemon,
    );
    let mut current = DaemonHandle::start_binary_in(&stable_daemon, &dir);

    spawn_echo(
        &mut current.connect_with_read_timeout(eventual_read_timeout),
        "stable-pty",
    );
    spawn_agent(
        &mut current.connect_with_read_timeout(eventual_read_timeout),
        "stable-agent",
        &script,
        "before handoff",
    );
    let mut current_pty = current.connect_with_read_timeout(eventual_read_timeout);
    attach(&mut current_pty, "stable-pty");
    send_input_boundary_and_wait_for_echo(&mut current_pty, "stable-pty", b"before\n", "before");
    wait_for_agent_turn(
        &mut current.connect_with_read_timeout(eventual_read_timeout),
        "stable-agent",
    );

    drop(current_pty);
    install_test_daemon_at(&previous, &stable_daemon);
    let old_adopter = DaemonHandle::start_binary_in(&stable_daemon, &dir);
    assert!(
        wait_for_child_exit(&mut current.child, EVENTUAL_PROGRESS_GUARD).is_some(),
        "current v3 sender should exit after the shipped v2 adopter ACKs"
    );

    let mut adopted_pty = old_adopter.connect_with_read_timeout(eventual_read_timeout);
    attach(&mut adopted_pty, "stable-pty");
    send_input_and_wait_for_echo(&mut adopted_pty, "stable-pty", b"after\n", "after");
    let mut adopted_agent = old_adopter.connect_with_read_timeout(eventual_read_timeout);
    assert_agent_steers_after_handoff(&mut adopted_agent, "stable-agent");

    drop(adopted_pty);
    drop(old_adopter);
    drop(current);
    cleanup(&dir);
}

#[test]
fn current_v3_refuses_shipped_v2_adopter_while_draft_coordination_is_active() {
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "current_v3_refuses_shipped_v2_adopter_while_draft_coordination_is_active",
    ) else {
        return;
    };
    let dir = test_dir("v3-v2-draft-coordination-refusal");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).expect("create cross-version daemon directory");
    let stable_daemon = dir.join("stable-kanna-daemon");
    install_test_daemon_at(
        Path::new(env!("CARGO_BIN_EXE_kanna-daemon")),
        &stable_daemon,
    );
    let mut current = DaemonHandle::start_binary_in(&stable_daemon, &dir);
    let session_id = "draft-coordination-pty";
    let mut connection = current.connect();
    connection.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });
    assert!(matches!(connection.recv(), Evt::SessionCreated { .. }));
    attach(&mut connection, session_id);
    send_input(&mut connection, session_id, b"human draft");
    connection.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"manager message".to_vec(),
    });
    expect_delivered(&mut connection);

    install_test_daemon_at(&previous, &stable_daemon);
    let mut legacy = Command::new(&stable_daemon)
        .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
        .spawn()
        .expect("start shipped v2 adopter");
    let status = wait_for_child_exit(&mut legacy, Duration::from_secs(10))
        .expect("legacy adopter should fail instead of discarding draft coordination");
    assert!(!status.success());
    assert!(
        current.child.try_wait().unwrap().is_none(),
        "current daemon must retain lifecycle ownership after refusing v2"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("daemon.pid"))
            .unwrap()
            .trim(),
        current.child.id().to_string()
    );
    let audit = std::fs::read_to_string(dir.join("kanna-daemon-lifecycle.log")).unwrap();
    assert!(
        audit.contains(
            "event=handoff_refused reason=draft_coordination_requires_v3 session=draft-coordination-pty"
        ),
        "draft-coordination legacy refusal should be audited: {audit}"
    );

    // The delivery went out over the human's draft, so the line the shell
    // reads is both of them — the collision the owner asked for, and proof
    // that the message was written rather than retained across the refusal.
    let deadline = Instant::now() + Duration::from_secs(3);
    let snapshot = loop {
        let snapshot = request_snapshot(&mut connection, session_id);
        if snapshot.vt.contains("LINE:<human draftmanager message>") {
            break snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "manager message was not delivered"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(snapshot.vt.contains("LINE:<human draftmanager message>"));

    drop(connection);
    drop(current);
    cleanup(&dir);
}

#[test]
fn protected_v3_session_refuses_transfer_to_a_shipped_v2_adopter() {
    let Some(previous) = support::previous_daemon::binary_or_skip(
        "protected_v3_session_refuses_transfer_to_a_shipped_v2_adopter",
    ) else {
        return;
    };
    let dir = test_dir("protected-v3-v2-refusal");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let stable_daemon = dir.join("stable-kanna-daemon");
    install_test_daemon_at(
        Path::new(env!("CARGO_BIN_EXE_kanna-daemon")),
        &stable_daemon,
    );
    let mut current = DaemonHandle::start_binary_in(&stable_daemon, &dir);
    let mut connection = current.connect();
    connection.send(&Cmd::Spawn {
        session_id: "protected-merge".to_string(),
        executable: "/bin/cat".to_string(),
        args: Vec::new(),
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: true,
    });
    assert!(matches!(connection.recv(), Evt::SessionCreated { .. }));

    install_test_daemon_at(&previous, &stable_daemon);
    let mut legacy = Command::new(&stable_daemon)
        .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
        .spawn()
        .expect("start shipped v2 adopter");
    let status = wait_for_child_exit(&mut legacy, Duration::from_secs(10))
        .expect("legacy adopter should fail instead of taking protected PTYs");
    assert!(!status.success());
    assert!(current.child.try_wait().unwrap().is_none());
    let published = std::fs::read_to_string(dir.join("daemon.pid")).unwrap();
    assert_eq!(published.trim(), current.child.id().to_string());
    let audit = std::fs::read_to_string(dir.join("kanna-daemon-lifecycle.log")).unwrap();
    assert!(
        audit.contains(
            "event=handoff_refused reason=protected_input_requires_v3 session=protected-merge"
        ),
        "protected legacy refusal should be audited: {audit}"
    );

    drop(connection);
    drop(current);
    cleanup(&dir);
}

#[test]
fn classification_waits_out_the_snapshot_and_must_be_replayed_on_the_successor() {
    let dir = test_dir("classification-snapshot-fence");
    cleanup(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("snapshot-complete");
    let release = dir.join("release-snapshot");
    let server_executable = std::fs::canonicalize(std::env::current_exe().unwrap())
        .unwrap()
        .to_string_lossy()
        .to_string();
    let marker_string = marker.to_string_lossy().to_string();
    let release_string = release.to_string_lossy().to_string();
    let mut old = DaemonHandle::start_in_with_env(
        &dir,
        &[
            ("KANNA_SERVER_EXECUTABLE", server_executable.as_str()),
            (
                "KANNA_DAEMON_TEST_HANDOFF_SNAPSHOT_MARKER",
                marker_string.as_str(),
            ),
            (
                "KANNA_DAEMON_TEST_HANDOFF_SNAPSHOT_RELEASE",
                release_string.as_str(),
            ),
        ],
    );
    let mut connection = old.connect();
    spawn_echo(&mut connection, "snapshot-race");
    connection.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(connection.recv(), Evt::Ok));

    let mut successor = spawn_replacement_without_wait(
        &dir,
        &[("KANNA_SERVER_EXECUTABLE", server_executable.as_str())],
    );
    // The marker is an explicit snapshot-boundary event. The deadline only
    // contains a child that never reaches it.
    let deadline = Instant::now() + EVENTUAL_PROGRESS_GUARD;
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        marker.exists(),
        "handoff never reached its snapshot boundary"
    );

    connection.send(&Cmd::ClassifyInput {
        session_id: "snapshot-race".to_string(),
        operator_input_only: true,
    });
    assert!(
        connection
            .recv_with_timeout(Duration::from_millis(200))
            .is_err(),
        "classification must not acknowledge after the handoff snapshot was captured"
    );
    std::fs::write(&release, b"release").unwrap();
    let post_snapshot = connection.recv_with_timeout(EVENTUAL_PROGRESS_GUARD);
    assert!(
        !matches!(post_snapshot, Ok(Evt::Ok)),
        "the snapshotted predecessor must not acknowledge classification: {post_snapshot:?}"
    );

    assert!(
        wait_for_child_exit(&mut old.child, EVENTUAL_PROGRESS_GUARD).is_some(),
        "predecessor should commit handoff"
    );
    let successor_pid = successor.id();
    let stream = wait_for_published_socket(
        &dir.join("daemon.pid"),
        &compute_socket_path(&dir),
        successor_pid,
    );
    stream
        .set_read_timeout(Some(EVENTUAL_PROGRESS_GUARD))
        .unwrap();
    let mut adopted = ClientConn {
        reader: BufReader::new(stream.try_clone().unwrap()),
        writer: stream,
    };
    adopted.send(&Cmd::AuthorizeServer {
        pid: std::process::id(),
    });
    assert!(matches!(adopted.recv(), Evt::Ok));
    adopted.send(&Cmd::ClassifyInput {
        session_id: "snapshot-race".to_string(),
        operator_input_only: true,
    });
    assert!(matches!(adopted.recv(), Evt::Ok));
    adopted.send(&Cmd::Input {
        session_id: "snapshot-race".to_string(),
        data: b"forged\n".to_vec(),
    });
    assert!(matches!(
        adopted.recv(),
        Evt::Error {
            code: Some(ErrorCode::InputUnauthorized),
            ..
        }
    ));

    let _ = successor.kill();
    let _ = successor.wait();
    drop(old);
    cleanup(&dir);
}

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

/// If the old daemon accepts the v3 handoff command and then drops the
/// connection, the new daemon cannot know whether sessions were detached.
/// It must not send a legacy-v2 handoff request or start a competing
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
        vec![3],
        "ambiguous failure after sending v3 Handoff must not retry legacy v2"
    );

    cleanup(&dir);
}

/// A successor timing out against a responsive-but-wedged incumbent must
/// fail closed. The incumbent remains published and its live PTY remains
/// usable; the stable lifecycle audit records why the replacement aborted.
#[test]
fn test_handoff_unresponsive_incumbent_keeps_sessions_and_audits_failure() {
    let dir = test_dir("unresponsive-incumbent");
    cleanup(&dir);
    let old =
        DaemonHandle::start_in_with_env(&dir, &[("KANNA_TEST_HANDOFF_RESPONSE_DELAY_MS", "1000")]);
    let old_pid = old.child.id();
    let startup_log = old.wait_for_log("kanna-daemon");
    assert!(
        startup_log.contains("] INFO ["),
        "per-process daemon logs should include timestamps and levels:\n{startup_log}"
    );
    let session_id = unique_session_id("wedged-survivor");
    let mut attached = old.connect();
    spawn_echo(&mut attached, &session_id);
    attach(&mut attached, &session_id);
    send_input_and_wait_for_echo(
        &mut attached,
        &session_id,
        b"before-timeout\n",
        "before-timeout",
    );

    let mut successor =
        spawn_replacement_without_wait(&dir, &[("KANNA_TEST_HANDOFF_RESPONSE_TIMEOUT_MS", "100")]);
    let status = wait_for_child_exit(&mut successor, Duration::from_secs(5))
        .expect("timed-out successor must exit");
    assert!(
        !status.success(),
        "timed-out successor must not publish a fresh empty daemon"
    );

    let published_pid = std::fs::read_to_string(dir.join("daemon.pid"))
        .expect("incumbent pid file should remain")
        .trim()
        .parse::<u32>()
        .expect("published pid should parse");
    assert_eq!(
        published_pid, old_pid,
        "the incumbent must remain the published daemon"
    );
    send_input_and_wait_for_echo(
        &mut attached,
        &session_id,
        b"after-timeout\n",
        "after-timeout",
    );

    let audit = std::fs::read_to_string(dir.join("kanna-daemon-lifecycle.log"))
        .expect("lifecycle audit should exist");
    assert!(
        audit.contains("event=handoff_aborted")
            && audit.contains("timeout reading handoff response")
            && audit.contains("incumbent_retained=true"),
        "audit should explain the fail-closed timeout:\n{audit}"
    );
    let current_log = std::fs::read_link(dir.join("kanna-daemon.log"))
        .expect("current daemon log link should exist");
    assert!(
        current_log
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(&format!("_{old_pid}_"))),
        "failed successor must not replace the incumbent log link: {current_log:?}"
    );

    drop(attached);
    drop(old);
    cleanup(&dir);
}

#[test]
fn ordinary_client_cannot_begin_or_receive_handoff() {
    let dir = test_dir("unauthorized-client");
    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();
    spawn_echo(&mut conn_a, "sess-protected");
    attach(&mut conn_a, "sess-protected");
    send_input_and_wait_for_echo(
        &mut conn_a,
        "sess-protected",
        b"before-refusal\n",
        "before-refusal",
    );

    let socket_path = compute_socket_path(&dir);
    let mut handoff = UnixStream::connect(&socket_path).expect("connect to old daemon");
    handoff
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let request = serde_json::json!({ "type": "Handoff", "version": 3 });
    writeln!(handoff, "{}", serde_json::to_string(&request).unwrap()).unwrap();
    handoff.flush().unwrap();
    let mut reader = BufReader::new(handoff.try_clone().unwrap());
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("old daemon should refuse handoff");
    assert!(
        matches!(
            serde_json::from_str::<Evt>(line.trim()).unwrap(),
            Evt::Error {
                code: Some(ErrorCode::HandoffUnauthorized),
                ..
            }
        ),
        "ordinary client must receive HandoffUnauthorized, got {line:?}"
    );
    assert!(
        recv_fds_nonblocking(handoff.as_raw_fd()).is_empty(),
        "unauthorized handoff must not receive SCM_RIGHTS descriptors"
    );
    let log = daemon_a.wait_for_log("refusing unauthorized successor");
    assert!(
        log.contains("refusing unauthorized successor"),
        "authorization refusal must be logged, got {log:?}"
    );
    assert!(
        !log.contains("sessions in manager (epoch "),
        "unauthorized request entered the sealed transaction: {log}"
    );
    drop(handoff);
    drop(reader);

    send_input_and_wait_for_echo(
        &mut conn_a,
        "sess-protected",
        b"after-refusal\n",
        "after-refusal",
    );
    spawn_echo(&mut conn_a, "post-refusal");
    kill_session(&mut conn_a, "post-refusal");

    drop(daemon_a);
    cleanup(&dir);
}

#[test]
fn test_handoff_capture_serializes_spawn_and_kill_until_abort() {
    let dir = test_dir("handoff-lifecycle-seal-abort");
    let daemon = DaemonHandle::start_in(&dir);
    let mut owner = daemon.connect();
    spawn_echo(&mut owner, "sess-captured-before-abort");

    let mut successor =
        spawn_replacement_without_wait(&dir, &[("KANNA_TEST_HANDOFF_ACK_DELAY_MS", "1500")]);
    let log = daemon.wait_for_log("HandoffReady sent and flushed");
    assert!(
        log.contains("snapshotting session sess-captured-before-abort")
            && log.contains("HandoffReady sent and flushed"),
        "real successor did not capture the live session: {log:?}",
    );

    let mut spawner = daemon.connect();
    spawner.send(&Cmd::Spawn {
        session_id: "sess-created-during-handoff".to_string(),
        executable: "/bin/cat".to_string(),
        args: vec![],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });
    let mut killer = daemon.connect();
    killer.send(&Cmd::Kill {
        session_id: "sess-captured-before-abort".to_string(),
    });

    assert!(
        spawner
            .recv_with_timeout(Duration::from_millis(250))
            .is_err(),
        "Spawn mutated the PTY registry after handoff capture but before ACK resolution",
    );
    assert!(
        killer
            .recv_with_timeout(Duration::from_millis(250))
            .is_err(),
        "Kill mutated the PTY registry after handoff capture but before ACK resolution",
    );

    successor.kill().expect("kill successor before handoff ACK");
    successor.wait().expect("reap interrupted successor");

    expect_session_created_with_timeout(
        &mut spawner,
        "sess-created-during-handoff",
        Duration::from_secs(2),
    );
    match killer.recv_with_timeout(Duration::from_secs(2)) {
        Ok(Evt::Ok) => {}
        other => panic!("Kill did not resume after handoff abort: {other:?}"),
    }

    let mut listing = daemon.connect();
    listing.send(&Cmd::List);
    let sessions = match listing.recv() {
        Evt::SessionList { sessions } => sessions,
        other => panic!("expected SessionList after handoff abort, got: {other:?}"),
    };
    assert!(sessions
        .iter()
        .any(|session| session["session_id"] == "sess-created-during-handoff"));
    assert!(!sessions
        .iter()
        .any(|session| session["session_id"] == "sess-captured-before-abort"));

    drop(daemon);
    cleanup(&dir);
}

#[test]
fn test_handoff_commit_refuses_mutations_with_retry_on_successor() {
    let dir = test_dir("handoff-lifecycle-seal-commit");
    let mut daemon = DaemonHandle::start_in(&dir);
    let script = write_steerable_agent(&dir);
    // The adoption delay must outlast the sealed-window probes below: four
    // clients each block a full 250ms recv timeout before the ACK may land.
    let mut successor =
        spawn_replacement_without_wait(&dir, &[("KANNA_TEST_HANDOFF_ACK_DELAY_MS", "3000")]);
    let log = daemon.wait_for_log("HandoffReady sent and flushed");
    assert!(
        log.contains("HandoffReady sent and flushed"),
        "real successor did not reach the pre-ACK window: {log:?}"
    );

    let mut spawner = daemon.connect();
    spawner.send(&Cmd::Spawn {
        session_id: "sess-must-retry-after-commit".to_string(),
        executable: "/bin/cat".to_string(),
        args: vec![],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });

    let mut agent_spawner = daemon.connect();
    agent_spawner.send(&Cmd::SpawnAgent {
        session_id: "agent-must-retry-after-commit".to_string(),
        params: agent_params(&script, "must not spawn on the old daemon"),
    });

    let mut killer = daemon.connect();
    killer.send(&Cmd::Kill {
        session_id: "kill-must-retry-after-commit".to_string(),
    });

    let mut agent_input = daemon.connect();
    agent_input.send(&Cmd::AgentInput {
        session_id: "input-must-retry-after-commit".to_string(),
        text: "must not reach the old daemon".to_string(),
    });

    for (name, client) in [
        ("Spawn", &mut spawner),
        ("SpawnAgent", &mut agent_spawner),
        ("Kill", &mut killer),
        ("AgentInput", &mut agent_input),
    ] {
        assert!(
            client
                .recv_with_timeout(Duration::from_millis(250))
                .is_err(),
            "{name} escaped before handoff ACK",
        );
    }

    // The authenticated successor commits adoption on its own once the test
    // ACK delay elapses; the first refusal therefore waits out that delay.
    for (name, client) in [
        ("Spawn", &mut spawner),
        ("SpawnAgent", &mut agent_spawner),
        ("Kill", &mut killer),
        ("AgentInput", &mut agent_input),
    ] {
        match client.recv_with_timeout(Duration::from_secs(5)) {
            Ok(Evt::Error {
                code: Some(ErrorCode::RetryOnSuccessor),
                message,
            }) => assert!(
                message.contains("retry against the adopting daemon"),
                "{name} returned the right code with the wrong guidance: {message}",
            ),
            other => panic!("{name} was not refused with retry_on_successor: {other:?}"),
        }
    }

    let _ = wait_for_child_exit(&mut daemon.child, Duration::from_secs(3));
    successor.kill().expect("stop adopting daemon");
    successor.wait().expect("reap adopting daemon");
    cleanup(&dir);
}

#[test]
fn retry_on_successor_creates_one_session_and_publishes_one_killed_exit() {
    let dir = test_dir("handoff-retry-idempotency");
    let mut old = DaemonHandle::start_in(&dir);
    spawn_echo(&mut old.connect(), "adopted-then-killed");

    // Open command sockets while they still resolve to the incumbent.
    let mut refused_spawn = old.connect();
    let mut refused_kill = old.connect();
    let spawn = Cmd::Spawn {
        session_id: "spawned-on-successor".to_string(),
        executable: "/bin/cat".to_string(),
        args: Vec::new(),
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    };
    let kill = Cmd::Kill {
        session_id: "adopted-then-killed".to_string(),
    };

    let successor_dir = dir.clone();
    let successor_start = std::thread::spawn(move || {
        DaemonHandle::start_in_with_env(
            &successor_dir,
            &[("KANNA_TEST_HANDOFF_ACK_DELAY_MS", "750")],
        )
    });
    wait_for_daemon_log_contains(
        &dir,
        "TEST HOOK: delaying adoption acknowledgement",
        Duration::from_secs(5),
    );

    refused_spawn.send(&spawn);
    refused_kill.send(&kill);
    assert!(
        refused_spawn
            .recv_with_timeout(Duration::from_millis(200))
            .is_err(),
        "Spawn must remain fenced until adoption commits"
    );
    assert!(
        refused_kill
            .recv_with_timeout(Duration::from_millis(200))
            .is_err(),
        "Kill must remain fenced until adoption commits"
    );

    let successor = successor_start.join().expect("successor start");
    for (name, client) in [("Spawn", &mut refused_spawn), ("Kill", &mut refused_kill)] {
        let response = client.recv();
        assert!(
            matches!(
                response,
                Evt::Error {
                    code: Some(ErrorCode::RetryOnSuccessor),
                    ..
                }
            ),
            "{name} must be explicitly retryable, got {response:?}"
        );
    }
    assert!(
        wait_for_child_exit(&mut old.child, Duration::from_secs(5)).is_some(),
        "incumbent must exit after committed handoff"
    );

    let mut events = successor.connect();
    events.send(&Cmd::Subscribe);
    assert!(matches!(events.recv(), Evt::Ok));

    let mut successor_commands = successor.connect();
    successor_commands.send(&spawn);
    expect_session_created_with_timeout(
        &mut successor_commands,
        "spawned-on-successor",
        Duration::from_secs(2),
    );
    successor_commands.send(&kill);
    assert!(matches!(successor_commands.recv(), Evt::Ok));

    successor_commands.send(&Cmd::List);
    let sessions = match successor_commands.recv() {
        Evt::SessionList { sessions } => sessions,
        other => panic!("expected SessionList, got {other:?}"),
    };
    assert_eq!(
        sessions
            .iter()
            .filter(|session| session["session_id"] == "spawned-on-successor")
            .count(),
        1,
        "the retried Spawn must create exactly one session"
    );
    assert!(
        sessions
            .iter()
            .all(|session| session["session_id"] != "adopted-then-killed"),
        "the retried Kill must remove the adopted incarnation"
    );

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut created = 0;
    let mut exits = 0;
    while Instant::now() < deadline && (created == 0 || exits == 0) {
        match events.recv_with_timeout(Duration::from_millis(200)) {
            Ok(Evt::SessionCreated { session_id }) if session_id == "spawned-on-successor" => {
                created += 1;
            }
            Ok(Evt::Exit { session_id, .. }) if session_id == "adopted-then-killed" => {
                exits += 1;
            }
            Ok(_) | Err(_) => {}
        }
    }
    while let Ok(event) = events.recv_with_timeout(Duration::from_millis(200)) {
        match event {
            Evt::SessionCreated { session_id } if session_id == "spawned-on-successor" => {
                created += 1;
            }
            Evt::Exit { session_id, .. } if session_id == "adopted-then-killed" => {
                exits += 1;
            }
            _ => {}
        }
    }
    assert_eq!(created, 1, "SessionCreated must be published once");
    assert_eq!(exits, 1, "the successful Kill must publish one Exit");

    drop(successor);
    drop(old);
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
        vec![3],
        "fd transfer failure after v3 metadata must not retry legacy v2"
    );

    cleanup(&dir);
}

/// Explicit protocol version mismatch is the safe case for falling back to the
/// deployed legacy v2 handoff version.
#[test]
fn test_handoff_explicit_v3_mismatch_retries_legacy_v2() {
    let dir = test_dir("version-mismatch-legacy");
    let fake = FakeOldDaemon::start(&dir, |mut stream, requests| {
        let version = read_handoff_version(&mut stream);
        requests.lock().unwrap().push(version);
        if version == 3 {
            write_event_line(
                &mut stream,
                serde_json::json!({
                    "type": "Error",
                    "code": "handoff_version_mismatch",
                    "message": "handoff version mismatch: expected 1 or 2, got 3"
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
            read_handoff_adopted(&mut stream, version);
        }
    });

    let daemon = DaemonHandle::start_in(&dir);
    let requests = fake.join();
    assert_eq!(
        requests,
        vec![3, 2],
        "explicit v3 mismatch should retry exactly once with legacy v2"
    );

    let mut conn = daemon.connect();
    spawn_echo(&mut conn, "fresh-after-legacy-fallback");
    attach(&mut conn, "fresh-after-legacy-fallback");

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

#[test]
fn test_handoff_preserves_a_logical_message_written_over_a_raw_draft_using_echo_wait() {
    let dir = test_dir("queued-logical-input");
    let session_id = "queued-logical-input";
    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();
    conn_a.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });
    loop {
        match conn_a.recv() {
            Evt::SessionCreated {
                session_id: created,
            } => {
                assert_eq!(created, session_id);
                break;
            }
            Evt::Output { .. } | Evt::StatusChanged { .. } => continue,
            other => panic!("expected SessionCreated, got: {other:?}"),
        }
    }
    attach(&mut conn_a, session_id);
    send_input(&mut conn_a, session_id, b"human draft");
    conn_a.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"manager message".to_vec(),
    });
    expect_delivered(&mut conn_a);

    drop(conn_a);
    let daemon_b = DaemonHandle::start_in(&dir);
    let mut conn_b = daemon_b.connect();
    attach(&mut conn_b, session_id);
    // The message was written over the human's draft before the handoff — the
    // collision the owner chose — so the line the shell read is both of them,
    // and it survives the handoff as terminal state.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = request_snapshot(&mut conn_b, session_id);
        if snapshot.vt.contains("LINE:<human draftmanager message>") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "manager message was not delivered"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    drop(daemon_b);
    cleanup(&dir);
}

#[test]
fn test_handoff_drains_unread_no_reply_raw_input_before_snapshot() {
    let dir = test_dir("unread-raw-input");
    let session_id = "unread-raw-input";
    let daemon_a =
        DaemonHandle::start_in_with_env(&dir, &[("KANNA_TEST_PTY_INPUT_READER_PAUSE_MS", "750")]);
    let mut conn_a = daemon_a.connect();
    conn_a.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while IFS= read -r line; do printf 'LINE:<%s>\\n' \"$line\"; done".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });
    assert!(matches!(conn_a.recv(), Evt::SessionCreated { .. }));
    assert!(daemon_a
        .wait_for_log("TEST HOOK: pausing PTY input reader")
        .contains("TEST HOOK: pausing PTY input reader"));

    conn_a.send(&Cmd::InputNoReply {
        session_id: session_id.to_string(),
        data: b"human draft".to_vec(),
    });
    conn_a.send(&Cmd::SubmitInput {
        session_id: session_id.to_string(),
        data: b"manager message".to_vec(),
    });
    expect_delivered(&mut conn_a);

    drop(conn_a);
    let daemon_b = DaemonHandle::start_in(&dir);
    let mut conn_b = daemon_b.connect();
    attach(&mut conn_b, session_id);

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = request_snapshot(&mut conn_b, session_id);
        if snapshot.vt.contains("LINE:<human draftmanager message>") {
            break;
        }
        assert!(Instant::now() < deadline, "handoff input was not delivered");
        std::thread::sleep(Duration::from_millis(20));
    }

    drop(daemon_b);
    cleanup(&dir);
}

#[test]
fn test_handoff_preserves_output_emitted_after_final_snapshot_before_ack() {
    let dir = test_dir("snapshot-to-ack-output");
    let marker_path = dir.join("handoff-snapshot-complete");
    let release_path = dir.join("handoff-snapshot-release");
    let daemon_a = DaemonHandle::start_in_with_path_env(
        &dir,
        &[
            (
                "KANNA_DAEMON_TEST_HANDOFF_SNAPSHOT_MARKER",
                marker_path.as_path(),
            ),
            (
                "KANNA_DAEMON_TEST_HANDOFF_SNAPSHOT_RELEASE",
                release_path.as_path(),
            ),
        ],
    );
    let mut conn_a = daemon_a.connect();
    let mut env = HashMap::new();
    env.insert(
        "KANNA_HANDOFF_MARKER".to_string(),
        marker_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "KANNA_HANDOFF_RELEASE".to_string(),
        release_path.to_string_lossy().into_owned(),
    );
    conn_a.send(&Cmd::Spawn {
        session_id: "sess-snapshot-window".to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while [ ! -f \"$KANNA_HANDOFF_MARKER\" ]; do sleep 0.01; done; printf 'snapshot-to-ack-output\\r\\n'; touch \"$KANNA_HANDOFF_RELEASE\"; sleep 30".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env,
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });
    match conn_a.recv() {
        Evt::SessionCreated { .. } => {}
        other => panic!("expected SessionCreated, got: {other:?}"),
    }
    drop(conn_a);

    let daemon_b = DaemonHandle::start_in(&dir);
    let mut conn_b = daemon_b.connect();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        conn_b.send(&Cmd::Snapshot {
            session_id: "sess-snapshot-window".to_string(),
        });
        match conn_b.recv() {
            Evt::Snapshot { snapshot, .. } if snapshot.vt.contains("snapshot-to-ack-output") => {
                break;
            }
            Evt::Snapshot { .. } | Evt::StatusChanged { .. } if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            other => {
                panic!("output emitted in the final-snapshot-to-ACK window was lost: {other:?}")
            }
        }
    }

    drop(daemon_b);
    cleanup(&dir);
}

/// The 2026-08-06 transfer incident, as a test.
///
/// Task transfer used to end the source agent with `SIGINT`. The daemon refuses
/// signals for adopted sessions by design — it holds the master fd but never
/// forked the child, so the pid cannot be pinned across `kill(2)` — and every
/// session older than the running daemon is adopted. After an app upgrade, no
/// pre-existing task could be finalized at all: `[handoff] adopted session …`
/// at 10:43, the signal refused at 13:43, the conversation lost.
///
/// Injected input has no such constraint: `Command::Input` writes to the master
/// fd with no ownership check. This pins both halves — the refusal stays (it is
/// a safety property, not a bug) and the replacement works through it — so the
/// finalization sequence in `crates/kanna-server/src/transfer_engine/finalize.rs`
/// cannot regress to signalling.
#[test]
fn test_adopted_session_refuses_signals_but_quits_on_injected_input() {
    let dir = test_dir("adopted-quit-by-input");
    let session_id = "sess-adopted-quit";

    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();
    conn_a.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            // Stands in for an agent TUI: it survives SIGINT (so a delivered
            // signal would not have ended it either) and quits on the composer
            // command typed at it.
            "trap '' INT; while read line; do case \"$line\" in */exit*) exit 0;; esac; done"
                .to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        operator_input_only: false,
    });
    match conn_a.recv() {
        Evt::SessionCreated { .. } => {}
        other => panic!("expected SessionCreated, got: {other:?}"),
    }

    // The upgrade. Everything the successor holds from here on is adopted.
    drop(conn_a);
    let daemon_b = DaemonHandle::start_in(&dir);
    daemon_b.wait_for_log("adopted session");

    let mut events = daemon_b.connect();
    events.send(&Cmd::Subscribe);
    assert!(matches!(events.recv(), Evt::Ok));

    let mut conn_b = daemon_b.connect();
    conn_b.send(&Cmd::Signal {
        session_id: session_id.to_string(),
        signal: "SIGINT".to_string(),
    });
    match conn_b.recv() {
        Evt::Error { message, .. } => assert!(
            message.contains("adopted"),
            "the refusal must say why, so the transfer log is diagnosable: {message}",
        ),
        other => panic!(
            "the daemon accepted a signal for an adopted session; it must fail closed: {other:?}",
        ),
    }

    // The replacement: kanna-server's submission policy — the text as one
    // write, then a lone CR as a discrete keystroke.
    send_input(&mut conn_b, session_id, b"/exit");
    std::thread::sleep(Duration::from_millis(150));
    send_input(&mut conn_b, session_id, b"\r");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut exited = false;
    while Instant::now() < deadline && !exited {
        if let Ok(Evt::Exit {
            session_id: gone, ..
        }) = events.recv_with_timeout(Duration::from_millis(200))
        {
            exited = gone == session_id;
        }
    }
    assert!(
        exited,
        "the adopted session did not quit on injected input, which is the only way \
         transfer finalization can end it",
    );

    drop(daemon_b);
    cleanup(&dir);
}

#[test]
fn test_adopted_pty_tracks_status_before_first_attach() {
    let dir = test_dir("status-before-attach");
    let release_path = dir.join("release-idle");

    let daemon_a = DaemonHandle::start_in(&dir);
    let mut conn_a = daemon_a.connect();
    let mut env = HashMap::new();
    env.insert(
        "KANNA_HANDOFF_RELEASE".to_string(),
        release_path.to_string_lossy().into_owned(),
    );
    conn_a.send(&Cmd::Spawn {
        session_id: "sess-adopted-stream".to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'Header\\r\\n• Working (0s • esc to interrupt)\\r\\n› Run /review'; while [ ! -f \"$KANNA_HANDOFF_RELEASE\" ]; do sleep 0.05; done; printf '\\033[2J\\033[HHeader\\r\\n› '; sleep 30".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env,
        cols: 80,
        rows: 24,
        agent_provider: Some("codex".to_string()),
        operator_input_only: false,
    });
    match conn_a.recv() {
        Evt::SessionCreated { .. } => {}
        other => panic!("expected SessionCreated, got: {:?}", other),
    }
    wait_for_session_status(
        &mut conn_a,
        "sess-adopted-stream",
        SessionStatus::Busy,
        Duration::from_secs(2),
    );

    drop(conn_a);
    let daemon_b = DaemonHandle::start_in(&dir);
    let mut conn_b = daemon_b.connect();
    std::fs::write(&release_path, b"go").unwrap();

    // Deliberately never send AttachSnapshot: the adopted reader and status
    // detector must already be running before any terminal client selects it.
    wait_for_session_status(
        &mut conn_b,
        "sess-adopted-stream",
        SessionStatus::Idle,
        Duration::from_secs(2),
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
        agent_provider: None,
        operator_input_only: false,
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

/// Release-complete regression: even when the old daemon is slow to
/// relinquish its PTY readers after acknowledging adoption (fault-injected
/// via KANNA_TEST_HANDOFF_RELEASE_DELAY_MS), the adopting daemon must not
/// publish itself (pid file + socket) until the old daemon has actually
/// exited — otherwise both daemons would consume and split session output.
#[test]
fn test_adopter_publishes_only_after_delayed_old_daemon_exits() {
    let dir = test_dir("delayed-release");
    let session_id = unique_session_id("delayed-release");

    // Old daemon with a delayed reader release.
    let mut daemon_a =
        DaemonHandle::start_in_with_env(&dir, &[("KANNA_TEST_HANDOFF_RELEASE_DELAY_MS", "1500")]);
    let mut conn_a = daemon_a.connect();
    spawn_echo(&mut conn_a, &session_id);
    attach(&mut conn_a, &session_id);
    send_input_and_wait_for_echo(
        &mut conn_a,
        &session_id,
        b"before-handoff\n",
        "before-handoff",
    );

    // New daemon adopts. start_in returns only once B's pid file and socket
    // are live — by then the delayed old daemon must have exited (it may be
    // an unreaped zombie of this test process, so probe with try_wait, not
    // kill(pid, 0)).
    let publish_started = Instant::now();
    let daemon_b = DaemonHandle::start_in(&dir);
    let waited = publish_started.elapsed();
    assert!(
        daemon_a
            .child
            .try_wait()
            .expect("old daemon status should be queryable")
            .is_some(),
        "old daemon must have exited before the adopter published its socket"
    );
    assert!(
        waited >= Duration::from_millis(1400),
        "the adopter must have actually waited out the delayed release, waited {waited:?}"
    );

    // The adopted session still works end-to-end through the new daemon —
    // no split reader consumed its output.
    let mut conn_b = daemon_b.connect();
    attach(&mut conn_b, &session_id);
    send_input_and_wait_for_echo(
        &mut conn_b,
        &session_id,
        b"after-handoff\n",
        "after-handoff",
    );

    cleanup(&dir);
}
