# Pre-warmed Shell Terminals Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-spawn idle zsh PTY sessions so `⌘J` and `⇧⌘J` shell modals open instantly.

**Architecture:** Add a `spawnShellSession` helper to the store that spawns a bare `/bin/zsh --login` via the daemon. Call it at task creation (after worktree setup) and at app startup (for existing tasks + repo root shells). ShellModal uses the same helper as a fallback. Fix broken kill session IDs.

**Tech Stack:** Vue 3, TypeScript, Tauri invoke (daemon protocol)

**Spec:** `docs/superpowers/specs/2026-03-25-pre-warmed-shells-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/desktop/src/stores/kanna.ts` | Modify | Add `spawnShellSession` helper, pre-warm calls in `setupWorktreeAndSpawn()` and `init()`, fix kill session IDs |
| `apps/desktop/src/components/ShellModal.vue` | Modify | Replace inline `spawnShell` with import of shared helper from store |

---

### Task 1: Fix kill session ID mismatch (existing bug)

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:585,599,782,994`

- [ ] **Step 1: Fix all four kill calls**

Change `shell-${item.id}` / `shell-${originalId}` to `shell-wt-${item.id}` / `shell-wt-${originalId}` at each site:

```typescript
// Line 585 (closeTask — done branch)
invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((e: unknown) =>
  console.error("[store] kill shell session failed:", e)),

// Line 599 (closeTask — non-done branch)
invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((e: unknown) =>
  console.error("[store] kill shell session failed:", e)),

// Line 782 (startPrAgent)
await invoke("kill_session", { sessionId: `shell-wt-${originalId}` }).catch((e: unknown) => console.error("[store] kill shell session failed:", e));

