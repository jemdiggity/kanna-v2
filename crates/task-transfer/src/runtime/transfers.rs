use super::events::{FinalizedOutgoingTransfer, PreflightResult, RuntimeError, RuntimeEvent};
use super::state::StagedTransferArtifact;
use super::state::{OutgoingTransferReservation, TransferArtifactRecord, TransferRuntime};
use super::utils::{
    managed_artifact_dir, prune_outgoing_transfers, prune_transfer_artifacts,
    remove_owned_artifact_path, remove_owned_artifact_paths, take_transfer_artifacts,
    ArtifactFraming,
};
use super::TransferTransport;
use crate::crypto::{open_json, parse_public_key, seal_json};
use crate::protocol::{PeerRequest, PeerResponse};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

impl TransferRuntime {
    pub async fn prepare_transfer_preflight(
        &self,
        target_peer_id: &str,
        source_task_id: &str,
    ) -> Result<PreflightResult, RuntimeError> {
        self.prepare_transfer_preflight_with_transport(
            target_peer_id,
            source_task_id,
            TransferTransport::Auto,
        )
        .await
    }

    pub async fn prepare_transfer_preflight_with_transport(
        &self,
        target_peer_id: &str,
        source_task_id: &str,
        transport: TransferTransport,
    ) -> Result<PreflightResult, RuntimeError> {
        let (target_peer, resolved_transport) = self
            .resolve_peer_with_transport(target_peer_id, transport)
            .await?;
        self.ensure_peer_is_trusted_for_transport(
            &target_peer.peer_id,
            &target_peer.public_key,
            resolved_transport,
        )?;
        let request_id = self.next_request_id("preflight");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "prepare_transfer",
                &request_id,
                serde_json::json!({
                    "source_peer_id": self.config.peer_id,
                    "source_task_id": source_task_id,
                    "reserved_target_peer_id": target_peer.peer_id,
                }),
            )
            .await?;
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
                for expired in
                    prune_outgoing_transfers(&mut transfers, self.config.pending_transfer_ttl)
                {
                    self.replay_store.remove_reservation(&expired);
                }
                let reservation = OutgoingTransferReservation {
                    target_peer_id: target_peer_id.to_owned(),
                    source_task_id: source_task_id.to_owned(),
                    target_peer: Some(target_peer),
                    transport: Some(resolved_transport),
                    created_at: Instant::now(),
                };
                self.replay_store
                    .save_reservation(&transfer_id, &reservation)?;
                transfers.insert(transfer_id.clone(), reservation);

