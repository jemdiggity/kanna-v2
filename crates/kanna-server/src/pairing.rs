use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PAIRING_TTL_MS: u64 = 5 * 60 * 1_000;
pub const MAX_FAILED_CLAIMS: u8 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedDevice {
    pub device_id: String,
    pub device_name: String,
    /// SHA-256 hex digest of the device secret issued at claim time. Absent
    /// for devices paired before secrets existed; those devices cannot
    /// authenticate LAN requests until they re-pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_hash: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PairingStore {
    pub trusted_devices: HashMap<String, Vec<TrustedDevice>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingSession {
    pub code: String,
    pub pairing_payload: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub lan_host: String,
    pub lan_port: u16,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ActivePairingSession {
    pub session: PairingSession,
    pub failed_claims: u8,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaimRequest {
    pub code: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaimResponse {
    pub desktop_id: String,
    pub desktop_name: String,
    /// One-time plaintext device secret. Only the hash is persisted; the
    /// mobile app must store this to authenticate LAN requests.
    pub device_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingClaimError {
    NoActiveSession,
    InvalidRequest,
    InvalidCode,
    Expired,
    RateLimited,
    Persistence(String),
}

impl fmt::Display for PairingClaimError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoActiveSession => formatter.write_str("no pairing session is active"),
            Self::InvalidRequest => formatter.write_str("pairing claim is invalid"),
            Self::InvalidCode => formatter.write_str("pairing code is invalid"),
            Self::Expired => formatter.write_str("pairing session expired"),
            Self::RateLimited => formatter.write_str("too many failed pairing attempts"),
            Self::Persistence(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for PairingClaimError {}

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
        let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temp_path, body).map_err(|e| {
            format!(
                "failed to write pairing store temp file {}: {}",
                temp_path.display(),
                e
            )
        })?;
        std::fs::rename(&temp_path, path).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!(
                "failed to replace pairing store {} from {}: {}",
                path.display(),
                temp_path.display(),
                e
            )
        })
    }

    pub fn add_trusted_device(
        &mut self,
        desktop_id: &str,
        device_id: &str,
        name: &str,
        secret_hash: &str,
    ) {
        let devices = self
            .trusted_devices
            .entry(desktop_id.to_string())
            .or_default();
        if let Some(device) = devices
            .iter_mut()
            .find(|device| device.device_id == device_id)
        {
            device.device_name = name.to_string();
            device.secret_hash = Some(secret_hash.to_string());
        } else {
            devices.push(TrustedDevice {
                device_id: device_id.to_string(),
                device_name: name.to_string(),
                secret_hash: Some(secret_hash.to_string()),
            });
        }
    }

    /// Validates a device secret presented on a LAN request against the
    /// stored hash. Devices paired before secrets existed have no hash and
    /// never verify.
    pub fn verify_device_secret(
        &self,
        desktop_id: &str,
        device_id: &str,
        device_secret: &str,
    ) -> bool {
        let Some(devices) = self.trusted_devices.get(desktop_id) else {
            return false;
        };
        let Some(stored_hash) = devices
            .iter()
            .find(|device| device.device_id == device_id)
            .and_then(|device| device.secret_hash.as_deref())
        else {
            return false;
        };
        constant_time_eq(
            stored_hash.as_bytes(),
            hash_device_secret(device_secret).as_bytes(),
        )
    }

    pub fn is_trusted(&self, desktop_id: &str, device_id: &str) -> bool {
        self.trusted_devices
            .get(desktop_id)
            .map(|devices| devices.iter().any(|device| device.device_id == device_id))
            .unwrap_or(false)
    }
}

pub fn hash_device_secret(device_secret: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(device_secret.as_bytes());
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
pub fn create_pairing_session(config: &Config) -> Result<PairingSession, String> {
    Ok(create_active_pairing_session(config)?.session)
}

pub fn create_active_pairing_session(config: &Config) -> Result<ActivePairingSession, String> {
    create_pairing_session_at(config, unix_time_ms()?)
}

fn create_pairing_session_at(config: &Config, now_ms: u64) -> Result<ActivePairingSession, String> {
    let code = generate_pairing_code()?;
    let pairing_payload = format!("KANNA1:{}:{code}", config.desktop_id.to_ascii_uppercase());
    if !pairing_payload.chars().all(is_qr_alphanumeric) {
        return Err("desktop identity cannot be encoded in a compact pairing QR".to_string());
    }

    Ok(ActivePairingSession {
        session: PairingSession {
            code,
            pairing_payload,
            desktop_id: config.desktop_id.clone(),
            desktop_name: config.desktop_name.clone(),
            lan_host: config.lan_host.clone(),
            lan_port: config.lan_port,
            expires_at_unix_ms: now_ms + PAIRING_TTL_MS,
        },
        failed_claims: 0,
    })
}

fn is_qr_alphanumeric(character: char) -> bool {
    character.is_ascii_uppercase()
        || character.is_ascii_digit()
        || matches!(
            character,
            ' ' | '$' | '%' | '*' | '+' | '-' | '.' | '/' | ':'
        )
}

pub fn claim_pairing_session(
    config: &Config,
    active: &mut Option<ActivePairingSession>,
    request: PairingClaimRequest,
) -> Result<PairingClaimResponse, PairingClaimError> {
    let now_ms = unix_time_ms().map_err(PairingClaimError::Persistence)?;
    claim_pairing_session_at(config, active, request, now_ms)
}

fn claim_pairing_session_at(
    config: &Config,
    active: &mut Option<ActivePairingSession>,
    request: PairingClaimRequest,
    now_ms: u64,
) -> Result<PairingClaimResponse, PairingClaimError> {
    let device_id = request.device_id.trim();
    let device_name = request.device_name.trim();
    if device_id.is_empty()
        || device_name.is_empty()
        || device_id.len() > 256
        || device_name.len() > 256
    {
        return Err(PairingClaimError::InvalidRequest);
    }

    let Some(current) = active.as_mut() else {
        return Err(PairingClaimError::NoActiveSession);
    };
    if now_ms > current.session.expires_at_unix_ms {
        *active = None;
        return Err(PairingClaimError::Expired);
    }
    if current.failed_claims >= MAX_FAILED_CLAIMS {
        return Err(PairingClaimError::RateLimited);
    }

    let normalized_code = request.code.trim().to_ascii_uppercase();
    if normalized_code != current.session.code {
        current.failed_claims += 1;
        return if current.failed_claims >= MAX_FAILED_CLAIMS {
            Err(PairingClaimError::RateLimited)
        } else {
            Err(PairingClaimError::InvalidCode)
        };
    }

    let device_secret = generate_device_secret().map_err(PairingClaimError::Persistence)?;
    let response = PairingClaimResponse {
        desktop_id: current.session.desktop_id.clone(),
        desktop_name: current.session.desktop_name.clone(),
        device_secret: device_secret.clone(),
    };
    let store_path = Path::new(&config.pairing_store_path);
    let mut store = PairingStore::load(store_path).map_err(PairingClaimError::Persistence)?;
    store.add_trusted_device(
        &response.desktop_id,
        device_id,
        device_name,
        &hash_device_secret(&device_secret),
    );
    store
        .save(store_path)
        .map_err(PairingClaimError::Persistence)?;
    *active = None;
    Ok(response)
}

fn generate_device_secret() -> Result<String, String> {
    use std::io::Read;

    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
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

fn unix_time_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {}", e))
        .map(|duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use crate::config::Config;
    use std::path::{Path, PathBuf};

    fn test_config(label: &str) -> Config {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: "/tmp/kanna.db".to_string(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48_120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: std::env::temp_dir()
                .join(format!("kanna-pairing-{label}-{unique}.json"))
                .to_string_lossy()
                .to_string(),
        }
    }

    #[test]
    fn trusted_device_roundtrip_preserves_desktop_binding() {
        let mut store = super::PairingStore::default();
        store.add_trusted_device(
            "desktop-1",
            "device-1",
            "Jeremy's iPhone",
            &super::hash_device_secret("secret-1"),
        );

        assert!(store.is_trusted("desktop-1", "device-1"));
        assert!(!store.is_trusted("desktop-2", "device-1"));
        assert!(store.verify_device_secret("desktop-1", "device-1", "secret-1"));
        assert!(!store.verify_device_secret("desktop-1", "device-1", "wrong"));
        assert!(!store.verify_device_secret("desktop-2", "device-1", "secret-1"));
    }

    #[test]
    fn pairing_store_persists_trusted_devices() {
        let path = std::env::temp_dir().join("kanna-pairing-store-test.json");
        let _ = std::fs::remove_file(&path);

        let mut store = super::PairingStore::default();
        store.add_trusted_device(
            "desktop-1",
            "device-1",
            "Jeremy's iPhone",
            &super::hash_device_secret("secret-1"),
        );
        store.save(&path).unwrap();

        let loaded = super::PairingStore::load(&path).unwrap();
        assert!(loaded.is_trusted("desktop-1", "device-1"));
        assert!(loaded.verify_device_secret("desktop-1", "device-1", "secret-1"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn create_pairing_session_uses_desktop_config() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: "/tmp/kanna.db".to_string(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
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

    #[test]
    fn pairing_payload_is_compact_versioned_and_contains_identity() {
        let mut config = test_config("payload");
        config.desktop_id = "desktop-21b320e8-a5ad-4fae-9d87-1db14090f0a9".to_string();
        let active = super::create_pairing_session_at(&config, 1_000).unwrap();

        assert_eq!(
            active.session.pairing_payload,
            format!(
                "KANNA1:DESKTOP-21B320E8-A5AD-4FAE-9D87-1DB14090F0A9:{}",
                active.session.code
            )
        );
        assert_eq!(active.session.pairing_payload.len(), 58);
        assert!(active
            .session
            .pairing_payload
            .chars()
            .all(super::is_qr_alphanumeric));
    }

    #[test]
    fn pairing_payload_rejects_identity_outside_qr_alphanumeric_mode() {
        let mut config = test_config("payload-invalid-identity");
        config.desktop_id = "desktop_not_transport_safe".to_string();

        assert_eq!(
            super::create_pairing_session_at(&config, 1_000).unwrap_err(),
            "desktop identity cannot be encoded in a compact pairing QR"
        );
    }

    #[test]
    fn successful_claim_is_single_use_and_persists_device() {
        let config = test_config("success");
        let mut active = Some(super::create_pairing_session_at(&config, 1_000).unwrap());
        let code = active.as_ref().unwrap().session.code.clone();

        let claimed = super::claim_pairing_session_at(
            &config,
            &mut active,
            super::PairingClaimRequest {
                code,
                device_id: "phone-1".to_string(),
                device_name: "Kanna Mobile".to_string(),
            },
            2_000,
        )
        .unwrap();

        assert_eq!(claimed.desktop_id, "desktop-1");
        assert!(active.is_none());
        assert_eq!(claimed.device_secret.len(), 64);
        let store = super::PairingStore::load(Path::new(&config.pairing_store_path)).unwrap();
        assert!(store.is_trusted("desktop-1", "phone-1"));
        assert!(store.verify_device_secret("desktop-1", "phone-1", &claimed.device_secret));
        let raw = std::fs::read_to_string(&config.pairing_store_path).unwrap();
        assert!(
            !raw.contains(&claimed.device_secret),
            "plaintext device secret must never be persisted"
        );
    }

    #[test]
    fn devices_paired_before_secrets_existed_never_verify() {
        let path = std::env::temp_dir().join("kanna-pairing-legacy-secret-test.json");
        let _ = std::fs::remove_file(&path);
        std::fs::write(
            &path,
            r#"{"trusted_devices":{"desktop-1":[{"device_id":"old-phone","device_name":"Old"}]}}"#,
        )
        .unwrap();

        let store = super::PairingStore::load(&path).unwrap();
        assert!(store.is_trusted("desktop-1", "old-phone"));
        assert!(!store.verify_device_secret("desktop-1", "old-phone", ""));
        assert!(!store.verify_device_secret("desktop-1", "old-phone", "anything"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn invalid_claims_are_rate_limited() {
        let config = test_config("rate-limit");
        let mut active = Some(super::create_pairing_session_at(&config, 1_000).unwrap());

        for attempt in 0..super::MAX_FAILED_CLAIMS {
            let error = super::claim_pairing_session_at(
                &config,
                &mut active,
                super::PairingClaimRequest {
                    code: "BAD000".to_string(),
                    device_id: "phone-1".to_string(),
                    device_name: "Kanna Mobile".to_string(),
                },
                2_000,
            )
            .unwrap_err();
            let expected = if attempt + 1 == super::MAX_FAILED_CLAIMS {
                super::PairingClaimError::RateLimited
            } else {
                super::PairingClaimError::InvalidCode
            };
            assert_eq!(error, expected);
        }

        assert_eq!(
            super::claim_pairing_session_at(
                &config,
                &mut active,
                super::PairingClaimRequest {
                    code: "BAD000".to_string(),
                    device_id: "phone-1".to_string(),
                    device_name: "Kanna Mobile".to_string(),
                },
                2_000,
            ),
            Err(super::PairingClaimError::RateLimited)
        );
    }

    #[test]
    fn expired_claim_consumes_the_stale_session() {
        let config = test_config("expired");
        let mut active = Some(super::create_pairing_session_at(&config, 1_000).unwrap());
        let code = active.as_ref().unwrap().session.code.clone();

        assert_eq!(
            super::claim_pairing_session_at(
                &config,
                &mut active,
                super::PairingClaimRequest {
                    code,
                    device_id: "phone-1".to_string(),
                    device_name: "Kanna Mobile".to_string(),
                },
                1_000 + super::PAIRING_TTL_MS + 1,
            ),
            Err(super::PairingClaimError::Expired)
        );
        assert!(active.is_none());
    }
}
