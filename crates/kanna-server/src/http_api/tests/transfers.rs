use super::*;

fn outgoing_transfer_body(transfer_id: &str, source_task_id: &str) -> String {
    serde_json::json!({
        "transfer": {
            "id": transfer_id,
            "direction": "outgoing",
            "status": "pending",
            "source_peer_id": "peer-source",
            "target_peer_id": "peer-target",
            "source_desktop_id": "desktop-source",
            "target_desktop_id": "desktop-target",
            "source_task_id": source_task_id,
            "local_task_id": source_task_id,
            "error": null,
            "payload_json": "{}",
        }
    })
    .to_string()
}

async fn post_transfer(
    app: &axum::Router,
    transfer_id: &str,
    source_task_id: &str,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers")
                .header("content-type", "application/json")
                .body(Body::from(outgoing_transfer_body(
                    transfer_id,
                    source_task_id,
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, from_slice(&body).unwrap())
}

/// A second push for a task that already has one in flight is a race between
/// two `task-pull-requested` deliveries, not a broken write. On 2026-08-06 it
/// surfaced as a raw 500 from `idx_task_transfer_active_outgoing_source`, which
/// gave the caller no way to tell "already in flight" from "the insert failed"
/// — so it kept its orphaned sidecar reservation instead of releasing it.
#[tokio::test]
async fn duplicate_outgoing_transfer_insert_answers_409_with_the_transfer_in_flight() {
    let app = super::test_router("desktop-1", "Studio Mac");

    let (status, body) = post_transfer(&app, "transfer-first", "task-source").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], "transfer-first");

    let (status, body) = post_transfer(&app, "transfer-second", "task-source").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "active_outgoing_transfer_exists");
    assert_eq!(body["sourceTaskId"], "task-source");
    // The caller learns which transfer owns the task, so it can report the one
    // that is really running rather than the reservation it just abandoned.
    assert_eq!(body["transferId"], "transfer-first");

    // A different source task is not this constraint's business.
    let (status, _) = post_transfer(&app, "transfer-other", "task-other").await;
    assert_eq!(status, StatusCode::OK);
}

/// Re-sending the same insert is how a retried request arrives; the row's own
/// id conflict has always been a no-op, and it must not be mistaken for the
/// active-transfer conflict.
#[tokio::test]
async fn reinserting_the_same_outgoing_transfer_stays_a_success() {
    let app = super::test_router("desktop-1", "Studio Mac");

    let (status, _) = post_transfer(&app, "transfer-retry", "task-source").await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = post_transfer(&app, "transfer-retry", "task-source").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], "transfer-retry");
}

/// The eligibility read a push makes before starting work. It has to agree with
/// the index exactly: anything it reports as free, the index must accept.
#[tokio::test]
async fn active_outgoing_route_reports_only_transfers_the_index_still_holds() {
    let app = super::test_router("desktop-1", "Studio Mac");

    let read = |source_task_id: &'static str| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(
                    Request::get(format!("/v1/transfers/outgoing/active/{source_task_id}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            from_slice::<serde_json::Value>(&body).unwrap()["transfer"].clone()
        }
    };

    assert!(read("task-source").await.is_null());

    let (status, _) = post_transfer(&app, "transfer-active", "task-source").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read("task-source").await["id"], "transfer-active");
    assert!(read("task-other").await.is_null());

    // Once the transfer reaches a terminal state the index frees the task, and
    // so must this read — otherwise a push is refused forever.
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-active/actions/fail-outgoing")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "reason": "peer went away" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert!(read("task-source").await.is_null());
    let (status, _) = post_transfer(&app, "transfer-retry", "task-source").await;
    assert_eq!(status, StatusCode::OK);
}
