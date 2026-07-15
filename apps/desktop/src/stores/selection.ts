import { computed, type ComputedRef } from "vue";
import { watchDebounced } from "@vueuse/core";
import { DEFAULT_STAGE_ORDER } from "@kanna/core";
import type { PipelineItem, Repo } from "../types/kanna";
import { createNavigationHistory } from "../composables/useNavigationHistory";
import { beginTaskSwitch } from "../perf/taskSwitchPerf";
import { markDesktopTaskRead, postDesktopOperatorEvent, putDesktopSetting } from "../services/desktopServerClient";
import { sortSidebarItemsForRepo } from "../utils/sidebarOrdering";
import { requireService, type StoreContext } from "./state";
import type { TaskUiSlot } from "../types/taskUi";
import { taskUiSlotForSelection } from "./taskUiSlots";

export interface SelectionApi {
  selectedRepo: ComputedRef<Repo | null>;
  currentItem: ComputedRef<PipelineItem | null>;
  currentTaskSlot: ComputedRef<TaskUiSlot | null>;
  selectedTaskId: ComputedRef<string | null>;
  sortedItemsForCurrentRepo: ComputedRef<PipelineItem[]>;
  sortedItemsAllRepos: ComputedRef<PipelineItem[]>;
  canGoBack: ComputedRef<boolean>;
  canGoForward: ComputedRef<boolean>;
  getStageOrder: (repoId: string) => readonly string[];
  selectRepo: (repoId: string) => Promise<void>;
  selectItem: (itemId: string, options?: SelectItemOptions) => Promise<void>;
  persistSelection: () => Promise<void>;
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
  let selectionPersistenceTail: Promise<void> = Promise.resolve();

  function logSelection(source: string, from: string | null, to: string | null, details: Record<string, unknown> = {}) {
    console.debug(`[selection] ${source}`, {
      from,
      to,
      selectedRepoId: context.state.selectedRepoId.value,
      ...details,
    });
  }

