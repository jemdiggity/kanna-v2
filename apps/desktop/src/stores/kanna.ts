import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { computedAsync, watchDebounced } from "@vueuse/core";
import { invoke } from "../invoke";
import { useToast } from '../composables/useToast';
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import { parseRepoConfig, parseAgentMd } from "@kanna/core";
import { parseAgentDefinition } from "../../../../packages/core/src/pipeline/agent-loader";
import { parsePipelineJson } from "../../../../packages/core/src/pipeline/pipeline-loader";
import { buildStagePrompt } from "../../../../packages/core/src/pipeline/prompt-builder";
import { getNextStage, getStageIndex } from "../../../../packages/core/src/pipeline/types";
import type { PipelineDefinition, AgentDefinition, StageCompleteResult } from "../../../../packages/core/src/pipeline/pipeline-types";
import { createNavigationHistory } from "../composables/useNavigationHistory";
import type { RepoConfig, CustomTaskConfig } from "@kanna/core";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
import i18n from '../i18n';
import {
  listRepos, insertRepo, findRepoByPath,
  hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery,
  listPipelineItems, insertPipelineItem,
  updatePipelineItemActivity, pinPipelineItem, unpinPipelineItem,
  reorderPinnedItems, updatePipelineItemDisplayName,
  updatePipelineItemStage, clearPipelineItemStageResult,
  closePipelineItem, reopenPipelineItem,
  getRepo, getSetting, setSetting,
  insertTaskBlocker, removeTaskBlocker, removeAllBlockersForItem,
  listBlockersForItem, listBlockedByItem, getUnblockedItems,
  hasCircularDependency, insertOperatorEvent, updateClaudeSessionId,
} from "@kanna/db";

/** Generate an 8-char hex ID (32 bits of randomness). */
function generateId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Internal tag helpers (not exported — tags column is legacy) ──────────
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; }
  catch { return []; }
}

function hasTag(item: { tags: string }, tag: string): boolean {
  return parseTags(item.tags).includes(tag);
}

async function addPipelineItemTag(
  db: DbHandle,
  id: string,
  tag: string
): Promise<void> {
  const rows = await db.select<{ tags: string }>(
    "SELECT tags FROM pipeline_item WHERE id = ?",
    [id]
  );
  const current: string[] = rows[0]?.tags ? JSON.parse(rows[0].tags) as string[] : [];
  if (!current.includes(tag)) {
    current.push(tag);
  }
  const closedAt = (tag === "done" || tag === "archived") ? ", closed_at = datetime('now')" : "";
  await db.execute(
    `UPDATE pipeline_item SET tags = ?${closedAt}, updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(current), id]
  );
}

async function removePipelineItemTag(
  db: DbHandle,
  id: string,
  tag: string
): Promise<void> {
  const rows = await db.select<{ tags: string }>(
    "SELECT tags FROM pipeline_item WHERE id = ?",
    [id]
  );
  const current: string[] = rows[0]?.tags ? JSON.parse(rows[0].tags) as string[] : [];
  const updated = current.filter((t) => t !== tag);
  const closedAt = (tag === "done" || tag === "archived") ? ", closed_at = NULL" : "";
  await db.execute(
    `UPDATE pipeline_item SET tags = ?${closedAt}, updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(updated), id]
  );
}

export interface PtySpawnOptions {
  agentProvider?: "claude" | "copilot";
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

  // ── Selection & navigation history ──────────────────────────────
  const selectedRepoId = ref<string | null>(null);
  const selectedItemId = ref<string | null>(null);
  const lastSelectedItemByRepo = ref<Record<string, string>>({});
  const nav = createNavigationHistory();
  const canGoBack = nav.canGoBack;
  const canGoForward = nav.canGoForward;

  // ── Preferences ──────────────────────────────────────────────────
  const suspendAfterMinutes = ref(30);
  const killAfterMinutes = ref(60);
  const ideCommand = ref("code");
  const gcAfterDays = ref(3);
  const hideShortcutsOnStartup = ref(false);
  const devLingerTerminals = ref(false);

  // ── Undo state ───────────────────────────────────────────────────
  const lastUndoAction = ref<{ type: "hideRepo"; repoId: string } | null>(null);

  // Items whose worktree + agent spawn is still in progress.
  // Excluded from the currentItem auto-select fallback to prevent
  // the terminal from mounting (and racing to spawn) before the
  // session actually exists in the daemon.
  const pendingSetupIds = ref<string[]>([]);

  // ── Pipeline cache ────────────────────────────────────────────────
  const pipelineCache = new Map<string, PipelineDefinition>();
  const agentCache = new Map<string, AgentDefinition>();

