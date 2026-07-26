#![cfg(unix)]

use reqwest::Client;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::net::TcpListener;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::Duration;

const CRASH_DB_ENV: &str = "KANNA_TEST_CRASH_LEGACY_DB";
const CRASH_READY_ENV: &str = "KANNA_TEST_CRASH_LEGACY_READY";

struct TestRoot {
    temp_dir: Option<tempfile::TempDir>,
}

impl TestRoot {
    fn new() -> Self {
        let temp_dir = tempfile::Builder::new()
            .prefix("kanna-server-legacy-relocation-")
            .tempdir()
            .expect("test root should be created");
        Self {
            temp_dir: Some(temp_dir),
        }
    }

    fn path(&self) -> &Path {
        self.temp_dir
            .as_ref()
            .expect("test root should be present")
            .path()
    }

    fn cleanup(&mut self) -> std::io::Result<()> {
        let Some(temp_dir) = self.temp_dir.take() else {
            return Ok(());
        };
        temp_dir.close()
    }
}

struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn spawn(command: &mut Command, label: &str) -> Self {
        let child = command
            .spawn()
            .unwrap_or_else(|error| panic!("{label} should spawn: {error}"));
        Self { child: Some(child) }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child
            .as_mut()
            .expect("child should still be owned")
            .try_wait()
    }

    fn kill_and_reap(&mut self) -> std::io::Result<ExitStatus> {
        if let Some(status) = self
            .child
            .as_mut()
            .expect("child should still be owned")
            .try_wait()?
        {
            self.child.take();
            return Ok(status);
        }
        self.child
            .as_mut()
            .expect("child should still be owned")
            .kill()?;
        let status = self
            .child
            .as_mut()
            .expect("child should still be owned")
            .wait()?;
        self.child.take();
        Ok(status)
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.child.take();
    }
}

fn free_loopback_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback port should be available");
    listener
        .local_addr()
        .expect("loopback listener should have an address")
        .port()
}

fn app_support_root(test_root: &Path) -> (PathBuf, PathBuf) {
    let home = test_root.join("home");
    #[cfg(target_os = "macos")]
    let data_root = home.join("Library").join("Application Support");
    #[cfg(not(target_os = "macos"))]
    let data_root = test_root.join("xdg-data");
    (home, data_root)
}

fn bootstrap_legacy_database(path: &Path) {
    std::fs::create_dir_all(path.parent().expect("legacy DB should have a parent"))
        .expect("legacy DB directory should be created");
    let connection = Connection::open(path).expect("legacy DB should open");
    connection
        .execute_batch(
            r#"
            CREATE TABLE settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            "#,
        )
        .expect("legacy DB schema should be bootstrapped");
}

fn put_setting_direct(path: &Path, key: &str, value: &str) {
    let connection = Connection::open(path).expect("database should open for fixture write");
    connection
        .execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .expect("fixture setting should be written");
}

fn legacy_recovery_archive(canonical_db_path: &Path) -> PathBuf {
    let parent = canonical_db_path
        .parent()
        .expect("canonical database should have a parent");
    let file_name = canonical_db_path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("canonical database should have a filename");
    let prefix = format!("{file_name}.legacy-recovery-");
    std::fs::read_dir(parent)
        .expect("canonical directory should be readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .unwrap_or_else(|| panic!("expected a legacy recovery archive beginning {prefix}"))
}

fn sqlite_sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

#[test]
#[ignore = "spawned by the relocation integration test"]
fn crash_residual_wal_writer() {
    let (Some(db_path), Some(ready_path)) = (
        std::env::var_os(CRASH_DB_ENV),
        std::env::var_os(CRASH_READY_ENV),
    ) else {
        // This helper is also discoverable by `cargo test -- --ignored`.
        // Without its parent-provided fixture paths, it has nothing to do.
        return;
    };
    let connection = Connection::open(db_path).expect("legacy DB should open in crash writer");
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            BEGIN;
            INSERT INTO settings (key, value) VALUES ('legacySeed', 'from-legacy');
            COMMIT;
            "#,
        )
        .expect("crash writer should commit the WAL-only seed");
    std::fs::write(ready_path, b"ready").expect("crash writer should signal readiness");
    loop {
        std::thread::park();
    }
}

