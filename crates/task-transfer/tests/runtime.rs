use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kanna_agent_protocol::{CompanionEvent, ServerFrame};
use kanna_task_transfer::crypto::{
    artifact_stream_context, open_json, parse_public_key, public_key_to_string, seal_json,
    StreamSealer, TransferIdentity,
};
use kanna_task_transfer::peer_store::{PeerRecord, PeerStore};
use kanna_task_transfer::protocol::{
    PeerRequest, PeerResponse, PeerTerminalControl, PeerTerminalEvent, CURRENT_PROTOCOL_VERSION,
    MAX_COMPANION_REQUEST_LINE_BYTES, MAX_PEER_REQUEST_LINE_BYTES,
};
use kanna_task_transfer::registry::{PeerRegistry, PeerRegistryEntry};
use kanna_task_transfer::runtime::{
    DiscoveryMode, ExternalPeer, PairingResult, RuntimeConfig, RuntimeError, RuntimeEvent,
    TransferRuntime, TransferTransport,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpSocket, TcpStream, UnixListener};
use tokio::sync::{mpsc, oneshot};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn peer_artifact_root(registry_root: &Path, peer_id: &str) -> std::path::PathBuf {
    registry_root
        .join("artifacts")
        .join(URL_SAFE_NO_PAD.encode(peer_id.as_bytes()))
}

fn runtime_endpoint(registry_root: &Path, peer_id: &str) -> String {
    PeerRegistry::new(registry_root.to_path_buf())
        .list_peers("")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == peer_id)
        .unwrap()
        .endpoint
}

async fn send_raw_task_pull(
    registry_root: &Path,
    source_peer_id: &str,
    request_id: &str,
    requester_peer_id: &str,
    sealed_payload: String,
) -> PeerResponse {
    let request = PeerRequest::RequestTaskPull {
        request_id: request_id.into(),
        requester_peer_id: requester_peer_id.into(),
        sealed_payload,
    };
    let mut stream = TcpStream::connect(runtime_endpoint(registry_root, source_peer_id))
        .await
        .unwrap();
    stream
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();
    stream.flush().await.unwrap();
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .unwrap();
    serde_json::from_str(response.trim()).unwrap()
}

fn seal_authenticated_task_pull(
    registry_root: &Path,
    source: &TransferRuntime,
    requester_peer_id: &str,
    request_id: &str,
    source_task_id: &str,
    owner_epoch: &str,
    issued_at_unix_ms: u64,
) -> String {
    let requester_identity = stored_runtime_identity(registry_root, requester_peer_id);
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    seal_json(
        &requester_identity,
        &source_public_key,
        &json!({
            "action": "request_task_pull",
            "request_id": request_id,
            "owner_epoch": owner_epoch,
            "issued_at_unix_ms": issued_at_unix_ms,
            "requester_peer_id": requester_peer_id,
            "source_task_id": source_task_id,
            "reserved_target_peer_id": source.local_identity().peer_id,
        }),
    )
    .unwrap()
}

async fn send_raw_peer_value(endpoint: &str, request: &serde_json::Value) -> PeerResponse {
    let mut stream = TcpStream::connect(endpoint).await.unwrap();
    stream
        .write_all(format!("{}\n", serde_json::to_string(request).unwrap()).as_bytes())
        .await
        .unwrap();
    stream.flush().await.unwrap();
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .unwrap();
    serde_json::from_str(response.trim()).unwrap()
}

async fn authenticated_request_epoch(endpoint: &str) -> String {
    match send_raw_peer_value(
        endpoint,
        &json!({
            "type": "get_authenticated_request_epoch",
            "request_id": "epoch-probe",
        }),
    )
    .await
    {
        PeerResponse::AuthenticatedRequestEpoch { epoch, .. } => epoch,
        response => panic!("expected authenticated request epoch, got {response:?}"),
    }
}

async fn runtime_with_trusted_hostile_peer(root: &Path, listener: &TcpListener) -> TransferRuntime {
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(root.to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-hostile".into(),
            display_name: "Hostile".into(),
            endpoint: listener.local_addr().unwrap().to_string(),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: CURRENT_PROTOCOL_VERSION,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(root, "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-hostile".into(),
            display_name: "Hostile".into(),
            public_key: target_public_key,
            capabilities_json: json!({
                "protocolVersion": CURRENT_PROTOCOL_VERSION,
                "authenticatedTaskRequests": true,
                "authenticatedTaskRequestVersion": 1,
            })
            .to_string(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    TransferRuntime::spawn(
        // Nothing here waits this out; it only has to outlast a round trip on
        // a box running several worktrees' suites, where a 2s bound turned a
        // slow reply into a timeout instead of the frame-limit rejection under
        // test.
        RuntimeConfig::for_tests("peer-primary", "Primary", root, 0)
            .with_peer_request_timeout(Duration::from_secs(60)),
    )
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_peer_response_is_rejected_at_the_frame_limit() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let runtime = runtime_with_trusted_hostile_peer(temp.path(), &listener).await;
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = String::new();
        BufReader::new(&mut stream)
            .read_line(&mut request)
            .await
            .unwrap();
        stream
            .write_all(&vec![b'x'; 8 * 1024 * 1024 + 1])
            .await
            .unwrap();
        stream.write_all(b"\n").await.unwrap();
    });

    let listing = runtime.list_peer_task_snapshots().await.unwrap();
    assert_eq!(listing.issues.len(), 1);
    assert!(
        listing.issues[0]
            .message
            .contains("exceeds maximum peer response frame size"),
        "unexpected hostile response error: {}",
        listing.issues[0].message,
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unterminated_peer_response_is_rejected_as_a_frame() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let runtime = runtime_with_trusted_hostile_peer(temp.path(), &listener).await;
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = String::new();
        BufReader::new(&mut stream)
            .read_line(&mut request)
            .await
            .unwrap();
        stream
            .write_all(b"{\"type\":\"task_snapshot\"}")
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
    });

    let listing = runtime.list_peer_task_snapshots().await.unwrap();
    assert_eq!(listing.issues.len(), 1);
    assert!(
        listing.issues[0]
            .message
            .contains("did not terminate within the peer response frame limit"),
        "unexpected hostile response error: {}",
        listing.issues[0].message,
    );
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthenticated_peer_connection_has_a_read_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(50)),
    )
    .await
    .unwrap();
    let mut slow = TcpStream::connect(runtime_endpoint(temp.path(), "peer-primary"))
        .await
        .unwrap();
    let mut byte = [0u8; 1];

    // Liveness: a retained listener task never closes the socket at all.
    let read = tokio::time::timeout(Duration::from_secs(10), slow.read(&mut byte))
        .await
        .expect("slow unauthenticated peer retained a listener task")
        .unwrap();

    assert_eq!(read, 0, "listener should close a pre-auth slowloris socket");
    drop(runtime);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_peer_request_is_closed_without_a_response() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let mut stream = TcpStream::connect(runtime_endpoint(temp.path(), "peer-primary"))
        .await
        .unwrap();

    stream.write_all(&vec![b'a'; 64 * 1024 + 1]).await.unwrap();
    stream.shutdown().await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_millis(250),
        stream.read_to_end(&mut response),
    )
    .await
    .expect("oversized unauthenticated request retained a listener task")
    .unwrap();

    assert!(
        response.is_empty(),
        "oversized input reached JSON dispatch: {}",
        String::from_utf8_lossy(&response),
    );
    drop(runtime);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_input_chunk_at_the_ui_boundary_fits_the_authenticated_peer_frame() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let runtime = runtime_with_trusted_hostile_peer(temp.path(), &listener).await;
    let server = tokio::spawn(async move {
        let (epoch_stream, _) = listener.accept().await.unwrap();
        let mut epoch_reader = BufReader::new(epoch_stream);
        let mut epoch_line = String::new();
        epoch_reader.read_line(&mut epoch_line).await.unwrap();
        let epoch_request: PeerRequest = serde_json::from_str(epoch_line.trim()).unwrap();
        let PeerRequest::GetAuthenticatedRequestEpoch { request_id } = epoch_request else {
            panic!("expected owner epoch request");
        };
        epoch_reader
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&PeerResponse::AuthenticatedRequestEpoch {
                        request_id,
                        epoch: "owner-epoch".into(),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let (input_stream, _) = listener.accept().await.unwrap();
        let mut input_reader = BufReader::new(input_stream);
        let mut input_line = String::new();
        input_reader.read_line(&mut input_line).await.unwrap();
        assert!(
            input_line.len() <= 64 * 1024,
            "4 KiB terminal input expanded to a {}-byte peer frame",
            input_line.len(),
        );
        let input_request: PeerRequest = serde_json::from_str(input_line.trim()).unwrap();
        let PeerRequest::SendSessionInput {
            request_id, data, ..
        } = input_request
        else {
            panic!("expected terminal input request");
        };
        assert_eq!(data, vec![u8::MAX; 4 * 1024]);
        input_reader
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&PeerResponse::SendSessionInput { request_id }).unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    runtime
        .send_peer_session_input(
            "peer-hostile",
            "task-boundary",
            vec![u8::MAX; 4 * 1024],
            false,
            false,
        )
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_listener_rejects_connections_beyond_its_hard_cap() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(
        // The 32 held connections must still occupy the cap when the 33rd
        // arrives, so this has to outlast everything below it. A 2s bound was
        // a race against the loop that opens them.
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_secs(60)),
    )
    .await
    .unwrap();
    let endpoint = runtime_endpoint(temp.path(), "peer-primary");
    let mut held = Vec::new();
    for _ in 0..32 {
        held.push(TcpStream::connect(&endpoint).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut rejected = TcpStream::connect(&endpoint).await.unwrap();
    rejected
        .write_all(b"{\"type\":\"get_authenticated_request_epoch\",\"request_id\":\"over-cap\"}\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    let read_result = tokio::time::timeout(
        Duration::from_millis(250),
        rejected.read_to_end(&mut response),
    )
    .await
    .expect("over-cap peer connection was not rejected promptly");
    if let Err(error) = read_result {
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset,
            "unexpected over-cap read error: {error}",
        );
    }

    assert!(
        response.is_empty(),
        "over-cap connection reached request dispatch: {}",
        String::from_utf8_lossy(&response),
    );
    drop(held);
    drop(runtime);
}

async fn accept_authenticated_request(
    listener: &TcpListener,
    epoch: &str,
) -> (BufReader<TcpStream>, PeerRequest) {
    let (epoch_stream, _) = listener.accept().await.unwrap();
    let mut epoch_reader = BufReader::new(epoch_stream);
    let mut epoch_line = String::new();
    epoch_reader.read_line(&mut epoch_line).await.unwrap();
    let epoch_request: PeerRequest = serde_json::from_str(epoch_line.trim()).unwrap();
    let PeerRequest::GetAuthenticatedRequestEpoch { request_id } = epoch_request else {
        panic!("expected authenticated request epoch probe");
    };
    let epoch_response = PeerResponse::AuthenticatedRequestEpoch {
        request_id,
        epoch: epoch.to_owned(),
    };
    epoch_reader
        .get_mut()
        .write_all(format!("{}\n", serde_json::to_string(&epoch_response).unwrap()).as_bytes())
        .await
        .unwrap();

    let (request_stream, _) = listener.accept().await.unwrap();
    let mut request_reader = BufReader::new(request_stream);
    let mut request_line = String::new();
    request_reader.read_line(&mut request_line).await.unwrap();
    let request = serde_json::from_str(request_line.trim()).unwrap();
    (request_reader, request)
}

async fn serve_task_file_reads(listener: TcpListener, maximum: usize) -> usize {
    let mut accepted = 0usize;
    while accepted < maximum {
        let next = tokio::time::timeout(Duration::from_secs(1), listener.accept()).await;
        let Ok(Ok((stream, _))) = next else {
            break;
        };
        accepted += 1;
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
        let body = r#"{"path":"src/private.rs","content":"private body"}"#;
        reader
            .get_mut()
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }
    accepted
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn stored_runtime_identity(registry_root: &Path, peer_id: &str) -> TransferIdentity {
    let identity_path = registry_root
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode(peer_id)));
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).expect("read runtime identity"))
            .expect("parse runtime identity");
    TransferIdentity::from_secret_string(
        stored["secret_key"]
            .as_str()
            .expect("runtime identity secret key"),
    )
    .expect("decode runtime identity")
}

fn seal_authenticated_transfer_request(
    sender: &TransferIdentity,
    receiver_public_key: &str,
    action: &str,
    request_id: &str,
    owner_epoch: &str,
    issued_at_unix_ms: u64,
    arguments: serde_json::Value,
) -> String {
    let mut payload = arguments.as_object().cloned().expect("object arguments");
    payload.insert("action".into(), json!(action));
    payload.insert("request_id".into(), json!(request_id));
    payload.insert("owner_epoch".into(), json!(owner_epoch));
    payload.insert("issued_at_unix_ms".into(), json!(issued_at_unix_ms));
    seal_json(
        sender,
        &parse_public_key(receiver_public_key).expect("receiver public key"),
        &serde_json::Value::Object(payload),
    )
    .expect("seal authenticated transfer request")
}

fn peer_error_message(response: PeerResponse) -> String {
    let PeerResponse::Error { message, .. } = response else {
        panic!("expected peer error response");
    };
    message
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepare_transfer_rejects_forged_stale_and_replayed_envelopes_before_reserving() {
    let temp = tempfile::tempdir().unwrap();
    let destination_config =
        RuntimeConfig::for_tests("peer-destination", "Destination", temp.path(), 0);
    let destination = TransferRuntime::spawn(destination_config.clone())
        .await
        .unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination").await;
    let endpoint = runtime_endpoint(temp.path(), "peer-destination");
    let owner_epoch = authenticated_request_epoch(&endpoint).await;
    let source_identity = stored_runtime_identity(temp.path(), "peer-source");
    let destination_public_key = destination.local_identity().public_key;

    let request = |request_id: &str, issued_at_unix_ms: u64, reserved_target_peer_id: &str| {
        let sealed_payload = seal_authenticated_transfer_request(
            &source_identity,
            &destination_public_key,
            "prepare_transfer",
            request_id,
            &owner_epoch,
            issued_at_unix_ms,
            json!({
                "source_peer_id": "peer-source",
                "source_task_id": "task-source",
                "reserved_target_peer_id": reserved_target_peer_id,
            }),
        );
        json!({
            "type": "prepare_transfer",
            "request_id": request_id,
            "source_peer_id": "peer-source",
            "sealed_payload": sealed_payload,
        })
    };

    let forged = send_raw_peer_value(
        &endpoint,
        &request(
            "prepare-forged-target",
            current_unix_ms(),
            "peer-someone-else",
        ),
    )
    .await;
    assert!(
        peer_error_message(forged).contains("reserved_target_peer_id"),
        "forged target identity allocated a reservation",
    );

    let stale =
        send_raw_peer_value(&endpoint, &request("prepare-stale", 1, "peer-destination")).await;
    assert!(peer_error_message(stale).contains("stale authenticated prepare_transfer"));

    let valid_request = request("prepare-replay", current_unix_ms(), "peer-destination");
    let valid = send_raw_peer_value(&endpoint, &valid_request).await;
    assert!(matches!(valid, PeerResponse::PrepareTransfer { .. }));
    let replay = send_raw_peer_value(&endpoint, &valid_request).await;
    assert!(peer_error_message(replay).contains("replayed authenticated prepare_transfer"));
    assert_eq!(
        replay_json_count(temp.path(), "peer-destination", "incoming-reservations"),
        1,
        "forged, stale, or replayed prepare allocated another reservation",
    );

    drop(destination);
    let _destination = TransferRuntime::spawn(destination_config).await.unwrap();
    let replay_after_restart = send_raw_peer_value(
        &runtime_endpoint(temp.path(), "peer-destination"),
        &valid_request,
    )
    .await;
    assert!(
        matches!(replay_after_restart, PeerResponse::Error { .. }),
        "captured prepare allocated a reservation after restart",
    );
    assert_eq!(
        replay_json_count(temp.path(), "peer-destination", "incoming-reservations"),
        1,
    );
}

/// A duplicate push discovers it lost the race only after its preflight has
/// already written a durable reservation and staged artifacts for it. On
/// 2026-08-06 that state was simply left behind. Abandoning has to clear both,
/// and has to survive the caller not knowing whether the reservation existed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoning_an_outgoing_transfer_clears_its_reservation_and_staged_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(500)),
    )
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
    let staged = temp.path().join("session.tar.gz");
    std::fs::write(&staged, b"session").unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "claude-session",
            staged.clone(),
            true,
        )
        .await
        .unwrap();
    let owned_artifact = source
        .fetch_transfer_artifact(&preflight.transfer_id, "claude-session")
        .await
        .unwrap()
        .path;
    assert_eq!(
        replay_json_count(temp.path(), "peer-source", "reservations"),
        1,
    );
    assert!(owned_artifact.exists());

    source
        .abandon_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap();

    assert_eq!(
        replay_json_count(temp.path(), "peer-source", "reservations"),
        0,
        "abandoned reservation stayed on disk",
    );
    assert!(
        !owned_artifact.exists(),
        "abandoned artifact stayed on disk"
    );
    assert!(source
        .fetch_transfer_artifact(&preflight.transfer_id, "claude-session")
        .await
        .is_err());

    // The caller's job is to leave nothing behind, not to prove something was
    // there — a second release, or one for a transfer this process never
    // reserved, is a no-op rather than an error it would have to swallow.
    source
        .abandon_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap();
    source
        .abandon_outgoing_transfer("transfer-never-reserved")
        .await
        .unwrap();
}

/// Claiming success over a reservation whose file survived is the same silent
/// leak in a quieter form: the caller tells the operator the reservation is
/// released, and nobody ever looks again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoning_an_outgoing_transfer_reports_a_reservation_it_could_not_delete() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(500)),
    )
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
    // Swapping the reservation file for a directory of the same name is the
    // portable way to make exactly one `remove_file` fail: unlinking a
    // directory is refused, and nothing else about the store changes.
    let reservation_path = only_replay_json(temp.path(), "peer-source", "reservations");
    std::fs::remove_file(&reservation_path).unwrap();
    std::fs::create_dir(&reservation_path).unwrap();

    let error = source
        .abandon_outgoing_transfer(&preflight.transfer_id)
        .await
        .expect_err("abandon claimed success over a reservation it could not delete");
    assert!(
        matches!(error, RuntimeError::Io(_)),
        "unexpected abandon failure: {error:?}",
    );

    // Once the obstruction is gone the same call succeeds, and the record that
    // is already absent is not mistaken for a failure.
    std::fs::remove_dir(&reservation_path).unwrap();
    source
        .abandon_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap();
    assert_eq!(
        replay_json_count(temp.path(), "peer-source", "reservations"),
        0,
    );
}

/// A preflight reserves on *both* machines. Releasing only the source half
/// leaves `incoming-reservations/<transfer_id>.json` on the destination, where
/// nothing but the TTL sweeper ever looks at it, and where it counts against
/// that machine's reservation admission cap in the meantime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoning_an_outgoing_transfer_releases_the_destination_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(500)),
    )
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
    assert_eq!(
        replay_json_count(temp.path(), "peer-destination", "incoming-reservations"),
        1,
    );

    source
        .abandon_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap();

    assert_eq!(
        replay_json_count(temp.path(), "peer-destination", "incoming-reservations"),
        0,
        "the destination reservation outlived the transfer that made it",
    );
    assert_eq!(
        replay_json_count(temp.path(), "peer-source", "reservations"),
        0,
    );

    // The destination answers an id it does not hold as settled, which is what
    // makes a half-failed release retriable rather than permanently stuck.
    let endpoint = runtime_endpoint(temp.path(), "peer-destination");
    let owner_epoch = authenticated_request_epoch(&endpoint).await;
    let source_identity = stored_runtime_identity(temp.path(), "peer-source");
    let destination_public_key = destination.local_identity().public_key;
    let unknown = send_raw_peer_value(
        &endpoint,
        &json!({
            "type": "abandon_transfer",
            "request_id": "abandon-unknown",
            "transfer_id": "transfer-never-reserved",
            "source_peer_id": "peer-source",
            "sealed_payload": seal_authenticated_transfer_request(
                &source_identity,
                &destination_public_key,
                "abandon_transfer",
                "abandon-unknown",
                &owner_epoch,
                current_unix_ms(),
                json!({
                    "source_peer_id": "peer-source",
                    "transfer_id": "transfer-never-reserved",
                    "reserved_target_peer_id": "peer-destination",
                }),
            ),
        }),
    )
    .await;
    assert!(
        matches!(unknown, PeerResponse::AbandonTransfer { .. }),
        "an unknown transfer id must settle rather than fail: {unknown:?}",
    );
}

/// The release is a narrow authority: it lets the one source that reserved a
/// transfer drop it *before* it commits. A committed reservation is an incoming
/// transfer this machine has already been told about, and a different peer has
/// no claim on either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_destination_refuses_to_release_a_committed_or_foreign_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(500)),
    )
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
    let intruder = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-intruder",
        "Intruder",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination").await;
    pair_peers(&intruder, &destination, "peer-destination").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination", "task-source")
        .await
        .unwrap();

    let endpoint = runtime_endpoint(temp.path(), "peer-destination");
    let owner_epoch = authenticated_request_epoch(&endpoint).await;
    let destination_public_key = destination.local_identity().public_key;
    let abandon_as = |peer_id: &'static str, request_id: &'static str| {
        let identity = stored_runtime_identity(temp.path(), peer_id);
        let sealed_payload = seal_authenticated_transfer_request(
            &identity,
            &destination_public_key,
            "abandon_transfer",
            request_id,
            &owner_epoch,
            current_unix_ms(),
            json!({
                "source_peer_id": peer_id,
                "transfer_id": preflight.transfer_id,
                "reserved_target_peer_id": "peer-destination",
            }),
        );
        json!({
            "type": "abandon_transfer",
            "request_id": request_id,
            "transfer_id": preflight.transfer_id,
            "source_peer_id": peer_id,
            "sealed_payload": sealed_payload,
        })
    };

    let foreign =
        send_raw_peer_value(&endpoint, &abandon_as("peer-intruder", "abandon-foreign")).await;
    assert!(
        peer_error_message(foreign).contains("another source"),
        "a peer that did not reserve the transfer released it",
    );
    assert_eq!(
        replay_json_count(temp.path(), "peer-destination", "incoming-reservations"),
        1,
    );

    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination",
                "task": { "source_task_id": "task-source" },
            }),
        )
        .await
        .unwrap();
    let event = next_incoming_transfer_request(&destination).await;
    assert_eq!(event.transfer_id, preflight.transfer_id);

    let committed =
        send_raw_peer_value(&endpoint, &abandon_as("peer-source", "abandon-committed")).await;
    assert!(
        peer_error_message(committed).contains("already committed"),
        "a committed transfer was released out from under its destination",
    );
    assert_eq!(
        replay_json_count(temp.path(), "peer-destination", "incoming-reservations"),
        1,
    );

    // The source keeps everything it needs to resolve the peer again, because
    // the remote leg is attempted before any local state is dropped.
    let refused = source
        .abandon_outgoing_transfer(&preflight.transfer_id)
        .await
        .expect_err("a refused remote release must not report success");
    assert!(
        refused.to_string().contains("already committed"),
        "unexpected refusal: {refused:?}",
    );
    assert_eq!(
        replay_json_count(temp.path(), "peer-source", "reservations"),
        1,
        "the source dropped the reservation naming the peer it still has to release",
    );
}

