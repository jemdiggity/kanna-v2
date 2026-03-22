# Toast Notifications Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toast notification system for errors and warnings, replacing `alert()` calls and surfacing critical silent failures.

**Architecture:** Module-level singleton composable (`useToast`) with a `ToastContainer` component rendered at the App.vue root. No third-party dependencies.

**Tech Stack:** Vue 3, TypeScript, scoped CSS, `<TransitionGroup>`

**Spec:** `docs/superpowers/specs/2026-03-22-toast-notifications-design.md`

---

### Task 1: Create `useToast` composable

**Files:**
- Create: `apps/desktop/src/composables/useToast.ts`

- [ ] **Step 1: Create the composable**

```ts
import { ref } from 'vue'

export interface Toast {
  id: number
  type: 'warning' | 'error'
  message: string
}

const MAX_VISIBLE = 3
const DURATIONS = { warning: 3000, error: 5000 } as const

const toasts = ref<Toast[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 0

function dismiss(id: number) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx !== -1) toasts.value.splice(idx, 1)
}

function add(type: Toast['type'], message: string) {
  const id = nextId++
  const toast: Toast = { id, type, message }

  // Evict oldest if at capacity
  while (toasts.value.length >= MAX_VISIBLE) {
    dismiss(toasts.value[0].id)
  }

  toasts.value.push(toast)
  timers.set(id, setTimeout(() => dismiss(id), DURATIONS[type]))
}

export function useToast() {
  return {
    toasts,
    dismiss,
    warning: (message: string) => add('warning', message),
    error: (message: string) => add('error', message),
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd apps/desktop && bunx vue-tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors referencing `useToast.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useToast.ts
git commit -m "feat: add useToast composable for error/warning notifications"
```

---

### Task 2: Create `ToastContainer` component

**Files:**
- Create: `apps/desktop/src/components/ToastContainer.vue`

- [ ] **Step 1: Create the component**

```vue
<script setup lang="ts">
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="toast-container" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :class="toast.type"
        role="alert"
      >
        <span class="toast-message">{{ toast.message }}</span>
        <button class="toast-dismiss" @click="dismiss(toast.id)" aria-label="Dismiss">&times;</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  padding: 8px 12px;
  border-radius: 4px;
  border-left: 3px solid;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  color: #e0e0e0;
  font-size: 13px;
  pointer-events: auto;
}

.toast.warning {
  background: #2a2a1a;
  border-left-color: #e3b341;
}

.toast.error {
  background: #2a1a1a;
  border-left-color: #f85149;
}

