import { computed, ref, type ComputedRef, type Ref } from "vue";
import { type PipelineItem, type Repo } from "../types/kanna";
import type { TaskUiSlot } from "../types/taskUi";
import { fetchDesktopRepoKannaDefinitions } from "../services/desktopServerClient";
import { requireService, type KannaSnapshot, type StoreContext } from "./state";
import { debugLog } from "../utils/debugLog";
import { applySnapshotSettingsToState } from "./snapshotSettings";
import { reconcileTaskUiSlots } from "./taskUiSlots";

interface OptimisticItemOverlay {
  key: string;
  apply: (snapshot: KannaSnapshot) => KannaSnapshot;
}

export interface QueryState<T> {
  data: Ref<T> | ComputedRef<T>;
  pending: Ref<boolean>;
  error: Ref<unknown>;
  refresh: () => Promise<void>;
}

export interface ReloadSnapshotOptions {
  /**
   * Re-resolve every repo's `.kanna` definitions as well as its rows. Repo
   * definitions live in the repo's committed tree, so the server resolves them
   * through Git — cheap to hold, expensive to ask for. Only a reload that can
   * actually have missed a definition change should pay for it.
   */
  refreshDefinitions?: boolean;
}

export interface QueriesApi {
  snapshot: QueryState<KannaSnapshot>;
  repos: QueryState<Repo[]>;
  items: QueryState<PipelineItem[]>;
  loadInitialData: () => Promise<void>;
  reloadSnapshot: (options?: ReloadSnapshotOptions) => Promise<void>;
  withOptimisticItemOverlay: <T>(input: {
    key: string;
    apply: (snapshot: KannaSnapshot) => KannaSnapshot;
    run: () => Promise<T>;
    reconcile?: () => Promise<void>;
  }) => Promise<T>;
}

function flattenSnapshotItems(snapshot: KannaSnapshot): PipelineItem[] {
  return snapshot.entries.flatMap((entry) => entry.items);
}