fn spawn_crash_residual_writer(db_path: &Path, ready_path: &Path) -> ChildGuard {
    let executable = std::env::current_exe().expect("integration test executable should resolve");
    let mut command = Command::new(executable);
    command
        .args([
            "--ignored",
            "--exact",
            "crash_residual_wal_writer",
            "--nocapture",
        ])
        .env(CRASH_DB_ENV, db_path)
        .env(CRASH_READY_ENV, ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    ChildGuard::spawn(&mut command, "crash writer")
}

async fn wait_for_crash_writer_ready(child: &mut ChildGuard, ready_path: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if ready_path.exists() {
            return;
        }
        if let Some(status) = child
            .try_wait()
            .expect("crash writer process status should be readable")
        {
            panic!("crash writer exited before becoming ready: {status}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!(
        "crash writer did not create ready marker {}",
        ready_path.display()
    );
}

fn assert_nonempty_file(path: &Path) {
    assert!(
        std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0),
        "expected non-empty crash residual {}",
        path.display()
    );
}

fn prove_seed_is_absent_from_main_file_only(legacy_db_path: &Path, copy_path: &Path) {
    std::fs::copy(legacy_db_path, copy_path).expect("legacy main-file-only copy should succeed");
    let copy = Connection::open(copy_path).expect("main-file-only copy should open");
    let settings_tables: i64 = copy
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
            [],
            |row| row.get(0),
        )
        .expect("main-file-only copy should expose the bootstrapped schema");
    assert_eq!(
        settings_tables, 1,
        "settings schema should be in the main DB"
    );
    let seed_rows: i64 = copy
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'legacySeed'",
            [],
            |row| row.get(0),
        )
        .expect("main-file-only copy should query settings");
    assert_eq!(
        seed_rows, 0,
        "legacySeed must be committed only in the residual WAL"
    );
}

fn write_server_config(
    path: &Path,
    canonical_db_path: &Path,
    daemon_dir: &Path,
    pairing_store_path: &Path,
    port: u16,
) {
    let config = format!(
        "relay_url = \"\"\n\
         device_token = \"test-device-token\"\n\
         daemon_dir = \"{}\"\n\
         db_path = \"{}\"\n\
         desktop_id = \"desktop-relocation-test\"\n\
         desktop_secret = \"desktop-secret\"\n\
         desktop_name = \"Relocation Test\"\n\
         version = \"test-version\"\n\
         environment = \"development\"\n\
         lan_host = \"127.0.0.1\"\n\
         lan_port = {port}\n\
         transfer_port = 4455\n\
         pairing_store_path = \"{}\"\n",
        daemon_dir.display(),
        canonical_db_path.display(),
        pairing_store_path.display(),
    );
    std::fs::write(path, config).expect("server config should be written");
}

async fn start_server(config_path: &Path, home: &Path, data_root: &Path, port: u16) -> ChildGuard {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-server"));
    command
        .env("KANNA_SERVER_CONFIG", config_path)
        .env("HOME", home)
        .env("XDG_DATA_HOME", data_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = ChildGuard::spawn(&mut command, "kanna-server");
    let status_url = format!("http://127.0.0.1:{port}/v1/status");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);

    while tokio::time::Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .expect("kanna-server process status should be readable")
        {
            panic!("kanna-server exited before becoming ready: {status}");
        }
        if reqwest::get(&status_url)
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return child;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("kanna-server did not become ready at {status_url}");
}

fn stop_server(child: &mut ChildGuard) {
    child
        .kill_and_reap()
        .expect("kanna-server should stop and be reaped");
}

async fn get_setting(client: &Client, port: u16, key: &str) -> Value {
    client
        .get(format!("http://127.0.0.1:{port}/v1/settings/{key}"))
        .send()
        .await
        .expect("setting request should reach kanna-server")
        .error_for_status()
        .expect("setting request should succeed")
        .json()
        .await
        .expect("setting response should be JSON")
}

