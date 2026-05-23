use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kanna_task_transfer::crypto::{public_key_to_string, TransferIdentity};
use kanna_task_transfer::peer_store::{PeerRecord, PeerStore};
use kanna_task_transfer::registry::{PeerRegistry, PeerRegistryEntry};
use kanna_task_transfer::runtime::{
    DiscoveryMode, PairingResult, RuntimeConfig, RuntimeEvent, TransferRuntime,
};
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peers_become_trusted_after_explicit_pairing() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let peers_before = primary.list_peers().await.unwrap();
    assert_eq!(peers_before.len(), 1);
    assert_eq!(peers_before[0].peer_id, "peer-secondary");
    assert!(!peers_before[0].trusted);

    let paired = pair_peers(&primary, &secondary, "peer-secondary").await;
    assert_eq!(paired.peer.peer_id, "peer-secondary");
    assert!(paired.peer.trusted);
    assert!(!paired.peer.public_key.is_empty());
    assert_eq!(paired.verification_code.len(), 6);

    let peers_after = primary.list_peers().await.unwrap();
    assert_eq!(peers_after.len(), 1);
    assert_eq!(peers_after[0].peer_id, "peer-secondary");
    assert!(peers_after[0].trusted);

    let pairing_event = secondary.next_event().await.unwrap();
    let RuntimeEvent::PairingCompleted(pairing_event) = pairing_event else {
        panic!("expected pairing completed event");
    };
    assert_eq!(pairing_event.peer_id, "peer-primary");
    assert_eq!(pairing_event.display_name, "Primary");
    assert_eq!(pairing_event.verification_code, paired.verification_code);

    let secondary_peers = secondary.list_peers().await.unwrap();
    assert_eq!(secondary_peers.len(), 1);
    assert_eq!(secondary_peers[0].peer_id, "peer-primary");
    assert!(secondary_peers[0].trusted);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_pairing_waits_for_target_acceptance_before_trusting() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let mut pairing = tokio::spawn(async move { primary.start_pairing("peer-secondary").await });

    let pairing_event = secondary.next_event().await.unwrap();
    let RuntimeEvent::PairingRequested(pairing_request) = pairing_event else {
        panic!("expected pairing request event");
    };
    assert_eq!(pairing_request.peer_id, "peer-primary");
    assert_eq!(pairing_request.display_name, "Primary");
    assert_eq!(pairing_request.verification_code.len(), 6);

    let secondary_peers_before_accept = secondary.list_peers().await.unwrap();
    assert_eq!(secondary_peers_before_accept.len(), 1);
    assert_eq!(secondary_peers_before_accept[0].peer_id, "peer-primary");
    assert!(!secondary_peers_before_accept[0].trusted);

    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut pairing)
            .await
            .is_err(),
        "start_pairing completed before the target accepted"
    );

    secondary
        .accept_pairing(
            &pairing_request.request_id,
            &pairing_request.verification_code,
        )
        .await
        .unwrap();

    let paired = pairing.await.unwrap().unwrap();
    assert_eq!(paired.peer.peer_id, "peer-secondary");
    assert!(paired.peer.trusted);

    let pairing_completed = secondary.next_event().await.unwrap();
    let RuntimeEvent::PairingCompleted(pairing_completed) = pairing_completed else {
        panic!("expected pairing completed event");
    };
    assert_eq!(pairing_completed.peer_id, "peer-primary");
    assert_eq!(
        pairing_completed.verification_code,
        pairing_request.verification_code
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_pairing_times_out_when_peer_accepts_without_replying() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: public_key_to_string(&target_identity.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();

    let primary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(50)),
    )
    .await
    .unwrap();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"start_pairing\""));
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    let error = primary.start_pairing("peer-target").await.unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("peer request to peer-target timed out"),
        "unexpected error: {message}",
    );

    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mdns_peers_can_discover_pair_and_transfer() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary-mdns", "Secondary", temp.path(), 0)
            .with_discovery_mode(DiscoveryMode::Mdns),
    )
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary-mdns", "Primary", temp.path(), 0)
            .with_discovery_mode(DiscoveryMode::Mdns),
    )
    .await
    .unwrap();

    let discovered = wait_for_peer(&primary, "peer-secondary-mdns").await;
    assert!(!discovered.endpoint.is_empty());
    wait_for_peer(&secondary, "peer-primary-mdns").await;

    pair_peers(&primary, &secondary, "peer-secondary-mdns").await;

    let preflight = primary
        .prepare_transfer_preflight("peer-secondary-mdns", "task-source")
        .await
        .unwrap();
    assert_eq!(preflight.source_peer_id, "peer-primary-mdns");

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary-mdns",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let event = next_incoming_transfer_request(&secondary).await;
    assert_eq!(event.source_peer_id, "peer-primary-mdns");
    assert_eq!(event.source_task_id, "task-source");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn primary_runtime_can_send_a_real_incoming_transfer_to_secondary() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let peers = primary.list_peers().await.unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].peer_id, "peer-secondary");
    assert_ne!(peers[0].endpoint, "127.0.0.1:0");

    pair_peers(&primary, &secondary, "peer-secondary").await;

    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();
    assert_eq!(preflight.source_peer_id, "peer-primary");
    assert!(!preflight.target_has_repo);

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let event = next_incoming_transfer_request(&secondary).await;
    assert_eq!(event.transfer_id, preflight.transfer_id);
    assert_eq!(event.source_peer_id, "peer-primary");
    assert_eq!(event.source_task_id, "task-source");
    assert_eq!(event.source_name.as_deref(), Some("Primary"));
    assert_eq!(
        event.payload,
        json!({
            "target_peer_id": "peer-secondary",
            "task": {
                "source_task_id": "task-source"
            }
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpaired_peers_cannot_start_transfer_preflight() {
    let temp = tempfile::tempdir().unwrap();

    let _secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let error = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("not trusted"),
        "unexpected error: {message}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_must_also_trust_the_source_peer() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let secondary_peer = primary
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-secondary")
        .unwrap();
    let primary_peer = secondary
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-primary")
        .unwrap();

    let primary_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    primary_store
        .upsert(PeerRecord {
            peer_id: secondary_peer.peer_id,
            display_name: secondary_peer.display_name,
            public_key: secondary_peer.public_key,
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let error = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("not trusted"),
        "unexpected error: {}",
        message
    );

    let secondary_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-secondary"));
    secondary_store
        .upsert(PeerRecord {
            peer_id: primary_peer.peer_id,
            display_name: primary_peer.display_name,
            public_key: primary_peer.public_key,
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();
    assert_eq!(preflight.source_peer_id, "peer-primary");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commit_ack_stays_responsive_when_secondary_events_are_not_drained() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    for transfer_index in 0..40 {
        if transfer_index == 0 {
            pair_peers(&primary, &secondary, "peer-secondary").await;
        }
        let preflight = primary
            .prepare_transfer_preflight("peer-secondary", &format!("task-{transfer_index}"))
            .await
            .unwrap();

        let commit = primary.prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary",
                "task": {
                    "source_task_id": format!("task-{transfer_index}")
                }
            }),
        );

        tokio::time::timeout(Duration::from_millis(200), commit)
            .await
            .expect("commit ack should not block on event backpressure")
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_preflight_commit_is_rejected_and_emits_no_incoming_event() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
            .with_pending_transfer_ttl(Duration::from_millis(25)),
    )
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_pending_transfer_ttl(Duration::from_millis(25)),
    )
    .await
    .unwrap();

    pair_peers(&primary, &secondary, "peer-secondary").await;

    let first = primary
        .prepare_transfer_preflight("peer-secondary", "task-stale")
        .await
        .unwrap();
    assert!(!first.transfer_id.is_empty());

    tokio::time::sleep(Duration::from_millis(40)).await;

    let commit_error = primary
        .prepare_transfer_commit(
            &first.transfer_id,
            json!({
                "target_peer_id": "peer-secondary",
                "task": {
                    "source_task_id": "task-stale"
                }
            }),
        )
        .await
        .unwrap_err();
    assert!(commit_error.to_string().contains("missing target peer"));

    consume_pairing_completed(&secondary).await;
    tokio::time::timeout(Duration::from_millis(100), secondary.next_event())
        .await
        .expect_err("expired commits must not emit incoming events");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_can_acknowledge_import_commit_back_to_source() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&primary, &secondary, "peer-secondary").await;

    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let _incoming = next_incoming_transfer_request(&secondary).await;

    secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();

    let ack = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(ack.transfer_id, preflight.transfer_id);
    assert_eq!(ack.source_task_id, "task-source");
    assert_eq!(ack.destination_local_task_id, "task-dest");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_can_finalize_outgoing_transfer_after_approval() {
    let temp = tempfile::tempdir().unwrap();

    let secondary = std::sync::Arc::new(
        TransferRuntime::spawn(RuntimeConfig::for_tests(
            "peer-secondary",
            "Secondary",
            temp.path(),
            0,
        ))
        .await
        .unwrap(),
    );

    let primary = std::sync::Arc::new(
        TransferRuntime::spawn(RuntimeConfig::for_tests(
            "peer-primary",
            "Primary",
            temp.path(),
            0,
        ))
        .await
        .unwrap(),
    );

    pair_peers(&primary, &secondary, "peer-secondary").await;

    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let _incoming = next_incoming_transfer_request(&secondary).await;

    let primary_for_completion = std::sync::Arc::clone(&primary);
    let transfer_id = preflight.transfer_id.clone();
    let completion = tokio::spawn(async move {
        let event = primary_for_completion.next_event().await.unwrap();
        let RuntimeEvent::OutgoingTransferFinalizationRequested(event) = event else {
            panic!("expected outgoing transfer finalization request");
        };
        assert_eq!(event.transfer_id, transfer_id);

        primary_for_completion
            .complete_outgoing_transfer_finalization(
                &event.transfer_id,
                Ok(kanna_task_transfer::runtime::FinalizedOutgoingTransfer {
                    payload: json!({
                        "task": {
                            "source_task_id": "task-source",
                            "resume_session_id": "019d-final",
                        }
                    }),
                    finalized_cleanly: true,
                }),
            )
            .await
            .unwrap();
    });

    let finalized = secondary
        .finalize_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap();

    completion.await.unwrap();
    assert_eq!(
        finalized.payload["task"]["resume_session_id"],
        json!("019d-final")
    );
    assert!(finalized.finalized_cleanly);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staged_transfer_artifacts_can_be_fetched_by_transfer_and_artifact_id() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let bundle_path = temp.path().join("transfer-1.bundle");
    std::fs::write(&bundle_path, b"bundle").unwrap();

    runtime
        .stage_transfer_artifact("transfer-1", "artifact-1", bundle_path.clone())
        .await
        .unwrap();

    let fetched = runtime
        .fetch_transfer_artifact("transfer-1", "artifact-1")
        .await
        .unwrap();

    assert_eq!(fetched.path, bundle_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_fetches_staged_transfer_artifacts_from_the_source_peer() {
    let temp = tempfile::tempdir().unwrap();

    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&source, &destination, "peer-destination").await;

    let bundle_path = temp.path().join("source.bundle");
    let bundle_bytes = b"bundle-contents";
    std::fs::write(&bundle_path, bundle_bytes).unwrap();

    let preflight = source
        .prepare_transfer_preflight("peer-destination", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-remote",
            bundle_path.clone(),
        )
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let event = next_incoming_transfer_request(&destination).await;
    assert_eq!(event.transfer_id, preflight.transfer_id);

    let fetched = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-remote")
        .await
        .unwrap();

    assert_ne!(fetched.path, bundle_path);
    assert_eq!(std::fs::read(&fetched.path).unwrap(), bundle_bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepare_transfer_preflight_does_not_leak_source_task_id_on_the_wire() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let registry = PeerRegistry::new(temp.path().to_path_buf());
    registry
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: public_key_to_string(&target_identity.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();

    let trust_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    trust_store
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: public_key_to_string(&target_identity.public_key),
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let (line_tx, line_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        line_tx.send(line.clone()).unwrap();
        let request_id = serde_json::from_str::<serde_json::Value>(line.trim())
            .unwrap()
            .get("request_id")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_string();
        let response = json!({
            "type": "prepare_transfer",
            "request_id": request_id,
            "transfer_id": "transfer-1",
            "source_peer_id": "peer-primary",
            "target_has_repo": false,
        });
        writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
    });

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    primary
        .prepare_transfer_preflight("peer-target", "task-secret")
        .await
        .unwrap();

    let captured = line_rx.await.unwrap();
    assert!(
        !captured.contains("task-secret"),
        "captured request leaked source task id: {captured}"
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepare_transfer_commit_does_not_leak_payload_on_the_wire() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let registry = PeerRegistry::new(temp.path().to_path_buf());
    registry
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: public_key_to_string(&target_identity.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();

    let trust_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    trust_store
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: public_key_to_string(&target_identity.public_key),
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let (commit_line_tx, commit_line_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (preflight_stream, _) = listener.accept().await.unwrap();
        let (preflight_reader, mut preflight_writer) = preflight_stream.into_split();
        let mut preflight_reader = BufReader::new(preflight_reader);
        let mut preflight_line = String::new();
        preflight_reader
            .read_line(&mut preflight_line)
            .await
            .unwrap();
        let preflight_request_id = serde_json::from_str::<serde_json::Value>(preflight_line.trim())
            .unwrap()
            .get("request_id")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_string();
        let preflight_response = json!({
            "type": "prepare_transfer",
            "request_id": preflight_request_id,
            "transfer_id": "transfer-1",
            "source_peer_id": "peer-primary",
            "target_has_repo": false,
        });
        preflight_writer
            .write_all(format!("{preflight_response}\n").as_bytes())
            .await
            .unwrap();

        let (commit_stream, _) = listener.accept().await.unwrap();
        let (commit_reader, mut commit_writer) = commit_stream.into_split();
        let mut commit_reader = BufReader::new(commit_reader);
        let mut commit_line = String::new();
        commit_reader.read_line(&mut commit_line).await.unwrap();
        commit_line_tx.send(commit_line.clone()).unwrap();
        let commit_request_id = serde_json::from_str::<serde_json::Value>(commit_line.trim())
            .unwrap()
            .get("request_id")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_string();
        let commit_response = json!({
            "type": "submit_transfer_payload",
            "request_id": commit_request_id,
            "transfer_id": "transfer-1",
        });
        commit_writer
            .write_all(format!("{commit_response}\n").as_bytes())
            .await
            .unwrap();
    });

    let primary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let preflight = primary
        .prepare_transfer_preflight("peer-target", "task-source")
        .await
        .unwrap();
    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "task": {
                    "source_task_id": "task-secret",
                },
            }),
        )
        .await
        .unwrap();

    let captured = commit_line_rx.await.unwrap();
    assert!(
        !captured.contains("task-secret"),
        "captured request leaked commit payload: {captured}"
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_transfer_artifact_does_not_leak_artifact_bytes_on_the_wire() {
    let temp = tempfile::tempdir().unwrap();

    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&source, &destination, "peer-destination").await;

    let bundle_path = temp.path().join("source.bundle");
    let bundle_bytes = b"bundle-contents";
    std::fs::write(&bundle_path, bundle_bytes).unwrap();

    let preflight = source
        .prepare_transfer_preflight("peer-destination", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-remote",
            bundle_path.clone(),
        )
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let _incoming = next_incoming_transfer_request(&destination).await;

    let source_peer = destination
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-source")
        .unwrap();
    let real_endpoint = source_peer.endpoint.clone();
    let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{proxy_port}"),
            pid: std::process::id(),
            public_key: source_peer.public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();

    let (captured_tx, captured_rx) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (client_stream, _) = proxy_listener.accept().await.unwrap();
        let upstream = TcpStream::connect(real_endpoint).await.unwrap();
        let (client_reader, mut client_writer) = client_stream.into_split();
        let (upstream_reader, mut upstream_writer) = upstream.into_split();

        let mut client_reader = BufReader::new(client_reader);
        let mut request_line = String::new();
        client_reader.read_line(&mut request_line).await.unwrap();
        upstream_writer
            .write_all(request_line.as_bytes())
            .await
            .unwrap();

        let mut upstream_reader = BufReader::new(upstream_reader);
        let mut response_line = String::new();
        upstream_reader.read_line(&mut response_line).await.unwrap();
        captured_tx.send(response_line.clone()).unwrap();
        client_writer
            .write_all(response_line.as_bytes())
            .await
            .unwrap();
    });

    let fetched = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-remote")
        .await
        .unwrap();

    let captured = captured_rx.await.unwrap();
    assert!(
        !captured.contains("bundle-contents") && !captured.contains("YnVuZGxlLWNvbnRlbnRz"),
        "captured response leaked artifact bytes: {captured}"
    );
    let fetched_bytes = std::fs::read(fetched.path).unwrap();
    assert_eq!(fetched_bytes, bundle_bytes);
    proxy.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acknowledge_import_committed_does_not_leak_task_ids_on_the_wire() {
    let temp = tempfile::tempdir().unwrap();

    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&source, &destination, "peer-destination").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination", "task-source")
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let _incoming = next_incoming_transfer_request(&destination).await;

    let source_peer = destination
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-source")
        .unwrap();
    let real_endpoint = source_peer.endpoint.clone();
    let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{proxy_port}"),
            pid: std::process::id(),
            public_key: source_peer.public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();

    let (captured_tx, captured_rx) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (client_stream, _) = proxy_listener.accept().await.unwrap();
        let upstream = TcpStream::connect(real_endpoint).await.unwrap();
        let (client_reader, mut client_writer) = client_stream.into_split();
        let (upstream_reader, mut upstream_writer) = upstream.into_split();

        let mut client_reader = BufReader::new(client_reader);
        let mut request_line = String::new();
        client_reader.read_line(&mut request_line).await.unwrap();
        captured_tx.send(request_line.clone()).unwrap();
        upstream_writer
            .write_all(request_line.as_bytes())
            .await
            .unwrap();

        let mut upstream_reader = BufReader::new(upstream_reader);
        let mut response_line = String::new();
        upstream_reader.read_line(&mut response_line).await.unwrap();
        client_writer
            .write_all(response_line.as_bytes())
            .await
            .unwrap();
    });

    destination
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();

    let captured = captured_rx.await.unwrap();
    assert!(
        !captured.contains("task-source") && !captured.contains("task-dest"),
        "captured request leaked task ids: {captured}"
    );
    proxy.await.unwrap();
}

