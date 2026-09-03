use kanna_agent_protocol::ServerFrame;
use kanna_task_transfer::protocol::{
    ControlRequest, ControlResponse, PeerCompanionEvent, PeerRequest, PeerResponse,
    PeerTerminalEvent, SidecarEvent,
};
use kanna_task_transfer::runtime::{ExternalPeer, TransferTransport};
use serde_json::json;

fn assert_roundtrip<T>(value: T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let encoded = serde_json::to_string(&value).unwrap();
    let decoded = serde_json::from_str::<T>(&encoded).unwrap();
    assert_eq!(decoded, value);
}

#[test]
fn get_local_identity_control_messages_roundtrip() {
    let request = ControlRequest::GetLocalIdentity {
        request_id: "identity-1".into(),
    };
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({
            "type": "get_local_identity",
            "request_id": "identity-1",
        }),
    );
    assert_roundtrip(request);

    let response = ControlResponse::GetLocalIdentity {
        request_id: "identity-1".into(),
        peer_id: "peer-a".into(),
        display_name: "Studio Mac".into(),
        public_key: "base64-key".into(),
        protocol_version: 1,
        accepting_transfers: true,
    };
    assert_eq!(
        serde_json::to_value(&response).unwrap(),
        json!({
            "type": "get_local_identity",
            "request_id": "identity-1",
            "peer_id": "peer-a",
            "display_name": "Studio Mac",
            "public_key": "base64-key",
            "protocol_version": 1,
            "accepting_transfers": true,
        }),
    );
    assert_roundtrip(response);
}

#[test]
fn companion_messages_roundtrip_with_shared_protocol_frames() {
    assert_roundtrip(PeerRequest::ObserveCompanion {
        request_id: "req-observe".into(),
        requester_peer_id: "peer-viewer".into(),
        sealed_payload: "sealed-observe".into(),
    });
    assert_roundtrip(PeerRequest::SendCompanionEvent {
        request_id: "req-event".into(),
        requester_peer_id: "peer-viewer".into(),
        sealed_payload: "sealed-event".into(),
    });
    assert_roundtrip(SidecarEvent::CompanionEvent {
        peer_id: "peer-owner".into(),
        task_id: "task-1".into(),
        generation: "generation-1".into(),
        generation_order: 1,
        frame: ServerFrame::CompanionUnavailable {
            task_id: "task-1".into(),
            attachment_epoch: None,
        },
    });
    assert_roundtrip(PeerCompanionEvent::Sealed {
        sealed_payload: "sealed-frame".into(),
    });
}

#[test]
fn control_messages_roundtrip_with_request_ids() {
    let message = ControlRequest::PrepareTransferPreflight {
        request_id: "req-1".into(),
        source_task_id: "task-source".into(),
        target_peer_id: "peer-target".into(),
        transport: TransferTransport::Cloud,
    };

    let json = serde_json::to_string(&message).unwrap();
    let parsed: ControlRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, message);
}

#[test]
fn authenticated_request_epoch_handshake_roundtrips() {
    assert_roundtrip(PeerRequest::GetAuthenticatedRequestEpoch {
        request_id: "epoch-1".into(),
    });
    assert_roundtrip(PeerResponse::AuthenticatedRequestEpoch {
        request_id: "epoch-1".into(),
        epoch: "restart-random-owner-epoch".into(),
    });
}

#[test]
fn terminal_observer_control_messages_carry_subscription_leases() {
    assert_roundtrip(ControlRequest::ObservePeerSession {
        request_id: "observe-1".into(),
        target_peer_id: "peer-owner".into(),
        session_id: "task-1".into(),
        observer_lease_id: "lease-new".into(),
    });
    assert_roundtrip(ControlRequest::UnobservePeerSession {
        request_id: "unobserve-1".into(),
        target_peer_id: "peer-owner".into(),
        session_id: "task-1".into(),
        observer_lease_id: "lease-new".into(),
    });
    let event = SidecarEvent::TerminalEvent {
        peer_id: "peer-owner".into(),
        session_id: "task-1".into(),
        observer_lease_id: "lease-new".into(),
        event: PeerTerminalEvent::Output {
            session_id: "task-1".into(),
            data: b"hello".to_vec(),
        },
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({
            "type": "terminal_event",
            "peer_id": "peer-owner",
            "session_id": "task-1",
            "observer_lease_id": "lease-new",
            "event": {
                "type": "output",
                "session_id": "task-1",
                "data": [104, 101, 108, 108, 111],
            },
        }),
    );
    assert_roundtrip(event);
}