                Ok(PreflightResult {
                    transfer_id,
                    source_peer_id,
                    target_has_repo,
                })
            }
            PeerResponse::StartPairing { .. } => Err(RuntimeError::Protocol(
                "unexpected pairing response during preflight".into(),
            )),
            PeerResponse::RequestTaskPull { .. } => Err(RuntimeError::Protocol(
                "unexpected task-pull response during preflight".into(),
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
            PeerResponse::AbandonTransfer { .. } => Err(RuntimeError::Protocol(
                "unexpected abandon response during preflight".into(),
            )),
            PeerResponse::TaskSnapshot { .. } => Err(RuntimeError::Protocol(
                "unexpected task-snapshot response during preflight".into(),
            )),
            PeerResponse::AuthenticatedRequestEpoch { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::ObserveCompanion { .. }
            | PeerResponse::SendCompanionEvent { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. }
            | PeerResponse::ReadTaskFile { .. }
            | PeerResponse::ReadTaskDirectory { .. }
            | PeerResponse::ReadTaskDiff { .. }
            | PeerResponse::MarkTaskRead { .. } => Err(RuntimeError::Protocol(
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
        let reservation = {
            let mut transfers = self.outgoing_transfers.lock().await;
            for expired in
                prune_outgoing_transfers(&mut transfers, self.config.pending_transfer_ttl)
            {
                self.replay_store.remove_reservation(&expired);
            }
            transfers.get(transfer_id).cloned()
        }
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing target peer for transfer commit {}",
                transfer_id
            ))
        })?;

        let target_peer = match reservation.target_peer {
            Some(peer) => peer,
            None => self.find_peer(&reservation.target_peer_id).await?,
        };
        match reservation.transport {
            Some(transport) => self.ensure_peer_is_trusted_for_transport(
                &target_peer.peer_id,
                &target_peer.public_key,
                transport,
            )?,
            None => {
                self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
            }
        }
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
            PeerResponse::RequestTaskPull { .. } => Err(RuntimeError::Protocol(
                "unexpected task-pull response during transfer commit".into(),
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
            PeerResponse::AbandonTransfer { .. } => Err(RuntimeError::Protocol(
                "unexpected abandon response during transfer commit".into(),
            )),
            PeerResponse::TaskSnapshot { .. } => Err(RuntimeError::Protocol(
                "unexpected task-snapshot response during transfer commit".into(),
            )),
            PeerResponse::AuthenticatedRequestEpoch { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::ObserveCompanion { .. }
            | PeerResponse::SendCompanionEvent { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. }
            | PeerResponse::ReadTaskFile { .. }
            | PeerResponse::ReadTaskDirectory { .. }
            | PeerResponse::ReadTaskDiff { .. }
            | PeerResponse::MarkTaskRead { .. } => Err(RuntimeError::Protocol(
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
            self.replay_store
                .prune_incoming_reservations(&mut reservations);
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
        let request_id = self.next_request_id("finalize");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &source_peer,
                "finalize_transfer",
                &request_id,
                serde_json::json!({
                    "requester_peer_id": self.config.peer_id,
                    "transfer_id": transfer_id,
                    "reserved_target_peer_id": self.config.peer_id,
                }),
            )
            .await?;
        let response = self
            .send_peer_request_with_timeout(
                &source_peer,
                PeerRequest::FinalizeTransfer {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
                // The source's own budget for shutting its agent down, plus one
                // ordinary request window to deliver the answer. Outlasting the
                // source by that margin is what makes the source's reply
                // authoritative: a destination that gave up first would report
                // `PeerRequestTimeout` for a finalization that had in fact
                // concluded, and spend an import attempt on it.
                self.config
                    .finalization_request_timeout
                    .saturating_add(self.config.peer_request_timeout),
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
                let source_public_key = parse_public_key(&source_peer.public_key)?;
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
            PeerResponse::AuthenticatedRequestEpoch { .. }
            | PeerResponse::StartPairing { .. }
            | PeerResponse::RequestTaskPull { .. }
            | PeerResponse::PrepareTransfer { .. }
            | PeerResponse::SubmitTransferPayload { .. }
            | PeerResponse::FetchTransferArtifact { .. }
            | PeerResponse::ImportCommitted { .. }
            | PeerResponse::TaskSnapshot { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::ObserveCompanion { .. }
            | PeerResponse::SendCompanionEvent { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. }
            | PeerResponse::ReadTaskFile { .. }
            | PeerResponse::ReadTaskDirectory { .. }
            | PeerResponse::ReadTaskDiff { .. }
            | PeerResponse::AbandonTransfer { .. }
            | PeerResponse::MarkTaskRead { .. } => Err(RuntimeError::Protocol(
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
        let cached = result.map_err(|error| error.to_string());
        let failed = cached.is_err();
        let waiters = {
            let mut finalizations = self.pending_outgoing_transfer_finalizations.lock().await;
            let state = finalizations.get_mut(transfer_id).ok_or_else(|| {
                RuntimeError::Protocol(format!(
                    "missing pending outgoing transfer finalization {}",
                    transfer_id
                ))
            })?;
            match state {
                super::state::OutgoingTransferFinalizationState::Pending { waiters } => {
                    let waiters = std::mem::take(waiters);
                    *state =
                        super::state::OutgoingTransferFinalizationState::Completed(cached.clone());
                    waiters
                }
                super::state::OutgoingTransferFinalizationState::Completed(_) => return Ok(()),
            }
        };
        for waiter in waiters {
            let _ = waiter.send(cached.clone());
        }
        if failed {
            self.cleanup_transfer_artifacts(transfer_id).await;
        }
        Ok(())
    }

    pub async fn next_event(&self) -> Result<RuntimeEvent, RuntimeError> {
        enum NextEvent {
            General(Option<RuntimeEvent>),
            Receipt(Option<super::events::OutgoingTransferCommittedEvent>),
        }

        loop {
            let next = {
                let mut general = self.incoming_events.lock().await;
                let mut receipts = self.receipt_events.lock().await;
                tokio::select! {
                    event = general.recv() => NextEvent::General(event),
                    event = receipts.recv() => NextEvent::Receipt(event),
                }
            };
            match next {
                NextEvent::General(Some(event)) => return Ok(event),
                NextEvent::Receipt(Some(event)) => {
                    let mut receipts = self.import_commit_receipts.lock().await;
                    let Some(receipt) = receipts.get_mut(&event.transfer_id) else {
                        continue;
                    };
                    receipt.event_queued = false;
                    if receipt.applied {
                        continue;
                    }
                    receipt.delivery_in_flight = true;
                    return Ok(RuntimeEvent::OutgoingTransferCommitted(event));
                }
                NextEvent::General(None) | NextEvent::Receipt(None) => {
                    return Err(RuntimeError::IncomingEventChannelClosed);
                }
            }
        }
    }

    pub async fn stage_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
        mut path: PathBuf,
        owned: bool,
    ) -> Result<(), RuntimeError> {
        if owned {
            let artifact_dir =
                managed_artifact_dir(&self.config.registry_dir, &self.config.peer_id, transfer_id);
            tokio::fs::create_dir_all(&artifact_dir).await?;
            // Named from the artifact id alone: the source basename is
            // unbounded, and the name is purely local storage — the payload
            // carries the user-visible file name. See
            // `utils::managed_artifact_filename`.
            let managed_path =
                artifact_dir.join(super::utils::managed_artifact_filename(artifact_id));
            if path != managed_path {
                match tokio::fs::rename(&path, &managed_path).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
                        tokio::fs::copy(&path, &managed_path).await?;
                        tokio::fs::remove_file(&path).await?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            path = managed_path;
        }
        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        let expired =
            prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        let retained_path = path.clone();
        let replaced = transfer_artifacts
            .entry(transfer_id.to_owned())
            .or_default()
            .insert(
                artifact_id.to_owned(),
                TransferArtifactRecord {
                    path,
                    created_at: Instant::now(),
                    owned,
                },
            );
        drop(transfer_artifacts);
        let mut cleanup = expired;
        if let Some(replaced) = replaced {
            if replaced.owned {
                cleanup.push(replaced.path);
            }
        }
        cleanup.retain(|path| path != &retained_path);
        remove_owned_artifact_paths(cleanup).await;
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
            self.replay_store
                .prune_incoming_reservations(&mut reservations);
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
        let request_id = self.next_request_id("fetch-artifact");
        let artifact_framing = ArtifactFraming::for_protocol(source_peer.protocol_version);
        let sealed_payload = seal_json(
            &self.identity,
            &source_public_key,
            &serde_json::json!({
                "request_id": request_id,
                "transfer_id": transfer_id,
                "artifact_id": artifact_id,
                "artifact_framing": artifact_framing.name(),
            }),
        )?;
        let path = self
            .fetch_peer_artifact_stream(
                &source_peer,
                PeerRequest::FetchTransferArtifact {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
                &request_id,
                transfer_id,
                artifact_id,
                artifact_framing,
                &source_public_key,
            )
            .await?;
        Ok(StagedTransferArtifact { path })
    }

    pub async fn acknowledge_import_committed(
        &self,
        transfer_id: &str,
        source_task_id: &str,
        destination_local_task_id: &str,
    ) -> Result<(), RuntimeError> {
        let source_peer_id = {
            let mut reservations = self.incoming_reservations.lock().await;
            self.replay_store
                .prune_incoming_reservations(&mut reservations);
            reservations.get(transfer_id).map(|reservation| {
                (
                    reservation.source_peer_id.clone(),
                    reservation.source_task_id.clone(),
                )
            })
        }
        .ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing source peer for import acknowledgment {}",
                transfer_id
            ))
        })?;

        let (source_peer_id, reserved_source_task_id) = source_peer_id;
        if reserved_source_task_id != source_task_id {
            return Err(RuntimeError::Protocol(format!(
                "unexpected source task {} for import acknowledgment {}",
                source_task_id, transfer_id
            )));
        }
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

                Ok(())
            }
            PeerResponse::AuthenticatedRequestEpoch { .. }
            | PeerResponse::StartPairing { .. }
            | PeerResponse::RequestTaskPull { .. }
            | PeerResponse::PrepareTransfer { .. }
            | PeerResponse::SubmitTransferPayload { .. }
            | PeerResponse::FetchTransferArtifact { .. }
            | PeerResponse::FinalizeTransfer { .. }
            | PeerResponse::TaskSnapshot { .. }
            | PeerResponse::ObserveSession { .. }
            | PeerResponse::ObserveCompanion { .. }
            | PeerResponse::SendCompanionEvent { .. }
            | PeerResponse::SendSessionInput { .. }
            | PeerResponse::ResizeSession { .. }
            | PeerResponse::CloseTask { .. }
            | PeerResponse::AdvanceTaskStage { .. }
            | PeerResponse::ReadTaskFile { .. }
            | PeerResponse::ReadTaskDirectory { .. }
            | PeerResponse::ReadTaskDiff { .. }
            | PeerResponse::AbandonTransfer { .. }
            | PeerResponse::MarkTaskRead { .. } => Err(RuntimeError::Protocol(
                "unexpected response while acknowledging import commit".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }

    /// Releases an outgoing reservation whose transfer will never be committed.
    ///
    /// A preflight writes a durable reservation to the registry dir and may be
    /// followed by staged artifacts (repo bundle, session archives) before the
    /// caller discovers the push is a duplicate. Without this the reservation
    /// and its temp files sit on disk until the TTL sweeper notices — the leak
    /// the duplicate-push race left behind on 2026-08-06. Abandoning an unknown
    /// transfer id is deliberately not an error: the caller's job is to make
    /// sure nothing is left, not to prove something was.
    ///
    /// Unlike the sweeps, this path reports what it could not delete. Its
    /// caller tells the operator the reservation is released, so returning
    /// success over a file that survived would recreate the silent leak in a
    /// quieter form. Both halves are attempted before the first failure is
    /// returned, and anything left undeleted stays retriable.
    /// The destination is released first, and a failure there returns before
    /// any local state is dropped. The local reservation is the only record of
    /// which peer holds the matching incoming one, so discarding it after a
    /// failed remote leg would leave a reservation nobody can address; keeping
    /// it makes the whole release retriable.
    pub async fn abandon_outgoing_transfer(&self, transfer_id: &str) -> Result<(), RuntimeError> {
        let reservation = self
            .outgoing_transfers
            .lock()
            .await
            .get(transfer_id)
            .cloned();
        if let Some(reservation) = reservation {
            self.release_peer_transfer_reservation(transfer_id, &reservation)
                .await?;
        }
        self.outgoing_transfers.lock().await.remove(transfer_id);
        let reservation = self
            .replay_store
            .remove_reservation_checked(transfer_id)
            .map_err(RuntimeError::from);
        let artifacts = self.cleanup_transfer_artifacts_checked(transfer_id).await;
        reservation.and(artifacts)
    }

    /// Tells the destination to drop the `incoming-reservations/<id>.json` its
    /// preflight created. Modelled on the prepare/finalize handlers: sealed,
    /// bound to this source and this transfer, and pinned to the peer that was
    /// reserved rather than whoever answers the address now.
    async fn release_peer_transfer_reservation(
        &self,
        transfer_id: &str,
        reservation: &OutgoingTransferReservation,
    ) -> Result<(), RuntimeError> {
        let target_peer = match reservation.target_peer.clone() {
            Some(peer) => peer,
            None => self.find_peer(&reservation.target_peer_id).await?,
        };
        match reservation.transport {
            Some(transport) => self.ensure_peer_is_trusted_for_transport(
                &target_peer.peer_id,
                &target_peer.public_key,
                transport,
            )?,
            None => self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?,
        }
        let request_id = self.next_request_id("abandon");
        let sealed_payload = self
            .seal_authenticated_peer_request(
                &target_peer,
                "abandon_transfer",
                &request_id,
                serde_json::json!({
                    "source_peer_id": self.config.peer_id,
                    "transfer_id": transfer_id,
                    "reserved_target_peer_id": target_peer.peer_id,
                }),
            )
            .await?;
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::AbandonTransfer {
                    request_id: request_id.clone(),
                    transfer_id: transfer_id.to_owned(),
                    source_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
            )
            .await?;

        match response {
            PeerResponse::AbandonTransfer {
                request_id: response_request_id,
                transfer_id: response_transfer_id,
            } => {
                if response_request_id != request_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched request id in abandon response: expected {}, got {}",
                        request_id, response_request_id
                    )));
                }
                if response_transfer_id != transfer_id {
                    return Err(RuntimeError::Protocol(format!(
                        "mismatched transfer id in abandon response: expected {}, got {}",
                        transfer_id, response_transfer_id
                    )));
                }
                Ok(())
            }
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
            _ => Err(RuntimeError::Protocol(
                "unexpected response while abandoning an outgoing transfer".into(),
            )),
        }
    }

    pub async fn mark_import_ack_completed(&self, transfer_id: &str) -> Result<(), RuntimeError> {
        self.incoming_reservations.lock().await.remove(transfer_id);
        self.replay_store.remove_incoming_reservation(transfer_id);
        self.cleanup_transfer_artifacts(transfer_id).await;
        Ok(())
    }

    pub(super) async fn cleanup_transfer_artifacts(&self, transfer_id: &str) {
        let paths = {
            let mut artifacts = self.transfer_artifacts.lock().await;
            take_transfer_artifacts(&mut artifacts, transfer_id)
        };
        remove_owned_artifact_paths(paths).await;
    }

    /// Like [`Self::cleanup_transfer_artifacts`], but reports what it could not
    /// delete and keeps that work retriable.
    ///
    /// Taking the records out of the map is what makes a failed deletion
    /// unrecoverable: the path is the only handle anyone has on the file. Any
    /// record whose file survived therefore goes back, so a retried abandon
    /// still knows what it owes the disk. Everything actually deleted stays
    /// deleted, so the retry does not redo work.
    async fn cleanup_transfer_artifacts_checked(
        &self,
        transfer_id: &str,
    ) -> Result<(), RuntimeError> {
        let records = {
            let mut artifacts = self.transfer_artifacts.lock().await;
            artifacts.remove(transfer_id).unwrap_or_default()
        };

        let mut undeleted = HashMap::new();
        let mut failure: Option<std::io::Error> = None;
        for (artifact_id, record) in records {
            if !record.owned {
                continue;
            }
            if let Err(error) = remove_owned_artifact_path(&record.path).await {
                undeleted.insert(artifact_id, record);
                failure.get_or_insert(error);
            }
        }

        if !undeleted.is_empty() {
            let mut artifacts = self.transfer_artifacts.lock().await;
            artifacts
                .entry(transfer_id.to_owned())
                .or_default()
                .extend(undeleted);
        }

        match failure {
            Some(error) => Err(RuntimeError::from(error)),
            None => Ok(()),
        }
    }

    pub async fn mark_incoming_event_recorded(
        &self,
        transfer_id: &str,
    ) -> Result<(), RuntimeError> {
        let mut reservations = self.incoming_reservations.lock().await;
        let reservation = reservations.get_mut(transfer_id).ok_or_else(|| {
            RuntimeError::Protocol(format!(
                "missing incoming transfer reservation {}",
                transfer_id
            ))
        })?;
        if reservation.event_recorded {
            return Ok(());
        }
        let mut recorded = reservation.clone();
        recorded.event_recorded = true;
        self.replay_store
            .save_incoming_reservation(transfer_id, &recorded)?;
        *reservation = recorded;
        Ok(())
    }

    pub async fn mark_import_commit_applied(&self, transfer_id: &str) -> Result<(), RuntimeError> {
        let mut receipts = self.import_commit_receipts.lock().await;
        let receipt = receipts.get_mut(transfer_id).ok_or_else(|| {
            RuntimeError::Protocol(format!("missing import commit receipt {}", transfer_id))
        })?;
        if receipt.applied {
            return Ok(());
        }
        let mut applied = receipt.clone();
        applied.applied = true;
        applied.delivery_in_flight = false;
        self.replay_store.save_receipt(transfer_id, &applied)?;
        *receipt = applied;
        self.replay_store.compact_receipts(&mut receipts);
        Ok(())
    }

    pub async fn nack_import_commit(&self, transfer_id: &str) -> Result<(), RuntimeError> {
        let mut receipts = self.import_commit_receipts.lock().await;
        let receipt = receipts.get_mut(transfer_id).ok_or_else(|| {
            RuntimeError::Protocol(format!("missing import commit receipt {}", transfer_id))
        })?;
        if receipt.applied {
            return Ok(());
        }
        receipt.delivery_in_flight = false;
        Ok(())
    }
}
