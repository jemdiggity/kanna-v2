# Merge Agent In Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat merge as an agent/task type, not as a task lifecycle stage.

**Architecture:** Existing workflow stages remain the lifecycle source of truth. Merge Master and run-merge-agent flows create ordinary `in progress` tasks that happen to run the merge agent. Startup migrations normalize legacy open `merge` rows to `in progress` while preserving merge tags/display names for search and history.

**Tech Stack:** TypeScript/Vue/Pinia/Vitest, Rust kanna-server/kanna-cli tests, SQLite migrations.

---

### Task 1: Core Stage Metadata

**Files:**
- Modify: `packages/core/src/config/custom-tasks.ts`
- Modify: `packages/core/src/config/custom-tasks.test.ts`
- Modify: `packages/core/src/config/repo-config.ts`
- Modify: `packages/core/src/config/repo-config.test.ts`
- Modify: `.kanna/tasks/merge-master/agent.md`

- [ ] Write failing tests that `stage: merge` in custom task frontmatter is ignored and the built-in stage order excludes `merge`.
- [ ] Run `pnpm --dir packages/core test -- custom-tasks repo-config` and confirm the expected failures.
- [ ] Remove `merge` from valid custom task stages and default stage order.
- [ ] Change Merge Master frontmatter to omit `stage: merge`.
- [ ] Re-run the focused package tests and confirm they pass.

### Task 2: Desktop Migration And Tests

**Files:**
- Modify: `apps/desktop/src/stores/db.ts`
- Modify: `apps/desktop/src/stores/db.test.ts`
- Modify: `apps/desktop/src/composables/useCustomTasks.test.ts`
- Modify: desktop tests with mocked `DEFAULT_STAGE_ORDER`

- [ ] Write/update failing DB tests that open `merge` rows normalize to `in progress`.
- [ ] Run `pnpm --dir apps/desktop test -- src/stores/db.test.ts src/composables/useCustomTasks.test.ts` and confirm failures.
- [ ] Replace legacy tag-to-stage migration for merge with `in progress`, and add direct open `merge` normalization.
- [ ] Update desktop expectations for Merge Master custom tasks and built-in stage order.
- [ ] Re-run focused desktop tests.

### Task 3: Server, CLI, And Mobile Surface

**Files:**
- Modify: `crates/kanna-cli/src/main.rs`
- Modify: `crates/kanna-server/src/task_creator.rs`
- Modify: `apps/mobile/src/screens/taskPresentation.ts`
- Modify: related tests

- [ ] Write/update tests so merge-agent task creation reports `stage: "in progress"` and mobile no longer presents `stage === "merge"` as a special lifecycle state.
- [ ] Run focused Rust and mobile tests and confirm failures.
- [ ] Update CLI mock task creation, server task creator defaults, and mobile presentation.
- [ ] Re-run focused tests.

### Task 4: Verification

- [ ] Run `pnpm --dir packages/core test -- custom-tasks repo-config`.
- [ ] Run focused desktop tests for DB migration, custom tasks, stage order, and merge queue creation.
- [ ] Run focused mobile tests around task presentation/controller merge-agent behavior.
- [ ] Run focused Rust tests for `kanna-server` and `kanna-cli` if the touched tests are available without external services.
