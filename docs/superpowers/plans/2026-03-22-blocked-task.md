# Blocked Task Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `blocked` pipeline stage so tasks can declare dependencies on other tasks and auto-start when all blockers leave `in_progress`.

**Architecture:** New `blocked` stage + `task_blocker` junction table. Two command palette commands ("Block Task", "Edit Blocked Task") manage dependencies. Auto-unblock logic triggers on stage transitions via `checkUnblocked()`. Blocked tasks have no worktree/agent until they unblock.

**Tech Stack:** Vue 3, Pinia, TypeScript, SQLite (tauri-plugin-sql), vitest

**Dependency:** This plan targets branch `task-8a29c9c0` (Pinia store refactor). All file references are relative to that branch's state.

**Spec:** `docs/superpowers/specs/2026-03-22-blocked-task-design.md`

---

### Task 1: Add `blocked` stage to pipeline types and transitions

**Files:**
- Modify: `packages/core/src/pipeline/types.ts`
- Modify: `packages/core/src/pipeline/transitions.test.ts`

- [ ] **Step 1: Write failing tests for new transitions**

Add to `packages/core/src/pipeline/transitions.test.ts`:

```typescript
it("allows blocked → in_progress", () => {
  expect(canTransition("blocked", "in_progress")).toBe(true);
});

it("allows blocked → done", () => {
  expect(canTransition("blocked", "done")).toBe(true);
});

it("rejects in_progress → blocked (not a transition)", () => {
  expect(canTransition("in_progress", "blocked")).toBe(false);
});

it("rejects blocked → pr (must go through in_progress first)", () => {
  expect(canTransition("blocked", "pr")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test`
Expected: 4 FAIL — `blocked` not in Stage type

- [ ] **Step 3: Update types.ts**

In `packages/core/src/pipeline/types.ts`:

```typescript
export type Stage = "in_progress" | "pr" | "merge" | "done" | "blocked";

export const VALID_TRANSITIONS = [
  { from: "in_progress", to: "pr" },
  { from: "in_progress", to: "done" },
  { from: "in_progress", to: "merge" },
  { from: "pr", to: "done" },
  { from: "merge", to: "done" },
  { from: "blocked", to: "in_progress" },
  { from: "blocked", to: "done" },
] as const;

export type ValidTransition = (typeof VALID_TRANSITIONS)[number];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/types.ts packages/core/src/pipeline/transitions.test.ts
git commit -m "feat: add blocked stage to pipeline types and transitions"
```

---

### Task 2: Add `TaskBlocker` type and DB query helpers

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`

- [ ] **Step 1: Add TaskBlocker interface to schema.ts**

Add to `packages/db/src/schema.ts` after the `PipelineItem` interface:

```typescript
export interface TaskBlocker {
  blocked_item_id: string;
  blocker_item_id: string;
}
```

- [ ] **Step 2: Add blocker query helpers to queries.ts**

Add to `packages/db/src/queries.ts` after the PipelineItem section. Import `TaskBlocker` from schema:

```typescript
// ---------------------------------------------------------------------------
// TaskBlocker
// ---------------------------------------------------------------------------

export async function insertTaskBlocker(
  db: DbHandle,
  blockedItemId: string,
  blockerItemId: string,
): Promise<void> {
  await db.execute(
    "INSERT OR IGNORE INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
    [blockedItemId, blockerItemId],
  );
}

export async function removeTaskBlocker(
  db: DbHandle,
  blockedItemId: string,
  blockerItemId: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM task_blocker WHERE blocked_item_id = ? AND blocker_item_id = ?",
    [blockedItemId, blockerItemId],
  );
}

export async function removeAllBlockersForItem(
  db: DbHandle,
  blockedItemId: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM task_blocker WHERE blocked_item_id = ?",
    [blockedItemId],
  );
}

export async function listBlockersForItem(
  db: DbHandle,
  blockedItemId: string,
): Promise<PipelineItem[]> {
  return db.select<PipelineItem>(
    `SELECT pi.* FROM pipeline_item pi
     JOIN task_blocker tb ON pi.id = tb.blocker_item_id
     WHERE tb.blocked_item_id = ?`,
    [blockedItemId],
  );
}

