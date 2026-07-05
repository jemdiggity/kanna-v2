import { computed, type ComputedRef, type Ref } from "vue";
import { computedAsync } from "@vueuse/core";
import type { AgentProvider } from "@kanna/db";
import { NEW_CUSTOM_TASK_PROMPT } from "@kanna/core";
import type { CustomTaskConfig } from "@kanna/core";

import Sidebar from "../components/Sidebar.vue";
import { selectTaskByActivity } from "../utils/selectTaskByActivity";
import { sortSidebarItemsForRepo } from "../utils/sidebarOrdering";
import { isTaskTearingDown } from "../stores/taskStages";
import type { WorkspaceTask } from "../workspace/types";
import type { AppSidebarItem } from "./useAppCloudWorkspace";
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

interface UseAppTaskNavigationOptions {
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  t: (key: string) => string;
  windowWorkspace: WindowWorkspaceController;
  sidebarRef: Ref<InstanceType<typeof Sidebar> | null>;
  sidebarRepos: ComputedRef<SidebarRepoProjection[]>;
  sidebarItems: ComputedRef<AppSidebarItem[]>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  selectedCloudRepoId: Ref<string | null>;
  selectedCloudItemId: Ref<string | null>;
  showBlockerSelect: Ref<boolean>;
  blockerSelectMode: Ref<"block" | "edit">;
  customTasks: Ref<CustomTaskConfig[]>;
  firstSupportedAgentProvider: (
    agentProvider: AgentProvider | AgentProvider[] | string | string[] | undefined,
  ) => AgentProvider | undefined;
  openPeerPicker: (taskId: string) => void;
  openPairPeerPicker: () => void;
}

