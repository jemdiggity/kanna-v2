//! The orchestrator contract for `/v1/task-events`.
//!
//! These exercise the real wiring an orchestrating agent depends on — DB write
//! -> event append -> cursor query -> HTTP response — because the risk is
//! precisely in that wiring: an event that fires while nobody is polling, or a
//! cursor that skips one, is invisible to any test that only checks a single
//! layer.

use super::*;
use crate::db::NewStageRun;
use axum::Router;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn seed_orchestration(db: &Db) {
    db.insert_test_repo("repo-events", "Events Repo")
        .expect("insert repo");
    db.insert_test_repo("repo-other", "Other Repo")
        .expect("insert other repo");
    for task_id in ["child-a", "child-b", "child-c"] {
        db.insert_test_pipeline_item(
            task_id,
            "repo-events",
            "child work",
            Some(task_id),
            "in progress",
            "2026-07-29 00:00:00",
        )
        .expect("insert child task");
    }
    db.insert_test_pipeline_item(
        "unwatched",
        "repo-other",
        "someone else's task",
        Some("Unwatched"),
        "in progress",
        "2026-07-29 00:00:00",
    )
    .expect("insert unwatched task");
}

fn events_router() -> (Router, String) {
    let state = test_state_with_seed("desktop-task-events", "Task Events", seed_orchestration);
    let db_path = state.config().db_path.clone();
    (router(state), db_path)
}

fn connect_test_relay_peer(
    source: &Arc<AppState>,
    peer: Arc<AppState>,
    connected: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let mut requests = source
        .take_desktop_relay_requests()
        .expect("take source relay queue");
    source.set_desktop_routing_available(true);
    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                crate::http_api::DesktopRelayRequest::ListActive { response, .. } => {
                    let machine_ids = if connected.load(Ordering::SeqCst) {
                        vec![peer.config().desktop_id.clone()]
                    } else {
                        Vec::new()
                    };
                    let _ = response.send(Ok(machine_ids));
                }
                crate::http_api::DesktopRelayRequest::Invoke {
                    method,
                    path,
                    body,
                    response,
                    ..
                } => {
                    let peer = Arc::clone(&peer);
                    let connected = Arc::clone(&connected);
                    tokio::spawn(async move {
                        if !connected.load(Ordering::SeqCst) {
                            let _ = response.send(Err("peer disconnected".to_string()));
                            return;
                        }
                        let result = crate::http_api::dispatch_authenticated_http_invoke(
                            peer, &method, &path, body,
                        )
                        .await;
                        let _ = response.send(Ok(result));
                    });
                }
            }
        }
    })
}

fn connect_test_relay_peer_with_long_poll_budget(
    source: &Arc<AppState>,
    peer: Arc<AppState>,
    invoke_count: Arc<AtomicUsize>,
    busy_count: Arc<AtomicUsize>,
) -> tokio::task::JoinHandle<()> {
    let mut requests = source
        .take_desktop_relay_requests()
        .expect("take source relay queue");
    source.set_desktop_routing_available(true);
    let permits = Arc::new(crate::relay::RelayHttpInvokePermits::new(1));
    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                crate::http_api::DesktopRelayRequest::ListActive { response, .. } => {
                    let _ = response.send(Ok(vec![peer.config().desktop_id.clone()]));
                }
                crate::http_api::DesktopRelayRequest::Invoke {
                    method,
                    path,
                    body,
                    response,
                    ..
                } => {
                    invoke_count.fetch_add(1, Ordering::SeqCst);
                    let permit = match permits.for_path(&path).try_acquire_owned() {
                        Ok(permit) => permit,
                        Err(_) => {
                            busy_count.fetch_add(1, Ordering::SeqCst);
                            let _ = response.send(Ok(crate::http_api::HttpInvokeResponse {
                                status: 503,
                                body: None,
                                error: Some("desktop is busy; too many concurrent requests".into()),
                            }));
                            continue;
                        }
                    };
                    let peer = Arc::clone(&peer);
                    tokio::spawn(async move {
                        let _permit = permit;
                        let result = crate::http_api::dispatch_authenticated_http_invoke(
                            peer, &method, &path, body,
                        )
                        .await;
                        let _ = response.send(Ok(result));
                    });
                }
            }
        }
    })
}

fn connect_test_relay_peer_with_invoke_gate(
    source: &Arc<AppState>,
    peer: Arc<AppState>,
    invoke_gate: Arc<tokio::sync::Semaphore>,
    invoke_count: Arc<AtomicUsize>,
) -> tokio::task::JoinHandle<()> {
    let mut requests = source
        .take_desktop_relay_requests()
        .expect("take source relay queue");
    source.set_desktop_routing_available(true);
    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                crate::http_api::DesktopRelayRequest::ListActive { response, .. } => {
                    let _ = response.send(Ok(vec![peer.config().desktop_id.clone()]));
                }
                crate::http_api::DesktopRelayRequest::Invoke {
                    method,
                    path,
                    body,
                    response,
                    ..
                } => {
                    invoke_count.fetch_add(1, Ordering::SeqCst);
                    let peer = Arc::clone(&peer);
                    let invoke_gate = Arc::clone(&invoke_gate);
                    tokio::spawn(async move {
                        let Ok(_permit) = invoke_gate.acquire_owned().await else {
                            return;
                        };
                        let result = crate::http_api::dispatch_authenticated_http_invoke(
                            peer, &method, &path, body,
                        )
                        .await;
                        let _ = response.send(Ok(result));
                    });
                }
            }
        }
    })
}

fn connect_unresponsive_listed_peer(
    source: &Arc<AppState>,
    machine_id: &str,
) -> tokio::task::JoinHandle<()> {
    let mut requests = source
        .take_desktop_relay_requests()
        .expect("take source relay queue");
    source.set_desktop_routing_available(true);
    let machine_id = machine_id.to_string();
    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                crate::http_api::DesktopRelayRequest::ListActive { response, .. } => {
                    let _ = response.send(Ok(vec![machine_id.clone()]));
                }
                crate::http_api::DesktopRelayRequest::Invoke { response, .. } => {
                    tokio::spawn(async move {
                        let _response = response;
                        std::future::pending::<()>().await;
                    });
                }
            }
        }
    })
}

async fn get_json_body(router: &Router, uri: &str) -> Value {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .expect("request");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(
        status,
        StatusCode::OK,
        "GET {uri}: {}",
        String::from_utf8_lossy(&bytes)
    );
    from_slice(&bytes).expect("json body")
}

async fn get_account_json_body(router: &Router, state: &AppState, uri: &str) -> Value {
    let token = state
        .local_task_events_token
        .as_deref()
        .expect("test task-event credential");
    let response = router
        .clone()
        .oneshot(
            Request::get(uri)
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("request");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(
        status,
        StatusCode::OK,
        "GET {uri}: {}",
        String::from_utf8_lossy(&bytes)
    );
    from_slice(&bytes).expect("json body")
}

fn cursor_of(body: &Value) -> String {
    body["cursor"].as_str().expect("cursor").to_string()
}

fn event_pairs(body: &Value) -> Vec<(String, String)> {
    body["events"]
        .as_array()
        .expect("events array")
        .iter()
        .map(|event| {
            (
                event["taskId"].as_str().expect("taskId").to_string(),
                event["type"].as_str().expect("type").to_string(),
            )
        })
        .collect()
}

fn legacy_parent_cursor(
    parent_task_id: &str,
    watermarks: serde_json::Map<String, Value>,
) -> String {
    let payload = serde_json::json!({
        "parent_task_id": parent_task_id,
        "watermarks": watermarks,
    });
    format!(
        "p1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
    )
}

fn aggregate_parent_cursor(
    local_machine_id: &str,
    peer_machine_id: &str,
    parent_task_id: &str,
    peer_cursor: &str,
) -> String {
    let payload = serde_json::json!({
        "localMachineId": local_machine_id,
        "scope": {
            "kind": "children",
            "parent_task_id": parent_task_id,
        },
        "machineIds": [local_machine_id, peer_machine_id],
        "cursorsByMachine": {
            (peer_machine_id): peer_cursor,
        },
    });
    format!(
        "ks1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
    )
}

fn start_run(db: &Db, run_id: &str, task_id: &str, stage: &str) {
    db.insert_stage_run(NewStageRun {
        id: run_id,
        task_id,
        stage,
        kind: "main",
        agent: Some("review"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some(task_id),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .expect("insert stage run");
}

/// One orchestrator, three children, events arriving in three different
/// relationships to its polling: before the first call, while a call is
/// blocked, and in the gap between two calls. Every event must arrive, in
/// order, exactly once — and no other task's events may leak in.
#[tokio::test]
async fn orchestrator_receives_every_child_event_exactly_once_across_polls() {
    let (router, db_path) = events_router();
    let watch = "/v1/task-events?taskIds=child-a,child-b,child-c";

    // Fired before the orchestrator ever calls: a watcher that starts without a
    // cursor must still see what it missed, or a fan-out that raced its parent
    // loses events it can never ask for again.
    {
        let db = Db::open(&db_path).expect("open db");
        start_run(&db, "run-a1", "child-a", "in progress");
    }

    let first = get_json_body(&router, &format!("{watch}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&first),
        vec![("child-a".to_string(), "run.started".to_string())]
    );
    let mut cursor = cursor_of(&first);

    // Fired while the call is blocked.
    let writer_db_path = db_path.clone();
    let writer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let db = Db::open(&writer_db_path).expect("open db");
        db.finish_stage_run("run-a1", "succeeded", Some("implemented"), None)
            .expect("finish run");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("advance stage");
        // Another repo's task, watched by nobody here.
        db.update_pipeline_item_stage("unwatched", "review")
            .expect("advance unwatched stage");
    });

    let started = std::time::Instant::now();
    let blocked = tokio::time::timeout(
        Duration::from_secs(20),
        get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=15")),
    )
    .await
    .expect("blocked wait returned");
    let blocked_for = started.elapsed();
    writer.await.expect("writer");
    // The append wakes the waiter directly. Falling back to the periodic
    // re-check would still be correct but would make every orchestrator step
    // seconds slower, so hold the push path in place.
    assert!(
        blocked_for < Duration::from_secs(4),
        "a blocked wait must be woken by the append, not by the re-check tick \
         (took {blocked_for:?})"
    );
    assert_eq!(blocked["waitOutcome"], serde_json::json!("events"));
    assert_eq!(
        event_pairs(&blocked),
        vec![
            ("child-a".to_string(), "run.finished".to_string()),
            ("child-a".to_string(), "stage.changed".to_string()),
        ],
        "the blocked call must return exactly the events that fired during it"
    );
    cursor = cursor_of(&blocked);

    // Fired in the gap: nothing is listening at all when these land.
    {
        let db = Db::open(&db_path).expect("open db");
        start_run(&db, "run-b1", "child-b", "in progress");
        db.update_pipeline_item_pr("child-b", Some(944), "https://github.com/o/r/pull/944")
            .expect("record pr");
        db.close_pipeline_item("child-c").expect("close child");
    }

    let after_gap = get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&after_gap),
        vec![
            ("child-b".to_string(), "run.started".to_string()),
            ("child-b".to_string(), "task.pr_created".to_string()),
            ("child-c".to_string(), "task.closed".to_string()),
        ],
        "events that fired between two polls must be delivered on the next one"
    );
    cursor = cursor_of(&after_gap);

    // Nothing left: the feed is drained, not looping over what it already gave.
    let drained = get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    assert_eq!(drained["waitOutcome"], serde_json::json!("timeout"));
    assert_eq!(event_pairs(&drained), Vec::new());
}

/// Replaying a cursor is how a crashed orchestrator resumes. The same cursor
/// must yield the same events — the log is the source of truth, not the
/// reader's position in it.
#[tokio::test]
async fn a_replayed_cursor_returns_the_same_events_and_never_earlier_ones() {
    let (router, db_path) = events_router();
    let watch = "/v1/task-events?taskIds=child-a";

    {
        let db = Db::open(&db_path).expect("open db");
        start_run(&db, "run-a1", "child-a", "in progress");
    }
    let first = get_json_body(&router, &format!("{watch}&timeoutSecs=1")).await;
    let cursor = cursor_of(&first);

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("advance stage");
    }

    let replayed = get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    let again = get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&replayed),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );
    assert_eq!(event_pairs(&again), event_pairs(&replayed));
}

