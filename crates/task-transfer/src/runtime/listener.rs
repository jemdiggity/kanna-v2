use super::companion::{
    append_owner_companion_event_rate_limited, ensure_owner_companion_generation,
    fresh_observation_challenge, register_owner_companion_observer,
    remove_owner_companion_observer, seal_owner_control_payload, stream_owner_companion,
    verify_observe_companion_proof, verify_send_companion_event_proof,
};
use super::daemon::{
    advance_owner_task_stage, close_owner_task, mark_owner_task_read, prepare_session_observer,
    read_owner_task_file, resize_daemon_session, send_daemon_input, stream_daemon_session,
};
use super::discovery::PeerDiscovery;
use super::events::{
    IncomingTransferEvent, OutgoingTransferFinalizationRequestedEvent, PairingCompletedEvent,
    PairingRequestedEvent, RuntimeError, RuntimeEvent, TaskPullRequestedEvent,
};
use super::external_peers::{
    ensure_peer_is_trusted, ensure_peer_is_trusted_for_transport, external_key_is_trusted,
    find_peer, ExternalPeerRegistry, TransferTransport,
};
use super::pull::{prune_task_pull_requests, validate_source_task_id};
use super::replay_store::unix_ms;
use super::state::{
    AuthenticatedPeerRequestReplay, ImportCommitReceipt, IncomingTransferReservation,
    ListenerContext, OutgoingTransferFinalizationState, OutgoingTransferReservation,
    PairingDecision, PendingPairingRequest, PendingTaskPullRequest,
};
use super::utils::{
    extract_request_id, load_or_create_identity, local_capabilities_json,
    pairing_verification_code, peer_store, prune_outgoing_transfers, prune_transfer_artifacts,
    read_bounded_json_line_with_type_limits, remove_owned_artifact_paths,
    supports_authenticated_task_requests, supports_duplex_terminal,
    supports_terminal_input_semantics, take_transfer_artifacts, write_bounded_legacy_json_line,
    write_json_line, ArtifactFraming,
};
use crate::crypto::{
    artifact_stream_context, open_json, parse_public_key, seal_json, seal_json_bounded,
    StreamSealer,
};
use crate::peer_store::PeerRecord;
use crate::protocol::{
    PairingPeer, PeerRequest, PeerResponse, MAX_COMPANION_REQUEST_LINE_BYTES,
    MAX_LEGACY_SUBMIT_TRANSFER_LINE_BYTES, MAX_PEER_REQUEST_LINE_BYTES,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use rand_core::{OsRng, RngCore};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
#[cfg(test)]
use std::sync::{Mutex as StdMutex, OnceLock};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex, OwnedSemaphorePermit, Semaphore};

#[derive(Debug)]
pub(super) struct LegacyArtifactMaterialization {
    pub(super) payload: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}

#[derive(Serialize)]
struct LegacyArtifactMetadataWire<'a> {
    request_id: &'a str,
    transfer_id: &'a str,
    artifact_id: &'a str,
    artifact_framing: &'a str,
    filename: &'a str,
    payload_b64: &'a str,
}

#[derive(Serialize)]
struct LegacyArtifactResponseWire<'a> {
    #[serde(rename = "type")]
    response_type: &'static str,
    request_id: &'a str,
    transfer_id: &'a str,
    sealed_payload: &'a str,
}

pub(super) async fn read_bounded_legacy_artifact<R>(
    reader: R,
    observed_size: u64,
    maximum_size: u64,
    permits: Arc<Semaphore>,
) -> Result<LegacyArtifactMaterialization, RuntimeError>
where
    R: AsyncRead + Unpin,
{
    let _permit = super::try_acquire_legacy_artifact_memory(permits, "serialization")?;
    if observed_size > maximum_size {
        return Err(RuntimeError::Protocol(format!(
            "transfer artifact exceeds maximum size of {maximum_size} bytes",
        )));
    }
    let initial_capacity = usize::try_from(observed_size.min(maximum_size)).map_err(|_| {
        RuntimeError::Protocol("artifact size cannot be represented on this platform".into())
    })?;
    let mut payload = Vec::with_capacity(initial_capacity);
    let mut bounded = reader.take(maximum_size.saturating_add(1));
    bounded.read_to_end(&mut payload).await?;
    if payload.len() as u64 > maximum_size {
        return Err(RuntimeError::Protocol(format!(
            "transfer artifact exceeds maximum size of {maximum_size} bytes",
        )));
    }
    Ok(LegacyArtifactMaterialization { payload, _permit })
}

pub(super) const MAX_CONCURRENT_PREAUTH_REQUESTS: usize = 16;

