use super::events::RuntimeError;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{Arc, Mutex};
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
// Incoming reservations are active work until destination acknowledgment
// completes. Bound admission rather than evicting committed user-pending work.
const DEFAULT_MAX_INCOMING_RESERVATIONS: usize = 256;
const DEFAULT_MAX_INCOMING_CONNECTIONS: usize = 32;
const DEFAULT_MAX_LIFECYCLE_EVENTS: usize = 256;
const DEFAULT_MAX_TASK_PULL_REQUESTS: usize = 256;
const DEFAULT_MAX_FINALIZATION_WAITERS: usize = 8;
const DEFAULT_MAX_PEER_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_RESPONSE_BYTES: usize = super::MAX_LEGACY_ARTIFACT_RESPONSE_BYTES;
// Finalizing an outgoing transfer is the one peer request whose answer waits on
// a *person's agent* rather than on this machine. `kanna-server` asks the source
// agent to wrap up, waits for it to go idle, tells it to quit, waits for the
// exit, and only then stages artifacts — minutes, legitimately, for a busy
// agent (`transfer_engine/finalize.rs`). Under the ordinary 15 s window the
// destination gave up on every wrap-up longer than a few seconds and burned an
// import attempt from the retry budget reserved for genuinely transient
// failures. Ten minutes covers the source's own bounded budget
// (WRAP_UP_TIMEOUT + QUIT_EXIT_TIMEOUT = 360 s) with room for staging the
// session archive, and is still a bound rather than an open wait.
//
// The number itself lives in `kanna-runtime-defaults`, which both this crate and
// `kanna-server` already depend on, so the source's shutdown budget is checked
// against *this* window rather than against a hand-copied restatement of it:
// shrinking this fails `the_shutdown_budget_fits_inside_the_peer_finalization_window`
// in `transfer_engine/finalize.rs`.
const DEFAULT_FINALIZATION_REQUEST_TIMEOUT: Duration =
    kanna_runtime_defaults::TRANSFER_FINALIZATION_REQUEST_TIMEOUT;
// How long an in-flight transfer keeps its source-side resources: the outgoing
// reservation, and the artifacts staged against it.
//
// The reservation clock starts at *push*, and pruning it is what makes a later
// `finalize_from_source` fail with "missing target peer" — so it has to outlive
// the whole window the destination is allowed to wait in. A reservation that
// expires early breaks a transfer that was working; one that expires late only
// holds a little memory for longer. Held at 300 s it was shorter than
// `DEFAULT_FINALIZATION_REQUEST_TIMEOUT`, which no wrap-up was slow enough to
// reach until finalization stopped being a 1500 ms `SIGINT`.
// `reservations_outlive_the_finalization_window` pins the relationship.
const DEFAULT_PENDING_TRANSFER_TTL: Duration = Duration::from_secs(900);
// How old a sealed peer request may be before it is refused as a replay.
//
// Deliberately *not* the TTL above, though it used to be the same number. That
// one is a resource lifetime and grows with the finalization budget; this one
// is a security bound and must not. Widening it to match would have handed an
// attacker a 15-minute replay window as a side effect of letting a busy agent
// wrap up.
const DEFAULT_AUTHENTICATED_REQUEST_FRESHNESS: Duration = Duration::from_secs(300);
const DEFAULT_MAX_PEER_REQUESTS: usize = 32;
const DEFAULT_MAX_MARK_READ_PEER_REQUESTS: usize = 4;
const DEFAULT_MAX_AUTHENTICATED_REQUEST_REPLAYS: usize = 8_192;
const DEFAULT_TERMINAL_OBSERVER_TOMBSTONE_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_MAX_TERMINAL_OBSERVER_TOMBSTONES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryMode {
    Registry,
    Mdns,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    #[cfg(test)]
    pub(super) mdns_fixture: Option<Arc<tokio::sync::Mutex<super::discovery::MdnsState>>>,
    pub peer_id: String,
    pub display_name: String,
    pub registry_dir: PathBuf,
    pub listen_port: u16,
    pub(super) daemon_dir: Option<PathBuf>,
    pub(super) db_path: Option<PathBuf>,
    pub(super) kanna_server_port: Option<u16>,
    pub(super) discovery_mode: DiscoveryMode,
    pub(super) pending_transfer_ttl: Duration,
    pub(super) authenticated_request_freshness: Duration,
    pub(super) peer_request_timeout: Duration,
    /// How long the source is given to answer a finalization request.
    ///
    /// Separate from `peer_request_timeout` because it bounds something else:
    /// every other peer request is this machine doing local work, while this one
    /// waits on an agent being asked to stop. The destination allows this plus
    /// one ordinary request window, so the source's answer — including its own
    /// timeout report — always arrives while the destination is still listening.
    pub(super) finalization_request_timeout: Duration,
    pub(super) receipt_retry_interval: Duration,
    pub(super) applied_receipt_ttl: Duration,
    pub(super) max_unapplied_receipts: usize,
    pub(super) max_applied_receipts: usize,
    pub(super) max_incoming_reservations: usize,
    pub(super) max_incoming_connections: usize,
    pub(super) max_lifecycle_events: usize,
    pub(super) max_task_pull_requests: usize,
    pub(super) max_finalization_waiters: usize,
    pub(super) max_peer_response_bytes: usize,
    pub(super) max_artifact_response_bytes: usize,
    pub(super) mark_read_timeout: Duration,
    pub(super) max_peer_requests: usize,
    pub(super) max_mark_read_peer_requests: usize,
    pub(super) max_authenticated_request_replays: usize,
    pub(super) terminal_observer_tombstone_ttl: Duration,
    pub(super) max_terminal_observer_tombstones: usize,
    pub(super) peer_discovery_delays: Arc<Mutex<VecDeque<Duration>>>,
}

