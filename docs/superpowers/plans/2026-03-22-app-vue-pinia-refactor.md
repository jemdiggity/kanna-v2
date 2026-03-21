# App.vue Pinia Store Refactor — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all persistent state and DB logic from App.vue into a Pinia store with reactive async computed properties, reducing App.vue to a UI shell.

**Architecture:** Single Pinia setup store (`useKannaStore`) owns DB handle, repos, pipeline items, preferences, and event listeners. DB handle resolved before app mount via async bootstrap in main.ts. VueUse `computedAsync` replaces manual refresh calls.

**Tech Stack:** Vue 3, Pinia, @vueuse/core (computedAsync), TypeScript, @kanna/db

**Spec:** `docs/superpowers/specs/2026-03-22-app-vue-pinia-refactor-design.md`

---

### Task 0: Install dependencies

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add pinia and @vueuse/core**

```bash
cd apps/desktop && bun add pinia @vueuse/core
```

- [ ] **Step 2: Verify installation**

```bash
cd apps/desktop && bun install
```

Expected: Clean install, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json apps/desktop/bun.lock
git commit -m "deps: add pinia and @vueuse/core"
```

---

### Task 1: Create DB bootstrap module

Extract DB loading and migrations from App.vue into a standalone module that main.ts can call before mounting.

**Files:**
- Create: `apps/desktop/src/stores/db.ts`

- [ ] **Step 1: Create `stores/db.ts`**

This module exports two functions:
- `loadDatabase()` — resolves DB name (env vars, worktree detection), runs backup, loads Tauri SQL plugin or mock. Returns `{ db: DbHandle, dbName: string }`.
- `runMigrations(db: DbHandle)` — all CREATE TABLE + ALTER TABLE statements from App.vue's `runMigrations()`.

```typescript
import { isTauri, getMockDatabase } from "../tauri-mock";
import { invoke } from "../invoke";
import { backupOnStartup } from "../composables/useBackup";
import type { DbHandle } from "@kanna/db";

export async function resolveDbName(): Promise<string> {
  if (!isTauri) return "mock";

  let dbName = "kanna-v2.db";
  try {
    const envDb = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" });
    if (envDb) dbName = envDb;
  } catch (e) {
    console.debug("[db] KANNA_DB_NAME not set:", e);
  }

  try {
    const wt = await invoke<string>("read_env_var", { name: "KANNA_WORKTREE" });
    if (wt) {
      const daemonDir = await invoke<string>("read_env_var", { name: "KANNA_DAEMON_DIR" }).catch(() => "");
      let suffix = Date.now().toString();
      if (daemonDir) {
        const parts = daemonDir.split("/");
        const idx = parts.indexOf(".kanna-daemon");
        if (idx > 0) suffix = parts[idx - 1];
      }
      dbName = `kanna-wt-${suffix}.db`;
    }
  } catch (e) {
    console.debug("[db] KANNA_WORKTREE not set:", e);
  }

  return dbName;
}

export async function loadDatabase(): Promise<{ db: DbHandle; dbName: string }> {
  const dbName = await resolveDbName();

  if (!isTauri) {
    const db = getMockDatabase() as unknown as DbHandle;
    return { db, dbName };
  }

  console.log("[db] using database:", dbName);
  await backupOnStartup(dbName);
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const db = (await Database.load(`sqlite:${dbName}`)) as unknown as DbHandle;
  return { db, dbName };
}

