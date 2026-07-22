# Mobile Terminal Edge-Back Gesture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the standard iOS left-edge swipe-back gesture from task terminal detail to the underlying task list.

**Architecture:** Keep navigation gesture ownership in the existing React Navigation native stack. Configure only the `TaskDetail` route for horizontal edge dismissal, explicitly leaving full-screen dismissal off so the terminal WebView retains non-edge gestures.

**Tech Stack:** React Native 0.86, React Navigation native stack 7, React 19 test renderer, Vitest, TypeScript

---

## File Structure

- Modify `apps/mobile/src/navigation/RootNavigator.component.test.tsx` to assert the native-stack options that define the gesture boundary.
- Modify `apps/mobile/src/navigation/RootNavigator.tsx` to configure the existing `TaskDetail` screen. No new component or gesture helper is needed because native stack owns recognition and animation.

### Task 1: Configure Native Edge-Back Dismissal

**Files:**
- Modify: `apps/mobile/src/navigation/RootNavigator.component.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx:243-247`

- [ ] **Step 1: Write the failing route-configuration test**

Add this test inside the existing `describe("RootNavigator", ...)` block, using the same render setup as the dark-background test:

```tsx
it("enables edge-only swipe back for task detail", async () => {
  await act(async () => {
    rendered = create(
      <RootNavigator
        controller={{} as never}
        forceCloudEnabled={false}
        initialState={{
          index: 0,
          key: "root",
          routeNames: ["MainTabs"],
          routes: [{ key: "main-tabs", name: "MainTabs" }],
          stale: false,
          type: "stack"
        } as never}
        onForceCloudChange={vi.fn()}
        onOpenAccount={vi.fn()}
        openMachinesRequestKey={0}
        quickReplies={DEFAULT_TASK_QUICK_REPLIES}
        quickRepliesHydrated
        state={{
          accountDesktops: [],
          composerAgentProvider: "claude",
          composerDesktopId: null,
          composerErrorMessage: null,
          composerPrompt: "",
          composerRepoId: null,
          isComposerOpen: false,
          isComposerOptionsExpanded: false,
          liveLanDesktops: [],
          pendingTaskCreation: null,
          repos: [],
          selectedTaskId: null,
          trustedDesktops: []
        } as never}
      />
    );
  });

  const taskDetailScreen = rendered.root
    .findAllByType("NativeStackScreen")
    .find((screen) => screen.props.name === "TaskDetail");

  expect(taskDetailScreen?.props.options).toMatchObject({
    fullScreenGestureEnabled: false,
    gestureDirection: "horizontal",
    gestureEnabled: true,
    headerShown: false
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --dir apps/mobile test -- RootNavigator.component.test.tsx
```

Expected: FAIL because the `TaskDetail` options contain only `headerShown: false` and do not yet contain the three gesture settings.

- [ ] **Step 3: Add the minimal native-stack configuration**

Replace the `TaskDetail` screen declaration in `RootNavigator.tsx` with:

```tsx
<RootStack.Screen
  component={TaskDetailRoute}
  name="TaskDetail"
  options={{
    fullScreenGestureEnabled: false,
    gestureDirection: "horizontal",
    gestureEnabled: true,
    headerShown: false
  }}
/>
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- RootNavigator.component.test.tsx
```

Expected: PASS with both `RootNavigator.component.test.tsx` tests green.

- [ ] **Step 5: Run mobile verification**

Run:

```bash
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
```

Expected: TypeScript exits 0 and the complete mobile Vitest suite reports no failures.

- [ ] **Step 6: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/navigation/RootNavigator.component.test.tsx
```

Expected: no whitespace errors; only the planned navigation implementation and test are uncommitted after the already committed design and plan documents.
