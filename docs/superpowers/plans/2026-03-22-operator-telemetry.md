# Operator Telemetry Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track operator behavior (task switches, dwell time, response time, focus score) via an event log and surface it as a third view in the AnalyticsModal.

**Architecture:** Append-only `operator_event` table captures task selections and app visibility changes. All metrics derived at query time in `useAnalytics`. New "Operator" view in AnalyticsModal shows headline cards + per-task bar chart.

**Tech Stack:** SQLite, Vue 3 composables, Chart.js via vue-chartjs

**Spec:** `docs/superpowers/specs/2026-03-22-operator-telemetry-design.md`

---

### Task 1: Add `OperatorEvent` type and `insertOperatorEvent` query helper

**Files:**
- Modify: `packages/db/src/schema.ts:73-78` (after `ActivityLog` interface)
- Modify: `packages/db/src/queries.ts:1-6` (add to imports + export)
- Test: `packages/db/src/queries.test.ts`

- [ ] **Step 1: Add `OperatorEvent` interface to schema.ts**

After the `ActivityLog` interface in `packages/db/src/schema.ts`, add:

```typescript
export interface OperatorEvent {
  id: number;
  event_type: "task_selected" | "app_blur" | "app_focus";
  pipeline_item_id: string | null;
  repo_id: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Add `insertOperatorEvent` helper to queries.ts**

At the bottom of `packages/db/src/queries.ts`, before the Settings section, add:

```typescript
// ---------------------------------------------------------------------------
// OperatorEvent
// ---------------------------------------------------------------------------

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

Add `OperatorEvent` to the import from `./schema.js` at the top of `queries.ts`.

- [ ] **Step 3: Write test for `insertOperatorEvent`**

In `packages/db/src/queries.test.ts`, the existing `createMockDb` needs an `operator_event` table added to its tables record, and a handler for `INSERT INTO OPERATOR_EVENT` in the execute method. Then add a test:

```typescript
describe("insertOperatorEvent", () => {
  it("inserts a task_selected event", async () => {
    const db = createMockDb();
    await insertOperatorEvent(db, "task_selected", "item-1", "repo-1");
    expect(db.tables.operator_event).toHaveLength(1);
    expect(db.tables.operator_event[0].event_type).toBe("task_selected");
    expect(db.tables.operator_event[0].pipeline_item_id).toBe("item-1");
    expect(db.tables.operator_event[0].repo_id).toBe("repo-1");
  });

  it("inserts an app_blur event with null item and repo", async () => {
    const db = createMockDb();
    await insertOperatorEvent(db, "app_blur", null, null);
    expect(db.tables.operator_event).toHaveLength(1);
    expect(db.tables.operator_event[0].pipeline_item_id).toBeNull();
    expect(db.tables.operator_event[0].repo_id).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/db && bun test`
Expected: All tests pass including the new `insertOperatorEvent` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "feat: add OperatorEvent type and insertOperatorEvent query helper"
```

---

### Task 2: Add `operator_event` table migration

**Files:**
- Modify: `apps/desktop/src/stores/db.ts:114-120` (after task_blocker migration)

- [ ] **Step 1: Add migration to `runMigrations()`**

At the end of `runMigrations()` in `apps/desktop/src/stores/db.ts`, after the `task_blocker` table (line 119), add:

```typescript
  // Operator telemetry event log
  await db.execute(`CREATE TABLE IF NOT EXISTS operator_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    pipeline_item_id TEXT,
    repo_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_operator_event_repo ON operator_event(repo_id, created_at)`);
```

- [ ] **Step 2: Verify migration is idempotent**

The `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` ensure this runs safely on both new and existing databases.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/db.ts
git commit -m "feat: add operator_event table migration"
```

---

