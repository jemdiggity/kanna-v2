# Repo Keyboard Navigation

## Summary

Add `⇧⌘↑` / `⇧⌘↓` shortcuts to jump between repos in the sidebar, restoring the last-selected task for each repo.

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `⇧⌘↑` | Jump to previous repo |
| `⇧⌘↓` | Jump to next repo |

These complement the existing `⌥⌘↑` / `⌥⌘↓` task navigation shortcuts.

## Behavior

1. **Repo order** follows the sidebar's visible (non-hidden) repo list.
2. **Last-selected task restoration**: when jumping to a repo, the task that was most recently selected in that repo is restored. If no prior selection exists, the first task in sidebar sort order is selected.
3. **Navigation history**: repo jumps are recorded in the global `useNavigationHistory` stack, so `Ctrl+-` / `Ctrl+Shift+-` (back/forward) works across repo jumps.
4. **Boundary clamping**: at the first or last repo, the shortcut is a no-op (no wrapping).

## State

- **`lastSelectedItemByRepo`**: a `Record<string, string>` map in the Pinia store, keyed by `repo_id`, valued by `item_id`. Updated on every `selectItem()` call. Session-level only (no DB persistence — resets on app restart).

## Changes

### `apps/desktop/src/stores/kanna.ts`
- Add `lastSelectedItemByRepo` ref (`Record<string, string>`)
- Update `selectItem()` to record `lastSelectedItemByRepo[item.repo_id] = itemId`
- Expose `lastSelectedItemByRepo` from the store

### `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Add two shortcut entries:
  - `{ action: "navigateRepoUp", key: "ArrowUp", meta: true, shift: true, display: "⇧⌘↑", context: ["main"] }`
  - `{ action: "navigateRepoDown", key: "ArrowDown", meta: true, shift: true, display: "⇧⌘↓", context: ["main"] }`

### `apps/desktop/src/App.vue`
- Add `navigateRepos(direction: -1 | 1)` function:
  1. Get visible repos list from store
  2. Find current repo index
  3. Compute next index (clamped)
  4. Look up `lastSelectedItemByRepo[nextRepo.id]`, validate the item still exists, belongs to that repo, and isn't tagged `done`
  5. Fall back to first task in `sortItemsForRepo(nextRepo.id)` if lookup fails validation
  6. Call `store.selectRepo()` + `store.selectItem()`
- Wire `navigateRepoUp` and `navigateRepoDown` actions to `navigateRepos(-1)` and `navigateRepos(1)`

### i18n
- Add label keys for the new shortcuts (e.g., `shortcuts.previousRepo`, `shortcuts.nextRepo`)
