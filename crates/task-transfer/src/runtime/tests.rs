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

#[tokio::test]
async fn peer_artifact_root_cleanup_is_isolated_for_dot_and_its_encoded_name() {
    let temp = tempfile::tempdir().expect("temp registry");
    let dot_root = utils::managed_artifact_root(temp.path(), ".");
    let encoded_name_root = utils::managed_artifact_root(temp.path(), "Lg");
    assert_ne!(
        dot_root, encoded_name_root,
        "every valid peer id must have a distinct managed artifact root",
    );

    let dot_runtime =
        TransferRuntime::spawn(RuntimeConfig::for_tests(".", "Dot Peer", temp.path(), 0))
            .await
            .expect("spawn dot peer");
    std::fs::create_dir_all(&dot_root).expect("create dot peer artifact root");
    let sentinel = dot_root.join("owned-by-dot");
    std::fs::write(&sentinel, b"artifact").expect("write dot peer artifact");

    let encoded_name_runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "Lg",
        "Encoded Name Peer",
        temp.path(),
        0,
    ))
    .await
    .expect("spawn encoded-name peer");
    assert!(
        sentinel.exists(),
        "starting another valid peer removed the dot peer's artifacts",
    );

    drop(encoded_name_runtime);
    assert!(
        sentinel.exists(),
        "dropping another valid peer removed the dot peer's artifacts",
    );
    drop(dot_runtime);
    assert!(
        !dot_root.exists(),
        "dropping the owning peer retained its managed artifacts",
    );
}

#[tokio::test]
async fn raw_legacy_root_that_casefolds_to_an_encoded_peer_root_is_never_recursively_cleaned() {
    let temp = tempfile::tempdir().expect("temp registry");
    let legacy_root = temp.path().join("artifacts").join("lg");
    let encoded_peer_root = utils::managed_artifact_root(temp.path(), ".");
    assert_eq!(
        encoded_peer_root
            .file_name()
            .and_then(std::ffi::OsStr::to_str),
        Some("Lg"),
    );

    let encoded_peer_runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        ".",
        "Encoded Peer",
        temp.path(),
        0,
    ))
    .await
    .expect("spawn encoded peer");
    std::fs::create_dir_all(&encoded_peer_root).expect("create encoded peer root");
    let sentinel = encoded_peer_root.join("owned-by-encoded-peer");
    std::fs::write(&sentinel, b"encoded").expect("write encoded peer sentinel");

    let upgraded_runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "lg",
        "Upgraded Peer",
        temp.path(),
        0,
    ))
    .await
    .expect("spawn upgraded peer");
    assert!(
        sentinel.exists(),
        "startup recursively deleted another peer's encoded root through its raw case-fold alias",
    );

    drop(upgraded_runtime);
    assert!(
        sentinel.exists(),
        "Drop recursively deleted another peer's encoded root through its raw case-fold alias",
    );
    drop(encoded_peer_runtime);
    assert!(!encoded_peer_root.exists(), "owning peer retained its root");
    assert!(
        legacy_root
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("Lg")),
        "fixture must model the raw/encoded case-fold alias",
    );
}

#[cfg(unix)]
#[tokio::test]
async fn startup_refuses_artifact_cleanup_through_a_symlinked_ancestor() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp registry");
    let external = tempfile::tempdir().expect("external artifacts");
    let external_peer_root = utils::managed_artifact_root(external.path(), "peer-symlink");
    std::fs::create_dir_all(&external_peer_root).expect("create external peer root");
    let sentinel = external_peer_root.join("must-survive-startup");
    std::fs::write(&sentinel, b"external").expect("write external sentinel");
    symlink(
        external.path().join("artifacts"),
        temp.path().join("artifacts"),
    )
    .expect("symlink artifacts ancestor");

    let result = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-symlink",
        "Symlink Peer",
        temp.path(),
        0,
    ))
    .await;

    assert!(
        result.is_err(),
        "startup accepted a symlinked artifacts ancestor"
    );
    assert!(
        sentinel.exists(),
        "startup deleted data outside the registry"
    );
}

