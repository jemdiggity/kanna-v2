use super::events::{PairingResult, PairingStartedEvent, RuntimeError, RuntimeEvent};
use super::state::{PairingDecision, TransferRuntime};
use super::utils::{local_capabilities_json, pairing_verification_code, unexpected_peer_response};
use crate::crypto::public_key_to_string;
use crate::peer_store::PeerRecord;
use crate::protocol::{PeerRequest, PeerResponse};
use chrono::Utc;

impl TransferRuntime {
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
            .try_send(RuntimeEvent::PairingStarted(PairingStartedEvent {
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
}
