# Blocked Task PTY Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the live task, worktree, and PTY session when a running task is marked blocked, then resume that same session in place with a blocker-context follow-up message when blockers clear.

**Architecture:** Keep blocked state on the existing `pipeline_item` instead of creating a replacement task. Split the change into three layers: a small DB helper for tag persistence, a close-behavior helper that distinguishes inert blocked tasks from blocked tasks with live resources, and a `tasks.ts` lifecycle rewrite that blocks/unblocks the same task id in place while preserving fallback startup for legacy blocked items with no session context.

**Tech Stack:** Vue 3 + Pinia store modules, TypeScript, Vitest, SQLite query helpers in `packages/db`, Tauri `invoke()` session commands.

---

## File Map

- `packages/db/src/queries.ts`
  Responsibility: add a focused helper for persisting task tags without embedding raw tag SQL in the store.
- `packages/db/src/queries.test.ts`
  Responsibility: prove the new tag helper updates only the requested task and refreshes `updated_at`.
- `apps/desktop/src/stores/taskCloseBehavior.ts`
  Responsibility: encode the difference between blocked tasks that are inert placeholders and blocked tasks that still own live resources.
- `apps/desktop/src/stores/taskCloseBehavior.test.ts`
  Responsibility: lock in the new close rules before touching the store lifecycle.
- `apps/desktop/src/stores/tasks.ts`
  Responsibility: replace blocked-task replacement/respawn behavior with in-place block/unblock behavior and an unblock follow-up message over the existing PTY.
- `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
  Responsibility: cover block-in-place, unblock-in-place, preserved selection/session identity, and the fallback startup path for legacy blocked tasks.

### Task 1: Add a Query Helper for Persisting Task Tags

**Files:**
- Modify: `packages/db/src/queries.ts`
- Modify: `packages/db/src/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test near the other `pipeline_item` query tests in `packages/db/src/queries.test.ts`:

```ts
it("updatePipelineItemTags overwrites tags for a single task", async () => {
  await insertPipelineItem(db, {
    id: "pi-tags",
    repo_id: "r1",
    issue_number: null,
    issue_title: null,
    prompt: "Blocked task",
    pr_number: null,
    pr_url: null,
    branch: "task-pi-tags",
    agent_type: "pty",
    agent_provider: "claude",
    port_offset: null,
    port_env: null,
    tags: ["blocked"],
  });

  await updatePipelineItemTags(db, "pi-tags", ["in progress", "blocked"]);

  const rows = await db.select<PipelineItem>("SELECT * FROM pipeline_item WHERE id = ?", ["pi-tags"]);
  expect(rows[0]?.tags).toBe('["in progress","blocked"]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd packages/db
pnpm exec vitest run src/queries.test.ts -t "updatePipelineItemTags overwrites tags for a single task"
```

Expected: FAIL with `updatePipelineItemTags is not defined` or an equivalent missing export error.

- [ ] **Step 3: Write the minimal implementation**

Add this helper to `packages/db/src/queries.ts` next to the other `updatePipelineItem*` helpers:

```ts
export async function updatePipelineItemTags(
  db: DbHandle,
  id: string,
  tags: string[],
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET tags = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(tags), id],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd packages/db
pnpm exec vitest run src/queries.test.ts -t "updatePipelineItemTags overwrites tags for a single task"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "test: cover workflow item tag updates"
```

### Task 2: Encode Live-Blocked Close Semantics in the Helper

**Files:**
- Modify: `apps/desktop/src/stores/taskCloseBehavior.ts`
- Modify: `apps/desktop/src/stores/taskCloseBehavior.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the old blocked-task expectation in `apps/desktop/src/stores/taskCloseBehavior.test.ts` with these two tests:

```ts
it("enters teardown for blocked tasks that still own live resources", () => {
  expect(
    getTaskCloseBehavior({
      wasBlocked: true,
      hasLiveTaskResources: true,
      currentStage: "in progress",
      hasTeardownCommands: true,
    }),
  ).toBe("enter-teardown");
});

