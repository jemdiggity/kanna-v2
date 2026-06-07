use crate::crypto::{
    open_json, parse_public_key, public_key_to_string, seal_json, CryptoError, TransferIdentity,
};
use crate::discovery::{
    encode_txt_record, hostname_for_peer, resolved_service_to_peer_entry, SERVICE_TYPE,
};
use crate::peer_store::{PeerRecord, PeerStore, PeerStoreError};
use crate::protocol::{
    DiscoveredPeer, PairingPeer, PeerRegistryEntry, PeerRequest, PeerResponse, PeerTaskSnapshot,
    PeerTerminalEvent,
};
use crate::registry::{PeerRegistry, RegistryError};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

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
    daemon_dir: Option<PathBuf>,
    db_path: Option<PathBuf>,
    kanna_server_port: Option<u16>,
    discovery_mode: DiscoveryMode,
    pending_transfer_ttl: Duration,
    peer_request_timeout: Duration,
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
        })
    }

    fn endpoint(&self) -> String {
        format!("127.0.0.1:{}", self.listen_port)
    }

    fn bind_host(&self) -> &'static str {
        match self.discovery_mode {
            DiscoveryMode::Registry => "127.0.0.1",
            DiscoveryMode::Mdns => "0.0.0.0",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightResult {
    pub transfer_id: String,
    pub source_peer_id: String,
    pub target_has_repo: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FinalizedOutgoingTransfer {
    pub payload: Value,
    pub finalized_cleanly: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingTransferEvent {
    pub transfer_id: String,
    pub source_peer_id: String,
    pub source_task_id: String,
    pub source_name: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingTransferCommittedEvent {
    pub transfer_id: String,
    pub source_task_id: String,
    pub destination_local_task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingTransferFinalizationRequestedEvent {
    pub transfer_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCompletedEvent {
    pub peer_id: String,
    pub display_name: String,
    pub verification_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRequestedEvent {
    pub request_id: String,
    pub peer_id: String,
    pub display_name: String,
    pub verification_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingStartedEvent {
    pub peer_id: String,
    pub display_name: String,
    pub verification_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingResult {
    pub peer: DiscoveredPeer,
    pub verification_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeEvent {
    PairingStarted(PairingStartedEvent),
    PairingRequested(PairingRequestedEvent),
    PairingCompleted(PairingCompletedEvent),
    IncomingTransferRequest(IncomingTransferEvent),
    OutgoingTransferCommitted(OutgoingTransferCommittedEvent),
    OutgoingTransferFinalizationRequested(OutgoingTransferFinalizationRequestedEvent),
    TerminalEvent {
        peer_id: String,
        session_id: String,
        event: PeerTerminalEvent,
    },
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("registry error: {0}")]
    Registry(#[from] RegistryError),
    #[error("peer store error: {0}")]
    PeerStore(#[from] PeerStoreError),
    #[error("crypto error: {0}")]
    Crypto(#[from] CryptoError),
    #[error("invalid runtime config: {0}")]
    InvalidConfig(String),
    #[error("peer not found: {0}")]
    PeerNotFound(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("peer request to {peer_id} timed out after {timeout_ms}ms")]
    PeerRequestTimeout { peer_id: String, timeout_ms: u128 },
    #[error("discovery error: {0}")]
    Discovery(String),
    #[error("incoming event channel closed")]
    IncomingEventChannelClosed,
}

#[derive(Debug, Clone)]
struct IncomingTransferReservation {
    source_peer_id: String,
    source_task_id: String,
    created_at: Instant,
}

#[derive(Debug, Clone)]
struct OutgoingTransferReservation {
    target_peer_id: String,
    created_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedTransferArtifact {
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
struct TransferArtifactRecord {
    path: PathBuf,
    created_at: Instant,
}

type PendingOutgoingTransferFinalizations =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<FinalizedOutgoingTransfer, RuntimeError>>>>>;

type PendingPairingRequests = Arc<Mutex<HashMap<String, PendingPairingRequest>>>;

struct PendingPairingRequest {
    verification_code: String,
    responder: oneshot::Sender<PairingDecision>,
}

enum PairingDecision {
    Accepted,
    Rejected,
}

#[derive(Clone)]
struct ListenerContext {
    self_peer_id: String,
    self_display_name: String,
    self_public_key: String,
    registry_root: PathBuf,
    discovery: PeerDiscovery,
    pending_transfer_ttl: Duration,
    peer_request_timeout: Duration,
    pending_pairing_requests: PendingPairingRequests,
    outgoing_transfers: Arc<Mutex<HashMap<String, OutgoingTransferReservation>>>,
    pending_outgoing_transfer_finalizations: PendingOutgoingTransferFinalizations,
    incoming_reservations: Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
    transfer_artifacts: Arc<Mutex<HashMap<String, HashMap<String, TransferArtifactRecord>>>>,
    task_snapshot: Arc<Mutex<Value>>,
    daemon_dir: Option<PathBuf>,
    db_path: Option<PathBuf>,
    kanna_server_port: Option<u16>,
    request_counter: Arc<AtomicU64>,
    incoming_sender: mpsc::UnboundedSender<RuntimeEvent>,
}

pub struct TransferRuntime {
    config: RuntimeConfig,
    discovery: PeerDiscovery,
    identity: TransferIdentity,
    pending_pairing_requests: PendingPairingRequests,
    outgoing_transfers: Arc<Mutex<HashMap<String, OutgoingTransferReservation>>>,
    pending_outgoing_transfer_finalizations: PendingOutgoingTransferFinalizations,
    incoming_reservations: Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
    transfer_artifacts: Arc<Mutex<HashMap<String, HashMap<String, TransferArtifactRecord>>>>,
    task_snapshot: Arc<Mutex<Value>>,
    terminal_observers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    incoming_sender: mpsc::UnboundedSender<RuntimeEvent>,
    incoming_events: Mutex<mpsc::UnboundedReceiver<RuntimeEvent>>,
    request_counter: Arc<AtomicU64>,
    listener_task: JoinHandle<()>,
    registry_entry_path: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredIdentity {
    secret_key: String,
}

#[derive(Clone)]
enum PeerDiscovery {
    Registry(PeerRegistry),
    Mdns(Arc<MdnsDiscovery>),
}

#[derive(Default)]
struct MdnsState {
    peers_by_id: HashMap<String, PeerRegistryEntry>,
    peer_ids_by_fullname: HashMap<String, String>,
}

struct MdnsDiscovery {
    daemon: ServiceDaemon,
    state: Arc<Mutex<MdnsState>>,
    browse_task: JoinHandle<()>,
    service_fullname: String,
}

impl PeerDiscovery {
    async fn list_peers(&self, self_peer_id: &str) -> Result<Vec<PeerRegistryEntry>, RuntimeError> {
        match self {
            Self::Registry(registry) => Ok(registry.list_peers(self_peer_id)?),
            Self::Mdns(discovery) => discovery.list_peers(self_peer_id).await,
        }
    }

    fn shutdown(&self) {
        if let Self::Mdns(discovery) = self {
            discovery.shutdown();
        }
    }
}

impl MdnsDiscovery {
    async fn spawn(
        peer_id: &str,
        display_name: &str,
        public_key: &str,
        listen_port: u16,
    ) -> Result<Self, RuntimeError> {
        let daemon =
            ServiceDaemon::new().map_err(|error| RuntimeError::Discovery(error.to_string()))?;
        let txt = encode_txt_record(peer_id, display_name, public_key, 1, true)
            .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;
        let properties = txt
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        let hostname = hostname_for_peer(peer_id)
            .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;
        let service_info = ServiceInfo::new(
            SERVICE_TYPE,
            peer_id,
            &hostname,
            "",
            listen_port,
            &properties[..],
        )
        .map_err(|error| RuntimeError::Discovery(error.to_string()))?
        .enable_addr_auto();
        let service_fullname = service_info.get_fullname().to_string();
        daemon
            .register(service_info)
            .map_err(|error| RuntimeError::Discovery(error.to_string()))?;

        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|error| RuntimeError::Discovery(error.to_string()))?;
        let state = Arc::new(Mutex::new(MdnsState::default()));
        let browse_state = Arc::clone(&state);
        let browse_task = tokio::spawn(async move {
            while let Ok(event) = receiver.recv_async().await {
                handle_mdns_event(&browse_state, event).await;
            }
        });

        Ok(Self {
            daemon,
            state,
            browse_task,
            service_fullname,
        })
    }

    async fn list_peers(&self, self_peer_id: &str) -> Result<Vec<PeerRegistryEntry>, RuntimeError> {
        let state = self.state.lock().await;
        let mut peers = state
            .peers_by_id
            .values()
            .filter(|peer| peer.peer_id != self_peer_id)
            .cloned()
            .collect::<Vec<_>>();
        peers.sort_by(|left, right| left.peer_id.cmp(&right.peer_id));
        Ok(peers)
    }

    fn shutdown(&self) {
        self.browse_task.abort();
        let _ = self.daemon.unregister(&self.service_fullname);
        let _ = self.daemon.shutdown();
    }
}

impl TransferRuntime {
    pub async fn spawn(mut config: RuntimeConfig) -> Result<Self, RuntimeError> {
        let listener = TcpListener::bind((config.bind_host(), config.listen_port)).await?;
        config.listen_port = listener.local_addr()?.port();
        let identity = load_or_create_identity(&config.registry_dir, &config.peer_id)?;
        let public_key = public_key_to_string(&identity.public_key);
        let _ = encode_txt_record(&config.peer_id, &config.display_name, &public_key, 1, true)
            .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;

        let (discovery, registry_entry_path) = match config.discovery_mode {
            DiscoveryMode::Registry => {
                let registry = PeerRegistry::new(config.registry_dir.clone());
                let registry_entry = PeerRegistryEntry {
                    peer_id: config.peer_id.clone(),
                    display_name: config.display_name.clone(),
                    endpoint: config.endpoint(),
                    pid: process::id(),
                    public_key: public_key.clone(),
                    protocol_version: 1,
                    accepting_transfers: true,
                };
                registry.write_entry(&registry_entry)?;
                (
                    PeerDiscovery::Registry(registry),
                    Some(registry_entry_path(&config.registry_dir, &config.peer_id)),
                )
            }
            DiscoveryMode::Mdns => (
                PeerDiscovery::Mdns(Arc::new(
                    MdnsDiscovery::spawn(
                        &config.peer_id,
                        &config.display_name,
                        &public_key,
                        config.listen_port,
                    )
                    .await?,
                )),
                None,
            ),
        };
        let (incoming_sender, incoming_receiver) = mpsc::unbounded_channel();
        let pending_pairing_requests = Arc::new(Mutex::new(HashMap::new()));
        let outgoing_transfers = Arc::new(Mutex::new(HashMap::new()));
        let pending_outgoing_transfer_finalizations = Arc::new(Mutex::new(HashMap::new()));
        let incoming_reservations = Arc::new(Mutex::new(HashMap::new()));
        let transfer_artifacts = Arc::new(Mutex::new(HashMap::new()));
        let task_snapshot = Arc::new(Mutex::new(Value::Null));
        let terminal_observers = Arc::new(Mutex::new(HashMap::new()));
        let request_counter = Arc::new(AtomicU64::new(1));
        let listener_context = ListenerContext {
            self_peer_id: config.peer_id.clone(),
            self_display_name: config.display_name.clone(),
            self_public_key: public_key,
            registry_root: config.registry_dir.clone(),
            discovery: discovery.clone(),
            pending_transfer_ttl: config.pending_transfer_ttl,
            peer_request_timeout: config.peer_request_timeout,
            pending_pairing_requests: Arc::clone(&pending_pairing_requests),
            outgoing_transfers: Arc::clone(&outgoing_transfers),
            pending_outgoing_transfer_finalizations: Arc::clone(
                &pending_outgoing_transfer_finalizations,
            ),
            incoming_reservations: Arc::clone(&incoming_reservations),
            transfer_artifacts: Arc::clone(&transfer_artifacts),
            task_snapshot: Arc::clone(&task_snapshot),
            daemon_dir: config.daemon_dir.clone(),
            db_path: config.db_path.clone(),
            kanna_server_port: config.kanna_server_port,
            request_counter: Arc::clone(&request_counter),
            incoming_sender: incoming_sender.clone(),
        };
        let listener_task = tokio::spawn(run_listener(listener, listener_context));

        Ok(Self {
            config,
            discovery,
            identity,
            pending_pairing_requests,
            outgoing_transfers,
            pending_outgoing_transfer_finalizations,
            incoming_reservations,
            transfer_artifacts,
            task_snapshot,
            terminal_observers,
            incoming_sender,
            incoming_events: Mutex::new(incoming_receiver),
            request_counter,
            listener_task,
            registry_entry_path,
        })
    }

    pub async fn list_peers(&self) -> Result<Vec<DiscoveredPeer>, RuntimeError> {
        self.discovery
            .list_peers(&self.config.peer_id)
            .await?
            .into_iter()
            .map(|peer| self.discovered_peer(peer))
            .collect()
    }

    pub async fn set_task_snapshot(&self, snapshot: Value) -> Result<(), RuntimeError> {
        *self.task_snapshot.lock().await = snapshot;
        Ok(())
    }

    pub async fn list_peer_task_snapshots(&self) -> Result<Vec<PeerTaskSnapshot>, RuntimeError> {
        let peers = self.list_peers().await?;
        let mut snapshots = Vec::new();
        for peer in peers.into_iter().filter(|peer| peer.trusted) {
            let request_id = self.next_request_id("task-snapshot");
            let response = match self
                .send_peer_request(
                    &PeerRegistryEntry {
                        peer_id: peer.peer_id.clone(),
                        display_name: peer.display_name.clone(),
                        endpoint: peer.endpoint.clone(),
                        pid: peer.pid,
                        public_key: peer.public_key.clone(),
                        protocol_version: peer.protocol_version,
                        accepting_transfers: peer.accepting_transfers,
                    },
                    PeerRequest::GetTaskSnapshot {
                        request_id: request_id.clone(),
                        requester_peer_id: self.config.peer_id.clone(),
                    },
                )
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    eprintln!(
                        "[task-transfer] failed to fetch task snapshot from {}: {}",
                        peer.peer_id, error
                    );
                    continue;
                }
            };

            match response {
                PeerResponse::TaskSnapshot {
                    request_id: response_request_id,
                    peer_id,
                    display_name,
                    snapshot,
                } => {
                    if response_request_id == request_id {
                        snapshots.push(PeerTaskSnapshot {
                            peer_id,
                            display_name,
                            snapshot,
                        });
                    }
                }
                PeerResponse::Error { message, .. } => {
                    eprintln!(
                        "[task-transfer] peer {} rejected task snapshot request: {}",
                        peer.peer_id, message
                    );
                }
                other => {
                    return Err(unexpected_peer_response("task snapshot", &other));
                }
            }
        }
        Ok(snapshots)
    }

    pub async fn observe_peer_session(
        &self,
        target_peer_id: &str,
        session_id: &str,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        if let Some(handle) = self.terminal_observers.lock().await.remove(&observer_key) {
            handle.abort();
        }

        let request_id = self.next_request_id("observe-session");
        let self_peer_id = self.config.peer_id.clone();
        let session_id = session_id.to_owned();
        let incoming_sender = self.incoming_sender.clone();
        let peer_for_task = target_peer.clone();
        let peer_id_for_error = target_peer.peer_id.clone();
        let session_id_for_error = session_id.clone();
        let handle = tokio::spawn(async move {
            if let Err(error) = stream_peer_session(
                peer_for_task,
                request_id,
                self_peer_id,
                session_id.clone(),
                incoming_sender.clone(),
            )
            .await
            {
                let _ = incoming_sender.send(RuntimeEvent::TerminalEvent {
                    peer_id: peer_id_for_error,
                    session_id: session_id_for_error.clone(),
                    event: PeerTerminalEvent::Error {
                        session_id: session_id_for_error,
                        message: error.to_string(),
                    },
                });
            }
        });
        self.terminal_observers
            .lock()
            .await
            .insert(observer_key, handle);
        Ok(())
    }

    pub async fn unobserve_peer_session(
        &self,
        target_peer_id: &str,
        session_id: &str,
    ) -> Result<(), RuntimeError> {
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        if let Some(handle) = self.terminal_observers.lock().await.remove(&observer_key) {
            handle.abort();
        }
        Ok(())
    }

    pub async fn send_peer_session_input(
        &self,
        target_peer_id: &str,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("send-input");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::SendSessionInput {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    session_id: session_id.to_owned(),
                    data,
                },
            )
            .await?;
        match response {
            PeerResponse::SendSessionInput {
                request_id: response_request_id,
            } if response_request_id == request_id => Ok(()),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("send-session-input", &other)),
        }
    }

    pub async fn resize_peer_session(
        &self,
        target_peer_id: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("resize-session");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::ResizeSession {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    session_id: session_id.to_owned(),
                    cols,
                    rows,
                },
            )
            .await?;
        match response {
            PeerResponse::ResizeSession {
                request_id: response_request_id,
            } if response_request_id == request_id => Ok(()),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("resize-session", &other)),
        }
    }

    pub async fn close_peer_task(
        &self,
        target_peer_id: &str,
        task_id: &str,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("close-task");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::CloseTask {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                },
            )
            .await?;
        match response {
            PeerResponse::CloseTask {
                request_id: response_request_id,
            } if response_request_id == request_id => Ok(()),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("close-task", &other)),
        }
    }

    pub async fn advance_peer_task_stage(
        &self,
        target_peer_id: &str,
        task_id: &str,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("advance-stage");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::AdvanceTaskStage {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                },
            )
            .await?;
        match response {
            PeerResponse::AdvanceTaskStage {
                request_id: response_request_id,
            } if response_request_id == request_id => Ok(()),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("advance-stage", &other)),
        }
    }

    pub async fn start_pairing(&self, target_peer_id: &str) -> Result<PairingResult, RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        let request_id = self.next_request_id("pair");
        let expected_verification_code = pairing_verification_code(
            &self.config.peer_id,
            &public_key_to_string(&self.identity.public_key),
            &target_peer.peer_id,
            &target_peer.public_key,
        );
        self.incoming_sender
            .send(RuntimeEvent::PairingStarted(PairingStartedEvent {
                peer_id: target_peer.peer_id.clone(),
                display_name: target_peer.display_name.clone(),
                verification_code: expected_verification_code.clone(),
            }))
            .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::StartPairing {
                    request_id: request_id.clone(),
                    source_peer_id: self.config.peer_id.clone(),
                    source_display_name: self.config.display_name.clone(),
                    source_public_key: public_key_to_string(&self.identity.public_key),
                    capabilities_json: local_capabilities_json(),
                },
            )
            .await?;

        match response {
            PeerResponse::StartPairing {
                request_id: response_request_id,
                peer,
                verification_code,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in pairing response: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }

                if peer.peer_id != target_peer.peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched peer id in pairing response: expected {}, got {}",
                        target_peer.peer_id, peer.peer_id
                    )));
                }

                if verification_code != expected_verification_code {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched verification code in pairing response: expected {}, got {}",
                        expected_verification_code, verification_code
                    )));
                }

                self.upsert_trusted_peer(PeerRecord {
                    peer_id: peer.peer_id,
                    display_name: peer.display_name,
                    public_key: peer.public_key,
                    capabilities_json: peer.capabilities_json,
                    paired_at: Utc::now().to_rfc3339(),
                    last_seen_at: Some(Utc::now().to_rfc3339()),
                    revoked_at: None,
                })?;

                Ok(PairingResult {
                    peer: self.discovered_peer(target_peer)?,
                    verification_code,
                })
            }
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("pairing", &other)),
        }
    }

    pub async fn accept_pairing(
        &self,
        request_id: &str,
        verification_code: &str,
    ) -> Result<(), RuntimeError> {
        let mut pending = self.pending_pairing_requests.lock().await;
        let Some(request) = pending.get(request_id) else {
            return Err(RuntimeError::Protocol(format!(
                "pairing request {} is not pending",
                request_id
            )));
        };
        if request.verification_code != verification_code {
            return Err(RuntimeError::Protocol(format!(
                "pairing request {} verification code did not match",
                request_id
            )));
        }

        let request = pending.remove(request_id).ok_or_else(|| {
            RuntimeError::Protocol(format!("pairing request {} is not pending", request_id))
        })?;
        request
            .responder
            .send(PairingDecision::Accepted)
            .map_err(|_| {
                RuntimeError::Protocol(format!(
                    "pairing request {} is no longer waiting",
                    request_id
                ))
            })
    }

    pub async fn reject_pairing(&self, request_id: &str) -> Result<(), RuntimeError> {
        let mut pending = self.pending_pairing_requests.lock().await;
        let request = pending.remove(request_id).ok_or_else(|| {
            RuntimeError::Protocol(format!("pairing request {} is not pending", request_id))
        })?;
        request
            .responder
            .send(PairingDecision::Rejected)
            .map_err(|_| {
                RuntimeError::Protocol(format!(
                    "pairing request {} is no longer waiting",
                    request_id
                ))
            })
    }

    pub async fn prepare_transfer_preflight(
        &self,
        target_peer_id: &str,
        source_task_id: &str,
    ) -> Result<PreflightResult, RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let target_public_key = parse_public_key(&target_peer.public_key)?;
        let sealed_payload = seal_json(
            &self.identity,
            &target_public_key,
            &serde_json::json!({
                "source_task_id": source_task_id,
            }),
        )?;
        let request_id = self.next_request_id("preflight");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::PrepareTransfer {
                    request_id: request_id.clone(),
                    source_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
            )
            .await?;

        match response {
            PeerResponse::PrepareTransfer {
                request_id: response_request_id,
                transfer_id,
                source_peer_id,
                target_has_repo,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in preflight response: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }

                let mut transfers = self.outgoing_transfers.lock().await;
                prune_outgoing_transfers(&mut transfers, self.config.pending_transfer_ttl);
                transfers.insert(
                    transfer_id.clone(),
                    OutgoingTransferReservation {
                        target_peer_id: target_peer_id.to_owned(),
                        created_at: Instant::now(),
                    },
                );

                Ok(PreflightResult {
                    transfer_id,
                    source_peer_id,
                    target_has_repo,
                })
            }
            PeerResponse::StartPairing { .. } => Err(RuntimeError::Protocol(
                "unexpected pairing response during preflight".into(),
            )),
            PeerResponse::SubmitTransferPayload { .. } => Err(RuntimeError::Protocol(
                "unexpected submit-transfer response during preflight".into(),
            )),
            PeerResponse::FetchTransferArtifact { .. } => Err(RuntimeError::Protocol(
                "unexpected fetch-transfer-artifact response during preflight".into(),
            )),
            PeerResponse::ImportCommitted { .. } => Err(RuntimeError::Protocol(
                "unexpected import-committed response during preflight".into(),
            )),
            PeerResponse::FinalizeTransfer { .. } => Err(RuntimeError::Protocol(
                "unexpected finalize response during preflight".into(),
            )),
            PeerResponse::TaskSnapshot { .. } => Err(RuntimeError::Protocol(
                "unexpected task-snapshot response during preflight".into(),
            )),
            PeerResponse::ObserveSession { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. } => Err(RuntimeError::Protocol(
                "unexpected observe-session response during preflight".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }

    pub async fn prepare_transfer_commit(
        &self,
        transfer_id: &str,
        payload: Value,
    ) -> Result<(), RuntimeError> {
        let target_peer_id = {
            let mut transfers = self.outgoing_transfers.lock().await;
            prune_outgoing_transfers(&mut transfers, self.config.pending_transfer_ttl);
            transfers
                .get(transfer_id)
                .map(|reservation| reservation.target_peer_id.clone())
        }
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing target peer for transfer commit {}",
                transfer_id
            ))
        })?;

        let target_peer = self.find_peer(&target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let target_public_key = parse_public_key(&target_peer.public_key)?;
        let sealed_payload = seal_json(&self.identity, &target_public_key, &payload)?;
        let request_id = self.next_request_id("commit");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::SubmitTransferPayload {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    sealed_payload,
                },
            )
            .await?;

        match response {
            PeerResponse::SubmitTransferPayload {
                request_id: response_request_id,
                transfer_id: response_transfer_id,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in commit response: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }

                if response_transfer_id != transfer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched transfer id in commit response: expected {}, got {}",
                        transfer_id, response_transfer_id
                    )));
                }

                Ok(())
            }
            PeerResponse::StartPairing { .. } => Err(RuntimeError::Protocol(
                "unexpected pairing response during transfer commit".into(),
            )),
            PeerResponse::PrepareTransfer { .. } => Err(RuntimeError::Protocol(
                "unexpected preflight response during transfer commit".into(),
            )),
            PeerResponse::FetchTransferArtifact { .. } => Err(RuntimeError::Protocol(
                "unexpected fetch-transfer-artifact response during transfer commit".into(),
            )),
            PeerResponse::ImportCommitted { .. } => Err(RuntimeError::Protocol(
                "unexpected import-committed response during transfer commit".into(),
            )),
            PeerResponse::FinalizeTransfer { .. } => Err(RuntimeError::Protocol(
                "unexpected finalize response during transfer commit".into(),
            )),
            PeerResponse::TaskSnapshot { .. } => Err(RuntimeError::Protocol(
                "unexpected task-snapshot response during transfer commit".into(),
            )),
            PeerResponse::ObserveSession { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. } => Err(RuntimeError::Protocol(
                "unexpected observe-session response during transfer commit".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }

    pub async fn finalize_outgoing_transfer(
        &self,
        transfer_id: &str,
    ) -> Result<FinalizedOutgoingTransfer, RuntimeError> {
        let source_peer_id = {
            let mut reservations = self.incoming_reservations.lock().await;
            prune_incoming_reservations(&mut reservations, self.config.pending_transfer_ttl);
            reservations
                .get(transfer_id)
                .map(|reservation| reservation.source_peer_id.clone())
        }
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing source peer for outgoing transfer finalization {}",
                transfer_id
            ))
        })?;

        let source_peer = self.find_peer(&source_peer_id).await?;
        self.ensure_peer_is_trusted(&source_peer.peer_id, &source_peer.public_key)?;
        let source_public_key = parse_public_key(&source_peer.public_key)?;
        let request_id = self.next_request_id("finalize");
        let response = self
            .send_peer_request(
                &source_peer,
                PeerRequest::FinalizeTransfer {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    requester_peer_id: self.config.peer_id.clone(),
                },
            )
            .await?;

        match response {
            PeerResponse::FinalizeTransfer {
                request_id: response_request_id,
                transfer_id: response_transfer_id,
                sealed_payload,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in finalize response: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }
                if response_transfer_id != transfer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched transfer id in finalize response: expected {}, got {}",
                        transfer_id, response_transfer_id
                    )));
                }
                let payload = open_json(&self.identity, &source_public_key, &sealed_payload)?;
                let finalized_payload = payload.get("payload").cloned().ok_or_else(|| {
                    RuntimeError::Protocol("finalize response missing payload".into())
                })?;
                let finalized_cleanly = payload
                    .get("finalized_cleanly")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                    RuntimeError::Protocol("finalize response missing finalized_cleanly".into())
                })?;
                Ok(FinalizedOutgoingTransfer {
                    payload: finalized_payload,
                    finalized_cleanly,
                })
            }
            PeerResponse::StartPairing { .. }
            | PeerResponse::PrepareTransfer { .. }
            | PeerResponse::SubmitTransferPayload { .. }
            | PeerResponse::FetchTransferArtifact { .. }
            | PeerResponse::ImportCommitted { .. }
            | PeerResponse::TaskSnapshot { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. } => Err(RuntimeError::Protocol(
                "unexpected response while finalizing outgoing transfer".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }

    pub async fn complete_outgoing_transfer_finalization(
        &self,
        transfer_id: &str,
        result: Result<FinalizedOutgoingTransfer, RuntimeError>,
    ) -> Result<(), RuntimeError> {
        let sender = self
            .pending_outgoing_transfer_finalizations
            .lock()
            .await
            .remove(transfer_id)
            .ok_or_else(|| {
                RuntimeError::Protocol(format!(
                    "missing pending outgoing transfer finalization {}",
                    transfer_id
                ))
            })?;
        sender.send(result).map_err(|_| {
            RuntimeError::Protocol(format!(
                "finalization receiver dropped for transfer {}",
                transfer_id
            ))
        })
    }

    pub async fn next_event(&self) -> Result<RuntimeEvent, RuntimeError> {
        let mut receiver = self.incoming_events.lock().await;
        receiver
            .recv()
            .await
            .ok_or(RuntimeError::IncomingEventChannelClosed)
    }

    pub async fn stage_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
        path: PathBuf,
    ) -> Result<(), RuntimeError> {
        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        transfer_artifacts
            .entry(transfer_id.to_owned())
            .or_default()
            .insert(
                artifact_id.to_owned(),
                TransferArtifactRecord {
                    path,
                    created_at: Instant::now(),
                },
            );
        Ok(())
    }

    pub async fn fetch_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
    ) -> Result<StagedTransferArtifact, RuntimeError> {
        if let Some(path) = self
            .lookup_transfer_artifact(transfer_id, artifact_id)
            .await
        {
            return Ok(StagedTransferArtifact { path });
        }

        let source_peer_id = {
            let mut reservations = self.incoming_reservations.lock().await;
            prune_incoming_reservations(&mut reservations, self.config.pending_transfer_ttl);
            reservations
                .get(transfer_id)
                .map(|reservation| reservation.source_peer_id.clone())
        }
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing source peer for transfer artifact {} on transfer {}",
                artifact_id, transfer_id
            ))
        })?;

        let source_peer = self.find_peer(&source_peer_id).await?;
        self.ensure_peer_is_trusted(&source_peer.peer_id, &source_peer.public_key)?;
        let source_public_key = parse_public_key(&source_peer.public_key)?;
        let sealed_payload = seal_json(
            &self.identity,
            &source_public_key,
            &serde_json::json!({
                "artifact_id": artifact_id,
            }),
        )?;
        let request_id = self.next_request_id("fetch-artifact");
        let response = self
            .send_peer_request(
                &source_peer,
                PeerRequest::FetchTransferArtifact {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
            )
            .await?;

        match response {
            PeerResponse::FetchTransferArtifact {
                request_id: response_request_id,
                transfer_id: response_transfer_id,
                sealed_payload,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in artifact fetch response: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }
                if response_transfer_id != transfer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched transfer id in artifact fetch response: expected {}, got {}",
                        transfer_id, response_transfer_id
                    )));
                }
                let payload = open_json(&self.identity, &source_public_key, &sealed_payload)?;
                let response_artifact_id = payload
                    .get("artifact_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol("artifact fetch response missing artifact_id".into())
                    })?;
                if response_artifact_id != artifact_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched artifact id in artifact fetch response: expected {}, got {}",
                        artifact_id, response_artifact_id
                    )));
                }
                let filename =
                    payload
                        .get("filename")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            RuntimeError::Protocol(
                                "artifact fetch response missing filename".into(),
                            )
                        })?;
                let payload_b64 = payload
                    .get("payload_b64")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol("artifact fetch response missing payload_b64".into())
                    })?;

                let path = self
                    .materialize_transfer_artifact(transfer_id, artifact_id, filename, payload_b64)
                    .await?;
                Ok(StagedTransferArtifact { path })
            }
            PeerResponse::StartPairing { .. }
            | PeerResponse::PrepareTransfer { .. }
            | PeerResponse::SubmitTransferPayload { .. }
            | PeerResponse::ImportCommitted { .. }
            | PeerResponse::FinalizeTransfer { .. }
            | PeerResponse::TaskSnapshot { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. } => Err(RuntimeError::Protocol(
                "unexpected response while fetching transfer artifact".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }

    pub async fn acknowledge_import_committed(
        &self,
        transfer_id: &str,
        source_task_id: &str,
        destination_local_task_id: &str,
    ) -> Result<(), RuntimeError> {
        let source_peer_id = {
            let mut reservations = self.incoming_reservations.lock().await;
            prune_incoming_reservations(&mut reservations, self.config.pending_transfer_ttl);
            reservations
                .get(transfer_id)
                .map(|reservation| reservation.source_peer_id.clone())
        }
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing source peer for import acknowledgment {}",
                transfer_id
            ))
        })?;

        let source_peer = self.find_peer(&source_peer_id).await?;
        self.ensure_peer_is_trusted(&source_peer.peer_id, &source_peer.public_key)?;
        let source_public_key = parse_public_key(&source_peer.public_key)?;
        let sealed_payload = seal_json(
            &self.identity,
            &source_public_key,
            &serde_json::json!({
                "source_task_id": source_task_id,
                "destination_local_task_id": destination_local_task_id,
            }),
        )?;
        let request_id = self.next_request_id("import-committed");
        let response = self
            .send_peer_request(
                &source_peer,
                PeerRequest::ImportCommitted {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
            )
            .await?;

        match response {
            PeerResponse::ImportCommitted {
                request_id: response_request_id,
                transfer_id: response_transfer_id,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in import commit acknowledgment: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }

                if response_transfer_id != transfer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched transfer id in import commit acknowledgment: expected {}, got {}",
                        transfer_id, response_transfer_id
                    )));
                }

                self.incoming_reservations.lock().await.remove(transfer_id);
                Ok(())
            }
            PeerResponse::StartPairing { .. }
            | PeerResponse::PrepareTransfer { .. }
            | PeerResponse::SubmitTransferPayload { .. }
            | PeerResponse::FetchTransferArtifact { .. }
            | PeerResponse::FinalizeTransfer { .. }
            | PeerResponse::TaskSnapshot { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. } => Err(RuntimeError::Protocol(
                "unexpected response while acknowledging import commit".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }

    async fn find_peer(&self, target_peer_id: &str) -> Result<PeerRegistryEntry, RuntimeError> {
        let peers = self.discovery.list_peers(&self.config.peer_id).await?;
        peers
            .into_iter()
            .find(|peer| peer.peer_id == target_peer_id)
            .ok_or_else(|| RuntimeError::PeerNotFound(target_peer_id.to_owned()))
    }

    fn discovered_peer(&self, peer: PeerRegistryEntry) -> Result<DiscoveredPeer, RuntimeError> {
        let trusted = self
            .trusted_peer_record(&peer.peer_id)?
            .map(|record| record.public_key == peer.public_key)
            .unwrap_or(false);

        Ok(DiscoveredPeer {
            peer_id: peer.peer_id,
            display_name: peer.display_name,
            endpoint: peer.endpoint,
            pid: peer.pid,
            public_key: peer.public_key,
            protocol_version: peer.protocol_version,
            accepting_transfers: peer.accepting_transfers,
            trusted,
        })
    }

    fn trusted_peer_record(&self, peer_id: &str) -> Result<Option<PeerRecord>, RuntimeError> {
        Ok(peer_store(&self.config.registry_dir, &self.config.peer_id)?
            .list_active()?
            .into_iter()
            .find(|record| record.peer_id == peer_id))
    }

    fn upsert_trusted_peer(&self, record: PeerRecord) -> Result<(), RuntimeError> {
        peer_store(&self.config.registry_dir, &self.config.peer_id)?.upsert(record)?;
        Ok(())
    }

    fn ensure_peer_is_trusted(
        &self,
        peer_id: &str,
        observed_public_key: &str,
    ) -> Result<(), RuntimeError> {
        ensure_peer_is_trusted_for(
            &self.config.registry_dir,
            &self.config.peer_id,
            peer_id,
            observed_public_key,
        )
    }

    async fn send_peer_request(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
    ) -> Result<PeerResponse, RuntimeError> {
        let request_timeout = self.config.peer_request_timeout;
        let response = tokio::time::timeout(request_timeout, async {
            let mut stream = TcpStream::connect(&peer.endpoint).await?;
            write_json_line(&mut stream, &request).await?;

            let mut response_line = String::new();
            let mut reader = BufReader::new(stream);
            let read = reader.read_line(&mut response_line).await?;
            if read == 0 {
                return Err(RuntimeError::Protocol(format!(
                    "peer {} closed the connection without a response",
                    peer.peer_id
                )));
            }

            parse_peer_response_line(&peer.peer_id, "peer request", &response_line)
        })
        .await
        .map_err(|_| RuntimeError::PeerRequestTimeout {
            peer_id: peer.peer_id.clone(),
            timeout_ms: request_timeout.as_millis(),
        })??;
        Ok(response)
    }

    fn next_request_id(&self, prefix: &str) -> String {
        format!(
            "{}-{}-{}",
            prefix,
            self.config.peer_id,
            self.request_counter.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn lookup_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
    ) -> Option<PathBuf> {
        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        transfer_artifacts
            .get(transfer_id)
            .and_then(|artifacts| artifacts.get(artifact_id))
            .map(|artifact| artifact.path.clone())
    }

    async fn materialize_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
        filename: &str,
        payload_b64: &str,
    ) -> Result<PathBuf, RuntimeError> {
        let artifact_dir = self.config.registry_dir.join("artifacts").join(transfer_id);
        std::fs::create_dir_all(&artifact_dir)?;

        let destination_path = artifact_dir.join(format!(
            "{}-{}",
            artifact_id,
            sanitize_artifact_filename(filename)
        ));
        let payload = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|error| {
            RuntimeError::Protocol(format!("invalid artifact payload: {}", error))
        })?;
        std::fs::write(&destination_path, payload)?;

        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        transfer_artifacts
            .entry(transfer_id.to_owned())
            .or_default()
            .insert(
                artifact_id.to_owned(),
                TransferArtifactRecord {
                    path: destination_path.clone(),
                    created_at: Instant::now(),
                },
            );

        Ok(destination_path)
    }
}