/// A watcher that falls behind must be told so, rather than silently receiving
/// a truncated view of what happened.
#[tokio::test]
async fn a_truncated_batch_reports_more_and_the_next_call_continues_from_it() {
    let (router, db_path) = events_router();

    {
        let db = Db::open(&db_path).expect("open db");
        // Four events against a page size of two, so the second page is exactly
        // full and must still report that nothing is left.
        start_run(&db, "run-a1", "child-a", "in progress");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("advance stage");
        db.update_pipeline_item_stage("child-a", "pr")
            .expect("advance stage again");
        db.close_pipeline_item("child-a").expect("close task");
    }

    let first = get_json_body(
        &router,
        "/v1/task-events?taskIds=child-a&limit=2&timeoutSecs=1",
    )
    .await;
    assert_eq!(first["hasMore"], serde_json::json!(true));
    assert_eq!(event_pairs(&first).len(), 2);

    let second = get_json_body(
        &router,
        &format!(
            "/v1/task-events?taskIds=child-a&limit=2&timeoutSecs=1&cursor={}",
            cursor_of(&first)
        ),
    )
    .await;
    assert_eq!(
        second["hasMore"],
        serde_json::json!(false),
        "a full final page must not claim more is waiting"
    );
    assert_eq!(
        event_pairs(&second),
        vec![
            ("child-a".to_string(), "stage.changed".to_string()),
            ("child-a".to_string(), "task.closed".to_string()),
        ]
    );
}

#[tokio::test]
async fn repo_scope_watches_tasks_the_caller_did_not_name() {
    let (router, db_path) = events_router();

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-b", "review")
            .expect("advance stage");
        db.update_pipeline_item_stage("unwatched", "review")
            .expect("advance unwatched stage");
    }

    let body = get_json_body(&router, "/v1/task-events?repoId=repo-events&timeoutSecs=1").await;
    assert_eq!(
        event_pairs(&body),
        vec![("child-b".to_string(), "stage.changed".to_string())]
    );
}

