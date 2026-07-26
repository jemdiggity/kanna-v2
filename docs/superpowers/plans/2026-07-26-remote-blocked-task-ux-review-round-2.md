# Remote Blocked Task UX Review Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daemon lag recovery deterministic, remote stage advancement owner-CAS protected and snapshot-confirmed, and blocker graph replacement transactionally atomic.

**Architecture:** Writer tasks notify a session recovery worker when a lagged mailbox drains. Owner snapshots publish the latest stage-run ID as a transition revision that viewers send back on advance and retain as pending until a new snapshot. Existing-task blocker mutation moves into one immediate SQLite transaction containing identity resolution, cycle validation, replacement, revision-trigger execution, and activity update.

**Tech Stack:** Rust, Tokio, rusqlite, Axum, Vue 3, TypeScript, Vitest, Tauri v2.

---

### Task 1: Signal-Driven Terminal Lag Recovery

**Files:**
- Modify: `crates/daemon/src/fanout.rs`
- Modify: `crates/daemon/src/output.rs`
- Modify: `crates/daemon/tests/reconnect.rs`

- [ ] **Step 1: Strengthen the failing integration probes**

Run the two existing tests repeatedly before production changes:

```bash
for i in 1 2 3 4 5; do
  cargo test -p kanna-daemon --test reconnect \
    overflowing_subscriber_resyncs_from_fresh_snapshot_without_delaying_healthy \
    -- --exact
  cargo test -p kanna-daemon --test reconnect \
    overflowing_observer_resyncs_with_fresh_snapshot_then_live_output \
    -- --exact
done
```

Expected before the fix: at least one timing-sensitive failure or evidence
that recovery is delayed until the 500 ms status tick.

- [ ] **Step 2: Add a unit regression for the drain notification**

Construct a small-budget `FanoutState`, overflow a registered subscriber,
drain its writer, and assert a `Notify`/generation signal is emitted when
`pending_bytes` becomes zero while `lagged` remains true.

- [ ] **Step 3: Run the new unit regression**

```bash
cargo test -p kanna-daemon fanout::tests::lagged_writer_notifies_when_mailbox_drains -- --exact
```

Expected: FAIL because writer tasks currently only decrement an atomic byte
counter and no recovery signal exists.

- [ ] **Step 4: Implement the recovery signal**

Add a session-scoped notification handle to `SessionFanout`, pass it to
subscriber writer tasks, and call `notify_one()` after a completed write makes
the pending byte count zero. In `output.rs`, select on that notification and
call the existing authoritative `resync_drained_subscribers` under the fanout
lock. Re-notify after snapshot failure when lagged subscribers remain drained.

- [ ] **Step 5: Verify daemon recovery**

Run the new unit test, both focused tests five times, then:

```bash
cargo test -p kanna-daemon --test reconnect
```

Expected: all tests pass without waiting for a later PTY chunk.

### Task 2: Owner-Enforced Remote Advance CAS

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/snapshot.rs`
- Modify: `crates/kanna-server/src/cloud_task_publisher.rs`
- Modify: `services/firebase-functions/src/types.ts`
- Modify: `services/relay/src/cloudTaskPublication.ts`
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `apps/desktop/src/utils/cloudTaskSnapshot.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.ts`
- Modify: `apps/desktop/src/workspace/types.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Test: adjacent Rust and TypeScript test files for each boundary

- [ ] **Step 1: Add viewer and transport regressions**

Add tests asserting:

```ts
await client.advanceStage({
  desktopId: "owner",
  taskId: "task",
  expectedTransitionRevision: "run-1",
});
```

serializes `{ expectedTransitionRevision: "run-1" }` through relay and LAN,
two UI retries before a new snapshot make one request, and a snapshot with
`transition_revision: "run-2"` permits the next advance.

- [ ] **Step 2: Run the TypeScript regressions**

```bash
pnpm --dir apps/desktop test --run \
  src/App.test.ts \
  src/services/desktopRelayTerminal.test.ts \
  src/services/desktopLanTerminal.test.ts
```

Expected: FAIL because advance options have no transition revision and the
viewer clears pending state when the request resolves.

- [ ] **Step 3: Add protocol and owner regressions**

Add Rust tests proving `expected_transition_revision` round-trips in
`ControlRequest::AdvancePeerTaskStage` and `PeerRequest::AdvanceTaskStage`,
reaches the owner HTTP JSON body, and causes `409 Conflict` when it differs
from `Db::latest_stage_run(task_id).id`. Include a replay after the first
request completes but before a viewer snapshot refresh.

- [ ] **Step 4: Run the Rust regressions**

```bash
cargo test -p task-transfer protocol:: -- --nocapture
cargo test -p task-transfer trusted_peer_advance_stage_posts_to_owner_kanna_server -- --exact
cargo test -p kanna-server http_api::tests::actions::stale_advance_transition_revision_is_rejected -- --exact
```

Expected: FAIL because the field and owner CAS validation do not exist.

- [ ] **Step 5: Publish and project the transition revision**

