# Delayed Close/Create Selection Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a newly created task's auto-selection when an older selected task's delayed close response completes.

**Architecture:** Centralize the selection-intent increment in a small store helper shared by UI navigation and task creation. Record task creation's optimistic auto-selection at the `createItem` store boundary while keeping generic selection, reconciliation, and close fallback version-neutral so asynchronous synchronization does not impersonate user navigation.

**Tech Stack:** Vue 3, Pinia-style composition store, TypeScript, Vitest, WebdriverIO mock E2E.

---

### Task 1: Store-Level Selection Intent

**Files:**
- Create: `apps/desktop/src/stores/selectionIntent.ts`
- Modify: `apps/desktop/src/stores/taskItemActions.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/taskCloseActions.test.ts`

- [ ] **Step 1: Add failing tests**

Replace the manual version mutation in the deferred-close test with a real `createItem` auto-selection and assert that creation increments `state.selectionIntentVersion`.

- [ ] **Step 2: Verify focused tests fail for the missing boundary behavior**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/taskCloseActions.test.ts`

Expected: a failure showing task creation does not change the intent version, allowing the delayed close to retain replacement ownership.

- [ ] **Step 3: Implement the shared recorder and route user selection through it**

Create `recordSelectionIntent(state: StoreState): void`, use it from the public recorder in `kanna.ts`, and call it before `createItem`'s optimistic auto-selection. Keep `useAppTaskNavigation` recording UI navigation intent through the public recorder.

- [ ] **Step 4: Verify focused store tests pass**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/taskCloseActions.test.ts`

Expected: all focused tests pass.

### Task 2: Browser Regression Coverage

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/task-lifecycle.test.ts`

- [ ] **Step 1: Change the delayed close gate scenario before production implementation validation**

While the old close response is held, call the real UI/store creation path for repository B, capture the returned durable task id, and assert repository B plus that task are selected.

- [ ] **Step 2: Release the close response and assert ownership persistence**

Assert the delayed close fulfills without changing the created task/repository selection, reload the app, and assert the same durable selection is restored.

- [ ] **Step 3: Run the focused E2E file**

Run: `pnpm --dir apps/desktop test:e2e -- mock/task-lifecycle.test.ts`

Expected: the mock lifecycle E2E suite passes.

### Task 3: Required Verification

**Files:**
- Verify all modified files from Tasks 1 and 2.

- [ ] **Step 1: Run the exact focused store command requested by review**

Run: `pnpm --dir apps/desktop exec vitest run src/stores/taskCloseActions.test.ts`

Expected: all task close action tests pass.

- [ ] **Step 2: Run the repository TypeScript/JavaScript suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 3: Run daemon tests serially**

Run from `crates/daemon`: `cargo test -- --test-threads=1`

Expected: all daemon unit and integration tests pass.

- [ ] **Step 4: Inspect the final diff and status**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended files are modified.
