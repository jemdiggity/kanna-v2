use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kanna_task_transfer::crypto::{
    parse_public_key, public_key_to_string, seal_json, TransferIdentity,
};
use kanna_task_transfer::peer_store::{PeerRecord, PeerStore};
use kanna_task_transfer::protocol::{PeerRequest, PeerResponse};
use kanna_task_transfer::registry::{PeerRegistry, PeerRegistryEntry};
use kanna_task_transfer::runtime::{
    DiscoveryMode, PairingResult, RuntimeConfig, RuntimeError, RuntimeEvent, TransferRuntime,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_peer_task_snapshots_rejects_spoofed_response_peer_id() {
    let temp = tempfile::tempdir().unwrap();
    let spoofing_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let spoofing_port = spoofing_listener.local_addr().unwrap().port();
    let honest_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let honest_port = honest_listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    let honest_identity = TransferIdentity::generate();
    let honest_public_key = public_key_to_string(&honest_identity.public_key);

    let registry = PeerRegistry::new(temp.path().to_path_buf());
    registry
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{spoofing_port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();
    registry
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-z-honest".into(),
            display_name: "Honest".into(),
            endpoint: format!("127.0.0.1:{honest_port}"),
            pid: std::process::id(),
            public_key: honest_public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();

    let peer_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    peer_store
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    peer_store
        .upsert(PeerRecord {
            peer_id: "peer-z-honest".into(),
            display_name: "Honest".into(),
            public_key: honest_public_key,
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let spoofing_server = tokio::spawn(async move {
        let (stream, _) = spoofing_listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let request: PeerRequest = serde_json::from_str(line.trim()).unwrap();
        let PeerRequest::GetTaskSnapshot { request_id, .. } = request else {
            panic!("expected get task snapshot request");
        };
        let response = PeerResponse::TaskSnapshot {
            request_id,
            peer_id: "peer-victim".into(),
            display_name: "Victim".into(),
            snapshot: json!({
                "tasks": [{
                    "id": "victim-task"
                }]
            }),
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
    });

    let honest_server = tokio::spawn(async move {
        let (stream, _) = honest_listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let request: PeerRequest = serde_json::from_str(line.trim()).unwrap();
        let PeerRequest::GetTaskSnapshot { request_id, .. } = request else {
            panic!("expected get task snapshot request");
        };
        let response = PeerResponse::TaskSnapshot {
            request_id,
            peer_id: "peer-z-honest".into(),
            display_name: "Honest".into(),
            snapshot: json!({
                "tasks": [{
                    "id": "honest-task"
                }]
            }),
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
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

    let snapshots = primary.list_peer_task_snapshots().await.unwrap();
    assert_eq!(
        snapshots.len(),
        1,
        "expected only the honest peer snapshot: {snapshots:?}"
    );
    assert_eq!(snapshots[0].peer_id, "peer-z-honest");
    assert_eq!(
        snapshots[0].snapshot,
        json!({
            "tasks": [{
                "id": "honest-task"
            }]
        })
    );
    spoofing_server.await.unwrap();
    honest_server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observe_peer_session_reports_empty_peer_response_with_peer_context() {
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

    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
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

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"observe_session\""));
        writer.write_all(b"\n").await.unwrap();
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
        .observe_peer_session("peer-target", "task-1")
        .await
        .unwrap();
    let message = match primary.next_event().await.unwrap() {
        RuntimeEvent::TerminalEvent { event, .. } => match event {
            kanna_task_transfer::protocol::PeerTerminalEvent::Error { message, .. } => message,
            other => panic!("expected terminal error event, got {other:?}"),
        },
        other => panic!("expected terminal event, got {other:?}"),
    };
    assert!(
        message.contains("peer peer-target returned an empty response"),
        "unexpected error: {message}",
    );

    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mdns_peers_can_discover_pair_and_transfer() {
    // This covers the runtime's mDNS discovery/listing/connection path on one
    // host. A true scoped IPv6 E2E needs two independently networked macOS
    // hosts on the same L2 segment with Local Network permission granted,
    // Bonjour/mDNS enabled, deterministic link-local IPv6 interfaces, and a
    // harness that can launch and coordinate both Kanna instances. The current
    // Rust and desktop E2E infrastructure starts peers on one machine, so it
    // cannot prove cross-Mac link-local scope routing. See the focused
    // discovery test for the scoped ResolvedService endpoint conversion.
    let temp = tempfile::tempdir().unwrap();

    let secondary_id = unique_mdns_peer_id("peer-secondary-mdns");
    let primary_id = unique_mdns_peer_id("peer-primary-mdns");

    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests(secondary_id.clone(), "Secondary", temp.path(), 0)
            .with_discovery_mode(DiscoveryMode::Mdns),
    )
    .await
    .unwrap();

    let primary = TransferRuntime::spawn(
        RuntimeConfig::for_tests(primary_id.clone(), "Primary", temp.path(), 0)
            .with_discovery_mode(DiscoveryMode::Mdns),
    )
    .await
    .unwrap();

    let discovered = wait_for_peer(&primary, &secondary_id).await;
    assert!(!discovered.endpoint.is_empty());
    wait_for_peer(&secondary, &primary_id).await;

    pair_peers(&primary, &secondary, &secondary_id).await;

    let preflight = primary
        .prepare_transfer_preflight(&secondary_id, "task-source")
        .await
        .unwrap();
    assert_eq!(preflight.source_peer_id, primary_id);

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": secondary_id,
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();

    let event = next_incoming_transfer_request(&secondary).await;
    assert_eq!(event.source_peer_id, primary_id);
    assert_eq!(event.source_task_id, "task-source");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_mdns_test_runs_keep_their_peers_apart() {
    // Regression coverage: mDNS service instance names are host- and
    // LAN-global, so two concurrent suite runs (parallel worktree `./kd test
    // rust` invocations on one machine) that register the same fixed instance
    // name make one run's primary resolve the other run's secondary. The
    // pairing request then parks in the foreign process until it fails with
    // PeerRequestTimeout. Simulate two concurrent runs in one process; each
    // exchange must pair and transfer with its own partner. This fails if the
    // mDNS test peer ids stop being unique per spawn.
    let (first, second) = tokio::join!(
        isolated_mdns_exchange("task-source-a"),
        isolated_mdns_exchange("task-source-b"),
    );
    assert_eq!(first, "task-source-a");
    assert_eq!(second, "task-source-b");
}

async fn isolated_mdns_exchange(source_task_id: &str) -> String {
    let temp = tempfile::tempdir().unwrap();
    let secondary_id = unique_mdns_peer_id("peer-secondary-mdns");
    let primary_id = unique_mdns_peer_id("peer-primary-mdns");

    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests(secondary_id.clone(), "Secondary", temp.path(), 0)
            .with_discovery_mode(DiscoveryMode::Mdns),
    )
    .await
    .unwrap();
    let primary = TransferRuntime::spawn(
        RuntimeConfig::for_tests(primary_id.clone(), "Primary", temp.path(), 0)
            .with_discovery_mode(DiscoveryMode::Mdns),
    )
    .await
    .unwrap();

    wait_for_peer(&primary, &secondary_id).await;
    wait_for_peer(&secondary, &primary_id).await;

    pair_peers(&primary, &secondary, &secondary_id).await;

    let preflight = primary
        .prepare_transfer_preflight(&secondary_id, source_task_id)
        .await
        .unwrap();
    assert_eq!(preflight.source_peer_id, primary_id);

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": secondary_id,
                "task": {
                    "source_task_id": source_task_id
                }
            }),
        )
        .await
        .unwrap();

    let event = next_incoming_transfer_request(&secondary).await;
    assert_eq!(event.source_peer_id, primary_id);
    event.source_task_id
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
async fn trusted_peer_advance_stage_posts_to_owner_kanna_server() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = oneshot::channel();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();

        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).await.unwrap();
            if header == "\r\n" {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = value.trim().parse().unwrap();
            }
        }

        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).await.unwrap();
        request_tx
            .send((request_line, String::from_utf8(body).unwrap()))
            .unwrap();

        reader
            .get_mut()
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .await
            .unwrap();
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(port),
    )
    .await
    .unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&secondary, &owner, "peer-owner").await;

    secondary
        .advance_peer_task_stage("peer-owner", "owner-task-1")
        .await
        .unwrap();

    let (request_line, body) = request_rx.await.unwrap();
    assert_eq!(
        request_line,
        "POST /v1/tasks/owner-task-1/actions/advance-stage HTTP/1.1\r\n"
    );
    assert_eq!(body, "{}");
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_read_task_file_fetches_from_owner_kanna_server() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = oneshot::channel();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).await.unwrap();
            if header == "\r\n" {
                break;
            }
        }
        request_tx.send(request_line).unwrap();

        let body = r#"{"path":"src dir/app.ts","content":"remote body"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        reader
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(port),
    )
    .await
    .unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&secondary, &owner, "peer-owner").await;

    let (path, content) = secondary
        .read_peer_task_file("peer-owner", "owner-task-1", "src dir/app.ts")
        .await
        .unwrap();
    assert_eq!(path, "src dir/app.ts");
    assert_eq!(content, "remote body");

    let request_line = request_rx.await.unwrap();
    assert_eq!(
        request_line,
        "GET /v1/tasks/owner-task-1/files/content?path=src%20dir%2Fapp.ts HTTP/1.1\r\n"
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_mark_read_posts_to_owner_kanna_server() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = oneshot::channel();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();

        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).await.unwrap();
            if header == "\r\n" {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = value.trim().parse().unwrap();
            }
        }

        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).await.unwrap();
        request_tx
            .send((request_line, String::from_utf8(body).unwrap()))
            .unwrap();

        reader
            .get_mut()
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .await
            .unwrap();
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(port),
    )
    .await
    .unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&secondary, &owner, "peer-owner").await;

    secondary
        .mark_peer_task_read("peer-owner", "owner-task-1", 7)
        .await
        .unwrap();

    let (request_line, body) = request_rx.await.unwrap();
    assert_eq!(
        request_line,
        "POST /v1/tasks/owner-task-1/actions/mark-read HTTP/1.1\r\n"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        json!({ "expectedActivityRevision": 7 }),
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_task_action_percent_encodes_task_id_as_one_path_segment() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = oneshot::channel();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        request_tx.send(request_line).unwrap();

        reader
            .get_mut()
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .await
            .unwrap();
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(port),
    )
    .await
    .unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&secondary, &owner, "peer-owner").await;

    secondary
        .mark_peer_task_read("peer-owner", "owner/task% snow 雪-._~", 7)
        .await
        .unwrap();

    assert_eq!(
        request_rx.await.unwrap(),
        "POST /v1/tasks/owner%2Ftask%25%20snow%20%E9%9B%AA-._~/actions/mark-read HTTP/1.1\r\n"
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_rejects_request_smuggling_task_id_before_kanna_connection() {
    assert_task_id_rejected_before_kanna_connection(
        "owner\r\nHost: attacker\r\n\r\nGET /smuggled HTTP/1.1",
        "task ID contains an ASCII control character",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_rejects_oversized_task_id_before_kanna_connection() {
    let task_id = "a".repeat(1025);
    assert_task_id_rejected_before_kanna_connection(&task_id, "task ID exceeds 1024 UTF-8 bytes")
        .await;
}

async fn assert_task_id_rejected_before_kanna_connection(task_id: &str, expected_message: &str) {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(port),
    )
    .await
    .unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&secondary, &owner, "peer-owner").await;

    let action = secondary.advance_peer_task_stage("peer-owner", task_id);
    tokio::pin!(action);
    let error = tokio::select! {
        result = &mut action => result.unwrap_err(),
        accepted = listener.accept() => {
            panic!(
                "invalid task ID opened a Kanna server connection: {:?}",
                accepted.unwrap().1,
            );
        }
        _ = tokio::time::sleep(Duration::from_secs(1)) => {
            panic!("task action did not reject the invalid task ID");
        }
    };
    assert!(
        matches!(error, RuntimeError::Protocol(_)),
        "unexpected error: {error}"
    );
    assert!(
        error.to_string().contains(expected_message),
        "unexpected error: {error}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "invalid task ID left a queued Kanna server connection",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forged_mark_read_payload_cannot_apply_owner_action() {
    let temp = tempfile::tempdir().unwrap();
    let kanna_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let kanna_port = kanna_listener.local_addr().unwrap().port();

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(kanna_port),
    )
    .await
    .unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&secondary, &owner, "peer-owner").await;
    let owner_peer = secondary
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap();
    let attacker = TransferIdentity::generate();
    let owner_public_key = parse_public_key(&owner_peer.public_key).unwrap();
    let sealed_payload = seal_json(
        &attacker,
        &owner_public_key,
        &json!({
            "task_id": "owner-task-1",
            "expected_activity_revision": 7,
        }),
    )
    .unwrap();

    let mut stream = TcpStream::connect(&owner_peer.endpoint).await.unwrap();
    let request = PeerRequest::MarkTaskRead {
        request_id: "forged-mark-read".into(),
        requester_peer_id: "peer-secondary".into(),
        sealed_payload,
    };
    stream
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();
    let mut response_line = String::new();
    BufReader::new(stream)
        .read_line(&mut response_line)
        .await
        .unwrap();
    let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
    let PeerResponse::Error {
        request_id,
        message,
    } = response
    else {
        panic!("expected forged mark-read request to fail");
    };
    assert_eq!(request_id, "forged-mark-read");
    assert!(
        message.contains("payload decryption failed"),
        "unexpected error: {message}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), kanna_listener.accept())
            .await
            .is_err(),
        "forged request reached the owner Kanna server"
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
async fn destination_reloads_awaiting_ack_reservation_after_sidecar_restart() {
    let temp = tempfile::tempdir().unwrap();
    let secondary_config = RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0);
    let secondary = TransferRuntime::spawn(secondary_config.clone())
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
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let incoming = next_incoming_transfer_request(&secondary).await;
    assert_eq!(incoming.transfer_id, preflight.transfer_id);

    drop(secondary);
    let secondary = TransferRuntime::spawn(secondary_config.clone())
        .await
        .unwrap();
    secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();
    let ack = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(ack.transfer_id, preflight.transfer_id);

    secondary
        .mark_import_ack_completed(&preflight.transfer_id)
        .await
        .unwrap();
    drop(secondary);
    let secondary = TransferRuntime::spawn(secondary_config).await.unwrap();
    let error = secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("missing source peer"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_reloads_outgoing_reservation_after_sidecar_restart() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let primary_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0);
    let primary = TransferRuntime::spawn(primary_config.clone())
        .await
        .unwrap();
    pair_peers(&primary, &secondary, "peer-secondary").await;

    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();
    drop(primary);
    let primary = TransferRuntime::spawn(primary_config).await.unwrap();

    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();

    let incoming = next_incoming_transfer_request(&secondary).await;
    assert_eq!(incoming.transfer_id, preflight.transfer_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unapplied_import_commit_receipt_older_than_pending_ttl_replays_after_source_restart() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let primary_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0);
    let primary = TransferRuntime::spawn(primary_config.clone())
        .await
        .unwrap();
    pair_peers(&primary, &secondary, "peer-secondary").await;
    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();

    secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();
    drop(primary);
    age_import_commit_receipt_past_pending_ttl(temp.path(), "peer-primary", &preflight.transfer_id);
    let primary = TransferRuntime::spawn(primary_config).await.unwrap();

    let replay = tokio::time::timeout(
        Duration::from_secs(1),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect("unapplied receipt was not replayed after restart");
    assert_eq!(replay.transfer_id, preflight.transfer_id);
    assert_eq!(replay.source_task_id, "task-source");
    assert_eq!(replay.destination_local_task_id, "task-dest");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unapplied_import_commit_receipt_retries_without_restart_or_duplicate() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let primary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_receipt_retry_interval(Duration::from_millis(75)),
    )
    .await
    .unwrap();
    pair_peers(&primary, &secondary, "peer-secondary").await;
    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();

    secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();
    let first = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(first.transfer_id, preflight.transfer_id);

    let retry = tokio::time::timeout(
        Duration::from_secs(1),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect("unapplied receipt was not retried while the runtime stayed alive");
    assert_eq!(retry.transfer_id, preflight.transfer_id);

    primary
        .mark_import_commit_applied(&preflight.transfer_id)
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_millis(225),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect_err("applied receipt continued retrying");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn receipt_limits_compact_applied_tombstones_and_reject_excess_unapplied() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let primary_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
        .with_replay_limits(1, 2);
    let primary = TransferRuntime::spawn(primary_config.clone())
        .await
        .unwrap();
    pair_peers(&primary, &secondary, "peer-secondary").await;

    let mut applied_ids = Vec::new();
    for index in 0..3 {
        let source_task_id = format!("task-applied-{index}");
        let destination_task_id = format!("task-dest-{index}");
        let preflight = primary
            .prepare_transfer_preflight("peer-secondary", &source_task_id)
            .await
            .unwrap();
        secondary
            .acknowledge_import_committed(
                &preflight.transfer_id,
                &source_task_id,
                &destination_task_id,
            )
            .await
            .unwrap();
        let _ = next_outgoing_transfer_committed(&primary).await;
        primary
            .mark_import_commit_applied(&preflight.transfer_id)
            .await
            .unwrap();
        applied_ids.push((preflight.transfer_id, source_task_id, destination_task_id));
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(
        replay_json_count(temp.path(), "peer-primary", "receipts"),
        2
    );

    let pending_one = primary
        .prepare_transfer_preflight("peer-secondary", "task-pending-1")
        .await
        .unwrap();
    secondary
        .acknowledge_import_committed(
            &pending_one.transfer_id,
            "task-pending-1",
            "task-pending-dest-1",
        )
        .await
        .unwrap();
    let _ = next_outgoing_transfer_committed(&primary).await;
    let pending_two = primary
        .prepare_transfer_preflight("peer-secondary", "task-pending-2")
        .await
        .unwrap();
    let cap_error = secondary
        .acknowledge_import_committed(
            &pending_two.transfer_id,
            "task-pending-2",
            "task-pending-dest-2",
        )
        .await
        .unwrap_err();
    assert!(cap_error.to_string().contains("too many unapplied"));
    assert_eq!(
        replay_json_count(temp.path(), "peer-primary", "receipts"),
        3,
        "two compacted tombstones plus the existing unapplied receipt must remain"
    );
    drop(primary);
    let _primary = TransferRuntime::spawn(primary_config).await.unwrap();
    assert_eq!(
        replay_json_count(temp.path(), "peer-primary", "receipts"),
        3,
        "restart must preserve unapplied work and keep applied tombstones bounded"
    );

    let (oldest_id, oldest_source, oldest_destination) = &applied_ids[0];
    let oldest_retry = send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        oldest_id,
        oldest_source,
        oldest_destination,
        true,
    )
    .await
    .unwrap();
    assert!(matches!(oldest_retry, PeerResponse::Error { .. }));
    let (newest_id, newest_source, newest_destination) = &applied_ids[2];
    let newest_retry = send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        newest_id,
        newest_source,
        newest_destination,
        true,
    )
    .await
    .unwrap();
    assert!(matches!(newest_retry, PeerResponse::ImportCommitted { .. }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_ttl_pruning_removes_outgoing_and_incoming_reservation_files() {
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
    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-expiring")
        .await
        .unwrap();
    let outgoing_path = replay_record_path(
        temp.path(),
        "peer-primary",
        "reservations",
        &preflight.transfer_id,
    );
    let incoming_path = replay_record_path(
        temp.path(),
        "peer-secondary",
        "incoming-reservations",
        &preflight.transfer_id,
    );
    assert!(outgoing_path.exists());
    assert!(incoming_path.exists());

    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = primary
        .prepare_transfer_commit(&preflight.transfer_id, json!({}))
        .await
        .unwrap_err();
    let _ = secondary
        .finalize_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap_err();
    assert!(!outgoing_path.exists());
    assert!(!incoming_path.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_import_commit_response_accepts_identical_retry_and_rejects_mismatch() {
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

    send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        &preflight.transfer_id,
        "task-source",
        "task-dest",
        false,
    )
    .await;
    let first = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(first.transfer_id, preflight.transfer_id);

    let retry = send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        &preflight.transfer_id,
        "task-source",
        "task-dest",
        true,
    )
    .await
    .expect("identical retry response");
    assert!(matches!(retry, PeerResponse::ImportCommitted { .. }));

    let mismatch = send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        &preflight.transfer_id,
        "task-source",
        "task-other",
        true,
    )
    .await
    .expect("mismatched retry response");
    assert!(matches!(mismatch, PeerResponse::Error { .. }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applied_receipt_older_than_pending_ttl_remains_an_idempotent_tombstone() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-secondary",
        "Secondary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let primary_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0);
    let primary = TransferRuntime::spawn(primary_config.clone())
        .await
        .unwrap();
    pair_peers(&primary, &secondary, "peer-secondary").await;
    let preflight = primary
        .prepare_transfer_preflight("peer-secondary", "task-source")
        .await
        .unwrap();
    secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();
    let _ = next_outgoing_transfer_committed(&primary).await;
    primary
        .mark_import_commit_applied(&preflight.transfer_id)
        .await
        .unwrap();
    drop(primary);
    age_import_commit_receipt_past_pending_ttl(temp.path(), "peer-primary", &preflight.transfer_id);
    let primary = TransferRuntime::spawn(primary_config).await.unwrap();

    let retry = send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        &preflight.transfer_id,
        "task-source",
        "task-dest",
        true,
    )
    .await
    .expect("applied duplicate response");
    assert!(matches!(retry, PeerResponse::ImportCommitted { .. }));
    let mismatch = send_raw_import_committed(
        temp.path(),
        &secondary,
        "peer-primary",
        &preflight.transfer_id,
        "task-source",
        "different-task-dest",
        true,
    )
    .await
    .expect("mismatched applied duplicate response");
    assert!(matches!(mismatch, PeerResponse::Error { .. }));
    tokio::time::timeout(Duration::from_millis(100), primary.next_event())
        .await
        .expect_err("applied duplicate emitted another event");
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

/// mDNS service instance names are visible to the whole host and LAN, not just
/// this process. Fixed names collide with concurrent runs of this suite in
/// other worktrees (or other machines on the same network), making discovery
/// resolve a foreign process's endpoint and pairing requests park there until
/// PeerRequestTimeout. Every spawned test peer gets a per-spawn unique id.
fn unique_mdns_peer_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!(
        "{prefix}-{}-{nanos:x}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

async fn wait_for_peer(
    runtime: &TransferRuntime,
    peer_id: &str,
) -> kanna_task_transfer::protocol::DiscoveredPeer {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let peers = runtime.list_peers().await.unwrap();
        if let Some(peer) = peers
            .into_iter()
            .find(|peer| peer.peer_id == peer_id && has_connectable_endpoint(peer))
        {
            return peer;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for peer {peer_id}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// mDNS resolution is eventually consistent: the first ServiceResolved event
/// can carry only an AAAA record whose link-local address is scoped to the
/// interface that happened to receive the announcement, not the interface
/// that owns the address (observed on a multi-NIC host: en10's fe80 address
/// scoped to en9). Connecting to such an endpoint black-holes until the peer
/// request timeout. The A record for the same host arrives moments later and
/// address sets only accumulate, so waiting for a same-host-connectable IPv4
/// endpoint is deterministic and keeps pairing off the misscoped address.
fn has_connectable_endpoint(peer: &kanna_task_transfer::protocol::DiscoveredPeer) -> bool {
    peer.endpoint
        .parse::<std::net::SocketAddr>()
        .map(|addr| addr.is_ipv4())
        .unwrap_or(false)
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

fn age_import_commit_receipt_past_pending_ttl(
    registry_root: &Path,
    peer_id: &str,
    transfer_id: &str,
) {
    let receipt_path = replay_record_path(registry_root, peer_id, "receipts", transfer_id);
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).expect("read receipt"))
            .expect("parse receipt");
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    receipt["created_at_unix_ms"] = json!(now_ms.saturating_sub(301_000));
    std::fs::write(
        receipt_path,
        serde_json::to_vec_pretty(&receipt).expect("serialize aged receipt"),
    )
    .expect("age receipt");
}

fn replay_record_path(
    registry_root: &Path,
    peer_id: &str,
    kind: &str,
    transfer_id: &str,
) -> std::path::PathBuf {
    let digest = Sha256::digest(transfer_id.as_bytes());
    let transfer_key = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    registry_root
        .join("transfer-replay")
        .join(URL_SAFE_NO_PAD.encode(peer_id))
        .join(kind)
        .join(format!("{transfer_key}.json"))
}

fn replay_json_count(registry_root: &Path, peer_id: &str, kind: &str) -> usize {
    let directory = registry_root
        .join("transfer-replay")
        .join(URL_SAFE_NO_PAD.encode(peer_id))
        .join(kind);
    std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
                .count()
        })
        .unwrap_or(0)
}

async fn send_raw_import_committed(
    registry_root: &Path,
    requester: &TransferRuntime,
    target_peer_id: &str,
    transfer_id: &str,
    source_task_id: &str,
    destination_local_task_id: &str,
    read_response: bool,
) -> Option<PeerResponse> {
    let target = requester
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == target_peer_id)
        .expect("target peer");
    let identity_path = registry_root
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-secondary")));
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).unwrap()).unwrap();
    let requester_identity = TransferIdentity::from_secret_string(
        stored["secret_key"].as_str().expect("stored secret key"),
    )
    .unwrap();
    let target_public_key = parse_public_key(&target.public_key).unwrap();
    let sealed_payload = seal_json(
        &requester_identity,
        &target_public_key,
        &json!({
            "source_task_id": source_task_id,
            "destination_local_task_id": destination_local_task_id,
        }),
    )
    .unwrap();
    let request = PeerRequest::ImportCommitted {
        request_id: format!("raw-{}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)),
        transfer_id: transfer_id.to_owned(),
        requester_peer_id: "peer-secondary".into(),
        sealed_payload,
    };
    let mut stream = TcpStream::connect(&target.endpoint).await.unwrap();
    stream
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();
    stream.flush().await.unwrap();
    if !read_response {
        drop(stream);
        return None;
    }

    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .unwrap();
    Some(serde_json::from_str(response.trim()).unwrap())
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
