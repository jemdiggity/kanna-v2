import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DbHandle,
  type PipelineItem,
  type Repo,
} from "../types/kanna";
import type { TaskUiSlot } from "../types/taskUi";
import { createStoreContext, createStoreState } from "./state";
import { createInitApi } from "./init";
import { applySnapshotSettingsToState } from "./snapshotSettings";
import { reconcileTaskUiSlots, taskUiSlotToSidebarItem } from "./taskUiSlots";
import { updateDesktopServerClientHandlersForTests } from "../services/desktopServerClient";

const setTitleMock = vi.hoisted(() => vi.fn(async () => {}));

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
      workflow: "default",
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
  const stateChangedListeners: Array<(scope: string) => void> = [];
  const connectionListeners: Array<(connected: boolean) => void> = [];
  let sharedConnectionState = {
    connected: false,
    revision: 0,
  };
  const streamClientMock = {
    onStateChanged: vi.fn((listener: (scope: string) => void) => {
      stateChangedListeners.push(listener);
      return vi.fn();
    }),
  };
  const getSharedStreamClientMock = vi.fn(async () => streamClientMock);
  const updatePipelineItemActivityMock = vi.fn(async () => {});
  const clearPipelineItemActivePostActionMock = vi.fn(async () => {});
  const loadWorkflowMock = vi.fn(async () => ({
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
    if (command === "get_app_build_info") return { version: "", branch: "", commitHash: "", worktree: "" };
    if (command === "git_app_info") return { version: "" };
    throw new Error(`unexpected invoke: ${command}`);
  });
  const setSettingMock = vi.fn(async () => {});
  const getSettingMock = vi.fn(async () => null);
  const listReposMock = vi.fn(async () => repos);
  const listPipelineItemsMock = vi.fn(async () => items);
  const getUnblockedItemsMock = vi.fn(async () => unblockedItems);
  let tauri = false;

  function installDefaultInvokeMock(): void {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "file_exists") return true;
      if (command === "list_sessions") return [];
      if (command === "kill_session") return undefined;
      if (command === "read_env_var") return "";
      if (command === "get_app_build_info") return { version: "", branch: "", commitHash: "", worktree: "" };
      if (command === "git_app_info") return { version: "" };
      throw new Error(`unexpected invoke: ${command}`);
    });
  }

  function reset(): void {
    repos = [makeRepo()];
    items = [];
    unblockedItems = [];
    listenMock.mockClear();
    stateChangedListeners.length = 0;
    connectionListeners.length = 0;
    sharedConnectionState = {
      connected: false,
      revision: 0,
    };
    streamClientMock.onStateChanged.mockClear();
    getSharedStreamClientMock.mockClear();
    updatePipelineItemActivityMock.mockClear();
    clearPipelineItemActivePostActionMock.mockClear();
    loadWorkflowMock.mockClear();
    advanceStageMock.mockClear();
    reloadSnapshotMock.mockClear();
    invokeMock.mockClear();
    installDefaultInvokeMock();
    setSettingMock.mockClear();
    setTitleMock.mockClear();
    getSettingMock.mockClear();
    listReposMock.mockClear();
    listPipelineItemsMock.mockClear();
    getUnblockedItemsMock.mockClear();
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
    stateChangedListeners,
    connectionListeners,
    get sharedConnectionState() {
      return sharedConnectionState;
    },
    setSharedConnection(connected: boolean) {
      if (connected !== sharedConnectionState.connected) {
        sharedConnectionState = {
          connected,
          revision: sharedConnectionState.revision + (connected ? 1 : 0),
        };
      }
    },
    streamClientMock,
    getSharedStreamClientMock,
    updatePipelineItemActivityMock,
    clearPipelineItemActivePostActionMock,
    loadWorkflowMock,
    advanceStageMock,
    reloadSnapshotMock,
    invokeMock,
    setSettingMock,
    getSettingMock,
    listReposMock,
    listPipelineItemsMock,
    getUnblockedItemsMock,
    get tauri() {
      return tauri;
    },
    set tauri(value: boolean) {
      tauri = value;
    },
    reset,
  };
});

