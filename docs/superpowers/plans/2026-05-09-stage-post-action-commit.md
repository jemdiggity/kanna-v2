# Stage Post-Action Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visible `commit` workflow stage with a generic post-action attached to `in progress`, keeping tasks grouped as `in progress` until commit completes.

**Architecture:** Workflow stages gain a single optional `post_action` object. Runtime state lives on `pipeline_item.active_post_action`; `pipeline_item.stage` remains the grouping and stage-advance source of truth. Stage completion handling treats `stage_result` as a post-action result when `active_post_action` is set, clears the marker on success, then advances to the next real stage with an explicit `skipPostAction` option.

**Tech Stack:** TypeScript, Vue 3, Pinia, Vitest, SQLite migrations, Tauri command mocks, WebDriver E2E.

---

### Task 1: Parse Post-Actions And Update Built-In Workflow Shape

**Files:**
- Modify: `packages/core/src/workflow/workflow-types.ts`
- Modify: `packages/core/src/workflow/workflow-loader.ts`
- Modify: `packages/core/src/workflow/workflow-loader.test.ts`
- Modify: `packages/core/src/config/repo-config.ts`
- Modify: `packages/core/src/config/repo-config.test.ts`
- Modify: `.kanna/workflows/default.json`
- Modify: `.kanna/workflows/qa.json`
- Modify: `.kanna/workflows/schema.json`

- [ ] **Step 1: Write failing parser tests**

Add these tests to `describe("parseWorkflowJson", ...)` in `packages/core/src/workflow/workflow-loader.test.ts`:

```ts
  it("parses a stage post_action", () => {
    const json = JSON.stringify({
      name: "My Workflow",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: {
            name: "commit",
            description: "Commit the relevant work",
            agent: "commit",
            prompt: "Commit $TASK_PROMPT",
            agent_provider: ["codex", "claude"],
            transition: "auto",
          },
        },
        { name: "pr", transition: "manual" },
      ],
    });

    const result = parseWorkflowJson(json);

    expect(result.stages[0].post_action).toEqual({
      name: "commit",
      description: "Commit the relevant work",
      agent: "commit",
      prompt: "Commit $TASK_PROMPT",
      agent_provider: ["codex", "claude"],
      transition: "auto",
    });
  });

  it("ignores non-object post_action values", () => {
    const json = JSON.stringify({
      name: "My Workflow",
      stages: [{ name: "in progress", transition: "manual", post_action: "commit" }],
    });

    const result = parseWorkflowJson(json);

    expect(result.stages[0].post_action).toBeUndefined();
  });
```

Add these tests to `describe("validateWorkflow", ...)`:

```ts
  it("returns error for post_action without a name", () => {
    const workflow = {
      name: "Workflow",
      stages: [
        {
          name: "in progress",
          transition: "manual" as const,
          post_action: { transition: "auto" as const },
        },
      ],
    };

    const errors = validateWorkflow(workflow);

    expect(errors.some((error) => error.includes("post_action") && error.includes("name"))).toBe(true);
  });

  it("returns error for invalid post_action transition", () => {
    const workflow = {
      name: "Workflow",
      stages: [
        {
          name: "in progress",
          transition: "manual" as const,
          post_action: { name: "commit", transition: "sideways" as "auto" },
        },
      ],
    };

    const errors = validateWorkflow(workflow);

    expect(errors.some((error) => error.includes("post_action") && error.includes("transition"))).toBe(true);
  });
```

Update the first test in `packages/core/src/config/repo-config.test.ts` to expect no built-in `commit` stage order:

```ts
  it("omits commit from the built-in stage display order", () => {
    expect(DEFAULT_STAGE_ORDER).toEqual(["merge", "pr", "review", "in progress"]);
    expect(DEFAULT_STAGE_ORDER).not.toContain("commit");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts src/config/repo-config.test.ts
```

Expected: FAIL because `post_action` is not typed or parsed, validation does not inspect it, and `DEFAULT_STAGE_ORDER` still includes `commit`.

- [ ] **Step 3: Add post-action types**

In `packages/core/src/workflow/workflow-types.ts`, add:

