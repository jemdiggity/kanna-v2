//! Server routes for the transfer sidecar's control plane and event stream.
//!
//! Every route here requires `DesktopLocalAccess` — a direct loopback
//! connection from the desktop process, not a paired LAN device and not an
//! authenticated relay tunnel. That is deliberately narrower than the rest of
//! `/v1/transfers/*`: these operations initiate pairing and move tasks between
//! machines, and before the move they were reachable only by whoever held the
//! sidecar's private stdio pipe.

use super::lan_trust::DesktopLocalAccess;
use super::state::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// One response's worth of events. The desktop loops on `hasMore`.
const DEFAULT_EVENT_LIMIT: usize = 100;
const MAX_EVENT_LIMIT: usize = 500;
const DEFAULT_WAIT_TIMEOUT_SECS: u64 = 25;
const MAX_WAIT_TIMEOUT_SECS: u64 = 120;

fn bad_request(message: String) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::BAD_REQUEST, message)
}

fn sidecar_error(message: String) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message)
}

pub(super) async fn run_transfer_control(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Path(operation): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    if !crate::transfer_control::is_transfer_control_operation(&operation) {
        return Err(bad_request(format!(
            "unsupported transfer control operation {operation}"
        )));
    }
    let params = body.map(|Json(value)| value).unwrap_or(Value::Null);
    let params = if params.is_null() { json!({}) } else { params };
    state
        .transfer_sidecar()
        .control(&operation, params)
        .await
        .map(Json)
        .map_err(sidecar_error)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferEventsQuery {
    cursor: Option<u64>,
    stream_id: Option<String>,
    limit: Option<usize>,
    timeout_secs: Option<u64>,
}

/// Long-poll the sidecar event stream, following `/v1/task-events`: pass the
/// returned cursor back and nothing fired between two calls is missed.
///
/// Unlike `/v1/task-events`, the cursor is not durable — the log is in memory
/// and dies with this process — so a cursor must be paired with the
/// `streamId` it came from. A cursor from an earlier server process is
/// discarded and answered with `missedEvents`, rather than being applied to
/// sequence numbers it never referred to.
///
/// Reading through a cursor also prunes it, so this is a single-consumer feed
/// — the desktop process. A caller that omits the cursor gets whatever is
/// still retained.
pub(super) async fn wait_transfer_events(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Query(query): Query<TransferEventsQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT);
    let timeout_secs = query
        .timeout_secs
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_SECS)
        .clamp(1, MAX_WAIT_TIMEOUT_SECS);
    let batch = state
        .transfer_sidecar()
        .events()
        .wait_for_events(
            query.cursor,
            query.stream_id.as_deref(),
            limit,
            Duration::from_secs(timeout_secs),
        )
        .await;
    Ok(Json(json!({
        "waitOutcome": if batch.events.is_empty() { "timeout" } else { "events" },
        "cursor": batch.cursor,
        "streamId": batch.stream_id,
        "events": batch.events,
        "hasMore": batch.has_more,
        "missedEvents": batch.missed_events,
    })))
}

/// Long-poll the companion frame lane. Same cursor/streamId contract as
/// `wait_transfer_events`, on a log of its own so a 40 MiB snapshot can never
/// evict a pairing prompt.
pub(super) async fn wait_transfer_companion_events(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Query(query): Query<TransferEventsQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT);
    let timeout_secs = query
        .timeout_secs
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_SECS)
        .clamp(1, MAX_WAIT_TIMEOUT_SECS);
    let batch = state
        .transfer_sidecar()
        .companion_events()
        .wait_for_events(
            query.cursor,
            query.stream_id.as_deref(),
            limit,
            Duration::from_secs(timeout_secs),
        )
        .await;
    Ok(Json(json!({
        "waitOutcome": if batch.events.is_empty() { "timeout" } else { "events" },
        "cursor": batch.cursor,
        "streamId": batch.stream_id,
        "events": batch.events,
        "hasMore": batch.has_more,
        "missedEvents": batch.missed_events,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudTransferProxyRequest {
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: String,
}

/// Bind (or rotate the credential of) an outbound cloud transfer proxy. The
/// renderer holds the Firebase session, so it pushes a fresh ID token here
/// whenever the session refreshes.
pub(super) async fn ensure_cloud_transfer_proxy(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Json(request): Json<CloudTransferProxyRequest>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let endpoint = crate::cloud_transfer_proxy::ensure_cloud_transfer_proxy_in_state(
        state.cloud_transfer_proxies(),
        request.peer_id,
        request.desktop_id,
        request.relay_url,
        request.id_token,
    )
    .await
    .map_err(bad_request)?;
    serde_json::to_value(endpoint)
        .map(Json)
        .map_err(|error| sidecar_error(format!("failed to encode cloud transfer proxy: {error}")))
}

pub(super) async fn remove_cloud_transfer_proxy(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Path(peer_id): Path<String>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    crate::cloud_transfer_proxy::remove_cloud_transfer_proxy_in_state(
        state.cloud_transfer_proxies(),
        &peer_id,
    )
    .await
    .map_err(bad_request)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(super) async fn clear_cloud_transfer_proxies(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    crate::cloud_transfer_proxy::clear_cloud_transfer_proxies_in_state(
        state.cloud_transfer_proxies(),
    )
    .await
    .map_err(sidecar_error)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