async fn put_setting(client: &Client, port: u16, key: &str, value: &str) {
    let response = client
        .put(format!("http://127.0.0.1:{port}/v1/settings/{key}"))
        .json(&json!({ "value": value }))
        .send()
        .await
        .expect("setting write should reach kanna-server");
    assert!(
        response.status().is_success(),
        "setting write failed: {}",
        response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable response>".to_string())
    );
}

#[tokio::test(flavor = "current_thread")]
async fn legacy_only_database_is_relocated_before_serving_and_persists_after_restart() {
    let mut root = TestRoot::new();
    let (home, data_root) = app_support_root(root.path());
    let legacy_db_path =
        kanna_runtime_defaults::legacy_desktop_db_path_for_app_support_root(&data_root);
    let canonical_db_path =
        kanna_runtime_defaults::canonical_desktop_db_path_for_app_support_root(&data_root);
    let legacy_wal_path = sqlite_sidecar_path(&legacy_db_path, "-wal");
    let legacy_shm_path = sqlite_sidecar_path(&legacy_db_path, "-shm");
    let config_path = root.path().join("server.toml");
    let daemon_dir = root.path().join("daemon");
    let pairing_store_path = root.path().join("pairings.json");
    let ready_path = root.path().join("crash-writer.ready");
    let main_only_copy_path = root.path().join("legacy-main-only.db");
    let port = free_loopback_port();
    let client = Client::new();

    bootstrap_legacy_database(&legacy_db_path);
    let mut crash_writer = spawn_crash_residual_writer(&legacy_db_path, &ready_path);
    wait_for_crash_writer_ready(&mut crash_writer, &ready_path).await;
    let crash_status = crash_writer
        .kill_and_reap()
        .expect("crash writer should be SIGKILLed and reaped");
    assert_eq!(
        crash_status.signal(),
        Some(9),
        "crash writer should terminate via SIGKILL"
    );
    assert_nonempty_file(&legacy_wal_path);
    assert_nonempty_file(&legacy_shm_path);
    prove_seed_is_absent_from_main_file_only(&legacy_db_path, &main_only_copy_path);

    write_server_config(
        &config_path,
        &canonical_db_path,
        &daemon_dir,
        &pairing_store_path,
        port,
    );
    assert!(legacy_db_path.exists());
    assert!(!canonical_db_path.exists());

    let mut first_server = start_server(&config_path, &home, &data_root, port).await;

    assert!(
        canonical_db_path.exists(),
        "startup should relocate the legacy DB to {}",
        canonical_db_path.display()
    );
    assert!(
        !legacy_db_path.exists(),
        "startup should stop serving from {}",
        legacy_db_path.display()
    );
    assert!(
        !legacy_wal_path.exists(),
        "startup should remove checkpointed legacy WAL {}",
        legacy_wal_path.display()
    );
    assert!(
        !legacy_shm_path.exists(),
        "startup should remove checkpointed legacy SHM {}",
        legacy_shm_path.display()
    );
    assert_eq!(
        get_setting(&client, port, "legacySeed").await,
        json!({ "key": "legacySeed", "value": "from-legacy" })
    );

    put_setting(&client, port, "relocationProbe", "written-through-http").await;
    stop_server(&mut first_server);

    let mut second_server = start_server(&config_path, &home, &data_root, port).await;
    assert_eq!(
        get_setting(&client, port, "legacySeed").await,
        json!({ "key": "legacySeed", "value": "from-legacy" })
    );
    assert_eq!(
        get_setting(&client, port, "relocationProbe").await,
        json!({ "key": "relocationProbe", "value": "written-through-http" })
    );
    stop_server(&mut second_server);

    root.cleanup().expect("test root should be removed");
}

