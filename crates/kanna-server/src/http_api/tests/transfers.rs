use super::*;

/// A router whose database actually contains the tasks a test names.
///
/// The push and task-transfers routes resolve their `{task_id}` path parameter
/// against `pipeline_item` — a task id or one of its branch names, like every
/// other task route — so a test that names a task the database has never heard
/// of is answered 404 rather than exercising the transfer surface.
fn test_router_with_tasks(desktop_id: &str, task_ids: &[&str]) -> axum::Router {
    let task_ids = task_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
    super::test_router_with_seed(desktop_id, "Studio Mac", move |db| {
        db.insert_test_repo("repo-transfer", "Transfer Repo")
            .expect("repo");
        for task_id in &task_ids {
            db.insert_test_pipeline_item(
                task_id,
                "repo-transfer",
                "transfer fixture task",
                Some("Transfer Fixture"),
                "in progress",
                "2026-09-06 00:00:00",
            )
            .expect("task");
        }
    })
}

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

/// Every push is its own intent, and only an explicit idempotency key collapses
/// two into one.
///
/// `transfer_work.id` is a permanent primary key and no row is ever pruned, so
/// keying a push on anything that repeats — the peer id was the first attempt —
/// makes every push of a task to that peer after the first schedule nothing,
/// forever. Pushing the same task to the same machine again is ordinary: the
/// first one failed and the operator fixed it, or they simply want it there
/// again. The duplicate-*delivery* race the T3 note describes is handled a
/// layer down, by the engine's eligibility read against
/// `idx_task_transfer_active_outgoing_source`, not by this key.
#[tokio::test]
async fn each_push_is_its_own_intent_unless_the_caller_supplies_a_key() {
    let app = test_router_with_tasks("desktop-push-intent-key", &["task-source"]);

    let push = |intent_key: Option<&'static str>| {
        let app = app.clone();
        async move {
            let mut body = serde_json::json!({ "peerId": "peer-target" });
            if let Some(intent_key) = intent_key {
                body["intentKey"] = serde_json::json!(intent_key);
            }
            let response = app
                .oneshot(
                    Request::post("/v1/tasks/task-source/actions/push-to-peer")
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            (status, from_slice::<serde_json::Value>(&body).unwrap())
        }
    };

    // Every click schedules. Before this the second one silently did nothing,
    // for the rest of the database's life.
    for attempt in 0..3 {
        let (status, body) = push(None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["scheduled"], true, "push {attempt} scheduled nothing");
    }

    // A caller that retries its own request and does not want the retry to
    // become a second push says so, and is answered `false` the second time.
    let (status, body) = push(Some("operator-retry")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["scheduled"], true);
    let (status, body) = push(Some("operator-retry")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["scheduled"], false);
}

