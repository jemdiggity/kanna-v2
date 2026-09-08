import { nextTick, ref } from "vue";
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
  const putDesktopSettingMock = vi.fn(async (key: string, value: string) => ({ key, value }));

  return {
    insertOperatorEventMock,
    setSettingMock,
    updatePipelineItemActivityMock,
    markDesktopTaskReadMock,
    putDesktopSettingMock,
    reset() {
      insertOperatorEventMock.mockClear();
      setSettingMock.mockClear();
      updatePipelineItemActivityMock.mockClear();
      markDesktopTaskReadMock.mockClear();
      putDesktopSettingMock.mockReset();
      putDesktopSettingMock.mockImplementation(async (key: string, value: string) => ({ key, value }));
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
  putDesktopSetting: mockState.putDesktopSettingMock,
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
    workflow: "default",
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

  it("can select a repo without persisting an intermediate window selection", async () => {
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
    state.items.value = [createItem({ id: "task-2", repo_id: "repo-2" })];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = null;
    state.lastSelectedItemByRepo.value["repo-2"] = "task-2";

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
      { windowWorkspace: { persistSelection } } as never,
    );

    await createSelectionApi(context).selectRepo("repo-2", {
      persistWindowSelection: false,
    });

    expect(state.selectedRepoId.value).toBe("repo-2");
    expect(state.selectedItemId.value).toBe("task-2");
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("does not persist a stale repo selection after focus changes while settings are pending", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [
      createRepo(),
      createRepo({
        id: "repo-mixed",
        path: "/tmp/repo-mixed",
        name: "repo-mixed",
        sort_order: 1,
      }),
    ];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = null;

    const settingWrite = deferred<void>();
    mockState.putDesktopSettingMock.mockImplementationOnce(async (key: string, value: string) => {
      await settingWrite.promise;
      return { key, value };
    });
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
      { windowWorkspace: { persistSelection } } as never,
    );

    const repoSelection = createSelectionApi(context).selectRepo("repo-mixed");
    expect(state.selectedRepoId.value).toBe("repo-mixed");
    expect(state.selectedItemId.value).toBeNull();

    state.selectedItemId.value = "remote:stable-slot";
    await persistSelection({
      selectedRepoId: "repo-mixed",
      selectedItemId: "remote-task-durable",
    });
    settingWrite.resolve();
    await repoSelection;

    expect(persistSelection).toHaveBeenCalledTimes(1);
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-mixed",
      selectedItemId: "remote-task-durable",
    });
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

  it("re-persists the selection when the selected creating slot names its task", async () => {
    // Selecting a task the moment it is created persists nothing durable, so
    // without this the choice is gone on the next reload.
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
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });

    state.taskUiSlots.value = acknowledgeTaskUiSlot(
      state.taskUiSlots.value,
      "create:slot-1",
      "durable-1",
    );
    await nextTick();
    await Promise.resolve();

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
    // The slot naming its task also re-persists on its own, so every write
    // after the creating one carries the same durable payload.
    for (const [payload] of persistSelection.mock.calls.slice(1)) {
      expect(payload).toEqual({ selectedRepoId: "repo-1", selectedItemId: "durable-1" });
    }
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

  it("keeps the repository selected when its last task is removed", async () => {
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
    const removedItem = createItem();
    state.items.value = [
      removedItem,
      createItem({ id: "task-2", repo_id: "repo-2" }),
    ];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = removedItem.id;

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
      { windowWorkspace: { persistSelection } } as never,
    );
    const selection = createSelectionApi(context);

    const replacementId = await selection.selectReplacementAfterItemRemoval(removedItem);

    expect(replacementId).toBeNull();
    expect(state.selectedRepoId.value).toBe("repo-1");
    expect(state.selectedItemId.value).toBeNull();
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });
  });

  it("selects the parent after removing its final child instead of an unrelated top-level task", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    const parent = createItem({
      id: "parent",
      created_at: "2026-04-29T00:00:03.000Z",
    });
    const child = createItem({
      id: "child",
      parent_task_id: parent.id,
      created_at: "2026-04-29T00:00:04.000Z",
    });
    const unrelated = createItem({
      id: "unrelated",
      created_at: "2026-04-29T00:00:01.000Z",
    });
    state.items.value = [parent, child, unrelated];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = child.id;

    const context = createStoreContext(
      state,
      {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      { windowWorkspace: { persistSelection: vi.fn(async () => {}) } } as never,
    );

    const replacementId = await createSelectionApi(context)
      .selectReplacementAfterItemRemoval(child);

    expect(replacementId).toBe(parent.id);
    expect(state.selectedItemId.value).toBe(parent.id);
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
    const backTarget = selection.takeBackTarget(
      "ready:slot-2",
      new Set(["create:slot-1", "ready:slot-2"]),
    );
    expect(backTarget).toBe("create:slot-1");
    await selection.selectItem(backTarget!, { recordNavigation: false });

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
    const backTarget = selection.takeBackTarget(
      "create:slot-1",
      new Set(["create:slot-1", "ready:slot-2"]),
    );
    expect(backTarget).toBe("ready:slot-2");
    await selection.selectItem(backTarget!, { recordNavigation: false });
    expect(state.selectedItemId.value).toBe("ready:slot-2");

    const forwardTarget = selection.takeForwardTarget(
      "ready:slot-2",
      new Set(["create:slot-1", "ready:slot-2"]),
    );
    expect(forwardTarget).toBe("create:slot-1");
    await selection.selectItem(forwardTarget!, { recordNavigation: false });
    expect(state.selectedItemId.value).toBe("create:slot-1");
    expect(selection.currentTaskSlot.value).toMatchObject({
      slot_id: "create:slot-1",
      state: "creating",
    });
  });

  it("round-trips remote presentation slots through the shared navigation ledger", async () => {
    vi.useFakeTimers();
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [createItem()];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
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
    const selection = createSelectionApi(context);

    await selection.selectItem("task-1");
    await vi.advanceTimersByTimeAsync(1001);
    selection.recordNavigation("remote:stable-slot", "task-1");

    const validIds = new Set(["task-1", "remote:stable-slot"]);
    expect(selection.takeBackTarget("remote:stable-slot", validIds)).toBe("task-1");
    expect(selection.takeForwardTarget("task-1", validIds)).toBe("remote:stable-slot");
  });

  it("can apply a history target without recording a circular selection", async () => {
    vi.useFakeTimers();
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [
      createItem({ id: "task-1" }),
      createItem({ id: "task-2", created_at: "2026-04-29T01:00:00.000Z" }),
    ];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
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
    const selection = createSelectionApi(context);

    await selection.selectItem("task-1");
    await vi.advanceTimersByTimeAsync(1001);
    selection.recordNavigation("remote:stable-slot", "task-1");
    await vi.advanceTimersByTimeAsync(1001);
    await selection.selectItem("task-2", {
      previousItemId: "remote:stable-slot",
      recordNavigation: false,
    });

    expect(selection.takeBackTarget(
      "task-2",
      new Set(["task-1", "task-2", "remote:stable-slot"]),
    )).toBe("task-1");
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

  it("marks an unread task read when its timestamp is SQLite's zone-less UTC", async () => {
    // The server writes `datetime('now')` — `YYYY-MM-DD HH:MM:SS`, UTC with no
    // zone designator. Read as local time it lands hours in the future west of
    // UTC, which made the "don't mark a just-unread task read" guard match
    // forever and selecting an unread task never marked it read.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [
      createItem({
        activity: "unread",
        activity_changed_at: "2026-04-29 11:50:00",
      }),
    ];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
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
      {
        reloadSnapshot: vi.fn(async () => {}),
        windowWorkspace: {
          persistSelection: vi.fn(async () => {}),
          invalidateSharedData: vi.fn(async () => {}),
        },
      } as never,
    );

    const api = createSelectionApi(context);
    await api.selectItem("task-1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockState.markDesktopTaskReadMock).toHaveBeenCalledWith("task-1");
  });

  it("leaves a task that became unread after the selection alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [
      createItem({
        activity: "unread",
        activity_changed_at: "2026-04-29 12:00:00.500",
      }),
    ];
    state.taskUiSlots.value = reconcileTaskUiSlots([], state.items.value);
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
      {
        reloadSnapshot: vi.fn(async () => {}),
        windowWorkspace: {
          persistSelection: vi.fn(async () => {}),
          invalidateSharedData: vi.fn(async () => {}),
        },
      } as never,
    );

    const api = createSelectionApi(context);
    await api.selectItem("task-1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockState.markDesktopTaskReadMock).not.toHaveBeenCalled();
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
