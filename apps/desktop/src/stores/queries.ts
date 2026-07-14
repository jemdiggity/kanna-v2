import { computed, ref, type ComputedRef, type Ref } from "vue";
import { type PipelineItem, type Repo } from "../types/kanna";
import { readRepoConfig, requireService, type KannaSnapshot, type StoreContext } from "./state";
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

export interface QueriesApi {
  snapshot: QueryState<KannaSnapshot>;
  repos: QueryState<Repo[]>;
  items: QueryState<PipelineItem[]>;
  loadInitialData: () => Promise<void>;
  reloadSnapshot: () => Promise<void>;
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
  const baseSnapshot = ref<KannaSnapshot>({ entries: [], taskBlockers: [], worktreePaths: {}, settings: {} });
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
    context.state.worktreePaths.value = { ...mergedSnapshot.value.worktreePaths };
    context.state.snapshotSettings.value = { ...mergedSnapshot.value.settings };
    context.state.taskUiSlots.value = reconcileTaskUiSlots(
      context.state.taskUiSlots.value,
      context.state.items.value,
      options,
    );
  }

  async function reloadSnapshot(): Promise<void> {
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

      for (const { repo } of snapshot.entries) {
        const repoStart = performance.now();
        debugLog(`[perf:items] refresh repo #${runId} ${repo.id}: ${(performance.now() - repoStart).toFixed(1)}ms`);

        if (!context.state.stageOrderCache.has(repo.path)) {
          try {
            const config = await readRepoConfig(repo.path);
            if (runId !== refreshRunId.value) return;
            if (config.stage_order) {
              context.state.stageOrderCache.set(repo.path, config.stage_order);
            }
          } catch (error) {
            if (runId !== refreshRunId.value) return;
            console.debug("[store] no repo config while refreshing stage order cache:", error);
          }
        }
      }

      debugLog(
        `[perf:items] refresh done #${runId}: ${(performance.now() - refreshStart).toFixed(1)}ms total, items=${loadedItems.length}`,
      );

      if (runId !== refreshRunId.value) return;
      baseSnapshot.value = snapshot;
      applySnapshotSettingsToState(context.state, snapshot.settings);
      syncSnapshot({ authoritative: true });

      for (const item of loadedItems) {
        const pending = context.state.pendingCreateVisibility.get(item.id);
        if (!pending) continue;
        debugLog(
          `[perf:createItem] items refresh -> visible: ${(performance.now() - pending.bumpAt).toFixed(1)}ms (id=${item.id})`,
        );
        context.state.pendingCreateVisibility.delete(item.id);
      }
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
    await reloadSnapshot();
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