#[tokio::test(flavor = "current_thread")]
async fn canonical_database_wins_and_legacy_state_is_archived_when_both_paths_exist() {
    let mut root = TestRoot::new();
    let (home, data_root) = app_support_root(root.path());
    let legacy_db_path =
        kanna_runtime_defaults::legacy_desktop_db_path_for_app_support_root(&data_root);
    let canonical_db_path =
        kanna_runtime_defaults::canonical_desktop_db_path_for_app_support_root(&data_root);
    let config_path = root.path().join("server.toml");
    let daemon_dir = root.path().join("daemon");
    let pairing_store_path = root.path().join("pairings.json");
    let port = free_loopback_port();
    let client = Client::new();

    bootstrap_legacy_database(&legacy_db_path);
    put_setting_direct(&legacy_db_path, "legacyOnly", "must-not-win");
    bootstrap_legacy_database(&canonical_db_path);
    put_setting_direct(&canonical_db_path, "canonicalOnly", "must-win");
    write_server_config(
        &config_path,
        &canonical_db_path,
        &daemon_dir,
        &pairing_store_path,
        port,
    );

    let mut server = start_server(&config_path, &home, &data_root, port).await;
    assert_eq!(
        get_setting(&client, port, "canonicalOnly").await,
        json!({ "key": "canonicalOnly", "value": "must-win" })
    );
    let missing_legacy = client
        .get(format!("http://127.0.0.1:{port}/v1/settings/legacyOnly"))
        .send()
        .await
        .expect("legacy setting request should reach server");
    assert_eq!(missing_legacy.status(), reqwest::StatusCode::NOT_FOUND);
    stop_server(&mut server);

    assert!(
        !legacy_db_path.exists(),
        "legacy candidate must be removed after its recovery archive is written"
    );
    let archive = legacy_recovery_archive(&canonical_db_path);
    let archived_value: String = Connection::open(&archive)
        .expect("legacy recovery archive should open")
        .query_row(
            "SELECT value FROM settings WHERE key = 'legacyOnly'",
            [],
            |row| row.get(0),
        )
        .expect("legacy recovery archive should retain legacy state");
    assert_eq!(archived_value, "must-not-win");

    root.cleanup().expect("test root should be removed");
}

#[tokio::test(flavor = "current_thread")]
async fn canonical_database_wins_while_archiving_legacy_wal_only_writes() {
    let mut root = TestRoot::new();
    let (home, data_root) = app_support_root(root.path());
    let legacy_db_path =
        kanna_runtime_defaults::legacy_desktop_db_path_for_app_support_root(&data_root);
    let canonical_db_path =
        kanna_runtime_defaults::canonical_desktop_db_path_for_app_support_root(&data_root);
    let config_path = root.path().join("server.toml");
    let daemon_dir = root.path().join("daemon");
    let pairing_store_path = root.path().join("pairings.json");
    let ready_path = root.path().join("crash-writer.ready");
    let port = free_loopback_port();
    let client = Client::new();

    bootstrap_legacy_database(&legacy_db_path);
    std::fs::create_dir_all(canonical_db_path.parent().unwrap()).unwrap();
    std::fs::copy(&legacy_db_path, &canonical_db_path)
        .expect("canonical point-in-time copy should be created before the legacy WAL write");
    put_setting_direct(&canonical_db_path, "canonicalOnly", "must-win");
    let mut crash_writer = spawn_crash_residual_writer(&legacy_db_path, &ready_path);
    wait_for_crash_writer_ready(&mut crash_writer, &ready_path).await;
    assert_eq!(
        crash_writer.kill_and_reap().unwrap().signal(),
        Some(9),
        "crash writer should leave a recoverable WAL"
    );

    write_server_config(
        &config_path,
        &canonical_db_path,
        &daemon_dir,
        &pairing_store_path,
        port,
    );
    let mut server = start_server(&config_path, &home, &data_root, port).await;
    assert_eq!(
        get_setting(&client, port, "canonicalOnly").await,
        json!({ "key": "canonicalOnly", "value": "must-win" })
    );
    let missing_legacy = client
        .get(format!("http://127.0.0.1:{port}/v1/settings/legacySeed"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_legacy.status(), reqwest::StatusCode::NOT_FOUND);
    stop_server(&mut server);

    let archive = legacy_recovery_archive(&canonical_db_path);
    let archived_value: String = Connection::open(&archive)
        .unwrap()
        .query_row(
            "SELECT value FROM settings WHERE key = 'legacySeed'",
            [],
            |row| row.get(0),
        )
        .expect("checkpointed recovery archive should retain the WAL-only write");
    assert_eq!(archived_value, "from-legacy");

    root.cleanup().expect("test root should be removed");
}
