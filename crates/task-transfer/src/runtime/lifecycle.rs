use super::companion::{
    open_owner_control_payload, open_peer_companion_stream, seal_observe_companion_proof,
    seal_send_companion_event_proof, stream_peer_companion, CompanionInboundByteBudget,
    MAX_COMPANION_INBOUND_DECODE_BYTES, MAX_CONCURRENT_COMPANION_INBOUND_DECODES,
};
use super::config::{DiscoveryMode, RuntimeConfig};
use super::daemon::{stream_peer_session, PeerSessionBridge};
use super::discovery::{MdnsDiscovery, PeerDiscovery};
use super::events::{RuntimeError, RuntimeEvent};
use super::external_peers;
use super::listener::{run_listener, MAX_CONCURRENT_PREAUTH_REQUESTS};
use super::replay_store::{unix_ms, TransferReplayStore};
use super::state::{
    install_companion_observer_if_latest, remove_companion_observer_generation,
    remove_companion_observer_registration, runtime_event_channel_with_capacity, CompanionObserver,
    ListenerContext, RuntimeEventSender, TerminalObserverSlot, TransferRuntime,
};
use super::utils::{
    load_or_create_identity, registry_entry_path, remove_managed_artifact_root,
    supports_duplex_terminal, supports_terminal_input_semantics, terminal_observer_key,
    unexpected_peer_response, CURRENT_PROTOCOL_VERSION,
};
use crate::crypto::{parse_public_key, public_key_to_string, seal_json};
use crate::discovery::encode_txt_record;
use crate::protocol::COMPANION_PROTOCOL_VERSION;
use crate::protocol::{
    DiscoveredPeer, LocalTransferIdentity, PeerTaskSnapshot, PeerTaskSnapshotIssue,
    PeerTaskSnapshotListing,
};
use crate::protocol::{
    PeerRegistryEntry, PeerRequest, PeerResponse, PeerTerminalControl, PeerTerminalEvent,
};
use crate::registry::PeerRegistry;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kanna_agent_protocol::{CompanionEvent, ServerFrame};
use rand_core::{OsRng, RngCore};
use serde_json::Value;
use std::collections::HashMap;
use std::process;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
#[cfg(test)]
use std::sync::{Mutex as StdMutex, OnceLock};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex, Semaphore};

#[cfg(test)]
struct CompanionRegistrationTestGate {
    blocked_generation: String,
    contender_generation: String,
    blocked: tokio::sync::Notify,
    release: tokio::sync::Notify,
    contender_entered: tokio::sync::Notify,
    contender_passed: tokio::sync::Notify,
}

#[cfg(test)]
pub(super) struct CompanionRegistrationTestGateGuard(Arc<CompanionRegistrationTestGate>);

#[cfg(test)]
static COMPANION_REGISTRATION_TEST_GATE: OnceLock<
    StdMutex<Option<Arc<CompanionRegistrationTestGate>>>,
> = OnceLock::new();

#[cfg(test)]
pub(super) fn install_companion_registration_test_gate(
    blocked_generation: &str,
    contender_generation: &str,
) -> CompanionRegistrationTestGateGuard {
    let gate = Arc::new(CompanionRegistrationTestGate {
        blocked_generation: blocked_generation.to_owned(),
        contender_generation: contender_generation.to_owned(),
        blocked: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        contender_entered: tokio::sync::Notify::new(),
        contender_passed: tokio::sync::Notify::new(),
    });
    *COMPANION_REGISTRATION_TEST_GATE
        .get_or_init(|| StdMutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));
    CompanionRegistrationTestGateGuard(gate)
}

#[cfg(test)]
impl CompanionRegistrationTestGateGuard {
    pub(super) async fn wait_until_blocked(&self) {
        self.0.blocked.notified().await;
    }

    pub(super) fn release(&self) {
        self.0.release.notify_one();
    }

    pub(super) async fn wait_until_contender_entered(&self) {
        self.0.contender_entered.notified().await;
    }

    pub(super) async fn wait_until_contender_passed(&self) {
        self.0.contender_passed.notified().await;
    }
}

