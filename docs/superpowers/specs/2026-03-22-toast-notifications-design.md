# Toast Notifications for Errors & Warnings

## Summary

Add a lightweight toast notification system to surface errors and warnings that currently either show as `alert()` dialogs or silently log to `console.error`. No third-party dependencies — a custom composable and component matching Kanna's existing patterns.

## Requirements

- **Types:** Errors and warnings only. No success/info toasts.
- **Position:** Top-right corner, fixed.
- **Auto-dismiss:** Warnings at 3s, errors at 5s. Both auto-dismiss.
- **Stacking:** Max 3 visible, newest on top. When a 4th arrives, the oldest is evicted immediately (no queue).
- **z-index:** 1200 (above modals at 1000 and KeyboardShortcutsModal at 1100).

## Composable: `useToast()`

Location: `apps/desktop/src/composables/useToast.ts`

Singleton composable using module-level reactive state. No Vue `provide`/`inject` — works anywhere, including the Pinia store.

### API

```ts
const { warning, error } = useToast()

warning('Worktree already exists')   // auto-dismiss 3s
error('Daemon connection failed')     // auto-dismiss 5s
```

### Internal State

```ts
interface Toast {
  id: number
  type: 'warning' | 'error'
  message: string
}
```

- Module-scoped `ref<Toast[]>` — max 3 entries.
- Dismiss timers stored in a separate `Map<number, ReturnType<typeof setTimeout>>` outside the reactive array (avoids devtools/serialization issues with timer handles in reactive state).
- Each toast gets a unique auto-incrementing ID.
- `warning()` and `error()` push a toast, set a dismiss timer in the map, and evict the oldest if over the limit.
- `dismiss(id)` clears the timer from the map and removes the toast from the array.

## Component: `<ToastContainer />`

Location: `apps/desktop/src/components/ToastContainer.vue`

Rendered once in `App.vue` at the root, outside the flex layout.

### Rendering

- Fixed position: `top: 12px; right: 12px`.
- Toasts stack vertically with 8px gap, newest on top.
- Container uses `display: flex; flex-direction: column-reverse` so new toasts append to the array but render on top. This avoids `TransitionGroup` `v-move` conflicts (no reordering happens, so no move transitions fire).
- Each toast: left color accent border + message text + dismiss X button.
- Vue `<TransitionGroup>` for slide-in-from-right / fade-out animations. No `v-move` class needed.

### Styling

Matches Kanna's dark theme design tokens:

| Element | Warning | Error |
|---------|---------|-------|
| Left border | `#e3b341` (amber) | `#f85149` (red) |
| Background | `#2a2a1a` | `#2a1a1a` |
| Text | `#e0e0e0` | `#e0e0e0` |

- Border-radius: 4px
- Shadow: `0 4px 12px rgba(0, 0, 0, 0.4)`
- Dismiss button: `#888` text, no background
- Font: system font stack (`-apple-system, BlinkMacSystemFont, ...`)
- Max width: ~360px, text truncated with ellipsis for long messages

### Keyboard

No keyboard shortcuts for toast dismissal. Escape is reserved for modals.

## Integration

### Phase 1: Replace `alert()` calls

Three `alert()` calls in `App.vue` and one in `kanna.ts`:
- `App.vue:157` — `editBlockedTask` failure in `onBlockerConfirm` → `error(...)`
- `App.vue:276` — "Select a repository first" → `warning('Select a repository first')`
- `App.vue:287` — Task creation failure → `error('Task creation failed: ...')`
- `kanna.ts:506` — "Select a repository first" in `mergeQueue()` → `warning('Select a repository first')`

### Phase 2: Surface critical silent failures from `kanna.ts`

Add `useToast()` calls alongside existing `console.error` in catch blocks for:
- Daemon connection/spawn failures
- Git operations (checkout, branch creation, worktree)
- Task/pipeline CRUD failures (create, update, delete, stage transitions)
- GitHub API failures (PR creation, label sync)

`console.error` calls remain in place for debugging. Toast calls are additive.

### How the store calls it

```ts
// In kanna.ts
import { useToast } from '../composables/useToast'

// In a catch block:
const { error } = useToast()
error(`Task creation failed: ${e?.message || e}`)
```

Works because the composable uses module-level state, not `provide`/`inject`.

## Out of Scope

- Success/info toasts
- Notification history or log panel
- Toast deduplication or count badges
- Configurable durations per-call
- Sound or system notifications
