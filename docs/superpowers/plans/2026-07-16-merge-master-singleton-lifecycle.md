# Merge Master Singleton Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one open merge-master task per repository across successful and failed merge turns.

**Architecture:** Define singleton identity by the open `pipeline_item` and its latest agent-bound `stage_run`, not by whether that run is currently running. The signal route reuses the latest persisted daemon session until the task is explicitly closed, after which the existing creation path may create a replacement.

**Tech Stack:** Rust, Axum, rusqlite, Tokio, `kanna-daemon` protocol tests

---

## File Structure

- `crates/kanna-server/src/http_api/tests/input.rs`: route-level regression tests for signaling open singleton tasks after completed turns.
- `crates/kanna-server/src/db/tests.rs`: focused database coverage for excluding explicitly closed singleton tasks.
- `crates/kanna-server/src/db/mod.rs`: rename the lookup result type so its name no longer implies a running turn.
- `crates/kanna-server/src/db/pipeline_items.rs`: change singleton lookup semantics to use the latest agent-bound run of an open task.
- `crates/kanna-server/src/http_api/signal_agent.rs`: call the lifecycle-based lookup name.

### Task 1: Add completed-turn regression coverage

**Files:**
- Modify: `crates/kanna-server/src/http_api/tests/input.rs`

- [x] **Step 1: Generalize the existing reuse test around a run status**

Rename the existing test body and parameterize the inserted run status with
this patch:

```diff
-#[tokio::test]
-async fn signal_agent_route_sends_message_to_open_running_agent_task() {
+async fn assert_signal_agent_reuses_open_task_with_run_status(run_status: &'static str) {
@@
-        status: "running",
+        status: run_status,
```

Expose the current behavior and the two completed-turn regressions through separate tests:

```rust
#[tokio::test]
async fn signal_agent_route_sends_message_to_open_running_agent_task() {
    assert_signal_agent_reuses_open_task_with_run_status("running").await;
}

#[tokio::test]
async fn signal_agent_route_reuses_open_agent_task_after_successful_turn() {
    assert_signal_agent_reuses_open_task_with_run_status("succeeded").await;
}

#[tokio::test]
async fn signal_agent_route_reuses_open_agent_task_after_failed_turn() {
    assert_signal_agent_reuses_open_task_with_run_status("failed").await;
}
```

- [x] **Step 2: Run the successful-turn regression and verify RED**

Run:

```bash
cargo test -p kanna-server signal_agent_route_reuses_open_agent_task_after_successful_turn -- --nocapture
```

Expected: FAIL because the endpoint does not find the `succeeded` run and enters the task-creation path instead of sending `Input` to `merge-session`.

- [x] **Step 3: Run the failed-turn regression and verify RED**

Run:

```bash
cargo test -p kanna-server signal_agent_route_reuses_open_agent_task_after_failed_turn -- --nocapture
```

Expected: FAIL for the same reason with a `failed` run.

### Task 2: Make lookup follow the open-task lifecycle

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs:291`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs:1,270-295`
- Modify: `crates/kanna-server/src/http_api/signal_agent.rs:39-40`

- [x] **Step 1: Rename the lookup result type**

In `db/mod.rs`, replace the status-specific name:

```rust
pub struct OpenAgentTask {
    pub task_id: String,
    pub session_id: String,
}
```

Update the import and constructor in `db/pipeline_items.rs` from `RunningAgentTask` to `OpenAgentTask`.

- [x] **Step 2: Implement the minimal lifecycle-based query**

Rename the database method to `find_open_agent_task` and remove only the run-status predicate:

```rust
pub fn find_open_agent_task(
    &self,
    repo_id: &str,
    agent: &str,
) -> Result<Option<OpenAgentTask>, rusqlite::Error> {
    self.conn
        .query_row(
            "SELECT p.id, COALESCE(NULLIF(sr.session_id, ''), p.id)
             FROM pipeline_item p
             JOIN stage_run sr ON sr.task_id = p.id
             WHERE p.repo_id = ?
               AND p.closed_at IS NULL
               AND sr.agent = ?
             ORDER BY datetime(sr.started_at) DESC, sr.id DESC
             LIMIT 1",
            (repo_id, agent),
            |row| {
                Ok(OpenAgentTask {
                    task_id: row.get(0)?,
                    session_id: row.get(1)?,
                })
            },
        )
        .optional()
}
```

In `signal_agent.rs`, call `db.find_open_agent_task(&repo_id, &agent)`.

- [x] **Step 3: Run all three reuse tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server signal_agent_route_ -- --nocapture
```

Expected: the running, succeeded, and failed reuse tests pass, along with the absent-task and detached-spawn signal tests.

### Task 3: Lock explicit-close replacement semantics

**Files:**
- Modify: `crates/kanna-server/src/db/tests.rs`

- [x] **Step 1: Add a focused closed-task lookup test**

Add:

```rust
#[test]
fn find_open_agent_task_ignores_closed_singleton() {
    let path = Db::test_db_path("closed-singleton-agent");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "task-merge",
        "repo-1",
        "Merge master",
        Some("Merge Master"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .expect("task");
    db.insert_stage_run(NewStageRun {
        id: "run-merge",
        task_id: "task-merge",
        stage: "in progress",
        kind: "main",
        agent: Some("merge"),
        agent_provider: Some("claude"),
        model: None,
        status: "succeeded",
        result: None,
        feedback: None,
        session_id: Some("merge-session"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .expect("run");
    db.set_test_pipeline_item_closed_at("task-merge", "2026-07-01T01:00:00Z")
        .expect("close task");

    assert!(db
        .find_open_agent_task("repo-1", "merge")
        .expect("lookup")
        .is_none());

    let _ = std::fs::remove_file(path);
}
```

- [x] **Step 2: Run the close-semantics test**

Run:

```bash
cargo test -p kanna-server find_open_agent_task_ignores_closed_singleton -- --nocapture
```

Expected: PASS, proving that `closed_at` remains the replacement boundary.

### Task 4: Verify the focused change and repository health

**Files:**
- Verify only

- [x] **Step 1: Format and inspect the patch**

Run:

```bash
cargo fmt --all -- --check
git diff --check
git diff -- crates/kanna-server/src/db/mod.rs crates/kanna-server/src/db/pipeline_items.rs crates/kanna-server/src/http_api/signal_agent.rs crates/kanna-server/src/http_api/tests/input.rs crates/kanna-server/src/db/tests.rs
```

Expected: formatting and whitespace checks pass; the diff contains only the lifecycle lookup, naming, and regression coverage.

- [x] **Step 2: Run the package test suite**

Run:

```bash
cargo test -p kanna-server
```

Expected: all `kanna-server` tests pass.

- [x] **Step 3: Run the canonical Rust verification if time permits**

Run:

```bash
./kd test rust
```

Expected: all canonical Rust checks pass.

Do not commit in this stage; Kanna's later workflow stage owns the commit.
