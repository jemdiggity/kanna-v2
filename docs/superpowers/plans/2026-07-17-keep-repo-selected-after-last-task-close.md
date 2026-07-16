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
