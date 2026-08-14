# In-Place Commit Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible `commit` workflow stage that continues the current task/session in place, then hands committed work to a PR-only stage.

**Architecture:** Workflow stages gain an optional `mode` field. The existing promotion path remains the default `new_task` mode, while `continue` mode updates the current `pipeline_item`, clears stale completion data, and sends the next stage prompt to the existing PTY session. Built-in workflows use `commit` as an auto `continue` stage before PR creation.

**Tech Stack:** TypeScript, Vue/Pinia store modules, Vitest, Kanna workflow JSON resources, Markdown agent definitions.

---

### Task 1: Parse Workflow Stage Mode

**Files:**
- Modify: `packages/core/src/workflow/workflow-types.ts`
- Modify: `packages/core/src/workflow/workflow-loader.ts`
- Test: `packages/core/src/workflow/workflow-loader.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add these tests inside `describe("parseWorkflowJson", ...)` in `packages/core/src/workflow/workflow-loader.test.ts`:

```ts
  it("parses continue mode when explicitly set", () => {
    const json = JSON.stringify({
      name: "My Workflow",
      stages: [{ name: "Commit", transition: "auto", mode: "continue" }],
    });

    const result = parseWorkflowJson(json);

    expect(result.stages[0].mode).toBe("continue");
  });

  it("ignores non-string mode values", () => {
    const json = JSON.stringify({
      name: "My Workflow",
      stages: [{ name: "Commit", transition: "auto", mode: true }],
    });

    const result = parseWorkflowJson(json);

    expect(result.stages[0].mode).toBeUndefined();
  });
