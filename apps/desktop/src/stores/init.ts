import type { StateChangeScope } from "@kanna/agent-protocol";
import type { DbHandle, PipelineItem, TaskBlocker } from "../types/kanna";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import {
  getSharedStreamConnectionState,
  getSharedStreamClient,
  onSharedStreamConnectionChange,
} from "../composables/desktopStreamClient";
import { clearCachedTerminalState } from "../composables/terminalStateCache";
import { markDaemonReadyObserved } from "../composables/daemonReadyState";
import { registerTerminalRuntimeStatusSink } from "../composables/terminalRuntimeStatusSink";
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
import {
  applyDesktopTaskRuntimeStatus,
  closeDesktopTask,
  putDesktopSetting,
} from "../services/desktopServerClient";

export interface InitApi {
  init: (db: DbHandle) => Promise<void>;
  loadPreferences: () => Promise<void>;
  savePreference: (key: string, value: string) => Promise<void>;
}

const WORKTREE_SHELL_ENV_GENERATION_KEY = "worktreeShellEnvGeneration";
const WORKTREE_SHELL_ENV_GENERATION = "2026-06-23-worktree-shell-env-v2";

function createTrailingAsyncCoordinator(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  let trailing = false;

  async function drain(): Promise<void> {
    running = true;
    do {
      trailing = false;
      try {
        await run();
      } catch (error) {
        onError(error);
      }
    } while (trailing);
    running = false;
  }

  return () => {
    if (running) {
      trailing = true;
      return;
    }
    void drain();
  };
}

interface DaemonSessionListEntry {
  session_id?: string;
  kind?: string;
}

