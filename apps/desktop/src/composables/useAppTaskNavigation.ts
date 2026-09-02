import { computed, watch, type ComputedRef, type Ref } from "vue";
import { computedAsync } from "@vueuse/core";
import type {
  BlockerTaskStates,
  PipelineItem,
  TaskBlocker,
} from "../types/kanna";
import {
  fetchDesktopRepoCommands,
  runDesktopRepoCommand,
  type DesktopRepoCommandCatalog,
} from "../services/desktopServerClient";

import Sidebar from "../components/Sidebar.vue";
import { isBlockerResolved } from "../utils/blockerResolution";
import { selectTaskByActivity } from "../utils/selectTaskByActivity";
import {
  replacementSidebarTaskItemsAfterRemoval,
  sortSidebarTaskItemsForRepo,
} from "../utils/sidebarOrdering";
import { isTaskTearingDown } from "../stores/taskStages";
import type { SidebarTaskItem } from "../types/taskUi";
import type { WorkspaceTask } from "../workspace/types";
import type { useKannaStore } from "../stores/kanna";
import type { useToast } from "./useToast";
import type { WindowWorkspaceController } from "../windowWorkspace";
import type { ActionName } from "./useKeyboardShortcuts";

interface SidebarRepoProjection {
  id: string;
  path: string;
  name: string;
  remote_url: string | null;
  remote_url_hash: string | null;
  default_branch: string;
  hidden: number;
  sort_order: number;
  created_at: string;
  last_opened_at: string;
}

interface DynamicCommand {
  id: string;
  label: string;
  description?: string;
  execute: () => void;
}

interface PaletteExtraCommand {
  action: ActionName;
  label: string;
  group: string;
  shortcut: string;
}

type ActivityShortcutScope = "currentRepo" | "allRepos";

function canonicalSidebarTaskItem(item: PipelineItem, fallbackRepoId?: string): SidebarTaskItem {
  const { id, ...presentation } = item;
  return {
    ...presentation,
    repo_id: item.repo_id ?? fallbackRepoId ?? "",
    closed_at: item.closed_at ?? null,
    pinned: item.pinned ?? 0,
    pin_order: item.pin_order ?? null,
    stage: item.stage ?? "in progress",
    pr_url: item.pr_url ?? null,
    parent_task_id: item.parent_task_id ?? null,
    created_at: item.created_at ?? "",
    slot_id: id,
    task_id: id,
    state: "ready",
  };
}

function canonicalSidebarTaskItems(
  items: readonly PipelineItem[],
  fallbackRepoId?: string,
): SidebarTaskItem[] {
  return items.map((item) => canonicalSidebarTaskItem(item, fallbackRepoId));
}

interface UseAppTaskNavigationOptions {
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  t: (key: string) => string;
  windowWorkspace: WindowWorkspaceController;
  sidebarRef: Ref<InstanceType<typeof Sidebar> | null>;
  sidebarRepos: ComputedRef<SidebarRepoProjection[]>;
  sidebarItems: ComputedRef<SidebarTaskItem[]>;
  taskBlockers?: ComputedRef<readonly TaskBlocker[]>;
  blockerTaskStates?: ComputedRef<Readonly<BlockerTaskStates>>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  selectedCloudRepoId: Ref<string | null>;
  selectedCloudItemId: Ref<string | null>;
  showBlockerSelect: Ref<boolean>;
  blockerSelectMode: Ref<"block" | "edit">;
  repoCommandCatalog: Ref<DesktopRepoCommandCatalog | null>;
  openPeerPicker: (taskId: string) => void;
  openPairPeerPicker: () => void;
  pullSelectedWorkspaceTask?: (task: WorkspaceTask) => void | Promise<void>;
}

function isActivityShortcutCandidate(item: { stage?: string; teardown_started_at?: string | null }): boolean {
  if (typeof item.stage !== "string") return true;
  return !isTaskTearingDown({ stage: item.stage, teardown_started_at: item.teardown_started_at });
}

function isUnpinnedActivityShortcutCandidate(item: { pinned?: number | boolean | null }): boolean {
  return !Boolean(item.pinned);
}