#[test]
fn task_pull_control_peer_and_event_messages_roundtrip() {
    let control_request = ControlRequest::RequestTaskPull {
        request_id: "control-pull-1".into(),
        target_peer_id: "peer-source".into(),
        source_task_id: "task-source".into(),
        transport: TransferTransport::Cloud,
    };
    assert_eq!(
        serde_json::to_value(&control_request).unwrap(),
        json!({
            "type": "request_task_pull",
            "request_id": "control-pull-1",
            "target_peer_id": "peer-source",
            "source_task_id": "task-source",
            "transport": "cloud",
        })
    );
    assert_roundtrip(control_request);

    assert_roundtrip(ControlResponse::RequestTaskPull {
        request_id: "control-pull-1".into(),
        pull_request_id: "pull-1".into(),
    });

    let peer_request = PeerRequest::RequestTaskPull {
        request_id: "peer-pull-1".into(),
        requester_peer_id: "peer-destination".into(),
        sealed_payload: "sealed-task-id".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_request).unwrap(),
        json!({
            "type": "request_task_pull",
            "request_id": "peer-pull-1",
            "requester_peer_id": "peer-destination",
            "sealed_payload": "sealed-task-id",
        })
    );
    assert_roundtrip(peer_request);

    assert_roundtrip(PeerResponse::RequestTaskPull {
        request_id: "pull-1".into(),
    });

    let event = SidecarEvent::TaskPullRequested {
        request_id: "pull-1".into(),
        requester_peer_id: "peer-destination".into(),
        source_task_id: "task-source".into(),
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({
            "type": "task_pull_requested",
            "request_id": "pull-1",
            "requester_peer_id": "peer-destination",
            "source_task_id": "task-source",
        })
    );
    assert_roundtrip(event);
}

#[test]
fn external_peer_control_messages_roundtrip() {
    let peer = ExternalPeer {
        peer_id: "peer-cloud".into(),
        display_name: "Cloud Mac".into(),
        endpoint: "127.0.0.1:4456".into(),
        public_key: "base64-key".into(),
        protocol_version: 1,
        accepting_transfers: true,
    };
    assert_roundtrip(ControlRequest::UpsertExternalPeer {
        request_id: "external-upsert".into(),
        peer: peer.clone(),
    });
    assert_roundtrip(ControlResponse::UpsertExternalPeer {
        request_id: "external-upsert".into(),
    });
    assert_roundtrip(ControlRequest::RemoveExternalPeer {
        request_id: "external-remove".into(),
        peer_id: peer.peer_id.clone(),
    });
    assert_roundtrip(ControlResponse::RemoveExternalPeer {
        request_id: "external-remove".into(),
    });
    assert_roundtrip(ControlRequest::ClearExternalPeers {
        request_id: "external-clear".into(),
    });
    assert_roundtrip(ControlResponse::ClearExternalPeers {
        request_id: "external-clear".into(),
    });

    assert_eq!(
        serde_json::to_value(ControlRequest::PrepareTransferPreflight {
            request_id: "preflight-cloud".into(),
            source_task_id: "task-source".into(),
            target_peer_id: "peer-cloud".into(),
            transport: TransferTransport::Cloud,
        })
        .unwrap(),
        json!({
            "type": "prepare_transfer_preflight",
            "request_id": "preflight-cloud",
            "source_task_id": "task-source",
            "target_peer_id": "peer-cloud",
            "transport": "cloud",
        })
    );
}

