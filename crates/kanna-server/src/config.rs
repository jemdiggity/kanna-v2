use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub relay_url: String,
    pub device_token: String,
    pub cloud_base_url: String,
    pub firebase_project_id: String,
    pub firebase_auth_emulator_url: Option<String>,
    pub firebase_firestore_emulator_host: Option<String>,
    pub daemon_dir: String,
    pub db_path: String,
    pub desktop_id: String,
    pub desktop_secret: Option<String>,
    pub desktop_name: String,
    pub server_version: Option<String>,
    pub lan_host: String,
    pub lan_port: u16,
    pub pairing_store_path: String,
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    relay_url: String,
    device_token: String,
    cloud_base_url: Option<String>,
    firebase_project_id: Option<String>,
    firebase_auth_emulator_url: Option<String>,
    firebase_firestore_emulator_host: Option<String>,
    daemon_dir: Option<String>,
    db_path: Option<String>,
    desktop_id: Option<String>,
    desktop_secret: Option<String>,
    desktop_name: Option<String>,
    server_version: Option<String>,
    lan_host: Option<String>,
    lan_port: Option<u16>,
    pairing_store_path: Option<String>,
}

fn default_daemon_dir_for_root(data_root: &Path) -> String {
    kanna_runtime_defaults::default_daemon_dir_for_app_support_root(data_root)
        .to_string_lossy()
        .to_string()
}

fn default_cloud_base_url() -> String {
    "http://127.0.0.1:5001/kanna-local/us-central1".to_string()
}

fn default_firebase_project_id() -> String {
    "kanna-local".to_string()
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

fn preferred_db_path_for_root(data_root: &Path) -> PathBuf {
    preferred_db_path_for_candidates(
        canonical_db_path_for_root(data_root),
        legacy_db_path_for_root(data_root),
    )
}

fn preferred_db_path_for_candidates(canonical: PathBuf, legacy: PathBuf) -> PathBuf {
    if canonical.exists() {
        return canonical;
    }

    if legacy.exists() {
        return legacy;
    }

    canonical
}

fn normalize_db_path_with_candidates(configured: &Path, canonical: &Path, legacy: &Path) -> String {
    if configured == canonical || configured == legacy {
        return preferred_db_path_for_candidates(canonical.to_path_buf(), legacy.to_path_buf())
            .to_string_lossy()
            .to_string();
    }

    configured.to_string_lossy().to_string()
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
    let canonical = canonical_db_path_for_root(data_root);
    let legacy = legacy_db_path_for_root(data_root);
    let db_path = match raw.db_path {
        Some(path) => normalize_db_path_with_candidates(Path::new(&path), &canonical, &legacy),
        None => preferred_db_path_for_root(data_root)
            .to_string_lossy()
            .to_string(),
    };

    Ok(Config {
        relay_url: raw.relay_url,
        device_token: raw.device_token,
        cloud_base_url: raw.cloud_base_url.unwrap_or_else(default_cloud_base_url),
        firebase_project_id: raw
            .firebase_project_id
            .unwrap_or_else(default_firebase_project_id),
        firebase_auth_emulator_url: raw.firebase_auth_emulator_url,
        firebase_firestore_emulator_host: raw.firebase_firestore_emulator_host,
        daemon_dir: raw
            .daemon_dir
            .unwrap_or_else(|| default_daemon_dir_for_root(data_root)),
        db_path,
        desktop_id: raw.desktop_id.unwrap_or_else(default_desktop_id),
        desktop_secret: raw.desktop_secret,
        desktop_name: raw.desktop_name.unwrap_or_else(default_desktop_name),
        server_version: raw.server_version,
        lan_host: raw.lan_host.unwrap_or_else(default_lan_host),
        lan_port: raw.lan_port.unwrap_or_else(default_lan_port),
        pairing_store_path: raw
            .pairing_store_path
            .unwrap_or_else(|| default_pairing_store_path_for_root(data_root)),
    })
}

impl Config {
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
    use super::{canonical_db_path_for_root, load_from_path, normalize_db_path_with_candidates};
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
        assert_eq!(
            config.pairing_store_path,
            root.join("Kanna")
                .join("mobile-pairings.json")
                .display()
                .to_string()
        );
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
    fn load_from_path_reads_cloud_and_emulator_identity_fields() {
        let root = unique_test_dir("cloud");
        let config_path = root.join("server.toml");
        fs::write(
            &config_path,
            "relay_url = \"ws://127.0.0.1:18080\"\n\
             device_token = \"device-token\"\n\
             cloud_base_url = \"http://127.0.0.1:5001/kanna-local/us-central1\"\n\
             firebase_project_id = \"kanna-local\"\n\
             firebase_auth_emulator_url = \"http://127.0.0.1:9099\"\n\
             firebase_firestore_emulator_host = \"127.0.0.1:8080\"\n\
             desktop_id = \"desktop-1\"\n\
             desktop_secret = \"desktop-secret\"\n",
        )
        .unwrap();

        let config = load_from_path(&config_path, &root).unwrap();

        assert_eq!(
            config.cloud_base_url,
            "http://127.0.0.1:5001/kanna-local/us-central1"
        );
        assert_eq!(config.firebase_project_id, "kanna-local");
        assert_eq!(
            config.firebase_auth_emulator_url.as_deref(),
            Some("http://127.0.0.1:9099")
        );
        assert_eq!(
            config.firebase_firestore_emulator_host.as_deref(),
            Some("127.0.0.1:8080")
        );
        assert_eq!(config.desktop_id, "desktop-1");
        assert_eq!(config.desktop_secret.as_deref(), Some("desktop-secret"));
    }
}
