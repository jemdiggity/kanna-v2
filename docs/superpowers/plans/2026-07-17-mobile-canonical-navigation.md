# Mobile Canonical Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-rolled mobile tab/detail switching with a React Navigation bottom-tab navigator inside a native root stack so Back always returns to the originating screen.

**Architecture:** `NavigationContainer` owns a native root stack containing `MainTabs`, pushed utility routes, and task routes. A bottom-tab navigator owns Tasks, Activity, and More; controller state remains responsible for task data and terminal sessions, while a persisted `activeView` projection is used only to reconstruct cold-start navigation.

**Tech Stack:** React 19, React Native 0.86, Expo 57, React Navigation 7, TypeScript, Vitest, React Test Renderer, WebdriverIO/Appium

---

This Kanna stage delegates commits to a later workflow stage, so the commit steps normally required by the planning workflow are intentionally omitted.

## File Map

- Create `apps/mobile/src/navigation/navigationState.ts`: route param types, initial-state reconstruction, and navigation-to-persistence projection.
- Create `apps/mobile/src/navigation/navigationState.test.ts`: pure route-state regression coverage.
- Rewrite `apps/mobile/src/navigation/RootNavigator.tsx`: real native-stack and bottom-tab navigator plus focused route wrappers.
- Rewrite `apps/mobile/src/navigation/RootNavigator.test.ts`: route inventory and navigator metadata contract coverage.
- Modify `apps/mobile/src/components/FloatingToolbar.tsx`: render navigator-owned tab state through the existing visual toolbar.
- Modify `apps/mobile/src/state/mobileController.ts`: remove routing decisions, expose task-detail focus, and return navigable task ids from task-producing operations.
- Modify `apps/mobile/src/state/mobileController.test.ts`: controller routing-separation, focus, cleanup, and task-id result coverage.
- Modify `apps/mobile/src/App.tsx`: hydrate before navigator mount, host the navigation container, and route successful composer actions.
- Modify `apps/mobile/src/App.component.test.tsx`: app/navigator wiring and action-result coverage.
- Modify `apps/mobile/src/appModel.ts` and `apps/mobile/src/App.test.tsx`: retire the metadata-only navigator model.
- Modify `apps/mobile/src/appShell.ts` and `apps/mobile/src/appShell.test.ts`: remove detail visibility derived from `activeView`.
- Modify `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`: reusable tab-origin list/detail/back flow.
- Modify `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts`: Activity-origin regression test.
- Modify `apps/mobile/package.json` and `pnpm-lock.yaml`: add `@react-navigation/native-stack`.

### Task 1: Define Navigation State and Restoration

**Files:**
- Create: `apps/mobile/src/navigation/navigationState.ts`
- Create: `apps/mobile/src/navigation/navigationState.test.ts`

- [ ] **Step 1: Write failing initial-state and projection tests**

Cover Tasks, Activity, More, Search, Desktops, and task detail layered over Tasks, Activity, and Search. The key regression is:

```ts
it("restores task detail above Activity and projects Activity while detail is active", () => {
  const initialState = buildInitialNavigationState({
    activeView: "recent",
    selectedTaskId: "task-activity"
  });

  expect(rootRouteNames(initialState)).toEqual(["MainTabs", "TaskDetail"]);
  expect(activeMainTab(initialState)).toBe("Activity");
  expect(projectActiveView(initialState)).toBe("recent");
});
```

Also assert Search restores as `MainTabs -> Search -> TaskDetail`, invalid/null selected task omits `TaskDetail`, and `TaskMore` projects the underlying task origin rather than overwriting it.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/navigation/navigationState.test.ts
```

Expected: FAIL because `navigationState.ts` and its exports do not exist.

- [ ] **Step 3: Implement route types and pure state helpers**

Define:

```ts
export type MainTabParamList = {
  Tasks: undefined;
  Activity: undefined;
  More: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  TaskDetail: { taskId: string };
  TaskMore: undefined;
  Search: undefined;
  Desktops: undefined;
};

export function buildInitialNavigationState(input: {
  activeView: MobileView;
  selectedTaskId: string | null;
}): InitialState;

export function projectActiveView(
  state: NavigationState | PartialState<NavigationState> | undefined
): MobileView;
```

Build a stale partial root state so React Navigation rehydrates keys and route names. `TaskDetail` is appended only when a selected task exists and the persisted view represents a detail-capable origin. Projection walks the active root route; when it is `TaskDetail` or `TaskMore`, it inspects the preceding routes and nested active tab.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 command again. Expected: all navigation-state tests PASS.

### Task 2: Separate Task Lifecycle From Routing

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/appShell.ts`
- Modify: `apps/mobile/src/appShell.test.ts`

- [ ] **Step 1: Write failing controller tests**

Add tests proving:

