import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { useAppTaskCreation } from "./useAppTaskCreation";

vi.mock("../invoke", () => ({
  invoke: vi.fn(),
}));

function createTaskCreationHarness() {
  const showNewTaskModal = ref(true);
  const onAgentChoiceUsed = vi.fn(async () => {});
  const store = {
    selectedRepoId: "repo-1",
    repos: [{ id: "repo-1", path: "/repo" }],
    createItem: vi.fn(async () => {}),
    cloneAndImportRepo: vi.fn(async () => {}),
  };

  const creation = useAppTaskCreation({
    store: store as never,
    toast: { warning: vi.fn(), error: vi.fn() } as never,
    t: (key: string) => key,
    sidebarRepos: computed(() => [{ id: "repo-1" }]),
    remoteSnapshot: computed(() => ({ repos: [], items: [] }) as never),
    mainPanelIsCloudTask: computed(() => false),
    selectedCloudRepoId: ref(null),
    selectedCloudItemId: ref(null),
    showNewTaskModal,
    availablePipelines: ref([]),
    defaultPipelineName: ref(undefined),
    availableBaseBranches: ref([]),
    defaultBaseBranchName: ref(undefined),
    repoDefaultBranchName: ref(undefined),
    showAddRepoModal: ref(false),
    isCloudOnlyRepoId: () => false,
    cloudRepoRemoteUrl: () => null,
    onAgentChoiceUsed,
  });

  return { creation, store, showNewTaskModal, onAgentChoiceUsed };
}

describe("useAppTaskCreation", () => {
  it("records the exact agent choice after a task is created", async () => {
    const { creation, onAgentChoiceUsed } = createTaskCreationHarness();

    await creation.handleNewTaskSubmit("Ship MRU", "codex", "default", "origin/main", "agent");

    expect(onAgentChoiceUsed).toHaveBeenCalledWith({ provider: "codex", executionType: "agent" });
  });

  it("does not record agent choice usage when task creation fails", async () => {
    const { creation, store, onAgentChoiceUsed } = createTaskCreationHarness();
    store.createItem.mockRejectedValueOnce(new Error("nope"));

    await creation.handleNewTaskSubmit("Ship MRU", "copilot", "default", "origin/main", "pty");

    expect(onAgentChoiceUsed).not.toHaveBeenCalled();
  });
});