export async function runMigrations(db: DbHandle): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER, issue_title TEXT, prompt TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
    branch TEXT, agent_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS worktree (
    id TEXT PRIMARY KEY, pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS terminal_session (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
    label TEXT, cwd TEXT, daemon_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER,
    status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT, error TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5')`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30')`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code')`);

  // Column migrations — expected to fail if already applied
  const addColumn = async (table: string, col: string, def: string) => {
    try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
    catch { console.debug(`[db] column ${table}.${col} already exists`); }
  };
  await addColumn("pipeline_item", "activity", "TEXT NOT NULL DEFAULT 'idle'");
  await addColumn("pipeline_item", "activity_changed_at", "TEXT");
  await addColumn("pipeline_item", "port_offset", "INTEGER");
  await addColumn("pipeline_item", "port_env", "TEXT");
  await addColumn("pipeline_item", "pinned", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("pipeline_item", "pin_order", "INTEGER");
  await addColumn("pipeline_item", "display_name", "TEXT");
  await addColumn("repo", "hidden", "INTEGER NOT NULL DEFAULT 0");

  // Stage migration
  try {
    await db.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
    await db.execute(`UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`);
  } catch (e) { console.debug("[db] stage migration:", e); }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/desktop && bunx vue-tsc --noEmit
```

Expected: No errors related to `stores/db.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/db.ts
git commit -m "refactor: extract DB bootstrap into stores/db.ts"
```

---

### Task 2: Create the Pinia store

The core of the refactor. Creates `useKannaStore` with all state, getters, and actions.

**Files:**
- Create: `apps/desktop/src/stores/kanna.ts`

- [ ] **Step 1: Create `stores/kanna.ts` with state and getters**

The store uses a module-level `_db` variable set by `init()`. State uses `computedAsync` for repos and items.

```typescript
import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { computedAsync } from "@vueuse/core";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import { parseRepoConfig } from "@kanna/core";
import type { RepoConfig } from "@kanna/core";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
import {
  listRepos, insertRepo, findRepoByPath,
  hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery,
  listPipelineItems, insertPipelineItem, updatePipelineItemStage,
  updatePipelineItemActivity, pinPipelineItem, unpinPipelineItem,
  reorderPinnedItems, updatePipelineItemDisplayName,
  getRepo, getSetting, setSetting,
} from "@kanna/db";

// Module-level DB handle — set once by init(), never null after that.
let _db: DbHandle;

export const useKannaStore = defineStore("kanna", () => {
  // ── Refresh trigger ──────────────────────────────────────────────
  const refreshKey = ref(0);
  function bump() { refreshKey.value++; }

  // ── Reactive DB reads ────────────────────────────────────────────
  const repos = computedAsync(async () => {
    refreshKey.value; // subscribe to trigger
    if (!_db) return [];
    return await listRepos(_db);
  }, []);

  const items = computedAsync(async () => {
    refreshKey.value;
    if (!_db || repos.value.length === 0) return [];
    const loaded: PipelineItem[] = [];
    for (const repo of repos.value) {
      loaded.push(...await listPipelineItems(_db, repo.id));
    }
    return loaded;
  }, []);

  // ── Selection state ──────────────────────────────────────────────
  const selectedRepoId = ref<string | null>(null);
  const selectedItemId = ref<string | null>(null);

  // ── Preferences ──────────────────────────────────────────────────
  const ideCommand = ref("code");
  const gcAfterDays = ref(3);
  const hideShortcutsOnStartup = ref(false);

  // ── Undo state ───────────────────────────────────────────────────
  const lastUndoAction = ref<{ type: "hideRepo"; repoId: string } | null>(null);

  // ── Computed getters ─────────────────────────────────────────────
  const selectedRepo = computed(() =>
    repos.value.find((r) => r.id === selectedRepoId.value) ?? null
  );

  const currentItem = computed(() => {
    if (!selectedItemId.value) return null;
    const item = items.value.find((i) => i.id === selectedItemId.value);
    return item && item.stage !== "done" ? item : null;
  });

  const sortedItemsForCurrentRepo = computed(() => {
    const repoItems = items.value.filter(
      (item) => item.repo_id === selectedRepoId.value && item.stage !== "done"
    );
    const pinned = repoItems
      .filter((i) => i.pinned)
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    const activityOrder: Record<string, number> = { idle: 0, unread: 1, working: 2 };
    const unpinned = repoItems
      .filter((i) => !i.pinned)
      .sort((a, b) => {
        const ao = activityOrder[a.activity || "idle"] ?? 0;
        const bo = activityOrder[b.activity || "idle"] ?? 0;
        if (ao !== bo) return ao - bo;
        const aTime = a.activity_changed_at || a.created_at;
        const bTime = b.activity_changed_at || b.created_at;
        return bTime.localeCompare(aTime);
      });
    return [...pinned, ...unpinned];
  });

  // ── Actions: Selection ───────────────────────────────────────────
  async function selectRepo(repoId: string) {
    selectedRepoId.value = repoId;
    await setSetting(_db, "selected_repo_id", repoId);
  }

  async function selectItem(itemId: string) {
    selectedItemId.value = itemId;
    await setSetting(_db, "selected_item_id", itemId);
    const item = items.value.find((i) => i.id === itemId);
    if (item && item.activity === "unread") {
      await updatePipelineItemActivity(_db, itemId, "idle");
      bump();
    }
  }

  // ── Actions: Repo management ─────────────────────────────────────
  async function importRepo(path: string, name: string, defaultBranch: string) {
    const existing = await findRepoByPath(_db, path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(_db, existing.id);
        bump();
        selectedRepoId.value = existing.id;
      }
      return;
    }
    const id = crypto.randomUUID();
    await insertRepo(_db, { id, path, name, default_branch: defaultBranch });
    bump();
    selectedRepoId.value = id;
  }

  async function hideRepo(repoId: string) {
    await hideRepoQuery(_db, repoId);
    if (selectedRepoId.value === repoId) selectedRepoId.value = null;
    lastUndoAction.value = { type: "hideRepo", repoId };
    bump();
  }

  // ── Actions: Pipeline CRUD ───────────────────────────────────────
  async function createItem(
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType: "pty" | "sdk" = "pty",
    opts?: { baseBranch?: string; stage?: string },
  ) {
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;

    // Read .kanna/config.json
    let repoConfig: RepoConfig = {};
    try {
      const configContent = await invoke<string>("read_text_file", {
        path: `${repoPath}/.kanna/config.json`,
      });
      if (configContent) repoConfig = parseRepoConfig(configContent);
    } catch (e) {
      console.debug("[store] no .kanna/config.json:", e);
    }

    // Assign port offset
    const usedOffsets = new Set(
      items.value.map((i) => i.port_offset).filter((o): o is number => o != null)
    );
    let portOffset = 1;
    while (usedOffsets.has(portOffset)) portOffset++;

    // Create git worktree
    const worktreeAddCwd = opts?.baseBranch
      ? `${repoPath}/.kanna-worktrees/${opts.baseBranch}`
      : repoPath;
    try {
      await invoke("git_worktree_add", {
        repoPath: worktreeAddCwd,
        branch,
        path: worktreePath,
        startPoint: opts?.baseBranch ? "HEAD" : null,
      });
    } catch (e) {
      console.error("[store] git_worktree_add failed:", e);
      throw e;
    }

    // Compute port env
    const portEnv: Record<string, string> = {};
    if (repoConfig.ports) {
      for (const [name, base] of Object.entries(repoConfig.ports)) {
        portEnv[name] = String(base + portOffset);
      }
    }

    // Insert DB record
    try {
      await insertPipelineItem(_db, {
        id,
        repo_id: repoId,
        issue_number: null,
        issue_title: null,
        prompt,
        stage: opts?.stage || "in_progress",
        pr_number: null,
        pr_url: null,
        branch,
        agent_type: agentType,
        port_offset: portOffset,
        port_env: Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null,
        activity: "working",
      });
    } catch (e) {
      console.error("[store] DB insert failed:", e);
      throw e;
    }

    // Refresh before spawn (spawnPtySession reads port_env from items)
    bump();

    // Spawn agent
    if (agentType !== "pty") {
      await invoke("create_agent_session", {
        sessionId: id,
        cwd: worktreePath,
        prompt,
        systemPrompt: null,
        permissionMode: "dontAsk",
      });
    } else {
      try {
        await spawnPtySession(id, worktreePath, prompt);
      } catch (e) {
        console.warn("[store] PTY pre-spawn failed, will retry on mount:", e);
      }
    }

    selectedItemId.value = id;
  }

  async function spawnPtySession(sessionId: string, cwd: string, prompt: string, cols = 80, rows = 24, model?: string) {
    let kannaHookPath: string;
    try {
      kannaHookPath = await invoke<string>("which_binary", { name: "kanna-hook" });
    } catch {
      throw new Error("kanna-hook binary not found. Ensure it is built (cargo build -p kanna-hook).");
    }

    const hookSettings = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${kannaHookPath} SessionStart ${sessionId}` }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `${kannaHookPath} UserPromptSubmit ${sessionId}` }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: `${kannaHookPath} Stop ${sessionId}` }] },
        ],
        StopFailure: [
          { hooks: [{ type: "command", command: `${kannaHookPath} StopFailure ${sessionId}` }] },
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: `${kannaHookPath} PostToolUse ${sessionId}` }] },
        ],
        PreToolUse: [
          { matcher: "AskUserQuestion", hooks: [{ type: "command", command: `${kannaHookPath} WaitingForInput ${sessionId}` }] },
        ],
        Notification: [
          { hooks: [{ type: "command", command: `${kannaHookPath} WaitingForInput ${sessionId}` }] },
        ],
      },
    });

    const env: Record<string, string> = { TERM: "xterm-256color", TERM_PROGRAM: "vscode" };
    let setupCmds: string[] = [];
    const item = items.value.find((i) => i.id === sessionId);
    if (item) {
      if (item.port_env) {
        try {
          Object.assign(env, JSON.parse(item.port_env));
        } catch (e) { console.error("[store] failed to parse port_env:", e); }
      }
      try {
        const repo = await getRepo(_db, item.repo_id);
        if (repo) {
          const configContent = await invoke<string>("read_text_file", {
            path: `${repo.path}/.kanna/config.json`,
          });
          if (configContent) {
            const repoConfig = parseRepoConfig(configContent);
            if (repoConfig.setup?.length) setupCmds = repoConfig.setup;
          }
        }
      } catch (e) { console.error("[store] failed to read setup config:", e); }
    }

    env.KANNA_WORKTREE = "1";

    const modelFlag = model ? ` --model ${model}` : "";
    const claudeCmd = `claude --dangerously-skip-permissions${modelFlag} --settings '${hookSettings}' '${prompt.replace(/'/g, "'\\''")}'`;
    const fullCmd = [...setupCmds, claudeCmd].join(" && ");

    await invoke("spawn_session", {
      sessionId,
      cwd,
      executable: "/bin/zsh",
      args: ["--login", "-c", fullCmd],
      env,
      cols,
      rows,
    });
  }

  async function closeTask() {
    lastUndoAction.value = null;
    const item = currentItem.value;
    const repo = selectedRepo.value;
    if (!item || !repo) return;
    try {
      await invoke("kill_session", { sessionId: item.id }).catch((e: unknown) => console.error("[store] kill_session failed:", e));
      await invoke("kill_session", { sessionId: `shell-${item.id}` }).catch((e: unknown) => console.error("[store] kill shell session failed:", e));

      if (item.stage === "in_progress") {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        try {
          const configContent = await invoke<string>("read_text_file", {
            path: `${repo.path}/.kanna/config.json`,
          });
          if (configContent) {
            const repoConfig = parseRepoConfig(configContent);
            if (repoConfig.teardown?.length) {
              for (const cmd of repoConfig.teardown) {
                await invoke("run_script", { script: cmd, cwd: worktreePath, env: { KANNA_WORKTREE: "1" } });
              }
            }
          }
        } catch (e) { console.error("[store] teardown failed:", e); }
      }

      await updatePipelineItemStage(_db, item.id, "done");
      bump();

      // Select next item
      const remaining = sortedItemsForCurrentRepo.value.filter((i) => i.id !== item.id);
      const firstIdle = remaining.find((i) => i.activity === "idle" || !i.activity);
      selectedItemId.value = (firstIdle || remaining[0])?.id || null;
    } catch (e) {
      console.error("[store] close failed:", e);
    }
  }

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
        "SELECT * FROM pipeline_item WHERE stage = 'done' ORDER BY updated_at DESC LIMIT 1"
      );
      const item = rows[0];
      if (!item?.branch) return;
      const repo = repos.value.find((r) => r.id === item.repo_id);
      if (!repo) return;
      await updatePipelineItemStage(_db, item.id, "in_progress");
      await updatePipelineItemActivity(_db, item.id, "working");
      const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
      await spawnPtySession(item.id, worktreePath, item.prompt || "");
      selectedItemId.value = item.id;
      bump();
    } catch (e) {
      console.error("[store] undo close failed:", e);
    }
  }

  async function startPrAgent(itemId: string, repoId: string, repoPath: string) {
    const item = items.value.find((i) => i.id === itemId);
    if (!item?.branch) return;

    const sourceWorktree = `${repoPath}/.kanna-worktrees/${item.branch}`;
    const prompt = [
      `You are in a worktree branched from "${item.branch}".`,
      `Your job is to create a GitHub pull request for that work.`,
      `IMPORTANT: First, check for uncommitted changes in the source worktree at "${sourceWorktree}" by running "git -C ${sourceWorktree} status".`,
      `If there are uncommitted changes there, commit them from that worktree: "git -C ${sourceWorktree} add -A && git -C ${sourceWorktree} commit -m '<appropriate message>'", then pull those commits into your branch: "git pull --rebase".`,
      `Then:`,
      `1. Rename this branch to something meaningful based on the commits (use "git branch -m <new-name>").`,
      `2. Push the branch (git push -u origin HEAD).`,
      `3. Create a PR with "gh pr create" — write a clear title and description summarizing the changes.`,
    ].join("\n");

    await createItem(repoId, repoPath, prompt, "pty", { baseBranch: item.branch, stage: "pr" });
  }

  async function startMergeAgent(repoId: string, repoPath: string) {
    const prompt = [
      `You are a merge agent. Your job is to safely merge pull requests without breaking the target branch.`,
      ``,
      `## Process`,
      ``,
      `1. Ask the user which PR(s) to merge and the target branch (default: main).`,
      ``,
      `2. Your worktree is your staging area. Fetch and reset it to the latest origin target branch.`,
      ``,
      `3. Determine what checks to run:`,
      `   a. Check .kanna/config.json for a configured test script (the "test" field, an array of shell commands).`,
      `   b. If none, discover what checks the repo has (CI config, test scripts, Makefile, etc.).`,
      `   c. If you can't determine what to run, ask the user.`,
      ``,
      `4. For each PR, sequentially:`,
      `   a. Rebase the PR branch onto your worktree's HEAD.`,
      `   b. If there are conflicts, attempt to resolve them. Show the user your resolutions and get approval before continuing.`,
      `   c. Run the checks determined in step 3.`,
      `   d. If checks fail, attempt to fix the issue. Show the user your fix and get approval before continuing.`,
      `   e. If checks pass, merge the PR to the target branch on origin.`,
      `   f. Update your worktree HEAD to match the new origin target branch.`,
      `   g. Delete the merged remote branch.`,
      ``,
      `5. Report results — which PRs merged, which failed, and why.`,
      ``,
      `## Principles`,
      ``,
      `- Each PR is merged individually. Don't hold passing PRs hostage to failing ones.`,
      `- Always rebase onto the latest target branch before running checks.`,
      `- Work in your worktree. Never modify the user's local main.`,
      `- When in doubt, ask the user. Don't force-push, skip tests, or resolve ambiguous conflicts silently.`,
      `- Keep the user informed of progress but don't be verbose.`,
      `- If gh CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.`,
    ].join("\n");

    await createItem(repoId, repoPath, prompt, "pty", { stage: "merge" });
  }

  async function pinItem(itemId: string, position: number) {
    await pinPipelineItem(_db, itemId, position);
    bump();
  }

  async function unpinItem(itemId: string) {
    await unpinPipelineItem(_db, itemId);
    bump();
  }

  async function reorderPinned(repoId: string, orderedIds: string[]) {
    await reorderPinnedItems(_db, repoId, orderedIds);
    bump();
  }

  async function renameItem(itemId: string, displayName: string | null) {
    await updatePipelineItemDisplayName(_db, itemId, displayName);
    bump();
  }

  // ── Actions: Preferences ─────────────────────────────────────────
  async function loadPreferences() {
    const ide = await getSetting(_db, "ideCommand");
    if (ide) ideCommand.value = ide;
    const gc = await getSetting(_db, "gcAfterDays");
    if (gc) gcAfterDays.value = parseInt(gc, 10) || 3;
    const hs = await getSetting(_db, "hideShortcutsOnStartup");
    hideShortcutsOnStartup.value = hs === "true";
  }

  async function savePreference(key: string, value: string) {
    await setSetting(_db, key, value);
    await loadPreferences();
  }

  // ── Actions: Make PR (keyboard shortcut) ─────────────────────────
  async function makePR() {
    const item = currentItem.value;
    const repo = selectedRepo.value;
    if (!item || !repo) return;
    const originalId = item.id;
    try {
      await startPrAgent(originalId, repo.id, repo.path);
    } catch (e) {
      console.error("[store] PR agent failed to start:", e);
    }
    try {
      await invoke("kill_session", { sessionId: originalId }).catch((e: unknown) => console.error("[store] kill_session failed:", e));
      await invoke("kill_session", { sessionId: `shell-${originalId}` }).catch((e: unknown) => console.error("[store] kill shell session failed:", e));
      await updatePipelineItemStage(_db, originalId, "done");
      bump();
    } catch (e) {
      console.error("[store] failed to close source task:", e);
    }
  }

  async function mergeQueue() {
    if (!selectedRepoId.value) {
      if (repos.value.length === 1) {
        selectedRepoId.value = repos.value[0].id;
      } else {
        alert("Select a repository first");
        return;
      }
    }
    const repo = repos.value.find((r) => r.id === selectedRepoId.value);
    if (!repo) return;
    try {
      await startMergeAgent(repo.id, repo.path);
    } catch (e) {
      console.error("[store] merge agent failed to start:", e);
    }
  }

  // ── Event handlers ───────────────────────────────────────────────
  function _handleAgentFinished(sessionId: string) {
    const item = items.value.find((i) => i.id === sessionId);
    if (!item) return;
    const activity = selectedItemId.value === sessionId ? "idle" : "unread";
    updatePipelineItemActivity(_db, item.id, activity).catch((e) =>
      console.error("[store] activity update failed:", e)
    );
    bump();
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  async function init(db: DbHandle) {
    _db = db;

    await loadPreferences();

    // Transition stale "working" items to "unread"
    const workingItems = await _db.select<PipelineItem>(
      "SELECT * FROM pipeline_item WHERE activity = 'working'"
    );
    for (const item of workingItems) {
      await updatePipelineItemActivity(_db, item.id, "unread");
    }

    // GC: remove done tasks older than gcAfterDays
    const cutoff = new Date(Date.now() - gcAfterDays.value * 86400000).toISOString();
    const stale = await _db.select<PipelineItem>(
      "SELECT * FROM pipeline_item WHERE stage = 'done' AND updated_at < ?",
      [cutoff]
    );
    for (const item of stale) {
      if (item.branch) {
        const repo = repos.value.find((r) => r.id === item.repo_id);
        if (repo) {
          const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
          await invoke("git_worktree_remove", { repoPath: repo.path, path: worktreePath }).catch((e: unknown) =>
            console.error("[store] worktree remove failed:", e)
          );
        }
      }
      await _db.execute("DELETE FROM pipeline_item WHERE id = ?", [item.id]);
    }
    if (stale.length > 0) {
      console.log(`[gc] cleaned up ${stale.length} done task(s)`);
    }

    // Trigger initial data load
    bump();

    // Restore persisted selection
    const savedRepo = await getSetting(_db, "selected_repo_id");
    const savedItem = await getSetting(_db, "selected_item_id");
    if (savedRepo && repos.value.some((r) => r.id === savedRepo)) {
      selectedRepoId.value = savedRepo;
      if (savedItem && items.value.some((i) => i.id === savedItem)) {
        selectedItemId.value = savedItem;
      }
    }

    // Set window title for non-main branches
    if (isTauri) {
      try {
        const info = await invoke<{ branch: string; commit_hash: string; version: string }>("git_app_info");
        if (info.branch !== "main" && info.branch !== "master") {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setTitle(`Kanna — ${info.branch} (${info.version} @ ${info.commit_hash})`);
        }
      } catch (e) { console.error("[store] git_app_info failed:", e); }
    }

    // Event listeners
    listen("hook_event", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      const hookEvent = payload.event;
      if (!sessionId) return;

      const item = items.value.find((i) => i.id === sessionId);
      if (!item) return;

      if (hookEvent === "Stop" || hookEvent === "StopFailure") {
        _handleAgentFinished(sessionId);
      } else if (hookEvent === "WaitingForInput") {
        await updatePipelineItemActivity(_db, item.id, "unread");
        bump();
      } else if (hookEvent === "PostToolUse") {
        await updatePipelineItemActivity(_db, item.id, "working");
        bump();
      }
    });

    listen("session_exit", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      if (!sessionId) return;
      _handleAgentFinished(sessionId);
    });
  }

  return {
    // State
    repos, items, selectedRepoId, selectedItemId,
    ideCommand, gcAfterDays, hideShortcutsOnStartup,
    lastUndoAction, refreshKey,
    // Getters
    selectedRepo, currentItem, sortedItemsForCurrentRepo,
    // Actions
    bump, init,
    selectRepo, selectItem,
    importRepo, hideRepo,
    createItem, spawnPtySession, closeTask, undoClose,
    startPrAgent, startMergeAgent, makePR, mergeQueue,
    pinItem, unpinItem, reorderPinned, renameItem,
    savePreference,
  };
});
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/desktop && bunx vue-tsc --noEmit
```

Expected: No errors related to `stores/kanna.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: create useKannaStore Pinia store with computedAsync"
```

---

### Task 3: Update main.ts bootstrap

Wire up async DB loading and Pinia before mount.

**Files:**
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Rewrite main.ts**

```typescript
import { createApp } from "vue";
import { createPinia } from "pinia";
import { isTauri } from "./tauri-mock";
import { loadDatabase, runMigrations } from "./stores/db";
import App from "./App.vue";

