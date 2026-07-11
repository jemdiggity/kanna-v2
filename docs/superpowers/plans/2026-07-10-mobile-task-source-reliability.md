# Mobile Task Source Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signed-in mobile task discovery stable by merging cloud and trusted LAN sources, ordering auth/bootstrap/listener state monotonically, and preventing stale navigation state from hiding the shell.

**Architecture:** Firebase auth and the Firestore task index expose explicit initial-readiness boundaries. A cloud/LAN composition client merges complete source snapshots and maintains per-task routes while the controller versions subscriptions and reruns invalidated bootstraps. Signed-in mode remains cloud-first even when a trusted LAN desktop is reachable or the cloud snapshot is empty.

**Tech Stack:** TypeScript, React Native/Expo, Firebase Auth and Firestore, Vitest, pnpm

---

Follow [the approved design](../specs/2026-07-10-mobile-task-source-reliability-design.md). This Kanna stage must not create commits, so every task ends with a test and diff checkpoint.

## File map

- `apps/mobile/src/lib/firebase/auth.ts` and `.test.ts`: initial auth readiness.
- `apps/mobile/src/lib/firebase/taskIndex.ts` and `.test.ts`: atomic, validated multi-desktop snapshots.
- `apps/mobile/src/lib/api/types.ts`: typed cloud owner identity.
- `apps/mobile/src/lib/sources/cloudLanClient.ts` and `.test.ts`: source merge and per-task routing.
- `apps/mobile/src/lib/transports/remoteTransport.ts` and `.test.ts`: replace stale relay routes.
- `apps/mobile/src/appModel.ts`, `appModel.cloudFallback.test.ts`, and `App.test.tsx`: live-cache/source wiring.
- `apps/mobile/src/state/mobileController.ts` and `.test.ts`: bootstrap/subscription ownership.
- `apps/mobile/src/appShell.ts`, `appShell.test.ts`, and `App.tsx`: resolved detail visibility and foreground recovery.

### Task 1: Await authoritative Firebase auth readiness

**Files:**
- Modify: `apps/mobile/src/lib/firebase/auth.ts:24-76`
- Test: `apps/mobile/src/lib/firebase/auth.test.ts:10-115`

- [ ] **Step 1: Write the failing delayed-auth test**

```ts
it("waits for the first authoritative auth observation", async () => {
  const user = createUser("user-restored", "restored@kanna.test");
  let emitAuth: ((user: MobileAuthUser | null) => void) | null = null;
  const sdk = createSdkMock();
  vi.mocked(sdk.onAuthStateChanged).mockImplementation((listener) => {
    emitAuth = listener;
    return () => undefined;
  });
  const session = createMobileAuthSession({ sdk });
  let initialized = false;
  const initialization = session.initialize().then(() => { initialized = true; });

  await Promise.resolve();
  expect(initialized).toBe(false);
  emitAuth?.(user);
  await initialization;
  expect(session.getState()).toEqual({ status: "signedIn", user });
});
```

- [ ] **Step 2: Verify RED**

Run `pnpm --dir apps/mobile test -- src/lib/firebase/auth.test.ts`.
Expected: the new test fails because `initialize()` resolves after registration.

- [ ] **Step 3: Implement one idempotent initial-state promise**

```ts
let initialAuthState: Promise<void> | null = null;

const ensureSubscribed = (): Promise<void> => {
  if (initialAuthState) return initialAuthState;
  initialAuthState = new Promise<void>((resolve, reject) => {
    let firstObservationPending = true;
    try {
      unsubscribeFromSdk = sdk.onAuthStateChanged((user) => {
        publish(normalizeUserState(user));
        if (firstObservationPending) {
          firstObservationPending = false;
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
  return initialAuthState;
};
```

Make `initialize()` await `ensureSubscribed()`.

- [ ] **Step 4: Verify GREEN and diff hygiene**

Rerun the Task 1 test command, then run `git diff --check -- apps/mobile/src/lib/firebase/auth.ts apps/mobile/src/lib/firebase/auth.test.ts`.
Expected: all auth tests pass and diff check is silent.

