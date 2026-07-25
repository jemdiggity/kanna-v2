# Mobile Partial-Task Abort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mobile create new tasks while other creations are unresolved, and let users safely abort each unresolved creation without creating an absent desktop task or leaving an orphan.

**Architecture:** Store creation attempts as a per-slot collection instead of one session-wide attempt. Route a new idempotent abort-creation operation directly to the attempt's frozen owning desktop, where requested-id creation and abort share a per-id coordinator. Keep ordinary task close semantics unchanged.

**Tech Stack:** React Native, TypeScript, Vitest, Vue-independent mobile state/controller modules, Rust, Axum, Tokio, SQLite-backed Kanna server.

---

### Task 1: Add the idempotent desktop abort-creation contract

**Files:**
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Test: `crates/kanna-server/src/http_api/tests/actions.rs`
- Test: `crates/kanna-server/src/http_api/tests/create_task.rs`

- [ ] **Step 1: Write failing HTTP tests for absent and existing requested ids**

Add route tests that establish the contract independently from mobile:

```rust
#[tokio::test]
async fn abort_task_creation_succeeds_when_requested_id_is_absent() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let response = app
        .oneshot(
            Request::post("/v1/tasks/a1b2c3d4/actions/abort-creation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn abort_task_creation_closes_an_existing_requested_id() {
    let app = super::test_router_with_task_closer(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            assert_eq!(task_id, "a1b2c3d4");
            Ok(())
        }),
    );
    let response = app
        .oneshot(
            Request::post("/v1/tasks/a1b2c3d4/actions/abort-creation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}
```

Add a coordinator test in `create_task.rs`: hold a requested-id create flight, start abort, assert abort has not completed, release create, and assert abort then invokes close. Use the existing channels in `concurrent_requested_task_creation_is_rejected_until_owner_failure_releases_flight` so the test observes ordering rather than sleeping.

Also seed an already closed requested-id task and assert abort returns 204
without invoking close again. While abort owns the requested id, issue a PUT
for that id and assert the existing create contract returns 409. These two
tests cover both idempotency and the opposite side of the shared coordinator.

- [ ] **Step 2: Run the route tests and verify RED**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions::abort_task_creation -- --nocapture
```

Expected: FAIL because `/actions/abort-creation` returns 404.

Run:

```bash
cargo test -p kanna-server http_api::tests::create_task::abort_waits_for_requested_creation -- --nocapture
```

Expected: FAIL because `AppState` has no abort-side requested-id acquisition method.

- [ ] **Step 3: Generalize the requested-id flight coordinator**

Replace the bare `Arc<Mutex<HashSet<String>>>` with a small shared coordinator that can either reject duplicate creates or asynchronously acquire an id for abort:

```rust
#[derive(Default)]
struct RequestedTaskOperations {
    active: StdMutex<HashSet<String>>,
    changed: tokio::sync::Notify,
}

pub(super) struct RequestedTaskOperation {
    task_id: String,
    operations: Arc<RequestedTaskOperations>,
}

impl Drop for RequestedTaskOperation {
    fn drop(&mut self) {
        self.operations
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.task_id);
        self.operations.changed.notify_waiters();
    }
}
```

Keep `begin_requested_task_creation()` nonblocking so concurrent duplicate PUT
requests retain their current 409 response. Add:

```rust
pub(super) async fn begin_requested_task_abort(
    &self,
    task_id: &str,
) -> RequestedTaskOperation {
    loop {
        let changed = self.requested_task_operations.changed.notified();
        {
            let mut active = self
                .requested_task_operations
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if active.insert(task_id.to_string()) {
                return RequestedTaskOperation {
                    task_id: task_id.to_string(),
                    operations: Arc::clone(&self.requested_task_operations),
                };
            }
        }
        changed.await;
    }
}
```

Register the `changed` future before checking the mutex so a release cannot be
missed between the check and `await`.

- [ ] **Step 4: Extract close handling and add the abort route**

Refactor `close_task` so the existing route delegates to an internal function
with `missing_is_success: false`. Add:

```rust
pub(super) async fn abort_task_creation(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    super::tasks::validate_requested_task_id(&task_id)?;
    let _operation = state.begin_requested_task_abort(&task_id).await;
    close_task_inner(state, task_id, true).await
}
```

`close_task_inner` must return 204 immediately when the id is absent and
`missing_is_success` is true. It must also return 204 for an already closed
task. For an existing open task, use the exact normal close workflow so daemon
sessions, teardown, worktrees, task ports, blocker notifications, and state
change events retain current behavior.

Export `validate_requested_task_id` as `pub(super)` and register:

```rust
.route(
    "/v1/tasks/{task_id}/actions/abort-creation",
    post(abort_task_creation),
)
```

- [ ] **Step 5: Run server tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions::abort_task_creation -- --nocapture
cargo test -p kanna-server http_api::tests::create_task::abort_waits_for_requested_creation -- --nocapture
cargo test -p kanna-server http_api::tests::actions::close_task_route -- --nocapture
```