export function createQueriesApi(context: StoreContext): QueriesApi {
  const baseSnapshot = ref<KannaSnapshot>({
    entries: [],
    taskBlockers: [],
    blockerTaskStates: {},
    worktreePaths: {},
    settings: {},
  });
  const snapshotPending = ref(false);
  const snapshotError = ref<unknown>(null);
  const optimisticItems = ref<OptimisticItemOverlay[]>([]);
  const refreshRunId = ref(0);

  const mergedSnapshot = computed(() => {
    let result = baseSnapshot.value;
    for (const overlay of optimisticItems.value) {
      result = overlay.apply(result);
    }
    return result;
  });

  const repos = computed(() => mergedSnapshot.value.entries.map((entry) => entry.repo));
  const items = computed(() => flattenSnapshotItems(mergedSnapshot.value));

  function syncSnapshot(options: { authoritative?: boolean } = {}): void {
    context.state.repos.value = repos.value;
    context.state.items.value = items.value;
    context.state.taskBlockers.value = mergedSnapshot.value.taskBlockers;
    context.state.blockerTaskStates.value = { ...(mergedSnapshot.value.blockerTaskStates ?? {}) };
    context.state.worktreePaths.value = { ...mergedSnapshot.value.worktreePaths };
    context.state.snapshotSettings.value = { ...mergedSnapshot.value.settings };
    context.state.repoSidebarOrder.value = { ...(mergedSnapshot.value.repoSidebarOrder ?? {}) };
    context.state.taskUiSlots.value = reconcileTaskUiSlots(
      context.state.taskUiSlots.value,
      context.state.items.value,
      options,
    );
  }

  async function reconcileMissingRepoState(
    loadedRepos: readonly Repo[],
    previousLocalRepoIds: ReadonlySet<string>,
    previousItems: readonly PipelineItem[],
    previousSlots: readonly TaskUiSlot[],
  ): Promise<void> {
    const visibleRepoIds = new Set(loadedRepos.map((repo) => repo.id));
    const retiredLocalRepoIds = new Set(
      [...previousLocalRepoIds].filter((repoId) => !visibleRepoIds.has(repoId)),
    );
    if (retiredLocalRepoIds.size === 0) return;

    const retiredSlots = previousSlots.filter((slot) =>
      retiredLocalRepoIds.has(slot.draft.repo_id),
    );
    context.state.taskUiSlots.value = context.state.taskUiSlots.value.filter((slot) =>
      !retiredLocalRepoIds.has(slot.draft.repo_id),
    );
    for (const slot of retiredSlots) {
      context.state.pendingCreateVisibility.delete(slot.slot_id);
      if (slot.task_id) context.state.pendingCreateVisibility.delete(slot.task_id);
    }
    for (const item of previousItems) {
      if (retiredLocalRepoIds.has(item.repo_id)) {
        context.state.pendingCreateVisibility.delete(item.id);
      }
    }

    const rememberedSelections = Object.entries(context.state.lastSelectedItemByRepo.value);
    if (rememberedSelections.some(([repoId]) => retiredLocalRepoIds.has(repoId))) {
      context.state.lastSelectedItemByRepo.value = Object.fromEntries(
        rememberedSelections.filter(([repoId]) => !retiredLocalRepoIds.has(repoId)),
      );
    }

    const selectedRepoId = context.state.selectedRepoId.value;
    const selectedItemId = context.state.selectedItemId.value;
    const selectedRepoIsMissing = selectedRepoId !== null && retiredLocalRepoIds.has(selectedRepoId);
    const selectedItemWasLocal = selectedItemId !== null && (
      previousSlots.some((slot) =>
        (slot.slot_id === selectedItemId || slot.task_id === selectedItemId)
        && retiredLocalRepoIds.has(slot.draft.repo_id),
      )
      || previousItems.some((item) =>
        item.id === selectedItemId && retiredLocalRepoIds.has(item.repo_id),
      )
    );
    const selectedItemStillVisible = selectedItemId !== null && context.state.taskUiSlots.value.some(
      (slot) => slot.slot_id === selectedItemId || slot.task_id === selectedItemId,
    );
    const selectionNeedsReconciliation = selectedRepoIsMissing
      || (selectedRepoId === null && selectedItemWasLocal && !selectedItemStillVisible);
    if (!selectionNeedsReconciliation) return;

    if (context.services.reconcileSelection) {
      context.services.reconcileSelection();
    } else {
      context.state.selectedRepoId.value = loadedRepos[0]?.id ?? null;
      context.state.selectedItemId.value = null;
    }

    try {
      await context.services.persistSelection?.();
    } catch (error) {
      console.error("[store] failed to persist selection after selected repo disappeared:", error);
    }
  }

  /**
   * Keep every repo's stage order in the cache that `sortedItemsForCurrentRepo`
   * reads. A repo's stage order changes only when its committed `.kanna` config
   * does, so a task-driven reload just fills in repos the cache has never seen;
   * `force` re-reads them all, which is what a repo-scoped change wants.
   */
  async function refreshStageOrderCache(
    repos: Repo[],
    runId: number,
    force: boolean,
  ): Promise<void> {
    for (const repo of repos) {
      if (!force && context.state.stageOrderCache.has(repo.id)) continue;

      let manifest;
      try {
        manifest = await fetchDesktopRepoKannaDefinitions(repo.id);
      } catch (error) {
        if (runId !== refreshRunId.value) return;
        console.warn(`[store] failed to refresh definitions for repo ${repo.id}:`, error);
        continue;
      }
      if (runId !== refreshRunId.value) return;

      const cachedStageOrder = context.state.stageOrderCache.get(repo.id);
      if (!cachedStageOrder || cachedStageOrder.revision !== manifest.revision) {
        context.state.stageOrderCache.set(repo.id, {
          revision: manifest.revision,
          stageOrder: manifest.config.stage_order ?? null,
        });
      }
    }
  }

  async function reloadSnapshot(options: ReloadSnapshotOptions = {}): Promise<void> {
    const runId = ++refreshRunId.value;
    snapshotPending.value = true;
    snapshotError.value = null;
    try {
      const refreshStart = performance.now();

      const snapshot = await requireService(context.services.fetchSnapshot, "fetchSnapshot")();
      if (runId !== refreshRunId.value) return;
      const loadedRepos = snapshot.entries.map((entry) => entry.repo);
      const loadedItems = flattenSnapshotItems(snapshot);

      debugLog(`[perf:items] refresh start #${runId}: repos=${loadedRepos.length}`);

      const previousLocalRepoIds = new Set(context.state.repos.value.map((repo) => repo.id));
      const previousItems = [...context.state.items.value];
      const previousSlots = [...context.state.taskUiSlots.value];
      baseSnapshot.value = snapshot;
      applySnapshotSettingsToState(context.state, snapshot.settings);
      syncSnapshot({ authoritative: true });
      await reconcileMissingRepoState(
        loadedRepos,
        previousLocalRepoIds,
        previousItems,
        previousSlots,
      );
      if (runId !== refreshRunId.value) return;

      for (const item of loadedItems) {
        const pending = context.state.pendingCreateVisibility.get(item.id);
        if (!pending) continue;
        debugLog(
          `[perf:createItem] items refresh -> visible: ${(performance.now() - pending.bumpAt).toFixed(1)}ms (id=${item.id})`,
        );
        context.state.pendingCreateVisibility.delete(item.id);
      }

      await refreshStageOrderCache(loadedRepos, runId, options.refreshDefinitions === true);
      if (runId !== refreshRunId.value) return;

      debugLog(
        `[perf:items] refresh done #${runId}: ${(performance.now() - refreshStart).toFixed(1)}ms total, items=${loadedItems.length}`,
      );
    } catch (error) {
      if (runId !== refreshRunId.value) return;
      snapshotError.value = error;
      throw error;
    } finally {
      if (runId === refreshRunId.value) {
        snapshotPending.value = false;
      }
    }
  }

  async function loadInitialData(): Promise<void> {
    // Cold start has no cached definitions to reuse.
    await reloadSnapshot({ refreshDefinitions: true });
  }

  function addOverlay(overlay: OptimisticItemOverlay): void {
    optimisticItems.value = [...optimisticItems.value.filter((entry) => entry.key !== overlay.key), overlay];
    syncSnapshot();
  }

  function removeOverlay(key: string): void {
    optimisticItems.value = optimisticItems.value.filter((entry) => entry.key !== key);
    syncSnapshot();
  }

  async function withOptimisticItemOverlay<T>(input: {
    key: string;
    apply: (snapshot: KannaSnapshot) => KannaSnapshot;
    run: () => Promise<T>;
    reconcile?: () => Promise<void>;
  }): Promise<T> {
    addOverlay({ key: input.key, apply: input.apply });
    try {
      const result = await input.run();
      await (input.reconcile?.() ?? reloadSnapshot());
      return result;
    } finally {
      removeOverlay(input.key);
      syncSnapshot();
    }
  }

  return {
    snapshot: {
      data: mergedSnapshot,
      pending: snapshotPending,
      error: snapshotError,
      refresh: reloadSnapshot,
    },
    repos: {
      data: repos,
      pending: snapshotPending,
      error: snapshotError,
      refresh: reloadSnapshot,
    },
    items: {
      data: items,
      pending: snapshotPending,
      error: snapshotError,
      refresh: reloadSnapshot,
    },
    loadInitialData,
    reloadSnapshot,
    withOptimisticItemOverlay,
  };
}
