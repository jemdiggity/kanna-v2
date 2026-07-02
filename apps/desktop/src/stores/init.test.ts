import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting, type DbHandle, type PipelineItem, type Repo } from "@kanna/db";
import { createStoreContext, createStoreState } from "./state";
import { createInitApi } from "./init";

const mockState = vi.hoisted(() => {
  const now = "2026-04-23T00:00:00.000Z";

  function makeRepo(overrides: Partial<Repo> = {}): Repo {
    return {
      id: "repo-1",
      path: "/tmp/repo",
      name: "repo",
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: now,
      last_opened_at: now,
      ...overrides,
    };
  }

  function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
    return {
      id: "task-1",
      repo_id: "repo-1",
      issue_number: null,
      issue_title: null,
      prompt: "Ship it",
      pipeline: "default",
      stage: "in progress",
      stage_result: null,
      active_post_action: null,
      tags: "[\"blocked\"]",
      pr_number: null,
      pr_url: null,
      branch: "task-task-1",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      activity_changed_at: now,
      unread_at: null,
      port_offset: 1421,
      display_name: null,
      port_env: "{\"KANNA_DEV_PORT\":\"1421\"}",
      pinned: 0,
      pin_order: null,
      base_ref: null,
      agent_session_id: "resume-123",
      previous_stage: null,
      teardown_started_at: null,
      last_output_preview: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  let repos = [makeRepo()];
  let items: PipelineItem[] = [];
  let unblockedItems: PipelineItem[] = [];
  const listenMock = vi.fn(async () => () => {});
  const updatePipelineItemActivityMock = vi.fn(async () => {});
  const clearPipelineItemActivePostActionMock = vi.fn(async () => {});
  const loadPipelineMock = vi.fn(async () => ({
    name: "default",
    stages: [
      { name: "commit", transition: "auto" },
      { name: "pr", transition: "manual" },
    ],
  }));
  const advanceStageMock = vi.fn(async () => {});
  const reloadSnapshotMock = vi.fn(async () => {});
  const invokeMock = vi.fn(async (command: string) => {
    if (command === "file_exists") return true;
    if (command === "list_sessions") return [];
    if (command === "kill_session") return undefined;
    if (command === "read_env_var") return "";
    if (command === "git_app_info") return { version: "" };
    throw new Error(`unexpected invoke: ${command}`);
  });
  const setSettingMock = vi.fn(async () => {});
  let tauri = false;

  function reset(): void {
    repos = [makeRepo()];
    items = [];
    unblockedItems = [];
    listenMock.mockClear();
    updatePipelineItemActivityMock.mockClear();
    clearPipelineItemActivePostActionMock.mockClear();
    loadPipelineMock.mockClear();
    advanceStageMock.mockClear();
    reloadSnapshotMock.mockClear();
    invokeMock.mockClear();
    setSettingMock.mockClear();
    tauri = false;
  }

  return {
    makeItem,
    get repos() {
      return repos;
    },
    get items() {
      return items;
    },
    set items(value: PipelineItem[]) {
      items = value;
    },
    get unblockedItems() {
      return unblockedItems;
    },
    set unblockedItems(value: PipelineItem[]) {
      unblockedItems = value;
    },
    listenMock,
    updatePipelineItemActivityMock,
    clearPipelineItemActivePostActionMock,
    loadPipelineMock,
    advanceStageMock,
    reloadSnapshotMock,
    invokeMock,
    setSettingMock,
    get tauri() {
      return tauri;
    },
    set tauri(value: boolean) {
      tauri = value;
    },
    reset,
  };
});

vi.mock("@kanna/db", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: mockState.setSettingMock,
  getUnblockedItems: vi.fn(async () => mockState.unblockedItems),
  listRepos: vi.fn(async () => mockState.repos),
  listPipelineItems: vi.fn(async () => mockState.items),
  listTaskBlockers: vi.fn(async () => []),
  updatePipelineItemActivity: mockState.updatePipelineItemActivityMock,
  markPipelineItemTearingDown: vi.fn(async () => {}),
  clearPipelineItemActivePostAction: mockState.clearPipelineItemActivePostActionMock,
  closePipelineItem: vi.fn(async () => {}),
}));

vi.mock("../tauri-mock", () => ({
  get isTauri() {
    return mockState.tauri;
  },
}));

vi.mock("../invoke", () => ({
  invoke: mockState.invokeMock,
}));

vi.mock("../listen", () => ({
  listen: mockState.listenMock,
}));

function createDb(): DbHandle {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async () => []),
  };
}

function getStageCompleteHandler(): (event: unknown) => Promise<void> {
  const handler = mockState.listenMock.mock.calls.find(
    ([eventName]) => eventName === "pipeline_stage_complete",
  )?.[1] as ((event: unknown) => Promise<void>) | undefined;
  if (!handler) throw new Error("pipeline_stage_complete handler was not registered");
  return handler;
}

