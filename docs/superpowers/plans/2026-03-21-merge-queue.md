# Merge Queue Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a merge queue task type that spawns a Claude agent to safely rebase, test, and merge PRs without breaking the target branch.

**Architecture:** New `"merge"` stage tag, sidebar section, `startMergeAgent()` function following the existing `startPrAgent()` pattern, `⇧⌘M` keyboard shortcut, and `test` config field in `.kanna/config.json`.

**Tech Stack:** Vue 3, TypeScript, vitest

**Spec:** `docs/superpowers/specs/2026-03-21-merge-queue-design.md`

---

### Task 1: Add `test` field to RepoConfig

**Files:**
- Modify: `packages/core/src/config/repo-config.ts:1-5`
- Modify: `packages/core/src/config/repo-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add test to `packages/core/src/config/repo-config.test.ts`:

```typescript
it("parses test scripts", () => {
  const config = parseRepoConfig(JSON.stringify({
    test: ["bun test", "cargo test"],
  }));
  expect(config.test).toEqual(["bun test", "cargo test"]);
});

it("ignores test if not an array of strings", () => {
  const config = parseRepoConfig(JSON.stringify({ test: "not-an-array" }));
  expect(config.test).toBeUndefined();
});

it("ignores test with mixed types in array", () => {
  const config = parseRepoConfig(JSON.stringify({ test: ["valid", 123] }));
  expect(config.test).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/config/repo-config.test.ts`
Expected: FAIL — `config.test` is undefined because the field isn't parsed yet.

- [ ] **Step 3: Add `test` field to RepoConfig and parse it**

In `packages/core/src/config/repo-config.ts`, add `test?: string[]` to the interface and parsing logic:

```typescript
export interface RepoConfig {
  setup?: string[];
  teardown?: string[];
  test?: string[];
  ports?: Record<string, number>;
}

export function parseRepoConfig(json: string): RepoConfig {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const config: RepoConfig = {};

  if (Array.isArray(raw.setup) && raw.setup.every((s) => typeof s === "string")) {
    config.setup = raw.setup as string[];
  }

  if (Array.isArray(raw.teardown) && raw.teardown.every((s) => typeof s === "string")) {
    config.teardown = raw.teardown as string[];
  }

  if (Array.isArray(raw.test) && raw.test.every((s) => typeof s === "string")) {
    config.test = raw.test as string[];
  }

  if (raw.ports && typeof raw.ports === "object" && !Array.isArray(raw.ports)) {
    const ports: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw.ports as Record<string, unknown>)) {
      if (typeof value === "number") ports[name] = value;
    }
    if (Object.keys(ports).length > 0) config.ports = ports;
  }

  return config;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test src/config/repo-config.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/repo-config.ts packages/core/src/config/repo-config.test.ts
git commit -m "feat: add test field to RepoConfig for merge queue"
```

---

### Task 2: Add `merge` stage and transitions

**Files:**
- Modify: `packages/core/src/workflow/types.ts:1-9`

- [ ] **Step 1: Add `merge` to Stage type and transitions**

In `packages/core/src/workflow/types.ts`:

```typescript
export type Stage = "in_progress" | "pr" | "merge" | "done";

export const VALID_TRANSITIONS = [
  { from: "in_progress", to: "pr" },
  { from: "in_progress", to: "done" },
  { from: "in_progress", to: "merge" },
  { from: "pr", to: "done" },
  { from: "merge", to: "done" },
] as const;

export type ValidTransition = (typeof VALID_TRANSITIONS)[number];
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd packages/core && bun test`
Expected: All tests PASS. No tests break because `canTransition` just checks the array.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workflow/types.ts
git commit -m "feat: add merge stage to workflow types"
```

---

### Task 3: Add merge badge

**Files:**
- Modify: `apps/desktop/src/components/StageBadge.vue:6-16`

- [ ] **Step 1: Add merge color and label**

In `apps/desktop/src/components/StageBadge.vue`, add entries to both maps:

```typescript
const stageColors: Record<string, string> = {
  in_progress: "#0066cc",
  pr: "#d29922",
  merge: "#8b5cf6",
  done: "#666",
};

const stageLabels: Record<string, string> = {
  in_progress: "In Progress",
  pr: "PR",
  merge: "Merge",
  done: "Done",
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/components/StageBadge.vue
git commit -m "feat: add purple merge badge"
```

---

### Task 4: Add "Merge Queue" sidebar section

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue:45-59` (script) and template

- [ ] **Step 1: Add `sortedMerge()` function**

In `apps/desktop/src/components/Sidebar.vue` script section, after `sortedPR()` (line 49):

```typescript
function sortedMerge(repoId: string): PipelineItem[] {
  return sortByActivity(
    props.workflowItems.filter((i) => i.repo_id === repoId && i.stage === "merge" && !i.pinned)
  );
}
```

- [ ] **Step 2: Update `itemsForRepo()` to include merge items**

Replace the existing `itemsForRepo` function:

```typescript
function itemsForRepo(repoId: string): PipelineItem[] {
  return [...sortedPinned(repoId), ...sortedPR(repoId), ...sortedMerge(repoId), ...sortedInProgress(repoId)];
}
```

- [ ] **Step 3: Add "Merge Queue" draggable section to template**

In the template, after the PR `</draggable>` block (after line 262) and before the "In Progress" section (line 265), add:

```vue
          <!-- Merge Queue tasks -->
          <div v-if="sortedMerge(repo.id).length > 0" class="section-label">Merge Queue</div>
          <draggable
            :model-value="sortedMerge(repo.id)"
            :group="{ name: `repo-${repo.id}` }"
            item-key="id"
            :animation="150"
            :sort="false"
            :force-fallback="true"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            fallback-class="sortable-fallback"
            class="type-zone"
            @change="(evt: any) => onUnpinnedChange(repo.id, evt)"
          >
            <template #item="{ element }">
              <div
                class="workflow-item"
                :class="{ selected: selectedItemId === element.id }"
                @click="handleSelectItem(element)"
                @dblclick.stop="startRename(element)"
              >
                <input
                  v-if="editingItemId === element.id"
                  class="rename-input"
                  v-model="editingValue"
                  @keydown.enter="commitRename(element.id)"
                  @keydown.escape="cancelRename()"
                  @blur="commitRename(element.id)"
                  @click.stop
                />
                <span
                  v-else
                  class="item-title"
                  :style="{
                    fontWeight: element.activity === 'unread' ? 'bold' : 'normal',
                    fontStyle: element.activity === 'working' ? 'italic' : 'normal',
                  }"
                >{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/Sidebar.vue
git commit -m "feat: add Merge Queue section to sidebar"
```

---

### Task 5: Add `startMergeAgent()` to useWorkflow

**Files:**
- Modify: `apps/desktop/src/composables/useWorkflow.ts:219-237` (after `startPrAgent`)

- [ ] **Step 1: Add `startMergeAgent` function**

In `apps/desktop/src/composables/useWorkflow.ts`, after `startPrAgent` (after line 237), add:

```typescript
  async function startMergeAgent(repoId: string, repoPath: string) {
    if (!db.value) return;

    const prompt = [
      `You are a merge agent. Your job is to safely merge pull requests without breaking the target branch.`,
      ``,
      `## Process`,
      ``,
      `1. Ask the user which PR(s) to merge and the target branch (default: main).`,
      ``,
      `2. Your worktree is your staging area. Fetch and reset it to the latest origin target branch.`,
      ``,
      `3. Determine what checks to run:`,
      `   a. Check .kanna/config.json for a configured test script (the "test" field, an array of shell commands).`,
      `   b. If none, discover what checks the repo has (CI config, test scripts, Makefile, etc.).`,
      `   c. If you can't determine what to run, ask the user.`,
      ``,
      `4. For each PR, sequentially:`,
      `   a. Rebase the PR branch onto your worktree's HEAD.`,
      `   b. If there are conflicts, attempt to resolve them. Show the user your resolutions and get approval before continuing.`,
      `   c. Run the checks determined in step 3.`,
      `   d. If checks fail, attempt to fix the issue. Show the user your fix and get approval before continuing.`,
      `   e. If checks pass, merge the PR to the target branch on origin.`,
      `   f. Update your worktree HEAD to match the new origin target branch.`,
      `   g. Delete the merged remote branch.`,
      ``,
      `5. Report results — which PRs merged, which failed, and why.`,
      ``,
      `## Principles`,
      ``,
      `- Each PR is merged individually. Don't hold passing PRs hostage to failing ones.`,
      `- Always rebase onto the latest target branch before running checks.`,
      `- Work in your worktree. Never modify the user's local main.`,
      `- When in doubt, ask the user. Don't force-push, skip tests, or resolve ambiguous conflicts silently.`,
      `- Keep the user informed of progress but don't be verbose.`,
    ].join("\n");

    await createItem(repoId, repoPath, prompt, "pty", { stage: "merge" });
  }
```

- [ ] **Step 2: Add `startMergeAgent` to the return object**

In the `return` statement (line 280), add `startMergeAgent`:

```typescript
  return {
    allItems,
    selectedItemId,
    loadAllItems,
    transition,
    createItem,
    spawnPtySession,
    startPrAgent,
    startMergeAgent,
    selectedItem,
    pinItem,
    unpinItem,
    reorderPinned,
    renameItem,
  };
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useWorkflow.ts
git commit -m "feat: add startMergeAgent to useWorkflow"
```

---

### Task 6: Add keyboard shortcut, wire action, and hook handlers in App.vue

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:3-20` (ActionName), `43-68` (shortcuts)
- Modify: `apps/desktop/src/App.vue:29` (destructuring), `193-210` (actions), `519` and `552` (hook handlers)

- [ ] **Step 1: Add `mergeQueue` to ActionName**

In `apps/desktop/src/composables/useKeyboardShortcuts.ts`, add `"mergeQueue"` to the `ActionName` union (after `"makePR"`):

```typescript
export type ActionName =
  | "newTask"
  | "newWindow"
  | "openFile"
  | "makePR"
  | "mergeQueue"
  | "closeTask"
  | "undoClose"
  | "navigateUp"
  | "navigateDown"
  | "toggleZen"
  | "dismiss"
  | "openInIDE"
  | "openShell"
  | "showDiff"
  | "toggleMaximize"
  | "showShortcuts"
  | "openPreferences"
  | "commandPalette";
```

- [ ] **Step 2: Add shortcut definition**

In the `shortcuts` array, after the `makePR` entry (line 48):

```typescript
  { action: "mergeQueue", label: "Merge Queue",      group: "Workflow",   key: ["M", "m"],                     meta: true, shift: true,  display: "⇧⌘M" },
```

- [ ] **Step 3: Add `startMergeAgent` to App.vue destructuring**

In `apps/desktop/src/App.vue` line 29, add `startMergeAgent` to the destructured return:

```typescript
const { allItems, selectedItemId, loadAllItems, transition, createItem, spawnPtySession, startPrAgent, startMergeAgent, selectedItem, pinItem, unpinItem, reorderPinned, renameItem } = useWorkflow(db);
```

- [ ] **Step 4: Wire `mergeQueue` action handler**

In the actions object (after the `makePR` handler, around line 210), add:

```typescript
  mergeQueue: async () => {
    if (!selectedRepoId.value) {
      if (repos.value.length === 1) {
        selectedRepoId.value = repos.value[0].id;
      } else {
        alert("Select a repository first");
        return;
      }
    }
    const repo = repos.value.find((r) => r.id === selectedRepoId.value);
    if (!repo) return;
    try {
      await startMergeAgent(repo.id, repo.path);
    } catch (e) {
      console.error("Merge agent failed to start:", e);
    }
  },
```

- [ ] **Step 5: Update hook_event and session_exit handlers for merge→done auto-transition**

In `apps/desktop/src/App.vue`, find both `hook_event` listener (around line 519) and `session_exit` listener (around line 552). In each, change:

```typescript
const becameDone = item.stage === "pr";
```

to:

```typescript
const becameDone = item.stage === "pr" || item.stage === "merge";
```

This ensures merge tasks auto-transition to `done` when the agent finishes, same as PR tasks.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts apps/desktop/src/App.vue
git commit -m "feat: add ⇧⌘M shortcut and command palette entry for merge queue"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Start dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Verify merge badge renders**

Create a task, manually set its stage to `merge` in the DB (or use the merge queue shortcut). Confirm the purple "Merge" badge appears.

- [ ] **Step 3: Verify ⇧⌘M shortcut**

Press `⇧⌘M` with a repo selected. Confirm a new merge task spawns with the merge prompt and appears in the "Merge Queue" sidebar section.

- [ ] **Step 4: Verify command palette**

Press `⇧⌘P`, type "merge". Confirm "Merge Queue" appears with `⇧⌘M` shortcut displayed.

- [ ] **Step 5: Verify agent interaction**

In the spawned merge task terminal, confirm the Claude agent asks which PR(s) to merge.