export function useAppTaskNavigation({
  store,
  toast,
  t,
  windowWorkspace,
  sidebarRef,
  sidebarRepos,
  sidebarItems,
  taskBlockers,
  blockerTaskStates,
  workspaceTasksByItemId,
  selectedCloudRepoId,
  selectedCloudItemId,
  showBlockerSelect,
  blockerSelectMode,
  repoCommandCatalog,
  openPeerPicker,
  openPairPeerPicker,
  pullSelectedWorkspaceTask,
}: UseAppTaskNavigationOptions) {
  const effectiveTaskBlockers = taskBlockers
    ?? computed(() => store.taskBlockers ?? []);
  const effectiveBlockerTaskStates = blockerTaskStates
    ?? computed(() => store.blockerTaskStates ?? {});
  let selectionIntentVersion = 0;

  function beginSelectionIntent(): number {
    store.recordSelectionIntent();
    selectionIntentVersion += 1;
    return selectionIntentVersion;
  }

  function visibleSidebarItemsForRepo(
    repoId: string,
    options: { currentRepoScope?: boolean } = {},
  ): SidebarTaskItem[] {
    const workspaceItems = sidebarItems.value.filter((item) => item.repo_id === repoId);
    const searchQuery = sidebarRef.value?.searchQuery ?? "";
    const sortOptions = {
      repoId,
      blockers: effectiveTaskBlockers.value,
      blockerTaskStates: effectiveBlockerTaskStates.value,
      getStageOrder: store.getStageOrder,
      searchQuery,
    };
    if (workspaceItems.length === 0 && !repoId.startsWith("cloud:")) {
      const fallbackItems = options.currentRepoScope && repoId === store.selectedRepoId
        ? store.sortedItemsForCurrentRepo
        : store.sortedItemsAllRepos.filter((item) => item.repo_id === repoId);
      if (fallbackItems.length === 0) return [];
      return sortSidebarTaskItemsForRepo({
        ...sortOptions,
        items: canonicalSidebarTaskItems(fallbackItems, repoId),
      });
    }
    return sortSidebarTaskItemsForRepo({ ...sortOptions, items: workspaceItems });
  }

  function orderedSidebarItemsForRepo(repoId: string): SidebarTaskItem[] {
    const workspaceItems = sidebarItems.value.filter((item) => item.repo_id === repoId);
    const items = workspaceItems.length > 0 || repoId.startsWith("cloud:")
      ? workspaceItems
      : canonicalSidebarTaskItems(
          store.sortedItemsAllRepos.filter((item) => item.repo_id === repoId),
          repoId,
        );
    return sortSidebarTaskItemsForRepo({
      repoId,
      items,
      blockers: effectiveTaskBlockers.value,
      blockerTaskStates: effectiveBlockerTaskStates.value,
      getStageOrder: store.getStageOrder,
    });
  }

  function visibleSidebarItemsAllRepos(): SidebarTaskItem[] {
    if (sidebarRepos.value.length > 0) {
      return sidebarRepos.value.flatMap((repo) => visibleSidebarItemsForRepo(repo.id));
    }
    if (store.sortedItemsAllRepos.length > 0) {
      return canonicalSidebarTaskItems(store.sortedItemsAllRepos);
    }
    const repoId = store.selectedRepoId;
    return repoId ? visibleSidebarItemsForRepo(repoId, { currentRepoScope: true }) : [];
  }

  function visibleSidebarItemsForCurrentRepo() {
    const repoId = selectedCloudRepoId.value ?? store.selectedRepoId;
    return repoId ? visibleSidebarItemsForRepo(repoId, { currentRepoScope: true }) : [];
  }

  function activityShortcutItems(scope: ActivityShortcutScope) {
    return scope === "currentRepo"
      ? visibleSidebarItemsForCurrentRepo()
      : visibleSidebarItemsAllRepos();
  }

  function sidebarItemForSelection(
    selectionId: string | null | undefined,
    items: readonly SidebarTaskItem[] = sidebarItems.value,
  ): SidebarTaskItem | null {
    if (!selectionId) return null;
    return items.find((item) =>
      item.slot_id === selectionId || item.task_id === selectionId,
    ) ?? null;
  }

  function presentationSlotIdForSelection(items: readonly SidebarTaskItem[]): string | null {
    const selectionId = selectedCloudItemId.value ?? store.selectedItemId;
    if (!selectionId) return null;
    const direct = sidebarItemForSelection(selectionId, items);
    if (direct) return direct.slot_id;

    const selectedWorkspace = workspaceTasksByItemId.value.get(selectionId);
    if (!selectedWorkspace) return selectionId;
    return items.find((item) =>
      workspaceTasksByItemId.value.get(item.slot_id) === selectedWorkspace,
    )?.slot_id ?? selectionId;
  }

  function navigationHistoryItems(): SidebarTaskItem[] {
    const visibleRepoIds = new Set(sidebarRepos.value.map((repo) => repo.id));
    const projectedItems = sidebarItems.value.filter((item) =>
      item.closed_at == null
      && (visibleRepoIds.size === 0 || visibleRepoIds.has(item.repo_id))
    );
    if (sidebarRepos.value.length > 0 || projectedItems.length > 0) {
      return projectedItems;
    }
    if (store.sortedItemsAllRepos.length > 0) {
      return canonicalSidebarTaskItems(store.sortedItemsAllRepos);
    }
    const repoId = store.selectedRepoId;
    return repoId ? visibleSidebarItemsForRepo(repoId, { currentRepoScope: true }) : [];
  }

  // Navigation
  async function selectSidebarItem(
    item: Pick<SidebarTaskItem, "slot_id" | "task_id" | "repo_id">,
    previousItemId?: string | null,
    selectionIntent = beginSelectionIntent(),
    recordNavigation = true,
  ) {
    if (selectionIntent !== selectionIntentVersion) return;
    if (item.repo_id !== store.selectedRepoId) {
      const previous = previousItemId !== undefined
        ? previousItemId
        : selectedCloudItemId.value ?? store.selectedItemId;
      // Both handlers apply their visible state synchronously before their
      // first persistence await. Start them together so Back can observe the
      // completed repo + task + history transition while writes are pending.
      const repoSelection = handleSelectRepo(item.repo_id, selectionIntent, false);
      const itemSelection = handleSelectItem(
        item.slot_id,
        previous,
        selectionIntent,
        recordNavigation,
      );
      await Promise.all([repoSelection, itemSelection]);
      return;
    }

    if (previousItemId !== undefined) {
      await handleSelectItem(item.slot_id, previousItemId, selectionIntent, recordNavigation);
    } else {
      await handleSelectItem(item.slot_id, undefined, selectionIntent, recordNavigation);
    }
  }

  async function selectSidebarItemById(presentationSlotId: string) {
    const item = sidebarItemForSelection(presentationSlotId);
    if (!item) return;
    await selectSidebarItem(item);
  }

  function prepareReplacementAfterItemRemoval(
    removedItem: SidebarTaskItem,
  ): () => Promise<string | null> {
    const sameRepoSorted = orderedSidebarItemsForRepo(removedItem.repo_id);
    const replacements = replacementSidebarTaskItemsAfterRemoval({
      repoId: removedItem.repo_id,
      items: sameRepoSorted,
      blockers: effectiveTaskBlockers.value,
      blockerTaskStates: effectiveBlockerTaskStates.value,
      getStageOrder: store.getStageOrder,
    }, removedItem);
    return async () => {
      let currentReplacement: SidebarTaskItem | null = null;
      for (const candidate of replacements) {
        currentReplacement = sidebarItems.value.find((item) =>
          item.repo_id === candidate.repo_id
          && item.slot_id === candidate.slot_id,
        )
          ?? (candidate.task_id
            ? sidebarItems.value.find((item) =>
                item.repo_id === candidate.repo_id
                && item.task_id === candidate.task_id,
              )
            : null)
          ?? null;
        if (currentReplacement) break;
      }
      if (currentReplacement) {
        await selectSidebarItem(currentReplacement, removedItem.slot_id);
        return currentReplacement.slot_id;
      }

      beginSelectionIntent();
      store.selectedRepoId = removedItem.repo_id;
      selectedCloudItemId.value = null;
      store.selectedItemId = null;
      const lastSelectedItemId = store.lastSelectedItemByRepo[removedItem.repo_id];
      if (
        lastSelectedItemId === removedItem.slot_id
        || (removedItem.task_id !== null && lastSelectedItemId === removedItem.task_id)
      ) {
        delete store.lastSelectedItemByRepo[removedItem.repo_id];
      }
      await windowWorkspace.persistSelection({
        selectedRepoId: removedItem.repo_id,
        selectedItemId: null,
      });
      return null;
    };
  }

  async function navigateItems(direction: -1 | 1) {
    const allItems = visibleSidebarItemsAllRepos();
    const visibleItems = allItems;
    if (visibleItems.length === 0) return;
    const selectedPresentationSlotId = presentationSlotIdForSelection(visibleItems);
    const currentIndex = visibleItems.findIndex((item) =>
      item.slot_id === selectedPresentationSlotId,
    );
    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = 0;
    } else {
      nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex >= visibleItems.length) nextIndex = visibleItems.length - 1;
    }
    const nextItem = visibleItems[nextIndex];
    if (nextItem.slot_id !== selectedPresentationSlotId) {
      const previousItemId = selectedCloudItemId.value ?? store.selectedItemId;
      await selectSidebarItem(nextItem, previousItemId);
    }
  }

  async function navigateRepos(direction: -1 | 1) {
    const selectionIntent = beginSelectionIntent();
    const visibleRepos = sidebarRepos.value;
    if (visibleRepos.length === 0) return;
    const currentIndex = visibleRepos.findIndex((r) => r.id === store.selectedRepoId);
    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = 0;
    } else {
      nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= visibleRepos.length) return;
    }
    const nextRepo = visibleRepos[nextIndex];
    if (nextRepo.id === store.selectedRepoId) return;
    const previousItemId = selectedCloudItemId.value ?? store.selectedItemId;

    // Restore last-selected task for this repo, or fall back to first task.
    const lastItemId = store.lastSelectedItemByRepo[nextRepo.id];
    const lastItem = lastItemId
      ? sidebarItems.value.find((item) =>
        (item.slot_id === lastItemId || item.task_id === lastItemId)
        && item.repo_id === nextRepo.id
        && item.closed_at == null,
      )
      : undefined;
    const targetItem = lastItem ?? visibleSidebarItemsForRepo(nextRepo.id)[0];

    if (targetItem) {
      await selectSidebarItem(targetItem, previousItemId, selectionIntent);
      return;
    }
    await handleSelectRepo(nextRepo.id, selectionIntent);
  }

  function isBlocked(itemId: string | null): boolean {
    if (itemId === null) return false;
    // Blocker lifecycle state remains available even when closed or hidden
    // blockers are absent from the visible task list.
    return effectiveTaskBlockers.value.some((blocker) => {
      if (blocker.blocked_item_id !== itemId) return false;
      const blockerState = effectiveBlockerTaskStates.value[blocker.blocker_item_id]
        ?? store.items.find((item) => item.id === blocker.blocker_item_id);
      return !blockerState || !isBlockerResolved(blockerState);
    });
  }

  async function selectReadTask(scope: ActivityShortcutScope) {
    const target = selectTaskByActivity(
      activityShortcutItems(scope).filter((item) =>
        isActivityShortcutCandidate(item)
        && isUnpinnedActivityShortcutCandidate(item)
        && !isBlocked(item.task_id)
      ),
      "oldest",
      "idle",
    );
    if (target) await selectSidebarItem(target);
  }

  async function selectUnreadTaskWithReadFallback(scope: ActivityShortcutScope) {
    const target = selectTaskByActivity(
      activityShortcutItems(scope).filter((item) =>
        isActivityShortcutCandidate(item)
        && isUnpinnedActivityShortcutCandidate(item)
      ),
      "oldest",
      "unread",
    );
    if (target) {
      await selectSidebarItem(target);
      return;
    }
    await selectReadTask(scope);
  }

  async function navigateHistory(direction: "back" | "forward") {
    const selectionIntent = beginSelectionIntent();
    const items = navigationHistoryItems();
    if (items.length === 0) return;
    const currentItemId = presentationSlotIdForSelection(items);
    if (!currentItemId) return;
    const validItemIds = new Set(items.map((item) => item.slot_id));
    const targetItemId = direction === "back"
      ? store.takeBackTarget(currentItemId, validItemIds)
      : store.takeForwardTarget(currentItemId, validItemIds);
    if (!targetItemId) return;
    const target = sidebarItemForSelection(targetItemId, items);
    if (!target) return;
    // The ledger move above and the visible selection below are one
    // optimistic transition: selectSidebarItem applies all visible state
    // before yielding to persistence.
    await selectSidebarItem(target, undefined, selectionIntent, false);
  }

  async function navigateBack() {
    await navigateHistory("back");
  }

  async function navigateForward() {
    await navigateHistory("forward");
  }

  function handleBlockTask() {
    blockerSelectMode.value = "block";
    showBlockerSelect.value = true;
  }

  function handleEditBlockedTask() {
    blockerSelectMode.value = "edit";
    showBlockerSelect.value = true;
  }

  const blockerCandidates = computed(() => {
    const item = store.currentItem;
    if (!item) return [];
    return store.items.filter((i) =>
      i.id !== item.id &&
      i.closed_at == null &&
      i.repo_id === store.selectedRepoId
    );
  });

  // Tasks that would create circular dependencies — shown greyed out
  const disabledBlockerIds = computedAsync(async () => {
    const item = store.currentItem;
    if (!item) return [];
    if (item.closed_at == null) {
      const dependents = await collectDependents(item.id);
      return [...dependents];
    }
    return [];
  }, []);

  /** Walk the blocker graph to find all tasks transitively blocked by itemId. */
  async function collectDependents(itemId: string): Promise<Set<string>> {
    const result = new Set<string>();
    const queue = [itemId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      const blocked = await store.listBlockedByItem(current);
      for (const b of blocked) {
        if (!result.has(b.id)) {
          result.add(b.id);
          queue.push(b.id);
        }
      }
    }
    return result;
  }

  const preselectedBlockerIds = computedAsync(async () => {
    const item = store.currentItem;
    if (!item) return [];
    const blockers = await store.listBlockersForItem(item.id);
    return blockers.map((b: PipelineItem) => b.id);
  }, []);

  // Build a map of blocked item ID → blocker names for the sidebar
  const sidebarBlockerNames = computedAsync(async () => {
    const blockedIds = new Set(store.taskBlockers.map((blocker) => blocker.blocked_item_id));
    const blockedItems = store.items.filter((i) => blockedIds.has(i.id));
    if (blockedItems.length === 0) return {};
    const map: Record<string, string> = {};
    for (const item of blockedItems) {
      const blockers = await store.listBlockersForItem(item.id);
      map[item.id] = blockers
        .map((b: PipelineItem) => b.display_name || (b.prompt ? b.prompt.slice(0, 30) : "Untitled"))
        .join(", ");
    }
    return map;
  }, {});

  async function onBlockerConfirm(selectedIds: string[]) {
    showBlockerSelect.value = false;
    if (blockerSelectMode.value === "block") {
      await store.blockTask(selectedIds);
    } else {
      const item = store.currentItem;
      if (item) {
        try {
          await store.editBlockedTask(item.id, selectedIds);
        } catch (e: unknown) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      }
    }
  }

  const paletteExtraCommands = computed<PaletteExtraCommand[]>(() => {
    const cmds: PaletteExtraCommand[] = [
      { action: "undoClose", label: t('tasks.undoClose'), group: t('shortcuts.groupTasks'), shortcut: "" },
    ];
    const item = store.currentItem;
    if (item && item.closed_at == null && !isBlocked(item.id)) {
      cmds.push({ action: "blockTask", label: t('tasks.blockTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
    }
    if (item && isBlocked(item.id)) {
      cmds.push({ action: "editBlockedTask", label: t('tasks.editBlockedTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
    }
    return cmds;
  });

  const paletteDynamicCommands = computed<DynamicCommand[]>(() => {
    const cmds: DynamicCommand[] = [];
    const selectedId = selectedCloudItemId.value ?? store.selectedItemId;
    const selectedSidebarItem = sidebarItemForSelection(selectedId);
    const selectedWorkspaceTask = selectedId
      ? workspaceTasksByItemId.value.get(selectedId)
        ?? (selectedSidebarItem?.task_id
          ? workspaceTasksByItemId.value.get(selectedSidebarItem.task_id)
          : undefined)
      : undefined;
    // Rename task (only when a task is selected)
    if (store.currentItem) {
      cmds.push({
        id: "rename-task",
        label: t('tasks.renameTask'),
        execute: () => sidebarRef.value?.renameSelectedItem(),
      });
    }
    if (
      selectedWorkspaceTask?.capabilities.canPushToMachine
      && selectedWorkspaceTask.item.closed_at == null
      && selectedWorkspaceTask.localTaskId
    ) {
      cmds.push({
        id: "push-to-machine",
        label: t('taskTransfer.pushToMachine'),
        execute: () => openPeerPicker(selectedWorkspaceTask.localTaskId!),
      });
    }
    if (
      selectedWorkspaceTask?.capabilities.canPullFromMachine
      && selectedWorkspaceTask.item.closed_at == null
      && pullSelectedWorkspaceTask
    ) {
      cmds.push({
        id: "pull-to-machine",
        label: t('taskTransfer.pullToThisMachine'),
        execute: () => void pullSelectedWorkspaceTask(selectedWorkspaceTask),
      });
    }
    cmds.push({
      id: "pair-machine",
      label: t('taskTransfer.pairPeer'),
      execute: () => openPairPeerPicker(),
    });
    for (const command of repoCommandCatalog.value?.commands ?? []) {
      cmds.push({
        id: command.id,
        label: command.label,
        description: command.description,
        execute: () => {
          const catalog = repoCommandCatalog.value;
          if (!catalog) return;
          void runDesktopRepoCommand(catalog.repoId, command.id, catalog.revision)
            .then(async ({ taskId }) => {
              await store.reloadSnapshot();
              await store.selectItem(taskId);
            })
            .catch(async (error) => {
              console.error("[App] repository command failed:", error);
              if (error instanceof Error && error.message.includes("failed: 409")) {
                try {
                  repoCommandCatalog.value = await fetchDesktopRepoCommands(catalog.repoId);
                } catch (refreshError) {
                  console.error("[App] repository command catalog refresh failed:", refreshError);
                }
              }
              toast.error(error instanceof Error ? error.message : String(error));
            });
        },
      });
    }
    return cmds;
  });

  async function handleSelectRepo(
    repoId: string,
    selectionIntent = beginSelectionIntent(),
    persistWindowSelection = true,
  ) {
    if (selectionIntent !== selectionIntentVersion) return;
    if (repoId.startsWith("cloud:")) {
      const rememberedSelectionId = store.lastSelectedItemByRepo[repoId] ?? null;
      const rememberedItem = sidebarItemForSelection(rememberedSelectionId);
      const presentationSlotId = rememberedItem?.slot_id ?? null;
      selectedCloudRepoId.value = repoId;
      store.selectedRepoId = repoId;
      store.selectedItemId = presentationSlotId;
      selectedCloudItemId.value = presentationSlotId;
      if (persistWindowSelection) {
        await windowWorkspace.persistSelection({
          selectedRepoId: store.selectedRepoId,
          selectedItemId: rememberedItem?.task_id ?? null,
        });
      }
      return;
    }
    selectedCloudRepoId.value = null;
    selectedCloudItemId.value = null;
    if (persistWindowSelection) {
      await store.selectRepo(repoId);
    } else {
      await store.selectRepo(repoId, { persistWindowSelection: false });
    }
  }

  async function handleSelectItem(
    presentationSlotId: string,
    previousItemId?: string | null,
    selectionIntent = beginSelectionIntent(),
    recordNavigation = true,
  ) {
    if (selectionIntent !== selectionIntentVersion) return;
    const fallbackItem = store.items.find((item) => item.id === presentationSlotId);
    const projectedItem = sidebarItemForSelection(presentationSlotId)
      ?? (fallbackItem ? canonicalSidebarTaskItem(fallbackItem) : null);
    const workspaceTask = workspaceTasksByItemId.value.get(projectedItem?.slot_id ?? presentationSlotId)
      ?? (projectedItem?.task_id
        ? workspaceTasksByItemId.value.get(projectedItem.task_id)
        : undefined)
      ?? workspaceTasksByItemId.value.get(presentationSlotId);
    const stablePresentationSlotId = projectedItem?.slot_id ?? presentationSlotId;
    const previousPresentationSlotId = previousItemId !== undefined
      ? previousItemId
      : selectedCloudItemId.value ?? store.selectedItemId;
    if (recordNavigation) {
      store.recordNavigation(stablePresentationSlotId, previousPresentationSlotId);
    }
    if (workspaceTask && workspaceTask.owner.kind !== "local") {
      const durableTaskId = projectedItem?.task_id ?? workspaceTask.item.id;
      selectedCloudRepoId.value = workspaceTask.repoKey;
      selectedCloudItemId.value = stablePresentationSlotId;
      store.selectedRepoId = workspaceTask.repoKey;
      store.selectedItemId = stablePresentationSlotId;
      store.lastSelectedItemByRepo[workspaceTask.repoKey] = stablePresentationSlotId;
      await windowWorkspace.persistSelection({
        selectedRepoId: store.selectedRepoId,
        selectedItemId: durableTaskId,
      });
      return;
    }
    selectedCloudRepoId.value = null;
    selectedCloudItemId.value = null;
    const localSelectionId = workspaceTask
      ? workspaceTask.localTaskId ?? projectedItem?.task_id ?? workspaceTask.item.id
      : projectedItem?.state === "creating"
        ? projectedItem.slot_id
        : projectedItem?.task_id ?? presentationSlotId;
    await store.selectItem(localSelectionId, {
      previousItemId: previousPresentationSlotId,
      recordNavigation: false,
    });
  }

  watch(
    () => {
      const presentationSlotId = selectedCloudItemId.value;
      if (!presentationSlotId) return null;
      const workspaceTask = workspaceTasksByItemId.value.get(presentationSlotId);
      if (!workspaceTask || workspaceTask.owner.kind === "local") return null;
      const currentRepoKey = selectedCloudRepoId.value ?? store.selectedRepoId;
      if (currentRepoKey === workspaceTask.repoKey) return null;
      const projectedItem = sidebarItemForSelection(presentationSlotId);
      return {
        currentRepoKey,
        durableTaskId: projectedItem?.task_id ?? workspaceTask.item.id,
        presentationSlotId,
        repoKey: workspaceTask.repoKey,
      };
    },
    (remoteSelection) => {
      if (!remoteSelection) return;
      const {
        currentRepoKey,
        durableTaskId,
        presentationSlotId,
        repoKey,
      } = remoteSelection;
      if (
        currentRepoKey
        && currentRepoKey !== repoKey
        && store.lastSelectedItemByRepo[currentRepoKey] === presentationSlotId
      ) {
        delete store.lastSelectedItemByRepo[currentRepoKey];
      }
      selectedCloudRepoId.value = repoKey;
      store.selectedRepoId = repoKey;
      store.lastSelectedItemByRepo[repoKey] = presentationSlotId;
      void windowWorkspace.persistSelection({
        selectedRepoId: repoKey,
        selectedItemId: durableTaskId,
      }).catch((error) => {
        console.error("[App] failed to persist rekeyed remote task selection:", error);
      });
    },
    { flush: "sync" },
  );

  watch(
    () => {
      const presentationSlotId = selectedCloudItemId.value;
      if (!presentationSlotId) return null;
      const workspaceTask = workspaceTasksByItemId.value.get(presentationSlotId);
      return workspaceTask?.owner.kind === "local"
        ? { presentationSlotId, workspaceTask }
        : null;
    },
    (localSelection) => {
      if (!localSelection) return;
      const projectedItem = sidebarItemForSelection(localSelection.presentationSlotId);
      const localTaskId = localSelection.workspaceTask.localTaskId
        ?? projectedItem?.task_id
        ?? localSelection.workspaceTask.item.id;
      const normalizeSelection = store.selectItem(localTaskId, { recordNavigation: false });
      if (selectedCloudItemId.value === localSelection.presentationSlotId) {
        selectedCloudRepoId.value = null;
        selectedCloudItemId.value = null;
      }
      void normalizeSelection.catch((error) => {
        console.error("[App] failed to normalize remote task selection to local owner:", error);
      });
    },
    { flush: "sync" },
  );

  return {
    visibleSidebarItemsForRepo,
    visibleSidebarItemsAllRepos,
    selectSidebarItem,
    selectSidebarItemById,
    prepareReplacementAfterItemRemoval,
    navigateItems,
    navigateRepos,
    navigateBack,
    navigateForward,
    selectReadTask,
    selectUnreadTaskWithReadFallback,
    handleBlockTask,
    handleEditBlockedTask,
    blockerCandidates,
    disabledBlockerIds,
    preselectedBlockerIds,
    sidebarBlockerNames,
    onBlockerConfirm,
    paletteExtraCommands,
    paletteDynamicCommands,
    handleSelectRepo,
    handleSelectItem,
  };
}
