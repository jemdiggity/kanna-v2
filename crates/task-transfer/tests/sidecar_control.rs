use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kanna_task_transfer::crypto::{public_key_to_string, TransferIdentity};
use kanna_task_transfer::peer_store::{PeerRecord, PeerStore};
use kanna_task_transfer::protocol::{
    ControlRequest, ControlResponse, PeerRegistryEntry, PeerRequest, PeerResponse,
};
use kanna_task_transfer::registry::PeerRegistry;
use serde_json::json;
use std::io::{BufRead, BufReader as StdBufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Notify};

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_mark_read_does_not_monopolize_sidecar_control() {
    let temp = tempfile::tempdir().unwrap();
    let registry_dir = temp.path().join("registry");
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let target_identity = TransferIdentity::generate();
    let target_public_key = public_key_to_string(&target_identity.public_key);
    PeerRegistry::new(registry_dir.clone())
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
    PeerStore::new(
        registry_dir
            .join("trusted-peers")
            .join(format!("{}.json", URL_SAFE_NO_PAD.encode("peer-primary"))),
    )
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

    let (peer_event_tx, mut peer_event_rx) = mpsc::unbounded_channel::<String>();
    let first_input_release = std::sync::Arc::new(Notify::new());
    let snapshot_release = std::sync::Arc::new(Notify::new());
    let peer_first_input_release = std::sync::Arc::clone(&first_input_release);
    let peer_snapshot_release = std::sync::Arc::clone(&snapshot_release);
    let peer_server = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        // Each admitted privileged operation first fetches the restart-specific
        // owner epoch, then opens its action connection. The two overloads are
        // rejected by sidecar admission before either connection is opened.
        for _ in 0..8 {
            let (stream, _) = listener.accept().await.unwrap();
            let peer_event_tx = peer_event_tx.clone();
            let first_input_release = std::sync::Arc::clone(&peer_first_input_release);
            let snapshot_release = std::sync::Arc::clone(&peer_snapshot_release);
            handlers.spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let request: PeerRequest = serde_json::from_str(line.trim()).unwrap();
                match request {
                    PeerRequest::GetAuthenticatedRequestEpoch { request_id } => {
                        let response = PeerResponse::AuthenticatedRequestEpoch {
                            request_id,
                            epoch: "sidecar-owner-epoch".into(),
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
                        peer_event_tx.send("mark-started".into()).unwrap();
                        let mut remainder = Vec::new();
                        reader.read_to_end(&mut remainder).await.unwrap();
                        peer_event_tx.send("mark-closed".into()).unwrap();
                    }
                    PeerRequest::SendSessionInput {
                        request_id, data, ..
                    } => {
                        let input = String::from_utf8(data).unwrap();
                        peer_event_tx.send(format!("input:{input}")).unwrap();
                        if input == "first" {
                            first_input_release.notified().await;
                        }
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
                        peer_event_tx.send("snapshot-started".into()).unwrap();
                        snapshot_release.notified().await;
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

    let mut child = Command::new(env!("CARGO_BIN_EXE_kanna-task-transfer"))
        .env("KANNA_TRANSFER_ROOT", temp.path())
        .env("KANNA_TRANSFER_REGISTRY_DIR", &registry_dir)
        .env("KANNA_TRANSFER_PEER_ID", "peer-primary")
        .env("KANNA_TRANSFER_DISPLAY_NAME", "Primary")
        .env("KANNA_TRANSFER_DISCOVERY", "registry")
        .env("KANNA_TRANSFER_PORT", "0")
        .env("KANNA_TRANSFER_CONTROL_MAX_IN_FLIGHT", "3")
        .env("KANNA_TRANSFER_MARK_READ_CONTROL_MAX_IN_FLIGHT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (response_tx, response_rx) = std_mpsc::channel();
    std::thread::spawn(move || {
        for line in StdBufReader::new(stdout).lines() {
            let line = line.unwrap();
            if let Ok(response) = serde_json::from_str::<ControlResponse>(&line) {
                response_tx.send(response).unwrap();
            }
        }
    });
    let mut sidecar = SidecarProcess { child, stdin };

    write_control(
        &mut sidecar.stdin,
        &ControlRequest::MarkPeerTaskRead {
            request_id: "mark".into(),
            target_peer_id: "peer-target".into(),
            task_id: "task-unread".into(),
            expected_activity_revision: 7,
        },
    );
    assert_eq!(peer_event_rx.recv().await.as_deref(), Some("mark-started"));
    write_control(
        &mut sidecar.stdin,
        &ControlRequest::MarkPeerTaskRead {
            request_id: "mark-overload".into(),
            target_peer_id: "peer-target".into(),
            task_id: "task-unread".into(),
            expected_activity_revision: 7,
        },
    );
    let overloaded = response_rx
        .recv_timeout(Duration::from_millis(500))
        .expect("excess mark-read control did not receive bounded backpressure");
    assert!(
        matches!(
            overloaded,
            ControlResponse::Error {
                ref request_id,
                ref message,
            } if request_id == "mark-overload" && message.contains("too many mark-read")
        ),
        "unexpected overload response: {overloaded:?}",
    );
    write_control(
        &mut sidecar.stdin,
        &ControlRequest::SendPeerSessionInput {
            request_id: "input-first".into(),
            target_peer_id: "peer-target".into(),
            session_id: "task-unread".into(),
            data: b"first".to_vec(),
        },
    );
    write_control(
        &mut sidecar.stdin,
        &ControlRequest::SendPeerSessionInput {
            request_id: "input-second".into(),
            target_peer_id: "peer-target".into(),
            session_id: "task-unread".into(),
            data: b"second".to_vec(),
        },
    );
    write_control(
        &mut sidecar.stdin,
        &ControlRequest::ListPeerTaskSnapshots {
            request_id: "refresh".into(),
        },
    );
    let mut started = vec![
        peer_event_rx.recv().await.unwrap(),
        peer_event_rx.recv().await.unwrap(),
    ];
    started.sort_unstable();
    assert_eq!(started, vec!["input:first", "snapshot-started"]);
    assert!(
        tokio::time::timeout(Duration::from_millis(150), peer_event_rx.recv())
            .await
            .is_err(),
        "second terminal input overtook the first response",
    );
    write_control(
        &mut sidecar.stdin,
        &ControlRequest::ResizePeerSession {
            request_id: "ordinary-overload".into(),
            target_peer_id: "peer-target".into(),
            session_id: "task-unread".into(),
            cols: 100,
            rows: 30,
        },
    );
    let ordinary_overload = response_rx
        .recv_timeout(Duration::from_millis(500))
        .expect("excess ordinary control did not receive bounded backpressure");
    assert!(
        matches!(
            ordinary_overload,
            ControlResponse::Error {
                ref request_id,
                ref message,
            } if request_id == "ordinary-overload" && message.contains("too many transfer")
        ),
        "unexpected ordinary overload response: {ordinary_overload:?}",
    );
    first_input_release.notify_one();
    snapshot_release.notify_one();

    let first = response_rx
        .recv_timeout(Duration::from_millis(500))
        .expect("terminal control waited behind stalled mark-read");
    let second = response_rx
        .recv_timeout(Duration::from_millis(500))
        .expect("LAN refresh waited behind stalled mark-read");
    let third = response_rx
        .recv_timeout(Duration::from_millis(500))
        .expect("second terminal input did not run after the first response");
    let mut completed_ids = vec![control_response_id(&first), control_response_id(&second)];
    completed_ids.push(control_response_id(&third));
    completed_ids.sort_unstable();
    assert_eq!(
        completed_ids,
        vec!["input-first", "input-second", "refresh"]
    );
    assert_eq!(peer_event_rx.recv().await.as_deref(), Some("input:second"));

    let mark = response_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("mark-read did not finish at its lower-layer deadline");
    assert_eq!(control_response_id(&mark), "mark");
    assert!(
        matches!(mark, ControlResponse::Error { ref message, .. } if message.contains("timed out after 2000ms")),
        "unexpected mark-read response: {mark:?}",
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(500), peer_event_rx.recv())
            .await
            .expect("stalled peer work survived mark-read timeout"),
        Some("mark-closed".into()),
    );
    peer_server.await.unwrap();
}

fn write_control(stdin: &mut ChildStdin, request: &ControlRequest) {
    writeln!(stdin, "{}", serde_json::to_string(request).unwrap()).unwrap();
    stdin.flush().unwrap();
}

fn control_response_id(response: &ControlResponse) -> &str {
    match response {
        ControlResponse::GetLocalIdentity { request_id, .. }
        | ControlResponse::Error { request_id, .. }
        | ControlResponse::ListPeers { request_id, .. }
        | ControlResponse::UpsertExternalPeer { request_id }
        | ControlResponse::RemoveExternalPeer { request_id }
        | ControlResponse::ClearExternalPeers { request_id }
        | ControlResponse::SetTaskSnapshot { request_id }
        | ControlResponse::ListPeerTaskSnapshots { request_id, .. }
        | ControlResponse::ObservePeerSession { request_id }
        | ControlResponse::UnobservePeerSession { request_id }
        | ControlResponse::SendPeerSessionInput { request_id }
        | ControlResponse::ResizePeerSession { request_id }
        | ControlResponse::ClosePeerTask { request_id }
        | ControlResponse::AdvancePeerTaskStage { request_id }
        | ControlResponse::ReadPeerTaskFile { request_id, .. }
        | ControlResponse::MarkPeerTaskRead { request_id }
        | ControlResponse::StartPairing { request_id, .. }
        | ControlResponse::AcceptPairing { request_id, .. }
        | ControlResponse::RejectPairing { request_id, .. }
        | ControlResponse::StageTransferArtifact { request_id, .. }
        | ControlResponse::FetchTransferArtifact { request_id, .. }
        | ControlResponse::PrepareTransferPreflight { request_id, .. }
        | ControlResponse::RequestTaskPull { request_id, .. }
        | ControlResponse::PrepareTransferCommit { request_id, .. }
        | ControlResponse::FinalizeOutgoingTransfer { request_id, .. }
        | ControlResponse::CompleteOutgoingTransferFinalization { request_id, .. }
        | ControlResponse::AcknowledgeImportCommitted { request_id, .. }
        | ControlResponse::MarkIncomingEventRecorded { request_id, .. }
        | ControlResponse::MarkImportCommitApplied { request_id, .. }
        | ControlResponse::NackImportCommit { request_id, .. }
        | ControlResponse::MarkImportAckCompleted { request_id, .. } => request_id,
    }
}
