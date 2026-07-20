import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppTaskCreation } from "./useAppTaskCreation";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTaskCreationHarness() {
  const showNewTaskModal = ref(false);
  const availablePipelines = ref<string[]>([]);
  const defaultPipelineName = ref<string | undefined>(undefined);
  const availableBaseBranches = ref<string[]>([]);
  const defaultBaseBranchName = ref<string | undefined>(undefined);
  const repoDefaultBranchName = ref<string | undefined>(undefined);
  const onAgentChoiceUsed = vi.fn(async () => {});
  const selectedCloudRepoId = ref<string | null>(null);
  const selectedCloudItemId = ref<string | null>(null);
  const toast = { warning: vi.fn(), error: vi.fn() };
  const store = {
    selectedRepoId: "repo-1",
    selectedItemId: null as string | null,
    currentItem: null as { id: string } | null,
    repos: [{ id: "repo-1", path: "/repo" }],
    items: [],
    taskBlockers: [] as Array<{ blocked_item_id: string; blocker_item_id: string }>,
    blockerTaskStates: {} as Record<string, { closed_at: string | null; stage: string; pr_url: string | null }>,
    taskUiSlots: [],
    lastSelectedItemByRepo: {} as Record<string, string>,
    persistSelection: vi.fn(async () => {}),
    createItem: vi.fn(async () => {}),
    createRepo: vi.fn(async () => "repo-1"),
    importRepo: vi.fn(async () => "repo-1"),
    cloneAndImportRepo: vi.fn(async () => {}),
    listBlockersForItem: vi.fn(async () => []),
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
    toast: toast as never,
    t: (key: string) => key,
    sidebarRepos: computed(() => [{ id: "repo-1" }]),
    remoteSnapshot: computed(() => ({ repos: [], items: [] }) as never),
    mainPanelIsCloudTask: computed(() => false),
    selectedCloudRepoId,
    selectedCloudItemId,
    showNewTaskModal,
    availablePipelines,
    defaultPipelineName,
    availableBaseBranches,
    defaultBaseBranchName,
    repoDefaultBranchName,
    showAddRepoModal: ref(false),
    isCloudOnlyRepoId: () => false,
    cloudRepoRemoteUrl: () => null,
    onAgentChoiceUsed,
  });

  return {
    creation,
    store,
    showNewTaskModal,
    availablePipelines,
    defaultPipelineName,
    availableBaseBranches,
    defaultBaseBranchName,
    repoDefaultBranchName,
    onAgentChoiceUsed,
    selectedCloudRepoId,
    selectedCloudItemId,
    toast,
  };
}