/// The public local surface is the watcher boundary: it fans a repository
/// wait through the already-authenticated relay bridge, while the peer's
/// tunneled sub-wait remains native and cannot recurse. The two repositories
/// deliberately have different row ids; only their remote URL hash agrees.
///
/// This is also the causal reconnect proof. The source retains the peer's
/// native cursor while the peer is absent, reports that gap, then catches up
/// from the peer's append-only feed without replaying the event already seen.
#[tokio::test]
async fn local_surface_aggregates_peer_repo_events_and_resumes_after_reconnect() {
    const REMOTE_HASH: &str = "sha256:same-origin-on-two-machines";
    let source = test_state_with_seed("desktop-source-events", "Source Mac", |db| {
        db.insert_test_repo("repo-source-id", "Kanna Source")
            .expect("insert source repo");
        db.patch_repo("repo-source-id", None, None, Some(Some(REMOTE_HASH)), None)
            .expect("set source remote hash");
    });
    let peer = test_state_with_seed("desktop-peer-events", "Peer Mac", |db| {
        db.insert_test_repo("repo-peer-different-id", "Kanna Peer")
            .expect("insert peer repo");
        db.patch_repo(
            "repo-peer-different-id",
            None,
            None,
            Some(Some(REMOTE_HASH)),
            None,
        )
        .expect("set peer remote hash");
        db.insert_test_pipeline_item(
            "remote-child",
            "repo-peer-different-id",
            "remote child",
            Some("Remote Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert peer task");
        start_run(db, "remote-run", "remote-child", "in progress");
    });
    let connected = Arc::new(AtomicBool::new(true));
    let relay = connect_test_relay_peer(&source, Arc::clone(&peer), Arc::clone(&connected));
    let source_router = router(Arc::clone(&source));
    let peer_router = router(Arc::clone(&peer));

    let first = get_account_json_body(
        &source_router,
        &source,
        "/v1/task-events?repoId=repo-source-id&timeoutSecs=1",
    )
    .await;
    assert_eq!(first["waitOutcome"], "events");
    assert!(cursor_of(&first).starts_with("ks1."));
    assert_eq!(
        event_pairs(&first),
        vec![("remote-child".into(), "run.started".into())]
    );
    assert_eq!(first["events"][0]["machineId"], "desktop-peer-events");
    assert_eq!(first["machineErrors"], json!([]));
    let first_cursor = cursor_of(&first);

    // The same event is present on the peer's own native feed. This compares
    // the aggregate output against its source of truth rather than a fixture.
    let peer_first = get_json_body(
        &peer_router,
        "/v1/task-events?repoId=repo-peer-different-id&localOnly=true&timeoutSecs=0",
    )
    .await;
    assert_eq!(event_pairs(&peer_first), event_pairs(&first));

    connected.store(false, Ordering::SeqCst);
    Db::open(&peer.config().db_path)
        .expect("open peer db")
        .update_pipeline_item_stage("remote-child", "review")
        .expect("append event while peer is disconnected");
    let stale = get_account_json_body(
        &source_router,
        &source,
        &format!("/v1/task-events?repoId=repo-source-id&cursor={first_cursor}&timeoutSecs=0"),
    )
    .await;
    assert_eq!(stale["waitOutcome"], "partial");
    assert_eq!(event_pairs(&stale), Vec::new());
    assert_eq!(
        stale["machineErrors"][0]["machineId"],
        "desktop-peer-events"
    );
    assert_eq!(stale["machineErrors"][0]["stale"], true);

    connected.store(true, Ordering::SeqCst);
    let caught_up = get_account_json_body(
        &source_router,
        &source,
        &format!(
            "/v1/task-events?repoId=repo-source-id&cursor={}&timeoutSecs=0",
            cursor_of(&stale)
        ),
    )
    .await;
    assert_eq!(caught_up["waitOutcome"], "events");
    assert_eq!(
        event_pairs(&caught_up),
        vec![("remote-child".into(), "stage.changed".into())]
    );
    assert_eq!(caught_up["events"][0]["machineId"], "desktop-peer-events");

    let drained = get_account_json_body(
        &source_router,
        &source,
        &format!(
            "/v1/task-events?repoId=repo-source-id&cursor={}&timeoutSecs=0",
            cursor_of(&caught_up)
        ),
    )
    .await;
    assert_eq!(drained["waitOutcome"], "timeout");
    assert_eq!(event_pairs(&drained), Vec::new());

    let peer_all = get_json_body(
        &peer_router,
        "/v1/task-events?repoRemoteUrlHash=sha256%3Asame-origin-on-two-machines&localOnly=true&timeoutSecs=0",
    )
    .await;
    let aggregate_events = event_pairs(&first)
        .into_iter()
        .chain(event_pairs(&caught_up))
        .collect::<Vec<_>>();
    assert_eq!(
        aggregate_events,
        event_pairs(&peer_all),
        "the aggregate feed must neither duplicate nor lose peer events"
    );

    relay.abort();
}

#[tokio::test]
async fn truncated_peer_legacy_parent_batch_preserves_acknowledged_watermarks() {
    let source = test_state_with_seed("desktop-legacy-source", "Legacy Source", |db| {
        db.insert_test_repo("repo-legacy-source", "Legacy Source Repo")
            .expect("insert source repo");
        for task_id in ["legacy-parent", "legacy-local"] {
            db.insert_test_pipeline_item(
                task_id,
                "repo-legacy-source",
                "local legacy cursor task",
                Some(task_id),
                "in progress",
                "2026-08-16 00:00:00",
            )
            .expect("insert source task");
        }
        db.update_pipeline_item_parent("legacy-local", Some("legacy-parent"))
            .expect("set local parent");
        db.update_pipeline_item_stage("legacy-local", "review")
            .expect("append local event");
    });
    let peer = test_state_with_seed("desktop-legacy-peer", "Legacy Peer", |db| {
        db.insert_test_repo("repo-legacy-peer", "Legacy Peer Repo")
            .expect("insert peer repo");
        for task_id in ["legacy-parent", "legacy-acknowledged", "legacy-pending"] {
            db.insert_test_pipeline_item(
                task_id,
                "repo-legacy-peer",
                "legacy cursor task",
                Some(task_id),
                "in progress",
                "2026-08-16 00:00:00",
            )
            .expect("insert peer task");
        }
        for child in ["legacy-acknowledged", "legacy-pending"] {
            db.update_pipeline_item_parent(child, Some("legacy-parent"))
                .expect("set parent");
        }
        db.update_pipeline_item_stage("legacy-pending", "review")
            .expect("append first pending event");
        db.update_pipeline_item_pr(
            "legacy-pending",
            Some(1102),
            "https://github.com/kanna/kanna/pull/1102",
        )
        .expect("append second pending event");
        db.update_pipeline_item_stage("legacy-acknowledged", "review")
            .expect("append acknowledged event after pending events");
    });
    let peer_router = router(Arc::clone(&peer));
    let acknowledged = get_json_body(
        &peer_router,
        "/v1/task-events?taskIds=legacy-acknowledged&localOnly=true&timeoutSecs=0",
    )
    .await;
    let acknowledged_seq = acknowledged["events"][0]["seq"]
        .as_i64()
        .expect("acknowledged event seq");
    let legacy_cursor = legacy_parent_cursor(
        "legacy-parent",
        [
            (
                "legacy-acknowledged".to_string(),
                serde_json::json!(acknowledged_seq),
            ),
            ("legacy-pending".to_string(), serde_json::json!(0)),
        ]
        .into_iter()
        .collect(),
    );

    // Establish the peer feed's exact non-replaying result for the same p1
    // cursor before comparing the aggregate surface with it.
    let peer_feed = get_json_body(
        &peer_router,
        &format!(
            "/v1/task-events?parentTaskId=legacy-parent&localOnly=true&limit=500&cursor={legacy_cursor}&timeoutSecs=0"
        ),
    )
    .await;
    assert_eq!(
        event_pairs(&peer_feed),
        vec![
            ("legacy-pending".into(), "stage.changed".into()),
            ("legacy-pending".into(), "task.pr_created".into()),
        ]
    );

    let invoke_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let invoke_count = Arc::new(AtomicUsize::new(0));
    let relay = connect_test_relay_peer_with_invoke_gate(
        &source,
        Arc::clone(&peer),
        Arc::clone(&invoke_gate),
        Arc::clone(&invoke_count),
    );
    let source_router = router(Arc::clone(&source));
    let aggregate_cursor = aggregate_parent_cursor(
        "desktop-legacy-source",
        "desktop-legacy-peer",
        "legacy-parent",
        &legacy_cursor,
    );
    let first = get_account_json_body(
        &source_router,
        &source,
        &format!(
            "/v1/task-events?parentTaskId=legacy-parent&limit=500&cursor={aggregate_cursor}&timeoutSecs=30"
        ),
    )
    .await;
    assert_eq!(
        event_pairs(&first),
        vec![("legacy-local".into(), "stage.changed".into())]
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while invoke_count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the retained peer wait must start with the original large limit");
    invoke_gate.add_permits(10);

    let second = get_account_json_body(
        &source_router,
        &source,
        &format!(
            "/v1/task-events?parentTaskId=legacy-parent&limit=1&cursor={}&timeoutSecs=5",
            cursor_of(&first)
        ),
    )
    .await;
    assert_eq!(
        event_pairs(&second),
        vec![("legacy-pending".into(), "stage.changed".into())]
    );
    assert_eq!(second["hasMore"], true);

    let last_emitted_seq = second["events"][0]["seq"]
        .as_i64()
        .expect("emitted peer sequence");
    let second_cursor = cursor_of(&second);
    let aggregate_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(
            second_cursor
                .strip_prefix("ks1.")
                .expect("aggregate cursor"),
        )
        .expect("decode aggregate continuation");
    let aggregate_continuation: Value =
        serde_json::from_slice(&aggregate_bytes).expect("parse aggregate continuation");
    let peer_continuation = aggregate_continuation["cursorsByMachine"]["desktop-legacy-peer"]
        .as_str()
        .expect("peer continuation");
    let peer_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(
            peer_continuation
                .strip_prefix("p1.")
                .expect("truncated legacy peer batch must retain a p1 continuation"),
        )
        .expect("decode peer continuation");
    let peer_continuation: Value =
        serde_json::from_slice(&peer_bytes).expect("parse peer continuation");
    assert_eq!(peer_continuation["event_seq"], last_emitted_seq);
    assert_eq!(
        peer_continuation["watermarks"]["legacy-acknowledged"],
        acknowledged_seq
    );
    assert!(acknowledged_seq > last_emitted_seq);

    let third = get_account_json_body(
        &source_router,
        &source,
        &format!(
            "/v1/task-events?parentTaskId=legacy-parent&limit=500&cursor={}&timeoutSecs=0",
            cursor_of(&second)
        ),
    )
    .await;
    assert_eq!(
        event_pairs(&third),
        vec![("legacy-pending".into(), "task.pr_created".into())],
        "resuming the truncated cursor must not replay the acknowledged child"
    );

    let aggregate_events = event_pairs(&second)
        .into_iter()
        .chain(event_pairs(&third))
        .collect::<Vec<_>>();
    assert_eq!(
        aggregate_events,
        event_pairs(&peer_feed),
        "the aggregate peer sequence must exactly match the peer's own feed"
    );
    assert!(aggregate_events
        .iter()
        .all(|(task_id, _)| task_id != "legacy-acknowledged"));

    relay.abort();
}

#[tokio::test]
async fn local_surface_aggregates_named_and_parent_scopes_when_tasks_live_only_on_peer() {
    let source = test_state_with_seed("desktop-source-scopes", "Source Mac", |db| {
        db.insert_test_repo("repo-source-scopes", "Source")
            .expect("insert source repo");
        db.insert_test_pipeline_item(
            "durable-parent",
            "repo-source-scopes",
            "parent",
            Some("Durable Parent"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert source parent");
    });
    let peer = test_state_with_seed("desktop-peer-scopes", "Peer Mac", |db| {
        db.insert_test_repo("repo-peer-scopes", "Peer")
            .expect("insert peer repo");
        db.insert_test_pipeline_item(
            "peer-only-child",
            "repo-peer-scopes",
            "child",
            Some("Peer Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert peer child");
        db.update_pipeline_item_parent("peer-only-child", Some("durable-parent"))
            .expect("attach cross-machine parent identity");
        start_run(db, "peer-only-run", "peer-only-child", "in progress");
    });
    let connected = Arc::new(AtomicBool::new(true));
    let relay = connect_test_relay_peer(&source, Arc::clone(&peer), connected);
    let source_router = router(Arc::clone(&source));

    let named = get_account_json_body(
        &source_router,
        &source,
        "/v1/task-events?taskIds=peer-only-child&timeoutSecs=0",
    )
    .await;
    assert_eq!(event_pairs(&named).len(), 1);
    assert_eq!(named["events"][0]["machineId"], "desktop-peer-scopes");

    let children = get_account_json_body(
        &source_router,
        &source,
        "/v1/task-events?parentTaskId=durable-parent&timeoutSecs=0",
    )
    .await;
    assert_eq!(event_pairs(&children), event_pairs(&named));
    assert_eq!(children["events"][0]["machineId"], "desktop-peer-scopes");

    relay.abort();
}

#[tokio::test]
async fn documented_node_fetch_watcher_authorizes_its_first_aggregate_poll() {
    let source = test_state_with_seed("desktop-node-source", "Node Source", |db| {
        db.insert_test_repo("repo-node-source", "Node Source")
            .expect("insert source repo");
    });
    let peer = test_state_with_seed("desktop-node-peer", "Node Peer", |db| {
        db.insert_test_repo("repo-node-peer", "Node Peer")
            .expect("insert peer repo");
        db.insert_test_pipeline_item(
            "node-peer-child",
            "repo-node-peer",
            "node watcher child",
            Some("Node Watcher Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert peer task");
        start_run(db, "node-peer-run", "node-peer-child", "in progress");
    });
    let relay = connect_test_relay_peer(&source, peer, Arc::new(AtomicBool::new(true)));
    let token_path = source
        .config()
        .task_events_token_path()
        .expect("task-event credential path");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&token_path)
                .expect("task-event credential metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind Node watcher server");
    let address = listener.local_addr().expect("Node watcher address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router(source).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .expect("serve Node watcher request");
    });
    let script = r#"
import { readFile } from "node:fs/promises";
const token = (await readFile(process.env.KANNA_TASK_EVENTS_TOKEN_PATH, "utf8")).trim();
const url = new URL("/v1/task-events", process.env.KANNA_SERVER_BASE_URL);
url.searchParams.set("taskIds", "node-peer-child");
url.searchParams.set("timeoutSecs", "0");
const response = await fetch(url, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20000),
});
const body = await response.text();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
process.stdout.write(body);
"#;
    let output = tokio::process::Command::new("node")
        .args(["--input-type=module", "-e", script])
        .env("KANNA_SERVER_BASE_URL", format!("http://{address}"))
        .env("KANNA_TASK_EVENTS_TOKEN_PATH", &token_path)
        .output()
        .await
        .expect("run documented Node watcher client");
    assert!(
        output.status.success(),
        "Node watcher failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let body: Value = from_slice(&output.stdout).expect("Node watcher JSON response");
    assert!(cursor_of(&body).starts_with("ks1."));
    assert_eq!(
        event_pairs(&body),
        vec![("node-peer-child".into(), "run.started".into())]
    );
    assert_eq!(body["events"][0]["machineId"], "desktop-node-peer");

    server.abort();
    relay.abort();
}

#[tokio::test]
async fn unpaired_non_loopback_lan_wait_never_uses_the_account_relay_feed() {
    const REMOTE_HASH: &str = "sha256:lan-authority-repo";
    let source = test_state_with_seed("desktop-lan-source", "LAN Source", |db| {
        db.insert_test_repo("repo-lan-source", "LAN Source Repo")
            .expect("insert source repo");
        db.patch_repo("repo-lan-source", None, None, Some(Some(REMOTE_HASH)), None)
            .expect("set source remote hash");
    });
    let peer = test_state_with_seed("desktop-lan-peer", "LAN Peer", |db| {
        db.insert_test_repo("repo-lan-peer", "LAN Peer Repo")
            .expect("insert peer repo");
        db.patch_repo("repo-lan-peer", None, None, Some(Some(REMOTE_HASH)), None)
            .expect("set peer remote hash");
        db.insert_test_pipeline_item(
            "lan-peer-child",
            "repo-lan-peer",
            "peer child",
            Some("Peer Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert peer task");
        start_run(db, "lan-peer-run", "lan-peer-child", "in progress");
    });
    let relay = connect_test_relay_peer(&source, peer, Arc::new(AtomicBool::new(true)));
    let app = router(Arc::clone(&source));
    let mut request = Request::get("/v1/task-events?repoId=repo-lan-source&timeoutSecs=0")
        .body(Body::empty())
        .expect("request");
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [192, 168, 1, 42],
            49152,
        ))));

    let response = app.oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("json body");
    assert_eq!(event_pairs(&body), Vec::new());
    assert!(!cursor_of(&body).starts_with("ks1."));
    assert!(body.get("machineErrors").is_none());

    relay.abort();
}

