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

    // The stranger emits an event while outside the subtree, then the parent
    // gets an empty batch. The cursor may advance the current children, but it
    // has no watermark for the stranger, so that retained event becomes
    // relevant if the task is adopted before the next call.
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
        get_json_body(&router, &format!("{watch}&cursor={cursor}&timeoutSecs=1")).await;
    assert_eq!(
        event_pairs(&after_adoption),
        vec![
            ("stranger".to_string(), "stage.changed".to_string()),
            ("stranger".to_string(), "stage.changed".to_string()),
        ],
        "a task adopted after a timeout must surface all retained pre-adoption events"
    );
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

    // Replayed from the beginning: the parent's own stage change is still
    // absent, and the adopted task's pre-adoption event now matches the scope —
    // parentage is evaluated as it stands, not as it stood when the event fired.
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

/// A parent cursor cannot be one global sequence: an outside task can emit at
/// N, an existing child can emit at N+1 and advance that watermark, and the
/// outside task can then be adopted. Its retained event at N must still be
/// delivered without replaying the existing child's event at N+1.
#[tokio::test]
async fn parent_cursor_keeps_older_retained_events_for_a_later_adoptee() {
    let (router, db_path) = parentage_router();
    let watch = "/v1/task-events?parentTaskId=parent-1";

    let initial = get_json_body(&router, &format!("{watch}&timeoutSecs=0")).await;
    assert!(event_pairs(&initial).is_empty());
    let initial_cursor = cursor_of(&initial);

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_stage("stranger", "review")
            .expect("outside task emits at N");
        db.update_pipeline_item_stage("child-a", "review")
            .expect("existing child emits at N+1");
    }

    let before_adoption = get_json_body(
        &router,
        &format!("{watch}&cursor={initial_cursor}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&before_adoption),
        vec![("child-a".to_string(), "stage.changed".to_string())]
    );
    let child_seq = before_adoption["events"][0]["seq"]
        .as_i64()
        .expect("child event seq");
    let cursor_after_child = cursor_of(&before_adoption);

    {
        let db = Db::open(&db_path).expect("open db");
        db.update_pipeline_item_parent("stranger", Some("parent-1"))
            .expect("adopt outside task");
    }

    let after_adoption = get_json_body(
        &router,
        &format!("{watch}&cursor={cursor_after_child}&timeoutSecs=1"),
    )
    .await;
    assert_eq!(
        event_pairs(&after_adoption),
        vec![("stranger".to_string(), "stage.changed".to_string())],
        "adoption must make the retained event at N eligible after N+1 was delivered"
    );
    let adopted_seq = after_adoption["events"][0]["seq"]
        .as_i64()
        .expect("adopted event seq");
    assert_eq!(
        adopted_seq + 1,
        child_seq,
        "the regression requires the outside event at N immediately before the child at N+1"
    );
}

/// Servers before the per-child cursor shipped returned a numeric sequence for
/// parent scopes. An agent can carry that cursor across an upgrade, so the
/// first new-server response must neither replay acknowledged events nor keep
/// returning a numeric cursor that cannot preserve later adoption semantics.
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
    assert!(opaque_cursor.starts_with("p2."));

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
async fn legacy_p1_parent_cursor_drains_without_replay_then_compacts_to_p2() {
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
    assert!(cursor_of(&upgraded).starts_with("p2."));
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
