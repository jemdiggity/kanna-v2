# Context-Dependent Shortcut Help Menu — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `⌘/` show keyboard shortcuts relevant to the current view context, with a toggle to the full list.

**Architecture:** A new `useShortcutContext` composable tracks the active context (`main` | `diff` | `file`) via a module-level reactive ref. Components declare their context on mount. The existing `KeyboardShortcutsModal` gains a context-filtered mode as its default view, with a link to toggle to the full shortcut list.

**Tech Stack:** Vue 3 Composition API, TypeScript, bun:test

**Spec:** `docs/superpowers/specs/2026-03-22-context-shortcut-help-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/desktop/src/composables/useShortcutContext.ts` | Create | Context tracking composable — `activeContext` ref, `useShortcutContext()`, `registerContextShortcuts()`, `getContextShortcuts()` |
| `apps/desktop/src/composables/useShortcutContext.test.ts` | Create | Unit tests for context tracking and shortcut filtering |
| `apps/desktop/src/composables/useKeyboardShortcuts.ts` | Modify | Add `context` field to `ShortcutDef`, tag each shortcut |
| `apps/desktop/src/components/KeyboardShortcutsModal.vue` | Modify | Context mode + full mode toggle, snapshot context on open |
| `apps/desktop/src/components/DiffModal.vue` | Modify | Call `useShortcutContext("diff")` |
| `apps/desktop/src/components/DiffView.vue` | Modify | Register Space supplementary shortcut |
| `apps/desktop/src/components/FilePreviewModal.vue` | Modify | Call `useShortcutContext("file")`, register Space + ⌘O |
| `apps/desktop/src/App.vue` | Modify | Pass `activeContext` snapshot to modal, close other modals before opening shortcuts |

---

### Task 0: Create `useShortcutContext` composable with tests

**Files:**
- Create: `apps/desktop/src/composables/useShortcutContext.ts`
- Create: `apps/desktop/src/composables/useShortcutContext.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// apps/desktop/src/composables/useShortcutContext.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import {
  activeContext,
  contextShortcuts,
  setContext,
  resetContext,
  registerContextShortcuts as register,
  clearContextShortcuts,
  getContextShortcuts,
  type ShortcutContext,
} from "./useShortcutContext";

describe("useShortcutContext", () => {
  beforeEach(() => {
    resetContext();
    clearContextShortcuts();
  });

  describe("activeContext", () => {
    it("defaults to 'main'", () => {
      expect(activeContext.value).toBe("main");
    });

    it("can be set to diff", () => {
      setContext("diff");
      expect(activeContext.value).toBe("diff");
    });

    it("resets to main", () => {
      setContext("file");
      resetContext();
      expect(activeContext.value).toBe("main");
    });
  });

  describe("registerContextShortcuts", () => {
    it("stores shortcuts for a context", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);
      expect(contextShortcuts.value.get("diff")).toEqual([
        { label: "Cycle Scope", display: "Space" },
      ]);
    });

    it("clears shortcuts for a context", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);
      clearContextShortcuts("diff");
      expect(contextShortcuts.value.has("diff")).toBe(false);
    });
  });

  describe("getContextShortcuts", () => {
    it("returns global shortcuts tagged for the context", () => {
      // getContextShortcuts reads from the shortcuts array in useKeyboardShortcuts
      // which tags shortcuts with context. We test that it merges supplementary ones.
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);
      const result = getContextShortcuts("diff");
      // Should include supplementary shortcuts
      const labels = result.map((s) => s.action);
      expect(labels).toContain("Cycle Scope");
    });

    it("includes untagged global shortcuts (available in all contexts)", () => {
      const result = getContextShortcuts("diff");
      const labels = result.map((s) => s.action);
      expect(labels).toContain("Keyboard Shortcuts");
      expect(labels).toContain("Command Palette");
      expect(labels).toContain("Dismiss");
    });

    it("excludes shortcuts tagged for other contexts", () => {
      const result = getContextShortcuts("diff");
      const labels = result.map((s) => s.action);
      expect(labels).not.toContain("New Task"); // main-only
      expect(labels).not.toContain("File Picker"); // main-only
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/composables/useShortcutContext.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the composable**

```typescript
// apps/desktop/src/composables/useShortcutContext.ts
import { ref, onMounted, onUnmounted } from "vue";
import { shortcuts } from "./useKeyboardShortcuts";

export type ShortcutContext = "main" | "diff" | "file";

export interface ContextShortcut {
  label: string;
  display: string;
}

/** Active context — module-level singleton. */
export const activeContext = ref<ShortcutContext>("main");