#[tokio::test]
async fn unauthenticated_loopback_waits_get_only_the_local_feed_for_all_browser_metadata() {
    const REMOTE_HASH: &str = "sha256:browser-origin-repo";
    let source = test_state_with_seed("desktop-browser-source", "Browser Source", |db| {
        db.insert_test_repo("repo-browser-source", "Browser Source Repo")
            .expect("insert source repo");
        db.patch_repo(
            "repo-browser-source",
            None,
            None,
            Some(Some(REMOTE_HASH)),
            None,
        )
        .expect("set source remote hash");
        db.insert_test_pipeline_item(
            "browser-local-child",
            "repo-browser-source",
            "local child",
            Some("Local Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert local task");
        start_run(
            db,
            "browser-local-run",
            "browser-local-child",
            "in progress",
        );
    });
    let peer = test_state_with_seed("desktop-browser-peer", "Browser Peer", |db| {
        db.insert_test_repo("repo-browser-peer", "Browser Peer Repo")
            .expect("insert peer repo");
        db.patch_repo(
            "repo-browser-peer",
            None,
            None,
            Some(Some(REMOTE_HASH)),
            None,
        )
        .expect("set peer remote hash");
        db.insert_test_pipeline_item(
            "browser-peer-child",
            "repo-browser-peer",
            "peer child",
            Some("Peer Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert peer task");
        start_run(db, "browser-peer-run", "browser-peer-child", "in progress");
    });
    let relay = connect_test_relay_peer(&source, peer, Arc::new(AtomicBool::new(true)));
    let app = router(source);
    for headers in [
        Vec::new(),
        vec![
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-mode", "same-origin"),
        ],
        vec![("origin", "https://attacker.example")],
    ] {
        let mut builder = Request::get("/v1/task-events?repoId=repo-browser-source&timeoutSecs=0");
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        let mut request = builder.body(Body::empty()).expect("request");
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                49152,
            ))));

        let response = app.clone().oneshot(request).await.expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("json body");
        assert_eq!(
            event_pairs(&body),
            vec![("browser-local-child".into(), "run.started".into())]
        );
        assert!(!cursor_of(&body).starts_with("ks1."));
        assert!(body["events"][0].get("machineId").is_none());
    }

    relay.abort();
}

#[tokio::test]
async fn unauthorized_resume_rejects_an_account_wide_cursor_without_losing_peer_state() {
    let source = test_state_with_seed("desktop-downgrade-source", "Downgrade Source", |db| {
        db.insert_test_repo("repo-downgrade", "Downgrade Repo")
            .expect("insert source repo");
        db.insert_test_pipeline_item(
            "downgrade-child",
            "repo-downgrade",
            "local child",
            Some("Local Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert local task");
        start_run(db, "downgrade-run", "downgrade-child", "in progress");
    });
    let peer = test_state_with_seed("desktop-downgrade-peer", "Downgrade Peer", |_| {});
    let relay = connect_test_relay_peer(&source, peer, Arc::new(AtomicBool::new(true)));
    let app = router(Arc::clone(&source));
    let first = get_account_json_body(
        &app,
        &source,
        "/v1/task-events?taskIds=downgrade-child&timeoutSecs=0",
    )
    .await;
    let mut request = Request::get(format!(
        "/v1/task-events?taskIds=downgrade-child&cursor={}&timeoutSecs=0",
        cursor_of(&first)
    ))
    .header(axum::http::header::ORIGIN, "https://attacker.example")
    .body(Body::empty())
    .expect("request");
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49153,
        ))));

    let response = app.oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert!(String::from_utf8_lossy(&body).contains("not authorized to resume"));

    relay.abort();
}