```ts
it("opens a task without rewriting the navigation projection", async () => {
  await controller.bootstrap();
  controller.setNavigationView("recent");
  controller.openTask("task-1");

  expect(store.getState().activeView).toBe("recent");
  expect(store.getState().selectedTaskId).toBe("task-1");
});
```

Add read-dwell tests that call `controller.setTaskDetailVisible(true)`, cover the detail with `false` before one second, restore `true`, and verify the unread task is marked read only after a fresh one-second focused dwell.

Add tests that `createTask`, `recoverTaskCreation`, `runMergeAgent`, and `advanceDesktopTaskStage` resolve to the selected display task id on success and `null` when no navigation should occur.

- [ ] **Step 2: Run the focused controller tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/appShell.test.ts
```

Expected: FAIL because the new controller methods and result contracts do not exist and `openTask()` still writes `activeView = "tasks"`.

- [ ] **Step 3: Implement controller-owned business state only**

Replace `showView` with:

```ts
setNavigationView(view: MobileView): void;
setTaskDetailVisible(visible: boolean): void;
```

Track task-detail focus in one controller-local boolean. `selectedTaskReadState().visible` becomes:

```ts
const visible =
  taskDetailVisible &&
  state.connectionState === "connected" &&
  selectedTaskId !== null;
```

`setTaskDetailVisible` updates the boolean and calls `reconcileSelectedTaskRead()`. `setNavigationView` updates only the persisted projection. Remove `store.setActiveView("tasks")` from `openTask()` and task creation completion.

Change task-producing signatures to:

```ts
createTask(geometry?: MobileTerminalGeometry): Promise<string | null>;
recoverTaskCreation(): Promise<string | null>;
runMergeAgent(taskId: string): Promise<string | null>;
advanceDesktopTaskStage(taskId: string): Promise<string | null>;
```

`completeTaskCreation()` returns the created display id only when the foreground composer requested opening it. Backgrounded creation returns `null`. Merge/stage methods return `taskIdToOpen` after `openTask(taskIdToOpen)` and return `null` after recording an error.

Delete `isTaskDetailVisible` from `appShell.ts`; leave only shell presentation helpers that do not inspect navigation state.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 2 command again. Expected: all focused controller and shell tests PASS.

### Task 3: Install and Build the Canonical Navigator

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Rewrite: `apps/mobile/src/navigation/RootNavigator.tsx`
- Rewrite: `apps/mobile/src/navigation/RootNavigator.test.ts`
- Modify: `apps/mobile/src/components/FloatingToolbar.tsx`

- [ ] **Step 1: Write failing route-inventory tests**

Replace the metadata-only test with assertions for exported route inventories and toolbar mappings:

```ts
expect(MAIN_TAB_ROUTES.map(({ name }) => name)).toEqual([
  "Tasks",
  "Activity",
  "More"
]);
expect(ROOT_STACK_ROUTES).toEqual([
  "MainTabs",
  "TaskDetail",
  "TaskMore",
  "Search",
  "Desktops"
]);
```

Add a toolbar adapter test proving that a navigator state with index `1` renders Activity active and presses call `navigation.navigate("Activity")`, while Search and Create remain utility callbacks rather than tab routes.

- [ ] **Step 2: Run the focused navigator tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/navigation/RootNavigator.test.ts src/components/FloatingToolbar.test.tsx
```

Expected: FAIL because the real route exports and navigator-owned toolbar adapter are absent.

- [ ] **Step 3: Add the compatible native-stack package**

Run:

```bash
pnpm --filter @kanna/mobile add @react-navigation/native-stack@^7.0.0
```

Expected: `apps/mobile/package.json` and `pnpm-lock.yaml` update without adding a new native module dependency.

- [ ] **Step 4: Implement the real navigator**

`RootNavigator.tsx` must create module-level navigators:

```ts
const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createBottomTabNavigator<MainTabParamList>();
```

Export a `RootNavigator` component receiving the current `SessionState`, `MobileController`, initial state, navigation ref, update information, and account/composer callbacks. Configure:

- `MainTabs`, `TaskDetail`, `TaskMore`, `Search`, and `Desktops` on the root native stack;
- Tasks, Activity, and More on the bottom-tab navigator;
- `headerShown: false` for `MainTabs` and `TaskDetail`;
- ordinary native headers and Back behavior for Search, Desktops, and TaskMore; and
- the existing floating toolbar as the tab navigator's custom `tabBar`.

`MainTabsRoute` receives root-stack navigation and pushes `TaskDetail` after `controller.openTask(taskId)`. Activity uses the same handler without changing tabs. Search pushes detail from its own root-stack route. The task `+` button pushes `TaskMore`.

Implement a focused `TaskDetailRoute`:

```ts
useFocusEffect(
  useCallback(() => {
    controller.setTaskDetailVisible(true);
    return () => controller.setTaskDetailVisible(false);
  }, [controller])
);

useEffect(
  () => () => controller.closeTask(),
  [controller]
);
```

