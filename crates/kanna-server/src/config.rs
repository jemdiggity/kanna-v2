use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub relay_url: String,
    pub device_token: String,
    #[serde(default = "default_daemon_dir")]
    pub daemon_dir: String,
    #[serde(default = "default_db_path")]
    pub db_path: String,
}

fn default_daemon_dir() -> String {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Kanna")
        .to_string_lossy()
        .to_string()
}

fn default_db_path() -> String {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.kanna.app")
        .join("kanna-v2.db")
        .to_string_lossy()
        .to_string()
}

impl Config {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = match std::env::var("KANNA_SERVER_CONFIG") {
            Ok(p) => PathBuf::from(p),
            Err(_) => dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Kanna")
                .join("server.toml"),
        };
        let content = std::fs::read_to_string(&config_path).map_err(|e| {
            format!(
                "Failed to read {}: {}. Run 'kanna-server register' first.",
                config_path.display(),
                e
            )
        })?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
}
