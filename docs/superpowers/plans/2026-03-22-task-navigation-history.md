# Task Navigation History Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VS Code-style back/forward navigation (Ctrl+- / Ctrl+Shift+-) for task-to-task history in Kanna.

**Architecture:** New `useNavigationHistory` composable manages in-memory back/forward stacks. The existing `useKeyboardShortcuts` system gets a `ctrl` modifier field and two new shortcut entries. `App.vue` wires the composable into task selection and keyboard actions.

**Tech Stack:** Vue 3 (composables, refs, computed), TypeScript, bun:test

**Spec:** `docs/superpowers/specs/2026-03-22-task-navigation-history-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/composables/useNavigationHistory.ts` | **Create** — back/forward stack logic, record/goBack/goForward API |
| `apps/desktop/src/composables/useNavigationHistory.test.ts` | **Create** — unit tests for the composable |
| `apps/desktop/src/composables/useKeyboardShortcuts.ts` | **Modify** — add `ctrl` field to `ShortcutDef`, update `matches()`, extend `ActionName`, add shortcut entries |
| `apps/desktop/src/App.vue` | **Modify** — initialize composable, wire keyboard actions, update `handleSelectItem` and `navigateItems` to record history |

---

### Task 1: Create `useNavigationHistory` composable with tests

**Files:**
- Create: `apps/desktop/src/composables/useNavigationHistory.ts`
- Create: `apps/desktop/src/composables/useNavigationHistory.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/desktop/src/composables/useNavigationHistory.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { createNavigationHistory } from "./useNavigationHistory";

describe("useNavigationHistory", () => {
  let nav: ReturnType<typeof createNavigationHistory>;

  beforeEach(() => {
    nav = createNavigationHistory();
  });

  describe("recordNavigation", () => {
    it("pushes previous task onto back stack", () => {
      nav.recordNavigation("A");
      expect(nav.canGoBack.value).toBe(true);
      expect(nav.canGoForward.value).toBe(false);
    });

    it("clears forward stack on new navigation", () => {
      nav.recordNavigation("A");
      nav.goBack("B"); // back to A, forward has B
      expect(nav.canGoForward.value).toBe(true);
      nav.recordNavigation("A"); // new nav clears forward
      expect(nav.canGoForward.value).toBe(false);
    });

    it("suppresses duplicate consecutive entries", () => {
      nav.recordNavigation("A");
      nav.recordNavigation("A"); // same as top of stack, should not double-push
      const first = nav.goBack("B");
      expect(first).toBe("A");
      const second = nav.goBack("A");
      expect(second).toBeNull(); // only one entry
    });

    it("ignores null previous task", () => {
      nav.recordNavigation(null);
      expect(nav.canGoBack.value).toBe(false);
    });

    it("caps back stack at 50 entries", () => {
      for (let i = 0; i < 60; i++) {
        nav.recordNavigation(`task-${i}`);
      }
      let count = 0;
      let current = "task-60";
      while (nav.canGoBack.value) {
        current = nav.goBack(current)!;
        count++;
      }
      expect(count).toBe(50);
    });
  });

  describe("goBack", () => {
    it("returns null when back stack is empty", () => {
      expect(nav.goBack("A")).toBeNull();
    });

    it("returns previous task and pushes current to forward stack", () => {
      nav.recordNavigation("A");
      nav.recordNavigation("B");
      const result = nav.goBack("C");
      expect(result).toBe("B");
      expect(nav.canGoForward.value).toBe(true);
    });

    it("skips task IDs not in the valid set", () => {
      nav.recordNavigation("A");
      nav.recordNavigation("B");
      // B was deleted, only A and C are valid
      const result = nav.goBack("C", new Set(["A", "C"]));
      expect(result).toBe("A");
    });

    it("returns null if all back entries are invalid", () => {
      nav.recordNavigation("A");
      const result = nav.goBack("B", new Set(["B"])); // A not valid
      expect(result).toBeNull();
    });
  });

  describe("goForward", () => {
    it("returns null when forward stack is empty", () => {
      expect(nav.goForward("A")).toBeNull();
    });

    it("returns next task and pushes current to back stack", () => {
      nav.recordNavigation("A");
      nav.goBack("B"); // now on A, forward has B
      const result = nav.goForward("A");
      expect(result).toBe("B");
      expect(nav.canGoBack.value).toBe(true);
    });

    it("skips invalid task IDs", () => {
      nav.recordNavigation("A");
      nav.recordNavigation("B");
      nav.goBack("C"); // on B, forward has C
      nav.goBack("B"); // on A, forward has B, C
      // B was deleted
      const result = nav.goForward("A", new Set(["A", "C"]));
      expect(result).toBe("C");
    });
  });

  describe("full navigation sequence", () => {
    it("handles back-forward-new navigation correctly", () => {
      nav.recordNavigation("A");
      nav.recordNavigation("B");
      // Go back twice: C -> B -> A
      expect(nav.goBack("C")).toBe("B");
      expect(nav.goBack("B")).toBe("A");
      // Go forward once: A -> B
      expect(nav.goForward("A")).toBe("B");
      // New navigation from B -> D clears forward
      nav.recordNavigation("B");
      expect(nav.canGoForward.value).toBe(false);
      // Back should go to B (from D)
      expect(nav.goBack("D")).toBe("B");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/composables/useNavigationHistory.test.ts`