/// Taking the artifact records out of the map is what would make a failed
/// deletion unrecoverable — the path is the only handle anyone has on the file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoning_an_outgoing_transfer_reports_and_retries_an_artifact_it_could_not_delete() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let staged = temp.path().join("session.tar.gz");
    std::fs::write(&staged, b"session").unwrap();
    source
        .stage_transfer_artifact("transfer-blocked-artifact", "claude-session", staged, true)
        .await
        .unwrap();
    let owned_artifact = source
        .fetch_transfer_artifact("transfer-blocked-artifact", "claude-session")
        .await
        .unwrap()
        .path;
    std::fs::remove_file(&owned_artifact).unwrap();
    std::fs::create_dir(&owned_artifact).unwrap();

    // No preflight ran, so the reservation half is a clean no-op and the
    // failure can only be the artifact.
    let error = source
        .abandon_outgoing_transfer("transfer-blocked-artifact")
        .await
        .expect_err("abandon claimed success over an artifact it could not delete");
    assert!(
        matches!(error, RuntimeError::Io(_)),
        "unexpected abandon failure: {error:?}",
    );

    std::fs::remove_dir(&owned_artifact).unwrap();
    source
        .abandon_outgoing_transfer("transfer-blocked-artifact")
        .await
        .expect("the undeleted artifact was forgotten instead of retried");
    assert!(!owned_artifact.exists(), "retried artifact stayed on disk");
    assert!(source
        .fetch_transfer_artifact("transfer-blocked-artifact", "claude-session")
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finalize_transfer_authenticates_reserved_target_and_rejects_replay_before_events() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(500)),
    )
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-destination", "Destination", temp.path(), 0)
            .with_peer_response_limits(8 * 1024, 80 * 1024),
    )
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination").await;
    let preflight = source
        .prepare_transfer_preflight("peer-destination", "task-source")
        .await
        .unwrap();
    let endpoint = runtime_endpoint(temp.path(), "peer-source");
    let owner_epoch = authenticated_request_epoch(&endpoint).await;
    let destination_identity = stored_runtime_identity(temp.path(), "peer-destination");
    let source_public_key = source.local_identity().public_key;

    let request = |request_id: &str, transfer_id: &str, authenticated_transfer_id: &str| {
        let sealed_payload = seal_authenticated_transfer_request(
            &destination_identity,
            &source_public_key,
            "finalize_transfer",
            request_id,
            &owner_epoch,
            current_unix_ms(),
            json!({
                "requester_peer_id": "peer-destination",
                "transfer_id": authenticated_transfer_id,
                "reserved_target_peer_id": "peer-destination",
            }),
        );
        json!({
            "type": "finalize_transfer",
            "request_id": request_id,
            "transfer_id": transfer_id,
            "requester_peer_id": "peer-destination",
            "sealed_payload": sealed_payload,
        })
    };

    let forged = send_raw_peer_value(
        &endpoint,
        &request(
            "finalize-forged-transfer",
            &preflight.transfer_id,
            "transfer-someone-else",
        ),
    )
    .await;
    assert!(
        peer_error_message(forged).contains("transfer_id"),
        "forged finalize reached renderer finalization",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), source.next_event())
            .await
            .is_err(),
        "forged finalize emitted renderer work",
    );

    let valid_request = request(
        "finalize-replay",
        &preflight.transfer_id,
        &preflight.transfer_id,
    );
    let endpoint_for_request = endpoint.clone();
    let valid_for_request = valid_request.clone();
    let response = tokio::spawn(async move {
        send_raw_peer_value(&endpoint_for_request, &valid_for_request).await
    });
    let event = loop {
        match source.next_event().await.unwrap() {
            RuntimeEvent::OutgoingTransferFinalizationRequested(event) => break event,
            RuntimeEvent::PairingCompleted(_) => {}
            other => panic!("unexpected event before finalization: {other:?}"),
        }
    };
    assert_eq!(event.transfer_id, preflight.transfer_id);
    source
        .complete_outgoing_transfer_finalization(
            &preflight.transfer_id,
            Ok(kanna_task_transfer::runtime::FinalizedOutgoingTransfer {
                payload: json!({"task": "payload"}),
                finalized_cleanly: true,
            }),
        )
        .await
        .unwrap();
    assert!(matches!(
        response.await.unwrap(),
        PeerResponse::FinalizeTransfer { .. }
    ));

    let replay = send_raw_peer_value(&endpoint, &valid_request).await;
    assert!(peer_error_message(replay).contains("replayed authenticated finalize_transfer"));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), source.next_event())
            .await
            .is_err(),
        "replayed finalize emitted a second renderer event",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_peer_is_session_trusted_and_never_persisted() {
    let temp = tempfile::tempdir().unwrap();
    let identity = TransferIdentity::generate();
    let public_key = public_key_to_string(&identity.public_key);
    let runtime_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0);
    let runtime = TransferRuntime::spawn(runtime_config.clone())
        .await
        .unwrap();

    runtime
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: "127.0.0.1:4456".into(),
            public_key: public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let peer = runtime.find_peer("peer-cloud").await.unwrap();
    assert_eq!(peer.endpoint, "127.0.0.1:4456");
    let listed = runtime
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-cloud")
        .unwrap();
    assert!(listed.trusted);
    assert_eq!(
        runtime
            .peer_routes("peer-cloud")
            .await
            .unwrap()
            .cloud_endpoint,
        Some("127.0.0.1:4456".into())
    );
    assert!(
        !trusted_peer_store_path(temp.path(), "peer-primary").exists(),
        "external trust must remain runtime-only"
    );

    runtime.remove_external_peer("peer-cloud").await.unwrap();
    assert!(runtime.find_peer("peer-cloud").await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_peer_key_rotation_immediately_revokes_old_key() {
    let temp = tempfile::tempdir().unwrap();
    let old_identity = TransferIdentity::generate();
    let old_public_key = public_key_to_string(&old_identity.public_key);
    let new_identity = TransferIdentity::generate();
    let new_public_key = public_key_to_string(&new_identity.public_key);
    let runtime_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0);
    let runtime = TransferRuntime::spawn(runtime_config.clone())
        .await
        .unwrap();

    for public_key in [&old_public_key, &new_public_key] {
        runtime
            .upsert_external_peer(ExternalPeer {
                peer_id: "peer-cloud".into(),
                display_name: "Cloud Mac".into(),
                endpoint: "127.0.0.1:4456".into(),
                public_key: public_key.clone(),
                protocol_version: 1,
                accepting_transfers: true,
            })
            .await
            .unwrap();
    }

    assert!(runtime
        .ensure_peer_is_trusted("peer-cloud", &old_public_key)
        .is_err());
    runtime
        .ensure_peer_is_trusted("peer-cloud", &new_public_key)
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_peer_validation_rejects_unsafe_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let valid_key = public_key_to_string(&TransferIdentity::generate().public_key);

    for peer in [
        ExternalPeer {
            peer_id: " ".into(),
            display_name: "Cloud Mac".into(),
            endpoint: "127.0.0.1:4456".into(),
            public_key: valid_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        },
        ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: "192.168.1.10:4456".into(),
            public_key: valid_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        },
        ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: "127.0.0.1:4456".into(),
            public_key: valid_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        },
        ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: "127.0.0.1:4456".into(),
            public_key: "not-a-key".into(),
            protocol_version: 1,
            accepting_transfers: true,
        },
    ] {
        assert!(runtime.upsert_external_peer(peer).await.is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_peer_merges_lan_and_cloud_routes_and_selects_requested_transport() {
    let temp = tempfile::tempdir().unwrap();
    let identity = TransferIdentity::generate();
    let public_key = public_key_to_string(&identity.public_key);
    let lan_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let lan_endpoint = lan_listener.local_addr().unwrap().to_string();
    let cloud_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let cloud_endpoint = cloud_listener.local_addr().unwrap().to_string();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target LAN".into(),
            endpoint: lan_endpoint.clone(),
            pid: std::process::id(),
            public_key: public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();
    runtime
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-target".into(),
            display_name: "Target Cloud".into(),
            endpoint: cloud_endpoint.clone(),
            public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let routes = runtime.peer_routes("peer-target").await.unwrap();
    assert_eq!(routes.lan_endpoint, Some(lan_endpoint));
    assert_eq!(routes.cloud_endpoint, Some(cloud_endpoint));

    let cloud_server = tokio::spawn(respond_to_preflight(cloud_listener, "transfer-cloud"));
    runtime
        .prepare_transfer_preflight_with_transport(
            "peer-target",
            "task-cloud",
            TransferTransport::Cloud,
        )
        .await
        .unwrap();
    cloud_server.await.unwrap();

    let lan_server = tokio::spawn(respond_to_preflight(lan_listener, "transfer-lan"));
    runtime
        .prepare_transfer_preflight_with_transport(
            "peer-target",
            "task-auto",
            TransferTransport::Auto,
        )
        .await
        .unwrap();
    lan_server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_is_sealed_idempotent_and_emitted_once_for_paired_peers() {
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
    pair_peers(&destination, &source, "peer-source").await;
    consume_pairing_completed(&source).await;

    let first = destination
        .request_task_pull("peer-source", "task-source", TransferTransport::Lan)
        .await
        .unwrap();
    let RuntimeEvent::TaskPullRequested(event) = source.next_event().await.unwrap() else {
        panic!("expected task pull request");
    };
    assert_eq!(event.request_id, first);
    assert_eq!(event.source_task_id, "task-source");
    assert_eq!(event.requester_peer_id, "peer-destination");

    let repeated = destination
        .request_task_pull("peer-source", "task-source", TransferTransport::Lan)
        .await
        .unwrap();
    assert_eq!(repeated, first);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err(),
        "duplicate pull request emitted a second event"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_rejects_stale_and_captured_requests_before_renderer_work() {
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
    pair_peers(&destination, &source, "peer-source").await;
    consume_pairing_completed(&source).await;
    let endpoint = runtime_endpoint(temp.path(), "peer-source");
    let owner_epoch = authenticated_request_epoch(&endpoint).await;
    let stale_payload = seal_authenticated_task_pull(
        temp.path(),
        &source,
        "peer-destination",
        "stale-pull",
        "task-stale",
        &owner_epoch,
        current_unix_ms().saturating_sub(10 * 60 * 1_000),
    );

    let stale = send_raw_task_pull(
        temp.path(),
        "peer-source",
        "stale-pull",
        "peer-destination",
        stale_payload,
    )
    .await;
    assert!(
        matches!(
            stale,
            PeerResponse::Error { ref message, .. }
                if message.contains("stale authenticated request_task_pull request")
        ),
        "unexpected stale task-pull response: {stale:?}",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err(),
        "stale task pull emitted renderer work",
    );

    let captured_payload = seal_authenticated_task_pull(
        temp.path(),
        &source,
        "peer-destination",
        "captured-pull",
        "task-captured",
        &owner_epoch,
        current_unix_ms(),
    );
    assert!(matches!(
        send_raw_task_pull(
            temp.path(),
            "peer-source",
            "captured-pull",
            "peer-destination",
            captured_payload.clone(),
        )
        .await,
        PeerResponse::RequestTaskPull { .. }
    ));
    assert!(matches!(
        source.next_event().await.unwrap(),
        RuntimeEvent::TaskPullRequested(_)
    ));
    let replay = send_raw_task_pull(
        temp.path(),
        "peer-source",
        "captured-pull",
        "peer-destination",
        captured_payload,
    )
    .await;
    assert!(
        matches!(
            replay,
            PeerResponse::Error { ref message, .. }
                if message.contains("replayed authenticated request_task_pull request")
        ),
        "unexpected captured replay response: {replay:?}",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err(),
        "captured task-pull replay emitted renderer work",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_replay_reservation_survives_source_restart() {
    let temp = tempfile::tempdir().unwrap();
    let source_config = RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0);
    let source = TransferRuntime::spawn(source_config.clone()).await.unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&destination, &source, "peer-source").await;
    consume_pairing_completed(&source).await;
    let request_id = "restart-pull";
    let owner_epoch =
        authenticated_request_epoch(&runtime_endpoint(temp.path(), "peer-source")).await;
    let first_payload = seal_authenticated_task_pull(
        temp.path(),
        &source,
        "peer-destination",
        request_id,
        "task-restart",
        &owner_epoch,
        current_unix_ms(),
    );
    assert!(matches!(
        send_raw_task_pull(
            temp.path(),
            "peer-source",
            request_id,
            "peer-destination",
            first_payload,
        )
        .await,
        PeerResponse::RequestTaskPull { .. }
    ));
    assert!(matches!(
        source.next_event().await.unwrap(),
        RuntimeEvent::TaskPullRequested(_)
    ));
    drop(source);

    let restarted = TransferRuntime::spawn(source_config).await.unwrap();
    let restarted_epoch =
        authenticated_request_epoch(&runtime_endpoint(temp.path(), "peer-source")).await;
    let replay_payload = seal_authenticated_task_pull(
        temp.path(),
        &restarted,
        "peer-destination",
        request_id,
        "task-restart",
        &restarted_epoch,
        current_unix_ms(),
    );
    let replay = send_raw_task_pull(
        temp.path(),
        "peer-source",
        request_id,
        "peer-destination",
        replay_payload,
    )
    .await;
    assert!(
        matches!(
            replay,
            PeerResponse::Error { ref message, .. }
                if message.contains("replayed authenticated request_task_pull request")
        ),
        "unexpected restart replay response: {replay:?}",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), restarted.next_event())
            .await
            .is_err(),
        "restart task-pull replay emitted renderer work",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_source_rejects_sustained_unique_requests_at_its_admission_cap() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
            .with_runtime_admission_limits(8, 1, 2),
    )
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
    pair_peers(&destination, &source, "peer-source").await;
    consume_pairing_completed(&source).await;

    destination
        .request_task_pull("peer-source", "task-first", TransferTransport::Lan)
        .await
        .expect("first pull is admitted");
    let RuntimeEvent::TaskPullRequested(_) = source.next_event().await.unwrap() else {
        panic!("expected first task-pull event");
    };

    let error = destination
        .request_task_pull("peer-source", "task-hostile", TransferTransport::Lan)
        .await
        .expect_err("second unique pull must be rejected while first is retained");
    assert!(
        error.to_string().contains("task-pull request capacity 1"),
        "unexpected overload error: {error}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err(),
        "rejected pull must not emit renderer work"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_uses_requested_cloud_route_for_externally_trusted_peers() {
    let source_root = tempfile::tempdir().unwrap();
    let destination_root = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        source_root.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination",
        "Destination",
        destination_root.path(),
        0,
    ))
    .await
    .unwrap();
    let source_identity = source.local_identity();
    let destination_identity = destination.local_identity();

    destination
        .upsert_external_peer(ExternalPeer {
            peer_id: source_identity.peer_id.clone(),
            display_name: source_identity.display_name,
            endpoint: runtime_endpoint(source_root.path(), "peer-source"),
            public_key: source_identity.public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: destination_identity.peer_id.clone(),
            display_name: destination_identity.display_name,
            endpoint: runtime_endpoint(destination_root.path(), "peer-destination"),
            public_key: destination_identity.public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    destination
        .request_task_pull("peer-source", "task-cloud", TransferTransport::Cloud)
        .await
        .unwrap();
    let RuntimeEvent::TaskPullRequested(event) = source.next_event().await.unwrap() else {
        panic!("expected task pull request");
    };
    assert_eq!(event.source_task_id, "task-cloud");
    assert_eq!(event.requester_peer_id, "peer-destination");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_rejects_unknown_peer_self_request_and_unsafe_task_ids() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    assert!(matches!(
        runtime
            .request_task_pull("peer-missing", "task-source", TransferTransport::Auto)
            .await,
        Err(RuntimeError::PeerNotFound(_))
    ));
    for source_task_id in ["", "   ", "task\r\nsmuggled"] {
        assert!(runtime
            .request_task_pull("peer-missing", source_task_id, TransferTransport::Auto)
            .await
            .is_err());
    }
    assert!(runtime
        .request_task_pull("peer-primary", "task-source", TransferTransport::Auto)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_rejects_mismatched_requester_key_without_emitting_event() {
    let source_root = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        source_root.path(),
        0,
    ))
    .await
    .unwrap();
    let expected_requester = TransferIdentity::generate();
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-destination".into(),
            display_name: "Destination".into(),
            endpoint: "127.0.0.1:9".into(),
            public_key: public_key_to_string(&expected_requester.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let rogue_requester = TransferIdentity::generate();
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let sealed_payload = seal_json(
        &rogue_requester,
        &source_public_key,
        &json!({ "source_task_id": "task-source" }),
    )
    .unwrap();
    assert!(matches!(
        send_raw_task_pull(
            source_root.path(),
            "peer-source",
            "rogue-pull",
            "peer-destination",
            sealed_payload,
        )
        .await,
        PeerResponse::Error { .. }
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_listener_rejects_unknown_and_self_requesters_before_decryption() {
    let source_root = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        source_root.path(),
        0,
    ))
    .await
    .unwrap();

    let unknown_error = peer_error_message(
        send_raw_task_pull(
            source_root.path(),
            "peer-source",
            "unknown-pull",
            "peer-unknown",
            "deliberately-not-a-sealed-envelope".into(),
        )
        .await,
    );
    assert!(
        unknown_error.contains("peer not found: peer-unknown"),
        "unknown requester must be rejected before malformed ciphertext is parsed: {unknown_error}"
    );

    let self_error = peer_error_message(
        send_raw_task_pull(
            source_root.path(),
            "peer-source",
            "self-pull",
            "peer-source",
            "deliberately-not-a-sealed-envelope".into(),
        )
        .await,
    );
    assert!(self_error.contains("cannot request a task pull from this runtime"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_listener_rejects_malformed_ciphertext_before_emitting_event() {
    let source_root = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        source_root.path(),
        0,
    ))
    .await
    .unwrap();
    let requester = TransferIdentity::generate();
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-destination".into(),
            display_name: "Destination".into(),
            endpoint: "127.0.0.1:9".into(),
            public_key: public_key_to_string(&requester.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let error = peer_error_message(
        send_raw_task_pull(
            source_root.path(),
            "peer-source",
            "malformed-pull",
            "peer-destination",
            "deliberately-not-a-sealed-envelope".into(),
        )
        .await,
    );
    assert!(error.contains("crypto error"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_pull_listener_rejects_blank_and_control_character_task_ids() {
    let source_root = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        source_root.path(),
        0,
    ))
    .await
    .unwrap();
    let requester = TransferIdentity::generate();
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-destination".into(),
            display_name: "Destination".into(),
            endpoint: "127.0.0.1:9".into(),
            public_key: public_key_to_string(&requester.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let owner_epoch =
        authenticated_request_epoch(&runtime_endpoint(source_root.path(), "peer-source")).await;

    for (request_id, task_id, expected_error) in [
        ("blank-pull", "   ", "must not be blank"),
        (
            "control-pull",
            "task\r\nsmuggled",
            "contains a control character",
        ),
    ] {
        let sealed_payload = seal_json(
            &requester,
            &source_public_key,
            &json!({
                "action": "request_task_pull",
                "request_id": request_id,
                "owner_epoch": owner_epoch,
                "issued_at_unix_ms": current_unix_ms(),
                "requester_peer_id": "peer-destination",
                "source_task_id": task_id,
                "reserved_target_peer_id": "peer-source",
            }),
        )
        .unwrap();
        let error = peer_error_message(
            send_raw_task_pull(
                source_root.path(),
                "peer-source",
                request_id,
                "peer-destination",
                sealed_payload,
            )
            .await,
        );
        assert!(
            error.contains(expected_error),
            "unexpected task ID validation error: {error}"
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), source.next_event())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outgoing_reservation_pins_cloud_route_across_external_peer_updates() {
    let temp = tempfile::tempdir().unwrap();
    let identity = TransferIdentity::generate();
    let public_key = public_key_to_string(&identity.public_key);
    let pinned_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let pinned_endpoint = pinned_listener.local_addr().unwrap().to_string();
    let replacement_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let replacement_endpoint = replacement_listener.local_addr().unwrap().to_string();
    let runtime_config = RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0);
    let runtime = TransferRuntime::spawn(runtime_config.clone())
        .await
        .unwrap();
    runtime
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: pinned_endpoint,
            public_key: public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let pinned_server = tokio::spawn(async move {
        let (reader, request) =
            accept_authenticated_request(&pinned_listener, "pinned-owner-epoch").await;
        let PeerRequest::PrepareTransfer { request_id, .. } = request else {
            panic!("expected preflight");
        };
        let mut stream = reader.into_inner();
        write_peer_response(
            &mut stream,
            &PeerResponse::PrepareTransfer {
                request_id,
                transfer_id: "transfer-pinned".into(),
                source_peer_id: "peer-primary".into(),
                target_has_repo: true,
            },
        )
        .await;

        let (commit, _) = pinned_listener.accept().await.unwrap();
        let mut reader = BufReader::new(commit);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let PeerRequest::SubmitTransferPayload {
            request_id,
            transfer_id,
            ..
        } = serde_json::from_str(line.trim()).unwrap()
        else {
            panic!("expected commit");
        };
        let mut stream = reader.into_inner();
        write_peer_response(
            &mut stream,
            &PeerResponse::SubmitTransferPayload {
                request_id,
                transfer_id,
            },
        )
        .await;
    });

    let preflight = runtime
        .prepare_transfer_preflight_with_transport(
            "peer-cloud",
            "task-source",
            TransferTransport::Cloud,
        )
        .await
        .unwrap();
    drop(runtime);
    let runtime = TransferRuntime::spawn(runtime_config).await.unwrap();
    runtime
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: replacement_endpoint,
            public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    runtime
        .prepare_transfer_commit(&preflight.transfer_id, json!({"task": "payload"}))
        .await
        .unwrap();
    pinned_server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), replacement_listener.accept())
            .await
            .is_err(),
        "commit unexpectedly switched to the replacement route"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_peer_registry_authorizes_inbound_transfer_without_lan_trust() {
    let temp = tempfile::tempdir().unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let registry = PeerRegistry::new(temp.path().to_path_buf());
    let source_entry = registry
        .list_peers("peer-destination")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-source")
        .unwrap();
    let destination_entry = registry
        .list_peers("peer-source")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-destination")
        .unwrap();

    destination
        .upsert_external_peer(ExternalPeer {
            peer_id: source_entry.peer_id.clone(),
            display_name: source_entry.display_name.clone(),
            endpoint: source_entry.endpoint.clone(),
            public_key: source_entry.public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: destination_entry.peer_id.clone(),
            display_name: destination_entry.display_name.clone(),
            endpoint: destination_entry.endpoint.clone(),
            public_key: destination_entry.public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    for peer_id in ["peer-source", "peer-destination"] {
        std::fs::remove_file(
            temp.path()
                .join(format!("{}.json", URL_SAFE_NO_PAD.encode(peer_id))),
        )
        .unwrap();
    }
    assert!(!trusted_peer_store_path(temp.path(), "peer-source").exists());
    assert!(!trusted_peer_store_path(temp.path(), "peer-destination").exists());

    let result = source
        .prepare_transfer_preflight_with_transport(
            "peer-destination",
            "task-source",
            TransferTransport::Cloud,
        )
        .await
        .unwrap();
    assert!(!result.transfer_id.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copied_cloud_peer_identity_does_not_authorize_plaintext_lan_snapshot_access() {
    let temp = tempfile::tempdir().unwrap();
    let copied_identity = TransferIdentity::generate();
    let copied_public_key = public_key_to_string(&copied_identity.public_key);
    let lan_spoof = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let lan_endpoint = lan_spoof.local_addr().unwrap().to_string();
    let cloud_proxy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let cloud_endpoint = cloud_proxy.local_addr().unwrap().to_string();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-cloud".into(),
            display_name: "LAN Spoof".into(),
            endpoint: lan_endpoint,
            pid: std::process::id(),
            public_key: copied_public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();
    runtime
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Real Cloud Mac".into(),
            endpoint: cloud_endpoint,
            public_key: copied_public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let spoof_contact = tokio::spawn(async move {
        let Ok(Ok((stream, _))) =
            tokio::time::timeout(Duration::from_millis(150), lan_spoof.accept()).await
        else {
            return false;
        };
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let PeerRequest::GetTaskSnapshot { request_id, .. } =
            serde_json::from_str(line.trim()).unwrap()
        else {
            panic!("expected task snapshot request");
        };
        let mut stream = reader.into_inner();
        write_peer_response(
            &mut stream,
            &PeerResponse::TaskSnapshot {
                request_id,
                peer_id: "peer-cloud".into(),
                display_name: "LAN Spoof".into(),
                snapshot: json!({"stolen": true}),
            },
        )
        .await;
        true
    });

    let listing = runtime.list_peer_task_snapshots().await.unwrap();
    assert!(listing.snapshots.is_empty());
    assert!(listing.issues.is_empty());
    assert!(
        !spoof_contact.await.unwrap(),
        "plaintext task snapshot was sent using external cloud trust"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_snapshot_polling_never_opens_a_cloud_only_external_route() {
    let temp = tempfile::tempdir().unwrap();
    let cloud_identity = TransferIdentity::generate();
    let cloud_public_key = public_key_to_string(&cloud_identity.public_key);
    let cloud_proxy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let cloud_endpoint = cloud_proxy.local_addr().unwrap().to_string();
    let contacts = std::sync::Arc::new(AtomicU64::new(0));
    let observed_contacts = std::sync::Arc::clone(&contacts);
    let proxy = tokio::spawn(async move {
        while let Ok(Ok((_stream, _))) =
            tokio::time::timeout(Duration::from_millis(250), cloud_proxy.accept()).await
        {
            observed_contacts.fetch_add(1, Ordering::Relaxed);
        }
    });
    let runtime = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(50)),
    )
    .await
    .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            public_key: cloud_public_key.clone(),
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-07-27T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    runtime
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-cloud".into(),
            display_name: "Cloud Mac".into(),
            endpoint: cloud_endpoint,
            public_key: cloud_public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    for _ in 0..2 {
        let listing = runtime.list_peer_task_snapshots().await.unwrap();
        assert!(listing.snapshots.is_empty());
        assert!(listing.issues.is_empty());
    }
    proxy.await.unwrap();

    assert_eq!(
        contacts.load(Ordering::Relaxed),
        0,
        "one-second LAN polling must not amplify into relay proxy connections",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rotated_external_key_rejects_all_pinned_transfer_continuations() {
    let temp = tempfile::tempdir().unwrap();
    let old_target = TransferIdentity::generate();
    let old_public_key = public_key_to_string(&old_target.public_key);
    let new_target = TransferIdentity::generate();
    let new_public_key = public_key_to_string(&new_target.public_key);
    let old_route = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let old_endpoint = old_route.local_addr().unwrap().to_string();
    let replacement_route = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let replacement_endpoint = replacement_route.local_addr().unwrap().to_string();
    let source_config = RuntimeConfig::for_tests("peer-source", "Source", temp.path(), 0)
        .with_peer_request_timeout(Duration::from_millis(50));
    let source = TransferRuntime::spawn(source_config).await.unwrap();
    let source_endpoint = PeerRegistry::new(temp.path().to_path_buf())
        .list_peers("peer-observer")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-source")
        .unwrap()
        .endpoint;
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: old_endpoint,
            public_key: old_public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    let preflight_server = tokio::spawn(respond_to_preflight(old_route, "transfer-pinned-key"));
    source
        .prepare_transfer_preflight_with_transport(
            "peer-target",
            "task-source",
            TransferTransport::Cloud,
        )
        .await
        .unwrap();
    preflight_server.await.unwrap();
    source
        .upsert_external_peer(ExternalPeer {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: replacement_endpoint,
            public_key: new_public_key,
            protocol_version: 1,
            accepting_transfers: true,
        })
        .await
        .unwrap();

    for request in [
        PeerRequest::FinalizeTransfer {
            request_id: "rotate-finalize".into(),
            transfer_id: "transfer-pinned-key".into(),
            requester_peer_id: "peer-target".into(),
            sealed_payload: "not-reached".into(),
        },
        PeerRequest::FetchTransferArtifact {
            request_id: "rotate-artifact".into(),
            transfer_id: "transfer-pinned-key".into(),
            requester_peer_id: "peer-target".into(),
            sealed_payload: "not-reached".into(),
        },
        PeerRequest::ImportCommitted {
            request_id: "rotate-ack".into(),
            transfer_id: "transfer-pinned-key".into(),
            requester_peer_id: "peer-target".into(),
            sealed_payload: "not-reached".into(),
        },
    ] {
        let PeerResponse::Error { message, .. } =
            send_raw_peer_request(&source_endpoint, &request).await
        else {
            panic!("rotated continuation unexpectedly succeeded");
        };
        assert!(
            message.contains("not trusted for cloud transfer"),
            "unexpected continuation error: {message}"
        );
    }
}

async fn respond_to_preflight(listener: TcpListener, transfer_id: &str) {
    let (reader, request) = accept_authenticated_request(&listener, "fixture-owner-epoch").await;
    let PeerRequest::PrepareTransfer { request_id, .. } = request else {
        panic!("expected preflight request");
    };
    let mut stream = reader.into_inner();
    write_peer_response(
        &mut stream,
        &PeerResponse::PrepareTransfer {
            request_id,
            transfer_id: transfer_id.into(),
            source_peer_id: "peer-primary".into(),
            target_has_repo: true,
        },
    )
    .await;
}

async fn write_peer_response(stream: &mut TcpStream, response: &PeerResponse) {
    stream
        .write_all(format!("{}\n", serde_json::to_string(response).unwrap()).as_bytes())
        .await
        .unwrap();
}

async fn send_raw_peer_request(endpoint: &str, request: &PeerRequest) -> PeerResponse {
    let mut stream = TcpStream::connect(endpoint).await.unwrap();
    stream
        .write_all(format!("{}\n", serde_json::to_string(request).unwrap()).as_bytes())
        .await
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_peer_observes_and_interacts_with_visual_companion() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("owner.sqlite");
    let workspace = temp.path().join("owner-worktree");
    create_companion_fixture(&db_path, &workspace);

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0).with_db_path(&db_path),
    )
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&viewer, &owner, "peer-owner").await;

    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-1")
        .await
        .unwrap();
    let initial = next_companion_frame(&viewer).await;
    let ServerFrame::CompanionSnapshot {
        task_id,
        session_id,
        revision,
        source_origin,
        assets,
        ..
    } = initial
    else {
        panic!("expected companion snapshot, got {initial:?}");
    };
    assert_eq!(task_id, "task-1");
    assert_eq!(source_origin.as_deref(), Some("http://localhost:52341"));
    assert_eq!(assets[0].name, "layout.png");

    let event = CompanionEvent {
        session_id: session_id.clone(),
        revision: revision.clone(),
        event_id: "event-1".into(),
        event_type: "click".into(),
        choice: "grid".into(),
        text: "Grid".into(),
        element_id: Some("layout-grid".into()),
        timestamp: 1_784_268_000_000,
    };
    viewer
        .send_peer_companion_event(
            "peer-owner",
            "task-1",
            &session_id,
            &revision,
            "generation-1",
            event.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        next_companion_frame(&viewer).await,
        ServerFrame::CompanionEventResult {
            task_id: "task-1".into(),
            session_id: Some("session-1".into()),
            revision: Some(revision.clone()),
            event_id: "event-1".into(),
            accepted: true,
            code: None,
            message: None,
            attachment_epoch: None,
        },
    );
    let written =
        std::fs::read_to_string(workspace.join(".superpowers/brainstorm/session-1/state/events"))
            .unwrap();
    assert_eq!(
        serde_json::from_str::<CompanionEvent>(written.trim()).unwrap(),
        event,
    );

    viewer
        .send_peer_companion_event(
            "peer-owner",
            "task-1",
            &session_id,
            "stale-revision",
            "generation-1",
            CompanionEvent {
                event_id: "event-stale".into(),
                ..event.clone()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        next_companion_frame(&viewer).await,
        ServerFrame::CompanionEventResult {
            task_id: "task-1".into(),
            session_id: Some("session-1".into()),
            revision: Some("stale-revision".into()),
            event_id: "event-stale".into(),
            accepted: false,
            code: Some("stale_revision".into()),
            message: Some("Refresh the visual companion and try again.".into()),
            attachment_epoch: None,
        },
    );

    std::fs::write(
        workspace.join(".superpowers/brainstorm/session-1/content/screen.html"),
        "<h2>Updated layout</h2>",
    )
    .unwrap();
    let updated = next_companion_frame(&viewer).await;
    let ServerFrame::CompanionSnapshot {
        revision: updated_revision,
        html,
        ..
    } = updated
    else {
        panic!("expected updated companion snapshot");
    };
    assert_ne!(updated_revision, revision);
    assert_eq!(html, "<h2>Updated layout</h2>");

    std::fs::remove_dir_all(workspace.join(".superpowers")).unwrap();
    assert_eq!(
        next_companion_frame(&viewer).await,
        ServerFrame::CompanionUnavailable {
            task_id: "task-1".into(),
            attachment_epoch: None,
        },
    );

    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-2")
        .await
        .unwrap();
    assert_eq!(
        next_companion_frame(&viewer).await,
        ServerFrame::CompanionUnavailable {
            task_id: "task-1".into(),
            attachment_epoch: None,
        },
    );
    wait_for_companion_counts(&viewer, &owner, 1, 1).await;
    assert_eq!(owner.owner_companion_observer_count().await, 1);
    let stale_generation_error = viewer
        .send_peer_companion_event(
            "peer-owner",
            "task-1",
            &session_id,
            &revision,
            "generation-1",
            CompanionEvent {
                event_id: "event-stale-generation".into(),
                ..event.clone()
            },
        )
        .await
        .unwrap_err();
    assert!(stale_generation_error
        .to_string()
        .contains("observation is not active"));
    viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-2")
        .await
        .unwrap();
    wait_for_companion_counts(&viewer, &owner, 0, 0).await;
    assert_eq!(owner.owner_companion_observer_count().await, 0);
    let no_observation_error = viewer
        .send_peer_companion_event(
            "peer-owner",
            "task-1",
            &session_id,
            &revision,
            "generation-2",
            CompanionEvent {
                event_id: "event-after-close".into(),
                ..event
            },
        )
        .await
        .unwrap_err();
    assert!(no_observation_error
        .to_string()
        .contains("observation is not active"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multiple_viewers_share_and_release_one_owner_companion_scan_source() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("owner.sqlite");
    let workspace = temp.path().join("owner-worktree");
    create_companion_fixture(&db_path, &workspace);

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0).with_db_path(&db_path),
    )
    .await
    .unwrap();
    let first_viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer-a",
        "Viewer A",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let second_viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer-b",
        "Viewer B",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&first_viewer, &owner, "peer-owner").await;
    pair_peers(&second_viewer, &owner, "peer-owner").await;

    first_viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-a")
        .await
        .unwrap();
    second_viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-b")
        .await
        .unwrap();
    let first = next_companion_frame(&first_viewer).await;
    let second = next_companion_frame(&second_viewer).await;
    let (
        ServerFrame::CompanionSnapshot {
            revision: first_revision,
            ..
        },
        ServerFrame::CompanionSnapshot {
            revision: second_revision,
            ..
        },
    ) = (first, second)
    else {
        panic!("both viewers must receive the shared snapshot");
    };
    assert_eq!(first_revision, second_revision);
    assert_eq!(owner.owner_companion_source_count().await, 1);

    first_viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-a")
        .await
        .unwrap();
    assert_eq!(owner.owner_companion_source_count().await, 1);
    second_viewer
        .unobserve_peer_companion("peer-owner", "task-1", "generation-b")
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        // Removing the source signals its poller; the poller releases retained
        // frame bytes asynchronously when it observes that cancellation.
        while owner.owner_companion_source_count().await != 0
            || owner.owner_companion_retained_bytes() != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the final observer must release the shared source");
    assert_eq!(owner.owner_companion_retained_bytes(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_owner_limits_companion_events_at_ksp_boundary_and_resets_on_new_generation() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("owner.sqlite");
    let workspace = temp.path().join("owner-worktree");
    create_companion_fixture(&db_path, &workspace);
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0).with_db_path(&db_path),
    )
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&viewer, &owner, "peer-owner").await;
    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-rate-1")
        .await
        .unwrap();
    let ServerFrame::CompanionSnapshot {
        session_id,
        revision,
        ..
    } = next_companion_frame(&viewer).await
    else {
        panic!("expected companion snapshot");
    };

    for index in 0..30 {
        viewer
            .send_peer_companion_event(
                "peer-owner",
                "task-1",
                &session_id,
                &revision,
                "generation-rate-1",
                companion_event(&format!("rate-{index}")),
            )
            .await
            .unwrap();
        let ServerFrame::CompanionEventResult { accepted, .. } =
            next_companion_frame(&viewer).await
        else {
            panic!("expected companion event result");
        };
        assert!(
            accepted,
            "event {index} should be inside the 30-event window"
        );
    }

    viewer
        .send_peer_companion_event(
            "peer-owner",
            "task-1",
            &session_id,
            &revision,
            "generation-rate-1",
            companion_event("rate-30"),
        )
        .await
        .unwrap();
    assert_eq!(
        next_companion_frame(&viewer).await,
        ServerFrame::CompanionEventResult {
            task_id: "task-1".into(),
            session_id: Some("session-1".into()),
            revision: Some(revision.clone()),
            event_id: "rate-30".into(),
            accepted: false,
            code: Some("companion_rate_limited".into()),
            message: Some("Too many visual companion selections were sent.".into()),
            attachment_epoch: None,
        },
    );

    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-rate-2")
        .await
        .unwrap();
    let _ = next_companion_frame(&viewer).await;
    viewer
        .send_peer_companion_event(
            "peer-owner",
            "task-1",
            &session_id,
            &revision,
            "generation-rate-2",
            companion_event("new-generation"),
        )
        .await
        .unwrap();
    let ServerFrame::CompanionEventResult { accepted, .. } = next_companion_frame(&viewer).await
    else {
        panic!("expected companion event result");
    };
    assert!(accepted);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claimed_trusted_peer_without_key_proof_cannot_observe_or_send_companion_events() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&viewer, &owner, "peer-owner").await;
    let endpoint = viewer
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap()
        .endpoint;

    let observe = PeerRequest::ObserveCompanion {
        request_id: "forged-observe".into(),
        requester_peer_id: "peer-viewer".into(),
        sealed_payload: "not-a-sealed-proof".into(),
    };
    let observe_response = send_raw_peer_request(&endpoint, &observe).await;
    assert!(matches!(
        observe_response,
        PeerResponse::Error { message, .. } if message.contains("json error")
    ));

    let send = PeerRequest::SendCompanionEvent {
        request_id: "forged-send".into(),
        requester_peer_id: "peer-viewer".into(),
        sealed_payload: "not-a-sealed-payload".into(),
    };
    let send_response = send_raw_peer_request(&endpoint, &send).await;
    assert!(matches!(
        send_response,
        PeerResponse::Error { message, .. } if message.contains("json error")
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_accepts_max_transfer_request_and_rejects_oversized_or_incomplete_ingress() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let endpoint = PeerRegistry::new(temp.path().to_path_buf())
        .list_peers("attacker")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap()
        .endpoint;

    let empty_transfer = PeerRequest::SubmitTransferPayload {
        request_id: "max-transfer".into(),
        transfer_id: "transfer-1".into(),
        sealed_payload: String::new(),
    };
    let empty_transfer_len = serde_json::to_vec(&empty_transfer).unwrap().len();
    let max_transfer = PeerRequest::SubmitTransferPayload {
        request_id: "max-transfer".into(),
        transfer_id: "transfer-1".into(),
        sealed_payload: "A".repeat(MAX_PEER_REQUEST_LINE_BYTES - empty_transfer_len),
    };
    assert_eq!(
        serde_json::to_vec(&max_transfer).unwrap().len(),
        MAX_PEER_REQUEST_LINE_BYTES
    );
    assert!(
        matches!(
            send_raw_peer_request(&endpoint, &max_transfer).await,
            PeerResponse::Error { request_id, .. } if request_id == "max-transfer"
        ),
        "a maximum-size transfer payload request should reach protocol handling"
    );

    let mut oversized =
        br#"{"type":"observe_companion","request_id":"oversized","requester_peer_id":"attacker","sealed_payload":""#
            .to_vec();
    oversized.resize(MAX_COMPANION_REQUEST_LINE_BYTES + 1, b'x');
    oversized.push(b'\n');
    assert!(
        send_inbound_bytes(&endpoint, &oversized).await.is_empty(),
        "oversized unauthenticated request should be closed without a response"
    );

    let mut reordered =
        br#"{"request_id":"reordered-oversized","requester_peer_id":"attacker","type":"observe_companion","sealed_payload":""#
            .to_vec();
    reordered.resize(MAX_COMPANION_REQUEST_LINE_BYTES + 1, b'x');
    reordered.push(b'\n');
    assert!(
        send_inbound_bytes(&endpoint, &reordered).await.is_empty(),
        "reordering a companion request must not bypass the companion ingress limit"
    );

    let mut newline_free =
        br#"{"type":"send_companion_event","request_id":"newline-free","requester_peer_id":"attacker","sealed_payload":""#
            .to_vec();
    newline_free.resize(MAX_COMPANION_REQUEST_LINE_BYTES, b'x');
    assert!(
        send_inbound_bytes(&endpoint, &newline_free)
            .await
            .is_empty(),
        "partial unauthenticated request should be closed without a response"
    );

    assert!(matches!(
        send_raw_peer_request(
            &endpoint,
            &PeerRequest::SendCompanionEvent {
                request_id: "listener-still-responsive".into(),
                requester_peer_id: "attacker".into(),
                sealed_payload: "invalid".into(),
            },
        )
        .await,
        PeerResponse::Error { .. }
    ));
    drop(owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_preauth_connections_time_out_and_do_not_starve_next_request() {
    let temp = tempfile::tempdir().unwrap();
    let request_timeout = Duration::from_millis(100);
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_peer_request_timeout(request_timeout),
    )
    .await
    .unwrap();
    let endpoint = PeerRegistry::new(temp.path().to_path_buf())
        .list_peers("attacker")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap()
        .endpoint;

    let mut stalled = Vec::new();
    for index in 0..16 {
        let mut stream = TcpStream::connect(&endpoint).await.unwrap();
        if index % 2 == 1 {
            stream
                .write_all(br#"{"type":"send_companion_event""#)
                .await
                .unwrap();
        }
        stalled.push(stream);
    }

    tokio::time::sleep(Duration::from_millis(20)).await;
    let healthy = tokio::time::timeout(
        Duration::from_secs(1),
        send_raw_peer_request(
            &endpoint,
            &PeerRequest::SendCompanionEvent {
                request_id: "healthy-after-stalls".into(),
                requester_peer_id: "attacker".into(),
                sealed_payload: "invalid".into(),
            },
        ),
    )
    .await
    .expect("a queued healthy request should proceed after stalled reads time out");
    assert!(matches!(healthy, PeerResponse::Error { .. }));

    for mut stream in stalled {
        let mut byte = [0_u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut byte))
            .await
            .expect("stalled connection should be closed after the pre-auth deadline")
            .unwrap();
        assert_eq!(read, 0);
    }
    drop(owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_max_size_unauthenticated_requests_remain_limited_until_protocol_decision() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(
        // Every one of the sixteen pre-auth permits has to still be held when
        // the count is read below, so this must outlast draining all sixteen
        // events. At 10s a loaded box expired two of them mid-drain and the
        // count came back 14.
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_secs(120)),
    )
    .await
    .unwrap();
    let endpoint = PeerRegistry::new(temp.path().to_path_buf())
        .list_peers("attacker")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap()
        .endpoint;

    let max_pairing_request = |index: usize| {
        let request_id = format!("max-pair-{index:02}");
        let empty = PeerRequest::StartPairing {
            request_id: request_id.clone(),
            source_peer_id: format!("attacker-{index:02}"),
            source_display_name: "Attacker".into(),
            source_public_key: "not-a-public-key".into(),
            capabilities_json: String::new(),
        };
        let empty_len = serde_json::to_vec(&empty).unwrap().len();
        let request = PeerRequest::StartPairing {
            request_id,
            source_peer_id: format!("attacker-{index:02}"),
            source_display_name: "Attacker".into(),
            source_public_key: "not-a-public-key".into(),
            capabilities_json: "A".repeat(MAX_PEER_REQUEST_LINE_BYTES - empty_len),
        };
        assert_eq!(
            serde_json::to_vec(&request).unwrap().len(),
            MAX_PEER_REQUEST_LINE_BYTES
        );
        request
    };

    let mut clients = Vec::new();
    for index in 0..16 {
        let endpoint = endpoint.clone();
        let request = max_pairing_request(index);
        clients.push(tokio::spawn(async move {
            send_raw_peer_request(&endpoint, &request).await
        }));
    }

    let mut pairing_request_ids = Vec::new();
    for _ in 0..16 {
        let event = tokio::time::timeout(Duration::from_secs(60), owner.next_event())
            .await
            .expect("all sixteen permitted requests should reach pairing policy")
            .unwrap();
        let RuntimeEvent::PairingRequested(event) = event else {
            panic!("expected pairing request");
        };
        pairing_request_ids.push(event.request_id);
    }
    assert_eq!(
        owner.active_preauth_request_count(),
        16,
        "complete parsed requests must retain all sixteen pre-auth permits while awaiting policy"
    );

    let endpoint_for_queued = endpoint.clone();
    let queued_request = max_pairing_request(16);
    clients.push(tokio::spawn(async move {
        send_raw_peer_request(&endpoint_for_queued, &queued_request).await
    }));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), owner.next_event())
            .await
            .is_err(),
        "the seventeenth complete request must wait for a pre-auth permit"
    );

    owner.reject_pairing(&pairing_request_ids[0]).await.unwrap();
    let released_event = tokio::time::timeout(Duration::from_secs(30), owner.next_event())
        .await
        .expect("releasing any protocol decision should admit the queued request")
        .unwrap();
    assert!(matches!(
        released_event,
        RuntimeEvent::PairingRequested(event) if event.peer_id == "attacker-16"
    ));
    assert_eq!(owner.active_preauth_request_count(), 16);

    for client in clients {
        client.abort();
    }
    drop(owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_long_lived_companion_streams_release_preauth_capacity() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("owner.sqlite");
    let workspace = temp.path().join("owner-worktree");
    create_companion_fixture(&db_path, &workspace);
    let db = rusqlite::Connection::open(&db_path).unwrap();
    for index in 2..=16 {
        db.execute(
            "INSERT INTO pipeline_item (id, branch) VALUES (?, ?)",
            [format!("task-{index}"), format!("task-task-{index}")],
        )
        .unwrap();
        db.execute(
            "INSERT INTO worktree (id, pipeline_item_id, path, branch)
             VALUES (?, ?, ?, ?)",
            [
                format!("wt-{index}"),
                format!("task-{index}"),
                workspace.to_string_lossy().into_owned(),
                format!("task-task-{index}"),
            ],
        )
        .unwrap();
    }
    drop(db);

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0).with_db_path(&db_path),
    )
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&viewer, &owner, "peer-owner").await;

    for index in 1..=16 {
        viewer
            .observe_peer_companion(
                "peer-owner",
                &format!("task-{index}"),
                &format!("generation-{index}"),
            )
            .await
            .unwrap();
    }
    wait_for_companion_counts(&viewer, &owner, 16, 16).await;
    assert_eq!(
        owner.active_preauth_request_count(),
        0,
        "verified and registered long-lived streams must release pre-auth permits"
    );

    let endpoint = PeerRegistry::new(temp.path().to_path_buf())
        .list_peers("control-client")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap()
        .endpoint;
    let response = tokio::time::timeout(
        Duration::from_secs(1),
        send_raw_peer_request(
            &endpoint,
            &PeerRequest::GetTaskSnapshot {
                request_id: "control-after-streams".into(),
                requester_peer_id: "peer-viewer".into(),
                sealed_payload: None,
            },
        ),
    )
    .await
    .expect("authenticated companion streams must not retain pre-auth permits");
    // A prompt reply of any kind proves the listener still had pre-auth
    // capacity; under the authenticated-request contract an unsealed snapshot
    // request is answered with an error rather than a snapshot.
    match response {
        PeerResponse::TaskSnapshot { request_id, .. } | PeerResponse::Error { request_id, .. } => {
            assert_eq!(request_id, "control-after-streams")
        }
        other => panic!("expected a prompt response, got {other:?}"),
    }
    drop(viewer);
    drop(owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captured_observe_and_send_fail_across_owner_restart_with_fresh_challenge() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("owner.sqlite");
    let workspace = temp.path().join("owner-worktree");
    create_companion_fixture(&db_path, &workspace);

    let port_probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let owner_port = port_probe.local_addr().unwrap().port();
    drop(port_probe);
    let owner_config = RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), owner_port)
        .with_db_path(&db_path);
    let viewer_identity = TransferIdentity::generate();
    let viewer_public_key = public_key_to_string(&viewer_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-viewer".into(),
            display_name: "Viewer".into(),
            endpoint: "127.0.0.1:9".into(),
            pid: std::process::id(),
            public_key: viewer_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let owner = TransferRuntime::spawn(owner_config.clone()).await.unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-owner"))
        .upsert(PeerRecord {
            peer_id: "peer-viewer".into(),
            display_name: "Viewer".into(),
            public_key: viewer_public_key,
            capabilities_json: "{\"protocolVersion\":2,\"companionCapabilityVersion\":1}".into(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let owner_entry = PeerRegistry::new(temp.path().to_path_buf())
        .list_peers("peer-viewer")
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap();
    let owner_public = parse_public_key(&owner_entry.public_key).unwrap();
    let stream_nonce = URL_SAFE_NO_PAD.encode([3_u8; 24]);
    let observe_request_id = "captured-observe";
    let sealed_observe = seal_json(
        &viewer_identity,
        &owner_public,
        &json!({
            "operation": "observe_companion",
            "request_id": observe_request_id,
            "requester_peer_id": "peer-viewer",
            "task_id": "task-1",
            "generation": "captured-generation",
            "session_id": null,
            "revision": null,
            "event": null,
            "stream_nonce": stream_nonce,
            "observation_challenge": null,
            "sequence": 0,
            "nonce": URL_SAFE_NO_PAD.encode([4_u8; 24]),
            "issued_at_ms": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        }),
    )
    .unwrap();
    let captured_observe = PeerRequest::ObserveCompanion {
        request_id: observe_request_id.into(),
        requester_peer_id: "peer-viewer".into(),
        sealed_payload: sealed_observe,
    };
    let captured_observe_wire = serde_json::to_string(&captured_observe).unwrap();
    assert!(!captured_observe_wire.contains("task-1"));
    assert!(!captured_observe_wire.contains("captured-generation"));

    let (mut first_observation, first_ack) =
        send_raw_observe(&owner_entry.endpoint, &captured_observe).await;
    let PeerResponse::ObserveCompanion {
        sealed_payload: first_ack,
        ..
    } = first_ack
    else {
        panic!("expected first sealed companion ACK");
    };
    let first_ack_wire = serde_json::to_string(&first_ack).unwrap();
    let first_ack = open_json(&viewer_identity, &owner_public, &first_ack).unwrap();
    let first_challenge = first_ack["observation_challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!first_ack_wire.contains(&first_challenge));

    let send_request_id = "captured-send";
    let captured_send = PeerRequest::SendCompanionEvent {
        request_id: send_request_id.into(),
        requester_peer_id: "peer-viewer".into(),
        sealed_payload: seal_json(
            &viewer_identity,
            &owner_public,
            &json!({
                "operation": "send_companion_event",
                "request_id": send_request_id,
                "requester_peer_id": "peer-viewer",
                "task_id": "task-1",
                "generation": "captured-generation",
                "session_id": "session-1",
                "revision": "captured-revision",
                "event": companion_event("captured-event"),
                "stream_nonce": stream_nonce,
                "observation_challenge": first_challenge,
                "sequence": 1,
                "nonce": URL_SAFE_NO_PAD.encode([5_u8; 24]),
                "issued_at_ms": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            }),
        )
        .unwrap(),
    };
    assert!(matches!(
        send_raw_peer_request(&owner_entry.endpoint, &captured_send).await,
        PeerResponse::SendCompanionEvent { .. }
    ));

    first_observation.shutdown().await.unwrap();
    drop(first_observation);
    drop(owner);
    tokio::time::sleep(Duration::from_millis(50)).await;

    let restarted_owner = TransferRuntime::spawn(owner_config).await.unwrap();
    let (second_observation, second_ack) =
        send_raw_observe(&owner_entry.endpoint, &captured_observe).await;
    let PeerResponse::ObserveCompanion {
        sealed_payload: second_ack,
        ..
    } = second_ack
    else {
        panic!("expected restarted sealed companion ACK");
    };
    let attacker = TransferIdentity::generate();
    assert!(open_json(&attacker, &owner_public, &second_ack).is_err());
    let second_ack = open_json(&viewer_identity, &owner_public, &second_ack).unwrap();
    let second_challenge = second_ack["observation_challenge"].as_str().unwrap();
    assert_ne!(second_challenge, first_challenge);

    assert!(matches!(
        send_raw_peer_request(&owner_entry.endpoint, &captured_send).await,
        PeerResponse::Error { message, .. }
            if message.contains("observation is not active")
    ));
    assert_eq!(restarted_owner.active_owner_companion_count(), 1);
    drop(second_observation);
}

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
async fn pending_unauthenticated_pairing_admission_is_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let target = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-target", "Target", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(250))
            .with_runtime_admission_limits(1, 8, 2),
    )
    .await
    .unwrap();
    let first = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-first",
        "First",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let second = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-second",
        "Second",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let first_pairing = tokio::spawn(async move { first.start_pairing("peer-target").await });
    let RuntimeEvent::PairingRequested(first_request) = target.next_event().await.unwrap() else {
        panic!("expected first pairing request");
    };

    let second_error = second
        .start_pairing("peer-target")
        .await
        .expect_err("pending unauthenticated pairing admission must be bounded");
    assert!(
        second_error
            .to_string()
            .contains("pending pairing request capacity 1"),
        "unexpected pairing admission error: {second_error}",
    );
    target
        .reject_pairing(&first_request.request_id)
        .await
        .unwrap();
    assert!(first_pairing.await.unwrap().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saturated_pairing_event_enqueue_does_not_retain_pending_admission() {
    let temp = tempfile::tempdir().unwrap();
    let target = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-target", "Target", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(250))
            .with_runtime_admission_limits(1, 8, 2),
    )
    .await
    .unwrap();
    let seed = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-seed", "Seed", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(250)),
    )
    .await
    .unwrap();
    pair_peers(&seed, &target, "peer-target").await;
    consume_pairing_completed(&target).await;
    seed.request_task_pull("peer-target", "task-fill", TransferTransport::Lan)
        .await
        .expect("fill target lifecycle channel");

    let saturated = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-saturated", "Saturated", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(250)),
    )
    .await
    .unwrap();
    let saturated_error = saturated
        .start_pairing("peer-target")
        .await
        .expect_err("full lifecycle channel must reject pairing enqueue");
    assert!(
        saturated_error
            .to_string()
            .contains("incoming event channel closed"),
        "unexpected saturated enqueue error: {saturated_error}",
    );
    assert!(matches!(
        target.next_event().await.unwrap(),
        RuntimeEvent::TaskPullRequested(_)
    ));

    let retry = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-retry", "Retry", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(250)),
    )
    .await
    .unwrap();
    let retry_pairing = tokio::spawn(async move { retry.start_pairing("peer-target").await });
    let request = tokio::time::timeout(Duration::from_secs(10), target.next_event())
        .await
        .expect("cleaned pairing admission should allow retry")
        .unwrap();
    let RuntimeEvent::PairingRequested(request) = request else {
        panic!("expected retry pairing request");
    };
    target.reject_pairing(&request.request_id).await.unwrap();
    assert!(retry_pairing.await.unwrap().is_err());
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
            protocol_version: 2,
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
    let legacy_identity = TransferIdentity::generate();
    let legacy_public_key = public_key_to_string(&legacy_identity.public_key);

    let registry = PeerRegistry::new(temp.path().to_path_buf());
    registry
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{spoofing_port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    registry
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-a-legacy".into(),
            display_name: "Legacy".into(),
            endpoint: "127.0.0.1:1".into(),
            pid: std::process::id(),
            public_key: legacy_public_key.clone(),
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
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let peer_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    peer_store
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    peer_store
        .upsert(PeerRecord {
            peer_id: "peer-a-legacy".into(),
            display_name: "Legacy".into(),
            public_key: legacy_public_key,
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
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let spoofing_server = tokio::spawn(async move {
        let (mut reader, request) =
            accept_authenticated_request(&spoofing_listener, "spoofing-owner-epoch").await;
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
        reader
            .get_mut()
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
    });

    let honest_server = tokio::spawn(async move {
        let (mut reader, request) =
            accept_authenticated_request(&honest_listener, "honest-owner-epoch").await;
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
        reader
            .get_mut()
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

    let listing = primary.list_peer_task_snapshots().await.unwrap();
    let snapshots = listing.snapshots;
    assert_eq!(
        snapshots.len(),
        1,
        "expected only the honest peer snapshot: {snapshots:?}"
    );
    assert_eq!(listing.issues.len(), 2);
    assert!(listing.issues.iter().any(|issue| {
        issue.peer_id == "peer-a-legacy" && issue.message.contains("upgrade and re-pair")
    }));
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
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: public_key_to_string(&target_identity.public_key),
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let server = tokio::spawn(async move {
        let (mut reader, request) =
            accept_authenticated_request(&listener, "observe-owner-epoch").await;
        assert!(matches!(request, PeerRequest::ObserveSession { .. }));
        reader.get_mut().write_all(b"\n").await.unwrap();
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
        .observe_peer_session("peer-target", "task-1", "lease-task-1")
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_sender_refuses_terminal_input_on_an_active_shipped_v4_observer_stream() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Shipped v4 Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 4,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Shipped v4 Target".into(),
            public_key: target_public_key,
            capabilities_json:
                "{\"protocolVersion\":4,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-08-11T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let server = tokio::spawn(async move {
        let (mut reader, request) =
            accept_authenticated_request(&listener, "v4-duplex-owner-epoch").await;
        let PeerRequest::ObserveSession {
            request_id,
            session_id,
            ..
        } = request
        else {
            panic!("expected observe session request");
        };
        reader
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&PeerResponse::ObserveSession {
                        request_id,
                        session_id: session_id.clone(),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        reader
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&PeerTerminalEvent::Snapshot {
                        session_id,
                        snapshot: json!({ "vt": "READY", "cols": 80, "rows": 24 }),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let mut control_line = String::new();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(250),
                reader.read_line(&mut control_line),
            )
            .await
            .is_err(),
            "current sender wrote terminal control onto a shipped-v4 observer stream: {control_line}",
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err(),
            "current sender fell back to a per-request shipped-v4 terminal input",
        );
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
        .observe_peer_session("peer-target", "task-1", "lease-task-1")
        .await
        .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(1), primary.next_event())
        .await
        .expect("timed out waiting for shipped-v4 terminal snapshot")
        .unwrap();
    assert!(matches!(
        ready,
        RuntimeEvent::TerminalEvent {
            event: PeerTerminalEvent::Snapshot { .. },
            ..
        }
    ));

    for (data, submission_boundary, control_input) in [
        (b"human draft".to_vec(), false, false),
        (b"\r".to_vec(), true, false),
        (b"\x1b[<65;1;1M".to_vec(), false, true),
    ] {
        let error = primary
            .send_peer_session_input(
                "peer-target",
                "task-1",
                data,
                submission_boundary,
                control_input,
            )
            .await
            .expect_err("shipped-v4 terminal input was accepted");
        assert!(
            error.to_string().contains("protocol v4")
                && error
                    .to_string()
                    .contains("explicit terminal submission/control semantics"),
            "unexpected mixed-version error: {error}",
        );
    }

    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_v5_terminal_input_uses_the_authenticated_observer_stream() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: CURRENT_PROTOCOL_VERSION,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json: json!({
                "protocolVersion": CURRENT_PROTOCOL_VERSION,
                "authenticatedTaskRequests": true,
                "authenticatedTaskRequestVersion": 1,
            })
            .to_string(),
            paired_at: "2026-08-11T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let server = tokio::spawn(async move {
        let (mut reader, request) =
            accept_authenticated_request(&listener, "duplex-owner-epoch").await;
        let PeerRequest::ObserveSession {
            request_id,
            session_id,
            ..
        } = request
        else {
            panic!("expected observe session request");
        };
        let response = PeerResponse::ObserveSession {
            request_id,
            session_id: session_id.clone(),
        };
        reader
            .get_mut()
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
        let snapshot = PeerTerminalEvent::Snapshot {
            session_id,
            snapshot: json!({ "vt": "READY", "cols": 80, "rows": 24 }),
        };
        reader
            .get_mut()
            .write_all(format!("{}\n", serde_json::to_string(&snapshot).unwrap()).as_bytes())
            .await
            .unwrap();

        let mut controls = Vec::new();
        for _ in 0..3 {
            let mut control_line = String::new();
            reader.read_line(&mut control_line).await.unwrap();
            controls
                .push(serde_json::from_str::<PeerTerminalControl>(control_line.trim()).unwrap());
        }
        let opened_another_connection =
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_ok();
        (controls, opened_another_connection)
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
        .observe_peer_session("peer-target", "task-1", "lease-task-1")
        .await
        .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(1), primary.next_event())
        .await
        .expect("timed out waiting for terminal snapshot")
        .unwrap();
    assert!(matches!(
        ready,
        RuntimeEvent::TerminalEvent {
            event: PeerTerminalEvent::Snapshot { .. },
            ..
        }
    ));

    tokio::time::timeout(Duration::from_millis(250), async {
        primary
            .send_peer_session_input(
                "peer-target",
                "task-1",
                b"human draft".to_vec(),
                false,
                false,
            )
            .await?;
        primary
            .send_peer_session_input("peer-target", "task-1", b"\r".to_vec(), true, false)
            .await?;
        primary
            .send_peer_session_input(
                "peer-target",
                "task-1",
                b"\x1b[<65;1;1M".to_vec(),
                false,
                true,
            )
            .await
    })
    .await
    .expect("duplex terminal input waited for a remote acknowledgement")
    .unwrap();

    let (controls, opened_another_connection) = server.await.unwrap();
    assert_eq!(
        controls,
        vec![
            PeerTerminalControl::Input {
                session_id: "task-1".into(),
                data: b"human draft".to_vec(),
                submission_boundary: false,
                control_input: false,
            },
            PeerTerminalControl::Input {
                session_id: "task-1".into(),
                data: b"\r".to_vec(),
                submission_boundary: true,
                control_input: false,
            },
            PeerTerminalControl::Input {
                session_id: "task-1".into(),
                data: b"\x1b[<65;1;1M".to_vec(),
                submission_boundary: false,
                control_input: true,
            },
        ]
    );
    assert!(
        !opened_another_connection,
        "terminal input opened a per-keystroke peer request instead of using the observer stream"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_owner_refuses_shipped_v4_duplex_and_fallback_input_before_daemon_access() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let legacy = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-legacy",
        "Shipped v4 Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&legacy, &owner, "peer-owner").await;

    let owner_peer = legacy
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap();
    let legacy_peer = owner
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-legacy")
        .unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: legacy_peer.peer_id,
            display_name: legacy_peer.display_name,
            endpoint: legacy_peer.endpoint,
            pid: legacy_peer.pid,
            public_key: legacy_peer.public_key,
            protocol_version: 4,
            accepting_transfers: legacy_peer.accepting_transfers,
        })
        .unwrap();

    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;
    let legacy_identity = stored_runtime_identity(temp.path(), "peer-legacy");
    let observe_payload = seal_authenticated_transfer_request(
        &legacy_identity,
        &owner_peer.public_key,
        "observe_session",
        "legacy-observe",
        &owner_epoch,
        current_unix_ms(),
        json!({ "session_id": "task-with-draft" }),
    );
    let observe = send_raw_peer_value(
        &owner_peer.endpoint,
        &json!({
            "type": "observe_session",
            "request_id": "legacy-observe",
            "requester_peer_id": "peer-legacy",
            "session_id": "task-with-draft",
            "sealed_payload": observe_payload,
        }),
    )
    .await;
    assert!(
        matches!(
            observe,
            PeerResponse::Error { ref message, .. }
                if message.contains("protocol v4")
                    && message.contains("duplex terminal control")
        ),
        "shipped-v4 duplex observation reached the daemon boundary: {observe:?}",
    );

    let input_payload = seal_authenticated_transfer_request(
        &legacy_identity,
        &owner_peer.public_key,
        "send_session_input",
        "legacy-input",
        &owner_epoch,
        current_unix_ms(),
        json!({
            "session_id": "task-with-draft",
            "data": [13],
        }),
    );
    let input = send_raw_peer_value(
        &owner_peer.endpoint,
        &json!({
            "type": "send_session_input",
            "request_id": "legacy-input",
            "requester_peer_id": "peer-legacy",
            "session_id": "task-with-draft",
            "data": [13],
            "sealed_payload": input_payload,
        }),
    )
    .await;
    assert!(
        matches!(
            input,
            PeerResponse::Error { ref message, .. }
                if message.contains("protocol v4")
                    && message.contains("explicit terminal submission/control semantics")
        ),
        "shipped-v4 fallback input reached the daemon boundary: {input:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_input_rejects_authenticated_true_to_false_semantics_before_daemon_access() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_dir = temp.path().join("daemon");
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let daemon_socket = kanna_runtime_defaults::socket_path(&daemon_dir);
    let daemon_listener = UnixListener::bind(&daemon_socket).unwrap();
    let daemon_contacts = std::sync::Arc::new(AtomicU64::new(0));
    let observed_contacts = std::sync::Arc::clone(&daemon_contacts);
    let daemon_probe = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = daemon_listener.accept().await else {
                return;
            };
            observed_contacts.fetch_add(1, Ordering::Relaxed);
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut command = String::new();
            reader.read_line(&mut command).await.unwrap();
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&kanna_daemon::protocol::Event::Ok).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_daemon_dir(&daemon_dir),
    )
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&viewer, &owner, "peer-owner").await;
    let owner_peer = viewer
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap();
    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;
    let viewer_identity = stored_runtime_identity(temp.path(), "peer-viewer");

    for (request_id, authenticated_submission, authenticated_control, field) in [
        ("downgrade-submission", true, false, "submission_boundary"),
        ("downgrade-control", false, true, "control_input"),
    ] {
        let sealed_payload = seal_authenticated_transfer_request(
            &viewer_identity,
            &owner_peer.public_key,
            "send_session_input",
            request_id,
            &owner_epoch,
            current_unix_ms(),
            json!({
                "session_id": "task-with-draft",
                "data": [13],
                "submission_boundary": authenticated_submission,
                "control_input": authenticated_control,
            }),
        );
        let response = send_raw_peer_value(
            &owner_peer.endpoint,
            &json!({
                "type": "send_session_input",
                "request_id": request_id,
                "requester_peer_id": "peer-viewer",
                "session_id": "task-with-draft",
                "data": [13],
                "submission_boundary": false,
                "control_input": false,
                "sealed_payload": sealed_payload,
            }),
        )
        .await;

        assert!(
            matches!(
                response,
                PeerResponse::Error { ref message, .. }
                    if message.contains(field)
                        && message.contains("does not match authenticated payload")
            ),
            "authenticated {field}:true was downgraded before dispatch: {response:?}",
        );
    }

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        daemon_contacts.load(Ordering::Relaxed),
        0,
        "forged terminal semantics reached the daemon",
    );
    daemon_probe.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn companion_observer_removes_itself_when_owner_disconnects() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key,
            capabilities_json: "{\"protocolVersion\":2,\"companionCapabilityVersion\":1}".into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let registry_dir = temp.path().to_path_buf();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let request: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(request["type"], "observe_companion");
        let primary_entry = PeerRegistry::new(registry_dir)
            .list_peers("peer-target")
            .unwrap()
            .into_iter()
            .find(|peer| peer.peer_id == "peer-primary")
            .unwrap();
        let primary_public = parse_public_key(&primary_entry.public_key).unwrap();
        let proof = open_json(
            &target_identity,
            &primary_public,
            request["sealed_payload"].as_str().unwrap(),
        )
        .unwrap();
        let observation_challenge = URL_SAFE_NO_PAD.encode([7_u8; 24]);
        let sealed_payload = seal_json(
            &target_identity,
            &primary_public,
            &json!({
                "operation": "observe_companion_ack",
                "request_id": request["request_id"],
                "task_id": proof["task_id"],
                "generation": proof["generation"],
                "stream_nonce": proof["stream_nonce"],
                "observation_challenge": observation_challenge,
                "sequence": 0,
                "frame": null,
            }),
        )
        .unwrap();
        writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "type": "observe_companion",
                        "request_id": request["request_id"],
                        "sealed_payload": sealed_payload,
                    })
                )
                .as_bytes(),
            )
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
        .observe_peer_companion("peer-target", "task-1", "generation-1")
        .await
        .unwrap();
    let frame = next_companion_frame(&primary).await;
    assert!(matches!(
        frame,
        ServerFrame::CompanionError {
            code,
            ..
        } if code == "connection_failed"
    ));
    server.await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while primary.companion_observer_count().await != 0 {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_removes_authorization_after_post_registration_stream_failure() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&viewer, &owner, "peer-owner").await;

    viewer
        .observe_peer_companion("peer-owner", "task-1", "generation-fails")
        .await
        .unwrap();
    let frame = next_companion_frame(&viewer).await;
    assert!(matches!(
        frame,
        ServerFrame::CompanionError { code, .. } if code == "connection_failed"
    ));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while owner.owner_companion_observer_count().await != 0
        || viewer.companion_observer_count().await != 0
    {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(owner.active_owner_companion_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn delayed_observe_cannot_install_after_unobserve() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let primary = std::sync::Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
                .with_peer_discovery_delays([Duration::from_millis(200)]),
        )
        .await
        .unwrap(),
    );
    let observe_runtime = std::sync::Arc::clone(&primary);
    let observe = tokio::spawn(async move {
        observe_runtime
            .observe_peer_session("peer-target", "task-delayed", "lease-delayed")
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    primary
        .unobserve_peer_session("peer-target", "task-delayed", "lease-delayed")
        .await
        .unwrap();
    observe.await.unwrap().unwrap();

    assert!(
        tokio::time::timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err(),
        "delayed observe installed after unobserve completed",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_observer_tombstones_are_bounded_without_losing_recent_race_protection() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let runtime = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
            .with_terminal_observer_tombstone_policy(Duration::from_secs(60), 2),
    )
    .await
    .unwrap();

    for index in 1..=3 {
        runtime
            .unobserve_peer_session(
                "peer-target",
                &format!("task-{index}"),
                &format!("lease-{index}"),
            )
            .await
            .unwrap();
    }

    let (observe_result, accepted) = tokio::join!(
        runtime.observe_peer_session("peer-target", "task-1", "lease-1"),
        tokio::time::timeout(
            Duration::from_secs(1),
            accept_authenticated_request(&listener, "bounded-owner-epoch"),
        ),
    );
    observe_result.unwrap();
    let (oldest_reader, oldest_request) =
        accepted.expect("oldest reclaimed tombstone still suppressed observe");
    assert!(matches!(oldest_request, PeerRequest::ObserveSession { .. }));
    drop(oldest_reader);

    runtime
        .observe_peer_session("peer-target", "task-3", "lease-3")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), listener.accept())
            .await
            .is_err(),
        "recent unobserve-before-observe tombstone lost race protection",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_observe_replacement_aborts_displaced_generation() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let primary = std::sync::Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
                .with_peer_discovery_delays([Duration::from_millis(200), Duration::ZERO]),
        )
        .await
        .unwrap(),
    );
    let first_runtime = std::sync::Arc::clone(&primary);
    let first = tokio::spawn(async move {
        first_runtime
            .observe_peer_session("peer-target", "task-replaced", "lease-old")
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    let second_runtime = std::sync::Arc::clone(&primary);
    let second = tokio::spawn(async move {
        second_runtime
            .observe_peer_session("peer-target", "task-replaced", "lease-new")
            .await
    });

    let (_, first_request) = tokio::time::timeout(
        Duration::from_secs(1),
        accept_authenticated_request(&listener, "replacement-owner-epoch"),
    )
    .await
    .expect("newest observe never connected");
    assert!(matches!(first_request, PeerRequest::ObserveSession { .. }));
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();

    assert!(
        tokio::time::timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err(),
        "stale delayed observe displaced the newer observer",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn old_unobserve_cannot_remove_replacement_observer_lease() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-primary",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let (old_observe, old_accepted) = tokio::join!(
        runtime.observe_peer_session("peer-target", "task-replaced", "lease-old"),
        accept_authenticated_request(&listener, "old-owner-epoch"),
    );
    old_observe.unwrap();
    let (old_reader, old_request) = old_accepted;
    assert!(matches!(old_request, PeerRequest::ObserveSession { .. }));
    let (new_observe, new_accepted) = tokio::join!(
        runtime.observe_peer_session("peer-target", "task-replaced", "lease-new"),
        accept_authenticated_request(&listener, "new-owner-epoch"),
    );
    new_observe.unwrap();
    let (mut new_reader, new_request) = new_accepted;
    assert!(matches!(&new_request, PeerRequest::ObserveSession { .. }));
    runtime
        .unobserve_peer_session("peer-target", "task-replaced", "lease-old")
        .await
        .unwrap();
    drop(old_reader);
    runtime
        .observe_peer_session("peer-target", "task-replaced", "lease-old")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), listener.accept())
            .await
            .is_err(),
        "delayed old observe displaced the replacement after its unobserve",
    );

    let PeerRequest::ObserveSession { request_id, .. } = new_request else {
        panic!("expected observe request");
    };
    let response = PeerResponse::ObserveSession {
        request_id,
        session_id: "task-replaced".into(),
    };
    new_reader
        .get_mut()
        .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
        .await
        .unwrap();
    let event = kanna_task_transfer::protocol::PeerTerminalEvent::Output {
        session_id: "task-replaced".into(),
        data: b"replacement-live".to_vec(),
    };
    new_reader
        .get_mut()
        .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
        .await
        .expect("replacement observer connection was closed by the old lease");
    match tokio::time::timeout(Duration::from_secs(1), runtime.next_event())
        .await
        .expect("replacement observer event was not forwarded")
        .unwrap()
    {
        RuntimeEvent::TerminalEvent {
            peer_id,
            session_id,
            observer_lease_id,
            event: kanna_task_transfer::protocol::PeerTerminalEvent::Output { data, .. },
        } => {
            assert_eq!(peer_id, "peer-target");
            assert_eq!(session_id, "task-replaced");
            assert_eq!(observer_lease_id, "lease-new");
            assert_eq!(data, b"replacement-live");
        }
        other => panic!("unexpected replacement observer event: {other:?}"),
    }
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

async fn assert_trusted_peer_advance_stage_posts_expected_body(
    expected_transition_revision: Option<&str>,
    expected_body: &str,
) {
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
        .advance_peer_task_stage("peer-owner", "owner-task-1", expected_transition_revision)
        .await
        .unwrap();

    let (request_line, body) = request_rx.await.unwrap();
    assert_eq!(
        request_line,
        "POST /v1/tasks/owner-task-1/actions/advance-stage HTTP/1.1\r\n"
    );
    assert_eq!(body, expected_body);
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_advance_stage_posts_to_owner_kanna_server() {
    assert_trusted_peer_advance_stage_posts_expected_body(
        Some("run-1"),
        r#"{"expectedTransitionRevision":"run-1"}"#,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_legacy_advance_without_revision_posts_no_cas_body() {
    assert_trusted_peer_advance_stage_posts_expected_body(None, "{}").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_close_routes_through_owner_kanna_server_action() {
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
        .close_peer_task("peer-owner", "owner-task-1")
        .await
        .unwrap();

    let (request_line, body) = request_rx.await.unwrap();
    assert_eq!(
        request_line,
        "POST /v1/tasks/owner-task-1/actions/close HTTP/1.1\r\n"
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
async fn trusted_peer_browse_and_diff_fetch_from_owner_kanna_server() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, mut request_rx) = mpsc::channel(2);

    let server = tokio::spawn(async move {
        for body in [
            r#"{"path":"src dir","entries":[],"offset":0,"nextOffset":null,"totalEntries":0}"#,
            r#"{"taskId":"owner-task-1","baseRef":"main","mergeBase":"abc","patch":"diff","truncated":true}"#,
        ] {
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
            request_tx.send(request_line).await.unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            reader
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        }
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

    let listing = secondary
        .read_peer_task_directory("peer-owner", "owner-task-1", "src dir", true, 0, 100)
        .await
        .unwrap();
    assert_eq!(listing["path"], "src dir");
    let diff = secondary
        .read_peer_task_diff("peer-owner", "owner-task-1", "branch", "all")
        .await
        .unwrap();
    assert_eq!(diff["truncated"], true);

    assert_eq!(
        request_rx.recv().await.unwrap(),
        "GET /v1/tasks/owner-task-1/browse?path=src%20dir&showAllFiles=true&offset=0&limit=100 HTTP/1.1\r\n"
    );
    assert_eq!(
        request_rx.recv().await.unwrap(),
        "GET /v1/tasks/owner-task-1/diff?scope=branch&mode=all HTTP/1.1\r\n"
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
async fn externally_trusted_peer_mark_read_keeps_authenticated_read_dwell_routing() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let kanna_port = listener.local_addr().unwrap().port();
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
    let owner_identity = owner.local_identity();
    let secondary_identity = secondary.local_identity();
    secondary
        .upsert_external_peer(ExternalPeer {
            peer_id: owner_identity.peer_id,
            display_name: owner_identity.display_name,
            endpoint: runtime_endpoint(temp.path(), "peer-owner"),
            public_key: owner_identity.public_key,
            protocol_version: owner_identity.protocol_version.into(),
            accepting_transfers: owner_identity.accepting_transfers,
        })
        .await
        .unwrap();
    owner
        .upsert_external_peer(ExternalPeer {
            peer_id: secondary_identity.peer_id,
            display_name: secondary_identity.display_name,
            endpoint: runtime_endpoint(temp.path(), "peer-secondary"),
            public_key: secondary_identity.public_key,
            protocol_version: secondary_identity.protocol_version.into(),
            accepting_transfers: secondary_identity.accepting_transfers,
        })
        .await
        .unwrap();

    secondary
        .mark_peer_task_read("peer-owner", "owner-task-1", 9)
        .await
        .unwrap();
    assert_eq!(
        request_rx.await.unwrap(),
        "POST /v1/tasks/owner-task-1/actions/mark-read HTTP/1.1\r\n",
    );
    server.await.unwrap();
    assert!(
        !trusted_peer_store_path(temp.path(), "peer-owner").exists()
            && !trusted_peer_store_path(temp.path(), "peer-secondary").exists(),
        "external read-dwell routing persisted session trust",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_mark_read_is_bounded_without_blocking_terminal_control_or_snapshot_refresh() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            endpoint: format!("127.0.0.1:{port}"),
            pid: std::process::id(),
            public_key: target_public_key.clone(),
            protocol_version: CURRENT_PROTOCOL_VERSION,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"))
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: target_public_key,
            capabilities_json: json!({
                "protocolVersion": CURRENT_PROTOCOL_VERSION,
                "authenticatedTaskRequests": true,
                "authenticatedTaskRequestVersion": 1,
            })
            .to_string(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let runtime = std::sync::Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
                // The mark-read bound below is what this test measures; the
                // outer per-request bound only has to outlast the other six
                // connections on a loaded box.
                .with_peer_request_timeout(Duration::from_secs(60))
                .with_mark_read_timeout(Duration::from_millis(75))
                .with_peer_request_limits(2, 1),
        )
        .await
        .unwrap(),
    );
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<&'static str>();
    let server = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        // Four operations fetch the live owner epoch first. The second mark-read
        // is then rejected locally by its dedicated permit before opening its
        // action connection, for seven bounded connections in total.
        for _ in 0..7 {
            let (stream, _) = listener.accept().await.unwrap();
            let event_tx = event_tx.clone();
            handlers.spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let request: PeerRequest = serde_json::from_str(line.trim()).unwrap();
                match request {
                    PeerRequest::GetAuthenticatedRequestEpoch { request_id } => {
                        let response = PeerResponse::AuthenticatedRequestEpoch {
                            request_id,
                            epoch: "stalled-owner-epoch".into(),
                        };
                        reader
                            .get_mut()
                            .write_all(
                                format!("{}\n", serde_json::to_string(&response).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    PeerRequest::MarkTaskRead { .. } => {
                        event_tx.send("mark-started").unwrap();
                        let mut remainder = Vec::new();
                        reader.read_to_end(&mut remainder).await.unwrap();
                        event_tx.send("mark-closed").unwrap();
                    }
                    PeerRequest::SendSessionInput { request_id, .. } => {
                        let response = PeerResponse::SendSessionInput { request_id };
                        reader
                            .get_mut()
                            .write_all(
                                format!("{}\n", serde_json::to_string(&response).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    PeerRequest::GetTaskSnapshot { request_id, .. } => {
                        let response = PeerResponse::TaskSnapshot {
                            request_id,
                            peer_id: "peer-target".into(),
                            display_name: "Target".into(),
                            snapshot: json!({ "schemaVersion": 1, "tasks": [] }),
                        };
                        reader
                            .get_mut()
                            .write_all(
                                format!("{}\n", serde_json::to_string(&response).unwrap())
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    other => panic!("unexpected peer request: {other:?}"),
                }
            });
        }
        while handlers.join_next().await.is_some() {}
    });

    let mark_runtime = std::sync::Arc::clone(&runtime);
    let mark_read = tokio::spawn(async move {
        mark_runtime
            .mark_peer_task_read("peer-target", "task-unread", 7)
            .await
    });
    assert_eq!(event_rx.recv().await, Some("mark-started"));
    let overload = runtime
        .mark_peer_task_read("peer-target", "task-unread", 8)
        .await
        .unwrap_err();
    assert!(
        overload
            .to_string()
            .contains("mark-read peer request capacity"),
        "unexpected mark-read overload: {overload}"
    );

    let controls = tokio::time::timeout(Duration::from_millis(250), async {
        let (input, snapshots) = tokio::join!(
            runtime.send_peer_session_input(
                "peer-target",
                "task-unread",
                b"x".to_vec(),
                false,
                false,
            ),
            runtime.list_peer_task_snapshots(),
        );
        input.unwrap();
        assert_eq!(snapshots.unwrap().snapshots.len(), 1);
    })
    .await;
    assert!(
        controls.is_ok(),
        "terminal control or LAN snapshot refresh waited behind mark-read"
    );

    let error = tokio::time::timeout(Duration::from_secs(10), mark_read)
        .await
        .expect("mark-read exceeded its lower-layer deadline")
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("timed out after 75ms"),
        "unexpected mark-read error: {error}"
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), event_rx.recv())
            .await
            .expect("stalled peer connection survived mark-read timeout"),
        Some("mark-closed"),
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

    let action = secondary.advance_peer_task_stage("peer-owner", task_id, Some("run-1"));
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
async fn forged_advance_payload_cannot_apply_owner_action() {
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
            "action": "advance_task_stage",
            "request_id": "forged-advance",
            "task_id": "owner-task-1",
            "expected_transition_revision": "run-1",
        }),
    )
    .unwrap();

    let mut stream = TcpStream::connect(&owner_peer.endpoint).await.unwrap();
    let request = json!({
        "type": "advance_task_stage",
        "request_id": "forged-advance",
        "requester_peer_id": "peer-secondary",
        "task_id": "owner-task-1",
        "expected_transition_revision": "run-1",
        "sealed_payload": sealed_payload,
    });
    stream
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();

    let mut response_line = String::new();
    let mut reader = BufReader::new(stream);
    tokio::select! {
        read = reader.read_line(&mut response_line) => {
            read.unwrap();
        }
        accepted = kanna_listener.accept() => {
            panic!(
                "forged advance reached the owner Kanna server: {:?}",
                accepted.unwrap().1,
            );
        }
        _ = tokio::time::sleep(Duration::from_secs(1)) => {
            panic!("forged advance produced neither a rejection nor an owner request");
        }
    }
    let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
    let PeerResponse::Error {
        request_id,
        message,
    } = response
    else {
        panic!("expected forged advance request to fail");
    };
    assert_eq!(request_id, "forged-advance");
    assert!(
        message.contains("payload decryption failed"),
        "unexpected error: {message}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn privileged_lan_requests_reject_a_spoofed_paired_peer_id() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
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
    let owner_endpoint = runtime_endpoint(temp.path(), "peer-owner");

    for request in [
        json!({
            "type": "observe_session",
            "request_id": "spoof-observe",
            "requester_peer_id": "peer-secondary",
            "session_id": "owner-task-1",
        }),
        json!({
            "type": "send_session_input",
            "request_id": "spoof-input",
            "requester_peer_id": "peer-secondary",
            "session_id": "owner-task-1",
            "data": [97],
        }),
        json!({
            "type": "resize_session",
            "request_id": "spoof-resize",
            "requester_peer_id": "peer-secondary",
            "session_id": "owner-task-1",
            "cols": 100,
            "rows": 40,
        }),
        json!({
            "type": "close_task",
            "request_id": "spoof-close",
            "requester_peer_id": "peer-secondary",
            "task_id": "owner-task-1",
        }),
        json!({
            "type": "read_task_file",
            "request_id": "spoof-read",
            "requester_peer_id": "peer-secondary",
            "task_id": "owner-task-1",
            "path": "src/private.rs",
        }),
    ] {
        let response = send_raw_peer_value(&owner_endpoint, &request).await;
        assert!(
            matches!(
                response,
                PeerResponse::Error { ref message, .. }
                    if message.contains("missing authenticated payload")
            ),
            "caller-supplied peer id was accepted for {}: {response:?}",
            request["type"],
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn privileged_lan_read_rejects_a_forged_sealed_payload() {
    let temp = tempfile::tempdir().unwrap();
    let kanna_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(kanna_listener.local_addr().unwrap().port()),
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
    let forged_payload = seal_json(
        &TransferIdentity::generate(),
        &parse_public_key(&owner_peer.public_key).unwrap(),
        &json!({
            "action": "read_task_file",
            "request_id": "forged-read",
            "issued_at_unix_ms": current_unix_ms(),
            "task_id": "owner-task-1",
            "path": "src/private.rs",
        }),
    )
    .unwrap();
    let request = json!({
        "type": "read_task_file",
        "request_id": "forged-read",
        "requester_peer_id": "peer-secondary",
        "task_id": "owner-task-1",
        "path": "src/private.rs",
        "sealed_payload": forged_payload,
    });

    let server = tokio::spawn(serve_task_file_reads(kanna_listener, 1));
    let response = send_raw_peer_value(&owner_peer.endpoint, &request).await;
    assert!(
        matches!(
            response,
            PeerResponse::Error { ref message, .. }
                if message.contains("payload decryption failed")
        ),
        "forged sealed file read was accepted: {response:?}",
    );
    assert_eq!(
        server.await.unwrap(),
        0,
        "forged file read reached the owner Kanna server",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn privileged_lan_read_rejects_replay_before_a_second_owner_action() {
    let temp = tempfile::tempdir().unwrap();
    let kanna_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(kanna_listener.local_addr().unwrap().port()),
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
    let identity_path = temp
        .path()
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-secondary")));
    let stored_identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).unwrap()).unwrap();
    let secondary_identity =
        TransferIdentity::from_secret_string(stored_identity["secret_key"].as_str().unwrap())
            .unwrap();
    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;
    let sealed_payload = seal_json(
        &secondary_identity,
        &parse_public_key(&owner_peer.public_key).unwrap(),
        &json!({
            "action": "read_task_file",
            "request_id": "replayed-read",
            "owner_epoch": owner_epoch,
            "issued_at_unix_ms": current_unix_ms(),
            "task_id": "owner-task-1",
            "path": "src/private.rs",
        }),
    )
    .unwrap();
    let request = json!({
        "type": "read_task_file",
        "request_id": "replayed-read",
        "requester_peer_id": "peer-secondary",
        "task_id": "owner-task-1",
        "path": "src/private.rs",
        "sealed_payload": sealed_payload,
    });

    let server = tokio::spawn(serve_task_file_reads(kanna_listener, 2));

    let first = send_raw_peer_value(&owner_peer.endpoint, &request).await;
    assert!(
        matches!(first, PeerResponse::ReadTaskFile { .. }),
        "initial authenticated file read failed: {first:?}",
    );
    let replay = send_raw_peer_value(&owner_peer.endpoint, &request).await;
    assert!(
        matches!(
            replay,
            PeerResponse::Error { ref message, .. }
                if message.contains("replayed authenticated read_task_file request")
        ),
        "replayed file read was accepted: {replay:?}",
    );
    assert_eq!(
        server.await.unwrap(),
        1,
        "replayed file read reached the owner Kanna server",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn privileged_advance_replay_is_rejected_after_owner_restart() {
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
    let identity_path = temp
        .path()
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-secondary")));
    let stored_identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).unwrap()).unwrap();
    let secondary_identity =
        TransferIdentity::from_secret_string(stored_identity["secret_key"].as_str().unwrap())
            .unwrap();
    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;
    let sealed_payload = seal_json(
        &secondary_identity,
        &parse_public_key(&owner_peer.public_key).unwrap(),
        &json!({
            "action": "advance_task_stage",
            "request_id": "restart-replay-advance",
            "owner_epoch": owner_epoch,
            "issued_at_unix_ms": current_unix_ms(),
            "task_id": "owner-task-1",
            "expected_transition_revision": "run-1",
        }),
    )
    .unwrap();
    let request = json!({
        "type": "advance_task_stage",
        "request_id": "restart-replay-advance",
        "requester_peer_id": "peer-secondary",
        "task_id": "owner-task-1",
        "expected_transition_revision": "run-1",
        "sealed_payload": sealed_payload,
    });
    let server = tokio::spawn(serve_task_file_reads(kanna_listener, 2));

    let initial = send_raw_peer_value(&owner_peer.endpoint, &request).await;
    assert!(
        matches!(initial, PeerResponse::AdvanceTaskStage { .. }),
        "initial authenticated advance failed: {initial:?}",
    );
    drop(owner);
    let restarted_owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(kanna_port),
    )
    .await
    .unwrap();
    let replay = send_raw_peer_value(&runtime_endpoint(temp.path(), "peer-owner"), &request).await;
    assert!(
        matches!(
            replay,
            PeerResponse::Error { ref message, .. }
                if message.contains("stale owner epoch")
        ),
        "owner restart forgot the authenticated replay: {replay:?}",
    );
    assert_eq!(
        server.await.unwrap(),
        1,
        "restart replay reached the owner Kanna server",
    );
    drop(restarted_owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_privileged_request_rejects_a_hostile_replay_after_owner_restart() {
    let temp = tempfile::tempdir().unwrap();
    let owner_config = RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0);
    let owner = TransferRuntime::spawn(owner_config.clone()).await.unwrap();
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
    let identity_path = temp
        .path()
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-secondary")));
    let stored_identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).unwrap()).unwrap();
    let secondary_identity =
        TransferIdentity::from_secret_string(stored_identity["secret_key"].as_str().unwrap())
            .unwrap();
    let owner_public_key = parse_public_key(&owner_peer.public_key).unwrap();
    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;

    let cases = vec![
        (
            "get_task_snapshot",
            json!({
                "type": "get_task_snapshot",
                "request_id": "restart-snapshot",
                "requester_peer_id": "peer-secondary",
            }),
            json!({}),
        ),
        (
            "observe_session",
            json!({
                "type": "observe_session",
                "request_id": "restart-observe",
                "requester_peer_id": "peer-secondary",
                "session_id": "owner-task-1",
            }),
            json!({ "session_id": "owner-task-1" }),
        ),
        (
            "send_session_input",
            json!({
                "type": "send_session_input",
                "request_id": "restart-input",
                "requester_peer_id": "peer-secondary",
                "session_id": "owner-task-1",
                "data": [120],
            }),
            json!({ "session_id": "owner-task-1", "data": [120] }),
        ),
        (
            "resize_session",
            json!({
                "type": "resize_session",
                "request_id": "restart-resize",
                "requester_peer_id": "peer-secondary",
                "session_id": "owner-task-1",
                "cols": 100,
                "rows": 40,
            }),
            json!({ "session_id": "owner-task-1", "cols": 100, "rows": 40 }),
        ),
        (
            "close_task",
            json!({
                "type": "close_task",
                "request_id": "restart-close",
                "requester_peer_id": "peer-secondary",
                "task_id": "owner-task-1",
            }),
            json!({ "task_id": "owner-task-1" }),
        ),
        (
            "advance_task_stage",
            json!({
                "type": "advance_task_stage",
                "request_id": "restart-advance",
                "requester_peer_id": "peer-secondary",
                "task_id": "owner-task-1",
                "expected_transition_revision": "run-1",
            }),
            json!({
                "task_id": "owner-task-1",
                "expected_transition_revision": "run-1",
            }),
        ),
        (
            "read_task_file",
            json!({
                "type": "read_task_file",
                "request_id": "restart-read",
                "requester_peer_id": "peer-secondary",
                "task_id": "owner-task-1",
                "path": "README.md",
            }),
            json!({ "task_id": "owner-task-1", "path": "README.md" }),
        ),
        (
            "mark_task_read",
            json!({
                "type": "mark_task_read",
                "request_id": "restart-mark-read",
                "requester_peer_id": "peer-secondary",
            }),
            json!({
                "task_id": "owner-task-1",
                "expected_activity_revision": 1,
            }),
        ),
    ];
    let mut captured = Vec::new();
    for (action, mut request, arguments) in cases {
        let request_id = request["request_id"].as_str().unwrap().to_owned();
        let mut payload = arguments.as_object().unwrap().clone();
        payload.insert("action".into(), json!(action));
        payload.insert("request_id".into(), json!(request_id));
        payload.insert("owner_epoch".into(), json!(owner_epoch));
        payload.insert("issued_at_unix_ms".into(), json!(current_unix_ms()));
        request["sealed_payload"] = json!(seal_json(
            &secondary_identity,
            &owner_public_key,
            &serde_json::Value::Object(payload),
        )
        .unwrap());
        captured.push((action, request));
    }

    drop(owner);
    let restarted_owner = TransferRuntime::spawn(owner_config).await.unwrap();
    let restarted_endpoint = runtime_endpoint(temp.path(), "peer-owner");
    for (action, request) in captured {
        let response = send_raw_peer_value(&restarted_endpoint, &request).await;
        assert!(
            matches!(
                response,
                PeerResponse::Error { ref message, .. }
                    if message.contains("stale owner epoch")
            ),
            "captured {action} request crossed an owner restart: {response:?}",
        );
    }
    drop(restarted_owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requester_restart_does_not_reuse_ids_for_authenticated_task_operations() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    owner
        .set_task_snapshot(json!({ "tasks": [{ "id": "owner-task-1" }] }))
        .await
        .unwrap();
    let requester_config = RuntimeConfig::for_tests("peer-requester", "Requester", temp.path(), 0);
    let requester = TransferRuntime::spawn(requester_config.clone())
        .await
        .unwrap();
    pair_peers(&requester, &owner, "peer-owner").await;

    async fn exercise(runtime: &TransferRuntime) {
        let listing = runtime.list_peer_task_snapshots().await.unwrap();
        assert_eq!(listing.snapshots.len(), 1, "{:?}", listing.issues);

        runtime
            .observe_peer_session("peer-owner", "owner-task-1", "restart-lease")
            .await
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(1), runtime.next_event())
            .await
            .unwrap()
            .unwrap();
        let RuntimeEvent::TerminalEvent { event, .. } = event else {
            panic!("expected terminal error event, got {event:?}");
        };
        let kanna_task_transfer::protocol::PeerTerminalEvent::Error { message, .. } = event else {
            panic!("expected terminal error");
        };
        assert!(!message.contains("replayed authenticated"), "{message}");

        for result in [
            runtime
                .send_peer_session_input("peer-owner", "owner-task-1", b"x".to_vec(), false, false)
                .await,
            runtime
                .resize_peer_session("peer-owner", "owner-task-1", 100, 40)
                .await,
            runtime.close_peer_task("peer-owner", "owner-task-1").await,
            runtime
                .advance_peer_task_stage("peer-owner", "owner-task-1", Some("run-1"))
                .await,
            runtime
                .read_peer_task_file("peer-owner", "owner-task-1", "README.md")
                .await
                .map(|_| ()),
            runtime
                .mark_peer_task_read("peer-owner", "owner-task-1", 1)
                .await,
        ] {
            let message = result
                .expect_err("owner adapters are intentionally absent")
                .to_string();
            assert!(!message.contains("replayed authenticated"), "{message}");
        }
    }

    exercise(&requester).await;
    drop(requester);
    let restarted_requester = TransferRuntime::spawn(requester_config).await.unwrap();
    exercise(&restarted_requester).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_replay_window_is_memory_only_and_hard_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_authenticated_request_replay_limit(2),
    )
    .await
    .unwrap();
    let requester = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-requester",
        "Requester",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&requester, &owner, "peer-owner").await;

    assert_eq!(
        requester
            .list_peer_task_snapshots()
            .await
            .unwrap()
            .snapshots
            .len(),
        1,
    );
    assert_eq!(
        requester
            .list_peer_task_snapshots()
            .await
            .unwrap()
            .snapshots
            .len(),
        1,
    );
    let full = requester.list_peer_task_snapshots().await.unwrap();
    assert!(full.snapshots.is_empty());
    assert!(full.issues[0].message.contains("replay window is full"));
    assert_eq!(
        replay_json_count(temp.path(), "peer-owner", "authenticated-peer-requests",),
        0,
        "snapshot polling must not create crash-durable replay records",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_terminal_input_replay_records_stay_memory_only() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let requester = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-requester",
        "Requester",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&requester, &owner, "peer-owner").await;

    for _ in 0..32 {
        let error = requester
            .send_peer_session_input("peer-owner", "owner-task-1", b"x".to_vec(), false, false)
            .await
            .expect_err("owner daemon is intentionally absent");
        assert!(!error.to_string().contains("replayed authenticated"));
    }
    assert_eq!(
        replay_json_count(temp.path(), "peer-owner", "authenticated-peer-requests",),
        0,
        "terminal input must not fsync one replay record per keystroke",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn privileged_lan_read_rejects_stale_and_tampered_arguments() {
    let temp = tempfile::tempdir().unwrap();
    let kanna_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(kanna_listener.local_addr().unwrap().port()),
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
    let identity_path = temp
        .path()
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-secondary")));
    let stored_identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).unwrap()).unwrap();
    let secondary_identity =
        TransferIdentity::from_secret_string(stored_identity["secret_key"].as_str().unwrap())
            .unwrap();
    let owner_public_key = parse_public_key(&owner_peer.public_key).unwrap();
    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;
    let server = tokio::spawn(serve_task_file_reads(kanna_listener, 2));

    for (request_id, issued_at_unix_ms, outer_path, expected_error) in [
        ("stale-read", 0, "src/private.rs", "stale"),
        (
            "tampered-read",
            current_unix_ms(),
            "src/other.rs",
            "does not match authenticated payload",
        ),
    ] {
        let sealed_payload = seal_json(
            &secondary_identity,
            &owner_public_key,
            &json!({
                "action": "read_task_file",
                "request_id": request_id,
                "owner_epoch": owner_epoch,
                "issued_at_unix_ms": issued_at_unix_ms,
                "task_id": "owner-task-1",
                "path": "src/private.rs",
            }),
        )
        .unwrap();
        let request = json!({
            "type": "read_task_file",
            "request_id": request_id,
            "requester_peer_id": "peer-secondary",
            "task_id": "owner-task-1",
            "path": outer_path,
            "sealed_payload": sealed_payload,
        });
        let response = send_raw_peer_value(&owner_peer.endpoint, &request).await;
        assert!(
            matches!(
                response,
                PeerResponse::Error { ref message, .. } if message.contains(expected_error)
            ),
            "{request_id} was accepted: {response:?}",
        );
    }

    assert_eq!(
        server.await.unwrap(),
        0,
        "stale or tampered file read reached the owner Kanna server",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forged_snapshot_payload_cannot_expose_owner_tasks() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    owner
        .set_task_snapshot(json!({
            "tasks": [{
                "id": "owner-secret-task",
                "prompt": "private owner task",
            }],
        }))
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
            "action": "get_task_snapshot",
            "request_id": "forged-snapshot",
        }),
    )
    .unwrap();

    let mut stream = TcpStream::connect(&owner_peer.endpoint).await.unwrap();
    let request = json!({
        "type": "get_task_snapshot",
        "request_id": "forged-snapshot",
        "requester_peer_id": "peer-secondary",
        "sealed_payload": sealed_payload,
    });
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
        panic!("expected forged task snapshot request to fail, got {response:?}");
    };
    assert_eq!(request_id, "forged-snapshot");
    assert!(
        message.contains("payload decryption failed"),
        "unexpected error: {message}"
    );
}

async fn mark_peer_as_protocol_v1(
    root: &Path,
    owner_peer_id: &str,
    legacy_peer: &kanna_task_transfer::protocol::DiscoveredPeer,
) {
    PeerRegistry::new(root.to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: legacy_peer.peer_id.clone(),
            display_name: legacy_peer.display_name.clone(),
            endpoint: legacy_peer.endpoint.clone(),
            pid: legacy_peer.pid,
            public_key: legacy_peer.public_key.clone(),
            protocol_version: 1,
            accepting_transfers: legacy_peer.accepting_transfers,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(root, owner_peer_id))
        .upsert(PeerRecord {
            peer_id: legacy_peer.peer_id.clone(),
            display_name: legacy_peer.display_name.clone(),
            public_key: legacy_peer.public_key.clone(),
            capabilities_json: json!({
                "protocolVersion": 1,
                "authenticatedTaskRequests": false,
            })
            .to_string(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_v1_snapshot_request_gets_explicit_secure_upgrade_error() {
    let temp = tempfile::tempdir().unwrap();
    let owner = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-owner",
        "Owner",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    owner
        .set_task_snapshot(json!({ "tasks": [{ "id": "owner-secret-task" }] }))
        .await
        .unwrap();
    let legacy = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-legacy",
        "Legacy",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&legacy, &owner, "peer-owner").await;
    let legacy_peer = owner
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-legacy")
        .unwrap();
    mark_peer_as_protocol_v1(temp.path(), "peer-owner", &legacy_peer).await;
    let owner_peer = legacy
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap();

    let mut stream = TcpStream::connect(&owner_peer.endpoint).await.unwrap();
    stream
        .write_all(
            b"{\"type\":\"get_task_snapshot\",\"request_id\":\"legacy-snapshot\",\"requester_peer_id\":\"peer-legacy\"}\n",
        )
        .await
        .unwrap();
    let mut response_line = String::new();
    BufReader::new(stream)
        .read_line(&mut response_line)
        .await
        .unwrap();
    let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
    assert!(
        matches!(
            response,
            PeerResponse::Error { ref message, .. }
                if message.contains("protocol v1")
                    && message.contains("authenticated task requests")
                    && message.contains("upgrade")
        ),
        "unexpected legacy snapshot response: {response:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_v1_advance_request_gets_explicit_secure_upgrade_error() {
    let temp = tempfile::tempdir().unwrap();
    let kanna_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(kanna_listener.local_addr().unwrap().port()),
    )
    .await
    .unwrap();
    let legacy = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-legacy",
        "Legacy",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&legacy, &owner, "peer-owner").await;
    let legacy_peer = owner
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-legacy")
        .unwrap();
    mark_peer_as_protocol_v1(temp.path(), "peer-owner", &legacy_peer).await;
    let owner_peer = legacy
        .list_peers()
        .await
        .unwrap()
        .into_iter()
        .find(|peer| peer.peer_id == "peer-owner")
        .unwrap();

    let mut stream = TcpStream::connect(&owner_peer.endpoint).await.unwrap();
    stream
        .write_all(
            b"{\"type\":\"advance_task_stage\",\"request_id\":\"legacy-advance\",\"requester_peer_id\":\"peer-legacy\",\"task_id\":\"owner-task-1\"}\n",
        )
        .await
        .unwrap();
    let mut response_line = String::new();
    BufReader::new(stream)
        .read_line(&mut response_line)
        .await
        .unwrap();
    let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
    assert!(
        matches!(
            response,
            PeerResponse::Error { ref message, .. }
                if message.contains("protocol v1")
                    && message.contains("authenticated task requests")
                    && message.contains("upgrade")
        ),
        "unexpected legacy advance response: {response:?}",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), kanna_listener.accept())
            .await
            .is_err(),
        "legacy unauthenticated advance reached the owner Kanna server",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replayed_advance_payload_cannot_apply_owner_action_twice() {
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
    let identity_path = temp
        .path()
        .join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-secondary"),));
    let stored_identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(identity_path).unwrap()).unwrap();
    let secondary_identity =
        TransferIdentity::from_secret_string(stored_identity["secret_key"].as_str().unwrap())
            .unwrap();
    let owner_public_key = parse_public_key(&owner_peer.public_key).unwrap();
    let owner_epoch = authenticated_request_epoch(&owner_peer.endpoint).await;
    let sealed_payload = seal_json(
        &secondary_identity,
        &owner_public_key,
        &json!({
            "action": "advance_task_stage",
            "request_id": "replayed-advance",
            "owner_epoch": owner_epoch,
            "issued_at_unix_ms": current_unix_ms(),
            "task_id": "owner-task-1",
            "expected_transition_revision": "run-1",
        }),
    )
    .unwrap();
    let request = json!({
        "type": "advance_task_stage",
        "request_id": "replayed-advance",
        "requester_peer_id": "peer-secondary",
        "task_id": "owner-task-1",
        "expected_transition_revision": "run-1",
        "sealed_payload": sealed_payload,
    });

    let server = tokio::spawn(async move {
        let mut accepted = 0usize;
        while accepted < 2 {
            let next =
                tokio::time::timeout(Duration::from_millis(300), kanna_listener.accept()).await;
            let Ok(Ok((stream, _))) = next else {
                break;
            };
            accepted += 1;
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
            reader
                .get_mut()
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .await
                .unwrap();
        }
        accepted
    });

    async fn send_request(endpoint: &str, request: &serde_json::Value) -> PeerResponse {
        let mut stream = TcpStream::connect(endpoint).await.unwrap();
        stream
            .write_all(format!("{}\n", serde_json::to_string(request).unwrap()).as_bytes())
            .await
            .unwrap();
        let mut response_line = String::new();
        BufReader::new(stream)
            .read_line(&mut response_line)
            .await
            .unwrap();
        serde_json::from_str(response_line.trim()).unwrap()
    }

    assert!(matches!(
        send_request(&owner_peer.endpoint, &request).await,
        PeerResponse::AdvanceTaskStage { .. }
    ));
    let replay_response = send_request(&owner_peer.endpoint, &request).await;
    assert!(
        matches!(
            replay_response,
            PeerResponse::Error { ref message, .. }
                if message.contains("replayed authenticated advance_task_stage request")
        ),
        "unexpected replay response: {replay_response:?}",
    );
    assert_eq!(
        server.await.unwrap(),
        1,
        "replayed advance reached the owner Kanna server",
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
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
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
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
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

        tokio::time::timeout(Duration::from_secs(10), commit)
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
    let owned_source = temp.path().join("owned-source-success.bundle");
    std::fs::write(&owned_source, b"owned source").unwrap();
    primary
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "owned-source-success",
            owned_source.clone(),
            true,
        )
        .await
        .unwrap();
    let managed_source = primary
        .fetch_transfer_artifact(&preflight.transfer_id, "owned-source-success")
        .await
        .unwrap()
        .path;
    assert!(!owned_source.exists());

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
    assert!(
        !managed_source.exists(),
        "source artifact survived successful import acknowledgment",
    );

    let ack = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(ack.transfer_id, preflight.transfer_id);
    assert_eq!(ack.source_task_id, "task-source");
    assert_eq!(ack.destination_local_task_id, "task-dest");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_outgoing_finalization_deletes_owned_source_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = std::sync::Arc::new(
        TransferRuntime::spawn(RuntimeConfig::for_tests(
            "peer-secondary-failure",
            "Secondary",
            temp.path(),
            0,
        ))
        .await
        .unwrap(),
    );
    let primary = std::sync::Arc::new(
        TransferRuntime::spawn(RuntimeConfig::for_tests(
            "peer-primary-failure",
            "Primary",
            temp.path(),
            0,
        ))
        .await
        .unwrap(),
    );
    pair_peers(&primary, &secondary, "peer-secondary-failure").await;
    let preflight = primary
        .prepare_transfer_preflight("peer-secondary-failure", "task-source")
        .await
        .unwrap();
    let owned_source = temp.path().join("owned-source-failure.bundle");
    std::fs::write(&owned_source, b"owned failure source").unwrap();
    primary
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "owned-source-failure",
            owned_source,
            true,
        )
        .await
        .unwrap();
    let managed_source = primary
        .fetch_transfer_artifact(&preflight.transfer_id, "owned-source-failure")
        .await
        .unwrap()
        .path;
    primary
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-secondary-failure",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&secondary).await;

    let primary_for_completion = std::sync::Arc::clone(&primary);
    let completion = tokio::spawn(async move {
        let event = primary_for_completion.next_event().await.unwrap();
        let RuntimeEvent::OutgoingTransferFinalizationRequested(event) = event else {
            panic!("expected outgoing transfer finalization request");
        };
        primary_for_completion
            .complete_outgoing_transfer_finalization(
                &event.transfer_id,
                Err(kanna_task_transfer::runtime::RuntimeError::Protocol(
                    "renderer finalization failed".into(),
                )),
            )
            .await
            .unwrap();
    });

    let error = secondary
        .finalize_outgoing_transfer(&preflight.transfer_id)
        .await
        .unwrap_err();
    completion.await.unwrap();
    assert!(error.to_string().contains("renderer finalization failed"));
    assert!(
        !managed_source.exists(),
        "owned source artifact survived terminal finalization failure",
    );
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
async fn destination_restart_allocates_a_new_id_after_source_retains_first_tombstone() {
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

    let first = primary
        .prepare_transfer_preflight("peer-secondary", "task-source-1")
        .await
        .unwrap();
    primary
        .prepare_transfer_commit(
            &first.transfer_id,
            json!({"task": {"source_task_id": "task-source-1"}}),
        )
        .await
        .unwrap();
    let _ = next_incoming_transfer_request(&secondary).await;
    secondary
        .acknowledge_import_committed(&first.transfer_id, "task-source-1", "task-dest-1")
        .await
        .unwrap();
    let _ = next_outgoing_transfer_committed(&primary).await;
    primary
        .mark_import_commit_applied(&first.transfer_id)
        .await
        .unwrap();
    secondary
        .mark_import_ack_completed(&first.transfer_id)
        .await
        .unwrap();

    drop(secondary);
    let secondary = TransferRuntime::spawn(secondary_config).await.unwrap();
    let second = primary
        .prepare_transfer_preflight("peer-secondary", "task-source-2")
        .await
        .unwrap();
    assert_ne!(second.transfer_id, first.transfer_id);
    assert!(second
        .transfer_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    primary
        .prepare_transfer_commit(
            &second.transfer_id,
            json!({"task": {"source_task_id": "task-source-2"}}),
        )
        .await
        .unwrap();
    let _ = next_incoming_transfer_request(&secondary).await;
    secondary
        .acknowledge_import_committed(&second.transfer_id, "task-source-2", "task-dest-2")
        .await
        .unwrap();
    let second_ack = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(second_ack.transfer_id, second.transfer_id);
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
async fn destination_replays_exact_incoming_event_after_submit_success_and_restart() {
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
    let payload = json!({
        "target_peer_id": "peer-secondary",
        "task": {
            "source_task_id": "task-source",
            "title": "Durably replay me"
        },
        "nested": { "preserve": ["this", 42, true] }
    });
    primary
        .prepare_transfer_commit(&preflight.transfer_id, payload.clone())
        .await
        .unwrap();

    // Simulate the destination sidecar crashing after it acknowledged submit to
    // the source but before its consumer received and recorded the event.
    drop(secondary);
    let secondary = TransferRuntime::spawn(secondary_config.clone())
        .await
        .unwrap();

    let replay = tokio::time::timeout(
        Duration::from_secs(1),
        next_incoming_transfer_request(&secondary),
    )
    .await
    .expect("destination did not replay the persisted incoming event");
    assert_eq!(replay.transfer_id, preflight.transfer_id);
    assert_eq!(replay.source_peer_id, "peer-primary");
    assert_eq!(replay.source_task_id, "task-source");
    assert_eq!(replay.source_name.as_deref(), Some("Primary"));
    assert_eq!(replay.payload, payload);

    secondary
        .mark_incoming_event_recorded(&preflight.transfer_id)
        .await
        .unwrap();
    secondary
        .mark_incoming_event_recorded(&preflight.transfer_id)
        .await
        .expect("recording the same incoming event twice should be idempotent");

    drop(secondary);
    let secondary = TransferRuntime::spawn(secondary_config).await.unwrap();
    tokio::time::timeout(Duration::from_millis(100), secondary.next_event())
        .await
        .expect_err("recorded incoming event replayed after restart");

    // Recording the event is independent of the destination's final import
    // acknowledgment; the reservation must remain usable until that completes.
    secondary
        .acknowledge_import_committed(&preflight.transfer_id, "task-source", "task-dest")
        .await
        .unwrap();
    let committed = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(committed.transfer_id, preflight.transfer_id);
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

    tokio::time::timeout(
        Duration::from_millis(225),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect_err("an in-flight receipt was redelivered before apply or nack");

    primary
        .nack_import_commit(&preflight.transfer_id)
        .await
        .unwrap();
    let retry = tokio::time::timeout(
        Duration::from_secs(1),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect("nacked receipt was not retried while the runtime stayed alive");
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
async fn stalled_receipt_consumer_has_one_bounded_pending_event_per_receipt_then_retries() {
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
            .with_replay_limits(2, 2)
            .with_receipt_retry_interval(Duration::from_millis(20)),
    )
    .await
    .unwrap();
    pair_peers(&primary, &secondary, "peer-secondary").await;

    let mut transfer_ids = Vec::new();
    for index in 0..2 {
        let source_task_id = format!("task-source-{index}");
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
        transfer_ids.push(preflight.transfer_id);
    }

    // Let many retry intervals pass while no consumer drains the runtime.
    tokio::time::sleep(Duration::from_millis(180)).await;

    let first = next_outgoing_transfer_committed(&primary).await;
    let second = next_outgoing_transfer_committed(&primary).await;
    let delivered = std::collections::HashSet::from([first.transfer_id, second.transfer_id]);
    assert_eq!(
        delivered,
        transfer_ids.iter().cloned().collect(),
        "the bounded queue should contain one event for each active receipt"
    );
    for transfer_id in &transfer_ids {
        primary
            .mark_import_commit_applied(transfer_id)
            .await
            .unwrap();
    }
    tokio::time::timeout(
        Duration::from_millis(40),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect_err("stalled retries accumulated duplicate queued receipt events");

    let retry_transfer = primary
        .prepare_transfer_preflight("peer-secondary", "task-source-retry")
        .await
        .unwrap();
    secondary
        .acknowledge_import_committed(
            &retry_transfer.transfer_id,
            "task-source-retry",
            "task-dest-retry",
        )
        .await
        .unwrap();
    let initial = next_outgoing_transfer_committed(&primary).await;
    assert_eq!(initial.transfer_id, retry_transfer.transfer_id);
    tokio::time::timeout(
        Duration::from_millis(100),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect_err("a claimed receipt was redelivered while its consumer was delayed");
    primary
        .nack_import_commit(&retry_transfer.transfer_id)
        .await
        .unwrap();
    let retry = tokio::time::timeout(
        Duration::from_millis(100),
        next_outgoing_transfer_committed(&primary),
    )
    .await
    .expect("a nacked receipt was not retried");
    assert_eq!(retry.transfer_id, retry_transfer.transfer_id);
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
async fn committed_incoming_reservations_survive_pending_ttl_and_restart() {
    let temp = tempfile::tempdir().unwrap();
    let secondary_config = RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
        .with_pending_transfer_ttl(Duration::from_secs(1))
        .with_max_incoming_reservations(2);
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

    let first = primary
        .prepare_transfer_preflight("peer-secondary", "task-committed-1")
        .await
        .unwrap();
    primary
        .prepare_transfer_commit(
            &first.transfer_id,
            json!({"task": {"source_task_id": "task-committed-1"}}),
        )
        .await
        .unwrap();
    let _ = next_incoming_transfer_request(&secondary).await;
    let first_path = replay_record_path(
        temp.path(),
        "peer-secondary",
        "incoming-reservations",
        &first.transfer_id,
    );
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let _ = primary
        .prepare_transfer_preflight("peer-secondary", "task-trigger-live-prune")
        .await
        .unwrap();
    assert!(first_path.exists());

    age_incoming_reservation(&first_path);
    drop(secondary);
    let secondary = TransferRuntime::spawn(secondary_config).await.unwrap();
    assert!(first_path.exists());
    secondary
        .acknowledge_import_committed(&first.transfer_id, "task-committed-1", "task-dest-1")
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incoming_reservation_capacity_rejects_without_displacing_committed_work() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
            .with_max_incoming_reservations(2),
    )
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

    let mut committed_ids = Vec::new();
    for index in 0..2 {
        let source_task = format!("task-committed-{index}");
        let transfer = primary
            .prepare_transfer_preflight("peer-secondary", &source_task)
            .await
            .unwrap();
        primary
            .prepare_transfer_commit(
                &transfer.transfer_id,
                json!({"task": {"source_task_id": source_task}}),
            )
            .await
            .unwrap();
        let _ = next_incoming_transfer_request(&secondary).await;
        committed_ids.push(transfer.transfer_id);
    }
    let capacity_error = primary
        .prepare_transfer_preflight("peer-secondary", "task-over-capacity")
        .await
        .unwrap_err();
    assert!(capacity_error
        .to_string()
        .contains("too many active incoming"));
    assert_eq!(
        replay_json_count(temp.path(), "peer-secondary", "incoming-reservations"),
        2
    );
    secondary
        .acknowledge_import_committed(&committed_ids[0], "task-committed-0", "task-dest-oldest")
        .await
        .unwrap();
    secondary
        .mark_import_ack_completed(&committed_ids[0])
        .await
        .unwrap();
    let admitted_after_cleanup = primary
        .prepare_transfer_preflight("peer-secondary", "task-after-cleanup")
        .await
        .unwrap();
    assert!(!admitted_after_cleanup.transfer_id.is_empty());
    secondary
        .acknowledge_import_committed(
            committed_ids.last().unwrap(),
            "task-committed-1",
            "task-dest-newest",
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_capacity_restart_preserves_existing_committed_work_and_closes_admission() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
            .with_max_incoming_reservations(2),
    )
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

    let mut committed = Vec::new();
    for index in 0..2 {
        let source_task_id = format!("task-legacy-{index}");
        let transfer = primary
            .prepare_transfer_preflight("peer-secondary", &source_task_id)
            .await
            .unwrap();
        primary
            .prepare_transfer_commit(
                &transfer.transfer_id,
                json!({"task": {"source_task_id": source_task_id}}),
            )
            .await
            .unwrap();
        let _ = next_incoming_transfer_request(&secondary).await;
        committed.push(transfer.transfer_id);
    }

    drop(secondary);
    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
            .with_max_incoming_reservations(1),
    )
    .await
    .unwrap();
    let admission_error = primary
        .prepare_transfer_preflight("peer-secondary", "task-over-legacy-cap")
        .await
        .unwrap_err();
    assert!(admission_error
        .to_string()
        .contains("too many active incoming"));

    for (index, transfer_id) in committed.iter().enumerate() {
        secondary
            .acknowledge_import_committed(
                transfer_id,
                &format!("task-legacy-{index}"),
                &format!("task-dest-{index}"),
            )
            .await
            .unwrap();
        secondary
            .mark_import_ack_completed(transfer_id)
            .await
            .unwrap();
    }
    let admitted = primary
        .prepare_transfer_preflight("peer-secondary", "task-after-legacy-cleanup")
        .await
        .unwrap();
    assert!(!admitted.transfer_id.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_terminal_cleanup_reopens_incoming_admission_live() {
    let temp = tempfile::tempdir().unwrap();
    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
            .with_max_incoming_reservations(1),
    )
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

    for index in 0..2 {
        let source_task_id = format!("task-terminal-{index}");
        let transfer = primary
            .prepare_transfer_preflight("peer-secondary", &source_task_id)
            .await
            .unwrap();
        primary
            .prepare_transfer_commit(
                &transfer.transfer_id,
                json!({"task": {"source_task_id": source_task_id}}),
            )
            .await
            .unwrap();
        let _ = next_incoming_transfer_request(&secondary).await;
        let capacity_error = primary
            .prepare_transfer_preflight("peer-secondary", "task-blocked")
            .await
            .unwrap_err();
        assert!(capacity_error
            .to_string()
            .contains("too many active incoming"));

        secondary
            .mark_import_ack_completed(&transfer.transfer_id)
            .await
            .unwrap();
    }

    let admitted = primary
        .prepare_transfer_preflight("peer-secondary", "task-after-terminal-cleanup")
        .await
        .unwrap();
    assert!(!admitted.transfer_id.is_empty());
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

/// Finalizing is the one peer request that waits on a *person's agent*.
///
/// `kanna-server` asks the source agent to wrap up, waits for it to go idle,
/// tells it to quit and waits for the exit — minutes for a busy agent, which is
/// the case the whole redesign exists for. While that shared the ordinary 15 s
/// peer-request window, the destination gave up on every wrap-up longer than a
/// few seconds, and its import work item spent one of eight attempts on a
/// finalization that was proceeding normally. Those attempts are the budget
/// reserved for genuinely transient failures — a locked OpenCode store, an
/// artifact fetch that dropped — so waiting must not come out of it.
///
/// The transfer still *completed* before this was fixed, off the cached
/// finalization result a later retry picked up, which is exactly why only a
/// test that watches the first request can catch it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_finalization_slower_than_the_peer_request_window_answers_the_first_request() {
    let temp = tempfile::tempdir().unwrap();

    // Both ends run with an ordinary peer-request window far shorter than the
    // finalization takes. Only the separate finalization window keeps this
    // request alive.
    let secondary = std::sync::Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0)
                .with_peer_request_timeout(Duration::from_millis(250)),
        )
        .await
        .unwrap(),
    );
    let primary = std::sync::Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
                .with_peer_request_timeout(Duration::from_millis(250)),
        )
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
                "task": { "source_task_id": "task-source" }
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

        // The wrap-up: longer than the peer-request window by an order of
        // magnitude, the same shape a busy agent has at full scale.
        tokio::time::sleep(Duration::from_millis(2_500)).await;

        primary_for_completion
            .complete_outgoing_transfer_finalization(
                &event.transfer_id,
                Ok(kanna_task_transfer::runtime::FinalizedOutgoingTransfer {
                    payload: json!({
                        "task": {
                            "source_task_id": "task-source",
                            "resume_session_id": "019d-slow-wrap-up",
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
        .expect(
            "the first finalization request must survive a wrap-up longer than the ordinary \
             peer-request window; erroring here spends an import attempt on waiting",
        );

    completion.await.unwrap();
    assert_eq!(
        finalized.payload["task"]["resume_session_id"],
        json!("019d-slow-wrap-up"),
    );
    assert!(finalized.finalized_cleanly);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_outgoing_finalization_retry_joins_one_desktop_operation() {
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
    // The finalization window, not the peer-request one, is what bounds this
    // wait now — and it is the *source* that owns it, because the source is
    // where the budget is being spent. A wrap-up that outlives even that budget
    // is still a case the source has to answer, and a retry still has to join
    // the desktop operation already running rather than starting a second one.
    let primary = std::sync::Arc::new(
        TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-primary", "Primary", temp.path(), 0)
                .with_finalization_request_timeout(Duration::from_millis(250)),
        )
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
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&secondary).await;

    let first_error = secondary
        .finalize_outgoing_transfer(&preflight.transfer_id)
        .await
        .expect_err("first request should time out while desktop finalization is slow");
    assert!(
        first_error.to_string().contains("timed out"),
        "unexpected first finalization error: {first_error}",
    );
    let first_event = primary.next_event().await.unwrap();
    let RuntimeEvent::OutgoingTransferFinalizationRequested(first_event) = first_event else {
        panic!("expected one outgoing finalization event");
    };
    assert_eq!(first_event.transfer_id, preflight.transfer_id);

    let retry_runtime = std::sync::Arc::clone(&secondary);
    let retry_transfer_id = preflight.transfer_id.clone();
    let retry = tokio::spawn(async move {
        retry_runtime
            .finalize_outgoing_transfer(&retry_transfer_id)
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), primary.next_event())
            .await
            .is_err(),
        "retry emitted a second destructive desktop finalization event",
    );

    let expected = kanna_task_transfer::runtime::FinalizedOutgoingTransfer {
        payload: json!({
            "task": {
                "source_task_id": "task-source",
                "resume_session_id": "019d-final-single-flight",
            }
        }),
        finalized_cleanly: true,
    };
    primary
        .complete_outgoing_transfer_finalization(&preflight.transfer_id, Ok(expected.clone()))
        .await
        .unwrap();

    assert_eq!(retry.await.unwrap().unwrap(), expected);
    assert_eq!(
        secondary
            .finalize_outgoing_transfer(&preflight.transfer_id)
            .await
            .unwrap(),
        expected,
        "post-completion retry should use the cached finalization result",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), primary.next_event())
            .await
            .is_err(),
        "cached retry emitted another desktop finalization event",
    );
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
        .stage_transfer_artifact("transfer-1", "artifact-1", bundle_path.clone(), false)
        .await
        .unwrap();

    let fetched = runtime
        .fetch_transfer_artifact("transfer-1", "artifact-1")
        .await
        .unwrap();

    assert_eq!(fetched.path, bundle_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_artifact_paths_encode_dot_dotdot_and_separator_transfer_ids() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-safe-artifacts",
        "Primary",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let peer_artifact_root = peer_artifact_root(temp.path(), "peer-safe-artifacts");
    let mut misplaced = Vec::new();

    for (index, transfer_id) in [".", "..", "nested/transfer", r"nested\transfer"]
        .into_iter()
        .enumerate()
    {
        let source_path = temp.path().join(format!("unsafe-{index}.bundle"));
        std::fs::write(&source_path, format!("artifact-{index}")).unwrap();
        let artifact_id = format!("artifact-{index}");
        runtime
            .stage_transfer_artifact(transfer_id, &artifact_id, source_path, true)
            .await
            .unwrap();
        let fetched = runtime
            .fetch_transfer_artifact(transfer_id, &artifact_id)
            .await
            .unwrap();
        let expected_transfer_dir =
            peer_artifact_root.join(URL_SAFE_NO_PAD.encode(transfer_id.as_bytes()));
        if fetched.path.parent() != Some(expected_transfer_dir.as_path()) {
            misplaced.push((transfer_id.to_owned(), fetched.path, expected_transfer_dir));
        }
    }

    assert!(
        misplaced.is_empty(),
        "unsafe transfer IDs escaped or created non-canonical managed paths: {misplaced:?}",
    );
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
    let bundle_bytes = (0..(256 * 1024 + 37))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&bundle_path, &bundle_bytes).unwrap();

    let preflight = source
        .prepare_transfer_preflight("peer-destination", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-remote",
            bundle_path.clone(),
            false,
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
    destination
        .mark_import_ack_completed(&preflight.transfer_id)
        .await
        .unwrap();
    assert!(
        !fetched.path.exists(),
        "receiver staging artifact survived terminal success cleanup",
    );
}

/// POSIX `NAME_MAX`: one path component may not exceed 255 bytes.
const NAME_MAX_BYTES: usize = 255;

fn artifact_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(std::ffi::OsStr::to_str)
        .expect("artifact path has a UTF-8 file name")
        .to_owned()
}

/// Staging and fetching must both keep the artifact's on-disk name inside
/// `NAME_MAX`, however long the file it was staged from is named.
///
/// The pre-fix scheme spent the artifact id twice — the source stored
/// `<artifact-id>-<basename>` and the receiver fetched that into
/// `<artifact-id>-<that whole name>` — so a descriptive basename pushed the
/// receiver past 255 bytes and killed the transfer mid-flight with
/// `ENAMETOOLONG` ("File name too long").
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn artifact_names_stay_inside_name_max_for_long_staged_basenames() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-long-name",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-long-name",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-long-name").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination-long-name", "task-source")
        .await
        .unwrap();
    // An artifact id of the shape the desktop mints, and a basename right at
    // the old overflow length.
    let artifact_id = format!("{}-session-archive", preflight.transfer_id);
    let staged_name = format!("{}.tar.gz", "a".repeat(NAME_MAX_BYTES - 7));
    assert_eq!(staged_name.len(), NAME_MAX_BYTES);
    let staged_path = temp.path().join(&staged_name);
    let payload = b"long-basename artifact".to_vec();
    std::fs::write(&staged_path, &payload).unwrap();

    source
        .stage_transfer_artifact(&preflight.transfer_id, &artifact_id, staged_path, true)
        .await
        .unwrap();
    let managed = source
        .fetch_transfer_artifact(&preflight.transfer_id, &artifact_id)
        .await
        .unwrap()
        .path;
    let managed_name = artifact_file_name(&managed);
    assert!(
        managed_name.len() <= NAME_MAX_BYTES,
        "staged artifact name overflowed NAME_MAX: {} bytes",
        managed_name.len(),
    );

    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-long-name",
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
        .fetch_transfer_artifact(&preflight.transfer_id, &artifact_id)
        .await
        .unwrap()
        .path;
    let fetched_name = artifact_file_name(&fetched);
    assert!(
        fetched_name.len() <= NAME_MAX_BYTES,
        "fetched artifact name overflowed NAME_MAX: {} bytes",
        fetched_name.len(),
    );
    assert_eq!(std::fs::read(&fetched).unwrap(), payload);
}

/// The exact shape that failed live on 2026-08-07: a Claude session archive,
/// whose staged path is `kanna-transfer-<64-hex transfer id>-claude-session.tar.gz`
/// under an artifact id of `<transfer id>-claude-session`. Doubling the id put
/// the receiver's name at ~261 bytes, so every Claude (and Copilot) task that
/// carried a session archive died on fetch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_session_archive_artifact_survives_the_name_max_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-claude-archive",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-claude-archive",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-claude-archive").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination-claude-archive", "task-source")
        .await
        .unwrap();
    let transfer_id = preflight.transfer_id.clone();
    assert_eq!(
        transfer_id.len(),
        64,
        "transfer ids are 32 hex-encoded bytes"
    );
    let artifact_id = format!("{transfer_id}-claude-session");
    let staged_name = format!("kanna-transfer-{transfer_id}-claude-session.tar.gz");
    let legacy_staged_name = format!("{artifact_id}-{staged_name}");
    let legacy_fetched_name = format!("{artifact_id}-{legacy_staged_name}");
    assert!(
        legacy_fetched_name.len() > NAME_MAX_BYTES,
        "fixture no longer models the live failure: {} bytes",
        legacy_fetched_name.len(),
    );

    let staged_path = temp.path().join(&staged_name);
    let payload = b"claude session archive".to_vec();
    std::fs::write(&staged_path, &payload).unwrap();
    source
        .stage_transfer_artifact(&transfer_id, &artifact_id, staged_path, true)
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &transfer_id,
            json!({
                "target_peer_id": "peer-destination-claude-archive",
                "task": {
                    "source_task_id": "task-source"
                }
            }),
        )
        .await
        .unwrap();
    let event = next_incoming_transfer_request(&destination).await;
    assert_eq!(event.transfer_id, transfer_id);

    let fetched = destination
        .fetch_transfer_artifact(&transfer_id, &artifact_id)
        .await
        .unwrap()
        .path;
    assert!(
        artifact_file_name(&fetched).len() <= NAME_MAX_BYTES,
        "fetched Claude archive name overflowed NAME_MAX",
    );
    assert_eq!(std::fs::read(&fetched).unwrap(), payload);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn older_destination_fetches_a_legacy_sealed_artifact_from_a_new_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-new",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-old",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-old").await;

    let destination_identity = destination.local_identity();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: destination_identity.peer_id,
            display_name: destination_identity.display_name,
            endpoint: runtime_endpoint(temp.path(), "peer-destination-old"),
            pid: std::process::id(),
            public_key: destination_identity.public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let bundle_bytes = b"legacy-compatible-bundle";
    let bundle_path = temp.path().join("legacy-source.bundle");
    std::fs::write(&bundle_path, bundle_bytes).unwrap();
    let preflight = source
        .prepare_transfer_preflight("peer-destination-old", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-legacy",
            bundle_path,
            false,
        )
        .await
        .unwrap();

    let destination_secret = stored_runtime_identity(temp.path(), "peer-destination-old");
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let request_id = "legacy-fetch-request";
    let request = PeerRequest::FetchTransferArtifact {
        request_id: request_id.into(),
        transfer_id: preflight.transfer_id.clone(),
        requester_peer_id: "peer-destination-old".into(),
        sealed_payload: seal_json(
            &destination_secret,
            &source_public_key,
            &json!({ "artifact_id": "artifact-legacy" }),
        )
        .unwrap(),
    };
    let mut stream = TcpStream::connect(runtime_endpoint(temp.path(), "peer-source-new"))
        .await
        .unwrap();
    stream
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();
    stream.flush().await.unwrap();
    let mut response_line = String::new();
    BufReader::new(stream)
        .read_line(&mut response_line)
        .await
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(response_line.trim()).unwrap();

    assert_eq!(response["type"], "fetch_transfer_artifact");
    assert!(
        response.get("stream_header").is_none(),
        "legacy response unexpectedly selected streamed framing: {response}",
    );
    let sealed_payload = response["sealed_payload"].as_str().unwrap();
    let metadata = kanna_task_transfer::crypto::open_json(
        &destination_secret,
        &source_public_key,
        sealed_payload,
    )
    .unwrap();
    assert_eq!(metadata["request_id"], request_id);
    assert_eq!(metadata["transfer_id"], preflight.transfer_id);
    assert_eq!(metadata["artifact_framing"], "legacy_sealed_v1");
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(metadata["payload_b64"].as_str().unwrap())
            .unwrap(),
        bundle_bytes,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_destination_cannot_force_legacy_artifact_materialization() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-current-framing",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-current-framing",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-current-framing").await;

    let artifact_path = temp.path().join("current-framing.bundle");
    std::fs::write(&artifact_path, b"must-use-streamed-framing").unwrap();
    let preflight = source
        .prepare_transfer_preflight("peer-destination-current-framing", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-current-framing",
            artifact_path,
            false,
        )
        .await
        .unwrap();

    let destination_identity =
        stored_runtime_identity(temp.path(), "peer-destination-current-framing");
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let request_id = "current-peer-legacy-downgrade";
    let request = PeerRequest::FetchTransferArtifact {
        request_id: request_id.into(),
        transfer_id: preflight.transfer_id.clone(),
        requester_peer_id: "peer-destination-current-framing".into(),
        sealed_payload: seal_json(
            &destination_identity,
            &source_public_key,
            &json!({
                "request_id": request_id,
                "transfer_id": preflight.transfer_id,
                "artifact_id": "artifact-current-framing",
                "artifact_framing": "legacy_sealed_v1",
            }),
        )
        .unwrap(),
    };
    let mut stream =
        TcpStream::connect(runtime_endpoint(temp.path(), "peer-source-current-framing"))
            .await
            .unwrap();
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

    let PeerResponse::Error { message, .. } = response else {
        panic!("current-capability peer forced legacy materialization: {response:?}");
    };
    assert!(
        message.contains("does not match negotiated streamed_v3 framing"),
        "unexpected downgrade rejection: {message}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_legacy_artifact_reader_releases_materialization_admission_for_retry() {
    let temp = tempfile::tempdir().unwrap();
    // The single-flight probe below has to observe the retained permit before
    // this timeout releases it, so the window it polls in and this value move
    // together. A 300ms permit against a 250ms probe left no room at all once
    // the box was busy.
    let peer_timeout = Duration::from_secs(5);
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source-stalled-legacy", "Source", temp.path(), 0)
            .with_peer_request_timeout(peer_timeout),
    )
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-stalled-legacy",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-stalled-legacy").await;

    let destination_identity = destination.local_identity();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: destination_identity.peer_id,
            display_name: destination_identity.display_name,
            endpoint: runtime_endpoint(temp.path(), "peer-destination-stalled-legacy"),
            pid: std::process::id(),
            public_key: destination_identity.public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let preflight = source
        .prepare_transfer_preflight("peer-destination-stalled-legacy", "task-source")
        .await
        .unwrap();
    let large_path = temp.path().join("stalled-legacy-large.bundle");
    std::fs::write(&large_path, vec![b'x'; 512 * 1024]).unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-stalled-large",
            large_path,
            false,
        )
        .await
        .unwrap();
    let retry_path = temp.path().join("stalled-legacy-retry.bundle");
    std::fs::write(&retry_path, b"retry-admitted").unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-stalled-retry",
            retry_path,
            false,
        )
        .await
        .unwrap();

    let destination_secret =
        stored_runtime_identity(temp.path(), "peer-destination-stalled-legacy");
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let source_endpoint = runtime_endpoint(temp.path(), "peer-source-stalled-legacy");
    let make_request = |request_id: &str, artifact_id: &str| PeerRequest::FetchTransferArtifact {
        request_id: request_id.into(),
        transfer_id: preflight.transfer_id.clone(),
        requester_peer_id: "peer-destination-stalled-legacy".into(),
        sealed_payload: seal_json(
            &destination_secret,
            &source_public_key,
            &json!({ "artifact_id": artifact_id }),
        )
        .unwrap(),
    };

    let mut stalled_stream = TcpStream::connect(&source_endpoint).await.unwrap();
    stalled_stream
        .write_all(
            format!(
                "{}\n",
                serde_json::to_string(&make_request(
                    "stalled-legacy-request",
                    "artifact-stalled-large",
                ))
                .unwrap(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    stalled_stream.flush().await.unwrap();

    let saw_single_flight = tokio::time::timeout(peer_timeout / 2, async {
        loop {
            let mut contender = TcpStream::connect(&source_endpoint).await.unwrap();
            contender
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&make_request(
                            "stalled-legacy-contender",
                            "artifact-stalled-retry",
                        ))
                        .unwrap(),
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut response_line = String::new();
            BufReader::new(contender)
                .read_line(&mut response_line)
                .await
                .unwrap();
            let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
            if matches!(
                response,
                PeerResponse::Error { ref message, .. }
                    if message.contains("materialization capacity is exhausted")
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(
        saw_single_flight.is_ok(),
        "stalled response never retained the legacy single-flight permit",
    );

    tokio::time::sleep(peer_timeout + Duration::from_millis(150)).await;
    let mut retry = TcpStream::connect(&source_endpoint).await.unwrap();
    retry
        .write_all(
            format!(
                "{}\n",
                serde_json::to_string(&make_request(
                    "stalled-legacy-retry",
                    "artifact-stalled-retry",
                ))
                .unwrap(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut retry_response_line = String::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        BufReader::new(retry).read_line(&mut retry_response_line),
    )
    .await
    .expect("retry remained blocked after the configured peer timeout")
    .unwrap();
    let retry_response: PeerResponse = serde_json::from_str(retry_response_line.trim()).unwrap();
    assert!(
        matches!(
            retry_response,
            PeerResponse::FetchTransferArtifact {
                stream_header: None,
                ..
            }
        ),
        "retry was not admitted after the stalled response timed out: {retry_response:?}",
    );
    drop(stalled_stream);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_stalled_legacy_readers_do_not_exhaust_listener_admission() {
    let temp = tempfile::tempdir().unwrap();
    let peer_timeout = Duration::from_secs(2);
    let source = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-source-stalled-admission", "Source", temp.path(), 0)
            .with_peer_request_timeout(peer_timeout)
            .with_max_incoming_connections(2),
    )
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-stalled-admission",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-stalled-admission").await;

    let destination_identity = destination.local_identity();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: destination_identity.peer_id,
            display_name: destination_identity.display_name,
            endpoint: runtime_endpoint(temp.path(), "peer-destination-stalled-admission"),
            pid: std::process::id(),
            public_key: destination_identity.public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let preflight = source
        .prepare_transfer_preflight("peer-destination-stalled-admission", "task-source")
        .await
        .unwrap();
    let artifact_path = temp.path().join("stalled-admission.bundle");
    std::fs::write(&artifact_path, vec![b'x'; 8 * 1024 * 1024]).unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-stalled-admission",
            artifact_path,
            false,
        )
        .await
        .unwrap();

    let destination_secret =
        stored_runtime_identity(temp.path(), "peer-destination-stalled-admission");
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let source_endpoint = runtime_endpoint(temp.path(), "peer-source-stalled-admission");
    let make_request = |request_id: &str| PeerRequest::FetchTransferArtifact {
        request_id: request_id.into(),
        transfer_id: preflight.transfer_id.clone(),
        requester_peer_id: "peer-destination-stalled-admission".into(),
        sealed_payload: seal_json(
            &destination_secret,
            &source_public_key,
            &json!({ "artifact_id": "artifact-stalled-admission" }),
        )
        .unwrap(),
    };

    let mut stalled_streams = Vec::new();
    for index in 0..2 {
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(1024).unwrap();
        let mut stream = socket
            .connect(source_endpoint.parse().unwrap())
            .await
            .unwrap();
        let request = make_request(&format!("stalled-admission-{index}"));
        stream
            .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
            .await
            .unwrap();
        stream.flush().await.unwrap();
        stalled_streams.push(stream);
        tokio::time::sleep(peer_timeout + Duration::from_millis(200)).await;
    }

    let mut probe = TcpStream::connect(&source_endpoint).await.unwrap();
    let probe_request = PeerRequest::GetAuthenticatedRequestEpoch {
        request_id: "stalled-admission-probe".into(),
    };
    probe
        .write_all(format!("{}\n", serde_json::to_string(&probe_request).unwrap(),).as_bytes())
        .await
        .unwrap();
    let mut response_line = String::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        BufReader::new(probe).read_line(&mut response_line),
    )
    .await
    .expect("listener admission remained exhausted by timed-out legacy responses")
    .unwrap();
    let response: PeerResponse = serde_json::from_str(response_line.trim()).unwrap();
    assert!(
        matches!(
            response,
            PeerResponse::AuthenticatedRequestEpoch {
                ref request_id,
                ..
            } if request_id == "stalled-admission-probe"
        ),
        "probe was not admitted after repeated stalled readers: {response:?}",
    );

    drop(stalled_streams);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_rejects_artifacts_above_the_legacy_materialization_limit() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-legacy-limit",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-legacy-limit",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-legacy-limit").await;

    let destination_identity = destination.local_identity();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: destination_identity.peer_id,
            display_name: destination_identity.display_name,
            endpoint: runtime_endpoint(temp.path(), "peer-destination-legacy-limit"),
            pid: std::process::id(),
            public_key: destination_identity.public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let artifact_path = temp.path().join("over-legacy-limit.bundle");
    let artifact = std::fs::File::create(&artifact_path).unwrap();
    artifact
        .set_len(kanna_task_transfer::runtime::MAX_LEGACY_TRANSFER_ARTIFACT_BYTES + 1)
        .unwrap();
    let preflight = source
        .prepare_transfer_preflight("peer-destination-legacy-limit", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-over-legacy-limit",
            artifact_path,
            false,
        )
        .await
        .unwrap();

    let destination_secret = stored_runtime_identity(temp.path(), "peer-destination-legacy-limit");
    let source_public_key = parse_public_key(&source.local_identity().public_key).unwrap();
    let request = PeerRequest::FetchTransferArtifact {
        request_id: "legacy-limit-request".into(),
        transfer_id: preflight.transfer_id.clone(),
        requester_peer_id: "peer-destination-legacy-limit".into(),
        sealed_payload: seal_json(
            &destination_secret,
            &source_public_key,
            &json!({ "artifact_id": "artifact-over-legacy-limit" }),
        )
        .unwrap(),
    };
    let mut stream = TcpStream::connect(runtime_endpoint(temp.path(), "peer-source-legacy-limit"))
        .await
        .unwrap();
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

    let PeerResponse::Error { message, .. } = response else {
        panic!("legacy source materialized an artifact above its limit: {response:?}");
    };
    assert!(
        message.contains(&format!(
            "maximum size of {} bytes",
            kanna_task_transfer::runtime::MAX_LEGACY_TRANSFER_ARTIFACT_BYTES,
        )),
        "unexpected legacy limit rejection: {message}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_destination_fetches_a_legacy_sealed_artifact_from_an_older_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-old",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-destination-new", "Destination", temp.path(), 0)
            .with_peer_response_limits(512, 32 * 1024),
    )
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-new").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination-new", "task-source")
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-new",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&destination).await;

    let legacy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let legacy_port = legacy_listener.local_addr().unwrap().port();
    let source_identity = stored_runtime_identity(temp.path(), "peer-source-old");
    let source_public_key = source.local_identity().public_key;
    let destination_public_key =
        parse_public_key(&destination.local_identity().public_key).unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source-old".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{legacy_port}"),
            pid: std::process::id(),
            public_key: source_public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let transfer_id = preflight.transfer_id.clone();
    let bundle_bytes = vec![b'x'; 4 * 1024];
    let served_bundle_bytes = bundle_bytes.clone();
    let legacy_server = tokio::spawn(async move {
        let (stream, _) = legacy_listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        let PeerRequest::FetchTransferArtifact {
            request_id,
            transfer_id: requested_transfer_id,
            ..
        } = serde_json::from_str(request_line.trim()).unwrap()
        else {
            panic!("expected artifact fetch request");
        };
        assert_eq!(requested_transfer_id, transfer_id);
        let sealed_payload = seal_json(
            &source_identity,
            &destination_public_key,
            &json!({
                "artifact_id": "artifact-legacy",
                "filename": "legacy.bundle",
                "payload_b64": URL_SAFE_NO_PAD.encode(&served_bundle_bytes),
            }),
        )
        .unwrap();
        let response = json!({
            "type": "fetch_transfer_artifact",
            "request_id": request_id,
            "transfer_id": requested_transfer_id,
            "sealed_payload": sealed_payload,
        });
        let response_line = format!("{response}\n");
        assert!(
            response_line.len() > 512,
            "legacy fixture did not exceed the generic peer frame budget",
        );
        writer.write_all(response_line.as_bytes()).await.unwrap();
    });

    let fetched = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-legacy")
        .await
        .unwrap();
    assert_eq!(std::fs::read(fetched.path).unwrap(), bundle_bytes);
    legacy_server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_legacy_artifact_response_rejects_allocation_amplification() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-amplification",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-amplification",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-amplification").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination-amplification", "task-source")
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-amplification",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&destination).await;

    let legacy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let legacy_port = legacy_listener.local_addr().unwrap().port();
    let source_identity = stored_runtime_identity(temp.path(), "peer-source-amplification");
    let source_public_key = source.local_identity().public_key;
    let destination_public_key =
        parse_public_key(&destination.local_identity().public_key).unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source-amplification".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{legacy_port}"),
            pid: std::process::id(),
            public_key: source_public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let transfer_id = preflight.transfer_id.clone();
    let legacy_server = tokio::spawn(async move {
        let (stream, _) = legacy_listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        let PeerRequest::FetchTransferArtifact {
            request_id,
            transfer_id: requested_transfer_id,
            ..
        } = serde_json::from_str(request_line.trim()).unwrap()
        else {
            panic!("expected artifact fetch request");
        };
        assert_eq!(requested_transfer_id, transfer_id);
        let allocation_amplifier = vec![json!([[], [], []]); 4_096];
        let sealed_payload = seal_json(
            &source_identity,
            &destination_public_key,
            &json!({
                "request_id": request_id,
                "transfer_id": requested_transfer_id,
                "artifact_id": "artifact-amplification",
                "filename": "amplification.bundle",
                "payload_b64": "",
                "allocation_amplifier": allocation_amplifier,
            }),
        )
        .unwrap();
        let response = PeerResponse::FetchTransferArtifact {
            request_id,
            transfer_id: requested_transfer_id,
            sealed_payload,
            stream_header: None,
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
    });

    let result = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-amplification")
        .await;
    legacy_server.await.unwrap();
    let error = result.expect_err(
        "authenticated legacy metadata must reject unknown nested structures before Value allocation",
    );
    assert!(
        error.to_string().contains("unknown field"),
        "unexpected allocation-amplification rejection: {error}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bidirectional_legacy_fetches_share_each_process_memory_budget() {
    let temp = tempfile::tempdir().unwrap();
    let first = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-legacy-first",
        "First",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let second = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-legacy-second",
        "Second",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&first, &second, "peer-legacy-second").await;

    for runtime in [&first, &second] {
        let identity = runtime.local_identity();
        let endpoint = runtime_endpoint(temp.path(), &identity.peer_id);
        PeerRegistry::new(temp.path().to_path_buf())
            .write_entry(&PeerRegistryEntry {
                peer_id: identity.peer_id,
                display_name: identity.display_name,
                endpoint,
                pid: std::process::id(),
                public_key: identity.public_key,
                protocol_version: 2,
                accepting_transfers: true,
            })
            .unwrap();
    }

    let first_to_second = first
        .prepare_transfer_preflight("peer-legacy-second", "task-first")
        .await
        .unwrap();
    let second_to_first = second
        .prepare_transfer_preflight("peer-legacy-first", "task-second")
        .await
        .unwrap();
    let first_artifact = temp.path().join("first-legacy.bundle");
    std::fs::write(&first_artifact, vec![b'a'; 4 * 1024 * 1024]).unwrap();
    first
        .stage_transfer_artifact(
            &first_to_second.transfer_id,
            "artifact-first",
            first_artifact,
            false,
        )
        .await
        .unwrap();
    let second_artifact = temp.path().join("second-legacy.bundle");
    std::fs::write(&second_artifact, vec![b'b'; 4 * 1024 * 1024]).unwrap();
    second
        .stage_transfer_artifact(
            &second_to_first.transfer_id,
            "artifact-second",
            second_artifact,
            false,
        )
        .await
        .unwrap();

    first
        .prepare_transfer_commit(
            &first_to_second.transfer_id,
            json!({
                "target_peer_id": "peer-legacy-second",
                "task": { "source_task_id": "task-first" }
            }),
        )
        .await
        .unwrap();
    let _second_incoming = next_incoming_transfer_request(&second).await;
    second
        .prepare_transfer_commit(
            &second_to_first.transfer_id,
            json!({
                "target_peer_id": "peer-legacy-first",
                "task": { "source_task_id": "task-second" }
            }),
        )
        .await
        .unwrap();
    let _first_incoming = next_incoming_transfer_request(&first).await;

    let (first_receive, second_receive) = tokio::join!(
        first.fetch_transfer_artifact(&second_to_first.transfer_id, "artifact-second"),
        second.fetch_transfer_artifact(&first_to_second.transfer_id, "artifact-first"),
    );
    let results = [first_receive, second_receive];
    assert!(
        results.iter().any(|result| {
            result.as_ref().is_err_and(|error| {
                error.to_string().contains("legacy artifact")
                    && error.to_string().contains("capacity is exhausted")
            })
        }),
        "bidirectional legacy transfers both crossed the per-process aggregate memory gate",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destination_protocol_change_after_preflight_upgrades_artifact_framing_monotonically() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-framing",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-framing",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-framing").await;

    let destination_identity = destination.local_identity();
    let destination_endpoint = runtime_endpoint(temp.path(), "peer-destination-framing");
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: destination_identity.peer_id.clone(),
            display_name: destination_identity.display_name.clone(),
            endpoint: destination_endpoint.clone(),
            pid: std::process::id(),
            public_key: destination_identity.public_key.clone(),
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let artifact_path = temp.path().join("framing-change.bundle");
    std::fs::write(&artifact_path, b"framing-change-bundle").unwrap();
    let preflight = source
        .prepare_transfer_preflight("peer-destination-framing", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-framing",
            artifact_path,
            false,
        )
        .await
        .unwrap();

    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: destination_identity.peer_id,
            display_name: destination_identity.display_name,
            endpoint: destination_endpoint,
            pid: std::process::id(),
            public_key: destination_identity.public_key,
            protocol_version: 3,
            accepting_transfers: true,
        })
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-framing",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&destination).await;

    let fetched = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-framing")
        .await
        .expect("a durable v2 preflight must allow the destination to upgrade to v3 framing");
    assert_eq!(
        std::fs::read(fetched.path).unwrap(),
        b"framing-change-bundle",
        "the monotonic framing upgrade changed the fetched artifact",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_artifact_response_replay_rejects_rewritten_outer_ids() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-replay",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-replay",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-replay").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination-replay", "task-source")
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-replay",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&destination).await;

    let replay_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let replay_port = replay_listener.local_addr().unwrap().port();
    let source_identity = stored_runtime_identity(temp.path(), "peer-source-replay");
    let source_public_key = source.local_identity().public_key;
    let destination_public_key =
        parse_public_key(&destination.local_identity().public_key).unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source-replay".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{replay_port}"),
            pid: std::process::id(),
            public_key: source_public_key,
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let replay_server = tokio::spawn(async move {
        let (stream, _) = replay_listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        let PeerRequest::FetchTransferArtifact {
            request_id,
            transfer_id,
            ..
        } = serde_json::from_str(request_line.trim()).unwrap()
        else {
            panic!("expected artifact fetch request");
        };
        let sealed_payload = seal_json(
            &source_identity,
            &destination_public_key,
            &json!({
                "request_id": "stale-fetch-request",
                "transfer_id": "stale-transfer",
                "artifact_id": "artifact-replay",
                "artifact_framing": "legacy_sealed_v1",
                "filename": "replayed.bundle",
                "payload_b64": URL_SAFE_NO_PAD.encode(b"stale-bundle"),
            }),
        )
        .unwrap();
        let response = PeerResponse::FetchTransferArtifact {
            request_id,
            transfer_id,
            sealed_payload,
            stream_header: None,
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
    });

    let error = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-replay")
        .await
        .expect_err("rewritten outer ids must not authenticate a stale sealed response");
    assert!(
        error.to_string().contains("authenticated request id"),
        "unexpected replay rejection: {error}",
    );
    replay_server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streamed_artifact_response_rejects_authenticated_framing_downgrade() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-downgrade",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-downgrade",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-downgrade").await;

    let preflight = source
        .prepare_transfer_preflight("peer-destination-downgrade", "task-source")
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-downgrade",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&destination).await;

    let downgrade_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let downgrade_port = downgrade_listener.local_addr().unwrap().port();
    let source_identity = stored_runtime_identity(temp.path(), "peer-source-downgrade");
    let source_public_key = source.local_identity().public_key;
    let destination_public_key =
        parse_public_key(&destination.local_identity().public_key).unwrap();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source-downgrade".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{downgrade_port}"),
            pid: std::process::id(),
            public_key: source_public_key,
            protocol_version: 3,
            accepting_transfers: true,
        })
        .unwrap();

    let downgrade_server = tokio::spawn(async move {
        let (stream, _) = downgrade_listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        let PeerRequest::FetchTransferArtifact {
            request_id,
            transfer_id,
            ..
        } = serde_json::from_str(request_line.trim()).unwrap()
        else {
            panic!("expected artifact fetch request");
        };
        let sealed_payload = seal_json(
            &source_identity,
            &destination_public_key,
            &json!({
                "request_id": request_id,
                "transfer_id": transfer_id,
                "artifact_id": "artifact-downgrade",
                "artifact_framing": "legacy_sealed_v1",
                "filename": "downgraded.bundle",
                "plaintext_size": 0,
            }),
        )
        .unwrap();
        let context = artifact_stream_context(&request_id, &transfer_id, "artifact-downgrade", 0);
        let sealer =
            StreamSealer::new(&source_identity, &destination_public_key, &context).unwrap();
        let response = PeerResponse::FetchTransferArtifact {
            request_id,
            transfer_id,
            sealed_payload,
            stream_header: Some(sealer.header()),
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
    });

    let error = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-downgrade")
        .await
        .expect_err("authenticated legacy framing must not downgrade a streamed request");
    assert!(
        error
            .to_string()
            .contains("authenticated framing does not match"),
        "unexpected downgrade rejection: {error}",
    );
    downgrade_server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_artifacts_are_deleted_on_ttl_shutdown_and_startup_while_borrowed_files_survive() {
    let temp = tempfile::tempdir().unwrap();
    let startup_orphan = peer_artifact_root(temp.path(), "peer-cleanup")
        .join("stale-transfer")
        .join("orphan.bundle");
    std::fs::create_dir_all(startup_orphan.parent().unwrap()).unwrap();
    std::fs::write(&startup_orphan, b"orphan").unwrap();

    let managed_shutdown_path;
    let borrowed_path = temp.path().join("borrowed-rollout.jsonl");
    std::fs::write(&borrowed_path, b"borrowed").unwrap();
    {
        let runtime = TransferRuntime::spawn(
            RuntimeConfig::for_tests("peer-cleanup", "Cleanup", temp.path(), 0)
                .with_pending_transfer_ttl(Duration::from_millis(5)),
        )
        .await
        .unwrap();
        assert!(
            !startup_orphan.exists(),
            "startup reconciliation retained an orphaned staging artifact",
        );

        let owned_ttl = temp.path().join("owned-ttl.bundle");
        std::fs::write(&owned_ttl, b"ttl").unwrap();
        runtime
            .stage_transfer_artifact("transfer-ttl", "artifact-ttl", owned_ttl.clone(), true)
            .await
            .unwrap();
        let managed_ttl = runtime
            .fetch_transfer_artifact("transfer-ttl", "artifact-ttl")
            .await
            .unwrap()
            .path;
        assert!(!owned_ttl.exists());
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(runtime
            .fetch_transfer_artifact("transfer-ttl", "artifact-ttl")
            .await
            .is_err(),);
        assert!(
            !managed_ttl.exists(),
            "TTL pruning retained an owned artifact"
        );

        let owned_shutdown = temp.path().join("owned-shutdown.bundle");
        std::fs::write(&owned_shutdown, b"shutdown").unwrap();
        runtime
            .stage_transfer_artifact(
                "transfer-shutdown",
                "artifact-shutdown",
                owned_shutdown.clone(),
                true,
            )
            .await
            .unwrap();
        managed_shutdown_path = runtime
            .fetch_transfer_artifact("transfer-shutdown", "artifact-shutdown")
            .await
            .unwrap()
            .path;
        runtime
            .stage_transfer_artifact(
                "transfer-borrowed",
                "artifact-borrowed",
                borrowed_path.clone(),
                false,
            )
            .await
            .unwrap();
    }
    assert!(
        !managed_shutdown_path.exists(),
        "runtime shutdown retained an owned artifact",
    );
    assert!(
        borrowed_path.exists(),
        "runtime shutdown deleted a borrowed source artifact",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hostile_self_peer_id_cannot_escape_artifact_cleanup_root() {
    let temp = tempfile::tempdir().unwrap();
    let registry_root = temp.path().join("registry");
    let absolute_canary_root = temp.path().join("absolute-must-survive");
    let absolute_canary = absolute_canary_root.join("canary.txt");
    std::fs::create_dir_all(registry_root.join("artifacts")).unwrap();
    std::fs::create_dir_all(&absolute_canary_root).unwrap();
    std::fs::write(&absolute_canary, b"safe").unwrap();
    let absolute_peer_id = absolute_canary_root.to_string_lossy().into_owned();

    let invalid = TransferRuntime::spawn(RuntimeConfig::for_tests(
        &absolute_peer_id,
        "Absolute path peer",
        &registry_root,
        0,
    ))
    .await;
    assert!(
        invalid.is_err(),
        "absolute peer id unexpectedly passed validation"
    );
    assert!(
        absolute_canary.exists(),
        "startup cleanup acted on an absolute peer id before validating it",
    );

    let dot_canary = registry_root.join("dot-canary.txt");
    std::fs::create_dir_all(registry_root.join("artifacts")).unwrap();
    std::fs::write(&dot_canary, b"safe").unwrap();

    let managed_path;
    {
        let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
            "..",
            "Dot path peer",
            &registry_root,
            0,
        ))
        .await
        .unwrap();
        assert!(
            dot_canary.exists(),
            "startup cleanup treated a dot peer id as path traversal",
        );

        let source = temp.path().join("owned.bundle");
        std::fs::write(&source, b"owned").unwrap();
        runtime
            .stage_transfer_artifact("transfer-1", "artifact-1", source, true)
            .await
            .unwrap();
        managed_path = runtime
            .fetch_transfer_artifact("transfer-1", "artifact-1")
            .await
            .unwrap()
            .path;
        assert!(
            managed_path.starts_with(registry_root.join("artifacts")),
            "managed artifact escaped its registry root: {managed_path:?}",
        );
    }

    assert!(
        absolute_canary.exists(),
        "drop cleanup removed the absolute canary"
    );
    assert!(dot_canary.exists(), "drop cleanup removed the dot canary");
    assert!(
        !managed_path.exists(),
        "drop cleanup retained the managed artifact"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_owned_artifact_restaging_retains_the_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-restage",
        "Restage",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let first_source = temp.path().join("first").join("bundle.tar");
    let second_source = temp.path().join("second").join("bundle.tar");
    std::fs::create_dir_all(first_source.parent().unwrap()).unwrap();
    std::fs::create_dir_all(second_source.parent().unwrap()).unwrap();
    std::fs::write(&first_source, b"first-generation").unwrap();
    std::fs::write(&second_source, b"second-generation").unwrap();

    runtime
        .stage_transfer_artifact(
            "transfer-redelivery",
            "artifact-redelivery",
            first_source,
            true,
        )
        .await
        .unwrap();
    let first_managed = runtime
        .fetch_transfer_artifact("transfer-redelivery", "artifact-redelivery")
        .await
        .unwrap()
        .path;
    runtime
        .stage_transfer_artifact(
            "transfer-redelivery",
            "artifact-redelivery",
            second_source,
            true,
        )
        .await
        .unwrap();
    let retained = runtime
        .fetch_transfer_artifact("transfer-redelivery", "artifact-redelivery")
        .await
        .unwrap()
        .path;

    assert_eq!(retained, first_managed);
    assert_eq!(
        std::fs::read(retained).unwrap(),
        b"second-generation",
        "duplicate staging deleted or retained the stale managed artifact",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_rejects_artifacts_over_128_mib_before_streaming_them() {
    let temp = tempfile::tempdir().unwrap();
    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-oversize",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-destination-oversize",
        "Destination",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    pair_peers(&source, &destination, "peer-destination-oversize").await;

    let artifact_path = temp.path().join("oversize.bundle");
    let artifact = std::fs::File::create(&artifact_path).unwrap();
    artifact
        .set_len(kanna_task_transfer::runtime::MAX_TRANSFER_ARTIFACT_BYTES + 1)
        .unwrap();
    let preflight = source
        .prepare_transfer_preflight("peer-destination-oversize", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-oversize",
            artifact_path,
            false,
        )
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-oversize",
                "task": { "source_task_id": "task-source" }
            }),
        )
        .await
        .unwrap();
    let _incoming = next_incoming_transfer_request(&destination).await;

    let error = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-oversize")
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("exceeds maximum size"),
        "unexpected oversize error: {error}",
    );
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
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let trust_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    trust_store
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: public_key_to_string(&target_identity.public_key),
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let (line_tx, line_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut reader, request) =
            accept_authenticated_request(&listener, "fixture-owner-epoch").await;
        let line = serde_json::to_string(&request).unwrap();
        line_tx.send(line.clone()).unwrap();
        let PeerRequest::PrepareTransfer { request_id, .. } = request else {
            panic!("expected authenticated prepare request");
        };
        let response = json!({
            "type": "prepare_transfer",
            "request_id": request_id,
            "transfer_id": "transfer-1",
            "source_peer_id": "peer-primary",
            "target_has_repo": false,
        });
        reader
            .get_mut()
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
async fn already_paired_v1_peer_is_reported_unsupported_without_opening_a_companion_stream() {
    let temp = tempfile::tempdir().unwrap();
    let target_identity = TransferIdentity::generate();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-v1".into(),
            display_name: "Legacy".into(),
            endpoint: "127.0.0.1:9".into(),
            pid: std::process::id(),
            public_key: public_key_to_string(&target_identity.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        })
        .unwrap();
    PeerStore::new(trusted_peer_store_path(temp.path(), "peer-current"))
        .upsert(PeerRecord {
            peer_id: "peer-v1".into(),
            display_name: "Legacy".into(),
            public_key: public_key_to_string(&target_identity.public_key),
            capabilities_json: "{\"protocolVersion\":1}".into(),
            paired_at: "2026-07-26T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();
    let current = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-current",
        "Current",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    let error = current
        .observe_peer_companion("peer-v1", "task-1", "generation-1")
        .await
        .unwrap_err();

    assert!(error
        .to_string()
        .contains("does not support visual companions"));
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
            protocol_version: 2,
            accepting_transfers: true,
        })
        .unwrap();

    let trust_store = PeerStore::new(trusted_peer_store_path(temp.path(), "peer-primary"));
    trust_store
        .upsert(PeerRecord {
            peer_id: "peer-target".into(),
            display_name: "Target".into(),
            public_key: public_key_to_string(&target_identity.public_key),
            capabilities_json:
                "{\"protocolVersion\":2,\"authenticatedTaskRequests\":true,\"authenticatedTaskRequestVersion\":1}"
                    .into(),
            paired_at: "2026-04-17T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        })
        .unwrap();

    let (commit_line_tx, commit_line_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut preflight_reader, preflight_request) =
            accept_authenticated_request(&listener, "fixture-owner-epoch").await;
        let PeerRequest::PrepareTransfer {
            request_id: preflight_request_id,
            ..
        } = preflight_request
        else {
            panic!("expected authenticated prepare request");
        };
        let preflight_response = json!({
            "type": "prepare_transfer",
            "request_id": preflight_request_id,
            "transfer_id": "transfer-1",
            "source_peer_id": "peer-primary",
            "target_has_repo": false,
        });
        preflight_reader
            .get_mut()
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
            false,
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
            protocol_version: 3,
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
        tokio::io::copy(&mut upstream_reader, &mut client_writer)
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
async fn timed_out_artifact_receive_removes_its_partial_staging_file() {
    let temp = tempfile::tempdir().unwrap();

    let source = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-source-timeout",
        "Source",
        temp.path(),
        0,
    ))
    .await
    .unwrap();
    let destination = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-destination-timeout", "Destination", temp.path(), 0)
            .with_peer_request_timeout(Duration::from_millis(75)),
    )
    .await
    .unwrap();

    pair_peers(&source, &destination, "peer-destination-timeout").await;

    let bundle_path = temp.path().join("timeout-source.bundle");
    std::fs::write(&bundle_path, b"bundle-contents").unwrap();
    let preflight = source
        .prepare_transfer_preflight("peer-destination-timeout", "task-source")
        .await
        .unwrap();
    source
        .stage_transfer_artifact(
            &preflight.transfer_id,
            "artifact-timeout",
            bundle_path,
            false,
        )
        .await
        .unwrap();
    source
        .prepare_transfer_commit(
            &preflight.transfer_id,
            json!({
                "target_peer_id": "peer-destination-timeout",
                "task": { "source_task_id": "task-source" }
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
        .find(|peer| peer.peer_id == "peer-source-timeout")
        .unwrap();
    let real_endpoint = source_peer.endpoint.clone();
    let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    PeerRegistry::new(temp.path().to_path_buf())
        .write_entry(&PeerRegistryEntry {
            peer_id: "peer-source-timeout".into(),
            display_name: "Source".into(),
            endpoint: format!("127.0.0.1:{proxy_port}"),
            pid: std::process::id(),
            public_key: source_peer.public_key,
            protocol_version: 3,
            accepting_transfers: true,
        })
        .unwrap();

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
        client_writer
            .write_all(response_line.as_bytes())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    });

    let error = destination
        .fetch_transfer_artifact(&preflight.transfer_id, "artifact-timeout")
        .await
        .expect_err("stalled artifact stream should time out");
    assert!(
        error.to_string().contains("timed out"),
        "unexpected stalled-stream error: {error}",
    );
    let staging_dir = temp
        .path()
        .join("artifacts")
        .join("peer-destination-timeout")
        .join(&preflight.transfer_id);
    if staging_dir.exists() {
        assert_eq!(
            std::fs::read_dir(staging_dir).unwrap().count(),
            0,
            "timed-out receive retained a partial staging artifact",
        );
    }
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

fn create_companion_fixture(db_path: &Path, workspace: &Path) {
    std::fs::create_dir_all(workspace.join(".superpowers/brainstorm/session-1/state")).unwrap();
    std::fs::create_dir_all(workspace.join(".superpowers/brainstorm/session-1/content")).unwrap();
    std::fs::write(
        workspace.join(".superpowers/brainstorm/session-1/state/server-info"),
        r#"{"url":"http://localhost:52341"}"#,
    )
    .unwrap();
    std::fs::write(
        workspace.join(".superpowers/brainstorm/session-1/content/screen.html"),
        "<h2>Choose a layout</h2>",
    )
    .unwrap();
    std::fs::write(
        workspace.join(".superpowers/brainstorm/session-1/content/layout.png"),
        b"PNG",
    )
    .unwrap();

    let db = rusqlite::Connection::open(db_path).unwrap();
    db.execute_batch(
        "CREATE TABLE pipeline_item (id TEXT PRIMARY KEY, branch TEXT);
         CREATE TABLE worktree (
             id TEXT PRIMARY KEY,
             pipeline_item_id TEXT NOT NULL,
             path TEXT NOT NULL,
             branch TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .unwrap();
    db.execute(
        "INSERT INTO pipeline_item (id, branch) VALUES ('task-1', 'task-task-1')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO worktree (id, pipeline_item_id, path, branch)
         VALUES ('wt-1', 'task-1', ?, 'task-task-1')",
        [workspace.to_str().unwrap()],
    )
    .unwrap();
}

async fn next_companion_frame(runtime: &TransferRuntime) -> ServerFrame {
    loop {
        match runtime.next_event().await.unwrap() {
            RuntimeEvent::CompanionEvent { frame, .. } => return frame,
            RuntimeEvent::PairingStarted(_)
            | RuntimeEvent::PairingRequested(_)
            | RuntimeEvent::PairingCompleted(_) => {}
            RuntimeEvent::IncomingTransferRequest(_)
            | RuntimeEvent::OutgoingTransferCommitted(_)
            | RuntimeEvent::OutgoingTransferFinalizationRequested(_)
            | RuntimeEvent::TaskPullRequested(_)
            | RuntimeEvent::TerminalEvent { .. } => {
                panic!("expected visual companion event")
            }
        }
    }
}

fn companion_event(event_id: &str) -> CompanionEvent {
    CompanionEvent {
        session_id: "session-1".into(),
        revision: "revision-1".into(),
        event_id: event_id.into(),
        event_type: "click".into(),
        choice: "grid".into(),
        text: "Grid".into(),
        element_id: Some("layout-grid".into()),
        timestamp: 1_784_268_000_000,
    }
}

async fn wait_for_companion_counts(
    viewer: &TransferRuntime,
    owner: &TransferRuntime,
    viewer_count: usize,
    owner_count: usize,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if viewer.companion_observer_count().await == viewer_count
            && owner.active_owner_companion_count() == owner_count
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "companion observer counts did not settle: viewer={}, owner={}",
            viewer.companion_observer_count().await,
            owner.active_owner_companion_count(),
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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
            RuntimeEvent::TaskPullRequested(_) => {
                panic!("expected incoming transfer event");
            }
            RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
                panic!("expected incoming transfer event");
            }
            RuntimeEvent::OutgoingTransferCommitted(_) => {
                panic!("expected incoming transfer event");
            }
            RuntimeEvent::TerminalEvent { .. } => {}
            RuntimeEvent::CompanionEvent { .. } => {}
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
            RuntimeEvent::TaskPullRequested(_) => {
                panic!("expected outgoing transfer committed event");
            }
            RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
                panic!("expected outgoing transfer committed event");
            }
            RuntimeEvent::IncomingTransferRequest(_) => {
                panic!("expected outgoing transfer committed event");
            }
            RuntimeEvent::TerminalEvent { .. } => {}
            RuntimeEvent::CompanionEvent { .. } => {}
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

/// The single replay record of `kind`, for tests that need to reach the file
/// itself rather than count it. Panics unless there is exactly one, so a test
/// cannot quietly obstruct the wrong record.
fn only_replay_json(registry_root: &Path, peer_id: &str, kind: &str) -> std::path::PathBuf {
    let directory = registry_root
        .join("transfer-replay")
        .join(URL_SAFE_NO_PAD.encode(peer_id))
        .join(kind);
    let mut paths = std::fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("read {}: {error}", directory.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    assert_eq!(
        paths.len(),
        1,
        "expected exactly one {kind} record in {}",
        directory.display(),
    );
    paths.remove(0)
}

fn age_incoming_reservation(path: &Path) {
    let mut reservation: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("read incoming reservation"))
            .expect("parse incoming reservation");
    reservation["created_at_unix_ms"] = json!(1);
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&reservation).expect("serialize aged reservation"),
    )
    .expect("age incoming reservation");
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
        RuntimeEvent::TaskPullRequested(_) => panic!("expected pairing completed event"),
        RuntimeEvent::IncomingTransferRequest(_) => panic!("expected pairing completed event"),
        RuntimeEvent::OutgoingTransferCommitted(_) => panic!("expected pairing completed event"),
        RuntimeEvent::OutgoingTransferFinalizationRequested(_) => {
            panic!("expected pairing completed event");
        }
        RuntimeEvent::TerminalEvent { .. } => panic!("expected pairing completed event"),
        RuntimeEvent::CompanionEvent { .. } => panic!("expected pairing completed event"),
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
                    RuntimeEvent::TaskPullRequested(_) => {
                        panic!("expected pairing started event");
                    }
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
                    RuntimeEvent::CompanionEvent { .. } => {
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
                    RuntimeEvent::TaskPullRequested(_) => {
                        panic!("expected pairing request event");
                    }
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
                    RuntimeEvent::CompanionEvent { .. } => {
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

async fn send_raw_observe(endpoint: &str, request: &PeerRequest) -> (TcpStream, PeerResponse) {
    let mut stream = TcpStream::connect(endpoint).await.unwrap();
    stream
        .write_all(format!("{}\n", serde_json::to_string(request).unwrap()).as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    {
        let mut reader = BufReader::new(&mut stream);
        reader.read_line(&mut line).await.unwrap();
    }
    (stream, serde_json::from_str(line.trim()).unwrap())
}

async fn send_inbound_bytes(endpoint: &str, bytes: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(endpoint).await.unwrap();
    let _ = stream.write_all(bytes).await;
    let _ = stream.shutdown().await;
    let mut response = Vec::new();
    match tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut response))
        .await
        .expect("bounded peer request should close promptly")
    {
        Ok(_) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
            ) => {}
        Err(error) => panic!("failed reading bounded peer response: {error}"),
    }
    response
}
