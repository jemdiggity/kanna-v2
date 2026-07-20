# Mobile Loading Ellipsis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a minimal animated text ellipsis during mobile startup, task creation, and terminal or agent connection without showing false empty-task states.

**Architecture:** A reusable `LoadingText` component owns the timer and accessible terminal-style presentation. Session state explicitly tracks first task-collection readiness; the controller moves that state from loading to ready or error, and task-list screens use it only when no content exists. Existing content remains visible during later refreshes.

**Tech Stack:** React 19, React Native 0.86, TypeScript, Vitest, react-test-renderer

---

## File Structure

- Create `apps/mobile/src/components/LoadingText.tsx`: reusable animated ellipsis label.
- Create `apps/mobile/src/components/LoadingText.test.tsx`: timer, rendering, accessibility, and cleanup coverage.
- Modify `apps/mobile/src/App.tsx` and `apps/mobile/src/App.component.test.tsx`: startup loading label.
- Modify `apps/mobile/src/screens/TaskScreen.tsx`, `TaskScreen.test.tsx`, `AgentMessageView.tsx`, and `AgentMessageView.test.tsx`: creation and connection loading labels.
- Modify `apps/mobile/src/state/sessionStore.ts` and `sessionStore.test.ts`: task-collection readiness state.
- Modify `apps/mobile/src/state/mobileController.ts` and `mobileController.test.ts`: readiness transitions for polling and live cloud.
- Modify `apps/mobile/src/components/TaskList.tsx`, `apps/mobile/src/screens/TasksScreen.tsx`, and `TasksScreen.test.tsx`: pending, error, and genuine empty task-list presentation.
- Modify `apps/mobile/src/navigation/RootNavigator.tsx` and navigation component/integration fixtures: pass readiness into Tasks and Activity.

### Task 1: Reusable terminal-style loading text

**Files:**
- Create: `apps/mobile/src/components/LoadingText.tsx`
- Create: `apps/mobile/src/components/LoadingText.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Create a react-test-renderer test that uses fake timers and asserts the exact sequence and stable accessibility metadata:

```tsx
it("cycles a fixed-width terminal ellipsis", async () => {
  vi.useFakeTimers();
  await act(async () => {
    rendered = create(<LoadingText label="Connecting" testID="loading" />);
  });
  const text = rendered!.root.findByProps({ testID: "loading" });
  expect(text.props.accessibilityLabel).toBe("Connecting, loading");
  expect(text.props.accessibilityRole).toBe("progressbar");
  expect(collectText(text)).toBe(`Connecting.${NBSP}${NBSP}`);

  await act(async () => vi.advanceTimersByTime(400));
  expect(collectText(text)).toBe(`Connecting..${NBSP}`);
  await act(async () => vi.advanceTimersByTime(400));
  expect(collectText(text)).toBe("Connecting...");
  await act(async () => vi.advanceTimersByTime(400));
  expect(collectText(text)).toBe(`Connecting.${NBSP}${NBSP}`);
});

