# Repo Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `⇧⌘↑` / `⇧⌘↓` shortcuts to jump between repos, restoring the last-selected task per repo.

**Architecture:** Three touch-points — store tracks per-repo last-selected task, shortcut registry adds two entries, App.vue wires the navigation function. Navigation history records the jump so back/forward works.

**Tech Stack:** Vue 3 + Pinia, TypeScript, vue-i18n

---

### Task 1: Add `lastSelectedItemByRepo` tracking to store

**Goal:** Track the most recently selected task per repo so repo jumps can restore it.

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:82-83` (add ref near other selection state)
- Modify: `apps/desktop/src/stores/kanna.ts:169-174` (update `selectItem`)
- Modify: `apps/desktop/src/stores/kanna.ts:1480-1500` (expose in return)

**Acceptance Criteria:**
- [ ] `lastSelectedItemByRepo` is a reactive `Record<string, string>` in the store
- [ ] Every `selectItem()` call updates `lastSelectedItemByRepo` with the item's repo_id → item id
- [ ] `lastSelectedItemByRepo` is exported from the store

**Verify:** `bun tsc --noEmit` from `apps/desktop/` → no type errors

**Steps:**

- [ ] **Step 1: Add the ref**

In `apps/desktop/src/stores/kanna.ts`, after line 83 (`const selectedItemId = ref<string | null>(null);`), add:

```typescript
const lastSelectedItemByRepo = ref<Record<string, string>>({});
```

- [ ] **Step 2: Update `selectItem()` to track per-repo selection**

In `selectItem()` (around line 169), after `selectedItemId.value = itemId;`, add tracking logic:

```typescript
async function selectItem(itemId: string) {
  nav.select(itemId, selectedItemId.value);
  selectedItemId.value = itemId;
  const item = items.value.find((i) => i.id === itemId);
  if (item) {
    lastSelectedItemByRepo.value[item.repo_id] = itemId;
  }
  await setSetting(_db, "selected_item_id", itemId);
  emitTaskSelected(itemId);
}
```

- [ ] **Step 3: Expose in store return**

In the return object (line ~1480), add `lastSelectedItemByRepo` to the State section:

```typescript
return {
  // State
  repos, items, selectedRepoId, selectedItemId, lastSelectedItemByRepo,
  canGoBack, canGoForward,
  // ... rest unchanged
};
```

- [ ] **Step 4: Verify types**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: track last-selected task per repo in store"
```

---

### Task 2: Register shortcuts and wire navigation

**Goal:** Add `⇧⌘↑`/`⇧⌘↓` shortcut definitions and the `navigateRepos()` function that jumps between repos.

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:4-35` (add action names)
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:71-72` (add shortcut defs)
- Modify: `apps/desktop/src/App.vue:91-110` (add `navigateRepos` function)
- Modify: `apps/desktop/src/App.vue:296-452` (wire actions in `keyboardActions`)

**Acceptance Criteria:**
- [ ] `⇧⌘↑` jumps to previous repo, `⇧⌘↓` jumps to next repo
- [ ] Jumping restores the last-selected task for that repo (or first task if none)
- [ ] Boundary clamping: no-op at first/last repo
- [ ] Jump is recorded in navigation history (back/forward works)
- [ ] Shortcuts appear in the keyboard shortcuts modal under Navigation group

**Verify:** `cd apps/desktop && bun tsc --noEmit` → no type errors

**Steps:**

- [ ] **Step 1: Add action names to the type union**

In `apps/desktop/src/composables/useKeyboardShortcuts.ts`, add `"navigateRepoUp"` and `"navigateRepoDown"` to the `ActionName` type union (after `"navigateDown"`):

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
  | "navigateRepoUp"
  | "navigateRepoDown"
  | "dismiss"
  // ... rest unchanged
