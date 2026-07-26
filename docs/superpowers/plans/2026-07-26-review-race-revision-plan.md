# Review Race Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reviewer-identified transition durability, daemon exit/reaping, initial spawn, UI synchronization, and old-catalog compatibility gaps.

**Architecture:** A pending stage replacement becomes a durable database state machine: reservation stores both the exact source snapshot and target landing metadata, normal landing deletes that recovery state atomically, and startup reconciles every remaining record against one daemon session list before serving actions. Daemon agent readers detach child resources under generation/PID guards, reap off-lock with a bounded grace, and revalidate before publishing; successful idle per-turn kills publish a killed exit so replacement markers are consumed exactly once.

**Tech Stack:** Rust, Tokio, SQLite/rusqlite, Vue/WebdriverIO E2E, TypeScript, pnpm.

---

### Task 1: Old catalog stage-run ownership

**Files:**
- Modify: `crates/kanna-mcp/src/main.rs`
- Modify: `crates/kanna-cli/src/commands/tool.rs`
- Test: `crates/kanna-mcp/src/main.rs`
- Test: `crates/kanna-cli/tests/tool_call.rs`

- [ ] Add old-override tests that pass an explicit caller `run_id` while `KANNA_STAGE_RUN_ID` is trusted.
- [ ] Run the focused tests and confirm old-catalog validation rejects the unknown parameter.
- [ ] Before catalog validation, clone object arguments and remove `run_id` only for trusted `kanna_complete_stage` calls; inject trusted `runId` into the resolved body afterward.
- [ ] Re-run MCP and CLI focused tests.

### Task 2: Daemon child lifecycle

**Files:**
- Modify: `crates/daemon/src/agent_runtime/readers.rs`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Test: `crates/daemon/src/agent_runtime/readers.rs`
- Test: `crates/daemon/tests/agent_sessions.rs`

- [ ] Restore/add a lingering-child regression that closes stdout while remaining alive and proves `List` stays responsive.
- [ ] Make EOF handling close stdin and handoff descriptors before reaping.
- [ ] Use `try_wait` for the already-exited fast path, then bounded polling and process-group kill off the registry lock.
- [ ] Revalidate generation and PID after reaping before updating or publishing.
- [ ] Emit a killed `Exit` when a successful kill removes an exited per-turn Codex/OpenCode session.
- [ ] Run daemon unit and agent-session integration tests.

### Task 3: Replacement marker consumption

**Files:**
- Modify: `crates/kanna-server/src/session_replacements.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Test: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] Add an idle per-turn replacement regression in which a later real successor exit must complete the successor rather than consume a stale marker.
- [ ] Ensure failed/no-exit kill outcomes cancel exactly the marker created by that kill, while successful killed exits consume the oldest marker.
- [ ] Run focused server watcher and lifecycle tests.

### Task 4: Durable pending replacement recovery

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Test: `crates/kanna-server/src/db/tests.rs`
- Test: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] Add a migration and schema for the pending replacement’s source snapshot, source ownership, target stage/branch/worktree, session, and successor run.
- [ ] Persist the recovery row in the same transaction as source closure and successor reservation.
- [ ] Delete recovery state atomically on landing or rollback.
- [ ] Add startup reconciliation tests for successor-present landing and source restoration when the successor is absent/mismatched.
- [ ] Reconcile before starting watcher/server services, failing startup closed if reconciliation cannot inspect daemon state.
- [ ] Run migration, DB, and lifecycle tests.

### Task 5: Initial/dormant spawn landing race

**Files:**
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Test: `crates/kanna-server/src/task_creator/tests/spawn.rs`

- [ ] Add a deterministic fake-daemon test that closes the task after `SessionCreated` but before landing.
- [ ] Land the initial pending run only while it remains latest and the task is open/current.
- [ ] On failed landing, guarded-kill the generated run and delete/roll back the pending run.
- [ ] Run focused initial and dormant spawn tests.

### Task 6: Revision failure UI synchronization

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/diff-view.test.ts`

- [ ] Wait for the delayed 500 response to become observable via an error toast and/or re-enabled send button.
- [ ] Assert the composer, draft, and review comments only after that completion point.
- [ ] Run the focused diff-view E2E test when the local browser harness is available.

### Task 7: Verification

**Files:**
- Inspect all modified files.

- [ ] Run focused Rust tests for daemon, server, MCP, and CLI.
- [ ] Run relevant pnpm tests/type checks.
- [ ] Run `cargo fmt --check` or repository formatting checks.
- [ ] Inspect `git diff --check`, `git status`, and the final diff against every reviewer item.
- [ ] Record Kanna stage success with the verified summary, or failure with the blocker.
