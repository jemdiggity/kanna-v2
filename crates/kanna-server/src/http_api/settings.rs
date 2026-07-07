use super::state::AppState;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SettingResponse {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PutSettingRequest {
    value: String,
}

pub(super) async fn get_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<Json<SettingResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let value = db
        .get_setting(&key)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {e}"),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("setting not found: {key}"),
            )
        })?;
    Ok(Json(SettingResponse { key, value }))
}

pub(super) async fn put_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(payload): Json<PutSettingRequest>,
) -> Result<Json<SettingResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    db.set_setting(&key, &payload.value).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    state.publish_state_changed(StateChangeScope::Settings);
    Ok(Json(SettingResponse {
        key,
        value: payload.value,
    }))
}

pub(super) async fn delete_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    db.delete_setting(&key).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    state.publish_state_changed(StateChangeScope::Settings);
    Ok(Json(serde_json::json!({ "key": key })))
}