Expected: all selected tests PASS; ordinary close still returns not-found for an absent id.

- [ ] **Step 6: Commit the server contract**

```bash
git add crates/kanna-server/src/http_api/state.rs crates/kanna-server/src/http_api/task_actions.rs crates/kanna-server/src/http_api/router.rs crates/kanna-server/src/http_api/tests/actions.rs crates/kanna-server/src/http_api/tests/create_task.rs
git commit -m "feat(server): abort uncertain task creation"
```

### Task 2: Route abort to the frozen owning desktop

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: `apps/mobile/src/appModel.ts`
- Test: `apps/mobile/src/lib/api/client.test.ts`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Test: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Test: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`

- [ ] **Step 1: Write failing transport routing tests**

Define the wished-for request in tests:

```ts
const request = {
  taskId: "a1b2c3d4",
  desktopId: "desktop-created-here"
};
await transport.abortTaskCreation(request);
```

Assert LAN posts:

```ts
expect(fetchImpl).toHaveBeenCalledWith(
  "http://127.0.0.1:48120/v1/tasks/a1b2c3d4/actions/abort-creation",
  { method: "POST" }
);
```

Assert remote ignores the currently selected desktop and invokes the frozen
owner:

```ts
expect(invokeDesktop).toHaveBeenCalledWith({
  desktopId: "desktop-created-here",
  method: "POST",
  path: "/v1/tasks/a1b2c3d4/actions/abort-creation",
  body: null
});
```

For `cloudLanClient`, cover both paths: use the matching live LAN client when
available, otherwise delegate to the cloud/relay client with the unchanged
request.

- [ ] **Step 2: Run transport tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/api/client.test.ts src/lib/transports/lanTransport.test.ts src/lib/transports/remoteTransport.test.ts src/lib/sources/cloudLanClient.test.ts
```

Expected: TypeScript/Vitest failures because `abortTaskCreation` is absent.

- [ ] **Step 3: Add the typed client operation**

In `types.ts` add:

```ts
export interface AbortTaskCreationRequest {
  taskId: string;
  desktopId: string;
}
```

Add this method to both `KannaTransport` and `KannaClient`:

```ts
abortTaskCreation(input: AbortTaskCreationRequest): Promise<void>;
```

Delegate it in `createKannaClient`, `createDelegatingClient`, unavailable
clients, and test client factories. Unavailable clients reject with the same
connection error style as other write operations.

- [ ] **Step 4: Implement each routing boundary**

LAN strips the routing-only desktop id:

```ts
abortTaskCreation: ({ taskId }) =>
  request<void>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/abort-creation`,
    { method: "POST" }
  ),
