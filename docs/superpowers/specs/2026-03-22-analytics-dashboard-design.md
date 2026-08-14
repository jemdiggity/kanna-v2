# Analytics Dashboard

## Summary

Modal-based analytics dashboard for the active repo. Two views — **Throughput** and **Activity Time** — cycled with spacebar. Backed by a new `activity_log` table for accurate time-in-state tracking. Chart.js for visualization.

## Views

### View 1: Throughput

Headline stats at top:
- Tasks created (period)
- Tasks completed (period)
- Completion rate (%)

When only 0–1 tasks exist, suppress the completion rate percentage (not meaningful).

Bar chart below: tasks created vs completed, grouped by adaptive time bucket (daily if <2 weeks of data, weekly if <3 months, monthly otherwise). X-axis = time bucket, Y-axis = count. Two series: created (blue) and completed (green).

Data source: `pipeline_item` table, scoped to `repo_id = selectedRepoId`.
- "Created" = `COUNT(*)` grouped by `DATE(created_at)`
- "Completed" = `COUNT(*)` where `stage = 'done'` grouped by `DATE(updated_at)`

**Empty state:** If the repo has zero workflow items, show a centered message: "No tasks yet" instead of an empty chart.

### View 2: Activity Time

Headline stats at top:
- Avg time working per task
- Avg time idle per task
- Avg time unread (waiting for human) per task

Horizontal stacked bar chart: one bar per task (most recent N tasks, e.g., 20), segments colored by activity state. Working = blue, idle = gray, unread = amber.

Data source: `activity_log` table, scoped to `pipeline_item.repo_id = selectedRepoId`.

Duration calculation is done in the composable (not pure SQL) because the terminal row needs special handling:
1. Query all `activity_log` rows for the repo's items, ordered by `pipeline_item_id, started_at`
2. For each consecutive pair of rows within the same item: duration = `next.started_at - current.started_at`
3. For the last row of each item: if `pipeline_item.stage = 'done'`, use `pipeline_item.updated_at` as end time; otherwise use `now`
4. Sum durations per activity type per item

**Empty state:** If no activity_log rows exist, show: "Activity tracking started — data will appear as agents run."

## Navigation

- **Open**: `Cmd+Shift+A` keyboard shortcut, registered as `"showAnalytics"` in `ActionName` union and `shortcuts` array in `useKeyboardShortcuts.ts`
- **Cycle views**: Spacebar while modal is open. The modal's `@keydown` handler captures spacebar with `e.stopPropagation()` and `e.preventDefault()` to prevent it reaching the terminal.
- **Close**: Escape or click overlay
- View indicator dots at bottom of modal (like a carousel)

## Database

### New migration (inline in `runMigrations()`)

Added as a new `try/catch` block in `runMigrations()` in App.vue, following the existing inline pattern (no file-based migration loader exists):

```sql
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    activity TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_log_item ON activity_log(pipeline_item_id);
```

### Logging activity transitions

Embed the activity_log INSERT inside `updatePipelineItemActivity` itself (in `packages/db/src/queries.ts`) so both writes happen atomically in the same function. This avoids fragile paired calls at every App.vue call site:

```typescript
export async function updatePipelineItemActivity(
  db: DbHandle,
  id: string,
  activity: "working" | "unread" | "idle"
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET activity = ?, activity_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [activity, id]
  );
  await db.execute(
    "INSERT INTO activity_log (pipeline_item_id, activity) VALUES (?, ?)",
    [activity === id ? activity : id, activity] // see corrected version below
  );
}
```

Corrected — the function already receives `id` (pipeline_item_id) and `activity`:

```typescript
export async function updatePipelineItemActivity(
  db: DbHandle,
  id: string,
  activity: "working" | "unread" | "idle"
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET activity = ?, activity_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [activity, id]
  );
  await db.execute(
    "INSERT INTO activity_log (pipeline_item_id, activity) VALUES (?, ?)",
    [id, activity]
  );
}
```

All existing call sites (there are ~6 in App.vue including startup cleanup, undo-close, and selecting-an-unread-item) automatically get logging without changes.

Additionally, in `insertPipelineItem`, add an activity_log row for the initial state:

```typescript
// After the INSERT INTO pipeline_item...
await db.execute(
  "INSERT INTO activity_log (pipeline_item_id, activity) VALUES (?, ?)",
  [item.id, item.activity ?? "idle"]
);
```

### Adaptive time range

Compute `julianday('now') - julianday(min(created_at))` from `pipeline_item` for the repo (anchored to now, not max):
- < 14 days: daily buckets
- < 90 days: weekly buckets
- Otherwise: monthly buckets

If the query returns NULL (no items), default to daily.

## New Files

### `apps/desktop/src/components/AnalyticsModal.vue`

Modal component following existing modal pattern (fixed overlay, centered content, Escape to close). Contains:
- View title + dot indicators
- Chart canvas (via vue-chartjs)
- Headline stat cards (3 across)
- Spacebar handler to cycle `activeView` between 0 and 1

Props: `db: Ref<DbHandle | null>`, `repoId: Ref<string | null>` — follows the existing composable pattern of accepting nullable refs, with the component guarding internally.
Emits: `close`

Width: 720px (wider than typical modals to fit charts).

### `apps/desktop/src/composables/useAnalytics.ts`

Composable that takes `db: Ref<DbHandle | null>` and `repoId: Ref<string | null>`. Exposes:
- `throughputData` — reactive chart data for view 1
- `activityData` — reactive chart data for view 2
- `headlineStats` — computed summary numbers
- `timeRange` — computed adaptive bucket size
- `refresh()` — re-query the DB
- `hasData` — boolean, false when no workflow items exist for the repo

All queries are raw SQL via `db.select()`. Duration calculation for activity view is done in JS (see View 2 section above).

## Dependencies

Add to `apps/desktop/package.json`:
- `chart.js@^4` — charting engine
- `vue-chartjs@^5` — Vue 3 wrapper for Chart.js 4

## Integration Points

### App.vue changes
- Add `showAnalyticsModal` ref
- Register `"showAnalytics"` action in keyboard shortcut handler to toggle the modal
- Render `<AnalyticsModal v-if="showAnalyticsModal">` with `db` and `selectedRepoId` refs
- Add inline migration for `activity_log` table in `runMigrations()`

### useKeyboardShortcuts.ts changes
- Add `"showAnalytics"` to `ActionName` type union
- Add `{ key: "a", meta: true, shift: true, action: "showAnalytics" }` to `shortcuts` array

### packages/db/src/queries.ts changes
- Modify `updatePipelineItemActivity` to also INSERT into `activity_log`
- Modify `insertPipelineItem` to INSERT initial activity_log row

## Design

Follows existing dark theme:
- Modal background: `#252525`, border `#444`
- Headline cards: `#1e1e1e` background, `#333` border
- Stat values: `#ccc`, labels: `#888`
- Chart colors: blue `#0066cc` (working/created), green `#2ea043` (completed), amber `#d29922` (unread), gray `#555` (idle)
- Chart background transparent, grid lines `#333`
- Dot indicators: active `#0066cc`, inactive `#555`