#[test]
fn applied_import_commit_control_messages_roundtrip() {
    assert_roundtrip(ControlRequest::MarkIncomingEventRecorded {
        request_id: "req-event-recorded".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlResponse::MarkIncomingEventRecorded {
        request_id: "req-event-recorded".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlRequest::MarkImportCommitApplied {
        request_id: "req-applied".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlResponse::MarkImportCommitApplied {
        request_id: "req-applied".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlRequest::NackImportCommit {
        request_id: "req-nack".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlResponse::NackImportCommit {
        request_id: "req-nack".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlRequest::MarkImportAckCompleted {
        request_id: "req-ack-completed".into(),
        transfer_id: "transfer-1".into(),
    });
    assert_roundtrip(ControlResponse::MarkImportAckCompleted {
        request_id: "req-ack-completed".into(),
        transfer_id: "transfer-1".into(),
    });
}

#[test]
fn incoming_transfer_event_roundtrips() {
    let event = SidecarEvent::IncomingTransferRequest {
        transfer_id: "transfer-1".into(),
        source_peer_id: "peer-source".into(),
        source_task_id: "task-source".into(),
        source_name: Some("Primary".into()),
        payload: json!({
            "task": {
                "source_task_id": "task-source",
            },
        }),
    };

    let json = serde_json::to_string(&event).unwrap();
    let parsed: SidecarEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, event);
}

#[test]
fn outgoing_transfer_committed_event_roundtrips() {
    let event = SidecarEvent::OutgoingTransferCommitted {
        transfer_id: "transfer-1".into(),
        source_task_id: "task-source".into(),
        destination_local_task_id: "task-dest".into(),
    };

    let json = serde_json::to_string(&event).unwrap();
    let parsed: SidecarEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, event);
}

#[test]
fn pairing_completed_event_roundtrips() {
    let event = SidecarEvent::PairingCompleted {
        peer_id: "peer-1".into(),
        display_name: "Primary".into(),
        verification_code: "123456".into(),
    };

    let json = serde_json::to_string(&event).unwrap();
    let parsed: SidecarEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, event);
}

#[test]
fn control_and_peer_message_roundtrips_with_request_ids() {
    let control_response = ControlResponse::PrepareTransferPreflight {
        request_id: "req-2".into(),
        transfer_id: "transfer-2".into(),
        source_peer_id: "peer-source".into(),
        target_has_repo: true,
    };

    let control_json = serde_json::to_string(&control_response).unwrap();
    let parsed_control: ControlResponse = serde_json::from_str(&control_json).unwrap();
    assert_eq!(parsed_control, control_response);

    let peer_request = PeerRequest::SubmitTransferPayload {
        request_id: "req-3".into(),
        transfer_id: "transfer-3".into(),
        sealed_payload: "sealed-submit".into(),
    };

    let peer_json = serde_json::to_string(&peer_request).unwrap();
    let parsed_peer_request: PeerRequest = serde_json::from_str(&peer_json).unwrap();
    assert_eq!(parsed_peer_request, peer_request);

    let peer_response = PeerResponse::SubmitTransferPayload {
        request_id: "req-4".into(),
        transfer_id: "transfer-4".into(),
    };

    let peer_response_json = serde_json::to_string(&peer_response).unwrap();
    let parsed_peer_response: PeerResponse = serde_json::from_str(&peer_response_json).unwrap();
    assert_eq!(parsed_peer_response, peer_response);
}

#[test]
fn remote_task_advance_messages_use_expected_wire_names() {
    let control_request = ControlRequest::AdvancePeerTaskStage {
        request_id: "req-advance-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
        expected_transition_revision: Some("run-1".into()),
    };
    assert_eq!(
        serde_json::to_value(&control_request).unwrap(),
        json!({
            "type": "advance_peer_task_stage",
            "request_id": "req-advance-control",
            "target_peer_id": "peer-owner",
            "task_id": "task-owner",
            "expected_transition_revision": "run-1",
        })
    );
    assert_roundtrip(control_request);

    assert_roundtrip(ControlResponse::AdvancePeerTaskStage {
        request_id: "req-advance-control".into(),
    });

    let peer_request = PeerRequest::AdvanceTaskStage {
        request_id: "req-advance-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        task_id: "task-owner".into(),
        expected_transition_revision: Some("run-1".into()),
        sealed_payload: None,
    };
    assert_eq!(
        serde_json::to_value(&peer_request).unwrap(),
        json!({
            "type": "advance_task_stage",
            "request_id": "req-advance-peer",
            "requester_peer_id": "peer-secondary",
            "task_id": "task-owner",
            "expected_transition_revision": "run-1",
        })
    );
    assert_roundtrip(peer_request);

    assert_roundtrip(PeerResponse::AdvanceTaskStage {
        request_id: "req-advance-peer".into(),
    });
}

#[test]
fn stage_advance_revision_field_is_backward_compatible() {
    let legacy_control = serde_json::from_value::<ControlRequest>(json!({
        "type": "advance_peer_task_stage",
        "request_id": "req-legacy-control",
        "target_peer_id": "peer-owner",
        "task_id": "task-owner",
    }));
    assert!(
        legacy_control.is_ok(),
        "new sidecar must accept an older control request without a CAS revision: {legacy_control:?}",
    );

    let legacy_peer = serde_json::from_value::<PeerRequest>(json!({
        "type": "advance_task_stage",
        "request_id": "req-legacy-peer",
        "requester_peer_id": "peer-secondary",
        "task_id": "task-owner",
    }));
    assert!(
        legacy_peer.is_ok(),
        "new owner must accept an older peer message without a CAS revision: {legacy_peer:?}",
    );

    let new_control_without_cas = ControlRequest::AdvancePeerTaskStage {
        request_id: "req-new-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
        expected_transition_revision: None,
    };
    assert_eq!(
        serde_json::to_value(new_control_without_cas).unwrap(),
        json!({
            "type": "advance_peer_task_stage",
            "request_id": "req-new-control",
            "target_peer_id": "peer-owner",
            "task_id": "task-owner",
        }),
        "a no-CAS request must retain the legacy wire shape for older sidecars",
    );

    let new_peer_without_cas = PeerRequest::AdvanceTaskStage {
        request_id: "req-new-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        task_id: "task-owner".into(),
        expected_transition_revision: None,
        sealed_payload: None,
    };
    assert_eq!(
        serde_json::to_value(new_peer_without_cas).unwrap(),
        json!({
            "type": "advance_task_stage",
            "request_id": "req-new-peer",
            "requester_peer_id": "peer-secondary",
            "task_id": "task-owner",
        }),
        "a no-CAS peer request must retain the legacy revision shape",
    );
}

#[test]
fn remote_task_file_messages_use_expected_wire_names() {
    let control_request = ControlRequest::ReadPeerTaskFile {
        request_id: "req-read-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
        path: "src/app.ts".into(),
    };
    assert_eq!(
        serde_json::to_value(&control_request).unwrap(),
        json!({
            "type": "read_peer_task_file",
            "request_id": "req-read-control",
            "target_peer_id": "peer-owner",
            "task_id": "task-owner",
            "path": "src/app.ts",
        })
    );
    assert_roundtrip(control_request);

    assert_roundtrip(ControlResponse::ReadPeerTaskFile {
        request_id: "req-read-control".into(),
        path: "src/app.ts".into(),
        content: "remote body".into(),
    });

    let peer_request = PeerRequest::ReadTaskFile {
        request_id: "req-read-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        task_id: "task-owner".into(),
        path: "src/app.ts".into(),
        sealed_payload: Some("sealed-read".into()),
    };
    assert_eq!(
        serde_json::to_value(&peer_request).unwrap(),
        json!({
            "type": "read_task_file",
            "request_id": "req-read-peer",
            "requester_peer_id": "peer-secondary",
            "task_id": "task-owner",
            "path": "src/app.ts",
            "sealed_payload": "sealed-read",
        })
    );
    assert_roundtrip(peer_request);

    assert_roundtrip(PeerResponse::ReadTaskFile {
        request_id: "req-read-peer".into(),
        path: "src/app.ts".into(),
        content: "remote body".into(),
    });
}

#[test]
fn remote_task_directory_and_diff_messages_roundtrip() {
    assert_roundtrip(ControlRequest::ReadPeerTaskDirectory {
        request_id: "req-directory-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
        path: "src".into(),
        show_all_files: true,
        offset: 100,
        limit: 100,
    });
    assert_roundtrip(ControlResponse::ReadPeerTaskDirectory {
        request_id: "req-directory-control".into(),
        listing: json!({ "path": "src", "entries": [] }),
    });
    assert_roundtrip(PeerRequest::ReadTaskDirectory {
        request_id: "req-directory-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        task_id: "task-owner".into(),
        path: "src".into(),
        show_all_files: true,
        offset: 100,
        limit: 100,
        sealed_payload: Some("sealed-directory".into()),
    });
    assert_roundtrip(PeerResponse::ReadTaskDirectory {
        request_id: "req-directory-peer".into(),
        listing: json!({ "path": "src", "entries": [] }),
    });

    assert_roundtrip(ControlRequest::ReadPeerTaskDiff {
        request_id: "req-diff-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
        scope: "branch".into(),
        mode: "all".into(),
    });
    assert_roundtrip(ControlResponse::ReadPeerTaskDiff {
        request_id: "req-diff-control".into(),
        diff: json!({ "patch": "diff", "truncated": true }),
    });
    assert_roundtrip(PeerRequest::ReadTaskDiff {
        request_id: "req-diff-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        task_id: "task-owner".into(),
        scope: "branch".into(),
        mode: "all".into(),
        sealed_payload: Some("sealed-diff".into()),
    });
    assert_roundtrip(PeerResponse::ReadTaskDiff {
        request_id: "req-diff-peer".into(),
        diff: json!({ "patch": "diff", "truncated": true }),
    });
}

#[test]
fn remote_task_mark_read_messages_use_expected_wire_names() {
    let control_request = ControlRequest::MarkPeerTaskRead {
        request_id: "req-mark-read-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
        expected_activity_revision: 7,
    };
    assert_eq!(
        serde_json::to_value(&control_request).unwrap(),
        json!({
            "type": "mark_peer_task_read",
            "request_id": "req-mark-read-control",
            "target_peer_id": "peer-owner",
            "task_id": "task-owner",
            "expected_activity_revision": 7,
        })
    );
    assert_roundtrip(control_request);

    assert_roundtrip(ControlResponse::MarkPeerTaskRead {
        request_id: "req-mark-read-control".into(),
    });

    let peer_request = PeerRequest::MarkTaskRead {
        request_id: "req-mark-read-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        sealed_payload: "sealed-task-and-cutoff".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_request).unwrap(),
        json!({
            "type": "mark_task_read",
            "request_id": "req-mark-read-peer",
            "requester_peer_id": "peer-secondary",
            "sealed_payload": "sealed-task-and-cutoff",
        })
    );
    assert_roundtrip(peer_request);

    assert_roundtrip(PeerResponse::MarkTaskRead {
        request_id: "req-mark-read-peer".into(),
    });
}

#[test]
fn transfer_artifact_control_messages_roundtrip() {
    assert_roundtrip(ControlRequest::StageTransferArtifact {
        request_id: "req-stage".into(),
        transfer_id: "transfer-1".into(),
        artifact_id: "artifact-1".into(),
        path: "/tmp/transfer-1.bundle".into(),
        owned: true,
    });

    assert_roundtrip(ControlRequest::FetchTransferArtifact {
        request_id: "req-fetch".into(),
        transfer_id: "transfer-1".into(),
        artifact_id: "artifact-1".into(),
    });

    assert_roundtrip(ControlResponse::StageTransferArtifact {
        request_id: "req-stage".into(),
        transfer_id: "transfer-1".into(),
        artifact_id: "artifact-1".into(),
    });

    assert_roundtrip(ControlResponse::FetchTransferArtifact {
        request_id: "req-fetch".into(),
        transfer_id: "transfer-1".into(),
        artifact_id: "artifact-1".into(),
        path: "/tmp/transfer-1.bundle".into(),
    });

    assert_roundtrip(PeerRequest::FetchTransferArtifact {
        request_id: "req-peer-fetch".into(),
        transfer_id: "transfer-1".into(),
        requester_peer_id: "peer-destination".into(),
        sealed_payload: "sealed-fetch".into(),
    });

    assert_roundtrip(PeerResponse::FetchTransferArtifact {
        request_id: "req-peer-fetch".into(),
        transfer_id: "transfer-1".into(),
        sealed_payload: "sealed-response".into(),
        stream_header: Some(kanna_task_transfer::crypto::SealedStreamHeader {
            version: 1,
            ephemeral_public_key: "ephemeral-key".into(),
            nonce_prefix_b64: "nonce-prefix".into(),
        }),
    });

    assert_roundtrip(ControlRequest::FinalizeOutgoingTransfer {
        request_id: "req-finalize".into(),
        transfer_id: "transfer-1".into(),
    });

    assert_roundtrip(ControlRequest::CompleteOutgoingTransferFinalization {
        request_id: "req-complete-finalize".into(),
        transfer_id: "transfer-1".into(),
        payload: Some(json!({
            "task": {
                "source_task_id": "task-source",
            },
        })),
        finalized_cleanly: true,
        error: None,
    });

    assert_roundtrip(ControlResponse::FinalizeOutgoingTransfer {
        request_id: "req-finalize".into(),
        transfer_id: "transfer-1".into(),
        payload: json!({
            "task": {
                "source_task_id": "task-source",
            },
        }),
        finalized_cleanly: false,
    });

    assert_roundtrip(ControlResponse::CompleteOutgoingTransferFinalization {
        request_id: "req-complete-finalize".into(),
        transfer_id: "transfer-1".into(),
    });

    assert_roundtrip(PeerRequest::FinalizeTransfer {
        request_id: "req-peer-finalize".into(),
        transfer_id: "transfer-1".into(),
        requester_peer_id: "peer-destination".into(),
        sealed_payload: "sealed-finalize-request".into(),
    });

    assert_roundtrip(PeerResponse::FinalizeTransfer {
        request_id: "req-peer-finalize".into(),
        transfer_id: "transfer-1".into(),
        sealed_payload: "sealed-finalize".into(),
    });

    assert_roundtrip(SidecarEvent::OutgoingTransferFinalizationRequested {
        transfer_id: "transfer-1".into(),
    });
}

#[test]
fn wire_messages_use_expected_json_shapes() {
    let request = ControlRequest::PrepareTransferPreflight {
        request_id: "req-1".into(),
        source_task_id: "task-source".into(),
        target_peer_id: "peer-target".into(),
        transport: TransferTransport::Auto,
    };
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({
            "type": "prepare_transfer_preflight",
            "request_id": "req-1",
            "source_task_id": "task-source",
            "target_peer_id": "peer-target",
            "transport": "auto",
        })
    );

    let response = ControlResponse::PrepareTransferPreflight {
        request_id: "req-2".into(),
        transfer_id: "transfer-2".into(),
        source_peer_id: "peer-source".into(),
        target_has_repo: false,
    };
    assert_eq!(
        serde_json::to_value(&response).unwrap(),
        json!({
            "type": "prepare_transfer_preflight",
            "request_id": "req-2",
            "transfer_id": "transfer-2",
            "source_peer_id": "peer-source",
            "target_has_repo": false,
        })
    );

    let peer_request = PeerRequest::SubmitTransferPayload {
        request_id: "req-3".into(),
        transfer_id: "transfer-3".into(),
        sealed_payload: "sealed-submit".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_request).unwrap(),
        json!({
            "type": "submit_transfer_payload",
            "request_id": "req-3",
            "transfer_id": "transfer-3",
            "sealed_payload": "sealed-submit",
        })
    );

    let peer_response = PeerResponse::SubmitTransferPayload {
        request_id: "req-4".into(),
        transfer_id: "transfer-4".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_response).unwrap(),
        json!({
            "type": "submit_transfer_payload",
            "request_id": "req-4",
            "transfer_id": "transfer-4",
        })
    );

    let event = SidecarEvent::IncomingTransferRequest {
        transfer_id: "transfer-1".into(),
        source_peer_id: "peer-source".into(),
        source_task_id: "task-source".into(),
        source_name: Some("Primary".into()),
        payload: json!({
            "task": {
                "source_task_id": "task-source",
            },
        }),
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({
            "type": "incoming_transfer_request",
            "transfer_id": "transfer-1",
            "source_peer_id": "peer-source",
            "source_task_id": "task-source",
            "source_name": "Primary",
            "payload": {
                "task": {
                    "source_task_id": "task-source",
                },
            },
        })
    );
}

