# Mobile Create Task Coverage Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the mobile create-task E2E coverage note and test descriptions with the current optimistic task-workspace flow.

**Architecture:** Keep the Appium gap explicit at the real app/server boundary, but describe the deterministic fixture controls needed to exercise pending, ambiguous, recovery, failure, and terminal-startup outcomes. Point readers to the focused component, controller, persistence, store, and UI-slot tests that currently cover those boundaries.

**Tech Stack:** React Native, TypeScript, Vitest, Appium, Rust daemon tests.

---

### Task 1: Correct the Coverage Record

**Files:**
- Modify: `apps/mobile/e2e/create-task-coverage.md`

- [x] **Step 1: Replace the stale provisioning-panel coverage claims**

Document that submission closes the composer and opens a normal task-shaped optimistic workspace; the stable UI slot is acknowledged in place when creation succeeds. Describe pending/uncertain/recovering states, exact-id recovery, definite failure draft restoration, persistence/hydration, list/detail presentation, and terminal-startup failure coverage in the test files named by the reviewer.

- [x] **Step 2: Update the Appium feasibility rationale and fixture requirements**

Keep the real repo, durable worktree/task/branch, agent-session, and terminal-startup side effects explicit. Require fixture controls for request recording, deferred/lost/rejected responses, exact-id replay, controlled terminal startup success/failure, authoritative task publication, and cleanup.

- [x] **Step 3: Replace the focused command**

Use exactly:

```bash
pnpm --dir apps/mobile test -- src/App.component.test.tsx src/components/CreateTaskComposer.test.tsx src/screens/TaskScreen.test.tsx src/screens/TasksScreen.test.tsx src/state/mobileController.test.ts src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts src/state/taskUiSlots.test.ts src/e2eTestIds.test.ts
```

### Task 2: Correct the Misleading Controller Test Name

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts`

- [x] **Step 1: Rename the stale test description**

Replace:

```ts
it("keeps create task feedback inside the composer while submitting", async () => {
```

with wording that describes the asserted pending task-creation state without claiming the feedback remains in the composer.

### Task 3: Verify the Revision

**Files:**
- Verify: `apps/mobile/e2e/create-task-coverage.md`
- Verify: `apps/mobile/src/state/mobileController.test.ts`

- [x] **Step 1: Run focused mobile verification**

Run the nine-file command from Task 1 and require an exit code of zero.

- [x] **Step 2: Run the repository test suite**

```bash
pnpm test
```

Require all workspace tasks to pass.

- [x] **Step 3: Run the serialized daemon suite**

```bash
cd crates/daemon && cargo test -- --test-threads=1
```

Require all daemon unit, integration, and documentation tests to pass.

- [x] **Step 4: Review the final diff**

Confirm the coverage note contains no provisioning-panel/background-control claims, names every requested narrower suite, uses the exact focused command, and that no unrelated behavior changed.
