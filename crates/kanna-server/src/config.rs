use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub relay_url: String,
    pub device_token: String,
    pub firebase_project_id: String,
    pub firebase_auth_emulator_url: Option<String>,
    #[allow(dead_code)]
    pub firebase_firestore_emulator_host: Option<String>,
    pub daemon_dir: String,
    pub db_path: String,
    pub kanna_cli_path: Option<String>,
    pub desktop_id: String,
    pub desktop_secret: Option<String>,
    pub desktop_name: String,
    pub version: String,
    pub environment: String,
    pub lan_host: String,
    pub lan_port: u16,
    /// The port the transfer sidecar listens on. Derived by the desktop, and
    /// the single owner of that derivation: the server hands it to the sidecar
    /// it spawns and dials the same port from the inbound tunnel bridge.
    pub transfer_port: u16,
    pub pairing_store_path: String,
    /// Seconds an activity value must hold before its transition reaches the
    /// event feed. Display state remains immediate; manager notifications are
    /// settled server-side and provider-neutral.
    pub activity_event_debounce_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    relay_url: String,
    device_token: String,
    firebase_project_id: Option<String>,
    firebase_auth_emulator_url: Option<String>,
    firebase_firestore_emulator_host: Option<String>,
    daemon_dir: Option<String>,
    db_path: Option<String>,
    kanna_cli_path: Option<String>,
    desktop_id: Option<String>,
    desktop_secret: Option<String>,
    desktop_name: Option<String>,
    version: String,
    environment: String,
    lan_host: Option<String>,
    lan_port: Option<u16>,
    transfer_port: Option<u16>,
    pairing_store_path: Option<String>,
    activity_event_debounce_seconds: Option<u64>,
}

fn default_daemon_dir_for_root(data_root: &Path) -> String {
    kanna_runtime_defaults::default_daemon_dir_for_app_support_root(data_root)
        .to_string_lossy()
        .to_string()
}

fn default_desktop_id() -> String {
    "desktop-default".to_string()
}

fn default_desktop_name() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "Kanna Desktop".to_string())
}

fn default_lan_host() -> String {
    "0.0.0.0".to_string()
}

fn default_lan_port() -> u16 {
    48_120
}

fn default_firebase_project_id() -> String {
    "kanna-local".to_string()
}

fn default_pairing_store_path_for_root(data_root: &Path) -> String {
    data_root
        .join("Kanna")
        .join("mobile-pairings.json")
        .to_string_lossy()
        .to_string()
}

fn app_data_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn canonical_db_path() -> PathBuf {
    canonical_db_path_for_root(&app_data_dir())
}

fn canonical_db_path_for_root(data_root: &Path) -> PathBuf {
    kanna_runtime_defaults::canonical_desktop_db_path_for_app_support_root(data_root)
}

fn legacy_db_path_for_root(data_root: &Path) -> PathBuf {
    kanna_runtime_defaults::legacy_desktop_db_path_for_app_support_root(data_root)
}

fn normalize_db_path_with_candidates(configured: &Path, canonical: &Path, legacy: &Path) -> String {
    if configured == canonical || configured == legacy {
        return canonical.to_string_lossy().to_string();
    }

    configured.to_string_lossy().to_string()
}

pub(crate) fn legacy_database_relocation_paths(db_path: &str) -> Option<(PathBuf, PathBuf)> {
    let canonical = PathBuf::from(db_path);
    let data_root = canonical.parent()?.parent()?;
    let canonical_dir = data_root.join("build.kanna");
    if canonical.parent()? != canonical_dir {
        return None;
    }

    let database_name = canonical.file_name()?;
    Some((
        data_root.join("com.kanna.app").join(database_name),
        canonical,
    ))
}