  const currentTaskSlot = computed(() =>
    taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      context.state.selectedItemId.value,
    ),
  );

  const selectedTaskId = computed(() => currentTaskSlot.value?.task_id ?? null);

  function persistSelection(): Promise<void> {
    const selection = {
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: selectedTaskId.value,
    };
    const write = selectionPersistenceTail.then(() =>
      context.services.windowWorkspace?.persistSelection(selection),
    );
    selectionPersistenceTail = write.catch(() => undefined);
    return write;
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
    return context.state.stageOrderCache.get(repoId)?.stageOrder ?? DEFAULT_STAGE_ORDER;
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

  const currentItem = computed(() => {
    const slot = currentTaskSlot.value;
    if (slot) {
      if (slot.draft.repo_id !== context.state.selectedRepoId.value) return null;
      return slot.task && !isItemHidden(slot.task) ? slot.task : null;
    }

    return sortedItemsForCurrentRepo.value[0] ?? null;
  });

  watchDebounced(
    selectedTaskId,
    async (taskId) => {
      if (!taskId) return;
      const selectionTime = Date.now() - 1000;
      const item = context.state.items.value.find((candidate) => candidate.id === taskId);
      if (!item || item.activity !== "unread") return;
      if (item.activity_changed_at && new Date(item.activity_changed_at).getTime() > selectionTime) return;
      const response = await markDesktopTaskRead(taskId);
      if (response.activity == null) return;
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await context.services.windowWorkspace?.invalidateSharedData("taskActivity");
    },
    { debounce: 1000 },
  );

  async function selectRepo(repoId: string) {
    const previousItemId = context.state.selectedItemId.value;
    context.state.selectedRepoId.value = repoId;
    context.state.selectedItemId.value = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      context.state.lastSelectedItemByRepo.value[repoId],
    )?.slot_id ?? null;
    logSelection("selectRepo", previousItemId, context.state.selectedItemId.value, { repoId });
    await putDesktopSetting("selected_repo_id", repoId);
    await persistSelection();
  }

  async function selectItem(itemId: string, options: SelectItemOptions = {}) {
    const slot = taskUiSlotForSelection(context.state.taskUiSlots.value, itemId);
    if (!slot) return;

    const previousSelectionId = options.previousItemId !== undefined
      ? options.previousItemId
      : context.state.selectedItemId.value;
    const previousSlotId = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      previousSelectionId,
    )?.slot_id ?? null;
    nav.select(slot.slot_id, previousSlotId);
    context.state.selectedItemId.value = slot.slot_id;
    context.state.selectedRepoId.value = slot.draft.repo_id;
    logSelection("selectItem", previousSlotId, slot.slot_id, {
      itemStage: slot.task?.stage ?? slot.draft.stage,
      itemBranch: slot.task?.branch,
    });
    if (slot.task_id && slot.task?.agent_type === "pty") {
      beginTaskSwitch(slot.task_id);
    }
    context.state.lastSelectedItemByRepo.value[slot.draft.repo_id] = slot.slot_id;
    await persistSelection();
    if (slot.task_id) {
      emitTaskSelected(slot.task_id);
    }
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
    const replacementSlot = replacement
      ? taskUiSlotForSelection(context.state.taskUiSlots.value, replacement.id)
      : null;
    if (!replacement || !replacementSlot) {
      logSelection("selectReplacementAfterItemRemoval:none", context.state.selectedItemId.value, null, {
        removedItemId: removedItem.id,
      });
      context.state.selectedItemId.value = null;
      await persistSelection();
      return null;
    }

    if (context.state.selectedRepoId.value !== replacementSlot.draft.repo_id) {
      context.state.selectedRepoId.value = replacementSlot.draft.repo_id;
    }

    if (context.state.selectedItemId.value !== replacementSlot.slot_id) {
      const previousSlotId = taskUiSlotForSelection(
        context.state.taskUiSlots.value,
        context.state.selectedItemId.value,
      )?.slot_id ?? null;
      nav.select(replacementSlot.slot_id, previousSlotId);
    }
    const previousItemId = context.state.selectedItemId.value;
    context.state.selectedItemId.value = replacementSlot.slot_id;
    context.state.lastSelectedItemByRepo.value[replacementSlot.draft.repo_id] = replacementSlot.slot_id;
    logSelection("selectReplacementAfterItemRemoval", previousItemId, replacementSlot.slot_id, {
      removedItemId: removedItem.id,
      replacementStage: replacement.stage,
      replacementBranch: replacement.branch,
    });
    if (replacement.agent_type === "pty") {
      beginTaskSwitch(replacement.id);
    }
    await persistSelection();
    if (replacementSlot.task_id) {
      emitTaskSelected(replacementSlot.task_id);
    }
    return replacementSlot.slot_id;
  }

  function restoreSelection(itemId: string) {
    const slot = taskUiSlotForSelection(context.state.taskUiSlots.value, itemId);
    if (!slot) return;

    const previousItemId = context.state.selectedItemId.value;
    context.state.selectedItemId.value = slot.slot_id;
    context.state.selectedRepoId.value = slot.draft.repo_id;
    logSelection("restoreSelection", previousItemId, slot.slot_id, {
      itemStage: slot.task?.stage ?? slot.draft.stage,
      itemBranch: slot.task?.branch,
    });
    context.state.lastSelectedItemByRepo.value[slot.draft.repo_id] = slot.slot_id;
  }

  function reconcileSelection() {
    const selectedRepoExists = context.state.selectedRepoId.value
      && context.state.repos.value.some((repo) => repo.id === context.state.selectedRepoId.value);
    if (!selectedRepoExists) {
      context.state.selectedRepoId.value = context.state.repos.value[0]?.id ?? null;
    }

    const selectedSlot = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      context.state.selectedItemId.value,
    );
    const selectedSlotValid = selectedSlot
      && selectedSlot.draft.repo_id === context.state.selectedRepoId.value
      && (selectedSlot.state === "creating" || !isItemHidden(selectedSlot.task));
    if (selectedSlotValid) {
      context.state.selectedItemId.value = selectedSlot.slot_id;
      return;
    }

    const repoId = context.state.selectedRepoId.value;
    if (!repoId) {
      context.state.selectedItemId.value = null;
      return;
    }

    const rememberedItemId = context.state.lastSelectedItemByRepo.value[repoId];
    const rememberedSlot = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      rememberedItemId,
    );
    const rememberedSlotValid = rememberedSlot
      && rememberedSlot.draft.repo_id === repoId
      && (rememberedSlot.state === "creating" || !isItemHidden(rememberedSlot.task));
    if (rememberedSlotValid) {
      context.state.selectedItemId.value = rememberedSlot.slot_id;
      return;
    }

    const fallbackTaskId = sortItemsForRepo(repoId)[0]?.id;
    context.state.selectedItemId.value = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      fallbackTaskId,
    )?.slot_id ?? null;
  }

  function visibleTaskSlotIds(): Set<string> {
    const availableRepoIds = new Set(
      context.state.repos.value
        .filter((repo) => !repo.hidden)
        .map((repo) => repo.id),
    );
    return new Set(
      context.state.taskUiSlots.value
        .filter((slot) =>
          availableRepoIds.has(slot.draft.repo_id)
          && (slot.state === "creating" || !isItemHidden(slot.task)))
        .map((slot) => slot.slot_id),
    );
  }

  function goBack() {
    const currentSlotId = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      context.state.selectedItemId.value,
    )?.slot_id ?? context.state.selectedItemId.value;
    if (!currentSlotId) return;
    const slotId = nav.goBack(currentSlotId, visibleTaskSlotIds());
    const slot = taskUiSlotForSelection(context.state.taskUiSlots.value, slotId);
    if (!slot) return;

    if (slot.draft.repo_id !== context.state.selectedRepoId.value) {
      context.state.selectedRepoId.value = slot.draft.repo_id;
    }
    context.state.lastSelectedItemByRepo.value[slot.draft.repo_id] = slot.slot_id;

    context.state.selectedItemId.value = slot.slot_id;
    void persistSelection();
    if (slot.task_id) {
      emitTaskSelected(slot.task_id);
    }
  }

  function goForward() {
    const currentSlotId = taskUiSlotForSelection(
      context.state.taskUiSlots.value,
      context.state.selectedItemId.value,
    )?.slot_id ?? context.state.selectedItemId.value;
    if (!currentSlotId) return;
    const slotId = nav.goForward(currentSlotId, visibleTaskSlotIds());
    const slot = taskUiSlotForSelection(context.state.taskUiSlots.value, slotId);
    if (!slot) return;

    if (slot.draft.repo_id !== context.state.selectedRepoId.value) {
      context.state.selectedRepoId.value = slot.draft.repo_id;
    }
    context.state.lastSelectedItemByRepo.value[slot.draft.repo_id] = slot.slot_id;

    context.state.selectedItemId.value = slot.slot_id;
    void persistSelection();
    if (slot.task_id) {
      emitTaskSelected(slot.task_id);
    }
  }

  return {
    selectedRepo,
    currentItem,
    currentTaskSlot,
    selectedTaskId,
    sortedItemsForCurrentRepo,
    sortedItemsAllRepos,
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
    getStageOrder,
    selectRepo,
    selectItem,
    persistSelection,
    selectReplacementAfterItemRemoval,
    reconcileSelection,
    restoreSelection,
    goBack,
    goForward,
    isItemHidden,
  };
}
