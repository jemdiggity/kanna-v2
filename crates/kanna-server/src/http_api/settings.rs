use super::lan_trust::DesktopLocalAccess;
use super::state::AppState;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub(crate) const CLOUD_TRANSFER_IDENTITY_SETTING: &str = "cloud_transfer_identity_v1";

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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudTransferIdentity {
    pub(crate) peer_id: String,
    pub(crate) display_name: String,
    pub(crate) public_key: String,
    pub(crate) protocol_version: u16,
    pub(crate) accepting_transfers: bool,
}

pub(super) async fn put_cloud_transfer_identity(
    _desktop: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Json(identity): Json<CloudTransferIdentity>,
) -> Result<Json<SettingResponse>, (axum::http::StatusCode, String)> {
    validate_cloud_transfer_identity(&identity)?;
    let value = serde_json::to_string(&identity).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to encode cloud transfer identity: {error}"),
        )
    })?;
    let db = Db::open(&state.config.db_path).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })?;
    db.set_setting(CLOUD_TRANSFER_IDENTITY_SETTING, &value)
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?;
    state.publish_state_changed(StateChangeScope::Settings);
    Ok(Json(SettingResponse {
        key: CLOUD_TRANSFER_IDENTITY_SETTING.into(),
        value,
    }))
}

fn validate_cloud_transfer_identity(
    identity: &CloudTransferIdentity,
) -> Result<(), (axum::http::StatusCode, String)> {
    for (field, value, maximum) in [
        ("peerId", identity.peer_id.as_str(), 256),
        ("displayName", identity.display_name.as_str(), 256),
        ("publicKey", identity.public_key.as_str(), 4096),
    ] {
        if value.trim().is_empty() || value.chars().count() > maximum {
            return Err((
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                format!("{field} must be nonblank and at most {maximum} characters"),
            ));
        }
    }
    if identity.protocol_version == 0 {
        return Err((
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "protocolVersion must be positive".into(),
        ));
    }
    Ok(())
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
    reject_reserved_setting_mutation(&key)?;
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
    reject_reserved_setting_mutation(&key)?;
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

fn reject_reserved_setting_mutation(key: &str) -> Result<(), (axum::http::StatusCode, String)> {
    if key == CLOUD_TRANSFER_IDENTITY_SETTING {
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            "cloud transfer identity must use the desktop-local identity endpoint".into(),
        ));
    }
    Ok(())
}
