# Debounced Mark-as-Read Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debounce mark-as-read by 1 second for all selection changes (click and keyboard) so rapid navigation doesn't mark passed-over items as read.

**Architecture:** A `useMarkAsRead` composable watches `selectedItemId` and uses VueUse's `useDebounceFn` to delay the activity transition. A timestamp guard prevents overwriting hook-driven activity changes during the debounce window.

**Tech Stack:** Vue 3, VueUse (`useDebounceFn`), bun:test

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `apps/desktop/src/composables/useMarkAsRead.ts` | Debounced mark-as-read composable |
| Create | `apps/desktop/src/composables/useMarkAsRead.test.ts` | Unit tests |
| Modify | `apps/desktop/src/App.vue:291-299` | Remove inline mark-as-read, wire up composable |
| Modify | `apps/desktop/package.json` | Add `@vueuse/core` dependency |

---

### Task 1: Install VueUse

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add @vueuse/core**

Run from repo root:
```bash
cd apps/desktop && bun add @vueuse/core
```

- [ ] **Step 2: Verify installation**

```bash
cd apps/desktop && bun run -e "import { useDebounceFn } from '@vueuse/core'; console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json apps/desktop/bun.lock
git commit -m "chore: add @vueuse/core dependency"
```

---

### Task 2: Write failing tests for useMarkAsRead

**Files:**
- Create: `apps/desktop/src/composables/useMarkAsRead.test.ts`

- [ ] **Step 1: Write the test file**

Tests use `bun:test` with `mock.module` for mocking (same pattern as `useBackup.test.ts`). Tests use real timers with `setTimeout` waits since `useDebounceFn` uses `setTimeout` internally. The DB is mocked to track calls.

```typescript
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ref } from "vue";
import type { PipelineItem } from "@kanna/db";

// Track DB calls
let dbCalls: { activity: string; id: string }[] = [];

// Mock @kanna/db
mock.module("@kanna/db", () => ({
  updatePipelineItemActivity: async (
    _db: any,
    id: string,
    activity: string
  ) => {
    dbCalls.push({ id, activity });
  },
}));

const { useMarkAsRead } = await import("./useMarkAsRead");

function makeItem(
  overrides: Partial<PipelineItem> = {}
): PipelineItem {
  return {
    id: "item-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: null,
    stage: "in_progress",
    pr_number: null,
    pr_url: null,
    branch: null,
    agent_type: "pty",
    activity: "unread",
    activity_changed_at: "2026-03-22T10:00:00.000Z",
    port_offset: null,
    display_name: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    created_at: "2026-03-22T09:00:00.000Z",
    updated_at: "2026-03-22T09:00:00.000Z",
    ...overrides,
  };
}

describe("useMarkAsRead", () => {
  beforeEach(() => {
    dbCalls = [];
  });

  it("marks an unread item as idle after debounce", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-22T10:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    // Should NOT be marked immediately
    await new Promise((r) => setTimeout(r, 100));
    expect(dbCalls).toHaveLength(0);
    expect(item.activity).toBe("unread");

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 1100));
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0]).toEqual({ id: "item-1", activity: "idle" });
    expect(item.activity).toBe("idle");
  });

  it("does not mark idle items", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "idle" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });

  it("cancels pending mark-as-read on rapid navigation", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item1 = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-22T10:00:00.000Z" });
    const item2 = makeItem({ id: "item-2", activity: "unread", activity_changed_at: "2026-03-22T10:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item1, item2]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    // Navigate rapidly: item-1 → item-2
    selectedItemId.value = "item-1";
    await new Promise((r) => setTimeout(r, 200));
    selectedItemId.value = "item-2";

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 1200));

    // Only item-2 should be marked
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].id).toBe("item-2");
    expect(item1.activity).toBe("unread");
    expect(item2.activity).toBe("idle");
  });

  it("skips mark-as-read if activity_changed_at is newer than selection time", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    // Set activity_changed_at far in the future so it's always after selectionTime
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2099-01-01T00:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 1200));

    // Should NOT mark as read — activity_changed_at is after selection time
    expect(dbCalls).toHaveLength(0);
    expect(item.activity).toBe("unread");
  });

  it("handles null activity_changed_at (treats as old)", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: null });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(1);
    expect(item.activity).toBe("idle");
  });

  it("no-ops when selectedItemId is set to null", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>("item-1");
    const item = makeItem({ id: "item-1", activity: "unread" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = null;

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });

  it("no-ops when db is null", async () => {
    const db = ref(null);
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-22T10:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });

  it("no-ops when item is removed from allItems during debounce", async () => {
    const db = ref({ execute: async () => ({ rowsAffected: 1 }), select: async () => [] });
    const selectedItemId = ref<string | null>(null);
    const item = makeItem({ id: "item-1", activity: "unread", activity_changed_at: "2026-03-22T10:00:00.000Z" });
    const allItems = ref<PipelineItem[]>([item]);

    useMarkAsRead(db as any, selectedItemId, allItems);

    selectedItemId.value = "item-1";

    // Remove item before debounce fires
    await new Promise((r) => setTimeout(r, 200));
    allItems.value = [];

    await new Promise((r) => setTimeout(r, 1200));
    expect(dbCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/desktop && bun test src/composables/useMarkAsRead.test.ts
```

