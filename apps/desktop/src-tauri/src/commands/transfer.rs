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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.get_local_identity().await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.upsert_external_peer(peer).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn remove_external_transfer_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.remove_external_peer(peer_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn clear_external_transfer_peers(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.clear_external_peers().await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
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
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.observe_peer_session(peer_id, session_id)
    )
}

#[tauri::command]
pub async fn unobserve_transfer_peer_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.unobserve_peer_session(peer_id, session_id)
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
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.advance_peer_task_stage(peer_id, task_id)
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .request_task_pull(
                target_peer_id,
                source_task_id,
                transport.unwrap_or_else(|| "auto".into()),
            )
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn stage_transfer_artifact(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    artifact_id: String,
    path: String,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.stage_transfer_artifact(transfer_id, artifact_id, path)
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .mark_incoming_transfer_event_recorded(transfer_id)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn mark_incoming_transfer_ack_completed(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .mark_incoming_transfer_ack_completed(transfer_id)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn mark_outgoing_transfer_commit_applied(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .mark_outgoing_transfer_commit_applied(transfer_id)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
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
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    payload: Option<Value>,
    finalized_cleanly: bool,
    error: Option<String>,
) -> Result<Value, String> {
    with_transfer_client!(
        app,
        state,
        client,
        client.complete_outgoing_transfer_finalization(
            transfer_id,
            payload,
            finalized_cleanly,
            error,
        )
    )
}
