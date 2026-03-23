# Shortcut Menu Toggle Behavior

## Summary

Refine the `Cmd+/` and `Shift+Cmd+/` keyboard shortcuts so they form a symmetric toggle/switch state machine for the shortcuts modal.

## State Machine

| Current state      | `Cmd+/`              | `Shift+Cmd+/`       |
|--------------------|----------------------|----------------------|
| Closed             | Open contextual      | Open all             |
| Showing contextual | Close                | Switch to all        |
| Showing all        | Switch to contextual | Close                |

Context always falls back to `"main"` — there is no "no contextual menu" edge case.

## Changes

### `App.vue` — `showShortcuts` handler (Cmd+/)

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

### `App.vue` — `showAllShortcuts` handler (Shift+Cmd+/)

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

### `KeyboardShortcutsModal.vue` — sync footer toggle back to parent

The footer toggle link mutates local `showFullMode` but App.vue tracks mode via `shortcutsStartFull`. Without syncing, keyboard shortcuts after a footer click would see stale state and take the wrong action.

Add an `update:fullMode` emit so App.vue stays in sync:

```typescript
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:hide-on-startup", value: boolean): void;
  (e: "update:full-mode", value: boolean): void;
}>();
```

Update the footer toggle to emit:

```typescript
function toggleMode() {
  showFullMode.value = !showFullMode.value;
  emit("update:full-mode", showFullMode.value);
}
```

Template change — footer link uses `@click="toggleMode"` instead of inline `@click="showFullMode = !showFullMode"`.

### `App.vue` — handle `update:full-mode` on the modal

```html
<KeyboardShortcutsModal
  v-if="showShortcutsModal"
  :context="shortcutsContext"
  :start-in-full-mode="shortcutsStartFull"
  @close="showShortcutsModal = false"
  @update:full-mode="shortcutsStartFull = $event"
/>
```

### No other files changed

- `useKeyboardShortcuts.ts` — shortcut definitions unchanged
- `useShortcutContext.ts` — context system unchanged
