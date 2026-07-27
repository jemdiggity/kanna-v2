# Task Action Recovery Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task-action recovery safe after ambiguous Spawn replies and compatible with mixed daemon sessions and pre-upgrade tool catalogs.

**Architecture:** Preserve the existing durable pending-stage-action boundary. Classify immediate Spawn reconciliation instead of conflating transport uncertainty with rejection, recover startup actions by their exact owner tuple, and adapt only the two catalog request resolvers at their compatibility boundary.

**Tech Stack:** Rust, Tokio Unix-socket daemon tests, SQLite-backed Kanna server tests, shared tool catalog.

## Global Constraints

- Never finalize or roll back a potentially live exact successor after transport-only reconciliation failure.
- Never let an unrelated ownerless legacy session authorize or block an exact successor.
- Never trust caller-supplied `run_id` over `KANNA_STAGE_RUN_ID`.
- Preserve both current completion fields through an override catalog that declares neither.

---

### Task 1: Ambiguous Spawn reconciliation

**Files:**
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Test: `crates/kanna-server/src/task_creator/tests/stage.rs`

**Interfaces:**
- Consumes: `DaemonClient::reconnect`, `DaemonClient::list`, durable `pending_stage_action`.
- Produces: a reconciliation result that distinguishes accepted, rejected, and indeterminate outcomes.

- [x] **Step 1: Write failing accepted-Spawn tests**

Add daemon fixtures that accept Spawn, lose its reply, then either fail or
stall subsequent List requests. Assert the API errors while the successor run
and pending action remain durable and the task is not finalized failed.

- [x] **Step 2: Run the tests and verify RED**

Run:
`cargo test -p kanna-server accepted_spawn -- --nocapture`

Expected: the new assertions fail because current code calls the destructive
failure path after the first reconciliation transport error.

- [x] **Step 3: Implement bounded tri-state reconciliation**

Add a private result enum and bounded reconnect/List loop. Route only a
successful conclusive rejection to existing rollback; return an indeterminate
error without mutating the reservation.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:
`cargo test -p kanna-server accepted_spawn -- --nocapture`

Expected: all accepted-Spawn tests pass.

### Task 2: Exact-owner mixed-session startup recovery

**Files:**
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Test: `crates/kanna-server/src/task_creator/tests/stage.rs`

**Interfaces:**
- Consumes: `SessionList.sessions` and each pending action's exact successor tuple.
- Produces: recovery unaffected by unrelated legacy sessions.

- [x] **Step 1: Write the failing mixed-session test**

Return a `SessionList` containing the exact successor plus an unrelated session
whose `run_id` is absent and whose aggregate capability is false. Assert the
successor lands and the pending action clears.

- [x] **Step 2: Run the test and verify RED**

Run:
`cargo test -p kanna-server startup_reconciliation_lands_exact_successor_with_unrelated_legacy_session -- --nocapture`

Expected: failure from the aggregate capability rejection.

- [x] **Step 3: Remove aggregate gating**

Let startup recovery classify each action solely from the exact tuple and
lifecycle events already collected by the handoff.

- [x] **Step 4: Run startup reconciliation tests and verify GREEN**

Run:
`cargo test -p kanna-server startup_reconciliation -- --nocapture`

Expected: mixed, stalled, exit-race, landing, and rollback cases pass.

### Task 3: Pre-upgrade completion catalog compatibility

**Files:**
- Modify: `crates/kanna-mcp/src/main.rs`
- Modify: `crates/kanna-cli/src/commands/tool.rs`
- Test: `crates/kanna-mcp/src/main.rs`
- Test: `crates/kanna-cli/src/tests/cli_surface.rs`

**Interfaces:**
- Consumes: `completion_attempt` from tool arguments and trusted process run id.
- Produces: `completionAttempt` and authoritative `runId` in the resolved HTTP body.

- [x] **Step 1: Strengthen both old-override tests**

Remove both parameters from the override, pass both current arguments, and
assert both camelCase body fields survive resolution.

- [x] **Step 2: Run tests and verify RED**

Run:
`cargo test -p kanna-mcp old_override_catalog`
and
`cargo test -p kanna-cli generic_complete_stage_tool_call_resolves_old_override`

Expected: unknown `completion_attempt` argument.

- [x] **Step 3: Implement resolver compatibility**

When the override lacks `completion_attempt`, validate it as a string, remove
it before shared-catalog resolution, then reinsert `completionAttempt`.

- [x] **Step 4: Run both package suites and verify GREEN**

Run:
`cargo test -p kanna-mcp`
and
`cargo test -p kanna-cli`

Expected: all tests pass.

### Task 4: Final verification and handoff

**Files:**
- Verify all files above.

**Interfaces:**
- Produces: one clean committed branch ready for Kanna stage completion.

- [ ] **Step 1: Run server verification**

Run:
`cargo test -p kanna-server`

- [x] **Step 2: Run formatting and diff checks**

Run:
`cargo fmt --all -- --check`
and
`git diff --check`

- [ ] **Step 3: Commit the review fixes**

Commit all source, tests, design, and plan changes with a review-fix message.

- [ ] **Step 4: Confirm clean ancestry and complete the Kanna stage**

Confirm `origin/main` is an ancestor, the worktree is clean, then record
successful stage completion with a summary of the three fixes and verification.
