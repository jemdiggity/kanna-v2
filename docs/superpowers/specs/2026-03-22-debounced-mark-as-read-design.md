# Debounced Mark-as-Read Design

## Problem

When a user navigates tasks with keyboard shortcuts (`⌥⌘↑`/`⌥⌘↓`), rapidly passed-over items should not be marked as read. Currently, click selection marks items as read immediately (inline in `handleSelectItem()`), while keyboard navigation does not mark items as read at all.

## Solution

A `useMarkAsRead` composable that debounces mark-as-read for **all** selection changes (click and keyboard) with a ~1 second delay. If the user navigates away before the timer fires, the previous item stays unread.

## Design

### Composable: `useMarkAsRead`

**File:** `apps/desktop/src/composables/useMarkAsRead.ts`

**Signature:**
```ts
function useMarkAsRead(
  db: Ref<Database | null>,
  selectedItemId: Ref<string | null>,
  allItems: Ref<PipelineItem[]>
): void
```

**Behavior:**
1. Watches `selectedItemId`
2. On change, calls a `useDebounceFn`-wrapped function with the new item ID and `Date.now()` as `selectionTime`
3. VueUse's `useDebounceFn` cancels any pending invocation on re-call (handles rapid navigation)
4. When the debounced function fires (after 1000ms of no further navigation):
   - Finds the item in `allItems`
   - Checks `item.activity === "unread"`
   - Checks `item.activity_changed_at < selectionTime` (guards against hook events that updated activity during the debounce window)
   - If both pass: calls `updatePipelineItemActivity(db, id, "idle")` and sets `item.activity = "idle"` locally
5. Auto-cleans up via VueUse's scope disposal

**Dependencies:** `useDebounceFn` and `watch` from VueUse / Vue.

### Hook race-condition guard

The `activity_changed_at` check prevents the debounce timer from overwriting activity state changes that occurred after the user selected the item. Example scenario:

1. User selects an idle task → timer starts, `selectionTime = T`
2. During the 1s window, `WaitingForInput` hook fires → item becomes `"unread"`, `activity_changed_at = T+500ms`
3. Timer fires → `activity_changed_at (T+500ms) > selectionTime (T)` → skip, preserving the unread state

### Integration with App.vue

- Remove the inline mark-as-read logic from `handleSelectItem()` (currently lines 296-298)
- Call `useMarkAsRead(db, selectedItemId, allItems)` once during setup
- Both click and keyboard selection flow through `selectedItemId`, so the composable handles both uniformly

### What does NOT change

- Activity state transitions from daemon hook events (`WaitingForInput`, `Stop`, `StopFailure`) remain unchanged
- Sidebar visual indicators (bold for unread, italic for working) remain unchanged
- Sort order (activity-based) remains unchanged — the item will re-sort when its activity changes after the debounce

## Testing

- Unit test the composable with fake timers: verify that rapid selection changes only mark the final item as read
- Unit test the `activity_changed_at` guard: verify that hook-updated items are not overwritten
- Manual test: keyboard-navigate quickly through several unread items, confirm only the one you rest on gets marked as read