.toast-message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-dismiss {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

.toast-dismiss:hover {
  color: #e0e0e0;
}

/* Transitions */
.toast-enter-active {
  transition: all 0.3s ease;
}

.toast-leave-active {
  transition: all 0.2s ease;
  position: absolute;
  right: 0;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
}
</style>
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd apps/desktop && bunx vue-tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors referencing `ToastContainer.vue`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/ToastContainer.vue
git commit -m "feat: add ToastContainer component"
```

---

### Task 3: Mount `ToastContainer` in App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Add import**

In `App.vue`, add import after the existing component imports (after the `BlockerSelectModal` import, around line 19):

```ts
import ToastContainer from "./components/ToastContainer.vue";
```

- [ ] **Step 2: Add component to template**

In the template, add `<ToastContainer />` as the last child inside `<div class="app">`, after the `BlockerSelectModal`:

```vue
    </BlockerSelectModal>
    <ToastContainer />
  </div>
</template>
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/desktop && bunx vue-tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: mount ToastContainer in App.vue"
```

---

### Task 4: Replace `alert()` calls in App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue` (find `alert(` calls by content, not line number — lines shift after Task 3's import)

- [ ] **Step 1: Add useToast import**

In `App.vue` `<script setup>`, add after the existing composable imports:

```ts
import { useToast } from "./composables/useToast";

const toast = useToast();
```

- [ ] **Step 2: Replace alert in `onBlockerConfirm` catch block**

Replace:
```ts
alert(e.message);
```

With:
```ts
toast.error(e.message);
```

- [ ] **Step 3: Replace alert in `handleNewTaskSubmit` repo guard**

Replace:
```ts
alert("Select a repository first");
```

With:
```ts
toast.warning("Select a repository first");
```

- [ ] **Step 4: Replace alert in `handleNewTaskSubmit` catch block**

Replace:
```ts
alert(`Task creation failed: ${e?.message || e}`);
```

With:
```ts
toast.error(`Task creation failed: ${e?.message || e}`);
```

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/desktop && bunx vue-tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors

- [ ] **Step 6: Verify no alert() calls remain in App.vue**

Run: `grep -n 'alert(' apps/desktop/src/App.vue`
Expected: no matches

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "fix: replace alert() calls with toast notifications in App.vue"
```

---

### Task 5: Replace `alert()` in kanna.ts and surface critical failures

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:179,209,351,378,488,506,515,582,716`

- [ ] **Step 1: Add useToast import**

In `kanna.ts`, add import at the top with other imports:

```ts
import { useToast } from '../composables/useToast'
```

- [ ] **Step 2: Replace alert at line 506**

In `mergeQueue()`, replace:
```ts
alert("Select a repository first");
```

With:
```ts
const { warning } = useToast()
warning("Select a repository first");
```

- [ ] **Step 3: Add toasts to critical failure catch blocks**

Add a toast call alongside each existing `console.error` for these user-facing operations. The `console.error` stays — the toast is additive.

**Note:** The spec mentions daemon connection and GitHub API failures, but those error paths live outside `kanna.ts` (daemon connection is in Rust, GitHub API is in `packages/core`). They are deferred to a follow-up.

**Line 179 — worktree creation failure (`createItem`):**
```ts
console.error("[store] git_worktree_add failed:", e);
useToast().error("Failed to create worktree");
```

**Line 209 — DB insert failure (`createItem`):**
```ts
console.error("[store] DB insert failed:", e);
useToast().error("Failed to save task to database");
```

**Line 351 — close task failure:**
```ts
console.error("[store] close failed:", e);
useToast().error("Failed to close task");
```

**Line 378 — undo close failure:**
```ts
console.error("[store] undo close failed:", e);
useToast().error("Failed to undo close");
```

**Line 488 — PR agent failure:**
```ts
console.error("[store] PR agent failed to start:", e);
useToast().error("Failed to start PR agent");
```

**Line 515 — merge agent failure:**
```ts
console.error("[store] merge agent failed to start:", e);
useToast().error("Failed to start merge agent");
```

**Line 582 — blocked task worktree failure:**
```ts
console.error("[store] startBlockedTask worktree_add failed:", e);
useToast().error("Failed to create worktree for blocked task");
```

**Line 716 — block task close failure:**
```ts
console.error("[store] blockTask close failed:", e);
useToast().error("Failed to block task");
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/desktop && bunx vue-tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors

- [ ] **Step 5: Verify no alert() calls remain in kanna.ts**

Run: `grep -n 'alert(' apps/desktop/src/stores/kanna.ts`
Expected: no matches

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "fix: replace alert() and add toast notifications for critical store failures"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Start the dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Verify toasts render**

Open the app. Trigger a toast by attempting to create a task without a repo selected (should show a warning toast top-right that auto-dismisses in 3s).

- [ ] **Step 3: Verify stacking**

Open browser console and run:
```js
// Access the composable from the console
const { useToast } = await import('/src/composables/useToast.ts')
const t = useToast()
t.error('Error 1'); t.error('Error 2'); t.warning('Warning 1'); t.error('Error 4 — should evict Error 1')
```
Verify: max 3 visible, oldest evicted when 4th arrives.

- [ ] **Step 4: Verify dismiss button works**

Click the X button on a toast — it should disappear immediately.

- [ ] **Step 5: Verify toasts appear above modals**

Open any modal (Cmd+K for command palette). Trigger a toast from console. Toast should appear above the modal overlay.