#[tokio::test]
async fn fresh_zero_timeout_drains_local_events_without_waiting_for_an_unresponsive_peer() {
    let source = test_state_with_seed("desktop-zero-source", "Zero Source", |db| {
        db.insert_test_repo("repo-zero", "Zero Repo")
            .expect("insert source repo");
        db.insert_test_pipeline_item(
            "zero-local-child",
            "repo-zero",
            "local child",
            Some("Local Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert local task");
        start_run(db, "zero-local-run", "zero-local-child", "in progress");
    });
    let relay = connect_unresponsive_listed_peer(&source, "desktop-zero-unresponsive");
    let app = router(Arc::clone(&source));

    let body = tokio::time::timeout(
        Duration::from_millis(500),
        get_account_json_body(
            &app,
            &source,
            "/v1/task-events?taskIds=zero-local-child&timeoutSecs=0",
        ),
    )
    .await
    .expect("zero-timeout drain must not await the relay invoke timeout");
    assert_eq!(
        event_pairs(&body),
        vec![("zero-local-child".into(), "run.started".into())]
    );
    assert_eq!(body["events"][0]["machineId"], "desktop-zero-source");

    relay.abort();
}

fn aggregate_pending_leg_states() -> (Arc<AppState>, Arc<AppState>) {
    let source = test_state_with_seed("desktop-pending-source", "Pending Source", |db| {
        db.insert_test_repo("repo-pending-source", "Pending Source Repo")
            .expect("insert source repo");
        db.insert_test_pipeline_item(
            "pending-local-child",
            "repo-pending-source",
            "local child",
            Some("Local Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert source task");
        start_run(
            db,
            "pending-local-run",
            "pending-local-child",
            "in progress",
        );
    });
    let peer = test_state_with_seed("desktop-pending-peer", "Pending Peer", |db| {
        db.insert_test_repo("repo-pending-peer", "Pending Peer Repo")
            .expect("insert peer repo");
        db.insert_test_pipeline_item(
            "pending-peer-child",
            "repo-pending-peer",
            "peer child",
            Some("Peer Child"),
            "in progress",
            "2026-08-16 00:00:00",
        )
        .expect("insert peer task");
    });
    (source, peer)
}

#[tokio::test]
async fn zero_timeout_resume_does_not_await_an_inherited_long_poll() {
    let (source, peer) = aggregate_pending_leg_states();
    let relay = connect_test_relay_peer(&source, peer, Arc::new(AtomicBool::new(true)));
    let app = router(Arc::clone(&source));
    let scope = "/v1/task-events?taskIds=pending-local-child,pending-peer-child";
    let first = get_account_json_body(&app, &source, &format!("{scope}&timeoutSecs=30")).await;
    assert_eq!(event_pairs(&first).len(), 1);

    let resumed = tokio::time::timeout(
        Duration::from_millis(500),
        get_account_json_body(
            &app,
            &source,
            &format!("{scope}&cursor={}&timeoutSecs=0", cursor_of(&first)),
        ),
    )
    .await
    .expect("zero-timeout resume must not await the inherited 30-second leg");
    assert!(event_pairs(&resumed).is_empty());

    relay.abort();
}

#[tokio::test]
async fn shrinking_limit_retains_one_peer_leg_and_resumes_past_only_emitted_events() {
    let (source, peer) = aggregate_pending_leg_states();
    let invoke_count = Arc::new(AtomicUsize::new(0));
    let busy_count = Arc::new(AtomicUsize::new(0));
    let relay = connect_test_relay_peer_with_long_poll_budget(
        &source,
        Arc::clone(&peer),
        Arc::clone(&invoke_count),
        Arc::clone(&busy_count),
    );
    let app = router(Arc::clone(&source));
    let scope = "/v1/task-events?taskIds=pending-local-child,pending-peer-child";
    let first =
        get_account_json_body(&app, &source, &format!("{scope}&limit=500&timeoutSecs=30")).await;
    assert_eq!(event_pairs(&first).len(), 1);

    // Resume with a different limit while the original peer long poll still
    // owns the only peer permit. Restarting that retained leg would now hit a
    // real 503, rather than racing a permit that the completed request already
    // released.
    tokio::time::timeout(Duration::from_secs(1), async {
        while invoke_count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the retained peer long poll must acquire its permit");
    assert_eq!(invoke_count.load(Ordering::SeqCst), 1);
    let inherited = get_account_json_body(
        &app,
        &source,
        &format!("{scope}&limit=1&cursor={}&timeoutSecs=0", cursor_of(&first)),
    )
    .await;
    assert!(event_pairs(&inherited).is_empty());
    assert_eq!(invoke_count.load(Ordering::SeqCst), 1);
    assert_eq!(busy_count.load(Ordering::SeqCst), 0);

    let db = Db::open(&peer.config().db_path).expect("open peer db");
    db.update_pipeline_item_stage("pending-peer-child", "review")
        .expect("append first peer event");
    db.update_pipeline_item_pr(
        "pending-peer-child",
        Some(1101),
        "https://github.com/kanna/kanna/pull/1101",
    )
    .expect("append second peer event");
    db.close_pipeline_item("pending-peer-child")
        .expect("append third peer event");

    let second = get_account_json_body(
        &app,
        &source,
        &format!(
            "{scope}&limit=1&cursor={}&timeoutSecs=5",
            cursor_of(&inherited)
        ),
    )
    .await;
    assert_eq!(event_pairs(&second).len(), 1);
    assert_eq!(second["hasMore"], true);
    assert_eq!(busy_count.load(Ordering::SeqCst), 0);

    let third = get_account_json_body(
        &app,
        &source,
        &format!(
            "{scope}&limit=1&cursor={}&timeoutSecs=0",
            cursor_of(&second)
        ),
    )
    .await;
    assert_eq!(event_pairs(&third).len(), 1);
    assert_eq!(third["hasMore"], true);

    let fourth = get_account_json_body(
        &app,
        &source,
        &format!("{scope}&limit=1&cursor={}&timeoutSecs=0", cursor_of(&third)),
    )
    .await;
    assert_eq!(event_pairs(&fourth).len(), 1);
    let peer_events = event_pairs(&second)
        .into_iter()
        .chain(event_pairs(&third))
        .chain(event_pairs(&fourth))
        .collect::<Vec<_>>();
    assert_eq!(
        peer_events,
        vec![
            ("pending-peer-child".into(), "stage.changed".into()),
            ("pending-peer-child".into(), "task.pr_created".into()),
            ("pending-peer-child".into(), "task.closed".into()),
        ],
        "shrinking the limit must preserve every event behind the retained leg"
    );
    assert_eq!(busy_count.load(Ordering::SeqCst), 0);
    assert_eq!(invoke_count.load(Ordering::SeqCst), 3);

    relay.abort();
}

#[tokio::test]
async fn empty_inherited_leg_is_rearmed_and_wakes_the_same_long_poll() {
    let (source, peer) = aggregate_pending_leg_states();
    let relay =
        connect_test_relay_peer(&source, Arc::clone(&peer), Arc::new(AtomicBool::new(true)));
    let app = router(Arc::clone(&source));
    let scope = "/v1/task-events?taskIds=pending-local-child,pending-peer-child";
    let first = get_account_json_body(&app, &source, &format!("{scope}&timeoutSecs=1")).await;
    assert_eq!(event_pairs(&first).len(), 1);
    tokio::time::sleep(Duration::from_millis(1_100)).await;

    let peer_db_path = peer.config().db_path.clone();
    let writer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        Db::open(&peer_db_path)
            .expect("open peer db")
            .update_pipeline_item_stage("pending-peer-child", "review")
            .expect("append peer event");
    });
    let resumed = tokio::time::timeout(
        Duration::from_secs(2),
        get_account_json_body(
            &app,
            &source,
            &format!("{scope}&cursor={}&timeoutSecs=5", cursor_of(&first)),
        ),
    )
    .await
    .expect("rearmed peer leg must wake this call, not the next outer poll");
    writer.await.expect("writer");
    assert_eq!(
        event_pairs(&resumed),
        vec![("pending-peer-child".into(), "stage.changed".into())]
    );
    assert_eq!(resumed["events"][0]["machineId"], "desktop-pending-peer");

    relay.abort();
}

/// One orchestrator, its own children, and nobody else's. Everything here is
/// reachable from the parent's own id — the point of the scope is that an agent
/// which lost the ids it created (compaction, a resumed session) can still name
/// something narrower than the whole repo.
fn seed_parentage(db: &Db) {
    db.insert_test_repo("repo-events", "Events Repo")
        .expect("insert repo");
    for (task_id, created_at) in [
        ("parent-1", "2026-07-29 00:00:00"),
        ("child-a", "2026-07-29 00:01:00"),
        ("child-b", "2026-07-29 00:02:00"),
        // Same repo, no parent yet: adopted mid-test to prove the scope is
        // re-resolved rather than snapshotted at the first call.
        ("stranger", "2026-07-29 00:03:00"),
    ] {
        db.insert_test_pipeline_item(
            task_id,
            "repo-events",
            "work",
            Some(task_id),
            "in progress",
            created_at,
        )
        .expect("insert task");
    }
    for child in ["child-a", "child-b"] {
        db.update_pipeline_item_parent(child, Some("parent-1"))
            .expect("set parent");
    }
}

fn parentage_router() -> (Router, String) {
    let state = test_state_with_seed("desktop-parentage", "Parentage", seed_parentage);
    let db_path = state.config().db_path.clone();
    (router(state), db_path)
}

/// The scope a fan-out can express after forgetting what it created: name
/// yourself, receive your children. It must wake on a child's append like any
/// other scope, pick up a task adopted after the watch began, and never hand
/// back the parent's own events — the parent is the caller, not a child.
#[tokio::test]
async fn watching_by_parent_delivers_child_events_without_naming_ids() {
    let (router, db_path) = parentage_router();
    let watch = "/v1/task-events?parentTaskId=parent-1";

    {
        let db = Db::open(&db_path).expect("open db");
        start_run(&db, "run-a1", "child-a", "in progress");
        // Neither of these belongs to the caller's fan-out: the parent's own
        // progress, and a sibling it never adopted.
        db.update_pipeline_item_stage("parent-1", "review")
            .expect("advance parent stage");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("advance stranger stage");
    }

    let first = get_json_body(&router, &format!("{watch}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&first),
        vec![("child-a".to_string(), "run.started".to_string())],
        "watching by parent must deliver the children's events and only those"
    );
    let mut cursor = cursor_of(&first);

    // A blocked wait on this scope must be woken by the append, exactly as a
    // named-id wait is: an orchestrator that switches to the parent scope must
    // not silently trade its latency for convenience.
    let writer_db_path = db_path.clone();
    let writer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let db = Db::open(&writer_db_path).expect("open db");
        db.finish_stage_run("run-a1", "succeeded", Some("done"), None)
            .expect("finish run");
        start_run(&db, "run-b1", "child-b", "in progress");
    });
    let started = std::time::Instant::now();
    let blocked = tokio::time::timeout(
        Duration::from_secs(20),
        get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=15")),
    )
    .await
    .expect("blocked wait returned");
    let blocked_for = started.elapsed();
    writer.await.expect("writer");
    assert!(
        blocked_for < Duration::from_secs(4),
        "a parent-scoped wait must be woken by the append, not by the re-check \
         tick (took {blocked_for:?})"
    );
    assert_eq!(
        event_pairs(&blocked),
        vec![
            ("child-a".to_string(), "run.finished".to_string()),
            ("child-b".to_string(), "run.started".to_string()),
        ]
    );
    cursor = cursor_of(&blocked);

    // The stranger emits an event while outside the subtree. The empty read is
    // a global checkpoint: adopting the task later must not rewind that cursor
    // and replay history the caller already advanced past.
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("stranger", "pr")
            .expect("advance stranger outside subtree");
    }
    let timed_out = get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=0")).await;
    assert_eq!(timed_out["waitOutcome"], serde_json::json!("timeout"));
    cursor = cursor_of(&timed_out);

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt");
    }
    let after_adoption =
        get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=0")).await;
    assert!(event_pairs(&after_adoption).is_empty());
    cursor = cursor_of(&after_adoption);

    // Future events use the same cursor normally after adoption.
    {
        let db = Db::open(&db_path).expect("open db");
        start_run(&db, "run-s1", "stranger", "in progress");
    }
    let after_adoption_event =
        get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&after_adoption_event),
        vec![("stranger".to_string(), "run.started".to_string())]
    );

    // Starting without a cursor still means retained history for the membership
    // as it exists now. Checkpoint semantics only affect cursor reuse.
    let replayed = get_json_body(&router, &format!("{watch}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&replayed),
        vec![
            ("child-a".to_string(), "run.started".to_string()),
            ("stranger".to_string(), "stage.changed".to_string()),
            ("child-a".to_string(), "run.finished".to_string()),
            ("child-b".to_string(), "run.started".to_string()),
            ("stranger".to_string(), "stage.changed".to_string()),
            ("stranger".to_string(), "run.started".to_string()),
        ]
    );
}

/// Parent membership is evaluated at each read checkpoint. An away/back round
/// trip cannot rewind the global sequence and replay acknowledged events; an
/// event after the checkpoint remains eligible when the child is back in scope
/// at the next read.
#[tokio::test]
async fn parent_cursor_handles_reparent_away_and_back_without_replay_or_skip() {
    let (router, db_path) = parentage_router();
    let watch = "/v1/task-events?parentTaskId=parent-1";
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("acknowledged event");
    }
    let acknowledged = get_json_body(&router, &format!("{watch}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&acknowledged),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );
    let cursor = cursor_of(&acknowledged);

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("child-a", None)
            .expect("reparent away");
        db.update_pipeline_item_stage("child-a", "pr")
            .expect("new event during round trip");
        db.update_pipeline_item_parent("child-a", Some("parent-1"))
            .expect("reparent back");
    }
    let after_round_trip =
        get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&after_round_trip),
        vec![("child-a".to_string(), "stage.changed".to_string())],
        "the acknowledged review event must not replay and the new pr event must not be skipped"
    );

    // If a read checkpoint occurs while the task is away, its outside event is
    // deliberately ineligible and remains behind that checkpoint after return.
    let cursor = cursor_of(&after_round_trip);
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("child-a", None)
            .expect("reparent away again");
        db.update_pipeline_item_stage("child-a", "done")
            .expect("outside event");
    }
    let away = get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=0")).await;
    assert!(event_pairs(&away).is_empty());
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("child-a", Some("parent-1"))
            .expect("return after checkpoint");
    }
    let returned = get_json_body(
        &router,
        &format!("{watch}&cursor={}&timeoutSecs=0", cursor_of(&away)),
    )
    .await;
    assert!(event_pairs(&returned).is_empty());
}

/// Servers before the per-child cursor shipped returned a numeric sequence for
/// parent scopes. An agent can carry that cursor across an upgrade, so the
/// first new-server response must neither replay acknowledged events nor keep
/// returning a numeric cursor that is not bound to the parent scope.
#[tokio::test]
async fn legacy_numeric_parent_cursor_deduplicates_then_upgrades_to_opaque() {
    let (router, db_path) = parentage_router();

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("first child event");
    }
    let acknowledged =
        get_json_body(&router, "/v1/task-events?taskIds=child-a&timeoutSecs=1").await;
    let legacy_cursor = cursor_of(&acknowledged);
    assert!(legacy_cursor.parse::<i64>().is_ok(), "fixed scope cursor");

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-b", "review")
            .expect("event after legacy cursor");
    }
    let upgraded = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={legacy_cursor}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&upgraded),
        vec![("child-b".to_string(), "stage.changed".to_string())],
        "the event acknowledged by the numeric cursor must not replay"
    );
    let opaque_cursor = cursor_of(&upgraded);
    assert!(opaque_cursor.starts_with("p3."));

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "pr")
            .expect("event after opaque cursor");
    }
    let next = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={opaque_cursor}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&next),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );
}

#[tokio::test]
async fn legacy_p1_parent_cursor_drains_without_replay_then_compacts_to_p3() {
    let (router, db_path) = parentage_router();
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("acknowledged child event");
    }
    let acknowledged =
        get_json_body(&router, "/v1/task-events?taskIds=child-a&timeoutSecs=1").await;
    let acknowledged_seq = acknowledged["events"][0]["seq"]
        .as_i64()
        .expect("event seq");
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-b", "review")
            .expect("pending child event");
    }
    let legacy_payload = serde_json::json!({
        "parent_task_id": "parent-1",
        "watermarks": {
            "child-a": acknowledged_seq,
            "child-b": 0,
        }
    });
    let legacy_cursor = format!(
        "p1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(legacy_payload.to_string())
    );

    let upgraded = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={legacy_cursor}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&upgraded),
        vec![("child-b".to_string(), "stage.changed".to_string())]
    );
    assert!(cursor_of(&upgraded).starts_with("p3."));
}

