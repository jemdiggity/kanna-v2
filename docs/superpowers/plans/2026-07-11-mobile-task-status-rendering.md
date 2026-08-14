# Mobile Task Status Rendering Implementation Plan

> **Revision note:** Reviewer-required desktop publication, mark-read lifecycle,
> transport, and relay E2E work is specified in
> `2026-07-11-mobile-task-status-revision.md`, which supersedes this original
> rendering-only plan where the two differ.

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render mobile task titles with the same idle, working, and unread typography as the desktop task list.

**Architecture:** Extend the mobile task summary contract with the existing activity state, normalize cloud snapshots at their boundary, and include activity in task-list equality so status-only updates rerender. Keep the presentation change local to `TaskCard`; desktop cloud-publication behavior is outside this rendering-only change.

**Tech Stack:** TypeScript, React Native, React 19, Vitest, Firestore task snapshots

**Stage constraint:** Do not commit during this implementation stage; the Kanna workflow handles committing after the user advances the task.

---

### Task 1: Preserve Task Activity Through the Mobile Cloud Boundary

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts:69`
- Modify: `apps/mobile/src/lib/firebase/taskIndex.ts:11-31,182-196`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts:42-112`

- [ ] **Step 1: Write failing cloud-mapping assertions**

Update the existing working snapshot expectation in `taskIndex.test.ts` to include activity:

```ts
    ).toEqual({
      id: "cloud-task-1",
      repoId: "repo-1",
      repoName: "kanna",
      title: "Mobile cloud",
      stage: "in progress",
      activity: "working",
      snippet: "Fix mobile cloud",
      agentProvider: "claude",
      agentType: "agent",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      ownerOnline: false,
    });
```

Replace the legacy-snapshot test with an assertion that absent and unrecognized activity normalize to idle:

```ts
  it("normalizes missing or unrecognized cloud activity to idle", () => {
    const legacySnapshot = {
      ownerDesktopId: "desktop-1",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-1",
      title: "Fix mobile cloud",
      promptSnippet: null,
      displayName: null,
      stage: "in progress",
      status: "active",
      repo: { cloudRepoId: "repo-1", name: "kanna" },
      updatedAt: "2026-05-14T00:01:00.000Z",
      closedAt: null,
    };

    expect(mapCloudTaskSnapshot(legacySnapshot)).toMatchObject({
      id: "cloud:desktop-1:repo-1:task-1",
      repoId: "repo-1",
      activity: "idle",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
    });
    expect(
      mapCloudTaskSnapshot({ ...legacySnapshot, activity: "paused" }).activity,
    ).toBe("idle");
  });
```

- [ ] **Step 2: Run the cloud mapper test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/firebase/taskIndex.test.ts
```

Expected: FAIL because mapped task summaries do not contain `activity`.

- [ ] **Step 3: Add the mobile activity contract and cloud normalization**

Add the shared type before `TaskSummary` and the activity field inside it in `apps/mobile/src/lib/api/types.ts`:

```ts
export type TaskActivity = "idle" | "working" | "unread";

export interface TaskSummary {
  id: string;
  repoId: string;
  repoName?: string | null;
  title: string;
  stage: string | null;
  activity?: TaskActivity | null;
  snippet?: string | null;
  agentProvider?: string | null;
  agentType?: "pty" | "agent" | null;
}
```

Update the task-index type import and add the activity property to `CloudTaskSnapshot` in `apps/mobile/src/lib/firebase/taskIndex.ts`:

```ts
import type { TaskActivity, TaskSummary } from "../api/types";
```

```ts
  stage: string;
  activity?: string | null;
  status: string;
```

Add activity to the object returned by `mapCloudTaskSnapshot`:

```ts
    stage: snapshot.stage,
    activity: normalizeTaskActivity(snapshot.activity),
    snippet: snapshot.promptSnippet ?? undefined,
```

Add the boundary helper immediately before `normalizeAgentType`:

```ts
function normalizeTaskActivity(activity: string | null | undefined): TaskActivity {
  if (activity === "working" || activity === "unread") {
    return activity;
  }
  return "idle";
}
```

- [ ] **Step 4: Run the cloud mapper test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/firebase/taskIndex.test.ts
```

Expected: PASS.

### Task 2: Publish Activity-Only Task Refreshes

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.ts:176-195`
- Test: `apps/mobile/src/state/sessionStore.test.ts:155-215`

- [ ] **Step 1: Write a failing store reactivity test**

Add beside the identical-refresh tests in `sessionStore.test.ts`:

```ts
  it("publishes when only a task's activity changes", () => {
    const store = createSessionStore();
    let publishes = 0;
    store.subscribe(() => {
      publishes += 1;
    });
    const task = {
      id: "task-status",
      repoId: "repo-1",
      title: "Render agent status",
      stage: "in progress",
      activity: "idle" as const,
    };

    store.setRecentTasks([task]);
    publishes = 0;
    store.setRecentTasks([{ ...task, activity: "working" }]);

    expect(publishes).toBe(1);
    expect(store.getState().recentTasks[0]?.activity).toBe("working");
  });
```

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: FAIL with `publishes` equal to `0`, because task equality currently ignores activity.

- [ ] **Step 3: Include effective activity in task equality**

Add activity to `areTaskListsEqual` in `apps/mobile/src/state/sessionStore.ts`, treating absent activity as idle because both render identically:

```ts
        task.stage === other.stage &&
        (task.activity ?? "idle") === (other.activity ?? "idle") &&
        (task.snippet ?? null) === (other.snippet ?? null) &&