// Line 994 (startMergeAgent)
await invoke("kill_session", { sessionId: `shell-wt-${originalId}` }).catch((e: unknown) =>
  console.error("[store] kill shell session failed:", e)
);
```

- [ ] **Step 2: Verify no other `shell-${` patterns exist**

Run: `grep -n 'shell-\${' apps/desktop/src/stores/kanna.ts`
Expected: No remaining `shell-${` (only `shell-wt-${` and `shell-repo-${`)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "fix: correct shell kill session IDs to match shell-wt- convention"
```

---

### Task 2: Add `spawnShellSession` helper to the store

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts` (add function near other spawn helpers, around line 386)

- [ ] **Step 1: Add the helper function**

Add `spawnShellSession` inside the `useKannaStore` function, near `spawnPtySession`:

```typescript
/** Spawn a bare zsh login shell in the daemon. Used for pre-warming and as ShellModal fallback. */
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

- [ ] **Step 2: Export `spawnShellSession` from the store return**

Add `spawnShellSession` to the return object (around line 1192):

```typescript
createItem, spawnPtySession, spawnShellSession, closeTask, undoClose,
```

- [ ] **Step 3: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: add spawnShellSession helper for pre-warmed shells"
```

---

### Task 3: Pre-warm worktree shell on task creation

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts` — `setupWorktreeAndSpawn()` (line ~291)

- [ ] **Step 1: Add pre-warm call after worktree creation**

In `setupWorktreeAndSpawn()`, after the `createWorktree()` try-catch block (line ~291) and before the agent spawn try-catch (line ~293), add:

```typescript
    // Pre-warm shell for ⌘J — fire-and-forget, runs in parallel with agent spawn
    spawnShellSession(`shell-wt-${id}`, worktreePath, JSON.stringify(portEnv))
      .catch(e => console.error("[store] shell pre-warm failed:", e));
```

- [ ] **Step 2: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: pre-warm worktree shell on task creation"
```

---

### Task 4: Pre-warm shells on app startup

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts` — `init()` (after line ~1125)

- [ ] **Step 1: Add startup pre-warm logic**

At the end of `init()`, after the window title block (line ~1125) and before the event listeners (line ~1127), add:

```typescript
    // Pre-warm shell sessions so ⌘J / ⇧⌘J are instant
    if (isTauri) {
      for (const item of eagerItems) {
        if (!item.branch) continue;
        const repo = eagerRepos.find(r => r.id === item.repo_id);
        if (!repo) continue;
        const wtPath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        spawnShellSession(`shell-wt-${item.id}`, wtPath, item.port_env, true)
          .catch(e => console.error("[store] shell pre-warm failed:", e));
      }
      for (const repo of eagerRepos) {
        spawnShellSession(`shell-repo-${repo.id}`, repo.path, null, false)
          .catch(e => console.error("[store] repo shell pre-warm failed:", e));
      }
    }
```

- [ ] **Step 2: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: pre-warm all shell sessions on app startup"
```

---

### Task 5: Pre-warm repo root shell on repo add

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts` — `importRepo()` and `createRepo()`

- [ ] **Step 1: Add pre-warm after repo insert in `importRepo()`**

After `selectedRepoId.value = id;` (line ~173), add:

```typescript
    if (isTauri) {
      spawnShellSession(`shell-repo-${id}`, path, null, false)
        .catch(e => console.error("[store] repo shell pre-warm failed:", e));
    }
```

- [ ] **Step 2: Add pre-warm after repo insert in `createRepo()`**

Same pattern after `selectedRepoId.value = id;` in `createRepo()`.

- [ ] **Step 3: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: pre-warm repo root shell on repo add"
```

---

### Task 6: Refactor ShellModal to use shared helper

**Files:**
- Modify: `apps/desktop/src/components/ShellModal.vue`
- Modify: `apps/desktop/src/stores/kanna.ts` (already exports `spawnShellSession`)

- [ ] **Step 1: Replace inline `spawnShell` with store helper**

Replace the `spawnShell` function in `ShellModal.vue` with a call to the store's `spawnShellSession`:

```vue
<script setup lang="ts">
import { ref, onMounted, onActivated, onDeactivated, nextTick } from "vue";
import TerminalView from "./TerminalView.vue";
import { useShortcutContext, setContext, resetContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
import { useKannaStore } from "../stores/kanna";

const props = defineProps<{
  sessionId: string;
  cwd: string;
  portEnv?: string | null;
  maximized?: boolean;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const termRef = ref<InstanceType<typeof TerminalView> | null>(null);
const store = useKannaStore();

useShortcutContext("shell");
const { zIndex, bringToFront } = useModalZIndex();
defineExpose({ zIndex, bringToFront });

// KeepAlive: onUnmounted won't fire on hide, so manage context on activate/deactivate too
onActivated(() => setContext("shell"));
onDeactivated(() => resetContext());

onMounted(async () => {
  await nextTick();
  termRef.value?.focus();
});

onActivated(async () => {
  await nextTick();
  termRef.value?.fit?.();
  termRef.value?.focus();
});

async function spawnShell(sessionId: string, cwd: string, _prompt: string, _cols: number, _rows: number) {
  const isWorktree = !sessionId.startsWith("shell-repo-");
  await store.spawnShellSession(sessionId, cwd, props.portEnv, isWorktree);
}
</script>
```

Note: The `cols` and `rows` params from `useTerminal`'s `spawnFn` signature are unused — `spawnShellSession` uses 80x24 defaults and `useTerminal` immediately resizes after attach.

- [ ] **Step 2: Remove the `invoke` import**

The `invoke` import is no longer needed in ShellModal since `spawnShellSession` handles it internally.

- [ ] **Step 3: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/ShellModal.vue
git commit -m "refactor: ShellModal uses shared spawnShellSession helper"
```

---

### Task 7: Manual verification

- [ ] **Step 1: Start the dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Create a new task and verify pre-warm**

Create a task. Before pressing `⌘J`, check daemon logs (`~/Library/Application Support/Kanna/kanna-daemon_*.log` or `{worktree}/.kanna-daemon/`) for the `shell-wt-{taskId}` session spawn.

- [ ] **Step 3: Press `⌘J` and verify instant shell**

Press `⌘J`. The shell should appear with a prompt instantly (no zsh startup delay). The terminal output should show the prompt from the `PreAttachBuffer` flush.

- [ ] **Step 4: Press `⇧⌘J` and verify instant repo root shell**

Press `⇧⌘J`. Same behavior — instant prompt.

- [ ] **Step 5: Close a task and verify cleanup**

Close a task. Verify the `shell-wt-{taskId}` session is killed (check daemon logs or `list_sessions`).

- [ ] **Step 6: Restart the app and verify startup pre-warm**

Stop and restart the dev server. Existing tasks should get pre-warmed shells on startup. Press `⌘J` on any task — should be instant.

- [ ] **Step 7: Commit any fixes if needed, then final commit**

```bash
git add -A
git commit -m "feat: pre-warmed shell terminals for instant ⌘J / ⇧⌘J"
```