/// Approve and reject are intents against a transfer that must exist and must
/// be incoming — a route that queued work for an unknown id would leave the
/// engine failing an item nobody can act on.
#[tokio::test]
async fn incoming_intents_require_an_incoming_transfer_and_are_idempotent() {
    let app = super::test_router("desktop-1", "Studio Mac");

    let intent = |action: &'static str, transfer_id: &'static str| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(
                    Request::post(format!("/v1/transfers/{transfer_id}/actions/{action}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            (
                status,
                from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    let (status, _) = intent("approve", "transfer-unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // An outgoing transfer is not something this machine approves.
    let (status, _) = post_transfer(&app, "transfer-outgoing", "task-source").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = intent("approve", "transfer-outgoing").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "transfer": {
                            "id": "transfer-incoming",
                            "direction": "incoming",
                            "status": "pending",
                            "source_peer_id": "peer-source",
                            "target_peer_id": null,
                            "source_desktop_id": null,
                            "target_desktop_id": null,
                            "source_task_id": "task-remote",
                            "local_task_id": null,
                            "error": null,
                            "payload_json": "{}",
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, body) = intent("approve", "transfer-incoming").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["scheduled"], true);
    // A second click is the same intent, not a second import.
    let (status, body) = intent("approve", "transfer-incoming").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["scheduled"], false);

    let (status, body) = intent("reject-incoming", "transfer-incoming").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["scheduled"], true);
}

/// A push answers what actually happened, and never lets a queued intent read
/// as a finished move.
///
/// A task manager on 2026-09-06 read `scheduled: true` from this route as a
/// completed transfer while the move was in fact dying on a relay socket the
/// caller could not see. The intent is still just an intent, so the response
/// says so in the same breath it says the work was queued.
#[tokio::test]
async fn a_push_response_states_that_nothing_has_moved_yet() {
    let app = test_router_with_tasks("desktop-push-intent", &["task-source"]);

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-source/actions/push-to-peer")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "peerId": "peer-target", "transport": "lan" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = from_slice::<serde_json::Value>(&body).unwrap();

    assert_eq!(body["scheduled"], true);
    assert_eq!(body["state"], "scheduled");
    assert_eq!(body["moved"], false);
    assert_eq!(body["sourceTaskId"], "task-source");
    assert_eq!(body["target"]["peerId"], "peer-target");
    assert_eq!(body["target"]["transport"], "lan");
    assert!(
        body["nextStep"]
            .as_str()
            .is_some_and(|step| step.contains("kanna_task_transfers")),
        "{body}"
    );
    // No peer registry is reachable in this fixture, so the desktop's own
    // spelling — a peer it already resolved — still schedules, and says the
    // resolution was the caller's.
    assert!(
        body["note"]
            .as_str()
            .is_some_and(|note| note.contains("caller's own peer id")),
        "{body}"
    );
}

/// A destination has to be named. Before this route resolved one centrally the
/// only spelling was a raw peer id an agent had to find in desktop source, so
/// the refusal names the argument that replaces that.
#[tokio::test]
async fn a_push_with_no_destination_is_refused_rather_than_queued() {
    let app = test_router_with_tasks("desktop-push-nodest", &["task-source"]);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-source/actions/push-to-peer")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("targetMachine"),
        "{}",
        String::from_utf8_lossy(&body)
    );
}

/// The duplicate an agent is most likely to create: asking for a move that is
/// already running. The engine would skip it silently, so the route reports the
/// transfer that owns the task instead of a fresh `scheduled: true` the caller
/// would read as a second move.
#[tokio::test]
async fn a_push_at_a_task_already_in_flight_names_the_transfer_that_owns_it() {
    let app = test_router_with_tasks("desktop-push-dup", &["task-source"]);
    let (status, _) = post_transfer(&app, "transfer-live", "task-source").await;
    assert_eq!(status, StatusCode::OK);

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-source/actions/push-to-peer")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "peerId": "peer-target" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = from_slice::<serde_json::Value>(&body).unwrap();

    assert_eq!(body["scheduled"], false);
    assert_eq!(body["state"], "already_in_flight");
    assert_eq!(body["moved"], false);
    assert_eq!(body["activeTransfer"]["id"], "transfer-live");
    assert_eq!(body["activeTransfer"]["state"], "pending");
    assert_eq!(body["activeTransfer"]["direction"], "outgoing");
}