#[cfg(test)]
struct CompanionResponseTestGate {
    request_id: String,
    blocked: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[cfg(test)]
pub(super) struct CompanionResponseTestGateGuard(Arc<CompanionResponseTestGate>);

#[cfg(test)]
static COMPANION_RESPONSE_TEST_GATE: OnceLock<StdMutex<Option<Arc<CompanionResponseTestGate>>>> =
    OnceLock::new();

#[cfg(test)]
pub(super) fn install_companion_response_test_gate(
    request_id: &str,
) -> CompanionResponseTestGateGuard {
    let gate = Arc::new(CompanionResponseTestGate {
        request_id: request_id.to_owned(),
        blocked: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    *COMPANION_RESPONSE_TEST_GATE
        .get_or_init(|| StdMutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));
    CompanionResponseTestGateGuard(gate)
}

#[cfg(test)]
impl CompanionResponseTestGateGuard {
    pub(super) async fn wait_until_blocked(&self) {
        self.0.blocked.notified().await;
    }

    pub(super) fn release(&self) {
        self.0.release.notify_one();
    }
}

#[cfg(test)]
impl Drop for CompanionResponseTestGateGuard {
    fn drop(&mut self) {
        self.0.release.notify_one();
        let mut installed = COMPANION_RESPONSE_TEST_GATE
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
async fn wait_for_companion_response_test_gate(response: &PeerResponse) {
    let PeerResponse::SendCompanionEvent { request_id, .. } = response else {
        return;
    };
    let gate = COMPANION_RESPONSE_TEST_GATE
        .get_or_init(|| StdMutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .filter(|gate| gate.request_id == *request_id)
        .cloned();
    if let Some(gate) = gate {
        gate.blocked.notify_one();
        gate.release.notified().await;
    }
}

pub(super) async fn run_listener(listener: TcpListener, context: ListenerContext) {
    loop {
        let accepted = listener.accept().await;
        let (stream, _) = match accepted {
            Ok(accepted) => accepted,
            Err(_) => break,
        };
        let Ok(permit) = Arc::clone(&context.incoming_connection_permits).try_acquire_owned()
        else {
            continue;
        };

        let connection_context = context.clone();
        let connection_preauth_requests = Arc::clone(&context.preauth_requests);

        tokio::spawn(async move {
            let _permit = permit;
            let Ok(Ok(preauth_permit)) = tokio::time::timeout(
                connection_context.peer_request_timeout,
                connection_preauth_requests.acquire_owned(),
            )
            .await
            else {
                return;
            };
            let _ = handle_connection(stream, connection_context, preauth_permit).await;
        });
    }
}

async fn trusted_reserved_target(
    context: &ListenerContext,
    reservation: &OutgoingTransferReservation,
) -> Result<crate::protocol::PeerRegistryEntry, RuntimeError> {
    if let Some(peer) = reservation.target_peer.clone() {
        ensure_peer_is_trusted_for_transport(
            &context.registry_root,
            &context.self_peer_id,
            &context.external_peers,
            &peer.peer_id,
            &peer.public_key,
            reservation.transport.unwrap_or(TransferTransport::Auto),
        )?;
        return Ok(peer);
    }

    let peer = find_peer(
        &context.discovery,
        &context.external_peers,
        &context.self_peer_id,
        &reservation.target_peer_id,
        TransferTransport::Auto,
    )
    .await?;
    ensure_peer_is_trusted(
        &context.registry_root,
        &context.self_peer_id,
        &context.external_peers,
        &peer.peer_id,
        &peer.public_key,
    )?;
    Ok(peer)
}

async fn trusted_receipt_target(
    context: &ListenerContext,
    receipt: &ImportCommitReceipt,
) -> Result<crate::protocol::PeerRegistryEntry, RuntimeError> {
    if let Some(peer) = receipt.target_peer.clone() {
        ensure_peer_is_trusted_for_transport(
            &context.registry_root,
            &context.self_peer_id,
            &context.external_peers,
            &peer.peer_id,
            &peer.public_key,
            receipt.transport.unwrap_or(TransferTransport::Auto),
        )?;
        return Ok(peer);
    }
    let peer = find_peer(
        &context.discovery,
        &context.external_peers,
        &context.self_peer_id,
        &receipt.target_peer_id,
        TransferTransport::Auto,
    )
    .await?;
    ensure_peer_is_trusted(
        &context.registry_root,
        &context.self_peer_id,
        &context.external_peers,
        &peer.peer_id,
        &peer.public_key,
    )?;
    Ok(peer)
}

async fn handle_connection(
    mut stream: TcpStream,
    context: ListenerContext,
    preauth_permit: OwnedSemaphorePermit,
) -> Result<(), RuntimeError> {
    let mut preauth_permit = Some(preauth_permit);
    let line = tokio::time::timeout(
        context.peer_request_timeout,
        read_bounded_json_line_with_type_limits(
            &mut BufReader::new(&mut stream),
            MAX_COMPANION_REQUEST_LINE_BYTES,
            MAX_PEER_REQUEST_LINE_BYTES,
            &[
                (
                    "submit_transfer_payload",
                    MAX_LEGACY_SUBMIT_TRANSFER_LINE_BYTES,
                ),
                ("observe_companion", MAX_COMPANION_REQUEST_LINE_BYTES),
                ("send_companion_event", MAX_COMPANION_REQUEST_LINE_BYTES),
            ],
            "peer request",
        ),
    )
    .await
    .map_err(|_| RuntimeError::Protocol("peer request timed out".into()))??;
    let Some(line) = line else {
        return Ok(());
    };

    let request_id = extract_request_id(&line);
    let request = serde_json::from_str::<PeerRequest>(line.trim());
    drop(line);
    let response = match request {
        Ok(PeerRequest::GetAuthenticatedRequestEpoch { request_id }) => {
            PeerResponse::AuthenticatedRequestEpoch {
                request_id,
                epoch: context.authenticated_request_epoch.clone(),
            }
        }
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
            {
                let mut pending = context.pending_pairing_requests.lock().await;
                if pending.len() >= context.max_pending_pairing_requests {
                    drop(pending);
                    write_json_line(
                        &mut stream,
                        &PeerResponse::Error {
                            request_id,
                            message: RuntimeError::Backpressure(format!(
                                "pending pairing request capacity {} is exhausted",
                                context.max_pending_pairing_requests,
                            ))
                            .to_string(),
                        },
                    )
                    .await?;
                    return Ok(());
                }
                pending.insert(
                    pairing_request_id.clone(),
                    PendingPairingRequest {
                        verification_code: verification_code.clone(),
                        responder: approval_sender,
                    },
                );
            }
            if context
                .incoming_sender
                .try_send(RuntimeEvent::PairingRequested(PairingRequestedEvent {
                    request_id: pairing_request_id.clone(),
                    peer_id: source_peer_id.clone(),
                    display_name: source_display_name.clone(),
                    verification_code: verification_code.clone(),
                }))
                .is_err()
            {
                context
                    .pending_pairing_requests
                    .lock()
                    .await
                    .remove(&pairing_request_id);
                write_json_line(
                    &mut stream,
                    &PeerResponse::Error {
                        request_id,
                        message: RuntimeError::IncomingEventChannelClosed.to_string(),
                    },
                )
                .await?;
                return Ok(());
            }

            let approved =
                match tokio::time::timeout(context.peer_request_timeout, approval_receiver).await {
                    Ok(Ok(PairingDecision::Accepted)) => true,
                    Ok(Ok(PairingDecision::Rejected)) => false,
                    Ok(Err(_)) => false,
                    Err(_) => false,
                };
            context
                .pending_pairing_requests
                .lock()
                .await
                .remove(&pairing_request_id);
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
                    .try_send(RuntimeEvent::PairingCompleted(PairingCompletedEvent {
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
            let authenticated = authenticate_peer_request(
                &context,
                &source_peer_id,
                Some(&sealed_payload),
                "prepare_transfer",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(
                &authenticated,
                "source_peer_id",
                &source_peer_id,
            )?;
            ensure_authenticated_argument(
                &authenticated,
                "reserved_target_peer_id",
                &context.self_peer_id,
            )?;
            let source_task_id =
                authenticated_argument::<String>(&authenticated, "source_task_id")?;
            let mut reservations = context.incoming_reservations.lock().await;
            context
                .replay_store
                .prune_incoming_reservations(&mut reservations);
            if reservations.len() >= context.replay_store.max_incoming_reservations() {
                return Err(RuntimeError::Protocol(format!(
                    "too many active incoming transfer reservations (maximum {})",
                    context.replay_store.max_incoming_reservations()
                )));
            }
            let transfer_id = loop {
                let candidate = random_transfer_id();
                if !reservations.contains_key(&candidate) {
                    break candidate;
                }
            };
            let reservation = IncomingTransferReservation {
                source_peer_id: source_peer_id.clone(),
                source_task_id,
                created_at_unix_ms: unix_ms(),
                committed: false,
                event: None,
                event_recorded: false,
            };
            context
                .replay_store
                .save_incoming_reservation(&transfer_id, &reservation)?;
            reservations.insert(transfer_id.clone(), reservation);

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
        Ok(PeerRequest::RequestTaskPull {
            request_id,
            requester_peer_id,
            sealed_payload,
        }) => match async {
            if requester_peer_id == context.self_peer_id {
                return Err(RuntimeError::Protocol(
                    "cannot request a task pull from this runtime".into(),
                ));
            }
            let authenticated = authenticate_peer_request(
                &context,
                &requester_peer_id,
                Some(&sealed_payload),
                "request_task_pull",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(
                &authenticated,
                "requester_peer_id",
                &requester_peer_id,
            )?;
            ensure_authenticated_argument(
                &authenticated,
                "reserved_target_peer_id",
                &context.self_peer_id,
            )?;
            let source_task_id =
                authenticated_argument::<String>(&authenticated, "source_task_id")?;
            validate_source_task_id(&source_task_id)?;

            let key = (requester_peer_id.clone(), source_task_id.clone());
            let mut requests = context.pending_task_pull_requests.lock().await;
            prune_task_pull_requests(&mut requests);
            if let Some(existing) = requests.get(&key) {
                return Ok::<PeerResponse, RuntimeError>(PeerResponse::RequestTaskPull {
                    request_id: existing.request_id.clone(),
                });
            }
            if requests.len() >= context.max_task_pull_requests {
                return Err(RuntimeError::Backpressure(format!(
                    "pending task-pull request capacity {} is exhausted",
                    context.max_task_pull_requests
                )));
            }

            let pull_request_id = format!(
                "pull-{}-{}",
                context.self_peer_id,
                context.request_counter.fetch_add(1, Ordering::Relaxed)
            );
            requests.insert(
                key.clone(),
                PendingTaskPullRequest {
                    request_id: pull_request_id.clone(),
                    created_at: std::time::Instant::now(),
                },
            );
            if context
                .incoming_sender
                .try_send(RuntimeEvent::TaskPullRequested(TaskPullRequestedEvent {
                    request_id: pull_request_id.clone(),
                    requester_peer_id,
                    source_task_id,
                }))
                .is_err()
            {
                requests.remove(&key);
                return Err(RuntimeError::IncomingEventChannelClosed);
            }

            Ok(PeerResponse::RequestTaskPull {
                request_id: pull_request_id,
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
                &context.external_peers,
                &transfer_id,
                sealed_payload,
                &context.incoming_reservations,
                &context.replay_store,
            )
            .await
            {
                Ok(event) => {
                    let event_was_newly_committed = {
                        let mut reservations = context.incoming_reservations.lock().await;
                        let mut reservation =
                            reservations.get(&transfer_id).cloned().ok_or_else(|| {
                                RuntimeError::Protocol(format!(
                                    "unknown transfer id {}",
                                    transfer_id
                                ))
                            })?;
                        if reservation.committed && reservation.event.is_some() {
                            false
                        } else {
                            reservation.committed = true;
                            reservation.event = Some(event.clone());
                            reservation.event_recorded = false;
                            context
                                .replay_store
                                .save_incoming_reservation(&transfer_id, &reservation)?;
                            reservations.insert(transfer_id.clone(), reservation);
                            true
                        }
                    };
                    if event_was_newly_committed {
                        context
                            .incoming_sender
                            .try_send(RuntimeEvent::IncomingTransferRequest(event))
                            .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
                    }
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
        Ok(PeerRequest::AbandonTransfer {
            request_id,
            transfer_id,
            source_peer_id,
            sealed_payload,
        }) => match async {
            let authenticated = authenticate_peer_request(
                &context,
                &source_peer_id,
                Some(&sealed_payload),
                "abandon_transfer",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(&authenticated, "source_peer_id", &source_peer_id)?;
            ensure_authenticated_argument(&authenticated, "transfer_id", &transfer_id)?;
            ensure_authenticated_argument(
                &authenticated,
                "reserved_target_peer_id",
                &context.self_peer_id,
            )?;

            let mut reservations = context.incoming_reservations.lock().await;
            context
                .replay_store
                .prune_incoming_reservations(&mut reservations);
            match reservations.get(&transfer_id) {
                // Idempotent for an id this runtime does not hold: the caller's
                // job is to guarantee nothing is left, not to prove something
                // was. A retry after a half-failed release must still settle.
                None => {}
                Some(reservation) if reservation.source_peer_id != source_peer_id => {
                    return Err(RuntimeError::Protocol(format!(
                        "peer {source_peer_id} cannot abandon transfer {transfer_id} reserved for another source",
                    )));
                }
                // A committed reservation carries a payload this machine has
                // already been told about — releasing it would strand an
                // incoming transfer the operator can see. Only the un-committed
                // half of a duplicate push is releasable this way.
                Some(reservation) if reservation.committed => {
                    return Err(RuntimeError::Protocol(format!(
                        "transfer {transfer_id} is already committed and cannot be abandoned",
                    )));
                }
                Some(_) => {
                    reservations.remove(&transfer_id);
                    context
                        .replay_store
                        .remove_incoming_reservation_checked(&transfer_id)
                        .map_err(RuntimeError::from)?;
                }
            }

            Ok::<PeerResponse, RuntimeError>(PeerResponse::AbandonTransfer {
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
        },
        Ok(PeerRequest::FinalizeTransfer {
            request_id,
            transfer_id,
            requester_peer_id,
            sealed_payload,
        }) => {
            match async {
                let (reservation, expired) = {
                    let mut transfers = context.outgoing_transfers.lock().await;
                    let expired =
                        prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl);
                    for expired_transfer_id in &expired {
                        context.replay_store.remove_reservation(expired_transfer_id);
                    }
                    (transfers.get(&transfer_id).cloned(), expired)
                };
                if !expired.is_empty() {
                    let mut finalizations =
                        context.pending_outgoing_transfer_finalizations.lock().await;
                    for expired_transfer_id in expired {
                        finalizations.remove(&expired_transfer_id);
                    }
                }
                let reservation = reservation.ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "missing target peer for outgoing transfer finalization {}",
                        transfer_id
                    ))
                })?;

                if requester_peer_id != reservation.target_peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected outgoing transfer finalization requester {} for transfer {}",
                        requester_peer_id, transfer_id
                    )));
                }

                let requester_peer = trusted_reserved_target(&context, &reservation).await?;
                let authenticated = authenticate_peer_request(
                    &context,
                    &requester_peer_id,
                    Some(&sealed_payload),
                    "finalize_transfer",
                    &request_id,
                )
                .await?;
                ensure_authenticated_argument(
                    &authenticated,
                    "requester_peer_id",
                    &requester_peer_id,
                )?;
                ensure_authenticated_argument(
                    &authenticated,
                    "transfer_id",
                    &transfer_id,
                )?;
                ensure_authenticated_argument(
                    &authenticated,
                    "reserved_target_peer_id",
                    &requester_peer_id,
                )?;

                let (tx, rx) = oneshot::channel();
                let (emit_event, cached) = {
                    let mut finalizations =
                        context.pending_outgoing_transfer_finalizations.lock().await;
                    let admission: Result<_, RuntimeError> =
                        match finalizations.entry(transfer_id.clone()) {
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert(OutgoingTransferFinalizationState::Pending {
                                waiters: vec![tx],
                            });
                            Ok((true, None))
                        }
                        std::collections::hash_map::Entry::Occupied(mut entry) => {
                            match entry.get_mut() {
                                OutgoingTransferFinalizationState::Pending { waiters } => {
                                    waiters.retain(|waiter| !waiter.is_closed());
                                    if waiters.len() >= context.max_finalization_waiters {
                                        return Err(RuntimeError::Backpressure(format!(
                                            "outgoing transfer finalization waiter capacity {} is exhausted",
                                            context.max_finalization_waiters
                                        )));
                                    }
                                    waiters.push(tx);
                                    Ok((false, None))
                                }
                                OutgoingTransferFinalizationState::Completed(result) => {
                                    Ok((false, Some(result.clone())))
                                }
                            }
                        }
                        };
                    admission?
                };
                if emit_event
                    && context
                        .incoming_sender
                        .try_send(RuntimeEvent::OutgoingTransferFinalizationRequested(
                            OutgoingTransferFinalizationRequestedEvent {
                                transfer_id: transfer_id.clone(),
                            },
                        ))
                        .is_err()
                {
                    context
                        .pending_outgoing_transfer_finalizations
                        .lock()
                        .await
                        .remove(&transfer_id);
                    return Err(RuntimeError::IncomingEventChannelClosed);
                }

                let result = match cached {
                    Some(result) => result,
                    // Not `peer_request_timeout`: the answer waits on the source
                    // agent being asked to wrap up and quit, which is minutes
                    // for a busy one. Under the ordinary window this timed out
                    // long before the desktop had anything to say, and the
                    // destination spent an import attempt on it.
                    None => tokio::time::timeout(context.finalization_request_timeout, rx)
                        .await
                        .map_err(|_| RuntimeError::PeerRequestTimeout {
                            peer_id: requester_peer_id.clone(),
                            timeout_ms: context.finalization_request_timeout.as_millis(),
                        })?
                        .map_err(|_| {
                            RuntimeError::Protocol(format!(
                                "desktop finalization receiver dropped for transfer {}",
                                transfer_id
                            ))
                        })?,
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
                    Err(error) => Err(RuntimeError::Protocol(error)),
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
        Ok(PeerRequest::FetchTransferArtifact {
            request_id,
            transfer_id,
            requester_peer_id,
            sealed_payload,
        }) => {
            let mut legacy_response_write_started = false;
            match async {
                let reservation = {
                    let mut transfers = context.outgoing_transfers.lock().await;
                    for expired in
                        prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl)
                    {
                        context.replay_store.remove_reservation(&expired);
                    }
                    transfers.get(&transfer_id).cloned()
                }
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "missing target peer for artifact fetch {}",
                        transfer_id
                    ))
                })?;

                if requester_peer_id != reservation.target_peer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected artifact fetch requester {} for transfer {}",
                        requester_peer_id, transfer_id
                    )));
                }

                let requester_peer = trusted_reserved_target(&context, &reservation).await?;
                let requester_public_key = parse_public_key(&requester_peer.public_key)?;
                let identity =
                    load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
                let request_payload = open_json(&identity, &requester_public_key, &sealed_payload)?;
                ensure_optional_authenticated_argument(
                    &request_payload,
                    "request_id",
                    &request_id,
                )?;
                ensure_optional_authenticated_argument(
                    &request_payload,
                    "transfer_id",
                    &transfer_id,
                )?;
                let artifact_id = request_payload
                    .get("artifact_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol("artifact fetch request missing artifact_id".into())
                    })?;
                let negotiated_artifact_framing =
                    ArtifactFraming::for_protocol(requester_peer.protocol_version);
                let artifact_framing = match request_payload.get("artifact_framing") {
                    Some(Value::String(name)) => {
                        let requested = ArtifactFraming::parse(name)?;
                        if !negotiated_artifact_framing
                            .allows_authenticated_request(requested)
                        {
                            return Err(RuntimeError::Protocol(format!(
                                "requested artifact framing {} does not match negotiated {} framing",
                                requested.name(),
                                negotiated_artifact_framing.name(),
                            )));
                        }
                        requested
                    }
                    Some(_) => {
                        return Err(RuntimeError::Protocol(
                            "artifact fetch request has invalid artifact_framing".into(),
                        ));
                    }
                    // Protocol v2 peers predate this field. For requests that omit
                    // it, the pinned peer capability remains the source of truth.
                    None => negotiated_artifact_framing,
                };

                let (artifact, expired_artifacts) = {
                    let mut artifacts = context.transfer_artifacts.lock().await;
                    let expired =
                        prune_transfer_artifacts(&mut artifacts, context.pending_transfer_ttl);
                    let artifact = artifacts
                    .get(&transfer_id)
                    .and_then(|artifacts| artifacts.get(artifact_id))
                    .cloned();
                    (artifact, expired)
                };
                remove_owned_artifact_paths(expired_artifacts).await;
                let artifact = artifact
                .ok_or_else(|| RuntimeError::Protocol(format!(
                        "missing transfer artifact {} for transfer {}",
                        artifact_id, transfer_id
                    )))?;
                let metadata = tokio::fs::metadata(&artifact.path).await?;
                let maximum_artifact_size = if artifact_framing.is_streamed() {
                    super::MAX_TRANSFER_ARTIFACT_BYTES
                } else {
                    super::MAX_LEGACY_TRANSFER_ARTIFACT_BYTES
                };
                if metadata.len() > maximum_artifact_size {
                    return Err(RuntimeError::Protocol(format!(
                        "transfer artifact exceeds maximum size of {} bytes",
                        maximum_artifact_size,
                    )));
                }
                let filename = artifact
                    .path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("artifact")
                    .to_string();
                if !artifact_framing.is_streamed() {
                    tokio::time::timeout(context.peer_request_timeout, async {
                        let file = tokio::fs::File::open(&artifact.path).await?;
                        let materialization = read_bounded_legacy_artifact(
                            file,
                            metadata.len(),
                            maximum_artifact_size,
                            Arc::clone(&context.legacy_artifact_memory_permits),
                        )
                        .await?;
                        let payload_b64 = URL_SAFE_NO_PAD.encode(&materialization.payload);
                        let retained_input_capacity =
                            super::legacy_artifact_retained_capacity(&[
                                materialization.payload.capacity(),
                                payload_b64.capacity(),
                            ])?;
                        let sealed_payload = {
                            let metadata = LegacyArtifactMetadataWire {
                                request_id: &request_id,
                                transfer_id: &transfer_id,
                                artifact_id,
                                artifact_framing: artifact_framing.name(),
                                filename: &filename,
                                payload_b64: &payload_b64,
                            };
                            seal_json_bounded(
                                &identity,
                                &requester_public_key,
                                &metadata,
                                retained_input_capacity,
                                super::MAX_LEGACY_ARTIFACT_METADATA_BYTES,
                                super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
                            )?
                        };
                        drop(payload_b64);
                        legacy_response_write_started = true;
                        let retained_response_capacity =
                            super::legacy_artifact_retained_capacity(&[
                                materialization.payload.capacity(),
                                sealed_payload.capacity(),
                            ])?;
                        write_bounded_legacy_json_line(
                            &mut stream,
                            &LegacyArtifactResponseWire {
                                response_type: "fetch_transfer_artifact",
                                request_id: &request_id,
                                transfer_id: &transfer_id,
                                sealed_payload: &sealed_payload,
                            },
                            retained_response_capacity,
                        )
                        .await
                    })
                    .await
                    .map_err(|_| RuntimeError::PeerRequestTimeout {
                        peer_id: requester_peer_id.clone(),
                        timeout_ms: context.peer_request_timeout.as_millis(),
                    })??;
                    return Ok::<(), RuntimeError>(());
                }
                let sealed_payload = seal_json(
                    &identity,
                    &requester_public_key,
                    &serde_json::json!({
                        "request_id": request_id,
                        "transfer_id": transfer_id,
                        "artifact_id": artifact_id,
                        "artifact_framing": artifact_framing.name(),
                        "filename": filename,
                        "plaintext_size": metadata.len(),
                    }),
                )?;
                let response_context = artifact_stream_context(
                    &request_id,
                    &transfer_id,
                    artifact_id,
                    metadata.len(),
                );
                let mut sealer =
                    StreamSealer::new(&identity, &requester_public_key, &response_context)?;
                write_json_line(
                    &mut stream,
                    &PeerResponse::FetchTransferArtifact {
                        request_id: request_id.clone(),
                        transfer_id,
                        sealed_payload,
                        stream_header: Some(sealer.header()),
                    },
                )
                .await?;

                let mut file = tokio::fs::File::open(&artifact.path).await?;
                let mut buffer = vec![0u8; super::TRANSFER_ARTIFACT_CHUNK_BYTES];
                loop {
                    let read = file.read(&mut buffer).await?;
                    if read == 0 {
                        break;
                    }
                    write_artifact_chunk(
                        &mut stream,
                        &sealer.seal_chunk(&buffer[..read], false)?,
                        false,
                    )
                    .await?;
                }
                write_artifact_chunk(&mut stream, &sealer.seal_chunk(&[], true)?, true).await?;
                Ok::<(), RuntimeError>(())
            }
            .await
            {
                Ok(()) => return Ok(()),
                Err(error)
                    if legacy_response_write_started
                        || matches!(&error, RuntimeError::PeerRequestTimeout { .. }) =>
                {
                    return Err(error);
                }
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
                // Keep receipt creation serialized for the full validation and durable write.
                // Otherwise concurrent acknowledgments could both observe no receipt and race
                // incompatible bindings onto disk.
                let mut receipts = context.import_commit_receipts.lock().await;
                let existing_receipt = receipts.get(&transfer_id).cloned();
                let reservation = if existing_receipt.is_none() {
                    let mut transfers = context.outgoing_transfers.lock().await;
                    for expired in
                        prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl)
                    {
                        context.replay_store.remove_reservation(&expired);
                    }
                    transfers.get(&transfer_id).cloned()
                } else {
                    None
                };
                let expected_target_peer_id = existing_receipt
                    .as_ref()
                    .map(|receipt| receipt.target_peer_id.clone())
                    .or_else(|| {
                        reservation
                            .as_ref()
                            .map(|reservation| reservation.target_peer_id.clone())
                    })
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

                let requester_peer = match (&existing_receipt, &reservation) {
                    (Some(receipt), _) => trusted_receipt_target(&context, receipt).await?,
                    (None, Some(reservation)) => {
                        trusted_reserved_target(&context, reservation).await?
                    }
                    (None, None) => {
                        return Err(RuntimeError::Protocol(format!(
                            "missing target peer for import acknowledgment {}",
                            transfer_id
                        )));
                    }
                };
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

                if let Some(mut receipt) = existing_receipt {
                    if receipt.source_task_id != source_task_id
                        || receipt.destination_local_task_id != destination_local_task_id
                    {
                        return Err(RuntimeError::Protocol(format!(
                            "mismatched duplicate import acknowledgment for transfer {}",
                            transfer_id
                        )));
                    }
                    receipt.try_queue_event(&transfer_id, &context.receipt_sender)?;
                    receipts.insert(transfer_id.clone(), receipt);
                    return Ok::<PeerResponse, RuntimeError>(PeerResponse::ImportCommitted {
                        request_id: request_id.clone(),
                        transfer_id,
                    });
                }

                let reservation = reservation.ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "missing target peer for import acknowledgment {}",
                        transfer_id
                    ))
                })?;
                if reservation.source_task_id != source_task_id {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected source task {} for import acknowledgment {}",
                        source_task_id, transfer_id
                    )));
                }
                if receipts.values().filter(|receipt| !receipt.applied).count()
                    >= context.replay_store.max_unapplied_receipts()
                {
                    return Err(RuntimeError::Protocol(format!(
                        "too many unapplied import acknowledgments (maximum {})",
                        context.replay_store.max_unapplied_receipts()
                    )));
                }
                let receipt = ImportCommitReceipt {
                    target_peer_id: requester_peer_id,
                    target_peer: reservation.target_peer.clone(),
                    transport: reservation.transport,
                    source_task_id: source_task_id.clone(),
                    destination_local_task_id: destination_local_task_id.clone(),
                    created_at_unix_ms: unix_ms(),
                    applied: false,
                    event_queued: false,
                    delivery_in_flight: false,
                };
                context.replay_store.save_receipt(&transfer_id, &receipt)?;
                context.outgoing_transfers.lock().await.remove(&transfer_id);
                context.replay_store.remove_reservation(&transfer_id);
                context
                    .pending_outgoing_transfer_finalizations
                    .lock()
                    .await
                    .remove(&transfer_id);
                let owned_artifacts = {
                    let mut artifacts = context.transfer_artifacts.lock().await;
                    take_transfer_artifacts(&mut artifacts, &transfer_id)
                };
                remove_owned_artifact_paths(owned_artifacts).await;
                receipts.insert(transfer_id.clone(), receipt);
                receipts
                    .get_mut(&transfer_id)
                    .expect("receipt was just inserted")
                    .try_queue_event(&transfer_id, &context.receipt_sender)?;
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
            sealed_payload,
        }) => match async {
            authenticate_peer_request(
                &context,
                &requester_peer_id,
                sealed_payload.as_deref(),
                "get_task_snapshot",
                &request_id,
            )
            .await?;
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
            sealed_payload,
        }) => {
            let response = match async {
                let payload = authenticate_peer_request(
                    &context,
                    &requester_peer_id,
                    sealed_payload.as_deref(),
                    "observe_session",
                    &request_id,
                )
                .await?;
                ensure_authenticated_argument(&payload, "session_id", &session_id)?;
                require_observer_terminal_input_compatibility(&context, &requester_peer_id)
                    .await?;
                prepare_session_observer(&context, &session_id).await
            }
            .await
            {
                Ok((daemon, initial_snapshot)) => {
                    drop(preauth_permit.take());
                    write_json_line(
                        &mut stream,
                        &PeerResponse::ObserveSession {
                            request_id,
                            session_id: session_id.clone(),
                        },
                    )
                    .await?;
                    stream_daemon_session(daemon, stream, session_id, initial_snapshot).await?;
                    return Ok(());
                }
                Err(error) => PeerResponse::Error {
                    request_id,
                    message: error.to_string(),
                },
            };
            response
        }
        Ok(PeerRequest::ObserveCompanion {
            request_id,
            requester_peer_id,
            sealed_payload: sealed_proof,
        }) => {
            match verify_observe_companion_proof(
                &context,
                &request_id,
                &requester_peer_id,
                &sealed_proof,
            )
            .await
            {
                Ok((task_id, generation, stream_nonce)) => {
                    let observation_challenge = fresh_observation_challenge();
                    let sealed_payload = seal_owner_control_payload(
                        &context,
                        &requester_peer_id,
                        "observe_companion_ack",
                        &request_id,
                        &task_id,
                        &generation,
                        &stream_nonce,
                        &observation_challenge,
                        0,
                        None,
                    )
                    .await?;
                    let cancel = register_owner_companion_observer(
                        &context,
                        &requester_peer_id,
                        &task_id,
                        &generation,
                        &stream_nonce,
                        &observation_challenge,
                    )
                    .await?;
                    drop(preauth_permit.take());
                    let result = async {
                        write_json_line(
                            &mut stream,
                            &PeerResponse::ObserveCompanion {
                                request_id: request_id.clone(),
                                sealed_payload,
                            },
                        )
                        .await?;
                        stream_owner_companion(
                            &context,
                            stream,
                            &requester_peer_id,
                            task_id.clone(),
                            request_id.clone(),
                            generation.clone(),
                            stream_nonce.clone(),
                            observation_challenge.clone(),
                            cancel,
                        )
                        .await
                    }
                    .await;
                    remove_owner_companion_observer(
                        &context,
                        &requester_peer_id,
                        &task_id,
                        &generation,
                    )
                    .await;
                    result?;
                    return Ok(());
                }
                Err(error) => PeerResponse::Error {
                    request_id,
                    message: error.to_string(),
                },
            }
        }
        Ok(PeerRequest::SendCompanionEvent {
            request_id,
            requester_peer_id,
            sealed_payload,
        }) => {
            let result = async {
                let (
                    task_id,
                    session_id,
                    revision,
                    generation,
                    stream_nonce,
                    observation_challenge,
                    sequence,
                    event,
                ) = verify_send_companion_event_proof(
                    &context,
                    &request_id,
                    &requester_peer_id,
                    &sealed_payload,
                )
                .await?;
                let limiter = ensure_owner_companion_generation(
                    &context,
                    &requester_peer_id,
                    &task_id,
                    &generation,
                    &stream_nonce,
                    &observation_challenge,
                    sequence,
                )
                .await?;
                let frame = append_owner_companion_event_rate_limited(
                    &context,
                    limiter,
                    &task_id,
                    &session_id,
                    &revision,
                    &event,
                )
                .await?;
                seal_owner_control_payload(
                    &context,
                    &requester_peer_id,
                    "companion_event_result",
                    &request_id,
                    &task_id,
                    &generation,
                    &stream_nonce,
                    &observation_challenge,
                    sequence,
                    Some(frame),
                )
                .await
            }
            .await;
            match result {
                Ok(sealed_payload) => PeerResponse::SendCompanionEvent {
                    request_id,
                    sealed_payload,
                },
                Err(error) => PeerResponse::Error {
                    request_id,
                    message: error.to_string(),
                },
            }
        }
        Ok(PeerRequest::SendSessionInput {
            request_id,
            requester_peer_id,
            session_id,
            data,
            submission_boundary,
            control_input,
            sealed_payload,
        }) => match async {
            let payload = authenticate_peer_request(
                &context,
                &requester_peer_id,
                sealed_payload.as_deref(),
                "send_session_input",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(&payload, "session_id", &session_id)?;
            ensure_authenticated_argument(&payload, "data", &data)?;
            require_terminal_input_semantics(&context, &requester_peer_id).await?;
            ensure_authenticated_argument(
                &payload,
                "submission_boundary",
                &submission_boundary,
            )?;
            ensure_authenticated_argument(&payload, "control_input", &control_input)?;
            send_daemon_input(
                &context,
                &session_id,
                data,
                submission_boundary,
                control_input,
            )
            .await
        }
        .await
        {
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
            sealed_payload,
        }) => match async {
            let payload = authenticate_peer_request(
                &context,
                &requester_peer_id,
                sealed_payload.as_deref(),
                "resize_session",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(&payload, "session_id", &session_id)?;
            ensure_authenticated_argument(&payload, "cols", &cols)?;
            ensure_authenticated_argument(&payload, "rows", &rows)?;
            resize_daemon_session(&context, &session_id, cols, rows).await
        }
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
            sealed_payload,
        }) => match async {
            let payload = authenticate_peer_request(
                &context,
                &requester_peer_id,
                sealed_payload.as_deref(),
                "close_task",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(&payload, "task_id", &task_id)?;
            close_owner_task(&context, &task_id).await
        }
        .await
        {
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
            expected_transition_revision,
            sealed_payload,
        }) => match async {
            let payload = authenticate_peer_request(
                &context,
                &requester_peer_id,
                sealed_payload.as_deref(),
                "advance_task_stage",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(&payload, "task_id", &task_id)?;
            ensure_authenticated_argument(
                &payload,
                "expected_transition_revision",
                &expected_transition_revision,
            )?;
            advance_owner_task_stage(&context, &task_id, expected_transition_revision.as_deref())
                .await?;
            Ok::<PeerResponse, RuntimeError>(PeerResponse::AdvanceTaskStage {
                request_id: request_id.clone(),
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
        Ok(PeerRequest::ReadTaskFile {
            request_id,
            requester_peer_id,
            task_id,
            path,
            sealed_payload,
        }) => match async {
            let payload = authenticate_peer_request(
                &context,
                &requester_peer_id,
                sealed_payload.as_deref(),
                "read_task_file",
                &request_id,
            )
            .await?;
            ensure_authenticated_argument(&payload, "task_id", &task_id)?;
            ensure_authenticated_argument(&payload, "path", &path)?;
            read_owner_task_file(&context, &task_id, &path).await
        }
        .await
        {
            Ok((path, content)) => PeerResponse::ReadTaskFile {
                request_id,
                path,
                content,
            },
            Err(error) => PeerResponse::Error {
                request_id,
                message: error.to_string(),
            },
        },
        Ok(PeerRequest::MarkTaskRead {
            request_id,
            requester_peer_id,
            sealed_payload,
        }) => match async {
            let payload = authenticate_peer_request(
                &context,
                &requester_peer_id,
                Some(&sealed_payload),
                "mark_task_read",
                &request_id,
            )
            .await?;
            let task_id: String = authenticated_argument(&payload, "task_id")?;
            let expected_activity_revision: i64 =
                authenticated_argument(&payload, "expected_activity_revision")?;
            if expected_activity_revision < 0 {
                return Err(RuntimeError::Protocol(
                    "authenticated expected_activity_revision must not be negative".into(),
                ));
            }
            mark_owner_task_read(&context, &task_id, expected_activity_revision).await?;
            Ok::<PeerResponse, RuntimeError>(PeerResponse::MarkTaskRead {
                request_id: request_id.clone(),
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
        Err(error) => PeerResponse::Error {
            request_id,
            message: error.to_string(),
        },
    };

    #[cfg(test)]
    wait_for_companion_response_test_gate(&response).await;
    write_json_line(&mut stream, &response).await?;
    Ok(())
}

async fn write_artifact_chunk(
    stream: &mut TcpStream,
    ciphertext: &[u8],
    final_chunk: bool,
) -> Result<(), RuntimeError> {
    let length = u32::try_from(ciphertext.len())
        .map_err(|_| RuntimeError::Protocol("artifact chunk length overflow".into()))?;
    stream.write_u8(u8::from(final_chunk)).await?;
    stream.write_u32(length).await?;
    stream.write_all(ciphertext).await?;
    Ok(())
}

async fn authenticate_peer_request(
    context: &ListenerContext,
    requester_peer_id: &str,
    sealed_payload: Option<&str>,
    expected_action: &str,
    expected_request_id: &str,
) -> Result<Value, RuntimeError> {
    let requester_peer = find_peer(
        &context.discovery,
        &context.external_peers,
        &context.self_peer_id,
        requester_peer_id,
        TransferTransport::Auto,
    )
    .await?;
    ensure_peer_is_trusted(
        &context.registry_root,
        &context.self_peer_id,
        &context.external_peers,
        requester_peer_id,
        &requester_peer.public_key,
    )?;
    let trusted_peer = peer_store(&context.registry_root, &context.self_peer_id)?
        .list_active()?
        .into_iter()
        .find(|peer| {
            peer.peer_id == requester_peer_id && peer.public_key == requester_peer.public_key
        });
    let externally_trusted = external_key_is_trusted(
        &context.external_peers,
        requester_peer_id,
        &requester_peer.public_key,
    );
    if trusted_peer.is_none() && !externally_trusted {
        return Err(RuntimeError::Protocol(format!(
            "peer {requester_peer_id} is not trusted"
        )));
    }
    let sealed_payload = sealed_payload.ok_or_else(|| {
        if externally_trusted
            || trusted_peer.as_ref().is_some_and(|trusted_peer| {
                supports_authenticated_task_requests(
                    requester_peer.protocol_version,
                    &trusted_peer.capabilities_json,
                )
            })
        {
            RuntimeError::Protocol(format!(
                "{expected_action} request is missing authenticated payload"
            ))
        } else {
            RuntimeError::Protocol(format!(
                "peer {requester_peer_id} uses protocol v{} without authenticated task requests; upgrade and re-pair the peer",
                requester_peer.protocol_version
            ))
        }
    })?;
    let requester_public_key = parse_public_key(&requester_peer.public_key)?;
    let identity = load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
    let payload = open_json(&identity, &requester_public_key, sealed_payload)?;
    if payload.get("action").and_then(Value::as_str) != Some(expected_action) {
        return Err(RuntimeError::Protocol(format!(
            "authenticated payload action does not match {expected_action}"
        )));
    }
    if payload.get("request_id").and_then(Value::as_str) != Some(expected_request_id) {
        return Err(RuntimeError::Protocol(
            "authenticated payload request_id does not match outer request".into(),
        ));
    }
    if payload.get("owner_epoch").and_then(Value::as_str)
        != Some(context.authenticated_request_epoch.as_str())
    {
        return Err(RuntimeError::Protocol(format!(
            "authenticated {expected_action} request targets a stale owner epoch"
        )));
    }

    let issued_at_unix_ms = payload
        .get("issued_at_unix_ms")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "authenticated {expected_action} payload is missing issued_at_unix_ms"
            ))
        })?;
    let now_ms = unix_ms();
    // The replay bound, not the in-flight resource TTL: those were one constant
    // until the finalization budget forced the second one to grow.
    let freshness_ms =
        u64::try_from(context.authenticated_request_freshness.as_millis()).unwrap_or(u64::MAX);
    if now_ms.saturating_sub(issued_at_unix_ms) > freshness_ms {
        return Err(RuntimeError::Protocol(format!(
            "stale authenticated {expected_action} request"
        )));
    }
    if issued_at_unix_ms.saturating_sub(now_ms) > freshness_ms {
        return Err(RuntimeError::Protocol(format!(
            "authenticated {expected_action} request was issued too far in the future"
        )));
    }

    let replay_key = format!("{requester_peer_id}\n{expected_action}\n{expected_request_id}");
    let expires_at = now_ms.max(issued_at_unix_ms).saturating_add(freshness_ms);
    let durable = matches!(
        expected_action,
        "close_task"
            | "advance_task_stage"
            | "prepare_transfer"
            | "finalize_transfer"
            | "request_task_pull"
    );
    let expired_durable = {
        let mut authenticated_requests = context.authenticated_peer_requests.lock().await;
        let expired = authenticated_requests
            .iter()
            .filter(|(_, replay)| replay.expires_at_unix_ms < now_ms)
            .map(|(replay_key, replay)| (replay_key.clone(), replay.durable))
            .collect::<Vec<_>>();
        for (replay_key, _) in &expired {
            authenticated_requests.remove(replay_key);
        }
        if authenticated_requests.contains_key(&replay_key) {
            return Err(RuntimeError::Protocol(format!(
                "replayed authenticated {expected_action} request"
            )));
        }
        if authenticated_requests.len() >= context.max_authenticated_request_replays {
            return Err(RuntimeError::Backpressure(format!(
                "authenticated request replay window is full (maximum {})",
                context.max_authenticated_request_replays,
            )));
        }
        authenticated_requests.insert(
            replay_key.clone(),
            AuthenticatedPeerRequestReplay {
                expires_at_unix_ms: expires_at,
                durable,
            },
        );
        expired
            .into_iter()
            .filter_map(|(replay_key, durable)| durable.then_some(replay_key))
            .collect::<Vec<_>>()
    };

    if !expired_durable.is_empty() {
        let replay_store = Arc::clone(&context.replay_store);
        tokio::task::spawn_blocking(move || {
            for replay_key in expired_durable {
                replay_store.remove_authenticated_peer_request(&replay_key);
            }
        });
    }

    if durable {
        let replay_store = Arc::clone(&context.replay_store);
        let persisted_key = replay_key.clone();
        let persist_result = tokio::task::spawn_blocking(move || {
            replay_store.save_authenticated_peer_request(&persisted_key, expires_at)
        })
        .await;
        match persist_result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                context
                    .authenticated_peer_requests
                    .lock()
                    .await
                    .remove(&replay_key);
                return Err(error);
            }
            Err(error) => {
                context
                    .authenticated_peer_requests
                    .lock()
                    .await
                    .remove(&replay_key);
                return Err(RuntimeError::Protocol(format!(
                    "authenticated replay persistence task failed: {error}"
                )));
            }
        }
    }
    Ok(payload)
}

