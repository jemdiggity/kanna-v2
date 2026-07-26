# Task Action Race and Retention Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven reviewer findings around stale UI completion, durable retries, bounded action records, CLI resume compatibility, post completion ownership, and startup lifecycle handoff.

**Architecture:** UI completions carry task/view ownership keys. All retried mutations use the existing durable request ledger with bounded completed-row GC. Resume and completion authorization move to feature- and attempt-scoped checks before mutation, and startup recovery transfers its subscribed daemon stream directly into the watcher.

**Tech Stack:** Vue 3, TypeScript, WebDriver E2E, Rust, Tokio, Axum, SQLite/rusqlite, pnpm.

---

### Task 1: Desktop stale-interaction regressions

**Files:**
- Modify: `apps/desktop/src/stores/pipeline.requestRevision.test.ts`
- Modify: `apps/desktop/tests/e2e/mock/stage-advance.test.ts`
- Modify: `apps/desktop/tests/e2e/mock/diff-view.test.ts`
- Modify: `apps/desktop/src/stores/pipeline.ts`
- Modify: `apps/desktop/src/components/DiffModal.vue`
- Modify: `apps/desktop/src/components/AppModalLayer.vue`

- [ ] Add failing tests for a delayed final close after task selection changes.
- [ ] Add failing E2E coverage for a dismissed revision modal followed by a task switch.
- [ ] Revalidate the selected task before fallback restoration and bind modal callbacks to the captured view key.
- [ ] Generate stable request keys for advance and rerun retry loops.
- [ ] Run focused Vitest and E2E tests.

### Task 2: Durable action ledger and bounded GC

**Files:**
- Modify: `packages/db/src/migrations/001_initial.sql`
- Modify: `packages/db/src/migrations.test.ts`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/task_action_requests.rs`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`

- [ ] Add failing replay tests for advance and rerun after a lost response.
- [ ] Add a failing growth test that preserves pending/recent rows but caps completed rows.
- [ ] Generalize claim/replay/finalization around advance, rerun, and revision.
- [ ] Add the updated-at index and completed-row age/hard-cap cleanup.
- [ ] Run focused DB and HTTP action tests.

### Task 3: Installed CLI resume feature probe

**Files:**
- Modify: `crates/kanna-server/src/task_creator/commands.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`

- [ ] Add old/no-resume executable fixtures for PTY and headless revisions.
- [ ] Verify they currently prepare a resumed transition.
- [ ] Probe each provider's help contract with a bounded subprocess before returning a resumed preparation.
- [ ] Fall back fresh on unsupported, failed, timed-out, or deferred-setup probes.
- [ ] Run focused revision tests.

### Task 4: Post-scoped completion attempt

**Files:**
- Modify: `packages/db/src/migrations/001_initial.sql`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-tool-catalog/src/catalog.json`
- Modify: relevant DB, lifecycle, catalog, and HTTP tests

- [ ] Add a failing test showing a duplicate parent completion can complete an injected post.
- [ ] Add a migration and insertion path for a post completion-attempt token.
- [ ] Include the token in the injected post prompt and completion request.
- [ ] Require exact post ownership or the exact parent-plus-token pair.
- [ ] Run focused completion and catalog tests.

### Task 5: Startup lifecycle stream handoff

**Files:**
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: relevant startup and watcher tests

- [ ] Add a failing test that emits successor Exit after startup List and during landing.
- [ ] Return the subscribed lifecycle client and buffered events from startup reconciliation.
- [ ] Adopt that connection in the watcher's first iteration instead of opening a replacement versioned stream.
- [ ] Run focused startup/watcher tests.

### Task 6: Verification and completion

- [ ] Run frontend focused tests and type checking.
- [ ] Run `cargo fmt --all -- --check` and focused Rust package tests.
- [ ] Run `pnpm test` and `./kd test rust` where practical.
- [ ] Run `git diff --check`, inspect the complete diff against all seven findings, and record Kanna stage completion.