impl RuntimeConfig {
    pub fn for_tests(
        peer_id: impl Into<String>,
        display_name: impl Into<String>,
        registry_dir: impl AsRef<Path>,
        listen_port: u16,
    ) -> Self {
        Self {
            #[cfg(test)]
            mdns_fixture: None,
            peer_id: peer_id.into(),
            display_name: display_name.into(),
            registry_dir: registry_dir.as_ref().to_path_buf(),
            listen_port,
            daemon_dir: None,
            db_path: None,
            kanna_server_port: None,
            discovery_mode: DiscoveryMode::Registry,
            pending_transfer_ttl: DEFAULT_PENDING_TRANSFER_TTL,
            authenticated_request_freshness: DEFAULT_AUTHENTICATED_REQUEST_FRESHNESS,
            peer_request_timeout: Duration::from_secs(15),
            finalization_request_timeout: DEFAULT_FINALIZATION_REQUEST_TIMEOUT,
            receipt_retry_interval: DEFAULT_RECEIPT_RETRY_INTERVAL,
            applied_receipt_ttl: DEFAULT_APPLIED_RECEIPT_TTL,
            max_unapplied_receipts: DEFAULT_MAX_UNAPPLIED_RECEIPTS,
            max_applied_receipts: DEFAULT_MAX_APPLIED_RECEIPTS,
            max_incoming_reservations: DEFAULT_MAX_INCOMING_RESERVATIONS,
            max_incoming_connections: DEFAULT_MAX_INCOMING_CONNECTIONS,
            max_lifecycle_events: DEFAULT_MAX_LIFECYCLE_EVENTS,
            max_task_pull_requests: DEFAULT_MAX_TASK_PULL_REQUESTS,
            max_finalization_waiters: DEFAULT_MAX_FINALIZATION_WAITERS,
            max_peer_response_bytes: DEFAULT_MAX_PEER_RESPONSE_BYTES,
            max_artifact_response_bytes: DEFAULT_MAX_ARTIFACT_RESPONSE_BYTES,
            mark_read_timeout: Duration::from_secs(2),
            max_peer_requests: DEFAULT_MAX_PEER_REQUESTS,
            max_mark_read_peer_requests: DEFAULT_MAX_MARK_READ_PEER_REQUESTS,
            max_authenticated_request_replays: DEFAULT_MAX_AUTHENTICATED_REQUEST_REPLAYS,
            terminal_observer_tombstone_ttl: DEFAULT_TERMINAL_OBSERVER_TOMBSTONE_TTL,
            max_terminal_observer_tombstones: DEFAULT_MAX_TERMINAL_OBSERVER_TOMBSTONES,
            peer_discovery_delays: Arc::new(Mutex::new(VecDeque::new())),
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

    pub fn with_finalization_request_timeout(
        mut self,
        finalization_request_timeout: Duration,
    ) -> Self {
        self.finalization_request_timeout = finalization_request_timeout;
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

    pub fn with_max_incoming_reservations(mut self, maximum: usize) -> Self {
        self.max_incoming_reservations = maximum;
        self
    }

    pub fn with_max_incoming_connections(mut self, maximum: usize) -> Self {
        self.max_incoming_connections = maximum.max(1);
        self
    }

    pub fn with_runtime_admission_limits(
        mut self,
        max_lifecycle_events: usize,
        max_task_pull_requests: usize,
        max_finalization_waiters: usize,
    ) -> Self {
        self.max_lifecycle_events = max_lifecycle_events.max(1);
        self.max_task_pull_requests = max_task_pull_requests.max(1);
        self.max_finalization_waiters = max_finalization_waiters.max(1);
        self
    }

    pub fn with_mark_read_timeout(mut self, mark_read_timeout: Duration) -> Self {
        self.mark_read_timeout = mark_read_timeout;
        self
    }

    pub fn with_peer_request_limits(
        mut self,
        max_peer_requests: usize,
        max_mark_read_peer_requests: usize,
    ) -> Self {
        self.max_peer_requests = max_peer_requests.max(1);
        self.max_mark_read_peer_requests = max_mark_read_peer_requests.max(1);
        self
    }

    pub fn with_peer_response_limits(
        mut self,
        max_peer_response_bytes: usize,
        max_artifact_response_bytes: usize,
    ) -> Self {
        self.max_peer_response_bytes = max_peer_response_bytes.max(1);
        self.max_artifact_response_bytes = max_artifact_response_bytes.max(1);
        self
    }

    pub fn with_authenticated_request_replay_limit(mut self, maximum: usize) -> Self {
        self.max_authenticated_request_replays = maximum.max(1);
        self
    }

    pub fn with_terminal_observer_tombstone_policy(
        mut self,
        ttl: Duration,
        maximum: usize,
    ) -> Self {
        self.terminal_observer_tombstone_ttl = ttl;
        self.max_terminal_observer_tombstones = maximum.max(1);
        self
    }

    pub fn with_peer_discovery_delays(self, delays: impl IntoIterator<Item = Duration>) -> Self {
        *self
            .peer_discovery_delays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = delays.into_iter().collect();
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
            .unwrap_or(kanna_runtime_defaults::DEFAULT_TRANSFER_PORT);

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

        let db_path = std::env::var("KANNA_DB_PATH")
            .or_else(|_| std::env::var("KANNA_CLI_DB_PATH"))
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(kanna_runtime_defaults::preferred_desktop_db_path);
        kanna_runtime_defaults::database_access::check(&db_path, cfg!(test))
            .map_err(RuntimeError::InvalidConfig)?;

        Ok(Self {
            #[cfg(test)]
            mdns_fixture: None,
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
            db_path: Some(db_path),
            kanna_server_port: std::env::var("KANNA_MOBILE_SERVER_PORT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.parse::<u16>())
                .transpose()
                .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?,
            discovery_mode,
            pending_transfer_ttl: DEFAULT_PENDING_TRANSFER_TTL,
            authenticated_request_freshness: DEFAULT_AUTHENTICATED_REQUEST_FRESHNESS,
            peer_request_timeout: Duration::from_secs(15),
            finalization_request_timeout: DEFAULT_FINALIZATION_REQUEST_TIMEOUT,
            receipt_retry_interval: DEFAULT_RECEIPT_RETRY_INTERVAL,
            applied_receipt_ttl: DEFAULT_APPLIED_RECEIPT_TTL,
            max_unapplied_receipts: DEFAULT_MAX_UNAPPLIED_RECEIPTS,
            max_applied_receipts: DEFAULT_MAX_APPLIED_RECEIPTS,
            max_incoming_reservations: DEFAULT_MAX_INCOMING_RESERVATIONS,
            max_incoming_connections: DEFAULT_MAX_INCOMING_CONNECTIONS,
            max_lifecycle_events: DEFAULT_MAX_LIFECYCLE_EVENTS,
            max_task_pull_requests: DEFAULT_MAX_TASK_PULL_REQUESTS,
            max_finalization_waiters: DEFAULT_MAX_FINALIZATION_WAITERS,
            max_peer_response_bytes: DEFAULT_MAX_PEER_RESPONSE_BYTES,
            max_artifact_response_bytes: DEFAULT_MAX_ARTIFACT_RESPONSE_BYTES,
            mark_read_timeout: Duration::from_secs(2),
            max_peer_requests: DEFAULT_MAX_PEER_REQUESTS,
            max_mark_read_peer_requests: DEFAULT_MAX_MARK_READ_PEER_REQUESTS,
            max_authenticated_request_replays: DEFAULT_MAX_AUTHENTICATED_REQUEST_REPLAYS,
            terminal_observer_tombstone_ttl: DEFAULT_TERMINAL_OBSERVER_TOMBSTONE_TTL,
            max_terminal_observer_tombstones: DEFAULT_MAX_TERMINAL_OBSERVER_TOMBSTONES,
            peer_discovery_delays: Arc::new(Mutex::new(VecDeque::new())),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A reservation must outlive the finalization the destination is allowed
    /// to wait for.
    ///
    /// The two clocks measure from different moments — the reservation from the
    /// push, the request window from the finalization request — so the
    /// reservation needs the request window *plus* the ordinary request budget
    /// the surrounding round trips spend. When it did not have that, a source
    /// whose agent used its full wrap-up budget had its reservation pruned out
    /// from under the answer, and the destination's import failed with
    /// "missing target peer for outgoing transfer finalization" until it ran
    /// out of attempts. Nothing was slow enough to reach that while
    /// finalization was a 1500 ms `SIGINT`.
    #[test]
    fn reservations_outlive_the_finalization_window() {
        assert!(
            DEFAULT_PENDING_TRANSFER_TTL
                >= DEFAULT_FINALIZATION_REQUEST_TIMEOUT + Duration::from_secs(15),
            "a pending-transfer TTL of {:?} prunes the reservation a finalization of up to {:?} \
             still needs; raise DEFAULT_PENDING_TRANSFER_TTL before lowering it, or lower the \
             source's budget in crates/kanna-server/src/transfer_engine/finalize.rs",
            DEFAULT_PENDING_TRANSFER_TTL,
            DEFAULT_FINALIZATION_REQUEST_TIMEOUT,
        );
    }

    /// …and the replay bound must not follow it up.
    ///
    /// The two were one constant, so the first attempt at the fix above raised
    /// the replay window to 15 minutes as a side effect of letting a busy agent
    /// wrap up. `task_pull_rejects_stale_and_captured_requests_before_renderer_work`
    /// caught it; this states the rule where the constants are.
    #[test]
    fn the_replay_bound_does_not_grow_with_the_resource_ttl() {
        assert!(
            DEFAULT_AUTHENTICATED_REQUEST_FRESHNESS < DEFAULT_PENDING_TRANSFER_TTL,
            "the replay window ({:?}) has been widened to the in-flight resource TTL ({:?}); \
             a sealed request stays replayable for that long",
            DEFAULT_AUTHENTICATED_REQUEST_FRESHNESS,
            DEFAULT_PENDING_TRANSFER_TTL,
        );
    }
}
