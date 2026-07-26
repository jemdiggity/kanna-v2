use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
    Ok,
    Error {
        message: String,
    },
    #[serde(other)]
    Unknown,
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
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
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
        Evt::Error { message } => assert!(
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