impl Drop for TransferRuntime {
    fn drop(&mut self) {
        self.listener_task.abort();
        self.discovery.shutdown();
        if let Some(registry_entry_path) = &self.registry_entry_path {
            let _ = std::fs::remove_file(registry_entry_path);
        }
        if let Ok(mut reservations) = self.incoming_reservations.try_lock() {
            reservations.clear();
        }
        if let Ok(mut pending) = self.pending_pairing_requests.try_lock() {
            pending.clear();
        }
        if let Ok(mut pending) = self.pending_outgoing_transfer_finalizations.try_lock() {
            pending.clear();
        }
        if let Ok(mut transfer_artifacts) = self.transfer_artifacts.try_lock() {
            transfer_artifacts.clear();
        }
        if let Ok(mut task_snapshot) = self.task_snapshot.try_lock() {
            *task_snapshot = Value::Null;
        }
        if let Ok(mut observers) = self.terminal_observers.try_lock() {
            for (_, handle) in observers.drain() {
                handle.abort();
            }
        }
    }
}

async fn run_listener(listener: TcpListener, context: ListenerContext) {
    loop {
        let accepted = listener.accept().await;
        let (stream, _) = match accepted {
            Ok(accepted) => accepted,
            Err(_) => break,
        };

        let connection_context = context.clone();

        tokio::spawn(async move {
            let _ = handle_connection(stream, connection_context).await;
        });
    }
}

