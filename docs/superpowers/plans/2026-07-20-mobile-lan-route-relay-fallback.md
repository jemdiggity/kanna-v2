# Mobile LAN Route Relay Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate an already-open account-owned mobile task from a failed LAN route to its relay fallback at the existing 1,000 ms optional-LAN deadline.

**Architecture:** Treat the optional LAN timeout as the boundary that expires synchronous routing only when Bonjour validation is still pending, while leaving account inventory and ordinary task-read failures intact. A small app-model route-change event connects trusted-LAN validation changes to the mobile controller, which reconciles the selected task through its existing route-identity-aware `startTaskView()` path for PTY, agent, and companion streams.

**Tech Stack:** TypeScript, React Native/Expo, Vitest fake timers, Kanna LAN and relay transports

---

## File structure

- Modify `apps/mobile/src/state/mobileController.ts`: subscribe to effective task-route changes, reconcile the selected stream, and unsubscribe on disposal.
- Modify `apps/mobile/src/state/mobileController.test.ts`: prove the shared controller boundary rebinds an open PTY stream and ignores unchanged route identities.
- Modify `apps/mobile/src/lib/sources/cloudLanClient.ts`: report actual optional LAN timeouts/failures without treating a shared read already in flight as a new failure.
- Modify `apps/mobile/src/lib/sources/cloudLanClient.test.ts`: pin the route-expiry callback to the 1,000 ms optional-read deadline.
- Modify `apps/mobile/src/appModel.ts`: expire trusted synchronous LAN URLs, publish validation changes, and connect them to the controller subscription.
- Modify `apps/mobile/src/appModel.cloudFallback.test.ts`: reproduce the iPhone journey with fake timers, a hanging `/v1/status`, `controller.openTask()`, and PTY migration to relay.

