# Pre-warmed Shell Terminals

## Problem

When a user presses `⌘J` (worktree shell) or `⇧⌘J` (repo root shell), zsh startup takes 200ms–2s depending on `.zshrc` complexity (nvm, rbenv, pyenv, etc.). The shell should be instant.

## Solution

Pre-spawn idle zsh PTY sessions in the daemon so they're already running when the user opens a shell modal. The daemon already supports this pattern: `Spawn` creates a session, `PreAttachBuffer` (64 KB) captures startup output, and `useTerminal`'s attach-first logic connects to existing sessions.

No daemon changes required.

## Session ID Convention

Matches the IDs generated in `App.vue` (after #201):

- **Per-task worktree shell:** `shell-wt-${taskId}` — cwd is the task's worktree path
- **Repo root shell:** `shell-repo-${repoId}` — one per repo, cwd is the repo root path

## Pre-spawn Trigger Points

### Per-task shell

In `setupWorktreeAndSpawn()` (kanna.ts), after `createWorktree()` succeeds and before the agent PTY spawn. Fire-and-forget — not awaited, runs in parallel with the agent spawn:

```
spawnShellSession(`shell-wt-${id}`, worktreePath, JSON.stringify(portEnv))
  .catch(e => console.error("[store] shell pre-warm failed:", e));
```

### App startup (existing tasks + repo root)

At the end of `store.init()`, after repos and items are loaded and selection is restored (line ~1113 of kanna.ts). At this point the daemon is ready — `init()` has already made successful `invoke` calls (e.g., `git_app_info`). The pre-warm logic:

```typescript
// Pre-warm worktree shells for active tasks
for (const item of eagerItems) {
  if (!item.branch) continue;
  const repo = eagerRepos.find(r => r.id === item.repo_id);
  if (!repo) continue;
  const wtPath = `${repo.path}/.kanna-worktrees/${item.branch}`;
  spawnShellSession(
    `shell-wt-${item.id}`, wtPath, item.port_env, true
  ).catch(e => console.error("[store] shell pre-warm failed:", e));
}

// Pre-warm repo root shell for each repo
for (const repo of eagerRepos) {
  spawnShellSession(
    `shell-repo-${repo.id}`, repo.path, null, false
  ).catch(e => console.error("[store] repo shell pre-warm failed:", e));
}
```

All spawns are fire-and-forget. The daemon rejects duplicate session IDs, providing natural dedup for sessions that survived handoff.

### Repo switch

When `selectedRepoId` changes, no action needed — each repo's shell is pre-warmed at startup. If a repo is added mid-session, spawn its `shell-repo-${repoId}` at that point.

## Shared Helper

Extract env-building logic from `ShellModal.spawnShell` into a reusable function in the store, since both the pre-spawn and the fallback spawn need the same env:

```typescript
async function spawnShellSession(
  sessionId: string,
  cwd: string,
  portEnv?: string | null,
  isWorktree = true,
): Promise<void> {
  const env: Record<string, string> = { TERM: "xterm-256color" };
  if (isWorktree) env.KANNA_WORKTREE = "1";
  if (portEnv) {
    try {
      Object.assign(env, JSON.parse(portEnv));
    } catch (e) {
      console.error("[store] failed to parse portEnv:", e);
    }
  }
  try {
    env.ZDOTDIR = await invoke<string>("ensure_term_init");
  } catch (e) {
    console.error("[store] failed to set up term init:", e);
  }
  await invoke("spawn_session", {
    sessionId,
    cwd,
    executable: "/bin/zsh",
    args: ["--login"],
    env,
    cols: 80,
    rows: 24,
  });
}
```

## Terminal Dimensions

Pre-spawned with 80x24 defaults. When the user opens the modal, `useTerminal` attaches and immediately calls `resize_session` with the actual terminal dimensions. The shell adapts via SIGWINCH. This already works for reattached sessions today.

## Attach Behavior: Clear+SIGWINCH

When `useTerminal` attaches to an existing session, it writes `\x1b[?25l\x1b[2J\x1b[H` (clear display) then does a SIGWINCH double-resize. This exists for Claude TUI reconnection. For pre-warmed shells:

1. `useTerminal` synchronously writes the clear-screen sequence to xterm.js
2. Daemon flushes `PreAttachBuffer` (zsh startup output + prompt) — reaches JS asynchronously via daemon socket → Tauri background reader → IPC event bridge
3. SIGWINCH fires, zsh redraws the prompt

The buffered output arrives after the clear — the user sees the prompt appear cleanly. No changes to `useTerminal` needed.

## ShellModal Changes

`ShellModal.spawnShell` becomes a thin wrapper around the shared `spawnShellSession` helper. It serves as the fallback path if attach fails (e.g., daemon restarted and lost sessions).

## Cleanup

### Existing bug: kill session ID mismatch

The store uses `shell-${item.id}` in kill calls (kanna.ts:584, 598, 780, 992), but the actual session ID is `shell-wt-${item.id}`. These kill calls are silently failing today. Fix all to use `shell-wt-${item.id}`.

### Task close/delete/merge

After fixing the ID mismatch above, the existing kill calls handle worktree shell cleanup.

### Repo root shell

No per-task cleanup needed — there's one repo root shell per repo, not per task. Kill `shell-repo-${repoId}` only when a repo is removed from Kanna.

### Daemon restart / handoff

Pre-warmed shells are normal daemon sessions. They survive `SCM_RIGHTS` handoff. On app startup after handoff, duplicate Spawn calls fail harmlessly — the daemon rejects duplicate session IDs, and the existing session is reused via attach.

## Resource Usage

Each idle zsh process uses ~1 MB of memory and one PTY fd pair. A user with 20 active tasks across 3 repos would have ~23 idle zsh processes — roughly 23 MB total. Negligible. No pool limit or LRU eviction needed.

## Edge Cases

### Shell exits before user opens modal

If the pre-warmed zsh exits (e.g., `.zshrc` error), the daemon sends `session_exit`. When the user later presses `⌘J`, attach fails, `useTerminal` falls back to spawning fresh. No special handling needed.

### Task without worktree

Pre-spawn only fires after `createWorktree()` succeeds. At startup, tasks without a `branch` field are skipped.

### Concurrent spawns

The agent PTY spawn (`${id}`) and shell pre-spawn (`shell-wt-${id}`) use different session IDs. No conflict.

### Worktree deleted while shell is alive

If a worktree is manually deleted, the pre-warmed shell has a stale cwd. The shell still functions — the user gets a prompt in a deleted directory. Worktree removal via the store's close/delete paths kills the shell session as part of cleanup.

## Files to Modify

- `apps/desktop/src/stores/kanna.ts` — add `spawnShellSession` helper, call it in `setupWorktreeAndSpawn()`, add startup pre-warm in `init()`, fix kill session IDs from `shell-${id}` to `shell-wt-${id}`
- `apps/desktop/src/components/ShellModal.vue` — use shared `spawnShellSession` helper as fallback