#[cfg(unix)]
#[test]
fn managed_artifact_cleanup_handles_trees_deeper_than_the_process_fd_limit() {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let temp = tempfile::tempdir().expect("temp registry");
    let peer_id = "peer-deep-cleanup";
    let artifact_root = utils::managed_artifact_root(temp.path(), peer_id);
    std::fs::create_dir_all(&artifact_root).expect("create artifact root");
    let root = CString::new(artifact_root.as_os_str().as_bytes()).expect("artifact root path");
    let descriptor = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    assert!(descriptor >= 0, "open artifact root");
    let mut current = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let child = CString::new("nested").expect("child name");
    for depth in 0..512 {
        let created = unsafe { libc::mkdirat(current.as_raw_fd(), child.as_ptr(), 0o700) };
        assert_eq!(
            created,
            0,
            "create descriptor-relative directory at depth {depth}: {}",
            std::io::Error::last_os_error(),
        );
        let next = unsafe {
            libc::openat(
                current.as_raw_fd(),
                child.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        assert!(
            next >= 0,
            "open descriptor-relative directory at depth {depth}: {}",
            std::io::Error::last_os_error(),
        );
        current = unsafe { OwnedFd::from_raw_fd(next) };
    }
    drop(current);

    utils::reset_managed_artifact_cleanup_directory_opens();
    utils::remove_managed_artifact_root(temp.path(), peer_id)
        .expect("cleanup should not retain one descriptor per depth");
    let directory_opens = utils::managed_artifact_cleanup_directory_opens();
    assert!(!artifact_root.exists());
    assert!(
        directory_opens <= 4 * 512 + 16,
        "depth-512 cleanup reopened directory prefixes quadratically: {directory_opens} opens",
    );
}

#[cfg(unix)]
#[test]
fn managed_artifact_cleanup_skips_lift_name_collisions_without_following_symlinks() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp registry");
    let external = tempfile::tempdir().expect("external target");
    let peer_id = "peer-lift-collisions";
    let artifact_root = utils::managed_artifact_root(temp.path(), peer_id);
    let nested = artifact_root.join("00-nested").join("child");
    std::fs::create_dir_all(nested.join("grandchild")).expect("create nested tree");

    let lifted_name =
        |index| artifact_root.join(format!(".kanna-cleanup-{}-{index}", std::process::id(),));
    std::fs::write(lifted_name(1), b"collision").expect("create file collision");
    let external_sentinel = external.path().join("must-survive");
    std::fs::write(&external_sentinel, b"external").expect("create external sentinel");
    symlink(&external_sentinel, lifted_name(2)).expect("create symlink collision");
    std::fs::create_dir_all(lifted_name(3).join("occupied")).expect("create directory collision");

    utils::remove_managed_artifact_root(temp.path(), peer_id)
        .expect("all lifted-name entry types should be treated as collisions");

    assert!(!artifact_root.exists());
    assert!(
        external_sentinel.exists(),
        "cleanup followed a colliding symlink outside the managed root",
    );
}

#[tokio::test(flavor = "current_thread")]
async fn startup_artifact_cleanup_yields_the_async_runtime_worker() {
    let temp = tempfile::tempdir().expect("temp registry");
    let peer_id = "peer-startup-cleanup-worker";
    let artifact_root = utils::managed_artifact_root(temp.path(), peer_id);
    std::fs::create_dir_all(&artifact_root).expect("create artifact root");
    std::fs::write(artifact_root.join("stale"), b"stale").expect("write stale artifact");
    let yielded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let yielded_in_task = yielded.clone();
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        yielded_in_task.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        peer_id,
        "Cleanup Worker Peer",
        temp.path(),
        0,
    ))
    .await
    .expect("spawn peer");

    assert!(
        yielded.load(std::sync::atomic::Ordering::SeqCst),
        "startup cleanup blocked the async runtime worker",
    );
    drop(runtime);
}

