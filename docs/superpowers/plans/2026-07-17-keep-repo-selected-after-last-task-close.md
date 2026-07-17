# Keep Repository Selected After Last Task Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current repository selected when its last open task is closed, even if other repositories still have open tasks.

**Architecture:** Restrict the close-removal replacement lookup in the selection store to the removed task's repository. Existing same-repository ordering remains unchanged; when no same-repository task remains, the existing no-replacement path clears and persists only the task selection while leaving `selectedRepoId` intact.

**Tech Stack:** Vue 3, TypeScript, Vitest, pnpm

---

### Task 1: Define the close-selection regression

**Files:**
- Modify: `apps/desktop/src/stores/selection.test.ts`
- Modify: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [x] **Step 1: Write a failing regression test**

Add a unit test that creates two repositories with one open task each, selects the task in `repo-1`, invokes `selectReplacementAfterItemRemoval()` for that task, and asserts that the result and selected task are null while `selectedRepoId` remains `repo-1`. Also update the teardown auto-close integration contract to expect the same repository and no selected task.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run src/stores/selection.test.ts` from `apps/desktop`.

Expected: FAIL because the current helper chooses the open task in `repo-2` and changes `selectedRepoId` to `repo-2`.

### Task 2: Restrict replacement lookup to the current repository

**Files:**
- Modify: `apps/desktop/src/stores/selection.ts`

- [x] **Step 1: Implement the minimal behavior change**

Remove the global fallback from `findReplacementAfterItemRemoval()`. Preserve the existing same-repository sorted lookup and return `null` when `sameRepoRemaining` is empty.

- [x] **Step 2: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run src/stores/selection.test.ts` from `apps/desktop`.

Expected: PASS, including the new regression and existing selection tests.

### Task 3: Verify the affected desktop store

**Files:**
- Modify: `apps/desktop/src/stores/selection.ts`
- Test: `apps/desktop/src/stores/selection.test.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [x] **Step 1: Run the desktop typecheck**

Run the desktop package's configured typecheck command identified in `apps/desktop/package.json`.

Expected: PASS.

- [x] **Step 2: Run the desktop test suite and inspect the final diff**

Run `pnpm test` from `apps/desktop`, then confirm the diff contains only the two regression contracts, the minimal selection change, and this implementation plan, with no unrelated edits.

### Task 4: Cover the complete desktop close flow

**Files:**
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/stores/taskCloseActions.ts`
- Modify: `apps/desktop/tests/e2e/mock/task-lifecycle.test.ts`

- [x] **Step 1: Add the two-repository E2E regression**

Import two fixture repositories and leave one inert open task in each. Select and persist the task in repository A, close it through `closeSelectedWorkspaceTask()`, and assert that repository A remains selected, `selectedItemId` is null, repository A displays its empty state, and repository B's task is not selected. Reload the app and repeat the persisted-selection assertions.

Capture whether the local task owns the current selection before posting the server close request. Use that captured value when deciding whether to select a replacement, so a live snapshot that removes the closed task before the request resolves cannot skip selection cleanup.

For a local workspace task, defer the local closed-task projection mark until the store close completes and the task is absent from the reloaded snapshot. This preserves the selected task slot long enough for the store to capture selection ownership and avoids hiding the projection when the close request fails.

- [x] **Step 2: Verify the regression detects the previous behavior**

Temporarily restore the old cross-repository replacement lookup in `apps/desktop/src/stores/selection.ts`, then run:

```bash
pnpm --dir apps/desktop test:e2e -- mock/task-lifecycle.test.ts
```

Expected: FAIL because closing repository A's task selects repository B and its remaining task. Restore the current selection implementation afterward.

- [x] **Step 3: Run the focused E2E with the fix restored**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- mock/task-lifecycle.test.ts
```

Expected: PASS.

- [x] **Step 4: Run the requested regression suites**

Run:

```bash
pnpm test
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: both commands pass with no test failures.