### Task 2: Publish atomic Firestore task snapshots

**Files:**
- Modify: `apps/mobile/src/lib/firebase/taskIndex.ts:1-241`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts:1-330`

- [ ] **Step 1: Write failing listener-order tests**

Capture root and child callbacks. Prove that two initial desktops emit nothing after only the first child settles, a removed child's late callback cannot resurrect tasks, child/root errors retain last-good data without publishing partial or stale aggregates, and unsubscribe rejects every late callback.

```ts
expect(onUpdate).not.toHaveBeenCalled();
desktopB.onNext({ docs: [] });
expect(onUpdate).toHaveBeenLastCalledWith([
  expect.objectContaining({ id: "cloud-task-a" })
]);
removedDesktop.onNext(snapshotWith("resurrected"));
expect(onUpdate).toHaveBeenLastCalledWith([]);
```

- [ ] **Step 2: Write failing validation and stable-order tests**

Extend the wished-for subscription signature with:

```ts
export interface CloudTaskIndexError {
  scope: "root" | "desktop" | "document";
  desktopId?: string;
  error: unknown;
}
```

Assert a malformed document is reported/skipped while a valid peer remains, and equal `updatedAt` values sort by mapped task identity ascending.

- [ ] **Step 3: Verify RED**

Run `pnpm --dir apps/mobile test -- src/lib/firebase/taskIndex.test.ts`.
Expected: partial emission, missing error callback, unsafe casts, and unstable tie order fail.

- [ ] **Step 4: Replace prime-plus-listener state with versioned child listeners**

Remove `primeTasks`. Populate the entire pending set before installing children, and gate callbacks by generation:

```ts
const childGenerations = new Map<string, number>();
const pendingDesktopIds = new Set<string>();
let nextGeneration = 0;

const emit = () => {
  if (cancelled || pendingDesktopIds.size > 0) return;
  onUpdate(mapAndSortSnapshots([...tasksByDesktop.values()].flat(), onError));
};

const generation = ++nextGeneration;
childGenerations.set(desktopId, generation);
const isCurrent = () =>
  !cancelled && childGenerations.get(desktopId) === generation;
```

On child success replace that desktop's full slice, settle it, and emit. On child error retain its slice, keep that desktop pending in the hydration barrier, and call `onError`; the app-model recovery owner then replaces the subscription with a complete one-shot read before restarting live listeners. Invalidate the generation before remove/re-add/unsubscribe. Give the root listener an error callback that leaves the aggregate intact.

- [ ] **Step 5: Validate documents and stabilize sorting**

Parse required owner/title/stage/repo/`updatedAt` fields instead of casting. Map `localRepoId` to `CloudTaskSummary.ownerLocalRepoId`. Use:

```ts
const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
return byUpdatedAt !== 0
  ? byUpdatedAt
  : stableTaskIdentity(left).localeCompare(stableTaskIdentity(right));
```

- [ ] **Step 6: Verify GREEN and diff hygiene**

Rerun Task 2 tests, then `git diff --check` for both task-index files.
Expected: all pass; no warnings leak from expected error tests; diff check is silent.

### Task 3: Compose cloud and LAN sources with per-task routes

**Files:**
- Create: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Create: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Modify: `apps/mobile/src/lib/api/types.ts:69-78`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts:75-170`
- Test: `apps/mobile/src/lib/transports/remoteTransport.test.ts`

- [ ] **Step 1: Type owner metadata**

Add optional `ownerDesktopId`, `ownerLocalRepoId`, `ownerLocalTaskId`, and `ownerOnline` fields to `TaskSummary`.

- [ ] **Step 2: Write failing pure merge tests**

Use the desired API:

```ts
const result = mergeCloudAndLanTasks({
  cloudTasks,
  lan: { desktopId: "desktop-lan", tasks: lanTasks }
});
```

Cover different cloud/LAN IDs for one duplicate, a same-local-ID task on another desktop, cloud-only plus LAN-only rows, LAN mutable metadata precedence, successful same-owner LAN absence, and `lan: null` retaining cloud. Assert duplicate route `{ source: "lan", taskId: "local-task", desktopId: "desktop-lan" }` is keyed by the displayed cloud ID.

