use super::events::RuntimeError;
use super::state::{OutgoingTransferReservation, StoredIdentity, TransferArtifactRecord};
use crate::crypto::TransferIdentity;
use crate::peer_store::PeerStore;
use crate::protocol::{PeerResponse, PeerTerminalEvent};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub(super) const CURRENT_PROTOCOL_VERSION: u32 = 2;
pub(super) const AUTHENTICATED_TASK_REQUEST_VERSION: u32 = 1;

pub(super) fn parse_peer_response_line(
    peer_id: &str,
    operation: &str,
    line: &str,
) -> Result<PeerResponse, RuntimeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::Protocol(format!(
            "peer {peer_id} returned an empty response for {operation}"
        )));
    }

    serde_json::from_str::<PeerResponse>(trimmed).map_err(|error| {
        RuntimeError::Protocol(format!(
            "peer {peer_id} returned a non-JSON response for {operation}: {error}"
        ))
    })
}

pub(super) fn parse_peer_terminal_event_line(
    peer_id: &str,
    session_id: &str,
    line: &str,
) -> Result<PeerTerminalEvent, RuntimeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::Protocol(format!(
            "peer {peer_id} returned an empty terminal event for session {session_id}"
        )));
    }

    serde_json::from_str::<PeerTerminalEvent>(trimmed).map_err(|error| {
        RuntimeError::Protocol(format!(
            "peer {peer_id} returned a non-JSON terminal event for session {session_id}: {error}"
        ))
    })
}

pub(super) fn terminal_observer_key(peer_id: &str, session_id: &str) -> String {
    format!("{peer_id}:{session_id}")
}

pub(super) fn peer_terminal_event_session_id(event: &PeerTerminalEvent) -> &str {
    match event {
        PeerTerminalEvent::Snapshot { session_id, .. }
        | PeerTerminalEvent::Output { session_id, .. }
        | PeerTerminalEvent::Exit { session_id, .. }
        | PeerTerminalEvent::Error { session_id, .. } => session_id,
    }
}

pub(super) fn extract_request_id(line: &str) -> String {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

pub(super) async fn write_json_line<T>(
    stream: &mut TcpStream,
    value: &T,
) -> Result<(), RuntimeError>
where
    T: serde::Serialize,
{
    let encoded = serde_json::to_vec(value)?;
    stream.write_all(&encoded).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

pub(super) fn registry_entry_path(root: &Path, peer_id: &str) -> PathBuf {
    root.join(format!("{}.json", URL_SAFE_NO_PAD.encode(peer_id)))
}

pub(super) fn peer_store(root: &Path, self_peer_id: &str) -> Result<PeerStore, RuntimeError> {
    Ok(PeerStore::new(root.join("trusted-peers").join(format!(
        "{}.json",
        URL_SAFE_NO_PAD.encode(self_peer_id)
    ))))
}

fn identity_path(root: &Path, self_peer_id: &str) -> PathBuf {
    root.join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode(self_peer_id)))
}

