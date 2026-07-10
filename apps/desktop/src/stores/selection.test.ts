import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DbHandle, PipelineItem, Repo } from "../types/kanna";

import { createSelectionApi } from "./selection";
import { createStoreContext, createStoreState } from "./state";
import { setDesktopServerClientHandlersForTests } from "../services/desktopServerClient";
import { initializeTaskItem, type InitializingTaskItem } from "./taskInitialization";

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

function createInitializingItem(
  overrides: Partial<InitializingTaskItem> = {},
): InitializingTaskItem {
  return {
    id: "create-1",
    state: "initializing",
    taskId: null,
    repo_id: "repo-1",
    prompt: "Create a task",
    display_name: null,
    pipeline: "default",
    stage: "in progress",
    agent_type: "pty",
    agent_provider: "claude",
    created_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function toastStub() {
  return {
    toasts: ref([]),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
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

  it("does not resolve an initializing UI item as a persisted task", () => {
    const state = createStoreState();
    state.repos.value = [createRepo()];
    state.items.value = [createItem({ id: "task-existing" })];
    state.initializingTaskItems.value = [createInitializingItem()];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create-1";

    const selection = createSelectionApi(createStoreContext(state, toastStub(), {}));

    expect(selection.currentInitializingItem.value?.id).toBe("create-1");
    expect(selection.currentItem.value).toBeNull();
  });

  it("persists only the durable id of an initializing selection", async () => {
    const state = createStoreState();
    state.repos.value = [createRepo()];
    state.initializingTaskItems.value = [createInitializingItem()];
    const persistSelection = vi.fn(async () => {});
    const selection = createSelectionApi(createStoreContext(
      state,
      toastStub(),
      { windowWorkspace: { persistSelection } } as never,
    ));

    await selection.selectItem("create-1");
    expect(selection.selectedItemIdForPersistence.value).toBeNull();
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });

    state.initializingTaskItems.value = initializeTaskItem(
      state.initializingTaskItems.value,
      "create-1",
      "task-1",
    );
    await selection.selectItem("create-1");
    expect(selection.selectedItemIdForPersistence.value).toBe("task-1");
    expect(persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
  });

  it("persists selection through the window workspace instead of global selected_item_id settings", async () => {
    const state = createStoreState();
    state.db.value = createDb();
    state.repos.value = [createRepo()];
    state.items.value = [createItem()];
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

  it("keeps an initializing UI item selected during selection reconciliation", () => {
    const state = createStoreState();
    state.repos.value = [createRepo()];
    state.items.value = [createItem({ id: "task-existing" })];
    state.initializingTaskItems.value = [createInitializingItem()];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create-1";

    const api = createSelectionApi(createStoreContext(state, toastStub(), {}));
    api.reconcileSelection();

    expect(state.selectedItemId.value).toBe("create-1");
    expect(api.currentInitializingItem.value?.id).toBe("create-1");
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