Expected: FAIL — `useMarkAsRead` module not found

- [ ] **Step 3: Commit failing tests**

```bash
git add apps/desktop/src/composables/useMarkAsRead.test.ts
git commit -m "test: add failing tests for useMarkAsRead composable"
```

---

### Task 3: Implement useMarkAsRead composable

**Files:**
- Create: `apps/desktop/src/composables/useMarkAsRead.ts`

- [ ] **Step 1: Write the composable**

```typescript
import { watch, type Ref } from "vue";
import { useDebounceFn } from "@vueuse/core";
import type { DbHandle, PipelineItem } from "@kanna/db";
import { updatePipelineItemActivity } from "@kanna/db";

export function useMarkAsRead(
  db: Ref<DbHandle | null>,
  selectedItemId: Ref<string | null>,
  allItems: Ref<PipelineItem[]>
): void {
  const markAsRead = useDebounceFn(
    (itemId: string, selectionTime: number) => {
      if (!db.value) return;
      const item = allItems.value.find((i) => i.id === itemId);
      if (!item || item.activity !== "unread") return;

      // Guard: skip if a hook updated activity after we selected the item.
      // activity_changed_at can be ISO 8601 or SQLite datetime('now') format —
      // Date.parse handles both correctly.
      if (item.activity_changed_at !== null) {
        const changedAt = new Date(item.activity_changed_at).getTime();
        if (changedAt > selectionTime) return;
      }

      updatePipelineItemActivity(db.value, itemId, "idle").catch((e) => {
        console.error("[useMarkAsRead] failed to update activity:", e);
      });
      item.activity = "idle";
    },
    1000
  );

  watch(selectedItemId, (itemId) => {
    if (itemId) {
      markAsRead(itemId, Date.now());
    }
  });
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd apps/desktop && bun test src/composables/useMarkAsRead.test.ts
```

Expected: All 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useMarkAsRead.ts
git commit -m "feat: implement useMarkAsRead composable with debounced activity transition"
```

---

### Task 4: Integrate into App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue:1-30` (imports)
- Modify: `apps/desktop/src/App.vue:291-299` (handleSelectItem)

- [ ] **Step 1: Add import**

In `App.vue`, add the import alongside the other composable imports (after line 23):

```typescript
import { useMarkAsRead } from "./composables/useMarkAsRead";
```

- [ ] **Step 2: Call composable in setup**

After the `usePipeline` destructuring (after line 29), add:

```typescript
useMarkAsRead(db, selectedItemId, allItems);
```

- [ ] **Step 3: Remove inline mark-as-read from handleSelectItem**

Change `handleSelectItem` (lines 291-300) from:

```typescript
function handleSelectItem(itemId: string) {
  selectedItemId.value = itemId;
  if (db.value) setSetting(db.value, "selected_item_id", itemId);
  // Mark as read if unread
  const item = allItems.value.find((i) => i.id === itemId);
  if (item && item.activity === "unread" && db.value) {
    updatePipelineItemActivity(db.value, itemId, "idle");
    item.activity = "idle";
  }
}
```

To:

```typescript
function handleSelectItem(itemId: string) {
  selectedItemId.value = itemId;
  if (db.value) setSetting(db.value, "selected_item_id", itemId);
}
```

- [ ] **Step 4: Clean up unused import if needed**

Check if `updatePipelineItemActivity` is still used elsewhere in `App.vue` (it is — in the hook event handlers around line 537). If so, keep the import. If not, remove it from line 7.

- [ ] **Step 5: Run all tests**

```bash
cd apps/desktop && bun test src/composables/useMarkAsRead.test.ts
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: wire useMarkAsRead into App.vue, remove inline mark-as-read"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Start the dev server**

```bash
./scripts/dev.sh
```

- [ ] **Step 2: Test keyboard navigation**

1. Have at least 2 tasks with `unread` activity (bold text in sidebar)
2. Press `⌥⌘↓` rapidly to navigate past them
3. Verify passed-over items stay bold (unread)
4. Rest on one item for >1 second
5. Verify it becomes normal weight (idle)

- [ ] **Step 3: Test click selection**

1. Have an unread task
2. Click it
3. Verify it stays bold for ~1 second, then becomes normal weight

- [ ] **Step 4: Commit any fixes if needed**
