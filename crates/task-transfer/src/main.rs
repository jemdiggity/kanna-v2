use kanna_task_transfer::protocol::{ControlRequest, ControlResponse, SidecarEvent};
use kanna_task_transfer::runtime::{RuntimeConfig, RuntimeError, RuntimeEvent, TransferRuntime};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::{oneshot, Semaphore};

const DEFAULT_CONTROL_MAX_IN_FLIGHT: usize = 32;
const DEFAULT_MARK_READ_CONTROL_MAX_IN_FLIGHT: usize = 4;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = Arc::new(TransferRuntime::spawn(RuntimeConfig::from_env()?).await?);
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let event_runtime = Arc::clone(&runtime);
    let event_stdout = Arc::clone(&stdout);

    let event_task = tokio::spawn(async move {
        loop {
            let event = match event_runtime.next_event().await {
                Ok(event) => event,
                Err(RuntimeError::IncomingEventChannelClosed) => break,
                Err(error) => {
                    let response = ControlResponse::Error {
                        request_id: String::new(),
                        message: error.to_string(),
                    };
                    let _ = write_json_line(&event_stdout, &response);
                    break;
                }
            };

            let payload = match event {
                RuntimeEvent::PairingStarted(event) => SidecarEvent::PairingStarted {
                    peer_id: event.peer_id,
                    display_name: event.display_name,
                    verification_code: event.verification_code,
                },
                RuntimeEvent::PairingRequested(event) => SidecarEvent::PairingRequested {
                    request_id: event.request_id,
                    peer_id: event.peer_id,
                    display_name: event.display_name,
                    verification_code: event.verification_code,
                },
                RuntimeEvent::PairingCompleted(event) => SidecarEvent::PairingCompleted {
                    peer_id: event.peer_id,
                    display_name: event.display_name,
                    verification_code: event.verification_code,
                },
                RuntimeEvent::TaskPullRequested(event) => SidecarEvent::TaskPullRequested {
                    request_id: event.request_id,
                    requester_peer_id: event.requester_peer_id,
                    source_task_id: event.source_task_id,
                },
                RuntimeEvent::IncomingTransferRequest(event) => {
                    SidecarEvent::IncomingTransferRequest {
                        transfer_id: event.transfer_id,
                        source_peer_id: event.source_peer_id,
                        source_task_id: event.source_task_id,
                        source_name: event.source_name,
                        payload: event.payload,
                    }
                }
                RuntimeEvent::OutgoingTransferCommitted(event) => {
                    SidecarEvent::OutgoingTransferCommitted {
                        transfer_id: event.transfer_id,
                        source_task_id: event.source_task_id,
                        destination_local_task_id: event.destination_local_task_id,
                    }
                }
                RuntimeEvent::OutgoingTransferFinalizationRequested(event) => {
                    SidecarEvent::OutgoingTransferFinalizationRequested {
                        transfer_id: event.transfer_id,
                    }
                }
                RuntimeEvent::TerminalEvent {
                    peer_id,
                    session_id,
                    observer_lease_id,
                    event,
                } => SidecarEvent::TerminalEvent {
                    peer_id,
                    session_id,
                    observer_lease_id,
                    event,
                },
            };

            if write_json_line(&event_stdout, &payload).is_err() {
                break;
            }
        }
    });

    let mut command_tasks = tokio::task::JoinSet::new();
    let control_permits = Arc::new(Semaphore::new(control_limit(
        "KANNA_TRANSFER_CONTROL_MAX_IN_FLIGHT",
        DEFAULT_CONTROL_MAX_IN_FLIGHT,
    )));
    let mark_read_control_permits = Arc::new(Semaphore::new(control_limit(
        "KANNA_TRANSFER_MARK_READ_CONTROL_MAX_IN_FLIGHT",
        DEFAULT_MARK_READ_CONTROL_MAX_IN_FLIGHT,
    )));
    let mut input_tails = HashMap::<(String, String), oneshot::Receiver<()>>::new();
    for line in std::io::stdin().lock().lines() {
        while command_tasks.try_join_next().is_some() {}
        input_tails.retain(|_, receiver| match receiver.try_recv() {
            Ok(()) | Err(oneshot::error::TryRecvError::Closed) => false,
            Err(oneshot::error::TryRecvError::Empty) => true,
        });
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request_id = extract_request_id(&line);
        match serde_json::from_str::<ControlRequest>(&line) {
            Ok(request) => {
                let is_mark_read = matches!(&request, ControlRequest::MarkPeerTaskRead { .. });
                let permits = if is_mark_read {
                    Arc::clone(&mark_read_control_permits)
                } else {
                    Arc::clone(&control_permits)
                };
                let permit = match permits.try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        write_json_line(
                            &stdout,
                            &ControlResponse::Error {
                                request_id,
                                message: if is_mark_read {
                                    "too many mark-read controls are already in flight".into()
                                } else {
                                    "too many transfer controls are already in flight".into()
                                },
                            },
                        )?;
                        continue;
                    }
                };
                let (input_predecessor, input_completion) = match &request {
                    ControlRequest::SendPeerSessionInput {
                        target_peer_id,
                        session_id,
                        ..
                    } => {
                        let key = (target_peer_id.clone(), session_id.clone());
                        let (completion, tail) = oneshot::channel();
                        (input_tails.insert(key, tail), Some(completion))
                    }
                    _ => (None, None),
                };
                let request_runtime = Arc::clone(&runtime);
                let request_stdout = Arc::clone(&stdout);
                command_tasks.spawn(async move {
                    let _permit = permit;
                    if let Some(predecessor) = input_predecessor {
                        let _ = predecessor.await;
                    }
                    let response = handle_request(&request_runtime, request).await;
                    if let Err(error) = write_json_line(&request_stdout, &response) {
                        eprintln!("[task-transfer] failed writing control response: {error}");
                    }
                    if let Some(completion) = input_completion {
                        let _ = completion.send(());
                    }
                });
            }
            Err(error) => {
                write_json_line(
                    &stdout,
                    &ControlResponse::Error {
                        request_id,
                        message: error.to_string(),
                    },
                )?;
            }
        }
    }

    command_tasks.shutdown().await;
    event_task.abort();
    Ok(())
}

