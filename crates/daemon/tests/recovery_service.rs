use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use kanna_daemon::protocol::ErrorCode;
use kanna_daemon::recovery::{RecoveryManager, SeededRecoverySnapshot};
use serde::{Deserialize, Serialize};

#[tokio::test]
async fn daemon_fetches_restore_snapshot_from_recovery_manager() {
    let recovery = RecoveryManager::new_for_test()
        .await
        .expect("test recovery manager should start");

    recovery
        .start_session("session-1", 80, 24, false)
        .await
        .expect("start_session should succeed");
    recovery
        .write_output("session-1", b"hello from recovery\r\n", 1)
        .await;

    let snapshot = recovery
        .get_snapshot("session-1")
        .await
        .expect("snapshot request should succeed")
        .expect("snapshot should exist");

    assert!(snapshot.serialized.contains("hello from recovery"));
}

#[tokio::test]
async fn recovery_end_session_removes_snapshot_artifact() {
    let recovery = RecoveryManager::new_for_test()
        .await
        .expect("test recovery manager should start");

    recovery
        .seed_snapshot(
            "session-2",
            &SeededRecoverySnapshot {
                serialized: "bye\r\n".to_string(),
                cols: 80,
                rows: 24,
                cursor_row: 0,
                cursor_col: 0,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
            },
        )
        .expect("should seed persisted recovery snapshot");

    recovery
        .start_session("session-2", 80, 24, true)
        .await
        .expect("start_session should succeed");

    let snapshot_path = recovery.snapshot_file_for_test("session-2");
    assert!(snapshot_path.exists(), "snapshot file should be seeded");

    recovery.end_session("session-2").await;

    let mut removed = false;
    for _ in 0..60 {
        if !snapshot_path.exists() {
            removed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(removed, "ended sessions should not keep recovery artifacts");
    assert!(
        recovery
            .get_snapshot("session-2")
            .await
            .expect("snapshot lookup should succeed")
            .is_none(),
        "ended sessions should not return snapshots"
    );
}

#[tokio::test]
async fn recovery_start_session_surfaces_invalid_snapshot_file() {
    let recovery = RecoveryManager::new_for_test()
        .await
        .expect("test recovery manager should start");

    let path = recovery.snapshot_file_for_test("session-bad");
    std::fs::write(&path, b"not valid json").expect("should seed invalid recovery file");

    let error = recovery
        .start_session("session-bad", 80, 24, true)
        .await
        .expect_err("invalid recovery snapshots should fail session restore");

    assert!(error.contains("persisted snapshot"));
}

#[tokio::test]
async fn recovery_seeded_snapshot_can_resume_adopted_session() {
    let recovery = RecoveryManager::new_for_test()
        .await
        .expect("test recovery manager should start");

    recovery
        .seed_snapshot(
            "adopted-session",
            &SeededRecoverySnapshot {
                serialized: "hello from handoff\r\n".to_string(),
                cols: 120,
                rows: 45,
                cursor_row: 1,
                cursor_col: 2,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
            },
        )
        .expect("should seed adopted recovery snapshot");

    recovery
        .start_session("adopted-session", 120, 45, true)
        .await
        .expect("seeded adopted session should resume from disk");

    let snapshot = recovery
        .get_snapshot("adopted-session")
        .await
        .expect("snapshot request should succeed")
        .expect("snapshot should exist");

    assert!(snapshot.serialized.contains("hello from handoff"));
    assert_eq!(snapshot.cols, 120);
    assert_eq!(snapshot.rows, 45);
}

#[tokio::test]
async fn recovery_manager_rejects_hostile_ids_before_worker_send_or_replay() {
    let recovery = RecoveryManager::new_for_test()
        .await
        .expect("test recovery manager should start");

    for session_id in [
        "../kanna-recovery-manager-canary",
        "/etc/passwd",
        "Upper",
        "caf\u{e9}",
    ] {
        for resume_from_disk in [true, false] {
            let error = recovery
                .start_session(session_id, 80, 24, resume_from_disk)
                .await
                .expect_err("hostile id must be rejected before worker send");
            assert!(
                error.contains("unsafe id"),
                "unexpected start_session error for {session_id:?}: {error}"
            );
        }

        let error = recovery
            .get_snapshot(session_id)
            .await
            .expect_err("hostile id must be rejected before worker send");
        assert!(
            error.contains("unsafe session id"),
            "unexpected get_snapshot error for {session_id:?}: {error}"
        );
    }

    recovery
        .reconnect_worker_for_test()
        .await
        .expect("rejected starts must not poison tracked-session replay");
    assert!(
        recovery
            .get_snapshot("safe-reconnect-probe")
            .await
            .expect("fresh worker should answer after replay")
            .is_none(),
        "fresh worker should not have an unexpected probe snapshot"
    );
}

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
    Snapshot {
        session_id: String,
    },
    SeedSnapshot {
        session_id: String,
        snapshot: SeedSnapshotPayload,
    },
    List,
    Kill {
        session_id: String,
    },
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
    Snapshot {
        session_id: String,
        snapshot: SnapshotPayload,
    },
    StatusChanged {
        session_id: String,
        status: SessionStatus,
    },
    SessionList {
        sessions: Vec<SessionListEntry>,
    },
    Ok,
    Error {
        code: Option<ErrorCode>,
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct SessionListEntry {
    session_id: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct SnapshotPayload {
    version: u32,
    rows: u16,
    cols: u16,
    #[serde(alias = "cursorRow")]
    cursor_row: u16,
    #[serde(alias = "cursorCol")]
    cursor_col: u16,
    #[serde(alias = "cursorVisible")]
    cursor_visible: bool,
    vt: String,
}

#[derive(Debug, Serialize)]
struct SeedSnapshotPayload {
    version: u32,
    rows: u16,
    cols: u16,
    cursor_row: u16,
    cursor_col: u16,
    cursor_visible: bool,
    vt: String,
}

fn compute_socket_path(dir: &Path) -> PathBuf {
    kanna_runtime_defaults::socket_path(dir)
}

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
    _dir: PathBuf,
}

static DAEMON_START_COUNTER: AtomicU64 = AtomicU64::new(0);

impl DaemonHandle {
    fn start() -> Self {
        let id = DAEMON_START_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("kanna-recovery-test-{}-{}", std::process::id(), id));
        std::fs::create_dir_all(&dir).expect("should create test daemon dir");

        let socket_path = compute_socket_path(&dir);
        let _ = std::fs::remove_file(&socket_path);
        let pid_path = dir.join("daemon.pid");
        let _ = std::fs::remove_file(&pid_path);

        let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
        let child = Command::new(&daemon_bin)
            .env(
                "KANNA_DAEMON_DIR",
                dir.to_str().expect("temp path should be utf8"),
            )
            .spawn()
            .expect("failed to start daemon");

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

        Self {
            child,
            socket_path,
            _dir: dir,
        }
    }

    fn connect(&self) -> ClientConn {
        let stream = UnixStream::connect(&self.socket_path).expect("failed to connect to daemon");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("should set read timeout");
        ClientConn {
            reader: BufReader::new(stream.try_clone().expect("should clone stream")),
            writer: stream,
        }
    }

    /// Best-effort teardown of every session this daemon still owns, before
    /// the daemon is killed under them. Silent on failure: some fixtures
    /// arrange for the daemon to be gone already.
    fn kill_live_sessions(&self) {
        let Ok(stream) = UnixStream::connect(&self.socket_path) else {
            return;
        };
        // Only if this handle's own daemon is still the one serving: a
        // superseded handle is dropped while its successor holds the socket,
        // and killing that successor's sessions would destroy the thing under
        // test.
        if kanna_daemon::proc_info::socket_peer_pid(stream.as_raw_fd())
            != Some(self.child.id() as libc::pid_t)
        {
            return;
        }
        if stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .is_err()
        {
            return;
        }
        let Ok(clone) = stream.try_clone() else {
            return;
        };
        let mut conn = ClientConn {
            reader: BufReader::new(clone),
            writer: stream,
        };
        conn.send(&Cmd::List);
        let deadline = Instant::now() + Duration::from_secs(5);
        let sessions = loop {
            if Instant::now() >= deadline {
                return;
            }
            let mut line = String::new();
            if conn.reader.read_line(&mut line).is_err() {
                return;
            }
            match serde_json::from_str::<Evt>(line.trim()) {
                Ok(Evt::SessionList { sessions }) => break sessions,
                Ok(_) => continue,
                Err(_) => return,
            }
        };
        for entry in sessions {
            conn.send(&Cmd::Kill {
                session_id: entry.session_id,
            });
        }
        let mut line = String::new();
        let _ = conn.reader.read_line(&mut line);
    }

    fn journal_path(&self, session_id: &str) -> PathBuf {
        self._dir
            .join("agent-journals")
            .join(format!("{session_id}.ndjson"))
    }

    fn journal_metadata_path(&self, session_id: &str) -> PathBuf {
        self._dir
            .join("agent-journals")
            .join(format!("{session_id}.meta.json"))
    }

    fn recovery_snapshot_path(&self, session_id: &str) -> PathBuf {
        self._dir
            .join("terminal-recovery")
            .join(format!("{session_id}.json"))
    }
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        // See `reconnect.rs`: a SIGKILLed daemon runs no teardown sweep, so
        // its session processes are orphaned to init and outlive the run.
        self.kill_live_sessions();
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self._dir);
    }
}

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl ClientConn {
    fn send(&mut self, cmd: &Cmd) {
        let mut json = serde_json::to_string(cmd).expect("should serialize command");
        json.push('\n');
        self.writer
            .write_all(json.as_bytes())
            .expect("should write command");
        self.writer.flush().expect("should flush command");
    }

    fn recv(&mut self) -> Evt {
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read timed out");
        serde_json::from_str(line.trim())
            .unwrap_or_else(|error| panic!("failed to parse event: {} — {:?}", error, line.trim()))
    }

    fn recv_until_exit(&mut self, session_id: &str) -> i32 {
        loop {
            match self.recv() {
                Evt::Exit {
                    session_id: exited_id,
                    code,
                } if exited_id == session_id => return code,
                Evt::Output { .. } => continue,
                Evt::StatusChanged { .. } => continue,
                other => panic!("expected Exit for {}, got {:?}", session_id, other),
            }
        }
    }
}