#[tokio::test]
async fn legacy_p1_parent_cursor_survives_a_child_reparented_away_before_compaction() {
    let (router, db_path) = parentage_router();
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("acknowledged child event");
    }
    let acknowledged =
        get_json_body(&router, "/v1/task-events?taskIds=child-a&timeoutSecs=1").await;
    let acknowledged_seq = acknowledged["events"][0]["seq"]
        .as_i64()
        .expect("event seq");
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-b", "review")
            .expect("pending child event");
        db.update_pipeline_item_parent("child-a", None)
            .expect("reparent acknowledged child away");
    }
    let legacy_payload = serde_json::json!({
        "parent_task_id": "parent-1",
        "watermarks": {
            "child-a": acknowledged_seq,
            "child-b": 0,
        }
    });
    let legacy_cursor = format!(
        "p1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(legacy_payload.to_string())
    );

    let upgraded = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={legacy_cursor}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&upgraded),
        vec![("child-b".to_string(), "stage.changed".to_string())]
    );
    assert!(cursor_of(&upgraded).starts_with("p3."));
}

#[tokio::test]
async fn legacy_p1_parent_cursor_paginates_an_adopted_child_then_compacts_once() {
    let (router, db_path) = parentage_router();
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("first established child event");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("first retained adoptee event");
        db.update_pipeline_item_stage("stranger", "pr")
            .expect("second retained adoptee event");
        db.update_pipeline_item_stage("child-b", "review")
            .expect("second established child event");
    }
    let established = get_json_body(
        &router,
        "/v1/task-events?taskIds=child-a,child-b&timeoutSecs=1",
    )
    .await;
    let established_events = established["events"].as_array().expect("events array");
    let watermark = |task_id: &str| {
        established_events
            .iter()
            .find(|event| event["taskId"] == task_id)
            .and_then(|event| event["seq"].as_i64())
            .expect("established child watermark")
    };
    let legacy_payload = serde_json::json!({
        "parent_task_id": "parent-1",
        "watermarks": {
            "child-a": watermark("child-a"),
            "child-b": watermark("child-b"),
        }
    });
    let legacy_cursor = format!(
        "p1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(legacy_payload.to_string())
    );
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt child after p1 issuance");
    }
    let watch = "/v1/task-events?parentTaskId=parent-1&limit=1&timeoutSecs=0";

    let first = get_json_body(&router, &format!("{watch}&cursor={legacy_cursor}")).await;
    assert_eq!(
        event_pairs(&first),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );
    assert_eq!(first["hasMore"], serde_json::json!(true));
    assert!(cursor_of(&first).starts_with("p1."));

    let second = get_json_body(&router, &format!("{watch}&cursor={}", cursor_of(&first))).await;
    assert_eq!(
        event_pairs(&second),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );
    assert_eq!(second["hasMore"], serde_json::json!(false));
    assert!(cursor_of(&second).starts_with("p3."));
    assert_ne!(first["events"][0]["seq"], second["events"][0]["seq"]);

    let drained = get_json_body(&router, &format!("{watch}&cursor={}", cursor_of(&second))).await;
    assert!(event_pairs(&drained).is_empty());
    assert_eq!(cursor_of(&drained), cursor_of(&second));
}

#[tokio::test]
async fn legacy_p1_full_map_returns_a_consumable_adoptee_continuation() {
    let (router, db_path) = parentage_router();
    let head_seq = {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("first retained adoptee event");
        db.update_pipeline_item_stage("stranger", "pr")
            .expect("second retained adoptee event");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("established child checkpoint");
        db.latest_task_event_seq().expect("event head")
    };
    let mut watermarks = (0..498)
        .map(|index| (format!("stale-{index:03}"), serde_json::json!(head_seq)))
        .collect::<serde_json::Map<_, _>>();
    watermarks.insert("child-a".to_string(), serde_json::json!(head_seq));
    watermarks.insert("child-b".to_string(), serde_json::json!(head_seq));
    assert_eq!(watermarks.len(), 500);
    let legacy_cursor = legacy_parent_cursor("parent-1", watermarks);
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt child after full p1 issuance");
    }
    let watch = "/v1/task-events?parentTaskId=parent-1&limit=1&timeoutSecs=0";

    let first = get_json_body(&router, &format!("{watch}&cursor={legacy_cursor}")).await;
    assert_eq!(
        event_pairs(&first),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );
    assert_eq!(first["hasMore"], serde_json::json!(true));
    let first_cursor = cursor_of(&first);
    assert!(first_cursor.starts_with("p1."));
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(first_cursor.strip_prefix("p1.").expect("p1 cursor"))
        .expect("decode continuation");
    let continuation: Value = serde_json::from_slice(&decoded).expect("parse continuation");
    assert_eq!(
        continuation["watermarks"]
            .as_object()
            .expect("watermarks")
            .len(),
        500,
        "the adopted child must not make the accepted legacy map grow"
    );

    let second = get_json_body(&router, &format!("{watch}&cursor={first_cursor}")).await;
    assert_eq!(
        event_pairs(&second),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );
    assert!(cursor_of(&second).starts_with("p3."));
    assert_ne!(first["events"][0]["seq"], second["events"][0]["seq"]);

    let drained = get_json_body(&router, &format!("{watch}&cursor={}", cursor_of(&second))).await;
    assert!(event_pairs(&drained).is_empty());
}

#[tokio::test]
async fn legacy_p1_reads_membership_and_events_from_one_snapshot() {
    let (router, db_path) = parentage_router();
    let head_seq = {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("retained adoptee event");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("legacy acknowledgement ceiling");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt before snapshot");
        db.latest_task_event_seq().expect("event head")
    };
    let legacy_cursor = legacy_parent_cursor(
        "parent-1",
        [
            ("child-a".to_string(), serde_json::json!(head_seq)),
            ("child-b".to_string(), serde_json::json!(head_seq)),
        ]
        .into_iter()
        .collect(),
    );
    let reader = Db::open(&db_path).expect("open snapshot reader");
    let writer_path = db_path.clone();
    let batch = crate::http_api::task_events::read_legacy_parent_batch_for_test(
        &reader,
        "parent-1",
        &legacy_cursor,
        1,
        move || {
            let writer = Db::open(&writer_path).expect("open interleaving writer");
            writer
                .update_pipeline_item_parent("stranger", None)
                .expect("reparent between membership and candidate reads");
        },
    )
    .expect("snapshot batch");
    assert_eq!(
        event_pairs(&batch),
        vec![("stranger".to_string(), "stage.changed".to_string())],
        "the candidate read must use the membership snapshot, not the writer's newer state"
    );

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("reattach after snapshot");
    }
    let replay = get_json_body(
        &router,
        &format!(
            "/v1/task-events?parentTaskId=parent-1&cursor={}&timeoutSecs=0",
            cursor_of(&batch)
        ),
    )
    .await;
    assert!(
        event_pairs(&replay).is_empty(),
        "delivered adoptee replayed"
    );
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("stranger", "pr")
            .expect("future adoptee event");
    }
    let future = get_json_body(
        &router,
        &format!(
            "/v1/task-events?parentTaskId=parent-1&cursor={}&timeoutSecs=1",
            cursor_of(&replay)
        ),
    )
    .await;
    assert_eq!(
        event_pairs(&future),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );
}

#[tokio::test]
async fn legacy_p1_compaction_preserves_an_away_child_acknowledgement() {
    let (router, db_path) = parentage_router();
    let acknowledged_seq = {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("first retained adoptee event");
        db.update_pipeline_item_stage("stranger", "pr")
            .expect("second retained adoptee event");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("acknowledged established child event");
        db.latest_task_event_seq().expect("event head")
    };
    let legacy_cursor = legacy_parent_cursor(
        "parent-1",
        [
            ("child-a".to_string(), serde_json::json!(acknowledged_seq)),
            ("child-b".to_string(), serde_json::json!(0)),
        ]
        .into_iter()
        .collect(),
    );
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("child-a", None)
            .expect("reparent acknowledged child away");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt child with retained events");
    }
    let watch = "/v1/task-events?parentTaskId=parent-1&limit=1&timeoutSecs=0";
    let first = get_json_body(&router, &format!("{watch}&cursor={legacy_cursor}")).await;
    assert!(cursor_of(&first).starts_with("p1."));
    let second = get_json_body(&router, &format!("{watch}&cursor={}", cursor_of(&first))).await;
    assert!(cursor_of(&second).starts_with("p3."));
    assert_eq!(event_pairs(&first).len() + event_pairs(&second).len(), 2);

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("child-a", Some("parent-1"))
            .expect("reattach acknowledged child");
    }
    let reattached =
        get_json_body(&router, &format!("{watch}&cursor={}", cursor_of(&second))).await;
    assert!(
        event_pairs(&reattached).is_empty(),
        "p3 compaction rewound the away child's acknowledgement"
    );
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "pr")
            .expect("new event after reattach");
    }
    let future = get_json_body(
        &router,
        &format!("{watch}&cursor={}", cursor_of(&reattached)),
    )
    .await;
    assert_eq!(
        event_pairs(&future),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );
}

#[tokio::test]
async fn legacy_p1_sparse_parent_ignores_large_unrelated_retained_history() {
    let (router, db_path) = parentage_router();
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("child-a", None)
            .expect("remove first established child");
        db.update_pipeline_item_parent("child-b", None)
            .expect("remove second established child");
    }
    let conn = rusqlite::Connection::open(&db_path).expect("open bulk writer");
    conn.execute_batch(
        "WITH RECURSIVE generated(value) AS (
             SELECT 1 UNION ALL SELECT value + 1 FROM generated WHERE value < 20000
         )
         INSERT INTO task_event (task_id, type, payload)
         SELECT 'unrelated-retained', 'stage.changed', NULL FROM generated;",
    )
    .expect("insert unrelated retained history");
    drop(conn);
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt sparse child");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("append sparse parent event");
    }
    let cursor = legacy_parent_cursor("parent-1", serde_json::Map::new());
    let sparse = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={cursor}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&sparse),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", None)
            .expect("empty the parent scope");
    }
    let empty_cursor = legacy_parent_cursor("parent-1", serde_json::Map::new());
    let empty = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={empty_cursor}&timeoutSecs=0"),
    )
    .await;
    assert!(event_pairs(&empty).is_empty());
    assert!(cursor_of(&empty).starts_with("p3."));
}