#[cfg(test)]
impl Drop for CompanionRegistrationTestGateGuard {
    fn drop(&mut self) {
        self.0.release.notify_one();
        let mut installed = COMPANION_REGISTRATION_TEST_GATE
            .get_or_init(|| StdMutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if installed
            .as_ref()
            .is_some_and(|gate| Arc::ptr_eq(gate, &self.0))
        {
            *installed = None;
        }
    }
}

#[cfg(test)]
fn notify_companion_registration_test_gate_entered(generation: &str) {
    let gate = COMPANION_REGISTRATION_TEST_GATE
        .get_or_init(|| StdMutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .filter(|gate| gate.contender_generation == generation)
        .cloned();
    if let Some(gate) = gate {
        gate.contender_entered.notify_one();
    }
}

#[cfg(not(test))]
fn notify_companion_registration_test_gate_entered(_generation: &str) {}

#[cfg(test)]
async fn wait_for_companion_registration_test_gate(generation: &str) {
    let gate = COMPANION_REGISTRATION_TEST_GATE
        .get_or_init(|| StdMutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(gate) = gate {
        if gate.contender_generation == generation {
            gate.contender_passed.notify_one();
            return;
        }
        if gate.blocked_generation == generation {
            gate.blocked.notify_one();
            gate.release.notified().await;
        }
    }
}

#[cfg(not(test))]
async fn wait_for_companion_registration_test_gate(_generation: &str) {}

struct CompanionObserverRegistrationRollback {
    latest_generations: super::state::CompanionObserverGenerations,
    incoming_sender: RuntimeEventSender,
    observer_key: (String, String),
    generation: String,
    generation_order: u64,
    armed: bool,
}

impl CompanionObserverRegistrationRollback {
    fn new(
        latest_generations: super::state::CompanionObserverGenerations,
        incoming_sender: RuntimeEventSender,
        observer_key: (String, String),
        generation: String,
        generation_order: u64,
    ) -> Self {
        Self {
            latest_generations,
            incoming_sender,
            observer_key,
            generation,
            generation_order,
            armed: true,
        }
    }

    async fn rollback(&mut self) {
        if !self.armed {
            return;
        }
        let removed = remove_companion_observer_registration(
            &mut *self.latest_generations.lock().await,
            &self.observer_key,
            &self.generation,
            self.generation_order,
        );
        if removed {
            self.incoming_sender.unregister_companion_generation(
                &self.observer_key.0,
                &self.observer_key.1,
                &self.generation,
                self.generation_order,
            );
        }
        self.armed = false;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CompanionObserverRegistrationRollback {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut latest_generations) = self.latest_generations.try_lock() {
            let removed = remove_companion_observer_registration(
                &mut latest_generations,
                &self.observer_key,
                &self.generation,
                self.generation_order,
            );
            if removed {
                self.incoming_sender.unregister_companion_generation(
                    &self.observer_key.0,
                    &self.observer_key.1,
                    &self.generation,
                    self.generation_order,
                );
            }
            return;
        }

        let latest_generations = Arc::clone(&self.latest_generations);
        let incoming_sender = self.incoming_sender.clone();
        let observer_key = self.observer_key.clone();
        let generation = self.generation.clone();
        let generation_order = self.generation_order;
        tokio::spawn(async move {
            let removed = remove_companion_observer_registration(
                &mut *latest_generations.lock().await,
                &observer_key,
                &generation,
                generation_order,
            );
            if removed {
                incoming_sender.unregister_companion_generation(
                    &observer_key.0,
                    &observer_key.1,
                    &generation,
                    generation_order,
                );
            }
        });
    }
}

impl TransferRuntime {
    pub fn local_identity(&self) -> LocalTransferIdentity {
        LocalTransferIdentity {
            peer_id: self.config.peer_id.clone(),
            display_name: self.config.display_name.clone(),
            public_key: public_key_to_string(&self.identity.public_key),
            // The cloud/LAN bridge identity remains protocol v1 for the
            // deployed mobile compatibility contract. Direct peer discovery
            // advertises CURRENT_PROTOCOL_VERSION separately.
            protocol_version: 1,
            accepting_transfers: true,
        }
    }

    pub async fn spawn(mut config: RuntimeConfig) -> Result<Self, RuntimeError> {
        crate::discovery::validate_peer_id(&config.peer_id)
            .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;
        let cleanup_registry_dir = config.registry_dir.clone();
        let cleanup_peer_id = config.peer_id.clone();
        tokio::task::spawn_blocking(move || {
            remove_managed_artifact_root(&cleanup_registry_dir, &cleanup_peer_id)
        })
        .await
        .map_err(|error| {
            std::io::Error::other(format!("managed artifact cleanup task failed: {error}"))
        })??;
        let listener = TcpListener::bind((config.bind_host(), config.listen_port)).await?;
        config.listen_port = listener.local_addr()?.port();
        let identity = load_or_create_identity(&config.registry_dir, &config.peer_id)?;
        let public_key = public_key_to_string(&identity.public_key);
        let _ = encode_txt_record(
            &config.peer_id,
            &config.display_name,
            &public_key,
            CURRENT_PROTOCOL_VERSION,
            true,
        )
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
                    protocol_version: CURRENT_PROTOCOL_VERSION,
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
        #[cfg(test)]
        let discovery = config
            .mdns_fixture
            .as_ref()
            .map(|state| PeerDiscovery::MdnsFixture(Arc::clone(state)))
            .unwrap_or(discovery);
        let (incoming_sender, incoming_receiver) =
            runtime_event_channel_with_capacity(config.max_lifecycle_events.max(1));
        let (receipt_sender, receipt_receiver) =
            mpsc::channel(config.max_unapplied_receipts.max(1));
        let pending_pairing_requests = Arc::new(Mutex::new(HashMap::new()));
        let pending_task_pull_requests = Arc::new(Mutex::new(HashMap::new()));
        let external_peers = external_peers::registry();
        let replay_store = Arc::new(TransferReplayStore::new(
            &config.registry_dir,
            &config.peer_id,
            config.pending_transfer_ttl,
            config.applied_receipt_ttl,
            config.max_unapplied_receipts,
            config.max_applied_receipts,
            config.max_incoming_reservations,
        ));
        let mut loaded_outgoing_transfers = replay_store.load_outgoing_reservations()?;
        let mut loaded_receipts = replay_store.load_receipts()?;
        for (transfer_id, receipt) in &mut loaded_receipts {
            if loaded_outgoing_transfers.remove(transfer_id).is_some() {
                replay_store.remove_reservation(transfer_id);
            }
            receipt.try_queue_event(transfer_id, &receipt_sender)?;
        }
        let outgoing_transfers = Arc::new(Mutex::new(loaded_outgoing_transfers));
        let import_commit_receipts = Arc::new(Mutex::new(loaded_receipts));
        let pending_outgoing_transfer_finalizations = Arc::new(Mutex::new(HashMap::new()));
        let loaded_incoming_reservations = replay_store.load_incoming_reservations()?;
        for reservation in loaded_incoming_reservations.values() {
            if reservation.committed && !reservation.event_recorded {
                if let Some(event) = reservation.event.clone() {
                    incoming_sender
                        .try_send(RuntimeEvent::IncomingTransferRequest(event))
                        .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
                }
            }
        }
        let incoming_reservations = Arc::new(Mutex::new(loaded_incoming_reservations));
        let transfer_artifacts = Arc::new(Mutex::new(HashMap::new()));
        let loaded_authenticated_peer_requests = replay_store.load_authenticated_peer_requests()?;
        if loaded_authenticated_peer_requests.len() > config.max_authenticated_request_replays {
            return Err(RuntimeError::InvalidConfig(format!(
                "replay store contains {} authenticated requests, exceeding configured maximum {}",
                loaded_authenticated_peer_requests.len(),
                config.max_authenticated_request_replays,
            )));
        }
        let authenticated_peer_requests = Arc::new(Mutex::new(loaded_authenticated_peer_requests));
        let task_snapshot = Arc::new(Mutex::new(Value::Null));
        let terminal_observers = Arc::new(Mutex::new(HashMap::new()));
        let incoming_connection_permits = Arc::new(Semaphore::new(config.max_incoming_connections));
        // Legacy serialization and receive both retain whole-file nested
        // base64/JSON buffers. One shared admission gate makes the declared
        // process-memory budget aggregate across both directions.
        let legacy_artifact_memory_permits = Arc::new(Semaphore::new(1));
        let peer_request_permits = Arc::new(Semaphore::new(config.max_peer_requests));
        // Artifact responses use a deliberately larger frame budget than task
        // metadata. Keep them single-flight so that bound is not multiplied by
        // the ordinary concurrent request limit.
        let artifact_peer_request_permits = Arc::new(Semaphore::new(1));
        let mark_read_peer_request_permits =
            Arc::new(Semaphore::new(config.max_mark_read_peer_requests));
        let companion_observers = Arc::new(Mutex::new(HashMap::new()));
        let companion_observer_generations = Arc::new(Mutex::new(HashMap::new()));
        let active_owner_companions = Arc::new(AtomicUsize::new(0));
        let owner_companion_retained_bytes = Arc::new(AtomicUsize::new(0));
        let owner_companion_sources = Arc::new(Mutex::new(HashMap::new()));
        let companion_materialization_budget = Arc::new(
            kanna_visual_companion::CompanionMaterializationBudget::new(2, 64 * 1024 * 1024),
        );
        let companion_inbound_decode_budget = Arc::new(CompanionInboundByteBudget::new(
            MAX_COMPANION_INBOUND_DECODE_BYTES,
        ));
        let companion_inbound_decode_slots =
            Arc::new(Semaphore::new(MAX_CONCURRENT_COMPANION_INBOUND_DECODES));
        let owner_companion_encoding_slots = Arc::new(Semaphore::new(2));
        let owner_companion_observers = Arc::new(Mutex::new(HashMap::new()));
        let companion_proof_nonces = Arc::new(Mutex::new(HashMap::new()));
        let preauth_requests = Arc::new(Semaphore::new(MAX_CONCURRENT_PREAUTH_REQUESTS));
        let request_counter = Arc::new(AtomicU64::new(1));
        let request_namespace = random_request_namespace();
        let listener_context = ListenerContext {
            self_peer_id: config.peer_id.clone(),
            self_display_name: config.display_name.clone(),
            self_public_key: public_key,
            authenticated_request_epoch: random_request_namespace(),
            registry_root: config.registry_dir.clone(),
            discovery: discovery.clone(),
            external_peers: Arc::clone(&external_peers),
            pending_transfer_ttl: config.pending_transfer_ttl,
            authenticated_request_freshness: config.authenticated_request_freshness,
            peer_request_timeout: config.peer_request_timeout,
            finalization_request_timeout: config.finalization_request_timeout,
            incoming_connection_permits,
            legacy_artifact_memory_permits: Arc::clone(&legacy_artifact_memory_permits),
            max_pending_pairing_requests: config.max_lifecycle_events,
            max_task_pull_requests: config.max_task_pull_requests,
            max_finalization_waiters: config.max_finalization_waiters,
            pending_pairing_requests: Arc::clone(&pending_pairing_requests),
            pending_task_pull_requests: Arc::clone(&pending_task_pull_requests),
            outgoing_transfers: Arc::clone(&outgoing_transfers),
            import_commit_receipts: Arc::clone(&import_commit_receipts),
            replay_store: Arc::clone(&replay_store),
            pending_outgoing_transfer_finalizations: Arc::clone(
                &pending_outgoing_transfer_finalizations,
            ),
            incoming_reservations: Arc::clone(&incoming_reservations),
            transfer_artifacts: Arc::clone(&transfer_artifacts),
            authenticated_peer_requests,
            max_authenticated_request_replays: config.max_authenticated_request_replays,
            task_snapshot: Arc::clone(&task_snapshot),
            db_path: config.db_path.clone(),
            daemon_dir: config.daemon_dir.clone(),
            kanna_server_port: config.kanna_server_port,
            request_counter: Arc::clone(&request_counter),
            incoming_sender: incoming_sender.clone(),
            receipt_sender: receipt_sender.clone(),
            active_owner_companions: Arc::clone(&active_owner_companions),
            owner_companion_retained_bytes: Arc::clone(&owner_companion_retained_bytes),
            owner_companion_sources: Arc::clone(&owner_companion_sources),
            companion_materialization_budget: Arc::clone(&companion_materialization_budget),
            owner_companion_encoding_slots,
            owner_companion_observers: Arc::clone(&owner_companion_observers),
            companion_proof_nonces,
            preauth_requests: Arc::clone(&preauth_requests),
        };
        let listener_task = tokio::spawn(run_listener(listener, listener_context));
        let retry_receipts = Arc::clone(&import_commit_receipts);
        let retry_sender = receipt_sender.clone();
        let retry_interval = config
            .receipt_retry_interval
            .max(std::time::Duration::from_millis(1));
        let receipt_retry_task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(retry_interval);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let mut receipts = retry_receipts.lock().await;
                for (transfer_id, receipt) in receipts.iter_mut() {
                    if receipt.try_queue_event(transfer_id, &retry_sender).is_err() {
                        return;
                    }
                }
            }
        });

        Ok(Self {
            config,
            discovery,
            external_peers,
            identity,
            pending_pairing_requests,
            outgoing_transfers,
            import_commit_receipts,
            replay_store,
            pending_outgoing_transfer_finalizations,
            incoming_reservations,
            transfer_artifacts,
            task_snapshot,
            terminal_observers,
            legacy_artifact_memory_permits,
            peer_request_permits,
            artifact_peer_request_permits,
            mark_read_peer_request_permits,
            companion_observers,
            companion_observer_generations,
            owner_companion_observers,
            active_owner_companions,
            owner_companion_retained_bytes,
            owner_companion_sources,
            companion_materialization_budget,
            companion_inbound_decode_budget,
            companion_inbound_decode_slots,
            preauth_requests,
            incoming_sender,
            incoming_events: Mutex::new(incoming_receiver),
            receipt_events: Mutex::new(receipt_receiver),
            request_counter,
            request_namespace,
            listener_task,
            receipt_retry_task,
            registry_entry_path,
        })
    }

