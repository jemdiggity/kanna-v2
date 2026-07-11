import { computed, type ComputedRef } from "vue";
import { watchDebounced } from "@vueuse/core";
import { DEFAULT_STAGE_ORDER } from "@kanna/core";
import type { PipelineItem, Repo } from "../types/kanna";
import { createNavigationHistory } from "../composables/useNavigationHistory";
import { beginTaskSwitch } from "../perf/taskSwitchPerf";
import { markDesktopTaskRead, postDesktopOperatorEvent, putDesktopSetting } from "../services/desktopServerClient";
import { sortSidebarItemsForRepo } from "../utils/sidebarOrdering";
import { requireService, type StoreContext } from "./state";
import type { InitializingTaskItem } from "./taskInitialization";

export interface SelectionApi {
  selectedRepo: ComputedRef<Repo | null>;
  selectedItemIdForPersistence: ComputedRef<string | null>;
  currentInitializingItem: ComputedRef<InitializingTaskItem | null>;
  currentItem: ComputedRef<PipelineItem | null>;
  sortedItemsForCurrentRepo: ComputedRef<PipelineItem[]>;
  sortedItemsAllRepos: ComputedRef<PipelineItem[]>;
  canGoBack: ComputedRef<boolean>;
  canGoForward: ComputedRef<boolean>;
  getStageOrder: (repoId: string) => readonly string[];
  persistSelection: () => Promise<void>;
  selectRepo: (repoId: string) => Promise<void>;
  selectItem: (itemId: string, options?: SelectItemOptions) => Promise<void>;
  selectReplacementAfterItemRemoval: (
    removedItem: Pick<PipelineItem, "id" | "repo_id">,
  ) => Promise<string | null>;
  reconcileSelection: () => void;
  restoreSelection: (itemId: string) => void;
  goBack: () => void;
  goForward: () => void;
  isItemHidden: (item: PipelineItem) => boolean;
}

export interface SelectItemOptions {
  previousItemId?: string | null;
}