async fn handle_mdns_event(state: &Arc<Mutex<MdnsState>>, event: ServiceEvent) {
    match event {
        ServiceEvent::ServiceResolved(service) => {
            let peer = match resolved_service_to_peer_entry(&service) {
                Ok(peer) => peer,
                Err(_) => return,
            };

            let mut state = state.lock().await;
            if let Some(previous_peer_id) = state
                .peer_ids_by_fullname
                .insert(service.get_fullname().to_owned(), peer.peer_id.clone())
            {
                state.peers_by_id.remove(&previous_peer_id);
            }
            state.peers_by_id.insert(peer.peer_id.clone(), peer);
        }
        ServiceEvent::ServiceRemoved(_, fullname) => {
            let mut state = state.lock().await;
            if let Some(peer_id) = state.peer_ids_by_fullname.remove(&fullname) {
                state.peers_by_id.remove(&peer_id);
            }
        }
        _ => {}
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    context: ListenerContext,
) -> Result<(), RuntimeError> {
    let mut line = String::new();
    let read = {
        let mut reader = BufReader::new(&mut stream);
        reader.read_line(&mut line).await?
    };

    if read == 0 {
        return Ok(());
    }

    let request_id = extract_request_id(&line);
    let response = match serde_json::from_str::<PeerRequest>(line.trim()) {
        Ok(PeerRequest::StartPairing {
            request_id,
            source_peer_id,
            source_display_name,
            source_public_key,
            capabilities_json,
        }) => {
            let verification_code = pairing_verification_code(
                &source_peer_id,
                &source_public_key,
                &context.self_peer_id,
                &context.self_public_key,
            );
            let pairing_request_id = format!(
                "incoming-pair-{}-{}",
                context.self_peer_id,
                context.request_counter.fetch_add(1, Ordering::Relaxed)
            );
            let (approval_sender, approval_receiver) = oneshot::channel();
            context.pending_pairing_requests.lock().await.insert(
                pairing_request_id.clone(),
                PendingPairingRequest {
                    verification_code: verification_code.clone(),
                    responder: approval_sender,
                },
            );
            context
                .incoming_sender
                .send(RuntimeEvent::PairingRequested(PairingRequestedEvent {
                    request_id: pairing_request_id.clone(),
                    peer_id: source_peer_id.clone(),
                    display_name: source_display_name.clone(),
                    verification_code: verification_code.clone(),
                }))
                .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;

            let approved =
                match tokio::time::timeout(context.peer_request_timeout, approval_receiver).await {
                    Ok(Ok(PairingDecision::Accepted)) => true,
                    Ok(Ok(PairingDecision::Rejected)) => false,
                    Ok(Err(_)) => false,
                    Err(_) => {
                        context
                            .pending_pairing_requests
                            .lock()
                            .await
                            .remove(&pairing_request_id);
                        false
                    }
                };
            if !approved {
                PeerResponse::Error {
                    request_id,
                    message: "pairing request was not accepted".into(),
                }
            } else {
                peer_store(&context.registry_root, &context.self_peer_id)?.upsert(PeerRecord {
                    peer_id: source_peer_id.clone(),
                    display_name: source_display_name.clone(),
                    public_key: source_public_key.clone(),
                    capabilities_json,
                    paired_at: Utc::now().to_rfc3339(),
                    last_seen_at: Some(Utc::now().to_rfc3339()),
                    revoked_at: None,
                })?;
                context
                    .incoming_sender
                    .send(RuntimeEvent::PairingCompleted(PairingCompletedEvent {
                        peer_id: source_peer_id,
                        display_name: source_display_name,
                        verification_code: verification_code.clone(),
                    }))
                    .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
                PeerResponse::StartPairing {
                    request_id,
                    peer: PairingPeer {
                        peer_id: context.self_peer_id.clone(),
                        display_name: context.self_display_name.clone(),
                        public_key: context.self_public_key.clone(),
                        capabilities_json: local_capabilities_json(),
                    },
                    verification_code,
                }
            }
        }
        Ok(PeerRequest::PrepareTransfer {
            request_id,
            source_peer_id,
            sealed_payload,
        }) => match async {
            let source_peer = context
                .discovery
                .list_peers(&context.self_peer_id)
                .await?
                .into_iter()
                .find(|peer| peer.peer_id == source_peer_id)
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "source peer {} is not currently discovered",
                        source_peer_id
                    ))
                })?;
            ensure_peer_is_trusted_for(
                &context.registry_root,
                &context.self_peer_id,
                &source_peer_id,
                &source_peer.public_key,
            )?;
            let source_public_key = parse_public_key(&source_peer.public_key)?;
            let identity = load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
            let decrypted_payload = open_json(&identity, &source_public_key, &sealed_payload)?;
            let source_task_id = decrypted_payload
                .get("source_task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RuntimeError::Protocol("prepare-transfer payload missing source_task_id".into())
                })?
                .to_string();
            let mut reservations = context.incoming_reservations.lock().await;
            prune_incoming_reservations(&mut reservations, context.pending_transfer_ttl);
            let transfer_id = format!(
                "{}-transfer-{}",
                context.self_peer_id,
                context.request_counter.fetch_add(1, Ordering::Relaxed)
            );
            reservations.insert(
                transfer_id.clone(),
                IncomingTransferReservation {
                    source_peer_id: source_peer_id.clone(),
                    source_task_id,
                    created_at: Instant::now(),
                },
            );

            Ok::<PeerResponse, RuntimeError>(PeerResponse::PrepareTransfer {
                request_id: request_id.clone(),
                transfer_id,
                source_peer_id,
                target_has_repo: false,
            })
        }
        .await
        {
            Ok(response) => response,
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Ok(PeerRequest::SubmitTransferPayload {
            request_id,
            transfer_id,
            sealed_payload,
        }) => {
            match build_incoming_event(
                &context.self_peer_id,
                &context.registry_root,
                &context.discovery,
                &transfer_id,
                context.pending_transfer_ttl,
                sealed_payload,
                &context.incoming_reservations,
            )
            .await
            {
                Ok(event) => {
                    context
                        .incoming_sender
                        .send(RuntimeEvent::IncomingTransferRequest(event))
                        .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
                    PeerResponse::SubmitTransferPayload {
                        request_id,
                        transfer_id,
                    }
                }
                Err(error) => PeerResponse::Error {
                    request_id,
                    message: error.to_string(),
                },
            }
        }
        Ok(PeerRequest::FinalizeTransfer {
            request_id,
            transfer_id,
            requester_peer_id,
        }) => {
            let transfer_id_for_cleanup = transfer_id.clone();
            match async {
                let expected_target_peer_id = {
                    let mut transfers = context.outgoing_transfers.lock().await;
                    prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl);
                    transfers
                        .get(&transfer_id)
                        .map(|reservation| reservation.target_peer_id.clone())
                }
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "missing target peer for outgoing transfer finalization {}",
                        transfer_id
                    ))
                })?;

                if requester_peer_id != expected_target_peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected outgoing transfer finalization requester {} for transfer {}",
                        requester_peer_id, transfer_id
                    )));
                }

                let requester_peer = context
                    .discovery
                    .list_peers(&context.self_peer_id)
                    .await?
                    .into_iter()
                    .find(|peer| peer.peer_id == requester_peer_id)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(format!(
                            "requester peer {} is not currently discovered",
                            requester_peer_id
                        ))
                    })?;
                ensure_peer_is_trusted_for(
                    &context.registry_root,
                    &context.self_peer_id,
                    &requester_peer_id,
                    &requester_peer.public_key,
                )?;

                let (tx, rx) = oneshot::channel();
                context
                    .pending_outgoing_transfer_finalizations
                    .lock()
                    .await
                    .insert(transfer_id.clone(), tx);
                context
                    .incoming_sender
                    .send(RuntimeEvent::OutgoingTransferFinalizationRequested(
                        OutgoingTransferFinalizationRequestedEvent {
                            transfer_id: transfer_id.clone(),
                        },
                    ))
                    .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;

                let result = match rx.await {
                    Ok(result) => result,
                    Err(_) => Err(RuntimeError::Protocol(format!(
                        "desktop finalization receiver dropped for transfer {}",
                        transfer_id
                    ))),
                };
                let identity =
                    load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
                let requester_public_key = parse_public_key(&requester_peer.public_key)?;
                match result {
                    Ok(finalized) => {
                        let sealed_payload = seal_json(
                            &identity,
                            &requester_public_key,
                            &serde_json::json!({
                                "payload": finalized.payload,
                                "finalized_cleanly": finalized.finalized_cleanly,
                            }),
                        )?;
                        Ok::<PeerResponse, RuntimeError>(PeerResponse::FinalizeTransfer {
                            request_id: request_id.clone(),
                            transfer_id,
                            sealed_payload,
                        })
                    }
                    Err(error) => Err(error),
                }
            }
            .await
            {
                Ok(response) => response,
                Err(error) => {
                    context
                        .pending_outgoing_transfer_finalizations
                        .lock()
                        .await
                        .remove(&transfer_id_for_cleanup);
                    PeerResponse::Error {
                        request_id,
                        message: error.to_string(),
                    }
                }
            }
        }
        Ok(PeerRequest::FetchTransferArtifact {
            request_id,
            transfer_id,
            requester_peer_id,
            sealed_payload,
        }) => {
            match async {
                let expected_target_peer_id = {
                    let mut transfers = context.outgoing_transfers.lock().await;
                    prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl);
                    transfers
                        .get(&transfer_id)
                        .map(|reservation| reservation.target_peer_id.clone())
                }
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "missing target peer for artifact fetch {}",
                        transfer_id
                    ))
                })?;

                if requester_peer_id != expected_target_peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected artifact fetch requester {} for transfer {}",
                        requester_peer_id, transfer_id
                    )));
                }

                let requester_peer = context
                    .discovery
                    .list_peers(&context.self_peer_id)
                    .await?
                    .into_iter()
                    .find(|peer| peer.peer_id == requester_peer_id)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(format!(
                            "requester peer {} is not currently discovered",
                            requester_peer_id
                        ))
                    })?;
                ensure_peer_is_trusted_for(
                    &context.registry_root,
                    &context.self_peer_id,
                    &requester_peer_id,
                    &requester_peer.public_key,
                )?;
                let requester_public_key = parse_public_key(&requester_peer.public_key)?;
                let identity =
                    load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
                let request_payload = open_json(&identity, &requester_public_key, &sealed_payload)?;
                let artifact_id = request_payload
                    .get("artifact_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol("artifact fetch request missing artifact_id".into())
                    })?;

                let mut artifacts = context.transfer_artifacts.lock().await;
                prune_transfer_artifacts(&mut artifacts, context.pending_transfer_ttl);
                match artifacts
                    .get(&transfer_id)
                    .and_then(|artifacts| artifacts.get(artifact_id))
                    .cloned()
                {
                    Some(artifact) => {
                        let filename = artifact
                            .path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("artifact")
                            .to_string();
                        let payload_b64 = URL_SAFE_NO_PAD.encode(std::fs::read(&artifact.path)?);
                        let sealed_payload = seal_json(
                            &identity,
                            &requester_public_key,
                            &serde_json::json!({
                                "artifact_id": artifact_id,
                                "filename": filename,
                                "payload_b64": payload_b64,
                            }),
                        )?;
                        Ok::<PeerResponse, RuntimeError>(PeerResponse::FetchTransferArtifact {
                            request_id: request_id.clone(),
                            transfer_id,
                            sealed_payload,
                        })
                    }
                    None => Err(RuntimeError::Protocol(format!(
                        "missing transfer artifact {} for transfer {}",
                        artifact_id, transfer_id
                    ))),
                }
            }
            .await
            {
                Ok(response) => response,
                Err(error) => PeerResponse::Error {
                    request_id,
                    message: error.to_string(),
                },
            }
        }
        Ok(PeerRequest::ImportCommitted {
            request_id,
            transfer_id,
            requester_peer_id,
            sealed_payload,
        }) => {
            match async {
                let expected_target_peer_id = {
                    let mut transfers = context.outgoing_transfers.lock().await;
                    prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl);
                    transfers
                        .get(&transfer_id)
                        .map(|reservation| reservation.target_peer_id.clone())
                }
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "missing target peer for import acknowledgment {}",
                        transfer_id
                    ))
                })?;

                if requester_peer_id != expected_target_peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected import acknowledgment requester {} for transfer {}",
                        requester_peer_id, transfer_id
                    )));
                }

                let requester_peer = context
                    .discovery
                    .list_peers(&context.self_peer_id)
                    .await?
                    .into_iter()
                    .find(|peer| peer.peer_id == requester_peer_id)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(format!(
                            "requester peer {} is not currently discovered",
                            requester_peer_id
                        ))
                    })?;
                ensure_peer_is_trusted_for(
                    &context.registry_root,
                    &context.self_peer_id,
                    &requester_peer_id,
                    &requester_peer.public_key,
                )?;
                let requester_public_key = parse_public_key(&requester_peer.public_key)?;
                let identity =
                    load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
                let payload = open_json(&identity, &requester_public_key, &sealed_payload)?;
                let source_task_id = payload
                    .get("source_task_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(
                            "import acknowledgment payload missing source_task_id".into(),
                        )
                    })?
                    .to_string();
                let destination_local_task_id = payload
                    .get("destination_local_task_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(
                            "import acknowledgment payload missing destination_local_task_id"
                                .into(),
                        )
                    })?
                    .to_string();

                context
                    .incoming_sender
                    .send(RuntimeEvent::OutgoingTransferCommitted(
                        OutgoingTransferCommittedEvent {
                            transfer_id: transfer_id.clone(),
                            source_task_id,
                            destination_local_task_id,
                        },
                    ))
                    .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
                context.outgoing_transfers.lock().await.remove(&transfer_id);
                Ok::<PeerResponse, RuntimeError>(PeerResponse::ImportCommitted {
                    request_id: request_id.clone(),
                    transfer_id,
                })
            }
            .await
            {
                Ok(response) => response,
                Err(error) => PeerResponse::Error {
                    request_id,
                    message: error.to_string(),
                },
            }
        }
        Ok(PeerRequest::GetTaskSnapshot {
            request_id,
            requester_peer_id,
        }) => match async {
            let requester_peer = context
                .discovery
                .list_peers(&context.self_peer_id)
                .await?
                .into_iter()
                .find(|peer| peer.peer_id == requester_peer_id)
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "requester peer {} is not currently discovered",
                        requester_peer_id
                    ))
                })?;
            ensure_peer_is_trusted_for(
                &context.registry_root,
                &context.self_peer_id,
                &requester_peer_id,
                &requester_peer.public_key,
            )?;
            Ok::<PeerResponse, RuntimeError>(PeerResponse::TaskSnapshot {
                request_id: request_id.clone(),
                peer_id: context.self_peer_id.clone(),
                display_name: context.self_display_name.clone(),
                snapshot: context.task_snapshot.lock().await.clone(),
            })
        }
        .await
        {
            Ok(response) => response,
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Ok(PeerRequest::ObserveSession {
            request_id,
            requester_peer_id,
            session_id,
        }) => {
            let response =
                match prepare_session_observer(&context, &requester_peer_id, &session_id).await {
                    Ok(daemon) => {
                        write_json_line(
                            &mut stream,
                            &PeerResponse::ObserveSession {
                                request_id,
                                session_id: session_id.clone(),
                            },
                        )
                        .await?;
                        stream_daemon_session(daemon, stream, session_id).await?;
                        return Ok(());
                    }
                    Err(error) => PeerResponse::Error {
                        request_id,
                        message: error.to_string(),
                    },
                };
            response
        }
        Ok(PeerRequest::SendSessionInput {
            request_id,
            requester_peer_id,
            session_id,
            data,
        }) => match send_daemon_input(&context, &requester_peer_id, &session_id, data).await {
            Ok(()) => PeerResponse::SendSessionInput { request_id },
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Ok(PeerRequest::ResizeSession {
            request_id,
            requester_peer_id,
            session_id,
            cols,
            rows,
        }) => match resize_daemon_session(&context, &requester_peer_id, &session_id, cols, rows)
            .await
        {
            Ok(()) => PeerResponse::ResizeSession { request_id },
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Ok(PeerRequest::CloseTask {
            request_id,
            requester_peer_id,
            task_id,
        }) => match close_owner_task(&context, &requester_peer_id, &task_id).await {
            Ok(()) => PeerResponse::CloseTask { request_id },
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Ok(PeerRequest::AdvanceTaskStage {
            request_id,
            requester_peer_id,
            task_id,
        }) => match advance_owner_task_stage(&context, &requester_peer_id, &task_id).await {
            Ok(()) => PeerResponse::AdvanceTaskStage { request_id },
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Err(error) => PeerResponse::Error {
            request_id,
            message: error.to_string(),
        },
    };

    write_json_line(&mut stream, &response).await?;
    Ok(())
}

async fn build_incoming_event(
    self_peer_id: &str,
    registry_root: &Path,
    discovery: &PeerDiscovery,
    transfer_id: &str,
    pending_transfer_ttl: Duration,
    sealed_payload: String,
    incoming_reservations: &Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
) -> Result<IncomingTransferEvent, RuntimeError> {
    let reservation = {
        let mut reservations = incoming_reservations.lock().await;
        prune_incoming_reservations(&mut reservations, pending_transfer_ttl);
        reservations
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| RuntimeError::Protocol(format!("unknown transfer id {}", transfer_id)))?
    };

    let source_peer = discovery
        .list_peers(self_peer_id)
        .await?
        .into_iter()
        .find(|peer| peer.peer_id == reservation.source_peer_id)
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "source peer {} is not currently discovered",
                reservation.source_peer_id
            ))
        })?;
    ensure_peer_is_trusted_for(
        registry_root,
        self_peer_id,
        &reservation.source_peer_id,
        &source_peer.public_key,
    )?;
    let source_public_key = parse_public_key(&source_peer.public_key)?;
    let identity = load_or_create_identity(registry_root, self_peer_id)?;
    let payload = open_json(&identity, &source_public_key, &sealed_payload)?;

    let source_task_id = payload
        .pointer("/task/source_task_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or(reservation.source_task_id);

    let source_name = Some(source_peer.display_name);

    Ok(IncomingTransferEvent {
        transfer_id: transfer_id.to_owned(),
        source_peer_id: reservation.source_peer_id,
        source_task_id,
        source_name,
        payload,
    })
}

