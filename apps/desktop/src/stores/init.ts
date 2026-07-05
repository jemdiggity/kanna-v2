import type { DbHandle, PipelineItem, TaskBlocker } from "../types/kanna";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import { getSharedStreamClient } from "../composables/desktopStreamClient";
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
import { resolveTaskItemForDaemonSession } from "./taskSessionIdentity";
import { requireService, type StoreContext } from "./state";
import { applySnapshotSettingsToState } from "./snapshotSettings";
import { cleanupClosedTaskWorktrees } from "./taskWorktreeCleanup";
import { putDesktopSetting } from "../services/desktopServerClient";

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

  function resolveUnblockedItemsFromSnapshot(
    items: readonly PipelineItem[],
    blockers: readonly TaskBlocker[],
  ): PipelineItem[] {
    const openItemIds = new Set(
      items
        .filter((item) => item.closed_at === null)
        .map((item) => item.id),
    );
    const blockerIdsByBlockedItemId = new Map<string, string[]>();

    for (const blocker of blockers) {
      const existing = blockerIdsByBlockedItemId.get(blocker.blocked_item_id);
      if (existing) {
        existing.push(blocker.blocker_item_id);
      } else {
        blockerIdsByBlockedItemId.set(blocker.blocked_item_id, [blocker.blocker_item_id]);
      }
    }

    return items.filter((item) => {
      if (item.closed_at !== null) return false;
      const blockerIds = blockerIdsByBlockedItemId.get(item.id);
      if (!blockerIds?.length) return false;
      return blockerIds.every((blockerId) => !openItemIds.has(blockerId));
    });
  }

  async function loadPreferences() {
    const snapshot = await requireService(context.services.fetchSnapshot, "fetchSnapshot")();
    context.state.snapshotSettings.value = { ...snapshot.settings };
    applySnapshotSettingsToState(context.state, snapshot.settings);
  }

  async function savePreference(key: string, value: string) {
    await putDesktopSetting(key, value);
    const reloadSnapshot = context.services.reloadSnapshot;
    if (reloadSnapshot) {
      await reloadSnapshot();
    } else {
      await loadPreferences();
    }
  }

  async function retireStaleWorktreeShellSessions(settings: Record<string, string>): Promise<void> {
    const currentGeneration = settings[WORKTREE_SHELL_ENV_GENERATION_KEY] ?? null;
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
      await putDesktopSetting(WORKTREE_SHELL_ENV_GENERATION_KEY, WORKTREE_SHELL_ENV_GENERATION);
      context.state.snapshotSettings.value = {
        ...context.state.snapshotSettings.value,
        [WORKTREE_SHELL_ENV_GENERATION_KEY]: WORKTREE_SHELL_ENV_GENERATION,
      };
    } catch (error) {
      console.warn("[store] failed to inspect worktree shell sessions for env migration:", error);
    }
  }

  async function init(db: DbHandle) {
    context.state.db.value = db;
    const { updatePipelineItemActivity, closePipelineItem } = await import("@kanna/db");

    await requireService(context.services.loadInitialData, "loadInitialData")();

    let eagerRepos = [...context.state.repos.value];
    let eagerItems = [...context.state.items.value];
    let snapshotBlockers = [...context.state.taskBlockers.value];
    let worktreePathByItemId = new Map(Object.entries(context.state.worktreePaths.value));

    async function refreshStartupSnapshot(): Promise<void> {
      await context.services.reloadSnapshot?.();
      eagerRepos = [...context.state.repos.value];
      eagerItems = [...context.state.items.value];
      snapshotBlockers = [...context.state.taskBlockers.value];
      worktreePathByItemId = new Map(Object.entries(context.state.worktreePaths.value));
    }

    const workingItems = eagerItems.filter((item) => item.activity === "working");
    for (const item of workingItems) {
      await updatePipelineItemActivity(context.requireDb(), item.id, "unread");
    }
    if (workingItems.length > 0) {
      await refreshStartupSnapshot();
    }

    if (isTauri) {
      await retireStaleWorktreeShellSessions(context.state.snapshotSettings.value);
      // Orphan = a task whose workspace was initialized (worktree row exists)
      // but whose directory is gone from disk. Dormant blocked tasks have a
      // branch name reserved yet no worktree row until their blockers close —
      // they must survive app restarts, so key on the worktree row, not on
      // the branch column.
      let closedOrphan = false;
      for (const item of eagerItems) {
        if (item.closed_at !== null) continue;
        const worktreePath = worktreePathByItemId.get(item.id);
        if (!worktreePath) continue;
        const exists = await invoke<boolean>("file_exists", { path: worktreePath });
        if (!exists) {
          console.warn(`[store] closing orphaned task ${item.id}: worktree missing at ${worktreePath}`);
          await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
          item.closed_at = new Date().toISOString();
          closedOrphan = true;
        }
      }
      if (closedOrphan) {
        await refreshStartupSnapshot();
      }
    }

    const unblockedItems = resolveUnblockedItemsFromSnapshot(eagerItems, snapshotBlockers);
    for (const item of unblockedItems) {
      console.debug(`[store] restoring previously blocked task: ${item.id}`);
      await tasks.restoreUnblockedTask(item);
    }

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
        type AppBuildInfoResponse = Omit<AppBuildInfo, "commitHash"> & {
          commitHash?: string;
          commit_hash?: string;
          taskId?: string;
          task_id?: string;
        };
        const buildInfo = await invoke<AppBuildInfoResponse>("get_app_build_info")
          .catch((error): AppBuildInfoResponse => {
            console.debug("[store] failed to read app build info:", error);
            return { version: "", branch: "", commitHash: "", worktree: "" };
          });
        const title = formatAppWindowTitle({
          branch: buildInfo.branch,
          commitHash: buildInfo.commitHash ?? buildInfo.commit_hash ?? "",
          taskId: buildInfo.taskId ?? buildInfo.task_id ?? "",
          worktree: buildInfo.worktree,
          version: buildInfo.version,
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
        if (item.closed_at !== null) continue;
        const repo = eagerRepos.find((candidate) => candidate.id === item.repo_id);
        if (!repo) continue;
        const worktreePath = worktreePathByItemId.get(item.id);
        if (!worktreePath) continue;
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

    if (isTauri) {
      getSharedStreamClient().then((client) => {
        client.onStateChanged((scope) => {
          void (async () => {
            const focusedTaskId = resolveFocusedTaskIdBeforeExternalRefresh();
            await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
            await preserveFocusedTaskAfterExternalRefresh(focusedTaskId);
            console.debug(`[store] refreshed snapshot after KSP state change: ${scope}`);
          })().catch((error) => {
            console.error("[store] KSP state change handler failed:", error);
          });
        });
      }).catch((error) => {
        console.warn("[store] failed to subscribe to KSP state changes:", error);
      });
    }

    listen("session_created", async (event: unknown) => {
      const sessionId = readSessionId(event);
      if (!sessionId || !isTaskAgentSession(sessionId)) return;

      const focusedTaskId = resolveFocusedTaskIdBeforeExternalRefresh();
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await preserveFocusedTaskAfterExternalRefresh(focusedTaskId);
      await context.services.syncTaskStatusesFromDaemon?.();
    });

    listen("status_changed", async (event: unknown) => {
      const payload = (event as { payload?: { session_id?: string; status?: string } }).payload ?? (event as { session_id?: string; status?: string });
      const sessionId = payload.session_id;
      const status = payload.status;
      if (!sessionId || typeof status !== "string") return;

      const item = resolveTaskItemForDaemonSession(context.state.items.value, sessionId);
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
        const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);

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
        if (repo) {
          await cleanupClosedTaskWorktrees(context, item, repo);
        } else {
          console.warn(`[store] skipped closed task worktree cleanup for ${item.id}: repo not found`);
        }
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

  }

  return {
    init,
    loadPreferences,
    savePreference,
  };
}