fn write_executable(path: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(path, contents).expect("should write sentinel executable");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .expect("should make sentinel executable");
}

fn snapshot_payload(vt: &str) -> SeedSnapshotPayload {
    SeedSnapshotPayload {
        version: 1,
        rows: 24,
        cols: 80,
        cursor_row: 0,
        cursor_col: 0,
        cursor_visible: true,
        vt: vt.to_string(),
    }
}

fn persisted_snapshot(session_id: &str, vt: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "sessionId": session_id,
        "serialized": vt,
        "cols": 80,
        "rows": 24,
        "cursorRow": 0,
        "cursorCol": 0,
        "cursorVisible": true,
        "savedAt": 1,
        "sequence": 1
    }))
    .expect("should serialize planted snapshot")
}

#[test]
fn hostile_pty_session_ids_are_rejected_before_spawn_or_persistence() {
    let daemon = DaemonHandle::start();
    std::fs::create_dir_all(daemon._dir.join("agent-journals")).unwrap();
    std::fs::create_dir_all(daemon._dir.join("terminal-recovery")).unwrap();
    let executable = daemon._dir.join("pty-spawn-sentinel.sh");
    write_executable(
        &executable,
        "#!/bin/sh\nprintf 'pty child ran' > \"$SENTINEL_FILE\"\nprintf 'output'\nsleep 1\n",
    );

    for (index, session_id) in ["../outside-pty", "Pty", "caf\u{e9}"]
        .into_iter()
        .enumerate()
    {
        let sentinel = daemon._dir.join(format!("pty-sentinel-{index}"));
        let mut env = HashMap::new();
        env.insert(
            "SENTINEL_FILE".to_string(),
            sentinel.to_string_lossy().to_string(),
        );
        let mut conn = daemon.connect();
        conn.send(&Cmd::Spawn {
            session_id: session_id.to_string(),
            executable: executable.to_string_lossy().to_string(),
            args: Vec::new(),
            cwd: daemon._dir.to_string_lossy().to_string(),
            env,
            cols: 80,
            rows: 24,
        });

        match conn.recv() {
            Evt::Error { code, message } => {
                assert_eq!(code, Some(ErrorCode::PtySpawnFailed));
                assert!(
                    message.contains("invalid session id"),
                    "unexpected spawn error for {session_id:?}: {message}"
                );
            }
            other => panic!("expected PtySpawnFailed for {session_id:?}, got {other:?}"),
        }

        conn.send(&Cmd::List);
        match conn.recv() {
            Evt::SessionList { sessions } => assert!(
                sessions
                    .iter()
                    .all(|session| session.session_id != session_id),
                "hostile PTY id {session_id:?} entered the registry"
            ),
            other => panic!("expected SessionList after rejected spawn, got {other:?}"),
        }

        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !sentinel.exists(),
            "PTY executable ran for hostile id {session_id:?}"
        );
        assert!(
            !daemon.journal_path(session_id).exists(),
            "journal created for hostile id {session_id:?}"
        );
        assert!(
            !daemon.journal_metadata_path(session_id).exists(),
            "journal metadata created for hostile id {session_id:?}"
        );
        assert!(
            !daemon.recovery_snapshot_path(session_id).exists(),
            "recovery snapshot created for hostile id {session_id:?}"
        );
    }
}