struct DaemonConnection {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

async fn stream_peer_session(
    peer: PeerRegistryEntry,
    request_id: String,
    requester_peer_id: String,
    session_id: String,
    incoming_sender: mpsc::UnboundedSender<RuntimeEvent>,
) -> Result<(), RuntimeError> {
    let mut stream = TcpStream::connect(&peer.endpoint).await?;
    write_json_line(
        &mut stream,
        &PeerRequest::ObserveSession {
            request_id: request_id.clone(),
            requester_peer_id,
            session_id: session_id.clone(),
        },
    )
    .await?;

    let mut response_line = String::new();
    {
        let mut reader = BufReader::new(&mut stream);
        let read = reader.read_line(&mut response_line).await?;
        if read == 0 {
            return Err(RuntimeError::Protocol(format!(
                "peer {} closed observe-session before response",
                peer.peer_id
            )));
        }
    }

    match parse_peer_response_line(&peer.peer_id, "observe-session", &response_line)? {
        PeerResponse::ObserveSession {
            request_id: response_request_id,
            session_id: response_session_id,
        } if response_request_id == request_id && response_session_id == session_id => {}
        PeerResponse::Error { message, .. } => return Err(RuntimeError::Protocol(message)),
        other => return Err(unexpected_peer_response("observe-session", &other)),
    }

    let mut reader = BufReader::new(stream);
    loop {
        let mut event_line = String::new();
        let read = reader.read_line(&mut event_line).await?;
        if read == 0 {
            return Ok(());
        }
        let event = parse_peer_terminal_event_line(&peer.peer_id, &session_id, &event_line)?;
        let event_session_id = peer_terminal_event_session_id(&event).to_owned();
        incoming_sender
            .send(RuntimeEvent::TerminalEvent {
                peer_id: peer.peer_id.clone(),
                session_id: event_session_id,
                event,
            })
            .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
    }
}

async fn prepare_session_observer(
    context: &ListenerContext,
    requester_peer_id: &str,
    session_id: &str,
) -> Result<DaemonConnection, RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;

    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Observe {
            session_id: session_id.to_owned(),
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(daemon),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon observe response: {:?}",
            other
        ))),
    }
}

