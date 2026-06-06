use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn compute_socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

fn unique_temp_root(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("kanna-{name}-{}-{nanos}", std::process::id()))
}

fn wait_for_daemon(child: &Child, daemon_dir: &Path) {
    let pid_path = daemon_dir.join("daemon.pid");
    let socket_path = compute_socket_path(&daemon_dir.to_path_buf());

    for _ in 0..50 {
        let pid_matches = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok())
            == Some(child.id());
        if pid_matches && UnixStream::connect(&socket_path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    panic!(
        "daemon did not become ready at {} with socket {}",
        pid_path.display(),
        socket_path.display()
    );
}

#[test]
fn worktree_daemon_ignores_production_default_env_and_writes_runtime_files_locally() {
    let root = unique_temp_root("daemon-worktree-isolation");
    let home = root.join("home");
    let worktree = root
        .join("repo")
        .join(".kanna-worktrees")
        .join("task-isolation");
    let production_daemon_dir = home
        .join("Library")
        .join("Application Support")
        .join("Kanna");

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
        wait_for_daemon(&child, &expected_daemon_dir);

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
