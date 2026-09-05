use super::companion::{CompanionInboundByteBudget, OwnerCompanionSource};
use super::config::RuntimeConfig;
use super::discovery::PeerDiscovery;
use super::events::{
    FinalizedOutgoingTransfer, IncomingTransferEvent, OutgoingTransferCommittedEvent, RuntimeError,
    RuntimeEvent,
};
use super::external_peers::ExternalPeerRegistry;
use super::replay_store::TransferReplayStore;
use crate::crypto::TransferIdentity;
use kanna_visual_companion::CompanionMaterializationBudget;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};
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
    pub(super) delivery_in_flight: bool,
}

impl ImportCommitReceipt {
    pub(super) fn try_queue_event(
        &mut self,
        transfer_id: &str,
        sender: &mpsc::Sender<OutgoingTransferCommittedEvent>,
    ) -> Result<(), RuntimeError> {
        if self.applied || self.event_queued || self.delivery_in_flight {
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
    pub(super) owned: bool,
}

pub(super) struct TerminalObserverSlot {
    pub(super) closed: bool,
    pub(super) closed_at: Option<Instant>,
    pub(super) handle: Option<JoinHandle<()>>,
    pub(super) control_sender: Option<mpsc::Sender<crate::protocol::PeerTerminalControl>>,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AuthenticatedPeerRequestReplay {
    pub(super) expires_at_unix_ms: u64,
    pub(super) durable: bool,
}

pub(super) type CachedOutgoingTransferFinalization = Result<FinalizedOutgoingTransfer, String>;

pub(super) enum OutgoingTransferFinalizationState {
    Pending {
        waiters: Vec<oneshot::Sender<CachedOutgoingTransferFinalization>>,
    },
    Completed(CachedOutgoingTransferFinalization),
}

pub(super) type PendingOutgoingTransferFinalizations =
    Arc<Mutex<HashMap<String, OutgoingTransferFinalizationState>>>;

pub(super) type PendingPairingRequests = Arc<Mutex<HashMap<String, PendingPairingRequest>>>;
pub(super) const MAX_COMPANION_OBSERVERS: usize = 64;
const MAX_RELIABLE_EVENTS_BEFORE_COMPANION: usize = 32;
#[cfg(test)]
pub(super) const MAX_PENDING_ORDINARY_EVENTS: usize = 4096;

#[derive(Default)]
struct CompanionEventState {
    pending: HashMap<(String, String), RuntimeEvent>,
    ready: VecDeque<(String, String)>,
    current_generations: HashMap<(String, String), (u64, String)>,
}

#[derive(Clone)]
pub(super) struct RuntimeEventSender {
    ordinary: mpsc::Sender<RuntimeEvent>,
    companion_state: Arc<StdMutex<CompanionEventState>>,
    companion_notify: mpsc::Sender<()>,
}

impl RuntimeEventSender {
    pub(super) fn register_companion_generation(
        &self,
        peer_id: &str,
        task_id: &str,
        generation: &str,
        generation_order: u64,
    ) -> bool {
        let key = (peer_id.to_owned(), task_id.to_owned());
        let mut state = self
            .companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .current_generations
            .get(&key)
            .is_some_and(|(current_order, current_generation)| {
                *current_order > generation_order
                    || (*current_order == generation_order && current_generation != generation)
            })
        {
            return false;
        }
        state
            .current_generations
            .insert(key.clone(), (generation_order, generation.to_owned()));
        if state.pending.get(&key).is_some_and(|pending| {
            matches!(
                pending,
                RuntimeEvent::CompanionEvent {
                    generation: pending_generation,
                    generation_order: pending_order,
                    ..
                } if *pending_order < generation_order
                    || (*pending_order == generation_order
                        && pending_generation != generation)
            )
        }) {
            state.pending.remove(&key);
            state.ready.retain(|pending_key| pending_key != &key);
        }
        true
    }

    pub(super) fn unregister_companion_generation(
        &self,
        peer_id: &str,
        task_id: &str,
        generation: &str,
        generation_order: u64,
    ) {
        let key = (peer_id.to_owned(), task_id.to_owned());
        let mut state = self
            .companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .current_generations
            .get(&key)
            .is_some_and(|(current_order, current_generation)| {
                *current_order == generation_order && current_generation == generation
            })
        {
            state.current_generations.remove(&key);
            state.pending.remove(&key);
            state.ready.retain(|pending_key| pending_key != &key);
        }
    }

    pub(super) async fn send(
        &self,
        event: RuntimeEvent,
    ) -> Result<(), mpsc::error::SendError<RuntimeEvent>> {
        let companion_identity = match &event {
            RuntimeEvent::CompanionEvent {
                peer_id,
                task_id,
                generation,
                generation_order,
                frame:
                    kanna_agent_protocol::ServerFrame::CompanionSnapshot { .. }
                    | kanna_agent_protocol::ServerFrame::CompanionUnavailable { .. },
                ..
            } => Some((
                (peer_id.clone(), task_id.clone()),
                generation.clone(),
                *generation_order,
            )),
            _ => None,
        };
        let Some((key, generation, generation_order)) = companion_identity else {
            if let RuntimeEvent::CompanionEvent {
                peer_id,
                task_id,
                generation,
                generation_order,
                ..
            } = &event
            {
                let state = self
                    .companion_state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state
                    .current_generations
                    .get(&(peer_id.clone(), task_id.clone()))
                    .is_some_and(|(current_order, current_generation)| {
                        *current_order > *generation_order
                            || (*current_order == *generation_order
                                && current_generation != generation)
                    })
                {
                    return Ok(());
                }
                drop(state);
                if matches!(
                    &event,
                    RuntimeEvent::CompanionEvent {
                        frame: kanna_agent_protocol::ServerFrame::CompanionError { .. },
                        ..
                    }
                ) {
                    self.invalidate_companion(peer_id, task_id, generation, *generation_order);
                }
            }
            return self.ordinary.send(event).await;
        };
        if self.companion_notify.is_closed() {
            return Err(mpsc::error::SendError(event));
        }
        let mut state = self
            .companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match state.current_generations.get(&key) {
            Some((current_order, current_generation))
                if *current_order > generation_order
                    || (*current_order == generation_order
                        && current_generation != &generation) =>
            {
                return Ok(());
            }
            Some(_) => {}
            None => {
                state
                    .current_generations
                    .insert(key.clone(), (generation_order, generation));
            }
        }
        if !state.pending.contains_key(&key) && state.pending.len() >= MAX_COMPANION_OBSERVERS {
            return Err(mpsc::error::SendError(event));
        }
        if !state.pending.contains_key(&key) {
            state.ready.push_back(key.clone());
        }
        state.pending.insert(key.clone(), event);
        drop(state);
        match self.companion_notify.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(())) => {
                let event = self
                    .companion_state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pending
                    .remove(&key)
                    .expect("just-inserted companion event should remain pending");
                Err(mpsc::error::SendError(event))
            }
        }
    }

    /// Non-blocking delivery for ordinary (non-companion) events whose lane
    /// must never wait on channel capacity, such as observed terminal output.
    // Match Tokio try_send: callers receive the original event on full or closed channels.
    #[allow(clippy::result_large_err)]
    pub(super) fn try_send(
        &self,
        event: RuntimeEvent,
    ) -> Result<(), mpsc::error::TrySendError<RuntimeEvent>> {
        self.ordinary.try_send(event)
    }

    pub(super) fn invalidate_companion(
        &self,
        peer_id: &str,
        task_id: &str,
        generation: &str,
        generation_order: u64,
    ) {
        let key = (peer_id.to_owned(), task_id.to_owned());
        let mut state = self
            .companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.pending.get(&key).is_some_and(|pending| {
            matches!(
                pending,
                RuntimeEvent::CompanionEvent {
                    generation: pending_generation,
                    generation_order: pending_order,
                    ..
                } if pending_generation == generation && *pending_order == generation_order
            )
        }) {
            state.pending.remove(&key);
            state.ready.retain(|pending_key| pending_key != &key);
        }
    }

    #[cfg(test)]
    pub(super) fn pending_companion_count(&self) -> usize {
        self.companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .len()
    }

    #[cfg(test)]
    pub(super) fn companion_generation_count(&self) -> usize {
        self.companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .current_generations
            .len()
    }
}

pub(super) struct RuntimeEventReceiver {
    ordinary: mpsc::Receiver<RuntimeEvent>,
    companion_state: Arc<StdMutex<CompanionEventState>>,
    companion_notify: mpsc::Receiver<()>,
    ordinary_closed: bool,
    companion_closed: bool,
    reliable_burst: usize,
}

impl RuntimeEventReceiver {
    #[cfg(test)]
    pub(super) fn close(&mut self) {
        self.ordinary.close();
        self.companion_notify.close();
    }

