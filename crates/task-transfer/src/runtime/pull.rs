use super::events::RuntimeError;
use super::state::{PendingTaskPullRequest, TransferRuntime};
use super::utils::unexpected_peer_response;
use super::TransferTransport;
use crate::crypto::{parse_public_key, seal_json};
use crate::protocol::{PeerRequest, PeerResponse};
use std::time::{Duration, Instant};

pub(super) const TASK_PULL_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);

pub(super) fn validate_source_task_id(source_task_id: &str) -> Result<(), RuntimeError> {
    if source_task_id.trim().is_empty() {
        return Err(RuntimeError::Protocol(
            "source task ID must not be blank".into(),
        ));
    }
    if source_task_id.len() > 1024 {
        return Err(RuntimeError::Protocol(format!(
            "source task ID exceeds 1024 UTF-8 bytes (received {})",
            source_task_id.len()
        )));
    }
    if source_task_id.chars().any(char::is_control) {
        return Err(RuntimeError::Protocol(
            "source task ID contains a control character".into(),
        ));
    }
    Ok(())
}

pub(super) fn prune_task_pull_requests(
    requests: &mut std::collections::HashMap<(String, String), PendingTaskPullRequest>,
) {
    let now = Instant::now();
    requests.retain(|_, request| {
        now.saturating_duration_since(request.created_at) < TASK_PULL_REQUEST_TTL
    });
}

impl TransferRuntime {
    pub async fn request_task_pull(
        &self,
        target_peer_id: &str,
        source_task_id: &str,
        transport: TransferTransport,
    ) -> Result<String, RuntimeError> {
        validate_source_task_id(source_task_id)?;
        if target_peer_id == self.config.peer_id {
            return Err(RuntimeError::Protocol(
                "cannot request a task pull from this runtime".into(),
            ));
        }

        let (target_peer, resolved_transport) = self
            .resolve_peer_with_transport(target_peer_id, transport)
            .await?;
        self.ensure_peer_is_trusted_for_transport(
            &target_peer.peer_id,
            &target_peer.public_key,
            resolved_transport,
        )?;
        let target_public_key = parse_public_key(&target_peer.public_key)?;
        let sealed_payload = seal_json(
            &self.identity,
            &target_public_key,
            &serde_json::json!({ "source_task_id": source_task_id }),
        )?;
        let wire_request_id = self.next_request_id("task-pull");
        let response = self
            .send_peer_request(
                &target_peer,
                PeerRequest::RequestTaskPull {
                    request_id: wire_request_id,
                    requester_peer_id: self.config.peer_id.clone(),
                    sealed_payload,
                },
            )
            .await?;

        match response {
            PeerResponse::RequestTaskPull { request_id } => Ok(request_id),
            PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
            other => Err(unexpected_peer_response("task-pull", &other)),
        }
    }
}