```ts
export interface WorkflowPostAction {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string | string[];
  transition: "manual" | "auto";
}
```

Then add this property to `WorkflowStage`:

```ts
  post_action?: WorkflowPostAction;
```

- [ ] **Step 4: Add parser and validation support**

In `packages/core/src/workflow/workflow-loader.ts`, add this helper above `extractStages`:

```ts
function extractPostAction(value: unknown): WorkflowStage["post_action"] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const postAction: WorkflowStage["post_action"] = {
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    transition: (raw["transition"] as "manual" | "auto") ?? "",
  };
  if (typeof raw["description"] === "string") postAction.description = raw["description"];
  if (typeof raw["agent"] === "string") postAction.agent = raw["agent"];
  if (typeof raw["prompt"] === "string") postAction.prompt = raw["prompt"];
  if (
    typeof raw["agent_provider"] === "string" ||
    (Array.isArray(raw["agent_provider"]) && raw["agent_provider"].every((entry) => typeof entry === "string"))
  ) {
    postAction.agent_provider = raw["agent_provider"] as string | string[];
  }
  return postAction;
}
```

In `extractStages`, after `mode` parsing, add:

```ts
    const postAction = extractPostAction(s["post_action"]);
    if (postAction) {
      stage.post_action = postAction;
    }
```

In `validateWorkflow`, inside the stage loop, add:

```ts
    if (stage.post_action !== undefined) {
      if (!stage.post_action.name || typeof stage.post_action.name !== "string" || stage.post_action.name.trim() === "") {
        errors.push(`Stage "${stage.name ?? "(unnamed)"}" has post_action with missing name`);
      }
      if (stage.post_action.transition !== "manual" && stage.post_action.transition !== "auto") {
        errors.push(
          `Stage "${stage.name ?? "(unnamed)"}" has post_action "${stage.post_action.name ?? "(unnamed)"}" with invalid transition "${stage.post_action.transition as string}"; must be "manual" or "auto"`,
        );
      }
    }
```

- [ ] **Step 5: Remove commit from built-in stage order**

In `packages/core/src/config/repo-config.ts`, change:

```ts
export const DEFAULT_STAGE_ORDER: readonly string[] = ["merge", "pr", "review", "in progress"];
```

- [ ] **Step 6: Update built-in workflow JSON**

In `.kanna/workflows/default.json`, make the stages:

```json
[
  {
    "name": "in progress",
    "description": "Agent implements the task",
    "agent": "implement",
    "prompt": "$TASK_PROMPT",
    "transition": "manual",
    "post_action": {
      "name": "commit",
      "description": "Implementation agent commits the relevant work",
      "agent": "commit",
      "prompt": "Commit the relevant work for this task. Original task: $TASK_PROMPT",
      "transition": "auto"
    }
  },
  {
    "name": "pr",
    "description": "Agent creates a GitHub PR",
    "agent": "pr",
    "prompt": "Create a PR for the work on branch $BRANCH. Previous result: $PREV_RESULT",
    "transition": "manual",
    "follow_task": false
  }
]
```

In `.kanna/workflows/qa.json`, make `in progress` contain the same `post_action`, remove the standalone `commit` stage, and keep `review` then `pr`.

In `.kanna/workflows/schema.json`, add `post_action` to stage properties with the same fields as a stage-local action:

```json
"post_action": {
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "transition"],
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "agent": { "type": "string" },
    "prompt": { "type": "string" },
    "agent_provider": {
      "oneOf": [
        { "enum": ["codex", "claude", "copilot"] },
        {
          "type": "array",
          "items": { "enum": ["codex", "claude", "copilot"] },
          "minItems": 1
        }
      ]
    },
    "transition": { "enum": ["manual", "auto"] }
  }
}
```

Also update the schema example to use `post_action` on `in progress` and remove the standalone `commit` stage.

