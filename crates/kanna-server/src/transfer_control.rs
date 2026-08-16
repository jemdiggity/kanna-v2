//! The sidecar control-plane vocabulary, moved here with the pipe.
//!
//! Every operation the desktop used to issue over stdio is named here exactly
//! once: it translates the caller's camelCase parameters into the sidecar's
//! snake_case request and shapes the reply back. The allowlist is the point —
//! the route cannot be used to hand the sidecar an arbitrary message.

use crate::transfer_sidecar::TransferSidecarClient;
use serde_json::{json, Value};

pub fn is_transfer_control_operation(operation: &str) -> bool {
    OPERATIONS.contains(&operation)
}

const OPERATIONS: &[&str] = &[
    "identity",
    "list-peers",
    "upsert-external-peer",
    "remove-external-peer",
    "clear-external-peers",
    "set-task-snapshot",
    "list-task-snapshots",
    "observe-peer-session",
    "unobserve-peer-session",
    "observe-peer-companion",
    "unobserve-peer-companion",
    "send-peer-companion-event",
    "send-peer-session-input",
    "resize-peer-session",
    "close-peer-task",
    "advance-peer-task-stage",
    "read-peer-task-file",
    "mark-peer-task-read",
    "start-pairing",
    "accept-pairing",
    "reject-pairing",
    "prepare-outgoing-transfer",
    "abandon-outgoing-transfer",
    "request-task-pull",
    "stage-artifact",
    "fetch-artifact",
    "acknowledge-import-committed",
    "mark-import-commit-applied",
    "nack-import-commit",
    "mark-incoming-event-recorded",
    "mark-import-ack-completed",
    "finalize-outgoing-transfer",
    "complete-outgoing-transfer-finalization",
];