### Task 3: Emit `task_selected` events from the store

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:10-20` (imports)
- Modify: `apps/desktop/src/stores/kanna.ts:103-111` (`selectItem()`)
- Modify: `apps/desktop/src/stores/kanna.ts:762-822` (`init()`)
- Modify: `apps/desktop/src/App.vue:54-71` (`navigateItems()`)

The spec identifies 6 places where `selectedItemId.value` is set directly:

1. `selectItem()` at kanna.ts:104 — primary selection action
2. `createItem()` at kanna.ts:233 — after creating a new task
3. `closeTask()` at kanna.ts:349 — selects next item after closing
4. `undoClose()` at kanna.ts:375 — selects restored item
5. `blockTask()` at kanna.ts:720 — selects the new blocked replacement
6. `init()` at kanna.ts:820 — restores persisted selection (must NOT emit)
7. `navigateItems()` in App.vue:69 — keyboard j/k navigation

- [ ] **Step 1: Add `insertOperatorEvent` to kanna.ts imports**

In `apps/desktop/src/stores/kanna.ts`, add `insertOperatorEvent` to the import from `@kanna/db` (line 10-20):

```typescript
import {
  listRepos, insertRepo, findRepoByPath,
  hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery,
  listPipelineItems, insertPipelineItem, updatePipelineItemStage,
  updatePipelineItemActivity, pinPipelineItem, unpinPipelineItem,
  reorderPinnedItems, updatePipelineItemDisplayName,
  getRepo, getSetting, setSetting,
  insertTaskBlocker, removeTaskBlocker, removeAllBlockersForItem,
  listBlockersForItem, listBlockedByItem, getUnblockedItems,
  hasCircularDependency,
  insertOperatorEvent,
} from "@kanna/db";
```

- [ ] **Step 2: Add `emitTaskSelected` helper inside the store**

Inside `useKannaStore`, add a private helper after the `bump()` function (around line 29):

```typescript
  function emitTaskSelected(itemId: string) {
    const item = items.value.find((i) => i.id === itemId);
    insertOperatorEvent(_db, "task_selected", itemId, item?.repo_id ?? null).catch((e) =>
      console.error("[store] operator event failed:", e)
    );
  }
```

- [ ] **Step 3: Emit from `selectItem()`**

In `selectItem()` (kanna.ts:103-111), add a single line after `await setSetting(...)` (line 105):

```typescript
    emitTaskSelected(itemId);
```

The full function becomes: `selectedItemId.value = itemId` → `setSetting` → `emitTaskSelected` → activity check.

- [ ] **Step 4: Emit from `createItem()`**

At kanna.ts:233, after `selectedItemId.value = id;`, add:

```typescript
    emitTaskSelected(id);
```

- [ ] **Step 5: Emit from `closeTask()`**

At kanna.ts:349, after `selectedItemId.value = ...`, add:

```typescript
    if (selectedItemId.value) emitTaskSelected(selectedItemId.value);
```

- [ ] **Step 6: Emit from `undoClose()`**

At kanna.ts:375, after `selectedItemId.value = item.id;`, add:

```typescript
      emitTaskSelected(item.id);
```

- [ ] **Step 7: Emit from `blockTask()`**

At kanna.ts:720, after `selectedItemId.value = newId;`, add:

```typescript
    emitTaskSelected(newId);
```

- [ ] **Step 8: Do NOT emit from `init()`**

At kanna.ts:820, the line `selectedItemId.value = savedItem;` is the init-time restore. Do **not** add an emit here — this is a cold restore, not an operator action.

- [ ] **Step 9: Emit from `navigateItems()` in App.vue**

In `apps/desktop/src/App.vue:54-71`, the `navigateItems` function sets `store.selectedItemId = nextId` at line 69. Import `insertOperatorEvent` and add the emit. Modify the function:

```typescript
function navigateItems(direction: -1 | 1) {
  const currentItems = store.sortedItemsForCurrentRepo;
  if (currentItems.length === 0) return;
  const currentIndex = currentItems.findIndex((i) => i.id === store.selectedItemId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentItems.length) nextIndex = currentItems.length - 1;
  }
  const nextId = currentItems[nextIndex].id;
  if (nextId !== store.selectedItemId) {
    if (store.selectedItemId) recordNavigation(store.selectedItemId);
    store.selectedItemId = nextId;
    const item = currentItems[nextIndex];
    insertOperatorEvent(db as any, "task_selected", nextId, item.repo_id).catch((e: unknown) =>
      console.error("[app] operator event failed:", e)
    );
  }
}
```

Add `insertOperatorEvent` to the imports from `@kanna/db` in App.vue.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts apps/desktop/src/App.vue
git commit -m "feat: emit task_selected operator events from all selection points"
```