#[test]
fn hostile_snapshot_ids_cannot_disclose_planted_snapshot_files() {
    const SECRET: &str = "outside snapshot secret";
    let daemon = DaemonHandle::start();
    std::fs::create_dir_all(daemon._dir.join("terminal-recovery")).unwrap();

    for session_id in ["../outside-snapshot", "Snapshot", "caf\u{e9}"] {
        let planted_path = daemon.recovery_snapshot_path(session_id);
        std::fs::write(&planted_path, persisted_snapshot(session_id, SECRET))
            .expect("should plant snapshot at vulnerable path");

        let mut conn = daemon.connect();
        conn.send(&Cmd::Snapshot {
            session_id: session_id.to_string(),
        });
        match conn.recv() {
            Evt::Error { code, message } => {
                assert_eq!(code, Some(ErrorCode::SessionNotFound));
                assert!(
                    message.contains("invalid session id"),
                    "unexpected snapshot error for {session_id:?}: {message}"
                );
                assert!(
                    !message.contains(SECRET),
                    "snapshot contents leaked in rejection"
                );
            }
            Evt::Snapshot { .. } => {
                panic!("hostile id {session_id:?} disclosed a planted snapshot")
            }
            other => panic!("expected invalid-session error for {session_id:?}, got {other:?}"),
        }
    }
}