pub async fn dispatch(
    client: &TransferSidecarClient,
    operation: &str,
    params: Value,
) -> Result<Value, String> {
    match operation {
        "identity" => {
            let response = client.request("get_local_identity", json!({})).await?;
            Ok(json!({
                "peerId": required_string(&response, &["peer_id", "peerId"])?,
                "displayName": required_string(&response, &["display_name", "displayName"])?,
                "publicKey": required_string(&response, &["public_key", "publicKey"])?,
                "protocolVersion": number(&response, &["protocol_version", "protocolVersion"])
                    .ok_or("transfer sidecar identity response missing protocol version")?,
                "acceptingTransfers": required_bool(
                    &response,
                    &["accepting_transfers", "acceptingTransfers"],
                )?,
            }))
        }
        "list-peers" => {
            let response = client.request("list_peers", json!({})).await?;
            let peers = response
                .get("peers")
                .and_then(Value::as_array)
                .cloned()
                .ok_or("transfer sidecar list_peers response missing peers")?;
            Ok(Value::Array(peers))
        }
        "upsert-external-peer" => {
            let peer = params
                .get("peer")
                .ok_or("upsert-external-peer requires a peer")?;
            client
                .request("upsert_external_peer", build_external_peer(peer)?)
                .await
        }
        "remove-external-peer" => {
            let peer_id = required_string(&params, &["peerId", "peer_id"])
                .map_err(|_| "external peer id must not be blank".to_string())?;
            client
                .request("remove_external_peer", json!({ "peer_id": peer_id }))
                .await
        }
        "clear-external-peers" => client.request("clear_external_peers", json!({})).await,
        "set-task-snapshot" => {
            let snapshot = params
                .get("snapshot")
                .cloned()
                .ok_or("set-task-snapshot requires a snapshot")?;
            client
                .request("set_task_snapshot", json!({ "snapshot": snapshot }))
                .await
        }
        "list-task-snapshots" => {
            let response = client
                .request("list_peer_task_snapshots", json!({}))
                .await?;
            let mut snapshots = response
                .get("snapshots")
                .and_then(Value::as_array)
                .cloned()
                .ok_or("transfer sidecar list_peer_task_snapshots response missing snapshots")?;
            // Unreachable peers come back as issues; the frontend renders them
            // in the same list keyed on `error`.
            if let Some(issues) = response.get("issues").and_then(Value::as_array) {
                snapshots.extend(issues.iter().cloned().map(|mut issue| {
                    if let Some(object) = issue.as_object_mut() {
                        if let Some(message) = object.remove("message") {
                            object.insert("error".to_string(), message);
                        }
                    }
                    issue
                }));
            }
            Ok(Value::Array(snapshots))
        }
        "observe-peer-session" | "unobserve-peer-session" => {
            let kind = if operation == "observe-peer-session" {
                "observe_peer_session"
            } else {
                "unobserve_peer_session"
            };
            client
                .request(
                    kind,
                    json!({
                        "target_peer_id": required_string(&params, &["peerId"])?,
                        "session_id": required_string(&params, &["sessionId"])?,
                        "observer_lease_id": required_string(&params, &["observerLeaseId"])?,
                    }),
                )
                .await
        }
        "observe-peer-companion" | "unobserve-peer-companion" => {
            let kind = if operation == "observe-peer-companion" {
                "observe_peer_companion"
            } else {
                "unobserve_peer_companion"
            };
            let response = client
                .request(
                    kind,
                    json!({
                        "target_peer_id": required_string(&params, &["peerId"])?,
                        "task_id": required_string(&params, &["taskId"])?,
                        "generation": required_string(&params, &["generation"])?,
                    }),
                )
                .await?;
            Ok(with_incarnation(response, client))
        }
        "send-peer-companion-event" => {
            let event = params
                .get("event")
                .cloned()
                .ok_or("send-peer-companion-event requires an event")?;
            let response = client
                .request(
                    "send_peer_companion_event",
                    json!({
                        "target_peer_id": required_string(&params, &["peerId"])?,
                        "task_id": required_string(&params, &["taskId"])?,
                        "session_id": required_string(&params, &["sessionId"])?,
                        "revision": required_string(&params, &["revision"])?,
                        "generation": required_string(&params, &["generation"])?,
                        "event": event,
                    }),
                )
                .await?;
            Ok(with_incarnation(response, client))
        }
        "send-peer-session-input" => {
            client
                .request(
                    "send_peer_session_input",
                    build_peer_session_input_request(&params)?,
                )
                .await
        }
        "resize-peer-session" => client
            .request(
                "resize_peer_session",
                json!({
                    "target_peer_id": required_string(&params, &["peerId"])?,
                    "session_id": required_string(&params, &["sessionId"])?,
                    "cols": number(&params, &["cols"]).ok_or("resize-peer-session requires cols")?,
                    "rows": number(&params, &["rows"]).ok_or("resize-peer-session requires rows")?,
                }),
            )
            .await,
        "close-peer-task" => {
            client
                .request(
                    "close_peer_task",
                    json!({
                        "target_peer_id": required_string(&params, &["peerId"])?,
                        "task_id": required_string(&params, &["taskId"])?,
                    }),
                )
                .await
        }
        "advance-peer-task-stage" => {
            let mut request = json!({
                "target_peer_id": required_string(&params, &["peerId"])?,
                "task_id": required_string(&params, &["taskId"])?,
            });
            if let Some(revision) = params
                .get("expectedTransitionRevision")
                .and_then(Value::as_str)
            {
                request["expected_transition_revision"] = Value::String(revision.to_string());
            }
            client.request("advance_peer_task_stage", request).await
        }
        "read-peer-task-file" => {
            client
                .request(
                    "read_peer_task_file",
                    json!({
                        "target_peer_id": required_string(&params, &["peerId"])?,
                        "task_id": required_string(&params, &["taskId"])?,
                        "path": required_string(&params, &["path"])?,
                    }),
                )
                .await
        }
        "mark-peer-task-read" => {
            client
                .request(
                    "mark_peer_task_read",
                    json!({
                        "target_peer_id": required_string(&params, &["peerId"])?,
                        "task_id": required_string(&params, &["taskId"])?,
                        "expected_activity_revision": number(&params, &["expectedActivityRevision"])
                            .ok_or("mark-peer-task-read requires expectedActivityRevision")?,
                    }),
                )
                .await
        }
        "start-pairing" => {
            let response = client
                .request(
                    "start_pairing",
                    json!({ "target_peer_id": required_string(&params, &["peerId"])? }),
                )
                .await?;
            Ok(json!({
                "peer": response
                    .get("peer")
                    .cloned()
                    .ok_or("transfer sidecar start_pairing response missing peer")?,
                "verificationCode": required_string(
                    &response,
                    &["verification_code", "verificationCode"],
                )?,
            }))
        }
        "accept-pairing" => {
            let response = client
                .request(
                    "accept_pairing",
                    json!({
                        "pairing_request_id": required_string(&params, &["pairingRequestId"])?,
                        "verification_code": required_string(&params, &["verificationCode"])?,
                    }),
                )
                .await?;
            Ok(json!({
                "pairingRequestId": required_string(
                    &response,
                    &["pairing_request_id", "pairingRequestId"],
                )?,
            }))
        }
        "reject-pairing" => {
            let response = client
                .request(
                    "reject_pairing",
                    json!({
                        "pairing_request_id": required_string(&params, &["pairingRequestId"])?,
                    }),
                )
                .await?;
            Ok(json!({
                "pairingRequestId": required_string(
                    &response,
                    &["pairing_request_id", "pairingRequestId"],
                )?,
            }))
        }
        "prepare-outgoing-transfer" => {
            let payload = params
                .get("payload")
                .ok_or("prepare-outgoing-transfer requires a payload")?;
            prepare_outgoing_transfer(client, payload).await
        }
        "abandon-outgoing-transfer" => {
            transfer_id_reply(
                client,
                "abandon_outgoing_transfer",
                json!({ "transfer_id": required_string(&params, &["transferId"])? }),
            )
            .await
        }
        "request-task-pull" => {
            let transport = transfer_transport(&params)?;
            let response = client
                .request(
                    "request_task_pull",
                    json!({
                        "target_peer_id": required_string(&params, &["targetPeerId"])?,
                        "source_task_id": required_string(&params, &["sourceTaskId"])?,
                        "transport": transport,
                    }),
                )
                .await?;
            Ok(json!({
                "requestId": required_string(&response, &["pull_request_id", "pullRequestId"])?,
            }))
        }
        "stage-artifact" => {
            let response = client
                .request(
                    "stage_transfer_artifact",
                    json!({
                        "transfer_id": required_string(&params, &["transferId"])?,
                        "artifact_id": required_string(&params, &["artifactId"])?,
                        "path": required_string(&params, &["path"])?,
                        "owned": params
                            .get("owned")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }),
                )
                .await?;
            Ok(json!({
                "transferId": required_string(&response, &["transfer_id", "transferId"])?,
                "artifactId": required_string(&response, &["artifact_id", "artifactId"])?,
            }))
        }
        "fetch-artifact" => {
            let response = client
                .request(
                    "fetch_transfer_artifact",
                    json!({
                        "transfer_id": required_string(&params, &["transferId"])?,
                        "artifact_id": required_string(&params, &["artifactId"])?,
                    }),
                )
                .await?;
            Ok(json!({
                "transferId": required_string(&response, &["transfer_id", "transferId"])?,
                "artifactId": required_string(&response, &["artifact_id", "artifactId"])?,
                "path": required_string(&response, &["path"])?,
            }))
        }
        "acknowledge-import-committed" => {
            transfer_id_reply(
                client,
                "acknowledge_import_committed",
                json!({
                    "transfer_id": required_string(&params, &["transferId"])?,
                    "source_task_id": required_string(&params, &["sourceTaskId"])?,
                    "destination_local_task_id": required_string(
                        &params,
                        &["destinationLocalTaskId"],
                    )?,
                }),
            )
            .await
        }
        "mark-import-commit-applied" => {
            transfer_id_reply(
                client,
                "mark_import_commit_applied",
                json!({ "transfer_id": required_string(&params, &["transferId"])? }),
            )
            .await
        }
        "nack-import-commit" => {
            transfer_id_reply(
                client,
                "nack_import_commit",
                json!({ "transfer_id": required_string(&params, &["transferId"])? }),
            )
            .await
        }
        "mark-incoming-event-recorded" => {
            transfer_id_reply(
                client,
                "mark_incoming_event_recorded",
                json!({ "transfer_id": required_string(&params, &["transferId"])? }),
            )
            .await
        }
        "mark-import-ack-completed" => {
            transfer_id_reply(
                client,
                "mark_import_ack_completed",
                json!({ "transfer_id": required_string(&params, &["transferId"])? }),
            )
            .await
        }
        "finalize-outgoing-transfer" => {
            let response = client
                .request(
                    "finalize_outgoing_transfer",
                    json!({ "transfer_id": required_string(&params, &["transferId"])? }),
                )
                .await?;
            Ok(json!({
                "transferId": required_string(&response, &["transfer_id", "transferId"])?,
                "payload": response
                    .get("payload")
                    .cloned()
                    .ok_or("finalize_outgoing_transfer response missing payload")?,
                "finalizedCleanly": required_bool(
                    &response,
                    &["finalized_cleanly", "finalizedCleanly"],
                )?,
            }))
        }
        "complete-outgoing-transfer-finalization" => transfer_id_reply(
            client,
            "complete_outgoing_transfer_finalization",
            json!({
                "transfer_id": required_string(&params, &["transferId"])?,
                "payload": params.get("payload").cloned().unwrap_or(Value::Null),
                "finalized_cleanly": params
                    .get("finalizedCleanly")
                    .and_then(Value::as_bool)
                    .ok_or("complete-outgoing-transfer-finalization requires finalizedCleanly")?,
                "error": params.get("error").cloned().unwrap_or(Value::Null),
            }),
        )
        .await,
        other => Err(format!("unsupported transfer control operation {other}")),
    }
}