- [ ] **Step 7: Run tests to verify pass**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts src/config/repo-config.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/core/src/workflow/workflow-types.ts packages/core/src/workflow/workflow-loader.ts packages/core/src/workflow/workflow-loader.test.ts packages/core/src/config/repo-config.ts packages/core/src/config/repo-config.test.ts .kanna/workflows/default.json .kanna/workflows/qa.json .kanna/workflows/schema.json
git commit -m "feat: define workflow post actions"
```

### Task 2: Persist Active Post-Action State

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`
- Modify: `packages/db/src/queries.test.ts`
- Modify: `packages/db/src/migrations/001_initial.sql`
- Modify: `apps/desktop/src/stores/db.ts`
- Modify: `apps/desktop/src/utils/taskTransfer.ts`

- [ ] **Step 1: Write failing query tests**

In `packages/db/src/queries.test.ts`, add the new helpers to the existing `@kanna/db` import list:

```ts
  clearPipelineItemActivePostAction,
  updatePipelineItemActivePostAction,
```

Add tests inside `describe("pipeline_item queries", ...)`:

```ts
  it("sets and clears the active post-action", async () => {
    const db = createMockDb();
    await insertPipelineItem(db, makePipelineItem({ id: "pi-post-action" }));

    await updatePipelineItemActivePostAction(db, "pi-post-action", "commit");
    let rows = await db.select<PipelineItem>("SELECT * FROM pipeline_item WHERE id = ?", ["pi-post-action"]);
    expect(rows[0].active_post_action).toBe("commit");

    await clearPipelineItemActivePostAction(db, "pi-post-action");
    rows = await db.select<PipelineItem>("SELECT * FROM pipeline_item WHERE id = ?", ["pi-post-action"]);
    expect(rows[0].active_post_action).toBeNull();
  });
```

Update the mock insert row shape in `packages/db/src/queries.test.ts` so inserted items include:

```ts
active_post_action: null,
```

Add mock SQL handling for:

```ts
if (query.startsWith("UPDATE pipeline_item SET active_post_action = ?")) {
  const [activePostAction, id] = bindValues as [string, string];
  const item = tables.pipeline_item.find((p) => p.id === id);
  if (item) item.active_post_action = activePostAction;
  return { rowsAffected: item ? 1 : 0 };
}

if (query.startsWith("UPDATE pipeline_item SET active_post_action = NULL")) {
  const [id] = bindValues as [string];
  const item = tables.pipeline_item.find((p) => p.id === id);
  if (item) item.active_post_action = null;
  return { rowsAffected: item ? 1 : 0 };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/db exec vitest run src/queries.test.ts --testNamePattern "active post-action"
```

Expected: FAIL because the schema and helper functions do not exist yet.

- [ ] **Step 3: Add schema field**

In `packages/db/src/schema.ts`, add to `PipelineItem` after `stage_result`:

```ts
  active_post_action: string | null;
```

- [ ] **Step 4: Add query helpers**

In `packages/db/src/queries.ts`, after `clearPipelineItemStageResult`, add:

```ts
export async function updatePipelineItemActivePostAction(
  db: DbHandle,
  id: string,
  activePostAction: string,
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET active_post_action = ?, updated_at = datetime('now') WHERE id = ?`,
    [activePostAction, id],
  );
}

export async function clearPipelineItemActivePostAction(
  db: DbHandle,
  id: string,
): Promise<void> {
  await db.execute(
    `UPDATE pipeline_item SET active_post_action = NULL, updated_at = datetime('now') WHERE id = ?`,
    [id],
  );
}
```

Update the `insertPipelineItem` omit list to include `"active_post_action"`:

```ts
Omit<PipelineItem, "created_at" | "updated_at" | "activity_changed_at" | "unread_at" | "pinned" | "pin_order" | "display_name" | "closed_at" | "workflow" | "stage" | "stage_result" | "active_post_action" | "tags" | "base_ref" | "agent_session_id" | "previous_stage" | "last_output_preview">
```

- [ ] **Step 5: Add migrations**

In `packages/db/src/migrations/001_initial.sql`, add the column to the initial `pipeline_item` table:

```sql
    active_post_action TEXT,
```

In `apps/desktop/src/stores/db.ts`, add a migration after `011_pipeline_item_last_output_preview`:

```ts
  await runMigration("012_pipeline_item_active_post_action", async () => {
    await addColumn("pipeline_item", "active_post_action", "TEXT");
  });
