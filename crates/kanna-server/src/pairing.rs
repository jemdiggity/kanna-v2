use crate::config::Config;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PAIRING_TTL_MS: u64 = 5 * 60 * 1_000;
pub const MAX_FAILED_CLAIMS: u8 = 5;
pub const PUSH_PAIRING_CERT_TTL_MS: u64 = 730 * 24 * 60 * 60 * 1_000;
const ANONYMOUS_PUSH_IDENTITY_VERSION: u8 = 1;
const PUSH_PAIRING_CERT_DOMAIN: &[u8] = b"kanna.push-pairing-cert.v1\0";
const ANONYMOUS_PUSH_AUTH_DOMAIN: &[u8] = b"kanna.relay-auth.v1\0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedDevice {
    pub device_id: String,
    pub device_name: String,
    /// SHA-256 hex digest of the device secret issued at claim time. Absent
    /// for devices paired before secrets existed; those devices cannot
    /// authenticate LAN requests until they re-pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_hash: Option<String>,
    /// Public identity that issued this device's most recent pairing
    /// certificate. Legacy pairings acquire this on their first authenticated
    /// re-issue. A mismatch means the private identity was lost or rotated and
    /// deliberately requires a new pairing ceremony.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_identity_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAnonymousPushRevocation {
    pub desktop_public_key: String,
    pub device_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PairingStore {
    pub trusted_devices: HashMap<String, Vec<TrustedDevice>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_anonymous_push_revocations: Vec<PendingAnonymousPushRevocation>,
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
    pub desktop_push_identity: DesktopPushIdentity,
    pub push_pairing_cert: PushPairingCertificate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPushIdentity {
    /// Raw 32-byte Ed25519 public key encoded as unpadded base64url.
    pub public_key: String,
    pub relay_url: String,
    pub environment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushPairingCertificate {
    pub device_id: String,
    /// Unix epoch milliseconds.
    pub issued_at: u64,
    /// Unix epoch milliseconds, 730 days after issuance.
    pub expires_at: u64,
    /// Raw 64-byte Ed25519 signature encoded as unpadded base64url.
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushPairingMaterial {
    pub desktop_push_identity: DesktopPushIdentity,
    pub push_pairing_cert: PushPairingCertificate,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnonymousPushIdentityStore {
    version: u8,
    private_key: String,
    public_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushPairingCertificatePayload<'a> {
    device_id: &'a str,
    issued_at: u64,
    expires_at: u64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingCertificateError {
    NotPaired,
    IdentityChanged,
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

impl fmt::Display for PairingCertificateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotPaired => formatter.write_str("device is not paired"),
            Self::IdentityChanged => formatter
                .write_str("desktop push identity changed; pair this device again to recover"),
            Self::Persistence(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for PairingCertificateError {}

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
                push_identity_public_key: None,
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

    pub fn remove_trusted_device(&mut self, desktop_id: &str, device_id: &str) -> bool {
        let Some(devices) = self.trusted_devices.get_mut(desktop_id) else {
            return false;
        };
        let Some(index) = devices
            .iter()
            .position(|device| device.device_id == device_id)
        else {
            return false;
        };
        let removed = devices.remove(index);
        if devices.is_empty() {
            self.trusted_devices.remove(desktop_id);
        }
        if let Some(desktop_public_key) = removed.push_identity_public_key {
            let revocation = PendingAnonymousPushRevocation {
                desktop_public_key,
                device_id: removed.device_id,
            };
            if !self
                .pending_anonymous_push_revocations
                .contains(&revocation)
            {
                self.pending_anonymous_push_revocations.push(revocation);
            }
        }
        true
    }

    pub fn acknowledge_anonymous_push_revocation(
        &mut self,
        revocation: &PendingAnonymousPushRevocation,
    ) -> bool {
        let before = self.pending_anonymous_push_revocations.len();
        self.pending_anonymous_push_revocations
            .retain(|pending| pending != revocation);
        self.pending_anonymous_push_revocations.len() != before
    }

    fn trusted_device_mut(
        &mut self,
        desktop_id: &str,
        device_id: &str,
    ) -> Option<&mut TrustedDevice> {
        self.trusted_devices
            .get_mut(desktop_id)?
            .iter_mut()
            .find(|device| device.device_id == device_id)
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
    let material = issue_push_pairing_material(config, device_id, now_ms)
        .map_err(PairingClaimError::Persistence)?;
    let response = PairingClaimResponse {
        desktop_id: current.session.desktop_id.clone(),
        desktop_name: current.session.desktop_name.clone(),
        device_secret: device_secret.clone(),
        desktop_push_identity: material.desktop_push_identity,
        push_pairing_cert: material.push_pairing_cert,
    };
    let store_path = Path::new(&config.pairing_store_path);
    let mut store = PairingStore::load(store_path).map_err(PairingClaimError::Persistence)?;
    store.add_trusted_device(
        &response.desktop_id,
        device_id,
        device_name,
        &hash_device_secret(&device_secret),
    );
    if let Some(device) = store.trusted_device_mut(&response.desktop_id, device_id) {
        device.push_identity_public_key = Some(response.desktop_push_identity.public_key.clone());
    }
    store
        .save(store_path)
        .map_err(PairingClaimError::Persistence)?;
    *active = None;
    Ok(response)
}

pub fn reissue_push_pairing_certificate(
    config: &Config,
    device_id: &str,
) -> Result<PushPairingMaterial, PairingCertificateError> {
    let now_ms = unix_time_ms().map_err(PairingCertificateError::Persistence)?;
    reissue_push_pairing_certificate_at(config, device_id, now_ms)
}

fn reissue_push_pairing_certificate_at(
    config: &Config,
    device_id: &str,
    now_ms: u64,
) -> Result<PushPairingMaterial, PairingCertificateError> {
    let identity = load_or_create_anonymous_push_identity(config)
        .map_err(PairingCertificateError::Persistence)?;
    let public_key = encode_public_key(&identity);
    let store_path = Path::new(&config.pairing_store_path);
    let mut store = PairingStore::load(store_path).map_err(PairingCertificateError::Persistence)?;
    let device = store
        .trusted_device_mut(&config.desktop_id, device_id)
        .ok_or(PairingCertificateError::NotPaired)?;
    match device.push_identity_public_key.as_deref() {
        Some(recorded) if recorded != public_key => {
            return Err(PairingCertificateError::IdentityChanged)
        }
        Some(_) => {}
        None => {
            device.push_identity_public_key = Some(public_key.clone());
            store
                .save(store_path)
                .map_err(PairingCertificateError::Persistence)?;
        }
    }
    Ok(issue_push_pairing_material_with_identity(
        config, device_id, now_ms, identity,
    ))
}

fn issue_push_pairing_material(
    config: &Config,
    device_id: &str,
    now_ms: u64,
) -> Result<PushPairingMaterial, String> {
    let identity = load_or_create_anonymous_push_identity(config)?;
    Ok(issue_push_pairing_material_with_identity(
        config, device_id, now_ms, identity,
    ))
}

fn issue_push_pairing_material_with_identity(
    config: &Config,
    device_id: &str,
    now_ms: u64,
    identity: SigningKey,
) -> PushPairingMaterial {
    let expires_at = now_ms.saturating_add(PUSH_PAIRING_CERT_TTL_MS);
    let payload = push_pairing_certificate_signing_payload(device_id, now_ms, expires_at);
    let signature = identity.sign(&payload);
    PushPairingMaterial {
        desktop_push_identity: DesktopPushIdentity {
            public_key: encode_public_key(&identity),
            relay_url: advertised_relay_url(
                config,
                std::env::var("KANNA_ADVERTISED_RELAY_URL").ok(),
            ),
            environment: config.environment.clone(),
        },
        push_pairing_cert: PushPairingCertificate {
            device_id: device_id.to_string(),
            issued_at: now_ms,
            expires_at,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        },
    }
}

fn advertised_relay_url(config: &Config, override_url: Option<String>) -> String {
    override_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| config.relay_url.clone())
}

/// Canonical bytes verified by the relay. The domain prefix prevents this
/// signature from being interpreted as another protocol message; the JSON
/// field order is fixed by the struct declaration.
pub fn push_pairing_certificate_signing_payload(
    device_id: &str,
    issued_at: u64,
    expires_at: u64,
) -> Vec<u8> {
    let payload = PushPairingCertificatePayload {
        device_id,
        issued_at,
        expires_at,
    };
    let mut bytes = PUSH_PAIRING_CERT_DOMAIN.to_vec();
    bytes.extend(
        serde_json::to_vec(&payload)
            .expect("serializing a pairing certificate payload cannot fail"),
    );
    bytes
}

fn anonymous_push_identity_path(config: &Config) -> Result<std::path::PathBuf, String> {
    let pairing_store = Path::new(&config.pairing_store_path);
    let parent = pairing_store.parent().ok_or_else(|| {
        format!(
            "pairing store path has no parent: {}",
            pairing_store.display()
        )
    })?;
    let pairing_file_name = pairing_store
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "pairing store path has no UTF-8 file name: {}",
                pairing_store.display()
            )
        })?;
    Ok(parent.join(format!("{pairing_file_name}.anonymous-push-identity.json")))
}

fn load_or_create_anonymous_push_identity(config: &Config) -> Result<SigningKey, String> {
    let path = anonymous_push_identity_path(config)?;
    match read_anonymous_push_identity(&path) {
        Ok(identity) => return Ok(identity),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(format!(
                "failed to read anonymous push identity {}: {error}",
                path.display()
            ));
        }
        Err(_) => {}
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("identity path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let mut private_key = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut private_key))
        .map_err(|error| format!("failed to read operating-system randomness: {error}"))?;
    let identity = SigningKey::from_bytes(&private_key);
    let stored = AnonymousPushIdentityStore {
        version: ANONYMOUS_PUSH_IDENTITY_VERSION,
        private_key: URL_SAFE_NO_PAD.encode(private_key),
        public_key: encode_public_key(&identity),
    };
    let body = serde_json::to_vec_pretty(&stored)
        .map_err(|error| format!("failed to serialize anonymous push identity: {error}"))?;

    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    match options.open(&path) {
        Ok(mut file) => {
            if let Err(error) = file.write_all(&body).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(format!("failed to write {}: {error}", path.display()));
            }
            Ok(identity)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_anonymous_push_identity(&path).map_err(|error| {
                format!(
                    "failed to read concurrently-created anonymous push identity {}: {error}",
                    path.display()
                )
            })
        }
        Err(error) => Err(format!("failed to create {}: {error}", path.display())),
    }
}

/// Sign a relay-issued one-time challenge with the existing anonymous push
/// identity. Authentication never creates or rotates pairing identity state.
pub(crate) fn sign_anonymous_push_auth_challenge(
    config: &Config,
    nonce: &str,
) -> Result<(String, String), String> {
    let path = anonymous_push_identity_path(config)?;
    let identity = read_anonymous_push_identity(&path).map_err(|error| {
        format!(
            "failed to read anonymous push identity {}: {error}",
            path.display()
        )
    })?;
    let nonce = URL_SAFE_NO_PAD
        .decode(nonce)
        .map_err(|error| format!("relay challenge is not valid base64url: {error}"))?;
    if nonce.len() != 32 {
        return Err("relay challenge must contain 32 bytes".to_string());
    }
    let mut payload = ANONYMOUS_PUSH_AUTH_DOMAIN.to_vec();
    payload.extend(nonce);
    let signature = identity.sign(&payload);
    Ok((
        encode_public_key(&identity),
        URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    ))
}

pub(crate) fn anonymous_push_public_key(config: &Config) -> Result<String, String> {
    let path = anonymous_push_identity_path(config)?;
    read_anonymous_push_identity(&path)
        .map(|identity| encode_public_key(&identity))
        .map_err(|error| {
            format!(
                "failed to read anonymous push identity {}: {error}",
                path.display()
            )
        })
}

fn read_anonymous_push_identity(path: &Path) -> Result<SigningKey, std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "identity must be a regular file",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "identity must not grant group or other permissions",
        ));
    }
    let body = std::fs::read(path)?;
    let stored: AnonymousPushIdentityStore = serde_json::from_slice(&body).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid identity JSON: {error}"),
        )
    })?;
    if stored.version != ANONYMOUS_PUSH_IDENTITY_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unsupported identity version {}", stored.version),
        ));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(stored.private_key)
        .map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid private key encoding: {error}"),
            )
        })?;
    let private_key: [u8; 32] = decoded.try_into().map_err(|decoded: Vec<u8>| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("private key must be 32 bytes, got {}", decoded.len()),
        )
    })?;
    let identity = SigningKey::from_bytes(&private_key);
    if encode_public_key(&identity) != stored.public_key {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stored public key does not match private key",
        ));
    }
    Ok(identity)
}