Expected: FAIL — module `./useNavigationHistory` not found

- [ ] **Step 3: Write the composable**

Create `apps/desktop/src/composables/useNavigationHistory.ts`:

```ts
import { ref, computed } from "vue";

const MAX_STACK_SIZE = 50;

export function createNavigationHistory() {
  const backStack = ref<string[]>([]);
  const forwardStack = ref<string[]>([]);

  const canGoBack = computed(() => backStack.value.length > 0);
  const canGoForward = computed(() => forwardStack.value.length > 0);

  function recordNavigation(previousId: string | null) {
    if (!previousId) return;
    // Suppress duplicate consecutive entries
    if (backStack.value.length > 0 && backStack.value[backStack.value.length - 1] === previousId) return;
    backStack.value.push(previousId);
    if (backStack.value.length > MAX_STACK_SIZE) {
      backStack.value.splice(0, backStack.value.length - MAX_STACK_SIZE);
    }
    forwardStack.value = [];
  }

  function goBack(currentId: string, validIds?: Set<string>): string | null {
    while (backStack.value.length > 0) {
      const taskId = backStack.value.pop()!;
      if (validIds && !validIds.has(taskId)) continue;
      forwardStack.value.push(currentId);
      return taskId;
    }
    return null;
  }

  function goForward(currentId: string, validIds?: Set<string>): string | null {
    while (forwardStack.value.length > 0) {
      const taskId = forwardStack.value.pop()!;
      if (validIds && !validIds.has(taskId)) continue;
      backStack.value.push(currentId);
      return taskId;
    }
    return null;
  }

  return { recordNavigation, goBack, goForward, canGoBack, canGoForward };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/composables/useNavigationHistory.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useNavigationHistory.ts apps/desktop/src/composables/useNavigationHistory.test.ts
git commit -m "feat: add useNavigationHistory composable with tests"
```

---

### Task 2: Add `ctrl` modifier support to keyboard shortcuts

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`

- [ ] **Step 1: Extend `ActionName` union**

In `useKeyboardShortcuts.ts`, extend the `ActionName` type. Line 20 currently reads `  | "commandPalette";` — replace it to add the new members at the end:

```ts
  | "commandPalette"
  | "goBack"
  | "goForward";
```

- [ ] **Step 2: Add `ctrl` field to `ShortcutDef`**

Add `ctrl?: boolean;` to the `ShortcutDef` interface (after line 34, the `alt` field):

```ts
  ctrl?: boolean;
```

- [ ] **Step 3: Update `matches()` to check `ctrlKey`**

In `matches()` (line 70-77), add a `ctrlKey` check after the existing `altKey` check (after line 74):

```ts
  if (e.ctrlKey !== (def.ctrl ?? false)) return false;