pub(super) fn load_or_create_identity(
    root: &Path,
    self_peer_id: &str,
) -> Result<TransferIdentity, RuntimeError> {
    let path = identity_path(root, self_peer_id);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if !contents.trim().is_empty() {
            let stored: StoredIdentity = serde_json::from_str(&contents)?;
            return TransferIdentity::from_secret_string(&stored.secret_key)
                .map_err(|error| RuntimeError::InvalidConfig(error.to_string()));
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let identity = TransferIdentity::generate();
    let stored = StoredIdentity {
        secret_key: identity.secret_key_string(),
    };
    std::fs::write(path, serde_json::to_vec_pretty(&stored)?)?;
    Ok(identity)
}

pub(super) fn local_capabilities_json() -> String {
    serde_json::json!({
        "protocolVersion": CURRENT_PROTOCOL_VERSION,
        "transferCapabilityVersion": 1,
        "authenticatedTaskRequests": true,
        "authenticatedTaskRequestVersion": AUTHENTICATED_TASK_REQUEST_VERSION,
    })
    .to_string()
}

pub(super) fn supports_authenticated_task_requests(
    protocol_version: u32,
    capabilities_json: &str,
) -> bool {
    if protocol_version < CURRENT_PROTOCOL_VERSION {
        return false;
    }
    let Ok(capabilities) = serde_json::from_str::<Value>(capabilities_json) else {
        return false;
    };
    capabilities
        .get("authenticatedTaskRequests")
        .and_then(Value::as_bool)
        == Some(true)
        && capabilities
            .get("authenticatedTaskRequestVersion")
            .and_then(Value::as_u64)
            .is_some_and(|version| version >= AUTHENTICATED_TASK_REQUEST_VERSION as u64)
}

pub(super) fn ensure_peer_is_trusted_for(
    root: &Path,
    self_peer_id: &str,
    peer_id: &str,
    observed_public_key: &str,
) -> Result<(), RuntimeError> {
    let trusted = peer_store(root, self_peer_id)?
        .list_active()?
        .into_iter()
        .find(|record| record.peer_id == peer_id)
        .filter(|record| record.public_key == observed_public_key)
        .is_some();

    if trusted {
        Ok(())
    } else {
        Err(RuntimeError::Protocol(format!(
            "peer {} is not trusted",
            peer_id
        )))
    }
}

pub(super) fn pairing_verification_code(
    left_peer_id: &str,
    left_public_key: &str,
    right_peer_id: &str,
    right_public_key: &str,
) -> String {
    let mut participants = [
        format!("{left_peer_id}:{left_public_key}"),
        format!("{right_peer_id}:{right_public_key}"),
    ];
    participants.sort();

    let mut hasher = Sha256::new();
    hasher.update(participants[0].as_bytes());
    hasher.update(b"|");
    hasher.update(participants[1].as_bytes());
    let digest = hasher.finalize();
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

pub(super) fn unexpected_peer_response(operation: &str, response: &PeerResponse) -> RuntimeError {
    RuntimeError::Protocol(format!(
        "unexpected response while handling {}: {:?}",
        operation, response
    ))
}

pub(super) fn prune_outgoing_transfers(
    transfers: &mut HashMap<String, OutgoingTransferReservation>,
    pending_transfer_ttl: Duration,
) -> Vec<String> {
    let now = Instant::now();
    let expired = transfers
        .iter()
        .filter(|(_, reservation)| {
            now.duration_since(reservation.created_at) >= pending_transfer_ttl
        })
        .map(|(transfer_id, _)| transfer_id.clone())
        .collect::<Vec<_>>();
    for transfer_id in &expired {
        transfers.remove(transfer_id);
    }
    expired
}

pub(super) fn prune_transfer_artifacts(
    transfer_artifacts: &mut HashMap<String, HashMap<String, TransferArtifactRecord>>,
    pending_transfer_ttl: Duration,
) -> Vec<std::path::PathBuf> {
    let now = Instant::now();
    let mut owned_paths = Vec::new();
    transfer_artifacts.retain(|_, artifacts| {
        artifacts.retain(|_, artifact| {
            let keep = now.duration_since(artifact.created_at) < pending_transfer_ttl;
            if !keep && artifact.owned {
                owned_paths.push(artifact.path.clone());
            }
            keep
        });
        !artifacts.is_empty()
    });
    owned_paths
}

pub(super) fn take_transfer_artifacts(
    transfer_artifacts: &mut HashMap<String, HashMap<String, TransferArtifactRecord>>,
    transfer_id: &str,
) -> Vec<std::path::PathBuf> {
    transfer_artifacts
        .remove(transfer_id)
        .into_iter()
        .flat_map(|artifacts| artifacts.into_values())
        .filter(|artifact| artifact.owned)
        .map(|artifact| artifact.path)
        .collect()
}

pub(super) async fn remove_owned_artifact_paths(paths: Vec<std::path::PathBuf>) {
    for path in paths {
        let _ = tokio::fs::remove_file(&path).await;
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::remove_dir(parent).await;
        }
    }
}

pub(super) fn sanitize_artifact_filename(filename: &str) -> String {
    let sanitized = filename
        .chars()
        .map(|character| match character {
            '/' | '\\' => '-',
            _ => character,
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "artifact".to_string()
    } else {
        sanitized
    }
}
