# Feature Parity Implementation Plan

> **For agentic workers:** Use superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Kanna Tauri to feature parity with the Swift version for daily use.

**Spec:** `docs/superpowers/specs/2026-03-18-feature-parity-design.md`

---

## Chunk 1: Interactive PTY Terminal

### Task 1: Pass prompt as positional arg, not -p

**Files:**
- Modify: `apps/desktop/src/composables/useWorkflow.ts`

- [ ] **Step 1: Change spawnPtySession to use positional arg**

Replace the current `-p` flag approach:
```typescript
// BEFORE:
const claudeCmd = `claude --dangerously-skip-permissions --settings '${hookSettings}' -p '${prompt.replace(/'/g, "'\\''")}'`;

// AFTER:
const claudeCmd = `claude --dangerously-skip-permissions --settings '${hookSettings}' '${prompt.replace(/'/g, "'\\''")}'`;
```

Remove `-p` entirely. The prompt becomes a positional argument, which starts Claude in interactive mode.

- [ ] **Step 2: Test — restart app, create task, verify Claude starts interactively**

Expected: Claude shows its full terminal UI (status bar, colored prompt, thinking indicator), not just plain text output. The task prompt should be the initial query.

- [ ] **Step 3: Commit**

---

## Chunk 2: Hook Event Handling + Activity Detection

### Task 2: Add activity columns to DB schema

**Files:**
- Modify: `apps/desktop/src/App.vue` (migration)
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`

- [ ] **Step 1: Add migration in App.vue runMigrations()**

```sql
ALTER TABLE pipeline_item ADD COLUMN activity TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE pipeline_item ADD COLUMN activity_changed_at TEXT;
```

Wrap in try/catch since ALTER TABLE fails if column already exists.

- [ ] **Step 2: Update PipelineItem interface in schema.ts**

Add `activity: "working" | "unread" | "idle"` and `activity_changed_at: string | null`.

- [ ] **Step 3: Add updateActivity query in queries.ts**

```typescript
export async function updatePipelineItemActivity(
  db: DbHandle, id: string, activity: string
): Promise<void>
```

- [ ] **Step 4: Commit**

### Task 3: Hook event listener in App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/listen.ts` (if needed)

- [ ] **Step 1: Add hook_event and session_exit listeners in onMounted**

```typescript
listen("hook_event", (event) => {
  const { session_id, event: hookEvent } = event.payload;
  const item = allItems.value.find(i => i.id === session_id);
  if (!item) return;

  if (hookEvent === "Stop" || hookEvent === "StopFailure") {
    const activity = selectedItemId.value === session_id ? "idle" : "unread";
    updateActivity(db, session_id, activity);
    item.activity = activity;
  } else if (hookEvent === "PostToolUse") {
    updateActivity(db, session_id, "working");
    item.activity = "working";
  }
});

listen("session_exit", (event) => {
  const { session_id } = event.payload;
  const item = allItems.value.find(i => i.id === session_id);
  if (!item) return;
  const activity = selectedItemId.value === session_id ? "idle" : "unread";
  updateActivity(db, session_id, activity);
  item.activity = activity;
});
```

- [ ] **Step 2: Mark as read when selecting a task**

In `handleSelectItem`, if the item's activity is `"unread"`, update to `"idle"`.

- [ ] **Step 3: On startup, transition stale "working" items to "unread"**

After `reconcileSessions`, for each workflow item with `activity === "working"`, try to attach. If attach fails, set activity to `"unread"`.

- [ ] **Step 4: Verify event bridge delivers hook_event — check lib.rs Subscribe + loop**

The event bridge in `lib.rs` already sends `Subscribe` and reads `HookEvent` in its loop. Verify by creating a task and checking for hook_event log entries.

- [ ] **Step 5: Commit**

### Task 4: Activity-based sidebar styling and sorting

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`

- [ ] **Step 1: Apply font styling based on activity**

In the workflow item row:
```vue
<span
  :style="{
    fontWeight: item.activity === 'unread' ? 'bold' : 'normal',
    fontStyle: item.activity === 'working' ? 'italic' : 'normal',
  }"
