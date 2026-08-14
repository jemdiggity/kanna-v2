import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppTaskCreation } from "./useAppTaskCreation";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import type { DesktopCloudSnapshot } from "../services/desktopCloudTaskIndex";

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
  const availableWorkflows = ref<string[]>([]);
  const defaultWorkflowName = ref<string | undefined>(undefined);
  const availableBaseBranches = ref<string[]>([]);
  const defaultBaseBranchName = ref<string | undefined>(undefined);
  const repoDefaultBranchName = ref<string | undefined>(undefined);
  const onAgentChoiceUsed = vi.fn(async () => {});
  const selectedCloudRepoId = ref<string | null>(null);
  const selectedCloudItemId = ref<string | null>(null);
  const remoteSnapshot = ref<DesktopCloudSnapshot>({
    repos: [],
    items: [],
    terminalRefs: {},
    blockedByTaskIds: {},
    transferMachines: [],
  });
  const cloudOnlyRepoIds = new Set<string>();
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
    cloneAndImportRepo: vi.fn(async () => "repo-1"),
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
    remoteSnapshot: computed(() => remoteSnapshot.value),
    mainPanelIsCloudTask: computed(() => false),
    selectedCloudRepoId,
    selectedCloudItemId,
    showNewTaskModal,
    availableWorkflows,
    defaultWorkflowName,
    availableBaseBranches,
    defaultBaseBranchName,
    repoDefaultBranchName,
    showAddRepoModal: ref(false),
    isCloudOnlyRepoId: (repoId) => Boolean(repoId && cloudOnlyRepoIds.has(repoId)),
    cloudRepoRemoteUrl: () => null,
    onAgentChoiceUsed,
  });

  return {
    creation,
    store,
    showNewTaskModal,
    availableWorkflows,
    defaultWorkflowName,
    availableBaseBranches,
    defaultBaseBranchName,
    repoDefaultBranchName,
    onAgentChoiceUsed,
    selectedCloudRepoId,
    selectedCloudItemId,
    remoteSnapshot,
    cloudOnlyRepoIds,
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
        defaultWorkflow: "default",
        workflows: ["default"],
      }),
      fetchRepoAgentProviders: async () => ["claude", "copilot", "codex", "opencode", "antigravity"],
      fetchRepoRecentWorkflows: async () => [],
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_dir") return [];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["origin/main"];
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: true };
      }
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
      defaultWorkflow: string;
      workflows: string[];
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
      defaultWorkflow: "default",
      workflows: ["default"],
    });
    providers.resolve([]);
    defaultBranch.resolve("main");
    baseBranches.resolve(["origin/main"]);
    await openPromise;
  });

  it("defaults the New Task workflow to the repository's most recently used one", async () => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default", "single-reviewer"],
      }),
      fetchRepoRecentWorkflows: async () => ["single-reviewer", "default"],
    });
    const { creation, defaultWorkflowName, availableWorkflows } = createTaskCreationHarness();

    await creation.openNewTaskModal();

    expect(availableWorkflows.value).toEqual(["default", "single-reviewer"]);
    expect(defaultWorkflowName.value).toBe("single-reviewer");
    expect(creation.newTaskOptionsLoading.value).toBe(false);
  });

  it("ignores recently used workflows the repository no longer offers", async () => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default", "single-reviewer"],
      }),
      fetchRepoRecentWorkflows: async () => ["retired-workflow", "single-reviewer"],
    });
    const { creation, defaultWorkflowName } = createTaskCreationHarness();

    await creation.openNewTaskModal();

    expect(defaultWorkflowName.value).toBe("single-reviewer");
  });

  it("falls back to the configured default when recently used workflows cannot be read", async () => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default", "single-reviewer"],
      }),
      fetchRepoRecentWorkflows: async () => {
        throw new Error("kanna-server unreachable");
      },
    });
    const { creation, defaultWorkflowName, toast } = createTaskCreationHarness();

    await creation.openNewTaskModal();

    expect(defaultWorkflowName.value).toBe("default");
    expect(creation.newTaskOptionsLoading.value).toBe(false);
    // A missing sticky default is not worth interrupting the operator over.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps each repository's sticky workflow default to itself", async () => {
    const recentWorkflowsByRepo: Record<string, string[]> = {
      "repo-1": ["single-reviewer"],
      "repo-2": [],
    };
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default", "single-reviewer"],
      }),
      fetchRepoRecentWorkflows: async (repoId: string) => recentWorkflowsByRepo[repoId] ?? [],
    });
    const { creation, store, showNewTaskModal, defaultWorkflowName } = createTaskCreationHarness();
    store.repos.push({ id: "repo-2", path: "/repo-2" });

    await creation.openNewTaskModal("repo-1");
    expect(defaultWorkflowName.value).toBe("single-reviewer");
    showNewTaskModal.value = false;

    await creation.openNewTaskModal("repo-2");
    expect(defaultWorkflowName.value).toBe("default");
  });

  it("hydrates cached repository options while refreshing them on reopen", async () => {
    const { creation, showNewTaskModal, availableWorkflows, defaultWorkflowName, availableBaseBranches } =
      createTaskCreationHarness();

    await creation.openNewTaskModal();
    showNewTaskModal.value = false;

    const definitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultWorkflow: string;
      workflows: string[];
    }>();
    const providers = deferred<["codex"]>();
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

    const reopenPromise = creation.openNewTaskModal();

    expect(creation.newTaskOptionsLoading.value).toBe(true);
    expect(creation.availableAgentProviders.value).toEqual([
      "claude", "copilot", "codex", "opencode", "antigravity",
    ]);
    expect(availableWorkflows.value).toEqual(["default"]);
    expect(defaultWorkflowName.value).toBe("default");
    expect(availableBaseBranches.value).toEqual(["origin/main"]);

    definitions.resolve({
      revision: "refreshed-rev",
      refName: "origin/trunk",
      config: {},
      defaultWorkflow: "review",
      workflows: ["default", "review"],
    });
    providers.resolve(["codex"]);
    defaultBranch.resolve("trunk");
    baseBranches.resolve(["origin/trunk", "trunk"]);
    await reopenPromise;

    expect(creation.availableAgentProviders.value).toEqual(["codex"]);
    expect(availableWorkflows.value).toEqual(["default", "review"]);
    expect(defaultWorkflowName.value).toBe("review");
    expect(availableBaseBranches.value).toEqual(["origin/trunk", "trunk"]);
    expect(creation.newTaskOptionsLoading.value).toBe(false);
  });

  it("keeps cached repository options isolated by repository", async () => {
    const {
      creation,
      store,
      showNewTaskModal,
      availableWorkflows,
      availableBaseBranches,
    } = createTaskCreationHarness();

    await creation.openNewTaskModal("repo-1");
    showNewTaskModal.value = false;
    store.repos.push({ id: "repo-2", path: "/repo-2" });
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "repo-2-rev",
        refName: "origin/trunk",
        config: {},
        defaultWorkflow: "review",
        workflows: ["default", "review"],
      }),
      fetchRepoAgentProviders: async (): Promise<["codex"]> => ["codex"],
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_default_branch") return "trunk";
      if (command === "git_list_base_branches") return ["origin/trunk"];
      return "";
    });
    await creation.openNewTaskModal("repo-2");
    showNewTaskModal.value = false;

    const definitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultWorkflow: string;
      workflows: string[];
    }>();
    const providers = deferred<["claude"]>();
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

    const reopenRepoOne = creation.openNewTaskModal("repo-1");

    expect(creation.availableAgentProviders.value).toEqual([
      "claude", "copilot", "codex", "opencode", "antigravity",
    ]);
    expect(availableWorkflows.value).toEqual(["default"]);
    expect(availableBaseBranches.value).toEqual(["origin/main"]);

    definitions.resolve({
      revision: "repo-1-refreshed-rev",
      refName: "origin/main",
      config: {},
      defaultWorkflow: "default",
      workflows: ["default"],
    });
    providers.resolve(["claude"]);
    defaultBranch.resolve("main");
    baseBranches.resolve(["origin/main", "main"]);
    await reopenRepoOne;
  });

  it("hydrates cached remote branches while refreshing a cloud-only repository", async () => {
    const {
      creation,
      store,
      showNewTaskModal,
      availableBaseBranches,
      defaultBaseBranchName,
      remoteSnapshot,
      cloudOnlyRepoIds,
    } = createTaskCreationHarness();
    const cloudRepoId = "cloud:repo-cloud";
    const cloudRepo = {
      id: cloudRepoId,
      path: "",
      name: "repo-cloud",
      default_branch: "main",
      remote_url: "git@github.com:kanna/repo-cloud.git",
      remote_url_hash: null,
      hidden: 0,
      sort_order: 0,
      created_at: "2026-07-21T00:00:00Z",
      last_opened_at: "2026-07-21T00:00:00Z",
    };
    remoteSnapshot.value = {
      repos: [cloudRepo],
      items: [],
      terminalRefs: {},
      blockedByTaskIds: {},
    };
    cloudOnlyRepoIds.add(cloudRepoId);
    store.selectedRepoId = cloudRepoId;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_list_remote_base_branches") return ["origin/main"];
      return "";
    });

    await creation.openNewTaskModal(cloudRepoId);
    showNewTaskModal.value = false;

    const refreshedBranches = deferred<string[]>();
    remoteSnapshot.value = {
      repos: [{ ...cloudRepo, default_branch: "trunk" }],
      items: [],
      terminalRefs: {},
      blockedByTaskIds: {},
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_list_remote_base_branches") return refreshedBranches.promise;
      return Promise.resolve("");
    });

    const reopenPromise = creation.openNewTaskModal(cloudRepoId);

    expect(availableBaseBranches.value).toEqual(["origin/main"]);
    expect(defaultBaseBranchName.value).toBe("origin/main");

    refreshedBranches.resolve(["origin/trunk", "trunk"]);
    await reopenPromise;

    expect(availableBaseBranches.value).toEqual(["origin/trunk", "trunk"]);
    expect(defaultBaseBranchName.value).toBe("origin/trunk");
  });

  it("discards option results from a superseded repository load", async () => {
    const definitions = {
      "repo-1": deferred<{
        revision: string;
        refName: string;
        config: Record<string, never>;
        defaultWorkflow: string;
        workflows: string[];
      }>(),
      "repo-2": deferred<{
        revision: string;
        refName: string;
        config: Record<string, never>;
        defaultWorkflow: string;
        workflows: string[];
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
      availableWorkflows,
      defaultWorkflowName,
      availableBaseBranches,
    } = createTaskCreationHarness();
    store.repos.push({ id: "repo-2", path: "/repo-2" });

    const firstOpen = creation.openNewTaskModal("repo-1");
    const secondOpen = creation.openNewTaskModal("repo-2");

    definitions["repo-2"].resolve({
      revision: "repo-2-rev",
      refName: "origin/trunk",
      config: {},
      defaultWorkflow: "review",
      workflows: ["default", "review"],
    });
    providers["repo-2"].resolve(["codex"]);
    defaultBranches["/repo-2"].resolve("trunk");
    baseBranches["/repo-2"].resolve(["origin/trunk"]);
    await secondOpen;

    definitions["repo-1"].resolve({
      revision: "repo-1-rev",
      refName: "origin/main",
      config: {},
      defaultWorkflow: "default",
      workflows: ["default"],
    });
    providers["repo-1"].resolve([]);
    defaultBranches["/repo"].resolve("main");
    baseBranches["/repo"].resolve(["origin/main"]);
    await firstOpen;

    expect(availableWorkflows.value).toEqual(["default", "review"]);
    expect(defaultWorkflowName.value).toBe("review");
    expect(availableBaseBranches.value).toEqual(["origin/trunk"]);
    expect(creation.availableAgentProviders.value).toEqual(["codex"]);
    expect(creation.newTaskOptionsLoading.value).toBe(false);

    const refreshedDefinitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultWorkflow: string;
      workflows: string[];
    }>();
    const refreshedProviders = deferred<[]>();
    const refreshedDefaultBranch = deferred<string>();
    const refreshedBaseBranches = deferred<string[]>();
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: () => refreshedDefinitions.promise,
      fetchRepoAgentProviders: () => refreshedProviders.promise,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_default_branch") return refreshedDefaultBranch.promise;
      if (command === "git_list_base_branches") return refreshedBaseBranches.promise;
      return Promise.resolve("");
    });

    const thirdOpen = creation.openNewTaskModal("repo-1");

    expect(availableWorkflows.value).toEqual([]);
    expect(availableBaseBranches.value).toEqual([]);

    refreshedDefinitions.resolve({
      revision: "repo-1-current-rev",
      refName: "origin/main",
      config: {},
      defaultWorkflow: "default",
      workflows: ["default"],
    });
    refreshedProviders.resolve([]);
    refreshedDefaultBranch.resolve("main");
    refreshedBaseBranches.resolve(["origin/main"]);
    await thirdOpen;
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
              defaultWorkflow: "default",
              workflows: ["default"],
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

  it("loads workflow choices and the default from the repo definitions manifest", async () => {
    const fetchRepoKannaDefinitions = vi.fn(async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config: { workflow: "remote-qa" },
      defaultWorkflow: "remote-qa",
      workflows: ["default", "remote-qa"],
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const { creation, availableWorkflows, defaultWorkflowName } = createTaskCreationHarness();

    await creation.openNewTaskModal();

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(availableWorkflows.value).toEqual(["default", "remote-qa"]);
    expect(defaultWorkflowName.value).toBe("remote-qa");
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
      availableWorkflows,
      defaultWorkflowName,
      toast,
    } = createTaskCreationHarness();

    await expect(creation.openNewTaskModal()).resolves.toBeUndefined();

    expect(toast.error).toHaveBeenCalledWith(
      "toasts.repoDefinitionsFailed: remote definitions unavailable",
    );
    expect(showNewTaskModal.value).toBe(true);
    expect(availableWorkflows.value).toEqual([]);
    expect(defaultWorkflowName.value).toBeUndefined();
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

  it("passes selected blocker task ids through to task creation", async () => {
    const { creation, store } = createTaskCreationHarness();

    await creation.handleNewTaskSubmit("Ship blocked", "claude", "default", "origin/main", "pty", ["task-blocker"]);

    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/repo",
      "Ship blocked",
      "pty",
      expect.objectContaining({ blockerTaskIds: ["task-blocker"] }),
    );
  });

  it("offers only open tasks in the selected repo as new-task blocker candidates", () => {
    const { creation, store } = createTaskCreationHarness();
    store.items = [
      { id: "task-open", repo_id: "repo-1", closed_at: null },
      { id: "task-closed", repo_id: "repo-1", closed_at: "2026-07-01T00:00:00.000Z" },
      { id: "task-other-repo", repo_id: "repo-2", closed_at: null },
    ] as never;

    expect(creation.newTaskBlockerCandidates.value.map((item) => item.id)).toEqual(["task-open"]);
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
        workflow: "default",
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

  it("skips the setup agent when an imported repository already has .kanna", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: true };
      }
      if (command === "file_exists" && args?.path === "/repo/.kanna") return true;
      return "";
    });
    const {
      creation,
      store,
      selectedCloudRepoId,
      selectedCloudItemId,
    } = createTaskCreationHarness();
    selectedCloudRepoId.value = "cloud:repo-stale";
    selectedCloudItemId.value = "cloud:repo-stale:task-stale";

    await creation.handleImportRepo("/repo", "repo", "main");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/repo/.kanna" });
    expect(selectedCloudRepoId.value).toBeNull();
    expect(selectedCloudItemId.value).toBeNull();
    expect(store.persistSelection).toHaveBeenCalled();
    expect(store.loadAgent).not.toHaveBeenCalled();
    expect(store.createItem).not.toHaveBeenCalled();
  });

  it("launches the setup agent when an imported repository has no .kanna", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: true };
      }
      if (command === "file_exists" && args?.path === "/repo/.kanna") return false;
      return "";
    });
    const { creation, store } = createTaskCreationHarness();

    await creation.handleImportRepo("/repo", "repo", "main");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/repo/.kanna" });
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

  it("guides an imported zero-commit repository without attempting a setup task", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_repository_state") {
        return { defaultBranch: "trunk", hasCommits: false };
      }
      return "";
    });
    const { creation, store, toast } = createTaskCreationHarness();

    await creation.handleImportRepo("/repo", "repo", "trunk");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "trunk");
    expect(store.loadAgent).not.toHaveBeenCalled();
    expect(store.createItem).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("toasts.emptyRepoNeedsInitialCommit");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("skips the setup agent when a cloned repository already has .kanna", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: true };
      }
      if (command === "file_exists" && args?.path === "/clone/.kanna") return true;
      return "";
    });
    const {
      creation,
      store,
      selectedCloudRepoId,
      selectedCloudItemId,
    } = createTaskCreationHarness();
    selectedCloudRepoId.value = "cloud:repo-stale";
    selectedCloudItemId.value = "cloud:repo-stale:task-stale";

    await creation.handleCloneRepo("git@github.com:kanna/repo.git", "/clone");

    expect(store.cloneAndImportRepo).toHaveBeenCalledWith(
      "git@github.com:kanna/repo.git",
      "/clone",
    );
    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/clone/.kanna" });
    expect(selectedCloudRepoId.value).toBeNull();
    expect(selectedCloudItemId.value).toBeNull();
    expect(store.persistSelection).toHaveBeenCalled();
    expect(store.loadAgent).not.toHaveBeenCalled();
    expect(store.createItem).not.toHaveBeenCalled();
  });

  it("guides a newly created zero-commit repository instead of launching a setup task", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: false };
      }
      return "";
    });
    const { creation, store, toast } = createTaskCreationHarness();

    await creation.handleCreateRepo("repo", "/repo");

    expect(store.createRepo).toHaveBeenCalledWith("repo", "/repo");
    expect(invokeMock).not.toHaveBeenCalledWith("file_exists", { path: "/repo/.kanna" });
    expect(store.loadAgent).not.toHaveBeenCalled();
    expect(store.createItem).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("toasts.emptyRepoNeedsInitialCommit");
    expect(toast.error).not.toHaveBeenCalled();
  });
});
