# Task Navigation History — Design Spec

## Motivation

Kanna supports keyboard-driven task navigation (⌥⌘↑/↓ for next/prev), but there's no way to retrace your steps through previously visited tasks. VS Code solves this with Ctrl+- (back) and Ctrl+Shift+- (forward). Kanna should do the same for task-to-task navigation.

## Requirements

- `Ctrl+-` navigates back to the previously viewed task
- `Ctrl+Shift+-` navigates forward after going back
- History tracks task selections only (not modals or views)
- In-memory only — resets on app quit
- Duplicate consecutive entries suppressed (re-selecting the same task is a no-op for history)
- Bounded stack size (50 entries) to prevent unbounded growth
- No UI beyond the keyboard shortcuts (they appear in the shortcuts help modal)

## Approach

New Vue composable (`useNavigationHistory`) that maintains back/forward stacks of task IDs. Integrates with the existing keyboard shortcut system in `useKeyboardShortcuts.ts` and the task selection handler in `App.vue`.

## Design

### Navigation History Composable

New file: `apps/desktop/src/composables/useNavigationHistory.ts`

Maintains two arrays used as stacks:

- **`backStack: string[]`** — task IDs navigated away from
- **`forwardStack: string[]`** — task IDs available to go forward to (populated by going back)

Exports:

- **`recordNavigation(taskId: string)`** — called when the user navigates to a task (click, next/prev shortcut). Pushes the *previous* task ID onto `backStack`, clears `forwardStack`. Suppresses duplicate consecutive entries. Caps `backStack` at 50 entries (drops oldest).
- **`goBack(): string | null`** — pops `backStack`, pushes current task onto `forwardStack`, returns the task ID to navigate to. Returns `null` if `backStack` is empty.
- **`goForward(): string | null`** — pops `forwardStack`, pushes current task onto `backStack`, returns the task ID to navigate to. Returns `null` if `forwardStack` is empty.
- **`canGoBack: ComputedRef<boolean>`** — reactive flag for whether back navigation is available.
- **`canGoForward: ComputedRef<boolean>`** — reactive flag for whether forward navigation is available.

The composable needs to know the current task ID to push it onto the opposite stack during back/forward. It accepts a `Ref<string | null>` for `selectedItemId` (or the current ID is passed as an argument to `goBack`/`goForward`).

**Stack behavior:**

| Action | backStack | forwardStack |
|--------|-----------|--------------|
| Select task B (was on A) | push A | clear |
| Select task C (was on B) | push B | clear |
| Go back (on C) | pop B | push C |
| Go back (on B) | pop A | push B |
| Go forward (on A) | push A | pop B |
| Select task D (on B) | push B | clear |

### Keyboard Shortcut Changes

The existing `ShortcutDef` interface only has `meta`, `shift`, and `alt` modifier fields. Since VS Code uses the Control key (not Command) for back/forward on macOS, the interface and matcher need a new `ctrl` field.

**Changes to `useKeyboardShortcuts.ts`:**

1. **Extend `ActionName` union** — add `goBack` and `goForward`:
   ```ts
   export type ActionName =
     | "newTask"
     // ... existing ...
     | "goBack"
     | "goForward";
   ```

2. **Add `ctrl` field to `ShortcutDef`:**
   ```ts
   interface ShortcutDef {
     // ... existing fields ...
     ctrl?: boolean;
   }
   ```

3. **Update `matches()` function** — add `ctrlKey` check:
   ```ts
   if (e.ctrlKey !== (def.ctrl ?? false)) return false;
   ```
   This also fixes `isAppShortcut()` (used by terminal passthrough) since it delegates to `matches()`.

4. **Add shortcut entries** in the Navigation section:
   ```ts
   { action: "goBack",    label: "Go Back",    group: "Navigation", key: "-", ctrl: true,               display: "⌃-" },
   { action: "goForward", label: "Go Forward", group: "Navigation", key: "-", ctrl: true, shift: true,  display: "⌃⇧-" },
   ```

**Note on WKWebView key capture:** `Ctrl+-` may conflict with macOS zoom shortcuts in WKWebView. If the key event is swallowed before reaching JavaScript, an alternative binding (e.g., `Ctrl+[` / `Ctrl+]`) may be needed. This should be verified at implementation time.

### App.vue Integration

1. **Initialize the composable** alongside existing composables:
   ```ts
   const { recordNavigation, goBack, goForward } = useNavigationHistory()
   ```

2. **Record history on task selection** — in `handleSelectItem()`, before updating `selectedItemId`, call `recordNavigation(selectedItemId.value)` (only if the current value is non-null and differs from the new one).

3. **Record history on next/prev task** — `navigateItems()` sets `selectedItemId.value` directly without calling `handleSelectItem`. It must also call `recordNavigation(selectedItemId.value)` before the assignment so that up/down keyboard navigation is tracked in history.

4. **Wire shortcut actions** — add to the `keyboardActions` map:
   ```ts
   goBack: () => {
     const taskId = goBack(selectedItemId.value)
     if (taskId) navigateToTask(taskId)
   },
   goForward: () => {
     const taskId = goForward(selectedItemId.value)
     if (taskId) navigateToTask(taskId)
   },
   ```

5. **Add a `navigateToTask` helper** — updates `selectedItemId`, persists to settings DB, and clears the unread activity indicator (same as `handleSelectItem`), but does *not* call `recordNavigation`. This prevents back/forward from creating circular history entries.

### Edge Cases

- **Task deleted while in history:** If `goBack`/`goForward` returns a task ID that no longer exists in the pipeline, skip it and try the next entry. This handles tasks that were closed or removed.
- **No current task:** If `selectedItemId` is null when navigating, don't push null onto any stack.
- **App startup:** History starts empty. The initially loaded task (restored from settings DB) is not a navigation event.

## Files Changed

| File | Change |
|------|--------|
| `apps/desktop/src/composables/useNavigationHistory.ts` | New composable |
| `apps/desktop/src/composables/useKeyboardShortcuts.ts` | Add `ctrl` to `ShortcutDef`, update `matches()`, extend `ActionName`, add two shortcut entries |
| `apps/desktop/src/App.vue` | Initialize composable, wire actions, add `navigateToTask` helper, update `navigateItems` to record history |

## Testing

- Unit test the composable: verify stack behavior for sequences of record/back/forward calls, duplicate suppression, cap enforcement, and deleted-task skipping.
