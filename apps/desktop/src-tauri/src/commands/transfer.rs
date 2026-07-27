use serde_json::Value;
use std::sync::Arc;

#[tauri::command]
pub async fn ensure_cloud_transfer_proxy(
    state: tauri::State<'_, crate::CloudTransferProxyState>,
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: String,
) -> Result<crate::cloud_transfer_proxy::CloudTransferProxyEndpoint, String> {
    crate::cloud_transfer_proxy::ensure_cloud_transfer_proxy_in_state(
        state.inner(),
        peer_id,
        desktop_id,
        relay_url,
        id_token,
    )
    .await
}

#[tauri::command]
pub async fn remove_cloud_transfer_proxy(
    state: tauri::State<'_, crate::CloudTransferProxyState>,
    peer_id: String,
) -> Result<(), String> {
    crate::cloud_transfer_proxy::remove_cloud_transfer_proxy_in_state(state.inner(), &peer_id).await
}

#[tauri::command]
pub async fn clear_cloud_transfer_proxies(
    state: tauri::State<'_, crate::CloudTransferProxyState>,
) -> Result<(), String> {
    crate::cloud_transfer_proxy::clear_cloud_transfer_proxies_in_state(state.inner()).await
}

async fn transfer_client(
    app: &tauri::AppHandle,
    state: &crate::TransferServiceState,
) -> Result<Arc<crate::transfer_sidecar::TransferSidecarClient>, String> {
    let mut guard = state.lock().await;
    if guard.as_ref().is_some_and(|client| client.is_dead()) {
        *guard = None;
    }
    if guard.is_none() {
        *guard = Some(Arc::new(
            crate::transfer_sidecar::TransferSidecarClient::spawn(app.clone())?,
        ));
    }
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "transfer sidecar client unavailable".to_string())
}

async fn retire_dead_client(
    state: &crate::TransferServiceState,
    client: &Arc<crate::transfer_sidecar::TransferSidecarClient>,
) {
    if !client.is_dead() {
        return;
    }
    let mut guard = state.lock().await;
    if guard
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(active, client))
    {
        *guard = None;
    }
}

macro_rules! with_transfer_client {
    ($app:expr, $state:expr, $client:ident, $request:expr) => {{
        let $client = transfer_client(&$app, $state.inner()).await?;
        let result = $request.await;
        retire_dead_client($state.inner(), &$client).await;
        result
    }};
}

#[tauri::command]
pub async fn get_transfer_identity(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Value, String> {
    with_transfer_client!(app, state, client, client.get_local_identity())
}

#[tauri::command]
pub async fn list_transfer_peers(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Vec<Value>, String> {
    let result = with_transfer_client!(app, state, client, client.list_transfer_peers());
    match &result {
        Ok(peers) => eprintln!(
            "[transfer-debug] list_transfer_peers ok count={}",
            peers.len()
        ),
        Err(error) => eprintln!("[transfer-debug] list_transfer_peers err: {}", error),
    }
    result
}

#[tauri::command]
pub async fn upsert_external_transfer_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer: Value,
) -> Result<Value, String> {
    with_transfer_client!(app, state, client, client.upsert_external_peer(peer))
}

#[tauri::command]
pub async fn remove_external_transfer_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
) -> Result<Value, String> {
    with_transfer_client!(app, state, client, client.remove_external_peer(peer_id))
}

#[tauri::command]
pub async fn clear_external_transfer_peers(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Value, String> {
    with_transfer_client!(app, state, client, client.clear_external_peers())
}

#[tauri::command]
pub async fn set_transfer_task_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    snapshot: Value,
) -> Result<Value, String> {
    with_transfer_client!(app, state, client, client.set_task_snapshot(snapshot))
}

#[tauri::command]
pub async fn list_transfer_task_snapshots(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Vec<Value>, String> {
    with_transfer_client!(app, state, client, client.list_peer_task_snapshots())
}

#[tauri::command]
pub async fn observe_transfer_peer_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
    observer_lease_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.observe_peer_session(peer_id, session_id, observer_lease_id)
    )
}

#[tauri::command]
pub async fn unobserve_transfer_peer_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
    observer_lease_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.unobserve_peer_session(peer_id, session_id, observer_lease_id)
    )
}

