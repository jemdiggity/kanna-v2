use serde_json::Value;

async fn ensure_client(
    app: &tauri::AppHandle,
    guard: &mut Option<crate::transfer_sidecar::TransferSidecarClient>,
) -> Result<(), String> {
    if guard.is_none() {
        *guard = Some(crate::transfer_sidecar::TransferSidecarClient::spawn(
            app.clone(),
        )?);
    }
    Ok(())
}

#[tauri::command]
pub async fn list_transfer_peers(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Vec<Value>, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.list_transfer_peers().await;
        (result, client.is_dead())
    };
    match &result {
        Ok(peers) => eprintln!(
            "[transfer-debug] list_transfer_peers ok count={}",
            peers.len()
        ),
        Err(error) => eprintln!("[transfer-debug] list_transfer_peers err: {}", error),
    }
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.set_task_snapshot(snapshot).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn list_transfer_task_snapshots(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
) -> Result<Vec<Value>, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.list_peer_task_snapshots().await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn observe_transfer_peer_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.observe_peer_session(peer_id, session_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn unobserve_transfer_peer_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.unobserve_peer_session(peer_id, session_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn send_transfer_peer_session_input(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .send_peer_session_input(peer_id, session_id, data)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .resize_peer_session(peer_id, session_id, cols, rows)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn close_transfer_peer_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.close_peer_task(peer_id, task_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn advance_transfer_peer_task_stage(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.advance_peer_task_stage(peer_id, task_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn read_transfer_peer_task_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
    path: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.read_peer_task_file(peer_id, task_id, path).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn mark_transfer_peer_task_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
    expected_activity_revision: i64,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .mark_peer_task_read(peer_id, task_id, expected_activity_revision)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn start_peer_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
) -> Result<Value, String> {
    eprintln!("[transfer-debug] start_peer_pairing start peer_id={peer_id}");
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.start_peer_pairing(peer_id.clone()).await;
        (result, client.is_dead())
    };
    match &result {
        Ok(value) => eprintln!("[transfer-debug] start_peer_pairing ok peer_id={peer_id}: {value}"),
        Err(error) => {
            eprintln!("[transfer-debug] start_peer_pairing err peer_id={peer_id}: {error}")
        }
    }
    if dead {
        *guard = None;
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .accept_peer_pairing(pairing_request_id, verification_code)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn reject_peer_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    pairing_request_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.reject_peer_pairing(pairing_request_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn prepare_outgoing_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    payload: Value,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.prepare_outgoing_transfer(payload).await;
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .stage_transfer_artifact(transfer_id, artifact_id, path)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn fetch_transfer_artifact(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    artifact_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .fetch_transfer_artifact(transfer_id, artifact_id)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}

#[tauri::command]
pub async fn acknowledge_incoming_transfer_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    source_task_id: String,
    destination_local_task_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .acknowledge_incoming_transfer_commit(
                transfer_id,
                source_task_id,
                destination_local_task_id,
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.finalize_outgoing_transfer(transfer_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
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
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client
            .complete_outgoing_transfer_finalization(transfer_id, payload, finalized_cleanly, error)
            .await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}
