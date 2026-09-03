import { computed, effectScope, nextTick, reactive, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import type { SidebarTaskItem } from "../types/taskUi";
import type { WorkspaceTask } from "../workspace/types";
import { createNavigationHistory } from "./useNavigationHistory";
import { useAppTaskNavigation } from "./useAppTaskNavigation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sidebarTask(slotId: string, repoId: string): SidebarTaskItem {
  const now = "2026-07-14T00:00:00.000Z";
  return {
    slot_id: slotId,
    task_id: slotId,
    state: "ready",
    repo_id: repoId,
    issue_number: null,
    issue_title: null,
    prompt: slotId,
    workflow: "default",
    pipeline_def: null,
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: `task-${slotId}`,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: now,
    unread_at: null,
    port_offset: null,
    display_name: slotId,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: now,
    updated_at: now,
  };
}

describe("useAppTaskNavigation", () => {
  it("derives push and pull palette actions from the selected workspace task capabilities", () => {
    const localItem = sidebarTask("slot-local", "repo-local");
    const remoteItem = {
      ...sidebarTask("slot-remote", "cloud:repo-remote"),
      task_id: "cloud:task-remote",
    };
    const localTask = {
      item: { id: "task-local" },
      localTaskId: "task-local",
      owner: { kind: "local", id: "local" },
      capabilities: { canPushToMachine: true, canPullFromMachine: false },
    } as WorkspaceTask;
    const remoteTask = reactive({
      item: { id: "cloud:task-remote" },
      localTaskId: null,
      owner: { kind: "remote", id: "desktop-owner" },
      capabilities: { canPushToMachine: false, canPullFromMachine: true },
    }) as WorkspaceTask;
    const selectedCloudItemId = ref<string | null>(null);
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: "repo-local",
      selectedItemId: "slot-local" as string | null,
      lastSelectedItemByRepo: {},
      items: [{ ...localItem, id: "task-local" }],
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: { ...localItem, id: "task-local" },
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      selectRepo: vi.fn(async () => {}),
      selectItem: vi.fn(async () => {}),
    });
    const openPeerPicker = vi.fn();
    const pullSelectedWorkspaceTask = vi.fn();
    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => []),
      sidebarItems: computed(() => [localItem, remoteItem]),
      workspaceTasksByItemId: computed(() => new Map([
        ["slot-local", localTask],
        ["task-local", localTask],
        ["slot-remote", remoteTask],
        ["cloud:task-remote", remoteTask],
      ])),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId,
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker,
      openPairPeerPicker: vi.fn(),
      pullSelectedWorkspaceTask,
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      expect(navigation.paletteExtraCommands.value).toContainEqual({
        action: "undoClose",
        label: "tasks.undoClose",
        group: "shortcuts.groupTasks",
        shortcut: "",
      });

      const localPush = navigation.paletteDynamicCommands.value.find((command) =>
        command.id === "push-to-machine");
      expect(localPush?.label).toBe("taskTransfer.pushToMachine");
      localPush?.execute();
      expect(openPeerPicker).toHaveBeenCalledWith("task-local");

      selectedCloudItemId.value = "slot-remote";
      store.selectedItemId = "slot-remote";
      store.currentItem = null as never;
      const remotePull = navigation.paletteDynamicCommands.value.find((command) =>
        command.id === "pull-to-machine");
      expect(remotePull?.label).toBe("taskTransfer.pullToThisMachine");
      remotePull?.execute();
      expect(pullSelectedWorkspaceTask).toHaveBeenCalledWith(remoteTask);

      remoteTask.capabilities.canPullFromMachine = false;
      expect(navigation.paletteDynamicCommands.value.some((command) =>
        command.id === "pull-to-machine")).toBe(false);
      expect(navigation.paletteDynamicCommands.value.some((command) =>
        command.id === "push-to-machine")).toBe(false);
      expect(navigation.paletteDynamicCommands.value.some((command) =>
        command.id === "pair-machine")).toBe(true);
    } finally {
      scope.stop();
    }
  });

  it("does not let an older cross-repo navigation overwrite a newer intent", async () => {
    const firstRepoSelection = deferred();
    const items = [sidebarTask("task-one", "repo-1"), sidebarTask("task-two", "repo-2")];
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: "repo-1",
      selectedItemId: "task-one" as string | null,
      lastSelectedItemByRepo: {
        "repo-1": "task-one",
        "repo-2": "task-two",
      } as Record<string, string>,
      items: items.map((item) => ({ ...item, id: item.task_id })),
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      recordNavigation: vi.fn(),
      takeBackTarget: vi.fn(),
      takeForwardTarget: vi.fn(),
    });
    let repoSelectionCount = 0;
    const selectRepo = vi.fn(async (repoId: string) => {
      repoSelectionCount += 1;
      store.selectedRepoId = repoId;
      store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
      if (repoSelectionCount === 1) await firstRepoSelection.promise;
    });
    const selectItem = vi.fn(async (itemId: string) => {
      store.selectedItemId = itemId;
      store.selectedRepoId = items.find((item) => item.slot_id === itemId)?.repo_id ?? store.selectedRepoId;
    });
    Object.assign(store, { selectRepo, selectItem });

    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => [
        { id: "repo-1" },
        { id: "repo-2" },
      ] as never),
      sidebarItems: computed(() => items),
      workspaceTasksByItemId: computed(() => new Map()),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      const olderNavigation = navigation.navigateItems(1);
      await vi.waitFor(() => expect(selectRepo).toHaveBeenCalledWith("repo-2", {
        persistWindowSelection: false,
      }));

      await navigation.navigateItems(-1);
      expect(store.selectedItemId).toBe("task-one");

      firstRepoSelection.resolve();
      await olderNavigation;

      expect(store.recordSelectionIntent).toHaveBeenCalledTimes(2);
      expect(selectItem).toHaveBeenCalledTimes(2);
      expect(selectItem).toHaveBeenNthCalledWith(1, "task-two", {
        previousItemId: "task-one",
        recordNavigation: false,
      });
      expect(selectItem).toHaveBeenNthCalledWith(2, "task-one", {
        previousItemId: "task-two",
        recordNavigation: false,
      });
      expect(store.selectedRepoId).toBe("repo-1");
      expect(store.selectedItemId).toBe("task-one");
    } finally {
      firstRepoSelection.resolve();
      scope.stop();
    }
  });

  it("keeps a selected remote task when its hidden local repo rekeys to cloud", async () => {
    const presentationSlotId = "remote:stable-task";
    const remoteTaskId = "cloud:desktop-1:repo-remote:task-1";
    const oldRepoKey = "repo-local";
    const cloudRepoKey = "cloud:desktop-1:repo-remote";
    const projectedItem = {
      ...sidebarTask(presentationSlotId, cloudRepoKey),
      task_id: remoteTaskId,
    };
    const selectedCloudRepoId = ref<string | null>(oldRepoKey);
    const selectedCloudItemId = ref<string | null>(presentationSlotId);
    const task = ref({
      repoKey: oldRepoKey,
      item: { id: remoteTaskId },
      localTaskId: null,
      owner: { kind: "remote", id: "desktop-1" },
    } as WorkspaceTask);
    const persistSelection = vi.fn(async () => {});
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: null as string | null,
      selectedItemId: presentationSlotId as string | null,
      lastSelectedItemByRepo: { [oldRepoKey]: presentationSlotId } as Record<string, string>,
      items: [],
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      selectRepo: vi.fn(async () => {}),
      selectItem: vi.fn(async () => {}),
    });

    const scope = effectScope();
    scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => []),
      sidebarItems: computed(() => [projectedItem]),
      workspaceTasksByItemId: computed(() => new Map([
        [presentationSlotId, task.value],
        [remoteTaskId, task.value],
      ])),
      selectedCloudRepoId,
      selectedCloudItemId,
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));

    try {
      task.value = { ...task.value, repoKey: cloudRepoKey };
      await nextTick();

      expect(selectedCloudRepoId.value).toBe(cloudRepoKey);
      expect(selectedCloudItemId.value).toBe(presentationSlotId);
      expect(store.selectedRepoId).toBe(cloudRepoKey);
      expect(store.selectedItemId).toBe(presentationSlotId);
      expect(store.lastSelectedItemByRepo).toEqual({
        [cloudRepoKey]: presentationSlotId,
      });
      expect(persistSelection).toHaveBeenCalledWith({
        selectedRepoId: cloudRepoKey,
        selectedItemId: remoteTaskId,
      });
    } finally {
      scope.stop();
    }
  });

  it("records a remote all-repos target and routes Back and Forward across owners", async () => {
    const localItem = sidebarTask("slot:local", "repo-local");
    const remoteItem = {
      ...sidebarTask("slot:remote", "cloud:repo-remote"),
      task_id: "cloud-task-remote",
      activity: "unread" as const,
      created_at: "2026-07-13T00:00:00.000Z",
    };
    const selectedCloudRepoId = ref<string | null>(null);
    const selectedCloudItemId = ref<string | null>(null);
    const recordNavigation = vi.fn();
    const takeBackTarget = vi.fn(() => localItem.slot_id);
    const takeForwardTarget = vi.fn(() => remoteItem.slot_id);
    const items = [localItem, remoteItem];
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: localItem.repo_id,
      selectedItemId: localItem.slot_id as string | null,
      lastSelectedItemByRepo: {
        [localItem.repo_id]: localItem.slot_id,
      } as Record<string, string>,
      items: [{ ...localItem, id: localItem.task_id }],
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      recordNavigation,
      takeBackTarget,
      takeForwardTarget,
      selectRepo: vi.fn(async (repoId: string) => {
        store.selectedRepoId = repoId;
        store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
      }),
      selectItem: vi.fn(async (itemId: string) => {
        store.selectedRepoId = localItem.repo_id;
        store.selectedItemId = itemId;
        store.lastSelectedItemByRepo[localItem.repo_id] = itemId;
      }),
    });
    const remoteWorkspaceTask = {
      repoKey: remoteItem.repo_id,
      item: { id: remoteItem.task_id },
      localTaskId: null,
      owner: { kind: "remote", desktopId: "desktop-remote" },
    } as unknown as WorkspaceTask;

    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => [
        { id: localItem.repo_id },
        { id: remoteItem.repo_id },
      ] as never),
      sidebarItems: computed(() => items),
      workspaceTasksByItemId: computed(() => new Map([
        [remoteItem.slot_id, remoteWorkspaceTask],
        [remoteItem.task_id, remoteWorkspaceTask],
      ])),
      selectedCloudRepoId,
      selectedCloudItemId,
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      await navigation.selectUnreadTaskWithReadFallback("allRepos");

      expect(recordNavigation).toHaveBeenCalledWith(remoteItem.slot_id, localItem.slot_id);
      expect(selectedCloudItemId.value).toBe(remoteItem.slot_id);
      expect(store.selectedRepoId).toBe(remoteItem.repo_id);

      await navigation.navigateBack();

      expect(takeBackTarget).toHaveBeenCalledWith(
        remoteItem.slot_id,
        new Set([localItem.slot_id, remoteItem.slot_id]),
      );
      expect(store.selectedRepoId).toBe(localItem.repo_id);
      expect(store.selectedItemId).toBe(localItem.slot_id);

      await navigation.navigateForward();

      expect(takeForwardTarget).toHaveBeenCalledWith(
        localItem.slot_id,
        new Set([localItem.slot_id, remoteItem.slot_id]),
      );
      expect(selectedCloudItemId.value).toBe(remoteItem.slot_id);
      expect(recordNavigation).toHaveBeenCalledTimes(1);
    } finally {
      scope.stop();
    }
  });

  it("does not overwrite a remote task selection when its repo has a local key", async () => {
    const repoPersistence = deferred();
    const localItem = sidebarTask("slot:local", "repo-local");
    const remoteItem = {
      ...sidebarTask("slot:remote", "repo-mixed"),
      task_id: "remote-task-durable",
      activity: "unread" as const,
      created_at: "2026-07-13T00:00:00.000Z",
    };
    const persistSelection = vi.fn(async () => {});
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: localItem.repo_id,
      selectedItemId: localItem.slot_id as string | null,
      lastSelectedItemByRepo: {
        [localItem.repo_id]: localItem.slot_id,
      } as Record<string, string>,
      items: [{ ...localItem, id: localItem.task_id }],
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      recordNavigation: vi.fn(),
      takeBackTarget: vi.fn(),
      takeForwardTarget: vi.fn(),
      selectItem: vi.fn(async () => {}),
    });
    const selectRepo = vi.fn(async (
      repoId: string,
      options?: { persistWindowSelection?: boolean },
    ) => {
      store.selectedRepoId = repoId;
      store.selectedItemId = null;
      await repoPersistence.promise;
      if (options?.persistWindowSelection !== false) {
        await persistSelection({
          selectedRepoId: repoId,
          selectedItemId: null,
        });
      }
    });
    Object.assign(store, { selectRepo });
    const remoteWorkspaceTask = {
      repoKey: remoteItem.repo_id,
      item: { id: remoteItem.task_id },
      localTaskId: null,
      owner: { kind: "remote", desktopId: "desktop-remote" },
    } as unknown as WorkspaceTask;

    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => [
        { id: localItem.repo_id },
        { id: remoteItem.repo_id },
      ] as never),
      sidebarItems: computed(() => [localItem, remoteItem]),
      workspaceTasksByItemId: computed(() => new Map([
        [remoteItem.slot_id, remoteWorkspaceTask],
        [remoteItem.task_id, remoteWorkspaceTask],
      ])),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      const switching = navigation.selectUnreadTaskWithReadFallback("allRepos");
      await vi.waitFor(() => expect(persistSelection).toHaveBeenCalledWith({
        selectedRepoId: remoteItem.repo_id,
        selectedItemId: remoteItem.task_id,
      }));
      repoPersistence.resolve();
      await switching;

      expect(selectRepo).toHaveBeenCalledWith(remoteItem.repo_id, {
        persistWindowSelection: false,
      });
      expect(persistSelection).toHaveBeenCalledTimes(1);
    } finally {
      repoPersistence.resolve();
      scope.stop();
    }
  });

  it("records repo-arrow navigation before persistence so Back can cancel it", async () => {
    vi.useFakeTimers();
    const repoPersistence = deferred();
    const items = [sidebarTask("task-one", "repo-1"), sidebarTask("task-two", "repo-2")];
    const history = createNavigationHistory();
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: "repo-1",
      selectedItemId: "task-one" as string | null,
      lastSelectedItemByRepo: {
        "repo-1": "task-one",
        "repo-2": "task-two",
      } as Record<string, string>,
      items: items.map((item) => ({ ...item, id: item.task_id })),
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      recordNavigation: (newItemId: string, previousItemId: string | null) =>
        history.select(newItemId, previousItemId),
      takeBackTarget: (currentItemId: string, validItemIds?: Set<string>) =>
        history.goBack(currentItemId, validItemIds),
      takeForwardTarget: (currentItemId: string, validItemIds?: Set<string>) =>
        history.goForward(currentItemId, validItemIds),
    });
    const selectRepo = vi.fn(async (repoId: string) => {
      store.selectedRepoId = repoId;
      store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
      if (repoId === "repo-2") await repoPersistence.promise;
    });
    const selectItem = vi.fn(async (itemId: string) => {
      const item = items.find((candidate) => candidate.slot_id === itemId);
      if (!item) return;
      store.selectedRepoId = item.repo_id;
      store.selectedItemId = item.slot_id;
      store.lastSelectedItemByRepo[item.repo_id] = item.slot_id;
    });
    Object.assign(store, { selectRepo, selectItem });

    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => [
        { id: "repo-1" },
        { id: "repo-2" },
      ] as never),
      sidebarItems: computed(() => items),
      workspaceTasksByItemId: computed(() => new Map()),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      await vi.advanceTimersByTimeAsync(1001);
      const repoNavigation = navigation.navigateRepos(1);
      await Promise.resolve();

      await navigation.navigateBack();
      expect(store.selectedRepoId).toBe("repo-1");
      expect(store.selectedItemId).toBe("task-one");

      repoPersistence.resolve();
      await repoNavigation;
    } finally {
      repoPersistence.resolve();
      scope.stop();
      vi.useRealTimers();
    }
  });

  it("records a cross-repo transition before persistence so Back can cancel it", async () => {
    vi.useFakeTimers();
    const firstRepoSelection = deferred();
    const items = [sidebarTask("task-one", "repo-1"), sidebarTask("task-two", "repo-2")];
    const history = createNavigationHistory();
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: "repo-1",
      selectedItemId: "task-one" as string | null,
      lastSelectedItemByRepo: {
        "repo-1": "task-one",
        "repo-2": "task-two",
      } as Record<string, string>,
      items: items.map((item) => ({ ...item, id: item.task_id })),
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      recordNavigation: (newItemId: string, previousItemId: string | null) =>
        history.select(newItemId, previousItemId),
      takeBackTarget: (currentItemId: string, validItemIds?: Set<string>) =>
        history.goBack(currentItemId, validItemIds),
      takeForwardTarget: (currentItemId: string, validItemIds?: Set<string>) =>
        history.goForward(currentItemId, validItemIds),
    });
    let repoSelectionCount = 0;
    const selectRepo = vi.fn(async (repoId: string) => {
      repoSelectionCount += 1;
      store.selectedRepoId = repoId;
      store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
      if (repoSelectionCount === 1) await firstRepoSelection.promise;
    });
    const selectItem = vi.fn(async (itemId: string) => {
      store.selectedItemId = itemId;
      store.selectedRepoId = items.find((item) => item.slot_id === itemId)?.repo_id ?? store.selectedRepoId;
    });
    Object.assign(store, { selectRepo, selectItem });

    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => [
        { id: "repo-1" },
        { id: "repo-2" },
      ] as never),
      sidebarItems: computed(() => items),
      workspaceTasksByItemId: computed(() => new Map()),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      await vi.advanceTimersByTimeAsync(1001);
      const olderNavigation = navigation.navigateItems(1);
      expect(selectRepo).toHaveBeenCalledWith("repo-2", {
        persistWindowSelection: false,
      });

      await navigation.navigateBack();
      expect(store.selectedRepoId).toBe("repo-1");
      expect(store.selectedItemId).toBe("task-one");

      firstRepoSelection.resolve();
      await olderNavigation;

      expect(selectItem).toHaveBeenCalledTimes(2);
      expect(selectItem).toHaveBeenNthCalledWith(1, "task-two", expect.objectContaining({
        previousItemId: "task-one",
      }));
      expect(selectItem).toHaveBeenNthCalledWith(2, "task-one", expect.objectContaining({
        previousItemId: "task-two",
      }));
    } finally {
      firstRepoSelection.resolve();
      scope.stop();
      vi.useRealTimers();
    }
  });

  it("applies a cross-repo Back target before persistence so Forward remains coherent", async () => {
    vi.useFakeTimers();
    const backRepoPersistence = deferred();
    const items = [sidebarTask("task-one", "repo-1"), sidebarTask("task-two", "repo-2")];
    const history = createNavigationHistory();
    const store = reactive({
      recordSelectionIntent: vi.fn(),
      selectedRepoId: "repo-2",
      selectedItemId: "task-two" as string | null,
      lastSelectedItemByRepo: {
        "repo-2": "task-two",
      } as Record<string, string>,
      items: items.map((item) => ({ ...item, id: item.task_id })),
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      recordNavigation: (newItemId: string, previousItemId: string | null) =>
        history.select(newItemId, previousItemId),
      takeBackTarget: (currentItemId: string, validItemIds?: Set<string>) =>
        history.goBack(currentItemId, validItemIds),
      takeForwardTarget: (currentItemId: string, validItemIds?: Set<string>) =>
        history.goForward(currentItemId, validItemIds),
    });
    const selectRepo = vi.fn(async (repoId: string) => {
      store.selectedRepoId = repoId;
      store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
      if (repoId === "repo-1") await backRepoPersistence.promise;
    });
    const selectItem = vi.fn(async (itemId: string) => {
      const item = items.find((candidate) => candidate.slot_id === itemId);
      if (!item) return;
      store.selectedRepoId = item.repo_id;
      store.selectedItemId = item.slot_id;
      store.lastSelectedItemByRepo[item.repo_id] = item.slot_id;
    });
    Object.assign(store, { selectRepo, selectItem });

    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => [
        { id: "repo-1" },
        { id: "repo-2" },
      ] as never),
      sidebarItems: computed(() => items),
      workspaceTasksByItemId: computed(() => new Map()),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog: ref(null),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      await vi.advanceTimersByTimeAsync(1001);
      history.select("task-two", "task-one");

      const olderBack = navigation.navigateBack();
      expect(store.selectedRepoId).toBe("repo-1");
      expect(store.selectedItemId).toBe("task-one");

      await navigation.navigateForward();
      expect(store.selectedRepoId).toBe("repo-2");
      expect(store.selectedItemId).toBe("task-two");

      backRepoPersistence.resolve();
      await olderBack;
      expect(store.selectedRepoId).toBe("repo-2");
      expect(store.selectedItemId).toBe("task-two");

      await navigation.navigateBack();
      expect(store.selectedRepoId).toBe("repo-1");
      expect(store.selectedItemId).toBe("task-one");
    } finally {
      backRepoPersistence.resolve();
      scope.stop();
      vi.useRealTimers();
    }
  });

  it("preserves distinct server command IDs when custom commands share a label", () => {
    const store = reactive({
      selectedRepoId: "repo-1",
      selectedItemId: null,
      lastSelectedItemByRepo: {},
      items: [],
      sortedItemsForCurrentRepo: [],
      sortedItemsAllRepos: [],
      taskBlockers: [],
      currentItem: null,
      getStageOrder: () => 0,
      listBlockedByItem: vi.fn(async () => []),
      listBlockersForItem: vi.fn(async () => []),
      blockTask: vi.fn(async () => {}),
      editBlockedTask: vi.fn(async () => {}),
      loadAgent: vi.fn(),
      createItem: vi.fn(),
      selectRepo: vi.fn(async () => {}),
      selectItem: vi.fn(async () => {}),
      reloadSnapshot: vi.fn(async () => {}),
      recordNavigation: vi.fn(),
      takeBackTarget: vi.fn(),
      takeForwardTarget: vi.fn(),
    });
    const repoCommandCatalog = ref({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [
        {
          id: "custom:deploy-staging:stable-a1",
          label: "Deploy",
          description: "Deploy staging",
          group: "automation" as const,
        },
        {
          id: "custom:deploy-production:stable-b2",
          label: "Deploy",
          description: "Deploy production",
          group: "automation" as const,
        },
      ],
    });
    const scope = effectScope();
    const navigation = scope.run(() => useAppTaskNavigation({
      store: store as never,
      toast: { error: vi.fn() } as never,
      t: (key) => key,
      windowWorkspace: { persistSelection: vi.fn(async () => {}) } as never,
      sidebarRef: ref(null),
      sidebarRepos: computed(() => []),
      sidebarItems: computed(() => []),
      workspaceTasksByItemId: computed(() => new Map()),
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
      showBlockerSelect: ref(false),
      blockerSelectMode: ref("block"),
      repoCommandCatalog,
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      expect(
        navigation.paletteDynamicCommands.value
          .filter((command) => command.label === "Deploy")
          .map((command) => command.id),
      ).toEqual([
        "custom:deploy-staging:stable-a1",
        "custom:deploy-production:stable-b2",
      ]);
    } finally {
      scope.stop();
    }
  });
});