```

Then renumber later migration IDs to avoid collisions:

```ts
"013_task_transfer_tables"
"014_task_transfer_payload_json"
"015_agent_session_id_rename"
"016_repo_sort_order"
```

- [ ] **Step 6: Preserve active post-action in task transfer payloads**

In `apps/desktop/src/utils/taskTransfer.ts`, add `active_post_action` to `OutgoingTransferPayload.task`:

```ts
    active_post_action: string | null;
```

Add it to `BuildOutgoingTransferPayloadInput.item`:

```ts
    "id" | "prompt" | "stage" | "active_post_action" | "branch" | "workflow" | "display_name" | "base_ref" | "agent_type" | "agent_provider" | "agent_session_id"
```

Add it to `buildOutgoingTransferPayload`:

```ts
      active_post_action: input.item.active_post_action,
```

In `apps/desktop/src/utils/taskTransfer.test.ts`, update the expected task payloads for normal tasks to include:

```ts
active_post_action: null,
```

- [ ] **Step 7: Run tests to verify pass**

Run:

```bash
pnpm --dir packages/db exec vitest run src/queries.test.ts --testNamePattern "active post-action"
pnpm --dir apps/desktop exec vitest run src/utils/taskTransfer.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/queries.test.ts packages/db/src/migrations/001_initial.sql apps/desktop/src/stores/db.ts apps/desktop/src/utils/taskTransfer.ts
git commit -m "feat: persist active task post actions"
```

### Task 3: Enter Commit Post-Action Without Changing Stage

**Files:**
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write failing store tests**

In `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`, update `mockState.makeItem` base data to include:

```ts
active_post_action: null,
```

Add mocks for the new DB helpers in the existing `@kanna/db` mock:

```ts
const updatePipelineItemActivePostActionMock = vi.fn(async (_db: DbHandle, itemId: string, activePostAction: string) => {
  const item = mockState.workflowItems.find((candidate) => candidate.id === itemId);
  if (item) item.active_post_action = activePostAction;
});
const clearPipelineItemActivePostActionMock = vi.fn(async (_db: DbHandle, itemId: string) => {
  const item = mockState.workflowItems.find((candidate) => candidate.id === itemId);
  if (item) item.active_post_action = null;
});
```

Reset them in `beforeEach`, expose them from `mockState`, and return them from the `@kanna/db` mock.

Add this test near the existing continue-mode tests:

```ts
  it("starts a stage post-action without changing the task stage", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: {
            name: "commit",
            transition: "auto",
            agent: "commit",
            prompt: "Commit $TASK_PROMPT",
          },
        },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
        agent_provider: "codex",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.updatePipelineItemActivePostActionMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.updatePipelineItemStageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.workflowItems[0].stage).toBe("in progress");
    expect(mockState.closePipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.clearPipelineItemStageResultMock).toHaveBeenCalledWith(expect.anything(), "item-source");
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[200~Stage prompt\x1b[201~\r")),
    });
  });
```

Add this test to prove completed post-actions can skip re-entry:

```ts
  it("skips the post-action and advances to the next real stage when requested", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: { name: "commit", transition: "auto", agent: "commit" },
        },
        { name: "pr", transition: "manual", agent: "pr" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "committed" }),
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source", { initiatedBy: "auto", skipPostAction: true });

    expect(mockState.updatePipelineItemActivePostActionMock).not.toHaveBeenCalled();
    expect(mockState.closePipelineItemMock).toHaveBeenCalledWith(expect.anything(), "item-source", expect.anything());
    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stage: "pr", prompt: "Stage prompt" }),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts --testNamePattern "post-action"
