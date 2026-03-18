# Kanna Tauri — Feature Parity Spec

**Date:** 2026-03-18
**Status:** Draft
**Author:** Jeremy Hale + Claude

## Overview

Bring the Tauri rewrite to feature parity with the Swift version for daily use. Agent personas (Night Shift, Reviewer, PM) remain deferred.

## 1. Interactive PTY Terminal

### Current
Claude runs with `-p "prompt"` (print mode — outputs response and exits). No interactive terminal.

### Target
Claude runs interactively with the full terminal UI. The prompt from the New Task modal is passed as a positional argument:

```
claude --dangerously-skip-permissions --settings '{"hooks":{...}}' "the user's prompt"
```

This starts Claude in interactive mode with the initial prompt. The user sees Claude's full terminal UI (status bar, thinking indicator, tool calls) and can type follow-up prompts.

### Changes
- `usePipeline.ts`: change `spawnPtySession` to pass prompt as positional arg, not `-p`
- Remove the `-p` flag entirely from PTY mode
- No delay or keystroke injection needed — Claude reads the positional arg on startup

## 2. Hook Event Handling

### Current
Hook events reach the daemon and get broadcast, but no frontend consumer processes them.

### Target
The app subscribes to hook broadcasts via a dedicated connection. Hook events update task activity state and trigger completion flows.

### Flow
1. Claude fires hook → `kanna-hook` → daemon → broadcast
2. Event bridge connection (already exists in `lib.rs`) sends `Subscribe` command
3. Bridge receives `HookEvent` → emits Tauri `hook_event` event
4. Frontend listener updates activity state

### Changes
- `lib.rs`: the event bridge already sends `Subscribe` — verify it works (it was added but may not be reading hook events in the loop)
- `App.vue`: add `listen("hook_event", handler)` and `listen("session_exit", handler)`
- On `Stop`: mark task activity as idle, set unread if user isn't viewing it
- On `StopFailure`: show error indicator
- On `PostToolUse`: mark task activity as working
- On `session_exit`: mark task completed

## 3. Activity Detection

### Current
No activity indicators on tasks.

