//! A task carries two orthogonal facts — what its agent session is doing, and
//! whether a human has read its latest output — and `activity` blends them
//! into one display value. These tests drive the whole chain the split has to
//! hold across: a daemon fixture on the real daemon socket, a real
//! `kanna-server` (real SQLite, real HTTP surface), and a real `kanna-mcp`
//! (real stdio JSON-RPC, real catalog routing). See `common/mod.rs`.
//!
//! Two failures motivated them, both observed operationally:
//!
//! 1. A task blocked inside a long MCP call reported `unread`/`idle` while its
//!    agent was demonstrably busy, so external supervisors raised quiet alarms
//!    against running agents.
//! 2. `kanna_wait_task`'s `until: finished` resolved on `unread`, which is
//!    read state — so a wait for a task to finish could resolve on a task that
//!    was still working.

mod common;

use common::{
    await_stored_activity, await_stored_runtime_state, execute_sql, seed_stage_run, start_chain,
};
use serde_json::json;
use std::time::{Duration, Instant};

/// `start_chain` leaves the task classified `busy`, which is what a session
/// blocked inside a long tool or MCP call renders for its whole duration —
/// Claude's `esc to interrupt` chrome stays on screen while the request is
/// outstanding.
#[tokio::test]
async fn a_busy_agent_whose_output_nobody_read_reports_busy_on_the_runtime_dimension() {
    const TASK_ID: &str = "task-busy-unread";
    let (server, _daemon, mut mcp) = start_chain("busy-unread", TASK_ID).await;
    await_stored_runtime_state(&server, TASK_ID, "busy").await;
    seed_stage_run(&server, TASK_ID, "run-1", "running").await;

    // Several server writes flag output as unread without consulting the
    // runtime dimension — a parked revision, an orphaned workspace, a
    // cross-machine transfer. Any of them leaves a working agent displaying
    // `unread`; this stands in for them so the assertion is about what the two
    // dimensions report, not about which writer produced the divergence.
    execute_sql(
        &server,
        "UPDATE pipeline_item SET activity = 'unread' WHERE id = ?",
        json!([TASK_ID]),
    )
    .await;
    await_stored_activity(&server, TASK_ID, "unread").await;

    mcp.call_get_task(2, TASK_ID);
    let task = mcp.recv_task();
    assert_eq!(
        task["runtimeState"],
        json!("busy"),
        "the agent is running and the runtime dimension must say so: {task}"
    );
    assert_eq!(task["readState"], json!("unread"), "{task}");
    assert_eq!(
        task["activity"],
        json!("unread"),
        "the blended display value is exactly what a finished task shows, \
         which is why it cannot be the liveness signal: {task}"
    );

    // The wait a fan-out owner blocks on must not mistake unread output for a
    // finished agent.
    let started = Instant::now();
    mcp.call_tool(
        3,
        "kanna_wait_task",
        json!({ "task_id": TASK_ID, "timeout_secs": 3, "poll_secs": 1, "until": "finished" }),
    );
    let waited = mcp.recv_task_within(Duration::from_secs(60));
    assert_eq!(
        waited["waitOutcome"],
        json!("timeout"),
        "a busy agent has not finished, whatever its read state says: {waited}"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(3),
        "the wait must have run its window rather than resolving early"
    );
}

/// The case the old `unread` clause was standing in for: an agent that ends
/// without recording a verdict, which every manual-transition stage does. It
/// is now covered positively by the runtime dimension's terminal value.
#[tokio::test]
async fn a_wait_for_finished_resolves_when_the_agent_session_exits() {
    const TASK_ID: &str = "task-session-exit";
    let (server, daemon, mut mcp) = start_chain("session-exit", TASK_ID).await;
    await_stored_runtime_state(&server, TASK_ID, "busy").await;
    seed_stage_run(&server, TASK_ID, "run-1", "running").await;

    mcp.call_tool(
        2,
        "kanna_wait_task",
        json!({ "task_id": TASK_ID, "timeout_secs": 60, "poll_secs": 1, "until": "finished" }),
    );

    // The agent exits cleanly without recording a verdict. Its run is left
    // `cancelled`, which is deliberately not terminal — a rerun, resume, or
    // close passes through the same status on the way to a replacement run —
    // so the session ending is the only thing that can resolve this wait.
    tokio::time::sleep(Duration::from_millis(500)).await;
    daemon.exit(TASK_ID, 0);

    let waited = mcp.recv_task_within(Duration::from_secs(90));
    assert_eq!(
        waited["waitOutcome"],
        json!("resolved"),
        "a session that ended is a finished task: {waited}"
    );
    assert_eq!(waited["runtimeState"], json!("exited"), "{waited}");
    await_stored_runtime_state(&server, TASK_ID, "exited").await;
}
