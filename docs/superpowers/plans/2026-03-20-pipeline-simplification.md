# Pipeline Simplification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5-stage pipeline with a 3-stage pipeline (`in_progress`, `pr`, `done`) and add a PR agent that spawns a haiku-model Claude PTY session to create GitHub PRs.

**Architecture:** Core pipeline types simplified in `packages/core/`, DB migration in `App.vue`, new `startPrAgent()` in `usePipeline.ts` that spawns a PTY session with `--model haiku`. Hook handler auto-transitions `pr` → `done`. Dead code (PR workflow, GitHub client, merge flow) deleted.

**Tech Stack:** Vue 3, TypeScript, SQLite, Tauri, Claude CLI (PTY via daemon)

**Spec:** `docs/superpowers/specs/2026-03-20-pipeline-simplification-design.md`

---

### Task 1: Update pipeline types and transitions

**Files:**
- Modify: `packages/core/src/pipeline/types.ts`
- Modify: `packages/core/src/pipeline/transitions.ts`
- Modify: `packages/core/src/pipeline/transitions.test.ts`

- [ ] **Step 1: Rewrite the transition tests for 3 stages**

```typescript
// packages/core/src/pipeline/transitions.test.ts
import { describe, it, expect } from "vitest";
import { canTransition, getTransition } from "./transitions.js";

describe("canTransition", () => {
  it("allows in_progress → pr", () => {
    expect(canTransition("in_progress", "pr")).toBe(true);
  });

  it("allows in_progress → done", () => {
    expect(canTransition("in_progress", "done")).toBe(true);
  });

  it("allows pr → done", () => {
    expect(canTransition("pr", "done")).toBe(true);
  });

  it("rejects pr → in_progress (backward)", () => {
    expect(canTransition("pr", "in_progress")).toBe(false);
  });

  it("rejects done → in_progress (terminal)", () => {
    expect(canTransition("done", "in_progress")).toBe(false);
  });

  it("rejects done → pr (terminal)", () => {
    expect(canTransition("done", "pr")).toBe(false);
  });
});

describe("getTransition", () => {
  it("returns transition for in_progress → pr", () => {
    expect(getTransition("in_progress", "pr")).toBeDefined();
  });

  it("returns undefined for invalid transition", () => {
    expect(getTransition("done", "pr")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test src/pipeline/transitions.test.ts`