>{{ itemTitle(item) }}</span>
```

- [ ] **Step 2: Sort items by activity group**

Update `itemsForRepo` to sort:
```typescript
function itemsForRepo(repoId: string) {
  const order = { idle: 0, unread: 1, working: 2 };
  return props.workflowItems
    .filter(i => i.repo_id === repoId)
    .sort((a, b) => {
      const ao = order[a.activity || 'idle'] ?? 0;
      const bo = order[b.activity || 'idle'] ?? 0;
      if (ao !== bo) return ao - bo;
      // Within same group, most recent first
      return (b.activity_changed_at || b.created_at).localeCompare(
        a.activity_changed_at || a.created_at
      );
    });
}
```

- [ ] **Step 3: Test — create task, verify italic while running, bold when finished (if not viewing), regular after viewing**

- [ ] **Step 4: Commit**

---

## Chunk 3: Keyboard Shortcuts

### Task 5: Update all keyboard shortcuts to match Swift version

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Modify: `apps/desktop/src/App.vue`
- Create: `apps/desktop/src/components/KeyboardShortcutsModal.vue`

- [ ] **Step 1: Rewrite useKeyboardShortcuts with new bindings**

Update the `KeyboardActions` interface and handler to match:

| Key | Meta | Shift | Alt | Action |
|-----|------|-------|-----|--------|
| n | true | true | false | newTask |
| n | true | false | false | newWindow |
| p | true | false | false | openFile |
| s | true | false | false | makePR |
| m | true | false | false | merge |
| Backspace | true | false | false | closeTask |
| ArrowDown | true | false | true | navigateDown |
| ArrowUp | true | false | true | navigateUp |
| z | true | true | false | toggleZen |
| Escape | false | false | false | exitZen |
| t | true | false | false | openTerminal |
| t | true | true | false | openTerminalAtRoot |
| w | true | false | false | closeTerminal |
| ArrowRight | true | false | true | nextTab |
| ArrowLeft | true | false | true | prevTab |
| / | true | false | false | showShortcuts |
| , | true | false | false | openPreferences |

- [ ] **Step 2: Wire new actions in App.vue**

Add handlers for: `newWindow`, `openFile`, `makePR`, `openTerminal`, `openTerminalAtRoot`, `closeTerminal`, `nextTab`, `prevTab`, `showShortcuts`.

`newWindow`: use `invoke("run_script", { script: "open -n '${appPath}'" })` or Tauri's window API.

- [ ] **Step 3: Create KeyboardShortcutsModal.vue**

Simple modal listing all shortcuts in groups (Workflow, Navigation, Terminal, Window, Help). Triggered by Cmd+/.

- [ ] **Step 4: Test — verify each shortcut fires the correct action**

- [ ] **Step 5: Commit**

---

## Chunk 4: Session Resume

### Task 6: Reattach to daemon sessions on startup

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/components/TerminalView.vue`

- [ ] **Step 1: On startup, attempt reattach for in_progress PTY items**

After `reconcileSessions` and activity migration, for each workflow item where `stage === "in_progress"` and `agent_type === "pty"`:

```typescript
try {
  await invoke("attach_session", { sessionId: item.id });
  // Attach succeeded — session is live, TerminalView will render output
} catch {
  // Session dead — mark as unread
  await updateActivity(db, item.id, "unread");
}
```

- [ ] **Step 2: Persist and restore selection**

Save `selectedRepoId` and `selectedItemId` to the `settings` table whenever they change (debounced). On startup, read and restore.

- [ ] **Step 3: TerminalView — handle case where session is already attached**

The TerminalView currently calls `startListening` → `attach_session` on mount. If the session was already attached during startup, this should not fail (the daemon allows multiple attaches to the same session).

- [ ] **Step 4: Test — create task, quit app, relaunch, verify terminal reconnects**

- [ ] **Step 5: Commit**

---

## Chunk 5: Diff Viewer Scopes

### Task 7: Multiple diff scopes + side-by-side mode

**Files:**
- Modify: `apps/desktop/src/components/DiffView.vue`
- Modify: `apps/desktop/src-tauri/src/commands/git.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register new command)

- [ ] **Step 1: Add git_diff_range Tauri command**

```rust
#[tauri::command]
pub fn git_diff_range(repo_path: String, from: String, to: String) -> Result<String, String>
```

Uses git2 `diff_tree_to_tree` between two revspecs. Register in `lib.rs`.

- [ ] **Step 2: Add scope selector to DiffView.vue**

Three buttons at top: Branch | Last Commit | Working. Default: Branch.

- Branch: `invoke("git_diff_range", { repoPath, from: defaultBranch, to: "HEAD" })`
- Last Commit: `invoke("git_diff_range", { repoPath, from: "HEAD~1", to: "HEAD" })`
- Working: existing `invoke("git_diff", { repoPath, staged: false })`

- [ ] **Step 3: Add side-by-side toggle**

`@pierre/diffs` FileDiff supports split mode. Add a toggle button and pass `diffMode: "split"` vs `"unified"` option.

- [ ] **Step 4: Test — verify each scope shows correct diff content**

- [ ] **Step 5: Commit**

---

## Chunk 6: File Picker

### Task 8: File picker with fuzzy search

**Files:**
- Create: `apps/desktop/src/components/FilePickerModal.vue`
- Modify: `apps/desktop/src-tauri/src/commands/fs.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register command)
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Add list_files Tauri command**