#[cfg(unix)]
#[tokio::test]
async fn drop_does_not_follow_an_artifacts_ancestor_replaced_with_a_symlink() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp registry");
    let external = tempfile::tempdir().expect("external artifacts");
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-drop-symlink",
        "Drop Symlink Peer",
        temp.path(),
        0,
    ))
    .await
    .expect("spawn peer");
    let artifacts = temp.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).expect("create managed artifacts ancestor");
    std::fs::rename(&artifacts, temp.path().join("artifacts-before-symlink"))
        .expect("move managed artifacts ancestor");

    let external_peer_root = utils::managed_artifact_root(external.path(), "peer-drop-symlink");
    std::fs::create_dir_all(&external_peer_root).expect("create external peer root");
    let sentinel = external_peer_root.join("must-survive-drop");
    std::fs::write(&sentinel, b"external").expect("write external sentinel");
    symlink(external.path().join("artifacts"), &artifacts).expect("replace artifacts with symlink");

    drop(runtime);

    assert!(sentinel.exists(), "Drop deleted data outside the registry");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_artifact_sender_and_receiver_share_one_memory_admission() {
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
    let first_permits = std::sync::Arc::clone(&permits);
    let (first_reader, mut first_writer) = tokio::io::duplex(16);
    let sender = tokio::spawn(async move {
        listener::read_bounded_legacy_artifact(first_reader, 4, 4, first_permits).await
    });

    while permits.available_permits() != 0 {
        tokio::task::yield_now().await;
    }

    let receive_error =
        super::try_acquire_legacy_artifact_memory(std::sync::Arc::clone(&permits), "receive")
            .expect_err("legacy receive overlapped legacy response serialization");
    assert!(matches!(receive_error, RuntimeError::Backpressure(_)));

    use tokio::io::AsyncWriteExt as _;
    first_writer.write_all(b"data").await.unwrap();
    drop(first_writer);
    let materialization = sender.await.unwrap().unwrap();
    drop(materialization);

    let receiver =
        super::try_acquire_legacy_artifact_memory(std::sync::Arc::clone(&permits), "receive")
            .expect("legacy receive should acquire the shared budget after serialization");
    let send_error = listener::read_bounded_legacy_artifact(
        std::io::Cursor::new(b"data".to_vec()),
        4,
        4,
        permits,
    )
    .await
    .expect_err("legacy serialization overlapped legacy receive");
    assert!(matches!(send_error, RuntimeError::Backpressure(_)));
    drop(receiver);
}

#[test]
fn legacy_artifact_allocation_boundary_uses_retained_capacity() {
    let response_line = String::with_capacity(4 * 1024);
    let unescaped_envelope = String::with_capacity(2 * 1024);
    let ciphertext = Vec::<u8>::with_capacity(1024);
    assert_eq!(response_line.len(), 0);
    assert_eq!(unescaped_envelope.len(), 0);
    assert_eq!(ciphertext.len(), 0);

    let capacities = [
        response_line.capacity(),
        unescaped_envelope.capacity(),
        ciphertext.capacity(),
    ];
    let exact_budget = capacities.iter().sum();
    super::ensure_legacy_artifact_allocation_capacity(&capacities, exact_budget)
        .expect("the exact retained-capacity boundary must be admitted");
    let error = super::ensure_legacy_artifact_allocation_capacity(&capacities, exact_budget - 1)
        .expect_err("one retained byte above budget must be rejected");
    assert!(
        error.to_string().contains("memory budget"),
        "unexpected retained-capacity error: {error}",
    );
}

#[tokio::test]
async fn legacy_artifact_line_growth_retains_no_capacity_above_its_wire_cap() {
    let maximum = 32 * 1024;
    let mut wire = vec![b'x'; maximum - 1];
    wire.push(b'\n');
    let mut reader = tokio::io::BufReader::new(std::io::Cursor::new(wire));

    let line = peer::read_bounded_artifact_response_line(&mut reader, maximum)
        .await
        .expect("the exact wire boundary must remain readable");
    assert_eq!(line.len(), maximum);
    assert!(
        line.capacity() <= maximum,
        "bounded line growth retained {} bytes for a {maximum}-byte wire cap",
        line.capacity(),
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
fn legacy_artifact_limit_preserves_the_protocol_v2_contract() {
    assert_eq!(
        super::MAX_LEGACY_TRANSFER_ARTIFACT_BYTES,
        super::MAX_TRANSFER_ARTIFACT_BYTES,
        "peers without an additive size capability retain the deployed 128 MiB contract",
    );
}

#[test]
fn legacy_artifact_receiver_checks_the_128_mib_boundary_before_decode() {
    fn unpadded_base64_len(decoded_size: u64) -> u64 {
        let complete_triples = decoded_size / 3;
        complete_triples * 4
            + match decoded_size % 3 {
                0 => 0,
                1 => 2,
                2 => 3,
                _ => unreachable!(),
            }
    }

    let maximum = super::MAX_TRANSFER_ARTIFACT_BYTES;
    peer::ensure_legacy_artifact_payload_length(unpadded_base64_len(maximum), maximum)
        .expect("the deployed protocol-v2 maximum must remain receivable");
    let error =
        peer::ensure_legacy_artifact_payload_length(unpadded_base64_len(maximum + 1), maximum)
            .expect_err("the first byte above the protocol-v2 maximum must be rejected");
    assert!(
        error.to_string().contains("exceeds maximum size"),
        "unexpected receiver boundary error: {error}",
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
    assert_eq!(
        super::MAX_LEGACY_ARTIFACT_PAYLOAD_B64_BYTES,
        178_956_971,
        "the wire cap must begin with the exact unpadded encoding of 128 MiB",
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