Expected: FAIL (old stages don't match)

- [ ] **Step 3: Update types.ts**

```typescript
// packages/core/src/pipeline/types.ts
export type Stage = "in_progress" | "pr" | "done";

export const VALID_TRANSITIONS = [
  { from: "in_progress", to: "pr" },
  { from: "in_progress", to: "done" },
  { from: "pr", to: "done" },
] as const;

export type ValidTransition = (typeof VALID_TRANSITIONS)[number];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test src/pipeline/transitions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/
git commit -m "refactor(pipeline): simplify to 3 stages (in_progress, pr, done)"
```

---

### Task 2: Delete dead code (PR workflow, GitHub client)

**Files:**
- Delete: `apps/desktop/src/composables/usePRWorkflow.ts`
- Delete: `packages/core/src/pr-workflow/workflow.ts`
- Delete: `packages/core/src/pr-workflow/workflow.test.ts`
- Delete: `packages/core/src/github/client.ts`
- Delete: `packages/core/src/github/client.test.ts`
- Delete: `packages/core/src/github/types.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Remove re-exports from index.ts**

In `packages/core/src/index.ts`, remove these lines:
```typescript
// GitHub
export * from "./github/types.js";
export * from "./github/client.js";

// PR Workflow
export * from "./pr-workflow/workflow.js";
```

- [ ] **Step 2: Delete the files**

```bash
rm apps/desktop/src/composables/usePRWorkflow.ts
rm packages/core/src/pr-workflow/workflow.ts
rm packages/core/src/pr-workflow/workflow.test.ts
rm packages/core/src/github/client.ts
rm packages/core/src/github/client.test.ts
rm packages/core/src/github/types.ts
rmdir packages/core/src/pr-workflow
rmdir packages/core/src/github
```

- [ ] **Step 3: Verify core package builds**

Run: `cd packages/core && bun test`
Expected: PASS (no broken imports)

- [ ] **Step 4: Commit**

```bash
git add -A packages/core/src/github/ packages/core/src/pr-workflow/ packages/core/src/index.ts apps/desktop/src/composables/usePRWorkflow.ts
git commit -m "chore: remove PR workflow, GitHub client (replaced by PR agent)"
```

---

### Task 3: Update DB migration and stage references in App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Change default stage in CREATE TABLE DDL and add data migration**

In `runMigrations()`, change the `CREATE TABLE pipeline_item` statement (line ~336-343). Change:
```typescript
stage TEXT NOT NULL DEFAULT 'queued',
```
To:
```typescript
stage TEXT NOT NULL DEFAULT 'in_progress',
```

Then, after the existing `ALTER TABLE` migrations (after `pin_order` block around line 383), add:

```typescript
  // Pipeline simplification: map old stages to new
  try {
    await database.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
    await database.execute(`UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`);
  } catch { /* migration already applied or no rows to update */ }
```

- [ ] **Step 2: Update GC query (line ~440)**

Change:
```typescript
"SELECT * FROM pipeline_item WHERE stage = 'closed' AND updated_at < ?",
```
To:
```typescript
"SELECT * FROM pipeline_item WHERE stage = 'done' AND updated_at < ?",
```

Update the log message from `closed` to `done`:
```typescript
console.log(`[gc] cleaned up ${stale.length} done task(s)`);
```

- [ ] **Step 3: Update currentItem filter (line ~73)**

Change:
```typescript
return item && item.stage !== "closed" ? item : null;
```
To:
```typescript
return item && item.stage !== "done" ? item : null;
```

- [ ] **Step 4: Update sortedItemsForCurrentRepo filter (line ~105)**

Change:
```typescript
.filter((item) => item.repo_id === selectedRepoId.value && item.stage !== "closed")
```
To:
```typescript
.filter((item) => item.repo_id === selectedRepoId.value && item.stage !== "done")
```

- [ ] **Step 5: Update handleCloseTask (line ~168)**

Change:
```typescript
await updatePipelineItemStage(db.value!, item.id, "closed");
```
To:
```typescript
await updatePipelineItemStage(db.value!, item.id, "done");
```

- [ ] **Step 6: Remove usePRWorkflow import and usage**

Remove from imports (line ~24):
```typescript
import { usePRWorkflow } from "./composables/usePRWorkflow";
```

Remove the computed (lines ~54-56):
```typescript
const prWorkflow = computed(() =>
  db.value ? usePRWorkflow(db.value) : null
);
```

Remove `handleMakePR` function (lines ~135-145) and `handleMerge` function (lines ~147-157). These will be replaced in Task 4.

- [ ] **Step 7: Update hook handler for pr → done auto-transition (line ~482)**

Change the Stop/StopFailure handler:
```typescript
if (hookEvent === "Stop" || hookEvent === "StopFailure") {
  // Auto-transition pr → done
  if (item.stage === "pr") {
    await updatePipelineItemStage(db.value!, item.id, "done");
    item.stage = "done";
  }
  const activity = selectedItemId.value === sessionId ? "idle" : "unread";
  updatePipelineItemActivity(db.value!, item.id, activity);
  item.activity = activity;
  refreshAllItems();
}
```

Also update the `session_exit` handler similarly (lines ~498-508):
```typescript
listen("session_exit", (event: any) => {
  const payload = event.payload || event;
  const sessionId = payload.session_id;
  if (!sessionId || !db.value) return;

  const item = allItems.value.find((i) => i.id === sessionId);
  if (!item) return;
  // Auto-transition pr → done on exit too
  if (item.stage === "pr") {
    updatePipelineItemStage(db.value!, item.id, "done");
    item.stage = "done";
  }
  const activity = selectedItemId.value === sessionId ? "idle" : "unread";
  updatePipelineItemActivity(db.value!, item.id, activity);
  item.activity = activity;
  refreshAllItems();
});
```

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "refactor(app): migrate stages, update GC/hooks for 3-stage pipeline"
```

---

### Task 4: Add startPrAgent and wire Cmd+S

**Files:**
- Modify: `apps/desktop/src/composables/usePipeline.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`

- [ ] **Step 1: Modify spawnPtySession to accept model override**

In `usePipeline.ts`, update `spawnPtySession` signature to accept an optional `model` parameter:

```typescript
async function spawnPtySession(
  sessionId: string,
  cwd: string,
  prompt: string,
  cols = 80,
  rows = 24,
  model?: string
) {
```

Update the `claudeCmd` construction (line ~170) to include model flag:

```typescript
const modelFlag = model ? ` --model ${model}` : "";
const claudeCmd = `claude --dangerously-skip-permissions${modelFlag} --settings '${hookSettings}' '${prompt.replace(/'/g, "'\\''")}'`;
```

- [ ] **Step 2: Add startPrAgent function**

Add after `spawnPtySession` in `usePipeline.ts`:

```typescript
const PR_AGENT_PROMPT = "Rename the branch to something reasonable based on the work done, push it, and create a GitHub PR using gh.";