```

Expected: FAIL because `active_post_action`, post-action entry, and `skipPostAction` do not exist.

- [ ] **Step 3: Extend advance options**

In `apps/desktop/src/stores/state.ts`, update `AdvanceStageOptions`:

```ts
export interface AdvanceStageOptions {
  initiatedBy?: "manual" | "auto";
  skipPostAction?: boolean;
}
```

- [ ] **Step 4: Add post-action helpers to `workflow.ts`**

In `apps/desktop/src/stores/workflow.ts`, update imports:

```ts
import {
  clearPipelineItemStageResult,
  getRepo,
  updatePipelineItemActivePostAction,
  updatePipelineItemStage,
} from "@kanna/db";
```

Update the type import:

```ts
import type { AgentDefinition, WorkflowDefinition, WorkflowPostAction, WorkflowStage } from "../../../../packages/core/src/workflow/workflow-types";
```

Add a helper to resolve prompt and options for either a stage or post-action:

```ts
  async function buildExecutionPrompt(
    repoPath: string,
    item: import("@kanna/db").PipelineItem,
    sourceBranch: string,
    sourceWorktree: string | undefined,
    execution: WorkflowStage | WorkflowPostAction,
  ): Promise<{ prompt: string; agentProvider: import("@kanna/db").AgentProvider; agent: AgentDefinition | null }> {
    if (!execution.agent) {
      return { prompt: "", agentProvider: item.agent_provider, agent: null };
    }
    const agent = await loadAgent(repoPath, execution.agent);
    const prompt = buildStagePrompt(agent.prompt, execution.prompt, {
      taskPrompt: item.prompt ?? "",
      prevResult: item.stage_result ?? undefined,
      branch: sourceBranch,
      baseRef: item.base_ref ?? undefined,
      sourceWorktree,
    });
    const preferredProviders = getPreferredAgentProviders({
      stage: execution.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
      agent: agent.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
      item: item.agent_provider,
    });
    const agentProvider = resolveAgentProvider(
      preferredProviders,
      await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
    );
    return { prompt, agentProvider, agent };
  }
```

Add an `enterPostAction` helper:

```ts
  async function enterPostAction(
    item: import("@kanna/db").PipelineItem,
    postAction: WorkflowPostAction,
    stagePrompt: string,
    agentProvider: string | null | undefined,
  ): Promise<void> {
    await continueStageInPlace(
      item.id,
      item.stage,
      item.stage,
      stagePrompt,
      agentProvider,
      item.agent_provider === "claude" && Boolean(item.prompt),
      async () => {
        await updatePipelineItemActivePostAction(context.requireDb(), item.id, postAction.name);
      },
    );
  }
```

Change `continueStageInPlace` to accept a pre-update callback:

```ts
    beforeClearResult?: () => Promise<void>,
```

Inside the try block, replace the unconditional stage update with:

```ts
      if (previousStageName !== nextStageName) {
        await updatePipelineItemStage(context.requireDb(), taskId, nextStageName);
      }
      await beforeClearResult?.();
```

- [ ] **Step 5: Use post-action entry in `advanceStage`**

In `advanceStage`, after resolving `sourceBranch` and `sourceWorktree`, add before `getNextStage` new-task behavior:

```ts
    const currentStage = workflow.stages.find((stage) => stage.name === item.stage);
    if (!options.skipPostAction && !item.active_post_action && currentStage?.post_action) {
      try {
        const execution = await buildExecutionPrompt(repo.path, item, sourceBranch, sourceWorktree, currentStage.post_action);
        await enterPostAction(item, currentStage.post_action, execution.prompt, execution.agentProvider);
      } catch (error) {
        console.error("[store] advanceStage: failed to enter post-action:", error);
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      }
      return;
    }
```

Then refactor the existing next-stage agent prompt code to call `buildExecutionPrompt(repo.path, item, sourceBranch, sourceWorktree, nextStage)` instead of duplicating provider resolution.

- [ ] **Step 6: Run tests to verify pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts --testNamePattern "post-action"
```

Expected: PASS.

- [ ] **Step 7: Run broader store tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add apps/desktop/src/stores/state.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "feat: enter task post actions in place"
```

### Task 4: Complete And Rerun Active Post-Actions

**Files:**
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Modify: `apps/desktop/src/stores/init.test.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write failing completion tests**

In `apps/desktop/src/stores/init.test.ts`, update base task fixtures to include:

```ts
active_post_action: null,
```