fn load_from_path(
    config_path: &Path,
    data_root: &Path,
) -> Result<Config, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(config_path).map_err(|e| {
        format!(
            "Failed to read {}: {}. Run 'kanna-server register' first.",
            config_path.display(),
            e
        )
    })?;
    let raw: RawConfig = toml::from_str(&content)?;
    let version = raw.version.trim().to_string();
    if version.is_empty() {
        return Err("version must not be empty".into());
    }
    if !matches!(
        raw.environment.as_str(),
        "development" | "staging" | "production"
    ) {
        return Err("environment must be one of development, staging, or production".into());
    }
    let canonical = canonical_db_path_for_root(data_root);
    let legacy = legacy_db_path_for_root(data_root);
    let db_path = match raw.db_path {
        Some(path) => normalize_db_path_with_candidates(Path::new(&path), &canonical, &legacy),
        None => canonical.to_string_lossy().to_string(),
    };
    let transfer_port = raw.transfer_port.ok_or("missing field `transfer_port`")?;
    if transfer_port == 0 {
        return Err("transfer_port must be greater than zero".into());
    }

    Ok(Config {
        relay_url: raw.relay_url,
        device_token: raw.device_token,
        firebase_project_id: raw
            .firebase_project_id
            .unwrap_or_else(default_firebase_project_id),
        firebase_auth_emulator_url: raw.firebase_auth_emulator_url,
        firebase_firestore_emulator_host: raw.firebase_firestore_emulator_host,
        daemon_dir: raw
            .daemon_dir
            .unwrap_or_else(|| default_daemon_dir_for_root(data_root)),
        db_path,
        kanna_cli_path: raw.kanna_cli_path,
        desktop_id: raw.desktop_id.unwrap_or_else(default_desktop_id),
        desktop_secret: raw.desktop_secret,
        desktop_name: raw.desktop_name.unwrap_or_else(default_desktop_name),
        version,
        environment: raw.environment,
        lan_host: raw.lan_host.unwrap_or_else(default_lan_host),
        lan_port: raw.lan_port.unwrap_or_else(default_lan_port),
        transfer_port,
        pairing_store_path: raw
            .pairing_store_path
            .unwrap_or_else(|| default_pairing_store_path_for_root(data_root)),
        activity_event_debounce_seconds: raw.activity_event_debounce_seconds.unwrap_or(20),
    })
}

impl Config {
    pub(crate) fn task_events_token_path(&self) -> Option<PathBuf> {
        if self.pairing_store_path.is_empty() {
            return None;
        }
        Some(
            Path::new(&self.pairing_store_path)
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("task-events.token"),
        )
    }

    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let data_root = app_data_dir();
        let config_path = match std::env::var("KANNA_SERVER_CONFIG") {
            Ok(p) => PathBuf::from(p),
            Err(_) => data_root.join("Kanna").join("server.toml"),
        };
        load_from_path(&config_path, &data_root)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_db_path_for_root, legacy_database_relocation_paths, load_from_path,
        normalize_db_path_with_candidates,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kanna-server-config-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_from_path_uses_test_root_defaults_and_prefers_canonical_db_path() {
        let root = unique_test_dir("load");
        let legacy_dir = root.join("com.kanna.app");
        let canonical_dir = root.join("build.kanna");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::create_dir_all(&canonical_dir).unwrap();
        fs::write(legacy_dir.join("kanna-v2.db"), b"").unwrap();
        fs::write(canonical_dir.join("kanna-v2.db"), b"").unwrap();

        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            format!(
                "relay_url = \"wss://relay.example\"\n\
                 device_token = \"device-token\"\n\
                 version = \"0.0.69-staging.1\"\n\
                 environment = \"staging\"\n\
                 transfer_port = 4455\n\
                 activity_event_debounce_seconds = 17\n\
                 db_path = \"{}\"\n\
                 desktop_id = \"desktop-1\"\n\
                 desktop_name = \"Studio Mac\"\n",
                legacy_dir.join("kanna-v2.db").display()
            ),
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(
            config.db_path,
            canonical_dir.join("kanna-v2.db").display().to_string()
        );
        assert_eq!(config.lan_host, "0.0.0.0");
        assert_eq!(config.lan_port, 48_120);
        assert_eq!(config.version, "0.0.69-staging.1");
        assert_eq!(config.environment, "staging");
        assert_eq!(config.activity_event_debounce_seconds, 17);
        assert_eq!(
            config.pairing_store_path,
            root.join("Kanna")
                .join("mobile-pairings.json")
                .display()
                .to_string()
        );
    }

    #[test]
    fn load_from_path_requires_build_metadata() {
        let root = unique_test_dir("missing-build-metadata");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"wss://relay.example\"\n\
             device_token = \"device-token\"\n",
        )
        .unwrap();

        let error = load_from_path(&config_path, &root).unwrap_err();