if (isTauri) {
  const { invoke } = await import("@tauri-apps/api/core");

  function forwardLog(level: string, origFn: (...args: any[]) => void) {
    return (...args: any[]) => {
      origFn.apply(console, args);
      const msg = args.map(a => {
        try { return typeof a === "string" ? a : JSON.stringify(a); }
        catch { return String(a); }
      }).join(" ");
      invoke("append_log", { message: `[${level}] ${msg}` }).catch(() => {});
    };
  }

  console.log = forwardLog("LOG", console.log);
  console.warn = forwardLog("WARN", console.warn);
  console.error = forwardLog("ERROR", console.error);

  window.addEventListener("error", (e) => {
    invoke("append_log", { message: `[UNCAUGHT] ${e.message} at ${e.filename}:${e.lineno}` }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    invoke("append_log", { message: `[UNHANDLED_REJECTION] ${e.reason}` }).catch(() => {});
  });
} else {
  console.log("[kanna] Running in browser mode with mock Tauri APIs");
}

try {
  const { db, dbName } = await loadDatabase();
  await runMigrations(db);

  const app = createApp(App);
  app.use(createPinia());
  app.provide("db", db);
  app.provide("dbName", dbName);
  app.mount("#app");
} catch (e) {
  console.error("[init] fatal:", e);
  const el = document.getElementById("app");
  if (el) el.textContent = `Failed to initialize: ${e}`;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/desktop && bunx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "refactor: async DB bootstrap with Pinia in main.ts"
```

---

### Task 4: Rewrite App.vue as UI shell

Replace all data logic with store usage. This is the largest single change.

**Files:**
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Rewrite App.vue**

The new App.vue keeps only UI state, keyboard wiring, and the template. All data logic comes from `useKannaStore()`.

```vue
<script setup lang="ts">
import { ref, computed, inject, onMounted, nextTick } from "vue";
import { isTauri } from "./tauri-mock";
import { invoke } from "./invoke";
import type { DbHandle } from "@kanna/db";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import ImportRepoModal from "./components/ImportRepoModal.vue";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.vue";
import FilePickerModal from "./components/FilePickerModal.vue";
import FilePreviewModal from "./components/FilePreviewModal.vue";
import DiffModal from "./components/DiffModal.vue";
import ShellModal from "./components/ShellModal.vue";
import CommandPaletteModal from "./components/CommandPaletteModal.vue";
import { useKeyboardShortcuts, type ActionName } from "./composables/useKeyboardShortcuts";
import { startPeriodicBackup } from "./composables/useBackup";
import { useKannaStore } from "./stores/kanna";

const store = useKannaStore();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;

// UI state
const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const showShortcutsModal = ref(false);
const showFilePickerModal = ref(false);
const showFilePreviewModal = ref(false);
const previewFilePath = ref("");
const showDiffModal = ref(false);
const showShellModal = ref(false);
const showCommandPalette = ref(false);
const diffScopes = new Map<string, "branch" | "commit" | "working">();
const zenMode = ref(false);
const maximized = ref(false);

// Navigation
function navigateItems(direction: -1 | 1) {
  const currentItems = store.sortedItemsForCurrentRepo;
  if (currentItems.length === 0) return;
  const currentIndex = currentItems.findIndex((i) => i.id === store.selectedItemId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentItems.length) nextIndex = currentItems.length - 1;
  }
  store.selectedItemId = currentItems[nextIndex].id;
}

// Keyboard shortcuts
const keyboardActions = {
  newTask: () => { showNewTaskModal.value = true; },
  newWindow: async () => {
    if (isTauri) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      new WebviewWindow(`window-${Date.now()}`, {
        url: "/", title: "", width: 1200, height: 800, minWidth: 800, minHeight: 600,
      });
    } else {
      window.open(window.location.href, "_blank");
    }
  },
  openFile: () => {
    if (showFilePreviewModal.value) {
      showFilePreviewModal.value = false;
      showFilePickerModal.value = true;
    } else {
      showFilePickerModal.value = !showFilePickerModal.value;
    }
  },
  openInIDE: async () => {
    const item = store.currentItem;
    const repo = store.selectedRepo;
    if (!item?.branch || !repo) return;
    const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
    await invoke("run_script", { script: `${store.ideCommand} "${worktreePath}"`, cwd: worktreePath, env: {} }).catch(() => {});
  },
  makePR: () => store.makePR(),
  mergeQueue: () => store.mergeQueue(),
  closeTask: () => store.closeTask(),
  undoClose: () => store.undoClose(),
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  toggleZen: () => { zenMode.value = !zenMode.value; },
  toggleMaximize: () => { maximized.value = !maximized.value; },
  dismiss: () => {
    if (showCommandPalette.value) { showCommandPalette.value = false; return; }
    if (showShortcutsModal.value) { showShortcutsModal.value = false; return; }
    if (showFilePreviewModal.value) { showFilePreviewModal.value = false; return; }
    if (showFilePickerModal.value) { showFilePickerModal.value = false; return; }
    if (showDiffModal.value) { showDiffModal.value = false; maximized.value = false; return; }
    if (showShellModal.value) { return; }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; return; }
    if (showImportRepoModal.value) { showImportRepoModal.value = false; return; }
  },
  openShell: () => { showShellModal.value = !showShellModal.value; },
  showDiff: () => { showDiffModal.value = !showDiffModal.value; },
  showShortcuts: () => { showShortcutsModal.value = !showShortcutsModal.value; },
  commandPalette: () => { showCommandPalette.value = !showCommandPalette.value; },
};
useKeyboardShortcuts(keyboardActions);

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