#[test]
fn hostile_seed_snapshot_ids_cannot_overwrite_planted_files() {
    let daemon = DaemonHandle::start();
    std::fs::create_dir_all(daemon._dir.join("terminal-recovery")).unwrap();

    for session_id in ["../outside-seed", "Seed", "caf\u{e9}"] {
        let planted_path = daemon.recovery_snapshot_path(session_id);
        let sentinel = persisted_snapshot(session_id, "sentinel snapshot contents");
        std::fs::write(&planted_path, &sentinel).expect("should plant file at vulnerable path");

        let mut conn = daemon.connect();
        conn.send(&Cmd::SeedSnapshot {
            session_id: session_id.to_string(),
            snapshot: snapshot_payload("overwrite attempt"),
        });
        match conn.recv() {
            Evt::Error { message, .. } => assert!(
                message.contains("invalid session id"),
                "unexpected seed error for {session_id:?}: {message}"
            ),
            other => panic!("expected invalid-session error for {session_id:?}, got {other:?}"),
        }

        assert_eq!(
            std::fs::read(&planted_path).expect("planted file should remain readable"),
            sentinel,
            "seeding hostile id {session_id:?} changed the planted file"
        );
    }
}

#[test]
fn daemon_does_not_serve_snapshot_after_session_exit() {
    let daemon = DaemonHandle::start();
    let session_id = "exiting-session";
    let mut conn = daemon.connect();

    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec!["-lc".to_string(), "printf 'done\\n'".to_string()],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });

    match conn.recv() {
        Evt::SessionCreated {
            session_id: created,
        } => assert_eq!(created, session_id),
        other => panic!("expected SessionCreated, got {:?}", other),
    }

    conn.send(&Cmd::AttachSnapshot {
        session_id: session_id.to_string(),
    });
    loop {
        match conn.recv() {
            Evt::Snapshot { .. } => break,
            Evt::StatusChanged { .. } => continue,
            other => panic!("expected Snapshot, got {:?}", other),
        }
    }

    let exit_code = conn.recv_until_exit(session_id);
    assert_eq!(exit_code, 0);

    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match conn.recv() {
        Evt::Error { message, .. } => assert!(
            message.contains("session not found"),
            "unexpected snapshot error: {}",
            message
        ),
        other => panic!("expected snapshot error, got {:?}", other),
    }
}