fn trusted_peer_store_path(root: &Path, self_peer_id: &str) -> std::path::PathBuf {
    root.join("trusted-peers")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode(self_peer_id)))
}

async fn wait_for_peer(
    runtime: &TransferRuntime,
    peer_id: &str,
) -> kanna_task_transfer::protocol::DiscoveredPeer {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let peers = runtime.list_peers().await.unwrap();
        if let Some(peer) = peers.into_iter().find(|peer| peer.peer_id == peer_id) {
            return peer;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for peer {peer_id}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn next_incoming_transfer_request(
    runtime: &TransferRuntime,
) -> kanna_task_transfer::runtime::IncomingTransferEvent {
    loop {
        match runtime.next_event().await.unwrap() {
            RuntimeEvent::IncomingTransferRequest(event) => return event,
            RuntimeEvent::PairingStarted(_) => {}
            RuntimeEvent::PairingRequested(_) => {}
            RuntimeEvent::PairingCompleted(_) => {}
            RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
                panic!("expected incoming transfer event");
            }
            RuntimeEvent::OutgoingTransferCommitted(_) => {
                panic!("expected incoming transfer event");
            }
            RuntimeEvent::TerminalEvent { .. } => {}
        }
    }
}

async fn next_outgoing_transfer_committed(
    runtime: &TransferRuntime,
) -> kanna_task_transfer::runtime::OutgoingTransferCommittedEvent {
    loop {
        match runtime.next_event().await.unwrap() {
            RuntimeEvent::OutgoingTransferCommitted(event) => return event,
            RuntimeEvent::PairingStarted(_) => {}
            RuntimeEvent::PairingRequested(_) => {}
            RuntimeEvent::PairingCompleted(_) => {}
            RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
                panic!("expected outgoing transfer committed event");
            }
            RuntimeEvent::IncomingTransferRequest(_) => {
                panic!("expected outgoing transfer committed event");
            }
            RuntimeEvent::TerminalEvent { .. } => {}
        }
    }
}