#[tokio::test]
async fn legacy_p1_dense_parent_candidate_work_is_page_bounded() {
    let (_router, db_path) = parentage_router();
    let conn = rusqlite::Connection::open(&db_path).expect("open bulk writer");
    conn.execute_batch(
        "WITH RECURSIVE generated(value) AS (
             SELECT 1 UNION ALL SELECT value + 1 FROM generated WHERE value < 20000
         )
         INSERT INTO task_event (task_id, type, payload)
         SELECT 'child-a', 'stage.changed', NULL FROM generated;",
    )
    .expect("insert dense parent history");
    drop(conn);

    let cursor = legacy_parent_cursor("parent-1", serde_json::Map::new());
    let reader = Db::open(&db_path).expect("open bounded reader");
    let progress_calls = Arc::new(AtomicUsize::new(0));
    reader.count_test_sqlite_progress(100, Arc::clone(&progress_calls));
    let batch = crate::http_api::task_events::read_legacy_parent_batch_for_test(
        &reader,
        "parent-1",
        &cursor,
        500,
        || {},
    )
    .expect("bounded dense-parent batch");
    reader.clear_test_sqlite_progress_handler();

    assert_eq!(batch["events"].as_array().expect("events").len(), 500);
    assert_eq!(batch["hasMore"], serde_json::json!(true));
    let progress_calls = progress_calls.load(Ordering::Relaxed);
    assert!(
        progress_calls < 1_000,
        "one legacy page used at least {} SQLite VM instructions; candidate work likely \
         visited/sorted the full 20,000-event parent history",
        progress_calls * 100
    );
}

#[tokio::test]
async fn legacy_p1_future_state_is_rejected_before_candidate_work() {
    let (_router, db_path) = parentage_router();
    let future_cursors = [
        serde_json::json!({
            "parent_task_id": "parent-1",
            "watermarks": { "child-a": i64::MAX },
        }),
        serde_json::json!({
            "parent_task_id": "parent-1",
            "watermarks": {},
            "event_seq": i64::MAX,
        }),
    ]
    .map(|payload| {
        format!(
            "p1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    });
    let reader = Db::open(&db_path).expect("open snapshot reader");

    for cursor in future_cursors {
        let error = crate::http_api::task_events::read_legacy_parent_batch_for_test(
            &reader,
            "parent-1",
            &cursor,
            500,
            || panic!("future cursor reached membership/candidate work"),
        )
        .expect_err("future p1 cursor must be rejected");
        assert_eq!(
            error,
            "cursor is not a valid cursor returned by this endpoint"
        );
    }
}

#[tokio::test]
async fn parent_cursor_rejects_oversized_and_future_state() {
    let (router, _db_path) = parentage_router();

    let oversized = format!(
        "/v1/task-events?parentTaskId=parent-1&cursor={}&timeoutSecs=0",
        "x".repeat(33 * 1024)
    );
    let response = router
        .clone()
        .oneshot(Request::get(oversized).body(Body::empty()).unwrap())
        .await
        .expect("oversized cursor request");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .expect("bounded error body");
    assert!(
        body.len() < 256,
        "an invalid cursor must not be echoed back"
    );

    let too_many_watermarks = (0..501)
        .map(|index| (format!("forged-{index}"), serde_json::json!(0)))
        .collect::<serde_json::Map<_, _>>();
    let oversized_map_cursor = format!(
        "p1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "parent_task_id": "parent-1",
                "watermarks": too_many_watermarks,
            })
            .to_string()
        )
    );
    let response = router
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/task-events?parentTaskId=parent-1&cursor={oversized_map_cursor}&timeoutSecs=0"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .expect("oversized p1 request");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let future_cursor = format!(
        "p3.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "parent_task_id": "parent-1",
                "event_seq": i64::MAX,
            })
            .to_string()
        )
    );
    let response = router
        .oneshot(
            Request::get(format!(
                "/v1/task-events?parentTaskId=parent-1&cursor={future_cursor}&timeoutSecs=0"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .expect("future p3 request");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn drained_parent_cursor_advances_past_large_unrelated_history() {
    let (router, db_path) = parentage_router();
    let initial = get_json_body(
        &router,
        "/v1/task-events?parentTaskId=parent-1&timeoutSecs=0",
    )
    .await;
    let initial_cursor = cursor_of(&initial);

    let conn = rusqlite::Connection::open(&db_path).expect("open db");
    conn.execute_batch(
        "WITH RECURSIVE generated(value) AS (
                 SELECT 1
                 UNION ALL
                 SELECT value + 1 FROM generated WHERE value < 10000
             )
             INSERT INTO task_event (task_id, type, payload)
             SELECT 'stranger', 'stage.changed', NULL FROM generated;",
    )
    .expect("insert unrelated retained history");
    let head: i64 = conn
        .query_row("SELECT MAX(seq) FROM task_event", [], |row| row.get(0))
        .expect("read head");
    drop(conn);

    let drained = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={initial_cursor}&timeoutSecs=0"),
    )
    .await;
    assert!(event_pairs(&drained).is_empty());
    let cursor = cursor_of(&drained);
    assert!(cursor.starts_with("p3."));
    assert!(cursor.len() < 128, "cursor must stay constant-size");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.strip_prefix("p3.").expect("p3 cursor"))
        .expect("decode p3 cursor");
    let payload: Value = serde_json::from_slice(&decoded).expect("parse p3 cursor");
    assert_eq!(payload["event_seq"], serde_json::json!(head));

    let rechecked = get_json_body(
        &router,
        &format!("/v1/task-events?parentTaskId=parent-1&cursor={cursor}&timeoutSecs=0"),
    )
    .await;
    assert!(event_pairs(&rechecked).is_empty());
    assert_eq!(cursor_of(&rechecked), cursor);
}

