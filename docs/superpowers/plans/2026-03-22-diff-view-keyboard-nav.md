# Diff View & File Viewer Keyboard Navigation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `less`-style keyboard scrolling to both DiffView and FilePreviewModal, with remapped component-specific shortcuts.

**Architecture:** Extract a shared `useLessScroll` composable that handles the common scroll key bindings (j/k/f/b/d/u/g/G/Space/arrows/PageUp/PageDown/q). Each component composes it with its own extra bindings (scope cycling for DiffView, markdown toggle + Cmd+O for FilePreviewModal).

**Tech Stack:** Vue 3 composables, DOM scrolling API

**Spec:** `docs/superpowers/specs/2026-03-22-diff-view-keyboard-nav-design.md`

---

## File Structure

- **Create:** `apps/desktop/src/composables/useLessScroll.ts` — shared less-style scroll key handler
- **Modify:** `apps/desktop/src/components/DiffView.vue:168-193` — replace keydown handler, add close emit, remap scope cycling
- **Modify:** `apps/desktop/src/components/DiffModal.vue:20` — wire DiffView `@close` to `emit('close')`
- **Modify:** `apps/desktop/src/components/FilePreviewModal.vue:147-174` — replace keydown handler, remap markdown toggle

---

### Task 1: Create `useLessScroll` composable

**Files:**
- Create: `apps/desktop/src/composables/useLessScroll.ts`

- [ ] **Step 1: Create the composable**

```typescript
import { type Ref, onMounted, onUnmounted } from "vue";

const LINE = 40;

function isInputTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t.isContentEditable
  );
}

function noMods(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/**
 * Registers less-style scroll key bindings on the given scrollable element.
 * Returns a cleanup function, but also auto-cleans on onUnmounted.
 *
 * @param scrollRef - Ref to the scrollable DOM element
 * @param extraHandler - Optional handler for component-specific keys.
 *   Called first; return true to indicate the key was handled (skips scroll logic).
 * @param onClose - Called when `q` is pressed.
 */
export function useLessScroll(
  scrollRef: Ref<HTMLElement | null>,
  options: {
    extraHandler?: (e: KeyboardEvent) => boolean;
    onClose?: () => void;
  } = {}
) {
  function onKeydown(e: KeyboardEvent) {
    if (isInputTarget(e)) return;

    // Let the component handle its own keys first
    if (options.extraHandler?.(e)) return;

    const el = scrollRef.value;
    if (!el) return;

    const page = el.clientHeight;
    const half = page / 2;

    // q — close
    if (e.key === "q" && noMods(e)) {
      e.preventDefault();
      options.onClose?.();
      return;
    }

    // Scroll bindings
    let handled = true;
    if ((e.key === "j" && noMods(e)) || (e.key === "ArrowDown" && noMods(e))) {
      el.scrollTop += LINE;
    } else if ((e.key === "k" && noMods(e)) || (e.key === "ArrowUp" && noMods(e))) {
      el.scrollTop -= LINE;
    } else if (
      (e.key === "f" && noMods(e)) ||
      (e.key === " " && noMods(e)) ||
      (e.key === "PageDown" && noMods(e))
    ) {
      el.scrollTop += page;
    } else if (
      (e.key === "b" && noMods(e)) ||
      (e.key === "PageUp" && noMods(e))
    ) {
      el.scrollTop -= page;
    } else if (e.key === "d" && noMods(e)) {
      el.scrollTop += half;
    } else if (e.key === "u" && noMods(e)) {
      el.scrollTop -= half;
    } else if (e.key === "g" && noMods(e)) {
      el.scrollTop = 0;
    } else if (e.key === "G" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      el.scrollTop = el.scrollHeight;
    } else {
      handled = false;
    }

    if (handled) e.preventDefault();
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onUnmounted(() => window.removeEventListener("keydown", onKeydown));
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/desktop && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `useLessScroll.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useLessScroll.ts
git commit -m "feat: add useLessScroll composable for less-style keyboard scrolling"
```

---

### Task 2: Wire `useLessScroll` into DiffView + remap scope cycling

**Files:**
- Modify: `apps/desktop/src/components/DiffView.vue:168-193`
- Modify: `apps/desktop/src/components/DiffModal.vue:11-13,20`

- [ ] **Step 1: Update DiffView emits and add close emit**

In `DiffView.vue`, change the `defineEmits` (line 15-17) to include `close`:

```typescript
const emit = defineEmits<{
  (e: "scope-change", scope: "branch" | "commit" | "working"): void;
  (e: "close"): void;
}>();
```

- [ ] **Step 2: Replace scope cycling and keydown handler**

Replace lines 168-193 (from `const scopeOrder` through `defineExpose`) with the code below. Leave the `watch()` block at lines 162-166 untouched:

```typescript
const scopeOrder: Array<"working" | "branch" | "commit"> = ["working", "branch", "commit"];