fn encode_public_key(identity: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(identity.verifying_key().to_bytes())
}

fn generate_device_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

fn generate_pairing_code() -> Result<String, String> {
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
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
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

    fn assert_valid_pairing_material(material: &super::PushPairingMaterial) {
        let public_key: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&material.desktop_push_identity.public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(&material.push_pairing_cert.signature)
                .unwrap(),
        )
        .unwrap();
        let payload = super::push_pairing_certificate_signing_payload(
            &material.push_pairing_cert.device_id,
            material.push_pairing_cert.issued_at,
            material.push_pairing_cert.expires_at,
        );
        VerifyingKey::from_bytes(&public_key)
            .unwrap()
            .verify(&payload, &signature)
            .unwrap();
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
        assert_eq!(
            claimed.desktop_push_identity.relay_url,
            "wss://relay.example"
        );
        assert_eq!(claimed.desktop_push_identity.environment, "development");
        assert_eq!(claimed.push_pairing_cert.device_id, "phone-1");
        assert_eq!(claimed.push_pairing_cert.issued_at, 2_000);
        assert_eq!(
            claimed.push_pairing_cert.expires_at,
            2_000 + super::PUSH_PAIRING_CERT_TTL_MS
        );
        assert_valid_pairing_material(&super::PushPairingMaterial {
            desktop_push_identity: claimed.desktop_push_identity.clone(),
            push_pairing_cert: claimed.push_pairing_cert.clone(),
        });
        let store = super::PairingStore::load(Path::new(&config.pairing_store_path)).unwrap();
        assert!(store.is_trusted("desktop-1", "phone-1"));
        assert!(store.verify_device_secret("desktop-1", "phone-1", &claimed.device_secret));
        let raw = std::fs::read_to_string(&config.pairing_store_path).unwrap();
        assert!(
            !raw.contains(&claimed.device_secret),
            "plaintext device secret must never be persisted"
        );
        let identity_path = super::anonymous_push_identity_path(&config).unwrap();
        let permissions = std::fs::metadata(identity_path).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(permissions.mode() & 0o077, 0);
    }

    #[test]
    fn pairing_identity_uses_phone_reachable_relay_override() {
        let config = test_config("advertised-relay");

        assert_eq!(
            super::advertised_relay_url(&config, Some(" ws://192.168.1.25:9086 ".to_string())),
            "ws://192.168.1.25:9086"
        );
        assert_eq!(
            super::advertised_relay_url(&config, None),
            "wss://relay.example"
        );
    }

    #[test]
    fn legacy_claim_clients_ignore_additive_push_fields() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPairingClaimResponse {
            desktop_id: String,
            desktop_name: String,
            device_secret: String,
        }

        let config = test_config("legacy-client");
        let mut active = Some(super::create_pairing_session_at(&config, 1_000).unwrap());
        let code = active.as_ref().unwrap().session.code.clone();
        let response = super::claim_pairing_session_at(
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

        let legacy: LegacyPairingClaimResponse =
            serde_json::from_value(serde_json::to_value(response).unwrap()).unwrap();
        assert_eq!(legacy.desktop_id, "desktop-1");
        assert_eq!(legacy.desktop_name, "Studio Mac");
        assert_eq!(legacy.device_secret.len(), 64);
    }

    #[test]
    fn authenticated_legacy_pairing_gets_a_certificate_from_the_stable_identity() {
        let config = test_config("legacy-reissue");
        let store_path = Path::new(&config.pairing_store_path);
        let mut store = super::PairingStore::default();
        store.add_trusted_device(
            &config.desktop_id,
            "legacy-phone",
            "Legacy Phone",
            &super::hash_device_secret("legacy-secret"),
        );
        store.save(store_path).unwrap();

        let first =
            super::reissue_push_pairing_certificate_at(&config, "legacy-phone", 10_000).unwrap();
        let second =
            super::reissue_push_pairing_certificate_at(&config, "legacy-phone", 20_000).unwrap();

        assert_eq!(
            first.desktop_push_identity.public_key,
            second.desktop_push_identity.public_key
        );
        assert_eq!(first.push_pairing_cert.issued_at, 10_000);
        assert_eq!(second.push_pairing_cert.issued_at, 20_000);
        assert_ne!(
            first.push_pairing_cert.signature,
            second.push_pairing_cert.signature
        );
        assert_valid_pairing_material(&first);
        assert_valid_pairing_material(&second);
        let persisted = super::PairingStore::load(store_path).unwrap();
        assert_eq!(
            persisted.trusted_devices[&config.desktop_id][0]
                .push_identity_public_key
                .as_deref(),
            Some(first.desktop_push_identity.public_key.as_str())
        );
    }

    #[test]
    fn identity_loss_requires_repairing_before_certificate_reissue() {
        let config = test_config("identity-loss");
        let mut active = Some(super::create_pairing_session_at(&config, 1_000).unwrap());
        let code = active.as_ref().unwrap().session.code.clone();
        let original = super::claim_pairing_session_at(
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
        std::fs::remove_file(super::anonymous_push_identity_path(&config).unwrap()).unwrap();

        assert_eq!(
            super::reissue_push_pairing_certificate_at(&config, "phone-1", 3_000),
            Err(super::PairingCertificateError::IdentityChanged)
        );

        let mut replacement = Some(super::create_pairing_session_at(&config, 4_000).unwrap());
        let replacement_code = replacement.as_ref().unwrap().session.code.clone();
        let repaired = super::claim_pairing_session_at(
            &config,
            &mut replacement,
            super::PairingClaimRequest {
                code: replacement_code,
                device_id: "phone-1".to_string(),
                device_name: "Kanna Mobile".to_string(),
            },
            5_000,
        )
        .unwrap();
        assert_ne!(
            original.desktop_push_identity.public_key,
            repaired.desktop_push_identity.public_key
        );
        assert!(super::reissue_push_pairing_certificate_at(&config, "phone-1", 6_000).is_ok());
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
