use super::events::RuntimeError;
use std::path::{Path, PathBuf};
use std::process;
use std::time::Duration;

// Two seconds keeps crash recovery responsive without flooding the renderer when
// its handler is temporarily failing.
const DEFAULT_RECEIPT_RETRY_INTERVAL: Duration = Duration::from_secs(2);
// Applied receipts only provide duplicate suppression, so retain one month and
// cap their count. Unapplied receipts represent required work and are never
// evicted; the lower admission cap instead makes overload explicit.
const DEFAULT_APPLIED_RECEIPT_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const DEFAULT_MAX_UNAPPLIED_RECEIPTS: usize = 256;
const DEFAULT_MAX_APPLIED_RECEIPTS: usize = 4096;
// Destination acknowledgments can be ambiguous across desktop/sidecar crashes,
// so retain committed reservations for a week but bound both active admission
// and historical committed rows.
const DEFAULT_COMMITTED_INCOMING_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DEFAULT_MAX_ACTIVE_INCOMING_RESERVATIONS: usize = 256;
const DEFAULT_MAX_COMMITTED_INCOMING_RESERVATIONS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryMode {
    Registry,
    Mdns,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub peer_id: String,
    pub display_name: String,
    pub registry_dir: PathBuf,
    pub listen_port: u16,
    pub(super) daemon_dir: Option<PathBuf>,
    pub(super) db_path: Option<PathBuf>,
    pub(super) kanna_server_port: Option<u16>,
    pub(super) discovery_mode: DiscoveryMode,
    pub(super) pending_transfer_ttl: Duration,
    pub(super) peer_request_timeout: Duration,
    pub(super) receipt_retry_interval: Duration,
    pub(super) applied_receipt_ttl: Duration,
    pub(super) max_unapplied_receipts: usize,
    pub(super) max_applied_receipts: usize,
    pub(super) committed_incoming_ttl: Duration,
    pub(super) max_active_incoming_reservations: usize,
    pub(super) max_committed_incoming_reservations: usize,
}

impl RuntimeConfig {
    pub fn for_tests(
        peer_id: impl Into<String>,
        display_name: impl Into<String>,
        registry_dir: impl AsRef<Path>,
        listen_port: u16,
    ) -> Self {
        Self {
            peer_id: peer_id.into(),
            display_name: display_name.into(),
            registry_dir: registry_dir.as_ref().to_path_buf(),
            listen_port,
            daemon_dir: None,
            db_path: None,
            kanna_server_port: None,
            discovery_mode: DiscoveryMode::Registry,
            pending_transfer_ttl: Duration::from_secs(300),
            peer_request_timeout: Duration::from_secs(15),
            receipt_retry_interval: DEFAULT_RECEIPT_RETRY_INTERVAL,
            applied_receipt_ttl: DEFAULT_APPLIED_RECEIPT_TTL,
            max_unapplied_receipts: DEFAULT_MAX_UNAPPLIED_RECEIPTS,
            max_applied_receipts: DEFAULT_MAX_APPLIED_RECEIPTS,
            committed_incoming_ttl: DEFAULT_COMMITTED_INCOMING_TTL,
            max_active_incoming_reservations: DEFAULT_MAX_ACTIVE_INCOMING_RESERVATIONS,
            max_committed_incoming_reservations: DEFAULT_MAX_COMMITTED_INCOMING_RESERVATIONS,
        }
    }

    pub fn with_discovery_mode(mut self, discovery_mode: DiscoveryMode) -> Self {
        self.discovery_mode = discovery_mode;
        self
    }

    pub fn with_pending_transfer_ttl(mut self, pending_transfer_ttl: Duration) -> Self {
        self.pending_transfer_ttl = pending_transfer_ttl;
        self
    }

    pub fn with_peer_request_timeout(mut self, peer_request_timeout: Duration) -> Self {
        self.peer_request_timeout = peer_request_timeout;
        self
    }

    pub fn with_receipt_retry_interval(mut self, receipt_retry_interval: Duration) -> Self {
        self.receipt_retry_interval = receipt_retry_interval;
        self
    }

    pub fn with_replay_limits(
        mut self,
        max_unapplied_receipts: usize,
        max_applied_receipts: usize,
    ) -> Self {
        self.max_unapplied_receipts = max_unapplied_receipts;
        self.max_applied_receipts = max_applied_receipts;
        self
    }