async function startPrAgent(itemId: string) {
  if (!db.value) return;
  const item = items.value.find((i) => i.id === itemId);
  if (!item || item.stage !== "in_progress") return;

  const repo = await getRepo(db.value, item.repo_id);
  if (!repo) return;
  const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;

  // 1. Kill existing coding agent session
  await invoke("kill_session", { sessionId: itemId }).catch(() => {});

  // 2. Run teardown scripts if configured
  try {
    const configContent = await invoke<string>("read_text_file", {
      path: `${repo.path}/.kanna/config.json`,
    });
    if (configContent) {
      const repoConfig = parseRepoConfig(configContent);
      if (repoConfig.teardown?.length) {
        for (const cmd of repoConfig.teardown) {
          await invoke("run_script", { script: cmd, cwd: worktreePath, env: {} });
        }
      }
    }
  } catch { /* no config or teardown failed — continue */ }

  // 3. Transition to pr stage
  await updatePipelineItemStage(db.value, itemId, "pr");
  item.stage = "pr";

  // 4. Spawn PR agent PTY session (reuses same session ID)
  // Small delay to ensure daemon has cleaned up old session
  await new Promise((r) => setTimeout(r, 500));
  await spawnPtySession(itemId, worktreePath, PR_AGENT_PROMPT, 80, 24, "haiku");
}
```

- [ ] **Step 3: Export startPrAgent from usePipeline**

Update the return statement:
```typescript
return {
  items,
  selectedItemId,
  loadItems,
  transition,
  createItem,
  spawnPtySession,
  startPrAgent,
  selectedItem,
  pinItem,
  unpinItem,
  reorderPinned,
};
```

- [ ] **Step 4: Wire startPrAgent in App.vue**

Update the destructuring (line ~29):
```typescript
const { items, selectedItemId, loadItems, transition, createItem, spawnPtySession, startPrAgent, selectedItem, pinItem, unpinItem, reorderPinned } = usePipeline(db);
```

Add a new `handleMakePR` that calls `startPrAgent`:
```typescript
async function handleMakePR() {
  const item = selectedItem();
  if (!item) return;
  try {
    await startPrAgent(item.id);
    await refreshAllItems();
  } catch (e) {
    console.error("PR agent failed to start:", e);
  }
}
```

- [ ] **Step 5: Remove merge shortcut and handler**

Three changes:

1. In `useKeyboardShortcuts.ts`, remove `"merge"` from the `ActionName` type union.

2. In `useKeyboardShortcuts.ts`, remove the merge shortcut from the `shortcuts` array (line ~48):
```typescript
  { action: "merge",      label: "Merge PR",          group: "Pipeline",   key: "m",                            meta: true,               display: "⌘M" },
```

3. In `App.vue`, remove the `handleMerge` function entirely (lines ~147-157) and remove the `merge: handleMerge` entry from the `useKeyboardShortcuts` call (line ~214).

- [ ] **Step 6: Update handleCloseTask to run teardown**

First, add `parseRepoConfig` to the existing `@kanna/core` import in App.vue (line ~8):
```typescript
import type { Stage } from "@kanna/core";
```
becomes:
```typescript
import { parseRepoConfig, type Stage } from "@kanna/core";
```

Then in `App.vue`, update `handleCloseTask`:

```typescript
async function handleCloseTask() {
  const item = selectedItem();
  if (!item || !selectedRepo.value) return;
  try {
    // Kill sessions
    await invoke("kill_session", { sessionId: item.id }).catch(() => {});
    await invoke("kill_session", { sessionId: `shell-${item.id}` }).catch(() => {});

    // Run teardown scripts if transitioning from in_progress
    if (item.stage === "in_progress") {
      const worktreePath = `${selectedRepo.value.path}/.kanna-worktrees/${item.branch}`;
      try {
        const configContent = await invoke<string>("read_text_file", {
          path: `${selectedRepo.value.path}/.kanna/config.json`,
        });
        if (configContent) {
          const repoConfig = parseRepoConfig(configContent);
          if (repoConfig.teardown?.length) {
            for (const cmd of repoConfig.teardown) {
              await invoke("run_script", { script: cmd, cwd: worktreePath, env: {} });
            }
          }
        }
      } catch { /* teardown failed — continue closing */ }
    }

    // Mark as done
    await updatePipelineItemStage(db.value!, item.id, "done");
    const currentItems = sortedItemsForCurrentRepo();
    const remaining = currentItems.filter((i) => i.id !== item.id);
    const firstRead = remaining.find((i) => (i as any).activity === "idle" || !(i as any).activity);
    selectedItemId.value = (firstRead || remaining[0])?.id || null;
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("Close failed:", e);
  }
}
```

- [ ] **Step 7: Remove merge event from MainPanel pass-through**

In `App.vue` template, remove `@merge="handleMerge"` from the MainPanel component.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/composables/usePipeline.ts apps/desktop/src/App.vue apps/desktop/src/composables/useKeyboardShortcuts.ts
git commit -m "feat(pipeline): add PR agent stage with haiku model PTY session"
```

---

### Task 5: Update UI components