```

- [ ] **Step 4: Add shortcut entries**

In the `shortcuts` array, add two entries in the Navigation section (after the `toggleZen` entry at line 57):

```ts
  { action: "goBack",    label: "Go Back",    group: "Navigation", key: "-", ctrl: true,               display: "⌃-" },
  { action: "goForward", label: "Go Forward", group: "Navigation", key: "-", ctrl: true, shift: true,  display: "⌃⇧-" },
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts
git commit -m "feat: add ctrl modifier and back/forward shortcut definitions"
```

---

### Task 3: Wire navigation history into App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue:1-300` (imports, composable init, handlers, keyboard actions)

- [ ] **Step 1: Import and initialize the composable**

Add import (after line 23, the `useBackup` import):

```ts
import { createNavigationHistory } from "./composables/useNavigationHistory";
```

Initialize after the existing composable calls (around line 34):

```ts
const { recordNavigation, goBack, goForward } = createNavigationHistory();
```

- [ ] **Step 2: Add `navigateToTask` helper**

Add a new function near `handleSelectItem` (around line 291). This navigates to a task without recording history — used by back/forward actions:

```ts
function navigateToTask(taskId: string) {
  selectedItemId.value = taskId;
  if (db.value) setSetting(db.value, "selected_item_id", taskId);
  const item = allItems.value.find((i) => i.id === taskId);
  if (item && item.activity === "unread" && db.value) {
    updatePipelineItemActivity(db.value, taskId, "idle");
    item.activity = "idle";
  }
}
```

- [ ] **Step 3: Update `handleSelectItem` to record history**

Modify `handleSelectItem` (line 291) to call `recordNavigation` before changing selection:

```ts
function handleSelectItem(itemId: string) {
  if (selectedItemId.value && selectedItemId.value !== itemId) {
    recordNavigation(selectedItemId.value);
  }
  selectedItemId.value = itemId;
  if (db.value) setSetting(db.value, "selected_item_id", itemId);
  const item = allItems.value.find((i) => i.id === itemId);
  if (item && item.activity === "unread" && db.value) {
    updatePipelineItemActivity(db.value, itemId, "idle");
    item.activity = "idle";
  }
}
```

- [ ] **Step 4: Update `navigateItems` to record history**

Modify `navigateItems` (line 93-107) to record history before changing selection:

```ts
function navigateItems(direction: -1 | 1) {
  const currentItems = sortedItemsForCurrentRepo();
  if (currentItems.length === 0) return;

  const currentIndex = currentItems.findIndex((i) => i.id === selectedItemId.value);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentItems.length) nextIndex = currentItems.length - 1;
  }
  const nextId = currentItems[nextIndex].id;
  if (nextId !== selectedItemId.value) {
    if (selectedItemId.value) recordNavigation(selectedItemId.value);
    selectedItemId.value = nextId;
  }
}
```

- [ ] **Step 5: Wire keyboard actions**

Add `goBack` and `goForward` to `keyboardActions` (before the closing `};` on line 270):

```ts
  goBack: () => {
    if (!selectedItemId.value) return;
    const validIds = new Set(allItems.value.filter((i) => i.stage !== "done").map((i) => i.id));
    const taskId = goBack(selectedItemId.value, validIds);
    if (taskId) navigateToTask(taskId);
  },
  goForward: () => {
    if (!selectedItemId.value) return;
    const validIds = new Set(allItems.value.filter((i) => i.stage !== "done").map((i) => i.id));
    const taskId = goForward(selectedItemId.value, validIds);
    if (taskId) navigateToTask(taskId);
  },
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: All tests pass (existing + new navigation history tests)

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: wire navigation history into task selection and keyboard shortcuts"
```

---

### Task 4: Manual verification

- [ ] **Step 1: Start dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Verify Ctrl+- key capture**

In the running app:
1. Select task A, then task B, then task C via sidebar clicks
2. Press `Ctrl+-` — should navigate back to task B
3. Press `Ctrl+-` again — should navigate back to task A
4. Press `Ctrl+Shift+-` — should navigate forward to task B

If `Ctrl+-` is intercepted by WKWebView (zoom), note in commit and consider alternative binding (`Ctrl+[` / `Ctrl+]`).

- [ ] **Step 3: Verify shortcuts appear in help modal**

Press `⌘/` to open keyboard shortcuts modal. Confirm "Go Back" and "Go Forward" appear in the Navigation section.

- [ ] **Step 4: Stop dev server**

Run: `./scripts/dev.sh stop`
