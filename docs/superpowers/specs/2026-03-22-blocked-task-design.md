# Blocked Task Feature

## Problem

Sometimes a new task depends on a task that is currently in progress. There's no point starting it because it would have to be re-written on top of the blocker's code. We need a way to put a task into a blocked state, where it queues up and starts automatically once all its blockers leave `in_progress`.

## Overview

- New `blocked` pipeline stage for tasks waiting on other tasks
- New `task_blocker` junction table for many-to-many dependency tracking
- Two command palette commands: "Block Task" and "Edit Blocked Task"
- Auto-unblock logic triggers when any task leaves `in_progress`
- Blocked tasks have no worktree or agent until they unblock

**Dependency:** This feature targets the post-refactor codebase from branch `task-8a29c9c0` (Pinia store refactor). The orchestration logic lives in `stores/kanna.ts`.

## Data Model

### Stage type

Add `blocked` to the Stage union:

```typescript
type Stage = "in_progress" | "pr" | "merge" | "done" | "blocked";
```

### Transition matrix

Two new transitions:

- `blocked → in_progress` (automatic, when all blockers leave `in_progress`)
- `blocked → done` (user abandons a blocked task via Cmd+Delete)

No transitions *into* `blocked` — tasks are created in that state via direct DB insert, bypassing `VALID_TRANSITIONS` (same pattern as existing task creation which inserts directly as `in_progress`).

### `task_blocker` table

```sql
CREATE TABLE IF NOT EXISTS task_blocker (
  blocked_item_id TEXT NOT NULL REFERENCES pipeline_item(id),
  blocker_item_id TEXT NOT NULL REFERENCES pipeline_item(id),
  PRIMARY KEY (blocked_item_id, blocker_item_id)
);
```

### DB query helpers (`packages/db`)

- `insertTaskBlocker(db, blockedItemId, blockerItemId)`
- `removeTaskBlocker(db, blockedItemId, blockerItemId)`
- `listBlockersForItem(db, blockedItemId)` → blocker PipelineItems
- `listBlockedByItem(db, blockerItemId)` → items blocked by this one
- `getUnblockedItems(db)` → items in `blocked` stage where ALL blockers are no longer `in_progress`
- `hasCircularDependency(db, blockedItemId, proposedBlockerIds)` → boolean (DFS cycle detection)

### TypeScript types (`packages/db`)

```typescript
interface TaskBlocker {
  blocked_item_id: string;
  blocker_item_id: string;
}
```

## "Block Task" Command

Triggered from command palette when selected task is `in_progress`.

1. User opens command palette, selects "Block Task"
2. Fuzzy search shows all other `in_progress` and `blocked` tasks (multi-select)
3. User selects one or more blockers, confirms
4. Insert a new `pipeline_item` with:
   - Same `prompt`, `repo_id`, `agent_type` as the closed task
   - `stage = 'blocked'`
   - No `branch`, `port_offset`, `port_env` (created on unblock)
   - `activity = 'idle'`
5. Insert `task_blocker` rows linking new item to each selected blocker
6. Close the current task via existing `closeTask()` logic (kill agent, teardown, remove worktree, set to `done`). Note: `blockTask()` must suppress the `checkUnblocked()` trigger during this close — the new blocked item and its blocker rows are already inserted, so the close won't cause a spurious unblock of unrelated tasks, but suppressing avoids unnecessary work.
7. Select next available task in sidebar

## "Edit Blocked Task" Command

Triggered from command palette when selected task is `blocked`.

1. User opens command palette, selects "Edit Blocked Task"
2. Fuzzy search of `in_progress` and `blocked` tasks, with current blockers pre-selected
3. User adds/removes blockers, confirms
4. Validate no circular dependencies (see below), reject if detected
5. Diff selection against existing `task_blocker` rows — insert new, delete removed
6. Run `checkUnblocked()` on the task — if all blockers are now clear (including zero blockers), auto-start immediately

Removing all blockers is the manual unblock path — no separate "unblock" command needed.

### Circular dependency prevention

Before inserting blocker rows (in both "Block Task" and "Edit Blocked Task"), validate that the new edges would not create a cycle. A cycle exists if any proposed blocker is itself (transitively) blocked by the task being blocked.

**Algorithm:** For each proposed blocker, walk the `task_blocker` graph from the blocker's own blockers, recursively. If the walk reaches the task being blocked, reject the operation. Given the small number of tasks (dozens, not thousands), a simple DFS is sufficient.

**Implementation:** `hasCircularDependency(db, blockedItemId, proposedBlockerIds)` → boolean. Added to `packages/db/src/queries.ts`.

**UX:** If a cycle is detected, show an error in the command palette (e.g., "Cannot add {task name} as a blocker — it would create a circular dependency").

## Auto-Unblock Logic

### Trigger