fn control_limit(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

async fn handle_request(runtime: &TransferRuntime, request: ControlRequest) -> ControlResponse {
    match request {
        ControlRequest::GetLocalIdentity { request_id } => {
            let identity = runtime.local_identity();
            ControlResponse::GetLocalIdentity {
                request_id,
                peer_id: identity.peer_id,
                display_name: identity.display_name,
                public_key: identity.public_key,
                protocol_version: identity.protocol_version,
                accepting_transfers: identity.accepting_transfers,
            }
        }
        ControlRequest::ListPeers { request_id } => match runtime.list_peers().await {
            Ok(peers) => ControlResponse::ListPeers { request_id, peers },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::UpsertExternalPeer { request_id, peer } => {
            match runtime.upsert_external_peer(peer).await {
                Ok(()) => ControlResponse::UpsertExternalPeer { request_id },
                Err(error) => control_error(request_id, error),
            }
        }
        ControlRequest::RemoveExternalPeer {
            request_id,
            peer_id,
        } => match runtime.remove_external_peer(&peer_id).await {
            Ok(()) => ControlResponse::RemoveExternalPeer { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ClearExternalPeers { request_id } => {
            match runtime.clear_external_peers().await {
                Ok(()) => ControlResponse::ClearExternalPeers { request_id },
                Err(error) => control_error(request_id, error),
            }
        }
        ControlRequest::SetTaskSnapshot {
            request_id,
            snapshot,
        } => match runtime.set_task_snapshot(snapshot).await {
            Ok(()) => ControlResponse::SetTaskSnapshot { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ListPeerTaskSnapshots { request_id } => {
            match runtime.list_peer_task_snapshots().await {
                Ok(listing) => ControlResponse::ListPeerTaskSnapshots {
                    request_id,
                    snapshots: listing.snapshots,
                    issues: listing.issues,
                },
                Err(error) => control_error(request_id, error),
            }
        }
        ControlRequest::ObservePeerSession {
            request_id,
            target_peer_id,
            session_id,
            observer_lease_id,
        } => match runtime
            .observe_peer_session(&target_peer_id, &session_id, &observer_lease_id)
            .await
        {
            Ok(()) => ControlResponse::ObservePeerSession { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::SendPeerSessionInput {
            request_id,
            target_peer_id,
            session_id,
            data,
        } => match runtime
            .send_peer_session_input(&target_peer_id, &session_id, data)
            .await
        {
            Ok(()) => ControlResponse::SendPeerSessionInput { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ResizePeerSession {
            request_id,
            target_peer_id,
            session_id,
            cols,
            rows,
        } => match runtime
            .resize_peer_session(&target_peer_id, &session_id, cols, rows)
            .await
        {
            Ok(()) => ControlResponse::ResizePeerSession { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ClosePeerTask {
            request_id,
            target_peer_id,
            task_id,
        } => match runtime.close_peer_task(&target_peer_id, &task_id).await {
            Ok(()) => ControlResponse::ClosePeerTask { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AdvancePeerTaskStage {
            request_id,
            target_peer_id,
            task_id,
            expected_transition_revision,
        } => match runtime
            .advance_peer_task_stage(
                &target_peer_id,
                &task_id,
                expected_transition_revision.as_deref(),
            )
            .await
        {
            Ok(()) => ControlResponse::AdvancePeerTaskStage { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ReadPeerTaskFile {
            request_id,
            target_peer_id,
            task_id,
            path,
        } => match runtime
            .read_peer_task_file(&target_peer_id, &task_id, &path)
            .await
        {
            Ok((path, content)) => ControlResponse::ReadPeerTaskFile {
                request_id,
                path,
                content,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkPeerTaskRead {
            request_id,
            target_peer_id,
            task_id,
            expected_activity_revision,
        } => match runtime
            .mark_peer_task_read(&target_peer_id, &task_id, expected_activity_revision)
            .await
        {
            Ok(()) => ControlResponse::MarkPeerTaskRead { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::UnobservePeerSession {
            request_id,
            target_peer_id,
            session_id,
            observer_lease_id,
        } => match runtime
            .unobserve_peer_session(&target_peer_id, &session_id, &observer_lease_id)
            .await
        {
            Ok(()) => ControlResponse::UnobservePeerSession { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::StartPairing {
            request_id,
            target_peer_id,
        } => match runtime.start_pairing(&target_peer_id).await {
            Ok(result) => ControlResponse::StartPairing {
                request_id,
                peer: result.peer,
                verification_code: result.verification_code,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AcceptPairing {
            request_id,
            pairing_request_id,
            verification_code,
        } => match runtime
            .accept_pairing(&pairing_request_id, &verification_code)
            .await
        {
            Ok(()) => ControlResponse::AcceptPairing {
                request_id,
                pairing_request_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::RejectPairing {
            request_id,
            pairing_request_id,
        } => match runtime.reject_pairing(&pairing_request_id).await {
            Ok(()) => ControlResponse::RejectPairing {
                request_id,
                pairing_request_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::StageTransferArtifact {
            request_id,
            transfer_id,
            artifact_id,
            path,
            owned,
        } => match runtime
            .stage_transfer_artifact(&transfer_id, &artifact_id, path.into(), owned)
            .await
        {
            Ok(()) => ControlResponse::StageTransferArtifact {
                request_id,
                transfer_id,
                artifact_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::FetchTransferArtifact {
            request_id,
            transfer_id,
            artifact_id,
        } => match runtime
            .fetch_transfer_artifact(&transfer_id, &artifact_id)
            .await
        {
            Ok(artifact) => ControlResponse::FetchTransferArtifact {
                request_id,
                transfer_id,
                artifact_id,
                path: artifact.path.to_string_lossy().into_owned(),
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::PrepareTransferPreflight {
            request_id,
            source_task_id,
            target_peer_id,
            transport,
        } => match runtime
            .prepare_transfer_preflight_with_transport(&target_peer_id, &source_task_id, transport)
            .await
        {
            Ok(result) => ControlResponse::PrepareTransferPreflight {
                request_id,
                transfer_id: result.transfer_id,
                source_peer_id: result.source_peer_id,
                target_has_repo: result.target_has_repo,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::RequestTaskPull {
            request_id,
            target_peer_id,
            source_task_id,
            transport,
        } => match runtime
            .request_task_pull(&target_peer_id, &source_task_id, transport)
            .await
        {
            Ok(pull_request_id) => ControlResponse::RequestTaskPull {
                request_id,
                pull_request_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::PrepareTransferCommit {
            request_id,
            transfer_id,
            payload,
        } => match runtime.prepare_transfer_commit(&transfer_id, payload).await {
            Ok(()) => ControlResponse::PrepareTransferCommit {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::FinalizeOutgoingTransfer {
            request_id,
            transfer_id,
        } => match runtime.finalize_outgoing_transfer(&transfer_id).await {
            Ok(result) => ControlResponse::FinalizeOutgoingTransfer {
                request_id,
                transfer_id,
                payload: result.payload,
                finalized_cleanly: result.finalized_cleanly,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::CompleteOutgoingTransferFinalization {
            request_id,
            transfer_id,
            payload,
            finalized_cleanly,
            error,
        } => match runtime
            .complete_outgoing_transfer_finalization(
                &transfer_id,
                match error {
                    Some(message) => Err(RuntimeError::Protocol(message)),
                    None => match payload {
                        Some(payload) => {
                            Ok(kanna_task_transfer::runtime::FinalizedOutgoingTransfer {
                                payload,
                                finalized_cleanly,
                            })
                        }
                        None => Err(RuntimeError::Protocol(
                            "complete outgoing transfer finalization missing payload".into(),
                        )),
                    },
                },
            )
            .await
        {
            Ok(()) => ControlResponse::CompleteOutgoingTransferFinalization {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AcknowledgeImportCommitted {
            request_id,
            transfer_id,
            source_task_id,
            destination_local_task_id,
        } => match runtime
            .acknowledge_import_committed(&transfer_id, &source_task_id, &destination_local_task_id)
            .await
        {
            Ok(()) => ControlResponse::AcknowledgeImportCommitted {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkIncomingEventRecorded {
            request_id,
            transfer_id,
        } => match runtime.mark_incoming_event_recorded(&transfer_id).await {
            Ok(()) => ControlResponse::MarkIncomingEventRecorded {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkImportCommitApplied {
            request_id,
            transfer_id,
        } => match runtime.mark_import_commit_applied(&transfer_id).await {
            Ok(()) => ControlResponse::MarkImportCommitApplied {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::NackImportCommit {
            request_id,
            transfer_id,
        } => match runtime.nack_import_commit(&transfer_id).await {
            Ok(()) => ControlResponse::NackImportCommit {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkImportAckCompleted {
            request_id,
            transfer_id,
        } => match runtime.mark_import_ack_completed(&transfer_id).await {
            Ok(()) => ControlResponse::MarkImportAckCompleted {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
    }
}

fn control_error(request_id: String, error: RuntimeError) -> ControlResponse {
    ControlResponse::Error {
        request_id,
        message: error.to_string(),
    }
}

fn extract_request_id(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("request_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn write_json_line<T>(stdout: &Arc<Mutex<std::io::Stdout>>, value: &T) -> std::io::Result<()>
where
    T: serde::Serialize,
{
    let encoded = serde_json::to_vec(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut writer = stdout
        .lock()
        .map_err(|_| std::io::Error::other("stdout mutex poisoned"))?;
    writer.write_all(&encoded)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}