function getSessionCreatedHandler(): (event: unknown) => Promise<void> {
  const handler = mockState.listenMock.mock.calls.find(
    ([eventName]) => eventName === "session_created",
  )?.[1] as ((event: unknown) => Promise<void>) | undefined;
  if (!handler) throw new Error("session_created handler was not registered");
  return handler;
}

function getSharedInvalidationHandler(
  onSharedInvalidation: ReturnType<typeof vi.fn>,
): () => Promise<void> {
  const handler = onSharedInvalidation.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
  if (!handler) throw new Error("shared invalidation handler was not registered");
  return handler;
}

describe("createInitApi", () => {
  beforeEach(() => {
    mockState.reset();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockClear();
  });

  it("retires handed-off worktree shells once when the shell env generation changes", async () => {
    mockState.tauri = true;
    mockState.items = [mockState.makeItem({ id: "task-1", branch: "task-task-1" })];
    mockState.invokeMock.mockImplementation(async (command: string) => {
      if (command === "file_exists") return true;
      if (command === "list_sessions") {
        return [
          { session_id: "shell-wt-task-1", kind: "pty" },
          { session_id: "task-1", kind: "pty" },
          { session_id: "shell-repo-repo-1", kind: "pty" },
          { session_id: "agent-task", kind: "agent" },
        ];
      }
      if (command === "kill_session") return undefined;
      if (command === "read_env_var") return "";
      if (command === "git_app_info") return { version: "" };
      throw new Error(`unexpected invoke: ${command}`);
    });

    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {}),
      prewarmWorktreeShellSession: vi.fn(async () => {}),
      spawnShellSession: vi.fn(async () => {}),
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, services);
    const ports = {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore;
    const initApi = createInitApi(context, ports, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask: vi.fn(async () => {}),
    });

    await initApi.init(createDb());

    expect(mockState.invokeMock).toHaveBeenCalledWith("kill_session", { sessionId: "shell-wt-task-1" });
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("kill_session", { sessionId: "task-1" });
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("kill_session", { sessionId: "shell-repo-repo-1" });
    expect(setSetting).toHaveBeenCalledWith(
      expect.anything(),
      "worktreeShellEnvGeneration",
      expect.any(String),
    );
    expect(services.prewarmWorktreeShellSession).toHaveBeenCalledWith(
      "shell-wt-task-1",
      "/tmp/repo/.kanna-worktrees/task-task-1",
      "{\"KANNA_DEV_PORT\":\"1421\"}",
      "/tmp/repo",
    );
  });

  it("restores unblocked tasks through the shared blocked-task restore path on startup", async () => {
    mockState.unblockedItems = [mockState.makeItem()];

    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {}),
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, services);
    const ports = {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore;
    const restoreUnblockedTask = vi.fn(async () => {});
    const startBlockedTask = vi.fn(async () => {});
    const initApi = createInitApi(context, ports, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask,
      restoreUnblockedTask,
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());

    expect(restoreUnblockedTask).toHaveBeenCalledWith(mockState.unblockedItems[0]);
    expect(startBlockedTask).not.toHaveBeenCalled();
  });

  it("restores selected repo and task from window bootstrap before falling back to defaults", async () => {
    mockState.items = [mockState.makeItem()];

    const state = createStoreState();
    const bootstrapRef = ref({
      windowId: "win-2",
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
    (
      state as ReturnType<typeof createStoreState> & {
        initialWindowBootstrap?: typeof bootstrapRef;
      }
    ).initialWindowBootstrap = bootstrapRef;

    const services = {
      loadInitialData: vi.fn(async () => {}),
      restoreSelection: vi.fn(),
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, services);
    const ports = {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore;
    const initApi = createInitApi(context, ports, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());

    expect(state.selectedRepoId.value).toBe("repo-1");
    expect(services.restoreSelection).toHaveBeenCalledWith("task-1");
  });

  it("refreshes externally spawned tasks without moving focus to the new task", async () => {
    const currentTask = mockState.makeItem({
      id: "task-current",
      tags: "[]",
      created_at: "2026-04-23T00:01:00.000Z",
      updated_at: "2026-04-23T00:01:00.000Z",
    });
    const externalTask = mockState.makeItem({
      id: "task-external",
      tags: "[]",
      created_at: "2026-04-23T00:02:00.000Z",
      updated_at: "2026-04-23T00:02:00.000Z",
    });
    mockState.items = [currentTask];

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [currentTask];
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: vi.fn(async () => {
        state.items.value = [externalTask, currentTask];
      }),
      currentItem: computed(() => {
        if (state.selectedItemId.value) {
          return state.items.value.find((item) => item.id === state.selectedItemId.value) ?? null;
        }
        return state.items.value[0] ?? null;
      }),
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const persistSelection = vi.fn(async () => {});
    const onSharedInvalidation = vi.fn(async () => () => undefined);
    const context = createStoreContext(state, toast, {
      ...services,
      windowWorkspace: { persistSelection, onSharedInvalidation },
    } as never);
    const ports = {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore;
    const initApi = createInitApi(context, ports, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());
    expect(state.selectedItemId.value).toBeNull();
    expect(services.currentItem.value?.id).toBe("task-current");

    await getSessionCreatedHandler()({ payload: { session_id: "task-external" } });

    expect(services.reloadSnapshot).toHaveBeenCalled();
    expect(state.items.value.map((item) => item.id)).toEqual(["task-external", "task-current"]);
    expect(state.selectedItemId.value).toBe("task-current");
    expect(services.currentItem.value?.id).toBe("task-current");
    expect(persistSelection).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-current",
    });
  });

  it("does not select a replacement task when an external refresh closes the selected task", async () => {
    const reviewTask = mockState.makeItem({
      id: "task-review",
      stage: "review",
      tags: "[]",
      created_at: "2026-04-23T00:01:00.000Z",
      updated_at: "2026-04-23T00:01:00.000Z",
    });
    const closedReviewTask = {
      ...reviewTask,
      stage: "done",
      closed_at: "2026-04-23T00:03:00.000Z",
    };
    const revisionTask = mockState.makeItem({
      id: "task-revision",
      stage: "in progress",
      tags: "[]",
      created_at: "2026-04-23T00:04:00.000Z",
      updated_at: "2026-04-23T00:04:00.000Z",
    });
    mockState.items = [reviewTask];

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [reviewTask];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "task-review";
    state.lastSelectedItemByRepo.value = { "repo-1": "task-review" };
    const reloadSnapshot = vi.fn(async () => {
      state.items.value = [revisionTask, closedReviewTask];
    });
    const reconcileSelection = vi.fn(() => {
      const selectedItem = state.selectedItemId.value
        ? state.items.value.find((item) => item.id === state.selectedItemId.value)
        : null;
      const selectedValid = selectedItem
        && selectedItem.stage !== "done"
        && selectedItem.closed_at === null
        && selectedItem.repo_id === state.selectedRepoId.value;
      if (selectedValid) return;
      state.selectedItemId.value = state.items.value.find((item) =>
        item.repo_id === state.selectedRepoId.value
        && item.stage !== "done"
        && item.closed_at === null
      )?.id ?? null;
    });
    const onSharedInvalidation = vi.fn(async () => () => undefined);
    const persistSelection = vi.fn(async () => {});
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot,
      reconcileSelection,
      windowWorkspace: { onSharedInvalidation, persistSelection },
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());
    await getSharedInvalidationHandler(onSharedInvalidation)();

    expect(reloadSnapshot).toHaveBeenCalled();
    expect(reconcileSelection).not.toHaveBeenCalled();
    expect(state.selectedItemId.value).toBeNull();
    expect(state.lastSelectedItemByRepo.value["repo-1"]).toBeUndefined();
    expect(persistSelection).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });
  });

  it("loads valid theme preferences from settings", async () => {
    vi.mocked(getSetting).mockImplementation(async (_db, key) => {
      if (key === "appTheme") return "light";
      if (key === "codeTheme") return "dark";
      return null;
    });

    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {}),
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());

    expect(state.appTheme.value).toBe("light");
    expect(state.codeTheme.value).toBe("dark");
  });

  it("loads agent message appearance and falls back to the legacy style setting", async () => {
    vi.mocked(getSetting).mockImplementation(async (_db, key) => {
      if (key === "agentMessageAppearance") return null;
      if (key === "agentMessageStyle") return "terminal";
      return null;
    });

    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {}),
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());

    expect(state.agentMessageAppearance.value).toBe("terminal");
  });

  it("falls back when stored theme preferences are invalid", async () => {
    vi.mocked(getSetting).mockImplementation(async (_db, key) => {
      if (key === "appTheme") return "sepia";
      if (key === "codeTheme") return "solarized";
      return null;
    });

    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {}),
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());

    expect(state.appTheme.value).toBe("dark");
    expect(state.codeTheme.value).toBe("match");
  });

  it("reloads and marks an unselected task unread when a stage-complete event arrives", async () => {
    const item = mockState.makeItem({
      id: "task-1",
      stage: "commit",
      tags: "[]",
    });
    mockState.items = [item];

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [item];
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: mockState.reloadSnapshotMock,
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const context = createStoreContext(state, toast, services);
    const ports = {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore;
    const initApi = createInitApi(context, ports, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());
    await getStageCompleteHandler()({ payload: { task_id: "task-1" } });

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(expect.anything(), "task-1", "unread");
    expect(mockState.reloadSnapshotMock).toHaveBeenCalledTimes(2);
  });
});