#[test]
fn daemon_seed_snapshot_command_serves_seeded_snapshot() {
    let daemon = DaemonHandle::start();
    let session_id = "seeded-session";
    let mut conn = daemon.connect();

    conn.send(&Cmd::SeedSnapshot {
        session_id: session_id.to_string(),
        snapshot: SeedSnapshotPayload {
            version: 1,
            rows: 31,
            cols: 101,
            cursor_row: 4,
            cursor_col: 7,
            cursor_visible: true,
            vt: "seeded snapshot output".to_string(),
        },
    });
    match conn.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok from seed snapshot, got {:?}", other),
    }

    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match conn.recv() {
        Evt::Snapshot {
            session_id: snap_session,
            snapshot,
        } => {
            assert_eq!(snap_session, session_id);
            assert_eq!(snapshot.rows, 31);
            assert_eq!(snapshot.cols, 101);
            assert_eq!(snapshot.cursor_row, 4);
            assert_eq!(snapshot.cursor_col, 7);
            assert!(snapshot.cursor_visible);
            assert_eq!(snapshot.vt, "seeded snapshot output");
        }
        other => panic!("expected seeded Snapshot response, got {:?}", other),
    }
}

#[test]
fn daemon_seed_snapshot_survives_next_spawn_and_appends_live_output() {
    let daemon = DaemonHandle::start();
    let session_id = "seeded-spawn-session";
    let mut conn = daemon.connect();

    conn.send(&Cmd::SeedSnapshot {
        session_id: session_id.to_string(),
        snapshot: SeedSnapshotPayload {
            version: 1,
            rows: 31,
            cols: 101,
            cursor_row: 4,
            cursor_col: 7,
            cursor_visible: false,
            vt: "\u{1b}[2J\u{1b}[Hseeded snapshot output".to_string(),
        },
    });
    match conn.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok from seed snapshot, got {:?}", other),
    }

    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec![
            "-lc".to_string(),
            "sleep 0.4; printf '\\r\\nnew live output'; sleep 2".to_string(),
        ],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });
    match conn.recv() {
        Evt::SessionCreated {
            session_id: created,
        } => assert_eq!(created, session_id),
        other => panic!("expected SessionCreated, got {:?}", other),
    }

    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match conn.recv() {
        Evt::Snapshot { snapshot, .. } => {
            assert_eq!((snapshot.cols, snapshot.rows), (101, 31));
            assert_eq!((snapshot.cursor_row, snapshot.cursor_col), (4, 7));
            assert!(!snapshot.cursor_visible);
            assert!(snapshot.vt.contains("seeded snapshot output"));
        }
        other => panic!("expected restored Snapshot, got {:?}", other),
    }

    std::thread::sleep(Duration::from_millis(700));
    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match conn.recv() {
        Evt::Snapshot { snapshot, .. } => {
            assert_eq!((snapshot.cols, snapshot.rows), (101, 31));
            assert!(snapshot.vt.contains("seeded snapshot output"));
            assert!(snapshot.vt.contains("new live output"));
        }
        other => panic!("expected appended Snapshot, got {:?}", other),
    }
}