- [ ] **Step 3: Verify merge RED**

Run `pnpm --dir apps/mobile test -- src/lib/sources/cloudLanClient.test.ts`.
Expected: module-not-found failure.

- [ ] **Step 4: Implement merge output**

```ts
export type DisplayTaskRoute =
  | { source: "cloud"; taskId: string }
  | { source: "lan"; taskId: string; desktopId: string };

export interface MergedTaskSnapshot {
  tasks: TaskSummary[];
  routes: Map<string, DisplayTaskRoute>;
}
```

Match owner desktop/task and owner-local repo when present. Preserve cloud ID/repository/owner fields, fill a missing owner-local repo from the matched LAN task, overlay non-null LAN title/stage/snippet/agent type, suppress proven stale same-owner cloud rows, and append unused LAN rows.

- [ ] **Step 5: Write failing composed-client routing tests**

After `listRecentTasks`, assert duplicates and LAN-only tasks route streams/actions to raw LAN IDs, cloud-only tasks route cloud, failed/timed-out LAN reprobes retain last-good display IDs and routes even when cloud duplicate/collision membership changes, repository mismatches remain separate, a later cloud owner-repo enrichment still matches a projection first learned from LAN, same-turn task collection readers share one route-backed snapshot, an authoritative publication bypasses a hung incidental read, a late successful LAN result cannot be downgraded by the same read, explicit LAN disablement replaces preserved routes with cloud, failed mutations are not cross-retried, and `createTask` uses LAN only when `input.desktopId` matches its reachable desktop.

```ts
client.observeTaskAgent("cloud-task", listener);
await client.closeTask("lan-only-task");
expect(lan.observeTaskAgent).toHaveBeenCalledWith("local-task", listener);
expect(lan.closeTask).toHaveBeenCalledWith("lan-only-task");
```

- [ ] **Step 6: Implement `createCloudLanClient`**

```ts
export function createCloudLanClient(
  cloud: KannaClient,
  lan: KannaClient,
  options: { isLanEnabled(): boolean }
): KannaClient;
```

Load cloud tasks and, when enabled, a LAN status/full recent-task snapshot with `Promise.allSettled`. Tolerate one failed read source, reject when both fail and no cached source exists, and atomically replace the route map only for the newest read epoch. Coalesce same-turn recent/repository/search calls into one composed batch, but always give `listRecentTasksWithSupplement` a fresh authoritative read so a Firestore callback cannot join an older or hung incidental snapshot. Incidental calls during an authoritative replacement use the accepted last-good projection. Filter the merged snapshot for repo/search views; merge repo/desktop lists by ID. Mutations select exactly one route.

- [ ] **Step 7: Write and fix the stale relay-route regression**

In `remoteTransport.test.ts`, publish snapshot A with a route then snapshot B without it and assert the old route is not reused. Replace the route map from every fresh complete cloud snapshot:

```ts
cloudTaskRoutes.clear();
for (const task of tasks) {
  if (isCloudTaskRoute(task)) {
    cloudTaskRoutes.set(task.id, {
      desktopId: task.ownerDesktopId,
      taskId: task.ownerLocalTaskId
    });
  }
}
```

When `listCloudTasks` exists, search the fresh cloud snapshot rather than invoking a selected desktop.

- [ ] **Step 8: Verify GREEN and diff hygiene**

Run `pnpm --dir apps/mobile test -- src/lib/sources/cloudLanClient.test.ts src/lib/transports/remoteTransport.test.ts`, then `git diff --check` for Task 3 files.
Expected: all pass and diff check is silent.

### Task 4: Wire merged live snapshots into the app model

**Files:**
- Modify: `apps/mobile/src/appModel.ts:84-580`
- Modify: `apps/mobile/src/appModel.cloudFallback.test.ts`
- Modify: `apps/mobile/src/App.test.tsx:280-575`

- [ ] **Step 1: Write failing cloud-plus-LAN integration tests**

