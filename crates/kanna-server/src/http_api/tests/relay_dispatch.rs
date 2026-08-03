use super::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::{Condvar, Mutex as StdMutex};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

/// Relay HTTP invokes used to be dispatched inline in the relay read loop:
/// a slow invoke (task lifecycle preparation runs synchronous git/SQLite
/// work) both occupied a Tokio runtime worker and head-of-line blocked every
/// later relay message. The dispatcher must instead return immediately,
/// drive the handler from the blocking pool, and let responses complete out
/// of order — proven here on a current-thread runtime with a definition
/// load that stays blocked while a later invoke completes.
#[tokio::test(flavor = "current_thread")]
async fn relay_http_invoke_dispatch_is_concurrent_and_off_the_runtime() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-relay-dispatch-{unique}"));
    super::init_test_git_repo(&repo_root);

    let state = super::test_state_with_seed("desktop-relay", "Studio Mac", |db| {
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
    });

    // Hold the repository definition load open until released, so the first
    // invoke stays in flight while the second one races past it.
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let started_tx = Arc::new(StdMutex::new(Some(started_tx)));
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    state.repo_definitions.set_before_load(Arc::new({
        let started_tx = Arc::clone(&started_tx);
        let release = Arc::clone(&release);
        move || {
            if let Some(started_tx) = started_tx.lock().unwrap().take() {
                let _ = started_tx.send(());
            }
            let (released, ready) = &*release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
        }
    }));

    // Real WebSocket sink, mirroring the relay connection: the accepting side
    // forwards each response frame as it arrives so ordering is observable.
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind relay stand-in");
    let addr = tcp.local_addr().expect("local addr");
    let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let relay_server = tokio::spawn(async move {
        let (stream, _) = tcp.accept().await.expect("accept ws");
        let mut ws =
            tokio_tungstenite::accept_async(tokio_tungstenite::MaybeTlsStream::Plain(stream))
                .await
                .expect("ws handshake");
        while let Some(Ok(message)) = ws.next().await {
            if let TungsteniteMessage::Text(text) = message {
                let frame: serde_json::Value =
                    serde_json::from_str(&text).expect("parse relay frame");
                if frames_tx.send(frame).is_err() {
                    return;
                }
            }
        }
    });
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("connect ws");
    let (sink, _read) = ws.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));
    let permits = Arc::new(tokio::sync::Semaphore::new(2));

    // First invoke: resolves repository definitions and blocks in the loader.
    crate::relay::dispatch_relay_http_invoke(
        Arc::clone(&state),
        Arc::clone(&sink),
        Arc::clone(&permits),
        crate::relay::RelayHttpInvokeRequest {
            id: crate::relay_client::RelayId::String("slow-invoke".to_string()),
            method: "GET".to_string(),
            path: "/v1/repos/repo-1/kanna-definitions".to_string(),
            body: serde_json::Value::Null,
            authenticated_user_id: None,
        },
    )
    .await
    .expect("dispatch slow invoke");

    tokio::time::timeout(Duration::from_secs(2), started_rx)
        .await
        .expect("definition load should start without an inline await")
        .unwrap();

    // Second invoke, issued while the first is still blocked: its response
    // must arrive first, proving the dispatcher neither serializes invokes
    // nor parks the runtime on the blocked one.
    crate::relay::dispatch_relay_http_invoke(
        Arc::clone(&state),
        Arc::clone(&sink),
        Arc::clone(&permits),
        crate::relay::RelayHttpInvokeRequest {
            id: crate::relay_client::RelayId::String("fast-invoke".to_string()),
            method: "GET".to_string(),
            path: "/v1/status".to_string(),
            body: serde_json::Value::Null,
            authenticated_user_id: None,
        },
    )
    .await
    .expect("dispatch fast invoke");

    let first_response = tokio::time::timeout(Duration::from_secs(2), frames_rx.recv())
        .await
        .expect("fast invoke response should not wait behind the blocked invoke")
        .expect("relay frame channel closed");
    assert_eq!(first_response["id"], "fast-invoke");
    assert_eq!(first_response["status"], 200);

    // Release the blocked loader; the slow invoke now completes and its
    // id-addressed response still reaches the relay.
    {
        let (released, ready) = &*release;
        *released.lock().unwrap() = true;
        ready.notify_all();
    }
    let second_response = tokio::time::timeout(Duration::from_secs(5), frames_rx.recv())
        .await
        .expect("slow invoke response should arrive after release")
        .expect("relay frame channel closed");
    assert_eq!(second_response["id"], "slow-invoke");
    assert_eq!(second_response["status"], 200);

    sink.lock().await.close().await.expect("close ws");
    relay_server.abort();
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Saturated invoke permits must produce an immediate id-addressed 503
/// instead of queueing unbounded work behind the relay connection.
#[tokio::test(flavor = "current_thread")]
async fn relay_http_invoke_dispatch_rejects_when_saturated() {
    let state = super::test_state_with_seed("desktop-relay-sat", "Studio Mac", |_db| {});

    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind relay stand-in");
    let addr = tcp.local_addr().expect("local addr");
    let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let relay_server = tokio::spawn(async move {
        let (stream, _) = tcp.accept().await.expect("accept ws");
        let mut ws =
            tokio_tungstenite::accept_async(tokio_tungstenite::MaybeTlsStream::Plain(stream))
                .await
                .expect("ws handshake");
        while let Some(Ok(message)) = ws.next().await {
            if let TungsteniteMessage::Text(text) = message {
                let frame: serde_json::Value =
                    serde_json::from_str(&text).expect("parse relay frame");
                if frames_tx.send(frame).is_err() {
                    return;
                }
            }
        }
    });
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("connect ws");
    let (sink, _read) = ws.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));

    let permits = Arc::new(tokio::sync::Semaphore::new(1));
    let held = Arc::clone(&permits)
        .try_acquire_owned()
        .expect("hold the only permit");

    crate::relay::dispatch_relay_http_invoke(
        Arc::clone(&state),
        Arc::clone(&sink),
        Arc::clone(&permits),
        crate::relay::RelayHttpInvokeRequest {
            id: crate::relay_client::RelayId::String("rejected-invoke".to_string()),
            method: "GET".to_string(),
            path: "/v1/status".to_string(),
            body: serde_json::Value::Null,
            authenticated_user_id: None,
        },
    )
    .await
    .expect("saturation response should still send");

    let response = tokio::time::timeout(std::time::Duration::from_secs(2), frames_rx.recv())
        .await
        .expect("saturation response should arrive immediately")
        .expect("relay frame channel closed");
    assert_eq!(response["id"], "rejected-invoke");
    assert_eq!(response["status"], 503);
    drop(held);

    sink.lock().await.close().await.expect("close ws");
    relay_server.abort();
}
