use super::config::{DiscoveryMode, RuntimeConfig};
use super::daemon::stream_peer_session;
use super::discovery::{MdnsDiscovery, PeerDiscovery};
use super::events::{RuntimeError, RuntimeEvent};
use super::external_peers;
use super::listener::run_listener;
use super::replay_store::TransferReplayStore;
use super::state::{ListenerContext, TerminalObserverSlot, TransferRuntime};
use super::utils::{
    load_or_create_identity, registry_entry_path, terminal_observer_key, unexpected_peer_response,
};
use crate::crypto::{parse_public_key, public_key_to_string, seal_json};
use crate::discovery::encode_txt_record;
use crate::protocol::{DiscoveredPeer, LocalTransferIdentity, PeerTaskSnapshot};
use crate::protocol::{PeerRegistryEntry, PeerRequest, PeerResponse, PeerTerminalEvent};
use crate::registry::PeerRegistry;
use serde_json::Value;
use std::collections::HashMap;
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};

impl TransferRuntime {
    pub fn local_identity(&self) -> LocalTransferIdentity {
        LocalTransferIdentity {
            peer_id: self.config.peer_id.clone(),
            display_name: self.config.display_name.clone(),
            public_key: public_key_to_string(&self.identity.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        }
    }

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
                        .send(RuntimeEvent::IncomingTransferRequest(event))
                        .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
                }
            }
        }
        let incoming_reservations = Arc::new(Mutex::new(loaded_incoming_reservations));
        let transfer_artifacts = Arc::new(Mutex::new(HashMap::new()));
        let authenticated_peer_requests = Arc::new(Mutex::new(HashMap::new()));
        let task_snapshot = Arc::new(Mutex::new(Value::Null));
        let terminal_observers = Arc::new(Mutex::new(HashMap::new()));
        let request_counter = Arc::new(AtomicU64::new(1));
        let listener_context = ListenerContext {
            self_peer_id: config.peer_id.clone(),
            self_display_name: config.display_name.clone(),
            self_public_key: public_key,
            registry_root: config.registry_dir.clone(),
            discovery: discovery.clone(),
            external_peers: Arc::clone(&external_peers),
            pending_transfer_ttl: config.pending_transfer_ttl,
            peer_request_timeout: config.peer_request_timeout,
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
            task_snapshot: Arc::clone(&task_snapshot),
            daemon_dir: config.daemon_dir.clone(),
            db_path: config.db_path.clone(),
            kanna_server_port: config.kanna_server_port,
            request_counter: Arc::clone(&request_counter),
            incoming_sender: incoming_sender.clone(),
            receipt_sender: receipt_sender.clone(),
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
            incoming_sender,
            incoming_events: Mutex::new(incoming_receiver),
            receipt_events: Mutex::new(receipt_receiver),
            request_counter,
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

    pub async fn list_peer_task_snapshots(&self) -> Result<Vec<PeerTaskSnapshot>, RuntimeError> {
        let peers = self.list_peers().await?;
        let mut snapshots = Vec::new();
        for peer in peers.into_iter().filter(|peer| {
            self.trusted_peer_record(&peer.peer_id)
                .ok()
                .flatten()
                .map(|record| record.public_key == peer.public_key)
                .unwrap_or(false)
        }) {
            let request_id = self.next_request_id("task-snapshot");
            let target_public_key = parse_public_key(&peer.public_key)?;
            let sealed_payload = seal_json(
                &self.identity,
                &target_public_key,
                &serde_json::json!({
                    "action": "get_task_snapshot",
                    "request_id": request_id,
                }),
            )?;
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
                        sealed_payload: Some(sealed_payload),
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
                    peer_id: response_peer_id,
                    display_name,
                    snapshot,
                } => {
                    if response_request_id == request_id {
                        if response_peer_id != peer.peer_id {
                            eprintln!(
                                "[task-transfer] peer {} returned task snapshot for mismatched peer {}",
                                peer.peer_id, response_peer_id
                            );
                            continue;
                        }
                        snapshots.push(PeerTaskSnapshot {
                            peer_id: peer.peer_id.clone(),
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
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        let generation = self.request_counter.fetch_add(1, Ordering::Relaxed);
        if let Some(displaced) = self.terminal_observers.lock().await.insert(
            observer_key.clone(),
            TerminalObserverSlot {
                generation,
                handle: None,
            },
        ) {
            if let Some(handle) = displaced.handle {
                handle.abort();
            }
        }

        let target_peer = match self.find_peer(target_peer_id).await {
            Ok(target_peer) => target_peer,
            Err(error) => {
                self.clear_terminal_observer_generation(&observer_key, generation)
                    .await;
                return Err(error);
            }
        };
        if let Err(error) =
            self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)
        {
            self.clear_terminal_observer_generation(&observer_key, generation)
                .await;
            return Err(error);
        }

        let request_id = self.next_request_id("observe-session");
        let self_peer_id = self.config.peer_id.clone();
        let session_id = session_id.to_owned();
        let incoming_sender = self.incoming_sender.clone();
        let peer_for_task = target_peer.clone();
        let peer_id_for_error = target_peer.peer_id.clone();
        let session_id_for_error = session_id.clone();
        let mut observers = self.terminal_observers.lock().await;
        let Some(slot) = observers
            .get_mut(&observer_key)
            .filter(|slot| slot.generation == generation)
        else {
            return Ok(());
        };
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
        if let Some(displaced) = slot.handle.replace(handle) {
            displaced.abort();
        }
        Ok(())
    }

    pub async fn unobserve_peer_session(
        &self,
        target_peer_id: &str,
        session_id: &str,
    ) -> Result<(), RuntimeError> {
        let observer_key = terminal_observer_key(target_peer_id, session_id);
        if let Some(slot) = self.terminal_observers.lock().await.remove(&observer_key) {
            if let Some(handle) = slot.handle {
                handle.abort();
            }
        }
        Ok(())
    }

    async fn clear_terminal_observer_generation(&self, observer_key: &str, generation: u64) {
        let mut observers = self.terminal_observers.lock().await;
        if observers
            .get(observer_key)
            .is_some_and(|slot| slot.generation == generation)
        {
            if let Some(slot) = observers.remove(observer_key) {
                if let Some(handle) = slot.handle {
                    handle.abort();
                }
            }
        }
    }

    pub async fn send_peer_session_input(
        &self,
        target_peer_id: &str,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
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
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
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
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
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
        expected_transition_revision: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_durably_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let request_id = self.next_request_id("advance-stage");
        let target_public_key = parse_public_key(&target_peer.public_key)?;
        let mut authenticated_payload = serde_json::json!({
            "action": "advance_task_stage",
            "request_id": request_id,
            "task_id": task_id,
        });
        if let Some(expected_transition_revision) = expected_transition_revision {
            authenticated_payload["expected_transition_revision"] =
                serde_json::Value::String(expected_transition_revision.to_owned());
        }
        let sealed_payload = seal_json(&self.identity, &target_public_key, &authenticated_payload)?;
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
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::ReadTaskFile {
                    request_id: request_id.clone(),
                    requester_peer_id: self.config.peer_id.clone(),
                    task_id: task_id.to_owned(),
                    path: path.to_owned(),
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

    pub async fn mark_peer_task_read(
        &self,
        target_peer_id: &str,
        task_id: &str,
        expected_activity_revision: i64,
    ) -> Result<(), RuntimeError> {
        let target_peer = self.find_peer(target_peer_id).await?;
        self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
        let target_public_key = parse_public_key(&target_peer.public_key)?;
        let sealed_payload = seal_json(
            &self.identity,
            &target_public_key,
            &serde_json::json!({
                "task_id": task_id,
                "expected_activity_revision": expected_activity_revision,
            }),
        )?;
        let request_id = self.next_request_id("mark-read");
        let response = self
            .send_peer_request_with_timeout(
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
            transfer_artifacts.clear();
        }
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
    }
}
