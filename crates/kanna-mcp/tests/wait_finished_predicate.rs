//! `kanna_wait_task(until: "finished")` decided "finished" from
//! `pipeline_item.activity == 'unread'` alone. An agent that finishes and
//! settles to `idle` never passes through `unread`, so a wait on it burned its
//! whole window and reported a timeout for a task that had carried a terminal
//! `stage_run` for minutes — and a caller looping on that predicate waits
//! forever, unable to tell "still working" from "finished".
//!
//! Observed on 2026-08-13 during a `specialized-reviewers` review: child task
//! `de752098` recorded a terminal `failed` run at 22:01:48Z, and two successive
//! waits — one started before that moment with a 600s window — both returned
//! "timed out waiting for task de752098". The four sibling children that
//! settled to `unread` all resolved.
//!
//! The predicate now keys on the terminal `stage_run`, a database fact, with
//! `activity` only a secondary signal. That correction is only meaningful
//! end to end: the run is written by `kanna-server` into SQLite and read back
//! by `kanna-mcp` over HTTP, so the whole chain runs here rather than a mock.
//! See `common/mod.rs` for the harness.

mod common;

use common::{seed_stage_run, seed_task, start_bare_chain};
use serde_json::{json, Value};
use std::time::Duration;

/// Long enough that a wait which resolves has to have resolved on the
/// predicate, short enough that a wait which does not resolve fails the test
/// quickly instead of hanging it.
const WAIT_SECS: u64 = 5;

fn wait_arguments(task_id: &str) -> Value {
    json!({
        "task_id": task_id,
        "timeout_secs": WAIT_SECS,
        "poll_secs": 1,
        "until": "finished",
    })
}

/// A wait may legitimately block for its whole window, so the receive budget
/// has to clear that window plus process overhead.
fn recv_budget() -> Duration {
    Duration::from_secs(WAIT_SECS + 30)
}

#[tokio::test]
async fn a_finished_task_that_settled_to_idle_resolves_instead_of_timing_out() {
    let task_id = "task-finished-idle";
    let (server, _daemon, mut mcp) = start_bare_chain("finished-idle").await;
    // The exact shape of the child that hung the dispatcher: the agent stopped
    // and its verdict is recorded, but the activity flag settled to `idle`
    // rather than passing through `unread`.
    seed_task(&server, task_id, "idle").await;
    seed_stage_run(&server, task_id, "run-terminal", "failed").await;

    mcp.call_tool(2, "kanna_wait_task", wait_arguments(task_id));
    let result = mcp.recv_task_within(recv_budget());

    assert_eq!(
        result["waitOutcome"],
        json!("resolved"),
        "a task whose latest stage run is terminal has finished, whatever the \
         activity flag settled to: {result}"
    );
    assert_eq!(result["activity"], json!("idle"), "{result}");
    assert_eq!(result["latestRun"]["status"], json!("failed"), "{result}");
}

#[tokio::test]
async fn a_finished_task_that_settled_to_unread_still_resolves() {
    let task_id = "task-finished-unread";
    let (server, _daemon, mut mcp) = start_bare_chain("finished-unread").await;
    // The settling path that always worked. It has to keep working: the fix
    // changes which fact is authoritative, not which tasks count as finished.
    seed_task(&server, task_id, "unread").await;
    seed_stage_run(&server, task_id, "run-terminal", "succeeded").await;

    mcp.call_tool(2, "kanna_wait_task", wait_arguments(task_id));
    let result = mcp.recv_task_within(recv_budget());

    assert_eq!(result["waitOutcome"], json!("resolved"), "{result}");
    assert_eq!(
        result["latestRun"]["status"],
        json!("succeeded"),
        "{result}"
    );
}

#[tokio::test]
async fn a_task_that_never_started_a_run_does_not_resolve_on_idle_alone() {
    let task_id = "task-never-started";
    let (server, _daemon, mut mcp) = start_bare_chain("never-started").await;
    // A task whose agent has not started yet is also `idle`. Widening the
    // activity set to include it — rather than keying on the terminal run —
    // would report this task as finished before it ever ran, which is why the
    // fix is the run and not a longer list of activity values.
    seed_task(&server, task_id, "idle").await;

    mcp.call_tool(2, "kanna_wait_task", wait_arguments(task_id));
    let result = mcp.recv_task_within(recv_budget());

    assert_eq!(
        result["waitOutcome"],
        json!("timeout"),
        "`idle` with no run at all is 'not started', not 'finished': {result}"
    );
}

#[tokio::test]
async fn a_running_task_does_not_resolve() {
    let task_id = "task-still-running";
    let (server, _daemon, mut mcp) = start_bare_chain("still-running").await;
    seed_task(&server, task_id, "working").await;
    seed_stage_run(&server, task_id, "run-live", "running").await;

    mcp.call_tool(2, "kanna_wait_task", wait_arguments(task_id));
    let result = mcp.recv_task_within(recv_budget());

    assert_eq!(
        result["waitOutcome"],
        json!("timeout"),
        "a live run is not a terminal one: {result}"
    );
}

/// The skew guard's whole point is that it reports on the *connected* server,
/// so the field has to actually survive the real `/v1/status` route and the
/// real allow-listing deserialization. A unit test of the diff cannot show
/// that: it would still pass if the server never emitted the field.
#[tokio::test]
async fn kanna_info_reports_no_skew_against_a_server_of_the_same_build() {
    let (_server, _daemon, mut mcp) = start_bare_chain("info-skew").await;

    mcp.call_tool(2, "kanna_info", json!({}));
    let info = mcp.recv_task_within(recv_budget());

    assert_eq!(
        info["agentApi"]["serverAdvertisesCapabilities"],
        json!(true),
        "a current server must advertise its agent-API surface: {info}"
    );
    assert_eq!(
        info["agentApi"]["status"],
        json!("current"),
        "a client and server built from the same tree are not skewed: {info}"
    );
    assert_eq!(info["agentApi"]["unavailableTools"], json!([]), "{info}");
}
