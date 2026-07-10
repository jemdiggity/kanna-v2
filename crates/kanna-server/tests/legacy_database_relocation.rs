#![cfg(unix)]

use reqwest::Client;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};

fn unique_test_root() -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "kanna-server-legacy-relocation-{}-{suffix}",
        std::process::id()
    ))
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

fn seed_legacy_database(path: &Path) {
    std::fs::create_dir_all(path.parent().expect("legacy DB should have a parent"))
        .expect("legacy DB directory should be created");
    let connection = Connection::open(path).expect("legacy DB should open");
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            INSERT INTO settings (key, value) VALUES ('legacySeed', 'from-legacy');
            "#,
        )
        .expect("legacy DB should be seeded");
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
         server_version = \"test-version\"\n\
         lan_host = \"127.0.0.1\"\n\
         lan_port = {port}\n\
         pairing_store_path = \"{}\"\n",
        daemon_dir.display(),
        canonical_db_path.display(),
        pairing_store_path.display(),
    );
    std::fs::write(path, config).expect("server config should be written");
}

async fn start_server(config_path: &Path, home: &Path, data_root: &Path, port: u16) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kanna-server"));
    command
        .env("KANNA_SERVER_CONFIG", config_path)
        .env("HOME", home)
        .env("XDG_DATA_HOME", data_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().expect("kanna-server should spawn");
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

async fn stop_server(child: &mut Child) {
    child.kill().await.expect("kanna-server should stop");
    child.wait().await.expect("kanna-server should be reaped");
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

#[tokio::test(flavor = "current_thread")]
async fn legacy_only_database_is_relocated_before_serving_and_persists_after_restart() {
    let root = unique_test_root();
    let (home, data_root) = app_support_root(&root);
    let legacy_db_path =
        kanna_runtime_defaults::legacy_desktop_db_path_for_app_support_root(&data_root);
    let canonical_db_path =
        kanna_runtime_defaults::canonical_desktop_db_path_for_app_support_root(&data_root);
    let config_path = root.join("server.toml");
    let daemon_dir = root.join("daemon");
    let pairing_store_path = root.join("pairings.json");
    let port = free_loopback_port();
    let client = Client::new();

    seed_legacy_database(&legacy_db_path);
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
    assert_eq!(
        get_setting(&client, port, "legacySeed").await,
        json!({ "key": "legacySeed", "value": "from-legacy" })
    );

    let write_response = client
        .put(format!(
            "http://127.0.0.1:{port}/v1/settings/relocationProbe"
        ))
        .json(&json!({ "value": "written-through-http" }))
        .send()
        .await
        .expect("setting write should reach kanna-server");
    assert!(
        write_response.status().is_success(),
        "setting write failed: {}",
        write_response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable response>".to_string())
    );
    stop_server(&mut first_server).await;

    let canonical = Connection::open(&canonical_db_path).expect("canonical DB should open");
    let persisted_value: String = canonical
        .query_row(
            "SELECT value FROM settings WHERE key = 'relocationProbe'",
            [],
            |row| row.get(0),
        )
        .expect("HTTP write should be stored in canonical DB");
    assert_eq!(persisted_value, "written-through-http");
    drop(canonical);

    let mut second_server = start_server(&config_path, &home, &data_root, port).await;
    assert_eq!(
        get_setting(&client, port, "relocationProbe").await,
        json!({ "key": "relocationProbe", "value": "written-through-http" })
    );
    stop_server(&mut second_server).await;

    std::fs::remove_dir_all(root).expect("test root should be removed");
}
