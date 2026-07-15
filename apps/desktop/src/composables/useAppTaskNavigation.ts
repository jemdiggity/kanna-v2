import { computed, watch, type ComputedRef, type Ref } from "vue";
import { computedAsync } from "@vueuse/core";
import type { PipelineItem } from "../types/kanna";
import { NEW_CUSTOM_TASK_PROMPT } from "@kanna/core";
import type { CustomTaskConfig } from "@kanna/core";

import Sidebar from "../components/Sidebar.vue";
import { isBlockerResolved } from "../utils/blockerResolution";
import { selectTaskByActivity } from "../utils/selectTaskByActivity";
import { sortSidebarTaskItemsForRepo } from "../utils/sidebarOrdering";
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
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  selectedCloudRepoId: Ref<string | null>;
  selectedCloudItemId: Ref<string | null>;
  showBlockerSelect: Ref<boolean>;
  blockerSelectMode: Ref<"block" | "edit">;
  customTasks: Ref<CustomTaskConfig[]>;
  openPeerPicker: (taskId: string) => void;
  openPairPeerPicker: () => void;
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
  workspaceTasksByItemId,
  selectedCloudRepoId,
  selectedCloudItemId,
  showBlockerSelect,
  blockerSelectMode,
  customTasks,
  openPeerPicker,
  openPairPeerPicker,
}: UseAppTaskNavigationOptions) {
  let selectionIntentVersion = 0;

  function visibleSidebarItemsForRepo(
    repoId: string,
    options: { currentRepoScope?: boolean } = {},
  ): SidebarTaskItem[] {
    const workspaceItems = sidebarItems.value.filter((item) => item.repo_id === repoId);
    const searchQuery = sidebarRef.value?.searchQuery ?? "";
    const sortOptions = {
      repoId,
      blockers: store.taskBlockers,
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

  function visibleSidebarItemsAllRepos(): SidebarTaskItem[] {
    const workspaceItems = sidebarRepos.value.flatMap((repo) => visibleSidebarItemsForRepo(repo.id));
    if (workspaceItems.length > 0) return workspaceItems;
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

  // Navigation
  async function selectSidebarItem(
    item: Pick<SidebarTaskItem, "slot_id" | "task_id" | "repo_id">,
    previousItemId?: string | null,
    selectionIntent = ++selectionIntentVersion,
  ) {
    if (selectionIntent !== selectionIntentVersion) return;
    if (item.repo_id !== store.selectedRepoId) {
      const previous = previousItemId !== undefined ? previousItemId : store.selectedItemId;
      await handleSelectRepo(item.repo_id, selectionIntent);
      if (selectionIntent !== selectionIntentVersion) return;
      await handleSelectItem(item.slot_id, previous, selectionIntent);
      return;
    }

    if (previousItemId !== undefined) {
      await handleSelectItem(item.slot_id, previousItemId, selectionIntent);
    } else {
      await handleSelectItem(item.slot_id, undefined, selectionIntent);
    }
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
      const previousItemId = store.selectedItemId;
      await selectSidebarItem(nextItem, previousItemId);
    }
  }

  async function navigateRepos(direction: -1 | 1) {
    const selectionIntent = ++selectionIntentVersion;
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
    const previousItemId = store.selectedItemId;

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

    await handleSelectRepo(nextRepo.id, selectionIntent);
    if (selectionIntent !== selectionIntentVersion) return;
    if (targetItem) {
      await handleSelectItem(targetItem.slot_id, previousItemId, selectionIntent);
    }
  }

  function isBlocked(itemId: string | null): boolean {
    if (itemId === null) return false;
    // Optimistic resolution: a blocker parked at `pr` with a PR created no
    // longer blocks (see isBlockerResolved). A blocker row whose task is
    // unknown counts as unresolved.
    return (store.taskBlockers ?? []).some((blocker) => {
      if (blocker.blocked_item_id !== itemId) return false;
      const blockerItem = store.items.find((item) => item.id === blocker.blocker_item_id);
      return !blockerItem || !isBlockerResolved(blockerItem);
    });
  }

  async function selectReadTask(mode: "oldest" | "newest") {
    const target = selectTaskByActivity(
      visibleSidebarItemsForCurrentRepo().filter((item) =>
        isActivityShortcutCandidate(item)
        && isUnpinnedActivityShortcutCandidate(item)
        && !isBlocked(item.task_id)
      ),
      mode,
      "idle",
    );
    if (target) await selectSidebarItem(target);
  }

  async function selectUnreadTaskWithReadFallback(mode: "oldest" | "newest") {
    const target = selectTaskByActivity(
      visibleSidebarItemsForCurrentRepo().filter((item) =>
        isActivityShortcutCandidate(item)
        && isUnpinnedActivityShortcutCandidate(item)
      ),
      mode,
      "unread",
    );
    if (target) {
      await selectSidebarItem(target);
      return;
    }
    await selectReadTask(mode);
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
    const cmds: PaletteExtraCommand[] = [];
    const item = store.currentItem;
    if (item && item.closed_at == null && !isBlocked(item.id)) {
      cmds.push({ action: "blockTask", label: t('tasks.blockTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
    }
    if (item && isBlocked(item.id)) {
      cmds.push({ action: "editBlockedTask", label: t('tasks.editBlockedTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
    }
    return cmds;
  });

  // Custom tasks
  async function handleLaunchCustomTask(task: CustomTaskConfig) {
    if (!store.selectedRepoId) {
      if (store.repos.length === 1) {
        store.selectedRepoId = store.repos[0].id;
      } else {
        alert(t('app.selectRepoFirst'));
        return;
      }
    }
    const repo = store.repos.find((r) => r.id === store.selectedRepoId);
    if (!repo) return;
    try {
      let resolvedTask = task;

      if (task.agent) {
        const agent = await store.loadAgent(repo.id, task.agent);

        resolvedTask = {
          ...task,
          model: task.model ?? agent.model,
          permissionMode: task.permissionMode ?? agent.permission_mode,
          allowedTools: task.allowedTools ?? agent.allowed_tools,
        };
      }

      await store.createItem(store.selectedRepoId, repo.path, resolvedTask.prompt, "pty", {
        customTask: resolvedTask,
        stage: task.stage,
      });
    } catch (e: unknown) {
      console.error("[App] custom task launch failed:", e);
      const message = typeof e === "object" && e !== null && "message" in e
        ? (e as { message?: unknown }).message || e
        : e;
      alert(`${t('app.customTaskLaunchFailed')}: ${String(message)}`);
    }
  }

  async function handleCreateCustomTask() {
    if (!store.selectedRepoId) {
      if (store.repos.length === 1) {
        store.selectedRepoId = store.repos[0].id;
      } else {
        alert(t('app.selectRepoFirst'));
        return;
      }
    }
    const repo = store.repos.find((r) => r.id === store.selectedRepoId);
    if (!repo) return;
    try {
      await store.createItem(store.selectedRepoId, repo.path, NEW_CUSTOM_TASK_PROMPT);
    } catch (e: unknown) {
      console.error("[App] custom task creation failed:", e);
      alert(`${t('app.customTaskCreationFailed')}: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function handleCreateAgent() {
    if (!store.selectedRepoId) {
      if (store.repos.length === 1) {
        store.selectedRepoId = store.repos[0].id;
      } else {
        alert(t('app.selectRepoFirst'));
        return;
      }
    }
    const repo = store.repos.find((r) => r.id === store.selectedRepoId);
    if (!repo) return;
    try {
      await store.createItem(store.selectedRepoId, repo.path, "Help me create a new agent definition for this repository.");
    } catch (e: unknown) {
      console.error("[App] create agent task failed:", e);
      alert(`Failed to create agent task: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function handleCreatePipeline() {
    if (!store.selectedRepoId) {
      if (store.repos.length === 1) {
        store.selectedRepoId = store.repos[0].id;
      } else {
        alert(t('app.selectRepoFirst'));
        return;
      }
    }
    const repo = store.repos.find((r) => r.id === store.selectedRepoId);
    if (!repo) return;
    try {
      await store.createItem(store.selectedRepoId, repo.path, "Help me create a new pipeline definition for this repository.");
    } catch (e: unknown) {
      console.error("[App] create pipeline task failed:", e);
      alert(`Failed to create pipeline task: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function handleCreateConfig() {
    if (!store.selectedRepoId) {
      if (store.repos.length === 1) {
        store.selectedRepoId = store.repos[0].id;
      } else {
        alert(t('app.selectRepoFirst'));
        return;
      }
    }
    const repo = store.repos.find((r) => r.id === store.selectedRepoId);
    if (!repo) return;
    try {
      const agent = await store.loadAgent(repo.id, "config-factory");
      await store.createItem(
        store.selectedRepoId,
        repo.path,
        "Help me create or update the .kanna/config.json for this repository.",
        "pty",
        {
          customTask: {
            name: "Create Config",
            agent: "config-factory",
            prompt: "Help me create or update the .kanna/config.json for this repository.",
            model: agent.model,
            permissionMode: agent.permission_mode,
            allowedTools: agent.allowed_tools,
          },
        },
      );
    } catch (e: unknown) {
      console.error("[App] create config task failed:", e);
      alert(`Failed to create config task: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function handleSetupRepo() {
    if (!store.selectedRepoId) {
      if (store.repos.length === 1) {
        store.selectedRepoId = store.repos[0].id;
      } else {
        alert(t('app.selectRepoFirst'));
        return;
      }
    }
    const repo = store.repos.find((r) => r.id === store.selectedRepoId);
    if (!repo) return;
    try {
      const agent = await store.loadAgent(repo.id, "setup");
      await store.createItem(
        store.selectedRepoId,
        repo.path,
        "Set up Kanna for this repository.",
        "pty",
        {
          customTask: {
            name: "Set Up Repository",
            agent: "setup",
            prompt: "Set up Kanna for this repository.",
            model: agent.model,
            permissionMode: agent.permission_mode,
            allowedTools: agent.allowed_tools,
          },
        },
      );
    } catch (e: unknown) {
      console.error("[App] setup repo task failed:", e);
      alert(`Failed to create setup task: ${e instanceof Error ? e.message : e}`);
    }
  }

  const paletteDynamicCommands = computed<DynamicCommand[]>(() => {
    const cmds: DynamicCommand[] = [];
    // Rename task (only when a task is selected)
    if (store.currentItem) {
      cmds.push({
        id: "rename-task",
        label: t('tasks.renameTask'),
        execute: () => sidebarRef.value?.renameSelectedItem(),
      });
    }
    if (store.currentItem && store.currentItem.closed_at == null) {
      cmds.push({
        id: "push-to-machine",
        label: t('taskTransfer.pushToMachine'),
        execute: () => openPeerPicker(store.currentItem!.id),
      });
    }
    cmds.push({
      id: "pair-machine",
      label: t('taskTransfer.pairPeer'),
      execute: () => openPairPeerPicker(),
    });
    // Factory commands
    cmds.push({
      id: "create-agent",
      label: t('commandPalette.createAgent'),
      description: t('commandPalette.createAgentDesc'),
      execute: () => { handleCreateAgent().catch((e) => console.error("[App] create agent failed:", e)); },
    });
    cmds.push({
      id: "create-pipeline",
      label: t('commandPalette.createPipeline'),
      description: t('commandPalette.createPipelineDesc'),
      execute: () => { handleCreatePipeline().catch((e) => console.error("[App] create pipeline failed:", e)); },
    });
    cmds.push({
      id: "setup-repo",
      label: t('commandPalette.setupRepo'),
      description: t('commandPalette.setupRepoDesc'),
      execute: () => { handleSetupRepo().catch((e) => console.error("[App] setup repo failed:", e)); },
    });
    cmds.push({
      id: "create-config",
      label: t('commandPalette.createConfig'),
      description: t('commandPalette.createConfigDesc'),
      execute: () => { handleCreateConfig().catch((e) => console.error("[App] create config failed:", e)); },
    });
    // Always include "New Custom Task" option
    cmds.push({
      id: "custom-task-new",
      label: t('app.newCustomTask'),
      description: t('app.newCustomTaskDesc'),
      execute: () => handleCreateCustomTask(),
    });
    // Add discovered custom tasks
    for (const task of customTasks.value) {
      cmds.push({
        id: `custom-task-${task.name}`,
        label: task.name,
        description: task.description,
        execute: () => handleLaunchCustomTask(task),
      });
    }
    return cmds;
  });

  async function handleSelectRepo(
    repoId: string,
    selectionIntent = ++selectionIntentVersion,
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
      await windowWorkspace.persistSelection({
        selectedRepoId: store.selectedRepoId,
        selectedItemId: rememberedItem?.task_id ?? null,
      });
      return;
    }
    selectedCloudRepoId.value = null;
    selectedCloudItemId.value = null;
    await store.selectRepo(repoId);
  }

  async function handleSelectItem(
    presentationSlotId: string,
    previousItemId?: string | null,
    selectionIntent = ++selectionIntentVersion,
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
    if (workspaceTask && workspaceTask.owner.kind !== "local") {
      const stablePresentationSlotId = projectedItem?.slot_id ?? presentationSlotId;
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
    if (previousItemId !== undefined) {
      await store.selectItem(localSelectionId, { previousItemId });
    } else {
      await store.selectItem(localSelectionId);
    }
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
      const normalizeSelection = store.selectItem(localTaskId);
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
    navigateItems,
    navigateRepos,
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