#[test]
fn daemon_spawn_does_not_resume_an_unmarked_stale_snapshot() {
    let daemon = DaemonHandle::start();
    let session_id = "stale-spawn-session";
    let snapshot_dir = daemon._dir.join("terminal-recovery");
    std::fs::create_dir_all(&snapshot_dir).expect("snapshot dir should exist");
    std::fs::write(
        snapshot_dir.join(format!("{session_id}.json")),
        serde_json::to_vec(&serde_json::json!({
            "sessionId": session_id,
            "serialized": "\u{1b}[2J\u{1b}[Hstale snapshot output",
            "cols": 101,
            "rows": 31,
            "cursorRow": 4,
            "cursorCol": 7,
            "cursorVisible": true,
            "savedAt": 1,
            "sequence": 1
        }))
        .unwrap(),
    )
    .expect("stale snapshot should write");

    let mut conn = daemon.connect();
    conn.send(&Cmd::Spawn {
        session_id: session_id.to_string(),
        executable: "/bin/sh".to_string(),
        args: vec!["-lc".to_string(), "sleep 2".to_string()],
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
    });
    match conn.recv() {
        Evt::SessionCreated {
            session_id: created,
        } => assert_eq!(created, session_id),
        other => panic!("expected SessionCreated, got {:?}", other),
    }

    conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match conn.recv() {
        Evt::Snapshot { snapshot, .. } => {
            assert_eq!((snapshot.cols, snapshot.rows), (80, 24));
            assert!(!snapshot.vt.contains("stale snapshot output"));
        }
        other => panic!("expected fresh Snapshot, got {:?}", other),
    }
}

#[test]
fn concurrent_duplicate_spawn_cannot_steal_the_seeded_snapshot() {
    let daemon = DaemonHandle::start();
    let session_id = "concurrent-seeded-spawn-session";
    let mut seed_conn = daemon.connect();
    let seeded_vt = format!("\u{1b}[2J\u{1b}[H{}seeded race marker", "x".repeat(10_000));

    seed_conn.send(&Cmd::SeedSnapshot {
        session_id: session_id.to_string(),
        snapshot: SeedSnapshotPayload {
            version: 1,
            rows: 31,
            cols: 101,
            cursor_row: 4,
            cursor_col: 7,
            cursor_visible: false,
            vt: seeded_vt,
        },
    });
    match seed_conn.recv() {
        Evt::Ok => {}
        other => panic!("expected Ok from seed snapshot, got {:?}", other),
    }

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let spawn = |mut conn: ClientConn, barrier: std::sync::Arc<std::sync::Barrier>| {
        std::thread::spawn(move || {
            barrier.wait();
            conn.send(&Cmd::Spawn {
                session_id: session_id.to_string(),
                executable: "/bin/sh".to_string(),
                args: vec!["-lc".to_string(), "sleep 2".to_string()],
                cwd: "/tmp".to_string(),
                env: HashMap::new(),
                cols: 80,
                rows: 24,
            });
            conn.recv()
        })
    };
    let first = spawn(daemon.connect(), barrier.clone());
    let second = spawn(daemon.connect(), barrier.clone());
    barrier.wait();

    let first_event = first.join().expect("first spawn thread should finish");
    let second_event = second.join().expect("second spawn thread should finish");
    assert!(
        matches!(
            (&first_event, &second_event),
            (Evt::SessionCreated { .. }, Evt::Error { .. })
                | (Evt::Error { .. }, Evt::SessionCreated { .. })
        ),
        "expected one winning and one rejected spawn, got {first_event:?} and {second_event:?}"
    );

    let mut snapshot_conn = daemon.connect();
    snapshot_conn.send(&Cmd::Snapshot {
        session_id: session_id.to_string(),
    });
    match snapshot_conn.recv() {
        Evt::Snapshot { snapshot, .. } => {
            assert_eq!((snapshot.cols, snapshot.rows), (101, 31));
            assert_eq!((snapshot.cursor_row, snapshot.cursor_col), (4, 7));
            assert!(!snapshot.cursor_visible);
            assert!(snapshot.vt.contains("seeded race marker"));
        }
        other => panic!("expected seeded Snapshot from winning spawn, got {other:?}"),
    }
}
