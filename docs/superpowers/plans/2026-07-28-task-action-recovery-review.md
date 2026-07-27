# Task Action Recovery Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable task-action retries, revision accounting, live-post dispatch, delayed spawn reconciliation, and KSP terminal routing safe across overlap, cancellation, crash recovery, and daemon lifecycle races.

**Architecture:** `task_action_request` becomes an explicit durable state machine with a process owner, an execution phase, and an optional recorded revision charge. HTTP handlers inspect completed/current-owner state before acquiring the process-local task flight, then run owned preparation and execution from cancellation-resistant tasks. Live spawn reconciliation is coordinated per run, uses targeted blocking DB/filesystem operations, lifecycle-fenced daemon probes, bounded jittered exponential backoff, and an AppState-owned shutdown signal.

**Tech Stack:** Rust, Tokio, Axum, rusqlite/SQLite, Kanna daemon JSON protocol, KSP WebSocket protocol.

---

### Task 1: Durable request ownership and flight ordering

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Modify: `crates/kanna-server/src/db/task_action_requests.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Test: `crates/kanna-server/src/http_api/tests/actions.rs`
- Modify: `packages/db/src/migrations/001_initial.sql`
- Test: `packages/db/src/migrations.test.ts`

- [ ] **Step 1: Write same-key pending and completed-key-during-unrelated-flight regressions**

  Extend the existing paused-claim HTTP fixture so the duplicate same key asserts `409` plus `Idempotency-Status: pending`, zero handler calls, and no durable reconciliation. Add a completed key, hold a different action's task flight, and assert the completed response still replays with its original body.

- [ ] **Step 2: Run the focused HTTP tests and verify both fail**

  Run: `cargo test -p kanna-server concurrent_same_key_replay completed_key_replays_during_unrelated_flight -- --nocapture`

  Expected: the live duplicate receives the generic task-flight conflict and/or the completed replay is hidden behind that flight.

- [ ] **Step 3: Add the durable execution state machine**

  Add migration `039_task_action_execution_phase` and initial/test schema columns:

  ```sql
  phase TEXT NOT NULL DEFAULT 'claimed'
    CHECK (phase IN ('claimed', 'preparing', 'successor_reserved', 'post_reserved')),
  owner_id TEXT,
  revision_round INTEGER
  ```

  Add DB operations that inspect/create a key without taking execution ownership, atomically acquire/take over `claimed` or stale `preparing` rows for one process owner, and report current-owner rows as pending. Preserve completed replay independently of local flights.

- [ ] **Step 4: Reorder the HTTP claim path**

  Give each `AppState` a stable process owner id. Inspect the durable key first; return completed/current-owner pending responses immediately. Acquire the task flight only for a new or recoverable request, then atomically persist `preparing` ownership before any blocking preparation. Never reconcile a current process owner's live request.

- [ ] **Step 5: Run DB and HTTP tests**

  Run: `cargo test -p kanna-server task_action_request -- --nocapture`

  Expected: all durable request and HTTP idempotency tests pass.

### Task 2: Crash-safe revision accounting and live-post dispatch

**Files:**
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/task_action_requests.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Test: `crates/kanna-server/src/db/tests.rs`
- Test: `crates/kanna-server/src/http_api/tests/revision_status.rs`
- Test: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] **Step 1: Write budget-gap, post-gap, and dropped-future regressions**

  Add DB/API tests that interrupt after a durable budget charge and prove replay returns the same recorded round without incrementing again. Add a live-post test that pauses after the post reservation and proves a retry cannot inject or advance twice. Add an HTTP test that drops the request future while blocking preparation is paused and proves the owned worker continues while a retry returns pending.

- [ ] **Step 2: Run the focused tests and verify they fail for the intended gaps**

  Run: `cargo test -p kanna-server revision_round_action live_post_reservation dropped_revision_http_future -- --nocapture`

  Expected: the budget increments twice, the post is not durable before input, or the dropped HTTP future exposes the request for re-execution.

- [ ] **Step 3: Couple revision charging to the request row**

  Replace the standalone agent budget increment with an immediate transaction that increments `pipeline_item.revision_rounds` and records the resulting round on the owned request. On replay, reuse the recorded round. Couple release/failure paths so a failed preparation cannot leave an untracked charge.

- [ ] **Step 4: Reserve live posts before daemon input**

  Add one guarded transaction that snapshots/finishes the source run, inserts a pending post run with its completion attempt, links the action request as `post_reserved`, and stores its replay response. Only after that transaction may input be sent. Successful input atomically starts the exact post and completes the request; session-not-found atomically restores the source before fallback; ambiguous delivery remains pending and cannot be resent or advanced.

- [ ] **Step 5: Make revision work cancellation-resistant**

  Spawn the owned preparation/transition worker before awaiting it, and move the task flight into that worker. Dropping the Axum request only drops the waiter; it does not cancel blocking preparation or expose the durable owner.

- [ ] **Step 6: Run focused revision, post, and action suites**

  Run: `cargo test -p kanna-server revision_status -- --nocapture`

  Run: `cargo test -p kanna-server dispatch_post -- --nocapture`

  Expected: all focused tests pass.

### Task 3: Owned and lifecycle-safe live spawn reconciliation

**Files:**
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: call sites in `crates/kanna-server/src/http_api/task_actions.rs` and `crates/kanna-server/src/http_api/tasks.rs`
- Test: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] **Step 1: Write lifecycle classification regressions**

  Add daemon fixtures for an exact run already listed as exited, exact Exit/removal between List and land, disappearance before the delayed probe, and an accepted legacy session whose List entry omits `run_id`. Assert only an active exact owned run lands; the legacy case remains pending.

- [ ] **Step 2: Write coordinator regressions**

  Assert duplicate starts for one run produce one probe owner, targeted lookup does not scan unrelated reservations, retries spread via bounded exponential delays, state-drop cancels the loop, and both land/rollback publish `StateChanged(Tasks)`.

- [ ] **Step 3: Run the focused reconciliation tests and verify failures**

  Run: `cargo test -p kanna-server late_spawn -- --nocapture`

  Expected: exited/legacy sessions are misclassified, duplicate loops start, or observers receive no task refresh.

- [ ] **Step 4: Implement targeted blocking reconciliation**

  Add `pending_stage_action(successor_run_id)` and use `spawn_blocking` for every SQLite, git, worktree, and filesystem operation. Add an AppState-owned coordinator that deduplicates run ids, supplies shutdown cancellation, and publishes task-state changes. Replace fixed cadence with bounded exponential backoff plus per-run jitter.

- [ ] **Step 5: Fence daemon lifecycle**

  Classify only `SessionState::Active` with the exact expected `run_id` as accepted. Subscribe to lifecycle events before List, reject an exact Exit/removal observed before landing, and perform a final ownership probe. Treat an ownershipless legacy accepted session as indeterminate instead of rolling it back.

- [ ] **Step 6: Run all task-creator tests**

  Run: `cargo test -p kanna-server task_creator::tests -- --nocapture`

  Expected: all task lifecycle tests pass.

### Task 4: KSP first-command routing

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Write first-input and first-resize transition regressions**

  Start an idle live-route control, transition the DB session before its first queued input/resize, publish a task state change, and assert the daemon receives the command for only the successor session.

- [ ] **Step 2: Run the focused KSP tests and verify failure**

  Run: `cargo test -p kanna-server terminal_control_first -- --nocapture`

  Expected: the first command targets the session resolved before the idle interval.

- [ ] **Step 3: Refresh while idle and immediately before first write**

  While waiting for the first command, consume task-state changes and refresh the cached session. After dequeuing that first command, resolve once more before connecting/writing so notification scheduling cannot route it to stale ownership.

- [ ] **Step 4: Run KSP tests**

  Run: `cargo test -p kanna-server ksp::tests -- --nocapture`

  Expected: KSP terminal routing and transport tests pass.

### Task 5: Full verification

**Files:**
- Review all modified files.

- [ ] **Step 1: Format**

  Run: `cargo fmt --all -- --check`

  Expected: exit 0.

- [ ] **Step 2: Run the server crate**

  Run: `cargo test -p kanna-server`

  Expected: exit 0.

- [ ] **Step 3: Run canonical Rust verification**

  Run: `./kd test rust`

  Expected: exit 0.

- [ ] **Step 4: Review the diff for scope and migration consistency**

  Run: `git diff --check && git status --short`

  Expected: no whitespace errors; only task-action recovery files and this plan are changed.