```

Add this test inside `describe("validateWorkflow", ...)`:

```ts
  it("returns error for invalid mode", () => {
    const workflow = {
      name: "Workflow",
      stages: [{ name: "Commit", transition: "auto" as const, mode: "sideways" as "continue" }],
    };

    const errors = validateWorkflow(workflow);

    expect(errors.some((error) => error.includes("mode"))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts
```

Expected: FAIL because `WorkflowStage` has no `mode` property and/or `validateWorkflow` does not reject invalid mode.

- [ ] **Step 3: Implement minimal parser support**

In `packages/core/src/workflow/workflow-types.ts`, add a mode union to `WorkflowStage`:

```ts
  mode?: "new_task" | "continue";
```

In `packages/core/src/workflow/workflow-loader.ts`, add validation after the transition check:

```ts
    if (
      stage.mode !== undefined &&
      stage.mode !== "new_task" &&
      stage.mode !== "continue"
    ) {
      errors.push(
        `Stage "${stage.name ?? "(unnamed)"}" has invalid mode "${stage.mode as string}"; must be "new_task" or "continue"`
      );
    }
```

In `extractStages`, preserve string modes:

```ts
    if (typeof s["mode"] === "string") {
      stage.mode = s["mode"] as WorkflowStage["mode"];
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/workflow-types.ts packages/core/src/workflow/workflow-loader.ts packages/core/src/workflow/workflow-loader.test.ts
git commit -m "feat: parse workflow stage mode"
```

### Task 2: Continue Stage In Place

**Files:**
- Modify: `apps/desktop/src/stores/workflow.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write failing store tests**

Add tests near the existing `advanceStage` tests in `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`:

```ts
  it("continues the same task and sends the next stage prompt when stage mode is continue", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit", prompt: "Commit $TASK_PROMPT" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.updatePipelineItemStageMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.closePipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "git_worktree_add",
      expect.anything(),
    );
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      input: "Stage prompt\n",
    });
  });

  it("clears stale stage result before sending a continue stage prompt", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    const clearCallOrder = vi.mocked(clearPipelineItemStageResult).mock.invocationCallOrder[0];
    const sendInputCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "send_input");
    const sendInputOrder = mockState.invokeMock.mock.invocationCallOrder[sendInputCallIndex];

    expect(clearCallOrder).toBeLessThan(sendInputOrder);
  });
```

If `clearPipelineItemStageResult` is not directly imported in the test file, extend the existing `@kanna/db` mock import list so the test can inspect the mocked function.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts --testNamePattern "continues the same task|clears stale stage result"
```

Expected: FAIL because `advanceStage` always closes and creates a new task.

- [ ] **Step 3: Implement continue-stage path**

In `apps/desktop/src/stores/workflow.ts`, import `updatePipelineItemStage`:

```ts
import { clearPipelineItemStageResult, getRepo, updatePipelineItemStage } from "@kanna/db";
```

Add this helper inside `createWorkflowApi`, near the selection helpers:

```ts
  async function continueStageInPlace(taskId: string, nextStageName: string, stagePrompt: string): Promise<void> {
    await updatePipelineItemStage(context.requireDb(), taskId, nextStageName);
    await clearPipelineItemStageResult(context.requireDb(), taskId);
    await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
    await invoke("send_input", {
      sessionId: taskId,
      input: `${stagePrompt}\n`,
    });
  }
```

In `advanceStage`, after `stagePrompt` and `agentOpts` are resolved and before selection/close/create behavior, add:

```ts
    if (nextStage.mode === "continue") {
      await continueStageInPlace(item.id, nextStage.name, stagePrompt);
      return;
    }
```

Keep the existing `new_task` path unchanged for stages whose mode is omitted or set to `new_task`.

- [ ] **Step 4: Run targeted tests to verify pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts --testNamePattern "continues the same task|clears stale stage result"
```

Expected: PASS.

- [ ] **Step 5: Run broader store tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "feat: continue workflow stage in place"
```

### Task 3: Add Commit Stage Resources

**Files:**
- Modify: `.kanna/workflows/default.json`
- Modify: `.kanna/workflows/qa.json`
- Create: `.kanna/agents/commit/AGENT.md`
- Modify: `.kanna/agents/pr/AGENT.md`

- [ ] **Step 1: Write resource validation checks**

Run this command before editing to prove the current resources do not yet satisfy the new contract:

```bash
test -f .kanna/agents/commit/AGENT.md && rg -n '"name": "commit"|mode": "continue"' .kanna/workflows/default.json .kanna/workflows/qa.json
```

Expected: FAIL because `.kanna/agents/commit/AGENT.md` does not exist and the workflows do not include the commit stage.

- [ ] **Step 2: Update default workflow**

Change `.kanna/workflows/default.json` to:

```json
{
  "name": "default",
  "description": "Standard in progress -> commit -> PR flow",
  "stages": [
    {
      "name": "in progress",
      "description": "Agent implements the task",
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "transition": "manual"
    },
    {
      "name": "commit",
      "description": "Implementation agent commits the relevant work",
      "agent": "commit",
      "prompt": "Commit the relevant work for this task. Original task: $TASK_PROMPT",
      "transition": "auto",
      "mode": "continue"
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
}
```

- [ ] **Step 3: Update QA workflow**

Change `.kanna/workflows/qa.json` to use `in progress -> commit -> review -> pr`:

```json
{
  "name": "qa",
  "description": "Implementation -> commit -> QA review -> PR flow with automatic revision requests for weak testing",
  "stages": [
    {
      "name": "in progress",
      "description": "Agent implements the task",
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "transition": "manual"
    },
    {
      "name": "commit",
      "description": "Implementation agent commits the relevant work before review",
      "agent": "commit",
      "prompt": "Commit the relevant work for this task before QA review. Original task: $TASK_PROMPT",
      "transition": "auto",
      "mode": "continue"
    },
    {
      "name": "review",
      "description": "QA agent checks whether sufficient tests exist before PR creation",
      "agent": "review",
      "prompt": "Review branch $BRANCH for task quality and test coverage. Original task: $TASK_PROMPT. Previous result: $PREV_RESULT",
      "transition": "auto"
    },
    {
      "name": "pr",
      "description": "Agent creates a GitHub PR after QA passes",
      "agent": "pr",
      "prompt": "Create a PR for the QA-approved work on branch $BRANCH. QA result: $PREV_RESULT",
      "transition": "manual",
      "follow_task": false
    }
  ]
}
```

- [ ] **Step 4: Add commit agent**

Create `.kanna/agents/commit/AGENT.md`:

```md
---
name: commit
description: Commits task work from the existing implementation context
agent_provider: codex, claude, copilot
permission_mode: default
---

You are continuing the same Kanna task session that implemented the work. Your job is to commit the relevant changes for this task before PR creation.

## Process

1. Inspect the worktree with `git status` and review the relevant diff.
2. Identify which changes belong to this task. Do not commit unrelated local changes.
3. Run focused checks when they are useful for confidence.
4. Create one or more clear commits with appropriate messages.
5. After the branch is committed and ready for the next stage, run:

   `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "<what you committed>"`

If you cannot safely decide what to commit, do not guess. Leave the worktree untouched where possible and run:

`kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<why committing is blocked>"`
```

- [ ] **Step 5: Remove PR agent commit ownership**

Edit `.kanna/agents/pr/AGENT.md` so the process starts with rebasing committed work:

```md
## Process

1. **Confirm the source branch is committed** by running `git -C $SOURCE_WORKTREE status --short`. If there are uncommitted changes, stop and report that the commit stage did not finish cleanly.

2. **Rebase onto latest main**: `git fetch origin main && git rebase origin/main`. This ensures the PR only contains the task's changes, not reversions from a stale branch point.

3. **Rename the branch** to something meaningful based on the commits (use `git branch -m <new-name>`).

4. **Push the branch**: `git push -u origin HEAD`.

5. **Create the PR**: `gh pr create` — write a clear title and description summarizing the changes.
```

- [ ] **Step 6: Validate resources**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts
test -f .kanna/agents/commit/AGENT.md
rg -n '"name": "commit"|mode": "continue"' .kanna/workflows/default.json .kanna/workflows/qa.json
! rg -n "commit them:|git -C \\$SOURCE_WORKTREE add|git -C \\$SOURCE_WORKTREE commit" .kanna/agents/pr/AGENT.md
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add .kanna/workflows/default.json .kanna/workflows/qa.json .kanna/agents/commit/AGENT.md .kanna/agents/pr/AGENT.md
git commit -m "feat: add in-place commit stage"
```

### Task 4: Final Verification

**Files:**
- Verify the full touched surface.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Run focused unit tests**

Run:

```bash
pnpm --dir packages/core exec vitest run src/workflow/workflow-loader.test.ts
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS.

- [ ] **Step 3: Check worktree state**

Run:

```bash
git status --short
git log --oneline -n 5
```

Expected: only pre-existing unrelated changes remain unstaged, and the latest commits correspond to this implementation.