/** Supplementary shortcuts registered by components, keyed by context. */
export const contextShortcuts = ref(new Map<ShortcutContext, ContextShortcut[]>());

export function setContext(ctx: ShortcutContext) {
  activeContext.value = ctx;
}

export function resetContext() {
  activeContext.value = "main";
}

/**
 * Composable: declares the active context for the component's lifetime.
 * Must be called during component setup().
 */
export function useShortcutContext(ctx: ShortcutContext) {
  onMounted(() => {
    activeContext.value = ctx;
  });
  onUnmounted(() => {
    activeContext.value = "main";
  });
}

/**
 * Register supplementary shortcuts for a context.
 * Must be called during component setup() so the cleanup hook registers.
 */
export function registerContextShortcuts(ctx: ShortcutContext, extras: ContextShortcut[]) {
  onMounted(() => {
    contextShortcuts.value.set(ctx, extras);
  });
  onUnmounted(() => {
    contextShortcuts.value.delete(ctx);
  });
}

/** Imperative clear — for testing and manual cleanup. */
export function clearContextShortcuts(ctx?: ShortcutContext) {
  if (ctx) {
    contextShortcuts.value.delete(ctx);
  } else {
    contextShortcuts.value.clear();
  }
}

/**
 * Returns shortcuts relevant to the given context:
 * - Global shortcuts tagged with this context (or untagged = all contexts)
 * - Supplementary shortcuts registered by components for this context
 */
export function getContextShortcuts(ctx: ShortcutContext): { keys: string; action: string }[] {
  const result: { keys: string; action: string }[] = [];

  // Global shortcuts: include if tagged for this context, or untagged (all contexts)
  for (const def of shortcuts) {
    if (!def.context || def.context.includes(ctx)) {
      result.push({ keys: def.display, action: def.label });
    }
  }

  // Supplementary shortcuts from components
  const extras = contextShortcuts.value.get(ctx);
  if (extras) {
    for (const s of extras) {
      result.push({ keys: s.display, action: s.label });
    }
  }

  return result;
}