async fn transfer_id_reply(
    client: &TransferSidecarClient,
    kind: &str,
    request: Value,
) -> Result<Value, String> {
    let response = client.request(kind, request).await?;
    Ok(json!({
        "transferId": required_string(&response, &["transfer_id", "transferId"])?,
    }))
}

async fn prepare_outgoing_transfer(
    client: &TransferSidecarClient,
    payload: &Value,
) -> Result<Value, String> {
    let phase = payload
        .get("phase")
        .and_then(Value::as_str)
        .ok_or("prepare_outgoing_transfer payload missing phase")?;
    match phase {
        "preflight" => {
            let response = client
                .request(
                    "prepare_transfer_preflight",
                    json!({
                        "source_task_id": required_string(
                            payload,
                            &["sourceTaskId", "source_task_id"],
                        )?,
                        "target_peer_id": required_string(
                            payload,
                            &["targetPeerId", "target_peer_id"],
                        )?,
                        "transport": transfer_transport(payload)?,
                    }),
                )
                .await?;
            Ok(json!({
                "transferId": required_string(&response, &["transfer_id", "transferId"])?,
                "sourcePeerId": required_string(&response, &["source_peer_id", "sourcePeerId"])?,
                "targetHasRepo": required_bool(&response, &["target_has_repo", "targetHasRepo"])?,
            }))
        }
        "commit" => {
            transfer_id_reply(
                client,
                "prepare_transfer_commit",
                json!({
                    "transfer_id": required_string(payload, &["transferId", "transfer_id"])?,
                    "payload": payload
                        .get("payload")
                        .cloned()
                        .ok_or("prepare_outgoing_transfer commit payload missing payload")?,
                }),
            )
            .await
        }
        other => Err(format!(
            "prepare_outgoing_transfer payload has unsupported phase {other}"
        )),
    }
}

