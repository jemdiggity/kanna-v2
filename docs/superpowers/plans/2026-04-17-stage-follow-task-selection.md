# Stage Follow Task Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow destination stages control whether Kanna follows the spawned next-stage task or keeps focus on the next visible sidebar item.

**Architecture:** Extend the workflow stage schema with an optional `follow_task` flag, thread that flag through `advanceStage()`, and give task creation an explicit `selectOnCreate` switch so stage handoff can suppress auto-selection without special-casing PR logic. Keep the selection target stable by computing it before closing the source task and reusing that captured id after the new task is inserted.

**Tech Stack:** TypeScript, Pinia store modules, Vitest, JSON workflow resources

---

## File Structure

- Modify: `packages/core/src/workflow/workflow-types.ts`
  Add `follow_task?: boolean` to `WorkflowStage`.
- Modify: `packages/core/src/workflow/workflow-loader.ts`
  Parse `follow_task` when it is a boolean and ignore non-boolean values.
- Modify: `packages/core/src/workflow/workflow-loader.test.ts`
  Cover parsing for omitted, `true`, `false`, and invalid `follow_task`.
- Modify: `apps/desktop/src/stores/state.ts`
  Add `selectOnCreate?: boolean` to `CreateItemOptions`.
- Modify: `apps/desktop/src/stores/tasks.ts`
  Respect `selectOnCreate` inside the async setup path that currently always calls `selectItem(id)`.
- Modify: `apps/desktop/src/stores/workflow.ts`
  Read `nextStage.follow_task`, capture the pre-close selection target, create the next task with `selectOnCreate: false` when needed, and restore selection afterward.
- Modify: `.kanna/workflows/default.json`
  Set `"follow_task": false` on the built-in `pr` stage.
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
  Add stage-advance selection coverage in the existing store integration harness.

### Task 1: Add Workflow Stage Follow Config

**Files:**
- Modify: `packages/core/src/workflow/workflow-types.ts`
- Modify: `packages/core/src/workflow/workflow-loader.ts`
- Test: `packages/core/src/workflow/workflow-loader.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
it("parses follow_task when explicitly false", () => {
  const json = JSON.stringify({
    name: "My Workflow",
    stages: [{ name: "PR", transition: "manual", follow_task: false }],
  });

  const result = parseWorkflowJson(json);

  expect(result.stages[0].follow_task).toBe(false);
});

it("parses follow_task when explicitly true", () => {
  const json = JSON.stringify({
    name: "My Workflow",
    stages: [{ name: "Stage 1", transition: "manual", follow_task: true }],
  });

  const result = parseWorkflowJson(json);

  expect(result.stages[0].follow_task).toBe(true);
});

it("ignores non-boolean follow_task values", () => {
  const json = JSON.stringify({
    name: "My Workflow",
    stages: [{ name: "Stage 1", transition: "manual", follow_task: "nope" }],
  });

  const result = parseWorkflowJson(json);

  expect(result.stages[0].follow_task).toBeUndefined();
});
```