async fn ensure_requester_peer_trusted(
    context: &ListenerContext,
    requester_peer_id: &str,
) -> Result<(), RuntimeError> {
    let requester_peer = context
        .discovery
        .list_peers(&context.self_peer_id)
        .await?
        .into_iter()
        .find(|peer| peer.peer_id == requester_peer_id)
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "requester peer {} is not currently discovered",
                requester_peer_id
            ))
        })?;
    ensure_peer_is_trusted_for(
        &context.registry_root,
        &context.self_peer_id,
        requester_peer_id,
        &requester_peer.public_key,
    )?;
    Ok(())
}

async fn send_daemon_input(
    context: &ListenerContext,
    requester_peer_id: &str,
    session_id: &str,
    data: Vec<u8>,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Input {
            session_id: session_id.to_owned(),
            data,
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon input response: {:?}",
            other
        ))),
    }
}

async fn resize_daemon_session(
    context: &ListenerContext,
    requester_peer_id: &str,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Resize {
            session_id: session_id.to_owned(),
            cols,
            rows,
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon resize response: {:?}",
            other
        ))),
    }
}

async fn close_owner_task(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    for session_id in [
        task_id.to_owned(),
        format!("shell-wt-{task_id}"),
        format!("td-{task_id}"),
    ] {
        kill_daemon_session_if_present(context, &session_id).await?;
    }
    close_pipeline_item_in_db(context, task_id)?;
    Ok(())
}

