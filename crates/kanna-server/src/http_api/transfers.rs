use super::state::AppState;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Discriminator clients match on to tell "this push is already in flight" from
/// any other write failure. Kept stable: `stores/transfer.ts` keys its
/// idempotent push path off this exact string.
pub(super) const ACTIVE_OUTGOING_TRANSFER_CONFLICT: &str = "active_outgoing_transfer_exists";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetCloudTaskIdentityRequest {
    cloud_task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingIncomingTransfersResponse {
    transfers: Vec<crate::db::PendingIncomingTransfer>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IncomingTransferCleanupCandidatesResponse {
    transfer_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferUpdateResponse {
    updated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FailTransferRequest {
    reason: String,
    claim_owner_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpsertTransferRequest {
    transfer: crate::db::NewTaskTransfer,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateTransferPayloadRequest {
    payload_json: String,
    claim_owner_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteTransferRequest {
    local_task_id: String,
    claim_owner_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaimIncomingTransferRequest {
    owner_token: String,
    #[serde(default)]
    recovery: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RejectTransferRequest {
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InsertTransferProvenanceRequest {
    provenance: crate::db::NewTaskTransferProvenance,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferResponse {
    transfer: Option<crate::db::TaskTransfer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PushTaskRequest {
    peer_id: String,
    /// Opt-in idempotency key, for a client that retries this request and does
    /// not want the retry to become a second push.
    ///
    /// Absent — which is every production caller — each request is its own
    /// intent. It has to be: `transfer_work.id` is a permanent primary key and
    /// no row is ever pruned, so keying on anything that repeats (the peer id,
    /// say) would make every push of a task to that peer after the first return
    /// `scheduled: false` and enqueue nothing, forever. Pushing the same task to
    /// the same machine again — after a failure the operator fixed, or simply
    /// later — is ordinary, and the engine's own eligibility read is what stops
    /// two live intents racing into one transfer.
    #[serde(default)]
    intent_key: Option<String>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    cloud_fallback: bool,
    #[serde(default)]
    target_desktop_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferIntentResponse {
    /// `false` when the same intent was already queued — a retried request,
    /// not a second transfer.
    scheduled: bool,
}

/// Push a task to a paired machine.
///
/// The push itself is server work: the renderer states the intent and the
/// engine performs the preflight, the git bundling, the artifact staging and
/// the commit. It cannot be undone by the window closing halfway through.
pub(super) async fn push_task_to_peer(
    State(state): State<Arc<AppState>>,
    Path(source_task_id): Path<String>,
    Json(payload): Json<PushTaskRequest>,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    if payload.peer_id.trim().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "peerId must not be empty".to_string(),
        ));
    }
    let intent_key = payload
        .intent_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .unwrap_or_else(crate::transfer_engine::queue::unique_work_nonce);
    let scheduled = state
        .transfer_work()
        .enqueue(
            &format!("push:{source_task_id}:{intent_key}"),
            crate::transfer_engine::queue::KIND_PUSH,
            None,
            &serde_json::json!({
                "sourceTaskId": source_task_id,
                "peerId": payload.peer_id,
                "transport": payload.transport,
                "cloudFallback": payload.cloud_fallback,
                "targetDesktopId": payload.target_desktop_id,
            }),
        )
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(Json(TransferIntentResponse { scheduled }))
}

/// Approve or reject an incoming transfer.
///
/// Both are intents rather than work the caller performs, so the desktop and
/// (in principle) mobile express them the same way and the engine executes.
/// Progress reaches the UI through the snapshot's `transfer_status`.
pub(super) async fn approve_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    schedule_incoming_intent(
        &state,
        &transfer_id,
        "import",
        crate::transfer_engine::queue::KIND_IMPORT,
    )
}

pub(super) async fn reject_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    schedule_incoming_intent(
        &state,
        &transfer_id,
        "reject",
        crate::transfer_engine::queue::KIND_REJECT,
    )
}

fn schedule_incoming_intent(
    state: &Arc<AppState>,
    transfer_id: &str,
    prefix: &str,
    kind: &str,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(state)?;
    let transfer = db
        .get_task_transfer(transfer_id)
        .map_err(db_error)?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("incoming transfer not found: {transfer_id}"),
            )
        })?;
    if transfer.direction != "incoming" {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("transfer is not incoming: {transfer_id}"),
        ));
    }
    let scheduled = state
        .transfer_work()
        .enqueue(
            &format!("{prefix}:{transfer_id}"),
            kind,
            Some(transfer_id),
            &serde_json::json!({ "transferId": transfer_id }),
        )
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(Json(TransferIntentResponse { scheduled }))
}

pub(super) async fn list_pending_incoming_transfers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PendingIncomingTransfersResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfers = db.list_pending_incoming_transfers().map_err(db_error)?;
    Ok(Json(PendingIncomingTransfersResponse { transfers }))
}

pub(super) async fn list_incoming_transfer_cleanup_candidates(
    State(state): State<Arc<AppState>>,
) -> Result<Json<IncomingTransferCleanupCandidatesResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfer_ids = db.list_terminal_incoming_transfer_ids().map_err(db_error)?;
    Ok(Json(IncomingTransferCleanupCandidatesResponse {
        transfer_ids,
    }))
}

pub(super) async fn mark_incoming_transfer_sidecar_cleanup_completed(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_incoming_transfer_sidecar_cleanup_completed(&transfer_id)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

/// A duplicate outgoing push is a race, not a server fault.
///
/// Two `task-pull-requested` deliveries for the same source task both passed a
/// stale renderer-snapshot eligibility check on 2026-08-06; the loser's insert
/// tripped `idx_task_transfer_active_outgoing_source` and surfaced as a raw
/// 500, leaving the caller no way to tell "already in flight" from "the write
/// broke". 409 with this body is that distinction, and it is what lets the
/// caller release the sidecar reservation its preflight had already made.
pub(super) async fn insert_task_transfer(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTransferRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {
    let db = open_db(&state).map_err(json_error)?;
    match db.insert_task_transfer(&payload.transfer) {
        Ok(()) => Ok(Json(serde_json::json!({ "id": payload.transfer.id }))),
        Err(error) if crate::db::is_active_outgoing_transfer_conflict(&error) => {
            let source_task_id = payload.transfer.source_task_id.clone();
            let existing = source_task_id
                .as_deref()
                .and_then(|task_id| db.active_outgoing_transfer_for_source(task_id).ok())
                .flatten();
            Err((
                axum::http::StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": ACTIVE_OUTGOING_TRANSFER_CONFLICT,
                    "sourceTaskId": source_task_id,
                    "transferId": existing.map(|transfer| transfer.id),
                })),
            ))
        }
        Err(error) => Err(json_error(db_error(error))),
    }
}

