#[path = "../../tests/support/mdns_names.rs"]
mod mdns_names;

use super::state::{
    install_companion_observer_if_latest, remove_companion_observer_generation,
    remove_companion_observer_registration, runtime_event_channel, CompanionObserver,
    MAX_PENDING_ORDINARY_EVENTS,
};
use super::*;
use crate::peer_store::PeerRecord;
use crate::protocol::{PeerRequest, PeerResponse, PeerTerminalEvent};
use kanna_agent_protocol::{CompanionDocumentKind, CompanionEvent, ServerFrame};
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .expect("env lock should not be poisoned")
}

#[tokio::test]
async fn generation_2_install_wins_when_generation_1_completes_later() {
    struct ReleaseOnDrop(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    let observer_key = ("peer-owner".to_owned(), "task-1".to_owned());
    let latest_generations =
        HashMap::from([(observer_key.clone(), (2, "generation-2".to_owned()))]);
    let mut observers = HashMap::new();
    let winning_handle = tokio::spawn(std::future::pending::<()>());
    let winning = CompanionObserver {
        generation: "generation-2".into(),
        generation_order: 2,
        handle: winning_handle,
        stream_nonce: "nonce-2".into(),
        observation_challenge: "challenge-2".into(),
        next_event_sequence: Arc::new(AtomicU64::new(1)),
        send_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    let winning_install = install_companion_observer_if_latest(
        &latest_generations,
        &mut observers,
        observer_key.clone(),
        winning,
    );
    assert!(matches!(winning_install, Ok(None)));

    let (released_tx, released_rx) = tokio::sync::oneshot::channel();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let losing_handle = tokio::spawn(async move {
        let _stream_resource = ReleaseOnDrop(Some(released_tx));
        let _ = entered_tx.send(());
        std::future::pending::<()>().await;
    });
    entered_rx
        .await
        .expect("losing stream task did not retain its resources");
    let losing = CompanionObserver {
        generation: "generation-1".into(),
        generation_order: 1,
        handle: losing_handle,
        stream_nonce: "nonce-1".into(),
        observation_challenge: "challenge-1".into(),
        next_event_sequence: Arc::new(AtomicU64::new(1)),
        send_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    let stale = match install_companion_observer_if_latest(
        &latest_generations,
        &mut observers,
        observer_key.clone(),
        losing,
    ) {
        Err(stale) => stale,
        Ok(_) => panic!("generation 1 replaced generation 2"),
    };
    stale.handle.abort();
    tokio::time::timeout(Duration::from_secs(1), released_rx)
        .await
        .expect("losing stream resources were not released")
        .expect("losing stream release signal was dropped");
    assert_eq!(
        observers
            .get(&observer_key)
            .map(|observer| observer.generation.as_str()),
        Some("generation-2"),
    );

    observers.remove(&observer_key).unwrap().handle.abort();
}

#[tokio::test]
async fn lower_order_registration_cannot_remove_higher_order_installed_observer() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("registry");
    let worktree = temp.path().join("owner-worktree");
    let db_path = temp.path().join("owner.sqlite");
    std::fs::create_dir_all(worktree.join(".superpowers/brainstorm/session-1/state")).unwrap();
    std::fs::create_dir_all(worktree.join(".superpowers/brainstorm/session-1/content")).unwrap();
    std::fs::write(
        worktree.join(".superpowers/brainstorm/session-1/state/server-info"),
        b"{}",
    )
    .unwrap();
    std::fs::write(
        worktree.join(".superpowers/brainstorm/session-1/content/layout.html"),
        b"<button data-choice='a'>A</button>",
    )
    .unwrap();
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch(
        "CREATE TABLE pipeline_item (id TEXT PRIMARY KEY, branch TEXT);
         CREATE TABLE worktree (
           id TEXT PRIMARY KEY,
           pipeline_item_id TEXT,
           path TEXT,
           created_at TEXT
         );",
    )
    .unwrap();
    db.execute(
        "INSERT INTO pipeline_item (id, branch) VALUES ('task-1', 'task-1')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO worktree (id, pipeline_item_id, path, created_at)
         VALUES ('wt-1', 'task-1', ?1, '2026-07-27T00:00:00Z')",
        [worktree.to_string_lossy().as_ref()],
    )
    .unwrap();
    drop(db);

    let owner = Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-owner", "Owner", &registry, 0).with_db_path(&db_path),
        )
        .await
        .unwrap(),
    );
    let viewer = Arc::new(
        TransferRuntime::spawn(RuntimeConfig::for_tests(
            "peer-viewer",
            "Viewer",
            &registry,
            0,
        ))
        .await
        .unwrap(),
    );
    let owner_public = crate::crypto::public_key_to_string(&owner.identity.public_key);
    let viewer_public = crate::crypto::public_key_to_string(&viewer.identity.public_key);
    owner
        .upsert_trusted_peer(PeerRecord {
            peer_id: "peer-viewer".into(),
            display_name: "Viewer".into(),
            public_key: viewer_public,
            capabilities_json: "{}".into(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    viewer
        .upsert_trusted_peer(PeerRecord {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            public_key: owner_public,
            capabilities_json: "{}".into(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let gate =
        super::lifecycle::install_companion_registration_test_gate("generation-a", "generation-b");
    let viewer_for_old = Arc::clone(&viewer);
    let old = tokio::spawn(async move {
        viewer_for_old
            .observe_peer_companion("peer-owner", "task-1", "generation-a")
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), gate.wait_until_blocked())
        .await
        .expect("lower-order registration did not reach the interleaving gate");

    let viewer_for_new = Arc::clone(&viewer);
    let newer = tokio::spawn(async move {
        viewer_for_new
            .observe_peer_companion("peer-owner", "task-1", "generation-b")
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), gate.wait_until_contender_entered())
        .await
        .expect("higher-order registration did not reach the critical section");
    assert!(
        tokio::time::timeout(
            Duration::from_millis(50),
            gate.wait_until_contender_passed()
        )
        .await
        .is_err(),
        "higher-order registration crossed the lower-order critical section"
    );
    gate.release();
    tokio::time::timeout(Duration::from_secs(1), gate.wait_until_contender_passed())
        .await
        .expect("higher-order registration did not proceed after the gate released");
    newer.await.unwrap().unwrap();
    let observer_key = ("peer-owner".to_owned(), "task-1".to_owned());
    let higher_order = viewer
        .companion_observers
        .lock()
        .await
        .get(&observer_key)
        .map(|observer| observer.generation_order)
        .expect("higher-order observer should install after the old critical section");
    old.await.unwrap().unwrap();

    let observers = viewer.companion_observers.lock().await;
    let observer = observers
        .get(&observer_key)
        .expect("lower-order registration removed the installed higher-order observer");
    assert_eq!(observer.generation, "generation-b");
    assert_eq!(observer.generation_order, higher_order);
    drop(observers);
    viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-b")
        .await
        .unwrap();
}

#[tokio::test]
async fn ordinary_event_queue_is_bounded_and_resumes_after_drain() {
    let (sender, mut receiver) = runtime_event_channel();
    let terminal = |index: usize| RuntimeEvent::TerminalEvent {
        peer_id: "peer-owner".into(),
        session_id: "terminal-session".into(),
        observer_lease_id: "lease-test".into(),
        event: PeerTerminalEvent::Output {
            session_id: "terminal-session".into(),
            data: index.to_le_bytes().to_vec(),
        },
    };
    for index in 0..MAX_PENDING_ORDINARY_EVENTS {
        sender
            .send(terminal(index))
            .await
            .expect("ordinary queue should accept events up to its bound");
    }
    let blocked_sender = sender.clone();
    let blocked = tokio::spawn(async move {
        blocked_sender
            .send(terminal(MAX_PENDING_ORDINARY_EVENTS))
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !blocked.is_finished(),
        "ordinary events must apply bounded backpressure instead of accumulating"
    );

    assert!(matches!(
        receiver.recv().await,
        Some(RuntimeEvent::TerminalEvent { .. })
    ));
    blocked
        .await
        .expect("bounded send task should finish")
        .expect("ordinary delivery should resume as the pump drains");
    assert!(matches!(
        receiver.recv().await,
        Some(RuntimeEvent::TerminalEvent { .. })
    ));
    sender
        .send(terminal(MAX_PENDING_ORDINARY_EVENTS + 1))
        .await
        .expect("ordinary delivery should recover as the pump drains");
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

async fn send_raw_companion_event(
    runtime: &TransferRuntime,
    owner: &TransferRuntime,
    generation: &str,
    request_id: &str,
    event: &CompanionEvent,
) -> TcpStream {
    let observer = runtime
        .companion_observers
        .lock()
        .await
        .get(&("peer-owner".to_string(), "task-1".to_string()))
        .map(|observer| {
            (
                observer.stream_nonce.clone(),
                observer.observation_challenge.clone(),
            )
        })
        .unwrap();
    let sealed_payload = super::companion::seal_send_companion_event_proof(
        &runtime.identity,
        &owner.identity.public_key,
        request_id,
        "peer-viewer",
        "task-1",
        &event.session_id,
        &event.revision,
        generation,
        &observer.0,
        &observer.1,
        1,
        event,
    )
    .unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", owner.config.listen_port))
        .await
        .unwrap();
    super::utils::write_json_line(
        &mut stream,
        &PeerRequest::SendCompanionEvent {
            request_id: request_id.into(),
            requester_peer_id: "peer-viewer".into(),
            sealed_payload,
        },
    )
    .await
    .unwrap();
    stream
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
    // Resolved, not spelled out: the application-data root is
    // `~/Library/Application Support` on macOS and the XDG data directory on
    // Linux, and this asserts the layout below it rather than one platform's.
    assert_eq!(
        config.db_path,
        Some(kanna_runtime_defaults::canonical_desktop_db_path_for_home(
            &home
        ))
    );
    assert_eq!(
        config.registry_dir,
        kanna_runtime_defaults::default_transfer_registry_dir_for_home(&home)
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
    // Resolved, not spelled out: the application-data root is
    // `~/Library/Application Support` on macOS and the XDG data directory on
    // Linux, and this asserts the layout below it rather than one platform's.
    assert_eq!(
        config.db_path,
        Some(kanna_runtime_defaults::canonical_desktop_db_path_for_home(
            &home
        ))
    );
    assert_eq!(
        config.registry_dir,
        kanna_runtime_defaults::default_transfer_registry_dir_for_home(&home)
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
    // Enough stale artifacts that removing them is real work. With a single
    // file the cleanup could finish before `spawn_blocking(..).await` was ever
    // polled, so the await returned `Ready` without giving the executor a
    // turn and the probe below never ran — a correct implementation failing
    // for scheduling reasons, which is what made this flaky under load. A
    // cleanup that takes measurable time forces the await to pend, which is
    // the condition the probe is actually about.
    for index in 0..2_000 {
        std::fs::write(artifact_root.join(format!("stale-{index}")), b"stale")
            .expect("write stale artifact");
    }
    // One executor turn is all this needs: it stores on its first poll rather
    // than parking on `yield_now` and requiring a second. A cleanup that ran
    // inline on the runtime thread would block that single turn, which is the
    // regression under test.
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ran_in_task = ran.clone();
    tokio::spawn(async move {
        ran_in_task.store(true, std::sync::atomic::Ordering::SeqCst);
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
        ran.load(std::sync::atomic::Ordering::SeqCst),
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

/// The artifact id a real Claude session-archive transfer uses: a 64-hex
/// transfer id plus the kind suffix the desktop appends.
fn claude_session_archive_artifact_id() -> String {
    format!("{}-claude-session", "b3".repeat(32))
}

/// The path that artifact is staged from — `/tmp/kanna-transfer-<id>-claude-session.tar.gz`.
fn claude_session_archive_source_name(artifact_id: &str) -> String {
    let transfer_id = artifact_id
        .strip_suffix("-claude-session")
        .expect("fixture artifact id carries the archive suffix");
    format!("kanna-transfer-{transfer_id}-claude-session.tar.gz")
}

#[test]
fn managed_artifact_filenames_stay_inside_name_max() {
    let cases = [
        claude_session_archive_artifact_id(),
        String::new(),
        "a".repeat(4096),
        format!("{}/{}", "nested".repeat(64), "б".repeat(200)),
    ];
    for artifact_id in cases {
        let filename = utils::managed_artifact_filename(&artifact_id);
        assert!(
            filename.len() <= utils::MANAGED_ARTIFACT_FILENAME_BYTES,
            "managed name for a {}-byte artifact id exceeded its budget: {} bytes",
            artifact_id.len(),
            filename.len(),
        );
        // A receiver still on the pre-fix scheme composes
        // `<artifact-id>-<the name we staged>`; that must fit too.
        assert!(
            artifact_id.len() + 1 + filename.len() <= utils::NAME_MAX_BYTES
                || artifact_id.len() > utils::NAME_MAX_BYTES,
            "a legacy receiver's doubled name would overflow NAME_MAX",
        );
        assert!(
            !filename.contains('/')
                && !filename.contains('\\')
                && filename != ".."
                && filename != ".",
            "managed name escaped its directory: {filename}",
        );
    }
}

#[test]
fn managed_artifact_filenames_separate_ids_sharing_a_truncated_prefix() {
    // Every artifact of one transfer starts with the same 64-hex transfer id,
    // so truncation alone would collide them.
    let transfer_id = "b3".repeat(32);
    let long_tail = "-".to_owned() + &"session".repeat(40);
    let names = [
        format!("{transfer_id}-claude-session"),
        format!("{transfer_id}-claude-transcript"),
        format!("{transfer_id}{long_tail}-one"),
        format!("{transfer_id}{long_tail}-two"),
    ]
    .map(|artifact_id| utils::managed_artifact_filename(&artifact_id));

    let unique = names.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(
        unique.len(),
        names.len(),
        "artifact ids sharing a prefix collided on disk: {names:?}",
    );
}

#[test]
fn managed_artifact_filename_is_stable_for_one_artifact_id() {
    let artifact_id = claude_session_archive_artifact_id();
    assert_eq!(
        utils::managed_artifact_filename(&artifact_id),
        utils::managed_artifact_filename(&artifact_id),
        "the staged name must be reproducible from the artifact id alone",
    );
}

/// The exact composition that killed a live transfer: the pre-fix scheme spent
/// the artifact id twice, so a real Claude session archive landed past
/// `NAME_MAX` on the receiver and the fetch died with `ENAMETOOLONG`.
#[test]
fn the_pre_fix_claude_session_archive_name_overflowed_name_max() {
    let artifact_id = claude_session_archive_artifact_id();
    let source_name = claude_session_archive_source_name(&artifact_id);
    let legacy_staged = format!("{artifact_id}-{source_name}");
    let legacy_fetched = format!("{artifact_id}-{legacy_staged}");
    assert!(
        legacy_fetched.len() > utils::NAME_MAX_BYTES,
        "fixture no longer models the overflow that was observed live: {} bytes",
        legacy_fetched.len(),
    );
    assert!(
        utils::managed_artifact_filename(&artifact_id).len() <= utils::NAME_MAX_BYTES,
        "the replacement scheme still overflows NAME_MAX",
    );
}

#[tokio::test]
async fn completed_old_companion_observer_cannot_remove_reattached_generation() {
    let mut observers = HashMap::new();
    let key = ("peer-owner".to_string(), "task-1".to_string());
    let replacement = tokio::spawn(std::future::pending::<()>());
    observers.insert(
        key.clone(),
        CompanionObserver {
            generation: "generation-new".into(),
            generation_order: 2,
            handle: replacement,
            stream_nonce: "stream-new".into(),
            observation_challenge: "challenge-new".into(),
            next_event_sequence: Arc::new(AtomicU64::new(1)),
            send_lock: Arc::new(tokio::sync::Mutex::new(())),
        },
    );

    assert!(!remove_companion_observer_generation(
        &mut observers,
        &key,
        "generation-old",
        1,
    ));
    assert_eq!(
        observers
            .get(&key)
            .map(|observer| observer.generation.as_str()),
        Some("generation-new"),
    );
    observers
        .remove(&key)
        .expect("replacement observer remains")
        .handle
        .abort();
}

#[tokio::test]
async fn completed_old_companion_observer_cannot_remove_newer_order_of_same_generation() {
    let key = ("peer-owner".to_string(), "task-1".to_string());
    let replacement = tokio::spawn(std::future::pending::<()>());
    let mut observers = HashMap::from([(
        key.clone(),
        CompanionObserver {
            generation: "generation-same".into(),
            generation_order: 2,
            handle: replacement,
            stream_nonce: "stream-new".into(),
            observation_challenge: "challenge-new".into(),
            next_event_sequence: Arc::new(AtomicU64::new(1)),
            send_lock: Arc::new(tokio::sync::Mutex::new(())),
        },
    )]);

    assert!(!remove_companion_observer_generation(
        &mut observers,
        &key,
        "generation-same",
        1,
    ));
    assert_eq!(
        observers
            .get(&key)
            .map(|observer| observer.generation_order),
        Some(2)
    );
    observers.remove(&key).unwrap().handle.abort();
}

#[test]
fn old_companion_registration_cleanup_cannot_remove_a_newer_order() {
    let observer_key = ("peer-owner".to_owned(), "task-1".to_owned());
    let mut latest_generations =
        HashMap::from([(observer_key.clone(), (2, "generation-same".to_owned()))]);

    assert!(!remove_companion_observer_registration(
        &mut latest_generations,
        &observer_key,
        "generation-same",
        1,
    ));
    assert_eq!(
        latest_generations.get(&observer_key),
        Some(&(2, "generation-same".to_owned()))
    );

    let (sender, _receiver) = runtime_event_channel();
    sender.register_companion_generation("peer-owner", "task-1", "generation-same", 2);
    sender.unregister_companion_generation("peer-owner", "task-1", "generation-same", 1);
    assert_eq!(sender.companion_generation_count(), 1);
}

#[tokio::test]
async fn unobserve_cleans_matching_preinstall_state_without_removing_newer_generation() {
    let temp = tempfile::tempdir().unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let observer_key = ("peer-owner".to_owned(), "task-1".to_owned());
    viewer
        .companion_observer_generations
        .lock()
        .await
        .insert(observer_key.clone(), (2, "generation-new".to_owned()));
    viewer.incoming_sender.register_companion_generation(
        "peer-owner",
        "task-1",
        "generation-new",
        2,
    );

    viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-old")
        .await
        .unwrap();
    assert_eq!(
        viewer
            .companion_observer_generations
            .lock()
            .await
            .get(&observer_key)
            .cloned(),
        Some((2, "generation-new".to_owned()))
    );
    assert_eq!(viewer.incoming_sender.companion_generation_count(), 1);

    viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-new")
        .await
        .unwrap();
    assert!(viewer
        .companion_observer_generations
        .lock()
        .await
        .is_empty());
    assert_eq!(viewer.incoming_sender.companion_generation_count(), 0);
}

#[tokio::test]
async fn failed_companion_stream_open_and_unobserve_release_generation_state() {
    let temp = tempfile::tempdir().unwrap();
    let stalled_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let target_identity = crate::crypto::TransferIdentity::generate();
    let target_public_key = crate::crypto::public_key_to_string(&target_identity.public_key);
    crate::registry::PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&crate::registry::PeerRegistryEntry {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            endpoint: stalled_listener.local_addr().unwrap().to_string(),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    super::utils::peer_store(temp.path(), "peer-viewer")
        .unwrap()
        .upsert(PeerRecord {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            public_key: target_public_key,
            capabilities_json: "{\"protocolVersion\":2,\"companionCapabilityVersion\":1}".into(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let viewer = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-viewer", "Viewer", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(25)),
    )
    .await
    .unwrap();

    let error = viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-fails")
        .await
        .unwrap_err();
    assert!(matches!(error, RuntimeError::PeerRequestTimeout { .. }));
    viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-fails")
        .await
        .unwrap();

    assert!(viewer
        .companion_observer_generations
        .lock()
        .await
        .is_empty());
    assert_eq!(viewer.incoming_sender.companion_generation_count(), 0);
}

#[tokio::test]
async fn cancelled_companion_stream_open_rolls_back_generation_state() {
    let temp = tempfile::tempdir().unwrap();
    let stalled_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let target_identity = crate::crypto::TransferIdentity::generate();
    let target_public_key = crate::crypto::public_key_to_string(&target_identity.public_key);
    crate::registry::PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&crate::registry::PeerRegistryEntry {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            endpoint: stalled_listener.local_addr().unwrap().to_string(),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    super::utils::peer_store(temp.path(), "peer-viewer")
        .unwrap()
        .upsert(PeerRecord {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            public_key: target_public_key,
            capabilities_json: "{\"protocolVersion\":2,\"companionCapabilityVersion\":1}".into(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let viewer = Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-viewer", "Viewer", temp.path(), 0)
                .with_peer_request_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap(),
    );
    let viewer_for_observe = Arc::clone(&viewer);
    let observe = tokio::spawn(async move {
        viewer_for_observe
            .observe_peer_companion("peer-owner", "task-1", "generation-cancelled")
            .await
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while viewer.incoming_sender.companion_generation_count() == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "observe did not register before opening the stalled stream"
        );
        tokio::task::yield_now().await;
    }
    assert_eq!(viewer.incoming_sender.companion_generation_count(), 1);

    observe.abort();
    assert!(observe.await.unwrap_err().is_cancelled());

    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let local_empty = viewer
            .companion_observer_generations
            .lock()
            .await
            .is_empty();
        let sender_empty = viewer.incoming_sender.companion_generation_count() == 0;
        if local_empty && sender_empty {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "cancelled observe retained local or event-sender generation state"
        );
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn stale_same_generation_send_failure_cannot_remove_replacement_observer() {
    let temp = tempfile::tempdir().unwrap();
    let stalled_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let target_identity = crate::crypto::TransferIdentity::generate();
    let target_public_key = crate::crypto::public_key_to_string(&target_identity.public_key);
    crate::registry::PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&crate::registry::PeerRegistryEntry {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            endpoint: stalled_listener.local_addr().unwrap().to_string(),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    super::utils::peer_store(temp.path(), "peer-viewer")
        .unwrap()
        .upsert(PeerRecord {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            public_key: target_public_key,
            capabilities_json: "{\"protocolVersion\":2,\"companionCapabilityVersion\":1}".into(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let viewer = Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-viewer", "Viewer", temp.path(), 0)
                .with_peer_request_timeout(Duration::from_millis(50)),
        )
        .await
        .unwrap(),
    );
    let observer_key = ("peer-owner".to_owned(), "task-1".to_owned());
    let old_send_lock = Arc::new(tokio::sync::Mutex::new(()));
    let old_send_guard = old_send_lock.lock().await;
    viewer
        .companion_observer_generations
        .lock()
        .await
        .insert(observer_key.clone(), (1, "generation-same".to_owned()));
    viewer.incoming_sender.register_companion_generation(
        "peer-owner",
        "task-1",
        "generation-same",
        1,
    );
    viewer.companion_observers.lock().await.insert(
        observer_key.clone(),
        CompanionObserver {
            generation: "generation-same".into(),
            generation_order: 1,
            handle: tokio::spawn(std::future::pending::<()>()),
            stream_nonce: super::companion::fresh_observation_challenge(),
            observation_challenge: super::companion::fresh_observation_challenge(),
            next_event_sequence: Arc::new(AtomicU64::new(1)),
            send_lock: Arc::clone(&old_send_lock),
        },
    );
    let viewer_for_send = Arc::clone(&viewer);
    let send = tokio::spawn(async move {
        viewer_for_send
            .send_peer_companion_event(
                "peer-owner",
                "task-1",
                "session-1",
                "revision-1",
                "generation-same",
                CompanionEvent {
                    session_id: String::new(),
                    revision: String::new(),
                    event_id: "event-old".into(),
                    event_type: "click".into(),
                    choice: "a".into(),
                    text: "A".into(),
                    element_id: None,
                    timestamp: 1_784_268_000_000,
                },
            )
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while Arc::strong_count(&old_send_lock) < 3 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "send did not capture the old observer before replacement"
        );
        tokio::task::yield_now().await;
    }

    viewer
        .companion_observer_generations
        .lock()
        .await
        .insert(observer_key.clone(), (2, "generation-same".to_owned()));
    viewer.incoming_sender.register_companion_generation(
        "peer-owner",
        "task-1",
        "generation-same",
        2,
    );
    let replacement = CompanionObserver {
        generation: "generation-same".into(),
        generation_order: 2,
        handle: tokio::spawn(std::future::pending::<()>()),
        stream_nonce: super::companion::fresh_observation_challenge(),
        observation_challenge: super::companion::fresh_observation_challenge(),
        next_event_sequence: Arc::new(AtomicU64::new(1)),
        send_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    viewer
        .companion_observers
        .lock()
        .await
        .insert(observer_key.clone(), replacement)
        .unwrap()
        .handle
        .abort();
    drop(old_send_guard);

    assert!(send.await.unwrap().is_err());
    assert_eq!(
        viewer
            .companion_observers
            .lock()
            .await
            .get(&observer_key)
            .map(|observer| observer.generation_order),
        Some(2)
    );
    assert_eq!(
        viewer
            .companion_observer_generations
            .lock()
            .await
            .get(&observer_key)
            .cloned(),
        Some((2, "generation-same".to_owned()))
    );
    assert_eq!(viewer.incoming_sender.companion_generation_count(), 1);
    viewer
        .companion_observers
        .lock()
        .await
        .remove(&observer_key)
        .unwrap()
        .handle
        .abort();
}

#[tokio::test]
async fn lan_companion_event_retry_after_owner_restart_is_durably_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("registry");
    let worktree = temp.path().join("worktree");
    let db_path = temp.path().join("kanna.sqlite");
    std::fs::create_dir_all(worktree.join(".superpowers/brainstorm/session-1/state")).unwrap();
    std::fs::create_dir_all(worktree.join(".superpowers/brainstorm/session-1/content")).unwrap();
    std::fs::write(
        worktree.join(".superpowers/brainstorm/session-1/state/server-info"),
        b"{}",
    )
    .unwrap();
    std::fs::write(
        worktree.join(".superpowers/brainstorm/session-1/content/layout.html"),
        b"<button data-choice='a'>A</button>",
    )
    .unwrap();
    let document = kanna_visual_companion::current_bundle(&worktree)
        .unwrap()
        .unwrap();
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch(
        "CREATE TABLE pipeline_item (id TEXT PRIMARY KEY, branch TEXT);
         CREATE TABLE worktree (
           id TEXT PRIMARY KEY,
           pipeline_item_id TEXT,
           path TEXT,
           created_at TEXT
         );",
    )
    .unwrap();
    db.execute(
        "INSERT INTO pipeline_item (id, branch) VALUES ('task-1', 'task-1')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO worktree (id, pipeline_item_id, path, created_at)
         VALUES ('wt-1', 'task-1', ?1, '2026-07-26T00:00:00Z')",
        [worktree.to_string_lossy().as_ref()],
    )
    .unwrap();
    drop(db);

    let owner_config =
        RuntimeConfig::for_tests("peer-owner", "Owner", &registry, 0).with_db_path(&db_path);
    let viewer_config = RuntimeConfig::for_tests("peer-viewer", "Viewer", &registry, 0);
    let owner = TransferRuntime::spawn(owner_config.clone()).await.unwrap();
    let viewer = TransferRuntime::spawn(viewer_config).await.unwrap();
    let owner_public = crate::crypto::public_key_to_string(&owner.identity.public_key);
    let viewer_public = crate::crypto::public_key_to_string(&viewer.identity.public_key);
    let trusted = |peer_id: &str, display_name: &str, public_key: String| PeerRecord {
        peer_id: peer_id.into(),
        display_name: display_name.into(),
        public_key,
        capabilities_json: "{}".into(),
        paired_at: "2026-07-26T00:00:00Z".into(),
        last_seen_at: None,
        revoked_at: None,
    };
    owner
        .upsert_trusted_peer(trusted("peer-viewer", "Viewer", viewer_public))
        .unwrap();
    viewer
        .upsert_trusted_peer(trusted("peer-owner", "Owner", owner_public.clone()))
        .unwrap();
    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-1")
        .await
        .unwrap();

    let event = CompanionEvent {
        session_id: document.session_id.clone(),
        revision: document.revision.clone(),
        event_id: "lan-lost-ack".into(),
        event_type: "click".into(),
        choice: "a".into(),
        text: "Option A".into(),
        element_id: None,
        timestamp: 1_784_268_000_000,
    };
    let response_gate = super::listener::install_companion_response_test_gate("send-1");
    let first = send_raw_companion_event(&viewer, &owner, "generation-1", "send-1", &event).await;
    let events_path = worktree
        .join(".superpowers/brainstorm")
        .join(&document.session_id)
        .join("state/events");
    tokio::time::timeout(Duration::from_secs(1), response_gate.wait_until_blocked())
        .await
        .expect("owner must block after append and before response write");
    assert_eq!(
        std::fs::read_to_string(&events_path)
            .unwrap()
            .lines()
            .count(),
        1
    );
    drop(first);
    response_gate.release();
    drop(response_gate);
    drop(owner);

    let replacement = TransferRuntime::spawn(owner_config).await.unwrap();
    replacement
        .upsert_trusted_peer(trusted(
            "peer-viewer",
            "Viewer",
            crate::crypto::public_key_to_string(&viewer.identity.public_key),
        ))
        .unwrap();
    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-2")
        .await
        .unwrap();
    let retry =
        send_raw_companion_event(&viewer, &replacement, "generation-2", "send-2", &event).await;
    let mut response_line = String::new();
    BufReader::new(retry)
        .read_line(&mut response_line)
        .await
        .unwrap();
    let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
    let PeerResponse::SendCompanionEvent { sealed_payload, .. } = response else {
        panic!("expected accepted companion event response");
    };
    let (_, _, _, _, _, _, _, frame) = super::companion::open_owner_control_payload(
        &viewer.identity,
        &replacement.identity.public_key,
        &sealed_payload,
    )
    .unwrap();
    assert!(matches!(
        frame,
        Some(ServerFrame::CompanionEventResult { accepted: true, .. })
    ));
    assert_eq!(
        std::fs::read_to_string(events_path)
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[tokio::test]
async fn slow_consumer_keeps_only_latest_large_companion_bundle_without_starving_reliable_events() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    runtime
        .incoming_sender
        .send(RuntimeEvent::TerminalEvent {
            peer_id: "peer-owner".into(),
            session_id: "task-1".into(),
            observer_lease_id: "lease-test".into(),
            event: PeerTerminalEvent::Output {
                session_id: "task-1".into(),
                data: b"terminal-remains-responsive".to_vec(),
            },
        })
        .await
        .unwrap();
    runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionError {
                task_id: "task-1".into(),
                code: "connection_failed".into(),
                message: "stream closed".into(),
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionEventResult {
                task_id: "task-1".into(),
                session_id: Some("session-1".into()),
                revision: Some("revision-1".into()),
                event_id: "event-1".into(),
                accepted: true,
                code: None,
                message: None,
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    for index in 0..8 {
        runtime
            .incoming_sender
            .send(RuntimeEvent::CompanionEvent {
                peer_id: "peer-owner".into(),
                task_id: "task-1".into(),
                generation: "generation-1".into(),
                generation_order: 1,
                frame: ServerFrame::CompanionSnapshot {
                    task_id: "task-1".into(),
                    session_id: "session-1".into(),
                    revision: format!("revision-{index}"),
                    document_kind: CompanionDocumentKind::Fragment,
                    html: "x".repeat(2 * 1024 * 1024),
                    source_origin: None,
                    assets: vec![],
                    attachment_epoch: None,
                },
            })
            .await
            .unwrap();
    }

    assert_eq!(runtime.incoming_sender.pending_companion_count(), 1);
    assert!(matches!(
        runtime.next_event().await.unwrap(),
        RuntimeEvent::TerminalEvent { .. }
    ));
    assert!(matches!(
        runtime.next_event().await.unwrap(),
        RuntimeEvent::CompanionEvent {
            frame: ServerFrame::CompanionError { .. },
            ..
        }
    ));
    assert!(matches!(
        runtime.next_event().await.unwrap(),
        RuntimeEvent::CompanionEvent {
            frame: ServerFrame::CompanionEventResult { .. },
            ..
        }
    ));
    let RuntimeEvent::CompanionEvent {
        frame: ServerFrame::CompanionSnapshot { revision, .. },
        ..
    } = runtime.next_event().await.unwrap()
    else {
        panic!("expected latest coalesced companion snapshot");
    };
    assert_eq!(revision, "revision-7");

    runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionSnapshot {
                task_id: "task-1".into(),
                session_id: "session-1".into(),
                revision: "must-not-follow-failure".into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "x".repeat(2 * 1024 * 1024),
                source_origin: None,
                assets: vec![],
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionError {
                task_id: "task-1".into(),
                code: "connection_failed".into(),
                message: "stream closed".into(),
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    assert_eq!(runtime.incoming_sender.pending_companion_count(), 0);
    assert!(matches!(
        runtime.next_event().await.unwrap(),
        RuntimeEvent::CompanionEvent {
            frame: ServerFrame::CompanionError { .. },
            ..
        }
    ));

    runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-new".into(),
            generation_order: 2,
            frame: ServerFrame::CompanionUnavailable {
                task_id: "task-1".into(),
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    runtime
        .incoming_sender
        .invalidate_companion("peer-owner", "task-1", "generation-old", 1);
    assert_eq!(runtime.incoming_sender.pending_companion_count(), 1);
    runtime
        .incoming_sender
        .invalidate_companion("peer-owner", "task-1", "generation-new", 2);
    assert_eq!(runtime.incoming_sender.pending_companion_count(), 0);
}

#[tokio::test]
async fn late_old_generation_cannot_replace_the_queued_recovery_snapshot() {
    let (sender, mut receiver) = runtime_event_channel();
    sender.register_companion_generation("peer-owner", "task-1", "generation-new", 2);
    sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-new".into(),
            generation_order: 2,
            frame: ServerFrame::CompanionSnapshot {
                task_id: "task-1".into(),
                session_id: "session-new".into(),
                revision: "revision-recovery".into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "<p>fresh recovery</p>".into(),
                source_origin: None,
                assets: vec![],
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-old".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionUnavailable {
                task_id: "task-1".into(),
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();

    let RuntimeEvent::CompanionEvent {
        generation,
        generation_order,
        frame: ServerFrame::CompanionSnapshot { revision, .. },
        ..
    } = receiver.recv().await.unwrap()
    else {
        panic!("expected the fresh recovery snapshot");
    };
    assert_eq!(generation, "generation-new");
    assert_eq!(generation_order, 2);
    assert_eq!(revision, "revision-recovery");
}

#[tokio::test]
async fn stale_same_generation_error_cannot_invalidate_newer_queued_snapshot() {
    let (sender, mut receiver) = runtime_event_channel();
    sender.register_companion_generation("peer-owner", "task-1", "generation-same", 2);
    sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-same".into(),
            generation_order: 2,
            frame: ServerFrame::CompanionSnapshot {
                task_id: "task-1".into(),
                session_id: "session-new".into(),
                revision: "revision-new".into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "<p>new</p>".into(),
                source_origin: None,
                assets: vec![],
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-same".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionError {
                task_id: "task-1".into(),
                code: "connection_failed".into(),
                message: "old stream failed".into(),
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();

    assert_eq!(sender.pending_companion_count(), 1);
    let RuntimeEvent::CompanionEvent {
        generation_order,
        frame: ServerFrame::CompanionSnapshot { revision, .. },
        ..
    } = receiver.recv().await.unwrap()
    else {
        panic!("expected the newer queued snapshot");
    };
    assert_eq!(generation_order, 2);
    assert_eq!(revision, "revision-new");
}

#[tokio::test]
async fn latest_companion_lane_is_capped_by_active_observer_limit() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    for index in 0..super::state::MAX_COMPANION_OBSERVERS {
        runtime
            .incoming_sender
            .send(RuntimeEvent::CompanionEvent {
                peer_id: "peer-owner".into(),
                task_id: format!("task-{index}"),
                generation: "generation-1".into(),
                generation_order: 1,
                frame: ServerFrame::CompanionUnavailable {
                    task_id: format!("task-{index}"),
                    attachment_epoch: None,
                },
            })
            .await
            .unwrap();
    }
    assert_eq!(
        runtime.incoming_sender.pending_companion_count(),
        super::state::MAX_COMPANION_OBSERVERS,
    );
    assert!(runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "one-too-many".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionUnavailable {
                task_id: "one-too-many".into(),
                attachment_epoch: None,
            },
        })
        .await
        .is_err());
}

#[tokio::test]
async fn latest_companion_lane_gets_bounded_fairness_during_continuous_reliable_traffic() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    runtime
        .incoming_sender
        .send(RuntimeEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionUnavailable {
                task_id: "task-1".into(),
                attachment_epoch: None,
            },
        })
        .await
        .unwrap();
    for index in 0..40 {
        runtime
            .incoming_sender
            .send(RuntimeEvent::TerminalEvent {
                peer_id: "peer-owner".into(),
                session_id: "task-1".into(),
                observer_lease_id: "lease-test".into(),
                event: PeerTerminalEvent::Output {
                    session_id: "task-1".into(),
                    data: vec![index],
                },
            })
            .await
            .unwrap();
    }

    for _ in 0..32 {
        assert!(matches!(
            runtime.next_event().await.unwrap(),
            RuntimeEvent::TerminalEvent { .. }
        ));
    }
    assert!(matches!(
        runtime.next_event().await.unwrap(),
        RuntimeEvent::CompanionEvent {
            frame: ServerFrame::CompanionUnavailable { .. },
            ..
        }
    ));
    assert!(matches!(
        runtime.next_event().await.unwrap(),
        RuntimeEvent::TerminalEvent { .. }
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_mdns_test_runs_keep_their_peers_apart() {
    use super::discovery::{handle_mdns_event, MdnsState};
    use crate::discovery::{encode_txt_record, hostname_for_peer, SERVICE_TYPE};
    use mdns_sd::{ServiceEvent, ServiceInfo};

    // Feed both runs' Bonjour records through the real resolver/cache in a
    // controlled order. LAN multicast delivery and multi-NIC convergence are
    // not the invariant: routing must select the intended identity even when
    // the cache also contains the other run's peers. The integration target's
    // mdns_peers_can_discover_pair_and_transfer retains real Bonjour coverage.
    let temp = tempfile::tempdir().unwrap();
    let mut peers = Vec::new();
    let mut caches = Vec::new();
    for id in [
        "peer-primary-mdns",
        "peer-secondary-mdns",
        "peer-primary-mdns",
        "peer-secondary-mdns",
    ] {
        let cache = Arc::new(tokio::sync::Mutex::new(MdnsState::default()));
        let mut config =
            RuntimeConfig::for_tests(mdns_names::unique_mdns_peer_id(id), id, temp.path(), 0);
        config.mdns_fixture = Some(Arc::clone(&cache));
        peers.push(TransferRuntime::spawn(config).await.unwrap());
        caches.push(cache);
    }
    let services = peers
        .iter()
        .map(|peer| {
            let txt = encode_txt_record(
                &peer.config.peer_id,
                &peer.config.display_name,
                &crate::crypto::public_key_to_string(&peer.identity.public_key),
                super::utils::CURRENT_PROTOCOL_VERSION,
                true,
            )
            .unwrap();
            let properties = txt.into_iter().collect::<Vec<_>>();
            ServiceInfo::new(
                SERVICE_TYPE,
                &peer.config.peer_id,
                &hostname_for_peer(&peer.config.peer_id).unwrap(),
                "127.0.0.1",
                peer.config.listen_port,
                &properties[..],
            )
            .unwrap()
            .as_resolved_service()
        })
        .collect::<Vec<_>>();
    for (index, cache) in caches.iter().enumerate() {
        for offset in 0..services.len() {
            let service = services[(index + offset) % services.len()].clone();
            handle_mdns_event(cache, ServiceEvent::ServiceResolved(Box::new(service))).await;
        }
    }
    for peer in &peers {
        let discovered = peer.list_peers().await.unwrap();
        assert_eq!(discovered.len(), 3);
        for entry in discovered {
            let intended = peers
                .iter()
                .find(|peer| peer.config.peer_id == entry.peer_id)
                .unwrap();
            assert_eq!(entry.endpoint, intended.config.endpoint());
        }
    }

    async fn exchange(source: &TransferRuntime, target: &TransferRuntime, task: &str) -> String {
        let pair = source.start_pairing(&target.config.peer_id);
        let accept = async {
            loop {
                if let RuntimeEvent::PairingRequested(request) = target.next_event().await.unwrap()
                {
                    assert_eq!(request.peer_id, source.config.peer_id);
                    target
                        .accept_pairing(&request.request_id, &request.verification_code)
                        .await
                        .unwrap();
                    break;
                }
            }
        };
        let (paired, ()) = tokio::join!(pair, accept);
        assert_eq!(paired.unwrap().peer.peer_id, target.config.peer_id);
        let preflight = source
            .prepare_transfer_preflight(&target.config.peer_id, task)
            .await
            .unwrap();
        assert_eq!(preflight.source_peer_id, source.config.peer_id);
        source
            .prepare_transfer_commit(
                &preflight.transfer_id,
                serde_json::json!({
                    "target_peer_id": target.config.peer_id,
                    "task": { "source_task_id": task }
                }),
            )
            .await
            .unwrap();
        loop {
            if let RuntimeEvent::IncomingTransferRequest(event) = target.next_event().await.unwrap()
            {
                assert_eq!(event.source_peer_id, source.config.peer_id);
                return event.source_task_id;
            }
        }
    }
    // A missing event is a broken fixture; only this outer guard uses time.
    let (first, second) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            exchange(&peers[0], &peers[1], "task-source-a"),
            exchange(&peers[2], &peers[3], "task-source-b")
        )
    })
    .await
    .expect("concurrent exchanges did not complete");
    assert_eq!(first, "task-source-a");
    assert_eq!(second, "task-source-b");
}
