import { computed, effectScope, nextTick, reactive, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import type { SidebarTaskItem } from "../types/taskUi";
import type { WorkspaceTask } from "../workspace/types";
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
    pipeline: "default",
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
  it("does not let an older cross-repo navigation overwrite a newer intent", async () => {
    const firstRepoSelection = deferred();
    const items = [sidebarTask("task-one", "repo-1"), sidebarTask("task-two", "repo-2")];
    const store = reactive({
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
      customTasks: ref([]),
      openPeerPicker: vi.fn(),
      openPairPeerPicker: vi.fn(),
    }));
    if (!navigation) throw new Error("navigation composable did not initialize");

    try {
      const olderNavigation = navigation.navigateItems(1);
      await vi.waitFor(() => expect(selectRepo).toHaveBeenCalledWith("repo-2"));

      await navigation.navigateItems(-1);
      expect(store.selectedItemId).toBe("task-one");

      firstRepoSelection.resolve();
      await olderNavigation;

      expect(selectItem).toHaveBeenCalledTimes(1);
      expect(selectItem).toHaveBeenCalledWith("task-one", { previousItemId: "task-two" });
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
      customTasks: ref([]),
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
});
