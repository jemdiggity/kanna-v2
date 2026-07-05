use super::state::AppState;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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

pub(super) async fn list_pending_incoming_transfers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PendingIncomingTransfersResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfers = db.list_pending_incoming_transfers().map_err(db_error)?;
    Ok(Json(PendingIncomingTransfersResponse { transfers }))
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