Add a test near the existing `workflow_stage_complete` tests:

```ts
  it("clears a successful active post-action and advances to the next real stage", async () => {
    const taskId = "task-post-action";
    mockState.workflowItems = [
      mockState.makeItem({
        id: taskId,
        stage: "in progress",
        active_post_action: "commit",
        stage_result: JSON.stringify({ status: "success", summary: "committed" }),
      }),
    ];
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: { name: "commit", transition: "auto", agent: "commit" },
        },
        { name: "pr", transition: "manual" },
      ],
    };

    await emitWorkflowStageComplete(taskId);

    expect(mockState.clearPipelineItemActivePostActionMock).toHaveBeenCalledWith(expect.anything(), taskId);
    expect(mockState.advanceStageMock).toHaveBeenCalledWith(taskId, {
      initiatedBy: "auto",
      skipPostAction: true,
    });
  });

  it("leaves a failed active post-action in place", async () => {
    const taskId = "task-post-action-failed";
    mockState.workflowItems = [
      mockState.makeItem({
        id: taskId,
        stage: "in progress",
        active_post_action: "commit",
        stage_result: JSON.stringify({ status: "failure", summary: "dirty unrelated files" }),
      }),
    ];

    await emitWorkflowStageComplete(taskId);

    expect(mockState.clearPipelineItemActivePostActionMock).not.toHaveBeenCalled();
    expect(mockState.advanceStageMock).not.toHaveBeenCalled();
  });
```

Use this helper in `apps/desktop/src/stores/init.test.ts` to retrieve the registered listener:

```ts
function getStageCompleteHandler(): (event: unknown) => Promise<void> {
  const handler = mockState.listenMock.mock.calls.find(
    ([eventName]) => eventName === "workflow_stage_complete",
  )?.[1] as ((event: unknown) => Promise<void>) | undefined;
  if (!handler) throw new Error("workflow_stage_complete handler was not registered");
  return handler;
}
```

Then call it in the completion tests:

```ts
await getStageCompleteHandler()({ payload: { task_id: taskId } });
```

- [ ] **Step 2: Write failing rerun test**

In `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`, add:

```ts
  it("reruns the active post-action prompt instead of the parent stage prompt", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          agent: "implement",
          prompt: "Implement $TASK_PROMPT",
          post_action: {
            name: "commit",
            transition: "auto",
            agent: "commit",
            prompt: "Commit $TASK_PROMPT",
          },
        },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        active_post_action: "commit",
      }),
    ];

    const store = await createStore();

    await store.rerunStage("item-source");

    expect(buildStagePrompt).toHaveBeenCalledWith(
      "Agent prompt",
      "Commit $TASK_PROMPT",
      expect.objectContaining({ taskPrompt: expect.any(String) }),
    );
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/init.test.ts --testNamePattern "post-action"
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts --testNamePattern "reruns the active post-action"
```

Expected: FAIL because completion does not clear `active_post_action`, and rerun uses the parent stage.

- [ ] **Step 4: Update completion handler**

In `apps/desktop/src/stores/init.ts`, import:

```ts
import { clearPipelineItemActivePostAction, updatePipelineItemActivity } from "@kanna/db";
```

In the `workflow_stage_complete` listener, after parsing a successful result and claiming `stage_result`, branch on `claimedItemSnapshot.active_post_action`:

```ts
              if (claimedItemSnapshot.active_post_action) {
                await clearPipelineItemActivePostAction(context.requireDb(), taskId);
                await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
                const claimedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
                if (claimedItem) {
                  Object.assign(claimedItem, claimedItemSnapshot);
                  claimedItem.active_post_action = null;
                  claimedItem.stage_result = claimedResult;
                }
                await requireService(context.services.advanceStage, "advanceStage")(taskId, {
                  initiatedBy: "auto",
                  skipPostAction: true,
                });
              } else {
                await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
                const claimedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
                if (claimedItem) {
                  Object.assign(claimedItem, claimedItemSnapshot);
                  claimedItem.stage_result = claimedResult;
                }
                await requireService(context.services.advanceStage, "advanceStage")(taskId, { initiatedBy: "auto" });
              }
```

