use super::config::RuntimeConfig;
use super::discovery::PeerDiscovery;
use super::events::{
    FinalizedOutgoingTransfer, IncomingTransferEvent, OutgoingTransferCommittedEvent, RuntimeError,
    RuntimeEvent,
};
use super::external_peers::ExternalPeerRegistry;
use super::replay_store::TransferReplayStore;
use crate::crypto::TransferIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub(super) struct IncomingTransferReservation {
    pub(super) source_peer_id: String,
    pub(super) source_task_id: String,
    pub(super) created_at_unix_ms: u64,
    pub(super) committed: bool,
    pub(super) event: Option<IncomingTransferEvent>,
    pub(super) event_recorded: bool,
}

#[derive(Debug, Clone)]
pub(super) struct OutgoingTransferReservation {
    pub(super) target_peer_id: String,
    pub(super) source_task_id: String,
    pub(super) target_peer: Option<crate::protocol::PeerRegistryEntry>,
    pub(super) transport: Option<super::external_peers::TransferTransport>,
    pub(super) created_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ImportCommitReceipt {
    pub(super) target_peer_id: String,
    pub(super) target_peer: Option<crate::protocol::PeerRegistryEntry>,
    pub(super) transport: Option<super::external_peers::TransferTransport>,
    pub(super) source_task_id: String,
    pub(super) destination_local_task_id: String,
    pub(super) created_at_unix_ms: u64,
    pub(super) applied: bool,
    pub(super) event_queued: bool,
}

impl ImportCommitReceipt {
    pub(super) fn try_queue_event(
        &mut self,
        transfer_id: &str,
        sender: &mpsc::Sender<OutgoingTransferCommittedEvent>,
    ) -> Result<(), RuntimeError> {
        if self.applied || self.event_queued {
            return Ok(());
        }
        let event = OutgoingTransferCommittedEvent {
            transfer_id: transfer_id.to_owned(),
            source_task_id: self.source_task_id.clone(),
            destination_local_task_id: self.destination_local_task_id.clone(),
        };
        match sender.try_send(event) {
            Ok(()) => {
                self.event_queued = true;
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(RuntimeError::IncomingEventChannelClosed)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedTransferArtifact {
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub(super) struct TransferArtifactRecord {
    pub(super) path: PathBuf,
    pub(super) created_at: Instant,
}

pub(super) struct TerminalObserverSlot {
    pub(super) lease_id: String,
    pub(super) closed: bool,
    pub(super) handle: Option<JoinHandle<()>>,
}

pub(super) type PendingOutgoingTransferFinalizations =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<FinalizedOutgoingTransfer, RuntimeError>>>>>;

pub(super) type PendingPairingRequests = Arc<Mutex<HashMap<String, PendingPairingRequest>>>;

pub(super) struct PendingPairingRequest {
    pub(super) verification_code: String,
    pub(super) responder: oneshot::Sender<PairingDecision>,
}

#[derive(Debug, Clone)]
pub(super) struct PendingTaskPullRequest {
    pub(super) request_id: String,
    pub(super) created_at: Instant,
}

pub(super) type PendingTaskPullRequests =
    Arc<Mutex<HashMap<(String, String), PendingTaskPullRequest>>>;

pub(super) enum PairingDecision {
    Accepted,
    Rejected,
}

#[derive(Clone)]
pub(super) struct ListenerContext {
    pub(super) self_peer_id: String,
    pub(super) self_display_name: String,
    pub(super) self_public_key: String,
    pub(super) registry_root: PathBuf,
    pub(super) discovery: PeerDiscovery,
    pub(super) external_peers: ExternalPeerRegistry,
    pub(super) pending_transfer_ttl: Duration,
    pub(super) peer_request_timeout: Duration,
    pub(super) pending_pairing_requests: PendingPairingRequests,
    pub(super) pending_task_pull_requests: PendingTaskPullRequests,
    pub(super) outgoing_transfers: Arc<Mutex<HashMap<String, OutgoingTransferReservation>>>,
    pub(super) import_commit_receipts: Arc<Mutex<HashMap<String, ImportCommitReceipt>>>,
    pub(super) replay_store: Arc<TransferReplayStore>,
    pub(super) pending_outgoing_transfer_finalizations: PendingOutgoingTransferFinalizations,
    pub(super) incoming_reservations: Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
    pub(super) transfer_artifacts:
        Arc<Mutex<HashMap<String, HashMap<String, TransferArtifactRecord>>>>,
    pub(super) authenticated_peer_requests: Arc<Mutex<HashMap<String, Instant>>>,
    pub(super) task_snapshot: Arc<Mutex<Value>>,
    pub(super) daemon_dir: Option<PathBuf>,
    pub(super) db_path: Option<PathBuf>,
    pub(super) kanna_server_port: Option<u16>,
    pub(super) request_counter: Arc<AtomicU64>,
    pub(super) incoming_sender: mpsc::UnboundedSender<RuntimeEvent>,
    pub(super) receipt_sender: mpsc::Sender<OutgoingTransferCommittedEvent>,
}

pub struct TransferRuntime {
    pub(super) config: RuntimeConfig,
    pub(super) discovery: PeerDiscovery,
    pub(super) external_peers: ExternalPeerRegistry,
    pub(super) identity: TransferIdentity,
    pub(super) pending_pairing_requests: PendingPairingRequests,
    pub(super) outgoing_transfers: Arc<Mutex<HashMap<String, OutgoingTransferReservation>>>,
    pub(super) import_commit_receipts: Arc<Mutex<HashMap<String, ImportCommitReceipt>>>,
    pub(super) replay_store: Arc<TransferReplayStore>,
    pub(super) pending_outgoing_transfer_finalizations: PendingOutgoingTransferFinalizations,
    pub(super) incoming_reservations: Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
    pub(super) transfer_artifacts:
        Arc<Mutex<HashMap<String, HashMap<String, TransferArtifactRecord>>>>,
    pub(super) task_snapshot: Arc<Mutex<Value>>,
    pub(super) terminal_observers: Arc<Mutex<HashMap<String, TerminalObserverSlot>>>,
    pub(super) incoming_sender: mpsc::UnboundedSender<RuntimeEvent>,
    pub(super) incoming_events: Mutex<mpsc::UnboundedReceiver<RuntimeEvent>>,
    pub(super) receipt_events: Mutex<mpsc::Receiver<OutgoingTransferCommittedEvent>>,
    pub(super) request_counter: Arc<AtomicU64>,
    pub(super) listener_task: JoinHandle<()>,
    pub(super) receipt_retry_task: JoinHandle<()>,
    pub(super) registry_entry_path: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct StoredIdentity {
    pub(super) secret_key: String,
}
