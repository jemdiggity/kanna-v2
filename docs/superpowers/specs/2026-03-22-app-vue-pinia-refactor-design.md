# App.vue Pinia Store Refactor

## Problem

App.vue (~710 lines) acts as both the root component and the data layer. It holds the DB handle, runs raw SQL queries, threads `db: Ref<DbHandle | null>` into every composable, orchestrates all state transitions, and manages event listeners. The code is imperative rather than reactive — mutations call `refreshItems()` manually at 5+ sites, items are mutated in-place creating dual sources of truth, and pure derivations like `sortedItemsForCurrentRepo()` are functions instead of computed properties.

## Solution

Extract all persistent state and data logic into a single Pinia setup store (`useKannaStore`), use VueUse's `computedAsync` for reactive DB reads, and resolve the DB handle before app mount so the store never deals with null.

## Dependencies

Add to `apps/desktop/package.json`:
- `pinia`
- `@vueuse/core`

## New Files

### `apps/desktop/src/stores/kanna.ts`

Single Pinia setup store.

**State:**
- `db: DbHandle` — set via `init(db)`, stored as module-level variable (Pinia stores cannot use `inject()`). Never null after `init()`.
- `repos: Ref<Repo[]>` — via `computedAsync`, re-evaluates when `refreshKey` changes
- `items: Ref<PipelineItem[]>` — via `computedAsync`, re-evaluates when `refreshKey` changes and `repos` is non-empty
- `selectedRepoId: Ref<string | null>`
- `selectedItemId: Ref<string | null>`
- `suspendAfterMinutes`, `killAfterMinutes`, `ideCommand`, `gcAfterDays` — preferences loaded in `init()`
- `hideShortcutsOnStartup: Ref<boolean>` — loaded from settings in `init()`
- `refreshKey: Ref<number>` — bumped after every mutation to trigger async re-fetch

**Getters (computed):**
- `selectedRepo` — derived from `repos` + `selectedRepoId`
- `currentItem` — selected item if not stage "done"
- `sortedItemsForCurrentRepo` — pinned-first sort (replaces the imperative function)

**Actions:**

Lifecycle:
- `init(db: DbHandle)` — stores db as module-level variable, loads preferences (including `hideShortcutsOnStartup`), transitions stale "working" → "unread", runs GC on old done tasks, restores persisted selection from settings, sets up `hook_event` and `session_exit` event listeners, sets window title

User-triggered mutations (each bumps `refreshKey` at the end):
- `createItem(repoId, repoPath, prompt)` — creates worktree + DB record, spawns PTY session
- `closeTask()` — kills sessions, runs teardown scripts, marks done, selects next item
- `undoClose()` — restores last closed/hidden action: if last action was hideRepo, unhides it; if closeTask, finds last done item, restores to in_progress, respawns PTY
- `hideRepo(repoId)` — hides repo from sidebar, records undo action
- `pinItem(itemId, position)`, `unpinItem(itemId)`, `reorderPinned(repoId, orderedIds)`, `renameItem(itemId, displayName)`
- `startPrAgent(itemId, repoId, repoPath)`, `startMergeAgent(repoId, repoPath)` — spawn agent sessions
- `selectRepo(repoId)` — updates selection, persists to settings
- `selectItem(itemId)` — updates selection, persists to settings, marks unread → idle
- `savePreference(key, value)`
- `importRepo(path, name, defaultBranch)`

Note: `transition(itemId, toStage)` from usePipeline is dead code (exported but never imported) — dropped.

Event handlers (set up by `init()`, called by daemon event listeners):
- `handleHookEvent(payload)` — processes Stop/StopFailure/WaitingForInput/PostToolUse
- `handleSessionExit(payload)` — backup for when hooks don't fire

Both share a private `_handleAgentFinished(sessionId, item)` to deduplicate the Stop/exit logic.

### `apps/desktop/src/stores/db.ts` (optional helper)

If needed, a small module exporting the `loadDatabase()` and `runMigrations()` functions extracted from App.vue, used by `main.ts` during bootstrap.

## Modified Files

### `apps/desktop/src/main.ts`

New bootstrap flow:

```
1. Resolve DB handle async (Tauri SQL plugin or mock)
2. Run migrations
3. Run backupOnStartup(dbName)
4. Create Vue app
5. Install Pinia
6. app.mount('#app')
7. In App.vue onMounted: store.init(dbHandle), startPeriodicBackup(dbName, dbHandle)
```

Fatal error if DB load fails — render error message in DOM, do not mount.

The DB handle is passed to `store.init(db)` which stores it as a module-level variable. `startPeriodicBackup` is called from App.vue's `onMounted` since it needs the component lifecycle for cleanup.

### `apps/desktop/src/App.vue`

Shrinks from ~710 lines to ~200 lines. Retains:

- UI state refs: `showNewTaskModal`, `showDiffModal`, `showShellModal`, `zenMode`, `maximized`, etc.
- `keyboardActions` object wiring UI state toggling + store action calls
- `useKeyboardShortcuts(keyboardActions)` + `navigateItems(direction)` helper
- `focusAgentTerminal()` (DOM concern)
- `diffScopes` Map (per-session UI state, not persisted)
- `startPeriodicBackup` call in `onMounted`
- Template (mostly unchanged, but wrapper handlers removed — template binds store actions directly where possible)
- Styles (unchanged)

Removed from App.vue:
- `db` ref and all raw SQL queries
- `runMigrations()`
- All composable imports and calls (`useRepo`, `usePipeline`, `usePreferences`)
- `refreshItems()` and all call sites
- `sortedItemsForCurrentRepo()` function
- `handleSelectRepo`, `handleSelectItem`, `handleCloseTask`, `handlePinItem`, `handleUnpinItem`, `handleReorderPinned`, `handleRenameItem`, `handleImportRepo` — either moved to store or bound directly
- `@agent-completed="refreshItems"` template binding → replaced with `@agent-completed="store.bump"` (bumps `refreshKey`)
- Event listeners (`hook_event`, `session_exit`)
- GC logic, stale-activity transition, selection restore
- `onMounted` body (replaced with `await store.init()`)

## Deleted Files

- `apps/desktop/src/composables/useRepo.ts` — absorbed by store
- `apps/desktop/src/composables/usePipeline.ts` — absorbed by store
- `apps/desktop/src/composables/usePreferences.ts` — absorbed by store

## Unchanged Files

- `apps/desktop/src/composables/useTerminal.ts` — independent, no DB
- `apps/desktop/src/composables/useKeyboardShortcuts.ts` — independent, no DB
- `apps/desktop/src/composables/useBackup.ts` — independent, takes raw DbHandle
- `packages/db/` — all types and query helpers untouched
- `packages/core/` — untouched
- All other components — they receive data via props from App.vue, unchanged

## Error Handling

- All store action catch blocks log with `console.error` (no silent failures)
- Migration `ALTER TABLE ADD COLUMN` catches use `console.debug` (expected errors)
- DB load failure in `main.ts` is fatal — shows error in DOM, does not mount
- `alert()` calls kept for now (toast system is a separate concern)

## Testing

**Automated:**
- `bun test` — existing unit tests in `packages/core/` and `packages/db/` pass
- `bunx vue-tsc --noEmit` — type-checks the refactored code

**Manual smoke test:**
- App launches, sidebar shows repos/items
- Create a task, PTY session spawns
- Close a task, teardown + auto-select next
- Pin/unpin/rename items
- Keyboard shortcuts work
- All modals open/close
- Browser mode (non-Tauri) works with mock DB

No new tests — pure refactor, existing tests cover the DB layer.
