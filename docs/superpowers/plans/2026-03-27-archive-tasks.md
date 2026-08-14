# Archive Tasks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-kill task close with archive-on-close, preserving Claude session IDs for resumption via `--resume <uuid>`.

**Architecture:** Add `claude_session_id` column to `pipeline_item`, pass `--session-id <uuid>` on spawn, send SIGINT (not SIGKILL) on archive, and resume with `--resume <uuid>` on undo. The "archived" tag replaces "done" as the close action's target; "done" remains for terminal states (PR merge, GC).

**Tech Stack:** SQLite (migration), TypeScript (store/queries/types), Rust (daemon signal handler), Vue (sidebar filtering)

---

### Task 1: Database & Type Foundation

**Goal:** Add `claude_session_id` column and `"archived"` system tag so all downstream code can reference them.

**Files:**
- Modify: `packages/db/src/schema.ts:11-34` (PipelineItem interface)
- Modify: `packages/core/src/workflow/types.ts:1` (SYSTEM_TAGS)
- Modify: `packages/db/src/queries.ts:106-142` (addPipelineItemTag, removePipelineItemTag)
- Modify: `apps/desktop/src/stores/db.ts:91-105` (addColumn migrations)

**Acceptance Criteria:**
- [ ] `PipelineItem` interface has `claude_session_id: string | null`
- [ ] `SYSTEM_TAGS` includes `"archived"`
- [ ] `addPipelineItemTag` sets `closed_at` for both `"done"` and `"archived"`
- [ ] `removePipelineItemTag` clears `closed_at` for both `"done"` and `"archived"`
- [ ] Migration adds `claude_session_id` column
- [ ] New `updateClaudeSessionId` query helper exists

**Verify:** `bun tsc --noEmit` in `packages/db` and `packages/core` → no errors

**Steps:**

- [ ] **Step 1: Add `"archived"` to system tags**

In `packages/core/src/workflow/types.ts`:
```typescript
export const SYSTEM_TAGS = ["in progress", "done", "pr", "merge", "blocked", "teardown", "archived"] as const;
```

- [ ] **Step 2: Add `claude_session_id` to PipelineItem interface**

In `packages/db/src/schema.ts`, add to the `PipelineItem` interface after `pin_order`:
```typescript
  claude_session_id: string | null;
```

- [ ] **Step 3: Update `addPipelineItemTag` to handle "archived" closed_at**

In `packages/db/src/queries.ts`, change line 119:
```typescript
  const closedAt = (tag === "done" || tag === "archived") ? ", closed_at = datetime('now')" : "";
```

- [ ] **Step 4: Update `removePipelineItemTag` to handle "archived" closed_at**

In `packages/db/src/queries.ts`, change line 137:
```typescript
  const closedAt = (tag === "done" || tag === "archived") ? ", closed_at = NULL" : "";
```

- [ ] **Step 5: Add `updateClaudeSessionId` query helper**

In `packages/db/src/queries.ts`, add after `updatePipelineItemDisplayName`:
```typescript
export async function updateClaudeSessionId(
  db: DbHandle,
  id: string,
  claudeSessionId: string
): Promise<void> {
  await db.execute(
    "UPDATE pipeline_item SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    [claudeSessionId, id]
  );
}
```

Export it from `packages/db/src/index.ts` (or wherever the barrel export is).

- [ ] **Step 6: Add migration for `claude_session_id` column**

In `apps/desktop/src/stores/db.ts`, after the existing `addColumn` calls (after line 104):
```typescript
  await addColumn("pipeline_item", "claude_session_id", "TEXT");
```

- [ ] **Step 7: Run type check and commit**

