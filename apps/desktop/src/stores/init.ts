import { getSetting, getUnblockedItems, listRepos, setSetting, type DbHandle, type PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import { clearCachedTerminalState } from "../composables/terminalStateCache";
import { markDaemonReadyObserved } from "../composables/daemonReadyState";
import {
  getTaskIdFromTeardownSessionId,
  isTeardownSessionId,
  reportCloseSessionError,
  reportPrewarmSessionError,
  shouldAutoCloseTaskAfterTeardownExit,
  shouldClearCachedTerminalStateOnSessionExit,
} from "./kannaCleanup";
import { formatAppWindowTitle, type AppBuildInfo } from "./windowTitle";
import { isTaskTearingDown } from "./taskStages";
import { requireService, type StoreContext } from "./state";
import { normalizeAppThemePreference, normalizeCodeThemePreference } from "../theme/theme";
import type { AgentMessageAppearance } from "./state";

export interface InitApi {
  init: (db: DbHandle) => Promise<void>;
  loadPreferences: () => Promise<void>;
  savePreference: (key: string, value: string) => Promise<void>;
}

const WORKTREE_SHELL_ENV_GENERATION_KEY = "worktreeShellEnvGeneration";
const WORKTREE_SHELL_ENV_GENERATION = "2026-06-23-worktree-shell-env-v2";

interface DaemonSessionListEntry {
  session_id?: string;
  kind?: string;
}

export function createInitApi(
  context: StoreContext,
  ports: import("./ports").PortsStore,
  tasks: Pick<import("./tasks").TasksApi, "checkUnblocked" | "handleAgentFinished" | "restoreUnblockedTask">,
): InitApi {
  function isVisibleItemInSelectedRepo(item: PipelineItem | null | undefined): item is PipelineItem {
    return Boolean(
      item
      && item.closed_at === null
      && item.repo_id === context.state.selectedRepoId.value,
    );
  }

  function resolveFocusedTaskIdBeforeExternalRefresh(): string | null {
    const selectedItem = context.state.selectedItemId.value
      ? context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value)
      : null;
    if (isVisibleItemInSelectedRepo(selectedItem)) return selectedItem.id;

    const currentItem = context.services.currentItem?.value ?? null;
    if (isVisibleItemInSelectedRepo(currentItem)) return currentItem.id;

    return null;
  }

  async function preserveFocusedTaskAfterExternalRefresh(taskId: string | null): Promise<void> {
    if (!taskId) return;

    const selectedItem = context.state.selectedItemId.value
      ? context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value)
      : null;
    if (isVisibleItemInSelectedRepo(selectedItem)) return;

    const focusedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!isVisibleItemInSelectedRepo(focusedItem)) return;

    context.state.selectedItemId.value = focusedItem.id;
    context.state.lastSelectedItemByRepo.value[focusedItem.repo_id] = focusedItem.id;
    await context.services.windowWorkspace?.persistSelection({
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: focusedItem.id,
    });
  }

  async function preserveExplicitSelectionAfterExternalRefresh(
    selectedItemIdBeforeRefresh: string | null,
  ): Promise<void> {
    if (!selectedItemIdBeforeRefresh) return;

    const selectedItem = context.state.items.value.find((candidate) => candidate.id === selectedItemIdBeforeRefresh);
    if (isVisibleItemInSelectedRepo(selectedItem)) return;

    const selectedRepoId = context.state.selectedRepoId.value;
    context.state.selectedItemId.value = null;
    if (selectedRepoId && context.state.lastSelectedItemByRepo.value[selectedRepoId] === selectedItemIdBeforeRefresh) {
      const { [selectedRepoId]: _removed, ...remaining } = context.state.lastSelectedItemByRepo.value;
      context.state.lastSelectedItemByRepo.value = remaining;
    }
    await context.services.windowWorkspace?.persistSelection({
      selectedRepoId,
      selectedItemId: null,
    });
  }

  function readSessionId(event: unknown): string | null {
    const payload = (event as { payload?: { session_id?: string } }).payload ?? (event as { session_id?: string });
    return typeof payload.session_id === "string" ? payload.session_id : null;
  }

  function isTaskAgentSession(sessionId: string): boolean {
    return !sessionId.startsWith("shell-") && !isTeardownSessionId(sessionId);
  }

  function normalizeAgentMessageAppearance(value: string | null): AgentMessageAppearance {
    if (value === "log" || value === "terminal") return value;
    return "chat";
  }

  async function loadPreferences() {
    const suspendAfter = await getSetting(context.requireDb(), "suspendAfterMinutes");
    if (suspendAfter) context.state.suspendAfterMinutes.value = parseInt(suspendAfter, 10) || 30;
    const killAfter = await getSetting(context.requireDb(), "killAfterMinutes");
    if (killAfter) context.state.killAfterMinutes.value = parseInt(killAfter, 10) || 60;
    const ide = await getSetting(context.requireDb(), "ideCommand");
    if (ide) context.state.ideCommand.value = ide;
    const hideShortcuts = await getSetting(context.requireDb(), "hideShortcutsOnStartup");
    context.state.hideShortcutsOnStartup.value = hideShortcuts === "true";
    const linger = await getSetting(context.requireDb(), "dev.lingerTerminals");
    context.state.devLingerTerminals.value = linger === "true";
    const appTheme = await getSetting(context.requireDb(), "appTheme");
    context.state.appTheme.value = normalizeAppThemePreference(appTheme);
    const codeTheme = await getSetting(context.requireDb(), "codeTheme");
    context.state.codeTheme.value = normalizeCodeThemePreference(codeTheme);
    const agentMessageAppearance = await getSetting(context.requireDb(), "agentMessageAppearance");
    const legacyAgentMessageStyle = agentMessageAppearance
      ? null
      : await getSetting(context.requireDb(), "agentMessageStyle");
    context.state.agentMessageAppearance.value = normalizeAgentMessageAppearance(
      agentMessageAppearance ?? legacyAgentMessageStyle,
    );
  }

  async function savePreference(key: string, value: string) {
    const { setSetting } = await import("@kanna/db");
    await setSetting(context.requireDb(), key, value);
    await loadPreferences();
  }

  async function retireStaleWorktreeShellSessions(): Promise<void> {
    const currentGeneration = await getSetting(context.requireDb(), WORKTREE_SHELL_ENV_GENERATION_KEY);
    if (currentGeneration === WORKTREE_SHELL_ENV_GENERATION) return;

    try {
      const sessions = await invoke<DaemonSessionListEntry[]>("list_sessions");
      const worktreeShellIds = sessions
        .map((session) => session.session_id)
        .filter((sessionId): sessionId is string => Boolean(sessionId?.startsWith("shell-wt-")));

      await Promise.all(worktreeShellIds.map((sessionId) =>
        invoke("kill_session", { sessionId }).catch((error: unknown) => {
          console.warn("[store] failed to retire stale worktree shell:", { sessionId, error });
        }),
      ));
      await setSetting(context.requireDb(), WORKTREE_SHELL_ENV_GENERATION_KEY, WORKTREE_SHELL_ENV_GENERATION);
    } catch (error) {
      console.warn("[store] failed to inspect worktree shell sessions for env migration:", error);
    }
  }

  async function init(db: DbHandle) {
    context.state.db.value = db;
    await loadPreferences();

    const { updatePipelineItemActivity, closePipelineItem } = await import("@kanna/db");

    const workingItems = await context.requireDb().select<PipelineItem>(
      "SELECT * FROM pipeline_item WHERE activity = 'working'",
    );
    for (const item of workingItems) {
      await updatePipelineItemActivity(context.requireDb(), item.id, "unread");
    }

    const eagerRepos = await listRepos(context.requireDb());
    const eagerItems: PipelineItem[] = [];
    const { listPipelineItems } = await import("@kanna/db");
    for (const repo of eagerRepos) {
      eagerItems.push(...await listPipelineItems(context.requireDb(), repo.id));
    }

    if (isTauri) {
      await retireStaleWorktreeShellSessions();
      // Orphan = a task whose workspace was initialized (worktree row exists)
      // but whose directory is gone from disk. Dormant blocked tasks have a
      // branch name reserved yet no worktree row until their blockers close —
      // they must survive app restarts, so key on the worktree row, not on
      // the branch column.
      const worktreeRows = await context.requireDb().select<{ pipeline_item_id: string; path: string }>(
        "SELECT pipeline_item_id, path FROM worktree",
      );
      const worktreePathByItemId = new Map(worktreeRows.map((row) => [row.pipeline_item_id, row.path]));
      for (const item of eagerItems) {
        if (item.closed_at !== null) continue;
        const worktreePath = worktreePathByItemId.get(item.id);
        if (!worktreePath) continue;
        const exists = await invoke<boolean>("file_exists", { path: worktreePath });
        if (!exists) {
          console.warn(`[store] closing orphaned task ${item.id}: worktree missing at ${worktreePath}`);
          await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
          item.closed_at = new Date().toISOString();
        }
      }
    }

    const unblockedItems = await getUnblockedItems(context.requireDb());
    for (const item of unblockedItems) {
      console.debug(`[store] restoring previously blocked task: ${item.id}`);
      await tasks.restoreUnblockedTask(item);
    }

    await requireService(context.services.loadInitialData, "loadInitialData")();

    const bootstrap = context.state.initialWindowBootstrap.value;
    const bootstrapRepoId = bootstrap?.selectedRepoId ?? null;
    const bootstrapItemId = bootstrap?.selectedItemId ?? null;
    if (bootstrapRepoId && eagerRepos.some((repo) => repo.id === bootstrapRepoId)) {
      context.state.selectedRepoId.value = bootstrapRepoId;
    } else if (eagerRepos.length > 0) {
      context.state.selectedRepoId.value = eagerRepos[0].id;
    }

    if (
      bootstrapItemId
      && eagerItems.some((item) =>
        item.id === bootstrapItemId
        && item.closed_at === null
        && item.repo_id === context.state.selectedRepoId.value)
    ) {
      requireService(context.services.restoreSelection, "restoreSelection")(bootstrapItemId);
    }

    if (isTauri) {
      try {
        const [branch, commitHash, worktree, gitInfo] = await Promise.all([
          invoke<string>("read_env_var", { name: "KANNA_BUILD_BRANCH" }).catch((error) => {
            console.debug("[store] KANNA_BUILD_BRANCH not set:", error);
            return "";
          }),
          invoke<string>("read_env_var", { name: "KANNA_BUILD_COMMIT" }).catch((error) => {
            console.debug("[store] KANNA_BUILD_COMMIT not set:", error);
            return "";
          }),
          invoke<string>("read_env_var", { name: "KANNA_BUILD_WORKTREE" }).catch((error) => {
            console.debug("[store] KANNA_BUILD_WORKTREE not set:", error);
            return "";
          }),
          invoke<{ version: string }>("git_app_info").catch((error) => {
            console.debug("[store] failed to read git app info:", error);
            return { version: "" };
          }),
        ]);
        const title = formatAppWindowTitle({
          branch,
          commitHash,
          worktree,
          version: gitInfo.version,
        } satisfies AppBuildInfo);
        if (title) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setTitle(title);
        }
      } catch (error) {
        console.error("[store] failed to set window title:", error);
      }
    }

    if (isTauri) {
      for (const item of eagerItems) {
        if (!item.branch || item.closed_at !== null) continue;
        const repo = eagerRepos.find((candidate) => candidate.id === item.repo_id);
        if (!repo) continue;
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        requireService(context.services.prewarmWorktreeShellSession, "prewarmWorktreeShellSession")(
          `shell-wt-${item.id}`,
          worktreePath,
          item.port_env,
          repo.path,
        ).catch((error) => reportPrewarmSessionError("[store] shell pre-warm failed:", error));
      }
      for (const repo of eagerRepos) {
        requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${repo.id}`, repo.path, null, false)
          .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
      }
    }

    await context.services.windowWorkspace?.onSharedInvalidation(async () => {
      const selectedItemIdBeforeRefresh = context.state.selectedItemId.value;
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await preserveExplicitSelectionAfterExternalRefresh(selectedItemIdBeforeRefresh);
    });

    listen("session_created", async (event: unknown) => {
      const sessionId = readSessionId(event);
      if (!sessionId || !isTaskAgentSession(sessionId)) return;

      const focusedTaskId = resolveFocusedTaskIdBeforeExternalRefresh();
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await preserveFocusedTaskAfterExternalRefresh(focusedTaskId);
    });

    listen("status_changed", async (event: unknown) => {
      const payload = (event as { payload?: { session_id?: string; status?: string } }).payload ?? (event as { session_id?: string; status?: string });
      const sessionId = payload.session_id;
      const status = payload.status;
      if (!sessionId || typeof status !== "string") return;

      const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
      if (!item) return;
      await requireService(context.services.applyTaskRuntimeStatus as ((item: PipelineItem, status: string) => Promise<void>) | undefined, "applyTaskRuntimeStatus")(item, status);
    });

    listen("session_exit", async (event: unknown) => {
      const payload = (event as { payload?: { session_id?: string; code?: number; resume_session_id?: string | null } }).payload
        ?? (event as { session_id?: string; code?: number; resume_session_id?: string | null });
      const sessionId = payload.session_id;
      if (!sessionId) return;

      requireService(context.services.resolveSessionExitWaiters, "resolveSessionExitWaiters")(sessionId);
      await requireService(context.services.persistExitedSessionResumeId, "persistExitedSessionResumeId")(
        sessionId,
        payload.resume_session_id,
      );

      if (typeof sessionId === "string" && isTeardownSessionId(sessionId)) {
        const itemId = getTaskIdFromTeardownSessionId(sessionId);
        const exitCode = typeof payload.code === "number" ? payload.code : null;
        if (!itemId || !shouldAutoCloseTaskAfterTeardownExit({
          exitCode,
          lingerEnabled: context.state.devLingerTerminals.value,
        })) {
          return;
        }

        const item = context.state.items.value.find((candidate) => candidate.id === itemId);
        if (!item || !isTaskTearingDown(item)) {
          return;
        }

        await Promise.all([
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill agent session failed:", error)),
          invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill shell session failed:", error)),
        ]);
        if (context.state.selectedItemId.value === item.id) {
          await requireService(
            context.services.selectReplacementAfterItemRemoval,
            "selectReplacementAfterItemRemoval",
          )(item);
        }
        await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
        await tasks.checkUnblocked(item.id);
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
        return;
      }

      if (shouldClearCachedTerminalStateOnSessionExit(sessionId)) {
        clearCachedTerminalState(sessionId);
      }
      void tasks.handleAgentFinished(sessionId);
    });

    listen("daemon_ready", async () => {
      markDaemonReadyObserved();
      await requireService(context.services.syncTaskStatusesFromDaemon, "syncTaskStatusesFromDaemon")();
    });

    listen("pipeline_stage_complete", async (event: unknown) => {
      const payload = (event as { payload?: { task_id?: string } }).payload ?? (event as { task_id?: string });
      const taskId = payload.task_id;
      if (!taskId) return;

      const item = context.state.items.value.find((candidate) => candidate.id === taskId);
      if (!item) return;

      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();

      const freshItem = context.state.items.value.find((candidate) => candidate.id === taskId);
      if (!freshItem) return;

      try {
        if (context.state.selectedItemId.value !== taskId) {
          await updatePipelineItemActivity(context.requireDb(), taskId, "unread");
          await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
        }
      } catch (error) {
        console.error("[store] pipeline_stage_complete handler failed:", error);
      }
    });
  }

  return {
    init,
    loadPreferences,
    savePreference,
  };
}