Keep the existing failure behavior: no advance, unread marker still applied if the task is not selected.

- [ ] **Step 5: Update rerun behavior**

In `apps/desktop/src/stores/workflow.ts`, in `rerunStage`, after resolving `currentStage`, add:

```ts
    const activePostAction = item.active_post_action
      ? currentStage.post_action?.name === item.active_post_action
        ? currentStage.post_action
        : null
      : null;
    const execution = activePostAction ?? currentStage;
```

Then replace uses of `currentStage.agent`, `currentStage.prompt`, and `currentStage.agent_provider` in the prompt/spawn block with `execution.agent`, `execution.prompt`, and `execution.agent_provider`.

Keep `currentStage.environment` for stage setup scripts. Do not add an `environment` field to post-actions in this task.

- [ ] **Step 6: Run tests to verify pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/init.test.ts --testNamePattern "post-action"
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts --testNamePattern "reruns the active post-action"
```

Expected: PASS.

- [ ] **Step 7: Run broader tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/init.test.ts src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add apps/desktop/src/stores/init.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/init.test.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "feat: complete task post actions"
```

### Task 5: Render Active Post-Actions In The Sidebar

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/components/__tests__/Sidebar.test.ts`
- Modify: `apps/desktop/src/stores/selection.test.ts`
- Modify: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
- Modify: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Write failing sidebar test**

In `apps/desktop/src/components/__tests__/Sidebar.test.ts`, update the `item` helper base to include:

```ts
active_post_action: null,
```

Add:

```ts
  it("prefixes active post-action tasks with an ASCII ellipsis and keeps the stage group", () => {
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Fix sidebar task ordering",
        active_post_action: "commit",
        stage: "in progress",
      }),
    ]);

    expect(wrapper.text()).toContain("in progress");
    expect(wrapper.text()).toContain("... Fix sidebar task ordering");
    expect(wrapper.text()).not.toContain("commit");
  });

  it("prefixes pinned active post-action tasks", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Pinned task",
        active_post_action: "commit",
        pinned: 1,
        pin_order: 0,
      }),
    ]);

    expect(wrapper.text()).toContain("... Pinned task");
  });
```

Update other test item helpers in `apps/desktop/src/stores/selection.test.ts`, `apps/desktop/src/stores/kanna.querySnapshot.test.ts`, and `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts` to include `active_post_action: null` in `PipelineItem` fixtures.

In `apps/desktop/src/stores/selection.test.ts`, update the built-in stage order expectation:

```ts
expect(api.getStageOrder("repo-1")).toEqual(["merge", "pr", "review", "in progress"]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts --testNamePattern "post-action"
pnpm --dir apps/desktop exec vitest run src/stores/selection.test.ts
```

Expected: FAIL because `itemTitle` does not add the prefix and stage order mocks still include `commit`.

- [ ] **Step 3: Add sidebar prefix**

In `apps/desktop/src/components/Sidebar.vue`, change `itemTitle` to:

```ts
function itemTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
  const truncated = raw.length > 40 ? raw.slice(0, 40) + "..." : raw;
  return item.active_post_action ? `... ${truncated}` : truncated;
}
```

Update `beforeEach` and `afterEach` in `Sidebar.test.ts` to use:

```ts
getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts src/stores/selection.test.ts src/stores/kanna.querySnapshot.test.ts src/stores/kanna.runtimeStatusSync.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop/src/components/Sidebar.vue apps/desktop/src/components/__tests__/Sidebar.test.ts apps/desktop/src/stores/selection.test.ts apps/desktop/src/stores/kanna.querySnapshot.test.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts
git commit -m "feat: show active post actions in sidebar"
```

### Task 6: Update E2E Coverage For Post-Action Flow

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/stage-advance.test.ts`
- Modify: `apps/desktop/tests/e2e/mock/stage-order.test.ts`

- [ ] **Step 1: Write failing E2E updates**

In `apps/desktop/tests/e2e/mock/stage-advance.test.ts`, change the `continue-e2e` workflow setup from a standalone `commit` stage to:

