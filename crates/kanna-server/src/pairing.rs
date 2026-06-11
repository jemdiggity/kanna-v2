use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedDevice {
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PairingStore {
    pub trusted_devices: HashMap<String, Vec<TrustedDevice>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingSession {
    pub code: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub lan_host: String,
    pub lan_port: u16,
    pub expires_at_unix_ms: u64,
}

impl PairingStore {
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }

        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read pairing store {}: {}", path.display(), e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("failed to parse pairing store {}: {}", path.display(), e))
    }

    #[cfg(test)]
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "failed to create pairing store directory {}: {}",
                    parent.display(),
                    e
                )
            })?;
        }

        let body = serde_json::to_string_pretty(self)
            .map_err(|e| format!("failed to serialize pairing store: {}", e))?;
        std::fs::write(path, body)
            .map_err(|e| format!("failed to write pairing store {}: {}", path.display(), e))
    }

    #[cfg(test)]
    pub fn add_trusted_device(&mut self, desktop_id: &str, device_id: &str, name: &str) {
        self.trusted_devices
            .entry(desktop_id.to_string())
            .or_default()
            .push(TrustedDevice {
                device_id: device_id.to_string(),
                device_name: name.to_string(),
            });
    }

    #[cfg(test)]
    pub fn is_trusted(&self, desktop_id: &str, device_id: &str) -> bool {
        self.trusted_devices
            .get(desktop_id)
            .map(|devices| devices.iter().any(|device| device.device_id == device_id))
            .unwrap_or(false)
    }
}

pub fn create_pairing_session(config: &Config) -> Result<PairingSession, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {}", e))?
        .as_millis() as u64;

    Ok(PairingSession {
        code: generate_pairing_code()?,
        desktop_id: config.desktop_id.clone(),
        desktop_name: config.desktop_name.clone(),
        lan_host: config.lan_host.clone(),
        lan_port: config.lan_port,
        expires_at_unix_ms: now_ms + 5 * 60 * 1000,
    })
}

pub fn active_pairing_code(session: Option<&PairingSession>) -> Option<String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;

    session
        .filter(|pairing| pairing.expires_at_unix_ms > now_ms)
        .map(|pairing| pairing.code.clone())
}

fn generate_pairing_code() -> Result<String, String> {
    use std::io::Read;

    let mut bytes = [0u8; 3];
    std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02X}", b)).collect())
}

#[cfg(test)]
mod tests {
    use crate::config::Config;
    use std::path::PathBuf;

    #[test]
    fn trusted_device_roundtrip_preserves_desktop_binding() {
        let mut store = super::PairingStore::default();
        store.add_trusted_device("desktop-1", "device-1", "Jeremy's iPhone");

        assert!(store.is_trusted("desktop-1", "device-1"));
        assert!(!store.is_trusted("desktop-2", "device-1"));
    }

    #[test]
    fn pairing_store_persists_trusted_devices() {
        let path = std::env::temp_dir().join("kanna-pairing-store-test.json");
        let _ = std::fs::remove_file(&path);

        let mut store = super::PairingStore::default();
        store.add_trusted_device("desktop-1", "device-1", "Jeremy's iPhone");
        store.save(&path).unwrap();

        let loaded = super::PairingStore::load(&path).unwrap();
        assert!(loaded.is_trusted("desktop-1", "device-1"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn create_pairing_session_uses_desktop_config() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: "/tmp/kanna.db".to_string(),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: PathBuf::from("/tmp/kanna-pairings.json")
                .to_string_lossy()
                .to_string(),
        };

        let session = super::create_pairing_session(&config).unwrap();

        assert_eq!(session.desktop_id, "desktop-1");
        assert_eq!(session.desktop_name, "Studio Mac");
        assert_eq!(session.lan_port, 48120);
        assert_eq!(session.code.len(), 6);
    }
}
