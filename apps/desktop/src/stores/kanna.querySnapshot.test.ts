import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "../types/kanna";
import {
  createStoreContext,
  createStoreState,
  type KannaSnapshot,
  type StoreServices,
} from "./state";
import { createQueriesApi } from "./queries";
import { createSelectionApi } from "./selection";
import { useKannaStore } from "./kanna";
import {
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";

const beginTaskSwitchMock = vi.hoisted(() => vi.fn());
const invalidateSharedDataMock = vi.hoisted(() => vi.fn(async () => {}));
const onSharedInvalidationMock = vi.hoisted(() => vi.fn(async () => () => undefined));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mockState = vi.hoisted(() => {
  const now = "2026-04-17T00:00:00.000Z";

  function makeRepo(overrides: Partial<Repo> = {}): Repo {
    const id = overrides.id ?? "repo-1";
    return {
      id,
      path: overrides.path ?? `/tmp/${id}`,
      name: overrides.name ?? id,
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: now,
      last_opened_at: now,
      ...overrides,
    };
  }

  function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
    const id = overrides.id ?? "item-1";
    const repoId = overrides.repo_id ?? "repo-1";
    return {
      id,
      repo_id: repoId,
      issue_number: null,
      issue_title: null,
      prompt: "Ship it",
      workflow: "default",
      stage: "in progress",
      stage_result: null,
      active_post_action: null,
      tags: "[]",
      pr_number: null,
      pr_url: null,
      branch: overrides.branch ?? `task-${id}`,
      closed_at: null,
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      activity_revision: 0,
      activity_changed_at: now,
      unread_at: null,
      port_offset: null,
      display_name: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      base_ref: null,
      agent_session_id: null,
      previous_stage: null,
      teardown_started_at: null,
      last_output_preview: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  let allRepos: Repo[] = [];
  let workflowItems: PipelineItem[] = [];

  const invokeImplementation = async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "ensure_term_init":
      case "list_sessions":
      case "get_app_data_dir":
      case "spawn_session":
      case "attach_session_with_snapshot":
      case "signal_session":
      case "kill_session":
      case "get_workflow_socket_path":
        return [];
      case "file_exists":
        return true;
      case "read_text_file":
        if (typeof args?.path === "string" && args.path.endsWith("/.kanna/config.json")) {
          return "{}";
        }
        throw new Error("missing");
      case "which_binary":
        return "/usr/bin/claude";
      case "git_default_branch":
        return "main";
      case "ensure_directory":
      case "git_init":
      case "git_clone":
        return undefined;
      default:
        throw new Error(`unexpected invoke: ${command}`);
    }
  };
  const invokeMock = vi.fn(invokeImplementation);
  const listReposMock = vi.fn(async () => allRepos.filter((repo) => !repo.hidden));
  const listPipelineItemsMock = vi.fn(async (_db: DbHandle, repoId: string) =>
    workflowItems.filter((item) => item.repo_id === repoId),
  );
  const listTaskBlockersMock = vi.fn(async () => []);
  const getSettingMock = vi.fn(async () => null);
  const getUnblockedItemsMock = vi.fn(async () => []);

  function reset(): void {
    allRepos = [
      makeRepo({ id: "repo-1", path: "/tmp/repo-1", name: "repo-1", hidden: 0 }),
      makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2", hidden: 0 }),
    ];
    workflowItems = [
      makeItem({ id: "item-1", repo_id: "repo-1" }),
      makeItem({ id: "item-2", repo_id: "repo-2" }),
    ];
    invokeMock.mockReset();
    invokeMock.mockImplementation(invokeImplementation);
    listReposMock.mockClear();
    listPipelineItemsMock.mockClear();
    listTaskBlockersMock.mockClear();
    getSettingMock.mockClear();
    getUnblockedItemsMock.mockClear();
  }

  reset();

  return {
    get allRepos() {
      return allRepos;
    },
    set allRepos(value: Repo[]) {
      allRepos = value;
    },
    get visibleRepos() {
      return allRepos.filter((repo) => !repo.hidden);
    },
    get workflowItems() {
      return workflowItems;
    },
    set workflowItems(value: PipelineItem[]) {
      workflowItems = value;
    },
    makeRepo,
    makeItem,
    invokeMock,
    listReposMock,
    listPipelineItemsMock,
    listTaskBlockersMock,
    getSettingMock,
    getUnblockedItemsMock,
    reset,
  };
});

vi.mock("../invoke", () => ({
  invoke: mockState.invokeMock,
}));

vi.mock("../tauri-mock", () => ({
  isTauri: false,
}));

vi.mock("../listen", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@kanna/core", () => ({
  parseRepoConfig: vi.fn(() => ({})),
  parseAgentMd: vi.fn(() => null),
  DEFAULT_STAGE_ORDER: ["pr", "review", "in progress"],
}));

vi.mock("../../../../packages/core/src/workflow/agent-loader", () => ({
  parseAgentDefinition: vi.fn(() => ({
    name: "agent",
    description: "agent",
    prompt: "Agent prompt",
  })),
}));

vi.mock("../../../../packages/core/src/workflow/workflow-loader", () => ({
  parseWorkflowJson: vi.fn(() => ({
    name: "default",
    stages: [],
  })),
}));

vi.mock("../../../../packages/core/src/workflow/prompt-builder", () => ({
  buildStagePrompt: vi.fn(() => "Stage prompt"),
}));