/// Parent pages use the same opaque cursor for both continuation and scope
/// binding. Draining a small page size must lose/replay nothing, and that
/// cursor must not be accepted by another parent or a fixed task/repo scope.
#[tokio::test]
async fn parent_scope_paginates_without_replay_and_binds_opaque_cursor() {
    let (router, db_path) = parentage_router();
    {
        let db = Db::open(&db_path).expect("open db");
        start_run(&db, "run-a1", "child-a", "in progress");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("advance first child");
        start_run(&db, "run-b1", "child-b", "in progress");
        db.update_pipeline_item_stage("child-b", "review")
            .expect("advance second child");
    }

    let first = get_json_body(
        &router,
        "/v1/task-events?parentTaskId=parent-1&limit=2&timeoutSecs=1",
    )
    .await;
    assert_eq!(first["hasMore"], serde_json::json!(true));
    let parent_cursor = cursor_of(&first);

    let second = get_json_body(
        &router,
        &format!(
            "/v1/task-events?parentTaskId=parent-1&limit=2&cursor={parent_cursor}&timeoutSecs=1"
        ),
    )
    .await;
    assert_eq!(second["hasMore"], serde_json::json!(false));
    let delivered = event_pairs(&first)
        .into_iter()
        .chain(event_pairs(&second))
        .collect::<Vec<_>>();
    assert_eq!(
        delivered,
        vec![
            ("child-a".to_string(), "run.started".to_string()),
            ("child-a".to_string(), "stage.changed".to_string()),
            ("child-b".to_string(), "run.started".to_string()),
            ("child-b".to_string(), "stage.changed".to_string()),
        ]
    );

    let drained_cursor = cursor_of(&second);
    let drained = get_json_body(
        &router,
        &format!(
            "/v1/task-events?parentTaskId=parent-1&limit=2&cursor={drained_cursor}&timeoutSecs=0"
        ),
    )
    .await;
    assert_eq!(drained["waitOutcome"], serde_json::json!("timeout"));
    assert!(event_pairs(&drained).is_empty());

    for path in [
        format!("/v1/task-events?parentTaskId=stranger&cursor={drained_cursor}&timeoutSecs=0"),
        format!("/v1/task-events?taskIds=child-a&cursor={drained_cursor}&timeoutSecs=0"),
        format!("/v1/task-events?repoId=repo-events&cursor={drained_cursor}&timeoutSecs=0"),
    ] {
        let response = router
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .expect("request");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

fn seed_high_cardinality_parent(db: &Db) {
    db.insert_test_repo("repo-many-children", "Many Children")
        .expect("insert repo");
    db.insert_test_pipeline_item(
        "parent-many",
        "repo-many-children",
        "parent",
        Some("parent"),
        "in progress",
        "2026-07-29 00:00:00",
    )
    .expect("insert parent");
    for index in 0..1_100 {
        let child_id = format!("child-{index:04}");
        db.insert_test_pipeline_item(
            &child_id,
            "repo-many-children",
            "child",
            Some(&child_id),
            "in progress",
            "2026-07-29 00:01:00",
        )
        .expect("insert child");
        db.update_pipeline_item_parent(&child_id, Some("parent-many"))
            .expect("set parent");
    }
}

/// SQLite's bundled expression depth is lower than a realistic fan-out. The
/// parent query must remain one bounded relational statement instead of
/// compiling one predicate per child, including when its opaque cursor is fed
/// back on the next long-poll recheck.
#[tokio::test]
async fn parent_scope_handles_more_children_than_sqlite_expression_depth() {
    let state = test_state_with_seed(
        "desktop-many-task-events",
        "Many Task Events",
        seed_high_cardinality_parent,
    );
    let db_path = state.config().db_path.clone();
    let router = router(state);
    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-1099", "review")
            .expect("append event");
    }

    let first = get_json_body(
        &router,
        "/v1/task-events?parentTaskId=parent-many&limit=1&timeoutSecs=1",
    )
    .await;
    assert_eq!(
        event_pairs(&first),
        vec![("child-1099".to_string(), "stage.changed".to_string())]
    );
    assert_eq!(first["hasMore"], serde_json::json!(false));
    assert!(
        cursor_of(&first).len() < 512,
        "the opaque cursor must not grow with all 1,100 children"
    );

    let drained = get_json_body(
        &router,
        &format!(
            "/v1/task-events?parentTaskId=parent-many&limit=1&cursor={}&timeoutSecs=0",
            cursor_of(&first)
        ),
    )
    .await;
    assert_eq!(drained["waitOutcome"], serde_json::json!("timeout"));
    assert!(event_pairs(&drained).is_empty());
}

/// Scope precedence, stated once so neither client has to guess: named ids beat
/// the parent scope, the parent scope beats the repo, and asking for none of
/// them is refused rather than answered with everything.
#[tokio::test]
async fn parent_scope_sits_between_named_ids_and_the_whole_repo() {
    let (router, db_path) = parentage_router();

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("advance child stage");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("advance stranger stage");
    }

    // Named ids win: the parent scope does not widen an explicit id list.
    let named = get_json_body(
        &router,
        "/v1/task-events?taskIds=stranger&parentTaskId=parent-1&timeoutSecs=1",
    )
    .await;
    assert_eq!(
        event_pairs(&named),
        vec![("stranger".to_string(), "stage.changed".to_string())]
    );

    // The parent scope wins over the repo: the sibling's event is not in it.
    let parented = get_json_body(
        &router,
        "/v1/task-events?parentTaskId=parent-1&repoId=repo-events&timeoutSecs=1",
    )
    .await;
    assert_eq!(
        event_pairs(&parented),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );

    // Branch names resolve here too, or a watcher holding a branch would
    // silently observe an empty feed.
    let by_branch = get_json_body(
        &router,
        "/v1/task-events?parentTaskId=branch-parent-1&timeoutSecs=1",
    )
    .await;
    assert_eq!(
        event_pairs(&by_branch),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );

    let unknown_parent = router
        .clone()
        .oneshot(
            Request::get("/v1/task-events?parentTaskId=nope&timeoutSecs=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(unknown_parent.status(), StatusCode::NOT_FOUND);

    // A parent with no children is an empty feed, not an error: a fan-out that
    // has not dispatched yet must be able to start watching first.
    let childless = get_json_body(
        &router,
        "/v1/task-events?parentTaskId=stranger&timeoutSecs=1",
    )
    .await;
    assert_eq!(childless["waitOutcome"], serde_json::json!("timeout"));
    assert_eq!(event_pairs(&childless), Vec::new());
}

#[tokio::test]
async fn task_ids_accept_branch_names_and_reject_unknown_tasks() {
    let (router, db_path) = events_router();

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("advance stage");
    }

    // Branch names resolve, as everywhere else a task id is accepted.
    let body = get_json_body(
        &router,
        "/v1/task-events?taskIds=branch-child-a&timeoutSecs=1",
    )
    .await;
    assert_eq!(
        event_pairs(&body),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );

    let unknown = router
        .clone()
        .oneshot(
            Request::get("/v1/task-events?taskIds=child-a,nope&timeoutSecs=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    let unscoped = router
        .clone()
        .oneshot(
            Request::get("/v1/task-events?timeoutSecs=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(unscoped.status(), StatusCode::BAD_REQUEST);
}

/// The daemon reports `waiting` when an agent CLI has rendered a prompt it is
/// parked on. That is the one state `activity` cannot express — it folds
/// waiting into idle — so the event is the only way an orchestrator learns a
/// child needs an answer.
#[tokio::test]
async fn a_task_parked_on_a_prompt_emits_awaiting_input_once_per_block() {
    let (router, db_path) = events_router();
    let db = Db::open(&db_path).expect("open db");

    db.update_pipeline_item_runtime_status("child-a", "busy", None)
        .expect("busy");
    db.update_pipeline_item_runtime_status(
        "child-a",
        "waiting",
        Some("How should I publish the fix?"),
    )
    .expect("waiting");
    // A repeated report of the same state is not a new block.
    db.update_pipeline_item_runtime_status("child-a", "waiting", Some("How should I publish?"))
        .expect("waiting again");

    let body = get_json_body(&router, "/v1/task-events?taskIds=child-a&timeoutSecs=1").await;
    let events = body["events"].as_array().expect("events");
    assert_eq!(event_pairs(&body).len(), 1);
    assert_eq!(events[0]["type"], serde_json::json!("task.awaiting_input"));
    assert_eq!(
        events[0]["payload"]["prompt"],
        serde_json::json!("How should I publish the fix?")
    );

    // Answering it and blocking again is a second, separate block.
    db.update_pipeline_item_runtime_status("child-a", "busy", None)
        .expect("busy again");
    db.update_pipeline_item_runtime_status("child-a", "waiting", Some("Anything else?"))
        .expect("waiting a second time");
    let next = get_json_body(
        &router,
        &format!(
            "/v1/task-events?taskIds=child-a&timeoutSecs=1&cursor={}",
            cursor_of(&body)
        ),
    )
    .await;
    assert_eq!(
        event_pairs(&next),
        vec![("child-a".to_string(), "task.awaiting_input".to_string())]
    );
}

/// PTY providers do not all expose a structured "needs input" signal. Codex,
/// for example, returns to its ordinary idle prompt after printing a design
/// approval question. The weaker activity edge must still be observable, with
/// the same transcript tail task detail exposes, without pretending it was a
/// daemon-confirmed interactive prompt.
#[tokio::test]
async fn every_working_task_stopping_emits_one_activity_changed_event() {
    let (router, db_path) = events_router();
    let db = Db::open(&db_path).expect("open db");

    for (task_id, activity, prompt) in [
        (
            "child-a",
            "unread",
            Some("Does this design have your approval?"),
        ),
        ("child-b", "idle", Some("Choose the deployment target.")),
        ("child-c", "unread", None),
    ] {
        if let Some(prompt) = prompt {
            db.update_pipeline_item_waiting_prompt(task_id, prompt)
                .expect("persist prompt");
        }
        db.update_pipeline_item_activity(task_id, "working")
            .expect("working");
        db.update_pipeline_item_activity(task_id, activity)
            .expect("stopped");
        // Repeating the stored state is not another transition.
        db.update_pipeline_item_activity(task_id, activity)
            .expect("same stopped state");
    }

    let started = std::time::Instant::now();
    let body = get_json_body(
        &router,
        "/v1/task-events?taskIds=child-a,child-b,child-c&timeoutSecs=15",
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a cursor-less wait must drain retained stopped edges immediately"
    );
    let events = body["events"].as_array().expect("events");
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0]["type"],
        serde_json::json!("task.activity_changed")
    );
    assert_eq!(events[0]["payload"]["previousActivity"], "working");
    assert_eq!(events[0]["payload"]["activity"], "unread");
    assert_eq!(
        events[0]["payload"]["waitingPromptSnippet"],
        "Does this design have your approval?"
    );
    assert_eq!(
        events[1]["type"],
        serde_json::json!("task.activity_changed")
    );
    assert_eq!(events[1]["payload"]["previousActivity"], "working");
    assert_eq!(events[1]["payload"]["activity"], "idle");
    assert_eq!(
        events[1]["payload"]["waitingPromptSnippet"],
        "Choose the deployment target."
    );
    assert_eq!(
        events[2]["type"],
        serde_json::json!("task.activity_changed")
    );
    assert_eq!(events[2]["payload"]["previousActivity"], "working");
    assert_eq!(events[2]["payload"]["activity"], "unread");
    assert!(
        events[2]["payload"]
            .as_object()
            .expect("activity payload")
            .get("waitingPromptSnippet")
            .is_none(),
        "an empty prompt must be omitted rather than serialized as null"
    );
}

/// `notifyTaskId` used to be creation-time only, so an orchestrator could not
/// subscribe to a task it had adopted rather than created.
///
/// Retargeting is pure pipeline-item state: the seeded tasks have no
/// workspace, no terminal session, and no stage run, so this also pins that a
/// task which has not started its first stage can still be retargeted.
#[tokio::test]
async fn notify_target_can_be_attached_and_cleared_after_creation() {
    let (router, db_path) = events_router();
    {
        let db = Db::open(&db_path).expect("open db");
        assert!(db
            .get_task_worktree_path("child-a")
            .expect("worktree")
            .is_none());
        assert!(db.latest_stage_run("child-a").expect("stage run").is_none());
    }

    let response = router
        .clone()
        .oneshot(
            Request::post("/v1/tasks/child-a/actions/set-notify")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"notifyTaskId":"child-b"}"#))
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);

    let db = Db::open(&db_path).expect("open db");
    assert_eq!(
        db.get_pipeline_item("child-a")
            .expect("get task")
            .expect("task exists")
            .notify_task_id
            .as_deref(),
        Some("child-b")
    );

    let cleared = router
        .clone()
        .oneshot(
            Request::post("/v1/tasks/child-a/actions/set-notify")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(cleared.status(), StatusCode::OK);
    assert!(db
        .get_pipeline_item("child-a")
        .expect("get task")
        .expect("task exists")
        .notify_task_id
        .is_none());

    let self_notify = router
        .clone()
        .oneshot(
            Request::post("/v1/tasks/child-a/actions/set-notify")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"notifyTaskId":"child-a"}"#))
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(self_notify.status(), StatusCode::BAD_REQUEST);
}

/// A closed task will never fire another completion notification, so
/// retargeting it is refused — but with a message that names the reason. The
/// zero-row update behind this route used to surface as `db error: not
/// found`, which reads as "no such task" and sent callers hunting for the
/// wrong problem.
#[tokio::test]
async fn retargeting_a_closed_task_reports_that_it_is_closed() {
    let (router, db_path) = events_router();
    Db::open(&db_path)
        .expect("open db")
        .close_pipeline_item("child-a")
        .expect("close task");

    let response = router
        .oneshot(
            Request::post("/v1/tasks/child-a/actions/set-notify")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"notifyTaskId":"child-b"}"#))
                .unwrap(),
        )
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(
        String::from_utf8_lossy(&body).as_ref(),
        "task is closed: child-a"
    );
}

/// A task that already notified one parent must notify a newly attached one:
/// otherwise adopting a finished-once task silently subscribes to nothing.
#[tokio::test]
async fn attaching_a_new_notify_target_rearms_the_notification() {
    let (_router, db_path) = events_router();
    let db = Db::open(&db_path).expect("open db");

    db.update_pipeline_item_notify_task("child-a", Some("child-b"))
        .expect("set notify");
    db.claim_task_notification("child-a")
        .expect("claim")
        .expect("notification claimed");
    assert!(db
        .claim_task_notification("child-a")
        .expect("claim again")
        .is_none());

    db.update_pipeline_item_notify_task("child-a", Some("child-c"))
        .expect("retarget notify");
    let claimed = db
        .claim_task_notification("child-a")
        .expect("claim")
        .expect("notification claimed for the new target");
    assert_eq!(claimed.notify_task_id, "child-c");
}
