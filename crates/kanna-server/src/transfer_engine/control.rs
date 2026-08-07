//! Thin, typed wrappers over the sidecar control operations the engine uses.
//!
//! Every call goes through the same allowlisted `transfer_control` dispatch the
//! desktop routes use, so there is exactly one vocabulary for the pipe. What
//! these add is the shape checking the renderer used to do in TypeScript after
//! the round trip.

use crate::http_api::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct PreflightResult {
    pub transfer_id: String,
    pub source_peer_id: String,
    pub target_has_repo: bool,
}

async fn control(state: &Arc<AppState>, operation: &str, params: Value) -> Result<Value, String> {
    state.transfer_sidecar().control(operation, params).await
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("transfer sidecar response missing {key}"))
}

/// The transient failures a LAN attempt is allowed to fall back to cloud over.
///
/// Anything else — a refused pairing, a rejected payload — is a real answer and
/// must not be retried on another transport.
pub fn is_connection_failure(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "i/o error:",
        "peer not found:",
        "timed out after",
        "connection refused",
        "connection reset",
        "connection closed",
        "no route to host",
        "network is unreachable",
        "broken pipe",
    ]
    .iter()
    .any(|fragment| message.contains(fragment))
}

pub async fn preflight(
    state: &Arc<AppState>,
    source_task_id: &str,
    target_peer_id: &str,
    transport: Option<&str>,
    cloud_fallback: bool,
) -> Result<PreflightResult, String> {
    let request = |transport: Option<&str>| {
        let mut payload = json!({
            "phase": "preflight",
            "sourceTaskId": source_task_id,
            "targetPeerId": target_peer_id,
        });
        if let Some(transport) = transport {
            payload["transport"] = json!(transport);
        }
        json!({ "payload": payload })
    };
    let response = match control(state, "prepare-outgoing-transfer", request(transport)).await {
        Ok(response) => response,
        Err(error)
            if transport == Some("lan") && cloud_fallback && is_connection_failure(&error) =>
        {
            control(state, "prepare-outgoing-transfer", request(Some("cloud"))).await?
        }
        Err(error) => return Err(error),
    };
    Ok(PreflightResult {
        transfer_id: required_string(&response, "transferId")?,
        source_peer_id: required_string(&response, "sourcePeerId")?,
        target_has_repo: response
            .get("targetHasRepo")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                "transfer sidecar preflight response missing targetHasRepo".to_string()
            })?,
    })
}

pub async fn commit(
    state: &Arc<AppState>,
    transfer_id: &str,
    payload: &Value,
) -> Result<(), String> {
    control(
        state,
        "prepare-outgoing-transfer",
        json!({ "payload": { "phase": "commit", "transferId": transfer_id, "payload": payload } }),
    )
    .await
    .map(|_| ())
}

pub async fn abandon(state: &Arc<AppState>, transfer_id: &str) -> Result<(), String> {
    control(
        state,
        "abandon-outgoing-transfer",
        json!({ "transferId": transfer_id }),
    )
    .await
    .map(|_| ())
}

pub async fn stage_artifact(
    state: &Arc<AppState>,
    transfer_id: &str,
    artifact_id: &str,
    path: &std::path::Path,
    owned: bool,
) -> Result<(), String> {
    control(
        state,
        "stage-artifact",
        json!({
            "transferId": transfer_id,
            "artifactId": artifact_id,
            "path": path.to_string_lossy(),
            "owned": owned,
        }),
    )
    .await
    .map(|_| ())
}

pub async fn fetch_artifact(
    state: &Arc<AppState>,
    transfer_id: &str,
    artifact_id: &str,
) -> Result<std::path::PathBuf, String> {
    let response = control(
        state,
        "fetch-artifact",
        json!({ "transferId": transfer_id, "artifactId": artifact_id }),
    )
    .await?;
    Ok(std::path::PathBuf::from(required_string(
        &response, "path",
    )?))
}

pub struct FinalizedTransfer {
    pub payload: Value,
    pub finalized_cleanly: bool,
}

/// Asks the source to finalize. Called on the *destination*, which is why it
/// exists at all: the destination cannot import a payload until the source has
/// shut its agent down and staged what the payload promises.
pub async fn finalize_from_source(
    state: &Arc<AppState>,
    transfer_id: &str,
) -> Result<FinalizedTransfer, String> {
    let response = control(
        state,
        "finalize-outgoing-transfer",
        json!({ "transferId": transfer_id }),
    )
    .await?;
    if required_string(&response, "transferId")? != transfer_id {
        return Err(format!(
            "finalized incoming transfer id mismatch: {transfer_id}"
        ));
    }
    Ok(FinalizedTransfer {
        payload: response
            .get("payload")
            .cloned()
            .ok_or_else(|| "finalize response missing payload".to_string())?,
        finalized_cleanly: response
            .get("finalizedCleanly")
            .and_then(Value::as_bool)
            .ok_or_else(|| "finalize response missing finalizedCleanly".to_string())?,
    })
}

/// Answers a finalization request the *source* is serving, with either the
/// finalized payload or the reason it could not produce one.
pub async fn complete_finalization(
    state: &Arc<AppState>,
    transfer_id: &str,
    payload: Option<&Value>,
    finalized_cleanly: bool,
    error: Option<&str>,
) -> Result<(), String> {
    control(
        state,
        "complete-outgoing-transfer-finalization",
        json!({
            "transferId": transfer_id,
            "payload": payload.cloned().unwrap_or(Value::Null),
            "finalizedCleanly": finalized_cleanly,
            "error": error.map(Value::from).unwrap_or(Value::Null),
        }),
    )
    .await
    .map(|_| ())
}

pub async fn acknowledge_import_committed(
    state: &Arc<AppState>,
    transfer_id: &str,
    source_task_id: &str,
    destination_local_task_id: &str,
) -> Result<(), String> {
    control(
        state,
        "acknowledge-import-committed",
        json!({
            "transferId": transfer_id,
            "sourceTaskId": source_task_id,
            "destinationLocalTaskId": destination_local_task_id,
        }),
    )
    .await
    .map(|_| ())
}

pub async fn mark_incoming_event_recorded(
    state: &Arc<AppState>,
    transfer_id: &str,
) -> Result<(), String> {
    control(
        state,
        "mark-incoming-event-recorded",
        json!({ "transferId": transfer_id }),
    )
    .await
    .map(|_| ())
}

pub async fn mark_import_ack_completed(
    state: &Arc<AppState>,
    transfer_id: &str,
) -> Result<(), String> {
    control(
        state,
        "mark-import-ack-completed",
        json!({ "transferId": transfer_id }),
    )
    .await
    .map(|_| ())
}

pub async fn mark_import_commit_applied(
    state: &Arc<AppState>,
    transfer_id: &str,
) -> Result<(), String> {
    control(
        state,
        "mark-import-commit-applied",
        json!({ "transferId": transfer_id }),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cloud fallback is for a LAN route that could not be reached, never for a
    /// peer that answered. Retrying a real refusal on another transport would
    /// turn one rejection into two attempts at the same rejected work.
    #[test]
    fn only_transport_level_failures_are_eligible_for_cloud_fallback() {
        for transient in [
            "i/o error: connection refused",
            "peer not found: peer-x",
            "request timed out after 5s",
            "Broken pipe",
        ] {
            assert!(is_connection_failure(transient), "{transient}");
        }
        for answered in [
            "peer peer-x is not trusted",
            "too many active incoming transfer reservations (maximum 32)",
            "transfer artifact path does not match the provider session contract",
        ] {
            assert!(!is_connection_failure(answered), "{answered}");
        }
    }
}