**Note:** Both Task 3 and Task 4 modify `App.vue`. If executing sequentially, Task 4's App.vue changes build on Task 3's. If executing in parallel, coordinate the merge.

---

### Task 4: Create `useOperatorEvents` composable for app visibility tracking

**Files:**
- Create: `apps/desktop/src/composables/useOperatorEvents.ts`
- Test: `apps/desktop/src/composables/useOperatorEvents.test.ts`
- Modify: `apps/desktop/src/App.vue` (instantiate composable)

- [ ] **Step 1: Write the test**

Create `apps/desktop/src/composables/useOperatorEvents.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ref } from "vue";

let dbCalls: { eventType: string; pipelineItemId: string | null; repoId: string | null }[] = [];

mock.module("@kanna/db", () => ({
  insertOperatorEvent: async (
    _db: any,
    eventType: string,
    pipelineItemId: string | null,
    repoId: string | null
  ) => {
    dbCalls.push({ eventType, pipelineItemId, repoId });
  },
}));

const { useOperatorEvents } = await import("./useOperatorEvents");

describe("useOperatorEvents", () => {
  beforeEach(() => {
    dbCalls = [];
  });

  it("emits app_blur when document becomes hidden", () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const cleanup = useOperatorEvents(db as any);

    // Simulate visibilitychange to hidden
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].eventType).toBe("app_blur");
    expect(dbCalls[0].pipelineItemId).toBeNull();
    expect(dbCalls[0].repoId).toBeNull();

    cleanup();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("emits app_focus when document becomes visible", () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const cleanup = useOperatorEvents(db as any);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].eventType).toBe("app_focus");

    cleanup();
  });

  it("does not emit when db is null", () => {
    const db = ref(null);
    const cleanup = useOperatorEvents(db as any);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dbCalls).toHaveLength(0);

    cleanup();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/composables/useOperatorEvents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the composable**

Create `apps/desktop/src/composables/useOperatorEvents.ts`:

```typescript
import { type Ref } from "vue";
import type { DbHandle } from "@kanna/db";
import { insertOperatorEvent } from "@kanna/db";

