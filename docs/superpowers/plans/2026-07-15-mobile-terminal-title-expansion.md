# Mobile Terminal Title Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users expand the current renamed task title from the mobile terminal header, then collapse it with a second title tap or an outside tap.

**Architecture:** Keep the interaction entirely inside `TaskScreen`, with transient state storing the id of the task whose title is expanded. The existing title text remains the automation and activity-value surface, while a new accessible title button controls expansion and a transparent dismissal layer consumes outside presses between the terminal/composer and the top chrome.

**Tech Stack:** React 19, React Native 0.79, TypeScript, Vitest, the existing hoisted hook-test harness pattern.

---

## File structure

- Modify `apps/mobile/src/e2eTestIds.ts` to name the title control and outside-dismissal layer without changing the existing title-text selector.
- Modify `apps/mobile/src/e2eTestIds.test.ts` to pin the new selector strings.
- Modify `apps/mobile/src/screens/TaskScreen.test.tsx` to provide stateful hook rerenders and specify the complete interaction contract before production code changes.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` to own expanded-title state, render the accessible control/dismissal layer, and establish the required stacking order.
- Do not change API models, native projects, `mobileEnvironments.json`, or the OTA runtime version.

### Task 1: Add stable interaction selectors

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Test: `apps/mobile/src/e2eTestIds.test.ts`

- [ ] **Step 1: Write the failing selector assertions**

Add these assertions to the existing stable-selector test:

```ts
expect(MOBILE_E2E_IDS.taskTitleButton).toBe("mobile.task-title-button");
expect(MOBILE_E2E_IDS.taskTitleDismissLayer).toBe(
  "mobile.task-title-dismiss-layer"
);
```

- [ ] **Step 2: Run the selector test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts
```

Expected: TypeScript/Vitest fails because `taskTitleButton` and `taskTitleDismissLayer` do not exist.

- [ ] **Step 3: Add the two constants without replacing `taskDetailTitle`**

Insert alongside the task-detail selectors:

```ts
taskDetailTitle: "mobile.task-detail-title",
taskTitleButton: "mobile.task-title-button",
taskTitleDismissLayer: "mobile.task-title-dismiss-layer",
```

The existing `taskDetailTitle` remains on the title `Text` so current Appium flows retain their title text and activity value.

- [ ] **Step 4: Run the selector test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts
```

Expected: the selector test passes.

- [ ] **Step 5: Review the Kanna stage diff checkpoint**

Run `git diff --check`. Do not commit in this manual Kanna stage; the pipeline owns the later commit.

### Task 2: Specify title expansion with stateful component tests

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Test: `apps/mobile/src/screens/TaskScreen.test.tsx`

- [ ] **Step 1: Replace the fixed `useState` mock with the repository's stateful harness pattern**

Hoist state storage and reset it before each test:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactHooks = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[]
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useState: <T,>(initialValue: T) => {
      const stateIndex = reactHooks.index++;
      if (reactHooks.values.length <= stateIndex) {
        reactHooks.values[stateIndex] = initialValue;
      }
      return [
        reactHooks.values[stateIndex] as T,
        (nextValue: T | ((currentValue: T) => T)) => {
          const currentValue = reactHooks.values[stateIndex] as T;
          reactHooks.values[stateIndex] =
            typeof nextValue === "function"
              ? (nextValue as (value: T) => T)(currentValue)
              : nextValue;
        }
      ] as const;
    }
  };
});

beforeEach(() => {
  reactHooks.index = 0;
  reactHooks.values = [];
});
```

At the start of `renderTaskScreen`, set `reactHooks.index = 0` so subsequent calls simulate React rerenders without erasing state.

- [ ] **Step 2: Make the render helper accept current task identity and title**

Replace positional-only task data with an optional override while keeping existing call sites valid:

```ts
interface RenderTaskScreenOptions {
  activity?: "idle" | "working" | "unread";
  agentType?: "agent" | "pty";
  e2eTaskSnapshotMarker?: string;
  taskId?: string;
  title?: string;
  terminalDims?: { cols: number | null; rows: number | null };
}

function renderTaskScreen(options: RenderTaskScreenOptions = {}): ElementNode {
  if (!TaskScreen) {
    throw new Error("TaskScreen was not loaded");
  }

  const {
    activity = "idle",
    agentType = "pty",
    e2eTaskSnapshotMarker,
    taskId = "task-1",
    title = "Task",
    terminalDims = { cols: null, rows: null }
  } = options;

  reactHooks.index = 0;
  return TaskScreen({
    task: {
      id: taskId,
      repoId: "repo-1",
      title,
      stage: "in progress",
      agentType,
      activity
    },
    terminalOutput: "terminal",
    terminalStatus: "live",
    terminalCols: terminalDims.cols,
    terminalRows: terminalDims.rows,
    terminalErrorMessage: null,
    agentEvents: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
    agentStatus: "live",
    agentErrorMessage: null,
    e2eTaskSnapshotMarker,
    onBack: vi.fn(),
    onOpenMore: vi.fn(),
    onSendInput: vi.fn(),
    onStopAgent: vi.fn(),
    onResolveAgentPermission: vi.fn()
  }) as ElementNode;
}
```