  async function loadPipeline(repoPath: string, pipelineName: string): Promise<PipelineDefinition> {
    const cacheKey = `${repoPath}::${pipelineName}`;
    const cached = pipelineCache.get(cacheKey);
    if (cached) return cached;

    // Try repo file first, fall back to bundled resource
    let pipeline: PipelineDefinition;
    try {
      const path = `${repoPath}/.kanna/pipelines/${pipelineName}.json`;
      const content = await invoke<string>("read_text_file", { path });
      pipeline = parsePipelineJson(content);
    } catch {
      try {
        const content = await invoke<string>("read_builtin_resource", {
          relativePath: `.kanna/pipelines/${pipelineName}.json`,
        });
        pipeline = parsePipelineJson(content);
      } catch (resourceErr) {
        throw new Error(`Pipeline "${pipelineName}" not found: ${resourceErr instanceof Error ? resourceErr.message : JSON.stringify(resourceErr)}`);
      }
    }
    pipelineCache.set(cacheKey, pipeline);
    return pipeline;
  }

  async function loadAgent(repoPath: string, agentName: string): Promise<AgentDefinition> {
    const cacheKey = `${repoPath}::${agentName}`;
    const cached = agentCache.get(cacheKey);
    if (cached) return cached;

    // Try repo file first, fall back to bundled resource
    let agent: AgentDefinition;
    try {
      const path = `${repoPath}/.kanna/agents/${agentName}/AGENT.md`;
      const content = await invoke<string>("read_text_file", { path });
      agent = parseAgentDefinition(content);
    } catch {
      try {
        const content = await invoke<string>("read_builtin_resource", {
          relativePath: `.kanna/agents/${agentName}/AGENT.md`,
        });
        agent = parseAgentDefinition(content);
      } catch (resourceErr) {
        throw new Error(`Agent "${agentName}" not found on disk or in bundled resources: ${resourceErr instanceof Error ? resourceErr.message : JSON.stringify(resourceErr)}`);
      }
    }
    agentCache.set(cacheKey, agent);
    return agent;
  }

  /** Check if an item has unresolved blockers (blockers whose closed_at is null). */
  async function hasUnresolvedBlockers(itemId: string): Promise<boolean> {
    const blockers = await listBlockersForItem(_db, itemId);
    return blockers.some(b => b.closed_at === null);
  }

  // ── Computed getters ─────────────────────────────────────────────
  const selectedRepo = computed(() =>
    repos.value.find((r) => r.id === selectedRepoId.value) ?? null
  );

  /** An item is considered "hidden" if it has been closed. */
  function isItemHidden(item: PipelineItem): boolean {
    return item.closed_at !== null;
  }

  const currentItem = computed(() => {
    if (selectedItemId.value) {
      const item = items.value.find((i) => i.id === selectedItemId.value);
      if (item && !isItemHidden(item)) return item;
    }
    // Auto-select first task in current repo if nothing valid is selected.
    // Skip items whose worktree/agent setup is still in progress — their
    // terminal would race to spawn before the daemon session is ready.
    return sortedItemsForCurrentRepo.value
      .find(i => !pendingSetupIds.value.includes(i.id)) ?? null;
  });