/// The observation half. A move is two rows on two machines tied together by
/// the task's ids, and this is the surface that answers "did it actually
/// happen?" — with the coarse verdict, because the engine's own status
/// vocabulary is longer than an agent should have to learn.
#[tokio::test]
async fn task_transfers_report_each_recorded_move_with_a_coarse_verdict() {
    let app = test_router_with_tasks(
        "desktop-task-transfers",
        &["task-source", "task-other", "task-arrived"],
    );

    let read = |task_id: &'static str| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(
                    Request::get(format!("/v1/tasks/{task_id}/transfers"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            from_slice::<serde_json::Value>(&body).unwrap()
        }
    };

    // A task nothing has happened to reports an empty list, which is not the
    // same claim as "no move was requested".
    assert_eq!(
        read("task-source").await["transfers"],
        serde_json::json!([])
    );

    let (status, _) = post_transfer(&app, "transfer-live", "task-source").await;
    assert_eq!(status, StatusCode::OK);
    let listed = read("task-source").await;
    assert_eq!(listed["taskId"], "task-source");
    assert_eq!(listed["transfers"][0]["id"], "transfer-live");
    assert_eq!(listed["transfers"][0]["status"], "pending");
    assert_eq!(listed["transfers"][0]["state"], "pending");
    assert_eq!(listed["transfers"][0]["sourceMachineId"], "desktop-source");
    assert_eq!(listed["transfers"][0]["targetMachineId"], "desktop-target");
    assert!(read("task-other").await["transfers"]
        .as_array()
        .is_some_and(|transfers| transfers.is_empty()));

    // The destination side of the same move: found by the id the task carries
    // there, and reported as incoming.
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "transfer": {
                            "id": "transfer-incoming",
                            "direction": "incoming",
                            "status": "completed",
                            "source_peer_id": "peer-source",
                            "target_peer_id": "peer-target",
                            "source_desktop_id": "desktop-source",
                            "target_desktop_id": "desktop-target",
                            "source_task_id": "task-source",
                            "local_task_id": "task-arrived",
                            "error": null,
                            "payload_json": "{}",
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let arrived = read("task-arrived").await;
    assert_eq!(arrived["transfers"][0]["id"], "transfer-incoming");
    assert_eq!(arrived["transfers"][0]["direction"], "incoming");
    assert_eq!(arrived["transfers"][0]["state"], "completed");
    assert_eq!(arrived["transfers"][0]["sourceTaskId"], "task-source");
    assert_eq!(arrived["transfers"][0]["localTaskId"], "task-arrived");

    // Asked by the durable source id, both halves answer.
    let both = read("task-source").await;
    let ids = both["transfers"]
        .as_array()
        .expect("transfers")
        .iter()
        .map(|transfer| transfer["id"].as_str().unwrap_or_default().to_string())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        ids,
        ["transfer-incoming", "transfer-live"]
            .into_iter()
            .map(str::to_string)
            .collect::<std::collections::BTreeSet<_>>()
    );
}

/// A failed transfer must read as failed, not as "not completed yet". The
/// distinction is the whole reason the coarse verdict exists.
#[tokio::test]
async fn a_failed_transfer_reports_failed_with_its_reason() {
    let app = test_router_with_tasks("desktop-failed-transfer", &["task-source"]);
    let (status, _) = post_transfer(&app, "transfer-doomed", "task-source").await;
    assert_eq!(status, StatusCode::OK);

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-doomed/actions/fail-outgoing")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "reason": "cloud transfer relay rejected tunnel" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-source/transfers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["transfers"][0]["state"], "failed");
    assert_eq!(
        body["transfers"][0]["error"],
        "cloud transfer relay rejected tunnel"
    );
}