async fn consume_pairing_completed(runtime: &TransferRuntime) {
    let event = runtime.next_event().await.unwrap();
    match event {
        RuntimeEvent::PairingCompleted(_) => {}
        RuntimeEvent::PairingStarted(_) => panic!("expected pairing completed event"),
        RuntimeEvent::PairingRequested(_) => panic!("expected pairing completed event"),
        RuntimeEvent::IncomingTransferRequest(_) => panic!("expected pairing completed event"),
        RuntimeEvent::OutgoingTransferCommitted(_) => panic!("expected pairing completed event"),
        RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
            panic!("expected pairing completed event");
        }
        RuntimeEvent::TerminalEvent { .. } => panic!("expected pairing completed event"),
    }
}

async fn pair_peers(
    source: &TransferRuntime,
    target: &TransferRuntime,
    target_peer_id: &str,
) -> PairingResult {
    let pairing = source.start_pairing(target_peer_id);
    tokio::pin!(pairing);
    let mut pairing_started = false;
    let mut pairing_request = None;
    while !pairing_started || pairing_request.is_none() {
        tokio::select! {
            result = &mut pairing => {
                panic!("pairing completed before target emitted a request: {result:?}");
            }
            event = source.next_event(), if !pairing_started => {
                match event.unwrap() {
                    RuntimeEvent::PairingStarted(event) => {
                        assert_eq!(event.peer_id, target_peer_id);
                        assert_eq!(event.verification_code.len(), 6);
                        pairing_started = true;
                    }
                    RuntimeEvent::PairingRequested(_) => {
                        panic!("source should not receive its own pairing request event");
                    }
                    RuntimeEvent::PairingCompleted(_) => {}
                    RuntimeEvent::IncomingTransferRequest(_) => {
                        panic!("expected pairing started event");
                    }
                    RuntimeEvent::OutgoingTransferCommitted(_) => {
                        panic!("expected pairing started event");
                    }
                    RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
                        panic!("expected pairing started event");
                    }
                    RuntimeEvent::TerminalEvent { .. } => {
                        panic!("expected pairing started event");
                    }
                }
            }
            event = target.next_event() => {
                match event.unwrap() {
                    RuntimeEvent::PairingRequested(event) => pairing_request = Some(event),
                    RuntimeEvent::PairingStarted(_) => {
                        panic!("target should not receive pairing started event");
                    }
                    RuntimeEvent::PairingCompleted(_) => {}
                    RuntimeEvent::IncomingTransferRequest(_) => {
                        panic!("expected pairing request event");
                    }
                    RuntimeEvent::OutgoingTransferCommitted(_) => {
                        panic!("expected pairing request event");
                    }
                    RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
                        panic!("expected pairing request event");
                    }
                    RuntimeEvent::TerminalEvent { .. } => {
                        panic!("expected pairing request event");
                    }
                }
            }
        }
    }

    let pairing_request = pairing_request.unwrap();

    target
        .accept_pairing(
            &pairing_request.request_id,
            &pairing_request.verification_code,
        )
        .await
        .unwrap();
    pairing.await.unwrap()
}