async fn advance_owner_task_stage(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    post_local_kanna_task_action(port, task_id, "advance-stage").await
}

async fn post_local_kanna_task_action(
    port: u16,
    task_id: &str,
    action: &str,
) -> Result<(), RuntimeError> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let path = format!("/v1/tasks/{task_id}/actions/{action}");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
    );
    stream.write_all(request.as_bytes()).await?;

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    let read = reader.read_line(&mut status_line).await?;
    if read == 0 {
        return Err(RuntimeError::Protocol(
            "Kanna server closed without a response".into(),
        ));
    }
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| {
            RuntimeError::Protocol(format!("invalid Kanna server response: {status_line}"))
        })?;
    if (200..300).contains(&status) {
        return Ok(());
    }

    let mut response = String::new();
    reader.read_to_string(&mut response).await?;
    Err(RuntimeError::Protocol(format!(
        "Kanna server task action failed with HTTP {status}: {response}"
    )))
}

async fn kill_daemon_session_if_present(
    context: &ListenerContext,
    session_id: &str,
) -> Result<(), RuntimeError> {
    let daemon_dir = context
        .daemon_dir
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("daemon directory is not configured".into()))?;
    let mut daemon = connect_daemon(daemon_dir).await?;
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Kill {
            session_id: session_id.to_owned(),
        },
    )
    .await?;
    match read_daemon_event(&mut daemon).await? {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => Ok(()),
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            Ok(())
        }
        DaemonEvent::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(RuntimeError::Protocol(format!(
            "unexpected daemon kill response: {:?}",
            other
        ))),
    }
}

