# Task Fuzzy Search

Replace the "Add Repo" button in the sidebar footer with a persistent search input that fuzzy-filters tasks by title, branch name, or prompt.

## Changes

### 1. Sidebar Footer

- Remove the "Add Repo" button and `add-repo` emit from `Sidebar.vue`
- Replace with a native `<input>` element bound to a local `searchQuery` ref (must be a native input, not a wrapper component, so `preventFocusSteal`'s `instanceof HTMLInputElement` check passes)
- Placeholder: "Search tasks..." with `⌘F` hint
- `Escape` clears the query and blurs the input
- Repo creation remains available via `⌘I` / `⇧⌘I`

### 2. Fuzzy Matching

- Reuse `fuzzyMatch()` from `utils/fuzzyMatch.ts` (already used by the file picker)
- For each `PipelineItem`, match the query against four fields: `display_name`, `issue_title`, `prompt`, `branch`
- An item passes the filter if any field produces a non-null `fuzzyMatch` result
- Items that don't match are excluded from the sidebar
- Repos with zero matching items hide entirely (header + list)
- Within each category group (pinned, merge, PR, in-progress, blocked), matched items keep their existing sort order (no re-ranking by score)
- When the query is cleared, the full sidebar restores immediately

**Filtering is display-only.** The `pipelineItems` prop stays unfiltered. Computed refs inside Sidebar derive filtered lists for rendering. Drag/drop and pin logic operate on the full unfiltered prop and are unaffected.

**Collapse behavior:** When a search query is active, collapsed repos auto-expand to show results. When the query is cleared, collapse state restores to what it was before.

**Repo count badge:** Shows the filtered count when a search is active, total count otherwise.

### 3. Keyboard Shortcut

- Add `"focusSearch"` to the `ActionName` union in `useKeyboardShortcuts.ts`
- Add a `ShortcutDef` entry: `action: "focusSearch"`, `labelKey: "shortcuts.focusSearch"`, `groupKey: "shortcuts.groupNavigation"`, `key: "f"`, `meta: true`, `display: "⌘F"`, `context: ["main"]`
- In App.vue's `keyboardActions`, add a `focusSearch` handler that calls `sidebarRef.value?.focusSearch()`
- Sidebar updates `defineExpose` to include both `renameSelectedItem` and `focusSearch` (merge, not replace)
- Note: `⌘F` overrides native WKWebView "Find in page" — existing `preventDefault` in the shortcuts system handles this

### 4. Parent Cleanup

- Remove **only** the `@add-repo` attribute from `<Sidebar>` in App.vue
- **Preserve** `addRepoInitialTab`, `createRepo`, and `importRepo` keyboard actions — these are independent of the sidebar button and remain the primary way to open the Add Repo modal
- Remove the `add-repo` emit definition from Sidebar's `defineEmits`

### 5. i18n

All three locale files (`en.json`, `ja.json`, `ko.json`):
- Add `sidebar.searchPlaceholder` — search input placeholder text
- Add `shortcuts.focusSearch` — shortcut display label
- Remove `sidebar.addRepo` and `sidebar.addRepoTooltip`

## Files Modified

- `apps/desktop/src/components/Sidebar.vue` — replace footer, add search filtering, update defineExpose
- `apps/desktop/src/composables/useKeyboardShortcuts.ts` — add `focusSearch` action and shortcut def
- `apps/desktop/src/App.vue` — remove `@add-repo`, add `focusSearch` keyboard action handler
- `apps/desktop/src/i18n/locales/en.json` — add search + shortcut keys, remove addRepo keys
- `apps/desktop/src/i18n/locales/ja.json` — same
- `apps/desktop/src/i18n/locales/ko.json` — same

## Non-Goals

- No match highlighting in the sidebar (items are already truncated to 40 chars)
- No re-ranking by score within categories
- No search across closed/done tasks
- No new dependencies
