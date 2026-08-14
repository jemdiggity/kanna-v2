# Mobile Activity Task Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sort the mobile Activity view as unread, idle/read, then working/busy while preserving source order inside each group.

**Architecture:** Add a pure presentation helper that returns a stably reordered copy of task summaries and treats missing or unknown activity as idle. Apply it only in `TasksScreen` when the screen is rendering the Activity/Recent mode, leaving repository lists and upstream LAN/cloud ordering unchanged.

**Tech Stack:** TypeScript, React Native, React 19, Vitest

---

### Task 1: Pure Activity Ordering Helper

**Files:**
- Create: `apps/mobile/src/screens/activityTaskOrder.ts`
- Create: `apps/mobile/src/screens/activityTaskOrder.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `apps/mobile/src/screens/activityTaskOrder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TaskActivity, TaskSummary } from "../lib/api/types";
import { orderActivityTasks } from "./activityTaskOrder";

function task(id: string, activity?: TaskActivity | null): TaskSummary {
  return {
    id,
    repoId: "repo-1",
    title: id,
    stage: "in progress",
    ...(activity === undefined ? {} : { activity })
  };
}

describe("orderActivityTasks", () => {
  it("orders unread, idle/read, and working/busy groups", () => {
    const tasks = [
      task("working-1", "working"),
      task("idle-1", "idle"),
      task("unread-1", "unread"),
      task("working-2", "working"),
      task("missing"),
      task("unread-2", "unread"),
      task("idle-2", null)
    ];

    expect(orderActivityTasks(tasks).map(({ id }) => id)).toEqual([
      "unread-1",
      "unread-2",
      "idle-1",
      "missing",
      "idle-2",
      "working-1",
      "working-2"
    ]);
  });

  it("returns a reordered copy without mutating the source array", () => {
    const tasks = [task("working", "working"), task("unread", "unread")];

    const ordered = orderActivityTasks(tasks);

    expect(ordered).not.toBe(tasks);
    expect(tasks.map(({ id }) => id)).toEqual(["working", "unread"]);
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run `pnpm --dir apps/mobile test -- activityTaskOrder.test.ts`.

Expected: FAIL because `./activityTaskOrder` does not exist.

- [ ] **Step 3: Implement the minimal stable helper**

Create `apps/mobile/src/screens/activityTaskOrder.ts`:

```ts
import type { TaskActivity, TaskSummary } from "../lib/api/types";

function activityPriority(activity: TaskActivity | null | undefined): number {
  if (activity === "unread") return 0;
  if (activity === "working") return 2;
  return 1;
}

export function orderActivityTasks(
  tasks: readonly TaskSummary[]
): TaskSummary[] {
  return tasks
    .map((task, sourceIndex) => ({ task, sourceIndex }))
    .sort(
      (left, right) =>
        activityPriority(left.task.activity) -
          activityPriority(right.task.activity) ||
        left.sourceIndex - right.sourceIndex
    )
    .map(({ task }) => task);
}
```

The explicit source-index tiebreaker enforces stable ordering independently of runtime sort details.

- [ ] **Step 4: Run the helper test to verify it passes**

Run `pnpm --dir apps/mobile test -- activityTaskOrder.test.ts`.

Expected: both `orderActivityTasks` tests PASS.

### Task 2: Activity Screen Integration

**Files:**
- Modify: `apps/mobile/src/screens/TasksScreen.tsx`
- Modify: `apps/mobile/src/screens/TasksScreen.test.tsx`

- [ ] **Step 1: Write the failing Activity integration test**

Add this case to the existing `describe("TasksScreen", ...)` block:

```ts
it("orders Recent tasks by attention state while preserving group order", () => {
  if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
  const tasks = [
    {
      id: "working-1",
      repoId: "repo-a",
      title: "Working 1",
      stage: "in progress",
      activity: "working" as const
    },
    {
      id: "unread-1",
      repoId: "repo-a",
      title: "Unread 1",
      stage: "review",
      activity: "unread" as const
    },
    {
      id: "idle-1",
      repoId: "repo-b",
      title: "Idle 1",
      stage: "in progress",
      activity: "idle" as const
    },
    {
      id: "unread-2",
      repoId: "repo-b",
      title: "Unread 2",
      stage: "review",
      activity: "unread" as const
    }
  ];

  const tree = TasksScreen({
    heading: "Recent",
    repos: [],
    selectedRepoId: "repo-a",
    tasks,
    onOpenTask: vi.fn(),
    onSelectRepo: vi.fn()
  }) as ElementNode;

  expect(
    (findElement(tree, TaskList)?.props?.tasks as typeof tasks).map(
      ({ id }) => id
    )
  ).toEqual(["unread-1", "unread-2", "idle-1", "working-1"]);
});
```

The existing `keeps Recent pan-repo` assertion remains valid because both fixtures have missing activity and share idle/read priority. The repository-scoping test remains the regression assertion that normal Tasks mode preserves filtered source order.

- [ ] **Step 2: Run the screen test to verify it fails**

Run `pnpm --dir apps/mobile test -- TasksScreen.test.tsx`.

Expected: FAIL because Recent still passes the incoming tasks unchanged.

- [ ] **Step 3: Apply Activity-only ordering in `TasksScreen`**

Add:

```ts
import { orderActivityTasks } from "./activityTaskOrder";
```

Replace `filteredTasks` with:

```ts
const displayedTasks = isRecentView
  ? orderActivityTasks(tasks)
  : selectedRepoId
    ? tasks.filter((task) => task.repoId === selectedRepoId)
    : tasks;
```

Pass `displayedTasks` to `TaskList`:

```tsx
<TaskList
  emptyLabel="No tasks yet."
  tasks={displayedTasks}
  testID={MOBILE_E2E_IDS.tasksScreen}
  onOpenTask={onOpenTask}
/>
```

- [ ] **Step 4: Run the focused helper and screen tests**

Run `pnpm --dir apps/mobile test -- activityTaskOrder.test.ts TasksScreen.test.tsx`.

Expected: all helper and `TasksScreen` tests PASS.

### Task 3: Verification

**Files:**
- Verify only; no additional files expected.

- [ ] **Step 1: Run the mobile typecheck**

Run `pnpm --dir apps/mobile typecheck`.

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run all mobile unit tests**

Run `pnpm --dir apps/mobile test`.

Expected: PASS with no failing Vitest suites.

- [ ] **Step 3: Inspect the final diff**

Run `git diff --check`, then inspect the diff for the four implementation files and two design documents.

Expected: `git diff --check` emits no output, and the diff contains only the approved Activity ordering change, its tests, and the design/plan documents.

No commit step is included because this Kanna stage explicitly delegates committing to the later workflow.
