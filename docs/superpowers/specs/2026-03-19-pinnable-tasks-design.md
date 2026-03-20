# Pinnable Tasks — Design Spec

## Overview

Tasks in the sidebar can be pinned to the top of their repo's task list. Pinned tasks are manually sortable by drag. Unpinned tasks remain auto-sorted by activity state and timestamp.

## Data Model

Add two columns to `pipeline_item`:

```sql
ALTER TABLE pipeline_item ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_item ADD COLUMN pin_order INTEGER;
```

- `pinned` — 1 if pinned, 0 if not
- `pin_order` — integer sort position among pinned tasks for the same repo. Null when unpinned.

Update `PipelineItem` interface in `packages/db/src/schema.ts`:

```typescript
pinned: number;       // 0 or 1
pin_order: number | null;
```

## Sidebar Rendering

Task list for each repo is split into two groups separated by a divider:

1. **Pinned tasks** — sorted by `pin_order` ascending
2. **Divider** — thin horizontal line, always visible when pinned tasks exist
3. **Unpinned tasks** — sorted by activity state (working > unread > idle), then by most recent timestamp

The divider is only visible when:
- There are pinned tasks for the repo, OR
- A drag is in progress (to show where to drop)

When no pinned tasks exist and no drag is active, the task list renders identically to today.

## Drag Behavior

All tasks are draggable via native HTML drag-and-drop (`draggable="true"`, `dragstart`/`dragover`/`drop` events).

### Pinning

Dragging any task triggers the divider to appear (if not already visible). Dropping a task above the divider pins it:
- Sets `pinned = 1`
- Sets `pin_order` based on drop position among existing pinned tasks

A 2px blue insertion indicator appears between pinned tasks to show where the dropped task will land.

### Unpinning

Dropping a pinned task below the divider unpins it:
- Sets `pinned = 0`, `pin_order = null`
- Task returns to its auto-sorted position among unpinned tasks

No drop indicator is shown in the unpinned zone since position is automatic.

### Reordering pinned tasks

Dragging a pinned task within the pinned zone reorders it. The 2px insertion indicator shows the target position. On drop, `pin_order` values are updated for all pinned tasks in the repo.

### Drag cancellation

If the drag ends without a valid drop (escape, drag outside sidebar), nothing changes. If no tasks are pinned after the drag ends, the divider hides.

### Drag scope

Drag-and-drop is scoped to a single repo's visible task list. Collapsed repos are not drag sources or targets. Cross-repo dragging is not supported.

## Closed tasks

Closed tasks (`stage === "closed"`) are hidden from the sidebar regardless of pin state. No special unpin step — they simply disappear from the filtered list. Sparse `pin_order` gaps left by closed (or unpinned) tasks are harmless — sorting by ascending value is correct regardless of gaps. The existing GC path hard-deletes closed items, which removes their `pin_order` from the sequence entirely.

## Scope

Pinning is per-repo. Each repo has its own set of pinned tasks with independent `pin_order` sequences.

## DB Queries

New queries in `packages/db/src/queries.ts`:

- `pinPipelineItem(db, itemId, pinOrder)` — sets `pinned = 1` and `pin_order`
- `unpinPipelineItem(db, itemId)` — sets `pinned = 0`, `pin_order = null`
- `reorderPinnedItems(db, repoId, orderedIds: string[])` — updates `pin_order` for each pinned item using a single `UPDATE ... CASE WHEN` statement to avoid partial-failure inconsistency (the `DbHandle` interface does not expose transactions)

## Composable Changes

`usePipeline.ts` gains three methods:
- `pinItem(itemId, position)` — calls `pinPipelineItem`, updates reactive state
- `unpinItem(itemId)` — calls `unpinPipelineItem`, updates reactive state
- `reorderPinned(repoId, orderedIds)` — calls `reorderPinnedItems`, updates reactive state

## Sorting Changes

Both `Sidebar.vue:itemsForRepo()` and `App.vue:sortedItemsForCurrentRepo()` are updated:

1. Pinned tasks first (`pinned === 1`), sorted by `pin_order` ascending
2. Unpinned tasks second (`pinned === 0`), sorted by activity state then timestamp (existing logic)

Keyboard navigation (Cmd+Opt+Up/Down) follows the same order: pinned tasks first, then unpinned. This matches what the user sees in the sidebar.

## Files to Modify

| File | Change |
|------|--------|
| `apps/desktop/src/App.vue` | Add migration, update `sortedItemsForCurrentRepo()` |
| `apps/desktop/src/components/Sidebar.vue` | Add drag-and-drop handlers, divider rendering, update `itemsForRepo()` |
| `packages/db/src/schema.ts` | Add `pinned` and `pin_order` to `PipelineItem` |
| `packages/db/src/queries.ts` | Add pin/unpin/reorder queries, update `insertPipelineItem` param type to omit `pinned`/`pin_order` (rely on DB defaults) |
| `apps/desktop/src/composables/usePipeline.ts` | Add `pinItem`, `unpinItem`, `reorderPinned` |
| `apps/desktop/src/tauri-mock.ts` | Update mock DB to handle pin/unpin/reorder queries for browser-mode dev |
| `PRD.md` | Add Pinned Tasks section |
