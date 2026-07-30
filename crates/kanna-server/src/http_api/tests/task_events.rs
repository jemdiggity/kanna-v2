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
use serde_json::Value;
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

async fn get_json_body(router: &Router, uri: &str) -> Value {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK, "GET {uri}");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
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

/// `notifyTaskId` used to be creation-time only, so an orchestrator could not
/// subscribe to a task it had adopted rather than created.
#[tokio::test]
async fn notify_target_can_be_attached_and_cleared_after_creation() {
    let (router, db_path) = events_router();

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
