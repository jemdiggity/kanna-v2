# Archive Tasks Design

## Problem

Closing a task (`⌘⌫`) hard-kills the Claude CLI process (SIGKILL) and tags the task as "done". The Claude conversation is lost — undoing (`⌘Z`) re-spawns Claude with the original prompt, starting a fresh conversation. Tasks should be pausable and resumable.

## Solution

Replace the kill-on-close behavior with archive-on-close. Archived tasks are hidden from the task list (same as "done" today) but are resumable to exactly where they left off.

### Key Mechanisms

- **`--session-id <uuid>`** — passed when spawning Claude, gives us a stable handle
- **SIGINT** — graceful shutdown signal; Claude finishes its current tool call and exits cleanly
- **`--resume <uuid>`** — resumes a Claude conversation by session ID

## Task Lifecycle

```
Active ("in progress")
  ↓ ⌘⌫ (archive)
Archived ("archived" tag, hidden from task list)
  ↓ ⌘Z (unarchive)
Active (Claude resumes via --resume <uuid>)

Active → Done ("done" tag) only via:
  - PR merge completion
  - Explicit "mark as done" (future)
  - GC after N days (existing preference)
```

## Changes

### 1. Database

Add `claude_session_id TEXT` column to `pipeline_item`.

```sql
ALTER TABLE pipeline_item ADD COLUMN claude_session_id TEXT;
```

Migration added to `runMigrations()` in `App.vue` (and mirrored in `packages/db`).

### 2. System Tags

Add `"archived"` to the system tags list in `packages/core/src/workflow/types.ts`.

Archived tasks are filtered out of the sidebar the same way "done" tasks are today.

### 3. Spawn — Pass `--session-id <uuid>`

In `spawnPtySession()` (`kanna.ts`), generate a UUID for the Claude session and store it:

```
const claudeSessionId = crypto.randomUUID()
→ UPDATE pipeline_item SET claude_session_id = :id WHERE id = :itemId
→ claude --session-id <claudeSessionId> ... (added to flags in the claude command string)
```

### 4. Daemon — Add SIGINT to Allowed Signals

In `crates/daemon/src/main.rs`, the `Signal` command handler's match block currently supports SIGTSTP, SIGCONT, SIGTERM, SIGKILL, SIGWINCH. Add `"SIGINT" => libc::SIGINT`.

### 5. `closeTask()` → Archive Flow

Replace the current kill-and-done logic:

**Before (current):**
```
kill_session(sessionId)         // SIGKILL
kill_session(shell-wt-sessionId) // kill shell too
addPipelineItemTag("done")
selectNextItem()
```

**After:**
```
signal_session(sessionId, "SIGINT")   // graceful shutdown
kill_session(shell-wt-sessionId)       // shell is not resumable, kill it
addPipelineItemTag("archived")
selectNextItem()
```

The SIGINT causes Claude to exit cleanly. The daemon will broadcast a SessionExit event when the process terminates. No need to wait for it synchronously — the tag is set immediately and the UI moves on.

**Edge cases (unchanged):**
- **Lingering tasks** — second `⌘⌫` still transitions to "done" (not "archived", since lingering is a dev hack)
- **Teardown tasks** — force-complete still transitions to "done"
- **Blocked tasks** — still transitions to "done" (never had a Claude session)

### 6. `undoClose()` → Resume Flow

Modify `undoClose()` to detect archived tasks and resume:

```
Query: most recent task with "archived" tag (instead of "done")
→ removePipelineItemTag("archived")
→ updatePipelineItemActivity("working")
→ selectItem(item.id)
→ spawnPtySession(item.id, worktreePath, prompt, {
    resumeSessionId: item.claude_session_id  // NEW option
  })
```

In `spawnPtySession()`, when `resumeSessionId` is provided:
```
claude --resume <resumeSessionId> --session-id <resumeSessionId> ...
```

The `--resume` flag tells Claude to load the existing conversation. The `--session-id` ensures the same UUID is reused (so future archives of the same task still work).

No prompt is passed on resume — Claude picks up the existing conversation silently.

### 7. Sidebar Filtering

Wherever "done" tasks are filtered out of the task list, also filter "archived":

```typescript
// Current: items.filter(i => !hasTag(i, "done"))
// New:     items.filter(i => !hasTag(i, "done") && !hasTag(i, "archived"))
```

### 8. `checkUnblocked()` — Archived Does NOT Unblock

Unlike "done", archiving a task should NOT trigger unblocking of dependent tasks. The archived task isn't finished — it's paused. Only "done", "pr", and "merge" should count as completed for unblocking purposes.

## Files to Modify

| File | Change |
|------|--------|
| `apps/desktop/src/App.vue` | Add migration for `claude_session_id` column |
| `apps/desktop/src/stores/kanna.ts` | `closeTask()`, `undoClose()`, `spawnPtySession()` |
| `apps/desktop/src/stores/db.ts` | Migration for `claude_session_id` column |
| `packages/db/src/schema.ts` | Add `claude_session_id` to `PipelineItem` |
| `packages/db/src/migrations/001_initial.sql` | Reference only (column added via ALTER) |
| `packages/core/src/workflow/types.ts` | Add `"archived"` to system tags |
| `crates/daemon/src/main.rs` | Add `"SIGINT"` to signal match |
| Sidebar filtering (wherever "done" is filtered) | Also filter "archived" |

## Not in Scope

- Archive UI (viewing/browsing archived tasks) — archives are hidden, accessed only via undo
- Bulk archive/unarchive
- Auto-archive idle tasks (future, uses existing `killAfterMinutes` preference)
- Worktree cleanup on archive (worktree stays intact for resume)
