import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
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
    reset,
  };
});

vi.mock("@kanna/db", () => ({
  getSetting: vi.fn(async () => null),
  getUnblockedItems: vi.fn(async () => mockState.unblockedItems),
  listRepos: vi.fn(async () => mockState.repos),
  listPipelineItems: vi.fn(async () => mockState.items),
  updatePipelineItemActivity: mockState.updatePipelineItemActivityMock,
  markPipelineItemTearingDown: vi.fn(async () => {}),
  clearPipelineItemActivePostAction: mockState.clearPipelineItemActivePostActionMock,
  closePipelineItem: vi.fn(async () => {}),
}));

vi.mock("../tauri-mock", () => ({
  isTauri: false,
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

describe("createInitApi", () => {
  beforeEach(() => {
    mockState.reset();
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

  it("consumes successful auto-stage results once when duplicate stage-complete events arrive", async () => {
    const item = mockState.makeItem({
      id: "task-1",
      stage: "commit",
      stage_result: JSON.stringify({ status: "success", summary: "committed" }),
      tags: "[]",
    });
    mockState.items = [item];

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [item];
    const services = {
      loadInitialData: vi.fn(async () => {}),
      loadPipeline: mockState.loadPipelineMock,
      advanceStage: mockState.advanceStageMock,
      reloadSnapshot: mockState.reloadSnapshotMock,
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    let claimAvailable = true;
    const db = {
      ...createDb(),
      execute: vi.fn(async (query: string) => {
        if (query.includes("UPDATE pipeline_item SET stage_result = NULL")) {
          if (!claimAvailable) return { rowsAffected: 0 };
          claimAvailable = false;
          return { rowsAffected: 1 };
        }
        return { rowsAffected: 1 };
      }),
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

    await initApi.init(db);

    const stageCompleteHandler = getStageCompleteHandler();

    await Promise.all([
      stageCompleteHandler({ payload: { task_id: "task-1" } }),
      stageCompleteHandler({ payload: { task_id: "task-1" } }),
    ]);

    expect(mockState.advanceStageMock).toHaveBeenCalledTimes(1);
    expect(mockState.advanceStageMock).toHaveBeenCalledWith("task-1", { initiatedBy: "auto" });
  });

  it("clears a successful active post-action and advances to the next real stage", async () => {
    const item = mockState.makeItem({
      id: "task-post-action",
      stage: "in progress",
      active_post_action: "commit",
      stage_result: JSON.stringify({ status: "success", summary: "committed" }),
      tags: "[]",
    });
    mockState.loadPipelineMock.mockResolvedValueOnce({
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: { name: "commit", transition: "auto", agent: "commit" },
        },
        { name: "pr", transition: "manual" },
      ],
    });
    mockState.items = [item];

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [item];
    const services = {
      loadInitialData: vi.fn(async () => {}),
      loadPipeline: mockState.loadPipelineMock,
      advanceStage: mockState.advanceStageMock,
      reloadSnapshot: mockState.reloadSnapshotMock,
    };
    const toast = {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    const db = {
      ...createDb(),
      execute: vi.fn(async () => ({ rowsAffected: 1 })),
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

    await initApi.init(db);
    await getStageCompleteHandler()({ payload: { task_id: "task-post-action" } });

    expect(mockState.clearPipelineItemActivePostActionMock).toHaveBeenCalledWith(expect.anything(), "task-post-action");
    expect(mockState.advanceStageMock).toHaveBeenCalledWith("task-post-action", {
      initiatedBy: "auto",
      skipPostAction: true,
    });
  });

  it("leaves a failed active post-action in place", async () => {
    const item = mockState.makeItem({
      id: "task-post-action-failed",
      stage: "in progress",
      active_post_action: "commit",
      stage_result: JSON.stringify({ status: "failure", summary: "dirty unrelated files" }),
      tags: "[]",
    });
    mockState.loadPipelineMock.mockResolvedValueOnce({
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: { name: "commit", transition: "auto", agent: "commit" },
        },
        { name: "pr", transition: "manual" },
      ],
    });
    mockState.items = [item];

    const state = createStoreState();
    state.repos.value = [...mockState.repos];
    state.items.value = [item];
    const services = {
      loadInitialData: vi.fn(async () => {}),
      loadPipeline: mockState.loadPipelineMock,
      advanceStage: mockState.advanceStageMock,
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
    await getStageCompleteHandler()({ payload: { task_id: "task-post-action-failed" } });

    expect(mockState.clearPipelineItemActivePostActionMock).not.toHaveBeenCalled();
    expect(mockState.advanceStageMock).not.toHaveBeenCalled();
  });
});
