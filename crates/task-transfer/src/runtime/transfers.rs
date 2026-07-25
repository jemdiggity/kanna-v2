use super::events::{FinalizedOutgoingTransfer, PreflightResult, RuntimeError, RuntimeEvent};
use super::state::StagedTransferArtifact;
use super::state::{OutgoingTransferReservation, TransferArtifactRecord, TransferRuntime};
use super::utils::{
    prune_incoming_reservations, prune_outgoing_transfers, prune_transfer_artifacts,
};
use crate::crypto::{open_json, parse_public_key, seal_json};
use crate::protocol::{PeerRequest, PeerResponse};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Instant;

impl TransferRuntime {
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
            | PeerResponse::AdvanceTaskStage { .. }
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
            | PeerResponse::AdvanceTaskStage { .. }
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
            | PeerResponse::AdvanceTaskStage { .. }
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
            | PeerResponse::AdvanceTaskStage { .. }
            | PeerResponse::MarkTaskRead { .. } => Err(RuntimeError::Protocol(
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
            | PeerResponse::AdvanceTaskStage { .. }
            | PeerResponse::MarkTaskRead { .. } => Err(RuntimeError::Protocol(
                "unexpected response while acknowledging import commit".into(),
            )),
            PeerResponse::Error {
                request_id: _,
                message,
            } => Err(RuntimeError::Protocol(message)),
        }
    }
}