export function useOperatorEvents(db: Ref<DbHandle | null>): () => void {
  function handleVisibilityChange() {
    if (!db.value) return;
    const eventType = document.hidden ? "app_blur" : "app_focus";
    insertOperatorEvent(db.value, eventType, null, null).catch((e) =>
      console.error("[operator-events] failed:", e)
    );
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/composables/useOperatorEvents.test.ts`
Expected: All 3 tests pass.

- [ ] **Step 5: Wire up in App.vue**

In `apps/desktop/src/App.vue`, add the import alongside `useMarkAsRead`:

```typescript
import { useOperatorEvents } from "./composables/useOperatorEvents";
```

After the `useMarkAsRead(...)` call (around line 32), add:

```typescript
useOperatorEvents(computed(() => db) as unknown as Ref<DbHandle | null>);
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/composables/useOperatorEvents.ts apps/desktop/src/composables/useOperatorEvents.test.ts apps/desktop/src/App.vue
git commit -m "feat: add useOperatorEvents composable for app visibility tracking"
```

---

### Task 5: Add operator metric computation to `useAnalytics`

**Files:**
- Modify: `apps/desktop/src/composables/useAnalytics.ts`

This is the most complex task. We query `operator_event` and `activity_log`, then compute dwell time, response time, context switch rate, and focus score.

- [ ] **Step 1: Add `OperatorEvent` to imports and add new refs**

At the top of `useAnalytics.ts`, add to the import from `@kanna/db`:

```typescript
import type { DbHandle, PipelineItem, ActivityLog, OperatorEvent } from "@kanna/db";
```

Add new interfaces after `ActivityBreakdown`:

```typescript
interface OperatorMetrics {
  avgResponseTime: number | null;  // seconds
  avgDwellTime: number | null;     // seconds
  switchesPerHour: number | null;
  focusScore: number | null;       // 0.0–1.0
}

interface OperatorTaskBreakdown {
  itemId: string;
  label: string;
  dwellTime: number;     // seconds — total active time on this task
  responseTime: number;  // seconds — time task sat unread before first look
}
```

- [ ] **Step 2: Add new refs inside `useAnalytics`**

Inside the `useAnalytics` function, after `const loading = ref(false);`, add:

```typescript
  const operatorMetrics = ref<OperatorMetrics>({ avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null });
  const operatorBreakdowns = ref<OperatorTaskBreakdown[]>([]);
  const hasOperatorData = ref(false);
```

- [ ] **Step 3: Add `computeOperatorMetrics` function**

Inside `useAnalytics`, after the `bucketLabel` function, add:

```typescript
  function computeDwells(events: OperatorEvent[]): Map<string, number> {
    // Returns total dwell time per pipeline_item_id (in seconds)
    const dwells = new Map<string, number>();
    let activeItemId: string | null = null;
    let segmentStart: number | null = null;
    let appVisible = true;

    for (const event of events) {
      const t = new Date(event.created_at + "Z").getTime();

      if (event.event_type === "task_selected") {
        // Close previous segment
        if (activeItemId && segmentStart !== null && appVisible) {
          const dur = Math.max(0, (t - segmentStart) / 1000);
          dwells.set(activeItemId, (dwells.get(activeItemId) || 0) + dur);
        }
        activeItemId = event.pipeline_item_id;
        segmentStart = appVisible ? t : null;
      } else if (event.event_type === "app_blur") {
        // Close current segment
        if (activeItemId && segmentStart !== null) {
          const dur = Math.max(0, (t - segmentStart) / 1000);
          dwells.set(activeItemId, (dwells.get(activeItemId) || 0) + dur);
        }
        segmentStart = null;
        appVisible = false;
      } else if (event.event_type === "app_focus") {
        appVisible = true;
        if (activeItemId) segmentStart = t;
      }
    }

    // Close final segment (still viewing a task)
    if (activeItemId && segmentStart !== null && appVisible) {
      const dur = Math.max(0, (Date.now() - segmentStart) / 1000);
      dwells.set(activeItemId, (dwells.get(activeItemId) || 0) + dur);
    }

    return dwells;
  }

  function computeActiveHours(events: OperatorEvent[]): number {
    if (events.length === 0) return 0;
    const first = new Date(events[0].created_at + "Z").getTime();
    const now = Date.now();
    let totalBlur = 0;
    let blurStart: number | null = null;

    for (const event of events) {
      const t = new Date(event.created_at + "Z").getTime();
      if (event.event_type === "app_blur") {
        blurStart = t;
      } else if (event.event_type === "app_focus" && blurStart !== null) {
        totalBlur += t - blurStart;
        blurStart = null;
      }
    }
    // If still blurred, count up to now
    if (blurStart !== null) totalBlur += now - blurStart;

    return Math.max(0.001, (now - first - totalBlur) / 3600000);
  }

  function computeSwitchCount(events: OperatorEvent[]): number {
    let count = 0;
    let prevItemId: string | null = null;
    for (const event of events) {
      if (event.event_type === "task_selected" && event.pipeline_item_id) {
        if (prevItemId !== null && event.pipeline_item_id !== prevItemId) {
          count++;
        }
        prevItemId = event.pipeline_item_id;
      }
    }
    return count;
  }

  function computeResponseTimes(
    events: OperatorEvent[],
    activityLogs: ActivityLog[]
  ): Map<string, number> {
    // For each unread transition, find time until first task_selected for that item
    const responses = new Map<string, number[]>();

    // Build a map of item → [timestamps when operator selected it]
    const selectionTimes = new Map<string, number[]>();
    for (const e of events) {
      if (e.event_type === "task_selected" && e.pipeline_item_id) {
        const arr = selectionTimes.get(e.pipeline_item_id) || [];
        arr.push(new Date(e.created_at + "Z").getTime());
        selectionTimes.set(e.pipeline_item_id, arr);
      }
    }

    for (const log of activityLogs) {
      if (log.activity !== "unread") continue;
      const unreadAt = new Date(log.started_at + "Z").getTime();
      const selections = selectionTimes.get(log.pipeline_item_id) || [];
      // Find first selection after this unread timestamp
      const firstAfter = selections.find((t) => t > unreadAt);
      if (firstAfter !== undefined) {
        const dur = (firstAfter - unreadAt) / 1000;
        const arr = responses.get(log.pipeline_item_id) || [];
        arr.push(dur);
        responses.set(log.pipeline_item_id, arr);
      }
    }

    // Average per item
    const avgResponses = new Map<string, number>();
    for (const [itemId, times] of responses) {
      avgResponses.set(itemId, times.reduce((a, b) => a + b, 0) / times.length);
    }
    return avgResponses;
  }
```

- [ ] **Step 3b: Reset operator refs in the early-return branch**

In `refresh()`, the existing early-return when `!hasData.value` (around line 97-101) resets throughput and activity refs. Add operator ref resets there too:

```typescript
      if (!hasData.value) {
        throughputBuckets.value = [];
        activityBreakdowns.value = [];
        operatorMetrics.value = { avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null };
        operatorBreakdowns.value = [];
        hasOperatorData.value = false;
        return;
      }
```

This prevents stale operator data from a previously-selected repo being shown when switching to a repo with no tasks.

- [ ] **Step 4: Add operator metric queries to `refresh()`**

Inside the `refresh()` function, after the activity breakdowns section (after `activityBreakdowns.value = breakdowns;` around line 175), add:

```typescript
      // --- Operator Metrics ---
      const opEvents = await db.value.select<OperatorEvent>(
        `SELECT * FROM operator_event
         WHERE repo_id = ? OR repo_id IS NULL
         ORDER BY created_at ASC`,
        [repoId.value]
      );

      hasOperatorData.value = opEvents.some((e) => e.event_type === "task_selected");

      if (hasOperatorData.value) {
        const dwells = computeDwells(opEvents);
        const dwellValues = [...dwells.values()];
        const avgDwell = dwellValues.length > 0
          ? dwellValues.reduce((a, b) => a + b, 0) / dwellValues.length
          : null;

        const activeHours = computeActiveHours(opEvents);
        const switchCount = computeSwitchCount(opEvents);

        // Focus score: sum of dwells > 30s / total dwell
        const totalDwell = dwellValues.reduce((a, b) => a + b, 0);
        const focusDwell = dwellValues.filter((d) => d > 30).reduce((a, b) => a + b, 0);
        const focusScore = totalDwell > 0 ? focusDwell / totalDwell : null;

        const responseTimes = computeResponseTimes(opEvents, logs);
        const responseValues = [...responseTimes.values()];
        const avgResponse = responseValues.length > 0
          ? responseValues.reduce((a, b) => a + b, 0) / responseValues.length
          : null;

        operatorMetrics.value = {
          avgResponseTime: avgResponse,
          avgDwellTime: avgDwell,
          switchesPerHour: switchCount / activeHours,
          focusScore,
        };

        // Per-task breakdowns for chart (most recent 20)
        const taskBreakdowns: OperatorTaskBreakdown[] = [];
        const recentItemIds = [...new Set(
          opEvents
            .filter((e) => e.event_type === "task_selected" && e.pipeline_item_id)
            .map((e) => e.pipeline_item_id!)
        )].slice(-20);

        for (const itemId of recentItemIds) {
          const item = itemMap.get(itemId);
          taskBreakdowns.push({
            itemId,
            label: item
              ? (item.display_name || item.issue_title || item.prompt?.slice(0, 30) || item.id.slice(0, 8))
              : itemId.slice(0, 8),
            dwellTime: dwells.get(itemId) || 0,
            responseTime: responseTimes.get(itemId) || 0,
          });
        }
        operatorBreakdowns.value = taskBreakdowns;
      } else {
        operatorMetrics.value = { avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null };
        operatorBreakdowns.value = [];
      }
```

- [ ] **Step 5: Export new refs**

In the return statement of `useAnalytics`, add the new refs:

```typescript
  return {
    throughputBuckets,
    activityBreakdowns,
    bucketSize,
    headlineStats,
    hasData,
    loading,
    refresh,
    operatorMetrics,
    operatorBreakdowns,
    hasOperatorData,
  };
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/composables/useAnalytics.ts
git commit -m "feat: add operator metric computation to useAnalytics"
```

---

### Task 6: Add "Operator" view to AnalyticsModal

**Files:**
- Modify: `apps/desktop/src/components/AnalyticsModal.vue`

- [ ] **Step 1: Update view count and names**

In `AnalyticsModal.vue`, change:

```typescript
const viewCount = 2;
const viewNames = ["Throughput", "Activity Time"];
```

to:

```typescript
const viewCount = 3;
const viewNames = ["Throughput", "Activity Time", "Operator"];
```

- [ ] **Step 2: Destructure new refs from `useAnalytics`**

Update the destructure to include operator data:

```typescript
const {
  throughputBuckets,
  activityBreakdowns,
  headlineStats,
  hasData,
  loading,
  operatorMetrics,
  operatorBreakdowns,
  hasOperatorData,
} = useAnalytics(toRef(props, "db"), toRef(props, "repoId"));
```

- [ ] **Step 3: Add Operator view template**

After the `<!-- View 1: Activity Time -->` template block (before `<!-- Dot indicators -->`), add:

```html
      <!-- View 2: Operator -->
      <template v-else-if="activeView === 2">
        <template v-if="!hasOperatorData">
          <div class="empty-state">Operator tracking started — data will appear as you work.</div>
        </template>
        <template v-else>
          <div class="headline-cards">
            <div class="card">
              <div class="card-value">{{ operatorMetrics.avgResponseTime != null ? formatDuration(operatorMetrics.avgResponseTime) : '—' }}</div>
              <div class="card-label">Avg Response Time</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.avgDwellTime != null ? formatDuration(operatorMetrics.avgDwellTime) : '—' }}</div>
              <div class="card-label">Avg Dwell Time</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.switchesPerHour != null ? operatorMetrics.switchesPerHour.toFixed(1) : '—' }}</div>
              <div class="card-label">Switches/Hour</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.focusScore != null ? Math.round(operatorMetrics.focusScore * 100) + '%' : '—' }}</div>
              <div class="card-label">Focus Score</div>
            </div>
          </div>
          <div class="chart-container">
            <Bar
              :data="{
                labels: operatorBreakdowns.map((b) => b.label),
                datasets: [
                  { label: 'Dwell Time', data: operatorBreakdowns.map((b) => b.dwellTime), backgroundColor: '#0066cc' },
                  { label: 'Response Time', data: operatorBreakdowns.map((b) => b.responseTime), backgroundColor: '#d29922' },
                ],
              }"
              :options="horizontalChartOptions"
            />
          </div>
        </template>
      </template>
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/AnalyticsModal.vue
git commit -m "feat: add Operator view to AnalyticsModal with headline cards and chart"
```

---

### Task 7: Manual verification

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: All unit tests pass.

- [ ] **Step 2: Start dev server and verify**

Run: `./scripts/dev.sh`

1. Open the app, select a few tasks, switch between them
2. Alt-tab away and back
3. Open Analytics (`Cmd+Shift+A`), press spacebar twice to reach the Operator view
4. Verify headline cards show values (non-dash)
5. Verify the chart renders with task labels and dwell/response bars

- [ ] **Step 3: Commit any fixes**

If any issues found during manual verification, fix and commit.