```ts
stages: [
  {
    name: "in progress",
    transition: "manual",
    post_action: {
      name: "commit",
      transition: "auto",
      agent: "commit-e2e",
      prompt: "Commit stage marker for $TASK_PROMPT",
    },
  },
  { name: "pr", transition: "manual" },
],
```

Update the test named `"advances a live task into a continue-mode commit stage through the daemon input command"` to:

```ts
it("starts a live task commit post-action through the daemon input command", async () => {
  const advanceResult = await callVueMethod(client, "store.advanceStage", taskId);
  if (isVueCallError(advanceResult)) throw new Error(advanceResult.__error);

  await waitForStage(client, taskId, "in progress");
  const rows = (await queryDb(
    client,
    "SELECT stage, active_post_action FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<{ stage: string; active_post_action: string | null }>;
  expect(rows[0]).toEqual({ stage: "in progress", active_post_action: "commit" });
  await waitForFileSize(inputCapturePath, expectedInput.length);
  expect(await readFile(inputCapturePath)).toEqual(expectedInput);
});
```

Make the same DB assertion change in the Claude and Copilot input tests: expect `stage = "in progress"` and `active_post_action = "commit"` instead of waiting for `stage = "commit"`.

Add a completion test:

```ts
it("clears a successful commit post-action and creates the PR task", async () => {
  const taskId = "post-action-complete-task";
  await execDb(
    client,
    `INSERT INTO pipeline_item (
       id, repo_id, prompt, workflow, stage, active_post_action, stage_result, tags, branch,
       agent_type, agent_provider, activity, display_name, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      taskId,
      repoId,
      "Complete commit post-action",
      "continue-e2e",
      "in progress",
      "commit",
      JSON.stringify({ status: "success", summary: "committed" }),
      "[]",
      "task-post-action-complete",
      "pty",
      "codex",
      "idle",
      null,
    ],
  );
  await hydrateStoreItem(client, taskId);

  await sendWorkflowStageComplete(client, taskId);

  const prTaskId = await waitForCreatedStageTask(client, repoId, "pr");
  expect(prTaskId).not.toBe(taskId);
  const rows = (await queryDb(
    client,
    "SELECT active_post_action FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<{ active_post_action: string | null }>;
  expect(rows[0]?.active_post_action).toBeNull();
});
```

In `apps/desktop/tests/e2e/mock/stage-order.test.ts`, remove assumptions that a visible `commit` section appears by default. Replace expected stage labels:

```ts
await waitForStageLabels(client, repoId, ["review", "in progress"]);
```

and remove position assertions that depend on `commitTop`.

- [ ] **Step 2: Run E2E tests to verify they fail**

With the dev app running through `./scripts/dev.sh`, run:

```bash
pnpm --dir apps/desktop test:e2e -- tests/e2e/mock/stage-advance.test.ts tests/e2e/mock/stage-order.test.ts
```

Expected: FAIL until production code and DB migration changes are complete.

- [ ] **Step 3: Run E2E tests to verify pass after implementation**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- tests/e2e/mock/stage-advance.test.ts tests/e2e/mock/stage-order.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add apps/desktop/tests/e2e/mock/stage-advance.test.ts apps/desktop/tests/e2e/mock/stage-order.test.ts
git commit -m "test: cover task post-action workflow flow"
```

### Task 7: Final Verification And Typecheck

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run focused unit suites**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts src/config/repo-config.test.ts
pnpm --dir packages/db exec vitest run src/queries.test.ts
pnpm --dir apps/desktop exec vitest run src/stores/init.test.ts src/stores/kanna.taskBaseBranch.test.ts src/components/__tests__/Sidebar.test.ts src/stores/selection.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run app E2E coverage**

Start the dev app if it is not running:

```bash
./scripts/dev.sh start
```

Then run:

```bash
pnpm --dir apps/desktop test:e2e -- tests/e2e/mock/stage-advance.test.ts tests/e2e/mock/stage-order.test.ts
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD~6..HEAD
git status --short
```

Expected: only intentional changes are present; `git status --short` is clean after commits.