it("finishes inert blocked tasks immediately", () => {
  expect(
    getTaskCloseBehavior({
      wasBlocked: true,
      hasLiveTaskResources: false,
      currentStage: "in progress",
      hasTeardownCommands: true,
    }),
  ).toBe("finish");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd apps/desktop
pnpm exec vitest run src/stores/taskCloseBehavior.test.ts
```

Expected: FAIL because `hasLiveTaskResources` is not part of `TaskCloseBehaviorInput`.

- [ ] **Step 3: Write the minimal implementation**

Update `apps/desktop/src/stores/taskCloseBehavior.ts` to distinguish inert blocked tasks from live blocked tasks:

```ts
export interface TaskCloseBehaviorInput {
  wasBlocked: boolean;
  hasLiveTaskResources: boolean;
  currentStage: string;
  hasTeardownCommands: boolean;
}

export function getTaskCloseBehavior(
  input: TaskCloseBehaviorInput,
): TaskCloseBehavior {
  if (isTeardownStage(input.currentStage) || !input.hasTeardownCommands) {
    return "finish";
  }

  if (input.wasBlocked && !input.hasLiveTaskResources) {
    return "finish";
  }

  return "enter-teardown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd apps/desktop
pnpm exec vitest run src/stores/taskCloseBehavior.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/taskCloseBehavior.ts apps/desktop/src/stores/taskCloseBehavior.test.ts
git commit -m "test: distinguish live blocked task close behavior"
```

### Task 3: Preserve the Existing Task and PTY When Blocking

**Files:**
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Uses: `packages/db/src/queries.ts`

- [ ] **Step 1: Write the failing store tests**

In `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`, replace the replacement-task test with these two tests:

```ts
it("marks the current task blocked in place without killing its live session", async () => {
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-active",
      branch: "task-item-active",
      claude_session_id: "claude-item-active",
      prompt: "Investigate sidebar lag",
      display_name: "Sidebar lag",
    }),
    mockState.makeItem({
      id: "item-blocker",
      branch: "task-item-blocker",
      prompt: "Finish upstream dependency",
      display_name: "Upstream dependency",
    }),
  ];

  const store = await createStore();
  await store.selectItem("item-active");
  await flushStore();

  await store.blockTask(["item-blocker"]);
  await flushStore();

  const active = mockState.workflowItems.find((item) => item.id === "item-active");
  expect(active?.branch).toBe("task-item-active");
  expect(active?.claude_session_id).toBe("claude-item-active");
  expect(JSON.parse(active?.tags ?? "[]")).toContain("blocked");
  expect(store.selectedItemId).toBe("item-active");
  expect(mockState.invokeMock).not.toHaveBeenCalledWith("kill_session", expect.anything());
  expect(mockState.invokeMock).not.toHaveBeenCalledWith(
    "git_worktree_remove",
    expect.objectContaining({ path: "/tmp/repo/.kanna-worktrees/task-item-active" }),
  );
});

it("unblocks a live blocked task in place and sends blocker context to the existing session", async () => {
  const blocker = mockState.makeItem({
    id: "item-blocker",
    branch: "task-item-blocker",
    closed_at: "2026-04-14T01:00:00.000Z",
    prompt: "Finish upstream dependency",
    display_name: "Upstream dependency",
  });

  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-blocked",
      branch: "task-item-blocked",
      claude_session_id: "claude-item-blocked",
      tags: '["blocked"]',
    }),
    blocker,
  ];

  mockState.listBlockersForItemMock
    .mockResolvedValueOnce([blocker])
    .mockResolvedValueOnce([]);

  const store = await createStore();
  await store.editBlockedTask("item-blocked", []);
  await flushStore();

  const blocked = mockState.workflowItems.find((item) => item.id === "item-blocked");
  expect(JSON.parse(blocked?.tags ?? "[]")).not.toContain("blocked");
  expect(mockState.invokeMock).toHaveBeenCalledWith(
    "send_input",
    expect.objectContaining({
      sessionId: "item-blocked",
      input: expect.stringContaining("Upstream dependency"),
    }),
  );
  expect(mockState.invokeMock).not.toHaveBeenCalledWith("spawn_session", expect.anything());
});
```

Update the mocked `invoke` switch to accept `send_input`, and expose `listBlockersForItemMock` from the hoisted `mockState` object so the tests can control blocker lookup sequences directly.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd apps/desktop
pnpm exec vitest run src/stores/kanna.taskBaseBranch.test.ts
```