function isActivityShortcutCandidate(item: { stage?: string; teardown_started_at?: string | null }): boolean {
  if (typeof item.stage !== "string") return true;
  return !isTaskTearingDown({ stage: item.stage, teardown_started_at: item.teardown_started_at });
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
  firstSupportedAgentProvider,
  openPeerPicker,
  openPairPeerPicker,
}: UseAppTaskNavigationOptions) {
  function visibleSidebarItemsForRepo(repoId: string, options: { currentRepoScope?: boolean } = {}) {
    const workspaceItems = sidebarItems.value.filter((item) => item.repo_id === repoId);
    const searchQuery = sidebarRef.value?.searchQuery ?? "";
    const sortOptions = {
      repoId,
      blockers: store.taskBlockers,
      getStageOrder: store.getStageOrder,
      searchQuery,
    };
    const withRepoId = (items: typeof workspaceItems) => items.map((item) => ({
      ...item,
      repo_id: item.repo_id ?? repoId,
    }));
    if (workspaceItems.length === 0 && options.currentRepoScope && repoId === store.selectedRepoId && !repoId.startsWith("cloud:")) {
      return sortSidebarItemsForRepo({ ...sortOptions, items: withRepoId(store.sortedItemsForCurrentRepo) });
    }
    if (options.currentRepoScope && repoId === store.selectedRepoId && !repoId.startsWith("cloud:")) {
      return sortSidebarItemsForRepo({ ...sortOptions, items: workspaceItems });
    }
    return sortSidebarItemsForRepo({ ...sortOptions, items: workspaceItems });
  }

  function visibleSidebarItemsAllRepos() {
    const workspaceItems = sidebarRepos.value.flatMap((repo) => visibleSidebarItemsForRepo(repo.id));
    if (workspaceItems.length > 0) return workspaceItems;
    if (store.sortedItemsAllRepos.length > 0) return store.sortedItemsAllRepos;
    const repoId = store.selectedRepoId;
    return repoId ? visibleSidebarItemsForRepo(repoId, { currentRepoScope: true }) : [];
  }

  function visibleSidebarItemsForCurrentRepo() {
    const repoId = selectedCloudRepoId.value ?? store.selectedRepoId;
    return repoId ? visibleSidebarItemsForRepo(repoId, { currentRepoScope: true }) : [];
  }

  // Navigation
  async function selectSidebarItem(item: Pick<AppSidebarItem, "id" | "repo_id">, previousItemId?: string | null) {
    if (item.repo_id !== store.selectedRepoId) {
      const previous = previousItemId !== undefined ? previousItemId : store.selectedItemId;
      await handleSelectRepo(item.repo_id);
      await handleSelectItem(item.id, previous);
      return;
    }

    if (previousItemId !== undefined) {
      await handleSelectItem(item.id, previousItemId);
    } else {
      await handleSelectItem(item.id);
    }
  }

  async function navigateItems(direction: -1 | 1) {
    const allItems = visibleSidebarItemsAllRepos();
    const visibleItems = allItems;
    if (visibleItems.length === 0) return;
    const currentIndex = visibleItems.findIndex((i) => i.id === store.selectedItemId);
    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = 0;
    } else {
      nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex >= visibleItems.length) nextIndex = visibleItems.length - 1;
    }
    const nextItem = visibleItems[nextIndex];
    if (nextItem.id !== store.selectedItemId) {
      const previousItemId = store.selectedItemId;
      await selectSidebarItem(nextItem, previousItemId);
    }
  }

  async function navigateRepos(direction: -1 | 1) {
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
      ? sidebarItems.value.find((i) => i.id === lastItemId && i.repo_id === nextRepo.id && i.closed_at == null)
      : undefined;
    const targetItem = lastItem ?? visibleSidebarItemsForRepo(nextRepo.id)[0];

    if (targetItem && !nextRepo.id.startsWith("cloud:")) {
      store.selectedRepoId = nextRepo.id;
      await handleSelectItem(targetItem.id, previousItemId);
      await store.selectRepo(nextRepo.id);
      return;
    }

    await handleSelectRepo(nextRepo.id);
    if (targetItem) {
      await handleSelectItem(targetItem.id, previousItemId);
    }
  }

  function isBlocked(itemId: string): boolean {
    return (store.taskBlockers ?? []).some((blocker) => blocker.blocked_item_id === itemId);
  }

  async function selectReadTask(mode: "oldest" | "newest") {
    const target = selectTaskByActivity(
      visibleSidebarItemsForCurrentRepo().filter((item) => isActivityShortcutCandidate(item) && !isBlocked(item.id)),
      mode,
      "idle",
    );
    if (target) await selectSidebarItem(target);
  }

  async function selectUnreadTaskWithReadFallback(mode: "oldest" | "newest") {
    const target = selectTaskByActivity(
      visibleSidebarItemsForCurrentRepo().filter(isActivityShortcutCandidate),
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
    return blockers.map((b) => b.id);
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
        .map((b) => b.display_name || (b.prompt ? b.prompt.slice(0, 30) : "Untitled"))
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
      let requestedAgentProvider: AgentProvider | undefined;

      if (task.agent) {
        const agent = await store.loadAgent(repo.path, task.agent);
        const firstProvider = firstSupportedAgentProvider(agent.agent_provider);

        resolvedTask = {
          ...task,
          prompt: task.prompt || agent.prompt,
          model: task.model ?? agent.model,
          permissionMode: task.permissionMode ?? agent.permission_mode,
          allowedTools: task.allowedTools ?? agent.allowed_tools,
        };
        requestedAgentProvider = task.agentProvider ?? firstProvider;
      }

      await store.createItem(store.selectedRepoId, repo.path, resolvedTask.prompt, "pty", {
        customTask: resolvedTask,
        stage: task.stage,
        agentProvider: requestedAgentProvider,
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
      const agent = await store.loadAgent(repo.path, "config-factory");
      await store.createItem(
        store.selectedRepoId,
        repo.path,
        "Help me create or update the .kanna/config.json for this repository.",
        "pty",
        {
          agentProvider: firstSupportedAgentProvider(agent.agent_provider),
          customTask: {
            name: "Create Config",
            agent: "config-factory",
            prompt: agent.prompt,
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

  async function handleSelectRepo(repoId: string) {
    if (repoId.startsWith("cloud:")) {
      selectedCloudRepoId.value = repoId;
      store.selectedRepoId = repoId;
      store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
      selectedCloudItemId.value = store.selectedItemId;
      await windowWorkspace.persistSelection({
        selectedRepoId: store.selectedRepoId,
        selectedItemId: store.selectedItemId,
      });
      return;
    }
    selectedCloudRepoId.value = null;
    selectedCloudItemId.value = null;
    await store.selectRepo(repoId);
  }

  async function handleSelectItem(itemId: string, previousItemId?: string | null) {
    const workspaceTask = workspaceTasksByItemId.value.get(itemId);
    if (workspaceTask && workspaceTask.owner.kind !== "local") {
      selectedCloudRepoId.value = workspaceTask.repoKey;
      selectedCloudItemId.value = itemId;
      store.selectedRepoId = workspaceTask.repoKey;
      store.selectedItemId = itemId;
      store.lastSelectedItemByRepo[workspaceTask.repoKey] = itemId;
      await windowWorkspace.persistSelection({
        selectedRepoId: store.selectedRepoId,
        selectedItemId: store.selectedItemId,
      });
      return;
    }
    selectedCloudRepoId.value = null;
    selectedCloudItemId.value = null;
    if (previousItemId !== undefined) {
      await store.selectItem(itemId, { previousItemId });
    } else {
      await store.selectItem(itemId);
    }
  }

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
