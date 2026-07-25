use super::state::AppState;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
pub(super) struct TransferUpdateResponse {
    updated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FailTransferRequest {
    reason: String,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteTransferRequest {
    local_task_id: String,
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

pub(super) async fn list_pending_incoming_transfers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PendingIncomingTransfersResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfers = db.list_pending_incoming_transfers().map_err(db_error)?;
    Ok(Json(PendingIncomingTransfersResponse { transfers }))
}

pub(super) async fn insert_task_transfer(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTransferRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    db.insert_task_transfer(&payload.transfer)
        .map_err(db_error)?;
    Ok(Json(serde_json::json!({ "id": payload.transfer.id })))
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
        .update_task_transfer_payload(&transfer_id, &payload.payload_json)
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
        .mark_task_transfer_completed(&transfer_id, &payload.local_task_id)
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
        .mark_incoming_transfer_importing(&transfer_id, &payload.local_task_id)
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
        .mark_incoming_transfer_awaiting_acknowledgment(&transfer_id, &payload.local_task_id)
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
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .claim_pending_incoming_transfer(&transfer_id)
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
        .fail_pending_incoming_transfer(&transfer_id, &payload.reason)
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