Expected: FAIL because `blockTask()` still creates a replacement item, and `editBlockedTask()` / `checkUnblocked()` still call the respawn path.

- [ ] **Step 3: Write the minimal implementation**

Make these changes in `apps/desktop/src/stores/tasks.ts`:

1. Import the new DB helper:

```ts
import {
  // ...
  updatePipelineItemTags,
} from "@kanna/db";
```

2. Add a small resource check and unblock-message builder near `startBlockedTask()`:

```ts
function hasLiveTaskResources(item: PipelineItem): boolean {
  return item.branch !== null || item.claude_session_id !== null || item.port_env !== null;
}

function buildBlockedResumeMessage(blockers: PipelineItem[]): string {
  const blockerContext = blockers
    .map((blocker) => {
      const name = blocker.display_name || (blocker.prompt ? blocker.prompt.slice(0, 60) : "Untitled");
      return `- ${name} (branch: ${blocker.branch || "unknown"})`;
    })
    .join("\n");

  return [
    "This task was previously blocked by the following tasks, which have now completed:",
    blockerContext,
    "Their changes may be on branches that haven't merged to main yet.",
    "Please continue this task using that context where relevant.",
  ].join("\n");
}
```

3. Add an in-place unblock helper:

```ts
async function resumeBlockedTaskInPlace(
  item: PipelineItem,
  blockers = await listBlockersForItem(context.requireDb(), item.id),
): Promise<void> {
  if (!JSON.parse(item.tags).includes("blocked")) return;
  const message = buildBlockedResumeMessage(blockers);

  await updatePipelineItemTags(
    context.requireDb(),
    item.id,
    JSON.parse(item.tags).filter((tag: string) => tag !== "blocked"),
  );
  await updatePipelineItemActivity(context.requireDb(), item.id, "working");
  await reloadSnapshot();

  await invoke("send_input", {
    sessionId: item.id,
    input: `${message}\n`,
  });
}
```

4. Rewrite `checkUnblocked()` to choose the in-place path first:

```ts
if (allClear) {
  if (hasLiveTaskResources(blocked)) {
    await resumeBlockedTaskInPlace(blocked);
  } else {
    await startBlockedTask(blocked);
  }
}
```

5. Preserve blocker context when manual unblock removes all blocker rows:

```ts
const updatedBlockers = await listBlockersForItem(context.requireDb(), itemId);
const allClear = updatedBlockers.length === 0 || updatedBlockers.every(
  (blocker) => blocker.closed_at !== null,
);

if (allClear) {
  const resumeBlockers = updatedBlockers.length > 0 ? updatedBlockers : currentBlockers;
  if (hasLiveTaskResources(item)) {
    await resumeBlockedTaskInPlace(item, resumeBlockers);
  } else {
    await startBlockedTask(item);
  }
}
```

6. Rewrite `blockTask()` to update the current task instead of creating a replacement:

```ts
for (const blockerId of blockerIds) {
  await insertTaskBlocker(context.requireDb(), item.id, blockerId);
}

const nextTags = Array.from(new Set([...JSON.parse(item.tags), "blocked"]));
await updatePipelineItemTags(context.requireDb(), item.id, nextTags);
await updatePipelineItemActivity(context.requireDb(), item.id, "idle");
await reloadSnapshot();
await requireService(context.services.selectItem, "selectItem")(item.id);
```

Delete the replacement-item path entirely:

