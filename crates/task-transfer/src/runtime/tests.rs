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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_artifact_materialization_admits_only_one_reader() {
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
    let first_permits = std::sync::Arc::clone(&permits);
    let (first_reader, mut first_writer) = tokio::io::duplex(16);
    let first = tokio::spawn(async move {
        listener::read_bounded_legacy_artifact(first_reader, 4, 4, first_permits).await
    });

    while permits.available_permits() != 0 {
        tokio::task::yield_now().await;
    }

    let error = listener::read_bounded_legacy_artifact(
        std::io::Cursor::new(b"next".to_vec()),
        4,
        4,
        std::sync::Arc::clone(&permits),
    )
    .await
    .expect_err("a concurrent legacy materialization must be rejected");
    assert!(
        matches!(error, RuntimeError::Backpressure(_)),
        "unexpected admission error: {error}",
    );

    use tokio::io::AsyncWriteExt as _;
    first_writer.write_all(b"data").await.unwrap();
    drop(first_writer);
    let materialization = first.await.unwrap().unwrap();
    assert_eq!(materialization.payload, b"data");
    assert_eq!(
        permits.available_permits(),
        0,
        "admission was released before response serialization could finish",
    );
    let error = listener::read_bounded_legacy_artifact(
        std::io::Cursor::new(b"later".to_vec()),
        5,
        5,
        std::sync::Arc::clone(&permits),
    )
    .await
    .expect_err("materialized response must retain admission until it is dropped");
    assert!(matches!(error, RuntimeError::Backpressure(_)));
    drop(materialization);
    assert_eq!(
        listener::read_bounded_legacy_artifact(
            std::io::Cursor::new(b"later".to_vec()),
            5,
            5,
            permits,
        )
        .await
        .unwrap()
        .payload,
        b"later",
    );
}

#[tokio::test]
async fn legacy_artifact_materialization_checks_bytes_read_after_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("growing.bundle");
    std::fs::write(&path, b"grew").unwrap();
    let observed_size = std::fs::metadata(&path).unwrap().len();
    use std::io::Write as _;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"!")
        .unwrap();
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
    let error = listener::read_bounded_legacy_artifact(
        tokio::fs::File::open(path).await.unwrap(),
        observed_size,
        4,
        permits,
    )
    .await
    .expect_err("artifact growth after metadata must exceed the read limit");

    assert!(
        error.to_string().contains("maximum size of 4 bytes"),
        "unexpected growth error: {error}",
    );
}

#[test]
fn legacy_artifact_payload_size_is_rejected_before_decode() {
    use base64::Engine as _;

    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"five!".as_slice());
    let error = peer::ensure_legacy_artifact_payload_size(&encoded, 4)
        .expect_err("encoded plaintext above the legacy limit must be rejected");

    assert!(
        error.to_string().contains("maximum size of 4 bytes"),
        "unexpected pre-decode size rejection: {error}",
    );
}

#[test]
fn legacy_artifact_response_line_has_a_hard_memory_derived_cap() {
    assert_eq!(
        peer::artifact_response_line_limit(
            utils::ArtifactFraming::LegacySealedV1,
            usize::MAX,
            usize::MAX,
        ),
        super::MAX_LEGACY_ARTIFACT_RESPONSE_BYTES,
    );
    assert!(
        super::MAX_LEGACY_ARTIFACT_RESPONSE_BYTES
            < super::LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES as usize,
        "legacy line alone exhausted the total response memory budget",
    );
}

#[tokio::test]
async fn guarded_artifact_part_cleans_timeout_before_retry_commit() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("artifact.bundle");
    std::fs::write(&destination, b"original").unwrap();

    let mut first = peer::GuardedArtifactPart::create(temp.path())
        .await
        .unwrap();
    let first_path = first.path().to_path_buf();
    first.write_all(b"incomplete").await.unwrap();
    let timed_out_destination = destination.clone();
    let timed_out = tokio::time::timeout(std::time::Duration::from_millis(5), async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        first.commit(&timed_out_destination).await
    })
    .await;
    assert!(timed_out.is_err(), "guarded write unexpectedly completed");
    assert!(!first_path.exists(), "timed-out partial file survived");
    assert_eq!(std::fs::read(&destination).unwrap(), b"original");

    let mut retry = peer::GuardedArtifactPart::create(temp.path())
        .await
        .unwrap();
    retry.write_all(b"replacement").await.unwrap();
    retry.commit(&destination).await.unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"replacement");
    assert_eq!(
        std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .count(),
        0,
    );
}

#[tokio::test]
async fn guarded_artifact_part_cleans_failed_atomic_rename() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("artifact.bundle");
    std::fs::create_dir(&destination).unwrap();

    let mut part = peer::GuardedArtifactPart::create(temp.path())
        .await
        .unwrap();
    let part_path = part.path().to_path_buf();
    part.write_all(b"complete").await.unwrap();
    part.commit(&destination)
        .await
        .expect_err("renaming over a directory must fail");

    assert!(!part_path.exists(), "failed rename retained partial file");
    assert!(destination.is_dir(), "failed rename damaged destination");
}