#[test]
fn remaining_protocol_variants_use_expected_json_shapes() {
    let list_peers_request = ControlRequest::ListPeers {
        request_id: "req-5".into(),
    };
    assert_eq!(
        serde_json::to_value(&list_peers_request).unwrap(),
        json!({
            "type": "list_peers",
            "request_id": "req-5",
        })
    );

    let commit_request = ControlRequest::PrepareTransferCommit {
        request_id: "req-6".into(),
        transfer_id: "transfer-6".into(),
        payload: json!({ "target_peer_id": "peer-target" }),
    };
    assert_eq!(
        serde_json::to_value(&commit_request).unwrap(),
        json!({
            "type": "prepare_transfer_commit",
            "request_id": "req-6",
            "transfer_id": "transfer-6",
            "payload": { "target_peer_id": "peer-target" },
        })
    );

    let list_peers_response = ControlResponse::ListPeers {
        request_id: "req-7".into(),
        peers: vec![kanna_task_transfer::protocol::DiscoveredPeer {
            peer_id: "peer-a".into(),
            display_name: "Alpha".into(),
            endpoint: "127.0.0.1:4455".into(),
            pid: 1234,
            public_key: "pub-a".into(),
            protocol_version: 1,
            accepting_transfers: true,
            trusted: true,
        }],
    };
    assert_eq!(
        serde_json::to_value(&list_peers_response).unwrap(),
        json!({
            "type": "list_peers",
            "request_id": "req-7",
            "peers": [{
                "peer_id": "peer-a",
                "display_name": "Alpha",
                "endpoint": "127.0.0.1:4455",
                "pid": 1234,
                "public_key": "pub-a",
                "protocol_version": 1,
                "accepting_transfers": true,
                "trusted": true,
            }],
        })
    );

    let pairing_response = ControlResponse::StartPairing {
        request_id: "req-7b".into(),
        peer: kanna_task_transfer::protocol::DiscoveredPeer {
            peer_id: "peer-b".into(),
            display_name: "Beta".into(),
            endpoint: "127.0.0.1:4456".into(),
            pid: 5678,
            public_key: "pub-b".into(),
            protocol_version: 1,
            accepting_transfers: true,
            trusted: true,
        },
        verification_code: "123456".into(),
    };
    assert_eq!(
        serde_json::to_value(&pairing_response).unwrap(),
        json!({
            "type": "start_pairing",
            "request_id": "req-7b",
            "peer": {
                "peer_id": "peer-b",
                "display_name": "Beta",
                "endpoint": "127.0.0.1:4456",
                "pid": 5678,
                "public_key": "pub-b",
                "protocol_version": 1,
                "accepting_transfers": true,
                "trusted": true,
            },
            "verification_code": "123456",
        })
    );

    let commit_response = ControlResponse::PrepareTransferCommit {
        request_id: "req-8".into(),
        transfer_id: "transfer-8".into(),
    };
    assert_eq!(
        serde_json::to_value(&commit_response).unwrap(),
        json!({
            "type": "prepare_transfer_commit",
            "request_id": "req-8",
            "transfer_id": "transfer-8",
        })
    );

    let control_error = ControlResponse::Error {
        request_id: "req-9".into(),
        message: "boom".into(),
    };
    assert_eq!(
        serde_json::to_value(&control_error).unwrap(),
        json!({
            "type": "error",
            "request_id": "req-9",
            "message": "boom",
        })
    );

    let peer_prepare = PeerRequest::PrepareTransfer {
        request_id: "req-10".into(),
        source_peer_id: "peer-source".into(),
        sealed_payload: "sealed-prepare".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_prepare).unwrap(),
        json!({
            "type": "prepare_transfer",
            "request_id": "req-10",
            "source_peer_id": "peer-source",
            "sealed_payload": "sealed-prepare",
        })
    );

    let peer_prepare_response = PeerResponse::PrepareTransfer {
        request_id: "req-11".into(),
        transfer_id: "transfer-11".into(),
        source_peer_id: "peer-source".into(),
        target_has_repo: true,
    };
    assert_eq!(
        serde_json::to_value(&peer_prepare_response).unwrap(),
        json!({
            "type": "prepare_transfer",
            "request_id": "req-11",
            "transfer_id": "transfer-11",
            "source_peer_id": "peer-source",
            "target_has_repo": true,
        })
    );

    let peer_ack = PeerRequest::ImportCommitted {
        request_id: "req-12".into(),
        transfer_id: "transfer-12".into(),
        requester_peer_id: "peer-destination".into(),
        sealed_payload: "sealed-ack".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_ack).unwrap(),
        json!({
            "type": "import_committed",
            "request_id": "req-12",
            "transfer_id": "transfer-12",
            "requester_peer_id": "peer-destination",
            "sealed_payload": "sealed-ack",
        })
    );

    let peer_fetch_artifact = PeerRequest::FetchTransferArtifact {
        request_id: "req-13".into(),
        transfer_id: "transfer-13".into(),
        requester_peer_id: "peer-destination".into(),
        sealed_payload: "sealed-fetch".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_fetch_artifact).unwrap(),
        json!({
            "type": "fetch_transfer_artifact",
            "request_id": "req-13",
            "transfer_id": "transfer-13",
            "requester_peer_id": "peer-destination",
            "sealed_payload": "sealed-fetch",
        })
    );

    let outgoing_event = SidecarEvent::OutgoingTransferCommitted {
        transfer_id: "transfer-13".into(),
        source_task_id: "task-source".into(),
        destination_local_task_id: "task-dest".into(),
    };
    assert_eq!(
        serde_json::to_value(&outgoing_event).unwrap(),
        json!({
            "type": "outgoing_transfer_committed",
            "transfer_id": "transfer-13",
            "source_task_id": "task-source",
            "destination_local_task_id": "task-dest",
        })
    );

    let pairing_event = SidecarEvent::PairingCompleted {
        peer_id: "peer-b".into(),
        display_name: "Beta".into(),
        verification_code: "123456".into(),
    };
    assert_eq!(
        serde_json::to_value(&pairing_event).unwrap(),
        json!({
            "type": "pairing_completed",
            "peer_id": "peer-b",
            "display_name": "Beta",
            "verification_code": "123456",
        })
    );

    let peer_fetch_artifact_response = PeerResponse::FetchTransferArtifact {
        request_id: "req-14".into(),
        transfer_id: "transfer-13".into(),
        sealed_payload: "sealed-response".into(),
        stream_header: Some(kanna_task_transfer::crypto::SealedStreamHeader {
            version: 1,
            ephemeral_public_key: "ephemeral-key".into(),
            nonce_prefix_b64: "nonce-prefix".into(),
        }),
    };
    assert_eq!(
        serde_json::to_value(&peer_fetch_artifact_response).unwrap(),
        json!({
            "type": "fetch_transfer_artifact",
            "request_id": "req-14",
            "transfer_id": "transfer-13",
            "sealed_payload": "sealed-response",
            "stream_header": {
                "version": 1,
                "ephemeral_public_key": "ephemeral-key",
                "nonce_prefix_b64": "nonce-prefix",
            },
        })
    );

    let peer_error = PeerResponse::Error {
        request_id: "req-15".into(),
        message: "down".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_error).unwrap(),
        json!({
            "type": "error",
            "request_id": "req-15",
            "message": "down",
        })
    );

    let stage_artifact_request = ControlRequest::StageTransferArtifact {
        request_id: "req-13".into(),
        transfer_id: "transfer-13".into(),
        artifact_id: "artifact-13".into(),
        path: "/tmp/transfer-13.bundle".into(),
        owned: true,
    };
    assert_eq!(
        serde_json::to_value(&stage_artifact_request).unwrap(),
        json!({
            "type": "stage_transfer_artifact",
            "request_id": "req-13",
            "transfer_id": "transfer-13",
            "artifact_id": "artifact-13",
            "path": "/tmp/transfer-13.bundle",
            "owned": true,
        })
    );

    let fetch_artifact_request = ControlRequest::FetchTransferArtifact {
        request_id: "req-14".into(),
        transfer_id: "transfer-13".into(),
        artifact_id: "artifact-13".into(),
    };
    assert_eq!(
        serde_json::to_value(&fetch_artifact_request).unwrap(),
        json!({
            "type": "fetch_transfer_artifact",
            "request_id": "req-14",
            "transfer_id": "transfer-13",
            "artifact_id": "artifact-13",
        })
    );

    let stage_artifact_response = ControlResponse::StageTransferArtifact {
        request_id: "req-15".into(),
        transfer_id: "transfer-13".into(),
        artifact_id: "artifact-13".into(),
    };
    assert_eq!(
        serde_json::to_value(&stage_artifact_response).unwrap(),
        json!({
            "type": "stage_transfer_artifact",
            "request_id": "req-15",
            "transfer_id": "transfer-13",
            "artifact_id": "artifact-13",
        })
    );

    let fetch_artifact_response = ControlResponse::FetchTransferArtifact {
        request_id: "req-16".into(),
        transfer_id: "transfer-13".into(),
        artifact_id: "artifact-13".into(),
        path: "/tmp/transfer-13.bundle".into(),
    };
    assert_eq!(
        serde_json::to_value(&fetch_artifact_response).unwrap(),
        json!({
            "type": "fetch_transfer_artifact",
            "request_id": "req-16",
            "transfer_id": "transfer-13",
            "artifact_id": "artifact-13",
            "path": "/tmp/transfer-13.bundle",
        })
    );
}