it("clears its animation interval when unmounted", async () => {
  vi.useFakeTimers();
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  await act(async () => {
    rendered = create(<LoadingText label="Loading tasks" />);
  });
  await act(async () => rendered!.unmount());
  expect(clearIntervalSpy).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --dir apps/mobile test src/components/LoadingText.test.tsx`

Expected: FAIL because `LoadingText.tsx` does not exist.

- [ ] **Step 3: Implement the minimal component**

Create the component with one interval, a nested monospace suffix, non-breaking-space padding, and a stable accessible label:

```tsx
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";

const ELLIPSIS_INTERVAL_MS = 400;
const NBSP = "\u00a0";

interface LoadingTextProps {
  label: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export function LoadingText({ label, style, testID }: LoadingTextProps) {
  const [dotCount, setDotCount] = useState(1);
  useEffect(() => {
    const interval = setInterval(
      () => setDotCount((count) => count === 3 ? 1 : count + 1),
      ELLIPSIS_INTERVAL_MS
    );
    return () => clearInterval(interval);
  }, []);
  const suffix = ".".repeat(dotCount).padEnd(3, NBSP);
  return (
    <Text
      accessibilityLabel={`${label}, loading`}
      accessibilityRole="progressbar"
      style={style}
      testID={testID}
    >
      {label}<Text accessible={false} style={styles.ellipsis}>{suffix}</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  ellipsis: { fontFamily: "Menlo" }
});
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `pnpm --dir apps/mobile test src/components/LoadingText.test.tsx`

Expected: PASS with no timer or act warnings.

- [ ] **Step 5: Commit the component**

```bash
git add apps/mobile/src/components/LoadingText.tsx apps/mobile/src/components/LoadingText.test.tsx
git commit -m "feat(mobile): add animated loading ellipsis"
```

### Task 2: Creation and connection loading states

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/AgentMessageView.tsx`
- Modify: `apps/mobile/src/screens/AgentMessageView.test.tsx`

- [ ] **Step 1: Write failing TaskScreen tests**

Mock `LoadingText` as the host string `LoadingText`, then extend the pending test and add state tables:

```tsx
expect(findByType(tree, "LoadingText")?.props).toMatchObject({
  label: "Creating task"
});

it.each([
  ["pending", "Creating task"],
  ["recovering", "Recovering task"]
] as const)("animates %s task creation", (taskCreationPhase, label) => {
  const tree = renderTaskScreen({ taskCreationPhase, taskId: "create:slot-1" });
  expect(findByType(tree, "LoadingText")?.props.label).toBe(label);
});

it.each(["idle", "connecting"] as const)(
  "animates PTY %s connection state",
  (terminalStatus) => {
    const tree = renderTaskScreen({ terminalStatus });
    expect(findByType(tree, "LoadingText")?.props.label).toBe("Connecting");
  }
);

it.each(["closed", "error"] as const)(
  "keeps PTY %s state static",
  (terminalStatus) => {
    expect(findByType(renderTaskScreen({ terminalStatus }), "LoadingText")).toBeNull();
  }
);
```

- [ ] **Step 2: Write the failing AgentMessageView tests**

Mock `LoadingText`, add a recursive host-type finder, and assert it exists only while connecting:

```tsx
vi.mock("../components/LoadingText", () => ({ LoadingText: "LoadingText" }));

function findByType(node: ElementNode, type: unknown): ElementNode | null {
  if (node.type === type) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child && typeof child === "object") {
      const match = findByType(child as ElementNode, type);
      if (match) return match;
    }
  }
  return null;
}

it("animates the agent connection state", () => {
  const tree = renderAgentView([], "connecting");
  expect(findByType(tree, "LoadingText")?.props.label).toBe("Connecting");
  expect(collectText(tree)).not.toContain("Connecting...");
});

it.each(["live", "idle", "error", "closed"] as const)(
  "does not animate the agent %s state",
  (status) => expect(findByType(renderAgentView([], status), "LoadingText")).toBeNull()
);
```

- [ ] **Step 3: Run both test files and verify RED**

Run: `pnpm --dir apps/mobile test src/screens/TaskScreen.test.tsx src/screens/AgentMessageView.test.tsx`

Expected: FAIL because the screens do not render `LoadingText`.

- [ ] **Step 4: Render LoadingText only for active waits**

In `TaskScreen`, derive whether the current overlay is active:

```tsx
const isAnimatedCreation =
  taskCreationPhase === "pending" || taskCreationPhase === "recovering";
const isAnimatedTerminalConnection =
  taskCreationPhase === "idle" &&
  task.agentType !== "agent" &&
  (terminalStatus === "idle" || terminalStatus === "connecting");
```

Use `LoadingText` instead of the overlay `Text` only when either boolean is true. Preserve the existing static label for uncertain, closed, and error states. In `AgentMessageView`, replace the static connecting text with:

```tsx
{status === "connecting" ? (
  <LoadingText label="Connecting" style={styles.mutedText} />
) : null}
```

- [ ] **Step 5: Run both test files and verify GREEN**

Run: `pnpm --dir apps/mobile test src/screens/TaskScreen.test.tsx src/screens/AgentMessageView.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the workspace loading UI**

```bash
git add apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/TaskScreen.test.tsx apps/mobile/src/screens/AgentMessageView.tsx apps/mobile/src/screens/AgentMessageView.test.tsx
git commit -m "feat(mobile): animate task loading labels"
```

### Task 3: Explicit first task-collection readiness

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Write the failing store test**

```ts
it("tracks first task collection readiness", () => {
  const store = createSessionStore();
  expect(store.getState().taskCollectionStatus).toBe("loading");
  store.setTaskCollectionStatus("ready");
  expect(store.getState().taskCollectionStatus).toBe("ready");
  store.setTaskCollectionStatus("error");
  expect(store.getState().taskCollectionStatus).toBe("error");
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `pnpm --dir apps/mobile test src/state/sessionStore.test.ts`

Expected: FAIL because `taskCollectionStatus` and its setter do not exist.

- [ ] **Step 3: Add the store state and setter**

```ts
export type TaskCollectionStatus = "loading" | "ready" | "error";

// SessionState
taskCollectionStatus: TaskCollectionStatus;

// SessionStore
setTaskCollectionStatus(status: TaskCollectionStatus): void;

// initial state
taskCollectionStatus: "loading",

// implementation
setTaskCollectionStatus(taskCollectionStatus) {
  state = { ...state, taskCollectionStatus };
  publish();
},
```

- [ ] **Step 4: Run the store test and verify GREEN**

Run: `pnpm --dir apps/mobile test src/state/sessionStore.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing controller transition tests**

Cover polling, live cloud, non-authoritative supplement, and initial error:

```ts
it("marks polled task collections ready after bootstrap", async () => {
  const store = createSessionStore();
  const controller = createMobileController(createClientMock(), store);
  await controller.bootstrap();
  expect(store.getState().taskCollectionStatus).toBe("ready");
});

it("waits for an authoritative live cloud publication", async () => {
  // capture onUpdate from subscribeCloudTasks
  await controller.bootstrap();
  expect(store.getState().taskCollectionStatus).toBe("loading");
  onUpdate([], { cloudAuthoritative: false });
  expect(store.getState().taskCollectionStatus).toBe("loading");
  onUpdate([], { cloudAuthoritative: true });
  expect(store.getState().taskCollectionStatus).toBe("ready");
});

it("stops initial collection loading when the live subscription errors", async () => {
  await controller.bootstrap();
  onError(new Error("cloud tasks unavailable"));
  expect(store.getState().taskCollectionStatus).toBe("error");
});
```

- [ ] **Step 6: Run controller tests and verify RED**

Run: `pnpm --dir apps/mobile test src/state/mobileController.test.ts`

Expected: FAIL because controller paths do not update readiness.

- [ ] **Step 7: Implement controller readiness transitions**

After `loadCollections` completes reconciliation, call:

```ts
store.setTaskCollectionStatus("ready");
```

In `applyLiveCloudTasks`, call it only for a complete publication:

```ts
if (cloudAuthoritative) {
  store.setTaskCollectionStatus("ready");
}
```

In the live subscription error callback and general bootstrap failure, stop only an outstanding first load:

```ts
if (store.getState().taskCollectionStatus === "loading") {
  store.setTaskCollectionStatus("error");
}
```

When account-scoped task arrays are deliberately cleared for an identity change, reset status to `loading`. Do not reset it in background refresh paths.

- [ ] **Step 8: Run store and controller tests and verify GREEN**

Run: `pnpm --dir apps/mobile test src/state/sessionStore.test.ts src/state/mobileController.test.ts`

Expected: PASS, including existing live-subscription recovery tests.

- [ ] **Step 9: Commit readiness state**

```bash
git add apps/mobile/src/state/sessionStore.ts apps/mobile/src/state/sessionStore.test.ts apps/mobile/src/state/mobileController.ts apps/mobile/src/state/mobileController.test.ts
git commit -m "feat(mobile): track initial task collection readiness"
```

### Task 4: Honest task-list startup states

**Files:**
- Modify: `apps/mobile/src/components/TaskList.tsx`
- Modify: `apps/mobile/src/screens/TasksScreen.tsx`
- Modify: `apps/mobile/src/screens/TasksScreen.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.component.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.integration.test.tsx`

- [ ] **Step 1: Write failing TasksScreen tests**

Add `taskCollectionStatus` to each TasksScreen fixture, add this render helper near the existing `repo` fixture, and assert the three empty-list presentations:

```tsx
function renderTasksScreen({
  taskCollectionStatus = "ready",
  taskSlots = []
}: {
  taskCollectionStatus?: TaskCollectionStatus;
  taskSlots?: TaskUiSlot[];
} = {}): ElementNode {
  if (!TasksScreen) throw new Error("TasksScreen was not loaded");
  return TasksScreen({
    heading: "Tasks",
    repos: [{ id: "repo-1", name: "Repo One" }],
    selectedRepoId: "repo-1",
    taskCollectionStatus,
    taskSlots,
    onOpenTask: vi.fn(),
    onSelectRepo: vi.fn()
  }) as ElementNode;
}

it("shows loading instead of an empty state before the first snapshot", () => {
  const tree = renderTasksScreen({ taskCollectionStatus: "loading", taskSlots: [] });
  expect(findElement(tree, TaskList)?.props).toMatchObject({
    loading: true,
    errorLabel: null
  });
});

it("shows the genuine empty state after a successful empty snapshot", () => {
  const tree = renderTasksScreen({ taskCollectionStatus: "ready", taskSlots: [] });
  expect(findElement(tree, TaskList)?.props.loading).toBe(false);
  expect(findElement(tree, TaskList)?.props.emptyLabel).toBe("No tasks yet.");
});

it("shows a static task load failure", () => {
  const tree = renderTasksScreen({ taskCollectionStatus: "error", taskSlots: [] });
  expect(findElement(tree, TaskList)?.props.errorLabel).toBe("Could not load tasks.");
});

it("keeps task content visible while status is loading", () => {
  const tree = renderTasksScreen({ taskCollectionStatus: "loading", taskSlots: taskSlots });
  expect(findElement(tree, TaskList)?.props.loading).toBe(false);
});
```

- [ ] **Step 2: Run TasksScreen tests and verify RED**

Run: `pnpm --dir apps/mobile test src/screens/TasksScreen.test.tsx`

Expected: FAIL because readiness props do not exist.

- [ ] **Step 3: Implement TaskList and TasksScreen presentation**

Add optional `loading` and `errorLabel` inputs to `TaskList`. When empty, render in priority order:

```tsx
if (!taskSlots.length) {
  return (
    <View collapsable={false} style={styles.emptyCard} testID={testID}>
      {loading ? (
        <LoadingText label="Loading tasks" style={styles.emptyLabel} />
      ) : (
        <Text style={styles.emptyLabel}>{errorLabel ?? emptyLabel}</Text>
      )}
    </View>
  );
}
```

Add required `taskCollectionStatus: TaskCollectionStatus` to `TasksScreen`, then pass:

```tsx
loading={taskCollectionStatus === "loading" && displayedTaskSlots.length === 0}
errorLabel={taskCollectionStatus === "error" ? "Could not load tasks." : null}
```

- [ ] **Step 4: Pass status from navigation**

In both Tasks and Activity routes:

```tsx
taskCollectionStatus={state.taskCollectionStatus}
```

Update navigation state fixtures with `taskCollectionStatus: "ready"`, except tests explicitly exercising initial loading.

- [ ] **Step 5: Run screen and navigation tests and verify GREEN**

Run: `pnpm --dir apps/mobile test src/screens/TasksScreen.test.tsx src/navigation/RootNavigator.component.test.tsx src/navigation/RootNavigator.integration.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit list loading states**

```bash
git add apps/mobile/src/components/TaskList.tsx apps/mobile/src/screens/TasksScreen.tsx apps/mobile/src/screens/TasksScreen.test.tsx apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/navigation/RootNavigator.component.test.tsx apps/mobile/src/navigation/RootNavigator.integration.test.tsx
git commit -m "feat(mobile): distinguish loading and empty task lists"
```

### Task 5: App-shell startup loading label

**Files:**
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`

- [ ] **Step 1: Write the failing app startup test**

Mock `LoadingText` as a host component and extend the deferred initialization test:

```tsx
expect(renderer.root.findByType("LoadingText").props).toMatchObject({
  label: "Starting Kanna",
  testID: MOBILE_E2E_IDS.appStartupLoading
});
expect(renderer.root.findAllByType("RootNavigator")).toHaveLength(0);

initialized.resolve();
await flushMicrotasks();

expect(renderer.root.findAllByType("LoadingText")).toHaveLength(0);
expect(renderer.root.findAllByType("RootNavigator")).toHaveLength(1);
```

Add `appStartupLoading: "mobile.app-startup-loading"` to `apps/mobile/src/e2eTestIds.ts` if using the shared ID catalog, and update its contract test.

- [ ] **Step 2: Run the app test and verify RED**

Run: `pnpm --dir apps/mobile test src/App.component.test.tsx src/e2eTestIds.test.ts`

Expected: FAIL because the startup label and test ID do not exist.

- [ ] **Step 3: Render startup loading text**

Inside the app shell, render a centered state whenever initialization has not finished:

```tsx
{!initialized ? (
  <View style={styles.startupLoading}>
    <LoadingText
      label="Starting Kanna"
      style={styles.startupLoadingText}
      testID={MOBILE_E2E_IDS.appStartupLoading}
    />
  </View>
) : null}
```

Use `flex: 1`, centered alignment, muted blue-gray text, and the existing dark shell background. Initialization errors continue through the existing error view after `initialized` becomes true.

- [ ] **Step 4: Run the app test and verify GREEN**

Run: `pnpm --dir apps/mobile test src/App.component.test.tsx src/e2eTestIds.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit startup loading UI**

```bash
git add apps/mobile/src/App.tsx apps/mobile/src/App.component.test.tsx apps/mobile/src/e2eTestIds.ts apps/mobile/src/e2eTestIds.test.ts
git commit -m "feat(mobile): show startup loading ellipsis"
```

### Task 6: Full verification and documentation check

**Files:**
- Verify: `apps/mobile/src/**/*.ts`
- Verify: `apps/mobile/src/**/*.tsx`
- Verify: `docs/superpowers/specs/2026-07-19-mobile-loading-ellipsis-design.md`

- [ ] **Step 1: Run focused loading tests together**

Run:

```bash
pnpm --dir apps/mobile test \
  src/components/LoadingText.test.tsx \
  src/screens/TaskScreen.test.tsx \
  src/screens/AgentMessageView.test.tsx \
  src/screens/TasksScreen.test.tsx \
  src/state/sessionStore.test.ts \
  src/state/mobileController.test.ts \
  src/navigation/RootNavigator.component.test.tsx \
  src/navigation/RootNavigator.integration.test.tsx \
  src/App.component.test.tsx \
  src/e2eTestIds.test.ts
```

Expected: all focused tests PASS with no unhandled timer warnings.

- [ ] **Step 2: Run mobile typecheck**

Run: `pnpm --dir apps/mobile typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the complete mobile unit suite**

Run: `pnpm --dir apps/mobile test`

Expected: all mobile unit tests PASS.

- [ ] **Step 4: Confirm OTA runtime compatibility is unchanged**

Run: `git diff HEAD~5 -- apps/mobile/src/mobileEnvironments.json apps/mobile/app.config.ts apps/mobile/plugins`

Expected: no native configuration, runtime version, or plugin changes.

- [ ] **Step 5: Inspect the final diff**

Run: `git status --short && git diff --check && git log --oneline -6`

Expected: no whitespace errors; only the scoped mobile implementation, tests, spec, and plan are present.