export async function listBlockedByItem(
  db: DbHandle,
  blockerItemId: string,
): Promise<PipelineItem[]> {
  return db.select<PipelineItem>(
    `SELECT pi.* FROM pipeline_item pi
     JOIN task_blocker tb ON pi.id = tb.blocked_item_id
     WHERE tb.blocker_item_id = ?`,
    [blockerItemId],
  );
}

export async function getUnblockedItems(
  db: DbHandle,
): Promise<PipelineItem[]> {
  return db.select<PipelineItem>(
    `SELECT pi.* FROM pipeline_item pi
     WHERE pi.stage = 'blocked'
     AND NOT EXISTS (
       SELECT 1 FROM task_blocker tb
       JOIN pipeline_item blocker ON blocker.id = tb.blocker_item_id
       WHERE tb.blocked_item_id = pi.id
       AND blocker.stage = 'in_progress'
     )`,
  );
}

export async function hasCircularDependency(
  db: DbHandle,
  blockedItemId: string,
  proposedBlockerIds: string[],
): Promise<boolean> {
  // DFS: starting from each proposed blocker's own blockers,
  // check if we can reach blockedItemId
  const visited = new Set<string>();

  async function dfs(currentId: string): Promise<boolean> {
    if (currentId === blockedItemId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const blockers = await db.select<TaskBlocker>(
      "SELECT * FROM task_blocker WHERE blocked_item_id = ?",
      [currentId],
    );
    for (const b of blockers) {
      if (await dfs(b.blocker_item_id)) return true;
    }
    return false;
  }

  for (const blockerId of proposedBlockerIds) {
    visited.clear();
    if (await dfs(blockerId)) return true;
  }
  return false;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts
git commit -m "feat: add TaskBlocker type and DB query helpers"
```

---

### Task 3: Add `task_blocker` table migration

**Files:**
- Modify: `apps/desktop/src/stores/db.ts`

- [ ] **Step 1: Add migration to runMigrations()**

Add at the end of `runMigrations()` in `apps/desktop/src/stores/db.ts`, before the closing `}`:

```typescript
  // Task blocker junction table for blocked task dependencies
  await db.execute(`CREATE TABLE IF NOT EXISTS task_blocker (
    blocked_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    blocker_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    PRIMARY KEY (blocked_item_id, blocker_item_id)
  )`);
```

Note: uses `ON DELETE CASCADE` so that when a pipeline_item is deleted (e.g., GC), its blocker relationships are cleaned up automatically.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/stores/db.ts
git commit -m "feat: add task_blocker table migration"
```

---

### Task 4: Add `blockTask()` and `checkUnblocked()` to Pinia store

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`

- [ ] **Step 1: Add imports for new DB helpers**

In `apps/desktop/src/stores/kanna.ts`, add to the imports from `@kanna/db`:

```typescript
import {
  // ... existing imports ...
  insertTaskBlocker, removeTaskBlocker, removeAllBlockersForItem,
  listBlockersForItem, listBlockedByItem, getUnblockedItems,
  hasCircularDependency,
} from "@kanna/db";
```

- [ ] **Step 2: Add `checkUnblocked()` function**

Add after the `_handleAgentFinished` function:

```typescript
  async function checkUnblocked(blockerItemId: string) {
    const blockedItems = await listBlockedByItem(_db, blockerItemId);
    for (const blocked of blockedItems) {
      if (blocked.stage !== "blocked") continue;
      const blockers = await listBlockersForItem(_db, blocked.id);
      const allClear = blockers.every(
        (b) => b.stage === "pr" || b.stage === "merge" || b.stage === "done"
      );
      if (allClear) {
        await startBlockedTask(blocked);
      }
    }
  }
```

- [ ] **Step 3: Add `startBlockedTask()` function**

Add after `checkUnblocked`:

```typescript
  async function startBlockedTask(item: PipelineItem) {
    const repo = repos.value.find((r) => r.id === item.repo_id);
    if (!repo) {
      console.error("[store] startBlockedTask: repo not found for", item.id);
      return;
    }

    // Build prompt context from blockers
    const blockers = await listBlockersForItem(_db, item.id);
    const blockerContext = blockers
      .map((b) => {
        const name = b.display_name || (b.prompt ? b.prompt.slice(0, 60) : "Untitled");
        return `- ${name} (branch: ${b.branch || "unknown"})`;
      })
      .join("\n");

    const augmentedPrompt = [
      "Note: this task was previously blocked by the following tasks which have now completed:",
      blockerContext,
      "Their changes may be on branches that haven't merged to main yet.",
      "",
      "Original task:",
      item.prompt || "",
    ].join("\n");

    // Create worktree from repo root
    const id = item.id;
    const branch = `task-${id}`;
    const worktreePath = `${repo.path}/.kanna-worktrees/${branch}`;

    try {
      await invoke("git_worktree_add", {
        repoPath: repo.path,
        branch,
        path: worktreePath,
        startPoint: null,
      });
    } catch (e) {
      console.error("[store] startBlockedTask worktree_add failed:", e);
      return;
    }

    // Assign port offset
    let repoConfig: RepoConfig = {};
    try {
      const configContent = await invoke<string>("read_text_file", {
        path: `${repo.path}/.kanna/config.json`,
      });
      if (configContent) repoConfig = parseRepoConfig(configContent);
    } catch (e) {
      console.debug("[store] no .kanna/config.json:", e);
    }

    const usedOffsets = new Set(
      items.value.map((i) => i.port_offset).filter((o): o is number => o != null)
    );
    let portOffset = 1;
    while (usedOffsets.has(portOffset)) portOffset++;

    const portEnv: Record<string, string> = {};
    if (repoConfig.ports) {
      for (const [name, base] of Object.entries(repoConfig.ports)) {
        portEnv[name] = String(base + portOffset);
      }
    }

    // Update DB record
    await _db.execute(
      `UPDATE pipeline_item
       SET branch = ?, port_offset = ?, port_env = ?,
           stage = 'in_progress', activity = 'working',
           activity_changed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [branch, portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, id],
    );

    bump();

    // Spawn agent
    try {
      await spawnPtySession(id, worktreePath, augmentedPrompt);
    } catch (e) {
      console.warn("[store] startBlockedTask PTY pre-spawn failed:", e);
    }
  }
```

- [ ] **Step 4: Add `blockTask()` function**

Add after `startBlockedTask`:

```typescript
  async function blockTask(blockerIds: string[]) {
    const item = currentItem.value;
    const repo = selectedRepo.value;
    if (!item || !repo || item.stage !== "in_progress") return;

    // Validate no circular dependencies
    // (For block task, the new item doesn't exist yet so no cycles possible
    // from the new item. But validate that none of the proposed blockers
    // would create a cycle if they themselves are blocked.)
    // This is a safety check — in practice Block Task creates a brand new item.

    // Save original task details before closing
    const originalPrompt = item.prompt;
    const originalRepoId = item.repo_id;
    const originalAgentType = item.agent_type;
    const originalDisplayName = item.display_name;
    const originalId = item.id;

    // Step 1: Create the new blocked item (before closing, to avoid race)
    const newId = crypto.randomUUID();
    await insertPipelineItem(_db, {
      id: newId,
      repo_id: originalRepoId,
      issue_number: null,
      issue_title: null,
      prompt: originalPrompt,
      stage: "blocked",
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: originalAgentType,
      port_offset: null,
      port_env: null,
      activity: "idle",
    });

    // Copy display name if set
    if (originalDisplayName) {
      await updatePipelineItemDisplayName(_db, newId, originalDisplayName);
    }

    // Step 2: Insert blocker relationships
    for (const blockerId of blockerIds) {
      await insertTaskBlocker(_db, newId, blockerId);
    }

    // Step 3: Close the original task (suppress checkUnblocked)
    try {
      await invoke("kill_session", { sessionId: originalId }).catch((e: unknown) =>
        console.error("[store] kill_session failed:", e)
      );
      await invoke("kill_session", { sessionId: `shell-${originalId}` }).catch((e: unknown) =>
        console.error("[store] kill shell session failed:", e)
      );

      const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
      try {
        const configContent = await invoke<string>("read_text_file", {
          path: `${repo.path}/.kanna/config.json`,
        });
        if (configContent) {
          const repoConfig = parseRepoConfig(configContent);
          if (repoConfig.teardown?.length) {
            for (const cmd of repoConfig.teardown) {
              await invoke("run_script", { script: cmd, cwd: worktreePath, env: { KANNA_WORKTREE: "1" } });
            }
          }
        }
      } catch (e) {
        console.error("[store] teardown failed:", e);
      }

      // Set to done WITHOUT triggering checkUnblocked
      await updatePipelineItemStage(_db, originalId, "done");
    } catch (e) {
      console.error("[store] blockTask close failed:", e);
    }

    bump();

    // Select the new blocked item
    selectedItemId.value = newId;
  }
```

- [ ] **Step 5: Add `editBlockedTask()` function**

Add after `blockTask`:

```typescript
  async function editBlockedTask(itemId: string, newBlockerIds: string[]) {
    const item = items.value.find((i) => i.id === itemId);
    if (!item || item.stage !== "blocked") return;

    // Validate no circular dependencies
    if (newBlockerIds.length > 0) {
      const hasCycle = await hasCircularDependency(_db, itemId, newBlockerIds);
      if (hasCycle) {
        throw new Error("Cannot add blocker — it would create a circular dependency");
      }
    }

    // Get current blockers
    const currentBlockers = await listBlockersForItem(_db, itemId);
    const currentIds = new Set(currentBlockers.map((b) => b.id));
    const newIds = new Set(newBlockerIds);

    // Remove old
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        await removeTaskBlocker(_db, itemId, id);
      }
    }

    // Add new
    for (const id of newIds) {
      if (!currentIds.has(id)) {
        await insertTaskBlocker(_db, itemId, id);
      }
    }

    bump();

    // Check if now unblocked (including zero blockers = immediate start)
    const updatedBlockers = await listBlockersForItem(_db, itemId);
    const allClear = updatedBlockers.length === 0 || updatedBlockers.every(
      (b) => b.stage === "pr" || b.stage === "merge" || b.stage === "done"
    );
    if (allClear) {
      await startBlockedTask(item);
    }
  }
```

- [ ] **Step 6: Hook `checkUnblocked` into stage transitions**

In `makePR()`, after `await updatePipelineItemStage(_db, originalId, "done");` add:

```typescript
      await checkUnblocked(originalId);
```

In `closeTask()`, after `await updatePipelineItemStage(_db, item.id, "done");` add:

```typescript
      // Only check unblocked if this isn't a blockTask suppression
      if (item.stage === "in_progress") {
        await checkUnblocked(item.id);
      }
```

Note: `closeTask()` is also used for blocked tasks (blocked → done). We only trigger `checkUnblocked` when the task was `in_progress`, since a blocked task being abandoned doesn't unblock anything.

Also update `closeTask()` to handle blocked tasks (no worktree to teardown):

After the existing `if (item.stage === "in_progress")` block that does teardown, add an else-if for blocked cleanup:

```typescript
      if (item.stage === "blocked") {
        await removeAllBlockersForItem(_db, item.id);
      }
```

- [ ] **Step 7: Add startup unblock check in `init()`**

In `init()`, after the GC block and before `bump()`, add:

```typescript
    // Check for blocked tasks that can now start
    const unblockedItems = await getUnblockedItems(_db);
    for (const item of unblockedItems) {
      console.log(`[store] auto-starting previously blocked task: ${item.id}`);
      await startBlockedTask(item);
    }
```

- [ ] **Step 8: Export new functions**

Add to the return statement of `useKannaStore`:

```typescript
    blockTask, editBlockedTask,
    listBlockersForItem: (itemId: string) => listBlockersForItem(_db, itemId),
```

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: add blockTask, editBlockedTask, checkUnblocked, startBlockedTask to store"
```

---

### Task 5: Add `blocked` stage to StageBadge

**Files:**
- Modify: `apps/desktop/src/components/StageBadge.vue`

- [ ] **Step 1: Add blocked to color and label maps**

In `StageBadge.vue`, add to `stageColors`:

```typescript
  blocked: "#666",
```

Add to `stageLabels`:

```typescript
  blocked: "Blocked",
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/components/StageBadge.vue
git commit -m "feat: add blocked stage to StageBadge"
```

---

### Task 6: Add "Blocked" section to Sidebar

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`

- [ ] **Step 1: Add `sortedBlocked()` function**

In `Sidebar.vue` `<script setup>`, after `sortedInProgress()`:

```typescript
function sortedBlocked(repoId: string): PipelineItem[] {
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && i.stage === "blocked" && !i.pinned)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
```

- [ ] **Step 2: Update `itemsForRepo()` to include blocked**

```typescript
function itemsForRepo(repoId: string): PipelineItem[] {
  return [...sortedPinned(repoId), ...sortedPR(repoId), ...sortedMerge(repoId), ...sortedInProgress(repoId), ...sortedBlocked(repoId)];
}
```

- [ ] **Step 3: Add Blocked section template**

In the `<template>`, after the "In Progress" `<draggable>` block and before the `<div v-if="itemsForRepo...">` empty state, add:

```html
          <!-- Blocked tasks -->
          <div v-if="sortedBlocked(repo.id).length > 0" class="section-label">Blocked</div>
          <div class="type-zone">
            <div
              v-for="element in sortedBlocked(repo.id)"
              :key="element.id"
              class="pipeline-item"
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
                style="color: #666;"
              >{{ itemTitle(element) }}</span>
            </div>
          </div>
```

Note: Blocked items are not draggable (no reason to pin a blocked task). They display in grey to match their "inert" state.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/Sidebar.vue
git commit -m "feat: add Blocked section to sidebar"
```

---

### Task 7: Add blocked task placeholder to MainPanel

**Files:**
- Modify: `apps/desktop/src/components/MainPanel.vue`

- [ ] **Step 1: Add blockers prop and blocked view**

Add a new prop for blockers:

```typescript
defineProps<{
  item: PipelineItem | null;
  repoPath?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
  maximized?: boolean;
  blockers?: PipelineItem[];
}>();
```

In the `<template>`, replace the `<template v-if="item">` block:

```html
    <template v-if="item">
      <TaskHeader v-if="!maximized" :item="item" />
      <template v-if="item.stage === 'blocked'">
        <div class="blocked-placeholder">
          <p class="blocked-title">Task Blocked</p>
          <p class="blocked-prompt">{{ item.prompt }}</p>
          <div v-if="blockers && blockers.length > 0" class="blocked-by">
            <p class="blocked-by-label">Blocked by:</p>
            <div v-for="b in blockers" :key="b.id" class="blocker-item">
              <span
                class="blocker-status"
                :style="{ color: b.stage === 'in_progress' ? '#0066cc' : '#666' }"
              >{{ b.stage === 'in_progress' ? 'In Progress' : b.stage }}</span>
              <span class="blocker-name">{{ b.display_name || (b.prompt ? b.prompt.slice(0, 60) : 'Untitled') }}</span>
            </div>
          </div>
          <p class="blocked-hint">This task will start automatically when all blockers leave "In Progress".</p>
        </div>
      </template>
      <template v-else>
        <TerminalTabs
          :session-id="item.id"
          :agent-type="item.agent_type || 'pty'"
          :repo-path="repoPath"
          :worktree-path="item.branch ? `${repoPath}/.kanna-worktrees/${item.branch}` : undefined"
          :prompt="item.prompt || ''"
          :spawn-pty-session="spawnPtySession"
          @agent-completed="emit('agent-completed')"
        />
      </template>
    </template>
```

- [ ] **Step 2: Add blocked placeholder styles**

```css
.blocked-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  max-width: 600px;
  margin: 0 auto;
}

.blocked-title {
  font-size: 18px;
  font-weight: 600;
  color: #888;
}

.blocked-prompt {
  font-size: 13px;
  color: #aaa;
  text-align: center;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.blocked-by {
  width: 100%;
  margin-top: 8px;
}

.blocked-by-label {
  font-size: 12px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.blocker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #252525;
  border-radius: 4px;
  margin-bottom: 4px;
}

.blocker-status {
  font-size: 11px;
  font-weight: 600;
  min-width: 80px;
}

.blocker-name {
  font-size: 12px;
  color: #bbb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blocked-hint {
  font-size: 11px;
  color: #555;
  margin-top: 8px;
}
```

- [ ] **Step 3: Wire blockers prop in App.vue**

In `App.vue`, where `<MainPanel>` is used, add a computed for current item blockers and pass it:

```typescript
// In <script setup>, add:
import { listBlockersForItem } from "@kanna/db";
import { computedAsync } from "@vueuse/core";

const currentBlockers = computedAsync(async () => {
  const item = store.currentItem;
  if (!item || item.stage !== "blocked") return [];
  return store.listBlockersForItem(item.id);
}, []);
```

In the template, pass it to MainPanel:

```html
<MainPanel
  :item="store.currentItem"
  :repo-path="store.selectedRepo?.path"
  :spawn-pty-session="store.spawnPtySession"
  :maximized="maximized"
  :blockers="currentBlockers"
  @agent-completed="() => {}"
/>
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/MainPanel.vue apps/desktop/src/App.vue
git commit -m "feat: add blocked task placeholder view in MainPanel"
```

---

### Task 8: Add "Block Task" and "Edit Blocked Task" to command palette

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Modify: `apps/desktop/src/components/CommandPaletteModal.vue`
- Modify: `apps/desktop/src/App.vue`

The current command palette derives its commands from keyboard shortcuts. "Block Task" and "Edit Blocked Task" don't have keyboard shortcuts — they're command-palette-only. We need to extend the palette to support commands without shortcuts.

- [ ] **Step 1: Add new action names to ActionName type**

In `useKeyboardShortcuts.ts`, add to the `ActionName` union:

```typescript
  | "blockTask"
  | "editBlockedTask"
```

Add corresponding no-ops to `keyboardActions` in App.vue (they won't have shortcuts):

```typescript
  blockTask: () => { handleBlockTask(); },
  editBlockedTask: () => { handleEditBlockedTask(); },
```

- [ ] **Step 2: Update CommandPaletteModal to accept extra commands**

Add a prop for additional commands that don't come from shortcuts:

```typescript
const props = defineProps<{
  extraCommands?: Command[];
}>();
```

Update the `commands` computed to merge them:

```typescript
const commands = computed<Command[]>(() => {
  const shortcutCommands = shortcuts
    .filter((s) => s.action !== "dismiss" && s.action !== "commandPalette")
    .map((s) => ({ action: s.action, label: s.label, group: s.group, shortcut: s.display }));
  return [...shortcutCommands, ...(props.extraCommands || [])];
});
```

- [ ] **Step 3: Pass contextual commands from App.vue**

In App.vue, add a computed that returns the relevant extra commands based on current task state:

```typescript
const paletteExtraCommands = computed(() => {
  const cmds: Array<{ action: ActionName; label: string; group: string; shortcut: string }> = [];
  const item = store.currentItem;
  if (item?.stage === "in_progress") {
    cmds.push({ action: "blockTask", label: "Block Task", group: "Pipeline", shortcut: "" });
  }
  if (item?.stage === "blocked") {
    cmds.push({ action: "editBlockedTask", label: "Edit Blocked Task", group: "Pipeline", shortcut: "" });
  }
  return cmds;
});
```

Pass to the modal:

```html
<CommandPaletteModal
  v-if="showCommandPalette"
  :extra-commands="paletteExtraCommands"
  @close="showCommandPalette = false"
  @execute="(action: ActionName) => keyboardActions[action]()"
/>
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts apps/desktop/src/components/CommandPaletteModal.vue apps/desktop/src/App.vue
git commit -m "feat: add Block Task and Edit Blocked Task to command palette"
```

---

### Task 9: Add blocker selection modal (fuzzy search multi-select)

**Files:**
- Create: `apps/desktop/src/components/BlockerSelectModal.vue`
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Create BlockerSelectModal.vue**

This modal shows a fuzzy-searchable list of `in_progress` and `blocked` tasks with multi-select checkboxes. It reuses the same visual style as `CommandPaletteModal`.

```vue
<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import type { PipelineItem } from "@kanna/db";

const props = defineProps<{
  candidates: PipelineItem[];
  preselected?: string[];
  title: string;
}>();

const emit = defineEmits<{
  (e: "confirm", selectedIds: string[]): void;
  (e: "cancel"): void;
}>();

const query = ref("");
const selected = ref<Set<string>>(new Set(props.preselected || []));
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const mouseMoved = ref(false);

const filtered = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return props.candidates;
  return props.candidates.filter((c) => {
    const name = c.display_name || c.prompt || "";
    return name.toLowerCase().includes(q);
  });
});

function toggleItem(id: string) {
  if (selected.value.has(id)) {
    selected.value.delete(id);
  } else {
    selected.value.add(id);
  }
}

function itemTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || "Untitled";
  return raw.length > 60 ? raw.slice(0, 60) + "..." : raw;
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault();
    e.stopPropagation();
    selectedIndex.value = Math.min(selectedIndex.value + 1, filtered.value.length - 1);
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault();
    e.stopPropagation();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === " ") {
    e.preventDefault();
    const item = filtered.value[selectedIndex.value];
    if (item) toggleItem(item.id);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selected.value.size > 0) {
      emit("confirm", [...selected.value]);
    }
  }
}

