use crate::companion_bridge::{
    CompanionBridgeBundle, CompanionBridgeEventResult, CompanionBridgeKey,
    CompanionBridgeLifecycle, CompanionBridgeManager, CompanionBridgeStateUpdate,
    CompanionLifecyclePageStrings,
};
use kanna_agent_protocol::CompanionAsset;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpsertRemoteCompanionBridgeInput {
    pub owner_window_label: String,
    pub lease_generation: String,
    pub owner_desktop_id: String,
    pub owner_task_id: String,
    pub session_id: String,
    pub revision: String,
    pub document_html: String,
    pub lifecycle_page_strings: CompanionLifecyclePageStrings,
    pub assets: Vec<CompanionAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetRemoteCompanionBridgeStateInput {
    pub owner_window_label: String,
    pub lease_generation: String,
    pub bridge_id: String,
    pub status: CompanionBridgeLifecycle,
    pub selected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetRemoteCompanionEventResultInput {
    pub owner_window_label: String,
    pub lease_generation: String,
    pub bridge_id: String,
    pub session_id: String,
    pub revision: String,
    pub event_id: String,
    pub accepted: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloseRemoteCompanionBridgeInput {
    pub owner_window_label: String,
    pub lease_generation: String,
    pub bridge_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRemoteCompanionBridgeOutput {
    pub entry_url: String,
    pub bridge_id: String,
}

// Tauri binds these individual arguments to the existing frontend invoke contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn upsert_remote_companion_bridge(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CompanionBridgeManager>>,
    owner_desktop_id: String,
    owner_task_id: String,
    session_id: String,
    revision: String,
    document_html: String,
    lifecycle_page_strings: CompanionLifecyclePageStrings,
    assets: Vec<CompanionAsset>,
    lease_generation: String,
) -> Result<UpsertRemoteCompanionBridgeOutput, String> {
    upsert_remote_companion_bridge_inner(
        state.inner(),
        UpsertRemoteCompanionBridgeInput {
            owner_window_label: window.label().to_owned(),
            lease_generation,
            owner_desktop_id,
            owner_task_id,
            session_id,
            revision,
            document_html,
            lifecycle_page_strings,
            assets,
        },
    )
    .await
}

async fn upsert_remote_companion_bridge_inner(
    state: &Arc<CompanionBridgeManager>,
    input: UpsertRemoteCompanionBridgeInput,
) -> Result<UpsertRemoteCompanionBridgeOutput, String> {
    let handle = state
        .upsert(
            CompanionBridgeKey {
                owner_window_label: input.owner_window_label,
                owner_lease_generation: input.lease_generation,
                owner_desktop_id: input.owner_desktop_id,
                owner_task_id: input.owner_task_id,
                session_id: input.session_id.clone(),
            },
            CompanionBridgeBundle {
                session_id: input.session_id,
                revision: input.revision,
                document_html: input.document_html,
                lifecycle_page_strings: input.lifecycle_page_strings,
                assets: input.assets,
            },
        )
        .await?;
    Ok(UpsertRemoteCompanionBridgeOutput {
        entry_url: handle.entry_url,
        bridge_id: handle.bridge_id,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_remote_companion_bridge_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CompanionBridgeManager>>,
    bridge_id: String,
    status: CompanionBridgeLifecycle,
    selected: bool,
    lease_generation: String,
) -> Result<(), String> {
    set_remote_companion_bridge_state_inner(
        state.inner(),
        SetRemoteCompanionBridgeStateInput {
            owner_window_label: window.label().to_owned(),
            lease_generation,
            bridge_id,
            status,
            selected,
        },
    )
    .await
}

async fn set_remote_companion_bridge_state_inner(
    state: &Arc<CompanionBridgeManager>,
    input: SetRemoteCompanionBridgeStateInput,
) -> Result<(), String> {
    state
        .ensure_lease(
            &input.bridge_id,
            &input.owner_window_label,
            &input.lease_generation,
        )
        .await?;
    state
        .set_state(
            &input.bridge_id,
            CompanionBridgeStateUpdate {
                status: input.status,
                selected: input.selected,
            },
        )
        .await
}

// Tauri binds these individual arguments to the existing frontend invoke contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn set_remote_companion_event_result(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CompanionBridgeManager>>,
    bridge_id: String,
    session_id: String,
    revision: String,
    event_id: String,
    accepted: bool,
    code: Option<String>,
    message: Option<String>,
    lease_generation: String,
) -> Result<(), String> {
    set_remote_companion_event_result_inner(
        state.inner(),
        SetRemoteCompanionEventResultInput {
            owner_window_label: window.label().to_owned(),
            lease_generation,
            bridge_id,
            session_id,
            revision,
            event_id,
            accepted,
            code,
            message,
        },
    )
    .await
}

async fn set_remote_companion_event_result_inner(
    state: &Arc<CompanionBridgeManager>,
    input: SetRemoteCompanionEventResultInput,
) -> Result<(), String> {
    state
        .ensure_lease(
            &input.bridge_id,
            &input.owner_window_label,
            &input.lease_generation,
        )
        .await?;
    state
        .set_event_result(
            &input.bridge_id,
            CompanionBridgeEventResult {
                session_id: input.session_id,
                revision: input.revision,
                event_id: input.event_id,
                accepted: input.accepted,
                code: input.code,
                message: input.message,
            },
        )
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn close_remote_companion_bridge(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CompanionBridgeManager>>,
    bridge_id: String,
    lease_generation: String,
) -> Result<(), String> {
    close_remote_companion_bridge_inner(
        state.inner(),
        CloseRemoteCompanionBridgeInput {
            owner_window_label: window.label().to_owned(),
            lease_generation,
            bridge_id,
        },
    )
    .await
}

async fn close_remote_companion_bridge_inner(
    state: &Arc<CompanionBridgeManager>,
    input: CloseRemoteCompanionBridgeInput,
) -> Result<(), String> {
    state
        .ensure_lease(
            &input.bridge_id,
            &input.owner_window_label,
            &input.lease_generation,
        )
        .await?;
    state.close(&input.bridge_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn close_remote_companion_bridges_for_lease(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CompanionBridgeManager>>,
    lease_generation: String,
) -> Result<(), String> {
    state
        .close_owned_by_lease(window.label(), &lease_generation)
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        CloseRemoteCompanionBridgeInput, SetRemoteCompanionBridgeStateInput,
        SetRemoteCompanionEventResultInput, UpsertRemoteCompanionBridgeInput,
    };
    use crate::companion_bridge::CompanionBridgeLifecycle;

    #[test]
    fn command_inputs_use_the_frontend_camel_case_contract() {
        let upsert: UpsertRemoteCompanionBridgeInput = serde_json::from_value(serde_json::json!({
            "ownerWindowLabel": "main",
            "leaseGeneration": "lease-1",
            "ownerDesktopId": "desktop-1",
            "ownerTaskId": "task-1",
            "sessionId": "session-1",
            "revision": "revision-1",
            "documentHtml": "<!doctype html><p>Companion</p>",
            "lifecyclePageStrings": {
                "unavailableTitle": "Ended",
                "unavailableDetail": "No longer available",
                "errorTitle": "Unavailable",
                "errorDetail": "Could not display"
            },
            "assets": [{
                "name": "layout.png",
                "content_type": "image/png",
                "digest": "digest-1",
                "data_b64": "UE5H"
            }]
        }))
        .unwrap();
        assert_eq!(upsert.owner_desktop_id, "desktop-1");
        assert_eq!(upsert.owner_task_id, "task-1");
        assert_eq!(upsert.session_id, "session-1");
        assert_eq!(upsert.assets[0].name, "layout.png");

        let state: SetRemoteCompanionBridgeStateInput = serde_json::from_value(serde_json::json!({
            "ownerWindowLabel": "main",
            "leaseGeneration": "lease-1",
            "bridgeId": "bridge-1",
            "status": "reconnecting",
            "selected": false
        }))
        .unwrap();
        assert_eq!(state.status, CompanionBridgeLifecycle::Reconnecting);
        assert!(!state.selected);

        let result: SetRemoteCompanionEventResultInput =
            serde_json::from_value(serde_json::json!({
                "ownerWindowLabel": "main",
                "leaseGeneration": "lease-1",
                "bridgeId": "bridge-1",
                "sessionId": "session-1",
                "revision": "revision-1",
                "eventId": "event-1",
                "accepted": false,
                "code": "stale_revision",
                "message": "not reflected"
            }))
            .unwrap();
        assert_eq!(result.event_id, "event-1");
        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.revision, "revision-1");
        assert!(!result.accepted);

        let close: CloseRemoteCompanionBridgeInput = serde_json::from_value(serde_json::json!({
            "ownerWindowLabel": "main",
            "leaseGeneration": "lease-1",
            "bridgeId": "bridge-1"
        }))
        .unwrap();
        assert_eq!(close.bridge_id, "bridge-1");
    }

    #[test]
    fn command_inputs_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<UpsertRemoteCompanionBridgeInput>(serde_json::json!({
                "ownerDesktopId": "desktop-1",
                "ownerWindowLabel": "main",
                "leaseGeneration": "lease-1",
                "ownerTaskId": "task-1",
                "sessionId": "session-1",
                "revision": "revision-1",
                "documentHtml": "<p>Companion</p>",
                "lifecyclePageStrings": {
                    "unavailableTitle": "Ended",
                    "unavailableDetail": "No longer available",
                    "errorTitle": "Unavailable",
                    "errorDetail": "Could not display"
                },
                "assets": [],
                "capability": "must-not-be-accepted"
            }))
            .is_err()
        );
    }
}