vi.mock("@kanna/" + "db", () => ({
  getSetting: mockState.getSettingMock,
  setSetting: mockState.setSettingMock,
  getUnblockedItems: mockState.getUnblockedItemsMock,
  listRepos: mockState.listReposMock,
  listPipelineItems: mockState.listPipelineItemsMock,
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

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: setTitleMock,
  }),
}));

vi.mock("../composables/desktopStreamClient", () => ({
  getSharedStreamClient: mockState.getSharedStreamClientMock,
  getSharedStreamConnectionState: vi.fn(() => ({ ...mockState.sharedConnectionState })),
  onSharedStreamConnectionChange: vi.fn((listener: (connected: boolean) => void) => {
    mockState.connectionListeners.push((connected: boolean) => {
      mockState.setSharedConnection(connected);
      listener(connected);
    });
    return vi.fn();
  }),
}));

function createDb(): DbHandle {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async () => []),
  };
}

function createSnapshotLoader(
  state: ReturnType<typeof createStoreState>,
  options: {
    repos?: Repo[];
    items?: PipelineItem[];
    taskBlockers?: Array<{ blocked_item_id: string; blocker_item_id: string }>;
    worktreePaths?: Record<string, string>;
    settings?: Record<string, string>;
  } = {},
) {
  return vi.fn(async () => {
    const repos = options.repos ?? mockState.repos;
    const items = options.items ?? mockState.items;
    const settings = options.settings ?? {};
    state.repos.value = repos;
    state.items.value = items;
    state.taskBlockers.value = options.taskBlockers ?? [];
    state.worktreePaths.value = options.worktreePaths ?? {};
    state.snapshotSettings.value = settings;
    applySnapshotSettingsToState(state, settings);
  });
}

function getSessionCreatedHandler(): (event: unknown) => Promise<void> {
  const handler = mockState.listenMock.mock.calls.find(
    ([eventName]) => eventName === "session_created",
  )?.[1] as ((event: unknown) => Promise<void>) | undefined;
  if (!handler) throw new Error("session_created handler was not registered");
  return handler;
}

function getSessionExitHandler(): (event: unknown) => Promise<void> {
  const handler = mockState.listenMock.mock.calls.find(
    ([eventName]) => eventName === "session_exit",
  )?.[1] as ((event: unknown) => Promise<void>) | undefined;
  if (!handler) throw new Error("session_exit handler was not registered");
  return handler;
}

