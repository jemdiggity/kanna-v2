use super::daemon::{
    advance_owner_task_stage, close_owner_task, mark_owner_task_read, prepare_session_observer,
    read_owner_task_file, resize_daemon_session, send_daemon_input, stream_daemon_session,
};
use super::discovery::PeerDiscovery;
use super::events::{
    IncomingTransferEvent, OutgoingTransferCommittedEvent,
    OutgoingTransferFinalizationRequestedEvent, PairingCompletedEvent, PairingRequestedEvent,
    RuntimeError, RuntimeEvent,
};
use super::replay_store::unix_ms;
use super::state::{
    ImportCommitReceipt, IncomingTransferReservation, ListenerContext, PairingDecision,
    PendingPairingRequest,
};
use super::utils::{
    ensure_peer_is_trusted_for, extract_request_id, load_or_create_identity,
    local_capabilities_json, pairing_verification_code, peer_store, prune_outgoing_transfers,
    prune_transfer_artifacts, write_json_line,
};
use crate::crypto::{open_json, parse_public_key, seal_json};
use crate::peer_store::PeerRecord;
use crate::protocol::{PairingPeer, PeerRequest, PeerResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use rand_core::{OsRng, RngCore};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

pub(super) async fn run_listener(listener: TcpListener, context: ListenerContext) {
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
                sealed_payload,
                &context.incoming_reservations,
                &context.replay_store,
            )
            .await
            {
                Ok(event) => {
                    {
                        let mut reservations = context.incoming_reservations.lock().await;
                        let reservation = reservations.get_mut(&transfer_id).ok_or_else(|| {
                            RuntimeError::Protocol(format!("unknown transfer id {}", transfer_id))
                        })?;
                        reservation.committed = true;
                        context
                            .replay_store
                            .save_incoming_reservation(&transfer_id, reservation)?;
                    }
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
                    for expired in
                        prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl)
                    {
                        context.replay_store.remove_reservation(&expired);
                    }
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
                    for expired in
                        prune_outgoing_transfers(&mut transfers, context.pending_transfer_ttl)
                    {
                        context.replay_store.remove_reservation(&expired);
                    }
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

                if let Some(receipt) = existing_receipt {
                    if receipt.source_task_id != source_task_id
                        || receipt.destination_local_task_id != destination_local_task_id
                    {
                        return Err(RuntimeError::Protocol(format!(
                            "mismatched duplicate import acknowledgment for transfer {}",
                            transfer_id
                        )));
                    }
                    if !receipt.applied {
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
                    }
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
                    source_task_id: source_task_id.clone(),
                    destination_local_task_id: destination_local_task_id.clone(),
                    created_at_unix_ms: unix_ms(),
                    applied: false,
                };
                context.replay_store.save_receipt(&transfer_id, &receipt)?;
                receipts.insert(transfer_id.clone(), receipt);
                context.outgoing_transfers.lock().await.remove(&transfer_id);
                context.replay_store.remove_reservation(&transfer_id);
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
                    Ok((daemon, initial_snapshot)) => {
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
        Ok(PeerRequest::ReadTaskFile {
            request_id,
            requester_peer_id,
            task_id,
            path,
        }) => match read_owner_task_file(&context, &requester_peer_id, &task_id, &path).await {
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
            let identity = load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
            let payload = open_json(&identity, &requester_public_key, &sealed_payload)?;
            let task_id = payload
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RuntimeError::Protocol("mark-read payload missing task_id".into())
                })?;
            let expected_activity_revision = payload
                .get("expected_activity_revision")
                .and_then(Value::as_i64)
                .filter(|revision| *revision >= 0)
                .ok_or_else(|| {
                    RuntimeError::Protocol(
                        "mark-read payload missing expected_activity_revision".into(),
                    )
                })?;
            mark_owner_task_read(
                &context,
                &requester_peer_id,
                task_id,
                expected_activity_revision,
            )
            .await?;
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

    write_json_line(&mut stream, &response).await?;
    Ok(())
}

async fn build_incoming_event(
    self_peer_id: &str,
    registry_root: &Path,
    discovery: &PeerDiscovery,
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
