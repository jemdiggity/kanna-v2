import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DbHandle, PipelineItem, Repo } from "../types/kanna";

import { createSelectionApi } from "./selection";
import { createStoreContext, createStoreState, type StoreServices } from "./state";
import { setDesktopServerClientHandlersForTests } from "../services/desktopServerClient";
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
  reconcileTaskUiSlots,
} from "./taskUiSlots";

const mockState = vi.hoisted(() => {
  const insertOperatorEventMock = vi.fn(async () => {});
  const setSettingMock = vi.fn(async () => {});
  const updatePipelineItemActivityMock = vi.fn(async () => {});
  const markDesktopTaskReadMock = vi.fn(async (taskId: string) => ({ taskId, activity: "idle" }));

  return {
    insertOperatorEventMock,
    setSettingMock,
    updatePipelineItemActivityMock,
    markDesktopTaskReadMock,
    reset() {
      insertOperatorEventMock.mockClear();
      setSettingMock.mockClear();
      updatePipelineItemActivityMock.mockClear();
      markDesktopTaskReadMock.mockClear();
    },
  };
});

vi.mock("@kanna/" + "db", () => ({
  insertOperatorEvent: mockState.insertOperatorEventMock,
  setSetting: mockState.setSettingMock,
  updatePipelineItemActivity: mockState.updatePipelineItemActivityMock,
}));

vi.mock("../services/desktopServerClient", () => ({
  markDesktopTaskRead: mockState.markDesktopTaskReadMock,
  postDesktopOperatorEvent: vi.fn(async () => {}),
  putDesktopSetting: vi.fn(async (key: string, value: string) => ({ key, value })),
  setDesktopServerClientHandlersForTests: vi.fn(),
}));

function createDb(): DbHandle {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async () => []),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    path: "/tmp/repo",
    name: "repo",
    default_branch: "main",
    hidden: 0,
    sort_order: 0,
    created_at: "2026-04-29T00:00:00.000Z",
    last_opened_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

function createItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
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
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-task-1",
    closed_at: null,
    agent_type: "agent",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: "2026-04-29T00:00:00.000Z",
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
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("createSelectionApi", () => {
  beforeEach(() => {
    mockState.reset();
    setDesktopServerClientHandlersForTests({
      putSetting: async (key, value) => ({ key, value }),
      postOperatorEvents: async () => {},
      markTaskRead: async (taskId) => {
        await mockState.updatePipelineItemActivityMock(expect.anything(), taskId, "idle");
        return { taskId, activity: "idle" };
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists selection through the window workspace instead of global selected_item_id settings", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [createItem()];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-1";

    const persistSelection = vi.fn(async () => {});
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {
        windowWorkspace: {
          persistSelection,
        },
      } as never,
    );

    await createSelectionApi(context).selectItem("task-1");

    expect(persistSelection).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
    expect(mockState.setSettingMock).not.toHaveBeenCalledWith(
      createDb(),
      "selected_item_id",
      "task-1",
    );
  });

  it("keeps slot selection stable while persisting only durable task IDs", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.selectedRepoId.value = "repo-1";
    state.taskUiSlots.value = [
      buildCreatingTaskUiSlot({
        slotId: "create:slot-1",
        repoId: "repo-1",
        prompt: "Ship it",
        agentType: "pty",
        requestedAgentProviders: "claude",
      }),
    ];

    const persistSelection = vi.fn(async () => {});
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {
        windowWorkspace: {
          persistSelection,
        },
      } as never,
    );
    const selection = createSelectionApi(context);

    await selection.selectItem("create:slot-1");

    expect(state.selectedItemId.value).toBe("create:slot-1");
    expect(selection.selectedTaskId.value).toBeNull();
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });

    state.taskUiSlots.value = acknowledgeTaskUiSlot(
      state.taskUiSlots.value,
      "create:slot-1",
      "durable-1",
    );
    await selection.persistSelection();

    expect(state.selectedItemId.value).toBe("create:slot-1");
    expect(selection.selectedTaskId.value).toBe("durable-1");
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "durable-1",
    });
  });

  it("serializes captured selection payloads so acknowledgement persists after the creating selection", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.selectedRepoId.value = "repo-1";
    state.taskUiSlots.value = [
      buildCreatingTaskUiSlot({
        slotId: "create:slot-1",
        repoId: "repo-1",
        prompt: "Ship it",
        agentType: "pty",
        requestedAgentProviders: "claude",
      }),
    ];
    const firstWrite = deferred<void>();
    const persistSelection = vi.fn(async () => {
      if (persistSelection.mock.calls.length === 1) {
        await firstWrite.promise;
      }
    });
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      { windowWorkspace: { persistSelection } } as never,
    );
    const selection = createSelectionApi(context);

    const creatingPersist = selection.selectItem("create:slot-1");
    await vi.waitFor(() => expect(persistSelection).toHaveBeenCalledTimes(1));
    expect(persistSelection).toHaveBeenNthCalledWith(1, {
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });

    state.taskUiSlots.value = acknowledgeTaskUiSlot(
      state.taskUiSlots.value,
      "create:slot-1",
      "durable-1",
    );
    const acknowledgedPersist = selection.persistSelection();
    await Promise.resolve();

    expect(persistSelection).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([creatingPersist, acknowledgedPersist]);

    expect(persistSelection).toHaveBeenNthCalledWith(2, {
      selectedRepoId: "repo-1",
      selectedItemId: "durable-1",
    });
    expect(persistSelection).toHaveBeenCalledTimes(2);
  });

  it("normalizes a durable task selection to its pre-existing stable slot ID", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [createItem({ id: "durable-1" })];
    state.taskUiSlots.value = reconcileTaskUiSlots(
      acknowledgeTaskUiSlot(
        [
          buildCreatingTaskUiSlot({
            slotId: "create:slot-1",
            repoId: "repo-1",
            prompt: "Ship it",
            agentType: "agent",
            requestedAgentProviders: "claude",
          }),
        ],
        "create:slot-1",
        "durable-1",
      ),
      state.items.value,
    );

    const persistSelection = vi.fn(async () => {});
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {
        windowWorkspace: {
          persistSelection,
        },
      } as never,
    );

    await createSelectionApi(context).selectItem("durable-1");

    expect(state.selectedItemId.value).toBe("create:slot-1");
    expect(state.lastSelectedItemByRepo.value["repo-1"]).toBe("create:slot-1");
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "durable-1",
    });
  });

  it("does not fall back to another durable item while a creating slot is selected", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [createItem({ id: "durable-1" })];
    state.taskUiSlots.value = [
      buildCreatingTaskUiSlot({
        slotId: "create:slot-1",
        repoId: "repo-1",
        prompt: "Ship it",
        agentType: "pty",
        requestedAgentProviders: "claude",
      }),
      ...reconcileTaskUiSlots([], state.items.value),
    ];
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {} as never,
    );
    const selection = createSelectionApi(context);

    await selection.selectItem("create:slot-1");

    expect(selection.currentTaskSlot.value?.slot_id).toBe("create:slot-1");
    expect(selection.currentItem.value).toBeNull();
  });

  it("uses the first sorted durable item as the no-selection fallback", () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [createItem()];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = null;
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {} as never,
    );

    const selection = createSelectionApi(context);

    expect(selection.currentItem.value?.id).toBe("task-1");
  });

  it("keeps a creating slot reachable in Back history before hydration", async () => {
    vi.useFakeTimers();
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    const durableItem = createItem({ id: "durable-1" });
    state.items.value = [durableItem];
    const creatingSlot = buildCreatingTaskUiSlot({
      slotId: "create:slot-1",
      repoId: "repo-1",
      prompt: "Creating task",
      agentType: "pty",
      requestedAgentProviders: "claude",
    });
    const [readySlot] = reconcileTaskUiSlots(
      acknowledgeTaskUiSlot([
        buildCreatingTaskUiSlot({
          slotId: "ready:slot-2",
          repoId: "repo-1",
          prompt: "Ready task",
          agentType: "agent",
          requestedAgentProviders: "claude",
        }),
      ], "ready:slot-2", "durable-1"),
      [durableItem],
    );
    state.taskUiSlots.value = [creatingSlot, readySlot];
    const services: StoreServices = {};
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      services,
    );
    const selection = createSelectionApi(context);
    services.sortedItemsAllRepos = selection.sortedItemsAllRepos;

    await selection.selectItem("create:slot-1");
    await vi.advanceTimersByTimeAsync(1001);
    await selection.selectItem("durable-1");
    selection.goBack();

    expect(state.selectedItemId.value).toBe("create:slot-1");
    expect(selection.currentTaskSlot.value).toMatchObject({
      slot_id: "create:slot-1",
      state: "creating",
    });
  });

  it("keeps a creating slot reachable in Forward history before hydration", async () => {
    vi.useFakeTimers();
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    const durableItem = createItem({ id: "durable-1" });
    state.items.value = [durableItem];
    const creatingSlot = buildCreatingTaskUiSlot({
      slotId: "create:slot-1",
      repoId: "repo-1",
      prompt: "Creating task",
      agentType: "pty",
      requestedAgentProviders: "claude",
    });
    const [readySlot] = reconcileTaskUiSlots(
      acknowledgeTaskUiSlot([
        buildCreatingTaskUiSlot({
          slotId: "ready:slot-2",
          repoId: "repo-1",
          prompt: "Ready task",
          agentType: "agent",
          requestedAgentProviders: "claude",
        }),
      ], "ready:slot-2", "durable-1"),
      [durableItem],
    );
    state.taskUiSlots.value = [creatingSlot, readySlot];
    const services: StoreServices = {};
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      services,
    );
    const selection = createSelectionApi(context);
    services.sortedItemsAllRepos = selection.sortedItemsAllRepos;

    await selection.selectItem("durable-1");
    await vi.advanceTimersByTimeAsync(1001);
    await selection.selectItem("create:slot-1");
    selection.goBack();
    expect(state.selectedItemId.value).toBe("ready:slot-2");

    selection.goForward();
    expect(state.selectedItemId.value).toBe("create:slot-1");
    expect(selection.currentTaskSlot.value).toMatchObject({
      slot_id: "create:slot-1",
      state: "creating",
    });
  });

  it("marks an unread selected task read and invalidates other windows", async () => {
    vi.useFakeTimers();
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [
      createItem({
        activity: "unread",
        activity_changed_at: "2026-04-29T00:00:00.000Z",
      }),
    ];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-1";

    const persistSelection = vi.fn(async () => {});
    const invalidateSharedData = vi.fn(async () => {});
    const reloadSnapshot = vi.fn(async () => {});
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {
        reloadSnapshot,
        windowWorkspace: {
          persistSelection,
          invalidateSharedData,
        },
      } as never,
    );

    const api = createSelectionApi(context);
    await api.selectItem("task-1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockState.markDesktopTaskReadMock).toHaveBeenCalledWith("task-1");
    expect(mockState.updatePipelineItemActivityMock).not.toHaveBeenCalled();
    expect(reloadSnapshot).toHaveBeenCalled();
    expect(invalidateSharedData).toHaveBeenCalledWith("taskActivity");
  });

  it("moves the selected repo to the selected item's repo", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [
      createRepo(),
      createRepo({
        id: "repo-2",
        path: "/tmp/repo-2",
        name: "repo-2",
        sort_order: 1,
      }),
    ];
    state.items.value = [createItem()];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-2";
    state.selectedItemId.value = null;

    const persistSelection = vi.fn(async () => {});
    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {
        windowWorkspace: {
          persistSelection,
        },
      } as never,
    );

    await createSelectionApi(context).selectItem("task-1");

    expect(state.selectedRepoId.value).toBe("repo-1");
    expect(state.selectedItemId.value).toBe("task-1");
    expect(persistSelection).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
  });

  it("falls back to the first visible repo and task when the current selection disappears", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo({ path: "/tmp/repo-1", name: "repo-1" })];
    state.items.value = [createItem()];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-missing";
    state.selectedItemId.value = "task-missing";

    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {} as never,
    );

    const api = createSelectionApi(context);
    api.reconcileSelection();

    expect(state.selectedRepoId.value).toBe("repo-1");
    expect(state.selectedItemId.value).toBe("task-1");
  });

  it("hides closed tasks even when their stage is not done", () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [
      createItem({
        id: "task-closed-pr",
        stage: "pr",
        closed_at: "2026-05-31 10:56:44",
      }),
      createItem({
        id: "task-open",
        stage: "in progress",
        closed_at: null,
        created_at: "2026-04-29T00:01:00.000Z",
      }),
    ];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "task-closed-pr";

    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {} as never,
    );

    const api = createSelectionApi(context);

    expect(api.sortedItemsForCurrentRepo.value.map((item) => item.id)).toEqual(["task-open"]);
    expect(api.currentItem.value?.id).toBe("task-open");
  });

  it("uses the built-in stage order when a repo has no stage_order override", () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [
      createItem({
        id: "task-progress",
        prompt: "In progress task",
        stage: "in progress",
        created_at: "2026-04-29T00:03:00.000Z",
      }),
      createItem({
        id: "task-commit",
        prompt: "Commit task",
        stage: "commit",
        created_at: "2026-04-29T00:02:00.000Z",
      }),
      createItem({
        id: "task-review",
        prompt: "Review task",
        stage: "review",
        created_at: "2026-04-29T00:01:00.000Z",
      }),
    ];
    state.selectedRepoId.value = "repo-1";

    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      {} as never,
    );

    const api = createSelectionApi(context);

    expect(api.getStageOrder("repo-1")).toEqual(["pr", "review", "in progress"]);
    expect(api.sortedItemsForCurrentRepo.value.map((item) => item.id)).toEqual([
      "task-review",
      "task-progress",
      "task-commit",
    ]);
  });
});
