# Operator Telemetry Design

**Date:** 2026-03-22
**Goal:** Capture and visualize how the human operator interacts with Kanna — task switching frequency, dwell time, response time to unread tasks, and overall focus discipline. If you can measure it, you can optimize it.

## Motivation

Kanna already tracks *agent* behavior well (activity_log records working/idle/unread transitions). What's missing is *operator* behavior — how the human uses the app. The sidebar is effectively an inbox; we want inbox-style metrics: how long do "emails" sit unread, how much time is spent reading each one, how often is the operator context-switching.

## Data Capture

### New table: `operator_event`

```sql
CREATE TABLE IF NOT EXISTS operator_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  pipeline_item_id TEXT,
  repo_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_operator_event_repo ON operator_event(repo_id, created_at);
```

`repo_id` is nullable — `app_blur`/`app_focus` are app-level events not scoped to a repo. `task_selected` events always have a `repo_id` (read from `items.value.find(i => i.id === itemId)?.repo_id`).

### Event types

| Event | Trigger | pipeline_item_id | repo_id |
|-------|---------|-----------------|---------|
| `task_selected` | `selectItem()` in kanna store | the selected task | task's repo |
| `app_blur` | Tauri window loses focus | NULL | NULL |
| `app_focus` | Tauri window regains focus | NULL | NULL |

### Emission points

- **`task_selected`** — INSERT inside `selectItem()` in `kanna.ts`. Note: `selectItem()` is also called during `init()` to restore the previously-selected task. Guard against this by passing an `{ emitEvent: false }` flag (or similar) during init-time restore so startup doesn't generate a spurious event.

  Keyboard navigation in `App.vue` (`navigateItems()`) sets `selectedItemId` directly, bypassing `selectItem()`. Either refactor to route through `selectItem()`, or add the INSERT at both call sites. The former is cleaner.

- **`app_blur` / `app_focus`** — new `useOperatorEvents(db, selectedRepoId)` composable. Uses `document.addEventListener("visibilitychange")` (not `window.blur`/`focus`, which fire on intra-app focus changes like modals and dropdowns in WKWebView). `document.hidden === true` → `app_blur`, `document.hidden === false` → `app_focus`. Instantiated in `App.vue`.

App focus/blur events distinguish "operator left Kanna open and walked away" from "operator is actively dwelling on a task." Without this, dwell time inflates when they alt-tab.

### Insert helper

Following the project pattern where all SQL goes through typed helpers in `packages/db/src/queries.ts`:

```typescript
export async function insertOperatorEvent(
  db: DbHandle,
  eventType: "task_selected" | "app_blur" | "app_focus",
  pipelineItemId: string | null,
  repoId: string | null
): Promise<void> {
  await db.execute(
    "INSERT INTO operator_event (event_type, pipeline_item_id, repo_id) VALUES (?, ?, ?)",
    [eventType, pipelineItemId, repoId]
  );
}
```

## Derived Metrics

All metrics computed at query time in `useAnalytics`. No pre-aggregation — the raw event stream is the source of truth.

### Dwell Time

For each `task_selected` event, dwell = time until the next `task_selected` or `app_blur`, whichever comes first. When `app_focus` fires, the dwell clock resumes for the previously-selected task until the next `task_selected` or `app_blur`. Concretely:

```
task_selected(A) @ t=0
app_blur         @ t=30   → dwell(A) segment 1 = 30s
app_focus        @ t=120  → resume clock for A
task_selected(B) @ t=140  → dwell(A) segment 2 = 20s → total dwell(A) = 50s
```

### Response Time

For each task that transitions to `activity = "unread"` (from `activity_log`), response time = time from the unread timestamp until the first `task_selected` event for that `pipeline_item_id` afterward. Requires a JOIN across `activity_log` and `operator_event` via `pipeline_item_id`. Tasks the operator never selects while unread (agent resumes before they look) are excluded.

### Context Switch Rate

Count of `task_selected` events where `pipeline_item_id` differs from the previous selection, divided by active hours. Active hours = total wall time minus `app_blur`→`app_focus` gaps. Reselecting the same task does not count as a switch.

**Degenerate cases:** If no events exist, switches/hour = 0. If no blur gaps exist, active hours = now minus first event timestamp. Division by zero guarded by `max(activeHours, 0.001)`.

### Focus Score

Sum of dwells > 30s / total active dwell time. Ranges 0.0–1.0. A score of 0.8 means 80% of the operator's active time was in sustained focus blocks. If no dwells exist, score = null (displayed as "—").

### Inbox Pressure (future)

Snapshot count of `pipeline_item` rows where `activity = "unread"` at each `task_selected` event. Tracks whether the operator stays on top of things or falls behind.

### Triage Speed (future)

When 2+ tasks are unread simultaneously, time from first selection to last unread cleared in that batch. Second-order metric to add once basics are working.

## UI

### New "Operator" view in AnalyticsModal

Third view in the existing spacebar carousel: Throughput → Activity Time → **Operator**.

`viewCount` goes from 2 → 3. `viewNames` adds `"Operator"`.

### Headline cards (4)

| Card | Example | Meaning |
|------|---------|---------|
| Avg Response Time | `3m 22s` | How long unread tasks wait before operator looks |
| Avg Dwell Time | `1m 45s` | How long they stay on each task |
| Switches/Hour | `12.4` | Context switch frequency during active time |
| Focus Score | `78%` | Ratio of deep-focus time to total active time |

### Chart

Horizontal stacked bar chart (matching Activity Time view style) showing the 20 most recent tasks:

- **Dwell time** (blue) — total active time the operator spent looking at this task
- **Response time** (amber) — how long it sat unread before they got to it

At-a-glance view of which tasks got attention quickly vs. which ones languished.

### Empty state

If `operator_event` has no rows for the current repo, show: "Operator tracking started — data will appear as you work." This is independent of the `hasData` gate (which checks `pipeline_item` count) — the Operator view should check its own data.

## Files Changed

| File | Change |
|------|--------|
| `apps/desktop/src/stores/db.ts` | Add migration: `CREATE TABLE IF NOT EXISTS operator_event` + index |
| `apps/desktop/src/stores/kanna.ts` | Insert `task_selected` event in `selectItem()`, guard init-time restore |
| `apps/desktop/src/composables/useOperatorEvents.ts` | **New.** Emit `app_blur`/`app_focus` via `visibilitychange` listener |
| `apps/desktop/src/composables/useAnalytics.ts` | Add operator metric queries and computed properties |
| `apps/desktop/src/components/AnalyticsModal.vue` | Add third "Operator" view with headline cards + chart |
| `packages/db/src/schema.ts` | Add `OperatorEvent` interface |
| `packages/db/src/queries.ts` | Add `insertOperatorEvent()` helper |

## Retention

No pruning in the initial implementation. At typical usage (~50 task selections/day, ~100 blur/focus events/day), the table grows ~150 rows/day, ~55k rows/year. SQLite handles this without issue. If growth becomes a concern, a future pass can add `DELETE FROM operator_event WHERE created_at < datetime('now', '-90 days')` on startup.

## Non-goals

- No real-time indicators or session summaries outside the modal (keep scope tight)
- No pre-aggregated session tables (derive everything from the event stream)
- Inbox Pressure and Triage Speed are future work — noted in the spec but not implemented in this pass
- No refactoring of `navigateItems()` in this pass if it's simpler to emit at both call sites