  /**
   * Sort items for a repo by pipeline stage order.
   * Order: pinned -> stages in pipeline order -> blocked (items with unresolved blockers).
   * Within each group, sorted by created_at DESC.
   */
  function sortItemsForRepo(repoId: string): PipelineItem[] {
    const repoItems = items.value.filter(
      (item) => item.repo_id === repoId && !isItemHidden(item)
    );
    const pinned = repoItems
      .filter((i) => i.pinned)
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    const sortByCreatedAt = (arr: typeof repoItems) =>
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));

    // Separate blocked items (those with "blocked" tag — kept for backward compat
    // until blocker system fully migrated) from stage-sorted items
    const blocked = sortByCreatedAt(repoItems.filter((i) => hasTag(i, "blocked") && !i.pinned));
    const blockedIds = new Set(blocked.map(i => i.id));

    // Non-pinned, non-blocked items sorted by stage order within their pipeline.
    // Items in the same stage are sorted by created_at DESC.
    const stageItems = repoItems.filter(i => !i.pinned && !blockedIds.has(i.id));

    // Build stage order from cached pipelines (synchronous — uses cache)
    const stageOrder = (item: PipelineItem): number => {
      const cacheKey = `${repos.value.find(r => r.id === repoId)?.path ?? ""}::${item.pipeline}`;
      const pipeline = pipelineCache.get(cacheKey);
      if (!pipeline) return 0; // unknown pipeline — sort first
      const idx = getStageIndex(pipeline, item.stage);
      return idx === -1 ? pipeline.stages.length : idx;
    };

    const sortedStageItems = stageItems.sort((a, b) => {
      const orderA = stageOrder(a);
      const orderB = stageOrder(b);
      if (orderA !== orderB) return orderA - orderB;
      return b.created_at.localeCompare(a.created_at);
    });

    return [...pinned, ...sortedStageItems, ...blocked];
  }

  // pinned (by pin_order) -> stages in pipeline order -> blocked (each by created_at desc).
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

  /** Select a task, recording the previous one in navigation history. */
  async function selectItem(itemId: string) {
    nav.select(itemId, selectedItemId.value);
    selectedItemId.value = itemId;
    const item = items.value.find((i) => i.id === itemId);
    if (item) {
      lastSelectedItemByRepo.value[item.repo_id] = itemId;
    }
    await setSetting(_db, "selected_item_id", itemId);
    emitTaskSelected(itemId);
  }

  /** Restore selection without recording history (startup / DB restore). */
  function restoreSelection(itemId: string) {
    selectedItemId.value = itemId;
    const item = items.value.find((i) => i.id === itemId);
    if (item) {
      lastSelectedItemByRepo.value[item.repo_id] = itemId;
    }
  }

  /** Navigate back, switching repos if needed. */
  function goBack() {
    if (!selectedItemId.value) return;
    const validIds = new Set(items.value.filter((i) => !isItemHidden(i)).map((i) => i.id));
    const taskId = nav.goBack(selectedItemId.value, validIds);
    if (!taskId) return;
    const item = items.value.find((i) => i.id === taskId);
    if (item) {
      if (item.repo_id !== selectedRepoId.value) {
        selectedRepoId.value = item.repo_id;
        setSetting(_db, "selected_repo_id", item.repo_id);
      }
      lastSelectedItemByRepo.value[item.repo_id] = taskId;
    }
    selectedItemId.value = taskId;
    setSetting(_db, "selected_item_id", taskId);
    emitTaskSelected(taskId);
  }

  /** Navigate forward, switching repos if needed. */
  function goForward() {
    if (!selectedItemId.value) return;
    const validIds = new Set(items.value.filter((i) => !isItemHidden(i)).map((i) => i.id));
    const taskId = nav.goForward(selectedItemId.value, validIds);
    if (!taskId) return;
    const item = items.value.find((i) => i.id === taskId);
    if (item) {
      if (item.repo_id !== selectedRepoId.value) {
        selectedRepoId.value = item.repo_id;
        setSetting(_db, "selected_repo_id", item.repo_id);
      }
      lastSelectedItemByRepo.value[item.repo_id] = taskId;
    }
    selectedItemId.value = taskId;
    setSetting(_db, "selected_item_id", taskId);
    emitTaskSelected(taskId);
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
    if (isTauri) {
      spawnShellSession(`shell-repo-${id}`, destination, null, false)
        .catch(e => console.error("[store] repo shell pre-warm failed:", e));
    }
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
    opts?: { baseBranch?: string; tags?: string[]; pipelineName?: string; stage?: string; customTask?: CustomTaskConfig; agentProvider?: "claude" | "copilot"; model?: string; permissionMode?: string; allowedTools?: string[] },
  ) {
    const id = generateId();
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;

    // Compute effective values from custom task config
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = opts?.customTask?.executionMode ?? agentType;
    const effectiveAgentProvider = opts?.customTask?.agentProvider ?? opts?.agentProvider ?? "claude";
    const displayName = opts?.customTask?.name ?? null;

    // Resolve pipeline name: explicit > repo config > "default"
    let pipelineName = opts?.pipelineName;
    if (!pipelineName) {
      try {
        const repoConfig = await readRepoConfig(repoPath);
        pipelineName = repoConfig.pipeline ?? "default";
      } catch {
        pipelineName = "default";
      }
    }

    // Load pipeline definition and resolve stage
    let firstStageName = opts?.stage ?? "in progress";
    let pipelinePrompt = effectivePrompt;
    try {
      const pipeline = await loadPipeline(repoPath, pipelineName);
      if (!opts?.stage && pipeline.stages.length > 0) {
        const firstStage = pipeline.stages[0];
        firstStageName = firstStage.name;

        // Load the first stage's agent and build prompt (skip if stage was overridden — prompt already built)
        if (firstStage.agent && !opts?.stage) {
          try {
            const agent = await loadAgent(repoPath, firstStage.agent);
            pipelinePrompt = buildStagePrompt(agent.prompt, firstStage.prompt, {
              taskPrompt: effectivePrompt,
            });
          } catch (e) {
            console.error("[store] failed to load agent for first stage:", e);
            // Fall back to the raw prompt
          }
        }
      }
    } catch (e) {
      console.error("[store] failed to load pipeline definition:", e);
      // Fall back to defaults — pipeline missing is not fatal at creation time
    }

    // Assign port offset
    const usedOffsets = new Set(
      items.value.map((i) => i.port_offset).filter((o): o is number => o != null)
    );
    let portOffset = 1;
    while (usedOffsets.has(portOffset)) portOffset++;

    // Compute base_ref for merge-base diffing
    let baseRef: string | null = null;
    try {
      const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
      // Prefer origin ref if remote exists
      try {
        await invoke<string>("git_merge_base", { repoPath, refA: `origin/${defaultBranch}`, refB: "HEAD" });
        baseRef = `origin/${defaultBranch}`;
      } catch {
        baseRef = defaultBranch;
      }
    } catch (e) {
      console.warn("[store] failed to compute base_ref:", e);
    }

    // Insert DB record immediately so the UI updates without waiting on IO
    try {
      await insertPipelineItem(_db, {
        id,
        repo_id: repoId,
        issue_number: null,
        issue_title: null,
        prompt: effectivePrompt,
        pipeline: pipelineName,
        stage: firstStageName,
        tags: opts?.tags ?? ["in progress"],
        pr_number: null,
        pr_url: null,
        branch,
        agent_type: effectiveAgentType,
        agent_provider: effectiveAgentProvider,
        port_offset: portOffset,
        port_env: null,
        activity: "working",
        display_name: displayName,
        base_ref: baseRef,
      });
    } catch (e) {
      console.error("[store] DB insert failed:", e);
      toast.error(tt('toasts.dbInsertFailed'));
      throw e;
    }

    pendingSetupIds.value = [...pendingSetupIds.value, id];
    bump();

    // Worktree creation, config read, and agent spawn run in the background.
    // Selection is deferred until setup completes so the terminal mounts
    // only after the session exists in the daemon.
    setupWorktreeAndSpawn(id, repoPath, worktreePath, branch, portOffset, pipelinePrompt, effectiveAgentType, opts);
  }

  /** Background IO for createItem: read config, create worktree, spawn agent, then select. */
  async function setupWorktreeAndSpawn(
    id: string, repoPath: string, worktreePath: string,
    branch: string, portOffset: number, prompt: string,
    agentType: "pty" | "sdk",
    opts?: { baseBranch?: string; tags?: string[]; pipelineName?: string; stage?: string; customTask?: CustomTaskConfig; agentProvider?: "claude" | "copilot"; model?: string; permissionMode?: string; allowedTools?: string[] },
  ) {
    try {
      // Read config and create worktree concurrently — they're independent.
      let repoConfig: RepoConfig;
      try {
        const [config] = await Promise.all([
          readRepoConfig(repoPath),
          createWorktree(repoPath, branch, worktreePath, opts?.baseBranch),
        ]);
        repoConfig = config;
      } catch (e) {
        console.error("[store] git_worktree_add failed:", e);
        toast.error(tt('toasts.worktreeFailed'));
        return;
      }

      const portEnv = computePortEnv(repoConfig, portOffset);

      if (Object.keys(portEnv).length > 0) {
        await _db.execute(
          "UPDATE pipeline_item SET port_env = ? WHERE id = ?",
          [JSON.stringify(portEnv), id],
        );
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
            agentProvider: opts?.customTask?.agentProvider ?? opts?.agentProvider,
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
      await selectItem(id);
    } finally {
      pendingSetupIds.value = pendingSetupIds.value.filter(pid => pid !== id);
    }
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

    // Pipeline env vars — passed to agent so kanna-cli can signal stage completion
    env.KANNA_TASK_ID = sessionId;
    try {
      const socketPath = await invoke<string>("get_pipeline_socket_path");
      env.KANNA_SOCKET_PATH = socketPath;
    } catch (e) {
      console.error("[store] failed to get pipeline socket path:", e);
    }
    try {
      const appDataDir = await invoke<string>("get_app_data_dir");
      const dbName = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" }).catch(() => "kanna-v2.db");
      env.KANNA_DB_PATH = `${appDataDir}/${dbName}`;
    } catch (e) {
      console.error("[store] failed to get DB path:", e);
    }

    const provider = options?.agentProvider ?? "claude";
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    let agentCmd: string;

    if (provider === "copilot") {
      // Build Copilot flags
      const copilotFlags: string[] = [];
      if (!options?.permissionMode || options.permissionMode === "dontAsk") {
        copilotFlags.push("--yolo");
      } else {
        // Copilot doesn't have an exact equivalent of --permission-mode acceptEdits.
        // Fall back to --yolo for now; users can use --allow-tool/--deny-tool for finer control.
        copilotFlags.push("--yolo");
      }
      if (options?.model) copilotFlags.push(`--model=${options.model}`);
      if (options?.allowedTools?.length) {
        for (const tool of options.allowedTools) copilotFlags.push(`--allow-tool=${tool}`);
      }
      if (options?.disallowedTools?.length) {
        for (const tool of options.disallowedTools) copilotFlags.push(`--deny-tool=${tool}`);
      }
      // maxTurns and maxBudgetUsd have no Copilot equivalent — skip silently

      agentCmd = `copilot ${copilotFlags.join(" ")} -i '${escapedPrompt}'`;
    } else {
      // Claude: inject hooks via --settings flag
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

      if (options?.resumeSessionId) {
        agentCmd = `claude ${flags.join(" ")}`;
      } else {
        agentCmd = `claude ${flags.join(" ")} '${escapedPrompt}'`;
      }
    }

    const allSetupCmds = [...setupCmds, ...(options?.setupCmdsOverride || [])];
    let fullCmd: string;
    if (allSetupCmds.length > 0) {
      const setupParts = allSetupCmds.map((cmd) => {
        const escaped = cmd.replace(/'/g, "'\\''");
        return `printf '\\033[2m$ %s\\033[0m\\n' '${escaped}' && ${cmd}`;
      });
      fullCmd = `printf '\\033[33mRunning startup...\\033[0m\\n' && ${setupParts.join(" && ")} && printf '\\n' && ${agentCmd}`;
    } else {
      fullCmd = agentCmd;
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
    const nextId = remaining[nextIdx]?.id || null;
    if (nextId) {
      selectItem(nextId);
    } else {
      selectedItemId.value = null;
    }
  }

  async function closeTask(targetItemId?: string) {
    lastUndoAction.value = null;
    const item = targetItemId
      ? items.value.find(i => i.id === targetItemId)
      : currentItem.value;
    const repo = item
      ? repos.value.find(r => r.id === item.repo_id)
      : selectedRepo.value;
    if (!item || !repo) return;
    try {
      // Lingering — second close finishes the task
      if (hasTag(item, "lingering")) {
        await removePipelineItemTag(_db, item.id, "lingering");
        await closePipelineItem(_db, item.id);
        selectNextItem(item.id);
        await checkUnblocked(item.id);
        bump();
        return;
      }

      // Already tearing down — force complete
      if (hasTag(item, "teardown")) {
        await invoke("kill_session", { sessionId: `td-${item.id}` }).catch((e: unknown) =>
          console.error("[store] kill teardown session failed:", e));
        await removePipelineItemTag(_db, item.id, "teardown");
        await closePipelineItem(_db, item.id);
        selectNextItem(item.id);
        bump();
        return;
      }

      const wasBlocked = hasTag(item, "blocked");

      // Blocked tasks never started — no teardown needed
      if (wasBlocked) {
        await removeAllBlockersForItem(_db, item.id);
        await closePipelineItem(_db, item.id);
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
        // No teardown — close (or linger if dev hack enabled)
        if (devLingerTerminals.value) {
          await addPipelineItemTag(_db, item.id, "lingering");
        } else {
          await closePipelineItem(_db, item.id);
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
          } catch (e) { console.error("[store] close cleanup failed:", e); }
        })();
        return;
      }

      // Has teardown scripts — enter teardown state
      // 1. Gracefully stop Claude, kill shell
      await Promise.all([
        invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((e: unknown) =>
          console.error("[store] signal_session failed:", e)),
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
      await invoke("attach_session", { sessionId: tdSessionId, agentProvider: "claude" });

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
      // Find most recently closed item to undo
      const rows = await _db.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE closed_at IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
      );
      const item = rows[0];
      if (!item) return;
      const repo = repos.value.find((r) => r.id === item.repo_id);
      if (!repo) return;
      await reopenPipelineItem(_db, item.id);
      await updatePipelineItemActivity(_db, item.id, "working");
      await selectItem(item.id);
      bump();
      // Spawn before selecting so the terminal mounts with the session already alive
      // (avoids a race where the terminal's spawn-on-mount and this spawn both fire)
      if (item.branch) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        try {
          await spawnPtySession(item.id, worktreePath, item.prompt || "", 80, 24, {
            agentProvider: (item.agent_provider as "claude" | "copilot") || "claude",
            ...(item.claude_session_id ? { resumeSessionId: item.claude_session_id } : {}),
          });
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

  // ── Pipeline engine: advanceStage ─────────────────────────────────
  /** Advance a task to the next pipeline stage. Core pipeline engine function. */
  async function advanceStage(taskId: string): Promise<void> {
    const item = items.value.find(i => i.id === taskId);
    if (!item?.branch) return;

    const repo = repos.value.find(r => r.id === item.repo_id) ?? await getRepo(_db, item.repo_id);
    if (!repo) {
      console.error("[store] advanceStage: repo not found for", taskId);
      return;
    }

    // Load pipeline definition
    let pipeline: PipelineDefinition;
    try {
      pipeline = await loadPipeline(repo.path, item.pipeline);
    } catch (e) {
      console.error("[store] advanceStage: pipeline definition not found:", e);
      toast.error(tt('toasts.pipelineNotFound'));
      return;
    }

    // Find next stage
    const nextStage = getNextStage(pipeline, item.stage);
    if (!nextStage) {
      toast.warning(tt('toasts.taskAtFinalStage'));
      return;
    }

    // Check blockers
    if (await hasUnresolvedBlockers(taskId)) {
      toast.warning(tt('toasts.taskBlocked'));
      return;
    }

    // Build the next stage's prompt
    let stagePrompt = "";
    const agentProvider = item.agent_provider as "claude" | "copilot" | undefined;
    let agentOpts: Record<string, unknown> = {};

    if (nextStage.agent) {
      try {
        const agent = await loadAgent(repo.path, nextStage.agent);
        const prevResult = item.stage_result ?? undefined;
        stagePrompt = buildStagePrompt(agent.prompt, nextStage.prompt, {
          taskPrompt: item.prompt ?? "",
          prevResult,
          branch: item.branch ?? undefined,
        });

        // Determine agent provider: stage override > agent definition > item default
        const resolvedProvider = (nextStage.agent_provider ?? (
          Array.isArray(agent.agent_provider) ? agent.agent_provider[0] : agent.agent_provider
        ) ?? agentProvider) as "claude" | "copilot" | undefined;

        agentOpts = {
          agentProvider: resolvedProvider,
          model: agent.model,
          permissionMode: agent.permission_mode,
          allowedTools: agent.allowed_tools,
        };
      } catch (e) {
        console.error("[store] advanceStage: failed to load agent:", e);
        toast.error(`${tt('toasts.agentStartFailed')}: ${e instanceof Error ? e.message : e}`);
        return;
      }
    }

    // Create new task for the next stage, then close the source task.
    const oldItemId = item.id;

    await createItem(repo.id, repo.path, stagePrompt, "pty", {
      baseBranch: item.branch,
      pipelineName: item.pipeline,
      stage: nextStage.name,
      ...agentOpts,
    });

    // Close the source task (runs teardown, kills sessions, cleans up)
    await closeTask(oldItemId);
  }

  /** Force advance, skipping teardown scripts. Used when teardown fails. */
  async function forceAdvanceStage(taskId: string): Promise<void> {
    // Same as advanceStage but skips teardown — advanceStage currently
    // doesn't run teardown anyway (it closes + creates new), so just delegate
    await advanceStage(taskId);
  }

  /** Re-run the current stage's setup + agent without advancing. Used after failure. */
  async function rerunStage(taskId: string): Promise<void> {
    const item = items.value.find(i => i.id === taskId);
    if (!item) return;

    const repo = repos.value.find(r => r.id === item.repo_id) ?? await getRepo(_db, item.repo_id);
    if (!repo) return;

    let pipeline: PipelineDefinition;
    try {
      pipeline = await loadPipeline(repo.path, item.pipeline);
    } catch (e) {
      console.error("[store] rerunStage: pipeline not found:", e);
      toast.error(tt('toasts.pipelineNotFound'));
      return;
    }

    const currentStage = pipeline.stages.find(s => s.name === item.stage);
    if (!currentStage) {
      console.error("[store] rerunStage: stage not found:", item.stage);
      toast.error(tt('toasts.stageNotFound'));
      return;
    }

    // Clear previous stage result
    await clearPipelineItemStageResult(_db, taskId);

    // Run setup
    if (currentStage.environment) {
      const env = pipeline.environments?.[currentStage.environment];
      if (env?.setup?.length) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        try {
          for (const script of env.setup) {
            await invoke("run_script", { script, cwd: worktreePath, env: { KANNA_WORKTREE: "1" } });
          }
        } catch (e) {
          console.error("[store] rerunStage: setup script failed:", e);
          toast.error(tt('toasts.stageSetupFailed'));
          return;
        }
      }
    }

    // Spawn agent
    if (currentStage.agent) {
      try {
        const agent = await loadAgent(repo.path, currentStage.agent);
        const stagePrompt = buildStagePrompt(agent.prompt, currentStage.prompt, {
          taskPrompt: item.prompt ?? "",
          branch: item.branch ?? undefined,
        });
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        const agentProvider = (currentStage.agent_provider ?? (
          Array.isArray(agent.agent_provider) ? agent.agent_provider[0] : agent.agent_provider
        ) ?? item.agent_provider) as "claude" | "copilot";

        await invoke("kill_session", { sessionId: taskId }).catch((e: unknown) =>
          console.error("[store] kill_session before rerun failed:", e));

        await spawnPtySession(taskId, worktreePath, stagePrompt, 80, 24, {
          agentProvider,
          model: agent.model,
          permissionMode: agent.permission_mode,
          allowedTools: agent.allowed_tools,
        });
      } catch (e) {
        console.error("[store] rerunStage: agent spawn failed:", e);
        toast.error(`${tt('toasts.agentStartFailed')}: ${e instanceof Error ? e.message : e}`);
      }
    }

    bump();
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
    const dl = await getSetting(_db, "dev.lingerTerminals");
    devLingerTerminals.value = dl === "true";
  }

  async function savePreference(key: string, value: string) {
    await setSetting(_db, key, value);
    await loadPreferences();
  }

  // ── Actions: Stage advance (keyboard shortcut, replaces makePR) ──
  async function makePR() {
    const item = currentItem.value;
    if (!item) return;
    try {
      await advanceStage(item.id);
    } catch (e) {
      console.error("[store] stage advance failed:", e);
      toast.error(tt('toasts.prAgentFailed'));
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
      // Load merge agent from pipeline definitions
      const agent = await loadAgent(repo.path, "merge");
      await createItem(repo.id, repo.path, agent.prompt, "pty");
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
      // A task is "blocked" if it has entries in task_blocker.
      // Check if all its blockers have been closed.
      if (blocked.closed_at !== null) continue; // already closed
      const blockers = await listBlockersForItem(_db, blocked.id);
      if (blockers.length === 0) continue;
      const allClear = blockers.every(b => b.closed_at !== null);
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
    let resolvedBaseRef: string | null = null;
    if (!worktreeExists) {
      // Fetch origin so the worktree starts from the latest remote state
      let startPoint: string | null = null;
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
        await invoke("git_fetch", { repoPath: repo.path, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
        resolvedBaseRef = startPoint;
      } catch (e) {
        console.debug("[store] fetch origin failed (offline?), using local HEAD:", e);
        // Try to at least get the default branch name for base_ref
        try {
          const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
          resolvedBaseRef = defaultBranch;
        } catch {
          // leave resolvedBaseRef as null
        }
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
        "SELECT * FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL",
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
       SET branch = ?, port_offset = ?, port_env = ?, base_ref = ?,
           tags = '[]', activity = 'working',
           activity_changed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [branch, portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, resolvedBaseRef, id],
    );

    bump();

    try {
      await spawnPtySession(id, worktreePath, augmentedPrompt, 80, 24, {
        agentProvider: (item.agent_provider as "claude" | "copilot") || "claude",
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
    if (!item || !repo || isItemHidden(item) || hasTag(item, "blocked")) return;

    const originalPrompt = item.prompt;
    const originalRepoId = item.repo_id;
    const originalAgentType = item.agent_type;
    const originalAgentProvider = item.agent_provider;
    const originalDisplayName = item.display_name;
    const originalId = item.id;

    const newId = generateId();
    await insertPipelineItem(_db, {
      id: newId,
      repo_id: originalRepoId,
      issue_number: null,
      issue_title: null,
      prompt: originalPrompt,
      pipeline: item.pipeline,
      stage: item.stage,
      tags: ["blocked"],
      pr_number: null,
      pr_url: null,
      branch: null,
      agent_type: originalAgentType,
      agent_provider: originalAgentProvider || "claude",
      port_offset: null,
      port_env: null,
      activity: "idle",
      base_ref: null,
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

      await closePipelineItem(_db, originalId);
      // The original task being closed may unblock other tasks that
      // were waiting on it. We must check — suppressing this causes deadlocks
      // when two tasks block each other (A blocked by B, then B blocked by A').
      await checkUnblocked(originalId);
    } catch (e) {
      console.error("[store] blockTask close failed:", e);
      toast.error(tt('toasts.blockTaskFailed'));
    }

    bump();
    await selectItem(newId);
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
      b => b.closed_at !== null
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
      console.debug(`[store] auto-starting previously blocked task: ${item.id}`);
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
        restoreSelection(savedItem);
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
        if (item.closed_at !== null) continue;
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

      if (hookEvent === "ClaudeWorking" || hookEvent === "CopilotThinking") {
        if (item.activity !== "working") {
          await updatePipelineItemActivity(_db, item.id, "working");
          bump();
        }
      } else if (hookEvent === "ClaudeIdle" || hookEvent === "CopilotIdle") {
        if (item.activity === "working") {
          if (selectedItemId.value === sessionId) {
            await updatePipelineItemActivity(_db, item.id, "idle");
          } else {
            await updatePipelineItemActivity(_db, item.id, "unread");
          }
          bump();
        }
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
      }
    });

    listen("session_exit", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      if (!sessionId) return;

      // Teardown session finished — close task
      if (typeof sessionId === "string" && sessionId.startsWith("td-")) {
        const itemId = sessionId.slice(3);
        const item = items.value.find((i) => i.id === itemId);
        if (!item || !hasTag(item, "teardown")) return;
        await removePipelineItemTag(_db, itemId, "teardown");
        if (devLingerTerminals.value) {
          await addPipelineItemTag(_db, itemId, "lingering");
        } else {
          await closePipelineItem(_db, itemId);
          if (selectedItemId.value === itemId) {
            selectNextItem(itemId);
          }
          await checkUnblocked(itemId);
        }
        bump();
        return;
      }

      _handleAgentFinished(sessionId);
    });

    // Pipeline stage-complete signal from kanna-cli via app socket
    listen("pipeline_stage_complete", async (event: unknown) => {
      const payload = (event as { payload: { task_id: string } }).payload;
      const taskId = payload?.task_id;
      if (!taskId) return;

      const item = items.value.find(i => i.id === taskId);
      if (!item) return;

      // Reload item from DB to get fresh stage_result
      bump();

      // Wait a tick for computedAsync to refresh
      await new Promise(resolve => setTimeout(resolve, 100));

      const freshItem = items.value.find(i => i.id === taskId);
      if (!freshItem) return;

      // Load pipeline to check transition type
      const repo = repos.value.find(r => r.id === freshItem.repo_id);
      if (!repo) return;

      try {
        const pipeline = await loadPipeline(repo.path, freshItem.pipeline);
        const stage = pipeline.stages.find(s => s.name === freshItem.stage);
        if (!stage) return;

        if (stage.transition === "auto") {
          // Parse stage_result to check if agent signaled success
          if (freshItem.stage_result) {
            try {
              const result = JSON.parse(freshItem.stage_result) as StageCompleteResult;
              if (result.status === "success") {
                await advanceStage(taskId);
              }
            } catch (e) {
              console.error("[store] failed to parse stage_result:", e);
            }
          }
        }

        // For manual transition or failure: mark activity as unread so user notices
        if (selectedItemId.value !== taskId) {
          await updatePipelineItemActivity(_db, taskId, "unread");
          bump();
        }
      } catch (e) {
        console.error("[store] pipeline_stage_complete handler failed:", e);
      }
    });
  }

  return {
    // State
    repos, items, selectedRepoId, selectedItemId, lastSelectedItemByRepo,
    canGoBack, canGoForward,
    suspendAfterMinutes, killAfterMinutes,
    ideCommand, gcAfterDays, hideShortcutsOnStartup, devLingerTerminals,
    lastUndoAction, refreshKey,
    // Getters
    selectedRepo, currentItem, sortedItemsForCurrentRepo, sortedItemsAllRepos,
    // Actions
    bump, init,
    selectRepo, selectItem, goBack, goForward,
    importRepo, createRepo, cloneAndImportRepo, hideRepo,
    createItem, spawnPtySession, spawnShellSession, closeTask, undoClose,
    advanceStage, forceAdvanceStage, rerunStage,
    loadPipeline, loadAgent,
    makePR, mergeQueue,
    blockTask, editBlockedTask,
    listBlockersForItem: (itemId: string) => listBlockersForItem(_db, itemId),
    listBlockedByItem: (itemId: string) => listBlockedByItem(_db, itemId),
    pinItem, unpinItem, reorderPinned, renameItem,
    savePreference,
  };
});