fn close_pipeline_item_in_db(context: &ListenerContext, task_id: &str) -> Result<(), RuntimeError> {
    let db_path = context
        .db_path
        .as_ref()
        .ok_or_else(|| RuntimeError::Protocol("database path is not configured".into()))?;
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|error| RuntimeError::Protocol(format!("db error: {error}")))?;
    let rows = conn
        .execute(
            "UPDATE pipeline_item
             SET previous_stage = COALESCE(previous_stage, stage),
                 stage = 'done',
                 closed_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ?",
            [task_id],
        )
        .map_err(|error| RuntimeError::Protocol(format!("db error: {error}")))?;
    if rows == 0 {
        return Err(RuntimeError::Protocol(format!("task not found: {task_id}")));
    }
    Ok(())
}

async fn stream_daemon_session(
    mut daemon: DaemonConnection,
    mut stream: TcpStream,
    session_id: String,
) -> Result<(), RuntimeError> {
    send_daemon_command(
        &mut daemon,
        &DaemonCommand::Snapshot {
            session_id: session_id.clone(),
        },
    )
    .await?;

    loop {
        match read_daemon_event(&mut daemon).await? {
            DaemonEvent::Snapshot {
                session_id: event_session_id,
                snapshot,
            } if event_session_id == session_id => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Snapshot {
                        session_id: event_session_id,
                        snapshot: serde_json::to_value(snapshot)?,
                    },
                )
                .await?;
            }
            DaemonEvent::Output {
                session_id: event_session_id,
                data,
            } if event_session_id == session_id => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Output {
                        session_id: event_session_id,
                        data,
                    },
                )
                .await?;
            }
            DaemonEvent::Exit {
                session_id: event_session_id,
                code,
                ..
            } if event_session_id == session_id => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Exit {
                        session_id: event_session_id,
                        code,
                    },
                )
                .await?;
                return Ok(());
            }
            DaemonEvent::Error { message, .. } => {
                write_json_line(
                    &mut stream,
                    &PeerTerminalEvent::Error {
                        session_id,
                        message,
                    },
                )
                .await?;
                return Ok(());
            }
            _ => {}
        }
    }
}

fn parse_peer_response_line(
    peer_id: &str,
    operation: &str,
    line: &str,
) -> Result<PeerResponse, RuntimeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::Protocol(format!(
            "peer {peer_id} returned an empty response for {operation}"
        )));
    }

    serde_json::from_str::<PeerResponse>(trimmed).map_err(|error| {
        RuntimeError::Protocol(format!(
            "peer {peer_id} returned a non-JSON response for {operation}: {error}"
        ))
    })
}

fn parse_peer_terminal_event_line(
    peer_id: &str,
    session_id: &str,
    line: &str,
) -> Result<PeerTerminalEvent, RuntimeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::Protocol(format!(
            "peer {peer_id} returned an empty terminal event for session {session_id}"
        )));
    }

    serde_json::from_str::<PeerTerminalEvent>(trimmed).map_err(|error| {
        RuntimeError::Protocol(format!(
            "peer {peer_id} returned a non-JSON terminal event for session {session_id}: {error}"
        ))
    })
}

async fn connect_daemon(daemon_dir: &Path) -> Result<DaemonConnection, RuntimeError> {
    let stream = UnixStream::connect(daemon_socket_path(daemon_dir)).await?;
    let (read_half, write_half) = stream.into_split();
    Ok(DaemonConnection {
        reader: BufReader::new(read_half),
        writer: write_half,
    })
}

async fn send_daemon_command(
    daemon: &mut DaemonConnection,
    command: &DaemonCommand,
) -> Result<(), RuntimeError> {
    let encoded = serde_json::to_vec(command)?;
    daemon.writer.write_all(&encoded).await?;
    daemon.writer.write_all(b"\n").await?;
    daemon.writer.flush().await?;
    Ok(())
}

async fn read_daemon_event(daemon: &mut DaemonConnection) -> Result<DaemonEvent, RuntimeError> {
    let mut line = String::new();
    let read = daemon.reader.read_line(&mut line).await?;
    if read == 0 {
        return Err(RuntimeError::Protocol(
            "daemon closed observer stream".into(),
        ));
    }
    Ok(serde_json::from_str(line.trim())?)
}