fn build_external_peer(peer: &Value) -> Result<Value, String> {
    Ok(json!({
        "peer": {
            "peer_id": required_string(peer, &["peerId", "peer_id"])?,
            "display_name": required_string(peer, &["displayName", "display_name"])?,
            "endpoint": required_string(peer, &["endpoint"])?,
            "public_key": required_string(peer, &["publicKey", "public_key"])?,
            "protocol_version": number(peer, &["protocolVersion", "protocol_version"])
                .ok_or("external peer missing protocol version")?,
            "accepting_transfers": required_bool(
                peer,
                &["acceptingTransfers", "accepting_transfers"],
            )
            .map_err(|_| "external peer missing accepting transfers state".to_string())?,
        },
    }))
}

fn transfer_transport(value: &Value) -> Result<String, String> {
    let transport = value
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    match transport {
        "auto" | "lan" | "cloud" => Ok(transport.to_string()),
        other => Err(format!("unsupported transfer transport {other}")),
    }
}

fn build_peer_session_input_request(params: &Value) -> Result<Value, String> {
    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or("send-peer-session-input requires data")?;
    Ok(json!({
        "target_peer_id": required_string(params, &["peerId"])?,
        "session_id": required_string(params, &["sessionId"])?,
        "data": data.as_bytes().to_vec(),
        "submission_boundary": required_bool(params, &["submissionBoundary"])?,
        "control_input": required_bool(params, &["controlInput"])?,
    }))
}