/// A pull moves a task onto *this* machine, so it is expressed only by a
/// process running on it — the same `DesktopLocalAccess` boundary the rest of
/// the sidecar control plane keeps, and deliberately narrower than the push it
/// asks the other machine to perform. Neither an authenticated relay tunnel nor
/// anything short of a direct connection to this desktop's own listener may
/// move a task here.
#[tokio::test]
async fn a_pull_is_reachable_only_from_this_desktop_s_own_loopback_connection() {
    let response = crate::http_api::routes::dispatch_authenticated_http_invoke(
        super::test_state_with_seed("desktop-pull-tunnel", "Studio Mac", |_| {}),
        "POST",
        "/v1/transfers/actions/pull-task",
        serde_json::json!({ "sourceTaskId": "task-source", "sourceMachine": "peer-primary" }),
    )
    .await;
    assert_eq!(response.status, 401, "{response:?}");
    assert!(
        response
            .error
            .as_deref()
            .into_iter()
            .chain(response.body.as_ref().and_then(|body| body.as_str()))
            .any(|message| message.contains("direct desktop loopback connection")),
        "{response:?}"
    );

    // The same route on a request with no connection identity at all, which is
    // what a synthesized in-process caller is. It must not be admitted either:
    // the guard is positive proof of a direct desktop connection, never the
    // absence of evidence against one.
    let app = super::test_router("desktop-pull-guard", "Studio Mac");
    let response = app
        .oneshot(
            Request::post("/v1/transfers/actions/pull-task")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "sourceTaskId": "task-source",
                        "sourceMachine": "peer-primary",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// The catalog promises both spellings of a task's identity, and an agent
/// routinely holds the branch one — `kanna_get_task` reports it as `branch` and
/// it names the worktree directory.
///
/// Answering a branch name with `transfers: []` is the worst shape this surface
/// can take: the tool description tells the caller to read an empty list as
/// "nothing has arrived yet, never that a pull was not requested", so an
/// unresolved identifier turns a real transfer into a confident "no".
#[tokio::test]
async fn task_transfers_answer_to_a_branch_name_exactly_as_to_the_task_id() {
    let app = super::test_router_with_seed("desktop-transfers-branch", "Studio Mac", |db| {
        db.insert_test_repo("repo-branch", "Branch Repo")
            .expect("repo");
        db.insert_test_pipeline_item(
            "task-source",
            "repo-branch",
            "moved by branch name",
            Some("Branch Task"),
            "in progress",
            "2026-09-06 00:00:00",
        )
        .expect("task");
    });

    let read = |identifier: &'static str| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(
                    Request::get(format!("/v1/tasks/{identifier}/transfers"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            (
                status,
                from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    let (status, _) = post_transfer(&app, "transfer-by-branch", "task-source").await;
    assert_eq!(status, StatusCode::OK);

    let (status, by_id) = read("task-source").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(by_id["transfers"][0]["id"], "transfer-by-branch");

    // `insert_test_pipeline_item` names the branch `branch-{id}`, so this is a
    // genuinely different string from the durable id.
    let (status, by_branch) = read("branch-task-source").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        by_branch, by_id,
        "a branch name must answer with the task's own records, not an empty list"
    );
    // …including the id the caller can carry onward, which is the durable one.
    assert_eq!(by_branch["taskId"], "task-source");

    // An identifier that names no task is a 404, not an empty list that reads
    // as "nothing has arrived yet".
    let (status, _) = read("task-does-not-exist").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// The same resolution on the push, where an unresolved identifier fails
/// *silently and forever*.
///
/// The route answered `scheduled: true` and the engine then failed
/// `SourceTask::load` with a **retriable** "task not found"
/// (`transfer_engine/push.rs`), so no `task_transfer` row was ever written and
/// the work item retried out of sight — while the caller polled a surface the
/// engine had given nothing to report.
#[tokio::test]
async fn a_push_named_by_branch_queues_work_for_the_durable_task_id() {
    let state = super::test_state_with_seed("desktop-push-branch", "Studio Mac", |db| {
        db.insert_test_repo("repo-branch", "Branch Repo")
            .expect("repo");
        db.insert_test_pipeline_item(
            "task-source",
            "repo-branch",
            "pushed by branch name",
            Some("Branch Task"),
            "in progress",
            "2026-09-06 00:00:00",
        )
        .expect("task");
    });
    let app = super::router(std::sync::Arc::clone(&state));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/branch-task-source/actions/push-to-peer")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "peerId": "peer-target", "transport": "lan" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = from_slice::<serde_json::Value>(&body).unwrap();

    assert_eq!(body["scheduled"], true);
    assert_eq!(
        body["sourceTaskId"], "task-source",
        "the answer must name the task the engine will actually load"
    );
    assert!(
        body["workId"]
            .as_str()
            .is_some_and(|work_id| work_id.starts_with("push:task-source:")),
        "{body}"
    );

    // The payload the engine reads is the part that used to be unloadable.
    let db = state.transfer_work().open_db().expect("db");
    let queued = db
        .claim_next_transfer_work(&Vec::<String>::new())
        .expect("claim")
        .expect("the push queued work");
    let payload = serde_json::from_str::<serde_json::Value>(&queued.payload_json).expect("payload");
    assert_eq!(payload["sourceTaskId"], "task-source");
}

/// An identifier that resolves to no task must be refused before anything is
/// queued, rather than answering like a scheduled push.
#[tokio::test]
async fn a_push_at_an_unknown_task_is_refused_with_nothing_queued() {
    let state = super::test_state_with_seed("desktop-push-unknown", "Studio Mac", |db| {
        db.insert_test_repo("repo-branch", "Branch Repo")
            .expect("repo");
    });
    let app = super::router(std::sync::Arc::clone(&state));

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-does-not-exist/actions/push-to-peer")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "peerId": "peer-target" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("task not found"),
        "{}",
        String::from_utf8_lossy(&body)
    );

    let db = state.transfer_work().open_db().expect("db");
    assert!(
        db.claim_next_transfer_work(&Vec::<String>::new())
            .expect("claim")
            .is_none(),
        "a refused push must leave the engine nothing to retry",
    );
}
