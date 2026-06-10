# Cloud Backend Failure Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a visible desktop toast when cloud Firestore sync or publish fails, and deploy the current backend/rules so production accepts nested desktop task documents.

**Architecture:** Keep cloud operations non-blocking, but route caught backend failures through the existing toast service with throttling at the polling boundary. Remove obsolete Firebase task snapshot function exports only if the current backend still exposes a function that the desktop no longer calls, then deploy Functions and Firestore rules together.

**Tech Stack:** Vue 3, Pinia store actions, Vitest, Firebase Functions, Firestore rules, `kd cloud deploy`.

---

### Task 1: App-Level Cloud Failure Toasts

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving `reconcileDesktopTaskSnapshots` and `listDesktopCloudTasks` failures call `toast.error` once with a cloud sync message.

- [ ] **Step 2: Run the App test and verify failure**

Run: `pnpm --dir apps/desktop exec vitest run src/App.test.ts`
Expected: FAIL because the catch blocks only call `console.warn`.

- [ ] **Step 3: Implement minimal throttled toast helper**

In `App.vue`, add a small helper that formats the backend error and throttles repeated cloud backend toasts, then call it from the existing reconcile and refresh catch blocks.

- [ ] **Step 4: Run the App test and verify pass**

Run: `pnpm --dir apps/desktop exec vitest run src/App.test.ts`
Expected: PASS.

### Task 2: Task Publish Failure Toasts

**Files:**
- Modify: `apps/desktop/src/stores/tasks.ts`
- Test: existing task store test covering task create/publish path if available; otherwise add focused coverage in the nearest existing store test file.

- [ ] **Step 1: Write failing test**

Add a test proving a cloud publish rejection after local task creation is surfaced via `context.toast.error` while keeping task creation successful.

- [ ] **Step 2: Run targeted store test and verify failure**

Run the nearest task store test command.
Expected: FAIL because publish failures are currently warning-only.

- [ ] **Step 3: Implement minimal toast in publish catch blocks**

Call the existing store toast context from publish failure catch blocks without blocking local task lifecycle.

- [ ] **Step 4: Run targeted store test and verify pass**

Run the same targeted test command.
Expected: PASS.

### Task 3: Backend Cleanup And Deploy

**Files:**
- Inspect/modify: `services/firebase-functions/src/index.ts`
- Verify: `firestore.rules`

- [ ] **Step 1: Inspect exported Firebase functions**

Confirm whether an obsolete task snapshot function remains exported and whether removing it is required by Firebase deploy.

- [ ] **Step 2: Remove obsolete function if needed**

If a function exists only for old cloud task snapshot publishing and is no longer called by desktop/mobile code, remove the export and deploy deletion with `--force`.

- [ ] **Step 3: Run backend verification**

Run: `pnpm --dir services/firebase-functions test`
Expected: PASS.

- [ ] **Step 4: Deploy backend/rules**

Run: `./kd cloud deploy --production`
Expected: deploys Functions and `firestore.rules` to `kanna-build`.