    pub fn with_applied_receipt_ttl(mut self, applied_receipt_ttl: Duration) -> Self {
        self.applied_receipt_ttl = applied_receipt_ttl;
        self
    }

    pub fn with_committed_incoming_ttl(mut self, ttl: Duration) -> Self {
        self.committed_incoming_ttl = ttl;
        self
    }

    pub fn with_incoming_replay_limits(mut self, max_active: usize, max_committed: usize) -> Self {
        self.max_active_incoming_reservations = max_active;
        self.max_committed_incoming_reservations = max_committed;
        self
    }

    pub fn with_daemon_dir(mut self, daemon_dir: impl AsRef<Path>) -> Self {
        self.daemon_dir = Some(daemon_dir.as_ref().to_path_buf());
        self
    }

    pub fn with_db_path(mut self, db_path: impl AsRef<Path>) -> Self {
        self.db_path = Some(db_path.as_ref().to_path_buf());
        self
    }

    pub fn with_kanna_server_port(mut self, port: u16) -> Self {
        self.kanna_server_port = Some(port);
        self
    }

    pub fn from_env() -> Result<Self, RuntimeError> {
        let listen_port = std::env::var("KANNA_TRANSFER_PORT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.parse::<u16>())
            .transpose()
            .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?
            .unwrap_or(4455);

        let transfer_root = std::env::var("KANNA_TRANSFER_ROOT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(kanna_runtime_defaults::default_transfer_root);

        let registry_dir = std::env::var("KANNA_TRANSFER_REGISTRY_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| transfer_root.join("registry"));

        let peer_id = std::env::var("KANNA_TRANSFER_PEER_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("peer-{}-{}", process::id(), listen_port));

        let display_name = std::env::var("KANNA_TRANSFER_DISPLAY_NAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("Kanna {}", process::id()));
        let discovery_mode = std::env::var("KANNA_TRANSFER_DISCOVERY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| match value.as_str() {
                "registry" => Ok(DiscoveryMode::Registry),
                "mdns" | "bonjour" => Ok(DiscoveryMode::Mdns),
                other => Err(RuntimeError::InvalidConfig(format!(
                    "unsupported transfer discovery mode: {other}"
                ))),
            })
            .transpose()?
            .unwrap_or(DiscoveryMode::Mdns);

        Ok(Self {
            peer_id,
            display_name,
            registry_dir,
            listen_port,
            daemon_dir: Some(
                std::env::var("KANNA_DAEMON_DIR")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(kanna_runtime_defaults::daemon_dir_for_current_runtime),
            ),
            db_path: Some(
                std::env::var("KANNA_DB_PATH")
                    .or_else(|_| std::env::var("KANNA_CLI_DB_PATH"))
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(kanna_runtime_defaults::preferred_desktop_db_path),
            ),
            kanna_server_port: std::env::var("KANNA_MOBILE_SERVER_PORT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.parse::<u16>())
                .transpose()
                .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?,
            discovery_mode,
            pending_transfer_ttl: Duration::from_secs(300),
            peer_request_timeout: Duration::from_secs(15),
            receipt_retry_interval: DEFAULT_RECEIPT_RETRY_INTERVAL,
            applied_receipt_ttl: DEFAULT_APPLIED_RECEIPT_TTL,
            max_unapplied_receipts: DEFAULT_MAX_UNAPPLIED_RECEIPTS,
            max_applied_receipts: DEFAULT_MAX_APPLIED_RECEIPTS,
            committed_incoming_ttl: DEFAULT_COMMITTED_INCOMING_TTL,
            max_active_incoming_reservations: DEFAULT_MAX_ACTIVE_INCOMING_RESERVATIONS,
            max_committed_incoming_reservations: DEFAULT_MAX_COMMITTED_INCOMING_RESERVATIONS,
        })
    }

    pub(super) fn endpoint(&self) -> String {
        format!("127.0.0.1:{}", self.listen_port)
    }

    pub(super) fn bind_host(&self) -> &'static str {
        match self.discovery_mode {
            DiscoveryMode::Registry => "127.0.0.1",
            DiscoveryMode::Mdns => "0.0.0.0",
        }
    }
}
