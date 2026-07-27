use super::*;
use std::sync::{Mutex, OnceLock};

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .expect("env lock should not be poisoned")
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }

    fn unset(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, previous }
    }
}

struct CwdGuard {
    previous: std::path::PathBuf,
}

impl CwdGuard {
    fn set(path: impl AsRef<std::path::Path>) -> Self {
        let previous = std::env::current_dir().expect("current dir should resolve");
        std::env::set_current_dir(path).expect("test cwd should be set");
        Self { previous }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        std::env::set_current_dir(&self.previous).expect("test cwd should be restored");
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.previous {
            std::env::set_var(self.key, value);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn from_env_uses_runtime_default_daemon_dir_inside_worktree() {
    let _lock = env_lock();
    let home = std::env::temp_dir().join(format!(
        "kanna-task-transfer-worktree-defaults-{}",
        std::process::id()
    ));
    let worktree = home
        .join("repo")
        .join(".kanna-worktrees")
        .join("task-transfer-test");
    std::fs::create_dir_all(&worktree).expect("worktree test dir should be created");
    let _cwd_guard = CwdGuard::set(&worktree);
    let _home_guard = EnvGuard::set("HOME", home.as_os_str());
    let _daemon_guard = EnvGuard::unset("KANNA_DAEMON_DIR");
    let _db_guard = EnvGuard::unset("KANNA_DB_PATH");
    let _cli_db_guard = EnvGuard::unset("KANNA_CLI_DB_PATH");
    let _transfer_root_guard = EnvGuard::unset("KANNA_TRANSFER_ROOT");
    let _registry_guard = EnvGuard::unset("KANNA_TRANSFER_REGISTRY_DIR");

    let config = RuntimeConfig::from_env().expect("runtime config should resolve");

    assert_eq!(
        config.daemon_dir,
        Some(kanna_runtime_defaults::daemon_dir_for_current_runtime())
    );
    assert_eq!(
        config.db_path,
        Some(
            home.join("Library")
                .join("Application Support")
                .join("build.kanna")
                .join("kanna-v2.db")
        )
    );
    assert_eq!(
        config.registry_dir,
        home.join("Library")
            .join("Application Support")
            .join("build.kanna")
            .join("transfer")
            .join("registry")
    );

    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn from_env_uses_runtime_default_daemon_dir_outside_worktree() {
    let _lock = env_lock();
    let home = std::env::temp_dir().join(format!(
        "kanna-task-transfer-production-defaults-{}",
        std::process::id()
    ));
    let cwd = home.join("plain-repo");
    std::fs::create_dir_all(&cwd).expect("plain test cwd should be created");
    let _cwd_guard = CwdGuard::set(&cwd);
    let _home_guard = EnvGuard::set("HOME", home.as_os_str());
    let _daemon_guard = EnvGuard::unset("KANNA_DAEMON_DIR");
    let _db_guard = EnvGuard::unset("KANNA_DB_PATH");
    let _cli_db_guard = EnvGuard::unset("KANNA_CLI_DB_PATH");
    let _transfer_root_guard = EnvGuard::unset("KANNA_TRANSFER_ROOT");
    let _registry_guard = EnvGuard::unset("KANNA_TRANSFER_REGISTRY_DIR");

    let config = RuntimeConfig::from_env().expect("runtime config should resolve");

    assert_eq!(
        config.daemon_dir,
        Some(kanna_runtime_defaults::daemon_dir_for_current_runtime())
    );
    assert_eq!(
        config.db_path,
        Some(
            home.join("Library")
                .join("Application Support")
                .join("build.kanna")
                .join("kanna-v2.db")
        )
    );
    assert_eq!(
        config.registry_dir,
        home.join("Library")
            .join("Application Support")
            .join("build.kanna")
            .join("transfer")
            .join("registry")
    );

    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn from_env_prefers_runtime_path_overrides() {
    let _lock = env_lock();
    let home = std::env::temp_dir().join(format!(
        "kanna-task-transfer-overrides-{}",
        std::process::id()
    ));
    let daemon_dir = home.join("custom-daemon");
    let db_path = home.join("custom.sqlite");
    let transfer_root = home.join("custom-transfer");
    let _home_guard = EnvGuard::set("HOME", home.as_os_str());
    let _daemon_guard = EnvGuard::set("KANNA_DAEMON_DIR", daemon_dir.as_os_str());
    let _db_guard = EnvGuard::set("KANNA_DB_PATH", db_path.as_os_str());
    let _cli_db_guard = EnvGuard::unset("KANNA_CLI_DB_PATH");
    let _transfer_root_guard = EnvGuard::set("KANNA_TRANSFER_ROOT", transfer_root.as_os_str());
    let _registry_guard = EnvGuard::unset("KANNA_TRANSFER_REGISTRY_DIR");

    let config = RuntimeConfig::from_env().expect("runtime config should resolve");

    assert_eq!(config.daemon_dir, Some(daemon_dir));
    assert_eq!(config.db_path, Some(db_path));
    assert_eq!(config.registry_dir, transfer_root.join("registry"));

    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_pairing_lifecycle_channel_does_not_retain_pending_admission() {
    let temp = tempfile::tempdir().expect("temp registry");
    let target = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-target", "Target", temp.path(), 0)
            .with_peer_request_timeout(std::time::Duration::from_millis(250))
            .with_runtime_admission_limits(1, 8, 2),
    )
    .await
    .expect("spawn target");
    target.incoming_events.lock().await.close();
    let requester = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-requester", "Requester", temp.path(), 0)
            .with_peer_request_timeout(std::time::Duration::from_millis(250)),
    )
    .await
    .expect("spawn requester");

    let error = requester
        .start_pairing("peer-target")
        .await
        .expect_err("closed lifecycle receiver must reject pairing");
    assert!(
        error.to_string().contains("incoming event channel closed"),
        "unexpected closed-channel error: {error}",
    );
    assert!(
        target.pending_pairing_requests.lock().await.is_empty(),
        "closed lifecycle enqueue retained pairing admission",
    );
}
