# Mobile Task Source Reliability Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the review gaps in hybrid cloud/LAN recovery, task identity and route continuity, bounded retry/probe work, and cross-boundary startup/hydration coverage.

**Architecture:** Keep Firestore authoritative for cloud membership while allowing the composed client to publish an independently successful trusted-LAN projection. Carry publication authority and stable route identity across the app-model/client/controller boundary so errors, selection, repositories, and streams change only when their owning source genuinely changes. Bound terminal Firestore recovery with cancellable exponential backoff and coalesce never-settling optional LAN probes.

**Tech Stack:** TypeScript, React Native, Vitest fake timers/deferred promises, Firebase Auth/Firestore mocked SDK callbacks, WebdriverIO/Appium.

**Workflow note:** This Kanna stage owns commits after manual advancement, so these steps do not create local commits.

---

### Task 1: Publish independent LAN recovery without clearing cloud failure

**Files:**
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Test: `apps/mobile/src/appModel.cloudFallback.test.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Add a failing app-model recovery regression**

Create a signed-in model with persisted trusted LAN, capture the initial task-index listener, reject its one-shot recovery read, and return a LAN task from `/v1/tasks/recent`. Assert that the LAN task becomes visible, the formatted cloud error remains, no empty cloud snapshot is accepted, and a later restarted listener callback replaces the fallback with the complete hybrid snapshot and clears the error.

```ts
subscriptions[0].onError({ scope: "root", error: cloudFailure });
recovery.reject(cloudFailure);
await vi.waitFor(() => {
  expect(state().recentTasks.map(({ id }) => id)).toEqual(["lan-only"]);
  expect(state().errorMessage).toBe("Cloud task index root: cloud unavailable");
});
subscriptions[1].onUpdate([recoveredCloudDuplicate]);
await vi.waitFor(() => {
  expect(state().recentTasks.map(({ id }) => id)).toEqual([
    recoveredCloudDuplicate.id,
    "lan-only"
  ]);
  expect(state().errorMessage).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/appModel.cloudFallback.test.ts`

Expected: the model retains an empty/old task collection because `recoverCurrentTasks` never publishes after the rejected one-shot, or a fallback publication incorrectly clears the cloud error.

- [ ] **Step 3: Carry publication authority through the controller adapter**

Extend the optional subscription callback with an optional authority value whose default remains cloud-authoritative for existing callers.

```ts
export interface CloudTaskPublication {
  cloudAuthoritative: boolean;
}

subscribeCloudTasks?: (
  uid: string,
  onUpdate: (tasks: TaskSummary[], publication?: CloudTaskPublication) => void,
  onError?: (error: unknown) => void,
) => () => void;
```

Pass `publication?.cloudAuthoritative !== false` into `applyLiveCloudTasks`; clear `cloudSubscriptionError` only for an authoritative publication. Live listener callbacks and successful one-shot recovery use `true`; an independent LAN fallback uses `false`.

- [ ] **Step 4: Preserve a failed cloud read as failure, then publish the composed LAN result**

Track the current task-index read failure separately from `liveCloudTasksReady`. Make `listCloudTasksForRouting` reject with that failure while no authoritative cache exists, so a composed read can accept LAN without converting the cloud side into `[]`. On a failed recovery one-shot, invoke the same versioned composed publication with `cloudAuthoritative: false`; clear the stored read failure only after a listener callback or successful one-shot.

```ts
let liveCloudTasksReadError: unknown | null = null;

if (isLiveCloudTasksReady() && getLiveCloudTasksUid() === uid) return cached;
if (getLiveCloudTasksReadError()) throw getLiveCloudTasksReadError();
return taskIndex.listRecentTasks(uid);
```

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/appModel.cloudFallback.test.ts src/state/mobileController.test.ts`

Expected: the new fallback/recovery tests and existing error ownership tests pass.

### Task 2: Reconcile created local identity and genuine route changes

**Files:**
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Test: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Test: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Test: `apps/mobile/src/appModel.cloudFallback.test.ts`

- [ ] **Step 1: Add failing create identity tests using the publisher shape**

Create a task whose response is local `task-created`, then publish a snapshot mapped through `mapCloudTaskSnapshot` without `cloudTaskId`:

```ts
const canonical = mapCloudTaskSnapshot({
  localRepoId: "repo-local",
  ownerDesktopId: "desktop-a",
  ownerLocalTaskId: "task-created",
  title: "Created task",
  stage: "in progress",
  repo: { cloudRepoId: "repo-cloud", name: "Repo" },
  updatedAt: "2026-07-11T00:00:00.000Z"
});
```

Assert the raw selection is migrated to `cloud:desktop-a:repo-local:task-created`, detail remains open, the raw stream closes once, the canonical stream opens once, and later unchanged snapshots do not reopen it.

- [ ] **Step 2: Add failing route-owner continuity tests**

Open an agent task through the real composed client, replace its route from cloud owner A to cloud owner B or cloud to LAN while keeping the display ID, and assert exactly one restart. Then assert input, permission, and interrupt all hit the replacement subscription, while a metadata-only snapshot with the same route does not restart.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm --dir apps/mobile test -- src/lib/sources/cloudLanClient.test.ts src/lib/transports/remoteTransport.test.ts src/state/mobileController.test.ts src/appModel.cloudFallback.test.ts`

Expected: create selection is reconciled away/closed and same-ID owner changes leave the old subscription active.

- [ ] **Step 4: Add optional synchronous route identity to the client contract**

```ts
export interface KannaClient {
  getTaskRouteIdentity?(taskId: string): string;
  // existing methods
}
```

Remote transport returns an identity containing the current routed desktop/local task. The composed client prefixes the effective source and LAN desktop and delegates cloud identity to the remote client. The delegating app client forwards the method.

- [ ] **Step 5: Store route identity with active streams**

```ts
type ActiveTaskAgent = {
  taskId: string;
  routeIdentity: string;
  subscription: TaskAgentSubscription;
};
```

`startTaskAgent` and `startTaskTerminal` return early only when both display ID and route identity match. A true identity change closes/reopens once; unchanged snapshots preserve stream continuity.

- [ ] **Step 6: Generalize pending action identity for create**

Track `{ ownerDesktopId, ownerLocalRepoId }` for the raw create response before opening it. Reconcile by `ownerLocalTaskId`, desktop, and local repo; atomically change selection to the unique canonical display ID, remove the alias, and let route-aware `startTaskView` migrate the stream. Keep the alias while only the raw LAN row is present.

- [ ] **Step 7: Verify GREEN**

Run the Task 2 command again. Expected: all create/route tests pass and unchanged-snapshot stream counts remain one.

### Task 3: Preserve explicit repositories and bound optional LAN probes

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Test: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`

- [ ] **Step 1: Add a failing unselected zero-task repository regression**

Accept explicit repos A and B, publish live tasks only for A, then reject the next repository supplementation. Assert B remains visible even though it is unselected and has zero tasks. Resolve a later current supplementation containing C and assert it replaces the explicit set, leaving task-derived A plus explicit C.

- [ ] **Step 2: Add a fake-timer never-settling LAN probe regression**

Make LAN status or task listing never settle, trigger repeated authoritative/live reads, advance beyond `optionalLanWaitMs` for each caller, and assert all reads resolve from cloud while only one underlying LAN probe is active. Resolve it late and assert a subsequent read may start one fresh probe rather than retaining parallel abandoned calls.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/lib/sources/cloudLanClient.test.ts`

Expected: repo B disappears and repeated callbacks increment the LAN probe call count.

- [ ] **Step 4: Track explicit repositories independently of task-derived repositories**

Add `lastExplicitRepos`. Replace it only after a current successful `listRepos`; reset it on account clear. Immediate live publications use:

```ts
store.setRepos(mergeReposWithTaskRepos(
  preserveSelectedRepo(lastExplicitRepos ?? [], previousState),
  tasks
));
```

An obsolete or failed supplementation never replaces this cache.

- [ ] **Step 5: Share optional LAN work while it is unresolved**

Wrap task, repository, and desktop optional reads in per-kind single-flight
promises that clear only on settlement. The first caller owns the bounded wait
and any late result. Later callers reuse the in-flight ownership barrier and
fall back immediately instead of launching new fetch chains or adopting a
result that predates their refresh.

```ts
const shareInFlight = <T>(read: () => Promise<T>) => {
  let inFlight: Promise<T> | null = null;
  return () => inFlight ??= read().finally(() => { inFlight = null; });
};
```

Keep existing epoch checks for late cache/supplement acceptance.

- [ ] **Step 6: Verify GREEN**

Run the Task 3 command again. Expected: explicit repos survive failure and permanent LAN deferrals remain single-flight.

### Task 4: Back off and cancel Firestore recovery

**Files:**
- Modify: `apps/mobile/src/appModel.ts`
- Test: `apps/mobile/src/appModel.cloudFallback.test.ts`

- [ ] **Step 1: Add permanent-error fake-timer tests**

Fail each restarted listener and one-shot read. Assert retry starts at 1 second, then 2, 4, and caps at 30 seconds; a successful callback resets the next failure to 1 second. Sign out or replace the client while a retry is pending and assert no further subscription is created after timers advance.

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/appModel.cloudFallback.test.ts`

Expected: retries remain fixed at one second and a client-generation replacement can leave a retry callback alive.

- [ ] **Step 3: Implement cancellable exponential backoff**

```ts
const CLOUD_TASK_RECOVERY_INITIAL_RETRY_MS = 1_000;
const CLOUD_TASK_RECOVERY_MAX_RETRY_MS = 30_000;
const delay = Math.min(
  CLOUD_TASK_RECOVERY_INITIAL_RETRY_MS * 2 ** retryAttempt,
  CLOUD_TASK_RECOVERY_MAX_RETRY_MS
);
retryAttempt += 1;
```

Capture epoch, UID, and client generation in the scheduled owner check. Cancel
the timer on unsubscribe/auth invalidation; stop retrying when any owner
component changes. Reset `retryAttempt` only after a live listener callback. A
successful one-shot still repairs and publishes the data snapshot, but retaining
backoff prevents a permanently failing listener from entering an immediate or
fixed one-second retry loop.

- [ ] **Step 4: Verify GREEN**

Run the Task 4 command again. Expected: delay/cancellation/reset assertions pass under fake timers.

### Task 5: Add real auth and Firestore boundary integration coverage

**Files:**
- Test: `apps/mobile/src/App.test.tsx`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts`

- [ ] **Step 1: Wire real restored auth through the app model**

Use `createMobileAuthSession` with `getCurrentUser() === null` and a deferred first `onAuthStateChanged` callback. Hydrate trusted LAN context, begin `model.initialize()`, and assert no LAN request/task publication occurs before the callback. Deliver the restored user, drive the live cloud callback, and assert publication history contains the complete cloud-only/duplicate/LAN-only snapshot but never a LAN-only bootstrap.

- [ ] **Step 2: Wire real Firestore child ordering through app model/controller**

Pass `createFirestoreTaskIndex(mockDb)` into `createAppModel`, drive a root containing desktop A and B, settle only A, and capture every `recentTasks` state publication. Assert no blank or A-only collection is committed. Settle B and assert the first non-empty accepted collection is the complete sorted A+B aggregate.

- [ ] **Step 3: Run integration tests**

Run: `pnpm --dir apps/mobile test -- src/App.test.tsx src/lib/firebase/taskIndex.test.ts`

Expected: both cross-boundary races pass deterministically.

### Task 6: Extend hybrid relaunch coverage and reconcile main expectation

**Files:**
- Modify: `apps/mobile/e2e/run.ts`
- Modify: `apps/mobile/e2e/specs/hybrid/hybrid-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/hybrid-reliability-coverage.md`
- Modify: `tests/remote-e2e/src/lan-layer.e2e.test.ts`

- [ ] **Step 1: Relaunch the simulator app after hybrid sign-in**

Pass the bundle ID into `runHybridTaskFlow`. After the first exact hybrid snapshot, call `terminateApp(bundleId)` and `activateApp(bundleId)` within the same Appium session, wait for the shell, and assert the same exact rows and LAN-preferred duplicate metadata return without filling or submitting credentials again.

- [ ] **Step 2: Update the coverage note**

Document that the lane now proves persisted Firebase auth and trusted-LAN restoration across a real process relaunch. Retain only the blockers that still apply to transient probe and foreground/OTA fault injection.

- [ ] **Step 3: Apply the upstream connection-mode expectation**

Change only `tests/remote-e2e/src/lan-layer.e2e.test.ts` from `connectionMode: "local"` to `connectionMode: "both"`; do not take the unrelated harness deletion from `70736fa0` because this branch intentionally extends that harness.

- [ ] **Step 4: Run the hybrid lane when its simulator stack is available**

Run: `pnpm --dir apps/mobile run test:e2e:hybrid`

Expected: sign-in, relaunch, restored exact hybrid rows, snapshot refresh, and LAN route checks pass. If prerequisites are unavailable, report the exact command failure and keep the deterministic integration substitutes green.

### Task 7: Sequential verification and review

**Files:**
- Verify all modified files

- [ ] **Step 1: Run the requested focused mobile gate**

```bash
pnpm --dir apps/mobile test -- \
  src/lib/firebase/auth.test.ts \
  src/lib/firebase/taskIndex.test.ts \
  src/lib/sources/cloudLanClient.test.ts \
  src/lib/transports/remoteTransport.test.ts \
  src/appModel.cloudFallback.test.ts \
  src/state/mobileController.test.ts \
  src/App.test.tsx \
  src/App.component.test.tsx
```

- [ ] **Step 2: Run mobile typecheck**

Run: `pnpm --dir apps/mobile typecheck`

- [ ] **Step 3: Run repository suites sequentially**

Run `pnpm test`, wait for completion, then run `(cd crates/daemon && cargo test -- --test-threads=1)`.

- [ ] **Step 4: Inspect hygiene and current-worktree scope**

```bash
git diff --check origin/main...HEAD
git diff --check
git status --short
```

- [ ] **Step 5: Obtain independent code review and rerun affected checks**

Ask a review agent to compare the final diff to all six reviewer requirements. Fix only verified gaps, rerun affected focused tests, then repeat the focused gate and typecheck before reporting completion.