#[test]
fn legacy_wire_message_variants_use_expected_json_shapes() {
    use kanna_task_transfer::protocol::WireMessage;

    assert_eq!(
        serde_json::to_value(&WireMessage::ListPeers).unwrap(),
        json!({
            "type": "list_peers",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::PairingRequest {
            peer_id: "peer-a".into(),
            display_name: "Alpha".into(),
        })
        .unwrap(),
        json!({
            "type": "pairing_request",
            "peer_id": "peer-a",
            "display_name": "Alpha",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::PairingAccept {
            peer_id: "peer-a".into(),
            code: "code-1".into(),
            public_key: "pubkey".into(),
        })
        .unwrap(),
        json!({
            "type": "pairing_accept",
            "peer_id": "peer-a",
            "code": "code-1",
            "public_key": "pubkey",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::PrepareTransfer {
            transfer_id: "transfer-a".into(),
            task_id: "task-a".into(),
            provider: "claude".into(),
        })
        .unwrap(),
        json!({
            "type": "prepare_transfer",
            "transfer_id": "transfer-a",
            "task_id": "task-a",
            "provider": "claude",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::PrepareTransferOk {
            transfer_id: "transfer-a".into(),
            ready_token: "ready".into(),
        })
        .unwrap(),
        json!({
            "type": "prepare_transfer_ok",
            "transfer_id": "transfer-a",
            "ready_token": "ready",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::TransferChunk {
            transfer_id: "transfer-a".into(),
            seq: 7,
            payload_b64: "YWJj".into(),
        })
        .unwrap(),
        json!({
            "type": "transfer_chunk",
            "transfer_id": "transfer-a",
            "seq": 7,
            "payload_b64": "YWJj",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::TransferCommit {
            transfer_id: "transfer-a".into(),
        })
        .unwrap(),
        json!({
            "type": "transfer_commit",
            "transfer_id": "transfer-a",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::TransferAck {
            transfer_id: "transfer-a".into(),
        })
        .unwrap(),
        json!({
            "type": "transfer_ack",
            "transfer_id": "transfer-a",
        })
    );
    assert_eq!(
        serde_json::to_value(&WireMessage::Error {
            message: "boom".into(),
        })
        .unwrap(),
        json!({
            "type": "error",
            "message": "boom",
        })
    );
}
