use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::relay_client::MobileNotificationPayload;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 2_000;
const MAX_TASK_ID_CHARS: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MobileNotificationRequest {
    title: String,
    body: String,
    task_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MobileNotificationResponse {
    status: &'static str,
    accepted_count: u64,
    failed_count: u64,
    failure_reasons: Vec<crate::relay_client::MobileNotificationFailureReason>,
}

pub(super) async fn notify_mobile(
    State(state): State<Arc<AppState>>,
    _access: PrivilegedTaskAccess,
    Json(payload): Json<MobileNotificationRequest>,
) -> Result<Json<MobileNotificationResponse>, (axum::http::StatusCode, String)> {
    let title = validate_text("title", payload.title, MAX_TITLE_CHARS)?;
    let body = validate_text("body", payload.body, MAX_BODY_CHARS)?;
    let task_id = payload
        .task_id
        .map(|task_id| validate_text("taskId", task_id, MAX_TASK_ID_CHARS))
        .transpose()?;

    let delivery = state
        .queue_mobile_notification(MobileNotificationPayload {
            title,
            body,
            task_id,
        })
        .await
        .map_err(|error| (axum::http::StatusCode::SERVICE_UNAVAILABLE, error))?;

    Ok(Json(MobileNotificationResponse {
        status: if delivery.accepted_count > 0 {
            "accepted"
        } else if delivery.failed_count > 0 {
            "deliveryFailed"
        } else {
            "noRegisteredDevices"
        },
        accepted_count: delivery.accepted_count,
        failed_count: delivery.failed_count,
        failure_reasons: delivery.failure_reasons,
    }))
}

fn validate_text(
    field: &'static str,
    value: String,
    max_chars: usize,
) -> Result<String, (axum::http::StatusCode, String)> {
    let value = value.trim();
    if value.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field} must be a non-empty string"),
        ));
    }
    if value.chars().count() > max_chars {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field} must be at most {max_chars} characters"),
        ));
    }
    Ok(value.to_string())
}