Select the latest stage-run ID in each snapshot item, publish it as optional
`transitionRevision`, validate it in the relay, and map it to
`PipelineItem.transition_revision` and `WorkspaceTaskSource`.

- [ ] **Step 6: Carry and enforce the CAS token**

Extend remote advance option and LAN control/peer request types with the
expected revision. Parse an `AdvanceStageRequest` JSON body in the owner route,
compare it to `latest_stage_run`, return `409` on mismatch, and only then
acquire/execute the existing single-flight transition.

- [ ] **Step 7: Keep viewer state pending until snapshot confirmation**

Replace the viewer in-flight `Set` with a map from owner/task to expected
transition revision. Do not clear it in `finally`; clear it only when the
authoritative workspace task disappears or exposes a different revision.

- [ ] **Step 8: Verify focused advance behavior**

Run the TypeScript and Rust commands from Steps 2 and 4 plus all adjacent
snapshot mapping tests. Expected: all pass.

### Task 3: Atomic Blocker Graph Replacement

**Files:**
- Modify: `crates/kanna-server/src/db/blockers.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Modify: `crates/kanna-server/src/http_api/task_blockers.rs`
- Modify: `crates/kanna-server/src/http_api/tasks.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`

- [ ] **Step 1: Add concurrent replacement and cycle regressions**

Use two `Db` connections and a barrier/fault hook to start inverse
replacements (`task-a -> task-b`, `task-b -> task-a`). Assert exactly one
commits and the final graph is acyclic. Add competing replacement tests on
one blocked task and assert the final set equals one complete request, never a
mixture.

- [ ] **Step 2: Add snapshot fault-injection coverage**

Pause a replacement after deleting old edges but before inserting new edges.
Start `ui_snapshot()` on a second connection and assert it returns only after
commit with the complete new edge set and its new `blocker_revision`, or reads
the complete old set if it began before the writer transaction.

- [ ] **Step 3: Run the new blocker regressions**

```bash
cargo test -p kanna-server db::tests::concurrent_blocker -- --nocapture
cargo test -p kanna-server db::tests::snapshot_never_observes_partial_blocker_replacement -- --exact
```

Expected: FAIL because identity/cycle checks, delete/inserts, activity, and
revision-trigger effects currently span independent autocommit statements.

- [ ] **Step 4: Implement one immediate transaction**

Add a typed blocker mutation error and:

```rust
pub fn replace_task_blockers_atomically(
    &self,
    task_or_branch_id: &str,
    blocker_task_ids: &[String],
) -> Result<String, ReplaceTaskBlockersError>
```

using `Transaction::new_unchecked(&self.conn,
TransactionBehavior::Immediate)`. Resolve identities, deduplicate, validate
self/cycles, delete, insert, update activity, and commit inside it. Add an
empty-list variant for unblock/integration restore without weakening the
non-empty `/actions/block` request validation.

- [ ] **Step 5: Route existing-task mutations through the transaction**

Map typed validation errors to current HTTP statuses in `task_blockers.rs`.
Use the atomic operation in block, unblock, integration substitution, and
restore. Preserve prepared-task creation rollback behavior for brand-new rows.

- [ ] **Step 6: Verify blocker behavior**

Run the Step 3 commands and the complete Kanna server DB/action test suites.
Expected: all pass and fault-injected reads expose no partial graph/revision.

### Task 4: Full Verification, Diff Review, Commit, And Handoff

**Files:**
- Review all changes against `origin/main`.

- [ ] **Step 1: Run focused frontend/workspace verification**

```bash
pnpm --dir apps/desktop test --run \
  src/App.test.ts \
  src/composables/useAppKeyboardActions.test.ts \
  src/services/desktopCloudTaskIndex.test.ts \
  src/services/desktopLanTaskIndex.test.ts \
  src/services/desktopLanTerminal.test.ts \
  src/services/desktopRelayTerminal.test.ts \
  src/workspace/buildWorkspace.test.ts \
  src/workspace/projectWorkspaceBlockers.test.ts
```

- [ ] **Step 2: Run desktop typecheck/build and practical JavaScript checks**

Use the repository scripts discovered in `package.json`, then run:

```bash
pnpm test
```

- [ ] **Step 3: Run focused and full Rust verification**

```bash
cargo test -p kanna-daemon --test reconnect
cargo test -p kanna-task-transfer
cargo test -p kanna-server
./kd test rust
```

- [ ] **Step 4: Inspect scope and correctness**

```bash
git diff --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git status --short
```

Confirm remote blocker UX remains intact, local behavior is unchanged, every
new token is optional in snapshots but required for remote advance, and no
release path gains a machine-installed dependency.

- [ ] **Step 5: Commit**

```bash
git add \
  apps crates services docs/superpowers
git commit -m "fix: close remote task concurrency review gaps"
```

- [ ] **Step 6: Record Kanna completion**

Call `kanna_complete_stage` with success and a summary stating that the future
PR supersedes #921, the three conflict/review decisions, and exact verification
evidence. Do not push, create a PR, modify #921, or advance the task manually.
