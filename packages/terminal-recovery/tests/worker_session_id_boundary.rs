use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use kanna_terminal_recovery::protocol::{RecoveryCommand, RecoveryResponse};

const CANARY_STEM: &str = "kanna-worker-session-id-canary";
const CANARY_CONTENTS: &[u8] = b"worker boundary secret";

#[test]
fn worker_exits_promptly_when_daemon_control_channel_reaches_eof() {
    let temp = tempfile::tempdir().expect("temporary test directory");
    let mut child = Command::new(env!("CARGO_BIN_EXE_kanna-terminal-recovery"))
        .env("KANNA_TERMINAL_RECOVERY_DIR", temp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("spawn recovery worker");

    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().expect("poll recovery worker") {
            assert!(
                status.success(),
                "EOF should stop the recovery worker cleanly"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "recovery worker stayed alive after its daemon channel closed"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn worker_rejects_hostile_session_ids_at_the_ndjson_boundary() {
    let temp = tempfile::tempdir().expect("temporary test directory");
    let snapshot_root = temp.path().join("snapshots");
    std::fs::create_dir_all(&snapshot_root).expect("snapshot root");
    let canary = temp.path().join(format!("{CANARY_STEM}.json"));
    std::fs::write(&canary, CANARY_CONTENTS).expect("plant canary outside snapshot root");

    let mut child = Command::new(env!("CARGO_BIN_EXE_kanna-terminal-recovery"))
        .env("KANNA_TERMINAL_RECOVERY_DIR", &snapshot_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn recovery worker");
    let mut stdin = child.stdin.take().expect("worker stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("worker stdout"));

    let hostile_ids = [
        format!("../{CANARY_STEM}"),
        "/etc/passwd".to_string(),
        "Upper".to_string(),
        "caf\u{e9}".to_string(),
    ];

    for session_id in hostile_ids {
        let commands = [
            RecoveryCommand::GetSnapshot {
                session_id: session_id.clone(),
            },
            RecoveryCommand::StartSession {
                session_id: session_id.clone(),
                cols: 80,
                rows: 24,
                resume_from_disk: true,
            },
            RecoveryCommand::StartSession {
                session_id: session_id.clone(),
                cols: 80,
                rows: 24,
                resume_from_disk: false,
            },
            RecoveryCommand::EndSession {
                session_id: session_id.clone(),
            },
        ];

        for command in commands {
            let response = send_command(&mut stdin, &mut stdout, &command);
            match response {
                RecoveryResponse::Error { message } => assert!(
                    !message.contains(std::str::from_utf8(CANARY_CONTENTS).unwrap()),
                    "worker leaked canary contents for {command:?}: {message}"
                ),
                other => panic!(
                    "worker must reject hostile id {session_id:?} for {command:?}, got {other:?}"
                ),
            }
        }
    }

    assert_eq!(
        std::fs::read(&canary).expect("canary remains readable"),
        CANARY_CONTENTS,
        "worker modified the file outside the snapshot root"
    );

    assert_eq!(
        send_command(&mut stdin, &mut stdout, &RecoveryCommand::FlushAndShutdown),
        RecoveryResponse::Ok
    );
    drop(stdin);
    assert!(
        child.wait().expect("wait for recovery worker").success(),
        "recovery worker should exit cleanly"
    );
}

fn send_command(
    stdin: &mut impl Write,
    stdout: &mut impl BufRead,
    command: &RecoveryCommand,
) -> RecoveryResponse {
    serde_json::to_writer(&mut *stdin, command).expect("serialize recovery command");
    stdin.write_all(b"\n").expect("terminate recovery command");
    stdin.flush().expect("flush recovery command");

    let mut line = String::new();
    let bytes = stdout.read_line(&mut line).expect("read recovery response");
    assert_ne!(bytes, 0, "worker closed before responding to {command:?}");
    serde_json::from_str(line.trim()).expect("parse recovery response")
}