async fn requester_protocol_version(
    context: &ListenerContext,
    requester_peer_id: &str,
) -> Result<u32, RuntimeError> {
    Ok(find_peer(
        &context.discovery,
        &context.external_peers,
        &context.self_peer_id,
        requester_peer_id,
        TransferTransport::Auto,
    )
    .await?
    .protocol_version)
}

async fn require_terminal_input_semantics(
    context: &ListenerContext,
    requester_peer_id: &str,
) -> Result<(), RuntimeError> {
    let protocol_version = requester_protocol_version(context, requester_peer_id).await?;
    if supports_terminal_input_semantics(protocol_version) {
        return Ok(());
    }
    Err(RuntimeError::Protocol(format!(
        "peer {requester_peer_id} uses task-transfer protocol v{protocol_version} without explicit terminal submission/control semantics; upgrade the peer before sending terminal input",
    )))
}

async fn require_observer_terminal_input_compatibility(
    context: &ListenerContext,
    requester_peer_id: &str,
) -> Result<(), RuntimeError> {
    let protocol_version = requester_protocol_version(context, requester_peer_id).await?;
    if !supports_duplex_terminal(protocol_version)
        || supports_terminal_input_semantics(protocol_version)
    {
        return Ok(());
    }
    Err(RuntimeError::Protocol(format!(
        "peer {requester_peer_id} uses task-transfer protocol v{protocol_version} duplex terminal control without explicit submission/control semantics; upgrade the peer before observing terminal sessions",
    )))
}