import { watch } from "vue";
watch(query, () => { selectedIndex.value = 0; });

onMounted(async () => {
  await nextTick();
  inputRef.value?.focus();
});
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')" @keydown="handleKeydown" @mousemove.once="mouseMoved = true">
    <div class="palette-modal">
      <div class="palette-header">{{ title }}</div>
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="palette-input"
        placeholder="Search tasks..."
      />
      <div class="command-list">
        <div
          v-for="(item, i) in filtered"
          :key="item.id"
          class="command-item"
          :class="{ selected: i === selectedIndex }"
          @click="toggleItem(item.id)"
          @mouseenter="mouseMoved && (selectedIndex = i)"
        >
          <span class="check">{{ selected.has(item.id) ? '✓' : ' ' }}</span>
          <span class="command-label">{{ itemTitle(item) }}</span>
          <span class="command-meta">
            <span class="stage-label">{{ item.stage === 'in_progress' ? 'In Progress' : 'Blocked' }}</span>
          </span>
        </div>
        <div v-if="filtered.length === 0" class="empty">No matching tasks</div>
      </div>
      <div class="palette-footer">
        <span class="hint">Space to toggle, Enter to confirm ({{ selected.size }} selected)</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 1000;
}
.palette-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 550px;
  max-width: 90vw;
  overflow: hidden;
}
.palette-header {
  padding: 10px 14px 0;
  font-size: 13px;
  font-weight: 600;
  color: #aaa;
}
.palette-input {
  width: 100%;
  padding: 10px 14px;
  background: #1a1a1a;
  border: none;
  border-bottom: 1px solid #333;
  color: #e0e0e0;
  font-size: 14px;
  outline: none;
}
.command-list {
  max-height: 400px;
  overflow-y: auto;
}
.command-item {
  padding: 8px 14px;
  font-size: 13px;
  color: #ccc;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
.command-item.selected {
  background: #0066cc;
  color: #fff;
}
.command-item:hover {
  background: #333;
}
.command-item.selected:hover {
  background: #0066cc;
}
.check {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  width: 16px;
  text-align: center;
}
.command-label {
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stage-label {
  font-size: 11px;
  color: #888;
}
.command-item.selected .stage-label {
  color: #ccc;
}
.palette-footer {
  padding: 8px 14px;
  border-top: 1px solid #333;
}
.hint {
  font-size: 11px;
  color: #666;
}
.empty {
  padding: 16px;
  color: #666;
  text-align: center;
  font-size: 13px;
}
</style>
```

- [ ] **Step 2: Wire BlockerSelectModal into App.vue**

Import and add state:

```typescript
import BlockerSelectModal from "./components/BlockerSelectModal.vue";

const showBlockerSelect = ref(false);
const blockerSelectMode = ref<"block" | "edit">("block");
```

Add the handler functions:

```typescript
function handleBlockTask() {
  blockerSelectMode.value = "block";
  showBlockerSelect.value = true;
}

function handleEditBlockedTask() {
  blockerSelectMode.value = "edit";
  showBlockerSelect.value = true;
}

const blockerCandidates = computed(() => {
  const item = store.currentItem;
  return store.items.filter((i) =>
    i.id !== item?.id &&
    (i.stage === "in_progress" || i.stage === "blocked") &&
    i.repo_id === store.selectedRepoId
  );
});

const preselectedBlockerIds = computedAsync(async () => {
  const item = store.currentItem;
  if (!item || item.stage !== "blocked") return [];
  const blockers = await store.listBlockersForItem(item.id);
  return blockers.map((b) => b.id);
}, []);

async function onBlockerConfirm(selectedIds: string[]) {
  showBlockerSelect.value = false;
  if (blockerSelectMode.value === "block") {
    await store.blockTask(selectedIds);
  } else {
    const item = store.currentItem;
    if (item) {
      try {
        await store.editBlockedTask(item.id, selectedIds);
      } catch (e: any) {
        alert(e.message); // Shows circular dependency error
      }
    }
  }
}
```

Add to the template:

```html
<BlockerSelectModal
  v-if="showBlockerSelect"
  :candidates="blockerCandidates"
  :preselected="blockerSelectMode === 'edit' ? preselectedBlockerIds : undefined"
  :title="blockerSelectMode === 'block' ? 'Select blocking tasks' : 'Edit blocking tasks'"
  @confirm="onBlockerConfirm"
  @cancel="showBlockerSelect = false"
/>
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/BlockerSelectModal.vue apps/desktop/src/App.vue
git commit -m "feat: add BlockerSelectModal and wire Block Task / Edit Blocked Task commands"
```

---

### Task 10: Handle `closeTask` for blocked items + update `currentItem` filter

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`

- [ ] **Step 1: Update `currentItem` computed to show blocked tasks**

The current `currentItem` filters out `done` tasks. Blocked tasks should be visible. Check that the filter already works — `item.stage !== "done"` already allows `blocked` through. Verify this is the case; no change needed if so.

- [ ] **Step 2: Update `closeTask` to handle blocked tasks**

This was already addressed in Task 4, Step 6. Verify the blocked task path works:
- No agent/shell sessions to kill (they don't exist)
- No worktree teardown needed
- Remove blocker relationships
- Set to `done`

- [ ] **Step 3: Run the full app and verify**

Run: `./scripts/dev.sh`

Manual test:
1. Create two tasks (A and B)
2. On task B, open command palette → "Block Task" → select A
3. Verify B appears in "Blocked" sidebar section with grey text
4. Verify B's main panel shows the blocked placeholder
5. Close task A (Cmd+Delete)
6. Verify B auto-starts (moves to In Progress, worktree created, agent spawned)

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from manual testing of blocked task flow"
```

---

### Task 11: Final integration and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

```bash
bun test
cd packages/core && bun test
```

- [ ] **Step 2: Verify TypeScript builds**

```bash
cd apps/desktop && bun run build:check
```

(Or whatever the type-check command is for this project.)

- [ ] **Step 3: Test edge cases manually**

1. **Edit blocked task — remove all blockers:** Should auto-start immediately
2. **Edit blocked task — circular dependency:** Should show error
3. **Abandon blocked task (Cmd+Delete):** Should move to done, clean up blocker rows
4. **Multiple blocked tasks sharing a blocker:** Both should auto-start when blocker clears
5. **Dependency chain (C blocked by B blocked by A):** When A clears, B starts. When B clears, C starts.
6. **App restart with blocked tasks:** Restart app, verify blocked tasks with cleared blockers auto-start

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: blocked task feature complete"
```