- remove `crypto.randomUUID().slice(0, 8)` replacement creation
- remove `withOptimisticItemOverlay()` from `blockTask()`
- remove dependent-edge transfer logic that existed only because the task id changed
- remove the explicit PTY kill / shell kill / teardown / worktree removal from `blockTask()`

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd apps/desktop
pnpm exec vitest run src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS, including the new in-place block/unblock tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "feat: preserve live task sessions while blocked"
```

### Task 4: Make `closeTask()` Clean Up Live Blocked Tasks and Preserve Legacy Fallback

**Files:**
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Modify: `apps/desktop/src/stores/taskCloseBehavior.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`:

```ts
it("closes a blocked task with live resources through the normal cleanup path", async () => {
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-blocked",
      branch: "task-item-blocked",
      claude_session_id: "claude-item-blocked",
      tags: '["blocked"]',
    }),
  ];

  const store = await createStore();
  await store.selectItem("item-blocked");
  await flushStore();

  await store.closeTask();
  await flushStore();

  expect(mockState.invokeMock).toHaveBeenCalledWith("kill_session", { sessionId: "item-blocked" });
  expect(mockState.invokeMock).toHaveBeenCalledWith("kill_session", { sessionId: "shell-wt-item-blocked" });
});

it("still respawns legacy blocked tasks with no live session context", async () => {
  const blocker = mockState.makeItem({
    id: "item-blocker",
    branch: "task-item-blocker",
    closed_at: "2026-04-14T01:00:00.000Z",
  });

  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-blocked",
      branch: null,
      claude_session_id: null,
      tags: '["blocked"]',
    }),
    blocker,
  ];

  mockState.listBlockersForItemMock
    .mockResolvedValueOnce([blocker])
    .mockResolvedValueOnce([]);

  const store = await createStore();
  await store.editBlockedTask("item-blocked", []);
  await flushStore();

  expect(mockState.invokeMock).toHaveBeenCalledWith(
    "spawn_session",
    expect.objectContaining({ sessionId: "item-blocked" }),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd apps/desktop
pnpm exec vitest run src/stores/kanna.taskBaseBranch.test.ts
```

Expected: FAIL because `closeTask()` still treats every blocked task as inert, and because the in-place unblock path has not been made resource-aware yet.

- [ ] **Step 3: Write the minimal implementation**

In `apps/desktop/src/stores/tasks.ts`, compute live resources before calling `getTaskCloseBehavior()`:

```ts
const hasLiveTaskResources = item.branch !== null || item.claude_session_id !== null || item.port_env !== null;
const teardownCmds = wasBlocked || existingTeardown || !hasLiveTaskResources
  ? []
  : await collectTeardownCommands(item, repo);

const closeBehavior = getTaskCloseBehavior({
  wasBlocked,
  hasLiveTaskResources,
  currentStage: item.stage,
  hasTeardownCommands: teardownCmds.length > 0,
});
```

Gate the inert blocked fast path:

```ts
if (closeBehavior === "finish" && wasBlocked && !hasLiveTaskResources) {
  await removeAllBlockersForItem(context.requireDb(), item.id);
  await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
  if (opts?.selectNext !== false) selectNextItem(nextId);
  await reloadSnapshot();
  return;
}
```

Leave live blocked tasks to fall through the normal cleanup branch so they kill sessions and release ports like any other live task.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd apps/desktop
pnpm exec vitest run src/stores/taskCloseBehavior.test.ts src/stores/kanna.taskBaseBranch.test.ts
pnpm exec tsc --noEmit
```

Expected: all targeted tests PASS and TypeScript exits successfully with code `0`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts apps/desktop/src/stores/taskCloseBehavior.ts apps/desktop/src/stores/taskCloseBehavior.test.ts
git commit -m "fix: clean up live blocked tasks correctly"
```

## Final Verification

- [ ] Run the focused test suites again:

```bash
cd packages/db
pnpm exec vitest run src/queries.test.ts -t "updatePipelineItemTags overwrites tags for a single task"

cd /Users/jeremyhale/Documents/work/jemdiggity/kanna-tauri/.kanna-worktrees/task-63250bf9/apps/desktop
pnpm exec vitest run src/stores/taskCloseBehavior.test.ts src/stores/kanna.taskBaseBranch.test.ts
pnpm exec tsc --noEmit
```

Expected:

- `packages/db` targeted query test passes
- `apps/desktop` targeted store tests pass
- TypeScript exits `0`

- [ ] Inspect git state:

```bash
git status --short
git log --oneline -n 5
```

Expected: only the planned commits are present and the worktree is clean.
