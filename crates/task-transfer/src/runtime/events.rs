use crate::crypto::CryptoError;
use crate::peer_store::PeerStoreError;
use crate::protocol::{DiscoveredPeer, PeerTerminalEvent};
use crate::registry::RegistryError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub struct TaskPullRequestedEvent {
    pub request_id: String,
    pub requester_peer_id: String,
    pub source_task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeEvent {
    PairingStarted(PairingStartedEvent),
    PairingRequested(PairingRequestedEvent),
    PairingCompleted(PairingCompletedEvent),
    TaskPullRequested(TaskPullRequestedEvent),
    IncomingTransferRequest(IncomingTransferEvent),
    OutgoingTransferCommitted(OutgoingTransferCommittedEvent),
    OutgoingTransferFinalizationRequested(OutgoingTransferFinalizationRequestedEvent),
    TerminalEvent {
        peer_id: String,
        session_id: String,
        observer_lease_id: String,
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
    #[error("{0}")]
    Backpressure(String),
    #[error("peer request to {peer_id} timed out after {timeout_ms}ms")]
    PeerRequestTimeout { peer_id: String, timeout_ms: u128 },
    #[error("discovery error: {0}")]
    Discovery(String),
    #[error("incoming event channel closed")]
    IncomingEventChannelClosed,
}
