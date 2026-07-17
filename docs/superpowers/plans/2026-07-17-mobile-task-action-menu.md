# Mobile Task Action Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the mobile task detail `+` button open a task-scoped Advance Stage / Close Task menu instead of navigating to More.

**Architecture:** Add a platform-menu adapter beside the existing quick-reply adapter, then have `TaskScreen` translate menu selections into explicit callbacks. `App` binds those callbacks to the selected task id and reuses the existing controller actions; navigation, transport, and the global More palette remain unchanged.

**Tech Stack:** React Native, React 19, TypeScript, Vitest, react-test-renderer, pnpm

---

### Task 1: Platform Task Action Menu

**Files:**
- Create: `apps/mobile/src/screens/taskActionMenu.ts`
- Create: `apps/mobile/src/screens/taskActionMenu.test.ts`

- [x] **Step 1: Write the failing iOS tests**

Create `taskActionMenu.test.ts` with hoisted mocks for `ActionSheetIOS`, `Alert`, and mutable `Platform.OS`, following `taskQuickReplyMenu.test.ts`. Import `showTaskActionMenu` and assert:

```ts
expect(nativeMocks.actionSheet).toHaveBeenCalledWith(
  {
    title: "Task Actions",
    options: ["Advance Stage", "Close Task", "Cancel"],
    cancelButtonIndex: 2,
    destructiveButtonIndex: 1
  },
  expect.any(Function)
);
```

Call the captured callback with indices `0`, `1`, `2`, and `99`. Expect `0` to emit `"advance-stage"`, `1` to emit `"close-task"`, and cancel/invalid indices to emit nothing.

- [x] **Step 2: Verify RED**

Run `pnpm --dir apps/mobile test src/screens/taskActionMenu.test.ts`.

Expected: FAIL because `./taskActionMenu` does not exist.

- [x] **Step 3: Implement the platform adapter**

Create `taskActionMenu.ts`:

```ts
import { ActionSheetIOS, Alert, Platform } from "react-native";

export type TaskAction = "advance-stage" | "close-task";

const TASK_ACTIONS: ReadonlyArray<{
  id: TaskAction;
  label: string;
  style?: "destructive";
}> = [
  { id: "advance-stage", label: "Advance Stage" },
  { id: "close-task", label: "Close Task", style: "destructive" }
];

const MENU_TITLE = "Task Actions";
const CANCEL_LABEL = "Cancel";

export function showTaskActionMenu(
  onSelect: (action: TaskAction) => void
): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [...TASK_ACTIONS.map((action) => action.label), CANCEL_LABEL],
        cancelButtonIndex: TASK_ACTIONS.length,
        destructiveButtonIndex: TASK_ACTIONS.findIndex(
          (action) => action.style === "destructive"
        )
      },
      (buttonIndex) => {
        const action = TASK_ACTIONS[buttonIndex];
        if (action) onSelect(action.id);
      }
    );
    return;
  }

  Alert.alert(
    MENU_TITLE,
    undefined,
    [
      ...TASK_ACTIONS.map((action) => ({
        text: action.label,
        style: action.style,
        onPress: () => onSelect(action.id)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const }
    ]
  );
}
```

- [x] **Step 4: Verify GREEN and add the fallback test**

Run the focused test and expect PASS. Then set the mock platform to Android, call `showTaskActionMenu`, and assert the alert contains Advance Stage, destructive Close Task, and Cancel. Invoke both action callbacks and expect the same two action identifiers. Rerun the focused test and expect PASS.

- [x] **Step 5: Check the checkpoint**

Run `git diff --check` and `git status --short`. Do not commit; this Kanna stage leaves commits to the later pipeline step.

### Task 2: TaskScreen Menu Dispatch

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.tsx:1-160,315-325`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx:1-220,315-380`

- [x] **Step 1: Write failing TaskScreen tests**

Extend the hoisted test mocks with `onAdvanceTaskStage`, `onCloseTask`, and `showTaskActionMenu`, then mock the helper:

```ts
vi.mock("./taskActionMenu", () => ({
  showTaskActionMenu: componentMocks.showTaskActionMenu
}));
```