// Handlers that mix UI state + store
async function handleNewTaskSubmit(prompt: string) {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert("Select a repository first");
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, prompt);
    showNewTaskModal.value = false;
  } catch (e: any) {
    console.error("Task creation failed:", e);
    alert(`Task creation failed: ${e?.message || e}`);
  }
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await store.importRepo(path, name, defaultBranch);
  showImportRepoModal.value = false;
}

// Init
onMounted(async () => {
  await store.init(db);
  startPeriodicBackup(dbName, { value: db });
  if (!store.hideShortcutsOnStartup) {
    showShortcutsModal.value = true;
  }
});
</script>

<template>
  <div class="app" :class="{ zen: zenMode }">
    <Sidebar
      v-if="!zenMode && !maximized"
      :repos="store.repos"
      :pipeline-items="store.items"
      :selected-repo-id="store.selectedRepoId"
      :selected-item-id="store.selectedItemId"
      @select-repo="store.selectRepo"
      @select-item="store.selectItem"
      @import-repo="showImportRepoModal = true"
      @new-task="(repoId: string) => { store.selectedRepoId = repoId; showNewTaskModal = true; }"
      @pin-item="store.pinItem"
      @unpin-item="store.unpinItem"
      @reorder-pinned="store.reorderPinned"
      @rename-item="store.renameItem"
      @hide-repo="store.hideRepo"
    />
    <MainPanel
      :item="store.currentItem"
      :repo-path="store.selectedRepo?.path"
      :spawn-pty-session="store.spawnPtySession"
      :maximized="maximized"
      @close-task="store.closeTask"
      @agent-completed="store.bump"
    />

    <NewTaskModal
      v-if="showNewTaskModal"
      @submit="handleNewTaskSubmit"
      @cancel="showNewTaskModal = false"
    />
    <ImportRepoModal
      v-if="showImportRepoModal"
      @import="handleImportRepo"
      @cancel="showImportRepoModal = false"
    />
    <CommandPaletteModal
      v-if="showCommandPalette"
      @close="showCommandPalette = false"
      @execute="(action: ActionName) => keyboardActions[action]()"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      :hide-on-startup="store.hideShortcutsOnStartup"
      @close="showShortcutsModal = false"
      @update:hide-on-startup="(val: boolean) => store.savePreference('hideShortcutsOnStartup', String(val))"
    />
    <ShellModal
      v-if="showShellModal && store.currentItem"
      :session-id="`shell-${store.currentItem.id}`"
      :cwd="store.currentItem.branch ? `${store.selectedRepo?.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo?.path || '/tmp'"
      :port-env="store.currentItem.port_env"
      :maximized="maximized"
      @close="showShellModal = false; maximized = false; focusAgentTerminal()"
    />
    <DiffModal
      v-if="showDiffModal && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : undefined"
      :initial-scope="store.currentItem ? diffScopes.get(store.currentItem.id) : undefined"
      :maximized="maximized"
      @scope-change="(s: any) => { if (store.currentItem) diffScopes.set(store.currentItem.id, s); }"
      @close="showDiffModal = false; maximized = false"
    />
    <FilePickerModal
      v-if="showFilePickerModal && store.selectedRepo?.path"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
      @close="showFilePickerModal = false"
      @select="(f: string) => { showFilePickerModal = false; previewFilePath = f; showFilePreviewModal = true; }"
    />
    <FilePreviewModal
      v-if="showFilePreviewModal && store.selectedRepo?.path"
      :file-path="previewFilePath"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
      :ide-command="store.ideCommand"
      @close="showFilePreviewModal = false"
    />
  </div>