fn daemon_socket_path(daemon_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    daemon_dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

fn terminal_observer_key(peer_id: &str, session_id: &str) -> String {
    format!("{peer_id}:{session_id}")
}

fn peer_terminal_event_session_id(event: &PeerTerminalEvent) -> &str {
    match event {
        PeerTerminalEvent::Snapshot { session_id, .. }
        | PeerTerminalEvent::Output { session_id, .. }
        | PeerTerminalEvent::Exit { session_id, .. }
        | PeerTerminalEvent::Error { session_id, .. } => session_id,
    }
}

fn extract_request_id(line: &str) -> String {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

async fn write_json_line<T>(stream: &mut TcpStream, value: &T) -> Result<(), RuntimeError>
where
    T: serde::Serialize,
{
    let encoded = serde_json::to_vec(value)?;
    stream.write_all(&encoded).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

fn registry_entry_path(root: &Path, peer_id: &str) -> PathBuf {
    root.join(format!("{}.json", URL_SAFE_NO_PAD.encode(peer_id)))
}

fn peer_store(root: &Path, self_peer_id: &str) -> Result<PeerStore, RuntimeError> {
    Ok(PeerStore::new(root.join("trusted-peers").join(format!(
        "{}.json",
        URL_SAFE_NO_PAD.encode(self_peer_id)
    ))))
}

fn identity_path(root: &Path, self_peer_id: &str) -> PathBuf {
    root.join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode(self_peer_id)))
}

fn load_or_create_identity(
    root: &Path,
    self_peer_id: &str,
) -> Result<TransferIdentity, RuntimeError> {
    let path = identity_path(root, self_peer_id);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if !contents.trim().is_empty() {
            let stored: StoredIdentity = serde_json::from_str(&contents)?;
            return TransferIdentity::from_secret_string(&stored.secret_key)
                .map_err(|error| RuntimeError::InvalidConfig(error.to_string()));
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let identity = TransferIdentity::generate();
    let stored = StoredIdentity {
        secret_key: identity.secret_key_string(),
    };
    std::fs::write(path, serde_json::to_vec_pretty(&stored)?)?;
    Ok(identity)
}

fn local_capabilities_json() -> String {
    serde_json::json!({
        "protocolVersion": 1,
        "transferCapabilityVersion": 1,
    })
    .to_string()
}

fn ensure_peer_is_trusted_for(
    root: &Path,
    self_peer_id: &str,
    peer_id: &str,
    observed_public_key: &str,
) -> Result<(), RuntimeError> {
    let trusted = peer_store(root, self_peer_id)?
        .list_active()?
        .into_iter()
        .find(|record| record.peer_id == peer_id)
        .filter(|record| record.public_key == observed_public_key)
        .is_some();

    if trusted {
        Ok(())
    } else {
        Err(RuntimeError::Protocol(format!(
            "peer {} is not trusted",
            peer_id
        )))
    }
}

fn pairing_verification_code(
    left_peer_id: &str,
    left_public_key: &str,
    right_peer_id: &str,
    right_public_key: &str,
) -> String {
    let mut participants = [
        format!("{left_peer_id}:{left_public_key}"),
        format!("{right_peer_id}:{right_public_key}"),
    ];
    participants.sort();

    let mut hasher = Sha256::new();
    hasher.update(participants[0].as_bytes());
    hasher.update(b"|");
    hasher.update(participants[1].as_bytes());
    let digest = hasher.finalize();
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

fn unexpected_peer_response(operation: &str, response: &PeerResponse) -> RuntimeError {
    RuntimeError::Protocol(format!(
        "unexpected response while handling {}: {:?}",
        operation, response
    ))
}

fn prune_outgoing_transfers(
    transfers: &mut HashMap<String, OutgoingTransferReservation>,
    pending_transfer_ttl: Duration,
) {
    let now = Instant::now();
    transfers
        .retain(|_, reservation| now.duration_since(reservation.created_at) < pending_transfer_ttl);
}

fn prune_incoming_reservations(
    reservations: &mut HashMap<String, IncomingTransferReservation>,
    pending_transfer_ttl: Duration,
) {
    let now = Instant::now();
    reservations
        .retain(|_, reservation| now.duration_since(reservation.created_at) < pending_transfer_ttl);
}

fn prune_transfer_artifacts(
    transfer_artifacts: &mut HashMap<String, HashMap<String, TransferArtifactRecord>>,
    pending_transfer_ttl: Duration,
) {
    let now = Instant::now();
    transfer_artifacts.retain(|_, artifacts| {
        artifacts
            .retain(|_, artifact| now.duration_since(artifact.created_at) < pending_transfer_ttl);
        !artifacts.is_empty()
    });
}

fn sanitize_artifact_filename(filename: &str) -> String {
    let sanitized = filename
        .chars()
        .map(|character| match character {
            '/' | '\\' => '-',
            _ => character,
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "artifact".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock should not be poisoned")
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    struct CwdGuard {
        previous: std::path::PathBuf,
    }

    impl CwdGuard {
        fn set(path: impl AsRef<std::path::Path>) -> Self {
            let previous = std::env::current_dir().expect("current dir should resolve");
            std::env::set_current_dir(path).expect("test cwd should be set");
            Self { previous }
        }
    }

    impl Drop for CwdGuard {
        fn drop(&mut self) {
            std::env::set_current_dir(&self.previous).expect("test cwd should be restored");
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn from_env_uses_worktree_daemon_dir_when_runtime_paths_are_not_overridden_inside_worktree() {
        let _lock = env_lock();
        let home = std::env::temp_dir().join(format!(
            "kanna-task-transfer-worktree-defaults-{}",
            std::process::id()
        ));
        let worktree = home
            .join("repo")
            .join(".kanna-worktrees")
            .join("task-transfer-test");
        std::fs::create_dir_all(&worktree).expect("worktree test dir should be created");
        let _cwd_guard = CwdGuard::set(&worktree);
        let resolved_worktree =
            std::env::current_dir().expect("resolved worktree cwd should be available");
        let _home_guard = EnvGuard::set("HOME", home.as_os_str());
        let _daemon_guard = EnvGuard::unset("KANNA_DAEMON_DIR");
        let _db_guard = EnvGuard::unset("KANNA_DB_PATH");
        let _cli_db_guard = EnvGuard::unset("KANNA_CLI_DB_PATH");
        let _transfer_root_guard = EnvGuard::unset("KANNA_TRANSFER_ROOT");
        let _registry_guard = EnvGuard::unset("KANNA_TRANSFER_REGISTRY_DIR");

        let config = RuntimeConfig::from_env().expect("runtime config should resolve");

        assert_eq!(
            config.daemon_dir,
            Some(resolved_worktree.join(".kanna-daemon"))
        );
        assert_eq!(
            config.db_path,
            Some(
                home.join("Library")
                    .join("Application Support")
                    .join("build.kanna")
                    .join("kanna-v2.db")
            )
        );
        assert_eq!(
            config.registry_dir,
            home.join("Library")
                .join("Application Support")
                .join("build.kanna")
                .join("transfer")
                .join("registry")
        );

        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn from_env_uses_production_defaults_when_runtime_paths_are_not_overridden_outside_worktree() {
        let _lock = env_lock();
        let home = std::env::temp_dir().join(format!(
            "kanna-task-transfer-production-defaults-{}",
            std::process::id()
        ));
        let cwd = home.join("plain-repo");
        std::fs::create_dir_all(&cwd).expect("plain test cwd should be created");
        let _cwd_guard = CwdGuard::set(&cwd);
        let _home_guard = EnvGuard::set("HOME", home.as_os_str());
        let _daemon_guard = EnvGuard::unset("KANNA_DAEMON_DIR");
        let _db_guard = EnvGuard::unset("KANNA_DB_PATH");
        let _cli_db_guard = EnvGuard::unset("KANNA_CLI_DB_PATH");
        let _transfer_root_guard = EnvGuard::unset("KANNA_TRANSFER_ROOT");
        let _registry_guard = EnvGuard::unset("KANNA_TRANSFER_REGISTRY_DIR");

        let config = RuntimeConfig::from_env().expect("runtime config should resolve");

        assert_eq!(
            config.daemon_dir,
            Some(
                home.join("Library")
                    .join("Application Support")
                    .join("Kanna")
            )
        );
        assert_eq!(
            config.db_path,
            Some(
                home.join("Library")
                    .join("Application Support")
                    .join("build.kanna")
                    .join("kanna-v2.db")
            )
        );
        assert_eq!(
            config.registry_dir,
            home.join("Library")
                .join("Application Support")
                .join("build.kanna")
                .join("transfer")
                .join("registry")
        );

        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn from_env_prefers_runtime_path_overrides() {
        let _lock = env_lock();
        let home = std::env::temp_dir().join(format!(
            "kanna-task-transfer-overrides-{}",
            std::process::id()
        ));
        let daemon_dir = home.join("custom-daemon");
        let db_path = home.join("custom.sqlite");
        let transfer_root = home.join("custom-transfer");
        let _home_guard = EnvGuard::set("HOME", home.as_os_str());
        let _daemon_guard = EnvGuard::set("KANNA_DAEMON_DIR", daemon_dir.as_os_str());
        let _db_guard = EnvGuard::set("KANNA_DB_PATH", db_path.as_os_str());
        let _cli_db_guard = EnvGuard::unset("KANNA_CLI_DB_PATH");
        let _transfer_root_guard = EnvGuard::set("KANNA_TRANSFER_ROOT", transfer_root.as_os_str());
        let _registry_guard = EnvGuard::unset("KANNA_TRANSFER_REGISTRY_DIR");

        let config = RuntimeConfig::from_env().expect("runtime config should resolve");

        assert_eq!(config.daemon_dir, Some(daemon_dir));
        assert_eq!(config.db_path, Some(db_path));
        assert_eq!(config.registry_dir, transfer_root.join("registry"));

        let _ = std::fs::remove_dir_all(home);
    }
}
