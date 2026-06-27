import { computed, type ComputedRef } from "vue";
import { watchDebounced } from "@vueuse/core";
import { DEFAULT_STAGE_ORDER } from "@kanna/core";
import { insertOperatorEvent, setSetting, updatePipelineItemActivity, type PipelineItem, type Repo } from "@kanna/db";
import { createNavigationHistory } from "../composables/useNavigationHistory";
import { beginTaskSwitch } from "../perf/taskSwitchPerf";
import { hasTag, requireService, type StoreContext } from "./state";

export interface SelectionApi {
  selectedRepo: ComputedRef<Repo | null>;
  currentItem: ComputedRef<PipelineItem | null>;
  sortedItemsForCurrentRepo: ComputedRef<PipelineItem[]>;
  sortedItemsAllRepos: ComputedRef<PipelineItem[]>;
  canGoBack: ComputedRef<boolean>;
  canGoForward: ComputedRef<boolean>;
  getStageOrder: (repoId: string) => readonly string[];
  selectRepo: (repoId: string) => Promise<void>;
  selectItem: (itemId: string, options?: SelectItemOptions) => Promise<void>;
  selectReplacementAfterItemRemoval: (removedItem: PipelineItem) => Promise<string | null>;
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

  async function persistWindowSelection(): Promise<void> {
    await context.services.windowWorkspace?.persistSelection({
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: context.state.selectedItemId.value,
    });
  }

  function emitTaskSelected(itemId: string) {
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    insertOperatorEvent(context.requireDb(), "task_selected", itemId, item?.repo_id ?? null).catch((error) =>
      console.error("[store] operator event failed:", error),
    );
  }

  function getStageOrder(repoId: string): readonly string[] {
    const repoPath = context.state.repos.value.find((repo) => repo.id === repoId)?.path ?? "";
    return context.state.stageOrderCache.get(repoPath) ?? DEFAULT_STAGE_ORDER;
  }

  function isItemHidden(item: PipelineItem): boolean {
    return item.stage === "done" || item.closed_at != null;
  }

  const selectedRepo = computed(() =>
    context.state.repos.value.find((repo) => repo.id === context.state.selectedRepoId.value) ?? null,
  );

  function sortItemsForRepo(repoId: string): PipelineItem[] {
    const repoItems = context.state.items.value.filter(
      (item) => item.repo_id === repoId && !isItemHidden(item),
    );
    const pinned = repoItems
      .filter((item) => item.pinned)
      .sort((left, right) => (left.pin_order ?? 0) - (right.pin_order ?? 0));
    const sortByCreatedAt = (entries: PipelineItem[]) =>
      entries.sort((left, right) => right.created_at.localeCompare(left.created_at));

    const blocked = sortByCreatedAt(repoItems.filter((item) => hasTag(item, "blocked") && !item.pinned));
    const blockedIds = new Set(blocked.map((item) => item.id));
    const stageItems = repoItems.filter((item) => !item.pinned && !blockedIds.has(item.id));
    const order = getStageOrder(repoId);

    const stageOrder = (item: PipelineItem): number => {
      const idx = order.indexOf(item.stage);
      return idx === -1 ? order.length : idx;
    };

    const sortedStageItems = stageItems.sort((left, right) => {
      const orderLeft = stageOrder(left);
      const orderRight = stageOrder(right);
      if (orderLeft !== orderRight) return orderLeft - orderRight;
      if (orderLeft === order.length && left.stage !== right.stage) {
        return left.stage.localeCompare(right.stage);
      }
      return right.created_at.localeCompare(left.created_at);
    });

    return nestChildren([...pinned, ...sortedStageItems, ...blocked]);
  }

  /**
   * Reorder a flat task list so every subtask immediately follows its parent, matching the
   * indented sidebar layout. Keeps task navigation (next/prev, close-replacement) in sync with
   * what the user sees. Only nests under parents that are themselves present in the list.
   */
  function nestChildren(ordered: PipelineItem[]): PipelineItem[] {
    const present = new Set(ordered.map((item) => item.id));
    const childrenByParent = new Map<string, PipelineItem[]>();
    for (const item of ordered) {
      const parentId = item.parent_task_id;
      if (parentId != null && parentId !== item.id && present.has(parentId)) {
        const siblings = childrenByParent.get(parentId) ?? [];
        siblings.push(item);
        childrenByParent.set(parentId, siblings);
      }
    }
    if (childrenByParent.size === 0) return ordered;
    for (const siblings of childrenByParent.values()) {
      siblings.sort((left, right) => left.created_at.localeCompare(right.created_at));
    }
    const childIds = new Set(
      [...childrenByParent.values()].flat().map((item) => item.id),
    );

    const out: PipelineItem[] = [];
    const seen = new Set<string>();
    const visit = (item: PipelineItem) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      out.push(item);
      for (const child of childrenByParent.get(item.id) ?? []) visit(child);
    };
    for (const item of ordered) {
      if (childIds.has(item.id)) continue;
      visit(item);
    }
    for (const item of ordered) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }

  const sortedItemsForCurrentRepo = computed(() =>
    sortItemsForRepo(context.state.selectedRepoId.value ?? ""),
  );

  const sortedItemsAllRepos = computed(() =>
    context.state.repos.value.flatMap((repo) => sortItemsForRepo(repo.id)),
  );

  const currentItem = computed(() => {
    if (context.state.selectedItemId.value) {
      const item = context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value);
      if (item && !isItemHidden(item) && item.repo_id === context.state.selectedRepoId.value) return item;
    }

    return sortedItemsForCurrentRepo.value.find(
      (item) => !context.state.pendingSetupIds.value.includes(item.id),
    ) ?? null;
  });

  watchDebounced(
    context.state.selectedItemId,
    async (itemId) => {
      if (!itemId) return;
      const selectionTime = Date.now() - 1000;
      const item = context.state.items.value.find((candidate) => candidate.id === itemId);
      if (!item || item.activity !== "unread") return;
      if (item.activity_changed_at && new Date(item.activity_changed_at).getTime() > selectionTime) return;
      await updatePipelineItemActivity(context.requireDb(), itemId, "idle");
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
    await setSetting(context.requireDb(), "selected_repo_id", repoId);
    await persistWindowSelection();
  }

  async function selectItem(itemId: string, options: SelectItemOptions = {}) {
    const previousItemId = options.previousItemId !== undefined
      ? options.previousItemId
      : context.state.selectedItemId.value;
    nav.select(itemId, previousItemId);
    context.state.selectedItemId.value = itemId;
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
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

  function findReplacementAfterItemRemoval(removedItem: PipelineItem): PipelineItem | null {
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

  async function selectReplacementAfterItemRemoval(removedItem: PipelineItem): Promise<string | null> {
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
    currentItem,
    sortedItemsForCurrentRepo,
    sortedItemsAllRepos,
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
    getStageOrder,
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