```

- [ ] **Step 2: Add shortcut definitions**

In the `shortcuts` array, after the `navigateDown` entry (line 72), add:

```typescript
  { action: "navigateRepoUp",   labelKey: "shortcuts.previousRepo",   groupKey: "shortcuts.groupNavigation", key: "ArrowUp",                   meta: true, shift: true,  display: "⇧⌘↑",     context: ["main"] },
  { action: "navigateRepoDown", labelKey: "shortcuts.nextRepo",       groupKey: "shortcuts.groupNavigation", key: "ArrowDown",                 meta: true, shift: true,  display: "⇧⌘↓",     context: ["main"] },
```

- [ ] **Step 3: Add `navigateRepos()` function in App.vue**

In `apps/desktop/src/App.vue`, after the `navigateItems` function (after line 110), add:

```typescript
function navigateRepos(direction: -1 | 1) {
  const visibleRepos = store.repos;
  if (visibleRepos.length === 0) return;
  const currentIndex = visibleRepos.findIndex((r) => r.id === store.selectedRepoId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= visibleRepos.length) return;
  }
  const nextRepo = visibleRepos[nextIndex];
  if (nextRepo.id === store.selectedRepoId) return;
  store.selectRepo(nextRepo.id);

  // Restore last-selected task for this repo, or fall back to first task
  const lastItemId = store.lastSelectedItemByRepo[nextRepo.id];
  const items = store.items;
  const lastItem = lastItemId
    ? items.find((i) => i.id === lastItemId && i.repo_id === nextRepo.id && !hasTag(i, "done"))
    : undefined;
  if (lastItem) {
    store.selectItem(lastItem.id);
  } else {
    const sorted = store.sortedItemsAllRepos.filter((i) => i.repo_id === nextRepo.id);
    if (sorted.length > 0) {
      store.selectItem(sorted[0].id);
    }
  }
}
```

- [ ] **Step 4: Check `hasTag` import in App.vue**

Verify `hasTag` is imported in App.vue. Search for its import — if not present, add:

```typescript
import { hasTag } from "@kanna/core";
```

- [ ] **Step 5: Wire actions in `keyboardActions`**

In the `keyboardActions` object (around line 339-340), after `navigateDown`, add:

```typescript
  navigateRepoUp: () => navigateRepos(-1),
  navigateRepoDown: () => navigateRepos(1),
```

- [ ] **Step 6: Verify types**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts apps/desktop/src/App.vue
git commit -m "feat: add ⇧⌘↑/⇧⌘↓ shortcuts for repo navigation"
```

---

### Task 3: Add i18n labels

**Goal:** Add translated labels for the new shortcuts so they display correctly in the keyboard shortcuts modal.

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json:48-49` (add after nextTask)
- Modify: `apps/desktop/src/i18n/locales/ja.json:48-49` (add after nextTask)
- Modify: `apps/desktop/src/i18n/locales/ko.json:48-49` (add after nextTask)

**Acceptance Criteria:**
- [ ] `shortcuts.previousRepo` and `shortcuts.nextRepo` keys exist in all three locale files
- [ ] Shortcuts modal shows the labels under the Navigation group

**Verify:** `cd apps/desktop && bun tsc --noEmit` → no type errors; open shortcuts modal → new entries visible

**Steps:**

- [ ] **Step 1: Add English labels**

In `apps/desktop/src/i18n/locales/en.json`, after the `"nextTask"` line, add:

```json
    "previousRepo": "Previous Repo",
    "nextRepo": "Next Repo",
```

- [ ] **Step 2: Add Japanese labels**

In `apps/desktop/src/i18n/locales/ja.json`, after the `"nextTask"` line, add:

```json
    "previousRepo": "前のリポジトリ",
    "nextRepo": "次のリポジトリ",
```

- [ ] **Step 3: Add Korean labels**

In `apps/desktop/src/i18n/locales/ko.json`, after the `"nextTask"` line, add:

```json
    "previousRepo": "이전 저장소",
    "nextRepo": "다음 저장소",
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/
git commit -m "feat: add i18n labels for repo navigation shortcuts"
```