fn authenticated_argument<T>(payload: &Value, name: &str) -> Result<T, RuntimeError>
where
    T: DeserializeOwned,
{
    let value = payload.get(name).cloned().ok_or_else(|| {
        RuntimeError::Protocol(format!("authenticated payload is missing {name}"))
    })?;
    serde_json::from_value(value).map_err(|error| {
        RuntimeError::Protocol(format!("authenticated payload has invalid {name}: {error}"))
    })
}

fn ensure_authenticated_argument<T>(
    payload: &Value,
    name: &str,
    outer: &T,
) -> Result<(), RuntimeError>
where
    T: DeserializeOwned + PartialEq,
{
    let authenticated: T = authenticated_argument(payload, name)?;
    if authenticated == *outer {
        Ok(())
    } else {
        Err(RuntimeError::Protocol(format!(
            "{name} does not match authenticated payload"
        )))
    }
}

fn ensure_optional_authenticated_argument<T>(
    payload: &Value,
    name: &str,
    outer: &T,
) -> Result<(), RuntimeError>
where
    T: DeserializeOwned + PartialEq,
{
    if payload.get(name).is_none() {
        return Ok(());
    }
    ensure_authenticated_argument(payload, name, outer)
}

async fn build_incoming_event(
    self_peer_id: &str,
    registry_root: &Path,
    discovery: &PeerDiscovery,
    external_peers: &ExternalPeerRegistry,
    transfer_id: &str,
    sealed_payload: String,
    incoming_reservations: &Arc<Mutex<HashMap<String, IncomingTransferReservation>>>,
    replay_store: &super::replay_store::TransferReplayStore,
) -> Result<IncomingTransferEvent, RuntimeError> {
    let reservation = {
        let mut reservations = incoming_reservations.lock().await;
        replay_store.prune_incoming_reservations(&mut reservations);
        reservations
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| RuntimeError::Protocol(format!("unknown transfer id {}", transfer_id)))?
    };

    let source_peer = find_peer(
        discovery,
        external_peers,
        self_peer_id,
        &reservation.source_peer_id,
        TransferTransport::Auto,
    )
    .await?;
    ensure_peer_is_trusted(
        registry_root,
        self_peer_id,
        external_peers,
        &reservation.source_peer_id,
        &source_peer.public_key,
    )?;
    let source_public_key = parse_public_key(&source_peer.public_key)?;
    let identity = load_or_create_identity(registry_root, self_peer_id)?;
    let payload = open_json(&identity, &source_public_key, &sealed_payload)?;

    let payload_source_task_id = payload
        .pointer("/task/source_task_id")
        .and_then(Value::as_str)
        .unwrap_or(&reservation.source_task_id);
    if payload_source_task_id != reservation.source_task_id {
        return Err(RuntimeError::Protocol(format!(
            "transfer {} payload source task does not match its reservation",
            transfer_id
        )));
    }

    let source_name = Some(source_peer.display_name);

    Ok(IncomingTransferEvent {
        transfer_id: transfer_id.to_owned(),
        source_peer_id: reservation.source_peer_id,
        source_task_id: reservation.source_task_id,
        source_name,
        payload,
    })
}

fn random_transfer_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
