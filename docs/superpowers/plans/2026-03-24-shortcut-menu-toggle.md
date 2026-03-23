# Shortcut Menu Toggle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cmd+/ and Shift+Cmd+/ form a symmetric toggle/switch state machine for the shortcuts modal.

**Architecture:** Two action handlers in App.vue get new branching logic based on `shortcutsStartFull`. The modal emits `update:full-mode` when its footer toggle is clicked so App.vue stays in sync.

**Tech Stack:** Vue 3, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-24-shortcut-menu-toggle-design.md`

---

### Task 1: Add `update:full-mode` emit to KeyboardShortcutsModal

**Files:**
- Modify: `apps/desktop/src/components/KeyboardShortcutsModal.vue:12-15` (emit declaration)
- Modify: `apps/desktop/src/components/KeyboardShortcutsModal.vue:75` (footer toggle click)

- [ ] **Step 1: Add `update:full-mode` to defineEmits**

In `apps/desktop/src/components/KeyboardShortcutsModal.vue`, change the emit declaration (line 12-15):

```typescript
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:hide-on-startup", value: boolean): void;
  (e: "update:full-mode", value: boolean): void;
}>();
```

- [ ] **Step 2: Add toggleMode function and update footer template**

Add a `toggleMode` function after `splitKeys`, before the closing `</script>` tag (before line 43):

```typescript
function toggleMode() {
  showFullMode.value = !showFullMode.value;
  emit("update:full-mode", showFullMode.value);
}
```

Update the footer toggle link in the template (line 75) from:

```html
<a class="toggle-link" @click="showFullMode = !showFullMode">
```

to:

```html
<a class="toggle-link" @click="toggleMode">
```

- [ ] **Step 3: Verify no TypeScript errors**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: No errors related to KeyboardShortcutsModal

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/KeyboardShortcutsModal.vue
git commit -m "feat: emit update:full-mode from shortcuts modal footer toggle"
```

---

### Task 2: Update App.vue shortcut handlers and template

**Files:**
- Modify: `apps/desktop/src/App.vue:311-331` (showShortcuts and showAllShortcuts handlers)
- Modify: `apps/desktop/src/App.vue:514-521` (KeyboardShortcutsModal template usage)

- [ ] **Step 1: Replace showShortcuts handler**

In `apps/desktop/src/App.vue`, replace the `showShortcuts` handler (lines 311-320):

```typescript
showShortcuts: () => {
  if (showShortcutsModal.value) {
    if (shortcutsStartFull.value) {
      // Showing all → switch to contextual
      shortcutsStartFull.value = false;
    } else {
      // Showing contextual → close
      showShortcutsModal.value = false;
    }
    return;
  }
  showCommandPalette.value = false;
  shortcutsContext.value = activeContext.value;
  shortcutsStartFull.value = false;
  showShortcutsModal.value = true;
},
```

- [ ] **Step 2: Replace showAllShortcuts handler**

Replace the `showAllShortcuts` handler (lines 321-331):

```typescript
showAllShortcuts: () => {
  if (showShortcutsModal.value) {
    if (!shortcutsStartFull.value) {
      // Showing contextual → switch to all
      shortcutsStartFull.value = true;
    } else {
      // Showing all → close
      showShortcutsModal.value = false;
    }
    return;
  }
  showCommandPalette.value = false;
  shortcutsContext.value = activeContext.value;
  shortcutsStartFull.value = true;
  showShortcutsModal.value = true;
},
```

- [ ] **Step 3: Add @update:full-mode to template**

In the `<KeyboardShortcutsModal>` usage (lines 514-521), add the event handler:

```html
<KeyboardShortcutsModal
  v-if="showShortcutsModal"
  :context="shortcutsContext"
  :start-in-full-mode="shortcutsStartFull"
  :hide-on-startup="store.hideShortcutsOnStartup"
  @close="showShortcutsModal = false"
  @update:hide-on-startup="(val: boolean) => store.savePreference('hideShortcutsOnStartup', String(val))"
  @update:full-mode="shortcutsStartFull = $event"
/>
```

- [ ] **Step 4: Verify no TypeScript errors**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: symmetric toggle/switch for shortcut menu shortcuts"
```

---

### Task 3: Manual smoke test

- [ ] **Step 1: Start the dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Verify the state machine**

Test each transition:

| Test | Action | Expected |
|------|--------|----------|
| 1 | Press `Cmd+/` from closed | Contextual menu opens |
| 2 | Press `Cmd+/` again | Menu closes |
| 3 | Press `Shift+Cmd+/` from closed | All shortcuts menu opens |
| 4 | Press `Shift+Cmd+/` again | Menu closes |
| 5 | Press `Cmd+/` to open contextual, then `Shift+Cmd+/` | Switches to all |
| 6 | Press `Shift+Cmd+/` to open all, then `Cmd+/` | Switches to contextual |
| 7 | Open contextual, click footer "Show all shortcuts" link, press `Shift+Cmd+/` | Menu closes (footer synced state) |
| 8 | Open all, click footer "Show main shortcuts" link, press `Cmd+/` | Menu closes (footer synced state) |