After every `updatePipelineItemStage` call that moves a task out of `in_progress`. This happens in three places in `stores/kanna.ts`:

- `makePR()` — `in_progress → pr`
- `mergeQueue()` — `in_progress → merge`
- `closeTask()` — `in_progress → done`

### `checkUnblocked(itemId)`

1. Query `listBlockedByItem(db, itemId)` — get all tasks blocked by the one that just transitioned
2. For each blocked task, query `listBlockersForItem(db, blockedItemId)`
3. Check if ALL blockers are no longer `in_progress` (stage is `pr`, `merge`, or `done` — NOT `blocked`, since a blocked task has done no work)
4. If yes, call `startBlockedTask(blockedItemId)`

### `startBlockedTask(blockedItemId)`

1. Look up the blocked item's `prompt`, `repo_id`, `agent_type`
2. Look up its blockers (for prompt context) — their display names and branch names
3. Augment the prompt:
   ```
   Note: this task was previously blocked by the following tasks which have now completed:
   - {display_name or first line of prompt} (branch: {branch})
   Their changes may be on branches that haven't merged to main yet.

   Original task:
   {original prompt}
   ```
4. Create a worktree (branched from repo root / default branch). This is intentional — the blocked task starts from the latest main, not from the blocker's feature branch. The prompt context tells the agent about the blocker's branches so it can incorporate those changes if needed (e.g., if the blocker hasn't merged to main yet).
5. Assign a port_offset
6. Update the pipeline_item: set `branch`, `port_offset`, `port_env`, `stage = 'in_progress'`, `activity = 'working'`
7. Spawn the PTY agent

## Sidebar & UI

### Sidebar sections (top to bottom)

1. Pinned
2. Pull Requests (`stage = 'pr'`)
3. Merge Queue (`stage = 'merge'`)
4. In Progress (`stage = 'in_progress'`)
5. Blocked (`stage = 'blocked'`)

Blocked items show display name (or prompt snippet) plus small text: "Blocked by: {task name(s)}".

Sorted by creation time (oldest first).

`sortedBlocked()` function added alongside existing `sortedPR()`, `sortedMerge()`, `sortedInProgress()`. Must be included in `itemsForRepo()` so blocked tasks count toward the repo badge.

### StageBadge

`blocked` — grey (`#666`, same family as `done`)

### Main panel for blocked tasks

No terminal view (no worktree/agent exists). Show a placeholder with:
- The task prompt
- List of blockers with status indicators for each

### Command palette visibility

- "Block Task" — visible when selected task is `in_progress`
- "Edit Blocked Task" — visible when selected task is `blocked`

## Files to Modify

All changes target the post-refactor branch (`task-8a29c9c0`).

| File | Changes |
|------|---------|
| `packages/core/src/pipeline/types.ts` | Add `blocked` to Stage, add `blocked → in_progress` and `blocked → done` transitions |
| `packages/db/src/schema.ts` | Add `TaskBlocker` interface |
| `packages/db/src/queries.ts` | Add blocker CRUD + `getUnblockedItems()` |
| `apps/desktop/src/stores/db.ts` | Add `task_blocker` table migration |
| `apps/desktop/src/stores/kanna.ts` | `blockTask()`, `editBlockedTask()`, `checkUnblocked()`, `startBlockedTask()`, hook into `makePR`/`mergeQueue`/`closeTask` |
| `apps/desktop/src/components/Sidebar.vue` | Add "Blocked" section below "In Progress" |
| `apps/desktop/src/components/StageBadge.vue` | Add grey for `blocked` |
| `apps/desktop/src/components/CommandPalette.vue` | Add "Block Task" and "Edit Blocked Task" commands with fuzzy task search |
| `apps/desktop/src/components/MainPanel.vue` | Blocked task placeholder view |

## Edge Cases

- **Blocker abandoned (Cmd+Delete):** Still counts as unblocked. The agent prompt mentions the dependency so it can adapt.
- **All blockers removed via edit:** Zero dependencies = immediately unblocked → task auto-starts.
- **Circular dependencies:** Prevented at insert time via DFS. Both commands allow selecting `in_progress` and `blocked` tasks as blockers (supporting dependency chains like C → B → A). The cycle check catches cases where a chain of blocked tasks would loop back.
- **Multiple blocked tasks share a blocker:** Each is checked independently when the blocker transitions.
- **Blocked task during GC:** Blocked tasks should NOT be garbage collected (they're not `done`). No changes needed — GC only targets `stage = 'done'`.
- **Abandoning a blocked task (Cmd+Delete):** Transitions `blocked → done`. Deletes associated `task_blocker` rows. No worktree to clean up.
- **App restart with blocked tasks:** In `init()`, after migrations and data load but before restoring selection, call `getUnblockedItems(db)` and pass each result to `startBlockedTask()`. This catches blockers that transitioned while the app was closed.