### Task 1: Reconcile selected streams when effective route identity changes

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts:4750`
- Modify: `apps/mobile/src/state/mobileController.ts:80-105, 990-1010, 2258-2268`

- [ ] **Step 1: Write the failing controller test**

Add a test beside the existing buffered-terminal rebinding test. It supplies a route-change subscription, opens one PTY task, changes only `getTaskRouteIdentity()`, and emits the notification:

```ts
it("rebinds the selected terminal when its effective route changes", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  let routeIdentity = "lan:desktop-a:task-1";
  let publishRouteChange: (() => void) | null = null;
  const unsubscribe = vi.fn();
  const streams: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  client.getTaskRouteIdentity = vi.fn(() => routeIdentity);
  client.observeTaskTerminal.mockImplementation(() => {
    const close = vi.fn();
    streams.push({ close });
    return { close };
  });
  const controller = createMobileController(client, store, undefined, {
    subscribeTaskRouteChanges(listener) {
      publishRouteChange = listener;
      return unsubscribe;
    }
  });

  await controller.bootstrap();
  controller.openTask("task-1");
  expect(streams).toHaveLength(1);

  publishRouteChange?.();
  expect(streams).toHaveLength(1);

  routeIdentity = "cloud:task-1";
  publishRouteChange?.();
  expect(streams).toHaveLength(2);
  expect(streams[0]!.close).toHaveBeenCalledOnce();

  controller.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "rebinds the selected terminal when its effective route changes"
```

Expected: TypeScript/Vitest fails because `MobileControllerOptions` has no `subscribeTaskRouteChanges` contract and the notification cannot rebind the selected stream.

- [ ] **Step 3: Add the minimal controller route subscription**

Extend `MobileControllerOptions`, retain the returned unsubscribe function, register after `startTaskView()` exists, and reuse the controller's durable-selection lookup:

```ts
export interface MobileControllerOptions {
  subscribeTaskRouteChanges?: (listener: () => void) => () => void;
}

let taskRoutesUnsubscribe: (() => void) | null = null;

const reconcileSelectedTaskRoute = () => {
  const selectedTaskId = store.getState().selectedTaskId;
  const durableTaskId = durableTaskIdForSelection(selectedTaskId);
  if (durableTaskId && findTask(durableTaskId)) {
    startTaskView(durableTaskId);
  }
};
taskRoutesUnsubscribe =
  options.subscribeTaskRouteChanges?.(reconcileSelectedTaskRoute) ?? null;
```

In `dispose()` add:

```ts
taskRoutesUnsubscribe?.();
taskRoutesUnsubscribe = null;
```

- [ ] **Step 4: Run the focused controller test and verify GREEN**

Run the Step 2 command. Expected: PASS; an unchanged identity is a no-op, a changed identity closes/replaces the PTY subscription, and disposal unsubscribes.

- [ ] **Step 5: Commit the controller boundary**

```bash
git add apps/mobile/src/state/mobileController.ts apps/mobile/src/state/mobileController.test.ts
git commit -m "fix(mobile): reconcile active task route changes"
```

### Task 2: Report actual LAN unavailability at the optional deadline

**Files:**
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.test.ts:2060`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts:38-46, 990-1040`

- [ ] **Step 1: Write the failing cloud/LAN deadline test**

Create a fake-timer test near the existing LAN-disable routing tests. Keep the cloud desktop read immediate and leave the LAN desktop read deferred:

```ts
it("expires LAN routability when the optional desktop read times out", async () => {
  vi.useFakeTimers();
  try {
    const pendingLanDesktops = deferred<DesktopSummary[]>();
    const cloud = createClientMock();
    const lan = createClientMock();
    cloud.listDesktops.mockResolvedValue([
      { id: "desktop-a", name: "Desktop A", online: true, mode: "remote" }
    ]);
    lan.listDesktops.mockReturnValue(pendingLanDesktops.promise);
    const onLanReadUnavailable = vi.fn();
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true,
      optionalLanWaitMs: 1_000,
      onLanReadUnavailable
    });

    const result = client.listDesktops();
    await vi.advanceTimersByTimeAsync(999);
    expect(onLanReadUnavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual([
      expect.objectContaining({ id: "desktop-a", mode: "remote" })
    ]);
    expect(onLanReadUnavailable).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run the cloud/LAN test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/sources/cloudLanClient.test.ts -t "expires LAN routability when the optional desktop read times out"
```

Expected: FAIL because `CloudLanClientOptions` does not expose or invoke `onLanReadUnavailable`.

- [ ] **Step 3: Add the deadline callback**

Extend the option contract:

```ts
export interface CloudLanClientOptions {
  onLanReadUnavailable?(): void;
}
```

In `listDesktops()`, after both source results settle and before publishing warnings/sources, expire LAN routing for any enabled rejected LAN result (including the existing shared-read-in-flight rejection):

```ts
if (
  lanStillEnabled &&
  lanResult?.status === "rejected" &&
  !(lanResult.reason instanceof OptionalLanReadInFlightError)
) {
  options.onLanReadUnavailable?.();
}
```

- [ ] **Step 4: Run the focused cloud/LAN test and verify GREEN**

Run the Step 2 command. Expected: PASS at exactly 1,000 ms.

- [ ] **Step 5: Commit the source deadline boundary**

```bash
git add apps/mobile/src/lib/sources/cloudLanClient.ts apps/mobile/src/lib/sources/cloudLanClient.test.ts
git commit -m "fix(mobile): expire LAN routes at optional timeout"
```

### Task 3: Migrate an already-open app-model PTY route to relay

**Files:**
- Modify: `apps/mobile/src/appModel.cloudFallback.test.ts:3929`
- Modify: `apps/mobile/src/appModel.ts:130-260, 700-830, 925-1055`

- [ ] **Step 1: Replace the inadequate regression with the failing user-journey test**

Use `vi.useFakeTimers()`, `createMutableBonjourBrowser([service])`, a `statusProbeShouldHang` switch, and `deferred<Response>()`. The fetch mock returns a valid status during initialization, then returns the deferred promise for every later `/v1/status` request. Publish one cloud task with a matching LAN task, open it through the controller, and capture the LAN WebSocket terminal subscription:

```ts
const accountTask = cloudTask({
  id: "cloud:desktop-lan:repo-lan:local-task",
  ownerDesktopId: "desktop-lan",
  ownerLocalRepoId: "repo-lan",
  ownerLocalTaskId: "local-task",
  agentType: "pty"
});

await app.initialize();
pushCloudTasks?.([accountTask]);
await flushAsyncWork(12);
app.controller.openTask(accountTask.id);
expect(lanTerminalSocket).toBeDefined();
expect(relayClient.observeTaskTerminal).not.toHaveBeenCalled();

statusProbeShouldHang = true;
bonjour.setServices([service]);
await vi.advanceTimersByTimeAsync(999);
expect(relayClient.observeTaskTerminal).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
await flushAsyncWork(12);

expect(lanTerminalSocket!.close).toHaveBeenCalledOnce();
expect(relayClient.observeTaskTerminal).toHaveBeenCalledWith(
  { desktopId: "desktop-lan", taskId: "local-task" },
  expect.any(Function)
);
expect(app.sessionStore.getState()).toMatchObject({
  selectedTaskId: accountTask.id,
  taskTerminalTaskId: accountTask.id
});
expect(app.sessionStore.getState().auth.status).toBe("signedIn");
expect(app.sessionStore.getState().accountDesktops).toEqual([
  expect.objectContaining({ id: "desktop-lan", mode: "remote" })
]);
```

Ensure the test's `finally` block disposes the controller, restores real timers, and leaves the deferred status probe unresolved so it truly covers the 1,000 ms deadline rather than the five-second late result.

- [ ] **Step 2: Run the app-model regression and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- appModel.cloudFallback.test.ts -t "migrates an open account task to relay when LAN validation times out"
```

Expected: FAIL because the LAN terminal remains open and the relay terminal observer is never called at 1,000 ms.

- [ ] **Step 3: Add trusted-route invalidation and route-change publication**

In `createAppModel()`, create a stable listener set before resolving the active client:

```ts
const taskRouteListeners = new Set<() => void>();
const publishTaskRouteChange = () => {
  for (const listener of taskRouteListeners) listener();
};
```

Pass `publishTaskRouteChange` into `createClientForMode()` as `onTaskRoutesChanged`, and pass this controller option:

```ts
subscribeTaskRouteChanges(listener) {
  taskRouteListeners.add(listener);
  return () => taskRouteListeners.delete(listener);
}
```

Extend `createTrustedLanFallbackClient()` with `onValidatedRoutesChanged`, pending-validation tracking, and an `invalidatePendingValidatedRoutes()` method. Add a focused string-map equality helper and centralize cache replacement so callbacks fire only when the desktop-to-URL mapping actually changes:

```ts
function areStringMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

const publishIfChanged = (previous: Map<string, string>) => {
  if (!areStringMapsEqual(previous, validatedBaseUrls)) {
    onValidatedRoutesChanged();
  }
};

invalidatePendingValidatedRoutes() {
  if (pendingValidationCount > 0) invalidateValidatedRoutes();
}
```

Use the same change detection when a successful `resolveClient()` adds a URL and when `listDesktops()` replaces the validated endpoint map. Keep `clientForDesktop()` returning `null` for any URL absent from the current map.

Finally wire the cloud/LAN boundary:

```ts
const composedClient = createCloudLanClient(cloudClient, trustedLanClient.client, {
  isLanEnabled: () => !forceCloud && getTrustedDesktopIds().length > 0,
  lanClientForDesktop: trustedLanClient.clientForDesktop,
  initialDesktopSources: getMachineSourceDesktops(),
  onDesktopSourceWarnings: onMachineSourceWarnings,
  onDesktopSourcesChanged: onMachineSourcesChanged,
  onLanReadUnavailable:
    trustedLanClient.invalidatePendingValidatedRoutes
});
```

This ordering clears synchronous LAN eligibility before the callback reaches the controller. `startTaskView()` then observes the cloud fallback identity and replaces PTY, agent, and companion subscriptions through the controller's route-identity checks.

- [ ] **Step 4: Run the app-model regression and verify GREEN**

Run the Step 2 command. Expected: PASS at the 1,000 ms boundary without resolving the hanging status probe.

- [ ] **Step 5: Run all focused routing/controller tests**

```bash
pnpm --dir apps/mobile test -- appModel.cloudFallback.test.ts src/lib/sources/cloudLanClient.test.ts src/state/mobileController.test.ts
```

Expected: PASS, including validated-LAN preference, LAN-only unavailability, PTY rebinding, and buffered-event generation guards.

- [ ] **Step 6: Commit the app-model integration**

```bash
git add apps/mobile/src/appModel.ts apps/mobile/src/appModel.cloudFallback.test.ts
git commit -m "fix(mobile): migrate timed-out LAN streams to relay"
```

### Task 4: Verify the complete revision

**Files:**
- Verify only; no expected source changes.

- [ ] **Step 1: Run mobile typechecking**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 2: Run the repository test suite**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run daemon tests serially**

```bash
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git log --oneline -5
```

Expected: no whitespace errors; only the planned mobile routing/test files and design/plan documentation differ from the pre-revision branch.
