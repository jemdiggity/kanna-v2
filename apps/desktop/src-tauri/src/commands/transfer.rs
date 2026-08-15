//! Transfer commands, now thin proxies onto `kanna-server`.
//!
//! The server owns the sidecar process and its stdio control plane; these
//! commands only translate a renderer `invoke` into one call on the server's
//! loopback control route. Nothing here knows the sidecar's wire protocol.
//!
//! The lifecycle-queue commands below are the exception: they act on the
//! in-process consumer queue in [`crate::transfer_sidecar`], which still lives
//! desktop-side because it elects an authoritative *window*.

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

/// Some control operations wait on a remote peer (pairing handshakes, repo
/// bundling on the far side), so this is generous compared to an ordinary
/// local request.
const TRANSFER_CONTROL_TIMEOUT: Duration = Duration::from_secs(120);

/// Transfers now require `kanna-server`, because it owns the sidecar. When the
/// server is not up, starting it is bounded rather than open-ended: a caller
/// that waits forever leaves the peer picker spinning with nothing to show and
/// no error to report, which is worse than saying the server is unavailable.
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(30);

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

async fn transfer_server_base_url(app: &tauri::AppHandle) -> Result<String, String> {
    tokio::time::timeout(
        SERVER_READY_TIMEOUT,
        crate::commands::mobile::ensure_server_base_url(app),
    )
    .await
    .map_err(|_| {
        "kanna-server did not become available; it owns the transfer sidecar, so transfers \
         cannot run without it"
            .to_string()
    })?
}

async fn transfer_control(
    app: &tauri::AppHandle,
    operation: &str,
    params: Value,
) -> Result<Value, String> {
    let base_url = transfer_server_base_url(app).await?;
    let response = http_client()
        .post(format!(
            "{base_url}/v1/transfers/sidecar/control/{operation}"
        ))
        .json(&params)
        .timeout(TRANSFER_CONTROL_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("transfer control {operation} failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(if body.is_empty() {
            format!("transfer control {operation} failed: {status}")
        } else {
            body
        });
    }
    serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("invalid transfer control {operation} response: {error}"))
}

async fn transfer_control_list(
    app: &tauri::AppHandle,
    operation: &str,
    params: Value,
) -> Result<Vec<Value>, String> {
    let value = transfer_control(app, operation, params).await?;
    value
        .as_array()
        .cloned()
        .ok_or_else(|| format!("transfer control {operation} did not return a list"))
}

#[tauri::command]
pub async fn ensure_cloud_transfer_proxy(
    app: tauri::AppHandle,
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: String,
) -> Result<Value, String> {
    let base_url = transfer_server_base_url(&app).await?;
    let response = http_client()
        .post(format!("{base_url}/v1/transfers/cloud-proxies"))
        .json(&json!({
            "peerId": peer_id,
            "desktopId": desktop_id,
            "relayUrl": relay_url,
            "idToken": id_token,
        }))
        .send()
        .await
        .map_err(|error| format!("cloud transfer proxy request failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(if body.is_empty() {
            format!("cloud transfer proxy request failed: {status}")
        } else {
            body
        });
    }
    serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("invalid cloud transfer proxy response: {error}"))
}

async fn delete_cloud_proxy_path(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let base_url = transfer_server_base_url(app).await?;
    let response = http_client()
        .delete(format!("{base_url}{path}"))
        .send()
        .await
        .map_err(|error| format!("cloud transfer proxy removal failed: {error}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(if body.is_empty() {
        format!("cloud transfer proxy removal failed: {status}")
    } else {
        body
    })
}

#[tauri::command]
pub async fn remove_cloud_transfer_proxy(
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<(), String> {
    let encoded = percent_encode_component(&peer_id);
    delete_cloud_proxy_path(&app, &format!("/v1/transfers/cloud-proxies/{encoded}")).await
}

#[tauri::command]
pub async fn clear_cloud_transfer_proxies(app: tauri::AppHandle) -> Result<(), String> {
    delete_cloud_proxy_path(&app, "/v1/transfers/cloud-proxies").await
}

/// Percent-encode a path segment or query value. Peer ids are opaque strings
/// from a remote machine and the event stream id is opaque server output, so
/// neither can be pasted into a URL unescaped.
pub(crate) fn percent_encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[tauri::command]
pub async fn get_transfer_identity(app: tauri::AppHandle) -> Result<Value, String> {
    transfer_control(&app, "identity", json!({})).await
}

#[tauri::command]
pub async fn list_transfer_peers(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    transfer_control_list(&app, "list-peers", json!({})).await
}

#[tauri::command]
pub async fn upsert_external_transfer_peer(
    app: tauri::AppHandle,
    peer: Value,
) -> Result<Value, String> {
    transfer_control(&app, "upsert-external-peer", json!({ "peer": peer })).await
}

#[tauri::command]
pub async fn remove_external_transfer_peer(
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<Value, String> {
    transfer_control(&app, "remove-external-peer", json!({ "peerId": peer_id })).await
}

#[tauri::command]
pub async fn clear_external_transfer_peers(app: tauri::AppHandle) -> Result<Value, String> {
    transfer_control(&app, "clear-external-peers", json!({})).await
}

#[tauri::command]
pub async fn set_transfer_task_snapshot(
    app: tauri::AppHandle,
    snapshot: Value,
) -> Result<Value, String> {
    transfer_control(&app, "set-task-snapshot", json!({ "snapshot": snapshot })).await
}

#[tauri::command]
pub async fn list_transfer_task_snapshots(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    transfer_control_list(&app, "list-task-snapshots", json!({})).await
}

#[tauri::command]
pub async fn observe_transfer_peer_session(
    app: tauri::AppHandle,
    peer_id: String,
    session_id: String,
    observer_lease_id: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "observe-peer-session",
        json!({
            "peerId": peer_id,
            "sessionId": session_id,
            "observerLeaseId": observer_lease_id,
        }),
    )
    .await
}

#[tauri::command]
pub async fn unobserve_transfer_peer_session(
    app: tauri::AppHandle,
    peer_id: String,
    session_id: String,
    observer_lease_id: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "unobserve-peer-session",
        json!({
            "peerId": peer_id,
            "sessionId": session_id,
            "observerLeaseId": observer_lease_id,
        }),
    )
    .await
}