export function createInitApi(
  context: StoreContext,
  ports: import("./ports").PortsStore,
  tasks: Pick<import("./tasks").TasksApi, "checkUnblocked" | "handleAgentFinished" | "restoreUnblockedTask">,
): InitApi {
  interface FocusedSelectionBeforeRefresh {
    taskId: string | null;
    selectedRepoId: string | null;
    selectedItemId: string | null;
  }

  function isVisibleItemInSelectedRepo(item: PipelineItem | null | undefined): item is PipelineItem {
    return Boolean(
      item
      && item.closed_at === null
      && item.repo_id === context.state.selectedRepoId.value,
    );
  }

  function resolveFocusedSelectionBeforeExternalRefresh(): FocusedSelectionBeforeRefresh {
    const selectedSlot = requireService(context.services.currentTaskSlot, "currentTaskSlot").value;
    const selectedTaskId = isVisibleItemInSelectedRepo(selectedSlot?.task)
      ? selectedSlot.task.id
      : null;

    const currentItem = context.services.currentItem?.value ?? null;
    return {
      taskId: selectedTaskId
        ?? (isVisibleItemInSelectedRepo(currentItem) ? currentItem.id : null),
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: context.state.selectedItemId.value,
    };
  }

  async function preserveFocusedTaskAfterExternalRefresh(
    selectionBeforeRefresh: FocusedSelectionBeforeRefresh,
  ): Promise<void> {
    const { taskId, selectedRepoId, selectedItemId } = selectionBeforeRefresh;
    if (!taskId) return;

    // Snapshot refreshes are asynchronous. A task selected while one is in
    // flight is newer intent and must not be replaced by the focus captured
    // before the refresh started.
    if (
      context.state.selectedRepoId.value !== selectedRepoId
      || context.state.selectedItemId.value !== selectedItemId
    ) {
      return;
    }

    const selectedSlot = requireService(context.services.currentTaskSlot, "currentTaskSlot").value;
    if (isVisibleItemInSelectedRepo(selectedSlot?.task) && selectedSlot.task.id === taskId) return;

    const focusedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!isVisibleItemInSelectedRepo(focusedItem)) return;

    requireService(context.services.restoreSelection, "restoreSelection")(focusedItem.id);
    await context.services.windowWorkspace?.persistSelection({
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: focusedItem.id,
    });
  }

  async function preserveExplicitSelectionAfterExternalRefresh(
    selectedTaskIdBeforeRefresh: string | null,
    selectedSlotIdBeforeRefresh: string | null,
  ): Promise<void> {
    if (!selectedTaskIdBeforeRefresh) return;

    const selectedSlot = requireService(context.services.currentTaskSlot, "currentTaskSlot").value;
    if (selectedSlot?.task_id === selectedTaskIdBeforeRefresh) return;
    if (context.state.selectedItemId.value !== selectedSlotIdBeforeRefresh) return;

    const selectedItem = context.state.items.value.find((candidate) => candidate.id === selectedTaskIdBeforeRefresh);
    if (isVisibleItemInSelectedRepo(selectedItem)) {
      requireService(context.services.restoreSelection, "restoreSelection")(selectedItem.id);
      return;
    }

    const selectedRepoId = context.state.selectedRepoId.value;
    context.state.selectedItemId.value = null;
    if (selectedRepoId && context.state.lastSelectedItemByRepo.value[selectedRepoId] === selectedSlotIdBeforeRefresh) {
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

    await requireService(context.services.loadInitialData, "loadInitialData")();

    registerTerminalRuntimeStatusSink(async (sessionId, status) => {
      const item = resolveTaskItemForDaemonSession(context.state.items.value, sessionId);
      if (!item) return;
      await requireService(
        context.services.applyTaskRuntimeStatus as ((item: PipelineItem, status: string) => Promise<void>) | undefined,
        "applyTaskRuntimeStatus",
      )(item, status);
    });

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
    let changedStartupActivity = false;
    for (const item of workingItems) {
      const response = await applyDesktopTaskRuntimeStatus(item.id, {
        status: "idle",
        selected: false,
      });
      changedStartupActivity = changedStartupActivity || response.activity != null;
    }
    if (changedStartupActivity) {
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
          await ports.closeTaskAndReleasePorts(item.id, closeDesktopTask);
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
      const selectedTaskIdBeforeRefresh = requireService(
        context.services.selectedTaskId,
        "selectedTaskId",
      ).value;
      const selectedSlotIdBeforeRefresh = context.state.selectedItemId.value;
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await preserveExplicitSelectionAfterExternalRefresh(
        selectedTaskIdBeforeRefresh,
        selectedSlotIdBeforeRefresh,
      );
    });

    // A repo's `.kanna` definitions change only when the repo does, and the
    // server resolves them out of Git. Re-reading them for a task's activity —
    // which is most of what StateChanged reports — put seconds of Git work
    // between an operator's keystroke and its echo, so only a scope that can
    // have moved a definition asks for one.
    let definitionsNeedRefresh = false;
    const refreshAfterKspStateChange = createTrailingAsyncCoordinator(
      async () => {
        const refreshDefinitions = definitionsNeedRefresh;
        definitionsNeedRefresh = false;
        const focusedSelection = resolveFocusedSelectionBeforeExternalRefresh();
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")({
          refreshDefinitions,
        });
        await preserveFocusedTaskAfterExternalRefresh(focusedSelection);
        console.debug("[store] refreshed snapshot after KSP state change");
      },
      (error) => {
        console.error("[store] KSP state change handler failed:", error);
      },
    );
    const handleKspStateChange = (scope: StateChangeScope) => {
      if (scope === "repos") definitionsNeedRefresh = true;
      refreshAfterKspStateChange();
    };

    if (isTauri) {
      let stateChangeSubscriptionReady = false;
      let lastQueuedConnectionRevision = 0;
      const catchUpAuthenticatedRevision = () => {
        if (!stateChangeSubscriptionReady) return;
        const connection = getSharedStreamConnectionState();
        if (!connection.connected || connection.revision <= lastQueuedConnectionRevision) return;
        lastQueuedConnectionRevision = connection.revision;
        // A gap in the stream can hide a repo-scoped change, so a reconnect
        // reconciles definitions too.
        definitionsNeedRefresh = true;
        refreshAfterKspStateChange();
      };
      onSharedStreamConnectionChange((connected) => {
        if (connected) catchUpAuthenticatedRevision();
      });
      getSharedStreamClient().then((client) => {
        client.onStateChanged(handleKspStateChange);
        stateChangeSubscriptionReady = true;
        // StateChanged is intentionally coarse and has no replay cursor. Once
        // its listener is installed, reconcile every authenticated connection
        // generation so activity changes emitted during startup or a network
        // gap cannot leave an unselected sidebar row stale.
        catchUpAuthenticatedRevision();
      }).catch((error) => {
        stateChangeSubscriptionReady = true;
        console.warn("[store] failed to subscribe to KSP state changes:", error);
      });
    }

    listen("session_created", async (event: unknown) => {
      const sessionId = readSessionId(event);
      if (!sessionId || !isTaskAgentSession(sessionId)) return;

      const focusedSelection = resolveFocusedSelectionBeforeExternalRefresh();
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await preserveFocusedTaskAfterExternalRefresh(focusedSelection);
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
        if (requireService(context.services.selectedTaskId, "selectedTaskId").value === item.id) {
          await requireService(
            context.services.selectReplacementAfterItemRemoval,
            "selectReplacementAfterItemRemoval",
          )(item);
        }
        await ports.closeTaskAndReleasePorts(item.id, closeDesktopTask);
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
    });

  }

  return {
    init,
    loadPreferences,
    savePreference,
  };
}
