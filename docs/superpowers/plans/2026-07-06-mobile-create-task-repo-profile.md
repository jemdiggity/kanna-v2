# Mobile Create Task Repo Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:executing-plans` because the state, persistence, routing, and drawer UI changes are tightly coupled. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile task creation use local per-repo machine and agent preferences with a compact drawer UI.

**Architecture:** Add local repo creation profiles to the mobile session store and persistence payload. The controller initializes composer machine and agent from a saved profile or cloud-task owner inference, persists choices after successful creation, and passes the selected desktop through the create request. The composer shows a minimal prompt-first UI with collapsed options when a repo profile exists.

**Tech Stack:** React Native, TypeScript, Vitest, existing mobile session store/controller/persistence APIs.

---

### Task 1: Local Repo Creation Profiles

**Files:**
- Modify: `apps/mobile/src/state/sessionPersistence.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Test: `apps/mobile/src/state/sessionPersistence.test.ts`
- Test: `apps/mobile/src/state/sessionStore.test.ts`

- [ ] **Step 1: Write failing persistence/store tests**

Add tests that hydrate and save `repoCreationProfiles`, update a repo profile by `repoId`, and preserve selected desktop/repo context.

- [ ] **Step 2: Run tests to verify red**

Run: `pnpm --dir apps/mobile test -- src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts`
Expected: FAIL because `repoCreationProfiles` is not in the persisted/session state.

- [ ] **Step 3: Implement profiles in state/persistence**

Add `RepoCreationProfile` with `repoId`, `desktopId`, `agentProvider`, and `updatedAt`; add `repoCreationProfiles` to `SessionState`, `PersistedSessionContext`, parser, hydration, and a store upsert method.

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm --dir apps/mobile test -- src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts`
Expected: PASS.

### Task 2: Composer Target Selection

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Write failing controller tests**

Add tests that opening the composer uses a saved repo profile, infers exactly one owner desktop from repo tasks, expands options when no desktop exists, disables create without a desktop, sends `desktopId` in create requests, and persists the profile after successful create.

- [ ] **Step 2: Run controller tests to verify red**

Run: `pnpm --dir apps/mobile test -- src/state/mobileController.test.ts`
Expected: FAIL because composer desktop/options state and `desktopId` request support are missing.

- [ ] **Step 3: Implement controller state flow**

Add `desktopId?: string` to `CreateTaskRequest`. Add composer fields for selected desktop and options expansion. Add controller methods to select desktop, toggle options, and initialize composer from selected repo profile/inference. Include selected `desktopId` in `createTask` and persist the repo profile after success.

- [ ] **Step 4: Run controller tests to verify green**

Run: `pnpm --dir apps/mobile test -- src/state/mobileController.test.ts`
Expected: PASS.

### Task 3: Routing With Explicit Desktop

**Files:**
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Test: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts` only if type changes require no behavior change.

- [ ] **Step 1: Write failing transport test**

Add a remote transport test that `createTask({ desktopId: "desktop-2", ... })` invokes `/v1/tasks` on `desktop-2` without relying on selected desktop or repo inference.

- [ ] **Step 2: Run test to verify red**

Run: `pnpm --dir apps/mobile test -- src/lib/transports/remoteTransport.test.ts`
Expected: FAIL because remote create ignores explicit `desktopId`.

- [ ] **Step 3: Implement explicit desktop routing**

Make remote `createTask` strip or ignore the client-only `desktopId` field before posting the body to desktop, and route via that desktop first. Keep repo owner inference as fallback.

- [ ] **Step 4: Run test to verify green**

Run: `pnpm --dir apps/mobile test -- src/lib/transports/remoteTransport.test.ts`
Expected: PASS.

### Task 4: Minimal Drawer UI

**Files:**
- Modify: `apps/mobile/src/components/CreateTaskComposer.tsx`
- Modify: `apps/mobile/src/components/CreateTaskComposer.test.tsx`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] **Step 1: Write failing component tests**

Add tests that a saved repo profile collapses options, no machine expands options, machine choices render and select, agent choice summary is visible, and Create is disabled without a selected machine.

- [ ] **Step 2: Run component tests to verify red**

Run: `pnpm --dir apps/mobile test -- src/components/CreateTaskComposer.test.tsx`
Expected: FAIL because the drawer always shows full agent options and has no machine selector.

- [ ] **Step 3: Implement drawer UI and App wiring**

Change drawer title to `New task in <repo name>`, add options summary row, add machine picker and compact agent picker inside collapsible options, wire controller state/methods from `App.tsx`, and preserve drawer-local errors.

- [ ] **Step 4: Run component tests to verify green**

Run: `pnpm --dir apps/mobile test -- src/components/CreateTaskComposer.test.tsx`
Expected: PASS.

### Task 5: Final Verification and Device Reload

**Files:**
- Verify all modified mobile files.

- [ ] **Step 1: Run focused mobile tests**

Run: `pnpm --dir apps/mobile test -- src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts src/state/mobileController.test.ts src/lib/transports/remoteTransport.test.ts src/appModel.cloudFallback.test.ts src/components/AccountSheet.test.tsx src/components/CreateTaskComposer.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm --dir apps/mobile typecheck`
Expected: PASS.

- [ ] **Step 3: Reload staging Metro**

Run: `tmux -L kanna-task-f6dce960 send-keys -t kanna-task-f6dce960:mobile.1 r`
Expected: Metro logs a fresh iOS bundle.

- [ ] **Step 4: Record Kanna stage success**

Run: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Added local per-repo mobile create-task machine and agent preferences with compact drawer UI."`
Expected: stage completion recorded.
