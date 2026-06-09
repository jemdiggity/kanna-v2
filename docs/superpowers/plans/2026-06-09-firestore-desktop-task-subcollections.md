# Firestore Desktop Task Subcollections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish desktop task snapshots directly to Firestore under per-desktop auto-ID documents with task auto-ID subcollections.

**Architecture:** Desktop resolves or creates `users/{uid}/desktops/{autoId}` by `desktopId`, then replaces that desktop document's `tasks` subcollection using identity fields in document data. Readers list all desktop docs and flatten each `tasks` subcollection into the existing cloud task snapshot model.

**Tech Stack:** Vue/Tauri desktop, Firebase Web SDK, Firestore security rules, Vitest.

---

### Task 1: Desktop Publisher

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudPublisher.ts`
- Test: `apps/desktop/src/services/desktopCloudPublisher.test.ts`

- [ ] Write failing tests for resolving/creating a desktop doc, upserting open task docs by `{localRepoId}:{ownerLocalTaskId}`, deleting stale docs, and deleting one remote task by identity.
- [ ] Run `pnpm --dir apps/desktop exec vitest run src/services/desktopCloudPublisher.test.ts` and verify failure.
- [ ] Replace cloud-function publisher calls with Firestore `collection`, `query`, `where`, `limit`, `getDocs`, `addDoc`, `writeBatch`, and `serverTimestamp`.
- [ ] Run the same test and verify pass.

### Task 2: Desktop Cloud Reader

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Test: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`

- [ ] Write failing tests that `listDesktopCloudTasks` reads `users/{uid}/desktops/*/tasks` and flattens task snapshots.
- [ ] Run targeted test and verify failure.
- [ ] Implement desktop-doc traversal while keeping `mapDesktopCloudTasks` unchanged for LAN reuse.
- [ ] Run targeted test and verify pass.

### Task 3: Mobile Cloud Reader

**Files:**
- Modify: `apps/mobile/src/lib/firebase/taskIndex.ts`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts`

- [ ] Write failing test for reading task subcollections under desktop docs.
- [ ] Implement traversal and flattening.
- [ ] Run targeted mobile firebase task index test.

### Task 4: Firestore Rules

**Files:**
- Modify: `firestore.rules`
- Test: `services/firebase-functions/test/firestore-rules.test.ts`

- [ ] Write failing rules tests allowing same-user desktop/task writes and denying cross-user writes.
- [ ] Implement rules for `users/{uid}/desktops/{desktopDocId}` and nested `tasks/{taskDocId}`.
- [ ] Run rules tests if emulator is available.

### Task 5: App Wiring And Verification

**Files:**
- Modify if needed: `apps/desktop/src/App.vue`, `apps/desktop/src/stores/tasks.ts`, `apps/desktop/src/services/desktopFirebaseConfig.ts`

- [ ] Remove cloud-function endpoint dependency from task publishing path.
- [ ] Keep public function names stable for callers.
- [ ] Run `pnpm --dir apps/desktop exec vitest run src/services/desktopCloudPublisher.test.ts src/services/desktopCloudTaskIndex.test.ts`.
- [ ] Run `pnpm --dir apps/desktop exec vue-tsc --noEmit`.