function cycleScopeForward() {
  const idx = scopeOrder.indexOf(scope.value);
  scope.value = scopeOrder[(idx + 1) % scopeOrder.length];
  loadDiff();
}

function cycleScopeBack() {
  const idx = scopeOrder.indexOf(scope.value);
  scope.value = scopeOrder[(idx - 1 + scopeOrder.length) % scopeOrder.length];
  loadDiff();
}

useLessScroll(containerRef, {
  extraHandler(e) {
    // Cmd+Shift+] — next scope
    if (e.key === "]" && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      cycleScopeForward();
      return true;
    }
    // Cmd+Shift+[ — previous scope
    if (e.key === "[" && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      cycleScopeBack();
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});

onMounted(() => loadDiff());

onUnmounted(() => cleanupInstance());

defineExpose({ refresh: loadDiff });
```

- [ ] **Step 3: Add useLessScroll import**

Add to DiffView.vue imports (line 2):

```typescript
import { useLessScroll } from "../composables/useLessScroll";
```

And remove `onMounted, onUnmounted` from vue import only if no longer used directly — but they are still needed (`onMounted` calls `loadDiff()`, `onUnmounted` calls `cleanupInstance()`), so keep the vue import as-is.

- [ ] **Step 4: Wire `@close` in DiffModal**

In `DiffModal.vue` line 20, add `@close` to the DiffView component:

```html
<DiffView :repo-path="repoPath" :worktree-path="worktreePath" :initial-scope="initialScope" @scope-change="emit('scope-change', $event)" @close="emit('close')" />
```

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/desktop && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/DiffView.vue apps/desktop/src/components/DiffModal.vue
git commit -m "feat: add less-style scroll keys to DiffView, remap scope cycling to Cmd+Shift+[/]"
```

---

### Task 3: Wire `useLessScroll` into FilePreviewModal + remap markdown toggle

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue:147-174,183`

- [ ] **Step 1: Add a template ref for the scroll container**

In `FilePreviewModal.vue`, add a ref near the other refs (around line 13):

```typescript
const contentRef = ref<HTMLElement | null>(null);
```

And add the `ref` attribute to the `.preview-content` div in the template (line 191-196). Change:

```html
<div
  v-else
  class="preview-content"
  :class="{ 'markdown-rendered': renderMarkdown && isMarkdownFile }"
  v-html="renderMarkdown && isMarkdownFile ? renderedMarkdown : highlighted"
></div>
```

to:

```html
<div
  v-else
  ref="contentRef"
  class="preview-content"
  :class="{ 'markdown-rendered': renderMarkdown && isMarkdownFile }"
  v-html="renderMarkdown && isMarkdownFile ? renderedMarkdown : highlighted"
></div>
```

- [ ] **Step 2: Replace keydown handler with useLessScroll**

Add import:

```typescript
import { useLessScroll } from "../composables/useLessScroll";
```

Replace lines 147-174 (`function handleKeydown` through end of `onUnmounted`) with:

```typescript
useLessScroll(contentRef, {
  extraHandler(e) {
    const meta = e.metaKey || e.ctrlKey;
    // Cmd+O — open in IDE
    if (meta && e.key === "o") {
      e.preventDefault();
      openInIDE();
      return true;
    }
    // m — toggle markdown rendering
    if (
      e.key === "m" &&
      isMarkdownFile.value &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      renderMarkdown.value = !renderMarkdown.value;
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});

onMounted(() => loadFile());
```

Remove the `onUnmounted` call entirely (useLessScroll handles listener cleanup).

- [ ] **Step 3: Update mode badge tooltip**

In the template (line 183), change the tooltip from `"space"` to `"m"`:

```html
<span v-if="isMarkdownFile" class="mode-badge" @click="renderMarkdown = !renderMarkdown" title="m">
```

- [ ] **Step 4: Clean up unused imports**

Remove `onUnmounted` from the vue import if no other code uses it. The import should become:

```typescript
import { ref, computed, onMounted, watch } from "vue";
```

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/desktop && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/FilePreviewModal.vue
git commit -m "feat: add less-style scroll keys to FilePreviewModal, remap markdown toggle to m"
```

---

### Task 4: Manual smoke test

- [ ] **Step 1: Start dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Test DiffView keyboard nav**

1. Open a task with changes, press Cmd+D to open diff modal
2. Verify: `j`/`k` scroll one line, `f`/`Space`/PageDown scroll one page, `b`/PageUp scroll one page up
3. Verify: `d` half-page down, `u` half-page up, `g` top, `G` bottom
4. Verify: `Cmd+Shift+]` cycles scope forward, `Cmd+Shift+[` cycles backward
5. Verify: `q` closes the modal

- [ ] **Step 3: Test FilePreviewModal keyboard nav**

1. Open file picker (Cmd+P), select a file to preview
2. Verify same scroll keys work on the file content
3. If markdown file: verify `m` toggles rendered/raw view
4. Verify `Cmd+O` still opens in IDE
5. Verify `q` closes the modal