#[tauri::command]
pub async fn send_transfer_peer_session_input(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.send_peer_session_input(peer_id, session_id, data)
    )
}

#[tauri::command]
pub async fn resize_transfer_peer_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.resize_peer_session(peer_id, session_id, cols, rows)
    )
}

#[tauri::command]
pub async fn close_transfer_peer_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
) -> Result<Value, String> {
    with_transfer_client!(app, state, client, client.close_peer_task(peer_id, task_id))
}

#[tauri::command]
pub async fn advance_transfer_peer_task_stage(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
    expected_transition_revision: Option<String>,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.advance_peer_task_stage(peer_id, task_id, expected_transition_revision)
    )
}

#[tauri::command]
pub async fn read_transfer_peer_task_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
    path: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.read_peer_task_file(peer_id, task_id, path)
    )
}

#[tauri::command]
pub async fn mark_transfer_peer_task_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
    expected_activity_revision: i64,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.mark_peer_task_read(peer_id, task_id, expected_activity_revision)
    )
}

#[tauri::command]
pub async fn start_peer_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
) -> Result<Value, String> {
    eprintln!("[transfer-debug] start_peer_pairing start peer_id={peer_id}");
    let result = with_transfer_client!(
        app,
        state,
        client,
        client.start_peer_pairing(peer_id.clone())
    );
    match &result {
        Ok(value) => eprintln!("[transfer-debug] start_peer_pairing ok peer_id={peer_id}: {value}"),
        Err(error) => {
            eprintln!("[transfer-debug] start_peer_pairing err peer_id={peer_id}: {error}")
        }
    }
    result
}

#[tauri::command]
pub async fn accept_peer_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    pairing_request_id: String,
    verification_code: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.accept_peer_pairing(pairing_request_id, verification_code)
    )
}

#[tauri::command]
pub async fn reject_peer_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    pairing_request_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.reject_peer_pairing(pairing_request_id)
    )
}

#[tauri::command]
pub async fn prepare_outgoing_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    payload: Value,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.prepare_outgoing_transfer(payload)
    )
}

#[tauri::command]
pub async fn request_task_pull(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    target_peer_id: String,
    source_task_id: String,
    transport: Option<String>,
) -> Result<Value, String> {
    let transport = transport.unwrap_or_else(|| "auto".into());
    with_transfer_client!(
        app,
        state,
        client,
        client.request_task_pull(target_peer_id, source_task_id, transport)
    )
}

#[tauri::command]
pub async fn stage_transfer_artifact(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    service_state: tauri::State<'_, crate::TransferServiceState>,
    consumer_state: tauri::State<'_, crate::TransferEventConsumerState>,
    transfer_id: String,
    artifact_id: String,
    path: String,
    owned: Option<bool>,
    delivery_id: Option<String>,
) -> Result<Value, String> {
    if let Some(delivery_id) = delivery_id.as_deref() {
        crate::transfer_sidecar::require_transfer_lifecycle_event_owner_in_state(
            consumer_state.inner(),
            webview.label(),
            delivery_id,
        )?;
    }
    with_transfer_client!(
        app,
        service_state,
        client,
        client.stage_transfer_artifact(transfer_id, artifact_id, path, owned.unwrap_or(false))
    )
}

#[tauri::command]
pub async fn fetch_transfer_artifact(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    artifact_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.fetch_transfer_artifact(transfer_id, artifact_id)
    )
}

#[tauri::command]
pub async fn materialize_transfer_artifact(
    source_path: String,
    provider: String,
    resume_session_id: String,
    filename: String,
    kind: String,
    materialization: String,
) -> Result<bool, String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME is unavailable for transfer artifact materialization".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::transfer_artifact::materialize_transfer_artifact_at_home(
            &home,
            std::path::Path::new(&source_path),
            &provider,
            &resume_session_id,
            &filename,
            &kind,
            &materialization,
        )
    })
    .await
    .map_err(|error| format!("transfer artifact materialization task failed: {error}"))?
}

#[tauri::command]
pub fn claim_transfer_event_consumer(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, crate::TransferEventConsumerState>,
) -> Result<bool, String> {
    crate::transfer_sidecar::claim_transfer_event_consumer_in_state(
        &app,
        state.inner(),
        webview.label(),
    )
}

