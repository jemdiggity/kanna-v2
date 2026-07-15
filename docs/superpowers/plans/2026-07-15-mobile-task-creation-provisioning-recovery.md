# Mobile Task Creation Provisioning Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile task provisioning dismissible and recoverable without ever issuing a blind duplicate create.

**Architecture:** Persist a client-selected task id behind an awaited write barrier before submission, create through a version-safe idempotent `PUT /v1/tasks/{taskId}` endpoint, keep ordinary create and explicit recovery single-flight, and separate composer visibility from creation phase. Generic failures become uncertain; recovery replays only the frozen id while typed pre-creation failures may restore Create.

**Tech Stack:** Rust/Axum/SQLite, React Native 0.79, React 19, TypeScript, Vitest, AsyncStorage session persistence.

---

### Task 1: Idempotent Rust Create Identity

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/http_api/tasks.rs`
- Modify: `crates/kanna-server/src/http_api/tests/create_task.rs`
- Modify: request literals under `crates/kanna-server/src/task_creator/tests/`

- [ ] Write failing route/task-creator tests for a lowercase-hex PUT path id,
  same payload replay, mismatched replay conflict, and legacy POST compatibility.
- [ ] Run `cargo test -p kanna-server http_api::tests::create_task -- --test-threads=1`
  and confirm failures are caused by missing identity semantics.
- [ ] Add `requested_task_id: Option<String>` to internal creation input and a
  PUT handler on `/v1/tasks/{task_id}`. Validate 8-64 lowercase hex characters.
  Active and dormant preparation use the path id when present; POST never does.
- [ ] Before preparation, return an existing matching task or `409`; if insert
  loses a race, repeat that lookup. Build the response from the durable item and
  optional worktree path.
- [ ] Guard each PUT id across the full handler so a concurrent replay receives
  an in-progress error until rollback-sensitive owner work settles; add a
  deferred-owner failure/retry regression.
- [ ] Re-run the focused Rust tests and keep them green.

### Task 2: Persisted Mobile Attempt State

**Files:**
- Modify: `apps/mobile/src/state/sessionPersistence.test.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/state/sessionPersistence.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`

- [ ] Write failing round-trip/hydration tests for:

```ts
export type TaskCreationPhase = "idle" | "pending" | "recovering" | "uncertain";
export interface PendingTaskCreation {
  taskId: string;
  repoId: string;
  prompt: string;
  desktopId: string;
  agentProvider: ComposerAgentProvider;
}
```

- [ ] Run `pnpm --dir apps/mobile test -- src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts` and verify red.
- [ ] Add atomic phase/attempt setters, `composerRepoId`, persistence parsing,
  and hydration that maps a persisted attempt to uncertain without opening it.
  Composer close must not mutate an unresolved attempt.
- [ ] Serialize app-model persistence writes and expose an awaitable barrier to
  the controller. Submission must await the frozen attempt's save before any
  client request; a save rejection is definitely pre-creation.
- [ ] Re-run the state suites and verify green.

### Task 3: Client Identity and Outcome Contract

**Files:**
- Modify: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/appModel.ts`

- [ ] Write failing tests that `taskId` selects an encoded PUT path and stays out
  of the body, while `TaskCreationError` exposes `not-created | unknown` and all
  untyped post-dispatch failures are unknown.
- [ ] Run `pnpm --dir apps/mobile test -- src/lib/api/client.test.ts src/lib/transports/lanTransport.test.ts` and verify red.
- [ ] Implement the typed error, wrap only task creation, preserve cause/message,
  keep POST as the no-id compatibility path, and make the disconnected client's
  create failure definite.
- [ ] Re-run the client suites and verify green.

### Task 4: Controller Single Flight and Recovery

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`

- [ ] Write a failing regression that two synchronous calls return the same
  promise and invoke `client.createTask` once against a deferred request.
- [ ] Run `pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "shares one durable create"` and verify two calls before the fix.
- [ ] Add a task-id-keyed create promise guard and generate/freeze one request
  before crossing the async boundary.
- [ ] Add failing tests for background hide, definite failure, generic uncertain
  failure, same-id recovery, recovery single flight, background success without
  view theft, restart recovery, and late response fencing.
- [ ] Add `backgroundTaskCreation()` and `recoverTaskCreation()`. Recovery replays
  exactly the persisted payload; every settlement checks the current task id.
- [ ] Run the complete controller suite and verify green.

### Task 5: Recoverable Provisioning UI

**Files:**
- Modify: `apps/mobile/src/components/CreateTaskComposer.test.tsx`
- Modify: `apps/mobile/src/components/CreateTaskComposer.tsx`
- Modify: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`

- [ ] Write failing tests that all non-idle phases omit prompt/Create/Cancel,
  keep the backdrop inert, map request-close and **Continue in background** to
  the background callback, and expose **Recover task** without a fresh submit.
- [ ] Run `pnpm --dir apps/mobile test -- src/components/CreateTaskComposer.test.tsx src/e2eTestIds.test.ts` and verify red.
- [ ] Replace `isSubmitting` with the phase, add truthful pending/uncertain copy,
  accessible actions, disabled recovering action, and stable action ids.
- [ ] Re-run focused UI suites and verify green.

### Task 6: Mounted App Boundary

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/App.tsx`

- [ ] Add the React 19 test renderer as a dev dependency if the existing harness
  cannot mount the real composer.
- [ ] Replace only the composer mock; mount real App + composer + controller +
  store while mocking native/external screens and using a complete deferred
  `KannaClient` double.
- [ ] Add failing integration cases for pending visibility/control exclusion,
  background/reopen, success opening the created task, definite failure form
  restoration, and ambiguous same-id recovery without duplicate creation.
- [ ] Wire `composerRepoId`, phase, background, and recovery callbacks in App.
- [ ] Run `pnpm --dir apps/mobile test -- src/App.component.test.tsx src/components/CreateTaskComposer.test.tsx src/state/mobileController.test.ts src/e2eTestIds.test.ts` and verify green.

### Task 7: Documentation and Verification

**Files:**
- Modify: `apps/mobile/e2e/create-task-coverage.md`

- [ ] Update the narrower coverage section with provisioning integration cases,
  current Appium side effects, and the fake repo/request-recorder/no-spawn/cleanup
  fixture needed for deterministic E2E.
- [ ] Run `pnpm --dir apps/mobile typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `cd crates/daemon && cargo test -- --test-threads=1`.
- [ ] Run `cargo test -p kanna-server` because Rust is changed.
- [ ] Inspect the final diff for no ambiguity-clearing timeout, no fresh-id
  recovery, no physical-device automation, and no unrelated generated changes.