```

- [ ] **Step 4: Run the store test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: PASS, including the existing identical-refresh tests.

### Task 3: Match Desktop Task-Title Typography

**Files:**
- Create: `apps/mobile/src/components/TaskCard.test.tsx`
- Modify: `apps/mobile/src/components/TaskCard.tsx:14-38,73-78`

- [ ] **Step 1: Write the failing task-card typography test**

Create `apps/mobile/src/components/TaskCard.test.tsx`:

```tsx
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TaskActivity, TaskSummary } from "../lib/api/types";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles,
  },
  Text: "Text",
  View: "View",
}));

let TaskCard: typeof import("./TaskCard").TaskCard | null = null;

beforeAll(async () => {
  TaskCard = (await import("./TaskCard")).TaskCard;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    style?: unknown;
    [key: string]: unknown;
  };
}

function childrenOf(node: ElementNode): Array<ElementNode | string> {
  const children = node.props?.children;
  if (!children) return [];
  return (Array.isArray(children) ? children : [children]).filter(Boolean);
}

function textContent(node: ElementNode | string): string {
  if (typeof node === "string") return node;
  return childrenOf(node).map(textContent).join("");
}

function findTextNode(node: ElementNode, text: string): ElementNode | null {
  if (node.type === "Text" && textContent(node) === text) return node;
  for (const child of childrenOf(node)) {
    if (typeof child === "string") continue;
    const match = findTextNode(child, text);
    if (match) return match;
  }
  return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
  }
  return style && typeof style === "object"
    ? (style as Record<string, unknown>)
    : {};
}

function renderTitleStyle(activity?: TaskActivity): Record<string, unknown> {
  if (!TaskCard) throw new Error("TaskCard was not loaded");
  const task: TaskSummary = {
    id: "task-1",
    repoId: "repo-1",
    title: "Agent status task",
    stage: "in progress",
    activity,
  };
  const tree = TaskCard({
    isRecentView: false,
    repoName: "kanna",
    task,
    onPress: vi.fn(),
  }) as ElementNode;
  const title = findTextNode(tree, task.title);
  if (!title) throw new Error("Task title was not rendered");
  return flattenStyle(title.props?.style);
}

describe("TaskCard activity typography", () => {
  it.each([
    ["unread", "bold", "normal"],
    ["working", "normal", "italic"],
    ["idle", "normal", "normal"],
    [undefined, "normal", "normal"],
  ] as const)(
    "renders %s task titles with desktop-equivalent typography",
    (activity, fontWeight, fontStyle) => {
      expect(renderTitleStyle(activity)).toMatchObject({ fontWeight, fontStyle });
    },
  );
});
```

- [ ] **Step 2: Run the task-card test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/components/TaskCard.test.tsx
```

Expected: FAIL because every title currently has weight `700` and no explicit activity-dependent style.

- [ ] **Step 3: Apply activity-specific title styles**

Add the activity style selection after the existing presentation model in `TaskCard`:

```tsx
  const model = buildTaskListItemModel(task, repoName, isRecentView);
  const titleActivityStyle =
    task.activity === "unread"
      ? styles.titleUnread
      : task.activity === "working"
        ? styles.titleWorking
        : styles.titleIdle;
```

Replace the existing title element:

```tsx
        <Text style={[styles.title, titleActivityStyle]}>{task.title}</Text>
```

Replace the fixed title weight and add the three explicit variants in the stylesheet:

```ts
  title: {
    color: "#F3F7FF",
    flex: 1,
    fontSize: 17,
  },
  titleIdle: {
    fontStyle: "normal",
    fontWeight: "normal",
  },
  titleUnread: {
    fontStyle: "normal",
    fontWeight: "bold",
  },
  titleWorking: {
    fontStyle: "italic",
    fontWeight: "normal",
  },
```

- [ ] **Step 4: Run the task-card test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/components/TaskCard.test.tsx
```

Expected: PASS for unread, working, idle, and missing activity.

### Task 4: Verify the Integrated Mobile Change

**Files:**
- Verify: `apps/mobile/src/components/TaskCard.test.tsx`
- Verify: `apps/mobile/src/lib/firebase/taskIndex.test.ts`
- Verify: `apps/mobile/src/state/sessionStore.test.ts`
- Verify: all modified source and documentation files

- [ ] **Step 1: Run focused status-rendering tests**

Run:

```bash
pnpm --dir apps/mobile test -- src/components/TaskCard.test.tsx src/lib/firebase/taskIndex.test.ts src/state/sessionStore.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the mobile TypeScript check**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 3: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff without committing**

Run:

```bash
git diff --check
git status --short
git diff -- apps/mobile/src/lib/api/types.ts apps/mobile/src/lib/firebase/taskIndex.ts apps/mobile/src/lib/firebase/taskIndex.test.ts apps/mobile/src/state/sessionStore.ts apps/mobile/src/state/sessionStore.test.ts apps/mobile/src/components/TaskCard.tsx apps/mobile/src/components/TaskCard.test.tsx docs/superpowers/specs/2026-07-11-mobile-task-status-rendering-design.md docs/superpowers/plans/2026-07-11-mobile-task-status-rendering.md
```

Expected: no whitespace errors; only the planned status-rendering source, tests, spec, and plan are changed.