Its visible Back button calls `navigation.goBack()`. Do not call `closeTask()` directly from the button; route removal owns cleanup, which also covers system Back and gestures.

`FloatingToolbar` receives `BottomTabBarProps`, derives the active tab from `state.index`, emits tab-press events, and navigates through the supplied navigator. Preserve existing test ids and utility buttons.

- [ ] **Step 5: Run focused navigator tests and typecheck**

Run:

```bash
pnpm --dir apps/mobile test -- src/navigation/RootNavigator.test.ts src/components/FloatingToolbar.test.tsx
pnpm --dir apps/mobile typecheck
```

Expected: tests PASS and TypeScript reports no errors.

### Task 4: Integrate Navigation With App Initialization and Actions

**Files:**
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/App.test.tsx`

- [ ] **Step 1: Write failing App wiring tests**

Mock `RootNavigator` as a host component and assert:

- it is not mounted until `model.initialize()` resolves;
- its `initialState` is built from hydrated `activeView` and `selectedTaskId`;
- its navigation-state callback calls `controller.setNavigationView(projectActiveView(state))`;
- successful foreground creation navigates to `TaskDetail` with the returned id;
- failed/backgrounded creation returning `null` does not navigate; and
- successful task actions from TaskMore pop back to the existing TaskDetail rather than adding a duplicate route.

- [ ] **Step 2: Run the App tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/App.component.test.tsx src/App.test.tsx
```

Expected: FAIL because App still switches directly on `activeView` and the model still exposes the metadata-only navigator.

- [ ] **Step 3: Refactor App into lifecycle host plus navigator**

Add initialization state and a navigation ref:

```ts
const navigationRef = useRef(createNavigationContainerRef<RootStackParamList>()).current;
const [initialized, setInitialized] = useState(false);

useEffect(() => {
  let cancelled = false;
  void model.initialize().then(() => {
    if (!cancelled) {
      setInitialized(true);
      void runOtaUpdateCheck();
    }
  });
  return () => { cancelled = true; };
}, [model, runOtaUpdateCheck]);
```

After initialization, render `RootNavigator` instead of the `activeView` switch. Keep account sheet, task composer, OTA banner, connection lifecycle, and task viewport measurement in App as global overlays/services.

Await composer submission and recovery. Navigate only for a non-null task id:

```ts
const taskId = await controller.createTask(geometry);
if (taskId && navigationRef.isReady()) {
  navigationRef.navigate("TaskDetail", { taskId });
}
```

Remove `createRootNavigator()` metadata from `AppModel`. Static route metadata now belongs to `RootNavigator.tsx`.

- [ ] **Step 4: Run App tests and typecheck**

Run:

```bash
pnpm --dir apps/mobile test -- src/App.component.test.tsx src/App.test.tsx
pnpm --dir apps/mobile typecheck
```

Expected: App tests PASS and TypeScript reports no errors.

### Task 5: Add the Activity-Origin End-to-End Regression

**Files:**
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts`
- Modify if needed: `apps/mobile/e2e/helpers/selectors.ts`

- [ ] **Step 1: Write the failing helper regression test**

Extract a helper that selects a supplied tab, opens its task row, presses Back, and asserts the same tab/list is visible. Add a unit test with Activity as the origin and verify the fake UI call order is:

```ts
[
  "select:recent",
  "open:task-1",
  "back",
  "assert:recent"
]
```

- [ ] **Step 2: Run the E2E helper unit test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/list-detail-back.test.ts
```

Expected: FAIL because the origin-preserving helper is absent.

- [ ] **Step 3: Implement and wire the Activity-origin smoke flow**

Use the existing stable toolbar and task-row accessibility ids. The simulator smoke must:

1. select Activity;
2. open the seeded task;
3. wait for TaskDetail;
4. press the visible Back control; and
5. verify the Activity tab is selected and the Activity task list is present.

Do not add physical-device automation.

- [ ] **Step 4: Run the E2E helper unit test and verify GREEN**

Run the Task 5 command again. Expected: PASS.

### Task 6: Regression Verification

**Files:**
- Review all modified mobile files and the two new planning documents.

- [ ] **Step 1: Run all mobile unit tests**

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile Vitest suites PASS.

- [ ] **Step 2: Run mobile typecheck**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: TypeScript reports no errors.

- [ ] **Step 3: Run repository verification**

```bash
pnpm test
```

Expected: repository test suite PASS. If failures are unrelated and pre-existing, capture the exact failing suite and verify the focused mobile suites still pass.

- [ ] **Step 4: Run diff and dependency checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only navigation implementation, tests, package metadata, and approved design/plan documents are changed.

- [ ] **Step 5: Optional simulator smoke when a dev simulator is available**

Use the repository workflow only:

```bash
./kd dev up --mobile
pnpm --dir apps/mobile run test:e2e:smoke
```

Expected: the Activity-origin list/detail/back regression passes. Do not install, launch, or automate a physical iPhone.
