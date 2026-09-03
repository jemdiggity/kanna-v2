use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::relay_client::{
    MobileNotificationDelivery, MobileNotificationNoDevicesReason, MobileNotificationPayload,
};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 2_000;
const MAX_TASK_ID_CHARS: usize = 256;

/// Placeholder content for a dry-run publish. The relay validates the shape of
/// every publish and ignores the content on a dry run; nothing is sent.
const REGISTRATION_PROBE_TITLE: &str = "Kanna";
const REGISTRATION_PROBE_BODY: &str = "push registration probe";

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
    /// Present exactly when `status` is `noRegisteredDevices` and the relay
    /// explained why (relays that predate the field explain nothing).
    #[serde(skip_serializing_if = "Option::is_none")]
    no_devices_reason: Option<MobileNotificationNoDevicesReason>,
}

fn delivery_status(delivery: &MobileNotificationDelivery) -> &'static str {
    if delivery.accepted_count > 0 {
        "accepted"
    } else if delivery.failed_count > 0 {
        "deliveryFailed"
    } else {
        "noRegisteredDevices"
    }
}

fn describe_no_devices_reason(reason: Option<&MobileNotificationNoDevicesReason>) -> String {
    let Some(reason) = reason else {
        return "reason=unexplained".to_string();
    };
    let mut text = format!("reason={}", reason.code);
    if let Some(retired_at) = &reason.retired_at {
        text.push_str(&format!(" retiredAt={retired_at}"));
    }
    if let Some(provider_code) = &reason.provider_code {
        text.push_str(&format!(" providerCode={provider_code}"));
    }
    if let Some(desktop_id) = &reason.retired_by_desktop_id {
        text.push_str(&format!(" retiredByDesktopId={desktop_id}"));
    }
    text
}

/// Every notification outcome is written to the server log, so an
/// `accepted` that later turns into `noRegisteredDevices` leaves a trace on
/// the desktop that sent it (task 34047a85: the 2026-09-03 loss left none).
fn log_notification_outcome(task_id: Option<&str>, delivery: &MobileNotificationDelivery) {
    let status = delivery_status(delivery);
    let task = task_id.unwrap_or("-");
    match status {
        "accepted" => log::info!(
            "Mobile notification {status}: task={task} accepted={} failed={} targeted={}",
            delivery.accepted_count,
            delivery.failed_count,
            delivery
                .targeted_device_count
                .map_or_else(|| "?".to_string(), |count| count.to_string()),
        ),
        "deliveryFailed" => log::warn!(
            "Mobile notification {status}: task={task} accepted={} failed={} failureReasons={}",
            delivery.accepted_count,
            delivery.failed_count,
            serde_json::to_string(&delivery.failure_reasons).unwrap_or_default(),
        ),
        _ => log::warn!(
            "Mobile notification {status}: task={task} accepted=0 failed=0 {}",
            describe_no_devices_reason(delivery.no_devices_reason.as_ref()),
        ),
    }
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
            task_id: task_id.clone(),
            dry_run: false,
        })
        .await
        .map_err(|error| {
            log::warn!(
                "Mobile notification relayFailed: task={} error={error}",
                task_id.as_deref().unwrap_or("-"),
            );
            (axum::http::StatusCode::SERVICE_UNAVAILABLE, error)
        })?;
    log_notification_outcome(task_id.as_deref(), &delivery);

    Ok(Json(MobileNotificationResponse {
        status: delivery_status(&delivery),
        accepted_count: delivery.accepted_count,
        failed_count: delivery.failed_count,
        failure_reasons: delivery.failure_reasons,
        no_devices_reason: delivery.no_devices_reason,
    }))
}

/// Whether the account this desktop is signed into currently has a mobile
/// push device registered, decided by the relay's own target resolution.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MobilePushRegistrationResponse {
    /// `registered`, `noRegisteredDevices`, or `unavailable` (the relay could
    /// not be asked; see `error`).
    status: &'static str,
    registered_device_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_devices_reason: Option<MobileNotificationNoDevicesReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub(super) async fn mobile_push_registration(
    State(state): State<Arc<AppState>>,
    _access: PrivilegedTaskAccess,
) -> Json<MobilePushRegistrationResponse> {
    let probe = state
        .queue_mobile_notification(MobileNotificationPayload {
            title: REGISTRATION_PROBE_TITLE.to_string(),
            body: REGISTRATION_PROBE_BODY.to_string(),
            task_id: None,
            dry_run: true,
        })
        .await;
    Json(match probe {
        Ok(delivery) => {
            let registered_device_count = delivery.targeted_device_count.unwrap_or(0);
            if registered_device_count > 0 {
                MobilePushRegistrationResponse {
                    status: "registered",
                    registered_device_count,
                    no_devices_reason: None,
                    error: None,
                }
            } else {
                log::warn!(
                    "Mobile push registration probe found no registered device: {}",
                    describe_no_devices_reason(delivery.no_devices_reason.as_ref()),
                );
                MobilePushRegistrationResponse {
                    status: "noRegisteredDevices",
                    registered_device_count: 0,
                    no_devices_reason: delivery.no_devices_reason,
                    error: None,
                }
            }
        }
        Err(error) => {
            log::warn!("Mobile push registration probe unavailable: {error}");
            MobilePushRegistrationResponse {
                status: "unavailable",
                registered_device_count: 0,
                no_devices_reason: None,
                error: Some(error),
            }
        }
    })
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