### Target
Match the Swift version's font-based activity states:
- **Italic** — working (received PostToolUse recently, or Claude is thinking)
- **Bold** — unread (Claude finished but user hasn't viewed the task yet)
- **Regular** — idle and read (user has seen the task since last busy→idle transition)

### Data Model
Add to pipeline item tracking (in-memory, not DB):
```typescript
activityState: Map<string, "working" | "unread" | "idle">
activityChangedAt: Map<string, number>
```

### Sidebar Sorting
Within each repo, sort tasks by activity:
1. Working (italic) — most recent first
2. Unread (bold) — most recent first
3. Idle (regular) — most recent first

### Changes
- `usePipeline.ts` or new `useActivity.ts` composable: activity state map
- `App.vue`: update activity on hook events. On selecting a task, mark it as read.
- `Sidebar.vue` / pipeline item component: apply italic/bold/regular font weight
- Sort items by activity group then by `activityChangedAt`

## 4. Diff Viewer — Multiple Scopes

### Current
Single scope (working tree changes, including untracked files).

### Target
Three scopes matching the Swift version:
- **Branch** — all changes since base branch (`git diff main...HEAD`)
- **Last commit** — `git diff HEAD~1..HEAD`
- **Working** — unstaged + untracked changes

Plus side-by-side diff mode (Cmd+Shift+D).

### Changes
- `DiffView.vue`: add scope selector (three buttons at top)
- `git.rs`: add `git_diff_range(repoPath, from, to)` command for branch/commit diffs
- Default scope: Branch
- `useKeyboardShortcuts.ts`: add Cmd+D (show diff) and Cmd+Shift+D (side-by-side)
- Side-by-side: use `@pierre/diffs` split mode option

## 5. Keyboard Shortcuts

### Current
Partial set: Cmd+N, Cmd+M, Cmd+Delete, Cmd+Z, Cmd+Up/Down, Escape.

### Target
Match the Swift version exactly:

**Pipeline:**
| Shortcut | Action |
|---|---|
| Shift+Cmd+N | New Task |
| Cmd+P | Open File |
| Cmd+S | Make PR |
| Cmd+M | Merge PR |
| Cmd+Delete | Close / Reject PR |

**Navigation:**
| Shortcut | Action |
|---|---|
| Option+Cmd+Down | Next Task |
| Option+Cmd+Up | Previous Task |
| Shift+Cmd+Z | Zen Mode |
| Escape | Exit Zen Mode |

**Terminal:**
| Shortcut | Action |
|---|---|
| Cmd+T | Open Terminal Tab |
| Shift+Cmd+T | Open Terminal at Repo Root |
| Cmd+W | Close Terminal Tab |
| Option+Cmd+Right | Next Tab |
| Option+Cmd+Left | Previous Tab |

**Help:**
| Shortcut | Action |
|---|---|
| Cmd+/ | Show Keyboard Shortcuts |

### Changes
- `useKeyboardShortcuts.ts`: update all bindings to match Swift version
- Note: Cmd+N → Shift+Cmd+N, Cmd+Up/Down → Option+Cmd+Up/Down
- Add missing shortcuts: Cmd+T, Cmd+W, Cmd+P, Cmd+/, Cmd+S, tab navigation
- `KeyboardShortcutsModal.vue`: new modal showing the shortcut reference

## 6. File Picker

### Current
None.

### Target
Cmd+P fuzzy file search modal. Lists files in the worktree (respecting .gitignore). Selecting a file opens it in the configured IDE.

### Changes
- `FilePickerModal.vue`: modal with text input, filtered file list
- `fs.rs`: add `list_files(path)` command — walks directory, filters via .gitignore patterns
- Open file: `invoke("run_script", { script: "${ideCommand} ${filePath}", cwd, env: {} })`
- `useKeyboardShortcuts.ts`: Cmd+P handler

## 7. Session Resume Across Restarts

### Current
PTY sessions survive in the daemon but the frontend doesn't reconnect. SDK sessions die with the app.

### Target
On startup, for each `in_progress` pipeline item with `agent_type: "pty"`:
- Try to reattach to the daemon session using the pipeline item's ID as session ID
- If attach succeeds, show the terminal with existing output
- If attach fails (session died), show "Session ended" with option to create a new task

No need to call `list_sessions` — the app knows which sessions should exist from the DB.

### Changes
- `App.vue`: on mount, for each in_progress PTY item, attempt `invoke("attach_session", { sessionId: item.id })`
- `TerminalView.vue`: handle attach failure gracefully
- Persistent selection: save `selectedRepoId` and `selectedItemId` to the `settings` table on change, restore on startup

## 8. App Icon

### Current
Default Tauri icon.

### Target
Use the same icon from the Swift project.

### Changes
- Copy icon files from `/Users/jeremyhale/Documents/work/jemdiggity/kanna/Sources/Kanna/Assets.xcassets/AppIcon.appiconset/`
- Convert to Tauri's required sizes (32x32, 128x128, 128x128@2x, icon.icns, icon.ico)
- Update `tauri.conf.json` icon paths

## 9. E2E Tests

### Current
23/30 mock tests, 3/4 real tests passing.

### Target
All tests pass. Add tests for new features.

### Changes
- Fix remaining 7 mock test failures (CSS selectors, timing)
- Add PTY mode test: create task → terminal output appears
- Add activity detection test: create task → verify font styling changes
- Add keyboard shortcuts test: verify all new shortcuts
- All tests must pass before merging

## Implementation Order

1. Interactive PTY terminal (removes -p, passes prompt as arg)
2. Hook event handling (Subscribe + frontend listener)
3. Activity detection (italic/bold/regular + sidebar sorting)
4. Keyboard shortcuts (match Swift version)
5. Session resume
6. Diff viewer scopes
7. File picker
8. App icon
9. E2E test fixes + new tests

## Out of Scope

- Auto-PR on completion (deferred per user request)
- Pipeline stage transitions (deferred)
- Night Shift / Reviewer / PM agents
- `--resume` conversation-level resume
- Delta updater plugin
