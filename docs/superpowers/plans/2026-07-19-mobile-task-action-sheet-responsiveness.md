# Mobile Task Action Sheet Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the iOS task action sheet open and the task screen responsive by removing the transparent navigation route wrapped around the native sheet.

**Architecture:** `TaskScreen` will own native task-action presentation and call the task callbacks supplied by `TaskDetailRoute`. The root navigator will contain only durable screens; the obsolete `TaskMore` route, its focus-effect presenter, and its transparent touch-intercepting view will be deleted.

**Tech Stack:** React Native 0.86, Expo 57, React Navigation 7, TypeScript, Vitest, react-test-renderer, pnpm

---

## File Structure

- `apps/mobile/src/navigation/RootNavigator.test.ts` — regression assertion for the canonical root-route inventory.
- `apps/mobile/src/navigation/navigationConfig.ts` — canonical route registry; remove `TaskMore`.
- `apps/mobile/src/navigation/navigationState.test.ts` — remove the obsolete projection test that constructs a `TaskMore` route.
- `apps/mobile/src/navigation/navigationState.ts` — root-stack types and active-view projection; remove `TaskMore`.
- `apps/mobile/src/navigation/taskNavigation.test.ts` — retain covered-task routing coverage using a real remaining covering route.
- `apps/mobile/src/navigation/RootNavigator.tsx` — remove route-push plumbing, the transparent screen, and the action-sheet focus effect.
- `apps/mobile/src/screens/TaskScreen.tsx` — remove the route override so `+` always uses the direct native action-sheet path.
- `apps/mobile/src/screens/TaskScreen.test.tsx` — remove the obsolete route-delegation fixture and retain direct action selection coverage.

### Task 1: Lock the Root Stack to Real Screens

**Files:**
- Modify: `apps/mobile/src/navigation/RootNavigator.test.ts`
- Modify: `apps/mobile/src/navigation/navigationConfig.ts`
- Modify: `apps/mobile/src/navigation/navigationState.test.ts`
- Modify: `apps/mobile/src/navigation/navigationState.ts`
- Modify: `apps/mobile/src/navigation/taskNavigation.test.ts`

- [ ] **Step 1: Write the failing route-inventory regression test**

Change the expected root route inventory in `RootNavigator.test.ts` so it excludes `TaskMore`:

```ts
expect(ROOT_STACK_ROUTES).toEqual([
  "MainTabs",
  "TaskDetail",
  "Search",
  "Desktops"
]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/navigation/RootNavigator.test.ts
```

Expected: FAIL because the received array still contains `"TaskMore"`.

- [ ] **Step 3: Remove `TaskMore` from the navigation model**

Change `ROOT_STACK_ROUTES` in `navigationConfig.ts` to:

```ts
export const ROOT_STACK_ROUTES = [
  "MainTabs",
  "TaskDetail",
  "Search",
  "Desktops"
] as const;
```

Change `RootStackParamList` in `navigationState.ts` to:

```ts
export type RootStackParamList = {
  MainTabs: undefined;
  TaskDetail: { taskId: string };
  Search: undefined;
  Desktops: undefined;
};
```

In `projectActiveView`, retain only `TaskDetail` as the route that projects through to its origin:

```ts
case "TaskDetail":
  break;
```

Delete the `projects TaskMore to the task route's underlying Activity origin` test from `navigationState.test.ts`, because callers can no longer construct that route.

In `taskNavigation.test.ts`, preserve the generic covered-detail behavior while replacing the obsolete fixture with a real route:

```ts
it("returns to the existing detail route from a covering screen", () => {
  expect(planTaskDetailNavigation({
    routes: [
      { name: "MainTabs" },
      { name: "TaskDetail", params: { taskId: "task-a" } },
      { name: "Search" }
    ],
    taskId: "task-b",
    pendingTaskId: null
  })).toEqual({ type: "popTo", taskId: "task-b" });
});
```

- [ ] **Step 4: Run the focused navigation-model tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/navigation/RootNavigator.test.ts src/navigation/navigationState.test.ts src/navigation/taskNavigation.test.ts
```

Expected: both test files PASS.

- [ ] **Step 5: Commit the navigation-model change**

```bash
git add apps/mobile/src/navigation/RootNavigator.test.ts apps/mobile/src/navigation/navigationConfig.ts apps/mobile/src/navigation/navigationState.test.ts apps/mobile/src/navigation/navigationState.ts apps/mobile/src/navigation/taskNavigation.test.ts
git commit -m "test(mobile): remove task actions from route inventory"
```

### Task 2: Present Task Actions Directly

**Files:**
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`

- [ ] **Step 1: Remove transparent-route presentation from `RootNavigator`**

Remove `useFocusEffect` and `showTaskActionMenu` imports only if no remaining code uses them. Remove `pushTaskMore` from `NavigationContent`, delete its `StackActions.push("TaskMore")` callback, and remove it from the context value and dependency list.

Delete this root-stack screen declaration:

```tsx
<RootStack.Screen
  component={TaskMoreRoute}
  name="TaskMore"
  options={{
    contentStyle: styles.transparentStackContent,
    headerShown: false,
    presentation: "transparentModal"
  }}
/>
```

Delete the entire `TaskMoreRoute` component. Remove `pushTaskMore` from `TaskDetailRoute`'s context destructuring and remove this prop from its `TaskScreen` render:

```tsx
onOpenTaskActions={pushTaskMore}
```

Delete the now-unused styles:

```ts
transparentStackContent: {
  backgroundColor: "transparent"
},
transparentTaskActions: {
  flex: 1
},
```

- [ ] **Step 2: Remove the obsolete TaskScreen override seam**

Delete `onOpenTaskActions?(): void` from `TaskScreenProps`, remove it from the function parameters, and make the plus button unconditionally use the direct handler:

```tsx
<Pressable
  accessibilityLabel="Task actions"
  accessibilityRole="button"
  style={styles.plusButton}
  testID={MOBILE_E2E_IDS.taskMoreButton}
  onPress={openTaskActionMenu}
>
```

Remove `onOpenTaskActions` from the `renderTaskScreen` test helper and delete the test named `delegates task actions to the navigation route when provided`. Retain the existing tests `opens task actions from the plus button` and `routes the %s task action`; they cover the direct native sheet path and both controller callbacks.

- [ ] **Step 3: Run focused component tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx src/screens/taskActionMenu.test.ts src/navigation/RootNavigator.component.test.tsx src/navigation/RootNavigator.integration.test.tsx
```

Expected: all focused component and action-menu tests PASS.

- [ ] **Step 4: Run the mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: TypeScript exits successfully with no errors, proving no `TaskMore` route or `onOpenTaskActions` references remain.

- [ ] **Step 5: Commit the direct action-sheet fix**

```bash
git add apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/TaskScreen.test.tsx
git commit -m "fix(mobile): present task actions without blocking route"
```

### Task 3: Verify the Mobile Regression Fix

**Files:**
- Verify only; no production files should change.

- [ ] **Step 1: Confirm obsolete route references are gone**

Run:

```bash
rg -n "TaskMore|pushTaskMore|onOpenTaskActions|transparentTaskActions|transparentStackContent" apps/mobile/src
```

Expected: no matches and exit code 1.

- [ ] **Step 2: Run the full mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile Vitest tests PASS.

- [ ] **Step 3: Inspect the final worktree diff**

Run:

```bash
git status --short
git diff --check HEAD~2..HEAD
git log -3 --oneline
```

Expected: no uncommitted implementation changes, no whitespace errors, and the design plus two implementation commits are visible in recent history.
