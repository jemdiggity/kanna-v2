import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { claimLocalTaskSelectionOwnership } from "./localTaskSelectionOwnership";

function createStore(input: {
  selectedItemId: string;
  slots?: Array<{ slotId: string; taskId: string | null; repoId: string }>;
  items?: Array<{ id: string; repo_id: string }>;
}) {
  return {
    selectedRepoId: "repo-other",
    selectedItemId: input.selectedItemId as string | null,
    lastSelectedItemByRepo: { "repo-1": input.selectedItemId } as Record<string, string>,
    taskUiSlots: (input.slots ?? []).map((slot) => ({
      slot_id: slot.slotId,
      task_id: slot.taskId,
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 0,
      draft: { repo_id: slot.repoId },
    })),
    items: input.items ?? [],
    persistSelection: vi.fn(async () => {}),
  };
}

describe("claimLocalTaskSelectionOwnership", () => {
  it("gives a selected creating slot ownership over stale cloud state", () => {
    const store = createStore({
      selectedItemId: "create:task",
      slots: [{ slotId: "create:task", taskId: null, repoId: "repo-1" }],
    });
    const selectedCloudRepoId = ref<string | null>("cloud:repo-1");
    const selectedCloudItemId = ref<string | null>("cloud:task");

    claimLocalTaskSelectionOwnership({
      store: store as never,
      repoId: "repo-1",
      selectedCloudRepoId,
      selectedCloudItemId,
    });

    expect(store.selectedItemId).toBe("create:task");
    expect(store.selectedRepoId).toBe("repo-1");
    expect(selectedCloudRepoId.value).toBeNull();
    expect(selectedCloudItemId.value).toBeNull();
    expect(store.persistSelection).toHaveBeenCalledTimes(1);
  });

  it("keeps ownership after a slot acknowledges its durable task id", () => {
    const store = createStore({
      selectedItemId: "task-durable",
      slots: [{ slotId: "create:task", taskId: "task-durable", repoId: "repo-1" }],
    });

    claimLocalTaskSelectionOwnership({
      store: store as never,
      repoId: "repo-1",
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
    });

    expect(store.selectedItemId).toBe("task-durable");
    expect(store.persistSelection).not.toHaveBeenCalled();
  });

  it("recognizes a hydrated local task when no slot is present", () => {
    const store = createStore({
      selectedItemId: "task-durable",
      items: [{ id: "task-durable", repo_id: "repo-1" }],
    });

    claimLocalTaskSelectionOwnership({
      store: store as never,
      repoId: "repo-1",
      selectedCloudRepoId: ref(null),
      selectedCloudItemId: ref(null),
    });

    expect(store.selectedItemId).toBe("task-durable");
    expect(store.persistSelection).not.toHaveBeenCalled();
  });

  it("does not claim a remote workspace projection as local", () => {
    const store = createStore({ selectedItemId: "remote:task" });

    claimLocalTaskSelectionOwnership({
      store: store as never,
      repoId: "repo-1",
      selectedCloudRepoId: ref("cloud:repo-1"),
      selectedCloudItemId: ref("remote:task"),
    });

    expect(store.selectedItemId).toBeNull();
    expect(store.lastSelectedItemByRepo).toEqual({});
    expect(store.persistSelection).toHaveBeenCalledTimes(1);
  });
});
