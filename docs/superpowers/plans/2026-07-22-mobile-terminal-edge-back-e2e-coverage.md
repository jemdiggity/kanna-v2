# Mobile Terminal Edge-Back E2E Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on the iOS simulator that a native left-edge drag over an open PTY terminal pops TaskDetail and restores the Tasks origin.

**Architecture:** Add one focused Appium helper to the existing list/detail/back smoke module. The helper issues the suite's established `mobile: dragFromToForDuration` command from the physical left edge across the screen, then waits for TaskDetail to leave the accessibility tree and the Tasks screen to be displayed; the smoke journey reopens the known PTY fixture from Tasks before invoking it.

**Tech Stack:** WebdriverIO/Appium, iOS Simulator, TypeScript, Vitest

---

## File Structure

- Modify `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts` to specify the native drag coordinates and completed navigation state before the helper exists.
- Modify `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts` to implement the native drag helper and add the Tasks-origin gesture journey while retaining the existing back-button and Activity-origin journeys.

### Task 1: Specify Native Edge-Back Completion

**Files:**
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts`

- [x] **Step 1: Add a failing unit test for the Appium gesture helper**

Import `performTaskDetailEdgeSwipeBack`, create a driver stub with a `390x844` window, and assert that it executes:

```ts
expect(driver.execute).toHaveBeenCalledWith(
  "mobile: dragFromToForDuration",
  {
    duration: 0.5,
    fromX: 1,
    fromY: 422,
    toX: 293,
    toY: 422
  }
);
```

The stub's `waitUntil` must evaluate the real predicate, and the test must also assert that both TaskDetail disappearance and Tasks visibility were inspected.

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/list-detail-back.test.ts
```

Expected: FAIL because `performTaskDetailEdgeSwipeBack` is not exported yet.

### Task 2: Add the Appium Gesture Journey

**Files:**
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`

- [x] **Step 1: Implement the minimal native drag helper**

Use `driver.getWindowSize()` and `driver.execute("mobile: dragFromToForDuration", ...)` with `fromX: 1`, a vertical midpoint, and an endpoint at 75% of screen width. Then use `driver.waitUntil` to require the TaskDetail selector to be absent and the Tasks selector to both exist and be displayed.

- [x] **Step 2: Extend the smoke journey without replacing existing checks**

After the existing PTY validation and visible-back-button return, explicitly select Tasks, reopen the exact `KANNA_E2E_PTY_TASK_ID` row, wait for TaskDetail and its rendered PTY terminal, perform the edge drag, and wait for task rows. Leave the existing Activity-origin open/back/assert sequence intact.

- [x] **Step 3: Run the focused tests and confirm GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/list-detail-back.test.ts src/navigation/RootNavigator.component.test.tsx
```

Expected: both files pass with no failures.

### Task 3: Verify the Revision

**Files:**
- Verify: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
- Verify: `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts`

- [x] **Step 1: Run static and repository checks**

Run:

```bash
pnpm --dir apps/mobile typecheck
pnpm test
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: all commands exit 0.

- [x] **Step 2: Run the kd-managed simulator smoke when fixture prerequisites are available**

Run:

```bash
./kd dev up --mobile
pnpm --dir apps/mobile run test:e2e:smoke
```

Expected: the smoke journey opens the known PTY fixture from Tasks, completes the native edge pop, observes Tasks again, and retains the visible-button and Activity-origin checks. If the required simulator, agent CLI, or PTY fixture is unavailable, capture the exact prerequisite failure instead of treating it as a passing smoke.

Result: `./kd dev up --mobile` started successfully, but the smoke runner stopped at its environment guard because this task shell has no `KANNA_E2E_DESKTOP_SERVER_URL`, `KANNA_E2E_PTY_TASK_ID`, or `KANNA_E2E_PTY_SENTINEL`. The repository documents that no synthetic deterministic PTY fixture path exists yet, so the native journey could not run in this worktree.

- [x] **Step 3: Review the final worktree**

Run:

```bash
git diff --check
git status --short
git diff -- apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts apps/mobile/e2e/specs/smoke/list-detail-back.test.ts
```

Expected: no whitespace errors and only the intended E2E coverage plus this plan are uncommitted. Kanna's stage post owns the local commit.
