//! End-to-end coverage for version-aware agent-status detection.
//!
//! These drive a real daemon process over its unix socket, so they cross the
//! whole path the feature actually lives on: the `Spawn` command carrying the
//! provider executable, the daemon's own version probe, rule selection inside
//! the classifier, the status timer, and the `StatusChanged` broadcast the
//! server consumes. Unit tests can prove a rule matches a frame; only this can
//! prove the daemon selected that rule for the CLI the session is running.
//!
//! Run single-threaded like the other daemon tests:
//! `cargo test --test detection_rules -- --test-threads=1`

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static TEST_INSTANCE_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// An OpenCode frame drawn with the **1.16.2** working-footer spelling, above
/// the composer status line that proves the session has parked.
///
/// The two verdicts this frame can carry are the whole point: under 1.16.2's
/// rules the footer is a live turn, and under 1.18.15's — which renamed it to
/// "esc interrupt" — nothing matches the footer and the composer status line
/// decides instead. One pattern set cannot be right for both machines.
const OPENCODE_1_16_FRAME: &str = concat!(
    "printf '\\033[2J\\033[H",
    "Ran the build.\\r\\n",
    "\\342\\224\\203 Build \\302\\267 Big Pickle OpenCode Zen\\r\\n",
    "\\342\\254\\235\\342\\254\\235\\342\\254\\235\\342\\254\\235 escape interrupt  tab agents\\r\\n'; ",
    "sleep 30"
);

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
    dir: PathBuf,
}

impl DaemonHandle {
    fn start(label: &str) -> Self {
        Self::start_with_env(label, &[])
    }