    pub async fn list_peers(&self) -> Result<Vec<DiscoveredPeer>, RuntimeError> {
        let mut peers = self.discovery.list_peers(&self.config.peer_id).await?;
        let mut external = external_peers::external_peers(&self.external_peers);
        external.sort_by(|left, right| left.peer_id.cmp(&right.peer_id));
        for peer in external {
            if !peers
                .iter()
                .any(|existing| existing.peer_id == peer.peer_id)
            {
                peers.push(external_peers::external_entry(&peer));
            }
        }
        peers.sort_by(|left, right| left.peer_id.cmp(&right.peer_id));
        peers
            .into_iter()
            .map(|peer| self.discovered_peer(peer))
            .collect()
    }

    pub async fn set_task_snapshot(&self, snapshot: Value) -> Result<(), RuntimeError> {
        *self.task_snapshot.lock().await = snapshot;
        Ok(())
    }

    pub async fn list_peer_task_snapshots(&self) -> Result<PeerTaskSnapshotListing, RuntimeError> {
        // Remote cloud tasks arrive through the Firestore subscription. Keep
        // the one-second LAN refresh on discovery routes only so a registered
        // external peer cannot turn polling into repeated relay tunnels.
        let peers = self
            .discovery
            .list_peers(&self.config.peer_id)
            .await?
            .into_iter()
            .map(|peer| self.discovered_peer(peer))
            .collect::<Result<Vec<_>, _>>()?;
        let mut snapshots = Vec::new();
        let mut issues = Vec::new();
        for peer in peers.into_iter().filter(|peer| {
            self.trusted_peer_record(&peer.peer_id)
                .ok()
                .flatten()
                .map(|record| record.public_key == peer.public_key)
                .unwrap_or(false)
        }) {
            match self.fetch_peer_task_snapshot(&peer).await {
                Ok(snapshot) => snapshots.push(snapshot),
                Err(error) => {
                    let message = error.to_string();
                    eprintln!(
                        "[task-transfer] failed to fetch task snapshot from {}: {}",
                        peer.peer_id, message
                    );
                    issues.push(PeerTaskSnapshotIssue {
                        peer_id: peer.peer_id,
                        display_name: peer.display_name,
                        message,
                    });
                }
            }
        }
        Ok(PeerTaskSnapshotListing { snapshots, issues })
    }