pub(super) async fn get_active_outgoing_transfer(
    State(state): State<Arc<AppState>>,
    Path(source_task_id): Path<String>,
) -> Result<Json<TransferResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfer = db
        .active_outgoing_transfer_for_source(&source_task_id)
        .map_err(db_error)?;
    Ok(Json(TransferResponse { transfer }))
}

pub(super) async fn get_task_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfer = db.get_task_transfer(&transfer_id).map_err(db_error)?;
    Ok(Json(TransferResponse { transfer }))
}

pub(super) async fn update_task_transfer_payload(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<UpdateTransferPayloadRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .update_task_transfer_payload(
            &transfer_id,
            &payload.payload_json,
            payload.claim_owner_token.as_deref(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn complete_task_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<CompleteTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_task_transfer_completed(
            &transfer_id,
            &payload.local_task_id,
            payload.claim_owner_token.as_deref(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn mark_incoming_transfer_importing(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<CompleteTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_incoming_transfer_importing(
            &transfer_id,
            &payload.local_task_id,
            payload.claim_owner_token.as_deref().unwrap_or_default(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn mark_incoming_transfer_awaiting_acknowledgment(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<CompleteTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_incoming_transfer_awaiting_acknowledgment(
            &transfer_id,
            &payload.local_task_id,
            payload.claim_owner_token.as_deref().unwrap_or_default(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn reject_task_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<RejectTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_task_transfer_rejected(&transfer_id, &payload.reason)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn insert_task_transfer_provenance(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InsertTransferProvenanceRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    db.insert_task_transfer_provenance(&payload.provenance)
        .map_err(db_error)?;
    Ok(Json(
        serde_json::json!({ "pipelineItemId": payload.provenance.pipeline_item_id }),
    ))
}

pub(super) async fn claim_pending_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<ClaimIncomingTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    if payload.owner_token.trim().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "ownerToken must not be empty".to_string(),
        ));
    }
    let db = open_db(&state)?;
    let updated = db
        .claim_pending_incoming_transfer(&transfer_id, &payload.owner_token, payload.recovery)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn renew_incoming_transfer_claim(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<ClaimIncomingTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .renew_incoming_transfer_claim(&transfer_id, &payload.owner_token)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn fail_pending_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<FailTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .fail_pending_incoming_transfer(
            &transfer_id,
            &payload.reason,
            payload.claim_owner_token.as_deref(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn fail_outgoing_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<FailTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .fail_outgoing_task_transfer(&transfer_id, &payload.reason)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn set_task_cloud_identity(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(payload): Json<SetCloudTaskIdentityRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    if payload.cloud_task_id.trim().is_empty()
        || payload.cloud_task_id.chars().any(char::is_control)
    {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "cloudTaskId must be non-blank and contain no control characters".to_string(),
        ));
    }

    let cloud_task_id = payload.cloud_task_id;
    let db_path = state.config.db_path.clone();
    let task_id_for_write = task_id.clone();
    let write = super::blocking::run_handler_blocking("cloud task identity write", move || {
        let db = Db::open(&db_path).map_err(db_error)?;
        db.set_cloud_task_identity(&task_id_for_write, &cloud_task_id)
            .map_err(db_error)
            .map(|write| (write, cloud_task_id))
    })
    .await?;
    match write {
        (crate::db::CloudTaskIdentityWrite::Updated, cloud_task_id)
        | (crate::db::CloudTaskIdentityWrite::Unchanged, cloud_task_id) => {
            Ok(Json(serde_json::json!({ "cloudTaskId": cloud_task_id })))
        }
        (crate::db::CloudTaskIdentityWrite::Conflict, _) => Err((
            axum::http::StatusCode::CONFLICT,
            "cloud task identity conflicts with existing ownership".to_string(),
        )),
        (crate::db::CloudTaskIdentityWrite::TaskNotFound, _) => Err((
            axum::http::StatusCode::NOT_FOUND,
            format!("task not found: {task_id}"),
        )),
    }
}

fn open_db(state: &AppState) -> Result<Db, (axum::http::StatusCode, String)> {
    Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })
}

fn db_error(error: rusqlite::Error) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        format!("db error: {error}"),
    )
}

fn json_error(
    (status, message): (axum::http::StatusCode, String),
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": message })))
}