```

Remote targets `input.desktopId` directly through `requestDesktop`, not
`requestTask`, because an uncertain task has no published route:

```ts
abortTaskCreation: ({ taskId, desktopId }) =>
  requestDesktop<void>(
    desktopId,
    "POST",
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/abort-creation`,
    null
  ),
```

Hybrid routing uses the destination LAN client only when LAN is enabled and
`lanClientForDesktop(input.desktopId)` resolves; otherwise it delegates to the
cloud client. Do not create or retire provisional task routes for abort.

- [ ] **Step 5: Run transport tests and typecheck**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/api/client.test.ts src/lib/transports/lanTransport.test.ts src/lib/transports/remoteTransport.test.ts src/lib/sources/cloudLanClient.test.ts
pnpm --dir apps/mobile typecheck
```

Expected: selected tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit transport support**

```bash
git add apps/mobile/src/lib/api/types.ts apps/mobile/src/lib/api/client.ts apps/mobile/src/lib/transports/lanTransport.ts apps/mobile/src/lib/transports/remoteTransport.ts apps/mobile/src/lib/sources/cloudLanClient.ts apps/mobile/src/appModel.ts apps/mobile/src/lib/api/client.test.ts apps/mobile/src/lib/transports/lanTransport.test.ts apps/mobile/src/lib/transports/remoteTransport.test.ts apps/mobile/src/lib/sources/cloudLanClient.test.ts
git commit -m "feat(mobile): route task creation abort"
```

### Task 3: Migrate the complete mobile creation flow atomically

The state, controller, and navigation APIs are tightly coupled. Complete
Phases A-C and commit them together so no intermediate commit has two sources
of creation truth or fails typecheck.

#### Phase A: Make unresolved creation state per-slot and durable

**Files:**
- Modify: `apps/mobile/src/state/taskUiSlots.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionPersistence.ts`
- Test: `apps/mobile/src/state/taskUiSlots.test.ts`
- Test: `apps/mobile/src/state/sessionStore.test.ts`
- Test: `apps/mobile/src/state/sessionPersistence.test.ts`

- [ ] **Step 1: Write failing state and persistence tests**

Add two unresolved attempts and assert both remain independently addressable:

```ts
store.addTaskCreationAttempt({
  ...attemptA,
  phase: "uncertain"
});
store.addTaskCreationAttempt({
  ...attemptB,
  phase: "pending"
});

expect(store.getState().taskCreationAttempts).toEqual([
  { ...attemptB, phase: "pending" },
  { ...attemptA, phase: "uncertain" }
]);
expect(store.getState().taskUiSlots.map(({ slotId }) => slotId)).toEqual([
  attemptB.slotId,
  attemptA.slotId
]);
```

Persist an array, reload it, and assert every phase hydrates as uncertain:

```ts
await persistence.save({
  mobileDeviceId: null,
  selectedDesktopId: "desktop-a",
  selectedRepoId: "repo-1",
  selectedTaskId: attemptA.slotId,
  activeView: "tasks",
  taskCreationAttempts: [attemptA, attemptB]
});

await expect(persistence.load()).resolves.toMatchObject({
  taskCreationAttempts: [attemptA, attemptB]
});
```

Keep a fixture with legacy `pendingTaskCreation` and assert it becomes a
one-element `taskCreationAttempts` array. Add duplicate slot-id and reserved-id
fixtures and assert the parser keeps only the first valid entry.

- [ ] **Step 2: Run state tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/taskUiSlots.test.ts src/state/sessionStore.test.ts src/state/sessionPersistence.test.ts
```

Expected: FAIL because state exposes only the singular attempt.

- [ ] **Step 3: Introduce the per-slot types and store methods**

Replace `TaskCreationState` with:

```ts
export type ActiveTaskCreationPhase = Exclude<TaskCreationPhase, "idle">;

export interface TaskCreationAttempt extends PendingTaskCreation {
  phase: ActiveTaskCreationPhase;
}
```

Store `taskCreationAttempts: TaskCreationAttempt[]`. Add:

```ts
addTaskCreationAttempt(attempt: TaskCreationAttempt): void;
setTaskCreationAttemptPhase(
  slotId: string,
  phase: ActiveTaskCreationPhase
): void;
removeTaskCreationAttempt(slotId: string): void;
```

Each mutation updates only the matching attempt and corresponding creating
slot. `buildCreatingTaskUiSlot` continues presenting the frozen draft, while
the attempt collection remains the source of reserved task id, geometry, and
phase. Add pure lookup helpers by slot id and reserved task id so controller
and navigation code do not duplicate searches.

- [ ] **Step 4: Migrate persistence without losing old attempts**

Change `PersistedSessionContext` to write:

```ts
taskCreationAttempts?: PendingTaskCreation[];
```

The parser reads the array first, validates entries with the existing
`parsePendingTaskCreation`, and deduplicates by both `slotId` and `taskId`.
When the array field is absent, parse legacy `pendingTaskCreation` into an
array. `getPersistedContext` writes unresolved attempts without their runtime
phase; `hydrateContext` restores them all as uncertain and rebuilds creating
slots. Do not copy a recovered attempt's prompt into the fresh composer.

- [ ] **Step 5: Run state tests before migrating consumers**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/taskUiSlots.test.ts src/state/sessionStore.test.ts src/state/sessionPersistence.test.ts
```

Expected: selected state tests PASS. Continue directly to Phase B without
committing because controller and navigation still consume the old API.

#### Phase B: Allow fresh composers and independent creation flights

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Test: `apps/mobile/src/appModel.taskCreation.test.ts`

- [ ] **Step 1: Write failing controller tests**

Create one uncertain attempt, invoke New Task, and assert the composer is fresh:

```ts
await controller.createTask();
controller.openComposer();

expect(store.getState()).toMatchObject({
  isComposerOpen: true,
  composerPrompt: "",
  selectedTaskId: null
});
expect(store.getState().taskCreationAttempts).toHaveLength(1);
```

Submit a second task while the first remains uncertain. Resolve the second
request and assert only its slot becomes ready while the first stays
uncertain. Add a restart case with two hydrated attempts and assert recovery
of one does not mutate the other.

Add a late-result regression: start a create, remove/abort its slot, resolve
the original promise, and assert the slot is not acknowledged or resurrected.

- [ ] **Step 2: Run controller tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/appModel.taskCreation.test.ts
```

Expected: FAIL because `openComposer()` redirects to the singular pending slot
and `createTask()` refuses a second attempt.

- [ ] **Step 3: Replace singleton controller flights with keyed collections**

Use:

```ts
const ordinaryTaskCreationFlights = new Map<string, Promise<string | null>>();
const recoveryTaskCreationFlights = new Map<string, Promise<string | null>>();
const taskCreationPersistenceFlights = new Map<string, Promise<void>>();
const recoveryStartedTaskIds = new Set<string>();
```

Change completion and definite-failure helpers to look up the exact slot and
reserved id before mutating. Their first guard is:

```ts
const current = findTaskCreationAttempt(store.getState(), attempt.slotId);
if (!current || current.taskId !== attempt.taskId) return null;
```

After every awaited persistence barrier, repeat this guard before dispatching
create or recovery. This prevents a successful abort from being followed by a
late local dispatch.

- [ ] **Step 4: Decouple composer lifecycle from unresolved attempts**

`openComposer()` always clears selection, seeds repo/desktop/provider from the
current repo profile, clears the prompt and composer error, and opens the
composer. Composer edit methods no longer return early because another slot is
unresolved. `createTask()` snapshots the current draft into a new attempt,
adds its slot, closes the composer, and records only that request's keyed
flight.

Change recovery to target a slot:

```ts
recoverTaskCreation(slotId: string): Promise<string | null>;
```

It updates only that attempt's phase and uses only that task id's recovery
flight. Definite failures remove only that attempt and slot.

- [ ] **Step 5: Run controller tests**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/appModel.taskCreation.test.ts
```

Expected: selected controller tests PASS. Continue directly to Phase C without
committing because navigation still consumes the old callbacks.

#### Phase C: Abort the selected partial task from the existing action menu

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`
- Modify: `apps/mobile/src/navigation/taskNavigation.ts`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/taskActionMenu.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Test: `apps/mobile/src/navigation/RootNavigator.integration.test.tsx`
- Test: `apps/mobile/src/navigation/RootNavigator.component.test.tsx`
- Test: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Test: `apps/mobile/src/screens/taskActionMenu.test.ts`

- [ ] **Step 1: Write failing abort behavior tests**

At controller level:

```ts
await controller.abortTaskCreation(attempt.slotId);

expect(client.abortTaskCreation).toHaveBeenCalledWith({
  taskId: attempt.taskId,
  desktopId: attempt.desktopId
});
expect(store.getState().taskCreationAttempts).toEqual([]);
expect(store.getState().taskUiSlots).toEqual([]);
```

Reject the client call and assert the attempt remains uncertain, the error is
shown, and a second abort call is accepted after the first finishes. Resolve a
late original create after successful abort and assert no slot returns.

At navigator level, render an uncertain slot, select Close Task from the action
menu, and assert `abortTaskCreation(slotId)` is called instead of
`closeDesktopTask`. Also assert normal ready tasks still call
`closeDesktopTask(durableTaskId)`.

- [ ] **Step 2: Run focused abort tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/navigation/RootNavigator.integration.test.tsx src/screens/TaskScreen.test.tsx src/screens/taskActionMenu.test.ts
```

Expected: FAIL because there is no controller abort method and the current
resolver passes the optimistic slot id to normal close.

- [ ] **Step 3: Implement controller abort**

Add:

```ts
abortTaskCreation(slotId: string): Promise<void>;
```

The implementation snapshots the matching attempt and uses the slot id as the
pending-action identity:

```ts
if (!store.beginTaskAction(slotId, "close-task")) return;
try {
  await client.abortTaskCreation({
    taskId: attempt.taskId,
    desktopId: attempt.desktopId
  });
  store.removeTaskCreationAttempt(slotId);
  if (store.getState().selectedTaskId === slotId) {
    stopTaskSession();
    store.setSelectedTask(null);
    store.clearTaskTerminal();
    store.clearTaskAgent();
    store.clearTaskCompanion();
  }
  setUnownedErrorMessage(null);
} catch (error) {
  fail(error);
} finally {
  store.finishTaskAction(slotId, "close-task");
}
```

Removal must be idempotent. Do not clear composer state or any other attempt.

- [ ] **Step 4: Route selected creation actions explicitly**

Navigation resolves the selected creation attempt before resolving a durable
task id. Close calls `abortTaskCreation(slotId)` for a creating slot and normal
close otherwise. Recovery calls `recoverTaskCreation(slotId)`.

Pass the route-specific phase from its matching attempt. Pending-action display
compares against the slot id for a creation and the durable id for a ready task.
Remove the fallback that treats `taskUiSlotToTaskSummary(slot).id` as a durable
task id for creating slots.

Limit the partial-task action sheet to Close Task and Cancel:

```ts
showTaskActionMenu(onSelect, onDismiss, { creationAttempt: true });
```

Ordinary tasks retain View Diff, Advance Stage, Close Task, and Cancel.
While abort is pending, hide/disable Recover task and keep the existing closing
spinner and duplicate-action guard.

- [ ] **Step 5: Run mobile behavior tests and typecheck**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/navigation/RootNavigator.integration.test.tsx src/navigation/RootNavigator.component.test.tsx src/screens/TaskScreen.test.tsx src/screens/taskActionMenu.test.ts
pnpm --dir apps/mobile typecheck
```

Expected: all selected tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit the atomic mobile migration**

```bash
git add apps/mobile/src/state/taskUiSlots.ts apps/mobile/src/state/sessionStore.ts apps/mobile/src/state/sessionPersistence.ts apps/mobile/src/state/mobileController.ts apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/navigation/taskNavigation.ts apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/taskActionMenu.ts apps/mobile/src/appModel.taskCreation.test.ts apps/mobile/src/state/taskUiSlots.test.ts apps/mobile/src/state/sessionStore.test.ts apps/mobile/src/state/sessionPersistence.test.ts apps/mobile/src/state/mobileController.test.ts apps/mobile/src/navigation/RootNavigator.integration.test.tsx apps/mobile/src/navigation/RootNavigator.component.test.tsx apps/mobile/src/screens/TaskScreen.test.tsx apps/mobile/src/screens/taskActionMenu.test.ts
git commit -m "fix(mobile): abort partial tasks independently"
```

### Task 4: Verify compatibility and the complete workflow

**Files:**
- Modify if assertions require it: `apps/mobile/e2e/create-task-coverage.md`
- Test: all files changed above

- [ ] **Step 1: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: all Vitest files PASS with zero failures.

- [ ] **Step 2: Run mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Run the complete Kanna server test target**

Run:

```bash
cargo test -p kanna-server
```

Expected: all server unit and HTTP tests PASS.

- [ ] **Step 4: Run repository-level practical regression tests**

Run:

```bash
pnpm test
```

Expected: Turbo reports all package test tasks successful. If an unrelated
environment-heavy test is intentionally excluded by the canonical command,
record that fact in the final handoff rather than substituting a different
command.

- [ ] **Step 5: Verify formatting, diff scope, and runtime-version decision**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~5
```

Confirm the diff contains only the approved mobile/server behavior and its
tests/docs. Confirm `apps/mobile/src/mobileEnvironments.json` is unchanged
because no native code, Expo SDK, native dependency, native config, certificate,
or config plugin changed.

- [ ] **Step 6: Commit final test/documentation adjustments**

If Task 4 required coverage-document updates:

```bash
git add apps/mobile/e2e/create-task-coverage.md
git commit -m "docs(mobile): cover partial task abort"
```

If no file changed, do not create an empty commit.