```rust
#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<String>, String>
```

Walk directory recursively, skip `.git/`, `node_modules/`, `target/`, and patterns from `.gitignore`. Return relative paths.

- [ ] **Step 2: Create FilePickerModal.vue**

Text input at top, scrollable file list below. Filters as user types (case-insensitive substring match). On Enter or click, opens file in IDE:

```typescript
invoke("run_script", {
  script: `${ideCommand} "${selectedFile}"`,
  cwd: worktreePath,
  env: {},
});
```

ESC or click outside closes modal.

- [ ] **Step 3: Wire Cmd+P in App.vue**

Add `showFilePickerModal` ref and `openFile` handler. Pass the current worktree path.

- [ ] **Step 4: Test — Cmd+P opens modal, typing filters, Enter opens file**

- [ ] **Step 5: Commit**

---

## Chunk 7: App Icon

### Task 9: Copy icon from Swift project

**Files:**
- Copy: icon files from Swift project to `apps/desktop/src-tauri/icons/`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

- [ ] **Step 1: Copy and convert icons**

```bash
cp /Users/jeremyhale/Documents/work/jemdiggity/kanna/Sources/Kanna/Assets.xcassets/AppIcon.appiconset/icon_32x32.png apps/desktop/src-tauri/icons/32x32.png
cp /Users/jeremyhale/Documents/work/jemdiggity/kanna/Sources/Kanna/Assets.xcassets/AppIcon.appiconset/icon_128x128.png apps/desktop/src-tauri/icons/128x128.png
cp /Users/jeremyhale/Documents/work/jemdiggity/kanna/Sources/Kanna/Assets.xcassets/AppIcon.appiconset/icon_128x128@2x.png apps/desktop/src-tauri/icons/128x128@2x.png
# Generate .icns and .ico from the 512x512@2x source
```

- [ ] **Step 2: Update tauri.conf.json icon paths**

- [ ] **Step 3: Test — rebuild, verify icon in dock and title bar**

- [ ] **Step 4: Commit**

---

## Chunk 8: E2E Tests

### Task 10: Fix existing test failures

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/*.test.ts`

- [ ] **Step 1: Fix CSS selector mismatches**

Audit each failing test against actual component class names. Fix `.preferences-panel` → `.prefs-panel` and similar.

- [ ] **Step 2: Fix async timing issues**

Ensure tests that create tasks wait for the task to appear before asserting. Use `waitForElement` / `waitForText` instead of fixed sleeps.

- [ ] **Step 3: Run full mock suite — all 30 must pass**

```bash
cd apps/desktop && bun test:e2e
```

- [ ] **Step 4: Commit**

### Task 11: Add new feature tests

**Files:**
- Create: `apps/desktop/tests/e2e/mock/activity.test.ts`
- Create: `apps/desktop/tests/e2e/mock/shortcuts.test.ts` (update existing)
- Modify: `apps/desktop/tests/e2e/real/claude-session.test.ts`

- [ ] **Step 1: Activity detection test**

Create task → verify italic font while running → verify bold after completion (if not viewing) → click task → verify regular font.

- [ ] **Step 2: Keyboard shortcuts test**

Verify all new shortcuts: Shift+Cmd+N opens New Task, Option+Cmd+Down navigates, Cmd+/ opens shortcuts modal, etc.

- [ ] **Step 3: PTY mode real test**

Create PTY task with real Claude → verify interactive terminal output (not just plain text) → verify session_exit event fires.

- [ ] **Step 4: Run all tests — all must pass**

```bash
cd apps/desktop && bun test:e2e:all
```

- [ ] **Step 5: Commit**

---

## Task Dependencies

```
Task 1 (Interactive PTY) ── no deps
Task 2 (DB schema) ── no deps
Task 3 (Hook listener) ── depends on Task 2
Task 4 (Sidebar styling) ── depends on Task 2, Task 3
Task 5 (Shortcuts) ── no deps
Task 6 (Session resume) ── depends on Task 2, Task 3
Task 7 (Diff scopes) ── no deps
Task 8 (File picker) ── depends on Task 5 (Cmd+P binding)
Task 9 (App icon) ── no deps
Task 10 (Fix tests) ── depends on Tasks 1-9
Task 11 (New tests) ── depends on Tasks 1-9, Task 10
```

Parallelizable: Tasks 1, 2, 5, 7, 9 can all be done concurrently.
