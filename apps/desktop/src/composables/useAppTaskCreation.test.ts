import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppTaskCreation } from "./useAppTaskCreation";
import { updateDesktopServerClientHandlersForTests } from "../services/desktopServerClient";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

function createTaskCreationHarness() {
  const showNewTaskModal = ref(true);
  const onAgentChoiceUsed = vi.fn(async () => {});
  const selectedCloudRepoId = ref<string | null>(null);
  const selectedCloudItemId = ref<string | null>(null);
  const store = {
    selectedRepoId: "repo-1",
    selectedItemId: null as string | null,
    repos: [{ id: "repo-1", path: "/repo" }],
    items: [],
    taskUiSlots: [],
    lastSelectedItemByRepo: {} as Record<string, string>,
    persistSelection: vi.fn(async () => {}),
    createItem: vi.fn(async () => {}),
    createRepo: vi.fn(async () => "repo-1"),
    importRepo: vi.fn(async () => "repo-1"),
    cloneAndImportRepo: vi.fn(async () => {}),
    loadAgent: vi.fn(async () => ({
      prompt: "Configure the GitHub flow by composing stock flavors.",
      agent_provider: ["codex", "claude"],
      model: undefined,
      permission_mode: "default",
      allowed_tools: undefined,
    })),
  };

  const creation = useAppTaskCreation({
    store: store as never,
    toast: { warning: vi.fn(), error: vi.fn() } as never,
    t: (key: string) => key,
    sidebarRepos: computed(() => [{ id: "repo-1" }]),
    remoteSnapshot: computed(() => ({ repos: [], items: [] }) as never),
    mainPanelIsCloudTask: computed(() => false),
    selectedCloudRepoId,
    selectedCloudItemId,
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

  return {
    creation,
    store,
    showNewTaskModal,
    onAgentChoiceUsed,
    selectedCloudRepoId,
    selectedCloudItemId,
  };
}

describe("useAppTaskCreation", () => {
  beforeEach(() => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoAgentProviders: async () => ["claude", "copilot", "codex", "opencode", "antigravity"],
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_dir") return [];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["origin/main"];
      return "";
    });
  });

  it("loads executable availability through the repo-scoped server resolver", async () => {
    const fetchRepoAgentProviders = vi.fn(async (): Promise<["opencode"]> => ["opencode"]);
    updateDesktopServerClientHandlersForTests({ fetchRepoAgentProviders });
    const { creation } = createTaskCreationHarness();

    await creation.openNewTaskModal();

    expect(fetchRepoAgentProviders).toHaveBeenCalledWith("repo-1");
    expect(creation.availableAgentProviders.value).toEqual(["opencode"]);
  });

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

  it("clears remote selection ownership before creating in an existing local repo", async () => {
    const {
      creation,
      store,
      selectedCloudRepoId,
      selectedCloudItemId,
    } = createTaskCreationHarness();
    selectedCloudRepoId.value = "repo-1";
    selectedCloudItemId.value = "cloud:repo-1:task-remote";

    await creation.handleNewTaskSubmit("Create locally", "claude", "default", "origin/main", "pty");

    expect(selectedCloudRepoId.value).toBeNull();
    expect(selectedCloudItemId.value).toBeNull();
    expect(store.createItem).toHaveBeenCalled();
  });

  it("keeps a durable selection owned by a noncanonical local task slot", async () => {
    const {
      creation,
      store,
      selectedCloudRepoId,
      selectedCloudItemId,
    } = createTaskCreationHarness();
    store.selectedItemId = "task-local";
    store.lastSelectedItemByRepo = { "repo-1": "task-local" };
    store.taskUiSlots = [{
      slot_id: "create:stable-local",
      task_id: "task-local",
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
      draft: {
        repo_id: "repo-1",
        prompt: "Create locally",
        display_name: null,
        pipeline: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-07-14T00:00:00.000Z",
      },
    }] as never;
    selectedCloudRepoId.value = "cloud:repo-1";
    selectedCloudItemId.value = "cloud:repo-1:task-remote";

    await creation.handleNewTaskSubmit("Create locally", "claude", "default", "origin/main", "pty");

    expect(store.selectedItemId).toBe("task-local");
    expect(store.lastSelectedItemByRepo).toEqual({ "repo-1": "task-local" });
    expect(selectedCloudRepoId.value).toBeNull();
    expect(selectedCloudItemId.value).toBeNull();
  });

  it("does not reopen the new task modal before recording the submitted agent choice", async () => {
    let finishRecordingChoice: (() => void) | undefined;
    const { creation, showNewTaskModal, onAgentChoiceUsed } = createTaskCreationHarness();
    onAgentChoiceUsed.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRecordingChoice = resolve;
    }));

    const submitPromise = creation.handleNewTaskSubmit(
      "Ship MRU",
      "copilot",
      "default",
      "origin/main",
      "pty",
    );
    await Promise.resolve();
    await Promise.resolve();

    invokeMock.mockClear();
    const openPromise = creation.openNewTaskModal();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(showNewTaskModal.value).toBe(false);

    finishRecordingChoice?.();
    await submitPromise;
    await openPromise;

    expect(showNewTaskModal.value).toBe(true);
  });

  it("launches the setup agent after importing a repository", async () => {
    const { creation, store } = createTaskCreationHarness();

    await creation.handleImportRepo("/repo", "repo", "main");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "main");
    expect(store.loadAgent).toHaveBeenCalledWith("/repo", "setup");
    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/repo",
      "Set up Kanna for this repository.",
      "pty",
      expect.objectContaining({
        customTask: expect.objectContaining({
          name: "Set Up Repository",
          agent: "setup",
          prompt: "Set up Kanna for this repository.",
        }),
      }),
    );
    expect(store.createItem.mock.calls[0]?.[4]).not.toHaveProperty("agentProvider");
  });
});
