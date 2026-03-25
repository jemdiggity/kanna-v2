import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { computedAsync, watchDebounced } from "@vueuse/core";
import { invoke } from "../invoke";
import { useToast } from '../composables/useToast';
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import { parseRepoConfig, parseAgentMd, hasTag } from "@kanna/core";
import type { RepoConfig, CustomTaskConfig } from "@kanna/core";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
import i18n from '../i18n';
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
} from "@kanna/db";

/** Generate an 8-char hex ID (32 bits of randomness). */
function generateId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
}
// Module-level DB handle — set once by init(), never null after that.
let _db: DbHandle;

function tt(key: string): string { return i18n.global.t(key); }

export const useKannaStore = defineStore("kanna", () => {
  const toast = useToast();

  // ── Refresh trigger ──────────────────────────────────────────────
  const refreshKey = ref(0);
  function bump() { refreshKey.value++; }

  function emitTaskSelected(itemId: string) {
    const item = items.value.find((i) => i.id === itemId);
    insertOperatorEvent(_db, "task_selected", itemId, item?.repo_id ?? null).catch((e) =>
      console.error("[store] operator event failed:", e)
    );
  }

  // ── Reactive DB reads ────────────────────────────────────────────
  const repos = computedAsync<Repo[]>(async () => {
    refreshKey.value; // subscribe to trigger
    if (!_db) return [];
    return await listRepos(_db);
  }, []);

  const items = computedAsync<PipelineItem[]>(async () => {
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
  const suspendAfterMinutes = ref(30);
  const killAfterMinutes = ref(60);
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
    if (selectedItemId.value) {
      const item = items.value.find((i) => i.id === selectedItemId.value);
      if (item && !hasTag(item, "done")) return item;
    }
    // Auto-select first task in current repo if nothing valid is selected
    return sortedItemsForCurrentRepo.value[0] ?? null;
  });

  function sortItemsForRepo(repoId: string): PipelineItem[] {
    const repoItems = items.value.filter(
      (item) => item.repo_id === repoId && !hasTag(item, "done")
    );
    const pinned = repoItems
      .filter((i) => i.pinned)
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    const sortByCreatedAt = (arr: typeof repoItems) =>
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const merge = sortByCreatedAt(repoItems.filter((i) => hasTag(i, "merge") && !i.pinned));
    const pr = sortByCreatedAt(repoItems.filter((i) => hasTag(i, "pr") && !i.pinned));
    const active = sortByCreatedAt(repoItems.filter((i) => !hasTag(i, "pr") && !hasTag(i, "merge") && !hasTag(i, "blocked") && !i.pinned));
    const blocked = sortByCreatedAt(repoItems.filter((i) => hasTag(i, "blocked") && !i.pinned));
    return [...pinned, ...merge, ...pr, ...active, ...blocked];
  }

  // Mirrors Sidebar.vue's itemsForRepo(): pinned (by pin_order), then merge → pr → active → blocked (each by created_at desc).
  const sortedItemsForCurrentRepo = computed(() =>
    sortItemsForRepo(selectedRepoId.value ?? "")
  );

  // All items across all repos, in sidebar order (repo by repo, each with its own sort).
  const sortedItemsAllRepos = computed(() =>
    repos.value.flatMap((repo) => sortItemsForRepo(repo.id))
  );

  // ── Actions: Selection ───────────────────────────────────────────
  async function selectRepo(repoId: string) {
    selectedRepoId.value = repoId;
    await setSetting(_db, "selected_repo_id", repoId);
  }

  // Mark unread → idle after 1s dwell. Array replacement (not mutation)
  // because computedAsync items are a shallowRef.
  watchDebounced(selectedItemId, async (itemId) => {
    if (!itemId) return;
    const selectionTime = Date.now() - 1000;
    const item = items.value.find((i) => i.id === itemId);
    if (!item || item.activity !== "unread") return;
    if (item.activity_changed_at && new Date(item.activity_changed_at).getTime() > selectionTime) return;
    await updatePipelineItemActivity(_db, itemId, "idle");
    items.value = items.value.map((i) =>
      i.id === itemId ? { ...i, activity: "idle", activity_changed_at: new Date().toISOString() } : i,
    );
  }, { debounce: 1000 });

  async function selectItem(itemId: string) {
    selectedItemId.value = itemId;
    await setSetting(_db, "selected_item_id", itemId);
    emitTaskSelected(itemId);
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
    const id = generateId();
    await insertRepo(_db, { id, path, name, default_branch: defaultBranch });
    bump();
    selectedRepoId.value = id;
    if (isTauri) {
      spawnShellSession(`shell-repo-${id}`, path, null, false)
        .catch(e => console.error("[store] repo shell pre-warm failed:", e));
    }
  }

  async function createRepo(name: string, path: string) {
    const existing = await findRepoByPath(_db, path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(_db, existing.id);
        bump();
        selectedRepoId.value = existing.id;
      }
      return;
    }
    await invoke("ensure_directory", { path });
    await invoke("git_init", { path });
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path }).catch(() => "main");
    const id = generateId();
    await insertRepo(_db, { id, path, name, default_branch: defaultBranch });
    bump();
    selectedRepoId.value = id;
    if (isTauri) {
      spawnShellSession(`shell-repo-${id}`, path, null, false)
        .catch(e => console.error("[store] repo shell pre-warm failed:", e));
    }
  }

  async function cloneAndImportRepo(url: string, destination: string) {
    await invoke("git_clone", { url, destination });
    const name = destination.split("/").pop() || "repo";
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: destination }).catch(() => "main");
    const id = generateId();
    await insertRepo(_db, { id, path: destination, name, default_branch: defaultBranch });
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
    opts?: { baseBranch?: string; tags?: string[]; customTask?: CustomTaskConfig },
  ) {
    const id = generateId();
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;

    // Compute effective values from custom task config
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = opts?.customTask?.executionMode ?? agentType;
    const displayName = opts?.customTask?.name ?? null;

    // Assign port offset
    const usedOffsets = new Set(
      items.value.map((i) => i.port_offset).filter((o): o is number => o != null)
    );
    let portOffset = 1;
    while (usedOffsets.has(portOffset)) portOffset++;

    // Insert DB record immediately so the UI updates without waiting on IO
    try {
      await insertPipelineItem(_db, {
        id,
        repo_id: repoId,
        issue_number: null,
        issue_title: null,
        prompt: effectivePrompt,
        tags: opts?.tags ?? ["in progress"],
        pr_number: null,
        pr_url: null,
        branch,
        agent_type: effectiveAgentType,
        port_offset: portOffset,
        port_env: null,
        activity: "working",
        display_name: displayName,
      });
    } catch (e) {
      console.error("[store] DB insert failed:", e);
      toast.error(tt('toasts.dbInsertFailed'));
      throw e;
    }

    bump();

    // Worktree creation, config read, and agent spawn run in the background.
    // Selection is deferred until setup completes so the terminal mounts
    // only after the session exists in the daemon.
    setupWorktreeAndSpawn(id, repoPath, worktreePath, branch, portOffset, effectivePrompt, effectiveAgentType, opts);
  }

  /** Background IO for createItem: read config, create worktree, spawn agent, then select. */
  async function setupWorktreeAndSpawn(
    id: string, repoPath: string, worktreePath: string,
    branch: string, portOffset: number, prompt: string,
    agentType: "pty" | "sdk",
    opts?: { baseBranch?: string; tags?: string[]; customTask?: CustomTaskConfig },
  ) {
    const repoConfig = await readRepoConfig(repoPath);
    const portEnv = computePortEnv(repoConfig, portOffset);

    if (Object.keys(portEnv).length > 0) {
      await _db.execute(
        "UPDATE pipeline_item SET port_env = ? WHERE id = ?",
        [JSON.stringify(portEnv), id],
      );
    }

    try {
      await createWorktree(repoPath, branch, worktreePath, opts?.baseBranch);
    } catch (e) {
      console.error("[store] git_worktree_add failed:", e);
      toast.error(tt('toasts.worktreeFailed'));
      return;
    }

    // Pre-warm shell for ⌘J — fire-and-forget, runs in parallel with agent spawn
    spawnShellSession(`shell-wt-${id}`, worktreePath, JSON.stringify(portEnv))
      .catch(e => console.error("[store] shell pre-warm failed:", e));

    try {
      if (agentType !== "pty") {
        await invoke("create_agent_session", {
          sessionId: id,
          cwd: worktreePath,
          prompt,
          systemPrompt: null,
          permissionMode: opts?.customTask?.permissionMode ?? null,
          model: opts?.customTask?.model ?? null,
          allowedTools: opts?.customTask?.allowedTools ?? null,
          disallowedTools: opts?.customTask?.disallowedTools ?? null,
          maxTurns: opts?.customTask?.maxTurns ?? null,
          maxBudgetUsd: opts?.customTask?.maxBudgetUsd ?? null,
        });
      } else {
        await spawnPtySession(id, worktreePath, prompt, 80, 24, {
          model: opts?.customTask?.model,
          permissionMode: opts?.customTask?.permissionMode,
          allowedTools: opts?.customTask?.allowedTools,
          disallowedTools: opts?.customTask?.disallowedTools,
          maxTurns: opts?.customTask?.maxTurns,
          maxBudgetUsd: opts?.customTask?.maxBudgetUsd,
          setupCmdsOverride: opts?.customTask?.setup,
          portEnv,
          setupCmds: repoConfig.setup || [],
        });
      }
    } catch (e) {
      console.error("[store] agent spawn failed:", e);
      toast.error(`${tt('toasts.agentStartFailed')}: ${e instanceof Error ? e.message : e}`);
    }

    // Select after setup so the terminal mounts with the session already alive
    selectedItemId.value = id;
    emitTaskSelected(id);
  }

  async function readRepoConfig(repoPath: string): Promise<RepoConfig> {
    try {
      const content = await invoke<string>("read_text_file", {
        path: `${repoPath}/.kanna/config.json`,
      });
      return content ? parseRepoConfig(content) : {};
    } catch (e) {
      console.debug("[store] no .kanna/config.json:", e);
      return {};
    }
  }

  function computePortEnv(repoConfig: RepoConfig, portOffset: number): Record<string, string> {
    const portEnv: Record<string, string> = {};
    if (repoConfig.ports) {
      for (const [name, base] of Object.entries(repoConfig.ports)) {
        portEnv[name] = String(base + portOffset);
      }
    }
    return portEnv;
  }

  async function createWorktree(repoPath: string, branch: string, worktreePath: string, baseBranch?: string) {
    const worktreeAddCwd = baseBranch
      ? `${repoPath}/.kanna-worktrees/${baseBranch}`
      : repoPath;

    // For new tasks (no baseBranch), fetch origin and branch from origin/{defaultBranch}
    // so the worktree starts from the latest remote state, not a potentially stale local branch.
    let startPoint: string | null = baseBranch ? "HEAD" : null;
    if (!baseBranch) {
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
        await invoke("git_fetch", { repoPath, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isOffline = /could not resolve host|network is unreachable|connection refused|timed out/i.test(msg);
        const noRemote = /does not appear to be a git repository|could not find remote|no remote|remote.*not found/i.test(msg);
        if (isOffline || noRemote) {
          console.debug("[store] fetch origin failed (offline or no remote), using local HEAD");
        } else {
          console.warn("[store] fetch origin failed:", msg);
          toast.warning(tt('toasts.fetchFailed'));
        }
      }
    }

    await invoke("git_worktree_add", {
      repoPath: worktreeAddCwd,
      branch,
      path: worktreePath,
      startPoint,
    });
  }


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

  async function spawnPtySession(sessionId: string, cwd: string, prompt: string, cols = 80, rows = 24, options?: PtySpawnOptions) {
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
    let setupCmds: string[] = options?.setupCmds || [];

    // When options are provided (e.g. from createItem/startBlockedTask), use them directly
    // to avoid a race with computedAsync not having refreshed items.value yet.
    if (options?.portEnv) {
      Object.assign(env, options.portEnv);
    } else {
      // Fallback: read from items.value (works for undoClose and terminal retry)
      const item = items.value.find((i) => i.id === sessionId);
      if (item) {
        if (item.port_env) {
          try {
            Object.assign(env, JSON.parse(item.port_env));
          } catch (e) { console.error("[store] failed to parse port_env:", e); }
        }
        if (setupCmds.length === 0) {
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
      }
    }

    env.KANNA_WORKTREE = "1";

    const flags: string[] = [];
    if (options?.permissionMode) {
      flags.push(`--permission-mode ${options.permissionMode}`);
    } else {
      flags.push("--dangerously-skip-permissions");
    }
    if (options?.model) flags.push(`--model ${options.model}`);
    if (options?.maxTurns != null) flags.push(`--max-turns ${options.maxTurns}`);
    if (options?.maxBudgetUsd != null) flags.push(`--max-budget-usd ${options.maxBudgetUsd}`);
    if (options?.allowedTools?.length) {
      flags.push(`--allowedTools ${options.allowedTools.join(",")}`);
    }
    if (options?.disallowedTools?.length) {
      flags.push(`--disallowedTools ${options.disallowedTools.join(",")}`);
    }

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const claudeCmd = `claude ${flags.join(" ")} --settings '${hookSettings}' '${escapedPrompt}'`;
    const allSetupCmds = [...setupCmds, ...(options?.setupCmdsOverride || [])];
    let fullCmd: string;
    if (allSetupCmds.length > 0) {
      const setupParts = allSetupCmds.map((cmd) => {
        const escaped = cmd.replace(/'/g, "'\\''");
        return `printf '\\033[2m$ %s\\033[0m\\n' '${escaped}' && ${cmd}`;
      });
      fullCmd = `printf '\\033[33mRunning startup...\\033[0m\\n' && ${setupParts.join(" && ")} && printf '\\n' && ${claudeCmd}`;
    } else {
      fullCmd = claudeCmd;
    }

    await invoke("spawn_session", {
      sessionId,
      cwd,
      executable: "/bin/zsh",
      args: ["--login", "-i", "-c", fullCmd],
      env,
      cols,
      rows,
    });
  }

  /** Collect all teardown commands for a task (custom task + repo-level). */
  async function collectTeardownCommands(item: PipelineItem, repo: Repo): Promise<string[]> {
    const cmds: string[] = [];
    if (item.display_name) {
      try {
        const tasksDir = `${repo.path}/.kanna/tasks`;
        const entries = await invoke<string[]>("list_dir", { path: tasksDir }).catch(() => [] as string[]);
        for (const entry of entries) {
          const agentMdPath = `${tasksDir}/${entry}/agent.md`;
          let content: string;
          try {
            content = await invoke<string>("read_text_file", { path: agentMdPath });
          } catch { continue; }
          const config = parseAgentMd(content, entry);
          if (config && config.name === item.display_name && config.teardown?.length) {
            cmds.push(...config.teardown);
            break;
          }
        }
      } catch (e) { console.error("[store] custom task teardown lookup failed:", e); }
    }
    try {
      const configContent = await invoke<string>("read_text_file", {
        path: `${repo.path}/.kanna/config.json`,
      });
      if (configContent) {
        const repoConfig = parseRepoConfig(configContent);
        if (repoConfig.teardown?.length) {
          cmds.push(...repoConfig.teardown);
        }
      }
    } catch (e) { console.error("[store] repo teardown lookup failed:", e); }
    return cmds;
  }

  function selectNextItem(closingId: string) {
    const sorted = sortedItemsForCurrentRepo.value;
    const idx = sorted.findIndex((i) => i.id === closingId);
    const remaining = sorted.filter((i) => i.id !== closingId);
    const nextIdx = idx >= remaining.length ? remaining.length - 1 : idx;
    selectedItemId.value = remaining[nextIdx]?.id || null;
    if (selectedItemId.value) emitTaskSelected(selectedItemId.value);
  }

  async function closeTask() {
    lastUndoAction.value = null;
    const item = currentItem.value;
    const repo = selectedRepo.value;
    if (!item || !repo) return;
    try {
      // Already tearing down — force complete
      if (hasTag(item, "teardown")) {
        await invoke("kill_session", { sessionId: `td-${item.id}` }).catch((e: unknown) =>
          console.error("[store] kill teardown session failed:", e));
        await removePipelineItemTag(_db, item.id, "teardown");
        await addPipelineItemTag(_db, item.id, "done");
        selectNextItem(item.id);
        bump();
        return;
      }

      const wasBlocked = hasTag(item, "blocked");

      // Blocked tasks never started — no teardown needed
      if (wasBlocked) {
        await removeAllBlockersForItem(_db, item.id);
        await addPipelineItemTag(_db, item.id, "done");
        selectNextItem(item.id);
        bump();
        (async () => {
          await invoke("kill_session", { sessionId: item.id }).catch((e: unknown) =>
            console.error("[store] kill_session failed:", e));
        })();
        return;
      }

      const teardownCmds = await collectTeardownCommands(item, repo);

      if (teardownCmds.length === 0) {
        // No teardown — fast close
        await addPipelineItemTag(_db, item.id, "done");
        selectNextItem(item.id);
        bump();
        (async () => {
          try {
            await Promise.all([
              invoke("kill_session", { sessionId: item.id }).catch((e: unknown) =>
                console.error("[store] kill_session failed:", e)),
              invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((e: unknown) =>
                console.error("[store] kill shell session failed:", e)),
            ]);
            await checkUnblocked(item.id);
          } catch (e) { console.error("[store] close cleanup failed:", e); }
        })();
        return;
      }

      // Has teardown scripts — enter teardown state
      // 1. Kill existing sessions
      await Promise.all([
        invoke("kill_session", { sessionId: item.id }).catch((e: unknown) =>
          console.error("[store] kill_session failed:", e)),
        invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((e: unknown) =>
          console.error("[store] kill shell session failed:", e)),
      ]);

      // 2. Spawn teardown PTY session and attach so output flows to the
      //    existing terminal (useTerminal listens for td-{sessionId} events)
      const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
      const scriptParts = teardownCmds.map((cmd) => {
        const escaped = cmd.replace(/'/g, "'\\''");
        return `printf '\\033[2m$ %s\\033[0m\\n' '${escaped}' && ${cmd}`;
      });
      const fullCmd = `printf '\\033[33mRunning teardown...\\033[0m\\n' && ${scriptParts.join(" && ")} && printf '\\n'`;
      const tdSessionId = `td-${item.id}`;
      await invoke("spawn_session", {
        sessionId: tdSessionId,
        cwd: worktreePath,
        executable: "/bin/zsh",
        args: ["--login", "-i", "-c", fullCmd],
        env: { KANNA_WORKTREE: "1" },
        cols: 120,
        rows: 30,
      });
      await invoke("attach_session", { sessionId: tdSessionId });

      // 3. Tag and refresh sidebar (strikethrough)
      await addPipelineItemTag(_db, item.id, "teardown");
      bump();
    } catch (e) {
      console.error("[store] close failed:", e);
      toast.error(tt('toasts.closeTaskFailed'));
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
        "SELECT * FROM pipeline_item WHERE tags LIKE '%\"done\"%' ORDER BY updated_at DESC LIMIT 1"
      );
      const item = rows[0];
      if (!item) return;
      const repo = repos.value.find((r) => r.id === item.repo_id);
      if (!repo) return;
      await removePipelineItemTag(_db, item.id, "done");
      await updatePipelineItemActivity(_db, item.id, "working");
      bump();
      // Spawn before selecting so the terminal mounts with the session already alive
      // (avoids a race where the terminal's spawn-on-mount and this spawn both fire)
      if (item.branch) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        try {
          await spawnPtySession(item.id, worktreePath, item.prompt || "");
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
      `1. Rebase onto latest main: "git fetch origin main && git rebase origin/main". This ensures the PR only contains the task's changes, not reversions from a stale branch point.`,
      `2. Rename this branch to something meaningful based on the commits (use "git branch -m <new-name>").`,
      `3. Push the branch (git push -u origin HEAD).`,
      `4. Create a PR with "gh pr create" — write a clear title and description summarizing the changes.`,
      `If gh CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.`,
    ].join("\n");

    await createItem(repoId, repoPath, prompt, "pty", { baseBranch: item.branch, tags: ["pr"] });
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

    await createItem(repoId, repoPath, prompt, "pty", { tags: ["merge"] });
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
    const sa = await getSetting(_db, "suspendAfterMinutes");
    if (sa) suspendAfterMinutes.value = parseInt(sa, 10) || 30;
    const ka = await getSetting(_db, "killAfterMinutes");
    if (ka) killAfterMinutes.value = parseInt(ka, 10) || 60;
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
      toast.error(tt('toasts.prAgentFailed'));
    }
    try {
      await invoke("kill_session", { sessionId: originalId }).catch((e: unknown) => console.error("[store] kill_session failed:", e));
      await invoke("kill_session", { sessionId: `shell-wt-${originalId}` }).catch((e: unknown) => console.error("[store] kill shell session failed:", e));
      await addPipelineItemTag(_db, originalId, "done");
      await checkUnblocked(originalId);
      bump();
    } catch (e) {
      console.error("[store] failed to close source task:", e);
      toast.error(tt('toasts.closeSourceTaskFailed'));
    }
  }

  async function mergeQueue() {
    if (!selectedRepoId.value) {
      if (repos.value.length === 1) {
        selectedRepoId.value = repos.value[0].id;
      } else {
        toast.warning(tt('toasts.selectRepoFirst'));
        return;
      }
    }
    const repo = repos.value.find((r) => r.id === selectedRepoId.value);
    if (!repo) return;
    try {
      await startMergeAgent(repo.id, repo.path);
    } catch (e) {
      console.error("[store] merge agent failed to start:", e);
      toast.error(tt('toasts.mergeAgentFailed'));
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

  async function checkUnblocked(blockerItemId: string) {
    const blockedItems = await listBlockedByItem(_db, blockerItemId);
    for (const blocked of blockedItems) {
      if (!hasTag(blocked, "blocked")) continue;
      const blockers = await listBlockersForItem(_db, blocked.id);
      const allClear = blockers.every(
        (b) => hasTag(b, "pr") || hasTag(b, "merge") || hasTag(b, "done")
      );
      if (allClear) {
        await startBlockedTask(blocked);
      }
    }
  }

  async function startBlockedTask(item: PipelineItem) {
    // repos.value may be empty during init() (computedAsync hasn't fired yet),
    // so fall back to a direct DB query.
    const repo = repos.value.find((r) => r.id === item.repo_id) ?? await getRepo(_db, item.repo_id);
    if (!repo) {
      console.error("[store] startBlockedTask: repo not found for", item.id);
      return;
    }

    const blockers = await listBlockersForItem(_db, item.id);
    const blockerContext = blockers
      .map((b) => {
        const name = b.display_name || (b.prompt ? b.prompt.slice(0, 60) : "Untitled");
        return `- ${name} (branch: ${b.branch || "unknown"})`;
      })
      .join("\n");

    const augmentedPrompt = [
      "Note: this task was previously blocked by the following tasks which have now completed:",
      blockerContext,
      "Their changes may be on branches that haven't merged to main yet.",
      "",
      "Original task:",
      item.prompt || "",
    ].join("\n");

    const id = item.id;
    const branch = `task-${id}`;
    const worktreePath = `${repo.path}/.kanna-worktrees/${branch}`;

    const worktreeExists = await invoke<boolean>("file_exists", { path: worktreePath });
    if (!worktreeExists) {
      // Fetch origin so the worktree starts from the latest remote state
      let startPoint: string | null = null;
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
        await invoke("git_fetch", { repoPath: repo.path, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
      } catch (e) {
        console.debug("[store] fetch origin failed (offline?), using local HEAD:", e);
      }

      try {
        await invoke("git_worktree_add", {
          repoPath: repo.path,
          branch,
          path: worktreePath,
          startPoint,
        });
      } catch (e) {
        console.error("[store] startBlockedTask worktree_add failed:", e);
        toast.error(tt('toasts.blockedWorktreeFailed'));
        return;
      }
    }

    let repoConfig: RepoConfig = {};
    try {
      const configContent = await invoke<string>("read_text_file", {
        path: `${repo.path}/.kanna/config.json`,
      });
      if (configContent) repoConfig = parseRepoConfig(configContent);
    } catch (e) {
      console.debug("[store] no .kanna/config.json:", e);
    }

    // items.value may be empty during init() (computedAsync hasn't fired),
    // so query DB directly for port offsets as a fallback.
    let portItems = items.value;
    if (portItems.length === 0) {
      portItems = await _db.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE repo_id = ? AND tags NOT LIKE '%\"done\"%'",
        [item.repo_id],
      );
    }
    const usedOffsets = new Set(
      portItems.map((i) => i.port_offset).filter((o): o is number => o != null)
    );
    let portOffset = 1;
    while (usedOffsets.has(portOffset)) portOffset++;

    const portEnv: Record<string, string> = {};
    if (repoConfig.ports) {
      for (const [name, base] of Object.entries(repoConfig.ports)) {
        portEnv[name] = String(base + portOffset);
      }
    }

    await _db.execute(
      `UPDATE pipeline_item
       SET branch = ?, port_offset = ?, port_env = ?,
           tags = '[]', activity = 'working',
           activity_changed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [branch, portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, id],
    );

    bump();

    try {
      await spawnPtySession(id, worktreePath, augmentedPrompt, 80, 24, {
        portEnv,
        setupCmds: repoConfig.setup || [],
      });
    } catch (e) {
      console.warn("[store] startBlockedTask PTY pre-spawn failed, will retry on mount:", e);
    }
  }

  async function blockTask(blockerIds: string[]) {
    const item = currentItem.value;
    const repo = selectedRepo.value;
    if (!item || !repo || hasTag(item, "done") || hasTag(item, "blocked")) return;

    const originalPrompt = item.prompt;
    const originalRepoId = item.repo_id;
    const originalAgentType = item.agent_type;
    const originalDisplayName = item.display_name;
    const originalId = item.id;

    const newId = generateId();
    await insertPipelineItem(_db, {
      id: newId,
      repo_id: originalRepoId,
      issue_number: null,
      issue_title: null,
      prompt: originalPrompt,
      tags: ["blocked"],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: originalAgentType,
      port_offset: null,
      port_env: null,
      activity: "idle",
    });

    if (originalDisplayName) {
      await updatePipelineItemDisplayName(_db, newId, originalDisplayName);
    }

    for (const blockerId of blockerIds) {
      await insertTaskBlocker(_db, newId, blockerId);
    }

    // Transfer: any task that was blocked by the original now depends on
    // the new blocked replacement instead. Without this, blocking B when
    // A' depends on B would leave A' pointing at the dead original B.
    const dependents = await listBlockedByItem(_db, originalId);
    for (const dep of dependents) {
      await removeTaskBlocker(_db, dep.id, originalId);
      await insertTaskBlocker(_db, dep.id, newId);
    }

    try {
      await invoke("kill_session", { sessionId: originalId }).catch((e: unknown) =>
        console.error("[store] kill_session failed:", e)
      );
      await invoke("kill_session", { sessionId: `shell-wt-${originalId}` }).catch((e: unknown) =>
        console.error("[store] kill shell session failed:", e)
      );

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
      } catch (e) {
        console.error("[store] teardown failed:", e);
      }

      await invoke("git_worktree_remove", { repoPath: repo.path, path: worktreePath }).catch((e: unknown) =>
        console.error("[store] worktree remove failed:", e)
      );

      await addPipelineItemTag(_db, originalId, "done");
      // The original task going to "done" may unblock other tasks that
      // were waiting on it. We must check — suppressing this causes deadlocks
      // when two tasks block each other (A blocked by B, then B blocked by A').
      await checkUnblocked(originalId);
    } catch (e) {
      console.error("[store] blockTask close failed:", e);
      toast.error(tt('toasts.blockTaskFailed'));
    }

    bump();
    selectedItemId.value = newId;
    emitTaskSelected(newId);
  }

  async function editBlockedTask(itemId: string, newBlockerIds: string[]) {
    const item = items.value.find((i) => i.id === itemId);
    if (!item || !hasTag(item, "blocked")) return;

    if (newBlockerIds.length > 0) {
      const hasCycle = await hasCircularDependency(_db, itemId, newBlockerIds);
      if (hasCycle) {
        throw new Error("Cannot add blocker — it would create a circular dependency");
      }
    }

    const currentBlockers = await listBlockersForItem(_db, itemId);
    const currentIds = new Set(currentBlockers.map((b) => b.id));
    const newIds = new Set(newBlockerIds);

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        await removeTaskBlocker(_db, itemId, id);
      }
    }

    for (const id of newIds) {
      if (!currentIds.has(id)) {
        await insertTaskBlocker(_db, itemId, id);
      }
    }

    bump();

    const updatedBlockers = await listBlockersForItem(_db, itemId);
    const allClear = updatedBlockers.length === 0 || updatedBlockers.every(
      (b) => hasTag(b, "pr") || hasTag(b, "merge") || hasTag(b, "done")
    );
    if (allClear) {
      await startBlockedTask(item);
    }
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

    // Eager load repos + items for selection restore
    // (computedAsync hasn't fired yet — repos.value is still [])
    const eagerRepos = await listRepos(_db);
    const eagerItems: PipelineItem[] = [];
    for (const repo of eagerRepos) {
      eagerItems.push(...await listPipelineItems(_db, repo.id));
    }

    // Check for blocked tasks that can now start
    const unblockedItems = await getUnblockedItems(_db);
    for (const item of unblockedItems) {
      console.log(`[store] auto-starting previously blocked task: ${item.id}`);
      await startBlockedTask(item);
    }

    // Trigger reactive data load
    bump();

    // Restore persisted selection (use eager data since computedAsync is still resolving)
    const savedRepo = await getSetting(_db, "selected_repo_id");
    const savedItem = await getSetting(_db, "selected_item_id");
    if (savedRepo && eagerRepos.some((r) => r.id === savedRepo)) {
      selectedRepoId.value = savedRepo;
      if (savedItem && eagerItems.some((i) => i.id === savedItem)) {
        selectedItemId.value = savedItem;
      }
    } else if (eagerRepos.length === 1) {
      selectedRepoId.value = eagerRepos[0].id;
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
      } else if (hookEvent === "Interrupted") {
        if (item.activity === "working") {
          await updatePipelineItemActivity(_db, item.id, "idle");
          bump();
        }
      } else if (hookEvent === "WaitingForInput") {
        if (item.activity !== "unread" && selectedItemId.value !== sessionId) {
          await updatePipelineItemActivity(_db, item.id, "unread");
          bump();
        }
      } else if (hookEvent === "PostToolUse") {
        if (item.activity !== "working") {
          await updatePipelineItemActivity(_db, item.id, "working");
          bump();
        }
      }
    });

    listen("session_exit", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      if (!sessionId) return;

      // Teardown session finished — mark task done
      if (typeof sessionId === "string" && sessionId.startsWith("td-")) {
        const itemId = sessionId.slice(3);
        const item = items.value.find((i) => i.id === itemId);
        if (!item || !hasTag(item, "teardown")) return;
        await removePipelineItemTag(_db, itemId, "teardown");
        await addPipelineItemTag(_db, itemId, "done");
        if (selectedItemId.value === itemId) {
          selectNextItem(itemId);
        }
        await checkUnblocked(itemId);
        bump();
        return;
      }

      _handleAgentFinished(sessionId);
    });
  }

  return {
    // State
    repos, items, selectedRepoId, selectedItemId,
    suspendAfterMinutes, killAfterMinutes,
    ideCommand, gcAfterDays, hideShortcutsOnStartup,
    lastUndoAction, refreshKey,
    // Getters
    selectedRepo, currentItem, sortedItemsForCurrentRepo, sortedItemsAllRepos,
    // Actions
    bump, init,
    selectRepo, selectItem,
    importRepo, createRepo, cloneAndImportRepo, hideRepo,
    createItem, spawnPtySession, spawnShellSession, closeTask, undoClose,
    startPrAgent, startMergeAgent, makePR, mergeQueue,
    blockTask, editBlockedTask,
    listBlockersForItem: (itemId: string) => listBlockersForItem(_db, itemId),
    listBlockedByItem: (itemId: string) => listBlockedByItem(_db, itemId),
    pinItem, unpinItem, reorderPinned, renameItem,
    savePreference,
  };
});