/** Human-readable context title for the modal header. */
export function getContextTitle(ctx: ShortcutContext): string {
  const titles: Record<ShortcutContext, string> = {
    main: "Main Shortcuts",
    diff: "Diff Viewer Shortcuts",
    file: "File Viewer Shortcuts",
  };
  return titles[ctx];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/composables/useShortcutContext.test.ts`
Expected: PASS (all tests green). Note: tests that call `onMounted`/`onUnmounted` outside Vue component context will need to use the imperative `setContext`/`resetContext`/`register`/`clearContextShortcuts` helpers. The composable wrappers (`useShortcutContext`, `registerContextShortcuts`) are tested indirectly via integration.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useShortcutContext.ts apps/desktop/src/composables/useShortcutContext.test.ts
git commit -m "feat: add useShortcutContext composable with tests"
```

---

### Task 1: Tag global shortcuts with context

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`

- [ ] **Step 1: Add `context` field to `ShortcutDef` and import the type**

In `apps/desktop/src/composables/useKeyboardShortcuts.ts`, add to the `ShortcutDef` interface:

```typescript
import type { ShortcutContext } from "./useShortcutContext";

interface ShortcutDef {
  // ... existing fields ...
  /** Which contexts this shortcut appears in. Undefined = all contexts. */
  context?: ShortcutContext[];
}
```

- [ ] **Step 2: Tag each shortcut in the `shortcuts[]` array**

Add `context` to each entry:

```typescript
// Pipeline — main only
{ action: "newTask",    ..., context: ["main"] },
{ action: "openFile",   ..., context: ["main"] },
{ action: "openInIDE",  ..., context: ["main"] },
{ action: "makePR",     ..., context: ["main"] },
{ action: "mergeQueue", ..., context: ["main"] },
{ action: "closeTask",  ..., context: ["main"] },
{ action: "undoClose",  ..., context: ["main"] },
// Navigation — main only
{ action: "navigateDown", ..., context: ["main"] },
{ action: "navigateUp",   ..., context: ["main"] },
{ action: "toggleZen",    ..., context: ["main"] },
// Terminal — main only
{ action: "openShell",  ..., context: ["main"] },
// Views — main only
{ action: "showDiff",       ..., context: ["main"] },
// Help — all contexts (no context field)
{ action: "showShortcuts",  ... },  // no context
{ action: "commandPalette", ... },  // no context
// Window — diff only
{ action: "toggleMaximize", ..., context: ["diff"] },
// Escape — all contexts (no context field)
{ action: "dismiss",    ... },  // no context
```

- [ ] **Step 3: Remove the dismiss filter from `getShortcutGroups`**

In `getShortcutGroups()`, remove the line that skips dismiss so Escape appears in full mode too (consistent with context mode):

```typescript
// Remove this line:
// if (def.action === "dismiss") continue;
```

- [ ] **Step 4: Verify existing tests still pass**

Run: `cd apps/desktop && bun test`
Expected: All existing tests pass. The `context` field is optional and doesn't affect shortcut matching or execution.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts
git commit -m "feat: tag keyboard shortcuts with context field"
```

---

### Task 2: Update `KeyboardShortcutsModal` for context/full mode

**Files:**
- Modify: `apps/desktop/src/components/KeyboardShortcutsModal.vue`

- [ ] **Step 1: Add context props and imports**

Add to the `<script setup>`:

```typescript
import { ref, watch, computed } from "vue";
import { getShortcutGroups } from "../composables/useKeyboardShortcuts";
import { getContextShortcuts, getContextTitle, type ShortcutContext } from "../composables/useShortcutContext";

const props = defineProps<{
  hideOnStartup?: boolean;
  context: ShortcutContext;
}>();
```

- [ ] **Step 2: Add mode toggle state and computed shortcuts**

```typescript
const showFullMode = ref(false);
const contextTitle = computed(() => getContextTitle(props.context));
const contextItems = computed(() => getContextShortcuts(props.context));
const groups = getShortcutGroups();
```

- [ ] **Step 3: Update template for context mode / full mode**

Replace the template content inside `.shortcuts-modal`:

```html
<h3>{{ showFullMode ? 'Keyboard Shortcuts' : contextTitle }}</h3>

<!-- Context mode: flat list -->
<div v-if="!showFullMode" class="context-shortcuts">
  <div v-for="s in contextItems" :key="s.keys" class="shortcut-row">
    <span class="shortcut-action">{{ s.action }}</span>
    <span class="shortcut-keys">
      <kbd v-for="(k, i) in splitKeys(s.keys)" :key="i">{{ k }}</kbd>
    </span>
  </div>
</div>

<!-- Full mode: grouped list (existing) -->
<div v-else class="shortcuts-grid">
  <div v-for="group in groups" :key="group.title" class="shortcut-group">
    <h4>{{ group.title }}</h4>
    <div v-for="s in group.shortcuts" :key="s.keys" class="shortcut-row">
      <span class="shortcut-action">{{ s.action }}</span>
      <span class="shortcut-keys">
        <kbd v-for="(k, i) in splitKeys(s.keys)" :key="i">{{ k }}</kbd>
      </span>
    </div>
  </div>
</div>

<!-- Footer -->
<div class="shortcuts-footer">
  <a class="toggle-link" @click="showFullMode = !showFullMode">
    {{ showFullMode ? `Show ${contextTitle.toLowerCase()}` : 'Show all shortcuts' }}
  </a>
  <label v-if="showFullMode" class="startup-checkbox">
    <input type="checkbox" v-model="hideOnStartup" />
    Don't show on startup
  </label>
</div>
```

- [ ] **Step 4: Add CSS for the new elements**

Add to the `<style scoped>` section:

```css
.context-shortcuts {
  margin-bottom: 12px;
}
.shortcuts-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #333;
}
.toggle-link {
  color: #58a6ff;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.toggle-link:hover {
  text-decoration: underline;
}
```

Move the existing `.startup-checkbox` styles so they no longer have `margin-top` and `padding-top` (those are now on `.shortcuts-footer`).

- [ ] **Step 5: Verify it builds**

Run: `cd apps/desktop && bun run build` (or check via the dev server)
Expected: No TypeScript or build errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/KeyboardShortcutsModal.vue
git commit -m "feat: add context/full mode toggle to shortcuts modal"
```

---

### Task 3: Wire up App.vue — pass context, close other modals

**Files:**
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Import `activeContext` and pass snapshot to modal**

In `App.vue`, add the import:

```typescript
import { activeContext } from "./composables/useShortcutContext";
```

Add a ref to snapshot the context when the modal opens:

```typescript
const shortcutsContext = ref<"main" | "diff" | "file">("main");
```

- [ ] **Step 2: Update `showShortcuts` action to snapshot context and close other modals**

Replace the `showShortcuts` action (line 268):

```typescript
showShortcuts: () => {
  if (showShortcutsModal.value) {
    showShortcutsModal.value = false;
    return;
  }
  // Close any other modal first (single-modal convention)
  showCommandPalette.value = false;
  showFilePreviewModal.value = false;
  showFilePickerModal.value = false;
  // Don't close diff/shell — those are the contexts we want to read
  // Snapshot the active context at open time
  shortcutsContext.value = activeContext.value;
  showShortcutsModal.value = true;
},
```

- [ ] **Step 3: Pass context prop to KeyboardShortcutsModal in the template**

Update the `<KeyboardShortcutsModal>` usage (around line 613-618):

```html
<KeyboardShortcutsModal
  v-if="showShortcutsModal"
  :context="shortcutsContext"
  :hide-on-startup="hideShortcutsOnStartup"
  @close="showShortcutsModal = false"
  @update:hide-on-startup="(val: boolean) => { hideShortcutsOnStartup = val; if (db) setSetting(db, 'hideShortcutsOnStartup', String(val)); }"
/>
```

- [ ] **Step 4: Verify it builds**

Run: `cd apps/desktop && bun run build`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: wire context snapshot and modal closing to shortcut help"
```

---

### Task 4: Register context in DiffModal and DiffView

**Files:**
- Modify: `apps/desktop/src/components/DiffModal.vue`
- Modify: `apps/desktop/src/components/DiffView.vue`

- [ ] **Step 1: Add `useShortcutContext("diff")` to DiffModal**

In `DiffModal.vue`, add to the `<script setup>`:

```typescript
import { useShortcutContext } from "../composables/useShortcutContext";
useShortcutContext("diff");
```

- [ ] **Step 2: Register Space shortcut in DiffView**

In `DiffView.vue`, add to the `<script setup>`:

```typescript
import { registerContextShortcuts } from "../composables/useShortcutContext";
registerContextShortcuts("diff", [{ label: "Cycle Scope", display: "Space" }]);
```

- [ ] **Step 3: Verify it builds**

Run: `cd apps/desktop && bun run build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/DiffModal.vue apps/desktop/src/components/DiffView.vue
git commit -m "feat: register diff context and Space shortcut"
```

---

### Task 5: Register context in FilePreviewModal

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`

- [ ] **Step 1: Add context and supplementary shortcuts**

In `FilePreviewModal.vue`, add to the `<script setup>`:

```typescript
import { useShortcutContext, registerContextShortcuts } from "../composables/useShortcutContext";

useShortcutContext("file");
registerContextShortcuts("file", [
  { label: "Open in IDE", display: "⌘O" },
  ...(props.filePath.toLowerCase().endsWith(".md")
    ? [{ label: "Toggle Markdown", display: "Space" }]
    : []),
]);
```

The file path doesn't change during the component's lifetime (it's a required prop), so this is safe to compute at setup time. `registerContextShortcuts` internally uses `onMounted`/`onUnmounted` for the actual map registration and cleanup.

- [ ] **Step 2: Verify it builds**

Run: `cd apps/desktop && bun run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/FilePreviewModal.vue
git commit -m "feat: register file context and supplementary shortcuts"
```

---

### Task 6: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Test main context**

Press `⌘/` from the main view. Verify:
- Title shows "Main Shortcuts"
- Shows pipeline, navigation, terminal shortcuts
- Does NOT show "Maximize" or "Cycle Scope"
- "Show all shortcuts" link is visible
- Click "Show all shortcuts" — all groups appear with group headers
- Click "Show main shortcuts" — returns to filtered view

- [ ] **Step 3: Test toggle behavior**

Press `⌘/` again — modal closes. Press `⌘/` — modal opens. Press `Escape` — modal closes.

- [ ] **Step 4: Test diff context**

Open a task with a worktree. Press `⌘D` to open diff viewer. Press `⌘/`. Verify:
- Title shows "Diff Viewer Shortcuts"
- Shows: Maximize, Escape, Keyboard Shortcuts, Command Palette, Cycle Scope (Space)
- Does NOT show pipeline shortcuts

- [ ] **Step 5: Test file context**

Press `⌘P` to open file picker, select a file. In the file preview, press `⌘/`. Verify:
- Title shows "File Viewer Shortcuts"
- Shows: Open in IDE, Escape, Keyboard Shortcuts, Command Palette
- For .md files, also shows "Toggle Markdown"

- [ ] **Step 6: Test ⌘/ while command palette is open**

Press `⇧⌘P` to open command palette. Press `⌘/`. Verify:
- Command palette closes
- Shortcuts modal opens with correct context

- [ ] **Step 7: Commit any fixes**

If any bugs were found and fixed during smoke testing, commit them.