Reset those mocks in `beforeEach`. In `renderTaskScreen`, pass the two action callbacks and remove `onOpenMore`. Add one test that presses `mobile.task-more-button` and expects `showTaskActionMenu` once. Add a parameterized test that captures the selection callback, emits each action, and expects only its matching callback:

```ts
it.each([
  ["advance-stage", "onAdvanceTaskStage"],
  ["close-task", "onCloseTask"]
] as const)("routes %s to %s", (action, callbackName) => {
  const tree = renderTaskScreen({ agentType: "agent" });
  pressByTestId(tree, "mobile.task-more-button");
  const onSelect = componentMocks.showTaskActionMenu.mock.calls[0]![0] as (
    selectedAction: "advance-stage" | "close-task"
  ) => void;

  onSelect(action);

  expect(componentMocks[callbackName]).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Verify RED**

Run `pnpm --dir apps/mobile test src/screens/TaskScreen.test.tsx`.

Expected: FAIL because `TaskScreen` still accepts/calls `onOpenMore` and never invokes the task menu.

- [x] **Step 3: Implement the new TaskScreen contract**

Import `showTaskActionMenu` and `TaskAction`. Replace `onOpenMore(): void` with:

```ts
onAdvanceTaskStage(): void;
onCloseTask(): void;
```

Destructure those props and add:

```ts
const openTaskActionMenu = () => {
  showTaskActionMenu((action: TaskAction) => {
    switch (action) {
      case "advance-stage":
        onAdvanceTaskStage();
        break;
      case "close-task":
        onCloseTask();
        break;
    }
  });
};
```

Set the `+` button to `onPress={openTaskActionMenu}` and give it `accessibilityLabel="Task actions"` and `accessibilityRole="button"`.

- [x] **Step 4: Verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test src/screens/TaskScreen.test.tsx src/screens/taskActionMenu.test.ts
```

Expected: PASS, including the existing composer and quick-reply coverage.

- [x] **Step 5: Check the checkpoint**

Run `git diff --check`; inspect only the planned Task 1/2 changes. Do not commit in this manual stage.

### Task 3: Bind Actions to the Selected Task

**Files:**
- Modify: `apps/mobile/src/App.tsx:155-190`
- Modify: `apps/mobile/src/App.component.test.tsx:210-340`

- [x] **Step 1: Write the failing App wiring test**

Seed a selected task with id `task-current`. Spy on `advanceDesktopTaskStage`, `closeDesktopTask`, and `showView`; mount the app; invoke the two `TaskScreen` props; and assert:

```ts
expect(advance).toHaveBeenCalledWith("task-current");
expect(close).toHaveBeenCalledWith("task-current");
expect(showView).not.toHaveBeenCalledWith("more");
```

Mock the first two spies with `mockResolvedValue(undefined)` so the test isolates component wiring.

- [x] **Step 2: Verify RED**

Run `pnpm --dir apps/mobile test src/App.component.test.tsx`.

Expected: FAIL because `TaskScreen` currently exposes `onOpenMore`, not task action callbacks.

- [x] **Step 3: Bind the existing controller methods**

Replace the TaskScreen prop:

```tsx
onOpenMore={() => controller.showView("more")}
```

with:

```tsx
onAdvanceTaskStage={() => {
  void controller.advanceDesktopTaskStage(selectedTask.id);
}}
onCloseTask={() => {
  void controller.closeDesktopTask(selectedTask.id);
}}
```

Do not change the More tab or `case "more"` rendering path.

- [x] **Step 4: Run focused verification**

Run:

```bash
pnpm --dir apps/mobile test src/screens/taskActionMenu.test.ts src/screens/TaskScreen.test.tsx src/App.component.test.tsx
pnpm --dir apps/mobile typecheck
```

Expected: all focused tests PASS and TypeScript reports no errors.

- [x] **Step 5: Run the mobile unit suite**

Run `pnpm --dir apps/mobile test`.

Expected: the mobile Vitest suite passes. Preserve the focused green evidence and report the exact output if an unrelated pre-existing failure appears.

- [x] **Step 6: Final hygiene and scope review**

Run `git diff --check`, `git status --short`, and review the diff for the two new helper files, four modified mobile files, the design spec, and this plan. Confirm there is no request-revision UI, merge-agent action, global More change, physical-device action, commit, push, or pipeline transition.