**Files:**
- Modify: `apps/desktop/src/components/StageBadge.vue`
- Modify: `apps/desktop/src/components/ActionBar.vue`
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/components/Sidebar.vue`

- [ ] **Step 1: Update StageBadge.vue**

Replace the stageColors and stageLabels:

```typescript
const stageColors: Record<string, string> = {
  in_progress: "#0066cc",
  pr: "#d29922",
  done: "#666",
};

const stageLabels: Record<string, string> = {
  in_progress: "In Progress",
  pr: "PR",
  done: "Done",
};
```

- [ ] **Step 2: Simplify ActionBar.vue**

Replace the script section — remove merge/close logic, keep Make PR only:

```vue
<script setup lang="ts">
import type { PipelineItem } from "@kanna/db";
import { computed } from "vue";

const props = defineProps<{
  item: PipelineItem;
}>();

const emit = defineEmits<{
  (e: "make-pr"): void;
}>();

const showMakePR = computed(() => {
  return props.item.stage === "in_progress";
});
</script>

<template>
  <div class="action-bar">
    <button
      v-if="showMakePR"
      class="btn btn-primary"
      @click="emit('make-pr')"
    >
      Make PR
    </button>
  </div>
</template>
```

Keep all existing styles.

- [ ] **Step 3: Update MainPanel.vue**

Remove the `merge` and `close-task` emits:

```vue
const emit = defineEmits<{
  (e: "make-pr"): void;
  (e: "agent-completed"): void;
}>();
```

Update the ActionBar in the template — remove `@merge` and `@close-task`:
```vue
<ActionBar
  v-if="!maximized"
  :item="item"
  @make-pr="emit('make-pr')"
/>
```

- [ ] **Step 4: Update Sidebar.vue stage filters (lines 32, 39)**

Change both `i.stage !== "closed"` to `i.stage !== "done"`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/StageBadge.vue apps/desktop/src/components/ActionBar.vue apps/desktop/src/components/MainPanel.vue apps/desktop/src/components/Sidebar.vue
git commit -m "refactor(ui): update components for 3-stage pipeline"
```

---

### Task 6: Update remaining references

**Files:**
- Modify: `apps/desktop/src/composables/useResourceSweeper.ts`
- Modify: `packages/db/src/queries.test.ts`
- Modify: `apps/desktop/tests/e2e/mock/action-bar.test.ts`

- [ ] **Step 1: Update useResourceSweeper.ts**

Change the SQL filter (line ~41):
```typescript
WHERE pi.stage IN ('merged', 'closed')
```
To:
```typescript
WHERE pi.stage = 'done'
```

- [ ] **Step 2: Update queries.test.ts**

Change all `stage: "queued"` references to `stage: "in_progress"` in test fixtures (lines ~239, ~258).

Change test description from `"queued"` references to `"in_progress"`.

- [ ] **Step 3: Update action-bar.test.ts**

This e2e test needs significant changes for the new pipeline:
- Remove the "clicking Close changes stage to Closed" test
- Remove the "hides Make PR and Close for closed task" test
- Update to test Make PR button visibility for `in_progress` stage
- The test inserts a task with `stage: "in_progress"` — this stays the same

```typescript
it("shows Make PR button for in_progress task", async () => {
  const el = await client.waitForText(".action-bar", "Make PR");
  expect(el).toBeTruthy();
});

it("does not show Make PR for done task", async () => {
  // Transition to done
  await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = document.getElementById("app").__vue_app__._instance.setupState;
     const db = ctx.db.value || ctx.db;
     const item = ctx.selectedItem();
     db.execute("UPDATE pipeline_item SET stage = 'done' WHERE id = ?", [item.id])
       .then(function() { return ctx.loadItems(ctx.selectedRepoId.value); })
       .then(function() { return ctx.refreshAllItems(); })
       .then(function() { cb("ok"); })
       .catch(function(e) { cb("err:" + e); });`
  );
  await Bun.sleep(300);
  const actionBar = await client.findElement(".action-bar");
  const text = await client.getText(actionBar);
  expect(text).not.toContain("Make PR");
});
```

- [ ] **Step 4: Run all tests**

```bash
bun test
```
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useResourceSweeper.ts packages/db/src/queries.test.ts apps/desktop/tests/e2e/mock/action-bar.test.ts
git commit -m "chore: update remaining stage references for pipeline simplification"
```

---

### Task 7: Verify and clean up

- [ ] **Step 1: Search for any remaining old stage references**

```bash
grep -r '"queued"\|"needs_review"\|"merged"\|"closed"' packages/ apps/desktop/src/ --include="*.ts" --include="*.vue" | grep -v node_modules | grep -v dist
```

Fix any remaining references.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```
Expected: All PASS

- [ ] **Step 3: Final commit if any cleanup was needed**

```bash
git add -A && git commit -m "chore: clean up remaining old stage references"
```