describe("useAppTaskCreation", () => {
  beforeEach(() => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultPipeline: "default",
        pipelines: ["default"],
      }),
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

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
  });

  it("shows New Task before repository options finish loading", async () => {
    const definitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultPipeline: string;
      pipelines: string[];
    }>();
    const providers = deferred<[]>();
    const defaultBranch = deferred<string>();
    const baseBranches = deferred<string[]>();
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: () => definitions.promise,
      fetchRepoAgentProviders: () => providers.promise,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_default_branch") return defaultBranch.promise;
      if (command === "git_list_base_branches") return baseBranches.promise;
      return Promise.resolve("");
    });
    const { creation, showNewTaskModal } = createTaskCreationHarness();

    const openPromise = creation.openNewTaskModal();

    expect(showNewTaskModal.value).toBe(true);
    expect(creation.newTaskOptionsLoading.value).toBe(true);

    definitions.resolve({
      revision: "remote-rev",
      refName: "origin/main",
      config: {},
      defaultPipeline: "default",
      pipelines: ["default"],
    });
    providers.resolve([]);
    defaultBranch.resolve("main");
    baseBranches.resolve(["origin/main"]);
    await openPromise;
  });

  it("discards option results from a superseded repository load", async () => {
    const definitions = {
      "repo-1": deferred<{
        revision: string;
        refName: string;
        config: Record<string, never>;
        defaultPipeline: string;
        pipelines: string[];
      }>(),
      "repo-2": deferred<{
        revision: string;
        refName: string;
        config: Record<string, never>;
        defaultPipeline: string;
        pipelines: string[];
      }>(),
    };
    const providers = {
      "repo-1": deferred<[]>(),
      "repo-2": deferred<["codex"]>(),
    };
    const defaultBranches = {
      "/repo": deferred<string>(),
      "/repo-2": deferred<string>(),
    };
    const baseBranches = {
      "/repo": deferred<string[]>(),
      "/repo-2": deferred<string[]>(),
    };
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: (repoId) => definitions[repoId as keyof typeof definitions].promise,
      fetchRepoAgentProviders: (repoId) => providers[repoId as keyof typeof providers].promise,
    });
    invokeMock.mockImplementation((command: string, args: { repoPath: keyof typeof defaultBranches }) => {
      if (command === "git_default_branch") return defaultBranches[args.repoPath].promise;
      if (command === "git_list_base_branches") return baseBranches[args.repoPath].promise;
      return Promise.resolve("");
    });
    const {
      creation,
      store,
      availablePipelines,
      defaultPipelineName,
      availableBaseBranches,
    } = createTaskCreationHarness();
    store.repos.push({ id: "repo-2", path: "/repo-2" });

    const firstOpen = creation.openNewTaskModal("repo-1");
    const secondOpen = creation.openNewTaskModal("repo-2");

    definitions["repo-2"].resolve({
      revision: "repo-2-rev",
      refName: "origin/trunk",
      config: {},
      defaultPipeline: "review",
      pipelines: ["default", "review"],
    });
    providers["repo-2"].resolve(["codex"]);
    defaultBranches["/repo-2"].resolve("trunk");
    baseBranches["/repo-2"].resolve(["origin/trunk"]);
    await secondOpen;

    definitions["repo-1"].resolve({
      revision: "repo-1-rev",
      refName: "origin/main",
      config: {},
      defaultPipeline: "default",
      pipelines: ["default"],
    });
    providers["repo-1"].resolve([]);
    defaultBranches["/repo"].resolve("main");
    baseBranches["/repo"].resolve(["origin/main"]);
    await firstOpen;

    expect(availablePipelines.value).toEqual(["default", "review"]);
    expect(defaultPipelineName.value).toBe("review");
    expect(availableBaseBranches.value).toEqual(["origin/trunk"]);
    expect(creation.availableAgentProviders.value).toEqual(["codex"]);
    expect(creation.newTaskOptionsLoading.value).toBe(false);
  });

  it("does not report definition errors from a superseded repository load", async () => {
    const oldDefinitions = deferred<never>();
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: (repoId) =>
        repoId === "repo-1"
          ? oldDefinitions.promise
          : Promise.resolve({
              revision: "repo-2-rev",
              refName: "origin/main",
              config: {},
              defaultPipeline: "default",
              pipelines: ["default"],
            }),
    });
    const { creation, store, toast } = createTaskCreationHarness();
    store.repos.push({ id: "repo-2", path: "/repo-2" });

    const firstOpen = creation.openNewTaskModal("repo-1");
    await creation.openNewTaskModal("repo-2");
    oldDefinitions.reject(new Error("stale repo unavailable"));
    await firstOpen;

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("loads pipeline choices and the default from the repo definitions manifest", async () => {
    const fetchRepoKannaDefinitions = vi.fn(async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config: { pipeline: "remote-qa" },
      defaultPipeline: "remote-qa",
      pipelines: ["default", "remote-qa"],
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const { creation, availablePipelines, defaultPipelineName } = createTaskCreationHarness();

    await creation.openNewTaskModal();

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(availablePipelines.value).toEqual(["default", "remote-qa"]);
    expect(defaultPipelineName.value).toBe("remote-qa");
    expect(invokeMock).not.toHaveBeenCalledWith("list_dir", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("read_text_file", expect.anything());
  });

  it("shows a definition error and opens a usable modal without local fallback", async () => {
    const error = new Error("remote definitions unavailable");
    const fetchRepoAgentProviders = vi.fn(async (): Promise<["claude"]> => ["claude"]);
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => {
        throw error;
      },
      fetchRepoAgentProviders,
    });
    const {
      creation,
      showNewTaskModal,
      availablePipelines,
      defaultPipelineName,
      toast,
    } = createTaskCreationHarness();

    await expect(creation.openNewTaskModal()).resolves.toBeUndefined();

    expect(toast.error).toHaveBeenCalledWith(
      "toasts.repoDefinitionsFailed: remote definitions unavailable",
    );
    expect(showNewTaskModal.value).toBe(true);
    expect(availablePipelines.value).toEqual([]);
    expect(defaultPipelineName.value).toBeUndefined();
    expect(fetchRepoAgentProviders).toHaveBeenCalledWith("repo-1");
    expect(creation.availableAgentProviders.value).toEqual(["claude"]);
    expect(invokeMock).toHaveBeenCalledWith("git_default_branch", { repoPath: "/repo" });
    expect(invokeMock).toHaveBeenCalledWith("git_list_base_branches", { repoPath: "/repo" });
    expect(invokeMock).not.toHaveBeenCalledWith("list_dir", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("read_text_file", expect.anything());
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

  it("classifies a task as blocked from hidden blocker state", () => {
    const { creation, store } = createTaskCreationHarness();
    store.currentItem = { id: "task-dependent" };
    store.taskBlockers = [{
      blocked_item_id: "task-dependent",
      blocker_item_id: "task-hidden",
    }];
    store.blockerTaskStates = {
      "task-hidden": {
        closed_at: null,
        stage: "review",
        pr_url: null,
      },
    };

    expect(creation.currentTaskIsBlocked.value).toBe(true);
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

  it("reopens New Task while the previous submission finishes", async () => {
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

    expect(invokeMock).toHaveBeenCalledWith("git_default_branch", { repoPath: "/repo" });
    expect(showNewTaskModal.value).toBe(true);
    expect(creation.newTaskSubmissionPending.value).toBe(true);

    finishRecordingChoice?.();
    await submitPromise;
    await openPromise;

    expect(showNewTaskModal.value).toBe(true);
    expect(creation.newTaskSubmissionPending.value).toBe(false);
  });

  it("launches the setup agent after importing a repository", async () => {
    const { creation, store } = createTaskCreationHarness();

    await creation.handleImportRepo("/repo", "repo", "main");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "main");
    expect(store.loadAgent).toHaveBeenCalledWith("repo-1", "setup");
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