export function createSelectionApi(context: StoreContext): SelectionApi {
  const nav = createNavigationHistory();

  function logSelection(source: string, from: string | null, to: string | null, details: Record<string, unknown> = {}) {
    console.debug(`[selection] ${source}`, {
      from,
      to,
      selectedRepoId: context.state.selectedRepoId.value,
      ...details,
    });
  }

  const selectedItemIdForPersistence = computed(() => {
    const selectedItemId = context.state.selectedItemId.value;
    const initializingItem = context.state.initializingTaskItems.value.find(
      (candidate) => candidate.id === selectedItemId,
    );
    if (initializingItem) return initializingItem.taskId;
    return selectedItemId?.startsWith("create:") ? null : selectedItemId;
  });

  async function persistWindowSelection(): Promise<void> {
    await context.services.windowWorkspace?.persistSelection({
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: selectedItemIdForPersistence.value,
    });
  }

  function emitTaskSelected(itemId: string) {
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    postDesktopOperatorEvent({
      eventType: "task_selected",
      pipelineItemId: itemId,
      repoId: item?.repo_id ?? null,
    }).catch((error) =>
      console.error("[store] operator event failed:", error),
    );
  }

  function getStageOrder(repoId: string): readonly string[] {
    const repoPath = context.state.repos.value.find((repo) => repo.id === repoId)?.path ?? "";
    return context.state.stageOrderCache.get(repoPath) ?? DEFAULT_STAGE_ORDER;
  }

  function isItemHidden(item: PipelineItem): boolean {
    return item.closed_at != null;
  }

  const selectedRepo = computed(() =>
    context.state.repos.value.find((repo) => repo.id === context.state.selectedRepoId.value) ?? null,
  );

  function sortItemsForRepo(repoId: string): PipelineItem[] {
    return sortSidebarItemsForRepo({
      repoId,
      items: context.state.items.value,
      blockers: context.state.taskBlockers.value,
      getStageOrder,
    });
  }

  const sortedItemsForCurrentRepo = computed(() =>
    sortItemsForRepo(context.state.selectedRepoId.value ?? ""),
  );

  const sortedItemsAllRepos = computed(() =>
    context.state.repos.value.flatMap((repo) => sortItemsForRepo(repo.id)),
  );

  const currentInitializingItem = computed(() =>
    context.state.initializingTaskItems.value.find(
      (candidate) => candidate.id === context.state.selectedItemId.value
        && candidate.repo_id === context.state.selectedRepoId.value,
    ) ?? null,
  );

  const currentItem = computed(() => {
    if (currentInitializingItem.value) return null;

    if (context.state.selectedItemId.value) {
      const item = context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value);
      if (item && !isItemHidden(item) && item.repo_id === context.state.selectedRepoId.value) return item;
    }

    return sortedItemsForCurrentRepo.value[0] ?? null;
  });

  watchDebounced(
    context.state.selectedItemId,
    async (itemId) => {
      if (!itemId) return;
      const selectionTime = Date.now() - 1000;
      const item = context.state.items.value.find((candidate) => candidate.id === itemId);
      if (!item || item.activity !== "unread") return;
      if (item.activity_changed_at && new Date(item.activity_changed_at).getTime() > selectionTime) return;
      const response = await markDesktopTaskRead(itemId);
      if (response.activity == null) return;
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await context.services.windowWorkspace?.invalidateSharedData("taskActivity");
    },
    { debounce: 1000 },
  );

  async function selectRepo(repoId: string) {
    const previousItemId = context.state.selectedItemId.value;
    context.state.selectedRepoId.value = repoId;
    context.state.selectedItemId.value = context.state.lastSelectedItemByRepo.value[repoId] ?? null;
    logSelection("selectRepo", previousItemId, context.state.selectedItemId.value, { repoId });
    await putDesktopSetting("selected_repo_id", repoId);
    await persistWindowSelection();
  }

  async function selectItem(itemId: string, options: SelectItemOptions = {}) {
    const previousItemId = options.previousItemId !== undefined
      ? options.previousItemId
      : context.state.selectedItemId.value;
    const initializingItem = context.state.initializingTaskItems.value.find(
      (candidate) => candidate.id === itemId,
    );
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    if (!initializingItem && !item) {
      logSelection("selectItem:ignoredStale", previousItemId, itemId);
      return;
    }

    nav.select(itemId, previousItemId);
    context.state.selectedItemId.value = itemId;
    if (initializingItem) {
      context.state.selectedRepoId.value = initializingItem.repo_id;
      context.state.lastSelectedItemByRepo.value[initializingItem.repo_id] = itemId;
      logSelection("selectInitializingItem", previousItemId, itemId, {
        taskId: initializingItem.taskId,
      });
      await persistWindowSelection();
      return;
    }

    if (item) {
      context.state.selectedRepoId.value = item.repo_id;
    }
    logSelection("selectItem", previousItemId, itemId, {
      itemStage: item?.stage,
      itemBranch: item?.branch,
    });
    if (item?.agent_type === "pty") {
      beginTaskSwitch(itemId);
    }
    if (item) {
      context.state.lastSelectedItemByRepo.value[item.repo_id] = itemId;
    }
    await persistWindowSelection();
    emitTaskSelected(itemId);
  }

  function findReplacementAfterItemRemoval(
    removedItem: Pick<PipelineItem, "id" | "repo_id">,
  ): PipelineItem | null {
    const sameRepoSorted = sortItemsForRepo(removedItem.repo_id);
    const sameRepoIndex = sameRepoSorted.findIndex((item) => item.id === removedItem.id);
    const sameRepoRemaining = sameRepoSorted.filter((item) => item.id !== removedItem.id);
    if (sameRepoRemaining.length > 0) {
      const nextIndex = sameRepoIndex >= 0
        ? Math.min(sameRepoIndex, sameRepoRemaining.length - 1)
        : 0;
      return sameRepoRemaining[nextIndex] ?? null;
    }

    const allSorted = context.state.repos.value.flatMap((repo) => sortItemsForRepo(repo.id));
    const globalIndex = allSorted.findIndex((item) => item.id === removedItem.id);
    const globalRemaining = allSorted.filter((item) => item.id !== removedItem.id);
    if (globalRemaining.length === 0) return null;

    const nextIndex = globalIndex >= 0
      ? Math.min(globalIndex, globalRemaining.length - 1)
      : 0;
    return globalRemaining[nextIndex] ?? null;
  }

  async function selectReplacementAfterItemRemoval(
    removedItem: Pick<PipelineItem, "id" | "repo_id">,
  ): Promise<string | null> {
    const replacement = findReplacementAfterItemRemoval(removedItem);
    if (!replacement) {
      logSelection("selectReplacementAfterItemRemoval:none", context.state.selectedItemId.value, null, {
        removedItemId: removedItem.id,
      });
      context.state.selectedItemId.value = null;
      await persistWindowSelection();
      return null;
    }

    if (context.state.selectedRepoId.value !== replacement.repo_id) {
      context.state.selectedRepoId.value = replacement.repo_id;
    }

    if (context.state.selectedItemId.value !== replacement.id) {
      nav.select(replacement.id, context.state.selectedItemId.value);
    }
    const previousItemId = context.state.selectedItemId.value;
    context.state.selectedItemId.value = replacement.id;
    context.state.lastSelectedItemByRepo.value[replacement.repo_id] = replacement.id;
    logSelection("selectReplacementAfterItemRemoval", previousItemId, replacement.id, {
      removedItemId: removedItem.id,
      replacementStage: replacement.stage,
      replacementBranch: replacement.branch,
    });
    if (replacement.agent_type === "pty") {
      beginTaskSwitch(replacement.id);
    }
    await persistWindowSelection();
    emitTaskSelected(replacement.id);
    return replacement.id;
  }

  function restoreSelection(itemId: string) {
    const previousItemId = context.state.selectedItemId.value;
    context.state.selectedItemId.value = itemId;
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    if (item) {
      context.state.selectedRepoId.value = item.repo_id;
    }
    logSelection("restoreSelection", previousItemId, itemId, {
      itemStage: item?.stage,
      itemBranch: item?.branch,
    });
    if (item) {
      context.state.lastSelectedItemByRepo.value[item.repo_id] = itemId;
    }
  }

  function reconcileSelection() {
    const selectedRepoExists = context.state.selectedRepoId.value
      && context.state.repos.value.some((repo) => repo.id === context.state.selectedRepoId.value);
    if (!selectedRepoExists) {
      context.state.selectedRepoId.value = context.state.repos.value[0]?.id ?? null;
    }

    const selectedItem = context.state.selectedItemId.value
      ? context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value)
      : null;
    const selectedInitializingItem = context.state.selectedItemId.value
      ? context.state.initializingTaskItems.value.find((candidate) =>
        candidate.id === context.state.selectedItemId.value
        && candidate.repo_id === context.state.selectedRepoId.value)
      : null;
    if (selectedInitializingItem) {
      return;
    }
    const selectedItemValid = selectedItem
      && !isItemHidden(selectedItem)
      && selectedItem.repo_id === context.state.selectedRepoId.value;
    if (selectedItemValid) {
      return;
    }

    const repoId = context.state.selectedRepoId.value;
    if (!repoId) {
      context.state.selectedItemId.value = null;
      return;
    }

    const rememberedItemId = context.state.lastSelectedItemByRepo.value[repoId];
    const rememberedItem = rememberedItemId
      ? context.state.items.value.find((candidate) =>
        candidate.id === rememberedItemId
        && candidate.repo_id === repoId
        && !isItemHidden(candidate))
      : null;
    if (rememberedItem) {
      context.state.selectedItemId.value = rememberedItem.id;
      return;
    }

    context.state.selectedItemId.value = sortItemsForRepo(repoId)[0]?.id ?? null;
  }

  function goBack() {
    if (!context.state.selectedItemId.value) return;
    const validIds = new Set(
      requireService(context.services.sortedItemsAllRepos, "sortedItemsAllRepos").value.map((item) => item.id),
    );
    const taskId = nav.goBack(context.state.selectedItemId.value, validIds);
    if (!taskId) return;

    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (item) {
      if (item.repo_id !== context.state.selectedRepoId.value) {
        context.state.selectedRepoId.value = item.repo_id;
      }
      context.state.lastSelectedItemByRepo.value[item.repo_id] = taskId;
    }

    context.state.selectedItemId.value = taskId;
    void persistWindowSelection();
    emitTaskSelected(taskId);
  }

  function goForward() {
    if (!context.state.selectedItemId.value) return;
    const validIds = new Set(
      requireService(context.services.sortedItemsAllRepos, "sortedItemsAllRepos").value.map((item) => item.id),
    );
    const taskId = nav.goForward(context.state.selectedItemId.value, validIds);
    if (!taskId) return;

    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (item) {
      if (item.repo_id !== context.state.selectedRepoId.value) {
        context.state.selectedRepoId.value = item.repo_id;
      }
      context.state.lastSelectedItemByRepo.value[item.repo_id] = taskId;
    }

    context.state.selectedItemId.value = taskId;
    void persistWindowSelection();
    emitTaskSelected(taskId);
  }

  return {
    selectedRepo,
    selectedItemIdForPersistence,
    currentInitializingItem,
    currentItem,
    sortedItemsForCurrentRepo,
    sortedItemsAllRepos,
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
    getStageOrder,
    persistSelection: persistWindowSelection,
    selectRepo,
    selectItem,
    selectReplacementAfterItemRemoval,
    reconcileSelection,
    restoreSelection,
    goBack,
    goForward,
    isItemHidden,
  };
}