Run: `cd packages/db && bun tsc --noEmit && cd ../core && bun tsc --noEmit`
Expected: No errors

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/core/src/workflow/types.ts apps/desktop/src/stores/db.ts
git commit -m "feat: add claude_session_id column and archived system tag"
```

---

### Task 2: Add SIGINT to Daemon Signal Handler

**Goal:** Allow the frontend to send SIGINT to a PTY session for graceful Claude shutdown.

**Files:**
- Modify: `crates/daemon/src/main.rs:512-526` (Signal command match block)

**Acceptance Criteria:**
- [ ] Daemon accepts `"SIGINT"` in the Signal command and sends `libc::SIGINT` to the session
- [ ] Existing signals still work

**Verify:** `cd crates/daemon && cargo clippy && cargo test -- --test-threads=1` → all pass, no warnings

**Steps:**

- [ ] **Step 1: Add SIGINT to signal match**

In `crates/daemon/src/main.rs`, in the `Command::Signal` match block (around line 513), add `"SIGINT"` arm:
```rust
        Command::Signal { session_id, signal } => {
            let sig = match signal.as_str() {
                "SIGINT" => libc::SIGINT,
                "SIGTSTP" => libc::SIGTSTP,
                "SIGCONT" => libc::SIGCONT,
                "SIGTERM" => libc::SIGTERM,
                "SIGKILL" => libc::SIGKILL,
                "SIGWINCH" => libc::SIGWINCH,
                other => {
```

- [ ] **Step 2: Run clippy, fmt, and tests**

Run: `cd crates/daemon && cargo fmt && cargo clippy && cargo test -- --test-threads=1`
Expected: All pass, no warnings

```bash
git add crates/daemon/src/main.rs
git commit -m "feat: add SIGINT to daemon signal handler"
```

---

### Task 3: Pass `--session-id` on Spawn and Store in DB

**Goal:** Generate a UUID when spawning Claude, pass it as `--session-id <uuid>`, and store it in the database.

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:33-43` (PtySpawnOptions interface)
- Modify: `apps/desktop/src/stores/kanna.ts:490-597` (spawnPtySession function)
- Modify: `apps/desktop/src/stores/kanna.ts:13-24` (imports)

**Acceptance Criteria:**
- [ ] `spawnPtySession` generates a UUID via `crypto.randomUUID()` and stores it in DB
- [ ] Claude is invoked with `--session-id <uuid>` flag
- [ ] `PtySpawnOptions` has optional `resumeSessionId` field for resume flow
- [ ] When `resumeSessionId` is provided, `--resume <uuid>` is used instead of the original prompt

**Verify:** `cd apps/desktop && bun tsc --noEmit` → no errors

**Steps:**

- [ ] **Step 1: Add `resumeSessionId` to PtySpawnOptions**

In `apps/desktop/src/stores/kanna.ts`, update the interface:
```typescript
export interface PtySpawnOptions {
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setupCmdsOverride?: string[];
  portEnv?: Record<string, string>;
  setupCmds?: string[];
  resumeSessionId?: string;
}
```

- [ ] **Step 2: Import `updateClaudeSessionId`**

In `apps/desktop/src/stores/kanna.ts`, add `updateClaudeSessionId` to the import from `@kanna/db`:
```typescript
import {
  listRepos, insertRepo, findRepoByPath,
  hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery,
  listPipelineItems, insertPipelineItem,
  addPipelineItemTag, removePipelineItemTag,
  updatePipelineItemActivity, pinPipelineItem, unpinPipelineItem,
  reorderPinnedItems, updatePipelineItemDisplayName,
  getRepo, getSetting, setSetting,
  insertTaskBlocker, removeTaskBlocker, removeAllBlockersForItem,
  listBlockersForItem, listBlockedByItem, getUnblockedItems,
  hasCircularDependency, insertOperatorEvent,
  updateClaudeSessionId,
} from "@kanna/db";
```

- [ ] **Step 3: Update `spawnPtySession` to handle session ID and resume**

In `spawnPtySession`, after the flags are built (around line 576), add session ID logic:

```typescript
    // Session ID: reuse for resume, generate new for fresh sessions
    const claudeSessionId = options?.resumeSessionId || crypto.randomUUID();
    if (!options?.resumeSessionId) {
      await updateClaudeSessionId(_db, sessionId, claudeSessionId);
    }

    if (options?.resumeSessionId) {
      flags.push(`--resume ${claudeSessionId}`);
    } else {
      flags.push(`--session-id ${claudeSessionId}`);
    }
```

Then update the command construction. When resuming, don't pass a prompt — just run `claude` with resume flags:

```typescript
    let claudeCmd: string;
    if (options?.resumeSessionId) {
      claudeCmd = `claude ${flags.join(" ")} --settings '${hookSettings}'`;
    } else {
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      claudeCmd = `claude ${flags.join(" ")} --settings '${hookSettings}' '${escapedPrompt}'`;
    }
```

The existing `fullCmd` assembly (setup commands wrapping `claudeCmd`) remains unchanged.

- [ ] **Step 4: Type check and commit**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: pass --session-id on Claude spawn, support --resume for archived tasks"
```

---

### Task 4: Convert `closeTask()` to Archive and Update `undoClose()`

**Goal:** `closeTask()` sends SIGINT and tags "archived" instead of SIGKILL and "done". `undoClose()` finds the most recent archived task and resumes it with `--resume`.

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:648-789` (closeTask and undoClose functions)

**Acceptance Criteria:**
- [ ] `closeTask()` uses `signal_session(sessionId, "SIGINT")` instead of `kill_session(sessionId)`
- [ ] `closeTask()` tags task as `"archived"` instead of `"done"` (for the normal/no-teardown path)
- [ ] Shell sessions (`shell-wt-*`) are still killed (not archived)
- [ ] `undoClose()` queries for `"archived"` tag instead of `"done"`
- [ ] `undoClose()` passes `resumeSessionId` to `spawnPtySession`
- [ ] Blocked and lingering edge cases still transition to `"done"` (not changed)
- [ ] Teardown completion still transitions to `"done"` (not changed)
- [ ] `checkUnblocked` is NOT called on archive (archived ≠ finished)

**Verify:** `cd apps/desktop && bun tsc --noEmit` → no errors

**Steps:**

- [ ] **Step 1: Update `closeTask()` — normal path (no teardown)**

In `closeTask()`, replace the no-teardown block (around lines 692-712):

```typescript
      if (teardownCmds.length === 0) {
        // No teardown — archive (or linger if dev hack enabled)
        if (devLingerTerminals.value) {
          await addPipelineItemTag(_db, item.id, "lingering");
        } else {
          await addPipelineItemTag(_db, item.id, "archived");
          selectNextItem(item.id);
        }
        bump();
        (async () => {
          try {
            await Promise.all([
              invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((e: unknown) =>
                console.error("[store] signal_session failed:", e)),
              invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((e: unknown) =>
                console.error("[store] kill shell session failed:", e)),
            ]);
            // NOTE: do not call checkUnblocked — archived ≠ done
          } catch (e) { console.error("[store] archive cleanup failed:", e); }
        })();
        return;
      }
```

- [ ] **Step 2: Update `closeTask()` — teardown path**

In the teardown path (around lines 716-746), change SIGINT for the main session but keep kill for shell:

```typescript
      // Has teardown scripts — enter teardown state
      // 1. Gracefully stop Claude, kill shell
      await Promise.all([
        invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((e: unknown) =>
          console.error("[store] signal_session failed:", e)),
        invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((e: unknown) =>
          console.error("[store] kill shell session failed:", e)),
      ]);
```

The rest of the teardown path (spawn teardown session, tag "teardown") stays the same. When teardown completes, the SessionExit handler already tags "done" — that's correct since teardown = intentional completion.

- [ ] **Step 3: Update `undoClose()` to find archived tasks and resume**

Replace the `undoClose()` function (lines 753-789):

```typescript
  async function undoClose() {
    if (lastUndoAction.value?.type === "hideRepo") {
      const repoId = lastUndoAction.value.repoId;
      lastUndoAction.value = null;
      await unhideRepoQuery(_db, repoId);
      bump();
      return;
    }
    try {
      const rows = await _db.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE tags LIKE '%\"archived\"%' ORDER BY updated_at DESC LIMIT 1"
      );
      const item = rows[0];
      if (!item) return;
      const repo = repos.value.find((r) => r.id === item.repo_id);
      if (!repo) return;
      await removePipelineItemTag(_db, item.id, "archived");
      await updatePipelineItemActivity(_db, item.id, "working");
      await selectItem(item.id);
      bump();
      if (item.branch) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        try {
          await spawnPtySession(
            item.id,
            worktreePath,
            item.prompt || "",
            80, 24,
            item.claude_session_id
              ? { resumeSessionId: item.claude_session_id }
              : undefined
          );
        } catch (spawnErr) {
          console.warn("[store] session re-spawn after undo failed:", spawnErr);
        }
      }
      selectedItemId.value = item.id;
      emitTaskSelected(item.id);
    } catch (e) {
      console.error("[store] undo close failed:", e);
      toast.error(tt('toasts.undoCloseFailed'));
    }
  }
```

- [ ] **Step 4: Type check and commit**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: archive tasks on close, resume on undo with --resume"
```

---

### Task 5: Sidebar and Store Filtering — Hide Archived Tasks

**Goal:** Archived tasks are hidden from the sidebar and store computed lists, same as "done" tasks.

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue:33-65` (filter functions)
- Modify: `apps/desktop/src/stores/kanna.ts:103-136` (currentItem, sortItemsForRepo)

**Acceptance Criteria:**
- [ ] Sidebar filter functions exclude "archived" tasks same as "done"
- [ ] `sortItemsForRepo` excludes "archived" tasks
- [ ] `currentItem` skips "archived" tasks
- [ ] Blocker status display treats "archived" as still active (not done)

**Verify:** `cd apps/desktop && bun tsc --noEmit` → no errors

**Steps:**

- [ ] **Step 1: Create helper for "hidden" check**

The pattern `!hasTag(i, "done")` appears in many places. Rather than duplicating `!hasTag(i, "done") && !hasTag(i, "archived")` everywhere, add a helper in `packages/core/src/workflow/types.ts`:

```typescript
export function isHidden(item: { tags: string }): boolean {
  return hasTag(item, "done") || hasTag(item, "archived");
}
```

- [ ] **Step 2: Update Sidebar.vue filter functions**

In `apps/desktop/src/components/Sidebar.vue`, import `isHidden` and replace all `!hasTag(i, "done")` with `!isHidden(i)`:

```typescript
// sortedPinned (line 35)
.filter((i) => i.repo_id === repoId && !isHidden(i) && i.pinned)

// sortedPR (line 45)
props.workflowItems.filter((i) => i.repo_id === repoId && hasTag(i, "pr") && !isHidden(i) && !i.pinned)

// sortedMerge (line 51)
props.workflowItems.filter((i) => i.repo_id === repoId && hasTag(i, "merge") && !isHidden(i) && !i.pinned)

// sortedActive (line 57)
props.workflowItems.filter((i) => i.repo_id === repoId && !hasTag(i, "pr") && !hasTag(i, "merge") && !hasTag(i, "blocked") && !isHidden(i) && !i.pinned)

// sortedBlocked (line 63)
props.workflowItems.filter((i) => i.repo_id === repoId && hasTag(i, "blocked") && !isHidden(i) && !i.pinned)
```

- [ ] **Step 3: Update store filtering**

In `apps/desktop/src/stores/kanna.ts`, import `isHidden` from `@kanna/core` and update:

```typescript
// currentItem (line 106)
if (item && !isHidden(item)) return item;

// sortItemsForRepo (line 113-114)
const repoItems = items.value.filter(
  (item) => item.repo_id === repoId && !isHidden(item)
);
```

- [ ] **Step 4: Update blocker status display in MainPanel.vue**

In `apps/desktop/src/components/MainPanel.vue` (line 34-35), archived blockers should show as active (not done), so update:
```typescript
:style="{ color: hasTag(b, 'done') ? '#666' : '#0066cc' }"
>{{ hasTag(b, 'done') ? $t('mainPanel.blockerDone') : $t('mainPanel.blockerActive') }}
```
This already works correctly — archived tasks aren't "done", so they'll show as active. No change needed here.

- [ ] **Step 5: Type check and commit**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

```bash
git add packages/core/src/workflow/types.ts apps/desktop/src/components/Sidebar.vue apps/desktop/src/stores/kanna.ts
git commit -m "feat: hide archived tasks from sidebar and store lists"
```

---

### Task 6: Update `getUnblockedItems` Query

**Goal:** The DB query for finding unblocked tasks must not treat "archived" as a completed state.

**Files:**
- Modify: `packages/db/src/queries.ts:284-297` (getUnblockedItems)

**Acceptance Criteria:**
- [ ] `getUnblockedItems` query does NOT count "archived" blockers as cleared
- [ ] Archived blocker keeps the dependent task blocked

**Verify:** `cd packages/db && bun tsc --noEmit` → no errors

**Steps:**

- [ ] **Step 1: Verify the query logic**

The current `getUnblockedItems` query checks:
```sql
AND blocker.tags NOT LIKE '%"done"%'
```

This means "a blocker is blocking if it does NOT have the done tag." Since archived tasks don't have the "done" tag, they will correctly continue to block. **No change needed** — the query already works correctly because it only clears on "done", not "archived".

However, the `checkUnblocked` function in kanna.ts (line 957) checks:
```typescript
const allClear = blockers.every(
  (b) => hasTag(b, "pr") || hasTag(b, "merge") || hasTag(b, "done")
);
```

This also already works correctly — "archived" is not in the list, so an archived blocker won't be considered "clear."

- [ ] **Step 2: Commit (no-op confirmation)**

No code changes needed. The existing logic correctly treats "archived" as still-blocking. Document this in the commit:

```bash
# No commit needed — existing unblock logic is already correct for archived tasks
```

---

### Task 7: Export `updateClaudeSessionId` and `isHidden` from Package Barrels

**Goal:** Ensure new functions are exported from their package entry points.

**Files:**
- Modify: `packages/db/src/index.ts` (or barrel export file)
- Modify: `packages/core/src/index.ts` (or barrel export file)

**Acceptance Criteria:**
- [ ] `updateClaudeSessionId` is importable from `@kanna/db`
- [ ] `isHidden` is importable from `@kanna/core`

**Verify:** `bun tsc --noEmit` from repo root → no errors across all packages

**Steps:**

- [ ] **Step 1: Find and update barrel exports**

Check `packages/db/src/index.ts` and `packages/core/src/index.ts` (or `packages/core/src/workflow/index.ts`) for the re-export pattern and add the new functions.

For `packages/db`, add `updateClaudeSessionId` to the existing re-export from `./queries.js`.

For `packages/core`, add `isHidden` to the existing re-export from `./workflow/types.js`.

- [ ] **Step 2: Full type check and commit**

Run: `bun tsc --noEmit` (from repo root, or via turborepo)
Expected: No errors

```bash
git add packages/db/src/index.ts packages/core/src/index.ts
git commit -m "chore: export updateClaudeSessionId and isHidden from package barrels"
```