#[tauri::command]
pub async fn observe_transfer_peer_companion(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
    generation: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "observe-peer-companion",
        json!({
            "peerId": peer_id,
            "taskId": task_id,
            "generation": generation,
        }),
    )
    .await
}

#[tauri::command]
pub async fn unobserve_transfer_peer_companion(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
    generation: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "unobserve-peer-companion",
        json!({
            "peerId": peer_id,
            "taskId": task_id,
            "generation": generation,
        }),
    )
    .await
}

#[tauri::command]
pub async fn send_transfer_peer_companion_event(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
    session_id: String,
    revision: String,
    generation: String,
    event: Value,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "send-peer-companion-event",
        json!({
            "peerId": peer_id,
            "taskId": task_id,
            "sessionId": session_id,
            "revision": revision,
            "generation": generation,
            "event": event,
        }),
    )
    .await
}

#[tauri::command]
pub async fn send_transfer_peer_session_input(
    app: tauri::AppHandle,
    peer_id: String,
    session_id: String,
    data: String,
    submission_boundary: Option<bool>,
    control_input: Option<bool>,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "send-peer-session-input",
        json!({
            "peerId": peer_id,
            "sessionId": session_id,
            "data": data,
            "submissionBoundary": submission_boundary.unwrap_or(false),
            "controlInput": control_input.unwrap_or(false),
        }),
    )
    .await
}

#[tauri::command]
pub async fn resize_transfer_peer_session(
    app: tauri::AppHandle,
    peer_id: String,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "resize-peer-session",
        json!({
            "peerId": peer_id,
            "sessionId": session_id,
            "cols": cols,
            "rows": rows,
        }),
    )
    .await
}

#[tauri::command]
pub async fn close_transfer_peer_task(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "close-peer-task",
        json!({ "peerId": peer_id, "taskId": task_id }),
    )
    .await
}

#[tauri::command]
pub async fn advance_transfer_peer_task_stage(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
    expected_transition_revision: Option<String>,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "advance-peer-task-stage",
        json!({
            "peerId": peer_id,
            "taskId": task_id,
            "expectedTransitionRevision": expected_transition_revision,
        }),
    )
    .await
}

#[tauri::command]
pub async fn read_transfer_peer_task_file(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
    path: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "read-peer-task-file",
        json!({ "peerId": peer_id, "taskId": task_id, "path": path }),
    )
    .await
}

#[tauri::command]
pub async fn mark_transfer_peer_task_read(
    app: tauri::AppHandle,
    peer_id: String,
    task_id: String,
    expected_activity_revision: i64,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "mark-peer-task-read",
        json!({
            "peerId": peer_id,
            "taskId": task_id,
            "expectedActivityRevision": expected_activity_revision,
        }),
    )
    .await
}

#[tauri::command]
pub async fn start_peer_pairing(app: tauri::AppHandle, peer_id: String) -> Result<Value, String> {
    transfer_control(&app, "start-pairing", json!({ "peerId": peer_id })).await
}

#[tauri::command]
pub async fn accept_peer_pairing(
    app: tauri::AppHandle,
    pairing_request_id: String,
    verification_code: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "accept-pairing",
        json!({
            "pairingRequestId": pairing_request_id,
            "verificationCode": verification_code,
        }),
    )
    .await
}

#[tauri::command]
pub async fn reject_peer_pairing(
    app: tauri::AppHandle,
    pairing_request_id: String,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "reject-pairing",
        json!({ "pairingRequestId": pairing_request_id }),
    )
    .await
}

#[tauri::command]
pub async fn request_task_pull(
    app: tauri::AppHandle,
    target_peer_id: String,
    source_task_id: String,
    transport: Option<String>,
) -> Result<Value, String> {
    transfer_control(
        &app,
        "request-task-pull",
        json!({
            "targetPeerId": target_peer_id,
            "sourceTaskId": source_task_id,
            "transport": transport.unwrap_or_else(|| "auto".into()),
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::percent_encode_component;

    #[test]
    fn peer_ids_are_percent_encoded_into_the_proxy_path() {
        assert_eq!(percent_encode_component("peer-secondary"), "peer-secondary");
        assert_eq!(
            percent_encode_component("peer/../secret?x"),
            "peer%2F..%2Fsecret%3Fx"
        );
    }
}