        assert!(error.to_string().contains("missing field"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_from_path_rejects_empty_version_after_trimming() {
        let root = unique_test_dir("empty-version");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"wss://relay.example\"\n\
             device_token = \"device-token\"\n\
             version = \"   \"\n\
             environment = \"development\"\n",
        )
        .unwrap();

        let error = load_from_path(&config_path, &root).unwrap_err();

        assert_eq!(error.to_string(), "version must not be empty");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_from_path_rejects_environment_outside_canonical_domain() {
        let root = unique_test_dir("invalid-environment");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"wss://relay.example\"\n\
             device_token = \"device-token\"\n\
             version = \"0.0.69\"\n\
             environment = \"prod\"\n",
        )
        .unwrap();

        let error = load_from_path(&config_path, &root).unwrap_err();

        assert_eq!(
            error.to_string(),
            "environment must be one of development, staging, or production"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_from_path_keeps_canonical_path_when_only_legacy_database_exists() {
        let root = unique_test_dir("legacy-only");
        let legacy = root.join("com.kanna.app").join("kanna-v2.db");
        let canonical = root.join("build.kanna").join("kanna-v2.db");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"legacy database").unwrap();

        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            format!(
                "relay_url = \"\"\n\
                 device_token = \"device-token\"\n\
                 version = \"test-version\"\n\
                 environment = \"development\"\n\
                 transfer_port = 4455\n\
                 db_path = \"{}\"\n",
                canonical.display()
            ),
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(config.db_path, canonical.display().to_string());
        assert_eq!(config.activity_event_debounce_seconds, 20);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_db_path_with_candidates_preserves_custom_paths() {
        let root = unique_test_dir("custom");
        let custom = root.join("custom.sqlite3");
        let canonical = canonical_db_path_for_root(&root);
        let legacy = root.join("com.kanna.app").join("kanna-v2.db");

        let normalized = normalize_db_path_with_candidates(&custom, &canonical, &legacy);

        assert_eq!(normalized, custom.display().to_string());
    }

    #[test]
    fn legacy_relocation_keeps_alternate_database_names_in_the_matching_app_roots() {
        let root = unique_test_dir("alternate-db-name");
        let canonical = root.join("build.kanna").join("kanna-worktree.db");

        assert_eq!(
            legacy_database_relocation_paths(canonical.to_str().unwrap()),
            Some((
                root.join("com.kanna.app").join("kanna-worktree.db"),
                canonical,
            ))
        );
    }

    #[test]
    fn load_from_path_reads_desktop_credential_fields() {
        let root = unique_test_dir("credentials");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             version = \"test-version\"\n\
             environment = \"development\"\n\
             transfer_port = 4455\n\
             desktop_id = \"desktop-1\"\n\
             desktop_secret = \"desktop-secret\"\n",
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(config.desktop_id, "desktop-1");
        assert_eq!(config.desktop_secret.as_deref(), Some("desktop-secret"));
    }

    #[test]
    fn load_from_path_requires_transfer_port() {
        let root = unique_test_dir("missing-transfer-port");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             version = \"test-version\"\n\
             environment = \"development\"\n",
        )
        .unwrap();

        let error = load_from_path(&config_path, &root).unwrap_err();

        assert!(error.to_string().contains("transfer_port"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_from_path_rejects_zero_transfer_port() {
        let root = unique_test_dir("zero-transfer-port");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             version = \"test-version\"\n\
             environment = \"development\"\n\
             transfer_port = 0\n",
        )
        .unwrap();

        let error = load_from_path(&config_path, &root).unwrap_err();

        assert_eq!(error.to_string(), "transfer_port must be greater than zero");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_from_path_reads_loopback_transfer_port() {
        let root = unique_test_dir("transfer-port");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             version = \"test-version\"\n\
             environment = \"development\"\n\
             transfer_port = 4455\n",
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(config.transfer_port, 4455);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_from_path_reads_desktop_resolved_kanna_cli_path() {
        let root = unique_test_dir("kanna-cli-path");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             version = \"test-version\"\n\
             environment = \"development\"\n\
             transfer_port = 4455\n\
             desktop_id = \"desktop-1\"\n\
             kanna_cli_path = \"/Applications/Kanna.app/Contents/MacOS/kanna-cli\"\n",
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(
            config.kanna_cli_path.as_deref(),
            Some("/Applications/Kanna.app/Contents/MacOS/kanna-cli")
        );
    }

    #[test]
    fn load_from_path_ignores_retired_cloud_bootstrap_fields() {
        let root = unique_test_dir("retired-fields");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             version = \"test-version\"\n\
             environment = \"development\"\n\
             transfer_port = 4455\n\
             cloud_base_url = \"http://127.0.0.1:5001/kanna-local/us-central1\"\n\
             firebase_project_id = \"kanna-local\"\n\
             desktop_id = \"desktop-1\"\n",
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(config.desktop_id, "desktop-1");
    }
}