#[tauri::command]
pub fn release_transfer_event_consumer(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, crate::TransferEventConsumerState>,
) -> Result<(), String> {
    crate::transfer_sidecar::release_transfer_event_consumer_in_state(
        &app,
        state.inner(),
        webview.label(),
    )
}

#[tauri::command]
pub fn acknowledge_transfer_lifecycle_event(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, crate::TransferEventConsumerState>,
    delivery_id: String,
) -> Result<bool, String> {
    crate::transfer_sidecar::acknowledge_transfer_lifecycle_event_in_state(
        &app,
        state.inner(),
        webview.label(),
        &delivery_id,
    )
}

#[tauri::command]
pub fn nack_transfer_lifecycle_event(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, crate::TransferEventConsumerState>,
    delivery_id: String,
) -> Result<bool, String> {
    crate::transfer_sidecar::nack_transfer_lifecycle_event_in_state(
        &app,
        state.inner(),
        webview.label(),
        &delivery_id,
    )
}

#[tauri::command]
pub fn renew_transfer_lifecycle_event(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, crate::TransferEventConsumerState>,
    delivery_id: String,
) -> bool {
    crate::transfer_sidecar::renew_transfer_lifecycle_event_in_state(
        state.inner(),
        webview.label(),
        &delivery_id,
    )
}

#[tauri::command]
pub fn claim_transfer_lifecycle_phase(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, crate::TransferEventConsumerState>,
    delivery_id: String,
    phase: String,
) -> Result<bool, String> {
    crate::transfer_sidecar::claim_transfer_lifecycle_phase_in_state(
        state.inner(),
        webview.label(),
        &delivery_id,
        &phase,
    )
}

#[tauri::command]
pub async fn acknowledge_incoming_transfer_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    source_task_id: String,
    destination_local_task_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.acknowledge_incoming_transfer_commit(
            transfer_id,
            source_task_id,
            destination_local_task_id,
        )
    )
}

#[tauri::command]
pub async fn mark_incoming_transfer_event_recorded(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.mark_incoming_transfer_event_recorded(transfer_id)
    )
}

#[tauri::command]
pub async fn mark_incoming_transfer_ack_completed(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.mark_incoming_transfer_ack_completed(transfer_id)
    )
}

#[tauri::command]
pub async fn mark_outgoing_transfer_commit_applied(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    service_state: tauri::State<'_, crate::TransferServiceState>,
    consumer_state: tauri::State<'_, crate::TransferEventConsumerState>,
    transfer_id: String,
    delivery_id: String,
) -> Result<Value, String> {
    crate::transfer_sidecar::require_transfer_lifecycle_event_owner_in_state(
        consumer_state.inner(),
        webview.label(),
        &delivery_id,
    )?;
    with_transfer_client!(
        app,
        service_state,
        client,
        client.mark_outgoing_transfer_commit_applied(transfer_id)
    )
}

#[tauri::command]
pub async fn nack_outgoing_transfer_commit(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    service_state: tauri::State<'_, crate::TransferServiceState>,
    consumer_state: tauri::State<'_, crate::TransferEventConsumerState>,
    transfer_id: String,
    delivery_id: String,
) -> Result<Value, String> {
    crate::transfer_sidecar::require_transfer_lifecycle_event_owner_in_state(
        consumer_state.inner(),
        webview.label(),
        &delivery_id,
    )?;
    with_transfer_client!(
        app,
        service_state,
        client,
        client.nack_outgoing_transfer_commit(transfer_id)
    )
}

#[tauri::command]
pub async fn finalize_outgoing_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.finalize_outgoing_transfer(transfer_id)
    )
}

#[tauri::command]
pub async fn complete_outgoing_transfer_finalization(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    service_state: tauri::State<'_, crate::TransferServiceState>,
    consumer_state: tauri::State<'_, crate::TransferEventConsumerState>,
    transfer_id: String,
    payload: Option<Value>,
    finalized_cleanly: bool,
    error: Option<String>,
    delivery_id: String,
) -> Result<Value, String> {
    crate::transfer_sidecar::require_transfer_lifecycle_event_owner_in_state(
        consumer_state.inner(),
        webview.label(),
        &delivery_id,
    )?;
    with_transfer_client!(
        app,
        service_state,
        client,
        client.complete_outgoing_transfer_finalization(
            transfer_id,
            payload,
            finalized_cleanly,
            error,
        )
    )
}
