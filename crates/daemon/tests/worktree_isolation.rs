use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Starting a process and having it publish a socket is an eventual event with
/// no product latency contract. This deadline only contains a wedged child.
const EVENTUAL_PROGRESS_GUARD: Duration = Duration::from_secs(30);

fn compute_socket_path(dir: &Path) -> PathBuf {
    kanna_runtime_defaults::socket_path(dir)
}

fn unique_temp_root(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("kanna-{name}-{}-{nanos}", std::process::id()))
}

/// Wait for *this* daemon generation to publish a connectable socket.
///
/// The PID file is written immediately before the socket is bound, so the PID
/// alone is not readiness; production clients require both, and so does this
/// harness. A fixed five-second budget used to stand in for that event, which
/// on a loaded box failed a daemon that was merely slow to start rather than
/// one that never started.
fn wait_for_daemon(child: &mut Child, daemon_dir: &Path) {
    let pid_path = daemon_dir.join("daemon.pid");
    let socket_path = compute_socket_path(daemon_dir);
    let deadline = Instant::now() + EVENTUAL_PROGRESS_GUARD;
    let mut last_pid;
    let mut last_connect_error = None;
    loop {
        if let Some(status) = child.try_wait().expect("daemon status should be readable") {
            panic!("daemon exited before becoming ready: {status}");
        }
        last_pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok());
        if last_pid == Some(child.id()) {
            match UnixStream::connect(&socket_path) {
                Ok(_) => return,
                Err(error) => last_connect_error = Some(error),
            }
        }
        assert!(
            Instant::now() < deadline,
            "daemon {} never published a connectable socket at {} (pid file at {} held \
             {last_pid:?}, last connect error: {last_connect_error:?})",
            child.id(),
            socket_path.display(),
            pid_path.display(),
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn worktree_daemon_ignores_production_default_env_and_writes_runtime_files_locally() {
    let root = unique_temp_root("daemon-worktree-isolation");
    let home = root.join("home");
    let worktree = root
        .join("repo")
        .join(".kanna-worktrees")
        .join("task-isolation");
    // The value a production launcher would pass. It must come from the
    // resolver rather than a literal: the daemon ignores this env var only by
    // recognising it as *this platform's* production default, and that path
    // is `~/Library/Application Support/Kanna` on macOS but an XDG data
    // directory on Linux.
    let production_daemon_dir = kanna_runtime_defaults::default_daemon_dir_for_home(&home);

    std::fs::create_dir_all(&worktree).expect("worktree cwd should be created");
    let expected_daemon_dir = worktree.join(".kanna-daemon");
    let expected_socket_path = compute_socket_path(&expected_daemon_dir);

    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
    let worktree_daemon_bin = worktree.join("bin").join("kanna-daemon");
    std::fs::create_dir_all(worktree_daemon_bin.parent().unwrap())
        .expect("worktree bin dir should be created");
    std::fs::copy(&daemon_bin, &worktree_daemon_bin).expect("daemon binary should copy");
    let mut permissions = std::fs::metadata(&worktree_daemon_bin)
        .expect("copied daemon binary should stat")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&worktree_daemon_bin, permissions)
        .expect("copied daemon binary should be executable");

    let mut child = Command::new(&worktree_daemon_bin)
        .current_dir(&worktree)
        .env("HOME", &home)
        .env("KANNA_DAEMON_DIR", &production_daemon_dir)
        .spawn()
        .expect("daemon should start");

    let test_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_for_daemon(&mut child, &expected_daemon_dir);

        assert!(
            expected_daemon_dir.join("daemon.pid").exists(),
            "worktree daemon pid should be written under {}",
            expected_daemon_dir.display()
        );
        assert!(
            compute_socket_path(&expected_daemon_dir).exists(),
            "worktree daemon socket should be bound"
        );
        assert!(
            std::fs::read_dir(&expected_daemon_dir)
                .expect("worktree daemon dir should be readable")
                .flatten()
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("kanna-daemon_")
                }),
            "daemon log should be written under {}",
            expected_daemon_dir.display()
        );
        assert!(
            !production_daemon_dir.join("daemon.pid").exists(),
            "production daemon dir must not receive this worktree daemon pid"
        );
    }));

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&expected_socket_path);
    let _ = std::fs::remove_dir_all(&root);

    if let Err(payload) = test_result {
        std::panic::resume_unwind(payload);
    }
}