</template>

<style>
:root {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: dark;
  color: #e0e0e0;
  background-color: #1a1a1a;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>

<style scoped>
.app {
  display: flex;
  height: 100%;
  width: 100%;
}
</style>
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/desktop && bunx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "refactor: slim App.vue to UI shell using useKannaStore"
```

---

### Task 5: Delete old composables

Remove the composables that have been absorbed by the store.

**Files:**
- Delete: `apps/desktop/src/composables/useRepo.ts`
- Delete: `apps/desktop/src/composables/usePipeline.ts`
- Delete: `apps/desktop/src/composables/usePreferences.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm apps/desktop/src/composables/useRepo.ts apps/desktop/src/composables/usePipeline.ts apps/desktop/src/composables/usePreferences.ts
```

- [ ] **Step 2: Verify no remaining imports**

```bash
cd apps/desktop && grep -r "useRepo\|usePipeline\|usePreferences" src/ --include="*.ts" --include="*.vue" | grep -v node_modules | grep -v "stores/"
```

Expected: No output (no remaining references).

- [ ] **Step 3: Verify it compiles**

```bash
cd apps/desktop && bunx vue-tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete composables absorbed by useKannaStore"
```

---

### Task 6: Type-check and smoke test

Final verification that everything works together.

**Files:** None (verification only)

- [ ] **Step 1: Run type checker**

```bash
cd apps/desktop && bunx vue-tsc --noEmit
```

Expected: Clean — no type errors.

- [ ] **Step 2: Run existing unit tests**

```bash
bun test
```

Expected: All tests pass (DB layer and core are unchanged).

- [ ] **Step 3: Start dev server**

```bash
./scripts/dev.sh
```

Expected: App launches, sidebar shows repos/items. Verify:
- Create a task → PTY session spawns
- Close a task → teardown + auto-select next
- Pin/unpin/rename items
- Keyboard shortcuts work (Cmd+N, Cmd+W, Cmd+K, etc.)
- Diff modal, shell modal, file picker open/close
- Undo close (Cmd+Z) works for both tasks and hidden repos

- [ ] **Step 4: Stop dev server**

```bash
./scripts/dev.sh stop
```

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during smoke test"
```