    fn start_with_env(label: &str, envs: &[(&str, &str)]) -> Self {
        let instance = TEST_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "kanna-detection-test-{label}-{}-{instance}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let socket_path = kanna_runtime_defaults::socket_path(&dir);
        let _ = std::fs::remove_file(&socket_path);
        let pid_path = dir.join("daemon.pid");
        let _ = std::fs::remove_file(&pid_path);

        let mut command = Command::new(PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon")));
        command.env("KANNA_DAEMON_DIR", dir.to_str().unwrap());
        for (key, value) in envs {
            command.env(key, value);
        }
        let child = command.spawn().expect("failed to start daemon");

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
            UnixStream::connect(&socket_path).is_ok(),
            "daemon was not ready at {socket_path:?}"
        );

        Self {
            child,
            socket_path,
            dir,
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
        let _ = std::fs::remove_file(&self.socket_path);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl ClientConn {
    fn send(&mut self, command: &Value) {
        let mut line = serde_json::to_string(command).unwrap();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    fn recv_with_timeout(&mut self, timeout: Duration) -> Option<Value> {
        self.reader.get_mut().set_read_timeout(Some(timeout)).ok()?;
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(line.trim()).ok(),
        }
    }

    /// Wait for the session to publish `status`, or report what it published
    /// instead. Deliberately not "the next event": the daemon interleaves
    /// output with status on one stream.
    fn wait_for_status(&mut self, session_id: &str, status: &str, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            match self.recv_with_timeout(remaining.min(Duration::from_millis(200))) {
                Some(event)
                    if event["type"] == "StatusChanged"
                        && event["session_id"] == session_id
                        && event["status"] == status =>
                {
                    return true
                }
                _ => continue,
            }
        }
    }
}

/// A stand-in for an installed provider CLI that answers `--version` and
/// nothing else. The daemon probes the path the server resolved, so a script
/// is a complete substitute for the real binary here.
fn fake_cli(dir: &Path, name: &str, version: &str) -> String {
    let path = dir.join(name);
    std::fs::write(
        &path,
        format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '{version}'; fi\n"),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().to_string()
}

fn spawn_opencode_session(
    daemon: &DaemonHandle,
    conn: &mut ClientConn,
    session_id: &str,
    script: &str,
    agent_executable: Option<String>,
) {
    let mut command = json!({
        "type": "Spawn",
        "session_id": session_id,
        "executable": "/bin/sh",
        "args": ["-c", script],
        "cwd": "/tmp",
        "env": {},
        "cols": 120,
        "rows": 40,
        "agent_provider": "opencode",
    });
    if let Some(executable) = agent_executable {
        command["agent_executable"] = Value::String(executable);
    }
    let _ = daemon;
    conn.send(&command);
}

/// The installed release decides which patterns apply.
///
/// This frame carries the footer spelling 1.16.2 drew. The session is running
/// 1.18.15, which renamed it — so no busy rule matches, and the composer
/// status line settles the session to idle. That verdict is only reachable
/// once the daemon has probed the CLI: it is the proof that version selection
/// happened, not merely that the rules could express it.
#[test]
fn the_probed_cli_version_selects_which_patterns_apply() {
    let daemon = DaemonHandle::start("version-selects");
    let executable = fake_cli(&daemon.dir, "opencode-new", "opencode 1.18.15");

    let mut subscriber = daemon.connect();
    subscriber.send(&json!({ "type": "Subscribe" }));

    let mut control = daemon.connect();
    spawn_opencode_session(
        &daemon,
        &mut control,
        "version-new",
        OPENCODE_1_16_FRAME,
        Some(executable),
    );

    assert!(
        subscriber.wait_for_status("version-new", "idle", Duration::from_secs(15)),
        "a session on 1.18.15 must not be held busy by a footer spelling its \
         CLI stopped drawing"
    );
}

/// And the same frame on the release that drew it stays busy.
///
/// The negative half matters as much as the positive one: version gating that
/// dropped the old spelling outright would look identical in the test above
/// and be a regression for every machine still on 1.16.
#[test]
fn an_older_cli_keeps_the_footer_spelling_its_release_drew() {
    let daemon = DaemonHandle::start("version-old");
    let executable = fake_cli(&daemon.dir, "opencode-old", "opencode 1.16.2");

    let mut subscriber = daemon.connect();
    subscriber.send(&json!({ "type": "Subscribe" }));

    let mut control = daemon.connect();
    spawn_opencode_session(
        &daemon,
        &mut control,
        "version-old",
        OPENCODE_1_16_FRAME,
        Some(executable),
    );

    assert!(
        !subscriber.wait_for_status("version-old", "idle", Duration::from_secs(6)),
        "a session on 1.16.2 must still read its own working footer as a live turn"
    );
}

/// A session whose provider executable was never sent — an older server, or a
/// spawn that names no agent CLI — classifies from every rule measured for its
/// provider. Unknown is a first-class answer, not a gap.
#[test]
fn an_unprobed_session_applies_every_measured_pattern() {
    let daemon = DaemonHandle::start("version-unknown");

    let mut subscriber = daemon.connect();
    subscriber.send(&json!({ "type": "Subscribe" }));

    let mut control = daemon.connect();
    spawn_opencode_session(
        &daemon,
        &mut control,
        "version-unknown",
        OPENCODE_1_16_FRAME,
        None,
    );

    assert!(
        !subscriber.wait_for_status("version-unknown", "idle", Duration::from_secs(6)),
        "with no version to select by, every measured spelling must still apply"
    );
}

/// A pattern fix reaches a live session without a daemon release.
///
/// The frame below is chrome no bundled rule describes — the shape a provider
/// UI change arrives as, and the shape that leaves a session latched at
/// whatever status it last had. Writing the override is the whole remediation:
/// no restart, no redeploy, no new build.
#[test]
fn a_hot_reloaded_override_reaches_a_live_session() {
    let daemon = DaemonHandle::start("hot-reload");
    let override_path = daemon.dir.join("detection-rules.json");

    let mut subscriber = daemon.connect();
    subscriber.send(&json!({ "type": "Subscribe" }));

    let mut control = daemon.connect();
    let script = "printf '\\033[2J\\033[HTHE CLI SHIPPED A NEW FOOTER\\r\\n'; sleep 30";
    spawn_opencode_session(&daemon, &mut control, "hot-reload", script, None);

    assert!(
        !subscriber.wait_for_status("hot-reload", "idle", Duration::from_secs(4)),
        "the bundled rules must not classify a footer nobody has measured"
    );

    std::fs::write(
        &override_path,
        r#"{
          "schemaVersion": 1,
          "providers": [{
            "provider": "opencode",
            "rules": [{
              "id": "opencode/idle/new-footer",
              "status": "idle",
              "priority": 55,
              "when": { "anyLine": { "contains": "the cli shipped a new footer" } }
            }]
          }]
        }"#,
    )
    .unwrap();

    assert!(
        subscriber.wait_for_status("hot-reload", "idle", Duration::from_secs(15)),
        "a rule written into the override file must reach a session that is \
         already running"
    );
}

/// A broken override costs a machine nothing.
///
/// Refusing the file and keeping the rules already in force is the only safe
/// answer: a daemon that fell back to classifying nothing would turn a typo
/// into an outage for every session on the machine.
#[test]
fn a_broken_override_leaves_the_bundled_rules_in_force() {
    let daemon = DaemonHandle::start("broken-override");
    std::fs::write(
        daemon.dir.join("detection-rules.json"),
        "{ this is not json",
    )
    .unwrap();

    let mut subscriber = daemon.connect();
    subscriber.send(&json!({ "type": "Subscribe" }));

    let mut control = daemon.connect();
    let script = concat!(
        "printf '\\033[2J\\033[H",
        "Ran the build.\\r\\n",
        "\\342\\224\\203 Build \\302\\267 Big Pickle OpenCode Zen\\r\\n'; ",
        "sleep 30"
    );
    spawn_opencode_session(&daemon, &mut control, "broken-override", script, None);

    assert!(
        subscriber.wait_for_status("broken-override", "idle", Duration::from_secs(15)),
        "the bundled rules must keep classifying when an override cannot be read"
    );
}