Change signed-in/trusted-LAN expectations to remote mode with cloud-only, duplicate, and LAN-only rows together. Add a callback-order test where merge A is deferred, cloud callback B resolves first, and A later cannot replace B.

- [ ] **Step 2: Verify RED**

Run `pnpm --dir apps/mobile test -- src/appModel.cloudFallback.test.ts src/App.test.tsx`.
Expected: current fallback selects one source and lacks callback versions.

- [ ] **Step 3: Track live readiness, not task count**

```ts
let liveCloudTasks: TaskSummary[] = [];
let liveCloudTasksReady = false;
let liveSubscriptionEpoch = 0;
```

Use cached tasks whenever ready, including `[]`; use one-shot Firestore only before readiness. Always dedupe cloud IDs even when relay presence is unknown/empty.

- [ ] **Step 4: Return `createCloudLanClient` for signed-in mode**

Remove `hasLiveCloudTasks`, `useLanFallback`, and task-count source decisions:

```ts
return createCloudLanClient(cloudClient, lanClient, {
  isLanEnabled: () => !forceCloud && hasTrustedLanPeer(getTrustedDesktops())
});
```

Keep disconnected and signed-out LAN-only paths.

- [ ] **Step 5: Version subscription merges and recover errors**

Extend the controller adapter with `onError`. Each Firestore callback updates cache and queues `activeClient.listRecentTasks` through a single-flight drain with one trailing-latest slot; relay-presence and Bonjour service changes enter the same drain. Reuse the endpoint validated by LAN status for the rest of that snapshot. Apply only the current subscription epoch and client generation. On task-index error retain cache, surface `onError`, clear queued publication, and attempt the same versioned one-shot merged read. Invalidate before unsubscribe/clear.

```ts
const revision = ++updateRevision;
const tasks = await activeClient.listRecentTasks();
if (epoch === liveSubscriptionEpoch && revision === updateRevision) onUpdate(tasks);
```

- [ ] **Step 6: Verify GREEN and diff hygiene**

Rerun Task 4 tests, then `git diff --check` for Task 4 files.
Expected: all pass with both sources visible.

### Task 5: Give the controller monotonic bootstrap and live ownership

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts:40-535`
- Test: `apps/mobile/src/state/mobileController.test.ts:145-330,836-1168,1370-1415`

- [ ] **Step 1: Write failing queued-bootstrap/deferred-live tests**

Defer the first `getStatus`, emit sign-in during it, then require a second status run. In remote mode seed old tasks/selection, defer the first subscription snapshot, and assert bootstrap neither polls task lists nor clears old state before the snapshot.

- [ ] **Step 2: Write failing obsolete/empty snapshot tests**

Capture generation A, refresh into generation B, invoke A and assert no mutation. Emit `[]` from B and assert selection reconciles only then.

- [ ] **Step 3: Verify RED**

Run `pnpm --dir apps/mobile test -- src/state/mobileController.test.ts`.
Expected: in-flight auth bootstrap is absorbed, remote bootstrap polls, and obsolete callbacks mutate state.

- [ ] **Step 4: Queue one trailing bootstrap**

```ts
let bootstrapRequested = false;
const bootstrap = (): Promise<void> => {
  bootstrapRequested = true;
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      do {
        bootstrapRequested = false;
        await doBootstrap();
      } while (bootstrapRequested);
    })().finally(() => { bootstrapInFlight = null; });
  }
  return bootstrapInFlight;
};
```

- [ ] **Step 5: Version live ownership and remove eager polling**

Increment `cloudSubscriptionEpoch` on start/stop; gate update/error callbacks. Remove `liveCloudTasksApplied`. Signed-in remote bootstrap starts the subscription and refreshes desktops but does not poll/reconcile task collections before a complete live snapshot. Errors preserve tasks and set only the message.

- [ ] **Step 6: Guard LAN polling commits**

Capture `taskCollectionsRevision` before each collection read, commit only if unchanged, and increment it for every accepted polling/live snapshot. Apply search results under the same query/revision.

- [ ] **Step 7: Verify GREEN and diff hygiene**

Rerun Task 5 tests, then `git diff --check` for controller files.
Expected: all pass and diff check is silent.

### Task 6: Resolve task detail before hiding shell controls

**Files:**
- Modify: `apps/mobile/src/appShell.ts:1-33`
- Test: `apps/mobile/src/appShell.test.ts:1-45`
- Modify: `apps/mobile/src/App.tsx:56-130,135-315`

- [ ] **Step 1: Write failing resolved-detail tests**

```ts
expect(isTaskDetailVisible("connected", false, "tasks")).toBe(false);
expect(isTaskDetailVisible("idle", true, "tasks")).toBe(false);
expect(isTaskDetailVisible("connected", true, "tasks")).toBe(true);
expect(isTaskDetailVisible("connected", true, "more")).toBe(false);
expect(shouldShowTopBar(false)).toBe(true);
expect(shouldShowFloatingToolbar(false)).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run `pnpm --dir apps/mobile test -- src/appShell.test.ts`.
Expected: raw-ID signatures/idle behavior fail.