    fn take_companion(&self) -> Option<RuntimeEvent> {
        let mut state = self
            .companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while let Some(key) = state.ready.pop_front() {
            if let Some(event) = state.pending.remove(&key) {
                return Some(event);
            }
        }
        None
    }

    pub(super) async fn recv(&mut self) -> Option<RuntimeEvent> {
        loop {
            if !self.ordinary_closed && self.reliable_burst < MAX_RELIABLE_EVENTS_BEFORE_COMPANION {
                match self.ordinary.try_recv() {
                    Ok(event) => {
                        self.reliable_burst += 1;
                        return Some(event);
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => self.ordinary_closed = true,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            if let Some(event) = self.take_companion() {
                self.reliable_burst = 0;
                return Some(event);
            }
            if !self.ordinary_closed {
                match self.ordinary.try_recv() {
                    Ok(event) => {
                        self.reliable_burst = self.reliable_burst.saturating_add(1);
                        return Some(event);
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => self.ordinary_closed = true,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            if self.ordinary_closed && self.companion_closed {
                return None;
            }
            tokio::select! {
                biased;
                event = self.ordinary.recv(), if !self.ordinary_closed => {
                    match event {
                        Some(event) => {
                            self.reliable_burst = self.reliable_burst.saturating_add(1);
                            return Some(event);
                        }
                        None => self.ordinary_closed = true,
                    }
                }
                notification = self.companion_notify.recv(), if !self.companion_closed => {
                    if notification.is_none() {
                        self.companion_closed = true;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
pub(super) fn runtime_event_channel() -> (RuntimeEventSender, RuntimeEventReceiver) {
    runtime_event_channel_with_capacity(MAX_PENDING_ORDINARY_EVENTS)
}

pub(super) fn runtime_event_channel_with_capacity(
    ordinary_capacity: usize,
) -> (RuntimeEventSender, RuntimeEventReceiver) {
    let (ordinary, ordinary_rx) = mpsc::channel(ordinary_capacity.max(1));
    let (companion_notify, companion_notify_rx) = mpsc::channel(1);
    let companion_state = Arc::new(StdMutex::new(CompanionEventState::default()));
    (
        RuntimeEventSender {
            ordinary,
            companion_state: Arc::clone(&companion_state),
            companion_notify,
        },
        RuntimeEventReceiver {
            ordinary: ordinary_rx,
            companion_state,
            companion_notify: companion_notify_rx,
            ordinary_closed: false,
            companion_closed: false,
            reliable_burst: 0,
        },
    )
}

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

pub(super) struct CompanionObserver {
    pub(super) generation: String,
    pub(super) generation_order: u64,
    pub(super) handle: JoinHandle<()>,
    pub(super) stream_nonce: String,
    pub(super) observation_challenge: String,
    pub(super) next_event_sequence: Arc<AtomicU64>,
    pub(super) send_lock: Arc<Mutex<()>>,
}

pub(super) struct OwnerCompanionObserver {
    pub(super) generation: String,
    pub(super) stream_nonce: String,
    pub(super) observation_challenge: String,
    pub(super) next_event_sequence: u64,
    pub(super) event_rate_limiter: Arc<Mutex<super::companion::CompanionEventRateLimiter>>,
    pub(super) cancel: watch::Sender<bool>,
}

pub(super) fn remove_companion_observer_generation(
    observers: &mut HashMap<(String, String), CompanionObserver>,
    key: &(String, String),
    generation: &str,
    generation_order: u64,
) -> bool {
    if observers.get(key).is_some_and(|observer| {
        observer.generation == generation && observer.generation_order == generation_order
    }) {
        observers.remove(key);
        true
    } else {
        false
    }
}

pub(super) fn remove_companion_observer_registration(
    latest_generations: &mut HashMap<(String, String), (u64, String)>,
    key: &(String, String),
    generation: &str,
    generation_order: u64,
) -> bool {
    if latest_generations
        .get(key)
        .is_some_and(|(current_order, current_generation)| {
            *current_order == generation_order && current_generation == generation
        })
    {
        latest_generations.remove(key);
        true
    } else {
        false
    }
}

pub(super) fn install_companion_observer_if_latest(
    latest_generations: &HashMap<(String, String), (u64, String)>,
    observers: &mut HashMap<(String, String), CompanionObserver>,
    observer_key: (String, String),
    observer: CompanionObserver,
) -> Result<Option<CompanionObserver>, CompanionObserver> {
    if latest_generations
        .get(&observer_key)
        .is_none_or(|(generation_order, generation)| {
            *generation_order != observer.generation_order || generation != &observer.generation
        })
    {
        return Err(observer);
    }
    Ok(observers.insert(observer_key, observer))
}

#[derive(Clone)]
pub(super) struct ListenerContext {
    pub(super) self_peer_id: String,
    pub(super) self_display_name: String,
    pub(super) self_public_key: String,
    pub(super) authenticated_request_epoch: String,
    pub(super) registry_root: PathBuf,
    pub(super) discovery: PeerDiscovery,
    pub(super) external_peers: ExternalPeerRegistry,
    pub(super) pending_transfer_ttl: Duration,
    pub(super) authenticated_request_freshness: Duration,
    pub(super) peer_request_timeout: Duration,
    pub(super) finalization_request_timeout: Duration,
    pub(super) incoming_connection_permits: Arc<Semaphore>,
    pub(super) legacy_artifact_memory_permits: Arc<Semaphore>,
    pub(super) max_pending_pairing_requests: usize,
    pub(super) max_task_pull_requests: usize,
    pub(super) max_finalization_waiters: usize,
    pub(super) pending_pairing_requests: PendingPairingRequests,
    pub(super) pending_task_pull_requests: PendingTaskPullRequests,
    pub(super) outgoing_transfers: Arc<Mutex<HashMap<String, OutgoingTransferReservation>>>,
    pub(super) import_commit_receipts: Arc<Mutex<HashMap<String, ImportCommitReceipt>>>,
    pub(super) replay_store: Arc<TransferReplayStore>,
    pub(super) pending_outgoing_transfer_finalizations: PendingOutgoingTransferFinalizations,
    pub(super) incoming_reservations: Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
    pub(super) transfer_artifacts:
        Arc<Mutex<HashMap<String, HashMap<String, TransferArtifactRecord>>>>,
    pub(super) authenticated_peer_requests:
        Arc<Mutex<HashMap<String, AuthenticatedPeerRequestReplay>>>,
    pub(super) max_authenticated_request_replays: usize,
    pub(super) task_snapshot: Arc<Mutex<Value>>,
    pub(super) db_path: Option<PathBuf>,
    pub(super) daemon_dir: Option<PathBuf>,
    pub(super) kanna_server_port: Option<u16>,
    pub(super) request_counter: Arc<AtomicU64>,
    pub(super) incoming_sender: RuntimeEventSender,
    pub(super) receipt_sender: mpsc::Sender<OutgoingTransferCommittedEvent>,
    pub(super) active_owner_companions: Arc<AtomicUsize>,
    pub(super) owner_companion_retained_bytes: Arc<AtomicUsize>,
    pub(super) owner_companion_sources: Arc<Mutex<HashMap<String, Arc<OwnerCompanionSource>>>>,
    pub(super) companion_materialization_budget: Arc<CompanionMaterializationBudget>,
    pub(super) owner_companion_encoding_slots: Arc<Semaphore>,
    pub(super) owner_companion_observers:
        Arc<Mutex<HashMap<(String, String), OwnerCompanionObserver>>>,
    pub(super) companion_proof_nonces: Arc<Mutex<HashMap<(String, String), Instant>>>,
    pub(super) preauth_requests: Arc<Semaphore>,
}

pub(super) type CompanionObserverGenerations = Arc<Mutex<HashMap<(String, String), (u64, String)>>>;

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
    pub(super) terminal_observers: Arc<Mutex<HashMap<(String, String), TerminalObserverSlot>>>,
    pub(super) legacy_artifact_memory_permits: Arc<Semaphore>,
    pub(super) peer_request_permits: Arc<Semaphore>,
    pub(super) artifact_peer_request_permits: Arc<Semaphore>,
    pub(super) mark_read_peer_request_permits: Arc<Semaphore>,
    pub(super) receipt_events: Mutex<mpsc::Receiver<OutgoingTransferCommittedEvent>>,
    pub(super) companion_observers: Arc<Mutex<HashMap<(String, String), CompanionObserver>>>,
    pub(super) companion_observer_generations: CompanionObserverGenerations,
    pub(super) owner_companion_observers:
        Arc<Mutex<HashMap<(String, String), OwnerCompanionObserver>>>,
    pub(super) active_owner_companions: Arc<AtomicUsize>,
    pub(super) owner_companion_retained_bytes: Arc<AtomicUsize>,
    pub(super) owner_companion_sources: Arc<Mutex<HashMap<String, Arc<OwnerCompanionSource>>>>,
    pub(super) companion_materialization_budget: Arc<CompanionMaterializationBudget>,
    pub(super) companion_inbound_decode_budget: Arc<CompanionInboundByteBudget>,
    pub(super) companion_inbound_decode_slots: Arc<Semaphore>,
    pub(super) preauth_requests: Arc<Semaphore>,
    pub(super) incoming_sender: RuntimeEventSender,
    pub(super) incoming_events: Mutex<RuntimeEventReceiver>,
    pub(super) request_counter: Arc<AtomicU64>,
    pub(super) request_namespace: String,
    pub(super) listener_task: JoinHandle<()>,
    pub(super) receipt_retry_task: JoinHandle<()>,
    pub(super) registry_entry_path: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct StoredIdentity {
    pub(super) secret_key: String,
}