- [ ] **Step 2: Run the parser tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/core/src/workflow/workflow-loader.test.ts
```

Expected: FAIL with assertions showing `follow_task` is missing from parsed stages.

- [ ] **Step 3: Add the stage type and parser support**

```ts
export interface WorkflowStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string;
  environment?: string;
  transition: "manual" | "auto";
  follow_task?: boolean;
}
```

```ts
function extractStages(obj: Record<string, unknown>): WorkflowStage[] {
  if (!Array.isArray(obj["stages"])) {
    return [];
  }

  return (obj["stages"] as unknown[]).map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Stage at index ${index} must be an object`);
    }
    const s = item as Record<string, unknown>;

    const stage: WorkflowStage = {
      name: typeof s["name"] === "string" ? s["name"] : "",
      transition: (s["transition"] as "manual" | "auto") ?? "",
    };

    if (typeof s["description"] === "string") {
      stage.description = s["description"];
    }
    if (typeof s["agent"] === "string") {
      stage.agent = s["agent"];
    }
    if (typeof s["prompt"] === "string") {
      stage.prompt = s["prompt"];
    }
    if (typeof s["agent_provider"] === "string") {
      stage.agent_provider = s["agent_provider"];
    }
    if (typeof s["environment"] === "string") {
      stage.environment = s["environment"];
    }
    if (typeof s["follow_task"] === "boolean") {
      stage.follow_task = s["follow_task"];
    }

    return stage;
  });
}
```

- [ ] **Step 4: Run the parser tests to verify they pass**

Run:

```bash
pnpm exec vitest run packages/core/src/workflow/workflow-loader.test.ts
```

Expected: PASS for the new `follow_task` cases and the existing workflow loader suite.

- [ ] **Step 5: Commit the parser change**

```bash
git add packages/core/src/workflow/workflow-types.ts \
  packages/core/src/workflow/workflow-loader.ts \
  packages/core/src/workflow/workflow-loader.test.ts
git commit -m "feat: add workflow stage follow-task config"
```

### Task 2: Add Task-Creation Selection Control

**Files:**
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/tasks.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing store test for create-time selection suppression**

```ts
it("does not auto-select a created task when selectOnCreate is false", async () => {
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-active",
      branch: "task-item-active",
      prompt: "Keep me selected",
      created_at: "2026-04-14T00:01:00.000Z",
      updated_at: "2026-04-14T00:01:00.000Z",
    }),
  ];

  const store = await createStore();
  await store.selectItem("item-active");
  await flushStore();

  await store.createItem("repo-1", "/tmp/repo", "Spawn without follow", "sdk", {
    agentProvider: "claude",
    selectOnCreate: false,
  });

  await flushStore();

  expect(store.selectedItemId).toBe("item-active");
});
```

- [ ] **Step 2: Run the store test to verify it fails**

Run:

```bash
pnpm exec vitest run apps/desktop/src/stores/kanna.taskBaseBranch.test.ts -t "does not auto-select a created task when selectOnCreate is false"
```

Expected: FAIL because `createItem()` currently selects the new task unconditionally after spawn setup.

- [ ] **Step 3: Add `selectOnCreate` to the create-item options and gate the selection**

```ts
export interface CreateItemOptions {
  baseBranch?: string;
  tags?: string[];
  workflowName?: string;
  stage?: string;
  customTask?: import("@kanna/core").CustomTaskConfig;
  agentProvider?: AgentProvider;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  selectOnCreate?: boolean;
}
```

```ts
async function setupWorktreeAndSpawn(
  id: string,
  repoPath: string,
  worktreePath: string,
  branch: string,
  portEnv: Record<string, string>,
  workflowPrompt: string,
  agentType: "pty" | "sdk",
  agentProvider: AgentProvider,
  opts?: CreateItemOptions,
) {
  // existing setup and spawn flow

  if (opts?.selectOnCreate !== false) {
    await requireService(context.services.selectItem, "selectItem")(id);
  }
}
```

- [ ] **Step 4: Run the focused store test to verify it passes**

Run:

```bash
pnpm exec vitest run apps/desktop/src/stores/kanna.taskBaseBranch.test.ts -t "does not auto-select a created task when selectOnCreate is false"
```

Expected: PASS, with `selectedItemId` remaining on the previously selected task.

- [ ] **Step 5: Commit the create-item selection control**

```bash
git add apps/desktop/src/stores/state.ts \
  apps/desktop/src/stores/tasks.ts \
  apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "feat: allow task creation without selection handoff"
```

### Task 3: Apply Stage-Level Follow Policy To Stage Advance

**Files:**
- Modify: `apps/desktop/src/stores/workflow.ts`
- Modify: `.kanna/workflows/default.json`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing stage-advance tests**

```ts
it("keeps selection on the next visible item when the destination stage sets follow_task to false", async () => {
  mockState.workflowDefinition = {
    name: "default",
    stages: [
      { name: "in progress", transition: "manual" },
      { name: "pr", transition: "manual", follow_task: false },
    ],
  };
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-source",
      branch: "task-source",
      stage: "in progress",
      created_at: "2026-04-14T00:02:00.000Z",
      updated_at: "2026-04-14T00:02:00.000Z",
    }),
    mockState.makeItem({
      id: "item-next",
      branch: "task-next",
      stage: "in progress",
      created_at: "2026-04-14T00:01:00.000Z",
      updated_at: "2026-04-14T00:01:00.000Z",
    }),
  ];

  const store = await createStore();
  await store.selectItem("item-source");
  await flushStore();

  await store.advanceStage("item-source");
  await flushStore();

  expect(store.selectedItemId).toBe("item-next");
});

it("still follows the spawned task when follow_task is omitted", async () => {
  mockState.workflowDefinition = {
    name: "default",
    stages: [
      { name: "in progress", transition: "manual" },
      { name: "review", transition: "manual" },
    ],
  };
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-source",
      branch: "task-source",
      stage: "in progress",
    }),
    mockState.makeItem({
      id: "item-next",
      branch: "task-next",
      stage: "in progress",
      created_at: "2026-04-14T00:01:00.000Z",
      updated_at: "2026-04-14T00:01:00.000Z",
    }),
  ];

  const store = await createStore();
  await store.selectItem("item-source");
  await flushStore();

  await store.advanceStage("item-source");

  await vi.waitFor(() => {
    expect(
      mockState.workflowItems.some((item) => item.id === store.selectedItemId && item.stage === "review")
    ).toBe(true);
  });
});

it("leaves selection unset when follow_task is false and there is no next visible item", async () => {
  mockState.workflowDefinition = {
    name: "default",
    stages: [
      { name: "in progress", transition: "manual" },
      { name: "pr", transition: "manual", follow_task: false },
    ],
  };
  mockState.workflowItems = [
    mockState.makeItem({
      id: "item-source",
      branch: "task-source",
      stage: "in progress",
    }),
  ];

  const store = await createStore();
  await store.selectItem("item-source");
  await flushStore();

  await store.advanceStage("item-source");
  await flushStore();

  await vi.waitFor(() => {
    expect(store.selectedItemId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused stage-advance tests to verify they fail**

Run:

```bash
pnpm exec vitest run apps/desktop/src/stores/kanna.taskBaseBranch.test.ts -t "follow_task"
```

Expected: FAIL because `advanceStage()` does not read `nextStage.follow_task` and the spawned task still auto-selects itself.

- [ ] **Step 3: Thread the destination-stage policy through `advanceStage()`**

```ts
async function advanceStage(taskId: string): Promise<void> {
  const item = context.state.items.value.find((candidate) => candidate.id === taskId);
  if (!item?.branch) return;

  // existing repo and workflow lookup

  const nextStage = getNextStage(workflow, item.stage);
  if (!nextStage) {
    context.toast.warning(context.tt("toasts.taskAtFinalStage"));
    return;
  }

  const shouldFollowTask = nextStage.follow_task !== false;
  const sortedItems = requireService(context.services.sortedItemsForCurrentRepo, "sortedItemsForCurrentRepo").value;
  const sourceIndex = sortedItems.findIndex((candidate) => candidate.id === item.id);
  const remainingItems = sortedItems.filter((candidate) => candidate.id !== item.id);
  const preservedIndex = sourceIndex >= remainingItems.length ? remainingItems.length - 1 : sourceIndex;
  const preservedSelectionId = shouldFollowTask ? null : (remainingItems[preservedIndex]?.id ?? null);

  // existing prompt and agent resolution

  await requireService(context.services.closeTask, "closeTask")(item.id, { selectNext: false });
  await requireService(context.services.createItem, "createItem")(repo.id, repo.path, stagePrompt, "pty", {
    baseBranch: item.branch,
    workflowName: item.workflow,
    stage: nextStage.name,
    selectOnCreate: shouldFollowTask,
    ...agentOpts,
  });

  if (!shouldFollowTask && preservedSelectionId) {
    const preservedItem = context.state.items.value.find((candidate) => candidate.id === preservedSelectionId && candidate.stage !== "done");
    if (preservedItem) {
      await requireService(context.services.selectItem, "selectItem")(preservedItem.id);
    }
  }
}
```

- [ ] **Step 4: Update the built-in PR stage to opt out**

```json
{
  "name": "pr",
  "description": "Agent creates a GitHub PR",
  "agent": "pr",
  "prompt": "Create a PR for the work on branch $BRANCH. Previous result: $PREV_RESULT",
  "transition": "manual",
  "follow_task": false
}
```

- [ ] **Step 5: Run the stage-advance and parser suites to verify the feature**

Run:

```bash
pnpm exec vitest run packages/core/src/workflow/workflow-loader.test.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS for parser coverage, `selectOnCreate` coverage, and stage-advance selection coverage.

- [ ] **Step 6: Run type-checking for the touched TypeScript surface**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit the stage-follow behavior**

```bash
git add apps/desktop/src/stores/workflow.ts \
  apps/desktop/src/stores/kanna.taskBaseBranch.test.ts \
  .kanna/workflows/default.json
git commit -m "feat: make stage handoff selection configurable"
```