fn required_string(value: &Value, keys: &[&str]) -> Result<String, String> {
    for key in keys {
        if let Some(result) = value.get(key).and_then(Value::as_str) {
            if !result.is_empty() {
                return Ok(result.to_string());
            }
        }
    }
    Err(format!(
        "missing required string field {}",
        keys.join(" or ")
    ))
}

fn required_bool(value: &Value, keys: &[&str]) -> Result<bool, String> {
    for key in keys {
        if let Some(result) = value.get(key).and_then(Value::as_bool) {
            return Ok(result);
        }
    }
    Err(format!(
        "missing required boolean field {}",
        keys.join(" or ")
    ))
}

fn number(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_operation_is_accepted_and_unknown_ones_are_not() {
        assert!(is_transfer_control_operation("start-pairing"));
        assert!(is_transfer_control_operation(
            "complete-outgoing-transfer-finalization"
        ));
        assert!(is_transfer_control_operation("abandon-outgoing-transfer"));
        assert!(!is_transfer_control_operation("shutdown"));
        assert!(!is_transfer_control_operation(""));
    }

    #[test]
    fn external_peer_requests_normalize_frontend_fields() {
        let request = build_external_peer(&json!({
            "peerId": "peer-cloud",
            "displayName": "Cloud",
            "endpoint": "127.0.0.1:1234",
            "publicKey": "key",
            "protocolVersion": 1,
            "acceptingTransfers": true,
        }))
        .expect("normalized peer");
        assert_eq!(request["peer"]["peer_id"], "peer-cloud");
        assert_eq!(request["peer"]["display_name"], "Cloud");
        assert_eq!(request["peer"]["protocol_version"], 1);
        assert_eq!(request["peer"]["accepting_transfers"], true);
    }

    #[test]
    fn external_peer_requests_reject_missing_protocol_metadata() {
        let error = build_external_peer(&json!({
            "peerId": "peer-cloud",
            "displayName": "Cloud",
            "endpoint": "127.0.0.1:1234",
            "publicKey": "key",
            "acceptingTransfers": true,
        }))
        .expect_err("protocol version is required");
        assert!(error.contains("protocol version"), "{error}");
    }

    #[test]
    fn transport_defaults_to_auto_and_rejects_unknown_values() {
        assert_eq!(transfer_transport(&json!({})).unwrap(), "auto");
        assert_eq!(
            transfer_transport(&json!({ "transport": "cloud" })).unwrap(),
            "cloud"
        );
        assert!(transfer_transport(&json!({ "transport": "carrier-pigeon" })).is_err());
    }

    #[test]
    fn send_peer_session_input_dispatch_preserves_declared_terminal_semantics() {
        for (submission_boundary, control_input) in [(true, false), (false, true)] {
            let request = build_peer_session_input_request(&json!({
                "peerId": "peer-secondary",
                "sessionId": "task-1",
                "data": "input",
                "submissionBoundary": submission_boundary,
                "controlInput": control_input,
            }))
            .expect("dispatch request");

            assert_eq!(request["submission_boundary"], submission_boundary);
            assert_eq!(request["control_input"], control_input);
        }
    }
}

/// Companion callers fence frames by sidecar incarnation, so companion verbs
/// answer with the incarnation that served them.
fn with_incarnation(mut response: Value, client: &TransferSidecarClient) -> Value {
    if let Some(object) = response.as_object_mut() {
        object.insert("incarnation".into(), Value::from(client.incarnation()));
    }
    response
}