- [ ] **Step 3: Implement one detail boolean and use it everywhere**

```ts
export function isTaskDetailVisible(
  connectionState: ConnectionState,
  hasSelectedTask: boolean,
  activeView: MobileView
): boolean {
  return connectionState === "connected" && hasSelectedTask && activeView !== "more";
}
export const shouldShowTopBar = (visible: boolean) => !visible;
export const shouldShowFloatingToolbar = (visible: boolean) => !visible;
```

Move `selectedTask` resolution before visibility in `App.tsx`; pass the one boolean to styling, content, top bar, and toolbar.

- [ ] **Step 4: Refresh on foreground from every state**

Remove the `connectionState === "connected"` guard:

```ts
if (shouldRefreshOnAppStateTransition(previousState, nextState)) {
  void controller.refresh();
}
```

Keep the immediate OTA-reload return.

- [ ] **Step 5: Verify GREEN and diff hygiene**

Run `pnpm --dir apps/mobile test -- src/appShell.test.ts src/appLifecycle.test.ts`, then `git diff --check` for Task 6 files.
Expected: all pass and diff check is silent.

### Task 7: Prove production-like startup and run the mobile gate

**Files:**
- Test: `apps/mobile/src/App.test.tsx`
- Test: `apps/mobile/src/appModel.cloudFallback.test.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Add the full model race regression**

Create a signed-in model with preserved trusted desktop/repo/stale task selection. Defer Firestore's first callback, return LAN-only tasks, then publish cloud-only plus duplicate tasks. Assert remote connected mode, displayed IDs `cloud-only`, `cloud-duplicate`, `lan-only`, and reconciliation of the stale selected ID. Resolve older deferred source work and assert the list is unchanged.

- [ ] **Step 2: Run the focused reliability suite**

```bash
pnpm --dir apps/mobile test -- \
  src/lib/firebase/auth.test.ts \
  src/lib/firebase/taskIndex.test.ts \
  src/lib/sources/cloudLanClient.test.ts \
  src/lib/transports/remoteTransport.test.ts \
  src/appModel.cloudFallback.test.ts \
  src/state/mobileController.test.ts \
  src/appShell.test.ts \
  src/appLifecycle.test.ts \
  src/App.test.tsx
```

Expected: every listed file passes with zero failing tests.

- [ ] **Step 3: Run all mobile tests and type checking**

```bash
pnpm --dir apps/mobile test
pnpm --dir apps/mobile typecheck
```

Expected: all mobile tests pass and TypeScript exits 0.

- [ ] **Step 4: Inspect final worktree**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only the spec, plan, and scoped mobile source/tests change; no generated iOS or unrelated files.

- [ ] **Step 5: Obtain independent code review and reverify**

Ask a review agent to compare the final diff to the approved design. Address verified correctness gaps only, then rerun affected focused tests, the complete mobile suite, typecheck, and diff checks.

- [ ] **Step 6: Prepare production-device verification without publishing**

Do not deploy cloud services, publish OTA, push, or create a PR. The new production Release must be installed while preserving app data to prove the original production state now displays tasks; perform that device mutation only under the user's explicit current-session direction.