    async fn fetch_peer_task_snapshot(
        &self,
        peer: &DiscoveredPeer,
    ) -> Result<PeerTaskSnapshot, RuntimeError> {
        let request_id = self.next_request_id("task-snapshot");
        let target_peer = PeerRegistryEntry {
            peer_id: peer.peer_id.clone(),
            display_name: peer.display_name.clone(),
            endpoint: peer.endpoint.clone(),
            pid: peer.pid,
            public_key: peer.public_key.clone(),
            protocol_version: peer.protocol_version,
            accepting_transfers: peer.accepting_transfers,
        };
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "get_task_snapshot",
                &request_id,
                serde_json::json!({}),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::GetTaskSnapshot {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload: Some(sealed_payload),
                },
            )
            .await?;
        match response {
            PeerResponse::TaskSnapshot {
                request_id: response_request_id,
                peer_id: response_peer_id,
                display_name,
                snapshot,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "peer {} returned task snapshot request id {} for {}",
                        peer.peer_id, response_request_id, request_id
                    )));
                }
                if response_peer_id != peer.peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "peer {} returned task snapshot for mismatched peer {}",
                        peer.peer_id, response_peer_id
                    )));
                }
                Ok(PeerTaskSnapshot {
                    peer_id: peer.peer_id.clone(),
                    display_name,
                    snapshot,
                })
            }
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(format!(
                "peer {} rejected task snapshot request: {}",
                peer.peer_id, message
            ))),
            other => Err(unexpected_peer_response("task snapshot", &other)),
        }
    }

    pub async fn observe_peer_session(
        &self,
        target_peer_id: &str,
        session_id: &str,
        observer_lease_id: &str,
    ) -> Result<(), RuntimeError> {
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        let lease_id = observer_lease_id.to_owned();
        let observer_lease_key = (observer_key.clone(), lease_id.clone());
        let mut observers = self.terminal_observers.lock().await;
        prune_terminal_observer_tombstones(
            &mut observers,
            self.config.terminal_observer_tombstone_ttl,
            self.config.max_terminal_observer_tombstones,
        );
        if observers
            .get(&observer_lease_key)
            .is_some_and(|slot| slot.closed)
        {
            return Ok(());
        }
        let displaced_keys = observers
            .iter()
            .filter_map(|(key, slot)| {
                (key.0 == observer_key && !slot.closed).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        for displaced_key in displaced_keys {
            if let Some(displaced) = observers.remove(&displaced_key) {
                if let Some(handle) = displaced.handle {
                    handle.abort();
                }
            }
        }
        observers.insert(
            observer_lease_key.clone(),
            TerminalObserverSlot {
                closed: false,
                closed_at: None,
                handle: None,
                control_sender: None,
            },
        );
        drop(observers);

        let target_peer = match self.find_peer(target_peer_id).await {
            Ok(target_peer) => target_peer,
            Err(error) => {
                self.clear_terminal_observer_lease(&observer_key, &lease_id)
                    .await;
                return Err(error);
            }
        };
        if let Err(error) =
            self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)
        {
            self.clear_terminal_observer_lease(&observer_key, &lease_id)
                .await;
            return Err(error);
        }

        // Discovery can be delayed while an unobserve or replacement races this
        // request. Recheck the lease before the owner-epoch network round trip so
        // a displaced observer never reaches the peer at all.
        if self
            .terminal_observers
            .lock()
            .await
            .get(&observer_lease_key)
            .is_none_or(|slot| slot.closed)
        {
            return Ok(());
        }

        let request_id = self.next_request_id("observe-session");
        let sealed_payload = match self
            .seal_authenticated_peer_request(
                &target_peer,
                "observe_session",
                &request_id,
                serde_json::json!({ "session_id": session_id }),
            )
            .await
        {
            Ok(sealed_payload) => sealed_payload,
            Err(error) => {
                self.clear_terminal_observer_lease(&observer_key, &lease_id)
                    .await;
                return Err(error);
            }
        };
        let self_peer_id = self.config.peer_id.clone();
        let session_id = session_id.to_owned();
        let incoming_sender = self.incoming_sender.clone();
        let peer_for_task = target_peer.clone();
        let peer_id_for_error = target_peer.peer_id.clone();
        let session_id_for_error = session_id.clone();
        let observer_lease_id_for_task = lease_id.clone();
        let (control_sender, control_receiver) =
            if supports_duplex_terminal(target_peer.protocol_version) {
                let (sender, receiver) = mpsc::channel(256);
                (Some(sender), Some(receiver))
            } else {
                (None, None)
            };
        let mut observers = self.terminal_observers.lock().await;
        let Some(slot) = observers
            .get_mut(&observer_lease_key)
            .filter(|slot| !slot.closed)
        else {
            return Ok(());
        };
        slot.control_sender = control_sender;
        let handle = tokio::spawn(async move {
            if let Err(error) = stream_peer_session(
                peer_for_task,
                request_id.clone(),
                self_peer_id,
                session_id.clone(),
                sealed_payload,
                PeerSessionBridge {
                    observer_lease_id: observer_lease_id_for_task.clone(),
                    incoming_sender: incoming_sender.clone(),
                    control_receiver,
                },
            )
            .await
            {
                let _ = incoming_sender.try_send(RuntimeEvent::TerminalEvent {
                    peer_id: peer_id_for_error,
                    session_id: session_id_for_error.clone(),
                    observer_lease_id: observer_lease_id_for_task,
                    event: PeerTerminalEvent::Error {
                        session_id: session_id_for_error,
                        message: error.to_string(),
                    },
                });
            }
        });
        if let Some(displaced) = slot.handle.replace(handle) {
            displaced.abort();
        }
        Ok(())
    }

    pub async fn unobserve_peer_session(
        &self,
        target_peer_id: &str,
        session_id: &str,
        observer_lease_id: &str,
    ) -> Result<(), RuntimeError> {
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        let observer_lease_key = (observer_key, observer_lease_id.to_owned());
        let mut observers = self.terminal_observers.lock().await;
        prune_terminal_observer_tombstones(
            &mut observers,
            self.config.terminal_observer_tombstone_ttl,
            self.config.max_terminal_observer_tombstones,
        );
        match observers.get_mut(&observer_lease_key) {
            Some(slot) => {
                slot.closed = true;
                slot.closed_at = Some(std::time::Instant::now());
                slot.control_sender = None;
                if let Some(handle) = slot.handle.take() {
                    handle.abort();
                }
            }
            None => {
                observers.insert(
                    observer_lease_key,
                    TerminalObserverSlot {
                        closed: true,
                        closed_at: Some(std::time::Instant::now()),
                        handle: None,
                        control_sender: None,
                    },
                );
            }
        }
        prune_terminal_observer_tombstones(
            &mut observers,
            self.config.terminal_observer_tombstone_ttl,
            self.config.max_terminal_observer_tombstones,
        );
        Ok(())
    }

    async fn clear_terminal_observer_lease(&self, observer_key: &str, lease_id: &str) {
        let observer_lease_key = (observer_key.to_owned(), lease_id.to_owned());
        let mut observers = self.terminal_observers.lock().await;
        if observers
            .get(&observer_lease_key)
            .is_some_and(|slot| !slot.closed)
        {
            if let Some(slot) = observers.remove(&observer_lease_key) {
                if let Some(handle) = slot.handle {
                    handle.abort();
                }
            }
        }
    }

    pub async fn observe_peer_companion(
        &self,
        target_peer_id: &str,
        task_id: &str,
        generation: &str,
    ) -> Result<(), RuntimeError> {
        let observer_order = self.request_counter.fetch_add(1, Ordering::Relaxed);
        let observer_key = (target_peer_id.to_owned(), task_id.to_owned());
        let generation = generation.to_owned();
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        if target_peer.protocol_version < COMPANION_PROTOCOL_VERSION {
            return Err(RuntimeError::Protocol(
                "peer does not support visual companions".into(),
            ));
        }
        notify_companion_registration_test_gate_entered(&generation);
        let (replaced, mut registration_rollback) = {
            let mut latest_generations = self.companion_observer_generations.lock().await;
            if latest_generations
                .get(&observer_key)
                .is_some_and(|(latest_order, _)| *latest_order > observer_order)
            {
                return Ok(());
            }
            let previous_registration = latest_generations.get(&observer_key).cloned();
            let mut observers = self.companion_observers.lock().await;
            let replaced =
                previous_registration.and_then(|(previous_order, previous_generation)| {
                    if observers.get(&observer_key).is_some_and(|observer| {
                        observer.generation_order == previous_order
                            && observer.generation == previous_generation
                    }) {
                        observers.remove(&observer_key)
                    } else {
                        None
                    }
                });
            latest_generations.insert(observer_key.clone(), (observer_order, generation.clone()));
            self.incoming_sender.register_companion_generation(
                target_peer_id,
                task_id,
                &generation,
                observer_order,
            );
            let registration_rollback = CompanionObserverRegistrationRollback::new(
                Arc::clone(&self.companion_observer_generations),
                self.incoming_sender.clone(),
                observer_key.clone(),
                generation.clone(),
                observer_order,
            );
            wait_for_companion_registration_test_gate(&generation).await;
            (replaced, registration_rollback)
        };
        if let Some(observer) = replaced {
            observer.handle.abort();
            self.incoming_sender.invalidate_companion(
                target_peer_id,
                task_id,
                &observer.generation,
                observer.generation_order,
            );
        }

        let opening = async {
            let request_id = self.next_request_id("observe-companion");
            let target_public = parse_public_key(&target_peer.public_key)?;
            let (sealed_proof, stream_nonce) = seal_observe_companion_proof(
                &self.identity,
                &target_public,
                &request_id,
                &self.config.peer_id,
                task_id,
                &generation,
            )?;
            let (stream, observation_challenge) = tokio::time::timeout(
                self.config.peer_request_timeout,
                open_peer_companion_stream(
                    crate::runtime::companion::PeerCompanionOpen {
                        peer: target_peer.clone(),
                        request_id: request_id.clone(),
                        requester_peer_id: self.config.peer_id.clone(),
                        task_id: task_id.to_owned(),
                        generation: generation.clone(),
                        sealed_proof,
                        stream_nonce: stream_nonce.clone(),
                    },
                    &self.identity,
                ),
            )
            .await
            .map_err(|_| RuntimeError::PeerRequestTimeout {
                peer_id: target_peer.peer_id.clone(),
                timeout_ms: self.config.peer_request_timeout.as_millis(),
            })??;
            Ok::<_, RuntimeError>((request_id, stream_nonce, stream, observation_challenge))
        }
        .await;
        let (request_id, stream_nonce, stream, observation_challenge) = match opening {
            Ok(opened) => opened,
            Err(error) => {
                registration_rollback.rollback().await;
                return Err(error);
            }
        };
        let task_id = task_id.to_owned();
        let incoming_sender = self.incoming_sender.clone();
        let peer_for_task = target_peer.clone();
        let peer_id_for_error = target_peer.peer_id.clone();
        let task_id_for_error = task_id.clone();
        let task_id_for_install = task_id.clone();
        let observers_for_cleanup = Arc::clone(&self.companion_observers);
        let generations_for_cleanup = Arc::clone(&self.companion_observer_generations);
        let observer_key_for_cleanup = observer_key.clone();
        let generation_for_cleanup = generation.clone();
        let request_id_for_stream = request_id;
        let stream_nonce_for_stream = stream_nonce.clone();
        let observation_challenge_for_stream = observation_challenge.clone();
        let identity_for_stream = self.identity.clone();
        let inbound_decode_slots = Arc::clone(&self.companion_inbound_decode_slots);
        let inbound_decode_budget = Arc::clone(&self.companion_inbound_decode_budget);
        let (start_sender, start_receiver) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            if start_receiver.await.is_err() {
                return;
            }
            if let Err(error) = stream_peer_companion(
                crate::runtime::companion::PeerCompanionStream {
                    peer: peer_for_task,
                    task_id: task_id.clone(),
                    generation: generation_for_cleanup.clone(),
                    generation_order: observer_order,
                    request_id: request_id_for_stream,
                    stream_nonce: stream_nonce_for_stream,
                    observation_challenge: observation_challenge_for_stream,
                    identity: identity_for_stream,
                    incoming_sender: incoming_sender.clone(),
                    inbound_decode_slots,
                    inbound_decode_budget,
                },
                stream,
            )
            .await
            {
                let _ = incoming_sender
                    .send(RuntimeEvent::CompanionEvent {
                        peer_id: peer_id_for_error.clone(),
                        task_id: task_id_for_error.clone(),
                        generation: generation_for_cleanup.clone(),
                        generation_order: observer_order,
                        frame: ServerFrame::CompanionError {
                            task_id: task_id_for_error.clone(),
                            code: "connection_failed".into(),
                            message: error.to_string(),
                            attachment_epoch: None,
                        },
                    })
                    .await;
            }
            let removed = {
                let mut latest_generations = generations_for_cleanup.lock().await;
                let mut observers = observers_for_cleanup.lock().await;
                let removed = remove_companion_observer_generation(
                    &mut observers,
                    &observer_key_for_cleanup,
                    &generation_for_cleanup,
                    observer_order,
                );
                if removed {
                    remove_companion_observer_registration(
                        &mut latest_generations,
                        &observer_key_for_cleanup,
                        &generation_for_cleanup,
                        observer_order,
                    );
                }
                removed
            };
            if removed {
                incoming_sender.unregister_companion_generation(
                    &peer_id_for_error,
                    &task_id_for_error,
                    &generation_for_cleanup,
                    observer_order,
                );
            }
        });
        let candidate = CompanionObserver {
            generation,
            generation_order: observer_order,
            handle,
            stream_nonce,
            observation_challenge,
            next_event_sequence: Arc::new(AtomicU64::new(1)),
            send_lock: Arc::new(Mutex::new(())),
        };
        let installation = {
            let latest_generations = self.companion_observer_generations.lock().await;
            let mut observers = self.companion_observers.lock().await;
            install_companion_observer_if_latest(
                &latest_generations,
                &mut observers,
                observer_key,
                candidate,
            )
        };
        match installation {
            Ok(replaced) => {
                registration_rollback.disarm();
                if let Some(replaced) = replaced {
                    replaced.handle.abort();
                    self.incoming_sender.invalidate_companion(
                        target_peer_id,
                        &task_id_for_install,
                        &replaced.generation,
                        replaced.generation_order,
                    );
                }
            }
            Err(stale) => {
                stale.handle.abort();
                registration_rollback.rollback().await;
                return Ok(());
            }
        }
        let _ = start_sender.send(());
        Ok(())
    }

    pub async fn unobserve_peer_companion(
        &self,
        target_peer_id: &str,
        task_id: &str,
        generation: &str,
    ) -> Result<(), RuntimeError> {
        let observer_key = (target_peer_id.to_owned(), task_id.to_owned());
        let mut latest_generations = self.companion_observer_generations.lock().await;
        let mut observers = self.companion_observers.lock().await;
        let observer = if observers
            .get(&observer_key)
            .is_some_and(|observer| observer.generation == generation)
        {
            observers.remove(&observer_key)
        } else {
            None
        };
        let registration = latest_generations
            .get(&observer_key)
            .filter(|(_, current_generation)| current_generation == generation)
            .cloned();
        if let Some((generation_order, current_generation)) = &registration {
            remove_companion_observer_registration(
                &mut latest_generations,
                &observer_key,
                current_generation,
                *generation_order,
            );
        }
        drop(observers);
        drop(latest_generations);

        let registration_matches_observer = observer
            .as_ref()
            .zip(registration.as_ref())
            .is_some_and(|(observer, (generation_order, current_generation))| {
                observer.generation_order == *generation_order
                    && observer.generation == current_generation.as_str()
            });
        if let Some(observer) = observer {
            observer.handle.abort();
            if !registration_matches_observer {
                self.incoming_sender.unregister_companion_generation(
                    target_peer_id,
                    task_id,
                    &observer.generation,
                    observer.generation_order,
                );
            }
        }
        if let Some((generation_order, current_generation)) = registration {
            self.incoming_sender.unregister_companion_generation(
                target_peer_id,
                task_id,
                &current_generation,
                generation_order,
            );
        }
        Ok(())
    }

    #[doc(hidden)]
    pub async fn companion_observer_count(&self) -> usize {
        self.companion_observers.lock().await.len()
    }

    #[doc(hidden)]
    pub fn active_owner_companion_count(&self) -> usize {
        self.active_owner_companions.load(Ordering::Acquire)
    }

    #[doc(hidden)]
    pub fn owner_companion_retained_bytes(&self) -> usize {
        self.owner_companion_retained_bytes.load(Ordering::Acquire)
    }

    #[doc(hidden)]
    pub async fn owner_companion_source_count(&self) -> usize {
        // Reading both shared fields here keeps the diagnostics tied to the
        // same runtime-owned admission domain.
        let _ = self.companion_materialization_budget.retained_bytes();
        self.owner_companion_sources.lock().await.len()
    }

    #[doc(hidden)]
    pub async fn owner_companion_observer_count(&self) -> usize {
        self.owner_companion_observers.lock().await.len()
    }

    #[doc(hidden)]
    pub fn active_preauth_request_count(&self) -> usize {
        MAX_CONCURRENT_PREAUTH_REQUESTS - self.preauth_requests.available_permits()
    }

    pub async fn send_peer_companion_event(
        &self,
        target_peer_id: &str,
        task_id: &str,
        session_id: &str,
        revision: &str,
        generation: &str,
        mut event: CompanionEvent,
    ) -> Result<(), RuntimeError> {
        event.session_id = session_id.to_owned();
        event.revision = revision.to_owned();
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        if target_peer.protocol_version < COMPANION_PROTOCOL_VERSION {
            return Err(RuntimeError::Protocol(
                "peer does not support visual companions".into(),
            ));
        }
        let target_public = parse_public_key(&target_peer.public_key)?;
        let observer_key = (target_peer_id.to_owned(), task_id.to_owned());
        let (send_lock, generation_order) = {
            let observers = self.companion_observers.lock().await;
            let observer = observers
                .get(&observer_key)
                .filter(|observer| observer.generation == generation)
                .ok_or_else(|| {
                    RuntimeError::Protocol("companion observation is not active".into())
                })?;
            (Arc::clone(&observer.send_lock), observer.generation_order)
        };
        let _send_guard = send_lock.lock().await;
        let result = async {
            let request_id = self.next_request_id("companion-event");
            let (stream_nonce, observation_challenge, sequence) = {
                let observers = self.companion_observers.lock().await;
                let observer = observers
                    .get(&observer_key)
                    .filter(|observer| {
                        observer.generation == generation
                            && observer.generation_order == generation_order
                    })
                    .ok_or_else(|| {
                        RuntimeError::Protocol("companion observation is not active".into())
                    })?;
                (
                    observer.stream_nonce.clone(),
                    observer.observation_challenge.clone(),
                    observer.next_event_sequence.fetch_add(1, Ordering::AcqRel),
                )
            };
            let sealed_proof = seal_send_companion_event_proof(
                &self.identity,
                &target_public,
                &request_id,
                &self.config.peer_id,
                task_id,
                session_id,
                revision,
                generation,
                &stream_nonce,
                &observation_challenge,
                sequence,
                &event,
            )?;
            let response = self
                .send_peer_request_with_line_limit(
                    &target_peer,
                    PeerRequest::SendCompanionEvent {
                        request_id: request_id.clone(),
                        requester_peer_id: self.config.peer_id.clone(),
                        sealed_payload: sealed_proof,
                    },
                    Some(super::companion::MAX_COMPANION_CONTROL_LINE_BYTES),
                )
                .await?;
            match response {
                PeerResponse::SendCompanionEvent {
                    request_id: response_request_id,
                    sealed_payload,
                } if response_request_id == request_id => {
                    let (
                        operation,
                        bound_request_id,
                        bound_task_id,
                        bound_generation,
                        bound_stream_nonce,
                        bound_observation_challenge,
                        bound_sequence,
                        frame,
                    ) = open_owner_control_payload(
                        &self.identity,
                        &target_public,
                        &sealed_payload,
                    )?;
                    if operation != "companion_event_result"
                        || bound_request_id != request_id
                        || bound_task_id != task_id
                        || bound_generation != generation
                        || bound_stream_nonce != stream_nonce
                        || bound_observation_challenge != observation_challenge
                        || bound_sequence != sequence
                    {
                        return Err(RuntimeError::Protocol(
                            "companion event result binding is invalid".into(),
                        ));
                    }
                    let frame = frame.ok_or_else(|| {
                        RuntimeError::Protocol("companion event result frame is missing".into())
                    })?;
                    if super::companion::frame_task_id(&frame) != Some(task_id) {
                        return Err(RuntimeError::Protocol(
                            "companion event result task is invalid".into(),
                        ));
                    }
                    self.incoming_sender
                        .send(RuntimeEvent::CompanionEvent {
                            peer_id: target_peer.peer_id,
                            task_id: task_id.to_owned(),
                            generation: generation.to_owned(),
                            generation_order,
                            frame,
                        })
                        .await
                        .map_err(|_| RuntimeError::IncomingEventChannelClosed)
                }
                PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
                other => Err(unexpected_peer_response("send-companion-event", &other)),
            }
        }
        .await;
        if result.is_err() {
            let removed = {
                let mut latest_generations = self.companion_observer_generations.lock().await;
                let mut observers = self.companion_observers.lock().await;
                if observers.get(&observer_key).is_some_and(|observer| {
                    observer.generation == generation
                        && observer.generation_order == generation_order
                }) {
                    let removed = observers.remove(&observer_key);
                    remove_companion_observer_registration(
                        &mut latest_generations,
                        &observer_key,
                        generation,
                        generation_order,
                    );
                    removed
                } else {
                    None
                }
            };
            if let Some(observer) = removed {
                observer.handle.abort();
                self.incoming_sender.unregister_companion_generation(
                    target_peer_id,
                    task_id,
                    &observer.generation,
                    observer.generation_order,
                );
            }
        }
        result
    }

    async fn send_observed_terminal_control(
        &self,
        target_peer_id: &str,
        session_id: &str,
        control: PeerTerminalControl,
    ) -> bool {
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        let sender = self
            .terminal_observers
            .lock()
            .await
            .iter()
            .find_map(|((key, _), slot)| {
                (key == &observer_key && !slot.closed)
                    .then(|| slot.control_sender.clone())
                    .flatten()
            });
        let Some(sender) = sender else {
            return false;
        };
        sender.send(control).await.is_ok()
    }

    pub async fn send_peer_session_input(
        &self,
        target_peer_id: &str,
        session_id: &str,
        data: Vec<u8>,
        submission_boundary: bool,
        control_input: bool,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        if !supports_terminal_input_semantics(target_peer.protocol_version) {
            return Err(RuntimeError::Protocol(format!(
                "peer {target_peer_id} uses task-transfer protocol v{} without explicit terminal submission/control semantics; upgrade the peer before sending terminal input",
                target_peer.protocol_version,
            )));
        }
        if self
            .send_observed_terminal_control(
                target_peer_id,
                session_id,
                PeerTerminalControl::Input {
                    session_id: session_id.to_owned(),
                    data: data.clone(),
                    submission_boundary,
                    control_input,
                },
            )
            .await
        {
            return Ok(());
        }
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("send-input");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "send_session_input",
                &request_id,
                serde_json::json!({
                    "session_id": session_id,
                    "data": data,
                    "submission_boundary": submission_boundary,
                    "control_input": control_input,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::SendSessionInput {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    session_id: session_id.to_owned(),
                    data,
                    submission_boundary,
                    control_input,
                    sealed_payload: Some(sealed_payload),
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
        if self
            .send_observed_terminal_control(
                target_peer_id,
                session_id,
                PeerTerminalControl::Resize {
                    session_id: session_id.to_owned(),
                    cols,
                    rows,
                },
            )
            .await
        {
            return Ok(());
        }
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("resize-session");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "resize_session",
                &request_id,
                serde_json::json!({
                    "session_id": session_id,
                    "cols": cols,
                    "rows": rows,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::ResizeSession {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    session_id: session_id.to_owned(),
                    cols,
                    rows,
                    sealed_payload: Some(sealed_payload),
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
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("close-task");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "close_task",
                &request_id,
                serde_json::json!({ "task_id": task_id }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::CloseTask {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                    sealed_payload: Some(sealed_payload),
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
        expected_transition_revision: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("advance-stage");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "advance_task_stage",
                &request_id,
                serde_json::json!({
                    "task_id": task_id,
                    "expected_transition_revision": expected_transition_revision,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::AdvanceTaskStage {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                    expected_transition_revision: expected_transition_revision.map(str::to_owned),
                    sealed_payload: Some(sealed_payload),
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

    pub async fn read_peer_task_file(
        &self,
        target_peer_id: &str,
        task_id: &str,
        path: &str,
    ) -> Result<(String, String), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("read-task-file");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "read_task_file",
                &request_id,
                serde_json::json!({
                    "task_id": task_id,
                    "path": path,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::ReadTaskFile {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                    path: path.to_owned(),
                    sealed_payload: Some(sealed_payload),
                },
            )
            .await?;
        match response {
            PeerResponse::ReadTaskFile {
                request_id: response_request_id,
                path,
                content,
            } if response_request_id == request_id => Ok((path, content)),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("read-task-file", &other)),
        }
    }

    pub async fn read_peer_task_directory(
        &self,
        target_peer_id: &str,
        task_id: &str,
        path: &str,
        show_all_files: bool,
        offset: usize,
        limit: usize,
    ) -> Result<Value, RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("read-task-directory");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "read_task_directory",
                &request_id,
                serde_json::json!({
                    "task_id": task_id,
                    "path": path,
                    "show_all_files": show_all_files,
                    "offset": offset,
                    "limit": limit,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::ReadTaskDirectory {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                    path: path.to_owned(),
                    show_all_files,
                    offset,
                    limit,
                    sealed_payload: Some(sealed_payload),
                },
            )
            .await?;
        match response {
            PeerResponse::ReadTaskDirectory {
                request_id: response_request_id,
                listing,
            } if response_request_id == request_id => Ok(listing),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("read-task-directory", &other)),
        }
    }

    pub async fn read_peer_task_diff(
        &self,
        target_peer_id: &str,
        task_id: &str,
        scope: &str,
        mode: &str,
    ) -> Result<Value, RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("read-task-diff");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "read_task_diff",
                &request_id,
                serde_json::json!({
                    "task_id": task_id,
                    "scope": scope,
                    "mode": mode,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::ReadTaskDiff {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                    scope: scope.to_owned(),
                    mode: mode.to_owned(),
                    sealed_payload: Some(sealed_payload),
                },
            )
            .await?;
        match response {
            PeerResponse::ReadTaskDiff {
                request_id: response_request_id,
                diff,
            } if response_request_id == request_id => Ok(diff),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("read-task-diff", &other)),
        }
    }

    pub async fn mark_peer_task_read(
        &self,
        target_peer_id: &str,
        task_id: &str,
        expected_activity_revision: i64,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("mark-read");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "mark_task_read",
                &request_id,
                serde_json::json!({
                    "task_id": task_id,
                    "expected_activity_revision": expected_activity_revision,
                }),
            )
            .await?;
        let response = self
            .send_mark_read_peer_request_with_timeout(
                &target_peer,
                PeerRequest::MarkTaskRead {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
                self.config.mark_read_timeout,
            )
            .await?;
        match response {
            PeerResponse::MarkTaskRead {
                request_id: response_request_id,
            } if response_request_id == request_id => Ok(()),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("mark-read", &other)),
        }
    }

    pub(super) async fn seal_authenticated_peer_request(
        &self,
        peer: &PeerRegistryEntry,
        action: &str,
        request_id: &str,
        arguments: Value,
    ) -> Result<String, RuntimeError> {
        self.require_authenticated_task_requests(
            &peer.peer_id,
            &peer.public_key,
            peer.protocol_version,
        )?;
        let epoch_request_id = self.next_request_id("owner-epoch");
        let owner_epoch = match self
            .send_peer_request(
                peer,
                PeerRequest::GetAuthenticatedRequestEpoch {
                    request_id: epoch_request_id.clone(),
                },
            )
            .await?
        {
            PeerResponse::AuthenticatedRequestEpoch {
                request_id: response_request_id,
                epoch,
            } if response_request_id == epoch_request_id && !epoch.trim().is_empty() => epoch,
            PeerResponse::Error { message, .. } => return Err(RuntimeError::Protocol(message)),
            other => return Err(unexpected_peer_response("owner epoch", &other)),
        };
        let mut payload = arguments.as_object().cloned().ok_or_else(|| {
            RuntimeError::Protocol("authenticated request arguments must be an object".into())
        })?;
        payload.insert("action".into(), Value::String(action.to_owned()));
        payload.insert("request_id".into(), Value::String(request_id.to_owned()));
        payload.insert("owner_epoch".into(), Value::String(owner_epoch));
        payload.insert("issued_at_unix_ms".into(), Value::from(unix_ms()));
        let target_public_key = parse_public_key(&peer.public_key)?;
        seal_json(&self.identity, &target_public_key, &Value::Object(payload))
            .map_err(RuntimeError::from)
    }
}

fn random_request_namespace() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn prune_terminal_observer_tombstones(
    observers: &mut HashMap<(String, String), TerminalObserverSlot>,
    ttl: std::time::Duration,
    maximum: usize,
) {
    let now = std::time::Instant::now();
    observers.retain(|_, slot| {
        !slot.closed
            || slot
                .closed_at
                .is_some_and(|closed_at| now.saturating_duration_since(closed_at) <= ttl)
    });
    let closed_count = observers.values().filter(|slot| slot.closed).count();
    if closed_count <= maximum {
        return;
    }
    let mut closed = observers
        .iter()
        .filter_map(|(key, slot)| slot.closed_at.map(|closed_at| (key.clone(), closed_at)))
        .collect::<Vec<_>>();
    closed.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    for (key, _) in closed.into_iter().take(closed_count - maximum) {
        observers.remove(&key);
    }
}

impl Drop for TransferRuntime {
    fn drop(&mut self) {
        self.listener_task.abort();
        self.receipt_retry_task.abort();
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
            for artifact in transfer_artifacts
                .drain()
                .flat_map(|(_, artifacts)| artifacts.into_values())
                .filter(|artifact| artifact.owned)
            {
                let _ = std::fs::remove_file(artifact.path);
            }
        }
        // Every owned source and receiver artifact is first moved beneath this
        // runtime-private root. Removing the root is therefore both complete
        // and safe even if an async artifact-map task still owns the mutex
        // while the final runtime handle is being dropped.
        let _ = remove_managed_artifact_root(&self.config.registry_dir, &self.config.peer_id);
        if let Ok(mut task_snapshot) = self.task_snapshot.try_lock() {
            *task_snapshot = Value::Null;
        }
        if let Ok(mut observers) = self.terminal_observers.try_lock() {
            for (_, slot) in observers.drain() {
                if let Some(handle) = slot.handle {
                    handle.abort();
                }
            }
        }
        if let Ok(mut observers) = self.companion_observers.try_lock() {
            for (_, observer) in observers.drain() {
                observer.handle.abort();
            }
        }
    }
}