function makeReadyTaskSlot(task: PipelineItem, slotId: string): TaskUiSlot {
  return {
    slot_id: slotId,
    task_id: task.id,
    state: "ready",
    task,
    draft: {
      repo_id: task.repo_id,
      prompt: task.prompt ?? "",
      display_name: task.display_name,
      workflow: task.pipeline,
      stage: task.stage,
      agent_type: "pty",
      agent_provider: task.agent_provider,
      created_at: task.created_at,
    },
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
    mockState.getSettingMock.mockResolvedValue(null);
    mockState.setSettingMock.mockClear();
    updateDesktopServerClientHandlersForTests({
      putSetting: async (key, value) => {
        await mockState.setSettingMock(expect.anything(), key, value);
        return { key, value };
      },
    });
  });

  it("sets the native window title from compiled build info in worktree builds", async () => {
    mockState.tauri = true;
    mockState.invokeMock.mockImplementation(async (command: string) => {
      if (command === "file_exists") return true;
      if (command === "list_sessions") return [];
      if (command === "kill_session") return undefined;
      if (command === "read_env_var") return "";
      if (command === "git_app_info") return { version: "0.0.65" };
      if (command === "get_app_build_info") {
        return {
          version: "0.0.65",
          branch: "task-37ec6039-3",
          commit_hash: "abc1234",
          task_id: "37ec6039",
          worktree: "task-37ec6039-3",
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state),
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
    await flushAsync();

    expect(mockState.invokeMock).toHaveBeenCalledWith("get_app_build_info");
    expect(setTitleMock).toHaveBeenCalledWith(
      "Kanna — task 37ec6039 · task-37ec6039-3 (0.0.65 @ abc1234)",
    );
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
    const item = mockState.makeItem({ id: "task-1", branch: "task-task-1" });
    mockState.items = [item];
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        items: [item],
        worktreePaths: {
          "task-1": "/tmp/repo/.kanna-worktrees/task-task-1",
        },
      }),
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
    expect(mockState.setSettingMock).toHaveBeenCalledWith(
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

  it("does not close dormant blocked tasks whose workspace was never initialized", async () => {
    mockState.tauri = true;
    mockState.items = [mockState.makeItem({ id: "task-1", branch: "task-task-1" })];
    mockState.invokeMock.mockImplementation(async (command: string) => {
      // A dormant task has a reserved branch name but no worktree on disk.
      if (command === "file_exists") return false;
      if (command === "list_sessions") return [];
      if (command === "kill_session") return undefined;
      if (command === "read_env_var") return "";
      if (command === "git_app_info") return { version: "" };
      throw new Error(`unexpected invoke: ${command}`);
    });

    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        items: mockState.items,
        worktreePaths: {},
      }),
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

    const db = createDb();
    // No worktree row exists for the dormant task.
    db["select"] = vi.fn(async () => []);
    await initApi.init(db);

    expect(
      (ports as unknown as { closeTaskAndReleasePorts: ReturnType<typeof vi.fn> }).closeTaskAndReleasePorts,
    ).not.toHaveBeenCalled();
  });

  it("closes orphaned tasks whose initialized worktree is missing from disk", async () => {
    mockState.tauri = true;
    mockState.items = [mockState.makeItem({ id: "task-1", branch: "task-task-1" })];
    mockState.invokeMock.mockImplementation(async (command: string) => {
      if (command === "file_exists") return false;
      if (command === "list_sessions") return [];
      if (command === "kill_session") return undefined;
      if (command === "read_env_var") return "";
      if (command === "git_app_info") return { version: "" };
      throw new Error(`unexpected invoke: ${command}`);
    });

    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        items: mockState.items,
        worktreePaths: {
          "task-1": "/tmp/repo/.kanna-worktrees/task-task-1",
        },
      }),
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

    const db = createDb();
    db["select"] = vi.fn(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM worktree")) {
        return [{ pipeline_item_id: "task-1", path: "/tmp/repo/.kanna-worktrees/task-task-1" }];
      }
      return [];
    }) as DbHandle["select"];
    await initApi.init(db);

    expect(
      (ports as unknown as { closeTaskAndReleasePorts: ReturnType<typeof vi.fn> }).closeTaskAndReleasePorts,
    ).toHaveBeenCalledWith("task-1", expect.any(Function));
    expect(mockState.invokeMock).toHaveBeenCalledWith("file_exists", {
      path: "/tmp/repo/.kanna-worktrees/task-task-1",
    });
  });

  it("restores unblocked tasks through the shared blocked-task restore path on startup", async () => {
    const blockedItem = mockState.makeItem({ id: "task-blocked" });
    const closedBlocker = mockState.makeItem({
      id: "task-blocker",
      closed_at: "2026-04-23T00:01:00.000Z",
    });
    mockState.unblockedItems = [blockedItem];

    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        items: [blockedItem, closedBlocker],
        taskBlockers: [{
          blocked_item_id: blockedItem.id,
          blocker_item_id: closedBlocker.id,
        }],
      }),
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

    expect(restoreUnblockedTask).toHaveBeenCalledWith(blockedItem);
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

    const restoreSelection = vi.fn((taskId: string) => {
      expect(taskId).toBe("task-1");
      state.selectedItemId.value = "create:stable-bootstrap";
    });
    const services = {
      loadInitialData: createSnapshotLoader(state, { items: mockState.items }),
      restoreSelection,
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
    expect(state.selectedItemId.value).toBe("create:stable-bootstrap");
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
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:stable-current";
    const selectedTaskId = ref<string | null>(currentTask.id);
    const currentTaskSlot = computed(() => selectedTaskId.value
      ? makeReadyTaskSlot(currentTask, "create:stable-current")
      : null);
    const restoreSelection = vi.fn((taskId: string) => {
      selectedTaskId.value = taskId;
      state.selectedItemId.value = "create:stable-current";
    });
    const resolveSessionCreatedWaiters = vi.fn();
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: vi.fn(async () => {
        state.items.value = [externalTask, currentTask];
        selectedTaskId.value = null;
      }),
      selectedTaskId: computed(() => selectedTaskId.value),
      currentTaskSlot,
      currentItem: computed(() => selectedTaskId.value
        ? state.items.value.find((item) => item.id === selectedTaskId.value) ?? null
        : state.items.value[0] ?? null),
      restoreSelection,
      resolveSessionCreatedWaiters,
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
    expect(state.selectedItemId.value).toBe("create:stable-current");
    expect(services.currentItem.value?.id).toBe("task-current");

    await getSessionCreatedHandler()({ payload: { session_id: "task-external" } });

    expect(resolveSessionCreatedWaiters).toHaveBeenCalledWith("task-external");
    expect(services.reloadSnapshot).toHaveBeenCalled();
    expect(state.items.value.map((item) => item.id)).toEqual(["task-external", "task-current"]);
    expect(restoreSelection).toHaveBeenCalledWith("task-current");
    expect(state.selectedItemId.value).toBe("create:stable-current");
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
    state.selectedItemId.value = "create:stable-review";
    state.lastSelectedItemByRepo.value = { "repo-1": "create:stable-review" };
    const selectedTaskId = ref<string | null>(reviewTask.id);
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
      selectedTaskId: computed(() => selectedTaskId.value),
      currentTaskSlot: computed(() => null),
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

  it("preserves a noncanonical slot when shared refresh keeps its durable task visible", async () => {
    const currentTask = mockState.makeItem({ id: "task-current", tags: "[]" });
    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [currentTask];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:stable-current";
    const restoreSelection = vi.fn((taskId: string) => {
      expect(taskId).toBe(currentTask.id);
      state.selectedItemId.value = "create:stable-current";
    });
    const onSharedInvalidation = vi.fn(async () => () => undefined);
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: vi.fn(async () => {
        state.items.value = [{ ...currentTask }];
      }),
      selectedTaskId: computed(() => currentTask.id),
      currentTaskSlot: computed(() => makeReadyTaskSlot(currentTask, "create:stable-current")),
      restoreSelection,
      windowWorkspace: {
        onSharedInvalidation,
        persistSelection: vi.fn(async () => {}),
      } as never,
    });
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask: vi.fn(async () => {}),
    });

    await initApi.init(createDb());
    await getSharedInvalidationHandler(onSharedInvalidation)();

    expect(state.selectedItemId.value).toBe("create:stable-current");
    expect(restoreSelection).not.toHaveBeenCalled();
  });

  it("preserves an acknowledged creating slot while its durable task payload is unhydrated", async () => {
    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:acknowledged";
    const acknowledgedSlot: TaskUiSlot = {
      slot_id: "create:acknowledged",
      task_id: "task-acknowledged",
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
      draft: {
        repo_id: "repo-1",
        prompt: "Still hydrating",
        display_name: null,
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-07-11T00:00:00Z",
      },
    };
    const onSharedInvalidation = vi.fn(async () => () => undefined);
    const persistSelection = vi.fn(async () => {});
    const restoreSelection = vi.fn();
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: vi.fn(async () => {
        state.items.value = [];
      }),
      selectedTaskId: computed(() => acknowledgedSlot.task_id),
      currentTaskSlot: computed(() => acknowledgedSlot),
      restoreSelection,
      windowWorkspace: {
        onSharedInvalidation,
        persistSelection,
      } as never,
    });
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask: vi.fn(async () => {}),
    });

    await initApi.init(createDb());
    await getSharedInvalidationHandler(onSharedInvalidation)();

    expect(state.selectedItemId.value).toBe("create:acknowledged");
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer remote selection after shared snapshot invalidation", async () => {
    const localTask = mockState.makeItem({ id: "task-before-refresh", tags: "[]" });
    const localSlot = makeReadyTaskSlot(localTask, "create:stable-local");
    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [localTask];
    state.taskUiSlots.value = [localSlot];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = localSlot.slot_id;
    state.lastSelectedItemByRepo.value = { "repo-1": localSlot.slot_id };

    const cloudRepoId = "cloud:repo-remote";
    const cloudTaskId = "cloud:lan:peer-primary:repo-remote:task-remote";
    const reloadSnapshot = vi.fn(async () => {
      state.items.value = [];
      state.taskUiSlots.value = [];
      state.selectedRepoId.value = cloudRepoId;
      state.selectedItemId.value = cloudTaskId;
      state.lastSelectedItemByRepo.value = { [cloudRepoId]: cloudTaskId };
    });
    const onSharedInvalidation = vi.fn(async () => () => undefined);
    const persistSelection = vi.fn(async () => {});
    const currentTaskSlot = computed(() => {
      const selectionId = state.selectedItemId.value;
      return state.taskUiSlots.value.find((slot) =>
        slot.slot_id === selectionId || slot.task_id === selectionId,
      ) ?? null;
    });
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot,
      selectedTaskId: computed(() => currentTaskSlot.value?.task_id ?? null),
      currentTaskSlot,
      restoreSelection: vi.fn(),
      windowWorkspace: { onSharedInvalidation, persistSelection },
    } as never);
    const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask: vi.fn(async () => {}),
    });

    await initApi.init(createDb());
    await getSharedInvalidationHandler(onSharedInvalidation)();

    expect(state.selectedRepoId.value).toBe(cloudRepoId);
    expect(state.selectedItemId.value).toBe(cloudTaskId);
    expect(state.lastSelectedItemByRepo.value).toEqual({ [cloudRepoId]: cloudTaskId });
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("uses the selected durable task when teardown exit chooses a replacement", async () => {
    const closingTask = mockState.makeItem({
      id: "task-closing",
      teardown_started_at: "2026-07-11T00:00:00Z",
    });
    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [closingTask];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:stable-closing";
    const selectReplacementAfterItemRemoval = vi.fn(async () => "create:stable-next");
    const reloadSnapshot = vi.fn(async () => {});
    const closeTaskAndReleasePorts = vi.fn(async (_taskId: string, close: (taskId: string) => Promise<void>) => {
      await close(closingTask.id);
    });
    updateDesktopServerClientHandlersForTests({ closeTask: async () => {} });
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, {
      loadInitialData: vi.fn(async () => {}),
      selectedTaskId: computed(() => closingTask.id),
      selectReplacementAfterItemRemoval,
      reloadSnapshot,
      resolveSessionExitWaiters: vi.fn(),
      persistExitedSessionResumeId: vi.fn(async () => {}),
    });
    const checkUnblocked = vi.fn(async () => {});
    const initApi = createInitApi(context, {
      closeTaskAndReleasePorts,
    } as unknown as import("./ports").PortsStore, {
      checkUnblocked,
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask: vi.fn(async () => {}),
    });

    await initApi.init(createDb());
    await getSessionExitHandler()({
      payload: { session_id: "td-task-closing", code: 0 },
    });

    expect(selectReplacementAfterItemRemoval).toHaveBeenCalledWith(closingTask);
    expect(closeTaskAndReleasePorts).toHaveBeenCalledWith(closingTask.id, expect.any(Function));
    expect(checkUnblocked).toHaveBeenCalledWith(closingTask.id);
    expect(reloadSnapshot).toHaveBeenCalled();
  });

  it("loads valid theme preferences from settings", async () => {
    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        settings: {
          appTheme: "light",
          codeTheme: "dark",
        },
      }),
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
    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        settings: {
          agentMessageStyle: "terminal",
        },
      }),
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
    const state = createStoreState();
    const services = {
      loadInitialData: createSnapshotLoader(state, {
        settings: {
          appTheme: "sepia",
          codeTheme: "solarized",
        },
      }),
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

  it("does not register the legacy workflow_stage_complete refresh listener", async () => {
    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: mockState.reloadSnapshotMock,
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

    expect(mockState.listenMock.mock.calls.map(([eventName]) => eventName)).not.toContain("workflow_stage_complete");
  });

  it("hydrates startup state from the server snapshot without direct DB reads", async () => {
    mockState.tauri = true;
    const repo = mockState.repos[0];
    const activeItem = mockState.makeItem({
      id: "task-active",
      branch: "task-active",
      tags: "[]",
      port_env: "{\"KANNA_DEV_PORT\":\"1422\"}",
    });
    const blockedItem = mockState.makeItem({
      id: "task-blocked",
      branch: "task-blocked",
      tags: "[\"blocked\"]",
      port_env: null,
    });
    const blockerItem = mockState.makeItem({
      id: "task-blocker",
      branch: "task-blocker",
      closed_at: "2026-04-23T00:02:00.000Z",
      tags: "[]",
      port_env: null,
    });

    const state = createStoreState();
    const services = {
      loadInitialData: vi.fn(async () => {
        state.repos.value = [repo];
        state.items.value = [activeItem, blockedItem, blockerItem];
        state.taskBlockers.value = [{
          blocked_item_id: blockedItem.id,
          blocker_item_id: blockerItem.id,
        }];
        state.worktreePaths.value = {
          [activeItem.id]: "/tmp/repo/.kanna-worktrees/task-active",
        };
        state.suspendAfterMinutes.value = 7;
        state.ideCommand.value = "zed";
      }),
      prewarmWorktreeShellSession: vi.fn(async () => {}),
      spawnShellSession: vi.fn(async () => {}),
      restoreSelection: vi.fn(),
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const restoreUnblockedTask = vi.fn(async () => {});
    const initApi = createInitApi(context, {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask,
    });

    const db = createDb();
    await initApi.init(db);

    expect(services.loadInitialData).toHaveBeenCalled();
    expect(mockState.listReposMock).not.toHaveBeenCalled();
    expect(mockState.listPipelineItemsMock).not.toHaveBeenCalled();
    expect(mockState.getUnblockedItemsMock).not.toHaveBeenCalled();
    expect(mockState.getSettingMock).not.toHaveBeenCalled();
    expect(db["select"]).not.toHaveBeenCalledWith(expect.stringContaining("FROM worktree"));
    expect(mockState.invokeMock).toHaveBeenCalledWith("file_exists", {
      path: "/tmp/repo/.kanna-worktrees/task-active",
    });
    expect(services.prewarmWorktreeShellSession).toHaveBeenCalledWith(
      "shell-wt-task-active",
      "/tmp/repo/.kanna-worktrees/task-active",
      "{\"KANNA_DEV_PORT\":\"1422\"}",
      "/tmp/repo",
    );
    expect(services.prewarmWorktreeShellSession).not.toHaveBeenCalledWith(
      "shell-wt-task-blocked",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(restoreUnblockedTask).toHaveBeenCalledWith(blockedItem);
    expect(state.suspendAfterMinutes.value).toBe(7);
    expect(state.ideCommand.value).toBe("zed");
  });

  it("reloads the snapshot when KSP reports server state changes", async () => {
    mockState.tauri = true;
    const currentTask = mockState.makeItem({ id: "task-current" });
    const externalTask = mockState.makeItem({ id: "task-external" });

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [currentTask];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:stable-current";
    const currentTaskSlot = computed(() => makeReadyTaskSlot(currentTask, "create:stable-current"));
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot: vi.fn(async () => {
        state.items.value = [externalTask, currentTask];
      }),
      selectedTaskId: computed(() => currentTask.id),
      currentTaskSlot,
      currentItem: computed(() => state.items.value.find((item) => item.id === currentTask.id) ?? null),
      restoreSelection: vi.fn((taskId: string) => {
        expect(taskId).toBe(currentTask.id);
        state.selectedItemId.value = "create:stable-current";
      }),
      prewarmWorktreeShellSession: vi.fn(async () => {}),
      spawnShellSession: vi.fn(async () => {}),
      windowWorkspace: {
        onSharedInvalidation: vi.fn(async () => () => undefined),
        persistSelection: vi.fn(async () => {}),
      },
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
    await flushAsync();

    expect(mockState.streamClientMock.onStateChanged).toHaveBeenCalled();
    expect(mockState.stateChangedListeners).toHaveLength(1);

    mockState.stateChangedListeners[0]("tasks");
    await flushAsync();

    expect(services.reloadSnapshot).toHaveBeenCalled();
    expect(state.selectedItemId.value).toBe("create:stable-current");
    // Task activity cannot move a repo's committed definitions, and resolving
    // them costs a Git round trip per repo, so this reload must not ask.
    expect(services.reloadSnapshot).toHaveBeenLastCalledWith({ refreshDefinitions: false });

    mockState.stateChangedListeners[0]("repos");
    await flushAsync();

    expect(services.reloadSnapshot).toHaveBeenLastCalledWith({ refreshDefinitions: true });
  });

  it("refreshes an unselected sidebar task through missed and live activity changes", async () => {
    mockState.tauri = true;
    const selectedTask = mockState.makeItem({ id: "task-selected", activity: "idle" });
    let backgroundActivity: PipelineItem["activity"] = "unread";
    const backgroundTask = () => mockState.makeItem({
      id: "task-background",
      activity: backgroundActivity,
    });

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [selectedTask, backgroundTask()];
    state.taskUiSlots.value = [
      makeReadyTaskSlot(selectedTask, selectedTask.id),
      makeReadyTaskSlot(backgroundTask(), "stable-background-slot"),
    ];
    state.selectedRepoId.value = selectedTask.repo_id;
    state.selectedItemId.value = selectedTask.id;

    const reloadSnapshot = vi.fn(async () => {
      state.items.value = [selectedTask, backgroundTask()];
      state.taskUiSlots.value = reconcileTaskUiSlots(
        state.taskUiSlots.value,
        state.items.value,
        { authoritative: true },
      );
    });
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot,
      selectedTaskId: computed(() => selectedTask.id),
      currentTaskSlot: computed(() =>
        state.taskUiSlots.value.find((slot) => slot.task_id === selectedTask.id) ?? null),
      currentItem: computed(() =>
        state.items.value.find((item) => item.id === selectedTask.id) ?? null),
      restoreSelection: vi.fn((taskId: string) => {
        state.selectedItemId.value = taskId;
      }),
      prewarmWorktreeShellSession: vi.fn(async () => {}),
      spawnShellSession: vi.fn(async () => {}),
      windowWorkspace: {
        onSharedInvalidation: vi.fn(async () => () => undefined),
        persistSelection: vi.fn(async () => {}),
      },
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      restoreUnblockedTask: vi.fn(async () => {}),
    });

    await initApi.init(createDb());
    await flushAsync();

    expect(mockState.connectionListeners).toHaveLength(1);
    mockState.connectionListeners[0](true);
    await flushAsync();
    reloadSnapshot.mockClear();

    mockState.connectionListeners[0](false);
    backgroundActivity = "working";
    mockState.connectionListeners[0](true);
    await flushAsync();

    const workingSlot = state.taskUiSlots.value.find(
      (slot) => slot.task_id === "task-background",
    );
    if (!workingSlot) throw new Error("background task slot disappeared");
    expect(taskUiSlotToSidebarItem(workingSlot).activity).toBe("working");
    expect(state.selectedItemId.value).toBe(selectedTask.id);
    expect(reloadSnapshot).toHaveBeenCalledTimes(1);

    backgroundActivity = "unread";
    mockState.stateChangedListeners[0]("tasks");
    await flushAsync();

    const unreadSlot = state.taskUiSlots.value.find(
      (slot) => slot.task_id === "task-background",
    );
    if (!unreadSlot) throw new Error("background task slot disappeared");
    expect(taskUiSlotToSidebarItem(unreadSlot).activity).toBe("unread");
    expect(state.selectedItemId.value).toBe(selectedTask.id);
  });

  it("coalesces KSP state change bursts into one active and one trailing refresh", async () => {
    mockState.tauri = true;
    const currentTask = mockState.makeItem({ id: "task-current" });
    const currentSlot = makeReadyTaskSlot(currentTask, "create:stable-current");
    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [currentTask];
    state.taskUiSlots.value = [currentSlot];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = currentSlot.slot_id;

    const finishRefreshes: Array<() => void> = [];
    const reloadSnapshot = vi.fn(() => new Promise<void>((resolve) => {
      finishRefreshes.push(resolve);
    }));
    const currentTaskSlot = computed(() => currentSlot);
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot,
      selectedTaskId: computed(() => currentTask.id),
      currentTaskSlot,
      currentItem: computed(() => currentTask),
      restoreSelection: vi.fn(),
      prewarmWorktreeShellSession: vi.fn(async () => {}),
      spawnShellSession: vi.fn(async () => {}),
      windowWorkspace: {
        onSharedInvalidation: vi.fn(async () => () => undefined),
        persistSelection: vi.fn(async () => {}),
      },
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());
    await flushAsync();

    const stateChanged = mockState.stateChangedListeners[0];
    stateChanged("tasks");
    stateChanged("tasks");
    stateChanged("tasks");
    await vi.waitFor(() => expect(reloadSnapshot).toHaveBeenCalledTimes(1));

    finishRefreshes[0]();
    await vi.waitFor(() => expect(reloadSnapshot).toHaveBeenCalledTimes(2));
    finishRefreshes[1]();
    await flushAsync();

    expect(reloadSnapshot).toHaveBeenCalledTimes(2);
    expect(state.selectedItemId.value).toBe(currentSlot.slot_id);
  });

  it("does not restore stale focus when selection changes during a KSP refresh", async () => {
    mockState.tauri = true;
    const previousTask = mockState.makeItem({ id: "task-previous" });
    const newerTask = mockState.makeItem({ id: "task-newer" });
    const previousSlot = makeReadyTaskSlot(previousTask, "create:stable-previous");
    const newerSlot = makeReadyTaskSlot(newerTask, "create:stable-newer");

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [previousTask, newerTask];
    state.taskUiSlots.value = [previousSlot, newerSlot];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = previousSlot.slot_id;

    let finishRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const currentTaskSlot = computed(() =>
      state.taskUiSlots.value.find((slot) => slot.slot_id === state.selectedItemId.value) ?? null,
    );
    const restoreSelection = vi.fn((taskId: string) => {
      const slot = state.taskUiSlots.value.find((candidate) => candidate.task_id === taskId);
      state.selectedItemId.value = slot?.slot_id ?? null;
    });
    const reloadSnapshot = vi.fn(async () => {
      await refreshGate;
    });
    const services = {
      loadInitialData: vi.fn(async () => {}),
      reloadSnapshot,
      selectedTaskId: computed(() => currentTaskSlot.value?.task_id ?? null),
      currentTaskSlot,
      currentItem: computed(() => currentTaskSlot.value?.task ?? null),
      restoreSelection,
      prewarmWorktreeShellSession: vi.fn(async () => {}),
      spawnShellSession: vi.fn(async () => {}),
      windowWorkspace: {
        onSharedInvalidation: vi.fn(async () => () => undefined),
        persistSelection: vi.fn(async () => {}),
      },
    };
    const context = createStoreContext(state, {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }, services);
    const initApi = createInitApi(context, {
      closeTaskAndReleasePorts: vi.fn(async () => {}),
    } as unknown as import("./ports").PortsStore, {
      checkUnblocked: vi.fn(async () => {}),
      handleAgentFinished: vi.fn(),
      startBlockedTask: vi.fn(async () => {}),
      restoreUnblockedTask: vi.fn(async () => {}),
    } as unknown as Parameters<typeof createInitApi>[2]);

    await initApi.init(createDb());
    await flushAsync();

    mockState.stateChangedListeners[0]("settings");
    await vi.waitFor(() => expect(reloadSnapshot).toHaveBeenCalledTimes(1));

    state.selectedItemId.value = newerSlot.slot_id;
    finishRefresh();
    await flushAsync();

    expect(restoreSelection).not.toHaveBeenCalled();
    expect(state.selectedItemId.value).toBe(newerSlot.slot_id);
  });
});

describe("Markdown preview mode settings", () => {
  it.each([
    { settings: {}, expected: "rendered" },
    { settings: { markdownPreviewMode: "raw" }, expected: "raw" },
    { settings: { markdownPreviewMode: "rendered" }, expected: "rendered" },
    { settings: { markdownPreviewMode: "invalid" }, expected: "rendered" },
  ])("normalizes $settings to $expected", ({ settings, expected }) => {
    const state = createStoreState();

    applySnapshotSettingsToState(state, settings);

    expect(state.markdownPreviewMode.value).toBe(expected);
  });
});
