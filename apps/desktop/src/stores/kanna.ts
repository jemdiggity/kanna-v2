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
import {
  listRepos, insertRepo, findRepoByPath,
  hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery,
  listPipelineItems, insertPipelineItem,
  addPipelineItemTag, removePipelineItemTag, updatePipelineItemTags,
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
    if (!selectedItemId.value) return null;
    const item = items.value.find((i) => i.id === selectedItemId.value);
    return item && !hasTag(item, "done") ? item : null;
  });

  // Mirrors Sidebar.vue's itemsForRepo(): pinned (by pin_order), then pr → merge → active (each by activity).
  const sortedItemsForCurrentRepo = computed(() => {
    const repoItems = items.value.filter(
      (item) => item.repo_id === selectedRepoId.value && !hasTag(item, "done")
    );
    const pinned = repoItems
      .filter((i) => i.pinned)
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    const activityOrder: Record<string, number> = { idle: 0, unread: 1, working: 2 };
    function sortByActivity(arr: typeof repoItems) {
      return arr.sort((a, b) => {
        const ao = activityOrder[a.activity || "idle"] ?? 0;
        const bo = activityOrder[b.activity || "idle"] ?? 0;
        if (ao !== bo) return ao - bo;
        const isIdle = (a.activity || "idle") === "idle";
        const aTime = (isIdle ? a.unread_at : null) || a.activity_changed_at || a.created_at;
        const bTime = (isIdle ? b.unread_at : null) || b.activity_changed_at || b.created_at;
        return bTime.localeCompare(aTime);
      });
    }
    const merge = sortByActivity(repoItems.filter((i) => hasTag(i, "merge") && !i.pinned));
    const pr = sortByActivity(repoItems.filter((i) => hasTag(i, "pr") && !i.pinned));
    const active = sortByActivity(repoItems.filter((i) => !hasTag(i, "pr") && !hasTag(i, "merge") && !hasTag(i, "blocked") && !i.pinned));
    const blocked = repoItems
      .filter((i) => hasTag(i, "blocked") && !i.pinned)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return [...pinned, ...merge, ...pr, ...active, ...blocked];
  });

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
    const effectiveStage = opts?.customTask?.stage ?? opts?.stage ?? "in_progress";
    const displayName = opts?.customTask?.name ?? null;

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
      toast.error("Failed to create worktree");
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
        prompt: effectivePrompt,
        tags: opts?.tags ?? [],
        pr_number: null,
        pr_url: null,
        branch,
        agent_type: effectiveAgentType,
        port_offset: portOffset,
        port_env: Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null,
        activity: "working",
        display_name: displayName,
      });
    } catch (e) {
      console.error("[store] DB insert failed:", e);
      toast.error("Failed to save task to database");
      throw e;
    }

    bump();

    // Spawn agent
    if (effectiveAgentType !== "pty") {
      await invoke("create_agent_session", {
        sessionId: id,
        cwd: worktreePath,
        prompt: effectivePrompt,
        systemPrompt: null,
        permissionMode: opts?.customTask?.permissionMode ?? "dontAsk",
        model: opts?.customTask?.model ?? null,
        allowedTools: opts?.customTask?.allowedTools ?? null,
        disallowedTools: opts?.customTask?.disallowedTools ?? null,
        maxTurns: opts?.customTask?.maxTurns ?? null,
        maxBudgetUsd: opts?.customTask?.maxBudgetUsd ?? null,
      });
    } else {
      try {
        await spawnPtySession(id, worktreePath, effectivePrompt, 80, 24, {
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
      } catch (e) {
        console.warn("[store] PTY pre-spawn failed, will retry on mount:", e);
      }
    }

    selectedItemId.value = id;
    emitTaskSelected(id);
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
    const permMode = options?.permissionMode ?? "dontAsk";
    flags.push(`--permission-mode ${permMode}`);
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
    const fullCmd = [...allSetupCmds, claudeCmd].join(" && ");

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

      if (!hasTag(item, "blocked")) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;

        // Custom task teardown (before repo-level teardown)
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
                for (const cmd of config.teardown) {
                  await invoke("run_script", { script: cmd, cwd: worktreePath, env: { KANNA_WORKTREE: "1" } });
                }
                break;
              }
            }
          } catch (e) { console.error("[store] custom task teardown failed:", e); }
        }

        // Repo-level teardown
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

      if (hasTag(item, "blocked")) {
        await removeAllBlockersForItem(_db, item.id);
      }

      await addPipelineItemTag(_db, item.id, "done");
      if (!hasTag(item, "blocked")) {
        await checkUnblocked(item.id);
      }
      bump();

      // Select next item in display order
      const sorted = sortedItemsForCurrentRepo.value;
      const idx = sorted.findIndex((i) => i.id === item.id);
      const remaining = sorted.filter((i) => i.id !== item.id);
      const nextIdx = idx >= remaining.length ? remaining.length - 1 : idx;
      selectedItemId.value = remaining[nextIdx]?.id || null;
      if (selectedItemId.value) emitTaskSelected(selectedItemId.value);
    } catch (e) {
      console.error("[store] close failed:", e);
      toast.error("Failed to close task");
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
      if (!item?.branch) return;
      const repo = repos.value.find((r) => r.id === item.repo_id);
      if (!repo) return;
      await removePipelineItemTag(_db, item.id, "done");
      await updatePipelineItemActivity(_db, item.id, "working");
      const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
      await spawnPtySession(item.id, worktreePath, item.prompt || "");
      selectedItemId.value = item.id;
      emitTaskSelected(item.id);
      bump();
    } catch (e) {
      console.error("[store] undo close failed:", e);
      toast.error("Failed to undo close");
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
      toast.error("Failed to start PR agent");
    }
    try {
      await invoke("kill_session", { sessionId: originalId }).catch((e: unknown) => console.error("[store] kill_session failed:", e));
      await invoke("kill_session", { sessionId: `shell-${originalId}` }).catch((e: unknown) => console.error("[store] kill shell session failed:", e));
      await addPipelineItemTag(_db, originalId, "done");
      await checkUnblocked(originalId);
      bump();
    } catch (e) {
      console.error("[store] failed to close source task:", e);
      toast.error("Failed to close source task");
    }
  }

  async function mergeQueue() {
    if (!selectedRepoId.value) {
      if (repos.value.length === 1) {
        selectedRepoId.value = repos.value[0].id;
      } else {
        toast.warning("Select a repository first");
        return;
      }
    }
    const repo = repos.value.find((r) => r.id === selectedRepoId.value);
    if (!repo) return;
    try {
      await startMergeAgent(repo.id, repo.path);
    } catch (e) {
      console.error("[store] merge agent failed to start:", e);
      toast.error("Failed to start merge agent");
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

    try {
      await invoke("git_worktree_add", {
        repoPath: repo.path,
        branch,
        path: worktreePath,
        startPoint: null,
      });
    } catch (e) {
      console.error("[store] startBlockedTask worktree_add failed:", e);
      toast.error("Failed to create worktree for blocked task");
      return;
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
      await spawnPtySession(id, worktreePath, augmentedPrompt, 80, 24, undefined, {
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
      await invoke("kill_session", { sessionId: `shell-${originalId}` }).catch((e: unknown) =>
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
      toast.error("Failed to block task");
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

    // Eager load repos + items for GC and selection restore
    // (computedAsync hasn't fired yet — repos.value is still [])
    const eagerRepos = await listRepos(_db);
    const eagerItems: PipelineItem[] = [];
    for (const repo of eagerRepos) {
      eagerItems.push(...await listPipelineItems(_db, repo.id));
    }

    // GC: remove done tasks older than gcAfterDays
    const cutoff = new Date(Date.now() - gcAfterDays.value * 86400000).toISOString();
    const stale = eagerItems.filter(
      (i) => hasTag(i, "done") && i.updated_at < cutoff
    );
    for (const item of stale) {
      if (item.branch) {
        const repo = eagerRepos.find((r) => r.id === item.repo_id);
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
      } else if (hookEvent === "Interrupted") {
        if (item.activity === "working") {
          await updatePipelineItemActivity(_db, item.id, "idle");
          bump();
        }
      } else if (hookEvent === "WaitingForInput") {
        if (item.activity !== "unread") {
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
    selectedRepo, currentItem, sortedItemsForCurrentRepo,
    // Actions
    bump, init,
    selectRepo, selectItem,
    importRepo, hideRepo,
    createItem, spawnPtySession, closeTask, undoClose,
    startPrAgent, startMergeAgent, makePR, mergeQueue,
    blockTask, editBlockedTask,
    listBlockersForItem: (itemId: string) => listBlockersForItem(_db, itemId),
    listBlockedByItem: (itemId: string) => listBlockedByItem(_db, itemId),
    pinItem, unpinItem, reorderPinned, renameItem,
    savePreference,
  };
});