Update existing test calls to the options object—for example, `renderTaskScreen({ agentType: "agent" })` and `renderTaskScreen({ agentType: "pty", terminalDims: { cols: 132, rows: 43 } })`—so their PTY/agent routing, dimensions, snapshot, and activity assertions remain unchanged.

- [ ] **Step 3: Write the collapsed and expanded renamed-title tests**

Use a long renamed title and assert both the new control and unchanged title text surface:

```ts
const renamedTitle = "Show the renamed title across every line of the mobile header";
let tree = renderTaskScreen({
  agentType: "pty",
  activity: "unread",
  title: renamedTitle
});
let button = findByTestId(tree, "mobile.task-title-button");
let title = findByTestId(tree, "mobile.task-detail-title");

expect(button?.props).toMatchObject({
  accessibilityRole: "button",
  accessibilityState: { expanded: false },
  testID: "mobile.task-title-button"
});
expect(title?.props).toMatchObject({
  accessibilityValue: { text: "unread" },
  children: renamedTitle,
  numberOfLines: 1
});
expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();

(button?.props?.onPress as (() => void) | undefined)?.();
tree = renderTaskScreen({ agentType: "pty", activity: "unread", title: renamedTitle });
button = findByTestId(tree, "mobile.task-title-button");
title = findByTestId(tree, "mobile.task-detail-title");

expect(button?.props?.accessibilityState).toEqual({ expanded: true });
expect(title?.props).toMatchObject({ children: renamedTitle });
expect(title?.props?.numberOfLines).toBeUndefined();
expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).not.toBeNull();
```

- [ ] **Step 4: Write second-tap, outside-tap, rename, and task-switch tests**

Add one small helper that invokes only the rendered control handler:

```ts
function press(node: ElementNode | null): void {
  const onPress = node?.props?.onPress;
  if (typeof onPress !== "function") {
    throw new Error("Expected a press handler");
  }
  onPress();
}
```

Then add the concrete transition coverage:

```ts
it("keeps an expanded title current when the same task is renamed", () => {
  let tree = renderTaskScreen({ taskId: "task-a", title: "Original title" });
  press(findByTestId(tree, "mobile.task-title-button"));

  tree = renderTaskScreen({ taskId: "task-a", title: "Renamed while open" });

  expect(findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityState)
    .toEqual({ expanded: true });
  expect(findByTestId(tree, "mobile.task-detail-title")?.props).toMatchObject({
    children: "Renamed while open"
  });
});

it("collapses the title when its button is pressed again", () => {
  let tree = renderTaskScreen({ taskId: "task-a", title: "Long title" });
  press(findByTestId(tree, "mobile.task-title-button"));
  tree = renderTaskScreen({ taskId: "task-a", title: "Long title" });

  press(findByTestId(tree, "mobile.task-title-button"));
  tree = renderTaskScreen({ taskId: "task-a", title: "Long title" });

  expect(findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityState)
    .toEqual({ expanded: false });
  expect(findByTestId(tree, "mobile.task-detail-title")?.props?.numberOfLines).toBe(1);
  expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();
});

it("collapses the title when the outside layer is pressed", () => {
  let tree = renderTaskScreen({ taskId: "task-a", title: "Long title" });
  press(findByTestId(tree, "mobile.task-title-button"));
  tree = renderTaskScreen({ taskId: "task-a", title: "Long title" });

  press(findByTestId(tree, "mobile.task-title-dismiss-layer"));
  tree = renderTaskScreen({ taskId: "task-a", title: "Long title" });

  expect(findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityState)
    .toEqual({ expanded: false });
  expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();
});

it("does not carry expanded state across task selection", () => {
  let tree = renderTaskScreen({ taskId: "task-a", title: "Task A" });
  press(findByTestId(tree, "mobile.task-title-button"));
  tree = renderTaskScreen({ taskId: "task-a", title: "Task A" });
  expect(findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityState)
    .toEqual({ expanded: true });

  tree = renderTaskScreen({ taskId: "task-b", title: "Task B" });
  expect(findByTestId(tree, "mobile.task-detail-title")?.props).toMatchObject({
    children: "Task B",
    numberOfLines: 1
  });
  expect(findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityState)
    .toEqual({ expanded: false });

  tree = renderTaskScreen({ taskId: "task-a", title: "Task A" });
  expect(findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityState)
    .toEqual({ expanded: false });
});
```

