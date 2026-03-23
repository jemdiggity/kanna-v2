# i18n Implementation Plan

## Goal

Add internationalization (English, Japanese, Korean) to Kanna's Vue frontend. All user-facing strings migrate from hardcoded English to `vue-i18n` translation keys. Locale persists in SQLite and switches reactively without restart.

## Spec

[docs/superpowers/specs/2026-03-23-i18n-design.md](../specs/2026-03-23-i18n-design.md)

## Key Decisions

- **vue-i18n v10** in Composition API mode (`legacy: false`)
- **Eager loading** — all 3 locale JSON files imported statically (small enough, no lazy loading needed)
- **labelKey/groupKey pattern** for keyboard shortcuts — translation keys stored in module-level arrays, resolved via `t()` at render time
- **i18n.global.t** for Pinia store strings (stores can't use `useI18n()`)
- **No interpolation/pluralization** — all strings are static (error messages include raw error text via template literals, which is fine)
- **macOS font fallback** handles CJK rendering — no font stack changes needed

## Research Findings

The spec's `en.json` covers ~60 strings but the codebase has **~180+ user-facing strings** across 20 components, 2 composables, and 2 stores. The plan below includes the complete set, organized into the following additional domains beyond the spec:

| Domain | Source |
|--------|--------|
| `tags.*` | TagBadges.vue |
| `analytics.*` | AnalyticsModal.vue |
| `agentView.*` | AgentView.vue |
| `addRepo.*` | AddRepoModal.vue |
| `diffView.*` | DiffView.vue |
| `filePicker.*` | FilePickerModal.vue |
| `filePreview.*` | FilePreviewModal.vue |
| `mainPanel.*` | MainPanel.vue |
| `blockerSelect.*` | BlockerSelectModal.vue |
| `commandPalette.*` | CommandPaletteModal.vue |
| `terminalTabs.*` | TerminalTabs.vue |
| `taskHeader.*` | TaskHeader.vue |
| `common.*` | Shared strings (Loading, Untitled) |
| `toasts.*` (expanded) | kanna.ts + App.vue |

---

## Batch 1 — Infrastructure

**Goal:** Install vue-i18n, create the i18n plugin, locale files, and register the plugin. No component changes — pure additive.

**Review checkpoint:** Confirm the app builds and boots with the i18n plugin registered. `$t` and `useI18n()` are available in components.

### Task 1.1 — Install vue-i18n

**File:** `apps/desktop/package.json`

```bash
cd apps/desktop && bun add vue-i18n
```

### Task 1.2 — Create i18n plugin setup

**New file:** `apps/desktop/src/i18n/index.ts`

```typescript
import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en, ja, ko }
})

export default i18n
```

### Task 1.3 — Create en.json with ALL strings

**New file:** `apps/desktop/src/i18n/locales/en.json`

Must include every domain listed above. The complete key structure:

```
tasks.newTask, tasks.makePR, tasks.mergeQueue, tasks.closeTask, tasks.undoClose,
tasks.blockTask, tasks.editBlockedTask, tasks.descriptionPlaceholder, tasks.untitled

actions.create, actions.cancel, actions.done, actions.delete, actions.close,
actions.edit, actions.submit, actions.dismiss

preferences.title, preferences.language, preferences.suspendAfter, preferences.killAfter,
preferences.ideCommand, preferences.idePlaceholder, preferences.gcAfterDays

shortcuts.title, shortcuts.showOnStartup, shortcuts.showAll, shortcuts.showContext,
shortcuts.groupTasks, shortcuts.groupNavigation, shortcuts.groupViews, shortcuts.groupHelp,
shortcuts.newTask, shortcuts.makePR, shortcuts.mergeQueue, shortcuts.closeReject,
shortcuts.undoClose, shortcuts.previousTask, shortcuts.nextTask, shortcuts.filePicker,
shortcuts.commandPalette, shortcuts.viewDiff, shortcuts.shellTerminal, shortcuts.openInIDE,
shortcuts.zenMode, shortcuts.maximize, shortcuts.toggleSidebar, shortcuts.analytics,
shortcuts.createRepo, shortcuts.importClone, shortcuts.goBack, shortcuts.goForward,
shortcuts.keyboardShortcuts, shortcuts.dismiss

shortcutContexts.main, shortcutContexts.diff, shortcutContexts.file, shortcutContexts.shell

sidebar.addRepo, sidebar.addRepoTooltip, sidebar.noTasks, sidebar.noReposYet,
sidebar.noReposHint, sidebar.newTaskTooltip, sidebar.removeRepoTooltip,
sidebar.sectionMergeQueue, sidebar.sectionPullRequests, sidebar.sectionInProgress,
sidebar.sectionBlocked, sidebar.blockedBy

modals.selectRepo, modals.chooseDirectory, modals.chooseCloneDirectory, modals.submitHint

toasts.taskCreationFailed, toasts.prCreationFailed, toasts.repoCreationFailed,
toasts.cloneFailed, toasts.worktreeFailed, toasts.dbInsertFailed,
toasts.closeTaskFailed, toasts.undoCloseFailed, toasts.prAgentFailed,
toasts.closeSourceTaskFailed, toasts.mergeAgentFailed, toasts.blockedWorktreeFailed,
toasts.blockTaskFailed, toasts.selectRepoFirst

tags.inProgress, tags.pr, tags.merge, tags.done, tags.blocked

analytics.viewTasks, analytics.viewAvgTime, analytics.viewOperator,
analytics.hint, analytics.noTasks, analytics.labelCreated, analytics.labelClosed,
analytics.labelOpen, analytics.activityTrackingStarted, analytics.avgBusy,
analytics.avgUnread, analytics.avgIdle, analytics.busy, analytics.unread, analytics.idle,
analytics.operatorTrackingStarted, analytics.avgResponseTime, analytics.avgDwellTime,
analytics.switchesPerHour, analytics.focusScore

agentView.thinking, agentView.working, agentView.completed, agentView.error,
agentView.turns, agentView.running

addRepo.tabCreate, addRepo.tabImport, addRepo.namePlaceholder, addRepo.change,
addRepo.importPlaceholder, addRepo.chooseLocalFolder, addRepo.detecting,
addRepo.gitRepoConfirmed, addRepo.notAGitRepo, addRepo.repoNamePlaceholder,
addRepo.cloning, addRepo.import, addRepo.or

diffView.scopeBranch, diffView.scopeLastCommit, diffView.scopeWorking, diffView.noChanges,
diffView.shortcutScopeNext, diffView.shortcutScopePrev, diffView.shortcutLineUpDown,
diffView.shortcutPageUpDown, diffView.shortcutHalfUpDown, diffView.shortcutTopBottom,
diffView.shortcutClose

filePicker.placeholder, filePicker.noFiles

filePreview.rendered, filePreview.raw, filePreview.openInIDE,
filePreview.shortcutOpenIDE, filePreview.shortcutToggleMarkdown,
filePreview.shortcutLineUpDown, filePreview.shortcutPageUpDown,
filePreview.shortcutHalfUpDown, filePreview.shortcutTopBottom,
filePreview.shortcutClose

mainPanel.taskBlocked, mainPanel.taskBlockedHint, mainPanel.waitingOn,
mainPanel.blockerDone, mainPanel.blockerActive, mainPanel.noReposTitle,
mainPanel.noReposHint, mainPanel.noTaskSelected, mainPanel.noTaskHint

blockerSelect.searchPlaceholder, blockerSelect.circularDep,
blockerSelect.statusBlocked, blockerSelect.statusActive,
blockerSelect.noMatchingTasks, blockerSelect.hintEmpty, blockerSelect.hintSelected

commandPalette.placeholder, commandPalette.noCommands

terminalTabs.noSession

taskHeader.branchLabel, taskHeader.prPrefix

common.loading

app.selectRepoFirst, app.customTaskLaunchFailed, app.customTaskCreationFailed,
app.newCustomTask, app.newCustomTaskDesc, app.selectBlockingTasks, app.editBlockingTasks
```

### Task 1.4 — Create ja.json and ko.json

**New files:** `apps/desktop/src/i18n/locales/ja.json`, `apps/desktop/src/i18n/locales/ko.json`

Identical key structure to en.json with translated values. Missing keys fall back to English.

### Task 1.5 — Register i18n plugin in main.ts

**File:** `apps/desktop/src/main.ts` (line 40-43)

Add `import i18n from './i18n'` and `app.use(i18n)` between Pinia registration and the `provide` calls.

### Task 1.6 — Add locale default setting in migrations

**File:** `apps/desktop/src/stores/db.ts` (after line 88)

Add: `await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('locale', 'en')")`

**Verification:** `bun tsc --noEmit` passes. Dev server starts. Console shows no vue-i18n errors.

---

## Batch 2 — Keyboard Shortcuts Refactor

**Goal:** Convert the module-level shortcuts system from hardcoded strings to translation keys. This is the most architecturally complex change.

**Review checkpoint:** Keyboard shortcuts modal renders correctly with English strings resolved from translation keys.

### Task 2.1 — Refactor useKeyboardShortcuts.ts

**File:** `apps/desktop/src/composables/useKeyboardShortcuts.ts`

Changes:
1. Rename `label` → `labelKey` and `group` → `groupKey` in the `ShortcutDef` interface (lines 33-49)
2. Update all entries in the `shortcuts` array (lines 55-85) to use translation keys:
   - `label: "New Task"` → `labelKey: "shortcuts.newTask"`
   - `group: "Tasks"` → `groupKey: "shortcuts.groupTasks"`
   - etc.
3. Change `groupOrder` (line 109) from `["Tasks", "Navigation", "Views", "Help"]` to `["shortcuts.groupTasks", "shortcuts.groupNavigation", "shortcuts.groupViews", "shortcuts.groupHelp"]`
4. Refactor `getShortcutGroups()` to accept a `t: (key: string) => string` parameter and resolve keys via `t()`
5. Update any other consumers of `label`/`group` fields

**Critical:** `isAppShortcut()` must NOT be affected — it only checks key bindings, not labels.

### Task 2.2 — Refactor useShortcutContext.ts

**File:** `apps/desktop/src/composables/useShortcutContext.ts`

Changes:
1. `getContextTitle()` (lines 96-104): Replace hardcoded titles with translation key lookup. Accept `t` parameter.
2. Update `getContextShortcuts()` if it embeds user-facing labels — the context shortcut labels registered in DiffView.vue and FilePreviewModal.vue also need translation keys.
3. `registerContextShortcuts()` callers pass `labelKey` instead of `label` string.

### Task 2.3 — Update KeyboardShortcutsModal.vue

**File:** `apps/desktop/src/components/KeyboardShortcutsModal.vue`

Changes:
1. Add `const { t } = useI18n()`
2. Change `getShortcutGroups()` call (line 23) to `computed(() => getShortcutGroups(t))`
3. Change `contextTitle` (line 21) to use refactored `getContextTitle(t, ...)`
4. Replace hardcoded template strings:
   - `'Keyboard Shortcuts'` (line 55) → `t('shortcuts.title')`
   - `'Show all shortcuts'` (line 83) → `t('shortcuts.showAll')`
   - `'Show ${contextTitle}'` → `t('shortcuts.showContext')` or keep interpolated
   - `"Don't show on startup"` (line 88) → `{{ $t('shortcuts.showOnStartup') }}`

**Verification:** Shortcuts modal opens in both full and context modes with correct strings. `bun tsc --noEmit` passes.

---

## Batch 3 — Locale Persistence & Preferences

**Goal:** Users can select their language in Preferences and have it persist across restarts.

**Review checkpoint:** Language dropdown in Preferences works. Switching locale updates all visible strings reactively. Locale survives app restart.

### Task 3.1 — Add language dropdown to PreferencesPanel.vue

**File:** `apps/desktop/src/components/PreferencesPanel.vue`

Changes:
1. Add `const { t } = useI18n()`
2. Add language `<select>` using the existing emit pattern (per spec)
3. Replace all hardcoded strings in template with `$t()` calls:
   - `"Preferences"` → `$t('preferences.title')`
   - `"Suspend After (min)"` → `$t('preferences.suspendAfter')`
   - `"Kill After (min)"` → `$t('preferences.killAfter')`
   - `"IDE Command"` → `$t('preferences.ideCommand')`
   - placeholder → `$t('preferences.idePlaceholder')`
   - `"Done"` → `$t('actions.done')`
4. Add `locale` to the preferences prop interface if needed

### Task 3.2 — Handle locale loading and switching in App.vue

**File:** `apps/desktop/src/App.vue`

Changes:
1. Import `i18n` from the i18n module
2. In `onMounted`, after `store.init(db)`: read `getSetting(db, 'locale')` and set `i18n.global.locale.value`
3. In the settings `update` handler: when key is `'locale'`, call `setSetting(db, 'locale', value)` and set `i18n.global.locale.value`

**Verification:** Set locale to `ja` in Preferences. All visible strings change to Japanese. Reload app — Japanese persists.

---

## Batch 4 — High-Visibility Component Migration

**Goal:** Migrate the always-visible components (sidebar, action bar, new task modal, main panel, task header).

**Review checkpoint:** All sidebar text, action bar buttons, task creation modal, main panel empty states, and task headers render translated strings.

### Task 4.1 — Sidebar.vue

**File:** `apps/desktop/src/components/Sidebar.vue`

Strings to migrate (~12):
- Empty state text: "No repos yet.", "Press ... to create one."
- Tooltips: "New Task (⌘N)", "Remove Repo"
- Section labels: "Merge Queue", "Pull Requests", "In Progress", "Blocked"
- "Blocked by: " prefix
- "No tasks" empty state
- "Add Repo" button + tooltip
- `"Untitled"` fallback in script

### Task 4.2 — ActionBar.vue

**File:** `apps/desktop/src/components/ActionBar.vue`

Strings to migrate (~1):
- `"Make PR"` button text

### Task 4.3 — NewTaskModal.vue

**File:** `apps/desktop/src/components/NewTaskModal.vue`

Strings to migrate (~4):
- `"New Task"` heading
- placeholder `"Describe the task..."`
- `"⌘Enter to submit"` hint
- `"Cancel"` / `"Create"` buttons

### Task 4.4 — MainPanel.vue

**File:** `apps/desktop/src/components/MainPanel.vue`

Strings to migrate (~9):
- "Task Blocked" title, hint text, "Waiting on:" label
- Blocker status labels: "Done", "Active", "Untitled" fallback
- Empty states: "No repos yet", hint, "No task selected", hint

### Task 4.5 — TaskHeader.vue

**File:** `apps/desktop/src/components/TaskHeader.vue`

Strings to migrate (~3):
- `"Untitled"` fallback
- `"branch:"` label
- `"PR #"` prefix

**Verification:** Navigate through the app in Japanese. All sidebar, main panel, and modal text is translated.

---

## Batch 5 — Modal Component Migration

**Goal:** Migrate all remaining modals.

**Review checkpoint:** Every modal in the app renders translated strings.

### Task 5.1 — AddRepoModal.vue

**File:** `apps/desktop/src/components/AddRepoModal.vue`

Strings to migrate (~15+):
- Tab labels: "Create New", "Import / Clone"
- Placeholders, "change" links, "or" + "choose a local folder"
- Detection states: "detecting...", "✓ Git repo · branch:", "Not a git repo..."
- Buttons: "Cancel", "Create", "Import", "Cloning..."
- Dialog titles in script: "Choose parent directory", "Choose clone directory", "Select a Git Repository"

### Task 5.2 — CommandPaletteModal.vue

**File:** `apps/desktop/src/components/CommandPaletteModal.vue`

Strings to migrate (~2):
- placeholder `"Type a command..."`
- `"No commands found"` empty state

### Task 5.3 — BlockerSelectModal.vue

**File:** `apps/desktop/src/components/BlockerSelectModal.vue`

Strings to migrate (~6):
- Search placeholder, "Circular dependency" tag, status tags
- "No matching tasks" empty state
- Hint text (empty / selected)
- `"Untitled"` fallbacks in script

### Task 5.4 — FilePickerModal.vue

**File:** `apps/desktop/src/components/FilePickerModal.vue`

Strings to migrate (~2):
- Search placeholder, "No files found" empty state

### Task 5.5 — FilePreviewModal.vue

**File:** `apps/desktop/src/components/FilePreviewModal.vue`

Strings to migrate (~5):
- "Rendered" / "Raw" toggle, "Open in IDE" button
- "Loading..." state
- Context shortcut labels in script (Open in IDE, Toggle Markdown, etc.)

### Task 5.6 — AnalyticsModal.vue

**File:** `apps/desktop/src/components/AnalyticsModal.vue`

Strings to migrate (~20+):
- View names: "Tasks", "Avg Time in State", "Operator"
- Hint text, "Loading...", "No tasks yet"
- Card labels: "Created", "Closed", "Open"
- Chart dataset labels
- Time-in-state labels: "Avg Busy", "Avg Unread", "Avg Idle", bar labels
- Operator labels: "Avg Response Time", "Avg Dwell Time", "Switches/Hour", "Focus Score"
- Tracking-started messages

**Verification:** Open every modal in Japanese. All text is translated.

---

## Batch 6 — Remaining Components & Stores

**Goal:** Migrate all remaining components and Pinia store strings.

**Review checkpoint:** Every user-facing string in the app is translated. No hardcoded English remains.

### Task 6.1 — AgentView.vue

**File:** `apps/desktop/src/components/AgentView.vue`

Strings to migrate (~6):
- "Thinking...", "Working" fallback, "Completed"/"Error" headers
- "turns" suffix, "Agent running..."

### Task 6.2 — DiffView.vue

**File:** `apps/desktop/src/components/DiffView.vue`

Strings to migrate (~10):
- Scope buttons: "Branch", "Last Commit", "Working"
- "No changes" empty state
- Context shortcut labels in script (Scope →/←, Line ↓/↑, etc.)

### Task 6.3 — TagBadges.vue

**File:** `apps/desktop/src/components/TagBadges.vue`

Strings to migrate (~5):
- Module-level `tagLabels` object: "In Progress", "PR", "Merge", "Done", "Blocked"
- Same constraint as shortcuts — must use a function or computed that takes `t`

### Task 6.4 — TerminalTabs.vue

**File:** `apps/desktop/src/components/TerminalTabs.vue`

Strings to migrate (~1):
- "No agent session active" placeholder

### Task 6.5 — ToastContainer.vue

**File:** `apps/desktop/src/components/ToastContainer.vue`

Strings to migrate (~1):
- `aria-label="Dismiss"` on dismiss button

### Task 6.6 — kanna.ts (Pinia store)

**File:** `apps/desktop/src/stores/kanna.ts`

Strings to migrate (~10):
- All toast messages: "Failed to create worktree", "Failed to save task to database", "Failed to close task", "Failed to undo close", "Failed to start PR agent", "Failed to close source task", "Select a repository first", "Failed to start merge agent", "Failed to create worktree for blocked task", "Failed to block task"
- Use `import i18n from '../i18n'` + `i18n.global.t('key')` pattern

### Task 6.7 — App.vue script strings

**File:** `apps/desktop/src/App.vue`

Strings to migrate (~10):
- Alert messages: "Select a repository first", "Custom task launch/creation failed"
- Toast messages: "Task creation failed", "Failed to create repo", "Clone failed"
- Command palette items: "New Custom Task", description, "Block Task", "Edit Blocked Task", "Tasks" group
- Template: BlockerSelectModal title prop ("Select/Edit blocking tasks")

**Verification:** `bun tsc --noEmit` passes. Switch through all 3 locales. No English strings visible in ja/ko. No console errors.

---

## Batch 7 — Final Verification

**Goal:** Full verification pass.

### Task 7.1 — TypeScript check

```bash
cd apps/desktop && bun tsc --noEmit
```

Fix any type errors.

### Task 7.2 — Dev server smoke test

```bash
./scripts/dev.sh
```

Verify the app boots, all screens render, locale switching works in all 3 languages.

### Task 7.3 — Update the spec

Update `docs/superpowers/specs/2026-03-23-i18n-design.md` to reflect the expanded `en.json` structure and any implementation details that diverged from the original spec.

---

## Files Created (4)

| File | Purpose |
|------|---------|
| `apps/desktop/src/i18n/index.ts` | Plugin setup |
| `apps/desktop/src/i18n/locales/en.json` | English strings (source of truth) |
| `apps/desktop/src/i18n/locales/ja.json` | Japanese translations |
| `apps/desktop/src/i18n/locales/ko.json` | Korean translations |

## Files Modified (~20)

| File | Change |
|------|--------|
| `apps/desktop/package.json` | Add vue-i18n dependency |
| `apps/desktop/src/main.ts` | Register i18n plugin |
| `apps/desktop/src/stores/db.ts` | Add locale default setting |
| `apps/desktop/src/stores/kanna.ts` | Use i18n.global.t for toasts |
| `apps/desktop/src/App.vue` | Locale loading/switching + string migration |
| `apps/desktop/src/composables/useKeyboardShortcuts.ts` | labelKey/groupKey refactor |
| `apps/desktop/src/composables/useShortcutContext.ts` | Translation key lookup |
| `apps/desktop/src/components/KeyboardShortcutsModal.vue` | Computed groups + string migration |
| `apps/desktop/src/components/PreferencesPanel.vue` | Language dropdown + string migration |
| `apps/desktop/src/components/Sidebar.vue` | String migration |
| `apps/desktop/src/components/ActionBar.vue` | String migration |
| `apps/desktop/src/components/NewTaskModal.vue` | String migration |
| `apps/desktop/src/components/MainPanel.vue` | String migration |
| `apps/desktop/src/components/TaskHeader.vue` | String migration |
| `apps/desktop/src/components/AddRepoModal.vue` | String migration |
| `apps/desktop/src/components/CommandPaletteModal.vue` | String migration |
| `apps/desktop/src/components/BlockerSelectModal.vue` | String migration |
| `apps/desktop/src/components/FilePickerModal.vue` | String migration |
| `apps/desktop/src/components/FilePreviewModal.vue` | String migration |
| `apps/desktop/src/components/AnalyticsModal.vue` | String migration |
| `apps/desktop/src/components/AgentView.vue` | String migration |
| `apps/desktop/src/components/DiffView.vue` | String migration |
| `apps/desktop/src/components/TagBadges.vue` | String migration |
| `apps/desktop/src/components/TerminalTabs.vue` | String migration |
| `apps/desktop/src/components/ToastContainer.vue` | String migration |

## Risks

1. **Translation quality** — ja/ko translations should be reviewed by native speakers. Machine translations are a starting point.
2. **String length** — Japanese/Korean strings may be shorter or longer than English, potentially affecting layout. Visual inspection needed.
3. **Context shortcut labels** — DiffView and FilePreviewModal register context shortcuts with string labels. These need the same labelKey pattern as the main shortcuts, which means `registerContextShortcuts` and `getContextShortcuts` APIs may need updating.
4. **TagBadges module-level constant** — Same constraint as shortcuts. Must convert `tagLabels` from a static object to a function accepting `t`.
5. **Template literal toast messages** — Messages like `Task creation failed: ${error}` need careful handling. The error detail is dynamic and should not be translated — only the prefix.