vi.mock("../composables/useToast", () => ({
  useToast: () => ({
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("../composables/terminalSessionRecovery", () => ({
  buildTaskShellCommand: vi.fn(() => "agent-command"),
  getShellTerminalEnv: vi.fn(() => ({
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "kanna",
  })),
  getTaskTerminalEnv: vi.fn(() => ({})),
}));

vi.mock("../composables/terminalStateCache", () => ({
  clearCachedTerminalState: vi.fn(),
}));

vi.mock("./kannaCleanup", () => ({
  closePipelineItemAndClearCachedTerminalState: vi.fn(async () => {}),
  getTaskIdFromTeardownSessionId: vi.fn(() => null),
  isTeardownSessionId: vi.fn(() => false),
  reportCloseSessionError: vi.fn(),
  reportPrewarmSessionError: vi.fn(),
  shouldAutoCloseTaskAfterTeardownExit: vi.fn(() => false),
  shouldAutoCloseTaskImmediatelyAfterEnteringTeardown: vi.fn(() => false),
  shouldClearCachedTerminalStateOnSessionExit: vi.fn(() => false),
}));

vi.mock("./agent-provider", () => ({
  getPreferredAgentProviders: vi.fn(() => "claude"),
  requireResolvedAgentProvider: vi.fn((provider?: string) => provider ?? "claude"),
  resolveAgentProvider: vi.fn((provider?: string | string[]) => Array.isArray(provider) ? provider[0] : (provider ?? "claude")),
}));

vi.mock("./portAllocationLog", () => ({
  formatTaskPortAllocationLog: vi.fn(() => ""),
}));

vi.mock("./taskCloseBehavior", () => ({
  getTaskCloseBehavior: vi.fn(() => "close"),
}));

vi.mock("./taskCloseSelection", () => ({
  shouldSelectNextOnCloseTransition: vi.fn(() => true),
}));

vi.mock("./taskShellPrewarm", () => ({
  shouldPrewarmTaskShellOnCreate: vi.fn(() => false),
}));

vi.mock("./taskRuntimeStatus", () => ({
  resolveActivityForRuntimeStatus: vi.fn(() => null),
  shouldIgnoreRuntimeStatusDuringSetup: vi.fn(() => false),
}));

vi.mock("../perf/taskSwitchPerf", () => ({
  beginTaskSwitch: (...args: unknown[]) => beginTaskSwitchMock(...args),
}));

vi.mock("./agent-permissions", () => ({
  getAgentPermissionFlags: vi.fn(() => []),
}));

vi.mock("./taskBaseBranch", () => ({
  getCreateWorktreeStartPoint: vi.fn(() => "main"),
  resolveInitialBaseRef: vi.fn(() => "origin/main"),
}));

vi.mock("./db", () => ({
  resolveDbName: vi.fn(() => "kanna.db"),
}));

vi.mock("./kannaCliEnv", () => ({
  buildKannaCliEnv: vi.fn(() => ({})),
}));

vi.mock("../i18n", () => ({
  default: {
    global: {
      t: (key: string) => key,
    },
  },
}));

vi.mock("@kanna/" + "db", () => ({
  listRepos: mockState.listReposMock,
  insertRepo: vi.fn(async (_db: DbHandle, repo: Repo) => {
    mockState.allRepos = [...mockState.allRepos, repo];
  }),
  findRepoByPath: vi.fn(async (_db: DbHandle, path: string) =>
    mockState.allRepos.find((repo) => repo.path === path) ?? null,
  ),
  hideRepo: vi.fn(async (_db: DbHandle, repoId: string) => {
    mockState.allRepos = mockState.allRepos.map((repo) =>
      repo.id === repoId ? { ...repo, hidden: 1 } : repo,
    );
  }),
  unhideRepo: vi.fn(async (_db: DbHandle, repoId: string) => {
    mockState.allRepos = mockState.allRepos.map((repo) =>
      repo.id === repoId ? { ...repo, hidden: 0 } : repo,
    );
  }),
  listPipelineItems: mockState.listPipelineItemsMock,
  listTaskBlockers: mockState.listTaskBlockersMock,
  insertPipelineItem: vi.fn(async () => {}),
  updatePipelineItemActivity: vi.fn(async () => {}),
  markPipelineItemTearingDown: vi.fn(async () => {}),
  updatePipelineItemStage: vi.fn(async () => {}),
  pinPipelineItem: vi.fn(async () => {}),
  unpinPipelineItem: vi.fn(async () => {}),
  reorderPinnedItems: vi.fn(async () => {}),
  updatePipelineItemDisplayName: vi.fn(async () => {}),
  clearPipelineItemStageResult: vi.fn(async () => {}),
  clearPipelineItemActivePostAction: vi.fn(async () => {}),
  closePipelineItem: vi.fn(async () => {}),
  reopenPipelineItem: vi.fn(async () => {}),
  getRepo: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.allRepos.find((repo) => repo.id === repoId) ?? null,
  ),
  getSetting: mockState.getSettingMock,
  setSetting: vi.fn(async () => {}),
  insertTaskBlocker: vi.fn(async () => {}),
  removeTaskBlocker: vi.fn(async () => {}),
  removeAllBlockersForItem: vi.fn(async () => {}),
  listBlockersForItem: vi.fn(async () => []),
  listBlockedByItem: vi.fn(async () => []),
  getUnblockedItems: mockState.getUnblockedItemsMock,
  hasCircularDependency: vi.fn(async () => false),
  insertOperatorEvent: vi.fn(async () => {}),
  updateAgentSessionId: vi.fn(async () => {}),
  listTaskPorts: vi.fn(async () => []),
  listTaskPortsForItem: vi.fn(async () => []),
  deleteTaskPortsForItem: vi.fn(async () => {}),
}));


function createDb(): DbHandle {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async () => []),
  };
}

async function flushStore(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function createStore(db: DbHandle = createDb()) {
  setActivePinia(createPinia());
  const store = useKannaStore();
  store.attachWindowWorkspace({
    bootstrap: {
      windowId: "main",
      selectedRepoId: null,
      selectedItemId: null,
    },
    loadSnapshot: vi.fn(async () => ({ windows: [] })),
    saveSnapshot: vi.fn(async () => {}),
    openWindow: vi.fn(async () => {}),
    persistSelection: vi.fn(async () => {}),
    persistSidebarHidden: vi.fn(async () => {}),
    persistSidebarWidth: vi.fn(async () => {}),
    invalidateSharedData: invalidateSharedDataMock,
    restoreAdditionalWindows: vi.fn(async () => {}),
    onSharedInvalidation: onSharedInvalidationMock,
  });
  await store.init(db);
  await flushStore();
  return store;
}

describe("kanna query snapshot regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:00:00.000Z"));
    mockState.reset();
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: mockState.visibleRepos.map((repo) => ({
        repo,
        items: mockState.workflowItems.filter((item) => item.repo_id === repo.id),
      })),
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    updateDesktopServerClientHandlersForTests({
      putSetting: async () => {},
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      }),
      findRepoByPath: async (path) =>
        mockState.allRepos.find((repo) => repo.path === path) as never ?? null,
      addRepo: async ({ path, name }) => {
        const repo = mockState.makeRepo({
          id: `repo-${mockState.allRepos.length + 1}`,
          path,
          name: name ?? path.split("/").pop() ?? "repo",
          hidden: 0,
        });
        mockState.allRepos = [...mockState.allRepos, repo];
        return repo as never;
      },
      patchRepo: async (repoId, input) => {
        mockState.allRepos = mockState.allRepos.map((repo) =>
          repo.id === repoId
            ? {
                ...repo,
                hidden: input.hidden === undefined ? repo.hidden : (input.hidden ? 1 : 0),
                remote_url: input.remoteUrl === undefined ? repo.remote_url : input.remoteUrl,
                remote_url_hash: input.remoteUrlHash === undefined ? repo.remote_url_hash : input.remoteUrlHash,
              }
            : repo,
        );
      },
    });
    beginTaskSwitchMock.mockReset();
    invalidateSharedDataMock.mockReset();
    onSharedInvalidationMock.mockReset();
    mockState.listReposMock.mockClear();
    mockState.listPipelineItemsMock.mockClear();
    mockState.listTaskBlockersMock.mockClear();
    mockState.getSettingMock.mockClear();
    mockState.getUnblockedItemsMock.mockClear();
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    vi.useRealTimers();
  });

  it("refreshes stage order by repo ID when the manifest revision changes", async () => {
    const repo = mockState.makeRepo({ id: "repo-stage-order", path: "/tmp/movable-path" });
    const firstOrder = ["review", "pr"];
    const responses = [
      {
        revision: "rev-1",
        refName: "origin/main",
        config: { stage_order: firstOrder },
        defaultWorkflow: "default",
        workflows: ["default"],
      },
      {
        revision: "rev-1",
        refName: "origin/main",
        config: { stage_order: ["ignored-same-revision"] },
        defaultWorkflow: "default",
        workflows: ["default"],
      },
      {
        revision: "rev-2",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      },
    ];
    const fetchRepoKannaDefinitions = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected manifest fetch");
      return response;
    });
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const state = createStoreState();
    const context = createStoreContext(state, { error: vi.fn(), warning: vi.fn() } as never, {
      fetchSnapshot: async () => ({
        entries: [{ repo, items: [] }],
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      }),
    });
    const queries = createQueriesApi(context);
    const selection = createSelectionApi(context);

    await queries.reloadSnapshot();
    const firstEntry = state.stageOrderCache.get(repo.id);
    expect(firstEntry).toBeDefined();
    expect(selection.getStageOrder(repo.id)).toBe(firstOrder);
    expect(state.stageOrderCache.has(repo.path)).toBe(false);

    // A task-driven reload keeps the definitions it already resolved: they can
    // only change when the repo does, and resolving them costs a Git round trip.
    await queries.reloadSnapshot();
    expect(state.stageOrderCache.get(repo.id)).toBe(firstEntry);
    expect(fetchRepoKannaDefinitions).toHaveBeenCalledTimes(1);

    await queries.reloadSnapshot({ refreshDefinitions: true });
    expect(state.stageOrderCache.get(repo.id)).toBe(firstEntry);
    expect(selection.getStageOrder(repo.id)).toBe(firstOrder);

    await queries.reloadSnapshot({ refreshDefinitions: true });
    expect(state.stageOrderCache.get(repo.id)).not.toBe(firstEntry);
    expect(selection.getStageOrder(repo.id)).toEqual(["pr", "review", "in progress"]);
    expect(fetchRepoKannaDefinitions).toHaveBeenCalledTimes(3);
    expect(fetchRepoKannaDefinitions).toHaveBeenNthCalledWith(1, repo.id);
  });

  it("resolves definitions for a repo it has not seen even without a forced refresh", async () => {
    const known = mockState.makeRepo({ id: "repo-known", path: "/tmp/known" });
    const added = mockState.makeRepo({ id: "repo-added", path: "/tmp/added" });
    const manifestFor = (repoId: string) => ({
      revision: `rev-${repoId}`,
      refName: "origin/main",
      config: { stage_order: [repoId] },
      defaultWorkflow: "default",
      workflows: ["default"],
    });
    const fetchRepoKannaDefinitions = vi.fn(async (repoId: string) => manifestFor(repoId));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const state = createStoreState();
    let repos = [known];
    const context = createStoreContext(state, { error: vi.fn(), warning: vi.fn() } as never, {
      fetchSnapshot: async () => ({
        entries: repos.map((repo) => ({ repo, items: [] })),
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      }),
    });
    const queries = createQueriesApi(context);
    const selection = createSelectionApi(context);

    await queries.reloadSnapshot();
    expect(fetchRepoKannaDefinitions).toHaveBeenCalledTimes(1);

    // A repo added while the app is running has no cached stage order, so it
    // still resolves — only repos already answered for are skipped.
    repos = [known, added];
    await queries.reloadSnapshot();

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledTimes(2);
    expect(fetchRepoKannaDefinitions).toHaveBeenLastCalledWith(added.id);
    expect(selection.getStageOrder(added.id)).toEqual([added.id]);
  });

  it("applies versioned task state without replacing item or slot collections", async () => {
    const repo = mockState.makeRepo();
    const item = mockState.makeItem();
    const fetchSnapshot = vi.fn(async (): Promise<KannaSnapshot> => ({
      entries: [{ repo, items: [item] }],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    const state = createStoreState();
    const context = createStoreContext(state, { error: vi.fn(), warning: vi.fn() } as never, {
      fetchSnapshot,
    });
    const queries = createQueriesApi(context);
    await queries.reloadSnapshot();

    const itemsIdentity = state.items.value;
    const slotsIdentity = state.taskUiSlots.value;
    const itemIdentity = state.items.value[0];
    const slotTaskIdentity = state.taskUiSlots.value[0]?.task;
    fetchSnapshot.mockClear();

    expect(queries.applyTaskStateChange({
      version: 1,
      task_id: item.id,
      activity: "unread",
      activity_revision: 1,
      activity_changed_at: "2026-09-03T18:30:00Z",
      unread_at: "2026-09-03T18:30:00Z",
      runtime_state: "idle",
      read_state: "unread",
      last_output_preview: "Finished",
    })).toBe(true);

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(state.items.value).toBe(itemsIdentity);
    expect(state.taskUiSlots.value).toBe(slotsIdentity);
    expect(state.items.value[0]).toBe(itemIdentity);
    expect(state.taskUiSlots.value[0]?.task).toBe(slotTaskIdentity);
    expect(state.items.value[0]).toMatchObject({
      activity: "unread",
      activity_revision: 1,
      runtime_state: "idle",
      read_state: "unread",
      last_output_preview: "Finished",
    });
    expect(queries.applyTaskStateChange({
      version: 2,
      task_id: item.id,
      activity: "idle",
      activity_revision: 2,
      activity_changed_at: null,
      unread_at: null,
      runtime_state: "idle",
      read_state: "read",
      last_output_preview: null,
    })).toBe(false);
  });

  it("does not let an in-flight stale snapshot overwrite a later scoped state", async () => {
    const repo = mockState.makeRepo();
    const initialItem = mockState.makeItem({ activity_revision: 0 });
    const staleReload = deferred<KannaSnapshot>();
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({
        entries: [{ repo, items: [initialItem] }],
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      } satisfies KannaSnapshot)
      .mockImplementationOnce(() => staleReload.promise);
    const state = createStoreState();
    const context = createStoreContext(state, { error: vi.fn(), warning: vi.fn() } as never, {
      fetchSnapshot,
    });
    const queries = createQueriesApi(context);
    await queries.reloadSnapshot();

    const pendingReload = queries.reloadSnapshot();
    expect(queries.applyTaskStateChange({
      version: 1,
      task_id: initialItem.id,
      activity: "working",
      activity_revision: 1,
      activity_changed_at: "2026-09-03T18:30:00Z",
      unread_at: null,
      runtime_state: "busy",
      read_state: "read",
      last_output_preview: "Running",
    })).toBe(true);
    staleReload.resolve({
      entries: [{
        repo,
        items: [{ ...initialItem, activity: "idle", activity_revision: 0 }],
      }],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    });
    await pendingReload;

    expect(state.items.value[0]).toMatchObject({
      activity: "working",
      activity_revision: 1,
      runtime_state: "busy",
      read_state: "read",
    });
  });

  it("publishes authoritative task state when one repo manifest fails", async () => {
    const error = new Error("stage-order manifest unavailable");
    const healthyRepo = mockState.makeRepo({ id: "repo-stage-healthy" });
    const failingRepo = mockState.makeRepo({ id: "repo-stage-error" });
    const healthyItem = mockState.makeItem({ id: "item-stage-healthy", repo_id: healthyRepo.id });
    const failingItem = mockState.makeItem({ id: "item-stage-error", repo_id: failingRepo.id });
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async (repoId) => {
        if (repoId === failingRepo.id) throw error;
        return {
          revision: "healthy-revision",
          refName: "origin/main",
          config: { stage_order: ["review", "in progress"] },
          defaultWorkflow: "default",
          workflows: ["default"],
        };
      },
    });
    const state = createStoreState();
    const context = createStoreContext(state, { error: vi.fn(), warning: vi.fn() } as never, {
      fetchSnapshot: async () => ({
        entries: [
          { repo: healthyRepo, items: [healthyItem] },
          { repo: failingRepo, items: [failingItem] },
        ],
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      }),
    });
    const queries = createQueriesApi(context);
    mockState.invokeMock.mockClear();

    await expect(queries.reloadSnapshot()).resolves.toBeUndefined();

    expect(state.repos.value.map((repo) => repo.id)).toEqual([healthyRepo.id, failingRepo.id]);
    expect(state.items.value.map((item) => item.id)).toEqual([healthyItem.id, failingItem.id]);
    expect(queries.snapshot.data.value.entries).toHaveLength(2);
    expect(queries.snapshot.error.value).toBeNull();
    expect(state.stageOrderCache.get(healthyRepo.id)).toEqual({
      revision: "healthy-revision",
      stageOrder: ["review", "in progress"],
    });
    expect(state.stageOrderCache.has(failingRepo.id)).toBe(false);
    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "read_text_file",
      expect.objectContaining({ path: expect.stringContaining("/.kanna/config.json") }),
    );
  });

  it("keeps the newest snapshot when an older reload resolves last", async () => {
    const older = deferred<KannaSnapshot>();
    const newer = deferred<KannaSnapshot>();
    const fetchSnapshot = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const state = createStoreState();
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, { fetchSnapshot });
    const queries = createQueriesApi(context);

    const olderReload = queries.reloadSnapshot();
    const newerReload = queries.reloadSnapshot();

    newer.resolve({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: { markdownPreviewMode: "raw" },
    });
    await newerReload;
    expect(state.markdownPreviewMode.value).toBe("raw");
    expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBe("raw");

    older.resolve({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: { markdownPreviewMode: "rendered" },
    });
    await olderReload;

    expect(state.markdownPreviewMode.value).toBe("raw");
    expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBe("raw");
    expect(queries.snapshot.pending.value).toBe(false);
    expect(queries.snapshot.error.value).toBeNull();
  });

  it("keeps a stale snapshot unpublished while the newer reload remains pending", async () => {
    const older = deferred<KannaSnapshot>();
    const newer = deferred<KannaSnapshot>();
    const fetchSnapshot = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const state = createStoreState();
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, { fetchSnapshot });
    const queries = createQueriesApi(context);

    const olderReload = queries.reloadSnapshot();
    const newerReload = queries.reloadSnapshot();

    older.resolve({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {
        markdownPreviewMode: "raw",
        snapshotOwner: "older",
      },
    });
    await olderReload;

    expect(state.markdownPreviewMode.value).toBe("rendered");
    expect(state.snapshotSettings.value.snapshotOwner).toBeUndefined();
    expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBeUndefined();
    expect(queries.snapshot.data.value.settings.snapshotOwner).toBeUndefined();
    expect(queries.snapshot.pending.value).toBe(true);
    expect(queries.snapshot.error.value).toBeNull();

    newer.resolve({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {
        markdownPreviewMode: "raw",
        snapshotOwner: "newer",
      },
    });
    await newerReload;

    expect(state.markdownPreviewMode.value).toBe("raw");
    expect(state.snapshotSettings.value.snapshotOwner).toBe("newer");
    expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBe("raw");
    expect(queries.snapshot.data.value.settings.snapshotOwner).toBe("newer");
    expect(queries.snapshot.pending.value).toBe(false);
    expect(queries.snapshot.error.value).toBeNull();
  });

  it("ignores an older reload failure while the newer reload remains pending", async () => {
    const older = deferred<KannaSnapshot>();
    const newer = deferred<KannaSnapshot>();
    const fetchSnapshot = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const state = createStoreState();
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, { fetchSnapshot });
    const queries = createQueriesApi(context);

    const olderReload = queries.reloadSnapshot();
    const newerReload = queries.reloadSnapshot();

    older.reject(new Error("older reload failed"));
    await expect(olderReload).resolves.toBeUndefined();

    expect(state.markdownPreviewMode.value).toBe("rendered");
    expect(state.snapshotSettings.value.snapshotOwner).toBeUndefined();
    expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBeUndefined();
    expect(queries.snapshot.error.value).toBeNull();
    expect(queries.snapshot.pending.value).toBe(true);

    newer.resolve({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {
        markdownPreviewMode: "raw",
        snapshotOwner: "newer",
      },
    });
    await newerReload;

    expect(state.markdownPreviewMode.value).toBe("raw");
    expect(state.snapshotSettings.value.snapshotOwner).toBe("newer");
    expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBe("raw");
    expect(queries.snapshot.data.value.settings.snapshotOwner).toBe("newer");
    expect(queries.snapshot.error.value).toBeNull();
    expect(queries.snapshot.pending.value).toBe(false);
  });

  it("keeps the newest snapshot when an older reload resumes after reading repo definitions", async () => {
    const older = deferred<KannaSnapshot>();
    const newer = deferred<KannaSnapshot>();
    const repoDefinitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultWorkflow: string;
      workflows: string[];
    }>();
    const definitionsReadStarted = deferred<void>();
    const fetchSnapshot = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const state = createStoreState();
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, { fetchSnapshot });
    const queries = createQueriesApi(context);
    const olderRepo = mockState.makeRepo({
      id: "repo-config-race",
      path: "/tmp/repo-config-race",
      name: "repo-config-race",
    });
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async (repoId) => {
        expect(repoId).toBe(olderRepo.id);
        definitionsReadStarted.resolve();
        return repoDefinitions.promise;
      },
    });

    let olderReload: Promise<void> | undefined;
    try {
      olderReload = queries.reloadSnapshot();
      older.resolve({
        entries: [{ repo: olderRepo, items: [] }],
        taskBlockers: [],
        worktreePaths: {},
        settings: { markdownPreviewMode: "rendered" },
      });
      await definitionsReadStarted.promise;

      const newerReload = queries.reloadSnapshot();
      newer.resolve({
        entries: [],
        taskBlockers: [],
        worktreePaths: {},
        settings: {
          markdownPreviewMode: "raw",
          snapshotOwner: "newer",
        },
      });
      await newerReload;

      repoDefinitions.resolve({
        revision: "older-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      });
      await olderReload;

      expect(state.markdownPreviewMode.value).toBe("raw");
      expect(state.snapshotSettings.value.snapshotOwner).toBe("newer");
      expect(queries.snapshot.data.value.settings.markdownPreviewMode).toBe("raw");
      expect(queries.snapshot.data.value.settings.snapshotOwner).toBe("newer");
      expect(queries.snapshot.pending.value).toBe(false);
      expect(queries.snapshot.error.value).toBeNull();
    } finally {
      repoDefinitions.resolve({
        revision: "older-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      });
      await olderReload?.catch(() => undefined);
    }
  });

  it("rejects and records the latest reload failure", async () => {
    const current = deferred<KannaSnapshot>();
    const state = createStoreState();
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, {
      fetchSnapshot: () => current.promise,
    });
    const queries = createQueriesApi(context);
    const failure = new Error("current reload failed");

    const reload = queries.reloadSnapshot();
    expect(queries.snapshot.pending.value).toBe(true);

    current.reject(failure);
    await expect(reload).rejects.toBe(failure);

    expect(queries.snapshot.error.value).toBe(failure);
    expect(queries.snapshot.pending.value).toBe(false);
  });

  it("removes a hidden repo and its tasks from the visible store state together", async () => {
    const store = await createStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);

    await store.hideRepo("repo-2");
    await flushStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1"]);
  });

  it("hydrates the startup snapshot without direct database reads", async () => {
    const db = createDb();
    const store = await createStore(db);

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    expect(mockState.listReposMock).not.toHaveBeenCalled();
    expect(mockState.listPipelineItemsMock).not.toHaveBeenCalled();
    expect(mockState.listTaskBlockersMock).not.toHaveBeenCalled();
    expect(mockState.getSettingMock).not.toHaveBeenCalled();
    expect(mockState.getUnblockedItemsMock).not.toHaveBeenCalled();
    expect(db["select"]).not.toHaveBeenCalled();
  });

  it("exposes selection persistence for composables that claim local ownership", async () => {
    const store = await createStore();

    expect((store as unknown as { persistSelection?: unknown }).persistSelection).toBeTypeOf("function");
  });

  it("hydrates a durable task into its acknowledged UI slot without changing its slot ID", async () => {
    const store = await createStore();
    store.taskUiSlots.splice(0, store.taskUiSlots.length, {
      slot_id: "create:slot-1",
      task_id: "item-1",
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
      draft: {
        repo_id: "repo-1",
        prompt: "Ship it",
        display_name: null,
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-04-17T00:00:00.000Z",
      },
    });
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "create:slot-1";

    await store.init(createDb());

    expect(store.taskUiSlots).toEqual([
      expect.objectContaining({
        slot_id: "create:slot-1",
        task_id: "item-1",
        state: "ready",
        task: expect.objectContaining({ id: "item-1" }),
      }),
      expect.objectContaining({
        slot_id: "item-2",
        task_id: "item-2",
        state: "ready",
        task: expect.objectContaining({ id: "item-2" }),
      }),
    ]);
    expect(store.selectedItemId).toBe("create:slot-1");
    expect(store.currentTaskSlot).toMatchObject({
      slot_id: "create:slot-1",
      task_id: "item-1",
      state: "ready",
    });
  });

  it("counts only successful authoritative reloads against acknowledged-slot miss grace", async () => {
    const state = createStoreState();
    state.taskUiSlots.value = [{
      slot_id: "create:missing-slot",
      task_id: "missing-task",
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
      draft: {
        repo_id: "repo-1",
        prompt: "Hydrate or expire",
        display_name: null,
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-04-17T00:00:00.000Z",
      },
    }];
    const missingSnapshot: KannaSnapshot = {
      entries: [{ repo: mockState.makeRepo(), items: [] }],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    };
    const services: StoreServices = {
      fetchSnapshot: vi.fn(async () => missingSnapshot),
    };
    const context = createStoreContext(state, {} as never, services);
    const queries = createQueriesApi(context);

    await queries.withOptimisticItemOverlay({
      key: "test:no-op-overlay",
      apply: (snapshot) => snapshot,
      run: async () => {},
      reconcile: async () => {},
    });

    expect(state.taskUiSlots.value).toEqual([
      expect.objectContaining({ authoritative_miss_grace_remaining: 1 }),
    ]);

    await queries.reloadSnapshot();

    expect(state.taskUiSlots.value).toEqual([
      expect.objectContaining({ authoritative_miss_grace_remaining: 0 }),
    ]);

    await queries.withOptimisticItemOverlay({
      key: "test:second-no-op-overlay",
      apply: (snapshot) => snapshot,
      run: async () => {},
      reconcile: async () => {},
    });

    expect(state.taskUiSlots.value).toEqual([
      expect.objectContaining({ authoritative_miss_grace_remaining: 0 }),
    ]);

    await queries.reloadSnapshot();

    expect(state.taskUiSlots.value).toEqual([]);
  });

  it("ignores an older snapshot that resolves after a newer slot hydration", async () => {
    const store = await createStore();
    const item2Slot = store.taskUiSlots.find((slot) => slot.task_id === "item-2");
    expect(item2Slot).toBeDefined();
    store.taskUiSlots.splice(0, store.taskUiSlots.length, {
      slot_id: "create:slot-1",
      task_id: "item-1",
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
      draft: {
        repo_id: "repo-1",
        prompt: "Ship it",
        display_name: null,
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-04-17T00:00:00.000Z",
      },
    }, item2Slot!);
    await store.selectItem("item-1");

    const olderResponse = deferred<KannaSnapshot>();
    const newerResponse = deferred<KannaSnapshot>();
    let requestCount = 0;
    setDesktopSnapshotFetcherForTests(() => {
      requestCount += 1;
      return requestCount === 1 ? olderResponse.promise : newerResponse.promise;
    });
    const snapshot = (items: PipelineItem[]): KannaSnapshot => ({
      entries: mockState.visibleRepos.map((repo) => ({
        repo,
        items: items.filter((item) => item.repo_id === repo.id),
      })),
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    });

    const olderReload = store.init(createDb());
    const newerReload = store.init(createDb());
    expect(requestCount).toBe(2);

    const newerItem = mockState.makeItem({
      id: "item-1",
      repo_id: "repo-1",
      display_name: "Newest task",
    });
    newerResponse.resolve(snapshot([newerItem, mockState.makeItem({ id: "item-2", repo_id: "repo-2" })]));
    await newerReload;
    olderResponse.resolve(snapshot([mockState.makeItem({ id: "item-2", repo_id: "repo-2" })]));
    await olderReload;
    await flushStore();

    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    expect(store.items.find((item) => item.id === "item-1")?.display_name).toBe("Newest task");
    expect(store.selectedItemId).toBe("create:slot-1");
    expect(store.currentTaskSlot).toMatchObject({
      slot_id: "create:slot-1",
      task_id: "item-1",
      state: "ready",
      task: expect.objectContaining({ id: "item-1", display_name: "Newest task" }),
    });
  });

  it("retires creating slots and selection state when their local repo disappears", async () => {
    const repo1 = mockState.makeRepo({ id: "repo-1" });
    const repo2 = mockState.makeRepo({ id: "repo-2" });
    const survivingItem = mockState.makeItem({ id: "item-1", repo_id: repo1.id });
    const state = createStoreState();
    state.repos.value = [repo1, repo2];
    state.items.value = [
      survivingItem,
      mockState.makeItem({ id: "item-2", repo_id: repo2.id }),
    ];
    state.taskUiSlots.value = [
      {
        slot_id: "item-1",
        task_id: "item-1",
        state: "ready",
        task: survivingItem,
        draft: {
          repo_id: repo1.id,
          prompt: survivingItem.prompt ?? "",
          display_name: null,
          workflow: "default",
          stage: "in progress",
          agent_type: "pty",
          agent_provider: "claude",
          created_at: survivingItem.created_at,
        },
      },
      {
        slot_id: "create:unacknowledged",
        task_id: null,
        state: "creating",
        task: null,
        authoritative_miss_grace_remaining: 0,
        draft: {
          repo_id: repo2.id,
          prompt: "Creating before repo removal",
          display_name: null,
          workflow: "default",
          stage: "in progress",
          agent_type: "pty",
          agent_provider: "claude",
          created_at: "2026-04-17T00:01:00.000Z",
        },
      },
      {
        slot_id: "create:acknowledged",
        task_id: "task-acknowledged",
        state: "creating",
        task: null,
        authoritative_miss_grace_remaining: 1,
        draft: {
          repo_id: repo2.id,
          prompt: "Acknowledged before repo removal",
          display_name: null,
          workflow: "default",
          stage: "in progress",
          agent_type: "pty",
          agent_provider: "claude",
          created_at: "2026-04-17T00:02:00.000Z",
        },
      },
    ];
    state.pendingCreateVisibility.set("create:unacknowledged", { bumpAt: 1 });
    state.pendingCreateVisibility.set("create:acknowledged", { bumpAt: 2 });
    state.pendingCreateVisibility.set("task-acknowledged", { bumpAt: 3 });
    state.selectedRepoId.value = repo2.id;
    state.selectedItemId.value = "create:acknowledged";
    state.lastSelectedItemByRepo.value = {
      [repo1.id]: "item-1",
      [repo2.id]: "create:acknowledged",
    };

    const reconcileSelection = vi.fn(() => {
      state.selectedRepoId.value = repo1.id;
      state.selectedItemId.value = "item-1";
    });
    const persistSelection = vi.fn(async () => {});
    const context = createStoreContext(state, {} as never, {
      fetchSnapshot: vi.fn(async (): Promise<KannaSnapshot> => ({
        entries: [{ repo: repo1, items: [survivingItem] }],
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      })),
      reconcileSelection,
      persistSelection,
    });

    await createQueriesApi(context).reloadSnapshot();

    expect(state.taskUiSlots.value.map((slot) => slot.slot_id)).toEqual(["item-1"]);
    expect(state.pendingCreateVisibility.has("create:unacknowledged")).toBe(false);
    expect(state.pendingCreateVisibility.has("create:acknowledged")).toBe(false);
    expect(state.pendingCreateVisibility.has("task-acknowledged")).toBe(false);
    expect(state.lastSelectedItemByRepo.value).toEqual({ [repo1.id]: "item-1" });
    expect(state.selectedRepoId.value).toBe(repo1.id);
    expect(state.selectedItemId.value).toBe("item-1");
    expect(reconcileSelection).toHaveBeenCalledTimes(1);
    expect(persistSelection).toHaveBeenCalledTimes(1);
  });

  it("preserves a cloud-only selection while retiring a missing local repo", async () => {
    const repo1 = mockState.makeRepo({ id: "repo-1" });
    const repo2 = mockState.makeRepo({ id: "repo-2" });
    const survivingItem = mockState.makeItem({ id: "item-1", repo_id: repo1.id });
    const cloudRepoId = "cloud:repo-remote";
    const cloudTaskId = "cloud:lan:peer:repo-remote:task-remote";
    const state = createStoreState();
    state.repos.value = [repo1, repo2];
    state.items.value = [survivingItem];
    state.taskUiSlots.value = [{
      slot_id: "create:retired",
      task_id: null,
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 0,
      draft: {
        repo_id: repo2.id,
        prompt: "Retire with local repo",
        display_name: null,
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-04-17T00:01:00.000Z",
      },
    }];
    state.selectedRepoId.value = cloudRepoId;
    state.selectedItemId.value = cloudTaskId;
    state.lastSelectedItemByRepo.value = {
      [repo2.id]: "create:retired",
      [cloudRepoId]: cloudTaskId,
    };
    const reconcileSelection = vi.fn();
    const persistSelection = vi.fn(async () => {});
    const context = createStoreContext(state, {} as never, {
      fetchSnapshot: vi.fn(async (): Promise<KannaSnapshot> => ({
        entries: [{ repo: repo1, items: [survivingItem] }],
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      })),
      reconcileSelection,
      persistSelection,
    });

    await createQueriesApi(context).reloadSnapshot();

    expect(state.taskUiSlots.value.every((slot) => slot.draft.repo_id !== repo2.id)).toBe(true);
    expect(state.selectedRepoId.value).toBe(cloudRepoId);
    expect(state.selectedItemId.value).toBe(cloudTaskId);
    expect(state.lastSelectedItemByRepo.value).toEqual({ [cloudRepoId]: cloudTaskId });
    expect(reconcileSelection).not.toHaveBeenCalled();
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("restores an unhidden repo with its tasks from the same refresh path", async () => {
    mockState.allRepos = [
      mockState.makeRepo({ id: "repo-1", path: "/tmp/repo-1", name: "repo-1", hidden: 0 }),
      mockState.makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2", hidden: 1 }),
    ];
    const store = await createStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1"]);

    await store.importRepo("/tmp/repo-2", "repo-2", "main");
    await flushStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
  });

  it("history navigation skips tasks from repos that are no longer visible", async () => {
    const store = await createStore();

    await store.selectRepo("repo-1");
    await store.selectItem("item-1");
    await vi.advanceTimersByTimeAsync(1001);
    store.selectedRepoId = "repo-2";
    await store.selectItem("item-2");
    await flushStore();

    await store.hideRepo("repo-2");
    await flushStore();

    const backTarget = store.takeBackTarget(
      store.selectedItemId!,
      new Set(store.taskUiSlots.map((slot) => slot.slot_id)),
    );
    expect(backTarget).toBe("item-1");
    await store.selectItem(backTarget!, { recordNavigation: false });
    await flushStore();

    expect(store.selectedRepo?.id).toBe("repo-1");
    expect(store.currentItem?.id).toBe("item-1");
  });

  it("records cross-repo task selection history when the previous task is provided explicitly", async () => {
    const store = await createStore();

    await store.selectRepo("repo-1");
    await store.selectItem("item-1");
    await vi.advanceTimersByTimeAsync(1001);

    await store.selectRepo("repo-2");
    await store.selectItem("item-2", { previousItemId: "item-1" });
    await flushStore();

    const backTarget = store.takeBackTarget(
      store.selectedItemId!,
      new Set(store.taskUiSlots.map((slot) => slot.slot_id)),
    );
    expect(backTarget).toBe("item-1");
    await store.selectItem(backTarget!, { recordNavigation: false });
    await flushStore();

    expect(store.selectedRepo?.id).toBe("repo-1");
    expect(store.currentItem?.id).toBe("item-1");

    const forwardTarget = store.takeForwardTarget(
      store.selectedItemId!,
      new Set(store.taskUiSlots.map((slot) => slot.slot_id)),
    );
    expect(forwardTarget).toBe("item-2");
    await store.selectItem(forwardTarget!, { recordNavigation: false });
    await flushStore();

    expect(store.selectedRepo?.id).toBe("repo-2");
    expect(store.currentItem?.id).toBe("item-2");
  });

  it("begins a task-switch perf record when selecting a PTY task", async () => {
    const store = await createStore();

    await store.selectRepo("repo-1");
    await store.selectItem("item-1");

    expect(beginTaskSwitchMock).toHaveBeenCalledWith("item-1");
  });

  it("emits a shared invalidation after hiding a repo", async () => {
    const store = await createStore();

    await store.hideRepo("repo-2");

    expect(invalidateSharedDataMock).toHaveBeenCalledWith("hideRepo");
  });
});