The outside-dismissal test invokes only the layer's handler, proving that the consuming layer owns that first interaction.

- [ ] **Step 5: Run the focused screen test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx
```

Expected: the new behavior tests fail because the title is still a `View`, stays one line, and has no dismissal layer.

### Task 3: Implement the title interaction in `TaskScreen`

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Test: `apps/mobile/src/screens/TaskScreen.test.tsx`

- [ ] **Step 1: Add task-associated transient state and reset behavior**

After the existing local state, add:

```ts
const [expandedTitleTaskId, setExpandedTitleTaskId] = useState<string | null>(null);
const isTitleExpanded = expandedTitleTaskId === task.id;

useEffect(() => {
  setExpandedTitleTaskId((currentTaskId) =>
    currentTaskId === task.id ? currentTaskId : null
  );
}, [task.id]);
```

This preserves expansion when only the same task's renamed title changes, renders a newly selected task collapsed immediately, and clears the stale id before a later return.

- [ ] **Step 2: Add the transparent outside-dismissal layer**

Render it after the terminal canvas and before the top chrome:

```tsx
{isTitleExpanded ? (
  <Pressable
    accessible={false}
    onPress={() => setExpandedTitleTaskId(null)}
    style={styles.titleDismissLayer}
    testID={MOBILE_E2E_IDS.taskTitleDismissLayer}
  />
) : null}
```

Add a full-screen absolute style above bottom chrome and below top chrome:

```ts
titleDismissLayer: {
  bottom: 0,
  left: 0,
  position: "absolute",
  right: 0,
  top: 0,
  zIndex: 4
},
```

- [ ] **Step 3: Convert the title chip to an accessible toggle**

Replace only the title-chip `View` with:

```tsx
<Pressable
  accessibilityHint={
    isTitleExpanded
      ? "Collapses the full task title"
      : "Expands the full task title"
  }
  accessibilityLabel={`${model.stageLabel}: ${model.title}`}
  accessibilityRole="button"
  accessibilityState={{ expanded: isTitleExpanded }}
  onPress={() =>
    setExpandedTitleTaskId((currentTaskId) =>
      currentTaskId === task.id ? null : task.id
    )
  }
  style={[styles.titleChip, isTitleExpanded ? styles.titleChipExpanded : null]}
  testID={MOBILE_E2E_IDS.taskTitleButton}
>
  <Text style={styles.stageLabel}>{model.stageLabel}</Text>
  <Text
    accessibilityValue={{ text: effectiveActivity }}
    numberOfLines={isTitleExpanded ? undefined : 1}
    style={styles.title}
    testID={MOBILE_E2E_IDS.taskDetailTitle}
  >
    {model.title}
  </Text>
</Pressable>
```

Add `titleChipExpanded: { alignItems: "flex-start" }` and raise `topChrome.zIndex` from `3` to `5`. Leave `bottomChrome.zIndex` at `3`, so the dismissal layer consumes terminal/composer presses while the title and back button remain usable.

- [ ] **Step 4: Run the focused title tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx src/e2eTestIds.test.ts
```

Expected: all focused tests pass, including existing routing, dimensions, snapshot marker, and activity coverage.

- [ ] **Step 5: Run mobile type and affected-suite verification**

Run:

```bash
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
git diff --check
```

Expected: TypeScript exits zero, every mobile Vitest file passes, and the diff has no whitespace errors.

- [ ] **Step 6: Verify through the canonical live stack**

After the KD physical-device orchestration fix has completed its own build/install/payload verification, reuse the running stack through:

```bash
KANNA_IOS_DEVICE_UDID=00008130-001015CA1091401C ./kd mobile run --device
```

Expected: KD returns after build/install/payload launch, the app loads the Metro bundle, the renamed title expands on tap, and either a second title tap or an outside tap collapses it. Physical interaction itself remains a human visual check.

- [ ] **Step 7: Review the Kanna stage diff checkpoint**

Run `git status --short` and `git diff --check`. Do not commit, push, create a PR, or record stage completion; the manual Kanna pipeline owns those later actions.
